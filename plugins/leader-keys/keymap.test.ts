import { describe, expect, it } from "vitest";
import { flattenKeymap, formatKeyPath, lookup, parseKeyPath, parseKeymap, sortedChildren } from "./keymap";

function leafAction(text: string | null, path: string) {
  const keymap = parseKeymap(text);
  const node = lookup(keymap.root, parseKeyPath(path)!);
  return { keymap, node };
}

describe("parseKeyPath", () => {
  it.each([
    ["f R", ["f", "R"]],
    ["SPC", ["SPC"]],
    ["  w   l ", ["w", "l"]],
    ["Tab", ["TAB"]],
  ])("parses %j", (path, keys) => {
    expect(parseKeyPath(path)).toEqual(keys);
  });

  it.each(["", "fR", "f Enter"])("rejects %j", (path) => {
    expect(parseKeyPath(path)).toBeNull();
  });
});

describe("parseKeymap", () => {
  it("builds the default map without a file", () => {
    const { keymap, node } = leafAction(null, "f n");
    expect(keymap.errors).toEqual([]);
    expect(node).toMatchObject({ kind: "leaf", action: "thread.new", custom: false });
    expect(keymap.fallback).toEqual({ key: "Space", alt: true, ctrl: false, meta: false, shift: false });
    expect(keymap.whichKeyDelayMs).toBe(300);
  });

  it("covers every prefix in the design", () => {
    const top = sortedChildren(parseKeymap(null).root)
      .filter(([, node]) => node.kind === "prefix")
      .map(([key]) => key);
    expect(top).toEqual(expect.arrayContaining(["f", "p", "b", "g", "s", "t", "w", "h"]));
    const root = parseKeymap(null).root;
    for (const path of [":", ",", "."]) {
      expect(lookup(root, parseKeyPath(path)!)?.kind).toBe("leaf");
    }
  });

  it("overrides, adds and unbinds bindings", () => {
    const text = JSON.stringify({
      bindings: {
        "f n": "window.new",
        "x t": { command: "plugin:taskboard/open", label: "Taskboard" },
        "g d": null,
      },
      labels: { x: "mine" },
    });
    const keymap = parseKeymap(text);
    expect(keymap.errors).toEqual([]);
    expect(lookup(keymap.root, ["f", "n"])).toMatchObject({ action: "window.new", custom: true });
    expect(lookup(keymap.root, ["x", "t"])).toMatchObject({ action: "plugin:taskboard/open", label: "Taskboard" });
    expect(lookup(keymap.root, ["x"])).toMatchObject({ kind: "prefix", label: "mine" });
    expect(lookup(keymap.root, ["g", "d"])).toBeUndefined();
  });

  it("rejects a binding that would be both a leaf and a prefix, keeping the default", () => {
    const keymap = parseKeymap(JSON.stringify({ bindings: { "f n x": "thread.new", f: "thread.new" } }));
    expect(keymap.errors).toHaveLength(2);
    expect(lookup(keymap.root, ["f", "n"])).toMatchObject({ action: "thread.new", custom: false });
    expect(lookup(keymap.root, ["f"])?.kind).toBe("prefix");
  });

  it.each([
    ["invalid JSON", "{", /not valid JSON/],
    ["an unknown field", JSON.stringify({ leaderKey: "x" }), /keymap\.json/],
    ["a bad command id", JSON.stringify({ bindings: { "x a": "rm -rf" } }), /not a bb command id/],
    ["an unknown leader action", JSON.stringify({ bindings: { "x a": "leader:explode" } }), /not a bb command id/],
    ["a bad key path", JSON.stringify({ bindings: { xa: "thread.new" } }), /not a key path/],
  ])("reports %s and still loads the defaults", (_label, text, message) => {
    const keymap = parseKeymap(text);
    expect(keymap.errors.join("\n")).toMatch(message);
    expect(lookup(keymap.root, ["f", "n"])).toMatchObject({ action: "thread.new" });
  });

  it("turns the fallback chord off with null and reads custom timings", () => {
    const keymap = parseKeymap(JSON.stringify({ fallback: null, whichKeyDelayMs: 0, timeoutMs: 1000 }));
    expect(keymap.fallback).toBeNull();
    expect(keymap.whichKeyDelayMs).toBe(0);
    expect(keymap.timeoutMs).toBe(1000);
  });

  it("flattens in which-key order", () => {
    const rows = flattenKeymap(parseKeymap(null).root).map((row) => formatKeyPath(row.keys));
    expect(rows[0]).toBe("SPC");
    expect(rows.indexOf("f n")).toBeLessThan(rows.indexOf("f N"));
    expect(rows.indexOf("f N")).toBeLessThan(rows.indexOf("f p"));
  });
});
