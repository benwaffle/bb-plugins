import { describe, expect, it } from "vitest";
import { reviewDockedPanels } from "./links";

describe("reviewDockedPanels", () => {
  it("docks the GitHub PR tab when the GitHub panel is available", () => {
    expect(reviewDockedPanels(42, true)).toEqual([{ pluginId: "github", actionId: "pull", title: "PR #42" }]);
  });

  it("docks nothing without the GitHub panel", () => {
    expect(reviewDockedPanels(42, false)).toEqual([]);
  });
});
