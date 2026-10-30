'use strict';

// app.mainFormsOnUpdate "exact" and app.pinDeclaredArtifacts, through the REAL vendored SDK (helpers/app-pin-server.js),
// plus the plugin-side rules that decide what reaches it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyAppMainForms, pinDeclaredArtifacts, declaredAppPins, appComponentsFor, exactMembershipOutcome } = require('../lib/app-components.js');
const { APP, FORM_A, FORM_B, META } = require('./helpers/app-membership-sdk.js');
const { createAppPublication } = require('../lib/app-publication-policy.js');
const { appPinServer, SITEMAP, VIEW, CHART, OFFNAV_CHART, FORM_QUICK, OFFNAV_FORM_A, OFFNAV_FORM_B } = require('./helpers/app-pin-server.js');

const MAIN = { contoso_item: [FORM_A] };
const writes = (state) => state.requests.filter((line) => !line.startsWith('GET '));

async function fetched(t, options) {
  const server = appPinServer(t, options);
  await server.sdk.initWorkspace();
  await server.sdk.fetchArtifact('app', APP);
  return server;
}

test('REAL BUNDLE: pinDeclaredArtifacts pins a chart of a table the navigation does not name; without it the push does not', async (t) => {
  const plain = await fetched(t);
  await applyAppMainForms(plain.sdk, APP, MAIN);
  assert.equal((await plain.sdk.pushArtifact('app', APP)).saved, true);
  assert.ok(!plain.state.members.has(`59:${OFFNAV_CHART}`), 'the default spec derives no off-navigation chart');
  assert.ok(!writes(plain.state).join('\n').includes(OFFNAV_CHART));

  const pinned = await fetched(t);
  await applyAppMainForms(pinned.sdk, APP, MAIN);
  assert.deepEqual(await pinDeclaredArtifacts(pinned.sdk, APP, { charts: [OFFNAV_CHART] }), { added: 1 });
  const pushed = await pinned.sdk.pushArtifact('app', APP);
  assert.equal(pushed.saved, true, JSON.stringify(pushed.error && pushed.error.message));
  assert.ok(pinned.state.members.has(`59:${OFFNAV_CHART}`), 'the declared chart joined the app');
  for (const key of [`1:${META.contoso_item}`, `60:${FORM_A}`, `26:${VIEW}`, `59:${CHART}`]) assert.ok(pinned.state.members.has(key), key);
});

test('REAL BUNDLE: exact removes only the listed table\'s other Main form, in one guarded change set, and stays owed until published', async (t) => {
  const server = await fetched(t, { members: [`1:${META.contoso_item}`, `62:${SITEMAP}`, `60:${FORM_B}`, `26:${VIEW}`, `59:${CHART}`] });
  await applyAppMainForms(server.sdk, APP, MAIN, { mainFormsOnUpdate: 'exact' });
  assert.equal((await server.sdk.getArtifact('app', APP)).components.mainFormsOnUpdate, 'exact');
  const pushed = await server.sdk.pushArtifact('app', APP);
  assert.equal(pushed.saved, true, JSON.stringify(pushed.error && pushed.error.message));
  assert.ok(!server.state.members.has(`60:${FORM_B}`), 'the unlisted Main form left the app');
  assert.ok(server.state.members.has(`60:${FORM_A}`));
  for (const key of [`1:${META.contoso_item}`, `26:${VIEW}`, `59:${CHART}`]) assert.ok(server.state.members.has(key), `${key} is not a Main form and stays`);
  const removal = writes(server.state).filter((line) => line.includes('/RemoveAppComponents'));
  assert.equal(removal.length, 1, writes(server.state).join('\n'));
  assert.match(removal[0], /^BATCH PATCH \/appmodules\(/, 'the removal is bound to the app token by the change set\'s first PATCH');
  assert.ok(writes(server.state).every((line) => !/appmodules\((?!11111111-0000-4000-8000-000000000001\))/.test(line)), 'no other app is written');
  assert.ok(!/RemoveAppComponents[^|]*(contoso_items|savedquery)/.test(removal[0]), 'only forms are removed');
  assert.equal(pushed.appMainForms && pushed.appMainForms.mode, 'exact');
  const outcome = exactMembershipOutcome(pushed, 'Membership');
  assert.equal(outcome.done, false, 'saved but not proven published is still owed');
  assert.match(outcome.reason, /not proven published|not exact/);
});

test('REAL BUNDLE: exact against an app that moved since the fetch removes nothing and keeps the concurrent edit', async (t) => {
  const server = await fetched(t, { members: [`1:${META.contoso_item}`, `62:${SITEMAP}`, `60:${FORM_B}`] });
  await applyAppMainForms(server.sdk, APP, MAIN, { mainFormsOnUpdate: 'exact' });
  server.state.version += 1;
  server.state.name = 'Renamed elsewhere';
  const pushed = await server.sdk.pushArtifact('app', APP).catch((error) => ({ saved: false, error }));
  assert.equal(pushed.saved, false, 'a moved app is a conflict, not a silent overwrite');
  assert.ok(server.state.members.has(`60:${FORM_B}`), 'no Main form left the app');
  assert.equal(server.state.name, 'Renamed elsewhere');
  assert.ok(!writes(server.state).some((line) => line.includes('/RemoveAppComponents')), writes(server.state).join('\n'));
});

test('REAL BUNDLE: exact through a client that cannot send a change set is refused before any write', async (t) => {
  const server = await fetched(t, { members: [`1:${META.contoso_item}`, `62:${SITEMAP}`, `60:${FORM_B}`] });
  delete server.httpClient.postRaw;
  await applyAppMainForms(server.sdk, APP, MAIN, { mainFormsOnUpdate: 'exact' });
  const pushed = await server.sdk.pushArtifact('app', APP).catch((error) => ({ saved: false, error }));
  assert.equal(pushed.saved, false);
  assert.equal(pushed.error.code, 'APP_MAIN_FORM_REMOVAL_UNSUPPORTED');
  assert.deepEqual(writes(server.state), []);
  assert.ok(server.state.members.has(`60:${FORM_B}`), 'no fall back to addOnly');
});

// --- plugin-side rules, no SDK -------------------------------------------------------------------------------------

function recordingProvision(artifact, classified = []) {
  const calls = [];
  return {
    calls,
    artifact,
    dataverse: { get: async (url) => { calls.push(['get', url]); return { status: 200, body: { value: classified } }; } },
    getArtifact: async () => { calls.push(['getArtifact']); return JSON.parse(JSON.stringify(artifact)); },
    addElement: async (type, id, pointer, value) => { calls.push(['addElement', pointer, value]); Object.assign(artifact, value); },
    updateElement: async (type, id, pointer, value) => { calls.push(['updateElement', pointer, value]); artifact.components = value; },
  };
}

test('applyAppMainForms: "exact" without a non-empty list is refused before anything is read', async () => {
  for (const list of [undefined, {}, { contoso_item: [] }]) {
    const provision = recordingProvision({ components: { forms: [] } });
    await assert.rejects(applyAppMainForms(provision, APP, list, { mainFormsOnUpdate: 'exact' }), { code: 'APP_MAIN_FORMS_EXACT_INVALID' });
    assert.deepEqual(provision.calls, []);
  }
});

test('applyAppMainForms: omitted and "addOnly" make exactly the calls the old path made', async () => {
  const runs = [];
  for (const options of [undefined, {}, { mainFormsOnUpdate: 'addOnly' }]) {
    const provision = recordingProvision({ components: { forms: [FORM_A], views: [VIEW] } });
    await applyAppMainForms(provision, APP, MAIN, options);
    runs.push(provision.calls);
  }
  assert.deepEqual(runs[1], runs[0]);
  assert.deepEqual(runs[2], runs[0]);
  assert.deepEqual(runs[0].at(-1), ['updateElement', '/components', { forms: [FORM_A], views: [VIEW], mainFormsByTable: MAIN }]);
});

test('pinDeclaredArtifacts: union only — existing pins stay, duplicates are not added, an excluded Main form is skipped, nothing new writes nothing', async () => {
  const other = '88888888-0000-4000-8000-000000000001';
  const provision = recordingProvision({ components: { forms: [], views: [other], charts: [], dashboards: [], mainFormsByTable: MAIN } },
    [{ formid: FORM_B, type: 2, objecttypecode: 'contoso_item', name: 'Alternate' }]);
  const result = await pinDeclaredArtifacts(provision, APP, { forms: [FORM_A, FORM_B], views: [other.toUpperCase(), VIEW], charts: [OFFNAV_CHART] });
  assert.deepEqual(result, { added: 3 });
  assert.deepEqual(provision.artifact.components.forms, [FORM_A]);
  assert.deepEqual(provision.artifact.components.views, [other, VIEW]);
  assert.deepEqual(provision.artifact.components.charts, [OFFNAV_CHART]);
  assert.deepEqual(provision.artifact.components.mainFormsByTable, MAIN);
  const before = provision.calls.length;
  assert.deepEqual(await pinDeclaredArtifacts(provision, APP, { views: [VIEW] }), { added: 0 });
  assert.ok(!provision.calls.slice(before).some(([kind]) => kind === 'updateElement' || kind === 'addElement'));
  const untouched = recordingProvision({});
  assert.deepEqual(await pinDeclaredArtifacts(untouched, APP, { forms: [] }), { added: 0 });
  assert.deepEqual(untouched.calls, [], 'nothing declared reads nothing');
});

test('declaredAppPins: the ids the build resolved, dashboards included', () => {
  assert.deepEqual(declaredAppPins({ forms: { contoso_item: FORM_A }, views: { a: VIEW }, charts: { c: CHART, empty: '' }, dashboards: { Overview: OFFNAV_CHART } }),
    { forms: [FORM_A], views: [VIEW], charts: [CHART], dashboards: [OFFNAV_CHART] });
});

test('exactMembershipOutcome: only every table exact AND the published layer matching is done', () => {
  const pushed = (tables, published) => ({ appMainForms: { mode: 'exact', tables, published } });
  assert.equal(exactMembershipOutcome(pushed([{ table: 'contoso_item', membership: 'exact' }], 'matches')).done, true);
  for (const published of ['differs', 'unreadable', 'notRead', undefined]) {
    assert.equal(exactMembershipOutcome(pushed([{ table: 'contoso_item', membership: 'exact' }], published)).done, false, String(published));
  }
  assert.equal(exactMembershipOutcome(pushed([{ table: 'contoso_item', membership: 'inconclusive', reason: 'read failed' }], 'matches')).done, false);
  assert.equal(exactMembershipOutcome(pushed([], 'matches')).done, false, 'no table rows is not proof');
  assert.equal(exactMembershipOutcome({ appMainForms: { mode: 'addOnly', tables: [] } }).done, false);
  assert.equal(exactMembershipOutcome({}).done, false);
});

// The build's result.created as the engine fills it (sdk-build.js): `forms` keeps ONE Main form per table (the last one
// created), `formIds` every declared form, keyed "<table>|<formType>|<name>".
const DECLARED = {
  forms: { contoso_item: FORM_B, contoso_other: OFFNAV_FORM_B },
  formIds: {
    'contoso_item|Main|Summary': FORM_A, 'contoso_item|Main|Alternate': FORM_B, 'contoso_item|QuickCreate|Quick': FORM_QUICK,
    'contoso_other|Main|Other summary': OFFNAV_FORM_A, 'contoso_other|Main|Other detail': OFFNAV_FORM_B,
  },
  views: { a: VIEW }, charts: { c: OFFNAV_CHART }, dashboards: {},
};

test('REAL BUNDLE: pinDeclaredArtifacts pins every declared form (several Main forms off the navigation, a Quick Create), never a Main form the list leaves out', async (t) => {
  const server = await fetched(t);
  await applyAppMainForms(server.sdk, APP, MAIN);
  const declared = declaredAppPins(DECLARED);
  await pinDeclaredArtifacts(server.sdk, APP, declared);
  const pushed = await server.sdk.pushArtifact('app', APP);
  assert.equal(pushed.saved, true, JSON.stringify(pushed.error && pushed.error.message));
  for (const key of [`60:${FORM_A}`, `60:${FORM_QUICK}`, `60:${OFFNAV_FORM_A}`, `60:${OFFNAV_FORM_B}`, `59:${OFFNAV_CHART}`]) {
    assert.ok(server.state.members.has(key), `${key} joined the app`);
  }
  assert.ok(!server.state.members.has(`60:${FORM_B}`), 'the Main form the list leaves out is not pinned');
  assert.ok(!writes(server.state).join('\n').includes(FORM_B));
});

test('declaredAppPins: every declared form of created.formIds and created.forms, once per GUID', () => {
  const pins = declaredAppPins({ ...DECLARED, forms: { ...DECLARED.forms, dup: `{${FORM_A.toUpperCase()}}` } });
  assert.deepEqual(pins.forms, [FORM_B, OFFNAV_FORM_B, `{${FORM_A.toUpperCase()}}`, FORM_QUICK, OFFNAV_FORM_A], 'the first spelling of an id is kept, the second dropped');
  assert.deepEqual(declaredAppPins({}).forms, []);
});

test('appComponentsFor: the declared projection of a new app lists every declared form and dashboard; the legacy projection is unchanged', () => {
  const legacy = appComponentsFor(DECLARED, MAIN);
  assert.deepEqual(legacy, { forms: [OFFNAV_FORM_B], views: [VIEW], charts: [OFFNAV_CHART], mainFormsByTable: MAIN }, 'one form per table, as before');
  assert.deepEqual(appComponentsFor(DECLARED, undefined), { forms: [FORM_B, OFFNAV_FORM_B], views: [VIEW], charts: [OFFNAV_CHART] });
  const declared = appComponentsFor({ ...DECLARED, dashboards: { Overview: CHART } }, MAIN, { declared: true });
  assert.deepEqual(declared.forms, [OFFNAV_FORM_B, FORM_A, FORM_QUICK, OFFNAV_FORM_A], 'the Main form outside the list is left out; a Quick Create is kept');
  assert.deepEqual(declared.dashboards, [CHART]);
  assert.deepEqual(declared.mainFormsByTable, MAIN);
  assert.deepEqual(appComponentsFor(DECLARED, undefined, { declared: true }).forms, [FORM_B, OFFNAV_FORM_B, FORM_A, FORM_QUICK, OFFNAV_FORM_A]);
});

// The build's exact update as the wiring makes it: the push records its result (published `notRead` — nothing published
// it yet), then the build's ordinary app publish goes through the port, which reads the PUBLISHED layer back and settles
// the obligation only on a match.
async function exactUpdate(t) {
  const server = await fetched(t, { members: [`1:${META.contoso_item}`, `62:${SITEMAP}`, `60:${FORM_B}`, `26:${VIEW}`, `59:${CHART}`] });
  await applyAppMainForms(server.sdk, APP, MAIN, { mainFormsOnUpdate: 'exact' });
  const pushed = await server.sdk.pushArtifact('app', APP);
  assert.equal(pushed.saved, true, JSON.stringify(pushed.error && pushed.error.message));
  const appWrite = { calls: 0, publish: async (id) => { appWrite.calls += 1; return server.sdk.publishArtifact('app', id); } };
  return { ...server, pushed, appWrite };
}

test('REAL BUNDLE: an exact update published through the port is settled by the published-layer proof, with one guarded publish', async (t) => {
  const { sdk, state, pushed, appWrite } = await exactUpdate(t);
  const port = createAppPublication({ appWrite, client: sdk.dataverse });
  assert.equal(port.recordExact(APP, pushed, { name: 'Membership', mainFormsByTable: MAIN }).done, false, 'the push alone proves nothing published');
  port.queue({ kind: 'app', id: APP, reason: 'app.tables' });
  const mark = state.requests.length;
  const answer = await port.publishApp(APP);
  assert.notEqual(answer.publish.kind, 'failed', JSON.stringify(answer.publish));
  assert.deepEqual(port.unsettled(), []);
  assert.deepEqual(port.owed(), [], 'the publish paid the queued work');
  const published = writes(state).slice(0).filter((line) => line.includes('/PublishXml'));
  assert.equal(published.length, 1, writes(state).join('\n'));
  assert.match(published[0], /^BATCH PATCH \/appmodules\(11111111-0000-4000-8000-000000000001\) \{\} \| POST \/PublishXml /, 'the SDK\'s guarded publish');
  const before = state.requests.length;
  assert.deepEqual(await port.flush(), { published: [], withheld: [], failed: [] });
  assert.equal(state.requests.length, before, 'nothing is published twice');
  assert.equal(appWrite.calls, 1);
  assert.ok(state.requests.slice(mark).some((line) => line.startsWith(`GET https://contoso.crm.dynamics.com/api/data/v9.2/appmodules(${APP})?$select=appmoduleidunique`) || line.includes(`appmodules(${APP})?$select=appmoduleidunique`)), 'the published layer was read');
});

test('REAL BUNDLE: an exact publish whose published layer reads back differently, or not at all, stays unsettled', async (t) => {
  for (const proof of ['differs', 'unreadable']) {
    const { sdk, pushed, appWrite } = await exactUpdate(t);
    // The proof's reads go through this client: one read is answered as a foreign edit (FORM_B back in the published layer)
    // or as a failure; every other read is the server's.
    const client = {
      get: async (path, ...rest) => {
        if (proof === 'unreadable' && path.includes('$select=appmoduleidunique') && !path.includes('RetrieveUnpublished')) return { status: 503, headers: {}, body: null };
        const answer = await sdk.dataverse.get(path, ...rest);
        if (proof === 'differs' && path.startsWith('/appmodulecomponents') && answer && answer.body && Array.isArray(answer.body.value)) {
          return { ...answer, body: { value: [...answer.body.value, { objectid: FORM_B, componenttype: 60 }] } };
        }
        return answer;
      },
    };
    const port = createAppPublication({ appWrite, client });
    port.recordExact(APP, pushed, { name: 'Membership', mainFormsByTable: MAIN });
    await port.publishApp(APP);
    const unsettled = port.unsettled();
    assert.equal(unsettled.length, 1, proof);
    assert.equal(unsettled[0].code, 'APP_MAIN_FORMS_NOT_EXACT');
    assert.match(unsettled[0].reason, new RegExp(proof));
  }
});

test('REAL BUNDLE: every later publish of an exact app proves it again: a membership changed between two publishes is not exact', async (t) => {
  const { sdk, state, pushed, appWrite } = await exactUpdate(t);
  const port = createAppPublication({ appWrite, client: sdk.dataverse });
  port.recordExact(APP, pushed, { name: 'Membership', mainFormsByTable: MAIN });
  await port.publishApp(APP);
  assert.deepEqual(port.unsettled(), []);
  await port.publishApp(APP);
  assert.deepEqual(port.unsettled(), [], 'an unchanged second publish stays proven');
  // Another writer puts FORM_B back between this build's two publishes; the SDK's guard has seen the list published, so
  // its next publish ships the app as it now is.
  state.members.add(`60:${FORM_B}`);
  state.version += 1;
  const answer = await port.publishApp(APP);
  assert.notEqual(answer.publish.kind, 'failed', JSON.stringify(answer.publish));
  assert.equal(port.unsettled().length, 1);
  assert.equal(port.unsettled()[0].code, 'APP_MAIN_FORMS_NOT_EXACT');
  assert.match(port.unsettled()[0].reason, /differs/);
});

test('REAL BUNDLE: a table publish the server refuses (403 PublishXml) stays owed and is reported failed, not paid', async (t) => {
  const server = appPinServer(t);
  await server.sdk.initWorkspace();
  await server.sdk.createArtifact('view', { id: VIEW, name: 'Probe view', entityLogicalName: 'contoso_item', columns: [{ name: 'contoso_name' }] });
  server.httpClient.post = async () => ({ status: 403, headers: {}, body: { error: { code: '0x80040220', message: 'Publish privilege missing' } } });
  const port = createAppPublication({ scopes: { table: { owe: () => false, publish: (target) => server.sdk.publishArtifact(target.artifact.type, target.artifact.id) } } });
  port.queue({ kind: 'table', id: 'contoso_item', artifact: { type: 'view', id: VIEW }, reason: 'quickFind' });
  const out = await port.flush();
  assert.deepEqual(out.published, []);
  assert.equal(out.failed.length, 1, JSON.stringify(out));
  assert.deepEqual({ ...out.failed[0], code: typeof out.failed[0].code }, { kind: 'table', id: 'contoso_item', code: 'string', reasons: ['quickFind'] });
  assert.ok(!JSON.stringify(out).includes('Publish privilege missing'), 'reported by code');
  assert.equal(port.owed().length, 1, 'still owed');
});
