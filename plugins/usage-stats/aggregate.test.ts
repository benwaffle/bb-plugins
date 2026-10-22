import { describe, expect, it } from "vitest";
import { dashboard, rangeEndingToday, threadDetail, totalsFor } from "./aggregate.js";
import { cacheHitRatio } from "./pricing.js";
import { importTranscripts, projectResolver } from "./importer.js";
import { localTranscriptReader } from "./transcripts.js";
import { fixtureProjects, memoryLedger, SESSION_A, SESSION_B } from "./test/helpers.js";

const NOW = Date.parse("2026-10-21T18:00:00.000Z");

/**
 * The fixture transcripts, with session A tied to bb thread thr_acme, plus a
 * Codex thread known only from the ledger. thr_acme also has a ledger row,
 * which the transcript supersedes.
 */
async function seeded() {
  const ledger = memoryLedger();
  await importTranscripts(ledger, localTranscriptReader(fixtureProjects()), projectResolver([]));
  ledger.rememberThread(
    { threadId: "thr_acme", title: "Flaky widget test", projectId: "proj_a", projectName: "Acme", provider: "claude-code", updatedAt: 1 },
    SESSION_A,
  );
  ledger.recordSnapshot({
    threadId: "thr_acme",
    sessionId: SESSION_A,
    provider: "claude-code",
    project: "Acme",
    turnId: "t9",
    ts: Date.parse("2026-10-21T09:30:00.000Z"),
    models: [{ model: "claude-opus-5-5", tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: 99 }],
  });
  ledger.rememberThread(
    { threadId: "thr_codex", title: "Port the parser", projectId: "proj_w", projectName: "Widgets", provider: "codex", updatedAt: 1 },
    "codex-session",
  );
  ledger.recordSnapshot({
    threadId: "thr_codex",
    sessionId: "codex-session",
    provider: "codex",
    project: "Widgets",
    turnId: "c1",
    ts: Date.parse("2026-10-21T15:00:00.000Z"),
    models: [{ model: "gpt-x", tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.5 }],
  });
  ledger.setMeta("importedAt", String(NOW));
  return ledger;
}

// msg_A1 0.0138 + msg_A2 0.005525 + msg_A3 0.00035 + msg_S1 0.00135
const ACME_COST = 0.021025;
const GADGET_COST = 0.00338;

describe("totals", () => {
  it("sums cost, tokens, turns, and threads across sources without counting a session twice", async () => {
    const { db } = await seeded();
    const totals = totalsFor(db, "all", rangeEndingToday(7, NOW));
    expect(totals.costUsd).toBeCloseTo(ACME_COST + GADGET_COST + 0.5, 10);
    expect(totals).toMatchObject({
      input: 236,
      output: 410,
      cacheRead: 12_000,
      cacheWrite: 1_500,
      tokens: 14_146,
      // three typed prompts and one Codex ledger turn
      turns: 4,
      threads: 3,
      unpricedTokens: 0,
    });
    expect(cacheHitRatio(totals)).toBeCloseTo(12_000 / 13_736, 10);
    // opus cache reads: 12,000 × ($5 − $0.50) per million
    expect(totals.savedUsd).toBeCloseTo(0.054, 10);
  });

  it("splits bb threads from sessions outside bb", async () => {
    const { db } = await seeded();
    const range = rangeEndingToday(7, NOW);
    expect(totalsFor(db, "bb", range)).toMatchObject({ threads: 2, turns: 3 });
    expect(totalsFor(db, "bb", range).costUsd).toBeCloseTo(ACME_COST + 0.5, 10);
    expect(totalsFor(db, "outside", range)).toMatchObject({ threads: 1, turns: 1 });
    expect(totalsFor(db, "outside", range).costUsd).toBeCloseTo(GADGET_COST, 10);
  });

  it("counts only today for a one-day range and compares with yesterday", async () => {
    const data = dashboard((await seeded()).db, { days: 1, source: "all", sort: "cost" }, NOW);
    expect(data.current.costUsd).toBeCloseTo(0.00035 + 0.00135 + GADGET_COST + 0.5, 10);
    expect(data.previous.costUsd).toBeCloseTo(0.0138 + 0.005525, 10);
    expect(data.days).toHaveLength(7);
  });
});

describe("dashboard", () => {
  it("buckets tokens by local day and model", async () => {
    const data = dashboard((await seeded()).db, { days: 7, source: "all", sort: "cost" }, NOW);
    expect(data.days.map((day) => day.day)).toEqual([
      "2026-10-15",
      "2026-10-16",
      "2026-10-17",
      "2026-10-18",
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
    ]);
    const byModel = (day: string) =>
      Object.fromEntries(
        (data.days.find((entry) => entry.day === day)?.models ?? []).map((slice) => [
          slice.model,
          slice.input + slice.output + slice.cacheRead + slice.cacheWrite,
        ]),
      );
    expect(byModel("2026-10-20")).toEqual({ "claude-opus-5-5": 6_210 + 6_105 });
    expect(byModel("2026-10-21")).toEqual({ "claude-haiku-4-5-20251001": 150, "claude-opus-5-5": 1_050 + 511, "gpt-x": 120 });
  });

  it("keeps a model's color slot when a filter hides other models", async () => {
    const { db } = await seeded();
    const all = dashboard(db, { days: 7, source: "all", sort: "cost" }, NOW).models;
    const outside = dashboard(db, { days: 7, source: "outside", sort: "cost" }, NOW).models;
    expect(all.map((key) => [key.label, key.slot])).toEqual([
      ["Opus 5.5", 0],
      ["Haiku 4.5", 1],
      ["gpt-x", 2],
    ]);
    expect(outside).toEqual(all);
  });

  it("ranks projects by cost, naming a bb thread's project after the thread", async () => {
    const data = dashboard((await seeded()).db, { days: 7, source: "all", sort: "cost" }, NOW);
    expect(data.projects.map((project) => [project.name, project.threads])).toEqual([
      ["Widgets", 1],
      ["Acme", 1],
      ["gadget", 1],
    ]);
    expect(data.providers.map((provider) => provider.provider)).toEqual(["codex", "claude-code"]);
    expect(data.sources).toEqual({ bbThreads: 2, outsideSessions: 1 });
    expect(data.importedAt).toBe(NOW);
  });

  it("lists top threads with titles, turns, and cache hit ratio", async () => {
    const data = dashboard((await seeded()).db, { days: 7, source: "all", sort: "turns" }, NOW);
    expect(data.threads.map((row) => [row.key, row.title, row.turns])).toEqual([
      ["thread:thr_acme", "Flaky widget test", 2],
      ["thread:thr_codex", "Port the parser", 1],
      [`session:${SESSION_B}`, "Gadget docs", 1],
    ]);
    expect(data.threads[0]?.cacheHit).toBeCloseTo(12_000 / (135 + 12_000 + 1_000), 10);
  });

  it("folds projects past the top eight into Other", async () => {
    const ledger = memoryLedger();
    for (let index = 0; index < 10; index += 1) {
      ledger.recordSnapshot({
        threadId: `thr_${index}`,
        sessionId: `s${index}`,
        provider: "codex",
        project: `p${index}`,
        turnId: "t",
        ts: NOW - 1000,
        models: [{ model: "gpt-x", tokens: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 10 - index }],
      });
    }
    const projects = dashboard(ledger.db, { days: 7, source: "all", sort: "cost" }, NOW).projects;
    expect(projects).toHaveLength(9);
    expect(projects.at(-1)).toEqual({ name: "Other (2)", costUsd: 3, tokens: 20, threads: 2, isOther: true });
  });
});

describe("threadDetail", () => {
  it("splits a thread's messages into turns at each typed prompt", async () => {
    const detail = threadDetail((await seeded()).db, "thread:thr_acme");
    expect(detail).not.toBeNull();
    expect(detail?.sessionIds).toEqual([SESSION_A]);
    expect(detail?.turns.map((turn) => [turn.index, turn.tokens])).toEqual([
      [1, 6_210 + 6_105],
      [2, 150 + 1_050],
    ]);
    expect(detail?.turns[0]?.costUsd).toBeCloseTo(0.0138 + 0.005525, 10);
    expect(detail?.models.map((model) => model.model)).toEqual(["claude-opus-5-5", "claude-haiku-4-5-20251001"]);
    expect(detail?.totals.costUsd).toBeCloseTo(ACME_COST, 10);
  });

  it("names a session outside bb by its custom title", async () => {
    const detail = threadDetail((await seeded()).db, `session:${SESSION_B}`);
    expect(detail).toMatchObject({ title: "Gadget docs", threadId: null, project: "gadget" });
    expect(detail?.turns).toHaveLength(1);
  });

  it("returns null for a key with no usage", async () => {
    expect(threadDetail((await seeded()).db, "thread:thr_missing")).toBeNull();
  });
});
