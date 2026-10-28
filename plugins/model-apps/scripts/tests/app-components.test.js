'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  currentAppLayer, currentLayerRow, savedPageRows, tableRefs, tableComponentIds, pinAppTables, resolveMainForms,
  readMainFormMembership, appEntityComponentsFor, collectionRows, readAppComponentInventory,
} = require('../lib/app-components.js');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../lib/maker-sdk.js');
const { createFakeAppsOrg } = require('./helpers/fake-apps-org.js');

const APP = '11111111-0000-4000-8000-000000000001';
const PUBLISHED = '11111111-0000-4000-8000-000000000002';
const CURRENT = '11111111-0000-4000-8000-000000000003';
const TASK = '22222222-0000-4000-8000-000000000001';
const EMAIL = '22222222-0000-4000-8000-000000000002';
const FORM_A = '33333333-0000-4000-8000-000000000001';
const FORM_B = '33333333-0000-4000-8000-000000000002';
const DASHBOARD = '33333333-0000-4000-8000-000000000003';

const response = (value, status = 200, extra = {}) => ({ status, body: { value, ...extra } });
const layer = (id, state) => ({ appmoduleid: APP, appmoduleidunique: id, componentstate: state });

test('currentAppLayer reads the unpublished-aware projection and chooses only one current layer', async () => {
  const calls = [];
  for (const rows of [[layer(PUBLISHED, 0)], [layer(CURRENT, 1)], [layer(PUBLISHED, 0), layer(CURRENT, 1)]]) {
    const result = await currentAppLayer({ get: async (url) => { calls.push(url); return response(rows); } }, APP);
    assert.equal(result.ok, true);
    assert.equal(result.appModuleIdUnique, rows.at(-1).appmoduleidunique);
  }
  assert.ok(calls.every((url) => url === `/appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=appmoduleid,appmoduleidunique,componentstate&$filter=appmoduleid eq ${APP}`));
});

test('currentAppLayer is inconclusive for unreadable, missing or ambiguous layers', async () => {
  for (const result of [
    response([], 403), response([]), response([layer(PUBLISHED, 0), layer(CURRENT, 0)]),
    response([layer(PUBLISHED, 1), layer(CURRENT, 1)]), response([{ componentstate: 1 }]),
    { status: 200, body: {} },
  ]) {
    const read = await currentAppLayer({ get: async () => result }, APP);
    assert.equal(read.ok, false, JSON.stringify(result));
    assert.ok(read.reason);
  }
});

test('currentLayerRow is the authored layer whichever of a record\u2019s rows comes first, and the first row when none is authored — the one rule a listing shows, written once', () => {
  const rows = (...states) => states.map((componentstate, i) => ({ name: `row ${i}`, componentstate }));
  const name = (list) => currentLayerRow(list).name;
  assert.equal(name(rows(0)), 'row 0', 'the only row, published');
  assert.equal(name(rows(1)), 'row 0', 'the only row, authored');
  assert.equal(name(rows(0, 1)), 'row 1', 'authored last');
  assert.equal(name(rows(1, 0)), 'row 0', 'authored first');
  assert.equal(name(rows(0, 1, 0)), 'row 1', 'authored between two published rows');
  assert.equal(name(rows(0, 0)), 'row 0', 'none authored: the first row, so a record is shown rather than hidden');
  assert.equal(name(rows(0, 1, 1)), 'row 1', 'the first AUTHORED row, not the first row');
  assert.equal(name(rows(2, 3)), 'row 0', 'states other than the two layers do not make a row current');
  assert.equal(currentLayerRow([null, { name: 'authored', componentstate: 1 }]).name, 'authored', 'a hole in the list is skipped');
  assert.equal(currentLayerRow([]), undefined, 'no rows, no current one');
});

// --- savedPageRows: the pages in the SAVED layer, so a page that was never published is found -------------------------------------------
//   GET /uxagentprojects/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=uxagentprojectid,name,componentstate&$filter=uxagentprojectid eq <id> or …
//   { "value": [ { "uxagentprojectid": "44444444-…", "name": "Overview", "componentstate": 1 } ] }
const pageId = (n) => `44444444-0000-4000-8000-${String(n).padStart(12, '0')}`;
const pageRow = (n, state = 0, name = `Page ${n}`) => ({ uxagentprojectid: pageId(n), name, componentstate: state });
const askedBy = (url) => [...url.matchAll(/uxagentprojectid eq ([0-9a-f-]{36})/g)].map((m) => m[1]);

test('savedPageRows reads the saved layer, 50 ids at a time, and answers every row of an id — a page never published (componentstate 1) included', async () => {
  const ids = Array.from({ length: 120 }, (_, n) => pageId(n));
  const calls = [];
  const client = { get: async (url) => { calls.push(url); return response(askedBy(url).map((id, n) => ({ uxagentprojectid: id, name: `p${n}`, componentstate: 1 }))); } };
  const rows = await savedPageRows(client, ids);
  assert.deepEqual(calls.map((url) => askedBy(url).length), [50, 50, 20]);
  assert.ok(calls.every((url) => url.startsWith('/uxagentprojects/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=uxagentprojectid,name,componentstate&$filter=uxagentprojectid eq ')));
  assert.deepEqual([...rows.keys()], ids);
  assert.equal(rows.get(pageId(7))[0].componentstate, 1, 'a page that exists only as a draft is answered');
});

test('savedPageRows asks once for an id however it is spelled, groups the two layers a pending edit answers with, and leaves an id nobody answers out', async () => {
  const calls = [];
  const client = { get: async (url) => { calls.push(url); return response([pageRow(1, 0, 'published'), pageRow(1, 1, 'authored'), pageRow(2)]); } };
  const rows = await savedPageRows(client, [pageId(1).toUpperCase(), pageId(1), `{${pageId(2)}}`, pageId(3)]);
  assert.deepEqual(askedBy(calls[0]), [pageId(1), pageId(2), pageId(3)]);
  assert.deepEqual([...rows.keys()], [pageId(1), pageId(2)], 'the id no row answers to is not in the map');
  assert.deepEqual(rows.get(pageId(1)).map((r) => r.name), ['published', 'authored']);
  assert.equal(currentLayerRow(rows.get(pageId(1))).name, 'authored');
  assert.equal((await savedPageRows(client, [])).size, 0);
  assert.equal(calls.length, 1, 'no ids, no request');
});

test('savedPageRows fails — never a shorter answer — for a refusal, an answer that is no list, a row with no page id and an id that is no GUID, with the code its caller asked for', async () => {
  const read = (get, options) => savedPageRows({ get }, [pageId(1)], options);
  await assert.rejects(read(async () => response([], 403)), (error) => error.code === 'APP_COMPONENTS_UNVERIFIED' && /the generative pages: HTTP 403/.test(error.message));
  await assert.rejects(read(async () => response([], 503), { code: 'CONNECTION_ERROR', label: 'the pages of the app' }), (error) => error.code === 'CONNECTION_ERROR' && /the pages of the app: HTTP 503/.test(error.message));
  await assert.rejects(read(async () => ({ status: 200, body: {} })), /no readable result set/);
  await assert.rejects(read(async () => ({ status: 200, body: { value: null } })), /no readable result set/);
  for (const bad of [{ name: 'Overview' }, { uxagentprojectid: '', name: 'Overview' }, { uxagentprojectid: 'not-a-guid' }, null]) {
    await assert.rejects(read(async () => response([pageRow(1), bad])), (error) => /a row has no readable page id/.test(error.message), JSON.stringify(bad));
  }
  await assert.rejects(savedPageRows({ get: async () => response([]) }, ['not-a-guid']), (error) => error.code === 'APP_COMPONENT_ID_INVALID');
});

test('savedPageRows follows the continuation of a page of rows', async () => {
  const calls = [];
  const client = { get: async (url) => { calls.push(url); return url === '/next-pages' ? response([pageRow(2)]) : response([pageRow(1)], 200, { '@odata.nextLink': '/next-pages' }); } };
  const rows = await savedPageRows(client, [pageId(1), pageId(2)]);
  assert.deepEqual([...rows.keys()], [pageId(1), pageId(2)]);
  assert.equal(calls.length, 2);
});

test('tableRefs resolves MetadataId and EntitySetName together, deduplicating logical names', async () => {
  const calls = [];
  const refs = await tableRefs({ get: async (url) => {
    calls.push(url);
    return { status: 200, body: { MetadataId: TASK.toUpperCase(), EntitySetName: 'tasks' } };
  } }, ['task', 'TASK']);
  assert.equal(refs.size, 1);
  assert.deepEqual(refs.get('task'), { metadataId: TASK, entitySetName: 'tasks' });
  assert.deepEqual(calls, ["/EntityDefinitions(LogicalName='task')?$select=MetadataId,EntitySetName"]);
});

test('tableRefs escapes OData literals and refuses an unresolved table with its HTTP status', async () => {
  const calls = [];
  await assert.rejects(tableRefs({ get: async (url) => { calls.push(url); return { status: 503, body: null }; } }, ["contoso_o'neil"]),
    (error) => /contoso_o'neil/.test(error.message) && error.statusCode === 503);
  assert.ok(calls[0].includes("LogicalName='contoso_o''neil'"));
  for (const body of [{}, { MetadataId: TASK }, { EntitySetName: 'tasks' }]) {
    await assert.rejects(tableRefs({ get: async () => ({ status: 200, body }) }, ['task']), /task/);
  }
});

test('tableComponentIds follows every nextLink and normalizes GUID casing', async () => {
  const calls = [];
  const ids = await tableComponentIds({ get: async (url) => {
    calls.push(url);
    return calls.length === 1
      ? response([{ objectid: TASK.toUpperCase(), componenttype: 1 }], 200, { '@odata.nextLink': '/next-components' })
      : response([{ objectid: EMAIL, componenttype: 1 }]);
  } }, CURRENT);
  assert.deepEqual([...ids], [TASK, EMAIL]);
  assert.equal(calls[0], `/appmodulecomponents?$select=objectid,componenttype&$filter=_appmoduleidunique_value eq ${CURRENT} and componenttype eq 1`);
  assert.equal(calls[1], '/next-components');
  assert.ok(!calls[0].includes('$top'));
});

test('component pagination refuses a repeated nextLink, malformed rows and later-page failures', async () => {
  for (const get of [
    async () => response([], 200, { '@odata.nextLink': '/repeat' }),
    async () => ({ status: 200, body: {} }),
    async () => response([{ componenttype: 1 }]),
    async (url) => url === '/later' ? response([], 429) : response([], 200, { '@odata.nextLink': '/later' }),
  ]) {
    await assert.rejects(tableComponentIds({ get }, CURRENT));
  }
});

// --- collectionRows: the continuation the platform really gives is ABSOLUTE ------------------------------------------------------------
//   "@odata.nextLink": "https://contoso.crm.dynamics.com/api/data/v9.0/appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?...&$skiptoken=..."
// and the SDK client's `get` puts the API root in front of whatever it is given.

const ORIGIN = 'https://contoso.crm.dynamics.com';
const FIRST = '/appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=appmoduleid,componentstate';
const NEXT = `${ORIGIN}/api/data/v9.0${FIRST}&$skiptoken=1`;

test('collectionRows follows an absolute @odata.nextLink through the client\'s getAbsolute, never through get, which would put the API root in front of it', async () => {
  const calls = [];
  const client = {
    get: async (url) => { calls.push(['get', url]); return response([{ n: 1 }], 200, { '@odata.nextLink': NEXT }); },
    getAbsolute: async (url) => { calls.push(['getAbsolute', url]); return response([{ n: 2 }]); },
  };
  assert.deepEqual(await collectionRows(client, FIRST, 'rows'), [{ n: 1 }, { n: 2 }]);
  assert.deepEqual(calls, [['get', FIRST], ['getAbsolute', NEXT]]);
});

test('collectionRows hands an absolute link to get as it is when the client has no getAbsolute, and a relative link always to get', async () => {
  const calls = [];
  const plain = {
    get: async (url) => {
      calls.push(url);
      if (calls.length === 1) return response([1], 200, { '@odata.nextLink': NEXT });
      return calls.length === 2 ? response([2], 200, { '@odata.nextLink': '/relative-next' }) : response([3]);
    },
  };
  assert.deepEqual(await collectionRows(plain, FIRST, 'rows'), [1, 2, 3]);
  assert.deepEqual(calls, [FIRST, NEXT, '/relative-next']);

  const seen = [];
  const both = {
    get: async (url) => { seen.push(url); return seen.length === 1 ? response([1], 200, { '@odata.nextLink': '/relative-next' }) : response([2]); },
    getAbsolute: async () => { throw new Error('not for a relative link'); },
  };
  assert.deepEqual(await collectionRows(both, FIRST, 'rows'), [1, 2]);
  assert.deepEqual(seen, [FIRST, '/relative-next']);
});

test('collectionRows reports a refused page with the label, the status, the URL and the platform\'s own words — and the code it was asked for', async () => {
  const refused = { status: 403, body: { error: { code: '0x80040220', message: 'The user is not a member of the organization.' } } };
  const client = { get: async () => refused, apiUrl: (p) => `${ORIGIN}/api/data/v9.0${p}` };
  await assert.rejects(collectionRows(client, FIRST, 'the apps'), (error) => {
    assert.equal(error.code, 'APP_COMPONENTS_UNVERIFIED', 'the default');
    assert.equal(error.statusCode, 403);
    assert.equal(error.message, `the apps: HTTP 403 from ${ORIGIN}/api/data/v9.0${FIRST}: The user is not a member of the organization.`);
    return true;
  });
  await assert.rejects(collectionRows(client, FIRST, 'the apps', { code: 'CONNECTION_ERROR' }), (error) => error.code === 'CONNECTION_ERROR' && error.statusCode === 403);
  // No platform message and no apiUrl on the client: the status and the path, and nothing invented.
  await assert.rejects(collectionRows({ get: async () => ({ status: 500, body: null }) }, FIRST, 'the apps'), (error) => error.message === `the apps: HTTP 500 from ${FIRST}` && error.statusCode === 500);
  // A refused ABSOLUTE page names that link, as it is.
  const later = { get: async () => response([], 200, { '@odata.nextLink': NEXT }), getAbsolute: async () => refused, apiUrl: () => { throw new Error('an absolute link has no API root to add'); } };
  await assert.rejects(collectionRows(later, FIRST, 'the apps'), (error) => error.message === `the apps: HTTP 403 from ${NEXT}: The user is not a member of the organization.`);
});

test('collectionRows fails closed, with the code it was asked for: an answer that is no list, a link that is no link, a page that repeats', async () => {
  // A reader that follows a repeated link never ends, so the fake gives up after a few reads rather than hang the run.
  const bounded = (get) => { let reads = 0; return async (url) => { reads += 1; if (reads > 10) throw new Error('followed a repeated link'); return get(url); }; };
  const cases = [
    ['no readable result set', async () => ({ status: 200, body: { oops: true } })],
    ['no readable result set', async () => ({ status: 200, body: { value: 'nope' } })],
    ['malformed @odata.nextLink', async () => response([], 200, { '@odata.nextLink': 7 })],
    ['malformed @odata.nextLink', async () => response([], 200, { '@odata.nextLink': '' })],
    ['repeated @odata.nextLink', async () => response([], 200, { '@odata.nextLink': FIRST })],
    ['repeated @odata.nextLink', async (url) => response([], 200, { '@odata.nextLink': url === FIRST ? NEXT : FIRST })],
  ];
  for (const [message, get] of cases) {
    for (const [options, code] of [[undefined, 'APP_COMPONENTS_UNVERIFIED'], [{ code: 'CONNECTION_ERROR' }, 'CONNECTION_ERROR']]) {
      await assert.rejects(collectionRows({ get: bounded(get) }, FIRST, 'rows', options), (error) => error.message === `rows: ${message}` && error.code === code, `${message} / ${code}`);
    }
  }
});

test('collectionRows over the SDK\'s real client reads every page of a collection that pages with an absolute link — no request carries the API root twice', async () => {
  const apps = Array.from({ length: 7 }, (_, i) => ({ appmoduleid: `00000000-0000-4000-8000-00000000000${i}`, name: `App ${i}`, uniquename: `app_${i}`, componentstate: 0 }));
  const org = createFakeAppsOrg({ apps, pageSize: 3 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-rows-'));
  try {
    const httpClient = createAzHttpClient(ORIGIN, { getToken: () => 'test-token', request: org.request, sleep: async () => {} });
    const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: ORIGIN, httpClient });
    const first = '/appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=appmoduleid,name,uniquename,description,componentstate';
    const rows = await collectionRows(sdk.dataverse, first, 'apps');
    assert.deepEqual(rows.map((row) => row.name), apps.map((app) => app.name), 'every page was read');
    assert.deepEqual(org.requests.map((r) => r.path.replace(/^.*\$skiptoken=/, '#')), [first, '#3', '#6']);
    assert.ok(org.requests.every((r) => !r.path.includes('https://')), 'no request path holds a second URL');
    assert.deepEqual(org.unexpected, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function pinClient({ present = [], persist = true, unknown = false, postStatus = 204 } = {}) {
  const calls = [];
  let written = false;
  const client = {
    get: async (url) => {
      calls.push(['GET', url]);
      if (url.includes("EntityDefinitions(LogicalName='")) {
        if (unknown) return { status: 404, body: null };
        const isEmail = url.includes("'email'");
        return { status: 200, body: { MetadataId: isEmail ? EMAIL : TASK, EntitySetName: isEmail ? 'emails' : 'tasks' } };
      }
      if (url.includes('RetrieveUnpublishedMultiple')) return response([layer(written ? CURRENT : PUBLISHED, written ? 1 : 0)]);
      if (url.includes('appmodulecomponents')) {
        const ids = written && persist ? [...present, TASK, EMAIL] : present;
        return response(ids.map((objectid) => ({ objectid, componenttype: 1 })));
      }
      assert.fail(`unexpected read ${url}`);
    },
    post: async (url, body) => { calls.push(['POST', url, body]); written = true; return { status: postStatus, body: null }; },
  };
  return { client, calls };
}

test('pinAppTables does no work for an absent list and no write when every table is already pinned', async () => {
  const empty = pinClient();
  assert.deepEqual(await pinAppTables(empty.client, APP, []), { added: [], already: [] });
  assert.deepEqual(empty.calls, []);
  const pinned = pinClient({ present: [TASK] });
  assert.deepEqual(await pinAppTables(pinned.client, APP, ['task', 'TASK']), { added: [], already: ['task'] });
  assert.ok(!pinned.calls.some(([method]) => method === 'POST'));
});

test('pinAppTables sends only missing OData references and proves the newly created current layer', async () => {
  const { client, calls } = pinClient({ present: [TASK] });
  assert.deepEqual(await pinAppTables(client, APP, ['task', 'email']), { added: ['email'], already: ['task'] });
  const posts = calls.filter(([method]) => method === 'POST');
  assert.deepEqual(posts, [['POST', '/AddAppComponents', { AppId: APP, Components: [{ '@odata.id': `emails(${EMAIL})` }] }]]);
  const reads = calls.filter(([method, url]) => method === 'GET' && url.includes('appmodulecomponents'));
  assert.equal(reads.length, 2);
  assert.ok(reads[0][1].includes(PUBLISHED));
  assert.ok(reads[1][1].includes(CURRENT), 'proof must re-resolve the layer after AddAppComponents, not reuse the old id');
});

test('pinAppTables refuses an unresolved table before any write', async () => {
  const { client, calls } = pinClient({ unknown: true });
  await assert.rejects(pinAppTables(client, APP, ['task']), /task/);
  assert.ok(!calls.some(([method]) => method === 'POST'));
});

test('pinAppTables fails when accepted components are missing, or the write fails', async () => {
  const ignored = pinClient({ persist: false });
  await assert.rejects(pinAppTables(ignored.client, APP, ['task']),
    (error) => error.code === 'APP_TABLES_NOT_PINNED' && /task/.test(error.message));
  const failed = pinClient({ postStatus: 429 });
  await assert.rejects(pinAppTables(failed.client, APP, ['task']), (error) => error.statusCode === 429);
});

const form = (formid, name, active = 1, extra = {}) => ({ formid, name, formactivationstate: active, ...extra });
const formSpec = (names, forms = []) => ({ app: { mainForms: { contoso_item: names } }, forms });

test('resolveMainForms uses the created entity|Main|name identity, ignoring same-named non-Main forms', async () => {
  const spec = formSpec(['SUMMARY'], [
    { entity: 'CONTOSO_ITEM', name: 'Summary' },
    { entity: 'contoso_item', name: 'Summary', formType: 'QuickView' },
  ]);
  const calls = [];
  const client = { get: async (url) => {
    calls.push(url);
    return response([form(FORM_A, 'Summary'), form(FORM_B, 'SUMMARY', 0)]);
  } };
  assert.deepEqual(await resolveMainForms(client, spec, { 'contoso_item|Main|Summary': FORM_A, 'contoso_item|QuickView|Summary': FORM_B }),
    { contoso_item: [FORM_A] });
  assert.equal(calls.length, 1, 'a known id must still check the active Main name namespace');
  assert.ok(calls[0].includes("objecttypecode eq 'contoso_item' and type eq 2"));
});

test('a known created Main id cannot bypass ambiguity among active normalized names', async () => {
  const spec = formSpec(['Summary'], [{ entity: 'contoso_item', name: 'Summary', formId: FORM_A }]);
  await assert.rejects(resolveMainForms({
    get: async () => response([form(FORM_A, 'Summary'), form(FORM_B, 'S\u00fcmmary')]),
  }, spec, { 'contoso_item|Main|Summary': FORM_A }),
  (error) => error.code === 'APP_MAIN_FORM_AMBIGUOUS' && /Summary.*contoso_item.*active Main forms/.test(error.message));
});

test('a known Main id missing from a lagging catalog still counts when detecting ambiguity', async () => {
  const spec = formSpec(['Summary'], [{ entity: 'contoso_item', name: 'Summary', formId: FORM_A }]);
  await assert.rejects(resolveMainForms({
    get: async () => response([form(FORM_B, 'SUMMARY')]),
  }, spec, { 'contoso_item|Main|Summary': FORM_A }),
  (error) => error.code === 'APP_MAIN_FORM_AMBIGUOUS' && /Summary.*contoso_item/.test(error.message));
});

test('a known Main id requires a readable catalog even when its identity was already resolved', async () => {
  const spec = formSpec(['Summary'], [{ entity: 'contoso_item', name: 'Summary', formId: FORM_A }]);
  await assert.rejects(resolveMainForms({ get: async () => response([], 403) }, spec, { 'contoso_item|Main|Summary': FORM_A }),
    (error) => error.code === 'APP_COMPONENTS_UNVERIFIED' && error.statusCode === 403);
});

test('normalized duplicate catalog rows count as one active Main id for both build and verify resolution', async () => {
  const spec = formSpec(['Summary'], [{ entity: 'contoso_item', name: 'Summary', formId: FORM_A }]);
  for (const created of [{}, { 'contoso_item|Main|Summary': FORM_A }]) {
    const client = { get: async () => response([form(FORM_A, 'Summary'), form(`{${FORM_A}}`, 'SUMMARY')]) };
    assert.deepEqual(await resolveMainForms(client, spec, created), { contoso_item: [FORM_A] });
  }
});

test('a known Main id can survive metadata lag when no other active same-named form exists', async () => {
  let reads = 0;
  const spec = formSpec(['Summary'], [{ entity: 'contoso_item', name: 'Summary', formId: FORM_A }]);
  const client = { get: async () => { reads++; return response([]); } };
  assert.deepEqual(await resolveMainForms(client, spec, { 'contoso_item|Main|Summary': FORM_A }), { contoso_item: [FORM_A] });
  assert.equal(reads, 1, 'metadata lag must not skip the namespace read');
});

test('a catalogued inactive known Main id is not counted as an extra active candidate', async () => {
  const spec = formSpec(['Summary'], [{ entity: 'contoso_item', name: 'Summary', formId: FORM_A }]);
  for (const rows of [
    [form(FORM_A, 'Summary', 0)],
    [form(FORM_A, 'Summary', 0), form(FORM_B, 'SUMMARY')],
  ]) {
    await assert.rejects(resolveMainForms({ get: async () => response(rows) }, spec, { 'contoso_item|Main|Summary': FORM_A }),
      (error) => error.code === 'APP_MAIN_FORM_INACTIVE' && /Summary.*contoso_item.*inactive/.test(error.message));
  }
});

test('resolveMainForms queries and paginates active Main names once per table', async () => {
  const calls = [];
  const map = await resolveMainForms({ get: async (url) => {
    calls.push(url);
    return calls.length === 1
      ? response([form(FORM_A, 'R\u00e9sum\u00e9')], 200, { '@odata.nextLink': '/forms-page-2' })
      : response([form(FORM_B, 'Information')]);
  } }, formSpec(['RESUME', 'Information']), {});
  assert.deepEqual(map, { contoso_item: [FORM_A, FORM_B] });
  assert.equal(calls[0], "/systemforms?$select=formid,name,formactivationstate&$filter=objecttypecode eq 'contoso_item' and type eq 2");
  assert.equal(calls.length, 2);
});

test('resolveMainForms resolves a stock Main before reporting a declared non-Main name', async () => {
  const spec = formSpec(['Information'], [{ entity: 'contoso_item', name: 'Information', formType: 'QuickView' }]);
  const client = { get: async () => response([form(FORM_A, 'Information')]) };
  assert.deepEqual(await resolveMainForms(client, spec, {}), { contoso_item: [FORM_A] });
  await assert.rejects(resolveMainForms({ get: async () => response([]) }, spec, {}), /Information.*QuickView.*Main/);
});

test('resolveMainForms refuses missing, ambiguous and inactive Main names, including normalized twins', async () => {
  for (const [rows, pattern] of [
    [[], /Main form 'Summary' of contoso_item not found/],
    [[form(FORM_A, 'Summary'), form(FORM_B, 'S\u00fcmmary')], /ambiguous/],
    [[form(FORM_A, 'Summary', 0)], /inactive/],
  ]) {
    await assert.rejects(resolveMainForms({ get: async () => response(rows) }, formSpec(['Summary']), {}), pattern);
  }
  await assert.rejects(resolveMainForms({ get: async () => response([], 403) }, formSpec(['Summary']), {}), /403/);
});

test('resolveMainForms returns no directive for omission and performs no reads for an empty map', async () => {
  const client = { get: async () => assert.fail('no catalog should be read') };
  assert.equal(await resolveMainForms(client, { app: {} }, {}), undefined);
  assert.deepEqual(await resolveMainForms(client, { app: { mainForms: {} } }, {}), {});
});

function membershipClient(ids, classified, { status = 200 } = {}) {
  const calls = [];
  return {
    calls,
    get: async (url) => {
      calls.push(url);
      if (url.startsWith('/appmodulecomponents')) return response(ids.map((objectid) => ({ objectid, componenttype: 60 })));
      const rows = classified.filter((row) => url.includes(`formid eq ${row.formid}`));
      return response(rows, status);
    },
  };
}

test('readMainFormMembership compares Main ids per table, not dashboard or QuickView ids', async () => {
  const client = membershipClient([FORM_A, FORM_B, DASHBOARD], [
    { formid: FORM_A, name: 'Summary', type: 2, objecttypecode: 'CONTOSO_ITEM' },
    { formid: FORM_B, name: 'Quick Summary', type: 6, objecttypecode: 'contoso_item' },
    { formid: DASHBOARD, name: 'Overview', type: 0, objecttypecode: 'none' },
  ]);
  const result = await readMainFormMembership(client, PUBLISHED, { contoso_item: [FORM_A] });
  assert.equal(result.kind, 'read');
  assert.deepEqual(result.tables[0].members, [FORM_A]);
  assert.deepEqual(result.tables[0].extras, []);
  assert.deepEqual(result.tables[0].missing, []);
  assert.ok(client.calls[0].includes(PUBLISHED));
  assert.ok(!client.calls.some((url) => url.includes('RetrieveUnpublishedMultiple')), 'the caller supplies the published layer');
});

test('readMainFormMembership counts inactive Main extras and reports missing ids', async () => {
  const client = membershipClient([FORM_B], [{ formid: FORM_B, name: 'Old Summary', type: 2, objecttypecode: 'contoso_item' }]);
  const result = await readMainFormMembership(client, PUBLISHED, { contoso_item: [FORM_A] });
  assert.equal(result.kind, 'read');
  assert.deepEqual(result.tables[0].extras, [FORM_B]);
  assert.deepEqual(result.tables[0].missing, [FORM_A]);
});

test('readMainFormMembership is inconclusive for unclassifiable or unreadable components', async () => {
  for (const client of [
    membershipClient([FORM_A], []),
    membershipClient([FORM_A], [{ formid: FORM_A, objecttypecode: 'contoso_item' }]),
    membershipClient([FORM_A], [{ formid: FORM_A, type: 2 }]),
    membershipClient([FORM_A], [], { status: 403 }),
  ]) {
    const result = await readMainFormMembership(client, PUBLISHED, { contoso_item: [FORM_A] });
    assert.equal(result.kind, 'inconclusive');
    assert.ok(result.reason);
  }
});

test('Main component classification is bounded to 50 ids per query and follows pagination', async () => {
  const ids = Array.from({ length: 101 }, (_, index) => `44444444-0000-4000-8000-${String(index).padStart(12, '0')}`);
  const rows = ids.map((formid) => ({ formid, type: 2, objecttypecode: 'contoso_item' }));
  const client = membershipClient(ids, rows);
  const result = await readMainFormMembership(client, PUBLISHED, { contoso_item: ids });
  assert.equal(result.kind, 'read');
  assert.equal(result.tables[0].members.length, 101);
  const queries = client.calls.filter((url) => url.startsWith('/systemforms'));
  assert.equal(queries.length, 3);
  assert.ok(queries.every((url) => (url.match(/formid eq /g) || []).length <= 50));
});

test('the shared table verifier keeps published-layer, missing-table and placeholder semantics', async () => {
  const calls = [];
  const sdk = {
    queryRecords: async (set, options) => {
      calls.push({ set, options });
      return set === 'appmodule' ? [{ appmoduleidunique: PUBLISHED }] : [{ objectid: TASK, componenttype: 1 }];
    },
    dataverse: { get: async (url) => url.includes("'task'") ? { status: 200, body: { MetadataId: TASK } } : { status: 404, body: null } },
  };
  assert.deepEqual(await appEntityComponentsFor(sdk, 'contoso_app', ['task', 'email']), { ok: true, present: ['task'], placeholder: false });
  assert.equal(calls[0].set, 'appmodule');
  assert.equal(calls[1].options.paginate, true);
  assert.ok(calls[1].options.filter.includes(PUBLISHED));
});

// --- readAppComponentInventory: which component types are read, and whether every asset was identified ----------------------------

const ASSET_SOURCES = {
  26: { set: 'savedquery', id: 'savedqueryid', table: 'returnedtypecode' },
  59: { set: 'savedqueryvisualization', id: 'savedqueryvisualizationid', table: 'primaryentitytypecode' },
  60: { set: 'systemform', id: 'formid', table: 'objecttypecode' },
};
const compId = (n) => `44444444-0000-4000-8000-${String(n).padStart(12, '0')}`;
// An SDK double that holds one app: `tables` maps a table component's MetadataId to its logical name, `assets` maps a component type to { id: the table
// of the view, form or chart }, `shape(type, rows)` changes what a lookup of those tables answers and `shapeList(type, rows)` what a component list answers.
// `reads` keeps every request, in order.
function inventorySdk({ tables = {}, assets = {}, shape = (type, rows) => rows, shapeList = (type, rows) => rows } = {}) {
  const reads = [];
  return {
    reads,
    dataverse: {
      get: async (url) => {
        reads.push(url);
        if (url.startsWith('/appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()')) return response([layer(CURRENT, 1)]);
        // The SAVED layer's lookup of the tables of components, by id (`savedLayer`): answers every record the double holds, never published ones included.
        const saved = /^\/(savedqueries|savedqueryvisualizations|systemforms)\/Microsoft\.Dynamics\.CRM\.RetrieveUnpublishedMultiple\(\)\?\$select=[^&]+&\$filter=(.*)$/.exec(url);
        if (saved) {
          const type = { savedqueries: 26, savedqueryvisualizations: 59, systemforms: 60 }[saved[1]];
          const source = ASSET_SOURCES[type];
          return response(shape(type, Object.entries(assets[type] || {}).filter(([id]) => saved[2].includes(id)).map(([id, table]) => ({ [source.id]: id, [source.table]: table }))));
        }
        const m = /^\/EntityDefinitions\(([0-9a-f-]{36})\)/.exec(url);
        return m && tables[m[1]] ? { status: 200, body: { LogicalName: tables[m[1]], IsCustomEntity: true } } : { status: 404, body: null };
      },
    },
    queryRecords: async (set, options) => {
      const filter = (options && options.filter) || '';
      reads.push(`${set}: ${filter}`);
      if (set === 'appmodulecomponent') {
        const type = Number((/componenttype eq (\d+)/.exec(filter) || [])[1]);
        return shapeList(type, type === 1 ? Object.keys(tables).map((objectid) => ({ objectid, componenttype: 1 })) : Object.keys(assets[type] || {}).map((objectid) => ({ objectid, componenttype: type })));
      }
      const [type, source] = Object.entries(ASSET_SOURCES).find(([, s]) => s.set === set);
      return shape(Number(type), Object.entries(assets[type] || {}).filter(([id]) => filter.includes(id)).map(([id, table]) => ({ [source.id]: id, [source.table]: table })));
    },
  };
}
const componentTypesRead = (sdk) => sdk.reads.filter((read) => read.startsWith('appmodulecomponent:')).map((read) => Number((/componenttype eq (\d+)/.exec(read) || [])[1]));

test('readAppComponentInventory with no options reads the table components and every kind of asset: the inventory the download is built on', async () => {
  const sdk = inventorySdk({
    tables: { [compId(1)]: 'Contoso_Table' },
    assets: { 26: { [compId(10)]: 'contoso_view' }, 59: { [compId(11)]: 'contoso_chart' }, 60: { [compId(12)]: 'contoso_form', [compId(13)]: 'none' } },
  });
  const inventory = await readAppComponentInventory(sdk, APP);
  assert.deepEqual(componentTypesRead(sdk), [1, 26, 59, 60]);
  assert.deepEqual([...inventory.tables.keys()], ['contoso_table']);
  assert.deepEqual(inventory.assetTables.sort(), ['contoso_chart', 'contoso_form', 'contoso_view']);
  assert.deepEqual(inventory.logicalNames.sort(), ['contoso_chart', 'contoso_form', 'contoso_table', 'contoso_view']);
  assert.deepEqual(inventory.notes, []);
  assert.deepEqual(Object.fromEntries([...inventory.assetTablesByType].map(([type, set]) => [type, [...set]])), { 26: ['contoso_view'], 59: ['contoso_chart'], 60: ['contoso_form'] }, 'which kind of component each table was found through');
});

test('readAppComponentInventory with componentTypes reads only those kinds: no other component list, no table metadata, no lookup of another kind', async () => {
  const sdk = inventorySdk({
    tables: { [compId(1)]: 'contoso_table' },
    assets: { 26: { [compId(10)]: 'contoso_view' }, 59: { [compId(11)]: 'contoso_chart' }, 60: { [compId(12)]: 'contoso_form' } },
  });
  const inventory = await readAppComponentInventory(sdk, APP, { componentTypes: [60, 59] });
  assert.deepEqual(componentTypesRead(sdk), [59, 60], 'in the order the inventory always reads them');
  assert.ok(!sdk.reads.some((read) => read.includes('EntityDefinitions') || read.startsWith('savedquery:')));
  assert.equal(inventory.tables.size, 0);
  assert.deepEqual(inventory.logicalNames.sort(), ['contoso_chart', 'contoso_form']);
  assert.deepEqual([...inventory.assetTablesByType.keys()].sort(), [59, 60]);
});

test('a component no row answers for is not a note by default, so the download reads what it always read, and is one when the caller needs every component identified', async () => {
  const assets = { 60: { [compId(12)]: 'contoso_form', [compId(13)]: 'contoso_unresolved' } };
  const lookup = { shape: (type, rows) => rows.filter((row) => row.formid !== compId(13)) };
  const lenient = await readAppComponentInventory(inventorySdk({ assets, ...lookup }), APP);
  assert.deepEqual(lenient.notes, [], 'unchanged: the download does not report it');
  assert.deepEqual(lenient.assetTables, ['contoso_form']);
  const strict = await readAppComponentInventory(inventorySdk({ assets, ...lookup }), APP, { componentTypes: [60], requireIdentified: true });
  assert.deepEqual(strict.notes, [{ kind: 'tables', reason: `tables derived from app component type 60 could not be fully identified (no systemform record answered for ${compId(13)})` }]);
  assert.deepEqual(strict.assetTables, ['contoso_form'], 'what was identified is still reported; the caller decides what an incomplete answer is worth');
});

test('requireIdentified: a dashboard (`none`) identifies its component; a row with no id, no table or a blank table does not; a long list of ids is cut', async () => {
  const dashboard = await readAppComponentInventory(inventorySdk({ assets: { 60: { [compId(13)]: 'none' } } }), APP, { componentTypes: [60], requireIdentified: true });
  assert.deepEqual(dashboard.notes, []);
  const ids = Array.from({ length: 5 }, (_, i) => compId(20 + i));
  const assets = { 59: Object.fromEntries(ids.map((id) => [id, 'contoso_chart'])) };
  for (const [what, shape] of [
    ['no id', (type, rows) => rows.map((row) => ({ primaryentitytypecode: row.primaryentitytypecode }))],
    ['no table', (type, rows) => rows.map((row) => ({ savedqueryvisualizationid: row.savedqueryvisualizationid }))],
    ['a blank table', (type, rows) => rows.map((row) => ({ ...row, primaryentitytypecode: '' }))],
  ]) {
    const read = await readAppComponentInventory(inventorySdk({ assets, shape }), APP, { componentTypes: [59], requireIdentified: true });
    assert.equal(read.notes.length, 1, what);
    assert.equal(read.notes[0].reason, `tables derived from app component type 59 could not be fully identified (no savedqueryvisualization record answered for ${ids.slice(0, 3).join(', ')} and 2 more)`, what);
  }
});

test('requireIdentified: an id spelled with braces or capitals in the answer is the component it names, and a row for another id does not identify this one', async () => {
  const id = compId(30);
  const braces = (type, rows) => rows.map((row) => ({ ...row, formid: `{${row.formid.toUpperCase()}}` }));
  const same = await readAppComponentInventory(inventorySdk({ assets: { 60: { [id]: 'contoso_form' } }, shape: braces }), APP, { componentTypes: [60], requireIdentified: true });
  assert.deepEqual(same.notes, []);
  const other = await readAppComponentInventory(inventorySdk({ assets: { 60: { [id]: 'contoso_form' } }, shape: (type, rows) => rows.map((row) => ({ ...row, formid: compId(31) })) }), APP, { componentTypes: [60], requireIdentified: true });
  assert.equal(other.notes.length, 1);
});

// --- readAppComponentInventory: the saved layer, and the strict reading of its answer -------------------------------------------
//   GET /systemforms/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=formid,objecttypecode&$filter=formid eq <id> or formid eq <id>
//   { "value": [ { "formid": "44444444-…", "objecttypecode": "contoso_item" } ] }

test('savedLayer looks the tables of the components up in the SAVED layer, twenty ids to a request, and never with a plain read: a component never published is identified', async () => {
  const ids = Array.from({ length: 46 }, (_, i) => compId(100 + i));
  const sdk = inventorySdk({ assets: { 60: Object.fromEntries(ids.map((id, i) => [id, i % 2 ? 'contoso_odd' : 'contoso_even'])) } });
  const inventory = await readAppComponentInventory(sdk, APP, { componentTypes: [60], requireIdentified: true, savedLayer: true });
  const lookups = sdk.reads.filter((read) => read.startsWith('/systemforms/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()'));
  assert.deepEqual(lookups.map((url) => (url.match(/formid eq /g) || []).length), [20, 20, 6]);
  assert.ok(lookups.every((url) => url.startsWith('/systemforms/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=formid,objecttypecode&$filter=formid eq ')));
  assert.ok(!sdk.reads.some((read) => /^(savedquery|savedqueryvisualization|systemform): /.test(read)), 'no plain read of the records: it answers the published layer only');
  assert.deepEqual(inventory.notes, []);
  assert.deepEqual(inventory.assetTables.sort(), ['contoso_even', 'contoso_odd']);
  assert.deepEqual([...inventory.assetTablesByType.get(60)].sort(), ['contoso_even', 'contoso_odd']);
});

test('savedLayer is off by default: the download keeps reading the published records with a plain read, and its answer is read as it always was', async () => {
  const sdk = inventorySdk({ assets: { 60: { [compId(12)]: 'contoso_form' } } });
  const inventory = await readAppComponentInventory(sdk, APP, { componentTypes: [60] });
  assert.ok(sdk.reads.some((read) => read.startsWith('systemform: formid eq ')), 'a plain read');
  assert.ok(!sdk.reads.some((read) => read.includes('/systemforms/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()')));
  assert.deepEqual(inventory.assetTables, ['contoso_form']);
  // The lenient reading is unchanged: every row adds its table, whatever id it carries and however it is spelled.
  const shape = (type, rows) => [...rows, { formid: compId(99), objecttypecode: 'Contoso_Other' }, { objecttypecode: 'contoso_idless' }];
  const lenient = await readAppComponentInventory(inventorySdk({ assets: { 60: { [compId(12)]: 'contoso_form' } }, shape }), APP, { componentTypes: [60] });
  assert.deepEqual(lenient.assetTables.sort(), ['contoso_form', 'contoso_idless', 'contoso_other'], 'unchanged: not the strict reading');
  assert.deepEqual(lenient.notes, []);
});

test('savedLayer: a refused or unreadable lookup is a note saying which read it was, and never a shorter inventory taken for a complete one', async () => {
  const id = compId(40);
  const refused = inventorySdk({ assets: { 60: { [id]: 'contoso_form' } } });
  const get = refused.dataverse.get;
  refused.dataverse.get = async (url) => (url.startsWith('/systemforms/') ? { status: 500, body: { error: { message: 'simulated refusal' } } } : get(url));
  const read = await readAppComponentInventory(refused, APP, { componentTypes: [60], requireIdentified: true, savedLayer: true });
  assert.equal(read.notes.length, 1);
  assert.match(read.notes[0].reason, /^tables derived from app component type 60 could not be read \(the saved systemform records of the app's components: HTTP 500 from \/systemforms\/.*: simulated refusal\)$/);
  assert.deepEqual(read.assetTables, []);
  for (const body of [{}, { value: null }, { value: 'x' }]) {
    const sdk = inventorySdk({ assets: { 60: { [id]: 'contoso_form' } } });
    const original = sdk.dataverse.get;
    sdk.dataverse.get = async (url) => (url.startsWith('/systemforms/') ? { status: 200, body } : original(url));
    const bad = await readAppComponentInventory(sdk, APP, { componentTypes: [60], requireIdentified: true, savedLayer: true });
    assert.match(bad.notes[0].reason, /could not be read \(the saved systemform records of the app's components: no readable result set\)/, JSON.stringify(body));
  }
});

test('requireIdentified reads the answer strictly: a row counts for an id the component list asked about and for no other, and two tables for one id, or a value no table has, keep the read from being complete', async () => {
  const held = compId(50);
  const form = compId(51);
  const assets = { 60: { [held]: 'contoso_held', [form]: 'contoso_form' } };
  const read = (shape) => readAppComponentInventory(inventorySdk({ assets, shape }), APP, { componentTypes: [60], requireIdentified: true, savedLayer: true });
  const surplus = await read((type, rows) => [...rows, { formid: compId(52), objecttypecode: 'contoso_lookup' }, { objecttypecode: 'contoso_idless' }, null]);
  assert.deepEqual(surplus.notes, [], 'a row for a record nobody asked about adds nothing and costs nothing');
  assert.deepEqual(surplus.assetTables.sort(), ['contoso_form', 'contoso_held']);
  const twice = await read((type, rows) => [...rows, ...rows.map((row) => ({ ...row }))]);
  assert.deepEqual(twice.notes, [], 'one record answered once per layer, the same table');
  const conflict = await read((type, rows) => [...rows, { formid: held, objecttypecode: 'contoso_lookup' }]);
  assert.deepEqual(conflict.notes, [{ kind: 'tables', reason: `tables derived from app component type 60 could not be fully identified (the systemform answer for ${held} names more than one table)` }]);
  assert.deepEqual(conflict.assetTables, ['contoso_form'], 'neither table of the contradicted record is let in; the unambiguous one stays');
  const unusable = await read((type, rows) => rows.map((row) => (row.formid === held ? { ...row, objecttypecode: '   ' } : row)));
  assert.deepEqual(unusable.notes, [{ kind: 'tables', reason: `tables derived from app component type 60 could not be fully identified (the systemform answer for ${held} names no usable table ("   "))` }]);
  assert.deepEqual(unusable.assetTables, ['contoso_form']);
  const everything = await read((type, rows) => [{ formid: compId(53), objecttypecode: 'contoso_lookup' }, ...rows.filter((row) => row.formid !== form), { formid: held, objecttypecode: 12345 }]);
  assert.equal(everything.notes.length, 1, 'one note for the type, with every reason in it');
  assert.equal(everything.notes[0].reason, `tables derived from app component type 60 could not be fully identified (no systemform record answered for ${form}; the systemform answer for ${held} names no usable table (12345))`);
});

// --- readAppComponentInventory: the component list itself, read strictly -------------------------------------------------------
//   GET /appmodulecomponents?$select=objectid,componenttype&$filter=_appmoduleidunique_value eq <layer> and componenttype eq 60
//   { "value": [ { "objectid": "44444444-…", "componenttype": 60 } ] }
// A caller that proves something from the list (the build's publish before the app) must be able to place EVERY row of it. A row it cannot place — no record, an
// objectid that is no GUID, a component type that is not the one asked for — would otherwise vanish in the filter or in the normalising of the ids, and the component it
// stood for would read as "the app holds no such component", which makes an incomplete list look complete. The download keeps reading the list as it always did.
const BAD_ROWS = [
  ['a null row', (id) => null, 'row 2 is not a record'],
  ['a row that is text', (id) => 'objectid', 'row 2 is not a record'],
  ['a row that is a list', (id) => [id], 'row 2 is not a record'],
  ['an objectid that is only braces', (id) => ({ objectid: '{}', componenttype: 60 }), 'row 2 has an objectid that is no GUID ("{}")'],
  ['an objectid that is no GUID', (id) => ({ objectid: 'not-a-guid', componenttype: 60 }), 'row 2 has an objectid that is no GUID ("not-a-guid")'],
  ['an objectid that is not text', (id) => ({ objectid: 12345, componenttype: 60 }), 'row 2 has an objectid that is no GUID (12345)'],
  ['no objectid', (id) => ({ componenttype: 60 }), 'row 2 has no objectid'],
  ['a null objectid', (id) => ({ objectid: null, componenttype: 60 }), 'row 2 has no objectid'],
  ['a component type that is text', (id) => ({ objectid: id, componenttype: 'bad' }), 'row 2 has component type "bad", not 60'],
  ['a component type that is a boolean', (id) => ({ objectid: id, componenttype: true }), 'row 2 has component type true, not 60'],
  ['a component type of another kind', (id) => ({ objectid: id, componenttype: 59 }), 'row 2 has component type 59, not 60'],
  ['no component type', (id) => ({ objectid: id }), 'row 2 says no component type'],
];

for (const [what, damaged, said] of BAD_ROWS) {
  test(`requireIdentified: a component list that holds ${what} is unreadable, with the row named, and no table is offered from the rest of it`, async () => {
    const [first, held] = [compId(60), compId(61)];
    const assets = { 60: { [first]: 'contoso_form', [held]: 'contoso_held' } };
    // The list answers the first component and, in the second row's place, the damaged one: the component it stood for is not in what the build reads.
    const shapeList = (type, rows) => (type === 60 ? [rows.find((row) => row.objectid === first), damaged(held)] : rows);
    const read = await readAppComponentInventory(inventorySdk({ assets, shapeList }), APP, { componentTypes: [60], requireIdentified: true, savedLayer: true });
    assert.deepEqual(read.notes, [{ kind: 'tables', reason: `app component type 60 could not be read (the component list holds 1 row it cannot place: ${said})` }]);
    assert.equal(read.componentProblems.get(60), `the component list holds 1 row it cannot place: ${said}`);
    assert.deepEqual(read.assetTables, [], 'nothing is looked up for a list that cannot be placed whole');
    assert.ok(!read.assetTablesByType.has(60) || read.assetTablesByType.get(60).size === 0);
  });
}

test('requireIdentified: every unplaceable row is counted, three are named and the rest are cut, and a well-formed list (braces, capitals, a numeric text type) is read as before', async () => {
  const ids = [compId(70), compId(71)];
  const assets = { 60: Object.fromEntries(ids.map((id) => [id, 'contoso_form'])) };
  const many = await readAppComponentInventory(inventorySdk({ assets, shapeList: (type, rows) => [...rows, null, null, { objectid: '{}', componenttype: 60 }, { componenttype: 60 }, 'x'] }), APP, { componentTypes: [60], requireIdentified: true });
  assert.equal(many.notes.length, 1);
  assert.equal(many.notes[0].reason, 'app component type 60 could not be read (the component list holds 5 rows it cannot place: row 3 is not a record; row 4 is not a record; row 5 has an objectid that is no GUID ("{}") and 2 more)');
  const spelled = await readAppComponentInventory(inventorySdk({ assets, shapeList: (type, rows) => rows.map((row, i) => ({ objectid: i ? `{${row.objectid.toUpperCase()}}` : row.objectid, componenttype: i ? ' 60 ' : '60' })) }), APP, { componentTypes: [60], requireIdentified: true });
  assert.deepEqual(spelled.notes, [], 'a GUID with braces or capitals and a type spelled as text are placeable');
  assert.deepEqual(spelled.assetTables, ['contoso_form']);
});

test('the download reads the component list as it always did: a row that cannot be placed is left out, as before, without a note — except one with no objectid, which has always been said', async () => {
  const [first, held] = [compId(80), compId(81)];
  const assets = { 60: { [first]: 'contoso_form', [held]: 'contoso_held' } };
  const lenient = (damaged) => readAppComponentInventory(inventorySdk({ assets, shapeList: (type, rows) => [rows.find((row) => row.objectid === first), damaged(held)] }), APP, { componentTypes: [60] });
  for (const what of ['a null row', 'an objectid that is only braces', 'a component type that is text', 'a component type of another kind']) {
    const read = await lenient(BAD_ROWS.find(([name]) => name === what)[1]);
    assert.deepEqual(read.notes, [], `${what}: unchanged, the row is dropped without a word`);
    assert.deepEqual(read.assetTables, ['contoso_form'], what);
  }
  const noId = await lenient(() => ({ componenttype: 60 }));
  assert.deepEqual(noId.notes, [{ kind: 'tables', reason: 'an app component of type 60 has no objectid and could not be recovered' }], 'the one case the download has always said');
});
