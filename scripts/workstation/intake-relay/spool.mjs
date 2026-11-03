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
// retain-only mode (delivery pending: transport not configured). It becomes
// deliverable through the restart-scan promotion (R8): when the relay starts
// in deliver mode, previously accepted retained envelopes are promoted to
// `pending` through this same durable bounded transition — exactly once,
// with all original receipts preserved — so enabling delivery after owner
// review never strands accepted work.

import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
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

/**
 * Private-filesystem boundary (R8 — finding f83f7699ae43; R9 completion):
 * spool records hold full client payloads, principal identities and request
 * IDs, so their privacy is enforced IN SOURCE, independently of the
 * deployment umask or any systemd UMask (which remains defense-in-depth).
 * Durable payload-bearing files (record temps, records, fence markers) are
 * created owner-only `0600`; relay-owned directories are created and kept no
 * broader than `0750`; and a mutating open of an EXISTING owned spool
 * tightens legacy broader modes of its known payload-bearing files (records,
 * temps, preserved record quarantine) BEFORE any acceptance — a directory
 * boundary alone would leave pre-R8 record files group-readable inside it.
 */
export const PRIVATE_DIR_MODE = 0o750;
export const PRIVATE_FILE_MODE = 0o600;

export class SpoolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SpoolError";
    this.code = code;
  }
}

/**
 * Tighten a relay-owned directory to no broader than `PRIVATE_DIR_MODE`
 * WITHOUT ever widening an already-stricter safe mode (e.g. 0700 stays 0700).
 * Only the named directory is touched — never a recursive chmod of
 * unrelated/foreign state — and a symlinked path is REFUSED (fail closed)
 * rather than followed outside the owned tree. A denied enforcement operation
 * throws `permission_enforcement_failed` so the caller fails closed before
 * any acceptance or mutation (a native permission failure can therefore never
 * produce a successful acceptance receipt).
 */
export function enforceOwnedPrivateDir(dirPath) {
  let stats;
  try {
    stats = lstatSync(dirPath);
  } catch (error) {
    throw new SpoolError(
      "spool_dir_unavailable",
      `relay directory ${dirPath} is unavailable: ${error.message}`,
    );
  }
  if (stats.isSymbolicLink()) {
    throw new SpoolError(
      "spool_symlink_refused",
      `relay directory ${dirPath} is a symlink — refusing to follow it outside the owned tree`,
    );
  }
  if (!stats.isDirectory()) {
    throw new SpoolError("spool_dir_unavailable", `relay path ${dirPath} is not a directory`);
  }
  const mode = stats.mode & 0o777;
  // Broader than 0750 = group-write, or ANY access for other. Stricter safe
  // modes (0700, 0500, …) are preserved untouched.
  if ((mode & 0o027) !== 0) {
    try {
      chmodSync(dirPath, PRIVATE_DIR_MODE);
    } catch (error) {
      throw new SpoolError(
        "permission_enforcement_failed",
        `cannot tighten relay directory ${dirPath} to 0${PRIVATE_DIR_MODE.toString(8)}: ${error.message}`,
      );
    }
  }
}

/**
 * Tighten KNOWN payload-bearing regular files in an owned relay directory
 * (R9 — completion of finding f83f7699ae43): a legacy spool written by the
 * pre-R8 writer under a permissive umask keeps valid records at `0644` even
 * after the directory is tightened to `0750` — the directory boundary alone
 * still lets the GROUP read those payloads. A mutating consumer therefore
 * tightens every known payload-bearing REGULAR file in the directory to
 * owner-only `0600` BEFORE any acceptance or other mutation:
 *   • envelope records (`*.json`),
 *   • receipt-less record temps (`.tmp-*`),
 *   • preserved record quarantine (`*.json.corrupt*`).
 * Already-stricter safe modes (0600, 0400, …) are preserved untouched;
 * entries that are not known payload-bearing spool state are never touched
 * (no recursive/foreign chmod); a payload-named SYMLINK is not a regular
 * file and is left exactly as found — chmod would FOLLOW it and mutate a
 * target outside the owned tree. A required tightening the OS denies throws
 * `permission_enforcement_failed` so the mutating open fails closed BEFORE
 * any acceptance (bytes, identities and receipts are never rewritten to
 * hide a mode; only the mode metadata changes).
 */
export function enforceOwnedPrivateRecords(dirPath) {
  let entries;
  try {
    entries = readdirSync(dirPath);
  } catch (error) {
    throw new SpoolError(
      "spool_dir_unavailable",
      `relay directory ${dirPath} is unreadable: ${error.message}`,
    );
  }
  for (const entry of entries) {
    const payloadBearing =
      entry.endsWith(".json") || entry.startsWith(TEMP_PREFIX) || entry.includes(".corrupt");
    if (!payloadBearing) continue;
    const path = join(dirPath, entry);
    let stats;
    try {
      stats = lstatSync(path); // lstat — never resolve a symlink to its target
    } catch (error) {
      throw new SpoolError(
        "permission_enforcement_failed",
        `cannot evaluate relay record ${path}: ${error.message}`,
      );
    }
    if (!stats.isFile()) continue; // symlink/dir at a payload-named path: untouched
    const mode = stats.mode & 0o777;
    if ((mode & ~PRIVATE_FILE_MODE) === 0) continue; // already owner-only-safe
    try {
      chmodSync(path, PRIVATE_FILE_MODE);
    } catch (error) {
      throw new SpoolError(
        "permission_enforcement_failed",
        `cannot tighten relay record ${path} to 0${PRIVATE_FILE_MODE.toString(8)}: ${error.message}`,
      );
    }
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
  // Private-filesystem boundary (R8 — finding f83f7699ae43): the durable file
  // is created owner-only `0600` EXPLICITLY — never left to the process
  // umask. An existing destination that is already stricter-safe (e.g. 0400)
  // keeps its mode: the atomic rename must not widen it.
  let fileMode = PRIVATE_FILE_MODE;
  try {
    const existing = statSync(filePath).mode & 0o777;
    if ((existing & ~PRIVATE_FILE_MODE) === 0) fileMode = existing;
  } catch {
    // New file — create at PRIVATE_FILE_MODE.
  }
  const fd = openSync(tmpPath, "wx", fileMode); // O_EXCL — unique name, never clobbers
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

export function createSpool({
  dir,
  maxEnvelopes,
  maxBytes,
  now = () => new Date().toISOString(),
  create = true,
}) {
  // Read-only consumers (`--status`) pass `create:false`: observing the spool
  // must never create it on a fresh host, and never chmod/repairs an existing
  // one — no creation, no mode change, no fixup (R8; independent-review
  // repair). Mutating consumers create the directory no broader than 0750 and
  // enforce that boundary explicitly (mkdir mode alone is umask-masked), so
  // existing owned-but-unsafe state is tightened — or the failure surfaces
  // truthfully — BEFORE any acceptance or mutation (R8). The same mutating
  // open also tightens the known payload-bearing FILES inside the directory
  // (records, temps, preserved record quarantine) to owner-only 0600 — the
  // directory boundary alone leaves legacy 0644 record files group-readable
  // (R9, completion of finding f83f7699ae43).
  if (create) {
    mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    enforceOwnedPrivateDir(dir);
    enforceOwnedPrivateRecords(dir);
  }

  function envelopePath(id) {
    return join(dir, `${id}.json`);
  }

  function writeEnvelope(record) {
    record.updatedAt = now();
    enforceRecordCapacity(record);
    writeFileDurable(envelopePath(record.id), `${JSON.stringify(record, null, 2)}\n`);
    return record;
  }

  function recordDurableBytes(record) {
    return Buffer.byteLength(`${JSON.stringify(record, null, 2)}\n`, "utf8");
  }

  /**
   * Byte bound enforced against the ACTUAL serialized durable representation of
   * the record (metadata, state, ownership fields, receipts — never a payload
   * estimate), including the quarantine bytes already occupying retained
   * capacity. Every persistence path that grows accepted state funnels through
   * here, so a full spool refuses truthfully and the previous durable bytes
   * survive exactly (the write below only ever renames a fully-written temp
   * over the path AFTER this check passed).
   *
   * The projected total is the retained bytes of everything ELSE plus the
   * record's ENTIRE new durable size — exactly what the directory will hold
   * after the rename (the record's own previous bytes are replaced, not
   * additive, so they enter the sum only through the new representation).
   */
  function enforceRecordCapacity(record) {
    const projectedTotal = retainedBytes(envelopePath(record.id)) + recordDurableBytes(record);
    if (projectedTotal > maxBytes) {
      throw new SpoolError("spool_full_bytes", `spool would exceed ${maxBytes} bytes`);
    }
  }

  function stats() {
    return { count: envelopeCount(), bytes: retainedBytes(null) };
  }

  function envelopeCount() {
    let count = 0;
    for (const entry of readdirSync(dir)) {
      if (entry.endsWith(".json")) count += 1;
    }
    return count;
  }

  /**
   * Total bytes of durable retained state in the spool directory: envelope
   * records (.json) PLUS preserved quarantine bytes (.json.corrupt[.n]) —
   * quarantine occupies real retained capacity and is never evicted to admit
   * new work (R4).
   */
  function retainedBytes(excludePath) {
    let bytes = 0;
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (entry.endsWith(".json")) {
        if (path === excludePath) continue;
        bytes += statSync(path).size;
      } else if (entry.includes(".corrupt")) {
        bytes += statSync(path).size;
      }
    }
    return bytes;
  }

  /**
   * The §9.1 retention boundary. Throws SpoolError with truthful refusal codes
   * on quota exhaustion — never evicts accepted work, never leaves a partial
   * file behind.
   *
   * Bridge-level replay (R4): a record for the same dedup key already in the
   * spool is resolved BEFORE any quota or write.
   *   • SAME digest → idempotent in storage: the already-durable accepted
   *     envelope and its retention receipt are reused VERBATIM — no receipt
   *     appended, no rewrite, no growth. (Previously every duplicate appended
   *     a receipt and rewrote the record before any quota check, so an
   *     ordinary retry loop grew one accepted envelope past maxBytes.)
   *   • DIFFERENT digest → truthful refusal (`intake_conflict`, mirroring the
   *     API's 409 class). The bridge never acknowledges the changed envelope
   *     as retained — the canonical API binding stays the task authority.
   */
  function writerReceive(envelope, { mode }) {
    const existing = list().find((record) => record.dedupKey === envelope.dedupKey);
    if (existing) {
      if (existing.digest !== envelope.digest) {
        throw new SpoolError(
          "intake_conflict",
          `request identity already retained with a different digest (${existing.digest.slice(0, 12)}…) — refusing the conflicting body`,
        );
      }
      return existing;
    }

    const { count, bytes } = stats();
    if (count >= maxEnvelopes) {
      throw new SpoolError(
        "spool_full_count",
        `spool holds ${count} envelopes (limit ${maxEnvelopes})`,
      );
    }

    const state = mode === "deliver" ? "pending" : "retained";
    const record = {
      // Spool-local record id: digest prefix + random suffix, so two envelopes
      // sealed in the same millisecond can never collide on a filename.
      id: `${envelope.sealedAt.replace(/[:.]/g, "-")}-${envelope.digest.slice(0, 12)}-${randomBytes(4).toString("hex")}`,
      createdAt: envelope.sealedAt,
      updatedAt: envelope.sealedAt,
      state,
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
    // The receipt is appended only after the first write is durable (§9.1),
    // but the quota decision must account for the FINAL durable
    // representation — the record with its metadata, state and retention
    // receipt — not the nominal incoming-envelope JSON (R4).
    const retentionReceipt = {
      kind: "retention",
      at: now(),
      state,
      note:
        mode === "deliver"
          ? "retained (delivery queued)"
          : "retained (delivery pending: transport not configured)",
    };
    const finalBytes = recordDurableBytes({ ...record, receipts: [retentionReceipt] });
    if (bytes + finalBytes > maxBytes) {
      throw new SpoolError("spool_full_bytes", `spool would exceed ${maxBytes} bytes`);
    }

    writeFileDurable(envelopePath(record.id), `${JSON.stringify(record, null, 2)}\n`);
    // The receipt is issued only after the parent-directory fsync inside
    // writeFileDurable — the file is durable before this line runs.
    record.receipts.push(retentionReceipt);
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
   * state is delivery-capable (redelivery is idempotent by binding). A record
   * that cannot be parsed never blocks startup and is never silently deleted:
   * its bytes are preserved by renaming the file to `<name>.corrupt` and the
   * scan reports it truthfully (same tolerance as `list()`; independent-review
   * repair — the unguarded parse used to fail the whole deliverer startup).
   *
   * A re-pend that would grow the record past the declared byte bound is
   * refused truthfully (R4): the uncertain on-disk state is preserved AS-IS —
   * an `admitted` envelope stays `admitted`, which is the safe direction (its
   * admission POST is never replayed from this state; the handover watch and
   * operator resume reconcile it idempotently) — no receipt is invented, no
   * bytes are corrupted, and startup is never blocked by a full spool.
   *
   * Deliver-mode promotion (R8 — finding 230ed4d58111): with
   * `{ promoteRetained: true }`, previously accepted retain-only envelopes
   * (`state === "retained"`) are promoted to `pending` through this same
   * durable bounded transition — the documented retain-first bootstrap
   * ("accept while fail-closed, enable delivery after owner review") must
   * deliver the already-accepted work automatically and exactly once, never
   * strand it. The promotion appends one receipt; identity, digest, payload
   * and all original receipts are preserved verbatim. A retain-only scan
   * (the default) NEVER promotes. A promotion the byte bound refuses is
   * reported in `promotionRefused` with the on-disk record preserved AS-IS —
   * never lost, never delivered from the inhibited state (a `retained`
   * record is not a delivery candidate, so the next successful promotion
   * reconciles it).
   */
  function restartScan({ promoteRetained = false } = {}) {
    const discardedTemps = [];
    const rePended = [];
    const corrupted = [];
    const boundRefused = [];
    const promoted = [];
    const promotionRefused = [];
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(TEMP_PREFIX)) {
        unlinkSync(join(dir, entry));
        discardedTemps.push(entry);
        continue;
      }
      if (!entry.endsWith(".json")) continue;
      let record = null;
      try {
        record = JSON.parse(readFileSync(join(dir, entry), "utf8"));
      } catch {
        // Preserve the bytes; surface the corruption; keep starting. The
        // quarantine destination never overwrites earlier forensic bytes: when
        // `<name>.json.corrupt` already exists, a numbered sibling is used
        // (independent-review repair — a plain rename would atomically replace
        // the earlier corrupt file and destroy its evidence).
        let corruptTarget = join(dir, `${entry}.corrupt`);
        let suffix = 0;
        while (existsSync(corruptTarget)) {
          suffix += 1;
          corruptTarget = join(dir, `${entry}.corrupt.${suffix}`);
        }
        renameSync(join(dir, entry), corruptTarget);
        corrupted.push(entry);
        continue;
      }
      if (record.state === "admitted") {
        // An in-flight admission attempt without a recorded terminal response
        // is an uncertain effect → back to pending (idempotent by binding).
        record.state = "pending";
        record.receipts.push({ kind: "restart_repended", at: now() });
        try {
          writeEnvelope(record);
          rePended.push(record.id);
        } catch (error) {
          if (error instanceof SpoolError && error.code === "spool_full_bytes") {
            // Capacity prevents recording the reconciliation — the uncertain
            // `admitted` state stays durable exactly as it was (R4: never
            // corrupt or evict accepted work to record bookkeeping).
            boundRefused.push(record.id);
            continue;
          }
          throw error;
        }
      } else if (promoteRetained && record.state === "retained") {
        // Deliver mode is now configured (R8): re-queue the already-accepted
        // retain-only work through the same durable bounded transition — no
        // resubmission, no operator resume, exactly one promotion receipt.
        record.state = "pending";
        record.deliveryPending = false;
        record.holdReason = null;
        record.receipts.push({
          kind: "promoted_from_retained",
          at: now(),
          note: "deliver mode configured: retained work re-queued for delivery",
        });
        try {
          writeEnvelope(record);
          promoted.push(record.id);
        } catch (error) {
          if (error instanceof SpoolError && error.code === "spool_full_bytes") {
            // Capacity prevents persisting the promotion — the accepted
            // record stays durable exactly as it was (R4: never corrupt or
            // evict accepted work to record bookkeeping), and it is NOT
            // delivered from the inhibited state.
            promotionRefused.push(record.id);
            continue;
          }
          throw error;
        }
      }
    }
    return { discardedTemps, rePended, corrupted, boundRefused, promoted, promotionRefused };
  }

  return { dir, writerReceive, list, get, updateState, restartScan, stats, envelopePath };
}

export { writeFileDurable, fsyncDir, rmSync };
