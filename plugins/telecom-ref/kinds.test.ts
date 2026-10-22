import { describe, expect, it } from "vitest";
import { KINDS } from "./dataset";
import { badgeColor, KIND_STYLES, kindVars, TINT_ALPHA, type Oklch } from "./kinds";

/** bb's canvas colors: oklch(100% 0 0) in the light theme, oklch(19.5% 0 0) in the dark one. */
const CANVAS = { light: { l: 1, c: 0, h: 0 }, dark: { l: 0.195, c: 0, h: 0 } } as const;

/** OKLCH to gamma-encoded sRGB channels in 0..1, clipped to the gamut the way a display shows them. */
function toSrgb({ l, c, h }: Oklch): [number, number, number] {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const lms = [l + 0.3963377774 * a + 0.2158037573 * b, l - 0.1055613458 * a - 0.0638541728 * b, l - 0.0894841775 * a - 1.291485548 * b].map(
    (v) => v ** 3,
  ) as [number, number, number];
  const [L, M, S] = lms;
  const linear = [
    4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
  ];
  return linear.map((v) => {
    const x = Math.min(1, Math.max(0, v));
    return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
  }) as [number, number, number];
}

function luminance(rgb: readonly number[]): number {
  const [r = 0, g = 0, b = 0] = rgb.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: readonly number[], b: readonly number[]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("kind badges", () => {
  it("label every kind with its own word and hue", () => {
    expect(Object.fromEntries(KINDS.map((kind) => [kind, KIND_STYLES[kind].label]))).toEqual({
      cmd: "Command",
      avp: "AVP",
      app: "Application",
      if: "Interface",
      nf: "NF",
    });
    expect(new Set(KINDS.map((kind) => KIND_STYLES[kind].hue)).size).toBe(KINDS.length);
  });

  it("set the light and dark custom properties from the kind's hue", () => {
    expect(kindVars("avp")).toEqual({
      "--kind-fg": "oklch(0.47 0.12 185)",
      "--kind-bg": `oklch(0.47 0.12 185 / ${TINT_ALPHA})`,
      "--kind-fg-dark": "oklch(0.8 0.1 185)",
      "--kind-bg-dark": `oklch(0.8 0.1 185 / ${TINT_ALPHA})`,
    });
  });

  it.each(["light", "dark"] as const)("meet WCAG AA contrast on their tint in the %s theme", (theme) => {
    const canvas = toSrgb(CANVAS[theme]);
    for (const kind of KINDS) {
      const text = toSrgb(badgeColor(kind, theme));
      const tint = text.map((channel, index) => channel * TINT_ALPHA + (canvas[index] ?? 0) * (1 - TINT_ALPHA));
      expect(contrast(text, tint), `${kind} in ${theme}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
