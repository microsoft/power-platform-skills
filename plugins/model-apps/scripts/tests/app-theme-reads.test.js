'use strict';
// lib/app-theme-reads.js: the strict read policy the theme helper runs its SDK reads under. A fake transport answers the
// exact read shapes the SDK's theme code sends (full URLs, the query percent-encoded once); each test pins what the
// policy concludes from one answer: placed and passed on, or APP_THEME_READ_INCOMPLETE with nothing concluded.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  guardAppThemeReads, markThemeReadGuarded, isThemeReadGuarded, assertThemeReadGuard, withThemeReadScope, isReadIncomplete,
  assertThemeIdentityConstraint, readThemeSettingIdentity, READ_INCOMPLETE, IDENTITY_UNPROVEN, MAX_PAGES, KEY_ATTRIBUTES,
} = require('../lib/app-theme-reads.js');

const ROOT = 'https://contoso.crm.dynamics.com/api/data/v9.2';
const APP = '11111111-1111-4111-8111-111111111111';
const THEME_DEF = '22222222-2222-4222-8222-222222222222';
const HEADER_DEF = '33333333-3333-4333-8333-333333333333';
const ROW = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';
const SOLUTION = '66666666-6666-4666-8666-666666666666';

const url = (path, params) => `${ROOT}${path}?${params.map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('&')}`;
const ok = (value, extra = {}) => ({ status: 200, headers: {}, body: { value, ...extra } });
const ROWS_FILTER = `_parentappmoduleid_value eq ${APP} and (_settingdefinitionid_value eq ${THEME_DEF})`;
const DEFINITIONS = url('/settingdefinitions', [['$select', 'settingdefinitionid,uniquename,displayname'], ['$filter', "uniquename eq 'CustomThemeDefinition' or uniquename eq 'OverrideAppHeaderColor'"]]);
const PLAIN = url('/appsettings', [['$select', 'appsettingid,value,_settingdefinitionid_value'], ['$filter', ROWS_FILTER]]);
const UNPUBLISHED = url('/appsettings/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()', [['$select', 'appsettingid,value,componentstate,_settingdefinitionid_value'], ['$filter', ROWS_FILTER]]);
const RESOURCE = url('/webresourceset', [['$select', 'webresourceid,name,webresourcetype'], ['$filter', "name eq 'contoso_/apptheme/a.xml'"]]);
const MEMBERS = url('/solutioncomponents', [['$select', 'objectid,componenttype'], ['$filter', `_solutionid_value eq ${SOLUTION} and (objectid eq ${ROW})`]]);
const SETTING = `${ROOT}/RetrieveSetting(SettingName='CustomThemeDefinition')`;
const OTHER_READ = url('/accounts', [['$select', 'name']]);

// `answers(url)` answers each GET; the log records every request the guard let through to the transport.
function transport(answers) {
  const log = [];
  return {
    log,
    async get(at) { log.push(`GET ${at}`); return answers(at); },
    async post(at) { log.push(`POST ${at}`); return { status: 204, headers: {}, body: null }; },
    async delete(at) { log.push(`DELETE ${at}`); return { status: 204, headers: {}, body: null }; },
  };
}

function guarded(answers) {
  const client = transport(answers);
  const guard = guardAppThemeReads(client);
  const sdk = markThemeReadGuarded({}, guard);
  const inScope = (work) => withThemeReadScope(sdk, { appId: APP }, work);
  return { client, guard, sdk, inScope };
}

const routes = (table) => (at) => {
  for (const [prefix, answer] of table) if (at === prefix || at.startsWith(prefix)) return typeof answer === 'function' ? answer(at) : answer;
  return { status: 404, headers: {}, body: { error: { code: '0x80040217', message: 'not found' } } };
};

async function refused(promise, words) {
  const error = await promise.then(() => null, (e) => e);
  assert.ok(error, 'the read was refused');
  assert.equal(error.code, READ_INCOMPLETE);
  assert.ok(isReadIncomplete(error));
  if (words) assert.match(error.message, words);
  assert.doesNotMatch(error.message, /https?:|contoso_|\$filter/, 'the message names no URL and no value');
  return error;
}

test('outside every theme scope the client is used as it is; inside, an unplaceable answer is refused and marks the scope', async () => {
  const bad = ok([{ appsettingid: null, value: 'x', _settingdefinitionid_value: THEME_DEF }]);
  const { guard, inScope } = guarded(routes([[PLAIN, bad]]));
  assert.equal(await guard.get(PLAIN), bad, 'another feature\'s read through the same client is untouched');
  let seen;
  await refused(inScope(async (scope) => { seen = scope; return guard.get(PLAIN); }), /published theme setting read answered a setting row with no id/);
  assert.deepEqual(seen.incomplete, { operation: 'published theme setting' });
  const other = ok([{ name: 'x' }]);
  const { guard: g2, inScope: s2 } = guarded(routes([[OTHER_READ, other]]));
  assert.equal(await s2(() => g2.get(OTHER_READ)), other, 'a read the theme code does not send is never judged');
});

test('a non-2xx answer stays the SDK\'s to report', async () => {
  const { guard, inScope } = guarded(routes([]));
  assert.equal((await inScope(() => guard.get(PLAIN))).status, 404);
});

test('definitions: a duplicate, an id-less or an unasked definition is refused; placed ones are recorded on the scope', async () => {
  const cases = [
    [[{ settingdefinitionid: THEME_DEF, uniquename: 'CustomThemeDefinition' }, { settingdefinitionid: OTHER, uniquename: 'CustomThemeDefinition' }], /twice/],
    [[{ settingdefinitionid: null, uniquename: 'CustomThemeDefinition' }], /no id/],
    [[{ settingdefinitionid: THEME_DEF, uniquename: 'SomethingElse' }], /did not ask for/],
    [[{ settingdefinitionid: THEME_DEF, uniquename: null }], /did not ask for/],
  ];
  for (const [rows, words] of cases) {
    const { guard, inScope } = guarded(routes([[DEFINITIONS, ok(rows)]]));
    await refused(inScope(() => guard.get(DEFINITIONS)), words);
  }
  const { guard, inScope } = guarded(routes([[DEFINITIONS, ok([{ settingdefinitionid: THEME_DEF.toUpperCase(), uniquename: 'CustomThemeDefinition' }, { settingdefinitionid: HEADER_DEF, uniquename: 'OverrideAppHeaderColor' }])]]));
  const definitions = await inScope(async (scope) => { await guard.get(DEFINITIONS); return Object.fromEntries(scope.definitions); });
  assert.deepEqual(definitions, { CustomThemeDefinition: THEME_DEF, OverrideAppHeaderColor: HEADER_DEF });
});

test('setting rows: each row must be one placed row of the app and a definition the read asked for', async () => {
  const row = (extra) => ({ appsettingid: ROW, value: 'v', _settingdefinitionid_value: THEME_DEF, ...extra });
  const cases = [
    [PLAIN, [row({ _settingdefinitionid_value: OTHER })], /definition it did not ask for/],
    [PLAIN, [row({ value: 7 })], /not text/],
    [PLAIN, [row({ value: null })], /not text/],
    [PLAIN, [row(), row({ appsettingid: OTHER })], /two rows for one setting/],
    [PLAIN, [row({ _parentappmoduleid_value: OTHER })], /another app/],
    [UNPUBLISHED, [row({ componentstate: 2 })], /state it cannot place/],
  ];
  for (const [at, rows, words] of cases) {
    const { guard, inScope } = guarded(routes([[at, ok(rows)]]));
    await refused(inScope(() => guard.get(at)), words);
  }
});

test('the two projections of one setting are judged as a pair: only the layer shapes Dataverse keeps are placed', async () => {
  const pair = async (plainRows, unpublishedRows) => {
    const { guard, inScope } = guarded(routes([[PLAIN, ok(plainRows)], [UNPUBLISHED, ok(unpublishedRows)]]));
    return inScope(async () => { await guard.get(PLAIN); return guard.get(UNPUBLISHED); });
  };
  const p = (value, id = ROW) => ({ appsettingid: id, value, _settingdefinitionid_value: THEME_DEF });
  const u = (value, componentstate, id = ROW) => ({ ...p(value, id), componentstate });
  // Placed: a draft never published, a published row, a published row with a draft over it, a pending removal, none.
  for (const [plainRows, unpublishedRows] of [[[], [u('a', 1)]], [[p('a')], [u('a', 0)]], [[p('a')], [u('b', 1)]], [[p('a')], []], [[], []]]) {
    assert.equal((await pair(plainRows, unpublishedRows)).status, 200, JSON.stringify([plainRows, unpublishedRows]));
  }
  await refused(pair([], [u('a', 0)]), /no published layer/);
  await refused(pair([p('a')], [u('a', 1, OTHER)]), /different row ids/);
  await refused(pair([p('a')], [u('b', 0)]), /projections differ/);
});

test('a web resource lookup by name is placed only as one row of that name with an id and a type', async () => {
  const row = (extra) => ({ webresourceid: ROW, name: 'contoso_/apptheme/a.xml', webresourcetype: 4, ...extra });
  const cases = [
    [[row(), row({ webresourceid: OTHER })], /more than one resource/],
    [[row({ name: 'contoso_/apptheme/b.xml' })], /another name/],
    [[row({ webresourceid: null })], /no id/],
    [[row({ webresourcetype: '4' })], /no type/],
  ];
  for (const [rows, words] of cases) {
    const { guard, inScope } = guarded(routes([[RESOURCE, ok(rows)]]));
    await refused(inScope(() => guard.get(RESOURCE)), words);
  }
  const { guard, inScope } = guarded(routes([[RESOURCE, ok([row({ name: 'CONTOSO_/apptheme/a.xml' })])]]));
  assert.equal((await inScope(() => guard.get(RESOURCE))).body.value.length, 1, 'a name matches ignoring case');
});

test('solution members: only the asked-for objects, each with a component type', async () => {
  for (const [rows, words] of [[[{ objectid: OTHER, componenttype: 61 }], /did not ask for/], [[{ objectid: ROW }], /no component type/]]) {
    const { guard, inScope } = guarded(routes([[MEMBERS, ok(rows)]]));
    await refused(inScope(() => guard.get(MEMBERS)), words);
  }
});

test('pages: every page is read and handed to the SDK as one answer with no continuation', async () => {
  const link = (n) => `${ROOT}/appsettings?$skiptoken=${n}`;
  const row = (id) => ({ appsettingid: id, value: 'v', _settingdefinitionid_value: THEME_DEF });
  const { guard, client, inScope } = guarded(routes([[PLAIN, ok([], { '@odata.nextLink': link(2) })], [link(2), ok([row(ROW)], { '@odata.nextLink': link(3) })], [link(3), ok([])]]));
  const answer = await inScope(() => guard.get(PLAIN));
  assert.deepEqual(answer.body, { value: [row(ROW)] });
  assert.equal(client.log.length, 3);
  // A no-id row on page 2 is refused like one on page 1.
  const second = guarded(routes([[PLAIN, ok([], { '@odata.nextLink': link(2) })], [link(2), ok([row(null)])]]));
  await refused(second.inScope(() => second.guard.get(PLAIN)), /no id/);
});

test('pages: a cycle, a foreign or other-API link, too many pages, a hidden remainder or a page with no rows is refused', async () => {
  const cases = [
    [{ [PLAIN]: ok([], { '@odata.nextLink': `${ROOT}/x?p=2` }), [`${ROOT}/x?p=2`]: ok([], { '@odata.nextLink': `${ROOT}/x?p=2` }) }, /cycle/],
    [{ [PLAIN]: ok([], { '@odata.nextLink': 'https://elsewhere.example.com/api/data/v9.2/appsettings?p=2' }) }, /off this environment/],
    [{ [PLAIN]: ok([], { '@odata.nextLink': 'https://contoso.crm.dynamics.com/api/data/v9.1/appsettings?p=2' }) }, /off this environment/],
    [{ [PLAIN]: ok([], { '@odata.nextLink': 7 }) }, /malformed/],
    [{ [PLAIN]: ok([], { '@Microsoft.Dynamics.CRM.morerecords': true }) }, /more rows exist/],
    [{ [PLAIN]: { status: 200, headers: {}, body: { rows: [] } } }, /no list of rows/],
    [{ [PLAIN]: ok([], { '@odata.nextLink': `${ROOT}/x?p=2` }), [`${ROOT}/x?p=2`]: { status: 500, headers: {}, body: {} } }, /later page/],
  ];
  for (const [table, words] of cases) {
    const { guard, inScope } = guarded((at) => table[at] || { status: 404, headers: {}, body: {} });
    await refused(inScope(() => guard.get(PLAIN)), words);
  }
  // An endless chain stops at the page budget, having read exactly that many pages.
  const { guard, client, inScope } = guarded((at) => {
    const n = at === PLAIN ? 1 : Number(new URL(at).searchParams.get('p'));
    return ok([], { '@odata.nextLink': `${ROOT}/x?p=${n + 1}` });
  });
  await refused(inScope(() => guard.get(PLAIN)), new RegExp(`more than ${MAX_PAGES} pages`));
  assert.equal(client.log.length, MAX_PAGES);
});

test('the resolved setting answer must carry a text value and a data type', async () => {
  for (const body of [{}, { SettingDetail: { Value: 1, DataType: 1 } }, { SettingDetail: { Value: '""' } }]) {
    const { guard, inScope } = guarded(routes([[SETTING, { status: 200, headers: {}, body }]]));
    await refused(inScope(() => guard.get(SETTING)));
  }
  const { guard, inScope } = guarded(routes([[SETTING, { status: 200, headers: {}, body: { SettingDetail: { Name: 'CustomThemeDefinition', Value: '""', DataType: 1 } } }]]));
  assert.equal((await inScope(() => guard.get(SETTING))).status, 200);
});

test('writes are counted only inside a scope, once, and a nested scope is the same scope', async () => {
  const { guard, sdk, inScope } = guarded(routes([]));
  await guard.post(`${ROOT}/x`);
  const counts = await inScope(async (outer) => {
    await guard.post(`${ROOT}/a`);
    await withThemeReadScope(sdk, { appId: APP }, async (inner) => { assert.equal(inner, outer); await guard.delete(`${ROOT}/b`); });
    return outer.writes;
  });
  assert.equal(counts, 2);
});

test('an SDK not made over a guarded client is refused before anything is read', () => {
  assert.equal(isThemeReadGuarded({}), false);
  assert.throws(() => assertThemeReadGuard({}), (error) => error.code === READ_INCOMPLETE);
  assert.throws(() => markThemeReadGuarded({}, transport(routes([]))), TypeError);
  assert.throws(() => withThemeReadScope({}, { appId: APP }, () => null), TypeError);
  const { sdk } = guarded(routes([]));
  assert.doesNotThrow(() => assertThemeReadGuard(sdk));
});

test('the setting row key must be an active key over the four layer attributes; a proven key is read once per client', async () => {
  const KEYS = "/EntityDefinitions(LogicalName='appsetting')/Keys";
  const keys = (value, extra) => routes([[KEYS, ok(value, extra)]]);
  const cases = [
    keys([]),
    keys([{ LogicalName: 'k', KeyAttributes: KEY_ATTRIBUTES, EntityKeyIndexStatus: 'Pending' }]),
    keys([{ LogicalName: 'k', KeyAttributes: KEY_ATTRIBUTES.slice(1), EntityKeyIndexStatus: 'Active' }]),
    keys([{ LogicalName: 'k', KeyAttributes: KEY_ATTRIBUTES, EntityKeyIndexStatus: 'Active' }], { '@odata.nextLink': `${ROOT}/x` }),
    routes([]),
    () => { throw new Error('socket hang up'); },
  ];
  for (const answers of cases) {
    await assert.rejects(assertThemeIdentityConstraint(transport(answers)), (error) => error.code === IDENTITY_UNPROVEN);
  }
  const client = transport(keys([{ LogicalName: 'k', KeyAttributes: [...KEY_ATTRIBUTES].reverse().map((name) => name.toUpperCase()), EntityKeyIndexStatus: 'Active' }]));
  await assertThemeIdentityConstraint(client);
  await assertThemeIdentityConstraint(client);
  assert.equal(client.log.length, 1);
});

test('readThemeSettingIdentity observes where the app\'s theme row is now, or refuses a row it cannot place', async () => {
  const definition = ok([{ settingdefinitionid: THEME_DEF, uniquename: 'CustomThemeDefinition', displayname: 'Theme' }]);
  const read = (plainRows, unpublishedRows, expected) => readThemeSettingIdentity(transport(routes([
    [`/settingdefinitions`, definition], [`/appsettings/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()`, ok(unpublishedRows)], [`/appsettings`, ok(plainRows)],
  ])), APP, expected);
  const p = (value) => ({ appsettingid: ROW, value });
  const u = (value, componentstate) => ({ ...p(value), componentstate });
  assert.deepEqual(await read([], []), { definitionId: THEME_DEF, state: 'absent', settingId: null, latestValue: undefined, matches: true });
  assert.deepEqual(await read([], [u('a', 1)], 'a'), { definitionId: THEME_DEF, state: 'draft', settingId: ROW, latestValue: 'a', matches: true });
  assert.equal((await read([p('a')], [u('a', 0)], 'b')).matches, false);
  assert.equal((await read([p('a')], [u('b', 1)])).state, 'publishedWithDraft');
  assert.equal((await read([p('a')], [])).state, 'removalPending');
  await assert.rejects(read([], [u('a', 1), { ...u('a', 1), appsettingid: OTHER }]), (error) => error.code === READ_INCOMPLETE);
  await assert.rejects(read([], [{ ...u('a', 1), appsettingid: null }]), (error) => error.code === READ_INCOMPLETE);
  await assert.rejects(readThemeSettingIdentity(transport(routes([[`/settingdefinitions`, ok([])]])), APP), (error) => error.code === READ_INCOMPLETE);
  await assert.rejects(readThemeSettingIdentity(transport(routes([[`/settingdefinitions`, definition], [`/appsettings`, ok([], { '@odata.nextLink': `${ROOT}/appsettings?p=2` })]])), APP), (error) => error.code === READ_INCOMPLETE, 'an unjudged first page is not the whole answer');
  await assert.rejects(readThemeSettingIdentity(transport(routes([])), 'not-a-guid'), (error) => error.code === READ_INCOMPLETE);
});
