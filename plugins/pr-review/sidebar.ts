import type { QueueEntry, SidebarGroupsResult } from "./contract.js";
import { pullKey, pullLabeler, stackOrder, type AgentState } from "./queue.js";
import { titleWithoutTicket } from "./parse.js";
import { queuedPullState, type RelatedPullState } from "./related.js";
import { ticketTooltip } from "./tickets.js";

export const NO_TICKET_LABEL = "No ticket";

export type ThreadReview = Omit<SidebarGroupsResult["threadReviews"][number], "threadId">;

export type TicketGroupItem =
  | { kind: "pull"; entry: QueueEntry }
  | { kind: "thread"; threadId: string; entry: QueueEntry | null; review: ThreadReview | null };

export interface TicketGroup {
  projectId: string;
  key: string;
  /** null for the group of PRs without a ticket. */
  ticketKey: string | null;
  /** The ticket summary, or null until it is read and for "No ticket". */
  summary: string | null;
  /** The ticket's Jira page, or null for "No ticket". */
  url: string | null;
  tooltip: string | null;
  threadIds: string[];
  /** Each entry's depth counts only the base PRs in this group. */
  items: TicketGroupItem[];
  /** A PR row's label, which names the repository only in a group that mixes repositories. */
  pullLabel: (repo: string, number: number) => string;
}

/**
 * A tree glyph indented one step per stack level below the first, such as
 * "└ " at depth 1 and "  └ " at depth 2. The indent is U+00A0 because the
 * sidebar collapses leading ASCII spaces in a row title.
 */
export function stackPrefix(depth: number): string {
  return depth === 0 ? "" : `${"\u00a0\u00a0".repeat(depth - 1)}└ `;
}

export type SidebarTone = "success" | "muted" | "accent" | "danger";

export interface SidebarRowIcon {
  name: string;
  tone: SidebarTone;
}

export type SidebarRowTrailing = { kind: "dot"; tone: SidebarTone } | { kind: "text"; text: string };

/**
 * The PR a review thread reviews, which bb draws as "#number" with a state
 * icon on the row's second line and leaves out of the start of the title.
 */
export interface SidebarRowPullRequest {
  number: number;
  state: NonNullable<RelatedPullState>;
}

/** The icon pr-review registers for ticket group headers. */
export const TICKET_ICON = "pr-review/ticket";

const PULL_ICONS: Record<NonNullable<RelatedPullState>, SidebarRowIcon> = {
  open: { name: "GitPullRequest", tone: "success" },
  draft: { name: "GitPullRequestDraft", tone: "muted" },
  merged: { name: "GitMerge", tone: "accent" },
  closed: { name: "GitPullRequestClosed", tone: "danger" },
};

const AGENT_DOTS: Partial<Record<AgentState, SidebarTone>> = {
  opened: "muted",
  reviewed: "success",
  "follow-ups": "accent",
};

function iconFor(state: RelatedPullState): { icon?: SidebarRowIcon } {
  return state === null ? {} : { icon: PULL_ICONS[state] };
}

/** The reviewed PR, absent while its state could not be read from GitHub. */
function pullRequestFor({ number, pullState }: ThreadReview): { pullRequest?: SidebarRowPullRequest } {
  return pullState === null ? {} : { pullRequest: { number, state: pullState } };
}

/**
 * The agent state as a trailing dot. A running agent has none, because the
 * host shows its own running indicator.
 */
function trailingFor(agent: AgentState): { trailing?: SidebarRowTrailing } {
  const tone = AGENT_DOTS[agent];
  return tone === undefined ? {} : { trailing: { kind: "dot", tone } };
}

export interface StackedThreadRow {
  threadId: string;
  depth?: number;
  description?: string;
  icon?: SidebarRowIcon;
  trailing?: SidebarRowTrailing;
  pullRequest?: SidebarRowPullRequest;
}

/**
 * A review thread's sidebar entry: the stack depth and "stacked on #N" of
 * its PR, absent when the PR is a stack base, not stacked, or not queued,
 * and its PR's state icon, agent dot, and number and state, which bb builds
 * without card or minimal groups ignore. Thread rows look the same on card
 * and minimal hosts.
 */
export function stackedThreadRow(threadId: string, entry: QueueEntry | null, review: ThreadReview | null): StackedThreadRow {
  const look =
    review === null ? {} : { ...iconFor(review.pullState), ...trailingFor(review.agent), ...pullRequestFor(review) };
  if (entry === null || entry.parentNumber === null) return { threadId, ...look };
  return { threadId, depth: entry.depth, description: `stacked on #${entry.parentNumber}`, ...look };
}

export interface ThreadRowDecoration {
  icon?: SidebarRowIcon;
  label?: string;
  /** The page bb opens when the label is clicked. */
  labelHref?: string;
  description?: string;
  trailing?: SidebarRowTrailing;
  pullRequest?: SidebarRowPullRequest;
}

function reviewWords(entry: QueueEntry): string | null {
  const states = new Set(entry.otherReviews.map((review) => review.state));
  if (entry.me === "changes-requested" || states.has("CHANGES_REQUESTED")) return "changes requested";
  if (entry.me === "approved" || states.has("APPROVED")) return "approved";
  if (entry.pendingReviewers === 0) return null;
  return `${entry.pendingReviewers} ${entry.pendingReviewers === 1 ? "review" : "reviews"} pending`;
}

/**
 * A queued PR's state in a few words, such as "conflicts · 3 failing" or
 * "draft · approved": draft, merge conflicts, failing checks, then the
 * review state, which is "changes requested" when any reviewer, the viewer
 * included, requested changes, else "approved" when any approved, else how
 * many requested reviews are pending. Empty when none of these apply.
 */
export function pullStatus(entry: QueueEntry): string {
  return [
    entry.isDraft ? "draft" : null,
    entry.conflicting ? "conflicts" : null,
    entry.failingChecks === 0 ? null : `${entry.failingChecks} failing`,
    reviewWords(entry),
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

/**
 * The state words of a reviewed PR that is not queued, which bb reads from
 * GitHub: "merged" or "closed", or "draft". An open PR has none.
 */
function unqueuedStatus(state: RelatedPullState): string {
  return state === "merged" || state === "closed" || state === "draft" ? state : "";
}

/**
 * Each ticket thread's decoration on a sidebar row outside its project's
 * header: the ticket key as the label, linked to the ticket's Jira page,
 * and, for a thread that reviews a PR,
 * the PR state icon and agent dot it has in a ticket group, the PR's state
 * words as the description, and the PR's number and state. A queued PR's
 * review thread without a ticket gets only the PR's number and state.
 */
export function threadRowDecorations(result: SidebarGroupsResult): Map<string, ThreadRowDecoration> {
  const reviewByThreadId = new Map(result.threadReviews.map(({ threadId, ...review }) => [threadId, review]));
  const pullByThreadId = new Map(result.threadPulls.map(({ threadId, entry }) => [threadId, entry]));
  const urlByTicketKey = new Map(result.tickets.map(({ key, url }) => [key, url]));
  const ticketLabel = (ticketKey: string): { label: string; labelHref?: string } => {
    const url = urlByTicketKey.get(ticketKey);
    return url === undefined ? { label: ticketKey } : { label: ticketKey, labelHref: url };
  };
  const decorations = new Map<string, ThreadRowDecoration>(
    result.threadPulls.map(({ threadId, entry }) => [
      threadId,
      { pullRequest: { number: entry.number, state: queuedPullState(entry) } },
    ]),
  );
  for (const { threadId, ticketKey } of result.threadTickets) {
    const review = reviewByThreadId.get(threadId);
    if (review === undefined) {
      decorations.set(threadId, ticketLabel(ticketKey));
      continue;
    }
    const entry = pullByThreadId.get(threadId);
    const description = entry === undefined ? unqueuedStatus(review.pullState) : pullStatus(entry);
    decorations.set(threadId, {
      ...iconFor(review.pullState),
      ...ticketLabel(ticketKey),
      ...(description === "" ? {} : { description }),
      ...trailingFor(review.agent),
      ...pullRequestFor(review),
    });
  }
  return decorations;
}

/** The sidebar style chosen in the plugin settings. */
export type SidebarStyle = "minimal" | "card";

export const SIDEBAR_STYLES: readonly SidebarStyle[] = ["minimal", "card"];

/**
 * The payload pr-review publishes: the chosen style when the host draws it,
 * card groups when the host draws card but not minimal groups, and legacy
 * flat groups on hosts that draw neither.
 */
export type SidebarLook = SidebarStyle | "legacy";

export function sidebarStyle(value: unknown): SidebarStyle {
  return value === "card" ? "card" : "minimal";
}

/**
 * Whether the host reported this plugin's groups in a style pr-review never
 * publishes, such as "flat". A host that draws card but not minimal groups
 * reports a "minimal" group back that way.
 */
export function rejectsMinimal(reported: string | undefined): boolean {
  return reported !== undefined && reported !== "minimal" && reported !== "card";
}

/**
 * The look to publish and the `style` to publish it with, from the chosen
 * style, the style the host reported for this plugin's groups (undefined
 * until it reports one, and always on hosts that predate styled groups),
 * and whether the host already rejected minimal groups. Legacy groups carry
 * the chosen style, so a host that draws styled groups reports which one it
 * took.
 */
export function sidebarLook(
  chosen: SidebarStyle,
  reported: string | undefined,
  minimalRejected: boolean,
): { look: SidebarLook; style: SidebarStyle } {
  if (reported === undefined) return { look: "legacy", style: chosen };
  if (chosen === "card" || minimalRejected || rejectsMinimal(reported)) return { look: "card", style: "card" };
  return { look: "minimal", style: "minimal" };
}

export interface PullRowLook {
  title: string;
  depth?: number;
  description?: string;
  icon?: SidebarRowIcon;
  variant?: "ghost";
}

/**
 * An unstarted PR row's title, description, and icon. Card and minimal
 * hosts get the stack depth, which they draw as a connector rail, and the
 * draft state as the icon, and a minimal host draws the row as a ghost row;
 * legacy hosts get a tree glyph per stack level in the title and "draft" in
 * the description.
 */
export function pullRowLook(entry: QueueEntry, label: string, look: SidebarLook): PullRowLook {
  const title = `${label} ${titleWithoutTicket(entry.title, entry.ticketKey)}`;
  const stackedOn = entry.parentNumber === null ? null : `on #${entry.parentNumber}`;
  if (look !== "legacy") {
    const stack = stackedOn === null ? {} : { depth: entry.depth, description: stackedOn };
    const variant = look === "minimal" ? { variant: "ghost" as const } : {};
    return { title, ...stack, ...iconFor(queuedPullState(entry)), ...variant };
  }
  const description = [stackedOn, entry.isDraft ? "draft" : null].filter((part) => part !== null).join(" · ");
  return { title: `${stackPrefix(entry.depth)}${title}`, ...(description === "" ? {} : { description }) };
}

/**
 * An unstarted PR row's action label: a single "+" on a minimal host, which
 * draws it as a compact button, and "Start" elsewhere.
 */
export function pullActionLabel(look: SidebarLook, starting: boolean): string {
  if (look === "minimal") return starting ? "…" : "+";
  return starting ? "Starting…" : "Start";
}

export interface GroupHeaderLook {
  label: string;
  keyLabel?: string;
  /** The page bb opens when the ticket key is clicked. */
  labelHref?: string;
  icon?: string;
}

/**
 * A ticket group's header: on card and minimal hosts the ticket key in
 * `keyLabel` and the summary as the label, with the ticket icon on a card
 * host (a minimal host draws the key as a pill instead); on legacy hosts the
 * key and summary in one label. A ticket's header links to its Jira page.
 */
export function groupHeaderLook({ ticketKey, summary, url }: TicketGroup, look: SidebarLook): GroupHeaderLook {
  const icon = look === "card" ? { icon: TICKET_ICON } : {};
  if (ticketKey === null) return { label: NO_TICKET_LABEL, ...icon };
  const labelHref = url === null ? {} : { labelHref: url };
  if (look === "legacy") return { label: summary === null ? ticketKey : `${ticketKey} ${summary}`, ...labelHref };
  return { label: summary ?? "", keyLabel: ticketKey, ...labelHref, ...icon };
}

function isStacked(entry: QueueEntry): boolean {
  return entry.parentNumber !== null || entry.childNumbers.length > 0;
}

/**
 * Stacked PRs first, each base PR followed by its dependents, then PRs that
 * are not in a stack, each part in queue order.
 */
export function stackFirst(pulls: readonly QueueEntry[]): QueueEntry[] {
  const ordered = stackOrder(
    pulls,
    (entry) => pullKey(entry.repo, entry.number),
    (entry) => (entry.parentNumber === null ? null : pullKey(entry.repo, entry.parentNumber)),
  );
  return [...ordered.filter(isStacked), ...ordered.filter((entry) => !isStacked(entry))];
}

function itemKey(item: TicketGroupItem): string {
  if (item.kind === "pull") return pullKey(item.entry.repo, item.entry.number);
  return item.entry === null ? item.threadId : pullKey(item.entry.repo, item.entry.number);
}

function itemParentKey({ entry }: TicketGroupItem): string | null {
  return entry === null || entry.parentNumber === null ? null : pullKey(entry.repo, entry.parentNumber);
}

/**
 * Review threads before unstarted PRs, each part stack-first, with threads
 * whose PR is not in the queue after the other threads. A dependent still
 * follows its base PR, so a thread whose base PR has no thread sits after
 * that PR's row.
 */
function threadsFirstItems(items: readonly TicketGroupItem[]): TicketGroupItem[] {
  const byEntry = new Map<QueueEntry, TicketGroupItem>();
  const unknown: TicketGroupItem[] = [];
  for (const item of items) {
    if (item.entry === null) unknown.push(item);
    else byEntry.set(item.entry, item);
  }
  const stacked = stackFirst([...byEntry.keys()]).flatMap((entry) => byEntry.get(entry) ?? []);
  const threads = [...stacked.filter((item) => item.kind === "thread"), ...unknown];
  return stackOrder([...threads, ...stacked.filter((item) => item.kind === "pull")], itemKey, itemParentKey);
}

/**
 * `items` with each entry's depth counting only the base PRs among `items`,
 * so a PR whose base PR sits in another group starts at depth 0. `items`
 * must list each base PR before its dependents, as `threadsFirstItems` does.
 */
function withVisibleDepth(items: readonly TicketGroupItem[]): TicketGroupItem[] {
  const depthByKey = new Map<string, number>();
  return items.map((item) => {
    const { entry } = item;
    if (entry === null) return item;
    const parentDepth =
      entry.parentNumber === null ? undefined : depthByKey.get(pullKey(entry.repo, entry.parentNumber));
    const depth = parentDepth === undefined ? 0 : parentDepth + 1;
    depthByKey.set(pullKey(entry.repo, entry.number), depth);
    return { ...item, entry: { ...entry, depth } };
  });
}

export function ticketGroups(
  result: SidebarGroupsResult,
  projectIdByThreadId: ReadonlyMap<string, string>,
): TicketGroup[] {
  const tickets = new Map(result.tickets.map((ticket) => [ticket.key, ticket]));
  const groups = new Map<string, TicketGroup>();
  const groupFor = (projectId: string, ticketKey: string | null): TicketGroup => {
    const key = `${projectId}:${ticketKey ?? ""}`;
    let group = groups.get(key);
    if (group === undefined) {
      const ticket = ticketKey === null ? undefined : tickets.get(ticketKey);
      group = {
        projectId,
        key,
        ticketKey,
        summary: ticket?.summary ?? null,
        url: ticket?.url ?? null,
        tooltip: ticketKey === null ? null : ticketTooltip(ticketKey, tickets.get(ticketKey)),
        threadIds: [],
        items: [],
        pullLabel: pullLabeler([]),
      };
      groups.set(key, group);
    }
    return group;
  };
  const pullByThreadId = new Map(result.threadPulls.map(({ threadId, entry }) => [threadId, entry]));
  const reviewByThreadId = new Map(result.threadReviews.map(({ threadId, ...review }) => [threadId, review]));
  for (const { projectId, entry } of result.pulls) {
    groupFor(projectId, entry.ticketKey).items.push({ kind: "pull", entry });
  }
  for (const { threadId, ticketKey } of result.threadTickets) {
    const projectId = projectIdByThreadId.get(threadId);
    if (projectId === undefined) continue;
    const group = groupFor(projectId, ticketKey);
    group.threadIds.push(threadId);
    group.items.push({
      kind: "thread",
      threadId,
      entry: pullByThreadId.get(threadId) ?? null,
      review: reviewByThreadId.get(threadId) ?? null,
    });
  }
  for (const group of groups.values()) {
    group.items = withVisibleDepth(threadsFirstItems(group.items));
    group.pullLabel = pullLabeler(group.items.flatMap((item) => (item.entry === null ? [] : [item.entry.repo])));
  }
  return [...groups.values()].sort(
    (left, right) => Number(left.ticketKey === null) - Number(right.ticketKey === null),
  );
}
