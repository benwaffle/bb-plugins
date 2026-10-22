import { describe, expect, it } from "vitest";
import { bundledDataset } from "./dataset";
import { normalize, parseQuery, resolve, search } from "./search";

const dataset = bundledDataset();

function topIds(query: string, limit = 5, filters = {}) {
  return search(dataset, query, filters, limit).map((hit) => hit.id);
}

describe("normalize", () => {
  it("folds case and punctuation the way the prebuilt index does", () => {
    expect(normalize("ULR-Flags")).toBe("ulrflags");
    expect(normalize("ulr flags")).toBe("ulrflags");
    expect(normalize("S13'")).toBe("s13");
  });
});

describe("parseQuery", () => {
  it("reads a leading kind word as a hint", () => {
    expect(parseQuery("AVP 1400")).toMatchObject({ normalized: "1400", kindHint: "avp" });
    expect(parseQuery("avp")).toMatchObject({ normalized: "avp", kindHint: null });
  });
});

describe("search ranking", () => {
  it("puts the command first for its abbreviation", () => {
    const [first] = search(dataset, "ULR", {}, 5);
    expect(first).toMatchObject({ id: "diam.cmd/316", match: "exact" });
  });

  it("ranks prefix matches after the exact abbreviation", () => {
    const ids = topIds("ULR", 5);
    expect(ids.indexOf("diam.cmd/316")).toBe(0);
    expect(ids).toContain("diam.avp/10415/1405"); // ULR-Flags
  });

  it("finds an AVP by name regardless of case and hyphens", () => {
    expect(topIds("subscription data", 1)).toEqual(["diam.avp/10415/1400"]);
  });

  it("matches codes, preferring the hinted kind", () => {
    expect(topIds("AVP 1400", 1)).toEqual(["diam.avp/10415/1400"]);
    expect(topIds("316", 1)).toEqual(["diam.cmd/316"]);
  });

  it("finds interfaces and network functions", () => {
    expect(topIds("S6a", 3)).toContain("if/S6a");
    expect(topIds("HSS", 1)).toEqual(["nf/HSS"]);
  });

  it("falls back to description text", () => {
    const hits = search(dataset, "default APN", {}, 50);
    expect(hits.some((hit) => hit.match === "description")).toBe(true);
  });

  it("applies kind and interface filters", () => {
    const hits = search(dataset, "location", { kinds: ["cmd"], interface: "if/S6a" }, 50);
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.entity.kind).toBe("cmd");
      expect(hit.entity.kind === "cmd" && hit.entity.interfaces).toContain("if/S6a");
    }
  });

  it("lists filtered entities for an empty query", () => {
    const hits = search(dataset, "", { kinds: ["app"] }, 500);
    expect(hits.length).toBe(dataset.meta.counts.apps);
  });
});

describe("resolve", () => {
  it("resolves ids and unique exact keys", () => {
    expect(resolve(dataset, "diam.avp/10415/1400")?.name).toBe("Subscription-Data");
    expect(resolve(dataset, "ULR")?.id).toBe("diam.cmd/316");
  });

  it("refuses prefixes and unknown ids", () => {
    expect(resolve(dataset, "Subscr")).toBeNull();
    expect(resolve(dataset, "diam.avp/10415/999999")).toBeNull();
  });
});
