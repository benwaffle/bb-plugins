import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { bundledDataset, bundledRaw, GTP_VERSIONS, gtpVersion } from "./dataset";
import { resolve, search } from "./search";
import plugin, { TOOL_NAME } from "./server";
import type { Entity, GtpIeRow, GtpIeTable, GtpMessageEntity, GtpVersion } from "./types";
import { messageIes } from "./validate";

const raw = bundledRaw();
const dataset = bundledDataset();

function entity(id: string): Entity {
  const found = dataset.byId.get(id);
  if (!found) throw new Error(`no entity ${id}`);
  return found;
}

function message(id: string): GtpMessageEntity {
  const found = entity(id);
  if (found.kind !== "gtpmsg") throw new Error(`${id} is a ${found.kind}`);
  return found;
}

function row(table: GtpIeTable | undefined, name: string): GtpIeRow {
  const found = table?.rows.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no row ${name} in ${table?.title}`);
  return found;
}

function clauses(item: Entity): string[] {
  return item.spec.map((ref) => `${ref.doc} §${ref.clause ?? ""}`);
}

async function host() {
  const { bb, harness } = createFakePluginHost({ pluginId: "telecom-ref" });
  await plugin(bb);
  return harness;
}

function text(result: unknown): string {
  if (typeof result === "string") return result;
  const content = (result as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map((part) => part.text ?? "").join("\n");
}

describe("GTP spec versions", () => {
  it("records the Rel-18 version each GTP table was read from", () => {
    expect(raw.meta.specVersions).toMatchObject({
      "TS 29.274": "18.8.0",
      "TS 29.280": "18.0.0",
      "TS 29.281": "18.4.0",
      "TS 29.060": "18.0.0",
    });
    expect(entity("gtp.msg/v2c/32").spec[0]).toEqual({ doc: "TS 29.274", version: "18.8.0", clause: "7.2.1" });
  });
});

describe("GTP values checked against the spec tables", () => {
  it.each([
    ["gtp.msg/v2c/32", "Create Session Request", "TS 29.274 §7.2.1"],
    ["gtp.msg/v2c/33", "Create Session Response", "TS 29.274 §7.2.2"],
    ["gtp.msg/v2c/34", "Modify Bearer Request", "TS 29.274 §7.2.7"],
    ["gtp.msg/v2c/95", "Create Bearer Request", "TS 29.274 §7.2.3"],
    ["gtp.msg/v2c/170", "Release Access Bearers Request", "TS 29.274 §7.2.21"],
    ["gtp.msg/v2c/176", "Downlink Data Notification", "TS 29.274 §7.2.11.1"],
    ["gtp.msg/v2c/133", "Forward Relocation Request", "TS 29.274 §7.3.1"],
    ["gtp.msg/v2c/25", "SRVCC PS to CS Request", "TS 29.280 §5.2.2"],
    ["gtp.msg/v1u/255", "G-PDU", "TS 29.281 §6.1"],
    ["gtp.msg/v1u/254", "End Marker", "TS 29.281 §7.3.2"],
    ["gtp.msg/v1u/26", "Error Indication", "TS 29.281 §7.3.1"],
    ["gtp.msg/v1c/16", "Create PDP Context Request", "TS 29.060 §7.3.1"],
  ])("message %s is %s (%s)", (id, name, clause) => {
    const item = entity(id);
    expect(item.kind === "gtpmsg" && item.name).toBe(name);
    expect(clauses(item)).toContain(clause);
  });

  it.each([
    ["gtp.ie/v2c/1", "International Mobile Subscriber Identity", "IMSI", "TS 29.274 §8.3"],
    ["gtp.ie/v2c/2", "Cause", null, "TS 29.274 §8.4"],
    ["gtp.ie/v2c/87", "Fully Qualified Tunnel Endpoint Identifier", "F-TEID", "TS 29.274 §8.22"],
    ["gtp.ie/v2c/93", "Bearer Context", null, "TS 29.274 §8.28"],
    ["gtp.ie/v2c/51", "STN-SR", null, "TS 29.280 §6.2"],
    ["gtp.ie/v1u/16", "Tunnel Endpoint Identifier Data I", null, "TS 29.281 §8.3"],
    ["gtp.ie/v1c/17", "Tunnel Endpoint Identifier Control Plane", null, "TS 29.060 §7.7.14"],
  ])("IE %s is %s (%s)", (id, name, abbrev, clause) => {
    const item = entity(id);
    expect(item.kind === "gtpie" && [item.name, item.abbrev]).toEqual([name, abbrev]);
    expect(clauses(item)).toContain(clause);
  });

  it("gives an IE's length kind and fixed octets as the IE type table does", () => {
    expect(entity("gtp.ie/v2c/87")).toMatchObject({ length: "Extendable", fixedOctets: "9/21/25", encoding: null });
    expect(entity("gtp.ie/v1c/1")).toMatchObject({ encoding: "TV", length: "Fixed", fixedOctets: "1" });
  });

  it.each([
    ["gtp.cause/v2c/2", "Local Detach", "request"],
    ["gtp.cause/v2c/16", "Request accepted", "acceptance"],
    ["gtp.cause/v2c/64", "Context Not Found", "rejection"],
    ["gtp.cause/v2c/73", "No resources available", "rejection"],
    ["gtp.cause/v1c/128", "Request accepted", "acceptance"],
    ["gtp.cause/v1c/192", "Non-existent", "rejection"],
  ])("cause %s is %s, %s", (id, name, category) => {
    expect(entity(id)).toMatchObject({ name, category });
  });

  it("leaves out reserved, spare, and shall-not-be-used cause values", () => {
    for (const code of [0, 1, 20, 71, 79, 99, 118, 132, 240]) expect(dataset.byId.has(`gtp.cause/v2c/${code}`)).toBe(false);
  });

  it.each([
    [0x85, "PDU Session Container", "TS 29.281 §5.2.2.7"],
    [0x84, "NR RAN Container", "TS 29.281 §5.2.2.6"],
    [0x40, "UDP Port", "TS 29.281 §5.2.2.1"],
    [0xc0, "PDCP PDU Number", "TS 29.281 §5.2.2.2"],
    [0x82, "Long PDCP PDU Number", "TS 29.281 §5.2.2.2A"],
    [0x81, "RAN Container", "TS 29.281 §5.2.2.4"],
    [0x83, "Xw RAN Container", "TS 29.281 §5.2.2.5"],
  ])("GTP-U extension header 0x%s is %s (%s)", (value, name, clause) => {
    const item = entity(`gtp.ext/v1u/${value}`);
    expect(item.kind === "gtpext" && item.name).toBe(name);
    expect(clauses(item)).toContain(clause);
  });

  it("cites TS 38.415 for the PDU Session Container and reads comprehension from bits 8 and 7", () => {
    const container = entity("gtp.ext/v1u/133");
    expect(container.spec.map((ref) => ref.doc)).toContain("TS 38.415");
    expect(container.kind === "gtpext" && container.comprehension).toMatch(/^Comprehension required by the endpoint receiver/);
    expect(entity("gtp.ext/v1u/64").kind === "gtpext" && (entity("gtp.ext/v1u/64") as { comprehension: string }).comprehension).toMatch(
      /discards it/,
    );
  });
});

describe("GTP message IE tables", () => {
  it("lists Create Session Request IEs with presence and instance, and the bearer context inside", () => {
    const [table] = message("gtp.msg/v2c/32").ieTables;
    expect(table).toMatchObject({ title: "Information Elements in a Create Session Request", table: "7.2.1-1" });
    expect(row(table, "Sender F-TEID for Control Plane")).toMatchObject({ ie: "gtp.ie/v2c/87", presence: ["M"], instance: "0" });
    expect(row(table, "PGW S5/S8 Address for Control Plane or PMIP")).toMatchObject({ ie: "gtp.ie/v2c/87", instance: "1" });
    expect(row(table, "MSISDN").presence).toEqual(["C", "CO"]);
    const bearers = row(table, "Bearer Contexts to be created");
    expect(bearers).toMatchObject({ ie: "gtp.ie/v2c/93", presence: ["M"] });
    expect(bearers.group?.table).toBe("7.2.1-2");
    expect(row(bearers.group ?? undefined, "S1-U eNodeB F-TEID")).toMatchObject({ ie: "gtp.ie/v2c/87", instance: "0" });
    expect(row(table, "Private Extension")).toMatchObject({ ie: "gtp.ie/v2c/255", instance: "VS" });
  });

  it("nests the bearer contexts of Forward Relocation Request inside its PDN connections", () => {
    const [table] = message("gtp.msg/v2c/133").ieTables;
    const connections = row(table, "MME/SGSN/AMF UE EPS PDN Connections");
    expect(connections).toMatchObject({ ie: "gtp.ie/v2c/109" });
    expect(row(connections.group ?? undefined, "Bearer Contexts").group?.table).toBe("7.3.1-3");
  });

  it("gives TS 29.060 messages one IE table per variant the spec prints", () => {
    expect(message("gtp.msg/v1c/18").ieTables.map((table) => table.title)).toEqual([
      "Information Elements in an SGSN-Initiated Update PDP Context Request",
      "Information Elements in a GGSN-Initiated Update PDP Context Request",
    ]);
    expect(row(message("gtp.msg/v1c/16").ieTables[0], "IMSI")).toMatchObject({ ie: "gtp.ie/v1c/2", presence: ["C"], instance: null });
  });

  it.each([
    "Echo Request",
    "Echo Response",
    "Create Session Request",
    "Create Session Response",
    "Modify Bearer Request",
    "Modify Bearer Response",
    "Delete Session Request",
    "Delete Session Response",
    "Create Bearer Request",
    "Create Bearer Response",
    "Update Bearer Request",
    "Update Bearer Response",
    "Delete Bearer Request",
    "Delete Bearer Response",
    "Release Access Bearers Request",
    "Release Access Bearers Response",
    "Downlink Data Notification",
    "Downlink Data Notification Acknowledge",
    "Downlink Data Notification Failure Indication",
    "Bearer Resource Command",
    "Bearer Resource Failure Indication",
    "Modify Bearer Command",
    "Modify Bearer Failure Indication",
    "Delete Bearer Command",
    "Delete Bearer Failure Indication",
    "Context Request",
    "Context Response",
    "Context Acknowledge",
    "Forward Relocation Request",
    "Forward Relocation Response",
    "Forward Relocation Complete Notification",
    "Forward Relocation Complete Acknowledge",
    "Identification Request",
    "Identification Response",
    "Create Indirect Data Forwarding Tunnel Request",
    "Create Indirect Data Forwarding Tunnel Response",
    "Delete Indirect Data Forwarding Tunnel Request",
    "Delete Indirect Data Forwarding Tunnel Response",
    "Suspend Notification",
    "Suspend Acknowledge",
    "Resume Notification",
    "Resume Acknowledge",
    "PGW Restart Notification",
    "PGW Restart Notification Acknowledge",
    "Update PDN Connection Set Request",
    "Update PDN Connection Set Response",
    "Delete PDN Connection Set Request",
    "Delete PDN Connection Set Response",
  ])("GTPv2-C %s has an IE table", (name) => {
    const found = raw.gtpMessages.find((item) => item.protocol === "proto/GTPv2-C" && item.name === name);
    expect(found?.ieTables.length).toBeGreaterThan(0);
  });

  it("gives every message an IE table except Version Not Supported (Indication) and G-PDU, which carry no IEs", () => {
    const without = raw.gtpMessages.filter((item) => item.ieTables.length === 0).map((item) => item.id);
    expect(without).toEqual(["gtp.msg/v1c/3", "gtp.msg/v1u/255", "gtp.msg/v2c/3"]);
  });
});

describe("GTP data integrity", () => {
  const versions = Object.keys(GTP_VERSIONS) as GtpVersion[];

  it.each([
    ["gtpMessages", (item: { type?: number; code?: number }) => item.type],
    ["gtpIes", (item: { type?: number; code?: number }) => item.type],
    ["gtpCauses", (item: { type?: number; code?: number }) => item.code],
    ["gtpExtensions", (item: { type?: number; code?: number }) => item.type],
  ] as const)("has unique %s values per GTP version", (group, value) => {
    for (const version of versions) {
      const items = (raw[group] as Array<{ id: string; type?: number; code?: number }>).filter((item) => gtpVersion(item.id) === version);
      expect(new Set(items.map(value)).size, `${group} ${version}`).toBe(items.length);
    }
  });

  it("pairs every request with a reply of its own version that names it back", () => {
    for (const item of raw.gtpMessages) {
      if (item.reply === null) continue;
      const reply = message(item.reply);
      expect(reply.protocol, item.id).toBe(item.protocol);
      expect(reply.replyTo, item.id).toContain(item.id);
      if (item.protocol === "proto/GTPv2-C") expect(reply.triggered, item.id).toBe(true);
    }
    for (const item of raw.gtpMessages) for (const asked of item.replyTo) expect(message(asked).reply).toBe(item.id);
  });

  it.each([
    ["gtp.msg/v2c/32", "gtp.msg/v2c/33"],
    ["gtp.msg/v2c/64", "gtp.msg/v2c/65"],
    ["gtp.msg/v2c/68", "gtp.msg/v2c/69"],
    ["gtp.msg/v2c/131", "gtp.msg/v2c/132"],
    ["gtp.msg/v2c/135", "gtp.msg/v2c/136"],
    ["gtp.msg/v2c/179", "gtp.msg/v2c/180"],
    ["gtp.msg/v2c/162", "gtp.msg/v2c/163"],
    ["gtp.msg/v1c/55", "gtp.msg/v1c/59"],
    ["gtp.msg/v1u/1", "gtp.msg/v1u/2"],
  ])("answers %s with %s", (request, reply) => {
    expect(message(request).reply).toBe(reply);
  });

  it("leaves messages without a reply unpaired", () => {
    for (const id of ["gtp.msg/v2c/70", "gtp.msg/v2c/73", "gtp.msg/v1u/255", "gtp.msg/v1u/26"]) expect(message(id).reply).toBeNull();
  });

  it("resolves every IE a message table names to an IE of the same version", () => {
    for (const item of raw.gtpMessages) {
      for (const ieId of messageIes(item)) {
        const ie = entity(ieId);
        expect(ie.kind, `${item.id} -> ${ieId}`).toBe("gtpie");
        expect(ie.kind === "gtpie" && ie.protocol).toBe(item.protocol);
      }
    }
  });

  it("leaves unresolved only the rows that name a family of IE types", () => {
    const unresolved = new Set<string>();
    const visit = (table: GtpIeTable) => {
      for (const item of table.rows) {
        if (item.ie === null) unresolved.add(item.type);
        if (item.group) visit(item.group);
      }
    };
    raw.gtpMessages.forEach((item) => item.ieTables.forEach(visit));
    expect([...unresolved]).toEqual(["MM Context"]);
  });
});

describe("GTP on interfaces and protocols", () => {
  it("links S11 and N3 to the GTP messages they carry", () => {
    const s11 = entity("if/S11");
    expect(s11.kind === "if" && s11.gtpMessages).toEqual(expect.arrayContaining(["gtp.msg/v2c/32", "gtp.msg/v2c/176", "gtp.msg/v2c/170"]));
    const n3 = entity("if/N3");
    expect(n3.kind === "if" && n3.gtpMessages).toEqual(expect.arrayContaining(["gtp.msg/v1u/255", "gtp.msg/v1u/254", "gtp.msg/v1u/26"]));
  });

  it("keeps End Marker off N19 and the mobility messages on S3, S10, S16, and N26", () => {
    expect(message("gtp.msg/v1u/254").interfaces).not.toContain("if/N19");
    expect(message("gtp.msg/v1u/255").interfaces).toContain("if/N19");
    expect(message("gtp.msg/v2c/133").interfaces).toEqual(["if/S3", "if/S10", "if/S16", "if/N26"]);
    expect(message("gtp.msg/v2c/141").interfaces).toEqual(["if/S10", "if/N26"]);
  });

  it("takes the flow from the message type table, reversed for the reply", () => {
    expect(message("gtp.msg/v2c/176").flow).toEqual({ from: ["nf/SGW"], to: ["nf/SGSN", "nf/MME"] });
    expect(message("gtp.msg/v2c/177").flow).toEqual({ from: ["nf/SGSN", "nf/MME"], to: ["nf/SGW"] });
    expect(message("gtp.msg/v2c/65").flow).toEqual({ from: ["nf/PGW"], to: ["nf/MME", "nf/SGSN", "nf/TWAN", "nf/ePDG"] });
  });

  it("gives each GTP protocol its messages and header", () => {
    const counts = Object.fromEntries(
      Object.values(GTP_VERSIONS).map(({ protocol }) => {
        const item = entity(protocol);
        return [protocol, item.kind === "proto" ? item.messages.length : -1];
      }),
    );
    expect(counts).toEqual({ "proto/GTPv2-C": 96, "proto/GTPv1-C": 60, "proto/GTP-U": 7 });
    const v2 = entity("proto/GTPv2-C");
    expect(v2.kind === "proto" && v2.header?.fields.map((field) => field.name)).toEqual(
      expect.arrayContaining(["P (Piggybacking flag)", "T (TEID flag)", "MP (Message Priority flag)", "Sequence Number", "Message Priority"]),
    );
    const u = entity("proto/GTP-U");
    expect(u.kind === "proto" && u.header?.spec).toMatchObject({ doc: "TS 29.281", clause: "5.1" });
  });
});

describe("GTP search", () => {
  it("finds messages, IEs, causes, and extension headers by name", () => {
    expect(resolve(dataset, "Create Session Request")?.id).toBe("gtp.msg/v2c/32");
    expect(resolve(dataset, "F-TEID")?.id).toBe("gtp.ie/v2c/87");
    expect(resolve(dataset, "PDU Session Container")?.id).toBe("gtp.ext/v1u/133");
    expect(resolve(dataset, "gtpv2 cause Context Not Found")?.id).toBe("gtp.cause/v2c/64");
  });

  it("reads a leading GTP version and kind word", () => {
    expect(resolve(dataset, "gtpv2 32")?.id).toBe("gtp.msg/v2c/32");
    expect(resolve(dataset, "gtpv2 ie 87")?.id).toBe("gtp.ie/v2c/87");
    expect(resolve(dataset, "gtpv2 cause 16")?.id).toBe("gtp.cause/v2c/16");
    expect(resolve(dataset, "gtp-u 255")?.id).toBe("gtp.msg/v1u/255");
    expect(resolve(dataset, "0x85")?.id).toBe("gtp.ext/v1u/133");
  });

  it("filters by protocol and kind", () => {
    const hits = search(dataset, "Echo Request", { protocol: "proto/GTP-U" }, 10);
    expect(hits[0]?.id).toBe("gtp.msg/v1u/1");
    expect(hits.every((hit) => "protocol" in hit.entity && hit.entity.protocol === "proto/GTP-U")).toBe(true);
    expect(search(dataset, "254", { kinds: ["gtpmsg"], protocol: "proto/GTP-U" }, 1)[0]?.entity.name).toBe("End Marker");
    expect(search(dataset, "Request accepted", { kinds: ["gtpcause"] }, 5).map((hit) => hit.id)).toEqual(
      expect.arrayContaining(["gtp.cause/v2c/16", "gtp.cause/v1c/128"]),
    );
  });

  it("finds an IE by the other name the spec's message tables use", () => {
    expect(resolve(dataset, "GTP-U Peer Address")?.id).toBe("gtp.ie/v1u/133");
    expect(resolve(dataset, "PTI")?.id).toBe("gtp.ie/v2c/100");
  });
});

describe(`${TOOL_NAME} and bb telecom-ref on GTP`, () => {
  it("prints a message's full IE table with grouped IEs nested", async () => {
    const harness = await host();
    const output = text(await harness.behavior.callAgentTool(TOOL_NAME, { query: "Create Session Request" }));
    expect(output).toMatch(/^## GTP-MSG Create Session Request\n/);
    expect(output).toContain("GTPv2-C message type 32 · initial · reply: Create Session Response (33)");
    expect(output).toContain("Information Elements in a Create Session Request (Table 7.2.1-1, TS 29.274 §7.2.1)");
    expect(output).toContain("- Sender F-TEID for Control Plane: F-TEID (87), M, instance 0");
    expect(output).toContain("  - S1-U eNodeB F-TEID: F-TEID (87), C/CO, instance 0");
    expect(output).toContain("Page: /plugins/telecom-ref/ref/gtp.msg/v2c/32");
  });

  it("shows the full entry for an exact match within a kind and protocol filter", async () => {
    const harness = await host();
    const output = text(await harness.behavior.callAgentTool(TOOL_NAME, { query: "87", kind: "gtpie", protocol: "GTPv2-C" }));
    expect(output).toMatch(/^## GTP-IE F-TEID · Fully Qualified Tunnel Endpoint Identifier\n/);
    expect(output).toContain("GTPv2-C IE type 87 · Extendable · fixed octets: 9/21/25");
    expect(output).toContain("Spec: TS 29.274 §8.22");
  });

  it("prints an extension header with its comprehension rule", async () => {
    const harness = await host();
    const output = text(await harness.behavior.callAgentTool(TOOL_NAME, { query: "gtp-u ext 0x85", limit: 1 }));
    expect(output.slice(0, output.indexOf("\n\nRel-"))).toBe(
      [
        "## GTP-EXT PDU Session Container",
        "GTPv1-U extension header 0x85 (133)",
        "",
        "Comprehension (bits 8 and 7 of the type): Comprehension required by the endpoint receiver but not by an intermediate node, which forwards it.",
        "Spec: TS 29.281 §5.2.2.7; TS 29.281 §5.2.1; TS 38.415; TS 23.501",
        "Page: /plugins/telecom-ref/ref/gtp.ext/v1u/133",
      ].join("\n"),
    );
  });

  it("lists an interface's GTP messages and a protocol's header", async () => {
    const harness = await host();
    const s11 = text(await harness.behavior.callAgentTool(TOOL_NAME, { query: "S11", limit: 1 }));
    expect(s11).toContain("GTP messages: Create Session Request (32), Create Session Response (33)");
    const proto = text(await harness.behavior.callAgentTool(TOOL_NAME, { query: "GTPv2-C", limit: 1 }));
    expect(proto).toContain("Header (TS 29.274 §5.1):");
    expect(proto).toContain("- octet 1, bits 4: T (TEID flag).");
  });

  it("reports an unknown protocol as a tool error", async () => {
    const harness = await host();
    expect(text(await harness.behavior.callAgentTool(TOOL_NAME, { query: "x", protocol: "GTPv9" }))).toContain('no protocol named "GTPv9"');
  });

  it("search filters by kind and protocol from the CLI", async () => {
    const harness = await host();
    const result = await harness.behavior.runCli(["search", "32", "--kind", "gtpmsg", "--protocol", "GTPv2-C", "--limit", "1"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      [
        "### GTP-MSG Create Session Request",
        "GTPv2-C message type 32 · initial · reply: Create Session Response (33) · SGSN/MME/TWAN/ePDG → PGW · on S4, S11, S5, S8, S2a, S2b",
        "Spec: TS 29.274 §7.2.1; TS 29.274 §6.1.0",
        "id: gtp.msg/v2c/32",
        "",
      ].join("\n"),
    );
  });

  it("search fails with a hint for an unknown protocol", async () => {
    const harness = await host();
    const result = await harness.behavior.runCli(["search", "Echo", "--protocol", "nope"]);
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stderr}`).toContain("--kind proto");
  });

  it("show prints a cause by id", async () => {
    const harness = await host();
    const result = await harness.behavior.runCli(["show", "gtp.cause/v2c/16"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("## GTP-CAUSE Request accepted\nGTPv2-C cause 16 · acceptance in a response or triggered message");
  });
});
