import { entityShortName, entityTitle, gtpLabel, hexByte, KIND_BADGES, vendorLabel, type Dataset } from "./dataset";
import type { SearchHit } from "./search";
import type { AvpFlags, AvpRef, Entity, GtpIeRow, GtpIeTable, ProtocolHeader, SpecRef } from "./types";

/** The nav panel path the page lives under, `/plugins/<pluginId>/<PANEL_PATH>/<entity id>`. */
export const PANEL_PATH = "ref";

/** How many linked items one detail list prints before "… N more". */
const LIST_LIMIT = 24;

/** How many IE table rows, nested rows included, one GTP message prints before pointing at its page. */
const IE_ROW_LIMIT = 160;

export function specLabel(ref: SpecRef): string {
  return ref.clause ? `${ref.doc} §${ref.clause}` : ref.doc;
}

/** The number an entry is known by, for its code badge: 316, 1400, 16777251, 0x85; null for interfaces and NFs. */
export function codeLabel(entity: Entity): string | null {
  switch (entity.kind) {
    case "cmd":
    case "avp":
    case "gtpcause":
      return String(entity.code);
    case "app":
      return String(entity.appId);
    case "gtpmsg":
    case "gtpie":
      return String(entity.type);
    case "gtpext":
      return hexByte(entity.type);
    default:
      return null;
  }
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

const stripNf = (ids: readonly string[]) => ids.map((id) => id.replace(/^nf\//, "")).join("/");

/** The first sentence of a description, for one-line summaries and link previews. */
export function firstSentence(text: string): string {
  const end = /[.!?](\s|$)/.exec(text);
  return end ? text.slice(0, end.index + 1) : text;
}

export function flagsLabel(flags: AvpFlags | null): string | null {
  if (!flags) return null;
  const parts = [
    flags.must.length > 0 ? `${flags.must.join(" ")} must` : null,
    flags.may.length > 0 ? `${flags.may.join(" ")} may` : null,
    flags.shouldNot.length > 0 ? `${flags.shouldNot.join(" ")} should not` : null,
    flags.mustNot.length > 0 ? `${flags.mustNot.join(" ")} must not` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : "no flag rules";
}

const BRACKETS: Record<AvpRef["kind"], [string, string]> = {
  fixed: ["<", ">"],
  required: ["{", "}"],
  optional: ["[", "]"],
};

/** The ABNF repetition prefix: "" for exactly the default, else "*", "1*", "2*5". */
export function repetition(ref: AvpRef): string {
  const defaultMin = ref.kind === "optional" ? 0 : 1;
  if (ref.max === 1 && ref.min === defaultMin) return "";
  const min = ref.min === defaultMin ? "" : String(ref.min);
  const max = ref.max === null ? "" : String(ref.max);
  return `${min}*${max}`;
}

/** The cardinality of an AVP line without its name: `*[ ]`, `{ }`. */
export function cardinality(ref: AvpRef): string {
  const [open, close] = BRACKETS[ref.kind];
  return `${repetition(ref)}${open} ${close}`;
}

/** One ABNF line: `*[ Supported-Features ]`. */
export function abnfLine(ref: AvpRef): string {
  const [open, close] = BRACKETS[ref.kind];
  return `${repetition(ref)}${open} ${ref.name} ${close}`;
}

/** A one-line summary of the facts every result shows. */
export function factLine(entity: Entity, dataset: Dataset): string {
  const parts: string[] = [];
  switch (entity.kind) {
    case "avp":
      parts.push(`AVP ${entity.code}`, `vendor ${entity.vendor} (${vendorLabel(entity.vendor)})`);
      if (entity.type) parts.push(entity.type);
      if (entity.flags) parts.push(`flags: ${flagsLabel(entity.flags)}`);
      break;
    case "cmd": {
      parts.push(`command ${entity.code}`);
      const apps = entity.apps.map((id) => dataset.byId.get(id)).filter((a) => a !== undefined);
      if (apps.length > 0) parts.push(`apps: ${apps.map(entityShortName).join(", ")}`);
      if (entity.flow) {
        const names = (ids: string[]) => ids.map((id) => id.replace(/^nf\//, "")).join("/");
        parts.push(`${names(entity.flow.request.from)} → ${names(entity.flow.request.to)}`);
      }
      break;
    }
    case "app":
      parts.push(`application ${entity.appId}`, vendorLabel(entity.vendor));
      break;
    case "if":
      parts.push(`${entity.endpoints.map((id) => id.replace(/^nf\//, "")).join(" ↔ ")}`);
      if (entity.protocol) parts.push(entity.protocol);
      if (entity.gtpMessages.length > 0) parts.push(plural(entity.gtpMessages.length, "GTP message"));
      break;
    case "nf":
      if (entity.generations.length > 0) parts.push(entity.generations.join("/"));
      break;
    case "svc": {
      const names = (ids: readonly string[]) => ids.map((id) => id.replace(/^nf\//, "")).join(", ");
      parts.push(`produced by ${names([entity.producer])}`);
      if (entity.consumers.length > 0) parts.push(`consumers: ${names(entity.consumers)}`);
      parts.push(`${entity.operations.length} operation${entity.operations.length === 1 ? "" : "s"}`);
      break;
    }
    case "proto":
      if (entity.transport) parts.push(entity.transport);
      if (entity.over.length > 0) parts.push(`over ${entity.over.map((id) => id.replace(/^proto\//, "")).join(", ")}`);
      parts.push(plural(entity.interfaces.length, "interface"));
      if (entity.messages.length > 0) parts.push(plural(entity.messages.length, "message"));
      break;
    case "gtpmsg": {
      parts.push(`${gtpLabel(entity.id)} message type ${entity.type}`);
      const roles = [entity.initial ? "initial" : null, entity.triggered ? "triggered" : null].filter(Boolean);
      if (roles.length > 0) parts.push(roles.join(" and "));
      const reply = entity.reply ? dataset.byId.get(entity.reply) : undefined;
      if (reply?.kind === "gtpmsg") parts.push(`reply: ${reply.name} (${reply.type})`);
      const asked = entity.replyTo.map((id) => dataset.byId.get(id)).filter((m) => m?.kind === "gtpmsg");
      if (asked.length > 0) parts.push(`replies to ${asked.map((m) => (m?.kind === "gtpmsg" ? `${m.name} (${m.type})` : "")).join(", ")}`);
      if (entity.flow) parts.push(`${stripNf(entity.flow.from)} → ${stripNf(entity.flow.to)}`);
      if (entity.interfaces.length > 0) parts.push(`on ${entity.interfaces.map((id) => id.replace(/^if\//, "")).join(", ")}`);
      break;
    }
    case "gtpie":
      parts.push(`${gtpLabel(entity.id)} IE type ${entity.type}`);
      if (entity.encoding) parts.push(entity.encoding);
      if (entity.length) parts.push(entity.length);
      if (entity.fixedOctets) parts.push(`fixed octets: ${entity.fixedOctets}`);
      parts.push(`in ${plural(entity.carriedIn.length, "message")}`);
      break;
    case "gtpcause":
      parts.push(`${gtpLabel(entity.id)} cause ${entity.code}`, CAUSE_CATEGORY[entity.category]);
      break;
    case "gtpext":
      parts.push(`${gtpLabel(entity.id)} extension header ${hexByte(entity.type)} (${entity.type})`);
      break;
  }
  return parts.join(" · ");
}

const CAUSE_CATEGORY = {
  request: "sent in a request or initial message",
  acceptance: "acceptance in a response or triggered message",
  rejection: "rejection in a response or triggered message",
} as const;

/** The IE type as the table prints it, with its value when it names one IE: "F-TEID (87)", "MM Context". */
function ieTypeLabel(row: GtpIeRow, dataset: Dataset): string {
  const ie = row.ie ? dataset.byId.get(row.ie) : undefined;
  return ie?.kind === "gtpie" ? `${row.type} (${ie.type})` : row.type;
}

/** One IE row: "IMSI: IMSI (1), C, instance 0". */
export function ieRowLine(row: GtpIeRow, dataset: Dataset): string {
  const facts = [ieTypeLabel(row, dataset), row.presence.join("/") || null, row.instance !== null ? `instance ${row.instance}` : null];
  return `${row.name}: ${facts.filter(Boolean).join(", ")}`;
}

/** An IE table as indented markdown lines, grouped IEs nested under their row, at most `budget` rows. */
function ieTableLines(table: GtpIeTable, dataset: Dataset, depth: number, budget: { left: number }): string[] {
  const lines: string[] = [];
  const indent = "  ".repeat(depth);
  for (const row of table.rows) {
    if (budget.left <= 0) break;
    budget.left -= 1;
    const group = row.group ? ` — ${row.group.title} (Table ${row.group.table}):` : "";
    lines.push(`${indent}- ${ieRowLine(row, dataset)}${group}`);
    if (row.group) lines.push(...ieTableLines(row.group, dataset, depth + 1, budget));
  }
  return lines;
}

function countRows(table: GtpIeTable): number {
  return table.rows.reduce((sum, row) => sum + 1 + (row.group ? countRows(row.group) : 0), 0);
}

function headerLines(header: ProtocolHeader): string[] {
  return [
    `Header (${specLabel(header.spec)}):`,
    ...header.fields.map((field) => `- octet ${field.octets}${field.bits ? `, bits ${field.bits}` : ""}: ${field.name}. ${field.description}`),
  ];
}

function names(dataset: Dataset, ids: readonly string[]): string {
  const shown = ids.slice(0, LIST_LIMIT).map((id) => {
    const entity = dataset.byId.get(id);
    if (!entity) return id;
    if (entity.kind === "avp" || entity.kind === "cmd" || entity.kind === "gtpcause") return `${entityShortName(entity)} (${entity.code})`;
    if (entity.kind === "gtpmsg" || entity.kind === "gtpie") return `${entityShortName(entity)} (${entity.type})`;
    if (entity.kind === "gtpext") return `${entityShortName(entity)} (${hexByte(entity.type)})`;
    return entityShortName(entity);
  });
  const more = ids.length - shown.length;
  return more > 0 ? `${shown.join(", ")}, … ${more} more` : shown.join(", ");
}

export function entityPath(pluginId: string, id: string): string {
  return `/plugins/${pluginId}/${PANEL_PATH}/${id}`;
}

/** A search hit as a markdown block: heading, facts, description, spec references. */
export function formatHit(hit: SearchHit, dataset: Dataset): string {
  const entity = hit.entity;
  const lines = [`### ${KIND_BADGES[entity.kind]} ${entityTitle(entity)}`, factLine(entity, dataset)];
  if (entity.description) lines.push(entity.description);
  if (entity.spec.length > 0) lines.push(`Spec: ${entity.spec.map(specLabel).join("; ")}`);
  lines.push(`id: ${entity.id}`);
  return lines.join("\n");
}

/** Everything about one entity, with its cross-links, as bounded markdown. */
export function formatEntity(entity: Entity, dataset: Dataset, pluginId: string): string {
  const lines = [`## ${KIND_BADGES[entity.kind]} ${entityTitle(entity)}`, factLine(entity, dataset)];
  if (entity.description) lines.push("", entity.description);
  const section = (label: string, ids: readonly string[]) => {
    if (ids.length > 0) lines.push(`${label}: ${names(dataset, ids)}`);
  };
  lines.push("");
  switch (entity.kind) {
    case "avp": {
      if (entity.children.length > 0) {
        const shown = entity.children.slice(0, LIST_LIMIT).map(abnfLine);
        const more = entity.children.length - shown.length;
        lines.push(`Children: ${shown.join(" ")}${more > 0 ? ` … ${more} more` : ""}`);
      }
      section("Parents", entity.parents);
      section("Carried in", entity.carriedIn);
      section("Applications", entity.apps);
      section("Interfaces", entity.interfaces);
      break;
    }
    case "cmd": {
      for (const format of entity.formats) {
        const app = dataset.byId.get(format.app);
        const label = app ? entityShortName(app) : format.app;
        const shown = format.avps.slice(0, LIST_LIMIT).map(abnfLine);
        const more = format.avps.length - shown.length;
        lines.push(
          `${format.name} (${label}, ${specLabel(format.spec)}): ${shown.join(" ")}${more > 0 ? ` … ${more} more` : ""}`,
        );
      }
      section("Interfaces", entity.interfaces);
      break;
    }
    case "app":
      section("Commands", entity.commands);
      section("Interfaces", entity.interfaces);
      break;
    case "if":
      section("Endpoints", entity.endpoints);
      section("Protocols", entity.protocols);
      section("Applications", entity.apps);
      section("SBI services", entity.services);
      section("GTP messages", entity.gtpMessages);
      break;
    case "nf":
      section("Interfaces", entity.interfaces);
      section("Produces", entity.services);
      section("Replaces", entity.replaces);
      section("Replaced by", entity.replacedBy);
      break;
    case "svc": {
      const shown = entity.operations.slice(0, LIST_LIMIT).map((operation) => {
        const consumers = operation.consumers.map((id) => id.replace(/^nf\//, "")).join("/");
        const facts = [operation.semantics, consumers ? `from ${consumers}` : null].filter(Boolean).join(", ");
        return facts ? `${operation.name} (${facts})` : operation.name;
      });
      const more = entity.operations.length - shown.length;
      if (shown.length > 0) lines.push(`Operations: ${shown.join("; ")}${more > 0 ? `; … ${more} more` : ""}`);
      section("Producer", [entity.producer]);
      section("Consumers", entity.consumers);
      section("Reference points", entity.interfaces);
      if (entity.aliases.length > 0) lines.push(`Also called: ${entity.aliases.join(", ")}`);
      break;
    }
    case "proto":
      section("Runs over", entity.over);
      section("Carries", entity.carries);
      section("Interfaces", entity.interfaces);
      if (entity.aliases.length > 0) lines.push(`Also called: ${entity.aliases.join(", ")}`);
      if (entity.header) lines.push(...headerLines(entity.header));
      section("Messages", entity.messages);
      break;
    case "gtpmsg": {
      if (entity.group) lines.push(`Message type table group: ${entity.group}`);
      if (entity.flow) {
        section("Sent by", entity.flow.from);
        section("Received by", entity.flow.to);
      }
      section("Interfaces", entity.interfaces);
      const budget = { left: IE_ROW_LIMIT };
      for (const table of entity.ieTables) {
        lines.push(`${table.title} (Table ${table.table}, ${specLabel(table.spec)}), name: IE type, presence, instance:`);
        lines.push(...ieTableLines(table, dataset, 0, budget));
      }
      const total = entity.ieTables.reduce((sum, table) => sum + countRows(table), 0);
      if (total > IE_ROW_LIMIT) lines.push(`… ${total - IE_ROW_LIMIT} more IE rows; see the page.`);
      if (entity.ieTables.length === 0) lines.push("No IE table: the spec defines none for this message.");
      break;
    }
    case "gtpie":
      if (entity.aliases.length > 0) lines.push(`Also called: ${entity.aliases.join(", ")}`);
      section("Carried in", entity.carriedIn);
      section("Interfaces", entity.interfaces);
      break;
    case "gtpcause":
      break;
    case "gtpext":
      lines.push(`Comprehension (bits 8 and 7 of the type): ${entity.comprehension}`);
      break;
  }
  if (entity.spec.length > 0) lines.push(`Spec: ${entity.spec.map(specLabel).join("; ")}`);
  lines.push(`Page: ${entityPath(pluginId, entity.id)}`);
  return lines.join("\n");
}
