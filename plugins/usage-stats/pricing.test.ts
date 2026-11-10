import { describe, expect, it } from "vitest";
import { priceTokens, type UsageTokens } from "./pricing.js";

/** One kind of token alone; the default 100,000 stays inside Haiku 5.5's base tier. */
const only = (field: keyof UsageTokens, count = 100_000): UsageTokens => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  [field]: count,
});

/** USD per million tokens of each kind, measured on 100,000 tokens. */
function perMTok(model: string, field: keyof UsageTokens): number | null {
  const cost = priceTokens(model, only(field));
  return cost === null ? null : cost * 10;
}

describe("priceTokens", () => {
  it.each([
    ["claude-fable-5-2", { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 }],
    ["claude-mythos-5-2", { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 }],
    ["claude-opus-5-5", { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }],
    ["claude-sonnet-5-5", { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }],
    ["claude-haiku-5-5", { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }],
  ])("prices %s per million tokens", (model, expected) => {
    for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      expect(perMTok(model, field)).toBeCloseTo(expected[field], 10);
    }
  });

  it("keeps a dated or [1m] id on its model's row, not the family row", () => {
    expect(perMTok("claude-opus-5-5[1m]", "input")).toBeCloseTo(4, 10);
    expect(perMTok("claude-opus-5-20260101", "input")).toBeCloseTo(5, 10);
    expect(perMTok("claude-fable-5-2-20261001", "input")).toBeCloseTo(8, 10);
    expect(perMTok("claude-sonnet-5", "cacheRead")).toBeCloseTo(0.2, 10);
  });

  it("prices a Haiku 5.5 request over 100K prompt tokens at the long-prompt rates", () => {
    // 100,000 prompt tokens is still the base tier.
    expect(priceTokens("claude-haiku-5-5", only("input"))).toBeCloseTo(0.01, 10);
    // Cache reads and writes count toward the prompt length.
    const long = { input: 1_000, output: 1_000, cacheRead: 99_000, cacheWrite: 1_000 };
    // 1,000×$0.50 + 1,000×$2.50 + 99,000×$0.05 + 1,000×$0.625 per million
    expect(priceTokens("claude-haiku-5-5", long)).toBeCloseTo(0.008575, 10);
  });

  it("leaves an unknown id unpriced", () => {
    expect(priceTokens("claude-unknown-9", only("input"))).toBeNull();
    expect(priceTokens("gpt-x", only("output"))).toBeNull();
  });
});
