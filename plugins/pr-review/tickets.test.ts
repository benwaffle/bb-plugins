import { describe, expect, it } from "vitest";
import { ticketTooltip } from "./tickets";
import { parseTwgWorkItems } from "./tools";

const url = "https://example.atlassian.net/browse/ACME-51";

describe("ticketTooltip", () => {
  it("names the key, summary, and status, and says when the title is still loading", () => {
    expect(ticketTooltip("ACME-51", { key: "ACME-51", summary: "Cache catalog", status: "In Progress", url })).toBe(
      "ACME-51: Cache catalog (In Progress)",
    );
    expect(ticketTooltip("ACME-51", { key: "ACME-51", summary: "Cache catalog", status: null, url })).toBe(
      "ACME-51: Cache catalog",
    );
    expect(ticketTooltip("ACME-51", { key: "ACME-51", summary: null, status: null, url })).toBe(
      "ACME-51 (loading title)",
    );
    expect(ticketTooltip("ACME-51", undefined)).toBe("ACME-51 (loading title)");
  });
});

describe("parseTwgWorkItems", () => {
  it("reads the single-key array shape", () => {
    const raw = JSON.stringify({ data: [{ key: "ACME-51", summary: "Cache catalog", status: { name: "Done" } }] });
    expect(parseTwgWorkItems(raw)).toEqual(new Map([["ACME-51", { summary: "Cache catalog", status: "Done" }]]));
  });

  it("keeps only the items twg marks ok in the multi-key shape", () => {
    const raw = JSON.stringify({
      data: {
        items: [
          { input: "ACME-51", ok: true, data: { key: "ACME-51", summary: "Cache catalog", status: { name: "To Do" } } },
          { input: "ACME-1", ok: false, error: { message: "Issue does not exist", status: 404 } },
        ],
        summary: { requested: 2, succeeded: 1, failed: 1 },
      },
    });
    expect(parseTwgWorkItems(raw)).toEqual(new Map([["ACME-51", { summary: "Cache catalog", status: "To Do" }]]));
  });
});
