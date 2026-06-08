'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { checkInnerLoopPlan, HEARTBEAT_WINDOW_MIN } = require('../lib/inner-loop-plan-state');

function tempProject(planData) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inner-loop-plan-state-'));
  if (planData !== null && planData !== undefined) {
    fs.mkdirSync(path.join(dir, 'docs', 'inner-loop'), { recursive: true });
    const body = typeof planData === 'string' ? planData : JSON.stringify(planData);
    fs.writeFileSync(path.join(dir, 'docs', 'inner-loop', 'inner-loop-plan.json'), body, 'utf8');
  }
  return dir;
}

function cleanup(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

test('returns exists:false / no-plan when plan file does not exist', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inner-loop-noplan-'));
  try {
    const r = await checkInnerLoopPlan({ projectRoot: dir });
    assert.equal(r.exists, false);
    assert.equal(r.stale, true);
    assert.equal(r.staleness.reason, 'no-plan');
    assert.equal(r.inExecution.status, 'no-plan');
    assert.equal(r.inExecution.windowMin, HEARTBEAT_WINDOW_MIN);
    assert.equal(r.planPath, null);
    assert.equal(r.htmlPath, null);
  } finally { cleanup(dir); }
});

test('returns exists:false / no-plan when plan file is malformed JSON', async () => {
  const dir = tempProject('{not valid json,,,');
  try {
    const r = await checkInnerLoopPlan({ projectRoot: dir });
    assert.equal(r.exists, false);
    assert.equal(r.staleness.reason, 'no-plan');
    assert.match(r.staleness.detail, /could not be parsed/i);
  } finally { cleanup(dir); }
});

test('returns exists:true / stale:false / state classification from cached plan data', async () => {
  const dir = tempProject({
    GENERATED_AT: '2026-04-01T00:00:00.000Z',
    PLAN_STATUS: 'Idle',
    binding: {
      bindingType: 'environment',
      organization: 'contoso',
      project: 'pp-site',
      repository: 'pp-site-repo',
      branch: 'main',
      gitFolder: '/site-name',
    },
    pendingCounts: { changes: 2, updates: 0, conflicts: 0 },
    state: 'Dirty',
  });
  try {
    const r = await checkInnerLoopPlan({ projectRoot: dir });
    assert.equal(r.exists, true);
    assert.equal(r.stale, false);
    assert.equal(r.generatedAt, '2026-04-01T00:00:00.000Z');
    assert.equal(r.bindingDetected, true);
    assert.equal(r.bindingType, 'environment');
    assert.equal(r.state, 'Dirty');
    assert.deepEqual(r.pendingCounts, { changes: 2, updates: 0, conflicts: 0 });
    assert.equal(r.inExecution.status, 'not-running');
  } finally { cleanup(dir); }
});

test('classifies inExecution.active when PLAN_STATUS=In Execution and heartbeat is fresh', async () => {
  const now = Date.UTC(2026, 4, 1, 12, 0, 0); // 2026-05-01 12:00:00 UTC
  const tenMinAgo = new Date(now - 10 * 60 * 1000).toISOString();
  const dir = tempProject({
    GENERATED_AT: '2026-05-01T11:00:00.000Z',
    PLAN_STATUS: 'In Execution',
    LAST_INVOCATION_AT: tenMinAgo,
  });
  try {
    const r = await checkInnerLoopPlan({ projectRoot: dir, now, writeHeartbeat: false });
    assert.equal(r.inExecution.status, 'active');
    assert.equal(r.inExecution.windowMin, HEARTBEAT_WINDOW_MIN);
  } finally { cleanup(dir); }
});

test('classifies inExecution.stale-heartbeat when PLAN_STATUS=In Execution but heartbeat is too old', async () => {
  const now = Date.UTC(2026, 4, 1, 12, 0, 0);
  const twoHoursAgo = new Date(now - 120 * 60 * 1000).toISOString();
  const dir = tempProject({
    PLAN_STATUS: 'In Execution',
    LAST_INVOCATION_AT: twoHoursAgo,
  });
  try {
    const r = await checkInnerLoopPlan({ projectRoot: dir, now, writeHeartbeat: false });
    assert.equal(r.inExecution.status, 'stale-heartbeat');
    assert.match(r.inExecution.reason, /stalled|min ago/i);
  } finally { cleanup(dir); }
});

test('refreshes LAST_INVOCATION_AT when PLAN_STATUS=In Execution and writeHeartbeat is enabled', async () => {
  const now = Date.UTC(2026, 4, 1, 12, 0, 0);
  const dir = tempProject({
    PLAN_STATUS: 'In Execution',
    LAST_INVOCATION_AT: new Date(now - 5 * 60 * 1000).toISOString(),
  });
  try {
    await checkInnerLoopPlan({ projectRoot: dir, now, writeHeartbeat: true });
    const planPath = path.join(dir, 'docs', 'inner-loop', 'inner-loop-plan.json');
    const written = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    assert.equal(written.LAST_INVOCATION_AT, new Date(now).toISOString(),
      'heartbeat write should pin LAST_INVOCATION_AT to the passed `now`');
  } finally { cleanup(dir); }
});

test('does NOT refresh LAST_INVOCATION_AT when PLAN_STATUS is not "In Execution"', async () => {
  const now = Date.UTC(2026, 4, 1, 12, 0, 0);
  const originalLast = new Date(now - 15 * 60 * 1000).toISOString();
  const dir = tempProject({
    PLAN_STATUS: 'Idle',
    LAST_INVOCATION_AT: originalLast,
  });
  try {
    await checkInnerLoopPlan({ projectRoot: dir, now, writeHeartbeat: true });
    const planPath = path.join(dir, 'docs', 'inner-loop', 'inner-loop-plan.json');
    const written = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    assert.equal(written.LAST_INVOCATION_AT, originalLast,
      'a non-"In Execution" plan should not have its heartbeat refreshed');
  } finally { cleanup(dir); }
});

test('does NOT refresh heartbeat when writeHeartbeat=false (audit / test mode)', async () => {
  const now = Date.UTC(2026, 4, 1, 12, 0, 0);
  const originalLast = new Date(now - 5 * 60 * 1000).toISOString();
  const dir = tempProject({
    PLAN_STATUS: 'In Execution',
    LAST_INVOCATION_AT: originalLast,
  });
  try {
    await checkInnerLoopPlan({ projectRoot: dir, now, writeHeartbeat: false });
    const planPath = path.join(dir, 'docs', 'inner-loop', 'inner-loop-plan.json');
    const written = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    assert.equal(written.LAST_INVOCATION_AT, originalLast);
  } finally { cleanup(dir); }
});

test('htmlPath is populated only when the HTML file exists alongside the JSON plan', async () => {
  const dir = tempProject({ PLAN_STATUS: 'Idle' });
  try {
    let r = await checkInnerLoopPlan({ projectRoot: dir, writeHeartbeat: false });
    assert.equal(r.htmlPath, null, 'precondition: no HTML yet');

    fs.writeFileSync(path.join(dir, 'docs', 'inner-loop', 'inner-loop-plan.html'),
      '<html><body>plan</body></html>');

    r = await checkInnerLoopPlan({ projectRoot: dir, writeHeartbeat: false });
    assert.ok(r.htmlPath && r.htmlPath.endsWith('inner-loop-plan.html'),
      'htmlPath should be populated once the file exists');
  } finally { cleanup(dir); }
});

test('bindingDetected=false when plan has no binding', async () => {
  const dir = tempProject({ PLAN_STATUS: 'Idle' });
  try {
    const r = await checkInnerLoopPlan({ projectRoot: dir, writeHeartbeat: false });
    assert.equal(r.bindingDetected, false);
    assert.equal(r.bindingType, null);
  } finally { cleanup(dir); }
});

test('requires projectRoot', async () => {
  await assert.rejects(() => checkInnerLoopPlan({}), /projectRoot is required/);
});

test('pendingCounts shape is preserved (null when absent, numbers when present)', async () => {
  const dirNo = tempProject({ PLAN_STATUS: 'Idle' });
  const dirYes = tempProject({
    PLAN_STATUS: 'Idle',
    pendingCounts: { changes: 1, updates: 2, conflicts: 0 },
  });
  try {
    const rNo = await checkInnerLoopPlan({ projectRoot: dirNo, writeHeartbeat: false });
    assert.equal(rNo.pendingCounts, null);

    const rYes = await checkInnerLoopPlan({ projectRoot: dirYes, writeHeartbeat: false });
    assert.deepEqual(rYes.pendingCounts, { changes: 1, updates: 2, conflicts: 0 });
  } finally { cleanup(dirNo); cleanup(dirYes); }
});
