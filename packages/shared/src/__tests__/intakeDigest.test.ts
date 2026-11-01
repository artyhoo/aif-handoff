import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  INTAKE_CLIENT_REQUEST_ID_MAX,
  INTAKE_COMPAT_LEVEL,
  INTAKE_NAMESPACED_REQUEST_ID_MAX,
  INTAKE_PRINCIPAL_ID_MAX,
  buildIntakeDedupKey,
  canonicalizeIntakePayload,
  computeIntakePayloadDigest,
  isValidIntakeClientRequestId,
  isValidIntakePrincipalId,
  isValidNamespacedIntakeRequestId,
  namespaceIntakeRequestId,
} from "../intakeDigest.js";

const VECTORS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../scripts/workstation/intake-relay/test-vectors/digest-vectors.json",
);

interface DigestVector {
  name: string;
  description: string;
  payload: Record<string, unknown>;
  expectedCanonicalJson: string;
  expectedDigest: string;
}

const vectorsFile: {
  version: number;
  vectors: DigestVector[];
} = JSON.parse(readFileSync(VECTORS_PATH, "utf8"));

describe("intakeDigest frozen client-content digest", () => {
  it("ships pinned vectors for the API and the bridge relay mirror", () => {
    expect(vectorsFile.version).toBe(1);
    expect(vectorsFile.vectors.length).toBeGreaterThanOrEqual(10);
  });

  it.each(vectorsFile.vectors.map((v) => [v.name, v] as const))(
    "vector %s matches the frozen canonicalization",
    (_name, vector) => {
      expect(canonicalizeIntakePayload(vector.payload)).toBe(vector.expectedCanonicalJson);
      expect(computeIntakePayloadDigest(vector.payload)).toBe(vector.expectedDigest);
    },
  );

  it("digests identically for the offset-normalization pair and differently for the changed instant", () => {
    const byName = new Map(vectorsFile.vectors.map((v) => [v.name, v]));
    const a = byName.get("scheduledat-offset-variant-a");
    const b = byName.get("scheduledat-offset-variant-b");
    const later = byName.get("scheduledat-different-instant");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(later).toBeDefined();
    expect(a!.expectedDigest).toBe(b!.expectedDigest);
    expect(a!.expectedDigest).not.toBe(later!.expectedDigest);
  });

  it("digests identically for the sort-tolerant array pair and differently for the element change", () => {
    const byName = new Map(vectorsFile.vectors.map((v) => [v.name, v]));
    const a = byName.get("sort-tolerant-arrays-order-a");
    const b = byName.get("sort-tolerant-arrays-order-b");
    const changed = byName.get("array-element-change");
    expect(a!.expectedDigest).toBe(b!.expectedDigest);
    expect(a!.expectedDigest).not.toBe(changed!.expectedDigest);
  });

  it("digests identically for the nested-object key-order pair", () => {
    const byName = new Map(vectorsFile.vectors.map((v) => [v.name, v]));
    expect(byName.get("nested-object-key-order-a")!.expectedDigest).toBe(
      byName.get("nested-object-key-order-b")!.expectedDigest,
    );
  });

  it("keeps the digest stable when env defaults change between create and replay", () => {
    // The digest covers client content only (§7.3/M2): flipping the env defaults
    // the legacy route would inject must never change it.
    const payload = {
      projectId: "proj-1",
      title: "Env-stable task",
      description: "desc",
    };
    const previousUseSubagents = process.env.AGENT_USE_SUBAGENTS;
    const previousMaxReviewIterations = process.env.AGENT_MAX_REVIEW_ITERATIONS;
    try {
      delete process.env.AGENT_USE_SUBAGENTS;
      delete process.env.AGENT_MAX_REVIEW_ITERATIONS;
      const baseline = computeIntakePayloadDigest(payload);

      process.env.AGENT_USE_SUBAGENTS = "true";
      process.env.AGENT_MAX_REVIEW_ITERATIONS = "9";
      expect(computeIntakePayloadDigest(payload)).toBe(baseline);

      process.env.AGENT_USE_SUBAGENTS = "false";
      process.env.AGENT_MAX_REVIEW_ITERATIONS = "1";
      expect(computeIntakePayloadDigest(payload)).toBe(baseline);

      // Absent optionals are the pinned null sentinel — never the env default.
      expect(canonicalizeIntakePayload(payload)).toContain('"useSubagents":null');
      expect(canonicalizeIntakePayload(payload)).toContain('"maxReviewIterations":null');
    } finally {
      if (previousUseSubagents === undefined) delete process.env.AGENT_USE_SUBAGENTS;
      else process.env.AGENT_USE_SUBAGENTS = previousUseSubagents;
      if (previousMaxReviewIterations === undefined) delete process.env.AGENT_MAX_REVIEW_ITERATIONS;
      else process.env.AGENT_MAX_REVIEW_ITERATIONS = previousMaxReviewIterations;
    }
  });

  it("keeps route/project-derived fields out of the digest (planPath absent stays null)", () => {
    // The route derives planPath from project config and forces plannerMode for
    // parallelEnabled projects (§7.5 step 3); a project-config change between
    // create and replay must not change the digest of identical client bytes.
    const payload = { projectId: "proj-1", title: "Route-stable", description: "d" };
    expect(canonicalizeIntakePayload(payload)).toContain('"planPath":null');
    expect(canonicalizeIntakePayload(payload)).toContain('"plannerMode":null');

    const withExplicitPlanPath = { ...payload, planPath: ".ai-factory/plans/explicit.md" };
    expect(computeIntakePayloadDigest(withExplicitPlanPath)).not.toBe(
      computeIntakePayloadDigest(payload),
    );
  });

  it("normalizes scheduledAt format-level only (no past/future judgment)", () => {
    const future = {
      projectId: "p",
      title: "t",
      description: "d",
      scheduledAt: "2027-01-01T00:00:00Z",
    };
    const past = {
      projectId: "p",
      title: "t",
      description: "d",
      scheduledAt: "2020-01-01T00:00:00Z",
    };
    // Both normalize; the digest does not know or care which is in the past.
    expect(canonicalizeIntakePayload(future)).toContain('"scheduledAt":"2027-01-01T00:00:00.000Z"');
    expect(canonicalizeIntakePayload(past)).toContain('"scheduledAt":"2020-01-01T00:00:00.000Z"');
  });

  it("excludes intake identity and attachments from the digest", () => {
    const base = { projectId: "p", title: "t", description: "d" };
    expect(canonicalizeIntakePayload(base)).not.toContain("intake");
    expect(canonicalizeIntakePayload(base)).not.toContain("attachments");
  });

  it("handles null/undefined payloads as the all-null canonical form", () => {
    expect(canonicalizeIntakePayload(null)).toBe(canonicalizeIntakePayload(undefined));
    expect(canonicalizeIntakePayload(null)).toContain('"title":null');
  });
});

describe("intake identity bounds (§7.4)", () => {
  it("accepts the boundary lengths and rejects one past them", () => {
    expect(INTAKE_CLIENT_REQUEST_ID_MAX).toBe(128);
    expect(INTAKE_PRINCIPAL_ID_MAX).toBe(64);
    expect(INTAKE_NAMESPACED_REQUEST_ID_MAX).toBe(193);

    const maxClient = "a".repeat(128);
    const overClient = "a".repeat(129);
    expect(isValidIntakeClientRequestId(maxClient)).toBe(true);
    expect(isValidIntakeClientRequestId(overClient)).toBe(false);

    const maxPrincipal = "b".repeat(64);
    const overPrincipal = "b".repeat(65);
    expect(isValidIntakePrincipalId(maxPrincipal)).toBe(true);
    expect(isValidIntakePrincipalId(overPrincipal)).toBe(false);

    // 64 + 1 + 128 = 193 accepted; 65 + 1 + 128 = 194 rejected.
    expect(isValidNamespacedIntakeRequestId(`${maxPrincipal}:${maxClient}`)).toBe(true);
    expect(isValidNamespacedIntakeRequestId(`${overPrincipal}:${maxClient}`)).toBe(false);
  });

  it("rejects empty ids, separators, and characters outside the charset", () => {
    for (const bad of ["", "has:colon", "has|pipe", "has space", "héllo", "slash/ed"]) {
      expect(isValidIntakeClientRequestId(bad)).toBe(false);
    }
    expect(isValidIntakeClientRequestId("ok.Id-_1")).toBe(true);
    for (const bad of ["", "no-separator", "a:b:c"]) {
      expect(isValidNamespacedIntakeRequestId(bad)).toBe(false);
    }
  });

  it("encodes the dedup key canonically", () => {
    expect(
      buildIntakeDedupKey({
        principalKind: "participant",
        principalId: "relay-svc",
        projectId: "proj-1",
        requestId: "relay-svc:nightly-1",
      }),
    ).toBe("participant|relay-svc|proj-1|relay-svc:nightly-1");
    expect(namespaceIntakeRequestId("relay-svc", "nightly-1")).toBe("relay-svc:nightly-1");
    expect(INTAKE_COMPAT_LEVEL).toBe(1);
  });
});
