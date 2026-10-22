import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { Ledger, LedgerModelTotal, LedgerSnapshot } from "./ledger.js";
import { fromBbTokens, priceTokens } from "./pricing.js";

const THREAD_PAGE = 200;
const RECONCILE_CONCURRENCY = 4;

const bbTokensSchema = z.object({
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  cacheWriteInputTokens: z.number().optional(),
  outputTokens: z.number(),
});

/** `bb.sdk.threads.cost`, on bb builds that price threads; validated because the SDK types omit it. */
const threadCostSchema = z.object({
  cost: z
    .object({
      models: z.array(z.object({ model: z.string(), costUsd: z.number().nullable(), tokens: bbTokensSchema })),
    })
    .nullable(),
  turns: z.array(z.object({ turnId: z.string() })),
});
type ThreadCostCall = (args: { threadId: string }) => Promise<unknown>;

/** The data of a `thread/tokenUsage/updated` event: cumulative totals, per model on newer bb builds. */
const tokenUsageEventSchema = z.object({
  providerThreadId: z.string(),
  tokenUsage: z.object({
    total: bbTokensSchema,
    models: z.array(z.object({ model: z.string(), breakdown: bbTokensSchema })).optional(),
  }),
});

export interface ThreadLike {
  id: string;
  title: string | null;
  titleFallback: string | null;
  projectId: string;
  providerId: string;
  updatedAt: number;
}

/**
 * Records bb threads into the ledger: each thread's latest token usage
 * event names its provider session and time, and the thread cost call (or,
 * without it, the event's own totals) gives the per-model totals.
 */
export function createThreadRecorder(bb: BbPluginApi, ledger: Ledger) {
  async function latestTokenUsage(threadId: string) {
    const [event] = await bb.sdk.threads.events.list({
      threadId,
      types: ["thread/tokenUsage/updated"],
      order: "desc",
      limit: "1",
    });
    if (event === undefined) return null;
    const data = tokenUsageEventSchema.safeParse(event.data);
    return data.success ? { ...data.data, seq: event.seq, createdAt: event.createdAt } : null;
  }

  async function threadModels(
    thread: ThreadLike,
    usage: z.infer<typeof tokenUsageEventSchema>,
  ): Promise<{ models: LedgerModelTotal[]; turnId: string | null }> {
    const cost = (bb.sdk.threads as unknown as { cost?: ThreadCostCall }).cost;
    if (typeof cost === "function") {
      const parsed = threadCostSchema.safeParse(await cost({ threadId: thread.id }));
      if (parsed.success && parsed.data.cost !== null) {
        return {
          models: parsed.data.cost.models.map((model) => ({
            model: model.model,
            tokens: fromBbTokens(thread.providerId, model.tokens),
            costUsd: model.costUsd,
          })),
          turnId: parsed.data.turns.at(-1)?.turnId ?? null,
        };
      }
    }
    const models = usage.tokenUsage.models ?? [{ model: "unknown", breakdown: usage.tokenUsage.total }];
    return {
      models: models.map((model) => {
        const tokens = fromBbTokens(thread.providerId, model.breakdown);
        return { model: model.model, tokens, costUsd: priceTokens(model.model, tokens) };
      }),
      turnId: null,
    };
  }

  /** Records a thread's growth since its last snapshot; returns the ledger rows written. */
  async function recordThread(thread: ThreadLike, projectNames: ReadonlyMap<string, string>): Promise<number> {
    const usage = await latestTokenUsage(thread.id);
    const projectName = projectNames.get(thread.projectId) ?? null;
    ledger.rememberThread(
      {
        threadId: thread.id,
        title: thread.title ?? thread.titleFallback,
        projectId: thread.projectId,
        projectName,
        provider: thread.providerId,
        updatedAt: thread.updatedAt,
      },
      usage?.providerThreadId ?? null,
    );
    if (usage === null) return 0;
    const { models, turnId } = await threadModels(thread, usage);
    const snapshot: LedgerSnapshot = {
      threadId: thread.id,
      sessionId: usage.providerThreadId,
      provider: thread.providerId,
      project: projectName,
      turnId: turnId ?? `seq-${usage.seq}`,
      ts: usage.createdAt,
      models,
    };
    return ledger.recordSnapshot(snapshot);
  }

  async function listAllThreads(): Promise<ThreadLike[]> {
    const threads: ThreadLike[] = [];
    for (const archived of [false, true]) {
      for (let offset = 0; ; offset += THREAD_PAGE) {
        const page = await bb.sdk.threads.list({ archived, includeHidden: true, limit: THREAD_PAGE, offset });
        threads.push(...page);
        if (page.length < THREAD_PAGE) break;
      }
    }
    return threads;
  }

  /** Records every thread that changed since it was last recorded. */
  async function reconcileThreads(projectNames: ReadonlyMap<string, string>) {
    const stale = (await listAllThreads()).filter(
      (thread) => ledger.threadUpdatedAt(thread.id) !== thread.updatedAt,
    );
    let threadsRecorded = 0;
    let ledgerRows = 0;
    for (let index = 0; index < stale.length; index += RECONCILE_CONCURRENCY) {
      const results = await Promise.allSettled(
        stale.slice(index, index + RECONCILE_CONCURRENCY).map((thread) => recordThread(thread, projectNames)),
      );
      for (const result of results) {
        if (result.status === "fulfilled") {
          threadsRecorded += 1;
          ledgerRows += result.value;
        } else {
          bb.log.warn(`thread usage not recorded: ${String(result.reason)}`);
        }
      }
    }
    return { threadsRecorded, ledgerRows };
  }

  return { recordThread, reconcileThreads };
}
