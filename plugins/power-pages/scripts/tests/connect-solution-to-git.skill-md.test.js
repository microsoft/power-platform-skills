'use strict';

// Source-grep regression tests for skills/connect-solution-to-git/SKILL.md.
// Each assertion pins a contract that was added in response to a specific
// live-test finding — if a future edit removes one of these, the test will
// fail loudly so the regression doesn't silently re-ship.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SKILL_MD = path.resolve(
  __dirname,
  '..', '..', 'skills', 'connect-solution-to-git', 'SKILL.md',
);

let prose;
test('connect-solution-to-git SKILL.md exists and is readable', () => {
  prose = fs.readFileSync(SKILL_MD, 'utf8');
  assert.ok(prose.length > 1000, 'SKILL.md should be non-trivial in size');
});

// ===== E1 — envUrl ↔ pac env who mismatch hard-fail =====

test('E1: Phase 1 declares `<envUrl>` as a required parameter (no implicit-current-env fallback)', () => {
  assert.match(prose, /Required parameter:\*?\*?\s*`<envUrl>`/i);
  assert.match(prose, /does NOT have an implicit/i);
});

test('E1: Phase 1 step 1 has a verbatim PowerShell snippet calling `pac env who --json`', () => {
  // The snippet MUST contain the literal command, the comparison branch,
  // and the recovery hint pointing at `pac org select --environment`.
  assert.match(prose, /pac env who --json \| ConvertFrom-Json/);
  assert.match(prose, /TrimEnd\('\/'\)\.ToLowerInvariant\(\)/);
  assert.match(prose, /\[envUrl-mismatch\] expected=\$expected actual=\$actual/);
});

test('E1: mismatch recovery prompt offers `pac org select --environment <expected>`', () => {
  assert.match(prose, /pac org select --environment ["{]<?[\w{]/i);
  // The Switch-PAC branch and Cancel branch are both present
  assert.match(prose, /Switch PAC: `pac org select --environment/);
  assert.match(prose, /Cancel — re-run with the correct --envUrl/);
});

// ===== E2 — drop PAT prereq + add Phase 1 step 0 silent token acquisition =====

test('E2: Prerequisites section does NOT contain the legacy "Optional ADO PAT" line', () => {
  // The 2026-06-11 live test removed PAT from the prereq path entirely —
  // tokens are now minted via az / Entra. Any future re-introduction of
  // a PAT prereq must be deliberate and re-evaluated.
  assert.doesNotMatch(prose, /\*\*Optional\*\*\s*ADO PAT/i);
  assert.doesNotMatch(prose, /Optional ADO PAT with `Code/i);
});

test('E2: Prerequisites section calls out az login as the auth path (no PAT)', () => {
  assert.match(prose, /Azure CLI installed and logged in.*az login/i);
  assert.match(prose, /never\*?\*?\s*asked for a PAT/i);
});

test('E2: Phase 1 has a step 0 that invokes get-ado-token.js --writeToFile docs/inner-loop/.ado-token', () => {
  // The skill MUST acquire the bearer token BEFORE the envUrl/PAC mismatch
  // check (step 1) because subsequent Phase 3 ADO pre-checks rely on it.
  const phase1Idx = prose.indexOf('## Phase 1 — Prereq Check');
  const phase2Idx = prose.indexOf('## Phase 2');
  assert.ok(phase1Idx > 0 && phase2Idx > phase1Idx, 'Phase 1 and Phase 2 headers must exist');
  const phase1 = prose.slice(phase1Idx, phase2Idx);
  assert.match(phase1, /^0\. \*\*Acquire an ADO Entra bearer token/m);
  assert.match(phase1, /get-ado-token\.js"?\s+--writeToFile\s+"docs\/inner-loop\/\.ado-token"/);
  // Tenant verification must be deferred to Phase 3 step 3a — not done here
  // because the org name isn't known yet.
  assert.match(phase1, /Tenant verification.*Phase 3 step 3a/i);
});

test('E2: Phase 1 step 0 lists every Phase 3 helper that consumes the token', () => {
  const phase1Idx = prose.indexOf('## Phase 1 — Prereq Check');
  const phase2Idx = prose.indexOf('## Phase 2');
  const phase1 = prose.slice(phase1Idx, phase2Idx);
  // These are the ADO helpers wired by E4 (3a-3e) and E5/E7 (3.4-3.5).
  for (const helper of [
    'list-ado-orgs',
    'list-ado-projects',
    'list-ado-repos',
    'verify-ado-permissions',
    'verify-repo-initialized',
    'list-ado-folders',
    'check-ado-folder-exists',
  ]) {
    assert.match(phase1, new RegExp(helper), `Phase 1 step 0 must reference ${helper} as a downstream consumer`);
  }
});
