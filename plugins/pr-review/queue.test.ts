import { describe, expect, it } from "vitest";
import {
  agentState,
  classifyPull,
  sortQueue,
  stackLinks,
  type PullReview,
  type PullSnapshot,
} from "./queue.js";

const ME = { login: "benwaffle", teams: ["private-tech-inc/network-services"] };
const HEAD = "head-oid";

function pull(number: number, overrides: Partial<PullSnapshot> = {}): PullSnapshot {
  return {
    repo: "private-tech-inc/hss",
    number,
    title: `PR ${number}`,
    body: "",
    url: `https://github.com/private-tech-inc/hss/pull/${number}`,
    isDraft: false,
    author: "meisbobzheng",
    authorAvatarUrl: null,
    headRefName: `branch-${number}`,
    headRefOid: HEAD,
    baseRefName: "main",
    isCrossRepository: false,
    additions: 10,
    deletions: 2,
    changedFiles: 1,
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
    const viaTeam = pull(1, { requestedTeams: ["private-tech-inc/network-services"] });
    expect(classifyPull(viaTeam, ME).me).toBe("requested");
    const reviewed = pull(2, {
      requestedTeams: ["private-tech-inc/network-services"],
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
          review("elevin-11", "APPROVED"),
        ],
      }),
      ME,
    );
    expect(classified.otherReviews).toEqual([
      { login: "elevin-11", avatarUrl: "https://avatars.example/elevin-11", state: "APPROVED" },
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
        pull(552, { repo: "private-tech-inc/web" }),
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
      latestReviews: [review("elevin-11", "APPROVED")],
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

describe("agentState", () => {
  const COMMAND = "/tncqr review pr";
  const state = (userMessages: string[], isRunning: boolean) => agentState({ userMessages, isRunning }, COMMAND);

  it("reports a thread with only its context message as opened, running or not", () => {
    expect(agentState(null, COMMAND)).toBe("none");
    expect(state(["Review context"], true)).toBe("opened");
    expect(state(["Review context"], false)).toBe("opened");
  });

  it("reports reviewing, then brief ready, once the review command is sent", () => {
    expect(state(["Review context", `${COMMAND} 596`], true)).toBe("reviewing");
    expect(state(["Review context", `${COMMAND} 596`], false)).toBe("brief-ready");
  });

  it("reports follow-ups for messages after the context or the last review", () => {
    expect(state(["Review context", "What does this change do?"], false)).toBe("follow-ups");
    expect(state(["Review context", `${COMMAND} 596`, "Fix the first finding"], true)).toBe("follow-ups");
    expect(state(["Review context", `${COMMAND} 596`, "Why?", `${COMMAND} 596`], true)).toBe("reviewing");
  });
});
