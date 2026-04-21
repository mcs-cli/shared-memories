#!/bin/bash
set -euo pipefail
trap 'exit 0' ERR

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

repo_root=$(git -C "$memories_dir" rev-parse --show-toplevel 2>/dev/null) || exit 0

# Fast-forward; ignore errors (covered by the state check below).
git -C "$repo_root" pull --ff-only --quiet >/dev/null 2>&1 || true

# Detect lingering state: uncommitted files OR local ahead of upstream.
uncommitted=$(git -C "$repo_root" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
unpushed=0
if git -C "$repo_root" rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  unpushed=$(git -C "$repo_root" rev-list '@{u}..HEAD' --count 2>/dev/null || echo 0)
fi

[ "$uncommitted" -eq 0 ] && [ "$unpushed" -eq 0 ] && exit 0

parts=()
[ "$uncommitted" -gt 0 ] && parts+=("$uncommitted uncommitted file(s)")
[ "$unpushed" -gt 0 ]    && parts+=("$unpushed unpushed commit(s)")
joined=$(printf '%s, ' "${parts[@]}" | sed 's/, $//')

msg="Shared memories have lingering state: ${joined}. The previous Stop hook's auto-push didn't complete — check SSH auth (ssh-add), network, or file naming (must match memories/(learning_|decision_)*.md). The next Stop will retry automatically."

jq -n --arg ctx "$msg" \
  '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx}}'
