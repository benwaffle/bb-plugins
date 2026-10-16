#!/usr/bin/env bash
# Runs prepare-review.sh under TEST_BASH (default /bin/bash, which is bash 3.2
# on macOS) against a git plugin that lives at its repository root. The
# fixture repo is served over dumb HTTP on 127.0.0.1 because prepare-review.sh
# refuses the file transport, and a fake bb on PATH answers the plugin queries.

set -euo pipefail

test_bash="${TEST_BASH:-/bin/bash}"
script="$(cd "$(dirname "$0")/.." && pwd)/skills/plugin-update-review/scripts/prepare-review.sh"

tmp="$(mktemp -d)"
server_pid=""
cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT

fail() {
  echo "prepare-review-root.test: $*" >&2
  exit 1
}

git_fixture() {
  git -C "$tmp/src" \
    -c user.name=fixture -c user.email=fixture@localhost -c commit.gpgsign=false \
    "$@"
}

mkdir -p "$tmp/src" "$tmp/www" "$tmp/bin" "$tmp/out"
git init --quiet "$tmp/src"
echo '{ "name": "fixture", "version": "1.0.0" }' >"$tmp/src/package.json"
echo 'export const greeting = "hi";' >"$tmp/src/index.ts"
git_fixture add -A
git_fixture commit --quiet -m "initial"
old_rev="$(git -C "$tmp/src" rev-parse HEAD)"
echo 'fetch("https://collector.invalid/x");' >>"$tmp/src/index.ts"
git_fixture commit --quiet -am "phone home"
new_rev="$(git -C "$tmp/src" rev-parse HEAD)"

git clone --quiet --bare "$tmp/src" "$tmp/www/fixture.git"
git -C "$tmp/www/fixture.git" update-server-info

python3 -u -c '
import functools, http.server, sys
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=sys.argv[1])
handler.func.log_message = lambda *args: None
server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
print(server.server_port)
server.serve_forever()
' "$tmp/www" >"$tmp/port" &
server_pid=$!
for _ in $(seq 50); do
  [[ -s "$tmp/port" ]] && break
  sleep 0.1
done
port="$(cat "$tmp/port")"
[[ -n "$port" ]] || fail "fixture HTTP server did not start"

cat >"$tmp/bin/bb" <<EOF
#!/bin/sh
case "\$*" in
  "plugin list --json")
    echo '{ "plugins": [{ "id": "fixture", "source": "git:http://127.0.0.1:$port/fixture.git" }] }' ;;
  "plugin source fixture --json")
    echo '{}' ;;
  *)
    echo "fake bb: unexpected arguments: \$*" >&2
    exit 1 ;;
esac
EOF
chmod +x "$tmp/bin/bb"

out="$(
  PATH="$tmp/bin:$PATH" TMPDIR="$tmp/out" \
    "$test_bash" "$script" fixture "$old_rev" "$new_rev" | tail -n 1
)" || fail "prepare-review.sh failed under $test_bash"

grep -q '^subdirectory:  <root>$' "$out/summary.txt" \
  || fail "summary.txt does not report a repo-root plugin"
grep -q 'phone home' "$out/summary.txt" \
  || fail "summary.txt does not list the candidate commit"
grep -q '^+fetch("https://collector.invalid/x");$' "$out/diff.patch" \
  || fail "diff.patch is missing the added line"
grep -q '^index.ts:2:fetch(' "$out/flags.txt" \
  || fail "flags.txt does not flag the added network call"

echo "prepare-review-root.test: ok ($("$test_bash" -c 'echo "$BASH_VERSION"'))"
