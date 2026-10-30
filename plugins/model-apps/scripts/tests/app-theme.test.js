'use strict';

// app.theme (Preview): validation, plan, apply and verify against an SDK double. The build never lets the SDK publish
// the theme itself; what is owed goes to the publication port.

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateAppTheme, planAppTheme, applyAppTheme, verifyAppTheme, canonicalTheme } = require('../lib/app-theme.js');
const { createAppPublication } = require('../lib/app-publication-policy.js');

const APP = '11111111-0000-4000-8000-000000000001';
const THEME = { basePaletteColor: '#0f6cbd', appHeader: { background: '#112233', foreground: '#FFFFFF' }, logo: { webResourceName: 'contoso_/images/logo.svg', tooltip: 'Contoso' } };

function sdkDouble({ afterPublish = { source: 'environment' }, resolved, pendingPublish = false, set, readError, row = { state: 'absent' } } = {}) {
  const calls = [];
  return {
    calls,
    getAppTheme: async (appId) => {
      calls.push(['getAppTheme', appId]);
      if (readError) throw readError;
      return { resolved: resolved || afterPublish, afterPublish, row, pendingPublish, pendingReasons: pendingPublish ? ['setting'] : [] };
    },
    setAppTheme: async (appId, theme, options) => {
      calls.push(['setAppTheme', appId, theme, options]);
      if (typeof set === 'function') return set();
      return set || { outcome: 'saved', webResource: { id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'contoso_theme_v1', created: true }, pendingPublish: true };
    },
  };
}

// The build's create port, as the theme sees it: it runs the setter and answers { outcome, result }.
const passThrough = () => ({ runs: [], async run(descriptor, execute) { this.runs.push(descriptor); return { outcome: 'created', result: await execute() }; } });

function context(sdk, { creates = passThrough() } = {}) {
  const published = [];
  const publication = createAppPublication({ appWrite: { publish: async (id) => { published.push(id); return { publish: { kind: 'submitted' } }; } } });
  return { ctx: { sdk, appId: APP, publication, ...(creates ? { creates } : {}) }, published, publication };
}

const spec = (theme) => ({ app: theme === undefined ? {} : { theme } });

test('validate: accepts a full theme, refuses raw attributes, bad colours, URLs and empty objects', () => {
  assert.deepEqual(validateAppTheme(THEME).errors, []);
  assert.deepEqual(validateAppTheme(undefined).errors, []);
  assert.deepEqual(validateAppTheme(null).errors, []);
  const cases = [
    [{ additionalAttributes: { x: 1 } }, /raw theme attributes are not supported/],
    [{ basePaletteColor: 'blue' }, /basePaletteColor must be a colour/],
    [{ basePaletteColor: '#0F6CBD', palette: { notASlot: '#000000' } }, /palette\.notASlot is not a theme field/],
    [{ appHeader: { foreground: '#000000' } }, /appHeader\.background is required/],
    [{ logo: { webResourceName: 'https://contoso.example/logo.svg' } }, /not a URL/],
    [{ logo: { webResourceName: '//contoso.example/logo.svg' } }, /not a URL/],
    [{ vibrancy: 101 }, /from -100 to 100/],
    [{}, /names no theme field/],
    [[], /must be an object/],
  ];
  for (const [theme, pattern] of cases) assert.match(validateAppTheme(theme).errors.join('\n'), pattern, JSON.stringify(theme));
});

test('omitted: no operation and not one SDK call, in plan, apply and verify', async () => {
  const sdk = sdkDouble();
  const { ctx } = context(sdk);
  const plan = await planAppTheme(spec(undefined), ctx);
  assert.deepEqual(plan, { operations: [], unknown: [] });
  assert.deepEqual(await applyAppTheme(plan, ctx), { saved: [], unchanged: [], pendingPublish: [], refused: [], unknown: [], managedBindings: [] });
  assert.deepEqual(await verifyAppTheme(spec(undefined), ctx), []);
  assert.deepEqual(sdk.calls, []);
});

test('an invalid theme is refused before any SDK call, even when the lint was skipped', async () => {
  const sdk = sdkDouble();
  const { ctx } = context(sdk);
  const plan = await planAppTheme(spec({ basePaletteColor: '#0F6CBD', additionalAttributes: {} }), ctx);
  const result = await applyAppTheme(plan, ctx);
  assert.deepEqual(result.refused, [{ key: 'app.theme', code: 'APP_THEME_INVALID' }]);
  assert.deepEqual(sdk.calls, []);
});

test('set: always publish:false, the app is queued on the port, the new version is a created binding, and only the port publishes', async () => {
  const sdk = sdkDouble();
  const { ctx, published, publication } = context(sdk);
  const plan = await planAppTheme(spec(THEME), ctx);
  assert.equal(plan.operations[0].action, 'set');
  assert.equal(plan.operations[0].destructive, false);
  const result = await applyAppTheme(plan, ctx);
  assert.deepEqual(result.saved, ['app.theme']);
  assert.deepEqual(result.pendingPublish, ['app.theme']);
  assert.deepEqual(result.managedBindings, [{ kind: 'webResource', key: 'app.theme', id: 'aaaaaaaa-0000-4000-8000-000000000001', origin: 'created' }]);
  const writes = sdk.calls.filter(([name]) => name === 'setAppTheme');
  assert.deepEqual(writes, [['setAppTheme', APP, THEME, { publish: false }]]);
  assert.deepEqual(published, [], 'apply publishes nothing');
  assert.deepEqual(publication.owed(), [{ kind: 'app', id: APP, reasons: ['app.theme'] }]);
  assert.deepEqual(await publication.flush(), { published: [APP], withheld: [], failed: [] });
  assert.deepEqual(published, [APP]);
});

test('null removes the app theme through setAppTheme(null, publish:false) and is marked destructive', async () => {
  const sdk = sdkDouble({ afterPublish: { source: 'app', theme: canonicalTheme(THEME), exact: true }, row: { state: 'published' }, set: { outcome: 'removed', pendingPublish: true } });
  const { ctx } = context(sdk);
  const plan = await planAppTheme(spec(null), ctx);
  assert.equal(plan.operations[0].action, 'remove');
  assert.equal(plan.operations[0].destructive, true);
  const result = await applyAppTheme(plan, ctx);
  assert.deepEqual(sdk.calls.filter(([name]) => name === 'setAppTheme'), [['setAppTheme', APP, null, { publish: false }]]);
  assert.deepEqual(result.saved, ['app.theme']);
  assert.deepEqual(result.managedBindings, []);
});

test('noChange: the theme the app will show already matches (case and key order aside); a pending one is still queued', async () => {
  const stored = { logo: { tooltip: 'Contoso', webResourceName: 'contoso_/images/logo.svg' }, appHeader: { foreground: '#ffffff', background: '#112233' }, basePaletteColor: '#0F6CBD' };
  for (const pendingPublish of [false, true]) {
    const sdk = sdkDouble({ afterPublish: { source: 'app', theme: stored, exact: true }, pendingPublish });
    const { ctx, publication } = context(sdk);
    const plan = await planAppTheme(spec(THEME), ctx);
    assert.equal(plan.operations[0].action, 'noChange');
    const result = await applyAppTheme(plan, ctx);
    assert.deepEqual(result.unchanged, ['app.theme']);
    assert.equal(sdk.calls.some(([name]) => name === 'setAppTheme'), false);
    assert.equal(publication.owed().length, pendingPublish ? 1 : 0);
  }
  const inexact = sdkDouble({ afterPublish: { source: 'app', theme: stored, exact: false } });
  assert.equal((await planAppTheme(spec(THEME), context(inexact).ctx)).operations[0].action, 'set', 'a version it could not read back is never equal');
  const env = sdkDouble({ afterPublish: { source: 'environment' } });
  assert.equal((await planAppTheme(spec(null), context(env).ctx)).operations[0].action, 'noChange', 'null with no app theme is nothing to do');
});

test('a failed read plans nothing (unknown); a pre-write SDK refusal is refused, anything else is unknown', async () => {
  const unreadable = sdkDouble({ readError: Object.assign(new Error('x'), { code: 'NETWORK' }) });
  const { ctx } = context(unreadable);
  const plan = await planAppTheme(spec(THEME), ctx);
  assert.deepEqual(plan, { operations: [], unknown: [{ key: 'app.theme', code: 'NETWORK' }] });
  assert.deepEqual((await applyAppTheme(plan, ctx)).unknown, [{ key: 'app.theme', code: 'NETWORK' }]);
  assert.equal(unreadable.calls.some(([name]) => name === 'setAppTheme'), false);

  for (const [error, bucket] of [
    [Object.assign(new Error('x'), { code: 'APP_THEME_LOGO_INVALID' }), 'refused'],
    [Object.assign(new Error('x'), { name: 'ValidationError' }), 'refused'],
    [Object.assign(new Error('x'), { code: 'HTTP_500' }), 'unknown'],
    [new Error('socket hang up'), 'unknown'],
  ]) {
    const sdk = sdkDouble({ set: () => { throw error; } });
    const c = context(sdk);
    const result = await applyAppTheme(await planAppTheme(spec(THEME), c.ctx), c.ctx);
    assert.equal(result[bucket].length, 1, `${error.code || error.name || error.message} -> ${bucket}`);
    assert.deepEqual(result.saved, []);
    assert.deepEqual(c.publication.owed(), [], 'nothing is queued for a theme that may not have been written');
    assert.ok(!JSON.stringify(result).includes('socket hang up'), 'no raw error text in the result');
  }
});

test('the write goes through creates.run with the content hash as identity when the build provides it', async () => {
  const sdk = sdkDouble();
  const { ctx } = context(sdk);
  const runs = [];
  ctx.creates = { run: async (descriptor, execute) => { runs.push(descriptor); return execute(); } };
  await applyAppTheme(await planAppTheme(spec(THEME), ctx), ctx);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].kind, 'appTheme');
  assert.equal(runs[0].identity.appId, APP);
  assert.match(runs[0].identity.sha256, /^[0-9a-f]{64}$/);
  const again = [];
  ctx.creates.run = async (descriptor, execute) => { again.push(descriptor); return execute(); };
  await applyAppTheme(await planAppTheme(spec({ ...THEME, basePaletteColor: '#0F6CBD' }), ctx), ctx);
  assert.equal(again[0].identity.sha256, runs[0].identity.sha256, 'colour case does not change the identity');
});

test('verify: live only when the app shows it now and nothing is pending; pending and differs are reported as such', async () => {
  const stored = { source: 'app', theme: THEME, exact: true };
  const check = async (options, theme = THEME) => (await verifyAppTheme(spec(theme), context(sdkDouble(options)).ctx))[0];
  assert.deepEqual(await check({ afterPublish: stored }), { key: 'app.theme', ok: true, state: 'live' });
  assert.equal((await check({ afterPublish: stored, pendingPublish: true })).state, 'pendingPublish');
  assert.equal((await check({ afterPublish: { source: 'environment' } })).state, 'differs');
  assert.equal((await check({ afterPublish: { source: 'unknown' } })).ok, false);
  assert.equal((await check({ readError: Object.assign(new Error('x'), { code: 'NETWORK' }) })).state, 'unknown');
  assert.deepEqual(await check({ afterPublish: { source: 'environment' } }, null), { key: 'app.theme', ok: true, state: 'live' });
});

test('a theme cannot publish around an exact Main-form obligation: its publication waits on the SDK writer, which withholds it', async () => {
  const sdk = sdkDouble();
  const withheld = Object.assign(new Error('withheld'), { code: 'APP_MAIN_FORM_PUBLISH_WITHHELD' });
  const publication = createAppPublication({ appWrite: { publish: async () => { throw withheld; } } });
  publication.recordExact(APP, { appMainForms: { mode: 'exact', tables: [{ table: 'contoso_item', membership: 'exact' }], published: 'notRead' } });
  const ctx = { sdk, appId: APP, publication, creates: passThrough() };
  await applyAppTheme(await planAppTheme(spec(THEME), ctx), ctx);
  assert.deepEqual(sdk.calls.filter(([name]) => name === 'setAppTheme').map((call) => call[3]), [{ publish: false }]);
  assert.throws(() => publication.assertRawPublishAllowed(APP), { code: 'APP_PUBLISH_BYPASS_REFUSED' });
  assert.deepEqual(await publication.flush(), { published: [], withheld: [{ id: APP, code: 'APP_MAIN_FORM_PUBLISH_WITHHELD' }], failed: [] });
  assert.equal(publication.owed().length, 1, 'the theme stays owed');
  assert.equal(publication.unsettled().length, 1, 'and the build stays nonzero');
});
test('null is decided from the app\'s own row: a published or draft row (even the "no theme" sentinel) is removed; an absent or removal-pending row is not', async () => {
  for (const [state, action] of [['published', 'remove'], ['publishedWithDraft', 'remove'], ['draft', 'remove'], ['absent', 'noChange'], ['removalPending', 'noChange']]) {
    // The sentinel row resolves to no theme at all, which is what made it look already removed.
    const sdk = sdkDouble({ afterPublish: { source: 'none' }, resolved: { source: 'none' }, row: { state, latestValue: '""' }, pendingPublish: state === 'removalPending' });
    const { ctx, publication } = context(sdk);
    const plan = await planAppTheme(spec(null), ctx);
    assert.equal(plan.operations[0].action, action, state);
    await applyAppTheme(plan, ctx);
    assert.equal(sdk.calls.filter(([name]) => name === 'setAppTheme').length, action === 'remove' ? 1 : 0, state);
    if (state === 'removalPending') assert.equal(publication.owed().length, 1, 'a pending removal is still owed to the app publish');
  }
  const check = async (options) => (await verifyAppTheme(spec(null), context(sdkDouble(options)).ctx))[0];
  assert.equal((await check({ afterPublish: { source: 'none' }, row: { state: 'published', latestValue: '""' } })).state, 'differs', 'the sentinel row still overrides the environment');
  assert.equal((await check({ afterPublish: { source: 'environment' }, row: { state: 'removalPending' }, pendingPublish: true })).state, 'pendingPublish');
  assert.deepEqual(await check({ afterPublish: { source: 'environment' }, row: { state: 'absent' } }), { key: 'app.theme', ok: true, state: 'live' });
  assert.equal((await check({ afterPublish: { source: 'environment' }, resolved: { source: 'app' }, row: { state: 'absent' } })).ok, false, 'still showing the app theme');
});

test('a set without the build\'s create port is refused before any write; a removal, which creates nothing, does not need it', async () => {
  const sdk = sdkDouble();
  const { ctx, publication } = context(sdk, { creates: null });
  const result = await applyAppTheme(await planAppTheme(spec(THEME), ctx), ctx);
  assert.deepEqual(result.refused, [{ key: 'app.theme', code: 'APP_THEME_CREATE_PORT_UNAVAILABLE' }]);
  assert.deepEqual(result.saved, []);
  assert.equal(sdk.calls.some(([name]) => name === 'setAppTheme'), false);
  assert.deepEqual(publication.owed(), []);
  const removal = sdkDouble({ row: { state: 'published' }, set: { outcome: 'removed', pendingPublish: true } });
  const c = context(removal, { creates: null });
  assert.deepEqual((await applyAppTheme(await planAppTheme(spec(null), c.ctx), c.ctx)).saved, ['app.theme']);
});

test('the create port\'s answer: unknown and refused write nothing more and queue nothing; adopted is read back; the descriptor names server-assigned children', async () => {
  const answers = [
    [{ outcome: 'unknown', result: undefined }, 'unknown', 'APP_THEME_CREATE_UNKNOWN'],
    [{ outcome: 'unknown', code: 'CREATE_OUTCOME_UNKNOWN', result: undefined }, 'unknown', 'CREATE_OUTCOME_UNKNOWN'],
    [{ outcome: 'refused', code: 'CREATES_POISONED', result: undefined }, 'refused', 'CREATES_POISONED'],
  ];
  for (const [answer, bucket, code] of answers) {
    const sdk = sdkDouble();
    const { ctx, publication } = context(sdk, { creates: { run: async () => answer } });
    const result = await applyAppTheme(await planAppTheme(spec(THEME), ctx), ctx);
    assert.deepEqual(result[bucket], [{ key: 'app.theme', code }]);
    assert.deepEqual(result.saved, []);
    assert.deepEqual(publication.owed(), []);
  }
  const adopted = sdkDouble({ afterPublish: { source: 'environment' } });
  let reads = 0;
  const realRead = adopted.getAppTheme;
  adopted.getAppTheme = async (appId) => { reads += 1; return reads === 1 ? realRead(appId) : { afterPublish: { source: 'app', theme: THEME, exact: true }, row: { state: 'draft' }, pendingPublish: true }; };
  const c = context(adopted, { creates: { run: async () => ({ outcome: 'adopted', result: undefined }) } });
  const result = await applyAppTheme(await planAppTheme(spec(THEME), c.ctx), c.ctx);
  assert.deepEqual(result.unchanged, ['app.theme']);
  assert.deepEqual(c.publication.owed().map((entry) => entry.id), [APP], 'the adopted theme is still owed its publication');

  const port = passThrough();
  const d = context(sdkDouble(), { creates: port });
  await applyAppTheme(await planAppTheme(spec(THEME), d.ctx), d.ctx);
  const [descriptor] = port.runs;
  assert.deepEqual(descriptor.childKeys, ['webResource', 'appSetting']);
  assert.equal(descriptor.serverAssigned, true);
  assert.equal(descriptor.identity.setting, 'CustomThemeDefinition');
  assert.deepEqual(descriptor.receipt({ webResource: { id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'contoso_/apptheme/0123456789abcdef.xml' } }),
    { id: null, childIds: {}, reused: { webResource: 'aaaaaaaa-0000-4000-8000-000000000001' }, versionName: 'contoso_/apptheme/0123456789abcdef.xml' },
    'a version the setter did not create is never ownership');
  assert.deepEqual(descriptor.receipt({ outcome: 'created', webResource: { id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'v', created: true }, appSetting: { id: 'bbbbbbbb-0000-4000-8000-000000000002', created: true } }),
    { id: 'bbbbbbbb-0000-4000-8000-000000000002', childIds: { webResource: 'aaaaaaaa-0000-4000-8000-000000000001', appSetting: 'bbbbbbbb-0000-4000-8000-000000000002' }, reused: {}, versionName: 'v' });
  assert.deepEqual(descriptor.receipt({ outcome: 'updated', webResource: { id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'v', created: true } }),
    { id: 'aaaaaaaa-0000-4000-8000-000000000001', childIds: { webResource: 'aaaaaaaa-0000-4000-8000-000000000001' }, reused: {}, versionName: 'v' }, 'an updated row is not a create');
});
