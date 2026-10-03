import { gitLines } from "./git.mts";

export type Change =
	| { readonly kind: "add" | "update" | "remove"; readonly path: string }
	| { readonly kind: "rename"; readonly path: string; readonly from: string };

/** Every kind once: its body mark and summary word, in the order the body lists them. */
const KINDS = {
	add: { mark: "+", past: "added" },
	update: { mark: "~", past: "updated" },
	rename: { mark: ">", past: "renamed" },
	remove: { mark: "-", past: "removed" },
} as const;
const ORDER = Object.keys(KINDS) as Change["kind"][];

/** `memories/learning_a_b.md` → `learning_a_b`: the path prefix and extension carry nothing. */
const short = (p: string): string => p.replace(/^memories\//, "").replace(/\.md$/, "");

const names = (c: Change): string => (c.kind === "rename" ? `${short(c.from)} → ${short(c.path)}` : short(c.path));

/** One body line per change, `+ learning_a_b`. */
export const changeLine = (c: Change): string => `${KINDS[c.kind].mark} ${names(c)}`;

/** One `git diff --name-status` line. Copies (C) are new files as far as the team is concerned. */
export function parseNameStatus(line: string): Change | null {
	const [status = "", a = "", b = ""] = line.split("\t");
	if (a === "") return null;
	switch (status[0]) {
		case "A":
		case "C":
			return { kind: "add", path: b || a };
		case "M":
		case "T":
			return { kind: "update", path: a };
		case "D":
			return { kind: "remove", path: a };
		case "R":
			return b === "" ? null : { kind: "rename", path: b, from: a };
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

const byKindThenPath = (x: Change, y: Change): number =>
	ORDER.indexOf(x.kind) - ORDER.indexOf(y.kind) || (x.path < y.path ? -1 : x.path > y.path ? 1 : 0);

/**
 * `<who>: add learning_x` for a single change; otherwise a count summary in the
 * subject and one line per file in the body. Who and what, not which machine:
 * the date is already in the commit.
 */
export function commitMessage(who: string, changes: readonly Change[]): string {
	const [only] = changes;
	if (only === undefined) return `${who}: update memories`;
	if (changes.length === 1) return `${who}: ${only.kind} ${names(only)}`;

	const summary = ORDER.flatMap((k) => {
		const n = changes.filter((c) => c.kind === k).length;
		return n > 0 ? [`${n} ${KINDS[k].past}`] : [];
	});
	const body = [...changes].sort(byKindThenPath).map(changeLine);
	return `${who}: ${summary.join(", ")}\n\n${body.join("\n")}`;
}
