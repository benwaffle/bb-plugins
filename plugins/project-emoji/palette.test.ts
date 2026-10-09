import { describe, expect, it } from "vitest";
import { PROJECT_HUES, parseCssColor, projectAccentColor, projectHue } from "./palette.js";

const SAMPLE_NAMES = ["bb", "atlas", "orchard", "lantern", "quill"];

describe("project palette", () => {
  it("has ten distinct hues", () => {
    expect(new Set(PROJECT_HUES).size).toBe(10);
  });

  it("maps a name to the same color every time", () => {
    expect(SAMPLE_NAMES.map(projectAccentColor)).toEqual([
      "oklch(0.86 0.07 200)",
      "oklch(0.86 0.07 164)",
      "oklch(0.86 0.07 20)",
      "oklch(0.86 0.07 272)",
      "oklch(0.86 0.07 308)",
    ]);
  });

  it("gives the sample projects distinct hues from the palette", () => {
    const hues = SAMPLE_NAMES.map(projectHue);
    expect(hues.every((hue) => PROJECT_HUES.includes(hue))).toBe(true);
    expect(new Set(hues).size).toBe(SAMPLE_NAMES.length);
  });
});

describe("parseCssColor", () => {
  it("accepts hex, keywords, and color functions", () => {
    for (const color of ["#7fb4ff", "#abc", "tomato", "oklch(0.86 0.07 236)", "rgb(10, 20, 30 / 50%)"]) {
      expect(parseCssColor(` ${color} `)).toBe(color);
    }
  });

  it("rejects anything else", () => {
    for (const color of ["", "#12", "red; background: blue", "url(x.png) x", "a".repeat(65)]) {
      expect(parseCssColor(color)).toBeNull();
    }
  });
});
