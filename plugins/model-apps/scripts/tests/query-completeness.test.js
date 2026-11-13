'use strict';
// What a bundled-SDK queryRecords() answer proves, measured on the REAL bundle through a fake transport, and what
// lib/query-completeness.js concludes from it. The fake answers the EntitySetName lookup every queryRecords call makes
// first, then serves pages addressed by a `$skiptoken=pN` next link.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { withThrowawaySdk } = require(path.join(__dirname, '..', 'lib', 'throwaway-sdk.js'));
const { createAzHttpClient } = require(path.join(__dirname, '..', 'lib', 'sdk-http-client.js'));
const { hasMoreOf, distinctRows, exactOne, requireComplete } = require(path.join(__dirname, '..', 'lib', 'query-completeness.js'));

const ORIGIN = 'https://contoso.crm.dynamics.com';
const role = (n) => ({ roleid: `00000000-0000-0000-0000-00000000000${n}`, name: 'Agent' });
const link = (n) => `${ORIGIN}/api/data/v9.2/roles?$select=roleid,name&$skiptoken=p${n}`;

async function query(pages, opts) {
  const sent = [];
  const request = async ({ url, method }) => {
    const u = decodeURIComponent(url);
    sent.push(`${method} ${u}`);
    if (u.includes('EntityDefinitions')) return { statusCode: 200, headers: {}, body: JSON.stringify({ EntitySetName: 'roles' }) };
    const m = /\$skiptoken=p(\d)/.exec(u);
    return { statusCode: 200, headers: {}, body: JSON.stringify(pages[m ? Number(m[1]) : 0]) };
  };
  const client = createAzHttpClient(ORIGIN, { getToken: () => 'x'.repeat(48), request, sleep: async () => {} });
  const rows = await withThrowawaySdk({ env: ORIGIN, httpClient: client, prefix: 'query-completeness-test-' },
    async (make) => make().queryRecords('role', { select: ['roleid', 'name'], ...opts }));
  return { rows, sent };
}

test('a top that leaves rows behind says so, and only on the array the SDK returned', async () => {
  const { rows } = await query([{ value: [role(1)], '@odata.nextLink': link(1) }], { top: 1 });
  assert.equal(rows.length, 1);
  assert.equal(hasMoreOf(rows), true);
  assert.equal(Object.keys(rows).includes('hasMore'), false, 'non-enumerable');
  assert.equal(hasMoreOf([...rows]), undefined, 'a copy loses the report');
  assert.equal(exactOne(rows, 'roleid').outcome, 'incomplete', 'one row shown, more exist: not proven one');
  assert.throws(() => requireComplete(rows, 'roleid', 'the role lookup'), (e) => e.code === 'QUERY_INCOMPLETE' && /role lookup/.test(e.message));

  const fit = await query([{ value: [role(1)] }], { top: 2 });
  assert.equal(hasMoreOf(fit.rows), false);
  const one = exactOne(fit.rows, 'roleid');
  assert.equal(one.outcome, 'one');
  assert.equal(one.reported, true);
  assert.equal(one.row.roleid, role(1).roleid);
  assert.equal(exactOne((await query([{ value: [] }], { top: 2 })).rows, 'roleid').outcome, 'none');
});

test('pagination keeps a row the server repeats on a later page; distinct ids do not double count it', async () => {
  const { rows, sent } = await query([{ value: [role(1), role(2)], '@odata.nextLink': link(1) }, { value: [role(2), role(3)] }], { paginate: true });
  assert.equal(rows.length, 4, 'the SDK concatenates as served');
  assert.equal(hasMoreOf(rows), false);
  assert.equal(sent.filter((s) => s.startsWith('GET ')).length, 3, 'entity-set lookup + two pages, GET only');
  const d = distinctRows(rows, 'roleid');
  assert.deepEqual(d.rows.map((r) => r.roleid.slice(-1)), ['1', '2', '3']);
  assert.deepEqual(d.duplicates, [role(2).roleid]);
  assert.deepEqual(requireComplete(rows, 'roleid').map((r) => r.roleid.slice(-1)), ['1', '2', '3']);

  const same = await query([{ value: [role(1)], '@odata.nextLink': link(1) }, { value: [role(1)] }], { paginate: true });
  assert.equal(same.rows.length, 2);
  assert.equal(exactOne(same.rows, 'roleid').outcome, 'one', 'one row read twice is still one row, not ambiguous');
  assert.equal(exactOne((await query([{ value: [role(1), role(2)] }], { top: 2 })).rows, 'roleid').outcome, 'ambiguous');
});

test('a page without a value array is an error, never an empty answer (first page or later)', async () => {
  await assert.rejects(query([{ rows: [] }], { top: 2 }), (e) => e.code === 'CONNECTION_ERROR');
  await assert.rejects(query([{ value: [role(1)], '@odata.nextLink': link(1) }, { other: [] }], { paginate: true }), (e) => e.code === 'CONNECTION_ERROR');
});

test('an answer with no report (plain array) is judged by count alone and says it was not reported', () => {
  const plain = [role(1)];
  assert.equal(hasMoreOf(plain), undefined);
  assert.deepEqual({ ...exactOne(plain, 'roleid'), row: undefined }, { outcome: 'one', row: undefined, count: 1, reported: false, duplicates: [] });
  assert.equal(exactOne([], 'roleid').outcome, 'none');
  assert.equal(exactOne([{ name: 'no id' }], 'roleid').outcome, 'incomplete', 'a row without an id cannot be told apart');
  assert.equal(requireComplete(plain, 'roleid').length, 1);
});

// #845: the rows of one name that two declared views share are read through the real bundle with every page followed, in one
// paginated query: two rows on two pages are two distinct rows, and the request count is the lookup plus one GET a page.
test('#845: verify reads every page of a name two declared views share, through the real bundle', async () => {
  const { verifySpec } = require(path.join(__dirname, '..', 'lib', 'verify-spec.js'));
  const view = (n) => ({ savedqueryid: `aaaaaaaa-0000-4000-8000-00000000000${n}`, returnedtypecode: 'contoso_item', name: 'Twin', layoutxml: '<grid><row><cell name="contoso_a"/></row></grid>' });
  const page = (n) => `${ORIGIN}/api/data/v9.2/savedqueries?$skiptoken=p${n}`;
  const run = async (pages) => {
    const sent = [];
    const request = async ({ url, method }) => {
      const u = decodeURIComponent(url);
      sent.push(`${method} ${u}`);
      if (u.includes('EntityDefinitions')) return { statusCode: 200, headers: {}, body: JSON.stringify({ EntitySetName: 'savedqueries' }) };
      const m = /\$skiptoken=p(\d)/.exec(u);
      return { statusCode: 200, headers: {}, body: JSON.stringify(pages[m ? Number(m[1]) : 0]) };
    };
    const client = createAzHttpClient(ORIGIN, { getToken: () => 'x'.repeat(48), request, sleep: async () => {} });
    const spec = { entities: [], appShell: { areas: [] }, views: ['a', 'b'].map((key) => ({ entity: 'contoso_item', name: 'Twin', key, reconcile: 'declared', columns: ['contoso_a'] })) };
    const r = await withThrowawaySdk({ env: ORIGIN, httpClient: client, prefix: 'query-completeness-test-' }, async (make) => {
      const sdk = make();
      return verifySpec(spec, { findTable: async () => null, findColumns: async () => [], sitemapXml: async () => '', queryRecords: (set, q) => sdk.queryRecords(set, q) });
    });
    return { r, sent };
  };
  const { r, sent } = await run([{ value: [view(1)], '@odata.nextLink': page(1) }, { value: [view(2), view(1)] }]);
  assert.equal(r.ok, true, JSON.stringify(r.missing));
  assert.deepEqual(r.checks.filter((c) => c.kind === 'view').map((c) => c.note), ['a', 'b'].map((k) => `present only: a distinct row is available, but view key "${k}" is not attributed to a row`));
  const gets = sent.filter((s) => s.includes('/savedqueries'));
  assert.equal(gets.length, 2, JSON.stringify(sent));
  assert.ok(gets[0].includes("$filter=returnedtypecode eq 'contoso_item' and name eq 'Twin'") && !/\$top=/.test(gets[0]), gets[0]);
  // The same row answered on both pages is one row, so one name is not two views.
  const once = await run([{ value: [view(1)], '@odata.nextLink': page(1) }, { value: [view(1)] }]);
  assert.equal(once.r.ok, false);
  assert.deepEqual(once.r.missing.map((m) => m.detail), ['only 1 distinct unclaimed row(s) named "Twin" on contoso_item were read for 2 declared view(s) (keys: "a", "b"); each declaration needs a row of its own']);
});