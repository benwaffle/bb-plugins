import { useEffect, useState, type ReactNode } from "react";
import { experimental_Icon as Icon, experimental_usePluginId, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { entityCode, entityShortName, entityTitle, KIND_BADGES, vendorLabel, type Dataset } from "./dataset";
import { abnfLine, cardinality, codeLabel, specLabel } from "./format";
import type { AppEntity, AvpEntity, AvpFlags, AvpRef, CommandEntity, Entity, InterfaceEntity, NfEntity } from "./types";
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
      ["Diameter applications", entity.apps],
    ],
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
        <div key={entity.id} className={`mt-8 grid gap-x-12 gap-y-8 ${links.length > 0 ? "lg:grid-cols-[minmax(0,1fr)_16rem]" : ""}`}>
          <div className="min-w-0 space-y-8">{body.main}</div>
          {links.length > 0 ? (
            <aside aria-label="Related entries" className="space-y-6 lg:border-l lg:border-border lg:pl-8">
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
