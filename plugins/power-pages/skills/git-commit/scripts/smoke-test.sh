#!/bin/bash
# Smoke test for /git-commit — exercises `pac pages git commit` against an env
# already connected to Git via /git-connect. Stages a tiny content change,
# commits, and verifies the post-commit status shows 0 pending.
#
# Run from WSL; uses Windows pac.exe via cmd.exe.
#
# Required env vars:
#   ENV_URL                target env URL (must already be connected via /git-connect)
#   SOLUTION_NAME          solution unique name
#   PP_SITE_ID             powerpagesite GUID (used to PATCH a powerpagecomponent
#                          to stage a change before committing)
#   PAC_EXE                full path to pac.exe (Windows-style)
#
# Exit codes:
#   0 — pass; 1 — pre-flight failed; 2 — commit / verify failed

set -uo pipefail

ENV_URL="${ENV_URL:-}"
SOLUTION_NAME="${SOLUTION_NAME:-}"
PP_SITE_ID="${PP_SITE_ID:-}"
PAC_EXE="${PAC_EXE:-C:\\Users\\rishjain\\source\\repos\\pac-worktrees\\pages_git_subnoun_poc\\drop\\Debug\\bolt\\net10.0\\pac.exe}"
COMMIT_MSG="${COMMIT_MSG:-Smoke test: dev loop change $(date +%Y-%m-%d_%H:%M:%S)}"

PASS=0
FAIL=0
log() { echo "[$(date +%H:%M:%S)] $*"; }
pass() { log "  PASS: $*"; PASS=$((PASS + 1)); }
fail() { log "  FAIL: $*"; FAIL=$((FAIL + 1)); }
pac() { log "  > pac $*"; cmd.exe /c "$PAC_EXE $*" 2>&1; }

[ -z "$ENV_URL" ] || [ -z "$SOLUTION_NAME" ] || [ -z "$PP_SITE_ID" ] && {
  log "ERROR: ENV_URL, SOLUTION_NAME, PP_SITE_ID must be set"
  exit 1
}

az account show &>/dev/null || { log "ERROR: az login first"; exit 1; }
pac pages git --help 2>&1 | grep -q commit || { log "ERROR: pac pages git sub-noun missing"; exit 1; }
pass "pre-flight OK"

# 1) Confirm we're connected
log "STATUS (pre-commit)"
status_out=$(pac pages git status --environment "$ENV_URL")
echo "$status_out"
echo "$status_out" | grep -qi "connected to" \
  && pass "env is connected" \
  || { fail "env is NOT connected — run /git-connect first"; exit 2; }

# 2) Stage a tiny change via OData PATCH on a powerpagecomponent under the site
TOKEN=$(az account get-access-token --resource "$ENV_URL" --query accessToken -o tsv 2>/dev/null)
[ -z "$TOKEN" ] && { fail "Could not get OData token"; exit 2; }

log "Stage change: PATCH a powerpagecomponent under site $PP_SITE_ID"
PATCH_TARGET=$(curl -s -H "Authorization: Bearer $TOKEN" \
  "${ENV_URL}/api/data/v9.2/powerpagecomponents?\$select=powerpagecomponentid,name&\$filter=_powerpagesiteid_value eq ${PP_SITE_ID}&\$top=1" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); v=d.get('value',[]); print(v[0]['powerpagecomponentid'] if v else '')")

if [ -n "$PATCH_TARGET" ]; then
  curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    "${ENV_URL}/api/data/v9.2/powerpagecomponents($PATCH_TARGET)" \
    -d "{\"content\":\"smoke test @ $(date +%s)\"}" > /dev/null
  pass "staged change on powerpagecomponent $PATCH_TARGET"
  curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    "${ENV_URL}/api/data/v9.2/PublishAllXml" -d '{}' > /dev/null
  log "PublishAllXml issued; waiting 30s for tracking"
  sleep 30
else
  log "WARN: no powerpagecomponent under this site; will commit current state (may be 'Nothing to commit')"
fi

# 3) Commit
log "COMMIT"
commit_out=$(pac pages git commit \
  --solutionName "$SOLUTION_NAME" \
  --message "$COMMIT_MSG" \
  --environment "$ENV_URL")
echo "$commit_out"

if echo "$commit_out" | grep -qi "committed"; then
  pass "commit emitted 'committed'"
elif echo "$commit_out" | grep -qi "no pending"; then
  pass "commit emitted 'No pending' (acceptable when no pending rows)"
else
  fail "commit emitted neither a 'committed' nor a 'No pending' confirmation"
fi

# 4) Verify post-commit status
log "STATUS (post-commit)"
sleep 5
status_out=$(pac pages git status --environment "$ENV_URL")
echo "$status_out"

# After a successful commit OR a no-op commit, status should show 0 pending.
# pac pages git status omits the 'pending change' line when count is 0;
# fail only if it shows a non-zero count.
if echo "$status_out" | grep -qiE "[1-9][0-9]* pending change"; then
  fail "post-commit status still reports pending changes"
else
  pass "post-commit status shows 0 pending"
fi

log ""
log "Passed: $PASS"
log "Failed: $FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 2
