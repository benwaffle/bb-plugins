---
name: project-emoji
description: "Show, pin, or reset the emoji and header color bb's sidebar shows for each project, with the bb project-emoji commands."
---

# Project emoji

The project-emoji plugin shows an emoji before each project name in the
sidebar. A project without a pinned emoji gets an automatic one, chosen once
from keywords in its name or checkout path, else from a hash of its id, and
stored so it never changes on its own.

On bb builds with the project header slot it also shows the project name in
bold in the project's color, over a faint wash of that color. A project
without a pinned color gets one of ten hues from a hash of its name. The
**Tint project headers** plugin setting (on by default) controls the wash.

## Commands

```
bb project-emoji list [--json]
bb project-emoji set <projectId> <emoji> [--json]
bb project-emoji clear <projectId> [--json]
bb project-emoji color <projectId> <css-color|auto> [--json]
```

- `list` prints one tab-separated line per project: emoji, `manual` or
  `auto`, header color, project id, name. `--json` prints
  `{"assignments":[{"projectId","emoji","source"}],"colors":[{"projectId","color"}]}`,
  where `colors` holds only pinned colors.
- `set` pins exactly one emoji (a single grapheme, ZWJ sequences and flags
  included). Anything else fails with `invalid_emoji`.
- `clear` (alias `reset`) removes the pin and stores a new automatic pick.
- `color` pins a CSS color (`#7fb4ff`, `tomato`, `oklch(0.86 0.07 236)`);
  `auto` removes the pin. Anything else fails with `invalid_color`.
- An unknown id fails with `project_not_found`; `bb project list` shows ids.

Open bb windows update as soon as a command finishes. In the app, clicking a
project's emoji opens the same picker, which has "Reset to automatic".
