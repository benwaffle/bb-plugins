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

describe("search query lifetime", () => {
  it("starts an empty, focused search when the panel opens at its root", () => {
    const earlier = renderSlot(panel, { subPath: "q/ULR" });
    expect((earlier.getByRole("combobox") as HTMLInputElement).value).toBe("ULR");
    earlier.unmount();

    const view = renderSlot(panel, { subPath: "" });
    const input = view.getByRole("combobox") as HTMLInputElement;
    expect(input.value).toBe("");
    expect(document.activeElement).toBe(input);
    view.unmount();
  });

  it("restores the query from the route, as back from a detail page does", () => {
    renderSlot(panel, { subPath: "diam.avp/10415/1405" }).unmount();
    const view = renderSlot(panel, { subPath: "q/ULR" });
    expect((view.getByRole("combobox") as HTMLInputElement).value).toBe("ULR");
    view.unmount();
  });
});

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

describe("architecture diagrams", () => {
  it("draws every box and interface as a focusable button", () => {
    const view = renderSlot(panel, { subPath: "diagram/interworking" });
    const n26 = view.getByRole("button", { name: "N26 interface, MME to AMF" });
    expect(n26.getAttribute("tabindex")).toBe("0");
    expect(view.getByRole("button", { name: "PGW-C, PDN Gateway Control plane function" })).toBeTruthy();
    view.unmount();
  });

  it("picks an interface by click or Enter and keeps the pick in the route", () => {
    const view = renderSlot(panel, { subPath: "diagram/interworking" });
    fireEvent.click(view.getByRole("button", { name: "N26 interface, MME to AMF" }));
    expect(view.navigateCalls.at(-1)).toEqual({ method: "toPluginPanel", path: "ref", options: { subPath: "diagram/interworking/if/N26", replace: true } });
    fireEvent.keyDown(view.getByRole("button", { name: "N11 interface, SMF + PGW-C to AMF" }), { key: "Enter" });
    expect(view.navigateCalls.at(-1)).toMatchObject({ options: { subPath: "diagram/interworking/if/N11" } });
    view.unmount();
  });

  it("shows the picked entry's detail beside the diagram and opens the full entry", () => {
    const view = renderSlot(panel, { subPath: "diagram/interworking/if/N26" });
    const inspector = view.getByRole("complementary", { name: "Selection" });
    expect(inspector.textContent).toContain("GTPv2-C");
    expect(inspector.textContent).toContain("MME — AMF");
    fireEvent.click(view.getByRole("button", { name: /Open full entry/ }));
    expect(view.navigateCalls.at(-1)).toEqual({ method: "toPluginPanel", path: "ref", options: { subPath: "if/N26" } });
    view.unmount();
  });

  it("switches between the views of one architecture, keeping the pick when the other view draws it", () => {
    const view = renderSlot(panel, { subPath: "diagram/5gc-sba/nf/AMF" });
    fireEvent.click(view.getByRole("button", { name: "Reference points" }));
    expect(view.navigateCalls.at(-1)).toMatchObject({ options: { subPath: "diagram/5gc-rp/nf/AMF" } });
    view.unmount();
  });

  it("links an entry's page to the diagrams that draw it", () => {
    const view = renderSlot(panel, { subPath: "nf/PGW-C" });
    fireEvent.click(view.getByRole("link", { name: /EPC and 5GC interworking/ }));
    expect(view.navigateCalls.at(-1)).toEqual({ method: "toPluginPanel", path: "ref", options: { subPath: "diagram/interworking/nf/PGW-C" } });
    view.unmount();
  });
});
