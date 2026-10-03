#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning
import { authorName, git, gitPresent, isWorkTree, operationInProgress, unpushedCount } from "./lib/git.mts";
import { commitMessage, stagedChanges } from "./lib/commit-message.mts";
import { detail, failOpen, isJsonStream, readStdin, say, warn } from "./lib/hook-io.mts";
import { badNames, uncommittedCount } from "./lib/pending.mts";
import { memoriesRepo, projectRoot } from "./lib/paths.mts";
import { RENAME_HINT, RESOLVE_COMMAND } from "./lib/naming.mts";
import { syncToRemote } from "./lib/push.mts";

const NAME = "memories_autopush";

/** A failed stage must not read as "nothing to commit"; let git speak and abort the turn. */
const stage = (repo: string, args: readonly string[]): void => {
	const r = git(repo, args, { inheritStderr: true });
	if (!r.ok) throw new Error(`git ${args.join(" ")} failed (exit ${r.exit ?? r.failure})`);
};

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
		say(`Shared memories: a ${op} is in progress in .claude/.memories-repo — auto-push paused. Run ${RESOLVE_COMMAND} to finish it.`);
		return;
	}

	const uncommitted = uncommittedCount(repo);
	let unpushed = unpushedCount(repo);
	if (uncommitted === 0 && unpushed === 0) return;

	if (uncommitted > 0) {
		const bad = badNames(repo);
		if (bad.length > 0) {
			say("Shared memories: skipping auto-push — unconventional filename(s):");
			for (const f of bad) say(`  - ${f}`);
			say(RENAME_HINT);
			say(`Or run ${RESOLVE_COMMAND} to have Claude rename them.`);
			return;
		}

		stage(repo, ["add", "-A", "--", "memories/"]);

		// Whether to commit is git's call; the parsed list only words the message, so a
		// status it can't classify still commits (or fails loudly) instead of skipping.
		if (!git(repo, ["diff", "--cached", "--quiet", "--", "memories/"]).ok) {
			const msg = commitMessage(authorName(repo), stagedChanges(repo));
			const commit = git(repo, ["commit", "-m", msg, "--quiet"]);
			if (!commit.ok) {
				say("Shared memories: commit failed; will retry on next Stop.");
				detail(`${commit.stdout}${commit.stderr}`.replace(/\n$/, ""));
				return;
			}
			unpushed = unpushedCount(repo);
		}
	}

	if (unpushed === 0) return;

	syncToRemote(repo, process.env["MEMORIES_PUSH_ATTEMPTS"]);
});
