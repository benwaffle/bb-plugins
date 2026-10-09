import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import type { PolicyStatus } from "./contract.js";
import { ACCOUNT_SIGN_OUT_METHOD, ACCOUNT_STATUS_METHOD, AI_TASKS, type AiTask } from "./policy.js";
import plugin from "./server.js";

type Selection = { mode: "automatic" } | { mode: "off" } | { mode: "service"; pluginId: string; serviceId: string };

interface BbState {
  plugins: Record<string, boolean>;
  /** bb-account's stored sign-in; survives the plugin being disabled. */
  account: "signed-out" | "signed-in";
  selections: Record<AiTask, Selection>;
  telemetryEnabled: boolean;
}

const GENERAL_SETTINGS = {
  defaultMachineAccess: null,
  defaultProviderId: null,
  machineGitCredentialsEnabled: false,
  machineServerUrl: null,
  managedBranchPrefix: "bi/",
  providerCompletedTurnDisplay: {},
  providerOrder: [],
  showDiagnosticEvents: false,
  showKeyboardHints: true,
  steerActiveThreadOnEnter: false,
  streamerMode: false,
};

const BB_AI = { mode: "service", pluginId: "bb-ai", serviceId: "cloud" } as const;

function compliantState(): BbState {
  return {
    plugins: { "bb-account": false, "bb-ai": false, connect: false, github: true },
    account: "signed-out",
    selections: { "thread-title": { mode: "automatic" }, "commit-message": { mode: "off" }, voice: { mode: "automatic" } },
    telemetryEnabled: false,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function load(state: BbState, signOutConfirmedAt: number | null = Date.now()) {
  const listeners = new Map<string, () => void>();
  const host = createFakePluginHost({
    pluginId: "cape-policy",
    sdk: {
      plugins: {
        enable: async ({ pluginId }) => {
          state.plugins[pluginId] = true;
          return { id: pluginId, enabled: true };
        },
        callRpc: async ({ pluginId, method }) => {
          if (pluginId !== "bb-account" || !state.plugins["bb-account"]) {
            throw new Error(`no rpc ${pluginId}.${method}`);
          }
          if (method === ACCOUNT_STATUS_METHOD) return { state: state.account };
          if (method === ACCOUNT_SIGN_OUT_METHOD) {
            const was = state.account;
            state.account = "signed-out";
            return { revocation: was === "signed-out" ? "not-signed-in" : "revoked", status: { state: "signed-out" } };
          }
          throw new Error(`no rpc ${pluginId}.${method}`);
        },
        list: async () => ({
          plugins: Object.entries(state.plugins).map(([id, enabled]) => ({ id, enabled })),
        }),
        disable: async ({ pluginId }) => {
          state.plugins[pluginId] = false;
          return { id: pluginId, enabled: false };
        },
      },
      system: {
        aiServices: async () => ({ selections: { ...state.selections }, services: [] }),
        setAiServiceSelection: async ({ task, selection }) => {
          state.selections[task] = selection;
          return { selections: { ...state.selections }, services: [] };
        },
        config: async () => ({
          generalSettings: { ...GENERAL_SETTINGS, telemetryEnabled: state.telemetryEnabled },
        }),
        updateGeneralSettings: async (settings) => {
          state.telemetryEnabled = settings.telemetryEnabled ?? state.telemetryEnabled;
          return {};
        },
      },
      subscribe: ({ event, callback }) => {
        listeners.set(event, callback as () => void);
        return () => listeners.delete(event);
      },
    },
  });
  if (signOutConfirmedAt !== null) void host.bb.storage.kv.set("signOutConfirmedAt", signOutConfirmedAt);
  plugin(host.bb);
  return { ...host, listeners };
}

async function startService(host: ReturnType<typeof load>) {
  const run = host.harness.runService("enforcer");
  // The service applies once before it parks on the abort signal.
  await expect.poll(() => host.harness.sdk.callsTo("plugins.list").length).toBeGreaterThan(0);
  await expect.poll(async () => ((await host.harness.callRpc("status")) as PolicyStatus).lastCheckedAt).not.toBeNull();
  return run;
}

function warnings(host: ReturnType<typeof load>): string[] {
  return host.harness.logEntries.filter((entry) => entry.level === "warn").map((entry) => entry.message);
}

describe("cape-policy enforcer", () => {
  it("reverts every violation when the service starts and logs each one", async () => {
    const state: BbState = {
      plugins: { "bb-account": true, "bb-ai": true, connect: true, github: true },
      account: "signed-in",
      selections: { "thread-title": BB_AI, "commit-message": BB_AI, voice: BB_AI },
      telemetryEnabled: true,
    };
    const host = load(state);
    const run = await startService(host);

    expect(state.plugins).toEqual({ "bb-account": false, "bb-ai": false, connect: false, github: true });
    expect(state.selections).toEqual(Object.fromEntries(AI_TASKS.map((task) => [task, { mode: "off" }])));
    expect(state.telemetryEnabled).toBe(false);
    expect(host.harness.sdk.callsTo("system.updateGeneralSettings")).toEqual([
      [{ ...GENERAL_SETTINGS, telemetryEnabled: false }],
    ]);
    expect(state.account).toBe("signed-out");
    expect(warnings(host)).toEqual([
      "reverted account:bb-account: signed-in -> signed-out (trigger: plugin loaded)",
      "reverted plugin:bb-account: enabled -> disabled (trigger: plugin loaded)",
      "reverted plugin:bb-ai: enabled -> disabled (trigger: plugin loaded)",
      "reverted plugin:connect: enabled -> disabled (trigger: plugin loaded)",
      "reverted ai:thread-title: routed to bb-ai -> off (trigger: plugin loaded)",
      "reverted ai:commit-message: routed to bb-ai -> off (trigger: plugin loaded)",
      "reverted ai:voice: routed to bb-ai -> off (trigger: plugin loaded)",
      "reverted setting:telemetryEnabled: true -> false (trigger: plugin loaded)",
    ]);
    const status = (await host.harness.callRpc("status")) as PolicyStatus;
    expect(status.compliant).toBe(true);

    run.controller.abort();
    await run.done;
    expect(host.listeners.size).toBe(0);
  });

  it("changes nothing when bb already complies, and leaves other AI services alone", async () => {
    const state = compliantState();
    state.selections.voice = { mode: "service", pluginId: "voice-whisper-local", serviceId: "whisper" };
    const host = load(state);
    const run = await startService(host);

    expect(host.harness.sdk.callsTo("plugins.disable")).toEqual([]);
    expect(host.harness.sdk.callsTo("system.setAiServiceSelection")).toEqual([]);
    expect(host.harness.sdk.callsTo("system.updateGeneralSettings")).toEqual([]);
    expect(warnings(host)).toEqual([]);

    run.controller.abort();
    await run.done;
  });

  it("reverts a change reported by a settings event", async () => {
    const state = compliantState();
    const host = load(state);
    const run = await startService(host);

    state.telemetryEnabled = true;
    state.plugins["bb-ai"] = true;
    host.listeners.get("system:config-changed")?.();

    await expect.poll(() => state.telemetryEnabled).toBe(false);
    await expect.poll(() => state.plugins["bb-ai"]).toBe(false);
    expect(warnings(host)).toEqual([
      "reverted plugin:bb-ai: enabled -> disabled (trigger: settings changed)",
      "reverted setting:telemetryEnabled: true -> false (trigger: settings changed)",
    ]);

    run.controller.abort();
    await run.done;
  });

  it("records a failed pass as an error and reports non-compliance", async () => {
    const host = load(compliantState());
    host.harness.sdk.stub("plugins.list", async () => {
      throw new Error("server unavailable");
    });

    const result = await host.harness.runCli(["apply", "--json"]);
    expect(result.exitCode).toBe(1);
    const status = JSON.parse(result.stdout) as PolicyStatus;
    expect(status).toMatchObject({ compliant: false, lastError: "server unavailable" });
    expect(host.harness.logEntries.some((entry) => entry.level === "error")).toBe(true);
  });
});

describe("bb cape-policy CLI", () => {
  it("status exits 1 and names each violation without changing anything", async () => {
    const state = compliantState();
    state.plugins.connect = true;
    state.selections["thread-title"] = BB_AI;
    const host = load(state);

    const result = await host.harness.runCli(["status"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Cape policy: NOT compliant");
    expect(result.stdout).toContain("VIOLATION\tplugin:connect\tenabled\t(expected disabled)");
    expect(result.stdout).toContain("VIOLATION\tai:thread-title\trouted to bb-ai");
    expect(result.stdout).toContain("ok\tsetting:telemetryEnabled\tfalse\t(expected false)");
    expect(state.plugins.connect).toBe(true);
  });

  it("apply fixes bb and exits 0", async () => {
    const state = compliantState();
    state.plugins["bb-account"] = true;
    const host = load(state);

    const result = await host.harness.runCli(["apply"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Cape policy: compliant");
    expect(state.plugins["bb-account"]).toBe(false);
  });

  it("explain lists every enforced item", async () => {
    const host = load(compliantState());
    const result = await host.harness.runCli(["explain"]);
    expect(result.exitCode).toBe(0);
    for (const needle of ["bb-account", "bb-ai", "connect", "telemetryEnabled", "every 60s"]) {
      expect(result.stdout).toContain(needle);
    }
  });
});

describe("bb account sign-out", () => {
  it("enables a disabled bb-account once to clear a credential it still holds", async () => {
    const state = compliantState();
    state.account = "signed-in";
    const host = load(state, null);
    const run = await startService(host);

    expect(state.account).toBe("signed-out");
    expect(state.plugins["bb-account"]).toBe(false);
    expect(host.harness.sdk.callsTo("plugins.enable")).toEqual([[{ pluginId: "bb-account" }]]);
    expect(warnings(host)).toEqual([
      "reverted account:bb-account: signed-in -> signed-out (trigger: plugin loaded)",
    ]);
    const status = (await host.harness.callRpc("status")) as PolicyStatus;
    expect(status.items[0]).toMatchObject({ id: "account:bb-account", compliant: true });

    run.controller.abort();
    await run.done;
  });

  it("leaves a disabled bb-account alone while its sign-out confirmation is fresh", async () => {
    const host = load(compliantState(), Date.now() - DAY_MS / 2);
    const run = await startService(host);
    expect(host.harness.sdk.callsTo("plugins.enable")).toEqual([]);
    run.controller.abort();
    await run.done;
  });

  it("checks a disabled bb-account again once the confirmation is a day old", async () => {
    const state = compliantState();
    const host = load(state, Date.now() - DAY_MS - 1);
    const run = await startService(host);
    expect(host.harness.sdk.callsTo("plugins.enable")).toEqual([[{ pluginId: "bb-account" }]]);
    expect(host.harness.sdk.callsTo("plugins.disable")).toEqual([[{ pluginId: "bb-account" }]]);
    expect(host.harness.sdk.callsTo("plugins.callRpc").map(([args]) => (args as { method: string }).method)).toEqual([
      ACCOUNT_STATUS_METHOD,
    ]);
    expect(state.plugins["bb-account"]).toBe(false);
    run.controller.abort();
    await run.done;
  });

  it("disables bb-account again when the check fails", async () => {
    const state = compliantState();
    const host = load(state, null);
    host.harness.sdk.stub("plugins.callRpc", async () => {
      throw new Error("bb-account not ready");
    });
    const result = await host.harness.runCli(["apply", "--json"]);
    expect(result.exitCode).toBe(1);
    expect(state.plugins["bb-account"]).toBe(false);
    expect(JSON.parse(result.stdout)).toMatchObject({ lastError: "account:bb-account: bb-account not ready" });
  });

  it("still applies the rest of the policy when sign-out fails", async () => {
    const state = compliantState();
    state.plugins["bb-account"] = true;
    state.plugins.connect = true;
    state.account = "signed-in";
    state.telemetryEnabled = true;
    const host = load(state);
    host.harness.sdk.stub("plugins.callRpc", async ({ method }: { method: string }) => {
      if (method === ACCOUNT_STATUS_METHOD) return { state: "signed-in" };
      throw new Error("getbb.app unreachable");
    });

    const result = await host.harness.runCli(["apply", "--json"]);
    expect(result.exitCode).toBe(1);
    expect(state.plugins).toMatchObject({ "bb-account": false, connect: false });
    expect(state.telemetryEnabled).toBe(false);
    const status = JSON.parse(result.stdout) as PolicyStatus;
    expect(status.lastError).toBe("account:bb-account: getbb.app unreachable");
    expect(host.harness.logEntries.filter((entry) => entry.level === "error").map((entry) => entry.message)).toEqual([
      "could not enforce account:bb-account: getbb.app unreachable (trigger: cli apply)",
    ]);
  });
});
