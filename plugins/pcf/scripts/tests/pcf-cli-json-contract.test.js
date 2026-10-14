'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadCli } = require('./helpers/cli-harness.js');

const scriptsDir = path.join(__dirname, '..');

async function runCli(script, argv, requires = {}) {
  const cli = loadCli(path.join(scriptsDir, script), { argv, requires });
  assert.equal(typeof cli.main, 'function');
  try {
    await cli.main(argv);
  } catch (err) {
    if (!String(err && err.message).startsWith('process.exit(')) throw err;
  }
  return cli;
}

async function runCliWithAuth(script, argv, requires = {}) {
  const realAuth = require('../lib/dataverse-auth.js');
  const emitted = { stdout: '', stderr: '', exitCode: null };
  const cli = await runCli(script, argv, {
    ...requires,
    './lib/dataverse-auth': {
      parseArgs: realAuth.parseArgs,
      validateFlags: realAuth.validateFlags,
      emitResult: (ok, payload) => {
        const body = payload instanceof Error ? { ok: false, error: payload.message || String(payload) } : payload;
        emitted.stdout += `${JSON.stringify(body)}\n`;
        if (!ok) emitted.stderr += `${body.error || 'failed'}\n`;
        emitted.exitCode = ok ? 0 : 1;
        const err = new Error(`process.exit(${emitted.exitCode})`);
        err.exitCode = emitted.exitCode;
        throw err;
      },
    },
  });
  return {
    ...cli,
    exitCode: emitted.exitCode,
    stdoutText: () => emitted.stdout,
    stderrText: () => emitted.stderr,
  };
}

function assertJsonFailure(cli, pattern) {
  assert.equal(cli.exitCode, 1);
  const payload = JSON.parse(cli.stdoutText());
  assert.equal(payload.ok, false);
  assert.match(payload.error, pattern);
  assert.match(cli.stderrText(), pattern);
}

test('PCF CLIs emit one stdout JSON object for non-usage runtime failures', async () => {
  const lint = await runCli('lint-pcf.js', ['--manifest', 'D:\\missing\\ControlManifest.Input.xml']);
  assertJsonFailure(lint, /ENOENT|no such file/i);

  const scaffold = await runCliWithAuth('pcf-scaffold.js', [
    '--template', 'field-standard',
    '--namespace', 'Contoso.Controls',
    '--name', 'StarRating',
    '--out', 'D:\\out',
    '--install',
  ], {
    './lib/node-tool': { runNpm: () => ({ status: 1, stderr: 'registry unavailable', stdout: '' }) },
    './lib/pcf-scaffold': {
      planScaffold: () => ({ files: [], recipe: null }),
      writeScaffold: () => ({ written: [] }),
      listTemplates: () => [],
      listRecipes: () => [],
    },
  });
  assertJsonFailure(scaffold, /npm ci failed[\s\S]*registry unavailable/);

  const doctor = await runCliWithAuth('pcf-doctor.js', ['--project', 'D:\\missing'], {
    './lib/pcf-matrix': { loadMatrix: () => ({ toolchain: {}, dependencySets: {} }) },
    './lib/node-tool': { runNpm: () => ({ status: 0, stdout: '10.0.0', stderr: '' }) },
    './lib/pac-exec': { runPac: () => ({ status: 0, stdout: 'pac 1.0.0', stderr: '' }) },
    './lib/pcf-doctor': {
      collectToolchain: () => ({}),
      checkToolchain: () => [],
      collectProject: () => { throw new Error('project missing'); },
      checkProject: () => [],
      hasErrors: () => false,
    },
  });
  assertJsonFailure(doctor, /project missing/);

  const upgrade = await runCliWithAuth('pcf-upgrade.js', ['--project', 'D:\\missing'], {
    './lib/pcf-upgrade': { runUpgrade: () => { throw new Error('project missing'); } },
  });
  assertJsonFailure(upgrade, /project missing/);
});
