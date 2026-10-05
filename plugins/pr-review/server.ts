import {
  PluginCliError,
  cliCommand,
  defineCli,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { REFS_CHANNEL } from "./channel.js";
import { rpcContract, type QueueEntry, type ThreadRef, type Ticket } from "./contract.js";
import {
  githubRefs,
  githubUrl,
  parseProjectKeys,
  parsePullUrl,
  parseRepoKey,
  parseRepoList,
  ticketKey,
  titleWithoutTicket,
} from "./parse.js";
import {
  agentState,
  classifyPull,
  sortQueue,
  type PullSnapshot,
  type Viewer,
} from "./queue.js";
import { createRefStore, createTicketStore, type TicketFields } from "./store.js";
import {
  OPEN_PULLS_QUERY,
  PULL_VIEW_FIELDS,
  createToolResolver,
  parseIssueTitle,
  parseOpenPulls,
  parsePullView,
  parseTwgWorkItems,
  runCommand,
  type PullView,
  type Runner,
} from "./tools.js";

export { rpcContract };

const GITHUB_PLUGIN_ID = "github";
const WORKTREE_PROVIDER_ID = "git-worktree";
export const REVIEW_COMMAND = "/thermo-nuclear-code-quality-review review pr";
const TITLE_LIMIT = 120;
const QUEUE_TTL_MS = 30_000;
const TICKET_TTL_MS = 60 * 60_000;
const TICKET_RETRY_MS = 5 * 60_000;
const TWG_TIMEOUT_MS = 20_000;
const VIEWER_TTL_MS = 60 * 60_000;
const ENVIRONMENT_READY_TIMEOUT_MS = 5 * 60_000;
const ENVIRONMENT_POLL_MS = 2_000;
const PULL_LINK_TIMEOUT_MS = 30_000;
const FIRST_MESSAGE_LIMIT = 400;

interface Cached<T> {
  value: T;
  at: number;
}

function fresh<T>(entry: Cached<T> | undefined, ttlMs: number): entry is Cached<T> {
  return entry !== undefined && Date.now() - entry.at < ttlMs;
}

function distinct(values: Iterable<string | null>): string[] {
  return [...new Set([...values].filter((value) => value !== null))];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pullKey(repo: string, number: number): string {
  return `${repo}#${number}`;
}

function shortRepo(repo: string): string {
  return repo.slice(repo.indexOf("/") + 1);
}

export function reviewTitle(repo: string, number: number, title: string, ticket: string | null): string {
  const prefix = `${shortRepo(repo)}#${number}`;
  const full = ticket === null ? `${prefix} ${title}` : `${prefix} ${ticket}: ${titleWithoutTicket(title)}`;
  return full.length <= TITLE_LIMIT ? full : `${full.slice(0, TITLE_LIMIT - 1)}…`;
}

export interface ReviewContext {
  repo: string;
  pull: Pick<PullView, "number" | "title" | "url" | "headRefName" | "additions" | "deletions" | "files">;
  ticket: Ticket | null;
  issues: ReadonlyArray<{ key: string; title: string | null; url: string }>;
  siblings: ReadonlyArray<{ key: string; title: string; url: string }>;
}

export function reviewCommand(number: number): string {
  return `${REVIEW_COMMAND} ${number}`;
}

/**
 * The first message of a review thread: the gathered context and nothing that
 * starts the review. The review runs when `reviewCommand` is sent.
 */
export function contextPrompt(context: ReviewContext): string {
  const { pull, ticket } = context;
  const lines = [
    "Review context (data gathered by the pr-review plugin):",
    `- PR: ${pullKey(context.repo, pull.number)} "${pull.title}" ${pull.url}`,
    `  branch ${pull.headRefName}, +${pull.additions}/-${pull.deletions} across ${pull.files.length} files`,
  ];
  if (ticket !== null) {
    const status = ticket.status === null ? "" : ` [${ticket.status}]`;
    const summary = ticket.summary === null ? "" : ` "${ticket.summary}"`;
    lines.push(`- Ticket: ${ticket.key}${summary}${status} ${ticket.url}`);
  }
  for (const issue of context.issues) {
    const title = issue.title === null ? "" : ` "${issue.title}"`;
    lines.push(`- Linked issue: ${issue.key}${title} ${issue.url}`);
  }
  if (ticket !== null && context.siblings.length > 0) {
    lines.push(`- Other open PRs on ${ticket.key}:`);
    for (const sibling of context.siblings) {
      lines.push(`  - ${sibling.key} "${sibling.title}" ${sibling.url}`);
    }
  }
  lines.push("", 'Do not review yet. Reply only "Ready." and wait for instructions.');
  return lines.join("\n");
}

export interface PluginDeps {
  run: Runner;
  pollMs: number;
  now: () => number;
}

const defaultDeps: PluginDeps = {
  run: runCommand,
  pollMs: ENVIRONMENT_POLL_MS,
  now: Date.now,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createPlugin(deps: PluginDeps) {
  return function plugin(bb: BbPluginApi): void {
    const settings = bb.settings.define({
      repos: {
        type: "string",
        label: "Repositories",
        description: 'Comma-separated "owner/repo" list whose open PRs fill the review queue.',
        default: "acme/widgets",
      },
      jiraProjects: {
        type: "string",
        label: "Jira project keys",
        description: 'Comma-separated Jira project keys recognised as tickets, such as "ACME".',
        default: "ACME",
      },
      jiraBaseUrl: {
        type: "string",
        label: "Jira site",
        description: "Base URL that ticket links open, without a trailing slash.",
        default: "https://example.atlassian.net",
      },
      reviewProject: {
        type: "project",
        label: "Review project",
        description:
          "Project that review threads start in when no project's git remote matches the PR's repository.",
      },
    });
    const store = createRefStore(bb.storage);
    const ticketStore = createTicketStore(bb.storage);
    const resolveTool = createToolResolver(deps.run);
    const disposed = new AbortController();
    bb.onDispose(() => disposed.abort());

    async function tool(name: "gh" | "twg"): Promise<string> {
      const path = await resolveTool(name);
      if (path === null) throw new Error(`${name} is not installed or not on PATH`);
      return path;
    }

    async function gh(args: readonly string[], timeoutMs = 30_000, cwd?: string): Promise<string> {
      return deps.run(await tool("gh"), args, { timeoutMs, ...(cwd === undefined ? {} : { cwd }) });
    }

    async function config() {
      const values = await settings.get();
      return {
        repos: parseRepoList(values.repos),
        projectKeys: parseProjectKeys(values.jiraProjects),
        jiraBaseUrl: values.jiraBaseUrl.replace(/\/+$/, ""),
        reviewProject: values.reviewProject ?? null,
      };
    }

    let viewerCache: Cached<Viewer> | undefined;
    async function viewer(): Promise<Viewer> {
      if (fresh(viewerCache, VIEWER_TTL_MS)) return viewerCache.value;
      const login = (await gh(["api", "user", "--jq", ".login"])).trim();
      if (login.length === 0) throw new Error("gh api user returned no login");
      let teams: string[] = [];
      try {
        const raw = await gh([
          "api",
          "user/teams",
          "--paginate",
          "--jq",
          '.[] | "\\(.organization.login)/\\(.slug)"',
        ]);
        teams = raw.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
      } catch (error) {
        bb.log.warn(`could not list GitHub teams; team review requests are ignored: ${errorMessage(error)}`);
      }
      viewerCache = { value: { login, teams }, at: Date.now() };
      return viewerCache.value;
    }

    const pullsCache = new Map<string, Cached<PullSnapshot[]>>();
    async function openPulls(repo: string, refresh: boolean): Promise<PullSnapshot[]> {
      const cached = pullsCache.get(repo);
      if (!refresh && fresh(cached, QUEUE_TTL_MS)) return cached.value;
      const [owner, name] = repo.split("/");
      const raw = await gh(
        ["api", "graphql", "-f", `owner=${owner}`, "-f", `name=${name}`, "-f", `query=${OPEN_PULLS_QUERY}`],
        60_000,
      );
      const pulls = parseOpenPulls(repo, raw);
      pullsCache.set(repo, { value: pulls, at: Date.now() });
      return pulls;
    }

    let githubPanelCache: Cached<boolean> | undefined;
    async function githubPanel(): Promise<boolean> {
      if (fresh(githubPanelCache, QUEUE_TTL_MS)) return githubPanelCache.value;
      let available = false;
      try {
        const { plugins } = await bb.sdk.plugins.list();
        available = plugins.some(
          (plugin) => plugin.id === GITHUB_PLUGIN_ID && plugin.enabled && plugin.status === "running",
        );
      } catch (error) {
        bb.log.warn(`could not list plugins: ${errorMessage(error)}`);
      }
      githubPanelCache = { value: available, at: Date.now() };
      return available;
    }

    async function liveThread(threadId: string) {
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        return thread.deletedAt === null ? thread : null;
      } catch {
        return null;
      }
    }

    async function userMessages(threadId: string): Promise<string[]> {
      const history = await bb.sdk.threads.promptHistory({ threadId });
      return [...history]
        .sort((left, right) => left.createdAt - right.createdAt)
        .map((entry) =>
          entry.input
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n")
            .trim(),
        );
    }

    async function threadAgentState(threadId: string | undefined): Promise<QueueEntry["agent"]> {
      if (threadId === undefined) return { state: "none", threadId: null };
      const thread = await liveThread(threadId);
      if (thread === null) return { state: "none", threadId: null };
      let messages: string[] = [];
      try {
        messages = await userMessages(threadId);
      } catch (error) {
        bb.log.warn(`could not read prompt history for ${threadId}: ${errorMessage(error)}`);
      }
      const isRunning = thread.status === "active" || thread.status === "starting";
      return { state: agentState({ userMessages: messages, isRunning }, REVIEW_COMMAND), threadId };
    }

    async function reviewQueue(refresh: boolean) {
      const { repos, projectKeys } = await config();
      const me = await viewer();
      const errors: Array<{ repo: string; message: string }> = [];
      const pulls = (
        await Promise.all(
          repos.map(async (repo) => {
            try {
              return await openPulls(repo, refresh);
            } catch (error) {
              errors.push({ repo, message: errorMessage(error) });
              return [];
            }
          }),
        )
      ).flat();
      const threads = store.threadsForPulls(pulls.map((pull) => pullKey(pull.repo, pull.number)));
      const sorted = sortQueue(pulls.map((pull) => ({ pull, classified: classifyPull(pull, me) })));
      const entries = await Promise.all(
        sorted.map(async ({ pull, classified }): Promise<QueueEntry> => ({
          repo: pull.repo,
          number: pull.number,
          title: pull.title,
          url: pull.url,
          isDraft: pull.isDraft,
          author: pull.author,
          authorAvatarUrl: pull.authorAvatarUrl,
          headRefName: pull.headRefName,
          ticketKey: ticketKey(pull, projectKeys)?.key ?? null,
          additions: pull.additions,
          deletions: pull.deletions,
          changedFiles: pull.changedFiles,
          me: classified.me,
          bucket: classified.bucket,
          otherReviews: classified.otherReviews,
          agent: await threadAgentState(threads.get(pullKey(pull.repo, pull.number))),
        })),
      );
      return {
        viewer: me.login,
        fetchedAt: new Date().toISOString(),
        githubPanel: await githubPanel(),
        entries,
        tickets: await tickets(entries.map((entry) => entry.ticketKey)),
        errors,
      };
    }

    const ticketLookups = new Map<string, Promise<void>>();
    const ticketFailures = new Map<string, number>();

    /**
     * Looks up `keys` with one twg call and caches what it resolves. A key twg
     * cannot read keeps its cached row, if any, and is retried after
     * `TICKET_RETRY_MS`.
     */
    async function lookUpTickets(keys: readonly string[]): Promise<void> {
      let found = new Map<string, TicketFields>();
      try {
        const raw = await deps.run(
          await tool("twg"),
          ["jira", "workitem", "get", ...keys, "-o", "json", "--output-summary", "none"],
          { timeoutMs: TWG_TIMEOUT_MS },
        );
        found = parseTwgWorkItems(raw);
        const missing = keys.filter((key) => !found.has(key));
        if (missing.length > 0) bb.log.warn(`twg could not read ${missing.join(", ")}`);
      } catch (error) {
        bb.log.warn(`could not read ${keys.join(", ")} with twg: ${errorMessage(error)}`);
      }
      const now = deps.now();
      ticketStore.save(found, now);
      for (const key of keys) {
        if (found.has(key)) ticketFailures.delete(key);
        else ticketFailures.set(key, now);
      }
      if (found.size > 0) bb.realtime.publish(REFS_CHANNEL, { tickets: [...found.keys()] });
    }

    /**
     * Tickets for every distinct key, from the plugin database. Keys never
     * looked up are resolved before returning; keys older than `TICKET_TTL_MS`,
     * and keys twg could not read, are refreshed in the background. A key with
     * no cached row has a null summary and status.
     */
    async function tickets(keys: Iterable<string | null>): Promise<Ticket[]> {
      const wanted = distinct(keys);
      const { jiraBaseUrl } = await config();
      const now = deps.now();
      let cached = ticketStore.get(wanted);
      const due = wanted.filter((key) => {
        if (ticketLookups.has(key)) return false;
        const row = cached.get(key);
        if (row !== undefined && now - row.fetchedAt < TICKET_TTL_MS) return false;
        const failedAt = ticketFailures.get(key);
        return failedAt === undefined || now - failedAt >= TICKET_RETRY_MS;
      });
      if (due.length > 0) {
        const lookup = lookUpTickets(due)
          .catch((error: unknown) => bb.log.warn(`could not cache ${due.join(", ")}: ${errorMessage(error)}`))
          .finally(() => {
            for (const key of due) ticketLookups.delete(key);
          });
        for (const key of due) ticketLookups.set(key, lookup);
      }
      const unresolved = new Set(
        wanted
          .filter((key) => !cached.has(key) && !ticketFailures.has(key))
          .flatMap((key) => ticketLookups.get(key) ?? []),
      );
      if (unresolved.size > 0) {
        await Promise.all(unresolved);
        cached = ticketStore.get(wanted);
      }
      return wanted.map((key) => ({
        key,
        summary: cached.get(key)?.summary ?? null,
        status: cached.get(key)?.status ?? null,
        url: `${jiraBaseUrl}/browse/${key}`,
      }));
    }

    async function resolveProjectId(repo: string): Promise<string> {
      const projects = await bb.sdk.projects.list();
      const match = projects.find((project) => {
        const remote = project.gitRemoteUrl;
        return remote !== null && new RegExp(`[:/]${repo.replaceAll(".", "\\.")}(\\.git)?/?$`, "i").test(remote);
      });
      if (match !== undefined) return match.id;
      const { reviewProject } = await config();
      if (reviewProject !== null && reviewProject.length > 0) return reviewProject;
      throw new Error(
        `No bb project has ${repo} as its git remote. Set the pr-review "Review project" setting.`,
      );
    }

    async function sidebarGroups() {
      const queue = await reviewQueue(false);
      const threadTickets = store.ticketThreads();
      for (const entry of queue.entries) {
        if (entry.agent.threadId !== null && entry.ticketKey !== null) {
          threadTickets.set(entry.agent.threadId, entry.ticketKey);
        }
      }
      const projectIds = new Map<string, Promise<string | null>>();
      const projectFor = (repo: string) => {
        let projectId = projectIds.get(repo);
        if (projectId === undefined) {
          projectId = resolveProjectId(repo).catch((error: unknown) => {
            bb.log.warn(`no sidebar group project for ${repo}: ${errorMessage(error)}`);
            return null;
          });
          projectIds.set(repo, projectId);
        }
        return projectId;
      };
      const pulls = (
        await Promise.all(
          queue.entries
            .filter((entry) => entry.agent.threadId === null && entry.bucket !== "approved")
            .map(async (entry) => {
              const projectId = await projectFor(entry.repo);
              return projectId === null ? null : { projectId, entry };
            }),
        )
      ).filter((pull) => pull !== null);
      return {
        githubPanel: queue.githubPanel,
        tickets: await tickets([...queue.tickets.map((ticket) => ticket.key), ...threadTickets.values()]),
        threadTickets: [...threadTickets].map(([threadId, ticketKey]) => ({ threadId, ticketKey })),
        pulls,
      };
    }

    async function issueTitle(key: string): Promise<string | null> {
      const parsed = parseRepoKey(key);
      if (parsed === null) return null;
      try {
        return parseIssueTitle(
          await gh(["issue", "view", String(parsed.number), "-R", parsed.repo, "--json", "title"], 15_000),
        );
      } catch {
        return null;
      }
    }

    async function resolvePull(repo: string, number: number) {
      const { projectKeys } = await config();
      const pull = parsePullView(
        await gh(["pr", "view", String(number), "-R", repo, "--json", PULL_VIEW_FIELDS.join(",")]),
      );
      const ticketMatch = ticketKey(pull, projectKeys);
      const linked = githubRefs(pull.body, repo, number);
      const openInRepo = await openPulls(repo, false).catch(() => [] as PullSnapshot[]);
      const siblings =
        ticketMatch === null
          ? []
          : openInRepo
              .filter((other) => other.number !== number)
              .filter((other) => ticketKey(other, projectKeys)?.key === ticketMatch.key)
              .map((other) => ({ key: pullKey(repo, other.number), title: other.title, url: other.url }));
      const openTitles = new Map(openInRepo.map((other) => [pullKey(repo, other.number), other.title]));
      const issues = await Promise.all(
        linked
          .filter((ref) => ref.kind === "gh-issue")
          .slice(0, 10)
          .map(async (ref) => ({ key: ref.key, title: await issueTitle(ref.key), url: githubUrl("gh-issue", ref.key), source: ref.source })),
      );
      const mentionedPulls = linked
        .filter((ref) => ref.kind === "gh-pr")
        .map((ref) => ({ key: ref.key, title: openTitles.get(ref.key) ?? null, url: githubUrl("gh-pr", ref.key), source: ref.source }));
      const ticketInfo = ticketMatch === null ? null : ((await tickets([ticketMatch.key]))[0] ?? null);

      const refs: ThreadRef[] = [
        { kind: "gh-pr", key: pullKey(repo, number), url: pull.url, title: pull.title, source: "review-target" },
        ...(ticketInfo === null || ticketMatch === null
          ? []
          : [{ kind: "jira" as const, key: ticketInfo.key, url: ticketInfo.url, title: ticketInfo.summary, source: ticketMatch.source }]),
        ...issues.map((issue) => ({ kind: "gh-issue" as const, ...issue })),
        ...mentionedPulls.map((mention) => ({ kind: "gh-pr" as const, ...mention })),
        ...siblings.map((sibling) => ({ kind: "gh-pr" as const, key: sibling.key, url: sibling.url, title: sibling.title, source: "sibling" as const })),
      ];
      return { pull, ticket: ticketInfo, issues, siblings, refs };
    }

    async function existingReviewThread(repo: string, number: number): Promise<string | null> {
      for (const threadId of store.reviewThreadFor(pullKey(repo, number))) {
        if ((await liveThread(threadId)) !== null) return threadId;
      }
      return null;
    }

    async function readyEnvironment(threadId: string, deadline: number) {
      while (!disposed.signal.aborted && Date.now() < deadline) {
        const thread = await liveThread(threadId);
        if (thread === null) return null;
        if (thread.environmentId !== null) {
          const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
          if (environment.status === "ready" && environment.path !== null) {
            return { id: environment.id, path: environment.path };
          }
          if (environment.status !== "creating" && environment.status !== "provisioning") {
            bb.log.warn(`environment for ${threadId} is ${environment.status}; skipped gh pr checkout`);
            return null;
          }
        }
        await sleep(deps.pollMs);
      }
      bb.log.warn(`environment for ${threadId} was not ready in time; skipped gh pr checkout`);
      return null;
    }

    async function checkoutPull(path: string, repo: string, pull: PullView): Promise<void> {
      try {
        await gh(["pr", "checkout", String(pull.number), "-R", repo], 120_000, path);
      } catch (error) {
        const branch = `review/pr-${pull.number}`;
        bb.log.info(`gh pr checkout ${pull.number} failed (${errorMessage(error)}); retrying as ${branch}`);
        await gh(["pr", "checkout", String(pull.number), "-R", repo, "--branch", branch, "--force"], 120_000, path);
      }
      const branch = (
        await deps.run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: path, timeoutMs: 15_000 })
      ).trim();
      if (branch !== pull.headRefName) {
        bb.log.warn(`${pullKey(repo, pull.number)} is checked out as ${branch}, not its head branch ${pull.headRefName}`);
      }
      bb.log.info(`checked out ${pullKey(repo, pull.number)} as ${branch} in ${path}`);
    }

    /**
     * Polls bb's branch lookup for the environment until it names the PR. The
     * GitHub plugin's PR tab resolves a thread's PR through this lookup once,
     * when it mounts, so the thread is opened only after it succeeds.
     */
    async function awaitEnvironmentPull(environmentId: string, pull: PullView): Promise<boolean> {
      const deadline = Date.now() + PULL_LINK_TIMEOUT_MS;
      while (!disposed.signal.aborted && Date.now() < deadline) {
        const result = await bb.sdk.environments.pullRequest({ environmentId }).catch(() => null);
        if (result?.outcome === "available") {
          if (result.pullRequest.url === pull.url) return true;
          bb.log.warn(`environment ${environmentId} resolves to ${result.pullRequest.url}, not ${pull.url}`);
          return false;
        }
        await sleep(deps.pollMs);
      }
      bb.log.warn(`bb did not resolve ${pull.url} for environment ${environmentId} in time`);
      return false;
    }

    async function prepareWorktree(threadId: string, repo: string, pull: PullView): Promise<void> {
      const environment = await readyEnvironment(threadId, Date.now() + ENVIRONMENT_READY_TIMEOUT_MS);
      if (environment === null) return;
      await checkoutPull(environment.path, repo, pull);
      await awaitEnvironmentPull(environment.id, pull);
    }

    async function serverHostId(): Promise<string> {
      const { primaryHostId } = await bb.sdk.system.config();
      if (primaryHostId === null) {
        throw new Error("bb has no server machine to create the review worktree on. Connect a machine first.");
      }
      return primaryHostId;
    }

    async function startReview(repo: string, number: number): Promise<{ threadId: string; created: boolean }> {
      const existing = await existingReviewThread(repo, number);
      if (existing !== null) return { threadId: existing, created: false };

      const resolved = await resolvePull(repo, number);
      if (resolved.pull.state !== "OPEN") {
        throw new Error(`${pullKey(repo, number)} is ${resolved.pull.state.toLowerCase()}, not open`);
      }
      const projectId = await resolveProjectId(repo);
      const hostId = await serverHostId();
      const base: { kind: "default" } | { kind: "named"; name: string } = resolved.pull.isCrossRepository
        ? { kind: "default" }
        : { kind: "named", name: `origin/${resolved.pull.headRefName}` };
      const thread = await bb.sdk.threads.spawn({
        projectId,
        environment: {
          type: "provider",
          environmentProviderId: WORKTREE_PROVIDER_ID,
          machine: { type: "existing", hostId },
          inputs: { branch: base },
        },
        title: reviewTitle(repo, number, resolved.pull.title, resolved.ticket?.key ?? null),
        prompt: contextPrompt({ repo, ...resolved }),
        pluginMetadata: { repo, number },
      });
      store.record(thread.id, resolved.refs);
      bb.realtime.publish(REFS_CHANNEL, { threadId: thread.id });
      await prepareWorktree(thread.id, repo, resolved.pull).catch((error: unknown) =>
        bb.log.warn(`could not check out ${pullKey(repo, number)} for ${thread.id}: ${errorMessage(error)}`),
      );
      bb.log.info(`started review thread ${thread.id} for ${pullKey(repo, number)}`);
      return { threadId: thread.id, created: true };
    }

    async function runReview(threadId: string, number: number): Promise<{ delivery: "sent" | "queued" }> {
      const result = await bb.sdk.threads.send({
        threadId,
        mode: "auto",
        input: [{ type: "text", text: reviewCommand(number), mentions: [] }],
      });
      bb.realtime.publish(REFS_CHANNEL, { threadId });
      return { delivery: result.delivery };
    }

    const environmentLookups = new Map<string, Cached<null>>();
    async function refsFromEnvironment(threadId: string, environmentId: string): Promise<ThreadRef[]> {
      if (fresh(environmentLookups.get(threadId), QUEUE_TTL_MS * 20)) return [];
      environmentLookups.set(threadId, { value: null, at: Date.now() });
      const { repos } = await config();
      const result = await bb.sdk.environments.pullRequest({ environmentId }).catch(() => null);
      if (result === null || result.outcome !== "available") return [];
      const pull = parsePullUrl(result.pullRequest.url);
      if (pull === null || !repos.includes(pull.repo)) return [];
      const resolved = await resolvePull(pull.repo, pull.number);
      const refs = resolved.refs.map((ref) =>
        ref.source === "review-target" ? { ...ref, source: "environment" as const } : ref,
      );
      store.record(threadId, refs);
      return refs;
    }

    async function threadRefs(threadId: string) {
      const thread = await liveThread(threadId);
      let refs = store.forThread(threadId);
      let worktree: { path: string } | null = null;
      if (thread !== null && thread.environmentId !== null) {
        if (refs.length === 0) {
          refs = await refsFromEnvironment(threadId, thread.environmentId).catch((error: unknown) => {
            bb.log.warn(`could not resolve refs for ${threadId}: ${errorMessage(error)}`);
            return [];
          });
        }
        const environment = await bb.sdk.environments
          .get({ environmentId: thread.environmentId })
          .catch(() => null);
        if (environment !== null && environment.path !== null) worktree = { path: environment.path };
      }
      return {
        refs,
        tickets: await tickets(refs.map((ref) => (ref.kind === "jira" ? ref.key : null))),
        worktree,
      };
    }

    async function relatedThreads(threadId: string) {
      const tickets = store
        .forThread(threadId)
        .filter((ref) => ref.kind === "jira")
        .map((ref) => ref.key);
      const others = [...new Set(tickets.flatMap((key) => store.threadsWith("jira", key)))].filter(
        (other) => other !== threadId,
      );
      const threads = (
        await Promise.all(
          others.map(async (otherId) => {
            const thread = await liveThread(otherId);
            if (thread === null) return null;
            const messages = await userMessages(otherId).catch(() => [] as string[]);
            const first = messages[0] ?? null;
            const refs = store.forThread(otherId);
            return {
              threadId: otherId,
              title: thread.title ?? thread.titleFallback ?? otherId,
              firstMessage:
                first === null || first.length <= FIRST_MESSAGE_LIMIT
                  ? first
                  : `${first.slice(0, FIRST_MESSAGE_LIMIT - 1)}…`,
              tickets: refs.filter((ref) => ref.kind === "jira").map((ref) => ref.key),
              pulls: refs
                .filter((ref) => ref.kind === "gh-pr" && (ref.source === "review-target" || ref.source === "environment"))
                .map((ref) => ref.key),
              updatedAt: thread.updatedAt,
            };
          }),
        )
      )
        .filter((thread) => thread !== null)
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .map(({ updatedAt: _updatedAt, ...thread }) => thread);
      return { tickets, threads };
    }

    bb.rpc.register(rpcContract, {
      reviewQueue: ({ refresh }) => reviewQueue(refresh),
      sidebarGroups: () => sidebarGroups(),
      startReview: ({ repo, number }) => startReview(repo, number),
      relatedThreads: ({ threadId }) => relatedThreads(threadId),
    });

    const jsonOption = { json: { type: "boolean", description: "Print the result as JSON" } } as const;

    function parsePullArgument(value: string, defaultRepo: string | undefined): { repo: string; number: number } {
      const fromUrl = parsePullUrl(value);
      if (fromUrl !== null) return fromUrl;
      const fromKey = parseRepoKey(value);
      if (fromKey !== null) return fromKey;
      if (/^\d+$/.test(value) && defaultRepo !== undefined) return { repo: defaultRepo, number: Number(value) };
      throw new PluginCliError(`"${value}" is not a PR number, owner/repo#n, or PR URL`, {
        code: "invalid_pull",
        hint: "For example `bb pr-review start 596` or `bb pr-review start acme/widgets#596`.",
      });
    }

    bb.cli.register(
      defineCli({
        name: "pr-review",
        summary: "Review queue for open PRs, and agent review threads with their PR, ticket, and issue refs",
        commands: {
          queue: cliCommand({
            summary: "List open PRs in review order with your state and the agent thread state",
            options: {
              ...jsonOption,
              refresh: { type: "boolean", description: "Bypass the 30 second cache" },
            },
            async run(input) {
              const queue = await reviewQueue(input.options.refresh === true);
              if (input.options.json) return { exitCode: 0, stdout: `${JSON.stringify(queue)}\n` };
              const lines = queue.entries.map((entry) =>
                [
                  pullKey(entry.repo, entry.number),
                  entry.bucket,
                  entry.ticketKey ?? "-",
                  `+${entry.additions}/-${entry.deletions}`,
                  entry.me,
                  entry.agent.state,
                  entry.title,
                ].join("\t"),
              );
              const errors = queue.errors.map((error) => `error\t${error.repo}\t${error.message}`);
              return { exitCode: 0, stdout: [...lines, ...errors].map((line) => `${line}\n`).join("") };
            },
          }),
          groups: cliCommand({
            summary: "List the ticket groups the sidebar nests review threads and unstarted PRs under",
            options: jsonOption,
            async run(input) {
              const result = await sidebarGroups();
              if (input.options.json) return { exitCode: 0, stdout: `${JSON.stringify(result)}\n` };
              const lines = [
                ...result.threadTickets.map(({ threadId, ticketKey }) => `${ticketKey}\tthread\t${threadId}`),
                ...result.pulls.map(
                  ({ entry }) => `${entry.ticketKey ?? "-"}\tpr\t${pullKey(entry.repo, entry.number)}\t${entry.title}`,
                ),
              ];
              return { exitCode: 0, stdout: lines.map((line) => `${line}\n`).join("") };
            },
          }),
          start: cliCommand({
            summary: "Find or open the review thread for a PR without running the review",
            positionals: [
              { name: "pull", description: "PR number (first configured repo), owner/repo#n, or PR URL", required: true },
            ],
            options: jsonOption,
            async run(input) {
              const { repos } = await config();
              const { repo, number } = parsePullArgument(input.positionals.pull, repos[0]);
              const result = await startReview(repo, number);
              return {
                exitCode: 0,
                stdout: input.options.json
                  ? `${JSON.stringify(result)}\n`
                  : `${result.created ? "started" : "existing"}\t${result.threadId}\n`,
              };
            },
          }),
          review: cliCommand({
            summary: "Run the thermo-nuclear code quality review in a PR's review thread, opening it first if needed",
            positionals: [
              { name: "pull", description: "PR number (first configured repo), owner/repo#n, or PR URL", required: true },
            ],
            options: jsonOption,
            async run(input) {
              const { repos } = await config();
              const { repo, number } = parsePullArgument(input.positionals.pull, repos[0]);
              const { threadId } = await startReview(repo, number);
              const { delivery } = await runReview(threadId, number);
              return {
                exitCode: 0,
                stdout: input.options.json
                  ? `${JSON.stringify({ threadId, delivery })}\n`
                  : `${delivery}\t${threadId}\n`,
              };
            },
          }),
          refs: cliCommand({
            summary: "Show the PR, ticket, and issue refs recorded for a thread",
            positionals: [{ name: "threadId", description: "Thread id", required: true }],
            options: jsonOption,
            async run(input) {
              const result = await threadRefs(input.positionals.threadId);
              if (input.options.json) return { exitCode: 0, stdout: `${JSON.stringify(result)}\n` };
              const lines = result.refs.map((ref) =>
                [ref.kind, ref.key, ref.source, ref.title ?? "", ref.url].join("\t"),
              );
              if (result.worktree !== null) lines.push(`worktree\t${result.worktree.path}`);
              return { exitCode: 0, stdout: lines.map((line) => `${line}\n`).join("") };
            },
          }),
          related: cliCommand({
            summary: "List other threads that share a ticket with a thread",
            positionals: [{ name: "threadId", description: "Thread id", required: true }],
            options: jsonOption,
            async run(input) {
              const result = await relatedThreads(input.positionals.threadId);
              if (input.options.json) return { exitCode: 0, stdout: `${JSON.stringify(result)}\n` };
              return {
                exitCode: 0,
                stdout: result.threads.map((thread) => `${thread.threadId}\t${thread.title}\n`).join(""),
              };
            },
          }),
        },
      }),
    );
  };
}

export default createPlugin(defaultDeps);
