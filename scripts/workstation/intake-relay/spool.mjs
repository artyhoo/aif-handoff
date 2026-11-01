// Durable spool owned by the single deliverer process (plan §9.1, M5).
//
// ALL spool mutations happen inside the writer process (deliverer), which
// executes the retention boundary serially per envelope:
//   quota reservation → temp file (O_EXCL) → fsync(file) → rename into place
//   → fsync(parent directory) → issue receipt.
// Because reservation, write, durability, and ACK are serialized inside one
// process, concurrent submitters cannot each observe the last free slot.
//
// Envelope states:
//   pending → (deliver) → admitted → completed
//   pending → rejected (409/410 terminal at admission) | tombstoned (410)
//   any delivery-capable state → hold_auth_config | hold_api_compat |
//                                hold_operator_fence | hold_handover_unconfirmed
// `retained` is the honest deliver-mode-waiting state of a receipt issued in
// retain-only mode (delivery pending: transport not configured).

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  fsyncSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export const SPOOL_STATES = [
  "pending",
  "retained",
  "admitted",
  "completed",
  "rejected",
  "tombstoned",
  "hold_auth_config",
  "hold_api_compat",
  "hold_operator_fence",
  "hold_handover_unconfirmed",
];

const TEMP_PREFIX = ".tmp-";

export class SpoolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SpoolError";
    this.code = code;
  }
}

function fsyncDir(dirPath) {
  let fd = -1;
  try {
    fd = openSync(dirPath, "r");
    fsyncSync(fd);
  } catch {
    // Some filesystems refuse O_RDONLY directory fsync; durability then rests
    // on the file fsync + rename alone. Never hides a refusal to WRITE.
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

function writeFileDurable(filePath, data) {
  const tmpPath = join(
    dirnameOf(filePath),
    `${TEMP_PREFIX}${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
  );
  const fd = openSync(tmpPath, "wx"); // O_EXCL — unique name, never clobbers
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, filePath);
  fsyncDir(dirnameOf(filePath));
  return filePath;
}

function dirnameOf(filePath) {
  const idx = filePath.lastIndexOf("/");
  return idx <= 0 ? "/" : filePath.slice(0, idx);
}

export function createSpool({ dir, maxEnvelopes, maxBytes, now = () => new Date().toISOString() }) {
  mkdirSync(dir, { recursive: true });

  function envelopePath(id) {
    return join(dir, `${id}.json`);
  }

  function readEnvelopeFile(id) {
    return JSON.parse(readFileSync(envelopePath(id), "utf8"));
  }

  function writeEnvelope(record) {
    record.updatedAt = now();
    writeFileDurable(envelopePath(record.id), `${JSON.stringify(record, null, 2)}\n`);
    return record;
  }

  function stats() {
    let count = 0;
    let bytes = 0;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".json")) continue;
      count += 1;
      bytes += statSync(join(dir, entry)).size;
    }
    return { count, bytes };
  }

  /**
   * The §9.1 retention boundary. Throws SpoolError with truthful refusal codes
   * on quota exhaustion — never evicts accepted work, never leaves a partial
   * file behind.
   *
   * Bridge-level replay: a record for the same dedup key already in the spool
   * (commit-before-ACK-loss retry, concurrent duplicate submit) returns the
   * EXISTING record with a `retention_replayed` receipt — no second record, no
   * quota consumption, no double delivery (the API binding stays the canonical
   * replay authority, §7.2).
   */
  function writerReceive(envelope, { mode }) {
    const existing = list().find((record) => record.dedupKey === envelope.dedupKey);
    if (existing) {
      existing.receipts.push({ kind: "retention_replayed", at: now() });
      writeEnvelope(existing);
      return existing;
    }

    const { count, bytes } = stats();
    if (count >= maxEnvelopes) {
      throw new SpoolError(
        "spool_full_count",
        `spool holds ${count} envelopes (limit ${maxEnvelopes})`,
      );
    }
    const incomingBytes = Buffer.byteLength(`${JSON.stringify(envelope, null, 2)}\n`, "utf8");
    if (bytes + incomingBytes > maxBytes) {
      throw new SpoolError("spool_full_bytes", `spool would exceed ${maxBytes} bytes`);
    }

    const record = {
      // Spool-local record id: digest prefix + random suffix, so two envelopes
      // sealed in the same millisecond can never collide on a filename.
      id: `${envelope.sealedAt.replace(/[:.]/g, "-")}-${envelope.digest.slice(0, 12)}-${randomBytes(4).toString("hex")}`,
      createdAt: envelope.sealedAt,
      updatedAt: envelope.sealedAt,
      state: mode === "deliver" ? "pending" : "retained",
      deliveryPending: mode !== "deliver",
      dedupKey: envelope.dedupKey,
      projectId: envelope.projectId,
      requestId: envelope.requestId,
      digest: envelope.digest,
      principal: envelope.principal,
      body: envelope.body,
      bodyBytes: envelope.bodyBytes,
      scheduledAt: envelope.body?.scheduledAt ?? null,
      receipts: [],
      attempts: 0,
      holdReason: null,
    };
    writeFileDurable(envelopePath(record.id), `${JSON.stringify(record, null, 2)}\n`);
    // The receipt is issued only after the parent-directory fsync inside
    // writeFileDurable — the file is durable before this line runs.
    record.receipts.push({
      kind: "retention",
      at: now(),
      state: record.state,
      note:
        mode === "deliver"
          ? "retained (delivery queued)"
          : "retained (delivery pending: transport not configured)",
    });
    writeEnvelope(record);
    return record;
  }

  function list() {
    return readdirSync(dir)
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => {
        try {
          return JSON.parse(readFileSync(join(dir, entry), "utf8"));
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  function get(id) {
    const path = envelopePath(id);
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  }

  function updateState(id, patch) {
    const record = get(id);
    if (!record) throw new SpoolError("envelope_missing", `no envelope ${id}`);
    Object.assign(record, patch);
    return writeEnvelope(record);
  }

  /**
   * Restart scan (§9.1): receipt-less temp files are discarded (no receipt was
   * ever issued for them; resubmit is idempotent at the API by binding);
   * every parsed envelope is conservatively re-pended to `pending` when its
   * state is delivery-capable (redelivery is idempotent by binding).
   */
  function restartScan() {
    const discardedTemps = [];
    const rePended = [];
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(TEMP_PREFIX)) {
        unlinkSync(join(dir, entry));
        discardedTemps.push(entry);
        continue;
      }
      if (!entry.endsWith(".json")) continue;
      const record = JSON.parse(readFileSync(join(dir, entry), "utf8"));
      if (record.state === "admitted") {
        // An in-flight admission attempt without a recorded terminal response
        // is an uncertain effect → back to pending (idempotent by binding).
        record.state = "pending";
        record.receipts.push({ kind: "restart_repended", at: now() });
        writeEnvelope(record);
        rePended.push(record.id);
      }
    }
    return { discardedTemps, rePended };
  }

  return { dir, writerReceive, list, get, updateState, restartScan, stats, envelopePath };
}

export { writeFileDurable, fsyncDir, rmSync };
