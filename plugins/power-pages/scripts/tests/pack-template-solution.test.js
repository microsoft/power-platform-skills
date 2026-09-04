'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  cleanupPackedTemplateSolution,
  isOwnedWorkDirectory,
  packTemplateSolution,
  parseArgs,
} = require('../pack-template-solution');
const { runPac } = require('../lib/pac-command');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pack-template-solution-test-'));
}

function createSolutionSource(root) {
  const other = path.join(root, 'Other');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 'Solution.xml'), [
    '<ImportExportXml><SolutionManifest>',
    '<UniqueName>test_template</UniqueName>',
    '<Version>1.0.0.0</Version>',
    '<Managed>0</Managed>',
    '</SolutionManifest></ImportExportXml>',
  ].join(''));
  fs.writeFileSync(path.join(other, 'Customizations.xml'), '<ImportExportXml />');
}

function fakeSolutionZip() {
  const name = Buffer.from('solution.xml');
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(name.length, 26);
  return Buffer.concat([header, name]);
}

test('parseArgs accepts pack and cleanup inputs', () => {
  assert.deepEqual(parseArgs(['--solutionPath', '/tmp/source']), {
    solutionPath: '/tmp/source',
  });
  assert.deepEqual(parseArgs(['--cleanup', '--workDirectory', '/tmp/work']), {
    cleanup: true,
    workDirectory: '/tmp/work',
  });
});

test('packTemplateSolution packs an unmanaged source tree into an owned temp directory', (t) => {
  const root = tempDir();
  const tmpRoot = path.join(root, 'tmp');
  const source = path.join(root, 'solution');
  fs.mkdirSync(tmpRoot);
  createSolutionSource(source);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];

  const result = packTemplateSolution({ solutionPath: source }, {
    tmpRoot,
    runPac(args) {
      calls.push(args);
      fs.writeFileSync(args[args.indexOf('--zipfile') + 1], fakeSolutionZip());
      return { status: 0, stdout: 'packed', stderr: '' };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.solutionPath, path.resolve(source));
  assert.equal(isOwnedWorkDirectory(result.workDirectory, tmpRoot), true);
  assert.deepEqual(calls, [[
    'solution', 'pack',
    '--zipfile', result.zipPath,
    '--folder', path.resolve(source),
    '--packagetype', 'Unmanaged',
  ]]);
  assert.equal(fs.existsSync(result.zipPath), true);
  assert.deepEqual(cleanupPackedTemplateSolution(result.workDirectory, { tmpRoot }), {
    ok: true,
    removed: true,
  });
  assert.equal(fs.existsSync(result.workDirectory), false);
});

test('packTemplateSolution rejects invalid source and removes partial output after PAC failure', (t) => {
  const root = tempDir();
  const tmpRoot = path.join(root, 'tmp');
  fs.mkdirSync(tmpRoot);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let calls = 0;

  const invalid = packTemplateSolution({ solutionPath: path.join(root, 'missing') }, {
    tmpRoot,
    runPac() {
      calls++;
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.step, 'validation');
  assert.equal(calls, 0);

  const source = path.join(root, 'solution');
  createSolutionSource(source);
  const failed = packTemplateSolution({ solutionPath: source }, {
    tmpRoot,
    runPac() {
      calls++;
      return { status: 1, stdout: '', stderr: 'pack rejected' };
    },
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.step, 'pack');
  assert.match(failed.error, /pack rejected/);
  assert.equal(fs.readdirSync(tmpRoot).length, 0);
});

test('cleanup rejects arbitrary paths outside generated work directories', (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(isOwnedWorkDirectory(root, path.dirname(root)), false);
  assert.deepEqual(cleanupPackedTemplateSolution(root, { tmpRoot: path.dirname(root) }), {
    ok: false,
    error: 'workDirectory is not a generated template solution directory',
  });
});

test('packTemplateSolution preserves the PAC error when cleanup also fails', (t) => {
  const root = tempDir();
  const tmpRoot = path.join(root, 'tmp');
  const source = path.join(root, 'solution');
  fs.mkdirSync(tmpRoot);
  createSolutionSource(source);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fsWithBlockedCleanup = {
    ...fs,
    rmSync() {
      throw new Error('EPERM');
    },
  };

  const result = packTemplateSolution({ solutionPath: source }, {
    fs: fsWithBlockedCleanup,
    tmpRoot,
    runPac() {
      return { status: 1, stdout: '', stderr: 'pack rejected' };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.step, 'pack');
  assert.match(result.error, /pack rejected/);
  assert.match(result.cleanupError, /EPERM/);
  assert.equal(result.workDirectory.startsWith(tmpRoot), true);
});

test('runPac invokes pac.exe directly on Windows without a command shell', () => {
  const calls = [];
  runPac(['solution', 'pack', '--folder', 'source'], {
    platform: 'win32',
    runCommand(command, args, options) {
      calls.push([command, args, options]);
      return 'ok';
    },
  });
  assert.equal(calls[0][0], 'pac.exe');
  assert.deepEqual(calls[0][1], ['solution', 'pack', '--folder', 'source']);
  assert.equal(calls[0][2].shell, false);
});
