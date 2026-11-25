import type { HostAppCommandInfo } from "./host";

export interface CommandEntry {
  available: boolean;
  /** The command's native shortcut, as bb labels it; null when it has none or the host does not report it. */
  shortcut: string | null;
}

export function indexCommands(infos: readonly HostAppCommandInfo[]): Map<string, CommandEntry> {
  return new Map(infos.map((info) => [info.id, { available: info.available, shortcut: info.shortcut ?? null }]));
}

/** Characters a which-key description cell holds at the popup's 360px width. */
export const WHICH_KEY_ROW_CHARS = 40;

/** Whether a which-key row has room for the shortcut after its label. */
export function shortcutFits(label: string, shortcut: string, budget = WHICH_KEY_ROW_CHARS): boolean {
  return label.length + 2 + shortcut.length <= budget;
}
