#!/bin/bash
set -euo pipefail
trap 'rc=$?; echo "memories_pull: aborted (rc=$rc) at line $LINENO: $BASH_COMMAND" >&2; exit 0' ERR

# SessionStart hook: fast-forward shared memories and surface any state left
# behind by a previous Stop hook's auto-push (auth failure, rebase conflict,
# guardrail refusal). This is the safety net that keeps silent push failures
# from accumulating invisibly.

command -v git >/dev/null 2>&1 || exit 0
command -v jq  >/dev/null 2>&1 || exit 0

input_data=$(cat) || exit 0
echo "$input_data" | jq '.' >/dev/null 2>&1 || exit 0

cwd=$(echo "$input_data" | jq -r '.cwd // empty')
[ -n "$cwd" ] || cwd="$(pwd)"

# Anchor on the hidden sparse checkout (the git work tree) rather than the
# .claude/memories symlink — same git root, but one less level of indirection.
memories_dir="$cwd/.claude/.memories-repo"
git -C "$memories_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

# keep in sync with hooks/memories_autopush.sh mode case
# Same resolution rules as the autopush hook, but no warning on unknown values:
# this hook emits user-visible output only via the final additionalContext JSON,
# so a stray echo here would be swallowed. The warning fires from the Stop hook.
case "${MEMORIES_AUTOPUSH_MODE:-}" in
  ""|auto) mode=auto ;;
  full)    mode=full ;;
  review)  mode=review ;;
  *)       mode=auto ;;
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

[ "$uncommitted" -eq 0 ] && [ "$unpushed" -eq 0 ] && exit 0

# Build summary without expanding an empty array (macOS Bash 3.2 + set -u).
# The early exit above guarantees at least one of these is > 0.
if [ "$uncommitted" -gt 0 ] && [ "$unpushed" -gt 0 ]; then
  joined="$uncommitted uncommitted file(s), $unpushed unpushed commit(s)"
elif [ "$uncommitted" -gt 0 ]; then
  joined="$uncommitted uncommitted file(s)"
else
  joined="$unpushed unpushed commit(s)"
fi

if [ "$mode" = "review" ]; then
  msg="Shared memories: ${joined} awaiting review (MEMORIES_AUTOPUSH_MODE=review). End a turn to see the per-file report with approve/discard commands."
else
  msg="Shared memories have lingering state: ${joined}. The previous Stop hook's auto-push didn't complete — check SSH auth (ssh-add), network, or file naming (must match memories/(learning_|decision_)*.md). The next Stop will retry automatically."
fi

jq -n --arg ctx "$msg" \
  '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx}}'
