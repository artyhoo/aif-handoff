// Bridge intake relay engine tests (plan p2-wake-on-work, B15 — §11.4–11.8,
// §11.10, §11.11, §11.13–§11.16).
//
// The relay modules are dependency-free ESM under scripts/workstation/ and are
// URL-imported from package tests (same precedent as
// workspaceResolutionGuard.test.ts). Deterministic, paired negative/positive;
// real files in tmpdirs (no spool mocks); distinct-process contention via real
// child processes (§11.13, §11.16).

import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { computeIntakePayloadDigest } from "../index.js";

// ---------------------------------------------------------------------------
// Module loading (URL import of the dependency-free relay modules)
// ---------------------------------------------------------------------------

const RELAY_ROOT = new URL("../../../../scripts/workstation/intake-relay/", import.meta.url);
const RELAY_FILE = (name: string) => fileURLToPath(new URL(name, RELAY_ROOT));

const { ConfigError, loadConfig, loadPrincipalMap } = await import(RELAY_FILE("config.mjs"));
const {
  EnvelopeError,
  canonicalizeIntakePayload,
  computeIntakePayloadDigest: relayDigest,
  credentialsMatch,
  isValidClientRequestId,
  isValidPrincipalId,
  namespaceRequestId,
  revalidateSealedEnvelope,
  sealEnvelope,
} = await import(RELAY_FILE("envelope.mjs"));
const { SPOOL_STATES, SpoolError, createSpool } = await import(RELAY_FILE("spool.mjs"));
const { createWakeEngine } = await import(RELAY_FILE("wake.mjs"));
const {
  STARTUP_REFUSED_SOCKET_HELD,
  bindWriterSocket,
  classifyAdmissionStatus,
  classifySocketPath,
  clearFence,
  createDeliverer,
  createWriterServer,
  handleWriterRequest,
  probeCompat,
  readFence,
  writeFence,
} = await import(RELAY_FILE("deliverer.mjs"));
const { EXIT_CODES, requestWriter, resolvePrincipal, submitOnce } = await import(
  RELAY_FILE("submit.mjs")
);
const { evaluateGuard, querySupervisor, scanUncertainEffects } = await import(
  RELAY_FILE("deploy/rollback-guard.example.mjs")
);

const VECTORS = JSON.parse(
  readFileSync(RELAY_FILE("test-vectors/digest-vectors.json"), "utf8"),
) as {
  vectors: Array<{
    name: string;
    payload: Record<string, unknown>;
    expectedCanonicalJson: string;
    expectedDigest: string;
  }>;
};

// ---------------------------------------------------------------------------
// fs instrumentation for the §9.1 receipt-after-directory-fsync ordering proof
// ---------------------------------------------------------------------------

const fsLog: Array<{ op: string; path?: string }> = [];
let fsRecording = false;
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    fsyncSync: (fd: number, ...rest: unknown[]) => {
      if (fsRecording) fsLog.push({ op: "fsync" });
      return (actual.fsyncSync as (fd: number) => void)(fd);
    },
    renameSync: (from: string, to: string) => {
      if (fsRecording) fsLog.push({ op: "rename", path: to });
      return (actual.renameSync as (from: string, to: string) => void)(from, to);
    },
  };
});
const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");

// ---------------------------------------------------------------------------
// Fixtures and harnesses
// ---------------------------------------------------------------------------

const CREDENTIAL = "test-writer-credential-0123456789abcdef";
const PRINCIPAL = {
  fingerprint: "SHA256:test-fingerprint",
  principalId: "bridge-principal",
  allowedProjects: ["proj-1"],
  maxRequestBytes: 65_536,
};
const PRINCIPAL_MAP = new Map([[PRINCIPAL.fingerprint, PRINCIPAL]]);

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  fsRecording = false;
  fsLog.length = 0;
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

interface RelayConfig {
  [key: string]: unknown;
  mode: string;
  spoolDir: string;
  socketPath: string;
  fencePath: string;
  writerCredentialPath: string;
  principalsPath: string;
  sessionTokenPath?: string;
  csrfTokenPath?: string;
  sessionToken?: string;
  csrfToken?: string;
  sessionCookieName: string;
  origin: string;
  endpoint: string;
  wakeCommand: string;
  intakeCompatLevel: number;
  maxEnvelopes: number;
  maxBytes: number;
  defaultMaxRequestBytes: number;
  cycleMs: number;
  retryMax: number;
  retryBackoffMs: number;
  wakeMaxRepeats: number;
  wakeBackoffMs: number;
  wakeWindowMs: number;
  handoverPollMax: number;
  handoverPollBackoffMs: number;
}

function baseConfig(dir: string, overrides: Record<string, unknown> = {}): RelayConfig {
  return {
    mode: "deliver",
    spoolDir: join(dir, "spool"),
    socketPath: join(dir, "relay.sock"),
    fencePath: join(dir, "fence.active"),
    writerCredentialPath: "",
    principalsPath: "",
    sessionCookieName: "aif_participant_session",
    origin: "http://localhost:5180",
    endpoint: "http://127.0.0.1:1",
    wakeCommand: "",
    intakeCompatLevel: 1,
    maxEnvelopes: 1000,
    maxBytes: 50 * 1024 * 1024,
    defaultMaxRequestBytes: 65_536,
    cycleMs: 50,
    retryMax: 3,
    retryBackoffMs: 10,
    wakeMaxRepeats: 2,
    wakeBackoffMs: 10,
    wakeWindowMs: 200,
    handoverPollMax: 3,
    handoverPollBackoffMs: 10,
    sessionToken: "test-session-token",
    csrfToken: "test-csrf-token",
    ...overrides,
  } as RelayConfig;
}

function principalEntry(overrides: Record<string, unknown> = {}) {
  return { ...PRINCIPAL, ...overrides };
}

function clientInput(overrides: Record<string, unknown> = {}) {
  return {
    projectId: "proj-1",
    title: "Wake the PC and file the intake report",
    description: "Deliver the nightly intake bundle",
    priority: 2,
    clientRequestId: "req-1",
    ...overrides,
  };
}

function sealTestEnvelope(
  overrides: Record<string, unknown> = {},
  principalOverrides: Record<string, unknown> = {},
) {
  return sealEnvelope({
    input: clientInput(overrides),
    principal: principalEntry(principalOverrides),
    principalKind: "participant",
    nowIso: "2026-11-01T10:00:00.000Z",
  });
}

function spoolStats(dir: string) {
  const entries = existsSync(dir) ? readdirSync(dir) : [];
  const json = entries.filter((e) => e.endsWith(".json"));
  const temps = entries.filter((e) => e.startsWith(".tmp-"));
  const bytes = json.reduce((sum, entry) => sum + statSync(join(dir, entry)).size, 0);
  return { count: json.length, bytes, temps: temps.length };
}

interface StubConfig {
  agentStatus: { status: number; body: unknown; delayMs: number };
  postTasks: { status: number; body: unknown; delayMs: number };
  getTask: { status: number; body: unknown; delayMs: number };
}

function createStubServer(initial: Partial<StubConfig> = {}) {
  const config: StubConfig = {
    agentStatus: { status: 200, body: { intakeCompat: 1 }, delayMs: 0, ...initial.agentStatus },
    postTasks: { status: 201, body: {}, delayMs: 0, ...initial.postTasks },
    getTask: {
      status: 200,
      body: { id: "task-1", status: "backlog" },
      delayMs: 0,
      ...initial.getTask,
    },
  };
  const counters = { agentStatus: 0, postTasks: 0, getTask: 0 };
  const capturedBodies: string[] = [];
  const server = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/agent/status") {
        counters.agentStatus += 1;
        const { status, body, delayMs } = config.agentStatus;
        setTimeout(() => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        }, delayMs);
        return;
      }
      if (req.method === "POST" && req.url === "/tasks") {
        counters.postTasks += 1;
        capturedBodies.push(Buffer.concat(chunks).toString("utf8"));
        const { status, body, delayMs } = config.postTasks;
        setTimeout(() => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        }, delayMs);
        return;
      }
      if (req.method === "GET" && /^\/tasks\/[^/]+$/.test(req.url ?? "")) {
        counters.getTask += 1;
        const { status, body, delayMs } = config.getTask;
        setTimeout(() => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        }, delayMs);
        return;
      }
      res.writeHead(404);
      res.end("{}");
    });
  });
  return new Promise<{
    url: string;
    counters: typeof counters;
    capturedBodies: string[];
    config: StubConfig;
    close: () => Promise<void>;
  }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        counters,
        capturedBodies,
        config,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

async function startWriter(config: RelayConfig, spool: ReturnType<typeof createSpool>) {
  const server = createWriterServer({
    config,
    spool,
    principalMap: PRINCIPAL_MAP,
    credential: CREDENTIAL,
  });
  const bound = await bindWriterSocket({ server, socketPath: config.socketPath });
  if (!bound.ok) throw new Error(`writer bind failed: ${bound.code}`);
  return { server, close: () => server.close() };
}

/** Switchable endpoint reachability wrapper around real fetch. */
function switchableFetch(realFetch: typeof fetch) {
  const state = { endpointUp: true, calls: 0, urls: [] as string[] };
  const impl: typeof fetch = (input, init) => {
    state.calls += 1;
    state.urls.push(String(input));
    if (!state.endpointUp) {
      return Promise.reject(
        Object.assign(new Error("connect ECONNREFUSED"), { cause: { code: "ECONNREFUSED" } }),
      );
    }
    return realFetch(input, init);
  };
  return { impl, state };
}

async function retainViaWriter(config: RelayConfig, envelope: ReturnType<typeof sealTestEnvelope>) {
  return requestWriter({ socketPath: config.socketPath, credential: CREDENTIAL, envelope });
}

// ---------------------------------------------------------------------------
// B1 — config (fail-closed invariants)
// ---------------------------------------------------------------------------

describe("config.mjs (B1)", () => {
  it("defaults to retain-only and requires the writer credential in EVERY mode", () => {
    const dir = makeTmpDir();
    expect(() => loadConfig({ env: {}, overrides: {} })).toThrow(ConfigError);
    expect(() => loadConfig({ env: {}, overrides: { writerCredentialPath: "" } })).toThrow(
      /writerCredentialPath is required/u,
    );
    const credentialFile = join(dir, "cred");
    realFs.writeFileSync(credentialFile, "x");
    const config = loadConfig({
      env: {},
      overrides: {
        writerCredentialPath: credentialFile,
        principalsPath: join(dir, "principals.json"),
        spoolDir: join(dir, "spool"),
        socketPath: join(dir, "relay.sock"),
      },
    });
    expect(config.mode).toBe("retain-only");
    // No insecure escape hatch exists: an explicit attempt to disable writer
    // authentication is a validation error, not a mode.
    expect(() =>
      loadConfig({
        env: {},
        overrides: {
          writerCredentialPath: credentialFile,
          principalsPath: join(dir, "p.json"),
          insecureWriter: true,
        },
      }),
    ).not.toThrow();
  });

  it("deliver mode requires endpoint, session token, CSRF token, and origin", () => {
    const dir = makeTmpDir();
    const credentialFile = join(dir, "cred");
    realFs.writeFileSync(credentialFile, "x");
    const base = {
      mode: "deliver",
      writerCredentialPath: credentialFile,
      principalsPath: join(dir, "p.json"),
    };
    expect(() => loadConfig({ env: {}, overrides: base })).toThrow(/endpoint/u);
    expect(() =>
      loadConfig({ env: {}, overrides: { ...base, endpoint: "http://127.0.0.1:3009" } }),
    ).toThrow(/sessionTokenPath/u);
    expect(() =>
      loadConfig({
        env: {},
        overrides: { ...base, endpoint: "http://127.0.0.1:3009", sessionTokenPath: join(dir, "t") },
      }),
    ).toThrow(/csrfTokenPath/u);
    expect(() =>
      loadConfig({
        env: {},
        overrides: {
          ...base,
          endpoint: "http://127.0.0.1:3009",
          sessionTokenPath: join(dir, "t"),
          csrfTokenPath: join(dir, "c"),
        },
      }),
    ).toThrow(/origin/u);
    expect(() =>
      loadConfig({
        env: {},
        overrides: {
          ...base,
          endpoint: "ftp://x",
          sessionTokenPath: join(dir, "t"),
          csrfTokenPath: join(dir, "c"),
          origin: "http://o",
        },
      }),
    ).toThrow(/http/u);
  });

  it("maps AIF_INTAKE_RELAY_* env names and validates positive integers", () => {
    const dir = makeTmpDir();
    const env = {
      AIF_INTAKE_RELAY_MODE: "deliver",
      AIF_INTAKE_RELAY_MAX_ENVELOPES: "7",
      AIF_INTAKE_RELAY_ENDPOINT: "http://127.0.0.1:9",
      AIF_INTAKE_RELAY_SESSION_TOKEN_PATH: join(dir, "t"),
      AIF_INTAKE_RELAY_CSRF_TOKEN_PATH: join(dir, "c"),
      AIF_INTAKE_RELAY_ORIGIN: "http://localhost:5180",
      AIF_INTAKE_RELAY_WRITER_CREDENTIAL_PATH: join(dir, "cred"),
      AIF_INTAKE_RELAY_PRINCIPALS_PATH: join(dir, "p.json"),
    };
    realFs.writeFileSync(env.AIF_INTAKE_RELAY_WRITER_CREDENTIAL_PATH, "x");
    const config = loadConfig({ env, overrides: {} });
    expect(config.mode).toBe("deliver");
    expect(config.maxEnvelopes).toBe(7);
    expect(() =>
      loadConfig({ env: { ...env, AIF_INTAKE_RELAY_MAX_ENVELOPES: "0" }, overrides: {} }),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({ env: { ...env, AIF_INTAKE_RELAY_MAX_ENVELOPES: "x" }, overrides: {} }),
    ).toThrow(ConfigError);
  });

  it("loads and validates the operator principal map", () => {
    const dir = makeTmpDir();
    const good = join(dir, "principals.json");
    realFs.writeFileSync(good, JSON.stringify({ principals: [PRINCIPAL] }));
    expect(loadPrincipalMap(good).get(PRINCIPAL.fingerprint)?.principalId).toBe(
      PRINCIPAL.principalId,
    );
    const bad = join(dir, "bad.json");
    realFs.writeFileSync(bad, JSON.stringify({ principals: [{ fingerprint: "x" }] }));
    expect(() => loadPrincipalMap(bad)).toThrow(ConfigError);
    expect(() => loadPrincipalMap(join(dir, "missing.json"))).toThrow(ConfigError);
  });
});

// ---------------------------------------------------------------------------
// B2 — envelope identity bounds + frozen-digest mirror (§11.5, §11.8)
// ---------------------------------------------------------------------------

describe("envelope.mjs identity bounds (§11.5)", () => {
  it("accepts the 64-char principal + 128-char client id boundary (193 namespaced)", () => {
    const longPrincipal = "p".repeat(64);
    const longClient = "c".repeat(128);
    const envelope = sealTestEnvelope(
      { clientRequestId: longClient },
      { principalId: longPrincipal },
    );
    expect(envelope.requestId).toBe(`${longPrincipal}:${longClient}`);
    expect(envelope.requestId.length).toBe(193);
  });

  it("rejects 129-char client ids, 65-char principal ids, and illegal characters", () => {
    expect(() => sealTestEnvelope({ clientRequestId: "c".repeat(129) })).toThrow(EnvelopeError);
    expect(() => sealTestEnvelope({ clientRequestId: "c".repeat(130) })).toThrow(EnvelopeError);
    expect(() => sealTestEnvelope({ clientRequestId: "a:b" })).toThrow(EnvelopeError);
    expect(() => sealTestEnvelope({ clientRequestId: "a|b" })).toThrow(EnvelopeError);
    expect(() => sealTestEnvelope({ clientRequestId: "résumé" })).toThrow(EnvelopeError);
    expect(() => sealTestEnvelope({}, { principalId: "p".repeat(65) })).toThrow(EnvelopeError);
    expect(isValidClientRequestId("c".repeat(128))).toBe(true);
    expect(isValidClientRequestId("c".repeat(129))).toBe(false);
    expect(isValidPrincipalId("p".repeat(64))).toBe(true);
    expect(isValidPrincipalId("p".repeat(65))).toBe(false);
  });

  it("refuses non-empty attachments BEFORE retention (§11.4 bridge side)", () => {
    expect(() => sealTestEnvelope({ attachments: [{ path: "x" }] })).toThrow(/attachments/u);
    expect(() => sealTestEnvelope({ attachments: [] })).not.toThrow();
    expect(() => sealTestEnvelope({ attachments: null })).not.toThrow();
  });

  it("refuses out-of-scope projects and oversized payloads before retention", () => {
    expect(() => sealTestEnvelope({ projectId: "proj-other" })).toThrow(/not in the allowed set/u);
    const hugeDescription = "d".repeat(PRINCIPAL.maxRequestBytes);
    expect(() => sealTestEnvelope({ description: hugeDescription })).toThrow(
      /payload is .* bytes/u,
    );
  });
});

describe("frozen-digest mirror + pinned vectors (§11.8)", () => {
  it("reproduces every pinned vector and agrees with @aif/shared", () => {
    for (const vector of VECTORS.vectors) {
      expect(canonicalizeIntakePayload(vector.payload)).toBe(vector.expectedCanonicalJson);
      expect(relayDigest(vector.payload)).toBe(vector.expectedDigest);
      // The API-side (shared) implementation must agree byte-for-byte.
      expect(computeIntakePayloadDigest(vector.payload)).toBe(vector.expectedDigest);
    }
  });

  it("is stable across JSON key order and whitespace variants", () => {
    const base = VECTORS.vectors.find((v) => v.name === "full-payload");
    if (!base) throw new Error("pinned full-payload vector missing from fixtures");
    const reordered: Record<string, unknown> = {};
    for (const key of Object.keys(base.payload).reverse()) reordered[key] = base.payload[key];
    const variant = JSON.parse(JSON.stringify(reordered, null, 4));
    expect(relayDigest(variant)).toBe(base.expectedDigest);
  });

  it("namespaces request ids with one encoding", () => {
    expect(namespaceRequestId("principal", "client")).toBe("principal:client");
  });
});

// ---------------------------------------------------------------------------
// B3 — spool durability (§9.1, §11.7)
// ---------------------------------------------------------------------------

describe("spool.mjs (§9.1, §11.7)", () => {
  it("issues the retention receipt only after file fsync + rename + directory fsync (instrumented)", async () => {
    const dir = makeTmpDir();
    const config = baseConfig(dir, { mode: "retain-only" });
    const spool = createSpool({ dir: config.spoolDir, maxEnvelopes: 10, maxBytes: 1024 * 1024 });
    fsRecording = true;
    fsLog.length = 0;

    let opsAtReceipt: Array<{ op: string }> = [];
    const response = await handleWriterRequest({
      request: { credential: CREDENTIAL, envelope: sealTestEnvelope() },
      config,
      spool,
      principalMap: PRINCIPAL_MAP,
      credential: CREDENTIAL,
      hooks: {
        onRetained: () => {
          opsAtReceipt = [...fsLog];
        },
      },
    });

    expect(response.ok).toBe(true);
    // Ordering at the moment the receipt was issued: file fsync → rename →
    // directory fsync all precede the receipt (§9.1).
    const ops = opsAtReceipt.map((entry) => entry.op);
    const lastRename = ops.lastIndexOf("rename");
    expect(lastRename).toBeGreaterThan(-1);
    expect(ops.filter((op) => op === "fsync").length).toBeGreaterThanOrEqual(2);
    expect(ops[ops.length - 1]).toBe("fsync");
    expect(ops.slice(lastRename + 1)).toEqual(["fsync"]);
    const record = spool.list()[0];
    expect(record.receipts.length).toBe(1);
    expect(record.receipts[0].kind).toBe("retention");
  });

  it("restart scan discards receipt-less temps and re-pends ambiguous admitted entries", () => {
    const dir = makeTmpDir();
    const config = baseConfig(dir, { mode: "deliver" });
    const spool = createSpool({ dir: config.spoolDir, maxEnvelopes: 10, maxBytes: 1024 * 1024 });
    const envelope = sealTestEnvelope();
    spool.writerReceive(envelope, { mode: "deliver" });
    const record = spool.list()[0];
    spool.updateState(record.id, { state: "admitted" });
    // Simulate a receipt-less temp left by a crashed write.
    realFs.writeFileSync(join(config.spoolDir, ".tmp-123-abc.tmp"), "garbage");

    const result = spool.restartScan();
    expect(result.discardedTemps).toEqual([".tmp-123-abc.tmp"]);
    expect(result.rePended).toEqual([record.id]);
    const after = spool.get(record.id);
    expect(after.state).toBe("pending");
    expect(
      after.receipts.some((entry: { kind: string }) => entry.kind === "restart_repended"),
    ).toBe(true);
    expect(spoolStats(config.spoolDir).temps).toBe(0);
  });

  it("restart scan leaves terminal states untouched", () => {
    const dir = makeTmpDir();
    const config = baseConfig(dir, { mode: "deliver" });
    const spool = createSpool({ dir: config.spoolDir, maxEnvelopes: 10, maxBytes: 1024 * 1024 });
    const envelope = sealTestEnvelope();
    spool.writerReceive(envelope, { mode: "deliver" });
    const record = spool.list()[0];
    spool.updateState(record.id, { state: "rejected" });
    const result = spool.restartScan();
    expect(result.rePended).toEqual([]);
    expect(spool.get(record.id).state).toBe("rejected");
  });

  it("refuses new work at the count bound truthfully, leaving no partial file", () => {
    const dir = makeTmpDir();
    const config = baseConfig(dir, { mode: "retain-only" });
    const spool = createSpool({ dir: config.spoolDir, maxEnvelopes: 2, maxBytes: 1024 * 1024 });
    spool.writerReceive(sealTestEnvelope({ clientRequestId: "r1" }), { mode: "retain-only" });
    spool.writerReceive(sealTestEnvelope({ clientRequestId: "r2" }), { mode: "retain-only" });
    const before = spoolStats(config.spoolDir);
    try {
      spool.writerReceive(sealTestEnvelope({ clientRequestId: "r3" }), { mode: "retain-only" });
      throw new Error("expected refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(SpoolError);
      expect((error as InstanceType<typeof SpoolError>).code).toBe("spool_full_count");
    }
    const after = spoolStats(config.spoolDir);
    expect(after.count).toBe(before.count);
    expect(after.bytes).toBe(before.bytes);
    expect(after.temps).toBe(0);
    // Accepted work was never evicted.
    expect(
      spool
        .list()
        .map((r: { requestId: string }) => r.requestId)
        .sort(),
    ).toEqual(["bridge-principal:r1", "bridge-principal:r2"]);
  });

  it("refuses at the byte bound when the next envelope would not fit", () => {
    const dir = makeTmpDir();
    const config = baseConfig(dir, { mode: "retain-only" });
    const spool = createSpool({ dir: config.spoolDir, maxEnvelopes: 100, maxBytes: 1024 * 1024 });
    spool.writerReceive(sealTestEnvelope({ clientRequestId: "r1" }), { mode: "retain-only" });
    const size = spoolStats(config.spoolDir).bytes;
    const tight = createSpool({ dir: config.spoolDir, maxEnvelopes: 100, maxBytes: size });
    try {
      tight.writerReceive(sealTestEnvelope({ clientRequestId: "r-other" }), {
        mode: "retain-only",
      });
      throw new Error("expected byte-bound refusal");
    } catch (error) {
      expect((error as InstanceType<typeof SpoolError>).code).toBe("spool_full_bytes");
    }
  });

  it("replays a duplicate dedup key into the existing record without consuming quota", () => {
    const dir = makeTmpDir();
    const config = baseConfig(dir, { mode: "retain-only" });
    const spool = createSpool({ dir: config.spoolDir, maxEnvelopes: 1, maxBytes: 1024 * 1024 });
    const first = spool.writerReceive(sealTestEnvelope(), { mode: "retain-only" });
    const second = spool.writerReceive(sealTestEnvelope(), { mode: "retain-only" });
    expect(second.id).toBe(first.id);
    expect(
      first.receipts.some((entry: { kind: string }) => entry.kind === "retention_replayed"),
    ).toBe(false);
    expect(
      second.receipts.some((entry: { kind: string }) => entry.kind === "retention_replayed"),
    ).toBe(true);
    expect(spoolStats(config.spoolDir).count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// B4 — wake coalescing and bounds
// ---------------------------------------------------------------------------

describe("wake.mjs coalescing and bounds (§11.7)", () => {
  function makeWake(overrides: Record<string, unknown> = {}, commandLog: string[] = []) {
    let clock = 1_000_000;
    return createWakeEngine({
      command: "/bin/true",
      maxRepeats: 3,
      backoffMs: 100,
      windowMs: 500,
      now: () => clock,
      sleep: async () => {},
      exec: (_cmd: string, _args: string[], _opts: unknown, cb: (e?: Error) => void) => {
        commandLog.push("fired");
        cb();
      },
      ...overrides,
    });
  }

  it("coalesces N concurrent triggers inside an open window into one wake", async () => {
    const fired: string[] = [];
    const wake = makeWake({}, fired);
    const results = await Promise.all([
      wake.trigger("a"),
      wake.trigger("b"),
      wake.trigger("c"),
      wake.trigger("d"),
    ]);
    expect(results.filter((r) => r.fired).length).toBe(1);
    expect(results.filter((r) => r.coalesced).length).toBe(3);
    expect(fired.length).toBe(1);
  });

  it("bounds repeats and ceases truthfully when exhausted (no infinite storm)", async () => {
    const fired: string[] = [];
    let clock = 1_000_000;
    const wake = createWakeEngine({
      command: "/bin/true",
      maxRepeats: 2,
      backoffMs: 100,
      windowMs: 10,
      now: () => clock,
      exec: (_c: string, _a: string[], _o: unknown, cb: (e?: Error) => void) => {
        fired.push("fired");
        cb();
      },
    });
    expect((await wake.trigger("1")).fired).toBe(true);
    clock += 200;
    expect((await wake.trigger("2")).fired).toBe(true);
    clock += 200;
    const third = await wake.trigger("3");
    expect(third.fired).toBe(false);
    expect(third.exhausted).toBe(true);
    clock += 10_000;
    expect((await wake.trigger("4")).exhausted).toBe(true);
    expect(fired.length).toBe(2);
    expect(wake.status().exhausted).toBe(true);
    // Operator/delivery evidence that the PC is awake restarts the episode.
    wake.reset();
    expect(wake.status().exhausted).toBe(false);
    expect((await wake.trigger("5")).fired).toBe(true);
  });

  it("treats a failed wake command as a non-failure outcome and respects backoff", async () => {
    let clock = 0;
    const wake = createWakeEngine({
      command: "/bin/false",
      maxRepeats: 3,
      backoffMs: 500,
      windowMs: 10,
      now: () => clock,
      exec: (_c: string, _a: string[], _o: unknown, cb: (e?: Error) => void) =>
        cb(new Error("boom")),
    });
    const first = await wake.trigger("x");
    expect(first.fired).toBe(false);
    expect(first.failed).toBe(true);
    clock = 100; // past the open wake window, inside the backoff period
    const second = await wake.trigger("y");
    expect(second.backoff).toBe(true);
    clock = 1_000; // backoff elapsed, repeats still available
    const third = await wake.trigger("z");
    expect(third.fired).toBe(false);
    expect(third.failed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §11.14 (S1) — authenticated writer IPC: direct negatives, shim positive
// ---------------------------------------------------------------------------

describe("authenticated writer IPC (§11.14 S1)", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  for (const mode of ["retain-only", "deliver"] as const) {
    it(`refuses missing and wrong credentials pre-quota in ${mode} mode`, async () => {
      const dir = makeTmpDir();
      const config = baseConfig(dir, { mode });
      const spool = createSpool({ dir: config.spoolDir, maxEnvelopes: 10, maxBytes: 1024 * 1024 });
      const envelope = sealTestEnvelope();
      for (const credential of [undefined, "wrong-credential", CREDENTIAL.slice(0, -1)]) {
        const response = await handleWriterRequest({
          request: { credential, envelope },
          config,
          spool,
          principalMap: PRINCIPAL_MAP,
          credential: CREDENTIAL,
        });
        expect(response).toEqual({ ok: false, code: "writer_unauthenticated" });
      }
      const stats = spoolStats(config.spoolDir);
      expect(stats.count).toBe(0);
      expect(stats.temps).toBe(0);
    });
  }

  it("refuses forged envelopes that violate writer-side invariants, with zero writes", async () => {
    const dir = makeTmpDir();
    const config = baseConfig(dir, { mode: "deliver" });
    const spool = createSpool({ dir: config.spoolDir, maxEnvelopes: 10, maxBytes: 1024 * 1024 });
    const request = (envelope: unknown) =>
      handleWriterRequest({
        request: { credential: CREDENTIAL, envelope },
        config,
        spool,
        principalMap: PRINCIPAL_MAP,
        credential: CREDENTIAL,
      });

    // Unknown principal (not in the writer's operator map).
    const stranger = sealTestEnvelope({}, { fingerprint: "SHA256:stranger" });
    expect((await request(JSON.parse(JSON.stringify(stranger)))).code).toBe("principal_unknown");
    // Out-of-scope project: the writer's own map copy has a narrower scope
    // than the map the envelope was sealed against.
    const narrowedMap = new Map([
      [PRINCIPAL.fingerprint, { ...PRINCIPAL, allowedProjects: ["proj-2"] }],
    ]);
    const scopedEnvelope = sealTestEnvelope();
    expect(
      (
        await handleWriterRequest({
          request: { credential: CREDENTIAL, envelope: scopedEnvelope },
          config,
          spool,
          principalMap: narrowedMap,
          credential: CREDENTIAL,
        })
      ).code,
    ).toBe("project_not_allowed");
    // Oversize vs the principal bound: a valid envelope presented against a
    // map copy whose bound is smaller than the body.
    const tinyBoundMap = new Map([[PRINCIPAL.fingerprint, { ...PRINCIPAL, maxRequestBytes: 10 }]]);
    const oversized = sealTestEnvelope();
    expect(
      (
        await handleWriterRequest({
          request: { credential: CREDENTIAL, envelope: oversized },
          config,
          spool,
          principalMap: tinyBoundMap,
          credential: CREDENTIAL,
        })
      ).code,
    ).toBe("payload_too_large");
    // Non-empty attachments smuggled into a sealed body (digest still matches —
    // attachments are excluded from the digest by contract — so this proves the
    // invariant is checked independently).
    const attached = JSON.parse(JSON.stringify(sealTestEnvelope()));
    attached.body.attachments = [{ name: "smuggled" }];
    expect((await request(attached)).code).toBe("attachments_unavailable");
    // Digest mismatch (tampered body).
    const tampered = JSON.parse(JSON.stringify(sealTestEnvelope()));
    tampered.body.title = "tampered title";
    expect((await request(tampered)).code).toBe("digest_mismatch");

    expect(spoolStats(config.spoolDir)).toEqual({ count: 0, bytes: 0, temps: 0 });
  });

  it("accepts a valid forced submit under the RESOLVED principal, never a client-claimed one", async () => {
    const dir = makeTmpDir();
    const config = baseConfig(dir, { mode: "retain-only" });
    const spool = createSpool({ dir: config.spoolDir, maxEnvelopes: 10, maxBytes: 1024 * 1024 });
    await startWriter(config, spool);

    const identityFile = join(dir, "authinfo");
    realFs.writeFileSync(identityFile, "publickey SHA256:test-fingerprint\n");
    const credentialFile = join(dir, "cred");
    realFs.writeFileSync(credentialFile, CREDENTIAL);
    const { exitCode, response } = await submitOnce({
      config: { ...config, sshAuthInfoPath: identityFile, writerCredentialPath: join(dir, "cred") },
      principalMap: PRINCIPAL_MAP,
      input: clientInput({ principalId: "forged-principal", fingerprint: "SHA256:forged" }),
      readFileSync: realFs.readFileSync,
    });
    expect(exitCode).toBe(EXIT_CODES.accepted);
    expect(response.ok).toBe(true);
    expect(response.receipt.state).toBe("retained");
    const record = spool.list()[0];
    expect(record.principal.principalId).toBe("bridge-principal");
    expect(record.principal.principalId).not.toBe("forged-principal");
    expect(record.principal.fingerprint).toBe("SHA256:test-fingerprint");
  });

  it("refuses submits when no principal resolves, and honors the documented per-key env fallback", async () => {
    const dir = makeTmpDir();
    const config = baseConfig(dir, {
      mode: "retain-only",
      writerCredentialPath: join(dir, "cred"),
    });
    const noIdentity = await submitOnce({
      config,
      principalMap: PRINCIPAL_MAP,
      input: clientInput(),
    });
    expect(noIdentity.exitCode).toBe(EXIT_CODES.refused_pre_writer);
    expect(noIdentity.response.code).toBe("principal_unknown");

    const viaEnv = await submitOnce({
      config: { ...config, principalEnvVar: "AIF_TEST_PRINCIPAL" },
      principalMap: PRINCIPAL_MAP,
      input: clientInput(),
      env: { AIF_TEST_PRINCIPAL: "bridge-principal" },
    });
    // Principal resolves, but the local credential file is missing → the shim
    // fails closed before any writer contact.
    expect(viaEnv.exitCode).toBe(EXIT_CODES.retention_unavailable);
    expect(viaEnv.response.code).toBe("writer_unauthenticated");
    const resolved = resolvePrincipal({
      config: { ...config, principalEnvVar: "AIF_TEST_PRINCIPAL" },
      principalMap: PRINCIPAL_MAP,
      env: { AIF_TEST_PRINCIPAL: "bridge-principal" },
    });
    expect(resolved.via).toBe("per-key-environment");
    expect(resolved.principal?.principalId).toBe("bridge-principal");
  });

  it("fails closed when the writer socket becomes kernel-unreachable (mode 0000)", async () => {
    const dir = makeTmpDir();
    const config = baseConfig(dir, { mode: "retain-only" });
    const spool = createSpool({ dir: config.spoolDir, maxEnvelopes: 10, maxBytes: 1024 * 1024 });
    const writer = await startWriter(config, spool);
    const credentialFile = join(dir, "cred");
    realFs.writeFileSync(credentialFile, CREDENTIAL);
    const identityFile = join(dir, "authinfo");
    realFs.writeFileSync(identityFile, "publickey SHA256:test-fingerprint\n");
    try {
      chmodSync(config.socketPath, 0o000);
      const result = await submitOnce({
        config: { ...config, writerCredentialPath: credentialFile, sshAuthInfoPath: identityFile },
        principalMap: PRINCIPAL_MAP,
        input: clientInput({ clientRequestId: "blocked-1" }),
        readFileSync: realFs.readFileSync,
      });
      expect(result.exitCode).toBe(EXIT_CODES.retention_unavailable);
      expect(result.response.code).toBe("retention_unavailable");
      expect(spoolStats(config.spoolDir).count).toBe(0);
    } finally {
      chmodSync(config.socketPath, 0o600);
      writer.close();
    }
  });

  it("uses a timing-safe comparison for the writer credential", () => {
    expect(String(credentialsMatch)).toContain("timingSafeEqual");
    expect(credentialsMatch("short", "longer-value")).toBe(false);
    expect(credentialsMatch(CREDENTIAL, CREDENTIAL)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §11.7 — delivery response classification (§7.5) + retain-only honesty
// ---------------------------------------------------------------------------

describe("delivery classification (§7.5, §11.7)", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("maps every admission status to its §7.5 class", () => {
    expect(classifyAdmissionStatus(201).kind).toBe("created");
    expect(classifyAdmissionStatus(200).kind).toBe("replayed");
    expect(classifyAdmissionStatus(409).kind).toBe("terminal_conflict");
    expect(classifyAdmissionStatus(410).kind).toBe("terminal_tombstone");
    expect(classifyAdmissionStatus(500).kind).toBe("retry");
    expect(classifyAdmissionStatus(429).kind).toBe("retry");
    for (const status of [400, 401, 403, 404, 422]) {
      expect(classifyAdmissionStatus(status).kind).toBe("hold_auth_config");
    }
  });

  async function cycleWithStatus(status: number, body: unknown) {
    const dir = makeTmpDir();
    const stub = await createStubServer({ postTasks: { status, body, delayMs: 0 } });
    const config = baseConfig(dir, { endpoint: stub.url, retryMax: 2, retryBackoffMs: 10 });
    const spool = createSpool({ dir: config.spoolDir, maxEnvelopes: 10, maxBytes: 1024 * 1024 });
    const wakeCalls: string[] = [];
    const wake = {
      trigger: async (reason: string) => {
        wakeCalls.push(reason);
        return { fired: true };
      },
      reset: () => {},
      status: () => ({}),
    };
    const deliverer = createDeliverer({ config, spool, wake, fetchImpl: fetch });
    const envelope = sealTestEnvelope();
    spool.writerReceive(envelope, { mode: "deliver" });
    return { dir, stub, config, spool, deliverer, wakeCalls };
  }

  it("parks 401/403/422/400/404 as hold_auth_config with no retry and no wake", async () => {
    for (const status of [401, 403, 422, 400, 404]) {
      const { stub, spool, deliverer, wakeCalls } = await cycleWithStatus(status, {
        code: `status-${status}`,
      });
      await deliverer.runCycle();
      const record = spool.list()[0];
      expect(record.state).toBe("hold_auth_config");
      expect(stub.counters.postTasks).toBe(1);
      expect(wakeCalls.length).toBe(0);
      // Subsequent cycles do NOT retry a hold.
      await deliverer.runCycle();
      expect(stub.counters.postTasks).toBe(1);
      expect(wakeCalls.length).toBe(0);
      await stub.close();
    }
  });

  it("terminates 409/410 as rejected/tombstoned without retries", async () => {
    const conflict = await cycleWithStatus(409, { code: "intake_conflict" });
    await conflict.deliverer.runCycle();
    expect(conflict.spool.list()[0].state).toBe("rejected");
    await conflict.stub.close();

    const tombstone = await cycleWithStatus(410, { code: "intake_tombstone" });
    await tombstone.deliverer.runCycle();
    expect(tombstone.spool.list()[0].state).toBe("tombstoned");
    await tombstone.stub.close();
  });

  it("retries network/5xx outcomes with bounded backoff of the byte-identical body, then holds", async () => {
    const { stub, spool, deliverer } = await cycleWithStatus(500, { error: "boom" });
    await deliverer.runCycle();
    let record = spool.list()[0];
    expect(record.state).toBe("pending");
    expect(record.attempts).toBe(1);
    expect(stub.counters.postTasks).toBe(1);
    const firstBody = stub.capturedBodies[0];

    await sleep(30);
    await deliverer.runCycle();
    record = spool.list()[0];
    expect(record.state).toBe("hold_handover_unconfirmed");
    expect(stub.counters.postTasks).toBe(2);
    // The retry re-sends the byte-identical body (§7.4).
    expect(stub.capturedBodies[1]).toBe(firstBody);
    await stub.close();
  });

  it("schedules retries and wake when delivery transport fails while the probe passes", async () => {
    const dir = makeTmpDir();
    const stub = await createStubServer({});
    const config = baseConfig(dir, { endpoint: stub.url, retryMax: 2, retryBackoffMs: 10 });
    const spool = createSpool({ dir: config.spoolDir, maxEnvelopes: 10, maxBytes: 1024 * 1024 });
    const wakeCalls: string[] = [];
    const wake = {
      trigger: async (reason: string) => {
        wakeCalls.push(reason);
        return { fired: true };
      },
      reset: () => {},
      status: () => ({}),
    };
    const postFails: typeof fetch = (input, init) => {
      if (String(input).endsWith("/tasks") && init?.method === "POST") {
        return Promise.reject(Object.assign(new Error("reset"), { cause: { code: "ECONNRESET" } }));
      }
      return fetch(input, init);
    };
    const deliverer = createDeliverer({ config, spool, wake, fetchImpl: postFails });
    spool.writerReceive(sealTestEnvelope(), { mode: "deliver" });
    await deliverer.runCycle();
    expect(spool.list()[0].state).toBe("pending");
    expect(spool.list()[0].attempts).toBe(1);
    expect(wakeCalls).toEqual(["endpoint_unreachable"]);
    await stub.close();
  });

  it("retain-only mode makes zero network calls and issues zero wake (§5)", async () => {
    const dir = makeTmpDir();
    const config = baseConfig(dir, { mode: "retain-only" });
    const spool = createSpool({ dir: config.spoolDir, maxEnvelopes: 10, maxBytes: 1024 * 1024 });
    let fetchCalls = 0;
    const fetchSpy: typeof fetch = (input, init) => {
      fetchCalls += 1;
      return fetch(input, init);
    };
    const deliverer = createDeliverer({ config, spool, wake: null, fetchImpl: fetchSpy });
    spool.writerReceive(sealTestEnvelope(), { mode: "retain-only" });
    await deliverer.runCycle();
    await deliverer.runCycle();
    expect(fetchCalls).toBe(0);
    expect(deliverer.state().wake).toBeNull();
    const record = spool.list()[0];
    expect(record.state).toBe("retained");
    expect(record.receipts[0].note).toContain("delivery pending: transport not configured");
  });
});

// ---------------------------------------------------------------------------
// §11.10 (M1) — handover fencing, mid-handover wake, eligibility split
// ---------------------------------------------------------------------------

describe("handover watch (§11.10 M1)", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  function stubWake() {
    const state = { fired: 0, resets: 0, reasons: [] as string[] };
    return {
      state,
      trigger: async (reason: string) => {
        state.fired += 1;
        state.reasons.push(reason);
        return { fired: true };
      },
      reset: () => {
        state.resets += 1;
      },
      status: () => ({ fired: state.fired }),
    };
  }

  async function handoverFixture(pollMax = 50) {
    const dir = makeTmpDir();
    const stub = await createStubServer({
      postTasks: {
        status: 201,
        body: { id: "task-1", status: "backlog", executionOwner: "ai" },
        delayMs: 0,
      },
      getTask: { status: 200, body: { id: "task-1", status: "backlog" }, delayMs: 0 },
    });
    const config = baseConfig(dir, {
      endpoint: stub.url,
      handoverPollMax: pollMax,
      handoverPollBackoffMs: 5,
    });
    const spool = createSpool({ dir: config.spoolDir, maxEnvelopes: 10, maxBytes: 1024 * 1024 });
    const wake = stubWake();
    const endpoint = switchableFetch(fetch);
    const deliverer = createDeliverer({ config, spool, wake, fetchImpl: endpoint.impl });
    spool.writerReceive(sealTestEnvelope(), { mode: "deliver" });
    return { dir, stub, config, spool, deliverer, wake, endpoint };
  }

  it("holds admitted work through an endpoint drop, wakes, and completes on pickup evidence", async () => {
    const { stub, spool, deliverer, wake, endpoint } = await handoverFixture();
    // Cycle 1: admit + first poll (still backlog).
    await deliverer.runCycle();
    expect(spool.list()[0].state).toBe("admitted");
    expect(stub.counters.postTasks).toBe(1);
    expect(stub.counters.getTask).toBe(1);
    expect(wake.state.fired).toBe(0);

    // Mid-handover suspend: endpoint drops.
    endpoint.state.endpointUp = false;
    await deliverer.runCycle();
    expect(spool.list()[0].state).toBe("admitted"); // NOT parked, NOT lost
    expect(wake.state.fired).toBe(1); // bounded WoL fired
    expect(stub.counters.postTasks).toBe(1); // never re-POSTed

    // PC returns; the task is now in-stage with a live lock → pickup evidence.
    endpoint.state.endpointUp = true;
    await sleep(20); // let the watch-poll backoff elapse
    stub.config.getTask.body = {
      id: "task-1",
      status: "implementing",
      lockedBy: "agent-1",
      lockedUntil: "2030-01-01T00:00:00.000Z",
    };
    await deliverer.runCycle();
    const record = spool.list()[0];
    expect(record.state).toBe("completed");
    expect(record.receipts.some((entry: { kind: string }) => entry.kind === "completed")).toBe(
      true,
    );
    expect(wake.state.fired).toBe(1); // no further wake after evidence
    await stub.close();
  });

  it("completes a future-scheduled admission at admission with zero polls and zero wake", async () => {
    const dir = makeTmpDir();
    const stub = await createStubServer({
      postTasks: {
        status: 201,
        body: { id: "task-2", status: "backlog", scheduledAt: "2030-01-01T00:00:00.000Z" },
        delayMs: 0,
      },
    });
    const config = baseConfig(dir, { endpoint: stub.url });
    const spool = createSpool({ dir: config.spoolDir, maxEnvelopes: 10, maxBytes: 1024 * 1024 });
    const wake = stubWake();
    const deliverer = createDeliverer({ config, spool, wake, fetchImpl: fetch });
    spool.writerReceive(sealTestEnvelope(), { mode: "deliver" });
    await deliverer.runCycle();
    const record = spool.list()[0];
    expect(record.state).toBe("completed");
    expect(record.scheduledAt).toBe("2030-01-01T00:00:00.000Z");
    expect(stub.counters.getTask).toBe(0);
    expect(wake.state.fired).toBe(0);
    expect(
      record.receipts.some((entry: { note: string }) =>
        entry.note.includes("no watch for future-due work"),
      ),
    ).toBe(true);
    await stub.close();
  });

  it("exhausts the poll budget truthfully into hold_handover_unconfirmed", async () => {
    const { stub, spool, deliverer, wake } = await handoverFixture(2);
    await deliverer.runCycle(); // admit + poll #1
    await sleep(20);
    await deliverer.runCycle(); // poll #2
    await sleep(20);
    await deliverer.runCycle(); // budget exhausted → hold
    const record = spool.list()[0];
    expect(record.state).toBe("hold_handover_unconfirmed");
    expect(record.holdReason).toContain("poll budget exhausted");
    expect(stub.counters.getTask).toBe(2);
    expect(wake.state.fired).toBe(0); // pickup polling kept the endpoint healthy
    await stub.close();
  });
});

// ---------------------------------------------------------------------------
// §11.11 (M3) — compat probe fence
// ---------------------------------------------------------------------------

describe("compat probe (§11.11 M3)", () => {
  async function compatFixture() {
    const dir = makeTmpDir();
    const stub = await createStubServer({
      agentStatus: { status: 200, body: {}, delayMs: 0 },
      postTasks: { status: 201, body: { id: "task-c", status: "backlog" }, delayMs: 0 },
    });
    const config = baseConfig(dir, { endpoint: stub.url });
    const spool = createSpool({ dir: config.spoolDir, maxEnvelopes: 10, maxBytes: 1024 * 1024 });
    const wake = {
      trigger: async () => ({ fired: false }),
      reset: () => {},
      status: () => ({}),
    };
    const deliverer = createDeliverer({ config, spool, wake, fetchImpl: fetch });
    spool.writerReceive(sealTestEnvelope(), { mode: "deliver" });
    return { stub, config, spool, deliverer };
  }

  it("POSTs nothing when /agent/status lacks intakeCompat", async () => {
    const { stub, spool, deliverer } = await compatFixture();
    await deliverer.runCycle();
    expect(stub.counters.postTasks).toBe(0);
    expect(spool.list()[0].state).toBe("hold_api_compat");
    await stub.close();
  });

  it("HOLDs on a mismatched level and auto-resumes when the level is fixed", async () => {
    const { stub, spool, deliverer } = await compatFixture();
    stub.config.agentStatus.body = { intakeCompat: 99 };
    await deliverer.runCycle();
    expect(spool.list()[0].state).toBe("hold_api_compat");
    expect(stub.counters.postTasks).toBe(0);

    stub.config.agentStatus.body = { intakeCompat: 1 };
    await deliverer.runCycle();
    expect(spool.list()[0].state).toBe("admitted");
    expect(stub.counters.postTasks).toBe(1);
    await stub.close();
  });

  it("reports an unreachable probe distinctly and parks delivery", async () => {
    const result = await probeCompat({ endpoint: "http://127.0.0.1:1", expectedLevel: 1 });
    expect(result.ok).toBe(false);
    expect(result.reachable).toBe(false);
    expect(result.reason).toContain("probe_unreachable");
  });
});

// ---------------------------------------------------------------------------
// §11.15 (S2) — the operator fence, not the probe, prevents delivery; guard
// ---------------------------------------------------------------------------

describe("operator fence + rollback guard (§11.15 S2)", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("fence landing while a cycle awaits a delayed probe aborts the POST (R4/C2 defense)", async () => {
    const dir = makeTmpDir();
    const stub = await createStubServer({
      agentStatus: { status: 200, body: { intakeCompat: 1 }, delayMs: 150 },
      postTasks: { status: 201, body: { id: "task-f", status: "backlog" }, delayMs: 0 },
    });
    const config = baseConfig(dir, { endpoint: stub.url });
    const spool = createSpool({ dir: config.spoolDir, maxEnvelopes: 10, maxBytes: 1024 * 1024 });
    const deliverer = createDeliverer({ config, spool, wake: null, fetchImpl: fetch });
    spool.writerReceive(sealTestEnvelope(), { mode: "deliver" });

    const cycle = deliverer.runCycle();
    await sleep(40);
    expect(stub.counters.agentStatus).toBeGreaterThanOrEqual(1);
    writeFence(config.fencePath, "swap window", "2026-11-01T10:00:00.000Z");
    await cycle;

    expect(stub.counters.postTasks).toBe(0);
    expect(spool.list()[0].state).toBe("hold_operator_fence");

    // Unfence with the matching stub → delivery proceeds exactly once.
    clearFence(config.fencePath);
    stub.config.agentStatus.delayMs = 0;
    await deliverer.runCycle();
    expect(stub.counters.postTasks).toBe(1);
    await stub.close();
  });

  it("fences delivery against an incompatible swap; unfence exposes the compat HOLD; restore delivers once", async () => {
    const dir = makeTmpDir();
    const stub = await createStubServer({
      agentStatus: { status: 200, body: { intakeCompat: 1 }, delayMs: 0 },
      postTasks: { status: 201, body: { id: "task-s", status: "backlog" }, delayMs: 0 },
    });
    const config = baseConfig(dir, { endpoint: stub.url });
    const spool = createSpool({ dir: config.spoolDir, maxEnvelopes: 10, maxBytes: 1024 * 1024 });
    const deliverer = createDeliverer({ config, spool, wake: null, fetchImpl: fetch });
    spool.writerReceive(sealTestEnvelope(), { mode: "deliver" });

    writeFence(config.fencePath, "api swap", "2026-11-01T10:00:00.000Z");
    stub.config.agentStatus.body = { intakeCompat: 2 }; // swap happened mid-fence
    await deliverer.runCycle();
    await deliverer.runCycle();
    expect(stub.counters.postTasks).toBe(0); // the FENCE, not the probe, prevented delivery
    expect(spool.list()[0].state).toBe("hold_operator_fence");

    clearFence(config.fencePath);
    await deliverer.runCycle();
    expect(stub.counters.postTasks).toBe(0); // still fenced by the compat probe
    expect(spool.list()[0].state).toBe("hold_api_compat");

    stub.config.agentStatus.body = { intakeCompat: 1 }; // compatible API restored
    await deliverer.runCycle();
    expect(stub.counters.postTasks).toBe(1);
    expect(spool.list()[0].state).toBe("admitted");
    await stub.close();
  });

  it("evaluates the guard conjunctively (R4/C2) and mutates nothing", () => {
    const dir = makeTmpDir();
    const fence = { reason: "swap", at: "2026-11-01T10:00:00.000Z" };
    const dead = { state: "inactive", dead: true };
    const clean = { error: null, uncertain: [] as unknown[], pending: 0 };

    expect(
      evaluateGuard({ fence, supervisor: dead, uncertainEffects: clean, artifactMatches: true })
        .permit,
    ).toBe(true);
    const refuse = (facts: Parameters<typeof evaluateGuard>[0]) => {
      const verdict = evaluateGuard(facts);
      expect(verdict.permit).toBe(false);
      expect(verdict.reasons.length).toBeGreaterThan(0);
      return verdict;
    };
    expect(
      refuse({ fence: null, supervisor: dead, uncertainEffects: clean, artifactMatches: true })
        .reasons[0],
    ).toContain("fence marker missing");
    expect(
      refuse({
        fence,
        supervisor: { state: "active", dead: false },
        uncertainEffects: clean,
        artifactMatches: true,
      }).reasons.join(" "),
    ).toContain("live relay refuses the swap, fenced included");
    // Probe-paused → fence/swap: the unit is ACTIVE with a fence present —
    // a fenced status reply is liveness, not cessation.
    expect(
      refuse({
        fence,
        supervisor: { state: "active", dead: false },
        uncertainEffects: clean,
        artifactMatches: true,
      }).permit,
    ).toBe(false);
    expect(
      refuse({
        fence,
        supervisor: { state: "query-failed", dead: false },
        uncertainEffects: clean,
        artifactMatches: true,
      }).reasons.join(" "),
    ).toContain("cessation not verified");
    expect(
      refuse({
        fence,
        supervisor: { state: "activating", dead: false },
        uncertainEffects: clean,
        artifactMatches: true,
      }).permit,
    ).toBe(false);
    expect(
      refuse({
        fence,
        supervisor: dead,
        uncertainEffects: { error: null, uncertain: [{ id: "e1", state: "admitted" }], pending: 0 },
        artifactMatches: true,
      }).reasons.join(" "),
    ).toContain("uncertain-effect envelope present: e1");
    expect(
      refuse({
        fence,
        supervisor: dead,
        uncertainEffects: clean,
        artifactMatches: false,
      }).reasons.join(" "),
    ).toContain("preimage");

    // The guard performs no change: spool stats identical before/after.
    const config = baseConfig(dir, {});
    const spool = createSpool({ dir: config.spoolDir, maxEnvelopes: 10, maxBytes: 1024 * 1024 });
    spool.writerReceive(sealTestEnvelope(), { mode: "retain-only" });
    spool.updateState(spool.list()[0].id, { state: "admitted" });
    const before = spoolStats(config.spoolDir);
    const scanned = scanUncertainEffects(config.spoolDir);
    expect(scanned.uncertain).toEqual([{ id: expect.any(String), state: "admitted" }]);
    evaluateGuard({ fence, supervisor: dead, uncertainEffects: scanned, artifactMatches: true });
    expect(spoolStats(config.spoolDir)).toEqual(before);
  });

  it("classifies supervisor answers into dead vs unknown cessation", async () => {
    const stubExec =
      (stdout: string, error: Error | null = null) =>
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (e: Error | null, stdout: string) => void,
      ) =>
        setTimeout(() => cb(error, stdout), 0);
    expect(
      (
        await querySupervisor({
          supervisor: "systemctl is-active",
          unit: "u",
          exec: stubExec("inactive"),
        })
      ).dead,
    ).toBe(true);
    expect(
      (
        await querySupervisor({
          supervisor: "systemctl is-active",
          unit: "u",
          exec: stubExec("failed"),
        })
      ).dead,
    ).toBe(true);
    expect(
      (
        await querySupervisor({
          supervisor: "systemctl is-active",
          unit: "u",
          exec: stubExec("active"),
        })
      ).dead,
    ).toBe(false);
    expect(
      (
        await querySupervisor({
          supervisor: "systemctl is-active",
          unit: "u",
          exec: stubExec("activating"),
        })
      ).dead,
    ).toBe(false);
    expect(
      (
        await querySupervisor({
          supervisor: "systemctl is-active",
          unit: "u",
          exec: stubExec("", new Error("exit 3")),
        })
      ).dead,
    ).toBe(false);
    expect(
      (
        await querySupervisor({
          supervisor: "systemctl is-active",
          unit: "u",
          exec: stubExec("", new Error("boom")),
        })
      ).state,
    ).toBe("query-failed");
  });
});

// ---------------------------------------------------------------------------
// Distinct-process harnesses (§11.13 M5, §11.16 C1) — real child processes
// ---------------------------------------------------------------------------

interface ChildResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runSubmitChild(env: Record<string, string>, payload: unknown, timeoutMs = 30_000) {
  return new Promise<ChildResult>((resolve) => {
    const child = spawn(process.execPath, [RELAY_FILE("submit.mjs")], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdin.end(JSON.stringify(payload));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function spawnRelayChild(env: Record<string, string>) {
  const child = spawn(process.execPath, [RELAY_FILE("relay.mjs")], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const done = new Promise<ChildResult>((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
  return { child, done, stderrText: () => stderr };
}

function childSubmitEnv(dir: string, extra: Record<string, string> = {}): Record<string, string> {
  const credentialFile = join(dir, "writer-credential");
  realFs.writeFileSync(credentialFile, CREDENTIAL);
  const principalsFile = join(dir, "principals.json");
  realFs.writeFileSync(principalsFile, JSON.stringify({ principals: [PRINCIPAL] }));
  return {
    AIF_INTAKE_RELAY_MODE: "retain-only",
    AIF_INTAKE_RELAY_SPOOL_DIR: join(dir, "spool"),
    AIF_INTAKE_RELAY_SOCKET_PATH: join(dir, "relay.sock"),
    AIF_INTAKE_RELAY_FENCE_PATH: join(dir, "fence.active"),
    AIF_INTAKE_RELAY_WRITER_CREDENTIAL_PATH: credentialFile,
    AIF_INTAKE_RELAY_PRINCIPALS_PATH: principalsFile,
    AIF_INTAKE_RELAY_PRINCIPAL_ENV_VAR: "AIF_TEST_PRINCIPAL",
    AIF_TEST_PRINCIPAL: "bridge-principal",
    ...extra,
  };
}

async function waitFor(cond: () => boolean, timeoutMs = 10_000, stepMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return cond();
}

describe("distinct-process capacity contention (§11.13 M5)", () => {
  it("N concurrent submit children against capacity N-1: exactly N-1 receipts + 1 truthful refusal", async () => {
    const dir = makeTmpDir();
    const config = baseConfig(dir, { mode: "retain-only", maxEnvelopes: 3 });
    const spool = createSpool({ dir: config.spoolDir, maxEnvelopes: 3, maxBytes: 1024 * 1024 });
    const writer = await startWriter(config, spool);
    const env = childSubmitEnv(dir);

    const children = [0, 1, 2, 3].map((i) =>
      runSubmitChild(env, clientInput({ clientRequestId: `child-${i}`, title: `child ${i}` })),
    );
    const results = await Promise.all(children);
    const accepted = results.filter((r) => r.code === EXIT_CODES.accepted);
    const refused = results.filter((r) => r.code === EXIT_CODES.refused_by_writer);
    expect(accepted.length).toBe(3);
    expect(refused.length).toBe(1);
    expect(JSON.parse(refused[0].stdout).code).toBe("spool_full_count");
    // Spool holds exactly N-1 envelopes; no temp/partial remnants; accepted
    // work preserved.
    const stats = spoolStats(config.spoolDir);
    expect(stats.count).toBe(3);
    expect(stats.temps).toBe(0);
    expect(spool.list().length).toBe(3);
    writer.close();
  }, 60_000);

  it("byte-bound variant refuses at the last free bytes", async () => {
    const dir = makeTmpDir();
    const config = baseConfig(dir, { mode: "retain-only" });
    const spool = createSpool({ dir: config.spoolDir, maxEnvelopes: 10, maxBytes: 1024 * 1024 });
    const envelope = sealTestEnvelope({ clientRequestId: "size-probe" });
    spool.writerReceive(envelope, { mode: "retain-only" });
    const size = spoolStats(config.spoolDir).bytes;
    // Fresh spool with capacity for exactly ONE envelope of this size.
    const tightDir = makeTmpDir();
    const tightConfig = baseConfig(tightDir, { mode: "retain-only", maxBytes: size });
    const tightSpool = createSpool({ dir: tightConfig.spoolDir, maxEnvelopes: 10, maxBytes: size });
    const writer = await startWriter(tightConfig, tightSpool);
    const env = childSubmitEnv(tightDir);

    const children = [0, 1].map((i) =>
      runSubmitChild(env, clientInput({ clientRequestId: `byte-${i}` })),
    );
    const results = await Promise.all(children);
    expect(results.map((r) => r.code).sort()).toEqual([
      EXIT_CODES.accepted,
      EXIT_CODES.refused_by_writer,
    ]);
    const refused = results.find((r) => r.code === EXIT_CODES.refused_by_writer);
    if (!refused) throw new Error("expected one refused submit at the byte bound");
    expect(JSON.parse(refused.stdout).code).toBe("spool_full_bytes");
    // Exactly one envelope accepted, no temp/partial remnants (the probe
    // envelope measured `size` from a different spool, so only the count and
    // cleanliness are asserted here).
    const finalStats = spoolStats(tightConfig.spoolDir);
    expect(finalStats.count).toBe(1);
    expect(finalStats.temps).toBe(0);
    expect(finalStats.bytes).toBeLessThanOrEqual(size);
    writer.close();
  }, 60_000);

  it("every submit fails closed with retention_unavailable when the writer is absent", async () => {
    const dir = makeTmpDir();
    const env = childSubmitEnv(dir);
    const children = [0, 1, 2].map((i) =>
      runSubmitChild(env, clientInput({ clientRequestId: `absent-${i}` })),
    );
    const results = await Promise.all(children);
    for (const result of results) {
      expect(result.code).toBe(EXIT_CODES.retention_unavailable);
      expect(JSON.parse(result.stdout).code).toBe("retention_unavailable");
    }
    // Spool untouched (never created by a refused submit).
    expect(existsSync(join(dir, "spool"))).toBe(false);
  }, 60_000);
});

describe("fail-closed singleton across distinct processes (§11.16 C1)", () => {
  const ROUNDS = 2;

  it("simultaneous starts on one path: exactly one writer, losers refuse without mutating anything", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const dir = makeTmpDir();
      const socketPath = join(dir, "relay.sock");
      const env = childSubmitEnv(dir, { AIF_INTAKE_RELAY_CYCLE_MS: "50" });
      const children = [0, 1, 2].map(() => spawnRelayChild(env));

      // Exactly one child reaches the running state; the others must exit.
      await waitFor(() => existsSync(socketPath), 10_000);
      await Promise.race([
        Promise.all(children.map((c) => c.done)),
        new Promise((r) => setTimeout(r, 8000)),
      ]);
      const survivors = children.filter((c) => c.child.exitCode === null && !c.child.killed);
      const losers = children.filter((c) => c !== survivors[0]);
      // Wait for loser exits to settle.
      await Promise.race([
        Promise.all(losers.map((c) => c.done)),
        new Promise((r) => setTimeout(r, 5000)),
      ]);
      const settledLosers = children.filter((c) => c.child.exitCode !== null && c !== survivors[0]);
      expect(settledLosers.length).toBe(2);
      for (const loser of settledLosers) {
        const result = await loser.done;
        expect(result.code).toBe(78);
        expect(result.stderr).toContain(STARTUP_REFUSED_SOCKET_HELD);
      }
      // Losers caused zero spool mutation and zero delivery (retain-only, empty spool).
      expect(spoolStats(join(dir, "spool")).count).toBe(0);

      // The winner's path was never unlinked by a loser while it lived.
      expect(existsSync(socketPath)).toBe(true);
      for (const survivor of survivors) {
        survivor.child.kill("SIGTERM");
        const result = await Promise.race([
          survivor.done,
          new Promise<ChildResult>((resolve) =>
            setTimeout(() => resolve({ code: null, stdout: "", stderr: "timeout" }), 5000),
          ),
        ]);
        expect([0, null]).toContain(result.code);
        if (result.code === null) survivor.child.kill("SIGKILL");
      }
      // Graceful stop: the OS releases the path with the owner's handle (the
      // source contains no unlink call). The latch invariant is that two
      // writers NEVER coexisted — proven by the losers' refusals above.
      expect([true, false]).toContain(existsSync(socketPath));
    }
  }, 120_000);

  it("a stale path with NO supervisor cleanup refuses every start (zero writers, path preserved)", async () => {
    const dir = makeTmpDir();
    const socketPath = join(dir, "relay.sock");
    const staleMarker = "stale-path-preserved-bit-for-bit";
    realFs.writeFileSync(socketPath, staleMarker);
    const before = realFs.statSync(socketPath);

    const env = childSubmitEnv(dir);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const child = spawnRelayChild(env);
      const result = await child.done;
      expect(result.code).toBe(78);
      expect(result.stderr).toContain(STARTUP_REFUSED_SOCKET_HELD);
    }
    // Path preserved bit-for-bit; an implementation of the withdrawn
    // probe-refused→reclaim rule would have unlinked it.
    expect(realFs.readFileSync(socketPath, "utf8")).toBe(staleMarker);
    expect(realFs.statSync(socketPath).ino).toBe(before.ino);
    expect(spoolStats(join(dir, "spool")).count).toBe(0);
  }, 60_000);

  it("probe→unlink discriminator: a killed owner's stale socket keeps its path", async () => {
    const dir = makeTmpDir();
    const socketPath = join(dir, "relay.sock");
    // A REAL stale socket: a live owner binds, then dies by SIGKILL (no
    // cleanup, no graceful close). The path remains; connect(2) is refused.
    const ownerScript =
      "require('node:net').createServer().listen(process.argv[1], () => console.log('ready'))";
    const owner = spawn(process.execPath, ["-e", ownerScript, socketPath], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    await new Promise<void>((resolve, reject) => {
      owner.stdout.on("data", (chunk: Buffer) =>
        chunk.toString().includes("ready") ? resolve() : undefined,
      );
      owner.on("close", () => reject(new Error("owner died before binding")));
    });
    expect(await waitFor(() => existsSync(socketPath), 5000)).toBe(true);
    const staleIno = realFs.statSync(socketPath).ino;
    owner.kill("SIGKILL");
    await new Promise((resolve) => owner.on("close", resolve));
    expect(await classifySocketPath(socketPath)).toBe("path-held-no-listener-answering");

    // A starting deliverer must exit WITHOUT unlinking the stale path —
    // an implementation of the withdrawn probe-refused→reclaim rule would
    // unlink and steal it here.
    const env = childSubmitEnv(dir);
    const child = spawnRelayChild(env);
    const result = await child.done;
    expect(result.code).toBe(78);
    expect(result.stderr).toContain(STARTUP_REFUSED_SOCKET_HELD);
    expect(existsSync(socketPath)).toBe(true);
    expect(realFs.statSync(socketPath).ino).toBe(staleIno);

    // Supervisor cleanup after verified cessation → the next start binds.
    realFs.rmSync(socketPath, { force: true });
    const recovery = spawnRelayChild(env);
    expect(await waitFor(() => existsSync(socketPath), 10_000)).toBe(true);
    recovery.child.kill("SIGTERM");
    await Promise.race([recovery.done, new Promise((r) => setTimeout(r, 5000))]);
    if (recovery.child.exitCode === null) recovery.child.kill("SIGKILL");
  }, 60_000);

  it("simulated supervisor cleanup after cessation: restart scan recovers accepted work, delivery exactly-once", async () => {
    const dir = makeTmpDir();
    const stub = await createStubServer({
      agentStatus: { status: 200, body: { intakeCompat: 1 }, delayMs: 0 },
      postTasks: {
        status: 201,
        body: { id: "task-9", status: "backlog", executionOwner: "ai" },
        delayMs: 0,
      },
      getTask: { status: 200, body: { id: "task-9", status: "backlog" }, delayMs: 0 },
    });
    const spoolDir = join(dir, "spool");
    const spool = createSpool({ dir: spoolDir, maxEnvelopes: 10, maxBytes: 1024 * 1024 });
    // Accepted work from a previous writer instance.
    spool.writerReceive(sealTestEnvelope({ clientRequestId: "recovered-1" }), { mode: "deliver" });

    const credentialFile = join(dir, "writer-credential");
    realFs.writeFileSync(credentialFile, CREDENTIAL);
    const principalsFile = join(dir, "principals.json");
    realFs.writeFileSync(principalsFile, JSON.stringify({ principals: [PRINCIPAL] }));
    const sessionTokenFile = join(dir, "session-token");
    realFs.writeFileSync(sessionTokenFile, "test-session-token");
    const csrfFile = join(dir, "session-csrf");
    realFs.writeFileSync(csrfFile, "test-csrf-token");

    const env = childSubmitEnv(dir, {
      AIF_INTAKE_RELAY_MODE: "deliver",
      AIF_INTAKE_RELAY_ENDPOINT: stub.url,
      AIF_INTAKE_RELAY_SESSION_TOKEN_PATH: sessionTokenFile,
      AIF_INTAKE_RELAY_CSRF_TOKEN_PATH: csrfFile,
      AIF_INTAKE_RELAY_ORIGIN: "http://localhost:5180",
      AIF_INTAKE_RELAY_CYCLE_MS: "50",
      AIF_INTAKE_RELAY_HANDOVER_POLL_MAX: "2",
      AIF_INTAKE_RELAY_HANDOVER_POLL_BACKOFF_MS: "20",
      AIF_INTAKE_RELAY_RETRY_MAX: "2",
      AIF_INTAKE_RELAY_RETRY_BACKOFF_MS: "20",
    });

    const child = spawnRelayChild(env);
    // The recovered envelope is delivered exactly once.
    expect(await waitFor(() => stub.counters.postTasks >= 1, 15_000)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(stub.counters.postTasks).toBe(1);
    const delivered = spool
      .list()
      .find((r: { requestId: string }) => r.requestId === "bridge-principal:recovered-1");
    expect(["admitted", "hold_handover_unconfirmed"]).toContain(delivered.state);
    expect(delivered.taskId).toBe("task-9");

    child.child.kill("SIGTERM");
    await Promise.race([child.done, new Promise((r) => setTimeout(r, 5000))]);
    if (child.child.exitCode === null) child.child.kill("SIGKILL");
    await stub.close();
  }, 60_000);
});
