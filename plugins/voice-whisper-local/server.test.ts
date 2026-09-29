import {
  createFakePluginHost,
  makeHostResponse,
} from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "./server.js";

type FakePluginHostOptions = NonNullable<
  Parameters<typeof createFakePluginHost>[0]
>;
type HostRpcResponder = NonNullable<
  FakePluginHostOptions["experimental_callHostRpc"]
>;
type VoiceSelection =
  | { mode: "automatic" }
  | { mode: "off" }
  | { mode: "service"; pluginId: string; serviceId: string };

const PLUGIN_ID = "voice-whisper-local";
const WHISPER_SELECTED: VoiceSelection = {
  mode: "service",
  pluginId: PLUGIN_ID,
  serviceId: "whisper",
};

const STATUS = {
  whisperCli: "/opt/homebrew/bin/whisper-cli",
  ffmpeg: "/opt/homebrew/bin/ffmpeg",
  modelDir: "/data/models",
  models: [
    {
      name: "base.en",
      path: "/data/models/ggml-base.en.bin",
      sizeBytes: 148 * 1024 * 1024,
    },
  ],
};

const PRIMARY = makeHostResponse({
  id: "host-primary",
  name: "studio",
  status: "connected",
});

function createHost(args: {
  voice?: VoiceSelection;
  primaryHostId?: string | null;
  hosts?: ReturnType<typeof makeHostResponse>[];
  settings?: Record<string, string>;
  respond: HostRpcResponder;
}) {
  const voice = args.voice ?? { mode: "automatic" };
  return createFakePluginHost({
    pluginId: PLUGIN_ID,
    ...(args.settings === undefined ? {} : { settings: args.settings }),
    sdk: {
      hosts: { list: async () => args.hosts ?? [PRIMARY] },
      system: {
        config: async () =>
          ({
            primaryHostId:
              args.primaryHostId === undefined
                ? PRIMARY.id
                : args.primaryHostId,
          }) as never,
        aiServices: async () =>
          ({
            selections: {
              "thread-title": { mode: "automatic" },
              "commit-message": { mode: "automatic" },
              voice,
            },
            services: [],
          }) as never,
      },
    },
    experimental_callHostRpc: args.respond,
  });
}

function registeredService(host: ReturnType<typeof createHost>) {
  const [service] = host.harness.registrations.aiServiceRegistrations;
  if (service === undefined) throw new Error("no AI service registered");
  return service;
}

function recording(): File {
  return new File([Buffer.from("fake-webm-bytes")], "voice-input.webm", {
    type: "audio/webm",
  });
}

describe("whisper AI service", () => {
  it("registers a transcribe-only whisper service", async () => {
    const host = createHost({ respond: () => STATUS });
    await plugin(host.bb);

    const service = registeredService(host);
    expect(service).toMatchObject({
      id: "whisper",
      displayName: "Local whisper.cpp",
    });
    expect(service.transcribe).toBeTypeOf("function");
    expect(service.complete).toBeUndefined();
  });

  it("transcribes on the primary host with the selected model and the hint as prompt", async () => {
    const host = createHost({
      settings: { model: "small.en" },
      respond: () => ({ ok: true, text: "Add a unit test." }),
    });
    await plugin(host.bb);

    const text = await registeredService(host).transcribe?.(recording(), {
      signal: new AbortController().signal,
      hint: "bb, useEffect",
    });

    expect(text).toBe("Add a unit test.");
    expect(host.harness.experimental_hostRpcCalls).toMatchObject([
      {
        method: "transcribe",
        hostId: "host-primary",
        input: {
          model: "small.en",
          audioBase64: Buffer.from("fake-webm-bytes").toString("base64"),
          mimeType: "audio/webm",
          filename: "voice-input.webm",
          prompt: "bb, useEffect",
          timeoutMs: 10_000,
        },
      },
    ]);
  });

  it("uses base.en when no model is configured", async () => {
    const host = createHost({ respond: () => ({ ok: true, text: "" }) });
    await plugin(host.bb);

    await registeredService(host).transcribe?.(recording(), {
      signal: new AbortController().signal,
      hint: null,
    });

    expect(host.harness.experimental_hostRpcCalls).toMatchObject([
      { input: { model: "base.en", prompt: null } },
    ]);
  });

  it("rejects with the host's failure message", async () => {
    const host = createHost({
      respond: () => ({
        ok: false,
        code: "request_failed",
        message: 'Whisper model "base.en" is not downloaded on this host.',
      }),
    });
    await plugin(host.bb);

    await expect(
      registeredService(host).transcribe?.(recording(), {
        signal: new AbortController().signal,
        hint: null,
      }),
    ).rejects.toThrow('Whisper model "base.en" is not downloaded');
  });

  it("reports ready only when the tools and the selected model are on the primary host", async () => {
    const ready = createHost({ respond: () => STATUS });
    await plugin(ready.bb);
    await expect(registeredService(ready).status?.()).resolves.toEqual({
      ready: true,
    });

    const missingModel = createHost({
      settings: { model: "small.en" },
      respond: () => STATUS,
    });
    await plugin(missingModel.bb);
    await expect(registeredService(missingModel).status?.()).resolves.toEqual({
      ready: false,
      message: "Download the small.en model: bb whisper prepare small.en",
    });

    const missingTools = createHost({
      respond: () => ({ ...STATUS, whisperCli: null }),
    });
    await plugin(missingTools.bb);
    await expect(
      registeredService(missingTools).status?.(),
    ).resolves.toMatchObject({ ready: false, message: /brew install/ });

    const noPrimary = createHost({
      primaryHostId: null,
      respond: () => STATUS,
    });
    await plugin(noPrimary.bb);
    await expect(registeredService(noPrimary).status?.()).resolves.toEqual({
      ready: false,
      message: "No primary machine is connected",
    });
    expect(noPrimary.harness.experimental_hostRpcCalls).toEqual([]);
  });
});

describe("whisper CLI", () => {
  it("shows status for the primary host and how to switch voice input to whisper", async () => {
    const host = createHost({
      hosts: [
        makeHostResponse({
          id: "host-other",
          name: "laptop",
          status: "connected",
        }),
        PRIMARY,
      ],
      respond: ({ method }) => {
        expect(method).toBe("status");
        return STATUS;
      },
    });
    await plugin(host.bb);

    const result = await host.harness.runCli(["status"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Host: studio (host-primary)");
    expect(result.stdout).toContain("base.en (148 MB)");
    expect(result.stdout).toContain("Selected model: base.en");
    expect(result.stdout).toContain("Voice input service: automatic");
    expect(result.stdout).toContain(
      "bb settings ai-services set voice whisper",
    );
    expect(host.harness.experimental_hostRpcCalls).toMatchObject([
      { method: "status", hostId: "host-primary" },
    ]);
  });

  it("omits the switch hint once voice input uses whisper and flags an undownloaded model", async () => {
    const host = createHost({
      voice: WHISPER_SELECTED,
      settings: { model: "small.en" },
      respond: () => STATUS,
    });
    await plugin(host.bb);

    const result = await host.harness.runCli(["status"]);

    expect(result.stdout).toContain(
      "The selected model is not downloaded. Run: bb whisper prepare small.en",
    );
    expect(result.stdout).not.toContain("bb settings ai-services set");
  });

  it("targets an explicit --host by name and emits JSON", async () => {
    const host = createHost({
      voice: WHISPER_SELECTED,
      hosts: [
        makeHostResponse({
          id: "host-other",
          name: "laptop",
          status: "connected",
        }),
        PRIMARY,
      ],
      respond: () => STATUS,
    });
    await plugin(host.bb);

    const result = await host.harness.runCli([
      "status",
      "--host",
      "laptop",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout ?? "")).toMatchObject({
      host: { id: "host-other", name: "laptop" },
      selectedModel: "base.en",
      voice: WHISPER_SELECTED,
      models: [{ name: "base.en" }],
    });
  });

  it("downloads a model with a long-running host call and selects it", async () => {
    const host = createHost({
      respond: ({ method, input }) => {
        if (method === "status") return STATUS;
        expect(method).toBe("prepareModel");
        expect(input).toEqual({ model: "small.en" });
        return {
          model: {
            name: "small.en",
            path: "/data/models/ggml-small.en.bin",
            sizeBytes: 488 * 1024 * 1024,
          },
          downloaded: true,
          warmupMs: 17_800,
        };
      },
    });
    await plugin(host.bb);

    const result = await host.harness.runCli(["prepare", "small.en"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Downloaded small.en (488 MB)");
    expect(result.stdout).toContain("17.8s");
    expect(result.stdout).toContain(
      "Selected small.en for whisper transcription",
    );
    expect(result.stdout).toContain(
      "bb settings ai-services set voice whisper",
    );
    expect(host.harness.experimental_hostRpcCalls).toMatchObject([
      { method: "prepareModel", hostId: "host-primary" },
    ]);

    const status = await host.harness.runCli(["status", "--json"]);
    expect(JSON.parse(status.stdout ?? "")).toMatchObject({
      selectedModel: "small.en",
    });
  });

  it("rejects bad model names, unknown hosts, and unknown flags without calling the host", async () => {
    const host = createHost({ respond: () => STATUS });
    await plugin(host.bb);

    const badModel = await host.harness.runCli(["prepare", "../etc/passwd"]);
    expect(badModel.exitCode).toBe(1);
    expect(badModel.stderr).toContain("Model names use");

    const badHost = await host.harness.runCli(["status", "--host", "nope"]);
    expect(badHost.exitCode).toBe(1);
    expect(badHost.stderr).toContain('No machine matches "nope"');

    const badFlag = await host.harness.runCli(["status", "--verbose"]);
    expect(badFlag.exitCode).toBe(1);
    expect(badFlag.stderr).toContain("Unknown flag --verbose");

    expect(host.harness.experimental_hostRpcCalls).toEqual([]);
  });

  it("asks for --host when no primary host is known and several machines are connected", async () => {
    const host = createHost({
      primaryHostId: null,
      hosts: [
        makeHostResponse({ id: "a", name: "alpha", status: "connected" }),
        makeHostResponse({ id: "b", name: "beta", status: "connected" }),
      ],
      respond: () => STATUS,
    });
    await plugin(host.bb);

    const result = await host.harness.runCli(["status"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("alpha, beta");
  });
});
