/**
 * The declarative format of an architecture diagram (diagrams/*.json).
 * Coordinates are in diagram units; the renderer scales them to the pane.
 */

export type Point = [x: number, y: number];

/** Control-plane lines are thin, user-plane lines thick; service-based attachments run to a bus. */
export type Plane = "control" | "user";

export interface DiagramNode {
  /** Unique within the diagram; the same network function may appear in several nodes. */
  id: string;
  /** Dataset ids ("nf/AMF"), one per row: ["nf/SMF", "nf/PGW-C"] draws a combined SMF + PGW-C. */
  nfs: string[];
  /** Display names, one per entry of nfs, where the figure prints another name: "V-PCRF", "E-UTRAN". */
  labels?: Array<string | null>;
  /** The centre of the box. */
  x: number;
  y: number;
  w?: number;
  h?: number;
  /** "network" draws a cut-corner octagon, as the figures draw data networks and access networks. */
  shape?: "box" | "network";
  /** A bus the box taps without a named interface, as the SCP sits on the SBI in TS 23.501 Figure 4.2.3-1. */
  tap?: string;
}

/** A horizontal service-based interface bus that NFs attach to. */
export interface DiagramBus {
  id: string;
  x1: number;
  x2: number;
  y: number;
}

export interface DiagramEdge {
  /** The dataset interface ("if/S11"). */
  if: string;
  /** Node ids; `to` may also name a bus. */
  from: string;
  to: string;
  plane?: Plane;
  /** The label when the figure prints another name than the interface: "S5-C", "Mr'". */
  label?: string;
  /** Waypoints between the two boxes, for orthogonal routes. */
  via?: Point[];
  /** Where along the line the label sits, 0 to 1 by length; 0.5 by default. */
  at?: number;
  /** Shifts the label off the line. */
  labelOffset?: Point;
  /** A loop out of one side of `from` back into it, for interfaces between two instances (S10, N9). */
  loop?: "top" | "bottom" | "left" | "right";
  /** For a bus attachment, the x where the line leaves the box; the box centre by default. */
  x?: number;
}

/** A labelled dashed area: a PLMN, an access network, the IMS. */
export interface DiagramRegion {
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Which corner the label sits in; top-left by default. */
  labelAt?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
}

/** A spec figure the diagram draws, with every interface the figure shows. */
export interface DiagramFigure {
  doc: string;
  clause: string;
  figure: string;
  title: string;
  /** The interfaces the figure labels, as dataset ids. Each must be drawn or listed in `omitted`. */
  shows: string[];
}

export interface Diagram {
  id: string;
  title: string;
  /** Diagrams in one group are views of the same architecture, switched with a toggle. */
  group: string;
  /** The toggle label within the group: "Service-based", "Reference points". */
  variant: string;
  summary: string;
  figures: DiagramFigure[];
  /** Interfaces a cited figure shows that this diagram leaves out, with the reason. */
  omitted?: Record<string, string>;
  width: number;
  height: number;
  regions?: DiagramRegion[];
  nodes: DiagramNode[];
  buses?: DiagramBus[];
  edges: DiagramEdge[];
  notes?: string[];
}
