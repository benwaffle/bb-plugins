import { useCallback, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import {
  definePluginApp,
  experimental_Icon as Icon,
  experimental_useSidebarThreads,
  useBbNavigate,
  useRealtime,
  useRpc,
  type BbNavigate,
  type PluginThreadHeaderActionProps,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { REFS_CHANNEL } from "./channel";
import type {
  QueueEntry,
  QueueResult as Queue,
  RelatedResult as Related,
  RefsResult as Refs,
  SidebarGroupsResult,
  Ticket,
  ThreadRef,
  rpcContract,
} from "./contract";
import { githubPanelPath, QUEUE_PANEL_ACTION_ID, reviewDockedPanels, type ReviewDockedPanel } from "./links";
import { ticketGroups } from "./sidebar";

type Load<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; value: T };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function openExternal(navigate: BbNavigate, url: string): void {
  if (!navigate.openUrl(url)) window.open(url, "_blank", "noopener");
}

function openPull(navigate: BbNavigate, githubPanel: boolean, key: string, url: string): void {
  const path = githubPanel ? githubPanelPath(key) : null;
  if (path === null) {
    openExternal(navigate, url);
    return;
  }
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

type ToThreadWithDockedPanels = (
  threadId: string,
  options?: { experimental_dockedPanels?: readonly ReviewDockedPanel[] },
) => void;

function openReviewThread(navigate: BbNavigate, threadId: string, number: number | null, githubPanel: boolean): void {
  const toThread: ToThreadWithDockedPanels = navigate.toThread;
  toThread(threadId, { experimental_dockedPanels: reviewDockedPanels(number, githubPanel) });
}

const ME_LABELS: Record<QueueEntry["me"], string> = {
  author: "author",
  requested: "requested",
  approved: "approved",
  "approved-stale": "approved, new commits",
  "changes-requested": "changes requested",
  commented: "commented",
  none: "—",
};

const AGENT_LABELS: Record<QueueEntry["agent"]["state"], string> = {
  none: "—",
  opened: "opened",
  reviewing: "reviewing",
  "brief-ready": "brief ready",
  "follow-ups": "follow-ups",
};

const REVIEW_GLYPHS: Record<QueueEntry["otherReviews"][number]["state"], string> = {
  APPROVED: "✓",
  CHANGES_REQUESTED: "✗",
  COMMENTED: "💬",
  DISMISSED: "–",
  PENDING: "…",
};

const buttonClass =
  "inline-flex h-7 items-center rounded-md border border-border px-2 text-xs outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
const linkClass = "text-left underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring rounded-sm";
const iconButtonClass =
  "inline-flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring";

function stopping(action: () => void) {
  return (event: MouseEvent) => {
    event.stopPropagation();
    action();
  };
}

function Avatar({ login, url }: { login: string; url: string | null }) {
  if (url === null) return null;
  return <img src={url} alt="" title={login} width={16} height={16} className="size-4 shrink-0 rounded-full" />;
}

function User({ login, url }: { login: string; url: string | null }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <Avatar login={login} url={url} />
      <span className="truncate">{login}</span>
    </span>
  );
}

function DraftBadge() {
  return (
    <span className="inline-flex h-4 shrink-0 items-center rounded border border-border px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      Draft
    </span>
  );
}

function QueueRow({
  entry,
  ticket,
  githubPanel,
  starting,
  onReview,
}: {
  entry: QueueEntry;
  ticket: Ticket | undefined;
  githubPanel: boolean;
  starting: boolean;
  onReview: (entry: QueueEntry) => void;
}) {
  const navigate = useBbNavigate();
  const key = `${entry.repo}#${entry.number}`;
  const review = () => {
    if (!starting) onReview(entry);
  };
  return (
    <tr
      className={`cursor-pointer border-b border-border align-top outline-none last:border-b-0 hover:bg-accent/50 focus-visible:bg-accent/50 ${
        entry.isDraft ? "text-muted-foreground" : ""
      }`}
      tabIndex={0}
      aria-busy={starting}
      onClick={review}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          review();
        }
      }}
    >
      <td className="py-2 pr-3">
        <div className={`flex items-center gap-1.5 ${entry.isDraft ? "" : "font-medium"}`}>
          {entry.isDraft ? <DraftBadge /> : null}
          <span>
            #{entry.number} {entry.title}
          </span>
        </div>
        <div className="text-xs text-muted-foreground">
          <User login={entry.author} url={entry.authorAvatarUrl} />
        </div>
      </td>
      <td className="py-2 pr-3 whitespace-nowrap">
        {entry.ticketKey === null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <button
            type="button"
            className={linkClass}
            title={ticket?.summary ?? entry.ticketKey}
            onClick={stopping(() => ticket !== undefined && openExternal(navigate, ticket.url))}
          >
            {entry.ticketKey}
          </button>
        )}
      </td>
      <td className="py-2 pr-3 whitespace-nowrap tabular-nums">
        <span className="text-green-600 dark:text-green-400">+{entry.additions}</span>{" "}
        <span className="text-red-600 dark:text-red-400">−{entry.deletions}</span>
        <div className="text-xs text-muted-foreground">{entry.changedFiles} files</div>
      </td>
      <td className="py-2 pr-3">
        {entry.otherReviews.length === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <ul className="space-y-0.5 text-xs">
            {entry.otherReviews.map((review) => (
              <li
                key={review.login}
                className="flex items-center gap-1"
                title={review.state.toLowerCase().replace("_", " ")}
              >
                <span aria-hidden>{REVIEW_GLYPHS[review.state]}</span>
                <User login={review.login} url={review.avatarUrl} />
              </li>
            ))}
          </ul>
        )}
      </td>
      <td className="py-2 pr-3 whitespace-nowrap">
        <span className={entry.me === "approved-stale" ? "font-medium text-amber-600 dark:text-amber-400" : ""}>
          {ME_LABELS[entry.me]}
        </span>
      </td>
      <td className="py-2 pr-3 whitespace-nowrap">{AGENT_LABELS[entry.agent.state]}</td>
      <td className="py-2">
        <div className="flex items-center justify-end gap-0.5">
          <button type="button" className={buttonClass} disabled={starting} onClick={stopping(review)}>
            {starting ? "Starting…" : entry.agent.threadId === null ? "Review" : "Open"}
          </button>
          {githubPanel ? (
            <button
              type="button"
              className={iconButtonClass}
              title="Open in the GitHub panel"
              aria-label="Open in the GitHub panel"
              onClick={stopping(() => openPull(navigate, true, key, entry.url))}
            >
              <Icon name="GitPullRequest" className="size-3.5" aria-hidden />
            </button>
          ) : null}
          <button
            type="button"
            className={iconButtonClass}
            title="Open on github.com"
            aria-label="Open on github.com"
            onClick={stopping(() => openExternal(navigate, entry.url))}
          >
            <Icon name="ExternalLink" className="size-3.5" aria-hidden />
          </button>
        </div>
      </td>
    </tr>
  );
}

function QueueTable({ children }: { children: ReactNode }) {
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="border-b border-border text-left text-xs text-muted-foreground">
          <th className="py-1 pr-3 font-medium">PR</th>
          <th className="py-1 pr-3 font-medium">Ticket</th>
          <th className="py-1 pr-3 font-medium">Size</th>
          <th className="py-1 pr-3 font-medium">Reviews</th>
          <th className="py-1 pr-3 font-medium">Me</th>
          <th className="py-1 pr-3 font-medium">Agent</th>
          <th className="py-1 font-medium">
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

function useReviewQueue() {
  const rpc = useRpc<typeof rpcContract>();
  const [queue, setQueue] = useState<Load<Queue>>({ status: "loading" });
  const [tickets, setTickets] = useState<ReadonlyMap<string, Ticket>>(() => new Map());

  const load = useCallback(
    (refresh: boolean) => {
      rpc
        .call("reviewQueue", { refresh })
        .then((value) => setQueue({ status: "ready", value }))
        .catch((error: unknown) => setQueue({ status: "error", message: errorMessage(error) }));
    },
    [rpc],
  );

  useEffect(() => load(false), [load]);
  useRealtime(REFS_CHANNEL, () => load(false));

  const ticketKeys = useMemo(() => {
    if (queue.status !== "ready") return [];
    return [...new Set(queue.value.entries.flatMap((entry) => (entry.ticketKey === null ? [] : [entry.ticketKey])))];
  }, [queue]);
  const ticketKeyList = ticketKeys.join(",");

  useEffect(() => {
    if (ticketKeys.length === 0) return;
    let cancelled = false;
    rpc
      .call("tickets", { keys: ticketKeys })
      .then(({ tickets: loaded }) => {
        if (!cancelled) setTickets(new Map(loaded.map((ticket) => [ticket.key, ticket])));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [rpc, ticketKeyList]);

  const { starting, review } = useStartReview(queue.status === "ready" && queue.value.githubPanel);

  return { queue, tickets, starting, load, review };
}

function useStartReview(githubPanel: boolean) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [starting, setStarting] = useState<string | null>(null);
  const review = useCallback(
    (entry: QueueEntry) => {
      if (entry.agent.threadId !== null) {
        openReviewThread(navigate, entry.agent.threadId, entry.number, githubPanel);
        return;
      }
      const key = `${entry.repo}#${entry.number}`;
      setStarting(key);
      rpc
        .call("startReview", { repo: entry.repo, number: entry.number })
        .then(({ threadId }) => openReviewThread(navigate, threadId, entry.number, githubPanel))
        .catch((error: unknown) => toast.error(`Could not start the review: ${errorMessage(error)}`))
        .finally(() => setStarting(null));
    },
    [githubPanel, navigate, rpc],
  );
  return { starting, review };
}

interface SidebarThreadGroupRow {
  id: string;
  title: string;
  description?: string;
  tooltip?: string;
  onSelect(): void;
  action?: { label: string; run(): void };
}

interface SidebarThreadGroup {
  projectId: string;
  key: string;
  label: string;
  tooltip?: string;
  threadIds: readonly string[];
  rows: readonly SidebarThreadGroupRow[];
}

type SidebarThreadGroupsSlot = (registration: {
  id: string;
  title: string;
  useGroups(): readonly SidebarThreadGroup[];
}) => void;

const SIDEBAR_REFRESH_MS = 60_000;
const NO_SIDEBAR_GROUPS: readonly SidebarThreadGroup[] = [];

function useSidebarReviewGroups(): readonly SidebarThreadGroup[] {
  const rpc = useRpc<typeof rpcContract>();
  const { threads } = experimental_useSidebarThreads();
  const [result, setResult] = useState<SidebarGroupsResult | null>(null);
  const load = useCallback(() => {
    rpc
      .call("sidebarGroups", {})
      .then(setResult)
      .catch(() => undefined);
  }, [rpc]);
  useEffect(() => {
    load();
    const timer = setInterval(load, SIDEBAR_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);
  useRealtime(REFS_CHANNEL, () => load());
  const { starting, review } = useStartReview(result?.githubPanel ?? false);
  const projectIdByThreadId = useMemo(
    () => new Map(threads.map((thread) => [thread.id, thread.projectId])),
    [threads],
  );
  return useMemo(() => {
    if (result === null) return NO_SIDEBAR_GROUPS;
    return ticketGroups(result, projectIdByThreadId).map((group) => ({
      projectId: group.projectId,
      key: group.key,
      label: group.label,
      ...(group.tooltip === null ? {} : { tooltip: group.tooltip }),
      threadIds: group.threadIds,
      rows: group.pulls.map((entry) => {
        const key = `${entry.repo}#${entry.number}`;
        return {
          id: key,
          title: `#${entry.number} ${entry.title}`,
          description: entry.isDraft ? `${entry.author} · draft` : entry.author,
          tooltip: `${key} · +${entry.additions} −${entry.deletions} · ${ME_LABELS[entry.me]}`,
          onSelect: () => review(entry),
          action: { label: starting === key ? "Starting…" : "Start", run: () => review(entry) },
        };
      }),
    }));
  }, [projectIdByThreadId, result, review, starting]);
}

function ReviewQueuePanel() {
  const { queue, tickets, starting, load, review } = useReviewQueue();
  const [showApproved, setShowApproved] = useState(false);

  if (queue.status === "loading") {
    return <div className="p-4 text-sm text-muted-foreground md:p-5">Loading open pull requests…</div>;
  }
  if (queue.status === "error") {
    return (
      <div className="space-y-2 p-4 text-sm md:p-5">
        <p className="text-destructive">{queue.message}</p>
        <button type="button" className={buttonClass} onClick={() => load(true)}>
          Retry
        </button>
      </div>
    );
  }

  const { entries, githubPanel, errors, viewer, fetchedAt } = queue.value;
  const active = entries.filter((entry) => entry.bucket !== "approved");
  const approved = entries.filter((entry) => entry.bucket === "approved");
  const row = (entry: QueueEntry) => (
    <QueueRow
      key={`${entry.repo}#${entry.number}`}
      entry={entry}
      ticket={entry.ticketKey === null ? undefined : tickets.get(entry.ticketKey)}
      githubPanel={githubPanel}
      starting={starting === `${entry.repo}#${entry.number}`}
      onReview={review}
    />
  );

  return (
    <div className="h-full overflow-y-auto p-4 md:p-5">
      <div className="mx-auto w-full max-w-6xl space-y-4">
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>
            {active.length} to look at as {viewer} · updated {new Date(fetchedAt).toLocaleTimeString()}
          </span>
          <button type="button" className={buttonClass} onClick={() => load(true)}>
            Refresh
          </button>
        </div>
        {errors.map((error) => (
          <p key={error.repo} className="text-sm text-destructive">
            {error.repo}: {error.message}
          </p>
        ))}
        {active.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing waiting on you.</p>
        ) : (
          <QueueTable>{active.map(row)}</QueueTable>
        )}
        {approved.length === 0 ? null : (
          <section className="space-y-2">
            <button
              type="button"
              className={`${linkClass} text-sm font-medium`}
              aria-expanded={showApproved}
              onClick={() => setShowApproved((open) => !open)}
            >
              {showApproved ? "▾" : "▸"} Approved, waiting on merge ({approved.length})
            </button>
            {showApproved ? <QueueTable>{approved.map(row)}</QueueTable> : null}
          </section>
        )}
      </div>
    </div>
  );
}

function QueueColumnRow({
  entry,
  current,
  starting,
  onReview,
}: {
  entry: QueueEntry;
  current: boolean;
  starting: boolean;
  onReview: (entry: QueueEntry) => void;
}) {
  const status = entry.agent.state === "none" ? ME_LABELS[entry.me] : AGENT_LABELS[entry.agent.state];
  return (
    <li>
      <button
        type="button"
        aria-current={current ? "page" : undefined}
        disabled={starting}
        onClick={() => onReview(entry)}
        className={`w-full rounded-md px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${
          current ? "bg-accent text-accent-foreground" : ""
        }`}
      >
        <div
          className={`flex items-center gap-1.5 text-sm ${entry.isDraft ? "text-muted-foreground" : "font-medium"}`}
        >
          {entry.isDraft ? <DraftBadge /> : null}
          <span className="truncate">
            #{entry.number} {entry.title}
          </span>
        </div>
        <div className="flex items-center gap-1 truncate text-xs text-muted-foreground">
          <User login={entry.author} url={entry.authorAvatarUrl} />
          <span aria-hidden>·</span>
          <span className="tabular-nums">
            +{entry.additions} −{entry.deletions}
          </span>
          <span aria-hidden>·</span>
          <span className={entry.me === "approved-stale" ? "text-amber-600 dark:text-amber-400" : ""}>
            {starting ? "starting…" : status}
          </span>
        </div>
      </button>
    </li>
  );
}

function ReviewQueueColumn({ threadId }: PluginThreadPanelProps) {
  const { queue, starting, load, review } = useReviewQueue();
  const [showApproved, setShowApproved] = useState(false);

  if (queue.status === "loading") {
    return <p className="p-3 text-sm text-muted-foreground">Loading…</p>;
  }
  if (queue.status === "error") {
    return (
      <div className="space-y-2 p-3 text-sm">
        <p className="text-destructive">{queue.message}</p>
        <button type="button" className={buttonClass} onClick={() => load(true)}>
          Retry
        </button>
      </div>
    );
  }
  const { entries, errors } = queue.value;
  const active = entries.filter((entry) => entry.bucket !== "approved");
  const approved = entries.filter((entry) => entry.bucket === "approved");
  const row = (entry: QueueEntry) => (
    <QueueColumnRow
      key={`${entry.repo}#${entry.number}`}
      entry={entry}
      current={entry.agent.threadId === threadId}
      starting={starting === `${entry.repo}#${entry.number}`}
      onReview={review}
    />
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2 text-xs text-muted-foreground">
        <span>{active.length} to look at</span>
        <button type="button" className={buttonClass} onClick={() => load(true)}>
          Refresh
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-1 pb-3">
        {errors.map((error) => (
          <p key={error.repo} className="px-2 text-xs text-destructive">
            {error.repo}: {error.message}
          </p>
        ))}
        {active.length === 0 ? (
          <p className="px-2 text-sm text-muted-foreground">Nothing waiting on you.</p>
        ) : (
          <ul className="space-y-0.5">{active.map(row)}</ul>
        )}
        {approved.length === 0 ? null : (
          <section className="space-y-1">
            <button
              type="button"
              className={`${linkClass} px-2 text-xs font-medium text-muted-foreground`}
              aria-expanded={showApproved}
              onClick={() => setShowApproved((open) => !open)}
            >
              {showApproved ? "▾" : "▸"} Approved ({approved.length})
            </button>
            {showApproved ? <ul className="space-y-0.5">{approved.map(row)}</ul> : null}
          </section>
        )}
      </div>
    </div>
  );
}

function useThreadRefs(threadId: string): Load<Refs> {
  const rpc = useRpc<typeof rpcContract>();
  const [refs, setRefs] = useState<Load<Refs>>({ status: "loading" });
  const load = useCallback(() => {
    rpc
      .call("threadRefs", { threadId })
      .then((value) => setRefs({ status: "ready", value }))
      .catch((error: unknown) => setRefs({ status: "error", message: errorMessage(error) }));
  }, [rpc, threadId]);
  useEffect(load, [load]);
  useRealtime(REFS_CHANNEL, (payload) => {
    if (typeof payload === "object" && payload !== null && "threadId" in payload && payload.threadId === threadId) {
      load();
    }
  });
  return refs;
}

function chipLabel(ref: ThreadRef): string {
  if (ref.kind === "jira") return ref.key;
  const number = ref.key.slice(ref.key.indexOf("#"));
  if (ref.source === "sibling") return `sibling ${number}`;
  return ref.kind === "gh-issue" ? `issue ${number}` : `PR ${number}`;
}

function Chip({ threadRef, githubPanel }: { threadRef: ThreadRef; githubPanel: boolean }) {
  const navigate = useBbNavigate();
  const primary = threadRef.source === "review-target" || threadRef.source === "environment";
  return (
    <button
      type="button"
      title={threadRef.title ?? threadRef.key}
      onClick={() =>
        threadRef.kind === "gh-pr"
          ? openPull(navigate, githubPanel, threadRef.key, threadRef.url)
          : openExternal(navigate, threadRef.url)
      }
      className={`inline-flex h-6 shrink-0 items-center rounded-full border px-2 text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring ${
        primary || threadRef.kind === "jira" ? "border-border font-medium" : "border-dashed border-border text-muted-foreground"
      }`}
    >
      {chipLabel(threadRef)}
    </button>
  );
}

function WorktreeButtons({ threadId, worktree }: { threadId: string; worktree: NonNullable<Refs["worktree"]> }) {
  const rpc = useRpc<typeof rpcContract>();
  const copyPath = () => {
    void navigator.clipboard
      .writeText(worktree.path)
      .then(() => toast.success("Workspace path copied"))
      .catch(() => toast.error(worktree.path));
  };
  if (!worktree.isLocal) {
    return (
      <button type="button" className={buttonClass} title={worktree.path} onClick={copyPath}>
        Copy path
      </button>
    );
  }
  const open = (editor: "goland" | "vscode") => {
    rpc
      .call("openWorktree", { threadId, editor })
      .then((result) => {
        if (!result.opened) toast.error(result.error ?? "Could not open the workspace");
      })
      .catch((error: unknown) => toast.error(errorMessage(error)));
  };
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      <button type="button" className={buttonClass} title={worktree.path} onClick={() => open("goland")}>
        GoLand
      </button>
      <button type="button" className={buttonClass} title={worktree.path} onClick={() => open("vscode")}>
        VS Code
      </button>
    </span>
  );
}

function RunReviewButton({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [sending, setSending] = useState(false);
  const run = () => {
    setSending(true);
    rpc
      .call("runReview", { threadId })
      .then(({ delivery }) => {
        if (delivery === "queued") toast.success("Review queued after the current turn");
      })
      .catch((error: unknown) => toast.error(`Could not run the review: ${errorMessage(error)}`))
      .finally(() => setSending(false));
  };
  return (
    <button
      type="button"
      className={buttonClass}
      disabled={sending}
      title="Run the thermo-nuclear code quality review on this PR"
      onClick={run}
    >
      {sending ? "Sending…" : "Run TNCQR"}
    </button>
  );
}

function ThreadRefsHeader({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const refs = useThreadRefs(threadId);
  if (refs.status !== "ready") return null;
  const { worktree, githubPanel } = refs.value;
  const chips = isCompactViewport
    ? refs.value.refs.filter((ref) => ref.kind === "jira" || ref.source === "review-target")
    : refs.value.refs;
  const reviewable = refs.value.refs.some(
    (ref) => ref.kind === "gh-pr" && (ref.source === "review-target" || ref.source === "environment"),
  );
  if (chips.length === 0 && worktree === null) return null;
  return (
    <div className="flex max-w-[48rem] items-center gap-1 overflow-hidden">
      {chips.map((ref) => (
        <Chip key={`${ref.kind}:${ref.key}`} threadRef={ref} githubPanel={githubPanel} />
      ))}
      {reviewable ? <RunReviewButton threadId={threadId} /> : null}
      {worktree === null || isCompactViewport ? null : <WorktreeButtons threadId={threadId} worktree={worktree} />}
    </div>
  );
}

function RelatedThreadsPanel({ threadId }: PluginThreadPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [related, setRelated] = useState<Load<Related>>({ status: "loading" });
  const load = useCallback(() => {
    rpc
      .call("relatedThreads", { threadId })
      .then((value) => setRelated({ status: "ready", value }))
      .catch((error: unknown) => setRelated({ status: "error", message: errorMessage(error) }));
  }, [rpc, threadId]);
  useEffect(load, [load]);
  useRealtime(REFS_CHANNEL, () => load());

  if (related.status === "loading") return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (related.status === "error") return <p className="text-sm text-destructive">{related.message}</p>;
  const { tickets, threads } = related.value;
  if (tickets.length === 0) {
    return <p className="text-sm text-muted-foreground">This thread has no ticket ref.</p>;
  }
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">Other threads on {tickets.join(", ")}</p>
      {threads.length === 0 ? (
        <p className="text-sm text-muted-foreground">No other threads share this ticket.</p>
      ) : (
        <ul className="space-y-2">
          {threads.map((thread) => (
            <li key={thread.threadId}>
              <button
                type="button"
                onClick={() => navigate.toThread(thread.threadId)}
                className="w-full rounded-md border border-border p-2 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
              >
                <div className="text-sm font-medium">{thread.title}</div>
                {thread.pulls.length === 0 ? null : (
                  <div className="text-xs text-muted-foreground">{thread.pulls.join(", ")}</div>
                )}
                {thread.firstMessage === null ? null : (
                  <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground">
                    {thread.firstMessage}
                  </p>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  const slots: typeof app.slots & { experimental_sidebarThreadGroups?: SidebarThreadGroupsSlot } = app.slots;
  slots.experimental_sidebarThreadGroups?.({
    id: "tickets",
    title: "Review threads by ticket",
    useGroups: useSidebarReviewGroups,
  });
  app.slots.navPanel({
    id: "review-queue",
    title: "Review queue",
    icon: "GitPullRequest",
    path: "queue",
    component: ReviewQueuePanel,
  });
  app.slots.experimental_threadHeaderAction({
    id: "refs",
    title: "PR and ticket refs",
    component: ThreadRefsHeader,
  });
  app.slots.threadPanelAction({
    id: QUEUE_PANEL_ACTION_ID,
    title: "Review queue",
    icon: "GitPullRequest",
    layout: "flush",
    component: ReviewQueueColumn,
  });
  app.slots.threadPanelAction({
    id: "related",
    title: "Related threads",
    icon: "Link",
    component: RelatedThreadsPanel,
  });
});
