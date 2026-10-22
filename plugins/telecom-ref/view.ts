import { useSyncExternalStore } from "react";
import type { BbNavigate } from "@get-bb/plugin-sdk/app";
import { PANEL_PATH } from "./format";
import { querySubPath } from "./links";
import type { EntityKind } from "./types";

const RECENT_LIMIT = 8;

/** How tall result rows are: a name line and a summary line, or one line each. */
export type Density = "comfortable" | "compact";

/**
 * The view state the search page, the sidebar, and the palette commands
 * share, so filters set in the sidebar apply to the page.
 */
export interface ViewState {
  query: string;
  kind: EntityKind | null;
  interfaceId: string | null;
  /** Bumped to ask the search box to take focus. */
  focusTick: number;
  recent: string[];
  density: Density;
}

let state: ViewState = { query: "", kind: null, interfaceId: null, focusTick: 0, recent: [], density: "comfortable" };
const listeners = new Set<() => void>();

export function getView(): ViewState {
  return state;
}

export function setView(patch: Partial<ViewState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useView(): ViewState {
  return useSyncExternalStore(subscribe, getView);
}

function recentKey(pluginId: string): string {
  return `${pluginId}:recent`;
}

function densityKey(pluginId: string): string {
  return `${pluginId}:density`;
}

/** Loads the per-window preferences: recently viewed entries and the result density. */
export function loadPreferences(pluginId: string): void {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(recentKey(pluginId)) ?? "[]");
    setView({ recent: Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [] });
  } catch {
    setView({ recent: [] });
  }
  try {
    setView({ density: localStorage.getItem(densityKey(pluginId)) === "compact" ? "compact" : "comfortable" });
  } catch {
    setView({ density: "comfortable" });
  }
}

export function setDensity(pluginId: string, density: Density): void {
  setView({ density });
  try {
    localStorage.setItem(densityKey(pluginId), density);
  } catch {
    // Storage can be full or disabled; the density then lasts for the session.
  }
}

export function rememberRecent(pluginId: string, id: string): void {
  const recent = [id, ...state.recent.filter((other) => other !== id)].slice(0, RECENT_LIMIT);
  setView({ recent });
  try {
    localStorage.setItem(recentKey(pluginId), JSON.stringify(recent));
  } catch {
    // Storage can be full or disabled; recents then last for the session.
  }
}

/**
 * Palette commands run outside React, so they navigate through the instance
 * the app overlay (mounted once per window) hands over.
 */
let windowNavigate: BbNavigate | null = null;

export function setWindowNavigate(navigate: BbNavigate | null): void {
  windowNavigate = navigate;
}

export function getWindowNavigate(): BbNavigate | null {
  return windowNavigate;
}

/** Show the search page, optionally with a fresh query, and focus its search box. */
export function openSearch(navigate: BbNavigate | null, query?: string): void {
  if (query !== undefined) setView({ query, kind: null, interfaceId: null });
  navigate?.toPluginPanel(PANEL_PATH, { subPath: querySubPath(state.query) });
  setView({ focusTick: state.focusTick + 1 });
}

/**
 * The result index a key moves the selection to, or null when the key is not
 * a list key. The arrows stop at the ends of the list.
 */
export function moveSelection(key: string, index: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowDown":
      return Math.min(index + 1, count - 1);
    case "ArrowUp":
      return Math.max(index - 1, 0);
    default:
      return null;
  }
}
