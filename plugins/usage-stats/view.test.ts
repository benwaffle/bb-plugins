import { describe, expect, it } from "vitest";
import type { DayUsage, ModelKey } from "./contract.js";
import { chartSeries, dayValues, deltaText, OTHER_KEY } from "./view.js";

const KEYS: ModelKey[] = [
  { model: "claude-opus-5-5", label: "Opus 5.5", slot: 0 },
  { model: "claude-sonnet-5", label: "Sonnet 5", slot: 1 },
  { model: "claude-haiku-4-5", label: "Haiku 4.5", slot: 2 },
  { model: "gpt-x", label: "gpt-x", slot: 3 },
  { model: "gpt-y", label: "gpt-y", slot: null },
];

const slice = (model: string, input: number, costUsd: number) => ({ model, input, output: 0, cacheRead: 0, cacheWrite: 0, costUsd });

describe("chartSeries", () => {
  it("keeps each model's slot color and folds models without a slot into Other", () => {
    const days: DayUsage[] = [{ day: "2026-10-21", models: [slice("claude-haiku-4-5", 5, 0), slice("gpt-y", 1, 0)] }];
    expect(chartSeries("model", days, KEYS)).toEqual([
      { key: "claude-haiku-4-5", label: "Haiku 4.5", color: "--series-3" },
      { key: OTHER_KEY, label: "Other", color: "--other" },
    ]);
  });

  it("sums a day's values per series for tokens and cost", () => {
    const day: DayUsage = { day: "2026-10-21", models: [slice("claude-opus-5-5", 1_000_000, 5), slice("gpt-y", 10, 0.1)] };
    expect(dayValues(day, "model", "tokens", KEYS)).toEqual({ "claude-opus-5-5": 1_000_000, [OTHER_KEY]: 10 });
    expect(dayValues(day, "model", "cost", KEYS)).toEqual({ "claude-opus-5-5": 5, [OTHER_KEY]: 0.1 });
    expect(dayValues(day, "type", "cost", KEYS)).toMatchObject({ input: 5, output: 0 });
  });
});

describe("deltaText", () => {
  it("states the change against the previous period", () => {
    expect(deltaText(150, 100, 7)).toBe("▲ 50% vs previous 7 days");
    expect(deltaText(50, 100, 1)).toBe("▼ 50% vs previous day");
    expect(deltaText(5, 0, 30)).toBeNull();
  });
});
