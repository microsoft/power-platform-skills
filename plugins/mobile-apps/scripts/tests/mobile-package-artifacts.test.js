'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { unpack, readOfflineContract, verifyInstalledOfflineSdk } = require('../lib/mobile-package-artifacts');
const { createSource } = require('../lib/mobile-published-packages');

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
    artifacts: { [artifact]: hash('native fixture'), 'android/runtime.h': hash('native header fixture') },
  };
  fs.mkdirSync(path.join(sdk, 'android'), { recursive: true });
  fs.writeFileSync(path.join(sdk, artifact), 'native fixture');
  fs.writeFileSync(path.join(sdk, 'android/runtime.h'), 'native header fixture');
  const lock = { packages: { [ENTRY]: { version: '0.2.0', integrity: `sha512-${'A'.repeat(86)}==` } } };
  const reference = structuredClone(lock);
  const published = {
    publication: { package: OFFLINE, version: '0.2.0', integrity: reference.packages[ENTRY].integrity },
    pkg: structuredClone(pkg),
    contract: structuredClone(contract),
  };
  const reads = [];
  const readPackage = (name, version) => {
    reads.push({ name, version });
    assert.equal(name, OFFLINE);
    assert.equal(version, '0.2.0');
    return structuredClone(published);
  };
  return {
    root, sdk, profile, host, pkg, contract, lock, reference, published, reads, readPackage,
    verify() {
      fs.writeFileSync(path.join(sdk, 'package.json'), JSON.stringify(pkg));
      fs.writeFileSync(path.join(sdk, 'compatibility.json'), JSON.stringify(contract));
      verifyInstalledOfflineSdk(root, profile, host, lock, reference, readPackage);
    },
  };
}

test('published offline admission verifies the exact SDK, peer contract and native artifacts', t => {
  const f = offlineFixture(t);
  assert.doesNotThrow(() => f.verify());
  assert.equal(fs.readFileSync(path.join(f.sdk, 'android/runtime.aar'), 'utf8'), 'native fixture');
  assert.deepEqual(f.reads, [{ name: OFFLINE, version: '0.2.0' }]);
  assert.doesNotThrow(() => verifyInstalledOfflineSdk(f.root, {}, {}, {}, {}));
});

test('offline native admission rejects drift without rewriting profiles or SDK files', t => {
  for (const mutate of [
    f => { f.lock.packages[ENTRY].version = '0.1.32'; },
    f => { f.reference.packages[ENTRY].integrity = `sha512-${'B'.repeat(86)}==`; },
    f => { f.published.publication.integrity = `sha512-${'B'.repeat(86)}==`; },
    f => { f.published.publication.version = '0.2.1'; },
    f => { f.host.version = '0.5.1'; },
    f => { f.contract.sourceDirty = true; },
    f => { f.contract.runtimeFamily = 'different-runtime'; },
    f => { f.contract.offlineContractVersion = 2; },
    f => { f.contract.engine = 'jsc'; },
    f => { f.contract.platformArchitectures.ios = ['old']; },
    f => { f.pkg.peerDependencies[HOST] = '^2.0.0'; },
    f => { f.contract.artifacts = {}; },
    f => { f.contract.artifacts = { '../outside': hash('outside') }; },
    f => { delete f.contract.artifacts['android/runtime.h']; },
    f => { fs.unlinkSync(path.join(f.sdk, 'android/runtime.h')); },
    f => {
      fs.writeFileSync(path.join(f.sdk, 'android/runtime.aar'), 'changed native binary');
      f.contract.artifacts['android/runtime.aar'] = hash('changed native binary');
    },
    f => {
      fs.writeFileSync(path.join(f.sdk, 'android/runtime.h'), 'changed header');
      delete f.contract.artifacts['android/runtime.h'];
    },
    f => { fs.appendFileSync(path.join(f.sdk, 'android/runtime.aar'), 'changed'); },
  ]) {
    const f = offlineFixture(t);
    mutate(f);
    const before = structuredClone(f.profile);
    assert.throws(() => f.verify(), error => error.code === 'MOBILE_RELEASE_BLOCKED');
    assert.deepEqual(f.profile, before);
  }
});

test('offline admission cannot fall back to installed metadata when the verified archive is unavailable', t => {
  const f = offlineFixture(t);
  assert.doesNotThrow(() => f.verify());
  assert.throws(() => verifyInstalledOfflineSdk(f.root, f.profile, f.host, f.lock, f.reference),
    /requires an integrity-verified published SDK archive/);
  assert.throws(() => verifyInstalledOfflineSdk(f.root, f.profile, f.host, f.lock, f.reference, () => {
    throw new Error('SDK publication unavailable');
  }), /SDK publication unavailable/);
});

test('a faithfully installed published SDK still must satisfy the host peers and native runtime contract', t => {
  for (const edit of [
    f => { f.contract.runtimeFamily = 'different-family'; },
    f => { f.contract.offlineContractVersion = 2; },
    f => { f.contract.reactNativeVersion = '0.85.0'; },
    f => { f.contract.expoSdkVersion = '55'; },
    f => { f.contract.engine = 'jsc'; },
    f => { f.contract.platformArchitectures.ios = ['old']; },
    f => { f.contract.complete = false; },
    f => { f.contract.sourceDirty = true; },
    f => { f.pkg.peerDependencies[HOST] = f.contract.hostPeerRange = '^2.0.0'; },
    f => { f.pkg.peerDependencies['react-native'] = '0.85.x'; },
    f => { f.host.peerDependencies[OFFLINE] = '^0.3.0'; },
  ]) {
    const f = offlineFixture(t);
    edit(f);
    f.published.pkg = structuredClone(f.pkg);
    f.published.contract = structuredClone(f.contract);
    assert.throws(() => f.verify(), /peers and native runtime contract disagree/);
  }
});

test('SDK archive inspection checks all declared artifacts and rejects an internally inconsistent contract', t => {
  const f = offlineFixture(t);
  f.verify();
  assert.deepEqual(readOfflineContract(f.sdk), f.published.contract);
  fs.writeFileSync(path.join(f.sdk, 'android/runtime.h'), 'bad published header');
  assert.throws(() => readOfflineContract(f.sdk), /artifact hash differs/);
});

test('offline admission binds the verified registry archive to the immutable template SRI and cleans scratch', t => {
  const f = offlineFixture(t);
  f.verify();
  fs.cpSync(f.sdk, path.join(f.root, 'package'), { recursive: true });
  const archive = path.join(f.root, 'offline.tgz');
  const packed = spawnSync('tar', ['-czf', 'offline.tgz', 'package'], { cwd: f.root, encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  const integrity = `sha512-${createHash('sha512').update(fs.readFileSync(archive)).digest('base64')}`;
  for (const lock of [f.lock, f.reference]) lock.packages[ENTRY].integrity = integrity;
  const scratch = [];
  let corrupt = false;
  let missingIntegrity = false;
  const options = {
    cwd: f.root,
    run(command, args, cwd) {
      if (command === 'npm') {
        assert.equal(cwd, f.root);
        assert.equal(args[1], `${OFFLINE}@0.2.0`);
        if (args[0] === 'view') return JSON.stringify({
          name: OFFLINE, version: '0.2.0', dist: missingIntegrity ? {} : { integrity },
        });
        assert.deepEqual(args.slice(0, 5), ['pack', `${OFFLINE}@0.2.0`, '--ignore-scripts', '--json', '--pack-destination']);
        const destination = args[5];
        scratch.push(destination);
        fs.copyFileSync(archive, path.join(destination, 'offline.tgz'));
        if (corrupt) fs.appendFileSync(path.join(destination, 'offline.tgz'), 'altered archive');
        return JSON.stringify([{ name: OFFLINE, version: '0.2.0', integrity, filename: 'offline.tgz' }]);
      }
      assert.equal(command, 'tar');
      const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    },
  };
  const source = createSource(options);
  const verify = reader => verifyInstalledOfflineSdk(f.root, f.profile, f.host, f.lock, f.reference, reader);
  verify(source.read);
  assert.deepEqual(source.read(OFFLINE, '0.2.0').contract.artifacts, f.contract.artifacts);
  assert.equal(scratch.length, 1, 'Reuse the verified reference within the same resolution');
  for (const lock of [f.lock, f.reference]) lock.packages[ENTRY].integrity = `sha512-${'B'.repeat(86)}==`;
  assert.throws(() => verify(source.read), /immutable template lock integrity/);
  for (const lock of [f.lock, f.reference]) lock.packages[ENTRY].integrity = integrity;
  corrupt = true;
  assert.throws(() => verify(createSource(options).read), /bytes do not match/);
  corrupt = false;
  missingIntegrity = true;
  assert.throws(() => verify(createSource(options).read), /integrity/);
  assert.ok(scratch.every(directory => !fs.existsSync(directory)));
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
