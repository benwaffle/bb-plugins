#!/usr/bin/env bash
# Usage: ci-status.sh <owner>/<repo> <sha> [<workflow-name>]
#
# Exits 0 and prints the evidence when <sha> has a green run of the CI
# workflow (default name "CI"). Runs of other workflows, such as
# "Dependabot Updates", do not count.
#
# A commit with no run of the workflow at all also passes when a pull request
# was merged as <sha>, its head commit has the same tree as <sha>, and that
# head has a green run: an identical tree means CI tested exactly the files
# of <sha>. This covers Dependabot auto-merges, because a push made with
# GITHUB_TOKEN starts no workflows. A commit whose own run failed or is still
# running never falls back to its pull request.
#
# Exits 1 with the reason on stderr when there is no green run, and 2 when a
# GitHub API call fails.

set -euo pipefail

die() {
  echo "ci-status: $*" >&2
  exit 2
}

for tool in gh jq; do
  command -v "$tool" >/dev/null || die "$tool is not on PATH"
done

repo="${1:-}"
sha="${2:-}"
workflow="${3:-CI}"
[[ "$repo" == */* && -n "$sha" ]] \
  || die "usage: ci-status.sh <owner>/<repo> <sha> [<workflow-name>]"

gh_api() {
  gh api "$1" || die "gh api $1 failed"
}

# Prints one line per run of $workflow on commit $1: <status> <conclusion> <url>.
workflow_runs() {
  gh_api "repos/$repo/actions/runs?head_sha=$1&per_page=100" \
    | jq -r --arg name "$workflow" \
      '.workflow_runs[] | select(.name == $name)
        | "\(.status) \(.conclusion // "none") \(.html_url)"'
}

green_url() {
  awk '$1 == "completed" && $2 == "success" { print $3; exit }'
}

tree_of() {
  gh_api "repos/$repo/commits/$1" | jq -r '.commit.tree.sha'
}

runs="$(workflow_runs "$sha")"
if [[ -n "$runs" ]]; then
  url="$(green_url <<<"$runs")"
  if [[ -n "$url" ]]; then
    echo "green: $workflow run on $sha: $url"
    exit 0
  fi
  echo "ci-status: $sha has no green $workflow run:" >&2
  echo "$runs" >&2
  exit 1
fi

tree="$(tree_of "$sha")"
heads="$(
  gh_api "repos/$repo/commits/$sha/pulls" \
    | jq -r --arg sha "$sha" \
      '.[] | select(.merge_commit_sha == $sha) | "\(.number) \(.head.sha)"'
)"
[[ -n "$heads" ]] || {
  echo "ci-status: $sha has no $workflow run and no pull request merged as it" >&2
  exit 1
}

while read -r number head; do
  head_tree="$(tree_of "$head")"
  if [[ "$head_tree" != "$tree" ]]; then
    echo "ci-status: PR #$number head $head has tree $head_tree, $sha has $tree" >&2
    continue
  fi
  url="$(workflow_runs "$head" | green_url)"
  if [[ -n "$url" ]]; then
    echo "green: $sha has no $workflow run; PR #$number head $head has the same tree $tree and a green run: $url"
    exit 0
  fi
  echo "ci-status: PR #$number head $head has the same tree but no green $workflow run" >&2
done <<<"$heads"
exit 1
