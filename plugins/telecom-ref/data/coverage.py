# /// script
# requires-python = ">=3.12"
# dependencies = ["python-docx>=1.1", "pyyaml>=6"]
# ///
"""Audits the built dataset against the reference point and service lists in
the 3GPP stage-2 specs and writes data/COVERAGE.md.

Expected items come from the specs where they list them (TS 23.401 §4.2,
TS 23.002 clauses 6, 6a, and 7, TS 23.214 §4.2, TS 23.501 clause 4, and the
service clauses build.py reads) and from fixed lists for the IMS reference
points and protocols this reference sets out to cover.

It also lists which interfaces and network functions the architecture
diagrams in diagrams/*.json draw, how each diagram covers the spec
figures it cites, and what the GTP tables hold per GTP version.

Run from the plugin directory after data/build.py: uv run data/coverage.py [--offline]
"""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from pathlib import Path

from build import DATA, latest_spec, norm_key, sbi_catalogue
from parse import docx_headings, docx_lines, heading_reference_points, reference_point_lines

IMS_REFERENCE_POINTS = ["Gm", "Mw", "Cx", "Dx", "Sh", "Rx", "Gx", "Gy", "Gz", "Ro", "Rf", "Mb", "Mj", "Mg", "Ici", "Izi"]
CUPS_REFERENCE_POINTS = ["Sxa", "Sxb", "Sxc", "Sxa/Sxb", "N4"]
CUPS_NFS = ["SGW-C", "SGW-U", "PGW-C", "PGW-U", "TDF-C", "TDF-U"]
PROTOCOLS = ["PFCP", "GTPv2-C", "GTP-U", "GTP'", "Diameter", "S1AP", "NGAP", "EPS NAS", "5GS NAS", "X2AP", "XnAP",
             "F1AP", "E1AP", "SBI", "SCTP", "RADIUS"]
# What the audit does not measure, as candidates for a later phase.
PHASE_2 = """## Not covered (candidate phase 2)

- PFCP messages and IEs (TS 29.244 clauses 7 and 8): message types, IE types, and grouped IE layouts.
- GTP IE field layouts (the octet figures of TS 29.274 clause 8, TS 29.060 §7.7, TS 29.281 clause 8), the
  condition text of message IE tables, and the GTPv2-C S101/S121 messages of TS 29.276.
- NGAP, S1AP, XnAP, X2AP, F1AP, and E1AP procedures and IEs (TS 38.413, 36.413, 38.423, 36.423, 38.473, 38.463).
- 5GS and EPS NAS message types and IEs (TS 24.501, TS 24.301).
- SBI resources, OpenAPI paths and data types (the TS 29.5xx OpenAPI files), and per-operation stage-3 detail.
- Reference points in TS 23.002 Annex A (the optional GLR) and in the feature specs TS 23.501 only points to
  (LCS TS 23.273, ProSe TS 23.304, MBS TS 23.247, UAS TS 23.256, AKMA TS 33.535).
"""


DIAGRAMS = DATA.parent / "diagrams"
SBI_LINE = re.compile(r"^(N[a-z0-9-]+):\s*Service[- ]based interface exhibited by")


def diagram_lines(interfaces: list[dict], nfs: list[dict]) -> list[str]:
    """The diagrams section: per-diagram figure coverage, then what at least one diagram draws."""
    diagrams = [json.loads(path.read_text("utf-8")) for path in sorted(DIAGRAMS.glob("*.json"))]
    names = {e["id"]: e["name"] for e in interfaces + nfs}
    drawn_ifs = {edge["if"] for d in diagrams for edge in d["edges"]}
    drawn_nfs = {nf for d in diagrams for node in d["nodes"] for nf in node["nfs"]}
    lines = ["## Architecture diagrams", "",
             "Each diagram in `diagrams/` cites the spec figures it draws. `Shown` counts the interfaces a figure",
             "labels; each is drawn or listed as omitted with a reason (checked by `diagrams.test.ts`).", "",
             "| Diagram | Figure | Shown | Drawn | Omitted |", "| --- | --- | ---: | ---: | ---: |"]
    for d in diagrams:
        drawn = {edge["if"] for edge in d["edges"]}
        for figure in d["figures"]:
            shows = figure["shows"]
            lines.append(f"| {d['id']} ({d['title']} · {d['variant']}) | {figure['doc']} Figure {figure['figure']} | {len(shows)} "
                         f"| {sum(1 for i in shows if i in drawn)} | {sum(1 for i in shows if i in d.get('omitted', {}))} |")
    def listing(ids: set[str]) -> str:
        return ", ".join(sorted((names.get(i, i) for i in ids), key=str.lower))
    lines += ["", f"Interfaces drawn in at least one diagram ({len(drawn_ifs)} of {len(interfaces)}): {listing(drawn_ifs)}.", "",
              f"Network functions drawn in at least one diagram ({len(drawn_nfs)} of {len(nfs)}): {listing(drawn_nfs)}.", ""]
    omitted = sorted({i for d in diagrams for i in d.get("omitted", {})} - drawn_ifs)
    if omitted:
        lines += [f"Shown in a cited figure but drawn in no diagram: {listing(set(omitted))}.", ""]
    return lines


@dataclass
class Item:
    name: str
    source: str
    found: str | None


GTP_VERSIONS = {"v2c": "GTPv2-C (TS 29.274, Sv TS 29.280)", "v1c": "GTPv1-C (TS 29.060)", "v1u": "GTPv1-U (TS 29.281)"}


def gtp_lines(messages: list[dict], ies: list[dict], causes: list[dict], extensions: list[dict]) -> list[str]:
    """The GTP section: entries per version, and the messages and IE table rows the tables leave open."""
    version = lambda e: e["id"].split("/")[1]
    lines = ["## GTP", "", "| Version | Messages | With IE tables | IEs | Causes | Extension headers |",
             "| --- | ---: | ---: | ---: | ---: | ---: |"]
    for key, label in GTP_VERSIONS.items():
        count = lambda items: sum(1 for e in items if version(e) == key)
        tables = sum(1 for m in messages if version(m) == key and m["ieTables"])
        lines.append(f"| {label} | {count(messages)} | {tables} | {count(ies)} | {count(causes)} | {count(extensions)} |")
    without = [f"{m['name']} ({version(m)} {m['type']})" for m in messages if not m["ieTables"]]
    lines += ["", f"Messages without an IE table, because the spec defines none: {', '.join(without)}."]
    unresolved: dict[str, int] = {}

    def visit(table: dict) -> None:
        for row in table["rows"]:
            if row["ie"] is None:
                unresolved[row["type"]] = unresolved.get(row["type"], 0) + 1
            if row["group"]:
                visit(row["group"])

    for m in messages:
        for table in m["ieTables"]:
            visit(table)
    rows = ", ".join(f"{name} ({n} rows)" for name, n in sorted(unresolved.items()))
    lines += ["", f"IE table rows that name no single IE type: {rows or 'none'}.", ""]
    return lines


def entity_index(groups: list[list[dict]]) -> dict[str, str]:
    """Normalized name or alias -> entity id, first entity wins."""
    index: dict[str, str] = {}
    for group in groups:
        for entity in group:
            for key in [entity["name"], *entity.get("aliases", [])]:
                index.setdefault(norm_key(key), entity["id"])
    return index


def unique(items: list[Item]) -> list[Item]:
    seen: set[str] = set()
    out = []
    for item in items:
        if norm_key(item.name) not in seen:
            seen.add(norm_key(item.name))
            out.append(item)
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--offline", action="store_true", help="use only cached downloads")
    args = parser.parse_args()

    def load(name: str) -> list[dict]:
        path = DATA / f"{name}.json"
        return json.loads(path.read_text("utf-8")) if path.exists() else []

    interfaces, nfs, services, protocols = load("interfaces"), load("nfs"), load("services"), load("protocols")
    if_index = entity_index([interfaces])
    nf_index = entity_index([nfs])
    svc_index = entity_index([services])
    proto_index = entity_index([protocols])

    def spec_lines(number: str) -> list[tuple[str, str | None]]:
        source = latest_spec(number, args.offline)
        assert source.path, f"TS {number} has no document"
        return docx_lines(source.path)

    def rp_items(points, index) -> list[Item]:
        out = []
        for point in points:
            source = f"{point.doc} §{point.clause}" if point.clause else point.doc
            out.append(Item(point.name, source, index.get(norm_key(point.name))))
        return out

    categories: dict[str, list[Item]] = {}

    epc = reference_point_lines(spec_lines("23.401"), "TS 23.401", ("4.2",))
    legacy = heading_reference_points(docx_headings(spec_lines("23.002")), "TS 23.002", ("6", "6a", "7"))
    categories["EPC and legacy reference points (TS 23.401 §4.2, TS 23.002 clauses 6, 6a, 7)"] = unique(
        rp_items(epc + legacy, if_index))

    cups = reference_point_lines(spec_lines("23.214"), "TS 23.214", ("4.2",))
    cups_items = rp_items(cups, if_index)
    cups_items += [Item(n, "TS 23.214 §4.2.2" if "/" in n else "TS 23.501 §4.3.1", if_index.get(norm_key(n)))
                   for n in CUPS_REFERENCE_POINTS if n not in {i.name for i in cups_items}]
    cups_items += [Item(n, "TS 23.214 §4.3.2", nf_index.get(norm_key(n))) for n in CUPS_NFS]
    categories["CUPS reference points and functions (TS 23.214, TS 29.244)"] = unique(cups_items)

    five_g = [p for p in reference_point_lines(spec_lines("23.501"), "TS 23.501", ("4",)) if p.name.startswith("N")]
    five_g_items = rp_items(five_g, if_index)
    five_g_items.append(Item("N26", "TS 23.501 §4.3.1", if_index.get("n26")))
    categories["5GS reference points (TS 23.501 clause 4)"] = unique(five_g_items)

    sbi_names = [m.group(1) for text, clause in spec_lines("23.501") if clause in ("4.2.6", "4.4.2.3")
                 and (m := SBI_LINE.match(text.replace("\t", " ")))]
    categories["5GC service-based interfaces (TS 23.501 §4.2.6, §4.4.2.3)"] = unique(
        [Item(n, "TS 23.501 §4.2.6", if_index.get(norm_key(n))) for n in sbi_names])

    categories["IMS reference points"] = [Item(n, "TS 23.228 / TS 23.002 §6a.7", if_index.get(norm_key(n)))
                                          for n in IMS_REFERENCE_POINTS]

    catalogue = sbi_catalogue(args.offline)
    categories["5GC SBI services (TS 23.502 §5.2, TS 23.288, TS 23.273, TS 23.632, TS 32.290, stage 3)"] = [
        Item(name, source, svc_index.get(norm_key(name))) for name, source in catalogue]

    categories["Protocols"] = [Item(n, "", proto_index.get(norm_key(n))) for n in PROTOCOLS]

    lines = [
        "# telecom-ref coverage",
        "",
        "Generated by `uv run data/coverage.py` from the built dataset and the Rel-18 specs. Each row of the",
        "summary counts the items the cited specs list and how many have an entry here.",
        "",
        "| Category | Expected | Covered | Missing |",
        "| --- | ---: | ---: | ---: |",
    ]
    for title, items in categories.items():
        covered = sum(1 for i in items if i.found)
        lines.append(f"| {title} | {len(items)} | {covered} | {len(items) - covered} |")
    lines += ["", f"Dataset: {len(interfaces)} interfaces, {len(nfs)} network functions, {len(services)} SBI services, "
              f"{len(protocols)} protocols.", ""]
    for title, items in categories.items():
        missing = [i for i in items if not i.found]
        lines += [f"## {title}", ""]
        if not missing:
            lines += ["All covered.", ""]
            continue
        lines += [f"Missing ({len(missing)}):", ""]
        lines += [f"- {i.name}" + (f" ({i.source})" if i.source else "") for i in missing]
        lines.append("")
    lines += diagram_lines(interfaces, nfs)
    lines += gtp_lines(load("gtpMessages"), load("gtpIes"), load("gtpCauses"), load("gtpExtensions"))
    lines += PHASE_2.splitlines()
    (DATA / "COVERAGE.md").write_text("\n".join(lines).rstrip() + "\n", "utf-8")
    for title, items in categories.items():
        print(f"{title}: {sum(1 for i in items if i.found)}/{len(items)}")


if __name__ == "__main__":
    main()
