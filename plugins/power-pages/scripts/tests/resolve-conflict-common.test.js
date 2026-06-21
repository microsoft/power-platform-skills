'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveSolutionIdByUniqueName } = require('../lib/resolve-conflict-common');

test('resolveSolutionIdByUniqueName: returns solutionid for an explicit token (no self-acquire)', async () => {
  let calledUrl = null;
  const makeRequestFn = async ({ url, headers }) => {
    calledUrl = url;
    assert.equal(headers.Authorization, 'Bearer explicit-tok');
    return { statusCode: 200, body: JSON.stringify({ value: [{ solutionid: 'sol-123' }] }) };
  };
  const id = await resolveSolutionIdByUniqueName({ base: 'https://org.crm.dynamics.com', token: 'explicit-tok', solutionUniqueName: 'RetailOS', makeRequestFn });
  assert.equal(id, 'sol-123');
  assert.match(decodeURIComponent(calledUrl), /uniquename eq 'RetailOS'/);
});

test('resolveSolutionIdByUniqueName: escapes single quotes in the unique name', async () => {
  let calledUrl = null;
  const makeRequestFn = async ({ url }) => { calledUrl = url; return { statusCode: 200, body: JSON.stringify({ value: [] }) }; };
  await resolveSolutionIdByUniqueName({ base: 'https://o', token: 't', solutionUniqueName: "O'Brien", makeRequestFn });
  assert.match(decodeURIComponent(calledUrl), /uniquename eq 'O''Brien'/);
});

test('resolveSolutionIdByUniqueName: returns null on non-200 / empty / missing args', async () => {
  assert.equal(await resolveSolutionIdByUniqueName({ base: '', token: 't', solutionUniqueName: 'X' }), null);
  assert.equal(await resolveSolutionIdByUniqueName({ base: 'https://o', token: 't', solutionUniqueName: '' }), null);
  const notFound = await resolveSolutionIdByUniqueName({ base: 'https://o', token: 't', solutionUniqueName: 'X', makeRequestFn: async () => ({ statusCode: 404, body: '{}' }) });
  assert.equal(notFound, null);
  const empty = await resolveSolutionIdByUniqueName({ base: 'https://o', token: 't', solutionUniqueName: 'X', makeRequestFn: async () => ({ statusCode: 200, body: JSON.stringify({ value: [] }) }) });
  assert.equal(empty, null);
});
