import { hashString } from "./emoji.js";

/** Ten evenly spaced OKLCH hues, muted enough to read on bb's dark sidebar. */
export const PROJECT_HUES: readonly number[] = [20, 56, 92, 128, 164, 200, 236, 272, 308, 344];

export function projectHue(projectName: string): number {
  return PROJECT_HUES[hashString(projectName) % PROJECT_HUES.length]!;
}

/** The automatic accent for a project: its name's hue at lightness 0.86, chroma 0.07. */
export function projectAccentColor(projectName: string): string {
  return `oklch(0.86 0.07 ${projectHue(projectName)})`;
}

const MAX_COLOR_LENGTH = 64;

/**
 * Accepts the shape of a CSS color (a keyword, `#hex`, or a function such as
 * `oklch(…)`). The browser has the final say: bb drops colors it rejects.
 */
export function parseCssColor(input: string): string | null {
  const value = input.trim();
  if (value.length === 0 || value.length > MAX_COLOR_LENGTH) return null;
  if (/^#[0-9a-f]{3,8}$/i.test(value)) return value;
  if (/^[a-z]+$/i.test(value)) return value;
  if (/^[a-z-]+\([0-9a-z.%,/\s+-]*\)$/i.test(value)) return value;
  return null;
}
