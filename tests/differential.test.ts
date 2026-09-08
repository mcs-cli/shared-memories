import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { git, memory, readGolden, rejectAllPushes, runHook, type Fixture, type RunResult } from "./harness.ts";


/**
 * Behaviour is pinned to tests/golden/, recorded from the bash implementation
 * this pack replaced and verified against it fixture by fixture before the bash
 * was removed. A drift here is a change in what the pack does, not a stale test.
 */
const ABORT = /^\w+: aborted.*$/m;

function check(name: string, actual: RunResult, expect?: RegExp, abortsDiffer = false): void {
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

const announce: readonly Fixture[] = [
	{
		name: "announce: review mode, well-named memory write",
		expect: /"hookEventName": "PostToolUse"/,
		hook: "announce",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
		stdin: JSON.stringify({ tool_input: { file_path: "/p/.claude/memories/learning_a_b.md" } }),
	},
	{
		name: "announce: auto mode is silent",
		hook: "announce",
		env: { MEMORIES_AUTOPUSH_MODE: "auto" },
		stdin: JSON.stringify({ tool_input: { file_path: "/p/.claude/memories/learning_a_b.md" } }),
	},
	{
		name: "announce: unset mode is silent",
		hook: "announce",
		stdin: JSON.stringify({ tool_input: { file_path: "/p/.claude/memories/learning_a_b.md" } }),
	},
	{
		name: "announce: unknown mode is silent",
		hook: "announce",
		env: { MEMORIES_AUTOPUSH_MODE: "banana" },
		stdin: JSON.stringify({ tool_input: { file_path: "/p/.claude/memories/learning_a_b.md" } }),
	},
	{
		name: "announce: decision_ prefix also matches",
		hook: "announce",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
		stdin: JSON.stringify({ tool_input: { file_path: "/p/.claude/memories/decision_x_y.md" } }),
	},
	{
		name: "announce: name with a space is rejected",
		hook: "announce",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
		stdin: JSON.stringify({ tool_input: { file_path: "/p/.claude/memories/learning_foo bar.md" } }),
	},
	{
		name: "announce: path outside .claude/memories is rejected",
		hook: "announce",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
		stdin: JSON.stringify({ tool_input: { file_path: "/p/notes/learning_a_b.md" } }),
	},
	{
		name: "announce: nested prefix path still matches",
		hook: "announce",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
		stdin: JSON.stringify({ tool_input: { file_path: "/deep/nest/.claude/memories/learning_a_b.md" } }),
	},
	{
		name: "announce: wrong prefix is rejected",
		hook: "announce",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
		stdin: JSON.stringify({ tool_input: { file_path: "/p/.claude/memories/scratch_a_b.md" } }),
	},
	{
		name: "announce: non-md extension is rejected",
		hook: "announce",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
		stdin: JSON.stringify({ tool_input: { file_path: "/p/.claude/memories/learning_a_b.txt" } }),
	},
	{
		name: "announce: missing file_path",
		hook: "announce",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
		stdin: JSON.stringify({ tool_input: {} }),
	},
	{
		name: "announce: non-string file_path",
		hook: "announce",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
		stdin: JSON.stringify({ tool_input: { file_path: 123 } }),
	},
	{
		name: "announce: empty stdin",
		hook: "announce",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
		stdin: "",
	},
	{
		name: "announce: malformed stdin",
		hook: "announce",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
		stdin: "not json at all",
	},
	{
		name: "announce: a path containing a quote",
		hook: "announce",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
		stdin: JSON.stringify({ tool_input: { file_path: '/p/"q"/.claude/memories/learning_a_b.md' } }),
	},
];

describe("announce — behaviour is pinned", () => {
	for (const fx of announce) test(fx.name, () => assertParity(fx));
});

const pull: readonly Fixture[] = [
	{ name: "pull: clean tree, auto", hook: "pull", env: { MEMORIES_AUTOPUSH_MODE: "auto" } },
	{ name: "pull: clean tree, review", hook: "pull", env: { MEMORIES_AUTOPUSH_MODE: "review" } },
	{
		name: "pull: untracked memory, auto reports lingering state",
		expect: /lingering state/,
		hook: "pull",
		env: { MEMORIES_AUTOPUSH_MODE: "auto" },
		setup: (repo) => memory(repo, "learning_pending_one.md"),
	},
	{
		name: "pull: untracked memory, review reports awaiting review",
		hook: "pull",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
		setup: (repo) => memory(repo, "learning_pending_one.md"),
	},
	{
		name: "pull: two untracked memories pluralise the same way",
		hook: "pull",
		env: { MEMORIES_AUTOPUSH_MODE: "auto" },
		setup: (repo) => {
			memory(repo, "learning_pending_one.md");
			memory(repo, "learning_pending_two.md");
		},
	},
	{
		name: "pull: unpushed commit only",
		hook: "pull",
		env: { MEMORIES_AUTOPUSH_MODE: "auto" },
		setup: (repo) => {
			memory(repo, "learning_committed_x.md");
			git(repo, "add", "-A");
			git(repo, "commit", "-qm", "local only");
		},
	},
	{
		name: "pull: uncommitted and unpushed together",
		hook: "pull",
		env: { MEMORIES_AUTOPUSH_MODE: "auto" },
		setup: (repo) => {
			memory(repo, "learning_committed_x.md");
			git(repo, "add", "-A");
			git(repo, "commit", "-qm", "local only");
			memory(repo, "learning_dirty_y.md");
		},
	},
	{
		name: "pull: no upstream configured",
		hook: "pull",
		env: { MEMORIES_AUTOPUSH_MODE: "auto" },
		setup: (repo) => {
			git(repo, "branch", "--unset-upstream");
			memory(repo, "learning_pending_one.md");
		},
	},
	{
		name: "pull: unknown mode warns, clean tree",
		hook: "pull",
		env: { MEMORIES_AUTOPUSH_MODE: "banana" },
	},
	{
		name: "pull: unknown mode warning joins the pending message",
		expect: /falling back to auto[^\n]*\\n\\nShared memories have lingering state/,
		hook: "pull",
		env: { MEMORIES_AUTOPUSH_MODE: "banana" },
		setup: (repo) => memory(repo, "learning_pending_one.md"),
	},
	{
		name: "pull: empty mode falls through to auto",
		hook: "pull",
		env: { MEMORIES_AUTOPUSH_MODE: "" },
		setup: (repo) => memory(repo, "learning_pending_one.md"),
	},
	{
		name: "pull: review mode clears the dedupe state file",
		hook: "pull",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
		setup: (repo) => writeFileSync(join(repo, ".review-shown"), "deadbeef\n"),
	},
	{
		name: "pull: auto mode leaves the dedupe state file alone",
		hook: "pull",
		env: { MEMORIES_AUTOPUSH_MODE: "auto" },
		setup: (repo) => writeFileSync(join(repo, ".review-shown"), "deadbeef\n"),
	},
	{
		name: "pull: missing checkout",
		hook: "pull",
		env: { MEMORIES_AUTOPUSH_MODE: "auto" },
		setup: (repo) => rmSync(repo, { recursive: true, force: true }),
	},
	{ name: "pull: malformed stdin", hook: "pull", stdin: "not json", env: { MEMORIES_AUTOPUSH_MODE: "auto" } },
	{
		name: "pull: empty stdin still does the work",
		hook: "pull",
		stdin: "",
		env: { MEMORIES_AUTOPUSH_MODE: "auto" },
		setup: (repo) => memory(repo, "learning_pending_one.md"),
	},
	{
		name: "pull: concatenated JSON stream is accepted",
		hook: "pull",
		stdin: '{"a":1} {"b":2}',
		env: { MEMORIES_AUTOPUSH_MODE: "auto" },
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
	{ name: "autopush: nothing pending, auto", hook: "autopush", env: { MEMORIES_AUTOPUSH_MODE: "auto" } },
	{ name: "autopush: nothing pending, review", hook: "autopush", env: { MEMORIES_AUTOPUSH_MODE: "review" } },
	{
		name: "autopush: nothing pending clears stale review state",
		hook: "autopush",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
		setup: (repo) => writeFileSync(join(repo, ".review-shown"), "stale\n"),
	},
	{
		name: "autopush: auto commits and pushes a new memory",
		hook: "autopush",
		env: { MEMORIES_AUTOPUSH_MODE: "auto" },
		setup: (repo) => memory(repo, "learning_new_thing.md", "A brand new lesson.\n"),
	},
	{
		name: "autopush: auto pushes a modification",
		hook: "autopush",
		env: { MEMORIES_AUTOPUSH_MODE: "auto" },
		setup: (repo) => memory(repo, "learning_seed_topic.md", "Rewritten seed.\n"),
	},
	{
		name: "autopush: auto parks a deletion",
		expect: /deleted memory file\(s\) left for manual review/,
		hook: "autopush",
		env: { MEMORIES_AUTOPUSH_MODE: "auto" },
		setup: (repo) => rmSync(join(repo, "memories", "learning_seed_topic.md")),
	},
	{
		name: "autopush: auto parks deletions but still pushes an addition",
		hook: "autopush",
		env: { MEMORIES_AUTOPUSH_MODE: "auto" },
		setup: (repo) => {
			rmSync(join(repo, "memories", "learning_seed_topic.md"));
			memory(repo, "learning_added_alongside.md");
		},
	},
	{
		name: "autopush: full pushes the deletion",
		expect: /^$/,
		hook: "autopush",
		env: { MEMORIES_AUTOPUSH_MODE: "full" },
		setup: (repo) => rmSync(join(repo, "memories", "learning_seed_topic.md")),
	},
	{
		name: "autopush: full without deletions omits the suffix",
		hook: "autopush",
		env: { MEMORIES_AUTOPUSH_MODE: "full" },
		setup: (repo) => memory(repo, "learning_new_thing.md"),
	},
	{
		name: "autopush: guardrail blocks a badly named file in auto",
		expect: /^Shared memories: skipping auto-push — unconventional filename\(s\):\n  - memories\/scratch\.md$/m,
		hook: "autopush",
		env: { MEMORIES_AUTOPUSH_MODE: "auto" },
		setup: (repo) => memory(repo, "scratch.md"),
	},
	{
		name: "autopush: guardrail blocks in full too",
		hook: "autopush",
		env: { MEMORIES_AUTOPUSH_MODE: "full" },
		setup: (repo) => memory(repo, "scratch.md"),
	},
	{
		name: "autopush: guardrail blocks in review too",
		hook: "autopush",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
		setup: (repo) => memory(repo, "scratch.md"),
	},
	{
		name: "autopush: guardrail lists several offenders",
		hook: "autopush",
		env: { MEMORIES_AUTOPUSH_MODE: "auto" },
		setup: (repo) => {
			memory(repo, "scratch.md");
			memory(repo, "wip notes.md");
			memory(repo, "learning_ok_one.md");
		},
	},
	{
		name: "autopush: unknown mode falls through to auto silently",
		hook: "autopush",
		env: { MEMORIES_AUTOPUSH_MODE: "banana" },
		setup: (repo) => memory(repo, "learning_new_thing.md"),
	},
	{
		name: "autopush: unpushed commit only",
		hook: "autopush",
		env: { MEMORIES_AUTOPUSH_MODE: "auto" },
		setup: (repo) => {
			memory(repo, "learning_committed_x.md");
			commit(repo, "local only");
		},
	},
	{
		name: "autopush: no upstream configured",
		hook: "autopush",
		env: { MEMORIES_AUTOPUSH_MODE: "auto" },
		setup: (repo) => {
			git(repo, "branch", "--unset-upstream");
			memory(repo, "learning_new_thing.md");
		},
	},
	{
		name: "autopush: missing checkout",
		hook: "autopush",
		env: { MEMORIES_AUTOPUSH_MODE: "auto" },
		setup: (repo) => rmSync(repo, { recursive: true, force: true }),
	},
	{ name: "autopush: malformed stdin", hook: "autopush", stdin: "not json", env: { MEMORIES_AUTOPUSH_MODE: "auto" } },
	{
		name: "autopush: empty stdin still pushes",
		hook: "autopush",
		stdin: "",
		env: { MEMORIES_AUTOPUSH_MODE: "auto" },
		setup: (repo) => memory(repo, "learning_new_thing.md"),
	},
];

describe("autopush — behaviour is pinned", () => {
	for (const fx of autopush) test(fx.name, () => assertParity(fx));
});

const ESC = String.fromCharCode(27);

const review: readonly Fixture[] = [
	{
		name: "review: a new file renders with its preview",
		expect: /^\+ NEW  <file:\/\/.*learning_new_thing\.md>\n {7}"First real line of the memory\."$/m,
		hook: "autopush",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
		setup: (repo) => memory(repo, "learning_new_thing.md", "First real line of the memory.\nSecond line.\n"),
	},
	{
		name: "review: preview skips leading blank and whitespace-only lines",
		hook: "autopush",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
		setup: (repo) => memory(repo, "learning_new_thing.md", "\n   \n\t\nActual content here.\n"),
	},
	{
		name: "review: an empty file emits no preview line",
		expect: /\+ NEW  <file:[^\n]*>\n(?!ceva)(?! {7}")/,
		hook: "autopush",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
		setup: (repo) => memory(repo, "learning_new_thing.md", ""),
	},
	{
		name: "review: a preview longer than 80 chars is truncated",
		hook: "autopush",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
		setup: (repo) => memory(repo, "learning_new_thing.md", `${"x".repeat(200)}\n`),
	},
	{
		name: "review: ANSI escapes in a memory never reach the terminal",
		hook: "autopush",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
		setup: (repo) => memory(repo, "learning_new_thing.md", `safe${ESC}[31mRED text\n`),
	},
	{
		name: "review: a bare carriage return is preserved, as the bash preserves it",
		hook: "autopush",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
		setup: (repo) => memory(repo, "learning_new_thing.md", "before\rafter\n"),
	},
	{
		name: "review: a tab in the preview survives",
		hook: "autopush",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
		setup: (repo) => memory(repo, "learning_new_thing.md", "before\tafter\n"),
	},
	{
		name: "review: a modification renders numstat",
		expect: /^~ MOD  <file:\/\/.*>  \(\+3 -1\)$/m,
		hook: "autopush",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
		setup: (repo) => memory(repo, "learning_seed_topic.md", "Line one.\nLine two.\nLine three.\n"),
	},
	{
		name: "review: a deletion renders its relative timestamp",
		expect: /^- DEL  memories\/learning_seed_topic\.md  \(last modified .+\)$/m,
		hook: "autopush",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
		setup: (repo) => rmSync(join(repo, "memories", "learning_seed_topic.md")),
	},
	{
		name: "review: new, modified and deleted together",
		hook: "autopush",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
		setup: (repo) => {
			memory(repo, "learning_extra_one.md", "Extra.\n");
			commit(repo, "add extra");
			git(repo, "push", "-q");
			memory(repo, "learning_brand_new.md", "Brand new.\n");
			memory(repo, "learning_seed_topic.md", "Modified seed.\n");
			rmSync(join(repo, "memories", "learning_extra_one.md"));
		},
	},
	{
		name: "review: pending files plus an unpushed commit",
		expect: /pending file\(s\) in memories\/ and 1 unpushed commit\(s\)/,
		hook: "autopush",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
		setup: (repo) => {
			memory(repo, "learning_committed_x.md");
			commit(repo, "local only");
			memory(repo, "learning_brand_new.md", "Brand new.\n");
		},
	},
	{
		name: "review: unpushed commit with no dirty files",
		hook: "autopush",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
		setup: (repo) => {
			memory(repo, "learning_committed_x.md");
			commit(repo, "local only");
		},
	},
	{
		name: "review: the same pending set is reported once",
		expect: /^$/,
		hook: "autopush",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
		runs: 2,
		setup: (repo) => memory(repo, "learning_new_thing.md", "A lesson.\n"),
	},
	{
		name: "review: a stale stored hash reprints",
		expect: /Shared memories \[review mode\]/,
		hook: "autopush",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
		setup: (repo) => memory(repo, "learning_new_thing.md", "A lesson.\n"),
		beforeEach: (repo) => writeFileSync(join(repo, ".review-shown"), "0000000000000000\n"),
	},
	{
		name: "review: twenty-one deletions straddle the timestamp cap",
		expect: /^- DEL  memories\/learning_bulk_20\.md$/m,
		hook: "autopush",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
		setup: (repo) => {
			for (let i = 0; i < 21; i++) memory(repo, `learning_bulk_${String(i).padStart(2, "0")}.md`, `Bulk ${i}.\n`);
			commit(repo, "bulk");
			git(repo, "push", "-q");
			for (let i = 0; i < 21; i++) rmSync(join(repo, "memories", `learning_bulk_${String(i).padStart(2, "0")}.md`));
		},
	},
];

const reviewChange: Fixture = {
	name: "review: adding a file after a report reprints",
	expect: /2 pending file\(s\)/,
	hook: "autopush",
	env: { MEMORIES_AUTOPUSH_MODE: "review" },
	runs: 2,
	setup: (repo) => memory(repo, "learning_new_thing.md", "A lesson.\n"),
	betweenRuns: (repo) => memory(repo, "learning_second_one.md", "Another lesson.\n"),
};

describe("review mode — behaviour is pinned", () => {
	test(reviewChange.name, () => assertParity(reviewChange));
	for (const fx of review) test(fx.name, () => assertParity(fx));
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
		env: { MEMORIES_AUTOPUSH_MODE: "auto" },
		setup: (repo, project) => {
			otherClonePushes(repo, project, "learning_theirs_one.md", "Theirs.\n");
			memory(repo, "learning_ours_one.md", "Ours.\n");
		},
	},
	{
		name: "push: a rebase conflict pauses and aborts",
		expect: /^Shared memories: auto-push paused — rebase conflict\. Resolve manually in \.claude\/\.memories-repo\/memories\.$/m,
		hook: "autopush",
		env: { MEMORIES_AUTOPUSH_MODE: "auto" },
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
		env: { MEMORIES_AUTOPUSH_MODE: "auto" },
		setup: (repo) => {
			memory(repo, "learning_ours_one.md", "Ours.\n");
			commit(repo, "local only");
			git(repo, "remote", "set-url", "origin", "/nonexistent/definitely-not-here.git");
		},
	},
	{
		name: "push: a zero attempt budget still tries once",
		hook: "autopush",
		env: { MEMORIES_AUTOPUSH_MODE: "auto", MEMORIES_PUSH_ATTEMPTS: "0" },
		setup: (repo, project) => {
			otherClonePushes(repo, project, "learning_theirs_one.md", "Theirs.\n");
			memory(repo, "learning_ours_one.md", "Ours.\n");
		},
	},
	{
		name: "push: a non-integer attempt budget falls back to the default",
		hook: "autopush",
		env: { MEMORIES_AUTOPUSH_MODE: "auto", MEMORIES_PUSH_ATTEMPTS: "banana" },
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
	env: attempts === undefined
		? { MEMORIES_AUTOPUSH_MODE: "auto" }
		: { MEMORIES_AUTOPUSH_MODE: "auto", MEMORIES_PUSH_ATTEMPTS: attempts },
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

const audit: readonly Fixture[] = [
	{
		// grep's [[:space:]] includes CR; a CRLF file's "blank" line is not blank to /^[\t ]*$/.
		name: "audit: a CRLF blank first line is skipped like bash skips it",
		expect: /"Real content\r"/,
		hook: "autopush",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
		setup: (repo) => memory(repo, "learning_new_thing.md", "\r\nReal content\r\n"),
	},
	{
		// bash ${var:0:80} counts characters; JS slice counts UTF-16 code units.
		name: "audit: an 80-character truncation counts characters, not code units",
		hook: "autopush",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
		setup: (repo) => memory(repo, "learning_new_thing.md", `${"é".repeat(100)}\n`),
	},
	{
		name: "audit: astral characters truncate at the same point",
		hook: "autopush",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
		setup: (repo) => memory(repo, "learning_new_thing.md", `${"🌍".repeat(100)}\n`),
	},
	{
		name: "audit: a memory path containing a space and a hash",
		hook: "autopush",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
		setup: (repo) => memory(repo, "learning_new_thing.md", "Content.\n"),
	},
];

describe("audit findings — behaviour is pinned", () => {
	for (const fx of audit) test(fx.name, () => assertParity(fx));
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
		name: "pathspec: full mode leaves a dirty root file uncommitted",
		expect: /^$/,
		hook: "autopush",
		env: { MEMORIES_AUTOPUSH_MODE: "full" },
		setup: (repo) => {
			withDirtyRootFile(repo);
			memory(repo, "learning_new_thing.md", "A lesson.\n");
		},
	},
	{
		name: "pathspec: auto mode leaves a dirty root file uncommitted",
		hook: "autopush",
		env: { MEMORIES_AUTOPUSH_MODE: "auto" },
		setup: (repo) => {
			withDirtyRootFile(repo);
			memory(repo, "learning_new_thing.md", "A lesson.\n");
		},
	},
	{
		name: "pathspec: a dirty root file does not trip the filename guardrail",
		hook: "autopush",
		env: { MEMORIES_AUTOPUSH_MODE: "auto" },
		setup: (repo) => withDirtyRootFile(repo),
	},
	{
		name: "pathspec: review mode does not report a dirty root file",
		hook: "autopush",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
		setup: (repo) => {
			withDirtyRootFile(repo);
			memory(repo, "learning_new_thing.md", "A lesson.\n");
		},
	},
	{
		name: "pathspec: SessionStart does not count a dirty root file as pending",
		hook: "pull",
		env: { MEMORIES_AUTOPUSH_MODE: "auto" },
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
		env: { MEMORIES_AUTOPUSH_MODE: "auto" },
		setup: (repo, project) => teammatePushes(repo, project, "learning_theirs_new.md"),
	},
	{
		name: "incoming: a fast-forward alongside our own untracked memory",
		hook: "pull",
		env: { MEMORIES_AUTOPUSH_MODE: "auto" },
		setup: (repo, project) => {
			teammatePushes(repo, project, "learning_theirs_new.md");
			memory(repo, "learning_ours_pending.md", "Ours, not yet pushed.\n");
		},
	},
	{
		name: "incoming: SessionStart does not fast-forward past a conflicting local commit",
		hook: "pull",
		env: { MEMORIES_AUTOPUSH_MODE: "auto" },
		setup: (repo, project) => {
			teammatePushes(repo, project, "learning_theirs_new.md");
			memory(repo, "learning_ours_own.md", "Ours.\n");
			commit(repo, "our local commit");
		},
	},
	{
		name: "incoming: the Stop hook rebases onto a teammate's commit",
		hook: "autopush",
		env: { MEMORIES_AUTOPUSH_MODE: "auto" },
		setup: (repo, project) => {
			teammatePushes(repo, project, "learning_theirs_new.md");
			memory(repo, "learning_ours_own.md", "Ours.\n");
		},
	},
];

describe("incoming memories — behaviour is pinned", () => {
	for (const fx of incoming) test(fx.name, () => assertParity(fx));
});

const edges: readonly Fixture[] = [
	{
		name: "edge: announce reads every value in a concatenated stream",
		expect: /Memory file saved at \/p\/\.claude\/memories\/learning_a_b\.md\\n\/p\/\.claude\/memories\/learning_c_d\.md \(MEMORIES/,
		hook: "announce",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
		stdin: '{"tool_input":{"file_path":"/p/.claude/memories/learning_a_b.md"}} {"tool_input":{"file_path":"/p/.claude/memories/learning_c_d.md"}}',
	},
	{
		name: "edge: announce when only the second value carries a path",
		expect: /learning_c_d\.md/,
		hook: "announce",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
		stdin: '{"tool_input":{}} {"tool_input":{"file_path":"/p/.claude/memories/learning_c_d.md"}}',
	},
	{
		// jq's `// empty` drops false, so it must not appear in the joined paths.
		name: "edge: announce drops a false file_path from the stream",
		expect: /Memory file saved at \/p\/\.claude\/memories\/learning_a_b\.md \(MEMORIES/,
		hook: "announce",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
		stdin: '{"tool_input":{"file_path":false}} {"tool_input":{"file_path":"/p/.claude/memories/learning_a_b.md"}}',
	},
	{
		// jq -r renders a non-string result as pretty JSON, not as a JS-style cast.
		name: "edge: announce renders a non-string file_path the way jq does",
		expect: /Memory file saved at \{\\n  \\"x\\": 1\\n\}\\n\/p\/\.claude/,
		hook: "announce",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
		stdin: '{"tool_input":{"file_path":{"x":1}}} {"tool_input":{"file_path":"/p/.claude/memories/learning_a_b.md"}}',
	},
	{
		name: "edge: announce strips a trailing newline the way $() did",
		expect: /Memory file saved at \/p\/\.claude\/memories\/learning_a_b\.md \(MEMORIES/,
		hook: "announce",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
		stdin: '{"tool_input":{"file_path":"/p/.claude/memories/learning_a_b.md\\n"}}',
	},
	{
		name: "edge: an empty last result does not silence the nudge",
		expect: /Memory file saved at \/p\/\.claude\/memories\/learning_a_b\.md \(MEMORIES/,
		hook: "announce",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
		stdin: '{"tool_input":{"file_path":"/p/.claude/memories/learning_a_b.md"}} {"tool_input":{"file_path":""}}',
	},
	{
		name: "edge: a locked index aborts the turn instead of reporting nothing",
		abortsDiffer: true,
		expect: /Unable to create .*index\.lock/,
		hook: "autopush",
		env: { MEMORIES_AUTOPUSH_MODE: "auto" },
		setup: (repo) => {
			memory(repo, "learning_new_thing.md", "A lesson.\n");
			writeFileSync(join(repo, ".git", "index.lock"), "");
		},
	},
	{
		name: "edge: announce ignores a null file_path",
		hook: "announce",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
		stdin: '{"tool_input":{"file_path":null}}',
	},
	{
		// jq neither aborts on an erroring value nor reports it once a later value
		// succeeds, so the leading 42 is skipped and the path IS announced. The
		// mirror-image fixture below is the silent one.
		name: "edge: announce still reports a path after a leading scalar",
		hook: "announce",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
		stdin: '42 {"tool_input":{"file_path":"/p/.claude/memories/learning_a_b.md"}}',
	},
	{
		// jq's status reflects the last value only, so a trailing scalar silences it.
		name: "edge: announce is silent when a scalar follows a valid path",
		hook: "announce",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
		stdin: '{"tool_input":{"file_path":"/p/.claude/memories/learning_a_b.md"}} 42',
	},
	{
		name: "edge: announce is silent when stdin is a bare scalar",
		hook: "announce",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
		stdin: "42",
	},
	{
		name: "edge: review reports a staged rename as unclassified pending",
		expect: /unclassified pending change\(s\) in memories\//,
		hook: "autopush",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
		setup: (repo) => git(repo, "mv", "memories/learning_seed_topic.md", "memories/learning_seed_renamed.md"),
	},
	{
		name: "edge: review on a detached HEAD with an unpushed commit",
		hook: "autopush",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
		setup: (repo) => {
			memory(repo, "learning_x_y.md");
			commit(repo, "local");
			git(repo, "checkout", "-q", "--detach");
		},
	},
	{
		name: "edge: a typechange to a symlink is unclassified pending",
		hook: "autopush",
		env: { MEMORIES_AUTOPUSH_MODE: "review" },
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
			MEMORIES_AUTOPUSH_MODE: "auto",
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
		env: { MEMORIES_AUTOPUSH_MODE: "auto" },
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
		env: { MEMORIES_AUTOPUSH_MODE: "auto" },
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
		env: { MEMORIES_AUTOPUSH_MODE: "auto" },
		setup: (repo) => {
			memory(repo, "learning_x_y.md");
			git(repo, "add", "-A");
		},
	},
	{
		name: "edge: a dangling memories symlink does not stop the push",
		hook: "autopush",
		env: { MEMORIES_AUTOPUSH_MODE: "auto" },
		setup: (repo, project) => {
			rmSync(join(project, ".claude", "memories"));
			symlinkSync(".memories-repo/nope", join(project, ".claude", "memories"));
			memory(repo, "learning_x_y.md");
		},
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
			env: { MEMORIES_AUTOPUSH_MODE: "full" },
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
