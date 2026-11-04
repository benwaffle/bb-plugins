import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REVIEW_COMMAND, createPlugin } from "./server.js";
import { createRefStore } from "./store.js";
import { CommandError, type RunOptions } from "./tools.js";

const REPO = "acme/widgets";
const OTHER_REPO = "acme/gadgets";
const START = Date.parse("2026-10-04T09:00:00Z");

interface Review {
  login: string;
  state: string;
  oid: string;
}

function pullNode(
  repo: string,
  number: number,
  title: string,
  options: { author?: string; body?: string; base?: string; draft?: boolean; reviews?: Review[]; failing?: number } = {},
) {
  return {
    number,
    title,
    body: options.body ?? "",
    url: `https://github.com/${repo}/pull/${number}`,
    isDraft: options.draft ?? false,
    headRefName: `branch-${number}`,
    headRefOid: `oid-${number}`,
    baseRefName: options.base ?? "main",
    isCrossRepository: false,
    additions: number % 50,
    deletions: number % 7,
    changedFiles: number % 5,
    updatedAt: "2026-10-01T00:00:00Z",
    mergeable: "MERGEABLE",
    author: { login: options.author ?? "bob", avatarUrl: `https://avatars.githubusercontent.com/${options.author ?? "bob"}` },
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              contexts: {
                checkRunCountsByState: [
                  { state: "SUCCESS", count: 3 },
                  { state: "FAILURE", count: options.failing ?? 0 },
                ],
                statusContextCountsByState: [],
              },
            },
          },
        },
      ],
    },
    headRollup: { nodes: [{ commit: { statusCheckRollup: { state: (options.failing ?? 0) > 0 ? "FAILURE" : "SUCCESS" } } }] },
    reviewRequests: {
      nodes: [{ requestedReviewer: { __typename: "Team", combinedSlug: "acme/platform" } }],
    },
    latestReviews: {
      nodes: (options.reviews ?? []).map((review) => ({
        author: { __typename: "User", login: review.login, avatarUrl: `https://avatars.githubusercontent.com/${review.login}` },
        state: review.state,
        submittedAt: "2026-10-02T00:00:00Z",
        commit: { oid: review.oid },
      })),
    },
  };
}

type PullNode = ReturnType<typeof pullNode>;

const OPEN: PullNode[] = [
  pullNode(REPO, 596, "ACME-51: Cache the widget catalog per tenant", { body: "Fixes #12" }),
  pullNode(REPO, 599, "Evict the old catalog entry", { body: "ACME-51\n\nFollow-up.", base: "branch-596", failing: 2 }),
  pullNode(REPO, 590, "Run the review workflow"),
  pullNode(REPO, 610, "ACME-52: Log catalog misses", { author: "benwaffle" }),
  pullNode(REPO, 620, "ACME-52: Price rounding", {
    author: "carol",
    reviews: [{ login: "benwaffle", state: "APPROVED", oid: "oid-620" }],
  }),
  pullNode(REPO, 630, "ACME-53: Draft the pricing API", { author: "carol", draft: true }),
  pullNode(REPO, 640, "ACME-53: Rename the pricing table", {
    author: "dave",
    reviews: [{ login: "carol", state: "CHANGES_REQUESTED", oid: "oid-640" }],
  }),
];

/** PRs that are not open in a configured repository, by `owner/repo#n`, with their GitHub state. */
const ELSEWHERE = new Map<string, { state: "OPEN" | "MERGED" | "CLOSED"; isDraft: boolean }>([
  [`${REPO}#534`, { state: "MERGED", isDraft: false }],
  [`${REPO}#541`, { state: "CLOSED", isDraft: false }],
  [`${OTHER_REPO}#77`, { state: "OPEN", isDraft: true }],
  [`${OTHER_REPO}#78`, { state: "OPEN", isDraft: false }],
]);

const JIRA = new Map([
  ["ACME-51", { summary: "Cache the widget catalog", status: "In Progress" }],
  ["ACME-52", { summary: "Price rounding", status: "To Do" }],
  ["ACME-53", { summary: "Pricing API", status: "Done" }],
]);

function twgWorkItems(keys: readonly string[]): string {
  return JSON.stringify({
    data: {
      items: keys.map((key) => {
        const fields = JIRA.get(key);
        return fields === undefined
          ? { input: key, ok: false, error: { message: "Issue does not exist", status: 404 } }
          : { input: key, ok: true, data: { key, summary: fields.summary, status: { name: fields.status } } };
      }),
    },
  });
}

/** One aliased `repository { pullRequest }` lookup per line, answered from `OPEN` and `ELSEWHERE`; unknown PRs are null with an error. */
function aliasedPulls(query: string): { stdout: string; failed: boolean } {
  const data: Record<string, Record<string, unknown>> = {};
  const errors: unknown[] = [];
  for (const match of query.matchAll(/(\w+): repository\(owner: "([^"]+)", name: "([^"]+)"\) \{(.*)\}/g)) {
    const [, repoAlias, owner, name, body] = match as unknown as [string, string, string, string, string];
    const repo = `${owner}/${name}`;
    const pulls: Record<string, unknown> = {};
    for (const pull of body.matchAll(/(\w+): pullRequest\(number: (\d+)\)/g)) {
      const [, alias, number] = pull as unknown as [string, string, string];
      const open = repo === REPO ? OPEN.find((node) => node.number === Number(number)) : undefined;
      const elsewhere = ELSEWHERE.get(`${repo}#${number}`);
      if (open !== undefined) pulls[alias] = { ...open, state: "OPEN" };
      else if (elsewhere !== undefined) pulls[alias] = elsewhere;
      else {
        pulls[alias] = null;
        errors.push({ type: "NOT_FOUND", path: [repoAlias, alias] });
      }
    }
    data[repoAlias] = pulls;
  }
  return { stdout: JSON.stringify(errors.length === 0 ? { data } : { data, errors }), failed: errors.length > 0 };
}

/** Open PRs per GraphQL page, so a read of `OPEN` takes several pages. */
const PAGE_SIZE = 3;

function fakeRunner() {
  const calls: string[] = [];
  const github = { rateLimited: false };
  const run = async (command: string, args: readonly string[], _options: RunOptions): Promise<string> => {
    if (args[0] === "--version") return "1.0\n";
    const line = [command, ...args].join(" ");
    calls.push(line);
    if (line.startsWith("gh api user --jq")) return "benwaffle\n";
    if (line.startsWith("gh api user/teams")) return "acme/platform\n";
    if (line.startsWith("gh api graphql")) {
      const query = args.find((arg) => arg.startsWith("query="))!.slice("query=".length);
      if (query.includes("pullRequests(states: OPEN")) {
        const cursor = args.find((arg) => arg.startsWith("cursor="));
        const start = cursor === undefined ? 0 : Number(cursor.slice("cursor=".length));
        const end = start + PAGE_SIZE;
        const pageInfo = { hasNextPage: end < OPEN.length, endCursor: end < OPEN.length ? String(end) : null };
        return JSON.stringify({ data: { repository: { pullRequests: { pageInfo, nodes: OPEN.slice(start, end) } } } });
      }
      if (github.rateLimited) {
        throw new CommandError("gh api graphql: API rate limit exceeded", JSON.stringify({ data: null, errors: [{ type: "RATE_LIMITED" }] }));
      }
      const { stdout, failed } = aliasedPulls(query);
      if (failed) throw new CommandError("gh api graphql: Could not resolve to a PullRequest", stdout);
      return stdout;
    }
    const view = /^gh pr view (\d+) -R (\S+) --json state,isDraft$/.exec(line);
    if (view !== null) {
      const state = ELSEWHERE.get(`${view[2]}#${view[1]}`);
      if (state === undefined) throw new Error(`gh pr view ${view[1]}: Could not resolve to a PullRequest`);
      return JSON.stringify(state);
    }
    if (line.startsWith("twg jira workitem get ")) return twgWorkItems(args.slice(3, args.indexOf("-o")));
    throw new Error(`unexpected command: ${line}`);
  };
  return { calls, run, github };
}

interface FakeThread {
  id: string;
  status: string;
  title: string | null;
  deleted: boolean;
  messages: Array<{ createdAt: number; text: string }>;
}

const THREADS: FakeThread[] = [
  { id: "thr_596", status: "idle", title: "#596 Cache", deleted: false, messages: [{ createdAt: 10, text: "Review context" }, { createdAt: 20, text: `${REVIEW_COMMAND} 596` }] },
  { id: "thr_590", status: "active", title: "#590 Run", deleted: false, messages: [{ createdAt: 10, text: "Review context" }] },
  { id: "thr_630", status: "idle", title: "#630 Draft", deleted: false, messages: [{ createdAt: 10, text: "Review context" }, { createdAt: 20, text: `${REVIEW_COMMAND} 630` }, { createdAt: 30, text: "Why?" }] },
  { id: "thr_640", status: "active", title: "#640 Rename", deleted: false, messages: [{ createdAt: 10, text: "Review context" }, { createdAt: 20, text: `${REVIEW_COMMAND} 640` }] },
  { id: "thr_534", status: "idle", title: "#534 Drop the old cache", deleted: false, messages: [{ createdAt: 10, text: `${REVIEW_COMMAND} 534` }] },
  { id: "thr_541", status: "idle", title: "#541 Closed", deleted: true, messages: [] },
  { id: "thr_77", status: "idle", title: "#77 Gadgets", deleted: false, messages: [{ createdAt: 10, text: "Review context" }] },
  { id: "thr_78", status: "starting", title: "#78 Gadgets", deleted: false, messages: [] },
  { id: "thr_404", status: "idle", title: "#404 Gone", deleted: false, messages: [] },
  { id: "thr_notes", status: "idle", title: "Plan ACME-51", deleted: false, messages: [{ createdAt: 10, text: "Plan it" }] },
];

const ref = (repo: string, number: number, source: "review-target" | "environment" | "sibling" = "review-target") => ({
  kind: "gh-pr" as const,
  key: `${repo}#${number}`,
  url: `https://github.com/${repo}/pull/${number}`,
  title: `PR ${number}`,
  source,
});
const ticket = (key: string) => ({ kind: "jira" as const, key, url: `https://example.atlassian.net/browse/${key}`, title: null, source: "title" as const });

/** Thread refs in recording order. */
const REFS: Array<[string, ReturnType<typeof ref | typeof ticket>[]]> = [
  ["thr_596", [ref(REPO, 596), ticket("ACME-51"), ref(REPO, 599, "sibling")]],
  ["thr_590", [ref(REPO, 590)]],
  ["thr_630", [ref(REPO, 630), ticket("ACME-53")]],
  ["thr_640", [ref(REPO, 640, "environment"), ticket("ACME-53")]],
  ["thr_534", [ticket("ACME-51"), ref(REPO, 534)]],
  ["thr_541", [ticket("ACME-53"), ref(REPO, 541)]],
  ["thr_77", [ticket("ACME-52"), ref(OTHER_REPO, 77)]],
  ["thr_78", [ticket("ACME-52"), ref(OTHER_REPO, 78, "environment")]],
  ["thr_404", [ticket("ACME-52"), ref(REPO, 404)]],
  ["thr_notes", [ticket("ACME-51")]],
  ["thr_unknown", [ticket("ACME-99")]],
];

async function load() {
  const runner = fakeRunner();
  const host = createFakePluginHost({
    pluginId: "pr-review",
    settings: { repos: REPO, jiraProjectKeys: "ACME", jiraSite: "https://example.atlassian.net" },
  });
  const byId = new Map(THREADS.map((thread) => [thread.id, thread]));
  const response = (thread: FakeThread) => ({
    id: thread.id,
    environmentId: `env_${thread.id}`,
    status: thread.status,
    title: thread.title,
    titleFallback: null,
    deletedAt: thread.deleted ? START : null,
    updatedAt: Math.max(1, ...thread.messages.map((message) => message.createdAt)),
  });
  const sdk = host.harness.sdk;
  sdk.stub("projects.list", async () => [
    { id: "proj_widgets", name: "widgets", gitRemoteUrl: "git@github.com:acme/widgets.git", sources: [] },
  ]);
  sdk.stub("plugins.list", async () => ({ plugins: [{ id: "github", enabled: true, status: "running" }] }));
  sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => {
    const thread = byId.get(threadId);
    if (thread === undefined) throw new Error("not found");
    return response(thread);
  });
  sdk.stub("threads.list", async ({ threadIds }: { threadIds: readonly string[] }) =>
    threadIds.flatMap((id) => {
      const thread = byId.get(id);
      return thread === undefined || thread.deleted ? [] : [response(thread)];
    }),
  );
  sdk.stub("threads.promptHistory", async ({ threadId }: { threadId: string }) =>
    (byId.get(threadId)?.messages ?? []).map((message, index) => ({
      id: `msg_${index}`,
      createdAt: message.createdAt,
      input: [{ type: "text", text: message.text, mentions: [] }],
    })),
  );
  const store = createRefStore(host.bb.storage);
  for (const [index, [threadId, refs]] of REFS.entries()) {
    vi.setSystemTime(START + index * 1_000);
    store.record(threadId, refs);
  }
  const clock = { now: START };
  await createPlugin({ run: runner.run, pollMs: 1, now: () => clock.now })(host.bb);
  return { ...host, runner, clock };
}

describe("sidebarGroups fixture", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const SNAPSHOT = "./__snapshots__/sidebar-groups.json";
  const serialized = (groups: unknown) => `${JSON.stringify(groups, null, 2)}\n`;
  const graphql = (calls: readonly string[]) => calls.filter((call) => call.startsWith("gh api graphql"));

  it("matches the recorded groups", async () => {
    const { harness } = await load();
    const groups = await harness.callRpc("sidebarGroups", {});
    await expect(serialized(groups)).toMatchFileSnapshot(SNAPSHOT);
  });

  it("reads every thread with one threads.list call and every PR state with one gh call", async () => {
    const { harness, runner } = await load();
    await harness.callRpc("sidebarGroups", {});
    // The first twg lookup lands during the first pass, so the refresh runs a second pass, which reads the PRs from memory.
    const lists = harness.sdk.callsTo("threads.list") as Array<[{ threadIds: string[] }]>;
    expect(lists).toHaveLength(2);
    for (const [{ threadIds }] of lists) expect([...threadIds].sort()).toEqual(REFS.map(([threadId]) => threadId).sort());
    expect(harness.sdk.callsTo("threads.get")).toHaveLength(0);
    expect(runner.calls.filter((call) => call.startsWith("gh pr view"))).toHaveLength(0);
    const lookups = graphql(runner.calls).filter((call) => !call.includes("pullRequests(states: OPEN"));
    expect(lookups).toHaveLength(1);
    expect(lookups[0]).toBe(
      [
        "gh api graphql -f query=query {",
        '  r0: repository(owner: "acme", name: "widgets") { p404: pullRequest(number: 404) { state isDraft } p541: pullRequest(number: 541) { state isDraft } p534: pullRequest(number: 534) { state isDraft } }',
        '  r1: repository(owner: "acme", name: "gadgets") { p78: pullRequest(number: 78) { state isDraft } p77: pullRequest(number: 77) { state isDraft } }',
        "}",
      ].join("\n"),
    );
  });

  it("re-reads only what changed on a later refresh, and keeps the same groups", async () => {
    const { harness, runner, clock } = await load();
    await harness.callRpc("sidebarGroups", {});
    const histories = harness.sdk.callsTo("threads.promptHistory").length;
    const lists = harness.sdk.callsTo("threads.list").length;
    const firstCalls = runner.calls.length;

    clock.now += 61_000;
    const later = await harness.callRpc("sidebarGroups", {});
    await expect(serialized(later)).toMatchFileSnapshot(SNAPSHOT);
    // The configured repository is probed for changes; the open PRs elsewhere, whose changes cannot be seen, are read again.
    // Merged and closed PRs are not read again, nor, for five minutes, the PR GitHub could not resolve.
    const laterCalls = graphql(runner.calls.slice(firstCalls));
    const probes = Math.ceil(OPEN.length / PAGE_SIZE);
    expect(laterCalls).toHaveLength(probes + 1);
    for (const call of laterCalls.slice(0, probes)) {
      expect(call).toContain("query=query($owner: String!, $name: String!, $cursor: String)");
      expect(call).not.toContain("latestReviews");
    }
    expect(laterCalls.slice(1, probes).map((call) => call.split(" -f ").at(-1))).toEqual(["cursor=3", "cursor=6"]);
    expect(laterCalls[probes]).toContain('r0: repository(owner: "acme", name: "gadgets") { p78: pullRequest(number: 78) { state isDraft } p77: pullRequest(number: 77) { state isDraft } }');
    expect(harness.sdk.callsTo("threads.list")).toHaveLength(lists + 1);
    expect(harness.sdk.callsTo("threads.promptHistory")).toHaveLength(histories);
  });

  it("reports a lookup GitHub refused with its error, and retries it on the next refresh", async () => {
    const { harness, runner, clock } = await load();
    runner.github.rateLimited = true;
    const refused = (await harness.callRpc("sidebarGroups", {})) as { threadReviews: Array<{ number: number; pullState: string | null }> };
    expect(refused.threadReviews.find((review) => review.number === 534)?.pullState).toBeNull();
    expect(harness.logEntries).toContainEqual({ level: "warn", message: expect.stringContaining("API rate limit exceeded") });
    expect(harness.logEntries.some((entry) => entry.message.includes("could not resolve"))).toBe(false);

    runner.github.rateLimited = false;
    clock.now += 61_000;
    const groups = await harness.callRpc("sidebarGroups", {});
    await expect(serialized(groups)).toMatchFileSnapshot(SNAPSHOT);
  });

  it("re-reads a PR whose head moved, alone, and every PR after five minutes", async () => {
    const { harness, runner, clock } = await load();
    await harness.callRpc("sidebarGroups", {});
    const pull = OPEN.find((node) => node.number === 599)!;
    const original = { ...pull };
    try {
      Object.assign(pull, { headRefOid: "oid-599-b", title: "Evict the stale catalog entry", updatedAt: "2026-10-05T00:00:00Z" });
      clock.now += 61_000;
      const before = runner.calls.length;
      const groups = (await harness.callRpc("sidebarGroups", {})) as { pulls: Array<{ entry: { number: number; title: string } }> };
      expect(groups.pulls.map(({ entry }) => [entry.number, entry.title])).toEqual([
        [599, "Evict the stale catalog entry"],
        [640, "ACME-53: Rename the pricing table"],
      ]);
      const details = graphql(runner.calls.slice(before)).filter((call) => call.includes('name: "widgets") {'));
      expect(details).toEqual([expect.stringContaining('r0: repository(owner: "acme", name: "widgets") { p599: pullRequest(number: 599) { state number title body')]);

      clock.now += 5 * 60_000;
      const full = runner.calls.length;
      await harness.callRpc("sidebarGroups", {});
      expect(graphql(runner.calls.slice(full)).filter((call) => call.includes("latestReviews(first: 50)"))).toHaveLength(
        Math.ceil(OPEN.length / PAGE_SIZE),
      );
    } finally {
      Object.assign(pull, original);
    }
  });
});
