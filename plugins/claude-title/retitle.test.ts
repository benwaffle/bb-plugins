import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClaudeHostEntry } from "./host.js";
import {
  OUTLINE_BUDGET_CHARS,
  cleanTitle,
  conversationLines,
  conversationTitlePrompt,
  isUntitled,
  recordKey,
  type ThreadTitleRecord,
} from "./retitle.js";
import plugin from "./server.js";

const PLUGIN_ID = "claude-title";
const THREAD_ID = "thr_short";
const FALLBACK = "demo bash cmds";

type FakePluginHostOptions = NonNullable<Parameters<typeof createFakePluginHost>[0]>;
type HostRpcResponder = NonNullable<FakePluginHostOptions["experimental_callHostRpc"]>;
type Thread = ReturnType<typeof makeThreadResponse>;
type Selection = { mode: "automatic" } | { mode: "off" };

interface OutlineItem {
  role: "user" | "assistant";
  preview: string;
}

function outlineItems(...texts: string[]): OutlineItem[] {
  return texts.map((preview, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    preview,
  }));
}

/**
 * A fake bb holding one thread. `threads.get` and `threads.update` read and
 * write `state.thread`; tests change `state` between events the way bb would.
 */
function createHost(args: {
  respond: HostRpcResponder;
  thread?: Partial<Thread>;
  outline?: OutlineItem[];
  firstPrompt?: string;
  settings?: Record<string, string | number>;
  titleSelection?: Selection;
}) {
  const state = {
    thread: makeThreadResponse({
      id: THREAD_ID,
      title: null,
      titleFallback: FALLBACK,
      ...args.thread,
    }),
    outline: args.outline ?? outlineItems(FALLBACK, "Here are a few bash commands."),
    titleSelection: args.titleSelection ?? ({ mode: "automatic" } as Selection),
    /** Applied by `threads.get` once, as if bb's own title landed meanwhile. */
    titleOnNextGet: undefined as string | undefined,
  };
  const host = createFakePluginHost({
    pluginId: PLUGIN_ID,
    ...(args.settings === undefined ? {} : { settings: args.settings }),
    sdk: {
      system: {
        config: async () => ({ primaryHostId: "host-primary" }) as never,
        aiServices: async () =>
          ({
            selections: {
              "thread-title": state.titleSelection,
              "commit-message": { mode: "automatic" },
              voice: { mode: "automatic" },
            },
            services: [
              {
                id: "claude",
                displayName: "Claude Code",
                pluginId: PLUGIN_ID,
                tasks: ["thread-title", "commit-message"],
                automaticRank: 0,
                status: { ready: true },
              },
            ],
          }) as never,
      },
      threads: {
        get: async () => {
          if (state.titleOnNextGet !== undefined) {
            state.thread = { ...state.thread, title: state.titleOnNextGet };
            state.titleOnNextGet = undefined;
          }
          return state.thread as never;
        },
        update: async ({ title }) => {
          state.thread = { ...state.thread, title: title ?? null };
          return state.thread as never;
        },
        conversationOutline: async () =>
          ({
            items: state.outline.map((item, index) => ({
              id: `item-${index}`,
              attachmentSummary: null,
              ...item,
            })),
            maxSeq: state.outline.length,
          }) as never,
        events: {
          list: async () =>
            [
              {
                id: "evt-1",
                type: "client/turn/requested",
                data: {
                  initiator: "user",
                  input: [
                    { type: "text", text: args.firstPrompt ?? FALLBACK, mentions: [] },
                  ],
                },
              },
            ] as never,
        },
      },
    },
    experimental_callHostRpc: args.respond,
  });
  const idle = (lastAssistantText: string | null = null) =>
    host.harness.emitThreadEvent("thread.idle", {
      thread: state.thread,
      lastAssistantText,
    });
  const record = () =>
    host.bb.storage.kv.get<ThreadTitleRecord>(recordKey(THREAD_ID));
  const prompts = () =>
    host.harness.experimental_hostRpcCalls
      .filter((call) => call.method === "complete")
      .map((call) => (call.input as { prompt: string }).prompt);
  return { host, state, idle, record, prompts };
}

const titleReply = (text: string): HostRpcResponder => () => ({
  ok: true,
  text,
  durationMs: 900,
});

describe("isUntitled", () => {
  it("treats a null, blank, or fallback-equal title as untitled", () => {
    expect(isUntitled({ title: null, titleFallback: FALLBACK })).toBe(true);
    expect(isUntitled({ title: "  ", titleFallback: FALLBACK })).toBe(true);
    expect(isUntitled({ title: FALLBACK, titleFallback: FALLBACK })).toBe(true);
    expect(isUntitled({ title: "Bash demo", titleFallback: FALLBACK })).toBe(false);
  });
});

describe("cleanTitle", () => {
  it("strips labels, quotes, and a trailing period", () => {
    expect(cleanTitle('Title: "Demo bash commands."', 48)).toBe("Demo bash commands");
  });

  it("cuts at a word boundary within the limit", () => {
    const title = cleanTitle(
      "Investigate why the nightly integration suite times out on arm runners",
      48,
    );
    expect(title).toBe("Investigate why the nightly integration suite");
    expect(title?.length).toBeLessThanOrEqual(48);
  });

  it("returns null for an empty reply", () => {
    expect(cleanTitle(' "" ', 48)).toBeNull();
  });
});

describe("conversationLines", () => {
  it("keeps the first message and the latest ones that fit", () => {
    const entries = Array.from({ length: 40 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `message ${index} ${"x".repeat(180)}`,
    }));

    const lines = conversationLines(entries);

    expect(lines[0]).toMatch(/^User: message 0 /u);
    expect(lines[1]).toBe("(earlier messages omitted)");
    expect(lines.at(-1)).toMatch(/^Assistant: message 39 /u);
    expect(lines.join("\n").length).toBeLessThanOrEqual(OUTLINE_BUDGET_CHARS + 40);
  });
});

describe("second title pass", () => {
  it("titles a short-prompt thread after its first turn, once", async () => {
    const { host, state, idle, record, prompts } = createHost({
      respond: titleReply("Demo bash commands"),
    });
    await plugin(host.bb);

    await idle("Here are a few bash commands: ls, grep, and find.");
    await idle("Later reply");

    expect(state.thread.title).toBe("Demo bash commands");
    expect(prompts()).toEqual([
      conversationTitlePrompt([
        `User: ${FALLBACK}`,
        "Assistant: Here are a few bash commands: ls, grep, and find.",
      ]),
    ]);
    expect(host.harness.experimental_hostRpcCalls[0]?.input).toMatchObject({
      model: "claude-haiku-4-5-20251001",
      timeoutMs: 20_000,
    });
    await expect(record()).resolves.toEqual({
      title: "Demo bash commands",
      turns: 1,
      retitled: false,
    });
  });

  it("caps the first message and reply at 600 characters and the title at the max length", async () => {
    const longPrompt = `fix ${"a".repeat(1_000)}`;
    const { host, state, idle, prompts } = createHost({
      respond: titleReply(
        "Fix the very long thing that keeps going on and on past the limit",
      ),
      firstPrompt: longPrompt,
      settings: { maxTitleLength: 30 },
    });
    await plugin(host.bb);

    await idle("b".repeat(1_000));

    const [prompt = ""] = prompts();
    const user = prompt.split("\n").find((line) => line.startsWith("User: ")) ?? "";
    const assistant =
      prompt.split("\n").find((line) => line.startsWith("Assistant: ")) ?? "";
    expect([...user.slice("User: ".length)]).toHaveLength(600);
    expect(user.endsWith("…")).toBe(true);
    expect([...assistant.slice("Assistant: ".length)]).toHaveLength(600);
    expect(state.thread.title).toBe("Fix the very long thing that");
  });

  it("never replaces a title someone typed", async () => {
    const { host, state, idle, record } = createHost({
      respond: titleReply("Demo bash commands"),
      thread: { title: "My bash notes" },
      settings: { retitleAfterTurns: 1 },
    });
    await plugin(host.bb);

    await idle("reply");
    state.outline = outlineItems("a", "b", "c", "d", "e", "f");
    await idle("reply");

    expect(state.thread.title).toBe("My bash notes");
    expect(host.harness.experimental_hostRpcCalls).toEqual([]);
    await expect(record()).resolves.toMatchObject({ title: null, retitled: true });
  });

  it("titles a thread whose title is only its fallback", async () => {
    const { host, state, idle } = createHost({
      respond: titleReply("Demo bash commands"),
      thread: { title: FALLBACK },
    });
    await plugin(host.bb);

    await idle("reply");

    expect(state.thread.title).toBe("Demo bash commands");
  });

  it("leaves a title that landed while claude was answering", async () => {
    const { host, state, idle } = createHost({
      respond: titleReply("Demo bash commands"),
    });
    await plugin(host.bb);
    state.titleOnNextGet = "Title from bb";

    await idle("reply");

    expect(state.thread.title).toBe("Title from bb");
    expect(host.harness.sdk.callsTo("threads.update")).toEqual([]);
  });

  it("waits while thread titles are off and runs once they route here", async () => {
    const { host, state, idle, record } = createHost({
      respond: titleReply("Demo bash commands"),
      titleSelection: { mode: "off" },
    });
    await plugin(host.bb);

    await idle("reply");
    expect(host.harness.experimental_hostRpcCalls).toEqual([]);
    await expect(record()).resolves.toBeUndefined();

    state.titleSelection = { mode: "automatic" };
    await idle("reply");
    expect(state.thread.title).toBe("Demo bash commands");
  });

  it("skips hidden threads and threads with no finished turn", async () => {
    const hidden = createHost({
      respond: titleReply("Title"),
      thread: { visibility: "hidden" },
    });
    await plugin(hidden.host.bb);
    await hidden.idle("reply");

    const fresh = createHost({ respond: titleReply("Title"), outline: outlineItems("hi") });
    await plugin(fresh.host.bb);
    await fresh.idle(null);

    expect(hidden.host.harness.experimental_hostRpcCalls).toEqual([]);
    expect(fresh.host.harness.experimental_hostRpcCalls).toEqual([]);
    await expect(fresh.record()).resolves.toBeUndefined();
  });

  it("tries once and logs when claude fails", async () => {
    const { host, state, idle } = createHost({
      respond: () => ({ ok: false, code: "timeout", message: "claude did not answer" }),
    });
    await plugin(host.bb);

    const { errors } = await idle("reply");
    await idle("reply");

    expect(errors).toEqual([]);
    expect(state.thread.title).toBeNull();
    expect(host.harness.experimental_hostRpcCalls).toHaveLength(1);
    expect(host.harness.logEntries).toContainEqual({
      level: "warn",
      message: `could not title ${THREAD_ID}: claude did not answer`,
    });
  });

  it("re-titles its own title once after the configured number of turns", async () => {
    const replies = ["Demo bash commands", "Write a bash backup script"];
    const { host, state, idle, record, prompts } = createHost({
      respond: () => ({ ok: true, text: replies.shift() ?? "", durationMs: 1 }),
      settings: { retitleAfterTurns: 2 },
    });
    await plugin(host.bb);

    await idle("Here are a few bash commands.");
    state.outline = outlineItems(FALLBACK, "Commands.", "now a backup script", "Sure.");
    await idle("Sure.");
    expect(state.thread.title).toBe("Demo bash commands");

    state.outline = [
      ...state.outline,
      ...outlineItems("keep 7 days", "Done: rotate after 7 days."),
    ];
    await idle("Done: rotate after 7 days.");
    await idle("Done: rotate after 7 days.");

    expect(state.thread.title).toBe("Write a bash backup script");
    expect(prompts()).toHaveLength(2);
    expect(prompts()[1]).toContain(
      [
        `User: ${FALLBACK}`,
        "Assistant: Commands.",
        "User: now a backup script",
        "Assistant: Sure.",
        "User: keep 7 days",
        "Assistant: Done: rotate after 7 days.",
      ].join("\n"),
    );
    await expect(record()).resolves.toEqual({
      title: "Write a bash backup script",
      turns: 3,
      retitled: true,
    });
  });

  it("does not re-title once someone renames the thread", async () => {
    const { host, state, idle } = createHost({
      respond: titleReply("Demo bash commands"),
      settings: { retitleAfterTurns: 1 },
    });
    await plugin(host.bb);

    await idle("reply");
    state.thread = { ...state.thread, title: "Renamed by hand" };
    state.outline = outlineItems("a", "b", "c", "d");
    await idle("reply");

    expect(state.thread.title).toBe("Renamed by hand");
    expect(host.harness.experimental_hostRpcCalls).toHaveLength(1);
  });
});

describe("bb claude-title retitle", () => {
  it("replaces any title with one from the conversation so far", async () => {
    const { host, state, record, prompts } = createHost({
      respond: titleReply("Bash backup script"),
      thread: { title: "Typed title" },
      outline: outlineItems(FALLBACK, "Commands.", "now a backup script", "Sure."),
    });
    await plugin(host.bb);

    const result = await host.harness.runCli(["retitle", THREAD_ID]);

    expect(result).toMatchObject({ exitCode: 0, stdout: "Bash backup script" });
    expect(state.thread.title).toBe("Bash backup script");
    expect(prompts()[0]).toContain("User: now a backup script\nAssistant: Sure.");
    await expect(record()).resolves.toEqual({
      title: "Bash backup script",
      turns: 2,
      retitled: true,
    });
  });

  it("prints JSON and fails on an empty thread or a claude error", async () => {
    const ok = createHost({ respond: titleReply("Bash demo") });
    await plugin(ok.host.bb);
    const json = await ok.host.harness.runCli(["retitle", THREAD_ID, "--json"]);
    expect(JSON.parse(json.stdout ?? "")).toEqual({
      threadId: THREAD_ID,
      title: "Bash demo",
    });

    const empty = createHost({ respond: titleReply("Bash demo"), outline: [] });
    await plugin(empty.host.bb);
    await expect(empty.host.harness.runCli(["retitle", THREAD_ID])).resolves.toEqual(
      expect.objectContaining({
        exitCode: 1,
        stderr: `${THREAD_ID} has no messages to title yet`,
      }),
    );

    const failing = createHost({
      respond: () => ({ ok: false, code: "not_found", message: "claude was not found" }),
    });
    await plugin(failing.host.bb);
    await expect(failing.host.harness.runCli(["retitle", THREAD_ID])).resolves.toEqual(
      expect.objectContaining({ exitCode: 1, stderr: "claude was not found" }),
    );
    expect(failing.state.thread.title).toBeNull();
  });

  it("needs exactly one thread id", async () => {
    const { host } = createHost({ respond: titleReply("x") });
    await plugin(host.bb);

    const result = await host.harness.runCli(["retitle"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("retitle <threadId>");
  });
});

describe("second title pass with a scripted claude", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "claude-title-retitle-test-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("runs claude on the primary host with the outline on stdin", async () => {
    const binDir = path.join(root, "bin");
    await mkdir(binDir, { recursive: true });
    const claude = path.join(binDir, "claude");
    const result = JSON.stringify({
      type: "result",
      is_error: false,
      result: '"Demo bash commands."\n',
    });
    await writeFile(
      claude,
      [
        "#!/bin/sh",
        `cat > "${root}/stdin"`,
        `cat <<'JSON'`,
        result,
        "JSON",
        "",
      ].join("\n"),
    );
    await chmod(claude, 0o755);
    const entry = experimental_createHostEntryHarness(
      createClaudeHostEntry({
        env: { PATH: `${binDir}${path.delimiter}/usr/bin${path.delimiter}/bin`, HOME: root },
        fallbackBinDirs: [],
        now: () => 0,
      }),
      {
        experimental_paths: {
          dataDir: path.join(root, "data"),
          tempDir: path.join(root, "tmp"),
        },
      },
    );
    const { host, state, idle } = createHost({
      respond: (call) => entry.experimental_call(call.method as "complete", call.input as never),
    });
    await plugin(host.bb);

    await idle("Here are a few bash commands.");

    expect(state.thread.title).toBe("Demo bash commands");
    const stdin = await readFile(path.join(root, "stdin"), "utf8");
    expect(stdin).toContain(`User: ${FALLBACK}\nAssistant: Here are a few bash commands.`);
    await entry.experimental_dispose();
  });
});
