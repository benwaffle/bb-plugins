Name your bb threads and write commit messages with the Claude Code login you already have. No bb account or bb cloud AI is needed.

## What you get

- A `Claude Code` AI service that bb uses for thread titles and commit messages.
- `bb claude-title status` shows whether `claude` is installed and logged in, how long the last reply took, and which service titles and commit messages use.
- `bb claude-title test "<first message>"` shows the title a new thread with that message would get, and how long it took.

## How it works

When bb needs a title or a commit message, the plugin runs `claude -p` on your primary machine with a small model (`claude-haiku-4-5-20251001` by default). claude runs from an empty directory with no tools, MCP servers, skills, project or user settings, or CLAUDE.md files, and with extended thinking off. A title takes about 1.5 seconds, well inside bb's 8-second limit.

Set it up once:

1. Install Claude Code and log in: `claude auth login`.
2. Check it: `bb claude-title status`.

With bb cloud off or signed out, the Automatic choice for titles and commit messages already uses this plugin. To pin it, run `bb settings ai-services set thread-title claude` and `bb settings ai-services set commit-message claude`, or choose Claude Code in Settings → AI services.

## Settings

- **Claude model**: the model or alias claude runs.
- **claude path**: an absolute path to `claude`, when it is not on `PATH` or in `~/.local/bin`, `~/.claude/local`, or a Homebrew bin directory.
- **Max title length**: the length the model is asked to keep titles under, up to bb's 48.
