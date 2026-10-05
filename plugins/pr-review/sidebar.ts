import type { QueueEntry, SidebarGroupsResult } from "./contract.js";
import { pullKey, stackOrder } from "./queue.js";
import { ticketTooltip } from "./tickets.js";

export const NO_TICKET_LABEL = "No ticket";

export type TicketGroupItem =
  | { kind: "pull"; entry: QueueEntry }
  | { kind: "thread"; threadId: string; entry: QueueEntry | null };

export interface TicketGroup {
  projectId: string;
  key: string;
  label: string;
  tooltip: string | null;
  threadIds: string[];
  items: TicketGroupItem[];
}

/**
 * A tree glyph indented one step per stack level below the first, such as
 * "└ " at depth 1 and "  └ " at depth 2. The indent is U+00A0 because the
 * sidebar collapses leading ASCII spaces in a row title.
 */
export function stackPrefix(depth: number): string {
  return depth === 0 ? "" : `${"\u00a0\u00a0".repeat(depth - 1)}└ `;
}

export interface StackedThreadRow {
  threadId: string;
  depth?: number;
  description?: string;
}

/**
 * A review thread's sidebar entry: the stack depth and "stacked on #N" of
 * its PR, absent when the PR is a stack base, not stacked, or not queued.
 */
export function stackedThreadRow(threadId: string, entry: QueueEntry | null): StackedThreadRow {
  if (entry === null || entry.parentNumber === null) return { threadId };
  return { threadId, depth: entry.depth, description: `stacked on #${entry.parentNumber}` };
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
  const labelFor = (ticketKey: string | null): string => {
    if (ticketKey === null) return NO_TICKET_LABEL;
    const summary = tickets.get(ticketKey)?.summary ?? null;
    return summary === null ? ticketKey : `${ticketKey} ${summary}`;
  };
  const groupFor = (projectId: string, ticketKey: string | null): TicketGroup => {
    const key = `${projectId}:${ticketKey ?? ""}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        projectId,
        key,
        label: labelFor(ticketKey),
        tooltip: ticketKey === null ? null : ticketTooltip(ticketKey, tickets.get(ticketKey)),
        threadIds: [],
        items: [],
      };
      groups.set(key, group);
    }
    return group;
  };
  const pullByThreadId = new Map(result.threadPulls.map(({ threadId, entry }) => [threadId, entry]));
  for (const { projectId, entry } of result.pulls) {
    groupFor(projectId, entry.ticketKey).items.push({ kind: "pull", entry });
  }
  for (const { threadId, ticketKey } of result.threadTickets) {
    const projectId = projectIdByThreadId.get(threadId);
    if (projectId === undefined) continue;
    const group = groupFor(projectId, ticketKey);
    group.threadIds.push(threadId);
    group.items.push({ kind: "thread", threadId, entry: pullByThreadId.get(threadId) ?? null });
  }
  for (const group of groups.values()) group.items = stackFirstItems(group.items);
  return [...groups.values()].sort(
    (left, right) => Number(left.label === NO_TICKET_LABEL) - Number(right.label === NO_TICKET_LABEL),
  );
}
