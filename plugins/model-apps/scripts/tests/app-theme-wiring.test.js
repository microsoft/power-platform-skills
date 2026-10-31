'use strict';
// app.theme (Preview) as the build, changed-only, verify and teardown reach it. The theme's own behaviour (plan, set,
// remove, reads, download capture) is pinned in app-theme*.test.js; here lib/app-theme.js's entry points are replaced by
// recorders, so what is pinned is WHERE the engine calls them, what it hands them, and what it does with the answer.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { inOwnFolder } = require('./helpers/own-app-folder.js');
const { runSdkBuild: runSdkBuildInPlace } = require('../lib/sdk-build.js');
const runSdkBuild = inOwnFolder(runSdkBuildInPlace);
const { membershipSpec, membershipSdk, APP } = require('./helpers/app-membership-sdk.js');
const { fakeGenpage } = require('./helpers/fake-genpage.js');
const theme = require('../lib/app-theme.js');
const { classifyAppShell } = require('../lib/classify-changes.js');
const { verifySpec } = require('../lib/verify-spec.js');
const { readerFor } = require('../verify-model-app.js');
const { planTeardown } = require('../lib/sdk-teardown.js');
const { appMembershipWarnings, validateAppSpec } = require('../lib/app-spec.js');
const { setAppThemeFloor } = require('../lib/app-components.js');

const THEME = { basePaletteColor: '#0f6cbd' };
const LOGO = 'contoso_/images/logo.svg';
const done = () => ({ saved: ['app.theme'], unchanged: [], pendingPublish: ['app.theme'], refused: [], unknown: [] });
const themed = (options) => { const spec = membershipSpec(options); spec.app.theme = THEME; return spec; };

// Replaces applyDeclaredAppTheme with one that queues the app's publication as the real one does (applyAppTheme `owe`),
// and records the call among the fake SDK's own events, so its place in the run is visible.
function recordTheme(t, fake, answer = done) {
  const calls = [];
  t.mock.method(theme, 'applyDeclaredAppTheme', async (spec, ctx) => {
    calls.push(ctx);
    fake.events.push(['theme', ctx.appId]);
    const result = answer();
    if (result.pendingPublish.length) ctx.publication.queue({ kind: 'app', id: ctx.appId, reason: 'app.theme' });
    return result;
  });
  return calls;
}
const indexOf = (events, name, from = 0) => events.findIndex(([event], i) => i >= from && event === name);
const count = (events, name) => events.filter(([event]) => event === name).length;

test('existing app, app step only: the theme is queued before the app\'s one publication, which pays it', async (t) => {
  const fake = membershipSdk({ existing: true });
  const calls = recordTheme(t, fake);
  const result = await runSdkBuild(themed({ hidden: false, mainForms: false }), { sdk: fake.sdk, apply: true, phases: ['app-shell'] });
  const at = indexOf(fake.events, 'theme');
  assert.ok(at >= 0 && at < indexOf(fake.events, 'publish'), JSON.stringify(fake.events.map(([e]) => e)));
  assert.equal(count(fake.events, 'publish'), 1, 'no second app publication for the theme');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].appId, APP);
  assert.equal(typeof calls[0].publication.queue, 'function', 'the build\'s publication port is handed over');
  assert.equal(calls[0].publisherPrefix, 'contoso');
  assert.equal(calls[0].solution, 'ContosoMembership');
  assert.deepEqual(result.created.appTheme, done());
});

test('existing app with the pages phase: the theme is queued in the app step, before the finalizer\'s publication, and adds none', async (t) => {
  const run = async (spec) => {
    const fake = membershipSdk({ existing: true });
    const calls = recordTheme(t, fake);
    await runSdkBuild(spec, { sdk: fake.sdk, apply: true, phases: ['app-shell', 'pages', 'publish'], publish: true, genpage: fakeGenpage() });
    return { fake, calls };
  };
  const baseline = await run(membershipSpec());
  const { fake, calls } = await run(themed());
  const at = indexOf(fake.events, 'theme');
  assert.ok(at >= 0 && at < indexOf(fake.events, 'push') && at < indexOf(fake.events, 'publish'), JSON.stringify(fake.events.map(([e]) => e)));
  assert.equal(calls.length, 1, 'the finalizer\'s fallback finds the theme done');
  assert.equal(count(fake.events, 'publish'), count(baseline.fake.events, 'publish'), 'the theme adds no app publication');
  assert.equal(baseline.calls.length, 0);
});

test('new app: the theme follows the create, whose own publication cannot pay it, and is paid by a later one', async (t) => {
  const fake = membershipSdk();
  recordTheme(t, fake);
  const result = await runSdkBuild(themed({ hidden: false, mainForms: false }), { sdk: fake.sdk, apply: true, phases: ['app-shell'] });
  const create = indexOf(fake.events, 'create');
  const at = indexOf(fake.events, 'theme');
  assert.ok(create >= 0 && create < at, 'never before the app exists');
  assert.ok(indexOf(fake.events, 'publish', at) > at, `an app publication follows the theme: ${JSON.stringify(fake.events.map(([e]) => e))}`);
  assert.equal(result.created.app, APP);
  assert.deepEqual(result.incomplete || [], []);
});

test('a refused or unknown theme ends the build as APP_THEME_INCOMPLETE, never retried, and keeps what was saved', async (t) => {
  for (const answer of [
    () => ({ ...done(), saved: [], pendingPublish: [], refused: [{ key: 'app.theme', code: 'APP_THEME_PREREQUISITE_UNRESOLVED' }] }),
    () => ({ ...done(), pendingPublish: [], unknown: [{ key: 'app.theme', code: 'APP_THEME_READ_INCOMPLETE', afterWrite: true }] }),
  ]) {
    const fake = membershipSdk({ existing: true });
    t.mock.restoreAll();
    recordTheme(t, fake, answer);
    await assert.rejects(runSdkBuild(themed({ hidden: false, mainForms: false }), { sdk: fake.sdk, apply: true, phases: ['app-shell'] }),
      (error) => error.code === 'APP_THEME_INCOMPLETE' && /APP_THEME_(PREREQUISITE_UNRESOLVED|READ_INCOMPLETE)/.test(error.message));
    assert.equal(count(fake.events, 'theme'), 1);
  }
});

test('a build that does not reach the app step does not apply, and does not claim, the theme', async (t) => {
  const fake = membershipSdk({ existing: true });
  const calls = recordTheme(t, fake);
  await runSdkBuild(themed({ hidden: false, mainForms: false }), { sdk: fake.sdk, apply: true, phases: ['publish'] });
  assert.equal(calls.length, 0);
});

test('a dry run lists the theme as one app step and applies nothing', async (t) => {
  const fake = membershipSdk({ existing: true });
  const calls = recordTheme(t, fake);
  const result = await runSdkBuild(themed({ hidden: false, mainForms: false }), { sdk: fake.sdk, apply: false, phases: ['app-shell'] });
  assert.deepEqual(result.planItems.filter((item) => /theme/.test(item.label)), [{ phase: 'app-shell', label: 'app theme (Preview)' }]);
  const bare = await runSdkBuild(membershipSpec({ hidden: false, mainForms: false }), { sdk: fake.sdk, apply: false, phases: ['app-shell'] });
  assert.deepEqual(bare.planItems.filter((item) => /theme/.test(item.label)), []);
  assert.equal(calls.length, 0);
});

test('the SDK factory guards theme reads only when asked (themeReads), innermost, and does not pass the option on', () => {
  const { withVendoredCompiler } = require('../lib/maker-sdk.js');
  const { isThemeReadGuarded } = require('../lib/app-theme-reads.js');
  const passed = [];
  const factory = withVendoredCompiler((options) => { passed.push(options); return {}; });
  const httpClient = { get: async () => ({ status: 200, body: { value: [] } }) };
  assert.equal(isThemeReadGuarded(factory({ httpClient })), false);
  assert.equal(isThemeReadGuarded(factory({ httpClient, themeReads: true })), true);
  assert.equal(isThemeReadGuarded(factory({ themeReads: true })), false, 'no client, nothing to guard');
  assert.ok(passed.every((options) => !Object.hasOwn(options, 'themeReads')));
});

test('changed-only: an edit to app.theme alone is a full build of the app, never a sitemap-only fast path', () => {
  const prior = membershipSpec({ hidden: false, mainForms: false });
  const out = classifyAppShell(themed({ hidden: false, mainForms: false }), prior);
  assert.deepEqual(out.fast, []);
  assert.equal(out.full.length, 1);
  assert.deepEqual(classifyAppShell(prior, membershipSpec({ hidden: false, mainForms: false })), { fast: [], full: [], debt: [] });
});

function verifyFixture() {
  const read = readerFor({}, 'contoso_membership');
  read.sitemapXml = async () => '<SiteMap><Area><Group><SubArea Entity="contoso_item" Title="Items"/></Group></Area></SiteMap>';
  const spec = themed({ hidden: false, mainForms: false });
  spec.entities = [];
  return { read, spec };
}
const themeChecks = (result) => result.checks.filter((check) => check.kind === 'app-theme');

test('verify: only a live theme passes, and its detail says it is API state, not render proof', async () => {
  const cases = [
    [[{ key: 'app.theme', ok: true, state: 'live' }], true, /API state, not render proof/],
    [[{ key: 'app.theme', ok: false, state: 'pendingPublish', reasons: ['row'] }], false, /not published yet \(row\)/],
    [[{ key: 'app.theme', ok: false, state: 'mismatch', code: 'APP_THEME_MEMBERSHIP_MISSING' }], false, /differs from the spec \(APP_THEME_MEMBERSHIP_MISSING\)/],
    [[{ key: 'app.theme', ok: false, state: 'unknown', code: 'APP_THEME_READ_INCOMPLETE' }], false, /unknown \(APP_THEME_READ_INCOMPLETE\) — unverified/],
    [[{ key: 'app.theme', ok: true, state: 'unknown' }], false, /unknown/],
  ];
  for (const [answer, present, detail] of cases) {
    const { read, spec } = verifyFixture();
    read.appTheme = async () => answer;
    const [check] = themeChecks(await verifySpec(spec, read));
    assert.equal(check.present, present, JSON.stringify(answer));
    assert.match(check.detail, detail);
  }
});

test('verify: a theme reader that is missing, throws or answers nothing fails as unverified', async () => {
  for (const reader of [undefined, async () => { throw new Error('403'); }, async () => [], async () => null]) {
    const { read, spec } = verifyFixture();
    if (reader) read.appTheme = reader; else delete read.appTheme;
    const checks = themeChecks(await verifySpec(spec, read));
    assert.equal(checks.length, 1);
    assert.equal(checks[0].present, false);
    assert.match(checks[0].detail, /unverified, not proven correct/);
  }
  const { read, spec } = verifyFixture();
  delete spec.app.theme;
  let asked = false;
  read.appTheme = async () => { asked = true; return []; };
  assert.deepEqual(themeChecks(await verifySpec(spec, read)), []);
  assert.equal(asked, false, 'an omitted theme is not managed, so it is not read');
});

test('verify: the reader reads on an isolated SDK made with the strict theme policy, and disposes it', async (t) => {
  const asked = [];
  let disposed = 0;
  const sdk = { queryRecords: async (set) => (set === 'appmodule' ? [{ appmoduleid: APP }] : []) };
  const isolated = { getAppTheme: async () => ({}) };
  const read = readerFor(sdk, 'contoso_membership', { isolatedReader: async (options) => { asked.push(options); return { sdk: isolated, dispose: () => { disposed++; } }; } });
  const seen = [];
  t.mock.method(theme, 'verifyAppTheme', async (spec, ctx) => { seen.push(ctx); return [{ key: 'app.theme', ok: true, state: 'live' }]; });
  const spec = themed({ hidden: false, mainForms: false });
  assert.deepEqual(await read.appTheme(spec), [{ key: 'app.theme', ok: true, state: 'live' }]);
  assert.deepEqual(asked, [{ themeReads: true }]);
  assert.equal(seen[0].sdk, isolated);
  assert.equal(seen[0].appId, APP);
  assert.equal(seen[0].solution, 'ContosoMembership');
  assert.equal(disposed, 1);
  await assert.rejects(readerFor(sdk, 'contoso_membership').appTheme(spec), /isolated reader/);
});

test('teardown: a theme names its logo but owns nothing — an external logo is kept, a declared one is deleted as before', () => {
  const spec = (external) => ({
    solution: { uniqueName: 'ThemeSln', publisherPrefix: 'contoso' },
    app: { name: 'Theme App', theme: { logo: { webResourceName: LOGO } } },
    entities: [{ schemaName: 'contoso_widget', primaryAttribute: { schemaName: 'contoso_name' }, columns: [] }],
    webResources: [{ name: LOGO, type: 'svg', contentBase64: 'PHN2Zz4=', ...(external ? { external: true } : {}) }],
    appShell: { areas: [{ label: 'A', groups: [{ label: 'G', subAreas: [{ entity: 'contoso_widget' }] }] }] },
  });
  const names = (s) => planTeardown(s).filter((step) => step.kind === 'webResource').map((step) => step.target.name);
  assert.ok(!names(spec(true)).includes(LOGO), 'a downloaded (external) logo is never deleted');
  assert.ok(names(spec(false)).includes(LOGO), 'the theme does not take ownership away from a declared, owned resource');
  const bare = spec(false);
  delete bare.app.theme;
  assert.deepEqual(planTeardown(spec(false)).map((step) => step.kind), planTeardown(bare).map((step) => step.kind), 'a theme adds and removes no teardown step');
});

test('spec: app.theme asks for 2.21.0, is validated by the theme schema, and a download keeps a higher floor', () => {
  const spec = themed({ hidden: false, mainForms: false });
  spec.minimumPluginVersion = '2.13.0';
  assert.ok(appMembershipWarnings(spec).some((w) => /'2\.21\.0' or newer when using app\.theme/.test(w)));
  spec.minimumPluginVersion = '2.21.0';
  assert.ok(!appMembershipWarnings(spec).some((w) => /app\.theme/.test(w)));
  const invalid = themed({ hidden: false, mainForms: false });
  invalid.app.theme = { vibrancy: 500 };
  assert.ok(validateAppSpec(invalid).errors.some((e) => /theme/.test(e)), 'an invalid theme is refused before the build');
  assert.equal(setAppThemeFloor({ app: { theme: THEME } }).minimumPluginVersion, '2.21.0');
  assert.equal(setAppThemeFloor({ app: { theme: null }, minimumPluginVersion: '2.13.0' }).minimumPluginVersion, '2.21.0');
  assert.equal(setAppThemeFloor({ app: { theme: THEME } }, '2.30.0').minimumPluginVersion, '2.30.0');
  assert.equal(setAppThemeFloor({ app: {}, minimumPluginVersion: '2.13.0' }).minimumPluginVersion, '2.13.0', 'no theme, no floor');
});

test('the wiring loads the theme modules only for a spec that declares a theme (a separate process, so this file\'s own requires do not count)', () => {
  const { spawnSync } = require('node:child_process');
  const script = `
    const { inOwnFolder } = require('./helpers/own-app-folder.js');
    const { runSdkBuild } = require('../lib/sdk-build.js');
    const { membershipSpec, membershipSdk } = require('./helpers/app-membership-sdk.js');
    const { validateAppSpec, appMembershipWarnings } = require('../lib/app-spec.js');
    (async () => {
      const spec = membershipSpec();
      validateAppSpec(spec); appMembershipWarnings(spec);
      await inOwnFolder(runSdkBuild)(spec, { sdk: membershipSdk({ existing: true }).sdk, apply: true, phases: ['app-shell'] });
      const loaded = Object.keys(require.cache).filter((f) => /[\\\\/]lib[\\\\/]app-theme(-reads)?\\.js$/.test(f));
      process.stdout.write('\\nLOADED=' + JSON.stringify(loaded) + '\\n');
    })().catch((e) => { process.stderr.write(String(e && e.stack)); process.exit(1); });`;
  const run = spawnSync(process.execPath, ['-e', script], { cwd: __dirname, encoding: 'utf8', env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT: '1' } });
  assert.equal(run.status, 0, run.stderr);
  const line = run.stdout.split(/\r?\n/).find((l) => l.startsWith('LOADED='));
  assert.ok(line, run.stdout);
  assert.deepEqual(JSON.parse(line.slice('LOADED='.length)), []);
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'lib', 'app-theme.js')));
});
