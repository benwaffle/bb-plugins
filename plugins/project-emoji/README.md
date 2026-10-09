# Project emoji

Puts an emoji before each project's name in bb's sidebar, and colors the
project's header. Every project gets an emoji and a color automatically;
click the emoji to choose another from a searchable picker, or reset it to the
automatic pick.

## Install

```sh
bb plugin install git:https://github.com/benwaffle/bb-plugins.git@main --plugin project-emoji
```

From a local checkout:

```sh
bb plugin install path:. --plugin project-emoji
```

## Automatic picks

The first time the plugin sees a project it picks an emoji and stores it, so
renaming or moving the project later does not change it.

1. A keyword table is checked against the project name, then the last segment
   of each checkout path, then the git remote's repository name. Within one of
   those, the rule listed first in `emoji.ts` wins, so `bb-plugins` gets 🔌,
   not 🐙. Examples: `bb` → 🐙, `telecom` → 📡, `raycast` → 🚀, `plugins` → 🔌,
   `skills` → 🧠, `api`/`server` → 🛠️, `ios`/`android`/`mobile` → 📱,
   `docs` → 📚, `infra`/`terraform`/`aws` → ☁️. The personal project gets 🏠.
2. Otherwise an FNV-1a hash of the project id picks from 48 defaults, skipping
   any emoji another project already holds, so projects stay distinct until the
   48 run out.

## Header colors

On bb builds with the `experimental_sidebarProjectDecoration` slot, each
project header shows its name in bold in the project's color, over a faint
wash of that color. The color is `oklch(0.86 0.07 h)`, where `h` is one of ten
hues (20°, 56°, … 344°) chosen by an FNV-1a hash of the project name. It is
computed, not stored, so renaming a project can change it. The palette is
tuned for the dark theme.

- Turn the wash off with the **Tint project headers** plugin setting. The name
  stays bold and colored.
- Pin a color with `bb project-emoji color <projectId> <css-color>`; `auto`
  removes the pin.

## Picker

Click a project's emoji. The picker searches emoji names and keywords, accepts
a pasted emoji that is not in its list, and has **Reset to automatic**. Enter
picks the first match. On a narrow window it opens as a bottom drawer.

## CLI

```
bb project-emoji list [--json]
bb project-emoji set <projectId> <emoji> [--json]
bb project-emoji clear <projectId> [--json]
bb project-emoji color <projectId> <css-color|auto> [--json]
```

`list` prints `emoji`, `manual` or `auto`, the header color, project id, and
name, tab separated; `--json` adds `colors`, the pinned colors only. `clear`
(alias `reset`) drops a pinned emoji and stores a fresh automatic pick.
`color` takes a hex color, a keyword, or a color function such as
`oklch(0.86 0.07 236)`; bb ignores a color the browser does not accept.
Changes reach open bb windows immediately.

## Storage

Picks live in the plugin's key-value storage in bb.db: one `project:<id>` row
per project holding `{ emoji, source }`, and one `color:<id>` row per pinned
color. `bb plugin remove` deletes the plugin's settings but keeps these rows,
so a reinstall under the same plugin id finds them again.

## Limits

- Older bb builds have no project header slot. There the plugin inserts its
  emoji button into the bundled sidebar list's DOM, finding rows by
  `data-sidebar-project-id`, and headers get no color. A sidebar list from
  another plugin, or a change to that markup, shows no emoji.
- The core project context menu cannot take plugin items, so there is no
  "Change icon…" entry; clicking the emoji opens the picker.
- Only the sidebar shows the emoji. Project headers elsewhere in the app have
  no plugin surface.
- Rows of deleted projects stay in storage and keep their emoji reserved for
  the distinctness check.
