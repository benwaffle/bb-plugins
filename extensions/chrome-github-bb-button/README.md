# bb for GitHub (Chrome and Firefox extension)

Adds a **bb** button to the header of every GitHub pull request. Clicking it
opens the bb thread the pull request came from in the bb desktop app.

## How it finds the thread

1. Reads the pull request's head branch from the page.
2. Branches that bb created end in the thread id, such as
   `bb/fix-login-thr_ekk8rv4cd5`. When the head branch names a thread that
   still exists, that thread is the answer.
3. Otherwise it lists bb threads and keeps the ones whose environment is
   checked out on that branch. When threads from several repositories share
   the branch name, it prefers environments whose directory name matches the
   GitHub repository.
4. It also searches bb for the pull request URL. Threads that quoted the URL
   rank first; any such thread that is not on the branch is added to the list
   as well.

One match opens directly. Several matches show a menu. No match shows a note
naming the branch it looked for.

## Opening

Selecting a thread calls the same route as `bb thread open --focus`. When the
desktop app is connected it switches to that thread and brings its window to
the front. Otherwise the extension opens the thread in a browser tab through
the bb session link.

## Install

One `manifest.json` loads in both browsers. Chrome runs `background.js` as a
service worker; Firefox ignores `service_worker` and runs the same file from
`background.scripts`.

### Chrome

1. Open `chrome://extensions`, enable Developer mode, choose Load unpacked, and
   pick this directory.
2. Open the extension options and set the server URL and API token. The desktop
   app records the server URL in `~/.bb/bb-app-runtime.json`; the token is the
   contents of `~/.bb/api-token`.
3. Open any pull request on github.com.

### Firefox (140 or later)

1. Open `about:debugging`, choose This Firefox, choose Load Temporary
   Add-on, and pick `manifest.json` in this directory.
2. Open `about:addons`, select bb for GitHub, and open its Preferences tab. Set
   the server URL and API token as for Chrome, then choose Save and test.
3. Allow the site access prompt (see below).
4. Open any pull request on github.com.

A temporary add-on is removed when Firefox quits. For a persistent install,
sign an unlisted build through addons.mozilla.org, for example with
`npx web-ext sign --channel unlisted --api-key … --api-secret …` and an AMO API
key. Then install the signed `.xpi` from `about:addons` > Install Add-on From
File.

### Site access in Firefox

Firefox treats Manifest V3 host permissions and content script matches as
optional. It can install the extension without access to `127.0.0.1`,
`localhost`, or `github.com`. When access is missing, the button does not
appear on GitHub, or it reports that the extension cannot reach bb.

Save and test in the options page asks for all three origins. Allow the prompt
once. You can also grant access in `about:addons` > bb for GitHub >
Permissions. Chrome grants these permissions at install, so it does not show
a prompt.

## Server requirement

The extension authenticates with the API token as a bearer header. The bb
server skips its browser origin check for bearer-authenticated requests, which
is what lets a `chrome-extension://` or `moz-extension://` origin call
`/api/v1`.
