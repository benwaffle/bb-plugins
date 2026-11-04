import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { pullKey, type PullReview, type PullSnapshot } from "./queue.js";
import type { TicketFields } from "./store.js";

export interface RunOptions {
  cwd?: string;
  timeoutMs: number;
}

export type Runner = (command: string, args: readonly string[], options: RunOptions) => Promise<string>;

/** A command that exited non-zero, with what it printed to stdout. */
export class CommandError extends Error {
  constructor(
    message: string,
    readonly stdout: string,
  ) {
    super(message);
  }
}

const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/**
 * Runs `command` in its own process group with stdin closed. When
 * `timeoutMs` passes, or stdout outgrows `MAX_OUTPUT_BYTES`, the whole group
 * is sent SIGKILL and the promise rejects at once, without waiting for
 * grandchildren that still hold the output pipes.
 */
export const runCommand: Runner = (command, args, options) =>
  new Promise((resolve, reject) => {
    const label = `${command} ${args.slice(0, 3).join(" ")}`;
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;

    const killGroup = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === null) resolve(Buffer.concat(stdout).toString("utf8"));
      else reject(error);
    };
    const timer = setTimeout(() => {
      killGroup();
      finish(new Error(`${label}: timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        killGroup();
        finish(new Error(`${label}: output exceeded ${MAX_OUTPUT_BYTES} bytes`));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => finish(new Error(`${label}: ${error.message}`)));
    child.on("close", (code, signal) => {
      if (code === 0) {
        finish(null);
        return;
      }
      const detail = Buffer.concat(stderr).toString("utf8").trim() || `exited with ${code ?? signal}`;
      finish(new CommandError(`${label}: ${detail}`, Buffer.concat(stdout).toString("utf8")));
    });
  });

const TOOL_CANDIDATES: Record<"gh" | "twg", string[]> = {
  gh: ["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh"],
  twg: ["twg", join(homedir(), ".local/bin/twg"), "/opt/homebrew/bin/twg", "/usr/local/bin/twg"],
};

export function createToolResolver(run: Runner) {
  const resolved = new Map<string, Promise<string | null>>();
  return (tool: "gh" | "twg"): Promise<string | null> => {
    let pending = resolved.get(tool);
    if (pending === undefined) {
      pending = (async () => {
        for (const candidate of TOOL_CANDIDATES[tool]) {
          try {
            await run(candidate, ["--version"], { timeoutMs: 10_000 });
            return candidate;
          } catch {
            continue;
          }
        }
        return null;
      })();
      resolved.set(tool, pending);
    }
    return pending;
  };
}

/**
 * The head commit's check rollup state. GitHub can answer a different state
 * for the same commit when `statusCheckRollup` also selects `contexts`, so
 * every query reads the state through this one selection, under its own alias.
 */
const HEAD_ROLLUP_FIELD = "headRollup: commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }";

/** The fields of a PR that the review queue shows. */
const PULL_FIELDS = `number title body url isDraft headRefName headRefOid baseRefName isCrossRepository additions deletions changedFiles updatedAt mergeable
        author { login avatarUrl(size: 32) }
        commits(last: 1) {
          nodes { commit { statusCheckRollup { contexts(first: 1) {
            checkRunCountsByState { state count }
            statusContextCountsByState { state count }
          } } } }
        }
        ${HEAD_ROLLUP_FIELD}
        reviewRequests(first: 30) {
          nodes { requestedReviewer { __typename ... on User { login } ... on Team { combinedSlug } } }
        }
        latestReviews(first: 50) {
          nodes { author { __typename login avatarUrl(size: 32) } state submittedAt commit { oid } }
        }`;

/** The fields of a PR that change when anything `PULL_FIELDS` reads changes, except check counts within one rollup state. */
const PULL_HEAD_FIELDS = `number updatedAt headRefOid mergeable
        ${HEAD_ROLLUP_FIELD}`;

function openPullsPageQuery(fields: string): string {
  return `query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 100, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        ${fields}
      }
    }
  }
}`;
}

/** One page of a repository's open PRs, most recently updated first, with every field the queue shows. */
export const OPEN_PULLS_QUERY = openPullsPageQuery(PULL_FIELDS);

/** One page of a repository's open PRs, in `OPEN_PULLS_QUERY` order, with only the fields that tell whether a PR changed. */
export const OPEN_PULL_HEADS_QUERY = openPullsPageQuery(PULL_HEAD_FIELDS);

export interface PullRef {
  repo: string;
  number: number;
}

const repoAlias = (index: number) => `r${index}`;
const pullAlias = (number: number) => `p${number}`;

/**
 * One query for `pulls`: an aliased `repository` per repo, one line each,
 * with an aliased `pullRequest` per number reading `fields` and `state`.
 */
function pullLookupQuery(pulls: readonly PullRef[], fields: string): string {
  const byRepo = new Map<string, Set<number>>();
  for (const pull of pulls) byRepo.set(pull.repo, (byRepo.get(pull.repo) ?? new Set()).add(pull.number));
  const selection = fields.replace(/\s+/g, " ");
  const lines = [...byRepo].map(([repo, numbers], index) => {
    const [owner, name] = repo.split("/");
    const lookups = [...numbers]
      .map((number) => `${pullAlias(number)}: pullRequest(number: ${number}) { state ${selection} }`)
      .join(" ");
    return `  ${repoAlias(index)}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${lookups} }`;
  });
  return `query {\n${lines.join("\n")}\n}`;
}

/** The query `parsePullStates` reads: the state and draft flag of each of `pulls`. */
export function pullStatesQuery(pulls: readonly PullRef[]): string {
  return pullLookupQuery(pulls, "isDraft");
}

/** The query `parsePullDetails` reads: the state and every queue field of each of `pulls`. */
export function pullDetailsQuery(pulls: readonly PullRef[]): string {
  return pullLookupQuery(pulls, PULL_FIELDS);
}

const lookupSchema = z.object({
  data: z.record(z.string(), z.record(z.string(), z.unknown()).nullable()),
});

/**
 * Whether `raw` is a GraphQL answer with data, which GitHub sends alongside
 * errors for the PRs and repositories a lookup names but cannot resolve.
 */
export function hasLookupData(raw: string): boolean {
  try {
    return lookupSchema.safeParse(JSON.parse(raw)).success;
  } catch {
    return false;
  }
}

/**
 * The node `pullLookupQuery` returned for each of `pulls`, by `pullKey`, as
 * parsed by `node`. A PR GitHub could not resolve is null.
 */
function parsePullLookup<T>(raw: string, pulls: readonly PullRef[], node: (value: unknown) => T): Map<string, T | null> {
  const { data } = lookupSchema.parse(JSON.parse(raw));
  const repos = [...new Set(pulls.map((pull) => pull.repo))];
  const found = new Map<string, T | null>();
  for (const pull of pulls) {
    const value = data[repoAlias(repos.indexOf(pull.repo))]?.[pullAlias(pull.number)];
    found.set(pullKey(pull.repo, pull.number), value === undefined || value === null ? null : node(value));
  }
  return found;
}

const reviewerSchema = z
  .object({ __typename: z.string(), login: z.string().optional(), combinedSlug: z.string().optional() })
  .nullable();

const countsByStateSchema = z.array(z.object({ state: z.string(), count: z.number() }));

/** Check run and commit status states that count as a failing check. */
const FAILING_CHECK_STATES = new Set([
  "ACTION_REQUIRED",
  "CANCELLED",
  "ERROR",
  "FAILURE",
  "STARTUP_FAILURE",
  "TIMED_OUT",
]);

function failingCount(counts: z.infer<typeof countsByStateSchema>): number {
  return counts.reduce((sum, { state, count }) => sum + (FAILING_CHECK_STATES.has(state) ? count : 0), 0);
}

const headRollupSchema = z.object({
  headRollup: z.object({
    nodes: z.array(z.object({ commit: z.object({ statusCheckRollup: z.object({ state: z.string() }).nullable() }) })),
  }),
});

const pullHeadSchema = z
  .object({ number: z.number(), updatedAt: z.string(), headRefOid: z.string(), mergeable: z.string() })
  .and(headRollupSchema);

/** A string that changes when a PR's `OPEN_PULL_HEADS_QUERY` fields change. */
function headFingerprint(head: z.infer<typeof pullHeadSchema>): string {
  const rollup = head.headRollup.nodes.at(-1)?.commit.statusCheckRollup?.state ?? "NONE";
  return [head.updatedAt, head.headRefOid, head.mergeable, rollup].join(" ");
}

const pullNodeSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string(),
  url: z.string(),
  isDraft: z.boolean(),
  headRefName: z.string(),
  headRefOid: z.string(),
  baseRefName: z.string(),
  isCrossRepository: z.boolean(),
  additions: z.number(),
  deletions: z.number(),
  changedFiles: z.number(),
  updatedAt: z.string(),
  mergeable: z.string(),
  author: z.object({ login: z.string(), avatarUrl: z.string() }).nullable(),
  commits: z.object({
    nodes: z.array(
      z.object({
        commit: z.object({
          statusCheckRollup: z
            .object({
              contexts: z.object({
                checkRunCountsByState: countsByStateSchema,
                statusContextCountsByState: countsByStateSchema,
              }),
            })
            .nullable(),
        }),
      }),
    ),
  }),
  headRollup: headRollupSchema.shape.headRollup,
  reviewRequests: z.object({
    nodes: z.array(z.object({ requestedReviewer: reviewerSchema })),
  }),
  latestReviews: z.object({
    nodes: z.array(
      z.object({
        author: z.object({ __typename: z.string(), login: z.string(), avatarUrl: z.string() }).nullable(),
        state: z.enum(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]),
        submittedAt: z.string().nullable(),
        commit: z.object({ oid: z.string() }).nullable(),
      }),
    ),
  }),
});

/** An open PR as the queue shows it, and the fingerprint `parseOpenPullHeads` gives it. */
export interface FingerprintedPull {
  pull: PullSnapshot;
  fingerprint: string;
}

function toSnapshot(repo: string, node: z.infer<typeof pullNodeSchema>): FingerprintedPull {
  const reviewers = node.reviewRequests.nodes.map((request) => request.requestedReviewer);
  const latestReviews: PullReview[] = node.latestReviews.nodes.flatMap((review) =>
    review.author === null
      ? []
      : [
          {
            login: review.author.login,
            avatarUrl: review.author.avatarUrl,
            isBot: review.author.__typename === "Bot",
            state: review.state,
            submittedAt: review.submittedAt ?? "",
            commitOid: review.commit?.oid || null,
          },
        ],
  );
  const checks = node.commits.nodes.at(-1)?.commit.statusCheckRollup?.contexts;
  const pull: PullSnapshot = {
    repo,
    number: node.number,
    title: node.title,
    body: node.body,
    url: node.url,
    isDraft: node.isDraft,
    author: node.author?.login ?? "ghost",
    authorAvatarUrl: node.author?.avatarUrl ?? null,
    headRefName: node.headRefName,
    headRefOid: node.headRefOid,
    baseRefName: node.baseRefName,
    isCrossRepository: node.isCrossRepository,
    additions: node.additions,
    deletions: node.deletions,
    changedFiles: node.changedFiles,
    updatedAt: node.updatedAt,
    conflicting: node.mergeable === "CONFLICTING",
    failingChecks:
      checks === undefined
        ? 0
        : failingCount(checks.checkRunCountsByState) + failingCount(checks.statusContextCountsByState),
    requestedUsers: reviewers.flatMap((reviewer) =>
      reviewer?.__typename === "User" && reviewer.login !== undefined ? [reviewer.login] : [],
    ),
    requestedTeams: reviewers.flatMap((reviewer) =>
      reviewer?.__typename === "Team" && reviewer.combinedSlug !== undefined
        ? [reviewer.combinedSlug]
        : [],
    ),
    latestReviews,
  };
  return { pull, fingerprint: headFingerprint(node) };
}

function openPullsPageSchema<T extends z.ZodType>(node: T) {
  return z.object({
    data: z.object({
      repository: z.object({
        pullRequests: z.object({
          pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
          nodes: z.array(node),
        }),
      }),
    }),
  });
}

const openPullsSchema = openPullsPageSchema(pullNodeSchema);
const openPullHeadsSchema = openPullsPageSchema(pullHeadSchema);

export interface Page<T> {
  items: T[];
  /** The cursor of the next page, or null on the last page. */
  next: string | null;
}

function nextCursor(pageInfo: { hasNextPage: boolean; endCursor: string | null }): string | null {
  return pageInfo.hasNextPage ? pageInfo.endCursor : null;
}

/** One page of `OPEN_PULLS_QUERY`. */
export function parseOpenPulls(repo: string, raw: string): Page<FingerprintedPull> {
  const { pullRequests } = openPullsSchema.parse(JSON.parse(raw)).data.repository;
  return { items: pullRequests.nodes.map((node) => toSnapshot(repo, node)), next: nextCursor(pullRequests.pageInfo) };
}

/** One page of `OPEN_PULL_HEADS_QUERY`: each PR's number and fingerprint. */
export function parseOpenPullHeads(raw: string): Page<{ number: number; fingerprint: string }> {
  const { pullRequests } = openPullHeadsSchema.parse(JSON.parse(raw)).data.repository;
  return {
    items: pullRequests.nodes.map((node) => ({ number: node.number, fingerprint: headFingerprint(node) })),
    next: nextCursor(pullRequests.pageInfo),
  };
}

const pullStateSchema = z.object({ state: z.enum(["OPEN", "CLOSED", "MERGED"]), isDraft: z.boolean() });

export type PullState = "open" | "draft" | "merged" | "closed";

function toPullState({ state, isDraft }: z.infer<typeof pullStateSchema>): PullState {
  if (state === "OPEN") return isDraft ? "draft" : "open";
  return state === "MERGED" ? "merged" : "closed";
}

/** The state of each of `pulls` from `pullStatesQuery`, by `pullKey`; null for a PR GitHub could not resolve. */
export function parsePullStates(raw: string, pulls: readonly PullRef[]): Map<string, PullState | null> {
  return parsePullLookup(raw, pulls, (value) => toPullState(pullStateSchema.parse(value)));
}

/**
 * Each of `pulls` from `pullDetailsQuery`, by `pullKey`, as the queue shows
 * it; null for a PR that is no longer open or that GitHub could not resolve.
 */
export function parsePullDetails(raw: string, pulls: readonly PullRef[]): Map<string, FingerprintedPull | null> {
  const repoOf = new Map(pulls.map((pull) => [pullKey(pull.repo, pull.number), pull.repo]));
  const details = parsePullLookup(raw, pulls, (value) => {
    const node = pullNodeSchema.and(z.object({ state: z.string() })).parse(value);
    return node.state === "OPEN" ? node : null;
  });
  return new Map(
    [...details].map(([key, node]) => [key, node === null ? null : toSnapshot(repoOf.get(key)!, node)]),
  );
}

export const PULL_VIEW_FIELDS = [
  "number",
  "title",
  "body",
  "headRefName",
  "url",
  "reviews",
  "reviewDecision",
  "latestReviews",
  "isCrossRepository",
  "state",
] as const;

const pullViewSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string(),
  headRefName: z.string(),
  url: z.string(),
  reviewDecision: z.string(),
  isCrossRepository: z.boolean(),
  state: z.string(),
});
export type PullView = z.infer<typeof pullViewSchema>;

export function parsePullView(raw: string): PullView {
  return pullViewSchema.parse(JSON.parse(raw));
}

const pullListSchema = z.array(
  z.object({ number: z.number(), title: z.string(), url: z.string() }),
);
export type PullListItem = z.infer<typeof pullListSchema>[number];

export function parsePullList(raw: string): PullListItem[] {
  return pullListSchema.parse(JSON.parse(raw));
}

const issueViewSchema = z.object({ title: z.string() });

export function parseIssueTitle(raw: string): string {
  return issueViewSchema.parse(JSON.parse(raw)).title;
}

const twgFieldsSchema = z.object({
  key: z.string(),
  summary: z.string().nullable().optional(),
  status: z.object({ name: z.string() }).nullable().optional(),
});

/**
 * `twg jira workitem get` prints `data` as an array of work items for one key,
 * and as `items` with a per-key `ok` flag for several keys.
 */
const twgWorkItemsSchema = z.object({
  data: z.union([
    z.array(twgFieldsSchema),
    z.object({
      items: z.array(z.object({ input: z.string(), ok: z.boolean(), data: twgFieldsSchema.optional() })),
    }),
  ]),
});

/** Summary and status by requested key, for the keys twg resolved. */
export function parseTwgWorkItems(raw: string): Map<string, TicketFields> {
  const { data } = twgWorkItemsSchema.parse(JSON.parse(raw));
  const resolved = Array.isArray(data)
    ? data.map((item) => [item.key, item] as const)
    : data.items.flatMap((item) => (item.ok && item.data !== undefined ? [[item.input, item.data] as const] : []));
  return new Map(
    resolved.map(([key, item]) => [key, { summary: item.summary ?? null, status: item.status?.name ?? null }]),
  );
}
