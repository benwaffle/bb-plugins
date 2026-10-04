import { describe, expect, it } from "vitest";
import { ticketTooltip } from "./tickets";
import { parseTwgWorkItems } from "./tools";

const url = "https://east-stout.atlassian.net/browse/CORE-51";

describe("ticketTooltip", () => {
  it("names the key, summary, and status, and says when the title is still loading", () => {
    expect(ticketTooltip("CORE-51", { key: "CORE-51", summary: "Track IMPI", status: "In Progress", url })).toBe(
      "CORE-51: Track IMPI (In Progress)",
    );
    expect(ticketTooltip("CORE-51", { key: "CORE-51", summary: "Track IMPI", status: null, url })).toBe(
      "CORE-51: Track IMPI",
    );
    expect(ticketTooltip("CORE-51", { key: "CORE-51", summary: null, status: null, url })).toBe(
      "CORE-51 (loading title)",
    );
    expect(ticketTooltip("CORE-51", undefined)).toBe("CORE-51 (loading title)");
  });
});

describe("parseTwgWorkItems", () => {
  it("reads the single-key array shape", () => {
    const raw = JSON.stringify({ data: [{ key: "CORE-51", summary: "Track IMPI", status: { name: "Done" } }] });
    expect(parseTwgWorkItems(raw)).toEqual(new Map([["CORE-51", { summary: "Track IMPI", status: "Done" }]]));
  });

  it("keeps only the items twg marks ok in the multi-key shape", () => {
    const raw = JSON.stringify({
      data: {
        items: [
          { input: "CORE-51", ok: true, data: { key: "CORE-51", summary: "Track IMPI", status: { name: "To Do" } } },
          { input: "CORE-1", ok: false, error: { message: "Issue does not exist", status: 404 } },
        ],
        summary: { requested: 2, succeeded: 1, failed: 1 },
      },
    });
    expect(parseTwgWorkItems(raw)).toEqual(new Map([["CORE-51", { summary: "Track IMPI", status: "To Do" }]]));
  });
});
