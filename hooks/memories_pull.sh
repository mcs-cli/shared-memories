#!/bin/bash
set -euo pipefail
trap 'rc=$?; echo "memories_pull: aborted (rc=$rc) at line $LINENO: $BASH_COMMAND" >&2; exit 0' ERR

# SessionStart hook: fast-forward shared memories and surface any state left
# behind by a previous Stop hook's auto-push (auth failure, rebase conflict,
# guardrail refusal). This is the safety net that keeps silent push failures
# from accumulating invisibly.

command -v git >/dev/null 2>&1 || { echo "memories_pull: git not found; skipping" >&2; exit 0; }
command -v jq  >/dev/null 2>&1 || { echo "memories_pull: jq not found; skipping" >&2; exit 0; }

input_data=$(cat) || exit 0
echo "$input_data" | jq '.' >/dev/null 2>&1 || { echo "memories_pull: stdin is not valid JSON; skipping" >&2; exit 0; }

# Anchor on the script's own path, not stdin `cwd`. The hook ships at
# <project>/.claude/hooks/shared-memories/<script>.sh, so the project root is
# three `dirname` steps up. Script-relative anchoring keeps us cwd-agnostic
# and matches memories_autopush.sh's resolution.
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd) || exit 0
project_root=$(cd -- "$script_dir/../../.." && pwd) || exit 0

# Anchor on the hidden sparse checkout (the git work tree) rather than the
# .claude/memories symlink — same git root, but one less level of indirection.
memories_dir="$project_root/.claude/.memories-repo"
if ! git -C "$memories_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "memories_pull: $memories_dir is not a git worktree; skipping (project_root=$project_root)" >&2
  exit 0
fi

# keep in sync with hooks/memories_autopush.sh mode case
# Unknown values surface a one-time warning via additionalContext below
# (echo here would be swallowed — SessionStart hooks only speak to Claude
# through the JSON channel). Once-per-session beats every-turn noise.
mode_warning=""
case "${MEMORIES_AUTOPUSH_MODE:-}" in
  ""|auto) mode=auto ;;
  full)    mode=full ;;
  review)  mode=review ;;
  *)       mode=auto
           mode_warning="Shared memories: unknown MEMORIES_AUTOPUSH_MODE='${MEMORIES_AUTOPUSH_MODE}' — falling back to auto. Fix the value in .claude/settings.local.json (valid: auto, full, review) and restart the session." ;;
esac

# Fast-forward; ignore errors (covered by the state check below).
git -C "$memories_dir" pull --ff-only --quiet >/dev/null 2>&1 || true

# In review mode, reset the Stop hook's dedupe state once per session so any
# pending changes the user previously ignored re-surface in the new session.
# Without this reset, an unresolved review report would stay silent forever
# after its hash settled. The state file lives outside the sparse cone, so
# git ignores it and there's nothing to clean up beyond the rm.
if [ "$mode" = "review" ]; then
  # keep in sync with hooks/memories_autopush.sh review_state_file path
  rm -f "$memories_dir/.review-shown" 2>/dev/null || true
fi

# Detect lingering state: uncommitted memory files OR local ahead of upstream.
# keep in sync with hooks/memories_autopush.sh uncommitted/unpushed check
uncommitted=$(git -C "$memories_dir" status --porcelain -- memories/ 2>/dev/null | wc -l | tr -d ' ')
unpushed=0
if git -C "$memories_dir" rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  unpushed=$(git -C "$memories_dir" rev-list '@{u}..HEAD' --count 2>/dev/null || echo 0)
fi

# Build pending-state message if any. Without pending state, we still emit
# the additionalContext when there's a mode_warning to surface.
pending_msg=""
if [ "$uncommitted" -gt 0 ] || [ "$unpushed" -gt 0 ]; then
  if [ "$uncommitted" -gt 0 ] && [ "$unpushed" -gt 0 ]; then
    joined="$uncommitted uncommitted file(s), $unpushed unpushed commit(s)"
  elif [ "$uncommitted" -gt 0 ]; then
    joined="$uncommitted uncommitted file(s)"
  else
    joined="$unpushed unpushed commit(s)"
  fi
  if [ "$mode" = "review" ]; then
    pending_msg="Shared memories: ${joined} awaiting review (MEMORIES_AUTOPUSH_MODE=review). End a turn to see the per-file report with approve/discard commands."
  else
    pending_msg="Shared memories have lingering state: ${joined}. The previous Stop hook's auto-push didn't complete — check SSH auth (ssh-add), network, or file naming (must match memories/{learning,decision}_<name>.md). The next Stop will retry automatically."
  fi
fi

# Combine warning and pending into one additionalContext payload, or exit
# silently if neither is present.
if [ -n "$mode_warning" ] && [ -n "$pending_msg" ]; then
  msg="$mode_warning"$'\n\n'"$pending_msg"
elif [ -n "$mode_warning" ]; then
  msg="$mode_warning"
elif [ -n "$pending_msg" ]; then
  msg="$pending_msg"
else
  exit 0
fi

jq -n --arg ctx "$msg" \
  '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx}}'
