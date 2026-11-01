import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import {
  auditEvents,
  participants,
  projects,
  taskAssignments,
  taskExecutorHistory,
  taskIntakeBindings,
  tasks,
} from "@aif/shared";
import { createTestDb } from "@aif/shared/server";
import type { ParticipantApiEnv } from "../middleware/participantAuth.js";

const testDb = { current: createTestDb() };
const mockBroadcast = vi.fn();
const PARTICIPANT_COOKIE = "test_participant_session";
const ORIGIN = "http://localhost:5180";
const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const REQUEST_ID = "relay-svc:p2-nightly-intake-1";

/** Mutable env overrides read by the mocked getEnv — tests flip these to prove
 * the keyed digest never depends on environment defaults (M2). */
const envOverrides: Record<string, unknown> = {};

vi.mock("@aif/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared")>();
  const defaults = actual.validateEnv({});
  return {
    ...actual,
    getEnv: () => ({ ...defaults, ...envOverrides }),
  };
});

vi.mock("@aif/shared/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared/server")>();
  return {
    ...actual,
    getDb: () => testDb.current,
  };
});

vi.mock("../ws.js", () => ({
  broadcast: (...args: unknown[]) => mockBroadcast(...args),
}));

const {
  createParticipant,
  createParticipantSession,
  revokeParticipantSession,
  listDueScheduledTasks,
} = await import("@aif/data");
const { participantAuth } = await import("../middleware/participantAuth.js");
const { participantCsrf } = await import("../middleware/csrf.js");
const { participantRouteAuthorization } = await import("../middleware/requireRole.js");
const { tasksRouter } = await import("../routes/tasks.js");

function createApp() {
  const app = new Hono<ParticipantApiEnv>();
  app.use("*", participantAuth);
  app.use("*", participantRouteAuthorization());
  app.use("*", participantCsrf());
  app.route("/tasks", tasksRouter);
  return app;
}

async function createAuthenticatedParticipant(role: "admin" | "member" = "member") {
  const id = crypto.randomUUID();
  const result = await createParticipant({
    username: `relay-${id}`,
    displayName: `Relay ${id}`,
    password: "a sufficiently safe password",
    role,
  });
  if (!result.ok) throw new Error("participant creation failed");
  const session = createParticipantSession(result.participant.id, { ttlMs: 60_000 });
  if (!session) throw new Error("session creation failed");
  return { participant: result.participant, session };
}

function authHeaders(session: { token: string; csrfToken: string }, json = false) {
  return {
    cookie: `${PARTICIPANT_COOKIE}=${session.token}`,
    origin: ORIGIN,
    "x-csrf-token": session.csrfToken,
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

function keyedBody(overrides: Record<string, unknown> = {}) {
  return {
    projectId: PROJECT_ID,
    title: "Nightly intake task",
    description: "Delivered by the bridge relay",
    intake: { requestId: REQUEST_ID },
    ...overrides,
  };
}

function countTasks() {
  return testDb.current.select().from(tasks).all().length;
}

function countBindings() {
  return testDb.current.select().from(taskIntakeBindings).all().length;
}

function broadcastsOfType(type: string) {
  return mockBroadcast.mock.calls.filter((call) => (call[0] as { type: string }).type === type);
}

beforeEach(() => {
  testDb.current = createTestDb();
  testDb.current
    .insert(projects)
    .values({ id: PROJECT_ID, name: "Intake", rootPath: "/tmp/intake-project" })
    .run();
  mockBroadcast.mockReset();
  for (const key of Object.keys(envOverrides)) delete envOverrides[key];
  // Participants mode on by default; the disabled-mode test flips it explicitly.
  envOverrides.PARTICIPANTS_MODE_ENABLED = true;
  envOverrides.PARTICIPANT_SESSION_COOKIE_NAME = PARTICIPANT_COOKIE;
  envOverrides.PARTICIPANT_ALLOWED_ORIGINS = [ORIGIN];
  envOverrides.INTERNAL_BROADCAST_TOKEN = "internal-secret";
});

describe("POST /tasks keyed intake admission (§7.5)", () => {
  it("creates the canonical task with a binding row and legacy-parity broadcasts", async () => {
    const admin = await createAuthenticatedParticipant("admin");
    const app = createApp();

    const res = await app.request("/tasks", {
      method: "POST",
      headers: authHeaders(admin.session, true),
      body: JSON.stringify(keyedBody()),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      status: string;
      intake: { replayed: boolean; requestId: string; digest: string };
    };
    expect(body.status).toBe("backlog");
    expect(body.intake.replayed).toBe(false);
    expect(body.intake.requestId).toBe(REQUEST_ID);
    expect(body.intake.digest).toMatch(/^[0-9a-f]{64}$/);

    expect(countTasks()).toBe(1);
    expect(countBindings()).toBe(1);

    const binding = testDb.current.select().from(taskIntakeBindings).all()[0];
    expect(binding.taskId).toBe(body.id);
    // The principal is the VERIFIED session participant — never client-claimed.
    expect(binding.principalId).toBe(admin.participant.id);
    expect(binding.principalKind).toBe("participant");
    expect(binding.requestId).toBe(REQUEST_ID);
    expect(binding.payloadDigest).toBe(body.intake.digest);

    // Broadcasts mirror the legacy creation path.
    expect(broadcastsOfType("task:created")).toHaveLength(1);
    expect(broadcastsOfType("agent:wake")).toHaveLength(1);
  });

  it("binds a digest equal to the bridge relay mirror's digest of the same sparse raw body", async () => {
    // The API digests the schema-PARSED body; the relay digests the RAW client
    // body. For sparse bodies the two only agree because the canonicalization
    // fills the schema's static-constant defaults on both sides (independent
    // -review repair). This test is the live cross-boundary proof: a real
    // keyed admission through HTTP, compared against the dependency-free .mjs
    // mirror over the same bytes.
    const envelopeModule = (await import(
      fileURLToPath(
        new URL("../../../../scripts/workstation/intake-relay/envelope.mjs", import.meta.url),
      )
    )) as { computeIntakePayloadDigest: (payload: Record<string, unknown>) => string };

    const admin = await createAuthenticatedParticipant("admin");
    const app = createApp();
    const rawBody = {
      projectId: PROJECT_ID,
      title: "Sparse intake task",
      intake: { requestId: REQUEST_ID },
    };

    const res = await app.request("/tasks", {
      method: "POST",
      headers: authHeaders(admin.session, true),
      body: JSON.stringify(rawBody),
    });

    expect(res.status).toBe(201);
    const { intake } = (await res.json()) as { intake: { digest: string } };
    const binding = testDb.current.select().from(taskIntakeBindings).all()[0];
    expect(countBindings()).toBe(1);

    const { intake: _excluded, ...clientContent } = rawBody;
    const mirrorDigest = envelopeModule.computeIntakePayloadDigest(clientContent);
    expect(binding.payloadDigest).toBe(mirrorDigest);
    expect(intake.digest).toBe(mirrorDigest);
  });

  it("returns 422 intake_principal_unavailable with zero writes when participants mode is disabled", async () => {
    envOverrides.PARTICIPANTS_MODE_ENABLED = false;
    const admin = await createAuthenticatedParticipant("admin");
    const app = createApp();

    const res = await app.request("/tasks", {
      method: "POST",
      headers: authHeaders(admin.session, true),
      body: JSON.stringify(keyedBody()),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("intake_principal_unavailable");
    expect(countTasks()).toBe(0);
    expect(countBindings()).toBe(0);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it("rejects a revoked session with 401 before any write", async () => {
    const admin = await createAuthenticatedParticipant("admin");
    revokeParticipantSession(admin.session.token);
    const app = createApp();

    const res = await app.request("/tasks", {
      method: "POST",
      headers: authHeaders(admin.session, true),
      body: JSON.stringify(keyedBody()),
    });

    expect(res.status).toBe(401);
    expect(countTasks()).toBe(0);
    expect(countBindings()).toBe(0);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it("rejects client-supplied digest/principal fields inside intake (strict schema)", async () => {
    const admin = await createAuthenticatedParticipant("admin");
    const app = createApp();

    const res = await app.request("/tasks", {
      method: "POST",
      headers: authHeaders(admin.session, true),
      body: JSON.stringify(
        keyedBody({ intake: { requestId: REQUEST_ID, digest: "f".repeat(64) } }),
      ),
    });

    expect(res.status).toBe(400);
    expect(countTasks()).toBe(0);
    expect(countBindings()).toBe(0);
  });

  it("rejects non-empty attachments with 422 pre-write (round-1 R2)", async () => {
    const admin = await createAuthenticatedParticipant("admin");
    const app = createApp();

    const res = await app.request("/tasks", {
      method: "POST",
      headers: authHeaders(admin.session, true),
      body: JSON.stringify(
        keyedBody({
          attachments: [{ name: "notes.txt", mimeType: "text/plain", size: 3, content: "abc" }],
        }),
      ),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("intake_attachments_unavailable");
    expect(countTasks()).toBe(0);
    expect(countBindings()).toBe(0);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it("mirrors the legacy member self-assignment rule: a member cannot key a human task to someone else (403)", async () => {
    // Parity with the legacy branch (independent-review repair): the keyed
    // path must not become a trust bypass around the member authorization
    // rule. 403 = auth/config condition → relay hold_auth_config, no retry.
    const member = await createAuthenticatedParticipant("member");
    const other = await createAuthenticatedParticipant("admin");
    const app = createApp();

    const res = await app.request("/tasks", {
      method: "POST",
      headers: authHeaders(member.session, true),
      body: JSON.stringify(
        keyedBody({
          requestId: "relay-svc:p2-member-bypass-1",
          executionOwner: "human",
          assigneeIds: [other.participant.id],
        }),
      ),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("forbidden");
    expect(countTasks()).toBe(0);
    expect(countBindings()).toBe(0);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it("still lets a member key a human task assigned to themselves (positive parity)", async () => {
    const member = await createAuthenticatedParticipant("member");
    const app = createApp();

    const res = await app.request("/tasks", {
      method: "POST",
      headers: authHeaders(member.session, true),
      body: JSON.stringify(
        keyedBody({
          requestId: "relay-svc:p2-member-self-1",
          executionOwner: "human",
          assigneeIds: [member.participant.id],
        }),
      ),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; executionOwner: string };
    expect(body.executionOwner).toBe("human");
    expect(countTasks()).toBe(1);
    expect(countBindings()).toBe(1);
  });

  it("rejects request IDs outside the §7.4 identity bounds", async () => {
    const admin = await createAuthenticatedParticipant("admin");
    const app = createApp();

    for (const requestId of [
      "relay-svc:" + "a".repeat(129), // 129-char client part
      "relay-svc:has:two:colons", // extra separator
      "relay-svc:spaced id", // charset violation
      "relay-svc:unicodé", // charset violation
      "no-separator", // missing namespace
    ]) {
      const res = await app.request("/tasks", {
        method: "POST",
        headers: authHeaders(admin.session, true),
        body: JSON.stringify(keyedBody({ intake: { requestId } })),
      });
      expect(res.status).toBe(400);
    }
    expect(countTasks()).toBe(0);
    expect(countBindings()).toBe(0);
  });

  it("accepts the 193-char identity boundary (64-char principal part + ':' + 128-char client part)", async () => {
    const admin = await createAuthenticatedParticipant("admin");
    const app = createApp();
    const requestId = `${"p".repeat(64)}:${"c".repeat(128)}`;

    const res = await app.request("/tasks", {
      method: "POST",
      headers: authHeaders(admin.session, true),
      body: JSON.stringify(keyedBody({ intake: { requestId } })),
    });

    expect(res.status).toBe(201);
    expect(countTasks()).toBe(1);
    expect(countBindings()).toBe(1);
  });

  it("replays identical resubmits to the original task with no new rows and no broadcasts", async () => {
    const admin = await createAuthenticatedParticipant("admin");
    const app = createApp();
    const payload = JSON.stringify(keyedBody());

    const first = await app.request("/tasks", {
      method: "POST",
      headers: authHeaders(admin.session, true),
      body: payload,
    });
    expect(first.status).toBe(201);
    const created = (await first.json()) as { id: string };
    expect(broadcastsOfType("task:created")).toHaveLength(1);

    // Simulated commit-before-ACK loss: the client re-sends the byte-identical body.
    const second = await app.request("/tasks", {
      method: "POST",
      headers: authHeaders(admin.session, true),
      body: payload,
    });

    expect(second.status).toBe(200);
    const replay = (await second.json()) as {
      id: string;
      status: string;
      intake: { replayed: boolean };
    };
    expect(replay.id).toBe(created.id);
    expect(replay.intake.replayed).toBe(true);
    expect(countTasks()).toBe(1);
    expect(countBindings()).toBe(1);
    // Replay emits neither task:created nor agent:wake.
    expect(broadcastsOfType("task:created")).toHaveLength(1);
    expect(broadcastsOfType("agent:wake")).toHaveLength(1);

    // The replay is audited.
    const audits = testDb.current
      .select()
      .from(auditEvents)
      .all()
      .filter((event) => event.action === "task.intake_replayed");
    expect(audits).toHaveLength(1);
    expect(audits[0].taskId).toBe(created.id);
  });

  it("replays a terminal task without restarting it", async () => {
    const admin = await createAuthenticatedParticipant("admin");
    const app = createApp();

    const first = await app.request("/tasks", {
      method: "POST",
      headers: authHeaders(admin.session, true),
      body: JSON.stringify(keyedBody()),
    });
    const created = (await first.json()) as { id: string };
    testDb.current.update(tasks).set({ status: "done" }).where(eq(tasks.id, created.id)).run();
    mockBroadcast.mockClear();

    const replay = await app.request("/tasks", {
      method: "POST",
      headers: authHeaders(admin.session, true),
      body: JSON.stringify(keyedBody()),
    });

    expect(replay.status).toBe(200);
    const body = (await replay.json()) as { id: string; status: string };
    expect(body.id).toBe(created.id);
    expect(body.status).toBe("done");
    expect(countTasks()).toBe(1);
    expect(countBindings()).toBe(1);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it("returns 409 intake_conflict for the same request ID with different content and creates nothing", async () => {
    const admin = await createAuthenticatedParticipant("admin");
    const app = createApp();

    const first = await app.request("/tasks", {
      method: "POST",
      headers: authHeaders(admin.session, true),
      body: JSON.stringify(keyedBody()),
    });
    expect(first.status).toBe(201);
    mockBroadcast.mockClear();

    const conflict = await app.request("/tasks", {
      method: "POST",
      headers: authHeaders(admin.session, true),
      body: JSON.stringify(keyedBody({ title: "Different content entirely" })),
    });

    expect(conflict.status).toBe(409);
    const body = (await conflict.json()) as { code: string };
    expect(body.code).toBe("intake_conflict");
    expect(countTasks()).toBe(1);
    expect(countBindings()).toBe(1);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it("returns 410 intake_tombstone after the original task was deleted and never re-admits", async () => {
    const admin = await createAuthenticatedParticipant("admin");
    const app = createApp();

    const first = await app.request("/tasks", {
      method: "POST",
      headers: authHeaders(admin.session, true),
      body: JSON.stringify(keyedBody()),
    });
    const created = (await first.json()) as { id: string };
    testDb.current.delete(tasks).where(eq(tasks.id, created.id)).run();
    mockBroadcast.mockClear();

    const replay = await app.request("/tasks", {
      method: "POST",
      headers: authHeaders(admin.session, true),
      body: JSON.stringify(keyedBody()),
    });

    expect(replay.status).toBe(410);
    const body = (await replay.json()) as { code: string };
    expect(body.code).toBe("intake_tombstone");
    expect(countTasks()).toBe(0);
    expect(countBindings()).toBe(1);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });
});

describe("POST /tasks keyed ordering stability (M2, §7.5)", () => {
  it("admits a first delivery with a past scheduledAt and the due scheduler picks it up", async () => {
    const admin = await createAuthenticatedParticipant("admin");
    const app = createApp();
    const past = new Date(Date.now() - 3_600_000).toISOString();

    const res = await app.request("/tasks", {
      method: "POST",
      headers: authHeaders(admin.session, true),
      body: JSON.stringify(keyedBody({ scheduledAt: past })),
    });

    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; scheduledAt: string };
    expect(new Date(created.scheduledAt).getTime()).toBe(new Date(past).getTime());

    // The existing coordinator catch-up owns the overdue fire.
    const due = listDueScheduledTasks(new Date().toISOString());
    expect(due.some((task) => task.id === created.id)).toBe(true);
    expect(countTasks()).toBe(1);
    expect(countBindings()).toBe(1);
  });

  it("resolves the identical replay of a past-scheduled task despite the elapsed schedule", async () => {
    const admin = await createAuthenticatedParticipant("admin");
    const app = createApp();
    const payload = JSON.stringify(
      keyedBody({ scheduledAt: new Date(Date.now() - 60_000).toISOString() }),
    );

    const first = await app.request("/tasks", {
      method: "POST",
      headers: authHeaders(admin.session, true),
      body: payload,
    });
    expect(first.status).toBe(201);
    const created = (await first.json()) as { id: string };

    // The legacy schema would 400 this past timestamp — the binding lookup
    // must precede any time re-validation.
    const replay = await app.request("/tasks", {
      method: "POST",
      headers: authHeaders(admin.session, true),
      body: payload,
    });

    expect(replay.status).toBe(200);
    const body = (await replay.json()) as { id: string; intake: { replayed: boolean } };
    expect(body.id).toBe(created.id);
    expect(body.intake.replayed).toBe(true);
    expect(countTasks()).toBe(1);
    expect(countBindings()).toBe(1);
  });

  it("keeps the digest identical when env defaults flip between create and replay", async () => {
    const admin = await createAuthenticatedParticipant("admin");
    const app = createApp();
    const payload = JSON.stringify(keyedBody());

    envOverrides.AGENT_USE_SUBAGENTS = false;
    envOverrides.AGENT_MAX_REVIEW_ITERATIONS = 2;
    const first = await app.request("/tasks", {
      method: "POST",
      headers: authHeaders(admin.session, true),
      body: payload,
    });
    expect(first.status).toBe(201);
    const created = (await first.json()) as { id: string; useSubagents: boolean };

    envOverrides.AGENT_USE_SUBAGENTS = true;
    envOverrides.AGENT_MAX_REVIEW_ITERATIONS = 9;
    const replay = await app.request("/tasks", {
      method: "POST",
      headers: authHeaders(admin.session, true),
      body: payload,
    });

    expect(replay.status).toBe(200);
    const body = (await replay.json()) as { id: string };
    expect(body.id).toBe(created.id);
    expect(countTasks()).toBe(1);
    expect(countBindings()).toBe(1);
    // The created row still carries the env defaults that were live at admission.
    expect(created.useSubagents).toBe(false);
  });

  it("keeps the digest identical when the project's parallelEnabled flips between create and replay", async () => {
    // Route-level forcing (§7.5 step 3, M2): `parallelEnabled → plannerMode
    // "full"` happens AFTER the digest is frozen, so flipping the project
    // between create and replay must resolve a replay, never a conflict.
    const admin = await createAuthenticatedParticipant("admin");
    const app = createApp();
    const payload = JSON.stringify(keyedBody({ requestId: "relay-svc:p2-parallel-flip-1" }));

    const first = await app.request("/tasks", {
      method: "POST",
      headers: authHeaders(admin.session, true),
      body: payload,
    });
    expect(first.status).toBe(201);
    const created = (await first.json()) as { id: string; plannerMode: string };
    expect(created.plannerMode).toBe("fast");

    testDb.current
      .update(projects)
      .set({ parallelEnabled: true })
      .where(eq(projects.id, PROJECT_ID))
      .run();

    const replay = await app.request("/tasks", {
      method: "POST",
      headers: authHeaders(admin.session, true),
      body: payload,
    });

    expect(replay.status).toBe(200);
    const body = (await replay.json()) as { id: string; task?: { plannerMode?: string } };
    expect(body.id).toBe(created.id);
    expect(countTasks()).toBe(1);
    expect(countBindings()).toBe(1);
    // The original row keeps the plannerMode frozen at admission time.
    const stored = testDb.current.select().from(tasks).all()[0];
    expect(stored.plannerMode).toBe("fast");
  });

  it("rejects the same request ID with a different scheduledAt as a conflict", async () => {
    const admin = await createAuthenticatedParticipant("admin");
    const app = createApp();

    const first = await app.request("/tasks", {
      method: "POST",
      headers: authHeaders(admin.session, true),
      body: JSON.stringify(
        keyedBody({ scheduledAt: new Date(Date.now() + 3_600_000).toISOString() }),
      ),
    });
    expect(first.status).toBe(201);

    const conflict = await app.request("/tasks", {
      method: "POST",
      headers: authHeaders(admin.session, true),
      body: JSON.stringify(
        keyedBody({ scheduledAt: new Date(Date.now() + 7_200_000).toISOString() }),
      ),
    });

    expect(conflict.status).toBe(409);
    expect(countTasks()).toBe(1);
    expect(countBindings()).toBe(1);
  });

  it("keeps the legacy golden contract: POST without intake rejects a past scheduledAt with 400", async () => {
    const admin = await createAuthenticatedParticipant("admin");
    const app = createApp();
    const past = new Date(Date.now() - 60_000).toISOString();

    const res = await app.request("/tasks", {
      method: "POST",
      headers: authHeaders(admin.session, true),
      body: JSON.stringify({ projectId: PROJECT_ID, title: "Legacy past", scheduledAt: past }),
    });

    expect(res.status).toBe(400);
    expect(countTasks()).toBe(0);
    expect(countBindings()).toBe(0);
  });

  it("keeps legacy creation byte-identical: no intake block, env defaults applied, task created", async () => {
    const admin = await createAuthenticatedParticipant("admin");
    const app = createApp();

    const res = await app.request("/tasks", {
      method: "POST",
      headers: authHeaders(admin.session, true),
      body: JSON.stringify({ projectId: PROJECT_ID, title: "Legacy task", description: "d" }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; intake?: unknown };
    expect(body.intake).toBeUndefined();
    expect(countTasks()).toBe(1);
    expect(countBindings()).toBe(0);
    expect(broadcastsOfType("task:created")).toHaveLength(1);
    expect(broadcastsOfType("agent:wake")).toHaveLength(1);
  });

  it("returns 404 for keyed intake against a missing project without writing", async () => {
    const admin = await createAuthenticatedParticipant("admin");
    const app = createApp();

    const res = await app.request("/tasks", {
      method: "POST",
      headers: authHeaders(admin.session, true),
      body: JSON.stringify(keyedBody({ projectId: "00000000-0000-4000-8000-00000000dead" })),
    });

    expect(res.status).toBe(404);
    expect(countTasks()).toBe(0);
    expect(countBindings()).toBe(0);
  });
});

describe("POST /tasks keyed replay after mutable ownership change (R3)", () => {
  // Kickoff verify3: identical replay resolves the ORIGINAL canonical task even
  // after completion — for human-owned keyed tasks too. Assignee liveness is
  // mutable creation-only eligibility; deactivating ONLY the assignee (while
  // the principal and project authorization stay valid) must never veto the
  // replay, its conflict, or its tombstone resolution.
  async function createAssignee() {
    const result = await createParticipant({
      username: `assignee-${crypto.randomUUID()}`,
      displayName: "Assignee",
      password: "a sufficiently safe password",
      role: "member",
    });
    if (!result.ok) throw new Error("participant creation failed");
    return result.participant;
  }

  function deactivateAssignee(id: string): void {
    testDb.current
      .update(participants)
      .set({ active: false, deactivatedAt: new Date().toISOString() })
      .where(eq(participants.id, id))
      .run();
  }

  function humanKeyedBody(assigneeId: string, requestId = "relay-svc:p2-human-replay-1") {
    return keyedBody({
      intake: { requestId },
      executionOwner: "human",
      assigneeIds: [assigneeId],
    });
  }

  it("replays the identical human-owned request to the original task after only the assignee was deactivated", async () => {
    const admin = await createAuthenticatedParticipant("admin");
    const assignee = await createAssignee();
    const app = createApp();
    const payload = JSON.stringify(humanKeyedBody(assignee.id));

    const first = await app.request("/tasks", {
      method: "POST",
      headers: authHeaders(admin.session, true),
      body: payload,
    });
    expect(first.status).toBe(201);
    const created = (await first.json()) as { id: string; intake: { digest: string } };
    // A human-owned creation wakes nobody; one task:created only.
    expect(broadcastsOfType("task:created")).toHaveLength(1);
    expect(broadcastsOfType("agent:wake")).toHaveLength(0);

    deactivateAssignee(assignee.id);

    const replay = await app.request("/tasks", {
      method: "POST",
      headers: authHeaders(admin.session, true),
      body: payload,
    });

    expect(replay.status).toBe(200);
    const body = (await replay.json()) as {
      id: string;
      executionOwner: string;
      intake: { replayed: boolean };
    };
    expect(body.id).toBe(created.id);
    expect(body.intake.replayed).toBe(true);
    expect(body.executionOwner).toBe("human");
    // The durable binding still carries the exact original digest.
    const binding = testDb.current.select().from(taskIntakeBindings).all()[0];
    expect(binding.taskId).toBe(created.id);
    expect(binding.payloadDigest).toBe(created.intake.digest);

    // One task + one binding total; no restart broadcast; no new ownership mutation.
    expect(countTasks()).toBe(1);
    expect(countBindings()).toBe(1);
    expect(broadcastsOfType("task:created")).toHaveLength(1);
    expect(broadcastsOfType("agent:wake")).toHaveLength(0);
    const assignments = testDb.current.select().from(taskAssignments).all();
    expect(assignments).toHaveLength(1);
    expect(assignments[0]?.participantId).toBe(assignee.id);
    expect(testDb.current.select().from(taskExecutorHistory).all()).toHaveLength(1);
  });

  it("replays the terminal human-owned task after its assignee was deactivated", async () => {
    const admin = await createAuthenticatedParticipant("admin");
    const assignee = await createAssignee();
    const app = createApp();
    const payload = JSON.stringify(humanKeyedBody(assignee.id));

    const first = await app.request("/tasks", {
      method: "POST",
      headers: authHeaders(admin.session, true),
      body: payload,
    });
    expect(first.status).toBe(201);
    const created = (await first.json()) as { id: string };
    deactivateAssignee(assignee.id);
    testDb.current.update(tasks).set({ status: "done" }).where(eq(tasks.id, created.id)).run();
    mockBroadcast.mockClear();

    const replay = await app.request("/tasks", {
      method: "POST",
      headers: authHeaders(admin.session, true),
      body: payload,
    });

    expect(replay.status).toBe(200);
    const body = (await replay.json()) as { id: string; status: string };
    expect(body.id).toBe(created.id);
    expect(body.status).toBe("done");
    expect(countTasks()).toBe(1);
    expect(countBindings()).toBe(1);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it("returns the retained tombstone after the assignee was deactivated and never re-admits", async () => {
    const admin = await createAuthenticatedParticipant("admin");
    const assignee = await createAssignee();
    const app = createApp();
    const payload = JSON.stringify(humanKeyedBody(assignee.id));

    const first = await app.request("/tasks", {
      method: "POST",
      headers: authHeaders(admin.session, true),
      body: payload,
    });
    expect(first.status).toBe(201);
    const created = (await first.json()) as { id: string };
    deactivateAssignee(assignee.id);
    testDb.current.delete(tasks).where(eq(tasks.id, created.id)).run();
    mockBroadcast.mockClear();

    const replay = await app.request("/tasks", {
      method: "POST",
      headers: authHeaders(admin.session, true),
      body: payload,
    });

    expect(replay.status).toBe(410);
    const body = (await replay.json()) as { code: string };
    expect(body.code).toBe("intake_tombstone");
    expect(countTasks()).toBe(0);
    expect(countBindings()).toBe(1);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it("still rejects a NEW request ID with the now-inactive assignee and creates zero side effects", async () => {
    const admin = await createAuthenticatedParticipant("admin");
    const assignee = await createAssignee();
    const app = createApp();

    const first = await app.request("/tasks", {
      method: "POST",
      headers: authHeaders(admin.session, true),
      body: JSON.stringify(humanKeyedBody(assignee.id)),
    });
    expect(first.status).toBe(201);
    deactivateAssignee(assignee.id);
    mockBroadcast.mockClear();
    const auditsBefore = testDb.current.select().from(auditEvents).all().length;

    const rejected = await app.request("/tasks", {
      method: "POST",
      headers: authHeaders(admin.session, true),
      body: JSON.stringify(humanKeyedBody(assignee.id, "relay-svc:p2-human-after-deactivation-1")),
    });

    expect(rejected.status).toBe(409);
    const body = (await rejected.json()) as { code: string };
    expect(body.code).toBe("invalid_ownership");
    expect(countTasks()).toBe(1);
    expect(countBindings()).toBe(1);
    expect(testDb.current.select().from(auditEvents).all().length).toBe(auditsBefore);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it("resolves a digest conflict for the known request ID even after the assignee was deactivated", async () => {
    const admin = await createAuthenticatedParticipant("admin");
    const assignee = await createAssignee();
    const app = createApp();

    const first = await app.request("/tasks", {
      method: "POST",
      headers: authHeaders(admin.session, true),
      body: JSON.stringify(humanKeyedBody(assignee.id)),
    });
    expect(first.status).toBe(201);
    deactivateAssignee(assignee.id);
    mockBroadcast.mockClear();

    const conflict = await app.request("/tasks", {
      method: "POST",
      headers: authHeaders(admin.session, true),
      body: JSON.stringify(
        keyedBody({
          intake: { requestId: "relay-svc:p2-human-replay-1" },
          executionOwner: "human",
          assigneeIds: [assignee.id],
          title: "Different content entirely",
        }),
      ),
    });

    expect(conflict.status).toBe(409);
    const body = (await conflict.json()) as { code: string };
    expect(body.code).toBe("intake_conflict");
    expect(countTasks()).toBe(1);
    expect(countBindings()).toBe(1);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it("never grants replay access to a revoked session", async () => {
    const admin = await createAuthenticatedParticipant("admin");
    const app = createApp();
    const payload = JSON.stringify(keyedBody());

    const first = await app.request("/tasks", {
      method: "POST",
      headers: authHeaders(admin.session, true),
      body: payload,
    });
    expect(first.status).toBe(201);
    revokeParticipantSession(admin.session.token);
    mockBroadcast.mockClear();
    const auditsBefore = testDb.current.select().from(auditEvents).all().length;

    const replay = await app.request("/tasks", {
      method: "POST",
      headers: authHeaders(admin.session, true),
      body: payload,
    });

    expect(replay.status).toBe(401);
    expect(countTasks()).toBe(1);
    expect(countBindings()).toBe(1);
    expect(testDb.current.select().from(auditEvents).all().length).toBe(auditsBefore);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });
});
