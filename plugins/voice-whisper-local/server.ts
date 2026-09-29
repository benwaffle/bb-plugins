import { Buffer } from "node:buffer";
import type { BbPluginApi, PluginAiServiceStatus } from "@get-bb/plugin-sdk";
import {
  DEFAULT_WHISPER_MODEL,
  WHISPER_SERVICE_ID,
  whisperHostContract,
  whisperModelNameSchema,
  type PrepareModelOutput,
  type WhisperStatus,
} from "./contract.js";

const CLI_NAME = "whisper";
const USAGE = `Usage: bb ${CLI_NAME} <status|prepare <model>> [--host <id-or-name>] [--json]`;
const PREPARE_TIMEOUT_MS = 30 * 60_000;
const STATUS_TIMEOUT_MS = 30_000;
const MEGABYTE = 1024 * 1024;
const TRANSCRIBE_TIMEOUT_MS = 10_000;
const HOST_CALL_GRACE_MS = 1_000;

interface ParsedArgv {
  readonly command: string | null;
  readonly positionals: string[];
  readonly json: boolean;
  readonly host: string | null;
  readonly error: string | null;
}

interface TargetHost {
  readonly id: string;
  readonly name: string;
}

class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

function parseArgv(argv: string[]): ParsedArgv {
  const positionals: string[] = [];
  let json = false;
  let host: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--host") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return {
          command: null,
          positionals,
          json,
          host,
          error: "--host requires a machine id or name",
        };
      }
      host = value;
      index += 1;
    } else if (arg !== undefined && arg.startsWith("--")) {
      return {
        command: null,
        positionals,
        json,
        host,
        error: `Unknown flag ${arg}`,
      };
    } else if (arg !== undefined) {
      positionals.push(arg);
    }
  }
  const [command = null, ...rest] = positionals;
  return { command, positionals: rest, json, host, error: null };
}

function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / MEGABYTE)} MB`;
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

const VOICE_SELECTION_HINT = `bb settings ai-services set voice ${WHISPER_SERVICE_ID}`;

type VoiceSelection = Awaited<
  ReturnType<BbPluginApi["sdk"]["system"]["aiServices"]>
>["selections"]["voice"];

function describeVoiceSelection(selection: VoiceSelection): string {
  return selection.mode === "service"
    ? `${selection.serviceId} (plugin ${selection.pluginId})`
    : selection.mode;
}

function formatStatus(args: {
  host: TargetHost;
  status: WhisperStatus;
  model: string;
  voice: VoiceSelection;
  voiceUsesWhisper: boolean;
}): string {
  const { status } = args;
  const lines = [
    `Host: ${args.host.name} (${args.host.id})`,
    `whisper-cli: ${status.whisperCli ?? "not found (brew install whisper.cpp)"}`,
    `ffmpeg: ${status.ffmpeg ?? "not found (brew install ffmpeg)"}`,
    `Model directory: ${status.modelDir}`,
  ];
  if (status.models.length === 0) {
    lines.push(
      `Models: none downloaded. Run: bb ${CLI_NAME} prepare ${args.model}`,
    );
  } else {
    lines.push("Models:");
    for (const model of status.models) {
      lines.push(`  ${model.name} (${formatMegabytes(model.sizeBytes)})`);
    }
  }
  lines.push(`Selected model: ${args.model}`);
  if (!status.models.some((model) => model.name === args.model)) {
    lines.push(
      `The selected model is not downloaded. Run: bb ${CLI_NAME} prepare ${args.model}`,
    );
  }
  lines.push(`Voice input service: ${describeVoiceSelection(args.voice)}`);
  if (!args.voiceUsesWhisper) {
    lines.push(
      `Voice input does not use whisper yet. Run: ${VOICE_SELECTION_HINT}`,
    );
  }
  return lines.join("\n");
}

function formatPrepared(args: {
  host: TargetHost;
  result: PrepareModelOutput;
  voiceUsesWhisper: boolean;
}): string {
  const { model } = args.result;
  const lines = [
    `${args.result.downloaded ? "Downloaded" : "Found"} ${model.name} (${formatMegabytes(model.sizeBytes)}) at ${model.path} on ${args.host.name}`,
    `Warm-up transcription took ${formatSeconds(args.result.warmupMs)}`,
    `Selected ${model.name} for whisper transcription`,
  ];
  if (!args.voiceUsesWhisper) {
    lines.push(`To use it for voice input, run: ${VOICE_SELECTION_HINT}`);
  }
  return lines.join("\n");
}

async function readHostId(bb: BbPluginApi): Promise<string> {
  const { primaryHostId } = await bb.sdk.system.config();
  if (primaryHostId === null) {
    throw new Error("No primary machine is connected");
  }
  return primaryHostId;
}

export default function plugin(bb: BbPluginApi): void {
  const settings = bb.settings.define({
    model: {
      type: "string",
      label: "Whisper model",
      description: `whisper.cpp model used for voice input, like base.en or small.en. Download it with bb ${CLI_NAME} prepare <model>, which also selects it.`,
      experimental_schema: whisperModelNameSchema,
      default: DEFAULT_WHISPER_MODEL,
    },
  });

  const host = bb.hosts.experimental_client({ contract: whisperHostContract });

  async function voiceSelection(): Promise<{
    voice: VoiceSelection;
    voiceUsesWhisper: boolean;
  }> {
    const { selections } = await bb.sdk.system.aiServices();
    const voice = selections.voice;
    return {
      voice,
      voiceUsesWhisper:
        voice.mode === "service" &&
        voice.pluginId === bb.pluginId &&
        voice.serviceId === WHISPER_SERVICE_ID,
    };
  }

  bb.experimental_aiServices.register({
    id: WHISPER_SERVICE_ID,
    displayName: "Local whisper.cpp",
    async transcribe(audio, { signal, hint }) {
      const [hostId, { model }] = await Promise.all([
        readHostId(bb),
        settings.get(),
      ]);
      const result = await host.call(
        "transcribe",
        {
          model,
          audioBase64: Buffer.from(await audio.arrayBuffer()).toString(
            "base64",
          ),
          mimeType: audio.type || "application/octet-stream",
          filename: audio.name || "voice-input",
          prompt: hint,
          timeoutMs: TRANSCRIBE_TIMEOUT_MS,
        },
        {
          hostId,
          signal,
          timeoutMs: TRANSCRIBE_TIMEOUT_MS + HOST_CALL_GRACE_MS,
        },
      );
      if (!result.ok) {
        throw new Error(result.message);
      }
      return result.text;
    },
    async status(): Promise<PluginAiServiceStatus> {
      const { primaryHostId } = await bb.sdk.system.config();
      if (primaryHostId === null) {
        return { ready: false, message: "No primary machine is connected" };
      }
      const [whisper, { model }] = await Promise.all([
        host.call("status", null, {
          hostId: primaryHostId,
          timeoutMs: STATUS_TIMEOUT_MS,
        }),
        settings.get(),
      ]);
      if (whisper.whisperCli === null || whisper.ffmpeg === null) {
        return {
          ready: false,
          message:
            "Install whisper.cpp and ffmpeg on the primary machine: brew install whisper.cpp ffmpeg",
        };
      }
      if (!whisper.models.some((installed) => installed.name === model)) {
        return {
          ready: false,
          message: `Download the ${model} model: bb ${CLI_NAME} prepare ${model}`,
        };
      }
      return { ready: true };
    },
  });

  async function resolveTargetHost(
    selector: string | null,
    primaryHostId: string | null,
  ): Promise<TargetHost> {
    const hosts = await bb.sdk.hosts.list();
    if (selector !== null) {
      const match = hosts.find(
        (candidate) => candidate.id === selector || candidate.name === selector,
      );
      if (match === undefined) {
        throw new CliUsageError(`No machine matches "${selector}"`);
      }
      return { id: match.id, name: match.name };
    }
    const primary = hosts.find((candidate) => candidate.id === primaryHostId);
    if (primary !== undefined) {
      return { id: primary.id, name: primary.name };
    }
    const connected = hosts.filter(
      (candidate) => candidate.status === "connected",
    );
    const only = connected[0];
    if (connected.length === 1 && only !== undefined) {
      return { id: only.id, name: only.name };
    }
    throw new CliUsageError(
      connected.length === 0
        ? "No connected machine. Start the local host daemon or pass --host"
        : `Several machines are connected; pass --host with one of: ${connected.map((candidate) => candidate.name).join(", ")}`,
    );
  }

  bb.cli.register({
    name: CLI_NAME,
    summary: "Local voice transcription with whisper.cpp",
    commands: [
      {
        name: "status",
        summary:
          "Show whisper-cli, ffmpeg, and downloaded models on the transcription host",
        usage: `bb ${CLI_NAME} status [--host <id-or-name>] [--json]`,
      },
      {
        name: "prepare",
        summary:
          "Download a whisper model onto the host and warm it up for first use",
        usage: `bb ${CLI_NAME} prepare <model> [--host <id-or-name>] [--json]`,
      },
    ],
    async run(argv, ctx) {
      const parsed = parseArgv(argv);
      if (parsed.error !== null) {
        return { exitCode: 1, stderr: `${parsed.error}\n${USAGE}` };
      }
      try {
        const config = await bb.sdk.system.config();
        const target = await resolveTargetHost(
          parsed.host,
          config.primaryHostId,
        );
        const selection = await voiceSelection();
        if (parsed.command === "status" && parsed.positionals.length === 0) {
          const [result, { model }] = await Promise.all([
            host.call("status", null, {
              hostId: target.id,
              timeoutMs: STATUS_TIMEOUT_MS,
              ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
            }),
            settings.get(),
          ]);
          return {
            exitCode: 0,
            stdout: parsed.json
              ? JSON.stringify({
                  host: target,
                  selectedModel: model,
                  voice: selection.voice,
                  ...result,
                })
              : formatStatus({
                  host: target,
                  status: result,
                  model,
                  ...selection,
                }),
          };
        }
        if (parsed.command === "prepare" && parsed.positionals.length === 1) {
          const model = whisperModelNameSchema.safeParse(parsed.positionals[0]);
          if (!model.success) {
            throw new CliUsageError(
              model.error.issues[0]?.message ?? "Invalid model name",
            );
          }
          const result = await host.call(
            "prepareModel",
            { model: model.data },
            {
              hostId: target.id,
              timeoutMs: PREPARE_TIMEOUT_MS,
              ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
            },
          );
          await settings.experimental_set({ model: result.model.name });
          return {
            exitCode: 0,
            stdout: parsed.json
              ? JSON.stringify({ host: target, voice: selection.voice, ...result })
              : formatPrepared({
                  host: target,
                  result,
                  voiceUsesWhisper: selection.voiceUsesWhisper,
                }),
          };
        }
        return { exitCode: 1, stderr: USAGE };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          exitCode: 1,
          stderr:
            error instanceof CliUsageError ? `${message}\n${USAGE}` : message,
        };
      }
    },
  });
}
