const GITHUB_PANEL_ROOT = "/plugins/github/github";

export function githubPanelPath(pullKey: string): string | null {
  const match = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(pullKey);
  if (match === null) return null;
  const [, owner, name, number] = match;
  return `${GITHUB_PANEL_ROOT}/pulls/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}/${number}`;
}

export const QUEUE_PANEL_ACTION_ID = "queue";

export interface ReviewDockedPanel {
  pluginId?: string;
  actionId: string;
  title?: string;
}

export function reviewDockedPanels(number: number | null, githubPanel: boolean): ReviewDockedPanel[] {
  const queue: ReviewDockedPanel = { actionId: QUEUE_PANEL_ACTION_ID, title: "Review queue" };
  if (!githubPanel) return [queue];
  return [queue, { pluginId: "github", actionId: "pull", title: number === null ? "GitHub PR" : `PR #${number}` }];
}
