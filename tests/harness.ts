import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

export type HookName = "pull" | "autopush" | "announce";

const HOOK_FILE: Record<HookName, string> = {
	pull: "pull.mts",
	autopush: "autopush.mts",
	announce: "announce.mts",
};

const EVENT: Record<HookName, string> = {
	pull: "SessionStart",
	autopush: "Stop",
	announce: "PostToolUse",
};

const GOLDEN_DIR = join(REPO, "tests", "golden");
const slug = (name: string): string => name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();

/**
 * Goldens outlive the run that recorded them, so anything that varies by
 * machine, day or temp path is replaced by a placeholder. Everything else
 * stays byte-exact.
 */
export function normalizeRun(r: RunResult, root: string): RunResult {
	const host = hostname().split(".")[0] ?? "";
	const user = userInfo().username;
	const scrub = (t: string): string =>
		t
			.split(root)
			.join("<TMP>")
			.replace(/\.memories-migration-\d{8}-\d{6}/g, ".memories-migration-<TS>")
			.replace(/\(last modified [^)]*\)/g, "(last modified <REL>)")
			.replace(/\d{4}-\d{2}-\d{2}/g, "<DATE>")
			.replace(/(deleted by )[0-9a-f]{7,40}/g, "$1<SHA>")
			.split(host)
			.join("<HOST>")
			.split(user)
			.join("<USER>");
	return { stdout: scrub(r.stdout), stderr: scrub(r.stderr), code: r.code, git: scrub(r.git) };
}

export function readGolden(name: string): RunResult | null {
	try {
		return JSON.parse(readFileSync(join(GOLDEN_DIR, `${slug(name)}.json`), "utf8")) as RunResult;
	} catch {
		return null;
	}
}

export function writeGolden(name: string, r: RunResult): void {
	mkdirSync(GOLDEN_DIR, { recursive: true });
	writeFileSync(join(GOLDEN_DIR, `${slug(name)}.json`), `${JSON.stringify(r, null, 2)}\n`);
}

export type RunResult = {
	readonly stdout: string;
	readonly stderr: string;
	readonly code: number;
	readonly git: string;
};

export type Fixture = {
	readonly name: string;
	readonly hook: HookName;
	readonly env?: Readonly<Record<string, string>>;
	readonly stdin?: string;
	/** Mutates the memories checkout to produce the pending state under test. */
	readonly setup?: (repo: string, project: string) => void;
	/** Runs before each implementation, after the tree is restored. */
	readonly beforeEach?: (repo: string, project: string) => void;
	/** Number of back-to-back invocations; the last one is compared. */
	readonly runs?: number;
	/** Mutates state between invocations, so a reprint-on-change can be exercised. */
	readonly betweenRuns?: (repo: string, project: string) => void;
	/** Non-vacuity: the bash side must actually produce this, or the fixture proves nothing. */
	readonly expect?: RegExp;
	/** The abort diagnostic is a documented stderr-only deviation; compare the rest of stderr. */
	readonly abortsDiffer?: boolean;
};

/**
 * Fixture commits are stamped at a fixed past date. `%cr` renders relative to
 * NOW, so commits made "just now" render as "0 seconds ago" for one run and
 * "1 second ago" for the other — an intermittent diff with no defect behind it.
 */
const FIXTURE_DATE = "2026-01-15T12:00:00+00:00";

/**
 * Nothing the suite compares may depend on the developer's environment.
 *
 * `LC_ALL` was deliberately left unpinned while the bash was still the reference:
 * `LC_ALL=C` switches `${var:0:80}` from characters to bytes, so pinning it would
 * have moved the reference rather than steadied it, and the truncation fixtures
 * said so immediately. The bash is gone and the goldens are recordings now, so
 * all the locale still reaches is git's own prose and collation -- and five
 * goldens quote git's English verbatim, which a translated git breaks.
 */
const HERMETIC = {
	LC_ALL: "C",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
	GIT_AUTHOR_NAME: "Fixture",
	GIT_AUTHOR_EMAIL: "fixture@example.com",
	GIT_COMMITTER_NAME: "Fixture",
	GIT_COMMITTER_EMAIL: "fixture@example.com",
	GIT_AUTHOR_DATE: FIXTURE_DATE,
	GIT_COMMITTER_DATE: FIXTURE_DATE,
} as const;

/**
 * `tsconfig.json` is JSONC by convention and `JSON.parse` is not, so reading it
 * strictly means a comment or a trailing comma turns a coverage gate into a
 * parse error that names neither. Scans in one pass so that `//`, `/*` and a
 * trailing `,` inside a string literal are left alone.
 */
export function stripJsonComments(text: string): string {
	const out: string[] = [];
	let inString = false;
	let inLine = false;
	let inBlock = false;

	for (let i = 0; i < text.length; i++) {
		const c = text[i] as string;
		const next = text[i + 1];

		if (inLine) {
			if (c === "\n") {
				inLine = false;
				out.push(c);
			}
			continue;
		}
		if (inBlock) {
			if (c === "*" && next === "/") {
				inBlock = false;
				i++;
			}
			continue;
		}
		if (inString) {
			out.push(c);
			if (c === "\\") {
				out.push(text[i + 1] ?? "");
				i++;
			} else if (c === '"') {
				inString = false;
			}
			continue;
		}
		if (c === '"') {
			inString = true;
			out.push(c);
			continue;
		}
		if (c === "/" && next === "/") {
			inLine = true;
			i++;
			continue;
		}
		if (c === "/" && next === "*") {
			inBlock = true;
			i++;
			continue;
		}
		// A structural comma before a closer. Walking back over whitespace can only
		// reach a comma that is structural: a comma ending a string is followed by
		// that string's own closing quote, never by `}` or `]`.
		if (c === "}" || c === "]") {
			let j = out.length - 1;
			while (j >= 0 && /\s/.test(out[j] as string)) j--;
			if (j >= 0 && out[j] === ",") out.splice(j, 1);
		}
		out.push(c);
	}
	return out.join("");
}

const entries = (dir: string): string[] => {
	try {
		return readdirSync(dir).sort();
	} catch {
		return [];
	}
};

export const git = (cwd: string, ...args: string[]): string => {
	try {
		return execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			maxBuffer: Infinity,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, ...HERMETIC },
		}).trim();
	} catch {
		return "";
	}
};

/** A remote that rejects every push with exit 1, so the retry budget is actually spent. */
export function rejectAllPushes(remote: string): void {
	const hook = join(remote, "hooks", "pre-receive");
	writeFileSync(hook, "#!/bin/sh\nexit 1\n");
	chmodSync(hook, 0o755);
}

export const memory = (repo: string, name: string, body = "A shared lesson.\n"): string => {
	const path = join(repo, "memories", name);
	writeFileSync(path, body);
	return path;
};

/** A bare remote plus a checkout with one committed memory, tracking origin. */
export function makeProject(): { root: string; work: string; project: string; repo: string; remote: string } {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "sm-")));
	const work = join(root, "work");
	mkdirSync(work, { recursive: true });
	const remote = join(work, "remote.git");
	const project = join(work, "project");
	const repo = join(project, ".claude", ".memories-repo");

	execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
	mkdirSync(join(repo, "memories"), { recursive: true });
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.email", "t@example.com");
	git(repo, "config", "user.name", "Test");
	git(repo, "remote", "add", "origin", remote);
	memory(repo, "learning_seed_topic.md", "Seed memory.\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-qm", "seed");
	git(repo, "push", "-q", "-u", "origin", "main");

	// The ancestor Node resolves module type from. "commonjs" is the hostile case.
	writeFileSync(join(project, "package.json"), '{"name":"consumer","type":"commonjs"}\n');
	mkdirSync(join(project, ".claude", "hooks", "shared-memories"), { recursive: true });
	execFileSync("ln", ["-sfn", ".memories-repo/memories", join(project, ".claude", "memories")]);
	return { root, work, project, repo, remote };
}

/** The layout mcs produces: the entry point, and the library beside it. */
function install(project: string, hook: HookName): void {
	const hooks = join(project, ".claude", "hooks", "shared-memories");
	mkdirSync(hooks, { recursive: true });
	cpSync(join(REPO, "runtime", HOOK_FILE[hook]), join(hooks, HOOK_FILE[hook]));
	chmodSync(join(hooks, HOOK_FILE[hook]), 0o755);
	cpSync(join(REPO, "runtime", "lib"), join(hooks, "lib"), { recursive: true });
}

/** Executed directly. mcs prefixes the declared `hookInterpreter` instead, which
 *  manifest.test.ts pins to the same command as the shebang, so the two agree. */
function invoke(project: string, hook: HookName, fx: Fixture): Omit<RunResult, "git"> {
	const payload = fx.stdin ?? JSON.stringify({ hook_event_name: EVENT[hook], session_id: "s1", cwd: project });
	const r = spawnSync(join(project, ".claude", "hooks", "shared-memories", HOOK_FILE[hook]), [], {
		cwd: project,
		input: payload,
		encoding: "utf8",
		maxBuffer: Infinity,
		timeout: 180_000,
		env: { ...process.env, ...HERMETIC, ...fx.env },
	});
	return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? -1 };
}

export function gitState(repo: string): string {
	const upstream = git(repo, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
	return [
		// Repo-wide, deliberately: a snapshot scoped to memories/ is blind to the
		// root-level damage the `-- memories/` pathspec exists to prevent.
		`status-all: ${git(repo, "status", "--porcelain").split("\n").filter(Boolean).sort().join(" | ")}`,
		`log-all: ${git(repo, "log", "--format=%s").split("\n").filter(Boolean).join(" | ")}`,
		`tracked-all: ${git(repo, "ls-files").split("\n").filter(Boolean).sort().join(" | ")}`,
		`status: ${git(repo, "status", "--porcelain", "--", "memories/").split("\n").filter(Boolean).sort().join(" | ")}`,
		`log: ${git(repo, "log", "--format=%s", "--", "memories/").split("\n").filter(Boolean).join(" | ")}`,
		`upstream: ${upstream || "(none)"}`,
		`unpushed: ${upstream ? git(repo, "rev-list", "@{u}..HEAD", "--count") : "0"}`,
		`tracked: ${git(repo, "ls-files", "--", "memories/").split("\n").filter(Boolean).sort().join(" | ")}`,
		`review-shown: ${existsSync(join(repo, ".review-shown")) ? "present" : "absent"}`,
		`worktree: ${entries(join(repo, "memories")).join(" ")}`,
		`remote-log: ${git(repo, "log", "--format=%s", "origin/main").split("\n").filter(Boolean).join(" | ")}`,
		`remote-files: ${git(repo, "ls-tree", "-r", "--name-only", "origin/main").split("\n").filter(Boolean).sort().join(" | ")}`,
	].join("\n");
}

export function runHook(fx: Fixture): RunResult {
	const { root, project, repo } = makeProject();
	try {
		fx.setup?.(repo, project);
		install(project, fx.hook);
		fx.beforeEach?.(repo, project);
		let last = invoke(project, fx.hook, fx);
		for (let i = 1; i < (fx.runs ?? 1); i++) {
			fx.betweenRuns?.(repo, project);
			last = invoke(project, fx.hook, fx);
		}
		return normalizeRun({ ...last, git: gitState(repo) }, root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

export type ScriptName = "doctor-memories" | "doctor-memories-remote";

export type ScriptFixture = {
	readonly name: string;
	readonly script: ScriptName;
	readonly setup?: (repo: string, project: string) => void;
	readonly expectCode?: number;
};

/**
 * Pack scripts are executed by mcs directly (ScriptRunner passes no arguments and
 * chmods first), so here the shebang really is what selects the interpreter —
 * unlike hooks, which mcs runs through their declared `hookInterpreter`.
 */
export function runScript(fx: ScriptFixture): RunResult {
	const { root, project, repo } = makeProject();
	try {
		fx.setup?.(repo, project);
		const r = spawnSync(join(REPO, "scripts", `${fx.script}.ts`), [], {
			encoding: "utf8",
			maxBuffer: Infinity,
			timeout: 180_000,
			env: { ...process.env, ...HERMETIC, MCS_PROJECT_PATH: project },
		});
		return normalizeRun(
			{ stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? -1, git: gitState(repo) },
			root,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

export type ConfigureFixture = {
	readonly name: string;
	/** Seeds the bare remote through a scratch clone before the project is shaped. */
	readonly seed?: (clone: string) => void;
	/** Shapes <project>/.claude before configure runs. */
	readonly pre?: (project: string, claude: string) => void;
	readonly env?: Readonly<Record<string, string>>;
	readonly expectCode?: number;
	readonly expect?: RegExp;
	/** Seed a remote whose branch carries no memories/ tree at all. */
	readonly emptyRemote?: boolean;
	/** Pass MCS_PROJECT_PATH with a trailing slash; bash concatenates, join() would normalise. */
	readonly trailingSlash?: boolean;
	/** Skipped when running as root, where the fixture's premise does not hold. */
	readonly skipAsRoot?: boolean;
	/**
	 * A deliberate departure from the recorded bash behaviour. The golden keeps
	 * recording what the bash did; this states what we now do instead, and why.
	 */
	readonly deviation?: {
		readonly reason: string;
		readonly stdout?: (recorded: string) => string;
		readonly code?: number;
	};
};

/** The migration backup embeds a HH:MM:SS stamp, so the two runs cannot share it. */
export function runConfigure(fx: ConfigureFixture): RunResult {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "sm-cfg-")));
	try {
		const work = join(root, "work");
		mkdirSync(work, { recursive: true });
		const remote = join(work, "remote.git");
		const project = join(work, "project");
		const claude = join(project, ".claude");

		execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
		const scratch = join(work, "scratch");
		git(work, "clone", "-q", remote, scratch);
		git(scratch, "config", "user.email", "t@example.com");
		git(scratch, "config", "user.name", "Test");
		if (fx.emptyRemote === true) {
			writeFileSync(join(scratch, "README.md"), "no memories dir\n");
		} else {
			mkdirSync(join(scratch, "memories"), { recursive: true });
			writeFileSync(join(scratch, "memories", "learning_shared_seed.md"), "Shared seed.\n");
		}
		git(scratch, "add", "-A");
		git(scratch, "commit", "-qm", "seed");
		git(scratch, "push", "-q", "-u", "origin", "main");
		fx.seed?.(scratch);
		rmSync(scratch, { recursive: true, force: true });

		mkdirSync(claude, { recursive: true });
		fx.pre?.(project, claude);

		const r = spawnSync(join(REPO, "scripts", "configure-memories.ts"), [], {
			encoding: "utf8",
			timeout: 180_000,
			env: {
				...process.env,
				...HERMETIC,
				MCS_PROJECT_PATH: fx.trailingSlash === true ? `${project}/` : project,
				MCS_RESOLVED_MEMORIES_REPO_URL: remote,
				MCS_RESOLVED_MEMORIES_BRANCH: "main",
				...fx.env,
			},
		});
		const listing = `${entries(claude).join(" ")}\n${entries(join(claude, "memories")).join(" ")}`;
		return normalizeRun(
			{ stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? -1, git: listing.trim() },
			root,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
