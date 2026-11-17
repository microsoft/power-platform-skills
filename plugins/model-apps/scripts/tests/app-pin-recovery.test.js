'use strict';

// reconcileUnconfirmedPin against a provision double: the branches the real-bundle file cannot reach cheaply (reads
// that fail or answer rows it cannot place, a refused repair, a missing intent) and what the repair push is handed.

const test = require('node:test');
const assert = require('node:assert/strict');
const { reconcileUnconfirmedPin, pinIntentOf, pinWarningOf } = require('../lib/app-pin-recovery.js');
const { APP, FORM_A, FORM_B, META } = require('./helpers/app-membership-sdk.js');
const { VIEW, CHART, OFFNAV_CHART } = require('./helpers/app-pin-server.js');

const LAYER = '11111111-0000-4000-8000-0000000000aa';
const DASHBOARD = '44444444-0000-4000-8000-000000000020';
const MAIN = { contoso_item: [FORM_A] };
const UNKNOWN = `APP_PIN_OUTCOME_UNKNOWN: App '${APP}': the change set adding its components was sent, but its answer was lost; it may have committed, and nothing was re-sent.`;
const lostPin = (extra = []) => ({ saved: true, warnings: [UNKNOWN, ...extra] });
const intent = (more = {}) => ({ tables: ['contoso_item'], forms: [], views: [], charts: [], dashboards: [], mainFormsByTable: MAIN, ...more });

// members: the `type:objectid` keys the current layer holds; reads: overrides by path fragment → response.
function double({ members = [], reads = {}, componentRows } = {}) {
  const calls = [];
  const state = { members: new Set(members), artifact: { components: {} } };
  const ok = (value) => ({ status: 200, body: { value } });
  const dataverse = {
    get: async (path) => {
      calls.push(['get', path]);
      for (const [fragment, response] of Object.entries(reads)) if (path.includes(fragment)) return typeof response === 'function' ? response() : response;
      if (path.startsWith('/EntityDefinitions')) return { status: 200, body: { MetadataId: META.contoso_item, EntitySetName: 'contoso_items' } };
      if (path.startsWith('/appmodules/')) return ok([{ appmoduleid: APP, appmoduleidunique: LAYER, componentstate: 0 }]);
      if (path.startsWith('/systemforms')) return ok([{ formid: FORM_A }, { formid: FORM_B }]);
      if (path.startsWith('/savedqueries')) return ok([{ savedqueryid: VIEW }]);
      if (path.startsWith('/savedqueryvisualizations')) return ok([{ savedqueryvisualizationid: CHART }]);
      if (path.startsWith('/appmodulecomponents')) {
        return ok(componentRows || [...state.members].map((key) => ({ componenttype: Number(key.split(':')[0]), objectid: key.split(':')[1] })));
      }
      return { status: 404, body: {} };
    },
  };
  const writes = () => calls.filter(([kind]) => kind !== 'get' && kind !== 'getArtifact');
  return {
    calls, state, writes,
    provision: {
      dataverse,
      fetchArtifact: async (type, id, options) => { calls.push(['fetchArtifact', type, id, options]); state.artifact = { components: {} }; },
      getArtifact: async () => { calls.push(['getArtifact']); return JSON.parse(JSON.stringify(state.artifact)); },
      addElement: async (type, id, pointer, value) => { calls.push(['addElement', pointer]); Object.assign(state.artifact, JSON.parse(JSON.stringify(value))); },
      updateElement: async (type, id, pointer, value) => { calls.push(['updateElement', pointer]); state.artifact.components = JSON.parse(JSON.stringify(value)); },
    },
  };
}

const COMPLETE = [`1:${META.contoso_item}`, `60:${FORM_A}`, `26:${VIEW}`, `59:${CHART}`];

test('pinWarningOf: only an outcome-unknown warning for THIS app triggers; other pin notices and other apps do not', () => {
  assert.equal(pinWarningOf(lostPin(), APP.toUpperCase()), UNKNOWN);
  assert.equal(pinWarningOf({ warnings: [UNKNOWN.replace(APP, '99999999-0000-4000-8000-000000000001')] }, APP), null);
  for (const code of ['APP_PIN_REBASE_REQUIRED (row moved)', 'APP_PIN_TOKEN_UNCONFIRMED (no echo)', 'APP_PIN_ECHO_MISSING (no row)']) {
    assert.equal(pinWarningOf({ warnings: [`${code}: App '${APP}': …`] }, APP), null, code);
  }
  assert.equal(pinWarningOf({ warnings: [`note: ${UNKNOWN}`] }, APP), null, 'anchored at the start');
});

test('another pin notice (or none) reads and writes nothing', async () => {
  const fake = double();
  let pushes = 0;
  const pushed = { saved: true, warnings: [`APP_PIN_REBASE_REQUIRED (row moved): App '${APP}': re-run.`] };
  const result = await reconcileUnconfirmedPin({ provision: fake.provision, appId: APP, intent: intent(), pushed, push: async () => { pushes += 1; } });
  assert.equal(result.outcome, 'none');
  assert.equal(result.pushed, pushed);
  assert.deepEqual(fake.calls, []);
  assert.equal(pushes, 0);
});

test('an intent that was not recorded is incomplete, with nothing read or written', async () => {
  const fake = double();
  const result = await reconcileUnconfirmedPin({ provision: fake.provision, appId: APP, intent: undefined, pushed: lostPin(), push: async () => assert.fail('no push') });
  assert.equal(result.outcome, 'incomplete');
  assert.equal(result.error.code, 'APP_PIN_UNCONFIRMED');
  assert.deepEqual(fake.calls, []);
});

for (const [name, reads, componentRows] of [
  ['the component read answers 503', { '/appmodulecomponents': { status: 503, body: { error: { message: 'Service unavailable' } } } }],
  ['the layer read answers two published rows', { '/appmodules/': { status: 200, body: { value: [{ appmoduleidunique: LAYER, componentstate: 0 }, { appmoduleidunique: LAYER, componentstate: 0 }] } } }],
  ['the view read answers no list', { '/savedqueries': { status: 200, body: {} } }],
  ['a component row names no GUID', {}, [{ componenttype: 1, objectid: META.contoso_item }, { componenttype: 60, objectid: '{}' }]],
  ['a component row has a text type', {}, [{ componenttype: '60', objectid: FORM_A }]],
]) {
  test(`a membership read that cannot be completed (${name}) is incomplete and writes nothing`, async () => {
    const fake = double({ members: COMPLETE, reads, componentRows });
    let pushes = 0;
    const result = await reconcileUnconfirmedPin({ provision: fake.provision, appId: APP, intent: intent(), pushed: lostPin(), push: async () => { pushes += 1; } });
    assert.equal(result.outcome, 'incomplete');
    assert.equal(result.error.code, 'APP_PIN_UNCONFIRMED');
    assert.equal(pushes, 0);
    assert.deepEqual(fake.writes().map(([kind]) => kind), ['fetchArtifact'], 'only the overwrite fetch');
    assert.ok(result.pushed.warnings.includes(UNKNOWN), 'the original warning stays reported');
  });
}

test('every member present: confirmed, the warning is replaced by a note, no second push', async () => {
  const fake = double({ members: COMPLETE });
  const result = await reconcileUnconfirmedPin({ provision: fake.provision, appId: APP, intent: intent(), pushed: lostPin(['other']), push: async () => assert.fail('no push') });
  assert.equal(result.outcome, 'confirmed');
  assert.ok(!result.pushed.warnings.includes(UNKNOWN));
  assert.equal(result.pushed.warnings[0], 'other');
  assert.deepEqual(fake.writes(), [['fetchArtifact', 'app', APP, { overwrite: true }]]);
});

test('a member missing: the fresh copy is handed back the exact directive, the allow-list and every declared pin before the ONE repair push', async () => {
  const fake = double({ members: [`1:${META.contoso_item}`, `60:${FORM_A}`] });
  const seen = [];
  const want = intent({ mainFormsOnUpdate: 'exact', charts: [OFFNAV_CHART], dashboards: [DASHBOARD] });
  const result = await reconcileUnconfirmedPin({
    provision: fake.provision, appId: APP, intent: want, pushed: lostPin(),
    push: async () => {
      seen.push(JSON.parse(JSON.stringify(fake.state.artifact.components)));
      for (const key of [`26:${VIEW}`, `59:${CHART}`, `59:${OFFNAV_CHART}`, `60:${DASHBOARD}`]) fake.state.members.add(key);
      return { saved: true, warnings: [] };
    },
  });
  assert.equal(result.outcome, 'repaired', JSON.stringify(result.error && result.error.message));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].mainFormsOnUpdate, 'exact');
  assert.deepEqual(seen[0].mainFormsByTable, MAIN);
  assert.deepEqual(seen[0].charts, [OFFNAV_CHART]);
  assert.deepEqual(seen[0].dashboards, [DASHBOARD]);
  assert.deepEqual(result.missing, [`26:${VIEW}`, `59:${CHART}`, `59:${OFFNAV_CHART}`, `60:${DASHBOARD}`].sort());
  assert.ok(!result.pushed.warnings.includes(UNKNOWN));
});

for (const [name, second, pattern] of [
  ['refused', { saved: false, error: { code: 'APP_MAIN_FORM_CONFLICT' } }, /refused: APP_MAIN_FORM_CONFLICT/],
  ['answered unknown again', lostPin(), /answer was lost too/],
  ['saved but the member is still missing', { saved: true, warnings: [] }, /still missing after one repair push/],
]) {
  test(`the repair push ${name}: incomplete, never a third push`, async () => {
    const fake = double({ members: [`1:${META.contoso_item}`] });
    let pushes = 0;
    const result = await reconcileUnconfirmedPin({ provision: fake.provision, appId: APP, intent: intent(), pushed: lostPin(), push: async () => { pushes += 1; return second; } });
    assert.equal(result.outcome, 'incomplete');
    assert.equal(result.error.code, 'APP_PIN_UNCONFIRMED');
    assert.match(result.error.message, pattern);
    assert.equal(pushes, 1);
  });
}

test('a repair push that throws is incomplete', async () => {
  const fake = double({ members: [] });
  const result = await reconcileUnconfirmedPin({ provision: fake.provision, appId: APP, intent: intent(), pushed: lostPin(), push: async () => { throw Object.assign(new Error('x'), { code: 'NETWORK' }); } });
  assert.equal(result.outcome, 'incomplete');
  assert.match(result.error.message, /repair push failed: NETWORK/);
});

test('pinIntentOf: tables and dashboards from the navigation, ids normalised, no header or navigation kept', () => {
  const artifact = {
    name: 'Membership', description: 'kept out',
    siteMap: { areas: [{ groups: [{ subAreas: [
      { type: 'Entity', entity: 'Contoso_Item' }, { type: 'Entity', entity: 'contoso_item' },
      { type: 'DashBoard', dashboardId: DASHBOARD.toUpperCase() }, { type: 'Url', url: 'https://contoso.example' },
    ] }] }] },
    components: { forms: [`{${FORM_A.toUpperCase()}}`, 'not-a-guid'], views: [VIEW, VIEW], charts: [], mainFormsByTable: { Contoso_Item: [FORM_A] }, mainFormsOnUpdate: 'exact' },
  };
  assert.deepEqual(pinIntentOf(artifact), {
    tables: ['contoso_item'], forms: [FORM_A], views: [VIEW], charts: [], dashboards: [DASHBOARD],
    mainFormsByTable: { contoso_item: [FORM_A] }, mainFormsOnUpdate: 'exact',
  });
  assert.deepEqual(Object.keys(pinIntentOf({ components: { mainFormsOnUpdate: 'addOnly' } })).sort(), ['charts', 'dashboards', 'forms', 'tables', 'views']);
});
