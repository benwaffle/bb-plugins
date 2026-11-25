---
name: telecom-ref
description: "Look up 3GPP Rel-18 Diameter AVP and command codes, flag rules, message formats (ABNF), applications, GTPv2-C, GTPv1-C, and GTPv1-U message types, IE tables, IE types, cause values, extension headers, and header layouts, EPC/CUPS/IMS/5GC interfaces, network functions, 5GC SBI services (producer, consumers, operations), and protocols with the telecom_ref_lookup tool or bb telecom-ref, instead of recalling them from memory. Also reads the EPC, 5GC, interworking, IMS, and roaming architecture diagrams as text."
---

# Telecom reference

The telecom-ref plugin bundles a 3GPP Release 18 reference built from public
IANA, IETF, and 3GPP sources: every IANA and TS 29.230 Diameter application,
command, and AVP, every GTP message, IE type, cause value, and extension
header of TS 29.274 (GTPv2-C, with the Sv messages of TS 29.280), TS 29.060
(GTPv1-C), and TS 29.281 (GTPv1-U), plus EPC, CUPS, IMS, 5GC, and legacy
interfaces and network functions, the 5GC SBI services of TS 23.502 and related specs (producer,
consumers, operations, stage-2 and stage-3 clauses), and the protocols the
interfaces carry. Entries cross-link: AVP → commands that carry it →
application → interface → network functions, and protocol → interfaces,
service → producer, consumers, and the reference points it realizes.

Use it whenever a task needs an AVP or command code, a vendor ID, a data
type, M/V/P flag rules, the AVPs of a message, a GTP message type, IE type,
cause value, or extension header value, the IEs of a GTP message with their
presence (M, C, CO, O) and instance, a GTP header field, or which interface or
node uses something. Do not recall these from memory; codes, flag rules, and
IE instances are easy to get wrong. Cite the spec clause the result gives.

## Agent tool

`telecom_ref_lookup({ query, kind?, interface?, limit? })`

- `query`: an abbreviation (`ULR`, `F-TEID`), a name (`Subscription-Data`,
  `Create Session Request`, `PDU Session Container`), a code (`316`,
  `AVP 1400`, `0x85`), an interface (`S6a`), a network function (`HSS`), an
  SBI service (`Nnrf_NFDiscovery`), a protocol (`PFCP`, `GTPv2-C`), or an
  entity id (`diam.avp/10415/1400`, `gtp.msg/v2c/32`). A protocol name also
  matches the interfaces that carry it. A query may start with a GTP version
  (`gtpv2`, `gtpv2c`, `gtpv1c`, `gtpu`, `gtpv1u`) and then a kind word
  (`msg`, `ie`, `cause`, `ext`): `gtpv2 32`, `gtpv2 ie 87`,
  `gtpv2 cause 64`, `gtp-u ext 0x85`.
- `kind`: `cmd`, `avp`, `app`, `if`, `nf`, `svc` (SBI service), `proto`,
  `gtpmsg` (GTP message), `gtpie` (GTP IE type), `gtpcause` (GTP cause
  value), or `gtpext` (GTP extension header).
- `interface`: an interface name or id, such as `Gx` or `if/Gx`.
- `protocol`: a protocol name, alias, or id, such as `GTPv2-C`, `GTPv1-C`,
  `GTP-U` (or `GTPv1-U`), `v2c`, or `proto/GTPv2-C`. It keeps the protocol,
  its GTP entries, and the interfaces that carry it.
- `limit`: 1 to 20 matches, 5 by default.

When the query names one entry exactly, the result starts with its full
entry (children, parents, carrying commands, applications, interfaces, for
commands every application's message format, and for GTP messages every IE
table), then lists other matches. With `kind`, `interface`, or `protocol`
set, a single exact match within the filters gets its full entry too, so
`{ query: "87", kind: "gtpie", protocol: "GTPv2-C" }` prints F-TEID in full.

## CLI

```
bb telecom-ref search <query> [--kind cmd|avp|app|if|nf|svc|proto|gtpmsg|gtpie|gtpcause|gtpext] [--interface <name>] [--protocol <name>] [--limit 1-20] [--json]
bb telecom-ref show <id | exact key> [--json]
bb telecom-ref diagram list [--json]
bb telecom-ref diagram show <diagram id> [--json]
```

- `search` prints the best matches as markdown blocks with a fact line,
  summary, spec reference, and id. It exits 1 when nothing matches.
- `show` prints one entry with its cross-links. It fails with a hint when the
  key matches more than one entry; run `search` and pass the id.

## GTP

GTP entries come from the newest Rel-18 versions in the 3GPP archive:
TS 29.274 V18.8.0 (GTPv2-C), TS 29.280 V18.0.0 (Sv), TS 29.281 V18.4.0
(GTPv1-U), and TS 29.060 V18.0.0 (GTPv1-C). Every value is read from the
spec's own tables.

- Messages (`gtp.msg/<version>/<type>`): type value, the reply and what it
  replies to (Create Session Request → Response, Modify Bearer Command →
  Modify Bearer Failure Indication, Context Response → Context
  Acknowledge), the GTPv2-C Initial and Triggered marks, the interfaces, and
  the message IE tables. GTPv2-C messages take their interfaces and their
  sender and receiver from the group headings of TS 29.274 Table 6.1-1 (and
  its S3/S10/S16/N26 columns); the flow is end to end, so Create Session
  Request reads SGSN/MME/TWAN/ePDG → PGW, and the SGW in between is implied.
  GTPv1-U messages run on every interface TS 29.281 §1 lists (End Marker
  excepted on N19, §7.3.2.3); GTPv1-C messages on Gn and Gp.
- IE tables print one line per row: `name: IE type (value), presence,
  instance`. A grouped IE's table (Bearer Context to be created within Create
  Session Request) is nested under its row. GTPv2-C rows with several
  conditions show every presence they take (`C/CO`). TS 29.060 prints some
  messages in variants (SGSN-Initiated and GGSN-Initiated Update PDP Context
  Request); each variant is its own table. Rows of type `MM Context` name one
  of six IE types and link to none.
- IEs (`gtp.ie/<version>/<type>`): name and short name, Fixed, Variable, or
  Extendable, fixed octets, TV or TLV for GTPv1, defining clause, and the
  messages that carry them.
- Causes (`gtp.cause/<version>/<code>`): whether the value is sent in a
  request, or accepts or rejects one in a response. Reserved, spare, and
  "shall not be used" values are left out.
- Extension headers (`gtp.ext/<version>/<type>`, GTPv1-U and GTPv1-C): the
  type value (shown as `0x85`), the comprehension rule bits 8 and 7 give, and
  the specs the clause cites (TS 38.415 for the PDU Session Container).
- `show proto/GTPv2-C`, `proto/GTPv1-C`, or `proto/GTP-U` prints the header
  layout, field by field, with the clause, and lists the messages.
- Versions in ids: `v2c` is GTPv2-C (and Sv), `v1c` GTPv1-C, `v1u` GTPv1-U.
  Interfaces list their GTP messages under `GTP messages`.

Not covered: the octet layouts inside each IE, the condition text of IE
table rows (read the cited clause), and the S101/S121 messages of
TS 29.276.

## Architecture diagrams

The plugin draws the 3GPP reference architectures, each from the spec
figures it cites:

| Id | Diagram | Figures |
| --- | --- | --- |
| `epc-cups` / `epc` | EPC non-roaming, CUPS split or combined gateways, with PCC and untrusted non-3GPP access | TS 23.401 Fig 4.2.1-1, TS 23.214 Fig 4.2.1-1, TS 23.402 Fig 4.2.2-1 |
| `5gc-sba` / `5gc-rp` | 5GC non-roaming, service-based or reference points | TS 23.501 Fig 4.2.3-1, 4.2.3-2 |
| `interworking` | EPC and 5GC interworking (HSS + UDM, SMF + PGW-C, UPF + PGW-U, N26) | TS 23.501 Fig 4.3.1-1 |
| `ims` | IMS, and how the P-CSCF reaches the PCRF (Rx) or PCF (N5) | TS 23.228 Fig 4.0 |
| `epc-roaming-hr` / `epc-roaming-lbo` | EPC roaming, home routed (S8) or local breakout (S9) | TS 23.401 Fig 4.2.2-1, 4.2.2-2 |
| `5gc-roaming-hr` / `5gc-roaming-lbo` | 5GC roaming with vSEPP and hSEPP over N32 | TS 23.501 Fig 4.2.4-3, 4.2.4-1 |

`diagram show <id>` prints a diagram as an adjacency list: each box with
its network function ids, then each interface line as `label (interface
id, protocol, plane): end — end`, then the interfaces the cited figures
show that the diagram leaves out, with the reason. Use it to answer "what
connects to what" for a whole architecture; use `show` or the lookup tool
for one interface. When a lookup names one entry exactly, its result ends
with `Diagrams:` and the diagrams that draw it.

In bb the diagrams page is at `/plugins/telecom-ref/ref/diagram/<id>`, and
`/plugins/telecom-ref/ref/diagram/<id>/<entity id>` opens it with that
network function or interface picked, for example
`/plugins/telecom-ref/ref/diagram/interworking/if/N26`.

## Reading results

- Ids: `diam.app/<appId>`, `diam.cmd/<code>`, `diam.avp/<vendor>/<code>`
  (vendor 0 is IETF, 10415 is 3GPP), `if/<name>`, `nf/<name>`,
  `svc/<service>` (`svc/Nsmf_PDUSession`), `proto/<name>` (`proto/PFCP`),
  `gtp.msg/v2c/32`, `gtp.ie/v2c/87`, `gtp.cause/v2c/16`, `gtp.ext/v1u/133`.
- Flag rules read like `V M must · P must not`.
- ABNF lines use `< x >` fixed, `{ x }` required, `[ x ]` optional, with a
  `n*m` repetition prefix.
- Summaries are written for this reference and are not spec text. For
  normative detail, read the cited clause. Entries without a summary are
  stubs: code, vendor, type, flags, and spec reference only.
- Each entry also has a page in bb at `/plugins/telecom-ref/ref/<id>`; share
  that path when the user wants to browse.
