import type { Ticket } from "./contract.js";

/** The native tooltip for a ticket key: `CORE-51: <summary> (<status>)`. */
export function ticketTooltip(key: string, ticket: Ticket | undefined): string {
  if (ticket === undefined || ticket.summary === null) return `${key} (loading title)`;
  return ticket.status === null ? `${key}: ${ticket.summary}` : `${key}: ${ticket.summary} (${ticket.status})`;
}
