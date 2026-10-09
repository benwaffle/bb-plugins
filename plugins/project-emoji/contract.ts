import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const assignmentSchema = z.object({
  projectId: z.string(),
  emoji: z.string(),
  source: z.enum(["manual", "auto"]),
});

export type EmojiAssignment = z.infer<typeof assignmentSchema>;

const colorPinSchema = z.object({
  projectId: z.string(),
  color: z.string(),
});

export type ColorPin = z.infer<typeof colorPinSchema>;

export const rpcContract = defineRpcContract({
  list: {
    input: z.null(),
    output: z.object({
      assignments: z.array(assignmentSchema),
      colors: z.array(colorPinSchema),
    }),
  },
  set: {
    input: z.object({ projectId: z.string().min(1), emoji: z.string() }).strict(),
    output: assignmentSchema,
  },
  reset: {
    input: z.object({ projectId: z.string().min(1) }).strict(),
    output: assignmentSchema,
  },
});
