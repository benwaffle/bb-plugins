import { describe, expect, it } from "vitest";
import { applyInputSchema } from "./contract.js";
import {
  BLUR_MAX,
  DIM_MAX,
  blurSchema,
  dimSchema,
  imageExtension,
  imagePathSchema,
  imageUrl,
  resolveImagePath,
} from "./model.js";

describe("dim and blur", () => {
  it("accept whole numbers inside the range", () => {
    for (const value of [0, 35, DIM_MAX]) expect(dimSchema.safeParse(value).success).toBe(true);
    for (const value of [0, 8, BLUR_MAX]) expect(blurSchema.safeParse(value).success).toBe(true);
  });

  it("reject values outside the range or with a fraction", () => {
    for (const value of [-1, DIM_MAX + 1, 12.5]) expect(dimSchema.safeParse(value).success).toBe(false);
    for (const value of [-1, BLUR_MAX + 1, 0.5]) expect(blurSchema.safeParse(value).success).toBe(false);
  });
});

describe("imagePathSchema", () => {
  it("accepts empty and absolute image paths", () => {
    for (const path of ["", "/Users/me/.bb/wallpaper/2026-11-10.jpg", "/tmp/a.PNG", "/x/y.webp"]) {
      expect(imagePathSchema.safeParse(path).success).toBe(true);
    }
  });

  it("rejects relative paths and other file types", () => {
    for (const path of ["today.jpg", "~/today.jpg", "/tmp/notes.txt", "/tmp/jpg", "/tmp/.jpg/file"]) {
      expect(imagePathSchema.safeParse(path).success).toBe(false);
    }
  });
});

describe("imageExtension", () => {
  it("lowercases known extensions and refuses the rest", () => {
    expect(imageExtension("/a/B.JPEG")).toBe(".jpeg");
    expect(imageExtension("/a/b.avif")).toBe(".avif");
    expect(imageExtension("/a/b.svg")).toBeNull();
    expect(imageExtension("/a/b")).toBeNull();
    expect(imageExtension("/a/b.constructor")).toBeNull();
  });
});

describe("resolveImagePath", () => {
  const home = "/Users/me";

  it("expands ~ and resolves relative paths against cwd", () => {
    expect(resolveImagePath("~/.bb/wallpaper/today.jpg", home, undefined)).toBe("/Users/me/.bb/wallpaper/today.jpg");
    expect(resolveImagePath("  /a/../b.jpg ", home, undefined)).toBe("/b.jpg");
    expect(resolveImagePath("pics/a.jpg", home, "/work")).toBe("/work/pics/a.jpg");
  });

  it("returns null for a relative path without a cwd", () => {
    expect(resolveImagePath("a.jpg", home, undefined)).toBeNull();
  });
});

describe("applyInputSchema", () => {
  it("takes a path with optional dim and blur", () => {
    expect(applyInputSchema.parse({ path: "/a.jpg" })).toEqual({ path: "/a.jpg" });
    expect(applyInputSchema.parse({ path: "/a.jpg", dim: 30, blur: 4 })).toEqual({ path: "/a.jpg", dim: 30, blur: 4 });
  });

  it("rejects unknown keys, an empty path, and out-of-range values", () => {
    expect(applyInputSchema.safeParse({ path: "/a.jpg", opacity: 1 }).success).toBe(false);
    expect(applyInputSchema.safeParse({ path: "" }).success).toBe(false);
    expect(applyInputSchema.safeParse({ path: "/a.jpg", dim: 81 }).success).toBe(false);
    expect(applyInputSchema.safeParse({ path: "/a.jpg", blur: 21 }).success).toBe(false);
  });
});

describe("imageUrl", () => {
  it("names the plugin route and carries the hash", () => {
    expect(imageUrl("wallpaper", "0123456789abcdef")).toBe("/api/v1/plugins/wallpaper/http/image?v=0123456789abcdef");
  });
});
