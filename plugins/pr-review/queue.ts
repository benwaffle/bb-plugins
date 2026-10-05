export type ReviewState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";

export interface PullReview {
  login: string;
  avatarUrl: string | null;
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
  authorAvatarUrl: string | null;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  isCrossRepository: boolean;
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
  avatarUrl: string | null;
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
    .map((review) => ({ login: review.login, avatarUrl: review.avatarUrl, state: review.state }));
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

export function pullKey(repo: string, number: number): string {
  return `${repo}#${number}`;
}

export interface StackLink {
  parentNumber: number | null;
  depth: number;
  childNumbers: number[];
}

/**
 * Where each open PR sits in a stack, keyed by `owner/repo#n`. A PR's parent
 * is the open PR in the same repository whose head branch is its base branch;
 * a PR whose head is in a fork is never a parent. When several open PRs share
 * that head branch, the lowest number is the parent. A PR whose base PR merged
 * or closed is a root.
 */
export function stackLinks(
  pulls: readonly Pick<PullSnapshot, "repo" | "number" | "headRefName" | "baseRefName" | "isCrossRepository">[],
): Map<string, StackLink> {
  const byHead = new Map<string, number>();
  for (const pull of [...pulls].sort((left, right) => right.number - left.number)) {
    if (!pull.isCrossRepository) byHead.set(`${pull.repo}\0${pull.headRefName}`, pull.number);
  }
  const parents = new Map<string, number>();
  for (const pull of pulls) {
    const parent = byHead.get(`${pull.repo}\0${pull.baseRefName}`);
    if (parent !== undefined && parent !== pull.number) parents.set(pullKey(pull.repo, pull.number), parent);
  }
  // Two PRs can each target the other's head branch; cut such a cycle at the
  // first of its PRs in `pulls`.
  for (const pull of pulls) {
    const key = pullKey(pull.repo, pull.number);
    const seen = new Set([key]);
    for (let parent = parents.get(key); parent !== undefined; ) {
      const parentKey = pullKey(pull.repo, parent);
      if (parentKey === key) parents.delete(key);
      if (seen.has(parentKey)) break;
      seen.add(parentKey);
      parent = parents.get(parentKey);
    }
  }
  const links = new Map<string, StackLink>();
  for (const pull of pulls) {
    const key = pullKey(pull.repo, pull.number);
    let depth = 0;
    for (let at = parents.get(key); at !== undefined; at = parents.get(pullKey(pull.repo, at))) depth++;
    links.set(key, { parentNumber: parents.get(key) ?? null, depth, childNumbers: [] });
  }
  for (const pull of [...pulls].sort((left, right) => left.number - right.number)) {
    const parent = parents.get(pullKey(pull.repo, pull.number));
    if (parent !== undefined) links.get(pullKey(pull.repo, parent))?.childNumbers.push(pull.number);
  }
  return links;
}

/**
 * `items` reordered so each item's stack dependents follow it directly, in
 * their order in `items`. An item whose parent is not in `items` keeps its
 * place. `parentKeyOf` must not form cycles, which `stackLinks` guarantees.
 */
export function stackOrder<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  parentKeyOf: (item: T) => string | null,
): T[] {
  const present = new Set(items.map(keyOf));
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const item of items) {
    const parent = parentKeyOf(item);
    if (parent === null || !present.has(parent)) {
      roots.push(item);
      continue;
    }
    const siblings = children.get(parent) ?? [];
    siblings.push(item);
    children.set(parent, siblings);
  }
  const ordered: T[] = [];
  const visit = (item: T) => {
    ordered.push(item);
    for (const child of children.get(keyOf(item)) ?? []) visit(child);
  };
  for (const root of roots) visit(root);
  return ordered;
}

type Ranked = { pull: PullSnapshot; classified: Classified };

function comparePriority(left: Ranked, right: Ranked): number {
  return (
    Number(left.classified.bucket === "approved") - Number(right.classified.bucket === "approved") ||
    Number(left.pull.isDraft) - Number(right.pull.isDraft) ||
    BUCKET_ORDER[left.classified.bucket] - BUCKET_ORDER[right.classified.bucket]
  );
}

function compareQueueEntries(left: Ranked, right: Ranked): number {
  return (
    comparePriority(left, right) ||
    left.pull.repo.localeCompare(right.pull.repo) ||
    left.pull.number - right.pull.number
  );
}

/**
 * Entries in review order. Inside a run of equal priority, a stacked PR
 * follows its base PR directly.
 */
export function sortQueue<T extends Ranked>(
  entries: readonly T[],
  links: ReadonlyMap<string, StackLink>,
): T[] {
  const runs: T[][] = [];
  for (const entry of [...entries].sort(compareQueueEntries)) {
    const run = runs.at(-1);
    if (run !== undefined && comparePriority(run[0]!, entry) === 0) run.push(entry);
    else runs.push([entry]);
  }
  return runs.flatMap((run) =>
    stackOrder(
      run,
      ({ pull }) => pullKey(pull.repo, pull.number),
      ({ pull }) => {
        const parent = links.get(pullKey(pull.repo, pull.number))?.parentNumber ?? null;
        return parent === null ? null : pullKey(pull.repo, parent);
      },
    ),
  );
}

export type AgentState = "none" | "opened" | "reviewing" | "brief-ready" | "follow-ups";

/**
 * A review thread opens with one context message and runs the review only when
 * a later message starts with `reviewCommand`. Messages after the last review
 * request are follow-ups.
 */
export function agentState(
  thread: { userMessages: readonly string[]; isRunning: boolean } | null,
  reviewCommand: string,
): AgentState {
  if (thread === null) return "none";
  const { userMessages } = thread;
  const lastReview = userMessages.map((message) => message.startsWith(reviewCommand)).lastIndexOf(true);
  if (lastReview === -1) return userMessages.length > 1 ? "follow-ups" : "opened";
  if (lastReview < userMessages.length - 1) return "follow-ups";
  return thread.isRunning ? "reviewing" : "brief-ready";
}
