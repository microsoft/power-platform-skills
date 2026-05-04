'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { checkAlmPlan } = require('../lib/check-alm-plan');

function tempProject(planData) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-alm-plan-test-'));
  if (planData !== null) {
    fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
    if (typeof planData === 'string') {
      fs.writeFileSync(path.join(dir, 'docs', '.alm-plan-data.json'), planData, 'utf8');
    } else {
      fs.writeFileSync(path.join(dir, 'docs', '.alm-plan-data.json'), JSON.stringify(planData), 'utf8');
    }
  }
  return dir;
}

test('returns exists:false / stale:true when no plan file exists', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-alm-plan-noplan-'));
  try {
    const r = await checkAlmPlan({ projectRoot: dir });
    assert.equal(r.exists, false);
    assert.equal(r.stale, true);
    assert.equal(r.staleness.reason, 'no-plan');
    assert.match(r.staleness.detail, /not found/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('returns exists:false / no-plan when plan file is malformed JSON', async () => {
  const dir = tempProject('{not valid json,,,');
  try {
    const r = await checkAlmPlan({ projectRoot: dir });
    assert.equal(r.exists, false);
    assert.equal(r.staleness.reason, 'no-plan');
    assert.match(r.staleness.detail, /could not be parsed/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('returns exists:true / stale:false when plan exists and no env credentials', async () => {
  const dir = tempProject({
    SITE_NAME: 'TestSite',
    GENERATED_AT: '2026-04-01T00:00:00.000Z',
    APPROVED_BY: 'admin@example.com',
    PLAN_STATUS: 'Approved',
  });
  try {
    const r = await checkAlmPlan({ projectRoot: dir });
    assert.equal(r.exists, true);
    assert.equal(r.stale, false);
    assert.equal(r.generatedAt, '2026-04-01T00:00:00.000Z');
    assert.equal(r.approver, 'admin@example.com');
    assert.equal(r.planStatus, 'Approved');
    assert.equal(r.staleness.reason, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('flags solution-modified when solution modifiedon is later than plan GENERATED_AT', async () => {
  const dir = tempProject({
    GENERATED_AT: '2026-04-01T00:00:00.000Z',
  });
  // Mock fetch returns modifiedon AFTER GENERATED_AT
  const fakeRequest = async () => ({
    statusCode: 200,
    body: JSON.stringify({ modifiedon: '2026-04-15T08:42:00Z', version: '1.0.0.4' }),
  });
  try {
    const r = await checkAlmPlan({
      projectRoot: dir,
      envUrl: 'https://example.crm.dynamics.com',
      token: 'tok',
      solutionId: 'sol-guid',
      makeRequest: fakeRequest,
    });
    assert.equal(r.exists, true);
    assert.equal(r.stale, true);
    assert.equal(r.staleness.reason, 'solution-modified');
    assert.match(r.staleness.detail, /2026-04-15/);
    assert.match(r.staleness.detail, /2026-04-01/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('does NOT flag stale when solution modifiedon is earlier than plan GENERATED_AT', async () => {
  const dir = tempProject({
    GENERATED_AT: '2026-04-15T08:42:00.000Z',
  });
  const fakeRequest = async () => ({
    statusCode: 200,
    body: JSON.stringify({ modifiedon: '2026-04-01T00:00:00Z', version: '1.0.0.1' }),
  });
  try {
    const r = await checkAlmPlan({
      projectRoot: dir,
      envUrl: 'https://example.crm.dynamics.com',
      token: 'tok',
      solutionId: 'sol-guid',
      makeRequest: fakeRequest,
    });
    assert.equal(r.exists, true);
    assert.equal(r.stale, false);
    assert.equal(r.staleness.reason, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('treats env query failure as non-fatal — returns exists:true / stale:false', async () => {
  const dir = tempProject({ GENERATED_AT: '2026-04-01T00:00:00.000Z' });
  const fakeRequest = async () => { throw new Error('network down'); };
  try {
    const r = await checkAlmPlan({
      projectRoot: dir,
      envUrl: 'https://example.crm.dynamics.com',
      token: 'tok',
      solutionId: 'sol-guid',
      makeRequest: fakeRequest,
    });
    assert.equal(r.exists, true);
    assert.equal(r.stale, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('captures htmlPath when alm-plan.html is also present', async () => {
  const dir = tempProject({ GENERATED_AT: '2026-04-01T00:00:00.000Z' });
  fs.writeFileSync(path.join(dir, 'docs', 'alm-plan.html'), '<html/>', 'utf8');
  try {
    const r = await checkAlmPlan({ projectRoot: dir });
    assert.ok(r.htmlPath && r.htmlPath.endsWith('alm-plan.html'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('throws when projectRoot is not provided', async () => {
  await assert.rejects(
    checkAlmPlan({}),
    /projectRoot is required/i
  );
});
