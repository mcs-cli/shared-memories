import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ALLOWED_PATTERN } from "../runtime/lib/naming.mts";
import { stripJsonComments } from "./harness.ts";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = readFileSync(join(REPO, "techpack.yaml"), "utf8");

/** Every `source:` the manifest names, without pulling in a YAML dependency. */
const sources = [...manifest.matchAll(/^\s*(?:source|contentFile|settingsFile|script|command|fixScript):\s*(\S+)/gm)]
	.map((m) => m[1] as string)
	.filter((v) => v.includes("/") || v.endsWith(".yaml"));

describe("techpack manifest", () => {
	test("every referenced path exists in the pack", () => {
		const missing = sources.filter((s) => !existsSync(join(REPO, s)));
		assert.deepEqual(missing, [], `manifest references files that do not exist: ${missing.join(", ")}`);
		assert.ok(sources.length >= 8, `expected the manifest to reference several files, found ${sources.length}`);
	});

	test("every hook declares the interpreter mcs runs it with", () => {
		// `.mts` is in mcs's ambiguousExtensions, so without this it falls back to bash.
		const declared = manifest.match(/hookInterpreter: node --experimental-strip-types/g) ?? [];
		assert.equal(declared.length, 3, "each of the three hooks needs its own hookInterpreter");
		assert.match(manifest, /minMCSVersion: "2026\.9\.3"/, "the interpreter field needs the release that honours it");
	});

	test("jq is gone and node is declared", () => {
		assert.doesNotMatch(manifest, /brew: jq/, "the pack no longer shells out to jq");
		assert.match(manifest, /brew: node/, "the pack now depends on Node");
	});

	test("the library ships beside the hooks it is imported from", () => {
		assert.match(manifest, /fileType: generic/);
		assert.match(manifest, /source: runtime\/lib\n\s*destination: hooks\/shared-memories\/lib/);
	});

	test("the library destination tracks the pack identifier", () => {
		// Hooks are namespaced into <pack-id>/, and the generic copy has to land in
		// the same directory. Renaming the pack without this line breaks the imports.
		const id = /^identifier:\s*(\S+)/m.exec(manifest)?.[1];
		assert.ok(id, "the manifest declares no identifier");
		assert.match(manifest, new RegExp(`destination: hooks/${id}/lib`));
	});
});

describe("hook install contract", () => {
	const dests = [...manifest.matchAll(/destination:\s*(\S+\.mts)/g)].map((m) => m[1] as string);

	test("three hooks are registered, all TypeScript", () => {
		assert.equal(dests.length, 3, "expected three registered hook entry points");
		for (const d of dests) assert.ok(existsSync(join(REPO, "runtime", d)), `${d} is registered but not shipped`);
	});

	test("no shell survives anywhere in the pack", () => {
		const stray = readdirSync(REPO, { recursive: true, encoding: "utf8" }).filter(
			(f) => f.endsWith(".sh") && !f.startsWith("node_modules"),
		);
		assert.deepEqual(stray, [], `shell scripts are not permitted: ${stray.join(", ")}`);
	});

	test("every entry point carries a shebang matching its declared interpreter", () => {
		for (const d of dests) {
			const first = readFileSync(join(REPO, "runtime", d), "utf8").split("\n")[0];
			assert.equal(
				first,
				"#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning",
				`${d} has no usable shebang`,
			);
		}
	});

	test("every entry point is executable", () => {
		for (const d of dests) {
			// mcs chmods on install, but a non-executable file in the repo is a smell.
			assert.ok(statSync(join(REPO, "runtime", d)).mode & 0o111, `${d} is not executable`);
		}
	});

	test("every entry point imports its library as a sibling", () => {
		// `./lib/...` has to resolve both in the pack checkout and once installed.
		for (const d of dests) {
			const body = readFileSync(join(REPO, "runtime", d), "utf8");
			assert.doesNotMatch(body, /from "\.\.\//, `${d} reaches outside its own directory`);
			assert.match(body, /from "\.\/lib\//, `${d} does not import the shared library`);
		}
	});

	test("every entry point is under the typecheck", () => {
		// This was `node --check`, which is parse-only and, on the declared 22.6.0
		// floor, does not apply the `.mts`-implies-ESM mapping: it read every entry
		// point as CommonJS and died on the first import. `tsc` subsumes it, but only
		// if `include` reaches these files -- a pattern ending in `.ts` matches no
		// `.mts`, which left all three plus lib/paths.mts unchecked entirely.
		const include = JSON.parse(stripJsonComments(readFileSync(join(REPO, "tsconfig.json"), "utf8"))).include as string[];
		// Resolve the globs instead of pinning one pattern string: rewriting
		// `include`, or adding a runtime file, then still has to keep the coverage.
		const reaches = include.map(
			(p) =>
				new RegExp(
					`^${p
						.split("/")
						.map((s) => (s === "**" ? "\0" : s.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")))
						.join("/")
						.replace(/\0\//g, "(?:[^/]+/)*")}$`,
				),
		);
		const unreachable = readdirSync(join(REPO, "runtime"), { recursive: true, encoding: "utf8" })
			.filter((f) => f.endsWith(".ts") || f.endsWith(".mts"))
			// readdirSync yields the platform separator; the globs are written with "/".
			.map((f) => `runtime/${f.split(sep).join("/")}`)
			.filter((f) => !reaches.some((re) => re.test(f)));
		assert.deepEqual(unreachable, [], `tsconfig include does not reach: ${unreachable.join(", ")}`);
	});
});

describe("the naming rule has one definition", () => {
	test("the slash command documents the pattern the code enforces", () => {
		const cmd = readFileSync(join(REPO, "commands", "approve-memories.md"), "utf8");
		const m = /\^memories\/\(learning\|decision\)_\[a-zA-Z0-9_-\]\+\\\.md\$/.exec(cmd);
		assert.ok(m, "approve-memories.md no longer documents the guardrail pattern");
		assert.equal(ALLOWED_PATTERN.source, "^memories\\/(learning|decision)_[a-zA-Z0-9_-]+\\.md$");
	});

	test("nothing shipped still points at a second copy of the rule", () => {
		// commands/ ships to consumers and Claude reads it, so it counts as much as the code.
		for (const dir of ["runtime", "runtime/lib", "scripts", "commands", "templates"]) {
			for (const f of readdirSync(join(REPO, dir)).filter((n) => /\.(m?ts|md)$/.test(n))) {
				const body = readFileSync(join(REPO, dir, f), "utf8");
				assert.doesNotMatch(body, /keep in sync/i, `${dir}/${f} still points at a second copy`);
			}
		}
	});
});
