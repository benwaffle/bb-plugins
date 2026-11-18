import type { ReactNode } from "react";
import { experimental_Icon as Icon, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { entityShortName, entityTitle, type Dataset } from "./dataset";
import { DiagramCanvas } from "./diagram-canvas";
import type { Diagram } from "./diagram-types";
import { DIAGRAMS, diagramById, diagramShows, diagramsShowing, diagramSubPath, edgeLabel, endTitle, groupLeaders, groupOf } from "./diagrams";
import { firstSentence, PANEL_PATH } from "./format";
import type { Entity } from "./types";
import { KindBadge, SECTION_HEADING, SpecPill, useOpenEntity } from "./ui";
import { openSearch } from "./view";

const TAB =
  "h-7 shrink-0 rounded-md px-2.5 text-xs transition-[background-color,color] duration-150";

function useOpenDiagram(): (id: string, focus?: string | null) => void {
  const navigate = useBbNavigate();
  return (id, focus) => navigate.toPluginPanel(PANEL_PATH, { subPath: diagramSubPath(id, focus), replace: true });
}

/** A button that picks an entity in the diagram when the diagram draws it, else opens its page. */
function PickLink({ id, diagram, dataset, onPick, children }: { id: string; diagram: Diagram; dataset: Dataset; onPick: (id: string) => void; children?: ReactNode }) {
  const open = useOpenEntity();
  const entity = dataset.byId.get(id);
  const inDiagram = diagramShows(diagram, id);
  return (
    <button
      type="button"
      onClick={() => (inDiagram ? onPick(id) : open(id))}
      title={inDiagram ? "Show in this diagram" : "Open its entry"}
      className={`rounded px-1.5 py-0.5 text-left text-[13px] transition-colors duration-150 hover:bg-foreground/[0.07] ${inDiagram ? "text-foreground" : "text-muted-foreground"}`}
    >
      {children ?? (entity ? entityShortName(entity) : id)}
    </button>
  );
}

/** The interfaces drawn at a network function's boxes in this diagram, each once. */
function interfacesAt(diagram: Diagram, nf: string): string[] {
  const nodes = new Set(diagram.nodes.filter((node) => node.nfs.includes(nf)).map((node) => node.id));
  return [...new Set(diagram.edges.filter((edge) => nodes.has(edge.from) || nodes.has(edge.to)).map((edge) => edge.if))];
}

/** The two ends of each line an interface is drawn as: "SGW — UPF + PGW-U (S5-U)". */
function drawnEnds(diagram: Diagram, id: string, dataset: Dataset): string[] {
  return diagram.edges
    .filter((edge) => edge.if === id)
    .map((edge) => {
      const to = edge.loop ? "another instance" : endTitle(diagram, edge.to, dataset);
      const label = edgeLabel(edge, dataset);
      const item = dataset.byId.get(id);
      return `${endTitle(diagram, edge.from, dataset)} — ${to}${item && label !== item.name ? ` (${label})` : ""}`;
    });
}

function Inspector({ entity, diagram, dataset, onPick }: { entity: Entity; diagram: Diagram; dataset: Dataset; onPick: (id: string) => void }) {
  const open = useOpenEntity();
  const openDiagram = useOpenDiagram();
  const others = diagramsShowing(entity.id).filter((other) => other.id !== diagram.id);
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <KindBadge kind={entity.kind} />
        <h2 className="text-base font-semibold text-balance text-foreground">{entityTitle(entity)}</h2>
        {entity.spec.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {entity.spec.slice(0, 4).map((spec) => (
              <SpecPill key={`${spec.doc}-${spec.clause ?? ""}`} spec={spec} />
            ))}
          </div>
        ) : null}
      </div>
      {entity.description ? <p className="text-[13px] leading-6 text-foreground">{entity.description}</p> : null}
      {entity.kind === "if" ? (
        <dl className="space-y-2 text-[13px]">
          <div>
            <dt className={SECTION_HEADING}>Protocol</dt>
            <dd className="text-foreground">{entity.protocol ?? "—"}</dd>
          </div>
          <div>
            <dt className={SECTION_HEADING}>Endpoints</dt>
            <dd className="-mx-1.5 flex flex-wrap">
              {entity.endpoints.map((endpoint, index) => (
                <PickLink key={`${endpoint}-${index}`} id={endpoint} diagram={diagram} dataset={dataset} onPick={onPick} />
              ))}
            </dd>
          </div>
          <div>
            <dt className={SECTION_HEADING}>Drawn here</dt>
            {drawnEnds(diagram, entity.id, dataset).map((line) => (
              <dd key={line} className="text-foreground">
                {line}
              </dd>
            ))}
          </div>
        </dl>
      ) : null}
      {entity.kind === "nf" ? (
        <div className="space-y-1">
          <h3 className={SECTION_HEADING}>Interfaces in this diagram</h3>
          <div className="-mx-1.5 flex flex-wrap">
            {interfacesAt(diagram, entity.id).map((id) => (
              <PickLink key={id} id={id} diagram={diagram} dataset={dataset} onPick={onPick} />
            ))}
          </div>
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => open(entity.id)}
        className="inline-flex h-7 items-center gap-1.5 rounded-md bg-foreground/[0.07] px-2.5 text-xs font-medium text-foreground transition-[background-color,transform] duration-150 hover:bg-foreground/10 active:scale-[0.97]"
      >
        Open full entry
        <Icon name="ArrowRight" className="size-3.5" aria-hidden />
      </button>
      {others.length > 0 ? (
        <div className="space-y-1">
          <h3 className={SECTION_HEADING}>Also drawn in</h3>
          <ul className="-mx-1.5">
            {others.map((other) => (
              <li key={other.id}>
                <button
                  type="button"
                  onClick={() => openDiagram(other.id, entity.id)}
                  className="rounded px-1.5 py-0.5 text-left text-[13px] text-foreground transition-colors duration-150 hover:bg-foreground/[0.07]"
                >
                  {other.title} · {other.variant}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <svg width="22" height="6" aria-hidden>
          <line x1="0" x2="22" y1="3" y2="3" stroke="currentColor" strokeWidth="1.25" strokeDasharray="5 3" />
        </svg>
        Control plane
      </span>
      <span className="flex items-center gap-1.5">
        <svg width="22" height="6" aria-hidden>
          <line x1="0" x2="22" y1="3" y2="3" stroke="var(--foreground)" strokeWidth="2.4" />
        </svg>
        User plane
      </span>
      <span className="flex items-center gap-1.5">
        <svg width="22" height="6" aria-hidden>
          <line x1="0" x2="22" y1="3" y2="3" stroke="currentColor" strokeWidth="5" strokeLinecap="round" />
        </svg>
        Service-based bus
      </span>
      <span>Ctrl/⌘ + scroll to zoom · drag to pan</span>
    </div>
  );
}

/**
 * The architecture diagrams: a picker across the diagram groups, a toggle
 * between views of one group, the diagram itself, and an inspector for the
 * network function or interface picked in it. The pick lives in the route,
 * so a list entry can link straight to it.
 */
export function DiagramPage({ dataset, id, focus }: { dataset: Dataset; id: string | null; focus: string | null }) {
  const navigate = useBbNavigate();
  const openDiagram = useOpenDiagram();
  const diagram = (id ? diagramById(id) : undefined) ?? DIAGRAMS[0]!;
  const picked = focus && dataset.byId.has(focus) ? focus : null;
  const entity = picked ? dataset.byId.get(picked) : undefined;
  const views = groupOf(diagram);
  const onPick = (next: string) => openDiagram(diagram.id, next === picked ? null : next);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="space-y-3 border-b border-border px-4 pt-4 pb-3 md:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="-ml-2 inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors duration-150 hover:bg-foreground/[0.05] hover:text-foreground"
            onClick={() => openSearch(navigate)}
          >
            <Icon name="ArrowLeft" className="size-3.5" aria-hidden />
            Search
          </button>
          <nav aria-label="Diagrams" className="flex min-w-0 flex-wrap gap-1">
            {groupLeaders().map((leader) => {
              const active = leader.group === diagram.group;
              return (
                <button
                  key={leader.group}
                  type="button"
                  aria-current={active ? "page" : undefined}
                  onClick={() => openDiagram(leader.id, picked && diagramShows(leader, picked) ? picked : null)}
                  className={`${TAB} ${active ? "bg-foreground/[0.08] font-medium text-foreground" : "text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground"}`}
                >
                  {leader.title}
                </button>
              );
            })}
          </nav>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="text-lg font-semibold tracking-tight text-foreground">{diagram.title}</h1>
          {views.length > 1 ? (
            <div role="group" aria-label="View" className="flex items-center rounded-md bg-foreground/[0.05] p-0.5">
              {views.map((view) => (
                <button
                  key={view.id}
                  type="button"
                  aria-pressed={view.id === diagram.id}
                  onClick={() => openDiagram(view.id, picked && diagramShows(view, picked) ? picked : null)}
                  className={`h-6 rounded px-2.5 text-xs transition-[background-color,color] duration-150 ${view.id === diagram.id ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"}`}
                >
                  {view.variant}
                </button>
              ))}
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">{diagram.variant}</span>
          )}
          <span className="flex flex-wrap gap-1.5">
            {diagram.figures.map((figure) => (
              <SpecPill key={`${figure.doc}-${figure.figure}`} spec={{ doc: figure.doc, clause: figure.clause }} />
            ))}
          </span>
        </div>
        <p className="max-w-[90ch] text-[13px] text-muted-foreground">{diagram.summary}</p>
        <Legend />
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <div className="min-w-0 flex-1 p-2" tabIndex={-1}>
          <DiagramCanvas
            diagram={diagram}
            dataset={dataset}
            picked={picked}
            onPick={onPick}
            label={`${diagram.title}, ${diagram.variant}. Each box and interface is a button.`}
          />
        </div>
        <aside aria-label="Selection" className="max-h-64 w-full shrink-0 overflow-y-auto border-t border-border p-4 md:max-h-none md:w-80 md:border-t-0 md:border-l">
          {entity ? (
            <Inspector entity={entity} diagram={diagram} dataset={dataset} onPick={onPick} />
          ) : (
            <div className="space-y-4 text-[13px] text-muted-foreground">
              <p>Pick a box or an interface to see its entry here. Hover or focus one to light up what it connects to; Tab moves through them and Enter picks.</p>
              {diagram.figures.map((figure) => (
                <p key={`${figure.doc}-${figure.figure}`}>
                  <span className="text-foreground">
                    {figure.doc} Figure {figure.figure}
                  </span>
                  : {figure.title}
                </p>
              ))}
              {diagram.notes?.map((note) => <p key={note}>{note}</p>)}
              {Object.keys(diagram.omitted ?? {}).length > 0 ? (
                <div className="space-y-1">
                  <h3 className={SECTION_HEADING}>Not drawn</h3>
                  <ul className="space-y-1">
                    {Object.entries(diagram.omitted ?? {}).map(([omitted, reason]) => {
                      const item = dataset.byId.get(omitted);
                      return (
                        <li key={omitted}>
                          <span className="text-foreground">{item ? item.name : omitted}</span>: {firstSentence(reason)}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : null}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
