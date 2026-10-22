// @vitest-environment jsdom
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { fireEvent } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import type { PluginNavPanelRegistration } from "@get-bb/plugin-sdk/app";

let panel: PluginNavPanelRegistration;

beforeAll(async () => {
  // jsdom does not lay out, so it has no scrollIntoView for the selected row.
  Element.prototype.scrollIntoView = () => {};
  const captured = await loadPluginApp(() => import("./app"));
  panel = captured.navPanels[0]!;
});

function selectedOption(view: ReturnType<typeof renderSlot>): string | null {
  return view.getAllByRole("option").find((option) => option.getAttribute("aria-selected") === "true")?.textContent ?? null;
}

describe("search keyboard navigation", () => {
  it("moves the selection with the arrows and opens it with Enter", () => {
    const view = renderSlot(panel, { subPath: "q/ULR" });
    const input = view.getByRole("combobox");
    expect(selectedOption(view)).toContain("Update-Location");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(selectedOption(view)).toContain("ULR-Flags");
    expect(input.getAttribute("aria-activedescendant")).toBe("telecom-ref-option-2");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(selectedOption(view)).toContain("ULR-Flags");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(view.navigateCalls.at(-1)).toEqual({ method: "toPluginPanel", path: "ref", options: { subPath: "diam.avp/10415/1405" } });
    view.unmount();
  });

  it("returns to the top with ArrowUp and stops there", () => {
    const view = renderSlot(panel, { subPath: "q/ULR" });
    const input = view.getByRole("combobox");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(selectedOption(view)).toContain("Update-Location");
    view.unmount();
  });
});
