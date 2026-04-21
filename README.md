# Shared Memories

A [tech pack](https://github.com/mcs-cli/mcs) that auto-syncs Claude Code's `.claude/memories/` across a team via a dedicated shared git repo. Captures are handled by [`mcs-cli/memory`](https://github.com/mcs-cli/memory) (the `continuous-learning` skill + semantic retrieval); this pack **shares** those captures across the team without anyone remembering to commit or push.

Built for the [`mcs`](https://github.com/mcs-cli/mcs) configuration engine.

```
identifier: shared-memories
requires:   mcs >= 2026.4.12
```

---

## When Is This Useful?

**You probably don't need this pack if** your team commits `.claude/memories/` directly into the project repo — normal git workflow already shares those memories across the team and this pack adds nothing.

**This pack is useful when**:

- You want memories in a **dedicated repo**, separate from project code — to avoid noising project PRs with memory-only diffs, to apply different access or review rules, or because the project's default-branch rulesets make small auto-commits painful.
- You run **multiple related repos** (microservices, mobile + web + backend, split client/server) that should share the **same memory corpus** — a learning about the auth contract is relevant to every service that talks to it, and a central memories repo lets all of them read/write the same KB.
- You want team memories to **outlive individual project repos** — short-lived prototypes, archived services, or repos that come and go shouldn't take institutional knowledge with them.

---

## The Problem

Claude Code's `.claude/memories/` is great — you accumulate `learning_*.md` and `decision_*.md` files and Claude gets smarter about your codebase over time. But memories are **per-engineer**: when someone figures out a gnarly integration quirk or pins down a subtle architecture decision, only they benefit.

The obvious fix is a shared git repo. Two friction points kill adoption:

1. **Remembering to push.** People forget. Memories sit on laptops for weeks.
2. **Branch protection on the shared repo.** If every Claude turn needs a PR + ticket + approval, nobody will bother pushing their tiny observations.

## The Solution

This pack implements a **closed-loop sharing system** that pulls the latest team memories at session start and pushes new ones when Claude finishes a turn.

```
                             SHARED MEMORIES LOOP

 ┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
 │   SESSION    │     │   TEAM KB    │     │     WORK     │     │     STOP     │
 │    START     │────>│    PULL      │────>│   SESSION    │────>│  AUTO-PUSH   │
 └──────────────┘     └──────────────┘     └──────────────┘     └──────────────┘
        ^                    |                    |                     |
        |                    |                    |       filename      |
        |                    |                    |       + deletion    |
        |                    v                    v       guardrails    v
        |             ┌────────────────────────────────────────────────────┐
        |             │              <shared memories repo>                 │
        |             │  memories/                                          │
        |             │    learning_background_task_watchdog_timeout.md     │
        +─────────────│    learning_orm_batch_insert_memory_spike.md        │
                      │    decision_architecture_mvvm_coordinators.md       │
                      │    ...                                              │
                      └────────────────────────────────────────────────────┘
```

Captures still come from [`mcs-cli/memory`](https://github.com/mcs-cli/memory). This pack is the distribution layer that makes them team-shared.

---

## How It Works

### The Three Pieces

| Piece | What | How |
|-------|------|-----|
| **SessionStart Hook** | Pulls the latest team memories at session start | `git pull --ff-only` against the shared checkout; also flags uncommitted/unpushed state left behind by a previous failed auto-push |
| **Stop Hook** | Auto-commits and pushes new/modified memory files after each Claude turn | Runs async; applies two guardrails (filename pattern + deletion block) before staging; rebases then pushes |
| **Sparse Checkout + Symlink** | Keeps the shared repo invisible on disk | `.claude/.memories-repo/` is a blobless single-branch sparse clone; `.claude/memories` is a symlink Claude Code reads from |

### The Feedback Loop

1. **First `mcs sync`** — the configure script clones the shared repo sparsely into `.claude/.memories-repo/`, symlinks `.claude/memories` to it, and migrates any pre-existing local memories into the shared folder (conflicts are preserved for manual review)

2. **Session starts** — the SessionStart hook fast-forwards the shared checkout and warns if a previous Stop left lingering state (auth failure, rebase conflict, guardrail-rejected files)

3. **During work** — Claude uses the [`continuous-learning`](https://github.com/mcs-cli/memory) skill to write new `learning_*.md` / `decision_*.md` files

4. **Claude finishes a turn** — the Stop hook collects dirty files, applies guardrails:
   - **Naming guardrail** — any file failing `^memories/(learning|decision)_[a-zA-Z0-9_-]+\.md$` halts everything until renamed
   - **Deletion guardrail** — deleted files are never auto-pushed (prevents accidental `rm` wiping team knowledge), but coexisting additions/modifications still push
   - Staged files commit as `auto: memories from <host> <date>`, rebase onto upstream, push

5. **Next session** — teammates pull your new memories via SessionStart and the loop continues

---

## What's Included

### Session Hooks

| Hook | Event | What It Does |
|------|-------|-------------|
| **memories_pull.sh** | `SessionStart` | Fast-forwards the shared memories checkout; emits a warning if previous state is stuck |
| **memories_autopush.sh** | `Stop` (async) | Auto-commits and pushes dirty memory files; enforces filename pattern + deletion block |

### Configuration Script

| Script | When | What It Does |
|--------|------|-------------|
| **configure-memories.sh** | `mcs sync` | Sparse-clones the shared repo, sets up the symlink, migrates any pre-existing `.claude/memories/` into the shared folder |

### Doctor Checks

| Check | What It Verifies |
|-------|-----------------|
| **Shared memories setup** | Sparse checkout exists and the symlink resolves to a live git repo (auto-fixable via `mcs sync`) |
| **Shared memories remote access** | Auth + network reachability via `git ls-remote origin`; warns (doesn't fail) on issues since local reads still work |

### Dependencies

| Dep | Via |
|-----|-----|
| **jq** | brew |

---

## Installation

### Prerequisites

- macOS
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- [mcs](https://github.com/mcs-cli/mcs) CLI
- [`mcs-cli/memory`](https://github.com/mcs-cli/memory) (companion capture pack — produces the `learning_*.md` / `decision_*.md` files this pack shares)
- A git repo the team can push to (SSH or HTTPS access)

### Setup

```bash
# 1. Install mcs
brew install mcs-cli/tap/mcs

# 2. Register both packs (capture + share)
mcs pack add mcs-cli/memory
mcs pack add mcs-cli/shared-memories

# 3. Sync your project
cd ~/Developer/my-project
mcs sync

# 4. Verify everything is healthy
mcs doctor
```

During `mcs sync`, you'll be prompted for:

| Prompt | What It Does | Default |
|--------|-------------|---------|
| **MEMORIES_REPO_URL** | Git URL of the shared memories repo (SSH or HTTPS) | *(required)* |
| **MEMORIES_BRANCH** | Branch that holds the memory files and this pack | `main` |
| **MEMORIES_DIR_NAME** | Folder inside `.claude/` that Claude Code reads memories from | `memories` |

---

## Directory Structure

```
shared-memories/
├── techpack.yaml                    # Manifest — defines all components
├── hooks/
│   ├── memories_pull.sh             # SessionStart: pull + stuck-state warning
│   └── memories_autopush.sh         # Stop: auto-commit + push (async)
└── scripts/
    ├── configure-memories.sh        # Sparse clone + symlink + migration
    ├── doctor-memories.sh           # Setup health check
    └── doctor-memories-remote.sh    # Remote-access health check
```

On engineer disks, the pack materializes as:

```
<project>/.claude/
├── .memories-repo/                  # hidden sparse clone of MEMORIES_BRANCH
│   └── memories/
│       ├── learning_*.md
│       └── decision_*.md
└── memories -> .memories-repo/memories   # symlink Claude Code reads
```

The clone uses `--filter=blob:none --single-branch --sparse` so only the memory markdowns materialize on disk (~1 MB typical) — pack plumbing (`techpack.yaml`, `hooks/`, `scripts/`) stays in git history but never hits the working tree.

---

## Migration From an Existing Local Memories Folder

Engineers who already have `.claude/memories/` populated (from `mcs-cli/memory`, Claude Code's native memory, or manual use) are handled automatically on first `mcs sync`:

1. The existing directory is moved aside to `.claude/.memories-migration-<timestamp>/`
2. The sparse clone + symlink are set up as normal
3. Files from the backup are imported into the new shared folder, **with the shared version winning on any filename conflict** (your local copy stays in the backup dir for manual review)
4. Well-named migrated files are auto-committed and pushed so they immediately become team knowledge
5. If no conflicts remain, the backup dir is cleaned up automatically

If any step fails partway, an `ERR` trap restores the original folder from the backup — you're never left with a broken setup and no memories.

---

## Optional: Working Around Default-Branch Rulesets

If your org enforces PR + ticket + approval on every default branch, every Claude Stop auto-pushing to it would turn each memory into a PR. That kills adoption.

**Workaround**: put everything on a side branch that no ruleset targets:

| Branch | Content | Push policy |
|---|---|---|
| `main` (default) | Stub README pointing at the side branch | PR-gated (org ruleset applies). Untouched after init. |
| `memories` (side) | Pack files + memory markdowns | **Free push**, no ruleset matches it |

Set `MEMORIES_BRANCH=memories` at install. Engineers push freely to the side branch; the default branch stays ruleset-compliant and no one ever touches it.

### Protect the Side Branch at the Repo Level

Free-push doesn't mean unprotected. Apply a repo-level ruleset to your side branch:

| Rule | What it blocks | Why |
|---|---|---|
| `non_fast_forward` | `git push --force` | Prevents history rewrite that could erase content between reflog expiries |
| `deletion` | `git push origin :<branch>` | Prevents catastrophic branch wipeout |

Normal commits (including ones that delete files via `memory-audit`) are unaffected, so the audit + manual-push flow still works.

---

## Intentional Deletion Workflow

When you legitimately want to remove stale memories (typically after running the `memory-audit` skill from `mcs-cli/memory`), do it manually:

```bash
git -C .claude/.memories-repo/memories commit -am "audit: remove stale memories"
git -C .claude/.memories-repo/memories push
```

The deletion block is deliberate friction: audit is rare enough (monthly-ish) that requiring explicit human confirmation is cheap insurance against catastrophic local-delete-then-auto-push accidents.

---

## Configuration Notes

### Gitignore Caveat

The pack adds these entries globally:

```
.claude/memories                # default symlink name
.claude/.memories-repo          # hidden sparse checkout (fixed name)
.claude/.memories-migration-*   # migration backups (fixed prefix)
```

If you override `MEMORIES_DIR_NAME` to anything other than `memories`, **add `.claude/<your-name>` to your gitignore manually** (global `~/.gitignore` or the parent repo's `.gitignore`). The configure script prints a reminder when this applies.

---

## Troubleshooting

```bash
mcs pack validate .                                  # verify techpack.yaml + file refs
mcs doctor                                           # after sync: verify setup + remote access
git -C .claude/.memories-repo/memories log -1        # confirm auto-push landed
```

**If the Stop hook silently refuses to push**, the naming guardrail is likely rejecting a file. Run:

```bash
git -C .claude/.memories-repo/memories status              # dirty files
git -C .claude/.memories-repo/memories ls-files --others   # untracked files
```

Anything not matching `memories/(learning|decision)_*.md` needs renaming.

**If SessionStart warns about lingering state**, either the previous push hit an auth/network issue (fix and wait for the next Stop), or guardrail-rejected files are sitting dirty (rename them). `mcs doctor` will tell you which.

---

## Links

- [MCS](https://github.com/mcs-cli/mcs) — the configuration engine
- [Creating Tech Packs](https://github.com/mcs-cli/mcs/blob/main/docs/creating-tech-packs.md) — guide for building your own
- [Tech Pack Schema](https://github.com/mcs-cli/mcs/blob/main/docs/techpack-schema.md) — full YAML reference
- [Claude Code hooks](https://docs.anthropic.com/en/docs/claude-code/hooks)
- [Git sparse-checkout](https://git-scm.com/docs/git-sparse-checkout)
- [Git partial clone](https://git-scm.com/docs/partial-clone)

---

## License

MIT
