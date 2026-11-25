/**
 * The entity kinds in the dataset. Ids start with the kind's prefix: "diam.avp/10415/1400",
 * "svc/Nnrf_NFDiscovery", "gtp.msg/v2c/32" (dataset.ts entityKind).
 */
export type EntityKind = "app" | "cmd" | "avp" | "if" | "nf" | "svc" | "proto" | "gtpmsg" | "gtpie" | "gtpcause" | "gtpext";

export interface SpecRef {
  /** "TS 29.272" or "RFC 6733". */
  doc: string;
  /** The Rel-18 version the data was read from, for 3GPP specs. */
  version?: string;
  clause?: string;
}

export interface AvpFlags {
  must: string[];
  may: string[];
  shouldNot: string[];
  mustNot: string[];
}

/** One AVP line of a command format or grouped AVP definition. */
export interface AvpRef {
  /** null for the generic `*[ AVP ]` extension point or a name no registry lists. */
  avp: string | null;
  name: string;
  /** `< x >` fixed, `{ x }` required, `[ x ]` optional. */
  kind: "fixed" | "required" | "optional";
  min: number;
  /** null: unbounded. */
  max: number | null;
}

export interface AppEntity {
  id: string;
  kind: "app";
  appId: number;
  name: string;
  short: string | null;
  vendor: number;
  description: string | null;
  spec: SpecRef[];
  commands: string[];
  interfaces: string[];
}

export interface CommandFormat {
  app: string;
  direction: "request" | "answer";
  name: string;
  proxiable: boolean;
  avps: AvpRef[];
  spec: SpecRef;
}

export interface CommandEntity {
  id: string;
  kind: "cmd";
  code: number;
  name: string;
  request: { name: string; abbrev: string | null };
  answer: { name: string; abbrev: string | null } | null;
  description: string | null;
  /** Network functions that send and receive the request. */
  flow: { request: { from: string[]; to: string[] } } | null;
  apps: string[];
  formats: CommandFormat[];
  spec: SpecRef[];
  interfaces: string[];
}

export interface AvpEntity {
  id: string;
  kind: "avp";
  code: number;
  vendor: number;
  name: string;
  type: string | null;
  flags: AvpFlags | null;
  mayEncrypt: boolean | null;
  description: string | null;
  spec: SpecRef[];
  children: AvpRef[];
  parents: string[];
  carriedIn: string[];
  apps: string[];
  interfaces: string[];
  /** Carried, directly or inside a grouped AVP, by an application this release describes in full. */
  inScope: boolean;
}

export interface InterfaceEntity {
  id: string;
  kind: "if";
  name: string;
  generations: string[];
  endpoints: string[];
  /** The protocol stack as the spec names it: "GTPv2-C / GTP-U". */
  protocol: string | null;
  /** The protocol entities ("proto/PFCP") the interface carries. */
  protocols: string[];
  apps: string[];
  /** The SBI services ("svc/Nsmf_PDUSession") whose producer and a consumer terminate this reference point. */
  services: string[];
  /** The GTP messages ("gtp.msg/v2c/32") the GTP specs list for this interface, GTPv2-C first, by type value. */
  gtpMessages: string[];
  description: string | null;
  aliases: string[];
  spec: SpecRef[];
}

export interface NfEntity {
  id: string;
  kind: "nf";
  name: string;
  fullName: string | null;
  generations: string[];
  description: string | null;
  replaces: string[];
  replacedBy: string[];
  aliases: string[];
  spec: SpecRef[];
  interfaces: string[];
  /** The SBI services it produces. */
  services: string[];
}

export interface ServiceOperation {
  name: string;
  /** "Request/Response" or "Subscribe/Notify", as the stage-2 service table gives it. */
  semantics: string | null;
  /** Example consumers the stage-2 service table lists. */
  consumers: string[];
}

export interface ServiceEntity {
  id: string;
  kind: "svc";
  /** "Nsmf_PDUSession". */
  name: string;
  aliases: string[];
  producer: string;
  consumers: string[];
  operations: ServiceOperation[];
  description: string | null;
  /** Stage-2 clauses first, then the stage-3 spec. */
  spec: SpecRef[];
  /** SBI reference points between the producer and a consumer: N11 for Nsmf_PDUSession. */
  interfaces: string[];
}

export interface ProtocolEntity {
  id: string;
  kind: "proto";
  name: string;
  fullName: string | null;
  aliases: string[];
  /** The transport it runs on and its port: "UDP port 8805". */
  transport: string | null;
  /** Protocols below it in the stack: S1AP over SCTP. */
  over: string[];
  /** Protocols that run over it. */
  carries: string[];
  description: string | null;
  spec: SpecRef[];
  interfaces: string[];
  /** Its messages ("gtp.msg/v2c/32"), by type value; empty for protocols this release has no message tables for. */
  messages: string[];
  /** The header layout, for the protocols whose header this reference describes. */
  header: ProtocolHeader | null;
}

export interface ProtocolHeader {
  spec: SpecRef;
  fields: HeaderField[];
}

/** One header field: "octet 1, bits 4: T (TEID flag)". */
export interface HeaderField {
  /** "1", "5-8", "9-11 (5-7 when T = 0)". */
  octets: string;
  /** "8-6", "4"; null for a whole-octet field. */
  bits: string | null;
  name: string;
  /** A summary written for this reference. */
  description: string;
}

/** The GTP versions the dataset holds, as their id segment: "gtp.msg/v2c/32". */
export type GtpVersion = "v2c" | "v1c" | "v1u";

/** One row of a GTP message's IE table. */
export interface GtpIeRow {
  /** The IE type ("gtp.ie/v2c/87"), or null when the row names a family of IE types ("MM Context"). */
  ie: string | null;
  /** The row's name: "Sender F-TEID for Control Plane". */
  name: string;
  /** The IE type as the table prints it: "F-TEID". */
  type: string;
  /** M, C, CO, or O. GTPv2-C tables give several rows for one IE when it has several conditions. */
  presence: string[];
  /** The instance number GTPv2-C tables give ("0", "VS" for Private Extension); null in GTPv1 tables. */
  instance: string | null;
  /** The table of a grouped IE's contents within this message: "Bearer Context to be created". */
  group: GtpIeTable | null;
}

export interface GtpIeTable {
  /** "Information Elements in a Create Session Request". */
  title: string;
  /** The spec's table number: "7.2.1-1". */
  table: string;
  spec: SpecRef;
  rows: GtpIeRow[];
}

export interface GtpMessageEntity {
  id: string;
  kind: "gtpmsg";
  /** "proto/GTPv2-C", "proto/GTPv1-C", or "proto/GTP-U". */
  protocol: string;
  type: number;
  name: string;
  /** GTPv2-C Table 6.1-1 Initial and Triggered columns; null for GTPv1, whose table has none. */
  initial: boolean | null;
  triggered: boolean | null;
  /** The message that answers this one: Create Session Response for Create Session Request. */
  reply: string | null;
  replyTo: string[];
  /** The heading of the message type table group the message sits under, as the spec prints it. */
  group: string | null;
  /** The nodes the message type table names as sender and receiver, end to end. */
  flow: { from: string[]; to: string[] } | null;
  /** IE tables: one per message, or one per variant ("SGSN-Initiated", "GGSN-Initiated") in TS 29.060. */
  ieTables: GtpIeTable[];
  description: string | null;
  spec: SpecRef[];
  interfaces: string[];
}

export interface GtpIeEntity {
  id: string;
  kind: "gtpie";
  protocol: string;
  type: number;
  name: string;
  /** The short name the IE type table gives in parentheses: "F-TEID". */
  abbrev: string | null;
  /** Other names the spec's message tables use for it: "PTI". */
  aliases: string[];
  /** TV or TLV in GTPv1; null in GTPv2-C, whose IEs all carry type, length, and instance. */
  encoding: string | null;
  /** Fixed, Variable, or Extendable, as the IE type table says. */
  length: string | null;
  /** The number of fixed octets the IE type table gives: "9/21/25", '"f+4-4" (See Figure 8.21-1)'. */
  fixedOctets: string | null;
  /** The messages whose IE tables carry it, directly or inside a grouped IE. */
  carriedIn: string[];
  description: string | null;
  spec: SpecRef[];
  interfaces: string[];
}

export interface GtpCauseEntity {
  id: string;
  kind: "gtpcause";
  protocol: string;
  code: number;
  name: string;
  /** Whether the value is sent in a request, or accepts or rejects one in a response. */
  category: "request" | "acceptance" | "rejection";
  description: string | null;
  spec: SpecRef[];
  interfaces: string[];
}

export interface GtpExtensionHeaderEntity {
  id: string;
  kind: "gtpext";
  protocol: string;
  /** The Next Extension Header Type value: 133 (0x85) for PDU Session Container. */
  type: number;
  name: string;
  /** What bits 8 and 7 of the type value tell a receiver that does not know it. */
  comprehension: string;
  description: string | null;
  spec: SpecRef[];
  interfaces: string[];
}

export type GtpEntity = GtpMessageEntity | GtpIeEntity | GtpCauseEntity | GtpExtensionHeaderEntity;

export type Entity =
  | AppEntity
  | CommandEntity
  | AvpEntity
  | InterfaceEntity
  | NfEntity
  | ServiceEntity
  | ProtocolEntity
  | GtpMessageEntity
  | GtpIeEntity
  | GtpCauseEntity
  | GtpExtensionHeaderEntity;

/** A prebuilt search document: the entity id and its normalized keys, best key first. */
export type SearchDoc = [id: string, keys: string[]];

export interface Meta {
  release: number;
  built: string;
  counts: Record<string, number>;
  specVersions: Record<string, string>;
  sources: Array<{ name: string; url: string }>;
  /** Applications whose commands and carried AVPs all have curated descriptions. */
  inScopeApps: string[];
  notice: string;
}

/** The dataset as the build writes it, one array per data/*.json file. */
export interface RawDataset {
  meta: Meta;
  apps: AppEntity[];
  commands: CommandEntity[];
  avps: AvpEntity[];
  interfaces: InterfaceEntity[];
  nfs: NfEntity[];
  services: ServiceEntity[];
  protocols: ProtocolEntity[];
  gtpMessages: GtpMessageEntity[];
  gtpIes: GtpIeEntity[];
  gtpCauses: GtpCauseEntity[];
  gtpExtensions: GtpExtensionHeaderEntity[];
  search: SearchDoc[];
}
