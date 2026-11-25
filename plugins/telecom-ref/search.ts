import { entityInterfaces, entityKind, entityProtocols, entityTitle, KINDS, type Dataset } from "./dataset";
import type { Entity, EntityKind } from "./types";

/**
 * Lowercase ASCII letters and digits only. data/build.py (norm_key) builds
 * the prebuilt index keys with the same rule, so "ULR-Flags", "ulr flags",
 * and "ULRFlags" all meet at "ulrflags".
 */
export function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export interface SearchFilters {
  kinds?: readonly EntityKind[];
  /** An interface id ("if/S6a"); keeps entities that belong to it. */
  interface?: string | null;
  /** A protocol id ("proto/GTPv2-C"); keeps the protocol, its messages, IEs, causes, and extension headers, and the interfaces that carry it. */
  protocol?: string | null;
}

export type MatchKind = "exact" | "code" | "prefix" | "substring" | "words" | "description";

export interface SearchHit {
  id: string;
  entity: Entity;
  score: number;
  match: MatchKind;
}

/** Leading words that name a kind: "AVP 1400", "cmd ULR", "interface S6a", "ie 87". */
const KIND_WORDS: Record<string, EntityKind> = {
  avp: "avp",
  avps: "avp",
  cmd: "cmd",
  command: "cmd",
  commands: "cmd",
  app: "app",
  application: "app",
  if: "if",
  interface: "if",
  nf: "nf",
  node: "nf",
  svc: "svc",
  service: "svc",
  services: "svc",
  proto: "proto",
  protocol: "proto",
  msg: "gtpmsg",
  message: "gtpmsg",
  ie: "gtpie",
  cause: "gtpcause",
  ext: "gtpext",
  exthdr: "gtpext",
};

/** Leading words, normalized, that name a GTP version: "gtpv2 32", "gtp-u 255", "GTPv2-C ie 87". */
const PROTOCOL_WORDS: Record<string, string> = {
  gtpv2: "proto/GTPv2-C",
  gtpv2c: "proto/GTPv2-C",
  gtpv1c: "proto/GTPv1-C",
  gtpu: "proto/GTP-U",
  gtpv1u: "proto/GTP-U",
};

/**
 * Ties between equal matches go to the kind people look up most. GTP kinds sit between the
 * Diameter ones so that equal matches keep the order they had before GTP entries existed.
 */
const KIND_ORDER: Record<EntityKind, number> = {
  cmd: 7,
  gtpmsg: 6.5,
  proto: 6,
  app: 5,
  if: 4,
  svc: 3,
  nf: 2,
  gtpie: 1.5,
  avp: 1,
  gtpcause: 0.5,
  gtpext: 0.25,
};

interface ParsedQuery {
  normalized: string;
  /** The whole query normalized, hint words included, so "GTP-U Peer Address" still matches its own name. */
  whole: string;
  words: string[];
  phrase: string;
  kindHint: EntityKind | null;
  /** A protocol id the query's leading word names. */
  protocolHint: string | null;
}

/** Reads up to two leading hint words, a GTP version then a kind ("gtpv2 ie 87"), when words follow them. */
export function parseQuery(query: string): ParsedQuery {
  const whole = normalize(query);
  let words = query.trim().split(/\s+/).filter(Boolean);
  let protocolHint: string | null = null;
  const firstWord = normalize(words[0] ?? "");
  if (words.length > 1 && Object.hasOwn(PROTOCOL_WORDS, firstWord)) {
    protocolHint = PROTOCOL_WORDS[firstWord] ?? null;
    words = words.slice(1);
  }
  let kindHint: EntityKind | null = null;
  const first = words[0]?.toLowerCase();
  if (words.length > 1 && first !== undefined && first in KIND_WORDS) {
    kindHint = KIND_WORDS[first] ?? null;
    words = words.slice(1);
  }
  const phrase = words.join(" ").toLowerCase();
  return {
    normalized: normalize(phrase),
    whole,
    words: words.map(normalize).filter(Boolean),
    phrase,
    kindHint,
    protocolHint,
  };
}

function keyScore(query: ParsedQuery, keys: readonly string[]): { score: number; match: MatchKind } | null {
  const q = query.normalized;
  let best: { score: number; match: MatchKind } | null = null;
  const offer = (score: number, match: MatchKind) => {
    if (best === null || score > best.score) best = { score, match };
  };
  keys.forEach((key, index) => {
    if (key === query.whole && query.whole !== q) {
      offer(1000 - index * 10, "exact");
    } else if (key === q) {
      // A code matches the same whatever its key position; names rank by key position.
      if (/^\d+$/.test(q)) offer(950, "code");
      else offer(1000 - index * 10, "exact");
    } else if (key.startsWith(q)) {
      offer(600 + (q.length / key.length) * 100 - index * 5, "prefix");
    } else if (q.length >= 3 && key.includes(q)) {
      offer(400 + (q.length / key.length) * 100 - index * 5, "substring");
    }
  });
  if (best === null && query.words.length > 1) {
    const joined = keys.join(" ");
    if (query.words.every((word) => joined.includes(word))) offer(250, "words");
  }
  return best;
}

function passes(entity: Entity, filters: SearchFilters): boolean {
  if (filters.kinds && filters.kinds.length > 0 && !filters.kinds.includes(entity.kind)) return false;
  if (filters.interface && !entityInterfaces(entity).includes(filters.interface)) return false;
  if (filters.protocol && !entityProtocols(entity).includes(filters.protocol)) return false;
  return true;
}

/**
 * Ranked matches for `query`: exact abbreviations, names, and codes first,
 * then prefixes, substrings, every query word among the keys, and finally
 * descriptions that contain the query. An empty query lists the filtered
 * entities by kind and title.
 */
export function search(dataset: Dataset, query: string, filters: SearchFilters = {}, limit = 50): SearchHit[] {
  const parsed = parseQuery(query);
  const hits: SearchHit[] = [];
  if (parsed.normalized === "") {
    for (const [id] of dataset.search) {
      const entity = dataset.byId.get(id);
      if (entity && passes(entity, filters)) hits.push({ id, entity, score: 0, match: "exact" });
    }
    return hits
      .sort((a, b) => KIND_ORDER[b.entity.kind] - KIND_ORDER[a.entity.kind] || entityTitle(a.entity).localeCompare(entityTitle(b.entity)))
      .slice(0, limit);
  }
  for (const [id, keys] of dataset.search) {
    const entity = dataset.byId.get(id);
    if (!entity || !passes(entity, filters)) continue;
    let scored = keyScore(parsed, keys);
    if (scored === null && parsed.phrase.length >= 3 && dataset.text.get(id)?.includes(parsed.phrase)) {
      scored = { score: 150, match: "description" };
    }
    if (scored === null) continue;
    let score = scored.score + KIND_ORDER[entity.kind];
    if (parsed.kindHint === entity.kind) score += 60;
    if (parsed.protocolHint !== null && entityProtocols(entity).includes(parsed.protocolHint)) score += 60;
    // Between equal matches, prefer entries this reference describes or gives formats for.
    if (entity.description) score += 3;
    if (entity.kind === "cmd" && entity.formats.length > 0) score += 3;
    hits.push({ id, entity, score, match: scored.match });
  }
  return hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}

/** Counts of each kind among all matches of `query`, ignoring the kind filter. */
export function kindCounts(dataset: Dataset, query: string, filters: SearchFilters = {}): Record<EntityKind, number> {
  const counts = Object.fromEntries(KINDS.map((kind) => [kind, 0])) as Record<EntityKind, number>;
  for (const hit of search(dataset, query, { ...filters, kinds: [] }, Number.POSITIVE_INFINITY)) {
    counts[hit.entity.kind] += 1;
  }
  return counts;
}

/** The entity for an id or for an exact unique key match ("ULR", "316", "S6a"), else null. */
export function resolve(dataset: Dataset, idOrKey: string): Entity | null {
  const direct = dataset.byId.get(idOrKey);
  if (direct) return direct;
  if (entityKind(idOrKey) !== null) return null;
  const [top, next] = search(dataset, idOrKey, {}, 2);
  if (!top || (top.match !== "exact" && top.match !== "code")) return null;
  if (next && next.score === top.score) return null;
  return top.entity;
}
