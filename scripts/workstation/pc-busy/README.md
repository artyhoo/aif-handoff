# PC busy/sleep host signals — amendment material (owner-reviewed)

This directory holds **reviewed amendment material** for the existing
workstation busy/sleep scripts. It documents their actual contract (sanitized)
and the exact, minimal amendments that close the two coverage gaps the PC
wake-on-work P2 slice depends on. **Nothing here is applied by the source
task** — the host scripts are never modified from this repository. Application
is the host-script owner's decision through the exact-candidate review
boundary (plan D1c — **BLOCKED** until applied and qualified).

| File                                | Role                                                                                                                        |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `wsl-report-amendment.example.ps1`  | emit `aif_pending=<n\|?>` from the existing single-writer state report (pinned tasks-only SQL, no intake join)              |
| `sleep-guard-amendment.example.ps1` | matching blocker rule (`aif_pending>0`), unknown → stay awake, optional suspend-time re-read + age-marker immediacy variant |

## Actual host contract (as observed; sanitized)

### `wsl-report.ps1` — the SINGLE writer

- Runs in the owner's interactive session every 2 minutes (WSL cannot be
  started under LOCAL SYSTEM; a 2026-09-09 incident had the guard suspend on
  top of a working agent).
- Writes the state file (`C:\ProgramData\workstation\wsl-state.txt`), ASCII,
  `key=value` lines: `ts=`, `aif_busy=`, `docker_cpu=`, `hub_busy_age=`,
  `hub_stop_age=`. **Single writer** — no second process ever writes it.
- Probes run inside WSL against the API container. Container not running →
  `aif_busy=0`. Else a **readonly** better-sqlite3 query against the canonical
  DB counts tasks `status in (planning, improve, implementing, review, verify)
and paused=0 and locked_by not null and locked_until > now and
last_heartbeat_at > now-15min` — live lock + fresh heartbeat only. Query
  failure → `aif_busy=?`.
- Also reports max per-container CPU% (`docker_cpu`) and the ages of the hub
  marker files (`hub_busy_age` / `hub_stop_age`). Marker files are an existing
  **age-of-file signal reported through the single writer** — the pattern any
  new signal must follow (no second writer, no new marker consumer).

### `sleep-guard.ps1` — the consumer

- Runs as SYSTEM every 5 minutes; suspends to S3 via the existing suspend
  helper when **no blocker** is present.
- Blockers: established non-loopback TCP on the protected local ports (the
  `tunnel-passive.txt` marker (`ip port`) **excludes** the Mac's passive
  tunnel connection from that check — orphan markers are ignored, the port
  must match a live connection); state file missing/stale (>6 min) →
  `wsl:unknown`; `aif_busy` numeric >0 → `aif:N`, non-numeric →
  `aif:unknown`; `docker_cpu` > threshold; hub marker ages within windows;
  system CPU/GPU above thresholds; user idle below the needed minutes; any
  `powercfg /requests` requester.
- **Fail-awake philosophy:** any UNKNOWN input (stale/missing file,
  non-numeric value) keeps the PC awake. All-clear path: log → settle 2 s →
  suspend.

## The coverage gap (plan §8.2) and the owned fix

The writer's `aif_busy` counts only locked+fresh in-stage work. Not covered:

1. **ACK-before-start** — a task admitted (keyed intake or ordinary create)
   sits in `backlog` with no lock until the coordinator picks it up.
2. **Timed obligations** — a task with a future `scheduledAt` has no lock at
   all until due; these arrive from ANY entry path (UI create, reschedule,
   keyed intake).
3. **Unlocked in-stage work** — an autonomous-active task between coordinator
   transitions.

The PC can therefore reach an all-clear while required canonical work exists.

### The fix (binding-agnostic by design — round-2 M4)

Both amendments count **ALL canonical AI-owned obligations from `tasks`
alone — no join on `task_intake_bindings`**. Intake-bound tasks are a subset
of ordinary rows, not a special class; a legacy/UI-scheduled task protects the
PC exactly like an intake-admitted one.

- `aif_pending` (new state-file line, same writer, same readonly query path)
  counts rows that are **not** gated (`execution_owner='ai'`, not `paused`,
  not `blocked_external`, not `manual_review_required`, not terminal
  `done`/`verified`) and are any of:
  - `backlog` (admitted-not-started, any entry path);
  - autonomous-active (`planning`/`improve`/`implementing`/`review`/`verify`)
    **without a live lock** (coordinator owes a transition);
  - `plan_ready` with `auto_mode=1` (awaiting auto-start);
  - any non-terminal, un-gated row with `scheduled_at > now` (timed
    obligation, until fired/cancelled/terminal).
- Semantics preserved exactly: stack not running → `aif_pending=0` (the
  pre-existing "stack down = idle" behavior is unchanged and documented
  honestly — sleeping with the stack down while legacy work waits outside the
  container is today's behavior, not a regression of this slice); query
  failure → `aif_pending=?`; unknown → the guard stays awake.
- The pinned SQL is the byte-faithful mirror of the source predicate
  `getAiWorkloadState()` (`packages/data/src/index.ts`), which is exposed for
  observability on `GET /agent/status` → `workload`. `/agent/status` is
  **observability only** — the host fence consumes the SQL amendment, because
  the writer's auth-free readonly query path is its established channel.

### Exclusion-marker correction (round-3 R3)

Earlier drafts treated `tunnel-passive.txt` as a "passive tunnel active"
marker. It is the opposite: an **exclusion** marker — it removes one specific
matching connection (the Mac's passive tunnel) from the TCP blocker check.
The amendment material below does not touch that logic.

## Residual race and sleep-qualification status (plan §8.3 — honest)

Even with both amendments applied, a task arriving **after** the guard's final
read can still let the PC suspend. The optional suspend-time re-read narrows
that window; it cannot close it (the writer cadence and the 2 s settle remain).

- **Until D1c is applied AND the real awake-signal consumption / final-suspend
  / quiet-work behavior is qualified on the host (D5), automatic sleep with
  admitted-but-unpicked work on the keyed intake path is NOT qualified —
  BLOCKED.** The amendment material defaults fail-awake (`aif_pending`
  missing/unknown → stay awake).
- The relay-side handover watch (see `../intake-relay/README.md`) bounds the
  cost of a mid-handover suspend: bounded wake, redelivery idempotent by
  binding — never loss, never unbounded dormancy.
- Timed wake of a **sleeping** PC at a future `scheduledAt` has no qualified
  source in this slice (plan D7, N/A-BLOCKED). The amendments only keep an
  **awake** PC awake while timed obligations exist.

## Application guide (owner, exact-candidate review)

1. Review the two `.example.ps1` fragments against the live scripts
   (SHA-verified snapshots live in the owner's private provenance tree).
2. Merge the fragments into the live scripts at the marked insertion points —
   they are additive: one new probe + one new state-file line (writer); one
   new blocker rule + optional re-read (guard).
3. Parameterize the placeholders (`<container>`, `<db-path>`, threshold
   values) to the live values; no real host value is committed anywhere.
4. Qualify on the host (D5): observe `aif_pending` while admitting a task
   through the keyed path while the PC would otherwise be idle; confirm the
   guard stays awake and suspends only after the work is picked up. **Only
   that evidence lifts the D1c/D5 sleep-qualification BLOCK.**
