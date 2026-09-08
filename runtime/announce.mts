#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning
import { additionalContext, failOpen, readStdin, streamValues } from "./lib/hook-io.mts";
import { MEMORY_WRITE_PATTERN } from "./lib/naming.mts";

const isObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/** How `jq -r` renders one result: strings raw, everything else as pretty JSON. */
const render = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v, null, 2));

/**
 * `jq -r '.tool_input.file_path // empty'` over every value on stdin, joined by
 * newlines. jq does not stop at an erroring value — it skips it and carries on —
 * and its exit status reflects only the LAST value. The bash's `|| exit 0` therefore
 * fires only when the final value errored, which is what null means here.
 */
function filePaths(values: readonly unknown[]): string | null {
	const out: string[] = [];
	let lastErrored = false;
	for (const value of values) {
		lastErrored = false;

		let toolInput: unknown = null;
		if (isObject(value)) toolInput = value["tool_input"] ?? null;
		else if (value !== null) {
			lastErrored = true;
			continue;
		}

		let filePath: unknown = null;
		if (isObject(toolInput)) filePath = toolInput["file_path"] ?? null;
		else if (toolInput !== null) {
			lastErrored = true;
			continue;
		}

		if (filePath === null || filePath === false) continue;
		out.push(render(filePath));
	}
	// `$(...)` strips trailing newlines, and jq emits one per result.
	return lastErrored ? null : out.join("\n").replace(/\n+$/, "");
}

failOpen("memories_announce", () => {
	const values = streamValues(readStdin());
	if (values === null) return;

	const filePath = filePaths(values);
	if (filePath === null || !MEMORY_WRITE_PATTERN.test(filePath)) return;

	// The bash matches the literal, not the resolved mode: unknown values are silent here.
	if (process.env["MEMORIES_AUTOPUSH_MODE"] !== "review") return;

	additionalContext(
		"PostToolUse",
		`Memory file saved at ${filePath} (MEMORIES_AUTOPUSH_MODE=review). This memory will not auto-push. Mention the pending memory to the user before ending your turn so they can decide whether to approve or discard. If they approve, run /approve-memories.`,
	);
});
