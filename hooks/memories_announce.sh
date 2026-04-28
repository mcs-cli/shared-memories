#!/bin/bash
set -euo pipefail
trap 'exit 0' ERR

# PostToolUse hook: surface review-mode memory writes to Claude's conversation.
#
# In review mode the Stop hook's pending-changes report goes to the terminal
# only (async hookAsync: true means stdout never re-enters Claude's context —
# see .claude/memories/learning_hook_output_channels.md). This hook fills that
# gap by injecting additionalContext after a memory file write, so Claude can
# proactively mention pending review to the user.
#
# Silent in auto/full modes — those auto-push and don't need a Claude-visible
# nudge.

command -v jq >/dev/null 2>&1 || exit 0

input_data=$(cat) || exit 0
file_path=$(echo "$input_data" | jq -r '.tool_input.file_path // empty' 2>/dev/null) || exit 0

# hookMatcher in techpack.yaml scopes us to Write/Edit/MultiEdit, but those
# tools touch many paths; restrict to the memory-file naming convention the
# autopush guardrail would accept (memories_autopush.sh allowed_pattern).
case "$file_path" in
  */.claude/memories/learning_*.md|*/.claude/memories/decision_*.md) ;;
  *) exit 0 ;;
esac

# Review mode only — auto/full/unset/unknown all auto-push and need no nudge.
case "${MEMORIES_AUTOPUSH_MODE:-}" in
  review) ;;
  *)      exit 0 ;;
esac

msg="Memory file saved at $file_path (MEMORIES_AUTOPUSH_MODE=review). This memory will not auto-push. Mention the pending memory to the user before ending your turn so they can decide whether to approve or discard."

jq -n --arg ctx "$msg" \
  '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $ctx}}'
