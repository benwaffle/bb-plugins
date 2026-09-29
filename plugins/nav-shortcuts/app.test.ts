import { collectPluginAppRegistrations } from "@get-bb/plugin-sdk/internal/plugin-app-collector";
import type { PluginCommandContext } from "@get-bb/plugin-sdk/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app.js";

const context: PluginCommandContext = {
  threadId: null,
  projectId: null,
  openPanel: () => false,
};

function command(id: string) {
  const registrations = collectPluginAppRegistrations(app);
  const found = registrations.commandPaletteActions.find(
    (candidate) => candidate.id === id,
  );
  if (found === undefined) throw new Error(`command ${id} not registered`);
  return found;
}

describe("nav-shortcuts app", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["back", "Go back", "["],
    ["forward", "Go forward", "]"],
  ])("registers %s as %s on Mod+%s", (id, title, key) => {
    const registered = command(id);
    expect(registered.title).toBe(title);
    expect(registered.defaultShortcut).toMatchObject({ key, mod: true });
  });

  it.each([
    ["back", "back"],
    ["forward", "forward"],
  ] as const)("runs history.%s", (id, method) => {
    const history = { back: vi.fn(), forward: vi.fn() };
    vi.stubGlobal("history", history);
    void command(id).run(context);
    expect(history[method]).toHaveBeenCalledOnce();
  });

  it("is unavailable when the session has no entry in that direction", () => {
    vi.stubGlobal("navigation", { canGoBack: false, canGoForward: true });
    expect(command("back").isAvailable?.(context)).toBe(false);
    expect(command("forward").isAvailable?.(context)).toBe(true);
  });

  it("stays available where the Navigation API is missing", () => {
    vi.stubGlobal("navigation", undefined);
    expect(command("back").isAvailable?.(context)).toBe(true);
    expect(command("forward").isAvailable?.(context)).toBe(true);
  });
});
