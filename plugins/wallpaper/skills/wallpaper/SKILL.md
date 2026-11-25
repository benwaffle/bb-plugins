---
name: wallpaper
description: "Set, show, or clear the image bb shows behind its thread and New thread panes, with optional dim and blur, with the bb wallpaper commands."
---

# Wallpaper

The wallpaper plugin shows one local image file behind a thread's timeline
and the New thread screen. The image covers the pane and is centered. The text
column, its composer footer, and wide Markdown tables keep the theme's solid
background, so text stays readable. The image starts below the macOS title bar.

## Commands

```
bb wallpaper apply <path> [--dim N] [--blur N] [--json]
bb wallpaper show [--json]
bb wallpaper clear [--json]
```

- `apply` checks the file and stores its absolute path. It also turns the
  wallpaper on. A relative path resolves against the current directory, and
  `~/` expands. Supported files are `.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`,
  and `.avif`, up to 50 MB.
  - `--dim` darkens the image by 0-80%.
  - `--blur` blurs it by 0-20 px.
  - An omitted option keeps its current value.
  - Errors: `not_found`, `not_a_file`, `unsupported_type`, `too_large`,
    `relative_path`.
- `show` prints `enabled`, `path`, `dim`, and `blur`. When the file can be
  served it also prints `hash` and `bytes`. When the stored path cannot be
  served it prints `error`. `--json` prints
  `{"enabled","path","dim","blur","image":{"url","hash","mime","bytes"}|null,"error"}`.
- `clear` drops the image path and keeps dim and blur.

Open bb windows update as soon as a command finishes. When the image changes,
the new one fades in over the old one in 200 ms without a reload.

## RPC

The `apply` RPC takes the same payload, with an absolute or `~/` path:

```sh
bb plugin rpc call wallpaper apply --input '{"path":"/abs/image.jpg","dim":20,"blur":0}'
```

`get` and `clear` take `null`. All three return the `show --json` shape.

## Settings

The plugin settings page has fields for **Show wallpaper**, **Image path**,
**Dim (%)**, and **Blur (px)**. You can also set them with
`bb plugin config wallpaper set <enabled|imagePath|dim|blur> <value>`.
Turning **Show wallpaper** off keeps the path.

## Constraints

- The image is read from the bb server's filesystem, so the path is on the
  server's machine.
- Replacing the file in place gives it a new content hash. Windows pick up the
  new image the next time they fetch the state: on an `apply`, a settings
  change, or a realtime reconnect.
