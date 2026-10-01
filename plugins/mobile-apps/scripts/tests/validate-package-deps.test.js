'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  HOST, fixtureRelease, createFixture, writeJson, modifyJson, installPackage,
  addDependency, runValidator,
} = require('./helpers/mobile-release-fixture');

function blocked(result, expression = /BLOCKED:/) {
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /^BLOCKED:/);
  assert.match(result.stderr, expression);
  assert.doesNotMatch(result.stderr, /fixture-secret-do-not-echo/);
}

test('allows the version-matched release and its shipped haptics, not a snapshot name allowlist', (t) => {
  const fixture = createFixture(t);
  const result = runValidator(fixture);
  assert.equal(result.status, 0, result.stderr);
});

test('blocks a new ambiguous dependency without exact plan approval', (t) => {
  const fixture = createFixture(t);
  addDependency(fixture.projectRoot, 'react-native-calendars', '1.1314.0');
  blocked(runValidator(fixture), /user-approved JavaScript Dependencies plan/);
});

test('allows the exact installed JS-only dependency approved in the plan', (t) => {
  const fixture = createFixture(t);
  addDependency(fixture.projectRoot, 'react-native-calendars', '1.1314.0');
  const result = runValidator(fixture, { approved: ['react-native-calendars@1.1314.0'] });
  assert.equal(result.status, 0, result.stderr);
});

test('blocks mismatched or non-exact JS approval', (t) => {
  const fixture = createFixture(t);
  addDependency(fixture.projectRoot, 'react-native-calendars', '1.1314.0');
  for (const approved of ['react-native-calendars@1.1300.0', 'react-native-calendars@^1.1314.0']) {
    blocked(runValidator(fixture, { approved: [approved] }), /user-approved JavaScript Dependencies plan/);
  }
});

test('does not let plan approval bypass known native or Microsoft native-family packages', (t) => {
  for (const name of ['expo-notifications', '@microsoft/power-apps-native-controls']) {
    const fixture = createFixture(t);
    addDependency(fixture.projectRoot, name, '1.0.0');
    blocked(runValidator(fixture, { approved: [`${name}@1.0.0`] }), /Native\/runtime dependency/);
  }
});

test('allows ordinary JS packages, including scoped dependencies', (t) => {
  const fixture = createFixture(t);
  addDependency(fixture.projectRoot, 'date-fns', '4.1.0');
  addDependency(fixture.projectRoot, '@scope/calendar-tools', '2.3.4');
  const result = runValidator(fixture);
  assert.equal(result.status, 0, result.stderr);
});

test('the dispatcher uses the isolated policy and preserves exact JS-approval parsing', (t) => {
  const fixture = createFixture(t);
  addDependency(fixture.projectRoot, 'react-native-calendars', '1.1314.0');
  const invoke = (approval) => spawnSync(process.execPath, [
    path.join(fixture.pluginRoot, 'scripts/validate-mobile-files.js'),
    '--project-root', fixture.projectRoot, '--file', 'package.json',
    '--approved-js-dependency', approval,
  ], { cwd: fixture.projectRoot, encoding: 'utf8', env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '1' } });
  const approved = invoke('react-native-calendars@1.1314.0');
  assert.equal(approved.status, 0, approved.stderr);
  const invalid = invoke('react-native-calendars@^1.1314.0');
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Invalid --approved-js-dependency/);
});

test('old apps are admitted by their release, not by a newer default release', (t) => {
  const old = fixtureRelease();
  const newest = fixtureRelease(2);
  newest.managedDependencies.dependencies['expo-notifications'] = '2.0.0';
  newest.nativePackages['node_modules/expo-notifications'] = '2.0.0';
  const fixture = createFixture(t, {
    release: old,
    catalog: { schemaVersion: 1, defaultRelease: newest.id, releases: [old, newest] },
  });
  assert.equal(runValidator(fixture).status, 0);
  addDependency(fixture.projectRoot, 'expo-notifications', '2.0.0');
  blocked(runValidator(fixture), /Native\/runtime dependency/);
});

test('unknown, missing or malformed policy fails closed without reading template dependencies', (t) => {
  for (const mode of ['empty', 'missing', 'malformed']) {
    const fixture = createFixture(t);
    const policy = path.join(fixture.pluginRoot, 'shared/mobile-releases.json');
    if (mode === 'empty') writeJson(policy, { schemaVersion: 1, defaultRelease: null, releases: [] });
    if (mode === 'missing') fs.rmSync(policy);
    if (mode === 'malformed') fs.writeFileSync(policy, '{"fixture-secret-do-not-echo":');
    blocked(runValidator(fixture), /verified mobile|mobile release policy/);
  }
});

test('does not exempt the bundled template path from release admission', (t) => {
  const fixture = createFixture(t);
  const template = path.join(fixture.pluginRoot, 'template');
  fs.cpSync(fixture.projectRoot, template, { recursive: true });
  fixture.projectRoot = template;
  addDependency(template, '@microsoft/power-apps-native-controls', '1.0.0');
  blocked(runValidator(fixture), /Native\/runtime dependency/);
});

test('rejects absent protected metadata and runtime versions changed to unknown values', (t) => {
  for (const edit of [
    (config) => { delete config.expo.extra.powerappsNative; },
    (config) => { config.expo.extra.powerappsNative.nativeRuntimeVersions.ios = 99; },
  ]) {
    const fixture = createFixture(t);
    modifyJson(path.join(fixture.projectRoot, 'app.json'), edit);
    blocked(runValidator(fixture), /metadata|runtime/);
  }
});

test('managed declarations must match the selected release even when the app lock was updated', (t) => {
  const fixture = createFixture(t);
  for (const file of ['package.json', 'package-lock.json']) {
    modifyJson(path.join(fixture.projectRoot, file), (data) => {
      const root = data.packages ? data.packages[''] : data;
      root.dependencies[HOST] = '^1.1.0';
    });
  }
  blocked(runValidator(fixture), /Managed dependency/);
});

test('a JS-only host remains runtime-sensitive and its installed version cannot drift', (t) => {
  const fixture = createFixture(t);
  modifyJson(path.join(fixture.projectRoot, 'node_modules', HOST, 'package.json'), (pkg) => { pkg.version = '1.0.1'; });
  modifyJson(path.join(fixture.projectRoot, 'package-lock.json'), (lock) => {
    lock.packages[`node_modules/${HOST}`].version = '1.0.1';
  });
  blocked(runValidator(fixture), /native inventory/);
});

test('nested native instances must match their exact reviewed path and version', (t) => {
  const release = fixtureRelease();
  const nested = 'node_modules/expo/node_modules/ordinary-bridge';
  release.nativePackages[nested] = '1.0.0';
  const fixture = createFixture(t, { release });
  assert.equal(runValidator(fixture).status, 0);
  installPackage(fixture.projectRoot, nested, '1.0.1', { codegenConfig: {} });
  modifyJson(path.join(fixture.projectRoot, 'package-lock.json'), (lock) => { lock.packages[nested].version = '1.0.1'; });
  blocked(runValidator(fixture), /nested package versions/);
});

for (const [label, relativeFile, properties] of [
  ['native source', 'source/bridge/Bridge.swift', {}],
  ['podspec', 'ordinary-widget.podspec', {}],
  ['codegen', null, { codegenConfig: {} }],
  ['Expo module', 'expo-module.config.json', {}],
  ['Expo config plugin', 'app.plugin.js', {}],
  ['platform project', 'android/build.gradle', {}],
]) {
  test(`detects an ordinary-name dependency through ${label}`, (t) => {
    const fixture = createFixture(t);
    addDependency(fixture.projectRoot, 'ordinary-widget', '1.0.0', { properties });
    if (relativeFile) {
      const target = path.join(fixture.projectRoot, 'node_modules/ordinary-widget', relativeFile);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, '');
    }
    blocked(runValidator(fixture, { approved: ['ordinary-widget@1.0.0'] }), /Native\/runtime dependency|Unreviewed native/);
  });
}

test('JS approval cannot hide native code in an ambiguous react-native package', (t) => {
  const fixture = createFixture(t);
  addDependency(fixture.projectRoot, 'react-native-calendars', '1.1314.0', { properties: { codegenConfig: {} } });
  blocked(runValidator(fixture, { approved: ['react-native-calendars@1.1314.0'] }), /Native\/runtime dependency/);
});

test('detects ordinary-name native modules in a JS dependency transitive closure', (t) => {
  const fixture = createFixture(t);
  addDependency(fixture.projectRoot, 'ordinary-ui', '1.0.0', { properties: { dependencies: { 'ordinary-bridge': '1.0.0' } } });
  addDependency(fixture.projectRoot, 'ordinary-bridge', '1.0.0', {
    section: null, installPath: 'node_modules/ordinary-ui/node_modules/ordinary-bridge', properties: { codegenConfig: {} },
  });
  blocked(runValidator(fixture), /Unreviewed native package/);
});

test('rejects malformed package, app, lock and installed JSON without leaking content', (t) => {
  for (const file of ['package.json', 'app.json', 'package-lock.json', `node_modules/${HOST}/package.json`]) {
    const fixture = createFixture(t);
    fs.writeFileSync(path.join(fixture.projectRoot, file), '{"fixture-secret-do-not-echo":');
    blocked(runValidator(fixture), /JSON|json|manifest/);
  }
});

test('preserves forbidden dependencies in every declaration section', (t) => {
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const fixture = createFixture(t);
    addDependency(fixture.projectRoot, 'axios', '1.0.0', { section });
    blocked(runValidator(fixture), /Forbidden dependency `axios`/);
  }
});

test('preserves vendor-only archive requirements without echoing registry credentials', (t) => {
  const fixture = createFixture(t);
  modifyJson(path.join(fixture.projectRoot, 'package.json'), (pkg) => {
    pkg.dependencies['expo-msal-intune'] = 'https://user:fixture-secret-do-not-echo@example.com/archive.tgz';
  });
  blocked(runValidator(fixture), /Vendor-only dependency/);
});

test('allows a reviewed vendor archive declaration, never an arbitrary file path', (t) => {
  const release = fixtureRelease();
  release.managedDependencies.dependencies['expo-msal-intune'] = 'file:./vendor/fixture-auth-1.0.0.tgz';
  release.nativePackages['node_modules/expo-msal-intune'] = '1.0.0';
  const fixture = createFixture(t, { release });
  assert.equal(runValidator(fixture).status, 0);
  modifyJson(path.join(fixture.projectRoot, 'package.json'), (pkg) => {
    pkg.dependencies['expo-msal-intune'] = 'file:../outside.tgz';
  });
  blocked(runValidator(fixture), /Vendor-only dependency/);
});

test('legacy edits preserve their reconstructed baseline without requiring release metadata', (t) => {
  const fixture = createFixture(t);
  fs.rmSync(path.join(fixture.projectRoot, 'app.json'));
  addDependency(fixture.projectRoot, 'date-fns', '4.1.0');
  const result = runValidator(fixture, { explicit: false, tool: 'Edit', input: { old_string: '"fixture-before"', new_string: '"fixture-mobile-app"' } });
  assert.equal(result.status, 0, result.stderr);
});

test('legacy edits block known native declaration drift even after npm rewrites the lock', (t) => {
  const fixture = createFixture(t);
  const result = runValidator(fixture, {
    explicit: false, tool: 'Edit', input: { old_string: `"${HOST}": "^0.9.0"`, new_string: `"${HOST}": "^1.0.0"` },
  });
  blocked(result, /Native\/runtime dependency/);
});

test('legacy edits block installed native drift against the lock', (t) => {
  const fixture = createFixture(t);
  modifyJson(path.join(fixture.projectRoot, 'node_modules/expo/package.json'), (pkg) => { pkg.version = '1.0.1'; });
  blocked(runValidator(fixture, { explicit: false }), /native dependency drift/);
});

test('legacy edits detect transitive native additions with an ordinary root package name', (t) => {
  const fixture = createFixture(t);
  addDependency(fixture.projectRoot, 'ordinary-ui', '1.0.0', { properties: { dependencies: { 'ordinary-bridge': '1.0.0' } } });
  addDependency(fixture.projectRoot, 'ordinary-bridge', '1.0.0', {
    section: null, installPath: 'node_modules/ordinary-ui/node_modules/ordinary-bridge', properties: { codegenConfig: {} },
  });
  const result = runValidator(fixture, {
    explicit: false, tool: 'Edit', input: { old_string: '', new_string: ',\n    "ordinary-ui": "1.0.0"' },
  });
  blocked(result, /Native\/runtime dependency/);
});

test('legacy fresh JS-only writes remain allowed without metadata or an installation', (t) => {
  const fixture = createFixture(t);
  fs.rmSync(path.join(fixture.projectRoot, 'node_modules'), { recursive: true });
  fs.rmSync(path.join(fixture.projectRoot, 'package-lock.json'));
  writeJson(path.join(fixture.projectRoot, 'package.json'), { dependencies: { 'date-fns': '4.1.0' } });
  assert.equal(runValidator(fixture, { explicit: false }).status, 0);
  writeJson(path.join(fixture.projectRoot, 'package.json'), { dependencies: { '@microsoft/power-apps-native-controls': '1.0.0' } });
  blocked(runValidator(fixture, { explicit: false }), /Native\/runtime dependency/);
});

test('legacy malformed package JSON also fails closed', (t) => {
  const fixture = createFixture(t);
  fs.writeFileSync(path.join(fixture.projectRoot, 'package.json'), '{');
  blocked(runValidator(fixture, { explicit: false }), /malformed package.json/);
});

function calendarFixture(t) {
  const release = fixtureRelease();
  for (const [name, version] of Object.entries({ react: '19.2.0', 'react-native': '0.83.6' })) {
    release.managedDependencies.dependencies[name] = version;
    release.nativePackages[`node_modules/${name}`] = version;
  }
  const fixture = createFixture(t, { release });
  const before = fs.readFileSync(path.join(fixture.projectRoot, 'package.json'), 'utf8');
  addDependency(fixture.projectRoot, 'react-native-calendars', '1.1314.0', {
    properties: { peerDependencies: { react: '>=16.3.0', 'react-native': '>=0.60.0' } },
  });
  return { fixture, before };
}

function validateCalendarEdit(fixture, before, tool = 'Edit') {
  const after = fs.readFileSync(path.join(fixture.projectRoot, 'package.json'), 'utf8');
  const edit = { old_string: before, new_string: after };
  return runValidator(fixture, {
    explicit: false, tool, approved: ['react-native-calendars@1.1314.0'],
    input: tool === 'MultiEdit' ? { edits: [edit] } : edit,
  });
}

test('legacy Edit and MultiEdit admit approved JS UI libraries using existing unchanged React/RN peers', (t) => {
  for (const tool of ['Edit', 'MultiEdit']) {
    const { fixture, before } = calendarFixture(t);
    const result = validateCalendarEdit(fixture, before, tool);
    assert.equal(result.status, 0, result.stderr);
    const unapproved = runValidator(fixture, {
      explicit: false, tool: 'Edit',
      input: { old_string: before, new_string: fs.readFileSync(path.join(fixture.projectRoot, 'package.json'), 'utf8') },
    });
    blocked(unapproved, /user-approved JavaScript Dependencies plan/);
  }
});

test('legacy JS peer reuse does not excuse changed root runtime declarations or installed native versions', (t) => {
  for (const updateLock of [false, true]) {
    const { fixture, before } = calendarFixture(t);
    modifyJson(path.join(fixture.projectRoot, 'node_modules/react-native/package.json'), (pkg) => { pkg.version = '0.83.7'; });
    if (updateLock) {
      for (const file of ['package.json', 'package-lock.json']) modifyJson(path.join(fixture.projectRoot, file), (value) => {
        (value.packages?.[''] || value).dependencies['react-native'] = '0.83.7';
        if (value.packages) value.packages['node_modules/react-native'].version = '0.83.7';
      });
    }
    blocked(validateCalendarEdit(fixture, before, 'MultiEdit'), /native dependency drift|Native\/runtime dependency/);
  }
});

test('updating the app lock cannot hide installed runtime drift against an unchanged exact before-pin', (t) => {
  const { fixture, before } = calendarFixture(t);
  modifyJson(path.join(fixture.projectRoot, 'node_modules/react-native/package.json'), (pkg) => { pkg.version = '0.83.7'; });
  modifyJson(path.join(fixture.projectRoot, 'package-lock.json'), (lock) => { lock.packages['node_modules/react-native'].version = '0.83.7'; });
  blocked(validateCalendarEdit(fixture, before), /native dependency drift/);
});

test('approved JS UI may consume a JS transitive helper that reuses unchanged React/RN peers', (t) => {
  const { fixture, before } = calendarFixture(t);
  addDependency(fixture.projectRoot, 'react-native-swipe-gestures', '1.0.5', {
    section: null, properties: { peerDependencies: { react: '*', 'react-native': '*' } },
  });
  modifyJson(path.join(fixture.projectRoot, 'node_modules/react-native-calendars/package.json'), (pkg) => {
    pkg.dependencies = { 'react-native-swipe-gestures': '^1.0.5' };
  });
  const result = validateCalendarEdit(fixture, before, 'MultiEdit');
  assert.equal(result.status, 0, result.stderr);
});

test('legacy JS peer reuse never admits native source, new native children or nested runtime peers', (t) => {
  for (const mutate of [
    (fixture) => modifyJson(path.join(fixture.projectRoot, 'node_modules/react-native-calendars/package.json'), (pkg) => { pkg.codegenConfig = {}; }),
    (fixture) => {
      addDependency(fixture.projectRoot, 'react-native', '0.82.0', {
        section: null, installPath: 'node_modules/react-native-calendars/node_modules/react-native',
      });
    },
    (fixture) => {
      const dependencies = { 'ordinary-native-child': '1.0.0' };
      modifyJson(path.join(fixture.projectRoot, 'node_modules/react-native-calendars/package.json'), (pkg) => { pkg.dependencies = dependencies; });
      addDependency(fixture.projectRoot, 'ordinary-native-child', '1.0.0', {
        section: null, properties: { codegenConfig: {} },
      });
    },
  ]) {
    const { fixture, before } = calendarFixture(t);
    mutate(fixture);
    blocked(validateCalendarEdit(fixture, before), /Native\/runtime dependency/);
  }
});

test('a newly introduced root native peer cannot be treated as an existing runtime', (t) => {
  const { fixture, before } = calendarFixture(t);
  addDependency(fixture.projectRoot, 'react-native-screens', '4.23.0');
  modifyJson(path.join(fixture.projectRoot, 'node_modules/react-native-calendars/package.json'), (pkg) => {
    pkg.peerDependencies['react-native-screens'] = '>=4.0.0';
  });
  blocked(validateCalendarEdit(fixture, before), /Native\/runtime dependency/);
});

test('React as a hard native/runtime dependency does not borrow the unchanged-peer exception', (t) => {
  const { fixture, before } = calendarFixture(t);
  modifyJson(path.join(fixture.projectRoot, 'node_modules/react-native-calendars/package.json'), (pkg) => {
    pkg.dependencies = { react: '19.2.0' };
  });
  blocked(validateCalendarEdit(fixture, before), /Native\/runtime dependency/);
});

test('JS alias support does not bypass forbidden-library and vendor-only rules', (t) => {
  for (const canonical of ['axios', 'lucide-react', 'expo-msal-intune']) {
    const fixture = createFixture(t);
    addDependency(fixture.projectRoot, 'friendly-alias', '1.0.0', { properties: { name: canonical } });
    for (const file of ['package.json', 'package-lock.json']) modifyJson(path.join(fixture.projectRoot, file), (value) => {
      (value.packages?.[''] || value).dependencies['friendly-alias'] = `npm:${canonical}@1.0.0`;
      if (value.packages) value.packages['node_modules/friendly-alias'].name = canonical;
    });
    blocked(runValidator(fixture), /Forbidden dependency|Vendor-only dependency/);
    blocked(runValidator(fixture, { explicit: false }), /Forbidden dependency|Vendor-only dependency/);
  }
});
