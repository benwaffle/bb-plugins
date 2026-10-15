import type { QueueEntry, RelatedResult } from "./contract.js";
import { titleWithoutTicket } from "./parse.js";
import { pullKey } from "./queue.js";

export type RelatedItem = RelatedResult["items"][number];
export type RelatedPullState = NonNullable<RelatedItem["pull"]>["state"];

export function queuedPullState(entry: Pick<QueueEntry, "isDraft">): "open" | "draft" {
  return entry.isDraft ? "draft" : "open";
}

/** `title` without the prefix of whichever of `tickets` it starts with. */
export function withoutTickets(title: string, tickets: readonly string[]): string {
  return tickets.reduce((stripped, key) => titleWithoutTicket(stripped, key), title);
}

/**
 * The Related tab's items: `threadItems`, plus each queued PR on `tickets`
 * that none of them covers, that is not in `ownPulls`, and that is not the
 * viewer's own. PRs come first, by repository and number, then threads
 * without a PR.
 */
export function relatedItems(
  threadItems: readonly RelatedItem[],
  entries: readonly QueueEntry[],
  tickets: readonly string[],
  ownPulls: ReadonlySet<string>,
): RelatedItem[] {
  const listed = new Set(
    threadItems.flatMap((item) => (item.pull === null ? [] : [pullKey(item.pull.repo, item.pull.number)])),
  );
  const unstarted = entries
    .filter((entry) => entry.ticketKey !== null && tickets.includes(entry.ticketKey) && entry.me !== "author")
    .filter((entry) => !ownPulls.has(pullKey(entry.repo, entry.number)) && !listed.has(pullKey(entry.repo, entry.number)))
    .map(
      (entry): RelatedItem => ({
        title: withoutTickets(entry.title, tickets),
        pull: { repo: entry.repo, number: entry.number, url: entry.url, state: queuedPullState(entry) },
        agent: entry.agent,
      }),
    );
  return [...threadItems, ...unstarted].sort(
    (left, right) =>
      Number(left.pull === null) - Number(right.pull === null) ||
      (left.pull?.repo ?? "").localeCompare(right.pull?.repo ?? "") ||
      (left.pull?.number ?? 0) - (right.pull?.number ?? 0),
  );
}
