'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadCli } = require('./helpers/cli-harness.js');

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
