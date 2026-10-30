'use strict';

// The whole build, through its app step, against the REAL vendored SDK and a stateful fake Dataverse whose change-set
// answers can be lost (helpers/app-pin-server.js). The SDK's guarded pin of an existing app's components is one `$batch`
// change set; when its answer is lost the SDK says APP_PIN_OUTCOME_UNKNOWN and re-sends nothing. The build then reads
// the app's components and either finds every intended one (no second push), makes exactly one repair push, or stops
// incomplete — never a third change set and never a warning only (lib/app-pin-recovery.js, sdk-build.js appWriters.push).
// The same harness drives "mainFormsOnUpdate": "exact" on the existing app: refused without the removal's authority,
// and with it the other Main form leaves the app and the publish is proven from the published layer.

const test = require('node:test');
const assert = require('node:assert/strict');
const { inOwnFolder } = require('./helpers/own-app-folder.js');
const { runSdkBuild: runSdkBuildInPlace } = require('../lib/sdk-build.js');
const { membershipSpec, FORM_A, FORM_B, META } = require('./helpers/app-membership-sdk.js');
const { appPinServer, VIEW, CHART } = require('./helpers/app-pin-server.js');
const { pinIntentOf } = require('../lib/app-pin-recovery.js');

const runSdkBuild = inOwnFolder(runSdkBuildInPlace);
const ICON = '88888888-0000-4000-8000-000000000001';
const SOLUTION = '99999999-0000-4000-8000-000000000001';
// The entity set each system table is read through; the pin server answers every other EntityDefinitions read as the
// app's own table.
const SETS = { webresource: 'webresourceset', appmodule: 'appmodules', appmodulecomponent: 'appmodulecomponents', solution: 'solutions', solutioncomponent: 'solutioncomponents', sitemap: 'sitemaps' };
const ALL = [`1:${META.contoso_item}`, `60:${FORM_A}`, `26:${VIEW}`, `59:${CHART}`];

// The pin server models the app and its components; the app step also reads the solution and the app's icon, which
// this answers: both already exist, so the build creates neither.
// watchCopy: record what the workspace copy asks the server to hold just before and just after each app push.
async function build(t, lose, { watchCopy = false, members, exact = false, allowDestructive } = {}) {
  const server = appPinServer(t, { lose, members });
  const get = server.httpClient.get;
  server.httpClient.get = async (url) => {
    const answer = (body) => { server.state.requests.push(`GET ${url}`); return { status: 200, headers: {}, body }; };
    const definition = /EntityDefinitions\(LogicalName='([a-z]+)'\)/.exec(url);
    if (definition && SETS[definition[1]]) return answer({ EntitySetName: SETS[definition[1]], LogicalName: definition[1] });
    if (url.includes('/webresourceset')) return answer({ value: [{ webresourceid: ICON, name: 'contoso_membership_icon' }] });
    if (url.includes('/solutions?')) return answer({ value: [{ solutionid: SOLUTION }] });
    return get(url);
  };
  await server.sdk.initWorkspace();
  const copies = [];
  if (watchCopy) {
    const push = server.sdk.pushArtifact.bind(server.sdk);
    server.sdk.pushArtifact = async (kind, id) => {
      const before = pinIntentOf(await server.sdk.getArtifact(kind, id));
      const pushed = await push(kind, id);
      copies.push({ before, after: pinIntentOf(await server.sdk.getArtifact(kind, id)), warnings: pushed.warnings || [] });
      return pushed;
    };
  }
  const warnings = [];
  let result;
  let error;
  try {
    const spec = membershipSpec({ hidden: false });
    if (exact) spec.app.mainFormsOnUpdate = 'exact';
    result = await runSdkBuild(spec, { sdk: server.sdk, apply: true, allowDestructive, phases: ['app-shell'], warn: (message) => warnings.push(message), log: () => {} });
  } catch (thrown) {
    error = thrown;
  }
  const changeSets = server.state.requests.filter((line) => line.startsWith('BATCH '));
  return { ...server, result, error, warnings, changeSets, copies };
}

test('build: a pin answer lost after it committed is confirmed by reading the app; no second change set', async (t) => {
  const { state, error, warnings, changeSets } = await build(t, ['afterCommit']);
  assert.equal(error, undefined, error && error.stack);
  assert.equal(changeSets.length, 1, changeSets.join('\n'));
  assert.ok(warnings.some((line) => line.includes('every intended component is present')), warnings.join('\n'));
  assert.ok(!warnings.some((line) => line.includes('APP_PIN_OUTCOME_UNKNOWN')), 'the unknown answer is settled, not left as a warning');
  for (const key of ALL) assert.ok(state.members.has(key), key);
});

test('build: a pin answer lost before it committed is repaired by exactly one more push', async (t) => {
  const { state, error, changeSets, copies } = await build(t, ['beforeCommit'], { watchCopy: true });
  assert.equal(error, undefined, error && error.stack);
  assert.equal(changeSets.length, 2, changeSets.join('\n'));
  // The build reads what the push intended from the workspace copy AFTER the push, and only when its pin answer was
  // lost: the SDK leaves the copy it pushed as it was, Main-form list included.
  assert.ok(copies[0].warnings.some((line) => line.startsWith('APP_PIN_OUTCOME_UNKNOWN')), JSON.stringify(copies[0].warnings));
  assert.deepEqual(copies[0].after, copies[0].before);
  assert.deepEqual(copies[0].after.mainFormsByTable, { contoso_item: [FORM_A] });
  for (const key of ALL) assert.ok(state.members.has(key), key);
  assert.ok(!state.members.has(`60:${FORM_B}`), 'the Main form the spec leaves out is not added by the repair');
});

test('build: the repair push losing its answer too stops the build incomplete, with no third change set', async (t) => {
  const { error, changeSets } = await build(t, ['beforeCommit', 'beforeCommit']);
  assert.equal(changeSets.length, 2, changeSets.join('\n'));
  assert.ok(error, 'the build does not end as a success');
  assert.equal(error.code, 'APP_PIN_UNCONFIRMED', error.stack);
  assert.ok((error.incomplete || []).some((entry) => entry.code === 'APP_PIN_UNCONFIRMED'), JSON.stringify(error.incomplete));
});

test('build: a pin answer that arrives reads and writes nothing more than the build always did', async (t) => {
  const { state, error, changeSets, warnings } = await build(t, []);
  assert.equal(error, undefined, error && error.stack);
  assert.equal(changeSets.length, 1);
  assert.deepEqual(warnings, []);
  for (const key of ALL) assert.ok(state.members.has(key), key);
  // The trail the build made before the recovery existed: 49 requests, these writes, in this order.
  const writes = state.requests.filter((line) => !line.startsWith('GET ')).map((line) => line.replace(/^(\S+ \S+?)(?:\?\S*)? .*$/, '$1').replace(/https:\/\/[^/]+\/api\/data\/v9\.\d/, ''));
  assert.deepEqual(writes, ['POST /AddSolutionComponent', 'PATCH /sitemaps(55555555-0000-4000-8000-000000000001)', 'BATCH PATCH', 'POST /PublishXml', 'POST /AddSolutionComponent']);
  assert.equal(state.requests.length, 49, state.requests.join('\n'));
});

// The app as it stands before the build: its table, its navigation and a second Main form (FORM_B) the spec leaves out.
const WITH_FORM_B = [`1:${META.contoso_item}`, '62:55555555-0000-4000-8000-000000000001', `60:${FORM_B}`];

test('build: "exact" Main forms on an existing app is refused without --allow-destructive, before the push writes the app', async (t) => {
  const { state, error, changeSets } = await build(t, [], { members: WITH_FORM_B, exact: true });
  assert.ok(error, 'the removal needs authority');
  assert.equal(error.code, 'APP_MAIN_FORMS_EXACT_UNAUTHORIZED', error.stack);
  assert.match(error.message, /takes the other Main forms of contoso_item out of the existing app's membership \(no form is deleted\)/);
  assert.deepEqual(changeSets, [], 'no change set was sent');
  assert.ok(state.members.has(`60:${FORM_B}`), 'the other Main form is still in the app');
});

test('build: "exact" Main forms with --allow-destructive takes the other Main form out and proves the published layer', async (t) => {
  const { state, error, result } = await build(t, [], { members: WITH_FORM_B, exact: true, allowDestructive: true });
  assert.equal(error, undefined, error && error.stack);
  assert.equal(result.incomplete, undefined);
  assert.ok(state.members.has(`60:${FORM_A}`), 'the listed Main form is in the app');
  assert.ok(!state.members.has(`60:${FORM_B}`), 'the other Main form is out of the app');
  assert.ok(state.requests.some((line) => line.startsWith('GET ') && line.includes('/appmodules(11111111-0000-4000-8000-000000000001)?$select=appmoduleidunique')),
    'the publish is proven from a read of the published layer');
});
