import { git } from "./git.mts";
import { say } from "./hook-io.mts";

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

/** `printf '  %s\n' "$err"` indents the first line only. */
function detail(err: string): void {
	if (err !== "") process.stdout.write(`  ${err}\n`);
}

export function syncToRemote(repo: string, attemptsRaw: string | undefined): void {
	const attempts = pushAttempts(attemptsRaw);
	for (let attempt = 1; ; attempt++) {
		// LC_ALL=C pins git's language so the conflict match survives a non-English locale.
		const pull = git(repo, ["pull", "--rebase", "--autostash", "--quiet"], { env: { LC_ALL: "C" } });
		if (!pull.ok) {
			const err = pull.stderr.replace(/\n$/, "");
			if (/conflict/i.test(err)) {
				const abort = git(repo, ["rebase", "--abort"]);
				if (!abort.ok) {
					say(
						"Shared memories: rebase conflict AND --abort failed — repo may be in a half-rebased state. Resolve manually in .claude/.memories-repo/memories.",
					);
					detail(abort.stderr.replace(/\n$/, ""));
				} else {
					say("Shared memories: auto-push paused — rebase conflict. Resolve manually in .claude/.memories-repo/memories.");
				}
			} else {
				say("Shared memories: pull --rebase failed (likely auth or network). Will retry on next Stop.");
				detail(err);
			}
			return;
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
