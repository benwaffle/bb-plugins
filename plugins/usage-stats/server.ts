import { cliCommand, defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import {
  costByProject,
  dashboard,
  modelSlices,
  previousRange,
  rangeEndingToday,
  threadDetail,
  totalsFor,
} from "./aggregate.js";
import { USAGE_CHANNEL } from "./channel.js";
import { rpcContract } from "./contract.js";
import {
  DEFAULT_IMPORT_BUDGET,
  emptyImportCounts,
  importTranscripts,
  projectResolver,
  type ImportBudget,
  type ImportCounts,
  type ProjectPath,
} from "./importer.js";
import { MIGRATIONS, openLedger } from "./ledger.js";
import { formatSummary } from "./summary.js";
import { createThreadRecorder } from "./threads.js";
import { localTranscriptReader, type TranscriptReader } from "./transcripts.js";

export { rpcContract };

export interface UsageStatsOptions {
  reader?: TranscriptReader;
  now?: () => number;
  importBudget?: ImportBudget;
}

/** Pause between import slices, so turns recorded on `thread.idle` and other handlers run in between. */
const SLICE_PAUSE_MS = 250;

function addCounts(total: ImportCounts, slice: ImportCounts): void {
  total.files = slice.files;
  total.filesRead += slice.filesRead;
  total.filesFailed += slice.filesFailed;
  total.filesRestarted += slice.filesRestarted;
  total.filesPending = slice.filesPending;
  total.messages += slice.messages;
  total.repeatedLines += slice.repeatedLines;
  total.prompts += slice.prompts;
  total.sessions = slice.sessions;
}

export interface BackfillCounts {
  threadsRecorded: number;
  ledgerRows: number;
  transcripts: ImportCounts;
}

export function createUsageStats(options: UsageStatsOptions = {}) {
  const reader = options.reader ?? localTranscriptReader();
  const now = options.now ?? Date.now;
  const importBudget = options.importBudget ?? DEFAULT_IMPORT_BUDGET;

  return async function plugin(bb: BbPluginApi) {
    const db = bb.storage.database();
    bb.storage.migrate(db, MIGRATIONS);
    const ledger = openLedger(db);
    const { recordThread, reconcileThreads } = createThreadRecorder(bb, ledger);

    let queue: Promise<unknown> = Promise.resolve();
    /** Runs ledger writers one at a time so an import and a turn never interleave. */
    function serial<T>(work: () => Promise<T>): Promise<T> {
      const next = queue.then(work, work);
      queue = next.catch(() => undefined);
      return next;
    }

    async function listProjects(): Promise<{ names: Map<string, string>; paths: ProjectPath[] }> {
      const projects = await bb.sdk.projects.list({ includePersonal: true });
      const names = new Map(projects.map((project) => [project.id, project.name]));
      const paths = projects.flatMap((project) =>
        project.sources.map((source) => ({ path: source.path, name: project.name })),
      );
      return { names, paths };
    }

    let disposed = false;
    bb.onDispose(() => {
      disposed = true;
    });

    let draining: Promise<ImportCounts> | null = null;
    /**
     * Imports every unread transcript byte, one budgeted slice at a time. Each
     * slice takes the ledger queue on its own, so no handler waits on more
     * than one slice. Concurrent callers share the drain in progress.
     */
    function drainImport(projectPaths?: readonly ProjectPath[]): Promise<ImportCounts> {
      draining ??= (async () => {
        const total = emptyImportCounts();
        const sessions = new Set<string>();
        try {
          const projectOf = projectResolver(projectPaths ?? (await listProjects()).paths);
          for (;;) {
            const slice = await serial(() => importTranscripts(ledger, reader, projectOf, { budget: importBudget, sessions }));
            addCounts(total, slice);
            if (slice.messages > 0 || slice.prompts > 0) bb.realtime.publish(USAGE_CHANNEL, { reason: "import" });
            if (slice.filesPending === 0) {
              ledger.setMeta("importedAt", String(now()));
              break;
            }
            if (disposed) break;
            await new Promise((resolve) => setTimeout(resolve, SLICE_PAUSE_MS));
          }
          return total;
        } finally {
          draining = null;
        }
      })();
      return draining;
    }

    function backfill(): Promise<BackfillCounts> {
      return (async () => {
        const projects = await listProjects();
        const threads = await serial(() => reconcileThreads(projects.names));
        const transcripts = await drainImport(projects.paths);
        return { ...threads, transcripts };
      })();
    }

    async function sampleWindows(): Promise<void> {
      const limits = await bb.sdk.system.usageLimits();
      const ts = now();
      for (const [provider, state] of Object.entries(limits)) {
        if (state.status !== "ok") continue;
        for (const window of state.windows) {
          ledger.addWindowSample({
            provider,
            label: window.label,
            ts,
            usedPercent: window.usedPercent,
            resetsAt: window.resetsAt,
            plan: state.planLabel,
          });
        }
      }
    }

    bb.events.on("thread.idle", async ({ thread }) => {
      await serial(async () => {
        const { names } = await listProjects();
        if ((await recordThread(thread, names)) > 0) bb.realtime.publish(USAGE_CHANNEL, { reason: "turn" });
      });
    });

    bb.background.service("backfill", {
      async start(signal) {
        try {
          const counts = await backfill();
          bb.log.info(`backfill: ${JSON.stringify(counts)}`);
          await sampleWindows();
        } catch (error) {
          bb.log.warn(`backfill failed: ${String(error)}`);
        }
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    });
    bb.background.schedule("import", "*/5 * * * *", () => {
      drainImport().catch((error: unknown) => bb.log.warn(`import failed: ${String(error)}`));
    });
    bb.background.schedule("windows", "*/10 * * * *", sampleWindows);

    bb.rpc.register(rpcContract, {
      dashboard(input) {
        return dashboard(db, input, now());
      },
      thread({ key }) {
        const detail = threadDetail(db, key);
        if (detail === null) throw new Error(`no usage recorded for ${key}`);
        return detail;
      },
    });

    const jsonOption = { json: { type: "boolean", description: "Print the result as JSON" } } as const;
    bb.cli.register(
      defineCli({
        name: "usage-stats",
        summary: "Token usage and API-equivalent cost across bb threads and Claude Code sessions",
        commands: {
          summary: cliCommand({
            summary: "Cost, tokens, cache hit ratio, and turns for today, the last 7 days, and the last N days",
            options: {
              days: {
                type: "integer",
                min: 1,
                max: 365,
                default: 30,
                description: "Length of the longest period, 1–365 days, and of the model and project breakdown",
              },
              ...jsonOption,
            },
            run(input) {
              const days = input.options.days;
              const at = now();
              const range = rangeEndingToday(days, at);
              const lengths = [...new Set([1, 7, days])].sort((left, right) => left - right);
              const periods = [
                ...lengths.map((length) => ({
                  label: length === 1 ? "Today" : `${length} days`,
                  totals: totalsFor(db, "all", rangeEndingToday(length, at)),
                })),
                { label: `prev ${days}d`, totals: totalsFor(db, "all", previousRange(range, days)) },
              ];
              const summary = {
                days,
                periods,
                models: modelSlices(db, "all", range),
                projects: costByProject(db, "all", range),
              };
              return {
                exitCode: 0,
                stdout: input.options.json ? `${JSON.stringify(summary)}\n` : formatSummary(summary),
              };
            },
          }),
          backfill: cliCommand({
            summary:
              "Record every bb thread's usage and import every Claude Code transcript not read yet; prints the counts",
            options: jsonOption,
            async run(input) {
              const counts = await backfill();
              if (input.options.json) return { exitCode: 0, stdout: `${JSON.stringify(counts)}\n` };
              const t = counts.transcripts;
              return {
                exitCode: 0,
                stdout: [
                  `bb threads recorded: ${counts.threadsRecorded} (${counts.ledgerRows} ledger rows)`,
                  `transcript files: ${t.files} listed, ${t.filesRead} read, ${t.filesFailed} unreadable`,
                  `messages: ${t.messages} new, ${t.repeatedLines} repeated content-block lines skipped`,
                  `prompts: ${t.prompts} new across ${t.sessions} sessions with new messages`,
                  "",
                ].join("\n"),
              };
            },
          }),
        },
      }),
    );
  };
}

export default createUsageStats();
