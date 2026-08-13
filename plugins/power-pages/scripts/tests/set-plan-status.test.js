'use strict';

// Tests for set-plan-status.js — the deterministic Draft/Approved writer that
// replaces plan-alm Phase 4's hand-authored Edits. The key invariants:
//   - Approved writes all four fields together (no partial "approver but Draft").
//   - Draft clears the approver (a draft has no approver).
//   - Approved without an approver is refused (can't create the broken state).
//   - A live plan (In Execution / Completed) is not silently re-drafted.
//   - --render regenerates docs/alm-plan.html with the matching badge.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { setPlanStatus } = require('../lib/set-plan-status');

function makeProject(t, planData) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'set-plan-status-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  if (planData !== undefined) {
    fs.writeFileSync(path.join(root, 'docs', '.alm-plan-data.json'), JSON.stringify(planData, null, 2));
  }
  return root;
}

function readPlan(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'docs', '.alm-plan-data.json'), 'utf8'));
}

test('Approved writes PLAN_STATUS + PLAN_MODE + APPROVED_BY + APPROVAL_DATE atomically', (t) => {
  const root = makeProject(t, { PLAN_STATUS: 'Draft', SITE_NAME: 'T' });
  const res = setPlanStatus({
    projectRoot: root, status: 'Approved', approver: 'Jane Doe',
    makeNow: () => '2026-06-22T00:00:00.000Z',
  });
  assert.equal(res.ok, true);
  assert.equal(res.previousStatus, 'Draft');
  assert.equal(res.status, 'Approved');
  assert.equal(res.mode, 'approved');

  const plan = readPlan(root);
  assert.equal(plan.PLAN_STATUS, 'Approved');
  assert.equal(plan.PLAN_MODE, 'approved');
  assert.equal(plan.APPROVED_BY, 'Jane Doe');
  assert.equal(plan.APPROVAL_DATE, '2026-06-22T00:00:00.000Z');
  // The whole point: no half-written state — all four agree.
});

test('Approved trims the approver and defaults APPROVAL_DATE to now', (t) => {
  const root = makeProject(t, { PLAN_STATUS: 'Draft' });
  const res = setPlanStatus({
    projectRoot: root, status: 'Approved', approver: '  Spaced Name  ',
    makeNow: () => '2026-01-02T03:04:05.000Z',
  });
  assert.equal(res.approver, 'Spaced Name');
  assert.equal(res.approvalDate, '2026-01-02T03:04:05.000Z');
  assert.equal(readPlan(root).APPROVED_BY, 'Spaced Name');
});

test('Draft clears a stale approver (a draft carries no approver)', (t) => {
  // This is exactly the broken state to recover from: approver set but Draft.
  const root = makeProject(t, { PLAN_STATUS: 'Draft', APPROVED_BY: 'Stale', APPROVAL_DATE: '2026-01-01T00:00:00Z' });
  const res = setPlanStatus({ projectRoot: root, status: 'Draft' });
  assert.equal(res.mode, 'draft');
  const plan = readPlan(root);
  assert.equal(plan.PLAN_STATUS, 'Draft');
  assert.equal(plan.PLAN_MODE, 'draft');
  assert.equal(plan.APPROVED_BY, '');
  assert.equal(plan.APPROVAL_DATE, '');
});

test('Approved without an approver is refused (cannot create the broken state)', (t) => {
  const root = makeProject(t, { PLAN_STATUS: 'Draft' });
  assert.throws(() => setPlanStatus({ projectRoot: root, status: 'Approved' }), /--approver is required/);
  assert.throws(() => setPlanStatus({ projectRoot: root, status: 'Approved', approver: '   ' }), /--approver is required/);
  // Plan must be untouched after a refused write.
  assert.equal(readPlan(root).PLAN_STATUS, 'Draft');
});

test('rejects a status this helper does not own', (t) => {
  const root = makeProject(t, { PLAN_STATUS: 'Draft' });
  assert.throws(() => setPlanStatus({ projectRoot: root, status: 'In Execution' }), /--status must be one of/);
  assert.throws(() => setPlanStatus({ projectRoot: root, status: 'Completed' }), /--status must be one of/);
});

test('refuses to regress a live plan without --force, allows with --force', (t) => {
  for (const live of ['In Execution', 'Completed']) {
    const root = makeProject(t, { PLAN_STATUS: live, APPROVED_BY: 'X' });
    assert.throws(
      () => setPlanStatus({ projectRoot: root, status: 'Draft' }),
      new RegExp(`already "${live}"`),
      `should refuse to re-draft a ${live} plan`,
    );
    // With --force it proceeds.
    const res = setPlanStatus({ projectRoot: root, status: 'Draft', force: true });
    assert.equal(res.status, 'Draft');
    assert.equal(readPlan(root).PLAN_STATUS, 'Draft');
  }
});

test('throws when there is no plan file', (t) => {
  const root = makeProject(t); // no plan-data written
  assert.throws(() => setPlanStatus({ projectRoot: root, status: 'Draft' }), /No ALM plan found/);
});

test('throws on unparseable plan file', (t) => {
  const root = makeProject(t);
  fs.writeFileSync(path.join(root, 'docs', '.alm-plan-data.json'), 'not json {{{');
  assert.throws(() => setPlanStatus({ projectRoot: root, status: 'Draft' }), /Could not parse/);
});

test('--render regenerates docs/alm-plan.html with the matching badge', (t) => {
  const root = makeProject(t, {
    PLAN_STATUS: 'Draft', SITE_NAME: 'DemoSite', GENERATED_AT: '2026-06-22',
    STRATEGY: 'Pipelines', stages: [], steps: [], risks: [],
  });
  const res = setPlanStatus({
    projectRoot: root, status: 'Approved', approver: 'Jane', render: true,
    makeNow: () => '2026-06-22T00:00:00.000Z',
  });
  assert.equal(res.rendered, true);
  const html = fs.readFileSync(path.join(root, 'docs', 'alm-plan.html'), 'utf8');
  // Badge derived from plan-data — text "Approved" and the status class applied.
  assert.match(html, /<span class="plan-status approved">Approved<\/span>/);
  // Approver surfaces in the Execution tab footer.
  assert.match(html, /Jane/);
});

test('--render failure leaves BOTH plan-data and alm-plan.html unchanged (atomic)', (t) => {
  const root = makeProject(t, {
    PLAN_STATUS: 'Draft', SITE_NAME: 'DemoSite', GENERATED_AT: '2026-06-22',
  });
  const dataPath = path.join(root, 'docs', '.alm-plan-data.json');
  const htmlPath = path.join(root, 'docs', 'alm-plan.html');
  const before = fs.readFileSync(dataPath, 'utf8');

  // A renderer that always fails — simulates a missing/broken render script or an
  // unexpected render error. setPlanStatus must NOT leave a half-applied state.
  const badRenderer = path.join(root, 'bad-renderer.js');
  fs.writeFileSync(badRenderer, 'process.stderr.write("boom\\n"); process.exit(1);\n');

  assert.throws(() => setPlanStatus({
    projectRoot: root, status: 'Approved', approver: 'Jane', render: true,
    rendererPath: badRenderer, makeNow: () => '2026-06-22T00:00:00.000Z',
  }));

  // plan-data must be byte-for-byte unchanged (still Draft, no approver) — the
  // status write must not "land" while the HTML stays stale.
  assert.equal(fs.readFileSync(dataPath, 'utf8'), before, 'plan-data must be untouched on render failure');
  // No HTML written, and no leftover temp files.
  assert.equal(fs.existsSync(htmlPath), false, 'no alm-plan.html on render failure');
  assert.equal(fs.existsSync(dataPath + '.tmp'), false, 'no stale .alm-plan-data.json.tmp');
  assert.equal(fs.existsSync(htmlPath + '.tmp'), false, 'no stale alm-plan.html.tmp');
});

test('idempotent: re-writing the same status yields the same plan-data', (t) => {
  const root = makeProject(t, { PLAN_STATUS: 'Draft', SITE_NAME: 'T' });
  setPlanStatus({ projectRoot: root, status: 'Approved', approver: 'A', makeNow: () => '2026-06-22T00:00:00.000Z' });
  const first = readPlan(root);
  setPlanStatus({ projectRoot: root, status: 'Approved', approver: 'A', makeNow: () => '2026-06-22T00:00:00.000Z' });
  assert.deepEqual(readPlan(root), first);
});
