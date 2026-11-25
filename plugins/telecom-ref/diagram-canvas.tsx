import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { Dataset } from "./dataset";
import { edgeLabel, nodeLabel, nodeTitle } from "./diagrams";
import { edgeGeometry, LABEL_FONT, NODE_FONT, nodeRect, REGION_FONT, regionLabelRect, rowRects, type EdgeGeometry, type Rect } from "./diagram-layout";
import type { Diagram, DiagramNode, Point } from "./diagram-types";

const PAD = 16;
const MAX_ZOOM = 6;
const ZOOM_STEP = 1.25;
/** Network shapes cut their corners by this much. */
const CUT = 10;

/**
 * Colours come from bb's theme tokens, so the diagram follows the active
 * palette in light and dark. Control-plane lines are dashed and thin,
 * user-plane lines solid and thick, as the 3GPP figures for IMS draw them.
 */
const STYLE = `
.trd { --trd-line: color-mix(in oklch, var(--foreground) 58%, var(--background)); --trd-box: color-mix(in oklch, var(--foreground) 4%, var(--background)); --trd-box-edge: color-mix(in oklch, var(--foreground) 38%, var(--background)); }
.trd text { font-family: inherit; }
.trd-region rect, .trd-region path { fill: none; stroke: color-mix(in oklch, var(--foreground) 30%, var(--background)); stroke-width: 1; stroke-dasharray: 6 4; }
.trd-region text { fill: var(--muted-foreground); font-size: ${REGION_FONT}px; font-weight: 500; letter-spacing: 0.02em; }
.trd-bus { stroke: var(--trd-box-edge); stroke-width: 5; stroke-linecap: round; }
.trd-line { fill: none; stroke: var(--trd-line); stroke-width: 1.25; stroke-dasharray: 5 3; stroke-linejoin: round; transition: opacity 120ms, stroke 120ms; }
.trd-line[data-plane="user"] { stroke: var(--foreground); stroke-width: 2.4; stroke-dasharray: none; }
.trd-line[data-bus] { stroke-dasharray: none; }
.trd-hit { fill: none; stroke: transparent; stroke-width: 12; pointer-events: stroke; }
.trd-label { fill: var(--foreground); font-size: ${LABEL_FONT}px; font-weight: 500; paint-order: stroke; stroke: var(--background); stroke-width: 4px; stroke-linejoin: round; }
.trd-box { fill: var(--trd-box); stroke: var(--trd-box-edge); stroke-width: 1.25; transition: fill 120ms, stroke 120ms; }
.trd-sep { stroke: var(--trd-box-edge); stroke-width: 1; }
.trd-name { fill: var(--foreground); font-size: ${NODE_FONT}px; font-weight: 600; pointer-events: none; }
.trd-ring { fill: none; stroke: none; stroke-width: 2; pointer-events: none; }
.trd-target { cursor: pointer; outline: none; }
.trd-target:focus-visible .trd-ring { stroke: var(--ring); }
.trd-dim { opacity: 0.22; }
.trd-lit .trd-box { stroke: var(--foreground); stroke-width: 1.75; }
.trd-lit .trd-line, .trd-lit.trd-line { stroke: var(--foreground); }
.trd-picked .trd-box { fill: color-mix(in oklch, var(--foreground) 12%, var(--background)); stroke: var(--foreground); stroke-width: 2.25; }
.trd-picked .trd-line { stroke-width: 3; }
`;

/** What the pointer or keyboard is on: a whole node, one row of it, or an edge by index. */
type Hover = { node: string } | { edge: number } | null;

interface Highlight {
  nodes: Set<string>;
  edges: Set<number>;
}

/** The node and edge an element lights up: itself and what it connects to. */
function highlightFor(diagram: Diagram, hover: Hover, picked: string | null): Highlight | null {
  const nodes = new Set<string>();
  const edges = new Set<number>();
  const lightNode = (id: string) => {
    nodes.add(id);
    diagram.edges.forEach((edge, index) => {
      if (edge.from === id || edge.to === id) {
        edges.add(index);
        nodes.add(edge.from);
        nodes.add(edge.to);
      }
    });
  };
  const lightEdge = (index: number) => {
    const edge = diagram.edges[index];
    if (!edge) return;
    edges.add(index);
    nodes.add(edge.from);
    nodes.add(edge.to);
  };
  if (hover && "node" in hover) lightNode(hover.node);
  else if (hover && "edge" in hover) lightEdge(hover.edge);
  else if (picked) {
    for (const node of diagram.nodes) if (node.nfs.includes(picked)) lightNode(node.id);
    diagram.edges.forEach((edge, index) => {
      if (edge.if === picked) lightEdge(index);
    });
  }
  return nodes.size > 0 ? { nodes, edges } : null;
}

function octagon(rect: Rect): string {
  const { x, y, w, h } = rect;
  const c = Math.min(CUT, h / 3);
  return `M${x + c},${y} H${x + w - c} L${x + w},${y + c} V${y + h - c} L${x + w - c},${y + h} H${x + c} L${x},${y + h - c} V${y + c} Z`;
}

function polyline(points: readonly Point[]): string {
  return points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
}

function activate(event: KeyboardEvent, run: () => void): void {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    run();
  }
}

interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

function fitBox(diagram: Diagram): ViewBox {
  return { x: -PAD, y: -PAD, w: diagram.width + 2 * PAD, h: diagram.height + 2 * PAD };
}

/** Keeps a zoomed view inside the diagram and no larger than the fitted view. */
function clampBox(box: ViewBox, fit: ViewBox): ViewBox {
  const w = Math.min(fit.w, Math.max(fit.w / MAX_ZOOM, box.w));
  const h = (box.h / box.w) * w;
  const x = Math.min(fit.x + fit.w - w, Math.max(fit.x, box.x));
  const y = Math.min(fit.y + fit.h - Math.min(h, fit.h), Math.max(fit.y, box.y));
  return { x, y, w, h: Math.min(h, fit.h) };
}

function zoomBox(box: ViewBox, factor: number, [cx, cy]: Point, fit: ViewBox): ViewBox {
  const w = box.w / factor;
  const h = box.h / factor;
  return clampBox({ x: cx - (cx - box.x) / factor, y: cy - (cy - box.y) / factor, w, h }, fit);
}

export interface DiagramCanvasProps {
  diagram: Diagram;
  dataset: Dataset;
  /** The entity the reader picked ("nf/AMF", "if/N11"); its boxes and lines stay lit. */
  picked: string | null;
  onPick: (id: string) => void;
  /** Accessible name for the whole figure. */
  label?: string;
}

function NodeShape({
  node,
  dataset,
  lit,
  dim,
  picked,
  onPick,
  onHover,
}: {
  node: DiagramNode;
  dataset: Dataset;
  lit: boolean;
  dim: boolean;
  picked: string | null;
  onPick: (id: string) => void;
  onHover: (hover: Hover) => void;
}) {
  const rect = nodeRect(node);
  const rows = rowRects(node);
  const shape =
    node.shape === "network" ? (
      <path className="trd-box" d={octagon(rect)} />
    ) : (
      <rect className="trd-box" x={rect.x} y={rect.y} width={rect.w} height={rect.h} rx={4} />
    );
  const classes = ["trd-node", lit ? "trd-lit" : "", dim ? "trd-dim" : "", node.nfs.some((nf) => nf === picked) ? "trd-picked" : ""];
  return (
    <g className={classes.join(" ")} data-node={node.id} onPointerEnter={() => onHover({ node: node.id })} onPointerLeave={() => onHover(null)}>
      {shape}
      {rows.slice(1).map((row) => (
        <line key={row.y} className="trd-sep" x1={row.x} x2={row.x + row.w} y1={row.y} y2={row.y} />
      ))}
      {node.nfs.map((nf, index) => {
        const row = rows[index]!;
        const name = nodeLabel(node, index, dataset);
        const entity = dataset.byId.get(nf);
        const full = entity?.kind === "nf" && entity.fullName ? `, ${entity.fullName}` : "";
        return (
          <g
            key={nf}
            className="trd-target"
            tabIndex={0}
            role="button"
            aria-label={`${name}${full}`}
            aria-pressed={picked === nf}
            data-entity={nf}
            onClick={() => onPick(nf)}
            onKeyDown={(event) => activate(event, () => onPick(nf))}
            onFocus={() => onHover({ node: node.id })}
            onBlur={() => onHover(null)}
          >
            <rect x={row.x} y={row.y} width={row.w} height={row.h} fill="transparent" />
            <text className="trd-name" x={row.x + row.w / 2} y={row.y + row.h / 2} textAnchor="middle" dominantBaseline="central">
              {name}
            </text>
            <rect className="trd-ring" x={row.x - 3} y={row.y - 3} width={row.w + 6} height={row.h + 6} rx={6} />
          </g>
        );
      })}
    </g>
  );
}

function EdgeShape({
  geometry,
  index,
  lit,
  dim,
  picked,
  ends,
  toBus,
  onPick,
  onHover,
}: {
  geometry: EdgeGeometry;
  index: number;
  lit: boolean;
  dim: boolean;
  picked: boolean;
  ends: string;
  toBus: boolean;
  onPick: (id: string) => void;
  onHover: (hover: Hover) => void;
}) {
  const { edge, points, label, labelAt, labelBox } = geometry;
  const d = polyline(points);
  const classes = ["trd-target", lit ? "trd-lit" : "", dim ? "trd-dim" : "", picked ? "trd-picked" : ""];
  return (
    <g
      className={classes.join(" ")}
      tabIndex={0}
      role="button"
      aria-label={`${label} interface, ${ends}`}
      aria-pressed={picked}
      data-entity={edge.if}
      onClick={() => onPick(edge.if)}
      onKeyDown={(event) => activate(event, () => onPick(edge.if))}
      onPointerEnter={() => onHover({ edge: index })}
      onPointerLeave={() => onHover(null)}
      onFocus={() => onHover({ edge: index })}
      onBlur={() => onHover(null)}
    >
      <path className="trd-line" d={d} data-plane={edge.plane ?? "control"} data-bus={toBus || undefined} />
      <path className="trd-hit" d={d} />
      <text className="trd-label" x={labelAt[0]} y={labelAt[1]} textAnchor="middle" dominantBaseline="central">
        {label}
      </text>
      <rect className="trd-ring" x={labelBox.x - 2} y={labelBox.y - 2} width={labelBox.w + 4} height={labelBox.h + 4} rx={4} />
    </g>
  );
}

/**
 * One architecture diagram as SVG. Boxes and interface lines are buttons
 * that pick their dataset entity; hovering or focusing one lights it and
 * everything it connects to. Ctrl or Cmd with the wheel (or a pinch) zooms,
 * the wheel or a drag pans once zoomed, and + - 0 work from the keyboard.
 */
export function DiagramCanvas({ diagram, dataset, picked, onPick, label }: DiagramCanvasProps) {
  const fit = useMemo(() => fitBox(diagram), [diagram]);
  const [box, setBox] = useState<ViewBox>(fit);
  const [hover, setHover] = useState<Hover>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; box: ViewBox } | null>(null);

  useEffect(() => setBox(fit), [fit]);

  const index = useMemo(() => new Map(diagram.nodes.map((node) => [node.id, node])), [diagram]);
  const geometry = useMemo(() => edgeGeometry(diagram, (edge) => edgeLabel(edge, dataset)), [diagram, dataset]);
  const highlight = highlightFor(diagram, hover, picked);
  const busIds = new Set((diagram.buses ?? []).map((bus) => bus.id));
  const pickedEdges = new Set(diagram.edges.flatMap((edge, i) => (edge.if === picked ? [i] : [])));

  /** Diagram units per screen pixel; the SVG keeps its aspect ratio, so one scale covers both axes. */
  const unitsPerPixel = (): number => {
    const svg = svgRef.current;
    if (!svg || svg.clientWidth === 0) return 1;
    return Math.max(box.w / svg.clientWidth, box.h / svg.clientHeight);
  };
  const toDiagram = (clientX: number, clientY: number): Point => {
    const svg = svgRef.current;
    const matrix = svg?.getScreenCTM?.();
    if (!svg || !matrix) return [box.x + box.w / 2, box.y + box.h / 2];
    const point = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
    return [point.x, point.y];
  };

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const at = toDiagram(event.clientX, event.clientY);
        setBox((current) => zoomBox(current, Math.exp(-event.deltaY * 0.01), at, fit));
      } else if (box.w < fit.w - 0.5) {
        event.preventDefault();
        const scale = unitsPerPixel();
        setBox((current) => clampBox({ ...current, x: current.x + event.deltaX * scale, y: current.y + event.deltaY * scale }, fit));
      }
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  });

  const zoomed = box.w < fit.w - 0.5;
  const zoomBy = (factor: number) => setBox((current) => zoomBox(current, factor, [current.x + current.w / 2, current.y + current.h / 2], fit));

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!zoomed || (event.target as Element).closest(".trd-target")) return;
    drag.current = { x: event.clientX, y: event.clientY, box };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const start = drag.current;
    if (!start) return;
    const scale = unitsPerPixel();
    setBox(clampBox({ ...start.box, x: start.box.x - (event.clientX - start.x) * scale, y: start.box.y - (event.clientY - start.y) * scale }, fit));
  };
  const onPointerUp = () => {
    drag.current = null;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget && !(event.target as Element).closest?.(".trd")) return;
    if (event.key === "+" || event.key === "=") zoomBy(ZOOM_STEP);
    else if (event.key === "-") zoomBy(1 / ZOOM_STEP);
    else if (event.key === "0") setBox(fit);
    else return;
    event.preventDefault();
  };

  const ends = (from: string, to: string, loop: boolean) => {
    const a = index.get(from);
    const b = index.get(to);
    const title = (node: DiagramNode | undefined) => (node ? nodeTitle(node, dataset) : "the service bus");
    return loop ? `${title(a)} to another ${title(a)}` : `${title(a)} to ${title(b)}`;
  };

  const controlClass =
    "flex size-7 items-center justify-center rounded-md text-sm text-muted-foreground transition-colors duration-150 hover:bg-foreground/[0.07] hover:text-foreground";
  return (
    <div className="relative h-full min-h-0 w-full" onKeyDown={onKeyDown}>
      <svg
        ref={svgRef}
        className={`trd h-full w-full select-none ${zoomed ? "cursor-grab active:cursor-grabbing" : ""}`}
        viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
        preserveAspectRatio="xMidYMid meet"
        role="group"
        aria-label={label ?? diagram.title}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <style>{STYLE}</style>
        {(diagram.regions ?? []).map((region) => {
          const text = regionLabelRect(region);
          return (
            <g key={region.label} className="trd-region">
              <rect x={region.x} y={region.y} width={region.w} height={region.h} rx={10} />
              <text x={text.x + 2} y={text.y + text.h / 2} dominantBaseline="central">
                {region.label}
              </text>
            </g>
          );
        })}
        {(diagram.buses ?? []).map((bus) => (
          <line key={bus.id} className={`trd-bus ${highlight ? "trd-dim" : ""}`} x1={bus.x1} x2={bus.x2} y1={bus.y} y2={bus.y} />
        ))}
        {diagram.nodes.flatMap((node) => {
          const bus = diagram.buses?.find((candidate) => candidate.id === node.tap);
          if (!bus) return [];
          const rect = nodeRect(node);
          const y = bus.y < rect.y ? rect.y : rect.y + rect.h;
          return [<line key={`tap-${node.id}`} className={`trd-line ${highlight && !highlight.nodes.has(node.id) ? "trd-dim" : ""}`} data-bus="" x1={node.x} x2={node.x} y1={y} y2={bus.y} />];
        })}
        {geometry.map((g, i) => (
          <EdgeShape
            key={`${g.edge.if}-${g.edge.from}-${g.edge.to}-${i}`}
            geometry={g}
            index={i}
            lit={highlight?.edges.has(i) ?? false}
            dim={highlight !== null && !highlight.edges.has(i)}
            picked={pickedEdges.has(i)}
            ends={ends(g.edge.from, g.edge.to, g.edge.loop !== undefined)}
            toBus={busIds.has(g.edge.to)}
            onPick={onPick}
            onHover={setHover}
          />
        ))}
        {diagram.nodes.map((node) => (
          <NodeShape
            key={node.id}
            node={node}
            dataset={dataset}
            lit={highlight?.nodes.has(node.id) ?? false}
            dim={highlight !== null && !highlight.nodes.has(node.id)}
            picked={picked}
            onPick={onPick}
            onHover={setHover}
          />
        ))}
      </svg>
      <div className="absolute right-3 bottom-3 flex items-center gap-0.5 rounded-lg border border-border bg-background/90 p-0.5 shadow-xs" data-render-hidden="">
        <button type="button" aria-label="Zoom out" title="Zoom out (−)" className={controlClass} onClick={() => zoomBy(1 / ZOOM_STEP)} disabled={!zoomed}>
          −
        </button>
        <button type="button" aria-label="Fit to pane" title="Fit (0)" className={`${controlClass} w-auto px-2 text-xs`} onClick={() => setBox(fit)}>
          Fit
        </button>
        <button type="button" aria-label="Zoom in" title="Zoom in (+)" className={controlClass} onClick={() => zoomBy(ZOOM_STEP)}>
          +
        </button>
      </div>
    </div>
  );
}
