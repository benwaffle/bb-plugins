# Project emoji

Puts an emoji before each project's name in bb's sidebar. Every project gets
one automatically; click it to choose another from a searchable picker, or
reset it to the automatic pick.

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
   not 🐙. Examples: `bb` → 🐙, `hss` → 📡, `raycast` → 🚀, `plugins` → 🔌,
   `skills` → 🧠, `api`/`server` → 🛠️, `ios`/`android`/`mobile` → 📱,
   `docs` → 📚, `infra`/`terraform`/`aws` → ☁️. The personal project gets 🏠.
2. Otherwise an FNV-1a hash of the project id picks from 48 defaults, skipping
   any emoji another project already holds, so projects stay distinct until the
   48 run out.

## Picker

Click a project's emoji. The picker searches emoji names and keywords, accepts
a pasted emoji that is not in its list, and has **Reset to automatic**. Enter
picks the first match. On a narrow window it opens as a bottom drawer.

## CLI

```
bb project-emoji list [--json]
bb project-emoji set <projectId> <emoji> [--json]
bb project-emoji clear <projectId> [--json]
```

`list` prints `emoji`, `manual` or `auto`, project id, and name, tab
separated. `clear` (alias `reset`) drops a pinned emoji and stores a fresh
automatic pick. Changes reach open bb windows immediately.

## Storage

Picks live in the plugin's key-value storage in bb.db, one `project:<id>` row
per project holding `{ emoji, source }`. Uninstalling the plugin removes them.

## Limits

- bb's plugin API has no slot for project rows, so the plugin inserts its
  button into the bundled sidebar list's DOM, finding rows by
  `data-sidebar-project-id`. A sidebar list from another plugin, or a change to
  that markup, shows no emoji.
- The core project context menu cannot take plugin items, so there is no
  "Change icon…" entry; clicking the emoji opens the picker.
- Only the sidebar shows the emoji. Project headers elsewhere in the app have
  no plugin surface.
- Rows of deleted projects stay in storage and keep their emoji reserved for
  the distinctness check.
