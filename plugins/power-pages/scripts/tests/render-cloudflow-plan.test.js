const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const scriptPath = path.join(__dirname, '..', 'render-cloudflow-plan.js');

const SAMPLE_DATA = {
  SITE_NAME: 'Contoso Portal',
  PLAN_TITLE: 'Cloud Flow Plan',
  SUMMARY: 'Register two cloud flows for support ticket automation with appropriate web role assignments.',
  WEB_ROLES_DATA: [
    {
      id: 'authenticated-users',
      name: 'Authenticated Users',
      desc: 'Built-in role for signed-in users.',
      builtin: true,
      isNew: false,
      color: '#8890a4',
    },
  ],
  CLOUD_FLOWS_DATA: [
    {
      id: 'send-ticket-confirmation',
      name: 'Send Ticket Confirmation',
      flowId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      status: 'create',
      webRoles: [
        {
          id: 'authenticated-users',
          reasoning: 'Any authenticated user who submits a ticket should trigger the confirmation email.',
        },
      ],
      rationale: 'Sends a confirmation email when a support ticket is submitted.',
      scenarios: [
        {
          name: 'onSubmit',
          purpose: 'Trigger confirmation email after ticket form submission',
        },
      ],
    },
  ],
  RATIONALE_DATA: [
    {
      icon: '📧',
      title: 'Async notification',
      desc: 'Email is sent in the background so the user sees immediate confirmation in the UI.',
    },
  ],
};

test('render-cloudflow-plan renders HTML from --data file', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudflow-plan-'));
  const dataPath = path.join(tempDir, 'data.json');
  const outputPath = path.join(tempDir, 'cloudflow-plan.html');

  fs.writeFileSync(dataPath, JSON.stringify(SAMPLE_DATA, null, 2), 'utf8');

  const result = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(fs.existsSync(outputPath));

  const html = fs.readFileSync(outputPath, 'utf8');
  assert.match(html, /Contoso Portal/);
  assert.match(html, /Send Ticket Confirmation/);
  assert.match(html, /Authenticated Users/);
  assert.match(html, /confirmation email/i);
});

test('render-cloudflow-plan renders HTML from --data-inline JSON', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudflow-plan-'));
  const outputPath = path.join(tempDir, 'cloudflow-plan-inline.html');

  const result = spawnSync(
    process.execPath,
    [scriptPath, '--output', outputPath, '--data-inline', JSON.stringify(SAMPLE_DATA)],
    { encoding: 'utf8' }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(fs.existsSync(outputPath));

  const html = fs.readFileSync(outputPath, 'utf8');
  assert.match(html, /Contoso Portal/);
  assert.match(html, /Send Ticket Confirmation/);
});

test('render-cloudflow-plan fails with no arguments', () => {
  const result = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage:/);
});

test('render-cloudflow-plan fails with invalid --data-inline JSON', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudflow-plan-'));
  const outputPath = path.join(tempDir, 'cloudflow-plan.html');

  const result = spawnSync(
    process.execPath,
    [scriptPath, '--output', outputPath, '--data-inline', '{not valid json}'],
    { encoding: 'utf8' }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /not valid JSON/);
});

test('render-cloudflow-plan refuses to overwrite existing file', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudflow-plan-'));
  const dataPath = path.join(tempDir, 'data.json');
  const outputPath = path.join(tempDir, 'cloudflow-plan.html');

  fs.writeFileSync(dataPath, JSON.stringify(SAMPLE_DATA, null, 2), 'utf8');

  const result1 = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], {
    encoding: 'utf8',
  });
  assert.equal(result1.status, 0, result1.stderr || result1.stdout);

  const originalContent = fs.readFileSync(outputPath, 'utf8');

  const result2 = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], {
    encoding: 'utf8',
  });
  assert.equal(result2.status, 1);
  assert.match(result2.stderr, /Output file already exists/);

  assert.equal(fs.readFileSync(outputPath, 'utf8'), originalContent);
});
