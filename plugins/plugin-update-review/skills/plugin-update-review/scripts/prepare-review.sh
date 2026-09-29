#!/usr/bin/env bash
# Usage: prepare-review.sh <plugin-id> [<old-version> <new-version>]
#
# Fetches the installed and candidate versions of one bb plugin into a scratch
# directory and writes the review inputs there. Without explicit versions it
# reads them from `bb plugin outdated --json`. Nothing here installs, builds,
# or executes plugin code: git hooks are disabled, npm pack runs with
# --ignore-scripts, and the diff runs with --no-ext-diff --no-textconv.
#
# Output directory (printed on the last line):
#   summary.txt     source, versions, commits and authors, diffstat
#   diff.patch      full diff of the plugin directory plus repo-root manifests
#   added-lines.txt every added line as <file>:<line>:<text>
#   flags.txt       added lines matching risk patterns, grouped by category
#   deps.txt        dependency and lockfile changes, npm metadata for changes

set -euo pipefail

public_registry="https://registry.npmjs.org/"

die() {
  echo "prepare-review: $*" >&2
  exit 1
}

for tool in bb git jq npm tar awk; do
  command -v "$tool" >/dev/null || die "$tool is not on PATH"
done

plugin_id="${1:-}"
[[ -n "$plugin_id" ]] || die "usage: prepare-review.sh <plugin-id> [<old> <new>]"
old_version="${2:-}"
new_version="${3:-}"

plugin_json="$(
  bb plugin list --json \
    | jq -e --arg id "$plugin_id" '.plugins[] | select(.id == $id)'
)" || die "plugin $plugin_id is not installed"
source_spec="$(jq -r '.source' <<<"$plugin_json")"
source_detail="$(bb plugin source "$plugin_id" --json)"
subdirectory="$(jq -r '.subdirectory // ""' <<<"$source_detail")"

if [[ -z "$old_version" || -z "$new_version" ]]; then
  outdated="$(
    bb plugin outdated --json \
      | jq -e --arg id "$plugin_id" '.[] | select(.id == $id)'
  )" || die "no update check result for $plugin_id"
  outcome="$(jq -r '.outcome' <<<"$outdated")"
  [[ "$outcome" == "update-available" ]] \
    || die "$plugin_id has no update available (outcome: $outcome)"
  old_version="$(jq -r '.installed.version' <<<"$outdated")"
  new_version="$(jq -r '.candidate.version' <<<"$outdated")"
fi

work_root="${TMPDIR:-/tmp}"
work_root="${work_root%/}/plugin-update-review"
out="$work_root/$plugin_id-${old_version:0:12}-${new_version:0:12}"
rm -rf "$out"
mkdir -p "$out"
repo="$out/repo"

git_safe() {
  git -c core.hooksPath=/dev/null \
    -c protocol.file.allow=never \
    -c core.fsmonitor=false \
    "$@"
}

case "$source_spec" in
  git:*)
    kind="git"
    spec="${source_spec#git:}"
    url="${spec%@*}"
    [[ "$spec" == *@* ]] || url="$spec"
    case "$url" in
      http://* | https://* | /*) ;;
      *) url="https://$url" ;;
    esac
    git_safe clone --quiet --no-checkout --filter=blob:none "$url" "$repo"
    git_safe -C "$repo" fetch --quiet --tags origin
    for rev in "$old_version" "$new_version"; do
      git_safe -C "$repo" cat-file -e "$rev^{commit}" 2>/dev/null \
        || git_safe -C "$repo" fetch --quiet origin "$rev" \
        || die "commit $rev is not in $url"
    done
    old_rev="$old_version"
    new_rev="$new_version"
    ;;
  npm:*)
    kind="npm"
    spec="${source_spec#npm:}"
    package_name="$spec"
    if [[ "${spec:1}" == *@* ]]; then
      package_name="${spec%@*}"
    fi
    registry="$(jq -r --arg d "$public_registry" '.registry // $d' <<<"$source_detail")"
    url="$registry$package_name"
    mkdir -p "$out/tarballs" "$repo"
    git_safe -C "$repo" init --quiet
    for version in "$old_version" "$new_version"; do
      tarball="$(
        npm pack "$package_name@$version" \
          --registry "$registry" \
          --pack-destination "$out/tarballs" \
          --ignore-scripts \
          --json \
          | jq -r '.[0].filename'
      )"
      find "$repo" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
      tar -xzf "$out/tarballs/$tarball" -C "$repo" --strip-components=1
      git_safe -C "$repo" add -A
      git_safe -C "$repo" \
        -c user.name=plugin-update-review \
        -c user.email=plugin-update-review@localhost \
        -c commit.gpgsign=false \
        commit --quiet --allow-empty -m "$package_name@$version"
    done
    old_rev="$(git -C "$repo" rev-parse HEAD~1)"
    new_rev="$(git -C "$repo" rev-parse HEAD)"
    subdirectory=""
    ;;
  *)
    die "$plugin_id has source $source_spec; only git: and npm: sources are reviewable"
    ;;
esac

scope=(".")
root_files=()
if [[ -n "$subdirectory" ]]; then
  scope=("$subdirectory")
  while IFS= read -r path; do
    root_files+=("$path")
  done < <(
    git -C "$repo" diff --name-only "$old_rev" "$new_rev" -- \
      ':(glob)*' ':(glob).*' ':(glob).github/**' ':(glob).bb/**'
  )
fi

diff_args=(--no-ext-diff --no-textconv --find-renames)

{
  echo "plugin:        $plugin_id"
  echo "source:        $source_spec"
  echo "kind:          $kind"
  echo "repository:    $url"
  echo "subdirectory:  ${subdirectory:-<root>}"
  echo "installed:     $old_version"
  echo "candidate:     $new_version"
  echo "scratch repo:  $repo"
  echo
  if [[ "$kind" == "git" ]]; then
    echo "== history =="
    if git -C "$repo" merge-base --is-ancestor "$old_rev" "$new_rev"; then
      echo "candidate descends from installed: yes"
    else
      echo "candidate descends from installed: NO (history was rewritten or the ref moved to another branch)"
    fi
    echo "tags at candidate: $(git -C "$repo" tag --points-at "$new_rev" | tr '\n' ' ')"
    echo
    echo "== commits touching the plugin (old..new) =="
    git -C "$repo" log --format='%h %an <%ae> %ad %s' --date=short \
      "$old_rev..$new_rev" -- "${scope[@]}" "${root_files[@]}"
    echo
    echo "== authors in this range vs. authors of the installed history =="
    comm -23 \
      <(git -C "$repo" log --format='%ae' "$old_rev..$new_rev" | sort -u) \
      <(git -C "$repo" log --format='%ae' "$old_rev" | sort -u) \
      | sed 's/^/new author: /'
    echo
    echo "== whole-repository diffstat =="
    git -C "$repo" diff "${diff_args[@]}" --shortstat "$old_rev" "$new_rev"
    echo
  fi
  echo "== reviewed-scope diffstat =="
  git -C "$repo" diff "${diff_args[@]}" --stat=200 "$old_rev" "$new_rev" -- \
    "${scope[@]}" "${root_files[@]}"
  echo
  echo "== changed lines in reviewed scope, excluding lockfiles =="
  git -C "$repo" diff "${diff_args[@]}" --numstat "$old_rev" "$new_rev" -- \
    "${scope[@]}" "${root_files[@]}" \
    ':(exclude,glob)**/package-lock.json' ':(exclude,glob)**/pnpm-lock.yaml' \
    ':(exclude,glob)**/yarn.lock' ':(exclude,glob)**/bun.lock*' \
    | awk '{ if ($1 == "-") bin++; else n += $1 + $2 } END { printf "%d lines, %d binary files\n", n, bin }'
  echo
  echo "== vendored, minified, generated, or binary paths changed =="
  git -C "$repo" diff "${diff_args[@]}" --numstat "$old_rev" "$new_rev" -- \
    "${scope[@]}" "${root_files[@]}" \
    | awk -F '\t' '
        $1 == "-" { print "binary: " $3; next }
        $3 ~ /(^|\/)(vendor|vendored|third[_-]party|dist|build|node_modules|generated)\// ||
        $3 ~ /\.(min\.(js|css|mjs)|wasm|node|map)$/ { print "path:   " $3 }
      '
} >"$out/summary.txt"

git -C "$repo" diff "${diff_args[@]}" "$old_rev" "$new_rev" -- \
  "${scope[@]}" "${root_files[@]}" >"$out/diff.patch"

awk '
  /^\+\+\+ / { file = substr($0, 7); next }
  /^@@ / {
    match($0, /\+[0-9]+/)
    line = substr($0, RSTART + 1, RLENGTH - 1)
    next
  }
  /^\+/ { printf "%s:%d:%s\n", file, line, substr($0, 2); line++; next }
  /^ / { line++ }
' "$out/diff.patch" >"$out/added-lines.txt"

flag() {
  local category="$1" pattern="$2"
  echo "== $category =="
  grep -E -i -- "$pattern" "$out/added-lines.txt" | cut -c1-300 || true
  echo
}

{
  flag "network" \
    'fetch\(|XMLHttpRequest|axios|WebSocket|EventSource|sendBeacon|undici|node-fetch|\bgot\(|\bky\b|https?://|wss?://|node:(http|https|http2|net|tls|dns|dgram)|["'"'"'](http|https|http2|net|tls|dns|dgram)["'"'"']|new Image\(|\.src ?=|srcset|url\(|<link|<script|<iframe|postMessage'
  flag "process execution" \
    'child_process|\bexec(Sync|File|FileSync)?\(|\bspawn(Sync)?\(|\bfork\(|execa|shelljs|\bcurl\b|\bwget\b|\bnc\b|osascript|powershell|\bsh -c|bash -c|Worker\('
  flag "bb data access (threads, prompts, files, terminals)" \
    'sdk\.(threads|projects|environments|hosts|files|terminals|skills|plugins|system|status)\b|storageFiles|timeline|conversationOutline|promptHistory|\boutput\(|\.search\(|events\.on\(|contributeInstructions|agents\.(configure|registerTool)|requestInput|useBbSdk|/api/v1'
  flag "filesystem, environment, secrets" \
    'node:fs|["'"'"']fs(/promises)?["'"'"']|readFile|writeFile|appendFile|readdir|createReadStream|createWriteStream|symlink|homedir|process\.env|\$HOME|~/|\.bb/|bb\.db|api-token|\.ssh|\.aws|\.npmrc|\.netrc|\.gitconfig|keychain|security find|secrets?\b|credential|password|\btoken\b|cookie|localStorage|sessionStorage|indexedDB'
  flag "obfuscation and dynamic code" \
    '\beval\(|new Function|\bFunction\(|atob\(|btoa\(|base64|fromCharCode|\\x[0-9a-f]{2}.*\\x[0-9a-f]{2}|\\u[0-9a-f]{4}.*\\u[0-9a-f]{4}|[A-Za-z0-9+/=]{160,}|[0-9a-f]{160,}|\bimport\([^"'"'"']|require\([^"'"'"']|WebAssembly|vm\.run|setTimeout\(["'"'"']'
  flag "build, install, and manifest surface" \
    '^[^:]*(package\.json|\.npmrc|\.yarnrc|tsconfig[^:]*\.json|(vite|esbuild|rollup|webpack|tailwind|postcss)\.config[^:]*|\.bb/plugins\.json|\.github/[^:]*):'
  echo "== very long added lines (over 400 characters) =="
  awk 'length($0) > 400 { split($0, p, ":"); printf "%s:%s: %d characters\n", p[1], p[2], length($0) }' \
    "$out/added-lines.txt"
} >"$out/flags.txt"

manifest_dir="${subdirectory:+$subdirectory/}"
package_at() {
  git -C "$repo" show "$1:${manifest_dir}package.json" 2>/dev/null || echo '{}'
}
lock_packages_at() {
  local rev="$1" lock
  for lock in "${manifest_dir}package-lock.json" "package-lock.json"; do
    if git -C "$repo" cat-file -e "$rev:$lock" 2>/dev/null; then
      git -C "$repo" show "$rev:$lock" \
        | jq -r '.packages // {} | to_entries[] | select(.key != "") | "\(.key)@\(.value.version // "?")"' \
        | sort -u
      return
    fi
  done
}

{
  echo "== package.json dependency changes (dependencies, optional, peer, dev, bundled) =="
  jq -n -r \
    --argjson old "$(package_at "$old_rev")" \
    --argjson new "$(package_at "$new_rev")" '
      ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies", "bundleDependencies", "bundledDependencies"]
      | .[] as $field
      | (($old[$field] // {}) | if type == "array" then map({(.): "*"}) | add // {} else . end) as $o
      | (($new[$field] // {}) | if type == "array" then map({(.): "*"}) | add // {} else . end) as $n
      | (($o + $n) | keys[]) as $name
      | select($o[$name] != $n[$name])
      | if $o[$name] == null then "added    \($field) \($name) \($n[$name])"
        elif $n[$name] == null then "removed  \($field) \($name) \($o[$name])"
        else "changed  \($field) \($name) \($o[$name]) -> \($n[$name])" end
    '
  echo
  echo "== package.json scripts, bb manifest, and engines changes =="
  jq -n -r \
    --argjson old "$(package_at "$old_rev")" \
    --argjson new "$(package_at "$new_rev")" '
      ["scripts", "bb", "engines", "main", "exports", "files", "bin"]
      | .[] as $field
      | select($old[$field] != $new[$field])
      | "\($field):\n  old: \($old[$field] | tojson)\n  new: \($new[$field] | tojson)"
    '
  echo
  echo "== lockfile packages added or re-versioned =="
  comm -13 <(lock_packages_at "$old_rev") <(lock_packages_at "$new_rev")
  echo
  echo "== registry metadata for added or changed direct dependencies =="
  jq -n -r \
    --argjson old "$(package_at "$old_rev")" \
    --argjson new "$(package_at "$new_rev")" '
      ["dependencies", "optionalDependencies", "peerDependencies"]
      | .[] as $field
      | ($new[$field] // {}) | to_entries[]
      | select(($old[$field] // {})[.key] != .value)
      | .key
    ' | sort -u | while IFS= read -r name; do
    echo "-- $name"
    npm view "$name" --json --registry "$public_registry" \
      name dist-tags.latest time.created time.modified maintainers \
      dist.unpackedSize repository.url 2>&1 | head -40 || true
  done
} >"$out/deps.txt"

echo "$out"
