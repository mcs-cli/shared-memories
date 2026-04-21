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

# Anchor on the hidden sparse checkout. The memories repo may contain
# root-level files (README etc.) — every working-tree git call below is
# scoped with `-- memories/` so those files can't trip the guardrail.
memories_dir="$cwd/.claude/.memories-repo"
git -C "$memories_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

# ── Fast exit if nothing to sync ─────────────────────────────────────────
# keep in sync with hooks/memories_pull.sh uncommitted/unpushed check
uncommitted=$(git -C "$memories_dir" status --porcelain -- memories/ 2>/dev/null | wc -l | tr -d ' ')
unpushed=0
if git -C "$memories_dir" rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  unpushed=$(git -C "$memories_dir" rev-list '@{u}..HEAD' --count 2>/dev/null || echo 0)
fi
[ "$uncommitted" -eq 0 ] && [ "$unpushed" -eq 0 ] && exit 0

# keep in sync with scripts/configure-memories.sh allowed_pattern
allowed_pattern='^memories/(learning|decision)_[a-zA-Z0-9_-]+\.md$'
committed=0

if [ "$uncommitted" -gt 0 ]; then
  untracked=$(git -C "$memories_dir" ls-files --others --exclude-standard --full-name -- memories/ 2>/dev/null || true)
  dirty_files=$(
    {
      git -C "$memories_dir" diff --name-only HEAD -- memories/ 2>/dev/null || true
      printf '%s\n' "$untracked"
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
  deleted_files=$(git -C "$memories_dir" diff --name-only --diff-filter=D HEAD -- memories/ 2>/dev/null || true)
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
      git -C "$memories_dir" diff --name-only --diff-filter=AM HEAD -- memories/ 2>/dev/null || true
      printf '%s\n' "$untracked"
    } | grep -v '^$' | sort -u
  )

  if [ -n "$stageable" ]; then
    while IFS= read -r f; do
      [ -n "$f" ] && git -C "$memories_dir" add -- "$f"
    done <<< "$stageable"

    # Commit only if something actually ended up staged.
    if ! git -C "$memories_dir" diff --cached --quiet -- memories/ 2>/dev/null; then
      host=$(hostname -s)
      date_str=$(date +%F)
      if git -C "$memories_dir" commit -m "auto: memories from $host $date_str" --quiet; then
        committed=1
      else
        echo "Shared memories: commit failed (pre-commit hook or git config?); will retry on next Stop."
        exit 0
      fi
    fi
  fi
fi

# Re-check unpushed only if we just committed — HEAD didn't move otherwise,
# so the count from the fast-exit block above is still accurate.
if [ "$committed" -eq 1 ]; then
  unpushed=0
  if git -C "$memories_dir" rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
    unpushed=$(git -C "$memories_dir" rev-list '@{u}..HEAD' --count 2>/dev/null || echo 0)
  fi
fi
[ "$unpushed" -eq 0 ] && exit 0

if ! git -C "$memories_dir" pull --rebase --autostash --quiet 2>/dev/null; then
  git -C "$memories_dir" rebase --abort 2>/dev/null || true
  echo "Shared memories: auto-push paused — rebase conflict. Resolve manually in .claude/.memories-repo/memories."
  exit 0
fi

git -C "$memories_dir" push --quiet 2>/dev/null || echo "Shared memories: auto-push failed (auth or network). Will retry on next Stop."
