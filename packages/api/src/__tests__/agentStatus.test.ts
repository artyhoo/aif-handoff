import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { INTAKE_COMPAT_LEVEL, projects, tasks } from "@aif/shared";
import { createTestDb } from "@aif/shared/server";

const testDb = { current: createTestDb() };

vi.mock("@aif/shared/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared/server")>();
  return {
    ...actual,
    getDb: () => testDb.current,
  };
});

const { listStaleInProgressTasks, getAiWorkloadState } = await import("@aif/data");

function createApp() {
  const startTime = Date.now();
  const app = new Hono();

  app.get("/agent/status", (c) => {
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
        heartbeatStale: lagMs > 5 * 60 * 1000,
        updatedAt: t.updatedAt,
      };
    });

    // Mirrors packages/api/src/index.ts — the canonical workload snapshot and
    // the keyed-intake compat level the bridge relay probes (§8.2/§9.3).
    const workload = getAiWorkloadState();

    return c.json({
      uptime: Math.floor((Date.now() - startTime) / 1000),
      activeTasks,
      activeTaskCount: activeTasks.length,
      staleTasks: activeTasks.filter((t) => t.heartbeatStale).length,
      workload,
      intakeCompat: INTAKE_COMPAT_LEVEL,
      checkedAt: new Date().toISOString(),
    });
  });

  return app;
}

describe("GET /agent/status", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    testDb.current = createTestDb();
    testDb.current.insert(projects).values({ id: "p1", name: "Test", rootPath: "/tmp/test" }).run();
    app = createApp();
  });

  it("returns empty activeTasks when no tasks are in progress", async () => {
    const res = await app.request("/agent/status");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.activeTasks).toEqual([]);
    expect(body.activeTaskCount).toBe(0);
    expect(body.staleTasks).toBe(0);
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });

  it("returns active tasks with heartbeat info", async () => {
    const now = new Date().toISOString();
    testDb.current
      .insert(tasks)
      .values({
        id: "t1",
        projectId: "p1",
        title: "Active Task",
        description: "desc",
        status: "implementing",
        lastHeartbeatAt: now,
        updatedAt: now,
      })
      .run();

    const res = await app.request("/agent/status");
    const body = await res.json();

    expect(body.activeTaskCount).toBe(1);
    expect(body.activeTasks[0].id).toBe("t1");
    expect(body.activeTasks[0].heartbeatStale).toBe(false);
    expect(body.activeTasks[0].heartbeatLagMs).toBeLessThan(5000);
  });

  it("marks tasks as stale when heartbeat is old", async () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    testDb.current
      .insert(tasks)
      .values({
        id: "t2",
        projectId: "p1",
        title: "Stale Task",
        description: "desc",
        status: "planning",
        lastHeartbeatAt: tenMinAgo,
        updatedAt: tenMinAgo,
      })
      .run();

    const res = await app.request("/agent/status");
    const body = await res.json();

    expect(body.activeTasks[0].heartbeatStale).toBe(true);
    expect(body.staleTasks).toBe(1);
  });

  it("reports the binding-agnostic workload snapshot and the keyed-intake compat level", async () => {
    // Admitted-not-started backlog row (no intake binding required — the
    // predicate is binding-agnostic) plus a future-scheduled obligation.
    testDb.current
      .insert(tasks)
      .values({ id: "t3", projectId: "p1", title: "Admitted", executionOwner: "ai" })
      .run();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    testDb.current
      .insert(tasks)
      .values({
        id: "t4",
        projectId: "p1",
        title: "Timed",
        executionOwner: "ai",
        scheduledAt: future,
      })
      .run();

    const res = await app.request("/agent/status");
    const body = await res.json();

    expect(body.intakeCompat).toBe(INTAKE_COMPAT_LEVEL);
    expect(body.workload).toEqual({
      busy: 0,
      pendingCount: 2,
      timedPendingCount: 1,
      earliestScheduledAt: future,
    });
    // Legacy stale-detector fields remain untouched by the workload addition.
    expect(body.activeTaskCount).toBe(0);
  });
});
