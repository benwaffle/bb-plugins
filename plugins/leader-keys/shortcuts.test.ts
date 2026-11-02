import { describe, expect, it } from "vitest";
import { formatShortcut, indexCommands, isMacPlatform, shortcutFits } from "./shortcuts";

const base = { mod: false, meta: false, control: false, alt: false, shift: false };

describe("formatShortcut", () => {
  it.each([
    [{ ...base, key: "n", mod: true }, true, "⌘ N"],
    [{ ...base, key: "n", mod: true }, false, "Ctrl + N"],
    [{ ...base, key: "ArrowLeft", mod: true, alt: true }, true, "⌥ ⌘ ←"],
    [{ ...base, key: "k", control: true, shift: true, meta: true }, true, "⌃ ⇧ ⌘ K"],
    [{ ...base, key: "Space", alt: true }, false, "Alt + Space"],
  ])("formats %j (mac=%s) as %j", (shortcut, mac, text) => {
    expect(formatShortcut(shortcut, mac)).toBe(text);
  });
});

describe("indexCommands", () => {
  it("formats shortcuts and maps missing or null ones to null", () => {
    const index = indexCommands(
      [
        { id: "thread.new", title: "New thread", available: true, shortcut: { ...base, key: "n", mod: true } },
        { id: "thread.archive", title: "Archive", available: false, shortcut: null },
        { id: "pane.focus.left", title: "Focus left", available: true },
      ],
      true,
    );
    expect(index.get("thread.new")).toEqual({ available: true, shortcut: "⌘ N" });
    expect(index.get("thread.archive")).toEqual({ available: false, shortcut: null });
    expect(index.get("pane.focus.left")).toEqual({ available: true, shortcut: null });
  });
});

describe("shortcutFits", () => {
  it("fits short labels and drops the shortcut for long ones", () => {
    expect(shortcutFits("New thread", "⌘ N")).toBe(true);
    expect(shortcutFits("Move the focused pane to the far right edge", "⌥ ⌘ →")).toBe(false);
  });
});

describe("isMacPlatform", () => {
  it.each([
    ["MacIntel", true],
    ["iPhone", true],
    ["Win32", false],
    ["Linux x86_64", false],
  ])("%s → %s", (platform, mac) => {
    expect(isMacPlatform(platform)).toBe(mac);
  });
});
