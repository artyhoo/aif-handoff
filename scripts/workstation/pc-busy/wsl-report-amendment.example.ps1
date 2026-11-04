# wsl-report.ps1 amendment — emit `aif_pending=<n|?>` (plan p2-wake-on-work, C2)
#
# EXAMPLE REVIEW MATERIAL — NOT APPLIED BY THE SOURCE TASK. The host-script
# owner merges this fragment into the live wsl-report.ps1 through the
# exact-candidate review boundary (D1c). It is strictly ADDITIVE: one new
# readonly probe + one new state-file line, following the existing writer
# patterns exactly (same container, same readonly DB access, same failure
# semantics, same single-writer file).
#
# Contract preserved:
#   * stack not running  -> aif_pending=0   (existing stack-down semantics)
#   * probe/query failure-> aif_pending=?   (fail-awake upstream)
#   * exactly one writer of the state file (this script) — no second writer
#   * binding-agnostic: the SQL reads `tasks` ONLY — no join on
#     `task_intake_bindings` (round-2 M4). Legacy/UI-created scheduled tasks
#     protect the PC exactly like intake-admitted ones.
#
# The SQL below is the pinned byte-faithful mirror of the source predicate
# `getAiWorkloadState()` (packages/data/src/index.ts), which is also exposed
# read-only on GET /agent/status -> `workload` (observability only; the guard
# consumes THIS file line, not the HTTP endpoint).

# ---------------------------------------------------------------------------
# 1. PINNED SQL — merge as a sibling constant of the existing aif_busy query.
#    Placeholders are bound at runtime to the same ISO-8601 UTC 'now' string
#    the existing query already computes (two binds of one value).
# ---------------------------------------------------------------------------

$aifPendingSql = @"
SELECT COUNT(*) AS n FROM tasks
WHERE execution_owner = 'ai'
  AND paused = 0
  AND status <> 'blocked_external'
  AND manual_review_required = 0
  AND NOT (status = 'plan_ready' AND auto_mode = 0)
  AND status NOT IN ('done', 'verified')
  AND (
        status = 'backlog'
        OR (status IN ('planning','improve','implementing','review','verify')
            AND (locked_by IS NULL OR locked_until IS NULL OR locked_until <= ?))
        OR (status = 'plan_ready' AND auto_mode = 1)
        OR (scheduled_at IS NOT NULL AND scheduled_at > ?)
      )
"@

# ---------------------------------------------------------------------------
# 2. PROBE — clone the EXISTING aif_busy readonly probe path verbatim
#    (same wsl.exe -d <distro> base64-wrapped bash, same
#    `docker exec -w /app <container> node … /data/aif.sqlite` readonly
#    access, same not-running and failure handling) and swap only the SQL
#    text and bind list:
#
#      $aifPending = Invoke-AifReadonlyQuery -Sql $aifPendingSql -Binds @($nowUtc, $nowUtc)
#
#    where Invoke-AifReadonlyQuery stands for whatever guarded helper the
#    live script already uses for aif_busy, with this exact behavior:
#
#      function Invoke-AifReadonlyQuery {
#        param([string] $Sql, [object[]] $Binds)
#        # container not running  -> return 0            (stack-down = idle)
#        # docker/node/SQL failure-> return $null        (caller emits '?')
#        # success                -> return [int] n      (first row, column n)
#      }
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# 3. EMIT — append one line to the state content the script already writes
#    (single writer; same ASCII key=value format, same write path):
#
#      $aifPendingLine = if ($null -eq $aifPending) { "aif_pending=?" }
#                        else                        { "aif_pending=$aifPending" }
#      # add $aifPendingLine to the existing key=value content array BEFORE the
#      # existing single write of the state file, next to the aif_busy line.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Semantics notes for the reviewer (plan §8.2, §8.3):
#   * 'aif_pending' counts rows the coordinator still owes work on OR that
#     carry a future scheduled_at: backlog (admitted-not-started, any entry
#     path), autonomous-active WITHOUT a live lock (quiet transition gap),
#     plan_ready with auto_mode=1 (awaiting auto-start), and any un-gated
#     non-terminal row with scheduled_at > now (timed obligation).
#   * Deliberately NOT counted (human/external gates, mirroring the guard's
#     philosophy): paused=1, blocked_external, manual_review_required=1,
#     plan_ready with auto_mode=0, terminal done/verified, execution_owner<>'ai'.
#   * A row can satisfy more than one branch; COUNT(*) counts ROWS once.
#   * Timestamps are ISO-8601 UTC text compared lexicographically — the same
#     convention the existing aif_busy query already relies on.
#   * This line is a SUPERSET signal for the guard: >0 means "do not sleep";
#     it never means "wake a sleeping PC" (no wake-at-due source exists — D7).
# ---------------------------------------------------------------------------
