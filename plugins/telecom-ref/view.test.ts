import { describe, expect, it } from "vitest";
import { moveSelection } from "./view";

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
