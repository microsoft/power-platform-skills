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

// ===== E4 — Phase 3 step 3 cascading discovery (3a/3b/3c/3c.5/3d/3e) =====

test('E4: Phase 3 step 3 declares cascading discovery (org → project → repo → branch → folder)', () => {
  assert.match(prose, /Cascading selection of ADO coordinates \(org → project → repo → branch → folder\)/);
  // The legacy free-text gate ID is RETIRED
  assert.doesNotMatch(prose, /connect-solution-to-git:3\.ado-fields/);
});

test('E4: each sub-step 3a-3e is present with its gate ID', () => {
  // 3a — org (gate)
  assert.match(prose, /Sub-step 3a — Select organization/);
  assert.match(prose, /connect-solution-to-git:3\.ado-org/);
  // 3b — project (gate, no Create-new)
  assert.match(prose, /Sub-step 3b — Select project/);
  assert.match(prose, /connect-solution-to-git:3\.ado-project/);
  assert.match(prose, /intentionally does NOT offer "Create new project"/);
  // 3c — repo (gate, with Create-new sub-gate)
  assert.match(prose, /Sub-step 3c — Select repository/);
  assert.match(prose, /connect-solution-to-git:3\.ado-repo/);
  assert.match(prose, /connect-solution-to-git:3\.create-repo/);
  // 3c.5 — perms (intent gate, hard-block)
  assert.match(prose, /Sub-step 3c\.5 — Verify ADO permissions/);
  assert.match(prose, /connect-solution-to-git:3\.ado-perms/);
  // 3d — branch (not-a-gate)
  assert.match(prose, /Sub-step 3d — Collect branch \(free-text, not-a-gate\)/);
  assert.match(prose, /connect-solution-to-git:3\.branch/);
  // 3e — folder (not-a-gate, with format warning)
  assert.match(prose, /Sub-step 3e — Select folder-in-repo/);
  assert.match(prose, /connect-solution-to-git:3\.folder\b/);
});

test('E4: each cascading helper is wired with the canonical CLI args', () => {
  assert.match(prose, /list-ado-orgs\.js"?\s+--token "<adoToken>"/);
  assert.match(prose, /list-ado-projects\.js"?\s+--organization "<org>" --token "<adoToken>"/);
  assert.match(prose, /list-ado-repos\.js"?\s+--organization "<org>" --project "<proj>" --token "<adoToken>"/);
  assert.match(prose, /verify-ado-permissions\.js"?[\s\\]+--organization "<org>" --project "<proj>" --repository "<repo>" --token "<adoToken>"/);
  assert.match(prose, /list-ado-folders\.js"?[\s\\]+--organization "<org>" --project "<proj>" --repository "<repo>" --token "<adoToken>"/);
});

test('E4: 3a and 3b auto-select when count==1', () => {
  const orgIdx = prose.indexOf('Sub-step 3a — Select organization');
  const projIdx = prose.indexOf('Sub-step 3b — Select project');
  const repoIdx = prose.indexOf('Sub-step 3c — Select repository');
  assert.ok(orgIdx > 0 && projIdx > orgIdx && repoIdx > projIdx);
  const orgSect = prose.slice(orgIdx, projIdx);
  const projSect = prose.slice(projIdx, repoIdx);
  assert.match(orgSect, /singleOrg.*auto-select/is);
  assert.match(projSect, /singleProject.*auto-select/is);
});

test('E4: tenant cross-check fires between 3a and 3b (after org known, before project list)', () => {
  const orgIdx = prose.indexOf('Sub-step 3a — Select organization');
  const projIdx = prose.indexOf('Sub-step 3b — Select project');
  const between = prose.slice(orgIdx, projIdx);
  assert.match(between, /Tenant cross-check/);
  assert.match(between, /--verifyTenant --organization "<org>"/);
  assert.match(between, /--writeToFile "docs\/inner-loop\/\.ado-token"/);
});

test('E4: folder-name format warning enforced in 3e prompt helper-text (anti-trailing-slash)', () => {
  const phase3 = prose.slice(prose.indexOf('## Phase 3'), prose.indexOf('## Phase 4'));
  // The 0x80040265 error must be cited as the rationale
  assert.match(phase3, /0x80040265/);
  // Rejection of slashes + trailing slashes must be explicit
  assert.match(phase3, /Rejected.*containing `\/`/);
  assert.match(phase3, /trailing slash/i);
  // Default suggestion is the solutionUniqueName (1:1 mapping)
  assert.match(phase3, /default to suggest.*solutionUniqueName/is);
});

test('E4: approval-gates.md §6A.3 catalog lists every NEW gate ID', () => {
  const cat = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'references', 'approval-gates.md'),
    'utf8',
  );
  for (const id of [
    'connect-solution-to-git:3.ado-org',
    'connect-solution-to-git:3.ado-project',
    'connect-solution-to-git:3.ado-repo',
    'connect-solution-to-git:3.create-repo',
    'connect-solution-to-git:3.ado-perms',
    'connect-solution-to-git:3.repo-init',
    'connect-solution-to-git:3.folder-occupied',
    'connect-solution-to-git:3.branch',
    'connect-solution-to-git:3.folder',
  ]) {
    assert.match(cat, new RegExp(id.replace(/\./g, '\\.')), `approval-gates.md must list ${id}`);
  }
  // The retired legacy ID is gone
  assert.doesNotMatch(cat, /connect-solution-to-git:3\.ado-fields/);
});


// ===== E5 — Phase 3 step 4 self-capable repo-init gate =====

test('E5: Phase 3 step 4 declares the connect-solution-to-git:3.repo-init gate (no setup-git-integration cross-reference)', () => {
  const phase3 = prose.slice(prose.indexOf('## Phase 3'), prose.indexOf('## Phase 4'));
  // The gate marker comment + headline must be inline in this skill, not delegated.
  assert.match(phase3, /<!-- gate: connect-solution-to-git:3\.repo-init \| category=consent \| cancel-leaves=nothing -->/);
  assert.match(phase3, /Gate \(consent · connect-solution-to-git:3\.repo-init\)/);
  // The retired legacy "Same as setup-git-integration Phase 2 step 2" must be gone from step 4.
  const step4Idx = phase3.indexOf('4. Repo-init check');
  assert.ok(step4Idx > -1, 'Phase 3 step 4 must use the heading "4. Repo-init check"');
  const step4 = phase3.slice(step4Idx);
  assert.doesNotMatch(step4, /Same as `setup-git-integration` Phase 2 step 2/);
  assert.doesNotMatch(step4, /setup-git-integration:2\.repo-init/);
});

test('E5: Phase 3 step 4 verify-repo-initialized CLI invocation includes the 4 required args', () => {
  const phase3 = prose.slice(prose.indexOf('## Phase 3'), prose.indexOf('## Phase 4'));
  // The bash fence MUST contain the helper path and the 4 flags it requires.
  assert.match(phase3, /scripts\/lib\/verify-repo-initialized\.js/);
  // All 4 args must be there (--organization, --project, --repository, --token).
  const helperBlock = phase3.slice(phase3.indexOf('verify-repo-initialized.js'));
  assert.match(helperBlock, /--organization "<org>"/);
  assert.match(helperBlock, /--project "<proj>"/);
  assert.match(helperBlock, /--repository "<repo>"/);
  assert.match(helperBlock, /--token "<adoToken>"/);
});

test('E5: repo-init gate offers all 3 prescribed options in the prescribed order', () => {
  const phase3 = prose.slice(prose.indexOf('## Phase 3'), prose.indexOf('## Phase 4'));
  const gateIdx = phase3.indexOf('connect-solution-to-git:3.repo-init');
  const gateSect = phase3.slice(gateIdx);
  // The 3 options must appear in this exact order in the options column.
  assert.match(
    gateSect,
    /Auto-init \(Recommended\),\s*Initialize manually then re-run,\s*Cancel and pick a different repo/,
  );
});

test('E5: Auto-init branch invokes init-ado-repo.js with the 5 required args', () => {
  const phase3 = prose.slice(prose.indexOf('## Phase 3'), prose.indexOf('## Phase 4'));
  const initIdx = phase3.indexOf('init-ado-repo.js');
  assert.ok(initIdx > -1, 'Phase 3 step 4 must invoke init-ado-repo.js in the Auto-init branch');
  const initBlock = phase3.slice(initIdx);
  // Helper takes 5 args: org, project, repository, branch, token
  assert.match(initBlock, /--organization "<org>"/);
  assert.match(initBlock, /--project "<proj>"/);
  assert.match(initBlock, /--repository "<repo>"/);
  assert.match(initBlock, /--branch "<branch>"/);
  assert.match(initBlock, /--token "<adoToken>"/);
});

test('E5: Auto-init decision tree handles statusCode 401, 403, 404, alreadyInitialized, and other failures', () => {
  const phase3 = prose.slice(prose.indexOf('## Phase 3'), prose.indexOf('## Phase 4'));
  const step4 = phase3.slice(phase3.indexOf('4. Repo-init check'));
  // Each outcome must be explicitly covered so the gate does not silently swallow errors.
  assert.match(step4, /ok:true, initialized:true/);
  assert.match(step4, /ok:true, alreadyInitialized:true/);
  assert.match(step4, /ok:false, statusCode:401/);
  assert.match(step4, /ok:false, statusCode:403/);
  assert.match(step4, /ok:false, statusCode:404/);
  assert.match(step4, /ok:false.*other/i);
});


// ===== E7 — Phase 3 step 5 folder-occupancy check + gate =====

test('E7: Phase 3 has a step 5 named "Folder-occupancy check"', () => {
  const phase3 = prose.slice(prose.indexOf('## Phase 3'), prose.indexOf('## Phase 4'));
  assert.match(phase3, /^5\.\s+Folder-occupancy check/m);
});

test('E7: step 5 invokes check-ado-folder-exists.js with all 6 required args', () => {
  const phase3 = prose.slice(prose.indexOf('## Phase 3'), prose.indexOf('## Phase 4'));
  const step5Idx = phase3.indexOf('5. Folder-occupancy check');
  const step5 = phase3.slice(step5Idx);
  assert.match(step5, /scripts\/lib\/check-ado-folder-exists\.js/);
  const helperBlock = step5.slice(step5.indexOf('check-ado-folder-exists.js'));
  assert.match(helperBlock, /--organization "<org>"/);
  assert.match(helperBlock, /--project "<proj>"/);
  assert.match(helperBlock, /--repository "<repo>"/);
  assert.match(helperBlock, /--gitFolder "<gitFolder>"/);
  assert.match(helperBlock, /--branch "<branch>"/);
  assert.match(helperBlock, /--token "<adoToken>"/);
});

test('E7: step 5 declares the connect-solution-to-git:3.folder-occupied gate inline (no cross-skill reference)', () => {
  const phase3 = prose.slice(prose.indexOf('## Phase 3'), prose.indexOf('## Phase 4'));
  assert.match(phase3, /<!-- gate: connect-solution-to-git:3\.folder-occupied \| category=consent \| cancel-leaves=nothing -->/);
  assert.match(phase3, /Gate \(consent · connect-solution-to-git:3\.folder-occupied\)/);
});

test('E7: folder-occupied gate fires ONLY when itemCount > 0 (decision tree explicit)', () => {
  const phase3 = prose.slice(prose.indexOf('## Phase 3'), prose.indexOf('## Phase 4'));
  const step5Idx = phase3.indexOf('5. Folder-occupancy check');
  const step5 = phase3.slice(step5Idx);
  // exists:false → no gate, continue
  assert.match(step5, /ok:true, exists:false.*no collision/is);
  assert.match(step5, /no gate fires/);
  // exists:true → fire gate
  assert.match(step5, /ok:true, exists:true, itemCount:N.*Fire the folder-occupied consent gate/is);
});

test('E7: folder-occupied gate offers the 4 prescribed options in the prescribed order', () => {
  const phase3 = prose.slice(prose.indexOf('## Phase 3'), prose.indexOf('## Phase 4'));
  const gateIdx = phase3.indexOf('connect-solution-to-git:3.folder-occupied');
  const gateSect = phase3.slice(gateIdx);
  assert.match(
    gateSect,
    /Pick a different gitFolder \(back to 3e\),\s*Pick a different repo \(back to 3c\),\s*Proceed anyway \(acknowledge risk\),\s*Cancel/,
  );
});

test('E7: preBindFolderOccupancy is persisted into Phase 4 planData', () => {
  const phase4 = prose.slice(prose.indexOf('## Phase 4'), prose.indexOf('## Phase 5'));
  // Field appears in the planData JSON shape
  assert.match(phase4, /"preBindFolderOccupancy"/);
});

test('E7: Phase 3 step 5 final Output line mentions the folder-occupancy outcome', () => {
  const phase3 = prose.slice(prose.indexOf('## Phase 3'), prose.indexOf('## Phase 4'));
  // The final Output: line of Phase 3 must acknowledge step 5's contribution.
  assert.match(phase3, /target folder confirmed empty.*collision acknowledged/i);
});
