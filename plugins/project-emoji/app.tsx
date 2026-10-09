import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import {
  definePluginApp,
  experimental_usePluginId,
  experimental_useSidebarThreads,
  useRealtime,
  useRpc,
  useSettings,
  type PluginAppSlots,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { REALTIME_CHANNEL } from "./channel";
import type { rpcContract } from "./contract";
import { BUTTON_CLASS, decorateProjectRows, removeDecorations } from "./decorate";
import { parseEmoji, searchEmoji } from "./emoji";
import { projectAccentColor } from "./palette";

interface PickerTarget {
  readonly projectId: string;
  readonly anchor: HTMLElement;
}

/**
 * `app.slots.experimental_sidebarProjectDecoration`, typed here because the
 * pinned SDK predates it. Hosts without the slot leave it undefined.
 */
export interface SidebarProjectDecoration {
  leading?: ReactNode;
  accentColor?: string;
  labelClassName?: string;
  tint?: boolean;
}

export interface SidebarProjectDecorationRegistration {
  id: string;
  title: string;
  useDecoration(projectId: string): SidebarProjectDecoration | null;
}

type SlotsWithProjectDecoration = PluginAppSlots & {
  experimental_sidebarProjectDecoration?: (
    registration: SidebarProjectDecorationRegistration,
  ) => void;
};

interface SidebarState {
  readonly emojiByProject: ReadonlyMap<string, string>;
  readonly colorByProject: ReadonlyMap<string, string>;
  readonly projectNames: ReadonlyMap<string, string>;
  readonly picker: PickerTarget | null;
}

/**
 * State the overlay loads and the decoration hooks read. The overlay and each
 * project header render in separate React trees, so they share it through
 * `useSyncExternalStore`.
 */
interface SidebarStore {
  get(): SidebarState;
  update(change: Partial<SidebarState>): void;
  subscribe(listener: () => void): () => void;
  openPicker(projectId: string, anchor: HTMLElement): void;
}

function createSidebarStore(): SidebarStore {
  let state: SidebarState = {
    emojiByProject: new Map(),
    colorByProject: new Map(),
    projectNames: new Map(),
    picker: null,
  };
  const listeners = new Set<() => void>();
  function update(change: Partial<SidebarState>): void {
    state = { ...state, ...change };
    for (const listener of listeners) listener();
  }
  return {
    get: () => state,
    update,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    openPicker(projectId, anchor) {
      update({ picker: { projectId, anchor } });
    },
  };
}

function useSidebarState(store: SidebarStore): SidebarState {
  return useSyncExternalStore(store.subscribe, store.get);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function EmojiPicker({
  target,
  projectName,
  current,
  onPick,
  onReset,
  onClose,
}: {
  target: PickerTarget;
  projectName: string;
  current: string | undefined;
  onPick: (emoji: string) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const anchorRef = useMemo(() => ({ current: target.anchor }), [target.anchor]);
  const matches = useMemo(() => searchEmoji(query), [query]);
  const typed = parseEmoji(query);

  return (
    <Popover open onOpenChange={(open) => (open ? undefined : onClose())}>
      <PopoverAnchor virtualRef={anchorRef} />
      <PopoverContent
        align="start"
        side="right"
        className="flex w-80 flex-col gap-2 p-2"
        mobileTitle={`Icon for ${projectName}`}
        autoFocusRef={searchRef}
      >
        <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            const first = typed ?? matches[0]?.emoji;
            if (first !== undefined) onPick(first);
          }}
          placeholder="Search emoji or paste one"
          aria-label="Search emoji"
          className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        />
        <div
          role="listbox"
          aria-label="Emoji"
          className="grid max-h-64 grid-cols-8 gap-0.5 overflow-y-auto"
        >
          {typed !== null && !matches.some((entry) => entry.emoji === typed) ? (
            <EmojiCell emoji={typed} name="typed emoji" selected={typed === current} onPick={onPick} />
          ) : null}
          {matches.map((entry) => (
            <EmojiCell
              key={entry.emoji}
              emoji={entry.emoji}
              name={entry.name}
              selected={entry.emoji === current}
              onPick={onPick}
            />
          ))}
        </div>
        {matches.length === 0 && typed === null ? (
          <p className="px-1 text-sm text-muted-foreground">No emoji match “{query}”.</p>
        ) : null}
        <button
          type="button"
          onClick={onReset}
          className="h-8 rounded-md px-2 text-left text-sm text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          Reset to automatic
        </button>
      </PopoverContent>
    </Popover>
  );
}

function EmojiCell({
  emoji,
  name,
  selected,
  onPick,
}: {
  emoji: string;
  name: string;
  selected: boolean;
  onPick: (emoji: string) => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      aria-label={name}
      title={name}
      onClick={() => onPick(emoji)}
      className={cn(
        "inline-flex size-8 items-center justify-center rounded-md text-lg leading-none outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
        selected && "bg-accent",
      )}
    >
      {emoji}
    </button>
  );
}

function stopEvent(event: SyntheticEvent): void {
  event.stopPropagation();
}

function EmojiButton({
  projectId,
  emoji,
  projectName,
  onOpen,
}: {
  projectId: string;
  emoji: string;
  projectName: string | undefined;
  onOpen: (projectId: string, anchor: HTMLElement) => void;
}) {
  const label = `Change icon for ${projectName ?? "project"}`;
  return (
    <button
      type="button"
      className={BUTTON_CLASS}
      aria-label={label}
      title={label}
      onPointerDown={stopEvent}
      onMouseDown={stopEvent}
      onKeyDown={stopEvent}
      onDoubleClick={stopEvent}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onOpen(projectId, event.currentTarget);
      }}
    >
      {emoji}
    </button>
  );
}

export function useProjectDecoration(
  store: SidebarStore,
  projectId: string,
): SidebarProjectDecoration | null {
  const { emojiByProject, colorByProject, projectNames } = useSidebarState(store);
  const tint = useSettings().values?.tint !== false;
  const emoji = emojiByProject.get(projectId);
  const projectName = projectNames.get(projectId);
  const accentColor =
    colorByProject.get(projectId) ??
    (projectName === undefined ? undefined : projectAccentColor(projectName));
  return useMemo(() => {
    if (emoji === undefined && accentColor === undefined) return null;
    return {
      ...(emoji === undefined
        ? {}
        : {
            leading: (
              <EmojiButton
                projectId={projectId}
                emoji={emoji}
                projectName={projectName}
                onOpen={store.openPicker}
              />
            ),
          }),
      ...(accentColor === undefined ? {} : { accentColor, tint }),
    };
  }, [store, projectId, emoji, projectName, accentColor, tint]);
}

/**
 * Inserts emoji buttons into the bundled sidebar's project rows, for hosts
 * without `experimental_sidebarProjectDecoration`.
 */
function useDomDecorations(store: SidebarStore, enabled: boolean): void {
  const pluginId = experimental_usePluginId();
  const { emojiByProject, projectNames } = useSidebarState(store);

  useEffect(() => {
    if (!enabled) return;
    const options = { pluginId, emojiByProject, projectNames, onOpen: store.openPicker };
    let frame: number | null = null;
    const schedule = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        decorateProjectRows(document, options);
      });
    };
    decorateProjectRows(document, options);
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [enabled, pluginId, emojiByProject, projectNames, store]);

  useEffect(() => (enabled ? () => removeDecorations(document) : undefined), [enabled]);
}

/**
 * Loads every project's emoji and color into the store and hosts the picker.
 * With `domFallback`, it also draws the emoji buttons itself.
 */
function ProjectEmojiOverlay({ store, domFallback }: { store: SidebarStore; domFallback: boolean }) {
  const rpc = useRpc<typeof rpcContract>();
  const { projects } = experimental_useSidebarThreads();
  const { emojiByProject, projectNames, picker } = useSidebarState(store);

  // Keyed on content: `projects` can change identity without changing, and
  // every store update re-renders this component.
  const projectKey = projects.map((project) => project.id).join("\n");
  const projectNamesKey = projects.map((project) => `${project.id}\t${project.name}`).join("\n");
  useEffect(() => {
    store.update({
      projectNames: new Map(projects.map((project) => [project.id, project.name])),
    });
  }, [store, projectNamesKey]);

  const refresh = useCallback(() => {
    rpc
      .call("list")
      .then(({ assignments, colors }) => {
        store.update({
          emojiByProject: new Map(
            assignments.map((assignment) => [assignment.projectId, assignment.emoji]),
          ),
          colorByProject: new Map(colors.map((pin) => [pin.projectId, pin.color])),
        });
      })
      .catch((error: unknown) => {
        console.warn("project-emoji: could not load project icons", error);
      });
  }, [rpc, store]);

  useEffect(refresh, [refresh, projectKey]);
  useRealtime(REALTIME_CHANNEL, refresh);
  useDomDecorations(store, domFallback);

  const close = useCallback(() => store.update({ picker: null }), [store]);

  const apply = useCallback(
    (projectId: string, request: Promise<{ emoji: string }>) => {
      close();
      request
        .then(({ emoji }) => {
          store.update({
            emojiByProject: new Map(store.get().emojiByProject).set(projectId, emoji),
          });
        })
        .catch((error: unknown) => {
          toast.error(`Could not change the project icon: ${errorMessage(error)}`);
        });
    },
    [store, close],
  );

  if (picker === null) return null;
  return (
    <EmojiPicker
      key={picker.projectId}
      target={picker}
      projectName={projectNames.get(picker.projectId) ?? "project"}
      current={emojiByProject.get(picker.projectId)}
      onPick={(emoji) =>
        apply(picker.projectId, rpc.call("set", { projectId: picker.projectId, emoji }))
      }
      onReset={() => apply(picker.projectId, rpc.call("reset", { projectId: picker.projectId }))}
      onClose={close}
    />
  );
}

export default definePluginApp((app) => {
  const store = createSidebarStore();
  const slots: SlotsWithProjectDecoration = app.slots;
  const hasDecorationSlot = slots.experimental_sidebarProjectDecoration !== undefined;
  slots.experimental_sidebarProjectDecoration?.({
    id: "project-emoji",
    title: "Project emoji",
    useDecoration: (projectId) => useProjectDecoration(store, projectId),
  });
  app.slots.experimental_appOverlay({
    id: "project-emoji",
    component: function ProjectEmojiAppOverlay() {
      return <ProjectEmojiOverlay store={store} domFallback={!hasDecorationSlot} />;
    },
  });
});
