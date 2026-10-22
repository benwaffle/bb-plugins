# Telecom reference

A searchable 3GPP Release 18 reference inside bb: Diameter applications,
commands, and AVPs, EPC and 5GC interfaces, and network functions, all
cross-linked. An AVP page links to the commands that carry it, the grouped
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
  `AVP 1400`), an interface (`S6a`), or a network function (`HSS`). Arrow keys
  move through the results and Enter opens one. Search runs in the page
  against a prebuilt index, so it needs no server round trip.
- The sidebar filters results by type and by interface and lists recently
  viewed entries.
- Each entry has its own page at `/plugins/telecom-ref/ref/<id>`, for example
  `/plugins/telecom-ref/ref/diam.avp/10415/1400`, so back and forward walk the
  cross-links. **Copy ref** copies a one-line citation.
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

Every AVP that the in-scope applications carry, directly or inside a grouped
AVP, has a summary: S6a/S6d and S13 (TS 29.272), Cx/Dx (TS 29.229), Sh
(TS 29.329), Gx (TS 29.212), Rx (TS 29.214), SLh (TS 29.173), SLg
(TS 29.172), and the Diameter base protocol (RFC 6733) with credit control
(RFC 8506). Other AVPs are stubs with code, vendor, type, flag rules, and
spec reference.

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
archives into `data/.cache/` (ignored by git), parses the spec tables and
ABNF, merges the curated YAML in `data/curated/`, computes the reverse
cross-links and the search index, writes `data/*.json`, and runs the dataset
validator in `dataset.test.ts`, which fails on any dangling cross-link.
`--offline` rebuilds from the cache.

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
