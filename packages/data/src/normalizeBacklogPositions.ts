import { pathToFileURL } from "node:url";
import { and, asc, eq } from "drizzle-orm";
import { logger as createLogger, tasks } from "@aif/shared";
import { getDb } from "@aif/shared/server";

const log = createLogger("normalize-backlog-positions");
const NORMALIZED_POSITION_STEP = 100;

type BacklogTaskSnapshot = Pick<
  typeof tasks.$inferSelect,
  "id" | "projectId" | "title" | "position" | "createdAt"
>;

export interface BacklogPositionChange {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  currentPosition: number;
  normalizedPosition: number;
  changed: boolean;
}

export interface ProjectBacklogNormalizationPlan {
  projectId: string;
  taskCount: number;
  changedTaskCount: number;
  tasks: BacklogPositionChange[];
}

export interface BacklogNormalizationPlan {
  projectId: string | null;
  projectCount: number;
  taskCount: number;
  changedTaskCount: number;
  projects: ProjectBacklogNormalizationPlan[];
}

export interface NormalizeBacklogPositionsOptions {
  projectId?: string;
  apply?: boolean;
}

export interface BacklogNormalizationResult extends BacklogNormalizationPlan {
  applied: boolean;
  updatedTaskCount: number;
}

export interface NormalizeBacklogCliOptions extends NormalizeBacklogPositionsOptions {
  help: boolean;
}

function backlogWhereClause(projectId?: string) {
  if (projectId) {
    return and(eq(tasks.status, "backlog"), eq(tasks.projectId, projectId));
  }
  return eq(tasks.status, "backlog");
}

function listBacklogTasks(projectId?: string): BacklogTaskSnapshot[] {
  return getDb()
    .select({
      id: tasks.id,
      projectId: tasks.projectId,
      title: tasks.title,
      position: tasks.position,
      createdAt: tasks.createdAt,
    })
    .from(tasks)
    .where(backlogWhereClause(projectId))
    .orderBy(asc(tasks.projectId), asc(tasks.createdAt), asc(tasks.id))
    .all()
    .map((task) => ({
      ...task,
      position: Number(task.position),
    }));
}

function buildProjectPlans(backlogTasks: BacklogTaskSnapshot[]): ProjectBacklogNormalizationPlan[] {
  const byProject = new Map<string, BacklogTaskSnapshot[]>();
  for (const task of backlogTasks) {
    const tasksForProject = byProject.get(task.projectId);
    if (tasksForProject) {
      tasksForProject.push(task);
      continue;
    }
    byProject.set(task.projectId, [task]);
  }

  return [...byProject.entries()].map(([projectId, projectTasks]) => {
    const tasks = projectTasks.map((task, index) => {
      const normalizedPosition = (index + 1) * NORMALIZED_POSITION_STEP;
      return {
        id: task.id,
        projectId,
        title: task.title,
        createdAt: task.createdAt,
        currentPosition: task.position,
        normalizedPosition,
        changed: task.position !== normalizedPosition,
      };
    });

    return {
      projectId,
      taskCount: tasks.length,
      changedTaskCount: tasks.filter((task) => task.changed).length,
      tasks,
    };
  });
}

export function planBacklogPositionNormalization(
  options: NormalizeBacklogPositionsOptions = {},
): BacklogNormalizationPlan {
  const projectId = options.projectId ?? null;
  const projects = buildProjectPlans(listBacklogTasks(options.projectId));
  const taskCount = projects.reduce((total, project) => total + project.taskCount, 0);
  const changedTaskCount = projects.reduce((total, project) => total + project.changedTaskCount, 0);

  return {
    projectId,
    projectCount: projects.length,
    taskCount,
    changedTaskCount,
    projects,
  };
}

export function normalizeBacklogPositions(
  options: NormalizeBacklogPositionsOptions = {},
): BacklogNormalizationResult {
  const plan = planBacklogPositionNormalization(options);
  const changedTasks = plan.projects.flatMap((project) => project.tasks.filter((task) => task.changed));

  if (!options.apply || changedTasks.length === 0) {
    return {
      ...plan,
      applied: false,
      updatedTaskCount: 0,
    };
  }

  log.warn(
    {
      projectId: plan.projectId,
      changedTaskCount: changedTasks.length,
    },
    "Applying backlog normalization will overwrite any manual backlog order",
  );

  const updatedTaskCount = getDb().transaction((tx) => {
    let updatedTaskCount = 0;

    for (const task of changedTasks) {
      const result = tx
        .update(tasks)
        .set({ position: task.normalizedPosition })
        .where(
          and(
            eq(tasks.id, task.id),
            eq(tasks.projectId, task.projectId),
            eq(tasks.status, "backlog"),
          ),
        )
        .run();
      updatedTaskCount += result.changes;
    }

    return updatedTaskCount;
  });

  return {
    ...plan,
    applied: true,
    updatedTaskCount,
  };
}

export function parseNormalizeBacklogPositionsArgs(
  args: string[],
): NormalizeBacklogCliOptions {
  const options: NormalizeBacklogCliOptions = {
    apply: false,
    help: false,
  };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--apply") {
      options.apply = true;
      continue;
    }

    if (arg === "--dry-run") {
      options.apply = false;
      continue;
    }

    if (arg === "--project") {
      const projectId = args[index + 1];
      if (!projectId) {
        throw new Error("Missing value for --project");
      }
      options.projectId = projectId;
      index++;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printHelp(): void {
  process.stdout.write(`Usage: node --import tsx packages/data/src/normalizeBacklogPositions.ts [options]

Options:
  --project <id>  Limit normalization to one project
  --apply         Rewrite backlog positions in place
  --dry-run       Preview only (default)
  --help          Show this message
`);
}

function logNormalizationResult(result: BacklogNormalizationResult): void {
  if (result.projectCount === 0) {
    log.info(
      {
        projectId: result.projectId,
        applied: result.applied,
      },
      "No backlog tasks matched the normalization scope",
    );
    return;
  }

  for (const project of result.projects) {
    log.info(
      {
        projectId: project.projectId,
        taskCount: project.taskCount,
        changedTaskCount: project.changedTaskCount,
        changes: project.tasks
          .filter((task) => task.changed)
          .map((task) => ({
            id: task.id,
            title: task.title,
            currentPosition: task.currentPosition,
            normalizedPosition: task.normalizedPosition,
            createdAt: task.createdAt,
          })),
      },
      result.applied ? "Project backlog positions normalized" : "Project backlog normalization preview",
    );
  }

  log.info(
    {
      projectId: result.projectId,
      projectCount: result.projectCount,
      taskCount: result.taskCount,
      changedTaskCount: result.changedTaskCount,
      updatedTaskCount: result.updatedTaskCount,
      mode: result.applied ? "apply" : "dry-run",
    },
    result.applied ? "Backlog normalization complete" : "Backlog normalization preview ready",
  );
}

export async function runNormalizeBacklogPositionsCli(args: string[]): Promise<number> {
  try {
    const options = parseNormalizeBacklogPositionsArgs(args);
    if (options.help) {
      printHelp();
      return 0;
    }

    const result = normalizeBacklogPositions(options);
    logNormalizationResult(result);
    return 0;
  } catch (error) {
    log.error({ err: error }, "Backlog normalization failed");
    return 1;
  }
}

const entryScript = process.argv[1];

if (entryScript && import.meta.url === pathToFileURL(entryScript).href) {
  const exitCode = await runNormalizeBacklogPositionsCli(process.argv.slice(2));
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}
