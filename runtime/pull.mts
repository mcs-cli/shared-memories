#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning
import { rmSync } from "node:fs";
import { join } from "node:path";
import { additionalContext, failOpen, isJsonStream, readStdin, warn } from "./lib/hook-io.mts";
import { gitLines, gitPresent, isWorkTree, unpushedCount, git } from "./lib/git.mts";
import { MODES, resolveMode } from "./lib/mode.mts";
import { memoriesRepo, projectRoot } from "./lib/paths.mts";

const NAME = "memories_pull";

failOpen(NAME, () => {
	if (!gitPresent()) return warn(`${NAME}: git not found; skipping`);
	if (!isJsonStream(readStdin())) return warn(`${NAME}: stdin is not valid JSON; skipping`);

	const project = projectRoot(import.meta.dirname);
	const repo = memoriesRepo(project);
	if (!isWorkTree(repo)) {
		return warn(`${NAME}: ${repo} is not a git worktree; skipping (project_root=${project})`);
	}

	const raw = process.env["MEMORIES_AUTOPUSH_MODE"];
	const { mode, unrecognised } = resolveMode(raw);
	const modeWarning =
		unrecognised === null
			? ""
			: `Shared memories: unknown MEMORIES_AUTOPUSH_MODE='${unrecognised}' — falling back to auto. Fix the value in .claude/settings.local.json (valid: ${MODES.join(", ")}) and restart the session.`;

	git(repo, ["pull", "--ff-only", "--quiet"]);

	if (mode === "review") {
		try {
			rmSync(join(repo, ".review-shown"), { force: true });
		} catch {
			/* the bash ignores this too */
		}
	}

	const uncommitted = gitLines(repo, ["status", "--porcelain", "--", "memories/"]).length;
	const unpushed = unpushedCount(repo);

	let pending = "";
	if (uncommitted > 0 || unpushed > 0) {
		const joined =
			uncommitted > 0 && unpushed > 0
				? `${uncommitted} uncommitted file(s), ${unpushed} unpushed commit(s)`
				: uncommitted > 0
					? `${uncommitted} uncommitted file(s)`
					: `${unpushed} unpushed commit(s)`;
		pending =
			mode === "review"
				? `Shared memories: ${joined} awaiting review (MEMORIES_AUTOPUSH_MODE=review). End a turn to see the per-file report with approve/discard commands.`
				: `Shared memories have lingering state: ${joined}. The previous Stop hook's auto-push didn't complete — check SSH auth (ssh-add), network, or file naming (must match memories/{learning,decision}_<name>.md). The next Stop will retry automatically.`;
	}

	const msg = modeWarning && pending ? `${modeWarning}\n\n${pending}` : modeWarning || pending;
	if (msg === "") return;
	additionalContext("SessionStart", msg);
});
