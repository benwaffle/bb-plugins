import type { MouseEvent, ReactNode } from "react";
import { experimental_usePluginId, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { entityShortName, entityTitle, KIND_BADGES, type Dataset } from "./dataset";
import { entityPath, PANEL_PATH, specLabel } from "./format";
import { specUrl } from "./links";
import type { EntityKind, SpecRef } from "./types";

export function useOpenEntity(): (id: string) => void {
  const navigate = useBbNavigate();
  return (id: string) => navigate.toPluginPanel(PANEL_PATH, { subPath: id });
}

/** A link to an entity's page; plain clicks navigate in place, modified clicks keep browser behavior. */
export function EntityLink({ id, dataset, children }: { id: string; dataset: Dataset; children?: ReactNode }) {
  const pluginId = experimental_usePluginId();
  const open = useOpenEntity();
  const entity = dataset.byId.get(id);
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    open(id);
  };
  return (
    <a
      href={entityPath(pluginId, id)}
      onClick={onClick}
      className="underline decoration-muted-foreground/40 underline-offset-2 hover:decoration-foreground"
      title={entity ? entityTitle(entity) : id}
    >
      {children ?? (entity ? entityShortName(entity) : id)}
    </a>
  );
}

export function KindBadge({ kind }: { kind: EntityKind }) {
  return (
    <span className="inline-flex h-4 shrink-0 items-center rounded border border-border px-1 font-mono text-[10px] font-medium tracking-wide text-muted-foreground">
      {KIND_BADGES[kind]}
    </span>
  );
}

const CHIP_CLASS = "inline-flex shrink-0 items-center rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground";

/** A spec reference, linked to the public spec page when there is one. */
export function SpecChip({ spec }: { spec: SpecRef }) {
  const url = specUrl(spec);
  const label = specLabel(spec);
  const title = spec.version ? `${label} (V${spec.version})` : label;
  if (!url) {
    return (
      <span title={title} className={CHIP_CLASS}>
        {label}
      </span>
    );
  }
  return (
    <a href={url} target="_blank" rel="noreferrer" title={title} className={`${CHIP_CLASS} hover:text-foreground`}>
      {label}
    </a>
  );
}

export const SECTION_HEADING = "text-xs font-semibold uppercase tracking-wide text-muted-foreground";
