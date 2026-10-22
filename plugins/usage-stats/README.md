# Usage stats

A **Usage** page in bb's navigation with token use and cost over time: by day
and model, by project, by thread, cache hit ratio, provider split, and the
subscription windows bb reports. A row opens the thread's per-turn breakdown.

Cost is **API-equivalent**: token counts priced at API list rates. A
subscription plan is not billed per token, so the figure is what the same
usage would cost on the API, not what you pay.

## Install

```sh
bb plugin install git:https://github.com/benwaffle/bb-plugins.git@main --plugin usage-stats
```

From a local checkout:

```sh
bb plugin install path:. --plugin usage-stats
```

Open it from the **Usage** entry in the sidebar navigation, or at
`/plugins/usage-stats/usage`. The page's sidebar and the **Source** control
switch between all usage, bb threads, and Claude Code sessions outside bb
(`/plugins/usage-stats/usage/bb` and `/plugins/usage-stats/usage/outside`).

## Where the numbers come from

| Source | What it records |
| --- | --- |
| Usage ledger | On every `thread.idle`, the thread's per-model totals from bb's thread cost call, stored as the growth since the previous turn. bb keeps only the latest token snapshot per thread, so the ledger is the history. Every bb provider. |
| Claude Code transcripts | Every API message in `~/.claude/projects/**/*.jsonl` on the machine the bb server runs on, with its model, timestamp, and input / output / cache read / cache write split. Covers Claude Code sessions bb never saw. |

A bb thread's Claude Code session id is its provider thread id, so a session
found in both is counted once, from its transcript. Claude Code writes one
transcript line per content block, all with the same message id and usage;
the importer records each message id once. Transcript messages are priced with
the same Anthropic list prices bb uses. Other providers use the cost bb
reports, which is empty for models bb has no price for.

The transcript import runs at startup and every 5 minutes, and reads only the
bytes appended since the last run. Subscription windows are sampled every 10
minutes so their line has history. On startup the plugin records every bb
thread that changed while it was not running. On bb builds without the
thread cost call, the ledger prices the thread's latest token event itself.

Transcripts are read from the server machine only. Threads whose Claude Code
session runs on another machine are still counted, through the ledger.

## CLI

```sh
bb usage-stats summary [--days N] [--json]
bb usage-stats backfill [--json]
```

`summary` prints cost, tokens, output, cache hit ratio, turns, and threads for
today, the last 7 days, and the last N days (default 30), the N days before
that, and the models and projects of the last N days. `backfill` records every
bb thread and imports every transcript byte not read yet, then prints the
counts.

## Develop

```sh
npm test
npm run check
```
