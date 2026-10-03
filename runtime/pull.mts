#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning
import { additionalContext, failOpen, isJsonStream, readStdin, warn } from "./lib/hook-io.mts";
import { aheadOfUpstream, git, gitPresent, hasUpstream, isWorkTree, operationInProgress } from "./lib/git.mts";
import { RESOLVE_COMMAND } from "./lib/naming.mts";
import { uncommittedCount } from "./lib/pending.mts";
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

	const op = operationInProgress(repo);
	if (op !== null) {
		additionalContext(
			"SessionStart",
			`Shared memories: a ${op} is in progress in .claude/.memories-repo, so auto-push is paused and teammates' memories were not pulled. Run ${RESOLVE_COMMAND} to finish it.`,
		);
		return;
	}

	// Without an upstream every Stop commits locally and nothing ever reaches the team.
	if (!hasUpstream(repo)) {
		additionalContext(
			"SessionStart",
			`Shared memories: the checkout in .claude/.memories-repo has no upstream branch, so memories are committed locally but never pushed or pulled. Run ${RESOLVE_COMMAND} to fix it.`,
		);
		return;
	}

	git(repo, ["pull", "--ff-only", "--quiet"]);

	const uncommitted = uncommittedCount(repo);
	const unpushed = aheadOfUpstream(repo);
	if (uncommitted === 0 && unpushed === 0) return;

	const joined = [
		uncommitted > 0 ? `${uncommitted} uncommitted file(s)` : "",
		unpushed > 0 ? `${unpushed} unpushed commit(s)` : "",
	]
		.filter(Boolean)
		.join(", ");
	additionalContext(
		"SessionStart",
		`Shared memories have lingering state: ${joined}. The previous Stop hook's auto-push didn't complete. The next Stop retries automatically. If it keeps failing: run ${RESOLVE_COMMAND} for a rebase conflict or misnamed files (must match memories/{learning,decision}_<name>.md); for auth, check ssh-add or run mcs doctor.`,
	);
});
