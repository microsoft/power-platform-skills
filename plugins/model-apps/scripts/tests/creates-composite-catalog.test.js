'use strict';
// The composite create port (lib/creates-port.js createCompositeCreatesPort) and its catalog (lib/creates-catalog.js): the shared
// contract the declared-artifact helpers build on. The real port runs over the REAL bundled SDK and the plugin's REAL HTTP client,
// against an in-memory Dataverse that holds charts (savedqueryvisualizations), so what is asserted is what reached the wire.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const { chartDef } = require('../lib/sdk-build.js');
const { createCreatesPort, createCompositeCreatesPort, createCompositePortForSpec, interpretCompositePush } = require('../lib/creates-port.js');
const { createIntentCatalog, identityFor, reserveChildren, compositeCapability, routeIntent } = require('../lib/creates-catalog.js');
const { intentFor } = require('../lib/creates-capabilities.js');
const { stableChildIdV1 } = require('../lib/creates-identity.js');

const BUNDLE = path.join(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');
const ENV = 'https://contoso.crm.dynamics.com';
const SCOPE = { kind: 'table', solution: 'contosocore', table: 'account' };
const DEF = chartDef({}, { entity: 'account', name: 'By owner', chartType: 'column', groupBy: 'ownerid' });
const CHART = { catalogKind: 'chart', key: 'account|by owner', scope: SCOPE, declaration: { name: DEF.name } };
const VIEW = { catalogKind: 'view', key: 'account|active', scope: SCOPE, declaration: { name: 'Active accounts', queryType: 0 } };
const FORM = { catalogKind: 'form', key: 'account|main', scope: SCOPE, declaration: { name: 'Account main', formType: 'main' } };
const BPF = { catalogKind: 'bpf', key: 'account|onboarding', scope: SCOPE, declaration: { name: 'Onboarding' } };
const STABLE = { createIdentity: 'stable-v1' };
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const counter = () => {
  let n = 0;
  return { newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` };
};

// A Dataverse holding charts, as the SDK's create and read requests meet it. A POST of an id that already holds a row answers
// 412 0x80040237 (Dataverse's duplicate-key answer to a create that supplies its own id).
function chartOrg() {
  const rows = new Map();
  const requests = [];
  const json = (statusCode, body, headers = {}) => ({ statusCode, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  async function request({ url, method, body }) {
    const u = new URL(url);
    const p = decodeURIComponent(u.pathname + u.search);
    requests.push({ method, path: p, body });
    if (/EntityDefinitions\(LogicalName='savedqueryvisualization'\)/.test(p)) return json(200, { EntitySetName: 'savedqueryvisualizations' });
    if (method === 'POST' && /\/savedqueryvisualizations$/.test(u.pathname)) {
      const sent = JSON.parse(body);
      if (rows.has(sent.savedqueryvisualizationid)) return json(412, { error: { code: '0x80040237', message: 'A record with matching key values already exists.' } });
      rows.set(sent.savedqueryvisualizationid, { ...sent, version: 1 });
      return json(201, { savedqueryvisualizationid: sent.savedqueryvisualizationid, '@odata.etag': 'W/"1"' }, { etag: 'W/"1"' });
    }
    return json(200, { value: [] });
  }
  return { request, requests, rows, posts: () => requests.filter((r) => r.method === 'POST') };
}

async function newSdk(org) {
  const { createMakerSdk, createNodeWorkspaceStorage } = require(BUNDLE);
  const httpClient = createAzHttpClient(ENV, { getToken: () => 'token', request: org.request, sleep: async () => {} });
  const sdk = createMakerSdk({ instanceUrl: ENV, workspaceStorage: createNodeWorkspaceStorage(makeTempDir('creates-composite-')), httpClient });
  await sdk.initWorkspace();
  return sdk;
}

const chartPort = (extra = {}) => createCompositePortForSpec(STABLE, { intents: [CHART, VIEW], shippedKinds: ['view', 'chart'], ...extra });
const pushChart = (sdk) => async ({ id }) => {
  await sdk.createArtifact('chart', { ...DEF, id });
  return sdk.pushArtifact('chart', id);
};

test('real port, real bundle: an acknowledged create is sent with the derived id once; a new process derives the same id', async () => {
  const org = chartOrg();
  const attempts = [];
  const port = chartPort({ onAttempt: async (a) => { attempts.push({ ...a, posts: org.posts().length }); } });
  assert.strictEqual(port.mode, 'composite');
  const { id } = port.identityFor('chart', CHART.key);
  assert.match(id, GUID);
  const out = await port.run({ kind: 'chart', key: CHART.key }, pushChart(await newSdk(org)));
  assert.deepStrictEqual([out.outcome, out.evidence, out.id, out.code], ['created', 'sdk-acknowledged', id, '']);
  assert.strictEqual(out.sdkResult.saved, true, 'the SDK answer is kept');
  assert.ok(!('origin' in out), 'the port sets no origin');
  assert.strictEqual(org.posts().length, 1);
  assert.strictEqual(JSON.parse(org.posts()[0].body).savedqueryvisualizationid, id, 'the create itself carries the stable id');
  assert.deepStrictEqual(attempts, [{ kind: 'chart', key: CHART.key, id, childIds: {}, posts: 0 }], 'the attempt is told before anything is sent');
  assert.strictEqual(chartPort().identityFor('chart', CHART.key).id, id);
});

test('real port, real bundle: a create the SDK refuses by value is refused with its own code and its SDK answer', async () => {
  const org = chartOrg();
  const { id } = chartPort().identityFor('chart', CHART.key);
  org.rows.set(id, { savedqueryvisualizationid: id, name: 'theirs', version: 3 });
  const out = await chartPort().run({ kind: 'chart', key: CHART.key }, pushChart(await newSdk(org)));
  assert.strictEqual(out.outcome, 'refused');
  assert.strictEqual(out.id, id);
  assert.strictEqual(out.code, out.sdkResult.error.code, 'the code is the SDK\u2019s, unchanged');
  assert.strictEqual(out.sdkResult.saved, false);
  assert.strictEqual(org.rows.get(id).name, 'theirs');
});

test('a thrown failure is rethrown as the same object, after one call, with the attempted ids', async () => {
  const boom = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  let calls = 0;
  const port = chartPort();
  await assert.rejects(port.run({ kind: 'chart', key: CHART.key }, async () => { calls++; throw boom; }), (e) => e === boom && e.createAttempt.id === port.identityFor('chart', CHART.key).id);
  assert.strictEqual(calls, 1);
});

test('interpretCompositePush: native match, lower-case codes, unknown answers and a different id', () => {
  const attempt = { kind: 'view', key: VIEW.key, id: 'AAAAAAAA-AAAA-5AAA-8AAA-AAAAAAAAAAAA', childIds: { 'tab:a': 'b' } };
  const id = attempt.id.toLowerCase();
  // The raw answer the bundled SDK gives when it adopts the exact row at the sent id (persistAdoption): saved false, no error.
  const adopted = { type: 'view', id, saved: false, adoptedExisting: true, shipped: false, publish: { kind: 'notRequested' } };
  const matched = interpretCompositePush(adopted, attempt);
  assert.deepStrictEqual([matched.outcome, matched.evidence, matched.id, matched.sdkResult], ['matched', 'native-match', id, adopted]);
  assert.deepStrictEqual(matched.childIds, { 'tab:a': 'b' });
  assert.strictEqual(interpretCompositePush({ ...adopted, error: { code: 'X_FAILED' } }, attempt).outcome, 'refused', 'an adoption beside an error is not a match');
  assert.strictEqual(interpretCompositePush({ outcome: 'refused', code: 'create-ownership-required' }, attempt).code, 'create-ownership-required');
  assert.strictEqual(interpretCompositePush({ outcome: 'unknown', code: 'create-completion-required' }, attempt).code, 'create-completion-required');
  assert.strictEqual(interpretCompositePush({ outcome: 'unknown', code: 'not a code!' }, attempt).code, 'WRITE_OUTCOME_UNKNOWN');
  assert.strictEqual(interpretCompositePush({ outcome: 'unknown' }, attempt).code, 'WRITE_OUTCOME_UNKNOWN');
  for (const empty of [undefined, null, 'saved']) assert.deepStrictEqual(interpretCompositePush(empty, attempt).code, 'create-identity-unverified');
  assert.strictEqual(interpretCompositePush({ outcome: 'saved' }, attempt).code, 'create-identity-unverified', 'a saved answer with no id is not a receipt');
  const other = interpretCompositePush({ outcome: 'saved', id: '0f0f0f0f-1111-4222-8333-444444444444' }, attempt);
  assert.deepStrictEqual([other.outcome, other.code], ['unknown', 'create-identity-conflict']);
  const refused = interpretCompositePush({ outcome: 'refused', code: 'PUSH_FAILED', rules: ['r1'], sdkResult: { saved: false } }, attempt);
  assert.deepStrictEqual([refused.rules, refused.sdkResult], [['r1'], { saved: false }]);
});

test('the old per-port ids are unchanged: the composite catalog derives the ids the stable port derives', () => {
  for (const intent of [CHART, VIEW]) {
    const old = createCreatesPort({ mode: 'stable', protectedKinds: [intent.catalogKind], intents: [intentFor(intent.catalogKind, { key: intent.key, scope: SCOPE, declaration: intent.declaration })] });
    assert.strictEqual(chartPort().identityFor(intent.catalogKind, intent.key).id, old.identityFor(intent.catalogKind, intent.key).id);
  }
  // Frozen: a change here re-keys every chart and view a stable-v1 app already created.
  assert.strictEqual(chartPort().identityFor('chart', CHART.key).id, CHART_ID);
  assert.strictEqual(chartPort().identityFor('view', VIEW.key).id, VIEW_ID);
});
const CHART_ID = '06eba6aa-595a-5e00-8781-bc7ee5897c07';
const VIEW_ID = 'e1d0fb31-7385-5e72-b407-1c4bd29ed780';

test('the old aggregate still refuses the four feature kinds; only the composite capability takes them', () => {
  for (const kind of ['form', 'dashboard', 'businessRule', 'bpf']) {
    assert.throws(() => createCreatesPort({ mode: 'stable', protectedKinds: [kind] }), (e) => /^create-identity-/.test(e.code), kind);
    assert.strictEqual(compositeCapability(kind).catalogKind, kind);
  }
  assert.deepStrictEqual(['form', 'dashboard', 'businessRule', 'bpf', 'view', 'chart'].map((k) => [compositeCapability(k).family, compositeCapability(k).bindingKind]),
    [['form', 'form'], ['dashboard', 'dashboard'], ['rule', 'business-rule'], ['bpf', 'bpf'], ['view', 'view'], ['chart', 'chart']]);
  for (const alias of ['formPageEmbed', 'form-layout', 'webResource', 'appTheme', 'nope']) {
    assert.throws(() => compositeCapability(alias), (e) => e.code === 'create-identity-unsupported', alias);
  }
});

test('an unsupported kind or child is refused before execute, so no local SDK edit is ever made for it', async () => {
  assert.throws(() => createCompositePortForSpec(STABLE, { intents: [CHART], shippedKinds: ['formPageEmbed'] }), (e) => e.code === 'create-identity-unsupported');
  const port = createCompositeCreatesPort({ catalog: createIntentCatalog([FORM, BPF]) });
  let calls = 0;
  const execute = async () => { calls++; return { outcome: 'saved' }; };
  await assert.rejects(port.run({ kind: 'form', key: FORM.key, childKeys: ['tab:general'] }, execute), (e) => e.code === 'create-identity-unsupported');
  await assert.rejects(port.run({ kind: 'form', key: FORM.key, children: [{ locator: 'x', childKind: 'formHostControl', keyParts: ['timeline', 'timeline'] }] }, execute), (e) => e.code === 'create-identity-unsupported', 'a timeline has no control slot');
  await assert.rejects(port.run({ kind: 'form', key: FORM.key, children: [{ locator: 'x', childKind: 'bpfStage', keyParts: ['s'] }] }, execute), (e) => e.code === 'create-identity-unsupported', 'a form has no stage');
  await assert.rejects(port.run({ kind: 'bpf', key: BPF.key, children: [{ locator: 's', childKind: 'bpfStage', keyParts: ['qualify'] }, { locator: 'st', childKind: 'bpfStep', keyParts: ['qualify'], parentLocator: 's' }] }, execute),
    (e) => e.code === 'create-identity-invalid' && /expected 2/.test(e.message), 'a one-part step is the wrong shape');
  assert.strictEqual(calls, 0);
});

test('a sibling of a declared kind that the spec does not declare is the plain pass-through, not refused', async () => {
  const ids = counter();
  const port = createCompositeCreatesPort({ catalog: createIntentCatalog([FORM]), newId: ids.newId });
  const seen = [];
  const out = await port.run({ kind: 'form', key: 'account|legacy quick create' }, async (got) => { seen.push(got); return { ok: true }; });
  assert.deepStrictEqual(seen, [{ id: '00000000-0000-4000-8000-000000000001', childIds: {} }]);
  assert.strictEqual(out.outcome, 'created');
  assert.strictEqual(routeIntent({ kind: 'form', key: 'account|legacy quick create' }, { catalog: port.catalog }), 'legacy');
  assert.strictEqual(routeIntent({ kind: 'form', key: FORM.key }, { catalog: port.catalog }), 'composite');
  assert.strictEqual(port.protects('form'), false, 'a kind is never protected as a whole');
  assert.strictEqual(port.identityFor('form', 'account|legacy quick create'), null);
});

test('the spec decides: no createIdentity is the pass-through; stable-v1 protects only views and charts unless a feature is declared', () => {
  assert.strictEqual(createCompositePortForSpec({}, { intents: [CHART, VIEW], shippedKinds: ['view', 'chart'] }).mode, 'passthrough');
  assert.throws(() => createCompositePortForSpec({ createIdentity: 'stable-v2' }, { intents: [CHART], shippedKinds: ['chart'] }), (e) => e.code === 'create-identity-invalid');
  const shipped = createCompositePortForSpec(STABLE, { intents: [CHART, FORM], shippedKinds: ['view', 'chart'] });
  assert.deepStrictEqual([shipped.protects('chart', CHART.key), shipped.protects('form', FORM.key)], [true, false]);
  const feature = createCompositePortForSpec({}, { intents: [CHART, FORM], shippedKinds: ['view', 'chart'], featureKinds: ['form'] });
  assert.deepStrictEqual([feature.protects('chart', CHART.key), feature.protects('form', FORM.key)], [false, true]);
});

test('children: reserved under the actual root id; a step under its stage, so different imported stage ids give different steps', () => {
  const catalog = createIntentCatalog([BPF]);
  const derived = identityFor('bpf', BPF.key, { catalog });
  const imported = 'C0C0C0C0-0000-4000-8000-000000000001';
  const actual = identityFor('bpf', BPF.key, { catalog, actualRootId: imported });
  assert.deepStrictEqual([actual.id, actual.source, actual.derivedId], [imported.toLowerCase(), 'actual', derived.id]);
  const stageUnder = (rootId) => reserveChildren('bpf', BPF.key, { catalog, actualRootId: rootId, children: [{ locator: 's', childKind: 'bpfStage', keyParts: ['qualify'] }] }).childIds.s;
  assert.notStrictEqual(stageUnder(imported), stageUnder(undefined), 'a stage follows the root it sits under');
  assert.strictEqual(stageUnder(imported), stableChildIdV1(imported.toLowerCase(), 'bpfStage', ['qualify']));
  const stepUnder = (stageId) => reserveChildren('bpf', BPF.key, { catalog, children: [{ locator: 'st', childKind: 'bpfStep', keyParts: ['qualify', 'contact'], actualParentId: stageId }] }).childIds.st;
  const a = stepUnder('11111111-0000-4000-8000-000000000001');
  const b = stepUnder('22222222-0000-4000-8000-000000000002');
  assert.notStrictEqual(a, b);
  assert.strictEqual(a, stableChildIdV1('11111111-0000-4000-8000-000000000001', 'bpfStep', ['qualify', 'contact']));
  const both = reserveChildren('bpf', BPF.key, { catalog, children: [{ locator: 'st', childKind: 'bpfStep', keyParts: ['qualify', 'contact'], parentLocator: 's' }, { locator: 's', childKind: 'bpfStage', keyParts: ['qualify'] }] });
  assert.strictEqual(both.childIds.st, stableChildIdV1(both.childIds.s, 'bpfStep', ['qualify', 'contact']), 'a step may precede its stage in the list');
});

test('the catalog refuses a twice-declared slot and two names that are one artifact, before any create', () => {
  assert.throws(() => createIntentCatalog([CHART, { ...CHART }]), (e) => e.code === 'create-identity-invalid' && /twice/.test(e.message));
  assert.throws(() => createIntentCatalog([CHART, { ...CHART, key: 'other key', declaration: { name: DEF.name.toUpperCase() } }]), (e) => e.code === 'create-identity-invalid' && /one artifact/.test(e.message));
});

test('incarnations: a key whose root was retired takes its stored incarnation as its derived id, and every child follows it; other keys keep their stable id', () => {
  const plain = createIntentCatalog([FORM, BPF, VIEW]);
  const REBORN = 'D0D0D0D0-0000-4000-8000-000000000001';
  let n = 0;
  // One stored entry (managed-bindings.js incarnations()): each gets an identity of its own unless the test names one.
  const inc = (family, key, rootId, over = {}) => ({ family, key, identity: `eeeeeeee-0000-4000-8000-${String(n += 1).padStart(12, '0')}`, rootId, epoch: 1, ...over });
  const catalog = createIntentCatalog([FORM, BPF, VIEW], { incarnations: [inc('bpf', BPF.key, REBORN), inc('form', 'account|other', '00000000-0000-4000-8000-0000000000aa')] });
  const stable = identityFor('bpf', BPF.key, { catalog: plain });
  const reborn = identityFor('bpf', BPF.key, { catalog });
  assert.deepStrictEqual([reborn.id, reborn.source, reborn.derivedId], [REBORN.toLowerCase(), 'derived', REBORN.toLowerCase()]);
  assert.strictEqual(catalog.get('bpf', BPF.key).stableId, stable.id, 'the stable id is still the spec\'s own');
  assert.deepStrictEqual(identityFor('form', FORM.key, { catalog }), identityFor('form', FORM.key, { catalog: plain }), 'a key with no incarnation is unchanged');
  assert.strictEqual(identityFor('bpf', BPF.key, { catalog, actualRootId: stable.id }).id, stable.id, 'a bound root still wins');
  const stage = [{ locator: 's', childKind: 'bpfStage', keyParts: ['qualify'] }];
  assert.strictEqual(reserveChildren('bpf', BPF.key, { catalog, children: stage }).childIds.s, stableChildIdV1(REBORN.toLowerCase(), 'bpfStage', ['qualify']));
  // The family is the store's (a rule is `rule`, not its catalog kind); a matching key of another family is not this one's.
  const RULE = { catalogKind: 'businessRule', key: 'account/hide', scope: SCOPE, declaration: { name: 'Hide' } };
  assert.strictEqual(createIntentCatalog([RULE], { incarnations: [inc('rule', RULE.key, REBORN)] }).identityFor('businessRule', RULE.key).id, REBORN.toLowerCase());
  assert.notStrictEqual(createIntentCatalog([RULE], { incarnations: [inc('bpf', RULE.key, REBORN)] }).identityFor('businessRule', RULE.key).id, REBORN.toLowerCase());
  // The plan's token for the store's fence: the stable id it selects by, and the epoch and root it selected.
  assert.deepStrictEqual({ ...catalog.get('bpf', BPF.key).incarnation }, { identity: stable.id, epoch: 1, rootId: REBORN.toLowerCase() });
  assert.deepStrictEqual({ ...catalog.incarnationOf('form', FORM.key) }, { identity: catalog.get('form', FORM.key).stableId, epoch: 0, rootId: null });
  assert.strictEqual(catalog.incarnationOf('form', 'not declared'), undefined);
  // Selected by the catalog's canonical identity too: an entry stored under another key (an earlier spelling of the same
  // artifact) whose identity is this declaration's stable id is its incarnation, never the retired stable id. Its own
  // key's entry wins over one of the same identity.
  const aliased = createIntentCatalog([BPF], { incarnations: [inc('bpf', 'account/Earlier spelling', REBORN, { identity: stable.id, epoch: 3 })] });
  assert.deepStrictEqual([aliased.identityFor('bpf', BPF.key).id, aliased.get('bpf', BPF.key).incarnation.epoch], [REBORN.toLowerCase(), 3]);
  const both = createIntentCatalog([BPF], { incarnations: [inc('bpf', 'account/Earlier spelling', REBORN, { identity: stable.id }), inc('bpf', BPF.key, '00000000-0000-4000-8000-0000000000cc')] });
  assert.strictEqual(both.identityFor('bpf', BPF.key).id, '00000000-0000-4000-8000-0000000000cc');
  assert.strictEqual(createIntentCatalog([BPF], { incarnations: [inc('rule', 'x', REBORN, { identity: stable.id })] }).identityFor('bpf', BPF.key).id, stable.id, 'an identity of another family is not this one\'s');
  for (const [label, incarnations] of [
    ['not a list', {}],
    ['no key', [inc('bpf', undefined, REBORN)]],
    ['no GUID', [inc('bpf', BPF.key, 'next')]],
    ['no identity', [inc('bpf', BPF.key, REBORN, { identity: undefined })]],
    ['no epoch', [inc('bpf', BPF.key, REBORN, { epoch: 0 })]],
    ['one key twice', [inc('bpf', BPF.key, REBORN), inc('bpf', BPF.key, '00000000-0000-4000-8000-0000000000bb')]],
    ['one identity twice', [inc('bpf', 'a', REBORN, { identity: stable.id }), inc('bpf', 'b', '00000000-0000-4000-8000-0000000000bb', { identity: stable.id })]],
    ['an incarnation that is another declaration\'s id', [inc('bpf', BPF.key, identityFor('view', VIEW.key, { catalog: plain }).id)]],
  ]) {
    assert.throws(() => createIntentCatalog([FORM, BPF, VIEW], { incarnations }), (e) => e.code === 'create-identity-invalid', label);
  }
});
