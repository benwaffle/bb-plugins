---
name: telecom-ref
description: "Look up 3GPP Rel-18 Diameter AVP and command codes, flag rules, message formats (ABNF), applications, EPC/5GC interfaces, and network functions with the telecom_ref_lookup tool or bb telecom-ref, instead of recalling them from memory."
---

# Telecom reference

The telecom-ref plugin bundles a 3GPP Release 18 reference built from public
IANA, IETF, and 3GPP sources: every IANA and TS 29.230 Diameter application,
command, and AVP, plus EPC, IMS, 5GC, and legacy interfaces and network
functions. Entries cross-link: AVP → commands that carry it → application →
interface → network functions.

Use it whenever a task needs an AVP or command code, a vendor ID, a data
type, M/V/P flag rules, the AVPs of a message, or which interface or node
uses something. Do not recall these from memory; codes and flag rules are
easy to get wrong. Cite the spec clause the result gives.

## Agent tool

`telecom_ref_lookup({ query, kind?, interface?, limit? })`

- `query`: an abbreviation (`ULR`), a name (`Subscription-Data`), a code
  (`316`, `AVP 1400`), an interface (`S6a`), a network function (`HSS`), or
  an entity id (`diam.avp/10415/1400`).
- `kind`: `cmd`, `avp`, `app`, `if`, or `nf`.
- `interface`: an interface name or id, such as `Gx` or `if/Gx`.
- `limit`: 1 to 20 matches, 5 by default.

When the query names one entry exactly, the result starts with its full
entry (children, parents, carrying commands, applications, interfaces, and
for commands every application's message format), then lists other matches.

## CLI

```
bb telecom-ref search <query> [--kind cmd|avp|app|if|nf] [--interface <name>] [--limit 1-20] [--json]
bb telecom-ref show <id | exact key> [--json]
```

- `search` prints the best matches as markdown blocks with a fact line,
  summary, spec reference, and id. It exits 1 when nothing matches.
- `show` prints one entry with its cross-links. It fails with a hint when the
  key matches more than one entry; run `search` and pass the id.

## Reading results

- Ids: `diam.app/<appId>`, `diam.cmd/<code>`, `diam.avp/<vendor>/<code>`
  (vendor 0 is IETF, 10415 is 3GPP), `if/<name>`, `nf/<name>`.
- Flag rules read like `V M must · P must not`.
- ABNF lines use `< x >` fixed, `{ x }` required, `[ x ]` optional, with a
  `n*m` repetition prefix.
- Summaries are written for this reference and are not spec text. For
  normative detail, read the cited clause. Entries without a summary are
  stubs: code, vendor, type, flags, and spec reference only.
- Each entry also has a page in bb at `/plugins/telecom-ref/ref/<id>`; share
  that path when the user wants to browse.
