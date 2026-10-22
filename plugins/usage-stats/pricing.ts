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

interface ModelPrice {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  cacheWriteUsdPerMTok: number;
  cacheReadUsdPerMTok: number;
}

function anthropicPrice(
  inputUsdPerMTok: number,
  outputUsdPerMTok: number,
  cacheReadUsdPerMTok = inputUsdPerMTok * 0.1,
): ModelPrice {
  return {
    inputUsdPerMTok,
    outputUsdPerMTok,
    cacheWriteUsdPerMTok: inputUsdPerMTok * 1.25,
    cacheReadUsdPerMTok,
  };
}

/**
 * Anthropic list prices per million tokens, the same table bb prices Claude
 * Code threads with, so transcript rows and ledger rows agree. First match
 * wins, so longer prefixes come first.
 */
const ANTHROPIC_PRICES: readonly (readonly [prefix: string, price: ModelPrice])[] = [
  ["claude-fable-5-1", anthropicPrice(10, 50, 0.25)],
  ["claude-mythos-5-1", anthropicPrice(10, 50, 0.25)],
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

/** API-equivalent cost in USD, or null for a model without a list price. */
export function priceTokens(model: string, tokens: UsageTokens): number | null {
  const price = priceFor(model);
  if (price === null) return null;
  return (
    (tokens.input * price.inputUsdPerMTok +
      tokens.output * price.outputUsdPerMTok +
      tokens.cacheRead * price.cacheReadUsdPerMTok +
      tokens.cacheWrite * price.cacheWriteUsdPerMTok) /
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
