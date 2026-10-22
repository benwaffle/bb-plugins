---
name: usage-stats
description: "Report token usage and API-equivalent cost per day, model, project, and thread across bb threads and Claude Code sessions with the bb usage-stats commands, or open the Usage page."
---

# Usage stats

The usage-stats plugin keeps a ledger of every bb turn's token growth and
imports Claude Code transcripts from `~/.claude/projects` on the server
machine. Costs are API-equivalent: token counts priced at API list rates, not
what a subscription bills. Say so when you quote a cost.

## Commands

```
bb usage-stats summary [--days N] [--json]
bb usage-stats backfill [--json]
```

- `summary` prints one line per period (today, 7 days, N days, and the N days
  before), then the models and projects of the last N days. `--days` is 1–365,
  default 30. `--json` returns `{ days, periods, models, projects }`.
- `backfill` records every bb thread that changed since it was last recorded
  and imports every transcript byte not read yet. It prints the threads and
  ledger rows recorded, files read, new messages, repeated content-block
  lines skipped, and new prompts. It is safe to run again.

## Page

The **Usage** navigation entry opens `/plugins/usage-stats/usage`. Append
`/bb` or `/outside` to show only bb threads or only Claude Code sessions
outside bb.
