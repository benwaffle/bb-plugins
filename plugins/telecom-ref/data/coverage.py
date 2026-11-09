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

Run from the plugin directory after data/build.py: uv run data/coverage.py [--offline]
"""

from __future__ import annotations

import argparse
import json
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
- GTPv2-C, GTPv1-C, and GTP-U message and IE types (TS 29.274, TS 29.060, TS 29.281).
- NGAP, S1AP, XnAP, X2AP, F1AP, and E1AP procedures and IEs (TS 38.413, 36.413, 38.423, 36.423, 38.473, 38.463).
- 5GS and EPS NAS message types and IEs (TS 24.501, TS 24.301).
- SBI resources, OpenAPI paths and data types (the TS 29.5xx OpenAPI files), and per-operation stage-3 detail.
- Reference points in TS 23.002 Annex A (the optional GLR) and in the feature specs TS 23.501 only points to
  (LCS TS 23.273, ProSe TS 23.304, MBS TS 23.247, UAS TS 23.256, AKMA TS 33.535).
"""


@dataclass
class Item:
    name: str
    source: str
    found: str | None


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
    lines += PHASE_2.splitlines()
    (DATA / "COVERAGE.md").write_text("\n".join(lines).rstrip() + "\n", "utf-8")
    for title, items in categories.items():
        print(f"{title}: {sum(1 for i in items if i.found)}/{len(items)}")


if __name__ == "__main__":
    main()
