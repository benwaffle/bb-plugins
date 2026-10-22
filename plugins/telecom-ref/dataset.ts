import apps from "./data/apps.json";
import avps from "./data/avps.json";
import commands from "./data/commands.json";
import interfaces from "./data/interfaces.json";
import meta from "./data/meta.json";
import nfs from "./data/nfs.json";
import search from "./data/search.json";
import type { Entity, EntityKind, Meta, RawDataset, SearchDoc } from "./types";

export interface Dataset {
  meta: Meta;
  byId: ReadonlyMap<string, Entity>;
  search: readonly SearchDoc[];
  /** Lowercased description text by id, for description matches. */
  text: ReadonlyMap<string, string>;
}

export const KIND_LABELS: Record<EntityKind, string> = {
  cmd: "Diameter commands",
  avp: "Diameter AVPs",
  app: "Diameter applications",
  if: "Interfaces",
  nf: "Network functions",
};

export const KIND_BADGES: Record<EntityKind, string> = {
  cmd: "CMD",
  avp: "AVP",
  app: "APP",
  if: "IF",
  nf: "NF",
};

export const KINDS: readonly EntityKind[] = ["cmd", "avp", "app", "if", "nf"];

export function entityKind(id: string): EntityKind | null {
  const prefix = id.split("/")[0];
  switch (prefix) {
    case "diam.app":
      return "app";
    case "diam.cmd":
      return "cmd";
    case "diam.avp":
      return "avp";
    case "if":
      return "if";
    case "nf":
      return "nf";
    default:
      return null;
  }
}

export function createDataset(raw: RawDataset): Dataset {
  const byId = new Map<string, Entity>();
  for (const entity of [...raw.apps, ...raw.commands, ...raw.avps, ...raw.interfaces, ...raw.nfs]) {
    byId.set(entity.id, entity);
  }
  const text = new Map<string, string>();
  for (const entity of byId.values()) {
    if (entity.description) text.set(entity.id, entity.description.toLowerCase());
  }
  return { meta: raw.meta, byId, search: raw.search, text };
}

/** The dataset the plugin bundles from data/*.json. */
export function bundledRaw(): RawDataset {
  return {
    meta: meta as Meta,
    apps: apps as RawDataset["apps"],
    commands: commands as RawDataset["commands"],
    avps: avps as RawDataset["avps"],
    interfaces: interfaces as RawDataset["interfaces"],
    nfs: nfs as RawDataset["nfs"],
    search: search as SearchDoc[],
  };
}

let bundled: Dataset | null = null;

export function bundledDataset(): Dataset {
  bundled ??= createDataset(bundledRaw());
  return bundled;
}

/** The display title of an entity: "ULR / ULA · Update-Location", "Subscription-Data", "S6a". */
export function entityTitle(entity: Entity): string {
  switch (entity.kind) {
    case "cmd": {
      const abbrevs = [entity.request.abbrev, entity.answer?.abbrev].filter((a): a is string => !!a);
      return abbrevs.length > 0 ? `${abbrevs.join(" / ")} · ${entity.name}` : entity.name;
    }
    case "app":
      return entity.short && entity.short !== entity.name ? `${entity.short} · ${entity.name}` : entity.name;
    case "nf":
      return entity.fullName ? `${entity.name} · ${entity.fullName}` : entity.name;
    default:
      return entity.name;
  }
}

/** A short name for cross-link chips: "ULR/ULA", "Subscription-Data", "S6a/S6d". */
export function entityShortName(entity: Entity): string {
  switch (entity.kind) {
    case "cmd": {
      const abbrevs = [entity.request.abbrev, entity.answer?.abbrev].filter((a): a is string => !!a);
      return abbrevs.length > 0 ? abbrevs.join("/") : entity.name;
    }
    case "app":
      return entity.short ?? entity.name;
    default:
      return entity.name;
  }
}

export function vendorLabel(vendor: number): string {
  if (vendor === 0) return "IETF";
  if (vendor === 10415) return "3GPP";
  return `vendor ${vendor}`;
}

/** "code 316", "1400 · vendor 10415", "App 16777251", for result meta lines. */
export function entityCode(entity: Entity): string | null {
  switch (entity.kind) {
    case "cmd":
      return `code ${entity.code}`;
    case "avp":
      return `${entity.code} · vendor ${entity.vendor}`;
    case "app":
      return `App ${entity.appId}`;
    default:
      return null;
  }
}

/** The interfaces an entity belongs to, for the interface filter. */
export function entityInterfaces(entity: Entity): readonly string[] {
  switch (entity.kind) {
    case "if":
      return [entity.id];
    default:
      return entity.interfaces;
  }
}
