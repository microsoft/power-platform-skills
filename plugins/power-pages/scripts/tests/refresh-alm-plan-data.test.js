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
