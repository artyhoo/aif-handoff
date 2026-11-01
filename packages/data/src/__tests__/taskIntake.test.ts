import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import Database from "better-sqlite3";
import { closeDb, getDb } from "@aif/shared/server";
import {
  participants,
  projects,
  taskAssignments,
  taskIntakeBindings,
  tasks,
  type NewTaskRow,
} from "@aif/shared";

const { createTaskWithIntakeBinding, getAiWorkloadState, createTask, updateTask } =
  await import("../index.js");
const { isSqliteUniqueConstraintError } = await import("../taskIntake.js");

type Db = ReturnType<typeof getDb>;

const PROJECT_ID = "proj-intake";
const DEDUP_KEY = "participant|relay-svc|proj-intake|relay-svc:nightly-1";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

function bindingInput(digest: string, dedupKey = DEDUP_KEY) {
  return {
    dedupKey,
    projectId: PROJECT_ID,
    principalKind: "participant" as const,
    principalId: "relay-svc",
    requestId: dedupKey.split("|")[3],
    payloadDigest: digest,
    source: "relay",
  };
}

function creationInput(overrides: Record<string, unknown> = {}) {
  return {
    projectId: PROJECT_ID,
    title: "Nightly intake task",
    description: "Delivered by the bridge relay",
    ...overrides,
  };
}

function countTasks(db: Db): number {
  return db.select().from(tasks).all().length;
}

function countBindings(db: Db): number {
  return db.select().from(taskIntakeBindings).all().length;
}

describe("createTaskWithIntakeBinding (keyed admission, §7.2)", () => {
  let workDir: string;
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    closeDb();
    workDir = mkdtempSync(join(tmpdir(), "aif-task-intake-"));
    dbPath = join(workDir, "intake.sqlite");
    db = getDb(dbPath);
    db.insert(projects)
      .values({ id: PROJECT_ID, name: "Intake", rootPath: join(workDir, "root") })
      .run();
  });

  afterEach(() => {
    closeDb();
    rmSync(workDir, { recursive: true, force: true });
  });

  it("admits a keyed payload atomically: one task row, one binding row, intake audit metadata", () => {
    const result = createTaskWithIntakeBinding(creationInput(), bindingInput(DIGEST_A));
    expect(result?.outcome).toBe("created");
    if (result?.outcome !== "created") throw new Error("expected created");

    expect(result.task.status).toBe("backlog");
    expect(result.task.projectId).toBe(PROJECT_ID);
    expect(countTasks(db)).toBe(1);
    expect(countBindings(db)).toBe(1);

    const binding = db.select().from(taskIntakeBindings).all()[0];
    expect(binding.dedupKey).toBe(DEDUP_KEY);
    expect(binding.payloadDigest).toBe(DIGEST_A);
    expect(binding.taskId).toBe(result.task.id);
    expect(binding.principalKind).toBe("participant");
    expect(binding.principalId).toBe("relay-svc");
    expect(binding.requestId).toBe("relay-svc:nightly-1");
    expect(binding.source).toBe("relay");
    expect(binding.createdAt).toBeTruthy();
  });

  it("replays an identical resubmit to the original task (commit-before-ACK loss)", () => {
    const first = createTaskWithIntakeBinding(creationInput(), bindingInput(DIGEST_A));
    const second = createTaskWithIntakeBinding(creationInput(), bindingInput(DIGEST_A));

    expect(first?.outcome).toBe("created");
    expect(second?.outcome).toBe("replayed");
    if (second?.outcome !== "replayed") throw new Error("expected replayed");
    if (first?.outcome !== "created") throw new Error("expected created");
    expect(second.task?.id).toBe(first.task.id);
    expect(second.binding.taskId).toBe(first.task.id);
    expect(countTasks(db)).toBe(1);
    expect(countBindings(db)).toBe(1);
  });

  it("replays a terminal task without restarting it", () => {
    const first = createTaskWithIntakeBinding(creationInput(), bindingInput(DIGEST_A));
    if (first?.outcome !== "created") throw new Error("expected created");
    db.update(tasks).set({ status: "done" }).where(eq(tasks.id, first.task.id)).run();

    const replay = createTaskWithIntakeBinding(creationInput(), bindingInput(DIGEST_A));
    expect(replay?.outcome).toBe("replayed");
    if (replay?.outcome !== "replayed") throw new Error("expected replayed");
    expect(replay.task?.status).toBe("done");
    expect(countTasks(db)).toBe(1);
    expect(countBindings(db)).toBe(1);
  });

  it("returns a tombstone for a deleted original instead of re-admitting", () => {
    const first = createTaskWithIntakeBinding(creationInput(), bindingInput(DIGEST_A));
    if (first?.outcome !== "created") throw new Error("expected created");
    db.delete(tasks).where(eq(tasks.id, first.task.id)).run();

    const replay = createTaskWithIntakeBinding(creationInput(), bindingInput(DIGEST_A));
    expect(replay?.outcome).toBe("replayed");
    if (replay?.outcome !== "replayed") throw new Error("expected replayed");
    expect(replay.task).toBeNull();
    expect(countTasks(db)).toBe(0);
    expect(countBindings(db)).toBe(1);
  });

  it("rejects conflicting content for a known request id without any write", () => {
    const first = createTaskWithIntakeBinding(creationInput(), bindingInput(DIGEST_A));
    if (first?.outcome !== "created") throw new Error("expected created");

    const conflict = createTaskWithIntakeBinding(
      creationInput({ title: "Different content" }),
      bindingInput(DIGEST_B),
    );
    expect(conflict?.outcome).toBe("conflict");
    if (conflict?.outcome !== "conflict") throw new Error("expected conflict");
    expect(conflict.binding.taskId).toBe(first.task.id);
    expect(conflict.binding.payloadDigest).toBe(DIGEST_A);
    expect(countTasks(db)).toBe(1);
    expect(countBindings(db)).toBe(1);
  });

  it("resolves replay identically after the database file is closed and reopened", () => {
    const first = createTaskWithIntakeBinding(creationInput(), bindingInput(DIGEST_A));
    if (first?.outcome !== "created") throw new Error("expected created");

    closeDb();
    db = getDb(dbPath);

    const replay = createTaskWithIntakeBinding(creationInput(), bindingInput(DIGEST_A));
    expect(replay?.outcome).toBe("replayed");
    if (replay?.outcome !== "replayed") throw new Error("expected replayed");
    expect(replay.task?.id).toBe(first.task.id);
    expect(countTasks(db)).toBe(1);
    expect(countBindings(db)).toBe(1);
  });

  it("stays time-stable: replay after the schedule elapsed still resolves the original (M2)", () => {
    // First delivery was created with a future schedule; the identical replay
    // arrives long after that schedule has passed. The data layer never consults
    // the clock — the binding resolves regardless of elapsed time.
    const past = new Date(Date.now() - 3_600_000).toISOString();
    const first = createTaskWithIntakeBinding(
      creationInput({ scheduledAt: past }),
      bindingInput(DIGEST_A),
    );
    if (first?.outcome !== "created") throw new Error("expected created");

    const replay = createTaskWithIntakeBinding(
      creationInput({ scheduledAt: past }),
      bindingInput(DIGEST_A),
    );
    expect(replay?.outcome).toBe("replayed");
    if (replay?.outcome !== "replayed") throw new Error("expected replayed");
    expect(replay.task?.id).toBe(first.task.id);
    expect(replay.task?.scheduledAt).toBe(past);
    expect(countTasks(db)).toBe(1);
  });

  it("returns undefined and writes nothing when ownership validation rejects the insert", () => {
    const rejected = createTaskWithIntakeBinding(
      creationInput({ executionOwner: "ai", assigneeIds: ["someone"] }),
      bindingInput(DIGEST_A),
    );
    expect(rejected).toBeUndefined();
    expect(countTasks(db)).toBe(0);
    expect(countBindings(db)).toBe(0);
  });

  // R3: assignee liveness is MUTABLE creation-only eligibility. Once a binding
  // is durable, deactivating the assignee must never veto the resolution of an
  // identical replay (or its conflict/tombstone variants) — the replay promise
  // covers human-owned keyed tasks too.
  describe("replay after mutable ownership change (R3)", () => {
    function participantRow(overrides: Record<string, unknown> = {}) {
      const id = crypto.randomUUID();
      return {
        id,
        username: `assignee-${id.slice(0, 8)}`,
        normalizedUsername: `assignee-${id}`,
        displayName: "Assignee",
        passwordHash: "test-hash",
        role: "member" as const,
        active: true,
        ...overrides,
      };
    }

    function admitHumanOwnedFor(assigneeId: string, dedupKey = DEDUP_KEY) {
      const input = creationInput({ executionOwner: "human", assigneeIds: [assigneeId] });
      const first = createTaskWithIntakeBinding(input, bindingInput(DIGEST_A, dedupKey));
      if (first?.outcome !== "created") throw new Error("expected created");
      return { input, first };
    }

    function deactivate(id: string): void {
      db.update(participants)
        .set({ active: false, deactivatedAt: new Date().toISOString() })
        .where(eq(participants.id, id))
        .run();
    }

    it("resolves the identical replay of a human-owned task after its assignee was deactivated", () => {
      const assignee = participantRow();
      db.insert(participants).values(assignee).run();
      const { input, first } = admitHumanOwnedFor(assignee.id);

      // ONLY the assignee changes; the binding is already durable.
      deactivate(assignee.id);

      const replay = createTaskWithIntakeBinding(input, bindingInput(DIGEST_A));
      expect(replay?.outcome).toBe("replayed");
      if (replay?.outcome !== "replayed") throw new Error("expected replayed");
      expect(replay.task?.id).toBe(first.task.id);
      expect(replay.task?.executionOwner).toBe("human");
      expect(countTasks(db)).toBe(1);
      expect(countBindings(db)).toBe(1);
      // Ownership rows were neither duplicated nor mutated.
      const assignments = db.select().from(taskAssignments).all();
      expect(assignments).toHaveLength(1);
      expect(assignments[0]?.participantId).toBe(assignee.id);
    });

    it("replays the terminal human-owned task after its assignee was deactivated", () => {
      const assignee = participantRow();
      db.insert(participants).values(assignee).run();
      const { input, first } = admitHumanOwnedFor(assignee.id);
      deactivate(assignee.id);
      db.update(tasks).set({ status: "done" }).where(eq(tasks.id, first.task.id)).run();

      const replay = createTaskWithIntakeBinding(input, bindingInput(DIGEST_A));
      expect(replay?.outcome).toBe("replayed");
      if (replay?.outcome !== "replayed") throw new Error("expected replayed");
      expect(replay.task?.id).toBe(first.task.id);
      expect(replay.task?.status).toBe("done");
      expect(countTasks(db)).toBe(1);
      expect(countBindings(db)).toBe(1);
    });

    it("returns the retained tombstone, not an ownership rejection, after the assignee was deactivated", () => {
      const assignee = participantRow();
      db.insert(participants).values(assignee).run();
      const { input, first } = admitHumanOwnedFor(assignee.id);
      deactivate(assignee.id);
      db.delete(tasks).where(eq(tasks.id, first.task.id)).run();

      const replay = createTaskWithIntakeBinding(input, bindingInput(DIGEST_A));
      expect(replay?.outcome).toBe("replayed");
      if (replay?.outcome !== "replayed") throw new Error("expected replayed");
      expect(replay.task).toBeNull();
      expect(replay.binding.taskId).toBe(first.task.id);
      expect(countTasks(db)).toBe(0);
      expect(countBindings(db)).toBe(1);
    });

    it("resolves a conflict for a known request id even when the assignee has been deactivated", () => {
      const assignee = participantRow();
      db.insert(participants).values(assignee).run();
      const { first } = admitHumanOwnedFor(assignee.id);
      deactivate(assignee.id);

      const conflict = createTaskWithIntakeBinding(
        creationInput({ executionOwner: "human", assigneeIds: [assignee.id], title: "Changed" }),
        bindingInput(DIGEST_B),
      );
      expect(conflict?.outcome).toBe("conflict");
      if (conflict?.outcome !== "conflict") throw new Error("expected conflict");
      expect(conflict.binding.taskId).toBe(first.task.id);
      expect(conflict.binding.payloadDigest).toBe(DIGEST_A);
      expect(countTasks(db)).toBe(1);
      expect(countBindings(db)).toBe(1);
    });

    it("still rejects a first admission whose assignee is inactive (creation-only eligibility retained)", () => {
      const assignee = participantRow({ active: false });
      db.insert(participants).values(assignee).run();

      const rejected = createTaskWithIntakeBinding(
        creationInput({ executionOwner: "human", assigneeIds: [assignee.id] }),
        bindingInput(DIGEST_A, "participant|relay-svc|proj-intake|relay-svc:fresh-1"),
      );
      expect(rejected).toBeUndefined();
      expect(countTasks(db)).toBe(0);
      expect(countBindings(db)).toBe(0);
    });
  });

  it("resolves exactly one created outcome under a distinct-process race on the same dedup key", async () => {
    // Two independent connections (this worker + a real child process importing
    // the same data layer) race one dedup key against the same SQLite file.
    const repoDataDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const fixturePath = join(
      dirname(fileURLToPath(import.meta.url)),
      "fixtures",
      "intakeContentionChild.mjs",
    );
    const child = spawn(
      process.execPath,
      ["--import", "tsx", fixturePath, dbPath, DEDUP_KEY, DIGEST_A, PROJECT_ID],
      { cwd: repoDataDir, stdio: ["ignore", "pipe", "pipe"] },
    );

    let childStdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      childStdout += chunk;
    });
    let childStderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      childStderr += chunk;
    });

    // Give the child time to reach its transaction, then race it in-process.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const local = createTaskWithIntakeBinding(creationInput(), bindingInput(DIGEST_A));

    const childExit = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`child timed out: ${childStderr}`)), 30_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(code ?? -1);
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    expect(childExit).toBe(0);

    // The child's pino logs share stdout; the admission result is the line that
    // parses to an object carrying an `outcome` field.
    const resultLines = childStdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as { outcome?: unknown };
        } catch {
          return null;
        }
      })
      .filter((parsed): parsed is { outcome?: unknown } => parsed !== null && "outcome" in parsed);
    expect(resultLines).toHaveLength(1);
    const remote = resultLines[0] as { outcome: string; task?: { id: string } | null };

    const outcomes = [local?.outcome, remote.outcome].sort();
    expect(outcomes).toEqual(["created", "replayed"]);
    if (local?.outcome !== "created" && local?.outcome !== "replayed") {
      throw new Error("unexpected local outcome");
    }
    const createdTaskId = local.outcome === "created" ? local.task.id : remote.task?.id;
    expect(createdTaskId).toBeTruthy();
    expect(countTasks(db)).toBe(1);
    expect(countBindings(db)).toBe(1);
    expect(db.select().from(taskIntakeBindings).all()[0].taskId).toBe(createdTaskId);
  }, 60_000);
});

/**
 * Defensive fault injection for the documented cross-connection constraint
 * reconciliation (finding ce77887e4444, R6).
 *
 * Scope qualification: the BEGIN IMMEDIATE protocol serializes every binding
 * write, so the "second connection committed the same key between this
 * transaction's read and its insert" state is NOT reachable in production —
 * the distinct-process race test above proves the real serialization/replay
 * behavior. These tests are NOT a concurrency claim. They prove the documented
 * catch → re-read → replay/conflict/tombstone defense classifies the ACTUAL
 * extended result codes the installed better-sqlite3 throws (`SQLITE_CONSTRAINT_PRIMARYKEY`,
 * `SQLITE_CONSTRAINT_UNIQUE`) — the bare base code `SQLITE_CONSTRAINT` is never
 * thrown for a statement-level failure — using REAL driver errors raised at the
 * real binding-insert statement inside a real IMMEDIATE transaction.
 */
describe("constraint-fault reconciliation (defensive fault injection, finding ce77887e4444)", () => {
  let workDir: string;
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    closeDb();
    workDir = mkdtempSync(join(tmpdir(), "aif-task-intake-fault-"));
    dbPath = join(workDir, "intake-fault.sqlite");
    db = getDb(dbPath);
    db.insert(projects)
      .values({ id: PROJECT_ID, name: "Intake", rootPath: join(workDir, "root") })
      .run();
  });

  afterEach(() => {
    closeDb();
    rmSync(workDir, { recursive: true, force: true });
  });

  const WINNER_TASK_ID = "task-winner-original";
  const DELETED_TASK_ID = "task-deleted-original";

  function commitWinnerBinding(digest: string, taskId: string): void {
    // Committed OUTSIDE the failed transaction at the exact boundary where an
    // unreachable second connection would have committed the winning binding —
    // visible to the production catch's re-read.
    db.insert(taskIntakeBindings)
      .values({
        dedupKey: DEDUP_KEY,
        projectId: PROJECT_ID,
        principalKind: "participant",
        principalId: "relay-svc",
        requestId: "relay-svc:nightly-1",
        payloadDigest: digest,
        taskId,
        source: "fault_injection_winner",
      })
      .run();
  }

  /**
   * Arms a REAL SQLite BEFORE INSERT trigger on the fixture's binding table so
   * the production binding INSERT fails with a genuine installed-driver error
   * at the exact statement the documented defense targets, and shadows the
   * connection's transaction method so the (classification-agnostic) wrapper
   * records the real caught error, disarms the trigger, optionally commits the
   * winner binding, and ALWAYS rethrows the original error. The production
   * catch then runs unmodified above it.
   */
  function armBindingInsertFault(options: {
    triggerName: string;
    triggerSql: string | string[];
    commitWinner?: () => void;
  }): { caught: unknown[] } {
    const caught: unknown[] = [];
    for (const statement of Array.isArray(options.triggerSql)
      ? options.triggerSql
      : [options.triggerSql]) {
      db.run(sql.raw(statement));
    }
    const originalTransaction = db.transaction.bind(db);
    (db as { transaction: unknown }).transaction = (callback: unknown, config: unknown) => {
      try {
        return (originalTransaction as (cb: unknown, cfg: unknown) => unknown)(callback, config);
      } catch (error) {
        caught.push(error);
        db.run(sql.raw(`DROP TRIGGER IF EXISTS ${options.triggerName}`));
        options.commitWinner?.();
        throw error;
      }
    };
    return { caught };
  }

  // Real PK collision: the trigger pre-inserts the SAME dedup key inside the
  // transaction, so the production INSERT itself raises the extended code.
  const PK_COLLISION_TRIGGER = `CREATE TRIGGER fault_binding_pk_collision
BEFORE INSERT ON task_intake_bindings
WHEN NEW.dedup_key = '${DEDUP_KEY}'
BEGIN
  INSERT INTO task_intake_bindings
    (dedup_key, project_id, principal_kind, principal_id, request_id, payload_digest, task_id, source)
  VALUES
    (NEW.dedup_key, NEW.project_id, NEW.principal_kind, NEW.principal_id, NEW.request_id, NEW.payload_digest, NEW.task_id, 'fault_injection');
END`;

  // Real UNIQUE collision on a non-PK unique index (the participants.ts family
  // shape): the trigger occupies task_id under a different dedup key.
  // (better-sqlite3 runs one statement per prepare — index and trigger separate.)
  const UNIQUE_COLLISION_TRIGGER = [
    "CREATE UNIQUE INDEX fault_unique_binding_task ON task_intake_bindings(task_id)",
    `CREATE TRIGGER fault_binding_unique_collision
BEFORE INSERT ON task_intake_bindings
WHEN NEW.dedup_key = '${DEDUP_KEY}'
BEGIN
  INSERT INTO task_intake_bindings
    (dedup_key, project_id, principal_kind, principal_id, request_id, payload_digest, task_id, source)
  VALUES
    ('fault|other|proj-intake|other:1', NEW.project_id, NEW.principal_kind, NEW.principal_id, NEW.request_id, NEW.payload_digest, NEW.task_id, 'fault_injection');
END`,
  ];

  // Real non-constraint failure: the trigger body references a missing table,
  // so the binding INSERT fails to compile with SQLITE_ERROR.
  const UNRELATED_ERROR_TRIGGER = `CREATE TRIGGER fault_binding_unrelated
BEFORE INSERT ON task_intake_bindings
WHEN NEW.dedup_key = '${DEDUP_KEY}'
BEGIN
  SELECT * FROM __no_such_fault_table__;
END`;

  // Real constraint-family member OUTSIDE the uniqueness set whose message
  // literally claims "UNIQUE constraint failed" — RAISE(ABORT) emits
  // SQLITE_CONSTRAINT_TRIGGER. Proves message text is never classified.
  const RAISE_TRIGGER = `CREATE TRIGGER fault_binding_raise
BEFORE INSERT ON task_intake_bindings
WHEN NEW.dedup_key = '${DEDUP_KEY}'
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE constraint failed: task_intake_bindings.dedup_key');
END`;

  function expectSqliteCode(caught: unknown[], expectedCode: string): void {
    expect(caught).toHaveLength(1);
    expect((caught[0] as { name?: unknown }).name).toBe("SqliteError");
    expect((caught[0] as { code?: unknown }).code).toBe(expectedCode);
  }

  it("resolves a real PRIMARYKEY constraint error as replay to the committed winner (extended code, not bare SQLITE_CONSTRAINT)", () => {
    const original = createTaskWithIntakeBinding(
      creationInput(),
      bindingInput(DIGEST_A, "participant|relay-svc|proj-intake|relay-svc:original-1"),
    );
    if (original?.outcome !== "created") throw new Error("expected created");

    const { caught } = armBindingInsertFault({
      triggerName: "fault_binding_pk_collision",
      triggerSql: PK_COLLISION_TRIGGER,
      commitWinner: () => commitWinnerBinding(DIGEST_A, original.task.id),
    });

    const result = createTaskWithIntakeBinding(creationInput(), bindingInput(DIGEST_A));

    // The real installed-driver error entered the production catch…
    expectSqliteCode(caught, "SQLITE_CONSTRAINT_PRIMARYKEY");
    // …and was classified and resolved as replay, not rethrown.
    expect(result?.outcome).toBe("replayed");
    if (result?.outcome !== "replayed") throw new Error("expected replayed");
    expect(result.task?.id).toBe(original.task.id);
    expect(result.binding.taskId).toBe(original.task.id);
    expect(result.binding.payloadDigest).toBe(DIGEST_A);
    // The faulted attempt rolled back: the original task is still the only one.
    expect(countTasks(db)).toBe(1);
    expect(countBindings(db)).toBe(2);
  });

  it("resolves a real PRIMARYKEY constraint error as conflict when the committed winner holds a different digest", () => {
    const original = createTaskWithIntakeBinding(
      creationInput(),
      bindingInput(DIGEST_A, "participant|relay-svc|proj-intake|relay-svc:original-1"),
    );
    if (original?.outcome !== "created") throw new Error("expected created");

    const { caught } = armBindingInsertFault({
      triggerName: "fault_binding_pk_collision",
      triggerSql: PK_COLLISION_TRIGGER,
      commitWinner: () => commitWinnerBinding(DIGEST_B, original.task.id),
    });

    const result = createTaskWithIntakeBinding(creationInput(), bindingInput(DIGEST_A));

    expectSqliteCode(caught, "SQLITE_CONSTRAINT_PRIMARYKEY");
    expect(result?.outcome).toBe("conflict");
    if (result?.outcome !== "conflict") throw new Error("expected conflict");
    expect(result.binding.taskId).toBe(original.task.id);
    expect(result.binding.payloadDigest).toBe(DIGEST_B);
    expect(countTasks(db)).toBe(1);
    expect(countBindings(db)).toBe(2);
  });

  it("resolves a real PRIMARYKEY constraint error as a tombstone when the winner's task row is gone", () => {
    const { caught } = armBindingInsertFault({
      triggerName: "fault_binding_pk_collision",
      triggerSql: PK_COLLISION_TRIGGER,
      commitWinner: () => commitWinnerBinding(DIGEST_A, DELETED_TASK_ID),
    });

    const result = createTaskWithIntakeBinding(creationInput(), bindingInput(DIGEST_A));

    expectSqliteCode(caught, "SQLITE_CONSTRAINT_PRIMARYKEY");
    expect(result?.outcome).toBe("replayed");
    if (result?.outcome !== "replayed") throw new Error("expected replayed");
    expect(result.task).toBeNull();
    expect(result.binding.taskId).toBe(DELETED_TASK_ID);
    expect(countTasks(db)).toBe(0);
    expect(countBindings(db)).toBe(1);
  });

  it("rethrows a real PRIMARYKEY constraint error and preserves rollback when no winner exists", () => {
    const { caught } = armBindingInsertFault({
      triggerName: "fault_binding_pk_collision",
      triggerSql: PK_COLLISION_TRIGGER,
    });

    let thrown: unknown;
    try {
      createTaskWithIntakeBinding(creationInput(), bindingInput(DIGEST_A));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(caught[0]);
    expectSqliteCode(caught, "SQLITE_CONSTRAINT_PRIMARYKEY");
    expect(countTasks(db)).toBe(0);
    expect(countBindings(db)).toBe(0);
  });

  it("resolves a real UNIQUE constraint error (non-PK unique index, participants.ts family shape) as replay", () => {
    const { caught } = armBindingInsertFault({
      triggerName: "fault_binding_unique_collision",
      triggerSql: UNIQUE_COLLISION_TRIGGER,
      commitWinner: () => commitWinnerBinding(DIGEST_A, WINNER_TASK_ID),
    });

    const result = createTaskWithIntakeBinding(creationInput(), bindingInput(DIGEST_A));

    expectSqliteCode(caught, "SQLITE_CONSTRAINT_UNIQUE");
    expect(result?.outcome).toBe("replayed");
    if (result?.outcome !== "replayed") throw new Error("expected replayed");
    expect(result.task).toBeNull();
    expect(result.binding.taskId).toBe(WINNER_TASK_ID);
    expect(countTasks(db)).toBe(0);
    expect(countBindings(db)).toBe(1);
  });

  it("rethrows a real unrelated (non-constraint) error even though a winner exists — no broad swallow", () => {
    const { caught } = armBindingInsertFault({
      triggerName: "fault_binding_unrelated",
      triggerSql: UNRELATED_ERROR_TRIGGER,
      commitWinner: () => commitWinnerBinding(DIGEST_A, WINNER_TASK_ID),
    });

    let thrown: unknown;
    try {
      createTaskWithIntakeBinding(creationInput(), bindingInput(DIGEST_A));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(caught[0]);
    expectSqliteCode(caught, "SQLITE_ERROR");
    // A winner WAS committed; the unrelated error was still not reconciled.
    expect(countBindings(db)).toBe(1);
    expect(countTasks(db)).toBe(0);
  });

  it("rethrows a real SQLITE_CONSTRAINT_TRIGGER whose message claims 'UNIQUE constraint failed' — message text is never classified", () => {
    const { caught } = armBindingInsertFault({
      triggerName: "fault_binding_raise",
      triggerSql: RAISE_TRIGGER,
      commitWinner: () => commitWinnerBinding(DIGEST_A, WINNER_TASK_ID),
    });

    let thrown: unknown;
    try {
      createTaskWithIntakeBinding(creationInput(), bindingInput(DIGEST_A));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(caught[0]);
    expectSqliteCode(caught, "SQLITE_CONSTRAINT_TRIGGER");
    expect((caught[0] as { message?: string }).message).toContain("UNIQUE constraint failed");
    expect(countBindings(db)).toBe(1);
    expect(countTasks(db)).toBe(0);
  });
});

describe("isSqliteUniqueConstraintError (real installed-driver classification pinning)", () => {
  function realDriverError(exec: (sqlite: Database.Database) => void): {
    name?: unknown;
    code?: unknown;
    message?: string;
  } {
    const sqlite = new Database(":memory:");
    try {
      exec(sqlite);
    } catch (error) {
      return error as { name?: unknown; code?: unknown; message?: string };
    } finally {
      sqlite.close();
    }
    throw new Error("expected the driver statement to fail");
  }

  it("classifies a real PRIMARYKEY SqliteError from the installed driver", () => {
    const error = realDriverError((sqlite) => {
      sqlite.exec("CREATE TABLE pin (k TEXT PRIMARY KEY)");
      sqlite.prepare("INSERT INTO pin (k) VALUES ('a')").run();
      sqlite.prepare("INSERT INTO pin (k) VALUES ('a')").run();
    });
    // The finding's core fact: the installed driver emits the extended code.
    expect(error.code).toBe("SQLITE_CONSTRAINT_PRIMARYKEY");
    expect(error.code).not.toBe("SQLITE_CONSTRAINT");
    expect(isSqliteUniqueConstraintError(error)).toBe(true);
  });

  it("classifies a real UNIQUE SqliteError from the installed driver", () => {
    const error = realDriverError((sqlite) => {
      sqlite.exec("CREATE TABLE pin (id TEXT PRIMARY KEY, email TEXT UNIQUE)");
      sqlite.prepare("INSERT INTO pin (id, email) VALUES ('i1', 'a@x')").run();
      sqlite.prepare("INSERT INTO pin (id, email) VALUES ('i2', 'a@x')").run();
    });
    expect(error.code).toBe("SQLITE_CONSTRAINT_UNIQUE");
    expect(isSqliteUniqueConstraintError(error)).toBe(true);
  });

  it("rejects a real unrelated SqliteError (SQLITE_ERROR)", () => {
    const error = realDriverError((sqlite) => {
      sqlite.prepare("SELECT * FROM __no_such_table__").all();
    });
    expect(error.code).toBe("SQLITE_ERROR");
    expect(isSqliteUniqueConstraintError(error)).toBe(false);
  });

  it("rejects a real NOT NULL constraint member outside the uniqueness set", () => {
    const error = realDriverError((sqlite) => {
      sqlite.exec("CREATE TABLE pin (id TEXT PRIMARY KEY, req TEXT NOT NULL)");
      sqlite.prepare("INSERT INTO pin (id, req) VALUES ('n1', NULL)").run();
    });
    expect(error.code).toBe("SQLITE_CONSTRAINT_NOTNULL");
    expect(isSqliteUniqueConstraintError(error)).toBe(false);
  });

  it("rejects unknown or non-SQLite codes", () => {
    expect(
      isSqliteUniqueConstraintError(Object.assign(new Error("busy"), { code: "SQLITE_BUSY" })),
    ).toBe(false);
    expect(
      isSqliteUniqueConstraintError(
        Object.assign(new Error("boom"), { code: "NOT_A_SQLITE_CODE" }),
      ),
    ).toBe(false);
    expect(isSqliteUniqueConstraintError({ code: 26 })).toBe(false);
  });

  it("rejects a message-only error carrying no structured code", () => {
    const messageOnly = new Error("UNIQUE constraint failed: task_intake_bindings.dedup_key");
    expect((messageOnly as { code?: unknown }).code).toBeUndefined();
    expect(isSqliteUniqueConstraintError(messageOnly)).toBe(false);
  });

  it("rejects null, undefined, and primitive values", () => {
    expect(isSqliteUniqueConstraintError(null)).toBe(false);
    expect(isSqliteUniqueConstraintError(undefined)).toBe(false);
    expect(isSqliteUniqueConstraintError("SQLITE_CONSTRAINT_PRIMARYKEY")).toBe(false);
    expect(isSqliteUniqueConstraintError(26)).toBe(false);
  });
});

describe("getAiWorkloadState (binding-agnostic workload predicate, §8.2)", () => {
  let workDir: string;
  let db: Db;
  let nowIso: string;

  beforeEach(() => {
    closeDb();
    workDir = mkdtempSync(join(tmpdir(), "aif-workload-"));
    db = getDb(join(workDir, "workload.sqlite"));
    db.insert(projects)
      .values({ id: PROJECT_ID, name: "Workload", rootPath: join(workDir, "root") })
      .run();
    nowIso = "2026-11-05T12:00:00.000Z";
  });

  afterEach(() => {
    closeDb();
    rmSync(workDir, { recursive: true, force: true });
  });

  function rawTask(overrides: Partial<NewTaskRow> = {}): string {
    const id = crypto.randomUUID();
    db.insert(tasks)
      .values({
        projectId: PROJECT_ID,
        title: "workload fixture",
        executionOwner: "ai",
        ...overrides,
        id,
      })
      .run();
    return id;
  }

  function future(hours = 1): string {
    return new Date(new Date(nowIso).getTime() + hours * 3_600_000).toISOString();
  }

  it("counts admitted-not-started backlog rows as pending immediately post-commit (ACK-before-start)", () => {
    createTask({ projectId: PROJECT_ID, title: "legacy backlog", description: "no binding" });
    const state = getAiWorkloadState(nowIso);
    expect(state.pendingCount).toBe(1);
    expect(state.busy).toBe(0);
    expect(state.timedPendingCount).toBe(0);
  });

  it("counts future scheduledAt rows from ANY entry path with no intake binding (M4)", () => {
    const id = createTask({ projectId: PROJECT_ID, title: "legacy timed", description: "d" })!.id;
    updateTask(id, { scheduledAt: future(2) });

    const state = getAiWorkloadState(nowIso);
    expect(state.timedPendingCount).toBe(1);
    expect(state.earliestScheduledAt).toBe(future(2));
    // Still owed: backlog until the scheduler fires it.
    expect(state.pendingCount).toBe(1);
    // The row has no intake binding — the predicate is binding-agnostic.
    expect(countBindings(db)).toBe(0);
  });

  it("counts in-stage rows as busy, with a pending split on missing live lock", () => {
    rawTask({ status: "planning", lockedBy: "coordinator", lockedUntil: future(1) });
    let state = getAiWorkloadState(nowIso);
    expect(state.busy).toBe(1);
    expect(state.pendingCount).toBe(0);

    // Quiet model waiting is busy — but a lock expiring means the coordinator
    // owes a transition, so the row is also pending.
    rawTask({ status: "implementing", lockedBy: null, lockedUntil: null });
    state = getAiWorkloadState(nowIso);
    expect(state.busy).toBe(2);
    expect(state.pendingCount).toBe(1);
  });

  it("distinguishes plan_ready autoMode (pending) from the human gate autoMode:false (excluded)", () => {
    rawTask({ status: "plan_ready", autoMode: true });
    rawTask({ status: "plan_ready", autoMode: false });
    const state = getAiWorkloadState(nowIso);
    expect(state.pendingCount).toBe(1);
  });

  it("excludes a human-gated plan_ready row from the timed obligation count too (§8.2)", () => {
    // A plan parked for manual decision with a future scheduledAt must not
    // hold the PC awake indefinitely — the human gate wins over the timer.
    rawTask({ status: "plan_ready", autoMode: false, scheduledAt: future(3) });
    const state = getAiWorkloadState(nowIso);
    expect(state.timedPendingCount).toBe(0);
    expect(state.earliestScheduledAt).toBeNull();
    expect(state.pendingCount).toBe(0);
    expect(state.busy).toBe(0);

    // The auto-start counterpart with the same schedule stays protective.
    rawTask({ status: "plan_ready", autoMode: true, scheduledAt: future(4) });
    const after = getAiWorkloadState(nowIso);
    expect(after.timedPendingCount).toBe(1);
    expect(after.earliestScheduledAt).toBe(future(4));
    // Counted once for the row, in both classes.
    expect(after.pendingCount).toBe(1);
  });

  it("excludes human gates and terminal rows from every counter", () => {
    rawTask({ status: "backlog", paused: true });
    rawTask({ status: "blocked_external", scheduledAt: future(1) });
    rawTask({ status: "plan_ready", autoMode: true, manualReviewRequired: true });
    rawTask({ status: "implementing", executionOwner: "human" });
    rawTask({ status: "done", scheduledAt: future(1) });
    rawTask({ status: "verified" });

    const state = getAiWorkloadState(nowIso);
    expect(state.busy).toBe(0);
    expect(state.pendingCount).toBe(0);
    expect(state.timedPendingCount).toBe(0);
    expect(state.earliestScheduledAt).toBeNull();
  });

  it("re-reads live: reschedule/cancel/terminal changes are reflected on the next read", () => {
    const id = createTask({ projectId: PROJECT_ID, title: "reschedulable", description: "d" })!.id;
    updateTask(id, { scheduledAt: future(1) });
    expect(getAiWorkloadState(nowIso).timedPendingCount).toBe(1);

    // Cancel the obligation (schedule cleared → drops out of timed, still backlog).
    updateTask(id, { scheduledAt: null });
    let state = getAiWorkloadState(nowIso);
    expect(state.timedPendingCount).toBe(0);
    expect(state.pendingCount).toBe(1);

    // Terminal rows stop protecting anything.
    db.update(tasks).set({ status: "done" }).where(eq(tasks.id, id)).run();
    state = getAiWorkloadState(nowIso);
    expect(state.pendingCount).toBe(0);
  });

  it("keeps a newer task protected when an older one completes (aggregates over all rows)", () => {
    rawTask({ status: "done" });
    createTask({ projectId: PROJECT_ID, title: "new pending", description: "d" });
    const state = getAiWorkloadState(nowIso);
    expect(state.pendingCount).toBe(1);
  });

  it("treats a past-due backlog row as pending until the scheduler fires it (due catch-up)", () => {
    const past = new Date(new Date(nowIso).getTime() - 3_600_000).toISOString();
    createTask({ projectId: PROJECT_ID, title: "overdue", description: "d", scheduledAt: past });
    const state = getAiWorkloadState(nowIso);
    expect(state.pendingCount).toBe(1);
    expect(state.timedPendingCount).toBe(0);
    expect(state.earliestScheduledAt).toBeNull();
  });

  it("sees an admission made between two consecutive reads (no caching)", () => {
    expect(getAiWorkloadState(nowIso).pendingCount).toBe(0);
    createTask({ projectId: PROJECT_ID, title: "late arrival", description: "d" });
    expect(getAiWorkloadState(nowIso).pendingCount).toBe(1);
  });

  it("returns the same state after a database reopen (restart-safe)", () => {
    createTask({ projectId: PROJECT_ID, title: "durable pending", description: "d" });
    const before = getAiWorkloadState(nowIso);

    closeDb();
    db = getDb(join(workDir, "workload.sqlite"));

    const after = getAiWorkloadState(nowIso);
    expect(after).toEqual(before);
  });

  it("respects the injected clock instead of the wall clock", () => {
    rawTask({ status: "backlog", scheduledAt: future(1) });
    // At the later clock time the obligation has fired/elapsed → drops from timed.
    const laterClock = future(2);
    const state = getAiWorkloadState(laterClock);
    expect(state.timedPendingCount).toBe(0);
  });
});

describe("pinned host SQL mirror (C2 amendment, §11.12)", () => {
  // The C2 host amendment (`scripts/workstation/pc-busy/wsl-report-amendment.example.ps1`)
  // must stay a faithful mirror of the source predicate: this executes the
  // PINNED SQL TEXT from the amendment file against the same fixture DB over
  // a separate READONLY better-sqlite3 connection — the exact modality the
  // host writer uses — and proves it agrees with `getAiWorkloadState()`
  // (binding-agnostic: no `task_intake_bindings` join anywhere, M4).
  let workDir: string;
  let db: Db;
  let dbPath: string;
  let nowIso: string;

  beforeEach(() => {
    closeDb();
    workDir = mkdtempSync(join(tmpdir(), "aif-workload-sql-"));
    dbPath = join(workDir, "workload.sqlite");
    db = getDb(dbPath);
    db.insert(projects)
      .values({ id: PROJECT_ID, name: "Workload SQL", rootPath: join(workDir, "root") })
      .run();
    nowIso = "2026-11-05T12:00:00.000Z";
  });

  afterEach(() => {
    closeDb();
    rmSync(workDir, { recursive: true, force: true });
  });

  function rawTask(overrides: Partial<NewTaskRow> = {}): void {
    db.insert(tasks)
      .values({
        projectId: PROJECT_ID,
        title: "workload sql fixture",
        executionOwner: "ai",
        ...overrides,
        id: crypto.randomUUID(),
      })
      .run();
  }

  function offsetIso(hours: number): string {
    return new Date(new Date(nowIso).getTime() + hours * 3_600_000).toISOString();
  }

  function loadPinnedSql(): string {
    const ps1 = readFileSync(
      fileURLToPath(
        new URL(
          "../../../../scripts/workstation/pc-busy/wsl-report-amendment.example.ps1",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    const match = /\$aifPendingSql = @"\n([\s\S]*?)\n"@/.exec(ps1);
    expect(match, "pinned SQL here-string not found in the C2 amendment").toBeTruthy();
    return match![1];
  }

  /** The host modality: a SEPARATE readonly connection running the raw SQL. */
  function runPinnedSql(sql: string): number {
    const readonly = new Database(dbPath, { readonly: true });
    try {
      const row = readonly.prepare(sql).get(nowIso, nowIso) as { n: number };
      return row.n;
    } finally {
      readonly.close();
    }
  }

  it("agrees with the source predicate over a mixed fixture, with no intake join (M4)", () => {
    const sql = loadPinnedSql();
    expect(sql.toUpperCase()).toContain("SELECT COUNT(*)");
    // Binding-agnostic by construction — the host channel never reads bindings.
    expect(sql).not.toContain("task_intake_bindings");

    rawTask({ status: "backlog" }); // pending only (admitted-not-started, no binding)
    rawTask({ status: "backlog", scheduledAt: offsetIso(2) }); // pending ∩ timed (counted once)
    rawTask({ status: "planning", lockedBy: "coordinator", lockedUntil: offsetIso(1) }); // busy only
    rawTask({ status: "implementing", lockedBy: null, lockedUntil: null }); // busy + pending
    rawTask({ status: "plan_ready", autoMode: true }); // pending (auto-start)
    // Gated rows — the human/external gates the guard excludes. The
    // human-gated row below carries a future schedule on purpose: the gate
    // must win over the timed branch in BOTH mirrors (review finding — the
    // timed branch used to count it and keep the PC awake indefinitely).
    rawTask({ status: "plan_ready", autoMode: false, scheduledAt: offsetIso(3) });
    rawTask({ status: "backlog", paused: true });
    rawTask({ status: "blocked_external", scheduledAt: offsetIso(1) });
    rawTask({ status: "plan_ready", autoMode: true, manualReviewRequired: true });
    rawTask({ status: "implementing", executionOwner: "human" });
    rawTask({ status: "done", scheduledAt: offsetIso(1) });
    rawTask({ status: "verified" });
    rawTask({ status: "backlog", scheduledAt: offsetIso(-1) }); // pending, not timed (due catch-up)

    const state = getAiWorkloadState(nowIso);
    expect(state.busy).toBe(2);
    expect(state.pendingCount).toBe(5);
    expect(state.timedPendingCount).toBe(1);
    // Exactly one deliberate overlap row (backlog + future schedule):
    const expectedUnion = state.pendingCount + state.timedPendingCount - 1;
    expect(expectedUnion).toBe(5);

    // The host channel (separate readonly connection, pinned SQL text)
    // returns the same protection count as the source predicate.
    expect(runPinnedSql(sql)).toBe(expectedUnion);
  });

  it("stays in agreement after a live schedule fires (row leaves both classes)", () => {
    const sql = loadPinnedSql();
    rawTask({ status: "backlog" });
    const fired = crypto.randomUUID();
    db.insert(tasks)
      .values({
        projectId: PROJECT_ID,
        title: "fired obligation",
        executionOwner: "ai",
        status: "backlog",
        scheduledAt: offsetIso(2),
        id: fired,
      })
      .run();

    let state = getAiWorkloadState(nowIso);
    expect(state.pendingCount).toBe(2);
    expect(state.timedPendingCount).toBe(1);
    expect(runPinnedSql(sql)).toBe(2); // union = 2 + 1 − 1 overlap

    // The scheduler fires it: leaves backlog, holds a live lock, clears the
    // schedule — drops out of pending AND timed, still busy.
    db.update(tasks)
      .set({
        status: "planning",
        lockedBy: "coordinator",
        lockedUntil: offsetIso(1),
        scheduledAt: null,
      })
      .where(eq(tasks.id, fired))
      .run();
    state = getAiWorkloadState(nowIso);
    expect(state.busy).toBe(1);
    expect(state.pendingCount).toBe(1);
    expect(state.timedPendingCount).toBe(0);
    expect(runPinnedSql(sql)).toBe(1);
  });
});
