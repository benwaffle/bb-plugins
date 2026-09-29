# Plugin update review

A bb plugin that contains only an agent skill, `plugin-update-review`. The
skill makes an agent read the diff of each pending plugin update before it
applies the update. The agent checks the diff for exfiltration and other
abuse, gives each plugin an `APPLY`, `HOLD`, or `ASK` verdict, and runs
`bb plugin update <id> --yes` only for `APPLY`.

bb plugins are full-trust code. A server entry runs in the bb server with its
API token. An app entry runs in the UI with your session. Every plugin can
read all threads and reach any network destination. bb checks for plugin
updates every six hours and records the candidates. This skill is the review
step between that check and `bb plugin update`.

## Install

```sh
bb plugin install git:https://github.com/benwaffle/bb-plugins.git@main --plugin plugin-update-review
```

bb requires a server entry in every plugin manifest. This plugin's
`server.ts` registers nothing, so the plugin has no routes, tools,
instructions, schedules, or UI. bb injects the skill from `skills/` into new
agent threads.

If you prefer not to install it as a plugin, copy the skill directory into
your user skills instead:

```sh
cp -R skills/plugin-update-review ~/.bb/skills/
```

## Use

Ask an agent in any thread:

- "Review and apply plugin updates."
- "Review the aura plugin update, but don't apply it."

The agent runs `bb plugin outdated --json`. For each candidate it runs
`skills/plugin-update-review/scripts/prepare-review.sh <id>`. The script
clones the git repository into `$TMPDIR` with hooks disabled, or packs both
npm versions with `--ignore-scripts`. It writes the diff, the added lines
that match risk patterns, and the dependency changes. The agent reads the
whole diff against
[the checklist](skills/plugin-update-review/references/review-checklist.md)
and reports a verdict for each plugin in a fixed format.

The skill never applies a `HOLD`. It asks you before it applies an `ASK`,
for example when the diff is over 800 lines or when vendored or minified
code changed. Before it applies an update, it confirms that the candidate is
still the commit that it reviewed.

## Weekly review (optional)

This command creates an automation. The automation runs the review every
Monday morning in a new thread in the Personal project, applies only `APPLY`
verdicts, and leaves the report in that thread:

```sh
bb automation create \
  --project proj_personal \
  --name "Weekly plugin update review" \
  --cron "0 9 * * 1" \
  --timezone America/New_York \
  --provider claude-code \
  --model claude-opus-5-5 \
  --permission-mode auto \
  --prompt "Use the plugin-update-review skill: review every pending bb plugin update and apply only the ones with an APPLY verdict. End with the verdict for each plugin, what was applied, and what is waiting for my decision."
```
