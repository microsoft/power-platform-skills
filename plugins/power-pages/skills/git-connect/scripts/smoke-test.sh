#!/bin/bash
# Smoke test for /git-connect — exercises `pac pages git connect`/`status`/`disconnect`.
# Run from WSL; uses Windows pac.exe via cmd.exe (WSL pac can't auth to Dataverse).
#
# Usage:
#   bash smoke-test.sh
#
# Required env vars (or override at top):
#   ENV_URL          target Power Pages env URL
#   SOLUTION_NAME    solution unique name to connect (must already exist)
#   ADO_ORG          Azure DevOps org name
#   ADO_PROJECT      ADO project name
#   ADO_REPO         ADO repo name
#   ADO_BRANCH       branch name (default: main)
#   GIT_FOLDER       folder path inside the repo (default: /SmokeTest_<timestamp>)
#   PAC_EXE          full path to pac.exe (Windows-style); default points at the
#                    pages_git_subnoun_poc worktree.
#
# Exit codes:
#   0 — all assertions passed
#   1 — pre-flight failed (auth, sub-noun missing, env vars unset)
#   2 — connect or verify failed
#   3 — disconnect cleanup failed

set -uo pipefail

ENV_URL="${ENV_URL:-}"
SOLUTION_NAME="${SOLUTION_NAME:-}"
ADO_ORG="${ADO_ORG:-}"
ADO_PROJECT="${ADO_PROJECT:-}"
ADO_REPO="${ADO_REPO:-}"
ADO_BRANCH="${ADO_BRANCH:-main}"
GIT_FOLDER="${GIT_FOLDER:-/SmokeTest_$(date +%Y%m%d_%H%M%S)}"
PAC_EXE="${PAC_EXE:-C:\\Users\\rishjain\\source\\repos\\pac-worktrees\\pages_git_subnoun_poc\\drop\\Debug\\bolt\\net10.0\\pac.exe}"

PASS=0
FAIL=0
log() { echo "[$(date +%H:%M:%S)] $*"; }
pass() { log "  PASS: $*"; PASS=$((PASS + 1)); }
fail() { log "  FAIL: $*"; FAIL=$((FAIL + 1)); }
pac() { log "  > pac $*"; cmd.exe /c "$PAC_EXE $*" 2>&1; }

# Pre-flight
[ -z "$ENV_URL" ] || [ -z "$SOLUTION_NAME" ] || [ -z "$ADO_ORG" ] || [ -z "$ADO_PROJECT" ] || [ -z "$ADO_REPO" ] && {
  log "ERROR: ENV_URL, SOLUTION_NAME, ADO_ORG, ADO_PROJECT, ADO_REPO must be set"
  exit 1
}

az account show &>/dev/null || { log "ERROR: az login first"; exit 1; }
pac pages git --help 2>&1 | grep -q connect || { log "ERROR: pac pages git sub-noun missing (verbPAPortalGit feature flag)"; exit 1; }
pass "pre-flight OK"

# 1) Initial status — should be 'Not connected' (or already connected — we'll disconnect first)
log "STATUS (pre-connect)"
status_out=$(pac pages git status --environment "$ENV_URL")
echo "$status_out"

if echo "$status_out" | grep -qi "connected to"; then
  log "Already connected; cleaning up first"
  pac pages git disconnect --solutionName "$SOLUTION_NAME" --environment "$ENV_URL" || true
  sleep 5
fi

# 2) Connect
log "CONNECT"
connect_out=$(pac pages git connect \
  --solutionName "$SOLUTION_NAME" \
  --organization "$ADO_ORG" \
  --project "$ADO_PROJECT" \
  --repository "$ADO_REPO" \
  --branch "$ADO_BRANCH" \
  --folder "$GIT_FOLDER" \
  --gitProvider 0 \
  --environment "$ENV_URL")
echo "$connect_out"

echo "$connect_out" | grep -qiE "connected to|connection established|successfully connected" \
  && pass "connect emitted expected stdout" \
  || fail "connect did NOT emit a connected confirmation"

# 3) Status — should show Connected
log "STATUS (post-connect)"
sleep 5
status_out=$(pac pages git status --environment "$ENV_URL")
echo "$status_out"
echo "$status_out" | grep -qi "connected to" \
  && pass "status confirms connected" \
  || fail "status did NOT report 'Connected to'"

# 4) Disconnect (cleanup)
log "DISCONNECT (cleanup)"
disconnect_out=$(pac pages git disconnect --solutionName "$SOLUTION_NAME" --environment "$ENV_URL")
echo "$disconnect_out"
echo "$disconnect_out" | grep -qi "disconnected" \
  && pass "disconnect emitted expected stdout" \
  || fail "disconnect did NOT emit a disconnected confirmation"

# 5) Final status — should be 'Not connected'
log "STATUS (post-disconnect)"
sleep 3
status_out=$(pac pages git status --environment "$ENV_URL")
echo "$status_out"
echo "$status_out" | grep -qiE "not connected|no source control connection" \
  && pass "post-disconnect status reports not-connected" \
  || fail "post-disconnect status did NOT report not-connected"

log ""
log "Passed: $PASS"
log "Failed: $FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 2
