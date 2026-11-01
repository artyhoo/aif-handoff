import { createHash } from "node:crypto";

/**
 * Keyed intake identity encoding (§7.4) and frozen client-content digest (§7.3)
 * for authenticated durable task intake (plan p2-wake-on-work).
 *
 * Two invariants matter here:
 *
 * 1. **One encoding everywhere.** The bridge envelope validator and the API
 *    schema must accept exactly the same request identities, so the bounds and
 *    the dedup-key encoding live here and are re-exported to both.
 * 2. **Frozen client content.** The digest is computed over the *client-supplied*
 *    create-payload fields only. Absent optional fields canonicalize to a pinned
 *    sentinel (`null`) — never to env defaults (`AGENT_USE_SUBAGENTS`,
 *    `AGENT_MAX_REVIEW_ITERATIONS`), route defaults (`planPath` from project
 *    config), forced values (`parallelEnabled → plannerMode`), or mode-driven
 *    flag defaults — so a changed environment, project config, or route default
 *    can never change the digest of identical original bytes (round-2 M2).
 *
 * The bridge relay ships a dependency-free mirror of `canonicalizeIntakePayload`
 * (`scripts/workstation/intake-relay/envelope.mjs`); the pinned vectors in
 * `scripts/workstation/intake-relay/test-vectors/digest-vectors.json` are shared
 * by both test suites so drift between the two implementations is caught by CI.
 */

/** Contract level of the keyed intake API. Bumped on breaking changes (§9.3). */
export const INTAKE_COMPAT_LEVEL = 1;

export const INTAKE_CLIENT_REQUEST_ID_MAX = 128;
export const INTAKE_PRINCIPAL_ID_MAX = 64;
/** `principalId:clientRequestId` — 64 + 1 + 128 = 193 (hard max, §7.4). */
export const INTAKE_NAMESPACED_REQUEST_ID_MAX = 193;

/** Client request IDs and principal IDs share one charset: `[A-Za-z0-9._-]`. */
export const INTAKE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Namespaced request ID: one `:` separator, bounded principal + client parts. */
export const INTAKE_NAMESPACED_REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}:[A-Za-z0-9._-]{1,128}$/;

/** Canonical dedup-key separator (`principalKind|principalId|projectId|requestId`). */
export const INTAKE_DEDUP_KEY_SEPARATOR = "|";

export function isValidIntakeClientRequestId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= INTAKE_CLIENT_REQUEST_ID_MAX &&
    INTAKE_ID_PATTERN.test(value)
  );
}

export function isValidIntakePrincipalId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= INTAKE_PRINCIPAL_ID_MAX &&
    INTAKE_ID_PATTERN.test(value)
  );
}

export function isValidNamespacedIntakeRequestId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= INTAKE_NAMESPACED_REQUEST_ID_MAX &&
    INTAKE_NAMESPACED_REQUEST_ID_PATTERN.test(value)
  );
}

export interface IntakeIdentityInput {
  principalKind: "participant" | "internal";
  principalId: string;
  projectId: string;
  requestId: string;
}

/** Canonical dedup key — the exact encoding stored in `task_intake_bindings.dedup_key`. */
export function buildIntakeDedupKey(input: IntakeIdentityInput): string {
  return [input.principalKind, input.principalId, input.projectId, input.requestId].join(
    INTAKE_DEDUP_KEY_SEPARATOR,
  );
}

/** Namespaced request ID (`${principalId}:${clientRequestId}`) — one encoding at both ends. */
export function namespaceIntakeRequestId(principalId: string, clientRequestId: string): string {
  return `${principalId}:${clientRequestId}`;
}

/**
 * Client-supplied create-payload fields covered by the frozen digest, in sorted
 * (canonical) order. `intake` and `attachments` are excluded by contract (§7.3):
 * the intake identity lives in the dedup key, and attachments are rejected on
 * the keyed path before any acceptance.
 */
const INTAKE_DIGEST_FIELDS = [
  "assigneeIds",
  "autoMode",
  "autoQa",
  "description",
  "executionOwner",
  "isFix",
  "maxReviewIterations",
  "modelOverride",
  "paused",
  "planDocs",
  "planPath",
  "planTests",
  "plannerMode",
  "priority",
  "projectId",
  "roadmapAlias",
  "runPlanImprove",
  "runPostVerify",
  "runtimeOptions",
  "runtimeProfileId",
  "scheduledAt",
  "skipReview",
  "tags",
  "title",
  "useSubagents",
] as const;

/** Arrays whose element order is not identity-bearing; sorted before digest. */
const INTAKE_SORT_TOLERANT_ARRAY_FIELDS: ReadonlySet<string> = new Set(["assigneeIds", "tags"]);

/** Format-level ISO-8601 normalization to UTC `Z` — no past/future judgment here. */
function normalizeIsoToUtcZ(value: string): string {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
}

function canonicalizeValue(
  field: string,
  value: unknown,
): string | number | boolean | null | unknown[] | Record<string, unknown> {
  if (value === undefined) return null;
  if (typeof value === "string") {
    return field === "scheduledAt" ? normalizeIsoToUtcZ(value) : value;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    const canonicalItems = value.map((item) => canonicalizeValue("", item));
    return INTAKE_SORT_TOLERANT_ARRAY_FIELDS.has(field)
      ? canonicalItems.sort((a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0))
      : canonicalItems;
  }
  if (typeof value === "object") {
    // Nested records (e.g. `runtimeOptions`): sort keys so property order in the
    // client JSON never changes the digest of identical content.
    const source = value as Record<string, unknown>;
    const canonical: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      canonical[key] = canonicalizeValue("", source[key]);
    }
    return canonical;
  }
  return null;
}

/**
 * Canonical JSON over the client-supplied create-payload fields (§7.3): absent
 * optional fields become the pinned `null` sentinel, `scheduledAt` is included
 * in normalized UTC-Z form when present, and the declared sort-tolerant arrays
 * (`assigneeIds`, `tags`) are sorted. Deterministic across key order and
 * whitespace variants of the client JSON.
 */
export function canonicalizeIntakePayload(
  payload: Record<string, unknown> | null | undefined,
): string {
  const canonical: Record<string, unknown> = {};
  for (const field of INTAKE_DIGEST_FIELDS) {
    canonical[field] = canonicalizeValue(field, payload?.[field]);
  }
  return JSON.stringify(canonical);
}

/** Server-computed sha256 hex digest of the frozen client-content canonicalization. */
export function computeIntakePayloadDigest(
  payload: Record<string, unknown> | null | undefined,
): string {
  return createHash("sha256").update(canonicalizeIntakePayload(payload)).digest("hex");
}
