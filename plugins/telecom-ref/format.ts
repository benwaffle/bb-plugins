import { entityShortName, entityTitle, KIND_BADGES, vendorLabel, type Dataset } from "./dataset";
import type { SearchHit } from "./search";
import type { AvpFlags, AvpRef, Entity, SpecRef } from "./types";

/** The nav panel path the page lives under, `/plugins/<pluginId>/<PANEL_PATH>/<entity id>`. */
export const PANEL_PATH = "ref";

/** How many linked items one detail list prints before "… N more". */
const LIST_LIMIT = 24;

export function specLabel(ref: SpecRef): string {
  return ref.clause ? `${ref.doc} §${ref.clause}` : ref.doc;
}

/** The number an entry is known by, for its code badge: 316, 1400, 16777251; null for interfaces and NFs. */
export function codeLabel(entity: Entity): string | null {
  switch (entity.kind) {
    case "cmd":
    case "avp":
      return String(entity.code);
    case "app":
      return String(entity.appId);
    default:
      return null;
  }
}

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
      break;
    case "nf":
      if (entity.generations.length > 0) parts.push(entity.generations.join("/"));
      break;
  }
  return parts.join(" · ");
}

function names(dataset: Dataset, ids: readonly string[]): string {
  const shown = ids.slice(0, LIST_LIMIT).map((id) => {
    const entity = dataset.byId.get(id);
    if (!entity) return id;
    if (entity.kind === "avp" || entity.kind === "cmd") return `${entityShortName(entity)} (${entity.code})`;
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
      section("Applications", entity.apps);
      break;
    case "nf":
      section("Interfaces", entity.interfaces);
      section("Replaces", entity.replaces);
      section("Replaced by", entity.replacedBy);
      break;
  }
  if (entity.spec.length > 0) lines.push(`Spec: ${entity.spec.map(specLabel).join("; ")}`);
  lines.push(`Page: ${entityPath(pluginId, entity.id)}`);
  return lines.join("\n");
}
