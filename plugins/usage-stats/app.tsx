import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  definePluginApp,
  experimental_useCodeTheme,
  useBbNavigate,
  useRealtime,
  useRpc,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import { USAGE_CHANNEL } from "./channel";
import { ThreadDrawer } from "./drawer";
import { STYLES } from "./styles";
import {
  HBarChart,
  Legend,
  LineChart,
  PercentSpark,
  SplitBar,
  StackedBarChart,
  TooltipProvider,
  type SplitPart,
} from "./charts";
import type { Dashboard, RangeDays, Source, Subscription, ThreadSort, rpcContract } from "./contract";
import { formatPercent, formatTokens, formatUsd, providerLabel } from "./format";
import { cacheHitRatio } from "./pricing";
import {
  chartSeries,
  dayValues,
  deltaText,
  errorMessage,
  parseDay,
  perTurnUsd,
  relativeTime,
  resetText,
  timeLabel,
  type Load,
  type Metric,
  type StackBy,
} from "./view";

const PANEL_PATH = "usage";
const RANGES: readonly { days: RangeDays; label: string }[] = [
  { days: 1, label: "Today" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
];
const SOURCES: readonly { source: Source; label: string; subPath: string }[] = [
  { source: "all", label: "All sources", subPath: "" },
  { source: "bb", label: "bb threads", subPath: "bb" },
  { source: "outside", label: "Outside bb", subPath: "outside" },
];
const PROVIDER_COLORS = ["--series-1", "--series-2", "--series-3", "--series-4"] as const;

function sourceOf(subPath: string): Source {
  return SOURCES.find((entry) => entry.subPath === subPath.split("/")[0])?.source ?? "all";
}

const dayLabel = (day: string) => parseDay(day).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const dayDetail = (day: string) =>
  parseDay(day).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

function ThemedRoot({ children, className }: { children: ReactNode; className?: string }) {
  const { mode } = experimental_useCodeTheme();
  return (
    <div className={className ?? "us-root"} data-theme={mode}>
      <style>{STYLES}</style>
      {children}
    </div>
  );
}

function useDashboard(days: RangeDays, source: Source, sort: ThreadSort): Load<Dashboard> {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<Load<Dashboard>>({ status: "loading" });
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let live = true;
    rpc
      .call("dashboard", { days, source, sort })
      .then((value) => live && setState({ status: "ready", value }))
      .catch((error: unknown) => live && setState({ status: "error", message: errorMessage(error) }));
    return () => {
      live = false;
    };
  }, [rpc, days, source, sort, version]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useRealtime(USAGE_CHANNEL, () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setVersion((value) => value + 1), 1_000);
  });
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);
  return state;
}

function Seg<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="us-seg" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={String(option.value)} type="button" aria-pressed={option.value === value} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Tile({ label, value, delta, badge }: { label: string; value: string; delta: ReactNode; badge?: ReactNode }) {
  return (
    <div className="us-card us-tile us-s3">
      <div className="us-label">
        {label}
        {badge}
      </div>
      <div className="us-value">{value}</div>
      <div className="us-delta">{delta}</div>
    </div>
  );
}

const API_EQUIVALENT_HINT =
  "Token counts priced at API list rates. A subscription plan is not billed per token, so this is what the same usage would cost on the API.";

function Kpis({ data }: { data: Dashboard }) {
  const { current, previous, rangeDays } = data;
  const perTurn = perTurnUsd(current);
  return (
    <>
      <Tile
        label="Cost"
        badge={
          <span className="us-badge" title={API_EQUIVALENT_HINT}>
            API-equivalent
          </span>
        }
        value={formatUsd(current.costUsd)}
        delta={deltaText(current.costUsd, previous.costUsd, rangeDays) ?? "no earlier usage to compare"}
      />
      <Tile
        label="Tokens"
        value={formatTokens(current.tokens)}
        delta={[`${formatTokens(current.output)} output`, deltaText(current.tokens, previous.tokens, rangeDays)].filter(Boolean).join(" · ")}
      />
      <Tile
        label="Cache hit ratio"
        value={formatPercent(cacheHitRatio(current))}
        delta={`saved ≈ ${formatUsd(current.savedUsd)} vs uncached`}
      />
      <Tile
        label="Turns · threads"
        value={`${current.turns.toLocaleString()} · ${current.threads.toLocaleString()}`}
        delta={perTurn === null ? "no turns" : `${formatUsd(perTurn)} per turn avg`}
      />
    </>
  );
}

function UsageByDay({ data }: { data: Dashboard }) {
  const [stack, setStack] = useState<StackBy>("model");
  const [metric, setMetric] = useState<Metric>("tokens");
  const [table, setTable] = useState(false);
  const series = useMemo(() => chartSeries(stack, data.days, data.models), [stack, data.days, data.models]);
  const format = metric === "tokens" ? formatTokens : formatUsd;
  const bars = data.days.map((day, index) => ({
    key: day.day,
    label: dayLabel(day.day),
    detail: dayDetail(day.day),
    values: dayValues(day, stack, metric, data.models),
    muted: data.rangeDays === 1 && index !== data.days.length - 1,
  }));
  const title = `${metric === "tokens" ? "Tokens" : "Cost"} by day`;
  return (
    <div className="us-card us-s8">
      <div className="us-card-head">
        <div>
          <h2>{title}</h2>
          <div className="us-sub">
            Stacked by {stack === "model" ? "model" : "token type"}
            {data.rangeDays === 1 ? " · last 7 days shown, today highlighted" : ""}
          </div>
        </div>
        <Seg label="Stack by" value={stack} onChange={setStack} options={[{ value: "model", label: "Model" }, { value: "type", label: "Token type" }]} />
        <Seg label="Metric" value={metric} onChange={setMetric} options={[{ value: "tokens", label: "Tokens" }, { value: "cost", label: "Cost" }]} />
        <div className="us-seg">
          <button type="button" aria-pressed={table} onClick={() => setTable(!table)}>
            Table
          </button>
        </div>
      </div>
      <Legend series={series} />
      {table ? (
        <div style={{ maxHeight: 260, overflow: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Day</th>
                {series.map((s) => (
                  <th key={s.key} className="us-num">
                    {s.label}
                  </th>
                ))}
                <th className="us-num">Total</th>
              </tr>
            </thead>
            <tbody>
              {[...bars].reverse().map((bar) => (
                <tr key={bar.key}>
                  <td>{bar.label}</td>
                  {series.map((s) => (
                    <td key={s.key} className="us-num">
                      {format(bar.values[s.key] ?? 0)}
                    </td>
                  ))}
                  <td className="us-num">{format(series.reduce((sum, s) => sum + (bar.values[s.key] ?? 0), 0))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <StackedBarChart bars={bars} series={series} format={format} label={`${title}, stacked bar chart`} />
      )}
    </div>
  );
}

function windowTone(usedPercent: number): { color: string; text: string } {
  if (usedPercent >= 90) return { color: "--critical", text: "⬤ Near limit" };
  if (usedPercent >= 75) return { color: "--warning", text: "▲ High" };
  return { color: "--good", text: "✓ OK" };
}

function SubscriptionCard({ subscriptions }: { subscriptions: readonly Subscription[] }) {
  const now = Date.now();
  return (
    <div className="us-card us-s4">
      <h2>Subscription windows</h2>
      {subscriptions.length === 0 ? (
        <div className="us-sub">No provider reported a usage window yet. Samples are taken every 10 minutes.</div>
      ) : (
        subscriptions.map((subscription) => (
          <div key={subscription.provider}>
            <div className="us-sub">
              {[providerLabel(subscription.provider), subscription.plan].filter(Boolean).join(" · ")} · sampled{" "}
              {relativeTime(subscription.sampledAt, now)}
            </div>
            {subscription.windows.map((window) => {
              const tone = windowTone(window.usedPercent);
              return (
                <div className="us-meter" key={window.label}>
                  <div className="us-meter-row">
                    <span>{window.label}</span>
                    <span>{Math.round(window.usedPercent)}%</span>
                  </div>
                  <div
                    className="us-bar"
                    role="meter"
                    aria-label={window.label}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(window.usedPercent)}
                  >
                    <div className="us-fill" style={{ width: `${Math.min(100, window.usedPercent)}%`, background: `var(${tone.color})` }} />
                  </div>
                  <div className="us-meter-foot">
                    <span style={{ color: `var(${tone.color})` }}>{tone.text}</span>
                    <span>{resetText(window.resetsAt, now)}</span>
                  </div>
                </div>
              );
            })}
            {subscription.series !== null && subscription.series.points.length > 1 && (
              <PercentSpark
                points={subscription.series.points.map((point) => ({ ts: point.ts, value: point.usedPercent }))}
                caption={`${subscription.series.label}, last 7 days`}
                formatTime={timeLabel}
              />
            )}
          </div>
        ))
      )}
      <div className="us-note">Percent used per window, as the provider reports it. Sampled every 10 minutes so the line has history.</div>
    </div>
  );
}

function ProjectsCard({ data }: { data: Dashboard }) {
  const total = data.projects.reduce((sum, project) => sum + project.costUsd, 0);
  return (
    <div className="us-card us-s5">
      <h2>Cost by project</h2>
      <div className="us-sub">Top 8 · rest folded into Other</div>
      {data.projects.length === 0 ? (
        <div className="us-empty">No usage in this range</div>
      ) : (
        <HBarChart
          label="Cost by project, bar chart"
          format={formatUsd}
          bars={data.projects.map((project) => ({
            key: project.name,
            label: project.name,
            value: project.costUsd,
            muted: project.isOther,
            tooltip: {
              title: project.name,
              rows: [
                { label: "Cost", value: formatUsd(project.costUsd) },
                { label: "Share", value: formatPercent(total === 0 ? null : project.costUsd / total) },
                { label: "Tokens", value: formatTokens(project.tokens) },
                { label: "Threads", value: project.threads.toLocaleString() },
              ],
            },
          }))}
        />
      )}
    </div>
  );
}

function CacheCard({ data }: { data: Dashboard }) {
  const points = data.days.map((day) => {
    const tokens = day.models.reduce(
      (sum, slice) => ({
        input: sum.input + slice.input,
        cacheRead: sum.cacheRead + slice.cacheRead,
        cacheWrite: sum.cacheWrite + slice.cacheWrite,
      }),
      { input: 0, cacheRead: 0, cacheWrite: 0 },
    );
    return { key: day.day, label: dayLabel(day.day), value: cacheHitRatio(tokens) };
  });
  const values = points.flatMap((point) => (point.value === null ? [] : [point.value]));
  const lowest = values.length === 0 ? 0.8 : Math.min(...values);
  const step = 1 - lowest > 0.5 ? 0.2 : 1 - lowest > 0.2 ? 0.1 : 0.05;
  const low = Math.max(0, Math.floor(lowest / step) * step);
  const ticks = Array.from({ length: Math.round((1 - low) / step) + 1 }, (_, index) => low + index * step);
  return (
    <div className="us-card us-s4">
      <h2>Cache hit ratio by day</h2>
      <div className="us-sub">cache read ÷ (input + cache read + cache write)</div>
      <LineChart
        points={points}
        domain={[low, 1]}
        ticks={ticks}
        format={(value) => formatPercent(value, 0)}
        label="Cache hit ratio by day, line chart"
        valueLabel="Cache hit ratio"
      />
    </div>
  );
}

function ProvidersCard({ data }: { data: Dashboard }) {
  const total = data.providers.reduce((sum, provider) => sum + provider.costUsd, 0);
  const parts: SplitPart[] = data.providers.map((provider, index) => ({
    key: provider.provider,
    label: providerLabel(provider.provider),
    value: provider.costUsd,
    color: PROVIDER_COLORS[index] ?? "--other",
    detail: `${formatUsd(provider.costUsd)} · ${formatPercent(total === 0 ? null : provider.costUsd / total, 0)}`,
  }));
  return (
    <div className="us-card us-s3">
      <h2>By provider</h2>
      <div className="us-sub">Share of cost</div>
      <SplitBar parts={parts} label="Share of cost by provider" />
      <div className="us-note">
        Claude Code transcripts are priced per message here. Other providers use the cost bb reports for each thread, which
        is empty for models bb has no price for.
      </div>
    </div>
  );
}

function ThreadsCard({
  data,
  sort,
  onSort,
  selected,
  onSelect,
}: {
  data: Dashboard;
  sort: ThreadSort;
  onSort: (sort: ThreadSort) => void;
  selected: string | null;
  onSelect: (key: string) => void;
}) {
  const now = Date.now();
  const value = (row: Dashboard["threads"][number]) => (sort === "cost" ? row.costUsd : sort === "tokens" ? row.tokens : row.turns);
  const max = Math.max(0, ...data.threads.map(value));
  const format = sort === "cost" ? formatUsd : sort === "tokens" ? formatTokens : (n: number) => n.toLocaleString();
  return (
    <div className="us-card us-s12">
      <div className="us-card-head">
        <div>
          <h2>Top threads</h2>
          <div className="us-sub">Click a row for the per-turn breakdown</div>
        </div>
        <Seg
          label="Sort threads"
          value={sort}
          onChange={onSort}
          options={[
            { value: "cost", label: "Cost" },
            { value: "tokens", label: "Tokens" },
            { value: "turns", label: "Turns" },
          ]}
        />
      </div>
      {data.threads.length === 0 ? (
        <div className="us-empty">No usage in this range</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Thread</th>
                <th>Project</th>
                <th>Provider</th>
                <th className="us-num">Turns</th>
                <th className="us-num">Tokens</th>
                <th className="us-num">Cache hit</th>
                <th style={{ width: 170 }}>{sort === "cost" ? "Cost" : sort === "tokens" ? "Tokens" : "Turns"}</th>
                <th className="us-num">Last active</th>
              </tr>
            </thead>
            <tbody>
              {data.threads.map((row) => (
                <tr
                  key={row.key}
                  className={`us-click${selected === row.key ? " us-sel" : ""}`}
                  tabIndex={0}
                  onClick={() => onSelect(row.key)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelect(row.key);
                    }
                  }}
                >
                  <td>
                    <span className="us-name" title={row.title}>
                      {row.title}
                    </span>
                    {row.threadId === null && (
                      <span className="us-pill" title="Claude Code session started outside bb">
                        outside bb
                      </span>
                    )}
                  </td>
                  <td>{row.project ?? "–"}</td>
                  <td>{providerLabel(row.provider)}</td>
                  <td className="us-num">{row.turns.toLocaleString()}</td>
                  <td className="us-num">{formatTokens(row.tokens)}</td>
                  <td className="us-num">{formatPercent(row.cacheHit)}</td>
                  <td>
                    <span className="us-ibar" style={{ width: Math.max(3, max === 0 ? 3 : (100 * value(row)) / max) }} />
                    {format(value(row))}
                  </td>
                  <td className="us-num">{relativeTime(row.lastTs, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function UsagePage({ subPath }: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  const source = sourceOf(subPath);
  const [days, setDays] = useState<RangeDays>(30);
  const [sort, setSort] = useState<ThreadSort>("cost");
  const [selected, setSelected] = useState<string | null>(null);
  const state = useDashboard(days, source, sort);
  const close = useCallback(() => setSelected(null), []);
  const setSource = (next: Source) =>
    navigate.toPluginPanel(PANEL_PATH, { subPath: SOURCES.find((entry) => entry.source === next)?.subPath ?? "" });
  return (
    <ThemedRoot>
      <TooltipProvider>
        <div className="us-scroll">
          <main className="us-main">
            <div className="us-topbar">
              <h1>Usage</h1>
              <Seg label="Time range" value={days} onChange={setDays} options={RANGES.map((range) => ({ value: range.days, label: range.label }))} />
              <Seg label="Source" value={source} onChange={setSource} options={SOURCES.map((entry) => ({ value: entry.source, label: entry.label }))} />
              <div className="us-spacer" />
              <span className="us-muted us-small">
                {state.status === "ready" && state.value.importedAt !== null
                  ? `Updated ${relativeTime(state.value.importedAt, Date.now())} · API-equivalent cost`
                  : "API-equivalent cost"}
              </span>
            </div>
            {state.status === "loading" && <div className="us-empty">Loading usage…</div>}
            {state.status === "error" && <div className="us-empty">{state.message}</div>}
            {state.status === "ready" && (
              <div className="us-grid12">
                <Kpis data={state.value} />
                <UsageByDay data={state.value} />
                <SubscriptionCard subscriptions={state.value.subscriptions} />
                <ProjectsCard data={state.value} />
                <CacheCard data={state.value} />
                <ProvidersCard data={state.value} />
                <ThreadsCard data={state.value} sort={sort} onSort={setSort} selected={selected} onSelect={setSelected} />
              </div>
            )}
          </main>
        </div>
        {selected !== null && (
          <ThreadDrawer
            threadKey={selected}
            modelKeys={state.status === "ready" ? state.value.models : []}
            onClose={close}
          />
        )}
      </TooltipProvider>
    </ThemedRoot>
  );
}

function UsageSidebar({ subPath }: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  const source = sourceOf(subPath);
  const state = useDashboard(30, "all", "cost");
  const counts = state.status === "ready" ? state.value.sources : null;
  const count = (entry: Source) =>
    counts === null ? "" : entry === "bb" ? counts.bbThreads : entry === "outside" ? counts.outsideSessions : counts.bbThreads + counts.outsideSessions;
  return (
    <ThemedRoot className="us-root us-side-root">
      <nav className="us-side" aria-label="Usage sources">
        <h3>Sources · 30 days</h3>
        {SOURCES.map((entry) => (
          <button
            key={entry.source}
            type="button"
            aria-current={entry.source === source ? "page" : undefined}
            onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: entry.subPath })}
          >
            <span>{entry.label}</span>
            <span>{count(entry.source)}</span>
          </button>
        ))}
      </nav>
    </ThemedRoot>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "usage",
    title: "Usage",
    icon: "ChartColumn",
    path: PANEL_PATH,
    component: UsagePage,
    experimental_sidebar: UsageSidebar,
  });
});
