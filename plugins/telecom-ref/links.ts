import type { SpecRef } from "./types";

/** What a panel subPath shows: the search page with its query ("" at the panel root) or one entity. */
export type PanelRoute = { kind: "search"; query: string } | { kind: "entity"; id: string };

const QUERY_PREFIX = "q/";

export function parseSubPath(subPath: string): PanelRoute {
  const path = subPath.replace(/^\/+|\/+$/g, "");
  if (path === "") return { kind: "search", query: "" };
  if (path.startsWith(QUERY_PREFIX)) {
    try {
      return { kind: "search", query: decodeURIComponent(path.slice(QUERY_PREFIX.length)) };
    } catch {
      return { kind: "search", query: path.slice(QUERY_PREFIX.length) };
    }
  }
  return { kind: "entity", id: path };
}

export function querySubPath(query: string): string {
  return query === "" ? "" : `${QUERY_PREFIX}${encodeURIComponent(query)}`;
}

/** The public page for a spec: the 3GPP status page or the RFC Editor copy, at the clause when it can. */
export function specUrl(ref: SpecRef): string | null {
  const ts = /^TS (\d{2})\.(\d{3})$/.exec(ref.doc);
  if (ts) return `https://www.3gpp.org/DynaReport/${ts[1]}${ts[2]}.htm`;
  const rfc = /^RFC (\d+)$/.exec(ref.doc);
  if (rfc) {
    const base = `https://www.rfc-editor.org/rfc/rfc${rfc[1]}`;
    return ref.clause && /^\d+(\.\d+)*$/.test(ref.clause) ? `${base}#section-${ref.clause}` : base;
  }
  return null;
}
