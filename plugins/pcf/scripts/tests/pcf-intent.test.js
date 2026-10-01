'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assertGolden } = require('./helpers/golden.js');
const { loadCli } = require('./helpers/cli-harness.js');
const { parseManifest } = require('../lib/pcf-manifest.js');
const { planScaffold } = require('../lib/pcf-scaffold.js');

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

function withRecipeCatalog(recipes, callback) {
  const recipesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-intent-recipes-'));
  try {
    for (const recipe of recipes) {
      const recipeDir = path.join(recipesRoot, recipe.id);
      fs.mkdirSync(recipeDir, { recursive: true });
      const recipeJson = recipe.raw === undefined ? recipeFixture(recipe) : recipe.raw;
      fs.writeFileSync(path.join(recipeDir, 'recipe.json'), JSON.stringify(recipeJson, null, 2));
    }
    return callback({ recipesRoot });
  } finally {
    fs.rmSync(recipesRoot, { recursive: true, force: true });
  }
}

function recipeFixture(overrides = {}) {
  const status = overrides.status || 'available';
  const recipe = {
    id: overrides.id,
    title: overrides.title || `${overrides.id} recipe`,
    summary: overrides.summary || `${overrides.id} summary`,
    template: overrides.template || 'field-standard',
    hosts: overrides.hosts || ['model', 'pages'],
    whyWanted: overrides.whyWanted || 'Covers the fixture catalog path.',
    certified: overrides.certified || { model: {}, pages: {} },
    status,
    ...overrides,
  };
  if (status !== 'planned' && recipe.configuration === undefined) {
    recipe.configuration = 'Configure the control using fixture defaults.';
  }
  return recipe;
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

test('validateIntent accepts the v1 shape with canonical binding targets', () => {
  assert.deepEqual(validateIntent(exampleIntent()), []);
});

test('validateIntent accepts standalone Liquid and combined field Pages journeys', () => {
  for (const journeys of [['liquid'], ['form-field', 'liquid']]) {
    assert.deepEqual(validateIntent(exampleIntent({ hosts: ['pages'], bindings: [], pages: { journeys } })), []);
  }
});

test('validateIntent rejects Pages list and dataset journeys with the documented host boundary', () => {
  for (const journey of ['list', 'sub-grid', 'form-sub-grid', 'dataset', 'dataset-subgrid', 'dataset-list']) {
    const errors = validateIntent(exampleIntent({ pages: { journeys: [journey] } }));
    assert.ok(errors.some((error) => /pages\.journeys\[0\]/.test(error)
      && /form-field, liquid/.test(error)
      && /dataset journeys on Power Pages \(form sub-grid, list\) are not supported in this release/i.test(error)
      && /paging and openDatasetItem/.test(error)
      && /model-driven and canvas apps only/.test(error)), `${journey}: ${errors.join('\n')}`);
  }
});

test('validateIntent reports schema, name, enum, template, recipe, and binding shape fixes', () => {
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
    'control.recipe',
    'hosts[1]',
    'offline (mobile offline) hosts are not supported',
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

test('validateIntent requires every binding to declare kind', () => {
  const { kind, ...bindingWithoutKind } = {
    ...exampleIntent().bindings[0],
    target: { controlId: 'Contacts', table: 'contact', view: 'Active Contacts', relationship: 'account_contact' },
    parameters: { records: { dataset: { name: 'records', propertySets: [{ name: 'email', column: 'emailaddress1' }] } } },
  };
  assert.equal(kind, 'field');

  const errors = validateIntent(exampleIntent({
    bindings: [bindingWithoutKind],
  }));

  assert.ok(errors.some((error) => error.includes('bindings[0].kind') && error.includes('required')), errors.join('\n'));
});

test('lintBindingIntent accepts dataset parameters declared by the manifest data-set', () => {
  const plan = planScaffold({
    template: 'dataset-standard',
    namespace: 'Contoso.Controls',
    name: 'DatasetStd',
  });
  const manifestText = plan.files.find((file) => file.relPath.endsWith('ControlManifest.Input.xml')).content;
  const manifest = parseManifest(manifestText).model;
  const intent = exampleIntent({
    control: { ...exampleIntent().control, template: 'dataset-standard' },
    hosts: ['model'],
    properties: [],
    bindings: [{
      kind: 'dataset-subgrid',
      table: 'account',
      form: 'Account',
      formType: 'main',
      target: { controlId: 'Contacts' },
      parameters: {
        sampleDataSet: {
          dataset: {
            name: 'sampleDataSet',
            propertySets: [{ name: 'sampleProperty', column: 'name' }],
          },
        },
      },
    }],
  });

  assert.equal(codes(lintBindingIntent(intent, { manifestModel: manifest })).includes('PCF_INTENT_PARAM_UNKNOWN'), false);
});

test('lintBindingIntent rejects unknown dataset property-set names', () => {
  const plan = planScaffold({
    template: 'dataset-standard',
    namespace: 'Contoso.Controls',
    name: 'DatasetStd',
  });
  const manifestText = plan.files.find((file) => file.relPath.endsWith('ControlManifest.Input.xml')).content;
  const manifest = parseManifest(manifestText).model;
  const intent = exampleIntent({
    control: { ...exampleIntent().control, template: 'dataset-standard' },
    hosts: ['model'],
    properties: [],
    bindings: [{
      kind: 'dataset-subgrid',
      table: 'account',
      form: 'Account',
      formType: 'main',
      target: { controlId: 'Contacts' },
      parameters: {
        sampleDataSet: {
          dataset: {
            name: 'sampleDataSet',
            propertySets: [{ name: 'missingPropertySet', column: 'name' }],
          },
        },
      },
    }],
  });

  assertFinding(lintBindingIntent(intent, { manifestModel: manifest }), 'PCF_INTENT_PARAM_UNKNOWN', 'error');
});

test('validateIntent rejects supplied recipes when no recipes are available', () => {
  const errors = withRecipeCatalog([], (deps) => validateIntent(exampleIntent({
    control: { ...exampleIntent().control, recipe: 'star-rating' },
  }), deps));

  assert.ok(errors.some((error) => error.includes('no recipes are available in this release') && error.includes('omit `recipe`')), errors.join('\n'));
});

test('validateIntent surfaces recipe catalog read and validation failures', () => {
  const errors = withRecipeCatalog([
    { id: 'broken-recipe', raw: { id: 'broken-recipe' } },
  ], (deps) => validateIntent(exampleIntent({
    control: { ...exampleIntent().control, recipe: 'broken-recipe' },
  }), deps));

  assert.ok(errors.some((error) => error.includes('could not read the recipe catalog:') && error.includes('title must be a non-empty string')), errors.join('\n'));
  assert.ok(!errors.some((error) => error.includes('no recipes are available in this release')), errors.join('\n'));
});

test('validateIntent reports unknown recipes and lists only available recipe ids', () => {
  const errors = withRecipeCatalog([
    { id: 'available-rating' },
    { id: 'planned-lookup', status: 'planned' },
  ], (deps) => validateIntent(exampleIntent({
    control: { ...exampleIntent().control, recipe: 'missing-recipe' },
  }), deps));

  const error = errors.find((item) => item.includes("control.recipe 'missing-recipe' is unknown"));
  assert.ok(error, errors.join('\n'));
  assert.match(error, /choose one of: available-rating/);
  assert.doesNotMatch(error, /planned-lookup/);
});

test('validateIntent rejects planned recipes because they cannot be scaffolded', () => {
  const errors = withRecipeCatalog([
    { id: 'planned-lookup', status: 'planned' },
  ], (deps) => validateIntent(exampleIntent({
    control: { ...exampleIntent().control, recipe: 'planned-lookup' },
  }), deps));

  assert.ok(errors.some((error) => error.includes("control.recipe 'planned-lookup' is planned") && error.includes('not available in this release')), errors.join('\n'));
});

test('validateIntent accepts available recipes from the injected catalog', () => {
  const errors = withRecipeCatalog([
    { id: 'available-rating' },
  ], (deps) => validateIntent(exampleIntent({
    control: { ...exampleIntent().control, recipe: 'available-rating' },
  }), deps));

  assert.deepEqual(errors, []);
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

test('lintBindingIntent blocks Pages dataset templates without a manifest or bindings', () => {
  for (const template of ['dataset-standard', 'dataset-virtual']) {
    const intent = exampleIntent({
      control: { ...exampleIntent().control, template },
      hosts: ['pages'],
      bindings: [],
    });
    assertFinding(lintBindingIntent(intent), 'PCF_INTENT_PAGES_DATASET', 'error');
    assert.ok(!codes(lintBindingIntent({ ...intent, hosts: ['model'] })).includes('PCF_INTENT_PAGES_DATASET'));
  }
});

test('lintBindingIntent blocks Pages datasets declared by the manifest even for a field intent', () => {
  const findings = lintBindingIntent(exampleIntent({ bindings: [] }), {
    manifestModel: manifestModel({ dataSets: [{ name: 'records', propertySets: [] }] }),
  });
  assertFinding(findings, 'PCF_INTENT_PAGES_DATASET', 'error');
  const dataset = findings.find((item) => item.code === 'PCF_INTENT_PAGES_DATASET');
  assert.match(dataset.message, /paging and openDatasetItem/);
  assert.match(dataset.message, /model-driven and canvas apps only/);
});

test('lintBindingIntent blocks Pages dataset bindings and dataset parameters', () => {
  const field = exampleIntent().bindings[0];
  for (const binding of [
    { ...field, kind: 'dataset-subgrid' },
    { ...field, parameters: { records: { dataset: { name: 'records', propertySets: [] } } } },
  ]) {
    assertFinding(lintBindingIntent(exampleIntent({ bindings: [binding] })), 'PCF_INTENT_PAGES_DATASET', 'error');
  }
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

test('lintBindingIntent no longer guides unsupported Pages list setup', () => {
  const intent = exampleIntent({ pages: { journeys: ['list'] } });
  const findings = lintBindingIntent(intent, { manifestModel: manifestModel(), matrix: matrix() });
  assert.ok(!codes(findings).includes('PCF_INTENT_LIST_NEEDS_VIEW_CONFIG'));
  assert.doesNotMatch(renderPlanMarkdown(intent, { lint: findings }), /List: configure|verify the rendered dataset/);
});

test('renderPlanMarkdown matches the reviewed golden output', () => {
  const intent = exampleIntent();
  const lint = lintBindingIntent(intent, { manifestModel: manifestModel() });

  assertGolden('pcf-plan-example.md', renderPlanMarkdown(intent, { lint }));
});

test('renderPlanMarkdown renders the documented standalone Liquid steps and golden plan', () => {
  const intent = exampleIntent({ hosts: ['pages'], bindings: [], pages: { journeys: ['liquid'] } });
  const markdown = renderPlanMarkdown(intent, { lint: lintBindingIntent(intent) });
  assert.ok(markdown.includes("{% codecomponent name:<registered control name> <property>:'<value>' %}"));
  assert.match(markdown, /page source/);
  assert.match(markdown, /save.*Sync.*Preview.*confirm the control renders/i);
  assert.doesNotMatch(markdown, /List: configure|verify the rendered dataset/);
  assertGolden('pcf-plan-liquid.md', markdown);
});

test('renderPlanMarkdown escapes markdown headings and table cells', () => {
  const markdown = renderPlanMarkdown(exampleIntent({
    control: {
      ...exampleIntent().control,
      displayName: 'Star | rating\ncontrol',
      description: 'Shows a value | with newline\nsafely',
    },
    properties: [
      { name: 'value|score', usage: 'bound', type: 'Whole.None', required: true, default: '1\n2' },
    ],
  }), { lint: [] });

  assert.match(markdown, /^# Star \\| rating control plan/m);
  assert.match(markdown, /\*\*Description:\*\* Shows a value \\| with newline<br>safely/);
  assert.match(markdown, /\| value\\\|score \| bound \| Whole\.None \| yes \| 1<br>2 \|/);
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

test('write-pcf-plan accepts Liquid, writes its instructions, and preserves the success JSON shape', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-plan-liquid-'));
  try {
    const intentPath = path.join(dir, 'pcf-intent.json');
    const outPath = path.join(dir, 'pcf-plan.md');
    fs.writeFileSync(intentPath, JSON.stringify(exampleIntent({
      hosts: ['pages'], bindings: [], pages: { journeys: ['liquid'] },
    })));
    const cli = await runCli(['--intent', `@${intentPath}`, '--out', outPath]);
    assert.equal(cli.exitCode, 0);
    assert.deepEqual(JSON.parse(cli.stdoutText()), { ok: true, out: outPath, findings: [] });
    assert.ok(fs.readFileSync(outPath, 'utf8').includes("{% codecomponent name:<registered control name> <property>:'<value>' %}"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('write-pcf-plan rejects a Pages list journey before writing a plan with schema JSON', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-plan-list-'));
  try {
    const intentPath = path.join(dir, 'pcf-intent.json');
    const outPath = path.join(dir, 'pcf-plan.md');
    fs.writeFileSync(intentPath, JSON.stringify(exampleIntent({ pages: { journeys: ['list'] } })));
    const cli = await runCli(['--intent', `@${intentPath}`, '--out', outPath]);
    assert.equal(cli.exitCode, 1);
    const payload = JSON.parse(cli.stdoutText());
    assert.equal(payload.ok, false);
    assert.equal(payload.out, null);
    assert.match(payload.error, /intent schema is invalid/i);
    assert.ok(payload.findings.some((item) => item.code === 'PCF_INTENT_SCHEMA' && item.severity === 'error'));
    assert.match(payload.findings[0].message, /dataset journeys on Power Pages/i);
    assert.equal(fs.existsSync(outPath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('write-pcf-plan blocks a Pages dataset while preserving the blocking-plan JSON shape', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-plan-dataset-'));
  try {
    const intentPath = path.join(dir, 'pcf-intent.json');
    const outPath = path.join(dir, 'pcf-plan.md');
    fs.writeFileSync(intentPath, JSON.stringify(exampleIntent({
      control: { ...exampleIntent().control, template: 'dataset-standard' },
      hosts: ['pages'],
      bindings: [],
    })));
    const cli = await runCli(['--intent', `@${intentPath}`, '--out', outPath]);
    assert.equal(cli.exitCode, 1);
    const payload = JSON.parse(cli.stdoutText());
    assert.deepEqual(Object.keys(payload).sort(), ['findings', 'ok', 'out']);
    assert.equal(payload.ok, false);
    assert.equal(payload.out, outPath);
    assertFinding(payload.findings, 'PCF_INTENT_PAGES_DATASET', 'error');
    assert.match(fs.readFileSync(outPath, 'utf8'), /PCF_INTENT_PAGES_DATASET/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('write-pcf-plan emits JSON and exits 1 when the intent file is missing', async () => {
  const cli = await runCli(['--intent', '@D:\\missing\\pcf-intent.json']);

  assert.equal(cli.exitCode, 1);
  assert.match(cli.stderrText().trim(), /^cannot read PCF intent/);
  const payload = JSON.parse(cli.stdoutText());
  assert.equal(payload.ok, false);
  assert.match(payload.error, /cannot read PCF intent/);
});

test('write-pcf-plan emits JSON and exits 1 when the intent JSON is invalid', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-plan-invalid-json-'));
  try {
    const intentPath = path.join(dir, 'pcf-intent.json');
    fs.writeFileSync(intentPath, '{ nope');

    const cli = await runCli(['--intent', `@${intentPath}`]);

    assert.equal(cli.exitCode, 1);
    assert.match(cli.stderrText().trim(), /^cannot read PCF intent/);
    const payload = JSON.parse(cli.stdoutText());
    assert.equal(payload.ok, false);
    assert.match(payload.error, /cannot read PCF intent/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('write-pcf-plan emits schema JSON instead of throwing for schema-invalid intent shapes', async () => {
  const cases = [
    ['null root', null],
    ['null property entry', exampleIntent({ properties: [null] })],
    ['null binding entry', exampleIntent({ bindings: [null] })],
  ];
  for (const [name, intent] of cases) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-plan-invalid-shape-'));
    try {
      const intentPath = path.join(dir, 'pcf-intent.json');
      fs.writeFileSync(intentPath, JSON.stringify(intent));

      const cli = await runCli(['--intent', `@${intentPath}`]);

      assert.equal(cli.exitCode, 1, name);
      const payload = JSON.parse(cli.stdoutText());
      assert.equal(payload.ok, false, name);
      assert.equal(payload.out, null, name);
      assert.ok(payload.findings.some((finding) => finding.code === 'PCF_INTENT_SCHEMA'), name);
      assert.match(payload.error, /intent schema is invalid/i, name);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('write-pcf-plan rejects a positional intent path without --intent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-plan-positional-'));
  try {
    const intentPath = path.join(dir, 'pcf-intent.json');
    fs.writeFileSync(intentPath, JSON.stringify(exampleIntent()));

    const cli = await runCli([intentPath]);

    assert.equal(cli.exitCode, 1);
    assert.match(cli.stderrText(), /Usage:/);
    assert.equal(cli.stdoutText(), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validateIntent explains that offline describes an unsupported host mode', () => {
  const errors = validateIntent(exampleIntent({ connectivity: 'offline' }));
  const expected = 'connectivity must be "online": it describes the host\'s connection mode, and offline (mobile offline) hosts are not supported in this release. A control that makes no network calls still uses "online".';
  assert.ok(errors.includes(expected), errors.join('\n'));
});
