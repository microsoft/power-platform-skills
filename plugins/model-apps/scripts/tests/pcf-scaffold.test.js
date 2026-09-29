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
  const scaffold = loadScaffold();
  return scaffold.planScaffold({
    template: 'field-standard',
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

test('listTemplates exposes the data-only template catalog', () => {
  const { listTemplates } = loadScaffold();

  assert.deepEqual(listTemplates(), [
    { id: 'field-standard', controlType: 'standard', kind: 'field', hosts: ['model', 'pages'] },
  ]);
});

test('listRecipes and renderRecipesTable handle an empty recipe catalog', () => {
  const { listRecipes, renderRecipesTable } = loadScaffold();

  assert.deepEqual(listRecipes(), []);
  assert.equal(renderRecipesTable(), [
    '<!-- pcf-recipes:begin -->',
    '| Recipe | Template | Hosts |',
    '| --- | --- | --- |',
    '| _No recipes yet._ |  |  |',
    '<!-- pcf-recipes:end -->',
    '',
  ].join('\n'));
});

test('listTemplates rejects malformed template metadata before exposing the catalog', () => {
  const { listTemplates } = loadScaffold();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-scaffold-template-meta-'));
  try {
    const dir = path.join(root, 'pcf', 'templates', 'broken');
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
  const expected = dependencySet(MATRIX, 'standard');

  assert.equal(pkg.name, 'starrating');
  assert.deepEqual(pkg.dependencies || {}, expected.dependencies);
  assert.deepEqual(pkg.devDependencies || {}, expected.devDependencies);
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
  const cli = path.join(ROOT, 'scripts', 'pcf-scaffold.js');
  const result = spawnSync(process.execPath, [cli, '--list'], { cwd: ROOT, encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(parsed.templates.map((item) => item.id), ['field-standard']);
  assert.deepEqual(parsed.recipes, []);
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
    assert.deepEqual(JSON.parse(fs.readFileSync(log, 'utf8')), { argv: ['ci'], cwd: outDir });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
