#!/bin/bash
set -euo pipefail
# Hooks must never fail-fast onto Claude Code, but silent aborts are
# undebuggable. Log the failing line/command to stderr before exiting 0.
trap 'rc=$?; echo "memories_autopush: aborted (rc=$rc) at line $LINENO: $BASH_COMMAND" >&2; exit 0' ERR

# Stop hook: handle shared-memory file changes per MEMORIES_AUTOPUSH_MODE mode.
#
# Modes (read from .claude/settings.local.json's `env` block — mcs writes the
# value from the techpack prompt during `mcs sync`):
#
#   auto    — writes auto-pushed; deletions parked for manual review (default)
#   full    — writes AND deletions auto-pushed
#   review  — nothing auto; prints a per-turn pending-changes report
#
# In every mode, files that don't match memories/(learning_|decision_)<name>.md
# halt everything until renamed — naming policy is orthogonal to push policy.
# Unset, empty, or unknown values fall through to `auto`.
#
# After memory-audit (auto mode only) intentionally removes stale files:
#   git -C .claude/.memories-repo/memories commit -am "audit: remove stale memories" && \
#     git -C .claude/.memories-repo/memories push

command -v git >/dev/null 2>&1 || exit 0
command -v jq  >/dev/null 2>&1 || exit 0

input_data=$(cat) || exit 0
echo "$input_data" | jq '.' >/dev/null 2>&1 || exit 0

cwd=$(echo "$input_data" | jq -r '.cwd // empty')
[ -n "$cwd" ] || cwd="$(pwd)"

# Anchor on the hidden sparse checkout. Every working-tree git call below is
# scoped with `-- memories/` so root-level repo files (README etc.) can't trip
# the guardrail.
memories_dir="$cwd/.claude/.memories-repo"
git -C "$memories_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

# ── Resolve mode ─────────────────────────────────────────────────────────
# keep in sync with hooks/memories_pull.sh mode case
case "${MEMORIES_AUTOPUSH_MODE:-}" in
  ""|auto) mode=auto ;;
  full)    mode=full ;;
  review)  mode=review ;;
  # Unknown values fall through silently here — the SessionStart hook
  # (memories_pull.sh) surfaces a once-per-session warning via additionalContext.
  # Repeating it on every Stop turn was noisy and useless (the user can't fix
  # the env without restarting the session anyway).
  *)       mode=auto ;;
esac

# Sibling of the sparse cone (cone = memories/), so git neither tracks nor
# pushes this file; .claude/.memories-repo is wholesale gitignored by the
# parent project (see techpack.yaml). Only used in review mode.
review_state_file="$memories_dir/.review-shown"

# ── Fast exit if nothing to sync ─────────────────────────────────────────
# keep in sync with hooks/memories_pull.sh uncommitted/unpushed check
uncommitted=$(git -C "$memories_dir" status --porcelain -- memories/ 2>/dev/null | wc -l | tr -d ' ')
unpushed=0
if git -C "$memories_dir" rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  unpushed=$(git -C "$memories_dir" rev-list '@{u}..HEAD' --count 2>/dev/null || echo 0)
fi

if [ "$uncommitted" -eq 0 ] && [ "$unpushed" -eq 0 ]; then
  # Nothing pending — wipe stale review-mode state so the next change reprints
  # fresh instead of being suppressed by a hash whose pending set is gone.
  [ "$mode" = "review" ] && [ -f "$review_state_file" ] && rm -f "$review_state_file"
  exit 0
fi

# Default empty so the review block sees consistent vars even when the
# only pending state is an unpushed commit (no dirty files).
untracked=""
am_numstats=""
added_modified=""
deleted_files=""

if [ "$uncommitted" -gt 0 ]; then
  # ── Gather dirty file lists (shared by review and auto/full) ───────────
  # keep in sync with scripts/configure-memories.sh allowed_pattern
  allowed_pattern='^memories/(learning|decision)_[a-zA-Z0-9_-]+\.md$'

  untracked=$(git -C "$memories_dir" ls-files --others --exclude-standard --full-name -- memories/ 2>/dev/null || true)
  dirty_files=$(
    {
      git -C "$memories_dir" diff --name-only HEAD -- memories/ 2>/dev/null || true
      printf '%s\n' "$untracked"
    } | grep -v '^$' | sort -u || true
  )

  # ── Filename guardrail (blocks ALL modes) ─────────────────────────────
  bad_files=$(echo "$dirty_files" | grep -Ev "$allowed_pattern" || true)
  if [ -n "$bad_files" ]; then
    echo "Shared memories: skipping auto-push — unconventional filename(s):"
    echo "$bad_files" | sed 's/^/  - /'
    echo "Rename to memories/learning_<topic>_<specific>.md or memories/decision_<domain>_<topic>.md so the guardrail accepts them."
    exit 0
  fi

  # Single --numstat call gives us both paths and per-file stats (used by the
  # review report below). For deletions we only need names — numstat would
  # include them with `-`/`-` stats, simpler to ask for names directly.
  am_numstats=$(git -C "$memories_dir" diff --numstat --diff-filter=AM HEAD -- memories/ 2>/dev/null || true)
  added_modified=$(printf '%s\n' "$am_numstats" | awk 'NF { print $3 }')
  deleted_files=$(git -C "$memories_dir" diff --name-only --diff-filter=D HEAD -- memories/ 2>/dev/null || true)
fi

# ── Mode: review ─────────────────────────────────────────────────────────
if [ "$mode" = "review" ]; then
  # Build canonical pending-state string. Hash is over <status>\t<path> lines
  # plus an UNPUSHED marker — deliberately content-agnostic, so consecutive
  # edits with the same diff status don't trigger reprints. The report's git
  # commands let the user inspect current content on demand.
  state_lines=""
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    state_lines+="NEW	$f"$'\n'
  done <<< "$untracked"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    state_lines+="MOD	$f"$'\n'
  done <<< "$added_modified"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    state_lines+="DEL	$f"$'\n'
  done <<< "$deleted_files"
  if [ "$unpushed" -gt 0 ]; then
    # If rev-parse fails the repo is degenerate (detached, mid-rebase). Skip
    # the dedupe contribution rather than poisoning the hash with a literal —
    # otherwise two distinct broken states would collide on the same hash.
    head_sha=$(git -C "$memories_dir" rev-parse HEAD 2>/dev/null || true)
    if [ -n "$head_sha" ]; then
      state_lines+="UNPUSHED	$head_sha	$unpushed"$'\n'
    fi
  fi
  # `|| true` because grep -v returns 1 on empty input (e.g. when only pending
  # state is a renamed file: rename doesn't match AM/D filters, state_lines
  # ends up empty, grep rc=1 + set -e + ERR trap = silent exit before our
  # unclassified-pending fallback below can fire.
  state_canonical=$(printf '%s' "$state_lines" | grep -v '^$' | sort || true)

  if [ -z "$state_canonical" ]; then
    # Filters captured nothing, but the fast-exit at the top of the hook
    # confirmed at least one of uncommitted/unpushed is > 0. Possible causes:
    # rename (R), typechange (T), conflict (UU/AA), or rev-parse HEAD failed
    # (degenerate repo: detached, mid-rebase, corrupt refs). Print a minimal
    # fallback so the user never sees a silent no-op when state is pending.
    if [ "$uncommitted" -gt 0 ]; then
      echo "Shared memories [review mode]: $uncommitted unclassified pending change(s) in memories/"
      echo "  Inspect: git -C .claude/.memories-repo status -- memories/"
    fi
    if [ "$unpushed" -gt 0 ]; then
      echo "Shared memories [review mode]: $unpushed unpushed commit(s) (HEAD unresolvable — repo may be detached or mid-rebase)"
      echo "  Inspect: git -C .claude/.memories-repo status"
    fi
    exit 0
  fi

  # Dedupe: skip if the current pending set was already reported this session.
  # SessionStart hook deletes $review_state_file once per session so an
  # ignored report re-surfaces at the start of each new session.
  # Hash via whatever's available — shasum (macOS), sha256sum (Linux), openssl,
  # or git hash-object as last resort. Different algorithms produce different
  # digests, but uniqueness within a session is all dedupe needs.
  # Percent-encode the chars that most reliably break terminal autolink
  # detection in file:// URLs. Spaces are the common case (project paths like
  # "/Users/x/My Code/foo"); # and ? also break URL parsing in some terminals.
  # Other reserved chars (parens, etc.) are passed through — most terminals
  # tolerate them and percent-encoding everything reserved would mangle the
  # URL beyond what the user expects to see in the report.
  url_encode_path() {
    local p="$1"
    p=${p// /%20}
    p=${p//\#/%23}
    p=${p//\?/%3F}
    printf '%s' "$p"
  }

  hash_stdin() {
    if   command -v shasum    >/dev/null 2>&1; then shasum -a 256 | awk '{print $1}'
    elif command -v sha256sum >/dev/null 2>&1; then sha256sum     | awk '{print $1}'
    elif command -v openssl   >/dev/null 2>&1; then openssl dgst -sha256 | awk '{print $NF}'
    else git hash-object --stdin
    fi
  }
  current_hash=$(printf '%s' "$state_canonical" | hash_stdin)
  if [ -z "$current_hash" ]; then
    # All hashing tools failed somehow — print the report unconditionally
    # rather than persisting an empty hash that would suppress forever.
    echo "memories_autopush: hash tool unavailable; skipping dedupe." >&2
  elif [ -f "$review_state_file" ]; then
    last_hash=$(tr -d '[:space:]' < "$review_state_file" 2>/dev/null || true)
    if [ "$current_hash" = "$last_hash" ]; then
      exit 0
    fi
  fi

  # Header parts — files and unpushed commits are different kinds of items, so
  # describe them separately rather than collapsing into a single "items" count.
  file_count=$(printf '%s\n%s\n%s\n' "$untracked" "$added_modified" "$deleted_files" | grep -cv '^$' || true)
  # Build header without expanding an empty array — macOS Bash 3.2 + set -u
  # treats "${parts[@]}" as unbound when parts=().
  if [ "$file_count" -gt 0 ] && [ "$unpushed" -gt 0 ]; then
    desc="$file_count pending file(s) in memories/ and $unpushed unpushed commit(s)"
  elif [ "$file_count" -gt 0 ]; then
    desc="$file_count pending file(s) in memories/"
  else
    desc="$unpushed unpushed commit(s)"
  fi
  echo "Shared memories [review mode]: $desc"

  while IFS= read -r f; do
    [ -n "$f" ] || continue
    preview=$(grep -m1 -v '^[[:space:]]*$' "$memories_dir/$f" 2>/dev/null || true)
    # Strip C0 control chars (incl. ESC for ANSI, BEL, CR) and DEL, but keep
    # tab (0x09) and UTF-8 multibyte (>=0x80) so international text survives.
    # Defends the terminal against memory files containing escape sequences.
    preview=$(printf '%s' "$preview" | LC_ALL=C tr -d '\000-\010\013\014\016-\037\177')
    preview=${preview:0:80}
    echo "+ NEW  <file://$(url_encode_path "$memories_dir/$f")>"
    [ -n "$preview" ] && echo "       \"$preview\""
  done <<< "$untracked"

  # Stats batched into am_numstats above — no per-file git invocation here.
  while IFS=$'\t' read -r added deleted f; do
    [ -n "$f" ] || continue
    echo "~ MOD  <file://$(url_encode_path "$memories_dir/$f")>  (+$added -$deleted)"
    echo "       Diff: git -C .claude/.memories-repo diff -- $f"
  done <<< "$am_numstats"

  while IFS= read -r f; do
    [ -n "$f" ] || continue
    last=$(git -C "$memories_dir" log -1 --format=%cr HEAD -- "$f" 2>/dev/null || echo "?")
    echo "- DEL  $f  (last modified $last)"
    echo "       Recover: git -C .claude/.memories-repo checkout HEAD -- $f"
  done <<< "$deleted_files"

  echo ""
  if [ "$unpushed" -gt 0 ]; then
    echo "  Note: $unpushed local commit(s) not yet on the remote."
    echo "        Push: git -C .claude/.memories-repo pull --rebase --autostash && git -C .claude/.memories-repo push"
    echo ""
  fi
  echo "Approve all: git -C .claude/.memories-repo add -A -- memories/ \\"
  echo "             && git -C .claude/.memories-repo commit -m 'review: <reason>' \\"
  echo "             && git -C .claude/.memories-repo pull --rebase --autostash \\"
  echo "             && git -C .claude/.memories-repo push"
  echo "Discard local changes: git -C .claude/.memories-repo checkout -- memories/"

  if [ -n "$current_hash" ]; then
    # Atomic write so a killed hook can't leave an empty state file behind.
    printf '%s\n' "$current_hash" > "$review_state_file.tmp" \
      && mv "$review_state_file.tmp" "$review_state_file"
  fi
  exit 0
fi

# ── Modes: auto / full ───────────────────────────────────────────────────
committed=0

if [ "$uncommitted" -gt 0 ]; then
  if [ "$mode" = "auto" ]; then
    if [ -n "$deleted_files" ]; then
      del_count=$(echo "$deleted_files" | wc -l | tr -d ' ')
      echo "Shared memories: $del_count deleted memory file(s) left for manual review (not auto-pushed):"
      echo "$deleted_files" | sed 's/^/  - /'
      echo "If intentional (e.g. after memory-audit), push manually:"
      echo "  git -C .claude/.memories-repo/memories commit -am 'audit: remove stale memories' && git -C .claude/.memories-repo/memories push"
    fi

    # Stage adds/mods only — deletions stay in the working tree.
    stageable=$(
      {
        printf '%s\n' "$added_modified"
        printf '%s\n' "$untracked"
      } | grep -v '^$' | sort -u || true
    )

    if [ -n "$stageable" ]; then
      while IFS= read -r f; do
        [ -n "$f" ] || continue
        git -C "$memories_dir" add -- "$f"
      done <<< "$stageable"
    fi
  else
    git -C "$memories_dir" add -A -- memories/
  fi

  if ! git -C "$memories_dir" diff --cached --quiet -- memories/ 2>/dev/null; then
    host=$(hostname -s)
    date_str=$(date +%F)
    if [ "$mode" = "full" ] && [ -n "$deleted_files" ]; then
      msg="auto: memories from $host $date_str (includes deletions)"
    else
      msg="auto: memories from $host $date_str"
    fi
    if commit_err=$(git -C "$memories_dir" commit -m "$msg" --quiet 2>&1); then
      committed=1
    else
      echo "Shared memories: commit failed; will retry on next Stop."
      [ -n "$commit_err" ] && printf '  %s\n' "$commit_err"
      exit 0
    fi
  fi
fi

# Re-check unpushed only if we just committed — HEAD didn't move otherwise.
if [ "$committed" -eq 1 ]; then
  unpushed=0
  if git -C "$memories_dir" rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
    unpushed=$(git -C "$memories_dir" rev-list '@{u}..HEAD' --count 2>/dev/null || echo 0)
  fi
fi
[ "$unpushed" -eq 0 ] && exit 0

if ! pull_err=$(LC_ALL=C git -C "$memories_dir" pull --rebase --autostash --quiet 2>&1); then
  # Distinguish actual rebase conflicts from network/auth/etc. so the message
  # matches reality. LC_ALL=C above forces English git output so the CONFLICT
  # marker is stable — without it, French/German/Japanese locales emit
  # CONFLIT/KONFLIKT/衝突 and the grep would misclassify the failure.
  if printf '%s' "$pull_err" | grep -qi 'conflict'; then
    if ! abort_err=$(git -C "$memories_dir" rebase --abort 2>&1); then
      echo "Shared memories: rebase conflict AND --abort failed — repo may be in a half-rebased state. Resolve manually in .claude/.memories-repo/memories."
      [ -n "$abort_err" ] && printf '  %s\n' "$abort_err"
    else
      echo "Shared memories: auto-push paused — rebase conflict. Resolve manually in .claude/.memories-repo/memories."
    fi
  else
    echo "Shared memories: pull --rebase failed (likely auth or network). Will retry on next Stop."
    [ -n "$pull_err" ] && printf '  %s\n' "$pull_err"
  fi
  exit 0
fi

if ! push_err=$(git -C "$memories_dir" push --quiet 2>&1); then
  echo "Shared memories: auto-push failed. Will retry on next Stop."
  [ -n "$push_err" ] && printf '  %s\n' "$push_err"
fi
