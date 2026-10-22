import type { DayUsage, ModelKey, ModelSlice, Totals } from "./contract.js";
import { priceTokens, totalTokens, ZERO_TOKENS, type UsageTokens } from "./pricing.js";

export type StackBy = "model" | "type";
export type Metric = "tokens" | "cost";

export interface ChartSeries {
  key: string;
  label: string;
  color: string;
}

export const OTHER_KEY = "__other__";

const SLOT_COLORS = ["--series-1", "--series-2", "--series-3", "--series-4"] as const;

type TokenType = keyof UsageTokens;

export const TOKEN_TYPES: readonly (ChartSeries & { key: TokenType })[] = [
  { key: "cacheRead", label: "Cache read", color: "--series-1" },
  { key: "cacheWrite", label: "Cache write", color: "--series-2" },
  { key: "input", label: "Input", color: "--series-3" },
  { key: "output", label: "Output", color: "--series-4" },
];

/** Series key for a model: its own key with a color slot, or Other. */
function modelSeriesKey(model: string, slots: ReadonlyMap<string, number | null>): string {
  return slots.get(model) == null ? OTHER_KEY : model;
}

/**
 * The series a stacked chart draws, bottom first. Models keep their fixed
 * slot color; models without one fold into a gray Other on top.
 */
export function chartSeries(stack: StackBy, days: readonly DayUsage[], keys: readonly ModelKey[]): ChartSeries[] {
  if (stack === "type") return [...TOKEN_TYPES];
  const present = new Set(days.flatMap((day) => day.models.filter((slice) => totalTokens(slice) > 0).map((slice) => slice.model)));
  const series: ChartSeries[] = keys
    .filter((key) => key.slot !== null && present.has(key.model))
    .sort((left, right) => (left.slot ?? 0) - (right.slot ?? 0))
    .map((key) => ({ key: key.model, label: key.label, color: modelColor(key.model, keys) }));
  const slots = new Map(keys.map((key) => [key.model, key.slot]));
  if ([...present].some((model) => modelSeriesKey(model, slots) === OTHER_KEY)) {
    series.push({ key: OTHER_KEY, label: "Other", color: "--other" });
  }
  return series;
}

/** A model's fixed slot color, or Other's gray. */
export function modelColor(model: string, keys: readonly ModelKey[]): string {
  const slot = keys.find((key) => key.model === model)?.slot;
  return slot == null ? "--other" : (SLOT_COLORS[slot] ?? "--other");
}

/** API-equivalent cost of one token type of a slice. */
function typeCost(slice: ModelSlice, type: TokenType): number {
  return priceTokens(slice.model, { ...ZERO_TOKENS, [type]: slice[type] }) ?? 0;
}

/** One day's value per series key. */
export function dayValues(day: DayUsage, stack: StackBy, metric: Metric, keys: readonly ModelKey[]): Record<string, number> {
  const values: Record<string, number> = {};
  if (stack === "type") {
    for (const type of TOKEN_TYPES) {
      values[type.key] = day.models.reduce(
        (sum, slice) => sum + (metric === "tokens" ? slice[type.key] : typeCost(slice, type.key)),
        0,
      );
    }
    return values;
  }
  const slots = new Map(keys.map((key) => [key.model, key.slot]));
  for (const slice of day.models) {
    const key = modelSeriesKey(slice.model, slots);
    values[key] = (values[key] ?? 0) + (metric === "tokens" ? totalTokens(slice) : slice.costUsd);
  }
  return values;
}

/** "▲ 12% vs previous 7 days", or null when there is nothing to compare with. */
export function deltaText(current: number, previous: number, days: number): string | null {
  if (previous <= 0) return null;
  const change = (current / previous - 1) * 100;
  const arrow = change >= 0 ? "▲" : "▼";
  return `${arrow} ${Math.abs(change).toFixed(0)}% vs previous ${days === 1 ? "day" : `${days} days`}`;
}

export function perTurnUsd(totals: Totals): number | null {
  return totals.turns === 0 ? null : totals.costUsd / totals.turns;
}

/** "2026-10-22" → a local Date at midnight. */
export function parseDay(day: string): Date {
  const [year = 1970, month = 1, date = 1] = day.split("-").map(Number);
  return new Date(year, month - 1, date);
}

export function relativeTime(ts: number, now: number): string {
  const minutes = Math.round((now - ts) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/** Time until an ISO reset instant: "resets in 1h 52m", or the weekday and time past a day. */
export function resetText(resetsAt: string | null, now: number): string {
  if (resetsAt === null) return "";
  const at = Date.parse(resetsAt);
  if (Number.isNaN(at)) return "";
  const minutes = Math.max(0, Math.round((at - now) / 60_000));
  if (minutes < 24 * 60) return `resets in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `resets ${new Date(at).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
}

export type Load<T> = { status: "loading" } | { status: "ready"; value: T } | { status: "error"; message: string };

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const timeLabel = (ts: number) =>
  new Date(ts).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
