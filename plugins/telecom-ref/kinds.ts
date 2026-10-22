import type { CSSProperties } from "react";
import type { EntityKind } from "./types";

/** An OKLCH color without alpha. */
export interface Oklch {
  l: number;
  c: number;
  h: number;
}

export interface KindStyle {
  /** The badge text: "AVP", "Command". */
  label: string;
  /** The hue the badge is tinted with in both themes. */
  hue: number;
}

/**
 * One hue per kind, spread around the wheel so neighbouring badges never
 * share a family, and kept clear of bb's destructive red and success green.
 */
export const KIND_STYLES: Record<EntityKind, KindStyle> = {
  cmd: { label: "Command", hue: 255 },
  avp: { label: "AVP", hue: 185 },
  app: { label: "Application", hue: 300 },
  if: { label: "Interface", hue: 70 },
  nf: { label: "NF", hue: 345 },
};

/** Badge text lightness and chroma per theme; the tint behind it is the same color at TINT_ALPHA. */
export const BADGE_TEXT = {
  light: { l: 0.47, c: 0.12 },
  dark: { l: 0.8, c: 0.1 },
} as const;

export const TINT_ALPHA = 0.12;

export function badgeColor(kind: EntityKind, theme: keyof typeof BADGE_TEXT): Oklch {
  return { ...BADGE_TEXT[theme], h: KIND_STYLES[kind].hue };
}

function css({ l, c, h }: Oklch, alpha = 1): string {
  return alpha === 1 ? `oklch(${l} ${c} ${h})` : `oklch(${l} ${c} ${h} / ${alpha})`;
}

/** The custom properties the KindBadge classes read: text and tint, light and dark. */
export function kindVars(kind: EntityKind): CSSProperties {
  const light = badgeColor(kind, "light");
  const dark = badgeColor(kind, "dark");
  return {
    "--kind-fg": css(light),
    "--kind-bg": css(light, TINT_ALPHA),
    "--kind-fg-dark": css(dark),
    "--kind-bg-dark": css(dark, TINT_ALPHA),
  } as CSSProperties;
}
