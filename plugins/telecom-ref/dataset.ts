import apps from "./data/apps.json";
import avps from "./data/avps.json";
import commands from "./data/commands.json";
import gtpCauses from "./data/gtpCauses.json";
import gtpExtensions from "./data/gtpExtensions.json";
import gtpIes from "./data/gtpIes.json";
import gtpMessages from "./data/gtpMessages.json";
import interfaces from "./data/interfaces.json";
import meta from "./data/meta.json";
import nfs from "./data/nfs.json";
import protocols from "./data/protocols.json";
import search from "./data/search.json";
import services from "./data/services.json";
import type { Entity, EntityKind, GtpVersion, Meta, RawDataset, SearchDoc } from "./types";

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
  svc: "SBI services",
  proto: "Protocols",
  gtpmsg: "GTP messages",
  gtpie: "GTP IEs",
  gtpcause: "GTP causes",
  gtpext: "GTP extension headers",
};

export const KIND_BADGES: Record<EntityKind, string> = {
  cmd: "CMD",
  avp: "AVP",
  app: "APP",
  if: "IF",
  nf: "NF",
  svc: "SVC",
  proto: "PROTO",
  gtpmsg: "GTP-MSG",
  gtpie: "GTP-IE",
  gtpcause: "GTP-CAUSE",
  gtpext: "GTP-EXT",
};

export const KINDS: readonly EntityKind[] = ["cmd", "avp", "app", "if", "nf", "svc", "proto", "gtpmsg", "gtpie", "gtpcause", "gtpext"];

/** Each GTP version's protocol entity and the name its entries show: "GTPv2-C 32". */
export const GTP_VERSIONS: Record<GtpVersion, { protocol: string; label: string }> = {
  v2c: { protocol: "proto/GTPv2-C", label: "GTPv2-C" },
  v1c: { protocol: "proto/GTPv1-C", label: "GTPv1-C" },
  v1u: { protocol: "proto/GTP-U", label: "GTPv1-U" },
};

/** The GTP version of a GTP entity id: "gtp.ie/v2c/87" -> "v2c". */
export function gtpVersion(id: string): GtpVersion | null {
  const version = id.split("/")[1];
  return version !== undefined && version in GTP_VERSIONS ? (version as GtpVersion) : null;
}

/** "GTPv2-C" for a GTP entity, else null. */
export function gtpLabel(id: string): string | null {
  const version = gtpVersion(id);
  return entityKind(id)?.startsWith("gtp") && version ? GTP_VERSIONS[version].label : null;
}

/** "0x85", the form TS 29.281 and TS 29.060 extension header values are usually quoted in. */
export function hexByte(value: number): string {
  return `0x${value.toString(16).padStart(2, "0")}`;
}

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
    case "svc":
      return "svc";
    case "proto":
      return "proto";
    case "gtp.msg":
      return "gtpmsg";
    case "gtp.ie":
      return "gtpie";
    case "gtp.cause":
      return "gtpcause";
    case "gtp.ext":
      return "gtpext";
    default:
      return null;
  }
}

export function allEntities(raw: RawDataset): Entity[] {
  return [
    ...raw.apps,
    ...raw.commands,
    ...raw.avps,
    ...raw.interfaces,
    ...raw.nfs,
    ...raw.services,
    ...raw.protocols,
    ...raw.gtpMessages,
    ...raw.gtpIes,
    ...raw.gtpCauses,
    ...raw.gtpExtensions,
  ];
}

export function createDataset(raw: RawDataset): Dataset {
  const byId = new Map<string, Entity>();
  for (const entity of allEntities(raw)) {
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
    services: services as RawDataset["services"],
    protocols: protocols as RawDataset["protocols"],
    gtpMessages: gtpMessages as RawDataset["gtpMessages"],
    gtpIes: gtpIes as RawDataset["gtpIes"],
    gtpCauses: gtpCauses as RawDataset["gtpCauses"],
    gtpExtensions: gtpExtensions as RawDataset["gtpExtensions"],
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
    case "proto":
      return entity.fullName ? `${entity.name} · ${entity.fullName}` : entity.name;
    case "gtpie":
      return entity.abbrev ? `${entity.abbrev} · ${entity.name}` : entity.name;
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
    case "gtpie":
      return entity.abbrev ?? entity.name;
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
    case "gtpmsg":
      return `${gtpLabel(entity.id)} type ${entity.type}`;
    case "gtpie":
      return `${gtpLabel(entity.id)} IE ${entity.type}`;
    case "gtpcause":
      return `${gtpLabel(entity.id)} cause ${entity.code}`;
    case "gtpext":
      return `${gtpLabel(entity.id)} ${hexByte(entity.type)}`;
    default:
      return null;
  }
}

/** The protocols an entity belongs to, for the protocol filter: a GTP entry's version, an interface's protocols, a protocol itself. */
export function entityProtocols(entity: Entity): readonly string[] {
  switch (entity.kind) {
    case "gtpmsg":
    case "gtpie":
    case "gtpcause":
    case "gtpext":
      return [entity.protocol];
    case "if":
      return entity.protocols;
    case "proto":
      return [entity.id];
    default:
      return [];
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
