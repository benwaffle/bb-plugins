// @vitest-environment jsdom
import type { ComponentType } from "react";
import type { PluginAppBuilder, PluginSidebarProject } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { fireEvent } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import definition, { type SidebarProjectDecorationRegistration } from "./app.js";
import { BUTTON_ATTRIBUTE } from "./decorate.js";

const ATLAS = "proj_atlas";
const QUILL = "proj_quill";

function sidebarProject(id: string, name: string): PluginSidebarProject {
  return { id, name, isPersonal: false, href: `/projects/${id}`, settingsHref: `/projects/${id}/settings` };
}

const sidebarThreads = {
  projects: [sidebarProject(ATLAS, "atlas"), sidebarProject(QUILL, "quill")],
};

const rpc = {
  list: () => ({
    assignments: [
      { projectId: ATLAS, emoji: "🧭", source: "auto" as const },
      { projectId: QUILL, emoji: "🪶", source: "manual" as const },
    ],
    colors: [{ projectId: QUILL, color: "#7fb4ff" }],
  }),
};

interface Registrations {
  overlays: { id: string; component: ComponentType }[];
  decorations: SidebarProjectDecorationRegistration[];
}

/** Runs the app setup against a host that offers the project decoration slot. */
function setupWithDecorationSlot(): Registrations {
  const registrations: Registrations = { overlays: [], decorations: [] };
  const builder = {
    slots: {
      experimental_appOverlay: (registration: Registrations["overlays"][number]) => {
        registrations.overlays.push(registration);
      },
      experimental_sidebarProjectDecoration: (registration: SidebarProjectDecorationRegistration) => {
        registrations.decorations.push(registration);
      },
    },
  } as unknown as PluginAppBuilder;
  definition.setup(builder);
  return registrations;
}

function renderHeaders(registrations: Registrations, settings: Record<string, boolean>) {
  const Overlay = registrations.overlays[0]!.component;
  const decoration = registrations.decorations[0]!;
  const headerPointerDown = vi.fn();
  function Header({ projectId }: { projectId: string }) {
    const value = decoration.useDecoration(projectId);
    return (
      <div data-testid={projectId} onPointerDown={headerPointerDown} onClick={headerPointerDown}>
        {value?.leading}
        <output>{JSON.stringify({ accentColor: value?.accentColor, tint: value?.tint })}</output>
      </div>
    );
  }
  function Harness() {
    return (
      <>
        <Overlay />
        <Header projectId={ATLAS} />
        <Header projectId={QUILL} />
      </>
    );
  }
  const view = renderSlot({ component: Harness }, {}, { rpc, settings, sidebarThreads });
  return { view, headerPointerDown };
}

function styleOf(projectId: string): unknown {
  const output = document.querySelector(`[data-testid="${projectId}"] output`);
  return JSON.parse(output?.textContent ?? "null");
}

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("project-emoji app with the decoration slot", () => {
  it("decorates each header with its emoji button, color, and tint", async () => {
    const registrations = setupWithDecorationSlot();
    expect(registrations.decorations.map(({ id, title }) => ({ id, title }))).toEqual([
      { id: "project-emoji", title: "Project emoji" },
    ]);

    const { view } = renderHeaders(registrations, { tint: true });

    expect(await view.findByRole("button", { name: "Change icon for atlas" })).toHaveProperty(
      "textContent",
      "🧭",
    );
    expect(view.getByRole("button", { name: "Change icon for quill" }).textContent).toBe("🪶");
    expect(styleOf(ATLAS)).toEqual({ accentColor: "oklch(0.86 0.07 164)", tint: true });
    expect(styleOf(QUILL)).toEqual({ accentColor: "#7fb4ff", tint: true });
    expect(document.querySelector(`[${BUTTON_ATTRIBUTE}]`)).toBeNull();
  });

  it("keeps the color but drops the tint when the setting is off", async () => {
    const { view } = renderHeaders(setupWithDecorationSlot(), { tint: false });
    await view.findByRole("button", { name: "Change icon for atlas" });
    expect(styleOf(ATLAS)).toEqual({ accentColor: "oklch(0.86 0.07 164)", tint: false });
  });

  it("opens the picker from the emoji without reaching the header", async () => {
    const { view, headerPointerDown } = renderHeaders(setupWithDecorationSlot(), { tint: true });
    const button = await view.findByRole("button", { name: "Change icon for atlas" });

    fireEvent.pointerDown(button);
    fireEvent.click(button);

    expect(headerPointerDown).not.toHaveBeenCalled();
    expect(await view.findByRole("searchbox", { name: "Search emoji" })).toBeTruthy();
  });
});

describe("project-emoji app without the decoration slot", () => {
  it("registers only the overlay and inserts emoji into the sidebar rows", async () => {
    const captured = await loadPluginApp(definition);
    expect(captured.appOverlays.map((overlay) => overlay.id)).toEqual(["project-emoji"]);

    const rows = document.createElement("div");
    rows.innerHTML = `
      <div data-sidebar-project-id="${ATLAS}">
        <span><span title="atlas">atlas</span><button data-sidebar-rename-anchor="">toggle</button></span>
      </div>`;
    document.body.append(rows);

    renderSlot(captured.appOverlays[0]!, {}, { rpc, sidebarThreads });

    await vi.waitFor(() => {
      expect(rows.querySelector(`[${BUTTON_ATTRIBUTE}="${ATLAS}"]`)?.textContent).toBe("🧭");
    });
  });
});
