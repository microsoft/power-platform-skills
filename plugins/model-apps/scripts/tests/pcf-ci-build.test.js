'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runCiBuild, packageSmokeTargets } = require('../pcf-ci-build.js');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-ci-build-test-'));
}

function deps(overrides = {}) {
  const calls = [];
  const templates = [
    { id: 'field-standard', controlType: 'standard', kind: 'field', hosts: ['model', 'pages'] },
    { id: 'field-virtual', controlType: 'virtual', kind: 'field', hosts: ['model'] },
    { id: 'dataset-standard', controlType: 'standard', kind: 'dataset', hosts: ['model'] },
  ];
  const recipes = [
    { id: 'star-rating', template: 'field-standard', hosts: ['model', 'pages'], status: 'available' },
    { id: 'grid-customizer', template: 'field-virtual', hosts: ['model'], status: 'available' },
    { id: 'planned-only', template: 'field-standard', hosts: ['model'], status: 'planned' },
  ];
  const matrix = {
    dependencySets: {
      standard: { lockDir: 'pcf/lock/standard' },
      virtual: { lockDir: 'pcf/lock/virtual' },
    },
  };
  return {
    calls,
    fs,
    os: { tmpdir: () => overrides.tmp || tmpRoot() },
    listTemplates: () => templates,
    listRecipes: () => recipes,
    loadMatrix: () => matrix,
    dependencySet: (_matrix, setName) => ({
      dependencies: setName === 'virtual' ? { react: '16.14.0' } : { '@fluentui/react-components': '9.46.2' },
      devDependencies: { 'pcf-scripts': '1.51.1' },
    }),
    planScaffold: (request) => {
      calls.push(['plan', request.template, request.recipe || null, request.hosts]);
      return { files: [] };
    },
    writeScaffold: (_plan, outDir) => {
      calls.push(['write', path.basename(outDir)]);
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'package.json'), '{"name":"x"}\n');
      fs.mkdirSync(path.join(outDir, 'Control'), { recursive: true });
      fs.writeFileSync(path.join(outDir, 'Control', 'ControlManifest.Input.xml'), '<control version="0.0.1" />');
      return { written: [] };
    },
    runNpm: (args, opts) => {
      calls.push(['npm', args, path.basename(opts.cwd), opts.npmCli || null]);
      if (String(args[0]) === 'install') {
        for (const spec of args.slice(1)) {
          const at = spec.lastIndexOf('@');
          const pkg = spec.slice(0, at);
          const dir = path.join(opts.cwd, 'node_modules', ...pkg.split('/'));
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '99.0.0' }));
        }
      }
      return { status: 0, stdout: '', stderr: '' };
    },
    runGates: (projectDir, hosts) => {
      calls.push(['gates', path.basename(projectDir), hosts]);
      return { status: 0, stdout: JSON.stringify({ ok: true, gates: [{ id: 'build', ok: true }] }), stderr: '' };
    },
    ...overrides,
  };
}

test('selects one template target and forwards npm-cli through npm ci before gates', () => {
  const d = deps();

  const result = runCiBuild({ template: 'field-standard', npmCli: 'D:\\tools\\npm-cli.js' }, d);

  assert.equal(result.ok, true);
  assert.deepEqual(result.results.map((item) => [item.id, item.kind, item.ok]), [
    ['field-standard', 'template', true],
  ]);
  assert.deepEqual(d.calls.filter((call) => call[0] === 'npm'), [
    ['npm', ['ci'], 'field-standard', 'D:\\tools\\npm-cli.js'],
  ]);
  assert.deepEqual(d.calls.find((call) => call[0] === 'gates'), ['gates', 'field-standard', ['model', 'pages']]);
});

test('--all runs every template and available recipe while reporting planned recipes as skipped', () => {
  const d = deps();

  const result = runCiBuild({ all: true }, d);

  assert.equal(result.ok, true);
  assert.deepEqual(result.results.map((item) => item.id), [
    'dataset-standard',
    'field-standard',
    'field-virtual',
    'grid-customizer',
    'star-rating',
  ]);
  assert.deepEqual(result.skipped, [{ id: 'planned-only', kind: 'recipe', reason: 'planned' }]);
  assert.equal(d.calls.filter((call) => call[0] === 'npm' && call[1][0] === 'ci').length, 5);
});

test('--latest installs every matrix package at latest and reports resolved versions', () => {
  const d = deps();

  const result = runCiBuild({ template: 'field-virtual', latest: true }, d);

  assert.equal(result.ok, true);
  assert.deepEqual(d.calls.filter((call) => call[0] === 'npm').map((call) => call[1]), [
    ['ci'],
    ['install', 'react@latest', 'pcf-scripts@latest'],
  ]);
  assert.deepEqual(result.results[0].latest.map((item) => [item.name, item.matrixVersion, item.resolvedVersion]), [
    ['react', '16.14.0', '99.0.0'],
    ['pcf-scripts', '1.51.1', '99.0.0'],
  ]);
});

test('removes temp work even when gates fail unless --keep is set', () => {
  const root = tmpRoot();
  const d = deps({
    tmp: root,
    runGates: () => ({ status: 1, stdout: JSON.stringify({ ok: false, gates: [{ id: 'build', ok: false }] }), stderr: '' }),
  });

  const result = runCiBuild({ template: 'field-standard' }, d);

  assert.equal(result.ok, false);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('--keep preserves the temp work directory for diagnostics', () => {
  const root = tmpRoot();
  const d = deps({ tmp: root });

  runCiBuild({ template: 'field-standard', keep: true }, d);

  assert.deepEqual(fs.readdirSync(root).length, 1);
});

test('--package uses the package smoke target set and verifies package contents', () => {
  const d = deps({
    runPackageSmoke: (target, projectDir) => {
      d.calls.push(['package', target.id, path.basename(projectDir)]);
      return { ok: true, zip: path.join(projectDir, 'bin', 'Release', `${target.id}.zip`), checks: [{ id: 'managed', ok: true }] };
    },
  });

  const result = runCiBuild({ package: true }, d);

  assert.equal(result.ok, true);
  assert.deepEqual(result.results.map((item) => [item.id, item.kind, item.package.ok]), [
    ['field-virtual', 'template', true],
    ['grid-customizer', 'recipe', true],
    ['star-rating', 'recipe', true],
  ]);
  assert.deepEqual(packageSmokeTargets(d).map((item) => item.id), ['field-virtual', 'grid-customizer', 'star-rating']);
});
