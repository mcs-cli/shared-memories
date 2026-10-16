import { gitLines } from "./git.mts";
import { isAllowedPath, USAGE_FILE } from "./naming.mts";

const dirtyLines = (repo: string): string[] => gitLines(repo, ["status", "--porcelain", "--", "memories/"]);

export function uncommittedCount(repo: string): number {
  return dirtyLines(repo).length;
}

/** Uncommitted memories a Stop should have pushed. The usage file is excluded: it gains rows after every Stop. */
export function lingeringCount(repo: string): number {
  return dirtyLines(repo).filter(l => l.slice(3) !== USAGE_FILE).length;
}

/** Dirty paths under memories/ that fail the naming rule: `{ diff --name-only HEAD ; untracked } | sort -u`. */
export function badNames(repo: string): string[] {
  const tracked = gitLines(repo, ["diff", "--name-only", "HEAD", "--", "memories/"]);
  const untracked = gitLines(repo, ["ls-files", "--others", "--exclude-standard", "--full-name", "--", "memories/"]);
  const dirty = [...new Set([...tracked, ...untracked])].sort();
  return dirty.filter(f => !isAllowedPath(f));
}
