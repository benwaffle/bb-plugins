import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin, { testTitlePrompt } from "./server.js";

type FakePluginHostOptions = NonNullable<
  Parameters<typeof createFakePluginHost>[0]
>;
type HostRpcResponder = NonNullable<
  FakePluginHostOptions["experimental_callHostRpc"]
>;
type Selection =
  | { mode: "automatic" }
  | { mode: "off" }
  | { mode: "service"; pluginId: string; serviceId: string };

const PLUGIN_ID = "claude-title";
const CLAUDE = "/Users/someone/.local/bin/claude";
const READY_STATUS = {
  claudePath: CLAUDE,
  login: { state: "logged-in" },
  lastLatencyMs: 1_480,
};

interface ServiceView {
  id: string;
  displayName: string;
  pluginId: string;
  tasks: string[];
  automaticRank: number | null;
  status: { ready: true } | { ready: false; message: string };
}

const CLAUDE_SERVICE: ServiceView = {
  id: "claude",
  displayName: "Claude Code",
  pluginId: PLUGIN_ID,
  tasks: ["thread-title", "commit-message"],
  automaticRank: 0,
  status: { ready: true },
};

function createHost(args: {
  respond: HostRpcResponder;
  settings?: Record<string, string | number>;
  primaryHostId?: string | null;
  selections?: Partial<Record<"thread-title" | "commit-message", Selection>>;
  services?: ServiceView[];
}) {
  return createFakePluginHost({
    pluginId: PLUGIN_ID,
    ...(args.settings === undefined ? {} : { settings: args.settings }),
    sdk: {
      system: {
        config: async () =>
          ({
            primaryHostId:
              args.primaryHostId === undefined
                ? "host-primary"
                : args.primaryHostId,
          }) as never,
        aiServices: async () =>
          ({
            selections: {
              "thread-title": { mode: "automatic" },
              "commit-message": { mode: "automatic" },
              voice: { mode: "automatic" },
              ...args.selections,
            },
            services: args.services ?? [CLAUDE_SERVICE],
          }) as never,
      },
    },
    experimental_callHostRpc: args.respond,
  });
}

function registeredService(host: ReturnType<typeof createHost>) {
  const [service] = host.harness.registrations.aiServiceRegistrations;
  if (service === undefined) throw new Error("no AI service registered");
  return service;
}

const signal = new AbortController().signal;

describe("claude AI service", () => {
  it("registers a text-only Claude Code service", async () => {
    const host = createHost({ respond: () => READY_STATUS });
    await plugin(host.bb);

    const service = registeredService(host);
    expect(service).toMatchObject({ id: "claude", displayName: "Claude Code" });
    expect(service.complete).toBeTypeOf("function");
    expect(service.transcribe).toBeUndefined();
  });

  it("completes on the primary host with the default settings and a 6.5s budget", async () => {
    const host = createHost({
      respond: () => ({ ok: true, text: "Fix flaky login test", durationMs: 1_400 }),
    });
    await plugin(host.bb);

    const text = await registeredService(host).complete?.("Title this", {
      signal,
    });

    expect(text).toBe("Fix flaky login test");
    expect(host.harness.experimental_hostRpcCalls).toMatchObject([
      {
        method: "complete",
        hostId: "host-primary",
        input: {
          prompt: "Title this",
          model: "claude-haiku-4-5-20251001",
          claudePath: null,
          maxTitleLength: 48,
          timeoutMs: 6_500,
        },
      },
    ]);
  });

  it("passes the configured model, claude path, and title length", async () => {
    const host = createHost({
      settings: { model: "haiku", claudePath: "/opt/claude", maxTitleLength: 30 },
      respond: () => ({ ok: true, text: "Title", durationMs: 1 }),
    });
    await plugin(host.bb);

    await registeredService(host).complete?.("Title this", { signal });

    expect(host.harness.experimental_hostRpcCalls[0]?.input).toMatchObject({
      model: "haiku",
      claudePath: "/opt/claude",
      maxTitleLength: 30,
    });
  });

  it("rejects with the host's failure message", async () => {
    const host = createHost({
      respond: () => ({
        ok: false,
        code: "timeout",
        message: "claude did not answer within 6500ms",
      }),
    });
    await plugin(host.bb);

    await expect(
      registeredService(host).complete?.("Title this", { signal }),
    ).rejects.toThrow("claude did not answer within 6500ms");
  });

  it("reports ready only when claude is found and logged in", async () => {
    const statuses = [
      READY_STATUS,
      { claudePath: CLAUDE, login: { state: "logged-out" }, lastLatencyMs: null },
      { claudePath: null, login: null, lastLatencyMs: null },
      {
        claudePath: CLAUDE,
        login: { state: "unknown", message: "claude auth status failed: EACCES" },
        lastLatencyMs: null,
      },
    ];
    let next = 0;
    const host = createHost({ respond: () => statuses[next++] });
    await plugin(host.bb);
    const service = registeredService(host);

    await expect(service.status?.()).resolves.toEqual({ ready: true });
    await expect(service.status?.()).resolves.toEqual({
      ready: false,
      message: "Claude Code is not logged in. Run: claude auth login",
    });
    await expect(service.status?.()).resolves.toMatchObject({
      ready: false,
      message: expect.stringContaining("claude was not found"),
    });
    await expect(service.status?.()).resolves.toEqual({
      ready: false,
      message: "claude auth status failed: EACCES",
    });
    expect(host.harness.experimental_hostRpcCalls[0]).toMatchObject({
      method: "status",
      input: { claudePath: null, refresh: false },
    });
  });

  it("fails without a primary machine and calls no host", async () => {
    const host = createHost({ primaryHostId: null, respond: () => READY_STATUS });
    await plugin(host.bb);

    await expect(registeredService(host).status?.()).rejects.toThrow(
      "No primary machine is connected",
    );
    await expect(
      registeredService(host).complete?.("Title this", { signal }),
    ).rejects.toThrow("No primary machine is connected");
    expect(host.harness.experimental_hostRpcCalls).toEqual([]);
  });
});

describe("bb claude-title", () => {
  it("test wraps the prompt in a title request and prints the title and timing", async () => {
    const host = createHost({
      respond: () => ({ ok: true, text: "Fix flaky login test", durationMs: 1_420 }),
    });
    await plugin(host.bb);

    const result = await host.harness.runCli(["test", "fix the", "flaky login test"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(
      /^Fix flaky login test\nclaude 1\.4s, total \d+\.\ds$/,
    );
    expect(host.harness.experimental_hostRpcCalls[0]?.input).toMatchObject({
      prompt: testTitlePrompt("fix the flaky login test"),
    });
  });

  it("test --raw sends the prompt as-is and --json prints timings", async () => {
    const host = createHost({
      respond: () => ({ ok: true, text: "ok", durationMs: 900 }),
    });
    await plugin(host.bb);

    const result = await host.harness.runCli(["test", "--raw", "--json", "Say ok"]);

    expect(JSON.parse(result.stdout ?? "")).toMatchObject({
      text: "ok",
      claudeMs: 900,
    });
    expect(host.harness.experimental_hostRpcCalls[0]?.input).toMatchObject({
      prompt: "Say ok",
    });
  });

  it("test exits non-zero with the failure", async () => {
    const host = createHost({
      respond: () => ({ ok: false, code: "not_found", message: "claude was not found" }),
    });
    await plugin(host.bb);

    const result = await host.harness.runCli(["test", "hello"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/^claude was not found \(after \d+\.\ds\)$/);
  });

  it("status refreshes the login and shows that Automatic picks this service", async () => {
    const host = createHost({ respond: () => READY_STATUS });
    await plugin(host.bb);

    const result = await host.harness.runCli(["status"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      [
        `claude: ${CLAUDE}`,
        "Login: logged in",
        "Model: claude-haiku-4-5-20251001",
        "Last reply: 1.5s",
        "Thread titles: automatic, currently Claude Code (plugin claude-title)",
        "Commit messages: automatic, currently Claude Code (plugin claude-title)",
      ].join("\n"),
    );
    expect(host.harness.experimental_hostRpcCalls[0]).toMatchObject({
      method: "status",
      input: { refresh: true },
    });
  });

  it("status says how to route a task here when another service or off handles it", async () => {
    const other: ServiceView = {
      ...CLAUDE_SERVICE,
      id: "other",
      displayName: "Other",
      pluginId: "another-plugin",
      automaticRank: 0,
    };
    const host = createHost({
      respond: () => READY_STATUS,
      selections: { "commit-message": { mode: "off" } },
      services: [other, { ...CLAUDE_SERVICE, automaticRank: 1 }],
    });
    await plugin(host.bb);

    const result = await host.harness.runCli(["status"]);

    expect(result.stdout).toContain(
      "Thread titles: automatic, currently Other (plugin another-plugin)",
    );
    expect(result.stdout).toContain("Commit messages: off");
    expect(result.stdout).toContain(
      "To route a task here, run: bb settings ai-services set <thread-title|commit-message> claude",
    );
  });

  it("status --json reports readiness and routing", async () => {
    const host = createHost({
      respond: () => ({ ...READY_STATUS, login: { state: "logged-out" } }),
      selections: {
        "thread-title": { mode: "service", pluginId: PLUGIN_ID, serviceId: "claude" },
      },
    });
    await plugin(host.bb);

    const result = await host.harness.runCli(["status", "--json"]);

    expect(JSON.parse(result.stdout ?? "")).toMatchObject({
      claudePath: CLAUDE,
      ready: false,
      model: "claude-haiku-4-5-20251001",
      routing: {
        "thread-title": { usesClaude: true },
        "commit-message": { usesClaude: true },
      },
    });
  });

  it("rejects unknown flags and commands without calling the host", async () => {
    const host = createHost({ respond: () => READY_STATUS });
    await plugin(host.bb);

    const badFlag = await host.harness.runCli(["status", "--verbose"]);
    const noPrompt = await host.harness.runCli(["test"]);

    expect(badFlag).toMatchObject({ exitCode: 1 });
    expect(badFlag.stderr).toContain("Unknown flag --verbose");
    expect(noPrompt).toMatchObject({ exitCode: 1 });
    expect(noPrompt.stderr).toContain("Usage: bb claude-title");
    expect(host.harness.experimental_hostRpcCalls).toEqual([]);
  });
});
