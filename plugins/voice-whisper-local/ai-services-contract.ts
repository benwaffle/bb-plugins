import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

const aiServiceErrorCodeSchema = z.enum([
  "timeout",
  "rate_limited",
  "service_unavailable",
  "auth_required",
  "request_failed",
  "invalid_response",
]);

const failureSchema = z
  .object({
    ok: z.literal(false),
    code: aiServiceErrorCodeSchema,
    message: z.string().min(1),
  })
  .strict();

const aiInferenceCompleteInputSchema = z
  .object({
    serviceId: z.string().min(1),
    model: z.string().min(1),
    reasoningEffort: z.literal("none"),
    prompt: z.string().min(1),
    outputSchema: jsonObjectSchema,
    timeoutMs: z.number().int().positive(),
  })
  .strict();

const aiInferenceCompleteOutputSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      model: z.string().min(1),
      value: jsonObjectSchema,
    })
    .strict(),
  failureSchema,
]);

const aiVoiceTranscribeInputSchema = z
  .object({
    serviceId: z.string().min(1),
    model: z.string().min(1),
    audioBase64: z.string().min(1),
    mimeType: z.string().min(1),
    filename: z.string().min(1),
    prompt: z.string().nullable(),
    timeoutMs: z.number().int().positive(),
  })
  .strict();

const aiVoiceTranscribeOutputSchema = z.union([
  z
    .object({ ok: z.literal(true), model: z.string().min(1), text: z.string() })
    .strict(),
  failureSchema,
]);

export const aiServicesHostContract = defineRpcContract({
  "ai.inference.complete": {
    input: aiInferenceCompleteInputSchema,
    output: aiInferenceCompleteOutputSchema,
  },
  "ai.voice.transcribe": {
    input: aiVoiceTranscribeInputSchema,
    output: aiVoiceTranscribeOutputSchema,
  },
});
