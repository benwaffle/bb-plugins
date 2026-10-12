import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeArgs, createClaudeHostEntry } from "./host.js";

const COMPLETE_INPUT = {
  prompt: "You create concise titles for coding tasks.\n\nTask:\nfix the flaky login test",
  model: "claude-haiku-4-5-20251001",
  claudePath: null,
  maxTitleLength: 48,
  timeoutMs: 5_000,
};

const LOGGED_IN = JSON.stringify({
  loggedIn: true,
  authMethod: "claude.ai",
  email: "someone@example.invalid",
  orgName: "Some org",
});

function printResult(result: string, isError = false): string {
  return JSON.stringify({
    type: "result",
    subtype: isError ? "error" : "success",
    is_error: isError,
    result,
    duration_ms: 700,
  });
}

describe("claude host entry", () => {
  let root: string;
  let binDir: string;
  let tempDir: string;
  let logDir: string;
  let env: NodeJS.ProcessEnv;
  let clockMs: number;

  /**
   * Installs a `claude` shell script that records its arguments, working
   * directory, environment, and stdin under logDir, then runs `body`.
   * `auth status` invocations are counted in auth-calls.
   */
  async function installClaude(args: {
    body: string;
    auth?: string;
    dir?: string;
  }): Promise<string> {
    const dir = args.dir ?? binDir;
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "claude");
    await writeFile(
      filePath,
      [
        "#!/bin/sh",
        `log="${logDir}"`,
        'if [ "$1" = "auth" ]; then',
        '  echo x >> "$log/auth-calls"',
        `  cat <<'JSON'`,
        args.auth ?? LOGGED_IN,
        "JSON",
        "  exit 0",
        "fi",
        'printf "%s\\n" "$@" > "$log/args"',
        'pwd -P > "$log/cwd"',
        'ls -A > "$log/cwd-contents"',
        'env > "$log/env"',
        'cat > "$log/stdin"',
        args.body,
        "",
      ].join("\n"),
    );
    await chmod(filePath, 0o755);
    return filePath;
  }

  async function logged(name: string): Promise<string> {
    return readFile(path.join(logDir, name), "utf8");
  }

  async function authCalls(): Promise<number> {
    try {
      return (await logged("auth-calls")).trim().split("\n").length;
    } catch {
      return 0;
    }
  }

  function harness() {
    return experimental_createHostEntryHarness(
      createClaudeHostEntry({ env, fallbackBinDirs: [], now: () => clockMs }),
      { experimental_paths: { dataDir: path.join(root, "data"), tempDir } },
    );
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "claude-title-host-test-"));
    binDir = path.join(root, "bin");
    tempDir = path.join(root, "tmp");
    logDir = path.join(root, "log");
    await mkdir(logDir, { recursive: true });
    env = {
      PATH: `${binDir}${path.delimiter}/usr/bin${path.delimiter}/bin`,
      HOME: root,
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
    };
    clockMs = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("runs claude -p from an empty directory with the prompt on stdin and returns the first line", async () => {
    await installClaude({
      body: `cat <<'JSON'\n${printResult("\n  Fix flaky login test  \nextra line")}\nJSON`,
    });
    const host = harness();

    const result = await host.experimental_call("complete", COMPLETE_INPUT);

    expect(result).toEqual({
      ok: true,
      text: "Fix flaky login test",
      durationMs: 0,
    });
    expect((await logged("args")).split("\n").slice(0, -1)).toEqual(
      claudeArgs(COMPLETE_INPUT),
    );
    expect(await logged("stdin")).toBe(COMPLETE_INPUT.prompt);
    expect(await logged("cwd")).toContain(`${path.sep}complete-`);
    expect(await logged("cwd-contents")).toBe("");
    const childEnv = await logged("env");
    expect(childEnv).toContain("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1");
    expect(childEnv).not.toContain("CLAUDECODE=");
    expect(childEnv).not.toContain("CLAUDE_CODE_ENTRYPOINT=");
    await host.experimental_dispose();
    await expect(readdir(tempDir)).resolves.toEqual([]);
  });

  it("turns off tools, thinking, settings files, MCP servers, and skills", () => {
    const args = claudeArgs({ model: "haiku", maxTitleLength: 30 });

    expect(args.slice(0, 5)).toEqual([
      "--print",
      "--model",
      "haiku",
      "--output-format",
      "json",
    ]);
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(JSON.parse(args[args.indexOf("--settings") + 1] ?? "")).toEqual({
      alwaysThinkingEnabled: false,
    });
    expect(args).toEqual(
      expect.arrayContaining([
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--no-session-persistence",
      ]),
    );
    expect(args[args.indexOf("--system-prompt") + 1]).toContain(
      "under 30 characters",
    );
  });

  it("reports claude's error result", async () => {
    await installClaude({
      body: `cat <<'JSON'\n${printResult("Invalid model name", true)}\nJSON\nexit 1`,
    });
    const host = harness();

    await expect(
      host.experimental_call("complete", COMPLETE_INPUT),
    ).resolves.toEqual({
      ok: false,
      code: "request_failed",
      message: "claude exited with 1: Invalid model name",
    });
    await host.experimental_dispose();
  });

  it("reports an empty reply as a failure", async () => {
    await installClaude({
      body: `cat <<'JSON'\n${printResult("\n  \n")}\nJSON`,
    });
    const host = harness();

    await expect(
      host.experimental_call("complete", COMPLETE_INPUT),
    ).resolves.toEqual({
      ok: false,
      code: "request_failed",
      message: "claude returned an empty reply",
    });
    await host.experimental_dispose();
  });

  it("reports stderr when claude prints no JSON", async () => {
    await installClaude({ body: 'echo "boom: not logged in" >&2\nexit 2' });
    const host = harness();

    await expect(
      host.experimental_call("complete", COMPLETE_INPUT),
    ).resolves.toEqual({
      ok: false,
      code: "request_failed",
      message: "claude exited with 2: boom: not logged in",
    });
    await host.experimental_dispose();
  });

  it("kills claude and the children holding its output at the timeout", async () => {
    await installClaude({ body: "sleep 5 &\nwait" });
    const host = harness();

    await expect(
      host.experimental_call("complete", { ...COMPLETE_INPUT, timeoutMs: 200 }),
    ).resolves.toEqual({
      ok: false,
      code: "timeout",
      message: "claude did not answer within 200ms",
    });
    await host.experimental_dispose();
    await expect(readdir(tempDir)).resolves.toEqual([]);
  });

  it("uses the configured claude path and rejects one that is not executable", async () => {
    const custom = await installClaude({
      dir: path.join(root, "custom"),
      body: `cat <<'JSON'\n${printResult("From custom")}\nJSON`,
    });
    const host = harness();

    await expect(
      host.experimental_call("complete", { ...COMPLETE_INPUT, claudePath: custom }),
    ).resolves.toMatchObject({ ok: true, text: "From custom" });
    await expect(
      host.experimental_call("complete", {
        ...COMPLETE_INPUT,
        claudePath: path.join(root, "missing", "claude"),
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "not_found",
      message: expect.stringContaining("is not an executable file"),
    });
    await host.experimental_dispose();
  });

  it("reports a missing claude without checking the login", async () => {
    const host = harness();

    await expect(
      host.experimental_call("status", { claudePath: null, refresh: false }),
    ).resolves.toEqual({ claudePath: null, login: null, lastLatencyMs: null });
    await expect(
      host.experimental_call("complete", COMPLETE_INPUT),
    ).resolves.toMatchObject({ ok: false, code: "not_found" });
    await host.experimental_dispose();
  });

  it("returns only the login state and caches a logged-in result for ten minutes", async () => {
    const claude = await installClaude({ body: "exit 0" });
    const host = harness();
    const status = () =>
      host.experimental_call("status", { claudePath: null, refresh: false });

    await expect(status()).resolves.toEqual({
      claudePath: claude,
      login: { state: "logged-in" },
      lastLatencyMs: null,
    });
    clockMs = 10 * 60_000;
    await status();
    expect(await authCalls()).toBe(1);

    clockMs += 1;
    await status();
    expect(await authCalls()).toBe(2);

    await host.experimental_call("status", { claudePath: null, refresh: true });
    expect(await authCalls()).toBe(3);
    await host.experimental_dispose();
  });

  it("rechecks a logged-out result after thirty seconds", async () => {
    await installClaude({
      body: "exit 0",
      auth: JSON.stringify({ loggedIn: false }),
    });
    const host = harness();
    const status = () =>
      host.experimental_call("status", { claudePath: null, refresh: false });

    await expect(status()).resolves.toMatchObject({
      login: { state: "logged-out" },
    });
    clockMs = 30_000;
    await status();
    expect(await authCalls()).toBe(1);
    clockMs += 1;
    await status();
    expect(await authCalls()).toBe(2);
    await host.experimental_dispose();
  });

  it("reports an unreadable auth status as unknown", async () => {
    await installClaude({ body: "exit 0", auth: "not json" });
    const host = harness();

    await expect(
      host.experimental_call("status", { claudePath: null, refresh: false }),
    ).resolves.toMatchObject({
      login: {
        state: "unknown",
        message: "claude auth status printed no JSON (exit 0)",
      },
    });
    await host.experimental_dispose();
  });

  it("reports the latency of the last reply", async () => {
    await installClaude({
      body: `cat <<'JSON'\n${printResult("Title")}\nJSON`,
    });
    const entry = createClaudeHostEntry({
      env,
      fallbackBinDirs: [],
      now: () => {
        clockMs += 1_250;
        return clockMs;
      },
    });
    const host = experimental_createHostEntryHarness(entry, {
      experimental_paths: { dataDir: path.join(root, "data"), tempDir },
    });

    await host.experimental_call("complete", COMPLETE_INPUT);

    await expect(
      host.experimental_call("status", { claudePath: null, refresh: false }),
    ).resolves.toMatchObject({ lastLatencyMs: 1_250 });
    await host.experimental_dispose();
  });
});
