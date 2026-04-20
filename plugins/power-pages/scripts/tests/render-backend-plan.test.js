const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const scriptPath = path.join(__dirname, '..', 'render-backend-plan.js');

const SAMPLE_DATA = {
  SITE_NAME: 'Contoso Portal',
  PLAN_TITLE: 'Backend Integration Plan',
  SUMMARY: 'Use Web API for data browsing and Server Logic for payment processing.',
  ITEMS_DATA: [
    {
      name: 'Event Listings',
      approach: 'webapi',
      description: 'Display events from Dataverse',
      reasoning: 'Simple CRUD — Web API is sufficient.',
      details: [
        { label: 'Tables', value: 'cr_events' },
        { label: 'Operations', value: 'Read' },
      ],
    },
    {
      name: 'Process Payment',
      approach: 'serverlogic',
      description: 'Call Stripe API with credentials on the server',
      reasoning: 'Credentials must stay on the server.',
      details: [
        { label: 'Endpoint', value: '/_api/serverlogics/process-payment' },
        { label: 'Secrets', value: 'STRIPE_SECRET_KEY' },
      ],
    },
    {
      name: 'Send Confirmation',
      approach: 'cloudflow',
      description: 'Email confirmation after payment',
      reasoning: 'Async notification — user does not wait.',
      details: [
        { label: 'Connector', value: 'Office 365 Outlook' },
      ],
    },
  ],
  DATA_FLOWS_DATA: [
    {
      trigger: 'User pays for event',
      description: 'Payment flow from form to confirmation',
      steps: [
        { approach: 'serverlogic', name: 'Process Payment', detail: 'Calls Stripe' },
        { approach: 'cloudflow', name: 'Send Email', detail: 'Async confirmation' },
      ],
    },
  ],
  RATIONALE_DATA: [
    {
      icon: '&#9881;',
      title: 'Web API for reads',
      desc: 'Simple data fetching needs no server-side logic.',
    },
    {
      icon: '&#128274;',
      title: 'Server Logic for payments',
      desc: 'Stripe credentials must never reach the browser.',
    },
  ],
};

test('render-backend-plan renders HTML from --data file', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-plan-'));
  const dataPath = path.join(tempDir, 'data.json');
  const outputPath = path.join(tempDir, 'backend-plan.html');

  fs.writeFileSync(dataPath, JSON.stringify(SAMPLE_DATA, null, 2), 'utf8');

  const result = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(fs.existsSync(outputPath));

  const html = fs.readFileSync(outputPath, 'utf8');
  assert.match(html, /Contoso Portal/);
  assert.match(html, /Event Listings/);
  assert.match(html, /Process Payment/);
  assert.match(html, /Send Confirmation/);
  assert.match(html, /Calls Stripe/);
  assert.match(html, /Web API for reads/);
});

test('render-backend-plan renders HTML from --data-inline JSON', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-plan-'));
  const outputPath = path.join(tempDir, 'backend-plan-inline.html');

  const result = spawnSync(
    process.execPath,
    [scriptPath, '--output', outputPath, '--data-inline', JSON.stringify(SAMPLE_DATA)],
    { encoding: 'utf8' }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(fs.existsSync(outputPath));

  const html = fs.readFileSync(outputPath, 'utf8');
  assert.match(html, /Contoso Portal/);
  assert.match(html, /Server Logic for payments/);
});

test('render-backend-plan fails with no arguments', () => {
  const result = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage:/);
});

test('render-backend-plan fails with invalid --data-inline JSON', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-plan-'));
  const outputPath = path.join(tempDir, 'backend-plan.html');

  const result = spawnSync(
    process.execPath,
    [scriptPath, '--output', outputPath, '--data-inline', '{bad json}'],
    { encoding: 'utf8' }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /not valid JSON/);
});

test('render-backend-plan refuses to overwrite existing file', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-plan-'));
  const dataPath = path.join(tempDir, 'data.json');
  const outputPath = path.join(tempDir, 'backend-plan.html');

  fs.writeFileSync(dataPath, JSON.stringify(SAMPLE_DATA, null, 2), 'utf8');

  const result1 = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], {
    encoding: 'utf8',
  });
  assert.equal(result1.status, 0, result1.stderr || result1.stdout);

  const original = fs.readFileSync(outputPath, 'utf8');

  const result2 = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], {
    encoding: 'utf8',
  });
  assert.equal(result2.status, 1);
  assert.match(result2.stderr, /Output file already exists/);
  assert.equal(fs.readFileSync(outputPath, 'utf8'), original);
});
