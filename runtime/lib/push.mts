import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, gitLines } from "./git.mts";
import { detail, say } from "./hook-io.mts";
import { RESOLVE_COMMAND, USAGE_FILE } from "./naming.mts";

export function pushAttempts(raw: string | undefined): number {
	if (raw === undefined || raw === "") return 12;
	if (!/^\d+$/.test(raw)) return 12;
	const n = Number.parseInt(raw, 10);
	return n === 0 ? 1 : n;
}

/** Full jitter, capped at 1.5s, matching the bash `0.05 * 2^attempt` schedule. */
export function jitterMs(attempt: number, random = Math.random): number {
	const ceiling = Math.min(0.05 * 2 ** attempt, 1.5);
	return Math.round(random() * ceiling * 1000);
}

/** Synchronous: the hook must finish before the turn proceeds. */
function sleep(ms: number): void {
	if (ms <= 0) return;
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const CONFLICT_MARKER = /^(<{7}|\|{7}|={7}|>{7})( |$)/;

const unmergedPaths = (repo: string): string[] => gitLines(repo, ["diff", "--name-only", "--diff-filter=U"]);

const PAUSED = `Shared memories: auto-push paused — rebase conflict. Run ${RESOLVE_COMMAND} to merge it.`;

// Clones synced before the union rule existed still conflict on the usage file,
// and that must never pause the memory pushes behind it. Returns why the rebase
// has to be aborted, or null once it finished.
function finishUsageOnlyRebase(repo: string): string | null {
	let unmerged = unmergedPaths(repo);
	if (unmerged.length === 0) return PAUSED;
	for (; unmerged.length > 0; unmerged = unmergedPaths(repo)) {
		if (unmerged.some((f) => f !== USAGE_FILE)) return PAUSED;

		// Dropping the markers is exactly what `merge=union` writes, and it keeps rows
		// the memory pack appended before this read; one landing before the write is lost.
		const path = join(repo, USAGE_FILE);
		try {
			const lines = readFileSync(path, "utf8").split("\n");
			writeFileSync(path, lines.filter((l) => !CONFLICT_MARKER.test(l)).join("\n"));
		} catch {
			break;
		}
		if (!git(repo, ["add", "--", USAGE_FILE]).ok) break;
		if (git(repo, ["rebase", "--continue"], { env: { GIT_EDITOR: "true" } }).ok) return null;
	}
	return `Shared memories: could not finish the rebase after merging ${USAGE_FILE}. Will retry on next Stop.`;
}

function abortRebase(repo: string, why: string): void {
	const abort = git(repo, ["rebase", "--abort"]);
	if (!abort.ok) {
		say(
			`Shared memories: rebase conflict AND --abort failed — repo may be in a half-rebased state. Run ${RESOLVE_COMMAND} to finish it.`,
		);
		detail(abort.stderr.replace(/\n$/, ""));
	} else {
		say(why);
	}
}

export function syncToRemote(repo: string, attemptsRaw: string | undefined): void {
	const attempts = pushAttempts(attemptsRaw);
	for (let attempt = 1; ; attempt++) {
		// LC_ALL=C pins git's language so the conflict match survives a non-English locale.
		const pull = git(repo, ["pull", "--rebase", "--autostash", "--quiet"], { env: { LC_ALL: "C" } });
		if (!pull.ok) {
			const err = pull.stderr.replace(/\n$/, "");
			if (!/conflict/i.test(err)) {
				say("Shared memories: pull --rebase failed (likely auth or network). Will retry on next Stop.");
				detail(err);
				return;
			}
			const why = finishUsageOnlyRebase(repo);
			if (why !== null) {
				abortRebase(repo, why);
				return;
			}
		}

		const push = git(repo, ["push", "--quiet"]);
		if (push.ok) return;
		const err = push.stderr.replace(/\n$/, "");

		// Exit code, not message text: only 1 means the remote rejected the update.
		if (push.exit !== 1) {
			say("Shared memories: auto-push failed (not a rejected update — auth, network or repository). Will retry on next Stop.");
			detail(err);
			return;
		}
		if (attempt >= attempts) {
			say(`Shared memories: auto-push failed after ${attempt} attempt(s). Will retry on next Stop.`);
			detail(err);
			return;
		}
		sleep(jitterMs(attempt));
	}
}
