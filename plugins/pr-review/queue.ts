export type ReviewState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";

export interface PullReview {
  login: string;
  isBot: boolean;
  state: ReviewState;
  submittedAt: string;
  commitOid: string | null;
}

export interface PullSnapshot {
  repo: string;
  number: number;
  title: string;
  body: string;
  url: string;
  isDraft: boolean;
  author: string;
  headRefName: string;
  headRefOid: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  updatedAt: string;
  requestedUsers: string[];
  requestedTeams: string[];
  latestReviews: PullReview[];
}

export interface Viewer {
  login: string;
  teams: readonly string[];
}

export type MyState =
  | "author"
  | "requested"
  | "approved"
  | "approved-stale"
  | "changes-requested"
  | "commented"
  | "none";

export type QueueBucket =
  | "approval-stale"
  | "requested"
  | "requested-approved"
  | "commented"
  | "other"
  | "approved";

export interface OtherReview {
  login: string;
  state: ReviewState;
}

export interface Classified {
  me: MyState;
  bucket: QueueBucket;
  otherReviews: OtherReview[];
  otherApprovals: number;
}

const BUCKET_ORDER: Record<QueueBucket, number> = {
  "approval-stale": 0,
  requested: 1,
  "requested-approved": 2,
  commented: 3,
  other: 4,
  approved: 5,
};

function sameLogin(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export function classifyPull(pull: PullSnapshot, viewer: Viewer): Classified {
  const otherReviews = pull.latestReviews
    .filter((review) => !review.isBot && !sameLogin(review.login, viewer.login))
    .filter((review) => review.state !== "PENDING")
    .map((review) => ({ login: review.login, state: review.state }));
  const otherApprovals = otherReviews.filter((review) => review.state === "APPROVED").length;
  const mine = pull.latestReviews.find(
    (review) => sameLogin(review.login, viewer.login) && review.state !== "PENDING",
  );

  const requestedByName = pull.requestedUsers.some((login) => sameLogin(login, viewer.login));
  const requestedViaTeam = pull.requestedTeams.some((team) =>
    viewer.teams.some((mineTeam) => sameLogin(mineTeam, team)),
  );
  const requested = requestedByName || (requestedViaTeam && mine === undefined);

  const me = myState(pull, viewer, mine, requested);
  return { me, bucket: bucketFor(me, otherApprovals), otherReviews, otherApprovals };
}

function myState(
  pull: PullSnapshot,
  viewer: Viewer,
  mine: PullReview | undefined,
  requested: boolean,
): MyState {
  if (sameLogin(pull.author, viewer.login)) return "author";
  if (requested) return "requested";
  switch (mine?.state) {
    case "APPROVED":
      return mine.commitOid === pull.headRefOid ? "approved" : "approved-stale";
    case "CHANGES_REQUESTED":
      return "changes-requested";
    case "COMMENTED":
      return "commented";
    case "DISMISSED":
    case "PENDING":
    case undefined:
      return "none";
  }
}

function bucketFor(me: MyState, otherApprovals: number): QueueBucket {
  switch (me) {
    case "approved-stale":
      return "approval-stale";
    case "requested":
      return otherApprovals === 0 ? "requested" : "requested-approved";
    case "changes-requested":
    case "commented":
      return "commented";
    case "approved":
      return "approved";
    case "author":
    case "none":
      return "other";
  }
}

export function compareQueueEntries(
  left: { pull: PullSnapshot; classified: Classified },
  right: { pull: PullSnapshot; classified: Classified },
): number {
  return (
    BUCKET_ORDER[left.classified.bucket] - BUCKET_ORDER[right.classified.bucket] ||
    Number(left.pull.isDraft) - Number(right.pull.isDraft) ||
    left.pull.repo.localeCompare(right.pull.repo) ||
    left.pull.number - right.pull.number
  );
}

export function sortQueue<T extends { pull: PullSnapshot; classified: Classified }>(
  entries: readonly T[],
): T[] {
  return [...entries].sort(compareQueueEntries);
}

export type AgentState = "none" | "reviewing" | "brief-ready" | "follow-ups";

export function agentState(thread: {
  userMessageCount: number;
  isRunning: boolean;
} | null): AgentState {
  if (thread === null) return "none";
  if (thread.userMessageCount > 1) return "follow-ups";
  return thread.isRunning ? "reviewing" : "brief-ready";
}
