#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning
import { authorName, git, gitPresent, isWorkTree, operationInProgress, unpushedCount } from "./lib/git.mts";
import { commitMessage, stagedChanges } from "./lib/commit-message.mts";
import { failOpen, isJsonStream, readStdin, say, warn } from "./lib/hook-io.mts";
import { badNames, uncommittedCount } from "./lib/pending.mts";
import { memoriesRepo, projectRoot } from "./lib/paths.mts";
import { RENAME_HINT } from "./lib/naming.mts";
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
		say(`Shared memories: a ${op} is in progress in .claude/.memories-repo — auto-push paused. Run /resolve-memories to finish it.`);
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
			say("Or run /resolve-memories to have Claude rename them.");
			return;
		}

		stage(repo, ["add", "-A", "--", "memories/"]);

		if (!git(repo, ["diff", "--cached", "--quiet", "--", "memories/"]).ok) {
			const msg = commitMessage(authorName(repo), stagedChanges(repo));
			const commit = git(repo, ["commit", "-m", msg, "--quiet"]);
			if (!commit.ok) {
				say("Shared memories: commit failed; will retry on next Stop.");
				const err = `${commit.stdout}${commit.stderr}`.replace(/\n$/, "");
				if (err !== "") process.stdout.write(`  ${err}\n`);
				return;
			}
			unpushed = unpushedCount(repo);
		}
	}

	if (unpushed === 0) return;

	syncToRemote(repo, process.env["MEMORIES_PUSH_ATTEMPTS"]);
});
