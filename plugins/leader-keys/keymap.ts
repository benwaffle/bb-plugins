import { z } from "zod";

/**
 * A leader action: a bb command id (`palette.open`, `plugin:<id>/<cmd>`), one
 * of this plugin's own actions (`leader:<name>`), or a placeholder for a
 * binding bb has no API for yet (`missing:<reason>`).
 */
export type LeaderAction = string;

export const LEADER_ACTIONS = {
  cheatSheet: "leader:cheat-sheet",
  describeKey: "leader:describe-key",
  reload: "leader:reload",
  editKeymap: "leader:edit-keymap",
  universalArgument: "leader:universal-argument",
} as const;

const LEADER_ACTION_IDS: ReadonlySet<string> = new Set(Object.values(LEADER_ACTIONS));

export type ActionKind = "core" | "plugin" | "leader" | "missing";

export function actionKind(action: LeaderAction): ActionKind {
  if (action.startsWith("missing:")) return "missing";
  if (action.startsWith("leader:")) return "leader";
  if (action.startsWith("plugin:")) return "plugin";
  return "core";
}

const CORE_COMMAND_ID = /^[a-zA-Z]+(\.[a-zA-Z0-9]+)+$/u;
const PLUGIN_COMMAND_ID = /^plugin:[a-z0-9][a-z0-9-]*\/[a-zA-Z0-9_-]+$/u;

export function isValidAction(action: string): boolean {
  if (action.startsWith("leader:")) return LEADER_ACTION_IDS.has(action);
  if (action.startsWith("missing:")) return action.length > "missing:".length;
  return CORE_COMMAND_ID.test(action) || PLUGIN_COMMAND_ID.test(action);
}

/** Commands that a count repeats; every other command runs once. */
const REPEATABLE: ReadonlySet<string> = new Set([
  "thread.next",
  "thread.previous",
  "panel.nextTab",
  "panel.previousTab",
  "pane.focus.left",
  "pane.focus.right",
  "pane.focus.up",
  "pane.focus.down",
  "pane.focus.next",
  "pane.focus.previous",
  "history.back",
  "history.forward",
]);

export function isRepeatable(action: LeaderAction): boolean {
  return REPEATABLE.has(action);
}

export interface LeafNode {
  kind: "leaf";
  action: LeaderAction;
  label: string;
  custom: boolean;
}

export interface PrefixNode {
  kind: "prefix";
  label: string;
  children: Map<string, KeyNode>;
}

export type KeyNode = LeafNode | PrefixNode;

type DefaultEntry = readonly [keys: string, action: LeaderAction, label: string];

const DEFAULT_PREFIX_LABELS: Readonly<Record<string, string>> = {
  f: "thread",
  p: "project",
  b: "tab",
  w: "pane",
  g: "git",
  s: "search",
  t: "toggle",
  h: "help",
  m: "model",
  o: "open",
  q: "quit/reload",
  x: "extra",
};

const DEFAULT_BINDINGS: readonly DefaultEntry[] = [
  ["SPC", "thread.search", "Switch thread"],
  [",", "thread.search", "Recent threads"],
  [".", "file.quickOpen", "Open file"],
  [":", "palette.open", "Command palette"],
  ["/", "window.find", "Find in thread"],
  ["`", "history.back", "Previous thread"],
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(
    (n): DefaultEntry => [String(n), `thread.jump.${n}`, `Thread ${n}`],
  ),
  ["TAB", "composer.focus", "Focus composer"],
  ["u", LEADER_ACTIONS.universalArgument, "Universal argument"],

  ["f n", "thread.new", "New thread"],
  ["f N", "window.new", "New window"],
  ["f f", "thread.search", "Find thread"],
  ["f r", "thread.search", "Recent threads"],
  ["f R", "thread.rename", "Rename thread"],
  ["f a", "thread.archive", "Archive thread"],
  ["f A", "missing:thread action unarchive", "Unarchive thread"],
  ["f p", "thread.pin", "Pin or unpin thread"],
  ["f m", "thread.markRead", "Mark read"],
  ["f c", "missing:thread action copy link", "Copy thread link"],
  ["f s", "missing:thread action open in split", "Open in split"],
  ["f j", "thread.next", "Next thread"],
  ["f k", "thread.previous", "Previous thread"],
  ["f [", "history.back", "Back"],
  ["f ]", "history.forward", "Forward"],

  ["p p", "missing:project picker", "Switch project"],
  ["p n", "missing:project picker", "New thread in project"],
  ["p o", "workspace.openPreferred", "Open in editor"],
  ["p t", "terminal.open", "Terminal"],

  ["b b", "missing:panel tab picker", "Switch tab"],
  ["b n", "panel.nextTab", "Next tab"],
  ["b p", "panel.previousTab", "Previous tab"],
  ["b c", "panel.newTab", "New tab"],
  ["b d", "panel.close", "Close tab"],
  ["b u", "panel.reopenClosedTab", "Reopen closed tab"],
  ["b f", "panel.fullScreen.toggle", "Full-screen panel"],

  ["w h", "pane.focus.left", "Pane left"],
  ["w j", "pane.focus.down", "Pane down"],
  ["w k", "pane.focus.up", "Pane up"],
  ["w l", "pane.focus.right", "Pane right"],
  ["w w", "pane.focus.next", "Next pane"],
  ["w W", "pane.focus.previous", "Previous pane"],
  ...[1, 2, 3, 4, 5, 6, 7, 8].map(
    (n): DefaultEntry => [`w ${n}`, `pane.focus.${n}`, `Pane ${n}`],
  ),
  ["w v", "missing:thread action open in split", "Split"],
  ["w s", "missing:thread action open in split", "Split"],
  ["w d", "pane.close", "Close pane"],
  ["w m", "pane.maximize.toggle", "Maximize pane"],

  ["g d", "plugin:bb--git/toggle-diff", "Toggle diff"],
  ["g g", "plugin:bb--git/toggle-diff", "Changes"],

  ["s s", "window.find", "Find in thread"],
  ["s t", "thread.search", "Search threads"],
  ["s p", "palette.open", "Command palette"],
  ["s f", "file.quickOpen", "Find file"],
  ["s r", "plugin:telecom-ref/search", "Telecom reference"],

  ["t s", "sidebar.toggle", "Sidebar"],
  ["t p", "panel.toggle", "Side panel"],
  ["t f", "panel.fullScreen.toggle", "Full-screen panel"],
  ["t 2", "missing:thread-list command", "Two-line rows"],
  ["t d", "missing:thread-list command", "Day labels"],
  ["t t", "missing:theme command", "Light/dark theme"],

  ["h b", LEADER_ACTIONS.cheatSheet, "Cheat sheet"],
  ["h k", LEADER_ACTIONS.describeKey, "Describe key"],
  ["h c", LEADER_ACTIONS.editKeymap, "Edit keymap"],
  ["h r", LEADER_ACTIONS.reload, "Reload keymap"],
  ["h K", "settings.open", "Keyboard settings"],

  ["m m", "modelPicker.toggle", "Model picker"],
  ["m n", "modelPicker.cycleModel", "Next model"],
  ["m p", "modelPicker.cycleProvider", "Next provider"],
  ["m r", "modelPicker.cycleReasoning", "Next reasoning effort"],

  ["o t", "terminal.open", "Terminal"],
  ["o s", "settings.open", "Settings"],
  ["o n", "notifications.open", "Notifications"],
  ["o l", "logs.openServerDaemon", "Server logs"],
  ["o d", "dataDirectory.open", "Data directory"],

  ["q r", "window.reload", "Reload window"],
  ["q s", "plugins.enterSafeMode", "Plugin safe mode on"],
  ["q S", "plugins.exitSafeMode", "Plugin safe mode off"],
];

const KEY_ALIASES: Readonly<Record<string, string>> = {
  SPC: "SPC",
  Space: "SPC",
  TAB: "TAB",
  Tab: "TAB",
};

/** Splits `"f R"` into `["f", "R"]`; null when a token is not a single key. */
export function parseKeyPath(path: string): string[] | null {
  const tokens = path.trim().split(/\s+/u).filter((token) => token !== "");
  if (tokens.length === 0) return null;
  const keys: string[] = [];
  for (const token of tokens) {
    const alias = KEY_ALIASES[token];
    if (alias !== undefined) keys.push(alias);
    else if ([...token].length === 1) keys.push(token);
    else return null;
  }
  return keys;
}

export function formatKeyPath(keys: readonly string[]): string {
  return keys.join(" ");
}

export const DEFAULT_FALLBACK = { key: "Space", alt: true } as const;

const chordSchema = z
  .object({
    key: z.string().min(1),
    alt: z.boolean().optional(),
    ctrl: z.boolean().optional(),
    meta: z.boolean().optional(),
    shift: z.boolean().optional(),
  })
  .strict();

const bindingValueSchema = z.union([
  z.string(),
  z.null(),
  z.object({ command: z.string(), label: z.string().optional() }).strict(),
]);

export const keymapFileSchema = z
  .object({
    fallback: z.union([chordSchema, z.null()]).optional(),
    whichKeyDelayMs: z.number().int().min(0).max(10_000).optional(),
    timeoutMs: z.number().int().min(0).max(60_000).optional(),
    terminalFallback: z.boolean().optional(),
    bindings: z.record(z.string(), bindingValueSchema).optional(),
    labels: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export type KeymapFile = z.infer<typeof keymapFileSchema>;

export interface FallbackChord {
  key: string;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
}

export interface Keymap {
  root: PrefixNode;
  fallback: FallbackChord | null;
  whichKeyDelayMs: number;
  timeoutMs: number;
  terminalFallback: boolean;
  errors: string[];
}

function emptyPrefix(label: string): PrefixNode {
  return { kind: "prefix", label, children: new Map() };
}

function prefixLabel(keys: readonly string[], labels: Readonly<Record<string, string>>): string {
  const path = formatKeyPath(keys);
  return labels[path] ?? DEFAULT_PREFIX_LABELS[path] ?? path;
}

function bind(
  root: PrefixNode,
  keys: readonly string[],
  leaf: LeafNode | null,
  labels: Readonly<Record<string, string>>,
): string | null {
  let node = root;
  for (let index = 0; index < keys.length - 1; index += 1) {
    const key = keys[index]!;
    const next = node.children.get(key);
    if (next === undefined) {
      if (leaf === null) return null;
      const created = emptyPrefix(prefixLabel(keys.slice(0, index + 1), labels));
      node.children.set(key, created);
      node = created;
    } else if (next.kind === "leaf") {
      return `"${formatKeyPath(keys)}" needs "${formatKeyPath(keys.slice(0, index + 1))}" to be a prefix, but it runs ${next.action}`;
    } else {
      node = next;
    }
  }
  const last = keys[keys.length - 1]!;
  const existing = node.children.get(last);
  if (leaf === null) {
    node.children.delete(last);
    return null;
  }
  if (existing?.kind === "prefix" && existing.children.size > 0) {
    return `"${formatKeyPath(keys)}" is a prefix; unbind its keys before binding it to ${leaf.action}`;
  }
  node.children.set(last, leaf);
  return null;
}

function toChord(value: z.infer<typeof chordSchema>): FallbackChord {
  const key = KEY_ALIASES[value.key] === "SPC" ? "Space" : value.key;
  return {
    key,
    alt: value.alt ?? false,
    ctrl: value.ctrl ?? false,
    meta: value.meta ?? false,
    shift: value.shift ?? false,
  };
}

export function buildKeymap(file: KeymapFile | null, parseErrors: readonly string[] = []): Keymap {
  const errors = [...parseErrors];
  const labels = file?.labels ?? {};
  const root = emptyPrefix("leader");
  for (const prefix of Object.keys(DEFAULT_PREFIX_LABELS)) {
    root.children.set(prefix, emptyPrefix(prefixLabel([prefix], labels)));
  }
  for (const [path, action, label] of DEFAULT_BINDINGS) {
    const keys = parseKeyPath(path);
    if (keys === null) throw new Error(`invalid default key path ${path}`);
    const error = bind(root, keys, { kind: "leaf", action, label, custom: false }, labels);
    if (error !== null) throw new Error(error);
  }
  for (const [path, value] of Object.entries(file?.bindings ?? {})) {
    const keys = parseKeyPath(path);
    if (keys === null) {
      errors.push(`"${path}" is not a key path; separate single keys with spaces, e.g. "f R"`);
      continue;
    }
    if (value === null) {
      bind(root, keys, null, labels);
      continue;
    }
    const command = typeof value === "string" ? value : value.command;
    if (!isValidAction(command)) {
      errors.push(`"${path}": "${command}" is not a bb command id, a plugin:<id>/<command> id, or a leader:* action`);
      continue;
    }
    const label = typeof value === "string" ? command : (value.label ?? command);
    const error = bind(root, keys, { kind: "leaf", action: command, label, custom: true }, labels);
    if (error !== null) errors.push(error);
  }
  for (const [path, label] of Object.entries(labels)) {
    const keys = parseKeyPath(path);
    const node = keys === null ? undefined : lookup(root, keys);
    if (node?.kind === "prefix") node.label = label;
    else if (node?.kind === "leaf") node.label = label;
  }
  return {
    root,
    fallback:
      file?.fallback === null
        ? null
        : toChord(file?.fallback ?? DEFAULT_FALLBACK),
    whichKeyDelayMs: file?.whichKeyDelayMs ?? 300,
    timeoutMs: file?.timeoutMs ?? 4000,
    terminalFallback: file?.terminalFallback ?? true,
    errors,
  };
}

/** Parses the keymap.json text; null text means the file does not exist. */
export function parseKeymap(text: string | null): Keymap {
  if (text === null || text.trim() === "") return buildKeymap(null);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return buildKeymap(null, [`keymap.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`]);
  }
  const parsed = keymapFileSchema.safeParse(json);
  if (!parsed.success) {
    return buildKeymap(
      null,
      parsed.error.issues.map((issue) => `keymap.json ${issue.path.join(".") || "(root)"}: ${issue.message}`),
    );
  }
  return buildKeymap(parsed.data);
}

export function lookup(root: PrefixNode, keys: readonly string[]): KeyNode | undefined {
  let node: KeyNode = root;
  for (const key of keys) {
    if (node.kind !== "prefix") return undefined;
    const next: KeyNode | undefined = node.children.get(key);
    if (next === undefined) return undefined;
    node = next;
  }
  return node;
}

const KEY_ORDER = (key: string): string => {
  if (key === "SPC") return "0";
  if (key === "TAB") return "1";
  if (/^[0-9]$/u.test(key)) return `2${key}`;
  if (/^[a-z]$/u.test(key)) return `3${key}0`;
  if (/^[A-Z]$/u.test(key)) return `3${key.toLowerCase()}1`;
  return `4${key}`;
};

/** A prefix's children in which-key order: SPC, TAB, digits, letters (a A b B…), punctuation. */
export function sortedChildren(node: PrefixNode): [string, KeyNode][] {
  return [...node.children.entries()].sort(([left], [right]) =>
    KEY_ORDER(left).localeCompare(KEY_ORDER(right)),
  );
}

export interface FlatBinding {
  keys: string[];
  action: LeaderAction;
  label: string;
  custom: boolean;
}

export function flattenKeymap(root: PrefixNode, prefix: string[] = []): FlatBinding[] {
  const rows: FlatBinding[] = [];
  for (const [key, node] of sortedChildren(root)) {
    const keys = [...prefix, key];
    if (node.kind === "leaf") rows.push({ keys, action: node.action, label: node.label, custom: node.custom });
    else rows.push(...flattenKeymap(node, keys));
  }
  return rows;
}
