import { appendFileSync, chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dashboard } from "./aggregate.js";
import { importTranscripts, projectResolver, type ImportOptions } from "./importer.js";
import { localTranscriptReader, type TranscriptReader } from "./transcripts.js";
import { fixtureProjects, memoryLedger, SESSION_A, SESSION_B } from "./test/helpers.js";

const NOW = Date.parse("2026-10-21T18:00:00.000Z");

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
      filesRestarted: 0,
      filesPending: 0,
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
    // 10×$4 + 200×$20 + 5000×$0.20 + 1000×$5 per million
    expect(rows.find((row) => row.id === "transcript:msg_A1")?.cost_usd).toBeCloseTo(0.01004, 10);
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
    expect(row.cost_usd).toBeCloseTo((1 * 4 + 30 * 20) / 1e6, 12);
  });
});

type Ledger = ReturnType<typeof memoryLedger>;

/** Everything an import writes that the Usage page reads. */
function aggregates(ledger: Ledger) {
  const all = (sql: string) => ledger.db.prepare(sql).all();
  return {
    usage: all(`SELECT * FROM usage ORDER BY id`),
    prompts: all(`SELECT * FROM prompts ORDER BY uuid`),
    titles: all(`SELECT * FROM session_titles ORDER BY session_id`),
    dashboard: dashboard(ledger.db, { days: 30, source: "all", sort: "cost" }, NOW),
  };
}

function transcriptPaths(reader: TranscriptReader): Promise<string[]> {
  return reader.list().then((files) => files.map((file) => file.path));
}

/** Imports until no file has unread bytes left, returning how many imports that took. */
async function importAll(ledger: Ledger, reader: TranscriptReader, options: ImportOptions = {}): Promise<number> {
  for (let imports = 1; imports <= 100; imports += 1) {
    if ((await importTranscripts(ledger, reader, projectOf, options)).filesPending === 0) return imports;
  }
  throw new Error("import did not catch up");
}

describe("incremental import", () => {
  it("records the same aggregates whether a fixture set is imported at once or in two steps", async () => {
    const full = memoryLedger();
    await importTranscripts(full, localTranscriptReader(fixtureProjects()), projectOf);

    const root = fixtureProjects();
    const reader = localTranscriptReader(root);
    const contents = new Map<string, Buffer>();
    for (const path of await transcriptPaths(reader)) {
      const bytes = readFileSync(path);
      contents.set(path, bytes);
      // Cut mid-line, so the first step ends on a partial line.
      writeFileSync(path, bytes.subarray(0, Math.floor(bytes.length / 2)));
    }
    const incremental = memoryLedger();
    const first = await importTranscripts(incremental, reader, projectOf);
    expect(first.filesRead).toBe(3);
    expect(aggregates(incremental)).not.toEqual(aggregates(full));

    for (const [path, bytes] of contents) appendFileSync(path, bytes.subarray(Math.floor(bytes.length / 2)));
    const second = await importTranscripts(incremental, reader, projectOf);
    expect(second).toMatchObject({ filesRead: 3, filesRestarted: 0, filesPending: 0 });
    expect(aggregates(incremental)).toEqual(aggregates(full));
  });

  it("spreads a budget-capped import over several calls with the same result", async () => {
    const full = memoryLedger();
    await importTranscripts(full, localTranscriptReader(fixtureProjects()), projectOf);

    // Each clock read advances 1ms, so a 5ms budget stops a few lines into a file.
    let ms = 0;
    const sliced = memoryLedger();
    const imports = await importAll(sliced, localTranscriptReader(fixtureProjects()), {
      budget: { maxFiles: 1, maxMs: 5 },
      clock: () => (ms += 1),
    });
    expect(imports).toBeGreaterThan(3);
    expect(aggregates(sliced)).toEqual(aggregates(full));
  });

  it("reads a file again from the start when it shrank or the line before its cursor changed", async () => {
    const root = fixtureProjects();
    const reader = localTranscriptReader(root);
    const ledger = memoryLedger();
    await importTranscripts(ledger, reader, projectOf);
    const gadget = join(root, "-home-dev-gadget", `${SESSION_B}.jsonl`);
    const original = readFileSync(gadget, "utf8");

    // Same length, last line edited in place, then grown so size and mtime change.
    writeFileSync(gadget, `${original.replaceAll("msg_B1", "msg_X1")}\n`);
    const rewritten = await importTranscripts(ledger, reader, projectOf);
    expect(rewritten).toMatchObject({ filesRead: 1, filesRestarted: 1, messages: 1 });
    expect(usageRows(ledger).map((row) => row.id)).toContain("transcript:msg_X1");

    writeFileSync(gadget, original.slice(0, original.indexOf("\n") + 1));
    const shrunk = await importTranscripts(ledger, reader, projectOf);
    expect(shrunk).toMatchObject({ filesRead: 1, filesRestarted: 1, messages: 0 });

    appendFileSync(gadget, original.slice(original.indexOf("\n") + 1));
    const grown = await importTranscripts(ledger, reader, projectOf);
    expect(grown).toMatchObject({ filesRead: 1, filesRestarted: 0 });
  });

  it("does not retry an unreadable file until it changes", async () => {
    const root = fixtureProjects();
    const reader = localTranscriptReader(root);
    const ledger = memoryLedger();
    const gadget = join(root, "-home-dev-gadget", `${SESSION_B}.jsonl`);
    chmodSync(gadget, 0o000);

    expect(await importTranscripts(ledger, reader, projectOf)).toMatchObject({ filesRead: 2, filesFailed: 1 });
    expect(await importTranscripts(ledger, reader, projectOf)).toMatchObject({ filesRead: 0, filesFailed: 0 });

    chmodSync(gadget, 0o644);
    appendFileSync(gadget, "\n");
    expect(await importTranscripts(ledger, reader, projectOf)).toMatchObject({ filesRead: 1, filesFailed: 0, messages: 1 });
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
