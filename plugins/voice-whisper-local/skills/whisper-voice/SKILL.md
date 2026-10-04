---
name: whisper-voice
description: "Set up or troubleshoot local voice transcription with whisper.cpp through the bb whisper commands."
---

# Local voice (whisper.cpp)

The plugin registers the `whisper` AI service for voice transcription. Voice
input uses it when the voice task selects it
(`bb settings ai-services set voice whisper`, or Settings → AI services).
The plugin's "Whisper model" setting picks the model, default `base.en`.
Transcription runs on the primary host with `whisper-cli` and `ffmpeg`;
nothing is sent to a cloud service.

## Commands

```
bb whisper status [--host <id-or-name>] [--json]
bb whisper prepare <model> [--host <id-or-name>] [--json]
```

`status` reports the resolved `whisper-cli` and `ffmpeg` paths, the model
directory, downloaded models, the selected model, and the service voice input
uses.

`prepare` downloads `ggml-<model>.bin` from the whisper.cpp Hugging Face
repository into the plugin's data directory on the host when it is missing,
then transcribes one second of silence so GPU shaders are compiled before the
first real recording, and selects the model for voice input. It may take several minutes for large models.

Both commands default to the primary host. Pass `--host` to target another
enrolled machine.

## Setup

1. `brew install whisper.cpp ffmpeg` on the host.
2. `bb whisper prepare base.en`
3. `bb settings ai-services set voice whisper`

## Troubleshooting

- "whisper-cli was not found": install whisper.cpp; the plugin searches `PATH`,
  `/opt/homebrew/bin`, `/usr/local/bin`, and `/home/linuxbrew/.linuxbrew/bin`.
- "is not downloaded on this host" or "Download the <model> model": run
  `bb whisper prepare <model>`; `bb whisper status` shows the selected model.
- No microphone, or whisper shows as not ready in Settings → AI services: run
  `bb whisper status` on the primary host and fix what it reports.
- "Local whisper did not finish within 9.0s": the plugin stops at nine
  seconds so its message beats bb's ten-second limit. The first recording
  after the machine has been idle or asleep can hit it while whisper.cpp
  reloads the model. The host warms the model in the background when its
  worker starts and when the model has gone unused for ten minutes, so retry
  after a few seconds. If every recording times out, use a smaller model such
  as `base.en`, or run `bb whisper prepare` again after upgrading whisper.cpp
  so shader compilation happens outside a recording.
