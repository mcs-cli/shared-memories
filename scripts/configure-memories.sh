#!/bin/bash
set -euo pipefail

# Runs during `mcs sync` after components install. Idempotent and self-healing:
# handles first-time setup, missing symlinks, broken symlinks pointing at a
# still-live checkout, AND migration from an existing non-symlink memories
# directory (e.g. memories an engineer already captured via mcs-cli/memory or
# Claude Code's native memory feature before adopting this pack).
#
# Layout on disk:
#   .claude/.memories-repo/            ← hidden sparse clone of the memories branch
#     memories/
#       learning_*.md / decision_*.md
#   .claude/memories                   ← symlink → .memories-repo/memories
#
# The checkout uses single-branch partial-blobless sparse-checkout so only the
# memory markdowns materialize on disk — pack plumbing stays in git history but
# never hits the working tree.

memories_link="$MCS_PROJECT_PATH/.claude/memories"
repo_dir="$MCS_PROJECT_PATH/.claude/.memories-repo"
repo_url="${MCS_RESOLVED_MEMORIES_REPO_URL:-}"
branch="${MCS_RESOLVED_MEMORIES_BRANCH:-main}"
migration_backup=""

if [ -z "$repo_url" ]; then
  echo "MEMORIES_REPO_URL not resolved; skipping memories clone." >&2
  exit 0
fi

link_memories() {
  ln -sfn .memories-repo/memories "$memories_link"
}

# If setup fails AFTER we've moved the user's existing memories aside, put them
# back so we never leave an engineer with no memory files at all.
restore_backup_on_error() {
  if [ -n "$migration_backup" ] && [ -d "$migration_backup" ] && [ ! -L "$memories_link" ]; then
    echo "Setup failed — restoring your original memories from $migration_backup to $memories_link" >&2
    mv "$migration_backup" "$memories_link" || true
  fi
}
trap restore_backup_on_error ERR

# ─── Case 1: healthy — symlink present and checkout live. Nothing to do. ───
if [ -L "$memories_link" ] && \
   git -C "$memories_link" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Shared memories already linked — leaving as-is."
  exit 0
fi

# ─── Case 2: pre-existing non-symlink at the memories path ─────────────────
# Could be empty (left over from an uninstalled pack) or populated (engineer
# was already using mcs-cli/memory or Claude Code's automemory locally).
# Migrate either way: back the directory up, then fall through to first-time
# setup and import the contents afterward.
if [ -e "$memories_link" ] && [ ! -L "$memories_link" ]; then
  if [ ! -d "$memories_link" ]; then
    echo "$memories_link exists but is not a directory or symlink; refusing to touch it." >&2
    exit 0
  fi

  if [ -z "$(ls -A "$memories_link" 2>/dev/null)" ]; then
    echo "Found empty $memories_link — removing and proceeding with fresh setup."
    rmdir "$memories_link"
  else
    ts=$(date +%Y%m%d-%H%M%S)
    migration_backup="$MCS_PROJECT_PATH/.claude/.memories-migration-$ts"
    count=$(ls -1A "$memories_link" 2>/dev/null | wc -l | tr -d ' ')
    echo "Found pre-existing $memories_link with $count entr(y/ies) — staging for migration..."
    echo "  → backing up to $migration_backup"
    mv "$memories_link" "$migration_backup"
  fi
fi

# ─── Case 3: checkout is live but symlink is missing or broken — relink. ───
if [ -d "$repo_dir/.git" ] && \
   git -C "$repo_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Memories checkout present, (re)linking $memories_link → .memories-repo/memories..."
  rm -f "$memories_link"
  link_memories
else
  # ─── Case 4: checkout dir exists but incomplete (no .git) — refuse. ──────
  if [ -e "$repo_dir" ]; then
    echo "$repo_dir exists but is not a valid git checkout; refusing to touch it." >&2
    echo "Delete it manually and re-run \`mcs sync\` to re-clone." >&2
    exit 0
  fi

  # ─── Case 5: nothing exists — first-time setup. ──────────────────────────
  echo "Cloning shared memories (branch '$branch', sparse) into $repo_dir..."
  git clone \
    --sparse \
    --filter=blob:none \
    --branch "$branch" \
    --single-branch \
    "$repo_url" "$repo_dir"
  git -C "$repo_dir" sparse-checkout set memories
  link_memories
fi

# ─── Post-setup: import migration backup (shared wins on conflict). ────────
# For every regular file in the backup, move it into the now-symlinked memories
# folder unless a file of the same name already exists (in which case the
# shared/team copy wins and the local one is preserved in the backup dir for
# manual review). This protects against silent overwrite of team knowledge.
if [ -n "$migration_backup" ] && [ -d "$migration_backup" ]; then
  imported=0
  skipped=0
  shopt -s nullglob dotglob
  for f in "$migration_backup"/*; do
    [ -f "$f" ] || continue
    name=$(basename "$f")
    target="$memories_link/$name"
    if [ -e "$target" ]; then
      skipped=$((skipped + 1))
    else
      mv "$f" "$target"
      imported=$((imported + 1))
    fi
  done
  shopt -u nullglob dotglob

  # If nothing left in backup (no conflicts, no subdirs), clean it up.
  if [ -z "$(ls -A "$migration_backup" 2>/dev/null)" ]; then
    rmdir "$migration_backup"
    echo "Migration: imported $imported local memory file(s); $skipped conflict(s) (shared version kept)."
  else
    echo "Migration: imported $imported local memory file(s); $skipped conflict(s) preserved at"
    echo "  $migration_backup"
    echo "  (the shared repo had files with the same names; review and delete when ready)."
  fi
fi

# Clear the ERR trap now that we're past the risky section.
trap - ERR

# ─── Auto-commit migrated memories if any well-named ones landed. ──────────
# Without this step the migrated files are untracked in the sparse checkout,
# which (a) makes SessionStart emit a scary "lingering state" warning on the
# next session and (b) delays team sharing until the next Stop hook fires.
# Committing and pushing right here closes both gaps.
#
# Guardrail applied here mirrors the Stop hook's pattern: only files matching
# ^memories/(learning|decision)_*.md get staged. Non-conforming files (e.g.
# a personal scratch.txt) stay untracked with a rename nudge — the Stop hook's
# all-or-nothing guardrail will catch them again if the engineer ignores the
# nudge, so the pressure to rename is consistent.
if [ "${imported:-0}" -gt 0 ]; then
  # keep in sync with hooks/memories_autopush.sh allowed_pattern
  allowed_pattern='^memories/(learning|decision)_[a-zA-Z0-9_-]+\.md$'

  untracked=$(git -C "$repo_dir" ls-files --others --exclude-standard --full-name -- memories/ 2>/dev/null | grep -v '^$' || true)
  good_files=$(echo "$untracked" | grep -E  "$allowed_pattern" || true)
  bad_files=$( echo "$untracked" | grep -Ev "$allowed_pattern" || true)

  if [ -n "$good_files" ]; then
    while IFS= read -r f; do
      [ -n "$f" ] && git -C "$repo_dir" add -- "$f"
    done <<< "$good_files"

    host=$(hostname -s)
    git -C "$repo_dir" commit -m "auto: migrate local memories from $host" --quiet

    # Rebase in case teammates pushed while we were cloning / migrating, then push.
    if git -C "$repo_dir" pull --rebase --autostash --quiet 2>/dev/null; then
      if git -C "$repo_dir" push --quiet 2>/dev/null; then
        echo "Pushed migrated memories to the shared branch."
      else
        echo "Migrated memories committed locally; push failed (auth or network?). The next Stop hook will retry."
      fi
    else
      git -C "$repo_dir" rebase --abort 2>/dev/null || true
      echo "Migrated memories committed locally; rebase conflict blocked the push. The next Stop hook will retry."
    fi
  fi

  if [ -n "$bad_files" ]; then
    echo "Note: these migrated files don't match the naming convention and were left untracked:"
    echo "$bad_files" | sed 's/^/  - /'
    echo "Rename them to memories/learning_<topic>_<specific>.md or memories/decision_<domain>_<topic>.md so they can be shared with the team."
  fi
fi

count=$(ls "$memories_link"/*.md 2>/dev/null | wc -l | tr -d ' ')
echo "Done. $count memory file(s) available at $memories_link."
