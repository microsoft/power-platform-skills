const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const scriptPath = path.join(
  __dirname,
  '..',
  'render-serverlogic-plan.js'
);

const SAMPLE_DATA = {
  SITE_NAME: 'Contoso Portal',
  PLAN_TITLE: 'Server Logic Plan',
  SUMMARY: 'Create multiple server logic items for the support portal while keeping role assignment and function design visible in one reviewable plan.',
  WEB_ROLES_DATA: [
    {
      id: 'authenticated-users',
      name: 'Authenticated Users',
      desc: 'Built-in role for signed-in users.',
      builtin: true,
      isNew: false,
      color: '#8890a4',
    },
    {
      id: 'support-managers',
      name: 'Support Managers',
      desc: 'Custom role for elevated support dashboards.',
      builtin: false,
      isNew: true,
      color: '#4a7ce8',
    },
  ],
  SERVER_LOGICS_DATA: [
    {
      id: 'dashboard-summary',
      name: 'dashboard-summary',
      displayName: 'Dashboard Summary',
      status: 'create',
      apiUrl: 'https://contoso.powerappsportals.com/_api/serverlogics/dashboard-summary',
      webRoles: [
        {
          id: 'authenticated-users',
          reasoning: 'Authenticated users need the dashboard because it surfaces their assigned work and queue metrics.',
        },
        {
          id: 'support-managers',
          reasoning: 'Support managers need the same endpoint to review queue-wide workload and escalations.',
        },
      ],
      rationale: 'This endpoint centralizes support dashboard aggregation on the server.',
      functions: [
        {
          name: 'get',
          purpose: 'Return dashboard summary data',
          reasoning: 'The dashboard only reads data, so GET is the right fit.',
        },
      ],
    },
    {
      id: 'case-export',
      name: 'case-export',
      displayName: 'Case Export',
      status: 'reuse',
      apiUrl: 'https://contoso.powerappsportals.com/_api/serverlogics/case-export',
      webRoles: [
        {
          id: 'support-managers',
          reasoning: 'Only support managers should initiate exports because the payload includes sensitive case data.',
        },
      ],
      rationale: 'This existing endpoint is being reused as-is for the export workflow.',
      functions: [
        {
          name: 'post',
          purpose: 'Start export job',
          reasoning: 'Export initiation changes state, so POST is required.',
        },
      ],
    },
  ],
  RATIONALE_DATA: [
    {
      icon: '🛡️',
      title: 'Why this structure',
      desc: 'The plan separates reusable endpoints from newly proposed endpoints so review can focus on real changes.',
    },
  ],
};

test('render-serverlogic-plan renders HTML from JSON data', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'serverlogic-plan-'));
  const dataPath = path.join(tempDir, 'data.json');
  const outputPath = path.join(tempDir, 'serverlogic-plan.html');

  fs.writeFileSync(dataPath, JSON.stringify(SAMPLE_DATA, null, 2), 'utf8');

  const result = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(fs.existsSync(outputPath));

  const html = fs.readFileSync(outputPath, 'utf8');
  assert.match(html, /Contoso Portal/);
  assert.match(html, /dashboard-summary/);
  assert.match(html, /Authenticated Users/);
  assert.match(html, /Support Managers/);
  assert.match(html, /Case Export/);
  assert.match(html, /assigned work and queue metrics/);
  assert.match(html, /Export initiation changes state/);
});

test('render-serverlogic-plan renders Key Vault banner when SECRETS_DATA has useKeyVault true', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'serverlogic-plan-'));
  const dataPath = path.join(tempDir, 'data.json');
  const outputPath = path.join(tempDir, 'serverlogic-plan.html');

  const dataWithSecrets = {
    ...SAMPLE_DATA,
    SECRETS_DATA: {
      useKeyVault: true,
      vaultName: 'contoso-kv',
      secrets: [
        {
          name: 'DashboardApiKey',
          purpose: 'API key for the dashboard analytics service',
          siteSetting: 'ExternalApi/DashboardApiKey',
          serverLogicId: 'dashboard-summary',
        },
      ],
    },
  };

  fs.writeFileSync(dataPath, JSON.stringify(dataWithSecrets, null, 2), 'utf8');

  const result = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const html = fs.readFileSync(outputPath, 'utf8');
  assert.match(html, /useKeyVault/);
  assert.match(html, /contoso-kv/);
  assert.match(html, /DashboardApiKey/);
});

test('render-serverlogic-plan defaults SECRETS_DATA to null when not provided', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'serverlogic-plan-'));
  const dataPath = path.join(tempDir, 'data.json');
  const outputPath = path.join(tempDir, 'serverlogic-plan.html');

  // SAMPLE_DATA has no SECRETS_DATA key
  fs.writeFileSync(dataPath, JSON.stringify(SAMPLE_DATA, null, 2), 'utf8');

  const result = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const html = fs.readFileSync(outputPath, 'utf8');
  // The template should contain `const SECRETS = null;` (no unreplaced placeholder)
  assert.ok(!html.includes('__SECRETS_DATA__'), 'SECRETS_DATA placeholder should be replaced');
  assert.match(html, /const SECRETS = null/);
});

test('render-serverlogic-plan refuses to overwrite an existing file', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'serverlogic-plan-'));
  const dataPath = path.join(tempDir, 'data.json');
  const outputPath = path.join(tempDir, 'serverlogic-plan.html');

  fs.writeFileSync(dataPath, JSON.stringify(SAMPLE_DATA, null, 2), 'utf8');

  // First render — should succeed
  const result1 = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], {
    encoding: 'utf8',
  });
  assert.equal(result1.status, 0, result1.stderr || result1.stdout);

  const originalContent = fs.readFileSync(outputPath, 'utf8');

  // Second render to same path — should fail with exit code 1
  const result2 = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], {
    encoding: 'utf8',
  });
  assert.equal(result2.status, 1);
  assert.match(result2.stderr, /Output file already exists/);

  // Original file should be untouched
  assert.equal(fs.readFileSync(outputPath, 'utf8'), originalContent);
});
