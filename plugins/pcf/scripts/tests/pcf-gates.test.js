'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadCli } = require('./helpers/cli-harness.js');
const { planScaffold, writeScaffold } = require('../lib/pcf-scaffold.js');

const scriptPath = path.join(__dirname, '..', 'pcf-gates.js');

async function run(argv, stubs) {
  const cli = loadCli(scriptPath, { argv, requires: stubs });
  assert.equal(typeof cli.main, 'function');
  try {
    await cli.main();
  } catch (err) {
    if (!String(err && err.message).startsWith('process.exit(')) throw err;
  }
  return cli;
}

test('pcf-gates continues through build after lint fails and exits 1 with every gate reported', async () => {
  const calls = [];
  const project = 'D:\\tmp\\pcf-project';
  const manifest = path.join(project, 'ControlManifest.Input.xml');
  const stubs = {
    './lib/pcf-build': {
      findControlProject: () => ({ projectDir: project, pcfproj: path.join(project, 'Control.pcfproj'), manifests: [manifest], packageJson: path.join(project, 'package.json') }),
      buildControl: () => {
        calls.push('build');
        return { ok: true, mode: 'production', controls: [], stdout: '', stderr: '' };
      },
      bundleFindings: () => [],
    },
    './lib/pcf-manifest': {
      parseManifest: () => ({ model: { resources: { code: [{ path: 'index.ts' }] }, control: { controlType: 'standard' }, features: [] }, errors: [] }),
      lintManifest: () => ({ ok: true, errors: [], warnings: [] }),
    },
    './lib/pcf-code-gate': {
      gateSources: () => ({ ok: true, errors: [], warnings: [] }),
    },
    './lib/node-tool': {
      resolvePackageBin: (projectDir, pkg, bin) => path.join(projectDir, 'node_modules', pkg, 'bin', `${bin}.js`),
      runNodeScript: (script, args) => {
        calls.push(args[0] || path.basename(script));
        if (args[0] === 'lint') return { status: 1, stdout: '', stderr: 'lint failed' };
        return { status: 0, stdout: 'tests passed', stderr: '' };
      },
    },
    'node:fs': {
      readFileSync: (file) => (String(file).endsWith('.xml') ? '<manifest />' : 'export class Control {}\n'),
      existsSync: () => true,
      statSync: () => ({ isDirectory: () => false, isFile: () => true }),
      readdirSync: () => [{ name: 'index.ts', isDirectory: () => false, isFile: () => true }],
    },
  };

  const cli = await run(['--project', project], stubs);

  assert.equal(cli.exitCode, 1);
  assert.deepEqual(calls, ['lint', '--ci', 'build']);
  const payload = JSON.parse(cli.stdoutText());
  assert.equal(payload.ok, false);
  assert.deepEqual(payload.gates.map((gate) => gate.id), ['manifest', 'code', 'lint', 'test', 'build']);
  assert.equal(payload.gates.find((gate) => gate.id === 'lint').ok, false);
  assert.equal(payload.gates.find((gate) => gate.id === 'test').ok, true);
  assert.equal(payload.gates.find((gate) => gate.id === 'build').ok, true);
  assert.match(payload.gates.find((gate) => gate.id === 'lint').findings[0].message, /lint failed/i);
  assert.match(payload.gates.find((gate) => gate.id === 'lint').findings[0].fix, /fix/i);
});

test('pcf-gates rejects usage errors before running gates', async () => {
  let called = false;
  const cli = await run(['--project'], {
    './lib/pcf-build': {
      findControlProject: () => { called = true; },
    },
  });

  assert.equal(cli.exitCode, 1);
  assert.equal(called, false);
  assert.match(cli.stderrText(), /Usage:/);
  assert.match(cli.stderrText(), /--project requires a value/);
  assert.equal(cli.stdoutText(), '');
});

test('pcf-gates refuses an escaping outDir before a test preparation build can run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-gates-containment-'));
  const project = path.join(dir, 'project');
  const outside = path.join(dir, 'sibling');
  const calls = [];
  try {
    writeScaffold(planScaffold({ template: 'field-standard', namespace: 'Contoso.Controls', name: 'Control' }), project);
    fs.writeFileSync(path.join(project, 'pcfconfig.json'), JSON.stringify({ outDir: '../sibling' }));
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'keep');

    const cli = await run(['--project', project, '--skip', 'lint,build'], {
      './lib/node-tool': {
        resolvePackageBin: (_project, pkg) => path.join(project, 'node_modules', pkg, 'bin', `${pkg}.js`),
        runNodeScript: (_script, args) => {
          calls.push(args);
          return { status: 0, stdout: 'prepared', stderr: '' };
        },
      },
    });

    assert.deepEqual(calls, [], 'no development build or test runner may run for an escaping output');
    assert.equal(cli.exitCode, 1);
    const payload = JSON.parse(cli.stdoutText());
    assert.equal(payload.ok, false);
    const gate = payload.gates.find((item) => item.id === 'test');
    assert.equal(gate.ok, false);
    assert.match(gate.findings[0].message, /outDir.*inside the PCF project/i);
    assert.equal(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8'), 'keep');
    assert.equal(fs.existsSync(path.join(project, 'Control', 'generated', 'ManifestTypes.d.ts')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pcf-gates emits JSON on stdout when a non-usage runtime failure is thrown', async () => {
  const cli = await run(['--project', 'D:\\tmp\\pcf-project'], {
    './lib/pcf-build': {
      findControlProject: () => { throw new Error('boom from gates'); },
    },
  });

  assert.equal(cli.exitCode, 1);
  const payload = JSON.parse(cli.stdoutText());
  assert.equal(payload.ok, false);
  assert.match(payload.error, /boom from gates/);
  assert.match(cli.stderrText(), /boom from gates/);
});
