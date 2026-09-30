'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseManifest, lintManifest } = require('../lib/pcf-manifest.js');
const { loadMatrix, dependencySet } = require('../lib/pcf-matrix.js');

const ROOT = path.join(__dirname, '..', '..');
const MATRIX = loadMatrix();
const RECIPE_FIXTURES = path.join(__dirname, 'fixtures', 'pcf-recipes');

function loadScaffold() {
  delete require.cache[require.resolve('../lib/pcf-scaffold.js')];
  return require('../lib/pcf-scaffold.js');
}

function findFile(plan, relPath) {
  const file = plan.files.find((item) => item.relPath === relPath);
  assert.ok(file, `${relPath} was not rendered`);
  return file.content;
}

function renderFieldPlan(overrides = {}) {
  return renderTemplatePlan('field-standard', overrides);
}

function renderTemplatePlan(template, overrides = {}) {
  const scaffold = loadScaffold();
  return scaffold.planScaffold({
    template,
    namespace: 'Contoso.Controls',
    name: 'StarRating',
    displayName: 'Star rating',
    description: 'Rates a record with stars.',
    hosts: ['model'],
    ...overrides,
  });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function walkFiles(dir) {
  const files = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        files.push(full);
      }
    }
  };
  walk(dir);
  return files;
}

test('listTemplates exposes the data-only template catalog', () => {
  const { listTemplates } = loadScaffold();

  assert.deepEqual(listTemplates(), [
    { id: 'dataset-standard', controlType: 'standard', kind: 'dataset', hosts: ['model'] },
    { id: 'dataset-virtual', controlType: 'virtual', kind: 'dataset', hosts: ['model'] },
    { id: 'field-standard', controlType: 'standard', kind: 'field', hosts: ['model', 'pages'] },
    { id: 'field-virtual', controlType: 'virtual', kind: 'field', hosts: ['model'] },
  ]);
});

test('listRecipes and renderRecipesTable handle an empty recipe catalog', () => {
  const { listRecipes, renderRecipesTable } = loadScaffold();
  const recipesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-scaffold-empty-recipes-'));
  try {
    assert.deepEqual(listRecipes({ recipesRoot }), []);
    assert.equal(renderRecipesTable({ recipesRoot }), [
      '<!-- pcf-recipes:begin -->',
      '| Recipe | Template | Designed for (hosts) | Certified | Status |',
      '| --- | --- | --- | --- | --- |',
      '| _No recipes yet._ |  |  |  |  |',
      '<!-- pcf-recipes:end -->',
      '',
    ].join('\n'));
  } finally {
    fs.rmSync(recipesRoot, { recursive: true, force: true });
  }
});

test('listRecipes and renderRecipesTable expose recipe status and certification', () => {
  const { listRecipes, renderRecipesTable } = loadScaffold();

  assert.deepEqual(listRecipes({ recipesRoot: RECIPE_FIXTURES }), [
    {
      id: 'dataset-overlay',
      title: 'Dataset overlay',
      template: 'dataset-standard',
      hosts: ['model'],
      status: 'available',
      certified: { model: { dataset: '2026-09-29' }, pages: {} },
    },
    {
      id: 'field-overlay',
      title: 'Field overlay',
      template: 'field-standard',
      hosts: ['model', 'pages'],
      status: 'available',
      certified: { model: { field: '2026-09-29' }, pages: {} },
    },
    {
      id: 'planned-only',
      title: 'Planned only',
      template: 'field-standard',
      hosts: ['model'],
      status: 'planned',
      certified: { model: {}, pages: {} },
    },
    {
      id: 'unsafe-overlay',
      title: 'Unsafe overlay',
      template: 'field-standard',
      hosts: ['model'],
      status: 'available',
      certified: { model: {}, pages: {} },
    },
  ]);
  assert.equal(renderRecipesTable({ recipesRoot: RECIPE_FIXTURES }), [
    '<!-- pcf-recipes:begin -->',
    '| Recipe | Template | Designed for (hosts) | Certified | Status |',
    '| --- | --- | --- | --- | --- |',
    '| Dataset overlay (`dataset-overlay`) | `dataset-standard` | model | model dataset: 2026-09-29 | available |',
    '| Field overlay (`field-overlay`) | `field-standard` | model, pages | model field: 2026-09-29; pages: not certified in this release | available |',
    '| Planned only (`planned-only`) | `field-standard` | model | model: not certified in this release | planned |',
    '| Unsafe overlay (`unsafe-overlay`) | `field-standard` | model | model: not certified in this release | available |',
    '<!-- pcf-recipes:end -->',
    '',
  ].join('\n'));
});

test('applyRecipeManifest replaces field properties, feature usage, and escapes attributes exactly', () => {
  const { applyRecipeManifest } = loadScaffold();
  const xml = [
    '<manifest>',
    '  <control namespace="N" constructor="C">',
    '    <external-service-usage enabled="false" />',
    '    <property name="old" display-name-key="Old" description-key="Old_Desc" of-type="SingleLine.Text" usage="bound" required="true" />',
    '    <resources />',
    '    <!-- marker -->',
    '  </control>',
    '</manifest>',
    '',
  ].join('\n');
  const patched = applyRecipeManifest(xml, {
    properties: [{
      name: 'rating&score',
      displayNameKey: 'Rating "Display"',
      descriptionKey: "Rating's <Description>",
      ofType: 'Whole.None',
      usage: 'bound',
      required: true,
    }, {
      name: 'max',
      displayNameKey: 'Max_Display',
      descriptionKey: 'Max_Desc',
      ofType: 'Whole.None',
      usage: 'input',
      required: false,
      defaultValue: '5 & more',
    }],
    features: [{ name: 'WebAPI', required: false }],
  });

  assert.equal(patched, [
    '<manifest>',
    '  <control namespace="N" constructor="C">',
    '    <external-service-usage enabled="false" />',
    '    <property name="rating&amp;score" display-name-key="Rating &quot;Display&quot;" description-key="Rating&apos;s &lt;Description&gt;" of-type="Whole.None" usage="bound" required="true" />',
    '    <property name="max" display-name-key="Max_Display" description-key="Max_Desc" of-type="Whole.None" usage="input" required="false" default-value="5 &amp; more" />',
    '    <resources />',
    '    <!-- marker -->',
    '    <feature-usage>',
    '      <uses-feature name="WebAPI" required="false" />',
    '    </feature-usage>',
    '  </control>',
    '</manifest>',
    '',
  ].join('\n'));
});

test('applyRecipeManifest replaces dataset property-sets and existing feature usage exactly', () => {
  const { applyRecipeManifest } = loadScaffold();
  const xml = [
    '<manifest>',
    '  <control namespace="N" constructor="C">',
    '    <data-set name="sampleDataSet" display-name-key="Dataset_Display_Key">',
    '      <property-set name="old" display-name-key="Old" description-key="Old_Desc" of-type="SingleLine.Text" usage="bound" required="false" />',
    '    </data-set>',
    '    <resources />',
    '    <feature-usage>',
    '      <uses-feature name="OldFeature" required="true" />',
    '    </feature-usage>',
    '  </control>',
    '</manifest>',
    '',
  ].join('\n');
  const patched = applyRecipeManifest(xml, {
    propertySets: [{
      dataSet: 'sampleDataSet',
      name: 'parent',
      displayNameKey: 'Parent_Display',
      descriptionKey: 'Parent_Desc',
      ofType: 'Lookup.Simple',
      usage: 'bound',
      required: false,
    }],
    features: [{ name: 'Utility', required: true }],
  });

  assert.equal(patched, [
    '<manifest>',
    '  <control namespace="N" constructor="C">',
    '    <data-set name="sampleDataSet" display-name-key="Dataset_Display_Key">',
    '      <property-set name="parent" display-name-key="Parent_Display" description-key="Parent_Desc" of-type="Lookup.Simple" usage="bound" required="false" />',
    '    </data-set>',
    '    <resources />',
    '    <feature-usage>',
    '      <uses-feature name="Utility" required="true" />',
    '    </feature-usage>',
    '  </control>',
    '</manifest>',
    '',
  ].join('\n'));
});


test('applyRecipeManifest patches one data-set property-set without changing a second data-set', () => {
  const { applyRecipeManifest } = loadScaffold();
  const untouched = [
    '    <data-set name="secondaryDataSet" display-name-key="Secondary_Display">',
    '      <property-set name="keep" display-name-key="Keep_Display" description-key="Keep_Desc" of-type="SingleLine.Text" usage="bound" required="false" />',
    '    </data-set>',
  ];
  const xml = [
    '<manifest>',
    '  <control namespace="N" constructor="C">',
    '    <data-set name="sampleDataSet" display-name-key="Dataset_Display_Key">',
    '      <property-set name="old" display-name-key="Old" description-key="Old_Desc" of-type="SingleLine.Text" usage="bound" required="false" />',
    '    </data-set>',
    ...untouched,
    '    <resources />',
    '  </control>',
    '</manifest>',
    '',
  ].join('\n');
  const patched = applyRecipeManifest(xml, {
    propertySets: [{
      dataSet: 'sampleDataSet',
      name: 'parent',
      displayNameKey: 'Parent_Display',
      descriptionKey: 'Parent_Desc',
      ofType: 'Lookup.Simple',
      usage: 'bound',
      required: false,
    }],
  });

  assert.equal(patched, [
    '<manifest>',
    '  <control namespace="N" constructor="C">',
    '    <data-set name="sampleDataSet" display-name-key="Dataset_Display_Key">',
    '      <property-set name="parent" display-name-key="Parent_Display" description-key="Parent_Desc" of-type="Lookup.Simple" usage="bound" required="false" />',
    '    </data-set>',
    ...untouched,
    '    <resources />',
    '  </control>',
    '</manifest>',
    '',
  ].join('\n'));
  assert.ok(patched.includes(untouched.join('\n')), 'secondary data-set bytes must stay unchanged');
});

test('applyRecipeManifest removes existing feature usage when recipe features are empty', () => {
  const { applyRecipeManifest } = loadScaffold();
  const xml = [
    '<manifest>',
    '  <control namespace="N" constructor="C">',
    '    <resources />',
    '    <feature-usage>',
    '      <uses-feature name="OldFeature" required="true" />',
    '    </feature-usage>',
    '  </control>',
    '</manifest>',
    '',
  ].join('\n');

  assert.equal(applyRecipeManifest(xml, { features: [] }), [
    '<manifest>',
    '  <control namespace="N" constructor="C">',
    '    <resources />',
    '  </control>',
    '</manifest>',
    '',
  ].join('\n'));
});

test('applyRecipeManifest leaves feature usage absent when the recipe has no features', () => {
  const { applyRecipeManifest } = loadScaffold();
  const xml = '<manifest>\n  <control namespace="N" constructor="C">\n    <resources />\n  </control>\n</manifest>\n';

  assert.equal(applyRecipeManifest(xml, {}), xml);
});

test('recipe overlay replaces and adds rendered files before patching a lint-clean manifest', () => {
  const plan = renderFieldPlan({ recipe: 'field-overlay', recipesRoot: RECIPE_FIXTURES, hosts: ['model', 'pages'] });

  assert.equal(findFile(plan, path.join('StarRating', 'index.ts')).trim(), 'export const recipeName = "StarRating";');
  assert.equal(findFile(plan, path.join('StarRating', 'css', 'recipe.css')).trim(), '.StarRating-recipe { color: red; }');
  const manifestXml = findFile(plan, path.join('StarRating', 'ControlManifest.Input.xml'));
  const parsed = parseManifest(manifestXml);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.model.properties.map((prop) => prop.name), ['rating', 'max']);
  assert.deepEqual(parsed.model.features, [{ name: 'WebAPI', required: false }]);
  assert.deepEqual(lintManifest(parsed.model, { hosts: ['model', 'pages'], matrix: MATRIX }), { ok: true, errors: [], warnings: [] });
});

test('recipe overlay patches dataset property-sets in the named data-set', () => {
  const plan = renderTemplatePlan('dataset-standard', { recipe: 'dataset-overlay', recipesRoot: RECIPE_FIXTURES });
  const manifestXml = findFile(plan, path.join('StarRating', 'ControlManifest.Input.xml'));
  const parsed = parseManifest(manifestXml);

  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.model.dataSets[0].propertySets, [{
    name: 'parent',
    usage: 'bound',
    ofType: 'Lookup.Simple',
    ofTypeGroup: undefined,
    required: false,
  }]);
  assert.deepEqual(lintManifest(parsed.model, { hosts: ['model'], matrix: MATRIX }), { ok: true, errors: [], warnings: [] });
});

test('unsafe recipe overlay paths are rejected before rendering', () => {
  const { planScaffold } = loadScaffold();

  assert.throws(
    () => planScaffold({ template: 'field-standard', recipe: 'unsafe-overlay', namespace: 'Contoso.Controls', name: 'StarRating', displayName: '..\\escape', recipesRoot: RECIPE_FIXTURES }),
    /unsafe scaffold path.*\.\.\\escape\.txt/,
  );
});

test('planned recipes cannot be scaffolded', () => {
  const { planScaffold } = loadScaffold();

  assert.throws(
    () => planScaffold({ template: 'field-standard', recipe: 'planned-only', namespace: 'Contoso.Controls', name: 'StarRating', displayName: '..\\escape', recipesRoot: RECIPE_FIXTURES }),
    /planned, not available in this release/,
  );
});

test('listRecipes rejects malformed recipe metadata with clear validation errors', () => {
  const { listRecipes } = loadScaffold();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-scaffold-recipe-meta-'));
  try {
    const dir = path.join(root, 'broken');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'recipe.json'), JSON.stringify({
      id: 'wrong',
      title: '',
      summary: '',
      template: 'missing-template',
      hosts: ['bad'],
      status: 'available',
      certified: { model: { field: '09-29-2026' }, pages: [] },
      properties: [{ name: '', usage: 'weird', required: 'yes' }],
    }));

    assert.throws(() => listRecipes({ recipesRoot: root }), /recipe\.json: id must equal directory name 'broken'; title must be a non-empty string; summary must be a non-empty string; template must be an existing template id; hosts must be a non-empty array containing only template hosts; whyWanted must be a non-empty string; certified\.model\.field must be YYYY-MM-DD; certified\.pages must be an object; configuration must be a non-empty string; properties\[0\]\.name must be a non-empty string; properties\[0\]\.displayNameKey must be a non-empty string; properties\[0\]\.descriptionKey must be a non-empty string; properties\[0\]\.ofType must be a non-empty string; properties\[0\]\.usage must be bound, input, or output; properties\[0\]\.required must be boolean/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('listRecipes rejects planned recipe metadata without explicit certification', () => {
  const { listRecipes } = loadScaffold();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-scaffold-planned-cert-'));
  try {
    const dir = path.join(root, 'planned-missing-cert');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'recipe.json'), JSON.stringify({
      id: 'planned-missing-cert',
      title: 'Planned missing certification',
      summary: 'A planned recipe without certification metadata.',
      template: 'field-standard',
      hosts: ['model'],
      whyWanted: 'Exercises explicit certification validation.',
      status: 'planned',
    }));

    assert.throws(
      () => listRecipes({ recipesRoot: root }),
      /recipe\.json: certified must be \{ "model": \{\}, "pages": \{\} \} or host journey date maps/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI --list shows recipe status and --recipe output names the recipe', () => {
  const { loadCli } = require('./helpers/cli-harness.js');
  const cli = path.join(ROOT, 'scripts', 'pcf-scaffold.js');
  const realAuth = require('../lib/dataverse-auth.js');
  const emitted = [];
  const dataverseAuth = { ...realAuth, emitResult: (ok, payload) => { emitted.push({ ok, payload }); } };
  const calls = [];
  const harness = loadCli(cli, {
    requires: {
      './lib/pcf-scaffold': {
        listTemplates: () => [{ id: 'field-standard' }],
        listRecipes: () => [{ id: 'field-overlay', title: 'Field overlay', template: 'field-standard', hosts: ['model'], status: 'available', certified: { model: {}, pages: {} } }],
        planScaffold: (request) => { calls.push(request); return { files: [], warnings: [], recipe: { id: 'field-overlay', title: 'Field overlay', status: 'available' } }; },
        writeScaffold: () => ({ written: ['project-file'] }),
      },
      './lib/dataverse-auth': dataverseAuth,
      './lib/node-tool': { runNpm: () => ({ status: 0, stdout: '', stderr: '' }) },
    },
  });

  harness.main(['--list']);
  assert.equal(emitted.at(-1).payload.recipes[0].status, 'available');

  const createHarness = loadCli(cli, {
    requires: {
      './lib/pcf-scaffold': {
        listTemplates: () => [],
        listRecipes: () => [],
        planScaffold: (request) => { calls.push(request); return { files: [], warnings: [], recipe: { id: 'field-overlay', title: 'Field overlay', status: 'available' } }; },
        writeScaffold: () => ({ written: ['project-file'] }),
      },
      './lib/dataverse-auth': dataverseAuth,
      './lib/node-tool': { runNpm: () => ({ status: 0, stdout: '', stderr: '' }) },
    },
  });
  createHarness.main(['--template', 'field-standard', '--namespace', 'Contoso.Controls', '--name', 'StarRating', '--out', 'project', '--recipe', 'field-overlay']);
  const parsed = emitted.at(-1).payload;
  assert.equal(parsed.recipe, 'field-overlay');
  assert.equal(parsed.recipeTitle, 'Field overlay');
  assert.equal(calls.at(-1).recipe, 'field-overlay');
});

test('CLI rejects valued boolean scaffold switches before listing or writing', () => {
  const { loadCli } = require('./helpers/cli-harness.js');
  const cli = path.join(ROOT, 'scripts', 'pcf-scaffold.js');
  const realAuth = require('../lib/dataverse-auth.js');
  const dataverseAuth = {
    ...realAuth,
    emitResult: () => {
      throw new Error('emitResult should not run for usage errors');
    },
  };

  for (const flag of ['--list=false', '--install=false']) {
    let sideEffect = false;
    const argv = flag === '--list=false'
      ? [flag]
      : ['--template', 'field-standard', '--namespace', 'Contoso.Controls', '--name', 'StarRating', '--out', 'project', flag];
    const harness = loadCli(cli, {
      argv,
      requires: {
        './lib/pcf-scaffold': {
          listTemplates: () => { sideEffect = true; return []; },
          listRecipes: () => { sideEffect = true; return []; },
          planScaffold: () => {
            sideEffect = true;
            return { files: [], warnings: [], recipe: null };
          },
          writeScaffold: () => {
            sideEffect = true;
            return { written: [] };
          },
        },
        './lib/dataverse-auth': dataverseAuth,
        './lib/node-tool': { runNpm: () => ({ status: 0, stdout: '', stderr: '' }) },
      },
    });

    try {
      harness.main(argv);
    } catch (err) {
      if (!String(err && err.message).startsWith('process.exit(')) throw err;
    }

    assert.equal(harness.exitCode, 1, flag);
    assert.match(harness.stderrText(), /--(?:list|install) does not take a value/, flag);
    assert.equal(harness.stdoutText(), '', flag);
    assert.equal(sideEffect, false, flag);
  }
});

test('listTemplates rejects malformed template metadata before exposing the catalog', () => {
  const { listTemplates } = loadScaffold();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-scaffold-template-meta-'));
  try {
    const dir = path.join(root, 'templates', 'broken');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'template.json'), JSON.stringify({ id: 'broken', hosts: 'model' }));

    assert.throws(() => listTemplates({ root }), /template\.json.*controlType/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('planScaffold renders field-standard without leftover placeholders and with a clean manifest', () => {
  const plan = renderFieldPlan();

  for (const file of plan.files) {
    assert.doesNotMatch(file.relPath, /\{\{[^}]+\}\}/, file.relPath);
    assert.doesNotMatch(file.content, /\{\{[^}]+\}\}/, file.relPath);
  }

  const manifestXml = findFile(plan, path.join('StarRating', 'ControlManifest.Input.xml'));
  const parsed = parseManifest(manifestXml);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(lintManifest(parsed.model, { hosts: ['model'], matrix: MATRIX }), { ok: true, errors: [], warnings: [] });
  assert.deepEqual(lintManifest(parsed.model, { hosts: ['pages'], matrix: MATRIX }), { ok: true, errors: [], warnings: [] });
  assert.doesNotMatch(manifestXml, /<uses-feature\b/);
  assert.doesNotMatch(manifestXml, /<feature-usage\b/);
  assert.match(manifestXml, /Features are declared only when this control's code uses them\./);
});

test('planScaffold renders every template without leftover placeholders and with clean model manifests', () => {
  const cases = [
    { id: 'field-standard', dependencySet: 'standard', controlType: 'standard', kind: 'field' },
    { id: 'dataset-standard', dependencySet: 'standard', controlType: 'standard', kind: 'dataset' },
    { id: 'field-virtual', dependencySet: 'virtual', controlType: 'virtual', kind: 'field' },
    { id: 'dataset-virtual', dependencySet: 'virtual', controlType: 'virtual', kind: 'dataset' },
  ];

  for (const item of cases) {
    const plan = renderTemplatePlan(item.id);
    for (const file of plan.files) {
      assert.doesNotMatch(file.relPath, /\{\{[^}]+\}\}/, `${item.id} ${file.relPath}`);
      assert.doesNotMatch(file.content, /\{\{[^}]+\}\}/, `${item.id} ${file.relPath}`);
    }

    const manifestXml = findFile(plan, path.join('StarRating', 'ControlManifest.Input.xml'));
    const parsed = parseManifest(manifestXml);
    assert.deepEqual(parsed.errors, [], item.id);
    assert.deepEqual(lintManifest(parsed.model, { hosts: ['model'], matrix: MATRIX }), { ok: true, errors: [], warnings: [] }, item.id);
    assert.equal(parsed.model.control.controlType, item.controlType);
    assert.equal(parsed.model.dataSets.length, item.kind === 'dataset' ? 1 : 0);
    assert.equal(parsed.model.properties.length, item.kind === 'field' ? 1 : 0);
    assert.doesNotMatch(manifestXml, /<feature-usage\b/, item.id);
    assert.match(manifestXml, /Features are declared only when this control's code uses them\./, item.id);

    const pkg = JSON.parse(findFile(plan, 'package.json'));
    const expected = dependencySet(MATRIX, item.dependencySet);
    assert.deepEqual(pkg.scripts, {
      build: 'pcf-scripts build',
      clean: 'pcf-scripts clean',
      lint: 'pcf-scripts lint',
      'lint:fix': 'pcf-scripts lint fix',
      rebuild: 'pcf-scripts rebuild',
      start: 'pcf-scripts start',
      'start:watch': 'pcf-scripts start watch',
      refreshTypes: 'pcf-scripts refreshTypes',
      test: 'jest --runInBand',
    }, `${item.id} scripts`);
    assert.deepEqual(pkg.dependencies || {}, expected.dependencies, `${item.id} dependencies`);
    assert.deepEqual(pkg.devDependencies || {}, expected.devDependencies, `${item.id} devDependencies`);
  }
});

test('virtual templates declare platform libraries from the compatibility matrix', () => {
  for (const id of ['field-virtual', 'dataset-virtual']) {
    const manifestXml = findFile(renderTemplatePlan(id), path.join('StarRating', 'ControlManifest.Input.xml'));
    const parsed = parseManifest(manifestXml);

    assert.deepEqual(parsed.model.resources.platformLibraries, [
      { name: 'React', version: MATRIX.platformLibraries.React.recommendedBaseline.version },
      { name: 'Fluent', version: MATRIX.platformLibraries.Fluent.recommendedBaseline.version },
    ], id);
  }
});

test('template sources do not hard-code React or Fluent platform-library versions', () => {
  const offenders = [];
  for (const root of [path.join(ROOT, 'templates'), path.join(ROOT, 'shared')]) {
    for (const file of walkFiles(root)) {
      const text = fs.readFileSync(file, 'utf8');
      if (/<platform-library\b[^>]*\bversion="\d+\.\d+\.\d+"/.test(text)) {
        offenders.push(path.relative(ROOT, file));
      }
      if (/"(?:react|@fluentui\/react-components)"\s*:\s*"\d+\.\d+\.\d+"/.test(text)) {
        offenders.push(path.relative(ROOT, file));
      }
    }
  }

  assert.deepEqual(offenders, []);
});

test('template directories do not carry unused package templates', () => {
  const offenders = walkFiles(path.join(ROOT, 'templates'))
    .map((file) => path.relative(ROOT, file))
    .filter((file) => path.basename(file) === 'package.json.tmpl');

  assert.deepEqual(offenders, []);
});

test('dataset templates render sorted rows, page once at a time, and open records without refreshing in updateView', () => {
  for (const id of ['dataset-standard', 'dataset-virtual']) {
    const plan = renderTemplatePlan(id);
    const source = findFile(plan, path.join('StarRating', 'index.ts'));
    const viewSource = id === 'dataset-virtual' ? findFile(plan, path.join('StarRating', 'StarRatingView.tsx')) : '';
    const runtimeSource = source + viewSource;
    const templateTest = findFile(plan, path.join('__tests__', 'StarRating.test.ts'));

    assert.match(runtimeSource, /sortedRecordIds/, id);
    assert.match(runtimeSource, /loadNextPage/, id);
    assert.match(runtimeSource, /loadPreviousPage/, id);
    assert.match(runtimeSource, /openDatasetItem/, id);
    assert.doesNotMatch(source, /refresh\(\)/, id);
    assert.match(templateTest, /loading state/, id);
    assert.match(templateTest, /empty state/, id);
    assert.match(templateTest, /error state/, id);
    assert.match(templateTest, /sortedRecordIds order/, id);
    assert.match(templateTest, /next and previous paging/, id);
    assert.match(templateTest, /opens records/, id);
  }
});

test('field-virtual mirrors field-standard field behavior tests', () => {
  const templateTest = findFile(renderTemplatePlan('field-virtual'), path.join('__tests__', 'StarRating.test.ts'));

  for (const expected of [
    'null raw value renders an empty field',
    'missing parameter object does not crash',
    'disabled mode disables the input',
    'non-editable security renders read-only',
    'change notifies exactly once',
    'two instances keep independent state and DOM',
  ]) {
    assert.match(templateTest, new RegExp(escapeRegExp(expected)));
  }
});

test('planScaffold renders the template id into shared README content', () => {
  const readme = findFile(renderFieldPlan(), 'README.md');

  assert.match(readme, /from the `field-standard` template/);
  assert.doesNotMatch(readme, /\{\{template\}\}/);
});

test('planScaffold escapes display text for TypeScript and resx XML contexts', () => {
  const plan = renderFieldPlan({
    displayName: 'Star "Rating" & Score',
    description: 'Rates <records> & "scores".',
  });

  const source = findFile(plan, path.join('StarRating', 'index.ts'));
  const resx = findFile(plan, path.join('StarRating', 'strings', 'StarRating.1033.resx'));

  assert.match(source, /setAttribute\("aria-label", "Star \\"Rating\\" & Score"\)/);
  assert.match(resx, /<value>Star "Rating" &amp; Score<\/value>/);
  assert.match(resx, /<value>Rates &lt;records&gt; &amp; "scores"\.<\/value>/);
});

test('field-standard CSS classes are scoped to the generated control name', () => {
  const plan = renderFieldPlan();
  const source = findFile(plan, path.join('StarRating', 'index.ts'));
  const css = findFile(plan, path.join('StarRating', 'css', 'StarRating.css'));
  const templateTest = findFile(plan, path.join('__tests__', 'StarRating.test.ts'));

  assert.doesNotMatch(source + css + templateTest, /__controlClass__/);
  assert.match(source, /starrating-control/);
  assert.match(css, /\.starrating-control\b/);
  assert.match(templateTest, /\.starrating-control/);
});

test('planScaffold uses the standard dependency lock package exactly', () => {
  const plan = renderFieldPlan();
  const pkg = JSON.parse(findFile(plan, 'package.json'));
  const expected = JSON.parse(fs.readFileSync(path.join(dependencySet(MATRIX, 'standard').lockDir, 'package.json'), 'utf8'));
  expected.name = 'starrating';

  assert.deepEqual(pkg, expected);
  assert.equal(pkg.scripts.build, 'pcf-scripts build');
  assert.equal(pkg.scripts.clean, 'pcf-scripts clean');
});

test('planScaffold rewrites the package-lock root name', () => {
  const plan = renderFieldPlan();
  const lock = JSON.parse(findFile(plan, 'package-lock.json'));

  assert.equal(lock.name, 'starrating');
  assert.equal(lock.packages[''].name, 'starrating');
});

test('planScaffold puts production PcfBuildMode after Microsoft.Common.props', () => {
  const proj = findFile(renderFieldPlan(), 'StarRating.pcfproj');
  const importOffset = proj.indexOf('Microsoft.Common.props');
  const modeOffset = proj.indexOf('<PcfBuildMode>production</PcfBuildMode>');

  assert.notEqual(importOffset, -1);
  assert.notEqual(modeOffset, -1);
  assert.ok(modeOffset > importOffset, 'PcfBuildMode must be after Microsoft.Common.props so NuGet props cannot overwrite it');
  assert.match(proj, /pac pcf push otherwise builds a development bundle/);
  assert.match(proj, new RegExp(`Microsoft\\.PowerApps\\.MSBuild\\.Pcf" Version="${escapeRegExp(MATRIX.toolchain.msbuildPcf.version)}"`));
  assert.doesNotMatch(fs.readFileSync(__filename, 'utf8'), new RegExp(escapeRegExp(MATRIX.toolchain.msbuildPcf.version)));
});

test('rendered Jest setup suppresses only the pinned jsdom punycode deprecation', () => {
  const setup = findFile(renderFieldPlan(), path.join('test', 'jest-setup.js'));
  const config = findFile(renderFieldPlan(), 'jest.config.cjs');

  assert.match(setup, /DEP0040/);
  assert.doesNotMatch(setup, /process\.noDeprecation/);
  assert.deepEqual([...new Set([...setup.matchAll(/DEP\d{4}/g)].map((match) => match[0]))], ['DEP0040']);
  assert.match(setup, /transitive jsdom dependency/);
  assert.match(setup, /when the compatibility matrix moves to a jsdom chain that no longer requires the core `punycode` module/);
  assert.match(config, /test\/pcf-jest-environment\.cjs/);
});

test('mockDataSet renders first-class loading, error and paging options', () => {
  const kit = findFile(renderFieldPlan(), path.join('test', 'pcf-context.ts'));

  assert.match(kit, /export type MockDataSetOptions/);
  assert.match(kit, /options: MockDataSetOptions = \{\}/);
  assert.match(kit, /loading: options\.loading \?\? false/);
  assert.match(kit, /error: options\.error \?\? false/);
  assert.match(kit, /errorMessage: options\.errorMessage/);
  assert.match(kit, /hasNextPage: options\.hasNextPage \?\? false/);
});

test('planScaffold rejects Power Pages for virtual templates before rendering', () => {
  const { planScaffold } = loadScaffold();

  assert.throws(
    () => planScaffold({ template: 'field-virtual', namespace: 'Contoso.Controls', name: 'StarRating', hosts: ['pages'] }),
    /Power Pages does not support virtual/,
  );
});

test('planScaffold validates namespace and control names', () => {
  const { planScaffold } = loadScaffold();

  assert.throws(
    () => planScaffold({ template: 'field-standard', namespace: '1bad', name: 'StarRating' }),
    /Namespace segment "1bad"/,
  );
  assert.throws(
    () => planScaffold({ template: 'field-standard', namespace: 'Contoso.Controls', name: 'class' }),
    /reserved/,
  );
});

test('writeScaffold refuses a non-empty output directory', () => {
  const { writeScaffold } = loadScaffold();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-scaffold-nonempty-'));
  try {
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'existing');
    assert.throws(() => writeScaffold(renderFieldPlan(), dir), /exists and is not empty/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeScaffold reports an existing PCF project before the generic non-empty error', () => {
  const { writeScaffold } = loadScaffold();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-scaffold-project-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    assert.throws(() => writeScaffold(renderFieldPlan(), dir), /already contains a PCF project/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeScaffold rejects unsafe planned relative paths', () => {
  const { writeScaffold } = loadScaffold();
  const cases = ['..\\escape.txt', '/abs.txt', 'C:\\abs.txt'];
  for (const relPath of cases) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-scaffold-path-'));
    try {
      assert.throws(() => writeScaffold({ files: [{ relPath, content: 'bad' }], warnings: [] }, dir), /unsafe scaffold path/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('writeScaffold allows safe nested planned relative paths', () => {
  const { writeScaffold } = loadScaffold();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-scaffold-path-ok-'));
  try {
    const result = writeScaffold({ files: [{ relPath: path.join('nested', 'ok.txt'), content: 'ok' }], warnings: [] }, dir);

    assert.deepEqual(result.written, [path.join(dir, 'nested', 'ok.txt')]);
    assert.equal(fs.readFileSync(path.join(dir, 'nested', 'ok.txt'), 'utf8'), 'ok');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeScaffold writes a complete project into an empty directory', () => {
  const { writeScaffold } = loadScaffold();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-scaffold-write-'));
  try {
    const result = writeScaffold(renderFieldPlan(), dir);

    assert.ok(result.written.includes(path.join(dir, 'StarRating.pcfproj')));
    assert.ok(fs.existsSync(path.join(dir, 'StarRating', 'index.ts')));
    assert.ok(fs.existsSync(path.join(dir, 'test', 'pcf-context.ts')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI --list emits the available templates and recipes', () => {
  const { listRecipes } = loadScaffold();
  const cli = path.join(ROOT, 'scripts', 'pcf-scaffold.js');
  const result = spawnSync(process.execPath, [cli, '--list'], { cwd: ROOT, encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(parsed.templates.map((item) => item.id), ['dataset-standard', 'dataset-virtual', 'field-standard', 'field-virtual']);
  assert.deepEqual(parsed.recipes, listRecipes());
});

test('CLI scaffolds and threads --npm-cli into --install', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-scaffold-cli-'));
  const npmCli = path.join(dir, 'fake-npm-cli.js');
  const log = path.join(dir, 'npm-args.json');
  fs.writeFileSync(
    npmCli,
    [
      '#!/usr/bin/env node',
      `'use strict';`,
      `require('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));`,
    ].join('\n'),
  );

  try {
    const outDir = path.join(dir, 'project');
    const cli = path.join(ROOT, 'scripts', 'pcf-scaffold.js');
    const result = spawnSync(process.execPath, [
      cli,
      '--template', 'field-standard',
      '--namespace', 'Contoso.Controls',
      '--name', 'StarRating',
      '--out', outDir,
      '--install',
      '--npm-cli', npmCli,
    ], { cwd: ROOT, encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.outDir, outDir);
    // The fake npm records process.cwd(), which the OS reports as the physical path. On macOS that is
    // /private/var/... for an os.tmpdir() of /var/..., so compare against the resolved directory.
    assert.deepEqual(JSON.parse(fs.readFileSync(log, 'utf8')), { argv: ['ci'], cwd: fs.realpathSync(outDir) });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
