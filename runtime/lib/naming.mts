/** The one definition. Bash carried four copies kept in step by comment. */
export const ALLOWED_PATTERN = /^memories\/(learning|decision)_[a-zA-Z0-9_-]+\.md$/;

export const RENAME_HINT =
	"Rename to memories/learning_<topic>_<specific>.md or memories/decision_<domain>_<topic>.md so the guardrail accepts them.";

/** The slash command that fixes what retrying never will. Every hint names it through this. */
export const RESOLVE_COMMAND = "/resolve-memories";
