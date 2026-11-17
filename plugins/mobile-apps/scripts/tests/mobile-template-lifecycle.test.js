'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const {
  acquireTemplate, assertEmptyDestination, assertTemplateManifest, checkSdk, inspectDestination, main,
  restorePreviewDependencies,
} = require('../mobile-template-lifecycle');
const { fixtureRelease, writeJson, writeProject, modifyJson, installPackage, addDependency } = require('./helpers/mobile-release-fixture');

const HOST = '@microsoft/power-apps-native-host';
const TEMPLATE = '@microsoft/power-apps-native-template';

function release(id = 'fixture-v1', templateVersion = 1, host = '1.0.0') {
  const entry = fixtureRelease(templateVersion);
  entry.id = id;
  entry.managedDependencies.dependencies[HOST] = host;
  entry.nativePackages[`node_modules/${HOST}`] = host;
  return entry;
}

function catalog(...releases) {
  return { schemaVersion: 1, defaultRelease: releases[0]?.id || null, releases };
}

function directory(t) {
  const root = path.join(__dirname, `.template-lifecycle-test-${randomUUID()}`);
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function manifest(entry) {
  return {
    schemaVersion: 1, templateVersion: entry.templateVersion,
    nativeRuntimeVersions: entry.nativeRuntimeVersions,
    templatePackage: { name: TEMPLATE, version: entry.template.version },
  };
}

function packageRunner(entry, overrides = {}) {
  const calls = [];
  const execute = (command, args, cwd, options) => {
    const installRoot = options?.env?.npm_config_prefix;
    calls.push({ command, args, cwd, installRoot });
    if (command === 'npm') {
      if (overrides.installError) throw new Error('Registry unavailable');
      assert.ok(installRoot, 'npm install must have an explicit isolated prefix');
      const packageRoot = path.join(installRoot, 'node_modules', TEMPLATE);
      writeJson(path.join(packageRoot, 'package.json'), {
        name: TEMPLATE, version: entry.template.version,
        bin: { 'create-power-app-native': overrides.bin || 'bin/create.js' },
        ...overrides.packageMetadata,
      });
      fs.mkdirSync(path.join(packageRoot, 'bin'));
      fs.writeFileSync(path.join(packageRoot, 'bin/create.js'), '// synthetic fixture CLI\n');
      writeJson(path.join(installRoot, 'package-lock.json'), { packages: {
        [`node_modules/${TEMPLATE}`]: {
          version: entry.template.version, integrity: overrides.integrity || entry.template.integrity,
        },
      } });
      if (overrides.extraPackage) {
        writeJson(path.join(installRoot, 'node_modules/unreviewed/package.json'), { name: 'unreviewed', version: '1.0.0' });
      }
      return '';
    }
    if (args[1] === '--manifest') {
      return overrides.manifestOutput ?? JSON.stringify(manifest(entry));
    }
    writeJson(path.join(args[1], 'app.json'), { expo: { extra: {
      powerappsNative: overrides.createdMetadata || {
        schemaVersion: 1, templateVersion: entry.templateVersion, nativeRuntimeVersions: entry.nativeRuntimeVersions,
      },
    } } });
    return 'Created synthetic fixture';
  };
  return { calls, run: execute };
}

function nativeSnapshotFixture(t) {
  const root = directory(t);
  writeProject(root, fixtureRelease());
  addDependency(root, 'ordinary-ui', '1.0.0', { properties: { peerDependencies: { react: '*' } } });
  const baseline = path.join(root, '.tmp/native-before.json');
  fs.mkdirSync(path.dirname(baseline));
  main(['snapshot-native', '--project-root', root, '--baseline', baseline]);
  const check = () => spawnSync(process.execPath, [
    path.join(__dirname, '../mobile-template-lifecycle.js'), 'check-native',
    '--project-root', root, '--baseline', baseline,
  ], { encoding: 'utf8' });
  return { root, baseline, check };
}

test('JS-only native comparison permits pure-JS updates and existing peers without matching a template lock', t => {
  const fixture = nativeSnapshotFixture(t);
  addDependency(fixture.root, 'ordinary-ui', '2.0.0', { properties: { peerDependencies: { react: '*' } } });
  assert.equal(fixture.check().status, 0);
  fs.unlinkSync(path.join(fixture.root, 'package-lock.json'));
  assert.equal(fixture.check().status, 0, 'A lockless JS workflow keeps the same installed native baseline');
  const snapshot = JSON.parse(fs.readFileSync(fixture.baseline, 'utf8'));
  assert.doesNotMatch(JSON.stringify(snapshot), /fixture-secret-do-not-echo/);
});

test('JS-only comparison rejects new native code in updated packages and their installed transitive closure', t => {
  for (const mode of ['direct-codegen', 'nested-bridge', 'nested-peer']) {
    const { root, check } = nativeSnapshotFixture(t);
    if (mode === 'direct-codegen') {
      addDependency(root, 'ordinary-ui', '2.0.0', { properties: { codegenConfig: {} } });
    } else {
      addDependency(root, 'ordinary-ui', '2.0.0', { properties: {
        [mode === 'nested-peer' ? 'peerDependencies' : 'dependencies']: { 'ordinary-bridge': '1.0.0' },
      } });
      addDependency(root, 'ordinary-bridge', '1.0.0', {
        section: null, installPath: 'node_modules/ordinary-ui/node_modules/ordinary-bridge',
      });
      fs.writeFileSync(path.join(root, 'node_modules/ordinary-ui/node_modules/ordinary-bridge/Bridge.swift'), 'import Foundation\n');
    }
    const result = check();
    assert.equal(result.status, 2, mode);
    assert.match(result.stderr, /BLOCKED: JavaScript-only update changed native\/runtime.*Restore the package snapshot/);
  }
});

test('JS-only comparison rejects changed native identity, placement, declarations and recorded requirements', t => {
  for (const change of [
    root => installPackage(root, 'node_modules/expo-haptics', '1.0.1'),
    root => modifyJson(path.join(root, 'node_modules/expo-haptics/package.json'), pkg => { pkg.codegenConfig = {}; }),
    root => {
      fs.mkdirSync(path.join(root, 'node_modules/ordinary-ui/node_modules'));
      fs.renameSync(path.join(root, 'node_modules/expo-haptics'), path.join(root, 'node_modules/ordinary-ui/node_modules/expo-haptics'));
    },
    root => modifyJson(path.join(root, 'package.json'), pkg => { pkg.dependencies['expo-haptics'] = '^1.0.0'; }),
    root => modifyJson(path.join(root, 'app.json'), app => { app.expo.extra.powerappsNative.nativeRuntimeVersions.ios = 2; }),
    root => fs.rmSync(path.join(root, 'node_modules/expo-haptics'), { recursive: true }),
  ]) {
    const { root, check } = nativeSnapshotFixture(t);
    change(root);
    const result = check();
    assert.equal(result.status, 2);
    assert.match(result.stderr, /BLOCKED:/);
    assert.doesNotMatch(result.stderr, /fixture-secret-do-not-echo/);
  }
});

test('native comparison fails closed on missing, malformed or wrong-app snapshots without rewriting them', t => {
  const fixture = nativeSnapshotFixture(t);
  const other = nativeSnapshotFixture(t);
  for (const data of ['not JSON', '{}', fs.readFileSync(other.baseline, 'utf8')]) {
    fs.writeFileSync(fixture.baseline, data);
    assert.equal(fixture.check().status, 2);
    assert.equal(fs.readFileSync(fixture.baseline, 'utf8'), data);
  }
  fs.unlinkSync(fixture.baseline);
  assert.equal(fixture.check().status, 2);
  assert.throws(() => main(['snapshot-native']), /Required/);
  assert.throws(() => main(['check-native', '--project-root', fixture.root]), /--baseline/);
});

test('native snapshots cannot be replaced after an update and accept only restored native state', t => {
  const { root, baseline, check } = nativeSnapshotFixture(t);
  const before = fs.readFileSync(baseline);
  installPackage(root, 'node_modules/expo-haptics', '1.0.1');
  assert.throws(() => main(['snapshot-native', '--project-root', root, '--baseline', baseline]), { code: 'EEXIST' });
  assert.deepEqual(fs.readFileSync(baseline), before);
  assert.equal(check().status, 2);
  installPackage(root, 'node_modules/expo-haptics', '1.0.0');
  assert.equal(check().status, 0);
  assert.deepEqual(fs.readFileSync(baseline), before);
  const outside = path.join(directory(t), 'native-before.json');
  assert.throws(() => main(['snapshot-native', '--project-root', root, '--baseline', outside]), /inside this app/);
  assert.equal(fs.existsSync(outside), false);
});

test('SDK validation binds the installed Expo CLI and cwd without changing the parent environment', t => {
  const root = directory(t);
  const expo = path.join(root, 'node_modules/expo');
  writeJson(path.join(expo, 'package.json'), { name: 'expo', version: '57.0.25', bin: { expo: 'bin/cli' } });
  fs.mkdirSync(path.join(expo, 'bin'));
  fs.writeFileSync(path.join(expo, 'bin/cli'), '// synthetic fixture CLI\n');
  const before = { ...process.env };
  const result = checkSdk(root, { run(command, args, cwd, invocation) {
    assert.equal(command, process.execPath);
    assert.deepEqual(args, [path.join(expo, 'bin/cli'), 'install', '--check']);
    assert.equal(cwd, fs.realpathSync.native(root));
    assert.deepEqual(invocation.env, { ...before, EXPO_OFFLINE: '1' });
    return 'Dependencies are up to date\n';
  } });
  assert.equal(result.expoVersion, '57.0.25');
  assert.equal(result.versionSource, 'installed-expo');
  assert.deepEqual({ ...process.env }, before);
  assert.throws(() => checkSdk(root, { run() { throw new Error('SDK mismatch'); } }), /SDK mismatch/);
  assert.deepEqual({ ...process.env }, before);
  assert.throws(() => main(['check-sdk']), /--project-root/);
});

test('SDK validation cannot download Expo or execute a CLI outside the installed package', t => {
  const root = directory(t);
  const options = { run() { assert.fail('Invalid installed SDK must fail before execution'); } };
  assert.throws(() => checkSdk(root, options), /ENOENT/);
  const expo = path.join(root, 'node_modules/expo');
  writeJson(path.join(expo, 'package.json'), { name: 'expo', bin: { expo: '../../outside.js' } });
  fs.writeFileSync(path.join(root, 'outside.js'), '// outside package\n');
  assert.throws(() => checkSdk(root, options), /contained in its package/);
});

test('preview dependency restore always targets the preview prefix, even when npm runs from the source context', t => {
  const root = directory(t);
  const source = path.join(root, 'source');
  const preview = path.join(root, 'preview');
  const files = {
    'package.json': { name: 'source-fixture', private: true, dependencies: {},
      scripts: { postinstall: 'node -e "process.exit(41)"' } },
    'package-lock.json': { lockfileVersion: 3, packages: { '': { dependencies: {} } } },
    'app.json': { expo: { extra: { powerappsNative: { templateVersion: 1 } } } },
  };
  for (const [file, value] of Object.entries(files)) {
    writeJson(path.join(source, file), value);
    writeJson(path.join(preview, file), value);
  }
  const config = '@microsoft:registry=https://packages.example.invalid/\n';
  fs.writeFileSync(path.join(source, '.npmrc'), config);
  fs.writeFileSync(path.join(preview, '.npmrc'), config);
  writeJson(path.join(source, 'node_modules/source-marker.json'), { preserve: true });
  let calls = 0;
  const result = restorePreviewDependencies(source, preview, {
    run(command, args, cwd, invocation) {
      calls++;
      assert.equal(command, 'npm');
      assert.equal(cwd, fs.realpathSync.native(source));
      assert.deepEqual(args, ['ci', '--ignore-scripts', '--no-legacy-peer-deps', '--no-force',
        '--no-audit', '--no-fund', '--prefix', fs.realpathSync.native(preview)]);
      assert.equal(invocation.env.npm_config_prefix, fs.realpathSync.native(preview));
      assert.equal(invocation.env.npm_config_global, 'false');
      assert.equal(invocation.env.npm_config_workspaces, 'false');
      assert.equal(fs.readFileSync(path.join(preview, '.npmrc'), 'utf8'), config);
      writeJson(path.join(preview, 'node_modules/restored.json'), { restored: true });
      return '';
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.sourceModified, false);
  assert.equal(fs.existsSync(path.join(source, 'node_modules/restored.json')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(source, 'node_modules/source-marker.json'))), { preserve: true });
  assert.equal(fs.readFileSync(path.join(preview, '.npmrc'), 'utf8'), config);
  for (const [file, value] of Object.entries(files)) {
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(source, file))), value);
  }
  assert.equal(restorePreviewDependencies(source, preview).installedDependencies, true);
  assert.equal(fs.existsSync(path.join(preview, 'node_modules/restored.json')), false,
    'Real npm ci must clean the disposable preview dependency tree');
  assert.equal(fs.existsSync(path.join(source, 'node_modules/source-marker.json')), true,
    'Real npm ci must leave the source dependency tree untouched');
  assert.throws(() => restorePreviewDependencies(source, source), /separate, non-nested/);
  assert.throws(() => restorePreviewDependencies(root, preview), /separate, non-nested/);
  writeJson(path.join(preview, 'app.json'), { changed: true });
  assert.throws(() => restorePreviewDependencies(source, preview, {
    run() { assert.fail('Changed previews must fail before npm'); },
  }), /differs from the source/);
});

test('preview restoration rejects source aliases and linked dependency directories before npm runs', t => {
  const root = directory(t);
  const source = path.join(root, 'source');
  const preview = path.join(root, 'preview');
  const alias = path.join(root, 'source-alias');
  fs.mkdirSync(source);
  fs.mkdirSync(preview);
  fs.symlinkSync(source, alias, 'junction');
  const options = { run() { assert.fail('Unsafe preview paths must fail before npm'); } };
  assert.throws(() => restorePreviewDependencies(source, alias, options), /separate, non-nested/);
  assert.throws(() => restorePreviewDependencies(preview, root, options), /separate, non-nested/);
  fs.symlinkSync(source, path.join(preview, 'node_modules'), 'junction');
  assert.throws(() => restorePreviewDependencies(source, preview, options), /must not be a symbolic link/);
});

test('preview dependency failures leave source files and dependency tree untouched', t => {
  const root = directory(t);
  const source = path.join(root, 'source');
  const preview = path.join(root, 'preview');
  for (const [file, value] of Object.entries({
    'package.json': { name: 'source-fixture', private: true },
    'package-lock.json': { lockfileVersion: 3, packages: { '': {} } },
    'app.json': { expo: {} },
  })) {
    writeJson(path.join(source, file), value);
    writeJson(path.join(preview, file), value);
  }
  writeJson(path.join(source, 'node_modules/source-marker.json'), { preserve: true });
  assert.throws(() => restorePreviewDependencies(source, preview, {
    run() { throw new Error('Synthetic preview registry failure'); },
  }), /Synthetic preview registry failure/);
  assert.equal(fs.existsSync(path.join(source, 'node_modules/source-marker.json')), true);
  assert.equal(fs.existsSync(path.join(source, '.npmrc')), false);
  assert.throws(() => main(['restore-preview', '--project-root', source]), /--preview-root/);
});

test('unknown release blocks acquisition before downloads or target writes', (t) => {
  const target = path.join(directory(t), 'app');
  let ran = false;
  assert.throws(() => acquireTemplate(target, 'unverified', {
    catalog: catalog(), run: () => { ran = true; },
  }), /release/i);
  assert.equal(ran, false);
  assert.equal(fs.existsSync(target), false);
});

test('creation rejects existing customer files without invoking npm', (t) => {
  const target = directory(t);
  fs.writeFileSync(path.join(target, 'customer.txt'), 'keep');
  assert.throws(() => assertEmptyDestination(target), /empty real directory/);
  const entry = release();
  const runner = packageRunner(entry);
  assert.throws(() => acquireTemplate(target, entry.id, { catalog: catalog(entry), ...runner }), /empty real directory/);
  assert.equal(runner.calls.length, 0);
  assert.equal(fs.readFileSync(path.join(target, 'customer.txt'), 'utf8'), 'keep');
});

test('creation-only destination inspection binds the existing parent without creating a new folder', t => {
  const root = directory(t);
  const target = path.join(root, 'new-parent', 'new app');
  const inspected = inspectDestination(target);
  assert.equal(inspected.parent, fs.realpathSync.native(root));
  assert.equal(inspected.destination, path.join(fs.realpathSync.native(root), 'new-parent', 'new app'));
  assert.equal(inspected.exists, false);
  assert.equal(fs.existsSync(path.join(root, 'new-parent')), false);
  assert.deepEqual(main(['destination', '--destination', target]), inspected);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'customer.txt'), 'preserve');
  assert.throws(() => inspectDestination(target), /empty real directory/);
  assert.equal(fs.readFileSync(path.join(target, 'customer.txt'), 'utf8'), 'preserve');
});

test('template acquisition rejects unexpected dependencies before any creation CLI execution', t => {
  const root = directory(t);
  const entry = release();
  for (const [index, overrides] of [
    { packageMetadata: { dependencies: { unreviewed: '1.0.0' } } },
    { packageMetadata: { optionalDependencies: { unreviewed: '1.0.0' } } },
    { packageMetadata: { peerDependencies: { unreviewed: '*' } } },
    { packageMetadata: { bundledDependencies: ['unreviewed'] } },
    { extraPackage: true },
  ].entries()) {
    const target = path.join(root, `case-${index}`);
    const runner = packageRunner(entry, overrides);
    assert.throws(() => acquireTemplate(target, entry.id, { catalog: catalog(entry), ...runner }),
      /self-contained|unexpected packages/);
    assert.equal(runner.calls.length, 1, 'No --manifest or scaffold command may execute');
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(runner.calls[0].installRoot), false);
  }
});

test('acquisition validates integrity before CLI execution and cleans its temporary install', (t) => {
  const target = path.join(directory(t), 'new app with spaces');
  const entry = release();
  const runner = packageRunner(entry);
  const result = acquireTemplate(target, entry.id, { catalog: catalog(entry), ...runner });
  assert.equal(result.installedDependencies, false);
  assert.equal(runner.calls.length, 3);
  assert.deepEqual(runner.calls[0].args, [
    'install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', `${TEMPLATE}@1.0.0`,
    '--prefix', runner.calls[0].installRoot,
  ]);
  assert.equal(runner.calls[1].args[1], '--manifest');
  assert.equal(runner.calls[2].args[1], target);
  assert.equal(fs.existsSync(runner.calls[0].installRoot), false);
  assert.equal(fs.existsSync(path.join(target, 'node_modules')), false);
});

test('published acquisition can target an empty current directory without staging inside it', (t) => {
  const target = path.join(directory(t), 'current-directory');
  fs.mkdirSync(target);
  const previous = process.cwd();
  const entry = release();
  const runner = packageRunner(entry);
  try {
    process.chdir(target);
    const result = acquireTemplate('.', entry.id, { catalog: catalog(entry), ...runner });
    assert.equal(result.installedDependencies, false);
    assert.equal(fs.existsSync(path.join(target, 'app.json')), true);
    const relative = path.relative(target, runner.calls[0].installRoot);
    assert.ok(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative));
    assert.equal(fs.existsSync(runner.calls[0].installRoot), false);
  } finally {
    process.chdir(previous);
  }
});

test('integrity, manifest, executable and registry failures never fall back to another template', (t) => {
  const root = directory(t);
  const entry = release();
  for (const [index, overrides] of [
    { integrity: 'sha512-wrong' }, { manifestOutput: '{}' }, { manifestOutput: 'not-json' },
    { bin: '../outside.js' }, { installError: true },
  ].entries()) {
    const target = path.join(root, `case-${index}`);
    const runner = packageRunner(entry, overrides);
    assert.throws(() => acquireTemplate(target, entry.id, { catalog: catalog(entry), ...runner }));
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(runner.calls[0].installRoot), false);
    assert.ok(runner.calls.length <= 2);
  }
  assert.throws(() => assertTemplateManifest({
    ...manifest(entry), nativeRuntimeVersions: { android: 99, ios: 1 },
  }, entry), /manifest does not match/);
});

test('post-copy mismatch is reported and partial target is preserved for review', (t) => {
  const target = path.join(directory(t), 'partial');
  const entry = release();
  const runner = packageRunner(entry, { createdMetadata: {} });
  assert.throws(() => acquireTemplate(target, entry.id, { catalog: catalog(entry), ...runner }), /manifest/);
  assert.equal(fs.existsSync(path.join(target, 'app.json')), true);
});

test('lifecycle CLI rejects unknown, duplicate and missing arguments', () => {
  for (const args of [
    [], ['apply'], ['acquire', '--release'], ['plan', '--project-root', '.', '--project-root', '.'],
    ['acquire', '--destination', '.', '--release', 'test', '--force', 'true'],
  ]) assert.throws(() => main(args), /Use acquire|argument|Required/);
});
