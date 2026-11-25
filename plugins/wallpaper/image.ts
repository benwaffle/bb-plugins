import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { IMAGE_TYPES, MAX_IMAGE_BYTES, imageExtension } from "./model.js";

export interface ImageFile {
  path: string;
  /** First 16 hex digits of the SHA-256 of the file's bytes. */
  hash: string;
  mime: string;
  bytes: number;
}

export class ImageFileError extends Error {
  constructor(
    readonly code: "unsupported_type" | "not_found" | "not_a_file" | "too_large",
    message: string,
  ) {
    super(message);
  }
}

export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  file: ImageFile;
}

export interface ImageReader {
  /** Stats and hashes the file, rehashing only when its size or mtime changed. */
  describe(path: string): Promise<ImageFile>;
  /** The file's current bytes, hashed as read, with their description. */
  read(path: string): Promise<{ file: ImageFile; bytes: Buffer }>;
}

export function createImageReader(): ImageReader {
  const cache = new Map<string, CacheEntry>();

  async function statImage(path: string) {
    const extension = imageExtension(path);
    if (extension === null) {
      throw new ImageFileError(
        "unsupported_type",
        `${path} is not a ${Object.keys(IMAGE_TYPES).join(", ")} file`,
      );
    }
    let info;
    try {
      info = await stat(path);
    } catch {
      throw new ImageFileError("not_found", `${path} does not exist`);
    }
    if (!info.isFile()) throw new ImageFileError("not_a_file", `${path} is not a regular file`);
    if (info.size > MAX_IMAGE_BYTES) {
      throw new ImageFileError(
        "too_large",
        `${path} is ${info.size} bytes; the limit is ${MAX_IMAGE_BYTES}`,
      );
    }
    return { info, mime: IMAGE_TYPES[extension] };
  }

  function remember(path: string, mtimeMs: number, mime: string, bytes: Buffer): ImageFile {
    const file: ImageFile = { path, hash: hashBytes(bytes), mime, bytes: bytes.byteLength };
    cache.clear();
    cache.set(path, { mtimeMs, size: bytes.byteLength, file });
    return file;
  }

  return {
    async describe(path) {
      const { info, mime } = await statImage(path);
      const cached = cache.get(path);
      if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
        return cached.file;
      }
      return remember(path, info.mtimeMs, mime, await readFile(path));
    },

    async read(path) {
      const { info, mime } = await statImage(path);
      const bytes = await readFile(path);
      return { file: remember(path, info.mtimeMs, mime, bytes), bytes };
    },
  };
}
