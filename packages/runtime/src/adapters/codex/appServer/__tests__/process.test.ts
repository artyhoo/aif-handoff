import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCodexAppServerEnv,
  buildWindowsAppServerCommandLine,
  hasProcessExited,
  resolveCodexAppServerExecutable,
  terminateCodexAppServerProcess,
} from "../process.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("codex app-server process helpers", () => {
  it("resolves executable from options, env, then installed codex on PATH", () => {
    expect(
      resolveCodexAppServerExecutable({
        runtimeId: "codex",
        options: { codexCliPath: "/custom/codex" },
        transport: "sdk",
      }),
    ).toBe("/custom/codex");

    vi.stubEnv("CODEX_CLI_PATH", "/env/codex");
    expect(
      resolveCodexAppServerExecutable({
        runtimeId: "codex",
        options: {},
        transport: "sdk",
      }),
    ).toBe("/env/codex");

    vi.unstubAllEnvs();
    expect(
      resolveCodexAppServerExecutable({
        runtimeId: "codex",
        options: {},
        transport: "sdk",
      }),
    ).toBe("codex");
  });

  it("builds a Windows command line for safe Codex shim paths", () => {
    expect(buildWindowsAppServerCommandLine("codex", ["app-server"])).toBe("codex app-server");
    expect(
      buildWindowsAppServerCommandLine("C:\\Program Files\\Codex\\codex.cmd", ["app-server"]),
    ).toBe('"C:\\Program Files\\Codex\\codex.cmd" app-server');
  });

  it("rejects Windows shell metacharacters in configured Codex command paths", () => {
    expect(() => buildWindowsAppServerCommandLine("codex&calc", ["app-server"])).toThrow(
      "Unsafe Codex app-server command argument contains Windows shell metacharacters",
    );
    expect(() => buildWindowsAppServerCommandLine("codex", ["app-server & calc"])).toThrow(
      "Unsafe Codex app-server command argument contains Windows shell metacharacters",
    );
  });

  it("forwards only exact shell keys or explicit safe prefixes", () => {
    vi.stubEnv("OPENAI_API_KEY", "openai-key");
    vi.stubEnv("CODEX_HOME", "/tmp/codex");
    vi.stubEnv("AIF_RUNTIME", "codex");
    vi.stubEnv("HANDOFF_PROJECT", "project-1");
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("LC_ALL", "C");
    vi.stubEnv("XDG_CONFIG_HOME", "/tmp/xdg");
    vi.stubEnv("HOME", "/tmp/home");
    vi.stubEnv("USER", "test-user");
    vi.stubEnv("PATH", "/usr/bin");
    vi.stubEnv("HTTP_PROXY", "http://proxy.example");
    vi.stubEnv("ALL_PROXY", "socks5://proxy.example:1080");

    const env = buildCodexAppServerEnv({
      runtimeId: "codex",
      options: {},
      // Explicit API-key opt-in: OPENAI_API_KEY may only be forwarded when the
      // profile asks for API-key auth (otherwise OAuth runs would be hijacked).
      apiKeyEnvVar: "OPENAI_API_KEY",
    });

    expect(env).toMatchObject({
      OPENAI_API_KEY: "openai-key",
      CODEX_HOME: "/tmp/codex",
      AIF_RUNTIME: "codex",
      HANDOFF_PROJECT: "project-1",
      NODE_ENV: "test",
      LC_ALL: "C",
      XDG_CONFIG_HOME: "/tmp/xdg",
      HOME: "/tmp/home",
      USER: "test-user",
      PATH: "/usr/bin",
      HTTP_PROXY: "http://proxy.example",
      http_proxy: "http://proxy.example",
      ALL_PROXY: "socks5://proxy.example:1080",
      all_proxy: "socks5://proxy.example:1080",
    });

    vi.unstubAllEnvs();
  });

  it("does not leak similarly named secrets through exact shell keys", () => {
    vi.stubEnv("USER_TOKEN", "do-not-forward");
    vi.stubEnv("HOME_SECRET", "do-not-forward");
    vi.stubEnv("PATH_TO_SECRET", "do-not-forward");
    vi.stubEnv("HTTP_PROXY_SECRET", "do-not-forward");
    vi.stubEnv("npm_config_user_agent", "do-not-forward");

    const env = buildCodexAppServerEnv({
      runtimeId: "codex",
      options: {},
    });

    expect(env.USER_TOKEN).toBeUndefined();
    expect(env.HOME_SECRET).toBeUndefined();
    expect(env.PATH_TO_SECRET).toBeUndefined();
    expect(env.HTTP_PROXY_SECRET).toBeUndefined();
    expect(env.npm_config_user_agent).toBeUndefined();

    vi.unstubAllEnvs();
  });

  it("does not consume ambient OPENAI_API_KEY / OPENAI_BASE_URL by default", () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-000");
    vi.stubEnv("OPENAI_BASE_URL", "http://host.docker.internal:8317/v1");

    const env = buildCodexAppServerEnv({
      runtimeId: "codex",
      options: {},
    });

    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OPENAI_BASE_URL).toBeUndefined();
  });

  it("forwards OPENAI_API_KEY when apiKeyEnvVar opts into API-key auth", () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-real");

    const env = buildCodexAppServerEnv({
      runtimeId: "codex",
      options: { apiKeyEnvVar: "OPENAI_API_KEY" },
    });

    expect(env.OPENAI_API_KEY).toBe("sk-real");
  });

  it("injects an explicit literal apiKey under its configured env var", () => {
    const env = buildCodexAppServerEnv({
      runtimeId: "codex",
      options: {},
      apiKey: "sk-literal",
      apiKeyEnvVar: "MY_CODEX_KEY",
    });

    expect(env.MY_CODEX_KEY).toBe("sk-literal");
    expect(env.OPENAI_API_KEY).toBe("sk-literal");
  });

  it("maps an explicit baseUrl onto CODEX_BASE_URL", () => {
    const env = buildCodexAppServerEnv({
      runtimeId: "codex",
      options: {},
      baseUrl: "https://codex.internal/api",
    });

    expect(env.CODEX_BASE_URL).toBe("https://codex.internal/api");
  });

  it("forwards NODE_ENV without forwarding NODE_OPTIONS", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("NODE_OPTIONS", "--require ./steal-secrets.js");

    const env = buildCodexAppServerEnv({
      runtimeId: "codex",
      options: {},
    });

    expect(env.NODE_ENV).toBe("test");
    expect(env.NODE_OPTIONS).toBeUndefined();
  });

  it("treats signal-terminated processes as already exited", async () => {
    const fakeProcess = new EventEmitter() as ChildProcessWithoutNullStreams;
    const kill = vi.fn(() => true) as unknown as ChildProcessWithoutNullStreams["kill"];
    Object.defineProperties(fakeProcess, {
      exitCode: { value: null, configurable: true },
      signalCode: { value: "SIGTERM", configurable: true },
    });
    fakeProcess.kill = kill;

    const logger = {
      debug: vi.fn(),
      warn: vi.fn(),
    };

    expect(hasProcessExited(fakeProcess)).toBe(true);
    await terminateCodexAppServerProcess(
      {
        process: fakeProcess,
        stderrTail: [],
        executablePath: "codex",
        args: ["app-server"],
      },
      logger,
      5,
      5,
    );

    expect(kill).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
