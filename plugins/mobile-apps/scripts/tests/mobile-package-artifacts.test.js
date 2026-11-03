'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { unpack, verifyInstalledOfflineSdk } = require('../lib/mobile-package-artifacts');

const HOST = '@microsoft/power-apps-native-host';
const OFFLINE = '@microsoft/power-apps-native-offline';
const ENTRY = `node_modules/${OFFLINE}`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-package-artifact-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('archive inspection rejects links, duplicate names and traversal before extraction', t => {
  const root = directory(t);
  const archive = path.join(root, 'source.tgz');
  fs.writeFileSync(archive, 'verified test archive');
  for (const [names, types, valid] of [
    ['package/\npackage/package.json', 'drwx package/\n-rw package/package.json', true],
    ['package/../escape', '-rw package/../escape', false],
    ['package/file\npackage/file', '-rw package/file\n-rw package/file', false],
    ['package/link', 'lrwx package/link -> /outside', false],
    ['package/drive:C', '-rw package/drive:C', false],
  ]) {
    let extracted = false;
    const execute = () => unpack(archive, root, (_command, args, cwd) => {
      assert.equal(cwd, root);
      assert.deepEqual(fs.readFileSync(path.join(root, 'artifact.tgz')), fs.readFileSync(archive));
      if (args[0] === '-tzf') return names;
      if (args[0] === '-tvzf') return types;
      extracted = true;
      return '';
    });
    if (valid) assert.equal(execute(), path.join(root, 'package'));
    else assert.throws(execute, /unsafe archive paths/);
    assert.equal(extracted, valid);
    assert.equal(fs.existsSync(path.join(root, 'artifact.tgz')), false);
    assert.equal(fs.readFileSync(archive, 'utf8'), 'verified test archive');
  }
  assert.throws(() => unpack(archive, root, () => { throw new Error('tar failed'); }), /tar failed/);
  assert.equal(fs.existsSync(path.join(root, 'artifact.tgz')), false);
});

function offlineFixture(t) {
  const root = directory(t);
  const sdk = path.join(root, ENTRY);
  const profile = {
    expoSdk: 57, runtimeFamily: 'expo57-rn86-hermes-newarch', offlineContractVersion: 1,
    managedDependencies: { [OFFLINE]: '0.2.0', 'react-native': '0.86.3' },
  };
  const host = { version: '1.0.0', peerDependencies: { [OFFLINE]: '0.2.0' } };
  const pkg = { name: OFFLINE, version: '0.2.0', peerDependencies: { [HOST]: '^1.0.0', 'react-native': '0.86.3' } };
  const artifact = 'android/runtime.aar';
  const contract = {
    schemaVersion: 2, complete: true, sourceDirty: false, packageVersion: '0.2.0',
    expoSdkVersion: 57, reactNativeVersion: '0.86.3',
    runtimeFamily: profile.runtimeFamily, offlineContractVersion: 1, engine: 'hermes',
    hostPeerRange: '^1.0.0', platformArchitectures: { android: ['new'], ios: ['new'] },
    artifacts: { [artifact]: hash('native fixture') },
  };
  fs.mkdirSync(path.join(sdk, 'android'), { recursive: true });
  fs.writeFileSync(path.join(sdk, artifact), 'native fixture');
  const lock = { packages: { [ENTRY]: { version: '0.2.0', integrity: `sha512-${'A'.repeat(86)}==` } } };
  const reference = structuredClone(lock);
  return {
    root, sdk, profile, host, pkg, contract, lock, reference,
    verify() {
      fs.writeFileSync(path.join(sdk, 'package.json'), JSON.stringify(pkg));
      fs.writeFileSync(path.join(sdk, 'compatibility.json'), JSON.stringify(contract));
      verifyInstalledOfflineSdk(root, profile, host, lock, reference);
    },
  };
}

test('published offline admission verifies the exact SDK, peer contract and native artifacts', t => {
  const f = offlineFixture(t);
  assert.doesNotThrow(() => f.verify());
  assert.equal(fs.readFileSync(path.join(f.sdk, 'android/runtime.aar'), 'utf8'), 'native fixture');
  assert.doesNotThrow(() => verifyInstalledOfflineSdk(f.root, {}, {}, {}, {}));
});

test('offline native admission rejects drift without rewriting profiles or SDK files', t => {
  for (const mutate of [
    f => { f.lock.packages[ENTRY].version = '0.1.32'; },
    f => { f.reference.packages[ENTRY].integrity = `sha512-${'B'.repeat(86)}==`; },
    f => { f.host.version = '0.5.1'; },
    f => { f.contract.sourceDirty = true; },
    f => { f.contract.runtimeFamily = 'different-runtime'; },
    f => { f.contract.offlineContractVersion = 2; },
    f => { f.contract.engine = 'jsc'; },
    f => { f.contract.platformArchitectures.ios = ['old']; },
    f => { f.pkg.peerDependencies[HOST] = '^2.0.0'; },
    f => { f.contract.artifacts = {}; },
    f => { f.contract.artifacts = { '../outside': hash('outside') }; },
    f => { fs.appendFileSync(path.join(f.sdk, 'android/runtime.aar'), 'changed'); },
  ]) {
    const f = offlineFixture(t);
    mutate(f);
    const before = structuredClone(f.profile);
    assert.throws(() => f.verify(), error => error.code === 'MOBILE_RELEASE_BLOCKED');
    assert.deepEqual(f.profile, before);
  }
});

test('retired artifact options cannot acquire templates or admit a project', t => {
  const root = directory(t);
  for (const args of [
    ['resolve-mobile-release.js', '--diagnostic-artifacts', 'retired.json'],
    ['mobile-template-lifecycle.js', 'acquire', '--destination', path.join(root, 'app'), '--diagnostic-artifacts', 'retired.json'],
    ['validate-mobile-files.js', '--project-root', root, '--all-source', '--diagnostic-artifacts', 'retired.json'],
  ]) {
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '..', args[0]), ...args.slice(1)], {
      encoding: 'utf8', env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '1' },
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /BLOCKED/);
    assert.equal(fs.existsSync(path.join(root, 'app')), false);
  }
});
