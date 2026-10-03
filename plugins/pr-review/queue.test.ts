import { describe, expect, it } from "vitest";
import { agentState, classifyPull, sortQueue, type PullReview, type PullSnapshot } from "./queue.js";

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
    headRefName: `branch-${number}`,
    headRefOid: HEAD,
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
  return { login, state, isBot, commitOid, submittedAt: "2026-10-01T00:00:00Z" };
}

function order(pulls: PullSnapshot[]): number[] {
  return sortQueue(pulls.map((entry) => ({ pull: entry, classified: classifyPull(entry, ME) }))).map(
    (entry) => entry.pull.number,
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
    expect(classified.otherReviews).toEqual([{ login: "elevin-11", state: "APPROVED" }]);
    expect(classified.otherApprovals).toBe(1);
  });

  it("marks my own PRs as author", () => {
    expect(classifyPull(pull(1, { author: "benwaffle", requestedTeams: ME.teams.slice() }), ME).me).toBe("author");
  });
});

describe("sortQueue", () => {
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

  it("puts drafts after ready PRs in a bucket, then oldest number first", () => {
    const draft = pull(1, { requestedUsers: ["benwaffle"], isDraft: true });
    const newer = pull(30, { requestedUsers: ["benwaffle"] });
    const older = pull(25, { requestedUsers: ["benwaffle"] });
    expect(order([draft, newer, older])).toEqual([25, 30, 1]);
  });
});

describe("agentState", () => {
  it("reports none, reviewing, brief ready, and follow-ups", () => {
    expect(agentState(null)).toBe("none");
    expect(agentState({ userMessageCount: 1, isRunning: true })).toBe("reviewing");
    expect(agentState({ userMessageCount: 1, isRunning: false })).toBe("brief-ready");
    expect(agentState({ userMessageCount: 2, isRunning: true })).toBe("follow-ups");
  });
});
