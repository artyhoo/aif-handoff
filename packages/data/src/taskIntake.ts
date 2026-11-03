import { and, asc, eq, inArray, max } from "drizzle-orm";
import {
  generatePlanPath,
  getProjectConfig,
  logger as createLogger,
  participants,
  projects,
  taskAssignments,
  taskExecutorHistory,
  auditEvents,
  taskIntakeBindings,
  tasks,
  type AuditActor,
  type ExecutionOwner,
  type NewTaskRow,
  type TaskIntakeBindingRow,
  type TaskRow,
} from "@aif/shared";
import { getDb } from "@aif/shared/server";
import { createAuditEventValues } from "./audit.js";

/**
 * Shared task-insertion path plus the atomic keyed-intake admission of plan
 * p2-wake-on-work (§7.2). The legacy `createTask` and `createTaskWithIntakeBinding`
 * run the SAME preparation and the SAME transaction body, so the legacy creation
 * contract stays byte-identical; the keyed path only adds the lookup-or-insert of
 * one `task_intake_bindings` row inside the same better-sqlite3 transaction.
 */

const log = createLogger("data:task-intake");

type TaskDb = ReturnType<typeof getDb>;
type TaskTx = Parameters<Parameters<TaskDb["transaction"]>[0]>[0];

/** Insert input shared by legacy and keyed task creation (mirrors `createTask`). */
export interface CreateTaskInsertInput {
  projectId: string;
  title: string;
  description: string;
  attachments?: unknown[];
  priority?: number;
  autoMode?: boolean;
  executionOwner?: ExecutionOwner;
  assigneeIds?: string[];
  actor?: AuditActor;
  isFix?: boolean;
  plannerMode?: string;
  planPath?: string;
  planDocs?: boolean;
  planTests?: boolean;
  skipReview?: boolean;
  useSubagents?: boolean;
  runPlanImprove?: boolean;
  runPostVerify?: boolean;
  autoQa?: boolean;
  maxReviewIterations?: number;
  paused?: boolean;
  runtimeProfileId?: string | null;
  modelOverride?: string | null;
  runtimeOptions?: Record<string, unknown> | null;
  roadmapAlias?: string;
  tags?: string[];
  scheduledAt?: string | null;
  position?: number;
}

/** Highest backlog position in a project (null when the project has no backlog). */
export function getMaxBacklogPosition(projectId: string): number | null {
  const row = getDb()
    .select({ maxPos: max(tasks.position) })
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), eq(tasks.status, "backlog")))
    .get();
  return row?.maxPos == null ? null : Number(row.maxPos);
}

interface PreparedTaskCreation {
  id: string;
  now: string;
  executionOwner: ExecutionOwner;
  assigneeIds: string[];
  assignees: {
    participantId: string;
    displayName: string;
    role: "admin" | "member";
    active: boolean;
  }[];
  actor: AuditActor;
  position: number;
  resolvedPlanPath: string | undefined;
}

/**
 * Ownership/planPath/position preparation shared by legacy and keyed creation.
 * Returns `undefined` when ownership validation rejects the insert — the legacy
 * `createTask` contract (`undefined` → caller answers 409 invalid_ownership).
 * This validation is INSERT-only eligibility (R3): the keyed path defers it to
 * the binding-miss path so it can never veto an already-durable replay.
 */
export function prepareTaskCreation(
  input: CreateTaskInsertInput,
): PreparedTaskCreation | undefined {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const executionOwner = input.executionOwner ?? "ai";
  const assigneeIds = [...new Set(input.assigneeIds ?? [])];
  const actor = input.actor ?? {
    kind: "system",
    id: null,
    displayNameSnapshot: "System",
  };

  // Auto-compute planPath for full mode when no explicit path is provided.
  // Read the project root directly (not via ./index.js) — index.ts re-exports
  // this module, so a back-import would create an import cycle.
  let resolvedPlanPath = input.planPath;
  if (input.plannerMode === "full") {
    const project = db
      .select({ rootPath: projects.rootPath })
      .from(projects)
      .where(eq(projects.id, input.projectId))
      .get();
    const projectRoot = project?.rootPath ?? process.cwd();
    const cfg = getProjectConfig(projectRoot);
    const defaultPlanPath = cfg.paths.plan;

    if (resolvedPlanPath === undefined || resolvedPlanPath === defaultPlanPath) {
      resolvedPlanPath = generatePlanPath(input.title, "full", {
        plansDir: cfg.paths.plans,
        defaultPlanPath,
      });
      log.debug("Auto-generated plan path for full mode: %s", resolvedPlanPath);
    }
  }

  const assignees =
    assigneeIds.length === 0
      ? []
      : db
          .select({
            participantId: participants.id,
            displayName: participants.displayName,
            role: participants.role,
            active: participants.active,
          })
          .from(participants)
          .where(inArray(participants.id, assigneeIds))
          .orderBy(asc(participants.displayName), asc(participants.id))
          .all();
  const hasInvalidAssignees =
    assignees.length !== assigneeIds.length || assignees.some((participant) => !participant.active);
  if (hasInvalidAssignees || (executionOwner === "ai" && assigneeIds.length > 0)) {
    log.warn(
      {
        projectId: input.projectId,
        executionOwner,
        requestedAssigneeCount: assigneeIds.length,
        activeAssigneeCount: assignees.filter((participant) => participant.active).length,
      },
      "Rejected task creation ownership",
    );
    return undefined;
  }
  const position =
    input.position ??
    (() => {
      const maxPosition = getMaxBacklogPosition(input.projectId);
      return (maxPosition ?? 1000) + 100;
    })();

  return { id, now, executionOwner, assigneeIds, assignees, actor, position, resolvedPlanPath };
}

/**
 * The transaction body shared by legacy and keyed creation — inserts the task
 * row, human assignments, executor history, and the `task.created` audit event.
 * `auditMetadata` extends the audit metadata (keyed admission records the intake
 * identity there, §7.5); legacy calls keep the original `{ownershipRevision: 0}`.
 */
export function insertTaskWithOwnershipRows(
  tx: TaskTx,
  input: CreateTaskInsertInput,
  prepared: PreparedTaskCreation,
  auditMetadata: Record<string, unknown> = { ownershipRevision: 0 },
): void {
  const { id, now, executionOwner, assignees, actor, position, resolvedPlanPath } = prepared;
  const values: NewTaskRow = {
    id,
    projectId: input.projectId,
    title: input.title,
    description: input.description,
    attachments: JSON.stringify(input.attachments ?? []),
    priority: input.priority,
    autoMode: input.autoMode,
    executionOwner,
    ownershipRevision: 0,
    isFix: input.isFix,
    plannerMode: input.plannerMode,
    planPath: resolvedPlanPath,
    planDocs: input.planDocs,
    planTests: input.planTests,
    skipReview: input.skipReview,
    useSubagents: input.useSubagents,
    runPlanImprove: input.runPlanImprove,
    runPostVerify: input.runPostVerify,
    autoQa: input.autoQa,
    maxReviewIterations: input.maxReviewIterations,
    paused: input.paused,
    runtimeProfileId: input.runtimeProfileId ?? null,
    modelOverride: input.modelOverride ?? null,
    runtimeOptionsJson:
      input.runtimeOptions === undefined ? null : JSON.stringify(input.runtimeOptions),
    roadmapAlias: input.roadmapAlias ?? null,
    tags: JSON.stringify(input.tags ?? []),
    scheduledAt: input.scheduledAt ?? null,
    reworkRequested: false,
    manualReviewRequired: false,
    status: "backlog",
    position,
    lastHeartbeatAt: now,
    createdAt: now,
    updatedAt: now,
  };
  tx.insert(tasks).values(values).run();
  if (executionOwner === "human" && assignees.length > 0) {
    tx.insert(taskAssignments)
      .values(
        assignees.map((assignee) => ({
          taskId: id,
          participantId: assignee.participantId,
          assignedByKind: actor.kind,
          assignedById: actor.id,
          assignedByDisplayNameSnapshot: actor.displayNameSnapshot,
          createdAt: now,
        })),
      )
      .run();
  }
  tx.insert(taskExecutorHistory)
    .values({
      id: crypto.randomUUID(),
      taskId: id,
      taskTitleSnapshot: input.title,
      ownershipRevision: 0,
      executionOwner,
      assigneesSnapshotJson: JSON.stringify(executionOwner === "human" ? assignees : []),
      statusSnapshot: "backlog",
      actorKind: actor.kind,
      actorId: actor.id,
      actorDisplayNameSnapshot: actor.displayNameSnapshot,
      reason: "task_created",
      createdAt: now,
    })
    .run();
  tx.insert(auditEvents)
    .values(
      createAuditEventValues({
        action: "task.created",
        entityType: "task",
        entityId: id,
        taskId: id,
        taskTitleSnapshot: input.title,
        executionOwnerSnapshot: executionOwner,
        assigneesSnapshot: executionOwner === "human" ? assignees : [],
        statusSnapshot: "backlog",
        actor,
        metadata: auditMetadata,
        createdAt: now,
      }),
    )
    .run();
}

function readTaskRowById(id: string): TaskRow | undefined {
  return getDb().select().from(tasks).where(eq(tasks.id, id)).get();
}

export interface TaskIntakeBindingInput {
  /** Canonical `principalKind|principalId|projectId|requestId` (§7.4 encoding). */
  dedupKey: string;
  projectId: string;
  principalKind: "participant" | "internal";
  principalId: string;
  /** Namespaced `pid:cid` request id, ≤ 193 chars (§7.4). */
  requestId: string;
  /** Server-computed frozen client-content digest (§7.3). */
  payloadDigest: string;
  /** Server-derived admission channel — never client-claimed. */
  source: string;
}

export type CreateTaskWithIntakeBindingResult =
  | { outcome: "created"; task: TaskRow }
  | { outcome: "replayed"; task: TaskRow | null; binding: TaskIntakeBindingRow }
  | { outcome: "conflict"; binding: TaskIntakeBindingRow }
  | {
      outcome: "rejected_first_admission";
      rejection: IntakeFirstAdmissionRejection;
    };

/**
 * Structured first-admission rejection returned by a `prepareFirstAdmission`
 * hook (R7). The admission seam never inspects `status` or `body` — it returns
 * the rejection verbatim to the caller alongside the zero-write guarantee
 * (`rejected_first_admission`). `status` is the HTTP status the caller must
 * answer with (never 2xx); `body` is the structured JSON payload (`error`,
 * `code`, optional `fieldErrors`).
 */
export interface IntakeFirstAdmissionRejection {
  status: number;
  body: Record<string, unknown>;
}

export interface CreateTaskWithIntakeBindingOptions {
  /**
   * Mutable CREATION-ONLY eligibility and creation-input resolution (R7),
   * invoked lazily at the binding-miss point INSIDE the admission transaction —
   * only after the durable binding for this request ID has already failed to
   * resolve. Runtime-profile validity, project existence, and project-config
   * default resolution belong here: an originally valid request replayed after
   * its profile was disabled/deleted/re-scoped or its project was deleted must
   * resolve its existing binding (replay/conflict/tombstone), never be vetoed
   * by mutable creation-only state — exactly as the R3 ordering deferred
   * assignee liveness into `prepareTaskCreation`. Return
   * `{ ok: false, rejection }` to refuse the FIRST admission with zero writes;
   * return `{ ok: true, input }` with the fully resolved creation input to
   * insert (that input replaces the raw `input` argument for this admission).
   * Never consulted for a binding hit, and never invoked a second time for the
   * same admission.
   */
  prepareFirstAdmission?: (
    rawInput: CreateTaskInsertInput,
  ) =>
    | { ok: true; input: CreateTaskInsertInput }
    | { ok: false; rejection: IntakeFirstAdmissionRejection };
}

/**
 * Extended better-sqlite3 result codes of the uniqueness-constraint family —
 * the only failures the cross-connection reconciliation below is for (a
 * competing writer committed the same unique value first). The installed
 * driver reports the *extended* code on `error.code`
 * (`SQLITE_CONSTRAINT_PRIMARYKEY` for the binding primary key,
 * `SQLITE_CONSTRAINT_UNIQUE` for a unique index, as in `participants.ts`);
 * the bare base code `SQLITE_CONSTRAINT` is never thrown for a
 * statement-level failure. Other constraint members (`_NOTNULL`, `_FOREIGNKEY`,
 * `_CHECK`, `_TRIGGER`, …) are genuine data bugs, not races — they must
 * propagate, never be reconciled against a binding re-read.
 */
const SQLITE_UNIQUE_CONSTRAINT_CODES: ReadonlySet<string> = new Set([
  "SQLITE_CONSTRAINT_PRIMARYKEY",
  "SQLITE_CONSTRAINT_UNIQUE",
]);

/** Structured better-sqlite3 uniqueness-constraint signal — never message matching. */
export function isSqliteUniqueConstraintError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && SQLITE_UNIQUE_CONSTRAINT_CODES.has(code);
}

/**
 * Atomically admit a keyed intake payload (§7.2): ONE better-sqlite3 transaction
 * that either (a) resolves an existing binding — digest match → the original task
 * live (any status, terminal included: replay never restarts it) or a tombstone
 * when the task row is gone, digest mismatch → conflict with zero writes — or
 * (b) inserts the task and the binding together. Binding resolution precedes ALL
 * mutable creation-only eligibility and configuration IO (R3 + R7): an assignee
 * who became inactive AFTER admission can never veto the replay/conflict/tombstone
 * resolution of an already-durable request, and neither can a runtime profile
 * disabled/deleted/re-scoped or a deleted project — those are resolved lazily by
 * the caller's `prepareFirstAdmission` hook at the binding-miss point inside this
 * same transaction; the full eligibility still applies to every genuine first
 * admission (`rejected_first_admission` / `undefined`, zero writes). A
 * uniqueness-constraint failure on the binding insert
 * (`SQLITE_CONSTRAINT_PRIMARYKEY` — the extended result code the installed
 * better-sqlite3 actually throws for the dedup primary key, never the bare base
 * code; `SQLITE_CONSTRAINT_UNIQUE` for a unique index — possible when a second
 * connection/process committed the same key between this transaction's read and
 * its write) rolls the transaction back and re-reads, so exactly one canonical
 * task survives a cross-connection race. Returns `undefined` only when ownership
 * validation rejects the insert — the caller answers 409 invalid_ownership and
 * nothing was written.
 */
export function createTaskWithIntakeBinding(
  input: CreateTaskInsertInput,
  binding: TaskIntakeBindingInput,
  options?: CreateTaskWithIntakeBindingOptions,
): CreateTaskWithIntakeBindingResult | undefined {
  const db = getDb();
  const auditMetadata = {
    ownershipRevision: 0,
    intake: {
      requestId: binding.requestId,
      digest: binding.payloadDigest,
      source: binding.source,
    },
  };

  type TxOutcome =
    | { kind: "created"; prepared: PreparedTaskCreation }
    | { kind: "ownership_rejected" }
    | { kind: "first_admission_rejected"; rejection: IntakeFirstAdmissionRejection }
    | { kind: "conflict"; binding: TaskIntakeBindingRow }
    | { kind: "replayed"; task: TaskRow | null; binding: TaskIntakeBindingRow };

  let outcome: TxOutcome;
  try {
    // BEGIN IMMEDIATE (§7.2): the admission transaction takes the write lock up
    // front, so a second connection/process racing the same dedup key blocks at
    // BEGIN and then reads the winner's committed binding (replay/conflict). A
    // deferred transaction would instead upgrade a stale read snapshot to a
    // write mid-transaction and fail with an unhandled SQLITE_BUSY snapshot
    // error — the replay/conflict resolution below would never run.
    outcome = db.transaction(
      (tx): TxOutcome => {
        const existing = tx
          .select()
          .from(taskIntakeBindings)
          .where(eq(taskIntakeBindings.dedupKey, binding.dedupKey))
          .get();
        if (existing) {
          if (existing.payloadDigest !== binding.payloadDigest) {
            log.warn(
              { dedupKey: binding.dedupKey, taskId: existing.taskId },
              "Keyed intake conflict: payload digest mismatch for known request id",
            );
            return { kind: "conflict", binding: existing };
          }
          const task = tx.select().from(tasks).where(eq(tasks.id, existing.taskId)).get();
          log.info(
            { dedupKey: binding.dedupKey, taskId: existing.taskId, taskPresent: Boolean(task) },
            "Keyed intake replay resolved to original binding",
          );
          return { kind: "replayed", task: task ?? null, binding: existing };
        }
        // Binding miss — a genuine first admission. Only here do the mutable
        // creation-only checks apply (R3 + R7 ordering): the replay/conflict/
        // tombstone resolution above already returned for every durable
        // request, so an assignee deactivated after admission, a runtime
        // profile disabled/deleted/re-scoped after admission, or a project
        // deleted after admission is never consulted for an existing binding.
        // The caller's hook resolves the creation-only eligibility (profile
        // validity, project existence) and the creation input (project-config
        // defaults); a structured rejection ends the transaction here with
        // zero writes.
        let admissionInput = input;
        if (options?.prepareFirstAdmission) {
          const prepared = options.prepareFirstAdmission(input);
          if (!prepared.ok) return { kind: "first_admission_rejected", rejection: prepared.rejection };
          admissionInput = prepared.input;
        }
        const created = prepareTaskCreation(admissionInput);
        if (!created) return { kind: "ownership_rejected" };
        insertTaskWithOwnershipRows(tx, admissionInput, created, auditMetadata);
        tx.insert(taskIntakeBindings)
          .values({
            dedupKey: binding.dedupKey,
            projectId: binding.projectId,
            principalKind: binding.principalKind,
            principalId: binding.principalId,
            requestId: binding.requestId,
            payloadDigest: binding.payloadDigest,
            taskId: created.id,
            source: binding.source,
          })
          .run();
        return { kind: "created", prepared: created };
      },
      { behavior: "immediate" },
    );
  } catch (error) {
    if (!isSqliteUniqueConstraintError(error)) throw error;
    // A concurrent connection/process committed the same dedup key before this
    // transaction's insert (defense in depth behind BEGIN IMMEDIATE); the
    // transaction (including our partial task insert) rolled back. Re-read the
    // winner and resolve as replay/conflict.
    const existing = db
      .select()
      .from(taskIntakeBindings)
      .where(eq(taskIntakeBindings.dedupKey, binding.dedupKey))
      .get();
    if (!existing) throw error;
    log.info(
      { dedupKey: binding.dedupKey, taskId: existing.taskId },
      "Keyed intake resolved after cross-connection constraint",
    );
    if (existing.payloadDigest !== binding.payloadDigest) {
      return { outcome: "conflict", binding: existing };
    }
    return {
      outcome: "replayed",
      task: readTaskRowById(existing.taskId) ?? null,
      binding: existing,
    };
  }

  switch (outcome.kind) {
    case "conflict":
      return { outcome: "conflict", binding: outcome.binding };
    case "replayed":
      return { outcome: "replayed", task: outcome.task, binding: outcome.binding };
    case "ownership_rejected":
      return undefined;
    case "first_admission_rejected":
      return { outcome: "rejected_first_admission", rejection: outcome.rejection };
    case "created": {
      const task = readTaskRowById(outcome.prepared.id);
      if (!task) {
        throw new Error(
          `Keyed intake admission committed task ${outcome.prepared.id} but the row is unreadable`,
        );
      }
      return { outcome: "created", task };
    }
  }
}
