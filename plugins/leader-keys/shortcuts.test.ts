import { describe, expect, it } from "vitest";
import { indexCommands, shortcutFits } from "./shortcuts";

describe("indexCommands", () => {
  it("keeps bb's shortcut labels and maps missing ones to null", () => {
    const index = indexCommands([
      { id: "thread.new", title: "New thread", available: true, shortcut: "⌘N" },
      { id: "thread.archive", title: "Archive", available: false },
    ]);
    expect(index.get("thread.new")).toEqual({ available: true, shortcut: "⌘N" });
    expect(index.get("thread.archive")).toEqual({ available: false, shortcut: null });
  });
});

describe("shortcutFits", () => {
  it("fits short labels and drops the shortcut for long ones", () => {
    expect(shortcutFits("New thread", "⌘N")).toBe(true);
    expect(shortcutFits("Move the focused pane to the far right edge", "⌥⌘→")).toBe(false);
  });
});
