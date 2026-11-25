import { describe, expect, it } from "vitest";
import type { BbNavigate } from "@get-bb/plugin-sdk/app";
import { getView, moveSelection, openSearch, setView } from "./view";

describe("openSearch", () => {
  const calls: unknown[] = [];
  const navigate = { toPluginPanel: (...args: unknown[]) => calls.push(args) } as unknown as BbNavigate;

  it("starts a fresh, unfiltered search when given an empty query", () => {
    setView({ query: "ULR", kind: "avp" });
    openSearch(navigate, "");
    expect(getView()).toMatchObject({ query: "", kind: null, interfaceId: null });
    expect(calls.at(-1)).toEqual(["ref", { subPath: "" }]);
  });

  it("carries the current search over without a query", () => {
    setView({ query: "ULR" });
    openSearch(navigate);
    expect(getView().query).toBe("ULR");
    expect(calls.at(-1)).toEqual(["ref", { subPath: "q/ULR" }]);
  });
});

describe("moveSelection", () => {
  it("moves down and up one result at a time", () => {
    expect(moveSelection("ArrowDown", 0, 3)).toBe(1);
    expect(moveSelection("ArrowUp", 2, 3)).toBe(1);
  });

  it("stops at the ends of the list", () => {
    expect(moveSelection("ArrowDown", 2, 3)).toBe(2);
    expect(moveSelection("ArrowUp", 0, 3)).toBe(0);
  });

  it("leaves other keys to the search box", () => {
    expect(moveSelection("Enter", 1, 3)).toBeNull();
    expect(moveSelection("Home", 1, 3)).toBeNull();
    expect(moveSelection("a", 1, 3)).toBeNull();
  });

  it("does nothing with no results", () => {
    expect(moveSelection("ArrowDown", 0, 0)).toBeNull();
  });
});
