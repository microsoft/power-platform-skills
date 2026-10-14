'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  currentAppLayer, currentLayerRow, tableRefs, tableComponentIds, pinAppTables, resolveMainForms,
  readMainFormMembership, appEntityComponentsFor, collectionRows,
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
