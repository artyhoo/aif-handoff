# Workstation Intake (PC wake-on-work) — operator runbook

Bridge-side intake for canonical PC-owned AIF work: incoming task requests are
authenticated, durably retained on the always-on bridge while the PC sleeps,
delivered to the PC AIF API exactly once (idempotent by binding), and watched
until the PC actually picks the work up.

This is a transport/admission integration. It is **not** a planner,
coordinator, second task store, or identity service — the canonical task
authority stays the PC AIF API, and the destination transaction boundary is
the `task_intake_bindings` row committed atomically with task admission
(migration v29).

- Source modules: [`scripts/workstation/intake-relay/`](../scripts/workstation/intake-relay/) (dependency-free Node ≥ 20 ESM)
- Engine details and envelope-state diagram: [`scripts/workstation/intake-relay/README.md`](../scripts/workstation/intake-relay/README.md)
- Host busy/sleep amendment material: [`scripts/workstation/pc-busy/`](../scripts/workstation/pc-busy/README.md)

> **Deployment status:** the engine ships fail-closed. Default mode is
> `retain-only` (no endpoint, no delivery, no wake). Enabling delivery
> requires owner-installed credentials and wiring (participant session,
> reverse forward, host amendments) that this repository does not ship or
> enroll. Until those are applied and reviewed, the relay only retains.

## Identity chain (who is allowed to submit)

```
submit client ──(SSH public key, existing bridge boundary)──▶ bridge sshd (forced command)
   principal₁ = fingerprint of the key sshd presented (ExposeAuthInfo)
                → operator-owned principals.json (fingerprint → id, allowed projects, size bound)
        │ submit.mjs stamps the RESOLVED principal; client-claimed principal
        │ fields are overwritten, never read; scope checked BEFORE retention
        ▼  authenticated writer IPC (0600 UDS in a 0750 dir + mandatory credential)
single writer (deliverer) revalidates every envelope invariant, then durably retains
   ──(deliver mode only)──▶ PC AIF API  POST /tasks {intake:{requestId}}
        ▼ API verifies the relay's participant session (principal₂) and CSRF
task_intake_bindings: principal₂ + project + namespaced request ID + server-computed
frozen digest → exactly one task ID
```

Two independent verifiers guard the path: the SSH boundary + writer credential
on the bridge (nothing unauthenticated reaches the spool), and the API
session/CSRF on the PC (nothing unauthenticated reaches admission). A missing,
revoked, or forged credential at either layer produces a truthful refusal and
zero side effects — nothing is enqueued, nothing wakes.

## Submitting work (bridge)

Payload on stdin, JSON receipt/refusal on stdout. The submitting key can only
run the shim (sshd forced command):

```sh
ssh -T <relay-user>@<bridge> < payload.json
```

Payload fields are the ordinary `POST /tasks` create fields **plus**
`clientRequestId` (1–128 chars of `[A-Za-z0-9._-]`, the caller's idempotency
key). `projectId` must be in the submitting principal's allowed set;
attachments must be absent/empty (keyed intake rejects them by design).

Receipts are distinct and truthful:

| Exit                       | Meaning                                                                                                                                      |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `0` + `retention` receipt  | durably retained (deliver mode: queued; retain-only: `delivery pending: transport not configured`)                                           |
| `0` + `retention_replayed` | same dedup key already in the spool — no second record, no quota consumed                                                                    |
| `2` + code                 | refused by the writer (`spool_full_count`, `spool_full_bytes`, envelope invariant, `writer_unauthenticated`)                                 |
| `3` + code                 | refused before the writer (`principal_unknown`, `project_not_allowed`, `payload_too_large`, `attachments_unavailable`, `request_id_invalid`) |
| `4`                        | `retention_unavailable` — writer down/unreachable; retry later (the supervisor restarts it)                                                  |

## Deduplication and replay

The canonical replay key is
`principalKind|principalId|projectId|<principal1>:<clientRequestId>`, bound to
one task ID together with a server-computed digest of the client content,
inside the admission transaction. Consequences:

- **Identical resubmit** — same body, any time, even after restart or after
  the first response was lost — returns the **original task** (`200`), never a
  duplicate, never a restart. Terminal tasks are not re-run.
- **Changed content** under the same request ID → `409 intake_conflict`,
  rejected without new work or wake.
- **Deleted original** → `410 intake_tombstone`; the request is never
  re-admitted.
- `scheduledAt` is included in the digest (normalized to UTC-Z): rescheduling
  under the same request ID is a conflict, not a silent re-schedule.
- Keyed first delivery may carry a **past** `scheduledAt` (delayed delivery is
  admitted and caught up by the existing scheduler); the legacy no-intake path
  still rejects past timestamps with `400`.

See [api.md](api.md#create-task) for the `intake` request field and response
codes.

## Operating the relay (bridge)

```sh
node relay.mjs                     # run the singleton writer + delivery loop
node relay.mjs --status            # read-only: fence, spool stats, per-envelope states
node relay.mjs fence --reason "…"  # durable operator fence — delivery parks (hold_operator_fence)
node relay.mjs unfence             # remove the fence (compat probe still applies)
node relay.mjs resume --id <id>    # operator hold-resume (via the authenticated writer IPC)
node relay.mjs resume --all
```

Envelope lifecycle and HOLD semantics:

- `pending → admitted` on a `201/200` admission receipt; **`completed` only on
  pickup evidence** (authenticated `GET /tasks/:id` polling shows the task
  left `backlog`, holds a live lock, or reached a terminal status). Delivery
  is not considered complete at the API ACK.
- A future `scheduledAt` completes the envelope at admission (the relay owns
  no timers). Keeping an awake PC awake until a due time is the host guard's
  job (`aif_pending`); **waking a sleeping PC at a due time is not provided by
  this slice** (no qualified wake-at-due source).
- Endpoint unreachable mid-handover ⇒ bounded wake ⇒ forward re-establishes ⇒
  polling resumes. Bounds exhausted ⇒ `hold_handover_unconfirmed` (truthful,
  no infinite wake storm).
- `hold_auth_config` (401/403/422/400/404 at admission) and
  `hold_handover_unconfirmed` resume **only** by operator action;
  `hold_api_compat` and `hold_operator_fence` resume automatically when their
  condition clears.
- Network/timeout/5xx ⇒ bounded exponential backoff retry of the byte-identical
  body — safe because a committed admission replays.

## Recovery

- The spool is crash-safe: the retention receipt is issued only after the
  envelope file **and its parent directory** are fsynced. A restart discards
  receipt-less temp files and re-pends ambiguous entries (redelivery is
  idempotent by binding). An unparseable record never blocks startup and is
  never deleted: it is quarantined as `<name>.json.corrupt` (or
  `<name>.json.corrupt.<n>` when that destination already exists — earlier
  forensic bytes are never overwritten) and reported by the restart scan.
- Storage bounds (count + bytes) refuse new work truthfully; accepted work is
  never evicted.
- **Singleton is fail-closed:** the Unix socket bind is the latch. If the path
  exists — live listener or stale file — startup refuses (exit 78,
  `startup_refused_socket_held`). The relay never unlinks its own socket path.
  After a crash, clear a stale path **only** after verifying cessation (unit
  inactive, no relay process); the systemd unit's `ExecStartPre` cleanup runs
  only after the previous instance is reaped, which is the qualified restart
  path.
- Bridge spool + bindings live on bridge disk, separately from the canonical
  D-backed PC storage. Bindings are append-only and are the anti-replay memory
  for the supported replay lifetime.

## First-deployment preconditions

- **Frozen-digest canonicalization is deployment-fresh.** The digest
  canonicalization changed before any deployment: absent optional fields now
  fill the eleven static schema defaults instead of the earlier null sentinel.
  No environment had live intake state under the older canonicalization
  (deployment is still gated behind the exact-candidate review), so nothing
  needed migrating — and **no upgrade proof or replay compatibility across the
  canonicalization change is claimed or provided**.
- **Precondition for any first deployment:** the target database must hold no
  pre-existing `task_intake_bindings` rows and the bridge spool no
  pre-existing envelopes that were written under a different canonicalization.
  A binding or sealed envelope computed under the old canonicalization would
  turn byte-identical replays into `intake_conflict` (409) responses after the
  change. If such state is ever found, stop and reconcile with the direction
  owner — do not re-seal, re-bind, or "upgrade" it in place.

## Rollback / API swap (bridge)

The compat probe (`GET /agent/status` → `intakeCompat`) is a runtime mismatch
detector only — **never** a fence, never a transactional version lock. Before
any incompatible API swap:

1. **Fence + stop** — `relay.mjs fence --reason …` **and** stop the unit. Both,
   never either.
2. **Verify cessation** with the supervisor (`systemctl is-active` must answer
   `inactive`/`failed`). `active`/`activating`/`deactivating`/unknown ⇒ do not
   proceed. A fenced `--status` reply proves the process is **alive**, not
   stopped.
3. **Drain / reconcile** — every envelope must sit in a recorded state;
   admitted-unconfirmed and `hold_handover_unconfirmed` envelopes are uncertain
   effects: carry them as HOLD, never retry them into the swapped target.
4. **Guard** — `node deploy/rollback-guard.example.mjs …` conjunctively
   re-verifies fence present ∧ supervisor-dead ∧ zero in-flight/uncertain ∧
   artifact sha256 preimage match; prints `PERMIT`/`REFUSE`. Swap only on
   `PERMIT`.
5. After the swap: start the relay, unfence. A pre-swap committed admission
   resolves as replay — never a duplicate.

## Security notes

- No secret, host value, principal, or machine inventory is committed in this
  repository; every operational value is a parameterized placeholder or an
  owner-installed `0600` file outside the repo.
- The writer accepts **no unauthenticated request in any mode** (retain-only
  included); there is no optional-token or insecure configuration.
- The API is never exposed beyond loopback on either host; delivery targets a
  bridge-loopback reverse forward that the PC itself establishes (the bridge
  never holds a PC credential).
