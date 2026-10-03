const GITHUB_PANEL_ROOT = "/plugins/github/github";

export function githubPanelPath(pullKey: string): string | null {
  const match = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(pullKey);
  if (match === null) return null;
  const [, owner, name, number] = match;
  return `${GITHUB_PANEL_ROOT}/pulls/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}/${number}`;
}
