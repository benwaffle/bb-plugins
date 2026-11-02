import { describe, expect, it } from "vitest";
import { describeAction } from "./actions";
import type { HostAppCommands } from "./host";
import type { CommandEntry } from "./shortcuts";

const commands: HostAppCommands = { execute: () => true, list: () => [] };
const index = new Map<string, CommandEntry>([
  ["thread.new", { available: true, shortcut: "⌘ N" }],
  ["pane.focus.left", { available: true, shortcut: null }],
  ["thread.archive", { available: false, shortcut: "⌘ ⌫" }],
]);

describe("describeAction", () => {
  it("shows a bb command's native shortcut", () => {
    expect(describeAction("thread.new", commands, index)).toEqual({ status: "ok", note: null, shortcut: "⌘ N" });
  });

  it("says no shortcut when bb reports none", () => {
    expect(describeAction("pane.focus.left", commands, index).shortcut).toBe("no shortcut");
    expect(describeAction("plugin:taskboard/open", commands, index)).toEqual({
      status: "unavailable",
      note: "not available here",
      shortcut: "no shortcut",
    });
  });

  it("keeps the shortcut on unavailable commands", () => {
    expect(describeAction("thread.archive", commands, index)).toMatchObject({ status: "unavailable", shortcut: "⌘ ⌫" });
  });

  it("marks bb commands as needing the fork without a command API", () => {
    expect(describeAction("thread.new", null, new Map())).toEqual({
      status: "needs-fork",
      note: "needs fork",
      shortcut: "no shortcut",
    });
  });

  it("gives leader and missing actions no shortcut", () => {
    expect(describeAction("leader:cheat-sheet", null, index)).toEqual({ status: "ok", note: null, shortcut: null });
    expect(describeAction("missing:unarchive", commands, index)).toEqual({
      status: "needs-api",
      note: "needs a bb API",
      shortcut: null,
    });
  });
});
