import { describe, expect, it } from "vitest";
import { reviewDockedPanels } from "./links";

describe("reviewDockedPanels", () => {
  it("docks the queue left of the GitHub PR tab when the GitHub panel is available", () => {
    expect(reviewDockedPanels(42, true)).toEqual([
      { actionId: "queue", title: "Review queue" },
      { pluginId: "github", actionId: "pull", title: "PR #42" },
    ]);
  });

  it("docks only the queue without the GitHub panel", () => {
    expect(reviewDockedPanels(42, false)).toEqual([{ actionId: "queue", title: "Review queue" }]);
  });
});
