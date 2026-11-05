import type { BbNavigate, PluginAppBuilder } from "@get-bb/plugin-sdk/app";

/** bb lists it as `plugin:usage-stats/open-usage`; the fork's Inbox usage footer runs that id. */
export const OPEN_USAGE_COMMAND_ID = "open-usage";
export const USAGE_PANEL_PATH = "usage";

type PanelNavigate = Pick<BbNavigate, "toPluginPanel">;

/**
 * Command `run` gets no navigator, so a mounted app overlay hands this
 * plugin's `useBbNavigate()` here. The command is unavailable until it does.
 */
let navigate: PanelNavigate | null = null;

/** Installs `next` and returns a release that clears it only if it is still the installed one. */
export function bindNavigate(next: PanelNavigate): () => void {
  navigate = next;
  return () => {
    if (navigate === next) navigate = null;
  };
}

export function registerOpenUsageCommand(app: Pick<PluginAppBuilder, "commands">): void {
  app.commands.register({
    id: OPEN_USAGE_COMMAND_ID,
    title: "Open Usage",
    isAvailable: () => navigate !== null,
    run: () => {
      navigate?.toPluginPanel(USAGE_PANEL_PATH);
    },
  });
}
