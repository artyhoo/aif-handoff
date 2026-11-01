# sleep-guard.ps1 amendment — aif_pending blocker + optional suspend-time re-read
# (plan p2-wake-on-work, C3)
#
# EXAMPLE REVIEW MATERIAL — NOT APPLIED BY THE SOURCE TASK. The host-script
# owner merges this fragment into the live sleep-guard.ps1 through the
# exact-candidate review boundary (D1c). Strictly ADDITIVE: one new blocker
# rule parsed from the SAME state file the guard already reads, plus an
# OPTIONAL final re-read between all-clear and suspend. The guard remains a
# pure CONSUMER — it never writes the state file (single-writer preserved).
#
# Fail-awake philosophy preserved:
#   * aif_pending numeric > 0  -> blocker 'aif-pending:N'   (stay awake)
#   * aif_pending non-numeric (incl. '?') while the state file is FRESH
#                              -> blocker 'aif-pending:unknown' (stay awake)
#   * state file stale/missing -> existing 'wsl:unknown' blocker (unchanged)

# ---------------------------------------------------------------------------
# 1. BLOCKER RULE — add next to the existing aif_busy rule, inside the same
#    block that parses the fresh state file into key=value pairs ($state):
# ---------------------------------------------------------------------------

<#
  # aif_pending: canonical AI-owned outstanding work (admitted-not-started,
  # unlocked in-stage, plan_ready auto, future-scheduled) — tasks-only SQL in
  # the writer (see wsl-report-amendment.example.ps1). Any entry path counts.
  if ($state.ContainsKey('aif_pending')) {
      $aifPendingRaw = $state['aif_pending']
      $aifPending = 0
      if (-not [int]::TryParse($aifPendingRaw, [ref]$aifPending)) {
          $blockers.Add('aif-pending:unknown')        # '?' or garbage -> awake
      }
      elseif ($aifPending -gt 0) {
          $blockers.Add("aif-pending:$aifPending")    # owed work -> awake
      }
  }
  # Missing key: an OLD writer that does not yet emit the line. Fail-awake is
  # the safe direction, but silently blocking forever on a pre-amendment
  # writer would defeat the stack-down=idle semantics — so treat a missing
  # key the same as unknown ONLY when the owner enables the strict flag below;
  # default: ignore (pre-amendment writer keeps today's behavior).
#>

# Owner switch (default off): $strictAifPending = $true  -> a missing
# aif_pending line on a FRESH state file is 'aif-pending:unknown' (fail-awake);
# default off keeps the pre-amendment behavior of the live guard unchanged.

# ---------------------------------------------------------------------------
# 2. OPTIONAL SUSPEND-TIME RE-READ (narrows, never closes, the final race —
#    plan §8.3). Insert immediately BEFORE the suspend invocation, i.e.
#    between the existing 'all clear' log line and the suspend helper call:
# ---------------------------------------------------------------------------

<#
  # Re-read the writer's state file one last time; if it changed since this
  # cycle's read (newer write = a fresh evaluation happened while we decided),
  # re-evaluate the aif rules once and abort the suspend on any new blocker.
  $statePath = 'C:\ProgramData\workstation\wsl-state.txt'   # existing path
  $readAt     = (Get-Item $statePath).LastWriteTimeUtc       # captured at the
                                                              # cycle's read
  Start-Sleep -Seconds 2                                     # existing settle
  $re = Get-Item $statePath -ErrorAction SilentlyContinue
  if ($null -ne $re -and $re.LastWriteTimeUtc -gt $readAt) {
      $state2 = Read-AifStateFile $statePath                 # existing parser
      $p2 = 0
      if ($state2.ContainsKey('aif_pending') -and
          -not [int]::TryParse($state2['aif_pending'], [ref]$p2)) {
          $blockers.Add('aif-pending:unknown')               # fail awake
      }
      elseif ($p2 -gt 0) {
          $blockers.Add("aif-pending:$p2")
      }
      if ($blockers.Count -gt 0) {
          # Writer saw new work between our reads — skip this suspend; the
          # next cycle re-evaluates with fresh data.
          return   # or the live script's existing skip/continue construct
      }
  }
#>

# ---------------------------------------------------------------------------
# 3. OPTIONAL AGE-MARKER IMMEDIACY VARIANT — stricter alternative to (2) for
#    owners who prefer a pure mtime rule without re-parsing content:
# ---------------------------------------------------------------------------

<#
  # Refuse to suspend while the writer's state file is younger than one writer
  # cadence (2 min): a very recent write means an evaluation may have landed
  # after this guard cycle started reading. Combined with the writer's 2-min
  # cadence this bounds the undetected-arrival window to ~one cadence.
  $cadenceSec = 120
  $ageSec = ((Get-Date).ToUniversalTime() - (Get-Item $statePath).LastWriteTimeUtc).TotalSeconds
  if ($ageSec -lt $cadenceSec) {
      $blockers.Add('aif-pending:fresh-write')   # conservative: settle first
  }
#>
# NOTE: enable (2) OR (3), not both — (3) subsumes (2)'s window at the cost
# of delaying suspension by up to one writer cadence after genuine all-clear.

# ---------------------------------------------------------------------------
# Reviewer notes (plan §8.3 — honest residual):
#   * Neither variant removes the irreducible window: work admitted AFTER the
#     final read can still be suspended upon. The relay-side handover watch
#     (bridge) bounds that cost — bounded wake + idempotent redelivery — it
#     does not prevent the suspend.
#   * This rule only keeps an AWAKE PC awake while canonical work exists.
#     Waking a SLEEPING PC at a future scheduledAt is a separate unqualified
#     capability (plan D7, N/A-BLOCKED) — no timer is added here.
#   * tunnel-passive.txt remains an EXCLUSION marker for the Mac's passive
#     tunnel connection; this amendment does not touch that logic.
# ---------------------------------------------------------------------------
