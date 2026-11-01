// Intake submit shim (plan p2-wake-on-work, Slice B, file B6).
//
// The TRUSTED CLIENT of the single retention writer (§9.2/R3-S1): this CLI
// runs as the sshd forced command on the bridge. It resolves principal₁ from
// the sshd-presented identity (never from client-supplied fields), applies
// scope checks BEFORE retention or wake, then hands the sealed envelope to
// the single writer over the authenticated UDS and relays the truthful
// receipt or refusal.
//
// It NEVER writes the spool directly and NEVER issues a wake — the writer
// alone decides capacity and durability (M5). Writer down or misauthenticated
// ⇒ truthful refusal exit; the supervisor restarts the writer and clients
// retry.

import { readFileSync, realpathSync } from "node:fs";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";

import { EnvelopeError, sealEnvelope } from "./envelope.mjs";
import { loadSecretFile } from "./deliverer.mjs";

/** Truthful exit codes (documented in the runbook). */
export const EXIT_CODES = {
  accepted: 0,
  internal_error: 1,
  refused_by_writer: 2,
  refused_pre_writer: 3,
  retention_unavailable: 4,
};

/**
 * Resolve principal₁ (R1): prefer the sshd ExposeAuthInfo identity file — the
 * fingerprint of the key sshd ACTUALLY presented — checked against the
 * operator-owned map. The per-key `environment=` variable named by
 * `principalEnvVar` is the documented fallback with a weaker trust basis
 * (operator-set per authorized_keys key, but not a proof of the presented
 * key). An arbitrary inherited environment variable is never sufficient by
 * itself. Client-supplied principal fields are never consulted.
 */
export function resolvePrincipal({
  config,
  principalMap,
  env = process.env,
  readFileSync: read = readFileSync,
}) {
  const identityPath = config.sshAuthInfoPath || env.SSH_AUTH_INFO_0 || "";
  if (identityPath) {
    let content;
    try {
      content = read(identityPath, "utf8");
    } catch {
      content = "";
    }
    const fingerprint = extractPresentedFingerprint(content);
    if (fingerprint && principalMap.has(fingerprint)) {
      return { principal: principalMap.get(fingerprint), via: "expose-auth-info" };
    }
  }
  if (config.principalEnvVar) {
    const claimed = env[config.principalEnvVar];
    if (typeof claimed === "string" && claimed.length > 0) {
      for (const entry of principalMap.values()) {
        if (entry.principalId === claimed) {
          return { principal: entry, via: "per-key-environment" };
        }
      }
    }
  }
  return { principal: null, via: null };
}

/** Extract the first `publickey SHA256:…` fingerprint from ExposeAuthInfo output. */
export function extractPresentedFingerprint(content) {
  if (typeof content !== "string") return null;
  const match = /^publickey\s+(SHA256:[A-Za-z0-9+/=_-]+)/m.exec(content);
  return match?.[1] ?? null;
}

/**
 * Incrementally byte-bounded stdin read (R4): the payload is bounded AS BYTES
 * ARRIVE against the resolved principal's `maxRequestBytes` — the same single
 * per-principal bound `sealEnvelope` enforces, never a second policy. An
 * oversized or never-ending stream is cut at the bound without waiting for
 * EOF: the input stream is destroyed (the feeding pipe gets EPIPE) and the
 * buffered memory never exceeds the declared bound. No JSON parsing and no
 * writer contact happen on this path.
 */
export async function readBoundedStdin({ maxBytes, stream = process.stdin }) {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new EnvelopeError("payload_too_large", `invalid request bound: ${maxBytes}`);
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const size = chunk.length;
    if (total + size > maxBytes) {
      // Stop reading and close the input NOW — refusal is answered from the
      // bound, not from EOF (R4). Memory held: at most `maxBytes`.
      stream.destroy();
      throw new EnvelopeError(
        "payload_too_large",
        `input exceeded ${maxBytes} bytes before EOF — stream closed without reading it all`,
      );
    }
    chunks.push(chunk);
    total += size;
  }
  return Buffer.concat(chunks);
}

/**
 * One submit: read the client payload, resolve the principal, seal the
 * envelope (scope checks pre-retention), hand it to the single writer over
 * the authenticated UDS. Returns `{ exitCode, response }` — the response is
 * the truthful receipt or refusal, relayed verbatim to the caller.
 * `principal` may be passed pre-resolved (the CLI resolves BEFORE reading
 * stdin so identity faults refuse without buffering the payload, R4); when
 * omitted it is resolved here exactly as before.
 */
export async function submitOnce({
  config,
  principalMap,
  input,
  principal: preResolvedPrincipal = null,
  env = process.env,
  readFileSync: read = readFileSync,
  connectImpl = connect,
  log = () => {},
}) {
  const { principal, via } = preResolvedPrincipal
    ? { principal: preResolvedPrincipal, via: "pre-resolved" }
    : resolvePrincipal({ config, principalMap, env, readFileSync: read });
  if (!principal) {
    return {
      exitCode: EXIT_CODES.refused_pre_writer,
      response: {
        ok: false,
        code: "principal_unknown",
        message: "no principal resolved from the presented sshd identity",
      },
    };
  }

  let envelope;
  try {
    envelope = sealEnvelope({ input, principal, principalKind: "participant" });
  } catch (error) {
    if (error instanceof EnvelopeError) {
      return {
        exitCode: EXIT_CODES.refused_pre_writer,
        response: { ok: false, code: error.code, message: error.message },
      };
    }
    throw error;
  }
  log(
    { principalId: principal.principalId, via, requestId: envelope.requestId },
    "envelope sealed",
  );

  let credential;
  try {
    credential = loadSecretFile(config.writerCredentialPath, "writer credential");
  } catch (error) {
    return {
      exitCode: EXIT_CODES.retention_unavailable,
      response: { ok: false, code: "writer_unauthenticated", message: error.message },
    };
  }

  let reply;
  try {
    reply = await requestWriter({
      socketPath: config.socketPath,
      credential,
      envelope,
      connectImpl,
    });
  } catch (error) {
    return {
      exitCode: EXIT_CODES.retention_unavailable,
      response: {
        ok: false,
        code: "retention_unavailable",
        message: `writer unreachable at ${config.socketPath}: ${error?.code ?? error?.message ?? "error"}`,
      },
    };
  }

  if (!reply || typeof reply !== "object" || reply.ok !== true) {
    return {
      exitCode: EXIT_CODES.refused_by_writer,
      response: reply ?? { ok: false, code: "writer_error" },
    };
  }
  return { exitCode: EXIT_CODES.accepted, response: reply };
}

/** Newline-delimited JSON over the UDS: request → half-close → single reply. */
export function requestWriter({
  socketPath,
  credential,
  envelope,
  control,
  connectImpl = connect,
}) {
  return new Promise((resolve, reject) => {
    const socket = connectImpl(socketPath);
    let buffered = "";
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(10_000, () => fail(new Error("writer timeout")));
    socket.once("error", fail);
    socket.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
    });
    socket.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        resolve(JSON.parse(buffered));
      } catch {
        reject(new Error("writer reply unparseable"));
      }
    });
    socket.write(`${JSON.stringify({ credential, envelope, control })}\n`);
    socket.end();
  });
}

// ---------------------------------------------------------------------------
// CLI entry: payload on stdin, receipt/refusal JSON on stdout.
// ---------------------------------------------------------------------------

async function main() {
  const { loadConfig, loadPrincipalMap } = await import("./config.mjs");
  const config = loadConfig();
  const principalMap = loadPrincipalMap(config.principalsPath);

  // Identity BEFORE payload (R4): the principal comes from the sshd boundary,
  // never from the stream — an unresolvable principal is refused before a
  // single stdin byte is buffered.
  const { principal } = resolvePrincipal({ config, principalMap });
  if (!principal) {
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        code: "principal_unknown",
        message: "no principal resolved from the presented sshd identity",
      })}\n`,
    );
    process.exitCode = EXIT_CODES.refused_pre_writer;
    return;
  }

  // Byte-bounded stdin (R4): bounded incrementally against the SAME
  // per-principal bound the seal enforces — an oversized or never-ending
  // stream is closed at the bound, and the truthful refusal is answered
  // without waiting for EOF, before any JSON parse or writer contact.
  let raw;
  try {
    raw = await readBoundedStdin({ maxBytes: principal.maxRequestBytes });
  } catch (error) {
    if (error instanceof EnvelopeError) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, code: error.code, message: error.message })}\n`,
      );
      process.exitCode = EXIT_CODES.refused_pre_writer;
      return;
    }
    throw error;
  }

  let input;
  try {
    input = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, code: "payload_unparseable", message: error.message })}\n`,
    );
    process.exitCode = EXIT_CODES.refused_pre_writer;
    return;
  }

  const { exitCode, response } = await submitOnce({
    config,
    principalMap,
    input,
    principal,
    log: console.error,
  });
  process.stdout.write(`${JSON.stringify(response)}\n`);
  process.exitCode = exitCode;
}

const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
