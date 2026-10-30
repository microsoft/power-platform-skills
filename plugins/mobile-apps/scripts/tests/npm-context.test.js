'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { fork } = require('node:child_process');
const { runCliSync } = require('../lib/process-runner');
const { withNpmContext } = require('../lib/npm-context');

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-npm-context-')));
  const source = path.join(root, 'source app');
  const target = path.join(root, 'tooling');
  for (const dir of [source, target]) {
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"context-fixture","private":true}');
  }
  const previous = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (/^npm_config_/i.test(key)) delete process.env[key];
  }
  process.env.npm_config_userconfig = path.join(root, 'user.npmrc');
  process.env.npm_config_globalconfig = path.join(root, 'global.npmrc');
  process.env.npm_config_cache = path.join(root, 'cache');
  fs.writeFileSync(process.env.npm_config_globalconfig, 'registry=https://global.example.invalid/\n');
  fs.writeFileSync(process.env.npm_config_userconfig, 'registry=https://user.example.invalid/\nfetch-retries=4\n');
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const get = (cwd, env, key) => runCliSync('npm', ['config', 'get', key], {
    cwd, env, encoding: 'utf8', timeout: 15000,
  }).trim();
  return { root, source, target, get };
}

test('isolated npm retains project, user and environment precedence and removes temporary credentials', t => {
  const { root, source, target, get } = fixture(t);
  const config = [
    'registry=https://project.example.invalid/',
    '@fixture:registry=https://scoped.example.invalid/',
    '//scoped.example.invalid/:_authToken=synthetic-test-token',
    'fetch-retries=2',
    'cafile=./certificate.pem',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(source, '.npmrc'), config);
  fs.writeFileSync(path.join(source, 'certificate.pem'), 'fixture-only certificate');
  process.env.npm_config_fetch_retries = '1';
  for (const fail of [false, true]) {
    const operation = () => withNpmContext(source, target, (env, cwd) => {
      assert.equal(cwd, fs.realpathSync.native(source));
      assert.equal(get(cwd, env, 'registry'), get(source, process.env, 'registry'));
      assert.equal(get(cwd, env, '@fixture:registry'), 'https://scoped.example.invalid/');
      assert.equal(get(cwd, env, 'fetch-retries'), '1');
      assert.equal(get(cwd, env, 'cafile'), path.join(source, 'certificate.pem'));
      assert.equal(env.npm_config_userconfig, path.join(root, 'user.npmrc'));
      assert.equal(env.npm_config_global, 'false');
      assert.equal(env.npm_config_prefix, target);
      assert.match(fs.readFileSync(path.join(target, '.npmrc'), 'utf8'), /synthetic-test-token/);
      if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(target, '.npmrc')).mode & 0o777, 0o600);
      if (fail) throw new Error('Synthetic failed installation');
      return 'installed';
    });
    if (fail) assert.throws(operation, /Synthetic failed installation/);
    else assert.equal(operation(), 'installed');
    assert.equal(fs.existsSync(path.join(target, '.npmrc')), false);
    assert.equal(fs.readFileSync(path.join(source, '.npmrc'), 'utf8'), config);
  }
});

test('npm context never overwrites a pre-existing tooling config', t => {
  const { source, target } = fixture(t);
  fs.writeFileSync(path.join(source, '.npmrc'), 'registry=https://project.example.invalid/\n');
  fs.writeFileSync(path.join(target, '.npmrc'), 'keep');
  assert.throws(() => withNpmContext(source, target, () => assert.fail('Do not install')), /EEXIST/);
  assert.equal(fs.readFileSync(path.join(target, '.npmrc'), 'utf8'), 'keep');
});

test('real npm acquisition writes only its isolated prefix and never executes package lifecycle scripts', t => {
  const { root, source, target } = fixture(t);
  const original = '{"name":"source-app","private":true,"dependencies":{"unavailable-source-package":"99.0.0"}}';
  fs.writeFileSync(path.join(source, 'package.json'), original);
  fs.mkdirSync(path.join(root, 'package'));
  fs.writeFileSync(path.join(root, 'package/package.json'), JSON.stringify({
    name: 'context-probe', version: '1.0.0',
    scripts: { install: 'node -e "throw new Error(\'Lifecycle must not execute\')"' },
  }));
  runCliSync('tar', ['-czf', 'probe.tgz', 'package'], { cwd: root, encoding: 'utf8', timeout: 10000 });
  withNpmContext(source, target, (env, cwd) => runCliSync('npm', [
    'install', path.join(root, 'probe.tgz'), '--ignore-scripts', '--no-audit', '--no-fund',
    '--prefix', target,
  ], { cwd, env, encoding: 'utf8', timeout: 30000 }));
  const installed = JSON.parse(fs.readFileSync(path.join(target, 'node_modules/context-probe/package.json'), 'utf8'));
  assert.equal(installed.version, '1.0.0');
  assert.equal(fs.readFileSync(path.join(source, 'package.json'), 'utf8'), original);
  assert.equal(fs.existsSync(path.join(source, 'node_modules')), false);
  assert.equal(fs.existsSync(path.join(source, 'package-lock.json')), false);
  assert.equal(fs.existsSync(path.join(target, '.npmrc')), false);
});

test('real isolated npm requests carry only the synthetic project-scoped registry credential', async t => {
  const { root, source, target } = fixture(t);
  const serverFile = path.join(root, 'registry.cjs');
  const requestFile = path.join(root, 'request.json');
  fs.writeFileSync(serverFile, `
const http = require('node:http');
const fs = require('node:fs');
const server = http.createServer((request, response) => {
  fs.writeFileSync(${JSON.stringify(requestFile)}, JSON.stringify({ url: request.url, authorization: request.headers.authorization }));
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ name: 'context-fixture', 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { name: 'context-fixture', version: '1.0.0' } } }));
});
server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
`);
  const server = fork(serverFile, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (server.exitCode === null && server.signalCode === null) server.kill(); });
  const port = await new Promise((resolve, reject) => {
    server.once('message', message => resolve(message.port));
    server.once('error', reject);
    server.once('exit', code => reject(new Error(`Fixture registry exited: ${code}`)));
  });
  fs.writeFileSync(path.join(source, '.npmrc'),
    `registry=http://127.0.0.1:${port}/\n//127.0.0.1:${port}/:_authToken=synthetic-registry-token\n`);
  const result = withNpmContext(source, target, (env, cwd) => runCliSync('npm', [
    'view', 'context-fixture', 'version', '--json', '--fetch-timeout=5000', '--fetch-retries=0',
  ], { cwd, env, encoding: 'utf8', timeout: 10000 }));
  assert.equal(JSON.parse(result), '1.0.0');
  assert.deepEqual(JSON.parse(fs.readFileSync(requestFile, 'utf8')), {
    url: '/context-fixture', authorization: 'Bearer synthetic-registry-token',
  });
  assert.equal(fs.existsSync(path.join(target, '.npmrc')), false);
});
