import { ahead, probe } from "./git.mts";
import { additionalContext, failOpen, isJsonStream, readStdin, warn } from "./hook-io.mts";
import { RESOLVE_COMMAND } from "./naming.mts";
import { memoriesRepo, projectRoot } from "./paths.mts";
import { lingeringCount } from "./pending.mts";

const NAME = "memories_status";

export const main = (hookDir: string): void =>
  failOpen(NAME, () => {
    // Runs beside the async pull: no read here may take the index lock the pull needs.
    process.env.GIT_OPTIONAL_LOCKS = "0";
    const project = projectRoot(hookDir);
    const repo = memoriesRepo(project);
    const state = probe(repo);
    if (state === "no-git") return warn(`${NAME}: git not found; skipping`);
    if (!isJsonStream(readStdin())) return warn(`${NAME}: stdin is not valid JSON; skipping`);
    if (state === "not-worktree") {
      return warn(`${NAME}: ${repo} is not a git worktree; skipping (project_root=${project})`);
    }

    if (state !== null) {
      additionalContext(
        "SessionStart",
        `Shared memories: a ${state} is in progress in .claude/.memories-repo, so auto-push is paused and teammates' memories were not pulled. Run ${RESOLVE_COMMAND} to finish it.`,
      );
      return;
    }

    const unpushed = ahead(repo);
    // Without an upstream every Stop commits locally and nothing ever reaches the team.
    if (unpushed === null) {
      additionalContext(
        "SessionStart",
        `Shared memories: the checkout in .claude/.memories-repo has no upstream branch, so memories are committed locally but never pushed or pulled. Run ${RESOLVE_COMMAND} to fix it.`,
      );
      return;
    }

    const uncommitted = lingeringCount(repo);
    if (uncommitted === 0 && unpushed === 0) return;

    const joined = [uncommitted > 0 ? `${uncommitted} uncommitted file(s)` : "", unpushed > 0 ? `${unpushed} unpushed commit(s)` : ""]
      .filter(Boolean)
      .join(", ");
    additionalContext(
      "SessionStart",
      `Shared memories have lingering state: ${joined}. The previous Stop hook's auto-push didn't complete. The next Stop retries automatically. If it keeps failing: run ${RESOLVE_COMMAND} for a rebase conflict or misnamed files (must match memories/{learning,decision}_<name>.md); for auth, check ssh-add or run mcs doctor.`,
    );
  });
