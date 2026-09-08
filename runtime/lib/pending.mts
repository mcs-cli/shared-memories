import { gitLines, gitOut, unpushedCount } from "./git.mts";
import { ALLOWED_PATTERN } from "./naming.mts";

export type NumStat = { readonly added: string; readonly deleted: string; readonly path: string };

export type Pending = {
	readonly uncommitted: number;
	readonly unpushed: number;
	readonly untracked: readonly string[];
	readonly numstats: readonly NumStat[];
	readonly deleted: readonly string[];
};

/** The paths `git diff --numstat --diff-filter=AM` reported, derived rather than stored. */
export const modifiedPaths = (p: Pending): string[] => p.numstats.map((n) => n.path).filter(Boolean);

export function uncommittedCount(repo: string): number {
	return gitLines(repo, ["status", "--porcelain", "--", "memories/"]).length;
}

export function collect(repo: string, uncommitted: number, unpushed: number): Pending {
	if (uncommitted === 0) {
		return { uncommitted, unpushed, untracked: [], numstats: [], deleted: [] };
	}
	const untracked = gitLines(repo, ["ls-files", "--others", "--exclude-standard", "--full-name", "--", "memories/"]);
	const numstats = gitLines(repo, ["diff", "--numstat", "--diff-filter=AM", "HEAD", "--", "memories/"])
		.map((l) => l.split("\t"))
		.filter((p): p is [string, string, string] => p.length === 3)
		.map(([added, deleted, path]) => ({ added, deleted, path }));
	return {
		uncommitted,
		unpushed,
		untracked,
		numstats,
		deleted: gitLines(repo, ["diff", "--name-only", "--diff-filter=D", "HEAD", "--", "memories/"]),
	};
}

/** `{ diff --name-only HEAD ; untracked } | sort -u`, then the guardrail. */
export function badNames(repo: string, untracked: readonly string[]): string[] {
	const tracked = gitLines(repo, ["diff", "--name-only", "HEAD", "--", "memories/"]);
	const dirty = [...new Set([...tracked, ...untracked])].filter((f) => f !== "").sort();
	return dirty.filter((f) => !ALLOWED_PATTERN.test(f));
}

export function recountUnpushed(repo: string): number {
	return unpushedCount(repo);
}

export function headSha(repo: string): string {
	return gitOut(repo, ["rev-parse", "HEAD"]);
}
