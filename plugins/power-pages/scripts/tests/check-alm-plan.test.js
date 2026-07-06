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
    // writeHeartbeat:false → read-only check; an Approved plan is NOT promoted.
    const r = await checkAlmPlan({ projectRoot: dir, writeHeartbeat: false });
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

test('deferral: .alm-deferred marker (empty) flips deferred:true, stale:false, even when no plan exists', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-alm-defer-empty-'));
  try {
    fs.writeFileSync(path.join(dir, '.alm-deferred'), '', 'utf8');
    const r = await checkAlmPlan({ projectRoot: dir });
    assert.equal(r.deferred, true);
    assert.equal(r.exists, false);                 // no plan file present, but...
    assert.equal(r.stale, false);                  // deferral is a deliberate state, not staleness
    assert.equal(r.staleness.reason, 'deferred');
    assert.match(r.staleness.detail, /deferred/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deferral: .alm-deferred with plain-text reason surfaces the reason in staleness.detail', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-alm-defer-text-'));
  try {
    fs.writeFileSync(path.join(dir, '.alm-deferred'), 'ni-dev — ALM handled separately by infra team', 'utf8');
    const r = await checkAlmPlan({ projectRoot: dir });
    assert.equal(r.deferred, true);
    assert.match(r.staleness.detail, /ni-dev/);
    assert.match(r.staleness.detail, /infra team/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deferral: .alm-deferred with JSON object preserves structured fields in deferral', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-alm-defer-json-'));
  try {
    const marker = { deferredAt: '2026-05-04T10:00:00Z', deferredBy: 'admin@example', reason: 'staging frozen', scope: 'env:ni-dev' };
    fs.writeFileSync(path.join(dir, '.alm-deferred'), JSON.stringify(marker), 'utf8');
    const r = await checkAlmPlan({ projectRoot: dir });
    assert.equal(r.deferred, true);
    assert.deepEqual(r.deferral, marker);
    assert.match(r.staleness.detail, /staging frozen/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deferral: .alm-deferred wins over an existing plan — caller should pass through quietly', async () => {
  const dir = tempProject({ GENERATED_AT: '2026-04-01T00:00:00.000Z' });
  try {
    fs.writeFileSync(path.join(dir, '.alm-deferred'), 'deferred', 'utf8');
    const r = await checkAlmPlan({ projectRoot: dir });
    assert.equal(r.deferred, true);
    // exists/plan fields are zeroed when deferred — Phase 0 gate sees a single signal
    assert.equal(r.exists, false);
    assert.equal(r.stale, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deferred:false is set in normal results so callers can branch consistently', async () => {
  const dir = tempProject({ GENERATED_AT: '2026-04-01T00:00:00.000Z' });
  try {
    const r = await checkAlmPlan({ projectRoot: dir });
    assert.equal(r.deferred, false);
    assert.equal(r.deferral, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Heartbeat / inExecution semantics ────────────────────────────────────────

const { checkAlmPlan: checkAlmPlanFn, computeInExecution, HEARTBEAT_WINDOW_MIN } = require('../lib/check-alm-plan');

test('inExecution.status === "no-plan" when plan file does not exist', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-alm-plan-inex-'));
  try {
    const r = await checkAlmPlanFn({ projectRoot: dir });
    assert.equal(r.inExecution.status, 'no-plan');
    assert.equal(r.inExecution.windowMin, HEARTBEAT_WINDOW_MIN);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('inExecution.status === "not-running" when PLAN_STATUS is Draft/Approved/Completed', async () => {
  for (const status of ['Draft', 'Approved', 'Completed']) {
    const dir = tempProject({ PLAN_STATUS: status, GENERATED_AT: new Date().toISOString() });
    try {
      const r = await checkAlmPlanFn({ projectRoot: dir, writeHeartbeat: false });
      assert.equal(r.inExecution.status, 'not-running', `expected not-running for PLAN_STATUS=${status}`);
      assert.match(r.inExecution.reason, /not 'In Execution'/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('inExecution.status === "active" on first heartbeat (PLAN_STATUS=In Execution, no prior heartbeat)', async () => {
  const dir = tempProject({ PLAN_STATUS: 'In Execution', GENERATED_AT: new Date().toISOString() });
  try {
    const r = await checkAlmPlanFn({ projectRoot: dir, writeHeartbeat: false });
    assert.equal(r.inExecution.status, 'active');
    assert.match(r.inExecution.reason, /first heartbeat/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('inExecution.status === "active" when heartbeat is recent (within window)', async () => {
  const now = Date.now();
  const dir = tempProject({
    PLAN_STATUS: 'In Execution',
    GENERATED_AT: new Date(now - 90 * 60_000).toISOString(),
    LAST_INVOCATION_AT: new Date(now - 5 * 60_000).toISOString(), // 5 min ago
  });
  try {
    const r = await checkAlmPlanFn({ projectRoot: dir, writeHeartbeat: false, now });
    assert.equal(r.inExecution.status, 'active');
    assert.match(r.inExecution.reason, /within \d+min window/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('inExecution.status === "stale-heartbeat" when heartbeat is older than window', async () => {
  const now = Date.now();
  const dir = tempProject({
    PLAN_STATUS: 'In Execution',
    GENERATED_AT: new Date(now - 120 * 60_000).toISOString(),
    LAST_INVOCATION_AT: new Date(now - (HEARTBEAT_WINDOW_MIN + 5) * 60_000).toISOString(),
  });
  try {
    const r = await checkAlmPlanFn({ projectRoot: dir, writeHeartbeat: false, now });
    assert.equal(r.inExecution.status, 'stale-heartbeat');
    assert.match(r.inExecution.reason, /stalled/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('inExecution.status === "stale-heartbeat" when LAST_INVOCATION_AT is unparseable', async () => {
  const dir = tempProject({
    PLAN_STATUS: 'In Execution',
    GENERATED_AT: new Date().toISOString(),
    LAST_INVOCATION_AT: 'not-a-timestamp',
  });
  try {
    const r = await checkAlmPlanFn({ projectRoot: dir, writeHeartbeat: false });
    assert.equal(r.inExecution.status, 'stale-heartbeat');
    assert.match(r.inExecution.reason, /not a parseable/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeHeartbeat:true refreshes LAST_INVOCATION_AT on the plan file', async () => {
  const oldStamp = new Date(Date.now() - 30 * 60_000).toISOString();
  const dir = tempProject({
    PLAN_STATUS: 'In Execution',
    GENERATED_AT: new Date(Date.now() - 90 * 60_000).toISOString(),
    LAST_INVOCATION_AT: oldStamp,
  });
  try {
    await checkAlmPlanFn({ projectRoot: dir, writeHeartbeat: true });
    const planAfter = JSON.parse(fs.readFileSync(path.join(dir, 'docs', '.alm-plan-data.json'), 'utf8'));
    assert.notEqual(planAfter.LAST_INVOCATION_AT, oldStamp, 'heartbeat must be updated');
    // The refreshed value must be parseable and very recent
    const refreshedMs = Date.parse(planAfter.LAST_INVOCATION_AT);
    assert.ok(Number.isFinite(refreshedMs));
    assert.ok(Date.now() - refreshedMs < 5000, 'heartbeat must be within 5s of now');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeHeartbeat:false leaves LAST_INVOCATION_AT untouched (read-only audits)', async () => {
  const oldStamp = new Date(Date.now() - 30 * 60_000).toISOString();
  const dir = tempProject({
    PLAN_STATUS: 'In Execution',
    GENERATED_AT: new Date(Date.now() - 90 * 60_000).toISOString(),
    LAST_INVOCATION_AT: oldStamp,
  });
  try {
    await checkAlmPlanFn({ projectRoot: dir, writeHeartbeat: false });
    const planAfter = JSON.parse(fs.readFileSync(path.join(dir, 'docs', '.alm-plan-data.json'), 'utf8'));
    assert.equal(planAfter.LAST_INVOCATION_AT, oldStamp);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('heartbeat is NOT written when PLAN_STATUS !== "In Execution"', async () => {
  // The chain only wants heartbeats during actual execution. If the plan is
  // Draft / Approved / Completed, a Phase 0 gate check should not silently
  // mark it as "in execution" by writing a heartbeat.
  const dir = tempProject({ PLAN_STATUS: 'Draft', GENERATED_AT: new Date().toISOString() });
  try {
    await checkAlmPlanFn({ projectRoot: dir, writeHeartbeat: true });
    const planAfter = JSON.parse(fs.readFileSync(path.join(dir, 'docs', '.alm-plan-data.json'), 'utf8'));
    assert.equal(planAfter.LAST_INVOCATION_AT, undefined,
      'heartbeat must not appear on a non-executing plan — Phase 0 checks during Draft/Approved must be side-effect-free');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lastInvocationAt in the return value reflects the PRIOR heartbeat, not the just-written one', async () => {
  // Important contract: the helper's return value must describe state BEFORE
  // it wrote the new heartbeat, so the caller's inExecution decision is based
  // on what actually existed when the chain began.
  const priorStamp = new Date(Date.now() - 10 * 60_000).toISOString();
  const dir = tempProject({
    PLAN_STATUS: 'In Execution',
    GENERATED_AT: new Date(Date.now() - 90 * 60_000).toISOString(),
    LAST_INVOCATION_AT: priorStamp,
  });
  try {
    const r = await checkAlmPlanFn({ projectRoot: dir, writeHeartbeat: true });
    assert.equal(r.lastInvocationAt, priorStamp,
      'return value carries the prior heartbeat — the just-written one is on disk for the NEXT skill in the chain');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('computeInExecution is pure — same inputs produce same output', () => {
  const now = Date.parse('2026-05-25T12:00:00.000Z');
  const recent = new Date(now - 10 * 60_000).toISOString();
  const stale = new Date(now - (HEARTBEAT_WINDOW_MIN + 1) * 60_000).toISOString();

  assert.equal(computeInExecution('In Execution', recent, now).status, 'active');
  assert.equal(computeInExecution('In Execution', stale, now).status, 'stale-heartbeat');
  assert.equal(computeInExecution('In Execution', null, now).status, 'active'); // first-heartbeat case
  assert.equal(computeInExecution('Draft', recent, now).status, 'not-running');
  assert.equal(computeInExecution(null, recent, now).status, 'not-running');
});

// ── LAST_SYNC_AT semantics (G3) ──────────────────────────────────────────────

test('LAST_SYNC_AT > GENERATED_AT shifts the staleness reference forward', async () => {
  // Scenario: plan was generated, then setup-solution sync ran (bumped
  // modifiedon AND wrote LAST_SYNC_AT after its final write), then a downstream
  // skill checks freshness. In the real timeline refresh-alm-plan-data writes
  // LAST_SYNC_AT AFTER setup-solution's bump-then-add ops complete, so
  // modifiedon <= LAST_SYNC_AT. Without LAST_SYNC_AT accounting, the
  // modifiedon > GENERATED_AT compare would falsely flag stale; with it,
  // max(generated, sync) handles correctly.
  const generatedAt = '2026-05-25T09:00:00.000Z';
  const modifiedOn = '2026-05-25T10:00:00.000Z';  // sync did it
  const lastSyncAt = '2026-05-25T10:00:05.000Z';  // marker written 5s later

  const dir = tempProject({
    GENERATED_AT: generatedAt,
    LAST_SYNC_AT: lastSyncAt,
    PLAN_STATUS: 'In Execution',
  });
  try {
    const r = await checkAlmPlanFn({
      projectRoot: dir,
      envUrl: 'https://org.crm.dynamics.com',
      token: 'fake',
      solutionId: 'sol-1',
      writeHeartbeat: false,
      makeRequest: async () => ({
        statusCode: 200,
        body: JSON.stringify({ modifiedon: modifiedOn, version: '1.0.0.4' }),
      }),
    });
    assert.equal(r.stale, false,
      'modifiedon within LAST_SYNC_AT window must NOT trigger stale: solution-modified');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('modifiedon AFTER LAST_SYNC_AT still triggers stale: solution-modified', async () => {
  // The LAST_SYNC_AT marker accepts modifications up to its timestamp, not
  // beyond. Any drift after the last sync IS stale and should fire the gate.
  const generatedAt = '2026-05-25T09:00:00.000Z';
  const lastSyncAt = '2026-05-25T10:00:00.000Z';
  const modifiedOn = '2026-05-25T11:30:00.000Z';  // 90 min after sync — drift

  const dir = tempProject({
    GENERATED_AT: generatedAt,
    LAST_SYNC_AT: lastSyncAt,
    PLAN_STATUS: 'In Execution',
  });
  try {
    const r = await checkAlmPlanFn({
      projectRoot: dir,
      envUrl: 'https://org.crm.dynamics.com',
      token: 'fake',
      solutionId: 'sol-1',
      writeHeartbeat: false,
      makeRequest: async () => ({
        statusCode: 200,
        body: JSON.stringify({ modifiedon: modifiedOn, version: '1.0.0.5' }),
      }),
    });
    assert.equal(r.stale, true);
    assert.equal(r.staleness.reason, 'solution-modified');
    assert.match(r.staleness.detail, /last sync at/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('LAST_SYNC_AT BEFORE GENERATED_AT (or absent) — staleness uses GENERATED_AT as before', async () => {
  // Backward compat: plans generated before the LAST_SYNC_AT feature should
  // still produce the original staleness behavior (compare against GENERATED_AT).
  const generatedAt = '2026-05-25T10:00:00.000Z';
  const modifiedOn = '2026-05-25T10:30:00.000Z';

  const dir = tempProject({
    GENERATED_AT: generatedAt,
    PLAN_STATUS: 'In Execution',
    // LAST_SYNC_AT omitted entirely
  });
  try {
    const r = await checkAlmPlanFn({
      projectRoot: dir,
      envUrl: 'https://org.crm.dynamics.com',
      token: 'fake',
      solutionId: 'sol-1',
      writeHeartbeat: false,
      makeRequest: async () => ({
        statusCode: 200,
        body: JSON.stringify({ modifiedon: modifiedOn }),
      }),
    });
    assert.equal(r.stale, true);
    assert.equal(r.staleness.reason, 'solution-modified');
    assert.match(r.staleness.detail, /plan generated at/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Unparseable LAST_SYNC_AT falls back to GENERATED_AT (defensive)', async () => {
  const generatedAt = '2026-05-25T10:00:00.000Z';
  const modifiedOn = '2026-05-25T10:30:00.000Z';

  const dir = tempProject({
    GENERATED_AT: generatedAt,
    LAST_SYNC_AT: 'not-a-timestamp',
    PLAN_STATUS: 'In Execution',
  });
  try {
    const r = await checkAlmPlanFn({
      projectRoot: dir,
      envUrl: 'https://org.crm.dynamics.com',
      token: 'fake',
      solutionId: 'sol-1',
      writeHeartbeat: false,
      makeRequest: async () => ({
        statusCode: 200,
        body: JSON.stringify({ modifiedon: modifiedOn }),
      }),
    });
    assert.equal(r.stale, true, 'unparseable LAST_SYNC_AT must not silently mask staleness');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Approved -> In Execution promotion (lifecycle activation) ---------------

test('promotes Approved -> In Execution on the first execution-skill Phase 0 (writeHeartbeat default)', async () => {
  const dir = tempProject({ SITE_NAME: 'T', PLAN_STATUS: 'Approved' });
  try {
    const r = await checkAlmPlan({ projectRoot: dir });
    assert.equal(r.planStatus, 'In Execution', 'returned status reflects the promotion');
    // inExecution is classified from the PRIOR (Approved) status, so the FIRST
    // execution-skill entry reports "not-running" — NOT "active". This keeps the
    // caller on the normal Phase 0 path where it still honors stale:true; an
    // "active" shortcut here would mask a stale plan on the first run after approval.
    assert.equal(r.inExecution.status, 'not-running', 'first Approved->In Execution entry is not-running');
    // Promotion + heartbeat are still persisted to disk for the NEXT in-chain skill,
    // which reads "In Execution" + a fresh heartbeat and classifies as "active".
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'docs', '.alm-plan-data.json'), 'utf8'));
    assert.equal(onDisk.PLAN_STATUS, 'In Execution');
    assert.ok(onDisk.LAST_INVOCATION_AT, 'first heartbeat written');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('second in-chain skill sees the promoted In Execution plan as active', async () => {
  // Simulates the next execution skill after the promotion: PLAN_STATUS is already
  // "In Execution" with a fresh heartbeat on disk, so the active-chain machinery
  // engages and Phase 0 gates are skipped (no re-nagging within a running run).
  const dir = tempProject({
    SITE_NAME: 'T',
    PLAN_STATUS: 'In Execution',
    LAST_INVOCATION_AT: new Date().toISOString(),
  });
  try {
    const r = await checkAlmPlan({ projectRoot: dir });
    assert.equal(r.inExecution.status, 'active');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Approved + stale source solution: stale gate is NOT masked by the promotion (inExecution stays not-running)', async () => {
  // Regression for the freshness-gate masking bug: an Approved plan whose source
  // solution was modified after generation must still surface stale:true on the
  // first execution skill. If the promotion classified inExecution as "active",
  // callers that skip Phase 0 on active status (deploy-pipeline SKILL.md) would
  // bypass the stale-plan confirmation. The promotion is persisted, but THIS call
  // must report inExecution "not-running" so stale:true is acted on.
  const dir = tempProject({
    SITE_NAME: 'T',
    PLAN_STATUS: 'Approved',
    GENERATED_AT: '2026-04-01T00:00:00.000Z',
  });
  // Solution modifiedon is AFTER GENERATED_AT → stale.
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
    assert.equal(r.stale, true, 'stale source solution still flagged');
    assert.equal(r.staleness.reason, 'solution-modified');
    assert.notEqual(r.inExecution.status, 'active', 'active shortcut must NOT mask the stale gate');
    assert.equal(r.inExecution.status, 'not-running');
    // Promotion still happens on disk (next skill sees In Execution).
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'docs', '.alm-plan-data.json'), 'utf8'));
    assert.equal(onDisk.PLAN_STATUS, 'In Execution');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('does NOT promote Approved when writeHeartbeat is false (read-only callers: plan-alm, audits, tests)', async () => {
  const dir = tempProject({ SITE_NAME: 'T', PLAN_STATUS: 'Approved' });
  try {
    const r = await checkAlmPlan({ projectRoot: dir, writeHeartbeat: false });
    assert.equal(r.planStatus, 'Approved', 'read-only check leaves the plan Approved');
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'docs', '.alm-plan-data.json'), 'utf8'));
    assert.equal(onDisk.PLAN_STATUS, 'Approved', 'disk untouched');
    assert.equal(onDisk.LAST_INVOCATION_AT, undefined, 'no heartbeat written');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('does NOT promote a Draft plan (only Approved is promotable)', async () => {
  const dir = tempProject({ SITE_NAME: 'T', PLAN_STATUS: 'Draft' });
  try {
    const r = await checkAlmPlan({ projectRoot: dir });
    assert.equal(r.planStatus, 'Draft');
    assert.equal(r.inExecution.status, 'not-running');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
