'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  loadDiagnosticArtifacts, resolveDiagnosticProject, planDiagnosticUpdate, summary,
  assertOnlineOnly, parseAndroidPlayerMetadata, acquireDiagnosticTemplate,
} = require('../lib/mobile-diagnostic-artifacts');
const { readCatalog, selectRelease } = require('../lib/mobile-release');
const { writeJson, readJson, modifyJson, writeProject, fixtureRelease, addDependency, PLUGIN_ROOT } = require('./helpers/mobile-release-fixture');

const HOST = '@microsoft/power-apps-native-host';
const TEMPLATE = '@microsoft/power-apps-native-template';
const LOCAL = ['auth', 'common', 'assets', 'host'].map((name) => `@microsoft/power-apps-native-${name}`);
const hash = (file, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(fs.readFileSync(file)).digest(encoding);
const version = '1.0.0-diagnostic.1';
const privateVersion = '1.0.0-expo57-diagnostic.0';

function runtimeMetadata(metadata) {
  const result = { ...metadata };
  delete result.diagnostic;
  return result;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, COPYFILE_DISABLE: '1' } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function fixture(t, {
  inspectionOnly = false, privateTargets = false,
  hostVersion = privateTargets ? privateVersion : version,
  templatePackageVersion = privateTargets ? privateVersion : version, managedRange = false,
} = {}) {
  const root = path.join(__dirname, `.diagnostic-fixture-${randomUUID()}`);
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const reference = path.join(root, 'reference');
  const release = fixtureRelease(2);
  release.managedDependencies.dependencies[HOST] = hostVersion;
  release.nativePackages[`node_modules/${HOST}`] = hostVersion;
  release.managedDependencies.dependencies.expo = '57.0.0';
  release.nativePackages['node_modules/expo'] = '57.0.0';
  if (managedRange) release.managedDependencies.dependencies['expo-haptics'] = '^2.0.0';
  for (const name of LOCAL.filter((item) => item !== HOST)) {
    release.managedDependencies.dependencies[name] = '0.1.0';
    release.nativePackages[`node_modules/${name}`] = '0.1.0';
  }
  writeProject(reference, release);
  const profile = {
    schemaVersion: 1, targetTemplateVersion: 2, expoSdk: 57, expoVersion: '57.0.0',
    nativeRuntime: {
      android: { version: 2, fingerprint: 'a'.repeat(64) },
      ios: { version: 2, fingerprint: 'b'.repeat(64) },
    },
    managedDependencies: { ...release.managedDependencies.dependencies },
    managedDevDependencies: {}, managedOverrides: {}, migrations: ['template-v2'],
  };
  const native = readJson(path.join(reference, 'app.json')).expo.extra.powerappsNative;
  const metadata = {
    schemaVersion: 1, supportedNativeRuntimeVersions: { android: [2], ios: [2] },
    recommendedNativeRuntimeVersions: { android: 2, ios: 2 },
    recommendedTemplatePackage: { name: TEMPLATE, version: privateTargets ? '0.1.0' : templatePackageVersion, templateVersion: 2, nativeRuntimeVersions: native.nativeRuntimeVersions },
    diagnostic: { protocol: 'online-only-57-v1', nativeRuntime: profile.nativeRuntime },
  };
  const packed = [];
  for (const name of [...LOCAL, TEMPLATE]) {
    const packageRoot = path.join(root, 'sources', name.split('/')[1], 'package');
    const packageVersion = name === HOST ? hostVersion : name === TEMPLATE ? templatePackageVersion : '0.1.0';
    const pkg = { name, version: packageVersion };
    if ((inspectionOnly || privateTargets) && [HOST, TEMPLATE].includes(name)) {
      pkg.private = true;
      pkg.powerAppsDiagnostic = privateTargets ? {
        protocol: 'online-only-57-v1',
        purpose: name === HOST ? 'upgrade-target' : 'upgrade-inspection-only',
        sourceVersion: name === HOST ? '0.4.0' : '0.1.0',
      } : { protocol: 'online-only-57-v1', purpose: 'upgrade-inspection-only' };
    }
    if (name === HOST) {
      pkg.bin = { 'upgrade-template': 'bin/upgrade.js' };
      writeJson(path.join(packageRoot, 'compatibility/current.json'), profile);
      writeJson(path.join(packageRoot, 'compatibility/migrations/template-v2.json'), {
        schemaVersion: 1, id: 'template-v2', fromTemplateVersion: 1, toTemplateVersion: 2,
        packageTransitions: { dependencies: { [HOST]: privateTargets
          ? { from: '^0.3.3', to: '^1.0.0' } : { from: '^0.4.0', to: hostVersion } } },
      });
      fs.mkdirSync(path.join(packageRoot, 'bin'));
      fs.writeFileSync(path.join(packageRoot, 'bin/upgrade.js'),
        '// fixture only: never executes a migration\nif (process.argv.includes("--help")) console.log("--project --dry-run --no-install --diagnostic-artifacts");\n');
    }
    if (name === TEMPLATE) {
      pkg.bin = { 'create-power-app-native': 'bin/create.js' };
      writeJson(path.join(packageRoot, 'template/app.json'), { expo: { extra: { powerappsNative: native } } });
      writeJson(path.join(packageRoot, 'template/package.json'), {
        name: 'fixture-mobile-app', version: '1.0.0', dependencies: release.managedDependencies.dependencies,
      });
      fs.mkdirSync(path.join(packageRoot, 'bin'));
      fs.writeFileSync(path.join(packageRoot, 'bin/create.js'), `
const fs = require('node:fs');
const path = require('node:path');
const pkg = require('../package.json');
const root = path.resolve(__dirname, '../template');
if (process.argv[2] === '--manifest') {
  console.log(JSON.stringify({ ...require('../template/app.json').expo.extra.powerappsNative,
    templatePackage: { name: pkg.name, version: pkg.version } }));
} else { fs.cpSync(root, process.argv[2], { recursive: true, errorOnExist: true, force: false }); }
`);
    }
    writeJson(path.join(packageRoot, 'package.json'), pkg);
    const relative = `reference/.branch-packages/${name.split('/')[1]}-${packageVersion}.tgz`;
    const archive = path.join(root, relative);
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    run('tar', ['-czf', path.basename(archive), '-C', path.dirname(packageRoot), 'package'], path.dirname(archive));
    const item = { name, version: packageVersion, path: relative, sha256: hash(archive), integrity: `sha512-${hash(archive, 'sha512', 'base64')}` };
    packed.push(item);
    if (name !== TEMPLATE) {
      const spec = `file:.branch-packages/${path.basename(archive)}`;
      modifyJson(path.join(reference, 'package.json'), (app) => {
        app.dependencies[name] = spec;
        app.overrides = { ...app.overrides, [name]: `$${name}` };
      });
      modifyJson(path.join(reference, 'package-lock.json'), (lock) => {
        lock.packages[''].dependencies[name] = spec;
        lock.packages[`node_modules/${name}`] = { version: packageVersion, resolved: spec, integrity: item.integrity };
      });
      fs.cpSync(packageRoot, path.join(reference, 'node_modules', name), { recursive: true });
    }
  }
  const manifest = {
    schemaVersion: 1, kind: 'mobile-local-diagnostic', packages: packed,
    referenceProject: { path: 'reference', packageJsonSha256: hash(path.join(reference, 'package.json')), packageLockSha256: hash(path.join(reference, 'package-lock.json')) },
    player: { platform: 'android', path: 'player.apk', sha256: '', metadata },
  };
  fs.writeFileSync(path.join(root, 'player.apk'), 'Synthetic APK fixture; never production binary evidence');
  manifest.player.sha256 = hash(path.join(root, 'player.apk'));
  const files = Object.fromEntries(['package.json', 'package-lock.json', ...packed.filter((item) => item.name !== TEMPLATE)
    .map((item) => item.path.slice('reference/'.length))].map((file) => [file, hash(path.join(reference, file))]));
  writeJson(path.join(reference, '.branch-install.json'), { schemaVersion: 1, source: 'template', files });
  const file = path.join(root, 'diagnostic.json');
  writeJson(file, manifest);
  const base = JSON.stringify(runtimeMetadata(metadata));
  const output = `E: manifest\n  E: application\n    E: meta-data\n      A: android:name(0x01010003)="com.microsoft.powerapps.devlauncher.PLAYER_COMPATIBILITY"\n      A: android:value(0x01010024)="${base}" (Raw: "${base}")\n`;
  const assetOutput = JSON.stringify(metadata);
  const calls = [];
  const execute = (command, args, cwd) => {
    calls.push({ command, args, cwd });
    return command === 'aapt2' ? output : command === 'unzip' ? assetOutput : run(command, args, cwd);
  };
  return { root, reference, manifest, file, output, assetOutput, options: { run: execute }, calls };
}

function repack(f, name, change) {
  const item = f.manifest.packages.find((entry) => entry.name === name);
  const packageRoot = path.join(f.root, 'sources', name.split('/')[1], 'package');
  change(packageRoot);
  const archive = path.join(f.root, item.path);
  run('tar', ['-czf', path.basename(archive), '-C', path.dirname(packageRoot), 'package'], path.dirname(archive));
  item.sha256 = hash(archive);
  item.integrity = `sha512-${hash(archive, 'sha512', 'base64')}`;
  if (name !== TEMPLATE) {
    fs.cpSync(packageRoot, path.join(f.reference, 'node_modules', name), { recursive: true });
    modifyJson(path.join(f.reference, 'package-lock.json'), (lock) => {
      lock.packages[`node_modules/${name}`].integrity = item.integrity;
    });
    f.manifest.referenceProject.packageLockSha256 = hash(path.join(f.reference, 'package-lock.json'));
    modifyJson(path.join(f.reference, '.branch-install.json'), (state) => {
      state.files[item.path.slice('reference/'.length)] = item.sha256;
      state.files['package-lock.json'] = f.manifest.referenceProject.packageLockSha256;
    });
  }
  writeJson(f.file, f.manifest);
}

function bindToBundle(f, app) {
  for (const item of f.manifest.packages.filter((entry) => entry.name !== TEMPLATE)) {
    const archive = path.join(f.root, item.path);
    const spec = `file:${archive.split(path.sep).join('/')}`;
    modifyJson(path.join(app, 'package.json'), (pkg) => { pkg.dependencies[item.name] = spec; });
    modifyJson(path.join(app, 'package-lock.json'), (lock) => {
      lock.packages[''].dependencies[item.name] = spec;
      lock.packages[`node_modules/${item.name}`].resolved = `file:${path.relative(app, archive).split(path.sep).join('/')}`;
    });
  }
}

test('explicit immutable local selection verifies real package CLI and lock without publishing or installing', (t) => {
  const f = fixture(t);
  const result = summary(loadDiagnosticArtifacts(f.file, f.options));
  assert.equal(result.validationScope, 'local-diagnostic-only');
  assert.equal(result.deploymentAllowed, false);
  assert.equal(result.hostVersion, version);
  assert.equal(result.platformValidation.ios, 'not-validated');
  assert.equal(f.calls.some((call) => call.command === 'npm'), false);
  assert.ok(f.calls.some((call) => call.args[1] === '--manifest'));
  assert.ok(f.calls.some((call) => call.command === 'aapt2'));
  const tarCalls = f.calls.filter((call) => call.command === 'tar');
  assert.equal(tarCalls.length, f.manifest.packages.length * 3);
  for (const call of tarCalls) {
    assert.equal(call.args[1], path.basename(call.args[1]));
    assert.equal(path.isAbsolute(call.args[1]), false);
    assert.equal(call.args[1].includes(':'), false);
    assert.ok(f.manifest.packages.some((item) => path.join(f.root, item.path) === path.join(call.cwd, call.args[1])));
  }
  assert.doesNotMatch(JSON.stringify(result), new RegExp(f.root));
  assert.equal(readCatalog().defaultRelease, null);
  assert.throws(() => selectRelease(), /No verified/);
  assert.equal(fs.readdirSync(process.cwd()).some((name) => name.startsWith('.mobile-artifact-inspection-')), false);
});

test('known selected APK supported counters produce concrete mismatch guidance without touching old app', (t) => {
  const f = fixture(t);
  const old = path.join(f.root, 'older-fixture');
  const source = fixtureRelease(1);
  source.nativePackages[`node_modules/${HOST}`] = '0.4.0';
  source.managedDependencies.dependencies[HOST] = '^0.4.0';
  writeProject(old, source);
  const before = fs.readFileSync(path.join(old, 'app.json'));
  const result = planDiagnosticUpdate(old, f.file, f.options);
  assert.equal(result.kind, 'template-upgrade');
  assert.equal(result.playerCompatibility.required, 1);
  assert.deepEqual(result.playerCompatibility.supported, [2]);
  assert.equal(result.playerCompatibility.matchesSource, false);
  assert.match(result.playerCompatibility.guidance, /cannot load this app yet/);
  assert.deepEqual(fs.readFileSync(path.join(old, 'app.json')), before);
});

test('hash changes, SRI changes and source-only player evidence fail closed', (t) => {
  const f = fixture(t);
  for (const mutate of [
    (manifest) => { manifest.packages[0].sha256 = 'c'.repeat(64); },
    (manifest) => { manifest.packages[0].integrity = `sha512-${Buffer.alloc(64).toString('base64')}`; },
    (manifest) => { manifest.referenceProject.packageLockSha256 = 'c'.repeat(64); },
    (manifest) => { manifest.player.sha256 = 'c'.repeat(64); },
    (manifest) => { manifest.player.metadata.supportedNativeRuntimeVersions.android = [1, 2]; },
    (manifest) => { manifest.player.platform = 'ios'; },
    (manifest) => { manifest.packages[0].path = '../outside.tgz'; },
  ]) {
    const manifest = structuredClone(f.manifest);
    mutate(manifest);
    writeJson(f.file, manifest);
    assert.throws(() => loadDiagnosticArtifacts(f.file, f.options), /hash|integrity|metadata|APK|relative paths/i);
  }
});

test('reference lock/native metadata and installed package content remain exact', (t) => {
  const f = fixture(t);
  const host = path.join(f.reference, 'node_modules', HOST, 'bin/upgrade.js');
  fs.appendFileSync(host, '\n// changed after packing');
  assert.throws(() => loadDiagnosticArtifacts(f.file, f.options), /content differs/);
});

test('the copied uninstalled reference blocks with explicit preparation guidance and never installs', (t) => {
  const f = fixture(t);
  fs.renameSync(path.join(f.reference, 'node_modules'), path.join(f.root, 'parked-modules'));
  assert.throws(() => loadDiagnosticArtifacts(f.file, f.options), /separate approval.*npm ci.*never installs/);
  assert.equal(f.calls.length, 0);
  assert.equal(fs.existsSync(path.join(f.reference, 'node_modules')), false);
});

test('same-counter stale APK fingerprints, missing assets and authoritative manifest disagreements block', (t) => {
  const f = fixture(t);
  const changed = structuredClone(f.manifest.player.metadata);
  changed.diagnostic.nativeRuntime.android.fingerprint = 'c'.repeat(64);
  f.manifest.player.metadata = changed;
  writeJson(f.file, f.manifest);
  const options = { run: (command, args, cwd) => command === 'unzip' ? JSON.stringify(changed) : f.options.run(command, args, cwd) };
  assert.throws(() => loadDiagnosticArtifacts(f.file, options), /baked diagnostic fingerprints differ/);
  changed.diagnostic.nativeRuntime.android.fingerprint = 'a'.repeat(64);
  changed.supportedNativeRuntimeVersions.android = [1, 2];
  writeJson(f.file, f.manifest);
  assert.throws(() => loadDiagnosticArtifacts(f.file, options), /authoritative AndroidManifest.*disagree/);
  assert.throws(() => loadDiagnosticArtifacts(f.file, {
    run: (command, args, cwd) => command === 'unzip' ? '' : f.options.run(command, args, cwd),
  }), /asset is missing or malformed/);
});

test('producer absolute archive declarations and equivalent relative lock paths retain strict admission', (t) => {
  const f = fixture(t);
  const app = path.join(f.root, 'producer-upgraded-fixture');
  fs.cpSync(f.reference, app, { recursive: true });
  bindToBundle(f, app);
  const before = hash(path.join(app, 'package.json'));
  const selection = resolveDiagnosticProject(app, f.file, f.options);
  assert.match(selection.projectBaseline.managedDependencies.dependencies[HOST], /^file:/);
  assert.doesNotMatch(JSON.stringify(summary(selection)), new RegExp(f.root));
  assert.equal(hash(path.join(app, 'package.json')), before);
  assert.equal(planDiagnosticUpdate(app, f.file, f.options).kind, 'current');
  modifyJson(path.join(app, 'package-lock.json'), (lock) => {
    lock.packages[`node_modules/${HOST}`].resolved = 'file:wrong-archive.tgz';
  });
  assert.throws(() => resolveDiagnosticProject(app, f.file, f.options), /same regular local diagnostic archive/);
});

test('producer managed-range pinning admits only the exact verified reference resolution', (t) => {
  const f = fixture(t, { managedRange: true });
  const app = path.join(f.root, 'exact-graph-fixture');
  fs.cpSync(f.reference, app, { recursive: true });
  bindToBundle(f, app);
  for (const spec of ['2.0.0', '2.0.1', '^2.1.0']) {
    modifyJson(path.join(app, 'package.json'), (pkg) => { pkg.dependencies['expo-haptics'] = spec; });
    modifyJson(path.join(app, 'package-lock.json'), (lock) => { lock.packages[''].dependencies['expo-haptics'] = spec; });
    const before = hash(path.join(app, 'package.json'));
    if (spec === '2.0.0') {
      const selection = resolveDiagnosticProject(app, f.file, f.options);
      assert.equal(selection.projectBaseline.managedDependencies.dependencies['expo-haptics'], '2.0.0');
      assert.equal(summary(selection).managedDependencies.dependencies['expo-haptics'], '^2.0.0');
    } else {
      assert.throws(() => resolveDiagnosticProject(app, f.file, f.options), /Managed dependency expo-haptics/);
    }
    assert.equal(hash(path.join(app, 'package.json')), before);
  }
});

test('actual supported counters admit a diagnostic even when the APK recommends an older template', (t) => {
  const f = fixture(t);
  const metadata = f.manifest.player.metadata;
  metadata.supportedNativeRuntimeVersions = { android: [1, 2], ios: [1, 2] };
  metadata.recommendedNativeRuntimeVersions = { android: 1, ios: 1 };
  metadata.recommendedTemplatePackage = {
    name: TEMPLATE, version: '0.1.0', templateVersion: 1, nativeRuntimeVersions: { android: 1, ios: 1 },
  };
  writeJson(f.file, f.manifest);
  const bakedOutput = () => `E: meta-data\n A: android:name="com.microsoft.powerapps.devlauncher.PLAYER_COMPATIBILITY"\n A: android:value="${JSON.stringify(runtimeMetadata(metadata))}" (Raw: "${JSON.stringify(runtimeMetadata(metadata))}")\n`;
  const options = { run: (command, args, cwd) => command === 'aapt2' ? bakedOutput()
    : command === 'unzip' ? JSON.stringify(metadata) : f.options.run(command, args, cwd) };
  const result = summary(loadDiagnosticArtifacts(f.file, options));
  assert.equal(result.player.recommendedTemplatePackage.version, '0.1.0');
  assert.deepEqual(result.player.supportedNativeRuntimeVersions.android, [1, 2]);
  assert.equal(result.template.version, version);
  metadata.supportedNativeRuntimeVersions.android = [1];
  writeJson(f.file, f.manifest);
  assert.throws(() => loadDiagnosticArtifacts(f.file, options), /does not support the target Android runtime counter/);
});

test('packed template CLI and host metadata disagreement blocks even with refreshed archive hashes', (t) => {
  const f = fixture(t);
  repack(f, TEMPLATE, (root) => modifyJson(path.join(root, 'template/app.json'), (config) => {
    config.expo.extra.powerappsNative.templateVersion = 3;
  }));
  assert.throws(() => loadDiagnosticArtifacts(f.file, f.options), /disagree/);
});

test('diagnostic selection blocks an old host CLI rather than inventing a migration flag', (t) => {
  const f = fixture(t);
  repack(f, HOST, (root) => fs.writeFileSync(path.join(root, 'bin/upgrade.js'),
    'if (process.argv.includes("--help")) console.log("--project --dry-run --no-install");\n'));
  assert.throws(() => loadDiagnosticArtifacts(f.file, f.options), /does not expose the required diagnostic migration CLI/);
});

test('unsafe packed links are rejected before template code executes', { skip: process.platform === 'win32' && 'Requires symlink privileges' }, (t) => {
  const f = fixture(t);
  repack(f, TEMPLATE, (root) => fs.symlinkSync('../outside', path.join(root, 'link')));
  assert.throws(() => loadDiagnosticArtifacts(f.file, f.options), /unsafe archive paths/);
  assert.equal(f.calls.some((call) => call.args[1] === '--manifest'), false);
});

test('diagnostic prereleases do not waive the native-transition major rule', (t) => {
  const f = fixture(t);
  const old = path.join(f.root, 'older-fixture');
  const source = fixtureRelease(1);
  source.nativePackages[`node_modules/${HOST}`] = '1.0.0-diagnostic.0';
  source.managedDependencies.dependencies[HOST] = '1.0.0-diagnostic.0';
  writeProject(old, source);
  repack(f, HOST, (root) => modifyJson(path.join(root, 'compatibility/migrations/template-v2.json'), (edge) => {
    edge.packageTransitions.dependencies[HOST].from = '1.0.0-diagnostic.0';
  }));
  assert.throws(() => planDiagnosticUpdate(old, f.file, f.options), /new host and template package major/);
});

test('private source-version inspection artifacts are never relabeled as the required production major', (t) => {
  const f = fixture(t, { inspectionOnly: true, hostVersion: '0.4.0', templatePackageVersion: '0.1.0' });
  const app = path.join(f.root, 'older-fixture');
  const source = fixtureRelease(1);
  source.nativePackages[`node_modules/${HOST}`] = '0.4.0';
  source.managedDependencies.dependencies[HOST] = '^0.4.0';
  writeProject(app, source);
  const result = planDiagnosticUpdate(app, f.file, f.options);
  assert.equal(result.target.hostVersion, '0.4.0');
  assert.equal(result.target.template.version, '0.1.0');
  assert.equal(result.target.templatePurpose, 'upgrade-inspection-only');
  assert.equal(result.productionReleaseRequirement.minimumHostMajor, 1);
  assert.match(result.productionReleaseRequirement.status, /do-not-satisfy-production-release/);
  assert.equal(result.hostInstallRequired, true, 'Equal package versions do not prove equal archive contents');
  const destination = path.join(f.root, 'must-not-create');
  assert.throws(() => acquireDiagnosticTemplate(destination, f.file, f.options), /upgrade-inspection-only/);
  assert.equal(fs.existsSync(destination), false);
  assert.throws(() => selectRelease(), /No verified/);
});

test('source-version scope reuses exact host archives but requires a private inspection template and no stale lock', (t) => {
  const f = fixture(t, { inspectionOnly: true, hostVersion: '0.4.0', templatePackageVersion: '0.1.0' });
  repack(f, HOST, (root) => modifyJson(path.join(root, 'package.json'), (pkg) => {
    delete pkg.private;
    delete pkg.powerAppsDiagnostic;
  }));
  assert.equal(loadDiagnosticArtifacts(f.file, f.options).inspectionOnly, true);
  repack(f, TEMPLATE, (root) => modifyJson(path.join(root, 'package.json'), (pkg) => { delete pkg.private; }));
  assert.throws(() => loadDiagnosticArtifacts(f.file, f.options), /private diagnostic template/);
  repack(f, TEMPLATE, (root) => modifyJson(path.join(root, 'package.json'), (pkg) => { pkg.private = true; }));
  repack(f, TEMPLATE, (root) => writeJson(path.join(root, 'template/package-lock.json'), { lockfileVersion: 3 }));
  assert.throws(() => loadDiagnosticArtifacts(f.file, f.options), /no stale template lock/);
});

test('controlled private targets preserve real identities, provenance and the APK source recommendation', (t) => {
  const f = fixture(t, { privateTargets: true });
  const selection = loadDiagnosticArtifacts(f.file, f.options);
  const result = summary(selection);
  assert.equal(result.hostVersion, privateVersion);
  assert.equal(result.template.version, privateVersion);
  assert.equal(result.templatePurpose, 'upgrade-inspection-only');
  assert.equal(result.player.recommendedTemplatePackage.version, '0.1.0');
  assert.deepEqual(result.player.supportedNativeRuntimeVersions.android, [2]);
  assert.equal(result.deploymentAllowed, false);
  assert.equal(result.platformValidation.ios, 'not-validated');
  assert.equal(readJson(path.join(f.reference, 'node_modules', HOST, 'package.json')).powerAppsDiagnostic.sourceVersion, '0.4.0');
  assert.equal(f.calls.some((call) => call.command === 'npm'), false);
  const destination = path.join(f.root, 'must-not-scaffold');
  assert.throws(() => acquireDiagnosticTemplate(destination, f.file, f.options), /upgrade-inspection-only/);
  assert.equal(fs.existsSync(destination), false);
  assert.equal(readCatalog().defaultRelease, null);
});

test('controlled private planning uses migration source major even when the host is already updated', (t) => {
  const f = fixture(t, { privateTargets: true });
  for (const installedVersion of ['0.4.0', privateVersion]) {
    const app = path.join(f.root, `older-fixture-${installedVersion}`);
    const source = fixtureRelease(1);
    source.nativePackages[`node_modules/${HOST}`] = installedVersion;
    source.managedDependencies.dependencies[HOST] = installedVersion;
    writeProject(app, source);
    const before = hash(path.join(app, 'package.json'));
    const result = planDiagnosticUpdate(app, f.file, f.options);
    assert.equal(result.kind, 'template-upgrade');
    assert.equal(result.target.hostVersion, privateVersion);
    assert.equal(result.target.template.version, privateVersion);
    assert.equal(result.productionReleaseRequirement.minimumHostMajor, 1);
    assert.equal(result.productionReleaseRequirement.status, 'new-major-diagnostic-not-a-published-release');
    assert.equal(result.target.managedDependencies.dependencies[HOST],
      readJson(path.join(f.reference, 'package.json')).dependencies[HOST]);
    assert.equal(hash(path.join(app, 'package.json')), before);
  }
});

test('controlled private markers reject malformed provenance, mixed roles and missing privacy', (t) => {
  const f = fixture(t, { privateTargets: true });
  for (const name of [HOST, TEMPLATE]) {
    const sourceFile = path.join(f.root, 'sources', name.split('/')[1], 'package/package.json');
    const original = readJson(sourceFile);
    for (const change of [
      (pkg) => { delete pkg.private; },
      (pkg) => { delete pkg.powerAppsDiagnostic; },
      (pkg) => { delete pkg.powerAppsDiagnostic.sourceVersion; },
      (pkg) => { pkg.powerAppsDiagnostic.sourceVersion = '^0.4.0'; },
      (pkg) => { pkg.powerAppsDiagnostic.sourceVersion = '1.0.0'; },
      (pkg) => { pkg.powerAppsDiagnostic.protocol = 'unknown'; },
      (pkg) => { pkg.powerAppsDiagnostic.purpose = name === HOST ? 'upgrade-inspection-only' : 'upgrade-target'; },
    ]) {
      repack(f, name, (root) => {
        writeJson(path.join(root, 'package.json'), original);
        modifyJson(path.join(root, 'package.json'), change);
      });
      assert.throws(() => loadDiagnosticArtifacts(f.file, f.options), /consistent package versions\/roles\/sourceVersion provenance/);
      repack(f, name, (root) => writeJson(path.join(root, 'package.json'), original));
    }
  }
  for (const name of [HOST, TEMPLATE]) {
    repack(f, name, (root) => modifyJson(path.join(root, 'package.json'), (pkg) => {
      delete pkg.private;
      delete pkg.powerAppsDiagnostic;
    }));
  }
  assert.throws(() => loadDiagnosticArtifacts(f.file, f.options), /consistent package versions\/roles\/sourceVersion provenance/);
});

test('controlled private package identities and native-transition major remain strict', (t) => {
  for (const versions of [
    { hostVersion: '0.4.0' }, { templatePackageVersion: '0.1.0' },
    { hostVersion: '1.0.0-other.0' },
  ]) {
    const f = fixture(t, { privateTargets: true, ...versions });
    assert.throws(() => loadDiagnosticArtifacts(f.file, f.options), /consistent package versions\/roles\/sourceVersion provenance/);
  }
  const f = fixture(t, { privateTargets: true });
  const app = path.join(f.root, 'same-major-fixture');
  const source = fixtureRelease(1);
  source.nativePackages[`node_modules/${HOST}`] = privateVersion;
  source.managedDependencies.dependencies[HOST] = privateVersion;
  writeProject(app, source);
  repack(f, HOST, (root) => modifyJson(path.join(root, 'compatibility/migrations/template-v2.json'), (edge) => {
    edge.packageTransitions.dependencies[HOST].from = '^1.0.0';
  }));
  assert.throws(() => planDiagnosticUpdate(app, f.file, f.options), /new host and template package major/);
});

test('same-version local host repair requires matching lock and installed bytes before becoming current', (t) => {
  const f = fixture(t, { privateTargets: true });
  const app = path.join(f.root, 'target-fixture');
  fs.cpSync(f.reference, app, { recursive: true });
  assert.equal(planDiagnosticUpdate(app, f.file, f.options).kind, 'current');
  fs.appendFileSync(path.join(app, 'node_modules', HOST, 'bin/upgrade.js'), '\n// same version, different artifact');
  const plan = planDiagnosticUpdate(app, f.file, f.options);
  assert.equal(plan.kind, 'host-repair');
  assert.equal(plan.hostInstallRequired, true);
  assert.equal(plan.migrationRequired, false);
});

test('missing or skipped packed migration edges block source planning', (t) => {
  const f = fixture(t);
  const old = path.join(f.root, 'older-fixture');
  writeProject(old, fixtureRelease(1));
  repack(f, HOST, (root) => modifyJson(path.join(root, 'compatibility/migrations/template-v2.json'), (edge) => {
    edge.toTemplateVersion = 3;
  }));
  assert.throws(() => planDiagnosticUpdate(old, f.file, f.options), /adjacent/);
});

test('strict diagnostic app resolution detects same-version tampering and extra native packages', (t) => {
  const f = fixture(t);
  const app = path.join(f.root, 'target-app');
  fs.cpSync(f.reference, app, { recursive: true });
  assert.equal(resolveDiagnosticProject(app, f.file, f.options).target.templateVersion, 2);
  fs.writeFileSync(path.join(app, 'node_modules', HOST, 'extra.swift'), '// unrelated native injection');
  assert.throws(() => resolveDiagnosticProject(app, f.file, f.options), /unselected extra files/);
});

test('online-only diagnostics use the real offline contract and never convert customer configuration', (t) => {
  const f = fixture(t);
  const app = path.join(f.root, 'offline-app');
  fs.cpSync(f.reference, app, { recursive: true });
  modifyJson(path.join(app, 'app.json'), (config) => { config.expo.extra.__offlineProfile = { enabled: true }; });
  const before = fs.readFileSync(path.join(app, 'app.json'));
  assert.throws(() => assertOnlineOnly(app), /online-only.*Offline-enabled/);
  assert.deepEqual(fs.readFileSync(path.join(app, 'app.json')), before);
  modifyJson(path.join(app, 'app.json'), (config) => {
    delete config.expo.extra.__offlineProfile;
    config.expo.extra.appConfig = { customerData: true };
  });
  assertOnlineOnly(app);
  fs.writeFileSync(path.join(app, 'app.config.js'), 'throw Error("do not execute"); const __offlineProfile = {};');
  assert.throws(() => assertOnlineOnly(app), /Dynamic app configuration/);
  fs.unlinkSync(path.join(app, 'app.config.js'));
  writeJson(path.join(app, 'offline-profile.json'), {});
  assert.throws(() => assertOnlineOnly(app), /offline-compatible/);
  fs.unlinkSync(path.join(app, 'offline-profile.json'));
  fs.mkdirSync(path.join(app, 'src'));
  fs.writeFileSync(path.join(app, 'src/offline.ts'), "import '@microsoft/power-apps-native-offline';");
  assert.throws(() => assertOnlineOnly(app), /references the native offline package/);
});

test('optional baseline profile import and unused retired offline declaration are not active offline by themselves', (t) => {
  const f = fixture(t);
  const app = path.join(f.root, 'baseline-fixture');
  fs.cpSync(f.reference, app, { recursive: true });
  fs.mkdirSync(path.join(app, 'app'));
  fs.writeFileSync(path.join(app, 'app/_layout.tsx'), "const optionalProfile = () => import('../offline-profile.json');\n");
  const offline = '@microsoft/power-apps-native-offline';
  modifyJson(path.join(app, 'package.json'), (pkg) => { pkg.dependencies[offline] = '^0.1.32'; });
  assertOnlineOnly(app);
  modifyJson(path.join(app, 'package.json'), (pkg) => { pkg.dependencies[offline] = '^0.1.33'; });
  assert.throws(() => assertOnlineOnly(app), /Customized offline SDK declarations/);
  modifyJson(path.join(app, 'package.json'), (pkg) => {
    delete pkg.dependencies[offline];
    pkg.peerDependencies = { [offline]: '^0.1.32' };
  });
  assert.throws(() => assertOnlineOnly(app), /Customized offline SDK declarations/);
  modifyJson(path.join(app, 'package.json'), (pkg) => {
    delete pkg.peerDependencies;
    pkg.dependencies['offline-alias'] = `npm:${offline}@0.1.32`;
  });
  assert.throws(() => assertOnlineOnly(app), /aliases or overrides/);
});

test('quoted offline keys and computed assignments are rejected without evaluating configuration', (t) => {
  const f = fixture(t);
  const app = path.join(f.root, 'quoted-offline-fixture');
  fs.cpSync(f.reference, app, { recursive: true });
  const config = path.join(app, 'app.config.js');
  for (const source of [
    'module.exports = {expo: {extra: {"__offlineProfile": {enabled: true}}}};',
    "config.expo.extra['__offlineProfile'] = {enabled: true};",
    'config.expo.extra["__offlineProfile"] ??= {enabled: true};',
    'config.expo.extra.__offlineProfile ||= {enabled: true};',
  ]) {
    fs.writeFileSync(config, `throw Error("must not execute");\n${source}\n`);
    assert.throws(() => assertOnlineOnly(app), /Dynamic app configuration references native offline behavior/);
  }
  fs.unlinkSync(config);
  fs.mkdirSync(path.join(app, 'src'));
  fs.writeFileSync(path.join(app, 'src/config.ts'), 'export const extra = {["__offlineProfile"]: {enabled: true}};\n');
  assert.throws(() => assertOnlineOnly(app), /references the native offline package or profile/);
});

test('offline app rejection precedes artifact inspection and any target-directory creation', (t) => {
  const f = fixture(t);
  const app = path.join(f.root, 'offline-first-fixture');
  writeProject(app, fixtureRelease(1));
  writeJson(path.join(app, 'offline-profile.json'), { enabled: true });
  const entries = fs.readdirSync(app).sort();
  const missingManifest = path.join(f.root, 'must-not-be-inspected.json');
  for (const action of [planDiagnosticUpdate, resolveDiagnosticProject]) {
    assert.throws(() => action(app, missingManifest, f.options), /online-only/);
  }
  assert.equal(f.calls.length, 0);
  assert.deepEqual(fs.readdirSync(app).sort(), entries);
});

test('Android metadata parser uses the actual compatibility node and supports escaped JSON', (t) => {
  const f = fixture(t);
  const metadata = runtimeMetadata(f.manifest.player.metadata);
  assert.deepEqual(parseAndroidPlayerMetadata(f.output), metadata);
  const qualified = f.output.replaceAll('A: android:', 'A: http://schemas.android.com/apk/res/android:');
  assert.deepEqual(parseAndroidPlayerMetadata(qualified), metadata);
  assert.deepEqual(parseAndroidPlayerMetadata(f.output.replaceAll(JSON.stringify(metadata),
    JSON.stringify(JSON.stringify(metadata)).slice(1, -1))), metadata);
  assert.deepEqual(parseAndroidPlayerMetadata(qualified.replaceAll(JSON.stringify(metadata),
    JSON.stringify(JSON.stringify(metadata)).slice(1, -1))), metadata);
  assert.throws(() => parseAndroidPlayerMetadata('source profile only'), /baked player/);
  assert.throws(() => parseAndroidPlayerMetadata(`${f.output}\n${f.output}`), /unique/);
  assert.throws(() => parseAndroidPlayerMetadata(`${f.output}\n${qualified}`), /unique/);
  assert.throws(() => parseAndroidPlayerMetadata(qualified.replaceAll('/res/android:', '/res/other:')), /baked player/);
  assert.throws(() => parseAndroidPlayerMetadata(qualified.replace('PLAYER_COMPATIBILITY"', 'PLAYER_COMPATIBILITY.extra"')), /baked player/);
  assert.throws(() => parseAndroidPlayerMetadata(qualified + qualified.split('\n').find(line => line.includes(':value('))), /one literal/);
});

test('approved diagnostic acquisition uses the local template, reference lock and no npm target', (t) => {
  const f = fixture(t);
  const target = path.join(f.root, 'fresh');
  const result = acquireDiagnosticTemplate(target, f.file, f.options);
  assert.equal(result.installedDependencies, false);
  assert.equal(fs.existsSync(path.join(target, 'node_modules')), false);
  const manifest = readJson(path.join(target, 'package.json'));
  assert.match(manifest.dependencies[HOST], /^file:\.branch-packages/);
  assert.equal(hash(path.join(target, 'package-lock.json')), f.manifest.referenceProject.packageLockSha256);
  assert.throws(() => acquireDiagnosticTemplate(target, f.file, f.options), /empty/);
});

test('diagnostic acquisition can target an empty current directory without introducing scratch entries', (t) => {
  const f = fixture(t);
  const target = path.join(f.root, 'current-directory');
  fs.mkdirSync(target);
  const previous = process.cwd();
  try {
    process.chdir(target);
    assert.equal(acquireDiagnosticTemplate('.', f.file, f.options).installedDependencies, false);
    assert.equal(fs.existsSync(path.join(target, 'app.json')), true);
    assert.equal(fs.readdirSync(target).some((name) => name.startsWith('.mobile-artifact-')), false);
  } finally {
    process.chdir(previous);
  }
});

test('read-only diagnostic planning changes no customer source/config, lock, or protected counters', (t) => {
  const f = fixture(t);
  const app = path.join(f.root, 'old-app');
  const old = fixtureRelease(1);
  old.nativePackages[`node_modules/${HOST}`] = '0.4.0';
  old.managedDependencies.dependencies[HOST] = '^0.4.0';
  writeProject(app, old);
  fs.writeFileSync(path.join(app, 'AGENTS.md'), 'customer instructions\n');
  const files = ['app.json', 'package.json', 'package-lock.json', 'AGENTS.md'];
  const before = files.map((file) => hash(path.join(app, file)));
  const result = planDiagnosticUpdate(app, f.file, f.options);
  assert.equal(result.hostInstallRequired, true);
  assert.deepEqual(files.map((file) => hash(path.join(app, file))), before);
  assert.equal(fs.existsSync(path.join(app, '.branch-packages')), false);
  assert.equal(readJson(path.join(app, 'node_modules', HOST, 'package.json')).version, '0.4.0');
});

test('published/default and deployment options cannot mix with diagnostic artifacts', () => {
  assert.throws(() => require('../mobile-template-lifecycle').main([
    'stage-diagnostic', '--project-root', 'fixture', '--diagnostic-artifacts', 'fixture.json',
  ]), /producer host CLI owns diagnostic migration writes/);
  for (const args of [
    ['--default'], ['--diagnostic-artifacts', 'ignored', '--default'],
    ['--diagnostic-artifacts', 'ignored', '--release', 'fake'],
    ['--diagnostic-artifacts', 'ignored', '--platform', 'android', '--base-version', 'fake', '--base-fingerprint', 'fake'],
    ['--diagnostic-artifacts', 'ignored', '--requirements-only', '--project-root', '.'],
  ]) {
    const result = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'scripts/resolve-mobile-release.js'), ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /BLOCKED/);
    if (args.includes('--diagnostic-artifacts')) assert.match(result.stderr, /Diagnostic artifacts cannot select/);
  }
});

test('resolver and changed-file validator share the explicit diagnostic selection and JS approval gate',
  { skip: process.platform === 'win32' && 'POSIX executable shim; shared parser and inventory tests run on Windows' }, (t) => {
  const f = fixture(t);
  const tools = path.join(f.root, 'tools');
  fs.mkdirSync(tools);
  const aapt = path.join(tools, 'aapt2');
  fs.writeFileSync(aapt, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(f.output)});\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(tools, 'unzip'), `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(f.assetOutput)});\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${tools}${path.delimiter}${process.env.PATH}`, POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '1' };
  const resolve = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'scripts/resolve-mobile-release.js'),
    '--project-root', f.reference, '--diagnostic-artifacts', f.file], { encoding: 'utf8', cwd: f.root, env });
  assert.equal(resolve.status, 0, resolve.stderr);
  assert.equal(JSON.parse(resolve.stdout).deploymentAllowed, false);
  for (const args of [
    ['--diagnostic-artifacts', f.file, '--project-root', path.join(f.root, 'missing-project')],
    ['--project-root', path.join(f.root, 'missing-project'), '--diagnostic-artifacts', f.file],
  ]) {
    const result = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'scripts/resolve-mobile-release.js'), ...args],
      { encoding: 'utf8', cwd: f.root, env });
    assert.equal(result.status, 2, 'Project checks must run regardless of argument order');
    assert.match(result.stderr, /app configuration/);
    assert.equal(result.stdout, '');
  }
  for (const suffix of [
    ['--default'], ['--release', 'fixture'],
    ['--platform', 'android', '--base-version', 'fixture', '--base-fingerprint', 'fixture'],
    ['--unknown'], ['--diagnostic-artifacts', f.file], ['--project-root'],
  ]) {
    const result = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'scripts/resolve-mobile-release.js'),
      '--diagnostic-artifacts', f.file, ...suffix], { encoding: 'utf8', cwd: f.root, env });
    assert.equal(result.status, 2, 'Trailing arguments must be parsed before diagnostic dispatch');
    assert.match(result.stderr, /cannot select|Unknown or duplicate|missing its value/);
    assert.equal(result.stdout, '');
  }
  const validator = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'scripts/validate-mobile-files.js'),
    '--project-root', f.reference, '--file', 'package.json', '--diagnostic-artifacts', f.file], { encoding: 'utf8', cwd: f.root, env });
  assert.equal(validator.status, 0, validator.stdout + validator.stderr);
  const strict = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'scripts/validate-mobile-files.js'),
    '--project-root', f.reference, '--file', 'package.json'], { encoding: 'utf8', cwd: f.root, env });
  assert.equal(strict.status, 2);
  assert.match(strict.stderr, /No verified mobile releases/);
  const app = path.join(f.root, 'js-app');
  fs.cpSync(f.reference, app, { recursive: true });
  bindToBundle(f, app);
  addDependency(app, 'react-native-calendars', '1.1314.0');
  const args = [path.join(PLUGIN_ROOT, 'scripts/validate-mobile-files.js'),
    '--project-root', app, '--file', 'package.json', '--diagnostic-artifacts', f.file];
  const unapproved = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: f.root, env });
  assert.equal(unapproved.status, 2);
  assert.match(unapproved.stderr, /user-approved JavaScript Dependencies/);
  const approved = spawnSync(process.execPath, [...args, '--approved-js-dependency', 'react-native-calendars@1.1314.0'],
    { encoding: 'utf8', cwd: f.root, env });
  assert.equal(approved.status, 0, approved.stdout + approved.stderr);
});
