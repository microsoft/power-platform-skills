'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  refresh,
  reconcile,
  buildHostResolutionFromCheck,
  dropResolvedRisks,
  computeNextStep,
  mapStepToSkill,
} = require('../lib/refresh-alm-plan-data');

function makeProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-alm-plan-'));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('buildHostResolutionFromCheck maps a successful host-check to plan-alm shape', () => {
  const next = buildHostResolutionFromCheck({
    schemaVersion: 2,
    resolutionStatus: 'AvailableUsingCustomHost',
    finalHostEnvUrl: 'https://orgc4f78248.crm5.dynamics.com/',
    finalHostEnvId: '334f023b-d8eb-e86d-b973-5c6d98170696',
    finalHostEnvName: 'Supplier Portal Pipelines Host',
    hostType: 'custom',
    pipelinesSolutionVersion: '9.1.0.0',
    actionTaken: 'fast-path-custom-d365projecthost',
  });
  assert.equal(next.status, 'AvailableUsingCustomHost');
  assert.equal(next.hostEnvUrl, 'https://orgc4f78248.crm5.dynamics.com/');
  assert.equal(next.hostEnvName, 'Supplier Portal Pipelines Host', 'env display name should flow through to plan-alm shape');
  assert.equal(next.hostType, 'custom');
  assert.equal(next.pipelinesSolutionVersion, '9.1.0.0');
  // Post-run flags must all clear so the renderer's "Will be ensured" branch
  // doesn't fire after the host actually exists.
  assert.equal(next.willEnsureDuringExecution, false);
  assert.equal(next.willProvisionPlatform, false);
  assert.equal(next.willProvisionCustom, false);
  assert.equal(next.willUsePpac, false);
  assert.equal(next.chosenEnvUrl, null);
});

test('buildHostResolutionFromCheck preserves null hostEnvName when the check did not capture it', () => {
  const next = buildHostResolutionFromCheck({
    resolutionStatus: 'AvailableUsingCustomHost',
    finalHostEnvUrl: 'https://x.crm.dynamics.com/',
    // no finalHostEnvName — older detect runs before the field existed
  });
  assert.equal(next.hostEnvName, null, 'Missing displayName should become null, not "undefined" or empty string');
});

test('buildHostResolutionFromCheck handles null/empty input safely', () => {
  assert.equal(buildHostResolutionFromCheck(null), null);
  assert.equal(buildHostResolutionFromCheck(undefined), null);
  assert.equal(buildHostResolutionFromCheck('not an object'), null);
  // An empty object (e.g. ensure-pipelines-host wrote a partial cache) → returns
  // a result with status defaulted to DetectionFailed. The contract is intentional:
  // a present-but-empty docs/alm/last-host-check.json is treated as "we attempted detection
  // but got nothing useful" rather than skipped silently. This means the renderer's
  // "Will be ensured" branch won't fire, but neither will "host-card-ok" — the
  // user sees a fall-through state that prompts re-running detection.
  const result = buildHostResolutionFromCheck({});
  assert.ok(result, 'empty object returns a result, not null');
  assert.equal(result.status, 'DetectionFailed');
});

test('dropResolvedRisks removes pre-run NoHost warnings after setup-pipeline', () => {
  const before = [
    { type: 'info', message: 'No Pipelines host detected. setup-pipeline will create a new Custom Host (D365_ProjectHost template, requires Power Platform admin).' },
    { type: 'warning', message: 'This solution has environment variables (5 detected) — you will be prompted for per-stage values during deployment.' },
    { type: 'info', message: 'A Dataverse solution will be created first — publisher prefix is irreversible once chosen.' },
  ];
  const after = dropResolvedRisks(before, 'setup-pipeline');
  assert.equal(after.length, 2, 'NoHost warning should be removed; other entries preserved');
  assert.ok(after.some((r) => /environment variables/.test(r.message)));
  assert.ok(after.some((r) => /Dataverse solution will be created/.test(r.message)));
  assert.ok(!after.some((r) => /No Pipelines host detected/.test(r.message)));
});

test('dropResolvedRisks removes existing-CustomHost warnings after setup-pipeline', () => {
  const before = [
    { type: 'info', message: 'An existing Custom Host (https://example.crm.dynamics.com/) will be reused. Source env will be bound to it automatically.' },
    { type: 'info', message: '3 existing Custom Hosts found in tenant. setup-pipeline will prompt for selection.' },
  ];
  const after = dropResolvedRisks(before, 'setup-pipeline');
  assert.equal(after.length, 0, 'Both pre-run host-related warnings should be removed');
});

test('dropResolvedRisks is a no-op for unknown phases', () => {
  const before = [{ type: 'info', message: 'Whatever' }];
  const after = dropResolvedRisks(before, 'unknown-phase');
  assert.deepEqual(after, before);
});

test('refresh returns ok:false when planData JSON is missing (soft no-op)', (t) => {
  const root = makeProject(t);
  // No docs/.alm-plan-data.json written
  const result = refresh({ projectRoot: root, phase: 'setup-pipeline', render: false });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not found/);
});

test('refresh validates phase argument', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), { SITE_NAME: 'Test' });
  assert.throws(
    () => refresh({ projectRoot: root, phase: 'bogus', render: false }),
    /--phase must be one of/
  );
});

test('refresh setup-pipeline rewrites hostResolution from docs/alm/last-host-check.json + drops NoHost warning', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    hostResolution: {
      status: 'NoHost',
      hostEnvUrl: null,
      willEnsureDuringExecution: true,
      willProvisionCustom: true,
    },
    risks: [
      { type: 'info', message: 'No Pipelines host detected. setup-pipeline will create a new Custom Host.' },
      { type: 'warning', message: 'This solution has environment variables — you will be prompted for per-stage values during deployment.' },
    ],
  });
  writeJson(path.join(root, 'docs', 'alm', 'last-host-check.json'), {
    schemaVersion: 2,
    resolutionStatus: 'AvailableUsingCustomHost',
    finalHostEnvUrl: 'https://newhost.crm.dynamics.com/',
    finalHostEnvId: '9eaa1234-aaaa-bbbb-cccc-000000000000',
    hostType: 'custom',
    pipelinesSolutionVersion: '9.1.0.0',
    actionTaken: 'fast-path-custom-d365projecthost',
  });
  writeJson(path.join(root, 'docs', 'alm', 'last-pipeline.json'), {
    pipelineId: 'pipe-1',
    pipelineName: 'TestSite-Pipeline',
    hostEnvUrl: 'https://newhost.crm.dynamics.com/',
    sourceDeploymentEnvironmentId: 'src-env-1',
    stages: [{ stageId: 'stg-1', stageName: 'Staging', targetDeploymentEnvironmentId: 'tgt-1' }],
  });

  const result = refresh({ projectRoot: root, phase: 'setup-pipeline', render: false });
  assert.equal(result.ok, true);

  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.equal(planData.hostResolution.status, 'AvailableUsingCustomHost', 'hostResolution.status should advance from NoHost');
  assert.equal(planData.hostResolution.hostEnvUrl, 'https://newhost.crm.dynamics.com/');
  assert.equal(planData.hostResolution.willEnsureDuringExecution, false, 'post-run "ensure" flag should clear');
  assert.equal(planData.hostResolution.willProvisionPlatform, false, 'post-run "willProvisionPlatform" flag should clear');
  assert.equal(planData.hostResolution.willProvisionCustom, false, 'post-run "provision" flag should clear');

  assert.equal(planData.pipelineMeta.pipelineName, 'TestSite-Pipeline');
  assert.equal(planData.pipelineMeta.pipelineId, 'pipe-1');
  assert.equal(planData.pipelineMeta.isActive, true);
  assert.equal(planData.pipelineMeta.lastDeploy, null, 'lastDeploy should still be null after setup-pipeline');

  assert.equal(planData.risks.length, 1, 'NoHost warning should be dropped');
  assert.match(planData.risks[0].message, /environment variables/);
});

test('refresh deploy-pipeline writes pipelineMeta.lastDeploy from docs/alm/last-deploy.json', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    pipelineMeta: {
      pipelineId: 'pipe-1',
      pipelineName: 'TestSite-Pipeline',
      isActive: true,
      lastDeploy: null,
    },
  });
  writeJson(path.join(root, 'docs', 'alm', 'last-deploy.json'), {
    stageRunId: 'run-42',
    stageName: 'Staging',
    status: 'Succeeded',
    deployedAt: '2026-05-05T16:00:00.000Z',
    artifactVersion: '1.0.0.4',
    componentCount: 246,
    activationStatus: 'Pending',
    siteUrl: null,
    pipelineId: 'pipe-1',
    solutionName: 'TestSite',
  });

  const result = refresh({ projectRoot: root, phase: 'deploy-pipeline', render: false });
  assert.equal(result.ok, true);

  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.equal(planData.pipelineMeta.lastDeploy.status, 'Succeeded');
  assert.equal(planData.pipelineMeta.lastDeploy.artifactVersion, '1.0.0.4');
  assert.equal(planData.pipelineMeta.lastDeploy.componentCount, 246);
  assert.equal(planData.pipelineMeta.lastDeploy.stageName, 'Staging');
});

test('refresh test-site populates validationRuns[stage] from docs/alm/last-test-site.json', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    validationRuns: { Staging: null },
  });
  writeJson(path.join(root, 'docs', 'alm', 'last-test-site.json'), {
    url: 'https://teststaging.powerappsportals.com',
    runAt: '2026-05-05T16:30:00.000Z',
    durationSec: 120,
    runOutcome: 'passed',
    summary: { critical: 0, high: 0, medium: 0, low: 0, total: 12, passed: 12, failed: 0, skipped: 0 },
    categories: [{ id: 'cat-1', name: 'Pages', tests: [] }],
  });

  const result = refresh({ projectRoot: root, phase: 'test-site', render: false, stageName: 'Staging' });
  assert.equal(result.ok, true);

  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.ok(planData.validationRuns.Staging);
  assert.equal(planData.validationRuns.Staging.runOutcome, 'passed');
  assert.equal(planData.validationRuns.Staging.summary.total, 12);
});

test('refresh test-site keys validationRuns by the BARE label even if given a "Deploy to {label}" stage', (t) => {
  // Hardening (defense against the "Deploy to {label}" mismatch class): if a caller
  // ever passes the pipeline stage NAME ("Deploy to Staging") instead of the bare
  // label, the per-stage object key must still be "Staging" so the renderer (which
  // looks up validationRuns by the bare label from the step name) finds it.
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    validationRuns: { Staging: null },
    steps: [{ name: 'Test site in Staging', status: 'pending' }],
  });
  writeJson(path.join(root, 'docs', 'alm', 'last-test-site.json'), { runOutcome: 'passed', runAt: '2026-06-16T00:00:00.000Z' });

  refresh({ projectRoot: root, phase: 'test-site', render: false, stageName: 'Deploy to Staging' });

  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.ok(planData.validationRuns.Staging, 'keyed by bare "Staging"');
  assert.equal(planData.validationRuns['Deploy to Staging'], undefined, 'must NOT key by the "Deploy to" stage name');
  assert.equal(planData.steps[0].status, 'completed', 'and the matching Test step still flips');
});

test('refresh test-site is a no-op when stageName is omitted', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    validationRuns: { Staging: null },
  });
  writeJson(path.join(root, 'docs', 'alm', 'last-test-site.json'), { runOutcome: 'passed' });

  const result = refresh({ projectRoot: root, phase: 'test-site', render: false });
  assert.equal(result.ok, true);
  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.equal(planData.validationRuns.Staging, null, 'no stage name → skip update');
});

test('refresh finalize sets PLAN_STATUS to Completed', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    PLAN_STATUS: 'In Execution',
    SITE_NAME: 'TestSite',
  });
  refresh({ projectRoot: root, phase: 'finalize', render: false });
  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.equal(planData.PLAN_STATUS, 'Completed');
});

// evaluatePlanCompletion — the In Execution → Completed transition that makes the
// LAST execution skill terminate the plan automatically. These tests pin the
// status-gate edges (the defensive "Approved" fallback + the Draft / failed-step
// guards) so the lifecycle can't silently over- or under-complete.

test('completion: the last execution phase flips a plan from Approved straight to Completed (defensive fallback)', (t) => {
  // Normal flow promotes Approved → In Execution in check-alm-plan.js's Phase 0
  // gate. If that promotion was ever skipped (read-only caller, --no-heartbeat,
  // a manual run) the plan can still be "Approved" when its final step lands.
  // evaluatePlanCompletion accepts BOTH In Execution AND Approved so the plan
  // still terminates instead of getting wedged one transition short of done.
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    PLAN_STATUS: 'Approved',
    SITE_NAME: 'TestSite',
    validationRuns: { Staging: null },
    steps: [
      { name: 'Deploy via pipeline to Staging', status: 'completed' },
      { name: 'Test site in Staging', status: 'pending' },
    ],
  });
  writeJson(path.join(root, 'docs', 'alm', 'last-test-site.json'), { runOutcome: 'passed', runAt: '2026-06-16T00:00:00.000Z' });

  refresh({ projectRoot: root, phase: 'test-site', render: false, stageName: 'Staging' });

  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.equal(planData.steps[1].status, 'completed', 'the final step flips to completed');
  assert.equal(planData.PLAN_STATUS, 'Completed', 'Approved → Completed (defensive fallback path)');
  assert.ok(planData.COMPLETED_AT, 'COMPLETED_AT is stamped on completion');
});

test('completion: a Draft plan is never auto-completed even when every step is done', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    PLAN_STATUS: 'Draft',
    SITE_NAME: 'TestSite',
    validationRuns: { Staging: null },
    steps: [{ name: 'Test site in Staging', status: 'completed' }],
  });
  writeJson(path.join(root, 'docs', 'alm', 'last-test-site.json'), { runOutcome: 'passed', runAt: '2026-06-16T00:00:00.000Z' });

  refresh({ projectRoot: root, phase: 'test-site', render: false, stageName: 'Staging' });

  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.equal(planData.PLAN_STATUS, 'Draft', 'an unapproved plan must not complete itself');
  assert.equal(planData.COMPLETED_AT, undefined, 'no COMPLETED_AT stamp for a Draft plan');
});

test('completion: a failed step blocks completion so a failed deploy can never look "done"', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    PLAN_STATUS: 'In Execution',
    SITE_NAME: 'TestSite',
    validationRuns: { Staging: null },
    steps: [
      { name: 'Deploy via pipeline to Staging', status: 'failed' },
      { name: 'Test site in Staging', status: 'pending' },
    ],
  });
  writeJson(path.join(root, 'docs', 'alm', 'last-test-site.json'), { runOutcome: 'passed', runAt: '2026-06-16T00:00:00.000Z' });

  refresh({ projectRoot: root, phase: 'test-site', render: false, stageName: 'Staging' });

  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.equal(planData.PLAN_STATUS, 'In Execution', 'a failed step keeps the plan in execution');
  assert.equal(planData.COMPLETED_AT, undefined, 'no COMPLETED_AT while a step is failed');
});

test('refresh setup-pipeline preserves prior pipelineMeta.reusedByWiring annotation', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    pipelineMeta: {
      reusedByWiring: { originalName: 'Existing Pipeline', requestedName: 'NewName' },
    },
  });
  writeJson(path.join(root, 'docs', 'alm', 'last-pipeline.json'), {
    pipelineId: 'pipe-x',
    pipelineName: 'Existing Pipeline',
    stages: [],
  });

  refresh({ projectRoot: root, phase: 'setup-pipeline', render: false });
  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.deepEqual(planData.pipelineMeta.reusedByWiring, {
    originalName: 'Existing Pipeline',
    requestedName: 'NewName',
  }, 'reusedByWiring annotation should survive the post-run refresh');
});

// ── Manual-path phases (export-solution / import-solution / activate-site) ────
//
// These phases are passthroughs in refresh-alm-plan-data — they don't ingest a
// marker file (no canonical schema today) but they ARE valid --phase values
// and the helper should re-render the plan when invoked. The agent updates
// planData.steps[i].status before calling these phases, so the test verifies
// that the helper accepts the phase, runs the (no-op) handler, and writes the
// planData back to disk without corruption.

test('refresh export-solution flips the "Export solution" step to completed (step-sync)', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    STRATEGY: 'manual',
    steps: [
      { name: 'Setup solution', status: 'completed' },
      { name: 'Export solution', status: 'in_progress' },
    ],
  });

  const result = refresh({ projectRoot: root, phase: 'export-solution', render: false });
  assert.equal(result.ok, true);
  assert.equal(result.phase, 'export-solution');
  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.equal(planData.STRATEGY, 'manual');
  assert.equal(planData.steps[0].status, 'completed', 'unrelated steps must be untouched');
  assert.equal(planData.steps[1].status, 'completed',
    'invoking --phase export-solution is proof the phase ran — step must flip from in_progress to completed without the agent doing a manual Edit');
});

test('refresh export-solution ingests docs/alm/last-export.json into planData.manualMeta.lastExport', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    STRATEGY: 'manual',
    steps: [{ name: 'Export solution', status: 'in_progress' }],
  });
  writeJson(path.join(root, 'docs', 'alm', 'last-export.json'), {
    exportedAt: '2026-05-26T12:34:56.000Z',
    solutionUniqueName: 'ContosoSite',
    solutionId: 'sol-guid-1',
    previousVersion: '1.0.0.2',
    version: '1.0.0.3',
    managed: true,
    sourceEnvironmentUrl: 'https://dev.crm.dynamics.com',
    zipPath: '/tmp/ContosoSite_managed.zip',
    fileSizeBytes: 1048576,
    asyncOperationId: 'async-guid-1',
  });

  const result = refresh({ projectRoot: root, phase: 'export-solution', render: false });
  assert.equal(result.ok, true);
  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));

  assert.ok(planData.manualMeta, 'manualMeta block must be created');
  const lx = planData.manualMeta.lastExport;
  assert.equal(lx.solutionUniqueName, 'ContosoSite');
  assert.equal(lx.solutionId, 'sol-guid-1');
  assert.equal(lx.previousVersion, '1.0.0.2');
  assert.equal(lx.version, '1.0.0.3');
  assert.equal(lx.managed, true);
  assert.equal(lx.sourceEnvironmentUrl, 'https://dev.crm.dynamics.com');
  assert.equal(lx.zipPath, '/tmp/ContosoSite_managed.zip');
  assert.equal(lx.fileSizeBytes, 1048576);
  assert.equal(lx.asyncOperationId, 'async-guid-1');
  assert.equal(lx.exportedAt, '2026-05-26T12:34:56.000Z');

  // Step-sync still works independent of marker ingestion
  assert.equal(planData.steps[0].status, 'completed');
});

test('refresh export-solution without the marker is a silent step-sync no-op for manualMeta', (t) => {
  // Legacy projects on the manual path may not yet have last-export.json.
  // The handler must still flip the step status (the invocation itself is
  // proof of completion) and must NOT create an empty/null manualMeta.lastExport.
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    STRATEGY: 'manual',
    steps: [{ name: 'Export solution', status: 'in_progress' }],
  });
  // No docs/alm/last-export.json on disk

  const result = refresh({ projectRoot: root, phase: 'export-solution', render: false });
  assert.equal(result.ok, true);
  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.equal(planData.steps[0].status, 'completed');
  // manualMeta should NOT be present (or its lastExport should not be present) —
  // the renderer would treat absence as "no export data yet" rather than
  // "export ran with null fields", which is more accurate.
  if (planData.manualMeta) {
    assert.equal(planData.manualMeta.lastExport, undefined,
      'no marker → no manualMeta.lastExport key (avoid null-filled rows in the Manual-path tab)');
  }
});

test('refresh export-solution handles malformed last-export.json gracefully', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    STRATEGY: 'manual',
    steps: [{ name: 'Export solution', status: 'in_progress' }],
  });
  const fs = require('fs');
  fs.mkdirSync(path.join(root, 'docs', 'alm'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'alm', 'last-export.json'), 'not-json{{{');

  // readJson is the shared internal helper — malformed JSON returns null,
  // so the handler degrades to step-sync-only.
  const result = refresh({ projectRoot: root, phase: 'export-solution', render: false });
  assert.equal(result.ok, true);
  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.equal(planData.steps[0].status, 'completed');
  // No partially-populated manualMeta.lastExport from a malformed marker.
  if (planData.manualMeta) {
    assert.equal(planData.manualMeta.lastExport, undefined);
  }
});

test('refresh export-solution stamps LAST_SYNC_AT — Phase 4.0 bump modifies source modifiedon', (t) => {
  // Without this stamp, a subsequent Phase 0 check in import-solution or
  // deploy-pipeline would see sol.modifiedon > GENERATED_AT and falsely flag
  // the plan as stale because export's always-on bump just modified it.
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    GENERATED_AT: '2026-05-25T09:00:00.000Z',
    PLAN_STATUS: 'In Execution',
    steps: [{ name: 'Export solution', status: 'in_progress' }],
  });

  const before = Date.now();
  refresh({ projectRoot: root, phase: 'export-solution', render: false });
  const after = Date.now();

  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.ok(planData.LAST_SYNC_AT, 'export-solution must stamp LAST_SYNC_AT (Phase 4.0 bumps source modifiedon)');
  const writtenMs = Date.parse(planData.LAST_SYNC_AT);
  assert.ok(writtenMs >= before && writtenMs <= after);
});

test('refresh configure-env-variables stamps LAST_SYNC_AT — env var defs bump source modifiedon', (t) => {
  // configure-env-variables creates environmentvariabledefinition records and
  // adds them to the solution via AddSolutionComponent. Each AddSolutionComponent
  // bumps solutions.modifiedon. Without the stamp, the next Phase 0 check
  // would falsely flag stale.
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    GENERATED_AT: '2026-05-25T09:00:00.000Z',
    PLAN_STATUS: 'In Execution',
    steps: [{ name: 'Configure env variables', status: 'in_progress' }],
  });

  const before = Date.now();
  refresh({ projectRoot: root, phase: 'configure-env-variables', render: false });
  const after = Date.now();

  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.ok(planData.LAST_SYNC_AT, 'configure-env-variables must stamp LAST_SYNC_AT (env var creation bumps source modifiedon)');
  const writtenMs = Date.parse(planData.LAST_SYNC_AT);
  assert.ok(writtenMs >= before && writtenMs <= after);
});

test('refresh deploy-pipeline ingests batchValidation block from last-deploy.json (MULTI_RUN_MODE)', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    STRATEGY: 'pp-pipelines',
    steps: [{ name: 'Deploy via pipeline to Staging', status: 'in_progress' }],
    stages: [{ label: 'Staging', envUrl: 'https://staging.crm.dynamics.com' }],
  });
  writeJson(path.join(root, 'docs', 'alm', 'last-deploy.json'), {
    pipelineId: 'pipe-1',
    stageRunId: 'srun-core',
    stageName: 'Staging',
    status: 'Succeeded',
    deployedAt: '2026-05-26T12:00:00.000Z',
    artifactVersion: '1.0.0.5',
    componentCount: 247,
    activationStatus: 'Activated',
    siteUrl: 'https://contoso.powerappsportals.com',
    targetEnvironmentUrl: 'https://staging.crm.dynamics.com',
    batchValidation: {
      totalSolutions: 3,
      succeeded: 3,
      failed: 0,
      pendingApproval: 0,
      timedOut: 0,
      elapsedSeconds: 187,
      perSolutionStageRunIds: {
        'TestSite_Core': 'srun-core',
        'TestSite_WebAssets': 'srun-webassets',
        'TestSite_Future': 'srun-future',
      },
    },
  });

  const result = refresh({ projectRoot: root, phase: 'deploy-pipeline', render: false });
  assert.equal(result.ok, true);
  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));

  const ld = planData.pipelineMeta.lastDeploy;
  // Top-level fields ingested as before
  assert.equal(ld.status, 'Succeeded');
  assert.equal(ld.artifactVersion, '1.0.0.5');
  // New batchValidation block ingested
  assert.ok(ld.batchValidation, 'batchValidation block must be ingested');
  assert.equal(ld.batchValidation.totalSolutions, 3);
  assert.equal(ld.batchValidation.succeeded, 3);
  assert.equal(ld.batchValidation.elapsedSeconds, 187);
  assert.deepEqual(ld.batchValidation.perSolutionStageRunIds, {
    'TestSite_Core': 'srun-core',
    'TestSite_WebAssets': 'srun-webassets',
    'TestSite_Future': 'srun-future',
  });
});

test('refresh deploy-pipeline completes the "Activate site" step when the marker evidences activation, but not Test', (t) => {
  // The PP deploy flow activates the site internally (marker.activationStatus),
  // so a successful deploy must also complete the matching "Activate site in {stage}"
  // step — otherwise computeNextStep would redundantly point the user at
  // /activate-site. Testing remains a separate step (test-site flips it).
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    STRATEGY: 'pp-pipelines',
    steps: [
      { name: 'Deploy via pipeline to Staging', status: 'pending' },
      { name: 'Activate site in Staging', status: 'pending' },
      { name: 'Test site in Staging', status: 'pending' },
    ],
    stages: [{ label: 'Staging', envUrl: 'https://staging.crm.dynamics.com' }],
  });
  writeJson(path.join(root, 'docs', 'alm', 'last-deploy.json'), {
    stageRunId: 'srun-1', stageName: 'Staging', status: 'Succeeded',
    deployedAt: '2026-06-16T00:00:00.000Z', activationStatus: 'Activated',
    siteUrl: 'https://contoso.powerappsportals.com',
  });

  refresh({ projectRoot: root, phase: 'deploy-pipeline', render: false });
  const steps = readJson(path.join(root, 'docs', '.alm-plan-data.json')).steps;
  const byName = (n) => steps.find((s) => s.name === n).status;
  assert.equal(byName('Deploy via pipeline to Staging'), 'completed');
  assert.equal(byName('Activate site in Staging'), 'completed', 'deploy activates the site -> Activate step completes too');
  assert.equal(byName('Test site in Staging'), 'pending', 'Test stays pending — it is the separate test-site step');
});

test('refresh deploy-pipeline leaves the "Activate site" step pending when activation was not done (null or deferred "Pending")', (t) => {
  // Only an explicit "Activated" outcome completes the Activate step. A missing
  // activationStatus (null) OR a deferred activation (deploy-pipeline writes
  // "Pending" when the user defers) must leave the step pending — the user still
  // needs to run /activate-site, and nextStep must keep surfacing it.
  for (const activationStatus of [undefined, null, 'Pending', 'Failed']) {
    const root = makeProject(t);
    writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
      SITE_NAME: 'TestSite',
      STRATEGY: 'pp-pipelines',
      steps: [
        { name: 'Deploy via pipeline to Staging', status: 'pending' },
        { name: 'Activate site in Staging', status: 'pending' },
      ],
      stages: [{ label: 'Staging', envUrl: 'https://staging.crm.dynamics.com' }],
    });
    const marker = { stageRunId: 'srun-1', stageName: 'Staging', status: 'Succeeded', deployedAt: '2026-06-16T00:00:00.000Z' };
    if (activationStatus !== undefined) marker.activationStatus = activationStatus;
    writeJson(path.join(root, 'docs', 'alm', 'last-deploy.json'), marker);

    refresh({ projectRoot: root, phase: 'deploy-pipeline', render: false });
    const steps = readJson(path.join(root, 'docs', '.alm-plan-data.json')).steps;
    assert.equal(
      steps.find((s) => s.name === 'Activate site in Staging').status,
      'pending',
      `activationStatus=${JSON.stringify(activationStatus)} must NOT complete the Activate step`,
    );
  }
});

test('refresh deploy-pipeline accepts legacy elapsedSecondsApprox name in batchValidation', (t) => {
  // Backward-compatibility: legacy SKILL.md prose (pre-v1.x) used
  // `elapsedSecondsApprox`. Markers written under that schema still in the
  // wild should normalize to `elapsedSeconds` on ingest so renderers don't
  // see two different field names.
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    STRATEGY: 'pp-pipelines',
    steps: [{ name: 'Deploy via pipeline to Staging', status: 'in_progress' }],
    stages: [{ label: 'Staging', envUrl: 'https://staging.crm.dynamics.com' }],
  });
  writeJson(path.join(root, 'docs', 'alm', 'last-deploy.json'), {
    pipelineId: 'pipe-1',
    stageRunId: 'srun-1',
    stageName: 'Staging',
    status: 'Succeeded',
    deployedAt: '2026-05-26T12:00:00.000Z',
    artifactVersion: '1.0.0.5',
    componentCount: 247,
    batchValidation: {
      totalSolutions: 2,
      succeeded: 2,
      failed: 0,
      pendingApproval: 0,
      timedOut: 0,
      elapsedSecondsApprox: 95, // legacy name
    },
  });

  refresh({ projectRoot: root, phase: 'deploy-pipeline', render: false });
  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.equal(planData.pipelineMeta.lastDeploy.batchValidation.elapsedSeconds, 95,
    'legacy elapsedSecondsApprox must be normalized to elapsedSeconds on ingest');
});

test('refresh deploy-pipeline sets batchValidation to null when marker omits the block (single-solution / v2)', (t) => {
  // Single-solution and legacy v2 manifests don't go through Phase 3.6 batch
  // validation; the marker won't have a batchValidation block. The handler
  // must explicitly set `lastDeploy.batchValidation = null` so the renderer
  // can distinguish "single-solution deploy" from "the data hasn't been
  // ingested yet" (which would be `undefined`).
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    STRATEGY: 'pp-pipelines',
    steps: [{ name: 'Deploy via pipeline to Staging', status: 'in_progress' }],
    stages: [{ label: 'Staging', envUrl: 'https://staging.crm.dynamics.com' }],
  });
  writeJson(path.join(root, 'docs', 'alm', 'last-deploy.json'), {
    pipelineId: 'pipe-1',
    stageRunId: 'srun-1',
    stageName: 'Staging',
    status: 'Succeeded',
    deployedAt: '2026-05-26T12:00:00.000Z',
    artifactVersion: '1.0.0.5',
    componentCount: 247,
    // no batchValidation block
  });

  refresh({ projectRoot: root, phase: 'deploy-pipeline', render: false });
  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.equal(planData.pipelineMeta.lastDeploy.batchValidation, null,
    'batchValidation must be explicitly null (not undefined) so renderers can branch on it');
});

test('refresh import-solution accepts the phase and round-trips planData', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    STRATEGY: 'manual',
    steps: [
      { name: 'Import to Staging', status: 'completed' },
      { name: 'Import to Production', status: 'in_progress' },
    ],
  });

  const result = refresh({ projectRoot: root, phase: 'import-solution', render: false });
  assert.equal(result.ok, true);
  assert.equal(result.phase, 'import-solution');
  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.equal(planData.steps[0].status, 'completed');
  assert.equal(planData.steps[1].status, 'in_progress');
});

test('refresh activate-site accepts the phase and round-trips planData', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    STRATEGY: 'manual',
    steps: [
      { name: 'Activate site in Staging', status: 'completed' },
    ],
  });

  const result = refresh({ projectRoot: root, phase: 'activate-site', render: false });
  assert.equal(result.ok, true);
  assert.equal(result.phase, 'activate-site');
  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.equal(planData.steps[0].status, 'completed');
});

test('refresh export-solution + import-solution + activate-site phases are listed in the validation error', (t) => {
  // Negative path: the validation-error message must reference the new phases
  // so users invoking the helper with a typo see an accurate enumeration.
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), { SITE_NAME: 'Test' });
  assert.throws(
    () => refresh({ projectRoot: root, phase: 'bogus-phase', render: false }),
    (err) => {
      assert.match(err.message, /--phase must be one of/);
      assert.match(err.message, /export-solution/);
      assert.match(err.message, /import-solution/);
      assert.match(err.message, /activate-site/);
      return true;
    },
  );
});

// ── Per-target import history ─────────────────────────────────────────────────
//
// import-solution writes docs/alm/last-import.json with the most recent import only;
// for Manual path with N targets we want a per-target record so the rendered
// plan can show "Import to Staging: IMPORTED v1.0.4 (288 components)" while
// "Import to Production" stays in_progress. refreshImportSolution captures
// the marker into planData.manualImports[stageName] keyed by the explicit
// --stageName arg (preferred) or derived from a URL match against
// planData.stages.

test('refresh import-solution captures per-target import outcome with stageName', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    STRATEGY: 'manual',
    stages: [
      { label: 'Staging', envUrl: 'https://staging.crm.dynamics.com', type: 'target' },
      { label: 'Production', envUrl: 'https://prod.crm.dynamics.com', type: 'target' },
    ],
    steps: [
      { name: 'Import to Staging', status: 'completed' },
      { name: 'Import to Production', status: 'pending' },
    ],
  });
  writeJson(path.join(root, 'docs', 'alm', 'last-import.json'), {
    solutionName: 'cr_TestSolution',
    targetEnvironment: 'https://staging.crm.dynamics.com',
    importedAt: '2026-05-08T16:00:00.000Z',
    status: 'Succeeded',
    artifactVersion: '1.0.4',
    componentCount: 288,
    componentResults: [
      { name: 'comp1', status: 'Succeeded' },
      { name: 'comp2', status: 'Succeeded' },
    ],
    importJobId: 'job-123',
  });

  const result = refresh({
    projectRoot: root,
    phase: 'import-solution',
    stageName: 'Staging',
    render: false,
  });
  assert.equal(result.ok, true);

  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  const staging = planData.manualImports && planData.manualImports.Staging;
  assert.ok(staging, 'planData.manualImports.Staging should be populated');
  assert.equal(staging.solutionName, 'cr_TestSolution');
  assert.equal(staging.targetEnvironment, 'https://staging.crm.dynamics.com');
  assert.equal(staging.status, 'Succeeded');
  assert.equal(staging.artifactVersion, '1.0.4');
  assert.equal(staging.componentCount, 288);
  assert.equal(staging.componentFailureCount, 0,
    'all componentResults Succeeded so failure count is 0');
  assert.equal(staging.importJobId, 'job-123');

  assert.equal(planData.manualImports && planData.manualImports.Production, undefined);
});

test('refresh import-solution falls back to URL match when stageName absent', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    STRATEGY: 'manual',
    stages: [
      { label: 'Staging', envUrl: 'https://staging.crm.dynamics.com/', type: 'target' },
      { label: 'Production', envUrl: 'https://prod.crm.dynamics.com', type: 'target' },
    ],
  });
  writeJson(path.join(root, 'docs', 'alm', 'last-import.json'), {
    solutionName: 'cr_TestSolution',
    targetEnvironment: 'https://prod.crm.dynamics.com/some/path',
    importedAt: '2026-05-08T17:00:00.000Z',
    status: 'Succeeded',
  });

  refresh({
    projectRoot: root,
    phase: 'import-solution',
    render: false,
  });

  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.ok(planData.manualImports && planData.manualImports.Production,
    'URL match against stages[].envUrl should resolve targetEnvironment to the Production stage');
  assert.equal(planData.manualImports.Production.status, 'Succeeded');
});

test('refresh import-solution captures component failures into componentFailureCount', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    STRATEGY: 'manual',
    stages: [{ label: 'Staging', envUrl: 'https://staging.crm.dynamics.com' }],
  });
  writeJson(path.join(root, 'docs', 'alm', 'last-import.json'), {
    solutionName: 'cr_TestSolution',
    targetEnvironment: 'https://staging.crm.dynamics.com',
    importedAt: '2026-05-08T16:00:00.000Z',
    status: 'Failed',
    componentResults: [
      { name: 'comp1', status: 'Succeeded' },
      { name: 'comp2', status: 'Failed' },
      { name: 'comp3', status: 'Failed' },
      { name: 'comp4', status: 'Succeeded' },
    ],
  });

  refresh({
    projectRoot: root,
    phase: 'import-solution',
    stageName: 'Staging',
    render: false,
  });

  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.equal(planData.manualImports.Staging.componentFailureCount, 2);
  assert.equal(planData.manualImports.Staging.componentCount, 4,
    'componentCount falls back to componentResults.length when not explicit');
});

test('refresh import-solution preserves prior-stage entries across calls', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    STRATEGY: 'manual',
    stages: [
      { label: 'Staging', envUrl: 'https://staging.crm.dynamics.com' },
      { label: 'Production', envUrl: 'https://prod.crm.dynamics.com' },
    ],
  });

  writeJson(path.join(root, 'docs', 'alm', 'last-import.json'), {
    solutionName: 'cr_TestSolution',
    targetEnvironment: 'https://staging.crm.dynamics.com',
    importedAt: '2026-05-08T16:00:00.000Z',
    status: 'Succeeded',
    artifactVersion: '1.0.4',
  });
  refresh({ projectRoot: root, phase: 'import-solution', stageName: 'Staging', render: false });

  writeJson(path.join(root, 'docs', 'alm', 'last-import.json'), {
    solutionName: 'cr_TestSolution',
    targetEnvironment: 'https://prod.crm.dynamics.com',
    importedAt: '2026-05-08T17:30:00.000Z',
    status: 'Succeeded',
    artifactVersion: '1.0.4',
  });
  refresh({ projectRoot: root, phase: 'import-solution', stageName: 'Production', render: false });

  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.ok(planData.manualImports.Staging, 'Staging entry should survive the Production import');
  assert.equal(planData.manualImports.Staging.targetEnvironment, 'https://staging.crm.dynamics.com');
  assert.equal(planData.manualImports.Production.targetEnvironment, 'https://prod.crm.dynamics.com');
});

test('refresh import-solution writes synthetic key when stage cannot be resolved', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    STRATEGY: 'manual',
    stages: [
      { label: 'Staging', envUrl: 'https://staging.crm.dynamics.com' },
    ],
  });
  writeJson(path.join(root, 'docs', 'alm', 'last-import.json'), {
    solutionName: 'cr_TestSolution',
    targetEnvironment: 'https://elsewhere.crm.dynamics.com',
    importedAt: '2026-05-08T16:00:00.000Z',
    status: 'Succeeded',
  });

  refresh({ projectRoot: root, phase: 'import-solution', render: false });

  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  const keys = Object.keys(planData.manualImports || {});
  assert.equal(keys.length, 1);
  assert.match(keys[0], /^unresolved-/, 'unresolvable stage should land under a synthetic key');
});

// ── setup-solution: ingest docs/alm/last-env-vars.json sidecar into planData.envVars ─

test('refresh setup-solution ingests docs/alm/last-env-vars.json into planData.envVars', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    plannedEnvVarCount: 7,
    envVars: [],  // empty before setup-solution runs
  });
  writeJson(path.join(root, 'docs', 'alm', 'last-env-vars.json'), {
    envVars: [
      { schemaName: 'ids_authentication_registration_localloginenabled', type: 'String', defaultValue: 'true', siteSetting: 'Authentication/Registration/LocalLoginEnabled' },
      { schemaName: 'ids_authentication_openauth_linkedin_clientsecret', type: 'Secret', defaultValue: null, siteSetting: 'Authentication/OpenAuth/LinkedIn/ClientSecret' },
    ],
    count: 2,
  });

  refresh({ projectRoot: root, phase: 'setup-solution', render: false });

  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.equal(planData.plannedEnvVarCount, 0,
    'plannedEnvVarCount must reset to 0 after setup-solution (planned has been resolved)');
  assert.equal(planData.envVars.length, 2,
    'planData.envVars should be populated from the sidecar');
  assert.equal(planData.envVars[0].schemaName, 'ids_authentication_registration_localloginenabled');
  assert.equal(planData.envVars[1].type, 'Secret');
});

test('refresh setup-solution leaves planData.envVars unchanged when sidecar is missing', (t) => {
  const root = makeProject(t);
  const originalEnvVars = [
    { schemaName: 'ids_existing', type: 'String', defaultValue: 'foo', siteSetting: 'Existing/Setting' },
  ];
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    plannedEnvVarCount: 0,
    envVars: originalEnvVars,
  });
  // No docs/alm/last-env-vars.json — refresh should soft-no-op on the env vars side.

  refresh({ projectRoot: root, phase: 'setup-solution', render: false });

  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.deepEqual(planData.envVars, originalEnvVars,
    'env vars must round-trip unchanged when sidecar is absent');
});

test('refresh setup-solution accepts an empty envVars[] sidecar (skip-all path)', (t) => {
  // Tier 1 "Skip all" + Tier 2 "Keep all as plain site settings" → no env
  // vars created. The sidecar correctly reports envVars: []. The renderer
  // should reflect the empty existing state instead of stale planned counts.
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    plannedEnvVarCount: 12,
    envVars: [],
  });
  writeJson(path.join(root, 'docs', 'alm', 'last-env-vars.json'), { envVars: [], count: 0 });

  refresh({ projectRoot: root, phase: 'setup-solution', render: false });

  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.equal(planData.plannedEnvVarCount, 0);
  assert.deepEqual(planData.envVars, [],
    'empty sidecar (user skipped all) should leave planData.envVars empty');
});

test('refresh setup-solution writes LAST_SYNC_AT so post-sync freshness checks do not falsely flag stale', (t) => {
  // G3: setup-solution sync mode bumps `solutions.modifiedon` past GENERATED_AT
  // through its version-PATCH + AddSolutionComponent operations. Without
  // LAST_SYNC_AT, a subsequent deploy-pipeline Phase 0 check would see
  // sol.modifiedon > GENERATED_AT and incorrectly fire the stale-plan gate
  // even though the modification was just-completed sync, not drift.
  // The refresh-alm-plan-data setup-solution handler writes LAST_SYNC_AT
  // so check-alm-plan.js's freshness check uses max(GENERATED_AT, LAST_SYNC_AT).
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    GENERATED_AT: '2026-05-25T09:00:00.000Z',
    PLAN_STATUS: 'In Execution',
    steps: [{ name: 'Setup solution', status: 'in_progress' }],
  });

  const before = Date.now();
  refresh({ projectRoot: root, phase: 'setup-solution', render: false });
  const after = Date.now();

  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.ok(planData.LAST_SYNC_AT, 'LAST_SYNC_AT must be written');
  const writtenMs = Date.parse(planData.LAST_SYNC_AT);
  assert.ok(Number.isFinite(writtenMs), 'LAST_SYNC_AT must be a parseable ISO timestamp');
  assert.ok(writtenMs >= before && writtenMs <= after, 'LAST_SYNC_AT must reflect the current invocation time');
  // Step-sync still works alongside the marker write
  assert.equal(planData.steps[0].status, 'completed');
});

// ── activate-site: ingest docs/alm/last-activate.json into planData.activations ──────

test('refresh activate-site captures siteUrl + status into planData.activations[stageName]', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    stages: [
      { label: 'Staging', envUrl: 'https://staging.crm.dynamics.com', type: 'target' },
    ],
  });
  writeJson(path.join(root, 'docs', 'alm', 'last-activate.json'), {
    stageName: 'Staging',
    siteName: 'TestSite',
    siteUrl: 'https://teststaging.powerappsportals.com',
    websiteRecordId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    environmentUrl: 'https://staging.crm.dynamics.com',
    activatedAt: '2026-05-08T20:00:00.000Z',
    status: 'Activated',
  });

  refresh({ projectRoot: root, phase: 'activate-site', stageName: 'Staging', render: false });

  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.ok(planData.activations && planData.activations.Staging,
    'planData.activations.Staging should be populated');
  assert.equal(planData.activations.Staging.siteUrl, 'https://teststaging.powerappsportals.com');
  assert.equal(planData.activations.Staging.status, 'Activated');
  assert.equal(planData.activations.Staging.activatedAt, '2026-05-08T20:00:00.000Z');
});

test('refresh activate-site falls back to environmentUrl match when stageName absent', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    stages: [
      { label: 'Staging', envUrl: 'https://staging.crm.dynamics.com', type: 'target' },
      { label: 'Production', envUrl: 'https://prod.crm.dynamics.com', type: 'target' },
    ],
  });
  writeJson(path.join(root, 'docs', 'alm', 'last-activate.json'), {
    siteName: 'TestSite',
    siteUrl: 'https://testprod.powerappsportals.com',
    environmentUrl: 'https://prod.crm.dynamics.com',
    activatedAt: '2026-05-08T21:00:00.000Z',
    status: 'Activated',
    // intentionally NO stageName field
  });

  refresh({ projectRoot: root, phase: 'activate-site', render: false });

  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.ok(planData.activations && planData.activations.Production,
    'environmentUrl match should resolve to the Production stage');
  assert.equal(planData.activations.Production.siteUrl, 'https://testprod.powerappsportals.com');
});

test('refresh activate-site preserves prior-stage entries across calls', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    stages: [
      { label: 'Staging', envUrl: 'https://staging.crm.dynamics.com' },
      { label: 'Production', envUrl: 'https://prod.crm.dynamics.com' },
    ],
  });

  // Activate Staging.
  writeJson(path.join(root, 'docs', 'alm', 'last-activate.json'), {
    stageName: 'Staging',
    siteUrl: 'https://teststaging.powerappsportals.com',
    environmentUrl: 'https://staging.crm.dynamics.com',
    status: 'Activated',
    activatedAt: '2026-05-08T20:00:00.000Z',
  });
  refresh({ projectRoot: root, phase: 'activate-site', stageName: 'Staging', render: false });

  // Activate Production. docs/alm/last-activate.json gets overwritten by the second activate-site run.
  writeJson(path.join(root, 'docs', 'alm', 'last-activate.json'), {
    stageName: 'Production',
    siteUrl: 'https://testprod.powerappsportals.com',
    environmentUrl: 'https://prod.crm.dynamics.com',
    status: 'Activated',
    activatedAt: '2026-05-08T21:30:00.000Z',
  });
  refresh({ projectRoot: root, phase: 'activate-site', stageName: 'Production', render: false });

  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.ok(planData.activations.Staging, 'Staging entry should survive the Production activation');
  assert.equal(planData.activations.Staging.siteUrl, 'https://teststaging.powerappsportals.com');
  assert.equal(planData.activations.Production.siteUrl, 'https://testprod.powerappsportals.com');
});

test('refresh activate-site recognizes AlreadyActivated status', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    stages: [{ label: 'Staging', envUrl: 'https://staging.crm.dynamics.com' }],
  });
  writeJson(path.join(root, 'docs', 'alm', 'last-activate.json'), {
    stageName: 'Staging',
    siteUrl: 'https://teststaging.powerappsportals.com',
    environmentUrl: 'https://staging.crm.dynamics.com',
    status: 'AlreadyActivated',
    activatedAt: '2026-05-08T20:00:00.000Z',
  });

  refresh({ projectRoot: root, phase: 'activate-site', stageName: 'Staging', render: false });

  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.equal(planData.activations.Staging.status, 'AlreadyActivated',
    'AlreadyActivated status round-trips so the renderer can show ALREADY LIVE badge');
});

// ── test-site stageName fallback (no --stageName arg, derive via marker / single-target) ──

test('refresh test-site falls back to marker.stageName when --stageName arg absent', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    stages: [
      { label: 'Staging', envUrl: 'https://staging.crm.dynamics.com', type: 'target' },
      { label: 'Production', envUrl: 'https://prod.crm.dynamics.com', type: 'target' },
    ],
  });
  writeJson(path.join(root, 'docs', 'alm', 'last-test-site.json'), {
    url: 'https://teststaging.powerappsportals.com',
    stageName: 'Staging',
    runAt: '2026-05-08T22:00:00.000Z',
    durationSec: 90,
    runOutcome: 'passed',
    summary: { passed: 5, failed: 0, skipped: 0, total: 5 },
  });

  refresh({ projectRoot: root, phase: 'test-site', render: false });

  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.ok(planData.validationRuns && planData.validationRuns.Staging,
    'marker stageName field should resolve to Staging');
  assert.equal(planData.validationRuns.Staging.runOutcome, 'passed');
});

test('refresh test-site falls back to single target stage when no stageName signal', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    stages: [
      { label: 'Dev', envUrl: 'https://dev.crm.dynamics.com', type: 'source' },
      { label: 'Production', envUrl: 'https://prod.crm.dynamics.com', type: 'target' },
    ],
  });
  writeJson(path.join(root, 'docs', 'alm', 'last-test-site.json'), {
    url: 'https://testprod.powerappsportals.com',
    runAt: '2026-05-08T23:00:00.000Z',
    runOutcome: 'passed',
    // no stageName in marker, no --stageName arg, but only ONE target stage exists
  });

  refresh({ projectRoot: root, phase: 'test-site', render: false });

  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.ok(planData.validationRuns && planData.validationRuns.Production,
    'single-target fallback should map to Production');
});

test('refresh test-site no-ops when no stageName signal and multiple targets', (t) => {
  // Multi-target, no stageName in marker, no --stageName arg → cannot resolve.
  // Helper should not corrupt validationRuns by guessing.
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    stages: [
      { label: 'Staging', envUrl: 'https://staging.crm.dynamics.com', type: 'target' },
      { label: 'Production', envUrl: 'https://prod.crm.dynamics.com', type: 'target' },
    ],
    validationRuns: {},
  });
  writeJson(path.join(root, 'docs', 'alm', 'last-test-site.json'), {
    url: 'https://test.powerappsportals.com',
    runOutcome: 'passed',
  });

  refresh({ projectRoot: root, phase: 'test-site', render: false });

  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.deepEqual(planData.validationRuns, {},
    'multi-target ambiguous case must not silently pick a stage');
});

// ── Step-sync ────────────────────────────────────────────────────────────
//
// refresh-alm-plan-data used to leave planData.steps[i].status updates to
// the agent (via Edit). In multi-phase orchestration that consistently got
// missed, so the rendered checklist drifted from reality. The helper now
// flips the matching step for every phase. Coverage:

test('step-sync: setup-solution flips "Setup solution" to completed', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    plannedEnvVarCount: 3,
    steps: [
      { name: 'Setup solution', status: 'pending' },
      { name: 'Setup pipeline', status: 'pending' },
    ],
  });

  refresh({ projectRoot: root, phase: 'setup-solution', render: false });

  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.equal(planData.steps[0].status, 'completed', 'Setup solution must flip');
  assert.equal(planData.steps[1].status, 'pending', 'Setup pipeline must NOT flip — different phase');
});

test('step-sync: setup-pipeline flips "Setup pipeline" to completed even without a marker', (t) => {
  // Invocation of --phase X is the proof, not the marker. Marker absence is
  // a soft no-op for the data-ingest path but step-sync still fires so the
  // checklist tracks orchestration progress.
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    steps: [
      { name: 'Setup pipeline', status: 'in_progress' },
      { name: 'Deploy via pipeline to Staging', status: 'pending' },
    ],
  });

  refresh({ projectRoot: root, phase: 'setup-pipeline', render: false });

  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.equal(planData.steps[0].status, 'completed');
  assert.equal(planData.steps[1].status, 'pending', 'deploy step is a later phase — must not flip');
});

test('step-sync: deploy-pipeline flips ONLY the matching stage step to completed on success', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', 'alm', 'last-deploy.json'), {
    stageRunId: 'sr-1',
    stageName: 'Staging',
    status: 'Succeeded',
    deployedAt: '2026-05-17T10:00:00Z',
  });
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    steps: [
      { name: 'Deploy via pipeline to Staging', status: 'pending' },
      { name: 'Deploy via pipeline to Production', status: 'pending' },
    ],
  });

  refresh({ projectRoot: root, phase: 'deploy-pipeline', render: false });

  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.equal(planData.steps[0].status, 'completed', 'Staging deploy step must flip');
  assert.equal(planData.steps[1].status, 'pending',
    'Production deploy step must stay pending — stage filter disambiguates "Deploy" steps');
});

test('step-sync: deploy-pipeline matches the REAL marker stageName "Deploy to {label}" (not just bare "Staging")', (t) => {
  // Regression for the stage-name mismatch: setup-pipeline names pipeline stages
  // "Deploy to {targetLabel}", and deploy-pipeline writes that verbatim as
  // last-deploy.json's stageName ("Deploy to Staging"). The plan step is
  // "Deploy via pipeline to Staging", so a raw substring match of the marker's
  // "deploy to staging" against the step name FAILS and the step would never
  // flip. setStepStatus must strip the leading "Deploy to " to recover "Staging".
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', 'alm', 'last-deploy.json'), {
    stageRunId: 'sr-real', stageName: 'Deploy to Staging', status: 'Succeeded',
    deployedAt: '2026-06-16T10:00:00Z', activationStatus: 'Activated',
    siteUrl: 'https://contoso.powerappsportals.com',
  });
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    steps: [
      { name: 'Deploy via pipeline to Staging', status: 'pending' },
      { name: 'Activate site in Staging', status: 'pending' },
      { name: 'Test site in Staging', status: 'pending' },
      { name: 'Deploy via pipeline to Production', status: 'pending' },
    ],
  });

  refresh({ projectRoot: root, phase: 'deploy-pipeline', render: false });

  const steps = readJson(path.join(root, 'docs', '.alm-plan-data.json')).steps;
  const st = (n) => steps.find((s) => s.name === n).status;
  assert.equal(st('Deploy via pipeline to Staging'), 'completed', 'real "Deploy to Staging" marker must flip the Staging deploy step');
  assert.equal(st('Activate site in Staging'), 'completed', 'activation evidence + normalized stage must flip the Activate step');
  assert.equal(st('Test site in Staging'), 'pending', 'Test stays the separate test-site step');
  assert.equal(st('Deploy via pipeline to Production'), 'pending', 'Production must NOT be touched by a "Deploy to Staging" marker');
});

test('setStepStatus: exported helper normalizes a "Deploy to {label}" stage to the bare label', () => {
  const { setStepStatus } = require('../lib/refresh-alm-plan-data');
  const planData = {
    steps: [
      { name: 'Deploy via pipeline to Staging', status: 'pending' },
      { name: 'Deploy via pipeline to Production', status: 'pending' },
    ],
  };
  const flipped = setStepStatus(planData, { keyword: /\bdeploy\b/i, stage: 'Deploy to Staging', status: 'completed' });
  assert.equal(flipped, 1);
  assert.equal(planData.steps[0].status, 'completed');
  assert.equal(planData.steps[1].status, 'pending');
});

test('step-sync: deploy-pipeline records "failed" status when marker shows failure', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', 'alm', 'last-deploy.json'), {
    stageRunId: 'sr-2',
    stageName: 'Staging',
    status: 'Failed',
    deployedAt: '2026-05-17T10:30:00Z',
  });
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    steps: [
      { name: 'Deploy via pipeline to Staging', status: 'pending' },
    ],
  });

  refresh({ projectRoot: root, phase: 'deploy-pipeline', render: false });

  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.equal(planData.steps[0].status, 'failed',
    'a failed deploy marker must be reflected as failed in the checklist');
});

test('step-sync: import-solution flips the right stage step on success', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', 'alm', 'last-import.json'), {
    solutionName: 'Foo',
    targetEnvironment: 'https://staging.crm.dynamics.com/',
    importedAt: '2026-05-17T11:00:00Z',
    status: 'Succeeded',
    componentResults: [],
  });
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    steps: [
      { name: 'Import to Staging', status: 'pending' },
      { name: 'Import to Production', status: 'pending' },
    ],
  });

  refresh({ projectRoot: root, phase: 'import-solution', render: false, stageName: 'Staging' });

  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.equal(planData.steps[0].status, 'completed');
  assert.equal(planData.steps[1].status, 'pending');
});

test('step-sync: activate-site flips "Activate site in {stage}" only when marker present', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', 'alm', 'last-activate.json'), {
    siteName: 'TestSite',
    siteUrl: 'https://test.powerappsportals.com/',
    environmentUrl: 'https://staging.crm.dynamics.com/',
    activatedAt: '2026-05-17T11:30:00Z',
    status: 'Activated',
  });
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    steps: [
      { name: 'Activate site in Staging', status: 'pending' },
      { name: 'Activate site in Production', status: 'pending' },
    ],
  });

  refresh({ projectRoot: root, phase: 'activate-site', render: false, stageName: 'Staging' });

  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.equal(planData.steps[0].status, 'completed');
  assert.equal(planData.steps[1].status, 'pending');
});

test('step-sync: test-site is non-blocking — always completes the step regardless of runOutcome', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', 'alm', 'last-test-site.json'), {
    stageName: 'Staging',
    url: 'https://test.powerappsportals.com/',
    runAt: '2026-05-17T12:00:00Z',
    runOutcome: 'failed',  // tests had failures
    summary: { critical: 1, high: 0, medium: 0, low: 0, total: 1 },
    categories: [],
  });
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    steps: [
      { name: 'Test site in Staging', status: 'pending' },
    ],
  });

  refresh({ projectRoot: root, phase: 'test-site', render: false, stageName: 'Staging' });

  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.equal(planData.steps[0].status, 'completed',
    'test-site step must be marked completed even when runOutcome === failed — test failures live in validationRuns[stage], not in the step status');
});

test('step-sync: finalize flips "Finalize" + sets PLAN_STATUS', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    PLAN_STATUS: 'In Execution',
    steps: [
      { name: 'Test site in Production', status: 'completed' },
      { name: 'Finalize ALM plan', status: 'pending' },
    ],
  });

  refresh({ projectRoot: root, phase: 'finalize', render: false });

  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.equal(planData.PLAN_STATUS, 'Completed');
  assert.equal(planData.steps[1].status, 'completed', 'Finalize step must flip');
});

test('step-sync: skip:true steps are NEVER auto-flipped', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    steps: [
      { name: 'Setup solution', status: 'pending', skip: true },
    ],
  });

  refresh({ projectRoot: root, phase: 'setup-solution', render: false });

  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.equal(planData.steps[0].status, 'pending',
    'skip:true means the user opted out — auto-flip must respect that');
});

test('step-sync: already-completed steps are NOT regressed (idempotent re-run)', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    steps: [
      { name: 'Setup solution', status: 'completed' },
    ],
  });

  refresh({ projectRoot: root, phase: 'setup-solution', render: false });

  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.equal(planData.steps[0].status, 'completed', 'completed must stay completed');
});

test('step-sync: a fresh failed marker overrides a stale completed status (retry-then-fail)', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', 'alm', 'last-deploy.json'), {
    stageRunId: 'sr-3',
    stageName: 'Production',
    status: 'Failed',
    deployedAt: '2026-05-17T13:00:00Z',
  });
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    steps: [
      // Already-completed step from a prior successful run; the new deploy
      // attempt to the same stage failed and the step must reflect that.
      { name: 'Deploy via pipeline to Production', status: 'completed' },
    ],
  });

  refresh({ projectRoot: root, phase: 'deploy-pipeline', render: false });

  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.equal(planData.steps[0].status, 'failed',
    'a fresh failure must override a prior completed — the only direction completed can regress in');
});

test('setStepStatus: exported helper handles missing or malformed planData gracefully', () => {
  const { setStepStatus } = require('../lib/refresh-alm-plan-data');
  assert.equal(setStepStatus({}, { keyword: /test/i, status: 'completed' }), 0);
  assert.equal(setStepStatus({ steps: null }, { keyword: /test/i, status: 'completed' }), 0);
  assert.equal(setStepStatus({ steps: 'not-an-array' }, { keyword: /test/i, status: 'completed' }), 0);
  assert.equal(setStepStatus({ steps: [{ name: 'Test step', status: 'pending' }] }, { keyword: null, status: 'completed' }), 0);
});

// ── Env var values backfill from deployment-settings.json ────────────────
//
// deploy-pipeline Phase 5 reads/writes deployment-settings.json to drive the
// `deploymentsettingsjson` PATCH on each stage run. The plan refresh now
// reaches back to that same file so the rendered plan's "Values by
// Environment" matrix populates automatically — no agent Edit required.

test('backfill: deploy-pipeline backfills per-stage values from top-level-stage deployment-settings.json', (t) => {
  const root = makeProject(t);
  // Top-level-stage shape (deploy-pipeline SKILL.md Phase 5.0a template).
  writeJson(path.join(root, 'deployment-settings.json'), {
    Staging: {
      EnvironmentVariables: [
        { SchemaName: 'cr5fe_localLoginEnabled', Value: 'true' },
        { SchemaName: 'cr5fe_apiBaseUrl', Value: 'https://staging.api.example.com' },
      ],
      ConnectionReferences: [],
    },
    Production: {
      EnvironmentVariables: [
        { SchemaName: 'cr5fe_localLoginEnabled', Value: 'false' },
        { SchemaName: 'cr5fe_apiBaseUrl', Value: 'https://api.example.com' },
      ],
    },
  });
  writeJson(path.join(root, 'docs', 'alm', 'last-deploy.json'), {
    stageRunId: 'sr-1', stageName: 'Staging', status: 'Succeeded',
    deployedAt: '2026-05-17T10:00:00Z',
  });
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    envVars: [
      { schemaName: 'cr5fe_localLoginEnabled', displayName: 'Local Login', type: 'Boolean', defaultValue: 'true' },
      { schemaName: 'cr5fe_apiBaseUrl', displayName: 'API Base URL', type: 'String', defaultValue: '' },
    ],
    steps: [{ name: 'Deploy via pipeline to Staging', status: 'pending' }],
  });

  refresh({ projectRoot: root, phase: 'deploy-pipeline', render: false });

  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.deepEqual(planData.envVars[0].values, {
    Staging: 'true',
    Production: 'false',
  }, 'localLoginEnabled values must be backfilled for both Staging and Production');
  assert.deepEqual(planData.envVars[1].values, {
    Staging: 'https://staging.api.example.com',
    Production: 'https://api.example.com',
  });
});

test('backfill: deploy-pipeline accepts the nested `stages` shape too', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'deployment-settings.json'), {
    stages: {
      Staging: {
        EnvironmentVariables: [
          { SchemaName: 'cr5fe_flag', Value: 'on' },
        ],
      },
    },
  });
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    envVars: [{ schemaName: 'cr5fe_flag', type: 'String' }],
  });

  refresh({ projectRoot: root, phase: 'deploy-pipeline', render: false });

  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.deepEqual(planData.envVars[0].values, { Staging: 'on' });
});

test('backfill: deploy-pipeline accepts camelCase inner keys (schemaName/value) for parity with planData', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'deployment-settings.json'), {
    Staging: {
      environmentVariables: [
        { schemaName: 'cr5fe_x', value: 'staging-value' },
      ],
    },
  });
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    envVars: [{ schemaName: 'cr5fe_x', type: 'String' }],
  });

  refresh({ projectRoot: root, phase: 'deploy-pipeline', render: false });
  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.deepEqual(planData.envVars[0].values, { Staging: 'staging-value' });
});

test('backfill: empty/missing values in deployment-settings.json do NOT clobber existing values{}', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'deployment-settings.json'), {
    Staging: {
      EnvironmentVariables: [
        { SchemaName: 'cr5fe_x', Value: '' },  // template placeholder
      ],
    },
  });
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    envVars: [{
      schemaName: 'cr5fe_x',
      type: 'String',
      values: { Staging: 'previously-set-by-agent' },  // existing value must survive
    }],
  });

  refresh({ projectRoot: root, phase: 'deploy-pipeline', render: false });
  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.equal(planData.envVars[0].values.Staging, 'previously-set-by-agent',
    'empty template value must not clobber a real value already on values{}');
});

test('backfill: an existing populated value cell is never overwritten by file values (manual override wins)', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'deployment-settings.json'), {
    Staging: {
      EnvironmentVariables: [
        { SchemaName: 'cr5fe_x', Value: 'file-value' },
      ],
    },
  });
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    envVars: [{
      schemaName: 'cr5fe_x',
      values: { Staging: 'manually-overridden' },
    }],
  });

  refresh({ projectRoot: root, phase: 'deploy-pipeline', render: false });
  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.equal(planData.envVars[0].values.Staging, 'manually-overridden',
    'pre-existing populated cell wins; the file only fills empty slots');
});

test('backfill: missing deployment-settings.json is a silent no-op (no crash, envVars unchanged)', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    envVars: [{ schemaName: 'cr5fe_x', type: 'String' }],
  });

  refresh({ projectRoot: root, phase: 'deploy-pipeline', render: false });
  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  // No values map should have been created — the renderer treats the absence
  // of values as "single defaultValue" rather than rendering an empty matrix.
  assert.equal(planData.envVars[0].values, undefined);
});

test('backfill: malformed deployment-settings.json does not throw — degrade gracefully', (t) => {
  const root = makeProject(t);
  fs.writeFileSync(path.join(root, 'deployment-settings.json'), '{ this is not valid json ', 'utf8');
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    envVars: [{ schemaName: 'cr5fe_x', type: 'String' }],
  });

  assert.doesNotThrow(() => refresh({ projectRoot: root, phase: 'deploy-pipeline', render: false }));
  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.equal(planData.envVars[0].values, undefined);
});

test('backfill: envVars not in deployment-settings.json are left alone (no spurious empty values map)', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'deployment-settings.json'), {
    Staging: {
      EnvironmentVariables: [
        { SchemaName: 'cr5fe_a', Value: 'aaa' },
      ],
    },
  });
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    envVars: [
      { schemaName: 'cr5fe_a', type: 'String' },
      { schemaName: 'cr5fe_b', type: 'String' },  // not in deployment-settings
    ],
  });

  refresh({ projectRoot: root, phase: 'deploy-pipeline', render: false });
  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.deepEqual(planData.envVars[0].values, { Staging: 'aaa' });
  assert.equal(planData.envVars[1].values, undefined,
    'env vars not referenced in deployment-settings.json must not get an empty values{} map');
});

// ── configure-env-variables phase ────────────────────────────────────────

test('configure-env-variables: backfills env var values + ingests last-env-vars sidecar + zeros plannedEnvVarCount', (t) => {
  const root = makeProject(t);
  // The skill writes both the deployment-settings.json (per-stage values)
  // AND the last-env-vars sidecar (definitions) before invoking refresh.
  writeJson(path.join(root, 'deployment-settings.json'), {
    Staging: {
      EnvironmentVariables: [
        { SchemaName: 'cr5fe_x', Value: 'staging-x' },
      ],
    },
    Production: {
      EnvironmentVariables: [
        { SchemaName: 'cr5fe_x', Value: 'prod-x' },
      ],
    },
  });
  writeJson(path.join(root, 'docs', 'alm', 'last-env-vars.json'), {
    envVars: [
      { schemaName: 'cr5fe_x', displayName: 'X', type: 'String', defaultValue: 'dev-x' },
    ],
    count: 1,
  });
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    plannedEnvVarCount: 1,
    envVars: [],  // empty pre-config
    steps: [{ name: 'Configure env variables', status: 'pending' }],
  });

  refresh({ projectRoot: root, phase: 'configure-env-variables', render: false });

  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  // 1. envVars[] populated from the sidecar
  assert.equal(planData.envVars.length, 1);
  assert.equal(planData.envVars[0].schemaName, 'cr5fe_x');
  // 2. values{} backfilled from deployment-settings.json
  assert.deepEqual(planData.envVars[0].values, { Staging: 'staging-x', Production: 'prod-x' });
  // 3. plannedEnvVarCount zeroed
  assert.equal(planData.plannedEnvVarCount, 0);
  // 4. Step flipped
  assert.equal(planData.steps[0].status, 'completed');
});

test('configure-env-variables: is accepted by --phase argument', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), { SITE_NAME: 'TestSite' });
  // Should not throw — the negative-path check earlier asserts "bogus-phase"
  // fails; this asserts the new phase is whitelisted.
  assert.doesNotThrow(() => refresh({ projectRoot: root, phase: 'configure-env-variables', render: false }));
});

test('configure-env-variables: matches "Configure environment variables" step name variants', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    steps: [
      { name: 'Configure environment variables', status: 'pending' },
    ],
  });
  refresh({ projectRoot: root, phase: 'configure-env-variables', render: false });
  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.equal(planData.steps[0].status, 'completed',
    'both "env variables" and "environment variables" step name spellings must flip');
});

test('extractPerStageValues: defensive against null / wrong-type inputs', () => {
  const { extractPerStageValues } = require('../lib/refresh-alm-plan-data');
  assert.equal(extractPerStageValues(null), null);
  assert.equal(extractPerStageValues('not an object'), null);
  assert.deepEqual(extractPerStageValues({}), {});
  // Stage with no EnvironmentVariables array → empty entry, but no crash
  assert.deepEqual(extractPerStageValues({ Staging: { ConnectionReferences: [] } }), {});
  // Stage with malformed array entries → those entries are skipped
  const result = extractPerStageValues({
    Staging: { EnvironmentVariables: [null, { SchemaName: 'x' }, { SchemaName: 'y', Value: 'v' }] },
  });
  assert.deepEqual(result, { y: { Staging: 'v' } });
});

// --- nextStep (DRY next-step lookup for user-driven sequencing) ---------------

test('mapStepToSkill: maps each step-name family to its slash command', () => {
  assert.equal(mapStepToSkill('Setup solution'), '/power-pages:setup-solution');
  assert.equal(mapStepToSkill('Setup pipeline'), '/power-pages:setup-pipeline');
  assert.equal(mapStepToSkill('Export solution'), '/power-pages:export-solution');
  assert.equal(mapStepToSkill('Import to Production'), '/power-pages:import-solution');
  assert.equal(mapStepToSkill('Deploy via pipeline to Staging'), '/power-pages:deploy-pipeline');
  assert.equal(mapStepToSkill('Activate site in Staging'), '/power-pages:activate-site');
  assert.equal(mapStepToSkill('Test site in Production'), '/power-pages:test-site');
  assert.equal(mapStepToSkill('Configure environment variables'), '/power-pages:configure-env-variables');
  // No user-invocable skill → null (e.g. an internal finalize step or junk).
  assert.equal(mapStepToSkill('Finalize'), null);
  assert.equal(mapStepToSkill(''), null);
  assert.equal(mapStepToSkill(undefined), null);
});

test('computeNextStep: returns the first pending step + its skill', () => {
  const next = computeNextStep({
    steps: [
      { name: 'Setup solution', status: 'completed' },
      { name: 'Setup pipeline', status: 'pending' },
      { name: 'Deploy via pipeline to Staging', status: 'pending' },
    ],
  });
  assert.deepEqual(next, { name: 'Setup pipeline', skill: '/power-pages:setup-pipeline' });
});

test('computeNextStep: skips skip:true steps', () => {
  const next = computeNextStep({
    steps: [
      { name: 'Setup solution', status: 'completed' },
      { name: 'Setup pipeline', status: 'pending', skip: true },
      { name: 'Deploy via pipeline to Staging', status: 'pending' },
    ],
  });
  assert.deepEqual(next, { name: 'Deploy via pipeline to Staging', skill: '/power-pages:deploy-pipeline' });
});

test('computeNextStep: skips non-pending statuses (completed/failed/in_progress)', () => {
  const next = computeNextStep({
    steps: [
      { name: 'Setup solution', status: 'completed' },
      { name: 'Setup pipeline', status: 'failed' },
      { name: 'Deploy via pipeline to Staging', status: 'in_progress' },
      { name: 'Activate site in Staging', status: 'pending' },
    ],
  });
  assert.deepEqual(next, { name: 'Activate site in Staging', skill: '/power-pages:activate-site' });
});

test('computeNextStep: treats a missing status as pending', () => {
  const next = computeNextStep({ steps: [{ name: 'Setup solution' }] });
  assert.deepEqual(next, { name: 'Setup solution', skill: '/power-pages:setup-solution' });
});

test('computeNextStep: returns null when every step is complete or there are no steps', () => {
  assert.equal(computeNextStep({ steps: [{ name: 'Setup solution', status: 'completed' }] }), null);
  assert.equal(computeNextStep({ steps: [] }), null);
  assert.equal(computeNextStep({}), null);
  assert.equal(computeNextStep(null), null);
});

test('refresh: surfaces nextStep in its return value after a phase refresh', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    steps: [
      { name: 'Setup solution', status: 'pending' },
      { name: 'Setup pipeline', status: 'pending' },
      { name: 'Deploy via pipeline to Staging', status: 'pending' },
    ],
  });
  // setup-solution refresh flips "Setup solution" → completed, so nextStep is Setup pipeline.
  const result = refresh({ projectRoot: root, phase: 'setup-solution', render: false });
  assert.equal(result.ok, true);
  assert.deepEqual(result.nextStep, { name: 'Setup pipeline', skill: '/power-pages:setup-pipeline' });
});

test('refresh: nextStep is null once the final pending step completes', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    steps: [
      { name: 'Setup solution', status: 'completed' },
      { name: 'Setup pipeline', status: 'pending' },
    ],
  });
  const result = refresh({ projectRoot: root, phase: 'setup-pipeline', render: false });
  assert.equal(result.ok, true);
  assert.equal(result.nextStep, null, 'all steps complete → nextStep null');
});

// --- reconcile (the enforcement backstop / auto-heal) ------------------------

// Backdate the plan file so a just-written marker is unambiguously "newer".
function backdatePlan(root, secondsAgo = 60) {
  const p = path.join(root, 'docs', '.alm-plan-data.json');
  const t = (Date.now() - secondsAgo * 1000) / 1000;
  fs.utimesSync(p, t, t);
}

test('reconcile: heals a skipped refresh — a newer last-deploy.json is ingested', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'T', pipelineMeta: { lastDeploy: null }, steps: [{ name: 'Deploy via pipeline to Staging', status: 'pending' }],
    stages: [{ label: 'Staging', envUrl: 'https://stg.crm.dynamics.com/', type: 'target' }],
  });
  // Marker written AFTER the plan (skill ran but its refresh step was skipped).
  writeJson(path.join(root, 'docs', 'alm', 'last-deploy.json'), {
    stageRunId: 'sr1', stageName: 'Staging', status: 'Succeeded', deployedAt: '2026-06-16T00:00:00.000Z',
    artifactVersion: '1.0.0.2', componentCount: 118,
  });
  backdatePlan(root);

  const result = reconcile({ projectRoot: root, render: false });
  assert.equal(result.ok, true);
  assert.deepEqual(result.reconciled, ['deploy-pipeline']);
  // failed[] is part of the contract — empty when every phase heals cleanly.
  assert.deepEqual(result.failed, []);
  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.equal(planData.pipelineMeta.lastDeploy.status, 'Succeeded');
  assert.equal(planData.pipelineMeta.lastDeploy.componentCount, 118);
});

test('reconcile: failed[] and nextStep are present on EVERY return path (stable contract)', (t) => {
  // Contract guard (Copilot review on #191): a phase whose refresh throws must NOT
  // be swallowed silently — it lands in result.failed = [{ phase, error }] while the
  // other phases still heal, and BOTH failed[] and nextStep are present on the
  // no-op / deferred / no-plan paths too so callers never special-case a missing
  // property. (A phase only throws on a genuine marker-schema break — readJson is
  // defensive — so we assert the contract shape rather than fabricate a throw.)
  const noPlan = reconcile({ projectRoot: makeProject(t), render: false });
  assert.ok(Array.isArray(noPlan.failed), 'no-plan path carries failed:[]');
  assert.ok('nextStep' in noPlan && noPlan.nextStep === null, 'no-plan path carries nextStep:null');

  const deferredRoot = makeProject(t);
  writeJson(path.join(deferredRoot, 'docs', '.alm-plan-data.json'), { SITE_NAME: 'T' });
  fs.writeFileSync(path.join(deferredRoot, '.alm-deferred'), 'deferred');
  const deferred = reconcile({ projectRoot: deferredRoot, render: false });
  assert.deepEqual(deferred.failed, [], 'deferred path carries failed:[]');
  assert.ok('nextStep' in deferred && deferred.nextStep === null, 'deferred path carries nextStep:null');

  // Nothing-pending but the plan still has an unfinished step -> reconcile must
  // compute and return that step (not omit nextStep just because no heal ran).
  const idleRoot = makeProject(t);
  writeJson(path.join(idleRoot, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'T',
    steps: [
      { name: 'Setup solution', status: 'completed' },
      { name: 'Setup pipeline', status: 'pending' },
    ],
  });
  const future = (Date.now() + 60 * 1000) / 1000;
  fs.utimesSync(path.join(idleRoot, 'docs', '.alm-plan-data.json'), future, future);
  const idle = reconcile({ projectRoot: idleRoot, render: false });
  assert.deepEqual(idle.failed, [], 'nothing-pending path carries failed:[]');
  assert.deepEqual(idle.nextStep, { name: 'Setup pipeline', skill: '/power-pages:setup-pipeline' },
    'nothing-pending path still surfaces the next unfinished step');
});

test('reconcile: idempotent no-op when the plan already reflects the markers', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', 'alm', 'last-deploy.json'), { stageName: 'Staging', status: 'Succeeded' });
  // Plan written AFTER the marker -> already reflected -> nothing pending.
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), { SITE_NAME: 'T' });
  const future = (Date.now() + 60 * 1000) / 1000;
  fs.utimesSync(path.join(root, 'docs', '.alm-plan-data.json'), future, future);

  const result = reconcile({ projectRoot: root, render: false });
  assert.deepEqual(result.reconciled, []);
});

test('reconcile: host-only phase when only last-host-check.json is pending (no pipeline yet)', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'T',
    hostResolution: { status: 'NoHost', hostEnvUrl: null },
    pipelineMeta: null,
    steps: [{ name: 'Setup pipeline', status: 'pending' }],
  });
  writeJson(path.join(root, 'docs', 'alm', 'last-host-check.json'), {
    resolutionStatus: 'AvailableUsingCustomHost',
    finalHostEnvUrl: 'https://host.crm.dynamics.com/',
    hostType: 'custom',
  });
  backdatePlan(root);

  const result = reconcile({ projectRoot: root, render: false });
  assert.deepEqual(result.reconciled, ['ensure-pipelines-host']);
  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.equal(planData.hostResolution.status, 'AvailableUsingCustomHost');
  assert.equal(planData.hostResolution.hostEnvUrl, 'https://host.crm.dynamics.com/');
  assert.equal(planData.pipelineMeta, null, 'host-only phase must NOT fabricate pipelineMeta');
  assert.equal(planData.steps[0].status, 'pending', 'host-only phase must NOT flip the Setup pipeline step');
});

test('reconcile: a pending last-pipeline.json supersedes the host-only phase', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), { SITE_NAME: 'T', steps: [{ name: 'Setup pipeline', status: 'pending' }] });
  writeJson(path.join(root, 'docs', 'alm', 'last-host-check.json'), { resolutionStatus: 'AvailableUsingCustomHost', finalHostEnvUrl: 'https://h/' });
  writeJson(path.join(root, 'docs', 'alm', 'last-pipeline.json'), { pipelineId: 'p1', pipelineName: 'My Pipeline', stages: [] });
  backdatePlan(root);

  const result = reconcile({ projectRoot: root, render: false });
  assert.ok(result.reconciled.includes('setup-pipeline'));
  assert.ok(!result.reconciled.includes('ensure-pipelines-host'), 'setup-pipeline covers the host — no redundant host-only phase');
});

test('reconcile: honors the .alm-deferred opt-out (no-op)', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), { SITE_NAME: 'T' });
  writeJson(path.join(root, 'docs', 'alm', 'last-deploy.json'), { stageName: 'Staging', status: 'Succeeded' });
  fs.writeFileSync(path.join(root, '.alm-deferred'), 'ni-dev — handled separately');
  backdatePlan(root);

  const result = reconcile({ projectRoot: root, render: false });
  assert.equal(result.reconciled.length, 0);
  assert.equal(result.reason, 'deferred');
});

test('reconcile: soft no-op when there is no plan', (t) => {
  const root = makeProject(t);
  const result = reconcile({ projectRoot: root, render: false });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-plan');
});
