import {
  LEADER_ACTIONS,
  formatKeyPath,
  isRepeatable,
  lookup,
  type FallbackChord,
  type Keymap,
  type LeaderAction,
} from "./keymap";

/** Where focus was when a key arrived, as the content script classifies it. */
export type FocusKind = "body" | "interactive" | "editable" | "terminal";

export interface KeyInput {
  type: "keydown" | "keyup";
  key: string;
  code: string;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  repeat: boolean;
  composing: boolean;
  defaultPrevented: boolean;
  focus: FocusKind;
  modalOpen: boolean;
  questionOpen: boolean;
  time: number;
}

export type LeaderState =
  | { mode: "idle" }
  | { mode: "count"; count: number }
  | { mode: "armed"; since: number; count: number | null }
  | {
      mode: "pending";
      keys: string[];
      count: number | null;
      describe: boolean;
      universal: boolean;
    };

export const IDLE: LeaderState = { mode: "idle" };

/** What the content script does with the DOM event. */
export type Disposition =
  /** Leave the event alone. */
  | "pass"
  /** preventDefault only: other window listeners such as push-to-talk still see it. */
  | "prevent"
  /** preventDefault + stopPropagation: no element listener sees it, window listeners still do. */
  | "swallow"
  /** preventDefault + stopImmediatePropagation. */
  | "own";

export type Effect =
  | { type: "run"; action: LeaderAction; times: number; keys: string[] }
  | { type: "describe"; keys: string[]; action: LeaderAction | null }
  | { type: "undefined"; keys: string[] }
  | { type: "cheat-sheet" };

export interface Step {
  state: LeaderState;
  disposition: Disposition;
  effects: Effect[];
}

/** A Space held this long belongs to push-to-talk. */
export const SPACE_HOLD_MS = 200;
const MAX_COUNT = 99;
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn", "AltGraph", "OS"]);

function step(state: LeaderState, disposition: Disposition, effects: Effect[] = []): Step {
  return { state, disposition, effects };
}

function isSpace(input: Pick<KeyInput, "key" | "code">): boolean {
  return input.code === "Space" || input.key === " " || input.key === "Spacebar";
}

function hasModifier(input: KeyInput): boolean {
  return input.alt || input.ctrl || input.meta || input.shift;
}

export function matchesFallback(input: KeyInput, chord: FallbackChord | null): boolean {
  if (chord === null) return false;
  const keyMatches =
    chord.key === "Space"
      ? isSpace(input)
      : input.key.toLowerCase() === chord.key.toLowerCase() || input.code === `Key${chord.key.toUpperCase()}`;
  return (
    keyMatches &&
    input.alt === chord.alt &&
    input.ctrl === chord.ctrl &&
    input.meta === chord.meta &&
    input.shift === chord.shift
  );
}

/** The keymap token for a key typed while a sequence is pending, or null for keys the keymap cannot name. */
export function keyToken(input: Pick<KeyInput, "key" | "code" | "alt" | "ctrl" | "meta">): string | null {
  if (input.ctrl || input.meta) return null;
  if (isSpace(input)) return "SPC";
  if (input.key === "Tab") return "TAB";
  if (input.alt) {
    const letter = /^Key([A-Z])$/u.exec(input.code);
    if (letter) return null;
  }
  return [...input.key].length === 1 ? input.key : null;
}

type PendingState = LeaderState & { mode: "pending" };

export function pending(count: number | null = null): PendingState {
  return { mode: "pending", keys: [], count, describe: false, universal: false };
}

/** Starts a sequence from outside the keyboard: bb's Leader key command or the palette. */
export function startLeader(state: LeaderState): LeaderState {
  if (state.mode === "pending") return state;
  return pending(state.mode === "count" || state.mode === "armed" ? state.count : null);
}

function canStartFallback(input: KeyInput, keymap: Keymap): boolean {
  if (input.modalOpen) return false;
  if (input.focus === "terminal" && !keymap.terminalFallback) return false;
  return matchesFallback(input, keymap.fallback);
}

function handleIdle(state: LeaderState & { mode: "idle" | "count" }, input: KeyInput, keymap: Keymap): Step {
  if (input.type !== "keydown" || input.repeat || input.composing) return step(state, "pass");
  if (canStartFallback(input, keymap)) {
    return step(pending(state.mode === "count" ? state.count : null), "own");
  }
  if (input.defaultPrevented || input.modalOpen || input.focus !== "body") return step(IDLE, "pass");
  if (isSpace(input) && !hasModifier(input)) {
    return step({ mode: "armed", since: input.time, count: state.mode === "count" ? state.count : null }, "prevent");
  }
  if (!input.questionOpen && !hasModifier(input) && /^[0-9]$/u.test(input.key)) {
    const digit = Number(input.key);
    if (state.mode === "idle") return digit === 0 ? step(IDLE, "pass") : step({ mode: "count", count: digit }, "pass");
    return step({ mode: "count", count: Math.min(MAX_COUNT, state.count * 10 + digit) }, "pass");
  }
  return step(IDLE, "pass");
}

function handleArmed(state: LeaderState & { mode: "armed" }, input: KeyInput, keymap: Keymap): Step {
  if (isSpace(input) && !hasModifier(input)) {
    if (input.type === "keydown") return step(state, "prevent");
    return input.time - state.since < SPACE_HOLD_MS ? step(pending(state.count), "prevent") : step(IDLE, "pass");
  }
  if (input.type === "keyup") return step(state, "pass");
  if (MODIFIER_KEYS.has(input.key)) return step(state, "pass");
  const rolled = handlePending(pending(state.count), input, keymap);
  return { ...rolled, disposition: rolled.disposition === "own" ? "swallow" : rolled.disposition };
}

function resolveLeaf(
  state: PendingState,
  keys: string[],
  action: LeaderAction,
): Step {
  if (state.describe) return step(IDLE, "own", [{ type: "describe", keys, action }]);
  if (action === LEADER_ACTIONS.universalArgument) {
    return step({ ...state, keys: [], universal: true, count: null }, "own");
  }
  if (action === LEADER_ACTIONS.describeKey) {
    return step({ ...state, keys: [], describe: true }, "own");
  }
  const times = isRepeatable(action) ? (state.count ?? 1) : 1;
  return step(IDLE, "own", [{ type: "run", action, times, keys }]);
}

function handlePending(state: PendingState, input: KeyInput, keymap: Keymap): Step {
  if (input.type === "keyup") return step(state, "pass");
  if (input.composing || MODIFIER_KEYS.has(input.key)) return step(state, "pass");
  if (input.key === "Escape" || (input.ctrl && input.key.toLowerCase() === "g")) return step(IDLE, "own");
  if (input.repeat) return step(state, "own");
  if (input.key === "Backspace") {
    if (state.keys.length > 0) return step({ ...state, keys: state.keys.slice(0, -1) }, "own");
    return step(state.universal || state.describe ? pending(state.count) : IDLE, "own");
  }
  if (state.universal && state.keys.length === 0 && /^[0-9]$/u.test(input.key) && !hasModifier(input)) {
    const digit = Number(input.key);
    return step({ ...state, count: Math.min(MAX_COUNT, (state.count ?? 0) * 10 + digit) }, "own");
  }
  const token = keyToken(input);
  if (token === null) return step(IDLE, input.ctrl || input.meta ? "pass" : "own");
  const keys = [...state.keys, token];
  const node = lookup(keymap.root, keys);
  if (node === undefined) {
    if (token === "?" && state.keys.length === 0 && !state.describe) {
      return step(IDLE, "own", [{ type: "cheat-sheet" }]);
    }
    if (state.describe) return step(IDLE, "own", [{ type: "describe", keys, action: null }]);
    return step(IDLE, "own", [{ type: "undefined", keys }]);
  }
  if (node.kind === "prefix") return step({ ...state, keys }, "own");
  return resolveLeaf(state, keys, node.action);
}

export function reduce(state: LeaderState, input: KeyInput, keymap: Keymap): Step {
  switch (state.mode) {
    case "idle":
    case "count":
      return handleIdle(state, input, keymap);
    case "armed":
      return handleArmed(state, input, keymap);
    case "pending":
      return handlePending(state, input, keymap);
  }
}

/** The status chip's text, as Emacs echoes keys: `3 SPC f -`. */
export function echo(state: LeaderState): string | null {
  switch (state.mode) {
    case "idle":
      return null;
    case "count":
      return String(state.count);
    case "armed":
      return null;
    case "pending": {
      const parts: string[] = [];
      if (state.describe) parts.push("describe:");
      if (state.count !== null) parts.push(String(state.count));
      parts.push("SPC");
      if (state.universal) parts.push("u");
      if (state.keys.length > 0) parts.push(formatKeyPath(state.keys));
      parts.push("-");
      return parts.join(" ");
    }
  }
}
