'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runSdkBuild, appDef } = require('../lib/sdk-build.js');
const { membershipSpec, membershipSdk, FORM_A, FORM_B, DASHBOARD, META, APP } = require('./helpers/app-membership-sdk.js');

test('appDef carries resolved Main ids and excludes the conflicting created Main pin by id', () => {
  const result = { forms: { contoso_item: FORM_B, contact: DASHBOARD }, views: {}, charts: {} };
  const definition = appDef(membershipSpec(), result, { mainFormsByTable: { contoso_item: [FORM_A] } });
  assert.deepEqual(definition.components.mainFormsByTable, { contoso_item: [FORM_A] });
  assert.deepEqual(definition.components.forms, [DASHBOARD]);
  result.forms.contoso_item = FORM_A;
  assert.deepEqual(appDef(membershipSpec(), result, { mainFormsByTable: { contoso_item: [FORM_A] } }).components.forms, [FORM_A, DASHBOARD]);
});

for (const publish of [false, true]) {
  test(`fresh create pins after identity and republishes its new layer (publish=${publish})`, async () => {
    const fake = membershipSdk();
    const result = await runSdkBuild(membershipSpec(), { sdk: fake.sdk, apply: true, phases: ['app-shell', 'publish'], publish });
    assert.equal(result.created.app, APP);
    assert.deepEqual(fake.pushes[0].components.mainFormsByTable, { contoso_item: [FORM_A] });
    const firstPush = fake.events.findIndex(([event]) => event === 'push');
    const pin = fake.events.findIndex(([event, action]) => event === 'post' && action === '/AddAppComponents');
    const republish = fake.events.findIndex(([event, action]) => event === 'post' && action === '/PublishXml');
    assert.ok(pin > firstPush, JSON.stringify(fake.events));
    assert.ok(republish > pin, 'a fresh create already published before pinning; its hidden tables must not be left pending');
    assert.equal(fake.pending, false);
    assert.equal(fake.events.filter(([event, url]) => event === 'get' && url.includes("objecttypecode eq 'contoso_item'")).length, 1,
      'resolve the directive once per run, even across a fetch and finalizer push');
    assert.ok(fake.tableIds.includes(META.task));
  });
}

test('omitted membership directives cost no component reads or extra publish', async () => {
  const fake = membershipSdk();
  await runSdkBuild(membershipSpec({ hidden: false, mainForms: false }), { sdk: fake.sdk, apply: true, phases: ['app-shell'] });
  assert.ok(!fake.events.some(([event]) => event === 'get' || event === 'post'));
  assert.equal(fake.pushes[0].components.mainFormsByTable, undefined);
});

test('a navigation table redundantly listed in app.tables is proven without another pin or publish', async () => {
  const fake = membershipSdk();
  const spec = membershipSpec({ mainForms: false });
  spec.app.tables = ['CONTOSO_ITEM'];
  await runSdkBuild(spec, { sdk: fake.sdk, apply: true, phases: ['app-shell'] });
  assert.ok(!fake.events.some(([event]) => event === 'post'));
});

test('unresolved hidden tables and Main names halt before creating or pushing the app', async () => {
  for (const fake of [membershipSdk({ malformedTable: true }), membershipSdk({ forms: [] })]) {
    await assert.rejects(runSdkBuild(membershipSpec(), { sdk: fake.sdk, apply: true, phases: ['app-shell'] }), /task|Summary/);
    assert.ok(!fake.events.some(([event]) => event === 'create' || event === 'push' || event === 'post'));
  }
});

test('a pin proof failure halts rather than reporting a completed app', async () => {
  const fake = membershipSdk({ dropPin: true });
  await assert.rejects(runSdkBuild(membershipSpec(), { sdk: fake.sdk, apply: true, phases: ['app-shell'] }), /task.*missing/i);
});

// componenttype 80 is appmodule, 62 sitemap:
// https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/solutioncomponent
const APP_MODULE = 80;
const SITEMAP_COMPONENT = 62;

test('a fresh app joins its solution before the hidden-table pin can fail', async () => {
  const fake = membershipSdk({ dropPin: true });
  const joins = [];
  fake.sdk.addSolutionComponent = async (o) => { joins.push(o.componentType); fake.events.push(['join', o.componentType, o.componentId]); };
  await assert.rejects(runSdkBuild(membershipSpec(), { sdk: fake.sdk, apply: true, phases: ['app-shell'] }), /task.*missing/i);
  const join = fake.events.findIndex(([event, type, id]) => event === 'join' && type === APP_MODULE && id === APP);
  const pin = fake.events.findIndex(([event, action]) => event === 'post' && action === '/AddAppComponents');
  assert.ok(join >= 0 && join < pin, `the app module joined before the pin: ${JSON.stringify(fake.events)}`);
  assert.ok(joins.includes(SITEMAP_COMPONENT), 'and its sitemap with it');
});

test('a re-run that reuses the app re-asserts its solution membership', async () => {
  const fake = membershipSdk({ existing: true });
  const joins = [];
  fake.sdk.addSolutionComponent = async (o) => { joins.push([o.componentType, o.componentId, o.solutionUniqueName]); };
  await runSdkBuild(membershipSpec(), { sdk: fake.sdk, apply: true, phases: ['app-shell'] });
  const sol = membershipSpec().solution.uniqueName;
  assert.ok(joins.some(([type, id, s]) => type === APP_MODULE && id === APP && s === sol), JSON.stringify(joins));
});

test('existing page-less app-shell push re-supplies the map after fetch and preserves other components', async () => {
  const fake = membershipSdk({ existing: true });
  const get = fake.sdk.getArtifact;
  let initial = true;
  fake.sdk.getArtifact = async (...args) => {
    const art = await get(...args);
    if (initial) {
      initial = false;
      await fake.sdk.addElement('app', APP, '', { components: { forms: [FORM_B, DASHBOARD], views: ['view-kept'], charts: ['chart-kept'], dashboards: [DASHBOARD] } });
      return await fake.sdk.getArtifact(...args);
    }
    return art;
  };
  await runSdkBuild(membershipSpec({ aiDescription: 'New routing' }), { sdk: fake.sdk, apply: true, phases: ['app-shell'] });
  assert.deepEqual(fake.pushes[0].components.mainFormsByTable, { contoso_item: [FORM_A] });
  assert.deepEqual(fake.pushes[0].components.forms, [DASHBOARD], 'filter Main ids, not same-named dashboard/QuickView components');
  assert.deepEqual(fake.pushes[0].components.views, ['view-kept']);
  assert.deepEqual(fake.pushes[0].components.charts, ['chart-kept']);
  const pin = fake.events.findIndex(([event, action]) => event === 'post' && action === '/AddAppComponents');
  const push = fake.events.findIndex(([event]) => event === 'push');
  const pub = fake.events.findIndex(([event]) => event === 'publish');
  assert.ok(pin >= 0 && pin < push && push < pub, JSON.stringify(fake.events));
});

test('existing page-backed routing-description push re-supplies the allow-list without rewriting navigation', async () => {
  const fake = membershipSdk({ existing: true, page: true });
  await runSdkBuild(membershipSpec({ page: true, aiDescription: 'New routing' }), { sdk: fake.sdk, apply: true, phases: ['app-shell'] });
  assert.equal(fake.pushes.length, 1);
  assert.deepEqual(fake.pushes[0].components.mainFormsByTable, { contoso_item: [FORM_A] });
  assert.ok(fake.pushes[0].siteMap.areas[0].groups[0].subAreas.some((sub) => sub.type === 'GenPage'));
  assert.equal(fake.pending, false);
});

for (const publish of [false, true]) {
  test(`existing app pins independently of app-shell push and finalizer keeps the directive (publish=${publish})`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-membership-build-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const fake = membershipSdk({ existing: true });
    await runSdkBuild(membershipSpec(), {
      sdk: fake.sdk, apply: true, phases: ['app-shell', 'pages', 'publish'], publish, appDir: dir,
      genpageCli: { enumerateEnv: async () => ({ ok: true, ids: [], pages: [] }) },
    });
    assert.equal(fake.pushes.length, 1, 'existing-app app-shell defers its push to the pages finalizer');
    assert.deepEqual(fake.pushes[0].components.mainFormsByTable, { contoso_item: [FORM_A] });
    const pin = fake.events.findIndex(([event, action]) => event === 'post' && action === '/AddAppComponents');
    const push = fake.events.findIndex(([event]) => event === 'push');
    assert.ok(pin >= 0 && pin < push, JSON.stringify(fake.events));
    assert.equal(fake.pending, false);
  });
}

test('SDK additive-membership warnings name the extra Main forms and the Maker remedy', async () => {
  const warnings = [];
  const fake = membershipSdk({
    existing: true,
    warnings: [`Main-form components outside the allow-list remain for table 'contoso_item': [${FORM_B}]. This option controls additions only; it does not remove existing components. Runtime form availability has not been verified.`],
  });
  await runSdkBuild(membershipSpec({ hidden: false }), { sdk: fake.sdk, apply: true, phases: ['app-shell'], warn: (line) => warnings.push(line) });
  assert.ok(warnings.some((line) => /already offers Main form.*Alternate.*contoso_item/.test(line)), warnings.join('; '));
  assert.ok(warnings.some((line) => /cannot remove.*Maker.*Forms/.test(line)), warnings.join('; '));
});
