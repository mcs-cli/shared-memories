import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { USAGE_FILE } from "./naming.mts";

export type GitRun = {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  /** The process's own exit status, or null when it never produced one. */
  readonly exit: number | null;
  /** Why there is no status: an errno if it never started, or the signal that killed it. */
  readonly failure: string | null;
};

export type GitOpts = {
  readonly env?: Readonly<Record<string, string>>;
  /** For calls the bash leaves unredirected, so git's own progress still reaches the user. */
  readonly inheritStderr?: boolean;
};

export function git(cwd: string, args: readonly string[], opts: GitOpts = {}): GitRun {
  const r = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    // `$(git ...)` was bounded only by memory. spawnSync defaults to 1MB, then
    // kills git with ENOBUFS, which `gitOut` turns into "" — a large enough
    // `status --porcelain` would read as "nothing pending".
    maxBuffer: Infinity,
    stdio: ["ignore", "pipe", opts.inheritStderr === true ? "inherit" : "pipe"],
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
  });
  const errno = (r.error as NodeJS.ErrnoException | undefined)?.code;
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    exit: r.status ?? null,
    failure: errno ?? r.signal ?? null,
  };
}

/** stdout trimmed, or "" on any failure — the `$(... || true)` shape. */
export function gitOut(cwd: string, args: readonly string[]): string {
  return git(cwd, args).stdout.trim();
}

export function gitLines(cwd: string, args: readonly string[]): string[] {
  return git(cwd, args)
    .stdout.split("\n")
    .filter(l => l !== "");
}

export function isWorkTree(dir: string): boolean {
  return git(dir, ["rev-parse", "--is-inside-work-tree"]).ok;
}

export function hasUpstream(dir: string): boolean {
  return git(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).ok;
}

/** Why the hook can't run, the operation left in progress, or null when the checkout is ready. */
export type Probe = "no-git" | "not-worktree" | "rebase" | "merge" | null;

/**
 * Whether git runs, `dir` is a checkout, and a rebase or merge was left half-finished there, in one
 * spawn. Staging mid-operation would mark the conflicted files resolved, markers and all, and commit
 * into the detached HEAD.
 */
export function probe(dir: string): Probe {
  const r = git(dir, [
    "rev-parse",
    "--is-inside-work-tree",
    "--path-format=absolute",
    "--git-path",
    "rebase-merge",
    "--git-path",
    "rebase-apply",
    "--git-path",
    "MERGE_HEAD",
  ]);
  if (r.failure === "ENOENT") return "no-git";
  if (!r.ok) return "not-worktree";
  const [rebaseMerge, rebaseApply, mergeHead] = r.stdout
    .trim()
    .split("\n")
    .slice(1)
    .map(p => existsSync(p));
  if (rebaseMerge === true || rebaseApply === true) return "rebase";
  return mergeHead === true ? "merge" : null;
}

/** Commits on HEAD the upstream lacks, or null when there is no upstream. */
export function ahead(dir: string): number | null {
  const r = git(dir, ["rev-list", "@{u}..HEAD", "--count"]);
  if (r.ok) {
    const n = Number.parseInt(r.stdout.trim(), 10);
    return Number.isNaN(n) ? 0 : n;
  }
  // rev-list fails for more than a missing upstream (an unborn HEAD has one and nothing ahead of it).
  return hasUpstream(dir) ? 0 : null;
}

/**
 * The name git will author the next commit with. When git has no identity the
 * commit itself fails, so the placeholder never reaches a subject.
 */
export function authorName(dir: string): string {
  return /^(.*?) </.exec(gitOut(dir, ["var", "GIT_AUTHOR_IDENT"]))?.[1]?.trim() || "unknown";
}

/** Whether git merges the usage file as a union, wherever the rule is set. */
export function hasUnionRule(dir: string): boolean {
  // check-attr resolves paths against the cwd, and `dir` may be memories/ itself.
  const top = gitOut(dir, ["rev-parse", "--show-toplevel"]);
  return top !== "" && gitOut(top, ["check-attr", "merge", "--", USAGE_FILE]).endsWith(": merge: union");
}

/** Whether the clone has the commit-graph turned off, which configure sets on every sync. */
export function commitGraphOff(dir: string): boolean {
  return gitOut(dir, ["config", "--type=bool", "--get", "core.commitGraph"]) === "false";
}

/** Whether the binary exists, the question `command -v git` asked. */
export function gitPresent(): boolean {
  const r = spawnSync("git", ["--version"], { stdio: "ignore" });
  return (r.error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT";
}
