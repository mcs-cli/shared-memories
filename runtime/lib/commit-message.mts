import { gitLines } from "./git.mts";

export type Change =
	| { readonly kind: "add" | "update" | "remove"; readonly path: string }
	| { readonly kind: "rename"; readonly path: string; readonly from: string };

/** `memories/learning_a_b.md` → `learning_a_b`: the path prefix and extension carry nothing. */
const short = (p: string): string => p.replace(/^memories\//, "").replace(/\.md$/, "");

/** One `git diff --name-status` line. Copies (C) are new files as far as the team is concerned. */
export function parseNameStatus(line: string): Change | null {
	const [status = "", a = "", b = ""] = line.split("\t");
	switch (status[0]) {
		case "A":
		case "C":
			return a === "" ? null : { kind: "add", path: b || a };
		case "M":
		case "T":
			return a === "" ? null : { kind: "update", path: a };
		case "D":
			return a === "" ? null : { kind: "remove", path: a };
		case "R":
			return a === "" || b === "" ? null : { kind: "rename", path: b, from: a };
		default:
			return null;
	}
}

/** What is staged under memories/, in the order git lists it. */
export function stagedChanges(repo: string): Change[] {
	return gitLines(repo, ["diff", "--cached", "--name-status", "-M", "--", "memories/"])
		.map(parseNameStatus)
		.filter((c): c is Change => c !== null);
}

const MARK = { add: "+", update: "~", remove: "-", rename: ">" } as const;

const line = (c: Change): string =>
	c.kind === "rename" ? `${MARK.rename} ${short(c.from)} → ${short(c.path)}` : `${MARK[c.kind]} ${short(c.path)}`;

/**
 * `<who>: add learning_x` for a single change; otherwise a count summary in the
 * subject and one line per file in the body. Who and what, not which machine:
 * the date is already in the commit.
 */
export function commitMessage(who: string, changes: readonly Change[]): string {
	if (changes.length === 0) return `${who}: update memories`;
	if (changes.length === 1) {
		const [c] = changes as [Change];
		const what = c.kind === "rename" ? `rename ${short(c.from)} → ${short(c.path)}` : `${c.kind} ${short(c.path)}`;
		return `${who}: ${what}`;
	}
	const count = (k: Change["kind"]) => changes.filter((c) => c.kind === k).length;
	const parts = (
		[
			["add", "added"],
			["update", "updated"],
			["rename", "renamed"],
			["remove", "removed"],
		] as const
	)
		.map(([k, label]) => [count(k), label] as const)
		.filter(([n]) => n > 0)
		.map(([n, label]) => `${n} ${label}`);
	const order = { add: 0, update: 1, rename: 2, remove: 3 } as const;
	const body = [...changes].sort((x, y) => order[x.kind] - order[y.kind] || (x.path < y.path ? -1 : x.path > y.path ? 1 : 0)).map(line);
	return `${who}: ${parts.join(", ")}\n\n${body.join("\n")}`;
}
