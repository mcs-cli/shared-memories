import { readFileSync } from "node:fs";

export function readStdin(): string {
	try {
		return readFileSync(0, "utf8");
	} catch {
		return "";
	}
}

export function parseJson(raw: string): unknown {
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return undefined;
	}
}

/** Matches `jq -n` output: two-space indent, trailing newline. */
export function emitJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function additionalContext(hookEventName: string, ctx: string): void {
	emitJson({ hookSpecificOutput: { hookEventName, additionalContext: ctx } });
}

export function say(line: string): void {
	process.stdout.write(`${line}\n`);
}

export function warn(line: string): void {
	process.stderr.write(`${line}\n`);
}

/**
 * The ERR-trap contract: nothing escapes, the hook always exits 0.
 * `exitCode` rather than `exit()`, which does not wait for an async pipe write
 * and can truncate a long review report.
 */
export function failOpen(name: string, body: () => void): void {
	// A reader that goes away is not the hook's failure. Node raises EPIPE as an
	// asynchronous `error` event on the stream rather than at the write, so the
	// catch below cannot see it, and the default handler prints a stack trace and
	// exits non-zero — precisely what this contract rules out.
	process.stdout.on("error", () => {});
	process.stderr.on("error", () => {});
	try {
		body();
	} catch (e) {
		const detail = e instanceof Error ? e.message : String(e);
		try {
			process.stderr.write(`${name}: aborted — ${detail}\n`);
		} catch {
			// Nowhere left to report to; exiting 0 still holds.
		}
	}
	process.exitCode = 0;
}

const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/;
const LITERAL = /^(true|false|null)/;

function scanValue(s: string, start: number): number {
	const c = s[start];
	if (c === "{" || c === "[") {
		const close = c === "{" ? "}" : "]";
		let depth = 0;
		for (let i = start; i < s.length; i++) {
			const ch = s[i];
			if (ch === '"') {
				i = scanString(s, i) - 1;
				if (i < start) return -1;
				continue;
			}
			if (ch === c) depth++;
			else if (ch === close && --depth === 0) return i + 1;
		}
		return -1;
	}
	if (c === '"') return scanString(s, start);
	const rest = s.slice(start);
	const lit = LITERAL.exec(rest);
	if (lit) return start + lit[0].length;
	const num = NUMBER.exec(rest);
	if (num) return start + num[0].length;
	return -1;
}

function scanString(s: string, start: number): number {
	for (let i = start + 1; i < s.length; i++) {
		if (s[i] === "\\") i++;
		else if (s[i] === '"') return i + 1;
	}
	return -1;
}

/**
 * The values `jq` would read from stdin, or null if it would have failed.
 * jq is a STREAM parser: empty input and several whitespace-separated values
 * are both valid, and JSON.parse rejects both. Used as a validity gate, the
 * difference decides whether a hook does its work at all.
 */
export function streamValues(raw: string): unknown[] | null {
	const values: unknown[] = [];
	let i = 0;
	while (i < raw.length) {
		while (i < raw.length && /\s/.test(raw[i] ?? "")) i++;
		if (i >= raw.length) break;
		const end = scanValue(raw, i);
		if (end < 0) return null;
		try {
			values.push(JSON.parse(raw.slice(i, end)));
		} catch {
			return null;
		}
		i = end;
	}
	return values;
}

export function isJsonStream(raw: string): boolean {
	return streamValues(raw) !== null;
}
