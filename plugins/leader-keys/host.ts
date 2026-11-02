/**
 * The bb fork's command API, looked up on the host runtime at call time. The
 * pinned SDK (0.6.68) does not declare these members, and stock bb does not
 * provide them, so each is null there and the plugin runs only its own
 * leader actions.
 */
export interface HostAppCommandInfo {
  id: string;
  title: string;
  available: boolean;
}

export interface HostAppCommands {
  execute(commandId: string): boolean;
  list(): HostAppCommandInfo[];
}

export interface HostCapabilities {
  useAppCommands: (() => HostAppCommands) | null;
  useLeaderKeyCommand: ((handler: () => boolean) => void) | null;
}

interface RuntimeGlobal {
  __bbPluginRuntime?: { pluginSdkApp?: Record<string, unknown> };
}

export function hostCapabilities(): HostCapabilities {
  const app = (globalThis as RuntimeGlobal).__bbPluginRuntime?.pluginSdkApp;
  const useAppCommands = app?.["experimental_useAppCommands"];
  const useLeaderKeyCommand = app?.["experimental_useLeaderKeyCommand"];
  return {
    useAppCommands: typeof useAppCommands === "function" ? (useAppCommands as () => HostAppCommands) : null,
    useLeaderKeyCommand:
      typeof useLeaderKeyCommand === "function" ? (useLeaderKeyCommand as (handler: () => boolean) => void) : null,
  };
}
