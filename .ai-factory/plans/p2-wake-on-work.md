# PC wake-on-work P2 — authenticated durable intake foundation (revised plan, R1–R5)

- **Branch:** `feature/p2-wake-on-work-5d7f45`
- **Created / revised:** 2026-10-31 / 2026-10-31 (REVISE feedback on plan SHA256 `43610764…433`)
- **Task ID (AIF):** `5d7f458d-6fdb-41fb-a33e-720114a7033b`, project `ec817095-89ec-4959-a4c9-34327326df11` (aif-handoff)
- **Baseline:** `002f93e7036e423c53ed4b2d6f4d43812c866b80` (re-verified this session: HEAD matches, tree clean except this plan; fork origin `artyhoo/aif-handoff`)
- **Authoritative inputs:** execution brief (SHA256 `1615000f…92ae4`), handoff (`bd81ef00…6f17`), P1 owner-review (`e8b66179…dd55`) — all three re-verified against the task private input root this session. Host-signal snapshots (see §6) read and SHA-pinned after the direction owner's verified transfer.

## Settings

- **Testing:** yes — Vitest, ≥70% coverage per touched package; paired negative/positive; crash/replay/handover tests; real SQLite files in tmpdir (no DB mocks for data-layer tests); distinct-connection contention case.
- **Docs:** yes — `docs/api.md`, `docs/architecture.md`, new `docs/workstation-intake.md`, relay README + parameterized deploy/host-hook templates (all sanitized; raw host values only in untracked private evidence).
- **Stage gating:** plan stops at **plan_ready, `autoMode:false`**. Implementation starts only after a bound independent PlanReview returns GO. No implementation from an unreviewed plan or a successful model turn.

## Review reconciliation (R1–R5 → decisions in this plan)

| Finding | Resolution (section) |
|---|---|
| R1 transport/principal fiction | Named candidate transport = PC-initiated reverse forward over the existing bridge SSH boundary; existence of the PC-held forward-only credential is an owner wiring fact → **BLOCKED D1b**; source ships **fail-closed retain-only mode** (no delivery, no wake) until the endpoint is explicitly configured (§5). Bridge principal bound to operator-owned fingerprint map + sshd-provided key identity; project/action/payload scope checked **before retention/wake** (§4). Old ":22 session = sleep protection" claim removed. |
| R2 accepted-attachment loss | Keyed path **rejects non-empty attachments at BOTH ends** before any acceptance/wake/write (API 422 `intake_attachments_unavailable` pre-write; bridge refusal pre-spool). Verified window: `packages/api/src/routes/tasks.ts:442-485` (create → persistAttachments → updateTask; also silently drops attachments when project lookup fails). Legacy no-intake behavior unchanged (§7.3). |
| R3 fictional busy marker | Real snapshots read (SHAs pinned in §6): `wsl-report` is the **single writer** (readonly SQLite count via container exec; `aif_busy=?`/stack-down semantics; 2-min cadence), guard freshness 6 min, fail-awake on unknown/stale, `tunnel-passive.txt` is an **exclusion** marker, all-clear → 2 s → S3. Integration = **owner-reviewed amendments to the existing writer/guard** (BLOCKED D1c) + source-owned canonical pending predicate that closes ACK-before-start and timed-obligation races; no marker-file fiction, no second writer (§8). |
| R4 cached dueAt not ownership | Relay-owned due timers **removed entirely**. Timed wake while asleep = **N/A-BLOCKED with evidence** (no qualified always-on wake source exists). Honest fallback per brief: canonical pending predicate keeps an awake PC awake for admitted timed obligations (fires/cancels derive from the live task row — reschedule/cancel/restart/timezone-safe by construction; overdue catch-up is the coordinator's existing `scheduledAt <= now` pickup, `packages/data/src/index.ts:2630-2647`) (§8.3). |
| R5 unimplementable reconciliation/identity | No read endpoint invented (verified: no `requestId` route/query exists in api/data/shared). The **same keyed POST is both admission and reconciliation** — binding atomicity guarantees it and never restarts a terminal task (tested). 401/403/422 → retained **HOLD**, no retry/wake storms; network/unknown outcome → bounded retry of a **byte-identical** body. One collision-free identity bound: principal₁ ≤64 + client id ≤128, charset `[A-Za-z0-9._-]`, namespaced `pid:cid` ≤**193** enforced identically at bridge (pre-retention) and API (schema regex+max), column comment 193 (§7.4). |
| Precision: spool durability | Receipt only after file fsync **and parent-directory fsync**; restart scan discards receipt-less temps, conservatively re-pending the rest (redelivery is idempotent); bounds refuse new work, never evict accepted work (§9.1). |
| Precision: singleton | OS-managed: systemd unit (deployment) **plus** source-level loopback TCP port bind — second instance exits on `EADDRINUSE`. No PID/timestamp lockfile used as cessation proof (§9.2). |
| Precision: contention | Real-file SQLite test with **two independent better-sqlite3 connections** (worker thread) racing the same dedup key → exactly one `created`; task/binding counts and identities asserted; broadcast spies assert no forbidden wake/write effects (§11.2). |
| Precision: sanitization | This tracked plan is sanitized (no host paths/ports/identifiers); raw reconciliation (snapshot contents, decoded queries, npm-ci child evidence) lives in untracked private evidence, never committed (§3, §12). |
| Precision: npm-ci child `bi2wt2dn3` | Reconciled first, before any write: recorded output ends `added 733 packages in 2m` (success, husky prepare ran); no npm/node process found running now (`ps` unavailable in container — checked via shell builtin listing; observation is limited to this container, not blanket host proof). Completed install reused; no new install needed for this replanning turn. |

## Summary

Source work in this repository plus parameterized deployment material — three slices:

1. **Slice A — keyed canonical admission (G5, brief V3):** optional `intake` block on `POST /tasks` binding API-verified principal + project + namespaced request ID + server-computed immutable digest to exactly one canonical task ID, committed atomically with admission, before acknowledgment. Identical replay returns the original task at any later status (never restarts it); deleted-original replay returns an explicit tombstone; content mismatch is rejected. Legacy clients without `intake` behave exactly as today.
2. **Slice B — bridge relay engine (G4, brief V2+V3):** narrow `scripts/workstation/intake-relay/` — dependency-free Node ESM modules for principal-resolved submit, atomic durable spool with bounded storage and honest refusal, coalesced bounded wake (only when a delivery endpoint is explicitly configured), and classification-correct redelivery. Default mode is **fail-closed retain-only** (§5).
3. **Slice C — awake/busy/due ownership (brief V4):** a canonical workload predicate at the source (`/agent/status` + data query) that counts required pending autonomous work — closing the ACK-before-start and timed-obligation gaps — plus **owner-reviewed amendment material** for the existing host writer/guard (BLOCKED D1c). No relay scheduler, no marker-file fiction.

**This is not:** a bot planner, replacement coordinator, second task store, new identity service, general orchestration/security platform, or any host/production change. No main merge; no new package; no Docker/compose change (relay runs on the bridge; any PC-side mount/forward unit is owner material); no runtime adapter change; no web UI change; no new npm dependencies.

## Environment snapshot (verified this session, before any write)

- Baseline `002f93e7` = reviewed target; clean tree; plan file the only untracked item.
- Prior-session facts re-verified against source: no request-key anywhere (`grep -rn requestId packages/{api,data,shared}/src` → none); `createTask` (`packages/data/src/index.ts:1177`) mints a fresh UUID per call; `createTaskSchema` (`packages/api/src/schemas.ts:151-183`) has no idempotency field; latest migration 28 → new is **v29**; `scheduledAtSchema` normalizes any-offset ISO-8601 to future UTC-Z (`packages/api/src/schemas.ts:49-64`).
- `GET /agent/status` (`packages/api/src/index.ts:50-75`) derives from `listStaleInProgressTasks` (`packages/data/src/index.ts:2650-2668`) which **excludes** actively-locked tasks (stale-detector polarity — stays untouched as a detector; Slice A adds the separate workload predicate rather than repurposing it).
- Post-create broadcasts happen in the route (`tasks.ts:499-506`): `task:created` always, `agent:wake` when `executionOwner==='ai'` — keyed `created` keeps both; pure replay emits **neither**.
- Attachment window confirmed at `tasks.ts:442-485`: task created with `attachments: []`, then `persistAttachments` + `updateTask`; attachments are also silently dropped when the project lookup fails (`if (project)`). Keyed path closes this by rejection (R2); legacy behavior untouched.
- Participant verifier inventory (reuse, unchanged from prior verification): `participant_sessions` (unique `token_digest`, `revoked_at`, `expires_at`), `participantAuth` (cookie or `Authorization: Bearer`), CSRF token + Origin allowlist, `requestActionContext(c)` exposing participants-mode state and actor on routes; `PARTICIPANTS_MODE_ENABLED` default `false`.
- Root `scripts/**.mjs` tested from package tests via URL-import precedent (`packages/shared/src/__tests__/workspaceResolutionGuard.test.ts`) — Slice B follows it.
- Host-signal snapshots (transferred by direction owner, manifest-verified): `sleep-guard.ps1` SHA256 `6bc3caac0cda1adffa005e5484155342bb84f4a1b97ae55bf83ff4b668196967`, `wsl-report.ps1` SHA256 `82bc4b9a810bc319d9cc9df6d1d12d6eb43b7a581ef93fc1519a4dcfc543ed75`. Raw contents/decoded query kept in private evidence; contract summary in §8.

## Verifier / principal path (V2)

Two chained verifiers; neither is a new identity service:

```
authenticated client ──(SSH pubkey, existing bridge boundary)──▶ bridge sshd (forced command)
   principal₁ = sshd-presented key identity → operator-owned fingerprint map (deploy/principals.json)
        │ submit.mjs: resolves principal₁ from the map, stamps it into the envelope;
        │ client-supplied principal fields are ignored/overwritten, never read
        │ checks allowedProjects / payload size / attachments-empty BEFORE retention or wake
        ▼
bridge relay spool (atomic + directory-durable, bounded) ──(coalesced wake, only in deliver mode)──▶ PC AIF API
   POST /tasks {intake:{requestId}, …}  +  Authorization: Bearer <relay service participant session>
        │ participantAuth resolves principal₂ = relay service participant (revocable, expiring)
        ▼
task_intake_bindings row: principal₂ + projectId + namespaced requestId + SERVER-computed digest → one task ID
```

- **principal₁ resolution (R1):** the resolver prefers sshd's `ExposeAuthInfo` identity file (fingerprint of the actually-presented key) checked against an operator-owned, service-user-readable-only `principals.json` (fingerprint → `{principalId, allowedProjects[], maxRequestBytes}`); the per-key `environment=` variant is documented as a fallback with its trust caveat (sshd-set per key, but not derived from the presented key at parse time). An arbitrary inherited environment variable is **never** sufficient by itself. Spoofed client identity (any envelope field claiming a principal) is overwritten.
- **Scope before retention/wake (R1):** envelope `projectId` must be in `allowedProjects`; payload within `maxRequestBytes`; attachments must be absent/empty (R2); request identity within the §7.4 bound. Any violation → refusal receipt, **no spool write, no wake**.
- **principal₂ is always the API-verified session principal.** HOLD semantics: `intake` present but participants mode disabled or session anonymous → **422 `intake_principal_unavailable`** before any DB write or wake broadcast. No fallback principal, no broadened trust. Legacy `POST /tasks` without `intake` keeps working in every mode.
- Missing/revoked/expired credentials therefore cannot enqueue or wake: unauthenticated requests never reach the spool (SSH boundary); unauthenticated/anonymous keyed requests create nothing (401/422 pre-write).

## Transport decision (R1) — named candidate, fail-closed default

- **Fact:** no bridge→PC delivery transport exists today. The PC API is PC-local; the bridge holds no verified PC credential; LAN/tailnet exposure of the API is not a qualified route. The prior plan's implicit "fetch to a PC URL" and its ":22 session counts as busy" corollary are **withdrawn**.
- **Named candidate (owner wiring, existing authority only):** PC-initiated reverse forward over the bridge's existing SSH boundary — a PC-side unit maintains an SSH session to the bridge exposing PC-local API as a **bridge-loopback** endpoint; the relay delivers only to that configured loopback URL. The bridge never holds a PC credential; the API is never exposed beyond loopback on either host. Dependency: a PC-held, forward-only bridge credential — **existence unconfirmed**; confirming or enrolling it (through existing owner routes) is D1b. No trust is granted by this task.
- **Source behavior until then (fail closed):** relay mode `retain-only` (the default; no endpoint configured) — submit still authenticates, scope-checks, and durably retains with an honest receipt `retained (delivery pending: transport not configured)`; the deliverer makes **no network calls and issues no wake**; `--status` reports the hold truthfully. Delivery and wake activate only in `deliver` mode (endpoint + transport explicitly configured).
- Wake ordering in `deliver` mode is internally consistent: the reverse endpoint exists only while the PC is awake, so unreachable-endpoint ⇒ wake (WoL) ⇒ PC start ⇒ forward re-establishes ⇒ delivery proceeds.

## Destination transaction boundary (V3)

### 7.1 Migration v29 (append-only; `packages/shared/src/db.ts` `MIGRATIONS`)

```sql
CREATE TABLE IF NOT EXISTS task_intake_bindings (
  dedup_key TEXT PRIMARY KEY,        -- canonical 'principalKind|principalId|projectId|requestId'
  project_id TEXT NOT NULL,
  principal_kind TEXT NOT NULL,      -- 'participant' | 'internal'
  principal_id TEXT NOT NULL,
  request_id TEXT NOT NULL,          -- namespaced 'pid:cid', ≤ 193 chars, charset [A-Za-z0-9._-] plus one ':'
  payload_digest TEXT NOT NULL,      -- server-computed sha256 hex
  task_id TEXT NOT NULL,             -- NO FK: tombstones must survive task deletion
  source TEXT NOT NULL,              -- server-derived from the verified principal, never client-claimed
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_task_intake_bindings_task ON task_intake_bindings(task_id);
```

Append-only for the supported replay lifetime — bindings and tombstones are the anti-replay memory; no cleanup in this slice ("old envelopes must not become new work").

### 7.2 Atomicity

New data-layer `createTaskWithIntakeBinding` runs **one** better-sqlite3 transaction: (1) select by `dedup_key`; (2a) hit + digest match → `{outcome:"replayed", task}` (task row read live — any status, including terminal: **replay never restarts, re-wakes, or re-admits it**); task row deleted → `{outcome:"replayed", task:null}` tombstone — never re-admit; (2b) hit + digest mismatch → `{outcome:"conflict"}`, zero writes; (3) miss → insert task (the existing `createTask` transaction body refactored into a tx-taking helper — byte-identical behavior for legacy calls) + insert binding + commit → `{outcome:"created"}`. `SQLITE_CONSTRAINT` on the PK (possible from a second connection/process) → catch → re-read → replay/conflict. Cross-connection correctness is proven by test (§11.2), not asserted by JS serialization.

### 7.3 Attachments (R2) and digest

- Keyed path: non-empty `attachments` → **422 `intake_attachments_unavailable` before any write/wake** (API), and refusal before retention/wake (bridge). Empty/absent is fine. The legacy window (`tasks.ts:442-485`) is documented as pre-existing legacy behavior, not broadened; a future slice may stage attachments transactionally.
- Digest: new `packages/shared/src/intakeDigest.ts` — canonical JSON over a fixed field list of the validated create payload, **excluding `intake` and `attachments`**; declared sort-tolerant arrays (`assigneeIds`, `tags`); `scheduledAt` in its schema-normalized UTC-Z form. Pinned vectors shared by API and relay tests via a tracked fixtures file, so bridge-computed and server-computed digests can never drift.

### 7.4 Identity bounds (R5) — one encoding everywhere

- Client request ID: 1–128 chars, `[A-Za-z0-9._-]`.
- principal₁ id (operator map value): 1–64 chars, same charset (validated at relay config load).
- Namespaced request ID: `${principal1}:${clientRequestId}` → 3–193 chars, regex `^[A-Za-z0-9._-]{1,64}:[A-Za-z0-9._-]{1,128}$`, hard max **193** — enforced identically by the bridge envelope validator (pre-retention), the API schema (`intake.requestId` regex + `max(193)`), and the v29 column comment. No other delimiter is legal, so prefix/delimiter ambiguity is impossible by construction.
- Identity and digest are **immutable after retention**: the spooled envelope body is sealed; every retry (including after restart) re-sends the byte-identical body. Therefore no accepted envelope can be retentively un-submittable downstream — the bridge applies the same bound the API enforces.

### 7.5 API mapping and HOLD classes (R5)

`POST /tasks` keyed branch (order matters — all pre-write checks precede `createTask`):

| Condition | Response | Side effects |
|---|---|---|
| participants mode off / anonymous + `intake` | 422 `intake_principal_unavailable` | none (AUTH/CONFIG HOLD) |
| `intake` + non-empty attachments | 422 `intake_attachments_unavailable` | none |
| created | 201 `{task, intake:{replayed:false, requestId, digest}}` | task+binding commit; existing `task:created` + `agent:wake` broadcasts preserved |
| replayed (task exists, any status incl. done) | 200 `{task, intake:{replayed:true}}` | **no broadcasts, no status change, no restart** |
| replayed tombstone (task deleted) | 410 `{code:"intake_tombstone", taskId}` | none |
| digest conflict | 409 `{code:"intake_conflict", taskId}` | none |

- Reconciliation needs **no new endpoint** (verified none exists): the same keyed POST is safe admission reconciliation under commit-before-ACK-loss, restart, and concurrency, because §7.2 makes it idempotent-by-binding.
- Relay response classes: 201/200 → delivered (tombstone + receipt); 409/410 → recorded terminal rejection (reported, not retried); **401/403/422 → retained HOLD** (`hold_auth_config`) — no retry, no wake, cleared only by an operator/config change plus documented resume; network/timeout/5xx → **unknown admission outcome** → bounded exponential backoff retry of the identical body (safe: if it committed, replay returns 200). The relay performs no other external effects, so "arbitrary task external-effect uncertainty" never arises inside it; effect-before-receipt uncertainty inside AIF remains the coordinator's existing idempotency/receipt domain, untouched.
- Audit: `task.created` metadata gains `{intake:{requestId, digest, source}}` (source server-derived); replay appends a `task.intake_replayed` audit event.

## Awake / busy / due-time ownership (V4)

### 8.1 Actual host contract (from verified snapshots; raw text in private evidence)

- **Single writer:** `wsl-report.ps1` runs in the owner's session every 2 min, queries the task store read-only from inside the API container, and writes `wsl-state.txt` (`ts=`, `aif_busy=`, `docker_cpu=`, `hub_busy_age=`, `hub_stop_age=`). Stack not running → `aif_busy=0`; query failure → `aif_busy=?`. `aif_busy` counts tasks `status in (planning, improve, implementing, review, verify) and paused=0 and locked_by not null and locked_until > now and last_heartbeat_at > now-15min` — i.e. **live lock + fresh heartbeat only**.
- **Consumer:** `sleep-guard.ps1` (SYSTEM, 5 min) treats missing/stale (>6 min) state or non-numeric `aif_busy` as **unknown → stay awake** (fail-awake); blocks on TCP sessions on remote ports (with `tunnel-passive.txt` being an **exclusion** marker for one passive tunnel connection — not a keep-awake flag), docker CPU, hub marker ages, CPU/GPU, idle, `powercfg` requests; on all-clear it sleeps 2 s then suspends to S3.
- **Marker precedent:** the hub markers are age-of-file signals reported *through the single writer* — the pattern any new signal must follow. No second writer of `wsl-state.txt` is ever introduced by this task.

### 8.2 The gap and the owned fix

The writer's predicate covers only locked+fresh in-stage work. Not covered: (a) an admitted task in the interval between admission ACK and the coordinator taking a lock (**ACK-before-start**), (b) admitted tasks waiting on their `scheduledAt` timer (**timed obligations** — no lock exists until due), (c) in-stage but currently unlocked tasks between stages. The PC can therefore reach an all-clear while required canonical work exists.

- **Source-owned (this slice, tested):** new data query `getAiWorkloadState()` — one live computation over task rows (no cache), returning `busy` (AI-owned, unpaused, in-stage **including** locked — quiet model waiting is busy) plus `pendingIntake` = count of intake-bound tasks in autonomous-pending states: admitted-not-started (`backlog`), **or** in-stage without a live lock, **or** carrying a future `scheduledAt` (the inhibit fallback). Human-gated waits (`plan_ready` with `autoMode:false`, human review park, `blocked_external`, paused) and terminal states are excluded, mirroring the guard's documented philosophy that human-waiting is not machine work. An old completion cannot clear a newer task's protection — the predicate aggregates over all rows. Exposed on `GET /agent/status` (`busy`, `pendingIntakeCount`, `timedPendingCount`, `earliestScheduledAt`) alongside the existing stale-detector fields, which remain untouched.
- **Owner-reviewed host material (BLOCKED D1c; produced, not applied):** parameterized amendments following the existing patterns exactly — `wsl-report` gains one line emitting `aif_pending=<n|?>` from the same readonly query path (exact pinned SQL over `tasks ⋈ task_intake_bindings`), preserving not-running→0 / failure→`?` semantics; `sleep-guard` gains the matching blocker rule (`aif_pending>0` → blocker; non-numeric → `aif-pending:unknown` → stay awake) and an optional immediate re-read between all-clear and suspend. Optional immediacy variant (age-marker file through the writer, hub-busy pattern) documented for the sub-writer-cadence window. `/agent/status` is observability; the host fence consumes the SQL amendment because the writer's auth-free readonly path is its established channel.

### 8.3 Handover and races

- **ACK-before-worker-start:** closed canonically — the admission commit itself creates the pending row; any post-commit workload read sees it. The relay needs no post-ACK PC-side protection (its old "pending marker" idea is withdrawn); protection is ownership of required pending work in the canonical store.
- **Arrival during final idle-to-suspend:** the guard's residual window is bounded by the writer cadence (2 min) plus its freshness bound (6 min); the amendment's optional re-read narrows the decision-time gap, and no work is ever lost if the race hits — the envelope is already a canonical task row; only start latency is affected, recovered by the coordinator's existing due-pickup on next wake. Documented honestly; not claimed as zero-width from source.
- **Quiet work:** status-based `busy` (in-stage incl. locked), not CPU/heartbeat — a model quietly waiting on a runtime is busy; a paused or human-gated task is not.
- **Reporter failure:** existing fail-awake semantics are preserved by the amendments (unknown/stale/`?` → stay awake); a dead reporter can never suspend the machine by accident.
- **Old completion vs newer work:** aggregate predicate (tested: old done + new pending → still protected).

### 8.4 Due-time ownership (R4)

- The relay keeps **no dueAt cache and no timers**. Timed wake while the PC is asleep has no qualified source today → recorded **N/A-BLOCKED with evidence** (D7).
- Honest fallback (brief-sanctioned): while the PC is awake, admitted timed obligations hold it awake via `pendingIntake` (future `scheduledAt` counts until fired/cancelled/terminal). Reschedule and cancel are re-read live from the task row each cycle — restart reconstruction, timezone normalization (schema-level UTC-Z), overdue catch-up (coordinator's existing `scheduledAt <= now` pickup) and cross-schedule conflicts all reduce to canonical state, not relay memory. The always-awake cost of the fallback is documented for the owner, who may scope it in the amendment config.

## Recovery / rollback ownership

### 9.1 Spool durable-ACK boundary (precision item)

Receipt for `retained` is issued only after: write temp file (unique `O_EXCL` name) → `fsync(file)` → `rename` into place → **`fsync(spool parent directory)`** → state-transition files follow the same protocol. On restart: scan discards receipt-less temp files (no receipt was ever issued for them — the client saw a refusal/timeout, and resubmit is idempotent at the API), and reconciles any ambiguous entry to `pending` (safe direction: redelivery is idempotent by binding). Storage bounds (count+bytes) **refuse new work truthfully** (distinct refusal receipt + exit code; no partial file left behind) and never evict accepted work. ENOSPC-class errors surface as refusal, never as silent loss.

### 9.2 Singleton deliverer (precision item)

The deliverer is single-instance by an OS-held contract: the systemd user unit (deployment material) plus a source-level bind on a configured loopback TCP port — a second instance exits non-zero on `EADDRINUSE`; the kernel releases the port on process death. PID/timestamp lockfiles are not used as cessation proof. The submit path (forced command) may run concurrently — spool writes are per-file atomic and uniquely named.

### 9.3 Rollback invariants

- PC code/config rollback must never restore a pre-image DB over acknowledged work: v29 bindings are append-only and only read/inserted by code, so older code over a newer DB fails closed on the keyed path (bindings unreadable → legacy path unaffected). Runbook states the invariant: reconcile accepted request IDs before any DB restore; one fenced deliverer at all times; bridge spool + tombstones (bridge disk) are named separately from canonical PC storage and survive relay upgrades.
- Deployment templates document preimage hashing (sha256 before/after) and a rollback procedure that preserves spool, tombstones, and bindings.

## File ownership (exact)

**Slice A — keyed admission:**

| # | File | Action |
|---|---|---|
| A1 | `packages/shared/src/db.ts` | edit — append migration v29 (§7.1) |
| A2 | `packages/shared/src/schema.ts` | edit — `taskIntakeBindings` drizzle table + row types |
| A3 | `packages/shared/src/intakeDigest.ts` | new — canonicalization + digest (§7.3) |
| A4 | `packages/shared/src/index.ts` | edit — export A3 |
| A5 | `packages/data/src/taskIntake.ts` | new — `createTaskWithIntakeBinding` (§7.2) |
| A6 | `packages/data/src/index.ts` | edit — re-export A5; add `getAiWorkloadState()` (§8.2); `listStaleInProgressTasks` untouched |
| A7 | `packages/api/src/schemas.ts` | edit — optional `intake:{requestId}` (regex + max 193); client digest/principal fields rejected |
| A8 | `packages/api/src/routes/tasks.ts` | edit — keyed admission branch in POST / (pre-write checks, outcome mapping, broadcasts per §7.5) |
| A9 | `packages/api/src/index.ts` | edit — `/agent/status` workload fields (§8.2) |
| A10 | `packages/shared/src/__tests__/intakeDigest.test.ts` | new — pinned vectors, order/array-sort stability, paired pos/neg |
| A11 | `packages/shared/src/__tests__/schema.test.ts` | edit — v29 table/index assertions |
| A12 | `packages/data/src/__tests__/taskIntake.test.ts` | new — tx atomicity, replay/conflict/tombstone, replay-after-done no-restart, reopen-file durability, **two-connection contention**, workload predicate cases (§11.2, §11.6) |
| A13 | `packages/api/src/__tests__/taskIntakeAdmission.test.ts` | new — route contract: HOLD branches pre-write, attachments rejection, identity bounds, broadcast spies, task/binding count proofs, CSRF/bearer |
| A14 | `packages/api/src/__tests__/agentStatus.test.ts` | edit — workload-field assertions |

**Slice B — relay engine (all new, zero npm deps):**

| # | File | Purpose |
|---|---|---|
| B1 | `scripts/workstation/intake-relay/config.mjs` | validated config: mode (`retain-only` default / `deliver`), endpoint, principal map path, spool bounds, retry/backoff/wake caps, singleton port |
| B2 | `scripts/workstation/intake-relay/envelope.mjs` | validation (identity bounds §7.4, size, attachments-empty), principal stamping (resolver output authoritative), namespacing, digest |
| B3 | `scripts/workstation/intake-relay/spool.mjs` | §9.1 durability protocol, states pending/delivered/rejected/tombstoned/**hold_auth_config**, bounds + honest refusal, restart scan |
| B4 | `scripts/workstation/intake-relay/wake.mjs` | coalescing state machine, bounded repeats/backoff, wake-in-progress ≠ failure; **deliver mode only** |
| B5 | `scripts/workstation/intake-relay/deliverer.mjs` | FIFO loop, §7.5 response classification, bounded backoff of identical bodies, loopback-port singleton, graceful drain |
| B6 | `scripts/workstation/intake-relay/submit.mjs` | CLI: principal resolution → scope checks pre-retention → durable spool → receipt/refusal exit codes; no wake |
| B7 | `scripts/workstation/intake-relay/relay.mjs` | service entry + `--status` (per-envelope state incl. hold reasons) + hold-resume command |
| B8 | `scripts/workstation/intake-relay/README.md` | parameter contract, §5 transport decision + fail-closed, deploy/rollback w/ preimage hashing, HOLD/resume runbook, security notes |
| B9 | `scripts/workstation/intake-relay/deploy/aif-intake-relay.service.example` | systemd user unit (singleton, restart) |
| B10 | `scripts/workstation/intake-relay/deploy/config.example.env` | placeholders only |
| B11 | `scripts/workstation/intake-relay/deploy/ssh-forced-command.example` | authorized_keys forced command + ExposeAuthInfo/per-key-env notes |
| B12 | `scripts/workstation/intake-relay/deploy/principals.example.json` | fingerprint → principalId/allowedProjects/maxRequestBytes |
| B13 | `scripts/workstation/intake-relay/deploy/pc-reverse-forward.example.service` | PC-side unit template (owner material; D1b dependency) |
| B14 | `scripts/workstation/intake-relay/test-vectors/digest-vectors.json` | shared pinned digest vectors (consumed by A10 and B15) |
| B15 | `packages/shared/src/__tests__/workstationIntakeRelay.test.ts` | new — URL-import tests B1–B7 against a stub admission server (`node:http`): §11.3–§11.5 |

**Slice C — host-signal integration material (owner-reviewed, BLOCKED D1c):**

| # | File | Purpose |
|---|---|---|
| C1 | `scripts/workstation/pc-busy/README.md` | actual contract (§8.1, sanitized), amendment guide, residual-race honesty, exclusion-marker correction |
| C2 | `scripts/workstation/pc-busy/wsl-report-amendment.example.ps1` | parameterized `aif_pending` emission via the existing readonly query path (pinned SQL), preserving 0/`?` semantics |
| C3 | `scripts/workstation/pc-busy/sleep-guard-amendment.example.ps1` | parameterized blocker rule + optional suspend-time re-read; optional age-marker immediacy variant |

**Docs:** `docs/api.md` (intake field/codes, `/agent/status` fields), `docs/architecture.md` (wake/intake subsection), `docs/workstation-intake.md` (new sanitized operator runbook: submit, status, HOLD/resume, recovery, rollback).

**Untracked private evidence:** `.ai-factory/evidence/p2-wake-on-work.private.md` — raw host reconciliation (snapshot text, decoded queries, paths/ports), never committed. No other files are modified. Packages' `CHECKLIST.md` items run at completion; husky/lint-staged hooks run as configured.

## Discriminating checks (tests:true)

Deterministic, owned, paired negative/positive, run on the PC in this container:

1. **Authenticated intake:** keyed create with participant session → 201 + binding row; participants mode disabled → 422 `intake_principal_unavailable`, task count unchanged, binding count unchanged, no `agent:wake` broadcast (spy); forged principal header/field never becomes binding principal; revoked session → 401 pre-write.
2. **Atomic durable replay:** identical resubmit and simulated commit-before-ACK-loss (client discards first response) → 200 same task ID; task count stays 1, binding count stays 1; **replay after the task reached `done` → 200, status unchanged, no broadcasts (never restarts a terminal task)**; relay restarted between spool and delivery → envelope survives, delivered once.
3. **Contention (precision item):** real tmpdir SQLite file, **two independent better-sqlite3 connections** (worker thread importing the data layer) racing the same dedup key → exactly one `created`, other side `replayed`, one task row, one binding row.
4. **Conflict/tombstone/attachments:** same requestId different title → 409, no new task, no wake; task deleted after accept → 410, never re-admitted; keyed create with non-empty attachments → 422 pre-write at API **and** refusal pre-spool at bridge; legacy attachment flow unchanged (golden test).
5. **Identity bounds (R5):** boundary charset/length matrix at both ends — 128-char client id + 64-char principal accepted (193); 129/65 rejected; `:`/`|`/unicode in client id rejected at bridge and API; namespaced id byte-identical across retries (stub server captures bodies → deep-equal).
6. **Workload predicate races (R3):** admitted-not-started → `pendingIntake ≥ 1` immediately post-commit (ACK-before-start); future `scheduledAt` → counted until terminal (timed inhibit); reschedule-later/cancel → live re-read reflects new row; in-stage locked **and** in-stage unlocked → `busy:true` (quiet work); paused / human-gated (`plan_ready` autoMode:false / blocked_external) → not protective; old done + new pending → still protected; two consecutive reads with an admission in between → second read protected (no caching).
7. **Relay honesty:** §9.1 receipt-after-dir-fsync ordering (instrumented); restart scan discards temps / re-pends ambiguous; count+byte bounds → truthful refusal exit, no partial file, accepted work never evicted; wake coalescing (N concurrent submits → 1 window, bounded repeats); **retain-only mode: zero network calls, zero wake** (asserted); singleton: second deliverer exits on `EADDRINUSE`; response-classification matrix incl. 401/403/422 → HOLD with no retry and no wake on subsequent cycles.
8. **Digest stability:** pinned shared vectors (B14); field-order/whitespace variants → same digest; one-character change → different digest; API and relay computations agree.

**Mandatory validation protocol:** `npm run ai:validate` on the PC against this isolated checkout; every aggregate component (`format:check`, `lint`, `test`, coverage ≥70% touched packages, `build`, `ai:perf`, `ai:load`, `ai:protocol`, `ai:checklist`) recorded as executed/failed/skipped/N-A with fresh output. Known trap: `ai:load` exits 0 when k6 is missing — recorded as its true state (UNVERIFIED/skipped-k6-missing), never PASS. No component removed or weakened; no heavy Mac test battery.

## Deployment dependencies & BLOCKED register (carried into REPORT)

| ID | Item | Owner | Status |
|---|---|---|---|
| D1a | PC `PARTICIPANTS_MODE_ENABLED` + relay service participant (existing bootstrap flow, role `member`) + session-token transport to bridge | direction owner (existing routes only) | **BLOCKED** — keyed path HOLDs by design meanwhile |
| D1b | PC-initiated reverse-forward unit + PC-held forward-only bridge credential (§5); confirm existing or enroll via existing routes | direction owner | **BLOCKED** — relay stays fail-closed `retain-only`; no wake, no delivery |
| D1c | `wsl-report`/`sleep-guard` amendments (C2/C3) applied to the host scripts | host-script owner via exact-candidate review | **BLOCKED** — material produced, not applied; source predicate + tests land now |
| D2 | Bridge Node ≥20 for the relay (or owner's chosen always-on host) | direction owner | deployment dependency, named |
| D3 | Internet entry (G2) | operator | BLOCKED, unchanged |
| D4 | Egress policy (G3) | operator | BLOCKED for provider/pilot cases; irrelevant to this no-model slice |
| D5 | Real sleep→wake, LAN, Mac-absent, cold-boot acceptance cases | executor after D1* via exact-candidate deployment review | runtime evidence stays fixtures-only; not claimable from source |
| D6 | getff PR2141 / A1 task `16732164-…` | retained A1 owner | untouched, preserved |
| D7 | Qualified always-on wake-at-due source for a sleeping PC | — | **N/A-BLOCKED with evidence** (§8.4); inhibit-while-awake fallback implemented canonically |

## Stage gating & stop condition

1. This revised plan lands as a commit on `feature/p2-wake-on-work-5d7f45` (plan only — sanitized; private evidence stays untracked).
2. Task returns to **plan_ready, `autoMode:false`**; independent bound PlanReview re-runs against brief V2/V3/V4, the kickoff verify list, and R1–R5.
3. On GO: implementation proceeds phase-wise A → B → C with the commit plan below; on REVISE: plan amended and re-reviewed. Implementation never starts from an unreviewed plan or a successful model turn.
4. Whole-feature DONE is **not** claimable by this slice: D1*/D5/D7 remain BLOCKED/UNVERIFIED; the REPORT returns PARTIAL/DONE-per-slice honestly.

## Commit plan

| Checkpoint | Contents | Message |
|---|---|---|
| 0 | this revised plan (sanitized) | `docs(plans): revise p2 wake-on-work plan — R1-R5 reconciliation (plan_ready, autoMode:false)` |
| 1 | A1–A6, A10–A12, B14 | `feat(shared,data): keyed task intake bindings (migration v29) with atomic replay/conflict/tombstone + workload predicate` |
| 2 | A7–A9, A13–A14 | `feat(api): authenticated keyed admission on POST /tasks + agent workload status` |
| 3 | B1–B13, B15 | `feat(workstation): fail-closed bridge intake relay (durable spool, classified redelivery, singleton)` |
| 4 | C1–C3 + docs | `docs(workstation): host-signal amendment material, intake runbook, api/architecture sync` |

## Out of scope / preserved (falsifiers)

- A1/getff B/OpenMaus/Hy-Memory untouched; PR2141 review HOLD unchanged; no second A1 executor.
- Configured role profiles (task `088182b8…`, plan/review `53eca24c…`) unchanged; no provider/bot verification traffic; no API-billed LLM in CI.
- No public exposure of API/MCP/admin ports; no Docker socket mount; no copied keys; no authorized_keys edits (template examples are documentation, not applied config); no force-push/reset/clean/stash/chown; no production image rebuild/restart; no VPN/power/partition change; no main merge; private host values never committed.
- Host scripts (`wsl-report`/`sleep-guard`) are never modified by this task — only reviewed amendment material is produced (D1c).
- If an already-enrolled wake/intake/busy path is discovered during implementation and verifies, it is reconciled and reused instead of the parallel pieces here (Slice B/C shrink; Slice A remains the destination contract).
