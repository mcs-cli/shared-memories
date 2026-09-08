---
description: Approve and push pending shared memories
---

# Approve Shared Memories

Stage, commit, pull --rebase, and push everything pending under `.claude/.memories-repo/memories/`. Works in any mode; primary use is `review`.

Arguments: $ARGUMENTS (optional commit-message reason). If omitted, default to `approved memories from <hostname> <YYYY-MM-DD>`.

## 1. Check pending state

Run `git -C .claude/.memories-repo status --porcelain -- memories/` and `git -C .claude/.memories-repo rev-list '@{u}..HEAD' --count` (treat missing upstream as 0). If both are empty, report **"Nothing to approve."** and stop.

## 2. Filename guardrail

Every dirty file under `memories/` must match `^memories/(learning|decision)_[a-zA-Z0-9_-]+\.md$` — the same pattern the Stop hook enforces, defined once in `runtime/lib/naming.mts`. If any file fails, list the offenders, instruct the user to rename them to `memories/learning_<topic>_<specific>.md` or `memories/decision_<domain>_<topic>.md`, and stop without committing.

## 3. Stage, commit, push

- `git -C .claude/.memories-repo add -A -- memories/`
- Compose the commit subject: `review: <reason>` where `<reason>` is `$ARGUMENTS` if given, else `approved memories from $(hostname -s) $(date +%F)`.
- `git -C .claude/.memories-repo commit -m "<subject>"` — skip if nothing got staged (only unpushed commits pending).
- `git -C .claude/.memories-repo pull --rebase --autostash`
- `git -C .claude/.memories-repo push`

If `pull --rebase` reports a conflict, run `git -C .claude/.memories-repo rebase --abort` and tell the user to resolve manually in `.claude/.memories-repo/memories`. Do not push.

## 4. Report

Tell the user the commit subject, the number of files committed, and that the push landed (or didn't, with the underlying error).
