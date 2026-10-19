#!/usr/bin/env bash
# Runs ci-status.sh under TEST_BASH (default /bin/bash) against a fake gh on
# PATH that serves GitHub API responses from fixture files.

set -euo pipefail

test_bash="${TEST_BASH:-/bin/bash}"
script="$(cd "$(dirname "$0")/.." && pwd)/skills/plugin-update-review/scripts/ci-status.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fail() {
  echo "ci-status.test: $*" >&2
  exit 1
}

mkdir -p "$tmp/bin" "$tmp/api"
cat >"$tmp/bin/gh" <<EOF
#!/bin/sh
[ "\$1" = api ] || { echo "fake gh: unexpected arguments: \$*" >&2; exit 1; }
file="$tmp/api/\$(printf '%s' "\$2" | tr '/?&=' '____')"
[ -f "\$file" ] || { echo "fake gh: no fixture for \$2" >&2; exit 1; }
cat "\$file"
EOF
chmod +x "$tmp/bin/gh"

fixture() {
  cat >"$tmp/api/$(printf '%s' "$1" | tr '/?&=' '____')"
}

runs() {
  fixture "repos/o/r/actions/runs?head_sha=$1&per_page=100"
}

commit() {
  echo "{ \"commit\": { \"tree\": { \"sha\": \"$2\" } } }" | fixture "repos/o/r/commits/$1"
}

pulls() {
  echo "[{ \"number\": 7, \"merge_commit_sha\": \"$1\", \"head\": { \"sha\": \"$2\" } }]" \
    | fixture "repos/o/r/commits/$1/pulls"
}

run() {
  PATH="$tmp/bin:$PATH" "$test_bash" "$script" o/r "$1" 2>"$tmp/stderr"
}

green='{ "name": "CI", "status": "completed", "conclusion": "success", "html_url": "https://ci/green" }'
red='{ "name": "CI", "status": "completed", "conclusion": "failure", "html_url": "https://ci/red" }'
other='{ "name": "Dependabot Updates", "status": "completed", "conclusion": "success", "html_url": "https://ci/other" }'

# A green run on the commit itself passes.
echo "{ \"workflow_runs\": [$other, $green] }" | runs direct
out="$(run direct)" || fail "direct green run did not pass: $(cat "$tmp/stderr")"
[[ "$out" == *https://ci/green* ]] || fail "direct pass does not cite the run: $out"

# A merge with only a non-CI run passes through its PR head with the same tree.
echo "{ \"workflow_runs\": [$other] }" | runs merged
commit merged tree1
pulls merged head1
echo "{ \"workflow_runs\": [$green] }" | runs head1
commit head1 tree1
out="$(run merged)" || fail "same-tree PR head did not pass: $(cat "$tmp/stderr")"
[[ "$out" == *"PR #7 head head1"* ]] || fail "tree-match pass does not cite the PR head: $out"

# A PR head with a different tree does not count.
echo '{ "workflow_runs": [] }' | runs drifted
commit drifted tree2
pulls drifted head2
echo "{ \"workflow_runs\": [$green] }" | runs head2
commit head2 tree3
if run drifted >/dev/null; then fail "PR head with a different tree passed"; fi
grep -q 'has tree tree3' "$tmp/stderr" || fail "tree mismatch is not reported: $(cat "$tmp/stderr")"

# A commit whose own CI run failed never falls back to its PR head.
echo "{ \"workflow_runs\": [$red] }" | runs broken
commit broken tree4
pulls broken head4
echo "{ \"workflow_runs\": [$green] }" | runs head4
commit head4 tree4
if run broken >/dev/null; then fail "commit with a failed CI run passed"; fi
grep -q 'https://ci/red' "$tmp/stderr" || fail "failed run is not reported: $(cat "$tmp/stderr")"

# A failed API call exits 2, not the "no green run" exit 1.
status=0
run missing >/dev/null || status=$?
[[ "$status" == 2 ]] || fail "failed API call exited $status, expected 2"

echo "ci-status.test: ok ($("$test_bash" -c 'echo "$BASH_VERSION"'))"
