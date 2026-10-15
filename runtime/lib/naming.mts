/** The one definition. Bash carried four copies kept in step by comment. */
export const ALLOWED_PATTERN = /^memories\/(learning|decision)_[a-zA-Z0-9_-]+\.md$/;

export const RENAME_HINT =
  "Rename to memories/learning_<topic>_<specific>.md or memories/decision_<domain>_<topic>.md so the guardrail accepts them.";

/** The slash command that fixes what retrying never will. Every hint names it through this. */
export const RESOLVE_COMMAND = "/resolve-memories";

/** Last-read dates the memory pack appends to. Exempt from the naming rule, and merged as a union. */
export const USAGE_FILE = "memories/.usage.tsv";

export const USAGE_ATTRIBUTE = `${USAGE_FILE} merge=union`;

/** The naming rule, plus the one bookkeeping file that is allowed to break it. */
export const isAllowedPath = (f: string): boolean => f === USAGE_FILE || ALLOWED_PATTERN.test(f);
