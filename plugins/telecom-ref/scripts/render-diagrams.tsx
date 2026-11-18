/**
 * Renders every diagram to PNG in bb's default light and dark themes, for a
 * visual check, and writes the layout problems lintLayout finds to layout.txt.
 *
 *   DIAGRAM_OUT=<dir> npm run diagrams:render
 *
 * The SVG comes from the same DiagramCanvas the plugin page mounts; headless
 * Chrome (CHROME, or Google Chrome in /Applications) screenshots it.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { it } from "vitest";
import { bundledDataset } from "../dataset";
import { DiagramCanvas } from "../diagram-canvas";
import { lintLayout } from "../diagram-layout";
import { DIAGRAMS, edgeLabel, nodeLabel } from "../diagrams";

/** bb's default theme tokens (apps/app/src/components/ui/theme.css), anchored on canvas and ink. */
const THEMES = {
  light: { canvas: "oklch(1 0 0)", ink: "oklch(0.3211 0 0)", muted: "oklch(0.44 0 0)", ring: "oklch(0.27 0 0)" },
  dark: { canvas: "oklch(0.195 0 0)", ink: "oklch(0.81 0 0)", muted: "oklch(0.78 0 0)", ring: "oklch(0.82 0 0)" },
} as const;

const SCALE = 1.6;
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function page(svg: string, theme: (typeof THEMES)[keyof typeof THEMES], width: number, height: number, title: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
:root { --background: ${theme.canvas}; --foreground: ${theme.ink}; --muted-foreground: ${theme.muted}; --ring: ${theme.ring}; }
html, body { margin: 0; background: var(--background); color: var(--foreground); font-family: -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif; }
h1 { font-size: 15px; font-weight: 600; margin: 14px 20px 0; }
.frame { width: ${width}px; height: ${height}px; padding: 0 4px; }
[data-render-hidden] { display: none; }
.relative { position: relative; } .h-full { height: 100%; } .w-full { width: 100%; }
</style></head><body><h1>${title}</h1><div class="frame">${svg}</div></body></html>`;
}

it("renders every diagram", () => {
  if (!process.env.DIAGRAM_OUT) throw new Error("set DIAGRAM_OUT to the directory the PNGs go to");
  const out = resolve(process.env.DIAGRAM_OUT);
  mkdirSync(out, { recursive: true });
  const dataset = bundledDataset();
  const only = process.env.DIAGRAM_ONLY?.split(",");
  const report: string[] = [];
  for (const diagram of DIAGRAMS) {
    if (only && !only.includes(diagram.id)) continue;
    const issues = lintLayout(diagram, (edge) => edgeLabel(edge, dataset), (node, row) => nodeLabel(node, row, dataset));
    report.push(`${diagram.id}: ${issues.length === 0 ? "layout clean" : `${issues.length} layout issues`}`, ...issues.map((issue) => `  ${issue}`));
    const svg = renderToStaticMarkup(<DiagramCanvas diagram={diagram} dataset={dataset} picked={null} onPick={() => {}} />);
    const width = Math.round((diagram.width + 32) * SCALE);
    const height = Math.round((diagram.height + 32) * SCALE);
    for (const [name, theme] of Object.entries(THEMES)) {
      const html = join(out, `${diagram.id}-${name}.html`);
      writeFileSync(html, page(svg, theme, width, height, `${diagram.title} · ${diagram.variant}`));
      execFileSync(CHROME, [
        "--headless",
        "--disable-gpu",
        "--hide-scrollbars",
        `--window-size=${width + 8},${height + 48}`,
        `--screenshot=${join(out, `${diagram.id}-${name}.png`)}`,
        `file://${html}`,
      ], { stdio: "ignore" });
    }
  }
  writeFileSync(join(out, "layout.txt"), `${report.join("\n")}\n`);
}, 120_000);
