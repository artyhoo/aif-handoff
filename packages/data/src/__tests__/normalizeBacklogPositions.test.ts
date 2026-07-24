import { describe, it, expect, beforeEach, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
import { projects, tasks } from "@aif/shared";
import { createTestDb } from "@aif/shared/server";

const testDb = { current: createTestDb() };

vi.mock("@aif/shared/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared/server")>();
  return {
    ...actual,
    getDb: () => testDb.current,
  };
});

const {
  normalizeBacklogPositions,
  parseNormalizeBacklogPositionsArgs,
  planBacklogPositionNormalization,
  runNormalizeBacklogPositionsCli,
} = await import("../normalizeBacklogPositions.js");

function seedProject(id: string) {
  testDb.current
    .insert(projects)
    .values({ id, name: id, rootPath: `/tmp/${id}` })
    .run();
}

function seedTask(input: Partial<typeof tasks.$inferInsert> & { id: string; projectId: string; title: string }) {
  testDb.current
    .insert(tasks)
    .values({
      status: "backlog",
      position: 100,
      createdAt: "2026-06-23T00:00:00.000Z",
      ...input,
    })
    .run();
}

function listProjectTasks(projectId: string) {
  return testDb.current
    .select({
      id: tasks.id,
      status: tasks.status,
      position: tasks.position,
      createdAt: tasks.createdAt,
    })
    .from(tasks)
    .where(eq(tasks.projectId, projectId))
    .orderBy(asc(tasks.createdAt), asc(tasks.id))
    .all()
    .map((task) => ({
      ...task,
      position: Number(task.position),
    }));
}

describe("normalizeBacklogPositions", () => {
  beforeEach(() => {
    testDb.current = createTestDb();
    seedProject("proj-1");
    seedProject("proj-2");
  });

  it("parses CLI arguments for dry-run, apply, and project scoping", () => {
    expect(parseNormalizeBacklogPositionsArgs(["--project", "proj-1"])).toEqual({
      apply: false,
      help: false,
      projectId: "proj-1",
    });

    expect(parseNormalizeBacklogPositionsArgs(["--apply", "--project", "proj-2"])).toEqual({
      apply: true,
      help: false,
      projectId: "proj-2",
    });

    expect(() => parseNormalizeBacklogPositionsArgs(["--project"])).toThrow(
      "Missing value for --project",
    );
    expect(() => parseNormalizeBacklogPositionsArgs(["--unknown"])).toThrow(
      "Unknown argument: --unknown",
    );
  });

  it("plans per-project normalization using createdAt then id order", () => {
    seedTask({
      id: "proj-1-late",
      projectId: "proj-1",
      title: "Late",
      position: 100,
      createdAt: "2026-06-23T00:00:02.000Z",
    });
    seedTask({
      id: "proj-1-early",
      projectId: "proj-1",
      title: "Early",
      position: 400,
      createdAt: "2026-06-23T00:00:01.000Z",
    });
    seedTask({
      id: "proj-2-b",
      projectId: "proj-2",
      title: "Project 2 B",
      position: 900,
      createdAt: "2026-06-23T00:00:03.000Z",
    });
    seedTask({
      id: "proj-2-a",
      projectId: "proj-2",
      title: "Project 2 A",
      position: 700,
      createdAt: "2026-06-23T00:00:03.000Z",
    });

    const plan = planBacklogPositionNormalization();

    expect(plan.projectCount).toBe(2);
    expect(plan.taskCount).toBe(4);
    expect(plan.changedTaskCount).toBe(4);
    expect(plan.projects).toEqual([
      {
        projectId: "proj-1",
        taskCount: 2,
        changedTaskCount: 2,
        tasks: [
          {
            id: "proj-1-early",
            projectId: "proj-1",
            title: "Early",
            createdAt: "2026-06-23T00:00:01.000Z",
            currentPosition: 400,
            normalizedPosition: 100,
            changed: true,
          },
          {
            id: "proj-1-late",
            projectId: "proj-1",
            title: "Late",
            createdAt: "2026-06-23T00:00:02.000Z",
            currentPosition: 100,
            normalizedPosition: 200,
            changed: true,
          },
        ],
      },
      {
        projectId: "proj-2",
        taskCount: 2,
        changedTaskCount: 2,
        tasks: [
          {
            id: "proj-2-a",
            projectId: "proj-2",
            title: "Project 2 A",
            createdAt: "2026-06-23T00:00:03.000Z",
            currentPosition: 700,
            normalizedPosition: 100,
            changed: true,
          },
          {
            id: "proj-2-b",
            projectId: "proj-2",
            title: "Project 2 B",
            createdAt: "2026-06-23T00:00:03.000Z",
            currentPosition: 900,
            normalizedPosition: 200,
            changed: true,
          },
        ],
      },
    ]);
  });

  it("keeps dry-run mode non-destructive", () => {
    seedTask({
      id: "dry-run-b",
      projectId: "proj-1",
      title: "Second",
      position: 800,
      createdAt: "2026-06-23T00:00:02.000Z",
    });
    seedTask({
      id: "dry-run-a",
      projectId: "proj-1",
      title: "First",
      position: 500,
      createdAt: "2026-06-23T00:00:01.000Z",
    });

    const result = normalizeBacklogPositions({ projectId: "proj-1" });

    expect(result.applied).toBe(false);
    expect(result.updatedTaskCount).toBe(0);
    expect(listProjectTasks("proj-1").map((task) => ({ id: task.id, position: task.position }))).toEqual([
      { id: "dry-run-a", position: 500 },
      { id: "dry-run-b", position: 800 },
    ]);
  });

  it("treats apply as a no-op when positions already match the normalized order", () => {
    seedTask({
      id: "already-first",
      projectId: "proj-1",
      title: "First",
      position: 100,
      createdAt: "2026-06-23T00:00:01.000Z",
    });
    seedTask({
      id: "already-second",
      projectId: "proj-1",
      title: "Second",
      position: 200,
      createdAt: "2026-06-23T00:00:02.000Z",
    });

    const result = normalizeBacklogPositions({ projectId: "proj-1", apply: true });

    expect(result.applied).toBe(false);
    expect(result.updatedTaskCount).toBe(0);
  });

  it("applies scoped normalization only to backlog tasks in the selected project", () => {
    seedTask({
      id: "apply-second",
      projectId: "proj-1",
      title: "Second",
      position: 500,
      createdAt: "2026-06-23T00:00:02.000Z",
    });
    seedTask({
      id: "apply-first",
      projectId: "proj-1",
      title: "First",
      position: 900,
      createdAt: "2026-06-23T00:00:01.000Z",
    });
    seedTask({
      id: "planning-task",
      projectId: "proj-1",
      title: "Planning",
      status: "planning",
      position: 777,
      createdAt: "2026-06-23T00:00:03.000Z",
    });
    seedTask({
      id: "other-project",
      projectId: "proj-2",
      title: "Other project",
      position: 950,
      createdAt: "2026-06-23T00:00:01.000Z",
    });

    const result = normalizeBacklogPositions({ projectId: "proj-1", apply: true });

    expect(result.applied).toBe(true);
    expect(result.updatedTaskCount).toBe(2);
    expect(listProjectTasks("proj-1")).toEqual([
      {
        id: "apply-first",
        status: "backlog",
        position: 100,
        createdAt: "2026-06-23T00:00:01.000Z",
      },
      {
        id: "apply-second",
        status: "backlog",
        position: 200,
        createdAt: "2026-06-23T00:00:02.000Z",
      },
      {
        id: "planning-task",
        status: "planning",
        position: 777,
        createdAt: "2026-06-23T00:00:03.000Z",
      },
    ]);
    expect(listProjectTasks("proj-2")).toEqual([
      {
        id: "other-project",
        status: "backlog",
        position: 950,
        createdAt: "2026-06-23T00:00:01.000Z",
      },
    ]);
  });

  it("does not update a task that leaves backlog after the normalization plan is read", () => {
    seedTask({
      id: "stale-task",
      projectId: "proj-1",
      title: "Leaves backlog",
      position: 900,
      createdAt: "2026-06-23T00:00:01.000Z",
    });
    seedTask({
      id: "remaining-backlog-task",
      projectId: "proj-1",
      title: "Still backlog",
      position: 500,
      createdAt: "2026-06-23T00:00:02.000Z",
    });

    const originalTransaction = testDb.current.transaction.bind(testDb.current);
    const transactionSpy = vi
      .spyOn(testDb.current, "transaction")
      .mockImplementation(((callback) => {
        testDb.current
          .update(tasks)
          .set({ status: "planning" })
          .where(eq(tasks.id, "stale-task"))
          .run();

        return originalTransaction(callback);
      }) as typeof testDb.current.transaction);

    const result = normalizeBacklogPositions({ projectId: "proj-1", apply: true });

    transactionSpy.mockRestore();

    expect(result.applied).toBe(true);
    expect(result.changedTaskCount).toBe(2);
    expect(result.updatedTaskCount).toBe(1);
    expect(listProjectTasks("proj-1")).toEqual([
      {
        id: "stale-task",
        status: "planning",
        position: 900,
        createdAt: "2026-06-23T00:00:01.000Z",
      },
      {
        id: "remaining-backlog-task",
        status: "backlog",
        position: 200,
        createdAt: "2026-06-23T00:00:02.000Z",
      },
    ]);
  });

  it("prints CLI help and supports project-scoped dry-run previews", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    expect(await runNormalizeBacklogPositionsCli(["--help"])).toBe(0);
    expect(writeSpy).toHaveBeenCalled();

    seedTask({
      id: "cli-preview",
      projectId: "proj-1",
      title: "Preview",
      position: 700,
      createdAt: "2026-06-23T00:00:01.000Z",
    });

    expect(await runNormalizeBacklogPositionsCli(["--project", "proj-1"])).toBe(0);
    expect(await runNormalizeBacklogPositionsCli(["--project", "missing-project"])).toBe(0);

    writeSpy.mockRestore();
  });

  it("returns a non-zero exit code for invalid CLI arguments", async () => {
    expect(await runNormalizeBacklogPositionsCli(["--unknown"])).toBe(1);
  });
});
