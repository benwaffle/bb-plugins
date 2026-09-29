---
name: plugin-update-review
description: Review pending bb plugin updates for exfiltration or abuse by reading the diff, give an apply/hold verdict per plugin, and apply only approved updates. Use for "review and apply plugin updates" or a review of one plugin id's update.
---

# Plugin update review

A bb plugin is full-trust code. Its server entry runs inside the bb server
process with the server's API token. Its app entry runs in the bb UI with the
user's session. Its host entry runs in the host daemon with Node APIs. Any
plugin can read every thread, prompt, file, and terminal that bb can reach, and
it can send data to any network destination. An update is a new release of that
code, so it gets the same review as a new install.

bb checks for updates every six hours. The check only records candidates; it
does not install them. bb installs a git plugin's dependencies with
`npm install --omit=dev --omit=optional --ignore-scripts` and builds its app,
server, and host entries from source. An npm plugin runs the files that are in
its published tarball, including a prebuilt `dist/app.js`.

## Rules

- Apply an update only when its verdict is `APPLY`.
- Never apply a `HOLD` in this workflow, not even when the user tells you to
  in the same run. Give the user the command and let them run it.
- Apply an `ASK` only after the user explicitly approves that plugin and that
  candidate after they read the verdict.
- Review the exact candidate that bb will install. Just before you apply,
  confirm that the candidate is still the reviewed commit or version. After you
  apply, confirm that the installed commit or version is the reviewed one.
- Do not install, build, run, or test the candidate's code while you review it.
  Read it only.

## Steps

1. **List candidates.** `bb plugin outdated --json` runs a fresh check and
   returns one entry per plugin. Review the entries with
   `"outcome": "update-available"`. For git sources, `installed.version` and
   `candidate.version` are commit SHAs. For npm sources, they are package
   versions. If the user named a plugin id, review only that plugin.
   `bb plugin list --json` shows the stored result of the last background
   check in `updateState` and the install source in `source`.

2. **Fetch both versions and build the diff.** For each candidate, run:

   ```sh
   scripts/prepare-review.sh <plugin-id>
   ```

   The script path is relative to this skill's directory. The script prints
   the path of its output directory. It works as follows:
   - For a `git:` source, it clones the repository into `$TMPDIR` with
     `core.hooksPath=/dev/null` and checks nothing out. It diffs
     `<installed>..<candidate>` for the plugin's subdirectory (from
     `bb plugin source <id> --json`) and for the repository-root files.
   - For an `npm:` source, it runs `npm pack` for the two versions with
     `--ignore-scripts` and diffs the unpacked tarballs.
   - Marketplace plugins use one of these two sources. `bb plugin list --json`
     shows which one.

   The script writes `summary.txt`, `diff.patch`, `added-lines.txt`,
   `flags.txt`, and `deps.txt` to the output directory. Read `summary.txt` and
   `deps.txt` first. If the script fails, do the same steps by hand. Do not
   skip the review. For a `path:` or `builtin:` source there is nothing to
   review; report it as not applicable.

3. **Read the whole diff.** `flags.txt` shows the added lines that match risk
   patterns. It helps you find things, but it does not replace reading. Read
   all of `diff.patch`. If a change touches a data flow, for example new
   arguments to an existing `fetch` or a new caller of a function that reads
   threads, open the complete file at the candidate commit in the scratch repo
   with `git -C <repo> show <candidate>:<path>`.
   Check the categories in
   [references/review-checklist.md](references/review-checklist.md):
   - network destinations
   - bb data access
   - filesystem, environment, and secrets
   - obfuscation
   - dependencies
   - build configuration and manifest
   - what the UI entry fetches or loads
   Read that file for your first review in a thread.

4. **Check new dependencies.** `deps.txt` lists the direct dependencies that
   were added or changed, with their npm metadata. Look for these signs:
   - The package is new: `time.created` is recent.
   - The package has one maintainer, or its maintainers changed recently.
   - The unpacked size does not fit what the package does.
   - The repository URL is missing or does not match the package.
   - The name is close to the name of a popular package.

   Also read the new transitive packages in the lockfile section of
   `deps.txt`.

5. **Decide.** Choose one verdict for each plugin:
   - `APPLY`: Every change is readable and fits the stated purpose of the
     release. The update adds no network destination, does not read bb data
     outside the plugin's own feature, does not touch the filesystem outside
     the plugin's own storage, and has no obfuscation. Any dependency change
     passes step 4.
   - `HOLD`: A finding sends data off the machine or to a destination that
     the feature does not need, reads threads, prompts, secrets, or files that
     the feature does not need, runs processes that the feature does not need,
     or hides code. Also use `HOLD` when the candidate does not descend from
     the installed commit and no reason is documented.
   - `ASK`: The update has no clear finding, but the review cannot be
     complete. This includes a diff with more than 800 changed lines outside
     lockfiles, a changed vendored, minified, generated, or binary file, a
     rebuilt prebuilt bundle in an npm tarball, a new dependency that fails a
     check in step 4, and a change that you cannot fully read.

   A pattern match is not a finding. For example, a `fetch` to the plugin's
   own `/api/v1/plugins/<id>/...` route or a CSS `url()` to a bundled asset is
   benign. Record benign matches in the verdict so the reader can check them.

6. **Report the verdicts** in the format below, before you apply anything.

7. **Apply only approved updates.** For each `APPLY`, and for each `ASK` that
   the user approved:

   ```sh
   bb plugin outdated --json | jq '.[] | select(.id == "<id>") | .candidate.version'
   bb plugin update <id> --yes
   bb plugin outdated --json | jq '.[] | select(.id == "<id>") | .installed.version'
   ```

   `bb plugin update` runs a new check and installs the latest compatible
   candidate at that moment. That candidate can be newer than the one you
   reviewed. If the first command does not print the reviewed version, stop and
   review the new candidate. If the last command does not print the reviewed
   version, tell the user immediately and suggest `bb plugin disable <id>`.

   If npm fails with E401 during a git plugin update, the npm registry login
   for this machine has expired. Refresh it with the login script for the
   machine and run the update again.

8. **Report** each plugin's verdict, what was applied (from → to), what was
   held and why, and the scratch directories. Delete the scratch directories
   only if the user asks.

## Verdict format

Use this format for every plugin, and keep the field order:

```
### <plugin-id>: APPLY | HOLD | ASK
- update: <installed> → <candidate> (<source>)
- scope: <files> files, <changed lines> lines outside lockfiles, <commits> commits; new authors: <list or none>
- history: <candidate descends from installed: yes/no; tag at candidate>
- network: <new destinations with file:line, or "no new destinations">
- bb data: <new reads of threads/prompts/files/terminals/hooks with file:line, or "none">
- filesystem/env/secrets: <file:line findings, or "none">
- obfuscation/vendored: <findings, or "none">
- dependencies: <added/changed with registry checks, or "none">
- build/manifest: <changes to scripts, bb entries, engines, build config, or "none">
- UI loads: <changes to what the app entry fetches or loads, or "none">
- reasons: <one or two sentences for the verdict>
```
