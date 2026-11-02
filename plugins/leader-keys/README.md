# Leader keys

Doom Emacs style leader keys for bb. Tap Space outside a text field, or press
Option+Space anywhere, then type a short sequence: `SPC f n` starts a new
thread, `SPC w l` moves to the pane on the right, `SPC t s` toggles the
sidebar. After 300 ms a which-key strip lists the keys that can come next,
and a status chip echoes what you typed so far.

## Install

```sh
bb plugin install git:https://github.com/benwaffle/bb-plugins.git@main --plugin leader-keys
```

From a local checkout:

```sh
bb plugin install path:. --plugin leader-keys
```

## Needs the bb fork for most bindings

Running a bb command (`palette.open`, `pane.focus.left`, `thread.archive`, …)
needs `experimental_useAppCommands`, which only the
[benwaffle/bb](https://github.com/benwaffle/bb) fork provides (branch
`bi/leader-keys-sdk`). The plugin checks for it at runtime.

| | Stock bb | bb fork |
| --- | --- | --- |
| Space tap and Option+Space, which-key, status chip | yes | yes |
| Cheat sheet, describe key, reload keymap, `bb leader-keys` | yes | yes |
| Bindings that run bb or plugin commands | shown as "needs fork" | yes |
| Leader from an embedded browser tab | no | yes, through bb's "Leader key" command (Option+Space, rebindable in Settings → Keyboard) |

Entries marked "needs a bb API" (unarchive, copy link, open in split, project
and tab pickers, theme and thread-list toggles) have no bb command yet and
stay dimmed on both.

## Use

- **Space** taps at body focus start the leader. Holding Space still starts
  push-to-talk: a tap shorter than 200 ms is the leader. On the fork, typing
  the next key while Space is still down also counts as a sequence.
- **Option+Space** starts the leader anywhere, including the composer and the
  terminal, unless a dialog is open.
- **Esc** cancels, **Backspace** goes up one level, **?** opens the cheat sheet.
- **Counts**: type digits before the leader (`3 SPC f j` moves three threads
  down) or after `SPC u` (`SPC u 3 f j`). Only movement commands repeat.
- **SPC h b** or **Leader keys** in the navigation opens the cheat sheet, with
  each entry's command and status. **SPC h k** describes the next sequence
  instead of running it.

The full map is on the cheat sheet; `bb leader-keys list` prints it too.

## Customize

Overrides live in `keymap.json` in the plugin's data directory
(`bb leader-keys path` prints it, usually `~/.bb/plugins/leader-keys/keymap.json`).
Edit it, then run **SPC h r** or "Leader keys: reload keymap".

```json
{
  "fallback": { "key": "Space", "alt": true },
  "whichKeyDelayMs": 300,
  "timeoutMs": 4000,
  "terminalFallback": true,
  "bindings": {
    "f R": "thread.rename",
    "x t": { "command": "plugin:taskboard/open", "label": "Taskboard" },
    "g d": null
  },
  "labels": { "x": "extra" }
}
```

- A binding maps a key path (single keys separated by spaces; `SPC` and `TAB`
  name those keys) to a bb command id, a `plugin:<id>/<command>` id, or one of
  `leader:cheat-sheet`, `leader:describe-key`, `leader:reload`,
  `leader:edit-keymap`, `leader:universal-argument`. `null` unbinds a key.
- A key cannot be both a command and a prefix; the cheat sheet lists such
  errors and the rest of the file still applies.
- `fallback: null` turns the Option+Space chord off. `whichKeyDelayMs: 0`
  never shows the strip; sequences then time out after `timeoutMs`.
- `terminalFallback: false` passes Option+Space through to the shell.

## CLI

```sh
bb leader-keys list [--json]   # every binding and keymap.json error
bb leader-keys describe f R    # what SPC f R does
bb leader-keys path            # where keymap.json lives
```
