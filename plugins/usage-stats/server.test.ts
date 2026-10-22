import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createUsageStats } from "./server.js";
import { localTranscriptReader } from "./transcripts.js";
import { fixtureProjects } from "./test/helpers.js";

const NOW = Date.parse("2026-10-21T18:00:00.000Z");

const CODEX_THREAD = makeThreadResponse({
  id: "thr_codex",
  title: "Port the parser",
  projectId: "proj_w",
  providerId: "codex",
  updatedAt: NOW - 60_000,
});

/** Mutable cumulative totals that the stubbed cost call and token event report. */
function codexUsage() {
  const state = { input: 100, cached: 40, output: 20, costUsd: 0.5, turn: 1 };
  const breakdown = () => ({
    totalTokens: state.input + state.output,
    inputTokens: state.input,
    cachedInputTokens: state.cached,
    cacheWriteInputTokens: 0,
    outputTokens: state.output,
    reasoningOutputTokens: 0,
  });
  return {
    state,
    cost: async () => ({
      cost: {
        totalUsd: state.costUsd,
        source: "reported",
        tokens: breakdown(),
        models: [{ model: "gpt-x", costUsd: state.costUsd, source: "reported", tokens: breakdown() }],
      },
      turns: [{ turnId: `turn-${state.turn}`, costUsd: null, source: "reported", tokens: breakdown() }],
      turnsCoverRetainedWindowOnly: false,
    }),
    events: async () => [
      {
        id: `evt_${state.turn}`,
        scope: "thread",
        threadId: "thr_codex",
        seq: state.turn,
        createdAt: NOW - 3_600_000 + state.turn,
        type: "thread/tokenUsage/updated",
        data: { providerThreadId: "codex-session", tokenUsage: { total: breakdown(), last: breakdown(), modelContextWindow: null } },
      },
    ],
  };
}

async function load() {
  const usage = codexUsage();
  const { bb, harness } = createFakePluginHost({
    pluginId: "usage-stats",
    sdk: {
      projects: {
        list: async () => [
          {
            id: "proj_w",
            name: "Widgets",
            kind: "standard" as const,
            createdAt: 1,
            updatedAt: 1,
            gitRemoteUrl: null,
            sources: [],
          },
        ],
      },
      threads: {
        list: async (args?: { archived?: boolean }) => (args?.archived === true ? [] : [CODEX_THREAD]),
        events: { list: usage.events },
        // Only some bb builds expose threads.cost; the SDK types leave it out.
        ...({ cost: usage.cost } as object),
      },
      system: {
        usageLimits: async () => ({
          "claude-code": {
            status: "ok" as const,
            accountEmail: null,
            planLabel: "Max",
            windows: [
              { label: "Current session", usedPercent: 64, resetsAt: "2026-10-21T20:00:00.000Z" },
              { label: "Weekly", usedPercent: 81, resetsAt: "2026-10-26T09:00:00.000Z" },
            ],
          },
          codex: { status: "not_installed" as const },
        }),
      },
    },
  });
  await createUsageStats({ reader: localTranscriptReader(fixtureProjects()), now: () => NOW })(bb);
  return { harness, usage };
}

describe("usage-stats server", () => {
  it("records each turn's growth on thread.idle through the cost call", async () => {
    const { harness, usage } = await load();
    await harness.behavior.emitThreadEvent("thread.idle", { thread: CODEX_THREAD, lastAssistantText: null });
    Object.assign(usage.state, { input: 160, cached: 100, output: 30, costUsd: 0.75, turn: 2 });
    await harness.behavior.emitThreadEvent("thread.idle", { thread: CODEX_THREAD, lastAssistantText: null });
    await harness.behavior.emitThreadEvent("thread.idle", { thread: CODEX_THREAD, lastAssistantText: null });

    const detail = (await harness.behavior.callRpc("thread", { key: "thread:thr_codex" })) as {
      turns: { costUsd: number; tokens: number }[];
      totals: { input: number; cacheRead: number; output: number };
      project: string;
    };
    expect(detail.turns.map((turn) => [turn.costUsd, turn.tokens])).toEqual([
      [0.5, 120],
      [0.25, 70],
    ]);
    // Codex counts cached tokens inside input tokens.
    expect(detail.totals).toMatchObject({ input: 60, cacheRead: 100, output: 30 });
    expect(detail.project).toBe("Widgets");
    expect(harness.inspection.realtimeSignals.map((signal) => signal.channel)).toEqual(["usage-changed", "usage-changed"]);
  });

  it("backfills bb threads and transcripts, and summarizes them on the CLI", async () => {
    const { harness } = await load();
    const backfill = await harness.behavior.runCli(["backfill", "--json"]);
    expect(backfill.exitCode).toBe(0);
    expect(JSON.parse(backfill.stdout)).toMatchObject({
      threadsRecorded: 1,
      ledgerRows: 1,
      transcripts: { files: 3, messages: 5, repeatedLines: 2, prompts: 3 },
    });
    const again = await harness.behavior.runCli(["backfill", "--json"]);
    expect(JSON.parse(again.stdout)).toMatchObject({ threadsRecorded: 0, transcripts: { messages: 0, filesRead: 0 } });

    const summary = await harness.behavior.runCli(["summary", "--days", "7"]);
    expect(summary.exitCode).toBe(0);
    expect(summary.stdout).toContain("API-equivalent");
    expect(summary.stdout).toMatch(/^7 days\s+\$0\.52\s+14k/m);
    expect(summary.stdout).toContain("Widgets");
  });

  it("serves the dashboard with sampled subscription windows", async () => {
    const { harness } = await load();
    await harness.behavior.runCli(["backfill"]);
    await harness.behavior.runSchedule("windows");
    const data = (await harness.behavior.callRpc("dashboard", { days: 7, source: "all", sort: "cost" })) as {
      threads: { key: string }[];
      subscriptions: { provider: string; plan: string; windows: { label: string }[]; series: { label: string } }[];
    };
    expect(data.threads[0]?.key).toBe("thread:thr_codex");
    expect(data.subscriptions).toEqual([
      expect.objectContaining({
        provider: "claude-code",
        plan: "Max",
        windows: [expect.objectContaining({ label: "Current session" }), expect.objectContaining({ label: "Weekly" })],
        series: expect.objectContaining({ label: "Weekly" }),
      }),
    ]);
  });
});
