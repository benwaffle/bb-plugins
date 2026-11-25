import { useCallback, useEffect, useState } from "react";
import {
  definePluginApp,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { REALTIME_CHANNEL } from "./channel";
import type { WallpaperState, rpcContract } from "./contract";
import { FADE_MS, NO_LAYERS, dropHidden, isEmpty, showImage, wallpaperCss } from "./css";

/** Resolves once the image is decoded, so swapping it in never shows a blank frame. */
function preload(url: string | null): Promise<void> {
  if (url === null) return Promise.resolve();
  const image = new Image();
  image.src = url;
  return image.decode().catch(() => undefined);
}

function Wallpaper() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<WallpaperState | null>(null);
  const [layers, setLayers] = useState(NO_LAYERS);
  const connection = useRealtimeConnectionState();

  const refresh = useCallback(() => {
    rpc
      .call("get", null)
      .then(setState)
      .catch((error: unknown) => console.warn("wallpaper: could not load the wallpaper", error));
  }, [rpc]);

  useEffect(refresh, [refresh]);
  useRealtime(REALTIME_CHANNEL, refresh);
  // Catch up on changes published while the realtime socket was down.
  useEffect(() => {
    if (connection === "connected") refresh();
  }, [connection, refresh]);

  const url = state?.enabled ? (state.image?.url ?? null) : null;
  useEffect(() => {
    let current = true;
    void preload(url).then(() => {
      if (current) setLayers((previous) => showImage(previous, url));
    });
    return () => {
      current = false;
    };
  }, [url]);

  useEffect(() => {
    if (dropHidden(layers) === layers) return;
    const timer = setTimeout(() => setLayers(dropHidden), FADE_MS + 50);
    return () => clearTimeout(timer);
  }, [layers]);

  if (state === null || isEmpty(layers)) return null;
  return <style data-bb-wallpaper="">{wallpaperCss(layers, state)}</style>;
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "wallpaper", component: Wallpaper });
});
