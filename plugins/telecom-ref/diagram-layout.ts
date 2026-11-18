import type { Diagram, DiagramEdge, DiagramNode, DiagramRegion, Point } from "./diagram-types";

export const NODE_W = 96;
export const NODE_H = 40;
export const NODE_FONT = 13;
export const LABEL_FONT = 12;
export const REGION_FONT = 11;
/** How far a loop reaches out of its box, and how wide it is. */
const LOOP_REACH = 22;
const LOOP_HALF = 14;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function nodeRect(node: DiagramNode): Rect {
  const w = node.w ?? NODE_W;
  const h = node.h ?? NODE_H * Math.max(1, node.nfs.length * 0.8);
  return { x: node.x - w / 2, y: node.y - h / 2, w, h };
}

/** The row of a combined node each network function occupies, top to bottom. */
export function rowRects(node: DiagramNode): Rect[] {
  const rect = nodeRect(node);
  const h = rect.h / node.nfs.length;
  return node.nfs.map((_, index) => ({ x: rect.x, y: rect.y + index * h, w: rect.w, h }));
}

/**
 * The approximate width of a label in the UI sans-serif at a font size. It
 * errs wide so the layout check flags a near miss rather than passes it.
 */
export function textWidth(text: string, size: number): number {
  let units = 0;
  for (const ch of text) units += /[A-Z0-9]/.test(ch) ? 0.66 : /[ il.'()\-/+]/.test(ch) ? 0.32 : 0.56;
  return units * size;
}

function center(rect: Rect): Point {
  return [rect.x + rect.w / 2, rect.y + rect.h / 2];
}

/** Where a line from inside the box toward `target` crosses its border. */
function exitPoint(rect: Rect, target: Point): Point {
  const [tx, ty] = target;
  const [cx, cy] = center(rect);
  if (tx >= rect.x && tx <= rect.x + rect.w) return [tx, ty < cy ? rect.y : rect.y + rect.h];
  if (ty >= rect.y && ty <= rect.y + rect.h) return [tx < cx ? rect.x : rect.x + rect.w, ty];
  const dx = tx - cx;
  const dy = ty - cy;
  const scale = Math.min(Math.abs(rect.w / 2 / dx), Math.abs(rect.h / 2 / dy));
  return [cx + dx * scale, cy + dy * scale];
}

/** A straight line between two boxes: vertical or horizontal where they overlap, else centre to centre. */
function straight(a: Rect, b: Rect): [Point, Point] {
  const left = Math.max(a.x, b.x);
  const right = Math.min(a.x + a.w, b.x + b.w);
  if (left < right) {
    const x = (left + right) / 2;
    return [exitPoint(a, [x, center(b)[1]]), exitPoint(b, [x, center(a)[1]])];
  }
  const top = Math.max(a.y, b.y);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  if (top < bottom) {
    const y = (top + bottom) / 2;
    return [exitPoint(a, [center(b)[0], y]), exitPoint(b, [center(a)[0], y])];
  }
  return [exitPoint(a, center(b)), exitPoint(b, center(a))];
}

function loopPoints(rect: Rect, side: NonNullable<DiagramEdge["loop"]>): Point[] {
  const [cx, cy] = center(rect);
  switch (side) {
    case "bottom": {
      const y = rect.y + rect.h;
      return [[cx - LOOP_HALF, y], [cx - LOOP_HALF, y + LOOP_REACH], [cx + LOOP_HALF, y + LOOP_REACH], [cx + LOOP_HALF, y]];
    }
    case "top":
      return [[cx - LOOP_HALF, rect.y], [cx - LOOP_HALF, rect.y - LOOP_REACH], [cx + LOOP_HALF, rect.y - LOOP_REACH], [cx + LOOP_HALF, rect.y]];
    case "left":
      return [[rect.x, cy - LOOP_HALF], [rect.x - LOOP_REACH, cy - LOOP_HALF], [rect.x - LOOP_REACH, cy + LOOP_HALF], [rect.x, cy + LOOP_HALF]];
    case "right": {
      const x = rect.x + rect.w;
      return [[x, cy - LOOP_HALF], [x + LOOP_REACH, cy - LOOP_HALF], [x + LOOP_REACH, cy + LOOP_HALF], [x, cy + LOOP_HALF]];
    }
  }
}

export interface DiagramIndex {
  nodes: ReadonlyMap<string, DiagramNode>;
  buses: ReadonlyMap<string, NonNullable<Diagram["buses"]>[number]>;
}

export function indexDiagram(diagram: Diagram): DiagramIndex {
  return {
    nodes: new Map(diagram.nodes.map((node) => [node.id, node])),
    buses: new Map((diagram.buses ?? []).map((bus) => [bus.id, bus])),
  };
}

/** The polyline an edge draws, from the border of `from` to the border of `to` (or the bus). */
export function edgePoints(edge: DiagramEdge, index: DiagramIndex): Point[] {
  const from = index.nodes.get(edge.from);
  if (!from) return [];
  const a = nodeRect(from);
  if (edge.loop) return loopPoints(a, edge.loop);
  const bus = index.buses.get(edge.to);
  if (bus) {
    const x = edge.x ?? from.x;
    return [exitPoint(a, [x, bus.y]), [x, bus.y]];
  }
  const to = index.nodes.get(edge.to);
  if (!to) return [];
  const b = nodeRect(to);
  const via = edge.via ?? [];
  if (via.length === 0) return straight(a, b);
  return [exitPoint(a, via[0]!), ...via, exitPoint(b, via[via.length - 1]!)];
}

function length(a: Point, b: Point): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

/** The point `at` (0 to 1) of the way along a polyline, by length. */
export function pointAlong(points: readonly Point[], at: number): Point {
  if (points.length === 0) return [0, 0];
  const total = points.slice(1).reduce((sum, point, index) => sum + length(points[index]!, point), 0);
  let remaining = total * at;
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1]!;
    const b = points[index]!;
    const segment = length(a, b);
    if (remaining <= segment || index === points.length - 1) {
      const t = segment === 0 ? 0 : Math.min(1, remaining / segment);
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    remaining -= segment;
  }
  return points[points.length - 1]!;
}

/** Where an edge's label is centred. A loop's label sits on its far side. */
export function labelPoint(edge: DiagramEdge, points: readonly Point[]): Point {
  const [x, y] = pointAlong(points, edge.at ?? 0.5);
  const outward: Record<NonNullable<DiagramEdge["loop"]>, Point> = { bottom: [0, 10], top: [0, -10], left: [-16, 0], right: [16, 0] };
  const [dx, dy] = edge.labelOffset ?? (edge.loop ? outward[edge.loop] : [0, 0]);
  return [x + dx, y + dy];
}

export function labelRect(text: string, [x, y]: Point, size = LABEL_FONT): Rect {
  const w = textWidth(text, size) + 6;
  const h = size + 4;
  return { x: x - w / 2, y: y - h / 2, w, h };
}

export function regionLabelRect(region: DiagramRegion): Rect {
  const w = textWidth(region.label, REGION_FONT) + 4;
  const h = REGION_FONT + 4;
  const corner = region.labelAt ?? "top-left";
  const x = corner.endsWith("left") ? region.x + 8 : region.x + region.w - 8 - w;
  const y = corner.startsWith("top") ? region.y + 5 : region.y + region.h - 5 - h;
  return { x, y, w, h };
}

export function overlaps(a: Rect, b: Rect, margin = 0): boolean {
  return a.x < b.x + b.w + margin && b.x < a.x + a.w + margin && a.y < b.y + b.h + margin && b.y < a.y + a.h + margin;
}

/** Whether the segment a-b passes through the rectangle (Liang-Barsky clipping). */
export function segmentHitsRect(a: Point, b: Point, rect: Rect): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const checks: Array<[number, number]> = [
    [-dx, a[0] - rect.x],
    [dx, rect.x + rect.w - a[0]],
    [-dy, a[1] - rect.y],
    [dy, rect.y + rect.h - a[1]],
  ];
  for (const [p, q] of checks) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}

function shrink(rect: Rect, by: number): Rect {
  return { x: rect.x + by, y: rect.y + by, w: rect.w - 2 * by, h: rect.h - 2 * by };
}

/** One edge as drawn: its polyline, label text, and label box. */
export interface EdgeGeometry {
  edge: DiagramEdge;
  points: Point[];
  label: string;
  labelAt: Point;
  labelBox: Rect;
}

export function edgeGeometry(diagram: Diagram, labelOf: (edge: DiagramEdge) => string): EdgeGeometry[] {
  const index = indexDiagram(diagram);
  return diagram.edges.map((edge) => {
    const points = edgePoints(edge, index);
    const label = labelOf(edge);
    const labelAt = labelPoint(edge, points);
    return { edge, points, label, labelAt, labelBox: labelRect(label, labelAt) };
  });
}

/**
 * Layout problems a reader would trip over: boxes that overlap or leave the
 * canvas, names that do not fit their box, lines that run through a box they
 * do not end at, and labels that cover a box, another label, or another line.
 */
export function lintLayout(diagram: Diagram, labelOf: (edge: DiagramEdge) => string, nodeLabel: (node: DiagramNode, row: number) => string): string[] {
  const issues: string[] = [];
  const geometry = edgeGeometry(diagram, labelOf);
  const rects = diagram.nodes.map((node) => ({ node, rect: nodeRect(node) }));
  const where = (edge: DiagramEdge) => `edge ${edge.if} ${edge.from}→${edge.to}`;

  rects.forEach(({ node, rect }, i) => {
    if (rect.x < 0 || rect.y < 0 || rect.x + rect.w > diagram.width || rect.y + rect.h > diagram.height) {
      issues.push(`node ${node.id} leaves the ${diagram.width}×${diagram.height} canvas`);
    }
    node.nfs.forEach((_, row) => {
      const text = nodeLabel(node, row);
      if (textWidth(text, NODE_FONT) > rect.w - 10) issues.push(`node ${node.id}: "${text}" does not fit in width ${rect.w}`);
    });
    for (const other of rects.slice(i + 1)) {
      if (overlaps(rect, other.rect, 6)) issues.push(`nodes ${node.id} and ${other.node.id} overlap`);
    }
  });

  for (const g of geometry) {
    const ends = new Set([g.edge.from, g.edge.to]);
    for (const { node, rect } of rects) {
      if (overlaps(g.labelBox, rect)) issues.push(`${where(g.edge)}: label "${g.label}" covers node ${node.id}`);
      if (ends.has(node.id)) continue;
      for (let s = 1; s < g.points.length; s++) {
        if (segmentHitsRect(g.points[s - 1]!, g.points[s]!, shrink(rect, 1))) {
          issues.push(`${where(g.edge)} runs through node ${node.id}`);
          break;
        }
      }
    }
    for (const other of geometry) {
      if (other === g) continue;
      if (geometry.indexOf(other) > geometry.indexOf(g) && overlaps(g.labelBox, other.labelBox, 2)) {
        issues.push(`labels "${g.label}" (${g.edge.from}→${g.edge.to}) and "${other.label}" (${other.edge.from}→${other.edge.to}) overlap`);
      }
      for (let s = 1; s < other.points.length; s++) {
        if (segmentHitsRect(other.points[s - 1]!, other.points[s]!, shrink(g.labelBox, 1))) {
          issues.push(`${where(g.edge)}: label "${g.label}" sits on the line of ${where(other.edge)}`);
          break;
        }
      }
    }
    for (const bus of diagram.buses ?? []) {
      if (g.edge.to === bus.id) continue;
      if (segmentHitsRect([bus.x1, bus.y], [bus.x2, bus.y], shrink(g.labelBox, 1))) {
        issues.push(`${where(g.edge)}: label "${g.label}" sits on bus ${bus.id}`);
      }
    }
    for (const region of diagram.regions ?? []) {
      if (overlaps(g.labelBox, regionLabelRect(region))) issues.push(`${where(g.edge)}: label "${g.label}" covers region label ${region.label}`);
    }
  }

  for (const bus of diagram.buses ?? []) {
    for (const { node, rect } of rects) {
      if (segmentHitsRect([bus.x1, bus.y], [bus.x2, bus.y], rect)) issues.push(`bus ${bus.id} runs through node ${node.id}`);
    }
  }
  for (const region of diagram.regions ?? []) {
    const label = regionLabelRect(region);
    for (const { node, rect } of rects) {
      if (overlaps(label, rect)) issues.push(`region label ${region.label} covers node ${node.id}`);
    }
    for (const g of geometry) {
      for (let s = 1; s < g.points.length; s++) {
        if (segmentHitsRect(g.points[s - 1]!, g.points[s]!, label)) {
          issues.push(`region label ${region.label} sits on the line of ${where(g.edge)}`);
          break;
        }
      }
    }
  }
  return issues;
}
