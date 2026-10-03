# 🧠 Shared Memories

A [tech pack](https://github.com/mcs-cli/mcs) that auto-syncs Claude Code's `.claude/memories/` across a team via a dedicated shared git repo. Captures are handled by [`mcs-cli/memory`](https://github.com/mcs-cli/memory) (the `continuous-learning` skill + semantic retrieval); this pack **shares** those captures across the team without anyone remembering to commit or push.

Built for the [`mcs`](https://github.com/mcs-cli/mcs) configuration engine.

```
identifier: shared-memories
requires:   mcs >= 2026.9.3
```

**Contents** — [When is this useful?](#-when-is-this-useful) · [The problem](#-the-problem) · [How it works](#-how-it-works) · [What's included](#-whats-included) · [Installation](#-installation) · [Directory structure](#-directory-structure) · [Migration](#-migration-from-an-existing-local-memories-folder) · [Side branches](#-optional-push-to-a-side-branch) · [Conflicts and stuck pushes](#-conflicts-and-stuck-pushes) · [Troubleshooting](#-troubleshooting) · [Development](#-development)

---

## 🤔 When Is This Useful?

**You probably don't need this pack if** your team commits `.claude/memories/` directly into the project repo — normal git workflow already shares those memories across the team and this pack adds nothing.

**This pack is useful when**:

- You want memories in a **dedicated repo**, separate from project code — to avoid noising project PRs with memory-only diffs, to apply different access or review rules, or because the project's default-branch rulesets make small auto-commits painful.
- You run **multiple related repos** (microservices, mobile + web + backend, split client/server) that should share the **same memory corpus** — a learning about the auth contract is relevant to every service that talks to it, and a central memories repo lets all of them read/write the same KB.
- You want team memories to **outlive individual project repos** — short-lived prototypes, archived services, or repos that come and go shouldn't take institutional knowledge with them.

---

## 🧩 The Problem

Claude Code's `.claude/memories/` is great — you accumulate `learning_*.md` and `decision_*.md` files and Claude gets smarter about your codebase over time. But memories are **per-engineer**: when someone figures out a gnarly integration quirk or pins down a subtle architecture decision, only they benefit.

The obvious fix is a shared git repo. Two friction points kill adoption:

1. **Remembering to push.** People forget. Memories sit on laptops for weeks.
2. **Branch protection on the shared repo.** If every Claude turn needs a PR + ticket + approval, nobody will bother pushing their tiny observations.

## 🔁 The Solution

This pack implements a **closed-loop sharing system** that pulls the latest team memories at session start and pushes new ones when Claude finishes a turn.

```mermaid
flowchart TD
    S([Session starts]) --> P["SessionStart hook<br/>git pull --ff-only"]
    P --> W["Work session<br/>continuous-learning writes<br/>learning_*.md · decision_*.md"]
    W --> T["Stop hook<br/>auto-push"]
    T -->|"filename guard<br/>+ configurable push policy"| R
    R[("shared memories repo — memories/<br/><br/>learning_background_task_watchdog_timeout.md<br/>learning_orm_batch_insert_memory_spike.md<br/>decision_architecture_mvvm_coordinators.md<br/>…")]
    R -->|"teammates fast-forward at<br/>their next session start"| P
```

Captures still come from [`mcs-cli/memory`](https://github.com/mcs-cli/memory). This pack is the distribution layer that makes them team-shared.

---

## 🔩 How It Works

### The Pieces

| Piece | What | How |
|-------|------|-----|
| **SessionStart Hook** | Pulls the latest team memories at session start | `git pull --ff-only` against the shared checkout; also flags what would keep your memories from reaching the team: lingering uncommitted/unpushed state, a rebase left half-finished, or a checkout with no upstream |
| **Stop Hook** | Commits and pushes every memory change after each Claude turn — additions, edits and deletions alike | Runs async; the filename guardrail blocks bad names; commits as the git user with a subject that says what changed; rebases and retries with jitter when a teammate pushed first |
| **/resolve-memories Slash Command** | Fixes what the Stop hook can't fix by retrying: merges rebase conflicts, renames files the guardrail rejects, restores a missing upstream | Commits, rebases and pushes once the blocker is gone; diagnoses auth and git-identity failures, which need a human |
| **Sparse Checkout + Symlink** | Keeps the shared repo invisible on disk | `.claude/.memories-repo/` is a blobless single-branch sparse clone; `.claude/memories` is a symlink Claude Code reads from |
| **CLAUDE.local.md Section** | Tells Claude the memories folder is a shared checkout rather than local scratch, so it doesn't stage memories in the wrong repo, misread an empty `git log` as "no history", or tidy away a teammate's file | An mcs template section (`shared-memories.instructions`) composed into `CLAUDE.local.md` on every `mcs sync`, between `<!-- mcs:begin -->` markers; your own content outside the markers is preserved |

### The Feedback Loop

1. **First `mcs sync`** — the configure script clones the shared repo sparsely into `.claude/.memories-repo/`, symlinks `.claude/memories` to it, and migrates any pre-existing local memories into the shared folder (conflicts are preserved for manual review)

2. **Session starts** — the SessionStart hook fast-forwards the shared checkout and warns about any lingering state (auth failure, rebase conflict, guardrail-rejected files, a rebase left in progress, no upstream)

3. **During work** — Claude uses the [`continuous-learning`](https://github.com/mcs-cli/memory) skill to write new `learning_*.md` / `decision_*.md` files

4. **Claude finishes a turn** — the Stop hook commits everything under `memories/` and pushes it:
   - **Naming guardrail** — any file failing `^memories/(learning|decision)_[a-zA-Z0-9_-]+\.md$` halts everything until renamed
   - **Commit** — additions, edits and deletions in one commit, authored as you: `Ana Souza: add learning_swiftui_previews`, or `Ana Souza: 2 added, 1 removed` with one line per file in the body
   - **Push** — `pull --rebase --autostash`, then push, retrying with jitter if a teammate pushed first. A conflict pauses the push until `/resolve-memories` merges it

5. **Next session** — teammates pull your new memories via SessionStart and the loop continues

The Stop hook in full, since it is where all the policy lives:

```mermaid
flowchart TD
    A([Claude finishes a turn]) --> P{"rebase or merge<br/>in progress?"}
    P -->|yes| Q["pause, ask for<br/>/resolve-memories"] --> Z
    P -->|no| B{"anything uncommitted<br/>or unpushed?"}
    B -->|no| Z([exit 0])
    B -->|yes| C{"every dirty file matches<br/>memories/learning_*.md<br/>or memories/decision_*.md?"}
    C -->|no| D["list the offenders,<br/>push nothing"] --> Z
    C -->|yes| G["stage everything,<br/>deletions included"]
    G --> I["commit as the git user ·<br/>pull --rebase --autostash · push<br/>retry with jitter if rejected"]
    I -->|rebase conflict| R["abort the rebase,<br/>ask for /resolve-memories"] --> Z
    I --> Z
```

---

## 📦 What's Included

### Session Hooks

| Hook | Event | What It Does |
|------|-------|-------------|
| **pull.mts** | `SessionStart` | Fast-forwards the shared memories checkout; warns when previous state is stuck, a rebase is left in progress, or the checkout has no upstream |
| **autopush.mts** | `Stop` (async) | Commits every change under `memories/` as the git user, then rebases and pushes; the filename guardrail blocks bad names |

Each runs as `node --experimental-strip-types --disable-warning=ExperimentalWarning <path>`: mcs prefixes the interpreter the hook declares in `hookInterpreter`, and never looks at the shebang. They install to `.claude/hooks/shared-memories/`, with the library they import beside them in `lib/`.

### Slash Commands

| Command | What It Does |
|---------|-------------|
| **/resolve-memories** | Fixes what the Stop hook can't: merges rebase conflicts, renames files the guardrail rejects, restores a missing upstream, finishes a rebase left in progress — then commits and pushes. Diagnoses auth and git-identity failures. See [Conflicts and stuck pushes](#-conflicts-and-stuck-pushes) |

### Configuration Script

| Script | When | What It Does |
|--------|------|-------------|
| **configure-memories.ts** | `mcs sync` | Sparse-clones the shared repo, sets up the symlink, migrates any pre-existing `.claude/memories/` into the shared folder |

### CLAUDE.local.md Section

| Section | What It Does |
|---------|-------------|
| **shared-memories.instructions** | Four facts Claude cannot infer from the filesystem: writes and deletions reach the team's repo at the end of the turn; the memory set changes between sessions; the parent project's git doesn't track memories (so `git add` there is a silent no-op); and memory files must be addressed as `git -C .claude/.memories-repo -- memories/<file>` |

### Doctor Checks

| Check | What It Verifies |
|-------|-----------------|
| **Shared memories setup** | Sparse checkout exists and the symlink resolves to a live git repo (auto-fixable via `mcs sync`) |
| **Shared memories remote access** | Auth + network reachability via `git ls-remote origin`; warns (doesn't fail) on issues since local reads still work |

### Dependencies

| Dep | Via |
|-----|-----|
| **Node.js 22.6+** | brew |

Node runs the TypeScript directly — there is no build step, no `node_modules`, and no runtime dependencies.

---

## 🚀 Installation

### Prerequisites

- macOS
- Node.js 22.6 or newer (where `--experimental-strip-types` landed)
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

> **Install per-project, not globally.** Run `mcs sync` from each project's root (the directory that contains `.claude/`, not `.claude/` itself) — do **not** install this pack into your user-level `~/.claude/` directory.
>
> The hooks anchor on their own on-disk location and operate on a sibling `.memories-repo/` working tree. A single global install would collapse every project onto one shared checkout, which breaks two things:
>
> 1. **Concurrent sessions race on the same working tree.** If you run Claude in two projects at the same time, both Stop hooks try to stage, commit, rebase, and push against the same `.git` index — you'll see interleaved commits and half-applied rebases.
> 2. **Project context bleeds across sessions.** Memories Claude writes while working on project A would be auto-pushed under project B's session if B happens to end its turn first.
>
> Per-project installs keep one independent clone per repo while still sharing the same remote, so the team-wide KB stays unified without the local race conditions.

---

## 📁 Directory Structure

```
shared-memories/
├── techpack.yaml                    # Manifest — defines all components
├── commands/
│   └── resolve-memories.md          # Slash command for conflicts and stuck pushes
├── runtime/                         # Installed to .claude/hooks/shared-memories/
│   ├── pull.mts                     # SessionStart: pull + stuck-state warning
│   ├── autopush.mts                 # Stop: auto-commit + push (async)
│   └── lib/                         # git, paths, naming, pending, commit-message, push
├── scripts/                         # Run in place from the pack checkout
│   ├── configure-memories.ts        # Sparse clone + symlink + migration
│   ├── doctor-memories.ts           # Setup health check
│   └── doctor-memories-remote.ts    # Remote-access health check
├── tests/                           # node:test — unit, contract and behaviour
│   └── golden/                      # Behaviour recordings the suite checks against
├── templates/
│   └── instructions.md              # CLAUDE.local.md section — what this dir is
├── .github/workflows/ci.yml         # macOS × Node 22.6/22/24
├── package.json                     # No dependencies; test + typecheck scripts
└── tsconfig.json                    # Strict, erasable-syntax-only, no emit
```

On engineer disks, the pack materializes as:

```
<project>/.claude/
├── hooks/shared-memories/           # run by mcs via each hook's declared hookInterpreter
│   ├── pull.mts
│   ├── autopush.mts
│   └── lib/                         # imported as ./lib/… by the entries beside it
├── .memories-repo/                  # sparse clone of MEMORIES_BRANCH
│   ├── README.md, LICENSE, etc.     # any root-level files your repo ships
│   └── memories/
│       ├── learning_*.md
│       └── decision_*.md
└── memories -> .memories-repo/memories   # symlink Claude Code reads
```

The clone uses `--sparse --filter=blob:none --single-branch` so only the `memories/` subtree plus any root-level files your repo ships (README, LICENSE) materialize on disk (~1 MB typical). Every hook git call is scoped with `-- memories/` pathspec, so root-level files are visible but never touched by the auto-commit/auto-push machinery — your teammates can edit the memories repo's README without tripping the guardrail.

---

## 🚚 Migration From an Existing Local Memories Folder

Engineers who already have `.claude/memories/` populated (from `mcs-cli/memory`, Claude Code's native memory, or manual use) are handled automatically on first `mcs sync`:

1. The existing directory is moved aside to `.claude/.memories-migration-<timestamp>/`
2. The sparse clone + symlink are set up as normal
3. Files from the backup are imported into the new shared folder, **with the shared version winning on any filename conflict** (your local copy stays in the backup dir for manual review)
4. **Files the shared repo previously deleted are held back** rather than re-imported (see below)
5. Well-named migrated files are auto-committed and pushed so they immediately become team knowledge
6. If nothing is left in the backup dir, it's cleaned up automatically

If any step fails partway, the failure path restores the original folder from the backup — you're never left with a broken setup and no memories.

Each file in the backup takes one of four paths:

```mermaid
flowchart TD
    A["a file in the migration backup"] --> B{"a file of that name<br/>already in the shared repo?"}
    B -->|yes| C["skip — the shared copy wins,<br/>yours stays in the backup"]
    B -->|no| D{"deleted somewhere in<br/>the branch's history?"}
    D -->|yes| E["hold back, naming the<br/>commit that removed it"]
    D -->|no| F["import into memories/"]
    F --> G{"matches the naming rule?"}
    G -->|yes| H["auto-commit and push"]
    G -->|no| I["leave untracked,<br/>with a rename nudge"]
```

### Why previously-deleted files are held back

Matching on "does this filename exist right now" isn't enough. Anything a past `memory-audit` removed is absent from the working tree, so a stale local copy looks brand new — it gets re-imported and, because well-named migrated files are auto-pushed, silently restored for the whole team. That reverses a curation decision someone made deliberately.

So the importer also scans the branch's history for deletions and holds those files back, naming the commit that removed each one:

```
Held back 1 file(s) previously deleted from the shared repo:
  - learning_x_y.md
      deleted by 6367a99 audit: remove stale memories
```

They stay in the backup dir; copy one across yourself to re-add it deliberately. Any historical deletion counts, not just commits labelled `audit:` — most curation happens in ordinary auto-push commits, so matching on the subject line would miss the majority of it.

To audit an import after the fact:

```bash
# what did this import add?
git -C .claude/.memories-repo show --name-only --format="" <commit>

# which paths were deleted before, and why? (the subject carries the intent)
git -C .claude/.memories-repo log --all --diff-filter=D --name-only \
  --format='%h|%ad|%s' --date=short -- memories/
```

A separate gap worth knowing about when you audit: filenames alone under-count duplicates, because memories consolidated during an earlier merge were **renamed**, so a re-added fragment never collides with its surviving twin. Compare normalized names (strip `_`/`-`/case), titles, and content — not just filenames.

---

## 🌿 Optional: Push to a Side Branch

If your org enforces PR + ticket + approval on the default branch of your memories repo, every Claude Stop auto-pushing to it would turn each memory into a PR. That kills adoption.

**Workaround**: set `MEMORIES_BRANCH` to a side branch (e.g., `memories`) that no ruleset targets. Auto-push goes there; the default branch stays untouched and ruleset-compliant.

### Protect the Side Branch at the Repo Level

Free-push doesn't mean unprotected. Apply a repo-level ruleset to your side branch:

| Rule | What it blocks | Why |
|---|---|---|
| `non_fast_forward` | `git push --force` | Prevents history rewrite that could erase content between reflog expiries |
| `deletion` | `git push origin :<branch>` | Prevents catastrophic branch wipeout |

Normal commits (including ones that delete files via `memory-audit`) are unaffected.

---

## 🧯 Conflicts and Stuck Pushes

Every change under `memories/` — additions, edits and deletions — is pushed at the end of the turn that made it. A memory removed by mistake comes back from history:

```bash
git -C .claude/.memories-repo log --diff-filter=D --oneline -- memories/<file>   # find the commit that removed it
git -C .claude/.memories-repo checkout <sha>^ -- memories/<file>                 # restore it; the next Stop pushes it
```

The Stop hook retries on every turn, so a network blip or a teammate pushing first sorts itself out. A few things never clear up by retrying. SessionStart and the Stop hook name them when they happen, and `/resolve-memories` handles the ones Claude can fix:

| Blocker | What `/resolve-memories` does |
|---------|-------------------------------|
| **Rebase conflict** — you and a teammate edited the same memory | Merges both versions so neither side's facts are lost, and shows you the result. Asks you when one side deleted the file and the other edited it |
| **Unconventional filename** — the guardrail halts every push | Proposes a `learning_…` / `decision_…` name and renames the file. Asks you when the type is unclear |
| **Rebase left in progress** — the hooks pause rather than commit conflict markers | Finishes it, or aborts it if the conflict is outside `memories/` |
| **No upstream** — commits stay local without a word | Sets the upstream to `origin/<branch>` |
| **Auth** (SSH key not loaded, expired token) | Diagnoses only: run `ssh-add`, refresh credentials, check with `mcs doctor` |
| **No git identity** — the commit itself fails | Diagnoses only: set `git config --global user.name` / `user.email` |

```
/resolve-memories [optional reason]
```

---

## 🔧 Troubleshooting

```bash
mcs pack validate .                                  # verify techpack.yaml + file refs
mcs doctor                                           # after sync: verify setup + remote access
git -C .claude/.memories-repo log -1 -- memories/    # confirm auto-push landed
```

**If the Stop hook silently refuses to push**, the naming guardrail is likely rejecting a file. Run:

```bash
git -C .claude/.memories-repo status -- memories/              # dirty files
git -C .claude/.memories-repo ls-files --others --exclude-standard -- memories/   # untracked
```

Anything not matching `memories/(learning|decision)_*.md` needs renaming — or run `/resolve-memories`.

**If SessionStart warns about lingering state**, the previous push hit one of the [blockers](#-conflicts-and-stuck-pushes). A network or auth issue clears on the next Stop once it's fixed (`mcs doctor` checks remote access); a rebase conflict or a misnamed file needs `/resolve-memories`.

---

## 🧪 Development

```bash
npm test                                             # unit, contract and behaviour suites
npm run typecheck                                    # tsc --noEmit (deps install ad hoc in CI)
```

TypeScript run directly by Node: no build step, no runtime dependencies, no lockfile. `tsconfig.json` sets `erasableSyntaxOnly`, so the syntax stays strippable — no `enum`, no `namespace`, no constructor parameter properties.

**`tests/golden/` is the behaviour contract.** Each file pins what the pack produces for one fixture: stdout, stderr, exit code, and the resulting repository state. The suite builds a throwaway project with a real git remote, installs the hooks, runs them through their shebang (pinned by `tests/manifest.test.ts` to the same command the manifest declares), and compares. A diff therefore means the pack's behaviour changed, not that a test went stale.

Fixtures carry an `expect` pattern asserted against the recording, so a fixture where nothing happens fails rather than passing vacuously. Machine- and day-dependent values — temp paths, hostname, dates, git's relative timestamps — are normalised; everything else is byte-exact.

CI runs on macOS across Node 22 and 24. Besides the typecheck and the suite it guards two things: the pack contains no shell at all, and the suite leaves the working tree clean.

To re-record after an intended behaviour change, run `UPDATE_GOLDENS=1 npm test` and review the diff of `tests/golden/` line by line: a recording is only as right as the behaviour it captured.

---

## 🔗 Links

- [MCS](https://github.com/mcs-cli/mcs) — the configuration engine
- [Creating Tech Packs](https://github.com/mcs-cli/mcs/blob/main/docs/creating-tech-packs.md) — guide for building your own
- [Tech Pack Schema](https://github.com/mcs-cli/mcs/blob/main/docs/techpack-schema.md) — full YAML reference
- [Claude Code hooks](https://docs.anthropic.com/en/docs/claude-code/hooks)
- [Git sparse-checkout](https://git-scm.com/docs/git-sparse-checkout)
- [Git partial clone](https://git-scm.com/docs/partial-clone)

---

## 📄 License

MIT
