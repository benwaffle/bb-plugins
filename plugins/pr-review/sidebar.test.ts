import { describe, expect, it } from "vitest";
import type { QueueEntry, SidebarGroupsResult } from "./contract";
import {
  groupHeaderLook,
  pullActionLabel,
  pullRowLook,
  sidebarLook,
  sidebarStyle,
  stackedThreadRow,
  stackFirst,
  threadRowDecorations,
  stackPrefix,
  TICKET_ICON,
  ticketGroups,
  type TicketGroupItem,
} from "./sidebar";

function itemLabel(item: TicketGroupItem): string {
  return item.kind === "thread" ? item.threadId : `#${item.entry.number}`;
}

function entry(
  number: number,
  ticketKey: string | null,
  stack: Pick<QueueEntry, "parentNumber" | "depth" | "childNumbers"> = { parentNumber: null, depth: 0, childNumbers: [] },
): QueueEntry {
  return {
    repo: "acme/widgets",
    number,
    title: `PR ${number}`,
    url: `https://github.com/acme/widgets/pull/${number}`,
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
      threadPulls: [],
      threadReviews: [],
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
        label: groupHeaderLook(group, "legacy").label,
        tooltip: group.tooltip,
        threads: group.threadIds,
        items: group.items.map(itemLabel),
      })),
    ).toEqual([
      { project: "proj_widgets", label: "ACME-21 Speed up the importer", tooltip: "ACME-21: Speed up the importer (In Progress)", threads: ["thr_a", "thr_b"], items: ["#8", "thr_a", "thr_b"] },
      { project: "proj_widgets", label: "ACME-30", tooltip: "ACME-30 (loading title)", threads: [], items: ["#9"] },
      { project: "proj_web", label: "ACME-21 Speed up the importer", tooltip: "ACME-21: Speed up the importer (In Progress)", threads: ["thr_other_project"], items: ["thr_other_project"] },
      { project: "proj_widgets", label: "No ticket", tooltip: null, threads: [], items: ["#7"] },
    ]);
  });

  it("orders review threads and unstarted PRs together, stacks first, with unqueued threads last", () => {
    const withThread = (pull: QueueEntry, threadId: string): QueueEntry => ({
      ...pull,
      agent: { state: "reviewing", threadId },
    });
    const base = withThread(entry(552, "ACME-21", { parentNumber: null, depth: 0, childNumbers: [553, 570] }), "thr_552");
    const top = withThread(entry(564, "ACME-21", { parentNumber: 553, depth: 2, childNumbers: [] }), "thr_564");
    const result: SidebarGroupsResult = {
      tickets: [],
      threadTickets: [
        { threadId: "thr_old", ticketKey: "ACME-21" },
        { threadId: "thr_564", ticketKey: "ACME-21" },
        { threadId: "thr_552", ticketKey: "ACME-21" },
      ],
      pulls: [
        { projectId: "proj_widgets", entry: entry(560, "ACME-21") },
        { projectId: "proj_widgets", entry: entry(553, "ACME-21", { parentNumber: 552, depth: 1, childNumbers: [564] }) },
        { projectId: "proj_widgets", entry: entry(570, "ACME-21", { parentNumber: 552, depth: 1, childNumbers: [] }) },
      ],
      threadPulls: [
        { threadId: "thr_552", entry: base },
        { threadId: "thr_564", entry: top },
      ],
      threadReviews: [],
    };
    const [group] = ticketGroups(
      result,
      new Map([
        ["thr_old", "proj_widgets"],
        ["thr_552", "proj_widgets"],
        ["thr_564", "proj_widgets"],
      ]),
    );

    expect(group?.threadIds).toEqual(["thr_old", "thr_564", "thr_552"]);
    expect(group?.items.map(itemLabel)).toEqual(["thr_552", "#553", "thr_564", "#570", "#560", "thr_old"]);
    expect(
      group?.items.flatMap((item) => (item.kind === "thread" ? [stackedThreadRow(item.threadId, item.entry, item.review)] : [])),
    ).toEqual([
      { threadId: "thr_552" },
      { threadId: "thr_564", depth: 2, description: "stacked on #553" },
      { threadId: "thr_old" },
    ]);
  });

  it("counts stack depth only over the base PRs in the same group", () => {
    const result: SidebarGroupsResult = {
      tickets: [],
      threadTickets: [{ threadId: "thr_553", ticketKey: "ACME-21" }],
      pulls: [
        { projectId: "proj_widgets", entry: entry(552, "ACME-30", { parentNumber: null, depth: 0, childNumbers: [553] }) },
        { projectId: "proj_widgets", entry: entry(564, "ACME-21", { parentNumber: 553, depth: 2, childNumbers: [] }) },
      ],
      threadPulls: [{ threadId: "thr_553", entry: entry(553, "ACME-21", { parentNumber: 552, depth: 1, childNumbers: [564] }) }],
      threadReviews: [],
    };
    const group = ticketGroups(result, new Map([["thr_553", "proj_widgets"]])).find(
      ({ ticketKey }) => ticketKey === "ACME-21",
    );

    expect(group?.items.map(itemLabel)).toEqual(["thr_553", "#564"]);
    expect(group?.items.map((item) => item.entry?.depth)).toEqual([0, 1]);
    const [thread] = group?.items ?? [];
    expect(thread?.kind === "thread" && stackedThreadRow(thread.threadId, thread.entry, thread.review)).toEqual({
      threadId: "thr_553",
      depth: 0,
      description: "stacked on #552",
    });
  });

  it("labels PR rows with the repository only in a group that mixes repositories", () => {
    const gadget = (number: number): QueueEntry => ({ ...entry(number, "ACME-21"), repo: "acme/gadgets" });
    const result: SidebarGroupsResult = {
      tickets: [],
      threadTickets: [{ threadId: "thr_gadget", ticketKey: "ACME-21" }],
      pulls: [
        { projectId: "proj_widgets", entry: entry(600, "ACME-21") },
        { projectId: "proj_widgets", entry: entry(601, "ACME-30") },
      ],
      threadPulls: [{ threadId: "thr_gadget", entry: gadget(12) }],
      threadReviews: [],
    };
    const groups = ticketGroups(result, new Map([["thr_gadget", "proj_widgets"]]));
    const labels = groups.map((group) =>
      group.items.flatMap((item) => (item.kind === "pull" ? [group.pullLabel(item.entry.repo, item.entry.number)] : [])),
    );

    expect(labels).toEqual([["widgets#600"], ["#601"]]);
  });
});

describe("stackFirst", () => {
  it("puts each stack first, base PR then dependents, then PRs not in a stack", () => {
    const pulls = [
      entry(560, "ACME-21"),
      entry(564, "ACME-21", { parentNumber: 553, depth: 2, childNumbers: [] }),
      entry(570, "ACME-21", { parentNumber: 552, depth: 1, childNumbers: [] }),
      entry(552, "ACME-21", { parentNumber: null, depth: 0, childNumbers: [553, 570] }),
      entry(553, "ACME-21", { parentNumber: 552, depth: 1, childNumbers: [564] }),
      entry(540, "ACME-21"),
    ];
    expect(stackFirst(pulls).map((pull) => pull.number)).toEqual([552, 570, 553, 564, 560, 540]);
  });

  it("keeps a dependent whose base PR has a review thread with the stacks", () => {
    const pulls = [entry(560, "ACME-21"), entry(553, "ACME-21", { parentNumber: 552, depth: 1, childNumbers: [] })];
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

describe("styled looks", () => {
  const result = (pulls: QueueEntry[]): SidebarGroupsResult => ({
    tickets: [{ key: "ACME-21", summary: "Speed up the importer", status: null, url: "https://jira/ACME-21" }],
    threadTickets: [
      { threadId: "thr_merged", ticketKey: "ACME-21" },
      { threadId: "thr_followups", ticketKey: "ACME-21" },
      { threadId: "thr_running", ticketKey: "ACME-21" },
    ],
    pulls: pulls.map((pull) => ({ projectId: "proj_widgets", entry: pull })),
    threadPulls: [],
    threadReviews: [
      { threadId: "thr_merged", number: 31, title: "ACME-21: Drop the old cache", pullState: "merged", agent: "reviewed" },
      { threadId: "thr_followups", number: 32, title: null, pullState: "open", agent: "follow-ups" },
      { threadId: "thr_running", number: 33, title: "Stream rows", pullState: "draft", agent: "reviewing" },
    ],
  });
  const projects = new Map([
    ["thr_merged", "proj_widgets"],
    ["thr_followups", "proj_widgets"],
    ["thr_running", "proj_widgets"],
  ]);

  it("splits the ticket key from its summary on card and minimal hosts and keeps one label elsewhere", () => {
    const [ticket, none] = ticketGroups(result([entry(7, null)]), projects);
    expect(ticket && groupHeaderLook(ticket, "card")).toEqual({
      label: "Speed up the importer",
      keyLabel: "ACME-21",
      icon: TICKET_ICON,
    });
    expect(none && groupHeaderLook(none, "card")).toEqual({ label: "No ticket", icon: TICKET_ICON });
    expect(ticket && groupHeaderLook(ticket, "minimal")).toEqual({ label: "Speed up the importer", keyLabel: "ACME-21" });
    expect(none && groupHeaderLook(none, "minimal")).toEqual({ label: "No ticket" });
    expect(ticket && groupHeaderLook(ticket, "legacy")).toEqual({ label: "ACME-21 Speed up the importer" });
  });

  it("decorates flat thread rows with the ticket key, the grouped row's icon and dot, and the PR", () => {
    const groups = result([]);
    const decorations = threadRowDecorations({
      ...groups,
      threadTickets: [...groups.threadTickets, { threadId: "thr_notes", ticketKey: "ACME-21" }],
    });
    expect(Object.fromEntries(decorations)).toEqual({
      thr_merged: {
        icon: { name: "GitMerge", tone: "accent" },
        label: "ACME-21",
        description: "#31 Drop the old cache",
        trailing: { kind: "dot", tone: "success" },
      },
      thr_followups: {
        icon: { name: "GitPullRequest", tone: "success" },
        label: "ACME-21",
        description: "#32",
        trailing: { kind: "dot", tone: "accent" },
      },
      thr_running: {
        icon: { name: "GitPullRequestDraft", tone: "muted" },
        label: "ACME-21",
        description: "#33 Stream rows",
      },
      thr_notes: { label: "ACME-21" },
    });
  });

  it("gives review threads their PR icon and an agent dot unless the agent is running", () => {
    const [group] = ticketGroups(result([]), projects);
    expect(
      group?.items.flatMap((item) => (item.kind === "thread" ? [stackedThreadRow(item.threadId, item.entry, item.review)] : [])),
    ).toEqual([
      {
        threadId: "thr_merged",
        icon: { name: "GitMerge", tone: "accent" },
        trailing: { kind: "dot", tone: "success" },
      },
      {
        threadId: "thr_followups",
        icon: { name: "GitPullRequest", tone: "success" },
        trailing: { kind: "dot", tone: "accent" },
      },
      { threadId: "thr_running", icon: { name: "GitPullRequestDraft", tone: "muted" } },
    ]);
  });

  it("shows a stacked draft PR by depth and icon on a card host and by glyph and text elsewhere", () => {
    const draft = { ...entry(553, "ACME-21", { parentNumber: 552, depth: 1, childNumbers: [] }), isDraft: true };
    expect(pullRowLook(draft, "#553", "card")).toEqual({
      title: "#553 PR 553",
      depth: 1,
      description: "on #552",
      icon: { name: "GitPullRequestDraft", tone: "muted" },
    });
    expect(pullRowLook(draft, "#553", "legacy")).toEqual({ title: "└ #553 PR 553", description: "on #552 · draft" });
    expect(pullRowLook(entry(600, null), "#600", "card")).toEqual({
      title: "#600 PR 600",
      icon: { name: "GitPullRequest", tone: "success" },
    });
    expect(pullRowLook(draft, "#553", "minimal")).toEqual({
      title: "#553 PR 553",
      depth: 1,
      description: "on #552",
      icon: { name: "GitPullRequestDraft", tone: "muted" },
      variant: "ghost",
    });
    const top = entry(564, "ACME-21", { parentNumber: 553, depth: 2, childNumbers: [] });
    expect(pullRowLook(top, "#564", "card")).toMatchObject({ title: "#564 PR 564", depth: 2 });
    expect(pullRowLook(top, "#564", "legacy")).toMatchObject({ title: "\u00a0\u00a0└ #564 PR 564" });
  });

  it("labels the start action + on a minimal host and Start elsewhere", () => {
    expect(pullActionLabel("minimal", false)).toBe("+");
    expect(pullActionLabel("minimal", true)).toBe("…");
    expect(pullActionLabel("card", false)).toBe("Start");
    expect(pullActionLabel("legacy", true)).toBe("Starting…");
  });
});

describe("sidebarLook", () => {
  it("reads the chosen style from the settings, minimal unless card", () => {
    expect(sidebarStyle(undefined)).toBe("minimal");
    expect(sidebarStyle("card")).toBe("card");
    expect(sidebarStyle("minimal")).toBe("minimal");
  });

  const legacy = (style: string) => ({ look: "legacy", style });
  const styled = (look: string) => ({ look, style: look });

  it("publishes legacy groups with the chosen style until the host reports a style back", () => {
    expect(sidebarLook("minimal", undefined, false)).toEqual(legacy("minimal"));
    expect(sidebarLook("card", undefined, false)).toEqual(legacy("card"));
  });

  it("uses minimal groups once a host reports minimal back", () => {
    expect(sidebarLook("minimal", "minimal", false)).toEqual(styled("minimal"));
  });

  it("falls back to card groups on a host that reports a minimal group back as flat", () => {
    expect(sidebarLook("minimal", "flat", false)).toEqual(styled("card"));
    expect(sidebarLook("minimal", "card", true)).toEqual(styled("card"));
  });

  it("tries minimal again after switching from card on a host not known to reject it", () => {
    expect(sidebarLook("minimal", "card", false)).toEqual(styled("minimal"));
  });

  it("uses card groups when card is chosen and the host reports any style", () => {
    expect(sidebarLook("card", "card", false)).toEqual(styled("card"));
    expect(sidebarLook("card", "minimal", false)).toEqual(styled("card"));
  });
});
