import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { RuntimeTransport } from "../../../types.js";
import { buildSafeWindowsShellCommandLine } from "../../../shellSafety.js";
import { PROXY_ENV_VARS } from "../../../proxyEnv.js";

const IS_WINDOWS = process.platform === "win32";

const ALLOWED_ENV_KEYS = new Set([
  "HOME",
  "USER",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "PATH",
  "SHELL",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TZ",
  "FORCE_COLOR",
  "NO_COLOR",
  "NODE_ENV",
  ...PROXY_ENV_VARS,
]);

const ALLOWED_ENV_PREFIXES = ["OPENAI_", "CODEX_", "AIF_", "HANDOFF_", "LC_", "XDG_"];

/**
 * Env vars never forwarded to the Codex app-server child by default.
 * `OPENAI_API_KEY` / `OPENAI_BASE_URL` are only honored when API-key auth is
 * explicitly opted into via profile `apiKeyEnvVar`/`apiKey` (handled before
 * this set is consulted — see `buildCodexAppServerEnvWithStats`). Mirrors the
 * SDK/CLI transport blocklists so all three local Codex transports isolate
 * ambient OpenAI auth env identically. `NODE_OPTIONS` is always stripped.
 */
const BLOCKED_ENV_KEYS = new Set(["OPENAI_API_KEY", "OPENAI_BASE_URL", "NODE_OPTIONS"]);

const DEFAULT_TERMINATE_TIMEOUT_MS = 1_000;
const DEFAULT_FORCE_KILL_TIMEOUT_MS = 500;
const MAX_STDERR_TAIL_LINES = 50;

export interface CodexAppServerLogger {
  debug?(context: Record<string, unknown>, message: string): void;
  info?(context: Record<string, unknown>, message: string): void;
  warn?(context: Record<string, unknown>, message: string): void;
  error?(context: Record<string, unknown>, message: string): void;
}

export interface CodexAppServerLaunchInput {
  runtimeId: string;
  profileId?: string | null;
  transport?: RuntimeTransport;
  options?: Record<string, unknown>;
  projectRoot?: string;
  cwd?: string;
  apiKey?: string | null;
  apiKeyEnvVar?: string | null;
  baseUrl?: string | null;
}

export interface CodexAppServerEnvironmentStats {
  env: Record<string, string>;
  forwardedCount: number;
  filteredCount: number;
  blockedCount: number;
  droppedDisallowedPrefixKeys: string[];
}

export interface CodexAppServerProcessContext {
  process: ChildProcessWithoutNullStreams;
  stderrTail: string[];
  executablePath: string;
  args: string[];
  cwd?: string;
}

export interface CodexAppServerSpawnOptions {
  input: CodexAppServerLaunchInput;
  logger?: CodexAppServerLogger;
}

export function resolveCodexAppServerExecutable(input: CodexAppServerLaunchInput): string {
  const options = asRecord(input.options);
  const configuredCliPath =
    readString(options.codexCliPath) ?? readString(process.env.CODEX_CLI_PATH);
  return configuredCliPath ?? "codex";
}

export function buildCodexAppServerEnv(input: CodexAppServerLaunchInput): Record<string, string> {
  return buildCodexAppServerEnvWithStats(input).env;
}

export function buildCodexAppServerEnvWithStats(
  input: CodexAppServerLaunchInput,
): CodexAppServerEnvironmentStats {
  const env: Record<string, string> = {};
  let forwardedCount = 0;
  let filteredCount = 0;
  let blockedCount = 0;
  const droppedDisallowedPrefixKeys = new Set<string>();

  const options = asRecord(input.options);
  const explicitApiKeyEnvVar = readString(input.apiKeyEnvVar) ?? readString(options.apiKeyEnvVar);
  const explicitApiKey = readString(input.apiKey) ?? readString(options.apiKey);
  // Local app-server runs default to `codex login` / OAuth. API-key auth is
  // opted into only via an explicit profile apiKeyEnvVar/apiKey — an ambient
  // OPENAI_API_KEY must not be consumed or forwarded, otherwise a placeholder
  // key hijacks the OAuth session.
  const allowApiKey = Boolean(explicitApiKeyEnvVar) || Boolean(explicitApiKey);
  const apiKeyEnvVar = explicitApiKeyEnvVar ?? "OPENAI_API_KEY";

  for (const [key, value] of Object.entries(process.env)) {
    if (value == null) continue;
    // Explicit API-key opt-in: forward the configured key var (which may be
    // OPENAI_API_KEY) before the blocklist, so API-key auth still works when a
    // profile requests it.
    if (key === apiKeyEnvVar && allowApiKey) {
      env[key] = value;
      forwardedCount += 1;
      continue;
    }
    // The configured key var without an opt-in must not leak into the child.
    if (key === apiKeyEnvVar) {
      blockedCount += 1;
      continue;
    }
    // Ambient OpenAI auth env (OPENAI_API_KEY / OPENAI_BASE_URL) is blocked by
    // default so a placeholder key cannot hijack an OAuth-backed `codex login`.
    if (BLOCKED_ENV_KEYS.has(key)) {
      blockedCount += 1;
      continue;
    }
    if (isAllowedEnvironmentKey(key)) {
      env[key] = value;
      forwardedCount += 1;
      continue;
    }
    filteredCount += 1;
    if (key.startsWith("npm_")) {
      droppedDisallowedPrefixKeys.add(key);
    }
  }

  const apiKey = explicitApiKey ?? (allowApiKey ? readString(process.env[apiKeyEnvVar]) : null);
  if (apiKey) {
    env[apiKeyEnvVar] = apiKey;
    env.OPENAI_API_KEY = apiKey;
  }

  const baseUrl =
    readString(input.baseUrl) ??
    readString(options.baseUrl) ??
    readString(process.env.CODEX_BASE_URL);
  if (baseUrl) {
    env.CODEX_BASE_URL = baseUrl;
  }

  // Windows env vars are case-insensitive; mirror proxy key casing to avoid
  // losing one variant when a parent process forwarded only uppercase/lowercase.
  mirrorEnvPair(env, "HTTP_PROXY", "http_proxy");
  mirrorEnvPair(env, "HTTPS_PROXY", "https_proxy");
  mirrorEnvPair(env, "ALL_PROXY", "all_proxy");
  mirrorEnvPair(env, "NO_PROXY", "no_proxy");

  return {
    env,
    forwardedCount,
    filteredCount,
    blockedCount,
    droppedDisallowedPrefixKeys: [...droppedDisallowedPrefixKeys],
  };
}

export function spawnCodexAppServerProcess(
  options: CodexAppServerSpawnOptions,
): CodexAppServerProcessContext {
  const transport = options.input.transport ?? RuntimeTransport.CLI;
  const executablePath = resolveCodexAppServerExecutable(options.input);
  const envStats = buildCodexAppServerEnvWithStats(options.input);
  const cwd = options.input.cwd ?? options.input.projectRoot;
  const args = ["app-server"];

  options.logger?.debug?.(
    {
      runtimeId: options.input.runtimeId,
      profileId: options.input.profileId ?? null,
      transport,
      executablePath,
      cwd: cwd ?? null,
      forwardedEnvCount: envStats.forwardedCount,
      filteredEnvCount: envStats.filteredCount,
      blockedEnvCount: envStats.blockedCount,
      droppedDisallowedPrefixCount: envStats.droppedDisallowedPrefixKeys.length,
      optionKeys: Object.keys(asRecord(options.input.options)),
    },
    "DEBUG [runtime:codex] Starting Codex app-server process over stdio",
  );

  if (envStats.droppedDisallowedPrefixKeys.length > 0) {
    options.logger?.warn?.(
      {
        runtimeId: options.input.runtimeId,
        profileId: options.input.profileId ?? null,
        transport,
        droppedDisallowedPrefixKeys: envStats.droppedDisallowedPrefixKeys.slice(0, 10),
      },
      "WARN [runtime:codex] Dropped disallowed environment prefix keys while building Codex app-server environment",
    );
  }

  const childProcess =
    IS_WINDOWS && !executablePath.toLowerCase().endsWith(".exe")
      ? spawn(
          process.env.ComSpec ?? "cmd.exe",
          ["/d", "/c", buildWindowsAppServerCommandLine(executablePath, args)],
          {
            cwd,
            env: envStats.env,
            stdio: "pipe",
            windowsVerbatimArguments: true,
          },
        )
      : spawn(executablePath, args, {
          cwd,
          env: envStats.env,
          stdio: "pipe",
        });

  const stderrTail: string[] = [];
  childProcess.stderr.on("data", (chunk: Buffer | string) => {
    stderrTail.push(String(chunk));
    while (stderrTail.length > MAX_STDERR_TAIL_LINES) {
      stderrTail.shift();
    }
  });

  return {
    process: childProcess,
    stderrTail,
    executablePath,
    args,
    cwd,
  };
}

export async function terminateCodexAppServerProcess(
  context: CodexAppServerProcessContext,
  logger?: CodexAppServerLogger,
  terminateTimeoutMs = DEFAULT_TERMINATE_TIMEOUT_MS,
  forceKillTimeoutMs = DEFAULT_FORCE_KILL_TIMEOUT_MS,
): Promise<void> {
  if (hasProcessExited(context.process)) {
    return;
  }

  logger?.debug?.(
    {
      executablePath: context.executablePath,
      cwd: context.cwd ?? null,
      terminateTimeoutMs,
    },
    "DEBUG [runtime:codex] Terminating Codex app-server process",
  );

  try {
    context.process.kill("SIGTERM");
  } catch {
    try {
      context.process.kill();
    } catch {
      // ignored
    }
  }

  const exited = await waitForExit(context.process, terminateTimeoutMs);
  if (exited) {
    return;
  }

  logger?.warn?.(
    {
      executablePath: context.executablePath,
      cwd: context.cwd ?? null,
      forceKillTimeoutMs,
    },
    "WARN [runtime:codex] Graceful Codex app-server shutdown timed out, forcing kill",
  );

  try {
    context.process.kill("SIGKILL");
  } catch {
    try {
      context.process.kill();
    } catch {
      // ignored
    }
  }

  const forceExited = await waitForExit(context.process, forceKillTimeoutMs);
  if (!forceExited) {
    logger?.warn?.(
      {
        executablePath: context.executablePath,
        cwd: context.cwd ?? null,
      },
      "WARN [runtime:codex] Codex app-server process did not exit after force kill",
    );
  }
}

function mirrorEnvPair(
  env: Record<string, string>,
  uppercaseKey: string,
  lowercaseKey: string,
): void {
  const value = env[uppercaseKey] ?? env[lowercaseKey];
  if (!value) {
    return;
  }
  env[uppercaseKey] = value;
  env[lowercaseKey] = value;
}

function isAllowedEnvironmentKey(key: string): boolean {
  return ALLOWED_ENV_KEYS.has(key) || ALLOWED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function hasProcessExited(process: ChildProcess): boolean {
  return process.exitCode != null || process.signalCode != null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function waitForExit(
  childProcess: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (hasProcessExited(childProcess)) {
    return true;
  }

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      childProcess.off("exit", onExit);
      childProcess.off("close", onClose);
    };
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const onExit = () => settle(true);
    const onClose = () => settle(true);
    const timer = setTimeout(() => settle(false), timeoutMs);
    childProcess.once("exit", onExit);
    childProcess.once("close", onClose);
  });
}

export function buildWindowsAppServerCommandLine(executablePath: string, args: string[]): string {
  return buildSafeWindowsShellCommandLine(executablePath, args, "Codex app-server");
}
