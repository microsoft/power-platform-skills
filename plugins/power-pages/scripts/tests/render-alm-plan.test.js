const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Tests for render-alm-plan.js (CLI-only — no exported functions).
// The script is spawned as a child process; file I/O uses real temp directories.

const SCRIPT = path.resolve(
  __dirname,
  '../../skills/plan-alm/scripts/render-alm-plan.js'
);

// ── Minimal valid data for the template ───────────────────────────────────────

function makeValidData(overrides = {}) {
  return {
    SITE_NAME: 'TestSite',
    GENERATED_AT: '2026-04-06T00:00:00.000Z',
    STRATEGY: 'pp-pipelines',
    EXPORT_TYPE: 'managed',
    APPROVAL_MODE: 'Required before each deployment',
    GIT_STATUS: 'yes',
    HAS_ENV_VARS: false,
    PLAN_STATUS: 'Draft',
    APPROVED_BY: '',
    APPROVAL_DATE: '',
    stages: [
      { label: 'Dev', type: 'source', envUrl: 'https://dev.crm.dynamics.com', approval: false },
      { label: 'Staging', type: 'target', envUrl: 'https://staging.crm.dynamics.com', approval: true },
      { label: 'Production', type: 'target', envUrl: 'https://prod.crm.dynamics.com', approval: true },
    ],
    steps: [
      { name: 'Setup Solution', status: 'completed' },
      { name: 'Setup Pipeline', status: 'pending' },
    ],
    risks: [
      { type: 'warning', message: 'No Git versioning detected — changes will not be tracked.' },
    ],
    ...overrides,
  };
}

/**
 * Runs render-alm-plan.js with the given args.
 * Writes the data JSON to a temp file, then spawns the script.
 * Returns { status, stdout, stderr, outputPath }.
 */
function runScript(data, outputPath) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-alm-test-'));
  const dataPath = path.join(tmpDir, 'data.json');
  fs.writeFileSync(dataPath, JSON.stringify(data), 'utf8');

  const result = spawnSync(
    process.execPath,
    [SCRIPT, '--output', outputPath, '--data', dataPath],
    { encoding: 'utf8', timeout: 10000 }
  );

  // Cleanup data file (not the output — caller may need it)
  fs.rmSync(tmpDir, { recursive: true, force: true });

  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

// ── Test 1: Successful render — file written, stdout is JSON { status: 'ok' } ─

test('render-alm-plan: renders output file and prints { status: ok } on success', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-alm-out-'));
  const outputPath = path.join(tmpDir, 'alm-plan.html');

  try {
    const { status, stdout } = runScript(makeValidData(), outputPath);

    assert.equal(status, 0, `Expected exit 0 but got ${status}`);
    assert.ok(fs.existsSync(outputPath), 'Output file should exist');
    assert.ok(fs.statSync(outputPath).size > 500, 'Output file should be > 500 bytes');

    const result = JSON.parse(stdout.trim());
    assert.equal(result.status, 'ok');
    assert.equal(result.output, outputPath);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Test 2: SITE_NAME appears in output ───────────────────────────────────────

test('render-alm-plan: replaces __SITE_NAME__ token with the provided site name', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-alm-out-'));
  const outputPath = path.join(tmpDir, 'alm-plan.html');

  try {
    const { status } = runScript(makeValidData({ SITE_NAME: 'IdeaSphere' }), outputPath);
    assert.equal(status, 0, 'Expected exit 0');

    const html = fs.readFileSync(outputPath, 'utf8');
    assert.ok(html.includes('IdeaSphere'), 'Output HTML should contain SITE_NAME "IdeaSphere"');
    assert.ok(!html.includes('__SITE_NAME__'), 'Output HTML should not contain unreplaced __SITE_NAME__');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Test 3: STRATEGY drives strategy label ─────────────────────────────────────

test('render-alm-plan: pp-pipelines strategy produces "Power Platform Pipelines" label', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-alm-out-'));
  const outputPath = path.join(tmpDir, 'alm-plan.html');

  try {
    const { status } = runScript(makeValidData({ STRATEGY: 'pp-pipelines' }), outputPath);
    assert.equal(status, 0, 'Expected exit 0');

    const html = fs.readFileSync(outputPath, 'utf8');
    assert.ok(
      html.includes('Power Platform Pipelines'),
      'Should show "Power Platform Pipelines" for pp-pipelines strategy'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('render-alm-plan: manual strategy produces "Manual Export / Import" label', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-alm-out-'));
  const outputPath = path.join(tmpDir, 'alm-plan.html');

  try {
    const { status } = runScript(makeValidData({ STRATEGY: 'manual' }), outputPath);
    assert.equal(status, 0, 'Expected exit 0');

    const html = fs.readFileSync(outputPath, 'utf8');
    assert.ok(
      html.includes('Manual Export / Import'),
      'Should show "Manual Export / Import" for manual strategy'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Test 4: Stage boxes rendered in output ────────────────────────────────────

test('render-alm-plan: stage labels appear in the rendered HTML', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-alm-out-'));
  const outputPath = path.join(tmpDir, 'alm-plan.html');

  const stages = [
    { label: 'Development', type: 'source', envUrl: 'https://dev.crm.dynamics.com', approval: false },
    { label: 'UAT', type: 'target', envUrl: 'https://uat.crm.dynamics.com', approval: true },
  ];

  try {
    const { status } = runScript(makeValidData({ stages }), outputPath);
    assert.equal(status, 0, 'Expected exit 0');

    const html = fs.readFileSync(outputPath, 'utf8');
    assert.ok(html.includes('Development'), 'HTML should contain stage label "Development"');
    assert.ok(html.includes('UAT'), 'HTML should contain stage label "UAT"');
    assert.ok(html.includes('https://dev.crm.dynamics.com'), 'HTML should contain dev env URL');
    assert.ok(html.includes('Approval gate'), 'HTML should contain approval gate badge for UAT');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Test 5: Checklist steps rendered ──────────────────────────────────────────

test('render-alm-plan: checklist step names appear in the rendered HTML', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-alm-out-'));
  const outputPath = path.join(tmpDir, 'alm-plan.html');

  const steps = [
    { name: 'Setup Solution', status: 'completed' },
    { name: 'Deploy to Staging', status: 'pending' },
  ];

  try {
    const { status } = runScript(makeValidData({ steps }), outputPath);
    assert.equal(status, 0, 'Expected exit 0');

    const html = fs.readFileSync(outputPath, 'utf8');
    assert.ok(html.includes('Setup Solution'), 'HTML should contain step name "Setup Solution"');
    assert.ok(html.includes('Deploy to Staging'), 'HTML should contain step name "Deploy to Staging"');
    // Status badge for "completed" should appear
    assert.ok(html.includes('status-completed'), 'HTML should include status-completed class');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Test 6: Risk messages rendered ────────────────────────────────────────────

test('render-alm-plan: risk messages appear in the rendered HTML', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-alm-out-'));
  const outputPath = path.join(tmpDir, 'alm-plan.html');

  const risks = [
    { type: 'warning', message: 'No source control configured — enable Git before production.' },
    { type: 'info', message: 'Connection references require manual mapping after import.' },
  ];

  try {
    const { status } = runScript(makeValidData({ risks }), outputPath);
    assert.equal(status, 0, 'Expected exit 0');

    const html = fs.readFileSync(outputPath, 'utf8');
    assert.ok(
      html.includes('No source control configured'),
      'HTML should include first risk message'
    );
    assert.ok(
      html.includes('Connection references require manual mapping'),
      'HTML should include second risk message'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Test 7: HAS_ENV_VARS drives env var note ──────────────────────────────────

test('render-alm-plan: HAS_ENV_VARS true produces env var warning note', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-alm-out-'));
  const outputPath = path.join(tmpDir, 'alm-plan.html');

  try {
    const { status } = runScript(makeValidData({ HAS_ENV_VARS: true }), outputPath);
    assert.equal(status, 0, 'Expected exit 0');

    const html = fs.readFileSync(outputPath, 'utf8');
    assert.ok(
      html.includes('environment variables'),
      'Should mention environment variables when HAS_ENV_VARS is true'
    );
    // Should use warning class
    assert.ok(html.includes('note-box warning'), 'Should use warning note box class');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Test 8: Exits non-zero when required keys are missing ─────────────────────

test('render-alm-plan: exits non-zero when required keys are missing from data', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-alm-out-'));
  const outputPath = path.join(tmpDir, 'alm-plan.html');

  // Omit SITE_NAME which is required
  const incompleteData = makeValidData();
  delete incompleteData.SITE_NAME;

  try {
    const { status, stderr } = runScript(incompleteData, outputPath);
    assert.notEqual(status, 0, 'Expected non-zero exit when required key is missing');
    assert.ok(stderr.includes('SITE_NAME'), 'stderr should mention the missing key');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Test 8b: solutionContents null → fallback note ────────────────────────────

test('render-alm-plan: solutionContents absent renders fallback note', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-alm-out-'));
  const outputPath = path.join(tmpDir, 'alm-plan.html');

  try {
    // solutionContents not provided — should render gracefully
    const { status } = runScript(makeValidData(), outputPath);
    assert.equal(status, 0, 'Expected exit 0 even when solutionContents is absent');

    const html = fs.readFileSync(outputPath, 'utf8');
    assert.ok(
      html.includes('Setup Solution'),
      'Fallback note should mention Setup Solution step'
    );
    assert.ok(!html.includes('__SOLUTION_CONTENTS__'), 'Placeholder should be replaced');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Test 8c: solutionContents with data renders tables and site settings ──────

test('render-alm-plan: solutionContents with data renders tables, promote table, excluded note', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-alm-out-'));
  const outputPath = path.join(tmpDir, 'alm-plan.html');

  const solutionContents = {
    tables: ['crd50_invoice', 'crd50_order'],
    botComponents: [{ name: 'Bot Consumer' }],
    siteSettings: {
      keepAsIs: [{ name: 'Search/Enabled' }],
      promoteToEnvVar: [{ name: 'Feature/EnablePortal', value: 'true' }],
      excluded: [{ name: 'Authentication/OpenAuth/ClientId' }],
    },
  };

  try {
    const { status } = runScript(makeValidData({ solutionContents }), outputPath);
    assert.equal(status, 0, 'Expected exit 0');

    const html = fs.readFileSync(outputPath, 'utf8');
    assert.ok(html.includes('crd50_invoice'), 'HTML should show table name');
    assert.ok(html.includes('Bot Consumer'), 'HTML should show bot component name');
    assert.ok(html.includes('Feature/EnablePortal'), 'HTML should show promote-to-env-var setting');
    assert.ok(html.includes('credential secret(s) excluded'), 'HTML should show excluded secrets note');
    assert.ok(html.includes('Review for Env Var Promotion'), 'HTML should show promotion table heading');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Test 8d: solutionContents with authNoValue renders warning table ───────────

test('render-alm-plan: solutionContents authNoValue renders warning note with setting names', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-alm-out-'));
  const outputPath = path.join(tmpDir, 'alm-plan.html');

  const solutionContents = {
    tables: [],
    botComponents: [],
    siteSettings: {
      keepAsIs: [{ name: 'Search/Enabled' }],
      promoteToEnvVar: [],
      authNoValue: [
        'Authentication/OpenAuth/Twitter/ConsumerKey',
        'AzureAD/LoginNonce',
      ],
      excluded: [],
    },
  };

  try {
    const { status } = runScript(makeValidData({ solutionContents }), outputPath);
    assert.equal(status, 0, 'Expected exit 0');

    const html = fs.readFileSync(outputPath, 'utf8');
    assert.ok(
      html.includes('Auth settings included without a dev value'),
      'HTML should show auth-no-value warning heading'
    );
    assert.ok(
      html.includes('Authentication/OpenAuth/Twitter/ConsumerKey'),
      'HTML should show first authNoValue setting name'
    );
    assert.ok(
      html.includes('AzureAD/LoginNonce'),
      'HTML should show second authNoValue setting name'
    );
    assert.ok(
      html.includes('No value configured in dev'),
      'HTML should explain why auth setting has no value'
    );
    // Summary counts: 1 keepAsIs, 0 promoteToEnvVar, 2 authNoValue, 0 excluded
    assert.ok(
      html.includes('2 auth settings without dev values'),
      'Summary should show count of authNoValue settings'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Test 9: Exits non-zero when --output or --data args are missing ───────────

test('render-alm-plan: exits non-zero when --output arg is not provided', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-alm-arg-'));
  const dataPath = path.join(tmpDir, 'data.json');
  fs.writeFileSync(dataPath, JSON.stringify(makeValidData()), 'utf8');

  try {
    const result = spawnSync(
      process.execPath,
      [SCRIPT, '--data', dataPath],  // intentionally omit --output
      { encoding: 'utf8', timeout: 10000 }
    );
    assert.notEqual(result.status, 0, 'Expected non-zero exit when --output is missing');
    assert.ok(
      (result.stderr || '').includes('Usage'),
      'stderr should show usage when --output is absent'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Test 10: plan-status CSS class injected ───────────────────────────────────

test('render-alm-plan: PLAN_STATUS value drives CSS class on plan-status span', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-alm-out-'));
  const outputPath = path.join(tmpDir, 'alm-plan.html');

  try {
    const { status } = runScript(makeValidData({ PLAN_STATUS: 'Approved' }), outputPath);
    assert.equal(status, 0, 'Expected exit 0');

    const html = fs.readFileSync(outputPath, 'utf8');
    // The script injects the lowercased PLAN_STATUS as an additional CSS class
    assert.ok(
      html.includes('class="plan-status approved"') || html.includes('plan-status approved'),
      'HTML should include plan-status CSS class "approved"'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Test 11: Solutions tab surfaces an Asset Advisory callout when the
//             primary recommendation is externalize-media ───────────────────

test('render-alm-plan: Solutions tab shows a callout + link to Asset Advisory when recommendation is externalize-media', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-alm-out-'));
  const outputPath = path.join(tmpDir, 'alm-plan.html');

  try {
    const data = makeValidData({
      // Non-trivial proposedSolutions so buildSolutionsHtml exercises the card path
      // and prefixes the callout. Without solutions the "(None)" note-box is rendered.
      proposedSolutions: [
        { uniqueName: 'Site_Core', displayName: 'Core', order: 1, sizeMB: 45, componentCount: 200, componentTypes: ['Web Page'] },
        { uniqueName: 'Site_Web', displayName: 'Web Assets', order: 2, sizeMB: 90, componentCount: 150, componentTypes: ['Web File'] },
      ],
      assetAdvisory: {
        enabled: true,
        recommendation: 'externalize-media',
        candidates: [
          { name: 'hero.jpg', sizeMB: 5.2, rationale: 'Large media asset', recommendation: 'azure-blob', suggestedUrlFormat: '' },
          { name: 'bg.png', sizeMB: 3.8, rationale: 'Large media asset', recommendation: 'cdn', suggestedUrlFormat: '' },
        ],
      },
    });
    const { status } = runScript(data, outputPath);
    assert.equal(status, 0, 'Expected exit 0');

    const html = fs.readFileSync(outputPath, 'utf8');

    // Callout text itself
    assert.ok(html.includes('A split may not be necessary.'),
      'Solutions tab should include the externalize callout headline');

    // Aggregate size from candidates (5.2 + 3.8 = 9.0)
    assert.ok(html.includes('9.0 MB'),
      'Callout should show aggregate MB from candidates');

    // Link to the Asset Advisory tab — verify the target tab exists and
    // the callout references it by the existing data-tab value.
    assert.ok(html.includes('data-tab="advisory"'),
      'Advisory tab button must still exist');
    assert.ok(html.includes('solutions-to-advisory'),
      'Callout should use the dedicated class so the interaction is testable');

    // The callout must appear inside the Solutions tab section and before the
    // next tab opens (Pipelines). Template order is: Advisory → EnvVars →
    // Solutions → Pipelines, so the callout sits between `tab-solutions` and
    // `tab-pipelines` markers.
    const solIdx = html.indexOf('id="tab-solutions"');
    const pipeIdx = html.indexOf('id="tab-pipelines"');
    const calloutIdx = html.indexOf('A split may not be necessary.');
    assert.ok(solIdx !== -1 && pipeIdx !== -1 && calloutIdx !== -1, 'All markers present');
    assert.ok(calloutIdx > solIdx, 'Callout should appear after the Solutions tab opens');
    assert.ok(calloutIdx < pipeIdx, 'Callout should appear before the Pipelines tab (i.e., within Solutions)');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('render-alm-plan: Solutions tab has NO callout when recommendation is not externalize-media', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-alm-out-'));
  const outputPath = path.join(tmpDir, 'alm-plan.html');

  try {
    const data = makeValidData({
      proposedSolutions: [
        { uniqueName: 'Site_Core', displayName: 'Core', order: 1, sizeMB: 45, componentCount: 200, componentTypes: ['Web Page'] },
      ],
      assetAdvisory: {
        enabled: true,
        recommendation: null, // nothing flagged
        candidates: [],
      },
    });
    const { status } = runScript(data, outputPath);
    assert.equal(status, 0);
    const html = fs.readFileSync(outputPath, 'utf8');
    assert.ok(!html.includes('A split may not be necessary.'),
      'No callout when externalize is not recommended');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('render-alm-plan: Solutions tab has NO callout when asset advisory is disabled', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-alm-out-'));
  const outputPath = path.join(tmpDir, 'alm-plan.html');

  try {
    const data = makeValidData({
      proposedSolutions: [
        { uniqueName: 'Site_Core', displayName: 'Core', order: 1, sizeMB: 45, componentCount: 200, componentTypes: ['Web Page'] },
      ],
      assetAdvisory: { enabled: false, recommendation: 'externalize-media', candidates: [] },
    });
    const { status } = runScript(data, outputPath);
    assert.equal(status, 0);
    const html = fs.readFileSync(outputPath, 'utf8');
    assert.ok(!html.includes('A split may not be necessary.'),
      'Disabled advisory must not surface the callout');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Test 12: Pipelines tab shows ONE pipeline + multiple runs in multi-solution plans

test('render-alm-plan: multi-solution Pipelines tab shows a single pipeline with N runs (not N pipelines)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-alm-out-'));
  const outputPath = path.join(tmpDir, 'alm-plan.html');

  try {
    const data = makeValidData({
      SITE_NAME: 'IdeaSphere',
      proposedSolutions: [
        { uniqueName: 'IdeaSphere_Core', displayName: 'Core', order: 1, sizeMB: 45, componentCount: 200, componentTypes: ['Web Page'] },
        { uniqueName: 'IdeaSphere_WebAssets', displayName: 'Web Assets', order: 2, sizeMB: 90, componentCount: 150, componentTypes: ['Web File'] },
        { uniqueName: 'IdeaSphere_Future', displayName: 'Future Growth', order: 3, sizeMB: 0, componentCount: 0, componentTypes: ['Any'], isFutureBuffer: true },
      ],
    });
    const { status } = runScript(data, outputPath);
    assert.equal(status, 0);
    const html = fs.readFileSync(outputPath, 'utf8');

    // Single pipeline header, not one per solution.
    assert.ok(html.includes('IdeaSphere-Pipeline'),
      'Should show a single pipeline named after the site');
    assert.ok(!html.includes('IdeaSphere_Core-Pipeline'),
      'Old per-solution pipeline name should NOT appear');
    assert.ok(!html.includes('IdeaSphere_WebAssets-Pipeline'),
      'Old per-solution pipeline name should NOT appear');

    // Tab title should not say "Deployment Pipelines (N)".
    assert.ok(!/Deployment Pipelines \(\d+\)/.test(html),
      'Tab title should say "Deployment Pipeline" (singular) now');

    // "Deployment order" block lists solutions.
    assert.ok(html.includes('Deployment order'),
      'Should show a Deployment order block');
    assert.ok(html.includes('IdeaSphere_Core'),
      'Solution names still surface per run');
    assert.ok(html.includes('IdeaSphere_WebAssets'));

    // Future buffer is labeled as skipped, not as "Run 3".
    assert.ok(html.includes('Skipped (empty)'),
      'Future buffer should show "Skipped (empty)" label');

    // Descriptor text reflects 1 pipeline.
    assert.ok(html.includes('One Power Platform Pipeline runs 2 solutions'),
      'Description should state 1 pipeline running 2 deployable solutions');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('render-alm-plan: single-solution Pipelines tab keeps simple stage flow', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-alm-out-'));
  const outputPath = path.join(tmpDir, 'alm-plan.html');

  try {
    const data = makeValidData({
      proposedSolutions: [
        { uniqueName: 'SiteSolution', displayName: 'Site', order: 1, sizeMB: 30, componentCount: 80, componentTypes: ['All'] },
      ],
    });
    const { status } = runScript(data, outputPath);
    assert.equal(status, 0);
    const html = fs.readFileSync(outputPath, 'utf8');
    // Single-solution path should NOT include the "Deployment order" subheading.
    assert.ok(!html.includes('Deployment order'),
      'Single-solution plan should not show a per-run list');
    assert.ok(!html.includes('Skipped (empty)'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Tests 13: hostResolution → "Pipelines Host" card on the Pipeline tab ──────

test('render-alm-plan: hostResolution AvailableUsingCustomHost renders host-card-ok with URL + version', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-alm-out-'));
  const outputPath = path.join(tmpDir, 'alm-plan.html');

  try {
    const data = makeValidData({
      hostResolution: {
        status: 'AvailableUsingCustomHost',
        hostEnvUrl: 'https://pascalepipelineshost.crm.dynamics.com',
        hostEnvId: '0817fd3d-a664-e99a-a758-dd9dc03ceb01',
        hostType: 'custom',
        pipelinesSolutionVersion: '9.2.3.4',
        candidatesCount: 0,
        willEnsureDuringExecution: false,
        willProvisionCustom: false,
        userChoseDeferToSetupPipeline: false,
      },
    });
    const { status } = runScript(data, outputPath);
    assert.equal(status, 0);
    const html = fs.readFileSync(outputPath, 'utf8');

    // The actual rendered card uses class="card host-card host-card-ok" — search
    // for the full attribute string so we don't false-match the CSS rules in <head>.
    assert.ok(html.includes('class="card host-card host-card-ok"'),
      'Host card element should carry the host-card-ok modifier class');
    assert.ok(html.includes('pascalepipelineshost.crm.dynamics.com'),
      'Host URL should appear in the card');
    assert.ok(html.includes('Pipelines v9.2.3.4'),
      'Pipelines solution version should be rendered');
    assert.ok(html.includes('Reachable'),
      'Card meta should indicate the host is reachable');
    // Card belongs to the Pipeline tab (between tab-pipelines opener and tab-checklist).
    const pipeIdx = html.indexOf('id="tab-pipelines"');
    const checkIdx = html.indexOf('id="tab-checklist"');
    const cardIdx = html.indexOf('class="card host-card host-card-ok"');
    assert.ok(pipeIdx !== -1 && checkIdx !== -1 && cardIdx !== -1, 'All markers present');
    assert.ok(cardIdx > pipeIdx && cardIdx < checkIdx,
      'Host card should sit inside the Pipelines tab');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('render-alm-plan: hostResolution willEnsureDuringExecution renders host-card-pending with status-specific note', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-alm-out-'));
  const outputPath = path.join(tmpDir, 'alm-plan.html');

  try {
    const data = makeValidData({
      hostResolution: {
        status: 'NoHost',
        hostEnvUrl: null,
        hostEnvId: null,
        hostType: null,
        pipelinesSolutionVersion: null,
        candidatesCount: 0,
        willEnsureDuringExecution: true,
        willProvisionCustom: true,
        userChoseDeferToSetupPipeline: false,
      },
    });
    const { status } = runScript(data, outputPath);
    assert.equal(status, 0);
    const html = fs.readFileSync(outputPath, 'utf8');

    assert.ok(html.includes('class="card host-card host-card-pending"'),
      'Host card element should carry the host-card-pending modifier class');
    assert.ok(html.includes('Will be ensured during setup-pipeline'),
      'Card value should advertise the deferred ensure');
    assert.ok(html.includes('D365_ProjectHost'),
      'NoHost note should reference the D365_ProjectHost template');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('render-alm-plan: hostResolution MultipleUnboundCustomHosts uses candidatesCount in pending note', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-alm-out-'));
  const outputPath = path.join(tmpDir, 'alm-plan.html');

  try {
    const data = makeValidData({
      hostResolution: {
        status: 'MultipleUnboundCustomHosts',
        hostEnvUrl: null,
        hostEnvId: null,
        hostType: null,
        pipelinesSolutionVersion: null,
        candidatesCount: 3,
        willEnsureDuringExecution: true,
        willProvisionCustom: false,
        userChoseDeferToSetupPipeline: true,
      },
    });
    const { status } = runScript(data, outputPath);
    assert.equal(status, 0);
    const html = fs.readFileSync(outputPath, 'utf8');

    assert.ok(html.includes('class="card host-card host-card-pending"'));
    assert.ok(html.includes('Will pick from 3 existing Custom Hosts'),
      'Pending note should reference candidatesCount');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('render-alm-plan: hostResolution CannotRedirect renders host-card-blocked', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-alm-out-'));
  const outputPath = path.join(tmpDir, 'alm-plan.html');

  try {
    const data = makeValidData({
      hostResolution: {
        status: 'CannotRedirect',
        hostEnvUrl: null,
        hostEnvId: null,
        hostType: null,
        pipelinesSolutionVersion: null,
        candidatesCount: 0,
        willEnsureDuringExecution: false,
        willProvisionCustom: false,
        userChoseDeferToSetupPipeline: false,
      },
    });
    const { status } = runScript(data, outputPath);
    assert.equal(status, 0);
    const html = fs.readFileSync(outputPath, 'utf8');

    assert.ok(html.includes('class="card host-card host-card-blocked"'),
      'Host card element should carry the host-card-blocked modifier class');
    assert.ok(html.includes('CannotRedirect'),
      'Card should call out the CannotRedirect status');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('render-alm-plan: hostResolution absent → no Pipelines Host card and no host-checklist substep', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-alm-out-'));
  const outputPath = path.join(tmpDir, 'alm-plan.html');

  try {
    // No hostResolution provided (Manual path or pre-update plans).
    const { status } = runScript(makeValidData(), outputPath);
    assert.equal(status, 0);
    const html = fs.readFileSync(outputPath, 'utf8');

    // Check for the rendered card element (full class attribute) rather than
    // the bare modifier names, which also appear in the embedded CSS rules.
    assert.ok(!html.includes('class="card host-card host-card-ok"'),
      'host-card-ok element should be omitted when hostResolution is absent');
    assert.ok(!html.includes('class="card host-card host-card-pending"'),
      'host-card-pending element should be omitted when hostResolution is absent');
    assert.ok(!html.includes('class="card host-card host-card-blocked"'),
      'host-card-blocked element should be omitted when hostResolution is absent');
    assert.ok(!html.includes('check-ensure-host'),
      'Host substep should be omitted when hostResolution is absent');
    // Placeholders must still be substituted to empty (no leaked tokens).
    assert.ok(!html.includes('__PIPELINES_HOST_CARD__'),
      'Host card placeholder should be replaced (with empty)');
    assert.ok(!html.includes('__HOST_CHECKLIST_SUBSTEP__'),
      'Host substep placeholder should be replaced (with empty)');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Tests 14: hostResolution → checklist substep on the Execution tab ─────────

test('render-alm-plan: hostResolution willEnsureDuringExecution renders checklist substep on the Execution tab', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-alm-out-'));
  const outputPath = path.join(tmpDir, 'alm-plan.html');

  try {
    const data = makeValidData({
      hostResolution: {
        status: 'AvailableUnboundCustomHost',
        hostEnvUrl: 'https://pascalepipelineshost.crm.dynamics.com',
        hostEnvId: '0817fd3d-a664-e99a-a758-dd9dc03ceb01',
        hostType: 'custom',
        pipelinesSolutionVersion: '9.2.3.4',
        candidatesCount: 1,
        willEnsureDuringExecution: true,
        willProvisionCustom: false,
        userChoseDeferToSetupPipeline: false,
      },
    });
    const { status } = runScript(data, outputPath);
    assert.equal(status, 0);
    const html = fs.readFileSync(outputPath, 'utf8');

    assert.ok(html.includes('check-ensure-host'),
      'Substep should expose the ensure-host id for inspection');
    assert.ok(html.includes('Ensure Pipelines host'),
      'Substep should be labelled "Ensure Pipelines host"');
    assert.ok(html.includes('delegated by setup-pipeline'),
      'Substep note should make the delegation explicit');
    // Substep belongs in the Execution Checklist tab.
    const checkIdx = html.indexOf('id="tab-checklist"');
    const subIdx = html.indexOf('check-ensure-host');
    assert.ok(checkIdx !== -1 && subIdx !== -1 && subIdx > checkIdx,
      'Substep must appear inside the Execution Checklist tab');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('render-alm-plan: hostResolution AvailableUsing* (already established) does NOT render the checklist substep', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-alm-out-'));
  const outputPath = path.join(tmpDir, 'alm-plan.html');

  try {
    // willEnsureDuringExecution is false — host already established, no delegation needed.
    const data = makeValidData({
      hostResolution: {
        status: 'AvailableUsingCustomHost',
        hostEnvUrl: 'https://pascalepipelineshost.crm.dynamics.com',
        hostEnvId: '0817fd3d-a664-e99a-a758-dd9dc03ceb01',
        hostType: 'custom',
        pipelinesSolutionVersion: '9.2.3.4',
        candidatesCount: 0,
        willEnsureDuringExecution: false,
        willProvisionCustom: false,
        userChoseDeferToSetupPipeline: false,
      },
    });
    const { status } = runScript(data, outputPath);
    assert.equal(status, 0);
    const html = fs.readFileSync(outputPath, 'utf8');

    assert.ok(!html.includes('check-ensure-host'),
      'Substep must not render when willEnsureDuringExecution is false');
    // The body-level <ul class="checklist-substep-list"> should not be emitted —
    // search for the open tag specifically so we don't false-match the CSS rule
    // ".checklist-substep-list{...}" in the embedded stylesheet.
    assert.ok(!html.includes('<ul class="checklist-substep-list">'),
      'No checklist-substep-list <ul> wrapper when host is already established');
    assert.ok(!html.includes('Ensure Pipelines host'),
      'No "Ensure Pipelines host" label when host is already established');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
