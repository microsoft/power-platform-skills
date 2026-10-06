'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runCiBuild, packageSmokeTargets, inspectSolutionZip, runPackageSmoke } = require('../pcf-ci-build.js');

// The suite runs on every PR and every local check, so a scratch root left behind leaks one per test
// into the machine's temp folder. Every root tmpRoot() creates, including the ones handed to the
// runner as its injected os.tmpdir() and the one the --keep test deliberately preserves, is removed
// when this file finishes.
const createdRoots = [];
function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-ci-build-test-'));
  createdRoots.push(root);
  return root;
}
test.after(() => {
  for (const root of createdRoots) fs.rmSync(root, { recursive: true, force: true });
});

function deps(overrides = {}) {
  const calls = [];
  // Progress lines are captured rather than written to the test runner's stderr.
  const progressLines = [];
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
      standard: { lockDir: 'lock/standard' },
      virtual: { lockDir: 'lock/virtual' },
    },
  };
  return {
    calls,
    progressLines,
    progress: (line) => progressLines.push(line),
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
      return { status: 0, stdout: JSON.stringify({ ok: true, gates: ['manifest', 'code', 'lint', 'test', 'build'].map((id) => ({ id, ok: true })) }), stderr: '' };
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

test('--templates runs every template and no recipes', () => {
  const d = deps();

  const result = runCiBuild({ templates: true }, d);

  assert.equal(result.ok, true);
  assert.deepEqual(result.results.map((item) => item.id), ['dataset-standard', 'field-standard', 'field-virtual']);
  assert.ok(result.results.every((item) => item.kind === 'template'));
  // Recipes are not in scope for this selector, so nothing is reported as skipped for them.
  assert.deepEqual(result.skipped, []);
  assert.equal(d.calls.filter((call) => call[0] === 'npm' && call[1][0] === 'ci').length, 3);
});

test('the CLI accepts --templates and still requires exactly one selector', () => {
  const { spawnSync } = require('node:child_process');
  const cli = path.join(__dirname, '..', 'pcf-ci-build.js');
  const both = spawnSync(process.execPath, [cli, '--templates', '--all'], { encoding: 'utf8' });
  assert.equal(both.status, 1);
  assert.match(both.stderr, /Choose exactly one of --all, --templates, --template <id>, --recipe <id>, or --package\./);
  const valued = spawnSync(process.execPath, [cli, '--templates=field-standard'], { encoding: 'utf8' });
  assert.equal(valued.status, 1);
});

// Durations are wall-clock, so they are normalized before comparing.
const normalizeSeconds = (line) => line.replace(/\(\d+s\)$/, '(Ns)');

test('reports each step as it starts and ends, then each target with its position and outcome', () => {
  const d = deps();

  const result = runCiBuild({ templates: true }, d);

  assert.equal(result.ok, true);
  assert.deepEqual(d.progressLines.filter((line) => line.includes('dataset-standard')).map(normalizeSeconds), [
    '[pcf-ci-build] [1/3] dataset-standard (template): npm ci ...',
    '[pcf-ci-build] [1/3] dataset-standard (template): npm ci ok (Ns)',
    '[pcf-ci-build] [1/3] dataset-standard (template): gates ...',
    '[pcf-ci-build] [1/3] dataset-standard (template): gates ok (Ns)',
    '[pcf-ci-build] [1/3] dataset-standard (template) ok (Ns)',
  ]);
  assert.equal(d.progressLines.length, 15);
  assert.equal(normalizeSeconds(d.progressLines.at(-1)), '[pcf-ci-build] [3/3] field-virtual (template) ok (Ns)');
});

test('progress marks a failed step and its target, including a step that throws', () => {
  const gatesFail = deps({
    runGates: () => ({ status: 1, stdout: JSON.stringify({ ok: false, gates: [{ id: 'lint', ok: false }] }), stderr: '' }),
  });
  runCiBuild({ template: 'field-standard' }, gatesFail);
  assert.deepEqual(gatesFail.progressLines.slice(-2).map(normalizeSeconds), [
    '[pcf-ci-build] [1/1] field-standard (template): gates failed (Ns)',
    '[pcf-ci-build] [1/1] field-standard (template) FAILED (Ns)',
  ]);

  // probeLatestDependencies throws when an install fails; the step still gets its closing line.
  const latestFails = deps({
    runNpm: (args) => (String(args[0]) === 'install' ? { status: 1, stdout: '', stderr: 'registry unavailable' } : { status: 0, stdout: '', stderr: '' }),
  });
  const result = runCiBuild({ template: 'field-standard', latest: true }, latestFails);
  assert.equal(result.ok, false);
  assert.deepEqual(latestFails.progressLines.slice(-3).map(normalizeSeconds), [
    '[pcf-ci-build] [1/1] field-standard (template): npm install @latest ...',
    '[pcf-ci-build] [1/1] field-standard (template): npm install @latest failed (Ns)',
    '[pcf-ci-build] [1/1] field-standard (template) FAILED (Ns)',
  ]);
});

test('gates fail when pcf-gates emits no parseable JSON result', () => {
  for (const [label, stdout] of [
    ['empty stdout', ''],
    ['non-JSON stdout', 'gates passed\n'],
    ['truncated JSON stdout', '{"ok":true,"gates":['],
  ]) {
    const d = deps({ runGates: () => ({ status: 0, stdout, stderr: `${label} diagnostic` }) });

    const result = runCiBuild({ template: 'field-standard' }, d);

    assert.equal(result.ok, false, label);
    assert.match(result.results[0].error, /pcf-gates did not emit valid JSON/i);
    assert.equal(result.results[0].gates.length, 0);
  }
});

function passingGateRecords() {
  return ['manifest', 'code', 'lint', 'test', 'build'].map((id) => ({ id, ok: true }));
}

test('gates accept only one JSON result with the five passing gate records', () => {
  const valid = JSON.stringify({ ok: true, gates: passingGateRecords() });
  const longDiagnostic = `diagnostic ${'x'.repeat(4000)}`;
  const cases = [
    ['missing gates', JSON.stringify({ ok: true, gates: [{ id: 'manifest', ok: true }] }), 'missing gates diagnostic'],
    ['empty records', JSON.stringify({ ok: true, gates: [{}, {}, {}, {}, {}] }), 'empty records diagnostic'],
    ['failed records', JSON.stringify({ ok: true, gates: passingGateRecords().map((gate) => ({ ...gate, ok: gate.id !== 'lint' })) }), 'failed records diagnostic'],
    ['multiple JSON results', `${valid}\n${JSON.stringify({ ok: true, gates: passingGateRecords() })}`, 'multiple JSON results diagnostic'],
  ];

  for (const [label, stdout, stderr] of cases) {
    const d = deps({ runGates: () => ({ status: 0, stdout, stderr }) });
    const result = runCiBuild({ template: 'field-standard' }, d);
    assert.equal(result.ok, false, label);
    assert.match(result.results[0].error, /manifest, code, lint, test, build|exactly one JSON/i, label);
    assert.match(result.results[0].error, /diagnostic/i, label);
  }

  const truncated = deps({ runGates: () => ({ status: 0, stdout: '{"ok":true', stderr: longDiagnostic }) });
  const truncatedResult = runCiBuild({ template: 'field-standard' }, truncated);
  assert.equal(truncatedResult.ok, false);
  assert.equal(truncatedResult.results[0].error.includes(longDiagnostic), false);

  const good = deps({ runGates: () => ({ status: 0, stdout: `${valid}\n`, stderr: '' }) });
  const passed = runCiBuild({ template: 'field-standard' }, good);
  assert.equal(passed.ok, true);
  assert.deepEqual(passed.results[0].gates.map((gate) => [gate.id, gate.ok]), passingGateRecords().map((gate) => [gate.id, gate.ok]));
});

test('gates fail when pcf-gates omits expected gate records', () => {
  const d = deps({ runGates: () => ({ status: 0, stdout: JSON.stringify({ ok: true, gates: [] }), stderr: '' }) });

  const result = runCiBuild({ template: 'field-standard' }, d);

  assert.equal(result.ok, false);
  assert.match(result.results[0].error, /pcf-gates did not report any gate records/i);
});

test('progress goes to stderr by default, one line per write', () => {
  const d = deps();
  delete d.progress;
  const written = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  try {
    runCiBuild({ template: 'field-standard' }, d);
  } finally {
    process.stderr.write = originalWrite;
  }

  assert.equal(written.length, 5);
  assert.ok(written.every((chunk) => /^\[pcf-ci-build\] [^\n]+\n$/.test(chunk)), JSON.stringify(written));
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

test('failed gates keep --latest resolved versions', () => {
  const d = deps({
    runGates: () => ({ status: 1, stdout: JSON.stringify({ ok: false, gates: [{ id: 'build', ok: false }] }), stderr: 'build failed' }),
  });

  const result = runCiBuild({ template: 'field-virtual', latest: true }, d);

  assert.equal(result.ok, false);
  assert.deepEqual(result.results[0].latest.map((item) => [item.name, item.matrixVersion, item.resolvedVersion]), [
    ['react', '16.14.0', '99.0.0'],
    ['pcf-scripts', '1.51.1', '99.0.0'],
  ]);
});

test('--latest records a target failure and continues when one latest install fails', () => {
  const d = deps({
    runNpm: (args, opts) => {
      d.calls.push(['npm', args, path.basename(opts.cwd), opts.npmCli || null]);
      if (String(args[0]) === 'install' && path.basename(opts.cwd) === 'field-standard') {
        return { status: 1, stdout: '', stderr: 'registry unavailable' };
      }
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
  });

  const result = runCiBuild({ all: true, latest: true }, d);

  assert.equal(result.ok, false);
  assert.equal(result.results.length, 5);
  assert.equal(result.results.find((item) => item.id === 'field-standard').ok, false);
  assert.match(result.results.find((item) => item.id === 'field-standard').error, /npm install latest failed for field-standard: registry unavailable/);
  assert.equal(result.results.find((item) => item.id === 'field-virtual').ok, true);
  assert.ok(d.calls.some((call) => call[0] === 'gates' && call[1] === 'field-virtual'));
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
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8')).scripts, undefined);
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

test('package smoke runs pac solution init, add-reference, then managed dotnet build', () => {
  const projectDir = tmpRoot();
  const controlDir = path.join(projectDir, 'Control');
  const productionBundle = Buffer.from('production-bytes');
  const developmentBundle = Buffer.from('development-bytes-longer');
  fs.writeFileSync(path.join(projectDir, 'package.json'), '{"name":"x"}\n');
  fs.mkdirSync(controlDir, { recursive: true });
  fs.writeFileSync(path.join(controlDir, 'ControlManifest.Input.xml'), '<manifest><control version="0.0.1" /></manifest>');
  fs.writeFileSync(path.join(controlDir, 'bundle.js'), productionBundle);
  const calls = [];

  const result = runPackageSmoke({ id: 'star-rating' }, projectDir, {}, {
    runPcfBuild: (_dir, mode) => {
      const content = mode === 'production' ? productionBundle : developmentBundle;
      fs.writeFileSync(path.join(controlDir, 'bundle.js'), content);
      return {
        ok: true,
        mode,
        controls: [{ bundleBytes: content.length, controlDir, referenced: ['bundle.js'] }],
      };
    },
    runPac: (args, opts) => {
      calls.push(['pac', args, path.basename(opts.cwd), opts.timeoutMs]);
      if (args.join(' ') === 'solution init --publisher-name Contoso --publisher-prefix contoso') {
        fs.mkdirSync(path.join(opts.cwd, 'Other'), { recursive: true });
        fs.writeFileSync(path.join(opts.cwd, 'Other', 'Solution.xml'), '<ImportExportXml><SolutionManifest><Version>0.0.0</Version></SolutionManifest></ImportExportXml>');
      }
      return { status: 0, stdout: '', stderr: '' };
    },
    spawnResultSync: (command, args, opts) => {
      calls.push([command, args, path.basename(opts.cwd), opts.encoding]);
      fs.mkdirSync(path.join(opts.cwd, 'bin', 'Release'), { recursive: true });
      writeZip(path.join(opts.cwd, 'bin', 'Release', 'solution.zip'), {
        'solution.xml': '<ImportExportXml><SolutionManifest><Managed>1</Managed><RootComponents><RootComponent type="66" /></RootComponents></SolutionManifest></ImportExportXml>',
        'customizations.xml': '<ImportExportXml><CustomControls /></ImportExportXml>',
        'Controls/ControlManifest.xml': '<control version="1.0.0"><resources><code path="bundle.js" order="1" /></resources></control>',
        'Controls/bundle.js': productionBundle,
      });
      return { status: 0, stdout: '', stderr: '' };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    ['pac', ['solution', 'init', '--publisher-name', 'Contoso', '--publisher-prefix', 'contoso'], '_solution', 120000],
    ['pac', ['solution', 'add-reference', '--path', projectDir], '_solution', 120000],
    ['dotnet', ['build', '-c', 'Release', '-p:SolutionPackageType=Managed'], '_solution', 'utf8'],
  ]);
});

test('inspectSolutionZip rejects an XML-only package', () => {
  const result = inspectSolutionZip(writeSmokeZip(), '1.0.0', {
    productionBytes: 10,
    developmentBytes: 20,
  });

  assert.equal(result.ok, false);
  const check = result.checks.find((item) => item.id === 'embedded-bundle-resources');
  assert.ok(check);
  assert.equal(check.ok, false);
});

test('inspectSolutionZip parses a spaced single-quoted code path and requires the resource', () => {
  const missing = inspectSolutionZip(writeSmokeZip({
    'Controls/ControlManifest.xml': '<control version="1.0.0"><resources><code path = \'bundle.js\' order="1" /></resources></control>',
  }), '1.0.0', {
    productionBytes: 10,
    developmentBytes: 20,
    productionBundles: [{ path: 'bundle.js', content: Buffer.from('production') }],
    developmentBundles: [{ path: 'bundle.js', content: Buffer.from('development-longer') }],
  });

  assert.equal(missing.ok, false);
  assert.match(missing.checks.find((check) => check.id === 'embedded-bundle-resources').detail, /bundle\.js/);

  const productionBundle = Buffer.from('production-bytes');
  const developmentBundle = Buffer.from('development-bytes-longer');
  const accepted = inspectSolutionZip(writeSmokeZip({
    'Controls/ControlManifest.xml': '<control version="1.0.0"><resources><code path = \'bundle.js\' order="1" /></resources></control>',
    'Controls/bundle.js': productionBundle,
  }), '1.0.0', {
    productionBytes: productionBundle.length,
    developmentBytes: developmentBundle.length,
    productionBundles: [{ path: 'bundle.js', content: productionBundle }],
    developmentBundles: [{ path: 'bundle.js', content: developmentBundle }],
  });

  assert.equal(accepted.ok, true, JSON.stringify(accepted.checks));
});

test('package smoke snapshots bundle bytes before a later step can swap them', () => {
  const projectDir = tmpRoot();
  const controlDir = path.join(projectDir, 'Control');
  fs.mkdirSync(controlDir, { recursive: true });
  fs.writeFileSync(path.join(controlDir, 'ControlManifest.Input.xml'), '<manifest><control version="0.0.1" /></manifest>');
  const bundlePath = path.join(controlDir, 'bundle.js');
  const devBytes = Buffer.from('development-bytes-unique');
  const prodBytes = Buffer.from('production-bytes');

  const run = (zipBytes) => runPackageSmoke({ id: 'star-rating' }, projectDir, {}, {
    runPcfBuild: (_dir, mode) => {
      const content = mode === 'development' ? devBytes : prodBytes;
      fs.writeFileSync(bundlePath, content);
      return { ok: true, controls: [{ bundleBytes: content.length, controlDir, referenced: ['bundle.js'] }] };
    },
    runPac: () => ({ status: 0, stdout: '', stderr: '' }),
    spawnResultSync: (_command, _args, opts) => {
      fs.writeFileSync(bundlePath, devBytes);
      fs.mkdirSync(path.join(opts.cwd, 'bin', 'Release'), { recursive: true });
      writeZip(path.join(opts.cwd, 'bin', 'Release', 'solution.zip'), {
        'solution.xml': '<ImportExportXml><SolutionManifest><Managed>1</Managed><RootComponents><RootComponent type="66" /></RootComponents></SolutionManifest></ImportExportXml>',
        'customizations.xml': '<ImportExportXml><CustomControls /></ImportExportXml>',
        'Controls/ControlManifest.xml': '<control version="1.0.0"><resources><code path="bundle.js" order="1" /></resources></control>',
        'Controls/bundle.js': zipBytes,
      });
      return { status: 0, stdout: '', stderr: '' };
    },
  });

  const swapped = run(devBytes);
  assert.equal(swapped.ok, false);
  assert.match(swapped.checks.find((check) => check.id === 'embedded-bundle-resources').detail, /development|does not match the production/i);

  const good = run(prodBytes);
  assert.equal(good.ok, true, JSON.stringify(good.checks));
});

test('inspectSolutionZip accepts a valid managed PCF solution package', () => {
  const productionBundle = Buffer.from('(()=>{"use strict";console.log("production");})();');
  const zip = writeSmokeZip({
    'Controls/ControlManifest.xml': '<control version="1.0.0"><resources><code path="bundle.js" order="1" /></resources></control>',
    'Controls/bundle.js': productionBundle,
  });

  const result = inspectSolutionZip(zip, '1.0.0', {
    productionBytes: productionBundle.length,
    developmentBytes: productionBundle.length + 10,
    productionBundles: [{ path: 'bundle.js', content: productionBundle }],
    developmentBundles: [{ path: 'bundle.js', content: Buffer.from('development bundle with source maps') }],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.checks.map((check) => [check.id, check.ok]), [
    ['managed', true],
    ['root-component-66', true],
    ['custom-controls', true],
    ['manifest-version', true],
    ['production-bundle-smaller', true],
    ['embedded-bundle-resources', true],
  ]);
});

test('inspectSolutionZip rejects a package whose manifest references a missing bundle', () => {
  const zip = writeSmokeZip({
    'Controls/ControlManifest.xml': '<control version="1.0.0"><resources><code path="bundle.js" order="1" /></resources></control>',
  });

  const result = inspectSolutionZip(zip, '1.0.0', {
    productionBytes: 10,
    developmentBytes: 20,
    productionBundles: [{ path: 'bundle.js', content: Buffer.from('production') }],
    developmentBundles: [{ path: 'bundle.js', content: Buffer.from('development') }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.checks.find((check) => check.id === 'embedded-bundle-resources').ok, false);
  assert.match(result.checks.find((check) => check.id === 'embedded-bundle-resources').detail, /missing/i);
});

test('inspectSolutionZip rejects a package whose embedded bundle differs from the production build', () => {
  const productionBundle = Buffer.from('production bundle');
  const developmentBundle = Buffer.from('development bundle');
  const zip = writeSmokeZip({
    'Controls/ControlManifest.xml': '<control version="1.0.0"><resources><code path="bundle.js" order="1" /></resources></control>',
    'Controls/bundle.js': developmentBundle,
  });

  const result = inspectSolutionZip(zip, '1.0.0', {
    productionBytes: productionBundle.length,
    developmentBytes: developmentBundle.length,
    productionBundles: [{ path: 'bundle.js', content: productionBundle }],
    developmentBundles: [{ path: 'bundle.js', content: developmentBundle }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.checks.find((check) => check.id === 'embedded-bundle-resources').ok, false);
  assert.match(result.checks.find((check) => check.id === 'embedded-bundle-resources').detail, /does not match the production build/i);
});

test('inspectSolutionZip reports package content failures independently', () => {
  const cases = [
    ['managed', { 'solution.xml': '<Managed>0</Managed><RootComponent type="66" />' }],
    ['root-component-66', { 'solution.xml': '<Managed>1</Managed><RootComponent type="1" />' }],
    ['custom-controls', { 'customizations.xml': '<ImportExportXml />' }],
    ['manifest-version', { 'Controls/ControlManifest.xml': '<control version="2.0.0" />' }],
  ];

  for (const [failedCheck, entries] of cases) {
    const result = inspectSolutionZip(writeSmokeZip(entries), '1.0.0', { productionBytes: 10, developmentBytes: 20 });
    assert.equal(result.ok, false, failedCheck);
    assert.equal(result.checks.find((check) => check.id === failedCheck).ok, false);
  }
});

test('readZipEntries rejects ZIP64 central directory sentinels with a clear error', () => {
  const file = path.join(tmpRoot(), 'zip64.zip');
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0xffff, 10);
  fs.writeFileSync(file, eocd);

  assert.throws(
    () => inspectSolutionZip(file, '1.0.0', { productionBytes: 10, developmentBytes: 20 }),
    /ZIP64 solution packages are not supported by this smoke reader/,
  );
});

test('readZipEntries rejects ZIP64 central directory entry sentinels with a clear error', () => {
  const file = writeSmokeZip();
  const buffer = fs.readFileSync(file);
  const central = findSignature(buffer, 0x02014b50);
  buffer.writeUInt32LE(0xffffffff, central + 20);
  fs.writeFileSync(file, buffer);

  assert.throws(
    () => inspectSolutionZip(file, '1.0.0', { productionBytes: 10, developmentBytes: 20 }),
    /ZIP64 solution packages are not supported by this smoke reader/,
  );
});

function writeSmokeZip(overrides = {}) {
  const file = path.join(tmpRoot(), 'solution.zip');
  writeZip(file, {
    'solution.xml': '<ImportExportXml><SolutionManifest><Managed>1</Managed><RootComponents><RootComponent type="66" /></RootComponents></SolutionManifest></ImportExportXml>',
    'customizations.xml': '<ImportExportXml><CustomControls /></ImportExportXml>',
    'Controls/ControlManifest.xml': '<control version="1.0.0" />',
    ...overrides,
  });
  return file;
}

function writeZip(file, entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name, 'utf8');
    const content = Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8');
    const local = Buffer.alloc(30 + nameBytes.length + content.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    content.copy(local, 30 + nameBytes.length);
    locals.push(local);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    centrals.push(central);
    offset += local.length;
  }

  const centralStart = offset;
  const central = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(centrals.length, 8);
  eocd.writeUInt16LE(centrals.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  fs.writeFileSync(file, Buffer.concat([...locals, central, eocd]));
}

function findSignature(buffer, signature) {
  for (let i = 0; i <= buffer.length - 4; i += 1) {
    if (buffer.readUInt32LE(i) === signature) return i;
  }
  throw new Error(`signature ${signature.toString(16)} not found`);
}
