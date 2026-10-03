import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createPlugin, REVIEW_COMMAND, reviewTitle } from "./server.js";
import type { RunOptions } from "./tools.js";

const REPO = "acme/widgets";

interface Call {
  command: string;
  args: readonly string[];
  cwd: string | undefined;
}

function graphqlNode(number: number, title: string, body: string) {
  return {
    number,
    title,
    body,
    url: `https://github.com/${REPO}/pull/${number}`,
    isDraft: false,
    headRefName: `branch-${number}`,
    headRefOid: `oid-${number}`,
    additions: 5,
    deletions: 1,
    changedFiles: 2,
    updatedAt: "2026-10-01T00:00:00Z",
    author: { login: "bob", avatarUrl: "https://avatars.githubusercontent.com/u/1?s=32" },
    reviewRequests: {
      nodes: [{ requestedReviewer: { __typename: "Team", combinedSlug: "acme/platform" } }],
    },
    latestReviews: {
      nodes: [
        { author: { __typename: "Bot", login: "copilot-pull-request-reviewer", avatarUrl: "https://avatars.githubusercontent.com/in/2?s=32" }, state: "COMMENTED", submittedAt: "2026-10-01T00:00:00Z", commit: { oid: "" } },
      ],
    },
  };
}

const OPEN_PULLS = JSON.stringify({
  data: {
    repository: {
      pullRequests: {
        nodes: [
          graphqlNode(596, "ACME-51: Cache the widget catalog per tenant", "Fixes #12\nBuilds on #590"),
          graphqlNode(599, "Evict the old catalog entry", "ACME-51\n\nFollow-up."),
          graphqlNode(590, "Run the review workflow", ""),
        ],
      },
    },
  },
});

const PULL_VIEW = JSON.stringify({
  number: 596,
  title: "ACME-51: Cache the widget catalog per tenant",
  body: "Fixes #12\nBuilds on #590",
  headRefName: "bob/catalog-cache",
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

function fakeRunner() {
  const calls: Call[] = [];
  const run = async (command: string, args: readonly string[], options: RunOptions): Promise<string> => {
    calls.push({ command, args, cwd: options.cwd });
    const line = [command, ...args].join(" ");
    if (args[0] === "--version") return "1.0\n";
    if (line.startsWith("gh api user --jq")) return "benwaffle\n";
    if (line.startsWith("gh api user/teams")) return "acme/platform\n";
    if (line.startsWith("gh api graphql")) return OPEN_PULLS;
    if (line.startsWith("gh pr view 596")) return PULL_VIEW;
    if (line.startsWith("gh issue view 12")) return JSON.stringify({ title: "Stale prices after a currency change" });
    if (line.startsWith("twg jira workitem get ACME-51")) {
      return JSON.stringify({
        data: [{ key: "ACME-51", summary: "Cache the widget catalog", status: { name: "In Progress" } }],
      });
    }
    if (line.startsWith("gh pr checkout") || command === "open") return "";
    if (line === "git rev-parse --abbrev-ref HEAD") return "bob/catalog-cache\n";
    throw new Error(`unexpected command: ${line}`);
  };
  return { calls, run };
}

async function load() {
  const runner = fakeRunner();
  const plugin = createPlugin({ run: runner.run, platform: "darwin", pollMs: 1 });
  const host = createFakePluginHost({ pluginId: "pr-review" });
  const threads = new Map<string, { id: string; environmentId: string; status: string; title: string }>();
  const sdk = host.harness.sdk;
  sdk.stub("projects.list", async () => [
    { id: "proj_widgets", name: "widgets", gitRemoteUrl: "git@github.com:acme/widgets.git", sources: [] },
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
    path: "/worktrees/widgets-596",
    hostId: "host_local",
  }));
  await plugin(host.bb);
  return { ...host, runner, threads };
}

describe("reviewTitle", () => {
  it("leads with the short repo, number, and ticket and stays within 120 characters", () => {
    expect(reviewTitle(REPO, 596, "ACME-51: Cache the catalog", "ACME-51")).toBe("widgets#596 ACME-51: Cache the catalog");
    expect(reviewTitle(REPO, 590, "Run the review workflow", null)).toBe("widgets#590 Run the review workflow");
    const long = reviewTitle(REPO, 1, "x".repeat(200), "ACME-1");
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
      projectId: "proj_widgets",
      title: "widgets#596 ACME-51: Cache the widget catalog per tenant",
      environment: {
        type: "provider",
        environmentProviderId: "git-worktree",
        machine: { type: "existing", hostId: "host_local" },
        inputs: { branch: { kind: "named", name: "origin/bob/catalog-cache" } },
      },
    });
    const prompt = String(spawn.prompt);
    expect(prompt).toContain('Ticket: ACME-51 "Cache the widget catalog" [In Progress]');
    expect(prompt).toContain('Linked issue: acme/widgets#12 "Stale prices after a currency change"');
    expect(prompt).toContain('acme/widgets#599 "Evict the old catalog entry"');
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
    expect(runner.calls[checkout]?.cwd).toBe("/worktrees/widgets-596");
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

    const refs = (await harness.callRpc("threadRefs", { threadId: "thr_1" })) as {
      refs: Array<{ kind: string; key: string; source: string }>;
      worktree: unknown;
    };
    expect(refs.refs.map((ref) => `${ref.source} ${ref.kind} ${ref.key}`)).toEqual(
      expect.arrayContaining([
        `review-target gh-pr ${REPO}#596`,
        "title jira ACME-51",
        `fixes gh-issue ${REPO}#12`,
        `mention gh-pr ${REPO}#590`,
        `sibling gh-pr ${REPO}#599`,
      ]),
    );
    expect(refs.worktree).toEqual({ path: "/worktrees/widgets-596", isLocal: true });
  });
});

describe("runReview", () => {
  it("sends the review command to the PR's review thread", async () => {
    const { harness } = await load();
    await harness.callRpc("startReview", { repo: REPO, number: 596 });
    expect(await harness.callRpc("runReview", { threadId: "thr_1" })).toEqual({ delivery: "sent" });
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

  it("opens the thread and runs the review from the CLI", async () => {
    const { harness } = await load();
    const result = await harness.runCli(["review", "596"]);
    expect(result).toMatchObject({ exitCode: 0, stdout: "sent\tthr_1\n" });
    expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(harness.sdk.callsTo("threads.send")).toHaveLength(1);
  });

  it("refuses a thread without a PR ref", async () => {
    const { harness } = await load();
    await expect(harness.callRpc("runReview", { threadId: "thr_none" })).rejects.toThrow(/no PR to review/);
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
        agent: { state: string };
      }>;
    };
    expect(queue.viewer).toBe("benwaffle");
    expect(queue.githubPanel).toBe(true);
    expect(queue.entries.map((entry) => [entry.number, entry.ticketKey, entry.me, entry.agent.state])).toEqual([
      [590, null, "requested", "none"],
      [596, "ACME-51", "requested", "opened"],
      [599, "ACME-51", "requested", "none"],
    ]);
    expect(queue.entries[0]?.authorAvatarUrl).toBe("https://avatars.githubusercontent.com/u/1?s=32");
  });
});

describe("related threads and editors", () => {
  it("lists other threads sharing the ticket and opens the worktree in GoLand", async () => {
    const { harness, runner, bb } = await load();
    await harness.callRpc("startReview", { repo: REPO, number: 596 });
    const store = (await import("./store.js")).createRefStore(bb.storage);
    store.record("thr_other", [
      { kind: "jira", key: "ACME-51", url: "https://example.atlassian.net/browse/ACME-51", title: null, source: "title" },
    ]);
    harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => ({
      id: threadId,
      environmentId: "env_review",
      status: "idle",
      title: threadId === "thr_other" ? "Implement ACME-51" : "widgets#596",
      titleFallback: null,
      deletedAt: null,
      updatedAt: 1,
    }));
    const related = (await harness.callRpc("relatedThreads", { threadId: "thr_1" })) as {
      tickets: string[];
      threads: Array<{ threadId: string; title: string; firstMessage: string | null }>;
    };
    expect(related.tickets).toEqual(["ACME-51"]);
    expect(related.threads).toEqual([
      expect.objectContaining({ threadId: "thr_other", title: "Implement ACME-51", firstMessage: "Review context" }),
    ]);

    expect(await harness.callRpc("openWorktree", { threadId: "thr_1", editor: "goland" })).toEqual({
      opened: true,
      path: "/worktrees/widgets-596",
      error: null,
    });
    expect(runner.calls.at(-1)).toMatchObject({ command: "open", args: ["-a", "GoLand", "/worktrees/widgets-596"] });
  });
});
