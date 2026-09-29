'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolvePackageBin, resolveNpmCli, runNodeScript, runNpm } = require('../lib/node-tool.js');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-nt-')); }

test('resolvePackageBin reads a string bin', () => {
  const d = tmp();
  const pkg = path.join(d, 'node_modules', 'pcf-scripts');
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'pcf-scripts', bin: './bin/pcf-scripts.js' }));
  fs.writeFileSync(path.join(pkg, 'bin', 'pcf-scripts.js'), '');
  assert.equal(resolvePackageBin(d, 'pcf-scripts'), path.join(pkg, 'bin', 'pcf-scripts.js'));
});

test('resolvePackageBin reads a map bin by name and returns null when absent', () => {
  const d = tmp();
  const pkg = path.join(d, 'node_modules', 'jest');
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'jest', bin: { jest: './bin/jest.js' } }));
  fs.writeFileSync(path.join(pkg, 'bin', 'jest.js'), '');
  assert.equal(resolvePackageBin(d, 'jest'), path.join(pkg, 'bin', 'jest.js'));
  assert.equal(resolvePackageBin(d, 'missing-pkg'), null);
});

test('resolveNpmCli prefers npm_execpath, then the node-adjacent install', () => {
  const d = tmp();
  const cli = path.join(d, 'npm-cli.js'); fs.writeFileSync(cli, '');
  assert.deepEqual(resolveNpmCli({ env: { npm_execpath: cli }, execPath: path.join(d, 'node.exe'), platform: 'win32', fs }), { cliPath: cli });
  const win = path.join(d, 'node_modules', 'npm', 'bin'); fs.mkdirSync(win, { recursive: true });
  fs.writeFileSync(path.join(win, 'npm-cli.js'), '');
  assert.deepEqual(resolveNpmCli({ env: {}, execPath: path.join(d, 'node.exe'), platform: 'win32', fs }), { cliPath: path.join(win, 'npm-cli.js') });
  const r = resolveNpmCli({ env: {}, execPath: path.join(d, 'nope', 'node'), platform: 'linux', fs });
  assert.match(r.error, /--npm-cli/);
});

test('runNodeScript spawns the current node with shell:false and an argv array', () => {
  const calls = [];
  const fake = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { status: 0, stdout: 'ok', stderr: '' }; };
  const r = runNodeScript('/x/bin.js', ['build', '--buildMode', 'production'], { cwd: '/p', spawnSync: fake });
  assert.equal(r.status, 0);
  assert.equal(calls[0].cmd, process.execPath);
  assert.deepEqual(calls[0].args, ['/x/bin.js', 'build', '--buildMode', 'production']);
  assert.equal(calls[0].opts.shell, false);
  assert.equal(calls[0].opts.cwd, '/p');
});

test('runNpm executes npm-cli.js through the current node without a shell', () => {
  const calls = [];
  const fake = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { status: 0, stdout: 'built', stderr: '' }; };
  const r = runNpm(['install', '--ignore-scripts'], { cwd: '/p', npmCli: '/npm/bin/npm-cli.js', spawnSync: fake });
  assert.equal(r.status, 0);
  assert.equal(calls[0].cmd, process.execPath);
  assert.deepEqual(calls[0].args, ['/npm/bin/npm-cli.js', 'install', '--ignore-scripts']);
  assert.equal(calls[0].opts.shell, false);
  assert.equal(calls[0].opts.cwd, '/p');
});
