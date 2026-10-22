import type Database from "better-sqlite3";
import { priceTokens, totalTokens, type UsageTokens } from "./pricing.js";
import type { TranscriptMessage, TranscriptPrompt, TranscriptTitle } from "./transcripts.js";

/**
 * Append-only: `bb.storage.migrate` applies statements by index, so new
 * schema goes at the end and shipped statements never change.
 *
 * `usage` holds one row per priced unit of work. Transcript rows are one API
 * message each, keyed by message id. Ledger rows are the growth of one bb
 * thread's per-model totals over one turn, keyed by thread, session, turn,
 * and model.
 */
export const MIGRATIONS = [
  `CREATE TABLE usage (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL CHECK (source IN ('transcript', 'ledger')),
    machine TEXT NOT NULL,
    ts INTEGER NOT NULL,
    session_id TEXT,
    thread_id TEXT,
    turn_id TEXT,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    project TEXT,
    input INTEGER NOT NULL,
    output INTEGER NOT NULL,
    cache_read INTEGER NOT NULL,
    cache_write INTEGER NOT NULL,
    cost_usd REAL
  )`,
  `CREATE INDEX usage_ts ON usage (ts)`,
  `CREATE INDEX usage_source_session ON usage (source, session_id)`,
  `CREATE TABLE prompts (
    uuid TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    ts INTEGER NOT NULL
  )`,
  `CREATE INDEX prompts_session_ts ON prompts (session_id, ts)`,
  `CREATE INDEX prompts_ts ON prompts (ts)`,
  `CREATE TABLE threads (
    thread_id TEXT PRIMARY KEY,
    title TEXT,
    project_id TEXT,
    project_name TEXT,
    provider TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE thread_sessions (
    session_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL
  )`,
  `CREATE TABLE ledger_totals (
    thread_id TEXT NOT NULL,
    session_key TEXT NOT NULL,
    model TEXT NOT NULL,
    input INTEGER NOT NULL,
    output INTEGER NOT NULL,
    cache_read INTEGER NOT NULL,
    cache_write INTEGER NOT NULL,
    cost_usd REAL,
    PRIMARY KEY (thread_id, session_key, model)
  )`,
  `CREATE TABLE transcript_files (
    machine TEXT NOT NULL,
    path TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime_ms REAL NOT NULL,
    offset INTEGER NOT NULL,
    PRIMARY KEY (machine, path)
  )`,
  `CREATE TABLE window_samples (
    provider TEXT NOT NULL,
    label TEXT NOT NULL,
    ts INTEGER NOT NULL,
    used_percent REAL NOT NULL,
    resets_at TEXT,
    plan TEXT,
    PRIMARY KEY (provider, label, ts)
  )`,
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE session_titles (
    session_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    custom INTEGER NOT NULL
  )`,
  /*
   * A bb thread's Claude Code session can show up twice: in its transcript
   * and in the ledger. The transcript is per message and timestamped, so a
   * ledger row whose session also has transcript rows is left out.
   */
  `CREATE VIEW usage_effective AS
    SELECT u.*, COALESCE(u.thread_id, s.thread_id) AS tid
    FROM usage u
    LEFT JOIN thread_sessions s ON s.session_id = u.session_id
    WHERE u.source = 'transcript'
       OR u.session_id IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM usage t WHERE t.source = 'transcript' AND t.session_id = u.session_id
       )`,
];

export interface ThreadFacts {
  threadId: string;
  title: string | null;
  projectId: string | null;
  projectName: string | null;
  provider: string;
  updatedAt: number;
}

export interface LedgerModelTotal {
  model: string;
  tokens: UsageTokens;
  costUsd: number | null;
}

/** A bb thread's cumulative per-model usage for one provider session. */
export interface LedgerSnapshot {
  threadId: string;
  sessionId: string | null;
  provider: string;
  project: string | null;
  turnId: string;
  ts: number;
  models: readonly LedgerModelTotal[];
}

export interface WindowSample {
  provider: string;
  label: string;
  ts: number;
  usedPercent: number;
  resetsAt: string | null;
  plan: string | null;
}

export interface FileCursor {
  size: number;
  mtimeMs: number;
  offset: number;
}

interface UsageRow {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cost_usd: number | null;
}

function rowTokens(row: UsageRow): UsageTokens {
  return { input: row.input, output: row.output, cacheRead: row.cache_read, cacheWrite: row.cache_write };
}

function maxTokens(a: UsageTokens, b: UsageTokens): UsageTokens {
  return {
    input: Math.max(a.input, b.input),
    output: Math.max(a.output, b.output),
    cacheRead: Math.max(a.cacheRead, b.cacheRead),
    cacheWrite: Math.max(a.cacheWrite, b.cacheWrite),
  };
}

function sameTokens(a: UsageTokens, b: UsageTokens): boolean {
  return a.input === b.input && a.output === b.output && a.cacheRead === b.cacheRead && a.cacheWrite === b.cacheWrite;
}

/**
 * Growth from `previous` to `current`. A total that went down means the
 * provider started counting again, so all of `current` is new.
 */
export function tokenGrowth(previous: UsageTokens | null, current: UsageTokens): UsageTokens {
  if (previous === null) return current;
  const reset =
    current.input < previous.input ||
    current.output < previous.output ||
    current.cacheRead < previous.cacheRead ||
    current.cacheWrite < previous.cacheWrite;
  if (reset) return current;
  return {
    input: current.input - previous.input,
    output: current.output - previous.output,
    cacheRead: current.cacheRead - previous.cacheRead,
    cacheWrite: current.cacheWrite - previous.cacheWrite,
  };
}

export type Ledger = ReturnType<typeof openLedger>;

export function openLedger(db: Database.Database) {
  const selectUsage = db.prepare<[string], UsageRow>(
    `SELECT input, output, cache_read, cache_write, cost_usd FROM usage WHERE id = ?`,
  );
  const insertUsage = db.prepare(
    `INSERT INTO usage (id, source, machine, ts, session_id, thread_id, turn_id, provider, model, project,
                        input, output, cache_read, cache_write, cost_usd)
     VALUES (@id, @source, @machine, @ts, @sessionId, @threadId, @turnId, @provider, @model, @project,
             @input, @output, @cacheRead, @cacheWrite, @costUsd)`,
  );
  const updateTokens = db.prepare(
    `UPDATE usage SET input = @input, output = @output, cache_read = @cacheRead, cache_write = @cacheWrite,
                      cost_usd = @costUsd
     WHERE id = @id`,
  );
  const insertPrompt = db.prepare(`INSERT OR IGNORE INTO prompts (uuid, session_id, ts) VALUES (?, ?, ?)`);
  const upsertTitle = db.prepare(
    `INSERT INTO session_titles (session_id, title, custom) VALUES (@sessionId, @title, @custom)
     ON CONFLICT (session_id) DO UPDATE SET title = excluded.title, custom = excluded.custom
     WHERE excluded.custom >= session_titles.custom`,
  );
  const upsertThread = db.prepare(
    `INSERT INTO threads (thread_id, title, project_id, project_name, provider, updated_at)
     VALUES (@threadId, @title, @projectId, @projectName, @provider, @updatedAt)
     ON CONFLICT (thread_id) DO UPDATE SET title = excluded.title, project_id = excluded.project_id,
       project_name = excluded.project_name, provider = excluded.provider, updated_at = excluded.updated_at`,
  );
  const selectThreadUpdatedAt = db.prepare<[string], { updated_at: number }>(
    `SELECT updated_at FROM threads WHERE thread_id = ?`,
  );
  const upsertSession = db.prepare(
    `INSERT INTO thread_sessions (session_id, thread_id) VALUES (?, ?)
     ON CONFLICT (session_id) DO UPDATE SET thread_id = excluded.thread_id`,
  );
  const selectTotal = db.prepare<[string, string, string], UsageRow>(
    `SELECT input, output, cache_read, cache_write, cost_usd FROM ledger_totals
     WHERE thread_id = ? AND session_key = ? AND model = ?`,
  );
  const upsertTotal = db.prepare(
    `INSERT INTO ledger_totals (thread_id, session_key, model, input, output, cache_read, cache_write, cost_usd)
     VALUES (@threadId, @sessionKey, @model, @input, @output, @cacheRead, @cacheWrite, @costUsd)
     ON CONFLICT (thread_id, session_key, model) DO UPDATE SET input = excluded.input, output = excluded.output,
       cache_read = excluded.cache_read, cache_write = excluded.cache_write, cost_usd = excluded.cost_usd`,
  );
  const addLedgerUsage = db.prepare(
    `INSERT INTO usage (id, source, machine, ts, session_id, thread_id, turn_id, provider, model, project,
                        input, output, cache_read, cache_write, cost_usd)
     VALUES (@id, 'ledger', 'bb', @ts, @sessionId, @threadId, @turnId, @provider, @model, @project,
             @input, @output, @cacheRead, @cacheWrite, @costUsd)
     ON CONFLICT (id) DO UPDATE SET input = input + excluded.input, output = output + excluded.output,
       cache_read = cache_read + excluded.cache_read, cache_write = cache_write + excluded.cache_write,
       cost_usd = CASE WHEN cost_usd IS NULL OR excluded.cost_usd IS NULL THEN NULL
                       ELSE cost_usd + excluded.cost_usd END`,
  );
  const selectCursor = db.prepare<[string, string], { size: number; mtime_ms: number; offset: number }>(
    `SELECT size, mtime_ms, offset FROM transcript_files WHERE machine = ? AND path = ?`,
  );
  const upsertCursor = db.prepare(
    `INSERT INTO transcript_files (machine, path, size, mtime_ms, offset) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (machine, path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms,
       offset = excluded.offset`,
  );
  const insertSample = db.prepare(
    `INSERT OR REPLACE INTO window_samples (provider, label, ts, used_percent, resets_at, plan)
     VALUES (@provider, @label, @ts, @usedPercent, @resetsAt, @plan)`,
  );
  const selectMeta = db.prepare<[string], { value: string }>(`SELECT value FROM meta WHERE key = ?`);
  const upsertMeta = db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  );

  return {
    db,

    /**
     * Records one transcript line's message. Lines of the same message carry
     * the same usage, so a repeat keeps the larger count per field and
     * reports `false`.
     */
    addTranscriptMessage(message: TranscriptMessage, machine: string, project: string | null): boolean {
      const id = `transcript:${message.messageId}`;
      const existing = selectUsage.get(id);
      if (existing === undefined) {
        insertUsage.run({
          id,
          source: "transcript",
          machine,
          ts: message.ts,
          sessionId: message.sessionId,
          threadId: null,
          turnId: null,
          provider: "claude-code",
          model: message.model,
          project,
          ...message.tokens,
          costUsd: priceTokens(message.model, message.tokens),
        });
        return true;
      }
      const previous = rowTokens(existing);
      const merged = maxTokens(previous, message.tokens);
      if (!sameTokens(previous, merged)) {
        updateTokens.run({ id, ...merged, costUsd: priceTokens(message.model, merged) });
      }
      return false;
    },

    addPrompt(prompt: TranscriptPrompt): boolean {
      return insertPrompt.run(prompt.uuid, prompt.sessionId, prompt.ts).changes > 0;
    },

    /** A title the user set wins over a generated one; otherwise the latest wins. */
    addTitle(title: TranscriptTitle): void {
      upsertTitle.run({ sessionId: title.sessionId, title: title.title, custom: title.custom ? 1 : 0 });
    },

    rememberThread(facts: ThreadFacts, sessionId: string | null): void {
      upsertThread.run(facts);
      if (sessionId !== null) upsertSession.run(sessionId, facts.threadId);
    },

    /** The `updatedAt` the thread had when it was last recorded, or null. */
    threadUpdatedAt(threadId: string): number | null {
      return selectThreadUpdatedAt.get(threadId)?.updated_at ?? null;
    },

    /**
     * Records the growth since the thread's previous snapshot for the same
     * session, one row per model that grew. Returns the rows written; a
     * repeated snapshot writes none.
     */
    recordSnapshot(snapshot: LedgerSnapshot): number {
      const sessionKey = snapshot.sessionId ?? "";
      let written = 0;
      db.transaction(() => {
        for (const model of snapshot.models) {
          const previous = selectTotal.get(snapshot.threadId, sessionKey, model.model);
          const growth = tokenGrowth(previous === undefined ? null : rowTokens(previous), model.tokens);
          const resetOrNew = previous === undefined || sameTokens(growth, model.tokens);
          const previousCost = previous?.cost_usd ?? null;
          const costGrowth =
            model.costUsd === null
              ? null
              : resetOrNew
                ? model.costUsd
                : previousCost === null
                  ? // No earlier price to subtract, so the growth takes its token share of the total.
                    (model.costUsd * totalTokens(growth)) / Math.max(1, totalTokens(model.tokens))
                  : Math.max(0, model.costUsd - previousCost);
          upsertTotal.run({ threadId: snapshot.threadId, sessionKey, model: model.model, ...model.tokens, costUsd: model.costUsd });
          if (totalTokens(growth) === 0) continue;
          addLedgerUsage.run({
            id: `ledger:${snapshot.threadId}:${sessionKey}:${snapshot.turnId}:${model.model}`,
            ts: snapshot.ts,
            sessionId: snapshot.sessionId,
            threadId: snapshot.threadId,
            turnId: snapshot.turnId,
            provider: snapshot.provider,
            model: model.model,
            project: snapshot.project,
            ...growth,
            costUsd: costGrowth,
          });
          written += 1;
        }
      })();
      return written;
    },

    cursor(machine: string, path: string): FileCursor | null {
      const row = selectCursor.get(machine, path);
      return row === undefined ? null : { size: row.size, mtimeMs: row.mtime_ms, offset: row.offset };
    },

    saveCursor(machine: string, path: string, cursor: FileCursor): void {
      upsertCursor.run(machine, path, cursor.size, cursor.mtimeMs, cursor.offset);
    },

    addWindowSample(sample: WindowSample): void {
      insertSample.run(sample);
    },

    meta(key: string): string | null {
      return selectMeta.get(key)?.value ?? null;
    },

    setMeta(key: string, value: string): void {
      upsertMeta.run(key, value);
    },
  };
}
