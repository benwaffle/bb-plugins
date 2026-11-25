import epc from "./diagrams/epc.json";
import epcCups from "./diagrams/epc-cups.json";
import epcRoamingHr from "./diagrams/epc-roaming-hr.json";
import epcRoamingLbo from "./diagrams/epc-roaming-lbo.json";
import fivegcRp from "./diagrams/5gc-rp.json";
import fivegcSba from "./diagrams/5gc-sba.json";
import fivegcRoamingHr from "./diagrams/5gc-roaming-hr.json";
import fivegcRoamingLbo from "./diagrams/5gc-roaming-lbo.json";
import ims from "./diagrams/ims.json";
import interworking from "./diagrams/interworking.json";
import { entityShortName, type Dataset } from "./dataset";
import { PANEL_PATH } from "./format";
import type { Diagram, DiagramEdge, DiagramNode } from "./diagram-types";
import type { Entity, InterfaceEntity } from "./types";

/** Every diagram, in the order the picker lists them; the first of a group is its default view. */
export const DIAGRAMS: readonly Diagram[] = [
  epcCups,
  epc,
  fivegcSba,
  fivegcRp,
  interworking,
  ims,
  epcRoamingHr,
  epcRoamingLbo,
  fivegcRoamingHr,
  fivegcRoamingLbo,
] as Diagram[];

export function diagramById(id: string): Diagram | undefined {
  return DIAGRAMS.find((diagram) => diagram.id === id);
}

/** The diagrams of a group, for the view toggle. */
export function groupOf(diagram: Diagram): Diagram[] {
  return DIAGRAMS.filter((other) => other.group === diagram.group);
}

/** The first diagram of each group, for the picker. */
export function groupLeaders(): Diagram[] {
  const seen = new Set<string>();
  return DIAGRAMS.filter((diagram) => !seen.has(diagram.group) && seen.add(diagram.group));
}

/** Whether a diagram draws the entity: a network function in a box or an interface on a line. */
export function diagramShows(diagram: Diagram, id: string): boolean {
  return diagram.nodes.some((node) => node.nfs.includes(id)) || diagram.edges.some((edge) => edge.if === id);
}

export function diagramsShowing(id: string): Diagram[] {
  return DIAGRAMS.filter((diagram) => diagramShows(diagram, id));
}

export function diagramSubPath(id: string, focus?: string | null): string {
  return focus ? `diagram/${id}/${focus}` : `diagram/${id}`;
}

export function diagramPath(pluginId: string, id: string, focus?: string | null): string {
  return `/plugins/${pluginId}/${PANEL_PATH}/${diagramSubPath(id, focus)}`;
}

/** The name a node row shows: the figure's label, else the network function's name. */
export function nodeLabel(node: DiagramNode, row: number, dataset: Dataset): string {
  const label = node.labels?.[row];
  if (label) return label;
  const id = node.nfs[row] ?? "";
  const entity = dataset.byId.get(id);
  return entity ? entityShortName(entity) : id;
}

export function nodeTitle(node: DiagramNode, dataset: Dataset): string {
  return node.nfs.map((_, row) => nodeLabel(node, row, dataset)).join(" + ");
}

export function edgeLabel(edge: DiagramEdge, dataset: Dataset): string {
  if (edge.label) return edge.label;
  const entity = dataset.byId.get(edge.if);
  return entity ? entity.name : edge.if;
}

/** Where an edge ends: a node's title, or "SBI" for a bus. */
export function endTitle(diagram: Diagram, id: string, dataset: Dataset): string {
  const node = diagram.nodes.find((candidate) => candidate.id === id);
  return node ? nodeTitle(node, dataset) : "SBI";
}

export interface DiagramIssue {
  diagram: string;
  message: string;
}

function asInterface(entity: Entity | undefined): InterfaceEntity | null {
  return entity?.kind === "if" ? entity : null;
}

/** Whether `a` and `b` can be the two ends of `item`: both are endpoints, and a self-link has the NF twice. */
function endsMatch(item: InterfaceEntity, a: string, b: string): boolean {
  if (!item.endpoints.includes(a) || !item.endpoints.includes(b)) return false;
  return a !== b || item.endpoints.filter((endpoint) => endpoint === a).length > 1;
}

/**
 * Every way a diagram can disagree with the dataset or the figures it cites:
 * an id the dataset lacks, an edge whose ends are not endpoints the dataset
 * records for its interface, a label that names another interface, and an
 * interface a cited figure shows that the diagram neither draws nor explains.
 */
export function validateDiagrams(diagrams: readonly Diagram[], dataset: Dataset): DiagramIssue[] {
  const issues: DiagramIssue[] = [];
  const ids = new Set<string>();
  const views = new Set<string>();
  for (const diagram of diagrams) {
    const issue = (message: string) => issues.push({ diagram: diagram.id, message });
    if (ids.has(diagram.id)) issue("duplicate diagram id");
    ids.add(diagram.id);
    if (!/^[a-z0-9-]+$/.test(diagram.id)) issue("diagram ids are lowercase letters, digits, and dashes");
    const view = `${diagram.group}/${diagram.variant}`;
    if (views.has(view)) issue(`two diagrams are view ${view}`);
    views.add(view);

    const nodes = new Map<string, DiagramNode>();
    for (const node of diagram.nodes) {
      if (nodes.has(node.id)) issue(`duplicate node id ${node.id}`);
      nodes.set(node.id, node);
      if (node.nfs.length === 0) issue(`node ${node.id} names no network function`);
      if (node.labels && node.labels.length > node.nfs.length) issue(`node ${node.id} has more labels than network functions`);
      for (const nf of node.nfs) {
        const entity = dataset.byId.get(nf);
        if (!entity) issue(`node ${node.id}: ${nf} is not in the dataset`);
        else if (entity.kind !== "nf") issue(`node ${node.id}: ${nf} is a ${entity.kind}, not a network function`);
      }
    }
    const buses = new Set((diagram.buses ?? []).map((bus) => bus.id));
    for (const bus of buses) if (nodes.has(bus)) issue(`bus ${bus} shares an id with a node`);
    for (const node of diagram.nodes) if (node.tap && !buses.has(node.tap)) issue(`node ${node.id} taps unknown bus ${node.tap}`);

    const drawn = new Set<string>();
    const seen = new Set<string>();
    for (const edge of diagram.edges) {
      const where = `edge ${edge.if} ${edge.from}→${edge.to}`;
      const item = asInterface(dataset.byId.get(edge.if));
      if (!item) {
        issue(`${where}: ${edge.if} is not an interface in the dataset`);
        continue;
      }
      drawn.add(edge.if);
      const key = `${edge.if}|${[edge.from, edge.to].sort().join("|")}|${edge.label ?? ""}`;
      if (seen.has(key)) issue(`${where} is drawn twice`);
      seen.add(key);
      const label = edgeLabel(edge, dataset);
      if (![item.name, ...item.aliases].some((name) => label.startsWith(name))) {
        issue(`${where}: label "${label}" does not name ${item.name}`);
      }
      const from = nodes.get(edge.from);
      if (!from) {
        issue(`${where}: no node ${edge.from}`);
        continue;
      }
      if (buses.has(edge.to)) {
        if (item.endpoints.length !== 1) issue(`${where}: only a service-based interface attaches to a bus`);
        if (!from.nfs.some((nf) => item.endpoints.includes(nf))) {
          issue(`${where}: ${from.nfs.join("+")} does not exhibit ${item.name} (exhibited by ${item.endpoints.join(", ")})`);
        }
        continue;
      }
      const to = nodes.get(edge.to);
      if (!to) {
        issue(`${where}: no node or bus ${edge.to}`);
        continue;
      }
      if (edge.loop && edge.from !== edge.to) issue(`${where}: a loop starts and ends at the same node`);
      if (!edge.loop && edge.from === edge.to) issue(`${where}: an edge from a node to itself needs a loop side`);
      const match = from.nfs.some((a) => to.nfs.some((b) => endsMatch(item, a, b)));
      if (!match) {
        issue(`${where}: ${from.nfs.join("+")} to ${to.nfs.join("+")} does not match the endpoints of ${item.name} (${item.endpoints.join(", ")})`);
      }
    }

    const shown = new Set<string>();
    for (const figure of diagram.figures) {
      for (const id of figure.shows) {
        shown.add(id);
        if (!asInterface(dataset.byId.get(id))) issue(`Figure ${figure.figure} lists ${id}, which is not an interface in the dataset`);
        else if (!drawn.has(id) && !diagram.omitted?.[id]) issue(`Figure ${figure.figure} shows ${id}, which the diagram neither draws nor lists as omitted`);
      }
    }
    for (const id of Object.keys(diagram.omitted ?? {})) {
      if (!shown.has(id)) issue(`omitted ${id} is not shown by any cited figure`);
      if (drawn.has(id)) issue(`omitted ${id} is drawn after all`);
    }
  }
  return issues;
}

/** A diagram as text an agent can read: its sources, boxes, and each interface with its two ends. */
export function diagramText(diagram: Diagram, dataset: Dataset, pluginId: string): string {
  const lines = [`## ${diagram.title} · ${diagram.variant}`, diagram.summary, ""];
  for (const figure of diagram.figures) lines.push(`Source: ${figure.doc} §${figure.clause}, Figure ${figure.figure}: ${figure.title}`);
  lines.push("", "Nodes:");
  for (const node of diagram.nodes) lines.push(`- ${nodeTitle(node, dataset)} (${node.nfs.join(" + ")})`);
  lines.push("", "Interfaces:");
  for (const edge of diagram.edges) {
    const item = asInterface(dataset.byId.get(edge.if));
    const plane = edge.plane === "user" ? "user plane" : "control plane";
    const facts = [edge.if, item?.protocol, plane].filter(Boolean).join(", ");
    const to = edge.loop ? `${endTitle(diagram, edge.from, dataset)} (another instance)` : endTitle(diagram, edge.to, dataset);
    lines.push(`- ${edgeLabel(edge, dataset)} (${facts}): ${endTitle(diagram, edge.from, dataset)} — ${to}`);
  }
  const omitted = Object.entries(diagram.omitted ?? {});
  if (omitted.length > 0) {
    lines.push("", "Shown in the cited figures but not drawn:");
    for (const [id, reason] of omitted) lines.push(`- ${id}: ${reason}`);
  }
  for (const note of diagram.notes ?? []) lines.push("", `Note: ${note}`);
  lines.push("", `Page: ${diagramPath(pluginId, diagram.id)}`);
  return lines.join("\n");
}
