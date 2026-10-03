import { describe, expect, it } from "vitest";
import { githubRefs, ticketKey, titleWithoutTicket } from "./parse.js";

const KEYS = ["CORE"];
const REPO = "private-tech-inc/hss";

describe("ticketKey", () => {
  it("reads a CORE-n: title prefix", () => {
    expect(ticketKey({ title: "CORE-51: Track the private identity", body: "" }, KEYS)).toEqual({
      key: "CORE-51",
      source: "title",
    });
  });

  it("reads a bracketed prefix and ignores keys mid-title", () => {
    expect(ticketKey({ title: "[CORE-7]: Fix it", body: "" }, KEYS)?.key).toBe("CORE-7");
    expect(ticketKey({ title: "Follow up on CORE-7 work", body: "" }, KEYS)).toBeNull();
  });

  it("falls back to a bare CORE-n line or a browse URL in the body", () => {
    expect(ticketKey({ title: "Untagged", body: "Summary\n\nCORE-19\n" }, KEYS)).toEqual({
      key: "CORE-19",
      source: "body",
    });
    expect(
      ticketKey({ title: "Untagged", body: "Jira: https://east-stout.atlassian.net/browse/CORE-35" }, KEYS)?.key,
    ).toBe("CORE-35");
  });

  it("prefers the title over the body", () => {
    expect(ticketKey({ title: "CORE-1: a", body: "CORE-2" }, KEYS)?.key).toBe("CORE-1");
  });

  it("ignores keys in prose, code, and other Jira projects", () => {
    expect(ticketKey({ title: "x", body: "This builds on CORE-12 from last week." }, KEYS)).toBeNull();
    expect(ticketKey({ title: "x", body: "```\nCORE-12\n```" }, KEYS)).toBeNull();
    expect(ticketKey({ title: "OPS-3: deploy", body: "OPS-3" }, KEYS)).toBeNull();
  });
});

describe("titleWithoutTicket", () => {
  it("drops the ticket prefix", () => {
    expect(titleWithoutTicket("CORE-51: Track the IMPI")).toBe("Track the IMPI");
    expect(titleWithoutTicket("Track the IMPI")).toBe("Track the IMPI");
  });
});

describe("githubRefs", () => {
  it("treats Fixes and Refs targets as issues and bare #n as PRs", () => {
    const body = "Fixes #12\nRefs #13\nStacked on #590.";
    expect(githubRefs(body, REPO, 596)).toEqual([
      { kind: "gh-issue", key: `${REPO}#12`, source: "fixes" },
      { kind: "gh-issue", key: `${REPO}#13`, source: "refs" },
      { kind: "gh-pr", key: `${REPO}#590`, source: "mention" },
    ]);
  });

  it("reads keyword lists, other repos, and keyword variants", () => {
    const body = "Closes #1, #2 and other-org/tool#3\nresolved: #4\nPart of #5";
    expect(githubRefs(body, REPO, 9).map((ref) => [ref.kind, ref.key, ref.source])).toEqual([
      ["gh-issue", `${REPO}#1`, "fixes"],
      ["gh-issue", `${REPO}#2`, "fixes"],
      ["gh-issue", "other-org/tool#3", "fixes"],
      ["gh-issue", `${REPO}#4`, "fixes"],
      ["gh-issue", `${REPO}#5`, "refs"],
    ]);
  });

  it("classifies GitHub URLs by path", () => {
    const body = "See https://github.com/private-tech-inc/hss/pull/534 and https://github.com/a/b/issues/8";
    expect(githubRefs(body, REPO, 1)).toEqual([
      { kind: "gh-pr", key: `${REPO}#534`, source: "mention" },
      { kind: "gh-issue", key: "a/b#8", source: "mention" },
    ]);
  });

  it("skips the PR itself, code, comments, HTML entities, and anchors", () => {
    const body = [
      "This PR (#596) does things.",
      "`#77` in code",
      "<!-- #78 in a comment -->",
      "&#39; entity",
      "[link](#section-2)",
      "```",
      "Fixes #79",
      "```",
    ].join("\n");
    expect(githubRefs(body, REPO, 596)).toEqual([]);
  });

  it("does not repeat a ref mentioned twice", () => {
    expect(githubRefs("Fixes #4. Again: fixes #4, then #4", REPO, 1)).toEqual([
      { kind: "gh-issue", key: `${REPO}#4`, source: "fixes" },
      { kind: "gh-pr", key: `${REPO}#4`, source: "mention" },
    ]);
  });
});
