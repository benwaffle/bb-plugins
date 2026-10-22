import type { MouseEvent, ReactNode } from "react";
import * as HoverCard from "@radix-ui/react-hover-card";
import { experimental_usePluginId, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { entityShortName, entityTitle, type Dataset } from "./dataset";
import { codeLabel, entityPath, firstSentence, PANEL_PATH, specLabel } from "./format";
import { KIND_STYLES, kindVars } from "./kinds";
import { specUrl } from "./links";
import type { Entity, EntityKind, SpecRef } from "./types";

declare const __BB_PLUGIN_ID__: string | undefined;

export function useOpenEntity(): (id: string) => void {
  const navigate = useBbNavigate();
  return (id: string) => navigate.toPluginPanel(PANEL_PATH, { subPath: id });
}

/** Marks portaled content as this plugin's, so its stylesheet applies outside the panel. */
function portalScopeProps() {
  return {
    "data-bb-portaled-overlay": "",
    "data-bb-plugin-root": "",
    ...(typeof __BB_PLUGIN_ID__ === "string" ? { "data-bb-plugin": __BB_PLUGIN_ID__ } : {}),
  };
}

export function KindBadge({ kind }: { kind: EntityKind }) {
  return (
    <span
      style={kindVars(kind)}
      className="inline-flex h-[18px] shrink-0 items-center rounded px-1.5 text-[11px] leading-none font-medium bg-(--kind-bg) text-(color:--kind-fg) dark:bg-(--kind-bg-dark) dark:text-(color:--kind-fg-dark)"
    >
      {KIND_STYLES[kind].label}
    </span>
  );
}

/** An entry's number in monospace: the command code, AVP code, or application id. */
export function CodeBadge({ entity }: { entity: Entity }) {
  const code = codeLabel(entity);
  if (code === null) return null;
  return (
    <span className="inline-flex h-[18px] shrink-0 items-center rounded bg-foreground/[0.06] px-1.5 font-mono text-[11px] leading-none tabular-nums text-muted-foreground">
      {code}
    </span>
  );
}

/** Hover previews open after a short rest so pointer sweeps across a list stay quiet. */
const PREVIEW_OPEN_DELAY = 350;
const PREVIEW_CLOSE_DELAY = 80;

function EntityPreview({ entity }: { entity: Entity }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <KindBadge kind={entity.kind} />
        <CodeBadge entity={entity} />
      </div>
      <p className="text-sm font-medium text-foreground">{entityTitle(entity)}</p>
      {entity.description ? (
        <p className="line-clamp-3 text-xs leading-5 text-muted-foreground">{firstSentence(entity.description)}</p>
      ) : null}
      {entity.spec[0] ? <p className="text-[11px] text-muted-foreground">{specLabel(entity.spec[0])}</p> : null}
    </div>
  );
}

/**
 * A link to an entity's page with a hover preview of its one-line summary.
 * Plain clicks navigate in place; modified clicks keep browser behavior.
 */
export function EntityLink({
  id,
  dataset,
  children,
  className = "underline decoration-foreground/20 underline-offset-[3px] transition-[text-decoration-color] duration-150 hover:decoration-foreground/70",
}: {
  id: string;
  dataset: Dataset;
  children?: ReactNode;
  className?: string;
}) {
  const pluginId = experimental_usePluginId();
  const open = useOpenEntity();
  const entity = dataset.byId.get(id);
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    open(id);
  };
  const link = (
    <a href={entityPath(pluginId, id)} onClick={onClick} className={className}>
      {children ?? (entity ? entityShortName(entity) : id)}
    </a>
  );
  if (!entity) return link;
  return (
    <HoverCard.Root openDelay={PREVIEW_OPEN_DELAY} closeDelay={PREVIEW_CLOSE_DELAY}>
      <HoverCard.Trigger asChild>{link}</HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          {...portalScopeProps()}
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          className="z-50 w-72 origin-(--radix-hover-card-content-transform-origin) rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.97] data-[state=open]:duration-150 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-100 motion-reduce:data-[state=open]:zoom-in-100"
        >
          <EntityPreview entity={entity} />
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}

const PILL_CLASS =
  "inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-foreground/[0.05] px-2 text-[11px] leading-none text-muted-foreground";

/** A spec reference as a pill, "TS 29.272 §7.3.2", linked to the public spec page when there is one. */
export function SpecPill({ spec }: { spec: SpecRef }) {
  const url = specUrl(spec);
  const title = spec.version ? `${specLabel(spec)} (V${spec.version})` : specLabel(spec);
  const content = (
    <>
      <span className="font-medium">{spec.doc}</span>
      {spec.clause ? <span className="tabular-nums opacity-75">§{spec.clause}</span> : null}
    </>
  );
  if (!url) {
    return (
      <span title={title} className={PILL_CLASS}>
        {content}
      </span>
    );
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      title={title}
      className={`${PILL_CLASS} transition-colors duration-150 hover:bg-foreground/10 hover:text-foreground`}
    >
      {content}
    </a>
  );
}

export const SECTION_HEADING = "text-xs font-medium text-muted-foreground";
