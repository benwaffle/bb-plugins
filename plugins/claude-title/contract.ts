import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const CLAUDE_SERVICE_ID = "claude";

export const DEFAULT_CLAUDE_MODEL = "claude-haiku-4-5-20251001";

/** bb clamps generated thread titles to 48 columns. */
export const BB_TITLE_WIDTH = 48;

export const claudeModelSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9.\-[\]]{0,99}$/,
    "Model names use lowercase letters, digits, dots, dashes, and brackets, like claude-haiku-4-5-20251001 or haiku",
  );

export const claudePathSchema = z
  .string()
  .refine(
    (value) => value === "" || value.startsWith("/"),
    "Leave empty to search PATH, or give an absolute path to the claude binary",
  );

export const maxTitleLengthSchema = z.number().int().min(10).max(BB_TITLE_WIDTH);

/** `null` searches PATH and the usual install directories. */
const claudePathInput = z.string().min(1).nullable();

export const completeInputSchema = z
  .object({
    prompt: z.string().min(1),
    model: claudeModelSchema,
    claudePath: claudePathInput,
    maxTitleLength: maxTitleLengthSchema,
    timeoutMs: z.number().int().positive(),
  })
  .strict();

export type CompleteInput = z.infer<typeof completeInputSchema>;

export const claudeFailureCodeSchema = z.enum([
  "not_found",
  "timeout",
  "request_failed",
]);

export type ClaudeFailureCode = z.infer<typeof claudeFailureCodeSchema>;

export const completeOutputSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      text: z.string(),
      durationMs: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      code: claudeFailureCodeSchema,
      message: z.string().min(1),
    })
    .strict(),
]);

export type CompleteOutput = z.infer<typeof completeOutputSchema>;

export const statusInputSchema = z
  .object({
    claudePath: claudePathInput,
    /** Skip the cached login check and ask `claude auth status` again. */
    refresh: z.boolean(),
  })
  .strict();

export const loginSchema = z.union([
  z.object({ state: z.literal("logged-in") }).strict(),
  z.object({ state: z.literal("logged-out") }).strict(),
  z.object({ state: z.literal("unknown"), message: z.string().min(1) }).strict(),
]);

export type Login = z.infer<typeof loginSchema>;

export const claudeStatusSchema = z
  .object({
    claudePath: z.string().nullable(),
    /** `null` when no claude binary was found. */
    login: loginSchema.nullable(),
    lastLatencyMs: z.number().int().nonnegative().nullable(),
  })
  .strict();

export type ClaudeStatus = z.infer<typeof claudeStatusSchema>;

export const claudeHostContract = defineRpcContract({
  complete: {
    input: completeInputSchema,
    output: completeOutputSchema,
  },
  status: {
    input: statusInputSchema,
    output: claudeStatusSchema,
  },
});
