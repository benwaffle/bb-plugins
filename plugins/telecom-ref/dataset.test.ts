import { describe, expect, it } from "vitest";
import { bundledRaw } from "./dataset";
import type { RawDataset } from "./types";
import { validateDataset } from "./validate";

/** A small consistent dataset: S6a carries ULR, which carries Subscription-Data, which groups MSISDN. */
function fixture(): RawDataset {
  return {
    meta: { release: 18, built: "2026-10-22", counts: {}, specVersions: {}, sources: [], inScopeApps: [], notice: "" },
    apps: [
      {
        id: "diam.app/16777251",
        kind: "app",
        appId: 16777251,
        name: "3GPP S6a/S6d",
        short: "S6a/S6d",
        vendor: 10415,
        description: null,
        spec: [{ doc: "TS 29.272" }],
        commands: ["diam.cmd/316"],
        interfaces: ["if/S6a"],
      },
    ],
    commands: [
      {
        id: "diam.cmd/316",
        kind: "cmd",
        code: 316,
        name: "Update-Location",
        request: { name: "Update-Location-Request", abbrev: "ULR" },
        answer: { name: "Update-Location-Answer", abbrev: "ULA" },
        description: null,
        flow: { request: { from: ["nf/MME"], to: ["nf/HSS"] } },
        apps: ["diam.app/16777251"],
        formats: [
          {
            app: "diam.app/16777251",
            direction: "answer",
            name: "Update-Location-Answer",
            proxiable: true,
            avps: [{ avp: "diam.avp/10415/1400", name: "Subscription-Data", kind: "optional", min: 0, max: 1 }],
            spec: { doc: "TS 29.272", clause: "7.2.4" },
          },
        ],
        spec: [{ doc: "TS 29.272", clause: "7.2.3" }],
        interfaces: ["if/S6a"],
      },
    ],
    avps: [
      {
        id: "diam.avp/10415/1400",
        kind: "avp",
        code: 1400,
        vendor: 10415,
        name: "Subscription-Data",
        type: "Grouped",
        flags: { must: ["V", "M"], may: [], shouldNot: [], mustNot: [] },
        mayEncrypt: false,
        description: null,
        spec: [{ doc: "TS 29.272", clause: "7.3.2" }],
        children: [{ avp: "diam.avp/10415/701", name: "MSISDN", kind: "optional", min: 0, max: 1 }],
        parents: [],
        carriedIn: ["diam.cmd/316"],
        apps: ["diam.app/16777251"],
        interfaces: ["if/S6a"],
        inScope: true,
      },
      {
        id: "diam.avp/10415/701",
        kind: "avp",
        code: 701,
        vendor: 10415,
        name: "MSISDN",
        type: "OctetString",
        flags: null,
        mayEncrypt: null,
        description: null,
        spec: [{ doc: "TS 29.329" }],
        children: [],
        parents: ["diam.avp/10415/1400"],
        carriedIn: [],
        apps: ["diam.app/16777251"],
        interfaces: ["if/S6a"],
        inScope: true,
      },
    ],
    interfaces: [
      {
        id: "if/S6a",
        kind: "if",
        name: "S6a",
        generations: ["4G"],
        endpoints: ["nf/MME", "nf/HSS"],
        protocol: "Diameter",
        apps: ["diam.app/16777251"],
        description: null,
        aliases: [],
        spec: [{ doc: "TS 23.401", clause: "4.2" }],
      },
    ],
    nfs: [
      {
        id: "nf/MME",
        kind: "nf",
        name: "MME",
        fullName: "Mobility Management Entity",
        generations: ["4G"],
        description: null,
        replaces: [],
        replacedBy: [],
        aliases: [],
        spec: [],
        interfaces: ["if/S6a"],
      },
      {
        id: "nf/HSS",
        kind: "nf",
        name: "HSS",
        fullName: "Home Subscriber Server",
        generations: ["4G"],
        description: null,
        replaces: [],
        replacedBy: [],
        aliases: [],
        spec: [],
        interfaces: ["if/S6a"],
      },
    ],
    search: [
      ["diam.app/16777251", ["s6as6d"]],
      ["diam.cmd/316", ["ulr", "updatelocationrequest", "316"]],
      ["diam.avp/10415/1400", ["subscriptiondata", "1400"]],
      ["diam.avp/10415/701", ["msisdn", "701"]],
      ["if/S6a", ["s6a"]],
      ["nf/MME", ["mme"]],
      ["nf/HSS", ["hss"]],
    ],
  };
}

describe("validateDataset", () => {
  it("accepts a consistent dataset", () => {
    expect(validateDataset(fixture())).toEqual([]);
  });

  it("reports a dangling link", () => {
    const raw = fixture();
    raw.interfaces[0]!.endpoints = ["nf/MME", "nf/HLR"];
    expect(validateDataset(raw)).toContainEqual({ id: "if/S6a", field: "endpoints", message: "dangling link to nf/HLR" });
  });

  it("reports a link to an entity of the wrong kind", () => {
    const raw = fixture();
    raw.avps[0]!.carriedIn = ["diam.app/16777251"];
    expect(validateDataset(raw)).toContainEqual(
      expect.objectContaining({ id: "diam.avp/10415/1400", field: "carriedIn", message: "diam.app/16777251 is a app, expected cmd" }),
    );
  });

  it("reports a reverse link without its forward link", () => {
    const raw = fixture();
    raw.avps[0]!.children = [];
    expect(validateDataset(raw)).toContainEqual({
      id: "diam.avp/10415/701",
      field: "parents",
      message: "diam.avp/10415/1400 does not list it as a child",
    });
  });

  it("reports duplicate ids, malformed spec docs, and gaps in the search index", () => {
    const raw = fixture();
    raw.nfs.push({ ...raw.nfs[0]! });
    raw.nfs[0]!.spec = [{ doc: "29.272" }];
    raw.search = raw.search.filter(([id]) => id !== "if/S6a");
    raw.search.push(["nf/AMF", ["AMF"]]);
    const issues = validateDataset(raw);
    expect(issues).toContainEqual({ id: "nf/MME", field: "id", message: "duplicate id" });
    expect(issues).toContainEqual({ id: "nf/MME", field: "spec", message: 'malformed spec doc "29.272"' });
    expect(issues).toContainEqual({ id: "if/S6a", field: "search", message: "missing from the search index" });
    expect(issues).toContainEqual({ id: "nf/AMF", field: "search", message: "indexes a missing entity" });
    expect(issues).toContainEqual({ id: "nf/AMF", field: "search", message: 'key "AMF" is not normalized' });
  });
});

describe("the committed dataset", () => {
  const raw = bundledRaw();

  it("has no dangling cross-links or index gaps", () => {
    expect(validateDataset(raw)).toEqual([]);
  });

  it("describes every AVP the in-scope applications carry", () => {
    const missing = raw.avps.filter((avp) => avp.inScope && !avp.description).map((avp) => avp.id);
    expect(missing).toEqual([]);
  });

  it("describes every command of every in-scope application", () => {
    const inScope = new Set(raw.meta.inScopeApps);
    const missing = raw.apps
      .filter((app) => inScope.has(app.id))
      .flatMap((app) => app.commands)
      .filter((id) => !raw.commands.find((cmd) => cmd.id === id)?.description);
    expect(raw.meta.inScopeApps).toContain("diam.app/16777312");
    expect([...new Set(missing)]).toEqual([]);
  });

  it("matches the counts in meta.json", () => {
    expect(raw.meta.counts).toMatchObject({
      apps: raw.apps.length,
      commands: raw.commands.length,
      avps: raw.avps.length,
      interfaces: raw.interfaces.length,
      nfs: raw.nfs.length,
    });
  });
});
