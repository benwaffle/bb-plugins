/**
 * Token counts split the way they are billed. `input` excludes cached tokens;
 * `cacheRead` and `cacheWrite` are the two halves of the cached input.
 */
export interface UsageTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const ZERO_TOKENS: UsageTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function totalTokens(tokens: UsageTokens): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
}

/** Cache read ÷ every input token; null when there was no input. */
export function cacheHitRatio(tokens: Pick<UsageTokens, "input" | "cacheRead" | "cacheWrite">): number | null {
  const denominator = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  return denominator === 0 ? null : tokens.cacheRead / denominator;
}

interface Rates {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  cacheWriteUsdPerMTok: number;
  cacheReadUsdPerMTok: number;
}

interface ModelPrice extends Rates {
  /**
   * Higher rates for a request whose prompt (input, cache reads, and cache
   * writes together) is over `overPromptTokens`. The tier applies per API
   * request, so a row summing several requests is priced at the base rates
   * unless its own prompt total crosses the threshold.
   */
  longPrompt?: { overPromptTokens: number; rates: Rates };
}

/** Cache writes are the 5-minute rate, 1.25× input; transcripts don't record which TTL was written. */
function anthropicRates(inputUsdPerMTok: number, outputUsdPerMTok: number, cacheReadUsdPerMTok: number): Rates {
  return {
    inputUsdPerMTok,
    outputUsdPerMTok,
    cacheWriteUsdPerMTok: inputUsdPerMTok * 1.25,
    cacheReadUsdPerMTok,
  };
}

function anthropicPrice(
  inputUsdPerMTok: number,
  outputUsdPerMTok: number,
  cacheReadUsdPerMTok = inputUsdPerMTok * 0.1,
): ModelPrice {
  return anthropicRates(inputUsdPerMTok, outputUsdPerMTok, cacheReadUsdPerMTok);
}

/**
 * Bumped whenever a row of `ANTHROPIC_PRICES` changes, so stored transcript
 * costs are recomputed once on the next plugin start.
 */
export const PRICING_VERSION = 2;

/**
 * Anthropic first-party list prices per million tokens, from
 * https://platform.claude.com/docs/en/about-claude/pricing. First match wins,
 * so a longer prefix comes before the family prefix it would otherwise fall
 * into (claude-opus-5-5 before claude-opus-5).
 */
const ANTHROPIC_PRICES: readonly (readonly [prefix: string, price: ModelPrice])[] = [
  ["claude-fable-5-2", anthropicPrice(8, 40, 0.2)],
  ["claude-mythos-5-2", anthropicPrice(8, 40, 0.2)],
  ["claude-fable-5-1", anthropicPrice(10, 50, 0.25)],
  ["claude-mythos-5-1", anthropicPrice(10, 50, 0.25)],
  ["claude-opus-5-5", anthropicPrice(4, 20, 0.2)],
  ["claude-sonnet-5-5", anthropicPrice(2, 10, 0.1)],
  [
    "claude-haiku-5-5",
    {
      ...anthropicPrice(0.1, 0.5),
      longPrompt: { overPromptTokens: 100_000, rates: anthropicRates(0.5, 2.5, 0.05) },
    },
  ],
  ["claude-fable-5", anthropicPrice(10, 50)],
  ["claude-mythos-5", anthropicPrice(10, 50)],
  ["claude-opus-5", anthropicPrice(5, 25)],
  ["claude-opus-4-8", anthropicPrice(5, 25)],
  ["claude-opus-4-7", anthropicPrice(5, 25)],
  ["claude-opus-4-6", anthropicPrice(5, 25)],
  ["claude-opus-4-5", anthropicPrice(5, 25)],
  ["claude-opus-4", anthropicPrice(15, 75)],
  ["claude-sonnet-5", anthropicPrice(2, 10)],
  ["claude-sonnet-4", anthropicPrice(3, 15)],
  ["claude-3-7-sonnet", anthropicPrice(3, 15)],
  ["claude-haiku-4", anthropicPrice(1, 5)],
  ["claude-3-5-haiku", anthropicPrice(0.8, 4)],
];

function priceFor(model: string): ModelPrice | null {
  for (const [prefix, price] of ANTHROPIC_PRICES) {
    if (model.startsWith(prefix)) return price;
  }
  return null;
}

function ratesFor(price: ModelPrice, tokens: UsageTokens): Rates {
  const long = price.longPrompt;
  if (long === undefined) return price;
  const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  return prompt > long.overPromptTokens ? long.rates : price;
}

/** API-equivalent cost in USD, or null for a model without a list price. */
export function priceTokens(model: string, tokens: UsageTokens): number | null {
  const price = priceFor(model);
  if (price === null) return null;
  const rates = ratesFor(price, tokens);
  return (
    (tokens.input * rates.inputUsdPerMTok +
      tokens.output * rates.outputUsdPerMTok +
      tokens.cacheRead * rates.cacheReadUsdPerMTok +
      tokens.cacheWrite * rates.cacheWriteUsdPerMTok) /
    1_000_000
  );
}

/**
 * What a cache read saved against sending the same tokens uncached. Models
 * without a list price save nothing measurable.
 */
export function cacheSavingsUsd(model: string, cacheReadTokens: number): number {
  const price = priceFor(model);
  if (price === null) return 0;
  return (cacheReadTokens * (price.inputUsdPerMTok - price.cacheReadUsdPerMTok)) / 1_000_000;
}

/** The shape bb's thread cost and token usage events report tokens in. */
export interface BbTokenBreakdown {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens?: number;
  outputTokens: number;
}

/**
 * Converts bb's breakdown to billed halves. bb counts cache writes inside
 * `cachedInputTokens`, and Codex counts cached tokens inside `inputTokens`.
 */
export function fromBbTokens(providerId: string, tokens: BbTokenBreakdown): UsageTokens {
  const cacheWrite = Math.min(tokens.cacheWriteInputTokens ?? 0, tokens.cachedInputTokens);
  const input =
    providerId === "codex"
      ? Math.max(0, tokens.inputTokens - tokens.cachedInputTokens)
      : tokens.inputTokens;
  return {
    input,
    output: tokens.outputTokens,
    cacheRead: tokens.cachedInputTokens - cacheWrite,
    cacheWrite,
  };
}

/** "claude-opus-5-5-20261001" → "Opus 5.5"; unknown names pass through. */
export function modelLabel(model: string): string {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d))?(?:-\d{8})?(?:\[.*\])?$/.exec(model);
  if (match === null) return model;
  const [, family = "", major, minor] = match;
  const name = family.charAt(0).toUpperCase() + family.slice(1);
  return minor === undefined ? `${name} ${major}` : `${name} ${major}.${minor}`;
}
