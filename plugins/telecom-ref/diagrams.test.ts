import { describe, expect, it } from "vitest";
import { bundledDataset } from "./dataset";
import { lintLayout } from "./diagram-layout";
import type { Diagram } from "./diagram-types";
import { DIAGRAMS, diagramsShowing, diagramText, edgeLabel, nodeLabel, validateDiagrams } from "./diagrams";

const dataset = bundledDataset();

/** A small valid diagram the failure cases below each break in one way. */
function sample(): Diagram {
  return {
    id: "sample",
    title: "Sample",
    group: "sample",
    variant: "Test",
    summary: "",
    figures: [{ doc: "TS 23.401", clause: "4.2.1", figure: "4.2.1-1", title: "", shows: ["if/S11"] }],
    width: 400,
    height: 200,
    nodes: [
      { id: "mme", nfs: ["nf/MME"], x: 80, y: 100 },
      { id: "sgw", nfs: ["nf/SGW"], x: 320, y: 100 },
    ],
    edges: [{ if: "if/S11", from: "mme", to: "sgw" }],
  };
}

function messages(diagram: Diagram): string[] {
  return validateDiagrams([diagram], dataset).map((issue) => issue.message);
}

describe("bundled diagrams", () => {
  it("match the dataset and draw every interface their figures show", () => {
    expect(validateDiagrams(DIAGRAMS, dataset)).toEqual([]);
  });

  it.each(DIAGRAMS.map((diagram) => [diagram.id, diagram] as const))("%s has a clean layout", (_, diagram) => {
    expect(lintLayout(diagram, (edge) => edgeLabel(edge, dataset), (node, row) => nodeLabel(node, row, dataset))).toEqual([]);
  });

  it("cover the architecture views the reference promises", () => {
    expect(DIAGRAMS.map((diagram) => diagram.id)).toEqual(
      expect.arrayContaining(["epc", "epc-cups", "5gc-sba", "5gc-rp", "interworking", "ims", "epc-roaming-hr", "epc-roaming-lbo", "5gc-roaming-hr", "5gc-roaming-lbo"]),
    );
  });

  it("finds the diagrams that draw an entity", () => {
    expect(diagramsShowing("if/N26").map((diagram) => diagram.id)).toEqual(["interworking"]);
    expect(diagramsShowing("nf/PGW-C").map((diagram) => diagram.id)).toEqual(["epc-cups", "interworking"]);
  });

  it("prints a diagram as an adjacency list", () => {
    const text = diagramText(DIAGRAMS.find((diagram) => diagram.id === "interworking")!, dataset, "telecom-ref");
    expect(text).toContain("Source: TS 23.501 §4.3.1, Figure 4.3.1-1");
    expect(text).toContain("- HSS + UDM (nf/HSS + nf/UDM)");
    expect(text).toContain("- N26 (if/N26, GTPv2-C, control plane): MME — AMF");
    expect(text).toContain("- S5-U (if/S5, GTPv2-C / GTP-U, user plane): SGW — UPF + PGW-U");
    expect(text).toContain("Page: /plugins/telecom-ref/ref/diagram/interworking");
  });
});

describe("validateDiagrams", () => {
  it("accepts the sample", () => {
    expect(messages(sample())).toEqual([]);
  });

  it("flags a network function the dataset lacks", () => {
    const diagram = sample();
    diagram.nodes[0]!.nfs = ["nf/NoSuchNF"];
    expect(messages(diagram)).toContainEqual("node mme: nf/NoSuchNF is not in the dataset");
  });

  it("flags an interface the dataset lacks", () => {
    const diagram = sample();
    diagram.edges.push({ if: "if/S99", from: "mme", to: "sgw" });
    expect(messages(diagram)).toContainEqual("edge if/S99 mme→sgw: if/S99 is not an interface in the dataset");
  });

  it("flags an edge whose ends are not the interface's endpoints", () => {
    const diagram = sample();
    diagram.edges[0] = { if: "if/S6a", from: "mme", to: "sgw" };
    diagram.figures = [];
    expect(messages(diagram)).toContainEqual(expect.stringMatching(/^edge if\/S6a mme→sgw: nf\/MME to nf\/SGW does not match the endpoints of S6a/));
  });

  it("flags a self-link the dataset does not record", () => {
    const diagram = sample();
    diagram.edges.push({ if: "if/S11", from: "mme", to: "mme", loop: "bottom" });
    expect(messages(diagram)).toContainEqual(expect.stringContaining("does not match the endpoints of S11"));
  });

  it("flags an interface the cited figure shows but the diagram neither draws nor explains", () => {
    const diagram = sample();
    diagram.figures[0]!.shows.push("if/S1-MME");
    expect(messages(diagram)).toContainEqual("Figure 4.2.1-1 shows if/S1-MME, which the diagram neither draws nor lists as omitted");
    diagram.omitted = { "if/S1-MME": "left out on purpose" };
    expect(messages(diagram)).toEqual([]);
  });

  it("flags a label that names another interface", () => {
    const diagram = sample();
    diagram.edges[0]!.label = "S5-C";
    expect(messages(diagram)).toContainEqual('edge if/S11 mme→sgw: label "S5-C" does not name S11');
  });

  it("only lets a service-based interface's own NF attach to a bus", () => {
    const diagram = sample();
    diagram.buses = [{ id: "sbi", x1: 0, x2: 400, y: 30 }];
    diagram.edges.push({ if: "if/Namf", from: "mme", to: "sbi" });
    expect(messages(diagram)).toContainEqual(expect.stringContaining("MME does not exhibit Namf"));
  });
});
