import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import {
  definePluginApp,
  experimental_Icon as Icon,
  experimental_usePluginId,
  experimental_useSidebarThreads,
  useBbNavigate,
  useRealtime,
  useRpc,
  useSettings,
  type BbNavigate,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { REFS_CHANNEL } from "./channel";
import type {
  QueueEntry,
  QueueResult as Queue,
  RelatedResult as Related,
  SidebarGroupsResult,
  Ticket,
  rpcContract,
} from "./contract";
import { githubPanelPath, QUEUE_PANEL_ACTION_ID } from "./links";
import { titleWithoutTicket } from "./parse";
import { needsViewer, pullLabeler, queueSections, type QueueSection, type QueueSectionKey } from "./queue";
import {
  groupHeaderLook,
  pullActionLabel,
  pullRowLook,
  rejectsMinimal,
  sidebarLook,
  sidebarStyle,
  stackedThreadRow,
  threadRowDecorations,
  ticketGroups,
  TICKET_ICON,
  type GroupHeaderLook,
  type PullRowLook,
  type SidebarStyle,
  type StackedThreadRow,
  type ThreadRowDecoration,
} from "./sidebar";
import { ticketTooltip } from "./tickets";

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
  opened: "opened",
  reviewing: "reviewing",
  reviewed: "reviewed",
  "follow-ups": "follow-ups",
};

function entryTitle(entry: QueueEntry): string {
  return titleWithoutTicket(entry.title, entry.ticketKey);
}

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

function StackBadge({ entry }: { entry: QueueEntry }) {
  if (entry.parentNumber === null) return null;
  return (
    <span
      className="inline-flex h-4 shrink-0 items-center rounded border border-border px-1 text-[10px] font-normal text-muted-foreground"
      title={`Stacked on ${entry.repo}#${entry.parentNumber} (base branch ${entry.baseRefName})`}
    >
      on #{entry.parentNumber}
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
        <div className={`flex items-baseline gap-1.5 ${entry.isDraft ? "" : "font-medium"}`}>
          {entry.isDraft ? <DraftBadge /> : null}
          <span className="shrink-0">#{entry.number}</span>
          <StackBadge entry={entry} />
          <span>{entryTitle(entry)}</span>
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
            title={ticketTooltip(entry.ticketKey, ticket)}
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

const QUEUE_COLUMNS = 7;

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
      {children}
    </table>
  );
}

function ticketsByKey(tickets: readonly Ticket[]): ReadonlyMap<string, Ticket> {
  return new Map(tickets.map((ticket) => [ticket.key, ticket]));
}

function useReviewQueue() {
  const rpc = useRpc<typeof rpcContract>();
  const [queue, setQueue] = useState<Load<Queue>>({ status: "loading" });

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

  const tickets = useMemo(
    () => ticketsByKey(queue.status === "ready" ? queue.value.tickets : []),
    [queue],
  );

  const { starting, review } = useStartReview();

  return { queue, tickets, starting, load, review };
}

/** "6 need you · 19 open": PRs that wait on the viewer, and every open PR. */
function queueCount(entries: readonly QueueEntry[]): string {
  return `${entries.filter(needsViewer).length} need you · ${entries.length} open`;
}

/** Which collapsible queue sections are open; every one starts closed. */
function useOpenSections() {
  const [open, setOpen] = useState<ReadonlySet<QueueSectionKey>>(new Set());
  const isOpen = (section: QueueSection<QueueEntry>) => !section.collapsible || open.has(section.key);
  const toggle = (key: QueueSectionKey) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  return { isOpen, toggle };
}

function SectionHeading({
  section,
  open,
  onToggle,
  className,
}: {
  section: QueueSection<QueueEntry>;
  open: boolean;
  onToggle: () => void;
  className: string;
}) {
  const label = `${section.label} (${section.entries.length})`;
  if (!section.collapsible) return <span className={className}>{label}</span>;
  return (
    <button type="button" className={`${linkClass} ${className}`} aria-expanded={open} onClick={onToggle}>
      {open ? "▾" : "▸"} {label}
    </button>
  );
}

type ReviewTarget = Pick<QueueEntry, "repo" | "number" | "agent">;

function useStartReview() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [starting, setStarting] = useState<string | null>(null);
  const review = useCallback(
    (entry: ReviewTarget) => {
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
  return { starting, review };
}

interface SidebarThreadGroupRow extends PullRowLook {
  id: string;
  tooltip?: string;
  onSelect(): void;
  action?: { label: string; run(): void };
}

/**
 * A thread row the host decorates with a stack depth, description, icon,
 * trailing dot, and pull request. bb builds without these drop the entry and ignore
 * `keepOrder`, so every thread is also listed in `threadIds`.
 */
type SidebarThreadGroupThreadRow = StackedThreadRow;

interface SidebarThreadGroup extends GroupHeaderLook {
  style: SidebarStyle;
  projectId: string;
  key: string;
  tooltip?: string;
  threadIds: readonly string[];
  rows: readonly (SidebarThreadGroupRow | SidebarThreadGroupThreadRow)[];
  keepOrder?: boolean;
}

type SidebarThreadGroupsSlot = (registration: {
  id: string;
  title: string;
  useGroups(): readonly SidebarThreadGroup[];
}) => void;

/**
 * `app.slots.experimental_sidebarThreadDecoration`, typed here because SDK
 * 0.6.49 predates it. bb calls `useThreadDecoration` once per thread row it
 * shows outside the project's header, such as in flat sidebar modes.
 */
type SidebarThreadDecorationSlot = (registration: {
  id: string;
  title: string;
  useThreadDecoration(threadId: string, projectId: string): ThreadRowDecoration | null;
}) => void;

/** A group as bb reports it back; builds that draw styled groups always set `style`. */
interface ResolvedSidebarThreadGroup {
  pluginId: string;
  style?: string;
}

const NO_RESOLVED_GROUPS: readonly ResolvedSidebarThreadGroup[] = [];

/**
 * The hook bb builds with sidebar groups install for reading every plugin's
 * resolved groups. SDK 0.5.29 does not export it, so it is read from the
 * plugin runtime; it is present or absent for the life of the app.
 */
const useResolvedSidebarGroups: () => readonly ResolvedSidebarThreadGroup[] =
  (
    globalThis as {
      __bbPluginRuntime?: {
        pluginSdkApp?: { experimental_useSidebarThreadGroups?: () => readonly ResolvedSidebarThreadGroup[] };
      };
    }
  ).__bbPluginRuntime?.pluginSdkApp?.experimental_useSidebarThreadGroups ?? (() => NO_RESOLVED_GROUPS);

/**
 * The look to publish for the style chosen in the settings, from the style
 * bb reports back for this plugin's groups. Legacy until the first groups
 * are reported back, so the groups render as on older builds until then. A
 * host that once reported a minimal group back in another style keeps
 * getting card groups, since a card group's reported style does not tell
 * whether the host draws minimal ones.
 */
function useSidebarLook(): ReturnType<typeof sidebarLook> {
  const pluginId = experimental_usePluginId();
  const chosen = sidebarStyle(useSettings().values?.sidebarStyle);
  const reported = useResolvedSidebarGroups().find((group) => group.pluginId === pluginId)?.style;
  const [minimalRejected, setMinimalRejected] = useState(false);
  useEffect(() => {
    if (rejectsMinimal(reported)) setMinimalRejected(true);
  }, [reported]);
  return sidebarLook(chosen, reported, minimalRejected);
}

const SIDEBAR_REFRESH_MS = 60_000;
const NO_SIDEBAR_GROUPS: readonly SidebarThreadGroup[] = [];

/**
 * The latest `sidebarGroups` result and each thread's row decoration from
 * it. `SidebarGroupsLoader` fills it, so the ticket groups and every
 * decorated thread row share one poll.
 */
interface SidebarGroupsStore {
  set(result: SidebarGroupsResult): void;
  subscribe(listener: () => void): () => void;
  result(): SidebarGroupsResult | null;
  decoration(threadId: string): ThreadRowDecoration | null;
}

function createSidebarGroupsStore(): SidebarGroupsStore {
  let result: SidebarGroupsResult | null = null;
  let decorations = new Map<string, ThreadRowDecoration>();
  const listeners = new Set<() => void>();
  return {
    set(next) {
      result = next;
      decorations = threadRowDecorations(next);
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    result: () => result,
    decoration: (threadId) => decorations.get(threadId) ?? null,
  };
}

function SidebarGroupsLoader({ store }: { store: SidebarGroupsStore }) {
  const rpc = useRpc<typeof rpcContract>();
  const load = useCallback(() => {
    rpc
      .call("sidebarGroups", {})
      .then((result) => store.set(result))
      .catch(() => undefined);
  }, [rpc, store]);
  useEffect(() => {
    load();
    const timer = setInterval(load, SIDEBAR_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);
  useRealtime(REFS_CHANNEL, () => load());
  return null;
}

function useThreadRowDecoration(store: SidebarGroupsStore, threadId: string): ThreadRowDecoration | null {
  return useSyncExternalStore(store.subscribe, () => store.decoration(threadId));
}

function useSidebarReviewGroups(store: SidebarGroupsStore): readonly SidebarThreadGroup[] {
  const { threads } = experimental_useSidebarThreads();
  const result = useSyncExternalStore(store.subscribe, store.result);
  const { starting, review } = useStartReview();
  const { look, style } = useSidebarLook();
  const projectIdByThreadId = useMemo(
    () => new Map(threads.map((thread) => [thread.id, thread.projectId])),
    [threads],
  );
  return useMemo(() => {
    if (result === null) return NO_SIDEBAR_GROUPS;
    return ticketGroups(result, projectIdByThreadId).map((group) => ({
      projectId: group.projectId,
      key: group.key,
      ...groupHeaderLook(group, look),
      style,
      ...(group.tooltip === null ? {} : { tooltip: group.tooltip }),
      threadIds: group.threadIds,
      rows: group.items.map((item): SidebarThreadGroupRow | SidebarThreadGroupThreadRow => {
        if (item.kind === "thread") return stackedThreadRow(item.threadId, item.entry, item.review);
        const { entry } = item;
        const key = `${entry.repo}#${entry.number}`;
        const baseOf =
          entry.childNumbers.length === 0 ? [] : [`base of ${entry.childNumbers.map((n) => `#${n}`).join(", ")}`];
        return {
          id: key,
          ...pullRowLook(entry, group.pullLabel(entry.repo, entry.number), look),
          tooltip: [
            key,
            entry.author,
            `+${entry.additions} −${entry.deletions}`,
            ME_LABELS[entry.me],
            ...(entry.parentNumber === null ? [] : [`stacked on #${entry.parentNumber}`]),
            ...baseOf,
          ].join(" · "),
          onSelect: () => review(entry),
          action: { label: pullActionLabel(look, starting === key), run: () => review(entry) },
        };
      }),
      keepOrder: true,
    }));
  }, [look, projectIdByThreadId, result, review, starting, style]);
}

function ReviewQueuePanel() {
  const { queue, tickets, starting, load, review } = useReviewQueue();
  const { isOpen, toggle } = useOpenSections();

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

  const { entries, githubPanel, errors, setup, viewer, fetchedAt } = queue.value;
  const sections = queueSections(entries);
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
            {queueCount(entries)} as {viewer} · updated {new Date(fetchedAt).toLocaleTimeString()}
          </span>
          <button type="button" className={buttonClass} onClick={() => load(true)}>
            Refresh
          </button>
        </div>
        {setup.map((hint) => (
          <p key={hint} className="text-sm text-muted-foreground">
            {hint}
          </p>
        ))}
        {errors.map((error) => (
          <p key={error.repo} className="text-sm text-destructive">
            {error.repo}: {error.message}
          </p>
        ))}
        {sections.length === 0 ? (
          <p className="text-sm text-muted-foreground">No open pull requests.</p>
        ) : (
          <QueueTable>
            {sections.map((section) => (
              <tbody key={section.key}>
                <tr className="border-b border-border">
                  <th colSpan={QUEUE_COLUMNS} className="pt-4 pb-1 text-left">
                    <SectionHeading
                      section={section}
                      open={isOpen(section)}
                      onToggle={() => toggle(section.key)}
                      className="text-sm font-medium"
                    />
                  </th>
                </tr>
                {isOpen(section) ? section.entries.map(row) : null}
              </tbody>
            ))}
          </QueueTable>
        )}
      </div>
    </div>
  );
}

function QueueColumnRow({
  entry,
  label,
  current,
  starting,
  onReview,
}: {
  entry: QueueEntry;
  label: string;
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
          <span className="shrink-0">{label}</span>
          <StackBadge entry={entry} />
          <span className="truncate">{entryTitle(entry)}</span>
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
  const { isOpen, toggle } = useOpenSections();

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
  const { entries, errors, setup } = queue.value;
  const sections = queueSections(entries);
  const label = pullLabeler(entries.map((entry) => entry.repo));
  const row = (entry: QueueEntry) => (
    <QueueColumnRow
      key={`${entry.repo}#${entry.number}`}
      entry={entry}
      label={label(entry.repo, entry.number)}
      current={entry.agent.threadId === threadId}
      starting={starting === `${entry.repo}#${entry.number}`}
      onReview={review}
    />
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2 text-xs text-muted-foreground">
        <span>{queueCount(entries)}</span>
        <button type="button" className={buttonClass} onClick={() => load(true)}>
          Refresh
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-1 pb-3">
        {setup.map((hint) => (
          <p key={hint} className="px-2 text-xs text-muted-foreground">
            {hint}
          </p>
        ))}
        {errors.map((error) => (
          <p key={error.repo} className="px-2 text-xs text-destructive">
            {error.repo}: {error.message}
          </p>
        ))}
        {sections.length === 0 ? (
          <p className="px-2 text-sm text-muted-foreground">No open pull requests.</p>
        ) : (
          sections.map((section) => (
            <section key={section.key} className="space-y-1">
              <SectionHeading
                section={section}
                open={isOpen(section)}
                onToggle={() => toggle(section.key)}
                className="px-2 text-xs font-medium text-muted-foreground"
              />
              {isOpen(section) ? <ul className="space-y-0.5">{section.entries.map(row)}</ul> : null}
            </section>
          ))
        )}
      </div>
    </div>
  );
}

function RelatedItemRow({
  item,
  label,
  githubPanel,
  starting,
  onReview,
}: {
  item: Related["items"][number];
  label: string | null;
  githubPanel: boolean;
  starting: boolean;
  onReview: (target: ReviewTarget) => void;
}) {
  const navigate = useBbNavigate();
  const { pull, agent } = item;
  const open = () => {
    if (pull !== null) onReview({ repo: pull.repo, number: pull.number, agent });
    else if (agent.threadId !== null) navigate.toThread(agent.threadId);
  };
  const details = [
    ...(pull === null || pull.state === null ? [] : [pull.state]),
    ...(agent.threadId === null ? [] : [`agent ${AGENT_LABELS[agent.state]}`]),
  ];
  return (
    <li className="flex items-start gap-2 rounded-md border border-border p-2">
      <button
        type="button"
        disabled={starting}
        onClick={open}
        className="min-w-0 flex-1 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        <div className={`flex items-baseline gap-1.5 text-sm ${pull?.state === "open" ? "font-medium" : "text-muted-foreground"}`}>
          {label === null ? null : <span className="shrink-0">{label}</span>}
          <span className="hover:underline">{item.title}</span>
        </div>
        {details.length === 0 ? null : <div className="text-xs text-muted-foreground">{details.join(" · ")}</div>}
      </button>
      {pull !== null && agent.threadId === null ? (
        <button type="button" className={buttonClass} disabled={starting} onClick={open}>
          {starting ? "Starting…" : "Start"}
        </button>
      ) : null}
      {pull !== null && githubPanel ? (
        <button
          type="button"
          className={iconButtonClass}
          title="Open in the GitHub panel"
          aria-label="Open in the GitHub panel"
          onClick={() => openPull(navigate, true, `${pull.repo}#${pull.number}`, pull.url)}
        >
          <Icon name="GitPullRequest" className="size-3.5" aria-hidden />
        </button>
      ) : null}
    </li>
  );
}

function RelatedThreadsPanel({ threadId }: PluginThreadPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [related, setRelated] = useState<Load<Related>>({ status: "loading" });
  const load = useCallback(() => {
    rpc
      .call("relatedThreads", { threadId })
      .then((value) => setRelated({ status: "ready", value }))
      .catch((error: unknown) => setRelated({ status: "error", message: errorMessage(error) }));
  }, [rpc, threadId]);
  useEffect(load, [load]);
  useRealtime(REFS_CHANNEL, () => load());
  const { starting, review } = useStartReview();

  if (related.status === "loading") return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (related.status === "error") return <p className="text-sm text-destructive">{related.message}</p>;
  const { tickets, items, githubPanel } = related.value;
  const label = pullLabeler(items.flatMap((item) => (item.pull === null ? [] : [item.pull.repo])));
  if (tickets.length === 0) {
    return <p className="text-sm text-muted-foreground">This thread has no ticket ref.</p>;
  }
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">Other PRs and threads on {tickets.join(", ")}</p>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No other PRs or threads share this ticket.</p>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <RelatedItemRow
              key={item.pull === null ? item.agent.threadId : `${item.pull.repo}#${item.pull.number}:${item.agent.threadId ?? ""}`}
              item={item}
              label={item.pull === null ? null : label(item.pull.repo, item.pull.number)}
              githubPanel={githubPanel}
              starting={item.pull !== null && starting === `${item.pull.repo}#${item.pull.number}`}
              onReview={review}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function TicketIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" />
      <path d="M13 5v2M13 17v2M13 11v2" />
    </svg>
  );
}

export default definePluginApp((app) => {
  app.experimental_icons.register({ name: TICKET_ICON, component: TicketIcon });
  const slots: typeof app.slots & {
    experimental_sidebarThreadGroups?: SidebarThreadGroupsSlot;
    experimental_sidebarThreadDecoration?: SidebarThreadDecorationSlot;
  } = app.slots;
  const store = createSidebarGroupsStore();
  slots.experimental_sidebarThreadGroups?.({
    id: "tickets",
    title: "Review threads by ticket",
    useGroups: () => useSidebarReviewGroups(store),
  });
  slots.experimental_sidebarThreadDecoration?.({
    id: "tickets",
    title: "Review threads by ticket",
    useThreadDecoration: (threadId) => useThreadRowDecoration(store, threadId),
  });
  app.slots.experimental_appOverlay({
    id: "sidebar-groups",
    component: function SidebarGroupsOverlay() {
      return <SidebarGroupsLoader store={store} />;
    },
  });
  app.slots.navPanel({
    id: "review-queue",
    title: "Review queue",
    icon: "GitPullRequest",
    path: "queue",
    component: ReviewQueuePanel,
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
