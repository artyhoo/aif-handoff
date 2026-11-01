import { Hono } from "hono";
import { INTAKE_COMPAT_LEVEL } from "@aif/shared";
import { getAiWorkloadState, listStaleInProgressTasks } from "@aif/data";
import type { ParticipantApiEnv } from "../middleware/participantAuth.js";

const startTime = Date.now();

/**
 * GET /agent/status — mounted by the API entry at `/agent` (index.ts) behind
 * the same global middleware chain as every other route, so under
 * PARTICIPANTS_MODE_ENABLED the request requires a resolved participant
 * session. The bridge relay's compat probe presents its service session here
 * (deliverer.mjs probeCompat); extracted into a router so tests compose the
 * REAL handler with the REAL auth middleware instead of a mirrored copy.
 */
export const agentStatusRouter = new Hono<ParticipantApiEnv>();

agentStatusRouter.get("/status", (c) => {
  const now = Date.now();
  const activeTasks = listStaleInProgressTasks().map((t) => {
    const heartbeatAt = t.lastHeartbeatAt ? new Date(t.lastHeartbeatAt).getTime() : null;
    const updatedAt = t.updatedAt ? new Date(t.updatedAt).getTime() : now;
    const lagMs = heartbeatAt ? now - heartbeatAt : now - updatedAt;

    return {
      id: t.id,
      title: t.title,
      status: t.status,
      lastHeartbeatAt: t.lastHeartbeatAt,
      heartbeatLagMs: lagMs,
      heartbeatStale: lagMs > 5 * 60 * 1000, // > 5 min without heartbeat
      updatedAt: t.updatedAt,
    };
  });

  // Canonical AI-workload snapshot (plan §8.2): admitted-not-started, in-stage
  // (locked or not — quiet model waiting is busy), and timed obligations from
  // ANY entry path. Binding-agnostic; the host sleep-guard consumes the pinned
  // SQL amendment of the same predicate. Existing stale-detector fields above
  // are unchanged.
  const workload = getAiWorkloadState();

  return c.json({
    uptime: Math.floor((Date.now() - startTime) / 1000),
    activeTasks,
    activeTaskCount: activeTasks.length,
    staleTasks: activeTasks.filter((t) => t.heartbeatStale).length,
    workload,
    // Keyed-intake contract level (§9.3): the bridge relay probes this before
    // any keyed delivery; a mismatch parks delivery as `hold_api_compat`.
    intakeCompat: INTAKE_COMPAT_LEVEL,
    checkedAt: new Date().toISOString(),
  });
});
