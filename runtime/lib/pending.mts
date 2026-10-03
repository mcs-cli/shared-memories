import { gitLines } from "./git.mts";
import { ALLOWED_PATTERN } from "./naming.mts";

export function uncommittedCount(repo: string): number {
	return gitLines(repo, ["status", "--porcelain", "--", "memories/"]).length;
}

/** Dirty paths under memories/ that fail the naming rule: `{ diff --name-only HEAD ; untracked } | sort -u`. */
export function badNames(repo: string): string[] {
	const tracked = gitLines(repo, ["diff", "--name-only", "HEAD", "--", "memories/"]);
	const untracked = gitLines(repo, ["ls-files", "--others", "--exclude-standard", "--full-name", "--", "memories/"]);
	const dirty = [...new Set([...tracked, ...untracked])].filter((f) => f !== "").sort();
	return dirty.filter((f) => !ALLOWED_PATTERN.test(f));
}
