import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  definePluginApp,
  experimental_usePluginId,
  useBbNavigate,
  type ExperimentalPageTitle,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import { bundledDataset, entityInterfaces, entityShortName, entityTitle, KIND_LABELS, KINDS, type Dataset } from "./dataset";
import { DetailPage } from "./detail";
import { factLine, PANEL_PATH } from "./format";
import { parseSubPath, querySubPath } from "./links";
import { kindCounts, search, type SearchHit } from "./search";
import { KindBadge, SECTION_HEADING, SpecChip, useOpenEntity } from "./ui";
import {
  getView,
  getWindowNavigate,
  loadRecent,
  openSearch,
  setView,
  setWindowNavigate,
  useView,
  type ViewState,
} from "./view";

const RESULT_LIMIT = 100;
const INTERFACE_FACET_LIMIT = 16;

/** Hands the window's navigation to the palette commands, and loads recents once per window. */
function NavigationBridge() {
  const navigate = useBbNavigate();
  const pluginId = experimental_usePluginId();
  useEffect(() => {
    setWindowNavigate(navigate);
    loadRecent(pluginId);
    return () => {
      if (getWindowNavigate() === navigate) setWindowNavigate(null);
    };
  }, [navigate, pluginId]);
  return null;
}

// ---------------------------------------------------------------------------
// Search page

function ResultRow({
  hit,
  dataset,
  selected,
  onOpen,
  onHover,
}: {
  hit: SearchHit;
  dataset: Dataset;
  selected: boolean;
  onOpen: () => void;
  onHover: () => void;
}) {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  const entity = hit.entity;
  return (
    <li
      ref={ref}
      role="option"
      aria-selected={selected}
      onClick={onOpen}
      onMouseMove={onHover}
      className={`cursor-pointer border-b border-border px-3 py-2 last:border-b-0 ${selected ? "bg-accent" : "hover:bg-accent/50"}`}
    >
      <div className="flex items-baseline gap-2">
        <KindBadge kind={entity.kind} />
        <span className="min-w-0 truncate font-medium">{entityTitle(entity)}</span>
        {entity.spec[0] ? (
          <span className="ml-auto">
            <SpecChip spec={entity.spec[0]} />
          </span>
        ) : null}
      </div>
      <div className="mt-0.5 text-xs text-muted-foreground">{factLine(entity, dataset)}</div>
      {entity.description ? <p className="mt-1 line-clamp-2 text-sm">{entity.description}</p> : null}
    </li>
  );
}

function SearchPage({ dataset, initialQuery }: { dataset: Dataset; initialQuery: string | null }) {
  const view = useView();
  const navigate = useBbNavigate();
  const open = useOpenEntity();
  const inputRef = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    if (initialQuery !== null && initialQuery !== getView().query) setView({ query: initialQuery });
  }, [initialQuery]);
  useEffect(() => {
    inputRef.current?.focus();
  }, [view.focusTick]);

  const { query, kind, interfaceId } = view;
  const hits = useMemo(
    () => search(dataset, query, { kinds: kind ? [kind] : [], interface: interfaceId }, RESULT_LIMIT),
    [dataset, query, kind, interfaceId],
  );
  useEffect(() => setSelected(0), [hits]);

  const setQuery = (next: string) => {
    setView({ query: next });
    navigate.toPluginPanel(PANEL_PATH, { subPath: querySubPath(next), replace: true });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelected((index) => Math.max(0, Math.min(index + 1, hits.length - 1)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelected((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      const hit = hits[selected];
      if (hit) open(hit.id);
    } else if (event.key === "Escape" && query !== "") {
      // Escape clears the query first; bb's own Escape handling runs once it is empty.
      event.preventDefault();
      setQuery("");
    }
  };

  const filterLabel = [kind ? KIND_LABELS[kind] : null, interfaceId ? dataset.byId.get(interfaceId)?.name : null].filter(Boolean);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border p-3 md:px-5">
        <div className="mx-auto flex w-full max-w-4xl items-center gap-3">
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder='Search: "ULR", "316", "Subscription-Data", "AVP 1400", "S6a", "HSS"'
            aria-label="Search the telecom reference"
            aria-controls="telecom-ref-results"
            spellCheck={false}
            className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <span className="shrink-0 text-xs text-muted-foreground">
            Rel-{dataset.meta.release} · {dataset.meta.built}
          </span>
        </div>
        {filterLabel.length > 0 ? (
          <div className="mx-auto mt-2 flex w-full max-w-4xl items-center gap-2 text-xs text-muted-foreground">
            <span>Filtered to {filterLabel.join(" on ")}</span>
            <button
              type="button"
              className="underline underline-offset-2 hover:text-foreground"
              onClick={() => setView({ kind: null, interfaceId: null })}
            >
              Clear
            </button>
          </div>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3 md:p-5">
        <div className="mx-auto w-full max-w-4xl">
          {hits.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {query === "" ? "Nothing matches these filters." : `No entry matches "${query}".`}
            </p>
          ) : (
            <ul id="telecom-ref-results" role="listbox" aria-label="Results" className="rounded-md border border-border">
              {hits.map((hit, index) => (
                <ResultRow
                  key={hit.id}
                  hit={hit}
                  dataset={dataset}
                  selected={index === selected}
                  onOpen={() => open(hit.id)}
                  onHover={() => setSelected(index)}
                />
              ))}
            </ul>
          )}
          <p className="mt-4 text-xs text-muted-foreground">{dataset.meta.notice}</p>
        </div>
      </div>
    </div>
  );
}

function ReferencePanel({ subPath }: PluginNavPanelProps) {
  const dataset = bundledDataset();
  const route = parseSubPath(subPath);
  return route.kind === "entity" ? (
    <DetailPage dataset={dataset} id={route.id} />
  ) : (
    <SearchPage dataset={dataset} initialQuery={route.query} />
  );
}

// ---------------------------------------------------------------------------
// Sidebar: type and interface filters, and recently viewed entries

function FacetButton({ active, label, count, onClick }: { active: boolean; label: ReactNode; count?: number; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm ${active ? "bg-accent font-medium" : "hover:bg-accent/50"}`}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined ? <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{count}</span> : null}
    </button>
  );
}

/** The interfaces among all matches of the query and kind, most matches first. */
function interfaceFacets(dataset: Dataset, view: ViewState): Array<[id: string, count: number]> {
  const tally = new Map<string, number>();
  for (const hit of search(dataset, view.query, { kinds: view.kind ? [view.kind] : [] }, Number.POSITIVE_INFINITY)) {
    for (const id of entityInterfaces(hit.entity)) tally.set(id, (tally.get(id) ?? 0) + 1);
  }
  return [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, INTERFACE_FACET_LIMIT);
}

function ReferenceSidebar({ subPath }: PluginNavPanelProps) {
  const dataset = bundledDataset();
  const view = useView();
  const navigate = useBbNavigate();
  const open = useOpenEntity();
  const route = parseSubPath(subPath);
  const viewingId = route.kind === "entity" ? route.id : null;

  const counts = useMemo(() => kindCounts(dataset, view.query, { interface: view.interfaceId }), [dataset, view.query, view.interfaceId]);
  const interfaces = useMemo(() => interfaceFacets(dataset, view), [dataset, view]);
  const total = KINDS.reduce((sum, kind) => sum + counts[kind], 0);
  const selectedInterfaceHidden = view.interfaceId !== null && !interfaces.some(([id]) => id === view.interfaceId);

  const apply = (patch: Partial<ViewState>) => {
    setView(patch);
    if (viewingId !== null) openSearch(navigate);
  };

  return (
    <nav aria-label="Telecom reference filters" className="space-y-4 p-2">
      <div className="space-y-0.5">
        <h2 className={`px-2 pb-1 ${SECTION_HEADING}`}>Type</h2>
        <FacetButton active={view.kind === null} label="All" count={total} onClick={() => apply({ kind: null })} />
        {KINDS.map((kind) => (
          <FacetButton key={kind} active={view.kind === kind} label={KIND_LABELS[kind]} count={counts[kind]} onClick={() => apply({ kind })} />
        ))}
      </div>
      <div className="space-y-0.5">
        <h2 className={`px-2 pb-1 ${SECTION_HEADING}`}>Interface</h2>
        {selectedInterfaceHidden && view.interfaceId ? (
          <FacetButton active label={dataset.byId.get(view.interfaceId)?.name ?? view.interfaceId} onClick={() => apply({ interfaceId: null })} />
        ) : null}
        {interfaces.map(([id, count]) => (
          <FacetButton
            key={id}
            active={view.interfaceId === id}
            label={dataset.byId.get(id)?.name ?? id}
            count={count}
            onClick={() => apply({ interfaceId: view.interfaceId === id ? null : id })}
          />
        ))}
        {interfaces.length === 0 ? <p className="px-2 text-xs text-muted-foreground">No interface among the matches.</p> : null}
      </div>
      {view.recent.length > 0 ? (
        <div className="space-y-0.5">
          <h2 className={`px-2 pb-1 ${SECTION_HEADING}`}>Recent</h2>
          {view.recent.map((id) => {
            const entity = dataset.byId.get(id);
            if (!entity) return null;
            return (
              <FacetButton
                key={id}
                active={viewingId === id}
                label={
                  <span className="flex items-center gap-1.5">
                    <KindBadge kind={entity.kind} />
                    <span className="truncate">{entityShortName(entity)}</span>
                  </span>
                }
                onClick={() => open(id)}
              />
            );
          })}
        </div>
      ) : null}
    </nav>
  );
}

/** The entry's short name after the panel title on detail pages. */
function usePageTitle({ subPath }: PluginNavPanelProps): ExperimentalPageTitle | null {
  const route = parseSubPath(subPath);
  const entity = route.kind === "entity" ? bundledDataset().byId.get(route.id) : undefined;
  if (!entity) return null;
  return { title: entityShortName(entity), windowTitle: `${entityShortName(entity)} · Telecom reference` };
}

function selectedText(): string {
  return window.getSelection()?.toString().trim().slice(0, 200) ?? "";
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "ref",
    title: "Telecom reference",
    icon: "FileText",
    path: PANEL_PATH,
    component: ReferencePanel,
    experimental_sidebar: ReferenceSidebar,
    experimental_usePageTitle: usePageTitle,
  });
  app.slots.experimental_appOverlay({ id: "navigation", component: NavigationBridge });
  app.commands.register({
    id: "search",
    title: "Telecom reference: search Diameter AVPs, commands, interfaces, network functions",
    defaultShortcut: { key: "k", mod: true, alt: true },
    run: () => openSearch(getWindowNavigate()),
  });
  app.commands.register({
    id: "lookup-selection",
    title: "Telecom reference: look up selected text",
    isAvailable: () => selectedText() !== "",
    run: () => openSearch(getWindowNavigate(), selectedText()),
  });
});
