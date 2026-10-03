import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "./server.js";

const PLUGIN_ID = "project-emoji";

interface ProjectSeed {
  id: string;
  name: string;
  createdAt: number;
  path?: string;
}

function projectResponse(seed: ProjectSeed) {
  return {
    id: seed.id,
    name: seed.name,
    kind: "standard" as const,
    createdAt: seed.createdAt,
    updatedAt: seed.createdAt,
    gitRemoteUrl: null,
    sources:
      seed.path === undefined
        ? []
        : [
            {
              id: `src_${seed.id}`,
              projectId: seed.id,
              hostId: "host_local",
              type: "local_path" as const,
              path: seed.path,
              isDefault: true,
              createdAt: seed.createdAt,
              updatedAt: seed.createdAt,
            },
          ],
  };
}

async function load(projects: ProjectSeed[]) {
  const host = createFakePluginHost({
    pluginId: PLUGIN_ID,
    sdk: { projects: { list: async () => projects.map(projectResponse) } },
  });
  await plugin(host.bb);
  return host;
}

const BB = { id: "proj_bb", name: "bb", createdAt: 1, path: "/Users/me/dev/bb" };
const ABC = { id: "proj_abc", name: "zzz", createdAt: 2 };
const OTHER = { id: "proj_other", name: "qqq", createdAt: 3 };

async function list(harness: Awaited<ReturnType<typeof load>>["harness"]) {
  return (await harness.callRpc("list")) as {
    assignments: { projectId: string; emoji: string; source: string }[];
  };
}

describe("project-emoji server", () => {
  it("assigns automatic emoji on first list and keeps them", async () => {
    const { harness } = await load([BB, ABC]);
    const first = await list(harness);
    expect(first.assignments).toEqual([
      { projectId: "proj_bb", emoji: "🐙", source: "auto" },
      { projectId: "proj_abc", emoji: "🌻", source: "auto" },
    ]);
    expect(await list(harness)).toEqual(first);
  });

  it("does not reshuffle earlier projects when a later one collides", async () => {
    const { harness } = await load([ABC]);
    await list(harness);
    harness.sdk.stub("projects.list", async () =>
      [ABC, OTHER].map(projectResponse),
    );
    const { assignments } = await list(harness);
    expect(assignments[0]).toEqual({ projectId: "proj_abc", emoji: "🌻", source: "auto" });
    expect(assignments[1]!.emoji).not.toBe("🌻");
  });

  it("persists a manual pick across a reload and resets it to automatic", async () => {
    const { harness } = await load([BB, ABC]);
    await list(harness);
    expect(await harness.callRpc("set", { projectId: "proj_bb", emoji: "🦀" })).toEqual({
      projectId: "proj_bb",
      emoji: "🦀",
      source: "manual",
    });
    expect(harness.realtimeSignals.map((signal) => signal.channel)).toEqual(["changed"]);

    const reloaded = await harness.reload(plugin);
    const { assignments } = await list(reloaded.harness);
    expect(assignments[0]).toEqual({ projectId: "proj_bb", emoji: "🦀", source: "manual" });

    expect(await reloaded.harness.callRpc("reset", { projectId: "proj_bb" })).toEqual({
      projectId: "proj_bb",
      emoji: "🐙",
      source: "auto",
    });
  });

  it("rejects input that is not one emoji and unknown projects", async () => {
    const { harness } = await load([BB]);
    await expect(
      harness.callRpc("set", { projectId: "proj_bb", emoji: "rocket" }),
    ).rejects.toThrow(/not a single emoji/);
    await expect(
      harness.callRpc("set", { projectId: "proj_missing", emoji: "🚀" }),
    ).rejects.toThrow(/no project with id proj_missing/);
    await expect(harness.callRpc("reset", { projectId: "proj_missing" })).rejects.toThrow(
      /no project with id proj_missing/,
    );
  });

  it("sets, lists, and clears through the CLI", async () => {
    const { harness } = await load([BB, ABC]);

    const set = await harness.runCli(["set", "proj_abc", "🚀"]);
    expect(set).toMatchObject({ exitCode: 0, stdout: "🚀 pinned for proj_abc\n" });

    const listed = await harness.runCli(["list"]);
    expect(listed.stdout).toBe(
      "🐙\tauto\tproj_bb\tbb\n🚀\tmanual\tproj_abc\tzzz\n",
    );

    const cleared = await harness.runCli(["clear", "proj_abc", "--json"]);
    expect(JSON.parse(cleared.stdout)).toEqual({
      projectId: "proj_abc",
      emoji: "🌻",
      source: "auto",
    });

    const invalid = await harness.runCli(["set", "proj_abc", "nope"]);
    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.stderr).toContain("not a single emoji");
  });
});
