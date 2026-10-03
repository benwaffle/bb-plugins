---
name: project-emoji
description: "Show, pin, or reset the emoji bb's sidebar shows before each project name, with the bb project-emoji commands."
---

# Project emoji

The project-emoji plugin shows an emoji before each project name in the
sidebar. A project without a pinned emoji gets an automatic one, chosen once
from keywords in its name or checkout path, else from a hash of its id, and
stored so it never changes on its own.

## Commands

```
bb project-emoji list [--json]
bb project-emoji set <projectId> <emoji> [--json]
bb project-emoji clear <projectId> [--json]
```

- `list` prints one tab-separated line per project: emoji, `manual` or
  `auto`, project id, name. `--json` prints
  `{"assignments":[{"projectId","emoji","source"}]}`.
- `set` pins exactly one emoji (a single grapheme, ZWJ sequences and flags
  included). Anything else fails with `invalid_emoji`.
- `clear` (alias `reset`) removes the pin and stores a new automatic pick.
- An unknown id fails with `project_not_found`; `bb project list` shows ids.

Open bb windows update as soon as a command finishes. In the app, clicking a
project's emoji opens the same picker, which has "Reset to automatic".
