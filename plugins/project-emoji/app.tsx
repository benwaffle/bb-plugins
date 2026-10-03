import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  definePluginApp,
  experimental_usePluginId,
  experimental_useSidebarThreads,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { REALTIME_CHANNEL } from "./channel";
import type { rpcContract } from "./contract";
import { decorateProjectRows, removeDecorations } from "./decorate";
import { parseEmoji, searchEmoji } from "./emoji";

interface PickerTarget {
  readonly projectId: string;
  readonly anchor: HTMLElement;
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

function ProjectEmojiOverlay() {
  const rpc = useRpc<typeof rpcContract>();
  const pluginId = experimental_usePluginId();
  const { projects } = experimental_useSidebarThreads();
  const [emojiByProject, setEmojiByProject] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const [target, setTarget] = useState<PickerTarget | null>(null);

  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );
  const projectKey = projects.map((project) => project.id).join("\n");

  const refresh = useCallback(() => {
    rpc
      .call("list")
      .then(({ assignments }) => {
        setEmojiByProject(
          new Map(assignments.map((assignment) => [assignment.projectId, assignment.emoji])),
        );
      })
      .catch((error: unknown) => {
        console.warn("project-emoji: could not load project icons", error);
      });
  }, [rpc]);

  useEffect(refresh, [refresh, projectKey]);
  useRealtime(REALTIME_CHANNEL, refresh);

  const openPicker = useCallback((projectId: string, anchor: HTMLElement) => {
    setTarget({ projectId, anchor });
  }, []);

  useEffect(() => {
    const options = { pluginId, emojiByProject, projectNames, onOpen: openPicker };
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
  }, [pluginId, emojiByProject, projectNames, openPicker]);

  useEffect(() => () => removeDecorations(document), []);

  const apply = useCallback(
    (projectId: string, request: Promise<{ emoji: string }>) => {
      setTarget(null);
      request
        .then(({ emoji }) => {
          setEmojiByProject((previous) => new Map(previous).set(projectId, emoji));
        })
        .catch((error: unknown) => {
          toast.error(`Could not change the project icon: ${errorMessage(error)}`);
        });
    },
    [],
  );

  if (target === null) return null;
  return (
    <EmojiPicker
      key={target.projectId}
      target={target}
      projectName={projectNames.get(target.projectId) ?? "project"}
      current={emojiByProject.get(target.projectId)}
      onPick={(emoji) =>
        apply(target.projectId, rpc.call("set", { projectId: target.projectId, emoji }))
      }
      onReset={() => apply(target.projectId, rpc.call("reset", { projectId: target.projectId }))}
      onClose={() => setTarget(null)}
    />
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({
    id: "project-emoji",
    component: ProjectEmojiOverlay,
  });
});
