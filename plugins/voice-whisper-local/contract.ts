import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const WHISPER_SERVICE_ID = "whisper";

export const DEFAULT_WHISPER_MODEL = "base.en";

export const whisperModelNameSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9.-]{0,63}$/,
    "Model names use lowercase letters, digits, dots, and dashes, like base.en",
  );

export type WhisperModelName = z.infer<typeof whisperModelNameSchema>;

const installedModelSchema = z
  .object({
    name: whisperModelNameSchema,
    path: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict();

export type InstalledModel = z.infer<typeof installedModelSchema>;

export const whisperStatusSchema = z
  .object({
    whisperCli: z.string().nullable(),
    ffmpeg: z.string().nullable(),
    modelDir: z.string().min(1),
    models: z.array(installedModelSchema),
  })
  .strict();

export type WhisperStatus = z.infer<typeof whisperStatusSchema>;

export const prepareModelInputSchema = z
  .object({ model: whisperModelNameSchema })
  .strict();

export const prepareModelOutputSchema = z
  .object({
    model: installedModelSchema,
    downloaded: z.boolean(),
    warmupMs: z.number().int().nonnegative(),
  })
  .strict();

export type PrepareModelOutput = z.infer<typeof prepareModelOutputSchema>;

export const whisperFailureCodeSchema = z.enum(["timeout", "request_failed"]);

export type WhisperFailureCode = z.infer<typeof whisperFailureCodeSchema>;

export const transcribeInputSchema = z
  .object({
    model: whisperModelNameSchema,
    audioBase64: z.string().min(1),
    mimeType: z.string().min(1),
    filename: z.string().min(1),
    prompt: z.string().nullable(),
    timeoutMs: z.number().int().positive(),
  })
  .strict();

export type TranscribeInput = z.infer<typeof transcribeInputSchema>;

export const transcribeOutputSchema = z.union([
  z.object({ ok: z.literal(true), text: z.string() }).strict(),
  z
    .object({
      ok: z.literal(false),
      code: whisperFailureCodeSchema,
      message: z.string().min(1),
    })
    .strict(),
]);

export type TranscribeOutput = z.infer<typeof transcribeOutputSchema>;

export const whisperHostContract = defineRpcContract({
  transcribe: {
    input: transcribeInputSchema,
    output: transcribeOutputSchema,
  },
  status: {
    input: z.null(),
    output: whisperStatusSchema,
  },
  prepareModel: {
    input: prepareModelInputSchema,
    output: prepareModelOutputSchema,
  },
});
