// Intake envelope: validation, authoritative principal stamping, namespacing,
// and the dependency-free frozen-digest mirror (plan p2-wake-on-work §7.3/§7.4).
//
// `canonicalizeIntakePayload` below MUST stay a byte-exact mirror of
// packages/shared/src/intakeDigest.ts — the pinned vectors in
// test-vectors/digest-vectors.json are executed against BOTH implementations
// by the test suites, so drift between them fails CI.

import { createHash, timingSafeEqual } from "node:crypto";

export const CLIENT_REQUEST_ID_MAX = 128;
export const PRINCIPAL_ID_MAX = 64;
export const NAMESPACED_REQUEST_ID_MAX = 193;
export const ID_PATTERN = /^[A-Za-z0-9._-]+$/;
export const NAMESPACED_REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}:[A-Za-z0-9._-]{1,128}$/;
export const DEDUP_KEY_SEPARATOR = "|";

export class EnvelopeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EnvelopeError";
    this.code = code;
  }
}

export function isValidClientRequestId(value) {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= CLIENT_REQUEST_ID_MAX &&
    ID_PATTERN.test(value)
  );
}

export function isValidPrincipalId(value) {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= PRINCIPAL_ID_MAX &&
    ID_PATTERN.test(value)
  );
}

export function isValidNamespacedRequestId(value) {
  return (
    typeof value === "string" &&
    value.length <= NAMESPACED_REQUEST_ID_MAX &&
    NAMESPACED_REQUEST_ID_PATTERN.test(value)
  );
}

export function buildDedupKey({ principalKind, principalId, projectId, requestId }) {
  return [principalKind, principalId, projectId, requestId].join(DEDUP_KEY_SEPARATOR);
}

export function namespaceRequestId(principalId, clientRequestId) {
  return `${principalId}:${clientRequestId}`;
}

// ---- Frozen client-content digest (mirror of shared intakeDigest) ----------

const DIGEST_FIELDS = [
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
];

const SORT_TOLERANT_ARRAY_FIELDS = new Set(["assigneeIds", "tags"]);

function normalizeIsoToUtcZ(value) {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
}

function canonicalizeValue(field, value) {
  if (value === undefined) return null;
  if (typeof value === "string") {
    return field === "scheduledAt" ? normalizeIsoToUtcZ(value) : value;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalizeValue("", item));
    return SORT_TOLERANT_ARRAY_FIELDS.has(field)
      ? items.sort((a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0))
      : items;
  }
  if (typeof value === "object") {
    const canonical = {};
    for (const key of Object.keys(value).sort()) {
      canonical[key] = canonicalizeValue("", value[key]);
    }
    return canonical;
  }
  return null;
}

export function canonicalizeIntakePayload(payload) {
  const canonical = {};
  for (const field of DIGEST_FIELDS) {
    canonical[field] = canonicalizeValue(field, payload?.[field]);
  }
  return JSON.stringify(canonical);
}

export function computeIntakePayloadDigest(payload) {
  return createHash("sha256").update(canonicalizeIntakePayload(payload)).digest("hex");
}

// ---- Envelope construction / validation -----------------------------------

/**
 * Stamp the authoritative principal onto the envelope and validate every
 * invariant BEFORE retention or wake (R1 scope-before-retention):
 *   • principal from the resolver output (client-claimed fields overwritten);
 *   • §7.4 identity bounds (identical encoding to the API);
 *   • payload size within the principal's maxRequestBytes;
 *   • projectId within the principal's allowedProjects;
 *   • attachments absent/empty;
 *   • scheduledAt, when present, is an ISO-8601 instant.
 * Returns the sealed envelope — identity and digest are immutable afterwards
 * (§7.4): every retry re-sends the byte-identical body.
 */
export function sealEnvelope({ input, principal, principalKind = "participant", nowIso }) {
  if (!principal || !isValidPrincipalId(principal.principalId)) {
    throw new EnvelopeError("principal_unknown", "resolver produced no valid principal id");
  }
  const projectId = input.projectId;
  if (typeof projectId !== "string" || projectId.length === 0) {
    throw new EnvelopeError("project_required", "projectId is required");
  }
  if (!principal.allowedProjects.includes(projectId)) {
    throw new EnvelopeError(
      "project_not_allowed",
      `project ${projectId} is not in the allowed set for principal ${principal.principalId}`,
    );
  }
  const clientRequestId = input.clientRequestId;
  if (!isValidClientRequestId(clientRequestId)) {
    throw new EnvelopeError(
      "request_id_invalid",
      "clientRequestId must be 1-128 chars of [A-Za-z0-9._-]",
    );
  }
  if (typeof input.title !== "string" || input.title.length < 1 || input.title.length > 500) {
    throw new EnvelopeError("title_invalid", "title must be 1-500 chars");
  }
  const attachments = input.attachments ?? [];
  if (!Array.isArray(attachments) || attachments.length > 0) {
    throw new EnvelopeError("attachments_unavailable", "keyed intake does not accept attachments");
  }
  if (input.scheduledAt !== undefined && input.scheduledAt !== null) {
    if (typeof input.scheduledAt !== "string" || Number.isNaN(Date.parse(input.scheduledAt))) {
      throw new EnvelopeError("scheduled_at_invalid", "scheduledAt must be an ISO-8601 instant");
    }
  }
  const bodyBytes = Buffer.byteLength(JSON.stringify(input), "utf8");
  const maxRequestBytes = principal.maxRequestBytes;
  if (bodyBytes > maxRequestBytes) {
    throw new EnvelopeError(
      "payload_too_large",
      `payload is ${bodyBytes} bytes; principal allows ${maxRequestBytes}`,
    );
  }

  const requestId = namespaceRequestId(principal.principalId, clientRequestId);
  if (!isValidNamespacedRequestId(requestId)) {
    throw new EnvelopeError(
      "request_id_invalid",
      `namespaced request id out of bounds: ${requestId.length}`,
    );
  }

  const createPayload = { ...input };
  delete createPayload.clientRequestId;
  delete createPayload.attachments;

  return Object.freeze({
    principal: Object.freeze({ ...principal, principalKind }),
    projectId,
    requestId,
    clientRequestId,
    body: Object.freeze(createPayload),
    bodyBytes,
    digest: computeIntakePayloadDigest(createPayload),
    dedupKey: buildDedupKey({
      principalKind,
      principalId: principal.principalId,
      projectId,
      requestId,
    }),
    sealedAt: nowIso ?? new Date().toISOString(),
  });
}

/** Constant-time credential comparison (§9.2). */
export function credentialsMatch(candidate, expected) {
  if (typeof candidate !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(candidate, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    // Length differences leak at most the length — still run a comparison over
    // equal-length buffers to keep the timing profile uniform.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Writer-side revalidation (§9.2): an authenticated request still re-checks
 * every envelope invariant against the writer's own copy of the operator map
 * before any quota reservation. Returns the re-checked principal or throws.
 */
export function revalidateSealedEnvelope(envelope, principalMap, defaults) {
  if (!envelope || typeof envelope !== "object") {
    throw new EnvelopeError("envelope_invalid", "malformed envelope");
  }
  const principal = principalMap.get(envelope.principal?.fingerprint);
  if (!principal || principal.principalId !== envelope.principal?.principalId) {
    throw new EnvelopeError("principal_unknown", "stamped principal is not in the operator map");
  }
  const principalKind = envelope.principal?.principalKind;
  if (principalKind !== "participant" && principalKind !== "internal") {
    throw new EnvelopeError("principal_kind_invalid", "unknown principal kind");
  }
  if (!isValidNamespacedRequestId(envelope.requestId)) {
    throw new EnvelopeError("request_id_invalid", "namespaced request id out of bounds");
  }
  const recomputedDedupKey = buildDedupKey({
    principalKind,
    principalId: principal.principalId,
    projectId: envelope.projectId,
    requestId: envelope.requestId,
  });
  if (envelope.dedupKey !== recomputedDedupKey) {
    throw new EnvelopeError("dedup_key_invalid", "dedup key does not match the identity fields");
  }
  if (envelope.bodyBytes > principal.maxRequestBytes) {
    throw new EnvelopeError("payload_too_large", "payload exceeds the principal bound");
  }
  if (!principal.allowedProjects.includes(envelope.projectId)) {
    throw new EnvelopeError("project_not_allowed", "project outside the principal scope");
  }
  // Attachments are unavailable on the keyed path — a sealed body never
  // carries them, so a forged body with non-empty attachments is refused
  // here too (writer-side invariant, §9.2).
  const attachments = envelope.body?.attachments;
  if (Array.isArray(attachments) && attachments.length > 0) {
    throw new EnvelopeError("attachments_unavailable", "keyed intake does not accept attachments");
  }
  const recomputed = computeIntakePayloadDigest(envelope.body);
  if (recomputed !== envelope.digest) {
    throw new EnvelopeError("digest_mismatch", "frozen digest does not match the sealed body");
  }
  void defaults;
  return principal;
}
