---
name: pr-review
description: "List the PR review queue, open the review thread for a PR, run its thermo-nuclear review, and read the PR, Jira ticket, and issue refs on a thread with the bb pr-review commands."
---

# PR review

The pr-review plugin keeps a queue of open PRs in the configured repositories
(default `private-tech-inc/hss`). It opens review threads in a worktree on the
PR's head branch and records which PR, Jira ticket, issues, and sibling
PRs belong to each thread.

## Commands

```
bb pr-review queue [--refresh] [--json]
bb pr-review groups [--json]
bb pr-review start <n | owner/repo#n | PR URL> [--json]
bb pr-review review <n | owner/repo#n | PR URL> [--json]
bb pr-review refs <threadId> [--json]
bb pr-review related <threadId> [--json]
```

- `queue` lists open PRs in review order. Each tab-separated line has
  `owner/repo#n`, group, ticket key or `-`, `+adds/-dels`, your state, agent
  state, and title. Groups in order: `approval-stale` (you approved, then new
  commits came), `requested`, `requested-approved`, `commented`, `other`, and
  `approved`. `--json` adds other reviewers, the review thread id, and the stack:
  `baseRefName`, `parentNumber` (the open PR whose head branch is this PR's
  base, or null), `depth` (0 when not stacked), and `childNumbers`. A stacked
  PR follows its base PR directly when both are in the same group.
  `--refresh` skips the 30 second cache.
- `groups` lists what bb's sidebar nests under ticket rows: tab-separated
  `ticket thread <threadId>` lines for threads with a Jira ticket, then
  `ticket pr owner/repo#n title` lines for open PRs without a review thread
  (`-` when the PR has no ticket). `--json` adds ticket summaries, project ids,
  and the full queue entries.
- `start` returns the existing review thread for the PR, or starts one with
  the PR context only; it does not run the review. It returns after the
  worktree is on the PR branch and prints `started` or `existing` and the
  thread id. A bare number uses the first configured repository.
- `review` does what `start` does, then sends
  `/thermo-nuclear-code-quality-review review pr <n>` to the thread. It prints
  `sent`, or `queued` when the agent is busy, and the thread id.
- Agent states in `queue`: `none`, `opened` (no review yet), `reviewing`,
  `brief-ready`, `follow-ups`.
- `refs` prints `kind key source title url` per ref and the workspace path.
  Kinds are `gh-pr`, `gh-issue`, and `jira`.
- `related` lists other threads that share a Jira ticket with the thread.

## Parsing rules

- Ticket: a `CORE-n:` title prefix, or else a line that is only `CORE-n`, or
  a `/browse/CORE-n` link in the body. Project keys come from the "Jira
  project keys" setting.
- `Fixes`, `Closes`, `Resolves`, `Refs`, `Part of`, and `See` before `#n` mean
  an issue. A bare `#n` or a `/pull/` URL means another PR.
- Text in code spans, code blocks, and HTML comments is ignored.

Run commands yourself; `gh` must be signed in, and ticket summaries need `twg`.
