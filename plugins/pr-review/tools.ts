import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { PullReview, PullSnapshot } from "./queue.js";
import type { TicketFields } from "./store.js";

export interface RunOptions {
  cwd?: string;
  timeoutMs: number;
}

export type Runner = (command: string, args: readonly string[], options: RunOptions) => Promise<string>;

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
      finish(new Error(`${label}: ${detail}`));
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

export const OPEN_PULLS_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 100, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number title body url isDraft headRefName headRefOid baseRefName isCrossRepository additions deletions changedFiles updatedAt mergeable
        author { login avatarUrl(size: 32) }
        commits(last: 1) {
          nodes { commit { statusCheckRollup { contexts(first: 1) {
            checkRunCountsByState { state count }
            statusContextCountsByState { state count }
          } } } }
        }
        reviewRequests(first: 30) {
          nodes { requestedReviewer { __typename ... on User { login } ... on Team { combinedSlug } } }
        }
        latestReviews(first: 50) {
          nodes { author { __typename login avatarUrl(size: 32) } state submittedAt commit { oid } }
        }
      }
    }
  }
}`;

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

const openPullsSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequests: z.object({
        nodes: z.array(
          z.object({
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
          }),
        ),
      }),
    }),
  }),
});

export function parseOpenPulls(repo: string, raw: string): PullSnapshot[] {
  const parsed = openPullsSchema.parse(JSON.parse(raw));
  return parsed.data.repository.pullRequests.nodes.map((node) => {
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
    return {
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
  });
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

const pullStateSchema = z.object({ state: z.enum(["OPEN", "CLOSED", "MERGED"]), isDraft: z.boolean() });

export const PULL_STATE_FIELDS = "state,isDraft";

export function parsePullState(raw: string): "open" | "draft" | "merged" | "closed" {
  const { state, isDraft } = pullStateSchema.parse(JSON.parse(raw));
  if (state === "OPEN") return isDraft ? "draft" : "open";
  return state === "MERGED" ? "merged" : "closed";
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
