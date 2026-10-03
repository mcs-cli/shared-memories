---
description: Fix what the shared-memories Stop hook can't fix on its own, then push
argument-hint: "[reason]"
disable-model-invocation: true
---

# Resolve Shared Memories

The Stop hook commits and pushes every memory change at the end of each turn, and retries network failures and rejected pushes by itself. This command handles what retrying never fixes: a rebase conflict, a file the naming guardrail rejects, a checkout with no upstream, or a rebase someone left half-finished. Auth and git-identity failures need a human; diagnose them and say exactly what to run.

Arguments: $ARGUMENTS (optional reason for the commit subject).

All git commands run against the memories repo as `git -C .claude/.memories-repo …`, with `-- memories/` as the pathspec. Never `-C .claude/memories`: that puts git's cwd inside `memories/`, and the pathspec then matches nothing.

## 1. Read the state

- `git -C .claude/.memories-repo status --porcelain -- memories/`: dirty files
- `git -C .claude/.memories-repo rev-parse --abbrev-ref --symbolic-full-name '@{u}'`: the upstream (fails if none)
- `git -C .claude/.memories-repo rev-list '@{u}..HEAD' --count`: unpushed commits
- `git -C .claude/.memories-repo rev-parse --path-format=absolute --git-path rebase-merge --git-path rebase-apply --git-path MERGE_HEAD`: if any of the three printed paths exists, a rebase (or merge) is in progress. The paths must be absolute: a relative one resolves against the project root and checks the wrong `.git`

If nothing is dirty, nothing is unpushed, an upstream exists and no rebase or merge is in progress, report **"Nothing to resolve."** and stop.

## 2. A rebase or merge already in progress

Go straight to step 6 and finish it. Don't commit anything new first. For a merge (`MERGE_HEAD`), resolve the conflicts the same way, then finish with `git -C .claude/.memories-repo commit --no-edit`.

## 3. Filename guardrail

Every dirty file under `memories/` must match `^memories/(learning|decision)_[a-zA-Z0-9_-]+\.md$`, the pattern the Stop hook enforces, defined once in `runtime/lib/naming.mts`. For each offender:

- read it and propose a conforming name: `learning_<topic>_<specific>.md` for something learned, `decision_<domain>_<topic>.md` for a decision taken;
- ask the user if the type is unclear, or if the file looks like scratch that shouldn't be shared at all;
- rename it with `git -C .claude/.memories-repo mv` if tracked, plain `mv` if untracked.

## 4. No upstream

Set it: `git -C .claude/.memories-repo branch --set-upstream-to=origin/<current branch>`. If that remote branch doesn't exist, stop and tell the user. The branch is chosen during `mcs sync`.

## 5. Commit

- `git -C .claude/.memories-repo add -A -- memories/`
- Skip the commit if nothing got staged (only unpushed commits are pending).
- Subject: `<name>: resolve — <reason>`. `<name>` is the author git will use: the part of `git -C .claude/.memories-repo var GIT_AUTHOR_IDENT` before ` <`. `<reason>` is `$ARGUMENTS`, or a few words on what you fixed.
- If the commit fails because git has no identity, stop and tell the user to set `git config --global user.name` and `user.email`.

## 6. Rebase onto the team's work, resolving conflicts

`git -C .claude/.memories-repo pull --rebase --autostash`. For each conflicted file (`git -C .claude/.memories-repo diff --name-only --diff-filter=U`):

- **Both sides edited a memory**: write one version that keeps every fact from both sides. Drop only exact duplicates, and keep the file's existing structure. Show the user the merged result.
- **One side deleted it, the other edited it**: ask the user whether to keep the edited version or let the deletion stand.
- **A conflict outside `memories/`**: `git -C .claude/.memories-repo rebase --abort`, tell the user, and stop.

Then `git -C .claude/.memories-repo add -- <file>` and `GIT_EDITOR=true git -C .claude/.memories-repo rebase --continue`, repeating until the rebase completes. **Never finish this command with a rebase still in progress.** Either complete it or abort it.

## 7. Push

`git -C .claude/.memories-repo push`.

- Rejected because a teammate pushed meanwhile: go back to step 6, once.
- Any other failure (auth, network, repository): stop. Suggest `ssh-add` for SSH remotes, a credential refresh for HTTPS, and `mcs doctor` to confirm remote access. Don't retry in a loop; the next Stop retries on its own.

## 8. Report

Tell the user what was wrong, what you changed (renames, conflict merges, upstream), the commit subject, and whether the push landed.
