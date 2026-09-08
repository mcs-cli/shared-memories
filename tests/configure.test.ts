import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, readGolden, runConfigure, type ConfigureFixture, type RunResult } from "./harness.ts";


/**
 * Behaviour is pinned to tests/golden/, recorded from the bash implementation
 * this pack replaced and verified against it fixture by fixture before the bash
 * was removed. A drift here is a change in what the pack does, not a stale test.
 */
function check(fx: ConfigureFixture, actual: RunResult): void {
	const golden = readGolden(fx.name);
	assert.ok(golden, `no golden recorded for "${fx.name}"`);

	const wantStdout = fx.deviation?.stdout ? fx.deviation.stdout(golden.stdout) : golden.stdout;
	const wantCode = fx.deviation?.code ?? golden.code;
	if (fx.deviation) {
		assert.ok(
			wantStdout !== golden.stdout || wantCode !== golden.code,
			`"${fx.name}" declares a deviation that is identical to the recorded bash behaviour`,
		);
	}

	assert.equal(actual.stdout, wantStdout, `stdout drifted for "${fx.name}"`);
	assert.equal(actual.code, wantCode, `exit code drifted for "${fx.name}"`);
	assert.equal(actual.stderr, golden.stderr, `stderr drifted for "${fx.name}"`);
	assert.equal(actual.git, golden.git, `resulting .claude/ drifted for "${fx.name}"`);
	// A fixture where nothing happens passes vacuously, so pin what was recorded.
	if (fx.expect) assert.match(golden.stdout + golden.stderr, fx.expect, `fixture "${fx.name}" never exercised what it claims to`);
	if (fx.expectCode !== undefined) {
		assert.equal(wantCode, fx.expectCode, `fixture "${fx.name}" did not reach the state it claims`);
	}
}

function assertParity(fx: ConfigureFixture): void {
	check(fx, runConfigure(fx));
}

const local = (claude: string, name: string, body = "Local memory.\n") => {
	mkdirSync(join(claude, "memories"), { recursive: true });
	writeFileSync(join(claude, "memories", name), body);
};

const fixtures: readonly ConfigureFixture[] = [
	{
		name: "case 5: fresh setup clones and links",
		expectCode: 0,
		expect: /Cloning shared memories \(branch 'main', sparse\)[\s\S]*Done\. 1 memory file\(s\) available/,
	},
	{
		name: "case 1: an already-linked setup is left alone",
		expectCode: 0,
		expect: /Shared memories already linked — leaving as-is\./,
		pre: (project, claude) => {
			// A live checkout plus the symlink is the healthy state.
			git(claude, "clone", "-q", join(project, "..", "remote.git"), join(claude, ".memories-repo"));
			symlinkSync(".memories-repo/memories", join(claude, "memories"));
		},
	},
	{
		name: "case 2: an empty memories directory is removed",
		expectCode: 0,
		expect: /Found empty .*memories — removing and proceeding with fresh setup\./,
		pre: (_project, claude) => mkdirSync(join(claude, "memories"), { recursive: true }),
	},
	{
		name: "case 2: a populated memories directory migrates and pushes",
		expectCode: 0,
		expect: /staging for migration[\s\S]*Migration: imported 1 local memory file\(s\)[\s\S]*Pushed migrated memories/,
		pre: (_project, claude) => local(claude, "learning_mine_own.md"),
	},
	{
		name: "case 2: the shared copy wins a filename conflict",
		expectCode: 0,
		expect: /1 conflict\(s\) \(shared version kept\)/,
		pre: (_project, claude) => local(claude, "learning_shared_seed.md", "My divergent copy.\n"),
	},
	{
		name: "case 2: a previously deleted memory is held back",
		expectCode: 0,
		expect: /previously-deleted file\(s\) held back[\s\S]*deleted by <SHA> remove it/,
		seed: (clone) => {
			writeFileSync(join(clone, "memories", "learning_curated_away.md"), "Was here.\n");
			git(clone, "add", "-A");
			git(clone, "commit", "-qm", "add it");
			rmSync(join(clone, "memories", "learning_curated_away.md"));
			git(clone, "add", "-A");
			git(clone, "commit", "-qm", "remove it");
			git(clone, "push", "-q");
		},
		pre: (_project, claude) => local(claude, "learning_curated_away.md", "My stale copy.\n"),
	},
	{
		name: "case 2: a badly named migrated file is left untracked",
		expectCode: 0,
		expect: /don't match the naming convention and were left untracked:\n  - memories\/scratch\.md/,
		pre: (_project, claude) => {
			local(claude, "learning_mine_own.md");
			local(claude, "scratch.md", "Not conventional.\n");
		},
	},
	{
		// Distinguishes the final count's `*.md` filter from a bare entry count.
		name: "case 2: a migrated non-markdown file is not counted as a memory",
		expectCode: 0,
		expect: /Done\. 2 memory file\(s\) available/,
		pre: (_project, claude) => {
			local(claude, "learning_mine_own.md");
			local(claude, "notes.txt", "Not a memory.\n");
		},
	},
	{
		name: "case 3: a live checkout with no symlink is relinked",
		expectCode: 0,
		expect: /Memories checkout present, \(re\)linking/,
		pre: (project, claude) => {
			git(claude, "clone", "-q", join(project, "..", "remote.git"), join(claude, ".memories-repo"));
		},
	},
	{
		name: "case 4: a non-checkout at the repo path is refused",
		expectCode: 0,
		expect: /exists but is not a valid git checkout; refusing to touch it\./,
		pre: (_project, claude) => mkdirSync(join(claude, ".memories-repo", "junk"), { recursive: true }),
	},
	{
		name: "preflight: an unreachable remote touches nothing",
		expectCode: 1,
		expect: /Cannot set up shared memories — remote is unreachable or branch missing\./,
		env: { MCS_RESOLVED_MEMORIES_REPO_URL: "/nonexistent/definitely-not-here.git" },
		pre: (_project, claude) => local(claude, "learning_mine_own.md"),
	},
	{
		name: "preflight: a missing branch touches nothing",
		expectCode: 1,
		expect: /Branch 'nope' does not exist on the remote/,
		env: { MCS_RESOLVED_MEMORIES_BRANCH: "nope" },
	},
	{
		name: "an unresolved repo url skips quietly",
		expectCode: 0,
		expect: /MEMORIES_REPO_URL not resolved; skipping memories clone\./,
		env: { MCS_RESOLVED_MEMORIES_REPO_URL: "" },
	},
	{
		name: "a regular file at the memories path is refused",
		expectCode: 0,
		expect: /exists but is not a directory or symlink; refusing to touch it\./,
		pre: (_project, claude) => writeFileSync(join(claude, "memories"), "i am a file\n"),
	},
];

describe("configure-memories — behaviour is pinned", () => {
	for (const fx of fixtures) test(fx.name, () => assertParity(fx));
});

const audited: readonly ConfigureFixture[] = [
	{
		name: "audited: a bootstrap branch with no memories tree exits 2 without Done",
		expectCode: 0,
		expect: /Cloning shared memories/,
		emptyRemote: true,
		deviation: {
			reason:
				"The bash ended with `count=$(ls \"$link\"/*.md ...)`; under `set -e -o pipefail` an unmatched glob made ls exit 2 and killed the script, so a first install against an empty branch reported failure and printed no Done line.",
			stdout: (recorded) => `${recorded}Done. 0 memory file(s) available at <TMP>/work/project/.claude/memories.\n`,
			code: 0,
		},
	},
	{
		name: "audited: a subdirectory in the migration backup is left behind",
		expectCode: 0,
		expect: /Kept at .*\.memories-migration-<TS> for review\./,
		pre: (_project, claude) => {
			local(claude, "learning_mine_own.md");
			mkdirSync(join(claude, "memories", "subdir"), { recursive: true });
			writeFileSync(join(claude, "memories", "subdir", "x.md"), "x\n");
		},
	},
	{
		name: "audited: a dotted .md file migrates but is not counted",
		expectCode: 0,
		expect: /Done\. 2 memory file\(s\) available/,
		pre: (_project, claude) => {
			local(claude, "learning_mine_own.md");
			writeFileSync(join(claude, "memories", ".hidden"), "h\n");
			writeFileSync(join(claude, "memories", ".hidden.md"), "h\n");
		},
	},
	{
		name: "audited: a dangling symlink with no checkout is replaced",
		expectCode: 0,
		expect: /Cloning shared memories/,
		pre: (_project, claude) => symlinkSync(".memories-repo/memories", join(claude, "memories")),
	},
	{
		name: "audited: a symlink to a non-git directory beside a live checkout is relinked",
		expectCode: 0,
		expect: /Memories checkout present, \(re\)linking/,
		pre: (project, claude) => {
			git(claude, "clone", "-q", join(project, "..", "remote.git"), join(claude, ".memories-repo"));
			mkdirSync(join(project, "elsewhere"), { recursive: true });
			symlinkSync(join(project, "elsewhere"), join(claude, "memories"));
		},
	},
	{
		name: "audited: every migrated file conflicting imports nothing",
		expectCode: 0,
		expect: /imported 0 local memory file\(s\); 1 conflict\(s\)/,
		pre: (_project, claude) => local(claude, "learning_shared_seed.md", "My divergent copy.\n"),
	},
	{
		name: "audited: twenty-one previously deleted files straddle the reason cap",
		expectCode: 0,
		expect: /previously-deleted file\(s\) held back/,
		seed: (clone) => {
			for (let i = 0; i < 21; i++) {
				writeFileSync(join(clone, "memories", `learning_gone_${String(i).padStart(2, "0")}.md`), "was\n");
			}
			git(clone, "add", "-A");
			git(clone, "commit", "-qm", "add many");
			for (let i = 0; i < 21; i++) rmSync(join(clone, "memories", `learning_gone_${String(i).padStart(2, "0")}.md`));
			git(clone, "add", "-A");
			git(clone, "commit", "-qm", "remove many");
			git(clone, "push", "-q");
		},
		pre: (_project, claude) => {
			for (let i = 0; i < 21; i++) local(claude, `learning_gone_${String(i).padStart(2, "0")}.md`, "stale\n");
		},
	},
	{
		name: "audited: a clone failure propagates git's exit status",
		expectCode: 128,
		skipAsRoot: true,
		pre: (_project, claude) => chmodSync(claude, 0o500),
	},
	{
		name: "audited: a trailing slash on the project path is not normalised away",
		expectCode: 0,
		trailingSlash: true,
	},
];

describe("audited configure edges — behaviour is pinned", () => {
	const root = process.getuid?.() === 0;
	for (const fx of audited) {
		// A read-only directory does not stop root, so that fixture proves nothing there.
		test(fx.name, { skip: fx.skipAsRoot === true && root }, () => assertParity(fx));
	}
});

const unchecked: readonly ConfigureFixture[] = [
	{
		// A fresh machine has no git identity, which is exactly when configureProject first runs.
		name: "unchecked: a failed migration commit is not reported as a push",
		expectCode: 128,
		expect: /Migration: imported 1 local memory file\(s\)/,
		env: {
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
			GIT_AUTHOR_NAME: "",
			GIT_AUTHOR_EMAIL: "",
			GIT_COMMITTER_NAME: "",
			GIT_COMMITTER_EMAIL: "",
		},
		pre: (_project, claude) => local(claude, "learning_mine_own.md"),
	},
	{
		name: "unchecked: a dangling symlink is skipped, not fatal",
		expectCode: 0,
		expect: /Migration: imported 1 local memory file\(s\)/,
		pre: (_project, claude) => {
			local(claude, "learning_mine_own.md");
			symlinkSync("/nonexistent/target.md", join(claude, "memories", "learning_dangling_link.md"));
		},
	},
];

describe("unchecked git results — behaviour is pinned", () => {
	for (const fx of unchecked) test(fx.name, () => assertParity(fx));
});

describe("configure-memories — deliberate fixes to defects in the bash", () => {
	test("an unset MCS_PROJECT_PATH is refused rather than resolved against the filesystem root", () => {
		// The bash built "$MCS_PROJECT_PATH/.claude/..." by concatenation, so an empty
		// value produced "/.claude/..." and failed deep inside git clone. Falling back
		// to cwd would be worse: configure would set up whatever directory you stood in.
		const r = runConfigure({ name: "unset project path", env: { MCS_PROJECT_PATH: "" } });
		assert.equal(r.code, 1, "an unusable project path must fail fast");
		assert.match(r.stderr, /MCS_PROJECT_PATH is not set/);
		assert.equal(r.stdout, "", "nothing is reported as done");
	});

	test("a bootstrap install against a branch with no memories reports success", () => {
		const r = runConfigure({ name: "bootstrap", emptyRemote: true });
		assert.equal(r.code, 0, "a first install is not a failure");
		assert.match(r.stdout, /Done\. 0 memory file\(s\) available at/);
	});
});
