'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  MAX_ASYNC_WAIT_MINUTES,
  PROCESS_TIMEOUT_MS,
  importTemplateSolution,
  parseArgs,
  run,
} = require('../import-template-solution');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'import-template-solution-test-'));
}

function fakeSolutionZip() {
  const name = Buffer.from('solution.xml');
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(name.length, 26);
  return Buffer.concat([header, name]);
}

function writeSolutionZip(t) {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const zipPath = path.join(root, 'solution.zip');
  fs.writeFileSync(zipPath, fakeSolutionZip());
  return zipPath;
}

test('parseArgs reads explicit publish behavior', () => {
  assert.deepEqual(parseArgs([
    '--zipPath', '/tmp/solution.zip',
    '--envUrl', 'https://contoso.crm.dynamics.com',
    '--publishChanges', 'true',
  ]), {
    zipPath: '/tmp/solution.zip',
    envUrl: 'https://contoso.crm.dynamics.com',
    publishChanges: true,
  });
  assert.equal(parseArgs(['--publishChanges', 'invalid']).publishChanges, null);
});

test('flagged template solutions import with publish changes', (t) => {
  const zipPath = writeSolutionZip(t);
  const calls = [];
  const result = importTemplateSolution({
    zipPath,
    envUrl: 'https://contoso.crm.dynamics.com',
    publishChanges: true,
  }, {
    runPac(args, options) {
      calls.push([args, options]);
      return { status: 0, stdout: 'imported', stderr: '' };
    },
  });

  assert.deepEqual(result, { ok: true, imported: true, publishChanges: true });
  assert.deepEqual(calls[0][0], [
    'solution', 'import',
    '--environment', 'https://contoso.crm.dynamics.com',
    '--path', path.resolve(zipPath),
    '--force-overwrite',
    '--activate-plugins',
    '--async',
    '--max-async-wait-time', String(MAX_ASYNC_WAIT_MINUTES),
    '--publish-changes',
  ]);
  assert.equal(calls[0][1], undefined);
});

test('unflagged template solutions omit publish changes', (t) => {
  const zipPath = writeSolutionZip(t);
  let args;
  const result = importTemplateSolution({
    zipPath,
    envUrl: 'https://contoso.crm.dynamics.com',
    publishChanges: false,
  }, {
    runPac(value) {
      args = value;
      return { status: 0, stdout: 'imported', stderr: '' };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.publishChanges, false);
  assert.equal(args.includes('--publish-changes'), false);
});

test('default PAC runner receives a timeout longer than the CLI wait', (t) => {
  const zipPath = writeSolutionZip(t);
  let options;
  const result = importTemplateSolution({
    zipPath,
    envUrl: 'https://contoso.crm.dynamics.com',
    publishChanges: false,
  }, {
    runCommand(command, args, commandOptions) {
      assert.equal(command, process.platform === 'win32' ? 'pac.exe' : 'pac');
      assert.equal(args.includes('--async'), true);
      options = commandOptions;
      return '';
    },
  });

  assert.equal(result.ok, true);
  assert.equal(options.timeout, PROCESS_TIMEOUT_MS);
  assert.ok(PROCESS_TIMEOUT_MS > MAX_ASYNC_WAIT_MINUTES * 60 * 1000);
});

test('PAC failures and invalid inputs stay explicit', (t) => {
  const zipPath = writeSolutionZip(t);
  const failed = importTemplateSolution({
    zipPath,
    envUrl: 'https://contoso.crm.dynamics.com',
    publishChanges: true,
  }, {
    runPac() {
      return { status: 1, stdout: '', stderr: 'Import failed' };
    },
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.phase, 'import');
  assert.match(failed.error, /Import failed/);

  for (const options of [
    { zipPath: '/missing.zip', envUrl: 'https://contoso.crm.dynamics.com', publishChanges: false },
    { zipPath, envUrl: 'https://example.org', publishChanges: false },
    { zipPath, envUrl: 'https://contoso.crm.dynamics.com', publishChanges: 'true' },
  ]) {
    assert.equal(importTemplateSolution(options).ok, false);
  }
});

test('CLI rejects incomplete or malformed arguments', () => {
  for (const argv of [
    [],
    ['--zipPath', '/tmp/a.zip'],
    ['--zipPath', '/tmp/a.zip', '--envUrl', 'https://contoso.crm.dynamics.com', '--publishChanges', 'yes'],
    ['--zipPath', '/tmp/a.zip', '--envUrl', 'https://contoso.crm.dynamics.com', '--unknown'],
  ]) {
    assert.equal(run(argv).ok, false);
  }
});
