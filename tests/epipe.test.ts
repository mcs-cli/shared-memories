import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeProject } from "./harness.ts";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

/** Runs a hook with its stdout reader gone before it writes: the EPIPE case. */
function runWithNoReader(hook: string, env: Record<string, string>, stdin: string) {
	const { root, project } = makeProject();
	const hooks = join(project, ".claude", "hooks", "shared-memories");
	mkdirSync(hooks, { recursive: true });
	cpSync(join(REPO, "runtime", hook), join(hooks, hook));
	chmodSync(join(hooks, hook), 0o755);
	cpSync(join(REPO, "runtime", "lib"), join(hooks, "lib"), { recursive: true });

	return new Promise<{ code: number | null; signal: string | null; stderr: string }>((resolve) => {
		const child = spawn(join(hooks, hook), [], {
			cwd: project,
			env: { ...process.env, ...env },
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
	test("announce still exits 0 and reports no stack", async () => {
		const r = await runWithNoReader(
			"announce.mts",
			{ MEMORIES_AUTOPUSH_MODE: "review" },
			JSON.stringify({ tool_input: { file_path: "/p/.claude/memories/learning_a_b.md" } }),
		);
		assert.equal(r.signal, null, "the hook must not die on SIGPIPE");
		assert.equal(r.code, 0);
		assert.doesNotMatch(r.stderr, /EPIPE/, "EPIPE must not surface as a failure");
	});
});
