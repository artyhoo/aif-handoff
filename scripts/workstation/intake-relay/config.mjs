// Bridge intake relay configuration (plan p2-wake-on-work, Slice B).
//
// Dependency-free Node ESM. Every operational value is parameterized; real
// host values (socket paths, credential paths, principals) live ONLY in
// owner-installed files outside this repository — this module validates the
// shape and the invariants, it never embeds them.
//
// Fail-closed invariants enforced here:
//   • mode defaults to `retain-only` — no endpoint, no delivery, no wake;
//   • the writer credential path is REQUIRED in every mode (§9.2/R3-S1):
//     there is no configuration in which the writer accepts an
//     unauthenticated request, retain-only included;
//   • `deliver` mode additionally requires the endpoint, the session-token
//     file, and an allowed origin for the CSRF/Origin checks.

export const MODES = ["retain-only", "deliver"];

import { readFileSync } from "node:fs";

const POSITIVE_INT_DEFAULTS = {
  intakeCompatLevel: 1,
  maxEnvelopes: 1000,
  maxBytes: 50 * 1024 * 1024,
  defaultMaxRequestBytes: 512 * 1024,
  cycleMs: 5000,
  retryMax: 5,
  retryBackoffMs: 2000,
  wakeMaxRepeats: 3,
  wakeBackoffMs: 30_000,
  wakeWindowMs: 60_000,
  handoverPollMax: 20,
  handoverPollBackoffMs: 2000,
};

const ENV_DEFAULTS = {
  spoolDir: "/var/lib/aif-intake-relay/spool",
  socketPath: "/var/lib/aif-intake-relay/relay.sock",
  fencePath: "/var/lib/aif-intake-relay/fence.active",
  writerCredentialPath: "",
  principalsPath: "",
  sessionTokenPath: "",
  csrfTokenPath: "",
  sessionCookieName: "aif_participant_session",
  origin: "",
  wakeCommand: "",
  sshAuthInfoPath: "",
  principalEnvVar: "",
};

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
    this.code = "config_invalid";
  }
}

function readPositiveInt(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${name} must be a positive integer (got ${JSON.stringify(raw)})`);
  }
  return value;
}

/**
 * Build the validated relay configuration. `env` supplies overrides
 * (`AIF_INTAKE_RELAY_*`); `overrides` (used by tests) wins over env.
 */
export function loadConfig({ env = process.env, overrides = {} } = {}) {
  const get = (name) => {
    if (overrides[name] !== undefined) return overrides[name];
    const envName = `AIF_INTAKE_RELAY_${name.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;
    return env[envName];
  };

  const mode = get("mode") ?? "retain-only";
  if (!MODES.includes(mode)) {
    throw new ConfigError(`mode must be one of ${MODES.join(" | ")} (got ${JSON.stringify(mode)})`);
  }

  const config = {
    mode,
    spoolDir: get("spoolDir") ?? ENV_DEFAULTS.spoolDir,
    socketPath: get("socketPath") ?? ENV_DEFAULTS.socketPath,
    fencePath: get("fencePath") ?? ENV_DEFAULTS.fencePath,
    // Mandatory in EVERY mode (§9.2/R3-S1) — no default, no insecure fallback.
    writerCredentialPath: get("writerCredentialPath") ?? "",
    principalsPath: get("principalsPath") ?? "",
    sessionTokenPath: get("sessionTokenPath") ?? "",
    // Session-bound CSRF token for POST /tasks (API csrf middleware requires
    // x-csrf-token verified against the session). Owner-installed 0600 file.
    csrfTokenPath: get("csrfTokenPath") ?? "",
    sessionCookieName: get("sessionCookieName") ?? ENV_DEFAULTS.sessionCookieName,
    origin: get("origin") ?? "",
    endpoint: get("endpoint") ?? "",
    wakeCommand: get("wakeCommand") ?? "",
    sshAuthInfoPath: get("sshAuthInfoPath") ?? "",
    // Documented fallback with a trust caveat (R1): only a per-key
    // `environment=` variable explicitly configured here is ever consulted,
    // and only when the ExposeAuthInfo identity file is unavailable.
    principalEnvVar: get("principalEnvVar") ?? "",
  };

  for (const [key, fallback] of Object.entries(POSITIVE_INT_DEFAULTS)) {
    // Overrides (tests / embedding callers) win over env; env wins over the
    // built-in default.
    config[key] =
      overrides[key] ?? readPositiveInt(env, `AIF_INTAKE_RELAY_${camelToSnake(key)}`, fallback);
  }

  // --- Fail-closed validation (§5, §9.2) --------------------------------
  if (!config.socketPath) throw new ConfigError("socketPath is required");
  if (!config.spoolDir) throw new ConfigError("spoolDir is required");
  if (!config.writerCredentialPath) {
    throw new ConfigError(
      "writerCredentialPath is required in every mode — the relay never runs an unauthenticated writer",
    );
  }
  if (!config.principalsPath) throw new ConfigError("principalsPath is required");

  if (mode === "deliver") {
    if (!config.endpoint) {
      throw new ConfigError("deliver mode requires endpoint (PC-local reverse-forward URL)");
    }
    if (!config.sessionTokenPath) {
      throw new ConfigError(
        "deliver mode requires sessionTokenPath (relay service participant session)",
      );
    }
    if (!config.csrfTokenPath) {
      throw new ConfigError(
        "deliver mode requires csrfTokenPath (session-bound CSRF token for POST /tasks)",
      );
    }
    if (!config.origin) {
      throw new ConfigError("deliver mode requires origin (allowed Origin for the API CSRF check)");
    }
    if (!/^https?:\/\//.test(config.endpoint)) {
      throw new ConfigError(
        `endpoint must be an http(s) URL (got ${JSON.stringify(config.endpoint)})`,
      );
    }
  }

  return config;
}

function camelToSnake(name) {
  return name.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase();
}

/**
 * Load the operator-owned principal map: fingerprint → principal entry.
 * The map file is owner-installed, service-user readable only; its values are
 * the authoritative principal identities (R1) — client-claimed principal
 * fields are always overwritten, never read.
 */
export function loadPrincipalMap(path, { readFileSync: read = readFileSync } = {}) {
  let raw;
  try {
    raw = read(path, "utf8");
  } catch (error) {
    throw new ConfigError(`principal map unreadable at ${path}: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`principal map is not valid JSON: ${error.message}`);
  }
  const principals = Array.isArray(parsed?.principals) ? parsed.principals : null;
  if (!principals) {
    throw new ConfigError("principal map must be { principals: [...] }");
  }
  const map = new Map();
  for (const entry of principals) {
    if (!entry || typeof entry.fingerprint !== "string" || typeof entry.principalId !== "string") {
      throw new ConfigError("each principal entry needs fingerprint and principalId");
    }
    if (!Array.isArray(entry.allowedProjects) || typeof entry.maxRequestBytes !== "number") {
      throw new ConfigError(
        `principal ${entry.principalId} needs allowedProjects[] and maxRequestBytes`,
      );
    }
    map.set(entry.fingerprint, entry);
  }
  return map;
}
