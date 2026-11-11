'use strict';
// The managed kinds' create bridge: only a matched envelope that carries the SDK's exact-match evidence for a create
// that execute saved is a match; a port failure after execute saved, a malformed match and a created answer without a
// readable id are never success.
const test = require('node:test');
const assert = require('node:assert/strict');
const { runManagedCreate } = require('../lib/managed-create.js');
const { stableCreates, stableId } = require('./helpers/stable-creates.js');

const request = { kind: 'dashboard', key: 'sales', identity: { name: 'Sales' }, childKeys: ['tile:a'] };
const saved = (sdkResult = {}) => async () => ({ outcome: 'saved', code: '', sdkResult });

test('a matched envelope with exact-match evidence is a match, never a creation', async () => {
  const out = await runManagedCreate({ creates: stableCreates() }, request, saved({ adoptedExisting: true }));
  assert.equal(out.status, 'matched');
  assert.equal(out.evidence, 'sdk-adopted-exact');
  assert.equal(out.id, stableId('stable-test', 'dashboard', 'sales'));
  assert.deepEqual(Object.keys(out.childIds), ['tile:a']);
});

test('a matched envelope without the evidence stays unknown', async () => {
  const out = await runManagedCreate({ creates: stableCreates({ malformedMatched: true }) }, request, saved());
  assert.equal(out.status, 'unknown');
});

test('a port that fails after execute saved is unknown: the callback\'s success does not rescue it', async () => {
  const out = await runManagedCreate({ creates: stableCreates({ failAfterExecute: true }) }, request, saved());
  assert.equal(out.executed, true);
  assert.equal(out.status, 'unknown');
});

test('a created answer without a readable id is not a receipt; the same key answers the same id in another run', async () => {
  const bad = { run: async (req, exec) => { await exec({ id: 'x', childIds: {} }); return { outcome: 'created', id: 'not-a-guid', childIds: {} }; } };
  assert.deepEqual((await runManagedCreate({ creates: bad }, request, saved())).status, 'unknown');
  const a = await runManagedCreate({ creates: stableCreates() }, request, saved());
  const b = await runManagedCreate({ creates: stableCreates() }, request, saved());
  assert.equal(a.status, 'created');
  assert.equal(a.id, b.id);
  assert.deepEqual(a.childIds, b.childIds);
});

test('no creation port: refused before anything runs', async () => {
  let ran = false;
  const out = await runManagedCreate({}, request, async () => { ran = true; return { outcome: 'saved' }; });
  assert.equal(out.status, 'refused');
  assert.equal(out.code, 'creation-port-unavailable');
  assert.equal(ran, false);
});
