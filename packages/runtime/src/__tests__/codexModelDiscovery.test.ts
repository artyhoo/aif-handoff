import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCodexAppServerDiscoveryEnv,
  startCodexAppServerWithRetry,
} from "../adapters/codex/modelDiscovery.js";

function createModelDiscoveryInput() {
  return {
    runtimeId: "codex",
    providerId: "openai",
    profileId: "profile-1",
    options: {},
  };
}

describe("codex app-server model discovery env", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not forward ambient OPENAI_BASE_URL into app-server discovery env", () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-env");
    vi.stubEnv("OPENAI_BASE_URL", "https://deprecated.example.com/v1");
    vi.stubEnv("npm_config_registry", "https://registry.npmjs.org");

    const env = buildCodexAppServerDiscoveryEnv({
      runtimeId: "codex",
      providerId: "openai",
      profileId: "profile-1",
      options: {},
      // Explicit API-key opt-in: ambient OPENAI_API_KEY is otherwise blocked so
      // OAuth-backed discovery is not hijacked. This test asserts OPENAI_BASE_URL
      // is stripped regardless of the key being present.
      apiKeyEnvVar: "OPENAI_API_KEY",
    });

    expect(env.OPENAI_API_KEY).toBe("sk-env");
    expect(env.OPENAI_BASE_URL).toBeUndefined();
    expect(env.npm_config_registry).toBeUndefined();
  });

  it("does not consume ambient OPENAI_API_KEY for discovery without an opt-in", () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-000");

    const env = buildCodexAppServerDiscoveryEnv({
      runtimeId: "codex",
      providerId: "openai",
      profileId: "profile-1",
      options: {},
    });

    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("maps an explicit discovery baseUrl to CODEX_BASE_URL only", () => {
    vi.stubEnv("OPENAI_BASE_URL", "https://deprecated.example.com/v1");

    const env = buildCodexAppServerDiscoveryEnv({
      runtimeId: "codex",
      providerId: "openai",
      profileId: "profile-1",
      baseUrl: "https://runtime.example.com/v1",
      options: {},
    });

    expect(env.CODEX_BASE_URL).toBe("https://runtime.example.com/v1");
    expect(env.OPENAI_BASE_URL).toBeUndefined();
  });
});

describe("codex app-server startup retry", () => {
  function getRetryWarnings(logger: { warn: ReturnType<typeof vi.fn> }) {
    return logger.warn.mock.calls.filter(
      (call) => call[1] === "WARN [runtime:codex] Codex app-server stdio startup failed, retrying",
    );
  }

  it("retries startup when the first stdio initialize attempt fails", async () => {
    const firstLaunch = {
      process: { pid: 101 } as never,
      stderrTail: ["first failure details"],
      executablePath: "codex",
      args: ["app-server"],
      cwd: undefined,
    };
    const secondLaunch = {
      process: { pid: 102 } as never,
      stderrTail: [],
      executablePath: "codex",
      args: ["app-server"],
      cwd: undefined,
    };
    const spawnCodexAppServer = vi
      .fn()
      .mockReturnValueOnce(firstLaunch)
      .mockReturnValueOnce(secondLaunch);
    const connectJsonRpcClient = vi
      .fn()
      .mockRejectedValueOnce(new Error("stdio connect failed"))
      .mockResolvedValueOnce({
        request: vi.fn().mockResolvedValue({}),
        close: vi.fn(),
      });
    const terminateProcess = vi.fn().mockResolvedValue(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const logger = {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const startup = await startCodexAppServerWithRetry(createModelDiscoveryInput(), logger, {
      spawnCodexAppServer,
      connectJsonRpcClient,
      terminateProcess,
      sleep,
    });

    expect(startup.attempt).toBe(2);
    expect(startup.executablePath).toBe("codex");
    expect(terminateProcess).toHaveBeenCalledTimes(1);
    expect(terminateProcess).toHaveBeenCalledWith(firstLaunch);
    expect(getRetryWarnings(logger)).toHaveLength(1);
    expect(logger.error).not.toHaveBeenCalled();
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("logs error and throws after startup retries are exhausted", async () => {
    const launch = {
      process: { pid: 777 } as never,
      stderrTail: ["fatal startup stderr"],
      executablePath: "codex",
      args: ["app-server"],
      cwd: undefined,
    };
    const spawnCodexAppServer = vi.fn().mockReturnValue({
      ...launch,
    });
    const connectJsonRpcClient = vi.fn().mockRejectedValue(new Error("initialize timeout"));
    const terminateProcess = vi.fn().mockResolvedValue(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const logger = {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    await expect(
      startCodexAppServerWithRetry(createModelDiscoveryInput(), logger, {
        spawnCodexAppServer,
        connectJsonRpcClient,
        terminateProcess,
        sleep,
      }),
    ).rejects.toThrow("fatal startup stderr");

    expect(connectJsonRpcClient).toHaveBeenCalledTimes(3);
    expect(terminateProcess).toHaveBeenCalledTimes(3);
    expect(getRetryWarnings(logger)).toHaveLength(2);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
