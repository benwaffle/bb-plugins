export type RefKind = "gh-pr" | "gh-issue" | "jira";

export type RefSource =
  | "review-target"
  | "title"
  | "body"
  | "fixes"
  | "refs"
  | "mention"
  | "sibling"
  | "environment";

export interface ExtractedRef {
  kind: RefKind;
  key: string;
  source: RefSource;
}

const TICKET_PATTERN = /\b([A-Z][A-Z0-9]+-\d+)\b/;
const TITLE_TICKET_PATTERN = /^\s*\[?([A-Z][A-Z0-9]+-\d+)\]?\s*:/;
const BODY_TICKET_LINE_PATTERN = /^\s*(?:[-*]\s*)?\[?([A-Z][A-Z0-9]+-\d+)\]?\s*\.?\s*$/;
const BODY_TICKET_URL_PATTERN = /\/browse\/([A-Z][A-Z0-9]+-\d+)\b/;

const REPO_PATTERN = "[\\w.-]+\\/[\\w.-]+";
const ISSUE_REFERENCE = `(?:${REPO_PATTERN})?#\\d+`;
const LINKING_KEYWORDS: ReadonlyArray<{ source: "fixes" | "refs"; words: string }> = [
  { source: "fixes", words: "close[sd]?|fix(?:e[sd])?|resolve[sd]?" },
  { source: "refs", words: "refs?|references?|related to|part of|see" },
];
const ISSUE_URL_PATTERN = new RegExp(
  `https?:\\/\\/github\\.com\\/(${REPO_PATTERN})\\/(issues|pull)\\/(\\d+)`,
  "g",
);

export function stripNonProse(markdown: string): string {
  return markdown
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/`[^`\n]*`/g, " ");
}

export function ticketKeyFromTitle(title: string, projectKeys: readonly string[]): string | null {
  const match = TITLE_TICKET_PATTERN.exec(title);
  return match !== null && hasProjectKey(match[1]!, projectKeys) ? match[1]! : null;
}

export function ticketKeyFromBody(body: string, projectKeys: readonly string[]): string | null {
  for (const line of stripNonProse(body).split(/\r?\n/)) {
    const bare = BODY_TICKET_LINE_PATTERN.exec(line);
    if (bare !== null && hasProjectKey(bare[1]!, projectKeys)) return bare[1]!;
    const url = BODY_TICKET_URL_PATTERN.exec(line);
    if (url !== null && hasProjectKey(url[1]!, projectKeys)) return url[1]!;
  }
  return null;
}

export function ticketKey(
  pull: { title: string; body: string },
  projectKeys: readonly string[],
): { key: string; source: "title" | "body" } | null {
  const fromTitle = ticketKeyFromTitle(pull.title, projectKeys);
  if (fromTitle !== null) return { key: fromTitle, source: "title" };
  const fromBody = ticketKeyFromBody(pull.body, projectKeys);
  if (fromBody !== null) return { key: fromBody, source: "body" };
  return null;
}

function hasProjectKey(key: string, projectKeys: readonly string[]): boolean {
  if (!TICKET_PATTERN.test(key)) return false;
  const project = key.slice(0, key.lastIndexOf("-"));
  return projectKeys.includes(project);
}

export function titleWithoutTicket(title: string): string {
  return title.replace(TITLE_TICKET_PATTERN, "").trim();
}

function qualify(reference: string, repo: string): string {
  return reference.startsWith("#") ? `${repo}${reference}` : reference;
}

export function githubRefs(
  body: string,
  repo: string,
  selfNumber: number,
): ExtractedRef[] {
  const prose = stripNonProse(body);
  const refs = new Map<string, ExtractedRef>();
  const self = `${repo}#${selfNumber}`;
  const add = (ref: ExtractedRef) => {
    const id = `${ref.kind}:${ref.key}`;
    if (ref.key === self || refs.has(id)) return;
    refs.set(id, ref);
  };

  let remaining = prose.replace(ISSUE_URL_PATTERN, (_url, urlRepo: string, path: string, number: string) => {
    add({
      kind: path === "pull" ? "gh-pr" : "gh-issue",
      key: `${urlRepo}#${number}`,
      source: "mention",
    });
    return " ";
  });

  for (const { source, words } of LINKING_KEYWORDS) {
    const pattern = new RegExp(
      `\\b(?:${words})\\s*:?\\s+(${ISSUE_REFERENCE}(?:\\s*(?:,|and)\\s*${ISSUE_REFERENCE})*)`,
      "gi",
    );
    remaining = remaining.replace(pattern, (_match, list: string) => {
      for (const reference of list.match(new RegExp(ISSUE_REFERENCE, "g")) ?? []) {
        add({ kind: "gh-issue", key: qualify(reference, repo), source });
      }
      return " ";
    });
  }

  const bare = new RegExp(`(?<![\\w&/])(${ISSUE_REFERENCE})\\b`, "g");
  for (const match of remaining.matchAll(bare)) {
    add({ kind: "gh-pr", key: qualify(match[1]!, repo), source: "mention" });
  }

  return [...refs.values()];
}

export function githubUrl(kind: "gh-pr" | "gh-issue", key: string): string {
  const [repo, number] = key.split("#");
  return `https://github.com/${repo}/${kind === "gh-pr" ? "pull" : "issues"}/${number}`;
}

export function parseRepoKey(key: string): { repo: string; number: number } | null {
  const match = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(key);
  return match === null ? null : { repo: match[1]!, number: Number(match[2]) };
}

export function parsePullUrl(url: string): { repo: string; number: number } | null {
  const match = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(url);
  return match === null ? null : { repo: match[1]!, number: Number(match[2]) };
}

export function parseRepoList(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => /^[\w.-]+\/[\w.-]+$/.test(entry));
}

export function parseProjectKeys(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toUpperCase())
    .filter((entry) => /^[A-Z][A-Z0-9]+$/.test(entry));
}
