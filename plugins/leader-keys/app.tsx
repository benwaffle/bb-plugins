import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRpc,
  type ExperimentalPageTitle,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./contract";
import { hostCapabilities, type HostAppCommands } from "./host";
import {
  LEADER_ACTIONS,
  actionKind,
  flattenKeymap,
  formatKeyPath,
  lookup,
  parseKeymap,
  sortedChildren,
  type FlatBinding,
  type Keymap,
  type PrefixNode,
} from "./keymap";
import {
  IDLE,
  echo,
  reduce,
  startLeader,
  type Disposition,
  type Effect,
  type FocusKind,
  type KeyInput,
  type LeaderState,
} from "./machine";
import { indexCommands, isMacPlatform, shortcutFits, type CommandEntry } from "./shortcuts";
import { describeAction, type ActionView } from "./actions";

const CHEAT_SHEET_PATH = "cheat-sheet";
const FLASH_MS = 2500;

// ---------------------------------------------------------------------------
// Window-wide store: the keymap, the file it came from, and the overlay's controls.

interface KeymapSnapshot {
  keymap: Keymap;
  path: string | null;
  loaded: boolean;
}

let snapshot: KeymapSnapshot = { keymap: parseKeymap(null), path: null, loaded: false };
const listeners = new Set<() => void>();

function setSnapshot(next: KeymapSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function useKeymapSnapshot(): KeymapSnapshot {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
  );
}

interface OverlayControls {
  start(): void;
  reload(): void;
}

let controls: OverlayControls | null = null;

// ---------------------------------------------------------------------------
// DOM classification for the state machine.

const OPEN_MODAL_SELECTOR = [
  '[aria-modal="true"]:not([inert]):not([inert] *):not([data-state="closed"])',
  '[role="dialog"][data-state="open"]:not([inert]):not([inert] *)',
].join(", ");

const EDITABLE_SELECTOR = [
  "input",
  "textarea",
  "select",
  "[contenteditable]:not([contenteditable='false'])",
  "[role='textbox']",
  "[role='combobox']",
].join(", ");

const INTERACTIVE_SELECTOR = [
  "button",
  "summary",
  "a[href]",
  "[role='button']",
  "[role='menuitem']",
  "[role='menuitemcheckbox']",
  "[role='menuitemradio']",
  "[role='option']",
  "[role='tab']",
  "[role='checkbox']",
  "[role='switch']",
  "[role='radio']",
  "[role='slider']",
].join(", ");

function focusKind(target: EventTarget | null): FocusKind {
  if (!(target instanceof Element)) return "body";
  const tag = target.tagName.toLowerCase();
  if (tag === "body" || tag === "html") return "body";
  if (target.closest("[data-app-terminal]") !== null) return "terminal";
  if (target.closest(EDITABLE_SELECTOR) !== null) return "editable";
  if (target.closest(INTERACTIVE_SELECTOR) !== null) return "interactive";
  return "body";
}

function toInput(event: KeyboardEvent): KeyInput {
  return {
    type: event.type === "keyup" ? "keyup" : "keydown",
    key: event.key,
    code: event.code,
    alt: event.altKey,
    ctrl: event.ctrlKey,
    meta: event.metaKey,
    shift: event.shiftKey,
    repeat: event.repeat,
    composing: event.isComposing,
    defaultPrevented: event.defaultPrevented,
    focus: focusKind(event.target),
    modalOpen: document.querySelector(OPEN_MODAL_SELECTOR) !== null,
    questionOpen: document.querySelector("[data-question-form]") !== null,
    time: event.timeStamp,
  };
}

function applyDisposition(event: KeyboardEvent, disposition: Disposition): void {
  if (disposition === "pass") return;
  event.preventDefault();
  if (disposition === "swallow") event.stopPropagation();
  if (disposition === "own") event.stopImmediatePropagation();
}

// ---------------------------------------------------------------------------
// Availability, shared by which-key and the cheat sheet.

const MAC = typeof navigator !== "undefined" && isMacPlatform(navigator.platform);

function commandIndex(commands: HostAppCommands | null): Map<string, CommandEntry> {
  if (commands === null) return new Map();
  try {
    return indexCommands(commands.list(), MAC);
  } catch (error) {
    console.warn("leader-keys: could not list bb commands", error);
    return new Map();
  }
}

// ---------------------------------------------------------------------------
// The overlay: key capture, which-key strip, status chip.

const capabilities = hostCapabilities();

function useOptionalAppCommands(): HostAppCommands | null {
  return capabilities.useAppCommands === null ? null : capabilities.useAppCommands();
}

function useOptionalLeaderKeyCommand(handler: () => boolean): void {
  capabilities.useLeaderKeyCommand?.(handler);
}

function useKeymapLoader(): () => void {
  const rpc = useRpc<typeof rpcContract>();
  const reload = useCallback(() => {
    rpc
      .call("keymap")
      .then(({ path, text }) => setSnapshot({ keymap: parseKeymap(text), path, loaded: true }))
      .catch((error: unknown) => {
        console.warn("leader-keys: could not read keymap.json", error);
        setSnapshot({ ...snapshot, loaded: true });
      });
  }, [rpc]);
  useEffect(reload, [reload]);
  return reload;
}

function LeaderOverlay() {
  const { keymap } = useKeymapSnapshot();
  const reload = useKeymapLoader();
  const navigate = useBbNavigate();
  const commands = useOptionalAppCommands();
  const [state, setState] = useState<LeaderState>(IDLE);
  const [flash, setFlash] = useState<string | null>(null);
  const [whichKey, setWhichKey] = useState(false);
  const stateRef = useRef<LeaderState>(IDLE);
  const keymapRef = useRef(keymap);
  keymapRef.current = keymap;
  const commandsRef = useRef(commands);
  commandsRef.current = commands;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showFlash = useCallback((message: string) => {
    if (flashTimer.current !== null) clearTimeout(flashTimer.current);
    setFlash(message);
    flashTimer.current = setTimeout(() => setFlash(null), FLASH_MS);
  }, []);

  const transition = useCallback((next: LeaderState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const runEffect = useCallback(
    (effect: Effect) => {
      const path = (keys: readonly string[]) => `SPC ${formatKeyPath(keys)}`;
      switch (effect.type) {
        case "undefined":
          showFlash(`${path(effect.keys)} is undefined`);
          return;
        case "cheat-sheet":
          navigateRef.current.toPluginPanel(CHEAT_SHEET_PATH);
          return;
        case "describe":
          showFlash(
            effect.action === null
              ? `${path(effect.keys)} is undefined`
              : `${path(effect.keys)} runs ${effect.action}`,
          );
          return;
        case "run":
          break;
      }
      const { action, times } = effect;
      switch (action) {
        case LEADER_ACTIONS.cheatSheet:
          navigateRef.current.toPluginPanel(CHEAT_SHEET_PATH);
          return;
        case LEADER_ACTIONS.reload:
          reload();
          showFlash("Keymap reloaded");
          return;
        case LEADER_ACTIONS.editKeymap:
          showFlash(snapshot.path === null ? "keymap.json path unknown" : `Edit ${snapshot.path}`);
          return;
      }
      const kind = actionKind(action);
      if (kind === "missing") {
        showFlash(`${path(effect.keys)} needs a bb API (${action.slice("missing:".length)})`);
        return;
      }
      const host = commandsRef.current;
      if (host === null) {
        showFlash(`${path(effect.keys)} needs the bb fork to run ${action}`);
        return;
      }
      for (let run = 0; run < times; run += 1) {
        if (!host.execute(action)) {
          if (run === 0) showFlash(`${action} is not available here`);
          return;
        }
      }
    },
    [reload, showFlash],
  );

  const handleKey = useCallback(
    (event: KeyboardEvent) => {
      const result = reduce(stateRef.current, toInput(event), keymapRef.current);
      applyDisposition(event, result.disposition);
      if (result.state !== stateRef.current) transition(result.state);
      for (const effect of result.effects) runEffect(effect);
    },
    [runEffect, transition],
  );

  const start = useCallback(() => {
    transition(startLeader(stateRef.current));
  }, [transition]);

  useOptionalLeaderKeyCommand(
    useCallback(() => {
      start();
      return true;
    }, [start]),
  );

  useEffect(() => {
    controls = { start, reload };
    return () => {
      if (controls?.start === start) controls = null;
    };
  }, [reload, start]);

  useEffect(() => {
    const cancel = () => transition(IDLE);
    window.addEventListener("keydown", handleKey, true);
    window.addEventListener("keyup", handleKey, true);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", handleKey, true);
      window.removeEventListener("keyup", handleKey, true);
      window.removeEventListener("blur", cancel);
    };
  }, [handleKey, transition]);

  const pendingKeys = state.mode === "pending" ? formatKeyPath(state.keys) : null;
  useEffect(() => {
    setWhichKey(false);
    if (pendingKeys === null) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    if (keymap.whichKeyDelayMs > 0) {
      timers.push(setTimeout(() => setWhichKey(true), keymap.whichKeyDelayMs));
    } else if (keymap.timeoutMs > 0) {
      timers.push(setTimeout(() => transition(IDLE), keymap.timeoutMs));
    }
    return () => timers.forEach(clearTimeout);
  }, [keymap.timeoutMs, keymap.whichKeyDelayMs, pendingKeys, state, transition]);

  useEffect(() => {
    if (state.mode !== "count") return;
    const timer = setTimeout(() => transition(IDLE), keymap.timeoutMs || 4000);
    return () => clearTimeout(timer);
  }, [keymap.timeoutMs, state, transition]);

  const chip = echo(state) ?? flash;
  const node = state.mode === "pending" ? lookup(keymap.root, state.keys) : undefined;
  return (
    <>
      {whichKey && node?.kind === "prefix" && state.mode === "pending" ? (
        <WhichKey node={node} keys={state.keys} commands={commands} />
      ) : null}
      {chip !== null ? (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none fixed right-3 bottom-3 z-[2147483000] rounded-md border border-border bg-popover px-2 py-1 font-mono text-xs text-popover-foreground shadow-md"
        >
          {chip}
        </div>
      ) : null}
    </>
  );
}

const PREFIX_VIEW: ActionView = { status: "ok", note: null, shortcut: null };

function WhichKey({ node, keys, commands }: { node: PrefixNode; keys: string[]; commands: HostAppCommands | null }) {
  const index = useMemo(() => commandIndex(commands), [commands, node]);
  const entries = sortedChildren(node);
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-3 left-1/2 z-[2147482999] w-max max-w-[min(360px,calc(100vw-24px))] -translate-x-1/2 rounded-lg border border-border bg-popover px-3 pt-2 pb-2.5 text-popover-foreground shadow-lg"
    >
      <div className="mb-1.5 flex min-w-0 items-baseline gap-2 text-xs text-muted-foreground">
        <span className="shrink-0 font-mono font-semibold text-foreground">SPC {formatKeyPath(keys)}</span>
        <span className="truncate">{node.label}</span>
      </div>
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-2.5 gap-y-0.5 text-xs">
        {entries.map(([key, child]) => {
          const { status, note, shortcut } =
            child.kind === "leaf" ? describeAction(child.action, commands, index) : PREFIX_VIEW;
          const label = child.kind === "prefix" ? `+${child.label}` : child.label;
          const description = note === null ? label : `${label} (${note})`;
          const showShortcut = shortcut !== null && shortcut !== "no shortcut" && shortcutFits(description, shortcut);
          const dim = status === "ok" ? "" : "opacity-40";
          return (
            <Fragment key={key}>
              <span className={`text-right font-mono font-semibold ${dim}`}>{key}</span>
              <span className={`pointer-events-auto flex min-w-0 items-baseline gap-2 ${dim}`} title={showShortcut || shortcut === null ? description : `${description} · ${shortcut}`}>
                <span className={`line-clamp-2 min-w-0 break-words ${child.kind === "prefix" ? "text-primary" : ""}`}>
                  {label}
                  {note === null ? null : <span className="text-muted-foreground"> ({note})</span>}
                </span>
                {showShortcut ? (
                  <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">{shortcut}</span>
                ) : null}
              </span>
            </Fragment>
          );
        })}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
        <span>ESC cancel</span>
        <span>BS up</span>
        <span>? cheat sheet</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cheat sheet page.

function groupRows(rows: readonly FlatBinding[], root: PrefixNode): { title: string; prefix: string; rows: FlatBinding[] }[] {
  const groups = new Map<string, { title: string; prefix: string; rows: FlatBinding[] }>();
  for (const row of rows) {
    const top = row.keys.length > 1 ? row.keys[0]! : "";
    let group = groups.get(top);
    if (group === undefined) {
      const node = top === "" ? undefined : root.children.get(top);
      group = {
        title: top === "" ? "Root" : node?.label ?? top,
        prefix: top === "" ? "SPC" : `SPC ${top}`,
        rows: [],
      };
      groups.set(top, group);
    }
    group.rows.push(row);
  }
  return [...groups.values()];
}

function CheatSheetPanel() {
  const { keymap, path } = useKeymapSnapshot();
  const commands = useOptionalAppCommands();
  const [query, setQuery] = useState("");
  const index = useMemo(() => commandIndex(commands), [commands, keymap]);
  const rows = useMemo(() => flattenKeymap(keymap.root), [keymap]);
  const needle = query.trim().toLowerCase();
  const filtered = needle === ""
    ? rows
    : rows.filter((row) =>
        `${formatKeyPath(row.keys)} ${row.label} ${row.action}`.toLowerCase().includes(needle),
      );
  const groups = groupRows(filtered, keymap.root);
  const fallback = keymap.fallback;
  return (
    <div className="mx-auto max-w-6xl px-6 py-5 text-sm">
      <div className="mb-4 flex flex-wrap items-center gap-4">
        <h1 className="text-base font-semibold">Leader keys</h1>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter keys, names or commands"
          className="w-72 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm"
        />
        <span className="text-xs text-muted-foreground">
          Leader: tap Space outside text fields
          {fallback === null ? "" : `, or ${fallback.ctrl ? "Ctrl+" : ""}${fallback.meta ? "Cmd+" : ""}${fallback.alt ? "Option+" : ""}${fallback.shift ? "Shift+" : ""}${fallback.key} anywhere`}
          . Type a count first to repeat movement.
        </span>
      </div>
      {commands === null ? (
        <p className="mb-4 rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
          This bb has no command API for plugins, so entries marked “needs fork” cannot run. The cheat sheet,
          describe-key and reload still work.
        </p>
      ) : null}
      {keymap.errors.length > 0 ? (
        <ul className="mb-4 list-disc rounded-md border border-destructive px-6 py-2 text-xs text-destructive">
          {keymap.errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : null}
      <div className="columns-3 gap-6">
        {groups.map((group) => (
          <section key={group.prefix} className="mb-4 break-inside-avoid">
            <h2 className="mb-1.5 flex items-baseline gap-2 text-xs font-semibold text-primary">
              <code className="font-mono">{group.prefix}</code>
              {group.title}
            </h2>
            <table className="w-full border-collapse text-xs">
              <tbody>
                {group.rows.map((row) => {
                  const { status, note, shortcut } = describeAction(row.action, commands, index);
                  return (
                    <tr key={formatKeyPath(row.keys)} className="border-b border-border">
                      <td className="py-1 pr-2 whitespace-nowrap font-mono">
                        {formatKeyPath(row.keys)}
                        {shortcut === null ? null : (
                          <span
                            className={`ml-2 text-[11px] text-muted-foreground ${status === "needs-fork" ? "opacity-50" : ""}`}
                          >
                            {shortcut}
                          </span>
                        )}
                      </td>
                      <td className={`py-1 ${status === "ok" || status === "unavailable" ? "" : "opacity-50"}`}>
                        {row.label}
                        {row.custom ? <span className="text-muted-foreground"> • custom</span> : null}
                        {note === null || status === "unavailable" ? null : (
                          <span className="text-muted-foreground"> ({note})</span>
                        )}
                      </td>
                      <td className="py-1 text-right font-mono text-muted-foreground">{row.action}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        ))}
      </div>
      <p className="mt-4 text-xs text-muted-foreground">
        Override bindings in {path ?? "keymap.json in this plugin's data directory"}, then run “Leader keys: reload
        keymap” or SPC h r. `bb leader-keys list` prints the same map.
      </p>
    </div>
  );
}

function CheatSheetPage() {
  useKeymapLoader();
  return <CheatSheetPanel />;
}

function useCheatSheetTitle(): ExperimentalPageTitle {
  return { title: "Leader keys" };
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "leader", component: LeaderOverlay });
  app.slots.navPanel({
    id: "cheat-sheet",
    title: "Leader keys",
    icon: "Keyboard",
    path: CHEAT_SHEET_PATH,
    component: CheatSheetPage,
    experimental_usePageTitle: useCheatSheetTitle,
  });
  app.commands.register({
    id: "leader",
    title: "Leader keys: start a leader sequence",
    run: () => controls?.start(),
  });
  app.commands.register({
    id: "reload-keymap",
    title: "Leader keys: reload keymap",
    run: () => controls?.reload(),
  });
});
