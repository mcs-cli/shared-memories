import { spawnSync } from "node:child_process";

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
		.filter((l) => l !== "");
}

export function isWorkTree(dir: string): boolean {
	return git(dir, ["rev-parse", "--is-inside-work-tree"]).ok;
}

export function hasUpstream(dir: string): boolean {
	return git(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).ok;
}

export function unpushedCount(dir: string): number {
	if (!hasUpstream(dir)) return 0;
	const out = gitOut(dir, ["rev-list", "@{u}..HEAD", "--count"]);
	const n = Number.parseInt(out, 10);
	return Number.isNaN(n) ? 0 : n;
}

/** Whether the binary exists, the question `command -v git` asked. */
export function gitPresent(): boolean {
	const r = spawnSync("git", ["--version"], { stdio: "ignore" });
	return (r.error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT";
}
