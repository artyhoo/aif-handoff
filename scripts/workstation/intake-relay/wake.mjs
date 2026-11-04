// Coalescing wake engine (plan §5 wake ordering, §8.3 M1 recovery, D7 bounds).
//
// Deliver mode only — retain-only never constructs one (asserted in tests).
// Driven by OUTSTANDING WORK (pending ∨ admitted-unconfirmed), never by a
// dueAt cache: the relay owns no timers for scheduled work (R4/D7).
//
// Semantics:
//   • a wake window is open for `windowMs` after a trigger — further triggers
//     inside the window coalesce into nothing (N submits → 1 wake);
//   • a wake-in-progress is not a failure outcome; failures are bounded by
//     `maxRepeats` with `backoffMs` between attempts, then the episode ceases
//     (no infinite wake storm — §8.3 bounds exhausted → truthful HOLD);
//   • `reset()` is called by the deliverer on delivery/handover evidence that
//     the PC is awake, so a new episode starts fresh.

import { execFile } from "node:child_process";

export function createWakeEngine({
  command,
  args = [],
  maxRepeats,
  backoffMs,
  windowMs,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  exec = execFile,
  log = () => {},
}) {
  if (!command) {
    throw new Error("wake engine requires a configured command");
  }
  let windowOpenUntil = 0;
  let repeatsUsed = 0;
  let nextRepeatAllowedAt = 0;
  let inFlight = false;
  let lastOutcome = null;

  function outstandingAllowed() {
    return repeatsUsed < maxRepeats;
  }

  async function trigger(reason) {
    const t = now();
    if (t < windowOpenUntil) {
      lastOutcome = { coalesced: true, reason, at: new Date(t).toISOString() };
      log({ coalesced: true, reason }, "wake coalesced inside open window");
      return { fired: false, coalesced: true };
    }
    if (inFlight) {
      return { fired: false, coalesced: true };
    }
    if (t < nextRepeatAllowedAt) {
      lastOutcome = { backoff: true, reason, at: new Date(t).toISOString() };
      return { fired: false, backoff: true };
    }
    if (!outstandingAllowed()) {
      lastOutcome = { exhausted: true, reason, at: new Date(t).toISOString() };
      log({ repeatsUsed, maxRepeats, reason }, "wake repeats exhausted — episode ceases");
      return { fired: false, exhausted: true };
    }

    inFlight = true;
    windowOpenUntil = t + windowMs;
    repeatsUsed += 1;
    nextRepeatAllowedAt = t + backoffMs;
    try {
      await new Promise((resolve, reject) => {
        exec(command, args, { timeout: 30_000 }, (error) => (error ? reject(error) : resolve()));
      });
      lastOutcome = { fired: true, reason, at: new Date(t).toISOString(), repeat: repeatsUsed };
      log({ reason, repeat: repeatsUsed }, "wake fired");
      return { fired: true, repeat: repeatsUsed };
    } catch (error) {
      lastOutcome = { fired: false, failed: true, reason, error: String(error?.message ?? error) };
      log({ reason, error: String(error?.message ?? error) }, "wake command failed");
      return { fired: false, failed: true };
    } finally {
      inFlight = false;
    }
  }

  function reset() {
    repeatsUsed = 0;
    nextRepeatAllowedAt = 0;
    windowOpenUntil = 0;
  }

  function status() {
    return {
      repeatsUsed,
      maxRepeats,
      exhausted: !outstandingAllowed(),
      lastOutcome,
    };
  }

  return { trigger, reset, status, sleep };
}
