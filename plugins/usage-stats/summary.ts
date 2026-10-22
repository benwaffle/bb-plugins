import type { ModelSlice, ProjectRow, Totals } from "./contract.js";
import { formatPercent, formatTokens, formatUsd } from "./format.js";
import { cacheHitRatio, modelLabel, totalTokens } from "./pricing.js";

export interface SummaryPeriod {
  label: string;
  totals: Totals;
}

export interface SummaryInput {
  days: number;
  periods: readonly SummaryPeriod[];
  models: readonly ModelSlice[];
  projects: readonly ProjectRow[];
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function padStart(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

/** The `bb usage-stats summary` text: periods, then the last period's models and projects. */
export function formatSummary(input: SummaryInput): string {
  const lines: string[] = ["Cost is API-equivalent: token counts priced at list rates, not what a subscription bills.", ""];
  lines.push(
    [pad("Period", 10), padStart("Cost", 9), padStart("Tokens", 9), padStart("Output", 8), padStart("Cache hit", 10), padStart("Turns", 7), padStart("Threads", 8)].join(" "),
  );
  for (const period of input.periods) {
    const totals = period.totals;
    lines.push(
      [
        pad(period.label, 10),
        padStart(formatUsd(totals.costUsd), 9),
        padStart(formatTokens(totals.tokens), 9),
        padStart(formatTokens(totals.output), 8),
        padStart(formatPercent(cacheHitRatio(totals)), 10),
        padStart(String(totals.turns), 7),
        padStart(String(totals.threads), 8),
      ].join(" "),
    );
  }
  if (input.models.length > 0) {
    lines.push("", `Models, last ${input.days} days`);
    for (const model of input.models) {
      const tokens = totalTokens(model);
      lines.push(`  ${pad(modelLabel(model.model), 18)} ${padStart(formatUsd(model.costUsd), 9)} ${padStart(formatTokens(tokens), 9)}`);
    }
  }
  if (input.projects.length > 0) {
    lines.push("", `Projects, last ${input.days} days`);
    for (const project of input.projects) {
      lines.push(`  ${pad(project.name, 18)} ${padStart(formatUsd(project.costUsd), 9)} ${padStart(formatTokens(project.tokens), 9)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
