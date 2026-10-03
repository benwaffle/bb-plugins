import { describe, expect, it } from "vitest";
import type { QueueEntry, SidebarGroupsResult } from "./contract";
import { ticketGroups } from "./sidebar";

function entry(number: number, ticketKey: string | null): QueueEntry {
  return {
    repo: "private-tech-inc/hss",
    number,
    title: `PR ${number}`,
    url: `https://github.com/private-tech-inc/hss/pull/${number}`,
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
      tickets: [{ key: "CORE-21", summary: "Speed up the importer", status: null, url: "https://jira/CORE-21" }],
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
        pulls: group.pulls.map((pull) => pull.number),
      })),
    ).toEqual([
      { project: "proj_hss", label: "CORE-21", tooltip: "Speed up the importer", threads: ["thr_a", "thr_b"], pulls: [8] },
      { project: "proj_hss", label: "CORE-30", tooltip: null, threads: [], pulls: [9] },
      { project: "proj_web", label: "CORE-21", tooltip: "Speed up the importer", threads: ["thr_other_project"], pulls: [] },
      { project: "proj_hss", label: "No ticket", tooltip: null, threads: [], pulls: [7] },
    ]);
  });
});
