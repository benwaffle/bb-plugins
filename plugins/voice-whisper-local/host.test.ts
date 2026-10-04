import { EventEmitter } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWhisperHostEntry, type SpawnedProcess } from "./host.js";

interface SpawnCall {
  readonly command: string;
  readonly args: readonly string[];
}

type CommandScript = (
  call: SpawnCall,
  child: FakeChild,
) => void | Promise<void>;

class FakeChild extends EventEmitter implements SpawnedProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killedWith: NodeJS.Signals | null = null;

  kill(signal: NodeJS.Signals): boolean {
    this.killedWith = signal;
    this.finish(null);
    return true;
  }

  finish(code: number | null): void {
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code);
  }

  succeed(stdout = ""): void {
    this.stdout.write(stdout);
    this.finish(0);
  }

  fail(code: number, stderr: string): void {
    this.stderr.write(stderr);
    this.finish(code);
  }
}

function isWarmUpCall(call: SpawnCall): boolean {
  return call.args.some(
    (arg) => arg.startsWith("anullsrc=") || arg.endsWith("silence.wav"),
  );
}

const succeedWarmUp: CommandScript = async (call, child) => {
  if (basename(call.command) === "ffmpeg") {
    await writeFile(call.args[call.args.length - 1] ?? "", "RIFF");
  }
  child.succeed();
};

/**
 * Background warm-up runs go to `warmUpScript` and `warmUpCalls`, so `calls`
 * holds only the commands a handler ran for its own request.
 */
function createSpawn(
  script: CommandScript,
  warmUpScript: CommandScript = succeedWarmUp,
) {
  const calls: SpawnCall[] = [];
  const warmUpCalls: SpawnCall[] = [];
  const spawn = (command: string, args: readonly string[]): SpawnedProcess => {
    const child = new FakeChild();
    const call = { command, args: [...args] };
    const warmUp = isWarmUpCall(call);
    (warmUp ? warmUpCalls : calls).push(call);
    queueMicrotask(() => {
      void (warmUp ? warmUpScript : script)(call, child);
    });
    return child;
  };
  return { calls, warmUpCalls, spawn };
}

function basename(command: string): string {
  return path.basename(command);
}

const TRANSCRIBE_INPUT = {
  model: "base.en",
  audioBase64: Buffer.from("fake-webm-bytes").toString("base64"),
  mimeType: "audio/webm",
  filename: "voice-input.webm",
  prompt: "bb, useEffect",
  timeoutMs: 5_000,
};

describe("whisper host entry", () => {
  let root: string;
  let binDir: string;
  let dataDir: string;
  let tempDir: string;
  let env: NodeJS.ProcessEnv;
  let clockMs: number;

  async function installTool(name: string): Promise<string> {
    const filePath = path.join(binDir, name);
    await writeFile(filePath, "#!/bin/sh\nexit 0\n");
    await chmod(filePath, 0o755);
    return filePath;
  }

  async function installModel(name: string, bytes = 16): Promise<string> {
    const modelDir = path.join(dataDir, "models");
    await mkdir(modelDir, { recursive: true });
    const filePath = path.join(modelDir, `ggml-${name}.bin`);
    await writeFile(filePath, Buffer.alloc(bytes, 1));
    return filePath;
  }

  function harnessFor(
    spawn: (command: string, args: readonly string[]) => SpawnedProcess,
    fetch: (
      url: string,
      init: { signal: AbortSignal },
    ) => Promise<Response> = () => Promise.reject(new Error("no network")),
  ) {
    return experimental_createHostEntryHarness(
      createWhisperHostEntry({
        env,
        fallbackBinDirs: [],
        spawn,
        fetch,
        now: () => clockMs,
      }),
      { experimental_paths: { dataDir, tempDir } },
    );
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "whisper-host-test-"));
    binDir = path.join(root, "bin");
    dataDir = path.join(root, "data");
    tempDir = path.join(root, "tmp");
    await mkdir(binDir, { recursive: true });
    env = { PATH: binDir };
    clockMs = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("converts the recording with ffmpeg and returns whisper-cli's text", async () => {
    const ffmpeg = await installTool("ffmpeg");
    const whisperCli = await installTool("whisper-cli");
    const modelPath = await installModel("base.en");
    const { calls, spawn } = createSpawn(async (call, child) => {
      if (basename(call.command) === "ffmpeg") {
        const wavPath = call.args[call.args.length - 1];
        if (wavPath === undefined) throw new Error("missing wav path");
        await writeFile(wavPath, "RIFF");
        child.succeed();
        return;
      }
      child.stderr.write("load_backend: loaded MTL backend\n");
      child.succeed("\n Add a unit test.\n And clean up  the recorder.\n");
    });
    const harness = harnessFor(spawn);

    const result = await harness.experimental_call(
      "transcribe",
      TRANSCRIBE_INPUT,
    );

    expect(result).toEqual({
      ok: true,
      text: "Add a unit test. And clean up the recorder.",
    });
    expect(calls.map((call) => call.command)).toEqual([ffmpeg, whisperCli]);
    const [ffmpegCall, whisperCall] = calls;
    expect(ffmpegCall?.args).toEqual(
      expect.arrayContaining(["-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le"]),
    );
    expect(ffmpegCall?.args[ffmpegCall.args.indexOf("-i") + 1]).toMatch(
      /input\.webm$/,
    );
    expect(whisperCall?.args).toEqual([
      "-m",
      modelPath,
      "-f",
      expect.stringMatching(/whisper-16k\.wav$/),
      "--no-timestamps",
      "--no-prints",
      "--prompt",
      "bb, useEffect",
    ]);
    await harness.experimental_dispose();
    await expect(readdir(tempDir)).resolves.toEqual([]);
  });

  it("converts a .wav upload into a separate file instead of overwriting the input", async () => {
    await installTool("ffmpeg");
    await installTool("whisper-cli");
    await installModel("base.en");
    const { calls, spawn } = createSpawn(async (call, child) => {
      if (basename(call.command) === "ffmpeg") {
        const inputPath = call.args[call.args.indexOf("-i") + 1];
        const wavPath = call.args[call.args.length - 1];
        if (inputPath === wavPath) {
          child.fail(234, `Output ${wavPath} same as Input #0 - exiting`);
          return;
        }
        await writeFile(wavPath ?? "", "RIFF");
        child.succeed();
        return;
      }
      child.succeed(" Hello.\n");
    });
    const harness = harnessFor(spawn);

    await expect(
      harness.experimental_call("transcribe", {
        ...TRANSCRIBE_INPUT,
        mimeType: "audio/wav",
        filename: "voice-input.wav",
      }),
    ).resolves.toEqual({ ok: true, text: "Hello." });
    const [ffmpegCall, whisperCall] = calls;
    const wavPath = ffmpegCall?.args[ffmpegCall.args.length - 1];
    expect(ffmpegCall?.args[ffmpegCall.args.indexOf("-i") + 1]).toMatch(
      /input\.wav$/,
    );
    expect(wavPath).toMatch(/whisper-16k\.wav$/);
    expect(whisperCall?.args[whisperCall.args.indexOf("-f") + 1]).toBe(wavPath);
    await harness.experimental_dispose();
  });

  it("auto-detects the language for multilingual models and omits empty prompts", async () => {
    await installTool("ffmpeg");
    await installTool("whisper-cli");
    await installModel("small");
    const { calls, spawn } = createSpawn(async (call, child) => {
      if (basename(call.command) === "ffmpeg") {
        await writeFile(call.args[call.args.length - 1] ?? "", "RIFF");
      }
      child.succeed(" Hola.\n");
    });
    const harness = harnessFor(spawn);

    await expect(
      harness.experimental_call("transcribe", {
        ...TRANSCRIBE_INPUT,
        model: "small",
        prompt: null,
      }),
    ).resolves.toEqual({ ok: true, text: "Hola." });
    const whisperArgs = calls[1]?.args ?? [];
    expect(whisperArgs).toEqual(expect.arrayContaining(["--language", "auto"]));
    expect(whisperArgs).not.toContain("--prompt");
    await harness.experimental_dispose();
  });

  it("explains how to download a missing model without running anything", async () => {
    await installTool("ffmpeg");
    await installTool("whisper-cli");
    const { calls, spawn } = createSpawn((_call, child) => child.succeed());
    const harness = harnessFor(spawn);

    const result = await harness.experimental_call(
      "transcribe",
      TRANSCRIBE_INPUT,
    );

    expect(result).toMatchObject({
      ok: false,
      code: "request_failed",
      message: expect.stringContaining("bb whisper prepare base.en"),
    });
    expect(calls).toEqual([]);
    await harness.experimental_dispose();
  });

  it("reports missing whisper.cpp with an install hint", async () => {
    await installTool("ffmpeg");
    await installModel("base.en");
    const { spawn } = createSpawn((_call, child) => child.succeed());
    const harness = harnessFor(spawn);

    await expect(
      harness.experimental_call("transcribe", TRANSCRIBE_INPUT),
    ).resolves.toMatchObject({
      ok: false,
      code: "request_failed",
      message: expect.stringContaining("brew install whisper.cpp"),
    });
    await harness.experimental_dispose();
  });

  it("reports a cancelled request instead of a tool failure when the caller aborts", async () => {
    await installTool("ffmpeg");
    await installTool("whisper-cli");
    await installModel("base.en");
    const controller = new AbortController();
    const { spawn } = createSpawn(async (call, child) => {
      if (basename(call.command) === "ffmpeg") {
        await writeFile(call.args[call.args.length - 1] ?? "", "RIFF");
        child.succeed();
        return;
      }
      controller.abort();
    });
    const harness = harnessFor(spawn);

    await expect(
      harness.experimental_call("transcribe", TRANSCRIBE_INPUT, {
        signal: controller.signal,
      }),
    ).resolves.toEqual({
      ok: false,
      code: "request_failed",
      message: "Transcription was cancelled",
    });
    await harness.experimental_dispose();
  });

  it("kills a hung whisper-cli at the deadline and reports a timeout", async () => {
    await installTool("ffmpeg");
    await installTool("whisper-cli");
    await installModel("base.en");
    const hung: { child: FakeChild | null } = { child: null };
    const { spawn } = createSpawn(async (call, child) => {
      if (basename(call.command) === "ffmpeg") {
        await writeFile(call.args[call.args.length - 1] ?? "", "RIFF");
        child.succeed();
        return;
      }
      hung.child = child;
    });
    const harness = harnessFor(spawn);

    const result = await harness.experimental_call("transcribe", {
      ...TRANSCRIBE_INPUT,
      timeoutMs: 60,
    });

    expect(result).toMatchObject({ ok: false, code: "timeout" });
    expect(hung.child?.killedWith).toBe("SIGKILL");
    await harness.experimental_dispose();
    await expect(readdir(tempDir)).resolves.toEqual([]);
  });

  it("surfaces ffmpeg failures with the tail of its stderr", async () => {
    await installTool("ffmpeg");
    await installTool("whisper-cli");
    await installModel("base.en");
    const { spawn } = createSpawn((_call, child) =>
      child.fail(1, "Invalid data found when processing input"),
    );
    const harness = harnessFor(spawn);

    await expect(
      harness.experimental_call("transcribe", TRANSCRIBE_INPUT),
    ).resolves.toEqual({
      ok: false,
      code: "request_failed",
      message: "ffmpeg exited with 1: Invalid data found when processing input",
    });
    await harness.experimental_dispose();
  });

  it("lists resolved tools and downloaded models in status", async () => {
    const whisperCli = await installTool("whisper-cli");
    const basePath = await installModel("base.en", 32);
    const smallPath = await installModel("small.en", 64);
    await writeFile(path.join(dataDir, "models", "notes.txt"), "ignored");
    const { spawn } = createSpawn((_call, child) => child.succeed());
    const harness = harnessFor(spawn);

    await expect(harness.experimental_call("status", { warmUpModel: null })).resolves.toEqual({
      whisperCli,
      ffmpeg: null,
      modelDir: path.join(dataDir, "models"),
      models: [
        { name: "base.en", path: basePath, sizeBytes: 32 },
        { name: "small.en", path: smallPath, sizeBytes: 64 },
      ],
    });
    await harness.experimental_dispose();
  });

  it("treats an empty model file as missing", async () => {
    await installTool("ffmpeg");
    await installTool("whisper-cli");
    await installModel("base.en", 0);
    const { calls, spawn } = createSpawn(async (call, child) => {
      if (basename(call.command) === "ffmpeg") {
        await writeFile(call.args[call.args.length - 1] ?? "", "RIFF");
      }
      child.succeed();
    });
    const fetch = vi.fn(async () => new Response(Buffer.alloc(8, 3)));
    const harness = harnessFor(spawn, fetch);

    await expect(
      harness.experimental_call("transcribe", TRANSCRIBE_INPUT),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining("bb whisper prepare base.en"),
    });
    expect(calls).toEqual([]);

    const prepared = await harness.experimental_call("prepareModel", {
      model: "base.en",
    });
    expect(prepared.downloaded).toBe(true);
    expect(prepared.model.sizeBytes).toBe(8);
    expect(fetch).toHaveBeenCalledOnce();
    await harness.experimental_dispose();
  });

  it("downloads a missing model once and warms it up", async () => {
    await installTool("ffmpeg");
    await installTool("whisper-cli");
    const { calls, warmUpCalls, spawn } = createSpawn((_call, child) =>
      child.succeed(),
    );
    const fetch = vi.fn(async (url: string) => {
      expect(url).toBe(
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin",
      );
      return new Response(Buffer.alloc(24, 7));
    });
    const harness = harnessFor(spawn, fetch);

    const first = await harness.experimental_call("prepareModel", {
      model: "tiny.en",
    });
    expect(first).toEqual({
      model: {
        name: "tiny.en",
        path: path.join(dataDir, "models", "ggml-tiny.en.bin"),
        sizeBytes: 24,
      },
      downloaded: true,
      warmupMs: expect.any(Number),
    });
    expect(calls).toEqual([]);
    expect(warmUpCalls.map((call) => basename(call.command))).toEqual([
      "ffmpeg",
      "whisper-cli",
    ]);
    expect(warmUpCalls[0]?.args).toEqual(
      expect.arrayContaining(["-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono"]),
    );

    const second = await harness.experimental_call("prepareModel", {
      model: "tiny.en",
    });
    expect(second.downloaded).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
    await expect(readdir(path.join(dataDir, "models"))).resolves.toEqual([
      "ggml-tiny.en.bin",
    ]);
    await harness.experimental_dispose();
  });

  it("fails a download on an HTTP error and leaves no partial file", async () => {
    await installTool("ffmpeg");
    await installTool("whisper-cli");
    const { spawn } = createSpawn((_call, child) => child.succeed());
    const harness = harnessFor(
      spawn,
      async () => new Response("not found", { status: 404 }),
    );

    await expect(
      harness.experimental_call("prepareModel", { model: "nope" }),
    ).rejects.toThrow(/HTTP 404/);
    await expect(readdir(path.join(dataDir, "models"))).resolves.toEqual([]);
    await harness.experimental_dispose();
  });
  describe("background warm-up", () => {
    const TEN_MINUTES_MS = 10 * 60_000;

    async function installEverything(): Promise<void> {
      await installTool("ffmpeg");
      await installTool("whisper-cli");
      await installModel("base.en");
    }

    function transcribeScript(text: string): CommandScript {
      return async (call, child) => {
        if (basename(call.command) === "ffmpeg") {
          await writeFile(call.args[call.args.length - 1] ?? "", "RIFF");
          child.succeed();
          return;
        }
        child.succeed(text);
      };
    }

    async function warmUpFinished(
      harness: ReturnType<typeof harnessFor>,
    ): Promise<void> {
      await vi.waitFor(() =>
        expect(harness.experimental_getRetainedWorkerLeaseCount()).toBe(0),
      );
    }

    it("warms the requested model on a status call and holds the worker while it runs", async () => {
      await installEverything();
      let releaseWarmUp = (): void => {};
      const { calls, warmUpCalls, spawn } = createSpawn(
        (_call, child) => child.succeed(),
        async (call, child) => {
          if (basename(call.command) === "ffmpeg") {
            await succeedWarmUp(call, child);
            return;
          }
          releaseWarmUp = () => child.succeed();
        },
      );
      const harness = harnessFor(spawn);

      await harness.experimental_call("status", { warmUpModel: "base.en" });

      await vi.waitFor(() => expect(warmUpCalls).toHaveLength(2));
      expect(warmUpCalls[1]?.args).toEqual(
        expect.arrayContaining([path.join(dataDir, "models", "ggml-base.en.bin")]),
      );
      expect(harness.experimental_getRetainedWorkerLeaseCount()).toBe(1);
      releaseWarmUp();
      await warmUpFinished(harness);
      expect(calls).toEqual([]);
      await harness.experimental_dispose();
      await expect(readdir(tempDir)).resolves.toEqual([]);
    });

    it("re-warms only after the model has sat unused for more than ten minutes", async () => {
      await installEverything();
      const { warmUpCalls, spawn } = createSpawn(transcribeScript(" Hi.\n"));
      const harness = harnessFor(spawn);

      await harness.experimental_call("status", { warmUpModel: "base.en" });
      await warmUpFinished(harness);
      expect(warmUpCalls).toHaveLength(2);

      clockMs += TEN_MINUTES_MS;
      await harness.experimental_call("status", { warmUpModel: "base.en" });
      await expect(
        harness.experimental_call("transcribe", TRANSCRIBE_INPUT),
      ).resolves.toEqual({ ok: true, text: "Hi." });
      await warmUpFinished(harness);
      expect(warmUpCalls).toHaveLength(2);

      clockMs += TEN_MINUTES_MS + 1;
      await harness.experimental_call("status", { warmUpModel: "base.en" });
      await warmUpFinished(harness);
      expect(warmUpCalls).toHaveLength(4);
      await harness.experimental_dispose();
    });

    it("answers a transcription without waiting for the warm-up that status started", async () => {
      await installEverything();
      const { calls, warmUpCalls, spawn } = createSpawn(
        transcribeScript(" Ship it.\n"),
        async (call, child) => {
          if (basename(call.command) === "ffmpeg") {
            await succeedWarmUp(call, child);
          }
        },
      );
      const harness = harnessFor(spawn);

      await harness.experimental_call("status", { warmUpModel: "base.en" });
      await expect(
        harness.experimental_call("transcribe", TRANSCRIBE_INPUT),
      ).resolves.toEqual({ ok: true, text: "Ship it." });
      await harness.experimental_call("status", { warmUpModel: "base.en" });

      expect(calls.map((call) => basename(call.command))).toEqual([
        "ffmpeg",
        "whisper-cli",
      ]);
      await vi.waitFor(() => expect(warmUpCalls).toHaveLength(2));
      expect(harness.experimental_getRetainedWorkerLeaseCount()).toBe(1);
      await harness.experimental_dispose();
      expect(harness.experimental_getRetainedWorkerLeaseCount()).toBe(0);
      await expect(readdir(tempDir)).resolves.toEqual([]);
    });

    it("warms a newly selected model while another model's warm-up is still running", async () => {
      await installEverything();
      await installModel("small.en");
      const { warmUpCalls, spawn } = createSpawn(
        (_call, child) => child.succeed(),
        async (call, child) => {
          if (basename(call.command) === "ffmpeg") {
            await succeedWarmUp(call, child);
          }
        },
      );
      const harness = harnessFor(spawn);

      await harness.experimental_call("status", { warmUpModel: "base.en" });
      await harness.experimental_call("status", { warmUpModel: "small.en" });

      await vi.waitFor(() => expect(warmUpCalls).toHaveLength(4));
      const modelArgs = warmUpCalls
        .filter((call) => basename(call.command) === "whisper-cli")
        .map((call) => path.basename(call.args[1] ?? ""));
      expect(modelArgs.sort()).toEqual([
        "ggml-base.en.bin",
        "ggml-small.en.bin",
      ]);
      expect(harness.experimental_getRetainedWorkerLeaseCount()).toBe(2);
      await harness.experimental_dispose();
    });

    it("skips the warm-up when no model is named or the model or tools are missing", async () => {
      await installTool("ffmpeg");
      await installModel("base.en");
      const { warmUpCalls, spawn } = createSpawn((_call, child) =>
        child.succeed(),
      );
      const harness = harnessFor(spawn);

      await harness.experimental_call("status", { warmUpModel: null });
      await harness.experimental_call("status", { warmUpModel: "base.en" });
      await warmUpFinished(harness);
      await installTool("whisper-cli");
      await harness.experimental_call("status", { warmUpModel: "small.en" });
      await warmUpFinished(harness);

      expect(warmUpCalls).toEqual([]);
      await harness.experimental_dispose();
    });
  });
});
