import type { PluginCommandContext, PluginCommandRegistration } from "@get-bb/plugin-sdk/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindNavigate, OPEN_USAGE_COMMAND_ID, registerOpenUsageCommand, USAGE_PANEL_PATH } from "./open-command.js";

const context = { threadId: null, projectId: null } as unknown as PluginCommandContext;

function registered(): PluginCommandRegistration {
  const registrations: PluginCommandRegistration[] = [];
  registerOpenUsageCommand({ commands: { register: (registration) => void registrations.push(registration) } });
  expect(registrations).toHaveLength(1);
  return registrations[0]!;
}

let release: (() => void) | null = null;
afterEach(() => {
  release?.();
  release = null;
});

describe("Open Usage command", () => {
  it("registers open-usage titled Open Usage", () => {
    const command = registered();
    expect(command.id).toBe(OPEN_USAGE_COMMAND_ID);
    expect(command.id).toBe("open-usage");
    expect(command.title).toBe("Open Usage");
  });

  it("is unavailable until a navigator is bound", () => {
    const command = registered();
    expect(command.isAvailable?.(context)).toBe(false);
    release = bindNavigate({ toPluginPanel: vi.fn() });
    expect(command.isAvailable?.(context)).toBe(true);
  });

  it("navigates to the Usage page", async () => {
    const toPluginPanel = vi.fn();
    release = bindNavigate({ toPluginPanel });
    await registered().run(context);
    expect(toPluginPanel).toHaveBeenCalledWith(USAGE_PANEL_PATH);
    expect(USAGE_PANEL_PATH).toBe("usage");
  });

  it("keeps a newer navigator when an older binding releases", async () => {
    const older = vi.fn();
    const newer = vi.fn();
    const releaseOlder = bindNavigate({ toPluginPanel: older });
    release = bindNavigate({ toPluginPanel: newer });
    releaseOlder();
    const command = registered();
    expect(command.isAvailable?.(context)).toBe(true);
    await command.run(context);
    expect(newer).toHaveBeenCalledOnce();
    expect(older).not.toHaveBeenCalled();
  });

  it("does nothing once released", async () => {
    const toPluginPanel = vi.fn();
    bindNavigate({ toPluginPanel })();
    const command = registered();
    expect(command.isAvailable?.(context)).toBe(false);
    await command.run(context);
    expect(toPluginPanel).not.toHaveBeenCalled();
  });
});
