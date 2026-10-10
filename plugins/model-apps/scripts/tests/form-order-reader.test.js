'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { readerFor } = require('../verify-model-app.js');

const USER = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const FORM_A = '11111111-1111-1111-1111-111111111111';
const FORM_B = '22222222-2222-2222-2222-222222222222';

function sdkFor({ who = { status: 200, body: { UserId: `{${USER.toUpperCase()}}` } }, retrieve = { status: 200, body: { value: [] } }, rows = [] } = {}) {
  const calls = [];
  const sdk = {
    dataverse: {
      get: async (url) => {
        calls.push({ type: 'get', url });
        if (url === '/WhoAmI') return who;
        return typeof retrieve === 'function' ? retrieve(url) : retrieve;
      },
    },
    queryRecords: async (set, opts) => {
      calls.push({ type: 'queryRecords', set, opts });
      assert.strictEqual(set, 'systemform');
      return rows;
    },
    findTables: async () => [],
    findColumns: async () => [],
  };
  return { sdk, calls };
}

test('servedMainForms calls RetrieveFilteredForms with the lower-cased entity and caller alias, then maps ids to names', async () => {
  const { sdk, calls } = sdkFor({
    retrieve: { status: 200, body: { value: [{ formid: `{${FORM_A.toUpperCase()}}` }, { formid: FORM_B }] } },
    rows: [{ formid: FORM_A.toUpperCase(), name: 'Work Item' }, { formid: `{${FORM_B}}`, name: 'My Work — Work Item' }],
  });

  const served = await readerFor(sdk, 'new_workitems', {}).servedMainForms('NEW_WorkItem');

  assert.deepStrictEqual(served, [
    { id: FORM_A, name: 'Work Item' },
    { id: FORM_B, name: 'My Work — Work Item' },
  ]);
  const retrieveCall = calls.find((c) => c.type === 'get' && c.url !== '/WhoAmI');
  assert.strictEqual(
    retrieveCall.url,
    `/systemforms/Microsoft.Dynamics.CRM.RetrieveFilteredForms(EntityLogicalName=@e,FormType=@t,User=@u)?@e='new_workitem'&@t=2&@u={'@odata.id':'systemusers(${USER})'}`,
  );
  const nameQuery = calls.find((c) => c.type === 'queryRecords');
  assert.deepStrictEqual(nameQuery.opts.select, ['formid', 'name']);
  assert.strictEqual(nameQuery.opts.filter, "objecttypecode eq 'new_workitem' and type eq 2");
});

test('WhoAmI is memoized across servedMainForms calls for two entities', async () => {
  const { sdk, calls } = sdkFor({
    retrieve: { status: 200, body: { value: [] } },
    rows: [],
  });
  const reader = readerFor(sdk, 'new_workitems', {});

  await reader.servedMainForms('new_workitem');
  await reader.servedMainForms('new_case');

  assert.strictEqual(calls.filter((c) => c.type === 'get' && c.url === '/WhoAmI').length, 1);
  assert.strictEqual(calls.filter((c) => c.type === 'get' && c.url !== '/WhoAmI').length, 2);
});

test('a served id with no systemform name row falls back to the normalized id', async () => {
  const { sdk } = sdkFor({
    retrieve: { status: 200, body: { value: [{ formid: `{${FORM_A.toUpperCase()}}` }] } },
    rows: [],
  });

  assert.deepStrictEqual(await readerFor(sdk, 'new_workitems', {}).servedMainForms('new_workitem'), [
    { id: FORM_A, name: FORM_A },
  ]);
});

test('RetrieveFilteredForms non-2xx responses throw with the HTTP status', async () => {
  const { sdk } = sdkFor({ retrieve: { status: 403, body: { error: { message: 'denied' } } } });

  await assert.rejects(readerFor(sdk, 'new_workitems', {}).servedMainForms('new_workitem'), /RetrieveFilteredForms returned HTTP 403/);
});

test('WhoAmI non-2xx or missing canonical GUID throws before interpolating a user into RetrieveFilteredForms', async (t) => {
  for (const [name, who] of [
    ['non-2xx WhoAmI', { status: 401, body: { UserId: USER } }],
    ['missing canonical GUID', { status: 200, body: { UserId: 'not-a-guid' } }],
  ]) {
    await t.test(name, async () => {
      const { sdk, calls } = sdkFor({ who });

      await assert.rejects(readerFor(sdk, 'new_workitems', {}).servedMainForms('new_workitem'), /WhoAmI returned no user id/);
      assert.deepStrictEqual(calls.map((c) => c.url).filter(Boolean), ['/WhoAmI']);
    });
  }
});

test('entity logical names containing quotes are OData-escaped in both RetrieveFilteredForms and name lookups', async () => {
  const { sdk, calls } = sdkFor({ retrieve: { status: 200, body: { value: [] } }, rows: [] });

  await readerFor(sdk, 'new_workitems', {}).servedMainForms("NEW_O'Hare");

  const retrieveCall = calls.find((c) => c.type === 'get' && c.url !== '/WhoAmI');
  assert.match(retrieveCall.url, /@e='new_o''hare'/);
  const nameQuery = calls.find((c) => c.type === 'queryRecords');
  assert.strictEqual(nameQuery.opts.filter, "objecttypecode eq 'new_o''hare' and type eq 2");
});
