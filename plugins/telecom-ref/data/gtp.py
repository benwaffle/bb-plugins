"""GTP tables from the Rel-18 specs: TS 29.274 (GTPv2-C), TS 29.280 (Sv), TS 29.281 (GTPv1-U), TS 29.060 (GTPv1-C).

Every value comes from a table of the spec document: message type tables
(29.274 Table 6.1-1, 29.280 Table 5.2.1, 29.281 Table 6.1-1, 29.060 Table 1),
IE type tables (29.274 Table 8.1-1, 29.280 Table 6.1-1, 29.281 Table 8.1-1,
29.060 Table 37), cause tables (29.274 Table 8.4-1, 29.060 Table 38), the
extension header type tables (29.281 Figure 5.2.1-3, 29.060 Figure 5), and
the per-message IE tables ("Information Elements in a Create Session
Request"). Clause numbers come from the document headings and table numbers.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import docx

NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def flat(text: str) -> str:
    return re.sub(r"\s+", " ", text.replace("\xa0", " ")).strip()


def norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", text.lower())


def singular_norm(text: str) -> str:
    """Normalized, with each word's plural "s" dropped: "Bearer Contexts" and "Bearer Context" meet."""
    words = re.findall(r"[a-z0-9]+", text.lower())
    return "".join(w[:-1] if len(w) > 3 and w.endswith("s") else w for w in words)


def strip_notes(text: str) -> str:
    """Drops "(NOTE 10)", "See NOTE 2, NOTE 3." and reference tags such as "[4]-[5]"."""
    text = re.sub(r"\(\s*(?:see\s+)?NOTE[^)]*\)", " ", text, flags=re.I)
    text = re.sub(r"\.?\s*See\s+NOTE\s*\d+(?:\s*(?:,|and)\s*NOTE\s*\d+)*\.?", " ", text, flags=re.I)
    text = re.sub(r"\[\d+\](?:\s*-\s*\[\d+\])?", " ", text)
    return flat(text)


@dataclass
class DocTable:
    """A top-level table with the last non-empty paragraph before it and its cells, merged cells repeated."""

    index: int
    caption: str
    rows: list[list[str]]
    clause: str | None

    @property
    def header(self) -> list[str]:
        return self.rows[0] if self.rows else []


TABLE_CAPTION = re.compile(r"^Table\s*([0-9A-Z][0-9A-Za-z.\- ]*?)\s*:\s*(.+)$")


def doc_tables(path: Path) -> list[DocTable]:
    document = docx.Document(str(path))
    tables = document.tables
    out: list[DocTable] = []
    caption = ""
    clause: str | None = None
    index = 0
    for element in document.element.body.iterchildren():
        if element.tag == f"{NS}p":
            text = paragraph_text(element)
            clause = heading_clause(element, text) or clause
            if text:
                caption = text
        elif element.tag == f"{NS}tbl":
            table = tables[index]
            rows = [[c.text.replace("\xa0", " ").strip() for c in row.cells] for row in table.rows]
            out.append(DocTable(index, caption, rows, clause))
            index += 1
    return out


def caption_parts(caption: str) -> tuple[str, str] | None:
    """'Table 7.2.1-1: Information Elements in a Create Session Request' -> ('7.2.1-1', 'Information ...')."""
    match = TABLE_CAPTION.match(caption)
    if not match:
        return None
    return match.group(1).replace(" ", ""), flat(match.group(2))


def find_table(tables: list[DocTable], title: str) -> DocTable:
    for table in tables:
        parts = caption_parts(table.caption)
        if parts and norm(parts[1]) == norm(title):
            return table
    raise SystemExit(f"no table titled {title!r}")


def find_table_by_header(tables: list[DocTable], first_cell: str) -> DocTable:
    for table in tables:
        if table.header and norm(table.header[0]).startswith(norm(first_cell)):
            return table
    raise SystemExit(f"no table whose first header cell is {first_cell!r}")


def clause_of_table(number: str) -> str | None:
    """'7.2.1-1' -> '7.2.1'; '7.9.2' (a table numbered like a clause) -> '7.9'; 'Table 5' -> None."""
    if "-" in number:
        return number.rsplit("-", 1)[0]
    if "." in number:
        return number.rsplit(".", 1)[0]
    return None


# Clause numbers with letter suffixes, as GTP specs use them: "5.2.2.2A", "7.5A.1.1", "7.4.z".
CLAUSE_HEADING = re.compile(r"^((?:\d+[A-Za-z]?)(?:\.(?:\d+[A-Za-z]?|[a-z]))*)\s+(\S.*)$")


def paragraph_text(element) -> str:
    # Heading numbers are separated from titles by a tab element.
    return flat("".join((t.text or "") if t.tag == f"{NS}t" else " " for t in element.iter(f"{NS}t", f"{NS}tab")))


def heading_clause(element, text: str) -> str | None:
    """The clause number of a heading paragraph ("Heading3", "H6" styles), else None."""
    style = element.find(f"{NS}pPr/{NS}pStyle")
    style_id = style.get(f"{NS}val") if style is not None else ""
    if not re.match(r"^(Heading|H)\d", style_id or "", re.I):
        return None
    match = CLAUSE_HEADING.match(text)
    return match.group(1) if match else None


def doc_lines(path: Path) -> list[tuple[str, str | None]]:
    """Every paragraph's text, including those in tables and content controls, with the clause it sits under."""
    document = docx.Document(str(path))
    out: list[tuple[str, str | None]] = []
    clause: str | None = None
    for element in document.element.body.iter(f"{NS}p"):
        text = paragraph_text(element)
        clause = heading_clause(element, text) or clause
        out.append((text, clause))
    return out


def heading_index(lines: list[tuple[str, str | None]], under: str) -> dict[str, str]:
    """Normalized heading title -> the first clause with that title within clause `under`.

    Specs repeat titles across clauses ("4.4.2.6 End Marker" for its UDP port, "7.3.2 End Marker" for
    the message), so each lookup names the clause that defines what it looks for.
    """
    by_title: dict[str, str] = {}
    for text, clause in lines:
        if clause and clause.startswith(under + ".") and text.startswith(clause + " "):
            by_title.setdefault(norm(text[len(clause):]), clause)
    return by_title


def clause_text(lines: list[tuple[str, str | None]], clause: str) -> str:
    """The text of a clause and its subclauses."""
    return "\n".join(text for text, c in lines if c == clause or (c or "").startswith(clause + "."))


SPEC_MENTION = re.compile(r"3GPP\s+TS\s+(\d{2}\.\d{3})")


# --------------------------------------------------------------------------
# Parsed rows


@dataclass
class MessageRow:
    type: int
    name: str
    clause: str | None
    initial: bool | None
    triggered: bool | None
    group: str | None
    flow: list[tuple[list[str], list[str]]] = field(default_factory=list)
    interfaces: list[str] = field(default_factory=list)
    # The flow is the message's own ("Modify Bearer Failure Indication (PGW to MME/SGSN ...)"), not its group's.
    own_flow: bool = False


@dataclass
class IeTypeRow:
    type: int
    name: str
    abbrev: str | None
    clause: str | None
    encoding: str | None  # TV or TLV in GTPv1; None in GTPv2, whose IEs are all type-length-instance
    length: str | None  # Fixed, Variable, or Extendable
    fixed_octets: str | None


@dataclass
class CauseRow:
    code: int
    name: str
    category: str  # request, acceptance, rejection


@dataclass
class ExtHeaderRow:
    type: int
    name: str
    clause: str | None
    refs: list[str]


@dataclass
class IeRow:
    name: str
    ie_type: str  # the IE Type column as printed, or the IE name for GTPv1 tables
    reference: str | None  # GTPv1 tables cite the IE clause instead of naming its type
    presence: list[str]
    instance: str | None
    group: "IeTable | None" = None


@dataclass
class IeTable:
    number: str
    title: str
    clause: str | None
    message: str  # the message name the caption names
    rows: list[IeRow]
    group_type: int | None = None  # "Bearer Context IE Type = 93" for a grouped IE table
    group_name: str | None = None  # set for every grouped IE table, even one whose type value the spec leaves out
    parent: str | None = None  # the grouped IE a nested table sits in: "PDN Connections"


# --------------------------------------------------------------------------
# Message types


NODE_NAMES = {
    "SGSN": "SGSN", "MME": "MME", "SGW": "SGW", "PGW": "PGW", "TWAN": "TWAN", "ePDG": "ePDG", "AMF": "AMF",
    "MBMS GW": "MBMS-GW",
}
GTP_INTERFACE = re.compile(r"\b(S\d+[a-z]?|N\d+|Sm|Sn|Sv|Gn|Gp)\b")


def parse_flow(text: str) -> tuple[list[tuple[list[str], list[str]]], list[str], list[str]]:
    """'SGSN/MME/ TWAN/ePDG to PGW (S4/S11, S5/S8, S2a, S2b)' -> pairs of NF names, interfaces, unknown names."""
    # Cells separate flows with commas, "|", or line breaks.
    text = flat(re.sub(r"[\n|]", ", ", text))
    interfaces: list[str] = []
    for inner in re.findall(r"\(([^()]*)\)", text):
        nodes_part, _, iface_part = inner.partition("–")
        source = iface_part if iface_part else inner
        if iface_part and " to " in nodes_part:
            text = text.replace(f"({inner})", nodes_part)
        else:
            text = text.replace(f"({inner})", " ")
        for name in GTP_INTERFACE.findall(source):
            if name not in interfaces:
                interfaces.append(name)
    pairs: list[tuple[list[str], list[str]]] = []
    unknown: list[str] = []
    for piece in text.split(","):
        if " to " not in piece:
            continue
        left, _, right = piece.partition(" to ")
        sides = []
        for side in (left, right):
            names = []
            for raw in side.split("/"):
                name = flat(flat(raw).strip("()"))
                if not name:
                    continue
                if name in NODE_NAMES:
                    names.append(NODE_NAMES[name])
                else:
                    unknown.append(name)
            sides.append(names)
        if sides[0] and sides[1]:
            pairs.append((sides[0], sides[1]))
    return pairs, interfaces, unknown


def v2_message_types(table: DocTable, unknown_nodes: list[str]) -> list[MessageRow]:
    """TS 29.274 Table 6.1-1, with each message's group heading, flow, and interfaces."""
    header = table.header
    i_initial = header.index("Initial")
    i_triggered = header.index("Triggered")
    out: list[MessageRow] = []
    group: str | None = None
    group_flow: list = []
    group_ifaces: list[str] = []
    mobility: dict[int, str] = {}
    for cells in table.rows[1:]:
        value = flat(cells[0])
        if not value:
            marks = {k: flat(c) for k, c in enumerate(cells[1:i_initial], 1) if re.fullmatch(r"S\d+|N\d+", flat(c))}
            if marks:
                mobility = marks
                continue
            group = flat(cells[1].replace("\n", "; "))
            mobility = {}
            group_flow, group_ifaces, unknown = parse_flow(cells[1])
            unknown_nodes += unknown
            continue
        if not value.isdigit():
            continue  # a range of reserved or future values
        lines = [flat(line) for line in cells[1].split("\n") if flat(line)]
        name = lines[0]
        if re.match(r"(Reserved|For future use)", name, re.I):
            continue
        flow, ifaces = group_flow, group_ifaces
        if len(lines) > 1:
            flow, ifaces, unknown = parse_flow(" ".join(lines[1:]))
            unknown_nodes += unknown
        if mobility:
            ifaces = [iface for k, iface in mobility.items() if flat(cells[k]).upper() == "X"]
        out.append(MessageRow(
            type=int(value),
            name=name,
            clause=None,
            initial=flat(cells[i_initial]).upper() == "X",
            triggered=flat(cells[i_triggered]).upper() == "X",
            group=group if len(lines) == 1 else " ".join(lines[1:]),
            flow=flow,
            interfaces=ifaces,
            own_flow=len(lines) > 1,
        ))
    return out


def sv_message_types(table: DocTable) -> list[MessageRow]:
    """TS 29.280 Table 5.2.1: the Sv messages, which share the GTPv2-C message type space."""
    header = table.header
    i_ref, i_initial, i_triggered = header.index("Reference"), header.index("Initial"), header.index("Triggered")
    out = []
    for cells in table.rows[1:]:
        value, name, reference = flat(cells[0]), flat(cells[1]), flat(cells[i_ref])
        if not value.isdigit() or not re.fullmatch(r"\d+(\.\d+)+", reference):
            continue  # values defined by TS 29.274 or reserved
        out.append(MessageRow(
            type=int(value), name=name, clause=reference,
            initial=flat(cells[i_initial]).upper() == "X", triggered=flat(cells[i_triggered]).upper() == "X",
            group=None, interfaces=["Sv"],
        ))
    return out


def v1_message_types(table: DocTable, plane: str) -> list[MessageRow]:
    """TS 29.060 Table 1 or TS 29.281 Table 6.1-1: the messages marked for `plane` ("GTP-C" or "GTP-U")."""
    header = table.header
    i_ref, i_plane = header.index("Reference"), header.index(plane)
    out = []
    for cells in table.rows[1:]:
        value, name, reference = flat(cells[0]), flat(cells[1]), flat(cells[i_ref])
        if not value.isdigit() or flat(cells[i_plane]).upper() != "X":
            continue
        out.append(MessageRow(
            type=int(value), name=name,
            clause=reference if re.fullmatch(r"\d+[A-Z]?(\.\d+[A-Z]?)+", reference) else None,
            initial=None, triggered=None, group=None,
        ))
    return out


# --------------------------------------------------------------------------
# IE types, causes, and extension headers


def split_abbrev(text: str) -> tuple[str, str | None]:
    """'Fully Qualified Tunnel Endpoint Identifier (F-TEID)' -> (name, 'F-TEID').

    A closing parenthetical of one or two words with an acronym in it is the short name the message
    tables use ("F-TEID", "Bearer QoS"). Other parentheticals stay in the name: "Recovery (Restart
    Counter)" explains the name, and "MM Context (GSM Key and Triplets)" tells IEs of one family apart.
    """
    text = strip_notes(text).rstrip(".")
    # A parenthetical without a space before it is part of the name: "IMEI(SV)".
    match = re.fullmatch(r"(.+?)\s+\(([^()]+)\)", text)
    words = match.group(2).split() if match else []
    if match and len(words) <= 2 and any(len(re.findall(r"[A-Z]", w)) >= 2 or len(words) == 1 for w in words):
        return match.group(1), match.group(2)
    return text, None


LENGTH_KIND = {"fixedlength": "Fixed", "variablelength": "Variable", "variable": "Variable", "extendable": "Extendable"}


def v2_ie_types(table: DocTable, skip_reference: str | None = None) -> list[IeTypeRow]:
    """TS 29.274 Table 8.1-1 or TS 29.280 Table 6.1-1. Rows whose reference names `skip_reference` belong to another spec."""
    out = []
    for cells in table.rows[1:]:
        value = flat(cells[0])
        if not value.isdigit():
            continue
        name_cell = flat(cells[1])
        if re.match(r"(Reserved|Spare|For future)", name_cell, re.I):
            continue
        comment = flat(cells[2]) if len(cells) > 2 else ""
        if skip_reference and skip_reference in comment:
            continue
        name, abbrev = split_abbrev(name_cell)
        kind, _, clause = comment.partition("/")
        clause = clause.strip()
        octets = flat(cells[3]) if len(cells) > 3 else ""
        out.append(IeTypeRow(
            type=int(value), name=name, abbrev=abbrev,
            clause=clause if re.fullmatch(r"\d+(\.\d+)+", clause) else None,
            encoding=None,
            length=LENGTH_KIND.get(norm(kind)),
            fixed_octets=None if octets in ("", "Not Applicable") or octets == comment else octets,
        ))
    return out


def v1_ie_types(table: DocTable) -> list[IeTypeRow]:
    """TS 29.060 Table 37 or TS 29.281 Table 8.1-1."""
    header = [norm(h) for h in table.header]
    i_value = header.index("ietypevalue")
    i_format = header.index("format")
    i_name = header.index("informationelement")
    i_ref = header.index("reference")
    i_length = header.index("lengthtype") if "lengthtype" in header else None
    i_octets = header.index("numberoffixedoctets") if "numberoffixedoctets" in header else None
    out = []
    for cells in table.rows[1:]:
        value = flat(cells[i_value])
        if not value.isdigit():
            continue
        name_cell = flat(cells[i_name])
        if re.match(r"(Reserved|Spare|For future)", name_cell, re.I):
            continue
        name, abbrev = split_abbrev(name_cell)
        reference = flat(cells[i_ref])
        octets = flat(cells[i_octets]) if i_octets is not None else ""
        out.append(IeTypeRow(
            type=int(value), name=name, abbrev=abbrev,
            clause=reference if re.fullmatch(r"\d+(\.\d+[A-Z]?)+", reference) else None,
            encoding=flat(cells[i_format]) or None,
            length=(flat(cells[i_length]) or None) if i_length is not None else None,
            fixed_octets=None if octets in ("", "Not Applicable") else octets,
        ))
    return out


def v2_causes(table: DocTable) -> list[CauseRow]:
    """TS 29.274 Table 8.4-1: the category is the table's "Message Type" column."""
    out = []
    for cells in table.rows[1:]:
        value, meaning, kind = flat(cells[1]), strip_notes(cells[2]).rstrip("."), norm(cells[0])
        if not value.isdigit() or re.match(r"(Reserved|Spare|Shall not be used)", meaning, re.I):
            continue
        category = "acceptance" if kind.startswith("acceptance") else "rejection" if kind.startswith("rejection") else (
            "request" if kind.startswith("request") else None)
        if category is None:
            raise SystemExit(f"TS 29.274 Table 8.4-1: no category for cause {value}")
        out.append(CauseRow(int(value), meaning, category))
    return out


def v1_cause_category(value: int) -> str | None:
    """TS 29.060 Table 39: bits 8 and 7 of the cause value give request (00), acceptance (10), or rejection (11)."""
    return {0: "request", 2: "acceptance", 3: "rejection"}.get(value >> 6)


def v1_causes(table: DocTable) -> list[CauseRow]:
    """TS 29.060 Table 38."""
    out = []
    for cells in table.rows[1:]:
        value = flat(cells[-1])
        if not value.isdigit():
            continue
        meaning = flat(cells[-2]).strip('"')
        if re.match(r"(For future use|Cause values reserved)", meaning, re.I):
            continue
        category = v1_cause_category(int(value))
        if category is None:
            raise SystemExit(f"TS 29.060 Table 38: cause {value} is in the range reserved for future use")
        out.append(CauseRow(int(value), meaning, category))
    return out


def ext_headers(table: DocTable, by_title: dict[str, str], lines: list[tuple[str, str | None]],
                own_docs: set[str]) -> list[ExtHeaderRow]:
    """The "Definition of Extension Header Type" figure: binary value, name, clause, and specs its clause cites."""
    out = []
    for cells in table.rows[1:]:
        bits = flat(cells[0]).replace(" ", "")
        if not re.fullmatch(r"[01]{8}", bits):
            continue
        name = strip_notes(cells[1])
        name = re.split(r"\.\s", name)[0].rstrip(".")
        if re.match(r"(Reserved|No more extension headers)", name, re.I):
            continue
        clause = by_title.get(norm(name))
        refs: list[str] = []
        if clause:
            for number in SPEC_MENTION.findall(clause_text(lines, clause)):
                if number not in own_docs and number not in refs:
                    refs.append(number)
        out.append(ExtHeaderRow(int(bits, 2), name, clause, refs))
    return out


# --------------------------------------------------------------------------
# Per-message IE tables


IE_TABLE = re.compile(r"^Information Elements? in (?:an? )?(.+)$", re.I)
GROUP_TABLE = re.compile(r"^(.+?) with(?:in)? (?:an? )?(.+)$", re.I)
PRESENCE_V1 = {"mandatory": "M", "conditional": "C", "optional": "O"}


def message_named(text: str, names: list[str]) -> str | None:
    """The longest message name that `text` names: 'SGSN-Initiated Update PDP Context Request' -> 'Update PDP Context Request'."""
    key = norm(text)
    found = [n for n in names if norm(n) and norm(n) in key]
    return max(found, key=lambda n: len(norm(n))) if found else None


def message_suffix(text: str, names: list[str]) -> tuple[str | None, str]:
    """'PDN Connections within Context Response' -> ('Context Response', 'PDN Connections')."""
    best = None
    for name in names:
        if norm(text).endswith(norm(name)) and (best is None or len(name) > len(best)):
            best = name
    if best is None:
        return None, text
    words = text.split()
    tail = len(best.split())
    rest = " ".join(words[: len(words) - tail])
    rest = re.sub(r"\s+(with(?:in)?|in)\s*(an?)?$", "", rest, flags=re.I).strip()
    return best, rest


def ie_rows(rows: list[list[str]], v1: bool) -> list[IeRow]:
    """The rows under the "Information elements | P | ..." header, with merged condition rows folded into one row."""
    start = next((k for k, r in enumerate(rows) if norm(r[0]).startswith("informationelement")), None)
    if start is None:
        return []
    header = [norm(h) for h in rows[start]]

    def col(*keys: str, last: bool = False) -> int | None:
        found = [k for k, h in enumerate(header) if h in keys]
        return (found[-1] if last else found[0]) if found else None

    # Merged cells repeat a header across columns; a long condition can spill into the first "IE Type"
    # column, so the type and instance are read from the last column with their header.
    i_p = col("p", "presencerequirement")
    i_type = col("ietype", last=True)
    i_ins = col("ins", "instance", last=True)
    i_ref = col("reference")
    out: list[IeRow] = []
    for cells in rows[start + 1:]:
        name = strip_notes(cells[0].split("\n")[0] if v1 else cells[0])
        if not name or name.upper().startswith("NOTE") or len(set(cells)) == 1:
            continue
        presence_raw = flat(cells[i_p]) if i_p is not None else ""
        presence = PRESENCE_V1.get(presence_raw.lower(), presence_raw) if v1 else presence_raw
        ie_type = strip_notes(cells[i_type]) if i_type is not None else name
        instance = flat(cells[i_ins]) if i_ins is not None else None
        reference = flat(cells[i_ref]) if i_ref is not None else None
        last = out[-1] if out else None
        if last and not v1 and (last.name, last.ie_type, last.instance) == (name, ie_type, instance):
            if presence and presence not in last.presence:
                last.presence.append(presence)
            continue
        out.append(IeRow(name, ie_type, reference or None, [presence] if presence else [], instance))
    return out


def message_ie_tables(tables: list[DocTable], names: list[str], v1: bool) -> tuple[list[IeTable], list[str]]:
    """Every "Information Elements in <message>" table and the grouped IE tables "<group> within <message>"."""
    out: list[IeTable] = []
    skipped: list[str] = []
    for table in tables:
        parts = caption_parts(table.caption)
        if not parts:
            continue
        number, title = parts
        main = IE_TABLE.match(title)
        if main:
            message = message_named(main.group(1), names)
            if message is None:
                skipped.append(f"Table {number}: {title}")
                continue
            out.append(IeTable(number, title, table.clause or clause_of_table(number), message, ie_rows(table.rows, v1)))
            continue
        # "Bearer Context IE Type = 93 (decimal)"; one table prints "x" for the value.
        type_cell = next((m.group(1) for r in table.rows[:2] for c in r if (m := re.search(r"IE Type\s*=\s*(\w+)", c))), None)
        if type_cell is None:
            continue
        group_type = int(type_cell) if type_cell.isdigit() else None
        if title.endswith("Grouped Type"):
            continue  # the IE's own definition in clause 8 ("Bearer Context Grouped Type"), not a message's
        grouped = GROUP_TABLE.match(title)
        message, rest = (None, title)
        if grouped:
            message, rest = message_suffix(grouped.group(2), names)
            group_name = grouped.group(1)
            parent = rest or None
        else:
            group_name, parent = title, None
        if message is None:
            # "Table 7.3.2-2: Bearer Context": the message whose IE table sits in the same clause.
            message = next((t.message for t in out if t.clause == table.clause and t.group_name is None), None)
        if message is None:
            skipped.append(f"Table {number}: {title}")
            continue
        out.append(IeTable(number, title, table.clause or clause_of_table(number), message, ie_rows(table.rows, v1),
                           group_type=group_type, group_name=flat(group_name), parent=parent))
    return out, skipped


# --------------------------------------------------------------------------
# Resolving IE type names and attaching grouped IE tables


class IeIndex:
    """IE type text as message tables print it ("F-TEID", "ULI", "Recovery") to the IE type value."""

    def __init__(self, ies: list[IeTypeRow], aliases: dict[str, str]):
        self.ies = {ie.type: ie for ie in ies}
        self.keys: dict[str, int] = {}
        for ie in ies:
            for key in (ie.name, ie.abbrev, f"{ie.name} ({ie.abbrev})" if ie.abbrev else None):
                if key:
                    self.keys.setdefault(norm(key), ie.type)
        # "Recovery (Restart Counter)" is printed "Recovery" in message tables. A name shared without its
        # parenthetical ("MM Context (...)" for six IEs) names no single IE, so it gets no key.
        bare: dict[str, list[int]] = {}
        for ie in ies:
            stripped = norm(re.sub(r"\([^()]*\)", " ", ie.name))
            if stripped and stripped != norm(ie.name):
                bare.setdefault(stripped, []).append(ie.type)
        for key, values in bare.items():
            if len(values) == 1:
                self.keys.setdefault(key, values[0])
        self.aliases = {norm(k): norm(v) for k, v in aliases.items()}

    def resolve(self, text: str) -> int | None:
        candidates = [text, re.sub(r"\([^()]*\)", " ", text), *re.findall(r"\(([^()]+)\)", text)]
        for candidate in candidates:
            key = norm(candidate)
            key = self.aliases.get(key, key)
            if key in self.keys:
                return self.keys[key]
        return None

    def names(self, value: int) -> set[str]:
        ie = self.ies.get(value)
        return {norm(n) for n in (ie.name, ie.abbrev) if n} if ie else set()


def walk_rows(rows: list[IeRow]):
    for row in rows:
        yield row
        if row.group:
            yield from walk_rows(row.group.rows)


def attach_groups(tables: list[IeTable], index: IeIndex) -> tuple[list[IeTable], list[str]]:
    """The message IE tables, with each grouped IE table attached to the rows it details, and what found no row.

    A grouped table "<group> within <message>" details the rows of its message named like the group
    ("Bearer Contexts to be created"), else every row whose IE type is named like the group ("Overload
    Control Information"), else the one row of the table's IE type value. A table nested in another
    grouped IE ("Bearer Context within PDN Connections within Context Response") looks inside that IE first.
    """
    mains = [t for t in tables if t.group_name is None]
    unmatched: list[str] = []
    for table in tables:
        if table.group_name is None:
            continue
        message_rows = [row for main in mains if main.message == table.message for row in walk_rows(main.rows)]
        scope = message_rows
        if table.parent:
            inside = [row for parent in message_rows if parent.group and singular_norm(parent.name) == singular_norm(table.parent)
                      for row in walk_rows(parent.group.rows)]
            if not inside:
                inside = [row for parent in message_rows if parent.group for row in walk_rows(parent.group.rows)]
            scope = inside or message_rows
        free = [row for row in scope if row.group is None]
        wanted = singular_norm(table.group_name or "")
        matched = [row for row in free if singular_norm(row.name) == wanted]
        if not matched:
            matched = [row for row in free if norm(table.group_name or "") in index.names(index.resolve(row.ie_type) or -1)]
        if not matched and table.group_type is not None:
            typed = [row for row in free if index.resolve(row.ie_type) == table.group_type]
            matched = typed if len(typed) == 1 else []
        if not matched:
            unmatched.append(f"Table {table.number}: {table.title}")
        for row in matched:
            row.group = table
    return mains, unmatched


# --------------------------------------------------------------------------
# Dataset entities


# GTP versions: the id segment, the protocol entity in curated/protocols.yaml, and the spec that defines it.
VERSIONS = {
    "v2c": {"protocol": "proto/GTPv2-C", "doc": "TS 29.274"},
    "v1c": {"protocol": "proto/GTPv1-C", "doc": "TS 29.060"},
    "v1u": {"protocol": "proto/GTP-U", "doc": "TS 29.281"},
}


def msg_id(version: str, value: int) -> str:
    return f"gtp.msg/{version}/{value}"


def ie_id(version: str, value: int) -> str:
    return f"gtp.ie/{version}/{value}"


def cause_id(version: str, value: int) -> str:
    return f"gtp.cause/{version}/{value}"


def ext_id(version: str, value: int) -> str:
    return f"gtp.ext/{version}/{value}"


def reply_name(name: str, names: set[str]) -> str | None:
    """The message that answers `name`, by the naming the message type tables use.

    "X Request" is answered by "X Response", a "Response" that has one by its "Acknowledge" (Context
    Response, SGSN Context Response), "X Notification" by "X Notification Acknowledge" or "X Acknowledge",
    "X Command" by "X Failure Indication", and "X" by "X Acknowledge" (Forward Relocation Complete).
    """
    candidates: list[str] = []
    if name.endswith(" Request"):
        candidates.append(name.removesuffix(" Request") + " Response")
    if name.endswith(" Response"):
        candidates.append(name.removesuffix(" Response") + " Acknowledge")
    if name.endswith(" Notification"):
        candidates += [name + " Acknowledge", name.removesuffix(" Notification") + " Acknowledge"]
    if name.endswith(" Command"):
        candidates.append(name.removesuffix(" Command") + " Failure Indication")
    if not name.endswith((" Acknowledge", " Response", " Indication")):
        candidates.append(name + " Acknowledge")
    return next((c for c in candidates if c in names and c != name), None)


@dataclass
class VersionTables:
    """Everything one GTP version's specs give, before it becomes entities."""

    version: str
    messages: list[tuple[str, MessageRow]]  # (spec doc, row)
    ies: list[tuple[str, IeTypeRow]]
    causes: list[tuple[str, CauseRow]]
    ext: list[tuple[str, ExtHeaderRow]]
    tables: list[IeTable]  # main IE tables, with grouped tables attached
    table_docs: dict[int, str]  # id(IeTable) -> spec doc
    type_table_clause: dict[str, str | None]  # spec doc -> clause of its message type table
    ie_table_clause: dict[str, str | None]  # spec doc -> clause of its IE type table
    cause_table_clause: str | None
    ext_table_clause: str | None
    by_title: dict[str, dict[str, str]]  # spec doc -> normalized heading -> clause
    index: IeIndex
    scope_interfaces: list[str]  # interface names from the spec scope, for versions whose table names none


def scope_interfaces(lines: list[tuple[str, str | None]]) -> list[str]:
    """Interface names the clause 1 scope bullets list: '- the S1-U, S11-U, ... and Sn interfaces of the EPS'."""
    names: list[str] = []
    for text, clause in lines:
        if clause != "1" or not re.match(r"^-?\s*the ", text):
            continue
        listed = re.match(r"^-?\s*the (.+?) (?:signalling )?interfaces?\b", text)
        if not listed:
            continue
        for name in re.split(r",\s*|\s+and\s+", listed.group(1)):
            name = name.strip()
            if name and name not in names:
                names.append(name)
    return names


def read_v2(paths: dict[str, Path], config: dict, log: list[str]) -> VersionTables:
    t274, t280 = doc_tables(paths["29.274"]), doc_tables(paths["29.280"])
    lines274, lines280 = doc_lines(paths["29.274"]), doc_lines(paths["29.280"])
    type274 = find_table(t274, "Message types for GTPv2")
    type280 = find_table(t280, "Message types for Sv interface")
    unknown_nodes: list[str] = []
    messages = [("TS 29.274", m) for m in v2_message_types(type274, unknown_nodes)]
    messages += [("TS 29.280", m) for m in sv_message_types(type280)]
    if unknown_nodes:
        log.append(f"TS 29.274 Table 6.1-1 names nodes no flow maps: {sorted(set(unknown_nodes))}")
    ie274 = find_table(t274, "Information Element types for GTPv2")
    ie280 = find_table(t280, "Information Elements for SRVCC")
    # Each table lists the other spec's IEs by reference only; each IE comes from the spec that defines it.
    ies = [("TS 29.274", r) for r in v2_ie_types(ie274, skip_reference="29.280")]
    ies += [("TS 29.280", r) for r in v2_ie_types(ie280, skip_reference="29.274")]
    cause_table = find_table(t274, "Cause values")
    causes = [("TS 29.274", r) for r in v2_causes(cause_table)]
    index = IeIndex([r for _, r in ies], (config.get("ieTypeAliases") or {}).get("v2c") or {})
    tables: list[IeTable] = []
    table_docs: dict[int, str] = {}
    for doc, doc_t in (("TS 29.274", t274), ("TS 29.280", t280)):
        names = [m.name for d, m in messages if d == doc]
        found, skipped = message_ie_tables(doc_t, names, v1=False)
        mains, unmatched = attach_groups(found, index)
        for item in skipped + unmatched:
            log.append(f"{doc}: grouped IE table matched no message or row: {item}")
        for table in mains:
            table_docs[id(table)] = doc
        tables += mains
    return VersionTables(
        version="v2c", messages=messages, ies=ies, causes=causes, ext=[], tables=tables, table_docs=table_docs,
        type_table_clause={"TS 29.274": type274.clause, "TS 29.280": type280.clause},
        ie_table_clause={"TS 29.274": ie274.clause, "TS 29.280": ie280.clause},
        cause_table_clause=cause_table.clause, ext_table_clause=None,
        by_title={"TS 29.274": heading_index(lines274, "7"), "TS 29.280": heading_index(lines280, "5")},
        index=index, scope_interfaces=[],
    )


def read_v1(version: str, path: Path, config: dict, log: list[str]) -> VersionTables:
    doc = VERSIONS[version]["doc"]
    tables_doc = doc_tables(path)
    lines = doc_lines(path)
    # Messages are defined in clause 7 of both specs; extension headers in 29.281 §5.2.2 and 29.060 §6.1.
    by_title = heading_index(lines, "7")
    ext_titles = heading_index(lines, "5.2.2" if version == "v1u" else "6.1")
    plane = "GTP-U" if version == "v1u" else "GTP-C"
    type_table = find_table(tables_doc, "Messages in GTP-U" if version == "v1u" else "Messages in GTP")
    messages = [(doc, m) for m in v1_message_types(type_table, plane)]
    for _, m in messages:
        m.clause = m.clause or by_title.get(norm(m.name))
    ie_table = find_table(tables_doc, "Information Elements")
    ies = [(doc, r) for r in v1_ie_types(ie_table)]
    cause_table = find_table(tables_doc, "Cause Values") if version == "v1c" else None
    causes = [(doc, r) for r in v1_causes(cause_table)] if cause_table else []
    ext_table = find_table_by_header(tables_doc, "Next Extension Header Field Value")
    ext = [(doc, r) for r in ext_headers(ext_table, ext_titles, lines, {"29.060", "29.281"})]
    index = IeIndex([r for _, r in ies], (config.get("ieTypeAliases") or {}).get(version) or {})
    aliases = (config.get("messageTableAliases") or {}).get(version) or {}
    names = [m.name for _, m in messages]
    found, skipped = message_ie_tables(tables_doc, names + list(aliases), v1=True)
    for table in found:
        table.message = aliases.get(table.message, table.message)
    for item in skipped:
        log.append(f"{doc}: IE table matched no message: {item}")
    return VersionTables(
        version=version, messages=messages, ies=ies, causes=causes, ext=ext, tables=found,
        table_docs={id(t): doc for t in found},
        type_table_clause={doc: type_table.clause}, ie_table_clause={doc: ie_table.clause},
        cause_table_clause=cause_table.clause if cause_table else None, ext_table_clause=ext_table.clause,
        by_title={doc: by_title}, index=index, scope_interfaces=scope_interfaces(lines),
    )


def resolve_row(row: IeRow, data: VersionTables, by_clause: dict[str, int]) -> int | None:
    """The IE type value of a message table row: by its IE type name, else (GTPv1) by the clause it cites."""
    value = data.index.resolve(row.ie_type)
    if value is None and row.reference:
        cited = re.search(r"(\d+(?:\.\d+[A-Z]?)+)", row.reference)
        if cited:
            value = by_clause.get(cited.group(1))
    return value


def assemble_gtp(data: list[VersionTables], config: dict, ref, nfs_out: dict[str, dict],
                 interfaces_out: dict[str, dict], protocols_out: dict[str, dict], log: list[str]) -> dict[str, list[dict]]:
    """GTP message, IE, cause, and extension header entities, linked to protocols, interfaces, and NFs."""
    messages_out: dict[str, dict] = {}
    ies_out: dict[str, dict] = {}
    causes_out: dict[str, dict] = {}
    ext_out: dict[str, dict] = {}
    interface_config = config.get("interfaces") or {}
    comprehension = config.get("comprehension") or {}

    def interface_ids(names: list[str], where: str, aliases: dict[str, str] | None = None) -> list[str]:
        out = []
        for name in names:
            iid = f"if/{(aliases or {}).get(name, name)}"
            if iid in interfaces_out:
                if iid not in out:
                    out.append(iid)
            else:
                log.append(f"{where}: no interface entry for {name}")
        return out

    for d in data:
        version = d.version
        protocol = VERSIONS[version]["protocol"]
        if protocol not in protocols_out:
            raise SystemExit(f"protocols.yaml has no {protocol}")
        by_clause = {r.clause: r.type for _, r in d.ies if r.clause}
        ie_clauses = (config.get("ieClauses") or {}).get(version) or {}
        ie_aliases: dict[int, list[str]] = {}
        for alias, target in ((config.get("ieTypeAliases") or {}).get(version) or {}).items():
            value = d.index.resolve(target)
            if value is None:
                raise SystemExit(f"gtp.yaml ieTypeAliases.{version}: {target} names no IE")
            ie_aliases.setdefault(value, []).append(alias)

        # ---- IEs
        for doc, r in d.ies:
            iid = ie_id(version, r.type)
            if iid in ies_out:
                raise SystemExit(f"{doc}: IE type {r.type} defined twice")
            ies_out[iid] = {
                "id": iid, "kind": "gtpie", "protocol": protocol, "type": r.type, "name": r.name, "abbrev": r.abbrev,
                "aliases": ie_aliases.get(r.type, []),
                "encoding": r.encoding, "length": r.length, "fixedOctets": r.fixed_octets,
                "carriedIn": [], "description": None,
                "spec": [ref(doc, r.clause or ie_clauses.get(r.type) or d.ie_table_clause[doc])], "interfaces": [],
            }

        # ---- messages
        names = {m.name for _, m in d.messages}
        rows_by_name = {m.name: (doc, m) for doc, m in d.messages}
        replies = {m.name: reply_name(m.name, names) for _, m in d.messages}
        reply_to: dict[str, list[str]] = {}
        for name, reply in replies.items():
            if reply:
                reply_to.setdefault(reply, []).append(name)
        if version == "v2c":
            for name, reply in replies.items():
                if reply and not rows_by_name[reply][1].triggered:
                    raise SystemExit(f"Table 6.1-1 does not mark {reply}, the reply to {name}, as triggered")

        def depth(name: str) -> int:
            hops, current = 0, name
            while reply_to.get(current):
                current = reply_to[current][0]
                hops += 1
            return hops

        if version == "v1c":
            names_cfg = interface_config.get("v1c") or {}
            version_ifaces = interface_ids(names_cfg.get("names") or [], "gtp.yaml interfaces.v1c")
        elif version == "v1u":
            cfg = interface_config.get("v1u") or {}
            version_ifaces = interface_ids(d.scope_interfaces, "TS 29.281 §1", cfg.get("aliases") or {})
        else:
            version_ifaces = []
        excluded = ((interface_config.get(version) or {}).get("exclude") or {})

        tables_by_message: dict[str, list[IeTable]] = {}
        for table in d.tables:
            tables_by_message.setdefault(table.message, []).append(table)

        unresolved: dict[str, int] = {}

        def row_json(row: IeRow, doc: str, carrier: str) -> dict:
            value = resolve_row(row, d, by_clause)
            target = ie_id(version, value) if value is not None else None
            if target is not None and target not in ies_out:
                target = None
            if target is None:
                unresolved[row.ie_type] = unresolved.get(row.ie_type, 0) + 1
            elif carrier not in ies_out[target]["carriedIn"]:
                ies_out[target]["carriedIn"].append(carrier)
            out = {"ie": target, "name": row.name, "type": row.ie_type, "presence": row.presence, "instance": row.instance}
            out["group"] = table_json(row.group, doc, carrier) if row.group else None
            return out

        def table_json(table: IeTable, doc: str, carrier: str) -> dict:
            return {
                "title": table.title,
                "table": table.number,
                "spec": ref(doc, table.clause),
                "rows": [row_json(r, doc, carrier) for r in table.rows],
            }

        for doc, m in d.messages:
            mid = msg_id(version, m.type)
            if mid in messages_out:
                raise SystemExit(f"{doc}: message type {m.type} defined twice")
            tables = tables_by_message.get(m.name, [])
            clause = m.clause or d.by_title[doc].get(norm(m.name)) or next((t.clause for t in tables), None)
            if m.interfaces:
                ifaces = interface_ids(m.interfaces, f"{doc} {m.name}")
            else:
                ifaces = [i for i in version_ifaces if i.removeprefix("if/") not in (excluded.get(m.type) or [])]
            pairs = m.flow
            if not m.own_flow and depth(m.name) % 2 == 1:
                pairs = [(to, sender) for sender, to in pairs]
            senders = [f"nf/{n}" for pair in pairs for n in pair[0]]
            receivers = [f"nf/{n}" for pair in pairs for n in pair[1]]
            for nid in senders + receivers:
                if nid not in nfs_out:
                    raise SystemExit(f"{doc} {m.name}: no network function {nid}")
            flow = {"from": list(dict.fromkeys(senders)), "to": list(dict.fromkeys(receivers))} if pairs else None
            spec = [ref(doc, clause)] if clause else []
            spec.append(ref(doc, d.type_table_clause[doc]))
            messages_out[mid] = {
                "id": mid, "kind": "gtpmsg", "protocol": protocol, "type": m.type, "name": m.name,
                "initial": m.initial, "triggered": m.triggered,
                "reply": msg_id(version, rows_by_name[replies[m.name]][1].type) if replies[m.name] else None,
                "replyTo": [msg_id(version, rows_by_name[n][1].type) for n in reply_to.get(m.name, [])],
                "group": m.group, "flow": flow, "interfaces": ifaces,
                "ieTables": [table_json(t, d.table_docs[id(t)], mid) for t in tables],
                "description": None,
                "spec": [dict(s) for s in {(s["doc"], s.get("clause")): s for s in spec}.values()],
            }
            for iid in ifaces:
                interfaces_out[iid]["gtpMessages"].append(mid)
            protocols_out[protocol]["messages"].append(mid)
        if unresolved:
            log.append(f"{VERSIONS[version]['doc']}: IE types no IE type table row names: {sorted(unresolved.items())}")

        # ---- causes and extension headers
        for doc, c in d.causes:
            cid = cause_id(version, c.code)
            if cid in causes_out:
                raise SystemExit(f"{doc}: cause {c.code} defined twice")
            causes_out[cid] = {
                "id": cid, "kind": "gtpcause", "protocol": protocol, "code": c.code, "name": c.name,
                "category": c.category, "description": None, "spec": [ref(doc, d.cause_table_clause)], "interfaces": [],
            }
        for doc, e in d.ext:
            eid = ext_id(version, e.type)
            if eid in ext_out:
                raise SystemExit(f"{doc}: extension header type {e.type} defined twice")
            spec = [ref(doc, e.clause)] if e.clause else []
            spec.append(ref(doc, d.ext_table_clause))
            spec += [ref(f"TS {n}") for n in e.refs]
            ext_out[eid] = {
                "id": eid, "kind": "gtpext", "protocol": protocol, "type": e.type, "name": e.name,
                "comprehension": comprehension[e.type >> 6], "description": None, "spec": spec, "interfaces": [],
            }

    for ie in ies_out.values():
        carried = sorted(ie["carriedIn"], key=lambda m: messages_out[m]["type"])
        ie["carriedIn"] = carried
        ie["interfaces"] = sorted({i for m in carried for i in messages_out[m]["interfaces"]},
                                  key=lambda i: interfaces_out[i]["name"].lower())
    for item in interfaces_out.values():
        item["gtpMessages"].sort(key=lambda m: (m.split("/")[1] != "v2c", messages_out[m]["type"]))
    for proto in protocols_out.values():
        proto["messages"].sort(key=lambda m: messages_out[m]["type"])

    by_type = lambda items: sorted(items.values(), key=lambda e: (e["id"].split("/")[1], e.get("type", e.get("code"))))
    return {
        "gtpMessages": by_type(messages_out),
        "gtpIes": by_type(ies_out),
        "gtpCauses": by_type(causes_out),
        "gtpExtensions": by_type(ext_out),
    }
