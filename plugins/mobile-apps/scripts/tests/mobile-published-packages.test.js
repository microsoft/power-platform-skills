'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const {
  HOST, TEMPLATE, createSource, selectPublishedContract, selectTemplateContract,
  readSourceRequirements, projectContract, planPublishedUpdate,
} = require('../lib/mobile-published-packages');
const { acquireHost } = require('../mobile-template-lifecycle');
const { readProject, readPlatformContext, validateProjectAgainstRelease } = require('../lib/mobile-release');
const { fixtureRelease, writeProject, writeJson, modifyJson, addDependency } = require('./helpers/mobile-release-fixture');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'published-mobile-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const projectRoot = path.join(directory, 'app');
  const release = fixtureRelease();
  release.platforms.android.fingerprint = 'a'.repeat(64);
  release.platforms.ios.fingerprint = 'b'.repeat(64);
  writeProject(projectRoot, release);
  const packages = new Map();
  const publication = (name, version) => ({
    package: name, version, integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
  });
  function host(version, templateVersion = 1, nativeVersion = 1, migrations = []) {
    const profile = {
      schemaVersion: 1, targetTemplateVersion: templateVersion, expoVersion: '1.0.0',
      managedDependencies: { expo: '1.0.0', react: '1.0.0', 'react-native': '1.0.0', 'expo-haptics': '1.0.0' },
      nativeRuntime: {
        android: { version: nativeVersion, fingerprint: (nativeVersion === 1 ? 'a' : 'c').repeat(64) },
        ios: { version: nativeVersion, fingerprint: (nativeVersion === 1 ? 'b' : 'd').repeat(64) },
      },
      migrations: migrations.map((migration) => migration.id),
    };
    const record = { publication: publication(HOST, version), pkg: { name: HOST, version }, profile, migrations };
    packages.set(`${HOST}@${version}`, record);
    return record;
  }
  function template(version, hostVersion = '1.0.0') {
    const selectedHost = packages.get(`${HOST}@${hostVersion}`);
    const manifest = { name: 'fixture-app', dependencies: { ...release.managedDependencies.dependencies, [HOST]: `^${hostVersion}` } };
    const record = {
      publication: publication(TEMPLATE, version), pkg: { name: TEMPLATE, version },
      app: { expo: { extra: { powerappsNative: {
        schemaVersion: 1, templateVersion: selectedHost.profile.targetTemplateVersion,
        nativeRuntimeVersions: Object.fromEntries(['android', 'ios'].map((platform) => [platform, selectedHost.profile.nativeRuntime[platform].version])),
      } } } },
      manifest,
      lock: {
        lockfileVersion: 3,
        packages: {
          '': structuredClone(manifest),
          ...Object.fromEntries(Object.entries(release.nativePackages).map(([name, installedVersion]) => [name, {
            version: name === `node_modules/${HOST}` ? hostVersion : installedVersion,
          }])),
        },
      },
    };
    packages.set(`${TEMPLATE}@${version}`, record);
    return record;
  }
  const baseline = host('1.0.0');
  template('1.0.0');
  writeJson(path.join(projectRoot, 'node_modules', HOST, 'compatibility/current.json'), baseline.profile);
  const requests = [];
  const options = {
    versions: () => [...packages.values()].filter((record) => record.pkg.name === TEMPLATE).map((record) => record.pkg.version),
    readPackage(name, version) {
      requests.push(`${name}@${version}`);
      const record = packages.get(`${name}@${version}`);
      if (!record) {
        const error = new Error('Selected exact package is not published');
        error.code = 'MOBILE_RELEASE_BLOCKED';
        throw error;
      }
      return structuredClone(record);
    },
  };
  return { directory, projectRoot, release, packages, requests, host, template, options };
}

function migration(version = '2.0.0', from = '^1.0.0') {
  return {
    id: 'template-v2', fromTemplateVersion: 1, toTemplateVersion: 2,
    targetProfile: { hostVersion: version },
    packageTransitions: { dependencies: { [HOST]: { from, to: `^${version}` } } },
  };
}

test('requirements-only inspection reads recorded state without a catalogue or registry', (t) => {
  const f = fixture(t);
  modifyJson(path.join(f.projectRoot, 'node_modules', HOST, 'package.json'), (pkg) => { pkg.version = '2.0.0'; });
  assert.deepEqual(readSourceRequirements(f.projectRoot), {
    templateVersion: 1, nativeRuntimeVersions: { android: 1, ios: 1 },
    hostVersion: '2.0.0', validationScope: 'requirements-only',
  });
  assert.deepEqual(f.requests, []);
});

test('published contract derives native pins from the template lock without inventing binary availability', (t) => {
  const f = fixture(t);
  const result = selectPublishedContract('1.0.0', f.options);
  assert.equal(result.source, 'npm');
  assert.equal(result.host.version, '1.0.0');
  assert.equal(result.template.version, '1.0.0');
  assert.deepEqual(result.platforms.android, { fingerprint: 'a'.repeat(64) });
  assert.equal(result.evidence, undefined);
  assert.equal(selectTemplateContract('1.0.0', f.options).id, result.id);
});

test('explicit template selection is retained when resolving a compatible installed project', t => {
  const f = fixture(t);
  f.template('1.0.1');
  const installed = readProject(f.projectRoot, readPlatformContext());
  const selected = projectContract(f.projectRoot, installed, { ...f.options, templateVersion: '1.0.0' });
  assert.equal(selected.template.version, '1.0.0');
  validateProjectAgainstRelease(installed, selected);
  assert.equal(projectContract(f.projectRoot, installed, f.options).template.version, '1.0.1');
  const records = path.join(f.directory, 'packages.json');
  writeJson(records, Object.fromEntries(f.packages));
  const preload = path.join(f.directory, 'published-fixture.cjs');
  fs.writeFileSync(preload, `
const records = require(${JSON.stringify(records)});
const source = require(${JSON.stringify(require.resolve('../lib/mobile-published-packages'))});
const injected = {
  readPackage(name, version) { return structuredClone(records[name + '@' + version]); },
  versions() { return Object.values(records).filter(record => record.pkg.name === ${JSON.stringify(TEMPLATE)}).map(record => record.pkg.version); },
};
for (const name of ['selectTemplateContract', 'projectContract']) {
  const original = source[name];
  source[name] = (...args) => {
    const index = name === 'projectContract' ? 2 : 1;
    args[index] = { ...injected, ...args[index] };
    return original(...args);
  };
}
`);
  const result = spawnSync(process.execPath, [
    '--require', preload, path.resolve(__dirname, '../resolve-mobile-release.js'),
    '--project-root', f.projectRoot, '--template-version', '1.0.0',
  ], { cwd: f.projectRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).template.version, '1.0.0');
});

test('same-runtime host patch uses the existing compatible template without a Player release record', (t) => {
  const f = fixture(t);
  f.host('1.0.1');
  const result = planPublishedUpdate(f.projectRoot, '1.0.1', f.options);
  assert.equal(result.kind, 'host-repair');
  assert.equal(result.migrationRequired, false);
  assert.equal(result.nativeChanged, false);
  assert.equal(result.target.hostVersion, '1.0.1');
  assert.equal(result.target.template.version, '1.0.0');
  assert.match(result.binaryAvailability, /not-checked/);
});

test('a non-native template migration advances template state without changing native runtime', (t) => {
  const f = fixture(t);
  f.host('1.1.0', 2, 1, [migration('1.1.0')]);
  f.template('1.1.0', '1.1.0');
  const result = planPublishedUpdate(f.projectRoot, '1.1.0', f.options);
  assert.equal(result.kind, 'template-upgrade');
  assert.equal(result.nativeChanged, false);
  assert.deepEqual(result.target.nativeRuntimeVersions, { android: 1, ios: 1 });
});

test('native major transition uses host migrations and reports binary availability separately', (t) => {
  const f = fixture(t);
  f.host('2.0.0', 2, 2, [migration()]);
  f.template('2.0.0', '2.0.0');
  const result = planPublishedUpdate(f.projectRoot, '2.0.0', f.options);
  assert.equal(result.kind, 'template-upgrade');
  assert.equal(result.nativeChanged, true);
  assert.equal(result.fullChainPreviewRequired, true);
  assert.equal(result.target.nativeRuntimeVersions.android, 2);
  assert.equal(result.target.platforms.android.player, undefined);
});

test('a manually updated host does not hide the older recorded template or require another host major', (t) => {
  const f = fixture(t);
  f.host('2.0.0', 2, 2, [migration()]);
  f.template('2.0.0', '2.0.0');
  modifyJson(path.join(f.projectRoot, 'node_modules', HOST, 'package.json'), (pkg) => { pkg.version = '2.0.0'; });
  const result = planPublishedUpdate(f.projectRoot, '2.0.0', f.options);
  assert.equal(result.kind, 'template-upgrade');
  assert.equal(result.hostInstallRequired, false);
  assert.equal(result.source.templateVersion, 1);
  assert.equal(result.target.templateVersion, 2);
});

test('native changes cannot be hidden in a patch or minor target', (t) => {
  const f = fixture(t);
  f.host('1.1.0', 2, 2, [migration('1.1.0')]);
  f.template('1.1.0', '1.1.0');
  assert.throws(() => planPublishedUpdate(f.projectRoot, '1.1.0', f.options), /new host major/);
});

test('unpublished or unfinalized targets fail before mutation without falling back', (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(path.join(f.projectRoot, 'package.json'), 'utf8');
  assert.throws(() => planPublishedUpdate(f.projectRoot, '2.0.0', f.options), /not published/);
  assert.deepEqual(f.requests, [`${HOST}@2.0.0`]);
  f.host('2.0.0', 2, 2, [migration('__RELEASE_HOST_VERSION__')]);
  assert.throws(() => planPublishedUpdate(f.projectRoot, '2.0.0', f.options), /unfinalized/);
  f.host('2.0.0', 2, 2, [migration()]).profile.runtimePreparation = { baseCommit: 'a'.repeat(40) };
  assert.throws(() => planPublishedUpdate(f.projectRoot, '2.0.0', f.options), /diagnostic runtime preparation/);
  assert.equal(fs.readFileSync(path.join(f.projectRoot, 'package.json'), 'utf8'), before);
});

test('downgrades and missing migration edges are rejected', (t) => {
  const f = fixture(t);
  f.host('0.9.0');
  assert.throws(() => planPublishedUpdate(f.projectRoot, '0.9.0', f.options), /downgrade/);
  f.host('2.0.0', 2, 2);
  f.template('2.0.0', '2.0.0');
  assert.throws(() => planPublishedUpdate(f.projectRoot, '2.0.0', f.options), /migration chain/);
});

test('equal version is current only after lock and installed-native validation', (t) => {
  const f = fixture(t);
  assert.equal(planPublishedUpdate(f.projectRoot, '1.0.0', f.options).kind, 'current');
  modifyJson(path.join(f.projectRoot, 'node_modules/expo-haptics/package.json'), (pkg) => { pkg.version = '1.0.1'; });
  assert.throws(() => planPublishedUpdate(f.projectRoot, '1.0.0', f.options), /differs from the app lock/);
});

test('native inventory comes from the published lock, never from the customer lock', (t) => {
  const f = fixture(t);
  const project = () => readProject(f.projectRoot, readPlatformContext());
  validateProjectAgainstRelease(project(), projectContract(f.projectRoot, project(), f.options));
  modifyJson(path.join(f.projectRoot, 'node_modules/expo-haptics/package.json'), (pkg) => { pkg.version = '1.0.1'; });
  modifyJson(path.join(f.projectRoot, 'package-lock.json'), (lock) => { lock.packages['node_modules/expo-haptics'].version = '1.0.1'; });
  const changed = project();
  assert.throws(() => validateProjectAgainstRelease(changed, projectContract(f.projectRoot, changed, f.options)), /native inventory/);
});

test('custom native code cannot extend the fixed runtime', (t) => {
  const f = fixture(t);
  addDependency(f.projectRoot, 'ordinary-wrapper', '1.0.0');
  fs.mkdirSync(path.join(f.projectRoot, 'node_modules/ordinary-wrapper/android'));
  const project = readProject(f.projectRoot, readPlatformContext());
  assert.throws(() => validateProjectAgainstRelease(project, projectContract(f.projectRoot, project, f.options)), /not managed|Unreviewed native/);
});

test('runtime labels cannot excuse mismatching published fingerprints', (t) => {
  const f = fixture(t);
  f.host('1.0.1').profile.nativeRuntime.android.fingerprint = 'f'.repeat(64);
  assert.throws(() => selectPublishedContract('1.0.1', f.options), /fingerprint/);
});

test('a matching new template cannot conceal a native fingerprint change under unchanged runtime counters', (t) => {
  const f = fixture(t);
  f.host('1.1.0', 2, 1, [migration('1.1.0')]).profile.nativeRuntime.android.fingerprint = 'f'.repeat(64);
  f.template('1.1.0', '1.1.0');
  assert.throws(() => planPublishedUpdate(f.projectRoot, '1.1.0', f.options), /fingerprint change must advance/);
});

test('current-state admission rejects a locally altered host profile', (t) => {
  const f = fixture(t);
  modifyJson(path.join(f.projectRoot, 'node_modules', HOST, 'compatibility/current.json'), (profile) => {
    profile.managedDependencies['expo-haptics'] = '2.0.0';
  });
  assert.throws(() => planPublishedUpdate(f.projectRoot, '1.0.0', f.options), /metadata differs/);
});

test('metadata cannot substitute the wrong template lock or core runtime', (t) => {
  const f = fixture(t);
  const template = f.packages.get(`${TEMPLATE}@1.0.0`);
  template.lock.packages['node_modules/expo'].version = '2.0.0';
  assert.throws(() => selectPublishedContract('1.0.0', f.options), /Expo\/React/);
  template.lock.packages['node_modules/expo'].version = '1.0.0';
  template.manifest.dependencies.react = '2.0.0';
  assert.throws(() => selectPublishedContract('1.0.0', f.options), /declarations differ/);
});

test('native metadata mutation is rejected without a template edge', (t) => {
  const f = fixture(t);
  f.host('2.0.0', 1, 2);
  f.template('2.0.0', '2.0.0');
  assert.throws(() => planPublishedUpdate(f.projectRoot, '2.0.0', f.options), /host-owned template migration/);
});

test('archive inspection checks real bytes, skips lifecycle scripts, and cleans scratch', (t) => {
  const f = fixture(t);
  const packageRoot = path.join(f.directory, 'package');
  const host = f.packages.get(`${HOST}@1.0.0`);
  writeJson(path.join(packageRoot, 'package.json'), { ...host.pkg, scripts: { postinstall: 'never-run-this' } });
  writeJson(path.join(packageRoot, 'compatibility/current.json'), host.profile);
  const archive = path.join(f.directory, 'host.tgz');
  const packed = spawnSync('tar', ['-czf', 'host.tgz', 'package'], { cwd: f.directory, encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  const integrity = `sha512-${createHash('sha512').update(fs.readFileSync(archive)).digest('base64')}`;
  const workspaces = [];
  let corrupt = false;
  let legacy = false;
  const options = {
    cwd: f.projectRoot,
    run(command, args, cwd) {
      if (command === 'npm') {
        assert.equal(cwd, f.projectRoot, 'npm must retain the calling project registry configuration');
        if (args[0] === 'view') return JSON.stringify({
          name: HOST, version: '1.0.0',
          dist: legacy ? { shasum: createHash('sha1').update(fs.readFileSync(archive)).digest('hex') } : { integrity },
        });
        assert.deepEqual(args.slice(0, 5), ['pack', `${HOST}@1.0.0`, '--ignore-scripts', '--json', '--pack-destination']);
        const destination = args[5];
        workspaces.push(destination);
        fs.copyFileSync(archive, path.join(destination, 'host.tgz'));
        if (corrupt) fs.appendFileSync(path.join(destination, 'host.tgz'), 'corrupt');
        return JSON.stringify([{ name: HOST, version: '1.0.0', integrity, filename: 'host.tgz' }]);
      }
      assert.equal(command, 'tar');
      const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    },
  };
  assert.equal(createSource(options).read(HOST, '1.0.0').profile.targetTemplateVersion, 1);
  assert.ok(workspaces.every((directory) => !fs.existsSync(directory)));
  legacy = true;
  assert.match(createSource(options).read(HOST, '1.0.0').publication.integrity, /^sha1-/);
  corrupt = true;
  assert.throws(() => createSource(options).read(HOST, '1.0.0'), /bytes do not match/);
  assert.ok(workspaces.every((directory) => !fs.existsSync(directory)));
});

test('selectors reject tags, prereleases, URLs and shell syntax before npm runs', () => {
  const source = createSource({ run() { assert.fail('npm must not run for invalid selectors'); } });
  for (const version of ['latest', '^1.0.0', '1.0.0-preview.1', 'https://example.com/package.tgz', '1.0.0;echo secret']) {
    assert.throws(() => source.read(HOST, version), /exact stable/);
  }
});

test('host acquisition is isolated, script-disabled, integrity-bound and cannot overwrite an app', (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(path.join(f.projectRoot, 'package.json'), 'utf8');
  const destination = path.join(f.directory, 'tooling');
  const options = {
    ...f.options,
    cwd: f.projectRoot,
    run(command, args, cwd, invocation) {
      assert.equal(command, 'npm');
      assert.equal(cwd, fs.realpathSync.native(f.projectRoot));
      assert.equal(invocation.env.npm_config_prefix, destination);
      assert.deepEqual(args, ['install', '--ignore-scripts', '--strict-peer-deps', '--no-legacy-peer-deps', '--no-force', '--no-audit', '--no-fund', '--prefix', destination]);
      const hostRoot = path.join(destination, 'node_modules', HOST);
      writeJson(path.join(hostRoot, 'package.json'), { name: HOST, version: '1.0.0', bin: { 'upgrade-template': 'scripts/upgrade.js' } });
      fs.mkdirSync(path.join(hostRoot, 'scripts'));
      fs.writeFileSync(path.join(hostRoot, 'scripts/upgrade.js'), '// fixture; never executed\n');
      writeJson(path.join(destination, 'package-lock.json'), { packages: {
        [`node_modules/${HOST}`]: { version: '1.0.0', integrity: f.packages.get(`${HOST}@1.0.0`).publication.integrity },
      } });
      return '';
    },
  };
  const result = acquireHost(destination, '1.0.0', options);
  assert.equal(result.lifecycleScriptsExecuted, false);
  assert.equal(result.upgradeCli, `node_modules/${HOST}/scripts/upgrade.js`);
  assert.equal(fs.readFileSync(path.join(f.projectRoot, 'package.json'), 'utf8'), before);
  assert.throws(() => acquireHost(f.projectRoot, '1.0.0', options), /existing apps are never overwritten/);
  assert.throws(() => acquireHost(destination, '1.0.0', options), /existing apps are never overwritten/);
});

test('older hosts do not accidentally select a newer template baseline', (t) => {
  const f = fixture(t);
  f.host('1.0.1');
  f.template('1.0.1', '1.0.1');
  assert.equal(selectPublishedContract('1.0.0', f.options).template.version, '1.0.0');
});
