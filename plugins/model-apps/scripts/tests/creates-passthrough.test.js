'use strict';
// The plain pass-through create port (lib/creates-passthrough.js): it mints the ids a create asks for, runs the create exactly once,
// and lets every failure through unchanged. It keeps no journal, so nothing here may look like a fence.
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPassthroughCreates } = require('../lib/creates-passthrough.js');
const fls = require('../lib/field-security.js');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sequence = () => { let n = 0; return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`; };
const request = (childKeys) => ({ kind: 'fieldSecurityProfile', key: 'hr', identity: { name: 'HR Salary' }, childKeys });

test('creates port: mints one id for the row and one per child key, hands them to the create, and answers them with its result', async () => {
  const creates = createPassthroughCreates({ newId: sequence() });
  const seen = [];
  const answer = await creates.run(request(['new_employee.new_salary', 'new_employee.new_bonus']), async (ids) => { seen.push(ids); return { saved: true }; });
  const ids = {
    id: '00000000-0000-4000-8000-000000000001',
    childIds: { 'new_employee.new_salary': '00000000-0000-4000-8000-000000000002', 'new_employee.new_bonus': '00000000-0000-4000-8000-000000000003' },
  };
  assert.deepEqual(seen, [ids]);
  assert.deepEqual(answer, { outcome: 'created', ...ids, ids, result: { saved: true } });
  // The default ids are random v4 GUIDs; a create without children gets an empty map.
  const fresh = await createPassthroughCreates().run(request(undefined), async () => 'ok');
  assert.match(fresh.id, UUID);
  assert.deepEqual([fresh.childIds, fresh.result], [{}, 'ok']);
});

test('creates port: each run calls its create exactly once and mints new ids — nothing is remembered between runs', async () => {
  const creates = createPassthroughCreates();
  const calls = [];
  const first = await creates.run(request(['t.c']), async (ids) => { calls.push(ids); });
  const second = await creates.run(request(['t.c']), async (ids) => { calls.push(ids); });
  assert.equal(calls.length, 2);
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.childIds['t.c'], second.childIds['t.c']);
});

test('creates port: a failed or unconfirmed create is rethrown as the same error, after one call, and is never sent again', async () => {
  for (const failure of [
    Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    Object.assign(new Error('the service did not answer'), { statusCode: 504 }),
    Object.assign(new Error('the profile was not saved'), { code: 'FIELD_SECURITY_PROFILE_NOT_SAVED' }),
  ]) {
    let calls = 0;
    await assert.rejects(
      () => createPassthroughCreates().run(request(['t.c']), async () => { calls += 1; throw failure; }),
      (e) => e === failure,
    );
    assert.equal(calls, 1, failure.message);
  }
});

test('creates port: a malformed request is refused before the create runs', async () => {
  const creates = createPassthroughCreates();
  let calls = 0;
  const execute = async () => { calls += 1; };
  for (const bad of [null, { key: 'hr' }, { kind: 'k' }, { kind: 'k', key: 'hr', childKeys: 'x' }, { kind: 'k', key: 'hr', childKeys: ['a', 'a'] }, { kind: 'k', key: 'hr', childKeys: [''] }]) {
    await assert.rejects(() => creates.run(bad, execute), TypeError);
  }
  await assert.rejects(() => creates.run({ kind: 'k', key: 'hr' }, null), TypeError);
  assert.equal(calls, 0);
  assert.throws(() => createPassthroughCreates({ newId: 'x' }), TypeError);
});

test('creates port: a field security profile is created through it with the minted ids, and a create that fails halts the step', async () => {
  const desired = fls.desiredProfile({ key: 'hr', name: 'HR Salary', permissions: [{ table: 'new_employee', column: 'new_salary', read: true }] });
  const plan = { operations: [{ key: 'fieldSecurityProfile:hr', kind: 'fieldSecurityProfile', target: 'hr', desired }] };
  const sdkOf = (createError) => {
    const calls = [];
    return {
      calls,
      createArtifact: async (kind, a) => { calls.push(['createArtifact', kind, a]); if (createError) throw createError; return a; },
      pushArtifact: async (kind, id) => { calls.push(['pushArtifact', kind, id]); return { saved: true }; },
    };
  };
  const sdk = sdkOf();
  const result = await fls.applyFieldSecurity(plan, { sdk, creates: createPassthroughCreates({ newId: sequence() }) });
  assert.deepEqual(result.saved, ['fieldSecurityProfile:hr']);
  assert.deepEqual(result.managedBindings, [{ kind: 'fieldSecurityProfile', key: 'hr', id: '00000000-0000-4000-8000-000000000001', origin: 'created' }]);
  const created = sdk.calls[0][2];
  assert.equal(created.id, '00000000-0000-4000-8000-000000000001');
  assert.deepEqual(created.permissions.map((p) => p.id), ['00000000-0000-4000-8000-000000000002']);
  assert.deepEqual(sdk.calls.map((c) => c[0]), ['createArtifact', 'pushArtifact']);
  // An answer lost on the way back is not swallowed into an "unknown" result: the error reaches the build's halt and retry policy.
  const lost = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  const failing = sdkOf(lost);
  await assert.rejects(() => fls.applyFieldSecurity(plan, { sdk: failing, creates: createPassthroughCreates() }), (e) => e === lost);
  assert.deepEqual(failing.calls.map((c) => c[0]), ['createArtifact']);
});

// A wiring site asks the port whether it protects a kind through portProtects / portIdentityFor, never through creates.protects:
// the default port the build constructs without createIdentity (createPassthroughCreates) has only `run`, and a test may inject any
// `{ run }` double, so a direct call would throw "protects is not a function" on every legacy build.
test('creates port: the plain port and a { run } double protect nothing, through the wiring helpers', () => {
  const { portProtects, portIdentityFor } = require('../lib/creates-passthrough.js');
  const plain = createPassthroughCreates();
  assert.deepEqual(Object.keys(plain), ['run'], 'the plain port keeps its one method');
  for (const port of [plain, { run: async () => ({}) }, undefined, null]) {
    for (const kind of ['form', 'view', 'chart', 'dashboard', 'fieldSecurityProfile']) {
      assert.equal(portProtects(port, kind), false);
      assert.equal(portIdentityFor(port, kind, 'k'), null);
    }
  }
});

test('creates port: the helpers answer a stable port exactly as it answers, and refuse a port that protects without ids', () => {
  const { portProtects, portIdentityFor } = require('../lib/creates-passthrough.js');
  const calls = [];
  const port = { run: async () => ({}), protects: (k) => { calls.push(['protects', k]); return k === 'form' ? 1 : 0; }, identityFor: (k, key) => { calls.push(['identityFor', k, key]); return { id: `id-${key}`, childIds: {} }; } };
  assert.equal(portProtects(port, 'form'), true, 'a truthy answer is true');
  assert.equal(portProtects(port, 'view'), false);
  assert.deepEqual(portIdentityFor(port, 'form', 'k1'), { id: 'id-k1', childIds: {} });
  assert.equal(portIdentityFor(port, 'view', 'k2'), null, 'an unprotected kind is never asked for ids');
  assert.deepEqual(calls, [['protects', 'form'], ['protects', 'view'], ['protects', 'form'], ['identityFor', 'form', 'k1'], ['protects', 'view']]);
  assert.throws(() => portIdentityFor({ run() {}, protects: () => true }, 'form', 'k'), /protects 'form' but has no identityFor/);
});