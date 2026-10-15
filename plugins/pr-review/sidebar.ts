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
  tooltip: string | null;
  threadIds: string[];
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
}

/**
 * A review thread's sidebar entry: the stack depth and "stacked on #N" of
 * its PR, absent when the PR is a stack base, not stacked, or not queued,
 * and its PR's state icon and agent dot, which bb builds without card
 * groups ignore.
 */
export function stackedThreadRow(threadId: string, entry: QueueEntry | null, review: ThreadReview | null): StackedThreadRow {
  const look = review === null ? {} : { ...iconFor(review.pullState), ...trailingFor(review.agent) };
  if (entry === null || entry.parentNumber === null) return { threadId, ...look };
  return { threadId, depth: entry.depth, description: `stacked on #${entry.parentNumber}`, ...look };
}

export interface PullRowLook {
  title: string;
  depth?: number;
  description?: string;
  icon?: SidebarRowIcon;
}

/**
 * An unstarted PR row's title, description, and icon. A card host gets the
 * stack depth, which it draws as a connector rail, and the draft state as the
 * icon; other hosts get a tree glyph per stack level in the title and "draft"
 * in the description.
 */
export function pullRowLook(entry: QueueEntry, label: string, card: boolean): PullRowLook {
  const title = `${label} ${titleWithoutTicket(entry.title, entry.ticketKey)}`;
  const stackedOn = entry.parentNumber === null ? null : `on #${entry.parentNumber}`;
  if (card) {
    const stack = stackedOn === null ? {} : { depth: entry.depth, description: stackedOn };
    return { title, ...stack, ...iconFor(queuedPullState(entry)) };
  }
  const description = [stackedOn, entry.isDraft ? "draft" : null].filter((part) => part !== null).join(" · ");
  return { title: `${stackPrefix(entry.depth)}${title}`, ...(description === "" ? {} : { description }) };
}

export interface GroupHeaderLook {
  label: string;
  keyLabel?: string;
  icon?: string;
  style?: "card";
}

/**
 * A ticket group's header: on a card host the ticket key in `keyLabel`, the
 * summary as the label, and the ticket icon; on other hosts the key and
 * summary in one label.
 */
export function groupHeaderLook({ ticketKey, summary }: TicketGroup, card: boolean): GroupHeaderLook {
  if (ticketKey === null) return card ? { label: NO_TICKET_LABEL, icon: TICKET_ICON, style: "card" } : { label: NO_TICKET_LABEL };
  if (card) return { label: summary ?? "", keyLabel: ticketKey, icon: TICKET_ICON, style: "card" };
  return { label: summary === null ? ticketKey : `${ticketKey} ${summary}` };
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

/**
 * Unstarted PRs and review threads in one stack-first order, so a dependent
 * follows its base PR whether either has a thread. Threads whose PR is not in
 * the queue come last.
 */
function stackFirstItems(items: readonly TicketGroupItem[]): TicketGroupItem[] {
  const byEntry = new Map<QueueEntry, TicketGroupItem>();
  const unknown: TicketGroupItem[] = [];
  for (const item of items) {
    if (item.entry === null) unknown.push(item);
    else byEntry.set(item.entry, item);
  }
  return [...stackFirst([...byEntry.keys()]).flatMap((entry) => byEntry.get(entry) ?? []), ...unknown];
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
      const summary = ticketKey === null ? null : (tickets.get(ticketKey)?.summary ?? null);
      group = {
        projectId,
        key,
        ticketKey,
        summary,
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
    group.items = stackFirstItems(group.items);
    group.pullLabel = pullLabeler(group.items.flatMap((item) => (item.entry === null ? [] : [item.entry.repo])));
  }
  return [...groups.values()].sort(
    (left, right) => Number(left.ticketKey === null) - Number(right.ticketKey === null),
  );
}
