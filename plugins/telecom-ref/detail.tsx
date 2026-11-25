import { useEffect, useState, type ReactNode } from "react";
import { experimental_Icon as Icon, experimental_usePluginId, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { entityCode, entityShortName, entityTitle, gtpLabel, hexByte, KIND_BADGES, vendorLabel, type Dataset } from "./dataset";
import { diagramPath, diagramsShowing, diagramSubPath } from "./diagrams";
import { abnfLine, cardinality, codeLabel, PANEL_PATH, specLabel } from "./format";
import type {
  AppEntity,
  AvpEntity,
  AvpFlags,
  AvpRef,
  CommandEntity,
  Entity,
  GtpCauseEntity,
  GtpExtensionHeaderEntity,
  GtpIeEntity,
  GtpIeRow,
  GtpIeTable,
  GtpMessageEntity,
  InterfaceEntity,
  NfEntity,
  ProtocolEntity,
  ServiceEntity,
} from "./types";
import { CodeBadge, EntityLink, KindBadge, SECTION_HEADING, SpecPill } from "./ui";
import { openSearch, rememberRecent } from "./view";

/** How many cross-links a group shows before "Show all". */
const GROUP_PREVIEW = 12;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2.5">
      <h2 className={SECTION_HEADING}>{title}</h2>
      {children}
    </section>
  );
}

/** Label/value rows; a null value leaves its row out. */
function Facts({ rows }: { rows: Array<[label: string, value: ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
      {rows
        .filter(([, value]) => value !== null)
        .map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 text-foreground">{value}</dd>
          </div>
        ))}
    </dl>
  );
}

const FLAG_RULES: Array<{ key: keyof AvpFlags; label: string; className: string }> = [
  { key: "must", label: "must", className: "text-foreground" },
  { key: "may", label: "may", className: "text-muted-foreground" },
  { key: "shouldNot", label: "should not", className: "text-muted-foreground" },
  { key: "mustNot", label: "must not", className: "text-muted-foreground line-through decoration-foreground/40" },
];

/** Each flag bit with its rule, "V must  M must  P must not". */
function FlagRules({ flags }: { flags: AvpFlags | null }) {
  if (!flags) return <span className="text-muted-foreground">—</span>;
  const bits = FLAG_RULES.flatMap((rule) => flags[rule.key].map((bit) => ({ bit, rule })));
  if (bits.length === 0) return <span className="text-muted-foreground">no flag rules</span>;
  return (
    <span className="flex flex-wrap gap-1.5">
      {bits.map(({ bit, rule }) => (
        <span key={bit} className="inline-flex h-5 items-center gap-1 rounded bg-foreground/[0.05] px-1.5 text-xs">
          <span className={`font-mono font-medium ${rule.className}`}>{bit}</span>
          <span className="text-muted-foreground">{rule.label}</span>
        </span>
      ))}
    </span>
  );
}

/** A titled list of cross-links in the side column; long lists collapse to the first few. */
function LinkGroup({ title, ids, dataset }: { title: string; ids: readonly string[]; dataset: Dataset }) {
  const [expanded, setExpanded] = useState(false);
  if (ids.length === 0) return null;
  const shown = expanded ? ids : ids.slice(0, GROUP_PREVIEW);
  return (
    <section className="space-y-1.5">
      <h2 className={`${SECTION_HEADING} flex items-baseline gap-1.5`}>
        {title}
        <span className="tabular-nums text-muted-foreground/70">{ids.length}</span>
      </h2>
      <ul className="-mx-2">
        {shown.map((id) => {
          const entity = dataset.byId.get(id);
          const code = entity ? codeLabel(entity) : null;
          return (
            <li key={id}>
              <EntityLink
                id={id}
                dataset={dataset}
                className="flex items-baseline gap-2 rounded-md px-2 py-1 text-sm text-foreground transition-colors duration-150 hover:bg-foreground/[0.05]"
              >
                <span className="min-w-0 flex-1 truncate">{entity ? entityShortName(entity) : id}</span>
                {code ? <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">{code}</span> : null}
              </EntityLink>
            </li>
          );
        })}
      </ul>
      {ids.length > GROUP_PREVIEW ? (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          {expanded ? "Show fewer" : `Show all ${ids.length}`}
        </button>
      ) : null}
    </section>
  );
}

/** The architecture diagrams that draw this entry, each opening with it picked. */
function DiagramLinks({ id }: { id: string }) {
  const pluginId = experimental_usePluginId();
  const navigate = useBbNavigate();
  const diagrams = diagramsShowing(id);
  if (diagrams.length === 0) return null;
  return (
    <section className="space-y-1.5">
      <h2 className={`${SECTION_HEADING} flex items-baseline gap-1.5`}>
        In diagrams
        <span className="tabular-nums text-muted-foreground/70">{diagrams.length}</span>
      </h2>
      <ul className="-mx-2">
        {diagrams.map((diagram) => (
          <li key={diagram.id}>
            <a
              href={diagramPath(pluginId, diagram.id, id)}
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
                event.preventDefault();
                navigate.toPluginPanel(PANEL_PATH, { subPath: diagramSubPath(diagram.id, id) });
              }}
              className="flex items-center gap-2 rounded-md px-2 py-1 text-sm text-foreground transition-colors duration-150 hover:bg-foreground/[0.05]"
            >
              <Icon name="Map" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{diagram.title}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">{diagram.variant}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Short entity links joined by a separator: "MME / SGSN". */
function InlineLinks({ ids, dataset, separator }: { ids: readonly string[]; dataset: Dataset; separator: string }) {
  return (
    <>
      {ids.map((id, index) => (
        <span key={id}>
          {index > 0 ? separator : ""}
          <EntityLink id={id} dataset={dataset} />
        </span>
      ))}
    </>
  );
}

function AbnfBlock({ refs, dataset }: { refs: readonly AvpRef[]; dataset: Dataset }) {
  return (
    <pre className="overflow-x-auto rounded-lg bg-foreground/[0.04] px-4 py-3 font-mono text-xs leading-5 text-foreground">
      {refs.map((ref, index) => {
        const target = ref.avp ? dataset.byId.get(ref.avp) : undefined;
        const [before, after] = abnfLine(ref).split(ref.name);
        return (
          <div key={`${ref.name}-${index}`}>
            <span className="text-muted-foreground">{before}</span>
            {target ? <EntityLink id={target.id} dataset={dataset}>{ref.name}</EntityLink> : ref.name}
            <span className="text-muted-foreground">{after}</span>
            {target?.kind === "avp" ? <span className="text-muted-foreground/70">{`  ; ${target.code}`}</span> : null}
          </div>
        );
      })}
    </pre>
  );
}

const TH = "py-1.5 pr-4 text-left text-xs font-normal text-muted-foreground";
const TD = "py-1.5 pr-4 align-baseline";

function ChildTable({ refs, dataset }: { refs: readonly AvpRef[]; dataset: Dataset }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border">
          <th className={`${TH} w-16`}>Code</th>
          <th className={TH}>AVP</th>
          <th className={TH}>Type</th>
          <th className={`${TH} pr-0 text-right`}>Card.</th>
        </tr>
      </thead>
      <tbody>
        {refs.map((child, index) => {
          const target = child.avp ? dataset.byId.get(child.avp) : undefined;
          const avp = target?.kind === "avp" ? target : null;
          return (
            <tr key={`${child.name}-${index}`} className="border-b border-border/50 last:border-b-0">
              <td className={`${TD} font-mono text-xs tabular-nums text-muted-foreground`}>{avp?.code ?? ""}</td>
              <td className={TD}>{avp ? <EntityLink id={avp.id} dataset={dataset}>{child.name}</EntityLink> : child.name}</td>
              <td className={`${TD} text-muted-foreground`}>{avp?.type ?? ""}</td>
              <td className={`${TD} pr-0 text-right font-mono text-xs whitespace-pre text-muted-foreground`}>{cardinality(child)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** The network functions at the ends of the given interfaces, each once. */
function endpointsOf(interfaceIds: readonly string[], dataset: Dataset): string[] {
  const ids = new Set<string>();
  for (const id of interfaceIds) {
    const item = dataset.byId.get(id);
    if (item?.kind === "if") for (const endpoint of item.endpoints) ids.add(endpoint);
  }
  return [...ids];
}

/** What a page shows: the facts and formats column, and the cross-link groups beside it. */
interface Body {
  main: ReactNode;
  links: Array<[title: string, ids: readonly string[]]>;
}

function avpBody(entity: AvpEntity, dataset: Dataset): Body {
  return {
    main: (
      <>
        <Facts
          rows={[
            ["Code", <span className="font-mono tabular-nums">{entity.code}</span>],
            ["Vendor", `${entity.vendor} (${vendorLabel(entity.vendor)})`],
            ["Type", entity.type ?? "—"],
            ["Flag rules", <FlagRules flags={entity.flags} />],
            ["May encrypt", entity.mayEncrypt === null ? null : entity.mayEncrypt ? "Yes" : "No"],
          ]}
        />
        {entity.children.length > 0 ? (
          <Section title={`Child AVPs · ${entity.children.length}`}>
            <ChildTable refs={entity.children} dataset={dataset} />
          </Section>
        ) : null}
      </>
    ),
    links: [
      ["Carried in", entity.carriedIn],
      ["Inside grouped AVPs", entity.parents],
      ["Used on", entity.interfaces],
      ["Terminated by", endpointsOf(entity.interfaces, dataset)],
      ["Applications", entity.apps],
    ],
  };
}

function messageName(part: { name: string; abbrev: string | null } | null): string {
  if (!part) return "—";
  return part.abbrev ? `${part.name} (${part.abbrev})` : part.name;
}

function commandBody(entity: CommandEntity, dataset: Dataset): Body {
  const flow = entity.flow?.request;
  return {
    main: (
      <>
        <Facts
          rows={[
            ["Code", <span className="font-mono tabular-nums">{entity.code}</span>],
            ["Request", messageName(entity.request)],
            ["Answer", messageName(entity.answer)],
            [
              "Request flow",
              flow ? (
                <span>
                  <InlineLinks ids={flow.from} dataset={dataset} separator=" / " />
                  <span className="text-muted-foreground">{" → "}</span>
                  <InlineLinks ids={flow.to} dataset={dataset} separator=" / " />
                </span>
              ) : null,
            ],
          ]}
        />
        {entity.formats.map((format) => {
          const app = dataset.byId.get(format.app);
          const bits = `${format.direction === "request" ? "R" : ""}${format.proxiable ? "P" : ""}`;
          return (
            <section key={`${format.app}-${format.direction}`} className="space-y-2.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <h2 className="text-sm font-medium text-foreground">{format.name}</h2>
                <span className="text-xs text-muted-foreground">
                  <EntityLink id={format.app} dataset={dataset}>
                    {app ? entityShortName(app) : format.app}
                  </EntityLink>
                  {bits ? ` · ${bits} bits` : ""}
                </span>
                <span className="ml-auto">
                  <SpecPill spec={format.spec} />
                </span>
              </div>
              <AbnfBlock refs={format.avps} dataset={dataset} />
            </section>
          );
        })}
        {entity.formats.length === 0 ? (
          <p className="text-sm text-muted-foreground">No message format in the Rel-{dataset.meta.release} sources this reference reads.</p>
        ) : null}
      </>
    ),
    links: [
      ["Used on", entity.interfaces],
      ["Sent by", flow?.from ?? []],
      ["Terminated by", flow?.to ?? []],
      ["Applications", entity.apps],
    ],
  };
}

function appBody(entity: AppEntity, dataset: Dataset): Body {
  return {
    main: (
      <>
        <Facts
          rows={[
            ["Application ID", <span className="font-mono tabular-nums">{entity.appId}</span>],
            ["Vendor", vendorLabel(entity.vendor)],
          ]}
        />
        <Section title={`Commands · ${entity.commands.length}`}>
          <table className="w-full text-sm">
            <tbody>
              {entity.commands.map((id) => {
                const command = dataset.byId.get(id);
                return (
                  <tr key={id} className="border-b border-border/50 last:border-b-0">
                    <td className={`${TD} w-16 font-mono text-xs tabular-nums text-muted-foreground`}>{command ? codeLabel(command) : ""}</td>
                    <td className={TD}>
                      <EntityLink id={id} dataset={dataset}>
                        {command ? entityTitle(command) : id}
                      </EntityLink>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Section>
      </>
    ),
    links: [
      ["Used on", entity.interfaces],
      ["Terminated by", endpointsOf(entity.interfaces, dataset)],
    ],
  };
}

function interfaceBody(entity: InterfaceEntity): Body {
  return {
    main: (
      <Facts
        rows={[
          ["Protocol", entity.protocol ?? "—"],
          ["Generation", entity.generations.join(", ") || "—"],
          ["Also called", entity.aliases.length > 0 ? entity.aliases.join(", ") : null],
        ]}
      />
    ),
    links: [
      ["Terminated by", entity.endpoints],
      ["Protocols", entity.protocols],
      ["Diameter applications", entity.apps],
      ["SBI services", entity.services],
      ["GTP messages", entity.gtpMessages],
    ],
  };
}

function serviceBody(entity: ServiceEntity, dataset: Dataset): Body {
  return {
    main: (
      <>
        <Facts
          rows={[
            ["Producer", <EntityLink id={entity.producer} dataset={dataset} />],
            ["Also called", entity.aliases.length > 0 ? entity.aliases.join(", ") : null],
          ]}
        />
        {entity.operations.length > 0 ? (
          <Section title={`Operations · ${entity.operations.length}`}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className={TH}>Operation</th>
                  <th className={TH}>Semantics</th>
                  <th className={`${TH} pr-0`}>Example consumers</th>
                </tr>
              </thead>
              <tbody>
                {entity.operations.map((operation) => (
                  <tr key={operation.name} className="border-b border-border/50 last:border-b-0">
                    <td className={`${TD} font-mono text-[13px]`}>{operation.name}</td>
                    <td className={`${TD} text-muted-foreground`}>{operation.semantics ?? "—"}</td>
                    <td className={`${TD} pr-0`}>
                      <InlineLinks ids={operation.consumers} dataset={dataset} separator=", " />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        ) : null}
      </>
    ),
    links: [
      ["Consumers", entity.consumers],
      ["Reference points", entity.interfaces],
    ],
  };
}

function protocolBody(entity: ProtocolEntity): Body {
  return {
    main: (
      <>
        <Facts
          rows={[
            ["Transport", entity.transport ?? "—"],
            ["Also called", entity.aliases.length > 0 ? entity.aliases.join(", ") : null],
          ]}
        />
        {entity.header ? (
          <section className="space-y-2.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h2 className={SECTION_HEADING}>Header</h2>
              <span className="ml-auto">
                <SpecPill spec={entity.header.spec} />
              </span>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className={`${TH} w-24`}>Octets</th>
                  <th className={`${TH} w-12`}>Bits</th>
                  <th className={TH}>Field</th>
                  <th className={`${TH} pr-0`}>Use</th>
                </tr>
              </thead>
              <tbody>
                {entity.header.fields.map((field) => (
                  <tr key={`${field.octets}-${field.bits ?? ""}-${field.name}`} className="border-b border-border/50 last:border-b-0">
                    <td className={`${TD} font-mono text-xs tabular-nums text-muted-foreground`}>{field.octets}</td>
                    <td className={`${TD} font-mono text-xs tabular-nums text-muted-foreground`}>{field.bits ?? ""}</td>
                    <td className={TD}>{field.name}</td>
                    <td className={`${TD} pr-0 text-muted-foreground`}>{field.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}
      </>
    ),
    links: [
      ["Interfaces", entity.interfaces],
      ["Messages", entity.messages],
      ["Runs over", entity.over],
      ["Carries", entity.carries],
    ],
  };
}

/** The rows of a GTP IE table, each grouped IE's rows indented under it. */
function IeRows({ rows, dataset, depth }: { rows: readonly GtpIeRow[]; dataset: Dataset; depth: number }) {
  return (
    <>
      {rows.map((row, index) => {
        const ie = row.ie ? dataset.byId.get(row.ie) : undefined;
        return (
          <IeRowGroup key={`${row.name}-${row.instance ?? ""}-${index}`} row={row} dataset={dataset} depth={depth}>
            <tr className="border-b border-border/50 last:border-b-0">
              <td className={TD} style={{ paddingLeft: `${depth * 1.25}rem` }}>
                {row.name}
              </td>
              <td className={TD}>
                {ie?.kind === "gtpie" ? <EntityLink id={ie.id} dataset={dataset}>{row.type}</EntityLink> : row.type}
                {ie?.kind === "gtpie" ? <span className="text-muted-foreground/70">{`  ${ie.type}`}</span> : null}
              </td>
              <td className={`${TD} font-mono text-xs text-muted-foreground`}>{row.presence.join(" ")}</td>
              <td className={`${TD} pr-0 text-right font-mono text-xs tabular-nums text-muted-foreground`}>{row.instance ?? ""}</td>
            </tr>
          </IeRowGroup>
        );
      })}
    </>
  );
}

function IeRowGroup({ row, dataset, depth, children }: { row: GtpIeRow; dataset: Dataset; depth: number; children: ReactNode }) {
  return (
    <>
      {children}
      {row.group ? (
        <>
          <tr>
            <td colSpan={4} className="pt-2 pb-1 text-xs text-muted-foreground" style={{ paddingLeft: `${(depth + 1) * 1.25}rem` }}>
              {`${row.group.title} · Table ${row.group.table}`}
            </td>
          </tr>
          <IeRows rows={row.group.rows} dataset={dataset} depth={depth + 1} />
        </>
      ) : null}
    </>
  );
}

function IeTableSection({ table, dataset }: { table: GtpIeTable; dataset: Dataset }) {
  return (
    <section className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h2 className="text-sm font-medium text-foreground">{table.title}</h2>
        <span className="text-xs text-muted-foreground">Table {table.table}</span>
        <span className="ml-auto">
          <SpecPill spec={table.spec} />
        </span>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className={TH}>Information element</th>
            <th className={TH}>IE type</th>
            <th className={`${TH} w-16`}>P</th>
            <th className={`${TH} w-12 pr-0 text-right`}>Ins.</th>
          </tr>
        </thead>
        <tbody>
          <IeRows rows={table.rows} dataset={dataset} depth={0} />
        </tbody>
      </table>
    </section>
  );
}

function versionLink(protocol: string, id: string, dataset: Dataset): ReactNode {
  return <EntityLink id={protocol} dataset={dataset}>{gtpLabel(id) ?? protocol}</EntityLink>;
}

function gtpMessageBody(entity: GtpMessageEntity, dataset: Dataset): Body {
  const roles = [entity.initial ? "Initial" : null, entity.triggered ? "Triggered" : null].filter(Boolean).join(", ");
  return {
    main: (
      <>
        <Facts
          rows={[
            ["Message type", <span className="font-mono tabular-nums">{entity.type}</span>],
            ["Protocol", versionLink(entity.protocol, entity.id, dataset)],
            ["Role", roles || null],
            ["Reply", entity.reply ? <EntityLink id={entity.reply} dataset={dataset} /> : null],
            ["Replies to", entity.replyTo.length > 0 ? <InlineLinks ids={entity.replyTo} dataset={dataset} separator=", " /> : null],
            [
              "Flow",
              entity.flow ? (
                <span>
                  <InlineLinks ids={entity.flow.from} dataset={dataset} separator=" / " />
                  <span className="text-muted-foreground">{" → "}</span>
                  <InlineLinks ids={entity.flow.to} dataset={dataset} separator=" / " />
                </span>
              ) : null,
            ],
            ["Type table group", entity.group],
          ]}
        />
        {entity.ieTables.map((table) => (
          <IeTableSection key={table.table} table={table} dataset={dataset} />
        ))}
        {entity.ieTables.length === 0 ? <p className="text-sm text-muted-foreground">The spec gives this message no IE table.</p> : null}
      </>
    ),
    links: [
      ["Used on", entity.interfaces],
      ["Sent by", entity.flow?.from ?? []],
      ["Received by", entity.flow?.to ?? []],
    ],
  };
}

function gtpIeBody(entity: GtpIeEntity, dataset: Dataset): Body {
  return {
    main: (
      <Facts
        rows={[
          ["IE type", <span className="font-mono tabular-nums">{entity.type}</span>],
          ["Protocol", versionLink(entity.protocol, entity.id, dataset)],
          ["Short name", entity.abbrev],
          ["Also called", entity.aliases.length > 0 ? entity.aliases.join(", ") : null],
          ["Encoding", entity.encoding],
          ["Length", entity.length],
          ["Fixed octets", entity.fixedOctets],
        ]}
      />
    ),
    links: [
      ["Carried in", entity.carriedIn],
      ["Used on", entity.interfaces],
    ],
  };
}

const CAUSE_CATEGORIES: Record<GtpCauseEntity["category"], string> = {
  request: "Request or initial message",
  acceptance: "Acceptance in a response or triggered message",
  rejection: "Rejection in a response or triggered message",
};

function gtpCauseBody(entity: GtpCauseEntity, dataset: Dataset): Body {
  return {
    main: (
      <Facts
        rows={[
          ["Cause value", <span className="font-mono tabular-nums">{entity.code}</span>],
          ["Protocol", versionLink(entity.protocol, entity.id, dataset)],
          ["Used in", CAUSE_CATEGORIES[entity.category]],
        ]}
      />
    ),
    links: [],
  };
}

function gtpExtensionBody(entity: GtpExtensionHeaderEntity, dataset: Dataset): Body {
  return {
    main: (
      <Facts
        rows={[
          ["Type value", <span className="font-mono tabular-nums">{`${hexByte(entity.type)} (${entity.type})`}</span>],
          ["Protocol", versionLink(entity.protocol, entity.id, dataset)],
          ["Comprehension", entity.comprehension],
        ]}
      />
    ),
    links: [],
  };
}

function nfBody(entity: NfEntity, dataset: Dataset): Body {
  return {
    main: (
      <>
        <Facts
          rows={[
            ["Generation", entity.generations.join(", ") || "—"],
            ["Also called", entity.aliases.length > 0 ? entity.aliases.join(", ") : null],
          ]}
        />
        <Section title={`Interfaces · ${entity.interfaces.length}`}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className={TH}>Interface</th>
                <th className={TH}>Peer</th>
                <th className={`${TH} pr-0`}>Protocol</th>
              </tr>
            </thead>
            <tbody>
              {entity.interfaces.map((id) => {
                const item = dataset.byId.get(id);
                const peers = item?.kind === "if" ? item.endpoints.filter((endpoint) => endpoint !== entity.id) : [];
                return (
                  <tr key={id} className="border-b border-border/50 last:border-b-0">
                    <td className={TD}>
                      <EntityLink id={id} dataset={dataset} />
                    </td>
                    <td className={TD}>
                      <InlineLinks ids={peers} dataset={dataset} separator=", " />
                    </td>
                    <td className={`${TD} pr-0 text-muted-foreground`}>{item?.kind === "if" ? item.protocol : null}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Section>
      </>
    ),
    links: [
      ["Produces", entity.services],
      ["Takes over from", entity.replaces],
      ["Taken over by", entity.replacedBy],
    ],
  };
}

function entityBody(entity: Entity, dataset: Dataset): Body {
  switch (entity.kind) {
    case "avp":
      return avpBody(entity, dataset);
    case "cmd":
      return commandBody(entity, dataset);
    case "app":
      return appBody(entity, dataset);
    case "if":
      return interfaceBody(entity);
    case "nf":
      return nfBody(entity, dataset);
    case "svc":
      return serviceBody(entity, dataset);
    case "proto":
      return protocolBody(entity);
    case "gtpmsg":
      return gtpMessageBody(entity, dataset);
    case "gtpie":
      return gtpIeBody(entity, dataset);
    case "gtpcause":
      return gtpCauseBody(entity, dataset);
    case "gtpext":
      return gtpExtensionBody(entity, dataset);
  }
}

/** A one-line citation for the clipboard: "AVP Subscription-Data (1400 · vendor 10415), TS 29.272 §7.3.2". */
function citation(entity: Entity): string {
  const code = entityCode(entity);
  const spec = entity.spec[0] ? `, ${specLabel(entity.spec[0])}` : "";
  return `${KIND_BADGES[entity.kind]} ${entityTitle(entity)}${code ? ` (${code})` : ""}${spec}`;
}

const GHOST_BUTTON =
  "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-[background-color,color,transform] duration-150 hover:bg-foreground/[0.05] hover:text-foreground active:scale-[0.97]";

export function DetailPage({ dataset, id }: { dataset: Dataset; id: string }) {
  const pluginId = experimental_usePluginId();
  const navigate = useBbNavigate();
  const entity = dataset.byId.get(id);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (entity) rememberRecent(pluginId, entity.id);
    setCopied(false);
  }, [entity, pluginId]);

  const backToSearch = (
    <button type="button" className={`${GHOST_BUTTON} -ml-2`} onClick={() => openSearch(navigate)}>
      <Icon name="ArrowLeft" className="size-3.5" aria-hidden />
      Results
    </button>
  );
  if (!entity) {
    return (
      <div className="px-4 py-6 md:px-6">
        <div className="mx-auto w-full max-w-5xl space-y-3">
          {backToSearch}
          <p className="text-sm font-medium text-foreground">No entry has the id {id}</p>
          <p className="text-[13px] text-muted-foreground">The link may point at an entry a newer dataset renamed. Search for it by name instead.</p>
        </div>
      </div>
    );
  }
  const copy = () => {
    void navigator.clipboard.writeText(citation(entity)).then(() => setCopied(true));
  };
  const body = entityBody(entity, dataset);
  const links = body.links.filter(([, ids]) => ids.length > 0);
  const inDiagrams = diagramsShowing(entity.id).length > 0;
  return (
    <div className="h-full overflow-y-auto px-4 py-6 md:px-6">
      <article className="mx-auto w-full max-w-5xl">
        <header>
          <div className="flex items-center justify-between">
            {backToSearch}
            <button type="button" onClick={copy} className={GHOST_BUTTON}>
              <Icon name={copied ? "Check" : "Copy"} className="size-3.5" aria-hidden />
              {copied ? "Copied" : "Copy reference"}
            </button>
          </div>
          <div className="mt-4 flex items-center gap-1.5">
            <KindBadge kind={entity.kind} />
            <CodeBadge entity={entity} />
          </div>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-balance text-foreground">{entityTitle(entity)}</h1>
          {entity.spec.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {entity.spec.map((spec) => (
                <SpecPill key={`${spec.doc}-${spec.clause ?? ""}`} spec={spec} />
              ))}
            </div>
          ) : null}
          {entity.description ? (
            <p className="mt-4 max-w-[68ch] text-[15px] leading-7 text-foreground">{entity.description}</p>
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">No summary yet. The spec references above define this entry.</p>
          )}
        </header>
        <div key={entity.id} className={`mt-8 grid gap-x-12 gap-y-8 ${links.length > 0 || inDiagrams ? "lg:grid-cols-[minmax(0,1fr)_16rem]" : ""}`}>
          <div className="min-w-0 space-y-8">{body.main}</div>
          {links.length > 0 || inDiagrams ? (
            <aside aria-label="Related entries" className="space-y-6 lg:border-l lg:border-border lg:pl-8">
              <DiagramLinks id={entity.id} />
              {links.map(([title, ids]) => (
                <LinkGroup key={title} title={title} ids={ids} dataset={dataset} />
              ))}
            </aside>
          ) : null}
        </div>
        <footer className="mt-10 border-t border-border pt-3 text-xs text-muted-foreground">
          Rel-{dataset.meta.release}. {dataset.meta.notice}
        </footer>
      </article>
    </div>
  );
}
