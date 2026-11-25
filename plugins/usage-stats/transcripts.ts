import { createReadStream } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UsageTokens } from "./pricing.js";

/** One model response, as Claude Code records it in a session transcript. */
export interface TranscriptMessage {
  kind: "message";
  /** The API message id. Claude Code writes one line per content block, all sharing it. */
  messageId: string;
  sessionId: string;
  ts: number;
  model: string;
  cwd: string | null;
  tokens: UsageTokens;
}

/** A prompt the user typed, which starts a turn. */
export interface TranscriptPrompt {
  kind: "prompt";
  uuid: string;
  sessionId: string;
  ts: number;
}

/** A session title: Claude Code's generated one, or one the user set. */
export interface TranscriptTitle {
  kind: "title";
  sessionId: string;
  title: string;
  custom: boolean;
}

export type TranscriptEntry = TranscriptMessage | TranscriptPrompt | TranscriptTitle;

function parseTitleLine(line: string, fallbackSessionId: string): TranscriptTitle | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const custom = parsed.type === "custom-title";
  const title = custom ? parsed.customTitle : parsed.aiTitle;
  if (typeof title !== "string" || title.trim() === "") return null;
  const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId : fallbackSessionId;
  return { kind: "title", sessionId, title: title.trim().slice(0, 200), custom };
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function isTypedPrompt(content: unknown): boolean {
  if (typeof content === "string") return content.length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((block) => isRecord(block) && block.type === "text");
}

/**
 * Reads one transcript line. Returns null for every line that is neither a
 * priced model response, a typed prompt, nor a session title: tool results, sidechain prompts,
 * meta lines, summaries, and Claude Code's `<synthetic>` placeholder replies.
 *
 * Lines are prefiltered on substrings before JSON.parse because most of a
 * transcript's bytes are tool output that holds neither.
 */
export function parseTranscriptLine(line: string, fallbackSessionId: string): TranscriptEntry | null {
  if (line.startsWith('{"type":"ai-title"') || line.startsWith('{"type":"custom-title"')) {
    return parseTitleLine(line, fallbackSessionId);
  }
  const isAssistant = line.includes('"type":"assistant"') && line.includes('"usage"');
  const isUser = !isAssistant && line.includes('"type":"user"') && !line.includes('"tool_use_id"');
  if (!isAssistant && !isUser) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.message)) return null;
  const ts = parseTimestamp(parsed.timestamp);
  if (ts === null) return null;
  const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId : fallbackSessionId;

  if (parsed.type === "assistant") {
    const { id, model, usage } = parsed.message;
    if (typeof id !== "string" || typeof model !== "string" || model.startsWith("<")) return null;
    if (!isRecord(usage)) return null;
    return {
      kind: "message",
      messageId: id,
      sessionId,
      ts,
      model,
      cwd: typeof parsed.cwd === "string" ? parsed.cwd : null,
      tokens: {
        input: count(usage.input_tokens),
        output: count(usage.output_tokens),
        cacheRead: count(usage.cache_read_input_tokens),
        cacheWrite: count(usage.cache_creation_input_tokens),
      },
    };
  }
  if (parsed.type === "user") {
    if (parsed.isSidechain === true || parsed.isMeta === true || parsed.isCompactSummary === true) return null;
    if (typeof parsed.uuid !== "string" || !isTypedPrompt(parsed.message.content)) return null;
    return { kind: "prompt", uuid: parsed.uuid, sessionId, ts };
  }
  return null;
}

export interface TranscriptFile {
  path: string;
  /** Session id from the file name or, for a subagent, its parent directory. */
  sessionId: string;
  size: number;
  mtimeMs: number;
}

export interface TranscriptLine {
  text: string;
  /** Byte offset just past this line's newline; resume reading from here. */
  endOffset: number;
}

/**
 * Where Claude Code transcripts come from. Each reader names one machine, so
 * a reader for another host can sit beside the local one without colliding
 * on paths.
 */
export interface TranscriptReader {
  readonly machine: string;
  list(): Promise<TranscriptFile[]>;
  /** Complete lines in bytes [`fromOffset`, `toOffset`); a trailing partial line is held back. */
  read(path: string, fromOffset: number, toOffset: number): AsyncIterable<TranscriptLine>;
  /** The bytes in [`fromOffset`, `toOffset`), fewer if the file ends first. */
  readBytes(path: string, fromOffset: number, toOffset: number): Promise<Buffer>;
}

const SESSION_FILE = /^([0-9a-f-]{36})\.jsonl$/;

/**
 * Splits a byte stream into complete lines, tracking byte offsets. Each byte
 * is scanned once: the pieces of a line that spans chunks are kept in a list
 * and joined once its newline arrives.
 */
export async function* splitLines(
  chunks: AsyncIterable<Buffer> | Iterable<Buffer>,
  startOffset: number,
): AsyncGenerator<TranscriptLine> {
  let pending: Buffer[] = [];
  let offset = startOffset;
  for await (const chunk of chunks) {
    let start = 0;
    let newline = chunk.indexOf(0x0a);
    while (newline !== -1) {
      const tail = chunk.subarray(start, newline);
      const bytes = pending.length === 0 ? tail : Buffer.concat([...pending, tail]);
      pending = [];
      offset += bytes.length + 1;
      yield { text: bytes.toString("utf8"), endOffset: offset };
      start = newline + 1;
      newline = chunk.indexOf(0x0a, start);
    }
    if (start < chunk.length) pending.push(chunk.subarray(start));
  }
}

/**
 * Reads `~/.claude/projects` on the machine the bb server runs on: one
 * `<session>.jsonl` per session, and `<session>/subagents/*.jsonl` for its
 * subagents.
 */
export function localTranscriptReader(root = join(homedir(), ".claude", "projects")): TranscriptReader {
  async function entries(dir: string) {
    try {
      return await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  }
  async function file(path: string, sessionId: string): Promise<TranscriptFile | null> {
    try {
      const info = await stat(path);
      return { path, sessionId, size: info.size, mtimeMs: info.mtimeMs };
    } catch {
      return null;
    }
  }
  return {
    machine: "local",
    async list() {
      const files: TranscriptFile[] = [];
      for (const project of await entries(root)) {
        if (!project.isDirectory()) continue;
        const projectDir = join(root, project.name);
        for (const entry of await entries(projectDir)) {
          const session = SESSION_FILE.exec(entry.name);
          if (entry.isFile() && session?.[1] !== undefined) {
            const found = await file(join(projectDir, entry.name), session[1]);
            if (found !== null) files.push(found);
          } else if (entry.isDirectory()) {
            const subagents = join(projectDir, entry.name, "subagents");
            for (const agent of await entries(subagents)) {
              if (!agent.isFile() || !agent.name.endsWith(".jsonl")) continue;
              const found = await file(join(subagents, agent.name), entry.name);
              if (found !== null) files.push(found);
            }
          }
        }
      }
      return files;
    },
    read(path, fromOffset, toOffset) {
      if (toOffset <= fromOffset) return splitLines([], fromOffset);
      const stream = createReadStream(path, { start: fromOffset, end: toOffset - 1 });
      return splitLines(stream as AsyncIterable<Buffer>, fromOffset);
    },
    async readBytes(path, fromOffset, toOffset) {
      const handle = await open(path, "r");
      try {
        const buffer = Buffer.alloc(Math.max(0, toOffset - fromOffset));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, fromOffset);
        return buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    },
  };
}
