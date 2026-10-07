'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const test = require('node:test');
const {
  acquireTemplate, assertEmptyDestination, assertTemplateManifest, compareVersions, main, planUpdate,
} = require('../mobile-template-lifecycle');
const { fixtureRelease, writeProject: project, writeJson } = require('./helpers/mobile-release-fixture');

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
  const execute = (command, args, cwd) => {
    calls.push({ command, args, cwd });
    if (command === 'npm') {
      if (overrides.installError) throw new Error('Registry unavailable');
      const packageRoot = path.join(cwd, 'node_modules', TEMPLATE);
      writeJson(path.join(packageRoot, 'package.json'), {
        name: TEMPLATE, version: entry.template.version,
        bin: { 'create-power-app-native': overrides.bin || 'bin/create.js' },
      });
      fs.mkdirSync(path.join(packageRoot, 'bin'));
      fs.writeFileSync(path.join(packageRoot, 'bin/create.js'), '// synthetic fixture CLI\n');
      writeJson(path.join(cwd, 'package-lock.json'), { packages: {
        [`node_modules/${TEMPLATE}`]: {
          version: entry.template.version, integrity: overrides.integrity || entry.template.integrity,
        },
      } });
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

test('package version comparisons are numeric, inclusive and stable-only', () => {
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.0', '2.0.0'), -1);
  assert.equal(compareVersions('1.0.0+build.1', '1.0.0+build.2'), 0);
  for (const version of ['latest', '^1.0.0', '01.0.0', '1.0.0-beta.1']) {
    assert.throws(() => compareVersions(version, '1.0.0'), /exact stable/);
  }
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

test('acquisition validates integrity before CLI execution and cleans its temporary install', (t) => {
  const target = path.join(directory(t), 'new app with spaces');
  const entry = release();
  const runner = packageRunner(entry);
  const result = acquireTemplate(target, entry.id, { catalog: catalog(entry), ...runner });
  assert.equal(result.installedDependencies, false);
  assert.equal(runner.calls.length, 3);
  assert.deepEqual(runner.calls[0].args, [
    'install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', `${TEMPLATE}@1.0.0`,
  ]);
  assert.equal(runner.calls[1].args[1], '--manifest');
  assert.equal(runner.calls[2].args[1], target);
  assert.equal(fs.existsSync(runner.calls[0].cwd), false);
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
    const relative = path.relative(target, runner.calls[0].cwd);
    assert.ok(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative));
    assert.equal(fs.existsSync(runner.calls[0].cwd), false);
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
    assert.equal(fs.existsSync(runner.calls[0].cwd), false);
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

test('same supported target is current; no outdated-host gate prevents stale-template migration', (t) => {
  const root = directory(t);
  const source = release();
  const target = release('fixture-v2', 2, '2.0.0');
  project(root, source);
  assert.equal(planUpdate(root, source.id, catalog(source, target)).kind, 'current');
  writeJson(path.join(root, 'node_modules', HOST, 'package.json'), { name: HOST, version: '2.0.0' });
  const plan = planUpdate(root, target.id, catalog(source, target));
  assert.equal(plan.kind, 'template-upgrade');
  assert.equal(plan.hostInstallRequired, false);
  assert.equal(plan.fullChainPreviewRequired, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'app.json'))).expo.extra.powerappsNative.templateVersion, 1);
});

test('same-template host repair does not require template advancement', (t) => {
  const root = directory(t);
  const source = release();
  const target = release('fixture-host-repair', 1, '1.1.0');
  project(root, source);
  const plan = planUpdate(root, target.id, catalog(source, target));
  assert.equal(plan.kind, 'host-repair');
  assert.equal(plan.migrationRequired, false);
  assert.equal(plan.hostInstallRequired, true);
});

test('native transitions require a host and template major before approval', (t) => {
  const root = directory(t);
  const source = release();
  project(root, source);
  const sameHostMajor = release('fixture-bad-host-major', 2, '1.1.0');
  assert.throws(() => planUpdate(root, sameHostMajor.id, catalog(source, sameHostMajor)), /major release/);
  const sameTemplateMajor = release('fixture-bad-template-major', 2, '2.0.0');
  sameTemplateMajor.template.version = '1.1.0';
  assert.throws(() => planUpdate(root, sameTemplateMajor.id, catalog(source, sameTemplateMajor)), /major release/);
  assert.equal(planUpdate(root, 'fixture-v2', catalog(source, release('fixture-v2', 2, '2.0.0'))).kind, 'template-upgrade');
});

test('downgrades and runtime metadata changes without a template edge block', (t) => {
  const root = directory(t);
  const source = release('fixture-v2', 2, '2.0.0');
  const old = release();
  project(root, source);
  assert.throws(() => planUpdate(root, old.id, catalog(source, old)), /downgrade/);
  const bad = release('fixture-runtime-only', 2, '2.1.0');
  bad.nativeRuntimeVersions.android = 3;
  assert.throws(() => planUpdate(root, bad.id, catalog(source, bad)), /published template migration/);
});

test('forward template counters cannot hide source host or template package downgrades', (t) => {
  for (const downgraded of ['host', 'template']) {
    const root = directory(t);
    const source = release('fixture-source', 1, '2.0.0');
    source.template.version = '2.0.0';
    const target = structuredClone(source);
    target.id = 'fixture-target';
    target.templateVersion = 2;
    if (downgraded === 'host') {
      target.managedDependencies.dependencies[HOST] = '1.5.0';
      target.nativePackages[`node_modules/${HOST}`] = '1.5.0';
      target.template.version = '2.1.0';
    } else {
      target.template.version = '1.5.0';
    }
    project(root, source);
    writeJson(path.join(root, 'node_modules', HOST, 'package.json'), { name: HOST, version: '1.0.0' });
    assert.throws(() => planUpdate(root, target.id, catalog(source, target)), /downgrade/);
  }
});

test('changed native fingerprints require a template edge even with new package majors', (t) => {
  const root = directory(t);
  const source = release();
  const target = structuredClone(source);
  target.id = 'fixture-new-fingerprint';
  target.template.version = '2.0.0';
  target.managedDependencies.dependencies[HOST] = '2.0.0';
  target.nativePackages[`node_modules/${HOST}`] = '2.0.0';
  target.platforms.android.fingerprint = 'fixture-changed-native-inputs';
  project(root, source);
  assert.throws(() => planUpdate(root, target.id, catalog(source, target)), /fingerprint changes require a published template migration/);
});

test('lifecycle CLI rejects unknown, duplicate and missing arguments', () => {
  for (const args of [
    [], ['apply'], ['acquire', '--release'], ['plan', '--project-root', '.', '--project-root', '.'],
    ['acquire', '--destination', '.', '--release', 'test', '--force', 'true'],
  ]) assert.throws(() => main(args), /Use acquire|argument|Required/);
});
