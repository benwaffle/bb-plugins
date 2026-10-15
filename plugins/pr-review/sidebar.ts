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
 * and its PR's state icon and agent dot, which bb builds without card or
 * minimal groups ignore. Thread rows look the same on card and minimal hosts.
 */
export function stackedThreadRow(threadId: string, entry: QueueEntry | null, review: ThreadReview | null): StackedThreadRow {
  const look = review === null ? {} : { ...iconFor(review.pullState), ...trailingFor(review.agent) };
  if (entry === null || entry.parentNumber === null) return { threadId, ...look };
  return { threadId, depth: entry.depth, description: `stacked on #${entry.parentNumber}`, ...look };
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
  icon?: string;
}

/**
 * A ticket group's header: on card and minimal hosts the ticket key in
 * `keyLabel` and the summary as the label, with the ticket icon on a card
 * host (a minimal host draws the key as a pill instead); on legacy hosts the
 * key and summary in one label.
 */
export function groupHeaderLook({ ticketKey, summary }: TicketGroup, look: SidebarLook): GroupHeaderLook {
  const icon = look === "card" ? { icon: TICKET_ICON } : {};
  if (ticketKey === null) return { label: NO_TICKET_LABEL, ...icon };
  if (look === "legacy") return { label: summary === null ? ticketKey : `${ticketKey} ${summary}` };
  return { label: summary ?? "", keyLabel: ticketKey, ...icon };
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
