import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  definePluginApp,
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
  Ticket,
  ThreadRef,
  rpcContract,
} from "./contract";
import { githubPanelPath } from "./links";

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
  return (
    <tr className="border-b border-border align-top last:border-b-0">
      <td className="py-2 pr-3">
        <button
          type="button"
          className={`${linkClass} font-medium`}
          onClick={() => openPull(navigate, githubPanel, key, entry.url)}
          title={githubPanel ? "Open in the GitHub panel" : "Open on GitHub"}
        >
          #{entry.number} {entry.title}
        </button>
        <div className="text-xs text-muted-foreground">
          {entry.author}
          {entry.isDraft ? " · draft" : ""}
          {" · "}
          <button type="button" className={linkClass} onClick={() => openExternal(navigate, entry.url)}>
            GitHub
          </button>
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
            onClick={() => ticket !== undefined && openExternal(navigate, ticket.url)}
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
              <li key={review.login} title={review.state.toLowerCase().replace("_", " ")}>
                {REVIEW_GLYPHS[review.state]} {review.login}
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
      <td className="py-2 text-right">
        <button type="button" className={buttonClass} disabled={starting} onClick={() => onReview(entry)}>
          {starting ? "Starting…" : entry.agent.threadId === null ? "Review" : "Open"}
        </button>
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

function ReviewQueuePanel() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [queue, setQueue] = useState<Load<Queue>>({ status: "loading" });
  const [tickets, setTickets] = useState<ReadonlyMap<string, Ticket>>(() => new Map());
  const [showApproved, setShowApproved] = useState(false);
  const [starting, setStarting] = useState<string | null>(null);

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

  const review = useCallback(
    (entry: QueueEntry) => {
      if (entry.agent.threadId !== null) {
        navigate.toThread(entry.agent.threadId);
        return;
      }
      const key = `${entry.repo}#${entry.number}`;
      setStarting(key);
      rpc
        .call("startReview", { repo: entry.repo, number: entry.number })
        .then(({ threadId }) => navigate.toThread(threadId))
        .catch((error: unknown) => toast.error(`Could not start the review: ${errorMessage(error)}`))
        .finally(() => setStarting(null));
    },
    [navigate, rpc],
  );

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

function ThreadRefsHeader({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const refs = useThreadRefs(threadId);
  if (refs.status !== "ready") return null;
  const { worktree, githubPanel } = refs.value;
  const chips = isCompactViewport
    ? refs.value.refs.filter((ref) => ref.kind === "jira" || ref.source === "review-target")
    : refs.value.refs;
  if (chips.length === 0 && worktree === null) return null;
  return (
    <div className="flex max-w-[48rem] items-center gap-1 overflow-hidden">
      {chips.map((ref) => (
        <Chip key={`${ref.kind}:${ref.key}`} threadRef={ref} githubPanel={githubPanel} />
      ))}
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
    id: "related",
    title: "Related threads",
    icon: "Link",
    component: RelatedThreadsPanel,
  });
});
