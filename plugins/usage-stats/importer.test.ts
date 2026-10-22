import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { importTranscripts, projectResolver } from "./importer.js";
import { localTranscriptReader } from "./transcripts.js";
import { fixtureProjects, memoryLedger, SESSION_A, SESSION_B } from "./test/helpers.js";

const projectOf = projectResolver([{ path: "/home/dev/acme", name: "Acme" }]);

function usageRows(ledger: ReturnType<typeof memoryLedger>) {
  return ledger.db
    .prepare(`SELECT id, session_id, model, project, input, output, cache_read, cache_write, cost_usd FROM usage ORDER BY id`)
    .all() as { id: string; session_id: string; model: string; project: string; cost_usd: number }[];
}

describe("importTranscripts", () => {
  it("records each API message once, though Claude Code writes a line per content block", async () => {
    const ledger = memoryLedger();
    const reader = localTranscriptReader(fixtureProjects());

    const counts = await importTranscripts(ledger, reader, projectOf);

    expect(counts).toEqual({
      files: 3,
      filesRead: 3,
      filesFailed: 0,
      messages: 5,
      // msg_A1's second content block, and msg_A2 copied into the forked session B
      repeatedLines: 2,
      prompts: 3,
      sessions: 2,
    });
    const rows = usageRows(ledger);
    expect(rows.map((row) => row.id)).toEqual([
      "transcript:msg_A1",
      "transcript:msg_A2",
      "transcript:msg_A3",
      "transcript:msg_B1",
      "transcript:msg_S1",
    ]);
    expect(rows.find((row) => row.id === "transcript:msg_A1")).toMatchObject({
      session_id: SESSION_A,
      project: "Acme",
      input: 10,
      output: 200,
      cache_read: 5000,
      cache_write: 1000,
    });
    // 10×$5 + 200×$25 + 5000×$0.50 + 1000×$6.25 per million
    expect(rows.find((row) => row.id === "transcript:msg_A1")?.cost_usd).toBeCloseTo(0.0138, 10);
    expect(rows.find((row) => row.id === "transcript:msg_A2")?.session_id).toBe(SESSION_A);
    expect(rows.find((row) => row.id === "transcript:msg_S1")?.session_id).toBe(SESSION_A);
    expect(rows.find((row) => row.id === "transcript:msg_B1")?.project).toBe("gadget");
  });

  it("reads only bytes appended since the last import", async () => {
    const ledger = memoryLedger();
    const root = fixtureProjects();
    const reader = localTranscriptReader(root);
    await importTranscripts(ledger, reader, projectOf);

    const again = await importTranscripts(ledger, reader, projectOf);
    expect(again).toMatchObject({ filesRead: 0, messages: 0, repeatedLines: 0, prompts: 0 });

    const appended = {
      type: "assistant",
      sessionId: SESSION_B,
      timestamp: "2026-10-21T12:05:00.000Z",
      message: {
        id: "msg_B2",
        model: "claude-opus-5-5",
        usage: { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 510, output_tokens: 4 },
      },
    };
    appendFileSync(join(root, "-home-dev-gadget", `${SESSION_B}.jsonl`), `${JSON.stringify(appended)}\n`);
    const third = await importTranscripts(ledger, reader, projectOf);
    expect(third).toMatchObject({ filesRead: 1, messages: 1, repeatedLines: 0, sessions: 1 });
  });

  it("keeps the larger count when a repeated line reports more tokens", async () => {
    const ledger = memoryLedger();
    const message = {
      kind: "message" as const,
      messageId: "msg_1",
      sessionId: "s",
      ts: 0,
      model: "claude-opus-5-5",
      cwd: null,
      tokens: { input: 1, output: 10, cacheRead: 0, cacheWrite: 0 },
    };
    expect(ledger.addTranscriptMessage(message, "local", null)).toBe(true);
    expect(ledger.addTranscriptMessage({ ...message, tokens: { ...message.tokens, output: 30 } }, "local", null)).toBe(false);
    expect(ledger.addTranscriptMessage(message, "local", null)).toBe(false);
    const row = ledger.db.prepare(`SELECT output, cost_usd FROM usage`).get() as { output: number; cost_usd: number };
    expect(row.output).toBe(30);
    expect(row.cost_usd).toBeCloseTo((1 * 5 + 30 * 25) / 1e6, 12);
  });
});

describe("projectResolver", () => {
  it("picks the longest project path prefix, else the directory name", () => {
    const resolve = projectResolver([
      { path: "/w/app", name: "App" },
      { path: "/w/app/packages/ui", name: "UI" },
    ]);
    expect(resolve("/w/app/packages/ui/src")).toBe("UI");
    expect(resolve("/w/app")).toBe("App");
    expect(resolve("/w/apple")).toBe("apple");
    expect(resolve(null)).toBeNull();
  });
});
