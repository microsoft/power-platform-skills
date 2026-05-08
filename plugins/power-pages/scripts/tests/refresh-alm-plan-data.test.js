'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  refresh,
  buildHostResolutionFromCheck,
  dropResolvedRisks,
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
  // a present-but-empty .last-host-check.json is treated as "we attempted detection
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

test('refresh setup-pipeline rewrites hostResolution from .last-host-check.json + drops NoHost warning', (t) => {
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
  writeJson(path.join(root, '.last-host-check.json'), {
    schemaVersion: 2,
    resolutionStatus: 'AvailableUsingCustomHost',
    finalHostEnvUrl: 'https://newhost.crm.dynamics.com/',
    finalHostEnvId: '9eaa1234-aaaa-bbbb-cccc-000000000000',
    hostType: 'custom',
    pipelinesSolutionVersion: '9.1.0.0',
    actionTaken: 'fast-path-custom-d365projecthost',
  });
  writeJson(path.join(root, '.last-pipeline.json'), {
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

test('refresh deploy-pipeline writes pipelineMeta.lastDeploy from .last-deploy.json', (t) => {
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
  writeJson(path.join(root, '.last-deploy.json'), {
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

test('refresh test-site populates validationRuns[stage] from .last-test-site.json', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'TestSite',
    validationRuns: { Staging: null },
  });
  writeJson(path.join(root, '.last-test-site.json'), {
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

test('refresh test-site is a no-op when stageName is omitted', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    validationRuns: { Staging: null },
  });
  writeJson(path.join(root, '.last-test-site.json'), { runOutcome: 'passed' });

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

test('refresh setup-pipeline preserves prior pipelineMeta.reusedByWiring annotation', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    pipelineMeta: {
      reusedByWiring: { originalName: 'Existing Pipeline', requestedName: 'NewName' },
    },
  });
  writeJson(path.join(root, '.last-pipeline.json'), {
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

test('refresh export-solution accepts the phase and returns ok:true', (t) => {
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
  // Passthrough handler — planData should round-trip unchanged.
  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.equal(planData.STRATEGY, 'manual');
  assert.equal(planData.steps[1].status, 'in_progress',
    'agent-set step status must round-trip through the passthrough handler');
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
