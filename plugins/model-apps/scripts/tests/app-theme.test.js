'use strict';
// lib/app-theme.js with SDK doubles: validation, the comparison form, the refusals made before any read, the create
// port's answer shapes, how a failure is classified (refused only on no-write evidence, else unknown), download's capture
// and the build-level failure. The wire behaviour against the real bundle is pinned in app-theme-real-bundle.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateAppTheme, canonicalTheme, planAppTheme, applyAppTheme, captureAppTheme, appThemeDownloadOutcome, appThemeIncomplete, isComplete, KEY,
} = require('../lib/app-theme.js');
const { guardAppThemeReads, markThemeReadGuarded } = require('../lib/app-theme-reads.js');
const { RETRY } = require('../lib/retry-policy.js');

const APP = '11111111-1111-4111-8111-111111111111';
const DEF = '22222222-2222-4222-8222-222222222222';
const THEME = { basePaletteColor: '#0f6cbd', appHeader: { background: '#112233' }, logo: { webResourceName: 'contoso_/images/logo.svg', tooltip: 'Contoso' } };
const VERSION = 'contoso_/apptheme/0123456789abcdef.xml';

// After every set the stored theme is read back (proveStoredTheme): the version by name, then the app's setting row. This
// answers those reads with the version VERSION and one row holding it; any other read is a 404.
const ROW = '33333333-3333-4333-8333-333333333333';
function storedAnswer(path) {
  const url = decodeURIComponent(path);
  const rows = (value) => ({ status: 200, headers: {}, body: { value } });
  if (url.startsWith('/webresourceset?')) return rows([{ webresourceid: '44444444-4444-4444-8444-444444444444', name: VERSION, webresourcetype: 4 }]);
  if (url.startsWith('/settingdefinitions?')) return rows([{ settingdefinitionid: DEF, uniquename: 'CustomThemeDefinition', displayname: 'Custom theme definition' }]);
  if (url.startsWith('/appsettings/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?')) return rows([{ appsettingid: ROW, value: VERSION, componentstate: 1, _settingdefinitionid_value: DEF }]);
  if (url.startsWith('/appsettings?')) return rows([{ appsettingid: ROW, value: VERSION, _settingdefinitionid_value: DEF }]);
  return { status: 404, headers: {}, body: {} };
}

// An SDK double made over a guarded client, as a themeReads SDK is. `methods(client)` gives its theme methods; a write
// sent through `client` is counted by the policy like one the real SDK sends.
function guardedSdk(methods = () => ({})) {
  const client = {
    async get(path) { return storedAnswer(path); },
    async post() { return { status: 204, headers: {}, body: null }; },
  };
  const guard = guardAppThemeReads(client);
  const sdk = { dataverse: guard, ...methods(guard) };
  return markThemeReadGuarded(sdk, guard);
}

const setPlan = (extra = {}) => ({
  operations: [{ key: KEY, kind: 'appTheme', target: APP, action: 'set', destructive: false, publicationScopes: ['app'], preconditions: [] }],
  unknown: [], theme: THEME, settingDefinitionId: DEF, pendingPublish: false, ...extra,
});
const removePlan = () => ({ ...setPlan(), operations: [{ ...setPlan().operations[0], action: 'remove', destructive: true }] });

function ports() {
  const queued = [];
  const runs = [];
  return {
    queued, runs,
    publication: { queue: (entry) => { queued.push(entry); } },
    passthrough: { run: async (descriptor, write) => { runs.push(descriptor); const result = await write(); return { outcome: 'created', id: null, childIds: {}, ids: {}, result }; } },
    fence: { run: async (descriptor, write) => { runs.push(descriptor); const result = await write(); return { outcome: 'applied', id: null, childIds: {}, result, evidence: 'sdk-acknowledged' }; } },
  };
}
const saved = (extra = {}) => ({ appId: APP, outcome: 'created', webResource: { name: VERSION }, pendingPublish: true, ...extra });

test('validation: a closed JSON theme of known fields only; raw attributes, URLs and non-JSON values are refused', () => {
  assert.deepEqual(validateAppTheme(THEME).errors, []);
  assert.deepEqual(validateAppTheme(undefined).errors, []);
  assert.deepEqual(validateAppTheme(null).errors, []);
  assert.deepEqual(validateAppTheme(Object.assign(Object.create(null), { basePaletteColor: '#000000' })).errors, []);
  const refused = (theme, words) => assert.match(validateAppTheme(theme).errors.join(' | '), words, JSON.stringify(theme));
  refused({}, /names no theme field/);
  refused([], /must be an object/);
  refused({ basePaletteColor: '#000000', additionalAttributes: {} }, /raw theme attributes are not supported/);
  refused({ basePaletteColor: '#00000' }, /colour/);
  refused({ vibrancy: 101 }, /-100 to 100/);
  refused({ vibrancy: Infinity }, /finite number/);
  refused({ appHeader: { foreground: '#000000' } }, /appHeader.background is required/);
  refused({ appHeader: ['#000000'] }, /must not be a list/);
  refused({ palette: { notASlot: '#000000' } }, /not a theme field/);
  refused({ logo: { webResourceName: 'https://contoso.example.com/logo.svg' } }, /not a URL/);
  refused({ logo: { webResourceName: '//cdn.example.com/logo.svg' } }, /not a URL/);
  refused({ logo: { tooltip: 7 } }, /tooltip must be text/);
  refused({ logo: {} }, /needs webResourceName or tooltip/);
  refused({ font: new String('Segoe') }, /plain JSON/);
  refused({ basePaletteColor: '#000000', extra: () => 1 }, /plain JSON|not a theme field/);
});

test('the comparison form ignores key order, colour case and undefined fields', () => {
  assert.deepEqual(canonicalTheme({ logo: { tooltip: 'a', webResourceName: 'x' }, basePaletteColor: '#0f6cbd', font: undefined }),
    { basePaletteColor: '#0F6CBD', logo: { tooltip: 'a', webResourceName: 'x' } });
  assert.equal(JSON.stringify(canonicalTheme({ b: 1, a: 2 })), '{"a":2,"b":1}');
});

test('plan: nothing is read for an omitted theme, an invalid theme, an app that is not a GUID or an SDK without strict reads', async () => {
  const sdk = guardedSdk(() => ({ getAppTheme: async () => { throw new Error('read'); } }));
  assert.deepEqual(await planAppTheme({ app: {} }, { sdk, appId: APP }), { operations: [], unknown: [] });
  const invalid = await planAppTheme({ app: { theme: { vibrancy: 500 } } }, { sdk, appId: APP });
  assert.equal(invalid.refused[0].code, 'APP_THEME_INVALID');
  assert.equal((await planAppTheme({ app: { theme: THEME } }, { sdk, appId: 'contoso' })).refused[0].code, 'APP_THEME_PREREQUISITE_UNRESOLVED');
  const plain = { getAppTheme: async () => { throw new Error('read'); }, dataverse: { get: async () => { throw new Error('read'); } } };
  assert.deepEqual((await planAppTheme({ app: { theme: THEME } }, { sdk: plain, appId: APP })).unknown, [{ key: KEY, code: 'APP_THEME_READ_INCOMPLETE' }]);
});

test('apply: a set through a fence-shaped or a passthrough port is saved and owes the app\'s publication', async () => {
  for (const kind of ['fence', 'passthrough']) {
    const p = ports();
    let args;
    const sdk = guardedSdk(() => ({ setAppTheme: async (...a) => { args = a; return saved(); } }));
    const result = await applyAppTheme(setPlan(), { sdk, creates: p[kind], publication: p.publication, publisherPrefix: 'contoso' });
    assert.deepEqual(result, { saved: [KEY], unchanged: [], pendingPublish: [KEY], refused: [], unknown: [], managedBindings: [] }, kind);
    assert.deepEqual(args, [APP, THEME, { publish: false, publisherPrefix: 'contoso' }]);
    assert.deepEqual(p.runs, [{ kind: 'appTheme', key: KEY, identity: { appId: APP, settingDefinitionId: DEF }, childKeys: [] }]);
    assert.deepEqual(p.queued, [{ kind: 'app', id: APP, reason: KEY }]);
  }
});

test('apply: refused before any write without a publication port, a create port, a prefix or a definition id', async () => {
  const p = ports();
  let calls = 0;
  const sdk = () => guardedSdk(() => ({ setAppTheme: async () => { calls += 1; return saved(); } }));
  const code = async (plan, ctx) => (await applyAppTheme(plan, { sdk: sdk(), ...ctx })).refused.map((entry) => entry.code);
  assert.deepEqual(await code(setPlan(), { creates: p.fence, publisherPrefix: 'contoso' }), ['APP_THEME_PUBLISH_BLOCKED']);
  assert.deepEqual(await code(setPlan(), { publication: p.publication, publisherPrefix: 'contoso' }), ['APP_THEME_CREATE_PORT_UNAVAILABLE']);
  assert.deepEqual(await code(setPlan(), { creates: p.fence, publication: p.publication, publisherPrefix: ' ' }), ['APP_THEME_PREREQUISITE_UNRESOLVED']);
  assert.deepEqual(await code(setPlan({ settingDefinitionId: undefined }), { creates: p.fence, publication: p.publication, publisherPrefix: 'contoso' }), ['APP_THEME_PREREQUISITE_UNRESOLVED']);
  assert.equal(calls, 0);
  // A removal creates nothing, so it needs no create port.
  const removed = await applyAppTheme(removePlan(), { sdk: guardedSdk(() => ({ setAppTheme: async () => ({ appId: APP, outcome: 'removed', pendingPublish: true }) })), publication: p.publication });
  assert.deepEqual(removed.saved, [KEY]);
});

test('apply: an answer that is not a known success is unknown, and nothing more is done to that app\'s theme by the same SDK', async () => {
  const p = ports();
  const sdk = guardedSdk(() => ({ setAppTheme: async () => saved() }));
  const odd = { run: async (descriptor, write) => ({ outcome: 'skipped', result: await write() }) };
  const ctx = { sdk, creates: odd, publication: p.publication, publisherPrefix: 'contoso' };
  assert.deepEqual((await applyAppTheme(setPlan(), ctx)).unknown, [{ key: KEY, code: 'APP_THEME_NOT_SAVED' }]);
  assert.deepEqual((await applyAppTheme(removePlan(), ctx)).unknown, [{ key: KEY, code: 'create-outcome-unknown' }]);
  assert.deepEqual((await planAppTheme({ app: { theme: null } }, { ...ctx, appId: APP })).unknown, [{ key: KEY, code: 'create-outcome-unknown' }]);
});

test('apply: a create port stop is passed on as it is, carrying the theme result', async () => {
  const p = ports();
  const stop = Object.assign(new Error('stopped'), { code: 'create-outcome-unknown' });
  const sdk = guardedSdk(() => ({ setAppTheme: async () => saved() }));
  const creates = { run: async () => { throw stop; } };
  const error = await applyAppTheme(setPlan(), { sdk, creates, publication: p.publication, publisherPrefix: 'contoso' }).catch((e) => e);
  assert.equal(error, stop);
  assert.deepEqual(error.appTheme.unknown, [{ key: KEY, code: 'create-outcome-unknown' }]);
  // A saved set whose answer names no version stops as completion-required, keeping what was saved.
  const missing = guardedSdk(() => ({ setAppTheme: async () => saved({ webResource: undefined }) }));
  const completion = await applyAppTheme(setPlan(), { sdk: missing, creates: p.fence, publication: p.publication, publisherPrefix: 'contoso' }).catch((e) => e);
  assert.equal(completion.code, 'create-completion-required');
  assert.deepEqual(completion.appTheme.saved, [KEY]);
});

test('apply: a failure is refused only with no write sent; after a write it is unknown; codes never carry words', async () => {
  const p = ports();
  const run = async (setAppTheme) => applyAppTheme(setPlan(), { sdk: guardedSdk((client) => ({ setAppTheme: () => setAppTheme(client) })), creates: p.fence, publication: p.publication, publisherPrefix: 'contoso' });
  assert.deepEqual((await run(async () => { throw Object.assign(new Error('x'), { code: 'PUBLISHER_NOT_FOUND' }); })).refused, [{ key: KEY, code: 'PUBLISHER_NOT_FOUND' }]);
  assert.deepEqual((await run(async () => { throw Object.assign(new Error('x'), { code: 'see https://contoso.example.com' }); })).refused, [{ key: KEY, code: 'APP_THEME_FAILED' }]);
  assert.deepEqual((await run(async () => { throw Object.assign(new Error('x'), { name: 'ValidationError' }); })).refused, [{ key: KEY, code: 'VALIDATION_ERROR' }]);
  const afterWrite = await run(async (client) => { await client.post('https://contoso.crm.dynamics.com/api/data/v9.2/webresourceset', {}); throw Object.assign(new Error('x'), { code: 'CONFLICT' }); });
  assert.deepEqual(afterWrite.refused, []);
  assert.deepEqual(afterWrite.unknown, [{ key: KEY, code: 'CONFLICT', afterWrite: true }]);
});

test('apply: an equal theme saved but unpublished is unchanged and still owes the publication; a failing queue is unknown', async () => {
  const p = ports();
  const noChange = { ...setPlan({ pendingPublish: true }), operations: [{ ...setPlan().operations[0], action: 'noChange' }] };
  const result = await applyAppTheme(noChange, { sdk: guardedSdk(), publication: p.publication });
  assert.deepEqual([result.unchanged, result.pendingPublish, p.queued.length], [[KEY], [KEY], 1]);
  const failing = await applyAppTheme(noChange, { sdk: guardedSdk(), publication: { queue: () => { throw Object.assign(new Error('x'), { code: 'PUBLISH_WITHHELD' }); } } });
  assert.deepEqual(failing.unknown, [{ key: KEY, code: 'PUBLISH_WITHHELD' }]);
  assert.equal(isComplete(failing), false);
  assert.equal(isComplete(null), true);
});

test('capture: the app\'s own exact theme is captured; absence, inherited, sentinel and inexact rows are not invented', () => {
  const row = (state, latestValue = VERSION) => ({ state, latestValue });
  const own = { source: 'app', exact: true, theme: { basePaletteColor: '#0f6cbd' } };
  assert.deepEqual(captureAppTheme({ row: row('absent'), afterPublish: { source: 'environment' } }), { status: 'omitted' });
  assert.deepEqual(captureAppTheme({ row: row('removalPending') }), { status: 'captured', theme: null, pendingPublish: true });
  assert.deepEqual(captureAppTheme({ row: row('draft'), afterPublish: own, pendingPublish: true }), { status: 'captured', theme: { basePaletteColor: '#0F6CBD' }, pendingPublish: true });
  assert.deepEqual(captureAppTheme({ row: row('published', '""'), afterPublish: { source: 'none' } }), { status: 'refused', code: 'APP_THEME_UNREPRESENTABLE' });
  assert.deepEqual(captureAppTheme({ row: row('published'), afterPublish: { ...own, exact: undefined } }), { status: 'refused', code: 'APP_THEME_UNREPRESENTABLE' });
  assert.deepEqual(captureAppTheme({ row: row('published'), afterPublish: { ...own, theme: { basePaletteColor: '#0f6cbd', additionalAttributes: {} } } }), { status: 'refused', code: 'APP_THEME_UNREPRESENTABLE' });
  assert.deepEqual(captureAppTheme({ row: row('published'), afterPublish: { source: 'unknown' } }), { status: 'refused', code: 'APP_THEME_READ_INCOMPLETE' });
  assert.deepEqual(captureAppTheme(null), { status: 'refused', code: 'APP_THEME_READ_INCOMPLETE' });
});

test('download outcome: a strict download refuses before output; --allow-lossy-download leaves the field out and names the loss', () => {
  const theme = { basePaletteColor: '#0F6CBD', logo: { webResourceName: 'contoso_/images/logo.svg' } };
  const logo = { webResourceName: 'contoso_/images/logo.svg', webResourceType: 11 };
  assert.deepEqual(appThemeDownloadOutcome({ status: 'captured', theme, pendingPublish: false, logo }),
    { write: true, theme, pendingPublish: false, logo: { ...logo, external: true } }, 'the logo is exported as an external binary, never owned');
  assert.deepEqual(appThemeDownloadOutcome({ status: 'captured', theme: null, pendingPublish: true }), { write: true, theme: null, pendingPublish: true });
  for (const allowLossy of [false, true]) assert.deepEqual(appThemeDownloadOutcome({ status: 'omitted' }, { allowLossy }), { write: false });
  for (const code of ['APP_THEME_UNREPRESENTABLE', 'APP_THEME_LOGO_UNAVAILABLE', 'APP_THEME_LOGO_INVALID', 'APP_THEME_READ_INCOMPLETE']) {
    const strict = appThemeDownloadOutcome({ status: 'refused', code });
    assert.equal(strict.write, false);
    assert.equal(strict.warning, undefined);
    assert.match(strict.error, new RegExp(`${code}.*--allow-lossy-download`));
    const lossy = appThemeDownloadOutcome({ status: 'refused', code }, { allowLossy: true });
    assert.equal(lossy.write, false);
    assert.equal(lossy.error, undefined);
    assert.match(lossy.warning, new RegExp(`LEFT OUT \\(${code}\\)`));
  }
  // A code that could carry words is never echoed.
  assert.match(appThemeDownloadOutcome({ status: 'refused', code: 'https://x y' }).error, /APP_THEME_FAILED/);
});

test('the build-level failure carries the result and is never retried', () => {
  const result = { saved: [KEY], unchanged: [], pendingPublish: [], refused: [], unknown: [{ key: KEY, code: 'APP_THEME_READ_INCOMPLETE', afterWrite: true }], managedBindings: [] };
  const error = appThemeIncomplete(result);
  assert.equal(error.code, 'APP_THEME_INCOMPLETE');
  assert.equal(error.recoverable, false);
  assert.equal(error.transient, false);
  assert.equal(error.retry, RETRY.NEVER);
  assert.equal(error.appTheme, result);
  assert.match(error.message, /APP_THEME_READ_INCOMPLETE.*What was saved is kept/);
});
