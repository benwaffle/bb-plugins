#!/usr/bin/env bash
# Builds each plugin the way `bb plugin install git:...` does: a copy outside
# the workspace (so imports cannot resolve from the root node_modules), only
# the plugin's own production dependencies, then `bb plugin build`.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
bb="$root/node_modules/.bin/bb"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

for dir in "$root"/plugins/*/; do
  name="$(basename "$dir")"
  echo "::group::$name"
  rsync -a --exclude node_modules --exclude dist "$dir" "$work/$name/"
  npm install \
    --prefix "$work/$name" \
    --ignore-scripts \
    --omit=dev \
    --omit=optional \
    --no-audit \
    --no-fund
  (cd "$work/$name" && env -u BB_CLI "$bb" plugin build .)
  echo "::endgroup::"
done
