import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { FileCursor, Ledger } from "./ledger.js";
import {
  parseTranscriptLine,
  type TranscriptEntry,
  type TranscriptFile,
  type TranscriptReader,
} from "./transcripts.js";

export interface ImportCounts {
  /** Transcript files the reader listed. */
  files: number;
  /** Files with bytes not read before. */
  filesRead: number;
  /** Files that could not be read, such as ones without read permission; retried once they change. */
  filesFailed: number;
  /** Files read again from the start because they shrank or the line before the cursor changed. */
  filesRestarted: number;
  /** Files with unread bytes left when the budget ran out; the next import continues with them. */
  filesPending: number;
  /** New API messages. */
  messages: number;
  /** Lines that repeated a message already recorded (one per extra content block). */
  repeatedLines: number;
  prompts: number;
  /** Sessions that gained at least one message. */
  sessions: number;
}

export interface ProjectPath {
  path: string;
  name: string;
}

/**
 * Names the project a working directory belongs to: the bb project whose
 * source path is the longest prefix, or else the directory's own name.
 */
export function projectResolver(paths: readonly ProjectPath[]): (cwd: string | null) => string | null {
  const sorted = [...paths].sort((left, right) => right.path.length - left.path.length);
  return (cwd) => {
    if (cwd === null) return null;
    const match = sorted.find((entry) => cwd === entry.path || cwd.startsWith(`${entry.path}/`));
    return match?.name ?? (basename(cwd) || null);
  };
}

const BATCH_LINES = 2_000;

export interface ImportBudget {
  /** Files to read per import, counting only files with unread bytes. */
  maxFiles: number;
  /** Wall-clock time per import, listing included. A file in progress stops at a line boundary. */
  maxMs: number;
}

export const DEFAULT_IMPORT_BUDGET: ImportBudget = { maxFiles: 200, maxMs: 2_000 };

export interface ImportOptions {
  budget?: ImportBudget;
  /** Collects ids of sessions that gained a message, across the imports that share it. */
  sessions?: Set<string>;
  clock?: () => number;
}

export function emptyImportCounts(): ImportCounts {
  return {
    files: 0,
    filesRead: 0,
    filesFailed: 0,
    filesRestarted: 0,
    filesPending: 0,
    messages: 0,
    repeatedLines: 0,
    prompts: 0,
    sessions: 0,
  };
}

function lineHash(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

/**
 * Where to resume a file: the cursor's offset if the last line it read is
 * still there byte for byte, else 0.
 */
async function resumeOffset(reader: TranscriptReader, file: TranscriptFile, cursor: FileCursor | null): Promise<number> {
  if (cursor === null || cursor.offset === 0) return 0;
  if (cursor.offset > file.size) return 0;
  if (cursor.lineStart === null || cursor.lineHash === null) return cursor.offset;
  const bytes = await reader.readBytes(file.path, cursor.lineStart, cursor.offset);
  const intact =
    bytes.length === cursor.offset - cursor.lineStart &&
    bytes[bytes.length - 1] === 0x0a &&
    lineHash(bytes.subarray(0, -1).toString("utf8")) === cursor.lineHash;
  return intact ? cursor.offset : 0;
}

/**
 * Reads transcript bytes not read before and records their messages and
 * prompts, within `budget`. Unchanged files are skipped by size and mtime,
 * and the rest are read from their cursors in listing order, which decides
 * the session a message copied into a forked session is recorded under. A file that shrank,
 * or whose last read line changed, is read again from the start; recording
 * is idempotent, so that only revisits rows already counted. Call again
 * while `filesPending` is above zero.
 */
export async function importTranscripts(
  ledger: Ledger,
  reader: TranscriptReader,
  projectOf: (cwd: string | null) => string | null,
  options: ImportOptions = {},
): Promise<ImportCounts> {
  const budget = options.budget ?? DEFAULT_IMPORT_BUDGET;
  const clock = options.clock ?? performance.now.bind(performance);
  const deadline = clock() + budget.maxMs;
  const counts = emptyImportCounts();
  const sessions = options.sessions ?? new Set<string>();
  const files = await reader.list();
  counts.files = files.length;

  const write = ledger.db.transaction((entries: readonly TranscriptEntry[]) => {
    for (const entry of entries) {
      if (entry.kind === "title") {
        ledger.addTitle(entry);
      } else if (entry.kind === "prompt") {
        if (ledger.addPrompt(entry)) counts.prompts += 1;
      } else if (ledger.addTranscriptMessage(entry, reader.machine, projectOf(entry.cwd))) {
        counts.messages += 1;
        sessions.add(entry.sessionId);
      } else {
        counts.repeatedLines += 1;
      }
    }
  });

  const stale = files
    .map((file) => ({ file, cursor: ledger.cursor(reader.machine, file.path) }))
    .filter(({ file, cursor }) => cursor === null || cursor.size !== file.size || cursor.mtimeMs !== file.mtimeMs);

  for (const [index, { file, cursor }] of stale.entries()) {
    if (index >= budget.maxFiles || clock() >= deadline) {
      counts.filesPending = stale.length - index;
      break;
    }
    let start = cursor?.offset ?? 0;
    let offset = start;
    /** The cursor reading resumes from, until its last line turns out to have changed. */
    let resumed = cursor;
    let lastLine: { start: number; text: string } | null = null;
    let batch: TranscriptEntry[] = [];
    let stopped = false;
    const save = (size: number) =>
      ledger.saveCursor(reader.machine, file.path, {
        size,
        mtimeMs: file.mtimeMs,
        offset,
        lineStart: lastLine?.start ?? resumed?.lineStart ?? null,
        lineHash: lastLine !== null ? lineHash(lastLine.text) : (resumed?.lineHash ?? null),
      });
    try {
      start = await resumeOffset(reader, file, cursor);
      if (start === 0 && resumed !== null) {
        if (resumed.offset > 0) counts.filesRestarted += 1;
        resumed = null;
      }
      offset = start;
      for await (const line of reader.read(file.path, start, file.size)) {
        lastLine = { start: offset, text: line.text };
        offset = line.endOffset;
        const entry = parseTranscriptLine(line.text, file.sessionId);
        if (entry !== null) batch.push(entry);
        if (batch.length >= BATCH_LINES) {
          write(batch);
          batch = [];
        }
        if (clock() >= deadline && offset < file.size) {
          stopped = true;
          break;
        }
      }
    } catch {
      counts.filesFailed += 1;
      write(batch);
      // Retry soon from the progress made; with none, wait until the file changes.
      save(offset > start ? offset : file.size);
      continue;
    }
    counts.filesRead += 1;
    write(batch);
    save(stopped ? offset : file.size);
    if (stopped) {
      counts.filesPending = stale.length - index;
      break;
    }
  }
  counts.sessions = sessions.size;
  return counts;
}
