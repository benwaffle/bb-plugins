import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createPlugin, REVIEW_COMMAND, reviewTitle } from "./server.js";
import type { RunOptions } from "./tools.js";

const REPO = "private-tech-inc/hss";

interface Call {
  command: string;
  args: readonly string[];
  cwd: string | undefined;
}

function graphqlNode(number: number, title: string, body: string, baseRefName = "main") {
  return {
    number,
    title,
    body,
    url: `https://github.com/${REPO}/pull/${number}`,
    isDraft: false,
    headRefName: `branch-${number}`,
    headRefOid: `oid-${number}`,
    baseRefName,
    isCrossRepository: false,
    additions: 5,
    deletions: 1,
    changedFiles: 2,
    updatedAt: "2026-10-01T00:00:00Z",
    author: { login: "meisbobzheng", avatarUrl: "https://avatars.githubusercontent.com/u/1?s=32" },
    reviewRequests: {
      nodes: [{ requestedReviewer: { __typename: "Team", combinedSlug: "private-tech-inc/network-services" } }],
    },
    latestReviews: {
      nodes: [
        { author: { __typename: "Bot", login: "copilot-pull-request-reviewer", avatarUrl: "https://avatars.githubusercontent.com/in/2?s=32" }, state: "COMMENTED", submittedAt: "2026-10-01T00:00:00Z", commit: { oid: "" } },
      ],
    },
  };
}

const OPEN_PULL_NODES = [
  graphqlNode(596, "CORE-51: Track the private identity the S-CSCF registered", "Fixes #12\nBuilds on #590"),
  graphqlNode(599, "De-register the old IMS identity", "CORE-51\n\nFollow-up.", "branch-596"),
  graphqlNode(590, "Run the review workflow", ""),
];

function openPulls(nodes: ReadonlyArray<ReturnType<typeof graphqlNode>>): string {
  return JSON.stringify({ data: { repository: { pullRequests: { nodes } } } });
}

const JIRA = new Map([
  ["CORE-51", { summary: "Track currently used IMPI", status: "In Progress" }],
  ["CORE-52", { summary: "Trigger RTR on default IMPU change", status: "To Do" }],
]);

function workItem(key: string, fields: { summary: string; status: string }) {
  return { key, summary: fields.summary, status: { name: fields.status }, url: `https://east-stout.atlassian.net/browse/${key}` };
}

/**
 * `twg jira workitem get` as it behaves: one key prints `data` as an array and
 * exits 1 when the key is unreadable; several keys print `data.items` with a
 * per-key `ok` flag and exit 0.
 */
function twgWorkItemGet(keys: readonly string[], jira: ReadonlyMap<string, { summary: string; status: string }>): string {
  if (keys.length === 1) {
    const fields = jira.get(keys[0]!);
    if (fields === undefined) throw new Error("twg jira workitem get: Command failed");
    return JSON.stringify({ data: [workItem(keys[0]!, fields)] });
  }
  return JSON.stringify({
    data: {
      items: keys.map((key) => {
        const fields = jira.get(key);
        return fields === undefined
          ? { input: key, ok: false, error: { message: "Issue does not exist", status: 404 } }
          : { input: key, ok: true, data: workItem(key, fields) };
      }),
    },
  });
}

const PULL_VIEW = JSON.stringify({
  number: 596,
  title: "CORE-51: Track the private identity the S-CSCF registered",
  body: "Fixes #12\nBuilds on #590",
  headRefName: "bob/cx-current-impi",
  url: `https://github.com/${REPO}/pull/596`,
  reviews: [],
  reviewDecision: "REVIEW_REQUIRED",
  latestReviews: [],
  files: [{ path: "a.go" }, { path: "b.go" }],
  additions: 279,
  deletions: 61,
  isCrossRepository: false,
  state: "OPEN",
});

function fakeRunner(nodes: ReadonlyArray<ReturnType<typeof graphqlNode>>) {
  const calls: Call[] = [];
  const twg: { jira: typeof JIRA; fail: boolean; gate: Promise<void> | null } = { jira: JIRA, fail: false, gate: null };
  const run = async (command: string, args: readonly string[], options: RunOptions): Promise<string> => {
    calls.push({ command, args, cwd: options.cwd });
    const line = [command, ...args].join(" ");
    if (args[0] === "--version") return "1.0\n";
    if (line.startsWith("gh api user --jq")) return "benwaffle\n";
    if (line.startsWith("gh api user/teams")) return "private-tech-inc/network-services\n";
    if (line.startsWith("gh api graphql")) return openPulls(nodes);
    if (line.startsWith("gh pr view 596")) return PULL_VIEW;
    if (line.startsWith("gh issue view 12")) return JSON.stringify({ title: "Wrong IMPI in RTR" });
    if (line.startsWith("twg jira workitem get ")) {
      await twg.gate;
      if (twg.fail) throw new Error("twg jira workitem: timed out");
      const keys = args.slice(3, args.indexOf("-o"));
      return twgWorkItemGet(keys, twg.jira);
    }
    if (line.startsWith("gh pr checkout")) return "";
    if (line === "git rev-parse --abbrev-ref HEAD") return "bob/cx-current-impi\n";
    throw new Error(`unexpected command: ${line}`);
  };
  return { calls, twg, run };
}

async function load(nodes = OPEN_PULL_NODES) {
  const runner = fakeRunner(nodes);
  const clock = { now: Date.parse("2026-10-04T09:00:00Z") };
  const plugin = createPlugin({ run: runner.run, pollMs: 1, now: () => clock.now });
  const host = createFakePluginHost({ pluginId: "pr-review" });
  const threads = new Map<string, { id: string; environmentId: string; status: string; title: string }>();
  const sdk = host.harness.sdk;
  sdk.stub("projects.list", async () => [
    { id: "proj_hss", name: "hss", gitRemoteUrl: "git@github.com:private-tech-inc/hss.git", sources: [] },
  ]);
  sdk.stub("plugins.list", async () => ({ plugins: [{ id: "github", enabled: true, status: "running" }] }));
  sdk.stub("system.config", async () => ({ primaryHostId: "host_local" }));
  sdk.stub("threads.spawn", async (args: { title: string }) => {
    const thread = { id: `thr_${threads.size + 1}`, environmentId: "env_review", status: "active", title: args.title };
    threads.set(thread.id, thread);
    return thread;
  });
  sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => {
    const thread = threads.get(threadId);
    if (thread === undefined) throw new Error("not found");
    return { ...thread, deletedAt: null, titleFallback: null, updatedAt: 1 };
  });
  sdk.stub("threads.promptHistory", async () => [
    { id: "msg_1", createdAt: 1, input: [{ type: "text", text: "Review context", mentions: [] }] },
  ]);
  sdk.stub("environments.pullRequest", async () => ({
    outcome: "available",
    pullRequest: { url: `https://github.com/${REPO}/pull/596` },
  }));
  sdk.stub("threads.send", async () => ({ ok: true, delivery: "sent" }));
  sdk.stub("environments.get", async () => ({
    id: "env_review",
    status: "ready",
    path: "/worktrees/hss-596",
    hostId: "host_local",
  }));
  await plugin(host.bb);
  return { ...host, runner, threads, clock };
}

describe("reviewTitle", () => {
  it("leads with the short repo, number, and ticket and stays within 120 characters", () => {
    expect(reviewTitle(REPO, 596, "CORE-51: Track the IMPI", "CORE-51")).toBe("hss#596 CORE-51: Track the IMPI");
    expect(reviewTitle(REPO, 590, "Run the review workflow", null)).toBe("hss#590 Run the review workflow");
    const long = reviewTitle(REPO, 1, "x".repeat(200), "CORE-1");
    expect(long).toHaveLength(120);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("startReview", () => {
  it("spawns a worktree thread at the PR head with a context message that does not start the review", async () => {
    const { harness } = await load();
    const result = await harness.callRpc("startReview", { repo: REPO, number: 596 });
    expect(result).toEqual({ threadId: "thr_1", created: true });

    const [[spawn]] = harness.sdk.callsTo("threads.spawn") as [[Record<string, unknown>]];
    expect(spawn).toMatchObject({
      projectId: "proj_hss",
      title: "hss#596 CORE-51: Track the private identity the S-CSCF registered",
      environment: {
        type: "provider",
        environmentProviderId: "git-worktree",
        machine: { type: "existing", hostId: "host_local" },
        inputs: { branch: { kind: "named", name: "origin/bob/cx-current-impi" } },
      },
    });
    const prompt = String(spawn.prompt);
    expect(prompt).toContain('Ticket: CORE-51 "Track currently used IMPI" [In Progress]');
    expect(prompt).toContain('Linked issue: private-tech-inc/hss#12 "Wrong IMPI in RTR"');
    expect(prompt).toContain('private-tech-inc/hss#599 "De-register the old IMS identity"');
    expect(prompt).not.toContain(REVIEW_COMMAND);
    expect(prompt.split("\n").at(-1)).toBe('Do not review yet. Reply only "Ready." and wait for instructions.');
  });

  it("returns once the worktree is on the PR head branch and bb resolves the PR for it", async () => {
    const { harness, runner } = await load();
    let lookups = 0;
    harness.sdk.stub("environments.pullRequest", async () =>
      ++lookups < 3
        ? { outcome: "absent" }
        : { outcome: "available", pullRequest: { url: `https://github.com/${REPO}/pull/596` } },
    );
    await harness.callRpc("startReview", { repo: REPO, number: 596 });
    const checkout = runner.calls.findIndex((call) => call.args[1] === "checkout");
    expect(runner.calls[checkout]?.cwd).toBe("/worktrees/hss-596");
    expect(runner.calls[checkout + 1]).toMatchObject({ command: "git", args: ["rev-parse", "--abbrev-ref", "HEAD"] });
    expect(lookups).toBe(3);
    expect(harness.sdk.callsTo("environments.pullRequest")[0]).toEqual([{ environmentId: "env_review" }]);
  });

  it("puts the CLI start thread's worktree on the bb server machine", async () => {
    const { harness } = await load();
    const result = await harness.runCli(["start", `${REPO}#596`]);
    expect(result).toMatchObject({ exitCode: 0, stdout: "started\tthr_1\n" });
    expect(harness.sdk.callsTo("threads.send")).toHaveLength(0);
    const [[spawn]] = harness.sdk.callsTo("threads.spawn") as [[{ environment: Record<string, unknown> }]];
    expect(spawn.environment.machine).toEqual({ type: "existing", hostId: "host_local" });
  });

  it("refuses to start without a server machine instead of spawning a thread with no machine", async () => {
    const { harness } = await load();
    harness.sdk.stub("system.config", async () => ({ primaryHostId: null }));
    await expect(harness.callRpc("startReview", { repo: REPO, number: 596 })).rejects.toThrow(/no server machine/);
    expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });

  it("records refs and reuses the thread on a second start", async () => {
    const { harness } = await load();
    await harness.callRpc("startReview", { repo: REPO, number: 596 });
    expect(await harness.callRpc("startReview", { repo: REPO, number: 596 })).toEqual({
      threadId: "thr_1",
      created: false,
    });
    expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(1);

    const cli = await harness.runCli(["refs", "thr_1", "--json"]);
    expect(cli.exitCode).toBe(0);
    const refs = JSON.parse(cli.stdout) as {
      refs: Array<{ kind: string; key: string; source: string }>;
      worktree: unknown;
    };
    expect(refs.refs.map((ref) => `${ref.source} ${ref.kind} ${ref.key}`)).toEqual(
      expect.arrayContaining([
        `review-target gh-pr ${REPO}#596`,
        "title jira CORE-51",
        `fixes gh-issue ${REPO}#12`,
        `mention gh-pr ${REPO}#590`,
        `sibling gh-pr ${REPO}#599`,
      ]),
    );
    expect(refs.worktree).toEqual({ path: "/worktrees/hss-596" });
  });
});

describe("review", () => {
  it("opens the PR's review thread and sends it the review command", async () => {
    const { harness } = await load();
    const result = await harness.runCli(["review", "596"]);
    expect(result).toMatchObject({ exitCode: 0, stdout: "sent\tthr_1\n" });
    expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(harness.sdk.callsTo("threads.send")).toEqual([
      [
        {
          threadId: "thr_1",
          mode: "auto",
          input: [{ type: "text", text: `${REVIEW_COMMAND} 596`, mentions: [] }],
        },
      ],
    ]);
  });
});

describe("reviewQueue", () => {
  it("returns open PRs with tickets and the agent thread state", async () => {
    const { harness } = await load();
    await harness.callRpc("startReview", { repo: REPO, number: 596 });
    const queue = (await harness.callRpc("reviewQueue", { refresh: true })) as {
      viewer: string;
      githubPanel: boolean;
      entries: Array<{
        number: number;
        ticketKey: string | null;
        me: string;
        authorAvatarUrl: string | null;
        parentNumber: number | null;
        depth: number;
        childNumbers: number[];
        agent: { state: string };
      }>;
    };
    expect(queue.viewer).toBe("benwaffle");
    expect(queue.githubPanel).toBe(true);
    expect(queue.entries.map((entry) => [entry.number, entry.ticketKey, entry.me, entry.agent.state])).toEqual([
      [590, null, "requested", "none"],
      [596, "CORE-51", "requested", "opened"],
      [599, "CORE-51", "requested", "none"],
    ]);
    expect(
      queue.entries.map((entry) => [entry.number, entry.parentNumber, entry.depth, entry.childNumbers]),
    ).toEqual([
      [590, null, 0, []],
      [596, null, 0, [599]],
      [599, 596, 1, []],
    ]);
    expect(queue.entries[0]?.authorAvatarUrl).toBe("https://avatars.githubusercontent.com/u/1?s=32");
  });
});

describe("sidebarGroups", () => {
  it("maps review threads to their ticket and lists unstarted PRs with their project", async () => {
    const { harness } = await load();
    await harness.callRpc("startReview", { repo: REPO, number: 596 });
    const groups = (await harness.callRpc("sidebarGroups", {})) as {
      githubPanel: boolean;
      tickets: Array<{ key: string; summary: string | null }>;
      threadTickets: Array<{ threadId: string; ticketKey: string }>;
      pulls: Array<{ projectId: string; entry: { number: number; ticketKey: string | null } }>;
    };
    expect(groups.githubPanel).toBe(true);
    expect(groups.threadTickets).toEqual([{ threadId: "thr_1", ticketKey: "CORE-51" }]);
    expect(groups.pulls.map(({ projectId, entry }) => [projectId, entry.number, entry.ticketKey])).toEqual([
      ["proj_hss", 590, null],
      ["proj_hss", 599, "CORE-51"],
    ]);
    expect(groups.tickets).toEqual([expect.objectContaining({ key: "CORE-51", summary: "Track currently used IMPI" })]);

    const cli = await harness.runCli(["groups"]);
    expect(cli).toMatchObject({
      exitCode: 0,
      stdout: [
        "CORE-51\tthread\tthr_1",
        `-\tpr\t${REPO}#590\tRun the review workflow`,
        `CORE-51\tpr\t${REPO}#599\tDe-register the old IMS identity`,
        "",
      ].join("\n"),
    });
  });
});

describe("related threads", () => {
  it("lists other threads sharing the ticket", async () => {
    const { harness, bb } = await load();
    await harness.callRpc("startReview", { repo: REPO, number: 596 });
    const store = (await import("./store.js")).createRefStore(bb.storage);
    store.record("thr_other", [
      { kind: "jira", key: "CORE-51", url: "https://east-stout.atlassian.net/browse/CORE-51", title: null, source: "title" },
    ]);
    harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => ({
      id: threadId,
      environmentId: "env_review",
      status: "idle",
      title: threadId === "thr_other" ? "Implement CORE-51" : "hss#596",
      titleFallback: null,
      deletedAt: null,
      updatedAt: 1,
    }));
    const related = (await harness.callRpc("relatedThreads", { threadId: "thr_1" })) as {
      tickets: string[];
      threads: Array<{ threadId: string; title: string; firstMessage: string | null }>;
    };
    expect(related.tickets).toEqual(["CORE-51"]);
    expect(related.threads).toEqual([
      expect.objectContaining({ threadId: "thr_other", title: "Implement CORE-51", firstMessage: "Review context" }),
    ]);
  });
});

describe("ticket summaries", () => {
  const nodes = [
    graphqlNode(601, "CORE-51: Track the IMPI", ""),
    graphqlNode(602, "CORE-52: Trigger RTR", ""),
    graphqlNode(603, "CORE-51: Follow-up", ""),
    graphqlNode(604, "CORE-404: Missing ticket", ""),
    graphqlNode(605, "No ticket", ""),
  ];

  interface QueueTickets {
    tickets: Array<{ key: string; summary: string | null; status: string | null }>;
  }

  const twgCalls = (runner: { calls: Call[] }) => runner.calls.filter((call) => call.args[0] === "jira");

  it("resolves every distinct queue key in one twg call and serves them with the queue", async () => {
    const { harness, runner } = await load(nodes);
    const queue = (await harness.callRpc("reviewQueue", { refresh: true })) as QueueTickets;

    expect(twgCalls(runner).map((call) => call.args)).toEqual([
      ["jira", "workitem", "get", "CORE-51", "CORE-52", "CORE-404", "-o", "json", "--output-summary", "none"],
    ]);
    expect(queue.tickets).toEqual([
      { key: "CORE-51", summary: "Track currently used IMPI", status: "In Progress", url: "https://east-stout.atlassian.net/browse/CORE-51" },
      { key: "CORE-52", summary: "Trigger RTR on default IMPU change", status: "To Do", url: "https://east-stout.atlassian.net/browse/CORE-52" },
      { key: "CORE-404", summary: null, status: null, url: "https://east-stout.atlassian.net/browse/CORE-404" },
    ]);
  });

  it("caches summaries for an hour, then serves the cached row while refreshing it", async () => {
    const { harness, runner, clock } = await load(nodes);
    await harness.callRpc("reviewQueue", { refresh: true });
    await harness.callRpc("reviewQueue", { refresh: true });
    expect(twgCalls(runner)).toHaveLength(1);

    clock.now += 61 * 60_000;
    runner.twg.jira = new Map([...JIRA, ["CORE-51", { summary: "Track the IMPI per registration", status: "Done" }]]);
    let release = () => {};
    runner.twg.gate = new Promise((resolve) => (release = resolve));
    const stale = (await harness.callRpc("reviewQueue", { refresh: true })) as QueueTickets;
    expect(stale.tickets[0]).toMatchObject({ key: "CORE-51", summary: "Track currently used IMPI" });
    expect(twgCalls(runner).at(-1)?.args.slice(3, -4)).toEqual(["CORE-51", "CORE-52", "CORE-404"]);

    release();
    await runner.twg.gate;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const refreshed = (await harness.callRpc("reviewQueue", { refresh: true })) as QueueTickets;
    expect(refreshed.tickets[0]).toMatchObject({ summary: "Track the IMPI per registration", status: "Done" });
    expect(twgCalls(runner)).toHaveLength(2);
  });

  it("keeps cached summaries when twg fails and retries an unreadable key after five minutes", async () => {
    const { harness, runner, clock } = await load(nodes);
    await harness.callRpc("reviewQueue", { refresh: true });
    await harness.callRpc("reviewQueue", { refresh: true });
    expect(twgCalls(runner)).toHaveLength(1);

    clock.now += 61 * 60_000;
    runner.twg.fail = true;
    await harness.callRpc("reviewQueue", { refresh: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const queue = (await harness.callRpc("reviewQueue", { refresh: true })) as QueueTickets;
    expect(queue.tickets.map((ticket) => [ticket.key, ticket.summary])).toEqual([
      ["CORE-51", "Track currently used IMPI"],
      ["CORE-52", "Trigger RTR on default IMPU change"],
      ["CORE-404", null],
    ]);
    expect(twgCalls(runner)).toHaveLength(2);

    clock.now += 5 * 60_000;
    runner.twg.fail = false;
    await harness.callRpc("reviewQueue", { refresh: true });
    expect(twgCalls(runner)).toHaveLength(3);
  });

  it("gives the sidebar groups and the refs CLI the ticket of each review thread", async () => {
    const { harness, runner } = await load();
    await harness.callRpc("startReview", { repo: REPO, number: 596 });
    const groups = (await harness.callRpc("sidebarGroups", {})) as QueueTickets;
    expect(groups.tickets).toEqual([expect.objectContaining({ key: "CORE-51", summary: "Track currently used IMPI" })]);
    const refs = JSON.parse((await harness.runCli(["refs", "thr_1", "--json"])).stdout) as QueueTickets;
    expect(refs.tickets).toEqual([
      expect.objectContaining({ key: "CORE-51", summary: "Track currently used IMPI", status: "In Progress" }),
    ]);
    expect(twgCalls(runner)).toHaveLength(1);
  });
});
