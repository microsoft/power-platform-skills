// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import test from 'node:test';
import assert from 'node:assert/strict';
import { CorrelationSession } from '../src/correlation.mjs';

test('request scopes are independent, restore nested context and retire stale owners', async () => {
  const session = new CorrelationSession(), a = session.newRequest(), b = session.newRequest();
  assert.notEqual(a.clientRequestId, b.clientRequestId);
  assert.equal(a.clientSessionId, b.clientSessionId);
  assert.notEqual(a.clientSessionId, new CorrelationSession().clientSessionId);
  await Promise.all([a, b].map(owner => session.run(owner, async () => {
    await Promise.resolve();
    assert.equal(session.capture(), owner);
    await session.sessionOnly(async () => assert.equal(session.capture().clientRequestId, undefined));
    await assert.rejects(session.sessionOnly(async () => { throw new Error('fixture'); }));
    assert.equal(session.capture(), owner);
  })));
  assert.equal(session.capture().clientRequestId, undefined);
  session.retire(a);
  await session.run(a, async () => assert.equal(session.capture().clientRequestId, undefined));
  await session.run({ clientRequestId: 'untrusted' }, async () => assert.equal(session.capture().clientRequestId, undefined));
});

test('request helper retires its owner on success or failure without collecting diagnostics', async () => {
  const session = new CorrelationSession();
  let first, second;
  assert.equal(await session.request(async () => { first = session.capture(); return 'ok'; }), 'ok');
  await assert.rejects(session.request(async () => { second = session.capture(); throw new Error('fixture'); }), /fixture/);
  assert.notEqual(first.clientRequestId, second.clientRequestId);
  for (const owner of [first, second])
    session.run(owner, () => assert.equal(session.capture(), session.sessionOwner));
});
