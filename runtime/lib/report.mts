import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gitOut } from "./git.mts";
import { modifiedPaths, type Pending } from "./pending.mts";

/** Only these three break terminal autolinking of file:// URLs; the bash leaves the rest. */
export function urlEncodePath(p: string): string {
	return p.replaceAll(" ", "%20").replaceAll("#", "%23").replaceAll("?", "%3F");
}

/** `tr -d '\000-\010\013\014\016-\037\177'`. Tab, LF and CR are deliberately NOT in that set. */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function preview(repo: string, file: string): string {
	let text: string;
	try {
		text = readFileSync(join(repo, file), "utf8");
	} catch {
		return "";
	}
	// grep's [[:space:]] includes CR, so a CRLF file's blank line is blank here too.
	const first = text.split("\n").find((l) => !/^[\t\n\v\f\r ]*$/.test(l)) ?? "";
	// bash ${var:0:80} counts characters, so an astral char is one, not two.
	return Array.from(first.replace(CONTROL, "")).slice(0, 80).join("");
}

/**
 * The hash the last review printed, or "" when it cannot be read.
 * The bash was `tr -d '[:space:]' < "$f" 2>/dev/null || true`, so an unreadable
 * state file meant no dedupe rather than no report. Reading it is racy besides:
 * a concurrent session's Stop hook can remove it between the check and the read,
 * and losing the whole report to that is the one outcome this pack avoids.
 */
export function lastShownHash(stateFile: string): string {
	try {
		return readFileSync(stateFile, "utf8").replace(/\s/g, "");
	} catch {
		return "";
	}
}

export function canonicalState(p: Pending, headSha: string): string {
	const lines = [
		...p.untracked.filter(Boolean).map((f) => `NEW\t${f}`),
		...modifiedPaths(p).map((f) => `MOD\t${f}`),
		...p.deleted.filter(Boolean).map((f) => `DEL\t${f}`),
	];
	if (p.unpushed > 0 && headSha !== "") lines.push(`UNPUSHED\t${headSha}\t${p.unpushed}`);
	return lines.sort().join("\n");
}

export function hashState(state: string): string {
	return createHash("sha256").update(state).digest("hex");
}

export function describe(fileCount: number, unpushed: number): string {
	if (fileCount > 0 && unpushed > 0) {
		return `${fileCount} pending file(s) in memories/ and ${unpushed} unpushed commit(s)`;
	}
	if (fileCount > 0) return `${fileCount} pending file(s) in memories/`;
	return `${unpushed} unpushed commit(s)`;
}

export function renderReport(repo: string, p: Pending): string[] {
	const out: string[] = [];
	const news = p.untracked.filter(Boolean);
	const mods = modifiedPaths(p);
	const dels = p.deleted.filter(Boolean);
	out.push(`Shared memories [review mode]: ${describe(news.length + mods.length + dels.length, p.unpushed)}`);

	for (const f of news) {
		out.push(`+ NEW  <file://${urlEncodePath(join(repo, f))}>`);
		const pv = preview(repo, f);
		if (pv !== "") out.push(`       "${pv}"`);
	}

	for (const { added, deleted, path } of p.numstats) {
		if (path === "") continue;
		out.push(`~ MOD  <file://${urlEncodePath(join(repo, path))}>  (+${added} -${deleted})`);
		out.push(`       Diff: git -C .claude/.memories-repo diff -- ${path}`);
	}

	// Per-file `git log` is one process each; the cap keeps a large audit predictable.
	let idx = 0;
	for (const f of dels) {
		idx++;
		if (idx <= 20) {
			const last = gitOut(repo, ["log", "-1", "--format=%cr", "HEAD", "--", f]) || "?";
			out.push(`- DEL  ${f}  (last modified ${last})`);
		} else {
			out.push(`- DEL  ${f}`);
		}
		out.push(`       Recover: git -C .claude/.memories-repo checkout HEAD -- ${f}`);
	}

	out.push("");
	if (p.unpushed > 0) {
		out.push(`  Note: ${p.unpushed} local commit(s) not yet on the remote.`);
		out.push(
			"        Push: git -C .claude/.memories-repo pull --rebase --autostash && git -C .claude/.memories-repo push",
		);
		out.push("");
	}
	out.push("Approve all:           /approve-memories  [optional commit reason]");
	out.push("Discard local changes: git -C .claude/.memories-repo checkout -- memories/ \\");
	out.push("                       && git -C .claude/.memories-repo clean -f -- memories/");
	return out;
}
