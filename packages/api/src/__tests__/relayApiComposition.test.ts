// Relay ↔ API authenticated-compat composition proof (rework R2 — §9.3/M3
// compat probe + §7.5 keyed admission + §8.3 handover watch).
//
// Discriminates the R2 integration defect the isolated suites could not see:
// the REAL relay deliverer path (probeCompat inside runCycle, then deliverOne,
// then watchOne) is driven over real loopback HTTP against the REAL API auth
// stack — participantCors → participantAuth session resolution →
// participantRouteAuthorization → participantCsrf — mounting the REAL
// /agent/status router and the REAL keyed-admission POST /tasks, on
// task-private state (createTestDb, no production DB, no port beyond an
// ephemeral loopback listener, no provider call).
//
// Under PARTICIPANTS_MODE_ENABLED — the only mode in which the keyed branch
// admits — /agent/status is NOT a public path, so the unauthenticated probe
// the pre-R2 relay sent is answered 401; this suite proves the composition
// both ways. No /agent/status exemption, no public workload, no
// caller-supplied principal headers: the relay's existing configured service
// session cookie is the only credential added.

import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdaptorServer } from "@hono/node-server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { INTAKE_COMPAT_LEVEL, projects, taskIntakeBindings, tasks } from "@aif/shared";
import { createTestDb } from "@aif/shared/server";
import type { ParticipantApiEnv } from "../middleware/participantAuth.js";

const testDb = { current: createTestDb() };
const mockBroadcast = vi.fn();
const PARTICIPANT_COOKIE = "test_participant_session";
const ORIGIN = "http://localhost:5180";
const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const CLIENT_REQUEST_ID = "composition-1";
const WRITER_CREDENTIAL = "composition-writer-credential-0123456789abcdef";
const BRIDGE_PRINCIPAL = {
  fingerprint: "SHA256:composition-fingerprint",
  principalId: "bridge-principal",
  allowedProjects: [PROJECT_ID],
  maxRequestBytes: 65_536,
};

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

const { createParticipant, createParticipantSession, revokeParticipantSession } =
  await import("@aif/data");
const { participantCors } = await import("../middleware/participantCors.js");
const { participantAuth } = await import("../middleware/participantAuth.js");
const { participantRouteAuthorization } = await import("../middleware/requireRole.js");
const { participantCsrf } = await import("../middleware/csrf.js");
const { tasksRouter } = await import("../routes/tasks.js");
const { agentStatusRouter } = await import("../routes/agentStatus.js");

// The dependency-free relay modules, URL-imported from the API package tests
// (same precedent as packages/shared/src/__tests__/workstationIntakeRelay.test.ts).
const RELAY_ROOT = new URL("../../../../scripts/workstation/intake-relay/", import.meta.url);
const relayFile = (name: string) => fileURLToPath(new URL(name, RELAY_ROOT));
const { createSpool } = await import(relayFile("spool.mjs"));
const { sealEnvelope } = await import(relayFile("envelope.mjs"));
const { bindWriterSocket, createDeliverer, createWriterServer } = await import(
  relayFile("deliverer.mjs")
);
const { requestWriter } = await import(relayFile("submit.mjs"));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  testDb.current = createTestDb();
  testDb.current
    .insert(projects)
    .values({ id: PROJECT_ID, name: "Composition", rootPath: "/tmp/composition-project" })
    .run();
  mockBroadcast.mockReset();
  for (const key of Object.keys(envOverrides)) delete envOverrides[key];
  // Participants mode on — the only mode in which the keyed branch admits,
  // and the mode in which /agent/status is session-gated.
  envOverrides.PARTICIPANTS_MODE_ENABLED = true;
  envOverrides.PARTICIPANT_SESSION_COOKIE_NAME = PARTICIPANT_COOKIE;
  envOverrides.PARTICIPANT_ALLOWED_ORIGINS = [ORIGIN];
  envOverrides.INTERNAL_BROADCAST_TOKEN = "internal-secret";
});

interface CompositionHandles {
  url: string;
  /** Cookie headers as actually presented to each tracked request. */
  seen: { agentStatus: (string | undefined)[]; taskGet: (string | undefined)[] };
  postTaskBodies: string[];
  close: () => Promise<void>;
}

/** The composed app — real middleware chain, real routers — over real HTTP. */
function startComposedApp(): Promise<CompositionHandles> {
  const app = new Hono<ParticipantApiEnv>();
  const seen: CompositionHandles["seen"] = { agentStatus: [], taskGet: [] };
  const postTaskBodies: string[] = [];

  // The REAL global chain in index.ts order. trackApiLoad/requestLogger are
  // metrics/log noise, not auth — omitted; every auth-bearing middleware is
  // the production one. The observer middleware only records what the relay
  // actually presented; it never mutates the request.
  app.use("*", participantCors());
  app.use("*", async (c, next) => {
    const cookie = c.req.header("cookie");
    if (c.req.path === "/agent/status") seen.agentStatus.push(cookie);
    if (c.req.method === "GET" && /^\/tasks\/[^/]+$/.test(c.req.path)) seen.taskGet.push(cookie);
    if (c.req.method === "POST" && c.req.path === "/tasks") {
      postTaskBodies.push(await c.req.text());
    }
    await next();
  });
  app.use("*", participantAuth);
  app.use("*", participantRouteAuthorization());
  app.use("*", participantCsrf());
  app.route("/agent", agentStatusRouter);
  app.route("/tasks", tasksRouter);

  const server = createAdaptorServer({ fetch: app.fetch });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        seen,
        postTaskBodies,
        close: () =>
          new Promise((done) => {
            // createAdaptorServer's ServerType union includes Http2Server,
            // which has no closeAllConnections — this server is always HTTP.
            (server as Server).closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

async function createAuthenticatedParticipant(role: "admin" | "member" = "member") {
  const id = crypto.randomUUID();
  const result = await createParticipant({
    username: `composition-${id}`,
    displayName: `Composition ${id}`,
    password: "a sufficiently safe password",
    role,
  });
  if (!result.ok) throw new Error("participant creation failed");
  const session = createParticipantSession(result.participant.id, { ttlMs: 60_000 });
  if (!session) throw new Error("session creation failed");
  return { participant: result.participant, session };
}

interface RelayConfig {
  [key: string]: unknown;
  mode: string;
  spoolDir: string;
  socketPath: string;
  fencePath: string;
  sessionCookieName: string;
  origin: string;
  endpoint: string;
  intakeCompatLevel: number;
}

function relayConfig(dir: string, endpoint: string, overrides: Record<string, unknown> = {}) {
  return {
    mode: "deliver",
    spoolDir: join(dir, "spool"),
    socketPath: join(dir, "relay.sock"),
    fencePath: join(dir, "fence.active"),
    sessionCookieName: PARTICIPANT_COOKIE,
    origin: ORIGIN,
    endpoint,
    intakeCompatLevel: INTAKE_COMPAT_LEVEL,
    cycleMs: 50,
    retryMax: 3,
    retryBackoffMs: 10,
    handoverPollMax: 3,
    handoverPollBackoffMs: 10,
    ...overrides,
  } as RelayConfig;
}

// The relay modules are untyped .mjs (no-explicit-any is off project-wide).
function makeSpool(config: RelayConfig) {
  return (createSpool as any)({
    dir: config.spoolDir,
    maxEnvelopes: 100,
    maxBytes: 1024 * 1024,
  });
}

async function startWriter(config: RelayConfig, spool: any) {
  const writer = (createWriterServer as any)({
    config,
    spool,
    principalMap: new Map([[BRIDGE_PRINCIPAL.fingerprint, BRIDGE_PRINCIPAL]]),
    credential: WRITER_CREDENTIAL,
  });
  const bound = await (bindWriterSocket as any)({ server: writer, socketPath: config.socketPath });
  if (!bound.ok) throw new Error(`writer bind failed: ${bound.code}`);
  return writer;
}

function sealCompositionEnvelope(overrides: Record<string, unknown> = {}) {
  return (sealEnvelope as any)({
    input: {
      projectId: PROJECT_ID,
      title: "Composition intake task",
      description: "Delivered by the bridge relay over the authenticated compat path",
      priority: 2,
      clientRequestId: CLIENT_REQUEST_ID,
      ...overrides,
    },
    principal: BRIDGE_PRINCIPAL,
    principalKind: "participant",
    nowIso: "2026-11-01T12:00:00.000Z",
  });
}

type WriterReply = { ok: true } | { ok: false; code?: string };

async function retainViaWriter(
  config: RelayConfig,
  envelope: ReturnType<typeof sealCompositionEnvelope>,
) {
  const reply = (await (requestWriter as any)({
    socketPath: config.socketPath,
    credential: WRITER_CREDENTIAL,
    envelope,
  })) as WriterReply;
  if (!reply.ok) throw new Error(`retention refused: ${reply.code ?? "unknown"}`);
}

function recordingWake() {
  const triggers: string[] = [];
  return {
    triggers,
    engine: {
      trigger: async (reason: string) => {
        triggers.push(reason);
        return { fired: true, attempts: 1, reason };
      },
      reset: () => {},
      status: () => ({}),
    },
  };
}

function countTasks() {
  return testDb.current.select().from(tasks).all().length;
}

function countBindings() {
  return testDb.current.select().from(taskIntakeBindings).all().length;
}

async function waitFor(cond: () => boolean, timeoutMs = 15_000, stepMs = 25): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return cond();
}

interface PostedIntakeBody {
  projectId: string;
  intake?: { requestId: string };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("relay ↔ API authenticated compat composition (rework R2)", () => {
  it("401-gates GET /agent/status without a session (the pre-R2 unauthenticated probe can never pass)", async () => {
    const api = await startComposedApp();
    try {
      const res = await fetch(`${api.url}/agent/status`, {
        headers: { accept: "application/json" },
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe("authentication_required");
    } finally {
      await api.close();
    }
  });

  it("refuses to construct a deliver-mode deliverer without the service session (missing credentials fail closed by construction)", async () => {
    const api = await startComposedApp();
    const dir = mkdtempSync(join(tmpdir(), "relay-composition-"));
    tmpDirs.push(dir);
    try {
      expect(() =>
        (createDeliverer as any)({
          config: relayConfig(dir, api.url, { sessionToken: undefined, csrfToken: undefined }),
          spool: makeSpool(relayConfig(dir, api.url)),
          wake: null,
        }),
      ).toThrow(/session token/);
    } finally {
      await api.close();
    }
  });

  it("delivers one retained envelope to exactly one canonical admitted task through the authenticated probe", async () => {
    const api = await startComposedApp();
    const dir = mkdtempSync(join(tmpdir(), "relay-composition-"));
    tmpDirs.push(dir);
    const { session } = await createAuthenticatedParticipant("member");
    const config = relayConfig(dir, api.url, {
      sessionToken: session.token,
      csrfToken: session.csrfToken,
    });
    const spool = makeSpool(config);
    const writer = await startWriter(config, spool);
    const envelope = sealCompositionEnvelope();
    await retainViaWriter(config, envelope);
    const wake = recordingWake();
    const deliverer = (createDeliverer as any)({ config, spool, wake: wake.engine });

    try {
      // Cycle 1 — authenticated compat probe → keyed admission → watch state.
      await deliverer.runCycle();

      // The probe presented the relay's configured service session cookie —
      // the R2 discriminator; the pre-R2 probe sent no cookie at all.
      expect(api.seen.agentStatus).toEqual([`${PARTICIPANT_COOKIE}=${session.token}`]);
      expect(deliverer.state().lastProbe).toMatchObject({
        ok: true,
        reachable: true,
        level: INTAKE_COMPAT_LEVEL,
      });

      // Exactly one keyed POST, one canonical task, one binding — and the
      // binding preserves the envelope identity end-to-end.
      expect(api.postTaskBodies).toHaveLength(1);
      const posted = JSON.parse(api.postTaskBodies[0]) as PostedIntakeBody;
      expect(posted.projectId).toBe(PROJECT_ID);
      expect(posted.intake?.requestId).toBe(envelope.requestId);
      const taskRows = testDb.current.select().from(tasks).all();
      expect(taskRows).toHaveLength(1);
      expect(countBindings()).toBe(1);
      const bindings = testDb.current.select().from(taskIntakeBindings).all();
      expect(bindings[0].requestId).toBe(envelope.requestId);
      expect(bindings[0].payloadDigest).toBe(envelope.digest);
      const taskId = taskRows[0].id;

      // The envelope is admitted-unconfirmed with its identity unchanged.
      const admitted = spool.list().find((r: any) => r.dedupKey === envelope.dedupKey);
      expect(admitted.state).toBe("admitted");
      expect(admitted.taskId).toBe(taskId);
      expect(admitted.requestId).toBe(envelope.requestId);
      expect(admitted.digest).toBe(envelope.digest);
      expect(admitted.receipts.some((r: any) => r.kind === "admitted")).toBe(true);

      // The PC answered the probe and the POST — no pointless wake.
      expect(wake.triggers).toEqual([]);
      const broadcastTypes = mockBroadcast.mock.calls.map(
        (call) => (call[0] as { type: string }).type,
      );
      expect(broadcastTypes).toContain("task:created");

      // The handover watch polls within the SAME cycle that admitted (§8.3):
      // the REAL authenticated GET /tasks/:id ran, and found no pickup
      // evidence (backlog, unlocked). Every watch poll carried the session.
      expect(api.seen.taskGet.length).toBeGreaterThanOrEqual(1);
      for (const cookie of api.seen.taskGet) {
        expect(cookie).toBe(`${PARTICIPANT_COOKIE}=${session.token}`);
      }

      // Cycle 2 — after the watch backoff elapses, the poll repeats; still
      // exactly one task, no second POST (admitted work is never re-admitted).
      await new Promise((resolve) => setTimeout(resolve, 25));
      const second = await deliverer.runCycle();
      expect(second.watch[0].outcome).toBe("watch_pending");
      expect(api.postTaskBodies).toHaveLength(1);
      expect(countTasks()).toBe(1);
      expect(countBindings()).toBe(1);

      // The workload snapshot the probe reads reflects the
      // admitted-not-started task (§8.2) — same signal, same authenticated
      // route the probe just used.
      const status = await fetch(`${api.url}/agent/status`, {
        headers: { cookie: `${PARTICIPANT_COOKIE}=${session.token}` },
      });
      expect(status.status).toBe(200);
      const statusBody = (await status.json()) as { workload: { pendingCount: number } };
      expect(statusBody.workload.pendingCount).toBeGreaterThanOrEqual(1);
    } finally {
      await deliverer.stop();
      writer.close();
      await api.close();
    }
  });

  it("fails closed on an invalid session: zero admission effects and no wake, parked across cycles", async () => {
    const api = await startComposedApp();
    const dir = mkdtempSync(join(tmpdir(), "relay-composition-"));
    tmpDirs.push(dir);
    const config = relayConfig(dir, api.url, {
      sessionToken: "forged-session-token",
      csrfToken: "forged-csrf-token",
    });
    const spool = makeSpool(config);
    const writer = await startWriter(config, spool);
    const envelope = sealCompositionEnvelope();
    await retainViaWriter(config, envelope);
    const wake = recordingWake();
    const deliverer = (createDeliverer as any)({ config, spool, wake: wake.engine });

    try {
      await deliverer.runCycle();
      expect(deliverer.state().lastProbe).toMatchObject({
        ok: false,
        reachable: true,
        reason: "probe_status_401",
      });
      // Zero admission POST effects, zero new tasks, zero bindings.
      expect(api.postTaskBodies).toHaveLength(0);
      expect(countTasks()).toBe(0);
      expect(countBindings()).toBe(0);
      // An ANSWERED 401 is a reachable-but-blocked PC — no pointless wake.
      expect(wake.triggers).toEqual([]);
      // The envelope is truthfully parked, not lost or retried.
      const parked = spool.list().find((r: any) => r.dedupKey === envelope.dedupKey);
      expect(parked.state).toBe("hold_api_compat");
      expect(parked.receipts.some((r: any) => r.kind === "parked_hold_api_compat")).toBe(true);

      // A further cycle stays parked with zero additional admission effects.
      await deliverer.runCycle();
      expect(api.postTaskBodies).toHaveLength(0);
      expect(countTasks()).toBe(0);
      expect(countBindings()).toBe(0);
      expect(wake.triggers).toEqual([]);
    } finally {
      await deliverer.stop();
      writer.close();
      await api.close();
    }
  });

  it("fails closed on a revoked session and resumes the SAME envelope losslessly when authorization is restored", async () => {
    const api = await startComposedApp();
    const dir = mkdtempSync(join(tmpdir(), "relay-composition-"));
    tmpDirs.push(dir);
    const { participant, session: held } = await createAuthenticatedParticipant("member");
    const heldConfig = relayConfig(dir, api.url, {
      sessionToken: held.token,
      csrfToken: held.csrfToken,
    });
    const spool = makeSpool(heldConfig);
    const writer = await startWriter(heldConfig, spool);
    const envelope = sealCompositionEnvelope();
    await retainViaWriter(heldConfig, envelope);
    const identity = {
      requestId: envelope.requestId as string,
      dedupKey: envelope.dedupKey as string,
      digest: envelope.digest as string,
    };
    const wake = recordingWake();
    const heldDeliverer = (createDeliverer as any)({
      config: heldConfig,
      spool,
      wake: wake.engine,
    });

    try {
      // Revoke the relay service session, then cycle: answered 401 → parked.
      expect(revokeParticipantSession(held.token)).toBe(true);
      await heldDeliverer.runCycle();
      expect(heldDeliverer.state().lastProbe).toMatchObject({
        ok: false,
        reason: "probe_status_401",
      });
      expect(api.postTaskBodies).toHaveLength(0);
      expect(countTasks()).toBe(0);
      expect(countBindings()).toBe(0);
      expect(wake.triggers).toEqual([]);

      const parked = spool.list().find((r: any) => r.dedupKey === identity.dedupKey);
      expect(parked.state).toBe("hold_api_compat");
      expect(parked.requestId).toBe(identity.requestId);
      expect(parked.digest).toBe(identity.digest);

      // Restored authorization: a fresh existing-style session for the SAME
      // participant; a new deliverer over the SAME spool. hold_api_compat is
      // a mechanical hold — it auto-resumes when its condition clears.
      const restored = createParticipantSession(participant.id, { ttlMs: 60_000 });
      if (!restored) throw new Error("restored session creation failed");
      const resumedConfig = relayConfig(dir, api.url, {
        sessionToken: restored.token,
        csrfToken: restored.csrfToken,
      });
      const resumedDeliverer = (createDeliverer as any)({
        config: resumedConfig,
        spool,
        wake: wake.engine,
      });
      await resumedDeliverer.runCycle();

      expect(resumedDeliverer.state().lastProbe).toMatchObject({
        ok: true,
        level: INTAKE_COMPAT_LEVEL,
      });
      // Exactly one POST ever: the held envelope was delivered once, identity
      // intact, no duplicate task, no duplicate binding.
      expect(api.postTaskBodies).toHaveLength(1);
      const posted = JSON.parse(api.postTaskBodies[0]) as PostedIntakeBody;
      expect(posted.intake?.requestId).toBe(identity.requestId);
      const taskRows = testDb.current.select().from(tasks).all();
      expect(taskRows).toHaveLength(1);
      expect(countBindings()).toBe(1);
      const bindings = testDb.current.select().from(taskIntakeBindings).all();
      expect(bindings[0].requestId).toBe(identity.requestId);
      expect(bindings[0].payloadDigest).toBe(identity.digest);
      const resumed = spool.list().find((r: any) => r.dedupKey === identity.dedupKey);
      expect(resumed.state).toBe("admitted");
      expect(resumed.taskId).toBe(taskRows[0].id);
      expect(resumed.requestId).toBe(identity.requestId);
      expect(resumed.digest).toBe(identity.digest);
      expect(wake.triggers).toEqual([]);
      await resumedDeliverer.stop();
    } finally {
      await heldDeliverer.stop();
      writer.close();
      await api.close();
    }
  });

  // R8 rework — finding 230ed4d58111: the documented retain-first bootstrap
  // ("accept while fail-closed retain-only, enable delivery after owner
  // review") used to strand every pre-switch envelope forever — no code path
  // made a `retained` record a delivery candidate. This composition proof
  // drives the REAL deliver-mode startup (start() → restartScan promotion →
  // compat probe → keyed POST → binding) over real loopback HTTP against the
  // REAL API on file-backed durable retained state, asserting the ACTUAL task
  // identity and counts, and proving a true replay restart cannot create a
  // second task.
  it("promotes durable retain-only work to exactly one canonical task when deliver mode is enabled; a true replay restart cannot create a second task", async () => {
    const api = await startComposedApp();
    const dir = mkdtempSync(join(tmpdir(), "relay-composition-"));
    tmpDirs.push(dir);
    const { session } = await createAuthenticatedParticipant("member");
    // Phase 1 — retain-only acceptance (real writer IPC, real durable file):
    // the envelope is accepted while the relay is still fail-closed.
    const retainConfig = relayConfig(dir, api.url, { mode: "retain-only" });
    const spool = makeSpool(retainConfig);
    const writer = await startWriter(retainConfig, spool);
    const envelope = sealCompositionEnvelope();
    await retainViaWriter(retainConfig, envelope);
    const retained = spool.list().find((r: any) => r.dedupKey === envelope.dedupKey);
    expect(retained.state).toBe("retained");
    writer.close();

    // Phase 2 — the owner enables deliver mode: a REAL deliverer in deliver
    // mode starts over the SAME durable spool state.
    const deliverConfig = relayConfig(dir, api.url, {
      sessionToken: session.token,
      csrfToken: session.csrfToken,
    });
    const wake = recordingWake();
    const deliverer = (createDeliverer as any)({
      config: deliverConfig,
      spool: makeSpool(deliverConfig),
      wake: wake.engine,
    });
    const identity = {
      requestId: envelope.requestId as string,
      dedupKey: envelope.dedupKey as string,
      digest: envelope.digest as string,
    };
    try {
      deliverer.start();
      expect(
        await waitFor(() => {
          const record = spool.list().find((r: any) => r.dedupKey === identity.dedupKey);
          return record?.state === "admitted" || record?.state === "completed";
        }),
      ).toBe(true);
      await deliverer.stop();

      // Exactly one keyed POST ever → exactly one canonical task and one
      // binding, with the envelope identity preserved end-to-end.
      expect(api.postTaskBodies).toHaveLength(1);
      expect(countTasks()).toBe(1);
      expect(countBindings()).toBe(1);
      const taskRows = testDb.current.select().from(tasks).all();
      const bindings = testDb.current.select().from(taskIntakeBindings).all();
      expect(bindings[0].requestId).toBe(identity.requestId);
      expect(bindings[0].payloadDigest).toBe(identity.digest);
      expect(bindings[0].taskId).toBe(taskRows[0].id);
      const promoted = spool.list().find((r: any) => r.dedupKey === identity.dedupKey);
      const kinds = (promoted.receipts as Array<{ kind: string }>).map((r) => r.kind);
      expect(kinds).toContain("promoted_from_retained");
      expect(kinds).toContain("admitted");
      expect(promoted.taskId).toBe(taskRows[0].id);
      expect(promoted.requestId).toBe(identity.requestId);
      expect(promoted.digest).toBe(identity.digest);
      // The PC answered the POST — no pointless wake fired for the promotion.
      expect(wake.triggers).toEqual([]);

      // Phase 3 — a true restart in deliver mode re-POSTs the byte-identical
      // body; the REAL keyed admission resolves it as a replay of the SAME
      // original task. No second task, no second binding, no new record.
      const replayDeliverer = (createDeliverer as any)({
        config: deliverConfig,
        spool: makeSpool(deliverConfig),
        wake: wake.engine,
      });
      replayDeliverer.start();
      expect(await waitFor(() => api.postTaskBodies.length >= 2)).toBe(true);
      await replayDeliverer.stop();
      expect(api.postTaskBodies).toHaveLength(2);
      expect(api.postTaskBodies[1]).toBe(api.postTaskBodies[0]);
      expect(countTasks()).toBe(1);
      expect(countBindings()).toBe(1);
      const replayedBindings = testDb.current.select().from(taskIntakeBindings).all();
      expect(replayedBindings).toHaveLength(1);
      expect(replayedBindings[0].taskId).toBe(taskRows[0].id);
      expect(replayedBindings[0].requestId).toBe(identity.requestId);
      expect(replayedBindings[0].payloadDigest).toBe(identity.digest);
      expect(spool.list().filter((r: any) => r.dedupKey === identity.dedupKey)).toHaveLength(1);
    } finally {
      await deliverer.stop();
      await api.close();
    }
  });
});
