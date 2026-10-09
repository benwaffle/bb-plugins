# Cape policy

Enforces Cape's security settings in bb for Cape employees. It keeps bb
signed out of any bb account, keeps bb cloud AI and bb connect off, and keeps
telemetry off. If one of these settings changes, the plugin changes it back and
logs the change.

## Install

```sh
bb plugin install git:https://github.com/benwaffle/bb-plugins.git@main --plugin cape-policy
```

From a local checkout:

```sh
bb plugin install path:. --plugin cape-policy
```

## What it enforces

[`policy.json`](policy.json) lists every enforced item:

| Item | Required state | How the plugin enforces it |
| --- | --- | --- |
| bb account sign-in | signed out | Calls bb-account's `signOut` RPC. This revokes the credential on getbb.app and clears it locally. |
| `bb-account` plugin | disabled | `bb.sdk.plugins.disable`. With it disabled, sign-in and the `bb account` CLI are unavailable. |
| `bb-ai` plugin | disabled | `bb.sdk.plugins.disable`. |
| `connect` plugin | disabled | `bb.sdk.plugins.disable`. |
| AI helper tasks (thread titles, commit messages, voice) | not routed to a disabled plugin | `bb.sdk.system.setAiServiceSelection` sets that task to `off`. `automatic` and other services, such as local whisper, are left alone. |
| `telemetryEnabled` | `false` | Reads the general settings, sets this one field, and writes them back with `bb.sdk.system.updateGeneralSettings`. |

The plugin applies the policy at these times:

- when it loads (a background service named `enforcer`)
- on every `system:config-changed` and `system:changed` event
- every 60 seconds, because some changes, such as enabling a plugin, may not
  emit an event

Each change the plugin makes is logged as a warning, for example:
`reverted plugin:bb-ai: enabled -> disabled (trigger: periodic check)`.

### Sign-out and a disabled bb-account

bb-account keeps its credential in its own plugin storage. Disabling the plugin
does not delete the credential, so bb signs back in when the plugin is enabled
again. The plugin handles this as follows:

- If bb-account is enabled, the plugin reads its status and signs out when
  needed. Then it disables the plugin.
- If bb-account is disabled, the plugin cannot read the stored credential. Once
  a day, it enables bb-account, confirms the sign-out (signing out if needed),
  and disables bb-account again. The time of the last confirmation is stored in
  this plugin's KV as `signOutConfirmedAt`.

## Extend the policy

Edit `policy.json`:

- Add a plugin id to `disabledPlugins` to keep that plugin disabled. AI tasks
  routed to that plugin are then also turned off.
- Add an entry to `generalSettings` to pin a general setting. The schema in
  `policy.ts` accepts only `telemetryEnabled`. Widen the schema when you add a
  key.

The schema is strict, so the plugin fails to load if `policy.json` contains
unknown fields.

## CLI

```
bb cape-policy status [--json]   # check each item; exit 1 if any item is out of policy
bb cape-policy apply [--json]    # apply the policy now and print the result
bb cape-policy explain           # what is enforced, and why
```

`status` only reads state. To read the bb-account status, it must call the
bb-account plugin, so when bb-account is disabled, `status` reports the last
confirmation.

## Settings card

Settings shows a **Cape policy** section. It lists each enforced item, its
current state, and the reason for it. It also says that these settings are
Cape policy, and it has an **Apply now** button.

## Limits

This plugin enforces the policy only while it is running. It cannot stop a
person who has access to the machine:

- **Uninstalling or disabling this plugin** removes all enforcement. bb has no
  way to lock a plugin in place.
- **Gaps between checks.** Someone can enable bb-account, sign in, and disable
  bb-account again between two checks. If no event fires, the stored
  credential is found only at the next daily check. Telemetry can stay on for
  up to 60 seconds before the plugin turns it off.
- **Before load.** The policy applies only after bb has loaded this plugin. If
  telemetry was on, bb may send events before the first check runs.
  Turning telemetry off sends one final `telemetry_disabled` event.
- bb-account and bb-ai expose some unrestricted RPC methods that a local
  process could call directly. This plugin reverts the result of such calls.
  It does not block the calls.

bb upstream has **no managed-policy, MDM, or locked-settings mechanism**. Its
settings are not read-only, and it reads no `/Library/...` policy file. Two
startup settings work outside this plugin. Deploy them with MDM alongside the
plugin:

1. **`BB_TELEMETRY=false`** in the bb server's environment. The server reads
   this at startup. When it is false, telemetry is off whatever the
   `telemetryEnabled` setting says. For the desktop app, set the variable in
   the environment that launches bb, for example with a LaunchAgent that runs
   `launchctl setenv BB_TELEMETRY false`. Restart bb afterwards.
2. **`<dataDir>/server-connect-hold.json`** (the default data dir is
   `~/.bb`), containing
   `{"version":1,"reason":"manual-import","createdAt":<epoch ms>}`. While this
   file exists, the server does not load `builtin:bb-account` or
   `builtin:connect`. If the server cannot read the file, it keeps them
   blocked. bb created this file for `bb server import`, not as a policy
   feature, and `bb server allow-connect` deletes it. Use MDM to put the file
   back if it is deleted.

Neither of these settings blocks bb cloud AI. For bb cloud AI, this plugin is
the only control.
