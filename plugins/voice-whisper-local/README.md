# Local voice (whisper.cpp)

Transcribe voice input in bb on your own machine with
[whisper.cpp](https://github.com/ggml-org/whisper.cpp). Audio never leaves the
host, and no OpenAI or Codex account is involved.

## Install

```sh
bb plugin install git:https://github.com/benwaffle/bb-plugins.git@main --plugin voice-whisper-local
```

From a local checkout:

```sh
bb plugin install path:. --plugin voice-whisper-local
```

## Set up

1. Install the tools on the host that will transcribe:
   `brew install whisper.cpp ffmpeg`.
2. Download a model: `bb whisper prepare base.en`.
3. Point voice input at it: `bb settings ai-services set voice whisper`, or
   choose Local whisper.cpp for voice in Settings → AI services.

`bb whisper prepare` also makes the model the one voice input uses; the
plugin's "Whisper model" setting holds that choice and defaults to `base.en`.
`bb whisper status` reports whether `whisper-cli` and `ffmpeg` are installed,
which models are downloaded, the selected model, and which service voice input
uses. Both commands take `--json` for
machine-readable output and `--host <id-or-name>` to target a machine other
than the primary host.

## Models

Model names follow whisper.cpp: `tiny.en`, `base.en`, `small.en`, `medium.en`,
`large-v3-turbo`, and so on. Names ending in `.en` are English-only; the others
detect the spoken language. `base.en` transcribes a ten-second clip in well
under a second on Apple Silicon. The plugin allows nine seconds per
transcription, under bb's ten-second limit, so larger models suit short
recordings only.

The first run of a freshly built whisper.cpp compiles GPU shaders, which can
take fifteen seconds or more. `bb whisper prepare` absorbs that cost so voice
input does not time out. After the machine idles or sleeps, whisper.cpp starts
cold again. The host transcribes one second of silence in the background when
its worker starts and whenever the selected model has gone unused for ten
minutes, so the next recording runs warm.

## Develop

```sh
npm install
npm run check   # typecheck, test, build
npm run dev     # rebuild and reload against a running bb
```

## How the pieces fit

`server.ts` registers the `whisper` AI service with
`bb.experimental_aiServices.register`. Its `transcribe` function reads the
selected model and sends the recording to the primary host through the
plugin's own `transcribe` host method (`contract.ts`); `host.ts` runs ffmpeg
and `whisper-cli` there. Its `status` function reports the service as not ready
until the tools and the selected model are on the primary host, which bb shows
in Settings → AI services.

The server entry imports only the bare `@get-bb/plugin-sdk` specifier. bb
aliases only that specifier when it loads a server entry and never installs a
git-sourced plugin's dependencies, so a subpath import there fails
`bb plugin install git:...`. Type-only imports are fine because `import type`
is erased before bundling.
