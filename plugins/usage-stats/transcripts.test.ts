import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { parseTranscriptLine, splitLines } from "./transcripts.js";

const FALLBACK = "fallback-session";

function line(value: unknown): string {
  return JSON.stringify(value);
}

describe("parseTranscriptLine", () => {
  it("reads an assistant message's id, model, timestamp, and usage split", () => {
    const entry = parseTranscriptLine(
      line({
        type: "assistant",
        sessionId: "s1",
        timestamp: "2026-10-20T10:00:05.000Z",
        cwd: "/home/dev/acme",
        message: {
          id: "msg_1",
          model: "claude-opus-5-5",
          usage: { input_tokens: 3, cache_creation_input_tokens: 40, cache_read_input_tokens: 500, output_tokens: 7 },
        },
      }),
      FALLBACK,
    );
    expect(entry).toEqual({
      kind: "message",
      messageId: "msg_1",
      sessionId: "s1",
      ts: Date.parse("2026-10-20T10:00:05.000Z"),
      model: "claude-opus-5-5",
      cwd: "/home/dev/acme",
      tokens: { input: 3, output: 7, cacheRead: 500, cacheWrite: 40 },
    });
  });

  it("skips synthetic replies, tool results, sidechain and meta prompts", () => {
    const ts = "2026-10-20T10:00:00.000Z";
    const synthetic = { type: "assistant", timestamp: ts, message: { id: "m", model: "<synthetic>", usage: {} } };
    const toolResult = { type: "user", uuid: "u", timestamp: ts, message: { content: [{ type: "tool_result", tool_use_id: "t" }] } };
    const sidechain = { type: "user", uuid: "u", timestamp: ts, isSidechain: true, message: { content: "go" } };
    const meta = { type: "user", uuid: "u", timestamp: ts, isMeta: true, message: { content: "caveat" } };
    for (const value of [synthetic, toolResult, sidechain, meta]) {
      expect(parseTranscriptLine(line(value), FALLBACK)).toBeNull();
    }
    expect(parseTranscriptLine("not json", FALLBACK)).toBeNull();
  });

  it("reads typed prompts, string or text blocks, with the file's session as fallback", () => {
    const ts = "2026-10-20T10:00:00.000Z";
    expect(parseTranscriptLine(line({ type: "user", uuid: "u1", timestamp: ts, message: { content: "hi" } }), FALLBACK)).toEqual({
      kind: "prompt",
      uuid: "u1",
      sessionId: FALLBACK,
      ts: Date.parse(ts),
    });
    const blocks = { type: "user", uuid: "u2", sessionId: "s", timestamp: ts, message: { content: [{ type: "text", text: "hi" }] } };
    expect(parseTranscriptLine(line(blocks), FALLBACK)).toMatchObject({ kind: "prompt", uuid: "u2", sessionId: "s" });
  });

  it("reads generated and custom session titles", () => {
    expect(parseTranscriptLine(line({ type: "ai-title", aiTitle: " Fix it ", sessionId: "s" }), FALLBACK)).toEqual({
      kind: "title",
      sessionId: "s",
      title: "Fix it",
      custom: false,
    });
    expect(parseTranscriptLine(line({ type: "custom-title", customTitle: "Mine", sessionId: "s" }), FALLBACK)).toMatchObject({
      custom: true,
      title: "Mine",
    });
  });
});

describe("splitLines", () => {
  it("yields complete lines with byte offsets and holds back a trailing partial line", async () => {
    const chunks = [Buffer.from("ab\nc"), Buffer.from("é\nunfinished")];
    const lines = [];
    for await (const entry of splitLines(Readable.from(chunks), 10)) lines.push(entry);
    expect(lines).toEqual([
      { text: "ab", endOffset: 13 },
      { text: "cé", endOffset: 17 },
    ]);
  });
});
