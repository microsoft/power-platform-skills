'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  findCodeSiteRoot,
  parseArgs,
  provisionTemplateSite,
  runPac,
} = require('../provision-template-site');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'provision-template-site-test-'));
}

function createSource(root) {
  fs.mkdirSync(path.join(root, '.powerpages-site'), { recursive: true });
  fs.writeFileSync(path.join(root, 'powerpages.config.json'), '{}');
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
}

test('parseArgs accepts source, output, and site name', () => {
  assert.deepEqual(parseArgs([
    '--sourcePath', '/tmp/source',
    '--outputDirectory', '/tmp/output',
    '--siteName', 'Supplier Portal',
  ]), {
    sourcePath: '/tmp/source',
    outputDirectory: '/tmp/output',
    siteName: 'Supplier Portal',
  });
});

test('findCodeSiteRoot resolves one nested PAC clone output and rejects ambiguity', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const site = path.join(dir, 'supplier-portal');
  createSource(site);
  assert.equal(findCodeSiteRoot(dir), site);

  createSource(path.join(dir, 'another-site'));
  assert.throws(() => findCodeSiteRoot(dir), /found 2/);
});

test('provisionTemplateSite clones packaged SPA code then uploads the cloned root', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source');
  const output = path.join(dir, 'output');
  createSource(source);
  const calls = [];

  const result = provisionTemplateSite({
    sourcePath: source,
    outputDirectory: output,
    siteName: 'Supplier Portal',
  }, {
    runPac(args) {
      calls.push(args);
      if (args[1] === 'clone') createSource(path.join(output, 'supplier-portal'));
      return { status: 0, stdout: 'ok', stderr: '' };
    },
  });

  const clonedPath = path.join(output, 'supplier-portal');
  assert.deepEqual(result, { ok: true, clonedPath });
  assert.deepEqual(calls, [
    [
      'pages', 'clone',
      '--path', source,
      '--outputDirectory', output,
      '--name', 'Supplier Portal',
      '--overwrite',
    ],
    [
      'pages', 'upload-code-site',
      '--rootPath', clonedPath,
      '--siteName', 'Supplier Portal',
    ],
  ]);
});

test('provisionTemplateSite stops after clone failure and reports the failed step', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source');
  createSource(source);
  let calls = 0;

  const result = provisionTemplateSite({
    sourcePath: source,
    outputDirectory: path.join(dir, 'output'),
    siteName: '311 Portal',
  }, {
    runPac() {
      calls++;
      return { status: 1, stdout: '', stderr: 'clone rejected' };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.step, 'clone');
  assert.match(result.error, /clone rejected/);
  assert.equal(calls, 1);
});

test('provisionTemplateSite reports upload failure without retrying', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source');
  const output = path.join(dir, 'output');
  createSource(source);
  let calls = 0;

  const result = provisionTemplateSite({
    sourcePath: source,
    outputDirectory: output,
    siteName: 'Supplier Portal',
  }, {
    runPac(args) {
      calls++;
      if (args[1] === 'clone') {
        createSource(path.join(output, 'supplier-portal'));
        return { status: 0, stdout: 'cloned', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: 'upload rejected' };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.step, 'upload');
  assert.equal(result.clonedPath, path.join(output, 'supplier-portal'));
  assert.match(result.error, /upload rejected/);
  assert.equal(calls, 2);
});

test('provisionTemplateSite rejects non-empty output directories', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source');
  const output = path.join(dir, 'output');
  createSource(source);
  fs.mkdirSync(output);
  fs.writeFileSync(path.join(output, 'stale.txt'), 'stale');

  const result = provisionTemplateSite({
    sourcePath: source,
    outputDirectory: output,
    siteName: '311 Portal',
  });

  assert.deepEqual(result, { ok: false, step: 'validation', error: 'outputDirectory must be empty' });
});

test('runPac invokes pac.exe directly on Windows without a command shell', () => {
  const calls = [];
  runPac(['pages', 'clone', '--path', 'source'], {
    platform: 'win32',
    runCommand(command, args, options) {
      calls.push([command, args, options]);
      return 'ok';
    },
  });
  assert.equal(calls[0][0], 'pac.exe');
  assert.deepEqual(calls[0][1], ['pages', 'clone', '--path', 'source']);
  assert.equal(calls[0][2].shell, false);
});
