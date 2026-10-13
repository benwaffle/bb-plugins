import type { BbPluginApi, PluginAiServiceStatus } from "@get-bb/plugin-sdk";
import {
  BB_TITLE_WIDTH,
  CLAUDE_SERVICE_ID,
  DEFAULT_CLAUDE_MODEL,
  claudeHostContract,
  claudeModelSchema,
  claudePathSchema,
  maxTitleLengthSchema,
  retitleAfterTurnsSchema,
  type ClaudeStatus,
  type CompleteOutput,
} from "./contract.js";
import { createRetitler } from "./retitle.js";

const CLI_NAME = "claude-title";
const USAGE = `Usage: bb ${CLI_NAME} <status | test [--raw] "<prompt>" | retitle <threadId>> [--json]`;
// bb abandons a title or commit message after 8s. claude gets 6.5s and the
// host call half a second more, so a slow reply fails here with a reason
// instead of as a bare bb timeout.
const COMPLETE_TIMEOUT_MS = 6_500;
const HOST_CALL_GRACE_MS = 500;
// bb gives a service's status two seconds in total.
const STATUS_TIMEOUT_MS = 1_800;
const CLI_STATUS_TIMEOUT_MS = 10_000;
const TEXT_TASKS = ["thread-title", "commit-message"] as const;

type TextTask = (typeof TEXT_TASKS)[number];
type AiServicesView = Awaited<
  ReturnType<BbPluginApi["sdk"]["system"]["aiServices"]>
>;

const TASK_LABELS: Record<TextTask, string> = {
  "thread-title": "Thread titles",
  "commit-message": "Commit messages",
};

/**
 * A stand-in for bb's own thread-title prompt, so `bb claude-title test`
 * shows roughly the title a new thread with that first message would get.
 */
export function testTitlePrompt(task: string): string {
  return [
    "You create concise titles for coding tasks.",
    "Reply with only the title: short, clear, sentence case, in the same language as the task. Keep it under about 40 characters. Summarize the task in your own words instead of copying its text. No quotes, no trailing punctuation, no explanation.",
    "",
    "Task:",
    task,
  ].join("\n");
}

interface ParsedArgv {
  readonly command: string | null;
  readonly positionals: string[];
  readonly json: boolean;
  readonly raw: boolean;
  readonly error: string | null;
}

function parseArgv(argv: string[]): ParsedArgv {
  const positionals: string[] = [];
  let json = false;
  let raw = false;
  for (const arg of argv) {
    if (arg === "--json") {
      json = true;
    } else if (arg === "--raw") {
      raw = true;
    } else if (arg.startsWith("--")) {
      return { command: null, positionals, json, raw, error: `Unknown flag ${arg}` };
    } else {
      positionals.push(arg);
    }
  }
  const [command = null, ...rest] = positionals;
  return { command, positionals: rest, json, raw, error: null };
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function toPluginStatus(status: ClaudeStatus): PluginAiServiceStatus {
  if (status.claudePath === null || status.login === null) {
    return {
      ready: false,
      message:
        "claude was not found on the primary machine. Install Claude Code or set the claude path in the plugin settings.",
    };
  }
  switch (status.login.state) {
    case "logged-in":
      return { ready: true };
    case "logged-out":
      return {
        ready: false,
        message: "Claude Code is not logged in. Run: claude auth login",
      };
    case "unknown":
      return { ready: false, message: status.login.message };
  }
}

function completeTextOrThrow(result: CompleteOutput): string {
  if (result.ok) return result.text;
  throw new Error(result.message);
}

async function readHostId(bb: BbPluginApi): Promise<string> {
  const { primaryHostId } = await bb.sdk.system.config();
  if (primaryHostId === null) {
    throw new Error("No primary machine is connected");
  }
  return primaryHostId;
}

/** The service a task uses right now, as bb resolves it. */
function describeRouting(
  view: AiServicesView,
  task: TextTask,
  pluginId: string,
): { text: string; usesClaude: boolean } {
  const selection = view.selections[task];
  const isClaude = (service: { pluginId: string; serviceId: string }) =>
    service.pluginId === pluginId && service.serviceId === CLAUDE_SERVICE_ID;
  if (selection.mode === "off") {
    return { text: "off", usesClaude: false };
  }
  if (selection.mode === "service") {
    return {
      text: `${selection.serviceId} (plugin ${selection.pluginId})`,
      usesClaude: isClaude(selection),
    };
  }
  const chosen = view.services
    .flatMap((service) =>
      service.automaticRank === null
        ? []
        : [{ ...service, automaticRank: service.automaticRank }],
    )
    .sort((a, b) => a.automaticRank - b.automaticRank)
    .find((service) => service.tasks.includes(task) && service.status.ready);
  if (chosen === undefined) {
    return { text: "automatic, no ready service", usesClaude: false };
  }
  return {
    text: `automatic, currently ${chosen.displayName} (plugin ${chosen.pluginId})`,
    usesClaude: isClaude({ pluginId: chosen.pluginId, serviceId: chosen.id }),
  };
}

function formatLogin(status: ClaudeStatus): string {
  if (status.login === null) return "not checked (no claude binary)";
  switch (status.login.state) {
    case "logged-in":
      return "logged in";
    case "logged-out":
      return "not logged in (run: claude auth login)";
    case "unknown":
      return `unknown: ${status.login.message}`;
  }
}

export default function plugin(bb: BbPluginApi): void {
  const settings = bb.settings.define({
    model: {
      type: "string",
      label: "Claude model",
      description:
        "Model claude runs for titles and commit messages: a full model name or an alias like haiku. A small model keeps replies inside bb's 8-second limit.",
      experimental_schema: claudeModelSchema,
      default: DEFAULT_CLAUDE_MODEL,
    },
    claudePath: {
      type: "string",
      label: "claude path",
      description:
        "Absolute path to the claude binary on the primary machine. Leave empty to search PATH, ~/.local/bin, ~/.claude/local, and the Homebrew bin directories.",
      experimental_schema: claudePathSchema,
      default: "",
    },
    maxTitleLength: {
      type: "number",
      label: "Max title length",
      description: `Characters the model is asked to keep a thread title under, from 10 to ${BB_TITLE_WIDTH}. bb cuts titles at ${BB_TITLE_WIDTH} columns either way.`,
      experimental_schema: maxTitleLengthSchema,
      default: BB_TITLE_WIDTH,
    },
    retitleAfterTurns: {
      type: "number",
      label: "Re-title after turns",
      description:
        "After the plugin titles a thread from its first turn, title it once more from the conversation when this many more turns have finished. 0 turns this off. Titles you typed are never replaced.",
      experimental_schema: retitleAfterTurnsSchema,
      default: 0,
    },
  });

  const host = bb.hosts.experimental_client({ contract: claudeHostContract });

  async function hostSettings() {
    const values = await settings.get();
    return {
      model: values.model,
      claudePath: values.claudePath === "" ? null : values.claudePath,
      maxTitleLength: values.maxTitleLength,
    };
  }

  async function runComplete(
    prompt: string,
    signal: AbortSignal | undefined,
    timeoutMs = COMPLETE_TIMEOUT_MS,
  ): Promise<CompleteOutput> {
    const [hostId, values] = await Promise.all([readHostId(bb), hostSettings()]);
    return host.call(
      "complete",
      { prompt, ...values, timeoutMs },
      {
        hostId,
        timeoutMs: timeoutMs + HOST_CALL_GRACE_MS,
        ...(signal === undefined ? {} : { signal }),
      },
    );
  }

  async function readStatus(args: {
    refresh: boolean;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<ClaudeStatus> {
    const [hostId, { claudePath }] = await Promise.all([
      readHostId(bb),
      hostSettings(),
    ]);
    return host.call(
      "status",
      { claudePath, refresh: args.refresh },
      {
        hostId,
        timeoutMs: args.timeoutMs,
        ...(args.signal === undefined ? {} : { signal: args.signal }),
      },
    );
  }

  bb.experimental_aiServices.register({
    id: CLAUDE_SERVICE_ID,
    displayName: "Claude Code",
    async complete(prompt, { signal }) {
      return completeTextOrThrow(await runComplete(prompt, signal));
    },
    async status() {
      return toPluginStatus(
        await readStatus({ refresh: false, timeoutMs: STATUS_TIMEOUT_MS }),
      );
    },
  });

  const retitler = createRetitler({
    bb,
    complete: (prompt, timeoutMs, signal) => runComplete(prompt, signal, timeoutMs),
    maxTitleLength: async () => (await settings.get()).maxTitleLength,
    retitleAfterTurns: async () => (await settings.get()).retitleAfterTurns,
    titlesRouteHere: async () =>
      describeRouting(await bb.sdk.system.aiServices(), "thread-title", bb.pluginId)
        .usesClaude,
  });
  bb.events.on("thread.idle", (payload) => retitler.onIdle(payload));

  bb.cli.register({
    name: CLI_NAME,
    summary: "Thread titles and commit messages from your Claude Code login",
    commands: [
      {
        name: "status",
        summary:
          "Show the claude binary, its login, the last reply time, and which service titles and commit messages use",
        usage: `bb ${CLI_NAME} status [--json]`,
      },
      {
        name: "test",
        summary:
          "Title a sample first message the way a new thread would, and time it; --raw sends the prompt as-is",
        usage: `bb ${CLI_NAME} test [--raw] "<prompt>" [--json]`,
      },
      {
        name: "retitle",
        summary:
          "Title a thread from its conversation so far, replacing its current title",
        usage: `bb ${CLI_NAME} retitle <threadId> [--json]`,
      },
    ],
    async run(argv, ctx) {
      const parsed = parseArgv(argv);
      if (parsed.error !== null) {
        return { exitCode: 1, stderr: `${parsed.error}\n${USAGE}` };
      }
      try {
        if (parsed.command === "status" && parsed.positionals.length === 0) {
          const [status, view, { model }] = await Promise.all([
            readStatus({
              refresh: true,
              timeoutMs: CLI_STATUS_TIMEOUT_MS,
              ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
            }),
            bb.sdk.system.aiServices(),
            settings.get(),
          ]);
          const routing = Object.fromEntries(
            TEXT_TASKS.map((task) => [
              task,
              describeRouting(view, task, bb.pluginId),
            ]),
          ) as Record<TextTask, ReturnType<typeof describeRouting>>;
          if (parsed.json) {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                ...status,
                ready: toPluginStatus(status).ready,
                model,
                routing,
              }),
            };
          }
          const lines = [
            `claude: ${status.claudePath ?? "not found"}`,
            `Login: ${formatLogin(status)}`,
            `Model: ${model}`,
            `Last reply: ${status.lastLatencyMs === null ? "none since the host worker started" : formatSeconds(status.lastLatencyMs)}`,
          ];
          for (const task of TEXT_TASKS) {
            lines.push(`${TASK_LABELS[task]}: ${routing[task].text}`);
          }
          if (TEXT_TASKS.some((task) => !routing[task].usesClaude)) {
            lines.push(
              `To route a task here, run: bb settings ai-services set <thread-title|commit-message> ${CLAUDE_SERVICE_ID}`,
            );
          }
          return { exitCode: 0, stdout: lines.join("\n") };
        }
        if (parsed.command === "test" && parsed.positionals.length > 0) {
          const text = parsed.positionals.join(" ");
          const startedAt = Date.now();
          const result = await runComplete(
            parsed.raw ? text : testTitlePrompt(text),
            ctx.signal,
          );
          const totalMs = Date.now() - startedAt;
          if (!result.ok) {
            return {
              exitCode: 1,
              stderr: `${result.message} (after ${formatSeconds(totalMs)})`,
            };
          }
          return {
            exitCode: 0,
            stdout: parsed.json
              ? JSON.stringify({
                  text: result.text,
                  claudeMs: result.durationMs,
                  totalMs,
                })
              : `${result.text}\nclaude ${formatSeconds(result.durationMs)}, total ${formatSeconds(totalMs)}`,
          };
        }
        if (parsed.command === "retitle" && parsed.positionals.length === 1) {
          const [threadId = ""] = parsed.positionals;
          const title = await retitler.retitle(threadId, ctx.signal);
          return {
            exitCode: 0,
            stdout: parsed.json ? JSON.stringify({ threadId, title }) : title,
          };
        }
        return { exitCode: 1, stderr: USAGE };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { exitCode: 1, stderr: message };
      }
    },
  });
}
