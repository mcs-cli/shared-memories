#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { hasUnionRule, isWorkTree } from "../runtime/lib/git.mts";
import { USAGE_FILE } from "../runtime/lib/naming.mts";

// mcs shellScript doctor contract: 0 pass, 1 fail, 2 warn, 3 skip.
const project = process.env.MCS_PROJECT_PATH || process.cwd();
const link = join(project, ".claude", "memories");
const repo = join(project, ".claude", ".memories-repo");

const isSymlink = (p: string): boolean => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

const problems: string[] = [];
if (!existsSync(join(repo, ".git"))) {
  problems.push(`git checkout missing at ${repo} (run 'mcs sync' to re-clone)`);
}
if (!isSymlink(link)) {
  problems.push(`symlink missing at ${link} (run 'mcs sync' to relink)`);
} else if (!isWorkTree(link)) {
  problems.push("symlink exists but doesn't resolve to a git checkout (run 'mcs sync' to repair)");
}

// A warning only: without the rule the Stop hook still merges usage conflicts itself.
const warnings: string[] = [];
if (existsSync(join(repo, ".git")) && !hasUnionRule(repo)) {
  warnings.push(`no merge=union rule for ${USAGE_FILE} in the checkout (run 'mcs sync' to add it)`);
}

if (problems.length + warnings.length > 0) {
  process.stdout.write(`Shared memories setup ${problems.length > 0 ? "is unhealthy" : "needs attention"}:\n`);
  for (const p of [...problems, ...warnings]) process.stdout.write(`  - ${p}\n`);
  process.exit(problems.length > 0 ? 1 : 2);
}
process.exit(0);
