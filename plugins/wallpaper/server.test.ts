import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WallpaperState } from "./contract.js";
import { hashBytes } from "./image.js";
import plugin from "./server.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wallpaper-server-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function load() {
  const host = createFakePluginHost({ pluginId: "wallpaper" });
  await plugin(host.bb);
  return host.harness;
}

async function image(name: string, content: string, mtime = 1_000): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, content);
  await utimes(path, mtime, mtime);
  return path;
}

describe("wallpaper server", () => {
  it("applies a file over rpc and serves it under its hash", async () => {
    const harness = await load();
    const path = await image("day.jpg", "first");
    const state = (await harness.callRpc("apply", { path, dim: 30, blur: 4 })) as WallpaperState;
    const hash = hashBytes(Buffer.from("first"));
    expect(state).toEqual({
      enabled: true,
      path,
      dim: 30,
      blur: 4,
      image: { url: `/api/v1/plugins/wallpaper/http/image?v=${hash}`, hash, mime: "image/jpeg", bytes: 5 },
      error: null,
    });
    expect(harness.realtimeSignals.length).toBeGreaterThan(0);

    const response = await harness.fetchHttp("GET", `/image?v=${hash}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/jpeg");
    expect(response.headers.get("Cache-Control")).toContain("immutable");
    expect(response.headers.get("ETag")).toBe(`"${hash}"`);
    expect(await response.text()).toBe("first");
  });

  it("does not cache the current file under a stale hash", async () => {
    const harness = await load();
    await harness.callRpc("apply", { path: await image("day.png", "png") });
    const response = await harness.fetchHttp("GET", "/image?v=0000000000000000");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("swaps the url when a new file is applied", async () => {
    const harness = await load();
    const first = (await harness.callRpc("apply", { path: await image("a.jpg", "a") })) as WallpaperState;
    const second = (await harness.callRpc("apply", { path: await image("b.jpg", "b") })) as WallpaperState;
    expect(second.image?.url).not.toBe(first.image?.url);
    expect(second.dim).toBe(0);
  });

  it("answers a matching ETag with 304", async () => {
    const harness = await load();
    const state = (await harness.callRpc("apply", { path: await image("a.jpg", "a") })) as WallpaperState;
    const response = await harness.fetchHttp("GET", `/image?v=${state.image!.hash}`, {
      headers: { "If-None-Match": `"${state.image!.hash}"` },
    });
    expect(response.status).toBe(304);
  });

  it("rejects missing files and keeps the previous wallpaper", async () => {
    const harness = await load();
    const path = await image("a.jpg", "a");
    await harness.callRpc("apply", { path });
    await expect(harness.callRpc("apply", { path: join(dir, "missing.jpg") })).rejects.toThrow(/does not exist/);
    expect(((await harness.callRpc("get", null)) as WallpaperState).path).toBe(path);
  });

  it("reports a wallpaper whose file disappeared", async () => {
    const harness = await load();
    const path = await image("a.jpg", "a");
    await harness.callRpc("apply", { path });
    await rm(path);
    const state = (await harness.callRpc("get", null)) as WallpaperState;
    expect(state.image).toBeNull();
    expect(state.error).toMatch(/does not exist/);
    expect((await harness.fetchHttp("GET", "/image?v=x")).status).toBe(404);
  });

  it("applies, shows, and clears from the CLI", async () => {
    const harness = await load();
    await image("rel.jpg", "rel");
    const applied = await harness.runCli(["apply", "rel.jpg", "--dim", "20", "--blur", "3", "--json"], { cwd: dir });
    expect(applied.exitCode).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({ path: join(dir, "rel.jpg"), dim: 20, blur: 3, enabled: true });

    const shown = await harness.runCli(["show"]);
    expect(shown.stdout).toContain(`path\t${join(dir, "rel.jpg")}`);
    expect(shown.stdout).toContain("dim\t20%");

    const cleared = await harness.runCli(["clear", "--json"]);
    expect(JSON.parse(cleared.stdout)).toMatchObject({ path: "", image: null, dim: 20, blur: 3 });

    expect((await harness.runCli(["apply", "a.jpg", "--dim", "81"], { cwd: dir })).exitCode).not.toBe(0);
  });

  it("rejects out-of-range settings", async () => {
    const harness = await load();
    await expect(harness.setSettings({ dim: 90 })).rejects.toThrow();
    await expect(harness.setSettings({ blur: 2.5 })).rejects.toThrow();
    await expect(harness.setSettings({ imagePath: "relative.jpg" })).rejects.toThrow();
    await harness.setSettings({ dim: 80, blur: 20, imagePath: "/abs/x.webp" });
  });
});
