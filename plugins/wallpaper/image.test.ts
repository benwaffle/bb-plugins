import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ImageFileError, createImageReader, hashBytes } from "./image.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wallpaper-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function expectCode(promise: Promise<unknown>, code: ImageFileError["code"]) {
  await expect(promise).rejects.toBeInstanceOf(ImageFileError);
  await expect(promise).rejects.toMatchObject({ code });
}

describe("hashBytes", () => {
  it("is 16 hex digits and changes with the content", () => {
    const a = hashBytes(new TextEncoder().encode("a"));
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(hashBytes(new TextEncoder().encode("a"))).toBe(a);
    expect(hashBytes(new TextEncoder().encode("b"))).not.toBe(a);
  });
});

describe("createImageReader", () => {
  it("describes a file by hash, type, and size", async () => {
    const path = join(dir, "day.jpg");
    await writeFile(path, "jpeg bytes");
    const file = await createImageReader().describe(path);
    expect(file).toEqual({ path, hash: hashBytes(Buffer.from("jpeg bytes")), mime: "image/jpeg", bytes: 10 });
  });

  it("gives a replaced file a new hash", async () => {
    const reader = createImageReader();
    const path = join(dir, "today.png");
    await writeFile(path, "one");
    await utimes(path, 1_000, 1_000);
    const first = await reader.describe(path);
    await writeFile(path, "two!");
    await utimes(path, 2_000, 2_000);
    const second = await reader.describe(path);
    expect(second.hash).not.toBe(first.hash);
    expect(second.mime).toBe("image/png");
  });

  it("reuses the hash while size and mtime are unchanged", async () => {
    const reader = createImageReader();
    const path = join(dir, "same.jpg");
    await writeFile(path, "aaa");
    await utimes(path, 1_000, 1_000);
    const first = await reader.describe(path);
    await writeFile(path, "bbb");
    await utimes(path, 1_000, 1_000);
    expect((await reader.describe(path)).hash).toBe(first.hash);
    // Reading the bytes always hashes what was read.
    const { file, bytes } = await reader.read(path);
    expect(bytes.toString()).toBe("bbb");
    expect(file.hash).toBe(hashBytes(Buffer.from("bbb")));
    expect((await reader.describe(path)).hash).toBe(file.hash);
  });

  it("refuses missing files, directories, and other types", async () => {
    const reader = createImageReader();
    await expectCode(reader.describe(join(dir, "missing.jpg")), "not_found");
    await mkdir(join(dir, "folder.jpg"));
    await expectCode(reader.describe(join(dir, "folder.jpg")), "not_a_file");
    await writeFile(join(dir, "notes.txt"), "x");
    await expectCode(reader.describe(join(dir, "notes.txt")), "unsupported_type");
  });
});
