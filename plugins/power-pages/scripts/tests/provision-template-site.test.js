'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  copyMissingTemplateFiles,
  findCodeSiteRoot,
  inspectCompiledOutput,
  inspectClonedSiteIdentity,
  parseArgs,
  provisionTemplateSite,
  runNpm,
  runPac,
} = require('../provision-template-site');

const SOURCE_ID = '11111111-1111-1111-1111-111111111111';
const CLONED_ID = '22222222-2222-2222-2222-222222222222';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'provision-template-site-test-'));
}

function createSource(root, { id = SOURCE_ID, name = 'Template Site' } = {}) {
  fs.mkdirSync(path.join(root, '.powerpages-site'), { recursive: true });
  fs.writeFileSync(path.join(root, '.powerpages-site', 'website.yml'), `id: ${id}\nname: ${name}\n`);
  fs.writeFileSync(path.join(root, 'powerpages.config.json'), JSON.stringify({ compiledPath: 'dist' }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { build: 'vite build' } }));
  fs.writeFileSync(path.join(root, '.npmrc'), 'omit-lockfile-registry-resolved=true\n');
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

test('inspectClonedSiteIdentity reads the new website record id from cloned metadata', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  createSource(dir, { id: CLONED_ID, name: 'Supplier Portal Clone' });

  assert.deepEqual(inspectClonedSiteIdentity(dir), {
    siteName: 'Supplier Portal Clone',
    websiteRecordId: CLONED_ID,
  });
});

test('inspectCompiledOutput requires the configured build directory to contain a file', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  createSource(dir);
  fs.mkdirSync(path.join(dir, 'dist', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dist', 'assets', 'index.js'), 'built');

  assert.deepEqual(inspectCompiledOutput(dir), {
    compiledPath: 'dist',
    outputPath: path.join(dir, 'dist'),
  });
});

test('inspectCompiledOutput rejects a project root or parent path as compiled output', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  createSource(dir);

  fs.writeFileSync(path.join(dir, 'powerpages.config.json'), JSON.stringify({ compiledPath: '.' }));
  assert.throws(() => inspectCompiledOutput(dir), /invalid compiledPath/);

  fs.writeFileSync(path.join(dir, 'powerpages.config.json'), JSON.stringify({ compiledPath: '../dist' }));
  assert.throws(() => inspectCompiledOutput(dir), /invalid compiledPath/);
});

test('provisionTemplateSite clones, installs, builds, validates output, then uploads', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source');
  const output = path.join(dir, 'output');
  createSource(source);
  const pacCalls = [];
  const npmCalls = [];

  const result = provisionTemplateSite({
    sourcePath: source,
    outputDirectory: output,
    siteName: 'Supplier Portal',
  }, {
    runPac(args) {
      pacCalls.push(args);
      if (args[1] === 'clone') {
        createSource(path.join(output, 'supplier-portal'), {
          id: CLONED_ID,
          name: 'Supplier Portal',
        });
        fs.writeFileSync(path.join(output, 'supplier-portal', 'package-lock.json'), '{}');
      }
      return { status: 0, stdout: 'ok', stderr: '' };
    },
    runNpm(args, cwd) {
      npmCalls.push([args, cwd]);
      if (args[0] === 'run') {
        fs.mkdirSync(path.join(cwd, 'dist'));
        fs.writeFileSync(path.join(cwd, 'dist', 'index.html'), '<html></html>');
      }
      return { status: 0, stdout: 'ok', stderr: '' };
    },
  });

  const clonedPath = path.join(output, 'supplier-portal');
  assert.deepEqual(result, {
    ok: true,
    clonedPath,
    siteName: 'Supplier Portal',
    websiteRecordId: CLONED_ID,
    compiledPath: 'dist',
  });
  assert.deepEqual(pacCalls, [
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
  assert.deepEqual(npmCalls, [
    [[
      'ci',
      '--no-audit',
      '--no-fund',
    ], clonedPath],
    [['run', 'build'], clonedPath],
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
        createSource(path.join(output, 'supplier-portal'), {
          id: CLONED_ID,
          name: 'Supplier Portal',
        });
        return { status: 0, stdout: 'cloned', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: 'upload rejected' };
    },
    runNpm(args, cwd) {
      if (args[0] === 'run') {
        fs.mkdirSync(path.join(cwd, 'dist'));
        fs.writeFileSync(path.join(cwd, 'dist', 'index.html'), '<html></html>');
      }
      return { status: 0, stdout: 'ok', stderr: '' };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.step, 'upload');
  assert.equal(result.clonedPath, path.join(output, 'supplier-portal'));
  assert.equal(result.websiteRecordId, CLONED_ID);
  assert.match(result.error, /upload rejected/);
  assert.equal(calls, 2);
});

test('provisionTemplateSite stops before upload when dependency installation fails', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source');
  const output = path.join(dir, 'output');
  createSource(source);
  const pacCalls = [];

  const result = provisionTemplateSite({
    sourcePath: source,
    outputDirectory: output,
    siteName: 'Supplier Portal',
  }, {
    runPac(args) {
      pacCalls.push(args);
      createSource(path.join(output, 'supplier-portal'), {
        id: CLONED_ID,
        name: 'Supplier Portal',
      });
      return { status: 0, stdout: 'ok', stderr: '' };
    },
    runNpm(args) {
      assert.equal(args[0], 'install');
      return { status: 1, stdout: '', stderr: 'install rejected' };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.step, 'install');
  assert.match(result.error, /install rejected/);
  assert.equal(pacCalls.length, 1);
});

test('provisionTemplateSite stops before upload when the cloned project build fails', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source');
  const output = path.join(dir, 'output');
  createSource(source);
  const pacCalls = [];
  let npmCalls = 0;

  const result = provisionTemplateSite({
    sourcePath: source,
    outputDirectory: output,
    siteName: 'Supplier Portal',
  }, {
    runPac(args) {
      pacCalls.push(args);
      createSource(path.join(output, 'supplier-portal'), {
        id: CLONED_ID,
        name: 'Supplier Portal',
      });
      return { status: 0, stdout: 'ok', stderr: '' };
    },
    runNpm(args) {
      npmCalls++;
      return args[0] === 'run'
        ? { status: 1, stdout: '', stderr: 'build rejected' }
        : { status: 0, stdout: 'ok', stderr: '' };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.step, 'build');
  assert.match(result.error, /build rejected/);
  assert.equal(npmCalls, 2);
  assert.equal(pacCalls.length, 1);
});

test('provisionTemplateSite stops before upload when build output is missing', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source');
  const output = path.join(dir, 'output');
  createSource(source);
  const pacCalls = [];

  const result = provisionTemplateSite({
    sourcePath: source,
    outputDirectory: output,
    siteName: 'Supplier Portal',
  }, {
    runPac(args) {
      pacCalls.push(args);
      createSource(path.join(output, 'supplier-portal'), {
        id: CLONED_ID,
        name: 'Supplier Portal',
      });
      return { status: 0, stdout: 'ok', stderr: '' };
    },
    runNpm() {
      return { status: 0, stdout: 'ok', stderr: '' };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.step, 'build-output');
  assert.match(result.error, /not a regular directory/);
  assert.equal(pacCalls.length, 1);
});

test('provisionTemplateSite stops before upload when clone metadata has no valid website id', (t) => {
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
        createSource(path.join(output, 'supplier-portal'), {
          id: 'not-a-guid',
          name: 'Supplier Portal',
        });
      }
      return { status: 0, stdout: 'ok', stderr: '' };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.step, 'clone-output');
  assert.match(result.error, /missing a valid id/);
  assert.equal(calls, 1);
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

test('provisionTemplateSite rejects an output path that is a file', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source');
  const outputFile = path.join(dir, 'output');
  createSource(source);
  fs.writeFileSync(outputFile, 'not a directory');

  assert.deepEqual(
    provisionTemplateSite({
      sourcePath: source,
      outputDirectory: outputFile,
      siteName: '311 Portal',
    }),
    {
      ok: false,
      step: 'validation',
      error: 'outputDirectory must be a regular directory when it exists',
    }
  );
});

test('provisionTemplateSite rejects case-variant output paths inside the source on Windows', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'TemplateSource');
  createSource(source);

  const result = provisionTemplateSite({
    sourcePath: source,
    outputDirectory: path.join(dir, 'templatesource', 'clone'),
    siteName: '311 Portal',
  }, {
    platform: 'win32',
  });

  assert.deepEqual(result, {
    ok: false,
    step: 'validation',
    error: 'outputDirectory must be separate from sourcePath',
  });
});

test('provisionTemplateSite rejects output paths whose existing parent resolves into the source', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source');
  createSource(source);
  const linkedParent = path.join(dir, 'linked-source');
  try {
    fs.symlinkSync(source, linkedParent, 'dir');
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      t.skip(`directory symlinks are unavailable: ${err.code}`);
      return;
    }
    throw err;
  }

  const result = provisionTemplateSite({
    sourcePath: source,
    outputDirectory: path.join(linkedParent, 'clone'),
    siteName: '311 Portal',
  });

  assert.deepEqual(result, {
    ok: false,
    step: 'validation',
    error: 'outputDirectory must be separate from sourcePath',
  });
});

test('provisionTemplateSite requires project-local npm configuration', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source');
  createSource(source);
  fs.rmSync(path.join(source, '.npmrc'));

  const result = provisionTemplateSite({
    sourcePath: source,
    outputDirectory: path.join(dir, 'output'),
    siteName: '311 Portal',
  });

  assert.deepEqual(result, {
    ok: false,
    step: 'validation',
    error: 'sourcePath is not a downloaded Power Pages code site',
  });
});

test('provisionTemplateSite restores project files omitted by PAC without replacing cloned identity', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source');
  const output = path.join(dir, 'output');
  createSource(source);
  fs.writeFileSync(path.join(source, 'dataverse-choice-values.json'), '{"status":{"Open":100000000}}');
  fs.mkdirSync(path.join(source, 'tests'));
  fs.writeFileSync(path.join(source, 'tests', 'serviceRequests.test.mjs'), 'export {};\n');
  fs.mkdirSync(path.join(source, '.powerpages-site', '.portalconfig'));
  fs.writeFileSync(path.join(source, '.powerpages-site', '.portalconfig', 'manifest.yml'), 'portalVersion: 1\n');
  const npmCalls = [];
  let pacCalls = 0;

  const result = provisionTemplateSite({
    sourcePath: source,
    outputDirectory: output,
    siteName: '311 Portal',
  }, {
    runPac(args) {
      pacCalls++;
      if (args[1] === 'clone') {
        const clonedPath = path.join(output, '311-portal');
        createSource(clonedPath, { id: CLONED_ID, name: '311 Portal' });
        fs.rmSync(path.join(clonedPath, '.npmrc'));
      }
      return { status: 0, stdout: 'ok', stderr: '' };
    },
    runNpm(args, cwd) {
      npmCalls.push(args);
      assert.equal(fs.existsSync(path.join(cwd, '.npmrc')), true);
      assert.equal(fs.existsSync(path.join(cwd, 'dataverse-choice-values.json')), true);
      assert.equal(fs.existsSync(path.join(cwd, 'tests', 'serviceRequests.test.mjs')), true);
      assert.equal(fs.existsSync(path.join(cwd, '.powerpages-site', '.portalconfig', 'manifest.yml')), true);
      if (args[0] === 'run') {
        fs.mkdirSync(path.join(cwd, 'dist'));
        fs.writeFileSync(path.join(cwd, 'dist', 'index.html'), '<html></html>');
      }
      return { status: 0, stdout: 'ok', stderr: '' };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.websiteRecordId, CLONED_ID);
  assert.equal(pacCalls, 2);
  assert.deepEqual(npmCalls.map((args) => args[0]), ['install', 'run']);
  assert.equal(
    fs.readFileSync(path.join(output, '311-portal', '.npmrc'), 'utf8'),
    fs.readFileSync(path.join(source, '.npmrc'), 'utf8')
  );
});

test('copyMissingTemplateFiles rejects source symlinks and preserves cloned website metadata', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source');
  const clone = path.join(dir, 'clone');
  createSource(source, { id: SOURCE_ID });
  createSource(clone, { id: CLONED_ID });
  fs.writeFileSync(path.join(source, 'extra.json'), '{}');

  assert.deepEqual(copyMissingTemplateFiles(source, clone), ['extra.json']);
  assert.match(
    fs.readFileSync(path.join(clone, '.powerpages-site', 'website.yml'), 'utf8'),
    new RegExp(CLONED_ID)
  );

  const target = path.join(dir, 'outside.json');
  const link = path.join(source, 'linked.json');
  fs.writeFileSync(target, '{}');
  try {
    fs.symlinkSync(target, link);
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      t.skip(`symlinks are unavailable: ${err.code}`);
      return;
    }
    throw err;
  }
  assert.throws(
    () => copyMissingTemplateFiles(source, clone),
    /symbolic link: linked\.json/
  );
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

test('runNpm invokes the Windows npm.cmd shim through cmd.exe without a command shell', () => {
  const calls = [];
  runNpm(['run', 'build'], '/tmp/site', {
    platform: 'win32',
    runNpmCommand(command, args, options) {
      calls.push([command, args, options]);
      return 'ok';
    },
  });
  assert.equal(calls[0][0], 'cmd.exe');
  assert.deepEqual(calls[0][1], ['/d', '/s', '/c', 'npm.cmd', 'run', 'build']);
  assert.equal(calls[0][2].cwd, '/tmp/site');
  assert.equal(calls[0][2].shell, false);
});
