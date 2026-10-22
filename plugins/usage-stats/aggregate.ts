import type Database from "better-sqlite3";
import type {
  Dashboard,
  DayUsage,
  ModelKey,
  ModelSlice,
  ProjectRow,
  ProviderRow,
  RangeDays,
  Source,
  Subscription,
  ThreadDetail,
  ThreadRow,
  ThreadSort,
  Totals,
} from "./contract.js";
import { cacheHitRatio, cacheSavingsUsd, modelLabel } from "./pricing.js";

const DAY_MS = 86_400_000;
const TOP_PROJECTS = 8;
const TOP_THREADS = 25;
const MAX_DETAIL_TURNS = 300;
const SERIES_DAYS = 7;
const LONGEST_RANGE_DAYS = 90;

export interface Range {
  since: number;
  until: number;
}

function startOfLocalDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function addLocalDays(ms: number, days: number): number {
  const date = new Date(ms);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

/** `days` whole local days ending with today. */
export function rangeEndingToday(days: number, now: number): Range {
  const tomorrow = addLocalDays(startOfLocalDay(now), 1);
  return { since: addLocalDays(tomorrow, -days), until: tomorrow };
}

/** The same number of days directly before `range`. */
export function previousRange(range: Range, days: number): Range {
  return { since: addLocalDays(range.since, -days), until: range.since };
}

export function localDayKey(ms: number): string {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

const THREAD_KEY = `COALESCE('thread:' || tid, 'session:' || session_id)`;

function sourceFilter(source: Source, column: string): string {
  if (source === "bb") return `AND ${column} IS NOT NULL`;
  if (source === "outside") return `AND ${column} IS NULL`;
  return "";
}

/** Effective usage rows in a range, filtered by source, as CTE `e`. */
function scoped(source: Source): string {
  return `WITH e AS (
    SELECT *, ${THREAD_KEY} AS key, input + output + cache_read + cache_write AS tokens
    FROM usage_effective
    WHERE ts >= @since AND ts < @until ${sourceFilter(source, "tid")}
  )`;
}

interface ModelSumRow {
  model: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cost: number;
  unpriced: number;
}

const MODEL_SUMS = `model, SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cache_read,
  SUM(cache_write) AS cache_write, SUM(COALESCE(cost_usd, 0)) AS cost,
  SUM(CASE WHEN cost_usd IS NULL THEN tokens ELSE 0 END) AS unpriced`;

function toSlice(row: ModelSumRow): ModelSlice {
  return {
    model: row.model,
    input: row.input,
    output: row.output,
    cacheRead: row.cache_read,
    cacheWrite: row.cache_write,
    costUsd: row.cost,
  };
}

/** Prompts per thread key, plus one turn per distinct ledger turn. */
function turnsByKey(db: Database.Database, source: Source, range: Range): Map<string, number> {
  const turns = new Map<string, number>();
  const prompts = db
    .prepare<Range, { key: string; n: number }>(
      `SELECT COALESCE('thread:' || s.thread_id, 'session:' || p.session_id) AS key, COUNT(*) AS n
       FROM prompts p LEFT JOIN thread_sessions s ON s.session_id = p.session_id
       WHERE p.ts >= @since AND p.ts < @until ${sourceFilter(source, "s.thread_id")}
       GROUP BY key`,
    )
    .all(range);
  const ledger = db
    .prepare<Range, { key: string; n: number }>(
      `${scoped(source)} SELECT key, COUNT(DISTINCT turn_id) AS n FROM e WHERE source = 'ledger' GROUP BY key`,
    )
    .all(range);
  for (const row of [...prompts, ...ledger]) turns.set(row.key, (turns.get(row.key) ?? 0) + row.n);
  return turns;
}

function sumTotals(slices: readonly ModelSumRow[], turns: number, threads: number): Totals {
  const totals: Totals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: 0,
    tokens: 0,
    unpricedTokens: 0,
    savedUsd: 0,
    turns,
    threads,
  };
  for (const row of slices) {
    totals.input += row.input;
    totals.output += row.output;
    totals.cacheRead += row.cache_read;
    totals.cacheWrite += row.cache_write;
    totals.costUsd += row.cost;
    totals.unpricedTokens += row.unpriced;
    totals.savedUsd += cacheSavingsUsd(row.model, row.cache_read);
  }
  totals.tokens = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
  return totals;
}

export function modelSlices(db: Database.Database, source: Source, range: Range): ModelSlice[] {
  return db
    .prepare<Range, ModelSumRow>(`${scoped(source)} SELECT ${MODEL_SUMS} FROM e GROUP BY model ORDER BY cost DESC, model`)
    .all(range)
    .map(toSlice);
}

export function totalsFor(db: Database.Database, source: Source, range: Range): Totals {
  const models = db
    .prepare<Range, ModelSumRow>(`${scoped(source)} SELECT ${MODEL_SUMS} FROM e GROUP BY model`)
    .all(range);
  const threads = db
    .prepare<Range, { n: number }>(`${scoped(source)} SELECT COUNT(DISTINCT key) AS n FROM e`)
    .get(range);
  let turns = 0;
  for (const n of turnsByKey(db, source, range).values()) turns += n;
  return sumTotals(models, turns, threads?.n ?? 0);
}

/**
 * Every model of the longest range, most tokens first. The first four keep a
 * color slot whatever range or source is shown, so a filter never repaints a
 * model.
 */
export function modelKeys(db: Database.Database, now: number): ModelKey[] {
  return db
    .prepare<Range, { model: string }>(
      `SELECT model FROM usage_effective WHERE ts >= @since AND ts < @until GROUP BY model
       ORDER BY SUM(input + output + cache_read + cache_write) DESC, model`,
    )
    .all(rangeEndingToday(LONGEST_RANGE_DAYS, now))
    .map((row, index) => ({ model: row.model, label: modelLabel(row.model), slot: index < 4 ? index : null }));
}

export function usageByDay(db: Database.Database, source: Source, range: Range): DayUsage[] {
  const rows = db
    .prepare<Range, ModelSumRow & { day: string }>(
      `${scoped(source)} SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch', 'localtime') AS day, ${MODEL_SUMS}
       FROM e GROUP BY day, model`,
    )
    .all(range);
  const byDay = new Map<string, ModelSlice[]>();
  for (const row of rows) {
    const slices = byDay.get(row.day) ?? [];
    slices.push(toSlice(row));
    byDay.set(row.day, slices);
  }
  const days: DayUsage[] = [];
  for (let at = range.since; at < range.until; at = addLocalDays(at, 1)) {
    const day = localDayKey(at);
    days.push({ day, models: byDay.get(day) ?? [] });
  }
  return days;
}

export function costByProject(db: Database.Database, source: Source, range: Range): ProjectRow[] {
  const rows = db
    .prepare<Range, { name: string; cost: number; tokens: number; threads: number }>(
      `${scoped(source)} SELECT COALESCE(th.project_name, e.project, 'Unknown') AS name,
         SUM(COALESCE(e.cost_usd, 0)) AS cost, SUM(e.tokens) AS tokens, COUNT(DISTINCT e.key) AS threads
       FROM e LEFT JOIN threads th ON th.thread_id = e.tid
       GROUP BY name ORDER BY cost DESC, tokens DESC`,
    )
    .all(range);
  const top = rows.slice(0, rows.length > TOP_PROJECTS + 1 ? TOP_PROJECTS : rows.length);
  const rest = rows.slice(top.length);
  const result: ProjectRow[] = top.map((row) => ({
    name: row.name,
    costUsd: row.cost,
    tokens: row.tokens,
    threads: row.threads,
    isOther: false,
  }));
  if (rest.length > 0) {
    result.push({
      name: `Other (${rest.length})`,
      costUsd: rest.reduce((sum, row) => sum + row.cost, 0),
      tokens: rest.reduce((sum, row) => sum + row.tokens, 0),
      threads: rest.reduce((sum, row) => sum + row.threads, 0),
      isOther: true,
    });
  }
  return result;
}

export function costByProvider(db: Database.Database, source: Source, range: Range): ProviderRow[] {
  return db
    .prepare<Range, ProviderRow>(
      `${scoped(source)} SELECT provider, SUM(COALESCE(cost_usd, 0)) AS costUsd, SUM(tokens) AS tokens
       FROM e GROUP BY provider ORDER BY costUsd DESC, tokens DESC`,
    )
    .all(range);
}

interface ThreadSumRow {
  key: string;
  tid: string | null;
  session_id: string | null;
  provider: string;
  project: string | null;
  cost: number;
  tokens: number;
  input: number;
  cache_read: number;
  cache_write: number;
  last: number;
  thread_title: string | null;
  thread_project: string | null;
  session_title: string | null;
}

function threadTitle(row: Pick<ThreadSumRow, "tid" | "thread_title" | "session_title" | "session_id">): string {
  return row.thread_title ?? row.session_title ?? (row.tid !== null ? row.tid : `Session ${row.session_id?.slice(0, 8) ?? ""}`);
}

export function topThreads(db: Database.Database, source: Source, range: Range, sort: ThreadSort): ThreadRow[] {
  const rows = db
    .prepare<Range, ThreadSumRow>(
      `${scoped(source)} SELECT e.key, e.tid, MAX(e.session_id) AS session_id, MAX(e.provider) AS provider,
         MAX(e.project) AS project, SUM(COALESCE(e.cost_usd, 0)) AS cost, SUM(e.tokens) AS tokens,
         SUM(e.input) AS input, SUM(e.cache_read) AS cache_read, SUM(e.cache_write) AS cache_write,
         MAX(e.ts) AS last, th.title AS thread_title, th.project_name AS thread_project,
         st.title AS session_title
       FROM e
       LEFT JOIN threads th ON th.thread_id = e.tid
       LEFT JOIN session_titles st ON st.session_id = e.session_id AND e.tid IS NULL
       GROUP BY e.key`,
    )
    .all(range);
  const turns = turnsByKey(db, source, range);
  const threads: ThreadRow[] = rows.map((row) => ({
    key: row.key,
    threadId: row.tid,
    title: threadTitle(row),
    project: row.thread_project ?? row.project,
    provider: row.provider,
    turns: turns.get(row.key) ?? 0,
    tokens: row.tokens,
    costUsd: row.cost,
    cacheHit: cacheHitRatio({ input: row.input, cacheRead: row.cache_read, cacheWrite: row.cache_write }),
    lastTs: row.last,
  }));
  const value = (row: ThreadRow) => (sort === "cost" ? row.costUsd : sort === "tokens" ? row.tokens : row.turns);
  return threads.sort((left, right) => value(right) - value(left) || right.lastTs - left.lastTs).slice(0, TOP_THREADS);
}

export function subscriptions(db: Database.Database, now: number): Subscription[] {
  const latest = db
    .prepare<[], { provider: string; ts: number }>(
      `SELECT provider, MAX(ts) AS ts FROM window_samples GROUP BY provider ORDER BY provider`,
    )
    .all();
  return latest.map(({ provider, ts }) => {
    const windows = db
      .prepare<[string, number], { label: string; used_percent: number; resets_at: string | null; plan: string | null }>(
        `SELECT label, used_percent, resets_at, plan FROM window_samples WHERE provider = ? AND ts = ? ORDER BY label`,
      )
      .all(provider, ts);
    // The window that resets last is the longest; on a tie, a weekly window wins.
    const longest = [...windows].sort(
      (left, right) =>
        (right.resets_at ?? "").localeCompare(left.resets_at ?? "") ||
        Number(/week/i.test(right.label)) - Number(/week/i.test(left.label)),
    )[0];
    const points =
      longest === undefined
        ? []
        : db
            .prepare<[string, string, number], { ts: number; used_percent: number }>(
              `SELECT ts, used_percent FROM window_samples WHERE provider = ? AND label = ? AND ts >= ? ORDER BY ts`,
            )
            .all(provider, longest.label, now - SERIES_DAYS * DAY_MS);
    return {
      provider,
      plan: windows.find((window) => window.plan !== null)?.plan ?? null,
      sampledAt: ts,
      windows: windows.map((window) => ({
        label: window.label,
        usedPercent: window.used_percent,
        resetsAt: window.resets_at,
      })),
      series:
        longest === undefined
          ? null
          : { label: longest.label, points: points.map((point) => ({ ts: point.ts, usedPercent: point.used_percent })) },
    };
  });
}

function sourceCounts(db: Database.Database, range: Range): Dashboard["sources"] {
  const row = db
    .prepare<Range, { bb: number; outside: number }>(
      `${scoped("all")} SELECT COUNT(DISTINCT tid) AS bb,
         COUNT(DISTINCT CASE WHEN tid IS NULL THEN session_id END) AS outside FROM e`,
    )
    .get(range);
  return { bbThreads: row?.bb ?? 0, outsideSessions: row?.outside ?? 0 };
}

export interface DashboardInput {
  days: RangeDays;
  source: Source;
  sort: ThreadSort;
}

export function dashboard(db: Database.Database, input: DashboardInput, now: number): Dashboard {
  const range = rangeEndingToday(input.days, now);
  const chartRange = rangeEndingToday(Math.max(input.days, 7), now);
  const importedAt = db.prepare<[], { value: string }>(`SELECT value FROM meta WHERE key = 'importedAt'`).get();
  return {
    rangeDays: input.days,
    source: input.source,
    current: totalsFor(db, input.source, range),
    previous: totalsFor(db, input.source, previousRange(range, input.days)),
    models: modelKeys(db, now),
    days: usageByDay(db, input.source, chartRange),
    projects: costByProject(db, input.source, range),
    providers: costByProvider(db, input.source, range),
    threads: topThreads(db, input.source, range, input.sort),
    subscriptions: subscriptions(db, now),
    sources: sourceCounts(db, range),
    importedAt: importedAt === undefined ? null : Number(importedAt.value),
  };
}

interface DetailRow {
  ts: number;
  source: "transcript" | "ledger";
  session_id: string | null;
  turn_id: string | null;
  model: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cost_usd: number | null;
  provider: string;
  project: string | null;
}

interface TurnAccumulator {
  ts: number;
  costUsd: number;
  tokens: number;
}

/**
 * Splits a thread's rows into turns. A transcript message belongs to the
 * session's latest prompt at or before it; a ledger row is its own turn.
 */
export function splitTurns(
  rows: readonly DetailRow[],
  promptsBySession: ReadonlyMap<string, readonly number[]>,
): TurnAccumulator[] {
  const turns = new Map<string, TurnAccumulator>();
  for (const row of rows) {
    let key: string;
    let start = row.ts;
    if (row.source === "ledger") {
      key = `ledger:${row.session_id ?? ""}:${row.turn_id ?? row.ts}`;
    } else {
      const prompts = promptsBySession.get(row.session_id ?? "") ?? [];
      let latest: number | undefined;
      for (const prompt of prompts) {
        if (prompt > row.ts) break;
        latest = prompt;
      }
      start = latest ?? prompts[0] ?? row.ts;
      key = `prompt:${row.session_id ?? ""}:${start}`;
    }
    const turn = turns.get(key) ?? { ts: start, costUsd: 0, tokens: 0 };
    turn.ts = Math.min(turn.ts, row.ts, start);
    turn.costUsd += row.cost_usd ?? 0;
    turn.tokens += row.input + row.output + row.cache_read + row.cache_write;
    turns.set(key, turn);
  }
  return [...turns.values()].sort((left, right) => left.ts - right.ts);
}

export function threadDetail(db: Database.Database, key: string): ThreadDetail | null {
  const [kind, id = ""] = key.split(/:(.*)/s, 2);
  const isThread = kind === "thread";
  const match = isThread ? "tid = ?" : "session_id = ? AND tid IS NULL";
  const rows = db
    .prepare<[string], DetailRow>(
      `SELECT ts, source, session_id, turn_id, model, input, output, cache_read, cache_write, cost_usd, provider, project
       FROM usage_effective WHERE ${match} ORDER BY ts`,
    )
    .all(id);
  const thread = isThread
    ? db
        .prepare<[string], { title: string | null; project_name: string | null; provider: string }>(
          `SELECT title, project_name, provider FROM threads WHERE thread_id = ?`,
        )
        .get(id)
    : undefined;
  if (rows.length === 0 && thread === undefined) return null;

  const sessionIds = isThread
    ? db.prepare<[string], { session_id: string }>(`SELECT session_id FROM thread_sessions WHERE thread_id = ? ORDER BY session_id`).all(id).map((row) => row.session_id)
    : [id];
  const promptsBySession = new Map<string, number[]>();
  const selectPrompts = db.prepare<[string], { ts: number }>(`SELECT ts FROM prompts WHERE session_id = ? ORDER BY ts`);
  for (const sessionId of sessionIds) {
    promptsBySession.set(sessionId, selectPrompts.all(sessionId).map((row) => row.ts));
  }

  const turns = splitTurns(rows, promptsBySession);
  const sessionTitle = isThread
    ? undefined
    : db.prepare<[string], { title: string }>(`SELECT title FROM session_titles WHERE session_id = ?`).get(id);
  const models = db
    .prepare<[string], ModelSumRow>(
      `WITH e AS (SELECT *, input + output + cache_read + cache_write AS tokens FROM usage_effective WHERE ${match})
       SELECT ${MODEL_SUMS} FROM e GROUP BY model ORDER BY cost DESC, model`,
    )
    .all(id);
  return {
    key,
    threadId: isThread ? id : null,
    sessionIds,
    title: threadTitle({
      tid: isThread ? id : null,
      thread_title: thread?.title ?? null,
      session_title: sessionTitle?.title ?? null,
      session_id: isThread ? null : id,
    }),
    project: thread?.project_name ?? [...rows].reverse().find((row) => row.project !== null)?.project ?? null,
    provider: thread?.provider ?? rows[0]?.provider ?? "claude-code",
    totals: sumTotals(models, turns.length, 1),
    turns: turns.slice(-MAX_DETAIL_TURNS).map((turn, index, kept) => ({
      index: turns.length - kept.length + index + 1,
      ts: turn.ts,
      costUsd: turn.costUsd,
      tokens: turn.tokens,
    })),
    models: models.map(toSlice),
    lastTs: rows.at(-1)?.ts ?? null,
  };
}
