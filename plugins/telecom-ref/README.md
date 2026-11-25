# Telecom reference

A searchable 3GPP Release 18 reference inside bb: Diameter applications,
commands, and AVPs, GTPv2-C, GTPv1-C, and GTPv1-U messages, IEs, cause
values, and extension headers, EPC, CUPS, IMS, and 5GC reference points,
network functions, 5GC SBI services, and protocols, all cross-linked. An AVP page links to the commands that carry it, the grouped
AVPs that contain it, its applications, their interfaces, and the network
functions at each end. Every entry cites the spec clause that defines it.

All data comes from public IANA, IETF, and 3GPP material. Descriptions are
summaries written for this reference, not specification text; the cited
clause stays the normative definition.

## Install

```sh
bb plugin install git:https://github.com/benwaffle/bb-plugins.git@main --plugin telecom-ref
```

From a local checkout:

```sh
bb plugin install path:. --plugin telecom-ref
```

## Use

- **Telecom reference** in the navigation opens the search page. Type an
  abbreviation (`ULR`), a name (`Subscription-Data`), a code (`316`,
  `AVP 1400`), an interface (`S6a`, `Sxb`), a network function (`HSS`), an SBI service
  (`Nsmf_PDUSession`), a protocol (`PFCP`, which also lists the interfaces
  that carry it), or a GTP message, IE, cause, or extension header
  (`Create Session Request`, `F-TEID`, `gtpv2 32`, `0x85`). Arrow keys
  move through the results and Enter opens one. Search runs in the page
  against a prebuilt index, so it needs no server round trip.
- The sidebar filters results by type and by interface and lists recently
  viewed entries.
- Each entry has its own page at `/plugins/telecom-ref/ref/<id>`, for example
  `/plugins/telecom-ref/ref/diam.avp/10415/1400`, so back and forward walk the
  cross-links. **Copy ref** copies a one-line citation.
- **Architecture diagrams** (the button on the search page, the sidebar, or
  the palette) draws the EPC (CUPS split or combined gateways, with PCC and
  untrusted non-3GPP access), the 5GC in service-based and reference point
  form, EPC/5GC interworking, the IMS, and EPC and 5GC roaming, each laid
  out after the 3GPP figure it cites. Every box and interface line is a
  button: hovering or focusing one lights it and what it connects to, and
  picking one shows its entry beside the diagram. Ctrl or Cmd with the wheel
  zooms, a drag pans, and + - 0 work from the keyboard. Each entry's page
  lists the diagrams that draw it.
- The command palette (Mod+Shift+P) has **Telecom reference: search…**
  (default shortcut Mod+Alt+K) and **Telecom reference: look up selected
  text**.
- Agents get the `telecom_ref_lookup` tool and the `bb telecom-ref` CLI; see
  [skills/telecom-ref/SKILL.md](skills/telecom-ref/SKILL.md).

## What is covered

| Kind | Source | Depth |
| --- | --- | --- |
| Diameter applications | IANA application IDs, TS 29.230 | All, with summaries for the in-scope applications |
| Diameter commands | IANA command codes, TS 29.230, RFC command tables | All; message formats (ABNF) where a Rel-18 spec or RFC prints one |
| Diameter AVPs | IANA AVP codes and RADIUS types (vendor 0), TS 29.230 (vendor 10415) | All, with type and flag rules where the defining spec's table gives them |
| Interfaces | Curated from TS 23.002, 23.401, 23.501, 23.228 | EPC, IMS, 5GC, and legacy 2G/3G reference points |
| Network functions | Curated from the same architecture specs | EPC, IMS, 5GC, and legacy nodes, with 4G to 5G succession |
| GTPv2-C | TS 29.274 V18.8.0, Sv messages TS 29.280 V18.0.0 | All message types with reply pairing, interfaces, and IE tables (presence, instance, grouped IEs); all IE types; all cause values; the header |
| GTPv1-C | TS 29.060 V18.0.0 | All GTP-C message types with IE tables; all IE types, cause values, and extension headers; the header |
| GTPv1-U | TS 29.281 V18.4.0 | All message types with IE tables, IE types, and extension headers; the header; UDP port 2152 and the interfaces of §1 |

Every AVP that the in-scope applications carry, directly or inside a grouped
AVP, has a summary: S6a/S6d and S13 (TS 29.272), Cx/Dx (TS 29.229), Sh
(TS 29.329), Gx (TS 29.212), Rx (TS 29.214), SLh (TS 29.173), SLg
(TS 29.172), the SMS applications S6c and SGd/Gdd (TS 29.338), the MTC
applications S6m/S6n and S6t (TS 29.336), Tsp (TS 29.368), T4 (TS 29.337),
and T6a/T6b (TS 29.128), and the Diameter base protocol (RFC 6733) with credit
control (RFC 8506). Every command of these applications has a summary too.
Other AVPs are stubs with code, vendor, type, flag rules, and spec reference.

TS 29.230 and TS 29.336 disagree on AVP codes 3176 and 3177; the reference
follows TS 29.230, the code registry, and notes the difference.

GTP values come from the spec tables themselves: message type tables, IE
type tables, cause tables, the extension header type figures, and every
"Information Elements in ..." table. GTPv2-C interfaces, senders, and
receivers follow the groups of TS 29.274 Table 6.1-1, which name a message's
ends end to end: Create Session Request reads SGSN/MME/TWAN/ePDG to PGW, and
the SGW that relays it is not named. TS 29.281 §1 also lists W1-U, N3mb, and N19mb, which this
reference has no interface entries for yet. Message IE tables give the IE
type, presence, and instance but not the condition text, and no IE has its
octet layout.

Known gaps: TS 32.299 ships as a Word 97 file whose AVP tables do not convert,
so its charging AVPs have types (from TS 29.230) but no flag rules. Some IETF
AVPs from RFCs without a flag table have no flag rules either.

## Rebuilding the data

The JSON under `data/` is generated and committed, so building the plugin
needs no network access. To regenerate it (macOS, for `textutil`):

```sh
npm run data            # uv run data/build.py
```

`data/build.py` downloads the IANA registries, the RFCs, and the Rel-18 spec
archives into `data/.cache/` (ignored by git), the GTP specs from the
3GPP archive's newest Rel-18 version, parses the spec tables and
ABNF, merges the curated YAML in `data/curated/`, computes the reverse
cross-links and the search index, writes `data/*.json`, and runs the dataset
validator in `dataset.test.ts`, which fails on any dangling cross-link.
`--offline` rebuilds from the cache.

## Diagrams

Each diagram is a JSON file in `diagrams/` (format in `diagram-types.ts`):
boxes name dataset network functions (several for a combined node such as
SMF + PGW-C) at fixed positions, and lines name dataset interfaces. One
component, `diagram-canvas.tsx`, renders them all as SVG in the active bb
theme's colours. `diagrams.test.ts` fails when a diagram names an id the
dataset lacks, draws a line whose ends are not endpoints the dataset
records for that interface, or leaves out an interface a cited figure shows
without a reason; it also fails on overlapping boxes, labels that cover a
box, a label, or a line, and lines through boxes. `data/coverage.py` lists
what the diagrams draw in `data/COVERAGE.md`.

To look at them, `DIAGRAM_OUT=<dir> npm run diagrams:render` writes a light
and a dark PNG of every diagram with headless Chrome (`CHROME` overrides the
path) and the layout check's findings to `<dir>/layout.txt`;
`DIAGRAM_ONLY=epc,ims` limits it to some diagrams.

The curated files:

- `curated/apps.yaml`: application summaries, and which spec clauses print
  which application's command formats when the ABNF header leaves the
  application ID out.
- `curated/interfaces.yaml`, `curated/nfs.yaml`: interfaces and network
  functions.
- `curated/descriptions/*.yaml`: AVP and command summaries keyed by
  `vendor/code` and command code.
- `curated/aliases.yaml`: AVP names that spec ABNF spells differently from
  the registry.
- `curated/gtp.yaml`: GTP header layouts, IE names that message tables spell
  differently from the IE type table, and the interfaces of GTPv1 messages.
  `data/gtp.py` reads the GTP tables.
