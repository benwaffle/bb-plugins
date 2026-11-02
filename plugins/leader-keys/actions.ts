import type { HostAppCommands } from "./host";
import { actionKind, type LeaderAction } from "./keymap";
import type { CommandEntry } from "./shortcuts";

export type EntryStatus = "ok" | "unavailable" | "needs-fork" | "needs-api";

export type CommandIndex = ReadonlyMap<string, CommandEntry>;

export const STATUS_NOTE: Record<EntryStatus, string | null> = {
  ok: null,
  unavailable: "not available here",
  "needs-fork": "needs fork",
  "needs-api": "needs a bb API",
};

export interface ActionView {
  status: EntryStatus;
  note: string | null;
  /** The native shortcut for a bb or plugin command, "no shortcut" when bb reports none; null for other actions. */
  shortcut: string | null;
}

export function describeAction(action: LeaderAction, commands: HostAppCommands | null, index: CommandIndex): ActionView {
  const kind = actionKind(action);
  const entry = index.get(action);
  const status: EntryStatus =
    kind === "leader" ? "ok"
    : kind === "missing" ? "needs-api"
    : commands === null ? "needs-fork"
    : entry?.available === true ? "ok"
    : "unavailable";
  const shortcut = kind === "core" || kind === "plugin" ? entry?.shortcut ?? "no shortcut" : null;
  return { status, note: STATUS_NOTE[status], shortcut };
}
