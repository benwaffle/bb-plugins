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

const OKLCH_HUE = /^oklch\(\s*\S+\s+\S+\s+(-?\d*\.?\d+)(?:deg)?\s*(?:\/[^)]*)?\)$/i;
const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const ACHROMATIC_CHROMA = 0.01;

function linearSrgb(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** The OKLCH hue of `#hex` digits, or undefined for a gray. */
function hexHue(digits: string): number | undefined {
  const rgb = digits.length <= 4 ? [...digits].map((digit) => digit + digit).join("") : digits;
  const r = linearSrgb(Number.parseInt(rgb.slice(0, 2), 16));
  const g = linearSrgb(Number.parseInt(rgb.slice(2, 4), 16));
  const b = linearSrgb(Number.parseInt(rgb.slice(4, 6), 16));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const labA = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const labB = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  if (Math.hypot(labA, labB) < ACHROMATIC_CHROMA) return undefined;
  return (Math.round((Math.atan2(labB, labA) * 180) / Math.PI) + 360) % 360;
}

/**
 * The OKLCH hue (0–360) of a pinned header color, for `#hex` and `oklch(…)`
 * colors. Undefined for grays and for other color forms.
 */
export function colorHue(color: string): number | undefined {
  const oklch = OKLCH_HUE.exec(color);
  if (oklch !== null) return ((Number(oklch[1]) % 360) + 360) % 360;
  const hex = HEX.exec(color);
  return hex === null ? undefined : hexHue(hex[1]!);
}
