import { describe, expect, it } from "vitest";
import { bundledRaw } from "./dataset";
import type { RawDataset } from "./types";
import { validateDataset } from "./validate";

/**
 * A small consistent dataset: S6a carries ULR, which carries Subscription-Data, which groups MSISDN;
 * S6a runs Diameter, and the HSS produces Nhss_UECM. GTPv2-C has Echo Request, answered by Echo
 * Response, which carries the Recovery IE, and the Request accepted cause.
 */
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
        protocols: ["proto/Diameter"],
        apps: ["diam.app/16777251"],
        services: [],
        gtpMessages: [],
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
        services: [],
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
        services: ["svc/Nhss_UECM"],
      },
    ],
    services: [
      {
        id: "svc/Nhss_UECM",
        kind: "svc",
        name: "Nhss_UECM",
        aliases: [],
        producer: "nf/HSS",
        consumers: ["nf/MME"],
        operations: [{ name: "Update", semantics: "Request/Response", consumers: ["nf/MME"] }],
        description: null,
        spec: [{ doc: "TS 23.632", clause: "6.1.3" }],
        interfaces: [],
      },
    ],
    protocols: [
      {
        id: "proto/Diameter",
        kind: "proto",
        name: "Diameter",
        fullName: null,
        aliases: [],
        transport: "TCP or SCTP port 3868",
        over: [],
        carries: [],
        description: null,
        spec: [{ doc: "RFC 6733" }],
        interfaces: ["if/S6a"],
        messages: [],
        header: null,
      },
      {
        id: "proto/GTPv2-C",
        kind: "proto",
        name: "GTPv2-C",
        fullName: null,
        aliases: [],
        transport: "UDP port 2123",
        over: [],
        carries: [],
        description: null,
        spec: [{ doc: "TS 29.274" }],
        interfaces: [],
        messages: ["gtp.msg/v2c/1", "gtp.msg/v2c/2"],
        header: null,
      },
    ],
    gtpMessages: [
      {
        id: "gtp.msg/v2c/1",
        kind: "gtpmsg",
        protocol: "proto/GTPv2-C",
        type: 1,
        name: "Echo Request",
        initial: true,
        triggered: false,
        reply: "gtp.msg/v2c/2",
        replyTo: [],
        group: null,
        flow: null,
        ieTables: [],
        description: null,
        spec: [{ doc: "TS 29.274", clause: "7.1.1" }],
        interfaces: [],
      },
      {
        id: "gtp.msg/v2c/2",
        kind: "gtpmsg",
        protocol: "proto/GTPv2-C",
        type: 2,
        name: "Echo Response",
        initial: false,
        triggered: true,
        reply: null,
        replyTo: ["gtp.msg/v2c/1"],
        group: null,
        flow: null,
        ieTables: [
          {
            title: "Information Elements in Echo Response",
            table: "7.1.2-1",
            spec: { doc: "TS 29.274", clause: "7.1.2" },
            rows: [{ ie: "gtp.ie/v2c/3", name: "Recovery", type: "Recovery", presence: ["M"], instance: "0", group: null }],
          },
        ],
        description: null,
        spec: [{ doc: "TS 29.274", clause: "7.1.2" }],
        interfaces: [],
      },
    ],
    gtpIes: [
      {
        id: "gtp.ie/v2c/3",
        kind: "gtpie",
        protocol: "proto/GTPv2-C",
        type: 3,
        name: "Recovery (Restart Counter)",
        abbrev: null,
        aliases: [],
        encoding: null,
        length: "Variable",
        fixedOctets: null,
        carriedIn: ["gtp.msg/v2c/2"],
        description: null,
        spec: [{ doc: "TS 29.274", clause: "8.5" }],
        interfaces: [],
      },
    ],
    gtpCauses: [
      {
        id: "gtp.cause/v2c/16",
        kind: "gtpcause",
        protocol: "proto/GTPv2-C",
        code: 16,
        name: "Request accepted",
        category: "acceptance",
        description: null,
        spec: [{ doc: "TS 29.274", clause: "8.4" }],
        interfaces: [],
      },
    ],
    gtpExtensions: [],
    search: [
      ["diam.app/16777251", ["s6as6d"]],
      ["diam.cmd/316", ["ulr", "updatelocationrequest", "316"]],
      ["diam.avp/10415/1400", ["subscriptiondata", "1400"]],
      ["diam.avp/10415/701", ["msisdn", "701"]],
      ["if/S6a", ["s6a"]],
      ["nf/MME", ["mme"]],
      ["nf/HSS", ["hss"]],
      ["svc/Nhss_UECM", ["nhssuecm"]],
      ["proto/Diameter", ["diameter"]],
      ["proto/GTPv2-C", ["gtpv2c"]],
      ["gtp.msg/v2c/1", ["echorequest", "1"]],
      ["gtp.msg/v2c/2", ["echoresponse", "2"]],
      ["gtp.ie/v2c/3", ["recoveryrestartcounter", "3"]],
      ["gtp.cause/v2c/16", ["requestaccepted", "16"]],
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

  it("reports protocol and service links that their targets do not mirror", () => {
    const raw = fixture();
    raw.interfaces[0]!.protocols = [];
    raw.nfs[1]!.services = [];
    raw.services[0]!.consumers = ["if/S6a"];
    const issues = validateDataset(raw);
    expect(issues).toContainEqual({ id: "proto/Diameter", field: "interfaces", message: "if/S6a does not list it" });
    expect(issues).toContainEqual({ id: "svc/Nhss_UECM", field: "producer", message: "nf/HSS does not list it" });
    expect(issues).toContainEqual(expect.objectContaining({ id: "svc/Nhss_UECM", field: "consumers", message: "if/S6a is a if, expected nf" }));
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

describe("validateDataset on GTP entries", () => {
  it("reports a reply its target does not mirror", () => {
    const raw = fixture();
    raw.gtpMessages[1]!.replyTo = [];
    expect(validateDataset(raw)).toContainEqual({ id: "gtp.msg/v2c/1", field: "reply", message: "gtp.msg/v2c/2 does not list it in replyTo" });
  });

  it("reports an IE table row naming a missing IE, and an IE whose carriers do not carry it", () => {
    const raw = fixture();
    raw.gtpMessages[1]!.ieTables[0]!.rows[0]!.ie = "gtp.ie/v2c/999";
    const issues = validateDataset(raw);
    expect(issues).toContainEqual({ id: "gtp.msg/v2c/2", field: "ieTables[0].rows[0].ie", message: "dangling link to gtp.ie/v2c/999" });
    expect(issues).toContainEqual({ id: "gtp.ie/v2c/3", field: "carriedIn", message: "gtp.msg/v2c/2 does not carry it" });
  });

  it("reports an id that disagrees with its value or version, and links across versions", () => {
    const raw = fixture();
    raw.gtpCauses[0]!.code = 17;
    raw.gtpIes[0]!.protocol = "proto/Diameter";
    const issues = validateDataset(raw);
    expect(issues).toContainEqual({ id: "gtp.cause/v2c/16", field: "id", message: "id does not end in its value 17" });
    expect(issues).toContainEqual({
      id: "gtp.ie/v2c/3",
      field: "protocol",
      message: "proto/Diameter is not the protocol of its id's GTP version",
    });
    expect(issues).toContainEqual({ id: "gtp.msg/v2c/2", field: "ieTables", message: "gtp.ie/v2c/3 is proto/Diameter, not proto/GTPv2-C" });
  });

  it("reports a protocol message list that disagrees with the messages", () => {
    const raw = fixture();
    raw.protocols[1]!.messages = ["gtp.msg/v2c/1"];
    expect(validateDataset(raw)).toContainEqual({ id: "gtp.msg/v2c/2", field: "protocol", message: "proto/GTPv2-C does not list it" });
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
      services: raw.services.length,
      protocols: raw.protocols.length,
      gtpMessages: raw.gtpMessages.length,
      gtpIes: raw.gtpIes.length,
      gtpCauses: raw.gtpCauses.length,
      gtpExtensions: raw.gtpExtensions.length,
    });
  });
});
