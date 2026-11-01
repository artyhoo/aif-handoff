# AIF intake relay (bridge) — authenticated durable task intake

Bridge-side engine for the PC wake-on-work P2 slice (plan `p2-wake-on-work`).
Dependency-free Node ESM (≥ Node 20, D2). It preserves incoming work while the
PC sleeps and lets replay resolve to one canonical task/owner — it is NOT a
planner, coordinator, second task store, or identity service. The canonical
task authority is the PC AIF API; the destination transaction boundary is the
`task_intake_bindings` binding committed atomically with admission (Slice A).

## Files

| File                               | Role                                                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.mjs`                       | validated configuration; fail-closed invariants (mode, mandatory writer credential)                                                                                       |
| `envelope.mjs`                     | envelope validation, authoritative principal stamping, identity bounds (§7.4), dependency-free frozen-digest mirror (§7.3)                                                |
| `spool.mjs`                        | durable spool owned by the single writer: quota → temp → fsync → rename → dir-fsync → receipt (§9.1), restart scan, bounded honest refusal                                |
| `wake.mjs`                         | coalescing, bounded wake engine (deliver mode only)                                                                                                                       |
| `deliverer.mjs`                    | the SINGLE WRITER process: singleton UDS latch (fail-closed), authenticated writer IPC, compat probe, operator fence, FIFO delivery + §7.5 classification, handover watch |
| `submit.mjs`                       | trusted shim under the sshd forced command: principal resolution → scope checks → authenticated hand-off to the writer                                                    |
| `relay.mjs`                        | service entry + `--status` + `fence`/`unfence` + writer-IPC hold-resume                                                                                                   |
| `deploy/`                          | parameterized example material (unit, env, SSH notes, principals, reverse forward, rollback guard)                                                                        |
| `test-vectors/digest-vectors.json` | pinned digest vectors shared with the API test suite                                                                                                                      |

## Verifier / principal path (§5, R1)

```
submit client ──(SSH pubkey, existing bridge boundary)──▶ bridge sshd (forced command)
   principal₁ = fingerprint of the key sshd presented (ExposeAuthInfo)
                → operator-owned principals.json
        │ submit.mjs: stamps the resolved principal; client-claimed principal
        │ fields are overwritten, never read; checks allowedProjects /
        │ maxRequestBytes / attachments-empty BEFORE retention or wake
        ▼  authenticated writer IPC ONLY (0600 socket in a 0750 dir + mandatory credential)
single writer (deliverer) — revalidates every envelope invariant, then:
   quota → temp → fsync → rename → dir-fsync → receipt (§9.1)
   ──(deliver mode: compat- AND operator-fenced)──▶ PC AIF API (reverse-forward loopback URL)
        POST /tasks {intake:{requestId}} + session cookie + CSRF token
        ▼
task_intake_bindings: API-verified principal₂ + project + namespaced request ID
        + SERVER-computed frozen digest → one task ID
```

`principal₁` (SSH identity, bridge-side) and `principal₂` (API-verified
participant session, PC-side) are different verifiers by design; the namespaced
request ID is `${principal1}:${clientRequestId}` and the binding's principal is
whatever the API session resolves — never a client-claimed value.

## Fail-closed default and transport decision (§5)

Default mode is **`retain-only`**: submit still authenticates (SSH boundary AND
writer-IPC authentication — both apply in every mode), scope-checks, and durably
retains with the honest receipt `retained (delivery pending: transport not
configured)`. The deliverer makes **zero network calls** and issues **zero
wake** in this mode.

Delivery/wake activate only in `deliver` mode: the PC-initiated reverse forward
(`deploy/pc-reverse-forward.example.service`, D1b) exposes PC-local API as a
bridge-loopback URL. Unreachable endpoint ⇒ wake ⇒ PC start ⇒ forward
re-establishes ⇒ delivery proceeds. No LAN/tailnet exposure of the API exists
in this design; this task grants no trust and enrolls no credential.

## The authenticated writer IPC (§9.2, R3/S1, R4/C1)

- The writer is reachable **only** through the Unix domain socket: file `0600`
  inside a service-user-owned `0750` directory — kernel-enforced reachability.
  The deliverer opens **no TCP listener at all**.
- **Every** request must present the per-instance writer credential
  (high-entropy, owner-installed `0600` file outside the repository; path is a
  required config field). Comparison is timing-safe. There is **no**
  configuration in which the writer accepts an unauthenticated request — no
  optional-token mode, no insecure flag, retain-only included.
- The writer re-validates every envelope invariant (principal in its own copy
  of the operator map, identity bounds, size vs the principal bound, project
  scope, attachments-empty, frozen-digest re-computation) **before** any quota
  reservation.
- Missing/invalid credential or unreachable socket ⇒ truthful refusal
  (`writer_unauthenticated` / `retention_unavailable`), zero quota, zero write,
  zero wake.
- **Singleton (fail-closed):** the UDS bind is the latch. A bind that fails for
  ANY reason — live listener or stale file alike — refuses startup: exit `78`,
  state `startup_refused_socket_held`, spool untouched. The deliverer **never
  unlinks and never reclaims** its socket path; the connect probe only
  classifies the refusal message (a refused connect proves nothing about the
  owning process — R4/C1). Stale-path cleanup belongs to the supervisor
  (systemd `ExecStartPre`, which runs only after the unit's previous instance
  is reaped) or to a manual owner step after verified cessation.

## Spool durability (§9.1, M5)

All spool mutations happen inside the single writer process. The retention
boundary per envelope: quota reservation (count+bytes) → temp file (`O_EXCL`)
→ `fsync(file)` → `rename` → `fsync(parent dir)` → **receipt**. Concurrent
submitters are serialized by the writer; there is no check-then-write race.
Restart scan discards receipt-less temps and re-pends ambiguous entries to
`pending` (redelivery is idempotent by binding). Bounds refuse new work
truthfully (`spool_full_count` / `spool_full_bytes`) and never evict accepted
work; `ENOSPC`-class failures surface as refusal, never silent loss.

## Envelope states

```
pending ──(deliver: 201/200)──▶ admitted ──(pickup evidence)──▶ completed
   │              └─(future scheduledAt)──▶ completed (at admission; no watch)
   ├─(409)──▶ rejected          (terminal, reported, not retried)
   ├─(410)──▶ tombstoned        (original deleted; never re-admitted)
   ├─(401/403/422/400/404)──▶ hold_auth_config   (operator hold — no retry, no wake)
   ├─(probe missing/mismatch)──▶ hold_api_compat  (auto-resumes when probe passes)
   ├─(fence present)──────────▶ hold_operator_fence (auto-resumes after unfence)
   ├─(poll/retry budget out)──▶ hold_handover_unconfirmed (operator hold)
   └─(retain-only receipt)──▶ retained (delivery pending: transport not configured)
```

`network / timeout / 5xx / 429` ⇒ bounded exponential backoff retry of the
byte-identical body (safe: a commit resolves as replay, §7.2).

## Handover contract (§8.3, M1)

Delivery is NOT complete at the API ACK. An admitted immediately-eligible
envelope is watched by authenticated `GET /tasks/:id` polling (no WebSocket
dependency) until pickup evidence: the task left `backlog`, carries a live
lock, or reached a terminal status. A future `scheduledAt` completes the
envelope at admission (the relay owns no timers — R4/D7). If the endpoint
drops mid-handover, the bounded wake loop fires and polling resumes after the
forward re-establishes. Bounds exhausted ⇒ `hold_handover_unconfirmed` —
truthful, never an infinite wake storm. **Until D1b/D1c land and are
qualified, automatic sleep with admitted-but-unpicked work on this path is
BLOCKED**; the produced host material defaults fail-awake.

## Operating

```sh
node relay.mjs                     # run the service (singleton writer + delivery loop)
node relay.mjs --status            # read-only: fence, spool stats, per-envelope states
node relay.mjs fence --reason "api swap window"   # durable fence; delivery parks
node relay.mjs unfence             # remove the fence (compat probe still applies)
node relay.mjs resume --id <id>    # operator hold-resume (via the writer IPC)
node relay.mjs resume --all        # resume every operator-held envelope
```

`hold_auth_config` and `hold_handover_unconfirmed` resume ONLY by operator
action; `hold_api_compat` and `hold_operator_fence` resume automatically when
their condition clears.

## Deployment (reviewed, separate boundary)

1. Install Node ≥ 20 (D2), the unit (`deploy/aif-intake-relay.service.example`),
   and `config.env` from `deploy/config.example.env` — placeholders only.
2. Install secrets through existing owner routes (this repository ships none):
   writer credential, principals map, and — deliver mode — session token +
   session-bound CSRF token. `0600`, service-user readable, outside the repo.
3. Configure the SSH forced command (`deploy/ssh-forced-command.example`) and
   the PC reverse forward (D1b) before enabling `deliver` mode.
4. Bridge spool + tombstones live on bridge disk, named separately from the
   canonical D-backed PC storage; they survive relay upgrades.

## Rollback / swap ordering (§9.3, M3, R3/S2, R4/C2)

The compat probe (`GET /agent/status` → `intakeCompat`) is a runtime mismatch
detector only — **never** a fence and never a transactional API-version lock.
Before ANY incompatible API swap:

1. **Fence + stop:** `relay.mjs fence --reason …` AND stop the unit — both,
   never either.
2. **Verify cessation (supervisor-asserted):** the supervisor must answer a
   dead state (`inactive`/`failed`). `active`/`activating`/`deactivating`/
   unknown/query-failure ⇒ do not proceed. Socket/status replies are
   corroboration only — a fenced status reply proves the process is ALIVE.
3. **Drain / reconcile:** every envelope must sit in a recorded state; in-flight
   (admitted-unconfirmed) and `hold_handover_unconfirmed` envelopes are
   uncertain effects — carried as HOLD, never retried into the target, never
   discarded.
4. **Guard:** `node deploy/rollback-guard.example.mjs …` re-verifies ALL of:
   fence present; supervisor-dead unit; zero in-flight/uncertain envelopes;
   API artifact sha256 preimage match. Any live relay REFUSEs — fenced
   included. Swap only on `PERMIT`.
5. Swap the API; then start the relay and unfence. The byte-identical keyed
   POST is idempotent by binding — a pre-swap commit resolves as replay, never
   a duplicate.

## Security notes

- No credential, principal, host value, or raw machine inventory is committed;
  everything operational is a parameterized placeholder or an owner-installed
  file outside the repository.
- The writer credential, session token, and CSRF token are per-instance,
  `0600`, service-user readable; generation/installation is owner work via
  existing routes (this task creates no secret and no new trust).
- SSH public-key boundary + forced command + ExposeAuthInfo fingerprint →
  operator map is the intake verifier; a websocket URL or caller-supplied
  principal/header is never sufficient.
- Refusal classes are truthful and distinct: `principal_unknown`,
  `project_not_allowed`, `payload_too_large`, `attachments_unavailable`,
  `request_id_invalid`, `writer_unauthenticated`, `retention_unavailable`,
  `spool_full_count`, `spool_full_bytes`, `startup_refused_socket_held`.
