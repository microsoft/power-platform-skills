'use strict';

// The whole build, through its app step, against the REAL vendored SDK and a stateful fake Dataverse whose change-set
// answers can be lost (helpers/app-pin-server.js). The SDK's guarded pin of an existing app's components is one `$batch`
// change set; when its answer is lost the SDK says APP_PIN_OUTCOME_UNKNOWN and re-sends nothing. The build then reads
// the app's components and either finds every intended one (no second push), makes exactly one repair push, or stops
// incomplete — never a third change set and never a warning only (lib/app-pin-recovery.js, sdk-build.js appWriters.push).
// The same harness drives "mainFormsOnUpdate": "exact" on the existing app: refused without the removal's authority,
// and with it the other Main form leaves the app and the publish is proven from the published layer — including the
// publish the pages phase's default-view placement makes with the page backend's own SDK.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { inOwnFolder } = require('./helpers/own-app-folder.js');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { withPageType } = require('./helpers/page-component-type.js');
const { runSdkBuild: runSdkBuildInPlace } = require('../lib/sdk-build.js');
const { makeGenpageSdk } = require('../lib/genpage-sdk.js');
const { membershipSpec, FORM_A, FORM_B, META } = require('./helpers/app-membership-sdk.js');
const { appPinServer, VIEW, CHART } = require('./helpers/app-pin-server.js');
const { pinIntentOf } = require('../lib/app-pin-recovery.js');
const { buildModelApp, isTransientHalt } = require('../build-model-app.js');

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
// withhold: how many app publishes the SDK refuses before it sends one (APP_MAIN_FORM_PUBLISH_WITHHELD: nothing was published), with the words withheldMessage.
async function build(t, lose, { watchCopy = false, members, exact = false, allowDestructive, withhold = 0, withheldMessage = 'read-back unavailable; no publish sent', appName } = {}) {
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
  const appPublishes = [];
  const publish = server.sdk.publishArtifact.bind(server.sdk);
  server.sdk.publishArtifact = async (kind, id, options) => {
    if (kind !== 'app') return publish(kind, id, options);
    if (appPublishes.length < withhold) {
      appPublishes.push('withheld');
      return { type: kind, id, shipped: false, publish: { kind: 'failed', error: { code: 'APP_MAIN_FORM_PUBLISH_WITHHELD', message: withheldMessage } } };
    }
    appPublishes.push('sent');
    return publish(kind, id, options);
  };
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
    if (appName) spec.app.name = appName;
    result = await runSdkBuild(spec, { sdk: server.sdk, apply: true, allowDestructive, phases: ['app-shell'], warn: (message) => warnings.push(message), log: () => {} });
  } catch (thrown) {
    error = thrown;
  }
  const changeSets = server.state.requests.filter((line) => line.startsWith('BATCH '));
  return { ...server, result, error, warnings, changeSets, copies, appPublishes };
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
  assert.equal(error.transient, false, 'a run again has no more authority: it is never run again');
  assert.match(error.message, /takes the other Main forms of contoso_item out of the existing app's membership \(no form is deleted\)/);
  assert.deepEqual(changeSets, [], 'no change set was sent');
  assert.ok(state.members.has(`60:${FORM_B}`), 'the other Main form is still in the app');
});

test('build: "exact" Main forms with --allow-destructive takes the other Main form out and proves the published layer', async (t) => {
  const { state, error, result, appPublishes } = await build(t, [], { members: WITH_FORM_B, exact: true, allowDestructive: true });
  assert.equal(error, undefined, error && error.stack);
  assert.equal(result.incomplete, undefined);
  assert.ok(state.members.has(`60:${FORM_A}`), 'the listed Main form is in the app');
  assert.ok(!state.members.has(`60:${FORM_B}`), 'the other Main form is out of the app');
  assert.ok(state.requests.some((line) => line.startsWith('GET ') && line.includes('/appmodules(11111111-0000-4000-8000-000000000001)?$select=appmoduleidunique')),
    'the publish is proven from a read of the published layer');
  assert.deepEqual(appPublishes, ['sent'], 'an accepted publish pays what was owed: the final flush publishes nothing more');
});

test('build: an "exact" publish withheld once is published again by the final flush, and the build succeeds', async (t) => {
  const { state, error, result, appPublishes } = await build(t, [], { members: WITH_FORM_B, exact: true, allowDestructive: true, withhold: 1 });
  assert.equal(error, undefined, error && error.stack);
  assert.equal(result.incomplete, undefined);
  assert.deepEqual(appPublishes, ['withheld', 'sent']);
  assert.ok(!state.members.has(`60:${FORM_B}`), 'the other Main form is out of the app');
});

test('build: an "exact" publish withheld every time is tried once more, then stops the build incomplete', async (t) => {
  const { error, appPublishes } = await build(t, [], { members: WITH_FORM_B, exact: true, allowDestructive: true, withhold: 2 });
  assert.deepEqual(appPublishes, ['withheld', 'withheld']);
  assert.ok(error, 'the build does not end as a success');
  const codes = (error.incomplete || []).map((entry) => entry.code);
  assert.ok(codes.includes('APP_MAIN_FORM_PUBLISH_WITHHELD'), JSON.stringify(error.incomplete));
  assert.ok(codes.includes('APP_MAIN_FORMS_NOT_EXACT'), JSON.stringify(error.incomplete));
});

// The end of a build that left an exact app's publication owed (sdk-build.js, the incomplete halt): the change is saved, so running every phase
// again would push it again and cannot settle what the SDK withholds. Its words read as a transient failure here, and the build is still run once.
test('build: the incomplete halt of a withheld "exact" publish is never run again, even when its words read as transient', async (t) => {
  const LABEL = 'SQL Timeout 503 try again later';
  const { error } = await build(t, [], { members: WITH_FORM_B, exact: true, allowDestructive: true, withhold: 2, withheldMessage: LABEL, appName: LABEL });
  assert.ok(error && Array.isArray(error.incomplete), error && error.stack);
  assert.ok(error.message.includes(LABEL), 'the halt quotes the words the maker named: ' + error.message);
  assert.equal(error.transient, false);
  assert.equal(isTransientHalt(error, { spec: membershipSpec({ hidden: false }) }), false);
  let attempts = 0;
  const lines = [];
  const appDir = makeTempDir('incomplete-halt-app');
  await assert.rejects(buildModelApp(membershipSpec({ hidden: false }), { apply: true, env: 'https://contoso.crm.dynamics.com', retryDelayMs: 0, appDir }, {
    sdk: {}, provisionSdk: {}, sleep: async () => {}, log: (m) => lines.push(String(m)), warn: () => {}, verify: async () => ({ ok: true }),
    discoverOpDiffState: async () => ({ collision: { appExists: false, solutionExists: false }, forms: [], sitemap: null }),
    runBuild: async () => { attempts += 1; throw error; },
  }), (thrown) => thrown === error);
  assert.equal(attempts, 1, 'the whole build is sent once');
  assert.equal(lines.filter((l) => /retrying/.test(l)).length, 0, lines.join('\n'));
});
// The pages phase pins the default view of each table a page it wrote reads (sdk-build.js, appWriters.placeViews). When it pins one it pushes and
// publishes the app through the page backend's own SDK — the real backend here, over the same fake Dataverse — and that publish ships whatever
// Main forms the app holds by then. `drift` puts the other Main form back into the app just before the placement, as another maker could; `held` puts it back
// just before the app step's publish, so the build's SDK withholds that publish and still withholds the app's publication when the placement comes.
const PAGE_ID = '99999999-0000-4000-8000-000000000022';
const PAGE_VIEW = '66666666-0000-4000-8000-000000000022';
async function placementBuild(t, { exact = false, drift = false, held = false } = {}) {
  const appDir = makeTempDir('placement-app-');
  fs.writeFileSync(path.join(appDir, 'overview.tsx'), 'export default function Overview(){return null;}');
  const server = appPinServer(t);
  const get = server.httpClient.get;
  server.httpClient.get = async (url) => {
    const decoded = decodeURIComponent(url);
    const answer = (body) => { server.state.requests.push(`GET ${url}`); return { status: 200, headers: {}, body }; };
    const definition = /EntityDefinitions\(LogicalName='([a-z]+)'\)/.exec(url);
    if (definition && definition[1] === 'savedquery') return answer({ LogicalName: 'savedquery', EntitySetName: 'savedqueries' });
    if (definition && SETS[definition[1]]) return answer({ EntitySetName: SETS[definition[1]], LogicalName: definition[1] });
    if (url.includes('/webresourceset')) return answer({ value: [{ webresourceid: ICON, name: 'contoso_membership_icon' }] });
    if (url.includes('/solutions?')) return answer({ value: [{ solutionid: SOLUTION }] });
    if (decoded.includes('/savedqueries') && decoded.includes('isdefault eq true')) return answer({ value: [{ savedqueryid: PAGE_VIEW }] });
    return get(url);
  };
  await server.sdk.initWorkspace();
  const query = server.sdk.queryRecords.bind(server.sdk);
  server.sdk.queryRecords = async (type, options = {}) => (type === 'webresource' && /_pagemanifest/.test(options.filter || '') ? [] : query(type, options));
  server.sdk.createWebResource = async () => ({ id: '88888888-0000-4000-8000-000000000022' });
  server.sdk.updateWebResource = async () => ({});
  server.sdk.dataverse.get = withPageType(server.sdk.dataverse.get.bind(server.sdk.dataverse));
  const ownerPublishes = [];
  if (held) {
    const publishArtifact = server.sdk.publishArtifact.bind(server.sdk);
    server.sdk.publishArtifact = async (type, id, options) => {
      if (type === 'app' && !ownerPublishes.length) server.state.members.add(`60:${FORM_B}`);
      const answer = await publishArtifact(type, id, options);
      if (type === 'app') ownerPublishes.push(answer.publish.kind === 'failed' ? answer.publish.error.code : answer.publish.kind);
      return answer;
    };
  }
  const spec = membershipSpec({ hidden: false });
  spec.schemaVersion = 2;
  if (exact) spec.app.mainFormsOnUpdate = 'exact';
  spec.pages = [{ key: 'overview', name: 'Overview', dataSources: ['contoso_other'], source: { kind: 'tsx', codeFile: 'overview.tsx' } }];
  const backend = makeGenpageSdk('https://contoso.crm.dynamics.com', { httpClient: server.httpClient });
  t.after(() => backend.dispose());
  const live = [];
  const pageAnswer = (options) => ({ pageId: PAGE_ID, name: options.name, publish: { kind: 'verified' }, warnings: [] });
  let placedAt;
  let placed;
  const genpage = {
    enumerateEnv: async () => ({ ok: true, ids: live.map((row) => row.pageId), pages: live }),
    create: async (options) => { live.push({ pageId: PAGE_ID, name: options.name }); return pageAnswer(options); },
    update: async (_id, options) => pageAnswer(options),
    placeInApp: async (id, options) => {
      if (drift) server.state.members.add(`60:${FORM_B}`);
      placedAt = server.state.requests.length;
      placed = await backend.placeInApp(id, options);
      return placed;
    },
  };
  let result;
  let error;
  try {
    result = await runSdkBuild(spec, { sdk: server.sdk, apply: true, phases: ['app-shell', 'pages'], appDir, env: 'https://contoso.crm.dynamics.com', genpage,
      allowDestructive: exact, publish: false, warn: () => {}, log: () => {} });
  } catch (thrown) {
    error = thrown;
  }
  const afterPlacement = placedAt === undefined ? [] : server.state.requests.slice(placedAt);
  return { result, error, placed, afterPlacement, ownerPublishes };
}
const appPublishOf = (lines) => lines.filter((line) => line.startsWith('POST ') && line.includes('/PublishXml') && line.includes('<appmodule>'));
const publishedLayerReads = (lines) => lines.filter((line) => line.startsWith('GET ') && line.includes('$select=appmoduleidunique'));

test('build: the default-view placement publishes an "exact" app with a Main form put back since — the build does not succeed', async (t) => {
  const { result, error, placed, afterPlacement } = await placementBuild(t, { exact: true, drift: true });
  assert.ok(placed && placed.pinnedViews.includes(PAGE_VIEW), 'the placement pinned the view and published the app');
  assert.equal(appPublishOf(afterPlacement).length, 1);
  assert.equal(result, undefined, 'a build whose last publish shipped a Main form outside the exact list is not a success');
  assert.equal(error && error.code, 'APP_MAIN_FORMS_NOT_EXACT', error && error.stack);
});

test('build: the default-view placement of an "exact" app is proven again from the published layer, and the build succeeds', async (t) => {
  const { result, error, afterPlacement } = await placementBuild(t, { exact: true });
  assert.equal(error, undefined, error && error.stack);
  assert.equal(result.incomplete, undefined);
  assert.equal(appPublishOf(afterPlacement).length, 1);
  assert.ok(publishedLayerReads(afterPlacement).length > 0, 'the placement publish is followed by a read of the published layer');
});

test('build: the default-view placement of an app with no exact list reads nothing more after its publish', async (t) => {
  const { result, error, afterPlacement } = await placementBuild(t);
  assert.equal(error, undefined, error && error.stack);
  assert.equal(result.incomplete, undefined);
  assert.equal(appPublishOf(afterPlacement).length, 1);
  assert.deepEqual(publishedLayerReads(afterPlacement), []);
});

test('build: an "exact" app whose publication the build SDK still withholds is not published by the default-view placement either', async (t) => {
  const { result, error, afterPlacement, ownerPublishes } = await placementBuild(t, { exact: true, held: true });
  assert.equal(ownerPublishes[0], 'APP_MAIN_FORM_PUBLISH_WITHHELD', 'the app step\'s publish was withheld');
  assert.ok(afterPlacement.length > 0, 'the placement ran');
  assert.deepEqual(appPublishOf(afterPlacement), [], 'no PublishXml of the app after the withheld one');
  assert.ok(ownerPublishes.length >= 2 && ownerPublishes.every((kind) => kind === 'APP_MAIN_FORM_PUBLISH_WITHHELD'), 'the placement asked the build SDK, which withheld it again');
  assert.equal(result, undefined);
  assert.ok(error && ['APP_MAIN_FORM_PUBLISH_WITHHELD', 'APP_MAIN_FORMS_NOT_EXACT'].includes(error.code), error && error.stack);
});