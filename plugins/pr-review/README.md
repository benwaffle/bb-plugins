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

Each group has a header: **Approved but changed** (1), **Needs you** (2 and
3), **Commented** (4), and **Others** (5). Draft PRs from every group go into a
collapsed **Drafts** section after them, in the same group order, and show in
muted text with a **Draft** badge. PRs you approved at their current head go
into a collapsed **Approved, waiting on merge** section. Merged and closed PRs
are not listed. Inside each group, the oldest number is first. A title drops
its ticket prefix, such as `ACME-51: `, because the Ticket column shows it.

The header counts the ready PRs that request your review or whose approval
went stale, and every open PR, such as `6 need you · 19 open`.

A PR is stacked when its base branch is the head branch of another open PR in
the same repository, such as #553 targeting #552's branch. A stacked PR shows
**on #552** after its number. When a stacked PR is in the same group as its
base PR, it comes directly after it, with the base PR's other dependents in
number order. Otherwise it stays in its own group. When the base PR merges or
closes, the stacked PR is no longer marked.

A review request counts as yours if it names you, or if it names one of your
teams and you have not reviewed yet. Columns:

| Column | Shows |
| --- | --- |
| PR | Number, **on #n** for a stacked PR, title, and the author with their GitHub avatar. A wrapped title keeps the number on its first line. |
| Ticket | Jira key from an `ACME-n:` title prefix, or else a bare `ACME-n` line or `/browse/ACME-n` link in the body. Hover for `ACME-n: <summary> (<status>)`. |
| Size | Additions, deletions, and changed files. |
| Reviews | The latest review state and avatar of every human reviewer other than you. |
| Me | `requested`, `commented`, `changes requested`, `approved`, `approved, new commits`, `author`, or `—`. |
| Agent | `—` when there is no review thread, `opened` until the review command is sent, `reviewing` while it runs, `reviewed` after it, and `follow-ups` once you sent a message after the review. |

The review command counts when `bb pr-review review` sends it, or when any
line of a message you send starts with it. Each message is checked once, and
the time of the last review is kept in the plugin database.

Click a row, or its **Review** button, to open the PR's review thread; one is
started when there is none. The icons at the row's end open the PR in the
GitHub plugin's panel (when that plugin is running) and on github.com.

## Sidebar

In bb's thread list, organized **By project**, review threads are nested under
their Jira ticket, such as **ACME-21 Checkout backlog bug bash**, when the ticket
has at least two threads or an open PR that has no review thread yet. The row
shows the ticket key and summary, or only the key until the summary is read,
and truncates in a narrow sidebar. Hover the ticket row for its summary and
status. An open PR without a review thread is a muted row under its
ticket, such as `#566 Keep the old task serving`, with a **Start** button; PRs
without a ticket are under **No ticket**. When a group's PRs are in more than
one repository, each PR row names its repository, such as `widgets#566`. The row says only `on #552` for a
stacked PR and `draft` for a draft, so the title, not the number, truncates in
a narrow sidebar. Hover the row for the author, size, and your state. Your own
PRs are not listed. Under a ticket, stacked PRs come first, each base PR followed by
the PRs stacked on it, then the other PRs. A stacked PR's row starts with a
tree glyph per stack level (`└ #553`, then `  └ #564`). Click the row, or **Start**, to open the PR's review
thread; one is started when there is none. PRs you approved at their current head are not
listed. Threads keep their own rows, so pinning, archiving, renaming, and
dragging work as usual. A thread's ticket is its PR's ticket, or else the
first Jira ref recorded for it. Threads without a ticket are not grouped.
On bb builds whose sidebar groups take thread decorations and `keepOrder`,
review threads follow the same stack-first order as PR rows, so a stacked PR's
thread sits right after its base PR's row or thread, with the tree glyph and
`stacked on #552` after its title; threads whose PR is not in the queue come
last. Older bb builds sort the review threads by their own thread order and
show them before the PR rows, so a thread's position and title do not show its
stack there.

On bb builds that draw styled groups (they report groups back with a
`style`), the **Sidebar style** setting picks the look:

- **minimal** (the default): the header shows the ticket key as a pill at
  its left (`ACME-21`), then the summary, with no box around the group. An
  unstarted PR is a ghost row with a **+** button in place of **Start**.
- **card**: each ticket is a bordered card. Its header shows a ticket icon,
  the key in mono (`ACME-21`), and the summary. **Start** shows when you
  hover a PR row.

In both, the header shows how many of the ticket's PRs have a review thread
(`1/3`). PR rows and review threads start with a PR state icon: green for
open, grey for a draft, and purple for merged. A merged or closed PR's state
is read from GitHub. PR rows have no tree glyph and no `draft` text. A
review thread is a plain thread row that ends with a dot for its agent state:
green when reviewed, purple for follow-ups, and grey when opened but not
reviewed yet. A running agent shows bb's own indicator instead. A stacked PR
row or thread is indented under its base PR with a connector rail, one step
per stack level, and a stacked PR row still says `on #552`.

A bb build that draws card groups but not minimal ones reports a minimal
group back as `flat`; pr-review then draws cards there, even with minimal
chosen. Until bb reports the groups back, and on older builds, the sidebar
looks as described above.

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
- is titled `#596 <PR title>`, without the title's ticket prefix, cut to 120
  characters. The project header and the ticket group show the repository and
  ticket;
- gets a first message with Markdown links to the PR, the ticket (with its
  summary and status), the linked issues, and the other open PRs on the same
  ticket, and an instruction to reply "Ready." and wait. bb cannot start a
  thread without a message, so the agent runs one short turn; it does not
  review. The diff size is not in the message, because the GitHub PR column
  shows it live:

  ```md
  Review context for [widgets#596](https://github.com/acme/widgets/pull/596): Cache the widget catalog per tenant (branch `bob/catalog-cache`)
  - Ticket [ACME-51](https://example.atlassian.net/browse/ACME-51): Cache the widget catalog (In Progress)
  - Linked issue [#12](https://github.com/acme/widgets/issues/12): Stale prices after a currency change
  - Other open PRs on ACME-51:
    - [#599](https://github.com/acme/widgets/pull/599): Evict the old catalog entry
  ```

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
highlighted, is in the thread panel's new-tab launcher. Its rows show `#600`,
or `widgets#600` when the queue has PRs from more than one repository. Docking needs a bb
build with docked thread panels (`toThread`'s `experimental_dockedPanels`).
Older builds, or bb without the GitHub plugin, open the thread with no docked
column.

## Related threads

The thread panel's **Related threads** action opens a tab that lists the other
PRs and threads on the thread's ticket:

- each other thread with the same ticket ref. A thread with a PR shows the PR
  number and title, the PR state (`open`, `draft`, `merged`, or `closed`), and
  the agent state. A thread without a PR shows its title and agent state;
- each open PR on the ticket that has no review thread and is not yours,
  with a **Start** button.

PRs come first, by number, then threads without a PR. A PR shows as `#600`, or
as `widgets#600` when the tab lists PRs from more than one repository. Click an item to open
its thread, with the GitHub PR column docked. The state of a PR that is no
longer open is read with `gh pr view` and kept until the plugin restarts.

## Settings

| Setting | Example | Meaning |
| --- | --- | --- |
| Repositories | `acme/widgets` | Comma-separated `owner/repo` list for the queue. |
| Jira project keys | `ACME` | Keys recognised as tickets. |
| Jira site | `https://example.atlassian.net` | Base URL for ticket links. |
| Review project | none | Project that review threads start in when no project's remote matches. |
| Sidebar style | `minimal` | `minimal` or `card` ticket groups in the sidebar (see [Sidebar](#sidebar)). |

Every setting but Sidebar style is empty after install. Until Repositories is set, the queue is
empty and shows a hint to set it. Tickets are recognised only when both Jira
project keys and Jira site are set; until then the queue shows a hint for them,
and PRs are not grouped by ticket.

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
size, your state, agent state, title. Before them, it prints a `setup <hint>`
line for each setting that still needs a value. `groups` prints what the sidebar groups
come from: one `ACME-n thread <threadId>` line per thread with a ticket, and
one `ACME-n pr owner/repo#n <title>` line per open PR without a review thread,
with `-` for no ticket; your own PRs are left out. `start` prints `started` or `existing`
and the thread id. `review` opens the thread if needed, sends the review
command, and prints `sent` or `queued` and the thread id. A bare number uses
the first configured repository.

`related` prints one `owner/repo#n PR-state agent-state threadId title` line
per item of the Related threads tab, with `-` for no PR, no PR state, or no
thread.

`refs` prints one `kind key source title url` line per ref and the workspace
path. A thread's refs are its PR, its ticket, issues from
`Fixes`/`Closes`/`Resolves`/`Refs`/`Part of #n`, other PRs mentioned as a bare
`#n` or PR URL, and sibling PRs on the same ticket. For a thread that the
plugin did not start, the refs come from the PR of the thread's branch the
first time `refs` reads them.

## Storage

Refs live in the plugin's SQLite database, one row per thread and ref:
`thread_id`, `kind` (`gh-pr`, `gh-issue`, or `jira`), `key` (`owner/repo#n`
or `ACME-n`), `url`, `title`, and `source` (`review-target`, `environment`,
`title`, `body`, `fixes`, `refs`, `mention`, or `sibling`).

The `reviews` table has one row per review thread: `reviewed_at`, the time
the review command was last sent, and `scanned_through`, the time of the
newest message checked for it.

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
  row shows only `ACME-n` and its tooltip is `ACME-n (loading title)`. A
  ticket that `twg` cannot read keeps that row and tooltip, and is tried again
  after five minutes.
