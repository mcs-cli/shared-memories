#!/bin/bash
# Remote-access health check for `mcs doctor`.
#
# Exit codes per the MCS shellScript doctor contract:
#   0 = pass (remote reachable, auth working)
#   1 = fail
#   2 = warning (checkout exists but remote unreachable — pushes will queue)
#   3 = skip (no checkout yet; doctor-memories.sh handles setup issues)
#
# Uses `git ls-remote origin` as a protocol-agnostic auth + reachability probe:
# it works for SSH, HTTPS, and git:// remotes, doesn't need a working tree,
# and returns fast. Failure modes it catches:
#   - SSH key not loaded or expired (ssh-add needed)
#   - Network offline or firewall blocking the host
#   - Remote URL changed or repo moved/deleted
#   - Credentials revoked / access removed

set -u

project="${MCS_PROJECT_PATH:-$PWD}"
repo_dir="$project/.claude/.memories-repo"

# No checkout → skip. The setup-health check flags this separately.
if [ ! -d "$repo_dir/.git" ]; then
  exit 3
fi

# Probe the remote. Suppress stdout (ref list could be large), capture stderr
# for diagnostics on failure.
if err=$(git -C "$repo_dir" ls-remote --quiet origin 2>&1 >/dev/null); then
  exit 0
fi

remote_url=$(git -C "$repo_dir" remote get-url origin 2>/dev/null || echo "<unknown>")
echo "Cannot reach the shared memories remote:"
echo "  remote: $remote_url"
echo "  error:  $err"
echo ""
echo "Common causes:"
echo "  - SSH key not loaded — try: ssh-add ~/.ssh/<your-key>"
echo "  - Network offline or VPN disconnected"
echo "  - Access revoked on the shared repo"
echo ""
echo "Memories still work locally; auto-push will retry on each Claude Stop once the remote is reachable."
exit 2
