#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { git, gitLines, gitOut, gitPresent, isWorkTree } from "../runtime/lib/git.mts";
import { ALLOWED_PATTERN } from "../runtime/lib/naming.mts";

const out = (line: string) => process.stdout.write(`${line}\n`);
const err = (line: string) => process.stderr.write(`${line}\n`);

const project = process.env["MCS_PROJECT_PATH"] ?? "";
const link = `${project}/.claude/memories`;
const repoDir = `${project}/.claude/.memories-repo`;
const repoUrl = process.env["MCS_RESOLVED_MEMORIES_REPO_URL"] ?? "";
const branch = process.env["MCS_RESOLVED_MEMORIES_BRANCH"] || "main";

let migrationBackup = "";
let createdRepoDir = false;

const isSymlink = (p: string): boolean => {
	try {
		return lstatSync(p).isSymbolicLink();
	} catch {
		return false;
	}
};
const exists = (p: string): boolean => {
	try {
		lstatSync(p);
		return true;
	} catch {
		return false;
	}
};
const isDir = (p: string): boolean => {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
};
const entries = (p: string): string[] => {
	try {
		return readdirSync(p).sort();
	} catch {
		return [];
	}
};

function linkMemories(): void {
	if (exists(link)) unlinkSync(link);
	symlinkSync(".memories-repo/memories", link);
	// A dangling link would survive long enough for the import below to move files into nothing.
	if (!isDir(link)) {
		err(`ERROR: ${link} → .memories-repo/memories points to a missing directory.`);
		err(`  The sparse checkout at ${repoDir} did not materialize memories/.`);
		throw new Error("link target missing");
	}
}

/** Never leave an engineer with no memories: put the backup back if setup failed after moving it. */
function restoreBackup(): void {
	if (createdRepoDir && isDir(repoDir) && !existsSync(join(repoDir, ".git"))) {
		rmSync(repoDir, { recursive: true, force: true });
	}
	// A dangling symlink counts as "not present" here, and must be swept before the move.
	if (isSymlink(link) && !existsSync(link)) unlinkSync(link);
	if (migrationBackup !== "" && isDir(migrationBackup) && !exists(link)) {
		err(`Setup failed — restoring your original memories from ${migrationBackup} to ${link}`);
		try {
			renameSync(migrationBackup, link);
		} catch {
			err("ERROR: Automatic restore failed. Your memories are preserved at:");
			err(`  ${migrationBackup}`);
			err(`Move this directory back to ${link} manually.`);
		}
	}
}

function stamp(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function main(): void {
	if (repoUrl === "") {
		err("MEMORIES_REPO_URL not resolved; skipping memories clone.");
		process.exit(0);
	}
	if (project === "") {
		err("MCS_PROJECT_PATH is not set; cannot locate the project's .claude directory.");
		process.exit(1);
	}
	if (!gitPresent()) {
		err("git is required for mcs-shared-memories setup but was not found on PATH.");
		process.exit(1);
	}

	// Case 1: healthy.
	if (isSymlink(link) && isWorkTree(link)) {
		out("Shared memories already linked — leaving as-is.");
		process.exit(0);
	}

	// Preflight before any filesystem mutation, so a bad remote leaves memories untouched.
	const probe = git(process.cwd(), ["ls-remote", "--exit-code", "--heads", repoUrl, branch]);
	if (!probe.ok) {
		err("Cannot set up shared memories — remote is unreachable or branch missing.");
		err(`  remote: ${repoUrl}`);
		err(`  branch: ${branch}`);
		err(`  error:  ${probe.stderr.replace(/\n$/, "") || (probe.failure ?? "")}`);
		err("");
		err("Common causes:");
		err("  - SSH key not loaded — try: ssh-add ~/.ssh/<your-key>");
		err("  - Network offline or VPN disconnected");
		err("  - Access revoked on the shared repo");
		err(`  - Branch '${branch}' does not exist on the remote`);
		err("");
		err(`Your existing memories at ${link} have not been touched.`);
		process.exit(1);
	}

	// Case 2: a real directory where the symlink belongs.
	if (exists(link) && !isSymlink(link)) {
		if (!isDir(link)) {
			err(`${link} exists but is not a directory or symlink; refusing to touch it.`);
			process.exit(0);
		}
		const contents = entries(link);
		if (contents.length === 0) {
			out(`Found empty ${link} — removing and proceeding with fresh setup.`);
			rmdirSync(link);
		} else {
			migrationBackup = `${project}/.claude/.memories-migration-${stamp()}`;
			out(`Found pre-existing ${link} with ${contents.length} entr(y/ies) — staging for migration...`);
			out(`  → backing up to ${migrationBackup}`);
			renameSync(link, migrationBackup);
		}
	}

	if (existsSync(join(repoDir, ".git")) && isWorkTree(repoDir)) {
		// Case 3: checkout is live, the link is missing or broken.
		out(`Memories checkout present, (re)linking ${link} → .memories-repo/memories...`);
		if (exists(link)) unlinkSync(link);
		linkMemories();
	} else if (exists(repoDir)) {
		// Case 4: something is there but it is not a checkout.
		err(`${repoDir} exists but is not a valid git checkout; refusing to touch it.`);
		err("Delete it manually and re-run `mcs sync` to re-clone.");
		process.exit(0);
	} else {
		// Case 5: first-time setup.
		out(`Cloning shared memories (branch '${branch}', sparse) into ${repoDir}...`);
		createdRepoDir = true;
		const clone = git(
			process.cwd(),
			["clone", "--sparse", "--filter=blob:none", "--branch", branch, "--single-branch", repoUrl, repoDir],
			{ inheritStderr: true },
		);
		// The bash has no handler here: `set -e` fires the ERR trap, which restores
		// the backup, and the script exits with git's own status.
		if (!clone.ok) {
			restoreBackup();
			process.exit(clone.exit ?? 1);
		}
		// Materialises memories/; the mkdir below would otherwise mask its failure.
		const sparse = git(repoDir, ["sparse-checkout", "set", "memories"], { inheritStderr: true });
		if (!sparse.ok) {
			restoreBackup();
			process.exit(sparse.exit ?? 1);
		}
		// A bootstrap branch has no memories/ tree, and the link would dangle.
		mkdirSync(join(repoDir, "memories"), { recursive: true });
		linkMemories();
	}

	let imported = 0;
	let skipped = 0;
	const resurrected: string[] = [];

	if (migrationBackup !== "" && isDir(migrationBackup)) {
		// Blobless clones keep every commit and tree, so this is offline and fast.
		const deletedHistory = new Set(
			gitLines(repoDir, ["log", "--all", "--diff-filter=D", "--name-only", "--format=", "--", "memories/"]),
		);

		for (const name of entries(migrationBackup)) {
			const from = join(migrationBackup, name);
			// `[ -f "$f" ] || continue` is false for a dangling symlink rather than fatal.
			let entry: ReturnType<typeof statSync>;
			try {
				entry = statSync(from);
			} catch {
				continue;
			}
			if (!entry.isFile()) continue;
			const target = join(link, name);
			if (exists(target)) {
				skipped++;
			} else if (deletedHistory.has(`memories/${name}`)) {
				resurrected.push(name);
			} else {
				renameSync(from, target);
				imported++;
			}
		}

		if (entries(migrationBackup).length === 0) {
			rmdirSync(migrationBackup);
			out(`Migration: imported ${imported} local memory file(s); ${skipped} conflict(s) (shared version kept).`);
		} else {
			out(
				`Migration: imported ${imported} local memory file(s); ${skipped} conflict(s) (shared version kept); ${resurrected.length} previously-deleted file(s) held back.`,
			);
			out(`  Kept at ${migrationBackup} for review.`);
		}
	}

	if (resurrected.length > 0) {
		out("");
		out(`Held back ${resurrected.length} file(s) previously deleted from the shared repo:`);
		let idx = 0;
		for (const name of resurrected) {
			idx++;
			out(`  - ${name}`);
			if (idx <= 20) {
				const why = gitOut(repoDir, ["log", "-1", "--format=%h %s", "--diff-filter=D", "--", `memories/${name}`]);
				if (why !== "") out(`      deleted by ${why}`);
			}
		}
		out("");
		out("Someone removed these deliberately, so they were not re-imported or pushed.");
		out(`To re-add one anyway: cp '${migrationBackup}/<file>' '${link}/<file>'`);
	}

	if (imported > 0) {
		const untracked = gitLines(repoDir, ["ls-files", "--others", "--exclude-standard", "--full-name", "--", "memories/"]);
		const good = untracked.filter((f) => ALLOWED_PATTERN.test(f));
		const bad = untracked.filter((f) => !ALLOWED_PATTERN.test(f));

		if (good.length > 0) {
			for (const f of good) {
				const add = git(repoDir, ["add", "--", f], { inheritStderr: true });
				if (!add.ok) process.exit(add.exit ?? 1);
			}
			// Unchecked, the push below succeeds vacuously and reports one that never happened.
			const commit = git(repoDir, ["commit", "-m", `auto: migrate local memories from ${hostname().split(".")[0]}`, "--quiet"], {
				inheritStderr: true,
			});
			if (!commit.ok) process.exit(commit.exit ?? 1);
			if (git(repoDir, ["pull", "--rebase", "--autostash", "--quiet"]).ok) {
				if (git(repoDir, ["push", "--quiet"]).ok) {
					out("Pushed migrated memories to the shared branch.");
				} else {
					out("Migrated memories committed locally; push failed (auth or network?). The next Stop hook will retry.");
				}
			} else {
				git(repoDir, ["rebase", "--abort"]);
				out("Migrated memories committed locally; rebase conflict blocked the push. The next Stop hook will retry.");
			}
		}

		if (bad.length > 0) {
			out("Note: these migrated files don't match the naming convention and were left untracked:");
			for (const f of bad) out(`  - ${f}`);
			out(
				"Rename them to memories/learning_<topic>_<specific>.md or memories/decision_<domain>_<topic>.md so they can be shared with the team.",
			);
		}
	}

	// Dotfiles are excluded because the bash counted with an `ls *.md` glob.
	const mds = entries(link).filter((f) => !f.startsWith(".") && f.endsWith(".md"));
	out(`Done. ${mds.length} memory file(s) available at ${link}.`);
}

try {
	main();
} catch (e) {
	restoreBackup();
	const detail = e instanceof Error ? e.message : String(e);
	if (detail !== "link target missing") err(`configure-memories: ${detail}`);
	process.exit(1);
}
