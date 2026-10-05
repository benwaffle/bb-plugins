import type { QueueEntry, SidebarGroupsResult } from "./contract.js";
import { pullKey, stackOrder } from "./queue.js";
import { ticketTooltip } from "./tickets.js";

export const NO_TICKET_LABEL = "No ticket";

export interface TicketGroup {
  projectId: string;
  key: string;
  label: string;
  tooltip: string | null;
  threadIds: string[];
  pulls: QueueEntry[];
}

/**
 * A tree glyph indented one step per stack level below the first, such as
 * "└ " at depth 1 and "  └ " at depth 2. The indent is U+00A0 because the
 * sidebar collapses leading ASCII spaces in a row title.
 */
export function stackPrefix(depth: number): string {
  return depth === 0 ? "" : `${"\u00a0\u00a0".repeat(depth - 1)}└ `;
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
        pulls: [],
      };
      groups.set(key, group);
    }
    return group;
  };
  for (const { projectId, entry } of result.pulls) {
    groupFor(projectId, entry.ticketKey).pulls.push(entry);
  }
  for (const { threadId, ticketKey } of result.threadTickets) {
    const projectId = projectIdByThreadId.get(threadId);
    if (projectId !== undefined) groupFor(projectId, ticketKey).threadIds.push(threadId);
  }
  for (const group of groups.values()) group.pulls = stackFirst(group.pulls);
  return [...groups.values()].sort(
    (left, right) => Number(left.label === NO_TICKET_LABEL) - Number(right.label === NO_TICKET_LABEL),
  );
}
