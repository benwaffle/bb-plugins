import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

export const DIM_MAX = 80;
export const BLUR_MAX = 20;
export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

export const IMAGE_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
} as const;

export type ImageExtension = keyof typeof IMAGE_TYPES;

export const dimSchema = z
  .number()
  .int("Dim must be a whole percentage")
  .min(0, "Dim must be at least 0")
  .max(DIM_MAX, `Dim must be at most ${DIM_MAX}`);

export const blurSchema = z
  .number()
  .int("Blur must be a whole number of pixels")
  .min(0, "Blur must be at least 0")
  .max(BLUR_MAX, `Blur must be at most ${BLUR_MAX}`);

/** The lowercased extension when it names a supported image type, else null. */
export function imageExtension(path: string): ImageExtension | null {
  const match = /\.[^./\\]+$/.exec(path);
  const extension = match?.[0].toLowerCase();
  return extension !== undefined && Object.hasOwn(IMAGE_TYPES, extension)
    ? (extension as ImageExtension)
    : null;
}

/**
 * Validates a stored image path: empty (no wallpaper) or an absolute path
 * ending in a supported image extension. Existence is checked when the file
 * is served, since the file can come and go after the setting is saved.
 */
export const imagePathSchema = z.string().refine(
  (path) => path === "" || (isAbsolute(path) && imageExtension(path) !== null),
  `Image path must be empty or an absolute path to a ${Object.keys(IMAGE_TYPES).join(", ")} file`,
);

/**
 * Turns user input into an absolute path: `~` and `~/…` expand against
 * `home`, other relative paths resolve against `cwd`. Returns null for a
 * relative path when there is no `cwd` to resolve it against.
 */
export function resolveImagePath(input: string, home: string, cwd: string | undefined): string | null {
  const path = input.trim();
  if (path === "~") return home;
  if (path.startsWith("~/")) return resolve(home, path.slice(2));
  if (isAbsolute(path)) return resolve(path);
  return cwd === undefined ? null : resolve(cwd, path);
}

/** Same-origin URL for the image; the content hash makes each file's URL unique. */
export function imageUrl(pluginId: string, hash: string): string {
  return `/api/v1/plugins/${encodeURIComponent(pluginId)}/http/image?v=${encodeURIComponent(hash)}`;
}
