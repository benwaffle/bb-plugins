import { describe, expect, it } from "vitest";
import type { QueueEntry, SidebarGroupsResult } from "./contract";
import { stackedThreadRow, stackFirst, stackPrefix, ticketGroups, type TicketGroupItem } from "./sidebar";

function itemLabel(item: TicketGroupItem): string {
  return item.kind === "thread" ? item.threadId : `#${item.entry.number}`;
}

function entry(
  number: number,
  ticketKey: string | null,
  stack: Pick<QueueEntry, "parentNumber" | "depth" | "childNumbers"> = { parentNumber: null, depth: 0, childNumbers: [] },
): QueueEntry {
  return {
    repo: "private-tech-inc/hss",
    number,
    title: `PR ${number}`,
    url: `https://github.com/private-tech-inc/hss/pull/${number}`,
    isDraft: false,
    author: "ana",
    authorAvatarUrl: null,
    headRefName: `branch-${number}`,
    baseRefName: stack.parentNumber === null ? "main" : `branch-${stack.parentNumber}`,
    ...stack,
    ticketKey,
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    me: "requested",
    bucket: "requested",
    otherReviews: [],
    agent: { state: "none", threadId: null },
  };
}

describe("ticketGroups", () => {
  it("groups threads and unstarted PRs per project and ticket, with untagged PRs last", () => {
    const result: SidebarGroupsResult = {
      githubPanel: true,
      tickets: [
        { key: "CORE-21", summary: "Speed up the importer", status: "In Progress", url: "https://jira/CORE-21" },
        { key: "CORE-30", summary: null, status: null, url: "https://jira/CORE-30" },
      ],
      threadTickets: [
        { threadId: "thr_a", ticketKey: "CORE-21" },
        { threadId: "thr_b", ticketKey: "CORE-21" },
        { threadId: "thr_other_project", ticketKey: "CORE-21" },
        { threadId: "thr_gone", ticketKey: "CORE-9" },
      ],
      pulls: [
        { projectId: "proj_hss", entry: entry(7, null) },
        { projectId: "proj_hss", entry: entry(8, "CORE-21") },
        { projectId: "proj_hss", entry: entry(9, "CORE-30") },
      ],
      threadPulls: [],
    };
    const groups = ticketGroups(
      result,
      new Map([
        ["thr_a", "proj_hss"],
        ["thr_b", "proj_hss"],
        ["thr_other_project", "proj_web"],
      ]),
    );

    expect(
      groups.map((group) => ({
        project: group.projectId,
        label: group.label,
        tooltip: group.tooltip,
        threads: group.threadIds,
        items: group.items.map(itemLabel),
      })),
    ).toEqual([
      { project: "proj_hss", label: "CORE-21 Speed up the importer", tooltip: "CORE-21: Speed up the importer (In Progress)", threads: ["thr_a", "thr_b"], items: ["#8", "thr_a", "thr_b"] },
      { project: "proj_hss", label: "CORE-30", tooltip: "CORE-30 (loading title)", threads: [], items: ["#9"] },
      { project: "proj_web", label: "CORE-21 Speed up the importer", tooltip: "CORE-21: Speed up the importer (In Progress)", threads: ["thr_other_project"], items: ["thr_other_project"] },
      { project: "proj_hss", label: "No ticket", tooltip: null, threads: [], items: ["#7"] },
    ]);
  });

  it("orders review threads and unstarted PRs together, stacks first, with unqueued threads last", () => {
    const withThread = (pull: QueueEntry, threadId: string): QueueEntry => ({
      ...pull,
      agent: { state: "reviewing", threadId },
    });
    const base = withThread(entry(552, "CORE-21", { parentNumber: null, depth: 0, childNumbers: [553, 570] }), "thr_552");
    const top = withThread(entry(564, "CORE-21", { parentNumber: 553, depth: 2, childNumbers: [] }), "thr_564");
    const result: SidebarGroupsResult = {
      githubPanel: true,
      tickets: [],
      threadTickets: [
        { threadId: "thr_old", ticketKey: "CORE-21" },
        { threadId: "thr_564", ticketKey: "CORE-21" },
        { threadId: "thr_552", ticketKey: "CORE-21" },
      ],
      pulls: [
        { projectId: "proj_hss", entry: entry(560, "CORE-21") },
        { projectId: "proj_hss", entry: entry(553, "CORE-21", { parentNumber: 552, depth: 1, childNumbers: [564] }) },
        { projectId: "proj_hss", entry: entry(570, "CORE-21", { parentNumber: 552, depth: 1, childNumbers: [] }) },
      ],
      threadPulls: [
        { threadId: "thr_552", entry: base },
        { threadId: "thr_564", entry: top },
      ],
    };
    const [group] = ticketGroups(
      result,
      new Map([
        ["thr_old", "proj_hss"],
        ["thr_552", "proj_hss"],
        ["thr_564", "proj_hss"],
      ]),
    );

    expect(group?.threadIds).toEqual(["thr_old", "thr_564", "thr_552"]);
    expect(group?.items.map(itemLabel)).toEqual(["thr_552", "#553", "thr_564", "#570", "#560", "thr_old"]);
    expect(
      group?.items.flatMap((item) => (item.kind === "thread" ? [stackedThreadRow(item.threadId, item.entry)] : [])),
    ).toEqual([
      { threadId: "thr_552" },
      { threadId: "thr_564", depth: 2, description: "stacked on #553" },
      { threadId: "thr_old" },
    ]);
  });
});

describe("stackFirst", () => {
  it("puts each stack first, base PR then dependents, then PRs not in a stack", () => {
    const pulls = [
      entry(560, "CORE-21"),
      entry(564, "CORE-21", { parentNumber: 553, depth: 2, childNumbers: [] }),
      entry(570, "CORE-21", { parentNumber: 552, depth: 1, childNumbers: [] }),
      entry(552, "CORE-21", { parentNumber: null, depth: 0, childNumbers: [553, 570] }),
      entry(553, "CORE-21", { parentNumber: 552, depth: 1, childNumbers: [564] }),
      entry(540, "CORE-21"),
    ];
    expect(stackFirst(pulls).map((pull) => pull.number)).toEqual([552, 570, 553, 564, 560, 540]);
  });

  it("keeps a dependent whose base PR has a review thread with the stacks", () => {
    const pulls = [entry(560, "CORE-21"), entry(553, "CORE-21", { parentNumber: 552, depth: 1, childNumbers: [] })];
    expect(stackFirst(pulls).map((pull) => pull.number)).toEqual([553, 560]);
  });
});

describe("stackPrefix", () => {
  it("indents a tree glyph with non-breaking spaces per stack level", () => {
    expect(stackPrefix(0)).toBe("");
    expect(stackPrefix(1)).toBe("└ ");
    expect(stackPrefix(2)).toBe("\u00a0\u00a0└ ");
  });
});
