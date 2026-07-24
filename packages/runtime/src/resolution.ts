import { RuntimeResolutionError, RuntimeValidationError } from "./errors.js";
import { isRuntimeTransport, RuntimeTransport } from "./types.js";
import type { RuntimeWorkflowSpec } from "./workflowSpec.js";

export interface RuntimeProfileLike {
  id?: string | null;
  name?: string;
  runtimeId: string;
  providerId: string;
  transport?: string | null;
  baseUrl?: string | null;
  apiKeyEnvVar?: string | null;
  defaultModel?: string | null;
  headers?: Record<string, string>;
  options?: Record<string, unknown>;
  enabled?: boolean;
}

export interface RuntimeResolutionEnv {
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_AUTH_TOKEN?: string;
  ANTHROPIC_BASE_URL?: string;
  ANTHROPIC_MODEL?: string;
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  OPENAI_MODEL?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_BASE_URL?: string;
  OPENROUTER_MODEL?: string;
  CODEX_BASE_URL?: string;
  CODEX_CLI_PATH?: string;
  [key: string]: string | undefined;
}

export interface RuntimeResolutionLogger {
  debug?(context: Record<string, unknown>, message: string): void;
  info?(context: Record<string, unknown>, message: string): void;
  warn?(context: Record<string, unknown>, message: string): void;
}

export interface ResolveRuntimeProfileInput {
  source: string;
  profile: RuntimeProfileLike | null;
  env?: RuntimeResolutionEnv;
  workflow?: RuntimeWorkflowSpec;
  modelOverride?: string | null;
  /** Adapter lightModel — used as fallback between profile.defaultModel and env inference. */
  lightModelFallback?: string | null;
  suppressModelFallback?: boolean;
  runtimeOptionsOverride?: Record<string, unknown> | null;
  fallbackRuntimeId?: string;
  fallbackProviderId?: string;
  allowDisabled?: boolean;
  logger?: RuntimeResolutionLogger;
}

export interface ResolvedRuntimeProfile {
  source: string;
  profileId: string | null;
  runtimeId: string;
  providerId: string;
  transport: RuntimeTransport;
  baseUrl: string | null;
  apiKeyEnvVar: string | null;
  apiKey: string | null;
  model: string | null;
  headers: Record<string, string>;
  options: Record<string, unknown>;
  workflow?: RuntimeWorkflowSpec;
}

function normalizeString(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const ENV_VAR_NAME_REGEX = /^[A-Za-z0-9_.-]+$/;

export function isValidEnvVarName(value: string | null | undefined): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  return ENV_VAR_NAME_REGEX.test(trimmed);
}

function inferDefaultApiKeyEnvVar(
  runtimeId: string,
  providerId: string,
  env: RuntimeResolutionEnv,
): string {
  const runtime = runtimeId.toLowerCase();
  const provider = providerId.toLowerCase();

  if (runtime === "claude" || provider === "anthropic") {
    if (normalizeString(env.ANTHROPIC_API_KEY)) return "ANTHROPIC_API_KEY";
    if (normalizeString(env.ANTHROPIC_AUTH_TOKEN)) return "ANTHROPIC_AUTH_TOKEN";
    return "ANTHROPIC_API_KEY";
  }
  if (runtime === "openrouter" || provider === "openrouter") {
    return "OPENROUTER_API_KEY";
  }
  return "OPENAI_API_KEY";
}

function inferDefaultBaseUrl(
  runtimeId: string,
  providerId: string,
  env: RuntimeResolutionEnv,
  transport: RuntimeTransport,
): string | null {
  const runtime = runtimeId.toLowerCase();
  const provider = providerId.toLowerCase();

  if (runtime === "claude" || provider === "anthropic") {
    return normalizeString(env.ANTHROPIC_BASE_URL);
  }

  if (runtime === "openrouter" || provider === "openrouter") {
    return normalizeString(env.OPENROUTER_BASE_URL) ?? "https://openrouter.ai/api/v1";
  }

  // Local Codex transports (sdk/cli/app-server) must not silently inherit
  // OPENAI_BASE_URL: an OAuth-backed `codex login` session should reach
  // Codex's own backend unless a profile baseUrl or CODEX_BASE_URL opts in.
  if (runtime === "codex" && transport !== RuntimeTransport.API) {
    return normalizeString(env.CODEX_BASE_URL);
  }

  return normalizeString(env.OPENAI_BASE_URL);
}

function inferDefaultTransport(runtimeId: string): RuntimeTransport {
  if (runtimeId.toLowerCase() === "codex") return RuntimeTransport.CLI;
  if (runtimeId.toLowerCase() === "openrouter") return RuntimeTransport.API;
  return RuntimeTransport.SDK;
}

function resolveConfiguredTransport(input: {
  source: string;
  profileId: string | null;
  runtimeId: string;
  rawTransport: string | null;
  logger?: RuntimeResolutionLogger;
}): RuntimeTransport {
  const fallback = inferDefaultTransport(input.runtimeId);
  if (!input.rawTransport) {
    return fallback;
  }

  if (input.rawTransport === "agentapi") {
    input.logger?.warn?.(
      {
        source: input.source,
        profileId: input.profileId,
        runtimeId: input.runtimeId,
        legacyTransport: input.rawTransport,
        normalizedTransport: RuntimeTransport.API,
      },
      "Legacy transport alias detected; normalizing to api",
    );
    return RuntimeTransport.API;
  }

  if (isRuntimeTransport(input.rawTransport)) {
    if (input.rawTransport === RuntimeTransport.APP_SERVER) {
      input.logger?.debug?.(
        {
          source: input.source,
          profileId: input.profileId,
          runtimeId: input.runtimeId,
          transport: input.rawTransport,
          explicit: true,
        },
        "Explicit app-server transport resolved from runtime profile",
      );
    }
    return input.rawTransport;
  }

  input.logger?.warn?.(
    {
      source: input.source,
      profileId: input.profileId,
      runtimeId: input.runtimeId,
      unknownTransport: input.rawTransport,
      fallbackTransport: fallback,
    },
    "Unknown transport value detected; falling back to inferred runtime transport",
  );
  return fallback;
}

function inferDefaultModel(
  runtimeId: string,
  providerId: string,
  env: RuntimeResolutionEnv,
): string | null {
  const runtime = runtimeId.toLowerCase();
  const provider = providerId.toLowerCase();

  if (runtime === "claude" || provider === "anthropic") {
    return normalizeString(env.ANTHROPIC_MODEL);
  }

  if (runtime === "codex" || provider === "openai") {
    return normalizeString(env.OPENAI_MODEL);
  }

  if (runtime === "openrouter" || provider === "openrouter") {
    return normalizeString(env.OPENROUTER_MODEL);
  }

  return null;
}

function resolveApiKey(envVarName: string, env: RuntimeResolutionEnv): string | null {
  return normalizeString(env[envVarName]);
}

function mergeRuntimeOptions(
  base: Record<string, unknown> | undefined,
  override: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  return {
    ...(base ?? {}),
    ...(override ?? {}),
  };
}

function applyTransportDefaults(
  transport: RuntimeTransport,
  options: Record<string, unknown>,
  env: RuntimeResolutionEnv,
): Record<string, unknown> {
  if (transport === RuntimeTransport.CLI) {
    const codexCliPath = normalizeString(env.CODEX_CLI_PATH);
    if (codexCliPath && options.codexCliPath == null) {
      return { ...options, codexCliPath };
    }
  }

  return options;
}

export function resolveRuntimeProfile(input: ResolveRuntimeProfileInput): ResolvedRuntimeProfile {
  const env = input.env ?? (process.env as RuntimeResolutionEnv);
  const profile = input.profile;

  const runtimeId = normalizeString(profile?.runtimeId) ?? normalizeString(input.fallbackRuntimeId);
  const providerId =
    normalizeString(profile?.providerId) ?? normalizeString(input.fallbackProviderId);

  if (!runtimeId || !providerId) {
    throw new RuntimeResolutionError(
      "Unable to resolve runtime profile: runtimeId/providerId are missing",
    );
  }

  if (profile?.enabled === false && !input.allowDisabled) {
    throw new RuntimeValidationError(`Runtime profile "${profile.id ?? "unknown"}" is disabled`);
  }

  const rawTransport = normalizeString(profile?.transport);
  const transport = resolveConfiguredTransport({
    source: input.source,
    profileId: normalizeString(profile?.id),
    runtimeId,
    rawTransport,
    logger: input.logger,
  });
  const explicitApiKeyEnvVar = normalizeString(profile?.apiKeyEnvVar);
  const defaultApiKeyEnvVar = inferDefaultApiKeyEnvVar(runtimeId, providerId, env);
  // Local Codex transports default to `codex login` / OAuth auth. They must not
  // implicitly consume an ambient OPENAI_API_KEY — only an explicit profile
  // apiKeyEnvVar opts a local Codex run into API-key auth.
  const isCodexLocalTransport =
    runtimeId.toLowerCase() === "codex" && transport !== RuntimeTransport.API;
  let apiKeyEnvVar: string | null =
    isCodexLocalTransport && !explicitApiKeyEnvVar ? null : defaultApiKeyEnvVar;
  if (explicitApiKeyEnvVar) {
    if (isValidEnvVarName(explicitApiKeyEnvVar)) {
      apiKeyEnvVar = explicitApiKeyEnvVar;
    } else {
      input.logger?.warn?.(
        {
          source: input.source,
          profileId: normalizeString(profile?.id),
          runtimeId,
          providerId,
          invalidApiKeyEnvVar: explicitApiKeyEnvVar,
          fallbackApiKeyEnvVar: defaultApiKeyEnvVar,
        },
        "Invalid apiKeyEnvVar detected; falling back to inferred default env var",
      );
    }
  }
  let apiKey = apiKeyEnvVar ? resolveApiKey(apiKeyEnvVar, env) : null;
  if (
    !apiKey &&
    explicitApiKeyEnvVar &&
    apiKeyEnvVar !== defaultApiKeyEnvVar &&
    !isCodexLocalTransport
  ) {
    const fallbackApiKey = resolveApiKey(defaultApiKeyEnvVar, env);
    if (fallbackApiKey) {
      input.logger?.warn?.(
        {
          source: input.source,
          profileId: normalizeString(profile?.id),
          runtimeId,
          providerId,
          missingApiKeyEnvVar: apiKeyEnvVar,
          fallbackApiKeyEnvVar: defaultApiKeyEnvVar,
        },
        "Configured apiKeyEnvVar is not set; falling back to inferred default env var",
      );
      apiKeyEnvVar = defaultApiKeyEnvVar;
      apiKey = fallbackApiKey;
    }
  }
  const baseUrl =
    normalizeString(profile?.baseUrl) ?? inferDefaultBaseUrl(runtimeId, providerId, env, transport);
  const model =
    input.suppressModelFallback === true
      ? null
      : (normalizeString(input.modelOverride) ??
        normalizeString(profile?.defaultModel) ??
        normalizeString(input.lightModelFallback) ??
        inferDefaultModel(runtimeId, providerId, env));
  const headers = profile?.headers ?? {};
  const mergedOptions = mergeRuntimeOptions(profile?.options, input.runtimeOptionsOverride);
  const options = applyTransportDefaults(transport, mergedOptions, env);

  const resolved: ResolvedRuntimeProfile = {
    source: input.source,
    profileId: normalizeString(profile?.id),
    runtimeId,
    providerId,
    transport,
    baseUrl,
    apiKeyEnvVar,
    apiKey,
    model,
    headers,
    options,
    workflow: input.workflow,
  };

  input.logger?.debug?.(
    {
      source: input.source,
      profileId: resolved.profileId,
      runtimeId: resolved.runtimeId,
      providerId: resolved.providerId,
      transport: resolved.transport,
      hasBaseUrl: Boolean(resolved.baseUrl),
      hasApiKey: Boolean(resolved.apiKey),
      model: resolved.model,
      suppressModelFallback: input.suppressModelFallback === true,
      optionKeys: Object.keys(resolved.options),
    },
    "Resolved runtime profile",
  );

  return resolved;
}

export interface RuntimeValidationResult {
  ok: boolean;
  message: string;
  warnings: string[];
}

export function validateResolvedRuntimeProfile(
  resolved: ResolvedRuntimeProfile,
): RuntimeValidationResult {
  const warnings: string[] = [];

  // API transport requires both key and base URL
  if (resolved.transport === RuntimeTransport.API) {
    if (!resolved.apiKey) {
      warnings.push(
        `Missing API key env var ${resolved.apiKeyEnvVar ?? "unknown"} for runtime "${resolved.runtimeId}" (API transport)`,
      );
    }
    if (!resolved.baseUrl && typeof resolved.options.agentApiBaseUrl !== "string") {
      warnings.push("API transport requires a base URL (set profile baseUrl or OPENAI_BASE_URL)");
    }
  }

  // CLI transport requires a CLI path
  if (
    (resolved.transport === RuntimeTransport.CLI ||
      resolved.transport === RuntimeTransport.APP_SERVER) &&
    typeof resolved.options.codexCliPath !== "string"
  ) {
    warnings.push(
      `${
        resolved.transport === RuntimeTransport.APP_SERVER ? "app-server" : "CLI"
      } transport is selected but codexCliPath is missing`,
    );
  }

  // SDK transport — API key is optional (CLI-backed SDKs manage auth via their own login flow)

  const ok = warnings.length === 0;
  return {
    ok,
    message: ok ? "Runtime profile validation passed" : "Runtime profile validation has warnings",
    warnings,
  };
}

export function redactResolvedRuntimeProfile(
  resolved: ResolvedRuntimeProfile,
): Record<string, unknown> {
  return {
    source: resolved.source,
    profileId: resolved.profileId,
    runtimeId: resolved.runtimeId,
    providerId: resolved.providerId,
    transport: resolved.transport,
    baseUrl: resolved.baseUrl,
    apiKeyEnvVar: resolved.apiKeyEnvVar,
    hasApiKey: Boolean(resolved.apiKey),
    model: resolved.model,
    headers: Object.keys(resolved.headers),
    optionKeys: Object.keys(resolved.options),
    workflowKind: resolved.workflow?.workflowKind ?? null,
  };
}
