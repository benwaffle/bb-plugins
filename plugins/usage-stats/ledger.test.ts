import { describe, expect, it } from "vitest";
import { tokenGrowth, type LedgerSnapshot } from "./ledger.js";
import { memoryLedger } from "./test/helpers.js";

function snapshot(turnId: string, ts: number, models: LedgerSnapshot["models"], sessionId: string | null = "sess-1"): LedgerSnapshot {
  return { threadId: "thr_one", sessionId, provider: "codex", project: "Acme", turnId, ts, models };
}

const tokens = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite });

function ledgerRows(ledger: ReturnType<typeof memoryLedger>) {
  return ledger.db
    .prepare(`SELECT turn_id, model, ts, input, output, cache_read, cost_usd FROM usage WHERE source = 'ledger' ORDER BY ts, model`)
    .all();
}

describe("recordSnapshot", () => {
  it("records each turn's growth per model and nothing for a repeated snapshot", () => {
    const ledger = memoryLedger();
    expect(ledger.recordSnapshot(snapshot("t1", 100, [{ model: "gpt-x", tokens: tokens(10, 5, 100), costUsd: 1 }]))).toBe(1);
    expect(
      ledger.recordSnapshot(
        snapshot("t2", 200, [
          { model: "gpt-x", tokens: tokens(15, 9, 300), costUsd: 1.5 },
          { model: "gpt-mini", tokens: tokens(4, 1), costUsd: null },
        ]),
      ),
    ).toBe(2);
    expect(ledger.recordSnapshot(snapshot("t2", 200, [{ model: "gpt-x", tokens: tokens(15, 9, 300), costUsd: 1.5 }]))).toBe(0);

    expect(ledgerRows(ledger)).toEqual([
      { turn_id: "t1", model: "gpt-x", ts: 100, input: 10, output: 5, cache_read: 100, cost_usd: 1 },
      { turn_id: "t2", model: "gpt-mini", ts: 200, input: 4, output: 1, cache_read: 0, cost_usd: null },
      { turn_id: "t2", model: "gpt-x", ts: 200, input: 5, output: 4, cache_read: 200, cost_usd: 0.5 },
    ]);
  });

  it("adds later growth of the same turn to its row", () => {
    const ledger = memoryLedger();
    ledger.recordSnapshot(snapshot("t1", 100, [{ model: "gpt-x", tokens: tokens(10, 5), costUsd: 1 }]));
    ledger.recordSnapshot(snapshot("t1", 150, [{ model: "gpt-x", tokens: tokens(12, 8), costUsd: 1.25 }]));
    expect(ledgerRows(ledger)).toEqual([{ turn_id: "t1", model: "gpt-x", ts: 100, input: 12, output: 8, cache_read: 0, cost_usd: 1.25 }]);
  });

  it("gives growth its token share of the total when the previous total had no price", () => {
    const ledger = memoryLedger();
    ledger.recordSnapshot(snapshot("t1", 100, [{ model: "gpt-x", tokens: tokens(30, 0), costUsd: null }]));
    ledger.recordSnapshot(snapshot("t2", 200, [{ model: "gpt-x", tokens: tokens(40, 0), costUsd: 4 }]));
    const rows = ledgerRows(ledger) as { turn_id: string; cost_usd: number | null }[];
    expect(rows.map((row) => [row.turn_id, row.cost_usd])).toEqual([
      ["t1", null],
      ["t2", 1],
    ]);
  });

  it("counts a new provider session from zero", () => {
    const ledger = memoryLedger();
    ledger.recordSnapshot(snapshot("t1", 100, [{ model: "gpt-x", tokens: tokens(50, 50), costUsd: 2 }]));
    ledger.recordSnapshot(snapshot("t2", 200, [{ model: "gpt-x", tokens: tokens(3, 4), costUsd: 0.1 }], "sess-2"));
    const rows = ledgerRows(ledger) as { input: number; cost_usd: number }[];
    expect(rows.map((row) => [row.input, row.cost_usd])).toEqual([
      [50, 2],
      [3, 0.1],
    ]);
  });
});

describe("repriceTranscripts", () => {
  const message = (messageId: string, model: string) => ({
    kind: "message" as const,
    messageId,
    sessionId: "sess-1",
    ts: 90,
    model,
    cwd: null,
    tokens: tokens(1_000_000, 0),
  });

  it("re-prices stored transcript rows once per pricing version and leaves ledger rows as reported", () => {
    const ledger = memoryLedger();
    ledger.addTranscriptMessage(message("msg_opus", "claude-opus-5-5"), "local", null);
    ledger.addTranscriptMessage(message("msg_gpt", "gpt-x"), "local", null);
    ledger.recordSnapshot(snapshot("t1", 100, [{ model: "claude-opus-5-5", tokens: tokens(1_000_000, 0), costUsd: 5 }]));
    // A row priced by an older table.
    ledger.db.prepare(`UPDATE usage SET cost_usd = 5 WHERE id = 'transcript:msg_opus'`).run();

    const costs = () =>
      ledger.db.prepare(`SELECT id, cost_usd FROM usage ORDER BY id`).all() as { id: string; cost_usd: number | null }[];
    expect(ledger.repriceTranscripts("2")).toBe(1);
    expect(costs()).toEqual([
      { id: "ledger:thr_one:sess-1:t1:claude-opus-5-5", cost_usd: 5 },
      { id: "transcript:msg_gpt", cost_usd: null },
      { id: "transcript:msg_opus", cost_usd: 4 },
    ]);
    expect(ledger.meta("pricingVersion")).toBe("2");

    ledger.db.prepare(`UPDATE usage SET cost_usd = 5 WHERE id = 'transcript:msg_opus'`).run();
    expect(ledger.repriceTranscripts("2")).toBe(0);
    expect(costs().find((row) => row.id === "transcript:msg_opus")?.cost_usd).toBe(5);
  });
});

describe("tokenGrowth", () => {
  it("subtracts the previous totals, or restarts when any total went down", () => {
    expect(tokenGrowth(null, tokens(5, 5))).toEqual(tokens(5, 5));
    expect(tokenGrowth(tokens(5, 5, 10), tokens(7, 6, 10))).toEqual(tokens(2, 1, 0));
    expect(tokenGrowth(tokens(5, 5), tokens(2, 9))).toEqual(tokens(2, 9));
  });
});

describe("usage_effective", () => {
  it("leaves out ledger rows of a session that also has transcript rows", () => {
    const ledger = memoryLedger();
    ledger.rememberThread(
      { threadId: "thr_one", title: "One", projectId: "proj_1", projectName: "Acme", provider: "claude-code", updatedAt: 1 },
      "sess-1",
    );
    ledger.recordSnapshot(snapshot("t1", 100, [{ model: "claude-opus-5-5", tokens: tokens(10, 10), costUsd: 1 }]));
    ledger.recordSnapshot({ ...snapshot("t1", 100, [{ model: "gpt-x", tokens: tokens(1, 1), costUsd: 0.01 }]), threadId: "thr_two", sessionId: "codex-1" });
    const effective = () =>
      ledger.db.prepare(`SELECT source, tid, model FROM usage_effective ORDER BY source, tid`).all();
    expect(effective()).toEqual([
      { source: "ledger", tid: "thr_one", model: "claude-opus-5-5" },
      { source: "ledger", tid: "thr_two", model: "gpt-x" },
    ]);

    ledger.addTranscriptMessage(
      { kind: "message", messageId: "msg_1", sessionId: "sess-1", ts: 90, model: "claude-opus-5-5", cwd: null, tokens: tokens(10, 12) },
      "local",
      null,
    );
    expect(effective()).toEqual([
      { source: "ledger", tid: "thr_two", model: "gpt-x" },
      { source: "transcript", tid: "thr_one", model: "claude-opus-5-5" },
    ]);
  });
});
