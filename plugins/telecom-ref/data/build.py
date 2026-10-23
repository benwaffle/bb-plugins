# /// script
# requires-python = ">=3.12"
# dependencies = ["python-docx>=1.1", "pyyaml>=6"]
# ///
"""Builds the telecom-ref dataset from public IANA, IETF, and 3GPP sources.

Downloads (cached under data/.cache/):
  - IANA AAA parameters: AVP codes, application IDs, command codes (CSV).
  - IETF RFC text for the RFCs the IANA AVP registry cites.
  - 3GPP Rel-18 specs from the 3GPP FTP "latest/Rel-18" folders: TS 29.230
    for 3GPP application IDs, command codes, and AVP codes, and each spec
    TS 29.230 cites for AVP flag rules, command formats, and grouped AVPs.

Merges curated YAML under data/curated/ (applications, interfaces, network
functions, and per-spec descriptions), computes reverse cross-links, writes
the JSON the plugin bundles, and runs the plugin's dataset validator.

Run from the plugin directory: uv run data/build.py [--offline]
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import re
import subprocess
import sys
import time
import urllib.request
import zipfile
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

import docx
import yaml

from parse import (
    CommandFormat,
    FlagRow,
    GroupedFormat,
    clean_name,
    dedupe_cells,
    docx_flag_rows,
    docx_headings,
    docx_lines,
    norm_type,
    parse_abnf,
    rfc_command_abbrevs,
    rfc_flag_rows,
    rfc_lines,
    rfc_numbers,
    spec_numbers,
)

DATA = Path(__file__).resolve().parent
PLUGIN = DATA.parent
CACHE = DATA / ".cache"
CURATED = DATA / "curated"

RELEASE = 18
IANA_BASE = "https://www.iana.org/assignments/aaa-parameters"
IANA_CSV = {
    "avps": f"{IANA_BASE}/aaa-parameters-1.csv",
    "apps": f"{IANA_BASE}/aaa-parameters-46.csv",
    "commands": f"{IANA_BASE}/aaa-parameters-47.csv",
}
# Diameter reuses RADIUS attribute codes 1-255 as vendor-0 AVP codes (RFC 6733 §4.5).
IANA_RADIUS_CSV = "https://www.iana.org/assignments/radius-types/radius-types-2.csv"
RADIUS_SKIP = re.compile(r"unassigned|reserved|experimental|implementation|allocated|deprecated", re.I)
RFC_URL = "https://www.rfc-editor.org/rfc/rfc{n}.txt"
SPEC_FOLDER = "https://www.3gpp.org/ftp/Specs/latest/Rel-{rel}/{series}_series/"
USER_AGENT = "Mozilla/5.0 (compatible; telecom-ref-build/1.0)"

VENDOR_IETF = 0
VENDOR_3GPP = 10415
VENDOR_NAMES = {VENDOR_IETF: "IETF", VENDOR_3GPP: "3GPP"}

# Applications whose commands and AVPs carry full descriptions.
IN_SCOPE_APPS = {0, 3, 4, 16777216, 16777217, 16777236, 16777238, 16777251, 16777252, 16777255, 16777291,
                 16777309, 16777310, 16777311, 16777312, 16777313, 16777345, 16777346}

# The application an RFC's command formats belong to when the header omits it.
RFC_DEFAULT_APP = {6733: 0, 8506: 4, 7155: 1, 4072: 5, 4004: 2, 4740: 6}
RFC_COMMAND_APP_OVERRIDES = {(6733, 271): 3}


# --------------------------------------------------------------------------
# Downloads


def fetch(url: str, dest: Path, offline: bool) -> Path:
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    if offline:
        raise SystemExit(f"offline and not cached: {url}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                body = response.read()
            tmp = dest.with_suffix(dest.suffix + ".part")
            tmp.write_bytes(body)
            tmp.replace(dest)
            return dest
        except Exception as error:  # noqa: BLE001 - retried, then re-raised
            if attempt == 3:
                raise SystemExit(f"download failed: {url}: {error}") from error
            time.sleep(2 * (attempt + 1))
    raise AssertionError("unreachable")


def spec_version(zip_name: str) -> str:
    """'29272-i70.zip' -> '18.7.0': each version digit is base 36."""
    code = re.search(r"-([0-9a-z]{3})\.zip$", zip_name)
    assert code, zip_name
    return ".".join(str(int(ch, 36)) for ch in code.group(1))


@dataclass
class SpecSource:
    number: str  # "29.272"
    version: str | None
    url: str | None
    path: Path | None


def latest_spec(number: str, offline: bool) -> SpecSource:
    series = number.split(".")[0]
    folder = SPEC_FOLDER.format(rel=RELEASE, series=series)
    listing = fetch(folder, CACHE / f"rel{RELEASE}-{series}-listing.html", offline).read_text("utf-8", "replace")
    compact = number.replace(".", "")
    names = sorted(set(re.findall(rf"\b{compact}-[0-9a-z]{{3}}\.zip", listing)))
    if not names:
        return SpecSource(number, None, None, None)
    name = names[-1]
    url = folder + name
    archive = fetch(url, CACHE / "3gpp" / name, offline)
    target = CACHE / "3gpp" / f"{compact}-{spec_version(name)}.docx"
    if target.exists():
        return SpecSource(number, spec_version(name), url, target)
    with zipfile.ZipFile(archive) as zf:
        # Multi-part specs ship one document per part; the first holds the main body.
        members = sorted(m for m in zf.namelist() if m.lower().endswith((".docx", ".doc")))
        if not members:
            return SpecSource(number, spec_version(name), url, None)
        member = members[0]
        if member.lower().endswith(".docx"):
            target.write_bytes(zf.read(member))
        else:
            legacy = target.with_suffix(".doc")
            legacy.write_bytes(zf.read(member))
            # Older specs ship Word 97 files; macOS textutil converts them.
            converted = subprocess.run(["textutil", "-convert", "docx", "-output", str(target), str(legacy)],
                                       capture_output=True)
            if converted.returncode != 0:
                print(f"  cannot convert {member}: {converted.stderr.decode().strip()}", file=sys.stderr)
                return SpecSource(number, spec_version(name), url, None)
    return SpecSource(number, spec_version(name), url, target)


# --------------------------------------------------------------------------
# Sources


def read_csv(path: Path) -> list[dict[str, str]]:
    return list(csv.DictReader(io.StringIO(path.read_text("utf-8"))))


def ref_text_docs(reference: str) -> list[str]:
    docs = [f"RFC {n}" for n in rfc_numbers(reference)]
    docs += [f"TS {n}" for n in spec_numbers(reference)]
    return docs


@dataclass
class Model:
    apps: dict[int, dict] = field(default_factory=dict)
    commands: dict[int, dict] = field(default_factory=dict)
    avps: dict[tuple[int, int], dict] = field(default_factory=dict)
    formats: list[CommandFormat] = field(default_factory=list)
    grouped: list[GroupedFormat] = field(default_factory=list)
    sources: list[dict] = field(default_factory=list)
    spec_versions: dict[str, str | None] = field(default_factory=dict)
    clause_titles: dict[str, dict[str, str]] = field(default_factory=dict)


def ref(doc: str, model: Model, clause: str | None = None) -> dict:
    out: dict = {"doc": doc}
    version = model.spec_versions.get(doc)
    if version:
        out["version"] = version
    if clause:
        out["clause"] = clause
    return out


def load_iana(model: Model, offline: bool) -> None:
    paths = {k: fetch(url, CACHE / "iana" / Path(url).name, offline) for k, url in IANA_CSV.items()}
    for key, url in IANA_CSV.items():
        model.sources.append({"name": f"IANA AAA parameters: {key}", "url": url})
    for row in read_csv(paths["apps"]):
        value, name = row["ID Value"].strip(), row["Name"].strip()
        if not value.isdigit() or name.lower() in {"unassigned", "reserved"}:
            continue
        app_id = int(value)
        model.apps[app_id] = {
            "appId": app_id,
            "name": name,
            "vendor": VENDOR_3GPP if name.startswith("3GPP") else VENDOR_IETF,
            "refs": ref_text_docs(row["Reference"]),
        }
    for row in read_csv(paths["commands"]):
        value, name = row["Code Value"].strip(), row["Name"].strip()
        if not value.isdigit() or name.lower() in {"unassigned", "reserved", "experimental code"}:
            continue
        code = int(value)
        abbrevs = re.findall(r"\b([A-Z]{3})\b", name)
        full = re.sub(r"\s*\([^)]*\)\s*", "", name).strip()
        full = re.sub(r"^3GPP-", "", full)
        entry = {"code": code, "ianaName": name, "refs": ref_text_docs(row["Reference"])}
        if abbrevs:
            entry["abbrevs"] = abbrevs[:2]
        if "-" in full and "/" in full and not re.fullmatch(r"[A-Z]{3}\s*/\s*[A-Z]{3}", full):
            entry["pairName"] = full
        model.commands[code] = entry
    radius = fetch(IANA_RADIUS_CSV, CACHE / "iana" / Path(IANA_RADIUS_CSV).name, offline)
    model.sources.append({"name": "IANA RADIUS attribute types", "url": IANA_RADIUS_CSV})
    for row in read_csv(radius):
        value, name = row["Value"].strip(), row["Description"].strip()
        if not value.isdigit() or not 1 <= int(value) <= 255 or RADIUS_SKIP.search(name):
            continue
        model.avps[(VENDOR_IETF, int(value))] = {
            "code": int(value),
            "vendor": VENDOR_IETF,
            "name": clean_name(name),
            "refs": ref_text_docs(row["Reference"]),
        }
    for row in read_csv(paths["avps"]):
        value, name = row["AVP Code"].strip(), row["Attribute Name"].strip()
        if not value.isdigit() or name.lower() in {"unassigned", "reserved"} or name.lower().startswith("reserved"):
            continue
        code = int(value)
        model.avps[(VENDOR_IETF, code)] = {
            "code": code,
            "vendor": VENDOR_IETF,
            "name": clean_name(name),
            "refs": ref_text_docs(row["Reference"]),
        }


def load_29230(model: Model, offline: bool) -> SpecSource:
    source = latest_spec("29.230", offline)
    assert source.path, "TS 29.230 must be available"
    model.spec_versions["TS 29.230"] = source.version
    model.sources.append({"name": f"3GPP TS 29.230 V{source.version}", "url": source.url})
    document = docx.Document(str(source.path))
    for table in document.tables:
        header = dedupe_cells([c.text.strip() for c in table.rows[0].cells])
        rows = [dedupe_cells([c.text.strip() for c in r.cells]) for r in table.rows[1:]]
        if header[:2] == ["Application identifier", "Application"]:
            for cells in rows:
                if len(cells) < 3 or not cells[0].isdigit():
                    continue
                app = model.apps.setdefault(int(cells[0]), {"appId": int(cells[0]), "refs": []})
                app.setdefault("name", cells[1])
                app["vendor"] = VENDOR_3GPP
                app["refs"] = sorted(set(app["refs"]) | {f"TS {n}" for n in spec_numbers(cells[2])})
        elif header[:3] == ["Command code value", "Command name", "Abbreviation"]:
            for cells in rows:
                if len(cells) < 4 or not cells[0].isdigit() or not cells[1]:
                    continue
                code = int(cells[0])
                entry = model.commands.setdefault(code, {"code": code, "refs": []})
                entry["pairName"] = clean_name(cells[1])
                abbrevs = [a.strip() for a in cells[2].split("/") if a.strip()]
                if len(abbrevs) == 2:
                    entry["abbrevs"] = abbrevs
                entry["refs"] = sorted(set(entry["refs"]) | {f"TS {n}" for n in spec_numbers(cells[3])})
        elif header[:3] == ["AVP Code", "Attribute Name", "Data Type"]:
            for cells in rows:
                if len(cells) < 4 or not cells[0].isdigit():
                    continue
                code = int(cells[0])
                spec = cells[3]
                model.avps[(VENDOR_3GPP, code)] = {
                    "code": code,
                    "vendor": VENDOR_3GPP,
                    "name": clean_name(cells[1]),
                    "type": norm_type(cells[2]),
                    "refs": [f"TS {n}" for n in spec_numbers(spec)],
                }
    return source


def merge_flag_rows(model: Model, rows: list[FlagRow], vendor_hint: int, doc: str) -> int:
    merged = 0
    by_name = {norm_key(a["name"]): k for k, a in model.avps.items() if k[0] == vendor_hint}
    for row in rows:
        if row.code is None:
            named = by_name.get(norm_key(row.name))
            if named is None:
                continue
            row.code = named[1]
        key = (vendor_hint, row.code)
        if key not in model.avps and vendor_hint == VENDOR_3GPP and row.code < 256 and doc == "TS 29.061":
            # TS 29.230 reserves 3GPP codes 1-255 for the RADIUS VSAs that TS 29.061 defines.
            model.avps[key] = {"code": row.code, "vendor": VENDOR_3GPP, "name": row.name, "refs": [doc]}
        avp = model.avps.get(key)
        if avp is not None and row.name.endswith("-") and norm_key(avp["name"]).startswith(norm_key(row.name)):
            row.name = avp["name"]  # RFC tables wrap long names onto a second line
        if avp is None or norm_key(avp["name"]) != norm_key(row.name):
            # Some flag tables list AVPs reused from other vendors; match by name.
            other = (VENDOR_IETF if vendor_hint == VENDOR_3GPP else VENDOR_3GPP, row.code)
            if other in model.avps and norm_key(model.avps[other]["name"]) == norm_key(row.name):
                key, avp = other, model.avps[other]
            elif avp is None:
                continue
            elif norm_key(avp["name"]) != norm_key(row.name):
                continue
        if "defined" in avp and avp["defined"]["doc"] != doc and doc not in avp.get("refs", []):
            continue  # a table that only lists an AVP defined elsewhere
        avp["flags"] = {"must": row.must, "may": row.may, "shouldNot": row.should_not, "mustNot": row.must_not}
        if row.type:
            # The defining spec's table is more reliable than the TS 29.230 summary table.
            avp["type"] = row.type
        if row.encr and row.encr.lower() in {"y", "yes", "n", "no"}:
            avp["mayEncrypt"] = row.encr.lower().startswith("y")
        clause = row.clause if row.clause and re.fullmatch(r"(\d+[a-z]?|[A-Z])(\.\d+[A-Za-z]?)*", row.clause) else None
        avp["defined"] = ref(doc, model, clause)
        merged += 1
    return merged


TYPE_SENTENCE = re.compile(
    r"\b([A-Za-z0-9][\w\-]*)\s+AVP\s*\(\s*AVP\s+[Cc]ode\s+(\d+)\s*\)\s+is\s+of\s+type\s+([A-Za-z][\w]*)"
)


def merge_type_sentences(model: Model, text: str, vendor_hint: int) -> int:
    """Fill missing data types from definitions like "The X AVP (AVP Code 1) is of type UTF8String"."""
    merged = 0
    for name, code, kind in TYPE_SENTENCE.findall(re.sub(r"\s+", " ", text)):
        avp = model.avps.get((vendor_hint, int(code)))
        if avp is None or avp.get("type") or norm_key(avp["name"]) != norm_key(name):
            continue
        avp["type"] = norm_type(kind)
        merged += 1
    return merged


def norm_key(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", text.lower())


def load_specs(model: Model, offline: bool) -> None:
    cited = sorted({d[3:] for a in model.avps.values() for d in a.get("refs", []) if d.startswith("TS ")}
                   | {d[3:] for a in model.apps.values() for d in a.get("refs", []) if d.startswith("TS ")}
                   | {d[3:] for c in model.commands.values() for d in c.get("refs", []) if d.startswith("TS ")})
    for number in cited:
        if number == "29.230":
            continue
        source = latest_spec(number, offline)
        doc = f"TS {number}"
        model.spec_versions[doc] = source.version
        if source.path is None:
            continue
        model.sources.append({"name": f"3GPP TS {number} V{source.version}", "url": source.url})
        lines = docx_lines(source.path)
        model.clause_titles[doc] = docx_headings(lines)
        merged = merge_flag_rows(model, docx_flag_rows(source.path), VENDOR_3GPP, doc)
        merge_type_sentences(model, "\n".join(text for text, _ in lines), VENDOR_3GPP)
        commands, grouped = parse_abnf(lines, doc, source.version, None)
        model.formats += commands
        model.grouped += grouped
        write_text_dump(doc, source.version, lines)
        print(f"  {doc} V{source.version}: {merged} flag rows, {len(commands)} command formats, {len(grouped)} grouped",
              file=sys.stderr)


def write_text_dump(doc: str, version: str | None, lines: list[tuple[str, str | None]]) -> None:
    """Plain-text copy of a spec, kept in the cache for description drafting."""
    out = CACHE / "text" / f"{doc.replace(' ', '_')}.txt"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(f"{doc} V{version}\n" + "\n".join(text for text, _ in lines), "utf-8")


def load_rfcs(model: Model, offline: bool) -> None:
    cited = sorted({int(d[4:]) for a in model.avps.values() for d in a.get("refs", []) if d.startswith("RFC ")}
                   | set(RFC_DEFAULT_APP))
    for number in cited:
        url = RFC_URL.format(n=number)
        try:
            path = fetch(url, CACHE / "rfc" / f"rfc{number}.txt", offline)
        except SystemExit as error:
            print(f"  RFC {number}: {error}", file=sys.stderr)
            continue
        doc = f"RFC {number}"
        model.sources.append({"name": doc, "url": url})
        lines = rfc_lines(path.read_text("utf-8", "replace"))
        merged = merge_flag_rows(model, rfc_flag_rows(lines), VENDOR_IETF, doc)
        merge_type_sentences(model, "\n".join(text for text, _ in lines), VENDOR_IETF)
        overrides = {code: app for (rfc, code), app in RFC_COMMAND_APP_OVERRIDES.items() if rfc == number}
        commands, grouped = parse_abnf(lines, doc, None, RFC_DEFAULT_APP.get(number), overrides)
        if number in RFC_DEFAULT_APP:
            model.formats += commands
            for code, entries in rfc_command_abbrevs(lines).items():
                entry = model.commands.get(code)
                if entry is None:
                    continue
                for full, abbrev, is_request in entries:
                    entry.setdefault("rfcNames", {})["request" if is_request else "answer"] = (full, abbrev)
        model.grouped += grouped
        write_text_dump(doc, None, lines)
        print(f"  {doc}: {merged} flag rows, {len(commands)} command formats, {len(grouped)} grouped", file=sys.stderr)


# --------------------------------------------------------------------------
# Assembly


def avp_id(vendor: int, code: int) -> str:
    return f"diam.avp/{vendor}/{code}"


def app_id(app: int) -> str:
    return f"diam.app/{app}"


def cmd_id(code: int) -> str:
    return f"diam.cmd/{code}"


def load_yaml(path: Path) -> object:
    return yaml.safe_load(path.read_text("utf-8")) if path.exists() else None


def first_ref(refs: list[str]) -> str | None:
    for doc in refs:
        if doc.startswith("TS ") or doc.startswith("RFC "):
            return doc
    return None


# Normalized AVP name -> (vendor, code) and registered name of each AVP that normalizes to it.
NameIndex = dict[str, list[tuple[tuple[int, int], str]]]


def resolve_name_index(model: Model) -> NameIndex:
    index: NameIndex = {}
    for key, avp in model.avps.items():
        index.setdefault(norm_key(avp["name"]), []).append((key, avp["name"]))
    return index


def resolve(name: str, doc: str, index: NameIndex, aliases: dict[str, str]) -> str | None:
    name = aliases.get(name, name)
    entries = index.get(norm_key(name), [])
    if not entries:
        return None
    preferred = VENDOR_IETF if doc.startswith("RFC") else VENDOR_3GPP

    # Names that differ only in case, as Service-Id 855 and Service-ID 3103 do, go to the
    # exact match. A RADIUS attribute (code < 256) can share a name with a Diameter-native
    # AVP, as Service-Selection 146 and 493 do; Diameter command formats mean the latter.
    def rank(entry: tuple[tuple[int, int], str]) -> tuple:
        (vendor, code), registered = entry
        return (registered != name, vendor != preferred, code < 256, vendor, code)

    key, _ = min(entries, key=rank)
    return avp_id(*key)


def assemble(model: Model) -> dict[str, list[dict]]:
    apps_yaml = load_yaml(CURATED / "apps.yaml") or {}
    curated_apps = apps_yaml.get("apps") or {}
    format_clauses = apps_yaml.get("formatClauses") or {}
    interfaces = load_yaml(CURATED / "interfaces.yaml") or []
    nfs = load_yaml(CURATED / "nfs.yaml") or []
    aliases = (load_yaml(CURATED / "aliases.yaml") or {}).get("avpNames", {})
    descriptions: dict[str, dict] = {}
    for path in sorted((CURATED / "descriptions").glob("*.yaml")):
        data = load_yaml(path) or {}
        descriptions[path.stem] = data

    index = resolve_name_index(model)
    unresolved: dict[str, int] = {}

    def ref_list(refs: list) -> list[dict]:
        out = []
        for r in refs:
            if isinstance(r, str):
                doc, _, clause = r.partition("§")
                out.append(ref(doc.strip(), model, clause.strip() or None))
            else:
                out.append(ref(r["doc"], model, r.get("clause")))
        return out

    # Grouped AVP children, keyed by AVP id. The defining spec wins over a
    # spec that repeats another's definition.
    children: dict[str, list[dict]] = {}
    child_source: dict[str, str] = {}
    for g in model.grouped:
        vendor = g.vendor if g.vendor is not None else (VENDOR_IETF if g.doc.startswith("RFC") else None)
        if vendor is None:
            continue
        key = (vendor, g.code)
        if key not in model.avps or norm_key(model.avps[key]["name"]) != norm_key(g.name):
            continue
        target = avp_id(*key)
        defined = model.avps[key].get("defined", {}).get("doc") or first_ref(model.avps[key].get("refs", []))
        if target in children and child_source[target] == defined and g.doc != defined:
            continue
        resolved = []
        for r in g.avps:
            rid = None if r.name == "AVP" else resolve(r.name, g.doc, index, aliases)
            if rid is None and r.name != "AVP":
                unresolved[r.name] = unresolved.get(r.name, 0) + 1
            resolved.append(r.to_json(rid))
        children[target] = resolved
        child_source[target] = g.doc

    # Command formats, keyed by command code then (app, direction). The spec
    # that owns the application wins when two specs print a format.
    formats: dict[int, dict[tuple[int | None, str], dict]] = {}
    for f in model.formats:
        if f.name.startswith("Example"):
            continue  # RFC 6733 §3.3 illustrates the ABNF with an example command
        if f.app is None:
            f.app = clause_app(format_clauses.get(f.doc, {}), f.clause)
        if f.app is None:
            continue
        direction = "request" if f.request else "answer"
        avps = []
        for r in f.avps:
            rid = None if r.name == "AVP" else resolve(r.name, f.doc, index, aliases)
            if rid is None and r.name != "AVP":
                unresolved[r.name] = unresolved.get(r.name, 0) + 1
            avps.append(r.to_json(rid))
        app_docs = model.apps.get(f.app, {}).get("refs", [])
        entry = {
            "app": app_id(f.app),
            "direction": direction,
            "name": f.name,
            "proxiable": f.proxiable,
            "avps": avps,
            "spec": ref(f.doc, model, f.clause),
        }
        slot = formats.setdefault(f.code, {})
        existing = slot.get((f.app, direction))
        if existing is None or (f.doc in app_docs and existing["spec"]["doc"] not in app_docs):
            slot[(f.app, direction)] = entry
        if f.code not in model.commands:
            model.commands[f.code] = {"code": f.code, "refs": [f.doc]}
        if f.app not in model.apps:
            model.apps[f.app] = {"appId": f.app, "name": f"Application {f.app}", "refs": [f.doc]}

    # ---- applications
    apps_out: dict[str, dict] = {}
    for number, app in sorted(model.apps.items()):
        curated = curated_apps.get(number, {})
        refs = ref_list(curated.get("spec", [])) or [ref(d, model) for d in app.get("refs", [])]
        name = app.get("name", f"Application {number}")
        apps_out[app_id(number)] = {
            "id": app_id(number),
            "kind": "app",
            "appId": number,
            "name": name,
            "short": curated.get("short") or (name[5:] if name.startswith("3GPP ") else None),
            "vendor": app.get("vendor", VENDOR_IETF),
            "description": curated.get("description"),
            "spec": refs,
            "commands": [],
            "interfaces": [],
        }

    # ---- commands
    cmd_desc: dict[int, dict] = {}
    avp_desc: dict[tuple[int, int] | str, dict] = {}
    for doc, data in descriptions.items():
        for code, entry in (data.get("commands") or {}).items():
            cmd_desc[int(code)] = {**entry, "_doc": doc}
        for key, entry in (data.get("avps") or {}).items():
            avp_desc[str(key)] = {**entry, "_doc": doc}

    commands_out: dict[str, dict] = {}
    for code, cmd in sorted(model.commands.items()):
        fmts = sorted(formats.get(code, {}).values(),
                      key=lambda f: (int(f["app"].split("/")[1]), f["direction"] != "request"))
        request, answer = command_names(cmd, fmts)
        for f in fmts:
            # Name abbreviation-named formats (<CER>) by the full message name, when one is known.
            full = (request if f["direction"] == "request" else answer or {"name": ""})["name"]
            if ABBREV.fullmatch(f["name"]) and full.endswith(("-Request", "-Answer")):
                f["name"] = full
        req_name = request["name"]
        name = re.sub(r"-Request$", "", req_name)
        curated = cmd_desc.get(code, {})
        doc_refs = [ref(d, model) for d in cmd.get("refs", [])]
        spec = ref_list(curated.get("spec", [])) or [f["spec"] for f in fmts if f["direction"] == "request"][:1] or doc_refs
        apps = sorted({f["app"] for f in fmts} | {app_id(a) for a in curated.get("apps", [])})
        commands_out[cmd_id(code)] = {
            "id": cmd_id(code),
            "kind": "cmd",
            "code": code,
            "name": name,
            "request": request,
            "answer": answer,
            "description": curated.get("description"),
            "flow": nf_flow(curated.get("flow")),
            "apps": apps,
            "formats": fmts,
            "spec": spec,
            "interfaces": [],
        }
        for a in apps:
            if a in apps_out:
                apps_out[a]["commands"].append(cmd_id(code))

    # ---- AVPs
    avps_out: dict[str, dict] = {}
    for (vendor, code), avp in sorted(model.avps.items()):
        aid = avp_id(vendor, code)
        curated = avp_desc.get(f"{vendor}/{code}", {})
        defined = avp.get("defined")
        refs = [defined] if defined else [ref(d, model) for d in avp.get("refs", [])[:1]]
        refs += ref_list(curated.get("spec", []))
        avps_out[aid] = {
            "id": aid,
            "kind": "avp",
            "code": code,
            "vendor": vendor,
            "name": avp["name"],
            "type": avp.get("type"),
            "flags": avp.get("flags"),
            "mayEncrypt": avp.get("mayEncrypt"),
            "description": curated.get("description"),
            "spec": dedupe_refs(refs),
            "children": children.get(aid, []),
            "parents": [],
            "carriedIn": [],
            "apps": [],
            "interfaces": [],
        }

    for aid, avp in avps_out.items():
        for child in avp["children"]:
            if child["avp"] and child["avp"] in avps_out:
                parents = avps_out[child["avp"]]["parents"]
                if aid not in parents:
                    parents.append(aid)
    for cid, cmd in commands_out.items():
        for f in cmd["formats"]:
            for r in f["avps"]:
                if r["avp"] and r["avp"] in avps_out:
                    carried = avps_out[r["avp"]]["carriedIn"]
                    if cid not in carried:
                        carried.append(cid)

    # AVP -> applications: directly carried, or reachable through grouped parents.
    for cid, cmd in commands_out.items():
        for f in cmd["formats"]:
            seen: set[str] = set()
            stack = [r["avp"] for r in f["avps"] if r["avp"]]
            while stack:
                current = stack.pop()
                if current in seen or current not in avps_out:
                    continue
                seen.add(current)
                apps = avps_out[current]["apps"]
                if f["app"] not in apps:
                    apps.append(f["app"])
                stack += [c["avp"] for c in avps_out[current]["children"] if c["avp"]]

    # ---- interfaces and network functions
    nfs_out: dict[str, dict] = {}
    for nf in nfs:
        nid = f"nf/{nf['id']}"
        nfs_out[nid] = {
            "id": nid,
            "kind": "nf",
            "name": nf["name"],
            "fullName": nf.get("fullName"),
            "generations": nf.get("generations", []),
            "description": nf.get("description"),
            "replaces": [f"nf/{x}" for x in nf.get("replaces", [])],
            "replacedBy": [],
            "aliases": nf.get("aliases", []),
            "spec": ref_list(nf.get("spec", [])),
            "interfaces": [],
        }
    for nid, nf in nfs_out.items():
        for old in nf["replaces"]:
            if old in nfs_out:
                nfs_out[old]["replacedBy"].append(nid)

    interfaces_out: dict[str, dict] = {}
    for item in interfaces:
        iid = f"if/{item['id']}"
        interfaces_out[iid] = {
            "id": iid,
            "kind": "if",
            "name": item["name"],
            "generations": item.get("generations", []),
            "endpoints": [f"nf/{e}" for e in item.get("endpoints", [])],
            "protocol": item.get("protocol"),
            "apps": [app_id(a) for a in item.get("apps", [])],
            "description": item.get("description"),
            "aliases": item.get("aliases", []),
            "spec": ref_list(item.get("spec", [])),
        }
        for endpoint in interfaces_out[iid]["endpoints"]:
            if endpoint in nfs_out:
                nfs_out[endpoint]["interfaces"].append(iid)
        for a in interfaces_out[iid]["apps"]:
            if a in apps_out:
                apps_out[a]["interfaces"].append(iid)

    for cmd in commands_out.values():
        cmd["interfaces"] = sorted({i for a in cmd["apps"] if a in apps_out for i in apps_out[a]["interfaces"]})
    for avp in avps_out.values():
        avp["apps"].sort()
        avp["carriedIn"].sort()
        avp["parents"].sort()
        avp["interfaces"] = sorted({i for a in avp["apps"] if a in apps_out for i in apps_out[a]["interfaces"]})

    in_scope = {app_id(a) for a in IN_SCOPE_APPS}
    for avp in avps_out.values():
        avp["inScope"] = any(a in in_scope for a in avp["apps"])

    top_unresolved = sorted(unresolved.items(), key=lambda kv: -kv[1])[:25]
    if top_unresolved:
        print(f"  unresolved AVP names in formats ({len(unresolved)}): {top_unresolved}", file=sys.stderr)

    return {
        "apps": list(apps_out.values()),
        "commands": list(commands_out.values()),
        "avps": list(avps_out.values()),
        "interfaces": list(interfaces_out.values()),
        "nfs": list(nfs_out.values()),
    }


ABBREV = re.compile(r"[A-Z]{3}")


def split_pair(pair: str | None) -> tuple[str | None, str | None]:
    """'Update-Location-Request/Answer' -> ('Update-Location-Request', 'Update-Location-Answer')."""
    if not pair:
        return None, None
    if "Request" not in pair:
        return pair, None
    stem = re.split(r"[-\s]?Request", pair)[0]
    return f"{stem}-Request", f"{stem}-Answer"


def command_names(cmd: dict, fmts: list[dict]) -> tuple[dict, dict | None]:
    """The request and answer {name, abbrev} of a command code.

    Names come from the RFC command table, then the TS 29.230 or IANA pair
    name, then the formats; RFC 6733 formats name themselves by abbreviation
    (<CER>), which only supplies the abbreviation.
    """
    rfc = cmd.get("rfcNames", {})
    pair = dict(zip(("request", "answer"), split_pair(cmd.get("pairName"))))
    abbrevs = dict(zip(("request", "answer"), cmd.get("abbrevs") or []))
    out: dict[str, dict] = {}
    for direction in ("request", "answer"):
        format_names = [f["name"] for f in fmts if f["direction"] == direction]
        rfc_name, rfc_abbrev = rfc.get(direction, (None, None))
        out[direction] = {
            "name": rfc_name or pair[direction] or next((n for n in format_names if not ABBREV.fullmatch(n)), None),
            "abbrev": abbrevs.get(direction) or rfc_abbrev or next((n for n in format_names if ABBREV.fullmatch(n)), None),
        }
    request, answer = out["request"], out["answer"]
    if answer["name"] is None and request["name"] and request["name"].endswith("-Request"):
        answer["name"] = request["name"][: -len("Request")] + "Answer"
    request["name"] = request["name"] or cmd.get("ianaName") or f"Command {cmd['code']}"
    return request, (answer if answer["name"] else None)


def nf_flow(flow: dict | None) -> dict | None:
    """Curated `flow` names NFs by id; the dataset links them as nf/<id>."""
    if not flow:
        return None
    request = flow["request"]
    return {"request": {side: [f"nf/{n}" for n in request.get(side, [])] for side in ("from", "to")}}


def clause_app(mapping: dict[str, int], clause: str | None) -> int | None:
    """The application of the longest clause prefix in `mapping` that covers `clause`."""
    if clause is None:
        return None
    best: tuple[int, int] | None = None
    for prefix, app in mapping.items():
        if clause == prefix or clause.startswith(prefix + "."):
            if best is None or len(prefix) > best[0]:
                best = (len(prefix), app)
    return best[1] if best else None


def dedupe_refs(refs: list[dict]) -> list[dict]:
    out, seen = [], set()
    for r in refs:
        key = (r["doc"], r.get("clause"))
        if key not in seen:
            seen.add(key)
            out.append(r)
    return out


# --------------------------------------------------------------------------
# Search index


def search_keys(entity: dict) -> list[str]:
    """Normalized keys, best first. The plugin normalizes queries the same way (search.ts normalize)."""
    keys: list[str] = []
    kind = entity["kind"]
    if kind == "cmd":
        for part in (entity["request"], entity["answer"]):
            if part:
                keys += [part.get("abbrev") or "", part["name"]]
        keys += [entity["name"], str(entity["code"])]
    elif kind == "avp":
        keys += [entity["name"], str(entity["code"])]
    elif kind == "app":
        keys += [entity.get("short") or "", entity["name"], str(entity["appId"])]
    elif kind == "if":
        keys += [entity["name"], *entity.get("aliases", [])]
    elif kind == "nf":
        keys += [entity["name"], entity.get("fullName") or "", *entity.get("aliases", [])]
    out: list[str] = []
    for key in keys:
        normalized = norm_key(key)
        if normalized and normalized not in out:
            out.append(normalized)
    return out


def build_search(dataset: dict[str, list[dict]]) -> list[list]:
    docs = []
    for group in ("commands", "apps", "interfaces", "nfs", "avps"):
        for entity in dataset[group]:
            docs.append([entity["id"], search_keys(entity)])
    return docs


# --------------------------------------------------------------------------


def write_json(name: str, value: object) -> None:
    path = DATA / f"{name}.json"
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=False) + "\n", "utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--offline", action="store_true", help="use only cached downloads")
    parser.add_argument("--skip-validate", action="store_true", help="do not run the plugin's dataset validator")
    args = parser.parse_args()

    model = Model()
    print("IANA registries", file=sys.stderr)
    load_iana(model, args.offline)
    print("3GPP TS 29.230", file=sys.stderr)
    load_29230(model, args.offline)
    print("RFCs", file=sys.stderr)
    load_rfcs(model, args.offline)
    print("3GPP specs cited by TS 29.230", file=sys.stderr)
    load_specs(model, args.offline)

    dataset = assemble(model)
    counts = {k: len(v) for k, v in dataset.items()}
    counts["avpsDescribed"] = sum(1 for a in dataset["avps"] if a["description"])
    counts["avpsInScope"] = sum(1 for a in dataset["avps"] if a["inScope"])
    counts["commandsWithFormats"] = sum(1 for c in dataset["commands"] if c["formats"])
    meta = {
        "release": RELEASE,
        "built": date.today().isoformat(),
        "counts": counts,
        "specVersions": {k: v for k, v in sorted(model.spec_versions.items()) if v},
        "sources": sorted({s["url"]: s for s in model.sources}.values(), key=lambda s: s["name"]),
        "inScopeApps": [app_id(a) for a in sorted(IN_SCOPE_APPS)],
        "notice": "Descriptions are summaries written for this reference, not specification text. "
                  "See the cited clause for the normative definition.",
    }
    for name, value in dataset.items():
        write_json(name, value)
    write_json("search", build_search(dataset))
    write_json("meta", meta)
    print(json.dumps(counts), file=sys.stderr)

    if not args.skip_validate:
        result = subprocess.run(["npx", "vitest", "run", "--config", "vitest.config.ts", "dataset.test.ts"], cwd=PLUGIN)
        if result.returncode != 0:
            raise SystemExit("dataset validation failed")


if __name__ == "__main__":
    main()
