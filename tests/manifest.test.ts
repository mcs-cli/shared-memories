import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { ALLOWED_PATTERN } from "../runtime/lib/naming.mts";
import { stripJsonComments } from "./harness.ts";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = readFileSync(join(REPO, "techpack.yaml"), "utf8");

/** Every `source:` the manifest names, without pulling in a YAML dependency. */
const sources = [...manifest.matchAll(/^\s*(?:source|contentFile|settingsFile|script|command|fixScript):\s*(\S+)/gm)]
  .map(m => m[1] as string)
  .filter(v => v.includes("/") || v.endsWith(".yaml"));

describe("techpack manifest", () => {
  test("every referenced path exists in the pack", () => {
    const missing = sources.filter(s => !existsSync(join(REPO, s)));
    assert.deepEqual(missing, [], `manifest references files that do not exist: ${missing.join(", ")}`);
    assert.ok(sources.length >= 8, `expected the manifest to reference several files, found ${sources.length}`);
  });

  test("the manifest requires an mcs that honours hookInterpreter", () => {
    const v = /^minMCSVersion:\s*"([\d.]+)"/m.exec(manifest)?.[1]?.split(".").map(Number) ?? [];
    const floor = [2026, 9, 3];
    const cmp = floor.map((f, i) => (v[i] ?? 0) - f).find(d => d !== 0) ?? 0;
    assert.ok(cmp >= 0, `minMCSVersion ${v.join(".")} predates ${floor.join(".")}, which ignores hookInterpreter`);
  });

  test("node is declared as a dependency", () => {
    assert.match(manifest, /brew: node/, "hookInterpreter names a binary no component installs");
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
  const dests = [...manifest.matchAll(/^\s*hook:\n\s*source:\s*\S+\n\s*destination:\s*(\S+)/gm)].map(m => m[1] as string);

  test("every shipped entry point is registered as a hook, and nothing else is", () => {
    const shipped = readdirSync(join(REPO, "runtime")).filter(f => f.endsWith(".mjs"));
    assert.ok(dests.length > 0, "the manifest registers no hooks");
    assert.deepEqual([...dests].sort(), shipped.sort());
  });

  test("no shell survives anywhere in the pack", () => {
    const stray = readdirSync(REPO, { recursive: true, encoding: "utf8" }).filter(f => f.endsWith(".sh") && !f.startsWith("node_modules"));
    assert.deepEqual(stray, [], `shell scripts are not permitted: ${stray.join(", ")}`);
  });

  test("every hook is declared with the interpreter its shebang names", () => {
    // mcs runs `<hookInterpreter> <path>` and ignores the shebang; the suite runs the shebang.
    // The library they import is `.mts`, which needs the type-stripping flag even from a `.mjs` entry.
    const declared = [...manifest.matchAll(/^\s*hookInterpreter:\s*(.+?)\s*$/gm)].map(m => m[1]);
    assert.equal(declared.length, dests.length, "each hook needs its own hookInterpreter");
    for (const d of dests) {
      const first = readFileSync(join(REPO, "runtime", d), "utf8").split("\n")[0] ?? "";
      const tail = /^#!\/usr\/bin\/env -S (.+)$/.exec(first)?.[1];
      assert.ok(tail?.startsWith("node --experimental-strip-types"), `${d} has no usable shebang`);
      for (const i of declared) assert.equal(i, tail, `${d}'s shebang and the manifest's hookInterpreter disagree`);
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
      assert.match(body, /import\("\.\/lib\//, `${d} does not import the shared library`);
    }
  });

  test("every entry point enables the compile cache before any TypeScript loads", () => {
    // Stripping even one `.mts` before the cache is on loads the stripper, which is
    // most of the startup the cache exists to save. So the entry stays plain JS, and
    // the library is imported dynamically, after the call.
    for (const d of dests) {
      const body = readFileSync(join(REPO, "runtime", d), "utf8");
      const enable = body.indexOf("enableCompileCache");
      assert.ok(enable >= 0, `${d} never enables the compile cache`);
      assert.ok(enable < body.indexOf("import("), `${d} imports its library before enabling the cache`);
      assert.doesNotMatch(body, /^\s*(?:import|export)\s[^(;]*["']\.{1,2}\//m, `${d} statically imports the library`);
    }
  });

  test("only the network pull runs async at SessionStart", () => {
    const block = (id: string): string => manifest.slice(manifest.indexOf(`- id: ${id}`)).split(/\n\s*- id: /)[0] ?? "";
    assert.match(block("hook-memories-pull"), /hookAsync: true/);
    assert.doesNotMatch(block("hook-memories-status"), /hookAsync/, "the status hook is what reaches Claude's context");
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
      p =>
        new RegExp(
          `^${p
            .split("/")
            .map(s => (s === "**" ? "\0" : s.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")))
            .join("/")
            .replace(/\0\//g, "(?:[^/]+/)*")}$`,
        ),
    );
    const unreachable = readdirSync(join(REPO, "runtime"), { recursive: true, encoding: "utf8" })
      .filter(f => f.endsWith(".ts") || f.endsWith(".mts") || f.endsWith(".mjs"))
      // readdirSync yields the platform separator; the globs are written with "/".
      .map(f => `runtime/${f.split(sep).join("/")}`)
      .filter(f => !reaches.some(re => re.test(f)));
    assert.deepEqual(unreachable, [], `tsconfig include does not reach: ${unreachable.join(", ")}`);
  });
});

describe("the naming rule has one definition", () => {
  test("the slash command documents the pattern the code enforces", () => {
    const cmd = readFileSync(join(REPO, "commands", "resolve-memories.md"), "utf8");
    const m = /\^memories\/\(learning\|decision\)_\[a-zA-Z0-9_-\]\+\\\.md\$/.exec(cmd);
    assert.ok(m, "resolve-memories.md no longer documents the guardrail pattern");
    assert.equal(ALLOWED_PATTERN.source, "^memories\\/(learning|decision)_[a-zA-Z0-9_-]+\\.md$");
  });
});
