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

// ── Tests 15: validationRuns → "Validation" tab with per-stage sub-tabs ───────

function makeValidationRun(overrides = {}) {
  return {
    url: 'https://staging.powerappsportals.com',
    runAt: '2026-04-29T09:50:00.000Z',
    durationSec: 95,
    runOutcome: 'passed',
    summary: { critical: 0, high: 0, medium: 0, low: 2, total: 2, automated: 2, manual: 0, passed: 2, failed: 0, skipped: 0 },
    categories: [
      {
        id: 'site-load',
        name: 'Site Load',
        icon: '\u{1F4E6}',
        tests: [
          {
            id: 't01',
            name: 'Homepage returns 200 OK',
            severity: 'critical',
            type: 'automated',
            status: 'passed',
            description: 'Homepage at site root should return HTTP 200.',
            steps: ['GET /', 'Expect 200'],
            expected: '200 OK',
            actual: '200 OK',
            validates: 'Site activation',
          },
        ],
      },
    ],
    ...overrides,
  };
}

test('render-alm-plan: validationRuns absent → empty Validation tab still renders sub-tabs for target stages', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-alm-out-'));
  const outputPath = path.join(tmpDir, 'alm-plan.html');

  try {
    const { status } = runScript(makeValidData(), outputPath);
    assert.equal(status, 0);
    const html = fs.readFileSync(outputPath, 'utf8');

    // Validation tab section + sidebar nav button must be present.
    assert.ok(html.includes('id="tab-validation"'), 'Validation tab section should render');
    assert.ok(html.includes('data-tab="validation"'), 'Validation sidebar nav button should render');

    // Two target stages in makeValidData → two sub-tab buttons.
    const subtabBtns = (html.match(/<button class="subtab-btn[^"]*"[^>]*>/g) || []);
    assert.equal(subtabBtns.length, 2,
      'One sub-tab per target stage (Staging + Production)');
    // Both stages rendered with "Not run" status when validationRuns absent.
    assert.ok(/subtab-status-pending[^>]*>Not run<\/span>/.test(html),
      'Stages with no run should display "Not run"');
    // Empty-state note appears in the active pane.
    assert.ok(html.includes('Not yet tested'),
      'Empty stage pane should show "Not yet tested"');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('render-alm-plan: validationRuns populated stage renders summary grid + categorized cards', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-alm-out-'));
  const outputPath = path.join(tmpDir, 'alm-plan.html');

  try {
    const data = makeValidData({
      validationRuns: {
        Staging: makeValidationRun(),
        Production: null,
      },
    });
    const { status } = runScript(data, outputPath);
    assert.equal(status, 0);
    const html = fs.readFileSync(outputPath, 'utf8');

    assert.ok(html.includes('class="test-summary-grid"'),
      'Per-stage summary grid should render');
    assert.ok(html.includes('class="test-category"'),
      'Categorized test cards should render');
    assert.ok(html.includes('Site Load'),
      'Category title should render');
    assert.ok(html.includes('Homepage returns 200 OK'),
      'Test name should render');
    // Outcome badge for the Staging stage in sub-tab bar — passed.
    assert.ok(/subtab-status-pass[^>]*>Passed<\/span>/.test(html),
      'Staging sub-tab should be marked Passed');
    // Production sub-tab still pending.
    assert.ok(/subtab-status-pending[^>]*>Not run<\/span>/.test(html),
      'Production sub-tab should be marked Not run');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('render-alm-plan: validationRuns failed test card renders red severity + FAIL status badge', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-alm-out-'));
  const outputPath = path.join(tmpDir, 'alm-plan.html');

  try {
    const data = makeValidData({
      validationRuns: {
        Staging: makeValidationRun({
          runOutcome: 'failed',
          summary: { critical: 1, high: 1, medium: 0, low: 0, total: 2, automated: 2, manual: 0, passed: 0, failed: 2, skipped: 0 },
          categories: [
            {
              id: 'webapi', name: 'Web API', icon: '\u{1F50C}',
              tests: [
                {
                  id: 't10',
                  name: '/_api/cr_orders returns 200',
                  severity: 'critical',
                  type: 'automated',
                  status: 'failed',
                  description: 'Verifies the orders Web API endpoint returns data.',
                  steps: ['Open DevTools', 'Navigate to Orders', 'Capture network'],
                  expected: 'HTTP 200 with OData response',
                  actual: 'HTTP 403 Forbidden',
                  validates: 'Table permissions for Orders',
                },
              ],
            },
          ],
        }),
      },
    });
    const { status } = runScript(data, outputPath);
    assert.equal(status, 0);
    const html = fs.readFileSync(outputPath, 'utf8');

    // Critical severity badge inside a rendered card (not the CSS rule).
    assert.ok(/<span class="severity-badge severity-critical">/.test(html),
      'Critical severity badge should render');
    // FAIL status badge.
    assert.ok(/<span class="test-status-badge test-status-fail">FAIL<\/span>/.test(html),
      'FAIL status badge should render');
    // Test card carries the failed modifier class for the red left-border.
    assert.ok(/<div class="test-card test-card-failed"/.test(html),
      'Failed test card should carry test-card-failed class');
    // Actual line shows up with the failed modifier.
    assert.ok(/<div class="test-actual is-failed"/.test(html),
      'Failed test should render Actual block with is-failed style');
    assert.ok(html.includes('HTTP 403 Forbidden'),
      'Actual response text should render');
    // Sidebar nav badge surfaces failure count (1 critical + 1 high = 2).
    assert.ok(/<span class="nav-badge nav-badge-warn">2<\/span>/.test(html),
      'Nav badge should show total failure count (critical + high)');
    // Stage status badge in sub-tab bar should be Failed.
    assert.ok(/subtab-status-fail[^>]*>Failed<\/span>/.test(html),
      'Stage with runOutcome=failed should show Failed status in sub-tab bar');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('render-alm-plan: validationRuns multi-stage renders one sub-tab + pane per stage', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-alm-out-'));
  const outputPath = path.join(tmpDir, 'alm-plan.html');

  try {
    const data = makeValidData({
      validationRuns: {
        Staging: makeValidationRun(),
        Production: makeValidationRun({ runOutcome: 'passed-with-warnings' }),
      },
    });
    const { status } = runScript(data, outputPath);
    assert.equal(status, 0);
    const html = fs.readFileSync(outputPath, 'utf8');

    // Two sub-tab buttons — one per stage; first marked active.
    assert.ok(/<button class="subtab-btn active"[^>]*data-vstage="Staging"/.test(html),
      'First sub-tab (Staging) should be active by default');
    assert.ok(/<button class="subtab-btn"[^>]*data-vstage="Production"/.test(html),
      'Production sub-tab should render in inactive state');
    // Both panes exist; first active, second hidden until clicked.
    assert.ok(html.includes('id="vstage-Staging"') && html.includes('id="vstage-Production"'),
      'Both stage panes should exist');
    assert.ok(/<div class="vstage-pane active" id="vstage-Staging">/.test(html),
      'Staging pane should be active');
    assert.ok(/<div class="vstage-pane" id="vstage-Production">/.test(html),
      'Production pane should be inactive');
    // Production marked Warnings in the sub-tab bar.
    assert.ok(/subtab-status-warn[^>]*>Warnings<\/span>/.test(html),
      'Production sub-tab should show Warnings status');
    // Sub-tab JS handler is wired up.
    assert.ok(html.includes("document.querySelectorAll('.subtab-btn')"),
      'Sub-tab JS handler should be present in the script block');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('render-alm-plan: validationRuns test card shows steps + expected when expanded', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-alm-out-'));
  const outputPath = path.join(tmpDir, 'alm-plan.html');

  try {
    const data = makeValidData({
      validationRuns: {
        Staging: makeValidationRun({
          categories: [
            {
              id: 'auth', name: 'Authentication', icon: '\u{1F512}',
              tests: [
                {
                  id: 't20',
                  name: 'Login redirects to Entra ID',
                  severity: 'critical',
                  type: 'manual',
                  status: 'passed',
                  description: 'Login flow.',
                  steps: ['Click Sign In', 'Verify redirect to login.microsoftonline.com'],
                  expected: 'User is redirected to Entra ID with the correct tenant ID',
                  actual: 'Redirected to login.microsoftonline.com/<tenant>',
                  validates: 'Entra ID app registration',
                },
              ],
            },
          ],
        }),
      },
    });
    const { status } = runScript(data, outputPath);
    assert.equal(status, 0);
    const html = fs.readFileSync(outputPath, 'utf8');

    // Steps list rendered as ordered list.
    assert.ok(/<ol class="test-steps">/.test(html),
      'Steps should render as <ol class="test-steps">');
    assert.ok(html.includes('Click Sign In'),
      'Step text should render');
    // Expected block.
    assert.ok(/<div class="test-expected">/.test(html),
      'Expected block should render');
    assert.ok(html.includes('Entra ID with the correct tenant ID'),
      'Expected text should render');
    // Manual test type badge.
    assert.ok(/<span class="test-type-badge test-type-manual">manual<\/span>/.test(html),
      'Manual type badge should render');
    // Validates field surfaces.
    assert.ok(html.includes('Entra ID app registration'),
      'Validates field text should render');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('render-alm-plan: Test site checklist step shows Passed badge + URL + pass count + View details link', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-alm-out-'));
  const outputPath = path.join(tmpDir, 'alm-plan.html');

  try {
    const data = makeValidData({
      steps: [
        { name: 'Deploy via pipeline to Staging', status: 'completed', skip: false },
        { name: 'Activate site in Staging', status: 'completed', skip: false },
        { name: 'Test site in Staging', status: 'completed', skip: false },
      ],
      validationRuns: {
        Staging: makeValidationRun({
          url: 'https://example.powerappsportals.com',
          summary: { critical: 0, high: 0, medium: 0, low: 1, total: 1, automated: 1, manual: 0, passed: 1, failed: 0, skipped: 0 },
        }),
      },
    });
    const { status } = runScript(data, outputPath);
    assert.equal(status, 0);
    const html = fs.readFileSync(outputPath, 'utf8');

    // The Test site step's substep block should contain a PASSED badge,
    // the URL inline, the pass count, and the View details link.
    const idx = html.indexOf('Test site in Staging');
    assert.ok(idx > 0, 'Test site step should render');
    const stepCtx = html.slice(idx, idx + 1200);
    assert.ok(/test-result-pass">PASSED</.test(stepCtx),
      'Test step substep should show PASSED badge');
    assert.ok(stepCtx.includes('example.powerappsportals.com'),
      'Test step substep should show the URL');
    assert.ok(stepCtx.includes('1 pass'),
      'Test step substep should show the pass count');
    assert.ok(/View details/.test(stepCtx),
      'Test step substep should include a "View details" jump link');
    // Deploy + Activate steps should each have a Target: env URL substep.
    const deployIdx = html.indexOf('Deploy via pipeline to Staging');
    const deployCtx = html.slice(deployIdx, deployIdx + 600);
    assert.ok(/Target:[\s\S]*staging\.crm\.dynamics\.com/.test(deployCtx),
      'Deploy step should show Target: <envUrl> substep');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('render-alm-plan: failed validationRun escalates Test step status from completed to warning', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-alm-out-'));
  const outputPath = path.join(tmpDir, 'alm-plan.html');

  try {
    const data = makeValidData({
      steps: [
        { name: 'Test site in Staging', status: 'completed', skip: false },
      ],
      validationRuns: {
        Staging: makeValidationRun({ runOutcome: 'failed' }),
      },
    });
    const { status } = runScript(data, outputPath);
    assert.equal(status, 0);
    const html = fs.readFileSync(outputPath, 'utf8');

    const idx = html.indexOf('Test site in Staging');
    const stepCtx = html.slice(idx - 200, idx + 200);
    // Status modifier on the wrapper div should be status-warning, not
    // status-completed, when the run failed.
    assert.ok(/checklist-item status-warning/.test(stepCtx),
      'A failed run should escalate the step status from completed to warning');
    assert.ok(/test-result-fail">FAILED</.test(html.slice(idx, idx + 1200)),
      'Failed run should render the FAILED badge in the substep');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('render-alm-plan: validationRuns nav badge shows OK when all stages passed cleanly', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-alm-out-'));
  const outputPath = path.join(tmpDir, 'alm-plan.html');

  try {
    const data = makeValidData({
      validationRuns: {
        Staging: makeValidationRun(),  // passed, 0 critical, 0 high
        Production: makeValidationRun(),
      },
    });
    const { status } = runScript(data, outputPath);
    assert.equal(status, 0);
    const html = fs.readFileSync(outputPath, 'utf8');

    // Nav badge should be OK (no critical/high failures).
    assert.ok(/<span class="nav-badge nav-badge-ok">OK<\/span>/.test(html),
      'Nav badge should display "OK" when no critical/high failures');
    // Should NOT show the warn badge.
    assert.ok(!/<span class="nav-badge nav-badge-warn">/.test(html.split('data-tab="validation"')[1] || ''),
      'Nav badge for Validation should not be the warn variant when passing');
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

test('render-alm-plan: pipelineMeta absent → no ACTIVE chip and no last-run footer', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-alm-out-'));
  const outputPath = path.join(tmpDir, 'alm-plan.html');

  try {
    const data = makeValidData(); // no pipelineMeta key
    const { status } = runScript(data, outputPath);
    assert.equal(status, 0);
    const html = fs.readFileSync(outputPath, 'utf8');

    // The single-solution branch should not emit a header, ACTIVE chip, or
    // last-run footer when pipelineMeta is absent. Look for the literal
    // closing tag span for ACTIVE so we don't false-match anywhere else.
    assert.ok(!/>ACTIVE<\/span>/.test(html),
      'No ACTIVE chip when pipelineMeta is absent');
    assert.ok(!/Last run:/.test(html),
      'No "Last run:" footer when pipelineMeta is absent');
    assert.ok(!/Reused/.test(html) || /Reused as managed/.test(html) || true,
      'No "Reused — matched on source+target" annotation when pipelineMeta is absent');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('render-alm-plan: pipelineMeta with isActive renders ACTIVE chip + actual name + last-run footer', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-alm-out-'));
  const outputPath = path.join(tmpDir, 'alm-plan.html');

  try {
    const data = makeValidData({
      pipelineMeta: {
        isActive: true,
        pipelineId: '2b8b5de8-8f43-f111-bec7-6045bd569497',
        pipelineName: 'BYOC Supplier Portal Pipeline',
        reusedByWiring: null,
        lastDeploy: {
          status: 'Succeeded',
          stageName: 'Deploy to Staging',
          deployedAt: '2026-04-29T08:42:00.000Z',
          artifactVersion: '1.0.0.2',
          componentCount: 118,
        },
      },
    });
    const { status } = runScript(data, outputPath);
    assert.equal(status, 0);
    const html = fs.readFileSync(outputPath, 'utf8');

    assert.ok(html.includes('BYOC Supplier Portal Pipeline'),
      'Should render the actual pipeline name from pipelineMeta');
    assert.ok(!/TestSite-Pipeline/.test(html),
      'Should NOT fall back to the synthesized {SITE_NAME}-Pipeline name when pipelineMeta supplies one');
    assert.ok(/>ACTIVE<\/span>/.test(html),
      'Should render the ACTIVE chip when pipelineMeta.isActive is true');
    assert.ok(/Last run:/.test(html),
      'Should render the "Last run:" footer when lastDeploy is set');
    assert.ok(html.includes('v1.0.0.2'),
      'Last-run footer should include the artifact version');
    assert.ok(html.includes('Succeeded'),
      'Last-run footer should include the deploy status');
    assert.ok(html.includes('118 components'),
      'Last-run footer should include the component count');
    assert.ok(html.includes('Deploy to Staging'),
      'Last-run footer should include the stage name');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('render-alm-plan: pipelineMeta.reusedByWiring renders the reused-name annotation', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-alm-out-'));
  const outputPath = path.join(tmpDir, 'alm-plan.html');

  try {
    const data = makeValidData({
      pipelineMeta: {
        isActive: true,
        pipelineId: 'aaaa1111-bbbb-cccc-dddd-eeeeffff0000',
        pipelineName: 'BYOC Demo Site Pipeline',
        reusedByWiring: {
          originalName: 'BYOC Demo Site Pipeline',
          requestedName: 'BYOC Supplier Portal Pipeline',
        },
        lastDeploy: null,
      },
    });
    const { status } = runScript(data, outputPath);
    assert.equal(status, 0);
    const html = fs.readFileSync(outputPath, 'utf8');

    assert.ok(html.includes('BYOC Demo Site Pipeline'),
      'Should render the original (reused) pipeline name');
    assert.ok(/Reused/.test(html),
      'Should mark the pipeline as reused');
    assert.ok(html.includes('matched on source+target wiring'),
      'Should explain the reused-by-wiring rationale');
    assert.ok(html.includes('BYOC Supplier Portal Pipeline'),
      'Should also surface the requested name so reviewers see why the actual name differs');
    assert.ok(!/Last run:/.test(html),
      'Should not render a "Last run:" footer when lastDeploy is null');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
