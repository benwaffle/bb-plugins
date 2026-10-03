import { describe, expect, it } from "vitest";
import {
  autoEmoji,
  EMOJI_CATALOG,
  FALLBACK_EMOJI,
  fallbackEmoji,
  keywordEmoji,
  parseEmoji,
  searchEmoji,
  type ProjectFacts,
} from "./emoji.js";

function project(overrides: Partial<ProjectFacts>): ProjectFacts {
  return {
    id: "proj_test",
    name: "untitled",
    kind: "standard",
    paths: [],
    gitRemoteUrl: null,
    ...overrides,
  };
}

const NONE = new Set<string>();

describe("keywordEmoji", () => {
  it.each([
    ["bb", "🐙"],
    ["telecom-provisioning", "📡"],
    ["raycast-scripts", "🚀"],
    ["bb-plugins", "🔌"],
    ["claude-skills", "🧠"],
    ["payments-api", "🛠️"],
    ["ios-app", "📱"],
    ["Android Client", "📱"],
    ["team docs", "📚"],
    ["terraform-live", "☁️"],
    ["myAwsStacks", "☁️"],
  ])("maps the project name %s to %s", (name, emoji) => {
    expect(keywordEmoji(project({ name }))).toBe(emoji);
  });

  it("prefers the name over the checkout path", () => {
    expect(
      keywordEmoji(project({ name: "docs", paths: ["/Users/me/dev/terraform"] })),
    ).toBe("📚");
  });

  it("falls back to the last path segment, then the remote repository name", () => {
    expect(keywordEmoji(project({ name: "work", paths: ["/home/me/src/infra"] }))).toBe("☁️");
    expect(
      keywordEmoji(
        project({ name: "work", gitRemoteUrl: "git@github.com:acme/mobile.git" }),
      ),
    ).toBe("📱");
  });

  it("ignores parent directories of the checkout path", () => {
    expect(keywordEmoji(project({ name: "zzz", paths: ["/srv/api/zzz"] }))).toBeNull();
  });

  it("gives the personal project a house", () => {
    expect(keywordEmoji(project({ kind: "personal", name: "Personal" }))).toBe("🏠");
  });

  it("matches whole tokens only", () => {
    expect(keywordEmoji(project({ name: "rapid" }))).toBeNull();
    expect(keywordEmoji(project({ name: "bbq" }))).toBeNull();
  });
});

describe("fallbackEmoji", () => {
  it("is a fixed function of the project id", () => {
    expect(fallbackEmoji("proj_vf3nzi3ukv", NONE)).toBe("🍄");
    expect(fallbackEmoji("proj_abc", NONE)).toBe("🌻");
    expect(fallbackEmoji("proj_xyz", NONE)).toBe("🧁");
  });

  it("probes past emoji other projects already use", () => {
    expect(fallbackEmoji("proj_abc", new Set(["🌻"]))).toBe("🍄");
    expect(fallbackEmoji("proj_abc", new Set(["🌻", "🍄"]))).toBe("🪐");
  });

  it("keeps its own slot when every fallback is taken", () => {
    expect(fallbackEmoji("proj_abc", new Set(FALLBACK_EMOJI))).toBe("🌻");
  });

  it("hands distinct emoji to projects assigned one after another", () => {
    const taken = new Set<string>();
    for (let index = 0; index < FALLBACK_EMOJI.length; index += 1) {
      taken.add(fallbackEmoji(`proj_${index}`, taken));
    }
    expect(taken.size).toBe(FALLBACK_EMOJI.length);
  });
});

describe("autoEmoji", () => {
  it("uses a keyword hit even when another project shares it", () => {
    expect(autoEmoji(project({ name: "api" }), new Set(["🛠️"]))).toBe("🛠️");
  });

  it("uses the fallback when no keyword matches", () => {
    expect(autoEmoji(project({ id: "proj_abc", name: "zzz" }), NONE)).toBe("🌻");
  });
});

describe("parseEmoji", () => {
  it.each(["🚀", " 🐙 ", "🧑‍💻", "🇺🇸", "1️⃣", "❤️"])("accepts %s", (value) => {
    expect(parseEmoji(value)).toBe(value.trim());
  });

  it.each(["", "a", "🚀🚀", "ok 🚀", "<b>"])("rejects %j", (value) => {
    expect(parseEmoji(value)).toBeNull();
  });
});

describe("catalog", () => {
  it("holds a few hundred unique, valid emoji", () => {
    const emoji = EMOJI_CATALOG.map((entry) => entry.emoji);
    expect(emoji.length).toBeGreaterThan(300);
    expect(new Set(emoji).size).toBe(emoji.length);
    expect(emoji.filter((value) => parseEmoji(value) === null)).toEqual([]);
  });

  it("offers every auto-pick emoji in the picker", () => {
    const catalog = new Set(EMOJI_CATALOG.map((entry) => entry.emoji));
    expect(FALLBACK_EMOJI.filter((value) => !catalog.has(value))).toEqual([]);
  });

  it("searches names and keywords by prefix", () => {
    expect(searchEmoji("octo").map((entry) => entry.emoji)).toEqual(["🐙"]);
    expect(searchEmoji("whale docker").map((entry) => entry.emoji)).toEqual(["🐳"]);
    expect(searchEmoji("  ")).toBe(EMOJI_CATALOG);
  });
});
