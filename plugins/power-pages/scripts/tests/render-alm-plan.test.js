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
