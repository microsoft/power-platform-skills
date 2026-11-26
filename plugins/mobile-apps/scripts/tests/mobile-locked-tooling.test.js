'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');
const { runCliSync } = require('../lib/process-runner');
const { writeJson } = require('./helpers/mobile-release-fixture');

test('real npm acquires the published Host with its locked peer even when a newer incompatible peer is available', async t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-locked-tooling-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'old app');
  const destination = path.join(root, 'reference');
  const host = '@microsoft/power-apps-native-host';
  const template = '@microsoft/power-apps-native-template';
  const releases = new Map();
  const tarballs = new Map();
  const requested = [];

  const server = http.createServer((req, res) => {
    const key = decodeURIComponent(req.url.slice(1));
    if (tarballs.has(key)) {
      requested.push(key);
      res.end(tarballs.get(key));
    } else if (releases.has(key)) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(releases.get(key)));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const registry = `http://127.0.0.1:${server.address().port}/`;
  function publish(name, version, fields = {}, files = {}) {
    const archive = `tarball-${tarballs.size}.tgz`;
    const dir = path.join(root, archive + '-src');
    const pkg = { name, version, ...fields };
    writeJson(path.join(dir, 'package/package.json'), pkg);
    for (const [file, content] of Object.entries(files)) {
      const target = path.join(dir, 'package', file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content));
    }
    runCliSync('tar', ['-czf', archive, 'package'], { cwd: dir });
    const bytes = fs.readFileSync(path.join(dir, archive));
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    tarballs.set(archive, bytes);
    const meta = releases.get(name) || { name, versions: {}, 'dist-tags': {} };
    meta.versions[version] = { ...pkg, dist: { integrity, tarball: registry + archive } };
    meta['dist-tags'].latest = version;
    releases.set(name, meta);
    return { version, integrity };
  }

  const version = '1.0.0';
  const deps = { react: version, 'react-native': version, expo: version, 'expo-haptics': version };
  const manifest = { name: 'fixture-app', version, dependencies: { ...deps, [host]: '^1.0.0' } };
  const packages = { '': manifest };
  for (const name of ['react', 'react-native', 'expo']) packages[`node_modules/${name}`] = publish(name, version);
  const peerDependencies = { 'fixture-renderer': '^1.0.0', react: '^1.0.0' };
  packages['node_modules/expo-haptics'] = { ...publish('expo-haptics', version, { peerDependencies }), peerDependencies };
  const compatible = { peerDependencies: { react: '^1.0.0' }, peerDependenciesMeta: { react: { optional: true } } };
  packages['node_modules/fixture-renderer'] = { ...publish('fixture-renderer', version, compatible), ...compatible, peer: true };
  const nativeRuntime = Object.fromEntries(['android', 'ios'].map(p => [p, { version: 1, fingerprint: 'a'.repeat(64) }]));
  const profile = { schemaVersion: 1, targetTemplateVersion: 1, nativeRuntime, expoVersion: version, managedDependencies: deps, migrations: [] };
  const bin = { 'upgrade-template': 'scripts/upgrade.js' };
  packages[`node_modules/${host}`] = { ...publish(host, version, { bin }, {
    'scripts/upgrade.js': '#!/usr/bin/env node\n', 'compatibility/current.json': profile,
  }), bin };
  publish(template, version, {}, {
    'template/app.json': { expo: { extra: { powerappsNative: { schemaVersion: 1, templateVersion: 1, nativeRuntimeVersions: { android: 1, ios: 1 } } } } },
    'template/package.json': manifest,
    'template/package-lock.json': { name: manifest.name, version, lockfileVersion: 3, packages },
  });
  // This later release satisfies the renderer range but not the frozen React peer.
  publish('react', '2.0.0');
  publish('fixture-renderer', '1.1.0', { ...compatible, peerDependencies: { react: '^2.0.0' } });
  const incompatibleTarball = new URL(releases.get('fixture-renderer').versions['1.1.0'].dist.tarball).pathname.slice(1);
  writeJson(path.join(source, 'package.json'), { name: 'customer-app', private: true });
  fs.writeFileSync(path.join(source, '.npmrc'), `registry=${registry}\n@microsoft:registry=${registry}\n`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)));
  Object.assign(env, {
    npm_config_registry: registry, npm_config_cache: path.join(root, 'cache'), npm_config_userconfig: path.join(root, 'user.npmrc'),
    npm_config_globalconfig: path.join(root, 'global.npmrc'), npm_config_fetch_retries: '0',
  });
  const { stdout } = await promisify(execFile)(process.execPath, [
    path.resolve(__dirname, '../mobile-template-lifecycle.js'), 'acquire', '--destination', destination, '--host-version', version,
  ], { cwd: source, env, timeout: 90000 });
  const result = JSON.parse(stdout);
  assert.equal(result.toolingResolution, 'published-template-lock');
  assert.equal(JSON.parse(fs.readFileSync(path.join(destination, 'node_modules/fixture-renderer/package.json'))).version, version);
  assert.ok(fs.statSync(path.join(destination, result.upgradeCli)).isFile());
  assert.ok(!requested.includes(incompatibleTarball));
  assert.deepEqual(fs.readdirSync(source).sort(), ['.npmrc', 'package.json']);
  assert.equal(fs.existsSync(path.join(destination, '.npmrc')), false);
});
