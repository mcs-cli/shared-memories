import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { probe } from "../runtime/lib/git.mts";
import {
  commit,
  dropUnionRule,
  type Fixture,
  git,
  memory,
  type RunResult,
  readGolden,
  rejectAllPushes,
  runHook,
  writeGolden,
} from "./harness.ts";

/**
 * Behaviour is pinned to tests/golden/. The goldens were first recorded from the
 * bash implementation this pack replaced, and re-recorded from the TypeScript
 * when the auto-push modes were removed, every diff reviewed by hand. A drift
 * here is a change in what the pack does, not a stale test.
 *
 * `UPDATE_GOLDENS=1 npm test` re-records instead of asserting. Review the diff:
 * the recording is only as right as the behaviour it captured.
 */
const ABORT = /^\w+: aborted.*$/m;

function check(name: string, actual: RunResult, expect?: RegExp, abortsDiffer = false): void {
  if (process.env.UPDATE_GOLDENS === "1") writeGolden(name, actual);
  const golden = readGolden(name);
  assert.ok(golden, `no golden recorded for "${name}"`);
  assert.equal(actual.stdout, golden.stdout, `stdout drifted from recorded behaviour for "${name}"`);
  assert.equal(actual.code, golden.code, `exit code drifted for "${name}"`);
  if (abortsDiffer) {
    assert.match(golden.stderr, ABORT, `"${name}" claims an abort deviation the recording does not show`);
    assert.match(actual.stderr, ABORT, `"${name}" should still report the abort`);
    assert.equal(actual.stderr.replace(ABORT, ""), golden.stderr.replace(ABORT, ""), `stderr drifted outside the abort line for "${name}"`);
  } else {
    assert.equal(actual.stderr, golden.stderr, `stderr drifted from recorded behaviour for "${name}"`);
  }
  assert.equal(actual.git, golden.git, `resulting state drifted for "${name}"\ngolden:\n${golden.git}\n\nactual:\n${actual.git}`);
  // A fixture where nothing happens passes vacuously, so pin what was recorded.
  if (expect) assert.match(golden.stdout + golden.stderr, expect, `fixture "${name}" never exercised what it claims to`);
}

function assertParity(fx: Fixture): void {
  check(fx.name, runHook(fx), fx.expect, fx.abortsDiffer);
}

const status: readonly Fixture[] = [
  { name: "status: clean tree", hook: "status" },
  {
    name: "status: an untracked memory reports lingering state",
    expect: /lingering state/,
    hook: "status",
    setup: repo => memory(repo, "learning_pending_one.md"),
  },
  {
    name: "status: two untracked memories pluralise the same way",
    hook: "status",
    setup: repo => {
      memory(repo, "learning_pending_one.md");
      memory(repo, "learning_pending_two.md");
    },
  },
  {
    name: "status: unpushed commit only",
    hook: "status",
    setup: repo => {
      memory(repo, "learning_committed_x.md");
      git(repo, "add", "-A");
      git(repo, "commit", "-qm", "local only");
    },
  },
  {
    name: "status: uncommitted and unpushed together",
    hook: "status",
    setup: repo => {
      memory(repo, "learning_committed_x.md");
      git(repo, "add", "-A");
      git(repo, "commit", "-qm", "local only");
      memory(repo, "learning_dirty_y.md");
    },
  },
  {
    name: "status: no upstream configured",
    expect: /no upstream branch/,
    hook: "status",
    setup: repo => {
      git(repo, "branch", "--unset-upstream");
      memory(repo, "learning_pending_one.md");
    },
  },
  {
    name: "status: missing checkout",
    hook: "status",
    setup: repo => rmSync(repo, { recursive: true, force: true }),
  },
  { name: "status: malformed stdin", hook: "status", stdin: "not json" },
  {
    name: "status: empty stdin still does the work",
    hook: "status",
    stdin: "",
    setup: repo => memory(repo, "learning_pending_one.md"),
  },
  {
    name: "status: concatenated JSON stream is accepted",
    hook: "status",
    stdin: '{"a":1} {"b":2}',
    setup: repo => memory(repo, "learning_pending_one.md"),
  },
];

describe("status — behaviour is pinned", () => {
  for (const fx of status) test(fx.name, () => assertParity(fx));
});

const autopush: readonly Fixture[] = [
  { name: "autopush: nothing pending", hook: "autopush" },
  {
    name: "autopush: commits and pushes a new memory",
    hook: "autopush",
    setup: repo => memory(repo, "learning_new_thing.md", "A brand new lesson.\n"),
  },
  {
    name: "autopush: pushes a modification",
    hook: "autopush",
    setup: repo => memory(repo, "learning_seed_topic.md", "Rewritten seed.\n"),
  },
  {
    name: "autopush: pushes a deletion",
    expect: /^$/,
    hook: "autopush",
    setup: repo => rmSync(join(repo, "memories", "learning_seed_topic.md")),
  },
  {
    name: "autopush: several changes are summarised, one line per file in the body",
    expect: /^$/,
    hook: "autopush",
    setup: repo => {
      memory(repo, "learning_extra_topic.md", "Second seed.\n");
      commit(repo, "second seed");
      git(repo, "push", "-q");
      memory(repo, "learning_new_one.md");
      memory(repo, "decision_new_two.md");
      memory(repo, "learning_seed_topic.md", "Rewritten seed.\n");
      rmSync(join(repo, "memories", "learning_extra_topic.md"));
    },
  },
  {
    name: "autopush: the subject names the git author, not the machine",
    hook: "autopush",
    env: { GIT_AUTHOR_NAME: "Someone Else" },
    setup: repo => memory(repo, "learning_new_thing.md"),
  },
  {
    name: "autopush: guardrail blocks a badly named file",
    expect: /^Shared memories: skipping auto-push — unconventional filename\(s\):\n {2}- memories\/scratch\.md$[\s\S]*\/resolve-memories/m,
    hook: "autopush",
    setup: repo => memory(repo, "scratch.md"),
  },
  {
    name: "autopush: guardrail lists several offenders",
    hook: "autopush",
    setup: repo => {
      memory(repo, "scratch.md");
      memory(repo, "wip notes.md");
      memory(repo, "learning_ok_one.md");
    },
  },
  {
    name: "autopush: unpushed commit only",
    hook: "autopush",
    setup: repo => {
      memory(repo, "learning_committed_x.md");
      commit(repo, "local only");
    },
  },
  {
    name: "autopush: no upstream configured",
    hook: "autopush",
    setup: repo => {
      git(repo, "branch", "--unset-upstream");
      memory(repo, "learning_new_thing.md");
    },
  },
  {
    name: "autopush: missing checkout",
    hook: "autopush",
    setup: repo => rmSync(repo, { recursive: true, force: true }),
  },
  { name: "autopush: malformed stdin", hook: "autopush", stdin: "not json" },
  {
    name: "autopush: empty stdin still pushes",
    hook: "autopush",
    stdin: "",
    setup: repo => memory(repo, "learning_new_thing.md"),
  },
];

describe("autopush — behaviour is pinned", () => {
  for (const fx of autopush) test(fx.name, () => assertParity(fx));
});

/** A second clone that pushes first, so our push is rejected as non-fast-forward. */
const otherClonePushes = (project: string, file: string, body: string, more: Readonly<Record<string, string>> = {}) => {
  const work = dirname(project);
  const other = join(work, "other");
  git(work, "clone", "-q", join(work, "remote.git"), other);
  git(other, "config", "user.email", "o@example.com");
  git(other, "config", "user.name", "Other");
  for (const [f, b] of Object.entries({ [file]: body, ...more })) writeFileSync(join(other, "memories", f), b);
  git(other, "add", "-A");
  git(other, "commit", "-qm", "from the other clone");
  git(other, "push", "-q");
};

/** A teammate pushed an edit to the seed memory, and we committed a different one. */
const conflictingEdit = (repo: string, project: string) => {
  otherClonePushes(project, "learning_seed_topic.md", "Their version of the seed.\n");
  memory(repo, "learning_seed_topic.md", "Our version of the seed.\n");
  commit(repo, "our conflicting edit");
};

const push: readonly Fixture[] = [
  {
    name: "push: a rebase conflict pauses and aborts",
    expect: /^Shared memories: auto-push paused — rebase conflict\. Run \/resolve-memories to merge it\.$/m,
    hook: "autopush",
    setup: conflictingEdit,
  },
  {
    name: "push: an unreachable remote reports auth or network",
    expect: /^Shared memories: pull --rebase failed \(likely auth or network\)\. Will retry on next Stop\.$/m,
    hook: "autopush",
    setup: repo => {
      memory(repo, "learning_ours_one.md", "Ours.\n");
      commit(repo, "local only");
      git(repo, "remote", "set-url", "origin", "/nonexistent/definitely-not-here.git");
    },
  },
];

describe("push loop — behaviour is pinned", () => {
  for (const fx of push) test(fx.name, () => assertParity(fx));
});

/** A remote that rejects every push, so the retry budget is spent rather than skipped. */
const budgetFixture = (name: string, attempts: string | undefined, expect: RegExp): Fixture => ({
  name,
  expect,
  hook: "autopush",
  ...(attempts === undefined ? {} : { env: { MEMORIES_PUSH_ATTEMPTS: attempts } }),
  setup: (repo, project) => {
    memory(repo, "learning_ours_one.md", "Ours.\n");
    commit(repo, "local only");
    rejectAllPushes(join(dirname(project), "remote.git"));
  },
});

const budgets: readonly Fixture[] = [
  budgetFixture("budget: zero is clamped to a single attempt", "0", /auto-push failed after 1 attempt\(s\)/),
  budgetFixture("budget: an explicit small budget is honoured", "3", /auto-push failed after 3 attempt\(s\)/),
  budgetFixture("budget: a non-integer falls back to twelve", "banana", /auto-push failed after 12 attempt\(s\)/),
  budgetFixture("budget: unset falls back to twelve", undefined, /auto-push failed after 12 attempt\(s\)/),
];

describe("retry budget — behaviour is pinned", () => {
  for (const fx of budgets) test(fx.name, () => assertParity(fx));
});

/** The shared repo ships root-level files (README, LICENSE). Every git call is
 *  scoped with `-- memories/` so they are visible but never swept into a commit. */
const withDirtyRootFile = (repo: string) => {
  writeFileSync(join(repo, "README.md"), "Shared memories repo.\n");
  commit(repo, "add a root README");
  git(repo, "push", "-q");
  writeFileSync(join(repo, "README.md"), "Edited by a teammate.\n");
};

const pathspec: readonly Fixture[] = [
  {
    name: "pathspec: a dirty root file stays uncommitted",
    expect: /^$/,
    hook: "autopush",
    setup: repo => {
      withDirtyRootFile(repo);
      memory(repo, "learning_new_thing.md", "A lesson.\n");
    },
  },
  {
    name: "pathspec: a dirty root file does not trip the filename guardrail",
    hook: "autopush",
    setup: repo => withDirtyRootFile(repo),
  },
  {
    name: "pathspec: SessionStart does not count a dirty root file as pending",
    hook: "status",
    setup: repo => withDirtyRootFile(repo),
  },
];

describe("pathspec scoping — behaviour is pinned", () => {
  for (const fx of pathspec) test(fx.name, () => assertParity(fx));
});

/** A teammate pushes while we are away; SessionStart is what brings it down. */
const teammatePushes = (project: string, file: string) => {
  const work = dirname(project);
  const other = join(work, "other");
  git(work, "clone", "-q", join(work, "remote.git"), other);
  git(other, "config", "user.email", "o@example.com");
  git(other, "config", "user.name", "Other");
  writeFileSync(join(other, "memories", file), "From a teammate.\n");
  git(other, "add", "-A");
  git(other, "commit", "-qm", "teammate memory");
  git(other, "push", "-q");
};

const incoming: readonly Fixture[] = [
  {
    name: "incoming: SessionStart fast-forwards a teammate's memory",
    hook: "pull",
    setup: (_repo, project) => teammatePushes(project, "learning_theirs_new.md"),
  },
  {
    name: "incoming: a fast-forward alongside our own untracked memory",
    hook: "pull",
    setup: (repo, project) => {
      teammatePushes(project, "learning_theirs_new.md");
      memory(repo, "learning_ours_pending.md", "Ours, not yet pushed.\n");
    },
  },
  {
    name: "incoming: the Stop hook rebases onto a teammate's commit",
    hook: "autopush",
    setup: (repo, project) => {
      teammatePushes(project, "learning_theirs_new.md");
      memory(repo, "learning_ours_own.md", "Ours.\n");
    },
  },
];

describe("incoming memories — behaviour is pinned", () => {
  for (const fx of incoming) test(fx.name, () => assertParity(fx));
});

/** Our edit conflicts with a teammate's, and the rebase is left mid-way with the file unmerged. */
const rebaseLeftInProgress = (repo: string, project: string) => {
  conflictingEdit(repo, project);
  git(repo, "pull", "--rebase", "-q");
  memory(repo, "learning_new_thing.md", "Written while the rebase was stuck.\n");
};

/** Runs `cmd` once the rebase has started, so the pick fails with no conflict to report. */
const failMidRebase = (repo: string, cmd: string) => {
  const hook = join(repo, ".git", "hooks", "post-checkout");
  writeFileSync(hook, `#!/bin/sh\n[ -e .git/rebase-merge ] && ${cmd}\nexit 0\n`);
  chmodSync(hook, 0o755);
};

const edges: readonly Fixture[] = [
  {
    name: "edge: a locked index aborts the turn instead of reporting nothing",
    abortsDiffer: true,
    expect: /Unable to create .*index\.lock/,
    hook: "autopush",
    setup: repo => {
      memory(repo, "learning_new_thing.md", "A lesson.\n");
      writeFileSync(join(repo, ".git", "index.lock"), "");
    },
  },
  {
    name: "edge: a staged rename is committed and pushed",
    expect: /^$/,
    hook: "autopush",
    setup: repo => git(repo, "mv", "memories/learning_seed_topic.md", "memories/learning_seed_renamed.md"),
  },
  {
    name: "edge: a detached HEAD with an unpushed commit stays silent",
    hook: "autopush",
    setup: repo => {
      memory(repo, "learning_x_y.md");
      commit(repo, "local");
      git(repo, "checkout", "-q", "--detach");
    },
  },
  {
    name: "edge: a typechange to a symlink is committed and pushed",
    hook: "autopush",
    setup: repo => {
      const p = join(repo, "memories", "learning_seed_topic.md");
      rmSync(p);
      symlinkSync("/etc/hostname", p);
    },
  },
  {
    name: "edge: a commit failure is reported and retried next Stop",
    expect: /Shared memories: commit failed; will retry on next Stop\./,
    hook: "autopush",
    env: {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "",
      GIT_COMMITTER_NAME: "",
    },
    setup: repo => {
      git(repo, "config", "--unset", "user.email");
      git(repo, "config", "--unset", "user.name");
      memory(repo, "learning_x_y.md");
    },
  },
  {
    name: "edge: the background pull survives a failed fast-forward",
    hook: "pull",
    setup: (repo, project) => {
      teammatePushes(project, "learning_theirs_a.md");
      memory(repo, "learning_ours_b.md");
      commit(repo, "ours");
    },
  },
  {
    name: "edge: a badly named DELETED file trips the guardrail",
    expect: /unconventional filename\(s\):\n {2}- memories\/scratch\.md/,
    hook: "autopush",
    setup: repo => {
      writeFileSync(join(repo, "memories", "scratch.md"), "x\n");
      commit(repo, "add scratch");
      git(repo, "push", "-q");
      rmSync(join(repo, "memories", "scratch.md"));
    },
  },
  {
    name: "edge: changes already staged in the index still commit",
    hook: "autopush",
    setup: repo => {
      memory(repo, "learning_x_y.md");
      git(repo, "add", "-A");
    },
  },
  {
    name: "edge: a dangling memories symlink does not stop the push",
    hook: "autopush",
    setup: (repo, project) => {
      rmSync(join(project, ".claude", "memories"));
      symlinkSync(".memories-repo/nope", join(project, ".claude", "memories"));
      memory(repo, "learning_x_y.md");
    },
  },
  {
    name: "edge: a rebase left in progress pauses the Stop hook",
    expect:
      /^Shared memories: a rebase is in progress in \.claude\/\.memories-repo — auto-push paused\. Run \/resolve-memories to finish it\.$/m,
    hook: "autopush",
    setup: rebaseLeftInProgress,
  },
  {
    name: "edge: a rebase left in progress is flagged at SessionStart",
    expect: /a rebase is in progress[^"]*\/resolve-memories/,
    hook: "status",
    setup: rebaseLeftInProgress,
  },
  {
    name: "edge: a pull that fails mid-rebase without a conflict is rolled back",
    expect: /^Shared memories: pull --rebase failed partway and was rolled back\. Will retry on next Stop\.$/m,
    hook: "autopush",
    setup: (repo, project) => {
      teammatePushes(project, "learning_theirs_new.md");
      memory(repo, "learning_ours_own.md", "Ours.\n");
      // Picking our commit has to write a new tree; the abort only reads.
      failMidRebase(repo, "chmod -R a-w .git/objects");
    },
    inspect: repo => {
      execFileSync("chmod", ["-R", "u+w", join(repo, ".git", "objects")]);
      assert.equal(probe(repo), null, "the rebase was left behind");
    },
  },
  {
    name: "edge: a commit-graph failure names mcs sync instead of a retry",
    expect: /commit-graph\. Run `mcs sync` to turn it off/,
    hook: "autopush",
    setup: (repo, project) => {
      teammatePushes(project, "learning_theirs_new.md");
      memory(repo, "learning_ours_own.md", "Ours.\n");
      // git's wording from a blobless clone on 2.50; no current git reproduces the failure itself.
      failMidRebase(
        repo,
        "echo 'fatal: commit 0123abc exists in commit-graph but not in the object database' >&2; chmod -R a-w .git/objects",
      );
    },
    inspect: repo => execFileSync("chmod", ["-R", "u+w", join(repo, ".git", "objects")]),
  },
  {
    name: "edge: a mid-rebase failure whose abort also fails pauses for resolve",
    expect: /^Shared memories: the rebase failed AND --abort failed .* Run \/resolve-memories to finish it\.$/m,
    hook: "autopush",
    setup: (repo, project) => {
      teammatePushes(project, "learning_theirs_new.md");
      memory(repo, "learning_ours_own.md", "Ours.\n");
      // An untracked file where our commit adds one blocks both the pick and the reset back.
      failMidRebase(repo, "echo stray > memories/learning_ours_own.md");
    },
  },
];

describe("audited edges — behaviour is pinned", () => {
  for (const fx of edges) test(fx.name, () => assertParity(fx));
});

const USAGE_SEED = "# since: 2026-10-01\nlearning_seed_topic.md\t2026-10-01\nlearning_seed_topic.md\t2026-10-02\n";

const usageFile = (repo: string): string => join(repo, "memories", ".usage.tsv");

/** Committed and pushed before anyone diverges, so both sides share it as the base. */
const seedUsage = (repo: string): void => {
  writeFileSync(usageFile(repo), USAGE_SEED);
  commit(repo, "seed usage");
  git(repo, "push", "-q");
};

/** A teammate pushes `theirs` as the usage file, then we leave `ours` dirty for the Stop hook. */
const divergingUsage =
  (theirs: string, ours: string, unionRule: boolean) =>
  (repo: string, project: string): void => {
    seedUsage(repo);
    otherClonePushes(project, ".usage.tsv", theirs);
    writeFileSync(usageFile(repo), ours);
    if (!unionRule) dropUnionRule(repo);
  };

/** Union semantics: every row either side wrote survives, and no marker leaks into the file. */
const keepsEveryLine =
  (...sides: string[]) =>
  (repo: string): void => {
    const merged = readFileSync(usageFile(repo), "utf8").split("\n");
    for (const line of sides.flatMap(t => t.split("\n")).filter(Boolean)) {
      assert.ok(merged.includes(line), `merged usage file lost ${JSON.stringify(line)}`);
    }
    assert.ok(!merged.some(l => /^(<{7}|\|{7}|={7}|>{7})/.test(l)), "conflict markers leaked into the usage file");
    assert.equal(git(repo, "rev-list", "@{u}..HEAD", "--count"), "0", "the merge was pushed");
  };

const APPENDED_THEIRS = `${USAGE_SEED}learning_theirs_one.md\t2026-10-03\n`;
const APPENDED_OURS = `${USAGE_SEED}learning_ours_one.md\t2026-10-04\n`;
const COMPACTED_THEIRS = "# since: 2026-10-01\nlearning_seed_topic.md\t2026-10-02\nlearning_theirs_one.md\t2026-10-03\n";
const EDITED_THEIRS = "# since: 2026-10-01\nlearning_seed_topic.md\t2026-10-05\nlearning_seed_topic.md\t2026-10-02\n";
const EDITED_OURS = "# since: 2026-10-01\nlearning_seed_topic.md\t2026-10-06\nlearning_seed_topic.md\t2026-10-02\n";

/** Each scenario runs twice: merged by the union rule, and by the Stop hook's fallback without it. */
const USAGE_SCENARIOS = [
  { clean: "appends on both sides merge", fallback: "appends on both sides are merged", theirs: APPENDED_THEIRS, ours: APPENDED_OURS },
  {
    clean: "a compaction against an append merges",
    fallback: "a compaction against an append is merged",
    theirs: COMPACTED_THEIRS,
    ours: APPENDED_OURS,
  },
  {
    clean: "in-place edits on both sides merge",
    fallback: "in-place edits on both sides are merged",
    theirs: EDITED_THEIRS,
    ours: EDITED_OURS,
  },
] as const;

// The seed rows a compaction rewrote are the one thing a union need not keep.
const newRows = (ours: string): string => (ours.startsWith(USAGE_SEED) ? ours.slice(USAGE_SEED.length) : ours);

const usage: readonly Fixture[] = [
  ...USAGE_SCENARIOS.flatMap(({ clean, fallback, theirs, ours }): Fixture[] => [
    {
      name: `usage: ${clean} cleanly under the union rule`,
      expect: /^$/,
      hook: "autopush",
      setup: divergingUsage(theirs, ours, true),
      inspect: keepsEveryLine(theirs, newRows(ours)),
    },
    {
      name: `usage: ${fallback} by the fallback without the union rule`,
      expect: /^$/,
      hook: "autopush",
      setup: divergingUsage(theirs, ours, false),
      inspect: keepsEveryLine(theirs, newRows(ours)),
    },
  ]),
  {
    name: "usage: a dirty usage file alone is committed as usage, not as a memory edit",
    expect: /^$/,
    hook: "autopush",
    setup: repo => writeFileSync(usageFile(repo), "# since: 2026-10-01\nlearning_seed_topic.md\t2026-10-01\n"),
  },
  {
    name: "usage: a usage file changed with a memory leaves the subject to the memory",
    expect: /^$/,
    hook: "autopush",
    setup: repo => {
      writeFileSync(usageFile(repo), "# since: 2026-10-01\nlearning_seed_topic.md\t2026-10-01\n");
      memory(repo, "learning_new_thing.md", "A brand new lesson.\n");
    },
  },
  {
    name: "usage: a dirty usage file beside a badly named one blocks on the bad name only",
    expect: /unconventional filename\(s\):\n {2}- memories\/scratch\.md\nRename/,
    hook: "autopush",
    setup: repo => {
      writeFileSync(usageFile(repo), "# since: 2026-10-01\n");
      memory(repo, "scratch.md");
    },
  },
  {
    // Base rows survive too; they are older dates, which readers already outrank.
    name: "usage: a diff3-style conflict loses its base marker and keeps its base rows",
    expect: /^$/,
    hook: "autopush",
    setup: (repo, project) => {
      divergingUsage(EDITED_THEIRS, EDITED_OURS, false)(repo, project);
      git(repo, "config", "merge.conflictStyle", "diff3");
    },
    inspect: keepsEveryLine(USAGE_SEED, EDITED_THEIRS, EDITED_OURS),
  },
  {
    name: "usage: a dirty usage file alone is not lingering state at SessionStart",
    expect: /^$/,
    hook: "status",
    setup: repo => writeFileSync(usageFile(repo), `${USAGE_SEED}learning_seed_topic.md\t2026-10-03\n`),
  },
  {
    name: "usage: SessionStart fast-forwards a teammate's usage rows over our dirty ones",
    expect: /^$/,
    hook: "pull",
    setup: divergingUsage(APPENDED_THEIRS, APPENDED_OURS, true),
    inspect: repo => {
      assert.equal(git(repo, "rev-parse", "HEAD"), git(repo, "rev-parse", "origin/main"), "the teammate's commit was pulled");
      const merged = readFileSync(usageFile(repo), "utf8").split("\n");
      for (const row of ["learning_theirs_one.md\t2026-10-03", "learning_ours_one.md\t2026-10-04"]) {
        assert.ok(merged.includes(row), `lost ${JSON.stringify(row)}`);
      }
      assert.equal(git(repo, "stash", "list"), "", "nothing stranded in the stash");
    },
  },
  {
    name: "usage: a memory conflicting beside the usage file still pauses",
    expect: /^Shared memories: auto-push paused — rebase conflict\. Run \/resolve-memories to merge it\.$/m,
    hook: "autopush",
    setup: (repo, project) => {
      seedUsage(repo);
      otherClonePushes(project, ".usage.tsv", EDITED_THEIRS, { "learning_seed_topic.md": "Their version of the seed.\n" });
      writeFileSync(usageFile(repo), EDITED_OURS);
      memory(repo, "learning_seed_topic.md", "Our version of the seed.\n");
      dropUnionRule(repo);
    },
  },
];

describe("the usage file — behaviour is pinned", () => {
  for (const fx of usage) test(fx.name, () => assertParity(fx));

  // Without this the fallback fixtures would pass just as well if git never conflicted.
  test("every scenario the fallback covers really conflicts without the union rule", () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-usage-"));
    try {
      for (const { theirs, ours } of USAGE_SCENARIOS) {
        writeFileSync(join(dir, "base"), USAGE_SEED);
        writeFileSync(join(dir, "theirs"), theirs);
        writeFileSync(join(dir, "ours"), ours);
        const r = spawnSync("git", ["merge-file", "-p", "ours", "base", "theirs"], { cwd: dir, encoding: "utf8" });
        assert.ok((r.status ?? 0) > 0, `no conflict between ${JSON.stringify(ours)} and ${JSON.stringify(theirs)}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Asserted directly rather than pinned to a golden, and deliberately so.
 *
 * What a golden would add over these assertions is git's own error prose for a
 * broken pushurl, byte for byte. Several goldens already quote git's English and
 * that is this suite's known fragility -- a translated or reworded git breaks
 * them. Not a property worth extending for a branch whose contract is an exit code.
 */
describe("push failures are classified by exit code, not message text", () => {
  test("a broken pushurl reaches the non-rejection branch", () => {
    const r = runHook({
      name: "internal: a broken pushurl is not a rejected update",
      hook: "autopush",
      setup: repo => {
        // A valid fetch url with a broken pushurl: `pull --rebase` one line
        // earlier still exits 0, so the loop reaches the push, and the push
        // exits 128 rather than the 1 that means the remote rejected it.
        git(repo, "config", "remote.origin.pushurl", "/nonexistent/remote.git");
        memory(repo, "learning_new_thing.md", "A lesson.\n");
      },
    });
    assert.match(r.stdout, /auto-push failed \(not a rejected update/);
    assert.doesNotMatch(r.stdout, /after \d+ attempt/, "a non-rejection must not spend the retry budget");
    assert.equal(r.code, 0);
  });
});
