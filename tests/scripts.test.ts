import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rmSync, symlinkSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { git, readGolden, runScript, type RunResult, type ScriptFixture } from "./harness.ts";


/**
 * Behaviour is pinned to tests/golden/, recorded from the bash implementation
 * this pack replaced and verified against it fixture by fixture before the bash
 * was removed. A drift here is a change in what the pack does, not a stale test.
 */
function check(name: string, actual: RunResult, expect?: RegExp): void {
	const golden = readGolden(name);
	assert.ok(golden, `no golden recorded for "${name}"`);
	assert.equal(actual.stdout, golden.stdout, `stdout drifted from recorded behaviour for "${name}"`);
	assert.equal(actual.code, golden.code, `exit code drifted for "${name}"`);
	assert.equal(actual.stderr, golden.stderr, `stderr drifted from recorded behaviour for "${name}"`);
	assert.equal(actual.git, golden.git, `resulting state drifted for "${name}"\ngolden:\n${golden.git}\n\nactual:\n${actual.git}`);
	// A fixture where nothing happens passes vacuously, so pin what was recorded.
	if (expect) assert.match(golden.stdout + golden.stderr, expect, `fixture "${name}" never exercised what it claims to`);
}

function assertParity(fx: ScriptFixture): void {
	check(fx.name, runScript(fx));
	if (fx.expectCode !== undefined) {
		assert.equal((readGolden(fx.name) as RunResult).code, fx.expectCode, `fixture "${fx.name}" did not reach the state it claims`);
	}
}

const claude = (project: string) => join(project, ".claude");

const fixtures: readonly ScriptFixture[] = [
	{ name: "doctor: healthy setup passes", script: "doctor-memories", expectCode: 0 },
	{
		name: "doctor: missing checkout and symlink",
		script: "doctor-memories",
		expectCode: 1,
		setup: (repo, project) => {
			rmSync(repo, { recursive: true, force: true });
			unlinkSync(join(claude(project), "memories"));
		},
	},
	{
		name: "doctor: checkout present, symlink missing",
		script: "doctor-memories",
		expectCode: 1,
		setup: (_repo, project) => unlinkSync(join(claude(project), "memories")),
	},
	{
		name: "doctor: dangling symlink",
		script: "doctor-memories",
		expectCode: 1,
		setup: (repo, project) => {
			rmSync(repo, { recursive: true, force: true });
		},
	},
	{
		name: "doctor: symlink resolves somewhere that is not a checkout",
		script: "doctor-memories",
		expectCode: 1,
		setup: (_repo, project) => {
			const link = join(claude(project), "memories");
			unlinkSync(link);
			mkdirSync(join(project, "elsewhere"), { recursive: true });
			symlinkSync(join(project, "elsewhere"), link);
		},
	},
	{ name: "doctor-remote: reachable remote passes", script: "doctor-memories-remote", expectCode: 0 },
	{
		name: "doctor-remote: no checkout skips",
		script: "doctor-memories-remote",
		expectCode: 3,
		setup: (repo) => rmSync(repo, { recursive: true, force: true }),
	},
	{
		name: "doctor-remote: unreachable remote warns",
		script: "doctor-memories-remote",
		expectCode: 2,
		setup: (repo) => git(repo, "remote", "set-url", "origin", "/nonexistent/definitely-not-here.git"),
	},
];

describe("pack scripts — behaviour is pinned", () => {
	for (const fx of fixtures) test(fx.name, () => assertParity(fx));
});
