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
        |                    |                    |     filename guard  |
        |                    |                    |     + configurable  |
        |                    v                    v     push policy     v
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
| **SessionStart Hook** | Pulls the latest team memories at session start | `git pull --ff-only` against the shared checkout; also flags lingering uncommitted/unpushed state — a stuck auto-push in `auto` / `full` mode, or pending changes awaiting decision in `review` mode |
| **Stop Hook** | Handles new/modified memory files after each Claude turn per `MEMORIES_AUTOPUSH_MODE` (`auto` / `full` / `review`) | Runs async; filename guardrail blocks bad names in every mode; mode dictates whether deletions auto-push and whether anything is committed at all |
| **Sparse Checkout + Symlink** | Keeps the shared repo invisible on disk | `.claude/.memories-repo/` is a blobless single-branch sparse clone; `.claude/memories` is a symlink Claude Code reads from |

### The Feedback Loop

1. **First `mcs sync`** — the configure script clones the shared repo sparsely into `.claude/.memories-repo/`, symlinks `.claude/memories` to it, and migrates any pre-existing local memories into the shared folder (conflicts are preserved for manual review)

2. **Session starts** — the SessionStart hook fast-forwards the shared checkout and warns about any lingering state (auth failure / rebase conflict / guardrail-rejected files in `auto` / `full`; pending review items in `review`)

3. **During work** — Claude uses the [`continuous-learning`](https://github.com/mcs-cli/memory) skill to write new `learning_*.md` / `decision_*.md` files

4. **Claude finishes a turn** — the Stop hook collects dirty files and dispatches by mode (`MEMORIES_AUTOPUSH_MODE`, see [Auto-Push Modes](#auto-push-modes)):
   - **Naming guardrail (all modes)** — any file failing `^memories/(learning|decision)_[a-zA-Z0-9_-]+\.md$` halts everything until renamed
   - **`auto` (default)** — adds/mods auto-pushed; deletions parked in the working tree for manual review
   - **`full`** — adds/mods AND deletions auto-pushed in one commit
   - **`review`** — nothing auto; the hook prints a per-file report with approve/discard commands instead

5. **Next session** — teammates pull your new memories via SessionStart and the loop continues

---

## What's Included

### Session Hooks

| Hook | Event | What It Does |
|------|-------|-------------|
| **memories_pull.sh** | `SessionStart` | Fast-forwards the shared memories checkout; emits a warning if previous state is stuck |
| **memories_autopush.sh** | `Stop` (async) | Dispatches by `MEMORIES_AUTOPUSH_MODE` mode (`auto` / `full` / `review`); filename guardrail applies in every mode |

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
| **MEMORIES_REPO_URL** | Clone URL for the shared memories repo, e.g. `git@github.com:org/memories.git` | *(required)* |
| **MEMORIES_BRANCH** | Branch that holds the memory files and this pack | `main` |
| **MEMORIES_AUTOPUSH_MODE** | Stop-hook behavior — `auto` (writes auto-pushed, deletions parked), `full` (writes + deletions auto-pushed), or `review` (nothing auto, per-turn report). See [Auto-Push Modes](#auto-push-modes). | `auto` |

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
├── .memories-repo/                  # sparse clone of MEMORIES_BRANCH
│   ├── README.md, LICENSE, etc.     # any root-level files your repo ships
│   └── memories/
│       ├── learning_*.md
│       └── decision_*.md
└── memories -> .memories-repo/memories   # symlink Claude Code reads
```

The clone uses `--sparse --filter=blob:none --single-branch` so only the `memories/` subtree plus any root-level files your repo ships (README, LICENSE) materialize on disk (~1 MB typical). Every hook git call is scoped with `-- memories/` pathspec, so root-level files are visible but never touched by the auto-commit/auto-push machinery — your teammates can edit the memories repo's README without tripping the guardrail.

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

## Optional: Push to a Side Branch

If your org enforces PR + ticket + approval on the default branch of your memories repo, every Claude Stop auto-pushing to it would turn each memory into a PR. That kills adoption.

**Workaround**: set `MEMORIES_BRANCH` to a side branch (e.g., `memories`) that no ruleset targets. Auto-push goes there; the default branch stays untouched and ruleset-compliant.

### Protect the Side Branch at the Repo Level

Free-push doesn't mean unprotected. Apply a repo-level ruleset to your side branch:

| Rule | What it blocks | Why |
|---|---|---|
| `non_fast_forward` | `git push --force` | Prevents history rewrite that could erase content between reflog expiries |
| `deletion` | `git push origin :<branch>` | Prevents catastrophic branch wipeout |

Normal commits (including ones that delete files via `memory-audit`) are unaffected, so the audit + manual-push flow still works.

---

## Auto-Push Modes

The Stop hook's behavior is set during `mcs sync` via the `MEMORIES_AUTOPUSH_MODE` prompt. The chosen value is written to `.claude/settings.local.json`'s `env` block (per-user / project-local). To change modes later, re-run `mcs sync` and pick a different value, or edit `.claude/settings.local.json` directly.

| Mode | Adds / Modifications | Deletions | When to use |
|------|----------------------|-----------|-------------|
| `auto` *(default)* | auto-pushed | parked for manual review | Safe default for most teams. The asymmetric trust matches how memories are typically created vs. removed. |
| `full` | auto-pushed | auto-pushed | You trust your workflow — `memory-audit` runs are deliberate, no fat-finger risk. Skips the Intentional Deletion Workflow below. |
| `review` | not pushed | not pushed | You want to inspect every change before it propagates to the team. The hook prints a per-file report each turn end. |

Unset, empty, and unrecognized values fall through to `auto` (with a one-line warning for unrecognized values), so existing installs see zero behavior change.

In `review` mode, the hook prints a report on each turn end:

```
Shared memories [review mode]: <N> pending item(s) in memories/
+ NEW  file:///…/memories/learning_foo.md
       "<first non-empty line preview>"
~ MOD  file:///…/memories/decision_bar.md  (+3 -1)
       Diff: git -C .claude/.memories-repo diff -- memories/decision_bar.md
- DEL  memories/learning_old.md  (last modified 3 weeks ago)
       Recover: git -C .claude/.memories-repo checkout HEAD -- memories/learning_old.md

Approve all: …  (bulk add + commit + pull --rebase + push)
Discard local changes: …
```

The same pending set is reported once per session — repeated turns within the session stay silent so the report doesn't spam every prompt. SessionStart resets the dedupe so unresolved changes re-surface in the next session instead of being buried forever.

Pull is always automatic regardless of mode — incoming team memories arrive at session start.

---

## Intentional Deletion Workflow

When you legitimately want to remove stale memories (typically after running the `memory-audit` skill from `mcs-cli/memory`), do it manually:

```bash
git -C .claude/.memories-repo/memories commit -am "audit: remove stale memories"
git -C .claude/.memories-repo/memories push
```

The deletion block in `auto` mode is deliberate friction: audit is rare enough (monthly-ish) that requiring explicit human confirmation is cheap insurance against catastrophic local-delete-then-auto-push accidents.

If your workflow makes that friction unnecessary, set `MEMORIES_AUTOPUSH_MODE=full` to skip this step — `memory-audit`'s deletions will then auto-push alongside any other writes.

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

**If SessionStart warns about lingering state**:
- In `auto` / `full` mode the previous push hit an auth/network issue (fix and wait for the next Stop), or guardrail-rejected files are sitting dirty (rename them). `mcs doctor` will tell you which.
- In `review` mode the warning is expected — it lists pending changes awaiting your decision. End a turn to see the per-file report.

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
