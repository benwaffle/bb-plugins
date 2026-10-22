import { useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  definePluginApp,
  experimental_Icon as Icon,
  experimental_usePluginId,
  useBbNavigate,
  type ExperimentalPageTitle,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import { bundledDataset, entityInterfaces, entityShortName, entityTitle, KIND_LABELS, KINDS, type Dataset } from "./dataset";
import { DetailPage } from "./detail";
import { factLine, firstSentence, PANEL_PATH } from "./format";
import { parseSubPath, querySubPath } from "./links";
import { kindCounts, search, type SearchHit } from "./search";
import type { Entity } from "./types";
import { CodeBadge, KindBadge, SECTION_HEADING, SpecPill, useOpenEntity } from "./ui";
import {
  getView,
  getWindowNavigate,
  loadPreferences,
  moveSelection,
  openSearch,
  setDensity,
  setView,
  setWindowNavigate,
  useView,
  type Density,
  type ViewState,
} from "./view";

const RESULT_LIMIT = 100;
const INTERFACE_FACET_LIMIT = 16;

/** Hands the window's navigation to the palette commands, and loads preferences once per window. */
function NavigationBridge() {
  const navigate = useBbNavigate();
  const pluginId = experimental_usePluginId();
  useEffect(() => {
    setWindowNavigate(navigate);
    loadPreferences(pluginId);
    return () => {
      if (getWindowNavigate() === navigate) setWindowNavigate(null);
    };
  }, [navigate, pluginId]);
  return null;
}

// ---------------------------------------------------------------------------
// Search page

const EXAMPLE_QUERIES = ["ULR", "316", "Subscription-Data", "S6a", "HSS"];

/** What a result row says under its name: the first sentence of the summary, else the facts line. */
function rowSummary(entity: Entity, dataset: Dataset): string {
  return entity.description ? firstSentence(entity.description) : factLine(entity, dataset);
}

function ResultRow({
  hit,
  index,
  dataset,
  density,
  selected,
  onOpen,
  onHover,
}: {
  hit: SearchHit;
  index: number;
  dataset: Dataset;
  density: Density;
  selected: boolean;
  onOpen: () => void;
  onHover: () => void;
}) {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  const entity = hit.entity;
  const compact = density === "compact";
  return (
    <li
      ref={ref}
      id={optionId(index)}
      role="option"
      aria-selected={selected}
      onClick={onOpen}
      onMouseMove={onHover}
      className={`grid cursor-pointer grid-cols-[6rem_minmax(0,1fr)_auto] items-center gap-x-3 rounded-md px-3 ${compact ? "py-1.5" : "py-2.5"} ${selected ? "bg-foreground/[0.07]" : ""}`}
    >
      <span className="flex">
        <KindBadge kind={entity.kind} />
      </span>
      <div className={compact ? "flex min-w-0 items-baseline gap-2" : "min-w-0"}>
        <div className="flex min-w-0 shrink-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{entityTitle(entity)}</span>
          <CodeBadge entity={entity} />
        </div>
        <p className={`truncate text-[13px] text-muted-foreground ${compact ? "min-w-0 flex-1" : "mt-0.5"}`}>{rowSummary(entity, dataset)}</p>
      </div>
      <span className="hidden sm:block">{entity.spec[0] ? <SpecPill spec={entity.spec[0]} /> : null}</span>
    </li>
  );
}

function optionId(index: number): string {
  return `telecom-ref-option-${index}`;
}

function DensityToggle({ density }: { density: Density }) {
  const pluginId = experimental_usePluginId();
  const options: Array<{ value: Density; label: string }> = [
    { value: "comfortable", label: "Comfortable" },
    { value: "compact", label: "Compact" },
  ];
  return (
    <div role="group" aria-label="Row density" className="flex items-center rounded-md bg-foreground/[0.05] p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={density === option.value}
          onClick={() => setDensity(pluginId, option.value)}
          className={`h-5 rounded px-2 text-[11px] transition-[background-color,color,transform] duration-150 active:scale-[0.96] ${density === option.value ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-4 min-w-4 items-center justify-center rounded border border-border px-1 font-sans text-[10px] leading-none text-muted-foreground">
      {children}
    </kbd>
  );
}

function NoMatches({ query, filtered, onQuery, onClearFilters }: { query: string; filtered: boolean; onQuery: (query: string) => void; onClearFilters: () => void }) {
  return (
    <div className="py-10">
      <p className="text-sm font-medium text-foreground">{query === "" ? "Nothing matches these filters" : `No entry matches \u201c${query}\u201d`}</p>
      <p className="mt-1 text-[13px] text-muted-foreground">
        {filtered ? "The type or interface filter may be hiding it. " : ""}
        Search by name, abbreviation, or code.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-1.5">
        {filtered ? (
          <button
            type="button"
            onClick={onClearFilters}
            className="h-7 rounded-md bg-foreground/[0.07] px-2.5 text-xs font-medium text-foreground transition-[background-color,transform] duration-150 hover:bg-foreground/10 active:scale-[0.97]"
          >
            Clear filters
          </button>
        ) : null}
        <span className={`mr-1 text-xs text-muted-foreground ${filtered ? "ml-2" : ""}`}>{filtered ? "or try" : "Try"}</span>
        {EXAMPLE_QUERIES.map((example) => (
          <button
            key={example}
            type="button"
            onClick={() => onQuery(example)}
            className="h-7 rounded-md bg-foreground/[0.05] px-2.5 text-xs text-foreground transition-[background-color,transform] duration-150 hover:bg-foreground/10 active:scale-[0.97]"
          >
            {example}
          </button>
        ))}
      </div>
    </div>
  );
}

function SearchPage({ dataset, routeQuery }: { dataset: Dataset; routeQuery: string }) {
  const view = useView();
  const navigate = useBbNavigate();
  const open = useOpenEntity();
  const inputRef = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState(0);

  // The route carries the query, so back/forward restores it and opening the panel root starts empty.
  useEffect(() => {
    if (routeQuery === getView().query) return;
    setView({ query: routeQuery });
    inputRef.current?.focus();
  }, [routeQuery]);
  useEffect(() => {
    inputRef.current?.focus();
  }, [view.focusTick]);

  const { query, kind, interfaceId, density } = view;
  // Typing stays responsive while a long result list re-renders; the stale list dims until it catches up.
  const deferredQuery = useDeferredValue(query);
  const searching = deferredQuery !== query;
  const hits = useMemo(
    () => search(dataset, deferredQuery, { kinds: kind ? [kind] : [], interface: interfaceId }, RESULT_LIMIT),
    [dataset, deferredQuery, kind, interfaceId],
  );
  useEffect(() => setSelected(0), [hits]);
  // The reset above lands a render late, so a shrunken list is read through the clamped index.
  const active = Math.min(selected, hits.length - 1);

  const setQuery = (next: string) => {
    setView({ query: next });
    navigate.toPluginPanel(PANEL_PATH, { subPath: querySubPath(next), replace: true });
  };
  const clearFilters = () => setView({ kind: null, interfaceId: null });
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const next = moveSelection(event.key, active, hits.length);
    if (next !== null) {
      event.preventDefault();
      setSelected(next);
    } else if (event.key === "Enter") {
      const hit = hits[active];
      if (hit) open(hit.id);
    } else if (event.key === "Escape" && query !== "") {
      // Escape clears the query first; bb's own Escape handling runs once it is empty.
      event.preventDefault();
      setQuery("");
    }
  };

  const filterLabel = [kind ? KIND_LABELS[kind] : null, interfaceId ? dataset.byId.get(interfaceId)?.name : null].filter(Boolean);
  const total = dataset.byId.size;
  const countLabel =
    deferredQuery === "" && filterLabel.length === 0
      ? `Browsing ${Math.min(hits.length, RESULT_LIMIT)} of ${total.toLocaleString()} entries`
      : hits.length >= RESULT_LIMIT
        ? `Top ${RESULT_LIMIT} matches`
        : `${hits.length} ${hits.length === 1 ? "match" : "matches"}`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-4 pt-6 pb-3 md:px-6">
        <div className="mx-auto w-full max-w-4xl">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">Telecom reference</h1>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            3GPP Release {dataset.meta.release} Diameter, EPC, and 5GC, built {dataset.meta.built}
          </p>
          <div className="relative mt-4">
            <Icon
              name={searching ? "Spinner" : "Search"}
              className={`pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground ${searching ? "animate-spin" : ""}`}
              aria-hidden
            />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Search by name, abbreviation, or code"
              role="combobox"
              aria-expanded={hits.length > 0}
              aria-label="Search the telecom reference"
              aria-controls="telecom-ref-results"
              aria-activedescendant={hits.length > 0 ? optionId(active) : undefined}
              spellCheck={false}
              autoComplete="off"
              className="h-10 w-full rounded-lg border border-transparent bg-foreground/[0.05] pr-3 pl-9 text-sm text-foreground outline-none transition-[background-color,border-color,box-shadow] duration-150 ease-out placeholder:text-muted-foreground/80 hover:bg-foreground/[0.07] focus:border-foreground/20 focus:bg-background focus:shadow-[0_0_0_3px_color-mix(in_oklch,var(--foreground)_7%,transparent)]"
            />
          </div>
          <div className="mt-3 flex min-h-6 items-center gap-3 text-xs text-muted-foreground">
            <span aria-live="polite">{countLabel}</span>
            {filterLabel.length > 0 ? (
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate">in {filterLabel.join(" on ")}</span>
                <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={clearFilters}>
                  Clear
                </button>
              </span>
            ) : null}
            <span className="ml-auto hidden items-center gap-1 md:flex">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
              <span className="mr-1.5">move</span>
              <Kbd>↵</Kbd>
              <span>open</span>
            </span>
            <DensityToggle density={density} />
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 md:px-6">
        <div className="mx-auto w-full max-w-4xl">
          {hits.length === 0 ? (
            <NoMatches query={deferredQuery} filtered={filterLabel.length > 0} onQuery={setQuery} onClearFilters={clearFilters} />
          ) : (
            <ul
              id="telecom-ref-results"
              role="listbox"
              aria-label="Results"
              aria-busy={searching}
              className={`-mx-3 transition-opacity duration-150 ${searching ? "opacity-60" : ""}`}
            >
              {hits.map((hit, index) => (
                <ResultRow
                  key={hit.id}
                  hit={hit}
                  index={index}
                  dataset={dataset}
                  density={density}
                  selected={index === active}
                  onOpen={() => open(hit.id)}
                  onHover={() => setSelected(index)}
                />
              ))}
            </ul>
          )}
          <p className="mt-6 text-xs text-muted-foreground">{dataset.meta.notice}</p>
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
    <SearchPage dataset={dataset} routeQuery={route.query} />
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
    run: () => openSearch(getWindowNavigate(), ""),
  });
  app.commands.register({
    id: "lookup-selection",
    title: "Telecom reference: look up selected text",
    isAvailable: () => selectedText() !== "",
    run: () => openSearch(getWindowNavigate(), selectedText()),
  });
});
