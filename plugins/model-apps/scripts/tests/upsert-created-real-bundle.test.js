'use strict';
// What the bundled SDK's upsertRecord() says about insert-or-update, pinned on the REAL bundle through a fake
// transport. No script calls upsertRecord today (tests/sdk-opt-ins.test.js); this pins the contract a future caller
// (an explicit data-repair upsert) must read: `created` is a claim only when the server's status proves it, a
// returned id never does, and a write whose answer is lost is reported as unknown and never re-sent.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { withThrowawaySdk } = require(path.join(__dirname, '..', 'lib', 'throwaway-sdk.js'));
const { createAzHttpClient } = require(path.join(__dirname, '..', 'lib', 'sdk-http-client.js'));

const ORIGIN = 'https://contoso.crm.dynamics.com';
const ID = '11111111-1111-4111-8111-111111111111';
const KEY = { key: 'accountnumber', value: 'K1' };

async function upsert(answer, options) {
  const sent = [];
  const request = async ({ url, method, headers }) => {
    const u = decodeURIComponent(url).replace(ORIGIN, '');
    const prefer = (headers && (headers.Prefer || headers.prefer)) || '';
    sent.push({ method, url: u, prefer });
    if (u.includes('EntityDefinitions')) {
      return { statusCode: 200, headers: {}, body: JSON.stringify({ EntitySetName: 'accounts', PrimaryIdAttribute: 'accountid' }) };
    }
    if (answer === 'drop') throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    return {
      statusCode: answer,
      headers: { 'OData-EntityId': `${ORIGIN}/api/data/v9.2/accounts(${ID})`, 'content-type': 'application/json' },
      body: answer === 204 ? '' : JSON.stringify({ accountid: ID }),
    };
  };
  const client = createAzHttpClient(ORIGIN, { getToken: () => 'x'.repeat(48), request, sleep: async () => {} });
  const args = ['account', KEY, { name: 'A' }];
  if (options !== undefined) args.push(options);
  const run = withThrowawaySdk({ env: ORIGIN, httpClient: client, prefix: 'upsert-created-test-' }, async (make) => make().upsertRecord(...args));
  return { run, sent };
}

test('a plain upsert returns the id but makes no insert-or-update claim, and sends one bare PATCH', async () => {
  const { run, sent } = await upsert(204);
  const result = await run;
  assert.equal(result.id, ID);
  assert.equal(result.created, undefined, 'a 204 answers an insert and an update alike');
  const writes = sent.filter((s) => s.method !== 'GET');
  assert.deepEqual(writes.map((s) => [s.method, s.url, s.prefer]), [['PATCH', "/api/data/v9.0/accounts(accountnumber='K1')", '']]);
});

test('reportCreated classifies 201 as created and 200 as updated, and a 204 it was not given stays unknown', async () => {
  for (const [status, created] of [[201, true], [200, false], [204, undefined]]) {
    const { run, sent } = await upsert(status, { reportCreated: true });
    const result = await run;
    assert.equal(result.id, ID);
    assert.equal(result.created, created, `status ${status}`);
    const patch = sent.find((s) => s.method === 'PATCH');
    assert.match(patch.url, /\?\$select=accountid$/);
    assert.equal(patch.prefer, 'return=representation');
  }
});

test('reportCreated must be a boolean; a lost answer is UPSERT_OUTCOME_UNKNOWN and the write is not re-sent', async () => {
  const bad = await upsert(204, { reportCreated: 'yes' });
  await assert.rejects(bad.run, (e) => e.code === 'INVALID_ARGUMENT' && /reportCreated/.test(e.message));
  assert.equal(bad.sent.filter((s) => s.method === 'PATCH').length, 0);

  const lost = await upsert('drop', { reportCreated: true });
  await assert.rejects(lost.run, (e) => e.code === 'UPSERT_OUTCOME_UNKNOWN' && /Nothing was re-sent/.test(e.message));
  assert.equal(lost.sent.filter((s) => s.method === 'PATCH').length, 1);
});
