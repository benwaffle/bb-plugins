/** The entity kinds in the dataset, as they appear in ids ("diam.avp/10415/1400", "svc/Nnrf_NFDiscovery"). */
export type EntityKind = "app" | "cmd" | "avp" | "if" | "nf" | "svc" | "proto";

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
}

export type Entity = AppEntity | CommandEntity | AvpEntity | InterfaceEntity | NfEntity | ServiceEntity | ProtocolEntity;

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
  search: SearchDoc[];
}
