import { describe, expect, it } from "vitest";
import {
  agentState,
  classifyPull,
  isReviewMessage,
  needsViewer,
  pullLabeler,
  queueSections,
  sortQueue,
  stackLinks,
  type PullReview,
  type PullSnapshot,
} from "./queue.js";

const ME = { login: "benwaffle", teams: ["acme/platform"] };
const HEAD = "head-oid";

function pull(number: number, overrides: Partial<PullSnapshot> = {}): PullSnapshot {
  return {
    repo: "acme/widgets",
    number,
    title: `PR ${number}`,
    body: "",
    url: `https://github.com/acme/widgets/pull/${number}`,
    isDraft: false,
    author: "bob",
    authorAvatarUrl: null,
    headRefName: `branch-${number}`,
    headRefOid: HEAD,
    baseRefName: "main",
    isCrossRepository: false,
    additions: 10,
    deletions: 2,
    changedFiles: 1,
    conflicting: false,
    failingChecks: 0,
    updatedAt: "2026-10-01T00:00:00Z",
    requestedUsers: [],
    requestedTeams: [],
    latestReviews: [],
    ...overrides,
  };
}

function review(login: string, state: PullReview["state"], commitOid: string = HEAD, isBot = false): PullReview {
  return { login, avatarUrl: `https://avatars.example/${login}`, state, isBot, commitOid, submittedAt: "2026-10-01T00:00:00Z" };
}

function order(pulls: PullSnapshot[]): number[] {
  return sortQueue(
    pulls.map((entry) => ({ pull: entry, classified: classifyPull(entry, ME) })),
    stackLinks(pulls),
  ).map((entry) => entry.pull.number);
}

function on(base: number, number: number, overrides: Partial<PullSnapshot> = {}): PullSnapshot {
  return pull(number, { baseRefName: `branch-${base}`, ...overrides });
}

function links(pulls: PullSnapshot[]): Record<string, [number | null, number, number[]]> {
  return Object.fromEntries(
    [...stackLinks(pulls)].map(([key, link]) => [key.slice(key.indexOf("#")), [link.parentNumber, link.depth, link.childNumbers]]),
  );
}

describe("classifyPull", () => {
  it("counts a team request as mine until I review", () => {
    const viaTeam = pull(1, { requestedTeams: ["acme/platform"] });
    expect(classifyPull(viaTeam, ME).me).toBe("requested");
    const reviewed = pull(2, {
      requestedTeams: ["acme/platform"],
      latestReviews: [review("benwaffle", "COMMENTED")],
    });
    expect(classifyPull(reviewed, ME).me).toBe("commented");
  });

  it("treats a personal re-request as requested even after a review", () => {
    const rerequested = pull(1, {
      requestedUsers: ["benwaffle"],
      latestReviews: [review("benwaffle", "CHANGES_REQUESTED")],
    });
    expect(classifyPull(rerequested, ME).me).toBe("requested");
  });

  it("flags an approval whose commit is no longer the head", () => {
    expect(classifyPull(pull(1, { latestReviews: [review("benwaffle", "APPROVED")] }), ME)).toMatchObject({
      me: "approved",
      bucket: "approved",
    });
    expect(
      classifyPull(pull(2, { latestReviews: [review("benwaffle", "APPROVED", "older-oid")] }), ME),
    ).toMatchObject({ me: "approved-stale", bucket: "approval-stale" });
  });

  it("leaves bots and me out of other reviewers", () => {
    const classified = classifyPull(
      pull(1, {
        latestReviews: [
          review("copilot-pull-request-reviewer", "COMMENTED", HEAD, true),
          review("benwaffle", "COMMENTED"),
          review("alice", "APPROVED"),
        ],
      }),
      ME,
    );
    expect(classified.otherReviews).toEqual([
      { login: "alice", avatarUrl: "https://avatars.example/alice", state: "APPROVED" },
    ]);
    expect(classified.otherApprovals).toBe(1);
  });

  it("marks my own PRs as author", () => {
    expect(classifyPull(pull(1, { author: "benwaffle", requestedTeams: ME.teams.slice() }), ME).me).toBe("author");
  });
});

describe("stackLinks", () => {
  it("links a chain of three", () => {
    expect(links([on(553, 564), pull(552), on(552, 553)])).toEqual({
      "#552": [null, 0, [553]],
      "#553": [552, 1, [564]],
      "#564": [553, 2, []],
    });
  });

  it("lists both children of a fork, lowest number first", () => {
    expect(links([on(552, 570), pull(552), on(552, 553)])).toEqual({
      "#552": [null, 0, [553, 570]],
      "#553": [552, 1, []],
      "#570": [552, 1, []],
    });
  });

  it("makes a PR a root once its base PR is no longer open", () => {
    expect(links([on(552, 553), on(553, 564)])).toEqual({
      "#553": [null, 0, [564]],
      "#564": [553, 1, []],
    });
  });

  it("ignores a matching head branch in another repository or in a fork", () => {
    expect(
      links([
        pull(552, { repo: "acme/web" }),
        pull(560, { headRefName: "shared", isCrossRepository: true }),
        on(552, 553),
        pull(561, { baseRefName: "shared" }),
      ]),
    ).toEqual({
      "#552": [null, 0, []],
      "#560": [null, 0, []],
      "#553": [null, 0, []],
      "#561": [null, 0, []],
    });
  });

  it("cuts a cycle of PRs that target each other's head branch", () => {
    expect(links([on(2, 1), on(1, 2)])).toEqual({ "#1": [null, 0, [2]], "#2": [1, 1, []] });
  });
});

describe("sortQueue", () => {
  it("puts stacked PRs directly after their base PR inside a priority group", () => {
    const requested = { requestedUsers: ["benwaffle"] };
    expect(
      order([pull(552, requested), on(552, 553, requested), pull(560, requested), on(553, 564, requested), on(552, 570, requested)]),
    ).toEqual([552, 553, 564, 570, 560]);
  });

  it("leaves a stacked PR in its own priority group", () => {
    const base = pull(552, { requestedUsers: ["benwaffle"] });
    const dependent = on(552, 553, { author: "benwaffle" });
    expect(order([dependent, pull(554, { requestedUsers: ["benwaffle"] }), base])).toEqual([552, 554, 553]);
  });

  it("orders stale approvals, then requested without approvals, requested with approvals, commented, rest, approved", () => {
    const requestedApproved = pull(10, {
      requestedUsers: ["benwaffle"],
      latestReviews: [review("alice", "APPROVED")],
    });
    const requested = pull(20, { requestedUsers: ["benwaffle"] });
    const commented = pull(5, { latestReviews: [review("benwaffle", "COMMENTED")] });
    const approved = pull(1, { latestReviews: [review("benwaffle", "APPROVED")] });
    const stale = pull(40, { latestReviews: [review("benwaffle", "APPROVED", "old")] });
    const mine = pull(3, { author: "benwaffle" });
    expect(order([requestedApproved, requested, commented, approved, stale, mine])).toEqual([
      40, 20, 10, 5, 3, 1,
    ]);
  });

  it("puts drafts after every ready PR, in priority order, ahead of approved PRs", () => {
    const staleDraft = pull(2, { latestReviews: [review("benwaffle", "APPROVED", "old")], isDraft: true });
    const requestedDraft = pull(1, { requestedUsers: ["benwaffle"], isDraft: true });
    const mineDraft = pull(4, { author: "benwaffle", isDraft: true });
    const newer = pull(30, { requestedUsers: ["benwaffle"] });
    const older = pull(25, { requestedUsers: ["benwaffle"] });
    const mine = pull(3, { author: "benwaffle" });
    const approved = pull(6, { latestReviews: [review("benwaffle", "APPROVED")] });
    expect(order([mineDraft, approved, requestedDraft, staleDraft, mine, newer, older])).toEqual([
      25, 30, 3, 2, 1, 4, 6,
    ]);
  });
});

describe("isReviewMessage", () => {
  const COMMAND = "/tncqr review pr";

  it("finds the review command on any line of a message", () => {
    expect(isReviewMessage(`${COMMAND} 596`, COMMAND)).toBe(true);
    expect(isReviewMessage(`Review context\n- Ticket ACME-51\n\n${COMMAND} 539`, COMMAND)).toBe(true);
    expect(isReviewMessage(`Run ${COMMAND} 596 later`, COMMAND)).toBe(false);
    expect(isReviewMessage("Review context", COMMAND)).toBe(false);
  });
});

describe("agentState", () => {
  const messages = (...times: number[]) => times.map((createdAt) => ({ createdAt, text: "message" }));
  const state = (createdAt: number[], reviewedAt: number | null, isRunning: boolean) =>
    agentState({ userMessages: messages(...createdAt), reviewedAt, isRunning });

  it("reports a thread without a review as opened, whatever else it was sent", () => {
    expect(agentState(null)).toBe("none");
    expect(state([1], null, true)).toBe("opened");
    expect(state([1, 2, 3], null, false)).toBe("opened");
  });

  it("reports reviewing, then reviewed, once the review command is sent", () => {
    expect(state([1, 2], 2, true)).toBe("reviewing");
    expect(state([1, 2], 2, false)).toBe("reviewed");
    expect(state([1], 5, true)).toBe("reviewing");
  });

  it("reports follow-ups for messages after the last review", () => {
    expect(state([1, 2, 3], 2, true)).toBe("follow-ups");
    expect(state([1, 2, 3, 4], 4, false)).toBe("reviewed");
  });
});

describe("needsViewer", () => {
  it("counts requested reviews and stale approvals on ready PRs only", () => {
    expect(needsViewer({ me: "requested", isDraft: false })).toBe(true);
    expect(needsViewer({ me: "approved-stale", isDraft: false })).toBe(true);
    expect(needsViewer({ me: "requested", isDraft: true })).toBe(false);
    expect(needsViewer({ me: "author", isDraft: false })).toBe(false);
    expect(needsViewer({ me: "commented", isDraft: false })).toBe(false);
    expect(needsViewer({ me: "none", isDraft: false })).toBe(false);
  });
});

describe("pullLabeler", () => {
  it("names the repository only when the PRs mix repositories", () => {
    expect(pullLabeler(["acme/widgets", "acme/widgets"])("acme/widgets", 600)).toBe("#600");
    expect(pullLabeler([])("acme/widgets", 600)).toBe("#600");
    const mixed = pullLabeler(["acme/widgets", "acme/gadgets"]);
    expect(mixed("acme/widgets", 600)).toBe("widgets#600");
    expect(mixed("acme/gadgets", 12)).toBe("gadgets#12");
  });
});

describe("queueSections", () => {
  it("splits the queue into sections in queue order, with drafts and approved PRs collapsible", () => {
    const entries = [
      { id: 40, bucket: "approval-stale", isDraft: false },
      { id: 20, bucket: "requested", isDraft: false },
      { id: 10, bucket: "requested-approved", isDraft: false },
      { id: 3, bucket: "other", isDraft: false },
      { id: 2, bucket: "approval-stale", isDraft: true },
      { id: 4, bucket: "other", isDraft: true },
      { id: 6, bucket: "approved", isDraft: false },
      { id: 7, bucket: "approved", isDraft: true },
    ] as const;
    expect(
      queueSections(entries).map((section) => [section.label, section.collapsible, section.entries.map((entry) => entry.id)]),
    ).toEqual([
      ["Approved but changed", false, [40]],
      ["Needs you", false, [20, 10]],
      ["Others", false, [3]],
      ["Drafts", true, [2, 4]],
      ["Approved, waiting on merge", true, [6, 7]],
    ]);
  });
});
