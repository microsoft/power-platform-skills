'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateStageRunsBatch } = require('../lib/validate-stage-runs-batch');

const HOST = 'https://host.crm.dynamics.com';
const STAGE_ID = 'stage-1';
const SOURCE_ENV_ID = 'src-env-1';

function makeMock({ behaviorBySolution }) {
  // behaviorBySolution: Map<solutionUniqueName, { validation: 'success' | 'fail' | 'pending' | 'timeout' }>
  //
  // Tracks call sequence per stage run so we can return the right response shape
  // for create-stage-run (201 with body), ValidatePackageAsync (204), and poll
  // (200 with stagerunstatus).
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  const calls = [];
  const stageRunBySolution = new Map();
  // Each solution gets a unique stageRunId derived from name+ix; lets us reverse-map
  // poll requests back to behavior config.
  let nextStageRunIdx = 0;

  helpers.makeRequest = async (req) => {
    calls.push({ url: req.url, method: req.method, body: req.body });

    // create-stage-run: POST /deploymentstageruns
    if (req.method === 'POST' && /\/deploymentstageruns\?\$select=/.test(req.url)) {
      const body = JSON.parse(req.body);
      const artifactName = body.artifactname;
      const stageRunId = `srun-${++nextStageRunIdx}-${artifactName}`;
      stageRunBySolution.set(stageRunId, artifactName);
      return {
        statusCode: 201,
        body: JSON.stringify({ deploymentstagerunid: stageRunId }),
        headers: { 'odata-entityid': `${HOST}/api/data/v9.0/deploymentstageruns(${stageRunId})` },
      };
    }

    // ValidatePackageAsync: POST /ValidatePackageAsync
    if (req.method === 'POST' && /ValidatePackageAsync/.test(req.url)) {
      return { statusCode: 204, body: '', headers: {} };
    }

    // poll-validation-status: GET deploymentstageruns(<id>)?$select=operation,validationresults,stagerunstatus
    if ((req.method === 'GET' || !req.method) && /deploymentstageruns\([^)]+\)\?\$select=operation/.test(req.url)) {
      const m = req.url.match(/deploymentstageruns\(([^)]+)\)/);
      const stageRunId = m && m[1];
      const solutionName = stageRunBySolution.get(stageRunId);
      const behavior = behaviorBySolution.get(solutionName) || { validation: 'success' };
      switch (behavior.validation) {
        case 'success':
          return { statusCode: 200, body: JSON.stringify({ stagerunstatus: 200000007, validationresults: 'ok' }) };
        case 'fail':
          return { statusCode: 200, body: JSON.stringify({ stagerunstatus: 200000003, validationresults: 'broke' }) };
        case 'pending':
          // Always returns "still validating" — the helper times out, then the
          // batch probe asks for stagerunstatus and sees pending approval.
          return { statusCode: 200, body: JSON.stringify({ stagerunstatus: 200000006, validationresults: null }) };
        case 'timeout':
          return { statusCode: 200, body: JSON.stringify({ stagerunstatus: 200000006, validationresults: null }) };
      }
    }

    // probe re-query when poll throws — same record, narrower $select (no operation)
    if ((req.method === 'GET' || !req.method) && /deploymentstageruns\([^)]+\)\?\$select=stagerunstatus/.test(req.url)) {
      const m = req.url.match(/deploymentstageruns\(([^)]+)\)/);
      const stageRunId = m && m[1];
      const solutionName = stageRunBySolution.get(stageRunId);
      const behavior = behaviorBySolution.get(solutionName) || { validation: 'success' };
      if (behavior.validation === 'pending') {
        return { statusCode: 200, body: JSON.stringify({ stagerunstatus: 200000005, validationresults: null }) };
      }
      // timeout probe sees the same "still validating" state — caller treats as Timeout
      return { statusCode: 200, body: JSON.stringify({ stagerunstatus: 200000006, validationresults: null }) };
    }

    throw new Error(`unmatched request: ${req.method} ${req.url}`);
  };

  return {
    calls,
    restore: () => { helpers.makeRequest = orig; },
  };
}

test('validateStageRunsBatch requires hostEnvUrl, stageId, sourceDeploymentEnvironmentId', async () => {
  await assert.rejects(
    () => validateStageRunsBatch({ specs: [], token: 't' }),
    /--hostEnvUrl is required/
  );
  await assert.rejects(
    () => validateStageRunsBatch({ hostEnvUrl: HOST, specs: [], token: 't' }),
    /--stageId is required/
  );
  await assert.rejects(
    () => validateStageRunsBatch({ hostEnvUrl: HOST, stageId: STAGE_ID, specs: [], token: 't' }),
    /--sourceDeploymentEnvironmentId is required/
  );
});

test('validateStageRunsBatch returns allPassed:true when every solution succeeds', async (t) => {
  const mock = makeMock({
    behaviorBySolution: new Map([
      ['A_Core', { validation: 'success' }],
      ['A_WebAssets', { validation: 'success' }],
      ['A_Future', { validation: 'success' }],
    ]),
  });
  t.after(mock.restore);

  const result = await validateStageRunsBatch({
    hostEnvUrl: HOST,
    token: 'fake',
    stageId: STAGE_ID,
    sourceDeploymentEnvironmentId: SOURCE_ENV_ID,
    specs: [
      { solutionUniqueName: 'A_Core', solutionId: 'sid-1' },
      { solutionUniqueName: 'A_WebAssets', solutionId: 'sid-2' },
      { solutionUniqueName: 'A_Future', solutionId: 'sid-3' },
    ],
    intervalMs: 1,
    maxAttempts: 2,
  });

  assert.equal(result.total, 3);
  assert.equal(result.succeeded, 3);
  assert.equal(result.failed, 0);
  assert.equal(result.pendingApproval, 0);
  assert.equal(result.allPassed, true);
  assert.equal(typeof result.elapsedSeconds, 'number',
    'elapsedSeconds must always be emitted so callers (deploy-pipeline Phase 3.6.6) can persist it without out-of-band timing');
  assert.ok(result.elapsedSeconds >= 0, 'elapsedSeconds must be non-negative');

  // Order is input order (Promise.all preserves it).
  assert.deepEqual(result.results.map((r) => r.solutionUniqueName), ['A_Core', 'A_WebAssets', 'A_Future']);
  for (const r of result.results) assert.equal(r.status, 'Succeeded');
});

test('validateStageRunsBatch surfaces per-solution Failed without halting siblings', async (t) => {
  const mock = makeMock({
    behaviorBySolution: new Map([
      ['B_Core', { validation: 'success' }],
      ['B_WebAssets', { validation: 'fail' }],
      ['B_Content', { validation: 'success' }],
    ]),
  });
  t.after(mock.restore);

  const result = await validateStageRunsBatch({
    hostEnvUrl: HOST,
    token: 'fake',
    stageId: STAGE_ID,
    sourceDeploymentEnvironmentId: SOURCE_ENV_ID,
    specs: [
      { solutionUniqueName: 'B_Core', solutionId: 'sid-1' },
      { solutionUniqueName: 'B_WebAssets', solutionId: 'sid-2' },
      { solutionUniqueName: 'B_Content', solutionId: 'sid-3' },
    ],
    intervalMs: 1,
    maxAttempts: 2,
  });

  assert.equal(result.total, 3);
  assert.equal(result.succeeded, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.allPassed, false);

  const failed = result.results.find((r) => r.solutionUniqueName === 'B_WebAssets');
  assert.equal(failed.status, 'Failed');
  assert.match(failed.error || '', /Validation failed/);

  // The two siblings still completed successfully — fan-out is not gated on first failure.
  assert.equal(result.results.find((r) => r.solutionUniqueName === 'B_Core').status, 'Succeeded');
  assert.equal(result.results.find((r) => r.solutionUniqueName === 'B_Content').status, 'Succeeded');
});

test('validateStageRunsBatch detects PendingApproval via probe after poll timeout', async (t) => {
  const mock = makeMock({
    behaviorBySolution: new Map([
      ['C_Core', { validation: 'pending' }],
    ]),
  });
  t.after(mock.restore);

  const result = await validateStageRunsBatch({
    hostEnvUrl: HOST,
    token: 'fake',
    stageId: STAGE_ID,
    sourceDeploymentEnvironmentId: SOURCE_ENV_ID,
    specs: [{ solutionUniqueName: 'C_Core', solutionId: 'sid-1' }],
    intervalMs: 1,
    maxAttempts: 2,
  });

  assert.equal(result.total, 1);
  assert.equal(result.pendingApproval, 1);
  assert.equal(result.succeeded, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.allPassed, false);

  const r = result.results[0];
  assert.equal(r.status, 'PendingApproval');
  assert.ok(r.stageRunId, 'PendingApproval result still includes stageRunId');
});

test('validateStageRunsBatch marks Timeout when poll exhausts and probe is not PendingApproval', async (t) => {
  const mock = makeMock({
    behaviorBySolution: new Map([
      ['D_Slow', { validation: 'timeout' }],
    ]),
  });
  t.after(mock.restore);

  const result = await validateStageRunsBatch({
    hostEnvUrl: HOST,
    token: 'fake',
    stageId: STAGE_ID,
    sourceDeploymentEnvironmentId: SOURCE_ENV_ID,
    specs: [{ solutionUniqueName: 'D_Slow', solutionId: 'sid-1' }],
    intervalMs: 1,
    maxAttempts: 2,
  });

  assert.equal(result.timedOut, 1);
  assert.equal(result.allPassed, false);
  assert.equal(result.results[0].status, 'Timeout');
});

test('validateStageRunsBatch rejects malformed specs and preserves the rest', async (t) => {
  const mock = makeMock({
    behaviorBySolution: new Map([['E_Core', { validation: 'success' }]]),
  });
  t.after(mock.restore);

  const result = await validateStageRunsBatch({
    hostEnvUrl: HOST,
    token: 'fake',
    stageId: STAGE_ID,
    sourceDeploymentEnvironmentId: SOURCE_ENV_ID,
    specs: [
      { solutionUniqueName: 'E_Core', solutionId: 'sid-1' },
      { solutionUniqueName: 'no-id' },  // missing solutionId
    ],
    intervalMs: 1,
    maxAttempts: 2,
  });

  assert.equal(result.total, 2);
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 1);

  const bad = result.results.find((r) => r.solutionUniqueName === 'no-id');
  assert.equal(bad.status, 'Error');
  assert.match(bad.error, /missing required fields/);
});

test('validateStageRunsBatch fans out N requests in parallel (not serial)', async (t) => {
  // Build a mock whose stage-run-create takes a measurable delay; if the batch
  // runs serially the total wall-clock is roughly N × delay, parallel is ~delay.
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  const delay = 40; // ms per request
  const createTimestamps = [];
  let nextStageRunIdx = 0;
  const stageRunBySolution = new Map();

  helpers.makeRequest = async (req) => {
    await new Promise((r) => setTimeout(r, delay));
    if (req.method === 'POST' && /\/deploymentstageruns\?\$select=/.test(req.url)) {
      createTimestamps.push(Date.now());
      const body = JSON.parse(req.body);
      const id = `srun-${++nextStageRunIdx}-${body.artifactname}`;
      stageRunBySolution.set(id, body.artifactname);
      return { statusCode: 201, body: JSON.stringify({ deploymentstagerunid: id }), headers: {} };
    }
    if (req.method === 'POST' && /ValidatePackageAsync/.test(req.url)) {
      return { statusCode: 204, body: '', headers: {} };
    }
    return { statusCode: 200, body: JSON.stringify({ stagerunstatus: 200000007, validationresults: 'ok' }) };
  };
  t.after(() => { helpers.makeRequest = orig; });

  const N = 4;
  const specs = Array.from({ length: N }, (_, i) => ({
    solutionUniqueName: `F_S${i}`,
    solutionId: `sid-${i}`,
  }));

  const t0 = Date.now();
  const result = await validateStageRunsBatch({
    hostEnvUrl: HOST,
    token: 'fake',
    stageId: STAGE_ID,
    sourceDeploymentEnvironmentId: SOURCE_ENV_ID,
    specs,
    intervalMs: 1,
    maxAttempts: 2,
  });
  const elapsed = Date.now() - t0;

  assert.equal(result.allPassed, true);
  // Each solution makes 3 sequential requests (create → validate → poll), each
  // with a ~40ms delay, so the per-solution chain is ~120ms. If parallel,
  // total elapsed should be ~120ms; if serial across solutions, it would be
  // N × 120ms = ~480ms. Allow generous headroom (3× per-solution) and assert
  // we're under it.
  const perSolutionChain = delay * 3;
  assert.ok(
    elapsed < perSolutionChain * 3,
    `expected parallel fan-out (~${perSolutionChain}ms), got serial-like elapsed=${elapsed}ms`
  );

  // The N create-stage-run calls should overlap — first and last create
  // timestamps should be within one delay-tick of each other.
  const createSpan = createTimestamps[createTimestamps.length - 1] - createTimestamps[0];
  assert.ok(
    createSpan < delay * 2,
    `expected parallel create-stage-run calls (span < ${delay * 2}ms), got span=${createSpan}ms`
  );
});

test('validateStageRunsBatch rePoll mode skips create-stage-run + ValidatePackageAsync', async (t) => {
  // Pure re-poll path — no POST /deploymentstageruns, no POST /ValidatePackageAsync.
  // Only GET deploymentstageruns(<id>)?$select=operation,validationresults,stagerunstatus.
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  const callMethods = [];
  helpers.makeRequest = async (req) => {
    callMethods.push({ method: req.method || 'GET', url: req.url });
    if ((req.method === 'GET' || !req.method) && /deploymentstageruns\([^)]+\)\?\$select=operation/.test(req.url)) {
      // After approval, transitions through Validating (200000006) then ValidationSucceeded (200000007).
      // Returning Succeeded immediately is fine — the helper exits the poll loop on success.
      return { statusCode: 200, body: JSON.stringify({ stagerunstatus: 200000007, validationresults: 'ok' }) };
    }
    throw new Error(`unexpected request in rePoll test: ${req.method} ${req.url}`);
  };
  t.after(() => { helpers.makeRequest = orig; });

  const result = await validateStageRunsBatch({
    hostEnvUrl: HOST,
    token: 'fake',
    rePoll: true,
    specs: [
      { solutionUniqueName: 'X_Core', solutionId: 'sid-1', stageRunId: 'existing-srun-1' },
      { solutionUniqueName: 'X_WebAssets', solutionId: 'sid-2', stageRunId: 'existing-srun-2' },
    ],
    intervalMs: 1,
    maxAttempts: 2,
  });

  assert.equal(result.allPassed, true);
  assert.equal(result.succeeded, 2);
  for (const r of result.results) {
    assert.equal(r.status, 'Succeeded');
    assert.ok(/^existing-srun-/.test(r.stageRunId), 'pre-existing stage run ID must be preserved');
  }

  // Critically, NO POST to /deploymentstageruns or /ValidatePackageAsync.
  for (const c of callMethods) {
    if (c.method === 'POST') {
      assert.fail(`rePoll mode must not POST anything; got ${c.method} ${c.url}`);
    }
  }
});

test('validateStageRunsBatch rePoll does not require stageId or sourceDeploymentEnvironmentId', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  helpers.makeRequest = async () => ({ statusCode: 200, body: JSON.stringify({ stagerunstatus: 200000007, validationresults: 'ok' }) });
  t.after(() => { helpers.makeRequest = orig; });

  // Omit stageId and sourceDeploymentEnvironmentId entirely — must succeed.
  const result = await validateStageRunsBatch({
    hostEnvUrl: HOST,
    token: 'fake',
    rePoll: true,
    specs: [{ solutionUniqueName: 'Y', solutionId: 'sid', stageRunId: 'srun-1' }],
    intervalMs: 1,
    maxAttempts: 2,
  });
  assert.equal(result.succeeded, 1);
});

test('validateStageRunsBatch rePoll surfaces missing stageRunId as Error without polling', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  let pollCalls = 0;
  helpers.makeRequest = async () => { pollCalls++; return { statusCode: 200, body: '{}' }; };
  t.after(() => { helpers.makeRequest = orig; });

  const result = await validateStageRunsBatch({
    hostEnvUrl: HOST,
    token: 'fake',
    rePoll: true,
    specs: [
      { solutionUniqueName: 'Z_Good', solutionId: 'sid-1', stageRunId: 'srun-1' },
      { solutionUniqueName: 'Z_Bad', solutionId: 'sid-2' },  // missing stageRunId
    ],
    intervalMs: 1,
    maxAttempts: 1,
  });

  assert.equal(result.failed, 1);
  const bad = result.results.find((r) => r.solutionUniqueName === 'Z_Bad');
  assert.equal(bad.status, 'Error');
  assert.match(bad.error, /missing required fields.*stageRunId/);
});

test('validateStageRunsBatch rePoll still classifies PendingApproval via probe (unapproved race)', async (t) => {
  // Simulates the case where the user clicked "Yes I approved" but the approval
  // hasn't propagated yet. Stage run is still 200000005 (PendingApproval), poll
  // sees only 200000006 (Validating) until timeout, then probe sees 200000005.
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  helpers.makeRequest = async (req) => {
    if (/\$select=operation/.test(req.url)) {
      // Still validating — keeps poll spinning until maxAttempts exhausts
      return { statusCode: 200, body: JSON.stringify({ stagerunstatus: 200000006, validationresults: null }) };
    }
    if (/\$select=stagerunstatus/.test(req.url)) {
      // Probe sees the actual state: Pending Approval
      return { statusCode: 200, body: JSON.stringify({ stagerunstatus: 200000005, validationresults: null }) };
    }
    return { statusCode: 200, body: '{}' };
  };
  t.after(() => { helpers.makeRequest = orig; });

  const result = await validateStageRunsBatch({
    hostEnvUrl: HOST,
    token: 'fake',
    rePoll: true,
    specs: [{ solutionUniqueName: 'P', solutionId: 'sid', stageRunId: 'srun-pending' }],
    intervalMs: 1,
    maxAttempts: 2,
  });

  assert.equal(result.pendingApproval, 1);
  assert.equal(result.allPassed, false);
  assert.equal(result.results[0].status, 'PendingApproval');
  assert.equal(result.results[0].stageRunId, 'srun-pending');
});

test('validateStageRunsBatch reports VALIDATE_PACKAGE_UNAVAILABLE when ValidatePackageAsync returns 404', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  let nextStageRunIdx = 0;
  helpers.makeRequest = async (req) => {
    if (req.method === 'POST' && /\/deploymentstageruns\?\$select=/.test(req.url)) {
      return {
        statusCode: 201,
        body: JSON.stringify({ deploymentstagerunid: `srun-${++nextStageRunIdx}` }),
        headers: {},
      };
    }
    if (req.method === 'POST' && /ValidatePackageAsync/.test(req.url)) {
      return { statusCode: 404, body: '{}', headers: {} };
    }
    return { statusCode: 200, body: '{}' };
  };
  t.after(() => { helpers.makeRequest = orig; });

  const result = await validateStageRunsBatch({
    hostEnvUrl: HOST,
    token: 'fake',
    stageId: STAGE_ID,
    sourceDeploymentEnvironmentId: SOURCE_ENV_ID,
    specs: [{ solutionUniqueName: 'G_Core', solutionId: 'sid-1' }],
    intervalMs: 1,
    maxAttempts: 2,
  });

  const r = result.results[0];
  assert.equal(r.status, 'Error');
  assert.match(r.error, /ValidatePackageAsync not available/);
  // stageRunId WAS created before the 404 — preserved so caller can clean up if needed.
  assert.ok(r.stageRunId);
});
