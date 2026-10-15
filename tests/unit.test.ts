import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { type Change, commitMessage, parseNameStatus } from "../runtime/lib/commit-message.mts";
import { isJsonStream } from "../runtime/lib/hook-io.mts";
import { ALLOWED_PATTERN, USAGE_FILE } from "../runtime/lib/naming.mts";
import { badNames } from "../runtime/lib/pending.mts";
import { jitterMs, pushAttempts } from "../runtime/lib/push.mts";
import { makeProject, memory, stripJsonComments } from "./harness.ts";

describe("the naming guardrail", () => {
  const ok = ["memories/learning_a_b.md", "memories/decision_x-y_z.md", "memories/learning_A1_b2.md"];
  const bad = [
    "memories/scratch.md",
    "memories/learning_a b.md",
    "memories/learning_a.txt",
    "memories/sub/learning_a_b.md",
    "learning_a_b.md",
    "memories/learning_.md",
  ];
  for (const f of ok) test(`accepts ${f}`, () => assert.ok(ALLOWED_PATTERN.test(f)));
  for (const f of bad) test(`rejects ${f}`, () => assert.ok(!ALLOWED_PATTERN.test(f)));
});

describe("the usage file is exempt from the naming guardrail, and nothing else is", () => {
  test("badNames passes the usage file and still flags its look-alikes", () => {
    const { root, repo } = makeProject();
    try {
      writeFileSync(join(repo, USAGE_FILE), "# since: 2026-10-01\n");
      memory(repo, "usage.tsv");
      memory(repo, ".usage.tsv.bak");
      mkdirSync(join(repo, "memories", "sub"));
      writeFileSync(join(repo, "memories", "sub", ".usage.tsv"), "");
      assert.deepEqual(badNames(repo), ["memories/.usage.tsv.bak", "memories/sub/.usage.tsv", "memories/usage.tsv"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the retry budget", () => {
  for (const [raw, n] of [
    [undefined, 12],
    ["", 12],
    ["banana", 12],
    ["-1", 12],
    ["3.5", 12],
    ["0", 1],
    ["1", 1],
    ["7", 7],
  ] as const) {
    test(`${JSON.stringify(raw)} yields ${n}`, () => assert.equal(pushAttempts(raw), n));
  }
  // 12 attempts at the 1.5s cap must stay inside the hook's 30s timeout.
  for (const [attempt, ms] of [
    [1, 100],
    [2, 200],
    [4, 800],
    [5, 1500],
    [12, 1500],
  ] as const) {
    test(`jitter for attempt ${attempt} tops out at ${ms}ms`, () =>
      assert.equal(
        jitterMs(attempt, () => 1),
        ms,
      ));
  }
  test("jitter bottoms out at zero", () =>
    assert.equal(
      jitterMs(12, () => 0),
      0,
    ));
});

describe("commit messages", () => {
  const add = (p: string): Change => ({ kind: "add", path: `memories/${p}.md` });
  const upd = (p: string): Change => ({ kind: "update", path: `memories/${p}.md` });
  const rm = (p: string): Change => ({ kind: "remove", path: `memories/${p}.md` });

  test("a single change names the memory, without path or extension", () => {
    assert.equal(commitMessage("Ana", [add("learning_a_b")]), "Ana: add learning_a_b");
    assert.equal(commitMessage("Ana", [upd("learning_a_b")]), "Ana: update learning_a_b");
    assert.equal(commitMessage("Ana", [rm("learning_a_b")]), "Ana: remove learning_a_b");
  });

  test("a single rename shows both names", () => {
    const c: Change = { kind: "rename", from: "memories/learning_old.md", path: "memories/learning_new.md" };
    assert.equal(commitMessage("Ana", [c]), "Ana: rename learning_old → learning_new");
  });

  test("several changes count by kind, leave out empty kinds, and list each file in the body", () => {
    const msg = commitMessage("Ana", [rm("learning_z"), add("learning_b"), upd("decision_c"), add("decision_a")]);
    assert.equal(msg, "Ana: 2 added, 1 updated, 1 removed\n\n+ decision_a\n+ learning_b\n~ decision_c\n- learning_z");
  });

  test("a usage-only change says so instead of naming a memory", () => {
    assert.equal(commitMessage("Ana", [{ kind: "update", path: USAGE_FILE }]), "Ana: update memory usage");
    assert.equal(commitMessage("Ana", [{ kind: "add", path: USAGE_FILE }]), "Ana: update memory usage");
  });

  test("the usage file is left out of a message that has memory changes", () => {
    const usage: Change = { kind: "update", path: USAGE_FILE };
    assert.equal(commitMessage("Ana", [usage, add("learning_a_b")]), "Ana: add learning_a_b");
    assert.equal(
      commitMessage("Ana", [add("learning_b"), usage, upd("decision_c")]),
      "Ana: 1 added, 1 updated\n\n+ learning_b\n~ decision_c",
    );
  });

  test("nothing staged still yields a usable subject", () => {
    assert.equal(commitMessage("Ana", []), "Ana: update memories");
  });

  test("git's name-status lines map onto change kinds", () => {
    assert.deepEqual(parseNameStatus("A\tmemories/learning_a.md"), { kind: "add", path: "memories/learning_a.md" });
    assert.deepEqual(parseNameStatus("M\tmemories/learning_a.md"), { kind: "update", path: "memories/learning_a.md" });
    assert.deepEqual(parseNameStatus("T\tmemories/learning_a.md"), { kind: "update", path: "memories/learning_a.md" });
    assert.deepEqual(parseNameStatus("D\tmemories/learning_a.md"), { kind: "remove", path: "memories/learning_a.md" });
    assert.deepEqual(parseNameStatus("R097\tmemories/learning_a.md\tmemories/learning_b.md"), {
      kind: "rename",
      from: "memories/learning_a.md",
      path: "memories/learning_b.md",
    });
    assert.deepEqual(parseNameStatus("C100\tmemories/learning_a.md\tmemories/learning_b.md"), {
      kind: "add",
      path: "memories/learning_b.md",
    });
    assert.equal(parseNameStatus("U\tmemories/learning_a.md"), null);
    assert.equal(parseNameStatus(""), null);
  });
});

describe("the jq stdin gate", () => {
  for (const s of ["", "   ", "\n", "null", "42", '"s"', "{}", "{}{}", '{"a":1} {"b":2}', "[1,2]", '{"a":"}"}']) {
    test(`accepts ${JSON.stringify(s)}`, () => assert.ok(isJsonStream(s)));
  }
  for (const s of ["not json", "{", "}", "[1,", '{"a":1} x', '"unterminated']) {
    test(`rejects ${JSON.stringify(s)}`, () => assert.ok(!isJsonStream(s)));
  }
});

describe("reading tsconfig.json as the JSONC it is by convention", () => {
  const parse = (t: string): unknown => JSON.parse(stripJsonComments(t));

  test("line and block comments are removed", () => {
    assert.deepEqual(parse('{\n  // leading\n  "a": 1, /* inline */ "b": 2\n}'), { a: 1, b: 2 });
  });

  test("a block comment spanning lines is removed", () => {
    assert.deepEqual(parse('{\n  /*\n   * why this option is set\n   */\n  "a": 1\n}'), { a: 1 });
  });

  test("comment markers inside a string survive", () => {
    assert.deepEqual(parse('{"a": "https://x/y", "b": "/* not a comment */"}'), {
      a: "https://x/y",
      b: "/* not a comment */",
    });
  });

  test("an escaped quote does not end the string early", () => {
    assert.deepEqual(parse('{"a": "he said \\"hi\\" // still a string"}'), { a: 'he said "hi" // still a string' });
  });

  test("trailing commas before a closer are dropped", () => {
    assert.deepEqual(parse('{"a": [1, 2, ], "b": 2, }'), { a: [1, 2], b: 2 });
  });

  test("a comma inside a string is not mistaken for a trailing one", () => {
    assert.deepEqual(parse('{"a": "x,", "b": ["y,"]}'), { a: "x,", b: ["y,"] });
  });
});
