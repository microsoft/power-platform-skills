'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { inspectStartup } = require('../inspect-startup');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-startup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, value) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const manifest = {
    name: 'startup-fixture',
    engines: { node: '>=22' },
    packageManager: 'npm@10.0.0',
    dependencies: { 'sample-package': '^1.0.0' },
  };
  const lock = {
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { ...manifest.dependencies } },
      'node_modules/sample-package': {
        version: '1.0.0',
        resolved: 'https://registry.example.com/package?token=do-not-emit',
        engines: { node: '>=20' },
      },
    },
  };
  write('package.json', manifest);
  write('package-lock.json', lock);
  return { root, write, manifest, lock };
}

test('inspection works before install, Metro configuration, or Power Apps initialization', (t) => {
  const { root } = fixture(t);
  const result = inspectStartup(root, ['sample-package']);
  assert.equal(result.status, 'inspected');
  assert.equal(result.node.current, process.version);
  assert.equal(result.node.projectRequirement, '>=22');
  assert.equal(result.packages[0].installedStatus, 'missing');
  assert.equal(result.packages[0].nodeRequirement, '>=20');
  assert.equal(result.lockfile.status, 'direct-declarations-match');
  assert.equal(result.lockfile.validationScope, 'direct-declarations-only');
  assert.equal(result.repairAuthorized, false);
  assert.equal(result.entryPoints[0].status, 'unresolved');
  assert.deepEqual(result.configFiles, []);
  assert.equal(fs.existsSync(path.join(root, '.powernative')), false);
  assert.equal(fs.existsSync(path.join(root, 'node_modules')), false);
});

test('entry resolution never evaluates package code or project config', (t) => {
  const { root, write } = fixture(t);
  write('node_modules/sample-package/package.json', {
    name: 'sample-package', version: '1.0.0', exports: { './config': './config.js' },
  });
  write('node_modules/sample-package/config.js', 'throw new Error("must not execute");');
  write('metro.config.js', 'throw new Error("must not execute app config");');
  const before = fs.readFileSync(path.join(root, 'package-lock.json'));
  const result = inspectStartup(root, ['sample-package/config']);
  assert.equal(result.entryPoints[0].status, 'resolved');
  assert.equal(result.packages[0].matchesLock, true);
  assert.deepEqual(fs.readFileSync(path.join(root, 'package-lock.json')), before);
});

test('correct installed version with absent export is reported without claiming package defect', (t) => {
  const { root, write } = fixture(t);
  write('node_modules/sample-package/package.json', {
    name: 'sample-package', version: '1.0.0', exports: { '.': './index.js' },
  });
  write('node_modules/sample-package/index.js', 'throw new Error("do not load");');
  const result = inspectStartup(root, ['sample-package/config']);
  assert.equal(result.packages[0].matchesLock, true);
  assert.equal(result.entryPoints[0].status, 'unresolved');
  assert.equal(result.entryPoints[0].code, 'ERR_PACKAGE_PATH_NOT_EXPORTED');
  assert.equal(result.repairAuthorized, false);
  assert.equal(JSON.stringify(result).includes('package-defect'), false);
});

test('parent installation cannot masquerade as app-local dependency resolution', (t) => {
  const { root, write } = fixture(t);
  write('node_modules/sample-package/package.json', { name: 'sample-package', version: '1.0.0', main: 'index.js' });
  write('node_modules/sample-package/index.js', 'throw new Error("do not execute");');
  write('child/package.json', { dependencies: { 'sample-package': '^1.0.0' } });
  const result = inspectStartup(path.join(root, 'child'), ['sample-package']);
  assert.equal(result.entryPoints[0].status, 'outside-project-install');
  assert.equal(result.packages[0].installedStatus, 'missing');
});

test('linked dependencies outside the selected app are not trusted as a local install', (t) => {
  const { root, write, manifest } = fixture(t);
  write('outside/package.json', { name: 'sample-package', version: '1.0.0', main: 'index.js' });
  write('outside/index.js', 'throw new Error("must not execute outside package");');
  write('app/package.json', manifest);
  fs.mkdirSync(path.join(root, 'app', 'node_modules'), { recursive: true });
  fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'app', 'node_modules', 'sample-package'), 'junction');
  const result = inspectStartup(path.join(root, 'app'), ['sample-package']);
  assert.equal(result.packages[0].installedStatus, 'outside-project');
  assert.equal(result.entryPoints[0].status, 'outside-project-install');
  assert.equal(result.packages[0].installedVersion, null);
});

test('manifest drift and installed version drift are distinct findings', (t) => {
  const { root, write, manifest } = fixture(t);
  manifest.dependencies['sample-package'] = '^2.0.0';
  write('package.json', manifest);
  write('node_modules/sample-package/package.json', { name: 'sample-package', version: '1.1.0' });
  const result = inspectStartup(root, []);
  assert.equal(result.lockfile.status, 'inconsistent');
  assert.deepEqual(result.lockfile.mismatches, [{ section: 'dependencies', name: 'sample-package' }]);
  assert.equal(result.packages[0].matchesLock, false);
  assert.equal(result.packages[0].lockedVersion, '1.0.0');
  assert.equal(result.packages[0].installedVersion, '1.1.0');
});

test('malformed, missing, unsupported and partial lockfiles never become valid', (t) => {
  const { root, write, lock } = fixture(t);
  for (const [content, expected] of [
    ['{broken', 'malformed'],
    [{ lockfileVersion: 1, dependencies: {} }, 'unsupported'],
    [{ lockfileVersion: 3, packages: { '': 'invalid' } }, 'malformed'],
    [{ lockfileVersion: 3, packages: { '': { dependencies: {} } } }, 'inconsistent'],
  ]) {
    write('package-lock.json', content);
    assert.equal(inspectStartup(root, []).lockfile.status, expected);
  }
  write('package-lock.json', lock);
  fs.unlinkSync(path.join(root, 'package-lock.json'));
  assert.equal(inspectStartup(root, []).lockfile.status, 'missing');
});

test('effective shrinkwrap takes precedence and alternate managers/workspaces require review', (t) => {
  const { root, write, manifest, lock } = fixture(t);
  write('npm-shrinkwrap.json', '{invalid');
  let result = inspectStartup(root, []);
  assert.equal(result.lockfile.file, 'npm-shrinkwrap.json');
  assert.equal(result.lockfile.status, 'malformed');
  fs.unlinkSync(path.join(root, 'npm-shrinkwrap.json'));
  manifest.workspaces = ['packages/*'];
  manifest.packageManager = 'pnpm@9.0.0';
  write('package.json', manifest);
  write('pnpm-lock.yaml', 'lockfileVersion: 9');
  result = inspectStartup(root, []);
  assert.equal(result.lockfile.status, 'workspace-review-required');
  assert.equal(result.packageManager, 'pnpm');
  assert.deepEqual(result.otherLocks, ['pnpm-lock.yaml']);
  assert.equal(result.repairAuthorized, false);
  delete manifest.workspaces;
  manifest.dependencies['sample-package'] = 'file:./local-package';
  lock.packages[''].dependencies = manifest.dependencies;
  write('package.json', manifest);
  write('package-lock.json', lock);
  assert.deepEqual(inspectStartup(root, []).lockfile.nonRegistry, ['sample-package']);
});

test('optional package omissions are identifiable without declaring installation broken', (t) => {
  const { root, write, manifest, lock } = fixture(t);
  manifest.optionalDependencies = { 'optional-package': '1.0.0' };
  lock.packages[''].optionalDependencies = manifest.optionalDependencies;
  lock.packages['node_modules/optional-package'] = { version: '1.0.0', optional: true };
  write('package.json', manifest);
  write('package-lock.json', lock);
  const optional = inspectStartup(root, []).packages.find(({ name }) => name === 'optional-package');
  assert.equal(optional.optional, true);
  assert.equal(optional.installedStatus, 'missing');
});

test('npm-normalized optional overrides match without hiding genuine declaration drift', (t) => {
  const { root, write, manifest, lock } = fixture(t);
  manifest.dependencies['sample-package'] = 'file:./shadowed';
  manifest.optionalDependencies = { 'sample-package': '^1.0.0' };
  lock.packages[''].dependencies = {};
  lock.packages[''].optionalDependencies = { 'sample-package': '^1.0.0' };
  write('package.json', manifest);
  write('package-lock.json', lock);
  const before = fs.readFileSync(path.join(root, 'package.json'));
  let result = inspectStartup(root, []);
  assert.equal(result.lockfile.status, 'direct-declarations-match');
  assert.deepEqual(result.lockfile.nonRegistry, []);
  assert.deepEqual(fs.readFileSync(path.join(root, 'package.json')), before);
  manifest.optionalDependencies['sample-package'] = '^2.0.0';
  write('package.json', manifest);
  result = inspectStartup(root, []);
  assert.equal(result.lockfile.status, 'inconsistent');
  assert.deepEqual(result.lockfile.mismatches, [{
    section: 'optionalDependencies', name: 'sample-package',
  }]);
});

test('output excludes full paths, registry URLs, config contents, and lifecycle scripts', (t) => {
  const { root, write, manifest } = fixture(t);
  manifest.scripts = { postinstall: 'secret-postinstall-command' };
  write('package.json', manifest);
  write('.npmrc', '//registry.example.com/:_authToken=never-read-this');
  write('auth.config.json', { secret: 'never-read-auth-config' });
  const output = JSON.stringify(inspectStartup(root, ['sample-package']));
  for (const forbidden of [root, 'registry.example.com', 'do-not-emit', 'never-read-this',
    'secret-postinstall-command', 'never-read-auth-config']) {
    assert.equal(output.includes(forbidden), false, forbidden);
  }
});

test('CLI fails closed for invalid roots/arguments and reports malformed manifest safely', (t) => {
  const { root, write } = fixture(t);
  const script = path.resolve(__dirname, '../inspect-startup.js');
  const run = (args) => spawnSync(process.execPath, [script, ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PATH: '' }, timeout: 5000,
  });
  for (const args of [[], ['--working-dir'], ['--working-dir', root, '--unknown', 'x'],
    ['--working-dir', root, '--entry-point', '../secret'],
    ['--working-dir', root, '--entry-point', 'https://example.com'],
    ['--working-dir', root, '--working-dir', root]]) {
    const result = run(args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Startup inspection failed/);
    assert.equal(result.stderr.includes(root), false);
  }
  write('package.json', '{a-secret-invalid-json');
  const result = run(['--working-dir', root]);
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).manifest, 'malformed');
  assert.equal(result.stdout.includes('a-secret'), false);
});

test('CLI uses the explicitly selected project even from another cwd', (t) => {
  const { root } = fixture(t);
  const result = spawnSync(process.execPath, [
    path.resolve(__dirname, '../inspect-startup.js'),
    '--working-dir', root, '--entry-point', 'sample-package',
  ], { cwd: os.tmpdir(), encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).node.projectRequirement, '>=22');
});
