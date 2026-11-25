import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { blurSchema, dimSchema } from "./model.js";

export const stateSchema = z.object({
  enabled: z.boolean(),
  /** Absolute path from the settings; empty when no wallpaper is set. */
  path: z.string(),
  dim: z.number(),
  blur: z.number(),
  /** Present when the file at `path` exists and can be served. */
  image: z
    .object({ url: z.string(), hash: z.string(), mime: z.string(), bytes: z.number() })
    .nullable(),
  /** Why `image` is null although `path` is set. */
  error: z.string().nullable(),
});

export type WallpaperState = z.infer<typeof stateSchema>;

export const applyInputSchema = z
  .object({
    /** Absolute, or `~/…`. */
    path: z.string().min(1),
    dim: dimSchema.optional(),
    blur: blurSchema.optional(),
  })
  .strict();

export type ApplyInput = z.infer<typeof applyInputSchema>;

export const rpcContract = defineRpcContract({
  get: { input: z.null(), output: stateSchema },
  apply: { input: applyInputSchema, output: stateSchema },
  clear: { input: z.null(), output: stateSchema },
});
