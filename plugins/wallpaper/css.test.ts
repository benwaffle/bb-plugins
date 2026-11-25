import { describe, expect, it } from "vitest";
import { NO_LAYERS, PANELS, dropHidden, isEmpty, showImage, wallpaperCss } from "./css.js";

const A = "/api/v1/plugins/wallpaper/http/image?v=aaaaaaaaaaaaaaaa";
const B = "/api/v1/plugins/wallpaper/http/image?v=bbbbbbbbbbbbbbbb";

describe("layer swaps", () => {
  it("fades a new image in over the current one", () => {
    const first = showImage(NO_LAYERS, A);
    expect(first).toEqual({ slots: [null, A], front: 1 });
    const second = showImage(first, B);
    expect(second).toEqual({ slots: [B, A], front: 0 });
    expect(dropHidden(second)).toEqual({ slots: [B, null], front: 0 });
  });

  it("keeps the same state when the image is already in front", () => {
    const layers = showImage(NO_LAYERS, A);
    expect(showImage(layers, A)).toBe(layers);
    expect(dropHidden(layers)).toBe(layers);
  });

  it("fades out to nothing", () => {
    const hidden = showImage(showImage(NO_LAYERS, A), null);
    expect(hidden).toEqual({ slots: [null, A], front: 0 });
    expect(isEmpty(hidden)).toBe(false);
    expect(isEmpty(dropHidden(hidden))).toBe(true);
  });
});

describe("wallpaperCss", () => {
  const layers = { slots: [A, B], front: 1 } as const;

  it("paints both slots with cover/center and only the front one opaque", () => {
    const css = wallpaperCss(layers, { dim: 0, blur: 0 });
    expect(css).toContain(`${PANELS}::before{background-image:url("${A}");opacity:0;}`);
    expect(css).toContain(`${PANELS}::after{background-image:url("${B}");opacity:1;}`);
    expect(css).toContain("background-size:cover");
    expect(css).toContain("background-position:center");
    expect(css).toContain("transition:opacity 200ms ease");
    expect(css).not.toContain("filter:");
    expect(css).not.toContain("backdrop-filter");
    expect(css).toContain("inset:0;");
  });

  it("dims with a shade over the image", () => {
    const css = wallpaperCss(layers, { dim: 35, blur: 0 });
    expect(css).toContain(`background-image:linear-gradient(rgb(0 0 0 / 0.35),rgb(0 0 0 / 0.35)),url("${B}")`);
  });

  it("blurs the layer once and overhangs the pane by twice the radius", () => {
    const css = wallpaperCss(layers, { dim: 0, blur: 8 });
    expect(css).toContain("filter:blur(8px);");
    expect(css).toContain("inset:-16px;");
    expect(css).toContain("clip-path:inset(calc(var(--bb-window-title-bar-height) + 16px) 0 0)");
  });

  it("writes an empty slot as no image", () => {
    const css = wallpaperCss({ slots: [A, null], front: 0 }, { dim: 20, blur: 0 });
    expect(css).toContain(`${PANELS}::after{background-image:none;opacity:0;}`);
  });
});
