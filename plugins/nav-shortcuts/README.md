# Back and forward shortcuts

`Mod+[` goes back and `Mod+]` goes forward through bb's page history, the same
history the sidebar's back and forward arrows walk. `Mod` is Command on macOS
and Control elsewhere, the Safari, Chrome, and Finder convention.

## Install

```sh
bb plugin install git:https://github.com/benwaffle/bb-plugins.git@main --plugin nav-shortcuts
```

From a local checkout:

```sh
bb plugin install path:. --plugin nav-shortcuts
```

## Commands

| Command | Title | Default |
| --- | --- | --- |
| `plugin:nav-shortcuts/back` | Go back | `Mod+[` |
| `plugin:nav-shortcuts/forward` | Go forward | `Mod+]` |

Both appear in the quick palette (`Mod+Shift+P`) and in Settings → Keyboard,
where either can be rebound or cleared. From a shell,
`bb settings keyboard set plugin:nav-shortcuts/back <shortcut>` rebinds one
and `disabled` clears it. `bb settings keyboard list` shows those overrides but
not the plugin defaults, which the app resolves.

They fire from the composer and other text fields, and not while a modal is
open. A command is unavailable, so the key passes through, when the window's
session history has no entry in that direction.

## Limits

- bb leaves a plugin's default shortcut unbound when a built-in command already
  holds the chord. On a bb that binds `Mod+[` or `Mod+]` itself, bind these
  commands in Settings → Keyboard instead.
- A plugin command cannot tell a focused terminal or embedded browser apart
  from the rest of the app, so the chords also fire there.
- The sidebar arrows do not advertise these chords through
  `aria-keyshortcuts`.
- The commands step through the browser's session history one entry at a
  time, so a page that replaced itself with the same URL takes an extra press.
