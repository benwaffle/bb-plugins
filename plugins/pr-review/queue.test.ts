import { describe, expect, it } from "vitest";
import { agentState, classifyPull, sortQueue, type PullReview, type PullSnapshot } from "./queue.js";

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
  return sortQueue(pulls.map((entry) => ({ pull: entry, classified: classifyPull(entry, ME) }))).map(
    (entry) => entry.pull.number,
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

describe("sortQueue", () => {
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
