import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { git, memory, readGolden, rejectAllPushes, runHook, writeGolden, type Fixture, type RunResult } from "./harness.ts";

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
	if (process.env["UPDATE_GOLDENS"] === "1") writeGolden(name, actual);
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

const pull: readonly Fixture[] = [
	{ name: "pull: clean tree", hook: "pull" },
	{
		name: "pull: an untracked memory reports lingering state",
		expect: /lingering state/,
		hook: "pull",
		setup: (repo) => memory(repo, "learning_pending_one.md"),
	},
	{
		name: "pull: two untracked memories pluralise the same way",
		hook: "pull",
		setup: (repo) => {
			memory(repo, "learning_pending_one.md");
			memory(repo, "learning_pending_two.md");
		},
	},
	{
		name: "pull: unpushed commit only",
		hook: "pull",
		setup: (repo) => {
			memory(repo, "learning_committed_x.md");
			git(repo, "add", "-A");
			git(repo, "commit", "-qm", "local only");
		},
	},
	{
		name: "pull: uncommitted and unpushed together",
		hook: "pull",
		setup: (repo) => {
			memory(repo, "learning_committed_x.md");
			git(repo, "add", "-A");
			git(repo, "commit", "-qm", "local only");
			memory(repo, "learning_dirty_y.md");
		},
	},
	{
		name: "pull: no upstream configured",
		expect: /no upstream branch/,
		hook: "pull",
		setup: (repo) => {
			git(repo, "branch", "--unset-upstream");
			memory(repo, "learning_pending_one.md");
		},
	},
	{
		name: "pull: missing checkout",
		hook: "pull",
		setup: (repo) => rmSync(repo, { recursive: true, force: true }),
	},
	{ name: "pull: malformed stdin", hook: "pull", stdin: "not json" },
	{
		name: "pull: empty stdin still does the work",
		hook: "pull",
		stdin: "",
		setup: (repo) => memory(repo, "learning_pending_one.md"),
	},
	{
		name: "pull: concatenated JSON stream is accepted",
		hook: "pull",
		stdin: '{"a":1} {"b":2}',
		setup: (repo) => memory(repo, "learning_pending_one.md"),
	},
];

describe("pull — behaviour is pinned", () => {
	for (const fx of pull) test(fx.name, () => assertParity(fx));
});

const commit = (repo: string, msg: string) => {
	git(repo, "add", "-A");
	git(repo, "commit", "-qm", msg);
};

const autopush: readonly Fixture[] = [
	{ name: "autopush: nothing pending", hook: "autopush" },
	{
		name: "autopush: commits and pushes a new memory",
		hook: "autopush",
		setup: (repo) => memory(repo, "learning_new_thing.md", "A brand new lesson.\n"),
	},
	{
		name: "autopush: pushes a modification",
		hook: "autopush",
		setup: (repo) => memory(repo, "learning_seed_topic.md", "Rewritten seed.\n"),
	},
	{
		name: "autopush: pushes a deletion",
		expect: /^$/,
		hook: "autopush",
		setup: (repo) => rmSync(join(repo, "memories", "learning_seed_topic.md")),
	},
	{
		name: "autopush: several changes are summarised, one line per file in the body",
		expect: /^$/,
		hook: "autopush",
		setup: (repo) => {
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
		setup: (repo) => memory(repo, "learning_new_thing.md"),
	},
	{
		name: "autopush: guardrail blocks a badly named file",
		expect: /^Shared memories: skipping auto-push — unconventional filename\(s\):\n  - memories\/scratch\.md$[\s\S]*\/resolve-memories/m,
		hook: "autopush",
		setup: (repo) => memory(repo, "scratch.md"),
	},
	{
		name: "autopush: guardrail lists several offenders",
		hook: "autopush",
		setup: (repo) => {
			memory(repo, "scratch.md");
			memory(repo, "wip notes.md");
			memory(repo, "learning_ok_one.md");
		},
	},
	{
		name: "autopush: unpushed commit only",
		hook: "autopush",
		setup: (repo) => {
			memory(repo, "learning_committed_x.md");
			commit(repo, "local only");
		},
	},
	{
		name: "autopush: no upstream configured",
		hook: "autopush",
		setup: (repo) => {
			git(repo, "branch", "--unset-upstream");
			memory(repo, "learning_new_thing.md");
		},
	},
	{
		name: "autopush: missing checkout",
		hook: "autopush",
		setup: (repo) => rmSync(repo, { recursive: true, force: true }),
	},
	{ name: "autopush: malformed stdin", hook: "autopush", stdin: "not json" },
	{
		name: "autopush: empty stdin still pushes",
		hook: "autopush",
		stdin: "",
		setup: (repo) => memory(repo, "learning_new_thing.md"),
	},
];

describe("autopush — behaviour is pinned", () => {
	for (const fx of autopush) test(fx.name, () => assertParity(fx));
});

/** A second clone that pushes first, so our push is rejected as non-fast-forward. */
const otherClonePushes = (repo: string, project: string, file: string, body: string) => {
	const work = dirname(project);
	const other = join(work, "other");
	git(work, "clone", "-q", join(work, "remote.git"), other);
	git(other, "config", "user.email", "o@example.com");
	git(other, "config", "user.name", "Other");
	writeFileSync(join(other, "memories", file), body);
	git(other, "add", "-A");
	git(other, "commit", "-qm", "from the other clone");
	git(other, "push", "-q");
};

const push: readonly Fixture[] = [
	{
		name: "push: a rejected push rebases and retries into success",
		expect: /^$/,
		hook: "autopush",
		setup: (repo, project) => {
			otherClonePushes(repo, project, "learning_theirs_one.md", "Theirs.\n");
			memory(repo, "learning_ours_one.md", "Ours.\n");
		},
	},
	{
		name: "push: a rebase conflict pauses and aborts",
		expect: /^Shared memories: auto-push paused — rebase conflict\. Run \/resolve-memories to merge it\.$/m,
		hook: "autopush",
		setup: (repo, project) => {
			otherClonePushes(repo, project, "learning_seed_topic.md", "Their version of the seed.\n");
			memory(repo, "learning_seed_topic.md", "Our version of the seed.\n");
			commit(repo, "our conflicting edit");
		},
	},
	{
		name: "push: an unreachable remote reports auth or network",
		expect: /^Shared memories: pull --rebase failed \(likely auth or network\)\. Will retry on next Stop\.$/m,
		hook: "autopush",
		setup: (repo) => {
			memory(repo, "learning_ours_one.md", "Ours.\n");
			commit(repo, "local only");
			git(repo, "remote", "set-url", "origin", "/nonexistent/definitely-not-here.git");
		},
	},
	{
		name: "push: a zero attempt budget still tries once",
		hook: "autopush",
		env: { MEMORIES_PUSH_ATTEMPTS: "0" },
		setup: (repo, project) => {
			otherClonePushes(repo, project, "learning_theirs_one.md", "Theirs.\n");
			memory(repo, "learning_ours_one.md", "Ours.\n");
		},
	},
	{
		name: "push: a non-integer attempt budget falls back to the default",
		hook: "autopush",
		env: { MEMORIES_PUSH_ATTEMPTS: "banana" },
		setup: (repo, project) => {
			otherClonePushes(repo, project, "learning_theirs_one.md", "Theirs.\n");
			memory(repo, "learning_ours_one.md", "Ours.\n");
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
		setup: (repo) => {
			withDirtyRootFile(repo);
			memory(repo, "learning_new_thing.md", "A lesson.\n");
		},
	},
	{
		name: "pathspec: a dirty root file does not trip the filename guardrail",
		hook: "autopush",
		setup: (repo) => withDirtyRootFile(repo),
	},
	{
		name: "pathspec: SessionStart does not count a dirty root file as pending",
		hook: "pull",
		setup: (repo) => withDirtyRootFile(repo),
	},
];

describe("pathspec scoping — behaviour is pinned", () => {
	for (const fx of pathspec) test(fx.name, () => assertParity(fx));
});

/** A teammate pushes while we are away; SessionStart is what brings it down. */
const teammatePushes = (repo: string, project: string, file: string) => {
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
		setup: (repo, project) => teammatePushes(repo, project, "learning_theirs_new.md"),
	},
	{
		name: "incoming: a fast-forward alongside our own untracked memory",
		hook: "pull",
		setup: (repo, project) => {
			teammatePushes(repo, project, "learning_theirs_new.md");
			memory(repo, "learning_ours_pending.md", "Ours, not yet pushed.\n");
		},
	},
	{
		name: "incoming: SessionStart does not fast-forward past a conflicting local commit",
		hook: "pull",
		setup: (repo, project) => {
			teammatePushes(repo, project, "learning_theirs_new.md");
			memory(repo, "learning_ours_own.md", "Ours.\n");
			commit(repo, "our local commit");
		},
	},
	{
		name: "incoming: the Stop hook rebases onto a teammate's commit",
		hook: "autopush",
		setup: (repo, project) => {
			teammatePushes(repo, project, "learning_theirs_new.md");
			memory(repo, "learning_ours_own.md", "Ours.\n");
		},
	},
];

describe("incoming memories — behaviour is pinned", () => {
	for (const fx of incoming) test(fx.name, () => assertParity(fx));
});

/** Our edit conflicts with a teammate's, and the rebase is left mid-way with the file unmerged. */
const rebaseLeftInProgress = (repo: string, project: string) => {
	otherClonePushes(repo, project, "learning_seed_topic.md", "Their version of the seed.\n");
	memory(repo, "learning_seed_topic.md", "Our version of the seed.\n");
	commit(repo, "our conflicting edit");
	git(repo, "pull", "--rebase", "-q");
	memory(repo, "learning_new_thing.md", "Written while the rebase was stuck.\n");
};

const edges: readonly Fixture[] = [
	{
		name: "edge: a locked index aborts the turn instead of reporting nothing",
		abortsDiffer: true,
		expect: /Unable to create .*index\.lock/,
		hook: "autopush",
		setup: (repo) => {
			memory(repo, "learning_new_thing.md", "A lesson.\n");
			writeFileSync(join(repo, ".git", "index.lock"), "");
		},
	},
	{
		name: "edge: a staged rename is committed and pushed",
		expect: /^$/,
		hook: "autopush",
		setup: (repo) => git(repo, "mv", "memories/learning_seed_topic.md", "memories/learning_seed_renamed.md"),
	},
	{
		name: "edge: a detached HEAD with an unpushed commit stays silent",
		hook: "autopush",
		setup: (repo) => {
			memory(repo, "learning_x_y.md");
			commit(repo, "local");
			git(repo, "checkout", "-q", "--detach");
		},
	},
	{
		name: "edge: a typechange to a symlink is committed and pushed",
		hook: "autopush",
		setup: (repo) => {
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
		setup: (repo) => {
			git(repo, "config", "--unset", "user.email");
			git(repo, "config", "--unset", "user.name");
			memory(repo, "learning_x_y.md");
		},
	},
	{
		name: "edge: SessionStart survives a failed fast-forward",
		expect: /lingering state/,
		hook: "pull",
		setup: (repo, project) => {
			teammatePushes(repo, project, "learning_theirs_a.md");
			memory(repo, "learning_ours_b.md");
			commit(repo, "ours");
		},
	},
	{
		name: "edge: a badly named DELETED file trips the guardrail",
		expect: /unconventional filename\(s\):\n  - memories\/scratch\.md/,
		hook: "autopush",
		setup: (repo) => {
			writeFileSync(join(repo, "memories", "scratch.md"), "x\n");
			commit(repo, "add scratch");
			git(repo, "push", "-q");
			rmSync(join(repo, "memories", "scratch.md"));
		},
	},
	{
		name: "edge: changes already staged in the index still commit",
		hook: "autopush",
		setup: (repo) => {
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
		expect: /^Shared memories: a rebase is in progress in \.claude\/\.memories-repo — auto-push paused\. Run \/resolve-memories to finish it\.$/m,
		hook: "autopush",
		setup: rebaseLeftInProgress,
	},
	{
		name: "edge: a rebase left in progress is flagged at SessionStart",
		expect: /a rebase is in progress[^"]*\/resolve-memories/,
		hook: "pull",
		setup: rebaseLeftInProgress,
	},
];

describe("audited edges — behaviour is pinned", () => {
	for (const fx of edges) test(fx.name, () => assertParity(fx));
});

/**
 * Asserted directly rather than pinned to a golden, and deliberately so.
 *
 * Every golden in this directory is a recording of the bash, and the bash is
 * gone, so a hand-written file here would claim to be a recording it is not.
 * The more durable reason is what a golden would add over these assertions:
 * git's own error prose for a broken pushurl, byte for byte. Five goldens
 * already quote git's English and that is this suite's known fragility --
 * a translated or reworded git breaks them. Not a property worth extending
 * to a sixth for a branch whose contract is an exit code.
 */
describe("push failures are classified by exit code, not message text", () => {
	test("a broken pushurl reaches the non-rejection branch", () => {
		const r = runHook({
			name: "internal: a broken pushurl is not a rejected update",
			hook: "autopush",
			setup: (repo) => {
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
