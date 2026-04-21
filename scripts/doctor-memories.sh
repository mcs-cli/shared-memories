#!/bin/bash
# Shared memories health check for `mcs doctor`.
#
# Exit codes per the MCS shellScript doctor contract:
#   0 = pass
#   1 = fail
#   2 = warning
#   3 = skip
#
# Verifies both halves of the on-disk setup:
#   1. .claude/.memories-repo/ is a real git checkout
#   2. The configured symlink under .claude/ resolves to that checkout

set -u

project="${MCS_PROJECT_PATH:-$PWD}"
memories_link="$project/.claude/memories"
repo_dir="$project/.claude/.memories-repo"

problems=()

if [ ! -d "$repo_dir/.git" ]; then
  problems+=("git checkout missing at $repo_dir (run 'mcs sync' to re-clone)")
fi

if [ ! -L "$memories_link" ]; then
  problems+=("symlink missing at $memories_link (run 'mcs sync' to relink)")
elif ! git -C "$memories_link" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  problems+=("symlink exists but doesn't resolve to a git checkout (run 'mcs sync' to repair)")
fi

if [ ${#problems[@]} -gt 0 ]; then
  echo "Shared memories setup is unhealthy:"
  for p in "${problems[@]}"; do
    echo "  - $p"
  done
  exit 1
fi

exit 0
