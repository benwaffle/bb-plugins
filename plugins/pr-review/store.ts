import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ThreadRef } from "./contract.js";

type Storage = BbPluginApi["storage"];

const MIGRATIONS = [
  `CREATE TABLE refs (
    thread_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('gh-pr', 'gh-issue', 'jira')),
    key TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (thread_id, kind, key)
  )`,
  `CREATE INDEX refs_by_key ON refs (kind, key)`,
  `CREATE TABLE tickets (
    key TEXT PRIMARY KEY,
    summary TEXT,
    status TEXT,
    fetched_at INTEGER NOT NULL
  )`,
];

function openDatabase(storage: Storage) {
  const handle = storage.database();
  storage.migrate(handle, MIGRATIONS);
  return handle;
}

interface RefRow {
  thread_id: string;
  kind: ThreadRef["kind"];
  key: string;
  url: string;
  title: string | null;
  source: ThreadRef["source"];
}

function toRef(row: RefRow): ThreadRef {
  return { kind: row.kind, key: row.key, url: row.url, title: row.title, source: row.source };
}

export interface RefStore {
  record(threadId: string, refs: readonly ThreadRef[]): void;
  forThread(threadId: string): ThreadRef[];
  threadsWith(kind: ThreadRef["kind"], key: string): string[];
  reviewThreadFor(pullKey: string): string[];
  threadsForPulls(pullKeys: readonly string[]): Map<string, string>;
  ticketThreads(): Map<string, string>;
}

export function createRefStore(storage: Storage): RefStore {
  const db = () => openDatabase(storage);

  return {
    record(threadId, refs) {
      const handle = db();
      const upsert = handle.prepare(
        `INSERT INTO refs (thread_id, kind, key, url, title, source, created_at)
         VALUES (@threadId, @kind, @key, @url, @title, @source, @createdAt)
         ON CONFLICT (thread_id, kind, key) DO UPDATE SET
           url = excluded.url,
           title = COALESCE(excluded.title, refs.title),
           source = CASE WHEN refs.source = 'review-target' THEN refs.source ELSE excluded.source END`,
      );
      const createdAt = new Date().toISOString();
      handle.transaction(() => {
        for (const ref of refs) upsert.run({ threadId, createdAt, ...ref });
      })();
    },

    forThread(threadId) {
      const rows = db()
        .prepare(
          `SELECT thread_id, kind, key, url, title, source FROM refs
           WHERE thread_id = ? ORDER BY created_at, kind, key`,
        )
        .all(threadId) as RefRow[];
      return rows.map(toRef);
    },

    threadsWith(kind, key) {
      const rows = db()
        .prepare(`SELECT DISTINCT thread_id FROM refs WHERE kind = ? AND key = ?`)
        .all(kind, key) as Array<{ thread_id: string }>;
      return rows.map((row) => row.thread_id);
    },

    reviewThreadFor(pullKey) {
      const rows = db()
        .prepare(
          `SELECT thread_id FROM refs
           WHERE kind = 'gh-pr' AND key = ? AND source = 'review-target'
           ORDER BY created_at DESC`,
        )
        .all(pullKey) as Array<{ thread_id: string }>;
      return rows.map((row) => row.thread_id);
    },

    ticketThreads() {
      const rows = db()
        .prepare(`SELECT thread_id, key FROM refs WHERE kind = 'jira' ORDER BY created_at DESC, key DESC`)
        .all() as Array<{ thread_id: string; key: string }>;
      return new Map(rows.map((row) => [row.thread_id, row.key]));
    },

    threadsForPulls(pullKeys) {
      if (pullKeys.length === 0) return new Map();
      const placeholders = pullKeys.map(() => "?").join(", ");
      const rows = db()
        .prepare(
          `SELECT key, thread_id FROM refs
           WHERE kind = 'gh-pr' AND source = 'review-target' AND key IN (${placeholders})
           ORDER BY created_at`,
        )
        .all(...pullKeys) as Array<{ key: string; thread_id: string }>;
      return new Map(rows.map((row) => [row.key, row.thread_id]));
    },
  };
}

export interface TicketFields {
  summary: string | null;
  status: string | null;
}

export interface CachedTicket extends TicketFields {
  fetchedAt: number;
}

export interface TicketStore {
  get(keys: readonly string[]): Map<string, CachedTicket>;
  save(tickets: ReadonlyMap<string, TicketFields>, fetchedAt: number): void;
}

export function createTicketStore(storage: Storage): TicketStore {
  const db = () => openDatabase(storage);

  return {
    get(keys) {
      if (keys.length === 0) return new Map();
      const placeholders = keys.map(() => "?").join(", ");
      const rows = db()
        .prepare(`SELECT key, summary, status, fetched_at FROM tickets WHERE key IN (${placeholders})`)
        .all(...keys) as Array<{ key: string; summary: string | null; status: string | null; fetched_at: number }>;
      return new Map(
        rows.map((row) => [row.key, { summary: row.summary, status: row.status, fetchedAt: row.fetched_at }]),
      );
    },

    save(tickets, fetchedAt) {
      const handle = db();
      const upsert = handle.prepare(
        `INSERT INTO tickets (key, summary, status, fetched_at) VALUES (@key, @summary, @status, @fetchedAt)
         ON CONFLICT (key) DO UPDATE SET
           summary = excluded.summary, status = excluded.status, fetched_at = excluded.fetched_at`,
      );
      handle.transaction(() => {
        for (const [key, fields] of tickets) upsert.run({ key, fetchedAt, ...fields });
      })();
    },
  };
}
