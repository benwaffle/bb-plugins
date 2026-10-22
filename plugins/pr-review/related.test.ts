import { describe, expect, it } from "vitest";
import type { QueueEntry } from "./contract";
import { relatedItems, withoutTickets, type RelatedItem } from "./related";

const REPO = "acme/widgets";

function entry(number: number, overrides: Partial<QueueEntry> = {}): QueueEntry {
  return {
    repo: REPO,
    number,
    title: `ACME-51: PR ${number}`,
    url: `https://github.com/${REPO}/pull/${number}`,
    isDraft: false,
    author: "ana",
    authorAvatarUrl: null,
    headRefName: `branch-${number}`,
    baseRefName: "main",
    parentNumber: null,
    depth: 0,
    childNumbers: [],
    ticketKey: "ACME-51",
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    conflicting: false,
    failingChecks: 0,
    pendingReviewers: 0,
    me: "requested",
    bucket: "requested",
    otherReviews: [],
    agent: { state: "none", threadId: null },
    ...overrides,
  };
}

function threadItem(threadId: string, number: number | null): RelatedItem {
  return {
    title: threadId,
    pull: number === null ? null : { repo: REPO, number, url: `https://github.com/${REPO}/pull/${number}`, state: "merged" },
    agent: { state: "reviewed", threadId },
  };
}

describe("relatedItems", () => {
  it("adds the ticket's other queued PRs, except the thread's own, the viewer's, and listed ones, and puts PRs first by number", () => {
    const items = relatedItems(
      [threadItem("thr_notes", null), threadItem("thr_610", 610), threadItem("thr_534", 534)],
      [
        entry(596),
        entry(610),
        entry(604, { isDraft: true }),
        entry(620, { me: "author" }),
        entry(630, { ticketKey: "ACME-9" }),
      ],
      ["ACME-51"],
      new Set([`${REPO}#596`]),
    );
    expect(items.map((item) => [item.pull?.number ?? null, item.pull?.state ?? null, item.title])).toEqual([
      [534, "merged", "thr_534"],
      [604, "draft", "PR 604"],
      [610, "merged", "thr_610"],
      [null, null, "thr_notes"],
    ]);
  });
});

describe("withoutTickets", () => {
  it("drops the prefix of whichever ticket the title starts with", () => {
    expect(withoutTickets("ACME-52: Refresh prices", ["ACME-51", "ACME-52"])).toBe("Refresh prices");
    expect(withoutTickets("OPS-1: Refresh prices", ["ACME-51"])).toBe("OPS-1: Refresh prices");
  });
});
