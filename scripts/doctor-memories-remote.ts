#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning
import { existsSync } from "node:fs";
import { join } from "node:path";
import { git, gitOut } from "../runtime/lib/git.mts";

// mcs shellScript doctor contract: 0 pass, 1 fail, 2 warn, 3 skip.
const project = process.env["MCS_PROJECT_PATH"] || process.cwd();
const repo = join(project, ".claude", ".memories-repo");

// No checkout is the setup check's problem, not this one's.
if (!existsSync(join(repo, ".git"))) process.exit(3);

const probe = git(repo, ["ls-remote", "--quiet", "origin"]);
if (probe.ok) process.exit(0);

const url = gitOut(repo, ["remote", "get-url", "origin"]) || "<unknown>";
const lines = [
	"Cannot reach the shared memories remote:",
	`  remote: ${url}`,
	`  error:  ${probe.stderr.replace(/\n$/, "") || (probe.failure ?? "")}`,
	"",
	"Common causes:",
	"  - SSH key not loaded — try: ssh-add ~/.ssh/<your-key>",
	"  - Network offline or VPN disconnected",
	"  - Access revoked on the shared repo",
	"",
	"Memories still work locally; auto-push will retry on each Claude Stop once the remote is reachable.",
];
process.stdout.write(`${lines.join("\n")}\n`);
process.exit(2);
