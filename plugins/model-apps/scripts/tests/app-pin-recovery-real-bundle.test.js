'use strict';

// app-pin-recovery.js against the REAL vendored SDK: the SDK pushes a fetched app, its component pin goes out as one
// change set, and the transport loses that change set's answer (before or after the server applied it). The SDK then
// reports APP_PIN_OUTCOME_UNKNOWN, and reconcileUnconfirmedPin settles it with the real fetch and the real push.
// The fake server below keeps state: the app row and its version, the navigation, and the component set, which only an
// applied AddAppComponents (plain or inside the change set) adds to.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../vendor/cds-maker-sdk.cjs');
const { applyAppMainForms } = require('../lib/app-components.js');
const { pinWarningOf, pinIntentOf, reconcileUnconfirmedPin } = require('../lib/app-pin-recovery.js');
const { APP, FORM_A, FORM_B, META } = require('./helpers/app-membership-sdk.js');
const { appPinServer, navigation, VIEW, CHART } = require('./helpers/app-pin-server.js');

const server = (t, options) => appPinServer(t, options);

// The build's flow for one push of a fetched app (sdk-build.js pushAppHeader through appWriters.push): the Main-form
// list is applied to the copy, the intent is recorded, and the push is made.
async function firstPush(sdk, mainFormsByTable) {
  await sdk.initWorkspace();
  await sdk.fetchArtifact('app', APP);
  await applyAppMainForms(sdk, APP, mainFormsByTable);
  const intent = pinIntentOf(await sdk.getArtifact('app', APP));
  const pushed = await sdk.pushArtifact('app', APP);
  return { intent, pushed };
}
const repairPush = (sdk, mainFormsByTable) => async () => {
  await applyAppMainForms(sdk, APP, mainFormsByTable);
  return sdk.pushArtifact('app', APP);
};
const MAIN = { contoso_item: [FORM_A] };
const ALL = [`1:${META.contoso_item}`, `60:${FORM_A}`, `26:${VIEW}`, `59:${CHART}`];
const writesAfter = (state, mark) => state.requests.slice(mark).filter((line) => !line.startsWith('GET '));

test('REAL BUNDLE: a lost change-set answer makes the real SDK report APP_PIN_OUTCOME_UNKNOWN for this app', async (t) => {
  const { sdk, state } = server(t, { lose: ['beforeCommit'] });
  const { pushed } = await firstPush(sdk, MAIN);
  assert.equal(pushed.saved, true, JSON.stringify(pushed.error && pushed.error.message));
  assert.match(pinWarningOf(pushed, APP), /^APP_PIN_OUTCOME_UNKNOWN: App '/);
  assert.equal(pinWarningOf(pushed, '99999999-0000-4000-8000-000000000001'), null, 'another app\'s warning never triggers');
  assert.ok(state.requests.some((line) => line.startsWith('BATCH ') && line.includes('/AddAppComponents')));
});

test('REAL BUNDLE: committed before the answer was lost -> no second mutation of any kind', async (t) => {
  const { sdk, state } = server(t, { lose: ['afterCommit'] });
  const { intent, pushed } = await firstPush(sdk, MAIN);
  const mark = state.requests.length;
  let pushes = 0;
  const result = await reconcileUnconfirmedPin({ provision: sdk, appId: APP, intent, pushed, push: async () => { pushes += 1; return repairPush(sdk, MAIN)(); } });
  assert.equal(result.outcome, 'confirmed', JSON.stringify(result.error && result.error.message));
  assert.equal(pushes, 0);
  assert.deepEqual(writesAfter(state, mark), [], 'only reads: no PATCH, POST or change set');
  assert.equal(pinWarningOf(result.pushed, APP), null, 'the settled warning is replaced by what was established');
  for (const key of ALL) assert.ok(state.members.has(key), key);
});

test('REAL BUNDLE: not committed -> exactly one repair push adds the missing members; an excluded Main form is never sent', async (t) => {
  const { sdk, state } = server(t, { lose: ['beforeCommit'] });
  const { intent, pushed } = await firstPush(sdk, MAIN);
  assert.ok(!state.members.has(`60:${FORM_A}`), 'the lost set did not commit');
  const mark = state.requests.length;
  let pushes = 0;
  const result = await reconcileUnconfirmedPin({ provision: sdk, appId: APP, intent, pushed, push: async () => { pushes += 1; return repairPush(sdk, MAIN)(); } });
  assert.equal(result.outcome, 'repaired', JSON.stringify(result.error && result.error.message));
  assert.equal(pushes, 1);
  for (const key of ALL) assert.ok(state.members.has(key), key);
  assert.ok(!state.members.has(`60:${FORM_B}`), 'the form the Main-form list leaves out is not re-added');
  const writes = writesAfter(state, mark);
  assert.equal(writes.filter((line) => line.includes('AddAppComponents')).length, 1, writes.join('\n'));
  assert.ok(!writes.join('\n').includes(FORM_B));
});

test('REAL BUNDLE: a concurrent header and navigation change survives the repair push', async (t) => {
  const { sdk, state } = server(t, { lose: ['beforeCommit'] });
  const { intent, pushed } = await firstPush(sdk, MAIN);
  // Another writer, after the lost answer: renames the app and retitles the navigation entry.
  state.name = 'Renamed elsewhere';
  state.sitemapXml = navigation('Items (edited elsewhere)');
  state.version += 1;
  const mark = state.requests.length;
  const result = await reconcileUnconfirmedPin({ provision: sdk, appId: APP, intent, pushed, push: repairPush(sdk, MAIN) });
  assert.equal(result.outcome, 'repaired', JSON.stringify(result.error && result.error.message));
  assert.equal(state.name, 'Renamed elsewhere');
  assert.match(state.sitemapXml, /Items \(edited elsewhere\)/);
  assert.ok(!writesAfter(state, mark).some((line) => line.includes('"name":"Membership"')), 'the stale header is never re-sent');
});

test('REAL BUNDLE: the original change set landing late (after the recovery read) cannot overwrite the header or re-add an excluded form', async (t) => {
  const { sdk, state, landLateOriginal } = server(t, { lose: ['held'] });
  const { intent, pushed } = await firstPush(sdk, MAIN);
  state.name = 'Renamed elsewhere';
  state.version += 1; // the concurrent writer moved the row, so the late guard (If-Match the old version) is refused
  let late;
  const result = await reconcileUnconfirmedPin({
    provision: sdk, appId: APP, intent, pushed,
    push: async () => { late = landLateOriginal(); return repairPush(sdk, MAIN)(); },
  });
  assert.equal(late, false, 'the late original rolled back on its own guard');
  assert.equal(result.outcome, 'repaired', JSON.stringify(result.error && result.error.message));
  assert.equal(state.name, 'Renamed elsewhere');
  assert.ok(!state.members.has(`60:${FORM_B}`));
});

test('REAL BUNDLE: the repair push losing its answer too is a bounded incomplete stop', async (t) => {
  const { sdk, state } = server(t, { lose: ['beforeCommit', 'beforeCommit'] });
  const { intent, pushed } = await firstPush(sdk, MAIN);
  let pushes = 0;
  const result = await reconcileUnconfirmedPin({ provision: sdk, appId: APP, intent, pushed, push: async () => { pushes += 1; return repairPush(sdk, MAIN)(); } });
  assert.equal(result.outcome, 'incomplete');
  assert.equal(result.error.code, 'APP_PIN_UNCONFIRMED');
  assert.equal(pushes, 1, 'no recursion');
  assert.equal(state.requests.filter((line) => line.startsWith('BATCH ')).length, 2, 'the original and one repair, never a third');
});

test('REAL BUNDLE: a repair push whose answer is lost after it committed is still an incomplete stop, not a claimed repair', async (t) => {
  const { sdk } = server(t, { lose: ['beforeCommit', 'afterCommit'] });
  const { intent, pushed } = await firstPush(sdk, MAIN);
  const result = await reconcileUnconfirmedPin({ provision: sdk, appId: APP, intent, pushed, push: repairPush(sdk, MAIN) });
  assert.equal(result.outcome, 'incomplete');
  assert.match(result.error.message, /answer was lost too/);
});

test('REAL BUNDLE: no unknown answer -> reconcile reads and writes nothing', async (t) => {
  const { sdk, state } = server(t);
  const { intent, pushed } = await firstPush(sdk, MAIN);
  assert.equal(pinWarningOf(pushed, APP), null, JSON.stringify(pushed.warnings));
  const mark = state.requests.length;
  const result = await reconcileUnconfirmedPin({ provision: sdk, appId: APP, intent, pushed, push: async () => assert.fail('no push') });
  assert.equal(result.outcome, 'none');
  assert.equal(result.pushed, pushed, 'the push result is handed back as it came');
  assert.equal(state.requests.length, mark, 'zero extra requests');
});
