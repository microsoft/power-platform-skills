'use strict';

// The publication port: what features owe is published once, through the build's own SDK app writer, and an app that
// asked for exact Main-form membership cannot be published around the SDK's guard.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAppPublication } = require('../lib/app-publication-policy.js');

const APP = '11111111-0000-4000-8000-000000000001';
const OTHER = '11111111-0000-4000-8000-000000000009';
const VIEW_ID = '66666666-0000-4000-8000-000000000001';
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
  port.queue({ kind: 'app', id: APP, reason: 'app.tables' });
  port.queue({ kind: 'app', id: `{${APP.toUpperCase()}}`, reason: 'pages' });
  port.queue({ kind: 'app', id: APP, reason: 'app.tables' });
  port.queue({ kind: 'table', id: 'contoso_item' });
  assert.deepEqual(port.owed(), [{ kind: 'app', id: APP, reasons: ['app.tables', 'pages'] }, { kind: 'table', id: 'contoso_item', reasons: [] }]);
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
  port.queue({ kind: 'app', id: APP, reason: 'app.tables' });
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

test('an existing app publish through publishApp pays the queued app work: queue -> publishApp -> flush publishes the app exactly once', async () => {
  const appWrite = writer();
  const port = createAppPublication({ appWrite });
  port.queue({ kind: 'app', id: APP, reason: 'app.tables' });
  const answer = await port.publishApp(APP);
  assert.deepEqual(answer, { type: 'app', id: APP, shipped: true, publish: { kind: 'submitted' } }, 'the PublishResult comes back as it came');
  assert.deepEqual(port.owed(), []);
  assert.deepEqual(await port.flush(), { published: [], withheld: [], failed: [] });
  assert.deepEqual(appWrite.calls, [APP], 'one app publish in all');
});

test('publishApp: a publish answered failed keeps the app owed; a throw propagates and keeps it owed; no writer is refused by code', async () => {
  const failing = createAppPublication({ appWrite: writer({ [APP]: { publish: { kind: 'failed', error: { code: 'APP_MAIN_FORM_PUBLISH_WITHHELD' } } } }) });
  failing.queue({ kind: 'app', id: APP, reason: 'app.tables' });
  assert.equal((await failing.publishApp(APP)).publish.kind, 'failed');
  assert.equal(failing.owed().length, 1);
  const thrown = Object.assign(new Error('lost'), { code: 'ECONNRESET' });
  const throwing = createAppPublication({ appWrite: writer({ [APP]: thrown }) });
  throwing.queue({ kind: 'app', id: APP });
  await assert.rejects(throwing.publishApp(APP), (error) => error === thrown);
  assert.equal(throwing.owed().length, 1);
  await assert.rejects(createAppPublication({}).publishApp(APP), { code: 'APP_PUBLICATION_UNAVAILABLE' });
});

test('notePublished settles an exact obligation only on a published-layer proof that matches; no reader or no list keeps it pending', async () => {
  const proofClient = (members) => ({
    get: async (path) => {
      if (path.startsWith(`/appmodules(${APP})`)) return { status: 200, body: { appmoduleidunique: '11111111-0000-4000-8000-000000000002' } };
      if (path.startsWith('/appmodulecomponents')) return { status: 200, body: { value: members.map((objectid) => ({ objectid, componenttype: 60 })) } };
      if (path.startsWith('/systemforms')) {
        return { status: 200, body: { value: members.filter((id) => path.includes(id)).map((formid) => ({ formid, type: 2, objecttypecode: 'contoso_item', name: formid })) } };
      }
      return { status: 404, body: null };
    },
  });
  const FORM_A = '33333333-0000-4000-8000-000000000001';
  const FORM_B = '33333333-0000-4000-8000-000000000002';
  const MAIN = { contoso_item: [FORM_A] };

  const matched = createAppPublication({ appWrite: writer(), client: proofClient([FORM_A]) });
  matched.recordExact(APP, exactPush('notRead'), { name: 'Membership', mainFormsByTable: MAIN });
  await matched.publishApp(APP);
  assert.deepEqual(matched.unsettled(), []);

  const differs = createAppPublication({ appWrite: writer(), client: proofClient([FORM_A, FORM_B]) });
  differs.recordExact(APP, exactPush('notRead'), { name: 'Membership', mainFormsByTable: MAIN });
  await differs.publishApp(APP);
  assert.equal(differs.unsettled().length, 1);
  assert.match(differs.unsettled()[0].reason, /differs/);
  assert.equal(differs.unsettled()[0].code, 'APP_MAIN_FORMS_NOT_EXACT');

  const unread = createAppPublication({ appWrite: writer(), client: { get: async () => ({ status: 500, body: null }) } });
  unread.recordExact(APP, exactPush('notRead'), { name: 'Membership', mainFormsByTable: MAIN });
  await unread.publishApp(APP);
  assert.match(unread.unsettled()[0].reason, /unreadable/);

  const noReader = createAppPublication({ appWrite: writer() });
  noReader.recordExact(APP, exactPush('notRead'), { name: 'Membership', mainFormsByTable: MAIN });
  await noReader.publishApp(APP);
  assert.equal(noReader.unsettled().length, 1, 'never settled without a read');
});

test('a queued non-app publication is bridged to its scope: deferred to the build, published by flush, or reported as unbridged', async () => {
  const deferred = [];
  const published = [];
  const scopes = {
    table: {
      owe: (target) => { deferred.push(target.id); return target.id === 'contoso_item'; },
      publish: async (target) => { published.push(target.id); return { type: 'table', id: target.id, shipped: true, publish: { kind: 'submitted' } }; },
    },
  };
  const port = createAppPublication({ appWrite: writer(), scopes });
  port.queue({ kind: 'table', id: 'contoso_item', artifact: { type: 'view', id: VIEW_ID }, reason: 'quickFind' });
  port.queue({ kind: 'table', id: 'contoso_other', artifact: { type: 'view', id: VIEW_ID }, reason: 'quickFind' });
  port.queue({ kind: 'webResource', id: VIEW_ID, reason: 'logo' });
  assert.deepEqual(deferred, ['contoso_item', 'contoso_other']);
  assert.deepEqual(port.deferred('table'), ['contoso_item'], 'the build\'s own table publication will publish it');
  assert.deepEqual(port.owed().map((entry) => `${entry.kind}:${entry.id}${entry.deferred ? ':deferred' : ''}`), ['table:contoso_item:deferred', 'table:contoso_other', `webResource:${VIEW_ID}`], 'a deferral is still owed');
  port.noteScopePublished('table', 'CONTOSO_ITEM');
  const out = await port.flush();
  assert.deepEqual(published, ['contoso_other']);
  assert.deepEqual(out.failed, []);
  assert.deepEqual(port.owed().map((entry) => entry.kind), ['webResource']);
  assert.deepEqual(port.unsettled(), [{ kind: 'webResource', id: VIEW_ID, code: 'PUBLICATION_SCOPE_UNBRIDGED', reason: `a webResource publication of '${VIEW_ID}' was queued, but this build has no way to publish it` }]);

  const broken = createAppPublication({ appWrite: writer(), scopes: { table: { owe: () => false, publish: async () => { throw Object.assign(new Error('x'), { code: 'PUBLISH_FAILED' }); } } } });
  broken.queue({ kind: 'table', id: 'contoso_item', artifact: { type: 'view', id: VIEW_ID } });
  assert.deepEqual((await broken.flush()).failed, [{ kind: 'table', id: 'contoso_item', code: 'PUBLISH_FAILED', reasons: [] }]);
  assert.equal(broken.owed().length, 1, 'still owed');
});

test('a table publish is paid only by an accepted PublishXml: a failed-by-value or unconfirmed answer stays owed and is reported failed', async () => {
  const answers = {
    contoso_refused: { type: 'table', id: 'contoso_refused', shipped: false, publish: { kind: 'failed', error: { code: 'CONNECTION_ERROR', statusCode: 403 } } },
    contoso_silent: undefined,
    contoso_unread: { type: 'table', id: 'contoso_unread', shipped: true, publish: { kind: 'unverifiable' } },
    contoso_verified: { type: 'table', id: 'contoso_verified', shipped: true, publish: { kind: 'verified' } },
  };
  const calls = [];
  const port = createAppPublication({ appWrite: writer(), scopes: { table: { owe: () => false, publish: async (target) => { calls.push(target.id); return answers[target.id]; } } } });
  for (const id of Object.keys(answers)) port.queue({ kind: 'table', id, artifact: { type: 'view', id: VIEW_ID }, reason: 'quickFind' });
  const out = await port.flush();
  assert.deepEqual(out.published, ['contoso_unread', 'contoso_verified']);
  assert.deepEqual(out.failed, [
    { kind: 'table', id: 'contoso_refused', code: 'CONNECTION_ERROR', reasons: ['quickFind'] },
    { kind: 'table', id: 'contoso_silent', code: 'PUBLICATION_UNCONFIRMED', reasons: ['quickFind'] },
  ]);
  assert.deepEqual(port.owed().map((entry) => entry.id), ['contoso_refused', 'contoso_silent'], 'a requested publication that did not happen is still owed');
  assert.ok(!JSON.stringify(out).includes('403'), 'reported by code');
  const again = await port.flush();
  assert.deepEqual(again.failed.map((row) => row.id), ['contoso_refused', 'contoso_silent']);
  assert.deepEqual(calls, Object.keys(answers), 'a refused target is not published again by the same build');
});

test('a table deferred to the build stays owed until the build reports its publication: published pays, refused fails, unreported is published at flush', async () => {
  const calls = [];
  const scopes = { table: { owe: () => true, publish: async (target) => { calls.push(target.id); return { type: 'table', id: target.id, shipped: true, publish: { kind: 'submitted' } }; } } };
  const port = createAppPublication({ appWrite: writer(), scopes });
  for (const id of ['contoso_paid', 'contoso_refused', 'contoso_unreported']) port.queue({ kind: 'table', id, reason: 'quickFind' });
  assert.deepEqual(port.deferred('table'), ['contoso_paid', 'contoso_refused', 'contoso_unreported']);
  port.noteScopePublished('table', 'contoso_paid');
  port.noteScopePublished('table', 'contoso_refused', { error: { code: 'CONNECTION_ERROR', statusCode: 403, message: 'raw text' } });
  port.noteScopePublished('table', 'contoso_never_queued');
  assert.deepEqual(port.deferred('table'), ['contoso_unreported']);
  const out = await port.flush();
  assert.deepEqual(out.published, ['contoso_unreported']);
  assert.deepEqual(out.failed, [{ kind: 'table', id: 'contoso_refused', code: 'CONNECTION_ERROR', reasons: ['quickFind'] }]);
  assert.deepEqual(calls, ['contoso_unreported'], 'the refused table is not published again: the build already made its attempt');
  assert.deepEqual(port.owed().map((entry) => entry.id), ['contoso_refused']);
  assert.ok(!JSON.stringify(out).includes('raw text'));

  port.queue({ kind: 'table', id: 'contoso_refused', reason: 'form' });
  assert.deepEqual(port.deferred('table'), ['contoso_refused'], 'queued again, it is the next publication\'s to attempt');
});

test('an exact app is proven by every publish: a later differing or unreadable read, or a lost publish answer, un-proves it; a refused publish keeps the proof', async () => {
  const FORM_A = '33333333-0000-4000-8000-000000000001';
  const FORM_B = '33333333-0000-4000-8000-000000000002';
  const state = { members: [FORM_A], status: 200 };
  const client = {
    get: async (path) => {
      if (state.status !== 200) return { status: state.status, body: null };
      if (path.startsWith(`/appmodules(${APP})`)) return { status: 200, body: { appmoduleidunique: '11111111-0000-4000-8000-000000000002' } };
      if (path.startsWith('/appmodulecomponents')) return { status: 200, body: { value: state.members.map((objectid) => ({ objectid, componenttype: 60 })) } };
      if (path.startsWith('/systemforms')) {
        return { status: 200, body: { value: state.members.filter((id) => path.includes(id)).map((formid) => ({ formid, type: 2, objecttypecode: 'contoso_item', name: formid })) } };
      }
      return { status: 404, body: null };
    },
  };
  const answers = {};
  const appWrite = writer(answers);
  const port = createAppPublication({ appWrite, client });
  port.recordExact(APP, exactPush('notRead'), { name: 'Membership', mainFormsByTable: { contoso_item: [FORM_A] } });
  await port.publishApp(APP);
  assert.deepEqual(port.unsettled(), []);
  await port.publishApp(APP);
  assert.deepEqual(port.unsettled(), [], 'a second matching publish stays proven');

  state.members = [FORM_A, FORM_B];
  await port.publishApp(APP);
  assert.equal(port.unsettled().length, 1, 'a later publish that shipped another membership is not exact');
  assert.match(port.unsettled()[0].reason, /differs/);

  state.members = [FORM_A];
  await port.publishApp(APP);
  assert.deepEqual(port.unsettled(), []);
  state.status = 500;
  await port.publishApp(APP);
  assert.match(port.unsettled()[0].reason, /unreadable/, 'a later publish that cannot be read back is unproven');

  state.status = 200;
  await port.publishApp(APP);
  assert.deepEqual(port.unsettled(), []);
  answers[APP] = { type: 'app', id: APP, shipped: false, publish: { kind: 'failed', error: { code: 'CONNECTION_ERROR' } } };
  state.members = [FORM_A, FORM_B];
  await port.publishApp(APP);
  assert.deepEqual(port.unsettled(), [], 'a refused publish shipped nothing, so the proof stands');

  answers[APP] = Object.assign(new Error('lost'), { code: 'ECONNRESET' });
  await assert.rejects(port.publishApp(APP), { code: 'ECONNRESET' });
  assert.equal(port.unsettled().length, 1, 'a lost answer may have shipped anything');
  assert.match(port.unsettled()[0].reason, /not answered \(ECONNRESET\)/);
});

test('the published-layer proof reads strictly: a component row it cannot place makes the proof unreadable, never a match', async () => {
  const FORM_A = '33333333-0000-4000-8000-000000000001';
  const client = {
    get: async (path) => {
      if (path.startsWith(`/appmodules(${APP})`)) return { status: 200, body: { appmoduleidunique: '11111111-0000-4000-8000-000000000002' } };
      if (path.startsWith('/appmodulecomponents')) return { status: 200, body: { value: [{ objectid: FORM_A, componenttype: 60 }, { objectid: '33333333-0000-4000-8000-000000000002', componenttype: 'sixty' }] } };
      if (path.startsWith('/systemforms')) return { status: 200, body: { value: [{ formid: FORM_A, type: 2, objecttypecode: 'contoso_item', name: 'A' }] } };
      return { status: 404, body: null };
    },
  };
  const port = createAppPublication({ appWrite: writer(), client });
  port.recordExact(APP, exactPush('notRead'), { name: 'Membership', mainFormsByTable: { contoso_item: [FORM_A] } });
  await port.publishApp(APP);
  assert.equal(port.unsettled().length, 1);
  assert.match(port.unsettled()[0].reason, /unreadable \(.*cannot place/);
});
