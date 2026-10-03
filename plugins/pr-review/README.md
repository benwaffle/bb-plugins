# PR review

A review queue for open GitHub pull requests. A Review button starts an agent
review thread in a worktree on the PR's head branch. Threads get chips for
their PR, Jira ticket, linked issues, and sibling PRs. Diffs, checks, and
comments stay in bb's built-in GitHub plugin, which this plugin links to.

## Install

```sh
bb plugin install git:https://github.com/benwaffle/bb-plugins.git@main --plugin pr-review
```

From a local checkout:

```sh
bb plugin install path:. --plugin pr-review
```

Requires `gh` signed in to GitHub. `twg` is optional; without it, tickets show
their key but no summary.

## Review queue

The **Review queue** sidebar entry lists the open PRs of the configured
repositories in this order:

1. PRs you approved that got new commits after your approval (shown as
   "approved, new commits").
2. PRs that request your review and have no approvals yet.
3. PRs that request your review and already have approvals.
4. PRs you commented on or requested changes on.
5. Everything else, including your own PRs.

PRs you approved at their current head go into a collapsed **Approved,
waiting on merge** section. Merged and closed PRs are not listed. Inside each
group, ready PRs come before drafts, then oldest number first.

A review request counts as yours if it names you, or if it names one of your
teams and you have not reviewed yet. Columns:

| Column | Shows |
| --- | --- |
| PR | Number and title. Click it to open the PR in the GitHub plugin's panel, or on github.com when that plugin is not running. |
| Ticket | Jira key from a `CORE-n:` title prefix, or else a bare `CORE-n` line or `/browse/CORE-n` link in the body. Hover for the summary. |
| Size | Additions, deletions, and changed files. |
| Reviews | The latest review state of every human reviewer other than you. |
| Me | `requested`, `commented`, `changes requested`, `approved`, `approved, new commits`, `author`, or `—`. |
| Agent | `—` when there is no review thread, `reviewing` while its first turn runs, `brief ready` after it, `follow-ups` once you sent more messages. |

**Review** finds the PR's review thread, or starts one when there is none.

## Review threads

A new review thread:

- starts in the project whose git remote matches the repository (or the
  **Review project** setting);
- gets a `git-worktree` environment based on `origin/<head branch>`, then runs
  `gh pr checkout <n>` in it once the worktree is ready. If that branch is
  already checked out in another worktree, it checks out as `review/pr-<n>`;
- is titled `hss#596 CORE-51: <PR title>`, cut to 120 characters;
- gets a prompt with the PR, the ticket's summary and status, the linked
  issues, and the other open PRs on the same ticket, followed by
  `/thermo-nuclear-code-quality-review review pr <n>`.

Because the worktree is on the PR branch, the GitHub plugin's **GitHub PR**
thread panel tab shows the PR's diff and checks for that thread.

**Review** and **Open** open the thread as three columns: a compact **Review
queue** with the current PR highlighted, the GitHub plugin's **GitHub PR** tab,
then the review thread. The first two are docked thread panel tabs. Drag the
dividers to resize them; bb remembers the widths. Use each column's header to
move it back to the right panel or close it. Pick another PR in the queue
column to switch threads; the columns follow. The **Review queue** tab is
also in the thread panel's new-tab launcher. This needs a bb build with
docked thread panels (`toThread`'s `experimental_dockedPanels`). Older builds
open the thread without the columns. Without the GitHub plugin, only the
queue is docked.

## Thread header

Threads with refs show chips in the header: the PR, the ticket (hover for its
summary), issues from `Fixes`/`Closes`/`Resolves`/`Refs`/`Part of #n`, other
PRs mentioned as a bare `#n` or PR URL, and sibling PRs on the same ticket.
For a thread that the plugin did not start, the refs come from the PR of the
thread's branch the first time the header loads.

**GoLand** and **VS Code** open the thread's workspace with `open -a` on
macOS, or the `goland`/`code` command elsewhere. When the workspace is on
another machine, a **Copy path** button is shown instead.

## Related threads

The thread panel's **Related threads** action opens a tab that lists other
threads that have the same ticket ref, with their title and first message.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| Repositories | `private-tech-inc/hss` | Comma-separated `owner/repo` list for the queue. |
| Jira project keys | `CORE` | Keys recognised as tickets. |
| Jira site | `https://east-stout.atlassian.net` | Base URL for ticket links. |
| Review project | none | Project that review threads start in when no project's remote matches. |

## CLI

```
bb pr-review queue [--refresh] [--json]
bb pr-review start <n | owner/repo#n | PR URL> [--json]
bb pr-review refs <threadId> [--json]
bb pr-review related <threadId> [--json]
```

`queue` prints one tab-separated line per PR: `owner/repo#n`, group, ticket,
size, your state, agent state, title. `start` prints `started` or `existing`
and the thread id. A bare number uses the first configured repository.

## Storage

Refs live in the plugin's SQLite database, one row per thread and ref:
`thread_id`, `kind` (`gh-pr`, `gh-issue`, or `jira`), `key` (`owner/repo#n`
or `CORE-n`), `url`, `title`, and `source` (`review-target`, `environment`,
`title`, `body`, `fixes`, `refs`, `mention`, or `sibling`).

## Limits

- bb has no API to open another plugin's page. The PR link pushes the GitHub
  plugin's route (`/plugins/github/github/pulls/<owner>/<repo>/<n>`) onto the
  app's history. That works only while the GitHub plugin keeps that route.
- Sibling PRs come from the open PRs in the same repository, so sibling PRs in
  other repositories are not found.
- The queue caches GitHub results for 30 seconds and ticket summaries for an
  hour. **Refresh** and `--refresh` skip the queue cache.
