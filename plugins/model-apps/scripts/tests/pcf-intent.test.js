'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assertGolden } = require('./helpers/golden.js');
const { loadCli } = require('./helpers/cli-harness.js');

const {
  validateIntent,
  lintBindingIntent,
  renderPlanMarkdown,
} = require('../lib/pcf-intent.js');

const scriptPath = path.join(__dirname, '..', 'write-pcf-plan.js');

function exampleIntent(overrides = {}) {
  return {
    schemaVersion: 1,
    control: {
      namespace: 'Contoso.Controls',
      name: 'StarRating',
      displayName: 'Star rating',
      description: 'Shows a whole number as 0-5 stars',
      template: 'field-standard',
      recipe: 'star-rating',
    },
    hosts: ['model', 'pages'],
    connectivity: 'online',
    properties: [
      { name: 'value', usage: 'bound', type: 'Whole.None', required: true },
      { name: 'max', usage: 'input', type: 'Whole.None', required: false, default: '5' },
    ],
    features: [],
    deploy: { solution: 'ContosoCore', publisherPrefix: null, environment: 'https://contoso.crm.dynamics.com' },
    bindings: [{
      kind: 'field',
      table: 'account',
      form: 'Account',
      formType: 'main',
      target: { column: 'new_rating' },
      clients: ['web', 'phone', 'tablet'],
      parameters: {
        value: { column: 'new_rating' },
        max: { static: '5', type: 'Whole.None' },
      },
    }],
    pages: { journeys: ['form-field'] },
    ...overrides,
  };
}

function matrix(overrides = {}) {
  return {
    hosts: {
      pages: { fieldTypes: ['Whole.None', 'SingleLine.Text'] },
    },
    unsupportedPropertyTypes: ['File', 'Image'],
    ...overrides,
  };
}

function manifestModel(overrides = {}) {
  return {
    control: { controlType: 'standard' },
    properties: [
      { name: 'value', usage: 'bound', required: true },
      { name: 'max', usage: 'input', required: false },
    ],
    ...overrides,
  };
}

function codes(findings) {
  return findings.map((finding) => finding.code);
}

function assertFinding(findings, code, severity) {
  const finding = findings.find((item) => item.code === code);
  assert.ok(finding, `${code} missing from ${codes(findings).join(', ')}`);
  assert.equal(finding.severity, severity);
  assert.match(finding.message, /.+/);
  assert.match(finding.fix, /add|bind|change|choose|remove|set|target|use|verify|map|include|keep/i);
}

async function runCli(argv) {
  const cli = loadCli(scriptPath, { argv });
  assert.equal(typeof cli.main, 'function');
  try {
    await cli.main();
  } catch (err) {
    if (!String(err && err.message).startsWith('process.exit(')) throw err;
  }
  return cli;
}

test('validateIntent accepts the v1 example shape with Task 15 binding amendments', () => {
  assert.deepEqual(validateIntent(exampleIntent()), []);
});

test('validateIntent reports schema, name, enum, template, and binding shape fixes', () => {
  const errors = validateIntent(exampleIntent({
    schemaVersion: 2,
    control: {
      namespace: '1bad',
      name: 'class',
      displayName: '',
      description: '',
      template: 'missing-template',
      recipe: 'missing-recipe',
    },
    hosts: ['model', 'bad-host'],
    connectivity: 'offline',
    properties: [{ name: '', usage: 'bad', type: '', required: 'yes' }],
    deploy: { solution: '', publisherPrefix: 'mscrmBad' },
    bindings: [{
      kind: 'bad-kind',
      table: '',
      form: '',
      formType: 'quick',
      target: {},
      clients: ['console'],
      parameters: { value: { static: 5 } },
    }],
    pages: { journeys: ['unknown'] },
  }));

  assert.ok(errors.length > 10);
  for (const text of [
    'schemaVersion must be 1',
    'control.namespace',
    'control.name',
    'control.template',
    'hosts[1]',
    'connectivity must be online',
    'properties[0].usage',
    'deploy.solution',
    'deploy.publisherPrefix',
    'bindings[0].kind',
    'bindings[0].clients[0]',
    'bindings[0].parameters.value.static',
    'pages.journeys[0]',
  ]) {
    assert.ok(errors.some((error) => error.includes(text)), `${text} missing from ${errors.join('\n')}`);
  }
});

test('lintBindingIntent reports PCF_INTENT_QC_SUBGRID', () => {
  const findings = lintBindingIntent(exampleIntent({
    bindings: [{
      kind: 'dataset-subgrid',
      table: 'account',
      form: 'Quick Create',
      formType: 'quick-create',
      target: { controlId: 'Contacts', table: 'contact', view: 'Active Contacts', relationship: 'account_contact' },
      parameters: { records: { dataset: { name: 'records', propertySets: [{ name: 'email', column: 'emailaddress1' }] } } },
    }],
  }), { manifestModel: manifestModel(), matrix: matrix() });

  assertFinding(findings, 'PCF_INTENT_QC_SUBGRID', 'error');
});

test('lintBindingIntent reports PCF_INTENT_PAGES_MULTI_FIELD', () => {
  const findings = lintBindingIntent(exampleIntent({
    bindings: [{
      kind: 'field',
      table: 'account',
      form: 'Account',
      formType: 'main',
      target: { column: 'new_rating' },
      parameters: {
        value: { column: 'new_rating' },
        max: { column: 'new_maxrating' },
      },
    }],
  }), { manifestModel: manifestModel(), matrix: matrix() });

  assertFinding(findings, 'PCF_INTENT_PAGES_MULTI_FIELD', 'error');
});

test('lintBindingIntent reports PCF_INTENT_PAGES_NEEDS_WEB', () => {
  const findings = lintBindingIntent(exampleIntent({
    bindings: [{ ...exampleIntent().bindings[0], clients: ['phone'] }],
  }), { manifestModel: manifestModel(), matrix: matrix() });

  assertFinding(findings, 'PCF_INTENT_PAGES_NEEDS_WEB', 'error');
});

test('lintBindingIntent reports PCF_INTENT_PAGES_VIRTUAL from the manifest model', () => {
  const findings = lintBindingIntent(exampleIntent(), {
    manifestModel: manifestModel({ control: { controlType: 'virtual' } }),
    matrix: matrix(),
  });

  assertFinding(findings, 'PCF_INTENT_PAGES_VIRTUAL', 'error');
});

test('lintBindingIntent reports PCF_INTENT_PAGES_VIRTUAL from the intent template when no manifest is supplied', () => {
  const findings = lintBindingIntent(exampleIntent({
    control: { ...exampleIntent().control, template: 'field-virtual' },
  }), { matrix: matrix() });

  assertFinding(findings, 'PCF_INTENT_PAGES_VIRTUAL', 'error');
});

test('lintBindingIntent does not reuse PCF_INTENT_PAGES_VIRTUAL for field-type policy checks', () => {
  const findings = lintBindingIntent(exampleIntent({
    properties: [{ name: 'value', usage: 'bound', type: 'File', required: true }],
  }), { matrix: matrix() });

  assert.ok(!findings.some((finding) => finding.code === 'PCF_INTENT_PAGES_VIRTUAL'));
});

test('lintBindingIntent reports PCF_INTENT_PARAM_UNKNOWN', () => {
  const findings = lintBindingIntent(exampleIntent({
    bindings: [{
      ...exampleIntent().bindings[0],
      parameters: { value: { column: 'new_rating' }, unexpected: { static: 'x', type: 'SingleLine.Text' } },
    }],
  }), { manifestModel: manifestModel(), matrix: matrix() });

  assertFinding(findings, 'PCF_INTENT_PARAM_UNKNOWN', 'error');
});

test('lintBindingIntent reports PCF_INTENT_BOUND_NOT_MAPPED but exempts grid EventName', () => {
  const missing = lintBindingIntent(exampleIntent({
    properties: [
      { name: 'value', usage: 'bound', type: 'Whole.None', required: true },
      { name: 'EventName', usage: 'bound', type: 'SingleLine.Text', required: true },
    ],
    bindings: [{
      kind: 'field',
      table: 'account',
      form: 'Account',
      formType: 'main',
      target: { column: 'new_rating' },
      parameters: { value: { column: 'new_rating' } },
    }],
  }), {
    manifestModel: manifestModel({
      properties: [
        { name: 'value', usage: 'bound', required: true },
        { name: 'EventName', usage: 'bound', required: true },
      ],
    }),
    matrix: matrix(),
  });
  assertFinding(missing, 'PCF_INTENT_BOUND_NOT_MAPPED', 'error');

  const grid = lintBindingIntent(exampleIntent({
    properties: [
      { name: 'EventName', usage: 'bound', type: 'SingleLine.Text', required: true },
    ],
    bindings: [{
      kind: 'grid-customizer',
      table: 'account',
      form: 'Account',
      formType: 'main',
      target: { controlId: 'accountGrid' },
      parameters: {},
    }],
  }), {
    manifestModel: manifestModel({ properties: [{ name: 'EventName', usage: 'bound', required: true }] }),
    matrix: matrix(),
  });
  assert.ok(!codes(grid).includes('PCF_INTENT_BOUND_NOT_MAPPED'));
});

test('lintBindingIntent reports PCF_INTENT_LIST_NEEDS_VIEW_CONFIG', () => {
  const findings = lintBindingIntent(exampleIntent({
    pages: { journeys: ['list'] },
  }), { manifestModel: manifestModel(), matrix: matrix() });

  assertFinding(findings, 'PCF_INTENT_LIST_NEEDS_VIEW_CONFIG', 'warning');
});

test('renderPlanMarkdown matches the reviewed golden output', () => {
  const intent = exampleIntent();
  const lint = lintBindingIntent(intent, { manifestModel: manifestModel(), matrix: matrix() });

  assertGolden('pcf-plan-example.md', renderPlanMarkdown(intent, { lint }));
});

test('write-pcf-plan writes markdown, emits JSON, and exits 1 when lint has errors', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-plan-cli-'));
  try {
    const intentPath = path.join(dir, 'pcf-intent.json');
    const outPath = path.join(dir, 'pcf-plan.md');
    fs.writeFileSync(intentPath, JSON.stringify(exampleIntent({
      bindings: [{ ...exampleIntent().bindings[0], clients: ['phone'] }],
    }), null, 2));

    const cli = await runCli(['--intent', `@${intentPath}`, '--out', outPath]);

    assert.equal(cli.exitCode, 1);
    const payload = JSON.parse(cli.stdoutText());
    assert.equal(payload.ok, false);
    assert.equal(payload.out, outPath);
    assert.ok(payload.findings.some((finding) => finding.code === 'PCF_INTENT_PAGES_NEEDS_WEB'));
    assert.match(fs.readFileSync(outPath, 'utf8'), /PCF_INTENT_PAGES_NEEDS_WEB/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
