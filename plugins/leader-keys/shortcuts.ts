import type { HostAppCommandInfo, HostAppShortcut } from "./host";

const KEY_GLYPHS: Readonly<Record<string, string>> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

/**
 * Renders a bb keybinding the way bb's own menus do: macOS glyphs in
 * ⌃ ⌥ ⇧ ⌘ order, `Ctrl + Alt + Shift + Meta` elsewhere. `mod` means Cmd on
 * macOS and Ctrl on other platforms.
 */
export function formatShortcut(shortcut: HostAppShortcut, mac: boolean): string {
  const meta = shortcut.meta || (shortcut.mod && mac);
  const control = shortcut.control || (shortcut.mod && !mac);
  const key = shortcut.key.length === 1 ? shortcut.key.toUpperCase() : (KEY_GLYPHS[shortcut.key] ?? shortcut.key);
  const parts = mac
    ? [control && "⌃", shortcut.alt && "⌥", shortcut.shift && "⇧", meta && "⌘", key]
    : [control && "Ctrl", shortcut.alt && "Alt", shortcut.shift && "Shift", meta && "Meta", key];
  return parts.filter((part): part is string => typeof part === "string").join(mac ? " " : " + ");
}

export interface CommandEntry {
  available: boolean;
  /** The command's native shortcut, formatted; null when it has none or the host does not report it. */
  shortcut: string | null;
}

export function indexCommands(infos: readonly HostAppCommandInfo[], mac: boolean): Map<string, CommandEntry> {
  return new Map(
    infos.map((info) => [
      info.id,
      { available: info.available, shortcut: info.shortcut == null ? null : formatShortcut(info.shortcut, mac) },
    ]),
  );
}

/** Characters a which-key description cell holds at the popup's 360px width. */
export const WHICH_KEY_ROW_CHARS = 40;

/** Whether a which-key row has room for the shortcut after its label. */
export function shortcutFits(label: string, shortcut: string, budget = WHICH_KEY_ROW_CHARS): boolean {
  return label.length + 2 + shortcut.length <= budget;
}

export function isMacPlatform(platform: string): boolean {
  return /mac|iphone|ipad/iu.test(platform);
}
