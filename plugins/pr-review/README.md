# PR review

A review queue for open GitHub pull requests. A Review button opens a review
thread in a worktree on the PR's head branch; the review itself runs when you
ask for it. The plugin records the PR, Jira ticket, linked issues, and sibling
PRs of each thread. Diffs, checks, and comments stay in bb's built-in GitHub
plugin, which this plugin links to.

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
group, ready PRs come before drafts, then oldest number first. Drafts show in
muted text with a **Draft** badge.

A review request counts as yours if it names you, or if it names one of your
teams and you have not reviewed yet. Columns:

| Column | Shows |
| --- | --- |
| PR | Number, title, and the author with their GitHub avatar. |
| Ticket | Jira key from a `CORE-n:` title prefix, or else a bare `CORE-n` line or `/browse/CORE-n` link in the body. Hover for `CORE-n: <summary> (<status>)`. |
| Size | Additions, deletions, and changed files. |
| Reviews | The latest review state and avatar of every human reviewer other than you. |
| Me | `requested`, `commented`, `changes requested`, `approved`, `approved, new commits`, `author`, or `—`. |
| Agent | `—` when there is no review thread, `opened` before the review runs, `reviewing` while it runs, `brief ready` after it, `follow-ups` once you sent other messages. |

Click a row, or its **Review** button, to open the PR's review thread; one is
started when there is none. The icons at the row's end open the PR in the
GitHub plugin's panel (when that plugin is running) and on github.com.

## Sidebar

In bb's thread list, organized **By project**, review threads are nested under
their Jira ticket, such as **CORE-21 S6a backlog bug bash**, when the ticket
has at least two threads or an open PR that has no review thread yet. The row
shows the ticket key and summary, or only the key until the summary is read,
and truncates in a narrow sidebar. Hover the ticket row for its summary and
status. An open PR without a review thread is a muted row under its
ticket, with the author and a **Start** button; PRs without a ticket are under
**No ticket**. Click the row, or **Start**, to open the PR's review thread; one
is started when there is none. PRs you approved at their current head are not
listed. Threads keep their own rows, so pinning, archiving, renaming, and
dragging work as usual. A thread's ticket is its PR's ticket, or else the
first Jira ref recorded for it. Threads without a ticket are not grouped.

The groups refresh when a review thread starts and once a minute. This needs
a bb build with `app.slots.experimental_sidebarThreadGroups`. Older builds
show the thread list without ticket groups.

## Review threads

A new review thread:

- starts in the project whose git remote matches the repository (or the
  **Review project** setting);
- gets a `git-worktree` environment based on `origin/<head branch>`, then runs
  `gh pr checkout <n>` in it once the worktree is ready. If that branch is
  already checked out in another worktree, it checks out as `review/pr-<n>`;
- is titled `hss#596 CORE-51: <PR title>`, cut to 120 characters;
- gets a first message with the PR, the ticket's summary and status, the
  linked issues, and the other open PRs on the same ticket, and an instruction
  to reply "Ready." and wait. bb cannot start a thread without a message, so
  the agent runs one short turn; it does not review.

The thread opens after `gh pr checkout` finishes and bb's branch lookup for the
worktree finds the PR (up to 30 seconds after checkout). The GitHub plugin's
**GitHub PR** tab reads that lookup once when it opens, so it shows the PR's
diff and checks instead of a PR picker.

`bb pr-review review <n>` sends
`/thermo-nuclear-code-quality-review review pr <n>` to the thread. When the
agent is busy, the message is queued.

**Review** and **Open** open the thread with the GitHub plugin's **GitHub PR**
tab docked as a column to its left. Drag the divider to resize it; bb
remembers the width. Use the column's header to move it back to the right
panel or close it. A compact **Review queue** tab, with the current PR
highlighted, is in the thread panel's new-tab launcher. Docking needs a bb
build with docked thread panels (`toThread`'s `experimental_dockedPanels`).
Older builds, or bb without the GitHub plugin, open the thread with no docked
column.

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
bb pr-review groups [--json]
bb pr-review start <n | owner/repo#n | PR URL> [--json]
bb pr-review review <n | owner/repo#n | PR URL> [--json]
bb pr-review refs <threadId> [--json]
bb pr-review related <threadId> [--json]
```

`queue` prints one tab-separated line per PR: `owner/repo#n`, group, ticket,
size, your state, agent state, title. `groups` prints what the sidebar groups
come from: one `CORE-n thread <threadId>` line per thread with a ticket, and
one `CORE-n pr owner/repo#n <title>` line per open PR without a review thread,
with `-` for no ticket. `start` prints `started` or `existing`
and the thread id. `review` opens the thread if needed, sends the review
command, and prints `sent` or `queued` and the thread id. A bare number uses
the first configured repository.

`refs` prints one `kind key source title url` line per ref and the workspace
path. A thread's refs are its PR, its ticket, issues from
`Fixes`/`Closes`/`Resolves`/`Refs`/`Part of #n`, other PRs mentioned as a bare
`#n` or PR URL, and sibling PRs on the same ticket. For a thread that the
plugin did not start, the refs come from the PR of the thread's branch the
first time `refs` reads them.

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
- The queue caches GitHub results for 30 seconds. **Refresh** and `--refresh`
  skip that cache.
- Ticket summaries are read with one `twg jira workitem get` call for all the
  keys in view and kept in the plugin's database. After an hour the cached
  summary is shown while it is read again. Until a ticket is read, its sidebar
  row shows only `CORE-n` and its tooltip is `CORE-n (loading title)`. A
  ticket that `twg` cannot read keeps that row and tooltip, and is tried again
  after five minutes.
