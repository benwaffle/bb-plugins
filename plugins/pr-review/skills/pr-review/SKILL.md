---
name: pr-review
description: "List the PR review queue, start or find the agent review thread for a PR, and read the PR, Jira ticket, and issue refs on a thread with the bb pr-review commands."
---

# PR review

The pr-review plugin keeps a queue of open PRs in the configured repositories
(default `private-tech-inc/hss`). It starts agent review threads in a worktree
on the PR's head branch and records which PR, Jira ticket, issues, and sibling
PRs belong to each thread.

## Commands

```
bb pr-review queue [--refresh] [--json]
bb pr-review start <n | owner/repo#n | PR URL> [--json]
bb pr-review refs <threadId> [--json]
bb pr-review related <threadId> [--json]
```

- `queue` lists open PRs in review order. Each tab-separated line has
  `owner/repo#n`, group, ticket key or `-`, `+adds/-dels`, your state, agent
  state, and title. Groups in order: `approval-stale` (you approved, then new
  commits came), `requested`, `requested-approved`, `commented`, `other`, and
  `approved`. `--json` adds other reviewers and the review thread id.
  `--refresh` skips the 30 second cache.
- `start` returns the existing review thread for the PR, or starts one with
  the PR context and `/thermo-nuclear-code-quality-review review pr <n>`. It
  prints `started` or `existing` and the thread id. A bare number uses the
  first configured repository.
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
