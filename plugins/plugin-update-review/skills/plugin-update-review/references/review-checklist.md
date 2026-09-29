# Review checklist

For each category, compare the candidate with the installed version. A
behavior that was already in the installed version is not new. But if the
update changes what data goes into that behavior, the change is new.

## Network destinations

Look for:

- `fetch`, `XMLHttpRequest`, `axios`, `got`, `ky`, `undici`, `node-fetch`
- `WebSocket`, `EventSource`, `navigator.sendBeacon`, `postMessage` to other
  windows
- `node:http`, `node:https`, `node:http2`, `node:net`, `node:tls`,
  `node:dns`, `node:dgram`
- `child_process` that runs `curl`, `wget`, `nc`, `ssh`, `git` with a remote,
  or `osascript`
- URL literals, and URLs that are built from settings, storage, or remote
  responses

For each destination, record the host, what is sent, and what triggers the
request. The server entry has the bb API token and every thread, so the
server entry must not send data to a new host unless the release is clearly
about that host. DNS lookups and image loads can also carry data: a
hostname, a query string, or a pixel URL can hold thread text.

## bb data access

In the server entry, `bb.sdk` is the full bb API:

- `threads.list`, `get`, `search`, `timeline`, `output`,
  `conversationOutline`, `promptHistory`, `storageFiles`
- `projects.files` and `projects.fileContent`
- `environments.diff*`
- `files.read` and `files.list`
- `terminals.output`
- `skills.getContent`
- `plugins.getSettings`
- `system.config`

Hooks can also see prompts and events:

- `bb.events.on(...)`, especially `experimental_thread.events`,
  `thread.idle` (`lastAssistantText`), `message.queued`, and
  `experimental_terminal.input`
- `bb.agents.contributeInstructions`, `bb.agents.configure`, and
  `bb.agents.registerTool`, which add text to every thread's prompt

In the app entry, the SDK hooks and direct `/api/v1/...` requests have the
user's session.

A read is expected when the plugin's feature needs it, for example a thread
namer that reads a thread's first message. Flag a read when the feature does
not need it, or when the data that the read returns goes to the network,
storage, or a place that other plugins or processes can read. A new tool or
instructions text that tells agents to send data, run commands, or change
settings is a prompt-injection finding.

## Filesystem, environment, and secrets

A plugin should use only `bb.storage`, `bb.settings`, `bb.secrets`, and its
own data directory. Flag access to any of these:

- `~/.bb`, `bb.db`, `api-token`, and other plugins' directories or secrets
- `~/.ssh`, `~/.aws`, `~/.npmrc`, `~/.netrc`, `~/.gitconfig`, `~/.config`,
  and keychain commands (`security find-*-password`)
- the whole of `process.env`, or enumeration of it, as opposed to one named
  variable that the feature documents
- browser storage in the app entry: `localStorage`, `sessionStorage`,
  `indexedDB`, and `document.cookie` for keys that do not belong to the plugin
- writes outside the plugin's storage, symlinks, and changes to shell
  profiles, launch agents, or git hooks

A host entry runs on the user's machine with full Node access. Review a new
or changed host entry at the level of a native binary.

## Obfuscation and dynamic code

Flag these:

- `eval`, `new Function`, `Function(...)`, string `setTimeout`, and `vm`
- `import()` or `require()` with a computed specifier
- `WebAssembly`
- long base64 or hex strings, `atob` or `Buffer.from(..., "base64")` that
  decode to code or URLs, `String.fromCharCode` chains, and escaped-string
  blobs
- minified or bundled code in the source tree, vendored copies of libraries,
  and generated files

The plugin's build minifies it at install time, so the source has no reason
to hold minified code. If the diff changes a vendored or minified file, do
not try to read it. The verdict is `ASK`. The user can then compare it with
the upstream release that it claims to be.

## Dependencies

Check every added or changed entry in `dependencies`, `optionalDependencies`,
and `peerDependencies`, and every new package in the lockfile. Git installs
omit dev dependencies, but the build can still load a dev dependency through
a build config, so read the build config changes too. For each direct
dependency, use `npm view <name> --registry https://registry.npmjs.org/` to
check these points:

- The package exists for a real purpose that the diff uses.
- `time.created` is not a few days before the release.
- The maintainers did not change recently.
- The `repository.url` matches the package.
- `dist.unpackedSize` is reasonable.

Also flag a dependency that is pinned to a git URL, a tarball URL, or a
`file:` path. bb installs with `--ignore-scripts`, so install scripts do not
run. But the dependency's code is bundled into the server, app, or host
entry and runs there.

## Build configuration and manifest

In `package.json`, look for changes to:

- `bb.server`, `bb.app`, `bb.host`, `bb.skills`, and `bb.themes`
- `engines`
- `main`, `exports`, `files`, and `bin`
- `scripts`

Also look at build config files (`vite`, `esbuild`, `tailwind`, `postcss`,
`tsconfig`), `.npmrc` and `.yarnrc` (bb deletes them for git installs, but
note them), repository-root workspace files, and `.bb/plugins.json`.

A new `bb.host` entry or a new `bb.app` entry is a large expansion of what
the plugin can do. Treat it as at least `ASK`. A new skill file adds
instructions to every thread, so read it as prompt text.

## What the UI entry fetches or loads

The app entry runs in the bb window. Flag these:

- new remote images, fonts, stylesheets, scripts, iframes, or `url(...)` in
  CSS
- `<link rel=preconnect>` or `prefetch`
- Content-Security-Policy changes on routes that the plugin serves
- new cache headers that store user data longer

A remote asset tells its host when and where bb is open. A URL that is built
from thread or user data sends that data.
