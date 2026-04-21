#!/bin/bash
set -euo pipefail
trap 'exit 0' ERR

# Stop hook: auto-commit and push shared memories.
#
# Two guardrails protect the team KB:
#   1. Filename pattern — only memories/(learning_|decision_)<name>.md get auto-pushed.
#      A stray "wip.md" or "notes.md" never silently propagates, and the hook
#      refuses everything until the offending name is fixed.
#   2. Deletion gate — deletions are NEVER auto-pushed. The hook still auto-pushes
#      any coexisting additions/modifications (so memory-audit + a new memory in
#      the same session don't block each other), but the deleted files stay in
#      the working tree for manual review. This prevents a local `rm` from
#      silently wiping team knowledge.
#
# After memory-audit (from mcs-cli/memory) intentionally removes stale files:
#   git -C .claude/.memories-repo/memories commit -am "audit: remove stale memories" && \
#     git -C .claude/.memories-repo/memories push

command -v git >/dev/null 2>&1 || exit 0
command -v jq  >/dev/null 2>&1 || exit 0

input_data=$(cat) || exit 0
echo "$input_data" | jq '.' >/dev/null 2>&1 || exit 0

cwd=$(echo "$input_data" | jq -r '.cwd // empty')
[ -n "$cwd" ] || cwd="$(pwd)"

# Anchor on the hidden sparse checkout (the git work tree).
memories_dir="$cwd/.claude/.memories-repo"
git -C "$memories_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

repo_root=$(git -C "$memories_dir" rev-parse --show-toplevel 2>/dev/null) || exit 0

# ── Fast exit if nothing to sync ─────────────────────────────────────────
uncommitted=$(git -C "$repo_root" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
unpushed=0
if git -C "$repo_root" rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  unpushed=$(git -C "$repo_root" rev-list '@{u}..HEAD' --count 2>/dev/null || echo 0)
fi
[ "$uncommitted" -eq 0 ] && [ "$unpushed" -eq 0 ] && exit 0

allowed_pattern='^memories/(learning|decision)_[a-zA-Z0-9_-]+\.md$'

if [ "$uncommitted" -gt 0 ]; then
  dirty_files=$(
    {
      git -C "$repo_root" diff --name-only HEAD 2>/dev/null || true
      git -C "$repo_root" ls-files --others --exclude-standard --full-name 2>/dev/null || true
    } | grep -v '^$' | sort -u
  )

  # ── Guardrail 1: reject unconventional filenames (blocks everything) ──
  bad_files=$(echo "$dirty_files" | grep -Ev "$allowed_pattern" || true)
  if [ -n "$bad_files" ]; then
    echo "Shared memories: skipping auto-push — unconventional filename(s):"
    echo "$bad_files" | sed 's/^/  - /'
    echo "Rename to memories/learning_<topic>_<specific>.md or memories/decision_<domain>_<topic>.md so the guardrail accepts them."
    exit 0
  fi

  # ── Guardrail 2: never auto-commit deletions — but don't block add/mods ──
  deleted_files=$(git -C "$repo_root" diff --name-only --diff-filter=D HEAD 2>/dev/null || true)
  if [ -n "$deleted_files" ]; then
    del_count=$(echo "$deleted_files" | wc -l | tr -d ' ')
    echo "Shared memories: $del_count deleted memory file(s) left for manual review (not auto-pushed):"
    echo "$deleted_files" | sed 's/^/  - /'
    echo "If intentional (e.g. after memory-audit), push manually:"
    echo "  git -C .claude/.memories-repo/memories commit -am 'audit: remove stale memories' && git -C .claude/.memories-repo/memories push"
  fi

  # Stage only additions/modifications (tracked AM + untracked). Deletions are
  # left in the working tree for the user to review and commit manually.
  stageable=$(
    {
      git -C "$repo_root" diff --name-only --diff-filter=AM HEAD 2>/dev/null || true
      git -C "$repo_root" ls-files --others --exclude-standard --full-name 2>/dev/null || true
    } | grep -v '^$' | sort -u
  )

  if [ -n "$stageable" ]; then
    while IFS= read -r f; do
      [ -n "$f" ] && git -C "$repo_root" add -- "$f"
    done <<< "$stageable"

    # Commit only if something actually ended up staged.
    if ! git -C "$repo_root" diff --cached --quiet 2>/dev/null; then
      host=$(hostname -s 2>/dev/null || hostname)
      date_str=$(date +%F)
      git -C "$repo_root" commit -m "auto: memories from $host $date_str" --quiet || exit 0
    fi
  fi
fi

# ── Rebase + push (re-check unpushed since we may have just committed) ──
unpushed=0
if git -C "$repo_root" rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  unpushed=$(git -C "$repo_root" rev-list '@{u}..HEAD' --count 2>/dev/null || echo 0)
fi
[ "$unpushed" -eq 0 ] && exit 0

if ! git -C "$repo_root" pull --rebase --autostash --quiet 2>/dev/null; then
  git -C "$repo_root" rebase --abort 2>/dev/null || true
  echo "Shared memories: auto-push paused — rebase conflict. Resolve manually in .claude/.memories-repo/memories."
  exit 0
fi

git -C "$repo_root" push --quiet 2>/dev/null || echo "Shared memories: auto-push failed (auth or network). Will retry on next Stop."
