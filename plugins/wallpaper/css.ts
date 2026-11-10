/**
 * The panes that show the wallpaper: a thread's timeline and the New thread
 * screen. Both are react-resizable-panels `<Panel>`s with `overflow: clip`,
 * so a layer that overhangs them (for blur) is clipped to the pane.
 */
export const PANELS = ':is([id="thread-detail-timeline-panel"],[id="root-compose-main-panel"])';

/**
 * Matches a pane while bb frames it under the macOS title bar. bb marks that
 * state only with a Tailwind class that clips the pane's foreign children to
 * below the title bar; pseudo-elements are not children, so the wallpaper
 * applies the same clip itself.
 */
export const FRAMED = '[class*="clip-path:inset(var(--bb-window-title-bar-height)"]';

export const FADE_MS = 200;

/**
 * bb paints an opaque background on the thread's scroll area and footer.
 * Clear those so the wallpaper shows beside the text column, and paint the
 * column, its footer, and wide Markdown tables with the theme background so
 * text stays on a solid surface.
 */
export const READING_SURFACE = `
[id="thread-detail-timeline-panel"] .thread-scrollbar:has(> div > .mx-auto){background-color:transparent;}
[id="thread-detail-timeline-panel"] .thread-scrollbar > div > .mx-auto{background-color:var(--background);box-shadow:0 0 0 1px var(--border);}
[id="thread-detail-timeline-panel"] [data-scroll-footer] > .bg-background:has(> .mx-auto){background-color:transparent;}
[id="thread-detail-timeline-panel"] [data-scroll-footer] > .bg-background > .mx-auto{background-color:var(--background);}
[id="thread-detail-timeline-panel"] [data-scroll-footer] > .bg-background:has(> .mx-auto) > [data-overflow-fade]{left:50%;right:auto;width:min(760px,100%);transform:translateX(-50%);}
[id="thread-detail-timeline-panel"] [data-markdown-preview] table,
[id="thread-detail-timeline-panel"] [data-markdown-preview] div:has(> table){background-color:var(--background);}
`;

/**
 * Two image slots, `::before` and `::after`, so a new image fades in over the
 * old one. `front` is the slot at full opacity.
 */
export interface LayerState {
  slots: readonly [string | null, string | null];
  front: 0 | 1;
}

export interface Appearance {
  /** Percent, 0-80. */
  dim: number;
  /** Pixels, 0-20. */
  blur: number;
}

/** How far a blurred layer overhangs the pane so its soft edges fall outside. */
export function blurOverhang(blur: number): number {
  return blur * 2;
}

function backgroundImage(url: string | null, dim: number): string {
  if (url === null) return "none";
  const image = `url(${JSON.stringify(url)})`;
  if (dim === 0) return image;
  const shade = `rgb(0 0 0 / ${dim / 100})`;
  return `linear-gradient(${shade},${shade}),${image}`;
}

/**
 * The whole wallpaper as one stylesheet. Layout, resizing, and image swaps
 * are left to the browser: nothing here depends on the pane's size.
 */
export function wallpaperCss(layers: LayerState, appearance: Appearance): string {
  const { dim, blur } = appearance;
  const overhang = blurOverhang(blur);
  const layer = `${PANELS}::before,${PANELS}::after`;
  const framed = `${PANELS}${FRAMED}::before,${PANELS}${FRAMED}::after`;
  const slot = (index: 0 | 1, pseudo: "before" | "after") =>
    `${PANELS}::${pseudo}{background-image:${backgroundImage(layers.slots[index], dim)};opacity:${layers.front === index ? 1 : 0};}`;
  return [
    `${PANELS}{position:relative;isolation:isolate;}`,
    `${layer}{content:"";position:absolute;inset:${overhang === 0 ? "0" : `-${overhang}px`};z-index:-1;pointer-events:none;` +
      `background-position:center;background-size:cover;background-repeat:no-repeat;` +
      `${blur === 0 ? "" : `filter:blur(${blur}px);`}transition:opacity ${FADE_MS}ms ease;}`,
    `${framed}{clip-path:inset(calc(var(--bb-window-title-bar-height) + ${overhang}px) 0 0);}`,
    `@media (prefers-reduced-motion:reduce){${layer}{transition:none;}}`,
    slot(0, "before"),
    slot(1, "after"),
    READING_SURFACE,
  ].join("\n");
}

export const NO_LAYERS: LayerState = { slots: [null, null], front: 0 };

/**
 * Puts `url` in the hidden slot and brings that slot to the front, so the
 * opacity transition fades it in over the current image. `null` fades the
 * current image out. Showing the image already in front is a no-op.
 */
export function showImage(layers: LayerState, url: string | null): LayerState {
  if (layers.slots[layers.front] === url) return layers;
  const back: 0 | 1 = layers.front === 0 ? 1 : 0;
  const slots: [string | null, string | null] = [...layers.slots];
  slots[back] = url;
  return { slots, front: back };
}

/** Empties the hidden slot once its fade-out has finished. */
export function dropHidden(layers: LayerState): LayerState {
  const back: 0 | 1 = layers.front === 0 ? 1 : 0;
  if (layers.slots[back] === null) return layers;
  const slots: [string | null, string | null] = [...layers.slots];
  slots[back] = null;
  return { slots, front: layers.front };
}

export function isEmpty(layers: LayerState): boolean {
  return layers.slots[0] === null && layers.slots[1] === null;
}
