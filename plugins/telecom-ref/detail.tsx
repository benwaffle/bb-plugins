import { useEffect, useState, type ReactNode } from "react";
import { experimental_usePluginId, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { entityCode, entityShortName, entityTitle, KIND_BADGES, vendorLabel, type Dataset } from "./dataset";
import { abnfLine, cardinality, factLine, flagsLabel, specLabel } from "./format";
import type { AppEntity, AvpEntity, AvpRef, CommandEntity, Entity, InterfaceEntity, NfEntity } from "./types";
import { EntityLink, KindBadge, SECTION_HEADING, SpecChip } from "./ui";
import { openSearch, rememberRecent } from "./view";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className={SECTION_HEADING}>{title}</h2>
      {children}
    </section>
  );
}

/** Label/value rows; a null value leaves its row out. */
function Facts({ rows }: { rows: Array<[label: string, value: ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
      {rows
        .filter(([, value]) => value !== null)
        .map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
    </dl>
  );
}

/** Entities as a list of badge + title links, each with an optional detail line. */
function LinkList({ ids, dataset, detail }: { ids: readonly string[]; dataset: Dataset; detail?: (entity: Entity) => ReactNode }) {
  if (ids.length === 0) return <p className="text-sm text-muted-foreground">None.</p>;
  return (
    <ul className="space-y-1 text-sm">
      {ids.map((id) => {
        const entity = dataset.byId.get(id);
        return (
          <li key={id} className="flex items-baseline gap-2">
            {entity ? <KindBadge kind={entity.kind} /> : null}
            <EntityLink id={id} dataset={dataset}>
              {entity ? entityTitle(entity) : id}
            </EntityLink>
            {entity && detail ? <span className="text-xs text-muted-foreground">{detail(entity)}</span> : null}
          </li>
        );
      })}
    </ul>
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
    <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs leading-5">
      {refs.map((ref, index) => {
        const target = ref.avp ? dataset.byId.get(ref.avp) : undefined;
        const [before, after] = abnfLine(ref).split(ref.name);
        return (
          <div key={`${ref.name}-${index}`}>
            {before}
            {target ? <EntityLink id={target.id} dataset={dataset}>{ref.name}</EntityLink> : ref.name}
            {after}
            {target?.kind === "avp" ? <span className="text-muted-foreground">{`  ; ${target.code}`}</span> : null}
          </div>
        );
      })}
    </pre>
  );
}

const interfaceDetail = (dataset: Dataset) => (entity: Entity) => factLine(entity, dataset);
const codeDetail = (entity: Entity) => entityCode(entity);

function ChildTable({ refs, dataset }: { refs: readonly AvpRef[]; dataset: Dataset }) {
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs text-muted-foreground">
        <tr>
          <th className="py-1 pr-3 font-normal">Code</th>
          <th className="py-1 pr-3 font-normal">AVP</th>
          <th className="py-1 pr-3 font-normal">Type</th>
          <th className="py-1 font-normal">Card.</th>
        </tr>
      </thead>
      <tbody>
        {refs.map((child, index) => {
          const target = child.avp ? dataset.byId.get(child.avp) : undefined;
          const avp = target?.kind === "avp" ? target : null;
          return (
            <tr key={`${child.name}-${index}`} className="border-t border-border">
              <td className="py-1 pr-3 font-mono text-xs text-muted-foreground">{avp?.code ?? ""}</td>
              <td className="py-1 pr-3">{avp ? <EntityLink id={avp.id} dataset={dataset}>{child.name}</EntityLink> : child.name}</td>
              <td className="py-1 pr-3 text-muted-foreground">{avp?.type ?? ""}</td>
              <td className="py-1 font-mono text-xs">{cardinality(child)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function AvpBody({ entity, dataset }: { entity: AvpEntity; dataset: Dataset }) {
  return (
    <>
      <Facts
        rows={[
          ["Code", entity.code],
          ["Vendor", `${entity.vendor} (${vendorLabel(entity.vendor)})`],
          ["Type", entity.type ?? "—"],
          ["Flag rules", flagsLabel(entity.flags) ?? "—"],
          ["May encrypt", entity.mayEncrypt === null ? null : entity.mayEncrypt ? "yes" : "no"],
        ]}
      />
      {entity.children.length > 0 ? (
        <Section title={`Child AVPs (${entity.children.length})`}>
          <ChildTable refs={entity.children} dataset={dataset} />
        </Section>
      ) : null}
      <Section title={`Carried in (${entity.carriedIn.length})`}>
        <LinkList ids={entity.carriedIn} dataset={dataset} detail={codeDetail} />
      </Section>
      {entity.parents.length > 0 ? (
        <Section title={`Inside grouped AVPs (${entity.parents.length})`}>
          <LinkList ids={entity.parents} dataset={dataset} detail={codeDetail} />
        </Section>
      ) : null}
      <Section title="Applications">
        <LinkList ids={entity.apps} dataset={dataset} />
      </Section>
      <Section title="Interfaces">
        <LinkList ids={entity.interfaces} dataset={dataset} detail={interfaceDetail(dataset)} />
      </Section>
    </>
  );
}

function messageName(part: { name: string; abbrev: string | null } | null): string {
  if (!part) return "—";
  return part.abbrev ? `${part.name} (${part.abbrev})` : part.name;
}

function CommandBody({ entity, dataset }: { entity: CommandEntity; dataset: Dataset }) {
  const flow = entity.flow?.request;
  return (
    <>
      <Facts
        rows={[
          ["Code", entity.code],
          ["Request", messageName(entity.request)],
          ["Answer", messageName(entity.answer)],
          [
            "Request flow",
            flow ? (
              <span>
                <InlineLinks ids={flow.from} dataset={dataset} separator=" / " />
                {" → "}
                <InlineLinks ids={flow.to} dataset={dataset} separator=" / " />
              </span>
            ) : null,
          ],
        ]}
      />
      {entity.formats.map((format) => {
        const app = dataset.byId.get(format.app);
        return (
          <Section key={`${format.app}-${format.direction}`} title={`${format.name} · ${app ? entityShortName(app) : format.app}`}>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <EntityLink id={format.app} dataset={dataset}>
                {app ? entityTitle(app) : format.app}
              </EntityLink>
              <span>
                {format.direction === "request" ? "R" : ""}
                {format.proxiable ? "P" : ""} bits
              </span>
              <SpecChip spec={format.spec} />
            </div>
            <AbnfBlock refs={format.avps} dataset={dataset} />
          </Section>
        );
      })}
      {entity.formats.length === 0 ? (
        <p className="text-sm text-muted-foreground">No message format in the Rel-{dataset.meta.release} sources this reference reads.</p>
      ) : null}
      <Section title="Interfaces">
        <LinkList ids={entity.interfaces} dataset={dataset} detail={interfaceDetail(dataset)} />
      </Section>
    </>
  );
}

function AppBody({ entity, dataset }: { entity: AppEntity; dataset: Dataset }) {
  return (
    <>
      <Facts rows={[["Application ID", entity.appId], ["Vendor", vendorLabel(entity.vendor)]]} />
      <Section title={`Commands (${entity.commands.length})`}>
        <LinkList ids={entity.commands} dataset={dataset} detail={codeDetail} />
      </Section>
      <Section title="Interfaces">
        <LinkList ids={entity.interfaces} dataset={dataset} detail={interfaceDetail(dataset)} />
      </Section>
    </>
  );
}

function InterfaceBody({ entity, dataset }: { entity: InterfaceEntity; dataset: Dataset }) {
  return (
    <>
      <Facts
        rows={[
          ["Protocol", entity.protocol ?? "—"],
          ["Generation", entity.generations.join(", ") || "—"],
          ["Also called", entity.aliases.length > 0 ? entity.aliases.join(", ") : null],
        ]}
      />
      <Section title="Endpoints">
        <LinkList ids={entity.endpoints} dataset={dataset} />
      </Section>
      {entity.apps.length > 0 ? (
        <Section title="Diameter applications">
          <LinkList ids={entity.apps} dataset={dataset} detail={codeDetail} />
        </Section>
      ) : null}
    </>
  );
}

function NfBody({ entity, dataset }: { entity: NfEntity; dataset: Dataset }) {
  /** The far end of each interface and its protocol: "HSS · Diameter". */
  const peerDetail = (item: Entity) =>
    item.kind === "if"
      ? [item.endpoints.filter((id) => id !== entity.id).map((id) => id.slice("nf/".length)).join(", "), item.protocol]
          .filter(Boolean)
          .join(" · ")
      : null;
  return (
    <>
      <Facts
        rows={[
          ["Generation", entity.generations.join(", ") || "—"],
          ["Also called", entity.aliases.length > 0 ? entity.aliases.join(", ") : null],
        ]}
      />
      <Section title={`Interfaces (${entity.interfaces.length})`}>
        <LinkList ids={entity.interfaces} dataset={dataset} detail={peerDetail} />
      </Section>
      {entity.replaces.length > 0 ? (
        <Section title="Takes over from">
          <LinkList ids={entity.replaces} dataset={dataset} />
        </Section>
      ) : null}
      {entity.replacedBy.length > 0 ? (
        <Section title="Taken over by">
          <LinkList ids={entity.replacedBy} dataset={dataset} />
        </Section>
      ) : null}
    </>
  );
}

function EntityBody({ entity, dataset }: { entity: Entity; dataset: Dataset }) {
  switch (entity.kind) {
    case "avp":
      return <AvpBody entity={entity} dataset={dataset} />;
    case "cmd":
      return <CommandBody entity={entity} dataset={dataset} />;
    case "app":
      return <AppBody entity={entity} dataset={dataset} />;
    case "if":
      return <InterfaceBody entity={entity} dataset={dataset} />;
    case "nf":
      return <NfBody entity={entity} dataset={dataset} />;
  }
}

/** A one-line citation for the clipboard: "AVP Subscription-Data (1400 · vendor 10415), TS 29.272 §7.3.2". */
function citation(entity: Entity): string {
  const code = entityCode(entity);
  const spec = entity.spec[0] ? `, ${specLabel(entity.spec[0])}` : "";
  return `${KIND_BADGES[entity.kind]} ${entityTitle(entity)}${code ? ` (${code})` : ""}${spec}`;
}

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
    <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => openSearch(navigate)}>
      ← Results
    </button>
  );
  if (!entity) {
    return (
      <div className="p-4 md:p-5">
        <div className="mx-auto w-full max-w-3xl space-y-2">
          {backToSearch}
          <p className="text-sm">No entry has the id {id}.</p>
        </div>
      </div>
    );
  }
  const copy = () => {
    void navigator.clipboard.writeText(citation(entity)).then(() => setCopied(true));
  };
  return (
    <div className="h-full overflow-y-auto p-4 md:p-5">
      <article className="mx-auto w-full max-w-3xl space-y-5">
        <header className="space-y-2">
          {backToSearch}
          <div className="flex flex-wrap items-center gap-2">
            <KindBadge kind={entity.kind} />
            <h1 className="text-lg font-semibold">{entityTitle(entity)}</h1>
            <button
              type="button"
              onClick={copy}
              className="ml-auto rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
            >
              {copied ? "Copied" : "Copy ref"}
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {entity.spec.map((spec) => (
              <SpecChip key={`${spec.doc}-${spec.clause ?? ""}`} spec={spec} />
            ))}
          </div>
        </header>
        {entity.description ? (
          <p className="text-sm leading-6">{entity.description}</p>
        ) : (
          <p className="text-sm text-muted-foreground">No summary yet. The spec references above define this entry.</p>
        )}
        <EntityBody entity={entity} dataset={dataset} />
        <footer className="border-t border-border pt-3 text-xs text-muted-foreground">
          Rel-{dataset.meta.release}. {dataset.meta.notice}
        </footer>
      </article>
    </div>
  );
}
