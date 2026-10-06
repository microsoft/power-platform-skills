'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  readCatalog, selectRelease, resolveProjectRelease, validateRelease, summarizeRelease,
  readProjectRequirements, selectProjectRelease, readPlatformContext,
} = require('../lib/mobile-release');
const {
  HOST, fixtureRelease, makeRelease, writeProject, createFixture, writeJson, modifyJson, installPackage, addDependency, runCli, runValidator,
} = require('./helpers/mobile-release-fixture');

function blocked(result, message) {
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^BLOCKED:/);
  if (message) assert.match(result.stderr, message);
  assert.doesNotMatch(result.stderr, /fixture-secret-do-not-echo/);
}

test('bundled policy starts empty and has no speculative default or release', () => {
  assert.deepEqual(readCatalog(), { schemaVersion: 1, defaultRelease: null, releases: [] });
  assert.throws(() => selectRelease(), /No verified mobile release.*maintainer/);
});

test('reusable fixtures deep-merge overrides and write a strictly resolvable synthetic project', (t) => {
  const fixture = createFixture(t);
  const overrides = {
    id: 'fixture-reusable-project',
    templateVersion: 4,
    nativeRuntimeVersions: { android: 4 },
    managedDependencies: { devDependencies: { typescript: '5.0.0' } },
    nativePackages: { 'node_modules/expo/node_modules/ordinary-bridge': '1.0.0' },
  };
  const originalOverrides = structuredClone(overrides);
  const release = makeRelease(overrides);
  assert.equal(release.nativeRuntimeVersions.ios, 1);
  assert.equal(release.nativePackages[`node_modules/${HOST}`], '1.0.0');
  assert.deepEqual(overrides, originalOverrides);
  assert.equal(validateRelease(release), release);
  const root = path.join(fixture.directory, 'standalone-project');
  assert.equal(writeProject(root, release), root);
  const catalog = { schemaVersion: 1, defaultRelease: release.id, releases: [release] };
  assert.equal(resolveProjectRelease(root, catalog), release);
  release.managedDependencies.devDependencies.typescript = '6.0.0';
  assert.equal(overrides.managedDependencies.devDependencies.typescript, '5.0.0');
  assert.equal(makeRelease().id, 'fixture-release-1');
});

test('selection returns the exact reviewed record, explicitly or through its default', () => {
  const release = fixtureRelease();
  const catalog = { schemaVersion: 1, defaultRelease: release.id, releases: [release] };
  assert.equal(validateRelease(release), release);
  assert.equal(selectRelease(release.id, catalog), release);
  assert.equal(selectRelease(undefined, catalog), release);
  assert.throws(() => selectRelease('unreviewed', catalog), /No verified mobile release/);
  assert.throws(() => selectRelease('fixture-secret-do-not-echo/invalid', catalog), /valid reviewed release id/);
  assert.throws(() => selectRelease(undefined, { ...catalog, defaultRelease: null }), /No verified mobile release/);
});

test('catalog schema, defaults and duplicate identities are strict', () => {
  const release = fixtureRelease();
  for (const catalog of [
    { schemaVersion: 2, defaultRelease: release.id, releases: [release] },
    { schemaVersion: 1, defaultRelease: 'unreviewed', releases: [release] },
    { schemaVersion: 1, defaultRelease: release.id, releases: [release, release] },
    { schemaVersion: 1, defaultRelease: release.id, releases: [release], latest: release.id },
  ]) assert.throws(() => selectRelease(undefined, catalog));
});

for (const [label, mutate] of [
  ['unknown record field', (r) => { r.verified = true; }],
  ['unsafe id', (r) => { r.id = '../release'; }],
  ['wrong template package', (r) => { r.template.package = 'unreviewed-template'; }],
  ['template prerelease', (r) => { r.template.version = '1.0.0-preview.1'; }],
  ['template range', (r) => { r.template.version = '^1.0.0'; }],
  ['leading-zero semver', (r) => { r.template.version = '01.0.0'; }],
  ['missing integrity', (r) => { delete r.template.integrity; }],
  ['invalid integrity', (r) => { r.template.integrity = 'sha512-short'; }],
  ['invalid templateVersion', (r) => { r.templateVersion = 0; }],
  ['missing platform runtime', (r) => { delete r.nativeRuntimeVersions.ios; }],
  ['string platform runtime', (r) => { r.nativeRuntimeVersions.android = '1'; }],
  ['missing host declaration', (r) => { delete r.managedDependencies.dependencies[HOST]; }],
  ['missing react declaration', (r) => { delete r.managedDependencies.dependencies.react; }],
  ['duplicate managed name', (r) => { r.managedDependencies.devDependencies = { react: '1.0.0' }; }],
  ['unknown managed section', (r) => { r.managedDependencies.other = {}; }],
  ['managed URL dependency', (r) => { r.managedDependencies.dependencies[HOST] = 'https://example.com/archive.tgz'; }],
  ['malformed managed range', (r) => { r.managedDependencies.dependencies[HOST] = '^1.0.0-...'; }],
  ['vendor traversal', (r) => { r.managedDependencies.dependencies[HOST] = 'file:./vendor/../host.tgz'; }],
  ['missing host inventory', (r) => { delete r.nativePackages[`node_modules/${HOST}`]; }],
  ['missing expo inventory', (r) => { delete r.nativePackages['node_modules/expo']; }],
  ['native version range', (r) => { r.nativePackages['node_modules/react'] = '^1.0.0'; }],
  ['native prerelease leading zero', (r) => { r.nativePackages['node_modules/react'] = '1.0.0-01'; }],
  ['path traversal', (r) => { r.nativePackages['node_modules/../outside'] = '1.0.0'; }],
  ['absolute package path', (r) => { r.nativePackages['/node_modules/outside'] = '1.0.0'; }],
  ['backslash path', (r) => { r.nativePackages['node_modules\\outside'] = '1.0.0'; }],
  ['invalid node_modules name', (r) => { r.nativePackages['node_modules/node_modules'] = '1.0.0'; }],
  ['missing iOS evidence', (r) => { delete r.platforms.ios; }],
  ['empty fingerprint', (r) => { r.platforms.android.fingerprint = ''; }],
  ['empty player version', (r) => { r.platforms.ios.player.version = ''; }],
  ['no verification references', (r) => { r.evidence = []; }],
]) {
  test(`rejects ${label} in reviewed policy`, () => {
    const release = fixtureRelease();
    mutate(release);
    assert.throws(() => validateRelease(release), (error) => error.code === 'MOBILE_RELEASE_BLOCKED');
  });
}

for (const evidence of [
  'http://example.com/release',
  'https:example.com/release',
  'https://user:fixture-secret-do-not-echo@example.com/release',
  'https://example.com/release?token=fixture-secret-do-not-echo',
  'https://example.com/release#fixture-secret-do-not-echo',
  'https://localhost/release',
  'https://127.0.0.1/release',
  'https://[::1]/release',
  'https://review.internal/release',
  'https://example.ghe.com/release',
  'https://example.com:8443/release',
]) {
  test('rejects non-public or credential-bearing evidence without echoing it', () => {
    const release = fixtureRelease();
    release.evidence = [evidence];
    assert.throws(() => validateRelease(release), (error) => {
      assert.doesNotMatch(error.message, /fixture-secret-do-not-echo/);
      return error.code === 'MOBILE_RELEASE_BLOCKED';
    });
    release.evidence = ['https://example.com/fixture/verification'];
    release.platforms.android.base.evidence = evidence;
    assert.throws(() => validateRelease(release));
  });
}

test('supports all managed sections and nested scoped native inventory', () => {
  const release = fixtureRelease();
  release.managedDependencies.devDependencies = { typescript: '~5.0.0' };
  release.managedDependencies.optionalDependencies = { 'optional-fixture': '>=1.0.0 <2.0.0' };
  release.managedDependencies.peerDependencies = { 'peer-fixture': '^1.0.0 || ^2.0.0' };
  release.nativePackages['node_modules/expo/node_modules/@scope/native-fixture'] = '1.0.0-preview.1';
  assert.equal(validateRelease(release), release);
});

test('summary includes reviewed capability inventory and safe specs without project config', () => {
  const release = fixtureRelease();
  release.managedDependencies.devDependencies = { typescript: '~5.0.0' };
  release.managedDependencies.optionalDependencies = { 'fixture-archive': 'file:./vendor/fixture-archive-1.0.0.tgz' };
  const summary = summarizeRelease(release);
  assert.deepEqual(Object.keys(summary), ['id', 'template', 'templateVersion', 'nativeRuntimeVersions', 'hostVersion', 'managedDependencies', 'nativePackages', 'platforms', 'evidence']);
  assert.equal(summary.hostVersion, release.nativePackages[`node_modules/${HOST}`]);
  assert.deepEqual(summary.nativePackages, release.nativePackages);
  assert.deepEqual(summary.managedDependencies, release.managedDependencies);
  assert.doesNotMatch(JSON.stringify(summary), /connectionString|appInsightsConfig|projectRoot|resolved/);
  summary.platforms.android.base.version = 'changed';
  assert.notEqual(release.platforms.android.base.version, 'changed');
  summary.nativePackages[`node_modules/${HOST}`] = '99.0.0';
  summary.managedDependencies.dependencies[HOST] = '^99.0.0';
  summary.managedDependencies.devDependencies.typescript = '99.0.0';
  assert.equal(release.nativePackages[`node_modules/${HOST}`], '1.0.0');
  assert.equal(release.managedDependencies.dependencies[HOST], '^1.0.0');
  assert.equal(release.managedDependencies.devDependencies.typescript, '~5.0.0');
});

test('summary rejects credentials and unsafe paths rather than publishing dependency specs', (t) => {
  for (const mutate of [
    (release) => { release.managedDependencies.dependencies[HOST] = 'https://user:fixture-secret-do-not-echo@example.com/archive.tgz'; },
    (release) => { release.managedDependencies.dependencies[HOST] = 'file:../fixture-secret-do-not-echo/archive.tgz'; },
    (release) => { release.nativePackages['node_modules/../fixture-secret-do-not-echo'] = '1.0.0'; },
  ]) {
    const release = fixtureRelease();
    const fixture = createFixture(t, { release });
    mutate(release);
    assert.throws(() => summarizeRelease(release), (error) => {
      assert.doesNotMatch(error.message, /fixture-secret-do-not-echo/);
      return error.code === 'MOBILE_RELEASE_BLOCKED';
    });
    writeJson(path.join(fixture.pluginRoot, 'shared/mobile-releases.json'), {
      schemaVersion: 1, defaultRelease: release.id, releases: [release],
    });
    blocked(runCli(fixture, ['--default']));
  }
});

test('project resolution returns its exact record, including an older release than the default', (t) => {
  const old = fixtureRelease();
  const newest = fixtureRelease(2);
  const catalog = { schemaVersion: 1, defaultRelease: newest.id, releases: [old, newest] };
  const fixture = createFixture(t, { release: old, catalog });
  assert.equal(resolveProjectRelease(fixture.projectRoot, catalog), old);
  const result = runCli(fixture, ['--project-root', fixture.projectRoot]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).id, old.id);
  assert.doesNotMatch(result.stdout, /fixture-secret-do-not-echo|appInsightsConfig/);
  assert.ok(!result.stdout.includes(fixture.projectRoot));
  assert.equal(JSON.parse(result.stdout).nativePackages[`node_modules/${HOST}`], old.nativePackages[`node_modules/${HOST}`]);
});

test('same runtime counters are disambiguated using managed and installed versions, not newest', (t) => {
  const old = fixtureRelease();
  const newer = fixtureRelease(2);
  newer.templateVersion = old.templateVersion;
  newer.nativeRuntimeVersions = { ...old.nativeRuntimeVersions };
  const catalog = { schemaVersion: 1, defaultRelease: newer.id, releases: [newer, old] };
  const fixture = createFixture(t, { release: old, catalog });
  assert.equal(resolveProjectRelease(fixture.projectRoot, catalog), old);
  assert.equal(selectProjectRelease(fixture.projectRoot, catalog), old);
});

test('shared protected requirements use installed host identity, not declarations or default, for planning', (t) => {
  const old = fixtureRelease();
  const newest = fixtureRelease(2);
  newest.templateVersion = old.templateVersion;
  newest.nativeRuntimeVersions = { ...old.nativeRuntimeVersions };
  const catalog = { schemaVersion: 1, defaultRelease: newest.id, releases: [old, newest] };
  const fixture = createFixture(t, { release: old, catalog });
  for (const file of ['package.json', 'package-lock.json']) {
    fs.writeFileSync(path.join(fixture.projectRoot, file), '{"fixture-secret-do-not-echo":');
  }
  assert.equal(selectProjectRelease(fixture.projectRoot, catalog), old);
  const planning = runCli(fixture, ['--project-root', fixture.projectRoot, '--requirements-only']);
  assert.equal(planning.status, 0, planning.stderr);
  assert.equal(JSON.parse(planning.stdout).id, old.id);
  blocked(runCli(fixture, ['--project-root', fixture.projectRoot]));
  installPackage(fixture.projectRoot, `node_modules/${HOST}`, '2.0.0');
  assert.equal(selectProjectRelease(fixture.projectRoot, catalog), newest);
});

test('ambiguous requirements block when installed host is missing, unreviewed, malformed or linked', (t) => {
  const old = fixtureRelease();
  const newest = fixtureRelease(2);
  newest.templateVersion = old.templateVersion;
  newest.nativeRuntimeVersions = { ...old.nativeRuntimeVersions };
  const catalog = { schemaVersion: 1, defaultRelease: newest.id, releases: [old, newest] };
  for (const edit of [
    (root) => fs.rmSync(path.join(root, 'node_modules', HOST), { recursive: true }),
    (root) => installPackage(root, `node_modules/${HOST}`, '99.0.0'),
    (root) => fs.writeFileSync(path.join(root, 'node_modules', HOST, 'package.json'), '{"fixture-secret-do-not-echo":'),
    (root) => installPackage(root, `node_modules/${HOST}`, '1.0.0', { name: 'ordinary-host-impostor' }),
    (root) => {
      const original = path.join(root, 'node_modules', HOST);
      const linked = path.join(root, 'linked-fixture-host');
      fs.renameSync(original, linked);
      fs.symlinkSync(linked, original, 'dir');
    },
  ]) {
    const fixture = createFixture(t, { release: old, catalog });
    edit(fixture.projectRoot);
    assert.throws(() => selectProjectRelease(fixture.projectRoot, catalog), (error) => error.code === 'MOBILE_RELEASE_BLOCKED');
    blocked(runCli(fixture, ['--project-root', fixture.projectRoot, '--requirements-only']));
  }
});

test('requirements reads return only validated protected fields without consulting dependency files', (t) => {
  const fixture = createFixture(t);
  for (const file of ['package.json', 'package-lock.json']) {
    fs.writeFileSync(path.join(fixture.projectRoot, file), '{"fixture-secret-do-not-echo":');
  }
  fs.rmSync(path.join(fixture.projectRoot, 'node_modules'), { recursive: true });
  const requirements = readProjectRequirements(fixture.projectRoot);
  assert.deepEqual(requirements, {
    schemaVersion: 1,
    templateVersion: fixture.release.templateVersion,
    nativeRuntimeVersions: fixture.release.nativeRuntimeVersions,
  });
  assert.equal(selectProjectRelease(fixture.projectRoot, fixture.catalog), fixture.release);
  const result = runCli(fixture, ['--project-root', fixture.projectRoot, '--requirements-only']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    ...summarizeRelease(fixture.release), validationScope: 'requirements-only',
  });
  assert.doesNotMatch(result.stdout, /fixture-secret-do-not-echo|appInsightsConfig/);
  assert.ok(!result.stdout.includes(fixture.projectRoot));
  blocked(runCli(fixture, ['--project-root', fixture.projectRoot]));
});

test('requirements planning preserves tenant configuration and returns only protected version fields', (t) => {
  const fixture = createFixture(t);
  const file = path.join(fixture.projectRoot, 'app.json');
  modifyJson(file, config => Object.assign(config.expo.extra.powerappsNative, {
    tenantMode: 'multi',
    appDisplayName: 'Customer-specific label',
    appName: 'customer_app',
    tenantPolicy: { allowedTenantIds: ['11111111-1111-4111-8111-111111111111'] },
  }));
  const before = fs.readFileSync(file, 'utf8');
  assert.deepEqual(readProjectRequirements(fixture.projectRoot), {
    schemaVersion: 1,
    templateVersion: fixture.release.templateVersion,
    nativeRuntimeVersions: fixture.release.nativeRuntimeVersions,
  });
  assert.equal(selectProjectRelease(fixture.projectRoot, fixture.catalog), fixture.release);
  const result = runCli(fixture, ['--project-root', fixture.projectRoot, '--requirements-only']);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /tenantMode|tenantPolicy|Customer-specific|customer_app|11111111/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('requirements-only selection preserves the source record despite manual host drift', (t) => {
  const old = fixtureRelease();
  const newest = fixtureRelease(2);
  const catalog = { schemaVersion: 1, defaultRelease: newest.id, releases: [old, newest] };
  for (const source of [old, newest]) {
    const fixture = createFixture(t, { release: source, catalog });
    const driftedHost = source === old ? '2.0.0' : '1.0.0';
    for (const file of ['package.json', 'package-lock.json']) modifyJson(path.join(fixture.projectRoot, file), (data) => {
      (data.packages?.[''] || data).dependencies[HOST] = `^${driftedHost}`;
    });
    installPackage(fixture.projectRoot, `node_modules/${HOST}`, driftedHost);
    modifyJson(path.join(fixture.projectRoot, 'package-lock.json'), (lock) => {
      lock.packages[`node_modules/${HOST}`].version = driftedHost;
    });
    assert.equal(selectProjectRelease(fixture.projectRoot, catalog), source);
    const planning = runCli(fixture, ['--project-root', fixture.projectRoot, '--requirements-only']);
    assert.equal(planning.status, 0, planning.stderr);
    assert.equal(JSON.parse(planning.stdout).id, source.id);
    assert.equal(JSON.parse(planning.stdout).hostVersion, source.nativePackages[`node_modules/${HOST}`]);
    assert.throws(() => resolveProjectRelease(fixture.projectRoot, catalog), /Managed dependency/);
    blocked(runCli(fixture, ['--project-root', fixture.projectRoot]), /Managed dependency/);
    blocked(runValidator(fixture), /Managed dependency/);
  }
});

test('equal host versions do not promote stale template requirements to the default release', (t) => {
  const old = fixtureRelease();
  const newest = fixtureRelease(2);
  old.managedDependencies.dependencies[HOST] = newest.managedDependencies.dependencies[HOST];
  old.nativePackages[`node_modules/${HOST}`] = newest.nativePackages[`node_modules/${HOST}`];
  const catalog = { schemaVersion: 1, defaultRelease: newest.id, releases: [old, newest] };
  const fixture = createFixture(t, { release: old, catalog });
  assert.equal(selectProjectRelease(fixture.projectRoot, catalog), old);
  const result = runCli(fixture, ['--project-root', fixture.projectRoot, '--requirements-only']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).templateVersion, old.templateVersion);
});

test('requirements planning never infers missing, invalid or unreviewed protected metadata', (t) => {
  for (const edit of [
    (config) => { delete config.expo.extra.powerappsNative; },
    (config) => { delete config.expo.extra.powerappsNative.schemaVersion; },
    (config) => { delete config.expo.extra.powerappsNative.templateVersion; },
    (config) => { delete config.expo.extra.powerappsNative.nativeRuntimeVersions; },
    (config) => { delete config.expo.extra.powerappsNative.nativeRuntimeVersions.ios; },
    (config) => { config.expo.extra.powerappsNative.schemaVersion = 2; },
    (config) => { config.expo.extra.powerappsNative.templateVersion = '1'; },
    (config) => { config.expo.extra.powerappsNative.nativeRuntimeVersions.android = 0; },
  ]) {
    const fixture = createFixture(t);
    modifyJson(path.join(fixture.projectRoot, 'app.json'), edit);
    assert.throws(() => readProjectRequirements(fixture.projectRoot), /Missing or invalid protected/);
    assert.throws(() => selectProjectRelease(fixture.projectRoot, fixture.catalog), /Missing or invalid protected/);
    blocked(runCli(fixture, ['--project-root', fixture.projectRoot, '--requirements-only']), /Missing or invalid protected/);
  }
  const fixture = createFixture(t);
  modifyJson(path.join(fixture.projectRoot, 'app.json'), (config) => { config.expo.extra.powerappsNative.templateVersion = 99; });
  assert.throws(() => selectProjectRelease(fixture.projectRoot, fixture.catalog), /does not match a verified release/);
  blocked(runCli(fixture, ['--project-root', fixture.projectRoot, '--requirements-only']), /does not match a verified release/);
});

test('requirements-only CLI is explicitly planning, not release assertion or deployment admission', (t) => {
  const fixture = createFixture(t);
  for (const args of [
    ['--requirements-only'],
    ['--release', fixture.release.id, '--requirements-only'],
    ['--project-root', fixture.projectRoot, '--requirements-only', '--requirements-only'],
    ['--project-root', fixture.projectRoot, '--requirements-only', '--default'],
    ['--project-root', fixture.projectRoot, '--requirements-only', '--release', fixture.release.id],
    ['--project-root', fixture.projectRoot, '--requirements-only', '--platform', 'ios'],
    ['--project-root', fixture.projectRoot, '--requirements-only', '--platform', 'android', '--base-version', fixture.release.platforms.android.base.version],
    ['--project-root', fixture.projectRoot, '--requirements-only', '--platform', 'android',
      '--base-version', fixture.release.platforms.android.base.version, '--base-fingerprint', fixture.release.platforms.android.fingerprint],
  ]) blocked(runCli(fixture, args));
  const strict = runCli(fixture, ['--project-root', fixture.projectRoot]);
  assert.equal(strict.status, 0, strict.stderr);
  assert.equal(JSON.parse(strict.stdout).validationScope, undefined);
});

test('requirements planning still requires a reviewed plugin policy and unambiguous source metadata', (t) => {
  const release = fixtureRelease();
  const duplicate = structuredClone(release);
  duplicate.id = 'fixture-same-requirements';
  for (const catalog of [
    { schemaVersion: 1, defaultRelease: null, releases: [] },
    { schemaVersion: 1, defaultRelease: release.id, releases: [release, duplicate] },
  ]) {
    const fixture = createFixture(t, { release, catalog });
    assert.throws(() => selectProjectRelease(fixture.projectRoot, catalog), /No verified mobile releases|multiple reviewed releases/);
    blocked(runCli(fixture, ['--project-root', fixture.projectRoot, '--requirements-only']));
  }
});

test('duplicate compatible records fail closed rather than guessing', (t) => {
  const release = fixtureRelease();
  const duplicate = structuredClone(release);
  duplicate.id = 'fixture-duplicate';
  const catalog = { schemaVersion: 1, defaultRelease: release.id, releases: [release, duplicate] };
  const fixture = createFixture(t, { release, catalog });
  blocked(runCli(fixture, ['--project-root', fixture.projectRoot]), /multiple reviewed releases/);
});

test('CLI supports explicit/default selection and exact project-release assertions', (t) => {
  const old = fixtureRelease();
  const newer = fixtureRelease(2);
  const fixture = createFixture(t, { release: old, catalog: { schemaVersion: 1, defaultRelease: newer.id, releases: [old, newer] } });
  for (const [args, id] of [
    [['--release', old.id], old.id],
    [['--default'], newer.id],
    [['--project-root', fixture.projectRoot, '--release', old.id], old.id],
  ]) {
    const result = runCli(fixture, args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).id, id);
  }
  blocked(runCli(fixture, ['--project-root', fixture.projectRoot, '--release', newer.id]), /exact selected/);
  blocked(runCli(fixture, ['--project-root', fixture.projectRoot, '--default']), /exact selected/);
});

test('deployment checks require a platform, exact base version and actual base fingerprint', (t) => {
  const release = fixtureRelease();
  release.platforms.ios.base.version = 'fixture-ios-base';
  const fixture = createFixture(t, { release });
  const args = ['--project-root', fixture.projectRoot, '--platform', 'ios', '--base-version', 'fixture-ios-base',
    '--base-fingerprint', release.platforms.ios.fingerprint];
  assert.equal(runCli(fixture, args).status, 0);
  blocked(runCli(fixture, ['--default', '--base-version', 'fixture-ios-base']), /requires --platform/);
  blocked(runCli(fixture, ['--default', '--base-fingerprint', release.platforms.ios.fingerprint]), /requires --platform/);
  for (const args of [
    ['--default', '--platform', 'ios'],
    ['--default', '--platform', 'ios', '--base-version', 'fixture-ios-base'],
    ['--default', '--platform', 'ios', '--base-fingerprint', release.platforms.ios.fingerprint],
  ]) blocked(runCli(fixture, args), /both --base-version and --base-fingerprint/);
  blocked(runCli(fixture, ['--default', '--platform', 'android', '--base-version', 'fixture-ios-base',
    '--base-fingerprint', release.platforms.android.fingerprint]), /deployment base/);
  blocked(runCli(fixture, ['--default', '--platform', 'ios', '--base-version', release.platforms.ios.player.version,
    '--base-fingerprint', release.platforms.ios.fingerprint]), /deployment base/);
  blocked(runCli(fixture, ['--default', '--platform', 'ios', '--base-version', 'fixture-ios-base',
    '--base-fingerprint', release.platforms.android.fingerprint]), /deployment base fingerprint/);
  blocked(runCli(fixture, ['--default', '--platform', 'ios', '--base-version', 'fixture-ios-base',
    '--base-fingerprint', 'fixture-secret-do-not-echo']), /deployment base fingerprint/);
});

test('matching deployment evidence cannot bypass strict project native inventory validation', (t) => {
  const fixture = createFixture(t);
  const platform = fixture.release.platforms.android;
  addDependency(fixture.projectRoot, '@microsoft/power-apps-native-controls', '1.0.0');
  blocked(runCli(fixture, ['--project-root', fixture.projectRoot, '--platform', 'android',
    '--base-version', platform.base.version, '--base-fingerprint', platform.fingerprint]), /Native\/runtime dependency/);
});

test('CLI rejects unknown, duplicate, conflicting and incomplete arguments without echoing values', (t) => {
  const fixture = createFixture(t);
  for (const args of [
    [], ['--unknown', 'fixture-secret-do-not-echo'], ['--default', '--default'],
    ['--release', fixture.release.id, '--release', fixture.release.id],
    ['--project-root', fixture.projectRoot, '--project-root', fixture.projectRoot],
    ['--default', '--platform', 'ios', '--platform', 'android'],
    ['--default', '--platform', 'ios', '--base-version', 'one', '--base-version', 'two'],
    ['--default', '--platform', 'ios', '--base-fingerprint', 'one', '--base-fingerprint', 'two'],
    ['--release', fixture.release.id, '--default'], ['--release'],
    ['--project-root', '--default'], ['--default', '--platform', 'web'],
    ['--default', '--base-version', ''], ['--default', '--platform'],
    ['--default', '--base-fingerprint'],
    ['--default', 'fixture-secret-do-not-echo'],
  ]) blocked(runCli(fixture, args));
});

test('CLI blocks the intentionally empty policy with actionable publication guidance', (t) => {
  const fixture = createFixture(t, { catalog: { schemaVersion: 1, defaultRelease: null, releases: [] } });
  blocked(runCli(fixture, ['--default']), /maintainer.*publish.*review/);
  blocked(runCli(fixture, ['--project-root', fixture.projectRoot]), /No verified mobile releases/);
});

test('does not evaluate app.config.js or leak app config on malformed JSON', (t) => {
  const fixture = createFixture(t);
  fs.writeFileSync(path.join(fixture.projectRoot, 'app.config.js'), 'throw new Error("fixture-secret-do-not-echo");');
  assert.equal(runCli(fixture, ['--project-root', fixture.projectRoot]).status, 0);
  fs.writeFileSync(path.join(fixture.projectRoot, 'app.json'), '{"fixture-secret-do-not-echo":');
  blocked(runCli(fixture, ['--project-root', fixture.projectRoot]), /Cannot read valid app.json/);
});

test('missing locks, old locks, root declaration drift and invalid dependency sections fail closed', (t) => {
  for (const edit of [
    (root) => fs.rmSync(path.join(root, 'package-lock.json')),
    (root) => modifyJson(path.join(root, 'package-lock.json'), (lock) => { lock.lockfileVersion = 1; }),
    (root) => modifyJson(path.join(root, 'package-lock.json'), (lock) => { lock.packages[''].dependencies.expo = '9.0.0'; }),
    (root) => modifyJson(path.join(root, 'package.json'), (pkg) => { pkg.dependencies = []; }),
    (root) => modifyJson(path.join(root, 'package.json'), (pkg) => { pkg.devDependencies = { react: '1.0.0' }; }),
  ]) {
    const fixture = createFixture(t);
    edit(fixture.projectRoot);
    blocked(runCli(fixture, ['--project-root', fixture.projectRoot]));
  }
});

test('npm v2 app locks are supported', (t) => {
  const fixture = createFixture(t);
  modifyJson(path.join(fixture.projectRoot, 'package-lock.json'), (lock) => { lock.lockfileVersion = 2; });
  assert.equal(runCli(fixture, ['--project-root', fixture.projectRoot]).status, 0);
});

test('declared managed dependencies cannot be moved to another section', (t) => {
  const fixture = createFixture(t);
  for (const file of ['package.json', 'package-lock.json']) modifyJson(path.join(fixture.projectRoot, file), (data) => {
    const root = data.packages?.[''] || data;
    root.devDependencies = { [HOST]: root.dependencies[HOST] };
    delete root.dependencies[HOST];
  });
  blocked(runCli(fixture, ['--project-root', fixture.projectRoot]), /Managed dependency/);
});

test('uninstalled, untracked and lock-mismatched native dependencies cannot pass', (t) => {
  for (const edit of [
    (root) => fs.rmSync(path.join(root, 'node_modules/expo'), { recursive: true }),
    (root) => installPackage(root, 'node_modules/ordinary-native', '1.0.0', { codegenConfig: {} }),
    (root) => modifyJson(path.join(root, 'package-lock.json'), (lock) => { lock.packages['node_modules/expo'].version = '2.0.0'; }),
  ]) {
    const fixture = createFixture(t);
    edit(fixture.projectRoot);
    blocked(runCli(fixture, ['--project-root', fixture.projectRoot]));
  }
});

test('an uninstalled ordinary-name direct dependency is not presumed JS-only', (t) => {
  const fixture = createFixture(t);
  for (const file of ['package.json', 'package-lock.json']) modifyJson(path.join(fixture.projectRoot, file), (data) => {
    (data.packages?.[''] || data).dependencies['ordinary-uninstalled'] = '1.0.0';
  });
  blocked(runCli(fixture, ['--project-root', fixture.projectRoot]), /declared dependency is not installed/);
});

test('an ordinary-name wrapper cannot conceal an uninstalled transitive module', (t) => {
  const fixture = createFixture(t);
  addDependency(fixture.projectRoot, 'ordinary-wrapper', '1.0.0', {
    properties: { dependencies: { 'ordinary-uninstalled': '1.0.0' } },
  });
  blocked(runCli(fixture, ['--project-root', fixture.projectRoot]), /incomplete transitive dependency tree/);
});

test('transitive dependency resolution supports hoisting and nested scoped packages', (t) => {
  const fixture = createFixture(t);
  addDependency(fixture.projectRoot, '@scope/wrapper', '1.0.0', {
    properties: { dependencies: { 'ordinary-tool': '1.0.0' } },
  });
  addDependency(fixture.projectRoot, 'ordinary-tool', '1.0.0', {
    section: null, properties: { dependencies: { '@scope/nested': '1.0.0' } },
  });
  addDependency(fixture.projectRoot, '@scope/nested', '1.0.0', {
    section: null, installPath: 'node_modules/ordinary-tool/node_modules/@scope/nested',
    properties: { peerDependencies: { react: '1.0.0' } },
  });
  assert.equal(runCli(fixture, ['--project-root', fixture.projectRoot]).status, 0);
});

test('missing CLI implementation files still produce sanitized BLOCKED errors', (t) => {
  const fixture = createFixture(t);
  fs.rmSync(path.join(fixture.pluginRoot, 'scripts/lib/mobile-release.js'));
  blocked(runCli(fixture, ['--default']), /Unable to verify/);
});

test('a nested second native instance cannot borrow approval from a root instance', (t) => {
  const release = fixtureRelease();
  release.nativePackages['node_modules/ordinary-bridge'] = '1.0.0';
  const fixture = createFixture(t, { release });
  addDependency(fixture.projectRoot, 'ordinary-bridge', '2.0.0', {
    section: null, installPath: 'node_modules/expo/node_modules/ordinary-bridge', properties: { codegenConfig: {} },
  });
  blocked(runCli(fixture, ['--project-root', fixture.projectRoot]), /Unreviewed native/);
});

test('unsafe lock paths and symlinked installations fail closed', (t) => {
  const fixture = createFixture(t);
  modifyJson(path.join(fixture.projectRoot, 'package-lock.json'), (lock) => { lock.packages['node_modules/../outside'] = { version: '1.0.0' }; });
  blocked(runCli(fixture, ['--project-root', fixture.projectRoot]), /Invalid or linked app lock/);
  modifyJson(path.join(fixture.projectRoot, 'package-lock.json'), (lock) => { delete lock.packages['node_modules/../outside']; });
  const external = path.join(fixture.directory, 'linked-package');
  writeJson(path.join(external, 'package.json'), { name: 'ordinary-link', version: '1.0.0' });
  fs.symlinkSync(external, path.join(fixture.projectRoot, 'node_modules/ordinary-link'), 'dir');
  blocked(runCli(fixture, ['--project-root', fixture.projectRoot]), /Linked packages/);
});

test('missing optional packages for another installation platform do not hide reviewed native packages', (t) => {
  const fixture = createFixture(t);
  const otherPlatform = process.platform === 'win32' ? 'linux' : 'win32';
  modifyJson(path.join(fixture.projectRoot, 'package-lock.json'), (lock) => {
    lock.packages['node_modules/optional-fixture'] = { version: '1.0.0', optional: true, os: [otherPlatform] };
  });
  assert.equal(runCli(fixture, ['--project-root', fixture.projectRoot]).status, 0);
  fs.rmSync(path.join(fixture.projectRoot, 'node_modules/expo'), { recursive: true });
  modifyJson(path.join(fixture.projectRoot, 'package-lock.json'), (lock) => {
    lock.packages['node_modules/expo'].optional = true;
    lock.packages['node_modules/expo'].os = [otherPlatform];
  });
  blocked(runCli(fixture, ['--project-root', fixture.projectRoot]), /native inventory|declared dependency is not installed/);
});

// Minimal npm-generated alias layout: CLIUI resolves both the ESM canonical
// package and an older CJS alias. The payloads and release policy remain synthetic.
function addCliuiAlias(fixture, { alias = 'string-width-cjs', canonical = 'string-width', properties = {} } = {}) {
  const cliui = '@isaacs/cliui';
  const dependencies = { [alias]: `npm:${canonical}@^4.2.0` };
  addDependency(fixture.projectRoot, cliui, '8.0.2', { properties: { dependencies } });
  const installPath = `node_modules/${alias}`;
  addDependency(fixture.projectRoot, alias, '4.2.3', { section: null, properties: { name: canonical, ...properties } });
  modifyJson(path.join(fixture.projectRoot, 'package-lock.json'), (lock) => {
    lock.packages[`node_modules/${cliui}`].dependencies = dependencies;
    lock.packages[installPath].name = canonical;
  });
  return installPath;
}

test('ordinary npm JS aliases retain canonical identity and exact lock versions', (t) => {
  const fixture = createFixture(t);
  const aliasPath = addCliuiAlias(fixture);
  addDependency(fixture.projectRoot, 'string-width', '5.1.2', { section: null });
  for (const file of [`node_modules/@isaacs/cliui/package.json`, 'package-lock.json']) {
    modifyJson(path.join(fixture.projectRoot, file), (value) => {
      const entry = value.packages ? value.packages['node_modules/@isaacs/cliui'] : value;
      entry.dependencies['string-width'] = '^5.1.2';
    });
  }
  assert.equal(resolveProjectRelease(fixture.projectRoot, fixture.catalog), fixture.release);
  assert.equal(runValidator(fixture).status, 0);
  assert.equal(runValidator(fixture, { explicit: false }).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.projectRoot, aliasPath, 'package.json'))).name, 'string-width');
});

test('direct npm JS aliases can be verified without promoting them into the native policy', (t) => {
  const fixture = createFixture(t);
  const aliasPath = addCliuiAlias(fixture);
  for (const file of ['package.json', 'package-lock.json']) {
    modifyJson(path.join(fixture.projectRoot, file), (value) => {
      (value.packages?.[''] || value).dependencies['string-width-cjs'] = 'npm:string-width@^4.2.0';
    });
  }
  assert.equal(resolveProjectRelease(fixture.projectRoot, fixture.catalog), fixture.release);
  assert.equal(fixture.release.nativePackages[aliasPath], undefined);
});

test('aliases fail closed on missing canonical lock identity or installed/lock identity and version drift', (t) => {
  for (const edit of [
    (root, entry) => modifyJson(path.join(root, 'package-lock.json'), (lock) => { delete lock.packages[entry].name; }),
    (root, entry) => modifyJson(path.join(root, 'package-lock.json'), (lock) => { lock.packages[entry].name = 'other-package'; }),
    (root, entry) => modifyJson(path.join(root, 'package-lock.json'), (lock) => { lock.packages[entry].version = '4.2.4'; }),
    (root, entry) => modifyJson(path.join(root, 'package-lock.json'), (lock) => { lock.packages[entry].link = true; }),
    (root, entry) => modifyJson(path.join(root, entry, 'package.json'), (pkg) => { pkg.version = '4.2.2'; }),
    (root, entry) => modifyJson(path.join(root, entry, 'package.json'), (pkg) => { pkg.name = 'other-package'; }),
  ]) {
    const fixture = createFixture(t);
    const alias = addCliuiAlias(fixture);
    edit(fixture.projectRoot, alias);
    blocked(runCli(fixture, ['--project-root', fixture.projectRoot]), /alias|canonical identity/);
    blocked(runValidator(fixture, { explicit: false }), /alias|canonical identity/);
  }
});

test('native aliases are rejected using alias names, canonical names and detected native code', (t) => {
  for (const aliasOptions of [
    { alias: 'expo-notifications', canonical: 'string-width' },
    { alias: 'string-width-cjs', canonical: '@microsoft/power-apps-native-controls' },
    { alias: 'string-width-cjs', canonical: 'ordinary-bridge', properties: { codegenConfig: {} } },
    { alias: 'string-width-cjs', canonical: 'ordinary-bridge', source: true },
  ]) {
    const release = fixtureRelease();
    const aliasPath = `node_modules/${aliasOptions.alias}`;
    release.nativePackages[aliasPath] = '4.2.3';
    const fixture = createFixture(t, { release });
    addCliuiAlias(fixture, aliasOptions);
    if (aliasOptions.source) fs.writeFileSync(path.join(fixture.projectRoot, aliasPath, 'Bridge.swift'), '');
    blocked(runCli(fixture, ['--project-root', fixture.projectRoot]), /Native\/runtime npm aliases/);
    blocked(runValidator(fixture, { explicit: false }), /Native\/runtime npm aliases/);
  }
});

test('ordinary non-aliased packages also reject contradictory canonical lock identities', (t) => {
  const fixture = createFixture(t);
  addDependency(fixture.projectRoot, 'date-fns', '4.1.0');
  modifyJson(path.join(fixture.projectRoot, 'package-lock.json'), (lock) => {
    lock.packages['node_modules/date-fns'].name = 'different-package';
  });
  blocked(runCli(fixture, ['--project-root', fixture.projectRoot]), /canonical identity/);
});

test('an alias canonical identity must also agree with its requesting package declaration', (t) => {
  for (const spec of ['npm:other-package@^4.2.0', '^4.2.0']) {
    const fixture = createFixture(t);
    addCliuiAlias(fixture);
    for (const file of ['node_modules/@isaacs/cliui/package.json', 'package-lock.json']) {
      modifyJson(path.join(fixture.projectRoot, file), (value) => {
        (value.packages?.['node_modules/@isaacs/cliui'] || value).dependencies['string-width-cjs'] = spec;
      });
    }
    blocked(runCli(fixture, ['--project-root', fixture.projectRoot]), /canonical identity.*dependency declaration/);
  }
});

const LINUX_GLIBC = { os: 'linux', cpu: 'x64', libc: 'glibc' };

function addLightningCssPlatforms(fixture, installedLibc = 'glibc') {
  const version = '1.29.2';
  const variants = { glibc: 'lightningcss-linux-x64-gnu', musl: 'lightningcss-linux-x64-musl' };
  const optionalDependencies = Object.fromEntries(Object.values(variants).map((name) => [name, version]));
  addDependency(fixture.projectRoot, 'lightningcss', version, { properties: { optionalDependencies } });
  installPackage(fixture.projectRoot, `node_modules/${variants[installedLibc]}`, version);
  modifyJson(path.join(fixture.projectRoot, 'package-lock.json'), (lock) => {
    lock.packages['node_modules/lightningcss'].optionalDependencies = optionalDependencies;
    for (const [libc, name] of Object.entries(variants)) {
      lock.packages[`node_modules/${name}`] = { version, optional: true, os: ['linux'], cpu: ['x64'], libc: [libc] };
    }
  });
}

test('Linux/glibc accepts omitted optional musl LightningCSS without skipping the active GNU package', (t) => {
  const fixture = createFixture(t);
  addLightningCssPlatforms(fixture);
  const context = readPlatformContext({
    os: 'linux', cpu: 'x64',
    getReport: () => ({ header: { glibcVersionRuntime: '2.39' }, environmentVariables: { credential: 'fixture-secret-do-not-echo' } }),
  });
  assert.deepEqual(context, LINUX_GLIBC);
  assert.equal(resolveProjectRelease(fixture.projectRoot, fixture.catalog, context), fixture.release);
  fs.rmSync(path.join(fixture.projectRoot, 'node_modules/lightningcss-linux-x64-gnu'), { recursive: true });
  assert.throws(() => resolveProjectRelease(fixture.projectRoot, fixture.catalog, context), /incomplete transitive dependency tree/);
});

test('Linux/musl accepts omitted optional glibc binaries using in-memory report detection', (t) => {
  const fixture = createFixture(t);
  addLightningCssPlatforms(fixture, 'musl');
  const context = readPlatformContext({
    os: 'linux', cpu: 'x64', getReport: () => ({ header: {}, sharedObjects: ['/lib/ld-musl-x86_64.so.1'] }),
  });
  assert.deepEqual(context, { os: 'linux', cpu: 'x64', libc: 'musl' });
  assert.equal(resolveProjectRelease(fixture.projectRoot, fixture.catalog, context), fixture.release);
});

test('unavailable libc evidence fails closed without leaking diagnostic reports or raw errors', (t) => {
  const fixture = createFixture(t);
  addLightningCssPlatforms(fixture);
  for (const getReport of [
    () => ({}),
    () => { throw new Error('fixture-secret-do-not-echo'); },
  ]) {
    const context = readPlatformContext({ os: 'linux', cpu: 'x64', getReport });
    assert.equal(context.libc, null);
    assert.throws(() => resolveProjectRelease(fixture.projectRoot, fixture.catalog, context),
      (error) => error.code === 'MOBILE_RELEASE_BLOCKED' && !error.message.includes('fixture-secret-do-not-echo'));
  }
  assert.deepEqual(readPlatformContext({ os: 'darwin', cpu: 'arm64', getReport: () => assert.fail('must not read reports on other platforms') }),
    { os: 'darwin', cpu: 'arm64', libc: null });
});

test('npm platform constraints support string/array forms and negation, but not a blanket optional skip', (t) => {
  for (const [constraints, omitted] of [
    [{ os: 'win32' }, true],
    [{ os: ['!linux'] }, true],
    [{ cpu: 'arm64' }, true],
    [{ cpu: ['!x64'] }, true],
    [{ libc: 'musl' }, true],
    [{ libc: ['!glibc'] }, true],
    [{ os: ['any'] }, false],
    [{ os: ['!win32'] }, false],
    [{ cpu: ['x64'] }, false],
    [{ libc: ['glibc'] }, false],
    [{}, false],
  ]) {
    const fixture = createFixture(t);
    modifyJson(path.join(fixture.projectRoot, 'package-lock.json'), (lock) => {
      lock.packages['node_modules/fixture-platform-addon'] = { version: '1.0.0', optional: true, ...constraints };
    });
    if (omitted) assert.equal(resolveProjectRelease(fixture.projectRoot, fixture.catalog, LINUX_GLIBC), fixture.release);
    else assert.throws(() => resolveProjectRelease(fixture.projectRoot, fixture.catalog, LINUX_GLIBC), /locked dependency is not installed/);
  }
});

function addOmittedWindowsSubtree(fixture, { nested = false, childName = 'fixture-optional-js-child' } = {}) {
  const parentName = 'fixture-windows-parent';
  const parentPath = `node_modules/${parentName}`;
  const childPath = nested ? `${parentPath}/node_modules/${childName}` : `node_modules/${childName}`;
  const optionalDependencies = { [parentName]: '1.0.0' };
  addDependency(fixture.projectRoot, 'fixture-platform-loader', '1.0.0', { properties: { optionalDependencies } });
  modifyJson(path.join(fixture.projectRoot, 'package-lock.json'), (lock) => {
    lock.packages['node_modules/fixture-platform-loader'].optionalDependencies = optionalDependencies;
    lock.packages[parentPath] = { version: '1.0.0', optional: true, os: ['win32'], dependencies: { [childName]: '^1.0.0' } };
    lock.packages[childPath] = { version: '1.0.0', optional: true };
  });
  return { parentPath, childPath, childName };
}

test('omitted Windows optional parents permit exclusively omitted JS children without their own os constraint', (t) => {
  for (const nested of [false, true]) {
    const fixture = createFixture(t);
    const { childPath } = addOmittedWindowsSubtree(fixture, { nested });
    modifyJson(path.join(fixture.projectRoot, 'package-lock.json'), (lock) => {
      lock.packages[childPath].dependencies = { 'fixture-optional-grandchild': '1.0.0' };
      lock.packages['node_modules/fixture-optional-grandchild'] = { version: '1.0.0', optional: true };
    });
    assert.equal(resolveProjectRelease(fixture.projectRoot, fixture.catalog, LINUX_GLIBC), fixture.release);
    assert.throws(() => resolveProjectRelease(fixture.projectRoot, fixture.catalog, { os: 'win32', cpu: 'x64', libc: null }),
      /incomplete transitive dependency tree/);
  }
});

test('a child shared with an active dependency cannot borrow an omitted optional parent exemption', (t) => {
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const fixture = createFixture(t);
    const { childName } = addOmittedWindowsSubtree(fixture);
    addDependency(fixture.projectRoot, 'fixture-active-consumer', '1.0.0', { properties: { [section]: { [childName]: '1.0.0' } } });
    assert.throws(() => resolveProjectRelease(fixture.projectRoot, fixture.catalog, LINUX_GLIBC), /incomplete transitive dependency tree/);
  }
});

test('required root dependencies cannot be excused by inherited optional flags or platform incompatibility', (t) => {
  const fixture = createFixture(t);
  const { childName, childPath } = addOmittedWindowsSubtree(fixture);
  for (const file of ['package.json', 'package-lock.json']) modifyJson(path.join(fixture.projectRoot, file), (value) => {
    (value.packages?.[''] || value).dependencies[childName] = '1.0.0';
  });
  modifyJson(path.join(fixture.projectRoot, 'package-lock.json'), (lock) => { lock.packages[childPath].os = ['win32']; });
  assert.throws(() => resolveProjectRelease(fixture.projectRoot, fixture.catalog, LINUX_GLIBC), /declared dependency is not installed/);
});

test('missing required lock entries are not optional merely because a skipped parent references them', (t) => {
  const fixture = createFixture(t);
  const { childPath } = addOmittedWindowsSubtree(fixture);
  modifyJson(path.join(fixture.projectRoot, 'package-lock.json'), (lock) => { delete lock.packages[childPath].optional; });
  assert.throws(() => resolveProjectRelease(fixture.projectRoot, fixture.catalog, LINUX_GLIBC), /locked dependency is not installed/);
});

test('all reviewed native entries remain mandatory even inside an exclusively omitted optional subtree', (t) => {
  const release = fixtureRelease();
  const nativePath = 'node_modules/fixture-required-native';
  release.nativePackages[nativePath] = '1.0.0';
  const fixture = createFixture(t, { release });
  addOmittedWindowsSubtree(fixture, { childName: 'fixture-required-native' });
  fs.rmSync(path.join(fixture.projectRoot, nativePath), { recursive: true });
  assert.throws(() => resolveProjectRelease(fixture.projectRoot, fixture.catalog, LINUX_GLIBC), /native inventory/);
});

test('an installed native leftover is inspected even when its optional parent is omitted', (t) => {
  const fixture = createFixture(t);
  const { childPath } = addOmittedWindowsSubtree(fixture);
  installPackage(fixture.projectRoot, childPath, '1.0.0', { codegenConfig: {} });
  assert.throws(() => resolveProjectRelease(fixture.projectRoot, fixture.catalog, LINUX_GLIBC), /Unreviewed native package/);
});
