'use strict';
// A push is skipped only on the SDK's own proof that the workspace copy equals what was last synced, and
// every doubt reads as "changed". The behaviour against the real bundle is pinned in rebuild-writes-real-bundle.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { hasUnsyncedEdits } = require('../lib/unsynced-edits.js');

const sdkWith = (diff) => ({ diffArtifact: async (type, id) => (typeof diff === 'function' ? diff(type, id) : diff) });

test('unsynced edits: an empty diff is the only proof of "nothing to push"', async () => {
  assert.equal(await hasUnsyncedEdits(sdkWith({ artifactType: 'view', artifactId: 'v', changes: [] }), 'view', 'v'), false);
  assert.equal(await hasUnsyncedEdits(sdkWith({ changes: [{ pointer: '/columns/1', type: 'added', newValue: {} }] }), 'view', 'v'), true);
});

test('unsynced edits: the diff is asked about the artifact in question', async () => {
  const asked = [];
  await hasUnsyncedEdits(sdkWith((type, id) => { asked.push([type, id]); return { changes: [] }; }), 'form', 'f-1');
  assert.deepEqual(asked, [['form', 'f-1']]);
});

test('unsynced edits: anything short of a clear answer reads as changed (fail open: write as before)', async () => {
  assert.equal(await hasUnsyncedEdits(undefined, 'view', 'v'), true, 'no SDK');
  assert.equal(await hasUnsyncedEdits({}, 'view', 'v'), true, 'an SDK without the method');
  assert.equal(await hasUnsyncedEdits({ diffArtifact: async () => { throw new Error('workspace file unreadable'); } }, 'view', 'v'), true, 'a diff that throws');
  assert.equal(await hasUnsyncedEdits({ diffArtifact: () => { throw new Error('sync throw'); } }, 'view', 'v'), true, 'a diff that throws synchronously');
  for (const odd of [undefined, null, {}, { changes: null }, { changes: 'none' }, { changes: {} }, 0, '']) {
    assert.equal(await hasUnsyncedEdits(sdkWith(odd), 'view', 'v'), true, `diff answer ${JSON.stringify(odd)}`);
  }
});
