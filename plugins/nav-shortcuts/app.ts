import { definePluginApp } from "@get-bb/plugin-sdk/app";

interface SessionNavigation {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

function sessionNavigation(): SessionNavigation | undefined {
  return (globalThis as { navigation?: SessionNavigation }).navigation;
}

export default definePluginApp((app) => {
  app.commands.register({
    id: "back",
    title: "Go back",
    defaultShortcut: { key: "[", mod: true },
    isAvailable: () => sessionNavigation()?.canGoBack ?? true,
    run: () => history.back(),
  });
  app.commands.register({
    id: "forward",
    title: "Go forward",
    defaultShortcut: { key: "]", mod: true },
    isAvailable: () => sessionNavigation()?.canGoForward ?? true,
    run: () => history.forward(),
  });
});
