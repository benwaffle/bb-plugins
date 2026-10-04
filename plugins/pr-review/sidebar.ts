import type { QueueEntry, SidebarGroupsResult } from "./contract.js";
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
      group = {
        projectId,
        key,
        label: ticketKey ?? NO_TICKET_LABEL,
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
  return [...groups.values()].sort(
    (left, right) => Number(left.label === NO_TICKET_LABEL) - Number(right.label === NO_TICKET_LABEL),
  );
}
