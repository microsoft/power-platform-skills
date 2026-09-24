'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { preparePlanProvenance, verifyPlanProvenance, planTargets } = require('../genpage-plan-provenance.js');

// What the planner hands back for approval (agents/genpage-planner.md Step 5) — a PREVIEW, with full
// prefixed names — and what it then writes (Step 6): a different document, suffixes only. The gate
// must accept the pair; a whole-document hash never could.
const PREVIEW = [
  '## Genpage Plan',
  '',
  '### Pages (2 total)',
  '| Page | File | Purpose | Entities |',
  '|------|------|---------|----------|',
  '| Overview | overview.tsx | Summary cards | contoso_project |',
  '| Details | details.tsx | One record | contoso_project |',
  '',
  '### Data Strategy',
  '- Entities to create: contoso_project (contoso_name, contoso_stage)',
  '',
  '### Localization',
  '- English only — no localization needed',
].join('\n');
const WRITTEN = [
  '# Genpage Plan',
  '## User Requirements',
  'Projects overview and details.',
  '## Pages',
  '| Page | File | Purpose | Entities |',
  '|------|------|---------|----------|',
  '| Details | details.tsx | One record | project |',
  '| Overview | overview.tsx | Summary cards | project |',
  '## Entity Creation Required',
  '### project',
  '| Suffix | Type |',
  '|---|---|',
  '| name | Text |',
  '## Per-Page Specifications',
  '### Overview',
  '- **File:** overview.tsx',
].join('\r\n');
const PAGE_ID = '6e0c28a2-cdbf-41ec-9186-d10fd5de6e35';
const EDIT_PREVIEW = `## Genpage Edit Plan\n\n### Current State\n- **File:** ${PAGE_ID}/page.tsx\n- **Data:** Mock data\n\n### Proposed Changes\n1. Add a search box\n`;
const EDIT_WRITTEN = `# Genpage Edit Plan\n\n## File Being Edited\n- **Absolute path:** D:\\work\\edit\\${PAGE_ID}\\page.tsx\n- **App ID:** 11111111-2222-3333-4444-555555555555\n- **Page ID:** ${PAGE_ID}\n`;

function tmpPlan(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genpage-plan-prov-'));
  const planPath = path.join(dir, 'genpage-plan.md');
  if (content !== undefined) fs.writeFileSync(planPath, content, 'utf8');
  return planPath;
}

test('preparePlanProvenance quarantines a stale plan before planner dispatch', () => {
  const planPath = tmpPlan('# Genpage Plan\nstale\n');

  const result = preparePlanProvenance({ planPath });

  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(planPath), false, 'stale plan must not remain at the authoritative path');
  assert.ok(result.quarantinedPath, 'quarantine path reported');
  assert.equal(fs.readFileSync(result.quarantinedPath, 'utf8'), '# Genpage Plan\nstale\n');
});

test('what a plan targets: the Pages files of a create, the page id of an edit, in either document', () => {
  assert.deepEqual(planTargets(PREVIEW), { kind: 'create', targets: ['details.tsx', 'overview.tsx'] });
  assert.deepEqual(planTargets(WRITTEN), { kind: 'create', targets: ['details.tsx', 'overview.tsx'] });
  assert.deepEqual(planTargets(EDIT_PREVIEW), { kind: 'edit', targets: [PAGE_ID] });
  assert.deepEqual(planTargets(EDIT_WRITTEN), { kind: 'edit', targets: [PAGE_ID] });
  assert.equal(planTargets('## Genpage Plan\n### Data Strategy\n- none\n'), null);
  // A create plan's per-page File line holding a GUID path is still a create, decided by its table.
  const guidFile = WRITTEN.replace('- **File:** overview.tsx', `- **File:** ${PAGE_ID}/page.tsx`);
  assert.equal(planTargets(guidFile).kind, 'create');
});

// The preview approved in plan mode and the file the planner writes are different documents by design.
test('verifyPlanProvenance accepts the written plan when it targets exactly the approved pages', () => {
  const create = verifyPlanProvenance({ planPath: tmpPlan(WRITTEN), approvedPlan: PREVIEW });
  assert.equal(create.ok, true, create.error);
  assert.deepEqual(create.targets, ['details.tsx', 'overview.tsx']);
  assert.match(create.writtenHash, /^[a-f0-9]{64}$/, 'the verified file is recorded by hash for the log');
  const edit = verifyPlanProvenance({ planPath: tmpPlan(EDIT_WRITTEN), approvedPlan: EDIT_PREVIEW });
  assert.equal(edit.ok, true, edit.error);
});

// A stale plan from an earlier run, or one the planner re-derived, targets other pages.
test('verifyPlanProvenance halts when the written plan targets other pages than were approved', () => {
  for (const [what, written] of [
    ['an extra page', WRITTEN.replace('| Overview | overview.tsx | Summary cards | project |', '| Overview | overview.tsx | Summary cards | project |\r\n| Admin | admin.tsx | Settings | project |')],
    ['a missing page', WRITTEN.replace('| Details | details.tsx | One record | project |\r\n', '')],
    ['a renamed page file', WRITTEN.replace('| Details | details.tsx |', '| Details | detail-view.tsx |')],
    ['no Pages table at all', WRITTEN.replace(/## Pages[\s\S]*?## Entity/, '## Entity')],
    ['an edit plan instead', EDIT_WRITTEN],
  ]) {
    const result = verifyPlanProvenance({ planPath: tmpPlan(written), approvedPlan: PREVIEW });
    assert.equal(result.ok, false, what);
    assert.match(result.error, /approved plan named details\.tsx, overview\.tsx/, what);
  }
  const otherPage = verifyPlanProvenance({ planPath: tmpPlan(EDIT_WRITTEN.replace(/6e0c28a2/g, '7f1d39b3')), approvedPlan: EDIT_PREVIEW });
  assert.equal(otherPage.ok, false, 'an edit plan for another page');
});

test('verifyPlanProvenance halts when the planner wrote nothing, or the approval names no pages', () => {
  const missing = verifyPlanProvenance({ planPath: tmpPlan(), approvedPlan: PREVIEW });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /planner did not write/);
  const vague = verifyPlanProvenance({ planPath: tmpPlan(WRITTEN), approvedPlan: 'Approved!' });
  assert.equal(vague.ok, false);
  assert.match(vague.error, /approved plan body names no pages/);
});

// The skill acts on the CLI's exit code and JSON line, so that contract is pinned end to end.
test('the CLI prepares and verifies by exit code: 0 on success, 3 on a failed gate, 1 on a usage error', () => {
  const { spawnSync } = require('node:child_process');
  const script = path.join(__dirname, '..', 'genpage-plan-provenance.js');
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genpage-plan-prov-cli-'));
  try {
    const planPath = path.join(dir, 'genpage-plan.md');
    const approved = path.join(dir, '.approved-genpage-plan.md');
    fs.writeFileSync(planPath, 'stale\n');
    const prep = run('prepare', '--plan', planPath);
    assert.equal(prep.status, 0, prep.stdout);
    assert.equal(JSON.parse(prep.stdout).ok, true);
    assert.equal(fs.existsSync(planPath), false, 'quarantined');
    // A second prepare with nothing to move is still a success, and a colliding stale name gets its own slot.
    assert.equal(run('prepare', '--plan', planPath).status, 0);
    fs.writeFileSync(planPath, 'stale\n');
    const again = JSON.parse(run('prepare', '--plan', planPath).stdout);
    assert.notEqual(again.quarantinedPath, JSON.parse(prep.stdout).quarantinedPath, 'an identical stale plan does not overwrite the first');

    fs.writeFileSync(approved, PREVIEW);
    const missing = run('verify', '--plan', planPath, '--approved', `@${approved}`);
    assert.equal(missing.status, 3);
    assert.match(JSON.parse(missing.stdout).error, /planner did not write/);
    fs.writeFileSync(planPath, WRITTEN);
    assert.equal(run('verify', '--plan', planPath, '--approved', `@${approved}`).status, 0);
    fs.writeFileSync(planPath, WRITTEN.replace('details.tsx', 'other.tsx'));
    assert.equal(run('verify', '--plan', planPath, '--approved', `@${approved}`).status, 3);

    assert.equal(run('verify', '--plan', planPath).status, 3, 'verify without --approved fails the gate');
    assert.equal(run('prepare').status, 3, 'prepare without --plan fails the gate');
    assert.equal(run('bogus').status, 1, 'an unknown command is a usage error');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
