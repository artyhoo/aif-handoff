// Pre-swap rollback guard (plan p2-wake-on-work, B16 — R3/S2 + R4/C2).
//
// EXAMPLE DEPLOYMENT MATERIAL — parameterized, reviewed by the operator, and
// run manually before an incompatible API swap. It PERFORMS NO CHANGE: it
// only verifies and prints PERMIT or REFUSE. The owner swaps only on PERMIT
// (deployment remains a separate exact-candidate review boundary).
//
// CONJUNCTIVE verdict — every condition must hold; there are no disjunctions:
//   1. durable fence marker present (relay fence/unfence wrote it);
//   2. supervisor-asserted cessation of the relay unit — the parameterized
//      supervisor query must answer a DEAD state (`inactive`/`failed`).
//      `active`/`activating`/`deactivating`/unknown/query-failure ⇒ REFUSE.
//      Any live relay REFUSEs — even when fenced: a fenced status reply is a
//      LIVENESS proof, not cessation (R4/C2). Socket/status replies are
//      corroboration only, never cessation evidence;
//   3. zero in-flight and zero uncertain-effect deliveries in the spool —
//      envelopes in `admitted` (delivered, pickup unconfirmed) or
//      `hold_handover_unconfirmed` are uncertain effects (§9.3 step 3);
//   4. sha256 of the API artifact to be swapped matches the operator's
//      expected preimage (wrong artifact ⇒ REFUSE).
//
// Usage:
//   node rollback-guard.example.mjs \
//     --fence-path /var/lib/aif-intake-relay/fence.active \
//     --spool-dir /var/lib/aif-intake-relay/spool \
//     --supervisor "systemctl is-active" \
//     --unit aif-intake-relay.service \
//     --artifact /srv/deploy/aif-api.tar \
//     --expected-sha256 <hex of the reviewed artifact>
//
// Every parameter is required; defaults are placeholders only.

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Spool states whose existence makes the swap UNSAFE (uncertain effects). */
const UNCERTAIN_EFFECT_STATES = new Set(["admitted", "hold_handover_unconfirmed"]);

/** The only supervisor answers that count as verified cessation. */
const DEAD_SUPERVISOR_STATES = new Set(["inactive", "failed"]);

/**
 * Run the parameterized supervisor query and classify its answer. ANY
 * failure to answer (nonzero exit, timeout, empty/unknown text) is UNKNOWN
 * cessation — never silently treated as stopped.
 */
export function querySupervisor({ supervisor, unit, exec = execFile, timeoutMs = 10_000 }) {
  return new Promise((resolve) => {
    const args = [...supervisor.split(/\s+/).filter(Boolean), unit];
    exec(args[0], args.slice(1), { timeout: timeoutMs }, (error, stdout) => {
      if (error) {
        // `systemctl is-active` exits nonzero for inactive/failed — classify
        // by the TEXT it printed, but only well-known dead answers count.
        const text = String(stdout ?? "").trim();
        if (DEAD_SUPERVISOR_STATES.has(text)) {
          resolve({ state: text, dead: true });
          return;
        }
        resolve({ state: text || "query-failed", dead: false });
        return;
      }
      const text = String(stdout ?? "").trim();
      resolve({ state: text || "empty", dead: DEAD_SUPERVISOR_STATES.has(text) });
    });
  });
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function scanUncertainEffects(spoolDir) {
  let files;
  try {
    files = readdirSync(spoolDir);
  } catch (error) {
    return { error: `spool unreadable: ${error.message}`, uncertain: [], pending: 0 };
  }
  const uncertain = [];
  let pending = 0;
  for (const entry of files) {
    if (!entry.endsWith(".json")) continue;
    let record = null;
    try {
      record = JSON.parse(readFileSync(join(spoolDir, entry), "utf8"));
    } catch {
      uncertain.push({ id: entry, reason: "unparseable envelope record" });
      continue;
    }
    if (UNCERTAIN_EFFECT_STATES.has(record?.state)) {
      uncertain.push({ id: record.id ?? entry, state: record.state });
    }
    if (record?.state === "pending") pending += 1;
  }
  return { error: null, uncertain, pending };
}

/**
 * The conjunctive verdict (R4/C2). Pure evaluation over gathered facts so the
 * full negative matrix is testable without touching a host.
 */
export function evaluateGuard({ fence, supervisor, uncertainEffects, artifactMatches }) {
  const reasons = [];
  if (!fence) reasons.push("fence marker missing — write it with `relay.mjs fence --reason …`");
  if (!supervisor.dead) {
    reasons.push(
      `relay unit cessation not verified (supervisor answered "${supervisor.state}") — any live relay refuses the swap, fenced included`,
    );
  }
  if (uncertainEffects.error) reasons.push(uncertainEffects.error);
  for (const item of uncertainEffects.uncertain ?? []) {
    reasons.push(
      `uncertain-effect envelope present: ${item.id}${item.state ? ` (${item.state})` : ""}`,
    );
  }
  if (!artifactMatches) reasons.push("API artifact sha256 does not match the expected preimage");
  return { permit: reasons.length === 0, reasons };
}

async function main(argv) {
  const flag = (name) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const required = {
    fencePath: flag("fence-path"),
    spoolDir: flag("spool-dir"),
    supervisor: flag("supervisor"),
    unit: flag("unit"),
    artifact: flag("artifact"),
    expectedSha256: flag("expected-sha256"),
  };
  for (const [name, value] of Object.entries(required)) {
    if (!value) {
      process.stderr.write(`missing required --${name}\n`);
      process.exitCode = 2;
      return;
    }
  }

  // Fact gathering — the guard performs no change of its own.
  let fence = null;
  try {
    statSync(required.fencePath);
    fence = JSON.parse(readFileSync(required.fencePath, "utf8"));
  } catch {
    fence = null;
  }
  const supervisor = await querySupervisor({
    supervisor: required.supervisor,
    unit: required.unit,
  });
  const uncertainEffects = scanUncertainEffects(required.spoolDir);
  let artifactMatches = false;
  try {
    artifactMatches = sha256File(required.artifact) === required.expectedSha256.toLowerCase();
  } catch (error) {
    uncertainEffects.error = `${uncertainEffects.error ? `${uncertainEffects.error}; ` : ""}artifact unreadable: ${error.message}`;
  }

  const verdict = evaluateGuard({ fence, supervisor, uncertainEffects, artifactMatches });
  process.stdout.write(
    `${JSON.stringify(
      {
        verdict: verdict.permit ? "PERMIT" : "REFUSE",
        reasons: verdict.reasons,
        facts: {
          fence: fence ? { at: fence.at, reason: fence.reason } : null,
          supervisorState: supervisor.state,
          uncertainEffects: uncertainEffects.uncertain,
          pendingEnvelopes: uncertainEffects.pending,
          artifactMatches,
        },
        checkedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = verdict.permit ? 0 : 1;
}

const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
