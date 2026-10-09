import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const itemSchema = z.object({
  id: z.string(),
  label: z.string(),
  reason: z.string(),
  expected: z.string(),
  current: z.string(),
  compliant: z.boolean(),
});

const statusSchema = z.object({
  items: z.array(itemSchema),
  compliant: z.boolean(),
  lastCheckedAt: z.number().nullable(),
  lastError: z.string().nullable(),
});

export type PolicyStatus = z.infer<typeof statusSchema>;

export const rpcContract = defineRpcContract({
  status: { input: z.null(), output: statusSchema },
  apply: { input: z.null(), output: statusSchema },
});

export const REALTIME_CHANNEL = "status";
