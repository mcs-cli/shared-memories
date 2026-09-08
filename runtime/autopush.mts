#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning
import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { git, gitPresent, isWorkTree, unpushedCount } from "./lib/git.mts";
import { failOpen, isJsonStream, readStdin, say, warn } from "./lib/hook-io.mts";
import { resolveMode } from "./lib/mode.mts";
import { badNames, collect, headSha, modifiedPaths, uncommittedCount } from "./lib/pending.mts";
import { memoriesRepo, projectRoot } from "./lib/paths.mts";
import { RENAME_HINT } from "./lib/naming.mts";
import { canonicalState, hashState, lastShownHash, renderReport } from "./lib/report.mts";
import { syncToRemote } from "./lib/push.mts";

const NAME = "memories_autopush";

/** A failed stage must not read as "nothing to commit"; let git speak and abort the turn. */
const stage = (repo: string, args: readonly string[]): void => {
	const r = git(repo, args, { inheritStderr: true });
	if (!r.ok) throw new Error(`git ${args.join(" ")} failed (exit ${r.exit ?? r.failure})`);
};

const today = (): string => {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

failOpen(NAME, () => {
	if (!gitPresent()) return warn(`${NAME}: git not found; skipping`);
	if (!isJsonStream(readStdin())) return warn(`${NAME}: stdin is not valid JSON; skipping`);

	const project = projectRoot(import.meta.dirname);
	const repo = memoriesRepo(project);
	if (!isWorkTree(repo)) {
		return warn(`${NAME}: ${repo} is not a git worktree; skipping (project_root=${project})`);
	}

	const { mode } = resolveMode(process.env["MEMORIES_AUTOPUSH_MODE"]);
	const reviewState = join(repo, ".review-shown");

	const uncommitted = uncommittedCount(repo);
	let unpushed = unpushedCount(repo);

	if (uncommitted === 0 && unpushed === 0) {
		if (mode === "review" && existsSync(reviewState)) rmSync(reviewState, { force: true });
		return;
	}

	const pending = collect(repo, uncommitted, unpushed);

	if (uncommitted > 0) {
		const bad = badNames(repo, pending.untracked);
		if (bad.length > 0) {
			say("Shared memories: skipping auto-push — unconventional filename(s):");
			for (const f of bad) say(`  - ${f}`);
			say(RENAME_HINT);
			return;
		}
	}

	if (mode === "review") {
		const state = canonicalState(pending, pending.unpushed > 0 ? headSha(repo) : "");
		if (state === "") {
			// Renames, typechanges, conflicts, or an unresolvable HEAD reach none of the filters.
			if (uncommitted > 0) {
				say(`Shared memories [review mode]: ${uncommitted} unclassified pending change(s) in memories/`);
				say("  Inspect: git -C .claude/.memories-repo status -- memories/");
			}
			if (unpushed > 0) {
				say(
					`Shared memories [review mode]: ${unpushed} unpushed commit(s) (HEAD unresolvable — repo may be detached or mid-rebase)`,
				);
				say("  Inspect: git -C .claude/.memories-repo status");
			}
			return;
		}

		const hash = hashState(state);
		if (lastShownHash(reviewState) === hash) return;

		for (const line of renderReport(repo, pending)) say(line);

		// Atomic, so a killed hook cannot leave an empty state file behind.
		writeFileSync(`${reviewState}.tmp`, `${hash}\n`);
		renameSync(`${reviewState}.tmp`, reviewState);
		return;
	}

	let committed = false;

	if (uncommitted > 0) {
		if (mode === "auto") {
			if (pending.deleted.length > 0) {
				say(`Shared memories: ${pending.deleted.length} deleted memory file(s) left for manual review (not auto-pushed):`);
				for (const f of pending.deleted) say(`  - ${f}`);
				say("If intentional (e.g. after memory-audit), approve them:");
				say("  /approve-memories audit cleanup");
			}
			const stageable = [...new Set([...modifiedPaths(pending), ...pending.untracked])].filter(Boolean).sort();
			for (const f of stageable) stage(repo, ["add", "--", f]);
		} else {
			stage(repo, ["add", "-A", "--", "memories/"]);
		}

		if (!git(repo, ["diff", "--cached", "--quiet", "--", "memories/"]).ok) {
			const suffix = mode === "full" && pending.deleted.length > 0 ? " (includes deletions)" : "";
			const msg = `auto: memories from ${hostname().split(".")[0]} ${today()}${suffix}`;
			const commit = git(repo, ["commit", "-m", msg, "--quiet"]);
			if (commit.ok) {
				committed = true;
			} else {
				say("Shared memories: commit failed; will retry on next Stop.");
				const err = `${commit.stdout}${commit.stderr}`.replace(/\n$/, "");
				if (err !== "") process.stdout.write(`  ${err}\n`);
				return;
			}
		}
	}

	if (committed) unpushed = unpushedCount(repo);
	if (unpushed === 0) return;

	syncToRemote(repo, process.env["MEMORIES_PUSH_ATTEMPTS"]);
});
