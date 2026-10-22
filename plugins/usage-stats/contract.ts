import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const rangeDaysSchema = z.union([z.literal(1), z.literal(7), z.literal(30), z.literal(90)]);
export type RangeDays = z.infer<typeof rangeDaysSchema>;

/** `bb` is usage tied to a bb thread; `outside` is Claude Code sessions bb does not know. */
export const sourceSchema = z.enum(["all", "bb", "outside"]);
export type Source = z.infer<typeof sourceSchema>;

export const threadSortSchema = z.enum(["cost", "tokens", "turns"]);
export type ThreadSort = z.infer<typeof threadSortSchema>;

const tokensSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
});

export const totalsSchema = tokensSchema.extend({
  costUsd: z.number(),
  tokens: z.number(),
  /** Tokens of models without a list price, left out of `costUsd`. */
  unpricedTokens: z.number(),
  /** What cache reads saved against the same tokens sent uncached. */
  savedUsd: z.number(),
  turns: z.number(),
  threads: z.number(),
});
export type Totals = z.infer<typeof totalsSchema>;

export const modelSliceSchema = tokensSchema.extend({ model: z.string(), costUsd: z.number() });
export type ModelSlice = z.infer<typeof modelSliceSchema>;

export const daySchema = z.object({
  /** Local calendar day, `YYYY-MM-DD`. */
  day: z.string(),
  models: z.array(modelSliceSchema),
});
export type DayUsage = z.infer<typeof daySchema>;

export const modelKeySchema = z.object({
  model: z.string(),
  label: z.string(),
  /** Categorical color slot 0–3, fixed per model across ranges; null folds into Other. */
  slot: z.number().int().min(0).max(3).nullable(),
});
export type ModelKey = z.infer<typeof modelKeySchema>;

export const projectRowSchema = z.object({
  name: z.string(),
  costUsd: z.number(),
  tokens: z.number(),
  threads: z.number(),
  /** The fold of every project past the top rows. */
  isOther: z.boolean(),
});
export type ProjectRow = z.infer<typeof projectRowSchema>;

export const providerRowSchema = z.object({ provider: z.string(), costUsd: z.number(), tokens: z.number() });
export type ProviderRow = z.infer<typeof providerRowSchema>;

export const threadRowSchema = z.object({
  /** `thread:<id>` for a bb thread, `session:<id>` for a Claude Code session outside bb. */
  key: z.string(),
  threadId: z.string().nullable(),
  title: z.string(),
  project: z.string().nullable(),
  provider: z.string(),
  turns: z.number(),
  tokens: z.number(),
  costUsd: z.number(),
  cacheHit: z.number().nullable(),
  lastTs: z.number(),
});
export type ThreadRow = z.infer<typeof threadRowSchema>;

export const windowSchema = z.object({
  label: z.string(),
  usedPercent: z.number(),
  resetsAt: z.string().nullable(),
});

export const windowSeriesSchema = z.object({
  label: z.string(),
  points: z.array(z.object({ ts: z.number(), usedPercent: z.number() })),
});

export const subscriptionSchema = z.object({
  provider: z.string(),
  plan: z.string().nullable(),
  sampledAt: z.number(),
  windows: z.array(windowSchema),
  /** The longest window's samples over the last 7 days. */
  series: windowSeriesSchema.nullable(),
});
export type Subscription = z.infer<typeof subscriptionSchema>;

export const dashboardSchema = z.object({
  rangeDays: rangeDaysSchema,
  source: sourceSchema,
  current: totalsSchema,
  previous: totalsSchema,
  models: z.array(modelKeySchema),
  /** At least 7 days, oldest first, so Today still shows its week. */
  days: z.array(daySchema),
  projects: z.array(projectRowSchema),
  providers: z.array(providerRowSchema),
  threads: z.array(threadRowSchema),
  subscriptions: z.array(subscriptionSchema),
  sources: z.object({ bbThreads: z.number(), outsideSessions: z.number() }),
  importedAt: z.number().nullable(),
});
export type Dashboard = z.infer<typeof dashboardSchema>;

export const turnSchema = z.object({ index: z.number(), ts: z.number(), costUsd: z.number(), tokens: z.number() });

export const threadDetailSchema = z.object({
  key: z.string(),
  threadId: z.string().nullable(),
  sessionIds: z.array(z.string()),
  title: z.string(),
  project: z.string().nullable(),
  provider: z.string(),
  totals: totalsSchema,
  turns: z.array(turnSchema),
  models: z.array(modelSliceSchema),
  lastTs: z.number().nullable(),
});
export type ThreadDetail = z.infer<typeof threadDetailSchema>;

export const rpcContract = defineRpcContract({
  dashboard: {
    input: z
      .object({ days: rangeDaysSchema, source: sourceSchema, sort: threadSortSchema })
      .strict(),
    output: dashboardSchema,
  },
  thread: {
    input: z.object({ key: z.string().regex(/^(thread|session):[\w.-]+$/) }).strict(),
    output: threadDetailSchema,
  },
});
