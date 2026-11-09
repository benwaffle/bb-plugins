import { allEntities, entityKind } from "./dataset";
import { normalize } from "./search";
import type { Entity, EntityKind, RawDataset, SpecRef } from "./types";

export interface ValidationIssue {
  id: string;
  field: string;
  message: string;
}

const ID_PATTERNS: Record<EntityKind, RegExp> = {
  app: /^diam\.app\/\d+$/,
  cmd: /^diam\.cmd\/\d+$/,
  avp: /^diam\.avp\/\d+\/\d+$/,
  if: /^if\/[A-Za-z0-9_-]+$/,
  nf: /^nf\/[A-Za-z0-9_-]+$/,
  svc: /^svc\/N[a-z0-9]+(-[a-z]+)?_[A-Za-z0-9_-]+$/,
  proto: /^proto\/[A-Za-z0-9'_-]+$/,
};

const SPEC_DOC = /^(TS \d{2}\.\d{3}|RFC \d{3,5})$/;

/**
 * Every problem that would break a cross-link or a lookup: duplicate or
 * malformed ids, links to missing entities or entities of the wrong kind,
 * reverse links that disagree with their forward links, malformed spec
 * references, and a search index that misses or duplicates an entity.
 */
export function validateDataset(raw: RawDataset): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const byId = new Map<string, Entity>();
  const all: Entity[] = allEntities(raw);

  for (const entity of all) {
    if (byId.has(entity.id)) issues.push({ id: entity.id, field: "id", message: "duplicate id" });
    byId.set(entity.id, entity);
    if (entityKind(entity.id) !== entity.kind || !ID_PATTERNS[entity.kind].test(entity.id)) {
      issues.push({ id: entity.id, field: "id", message: `malformed id for kind ${entity.kind}` });
    }
  }

  const link = (from: Entity, field: string, target: string | null, kind: EntityKind) => {
    if (target === null) return;
    const found = byId.get(target);
    if (!found) issues.push({ id: from.id, field, message: `dangling link to ${target}` });
    else if (found.kind !== kind) issues.push({ id: from.id, field, message: `${target} is a ${found.kind}, expected ${kind}` });
  };
  const links = (from: Entity, field: string, targets: readonly string[], kind: EntityKind) => {
    for (const target of targets) link(from, field, target, kind);
  };
  const specs = (from: Entity, field: string, refs: readonly SpecRef[]) => {
    for (const ref of refs) {
      if (!SPEC_DOC.test(ref.doc)) issues.push({ id: from.id, field, message: `malformed spec doc "${ref.doc}"` });
    }
  };

  for (const entity of all) {
    specs(entity, "spec", entity.spec);
    switch (entity.kind) {
      case "app":
        links(entity, "commands", entity.commands, "cmd");
        links(entity, "interfaces", entity.interfaces, "if");
        break;
      case "cmd":
        links(entity, "apps", entity.apps, "app");
        links(entity, "interfaces", entity.interfaces, "if");
        if (entity.flow) {
          links(entity, "flow.request.from", entity.flow.request.from, "nf");
          links(entity, "flow.request.to", entity.flow.request.to, "nf");
        }
        entity.formats.forEach((format, index) => {
          link(entity, `formats[${index}].app`, format.app, "app");
          specs(entity, `formats[${index}].spec`, [format.spec]);
          for (const ref of format.avps) link(entity, `formats[${index}].avps`, ref.avp, "avp");
        });
        break;
      case "avp":
        for (const child of entity.children) link(entity, "children", child.avp, "avp");
        links(entity, "parents", entity.parents, "avp");
        links(entity, "carriedIn", entity.carriedIn, "cmd");
        links(entity, "apps", entity.apps, "app");
        links(entity, "interfaces", entity.interfaces, "if");
        break;
      case "if":
        links(entity, "endpoints", entity.endpoints, "nf");
        links(entity, "apps", entity.apps, "app");
        links(entity, "protocols", entity.protocols, "proto");
        links(entity, "services", entity.services, "svc");
        break;
      case "nf":
        links(entity, "replaces", entity.replaces, "nf");
        links(entity, "replacedBy", entity.replacedBy, "nf");
        links(entity, "interfaces", entity.interfaces, "if");
        links(entity, "services", entity.services, "svc");
        break;
      case "svc":
        link(entity, "producer", entity.producer, "nf");
        links(entity, "consumers", entity.consumers, "nf");
        entity.operations.forEach((operation, index) => links(entity, `operations[${index}].consumers`, operation.consumers, "nf"));
        links(entity, "interfaces", entity.interfaces, "if");
        break;
      case "proto":
        links(entity, "over", entity.over, "proto");
        links(entity, "carries", entity.carries, "proto");
        links(entity, "interfaces", entity.interfaces, "if");
        break;
    }
  }

  // Reverse links must mirror their forward links.
  for (const avp of raw.avps) {
    for (const parentId of avp.parents) {
      const parent = byId.get(parentId);
      if (parent?.kind === "avp" && !parent.children.some((c) => c.avp === avp.id)) {
        issues.push({ id: avp.id, field: "parents", message: `${parentId} does not list it as a child` });
      }
    }
    for (const commandId of avp.carriedIn) {
      const command = byId.get(commandId);
      if (command?.kind === "cmd" && !command.formats.some((f) => f.avps.some((r) => r.avp === avp.id))) {
        issues.push({ id: avp.id, field: "carriedIn", message: `${commandId} does not carry it` });
      }
    }
  }
  for (const nf of raw.nfs) {
    for (const interfaceId of nf.interfaces) {
      const item = byId.get(interfaceId);
      if (item?.kind === "if" && !item.endpoints.includes(nf.id)) {
        issues.push({ id: nf.id, field: "interfaces", message: `${interfaceId} does not end at it` });
      }
    }
  }

  for (const item of raw.interfaces) {
    for (const protocolId of item.protocols) {
      const protocol = byId.get(protocolId);
      if (protocol?.kind === "proto" && !protocol.interfaces.includes(item.id)) {
        issues.push({ id: item.id, field: "protocols", message: `${protocolId} does not list it` });
      }
    }
    for (const serviceId of item.services) {
      const service = byId.get(serviceId);
      if (service?.kind === "svc" && !service.interfaces.includes(item.id)) {
        issues.push({ id: item.id, field: "services", message: `${serviceId} does not list it` });
      }
    }
  }
  for (const protocol of raw.protocols) {
    for (const interfaceId of protocol.interfaces) {
      const item = byId.get(interfaceId);
      if (item?.kind === "if" && !item.protocols.includes(protocol.id)) {
        issues.push({ id: protocol.id, field: "interfaces", message: `${interfaceId} does not list it` });
      }
    }
    for (const lowerId of protocol.over) {
      const lower = byId.get(lowerId);
      if (lower?.kind === "proto" && !lower.carries.includes(protocol.id)) {
        issues.push({ id: protocol.id, field: "over", message: `${lowerId} does not list it as carried` });
      }
    }
  }
  for (const nf of raw.nfs) {
    for (const serviceId of nf.services) {
      const service = byId.get(serviceId);
      if (service?.kind === "svc" && service.producer !== nf.id) {
        issues.push({ id: nf.id, field: "services", message: `${serviceId} has another producer` });
      }
    }
  }
  for (const service of raw.services) {
    const producer = byId.get(service.producer);
    if (producer?.kind === "nf" && !producer.services.includes(service.id)) {
      issues.push({ id: service.id, field: "producer", message: `${service.producer} does not list it` });
    }
    for (const interfaceId of service.interfaces) {
      const item = byId.get(interfaceId);
      if (item?.kind === "if" && !item.services.includes(service.id)) {
        issues.push({ id: service.id, field: "interfaces", message: `${interfaceId} does not list it` });
      }
    }
  }

  // The prebuilt index must hold every entity once, with normalized keys.
  const indexed = new Set<string>();
  for (const [id, keys] of raw.search) {
    if (indexed.has(id)) issues.push({ id, field: "search", message: "indexed twice" });
    indexed.add(id);
    if (!byId.has(id)) issues.push({ id, field: "search", message: "indexes a missing entity" });
    if (keys.length === 0) issues.push({ id, field: "search", message: "has no keys" });
    for (const key of keys) {
      if (normalize(key) !== key) issues.push({ id, field: "search", message: `key "${key}" is not normalized` });
    }
  }
  for (const id of byId.keys()) {
    if (!indexed.has(id)) issues.push({ id, field: "search", message: "missing from the search index" });
  }
  return issues;
}
