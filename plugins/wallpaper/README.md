# Wallpaper

Shows one local image behind bb's thread timeline and New thread screen, with
optional dim and blur. It is pure CSS: no canvas and no resize handling.
Toggling the sidebar or resizing the window moves the image along with the
pane, without redrawing it.

## Install

```sh
bb plugin install git:https://github.com/benwaffle/bb-plugins.git@main --plugin wallpaper
```

From a local checkout:

```sh
bb plugin install path:. --plugin wallpaper
```

## Use

```sh
bb wallpaper apply ~/Pictures/day.jpg --dim 20 --blur 4
bb wallpaper show
bb wallpaper clear
```

The same payload works over RPC, for scripts:

```sh
bb plugin rpc call wallpaper apply --input '{"path":"/Users/me/Pictures/day.jpg"}'
```

Settings → Installed plugins → Wallpaper has the same fields: **Show
wallpaper**, **Image path**, **Dim (%)** (0-80), and **Blur (px)** (0-20).

## How it works

- **Layer.** An `experimental_appOverlay` component renders one `<style>`
  element. The image is the `::before` or `::after` pseudo-element of
  `#thread-detail-timeline-panel` and `#root-compose-main-panel`, with
  `position:absolute; inset:0; z-index:-1`. The panel gets
  `isolation:isolate`, so the layer sits above the panel's own background and
  below its content. The layer uses `background-size:cover` and
  `background-position:center`. There is no DOM injection and no
  MutationObserver. When React replaces a panel, the CSS still matches the new
  element.
- **Dim.** A translucent black gradient layered over the image in the same
  `background-image`.
- **Blur.** `filter: blur()` on the layer itself, not `backdrop-filter`. The
  layer overhangs the pane by twice the radius so the soft edges fall outside
  the pane's `overflow: clip`.
- **Title bar.** While bb frames the pane under the macOS title bar, it clips
  the pane's foreign children to below the bar. The clip uses a Tailwind
  class, and it does not reach pseudo-elements. The wallpaper therefore
  applies the same `clip-path` to its layer whenever that class is present.
- **Image swaps.** The server serves the file at `/http/image?v=<hash>`. The
  hash is the first 16 hex digits of the SHA-256 of the file. A URL whose hash
  matches the current file is sent with `Cache-Control: immutable`; any other
  hash gets `no-cache`. When a new file is applied, the app preloads and
  decodes it into the hidden pseudo-element. It then swaps the two opacities,
  which crossfades in 200 ms. A file's hash is cached by path, size, and
  mtime.
- **Legibility.** bb paints an opaque background on the thread's scroll area
  and composer footer. The plugin makes those transparent beside the text
  column. It keeps the column, its footer, and wide Markdown tables on
  `var(--background)`. These rules are the reading-surface rules from
  [aura](https://github.com/MateoCerquetella/bb-plugins/tree/main/plugins/aura).
  They are present only while a wallpaper is showing.

## Development

```sh
npm run check   # bb plugin types --check, tsc, vitest, bb plugin build
```
