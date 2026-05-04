#!/bin/bash
# Smoke test for /git-pull — exercises `pac pages git pull` against a target env
# already connected to a Git repo that has commits the env doesn't have.
#
# Run from WSL; uses Windows pac.exe via cmd.exe.
#
# Prereqs:
#   - Source env has previously committed at least once to <ADO_BRANCH>/<GIT_FOLDER>.
#   - Target env (ENV_URL) is connected to the SAME repo/branch/folder via /git-connect.
#
# Required env vars:
#   ENV_URL         target env URL (must be already connected via /git-connect)
#   SOLUTION_NAME   solution unique name on the target
#   AUTO_RESOLVE    'true' to pass --autoResolve (accept Git version on conflicts), default true
#   PAC_EXE         Windows path to pac.exe
#
# Exit codes:
#   0 — pass; 1 — pre-flight failed; 2 — pull / verify failed

set -uo pipefail

ENV_URL="${ENV_URL:-}"
SOLUTION_NAME="${SOLUTION_NAME:-}"
AUTO_RESOLVE="${AUTO_RESOLVE:-true}"
PAC_EXE="${PAC_EXE:-C:\\Users\\rishjain\\source\\repos\\pac-worktrees\\pages_git_subnoun_poc\\drop\\Debug\\bolt\\net10.0\\pac.exe}"

PASS=0
FAIL=0
log() { echo "[$(date +%H:%M:%S)] $*"; }
pass() { log "  PASS: $*"; PASS=$((PASS + 1)); }
fail() { log "  FAIL: $*"; FAIL=$((FAIL + 1)); }
pac() { log "  > pac $*"; cmd.exe /c "$PAC_EXE $*" 2>&1; }

[ -z "$ENV_URL" ] || [ -z "$SOLUTION_NAME" ] && {
  log "ERROR: ENV_URL and SOLUTION_NAME must be set"
  exit 1
}

az account show &>/dev/null || { log "ERROR: az login first"; exit 1; }
pac pages git --help 2>&1 | grep -q pull || { log "ERROR: pac pages git sub-noun missing"; exit 1; }
pass "pre-flight OK"

# 1) Confirm connected
log "STATUS (pre-pull)"
status_out=$(pac pages git status --environment "$ENV_URL")
echo "$status_out"
echo "$status_out" | grep -qi "connected to" \
  && pass "env is connected" \
  || { fail "env is NOT connected — run /git-connect first"; exit 2; }

# 2) Pull
log "PULL (autoResolve=$AUTO_RESOLVE)"
if [ "$AUTO_RESOLVE" = "true" ]; then
  pull_out=$(pac pages git pull --solutionName "$SOLUTION_NAME" --autoResolve --environment "$ENV_URL")
else
  pull_out=$(pac pages git pull --solutionName "$SOLUTION_NAME" --environment "$ENV_URL")
fi
echo "$pull_out"

if echo "$pull_out" | grep -qi "pulled"; then
  pass "pull emitted 'pulled'"
elif echo "$pull_out" | grep -qi "conflict"; then
  if [ "$AUTO_RESOLVE" = "true" ]; then
    fail "pull reported conflicts even with --autoResolve"
  else
    pass "pull aborted on conflicts (expected without --autoResolve)"
  fi
elif echo "$pull_out" | grep -qiE "no changes to pull|no available updates"; then
  pass "no available updates (acceptable)"
else
  fail "pull emitted unexpected output"
fi

# 3) Verify post-pull status
log "STATUS (post-pull)"
sleep 5
status_out=$(pac pages git status --environment "$ENV_URL")
echo "$status_out"

# pac pages git status omits the 'available update' line when count is 0;
# fail only if it shows a non-zero count.
if echo "$status_out" | grep -qiE "[1-9][0-9]* available update"; then
  fail "post-pull status still reports available updates"
else
  pass "post-pull status reports 0 available updates"
fi

log ""
log "Passed: $PASS"
log "Failed: $FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 2
