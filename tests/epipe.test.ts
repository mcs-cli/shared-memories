import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeProject, memory } from "./harness.ts";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

/** Runs a hook with its stdout reader gone before it writes: the EPIPE case. */
function runWithNoReader(hook: string, stdin: string, setup?: (repo: string) => void) {
	const { root, project, repo } = makeProject();
	setup?.(repo);
	const hooks = join(project, ".claude", "hooks", "shared-memories");
	mkdirSync(hooks, { recursive: true });
	cpSync(join(REPO, "runtime", hook), join(hooks, hook));
	chmodSync(join(hooks, hook), 0o755);
	cpSync(join(REPO, "runtime", "lib"), join(hooks, "lib"), { recursive: true });

	return new Promise<{ code: number | null; signal: string | null; stderr: string }>((resolve) => {
		const child = spawn(join(hooks, hook), [], {
			cwd: project,
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (d) => (stderr += d));
		child.stdout.destroy();
		child.stdin.end(stdin);
		child.on("close", (code, signal) => {
			rmSync(root, { recursive: true, force: true });
			resolve({ code, signal, stderr });
		});
	});
}

describe("a hook whose reader has gone away", () => {
	test("SessionStart still exits 0 and reports no stack", async () => {
		// Lingering state makes pull write its additionalContext into the closed pipe.
		const r = await runWithNoReader("pull.mts", "{}", (repo) => memory(repo, "learning_pending_one.md"));
		assert.equal(r.signal, null, "the hook must not die on SIGPIPE");
		assert.equal(r.code, 0);
		assert.doesNotMatch(r.stderr, /EPIPE/, "EPIPE must not surface as a failure");
	});
});
