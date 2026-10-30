import { git, hasUpstream, probe } from "./git.mts";
import { failOpen, isJsonStream, readStdin } from "./hook-io.mts";
import { memoriesRepo, projectRoot } from "./paths.mts";

const NAME = "memories_pull";

/** Async: nobody reads its output, so the status hook reports what stops it pulling. */
export const main = (hookDir: string): void =>
  failOpen(NAME, () => {
    if (!isJsonStream(readStdin())) return;
    const repo = memoriesRepo(projectRoot(hookDir));
    if (probe(repo) !== null || !hasUpstream(repo)) return;

    // Usage rows written after the last Stop would otherwise block every incoming change to that file.
    git(repo, ["pull", "--ff-only", "--autostash", "--quiet"]);
  });
