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
3. Point voice input at it: `bb-app config set BB_TRANSCRIPTION whisper/base.en`.

`bb whisper status` reports whether `whisper-cli` and `ffmpeg` are installed
and which models are downloaded. Both commands take `--json` for
machine-readable output and `--host <id-or-name>` to target a machine other
than the primary host.

## Models

Model names follow whisper.cpp: `tiny.en`, `base.en`, `small.en`, `medium.en`,
`large-v3-turbo`, and so on. Names ending in `.en` are English-only; the others
detect the spoken language. `base.en` transcribes a ten-second clip in well
under a second on Apple Silicon. bb allows ten seconds per transcription, so
larger models suit short recordings only.

The first run of a freshly built whisper.cpp compiles GPU shaders, which can
take fifteen seconds or more. `bb whisper prepare` absorbs that cost so voice
input does not time out.

## Develop

```sh
npm install
npm run check   # typecheck, test, build
npm run dev     # rebuild and reload against a running bb
```

## Vendored AI-services contract

`ai-services-contract.ts` mirrors `experimental_aiServicesHostContract` from
`@get-bb/plugin-sdk/ai-services`. The SDK version is not usable here: bb aliases
only the bare `@get-bb/plugin-sdk` specifier at load time, so a server entry's
subpath import has to be bundled from the plugin's own SDK install, and bb never
installs a git-sourced plugin's dependencies. Importing the subpath makes
`bb plugin install git:...` fail while building the server bundle.

The types in `host.ts` still come from the SDK subpath, because `import type`
is erased before bundling.

Keep this file in step with the SDK when bb changes the `ai.inference.complete`
or `ai.voice.transcribe` schemas. `npm run types:refresh` does not touch it.
