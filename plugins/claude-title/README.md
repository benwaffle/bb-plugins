# Claude Code titles

Write bb thread titles and commit messages with the Claude Code login you
already have. No bb account or bb cloud AI is involved: the plugin runs
`claude -p` on your machine with a small model.

## Install

```sh
bb plugin install git:https://github.com/benwaffle/bb-plugins.git@main --plugin claude-title
```

From a local checkout:

```sh
bb plugin install path:. --plugin claude-title
```

## Set up

1. Install Claude Code on the primary machine and log in: `claude auth login`.
2. Check it: `bb claude-title status`.

bb's Automatic choice for titles and commit messages prefers bb cloud and
otherwise takes the first ready service, so with bb cloud off or signed out
Automatic already uses this plugin. To pin it regardless, run
`bb settings ai-services set thread-title claude` (and `commit-message`), or
choose Claude Code in Settings → AI services.

## Commands

- `bb claude-title status` shows the `claude` binary, whether it is logged
  in, the model, how long the last reply took, and which service thread titles
  and commit messages use right now.
- `bb claude-title test "<first message>"` titles a sample first message the
  way a new thread would and prints the title and the time it took. `--raw`
  sends the text to the model as-is.

Both take `--json`.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| Claude model | `claude-haiku-4-5-20251001` | Model name or alias passed to `claude --model`. |
| claude path | empty | Absolute path to `claude`. Empty searches `PATH`, `~/.local/bin`, `~/.claude/local`, and the Homebrew bin directories. |
| Max title length | 48 | Characters the model is asked to keep a title under. bb cuts titles at 48 columns either way. |

## How it runs claude

bb writes the prompt (its own title or commit-message template) and calls the
service once per thread title and once per commit message, and gives up after
8 seconds. The plugin's host entry runs:

```sh
claude --print --model <model> --output-format json --tools "" \
  --strict-mcp-config --setting-sources "" --disable-slash-commands \
  --no-session-persistence --settings '{"alwaysThinkingEnabled":false}' \
  --system-prompt "<reply with only the requested text on one line>"
```

with the prompt on stdin, from a fresh empty directory under the plugin's temp
directory, with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. No tools, MCP
servers, skills, project or user settings, or CLAUDE.md files apply, and
nothing is saved as a session. Settings an administrator manages still apply.
Extended thinking is off because it adds several seconds to a one-line reply.
claude gets 6.5 seconds; a slower reply fails with a reason instead of hitting
bb's limit.

On an Apple Silicon Mac a title takes about 1.5 seconds, most of it claude
starting up, so the plugin does not warm anything up in advance.

The service is ready when `claude` is found and `claude auth status` reports a
login. The plugin reads only the `loggedIn` field of that output and caches a
logged-in result for ten minutes and a logged-out one for thirty seconds;
`bb claude-title status` always checks again.

## Develop

```sh
npm install
npm run check   # types:check, typecheck, test, build
npm run dev     # rebuild and reload against a running bb
```

`server.ts` registers the `claude` AI service and the CLI. Its `complete`
function forwards the prompt to the primary machine through the plugin's
`complete` host method (`contract.ts`); `host.ts` finds and runs `claude`
there, where the login lives. The tests drive `host.ts` against a scripted
`claude` shell script and `server.ts` against the SDK's fake host.
