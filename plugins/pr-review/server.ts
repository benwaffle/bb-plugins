import {
  PluginCliError,
  cliCommand,
  defineCli,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { REFS_CHANNEL } from "./channel.js";
import {
  rpcContract,
  type QueueEntry,
  type RelatedResult,
  type SidebarGroupsResult,
  type ThreadRef,
  type Ticket,
} from "./contract.js";
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
  isReviewMessage,
  pullKey,
  shortRepo,
  sortQueue,
  stackLinks,
  type PullSnapshot,
  type UserMessage,
  type Viewer,
} from "./queue.js";
import { queuedPullState, relatedItems, withoutTickets, type RelatedItem, type RelatedPullState } from "./related.js";
import { SIDEBAR_STYLES } from "./sidebar.js";
import { createRefStore, createTicketStore, type TicketFields } from "./store.js";
import {
  CommandError,
  OPEN_PULLS_QUERY,
  OPEN_PULL_HEADS_QUERY,
  PULL_VIEW_FIELDS,
  createToolResolver,
  hasLookupData,
  parseIssueTitle,
  parseOpenPullHeads,
  parseOpenPulls,
  parsePullDetails,
  parsePullStates,
  parsePullView,
  parseTwgWorkItems,
  pullDetailsQuery,
  pullStatesQuery,
  runCommand,
  type FingerprintedPull,
  type Page,
  type PullRef,
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
const TEAMS_TTL_MS = 60 * 60_000;
/** Hard limit on one gh call; the call's process group is killed when it passes. */
const GH_TIMEOUT_MS = 10_000;
/** A GraphQL page reads up to 100 PRs with their reviews and checks. */
const GRAPHQL_TIMEOUT_MS = 30_000;
/** PRs read per aliased GraphQL lookup. */
const LOOKUP_PAGE_SIZE = 50;
/**
 * How often a repository's open PRs are read in full. In between, a read
 * fetches only what tells whether each PR changed, and the full fields of
 * the PRs that did. Check counts that change within one rollup state show
 * at the next full read.
 */
const FULL_READ_MS = 5 * 60_000;
/** How long a PR whose state could not be read waits before it is read again. */
const PULL_STATE_RETRY_MS = 5 * 60_000;
/** Thread ids per `threads.list` call; the API's limit. */
const THREAD_LIST_PAGE_SIZE = 200;
const CHECKOUT_TIMEOUT_MS = 120_000;
/** How long a `sidebarGroups` result is served before it is refreshed. */
const SIDEBAR_TTL_MS = 60_000;
/** How long a sidebar call with no result yet waits for the first refresh. */
const SIDEBAR_FIRST_WAIT_MS = 10_000;
/** How long a sidebar call with a stale result waits for its refresh. */
const SIDEBAR_STALE_WAIT_MS = 2_000;
/** Refreshes a result whose inputs change during its refresh at most this many times in a row. */
const SIDEBAR_MAX_REFRESH_PASSES = 3;
const ENVIRONMENT_READY_TIMEOUT_MS = 5 * 60_000;
const ENVIRONMENT_POLL_MS = 2_000;
const PULL_LINK_TIMEOUT_MS = 30_000;

interface Cached<T> {
  value: T;
  at: number;
}

const REPOS_SETUP_HINT =
  'Set "Repositories" in the PR review plugin settings to the "owner/repo" list whose open PRs fill the queue.';
const JIRA_SETUP_HINT =
  'Set "Jira project keys" and "Jira site" in the PR review plugin settings to link PRs to Jira tickets.';

/** What the queue shows until the plugin settings are filled in. */
function setupHints(reposConfigured: boolean, jiraConfigured: boolean): string[] {
  return [...(reposConfigured ? [] : [REPOS_SETUP_HINT]), ...(jiraConfigured ? [] : [JIRA_SETUP_HINT])];
}

function fresh<T>(entry: Cached<T> | undefined, ttlMs: number, now: number): entry is Cached<T> {
  return entry !== undefined && now - entry.at < ttlMs;
}

function distinct(values: Iterable<string | null>): string[] {
  return [...new Set([...values].filter((value) => value !== null))];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

type ThreadRow = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number];

/** A thread's row, null for a deleted or unknown thread, and its agent state. */
interface ThreadInfo {
  thread: ThreadRow | null;
  agent: QueueEntry["agent"];
}

/**
 * `#596 <PR title>`, cut to 120 characters. The sidebar's project header and
 * ticket group show the repository and ticket, so the title leaves them out.
 */
export function reviewTitle(number: number, title: string, ticket: string | null): string {
  const full = `#${number} ${titleWithoutTicket(title, ticket)}`;
  return full.length <= TITLE_LIMIT ? full : `${full.slice(0, TITLE_LIMIT - 1)}…`;
}

export interface ReviewContext {
  repo: string;
  pull: Pick<PullView, "number" | "title" | "url" | "headRefName">;
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
  const { repo, pull, ticket } = context;
  const ticketKey = ticket?.key ?? null;
  const label = (key: string) => (key.startsWith(`${repo}#`) ? key.slice(repo.length) : key);
  const lines = [
    `Review context for [${shortRepo(repo)}#${pull.number}](${pull.url}): ${titleWithoutTicket(pull.title, ticketKey)} (branch \`${pull.headRefName}\`)`,
  ];
  if (ticket !== null) {
    const summary = ticket.summary === null ? "" : `: ${ticket.summary}`;
    const status = ticket.status === null ? "" : ` (${ticket.status})`;
    lines.push(`- Ticket [${ticket.key}](${ticket.url})${summary}${status}`);
  }
  for (const issue of context.issues) {
    const title = issue.title === null ? "" : `: ${issue.title}`;
    lines.push(`- Linked issue [${label(issue.key)}](${issue.url})${title}`);
  }
  if (ticket !== null && context.siblings.length > 0) {
    lines.push(`- Other open PRs on ${ticket.key}:`);
    for (const sibling of context.siblings) {
      lines.push(`  - [${label(sibling.key)}](${sibling.url}): ${titleWithoutTicket(sibling.title, ticketKey)}`);
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

const NO_SIDEBAR_GROUPS: SidebarGroupsResult = {
  tickets: [],
  threadTickets: [],
  pulls: [],
  threadPulls: [],
  threadReviews: [],
};

type Settled<T> = { kind: "resolved"; value: T } | { kind: "rejected" } | { kind: "pending" };

/** How `promise` settles within `ms`. */
async function settleWithin<T>(promise: Promise<T>, ms: number): Promise<Settled<T>> {
  let timer: NodeJS.Timeout | undefined;
  const pending = new Promise<Settled<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "pending" }), ms);
  });
  try {
    return await Promise.race([
      promise.then(
        (value): Settled<T> => ({ kind: "resolved", value }),
        (): Settled<T> => ({ kind: "rejected" }),
      ),
      pending,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createPlugin(deps: PluginDeps) {
  return function plugin(bb: BbPluginApi): void {
    const settings = bb.settings.define({
      repos: {
        type: "string",
        label: "Repositories",
        description: 'Comma-separated "owner/repo" list whose open PRs fill the review queue, such as "acme/widgets".',
        default: "",
      },
      jiraProjectKeys: {
        type: "string",
        label: "Jira project keys",
        description: 'Comma-separated Jira project keys recognised as tickets, such as "ACME". Tickets also need the Jira site.',
        default: "",
      },
      jiraSite: {
        type: "string",
        label: "Jira site",
        description: 'Base URL that ticket links open, such as "https://example.atlassian.net".',
        default: "",
      },
      reviewProject: {
        type: "project",
        label: "Review project",
        description:
          "Project that review threads start in when no project's git remote matches the PR's repository.",
      },
      sidebarStyle: {
        type: "select",
        label: "Sidebar style",
        description:
          'How ticket groups look in the sidebar: "minimal" shows the ticket key as a pill and unstarted PRs as ghost rows, "card" draws each ticket as a bordered card. bb builds that draw neither show flat groups.',
        options: [...SIDEBAR_STYLES],
        default: "minimal",
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

    async function gh(args: readonly string[], timeoutMs = GH_TIMEOUT_MS, cwd?: string): Promise<string> {
      return deps.run(await tool("gh"), args, { timeoutMs, ...(cwd === undefined ? {} : { cwd }) });
    }

    async function config() {
      const values = await settings.get();
      const repos = parseRepoList(values.repos);
      const jiraKeys = parseProjectKeys(values.jiraProjectKeys);
      const jiraBaseUrl = values.jiraSite.trim().replace(/\/+$/, "");
      const jiraConfigured = jiraKeys.length > 0 && jiraBaseUrl.length > 0;
      return {
        repos,
        projectKeys: jiraConfigured ? jiraKeys : [],
        jiraBaseUrl,
        reviewProject: values.reviewProject ?? null,
        setup: setupHints(repos.length > 0, jiraConfigured),
      };
    }

    let login: string | undefined;
    let teamsCache: Cached<string[]> | undefined;
    let viewerLookup: Promise<Viewer> | null = null;

    /**
     * The GitHub login, read once per process, and the login's teams, read
     * hourly. A failed team lookup keeps the teams read last and is retried
     * an hour later. Concurrent callers share one lookup.
     */
    function viewer(): Promise<Viewer> {
      if (login !== undefined && fresh(teamsCache, TEAMS_TTL_MS, deps.now())) {
        return Promise.resolve({ login, teams: teamsCache.value });
      }
      viewerLookup ??= lookUpViewer().finally(() => {
        viewerLookup = null;
      });
      return viewerLookup;
    }

    async function lookUpViewer(): Promise<Viewer> {
      if (login === undefined) {
        const read = (await gh(["api", "user", "--jq", ".login"])).trim();
        if (read.length === 0) throw new Error("gh api user returned no login");
        login = read;
      }
      let teams = teamsCache?.value ?? [];
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
        bb.log.warn(`could not list GitHub teams; team review requests use the last list read: ${errorMessage(error)}`);
      }
      teamsCache = { value: teams, at: deps.now() };
      return { login, teams };
    }

    /** Every page of a repository's open PRs from `query`. */
    async function openPullPages<T>(repo: string, query: string, parse: (raw: string) => Page<T>): Promise<T[]> {
      const [owner, name] = repo.split("/");
      const items: T[] = [];
      let cursor: string | null = null;
      do {
        const args = ["api", "graphql", "-f", `owner=${owner}`, "-f", `name=${name}`, "-f", `query=${query}`];
        const page = parse(await gh(cursor === null ? args : [...args, "-f", `cursor=${cursor}`], GRAPHQL_TIMEOUT_MS));
        items.push(...page.items);
        cursor = page.next;
      } while (cursor !== null);
      return items;
    }

    /**
     * The output of an aliased GraphQL lookup. GitHub answers a lookup naming
     * a PR or repository it cannot resolve with the rest of the data and an
     * error, and gh then prints that answer and exits non-zero; that answer is
     * returned as well. Any other failure, an answer without data included,
     * rejects with gh's error.
     */
    async function graphqlLookup(query: string): Promise<string> {
      try {
        return await gh(["api", "graphql", "-f", `query=${query}`], GRAPHQL_TIMEOUT_MS);
      } catch (error) {
        if (error instanceof CommandError && hasLookupData(error.stdout)) return error.stdout;
        throw error;
      }
    }

    interface RepoPulls {
      pulls: FingerprintedPull[];
      at: number;
      fullAt: number;
    }

    const pullsCache = new Map<string, RepoPulls>();

    /**
     * A repository's open PRs, most recently updated first, from memory for
     * `QUEUE_TTL_MS`. `refresh`, a first read, and a read `FULL_READ_MS` after
     * the last full one read every PR in full; any other read fetches each
     * PR's fingerprint and re-reads only the PRs that are new or changed.
     */
    async function openPulls(repo: string, refresh: boolean): Promise<PullSnapshot[]> {
      const cached = pullsCache.get(repo);
      const now = deps.now();
      if (!refresh && cached !== undefined && now - cached.at < QUEUE_TTL_MS) return cached.pulls.map(({ pull }) => pull);
      let read: RepoPulls;
      if (refresh || cached === undefined || now - cached.fullAt >= FULL_READ_MS) {
        const pulls = await openPullPages(repo, OPEN_PULLS_QUERY, (raw) => parseOpenPulls(repo, raw));
        read = { pulls, at: deps.now(), fullAt: deps.now() };
      } else {
        read = { pulls: await changedPulls(repo, cached.pulls), at: deps.now(), fullAt: cached.fullAt };
      }
      pullsCache.set(repo, read);
      return read.pulls.map(({ pull }) => pull);
    }

    /**
     * The repository's open PRs in `OPEN_PULL_HEADS_QUERY` order: each PR of
     * `previous` whose fingerprint is unchanged as it was, and each new or
     * changed PR read again in full.
     */
    async function changedPulls(repo: string, previous: readonly FingerprintedPull[]): Promise<FingerprintedPull[]> {
      const heads = await openPullPages(repo, OPEN_PULL_HEADS_QUERY, parseOpenPullHeads);
      const known = new Map(previous.map((entry) => [entry.pull.number, entry]));
      const unchanged = (head: { number: number; fingerprint: string }) =>
        known.get(head.number)?.fingerprint === head.fingerprint;
      const changed: PullRef[] = heads.filter((head) => !unchanged(head)).map((head) => ({ repo, number: head.number }));
      const pages = await Promise.all(
        chunks(changed, LOOKUP_PAGE_SIZE).map(async (page) => parsePullDetails(await graphqlLookup(pullDetailsQuery(page)), page)),
      );
      const details = new Map(pages.flatMap((page) => [...page]));
      return heads.flatMap((head) => {
        const entry = unchanged(head) ? known.get(head.number) : details.get(pullKey(repo, head.number));
        return entry === undefined || entry === null ? [] : [entry];
      });
    }

    let githubPanelCache: Cached<boolean> | undefined;
    async function githubPanel(): Promise<boolean> {
      if (fresh(githubPanelCache, QUEUE_TTL_MS, deps.now())) return githubPanelCache.value;
      let available = false;
      try {
        const { plugins } = await bb.sdk.plugins.list();
        available = plugins.some(
          (plugin) => plugin.id === GITHUB_PLUGIN_ID && plugin.enabled && plugin.status === "running",
        );
      } catch (error) {
        bb.log.warn(`could not list plugins: ${errorMessage(error)}`);
      }
      githubPanelCache = { value: available, at: deps.now() };
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

    async function userMessages(threadId: string): Promise<UserMessage[]> {
      const history = await bb.sdk.threads.promptHistory({ threadId });
      return [...history]
        .sort((left, right) => left.createdAt - right.createdAt)
        .map((entry) => ({
          createdAt: entry.createdAt,
          text: entry.input
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n")
            .trim(),
        }));
    }

    /**
     * When the review command was last sent to the thread: by `runReview`, or
     * typed into a message. Each message is scanned for the command once, and
     * the result is kept in the plugin database, so a review stays known after
     * its message leaves the prompt history bb returns.
     */
    function lastReviewAt(threadId: string, messages: readonly UserMessage[]): number | null {
      const { reviewedAt, scannedThrough } = store.review(threadId);
      const unscanned = messages.filter((message) => message.createdAt > scannedThrough);
      const newest = unscanned.at(-1);
      if (newest === undefined) return reviewedAt;
      const found = unscanned.filter((message) => isReviewMessage(message.text, REVIEW_COMMAND)).at(-1);
      store.recordReview(threadId, found?.createdAt ?? null, newest.createdAt);
      return found === undefined ? reviewedAt : Math.max(found.createdAt, reviewedAt ?? 0);
    }

    /** The live (not deleted) threads among `threadIds`, by id, read with one `threads.list` call per 200 ids. */
    async function liveThreads(threadIds: readonly string[]): Promise<Map<string, ThreadRow>> {
      const pages = await Promise.all(
        chunks([...new Set(threadIds)], THREAD_LIST_PAGE_SIZE).map((page) =>
          bb.sdk.threads.list({ threadIds: page, includeHidden: true, limit: page.length }),
        ),
      );
      return new Map(pages.flat().map((thread) => [thread.id, thread]));
    }

    /**
     * Prompt history by thread, with the thread's `updatedAt` when it was
     * read. bb moves `updatedAt` forward whenever a message is added, so the
     * history is read again only after it moves.
     */
    const historyCache = new Map<string, { updatedAt: number; messages: UserMessage[] }>();

    async function cachedUserMessages(thread: ThreadRow): Promise<UserMessage[]> {
      const cached = historyCache.get(thread.id);
      if (cached !== undefined && cached.updatedAt === thread.updatedAt) return cached.messages;
      try {
        const messages = await userMessages(thread.id);
        historyCache.set(thread.id, { updatedAt: thread.updatedAt, messages });
        return messages;
      } catch (error) {
        bb.log.warn(`could not read prompt history for ${thread.id}: ${errorMessage(error)}`);
        return [];
      }
    }

    /** Each of `threadIds` with its row and agent state, from one thread lookup. */
    async function threadInfos(threadIds: readonly string[]): Promise<Map<string, ThreadInfo>> {
      const threads = await liveThreads(threadIds);
      const infos = await Promise.all(
        [...new Set(threadIds)].map(async (threadId): Promise<[string, ThreadInfo]> => {
          const thread = threads.get(threadId) ?? null;
          if (thread === null) return [threadId, { thread, agent: { state: "none", threadId: null } }];
          const messages = await cachedUserMessages(thread);
          const isRunning = thread.status === "active" || thread.status === "starting";
          const reviewedAt = lastReviewAt(threadId, messages);
          return [threadId, { thread, agent: { state: agentState({ userMessages: messages, reviewedAt, isRunning }), threadId } }];
        }),
      );
      return new Map(infos);
    }

    function reviewQueue(refresh: boolean) {
      return queueWithThreads(refresh).then(({ queue }) => queue);
    }

    /**
     * The review queue, and the row and agent state of each queued PR's
     * review thread and each of `threadIds`, from one thread lookup. A
     * repository whose open PRs cannot be read is listed in `errors`, and
     * contributes its last PRs read when `staleOnError` is set, or none.
     */
    async function queueWithThreads(refresh: boolean, staleOnError = false, threadIds: readonly string[] = []) {
      const { repos, projectKeys, setup } = await config();
      const me = await viewer();
      const errors: Array<{ repo: string; message: string }> = [];
      const pulls = (
        await Promise.all(
          repos.map(async (repo) => {
            try {
              return await openPulls(repo, refresh);
            } catch (error) {
              errors.push({ repo, message: errorMessage(error) });
              return staleOnError ? (pullsCache.get(repo)?.pulls.map(({ pull }) => pull) ?? []) : [];
            }
          }),
        )
      ).flat();
      const reviewThreads = store.threadsForPulls(pulls.map((pull) => pullKey(pull.repo, pull.number)));
      const threads = await threadInfos([...reviewThreads.values(), ...threadIds]);
      const agentFor = (pull: PullSnapshot): QueueEntry["agent"] => {
        const threadId = reviewThreads.get(pullKey(pull.repo, pull.number));
        return (threadId === undefined ? undefined : threads.get(threadId)?.agent) ?? { state: "none", threadId: null };
      };
      const links = stackLinks(pulls);
      const sorted = sortQueue(
        pulls.map((pull) => ({ pull, classified: classifyPull(pull, me) })),
        links,
      );
      const entries = sorted.map(
        ({ pull, classified }): QueueEntry => ({
          repo: pull.repo,
          number: pull.number,
          title: pull.title,
          url: pull.url,
          isDraft: pull.isDraft,
          author: pull.author,
          authorAvatarUrl: pull.authorAvatarUrl,
          headRefName: pull.headRefName,
          baseRefName: pull.baseRefName,
          ...links.get(pullKey(pull.repo, pull.number))!,
          ticketKey: ticketKey(pull, projectKeys)?.key ?? null,
          additions: pull.additions,
          deletions: pull.deletions,
          changedFiles: pull.changedFiles,
          conflicting: pull.conflicting,
          failingChecks: pull.failingChecks,
          pendingReviewers: pull.requestedUsers.length + pull.requestedTeams.length,
          me: classified.me,
          bucket: classified.bucket,
          otherReviews: classified.otherReviews,
          agent: agentFor(pull),
        }),
      );
      const queue = {
        viewer: me.login,
        fetchedAt: new Date().toISOString(),
        githubPanel: await githubPanel(),
        entries,
        tickets: await tickets(entries.map((entry) => entry.ticketKey)),
        errors,
        setup,
      };
      return { queue, threads };
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
      if (found.size > 0) publishRefs({ tickets: [...found.keys()] });
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

    async function computeSidebarGroups(): Promise<{ value: SidebarGroupsResult; errors: string[] }> {
      const threadTickets = store.ticketThreads();
      const { queue, threads } = await queueWithThreads(false, true, [...threadTickets.keys()]);
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
            .filter((entry) => entry.agent.threadId === null && entry.bucket !== "approved" && entry.me !== "author")
            .map(async (entry) => {
              const projectId = await projectFor(entry.repo);
              return projectId === null ? null : { projectId, entry };
            }),
        )
      ).filter((pull) => pull !== null);
      const queued = new Map(queue.entries.map((entry) => [pullKey(entry.repo, entry.number), entry]));
      const reviews = await threadReviews([...threadTickets.keys()], queued, threads);
      const threadReviewRows = [...reviews].flatMap(([threadId, { pull, agent }]) =>
        pull === null ? [] : [{ threadId, number: pull.number, pullState: pull.state, agent: agent.state }],
      );
      const result: SidebarGroupsResult = {
        tickets: await tickets([...queue.tickets.map((ticket) => ticket.key), ...threadTickets.values()]),
        threadTickets: [...threadTickets].map(([threadId, ticketKey]) => ({ threadId, ticketKey })),
        pulls,
        threadPulls: queue.entries.flatMap((entry) =>
          entry.agent.threadId === null ? [] : [{ threadId: entry.agent.threadId, entry }],
        ),
        threadReviews: threadReviewRows,
      };
      return {
        value: result,
        errors: queue.errors.map((error) => `${error.repo}: ${error.message}`),
      };
    }

    let sidebarCache: (Cached<SidebarGroupsResult> & { generation: number }) | undefined;
    let sidebarRefresh: Promise<SidebarGroupsResult> | null = null;
    let sidebarGeneration = 0;
    let sidebarFailing = false;
    let sidebarThrewAt: number | null = null;

    /** Marks the sidebar result stale and tells the app's views that refs changed. */
    function publishRefs(payload: Record<string, unknown>): void {
      sidebarGeneration++;
      bb.realtime.publish(REFS_CHANNEL, payload);
    }

    function sidebarFailure(message: string): void {
      if (!sidebarFailing) bb.log.warn(`sidebar groups are serving the last result read: ${message}`);
      sidebarFailing = true;
    }

    /**
     * Refreshes the sidebar result. Concurrent callers share one refresh. A
     * refresh whose inputs change while it runs runs again, so it resolves
     * with a result as new as the call. A failure is logged once until a
     * refresh succeeds.
     */
    function refreshSidebarGroups(): Promise<SidebarGroupsResult> {
      sidebarRefresh ??= (async () => {
        try {
          for (let pass = 1; ; pass++) {
            const generation = sidebarGeneration;
            const { value, errors } = await computeSidebarGroups();
            sidebarCache = { value, at: deps.now(), generation };
            sidebarThrewAt = null;
            if (errors.length > 0) sidebarFailure(errors.join("; "));
            else if (sidebarFailing) {
              bb.log.info("sidebar groups refreshed after GitHub errors");
              sidebarFailing = false;
            }
            if (generation === sidebarGeneration || pass === SIDEBAR_MAX_REFRESH_PASSES) return value;
          }
        } catch (error) {
          sidebarFailure(errorMessage(error));
          sidebarThrewAt = deps.now();
          throw error;
        } finally {
          sidebarRefresh = null;
        }
      })();
      return sidebarRefresh;
    }

    /**
     * The sidebar result, from memory while it is fresh. A stale or missing
     * result is refreshed in the background; the call waits for that refresh
     * only briefly, then returns the last result, or no groups, and publishes
     * `REFS_CHANNEL` once the refresh lands. After a failed refresh, calls
     * return the last result without retrying until `SIDEBAR_TTL_MS` passes.
     */
    async function sidebarGroups(): Promise<SidebarGroupsResult> {
      const cached = sidebarCache;
      const now = deps.now();
      if (cached !== undefined && cached.generation === sidebarGeneration && now - cached.at < SIDEBAR_TTL_MS) {
        return cached.value;
      }
      const fallback = cached?.value ?? NO_SIDEBAR_GROUPS;
      if (sidebarRefresh === null && sidebarThrewAt !== null && now - sidebarThrewAt < SIDEBAR_TTL_MS) {
        return fallback;
      }
      const refresh = refreshSidebarGroups();
      const outcome = await settleWithin(refresh, cached === undefined ? SIDEBAR_FIRST_WAIT_MS : SIDEBAR_STALE_WAIT_MS);
      if (outcome.kind === "pending") {
        refresh.then(
          () => bb.realtime.publish(REFS_CHANNEL, {}),
          () => undefined,
        );
      }
      return outcome.kind === "resolved" ? outcome.value : fallback;
    }

    async function issueTitle(key: string): Promise<string | null> {
      const parsed = parseRepoKey(key);
      if (parsed === null) return null;
      try {
        return parseIssueTitle(
          await gh(["issue", "view", String(parsed.number), "-R", parsed.repo, "--json", "title"]),
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
        await gh(["pr", "checkout", String(pull.number), "-R", repo], CHECKOUT_TIMEOUT_MS, path);
      } catch (error) {
        const branch = `review/pr-${pull.number}`;
        bb.log.info(`gh pr checkout ${pull.number} failed (${errorMessage(error)}); retrying as ${branch}`);
        await gh(["pr", "checkout", String(pull.number), "-R", repo, "--branch", branch, "--force"], CHECKOUT_TIMEOUT_MS, path);
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
        title: reviewTitle(number, resolved.pull.title, resolved.ticket?.key ?? null),
        prompt: contextPrompt({ repo, ...resolved }),
        pluginMetadata: { repo, number },
      });
      store.record(thread.id, resolved.refs);
      publishRefs({ threadId: thread.id });
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
      store.recordReview(threadId, deps.now(), 0);
      publishRefs({ threadId });
      return { delivery: result.delivery };
    }

    const environmentLookups = new Map<string, Cached<null>>();
    async function refsFromEnvironment(threadId: string, environmentId: string): Promise<ThreadRef[]> {
      if (fresh(environmentLookups.get(threadId), QUEUE_TTL_MS * 20, deps.now())) return [];
      environmentLookups.set(threadId, { value: null, at: deps.now() });
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

    const pullStates = new Map<string, Cached<NonNullable<RelatedPullState>>>();
    const pullStateFailures = new Map<string, number>();

    /**
     * Each of `pulls`' state from GitHub, by `pullKey`, read with one GraphQL
     * call per `LOOKUP_PAGE_SIZE` PRs. Merged and closed states are kept for
     * good, open and draft ones for `QUEUE_TTL_MS`. A PR whose state cannot
     * be read is null. A PR GitHub cannot resolve is read again after
     * `PULL_STATE_RETRY_MS`; after any other failure, on the next call.
     */
    async function pullStatesFor(pulls: readonly PullRef[]): Promise<Map<string, RelatedPullState>> {
      const now = deps.now();
      const states = new Map<string, RelatedPullState>();
      const due: PullRef[] = [];
      for (const pull of pulls) {
        const key = pullKey(pull.repo, pull.number);
        if (states.has(key)) continue;
        const cached = pullStates.get(key);
        const failedAt = pullStateFailures.get(key);
        if (cached !== undefined && (cached.value === "merged" || cached.value === "closed" || fresh(cached, QUEUE_TTL_MS, now))) {
          states.set(key, cached.value);
          continue;
        }
        states.set(key, null);
        if (failedAt === undefined || now - failedAt >= PULL_STATE_RETRY_MS) due.push(pull);
      }
      await Promise.all(
        chunks(due, LOOKUP_PAGE_SIZE).map(async (page) => {
          let read: Map<string, NonNullable<RelatedPullState> | null>;
          try {
            read = parsePullStates(await graphqlLookup(pullStatesQuery(page)), page);
          } catch (error) {
            bb.log.warn(`could not read the state of ${page.length} PRs: ${errorMessage(error)}`);
            return;
          }
          const unread: string[] = [];
          for (const pull of page) {
            const key = pullKey(pull.repo, pull.number);
            const state = read.get(key) ?? null;
            if (state === null) {
              pullStateFailures.set(key, deps.now());
              unread.push(key);
              continue;
            }
            pullStateFailures.delete(key);
            pullStates.set(key, { value: state, at: deps.now() });
            states.set(key, state);
          }
          if (unread.length > 0) bb.log.warn(`GitHub could not resolve ${unread.join(", ")}`);
        }),
      );
      return states;
    }

    function isReviewPull(ref: ThreadRef): boolean {
      return ref.kind === "gh-pr" && (ref.source === "review-target" || ref.source === "environment");
    }

    interface ThreadReview {
      pull: RelatedItem["pull"];
      title: string | null;
      agent: QueueEntry["agent"];
    }

    /**
     * For each of `threadIds`: the PR it reviews, with its state, the PR's
     * title as recorded, and the thread's agent state from `threads`. `pull`
     * is null for a thread that does not review a PR. The states of PRs that
     * are not in `queued` are read from GitHub together.
     */
    async function threadReviews(
      threadIds: readonly string[],
      queued: ReadonlyMap<string, QueueEntry>,
      threads: ReadonlyMap<string, ThreadInfo>,
    ): Promise<Map<string, ThreadReview>> {
      const targets = threadIds.map((threadId) => {
        const ref = store.forThread(threadId).find(isReviewPull);
        const parsed = ref === undefined ? null : parseRepoKey(ref.key);
        return { threadId, ref, parsed };
      });
      const states = await pullStatesFor(
        targets.flatMap(({ ref, parsed }) => (ref === undefined || parsed === null || queued.has(ref.key) ? [] : [parsed])),
      );
      return new Map(
        targets.map(({ threadId, ref, parsed }): [string, ThreadReview] => {
          const agent = threads.get(threadId)?.agent ?? { state: "none", threadId: null };
          if (ref === undefined || parsed === null) return [threadId, { pull: null, title: null, agent }];
          const entry = queued.get(ref.key);
          const state = entry === undefined ? (states.get(ref.key) ?? null) : queuedPullState(entry);
          return [threadId, { pull: { ...parsed, url: ref.url, state }, title: entry?.title ?? ref.title, agent }];
        }),
      );
    }

    /**
     * PRs and threads that share a ticket with `threadId`: each other thread
     * with that ticket ref, with its PR's state when it has one, and each open
     * PR on the ticket that has no such thread and is not the viewer's.
     */
    async function relatedThreads(threadId: string): Promise<RelatedResult> {
      const ownRefs = store.forThread(threadId);
      const tickets = ownRefs.filter((ref) => ref.kind === "jira").map((ref) => ref.key);
      if (tickets.length === 0) return { githubPanel: await githubPanel(), tickets, items: [] };
      const ownPulls = new Set(ownRefs.filter(isReviewPull).map((ref) => ref.key));
      const others = [...new Set(tickets.flatMap((key) => store.threadsWith("jira", key)))].filter(
        (other) => other !== threadId,
      );
      const { queue, threads } = await queueWithThreads(false, false, others);
      const queued = new Map(queue.entries.map((entry) => [pullKey(entry.repo, entry.number), entry]));
      const live = others.flatMap((otherId) => {
        const thread = threads.get(otherId)?.thread ?? null;
        return thread === null ? [] : [{ otherId, thread }];
      });
      const reviews = await threadReviews(live.map(({ otherId }) => otherId), queued, threads);
      const threadItems = live.map(({ otherId, thread }): RelatedItem => {
        const threadTitle = thread.title ?? thread.titleFallback ?? otherId;
        const { pull, title, agent } = reviews.get(otherId)!;
        return { title: pull === null ? threadTitle : withoutTickets(title ?? threadTitle, tickets), pull, agent };
      });
      return { githubPanel: queue.githubPanel, tickets, items: relatedItems(threadItems, queue.entries, tickets, ownPulls) };
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
      if (/^\d+$/.test(value)) {
        if (defaultRepo !== undefined) return { repo: defaultRepo, number: Number(value) };
        throw new PluginCliError(`"${value}" needs a repository: no repositories are configured`, {
          code: "invalid_pull",
          hint: `${REPOS_SETUP_HINT} Or pass owner/repo#n or a PR URL.`,
        });
      }
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
              const setup = queue.setup.map((hint) => `setup\t${hint}`);
              return { exitCode: 0, stdout: [...setup, ...lines, ...errors].map((line) => `${line}\n`).join("") };
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
            summary: "List the other PRs and threads that share a ticket with a thread",
            positionals: [{ name: "threadId", description: "Thread id", required: true }],
            options: jsonOption,
            async run(input) {
              const result = await relatedThreads(input.positionals.threadId);
              if (input.options.json) return { exitCode: 0, stdout: `${JSON.stringify(result)}\n` };
              const lines = result.items.map((item) =>
                [
                  item.pull === null ? "-" : pullKey(item.pull.repo, item.pull.number),
                  item.pull?.state ?? "-",
                  item.agent.state,
                  item.agent.threadId ?? "-",
                  item.title,
                ].join("\t"),
              );
              return { exitCode: 0, stdout: lines.map((line) => `${line}\n`).join("") };
            },
          }),
        },
      }),
    );
  };
}

export default createPlugin(defaultDeps);
