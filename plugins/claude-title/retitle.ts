import type { BbPluginApi, PluginThreadEventPayloads } from "@get-bb/plugin-sdk";
import type { CompleteOutput } from "./contract.js";

/** Characters kept from each message in the conversation sent to claude. */
export const OUTLINE_MESSAGE_CHARS = 600;
/** Characters of conversation sent to claude for a title, at most. */
export const OUTLINE_BUDGET_CHARS = 3_000;
// A pass runs after a turn, outside bb's 8-second title limit, so claude
// gets longer than it does for the titles bb asks for.
export const RETITLE_TIMEOUT_MS = 20_000;
const FIRST_PROMPT_EVENT_LIMIT = "20";
const OMITTED_LINE = "(earlier messages omitted)";

type IdlePayload = PluginThreadEventPayloads["thread.idle"];
type Thread = IdlePayload["thread"];

export interface OutlineEntry {
  readonly role: "user" | "assistant";
  readonly text: string;
}

/**
 * What the plugin remembers about one thread, under `thread/<id>` in KV.
 * A record exists once the first pass has looked at the thread.
 */
export interface ThreadTitleRecord {
  /** The title this plugin set and still owns, or null when it owns none. */
  readonly title: string | null;
  /** Assistant replies in the conversation when `title` was set. */
  readonly turns: number;
  /** Whether the follow-up re-title has run or can no longer run. */
  readonly retitled: boolean;
}

export interface RetitleDeps {
  readonly bb: BbPluginApi;
  complete(prompt: string, timeoutMs: number, signal?: AbortSignal): Promise<CompleteOutput>;
  maxTitleLength(): Promise<number>;
  /** Assistant replies after the first-pass title before a follow-up; 0 is off. */
  retitleAfterTurns(): Promise<number>;
  /** Whether bb routes thread titles to this plugin's service. */
  titlesRouteHere(): Promise<boolean>;
}

export function recordKey(threadId: string): string {
  return `thread/${threadId}`;
}

/**
 * A thread is untitled while bb shows its first-message fallback: `title` is
 * null until bb's title service, a fork, or a person sets one, and bb keeps
 * the fallback in its own `titleFallback` field. A title equal to the
 * fallback counts as untitled too, since it carries nothing more.
 */
export function isUntitled(thread: Pick<Thread, "title" | "titleFallback">): boolean {
  const title = thread.title?.trim() ?? "";
  return title.length === 0 || title === thread.titleFallback?.trim();
}

function clip(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  const chars = [...normalized];
  return chars.length <= maxChars
    ? normalized
    : `${chars.slice(0, maxChars - 1).join("")}…`;
}

/**
 * Makes a model reply fit for a thread title: one line without a `Title:`
 * label, wrapping quotes, or a trailing period, cut at a word boundary to
 * `maxLength` characters. Null when nothing is left.
 */
export function cleanTitle(text: string, maxLength: number): string | null {
  let title = text
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^title:\s*/iu, "")
    .replace(/^["'`“”‘’*]+|["'`“”‘’*]+$/gu, "")
    .replace(/[.。]+$/u, "")
    .trim();
  const chars = [...title];
  if (chars.length > maxLength) {
    const cut = chars.slice(0, maxLength).join("");
    const space = cut.lastIndexOf(" ");
    title = (space >= maxLength / 2 ? cut.slice(0, space) : cut).trim();
  }
  return title.length > 0 ? title : null;
}

export function conversationTitlePrompt(lines: readonly string[]): string {
  return [
    "You create concise titles for coding conversations.",
    "Reply with only the title: short, clear, sentence case, in the same language as the conversation. Keep it under about 40 characters. Name the task the user is working on in your own words, using what the assistant's replies reveal about it. No quotes, no trailing punctuation, no explanation.",
    "",
    "Conversation:",
    ...lines,
  ].join("\n");
}

function formatEntry(entry: OutlineEntry): string {
  const role = entry.role === "user" ? "User" : "Assistant";
  return `${role}: ${clip(entry.text, OUTLINE_MESSAGE_CHARS)}`;
}

/** The first user message and the first assistant reply. */
export function firstExchangeLines(entries: readonly OutlineEntry[]): string[] {
  const user = entries.find((entry) => entry.role === "user");
  const assistant = entries.find((entry) => entry.role === "assistant");
  return [user, assistant].flatMap((entry) =>
    entry === undefined ? [] : [formatEntry(entry)],
  );
}

/**
 * The whole conversation when it fits in {@link OUTLINE_BUDGET_CHARS};
 * otherwise the first message and as many of the latest as fit.
 */
export function conversationLines(entries: readonly OutlineEntry[]): string[] {
  const lines = entries.map(formatEntry);
  const [first, ...rest] = lines;
  if (first === undefined) return [];
  let used = first.length;
  const tail: string[] = [];
  for (let index = rest.length - 1; index >= 0; index -= 1) {
    const line = rest[index] ?? "";
    if (used + line.length + 1 > OUTLINE_BUDGET_CHARS) break;
    used += line.length + 1;
    tail.unshift(line);
  }
  return tail.length === rest.length
    ? lines
    : [first, OMITTED_LINE, ...tail];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createRetitler(deps: RetitleDeps) {
  const { bb } = deps;
  const kv = bb.storage.kv;
  const inFlight = new Set<string>();

  /** The first message a person sent, in full; null when bb has none. */
  async function readFirstUserText(threadId: string): Promise<string | null> {
    const rows = await bb.sdk.threads.events.list({
      threadId,
      types: ["client/turn/requested"],
      order: "asc",
      limit: FIRST_PROMPT_EVENT_LIMIT,
    });
    for (const row of rows) {
      if (row.type !== "client/turn/requested" || row.data.initiator !== "user") {
        continue;
      }
      const text = row.data.input
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join(" ")
        .trim();
      if (text.length > 0) return text;
    }
    return null;
  }

  /**
   * The conversation as bb outlines it (each message cut to a short
   * preview), with the first user message in full and, when given, the
   * reply of the only finished turn in full.
   */
  async function readConversation(
    threadId: string,
    lastAssistantText: string | null,
  ): Promise<OutlineEntry[]> {
    const [{ items }, firstUserText] = await Promise.all([
      bb.sdk.threads.conversationOutline({ threadId }),
      readFirstUserText(threadId).catch((error: unknown) => {
        bb.log.warn(`could not read the first message of ${threadId}: ${errorMessage(error)}`);
        return null;
      }),
    ]);
    const firstUser = items.findIndex((item) => item.role === "user");
    const assistants = items.filter((item) => item.role === "assistant");
    return items.map((item, index) => {
      if (index === firstUser && firstUserText !== null) {
        return { role: item.role, text: firstUserText };
      }
      if (item === assistants[0] && assistants.length === 1 && lastAssistantText) {
        return { role: item.role, text: lastAssistantText };
      }
      return { role: item.role, text: item.preview };
    });
  }

  async function generate(lines: string[], signal?: AbortSignal): Promise<string> {
    const [result, maxLength] = await Promise.all([
      deps.complete(conversationTitlePrompt(lines), RETITLE_TIMEOUT_MS, signal),
      deps.maxTitleLength(),
    ]);
    if (!result.ok) throw new Error(result.message);
    const title = cleanTitle(result.text, maxLength);
    if (title === null) throw new Error("claude returned no usable title");
    return title;
  }

  /**
   * Generates a title and writes it if `owns` still holds for the thread as
   * bb has it after claude answered; returns whether it was written.
   */
  async function writeTitle(args: {
    threadId: string;
    lines: string[];
    turns: number;
    retitled: boolean;
    owns(current: Pick<Thread, "title" | "titleFallback">): boolean;
    signal?: AbortSignal;
  }): Promise<string | null> {
    const title = await generate(args.lines, args.signal);
    const current = await bb.sdk.threads.get({ threadId: args.threadId });
    if (!args.owns(current)) return null;
    await bb.sdk.threads.update({ threadId: args.threadId, title });
    await kv.set(recordKey(args.threadId), {
      title,
      turns: args.turns,
      retitled: args.retitled,
    } satisfies ThreadTitleRecord);
    return title;
  }

  function countTurns(entries: readonly OutlineEntry[]): number {
    return entries.filter((entry) => entry.role === "assistant").length;
  }

  async function firstPass(thread: Thread, lastAssistantText: string | null): Promise<void> {
    const key = recordKey(thread.id);
    if (!isUntitled(thread)) {
      await kv.set(key, { title: null, turns: 0, retitled: true } satisfies ThreadTitleRecord);
      return;
    }
    if (!(await deps.titlesRouteHere())) return;
    const entries = await readConversation(thread.id, lastAssistantText);
    const turns = countTurns(entries);
    if (turns === 0) return;
    // One attempt per thread: a failure is recorded like a success so a
    // broken claude does not run again on every turn.
    await kv.set(key, { title: null, turns, retitled: true } satisfies ThreadTitleRecord);
    await writeTitle({
      threadId: thread.id,
      lines: firstExchangeLines(entries),
      turns,
      retitled: false,
      owns: isUntitled,
    });
  }

  async function followUp(thread: Thread, record: ThreadTitleRecord): Promise<void> {
    if (record.title === null || record.retitled) return;
    const key = recordKey(thread.id);
    if (thread.title !== record.title) {
      await kv.set(key, { ...record, title: null, retitled: true } satisfies ThreadTitleRecord);
      return;
    }
    const after = await deps.retitleAfterTurns();
    if (after === 0 || !(await deps.titlesRouteHere())) return;
    const entries = await readConversation(thread.id, null);
    const turns = countTurns(entries);
    if (turns - record.turns < after) return;
    await kv.set(key, { ...record, retitled: true } satisfies ThreadTitleRecord);
    await writeTitle({
      threadId: thread.id,
      lines: conversationLines(entries),
      turns,
      retitled: true,
      owns: (current) => current.title === record.title,
    });
  }

  return {
    async onIdle({ thread, lastAssistantText }: IdlePayload): Promise<void> {
      if (
        thread.visibility === "hidden" ||
        thread.archivedAt !== null ||
        thread.deletedAt !== null ||
        inFlight.has(thread.id)
      ) {
        return;
      }
      inFlight.add(thread.id);
      try {
        const record = await kv.get<ThreadTitleRecord>(recordKey(thread.id));
        await (record === undefined
          ? firstPass(thread, lastAssistantText)
          : followUp(thread, record));
      } catch (error) {
        bb.log.warn(`could not title ${thread.id}: ${errorMessage(error)}`);
      } finally {
        inFlight.delete(thread.id);
      }
    },

    /**
     * Titles a thread from its conversation so far, whatever its current
     * title, and takes ownership of the new one.
     */
    async retitle(threadId: string, signal?: AbortSignal): Promise<string> {
      const entries = await readConversation(threadId, null);
      if (entries.length === 0) {
        throw new Error(`${threadId} has no messages to title yet`);
      }
      const title = await writeTitle({
        threadId,
        lines: conversationLines(entries),
        turns: countTurns(entries),
        retitled: true,
        owns: () => true,
        ...(signal === undefined ? {} : { signal }),
      });
      if (title === null) throw new Error(`${threadId} was not retitled`);
      return title;
    },
  };
}
