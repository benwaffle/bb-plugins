import { describe, expect, it } from "vitest";
import type { QueueEntry, SidebarGroupsResult } from "./contract";
import { ticketGroups } from "./sidebar";

function entry(number: number, ticketKey: string | null): QueueEntry {
  return {
    repo: "acme/widgets",
    number,
    title: `PR ${number}`,
    url: `https://github.com/acme/widgets/pull/${number}`,
    isDraft: false,
    author: "ana",
    authorAvatarUrl: null,
    headRefName: `branch-${number}`,
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
        { key: "ACME-21", summary: "Speed up the importer", status: "In Progress", url: "https://jira/ACME-21" },
        { key: "ACME-30", summary: null, status: null, url: "https://jira/ACME-30" },
      ],
      threadTickets: [
        { threadId: "thr_a", ticketKey: "ACME-21" },
        { threadId: "thr_b", ticketKey: "ACME-21" },
        { threadId: "thr_other_project", ticketKey: "ACME-21" },
        { threadId: "thr_gone", ticketKey: "ACME-9" },
      ],
      pulls: [
        { projectId: "proj_widgets", entry: entry(7, null) },
        { projectId: "proj_widgets", entry: entry(8, "ACME-21") },
        { projectId: "proj_widgets", entry: entry(9, "ACME-30") },
      ],
    };
    const groups = ticketGroups(
      result,
      new Map([
        ["thr_a", "proj_widgets"],
        ["thr_b", "proj_widgets"],
        ["thr_other_project", "proj_web"],
      ]),
    );

    expect(
      groups.map((group) => ({
        project: group.projectId,
        label: group.label,
        tooltip: group.tooltip,
        threads: group.threadIds,
        pulls: group.pulls.map((pull) => pull.number),
      })),
    ).toEqual([
      { project: "proj_widgets", label: "ACME-21 Speed up the importer", tooltip: "ACME-21: Speed up the importer (In Progress)", threads: ["thr_a", "thr_b"], pulls: [8] },
      { project: "proj_widgets", label: "ACME-30", tooltip: "ACME-30 (loading title)", threads: [], pulls: [9] },
      { project: "proj_web", label: "ACME-21 Speed up the importer", tooltip: "ACME-21: Speed up the importer (In Progress)", threads: ["thr_other_project"], pulls: [] },
      { project: "proj_widgets", label: "No ticket", tooltip: null, threads: [], pulls: [7] },
    ]);
  });
});
