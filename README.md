# bb-plugins

Third-party [bb](https://getbb.app) plugins and browser extensions I maintain
outside the bb fork, so they install like any other third-party plugin and do
not add commits that have to be carried through every upstream sync.

## Plugins

| Plugin | Directory | What it does |
| --- | --- | --- |
| `cape-policy` | [plugins/cape-policy](plugins/cape-policy) | Enforces Cape security settings: bb account signed out, bb cloud AI and connect off, telemetry off. |
| `plugin-update-review` | [plugins/plugin-update-review](plugins/plugin-update-review) | Agent skill that reviews each plugin update's diff for exfiltration or abuse before applying it. |
| `pr-review` | [plugins/pr-review](plugins/pr-review) | Review queue for open PRs, agent review threads in PR worktrees, and PR/ticket refs per thread. |
| `project-emoji` | [plugins/project-emoji](plugins/project-emoji) | An emoji before each project name in the sidebar, picked automatically or chosen by hand. |
| `voice-whisper-local` | [plugins/voice-whisper-local](plugins/voice-whisper-local) | Transcribe voice input locally with whisper.cpp. |

Install one at a time, naming the entry from `.bb/plugins.json`:

```sh
bb plugin install git:https://github.com/benwaffle/bb-plugins.git@main --plugin voice-whisper-local
```

`--subdirectory plugins/voice-whisper-local` does the same thing without
consulting the collection manifest. Inside a clone,
`bb plugin install path:. --plugin voice-whisper-local` installs from the working tree.

## Extensions

| Extension | Directory | What it does |
| --- | --- | --- |
| `chrome-github-bb-button` | [extensions/chrome-github-bb-button](extensions/chrome-github-bb-button) | Adds a bb button to GitHub pull requests. |

Browser extensions are not bb plugins; each one has its own README with load
instructions.

## Layout

```
.bb/plugins.json        collection manifest bb reads for `--plugin <name>`
plugins/<name>/         one bb plugin per directory, its own package.json
extensions/<name>/      one browser extension per directory
```

The repository is an npm workspace so that one `npm install` at the root sets
every plugin up. Each plugin pins `@get-bb/plugin-sdk` to the exact version
bundled in the `bb-app` release the repository builds against, which
`bb plugin types --check` enforces.

## Develop

```sh
npm install
npm run check      # every plugin: types:check, typecheck, test, build
npm run build      # every plugin: bb plugin build
npm run check:isolated  # every plugin built as `bb plugin install git:...` does
```

`bb plugin install git:...` runs `npm install --omit=dev` in the plugin's own
directory, so `@get-bb/plugin-sdk` (a devDependency) is absent when bb bundles
the frontend. Code reachable from the `bb.app` entry may use
`@get-bb/plugin-sdk/app` but not the bare `@get-bb/plugin-sdk`, so `app.tsx`
imports `contract.ts` type-only and takes shared runtime constants from
`channel.ts`. The workspace install hides a mistake here;
`npm run check:isolated` catches it.

Plugin scripts shell out to the `bb` CLI from the `bb-app` devDependency, and
run it as `env -u BB_CLI bb` so an installed bb desktop app does not take over
the build.

Bumping bb: raise `bb-app` at the root, then run `npm run types:refresh` in
each plugin to repin its SDK devDependency, and `npm install`.
