'use strict';

// The publication port: what features owe is published once, through the build's own SDK app writer, and an app that
// asked for exact Main-form membership cannot be published around the SDK's guard.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAppPublication } = require('../lib/app-publication-policy.js');

const APP = '11111111-0000-4000-8000-000000000001';
const OTHER = '11111111-0000-4000-8000-000000000009';
const exactPush = (published, membership = 'exact') => ({ saved: true, appMainForms: { mode: 'exact', tables: [{ table: 'contoso_item', membership }], published } });

function writer(answers = {}) {
  const calls = [];
  return {
    calls,
    publish: async (id) => {
      calls.push(id);
      const answer = answers[id];
      if (answer instanceof Error) throw answer;
      return answer || { type: 'app', id, shipped: true, publish: { kind: 'submitted' } };
    },
  };
}

test('queue: one entry per kind and id (any case or braces), every reason kept, a target without kind or id refused', () => {
  const port = createAppPublication({ appWrite: writer() });
  port.queue({ kind: 'app', id: APP, reason: 'app.theme' });
  port.queue({ kind: 'app', id: `{${APP.toUpperCase()}}`, reason: 'pages' });
  port.queue({ kind: 'app', id: APP, reason: 'app.theme' });
  port.queue({ kind: 'table', id: 'contoso_item' });
  assert.deepEqual(port.owed(), [{ kind: 'app', id: APP, reasons: ['app.theme', 'pages'] }, { kind: 'table', id: 'contoso_item', reasons: [] }]);
  assert.throws(() => port.queue({ kind: 'app' }), { code: 'PUBLICATION_TARGET_INVALID' });
});

test('flush publishes each owed app once through appWrite.publish and clears it; other kinds are left for the build', async () => {
  const appWrite = writer();
  const port = createAppPublication({ appWrite });
  port.queue({ kind: 'app', id: APP, reason: 'a' });
  port.queue({ kind: 'app', id: APP, reason: 'b' });
  port.queue({ kind: 'app', id: OTHER });
  port.queue({ kind: 'table', id: 'contoso_item' });
  assert.deepEqual(await port.flush(), { published: [APP, OTHER], withheld: [], failed: [] });
  assert.deepEqual(appWrite.calls, [APP, OTHER]);
  assert.deepEqual(port.owed().map((entry) => entry.kind), ['table']);
  assert.deepEqual(await port.flush(), { published: [], withheld: [], failed: [] }, 'nothing is published twice');
});

test('a withheld exact publish (thrown or answered as failed) stays owed and is reported by code; other failures are failed', async () => {
  const withheld = Object.assign(new Error('raw text'), { code: 'APP_MAIN_FORM_PUBLISH_WITHHELD' });
  const appWrite = writer({
    [APP]: withheld,
    [OTHER]: { type: 'app', id: OTHER, shipped: false, publish: { kind: 'failed', error: { code: 'APP_MAIN_FORM_PUBLISH_CONFLICT' } } },
  });
  const port = createAppPublication({ appWrite });
  port.queue({ kind: 'app', id: APP });
  port.queue({ kind: 'app', id: OTHER });
  const out = await port.flush();
  assert.deepEqual(out, { published: [], withheld: [{ id: APP, code: 'APP_MAIN_FORM_PUBLISH_WITHHELD' }, { id: OTHER, code: 'APP_MAIN_FORM_PUBLISH_CONFLICT' }], failed: [] });
  assert.ok(!JSON.stringify(out).includes('raw text'));
  assert.equal(port.owed().length, 2, 'still owed');

  const failing = createAppPublication({ appWrite: writer({ [APP]: { publish: { kind: 'failed' } } }) });
  failing.queue({ kind: 'app', id: APP });
  assert.deepEqual(await failing.flush(), { published: [], withheld: [], failed: [{ id: APP, code: 'APP_PUBLISH_FAILED' }] });
  const unavailable = createAppPublication({});
  unavailable.queue({ kind: 'app', id: APP });
  assert.deepEqual((await unavailable.flush()).failed, [{ id: APP, code: 'APP_PUBLICATION_UNAVAILABLE' }]);
});

test('exact obligation: raw publish refused once recorded, unsettled until a push proves it published, and a proven push settles the owed app', () => {
  const port = createAppPublication({ appWrite: writer() });
  port.assertRawPublishAllowed(APP);
  port.queue({ kind: 'app', id: APP, reason: 'app.theme' });
  const pending = port.recordExact(APP, exactPush('notRead'), 'Membership');
  assert.equal(pending.done, false);
  assert.throws(() => port.assertRawPublishAllowed(APP.toUpperCase()), { code: 'APP_PUBLISH_BYPASS_REFUSED' });
  port.assertRawPublishAllowed(OTHER);
  assert.deepEqual(port.unsettled().map((row) => row.appId), [APP]);
  assert.equal(port.owed().length, 1);
  assert.equal(port.recordExact(APP, exactPush('matches')).done, true);
  assert.deepEqual(port.unsettled(), []);
  assert.deepEqual(port.owed(), [], 'the proven publish settled what was owed');
  assert.throws(() => port.assertRawPublishAllowed(APP), { code: 'APP_PUBLISH_BYPASS_REFUSED' }, 'still only through the SDK writer');
  assert.equal(port.recordExact(APP, exactPush('matches', 'inconclusive')).done, false, 'the last answer stands');
  assert.equal(port.unsettled().length, 1);
});
