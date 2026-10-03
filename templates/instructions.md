## Shared memories (`.claude/memories`)

`.claude/memories` → `.claude/.memories-repo/memories` — a symlink into a sparse
checkout of a git repo the team shares. Treat it as shared state, not scratch.

- **Writes and deletions reach the whole team.** The Stop hook commits and
  pushes them, deletions included, at the end of every turn. Never delete or
  rewrite a memory file to tidy up unless the user asked for it.
- **The memory set changes from outside this session.** SessionStart pulls
  teammates' commits, so file counts and contents are not constants to cache.
- **The parent project's git does not track memories.** `.claude/memories` and
  `.claude/.memories-repo` are gitignored — `git add` on a memory file from the
  project root is a silent no-op. The memories repo is a separate git root.
- **Address memory files as** `git -C .claude/.memories-repo <cmd> -- memories/<file>`.
  Using `-C .claude/memories` puts git's cwd *inside* `memories/`, so a
  `memories/<file>` pathspec matches nothing: the command exits 0 with empty
  output and you conclude "no history" from a false premise.
