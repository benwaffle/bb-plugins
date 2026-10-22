import { basename } from "node:path";
import type { Ledger } from "./ledger.js";
import { parseTranscriptLine, type TranscriptEntry, type TranscriptReader } from "./transcripts.js";

export interface ImportCounts {
  /** Transcript files the reader listed. */
  files: number;
  /** Files with bytes not read before. */
  filesRead: number;
  /** Files that could not be read, such as ones without read permission; retried next import. */
  filesFailed: number;
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

/**
 * Reads every transcript byte not read before and records its messages and
 * prompts. Unchanged files are skipped by size and mtime; a file that shrank
 * is read again from the start.
 */
export async function importTranscripts(
  ledger: Ledger,
  reader: TranscriptReader,
  projectOf: (cwd: string | null) => string | null,
): Promise<ImportCounts> {
  const counts: ImportCounts = { files: 0, filesRead: 0, filesFailed: 0, messages: 0, repeatedLines: 0, prompts: 0, sessions: 0 };
  const sessions = new Set<string>();
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

  for (const file of files) {
    const cursor = ledger.cursor(reader.machine, file.path);
    if (cursor !== null && cursor.size === file.size && cursor.mtimeMs === file.mtimeMs) continue;
    const start = cursor === null || cursor.offset > file.size ? 0 : cursor.offset;
    if (start === file.size) {
      ledger.saveCursor(reader.machine, file.path, { size: file.size, mtimeMs: file.mtimeMs, offset: start });
      continue;
    }
    let offset = start;
    let batch: TranscriptEntry[] = [];
    try {
      for await (const line of reader.read(file.path, start)) {
        offset = line.endOffset;
        const entry = parseTranscriptLine(line.text, file.sessionId);
        if (entry !== null) batch.push(entry);
        if (batch.length >= BATCH_LINES) {
          write(batch);
          batch = [];
        }
      }
    } catch {
      counts.filesFailed += 1;
      continue;
    }
    counts.filesRead += 1;
    write(batch);
    ledger.saveCursor(reader.machine, file.path, { size: file.size, mtimeMs: file.mtimeMs, offset });
  }
  counts.sessions = sessions.size;
  return counts;
}
