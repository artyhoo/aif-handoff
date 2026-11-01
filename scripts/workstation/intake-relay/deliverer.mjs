// Bridge intake relay deliverer (plan p2-wake-on-work, Slice B, file B5).
//
// The SINGLE WRITER process (§9.1/M5): it owns every spool mutation, the
// authenticated retention IPC endpoint (§9.2/R3-S1), the fail-closed UDS
// singleton latch (§9.2/R4-C1), the compat probe (§9.3/M3), the operator
// fence re-checks (§9.3/R4-C2), the FIFO delivery loop with §7.5 response
// classification, and the handover watch (§8.3/M1).
//
// Fail-closed invariants:
//   • the socket bind is the singleton latch — a bind that fails for ANY
//     reason refuses startup (exit state `startup_refused_socket_held`);
//     this process NEVER unlinks and NEVER reclaims its socket path. The
//     connect probe is a diagnostic that classifies the refusal message —
//     never a decision input (R4/C1);
//   • every writer request must present the per-instance writer credential;
//     there is no configuration in which an unauthenticated request is
//     accepted — retain-only mode included (R3/S1);
//   • retain-only mode performs ZERO network calls and issues ZERO wake
//     (asserted in tests);
//   • the operator fence, when present, permits zero keyed delivery — it is
//     re-checked at startup, before every delivery cycle, and immediately
//     before every keyed POST (R4/C2 defense-in-depth).

import { chmodSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { connect, createServer } from "node:net";
import { dirname } from "node:path";

import { credentialsMatch, revalidateSealedEnvelope } from "./envelope.mjs";
import { SpoolError, writeFileDurable } from "./spool.mjs";
import { createWakeEngine } from "./wake.mjs";

export const STARTUP_REFUSED_SOCKET_HELD = "startup_refused_socket_held";

/** Terminal AIF task statuses (mirrors the shared state machine). */
export const TERMINAL_TASK_STATUSES = new Set(["done", "verified"]);

/** Operator holds resumed only by explicit operator action (§9.3). */
export const OPERATOR_HOLD_STATES = new Set(["hold_auth_config", "hold_handover_unconfirmed"]);

/** Mechanical holds that resume automatically when their condition clears. */
export const OPERATOR_AUTO_HOLD_STATES = new Set(["hold_api_compat", "hold_operator_fence"]);

// ---------------------------------------------------------------------------
// Operator fence (§9.3) — durable fsynced marker shared with relay.mjs.
// ---------------------------------------------------------------------------

export function writeFence(fencePath, reason, nowIso) {
  const marker = {
    reason: String(reason ?? "unspecified"),
    at: nowIso ?? new Date().toISOString(),
  };
  mkdirSync(dirname(fencePath), { recursive: true });
  writeFileDurable(fencePath, `${JSON.stringify(marker, null, 2)}\n`);
  return marker;
}

export function readFence(fencePath) {
  try {
    statSync(fencePath);
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(fencePath, "utf8"));
    if (parsed && typeof parsed.reason === "string" && typeof parsed.at === "string") {
      return parsed;
    }
    // A present-but-unparsable marker still fences (fail closed).
    return { reason: "unreadable-marker", at: "unknown" };
  } catch {
    return { reason: "unreadable-marker", at: "unknown" };
  }
}

export function clearFence(fencePath) {
  try {
    rmSync(fencePath, { force: true });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Fail-closed singleton bind (R4/C1).
// ---------------------------------------------------------------------------

function listenOnce(server, socketPath) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

/**
 * Diagnostic-only classification of a refused socket path (R4/C1): a refused
 * connect(2) proves NOTHING about the owning process — a rival in
 * bind/listen startup or in cleanup can refuse a probe while still owning
 * the path. The result is never a decision input; the decision (refuse
 * startup) is made before this runs.
 */
export function classifySocketPath(socketPath, { timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const probe = connect(socketPath);
    const finish = (classification) => {
      probe.destroy();
      resolve(classification);
    };
    probe.setTimeout(timeoutMs, () => finish("path-unreachable-timeout"));
    probe.once("connect", () => finish("listener-live-answering"));
    probe.once("error", (error) => {
      if (error.code === "ECONNREFUSED") {
        // Stale file OR rival in bind/listen startup — indistinguishable, and
        // neither is evidence that the path is free.
        finish("path-held-no-listener-answering");
        return;
      }
      finish(`path-unreachable-${error.code ?? "unknown"}`);
    });
  });
}

/**
 * Bind the writer's UDS as the OS-held singleton latch. ANY failure refuses:
 * the caller receives `{ ok:false, code: STARTUP_REFUSED_SOCKET_HELD }` plus
 * a diagnostic classification and must exit non-zero without touching the
 * spool. The socket path is never unlinked here — stale-path cleanup belongs
 * to the supervisor/owner only, after verified cessation (R4/C1).
 */
export async function bindWriterSocket({ server, socketPath, log = () => {} }) {
  const dir = dirname(socketPath);
  mkdirSync(dir, { recursive: true, mode: 0o750 });
  // mkdir mode is umask-masked; enforce the kernel reachability boundary
  // explicitly (§9.2: service-user-owned 0750 dir, 0600 socket).
  try {
    chmodSync(dir, 0o750);
  } catch (error) {
    log({ dir, error: String(error?.message ?? error) }, "socket directory chmod failed");
  }

  try {
    await listenOnce(server, socketPath);
  } catch (error) {
    server.close();
    const classification = await classifySocketPath(socketPath);
    log(
      { socketPath, code: error.code, classification },
      "singleton bind refused — socket path held (fail-closed)",
    );
    return { ok: false, code: STARTUP_REFUSED_SOCKET_HELD, error, classification };
  }
  try {
    chmodSync(socketPath, 0o600);
  } catch (error) {
    log({ socketPath, error: String(error?.message ?? error) }, "socket chmod failed");
  }
  return { ok: true, server };
}

// ---------------------------------------------------------------------------
// Authenticated retention writer IPC (§9.2/R3-S1) — raw newline-delimited
// JSON over the singleton UDS. One request per connection:
//   → { credential, envelope }
//   ← { ok:true, receipt } | { ok:false, code, message? }
// ---------------------------------------------------------------------------

function respondJson(socket, payload) {
  try {
    socket.end(`${JSON.stringify(payload)}\n`);
  } catch {
    /* client already gone — nothing durable happened */
  }
}

export async function handleWriterRequest({
  request,
  config,
  spool,
  principalMap,
  credential,
  log = () => {},
  hooks = {},
  now = () => new Date(),
}) {
  // Mandatory per-request credential — timing-safe compare (R3/S1). There is
  // no optional-token path and no insecure flag.
  if (
    !request ||
    typeof request !== "object" ||
    !credentialsMatch(request.credential, credential)
  ) {
    log({ code: "writer_unauthenticated" }, "writer request refused — credential missing or wrong");
    return { ok: false, code: "writer_unauthenticated" };
  }
  if (request.control) {
    return handleControlRequest({ request: request.control, spool, log, now });
  }
  // Writer-side revalidation of every envelope invariant against the writer's
  // own copy of the operator map — BEFORE any quota reservation (§9.2).
  try {
    revalidateSealedEnvelope(request.envelope, principalMap);
  } catch (error) {
    log({ code: error.code }, "writer request refused — envelope revalidation failed");
    return { ok: false, code: error.code ?? "envelope_invalid" };
  }
  try {
    const record = spool.writerReceive(request.envelope, { mode: config.mode });
    hooks.onRetained?.(record);
    log({ id: record.id, state: record.state }, "envelope retained durably");
    return {
      ok: true,
      receipt: {
        id: record.id,
        state: record.state,
        dedupKey: record.dedupKey,
        requestId: record.requestId,
        digest: record.digest,
        receipts: record.receipts,
      },
    };
  } catch (error) {
    if (error instanceof SpoolError) {
      // Truthful bounded refusal (spool_full_count / spool_full_bytes) — zero
      // partial file, accepted work never evicted (§9.1).
      return { ok: false, code: error.code, message: error.message };
    }
    throw error;
  }
}

/**
 * Operator hold-resume (§9.3), executed INSIDE the single writer process
 * (M5): re-pends operator-held envelopes. Mechanical holds
 * (hold_api_compat / hold_operator_fence) resume automatically when their
 * condition clears and are reported, not touched.
 */
export function handleControlRequest({ request, spool, log = () => {}, now = () => new Date() }) {
  if (request?.op !== "resume") {
    return { ok: false, code: "control_unsupported" };
  }
  const resumed = [];
  const skipped = [];
  for (const record of spool.list()) {
    if (request.id && record.id !== request.id) continue;
    if (!OPERATOR_HOLD_STATES.has(record.state)) {
      if (!request.id || record.id === request.id) {
        skipped.push({
          id: record.id,
          state: record.state,
          reason: OPERATOR_AUTO_HOLD_STATES.has(record.state)
            ? "auto-resumes when the condition clears"
            : "not held",
        });
      }
      if (request.id) break;
      continue;
    }
    spool.updateState(record.id, {
      state: "pending",
      holdReason: null,
      receipts: [
        ...record.receipts,
        {
          kind: "resumed_by_operator",
          at: now().toISOString(),
          note: `resumed from ${record.state}`,
        },
      ],
    });
    resumed.push(record.id);
    if (request.id) break;
  }
  log({ resumed, skipped }, "operator hold-resume executed");
  return { ok: true, control: "resume", resumed, skipped };
}

/**
 * Transport-level frame cap for one writer request (R4): the writer never
 * buffers more than this per connection, regardless of what the peer streams.
 * The per-principal payload bound is a separate, post-parse check
 * (`revalidateSealedEnvelope`); this cap is the memory/connection bound.
 */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/**
 * Create the retention-writer server (raw net server on the singleton UDS).
 * The retention boundary (quota reservation → temp write → fsync → rename →
 * directory fsync → receipt) runs synchronously inside this single process —
 * concurrent submitters are serialized by the event loop, which IS the M5
 * single-writer contract.
 *
 * The frame cap is an ACTUAL bound (R4): past it the writer stops
 * accumulating (releases the partial frame), answers the truthful
 * `request_too_large` refusal, and destroys the peer once the refusal is on
 * the wire — an active non-terminating stream can no longer keep the
 * connection (and the memory) alive past the cap, and no record or wake can
 * ever arise from a refused frame (the writer path holds no wake reference
 * at all). Credential verification stays mandatory on every processed frame.
 */
export function createWriterServer({
  config,
  spool,
  principalMap,
  credential,
  log = () => {},
  hooks = {},
  now = () => new Date(),
}) {
  if (typeof credential !== "string" || credential.length === 0) {
    throw new Error("writer credential is mandatory (§9.2) — refusing to start the writer");
  }
  // allowHalfOpen: the client half-closes after its request (framed end), and
  // the reply is produced asynchronously — the socket must stay writable after
  // the client's FIN or the reply would be silently dropped by autoDestroy.
  return createServer({ allowHalfOpen: true }, (socket) => {
    // Byte-preserving frame accumulation (R5 — finding 423c1656968f): received
    // chunks are held as raw BYTES until one complete frame is available, and
    // UTF-8 is decoded exactly once at the framed end. Per-chunk string
    // decoding irreversibly replaced bytes split across read boundaries with
    // U+FFFD, so any multi-byte frame spanning several reads (Cyrillic/CJK
    // content) arrived corrupted and was refused `digest_mismatch`. The frame
    // cap is counted from RAW chunk bytes BEFORE accumulation, so the bound
    // holds whether or not the frame ever completes.
    let frameChunks = [];
    let frameBytes = 0;
    let answered = false;
    const answer = (payload) => {
      if (answered) return;
      answered = true;
      respondJson(socket, payload);
    };
    socket.setTimeout(30_000, () => socket.destroy());
    socket.on("data", (chunk) => {
      if (answered) return; // refused frame — never accumulate another byte
      if (frameBytes + chunk.length > MAX_FRAME_BYTES) {
        log(
          { code: "request_too_large", bytes: frameBytes + chunk.length },
          "writer frame cap exceeded — refusing and closing the peer",
        );
        frameChunks = []; // release the oversized frame from memory immediately
        frameBytes = 0;
        answered = true;
        try {
          socket.end(`${JSON.stringify({ ok: false, code: "request_too_large" })}\n`, () => {
            // Refusal flushed — now end the unbounded stream for good. destroy()
            // closes BOTH directions, so a peer that never sends FIN cannot
            // hold the connection open (the idle timeout alone would not fire
            // on an active stream).
            socket.destroy();
          });
        } catch {
          socket.destroy();
        }
        return;
      }
      frameChunks.push(chunk);
      frameBytes += chunk.length;
    });
    socket.on("end", () => {
      if (answered) return;
      let request = null;
      try {
        // One decode over the complete received byte sequence — a split
        // multi-byte sequence is reassembled before UTF-8 decoding.
        request = JSON.parse(Buffer.concat(frameChunks).toString("utf8"));
      } catch {
        answer({ ok: false, code: "invalid_request" });
        return;
      }
      handleWriterRequest({ request, config, spool, principalMap, credential, log, hooks, now })
        .then(answer)
        .catch((error) => {
          log({ error: String(error?.message ?? error) }, "writer request handling failed");
          answer({ ok: false, code: "writer_error" });
        });
    });
    socket.on("error", () => {
      /* client vanished mid-request — release the socket either way */
      socket.destroy();
    });
  });
}

// ---------------------------------------------------------------------------
// Compat probe (§9.3/M3) — runtime mismatch detector, never a fence.
// ---------------------------------------------------------------------------

/**
 * Probe `GET {endpoint}/agent/status` for `intakeCompat`. `reachable` is
 * reported separately from `ok`: a network-level failure means the PC may be
 * asleep (wake applies); a content mismatch means the PC is UP but the API
 * contract drifted (no wake — it would be pointless).
 *
 * The probe carries the relay's own configured service participant session
 * (§5) as a cookie, exactly like deliverOne/watchOne: under
 * PARTICIPANTS_MODE_ENABLED — the only mode in which the keyed branch admits —
 * the API's global participantAuth middleware 401s every non-public path, and
 * /agent/status is not public. An unauthenticated probe therefore parks all
 * keyed delivery as hold_api_compat forever; `runCycle` always passes the
 * loaded session token here. GET is a CSRF-safe method: no origin or
 * x-csrf-token is required (and none is sent — probe redaction keeps the
 * cookie out of logs). A missing/invalid/revoked session is answered 401 →
 * `probe_status_401` → reachable-but-blocked fail-closed park, no wake.
 */
export async function probeCompat({
  endpoint,
  expectedLevel,
  sessionCookieName,
  sessionToken,
  fetchImpl = fetch,
  log = () => {},
}) {
  let response;
  try {
    const headers = { accept: "application/json" };
    if (sessionToken) {
      headers.cookie = `${sessionCookieName}=${sessionToken}`;
    }
    response = await fetchImpl(`${endpoint.replace(/\/$/, "")}/agent/status`, {
      method: "GET",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    return {
      ok: false,
      reachable: false,
      reason: `probe_unreachable: ${error?.cause?.code ?? error?.name ?? "error"}`,
    };
  }
  if (response.status !== 200) {
    return { ok: false, reachable: true, reason: `probe_status_${response.status}` };
  }
  let parsed;
  try {
    parsed = await response.json();
  } catch {
    return { ok: false, reachable: true, reason: "probe_unparseable" };
  }
  if (!parsed || typeof parsed !== "object" || parsed.intakeCompat === undefined) {
    // An API without the field lacks the keyed path → zero POSTs (M3).
    return { ok: false, reachable: true, reason: "probe_missing_intakeCompat" };
  }
  if (parsed.intakeCompat !== expectedLevel) {
    return {
      ok: false,
      reachable: true,
      reason: `probe_level_mismatch: ${JSON.stringify(parsed.intakeCompat)}`,
    };
  }
  log({ level: expectedLevel }, "compat probe passed");
  return { ok: true, reachable: true, level: parsed.intakeCompat };
}

// ---------------------------------------------------------------------------
// §7.5 response classification.
// ---------------------------------------------------------------------------

/**
 * Map an admission HTTP status to the relay's response class (plan §7.5):
 *   201 → created (admission receipt); 200 → replayed (original task);
 *   409 → conflict / 410 → tombstone (terminal, reported, not retried);
 *   network error / timeout / 5xx / 429 → retry (unknown admission outcome —
 *                 bounded exponential backoff of the byte-identical body);
 *   every other 4xx (401/403/422/400/404) → hold_auth_config: retained HOLD
 *                 with no retry and no wake. Under §7.5 ordering a keyed 422
 *                 can only be a principal/attachments/structural fault and a
 *                 keyed 404 a scope/config mismatch — always operator
 *                 conditions, never silently discarded accepted work.
 */
export function classifyAdmissionStatus(status) {
  if (status === 201) return { kind: "created" };
  if (status === 200) return { kind: "replayed" };
  if (status === 409) return { kind: "terminal_conflict" };
  if (status === 410) return { kind: "terminal_tombstone" };
  if (status >= 500 || status === 429) return { kind: "retry" };
  return { kind: "hold_auth_config" };
}

// ---------------------------------------------------------------------------
// The deliverer.
// ---------------------------------------------------------------------------

const DELIVERY_CAPABLE_STATES = new Set(["pending", "hold_api_compat", "hold_operator_fence"]);

export function createDeliverer({
  config,
  spool,
  wake = null,
  fetchImpl = fetch,
  log = () => {},
  now = () => new Date(),
}) {
  if (config.mode === "deliver") {
    if (!config.sessionToken) {
      throw new Error("deliver mode requires the loaded session token (§5)");
    }
    if (!config.csrfToken) {
      throw new Error("deliver mode requires the loaded session-bound CSRF token");
    }
  }
  let draining = false;
  let running = false;
  let cycleCount = 0;
  let cycleInFlight = Promise.resolve();
  let endpointHealthy = true;
  let lastCycleResult = null;
  let lastProbe = null;
  let timer = null;

  const nowIso = () => new Date(now().getTime()).toISOString();

  function deliveryCandidates() {
    return spool
      .list()
      .filter((record) => DELIVERY_CAPABLE_STATES.has(record.state))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  function parkDeliveryCapable(state, note) {
    for (const record of deliveryCandidates()) {
      if (record.state === state) continue;
      spool.updateState(record.id, {
        state,
        holdReason: note,
        receipts: [...record.receipts, { kind: `parked_${state}`, at: nowIso(), note }],
      });
    }
  }

  function resumeMechanicalHolds(fromState) {
    for (const record of spool.list()) {
      if (record.state !== fromState) continue;
      spool.updateState(record.id, {
        state: "pending",
        holdReason: null,
        receipts: [
          ...record.receipts,
          { kind: "resumed_from_hold", at: nowIso(), note: `condition cleared: ${fromState}` },
        ],
      });
    }
  }

  function isFutureScheduled(scheduledAt) {
    if (typeof scheduledAt !== "string" || scheduledAt.length === 0) return false;
    const at = Date.parse(scheduledAt);
    return !Number.isNaN(at) && at > now().getTime();
  }

  function admittedUnconfirmedEligible() {
    return spool
      .list()
      .filter((record) => record.state === "admitted" && !isFutureScheduled(record.scheduledAt));
  }

  function outstandingWorkExists() {
    return deliveryCandidates().length > 0 || admittedUnconfirmedEligible().length > 0;
  }

  async function maybeWake(reason) {
    if (config.mode !== "deliver" || !wake) return { fired: false, reason: "no-wake-engine" };
    if (!outstandingWorkExists()) return { fired: false, reason: "no-outstanding-work" };
    return wake.trigger(reason);
  }

  function wakeResetOnPcEvidence() {
    // A passing compat probe is ROUTINE-CYCLE evidence only: it marks the
    // endpoint healthy but must NOT reset the wake episode. Resetting here
    // meant the §8.3 bounds could never accumulate — an admitted-unconfirmed
    // envelope whose handover GET was unreachable while the probe still
    // answered would fire a fresh wake every cycle, unbounded (no storm cap).
    // The episode resets on strong PC evidence only (R1 rework repair):
    // resetWakeEpisode() below — an answered admission POST — and the
    // completed_pickup reset at the end of the watch phase.
    endpointHealthy = true;
  }

  function resetWakeEpisode() {
    // Strong PC evidence (admission POST answered): the next suspend starts a
    // fresh, fully-budgeted wake episode (§8.3).
    endpointHealthy = true;
    wake?.reset();
  }

  function appendReceipt(record, entry) {
    return spool.updateState(record.id, {
      receipts: [...record.receipts, { at: nowIso(), ...entry }],
    });
  }

  function deliveryHeaders() {
    return {
      "content-type": "application/json",
      // Participant sessions resolve from the session cookie (participantAuth
      // middleware) — the relay presents its service session as a cookie.
      cookie: `${config.sessionCookieName}=${config.sessionToken}`,
      origin: config.origin,
      "x-csrf-token": config.csrfToken,
    };
  }

  function admissionEndpoint() {
    return `${config.endpoint.replace(/\/$/, "")}/tasks`;
  }

  function taskEndpoint(id) {
    return `${config.endpoint.replace(/\/$/, "")}/tasks/${id}`;
  }

  function keyedBody(record) {
    // Byte-identical on every retry (§7.4): the sealed body is frozen and the
    // intake identity is the namespaced request ID. JSON.stringify over the
    // same frozen object is deterministic.
    return JSON.stringify({ ...record.body, intake: { requestId: record.requestId } });
  }

  function scheduleRetry(record, note) {
    const attempts = (record.attempts ?? 0) + 1;
    if (attempts >= config.retryMax) {
      spool.updateState(record.id, {
        state: "hold_handover_unconfirmed",
        holdReason: "delivery retry budget exhausted; admission outcome unknown",
        attempts,
        receipts: [...record.receipts, { kind: "hold_handover_unconfirmed", at: nowIso(), note }],
      });
      return { outcome: "hold_handover_unconfirmed" };
    }
    const backoffMs = Math.min(
      config.retryBackoffMs * 2 ** (attempts - 1),
      10 * config.retryBackoffMs,
    );
    appendReceipt(record, {
      kind: "delivery_retry_scheduled",
      attempts,
      note: `${note}; retry in ${backoffMs}ms`,
    });
    spool.updateState(record.id, {
      attempts,
      nextAttemptAt: new Date(now().getTime() + backoffMs).toISOString(),
    });
    return { outcome: "retry_scheduled" };
  }

  async function deliverOne(record) {
    let response;
    try {
      response = await fetchImpl(admissionEndpoint(), {
        method: "POST",
        headers: deliveryHeaders(),
        body: keyedBody(record),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      // Unknown admission outcome (§7.5): bounded exponential backoff retry of
      // the identical body — safe, because a commit resolves as replay.
      endpointHealthy = false;
      const result = scheduleRetry(
        record,
        `transport error: ${error?.cause?.code ?? error?.name ?? "error"}`,
      );
      if (result.outcome === "retry_scheduled") {
        await maybeWake("endpoint_unreachable");
      }
      return result;
    }

    const text = await response.text();
    let parsed = null;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    const classification = classifyAdmissionStatus(response.status);

    if (classification.kind === "retry") {
      endpointHealthy = false;
      return scheduleRetry(record, `admission status ${response.status}`);
    }

    if (classification.kind === "hold_auth_config") {
      // Retained HOLD (§7.5): no retry, no wake — always a config/auth
      // condition under §7.5 ordering. Resumed only by operator hold-resume.
      spool.updateState(record.id, {
        state: "hold_auth_config",
        holdReason: `admission status ${response.status}`,
        receipts: [
          ...record.receipts,
          {
            kind: "hold_auth_config",
            at: nowIso(),
            note: `admission status ${response.status}${parsed?.code ? ` (${parsed.code})` : ""}`,
          },
        ],
      });
      return { outcome: "hold_auth_config" };
    }

    if (
      classification.kind === "terminal_conflict" ||
      classification.kind === "terminal_tombstone"
    ) {
      const state = classification.kind === "terminal_conflict" ? "rejected" : "tombstoned";
      spool.updateState(record.id, {
        state,
        holdReason: null,
        receipts: [
          ...record.receipts,
          {
            kind: state,
            at: nowIso(),
            note: `admission status ${response.status} — terminal, not retried`,
          },
        ],
      });
      return { outcome: state };
    }

    // 201 created / 200 replayed — admission receipt (§7.5). The PC is
    // demonstrably awake (it answered the POST): reset the wake episode.
    resetWakeEpisode();
    const task = parsed ?? {};
    const scheduledAt = typeof task.scheduledAt === "string" ? task.scheduledAt : null;
    const taskId = typeof task.id === "string" ? task.id : null;

    if (isFutureScheduled(scheduledAt)) {
      // Eligibility split (§8.3): future-scheduled work needs no handover
      // watch — the relay owns no timers (R4/D7). Due-while-asleep stays D7.
      spool.updateState(record.id, {
        state: "completed",
        taskId,
        scheduledAt,
        holdReason: null,
        receipts: [
          ...record.receipts,
          {
            kind: classification.kind === "created" ? "admitted" : "replayed",
            at: nowIso(),
            note: `status ${response.status}; scheduled for ${scheduledAt}; completed at admission (no watch for future-due work)`,
          },
        ],
      });
      return { outcome: "completed_scheduled" };
    }

    spool.updateState(record.id, {
      state: "admitted",
      taskId,
      holdReason: null,
      watchAttempts: 0,
      lastWatchAt: null,
      receipts: [
        ...record.receipts,
        {
          kind: classification.kind === "created" ? "admitted" : "replayed",
          at: nowIso(),
          note: `status ${response.status}; handover watch started`,
        },
      ],
    });
    return { outcome: "admitted" };
  }

  function hasPickupEvidence(task, atMs) {
    if (!task || typeof task !== "object") return false;
    if (typeof task.status === "string" && task.status !== "backlog") return true;
    const lockedUntil = typeof task.lockedUntil === "string" ? Date.parse(task.lockedUntil) : NaN;
    return Boolean(task.lockedBy) && !Number.isNaN(lockedUntil) && lockedUntil > atMs;
  }

  function exhaustWatch(record, note) {
    spool.updateState(record.id, {
      state: "hold_handover_unconfirmed",
      holdReason: note,
      receipts: [...record.receipts, { kind: "hold_handover_unconfirmed", at: nowIso(), note }],
    });
    return { outcome: "hold_handover_unconfirmed" };
  }

  async function watchOne(record) {
    if (typeof record.taskId !== "string" || record.taskId.length === 0) {
      return exhaustWatch(record, "admitted envelope has no task id");
    }
    const dueForPoll =
      record.lastWatchAt === null ||
      now().getTime() - Date.parse(record.lastWatchAt) >= nextWatchDelayMs(record);
    if (!dueForPoll) return { outcome: "watch_waiting" };
    if ((record.watchAttempts ?? 0) >= config.handoverPollMax) {
      return exhaustWatch(record, "handover poll budget exhausted without pickup evidence");
    }

    let response;
    try {
      response = await fetchImpl(taskEndpoint(record.taskId), {
        method: "GET",
        headers: {
          accept: "application/json",
          cookie: `${config.sessionCookieName}=${config.sessionToken}`,
        },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // Mid-handover suspend (M1): the PC went down between commit and
      // pickup — bounded WoL, forward re-establishes, polling resumes.
      // Advance only the cadence marker (the next poll waits out the backoff)
      // but NOT the pickup budget: recovery work in progress must not be
      // converted into a hold by endpoint downtime alone.
      endpointHealthy = false;
      spool.updateState(record.id, { lastWatchAt: nowIso() });
      await maybeWake("endpoint_unreachable_mid_handover");
      return { outcome: "watch_unreachable" };
    }

    if (response.status === 404) {
      // The admitted task was deleted after admission: delivery itself
      // completed; the canonical answer for this request ID is now the
      // tombstone (never re-admitted).
      spool.updateState(record.id, {
        state: "completed",
        holdReason: null,
        receipts: [
          ...record.receipts,
          {
            kind: "completed",
            at: nowIso(),
            note: "admitted task no longer exists (deleted post-admission); watch closed",
          },
        ],
      });
      return { outcome: "completed_deleted" };
    }
    if (response.status !== 200) {
      // The endpoint was REACHED and answered a non-200: this poll happened
      // and can never yield pickup evidence, so it consumes the bounded
      // budget and advances the backoff like a real poll. Without this, a
      // persistently erroring endpoint (5xx/auth config) polls once per
      // cycle forever while the envelope stays admitted (independent-review
      // repair); exhausting the budget lands in the standard truthful hold.
      spool.updateState(record.id, {
        watchAttempts: (record.watchAttempts ?? 0) + 1,
        lastWatchAt: nowIso(),
      });
      appendReceipt(record, {
        kind: "watch_poll_error",
        note: `GET /tasks status ${response.status} (poll ${(record.watchAttempts ?? 0) + 1}/${config.handoverPollMax})`,
      });
      return { outcome: "watch_poll_error" };
    }

    let task = null;
    try {
      task = await response.json();
    } catch {
      task = null;
    }
    spool.updateState(record.id, {
      watchAttempts: (record.watchAttempts ?? 0) + 1,
      lastWatchAt: nowIso(),
    });
    if (hasPickupEvidence(task, now().getTime())) {
      spool.updateState(record.id, {
        state: "completed",
        holdReason: null,
        receipts: [
          ...record.receipts,
          {
            kind: "completed",
            at: nowIso(),
            note: `pickup evidence: status ${task?.status ?? "unknown"}`,
          },
        ],
      });
      return { outcome: "completed_pickup" };
    }
    return { outcome: "watch_pending" };
  }

  function nextWatchDelayMs(record) {
    // Bounded exponential backoff (§8.3), capped at 10× the base interval.
    const attempts = Math.max((record.watchAttempts ?? 0) - 1, 0);
    return Math.min(
      config.handoverPollBackoffMs * 2 ** attempts,
      10 * config.handoverPollBackoffMs,
    );
  }

  async function runCycle() {
    if (config.mode !== "deliver") {
      // Retain-only: zero network calls, zero wake (§5).
      cycleCount += 1;
      lastCycleResult = { mode: "retain-only", networkCalls: 0 };
      return lastCycleResult;
    }
    if (draining) return { skipped: "draining" };
    cycleCount += 1;

    // Operator fence — before every delivery cycle (§9.3). A systemd
    // auto-restart stays fenced because the fence is also checked at startup.
    const fence = readFence(config.fencePath);
    if (fence) {
      parkDeliveryCapable(
        "hold_operator_fence",
        `operator fence active since ${fence.at}: ${fence.reason}`,
      );
      lastCycleResult = { fenced: true, networkCalls: 0 };
      return lastCycleResult;
    }
    resumeMechanicalHolds("hold_operator_fence");

    // Compat probe (§9.3/M3): missing/mismatched/unparseable → ALL keyed
    // delivery parks as hold_api_compat with ZERO POSTs to /tasks. The probe
    // presents the same relay service session as the delivery/watch calls:
    // /agent/status is participantAuth-gated in the only mode that admits.
    lastProbe = await probeCompat({
      endpoint: config.endpoint,
      expectedLevel: config.intakeCompatLevel,
      sessionCookieName: config.sessionCookieName,
      sessionToken: config.sessionToken,
      fetchImpl,
      log,
    });
    if (!lastProbe.ok) {
      parkDeliveryCapable("hold_api_compat", lastProbe.reason);
      if (!lastProbe.reachable) {
        // Endpoint unreachable — PC may be asleep; bounded wake (M1).
        await maybeWake("endpoint_unreachable");
      }
      lastCycleResult = { compatBlocked: lastProbe.reason, networkCalls: 0 };
      return lastCycleResult;
    }
    wakeResetOnPcEvidence();
    resumeMechanicalHolds("hold_api_compat");

    // FIFO delivery of due pending envelopes.
    const due = deliveryCandidates()
      .filter((record) => record.state === "pending")
      .filter(
        (record) => !record.nextAttemptAt || Date.parse(record.nextAttemptAt) <= now().getTime(),
      );
    const delivery = [];
    for (const record of due) {
      if (draining) break;
      // R4/C2 defense-in-depth: immediate pre-POST fence re-check — a delivery
      // scheduled earlier cannot evade a fence that lands while it awaits the
      // compat probe. Never a replacement for the full swap ordering.
      if (readFence(config.fencePath)) {
        parkDeliveryCapable("hold_operator_fence", "operator fence landed mid-cycle");
        break;
      }
      delivery.push({ id: record.id, ...(await deliverOne(spool.get(record.id) ?? record)) });
    }

    // Handover watch (§8.3/M1) over admitted-unconfirmed eligible envelopes.
    const watch = [];
    for (const record of admittedUnconfirmedEligible()) {
      if (draining) break;
      watch.push({ id: record.id, ...(await watchOne(spool.get(record.id) ?? record)) });
    }
    if (watch.some((entry) => entry.outcome === "completed_pickup")) {
      // Pickup evidence proves the PC is up and consuming — the next wake
      // episode starts fresh for any future suspend.
      wake?.reset();
    }

    lastCycleResult = {
      mode: "deliver",
      networkCalls: delivery.length + watch.length,
      delivery,
      watch,
    };
    return lastCycleResult;
  }

  function start({ intervalMs = config.cycleMs } = {}) {
    if (running) return;
    running = true;
    // Fence check at startup (§9.3).
    const startupFence = readFence(config.fencePath);
    if (startupFence) {
      log({ fence: startupFence }, "startup under operator fence — delivery stays parked");
    }
    // Restart scan (§9.1): discard receipt-less temps, reconcile uncertain
    // in-flight admissions back to pending (idempotent by binding), and
    // quarantine unparseable records without blocking startup. Without this
    // a crash between commit and response recording could leave an `admitted`
    // envelope dormant forever.
    const scan = spool.restartScan();
    // `boundRefused` is surfaced like every other reconciliation outcome (R5):
    // a crash-reconciliation re-pend refused by the storage bounds is an
    // operator-visible event (docs/workstation-intake.md runbook), not a
    // silent pass — the on-disk state is preserved and the handover watch or
    // an operator resume still owns the record.
    if (
      scan.discardedTemps.length > 0 ||
      scan.rePended.length > 0 ||
      scan.corrupted.length > 0 ||
      scan.boundRefused.length > 0
    ) {
      log(
        {
          discardedTemps: scan.discardedTemps,
          rePended: scan.rePended,
          corrupted: scan.corrupted,
          boundRefused: scan.boundRefused,
        },
        "restart scan reconciled spool state (§9.1)",
      );
    }
    const tick = async () => {
      const cycle = runCycle().catch((error) => {
        log({ error: String(error?.message ?? error) }, "delivery cycle failed");
      });
      cycleInFlight = cycle;
      await cycle;
      if (running) timer = setTimeout(tick, intervalMs);
    };
    timer = setTimeout(tick, 0);
  }

  async function stop() {
    draining = true;
    running = false;
    if (timer) clearTimeout(timer);
    // Graceful drain: the in-flight cycle finishes before this resolves.
    // This source NEVER calls unlink on the socket path (R4/C1) — the OS
    // releases the path naturally when the owning handle closes on a clean
    // shutdown. A crash/power-loss leaves the stale path in place, where it
    // fail-closed-blocks the next start until supervisor/owner cleanup.
    await cycleInFlight;
  }

  function state() {
    return {
      mode: config.mode,
      draining,
      running,
      cycleCount,
      endpointHealthy,
      lastProbe,
      lastCycleResult,
      wake: wake?.status?.() ?? null,
    };
  }

  return { runCycle, start, stop, state, deliveryCandidates, parkDeliveryCapable };
}

// ---------------------------------------------------------------------------
// Credential loading (owner-installed 0600 files outside the repository).
// ---------------------------------------------------------------------------

export function loadSecretFile(path, label) {
  if (!path) throw new Error(`${label} path is required`);
  let value;
  try {
    value = readFileSync(path, "utf8").trim();
  } catch (error) {
    throw new Error(`${label} unreadable at ${path}: ${error.message}`);
  }
  if (value.length === 0) throw new Error(`${label} at ${path} is empty`);
  return value;
}

// ---------------------------------------------------------------------------
// CLI service entry.
// ---------------------------------------------------------------------------

export async function runService({ config, spool, principalMap, log = console.error }) {
  const credential = loadSecretFile(config.writerCredentialPath, "writer credential");

  const sessionToken =
    config.mode === "deliver" ? loadSecretFile(config.sessionTokenPath, "session token") : null;
  const csrfToken =
    config.mode === "deliver" ? loadSecretFile(config.csrfTokenPath, "CSRF token") : null;
  const serviceConfig = sessionToken !== null ? { ...config, sessionToken, csrfToken } : config;

  const server = createWriterServer({
    config: serviceConfig,
    spool,
    principalMap,
    credential,
    log,
  });

  // Singleton bind BEFORE any spool mutation — a refused bind leaves the
  // spool untouched (R4/C1).
  const bound = await bindWriterSocket({ server, socketPath: config.socketPath, log });
  if (!bound.ok) {
    log(
      JSON.stringify({
        state: STARTUP_REFUSED_SOCKET_HELD,
        socketPath: config.socketPath,
        classification: bound.classification,
        error: String(bound.error?.code ?? bound.error?.message ?? bound.error),
      }),
    );
    process.exitCode = 78;
    return { ok: false, code: STARTUP_REFUSED_SOCKET_HELD, classification: bound.classification };
  }

  const wake =
    config.mode === "deliver" && config.wakeCommand
      ? createWakeEngine({
          command: config.wakeCommand,
          maxRepeats: config.wakeMaxRepeats,
          backoffMs: config.wakeBackoffMs,
          windowMs: config.wakeWindowMs,
          log: (meta, message) => log(JSON.stringify({ component: "wake", ...meta }), message),
        })
      : null;

  const deliverer = createDeliverer({ config: serviceConfig, spool, wake, log });

  const shutdown = async (signal) => {
    log(JSON.stringify({ state: "draining", signal }));
    await deliverer.stop();
    server.close();
    // Intentionally NOT unlinking the socket path (R4/C1).
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  deliverer.start();
  log(JSON.stringify({ state: "running", mode: config.mode, socketPath: config.socketPath }));
  return { ok: true, deliverer, server };
}
