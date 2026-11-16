'use strict';
// Declared form layouts (forms[].reconcile: "declared") wired into the build: the spec gate, the forms phase's dispatch to the
// managed form helper (lib/form-layout-reconcile.js reconcileDeclaredForm), the halt it is given, the per-table publish the
// managed publisher owes, and the CLI's typed `publication-risk:<scopeKey>/<dispatch>` acceptance after a publish whose answer was lost.
// Everything runs through the real engine (lib/sdk-build.js runSdkBuild), the real vendored SDK and the fake Dataverse org,
// with the CLI's transport shape (helpers/gated-fake-client.js: the publication barrier with the send observer inside it).
// The build path is behind lib/declared-features.js; each test that needs it switches it on and back.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../vendor/cds-maker-sdk.cjs');
const { runSdkBuild } = require('../lib/sdk-build.js');
const { validateAppSpec } = require('../lib/app-spec.js');
const { lintAppSpec } = require('../lib/spec-lint.js');
const { openManagedBindings } = require('../lib/managed-bindings.js');
const { createPublicationBarrier } = require('../lib/publication-barrier.js');
const { createAttemptSendObserver } = require('../lib/managed-feature-contract.js');
const { buildModelApp, authorizationKeys } = require('../build-model-app.js');
const { readerFor, isolatedReaderFor } = require('../verify-model-app.js');
const { main: downloadMain } = require('../download-model-app.js');
const { verifySpec } = require('../lib/verify-spec.js');
const { readVerifyManifest } = require('../lib/declared-form-io.js');
const { storeFileName } = require('../lib/managed-bindings.js');
const { environmentFingerprint } = require('../lib/page-ownership-records.js');
const { DECLARED_FEATURES } = require('../lib/declared-features.js');
const { createFakeBuildOrg } = require('./helpers/fake-app-build-org.js');
const { gatedClient } = require('./helpers/gated-fake-client.js');
const { withSecondLanguageCaptions, withoutLanguage } = require('./helpers/platform-labels.js');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const newDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'declared-forms-')); dirs.push(d); return d; };

const ENTITIES = { contoso_item: { attributes: { contoso_name: 'String', contoso_code: 'String' } } };
const SOLUTION = 'ContosoDeclared';
const APP = 'contoso_declaredforms';
const KEY = 'contoso_item/main/declared item';

function makeSpec({ declared = true, form = {} } = {}) {
  return {
    solution: { uniqueName: SOLUTION, displayName: 'Contoso Declared', publisherPrefix: 'contoso' },
    app: { name: 'Declared Forms', uniqueName: APP },
    entities: [{ schemaName: 'contoso_item', displayName: 'Item', existing: true, primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns: [{ schemaName: 'contoso_code', displayName: 'Code', type: 'Text' }] }],
    forms: [{
      entity: 'contoso_item', name: 'Declared Item', formType: 'Main', ...(declared ? { reconcile: 'declared' } : {}),
      tabs: [{ name: 'general', label: 'General', sections: [{ name: 'main', label: 'Main', fields: ['contoso_name', 'contoso_code'] }] }],
      ...form,
    }],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Records', subAreas: [{ entity: 'contoso_item', title: 'Items' }] }] }] },
  };
}

async function withForms(on, fn) {
  const was = DECLARED_FEATURES.forms;
  DECLARED_FEATURES.forms = on;
  try { return await fn(); } finally { DECLARED_FEATURES.forms = was; }
}

const rootOrigin = (g) => (g.records.find((r) => r.kind === 'form' && r.key === KEY) || {}).origin;
const storeOf = (org, dir) => openManagedBindings({ workspaceDir: dir, environment: org.origin, appUniqueName: APP, solutionUniqueName: SOLUTION });

// One invocation: a fresh barrier, observer and SDK over `dir` (a stopped invocation's SDK and observer are retired).
async function build(org, dir, spec, { barrier = createPublicationBarrier(), ...opts } = {}) {
  const sendObserver = createAttemptSendObserver();
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: org.origin, httpClient: gatedClient(org, barrier, sendObserver) });
  await sdk.initWorkspace();
  const mark = org.calls.length;
  let out;
  let err;
  try {
    out = await runSdkBuild(spec, { sdk, apply: true, publish: false, workspaceDir: dir, appDir: dir, env: org.origin, warn: () => {}, phases: ['forms'], publicationBarrier: barrier, sendObserver, ...opts });
  } catch (e) {
    err = e;
  }
  const calls = org.calls.slice(mark);
  return { out, err, calls, writes: calls.filter((c) => c.method !== 'GET'), tablePublishes: org.tablePublishes(mark), barrier };
}

const formPosts = (r) => r.writes.filter((c) => c.method === 'POST' && /^\/systemforms(?:\?|$)/.test(c.path));
const formWrites = (r) => r.writes.filter((c) => /^\/systemforms/.test(c.path));
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const shape = (calls) => calls.map((c) => `${c.method} ${c.path.replace(GUID, '<id>')}`);

// Every word a stop says: its message, its causes and the findings it carries.
function chainText(err) {
  const out = [];
  for (let e = err, n = 0; e && n < 10; e = e.cause, n += 1) {
    out.push(String(e.message || ''));
    for (const f of Array.isArray(e.findings) ? e.findings : []) out.push(`${f.code}: ${f.message}`);
  }
  return out.join('\n');
}

// The first PublishXml naming contoso_item loses its answer: the request reaches the org (applied) or never does.
function losePublish(org, { applied }) {
  let n = 0;
  return org.intercept((r) => r.method === 'POST' && r.path === '/PublishXml' && /contoso_item/.test(JSON.stringify(r.body)) && n++ === 0, async (r) => {
    if (applied) await org.fake.httpClient.post(`${org.origin}/api/data/v9.2/PublishXml`, r.body);
    throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  });
}

// --- the spec gate -----------------------------------------------------------------------------------------------------------

test('with the build path off, a declared form is refused with the words it always had', async () => {
  await withForms(false, () => {
    const v = validateAppSpec(makeSpec(), { profile: 'deploy' });
    assert.equal(v.ok, false);
    assert.ok(v.errors.includes("forms: 'Declared Item' — reconcile is supported only on views, charts, dashboards, business rules, business process flows and web resources; leave it out (this artifact keeps the existing build behaviour)"), JSON.stringify(v.errors));
  });
});

test('with the build path on, a declared form validates and refuses what the declared build cannot keep proved', async () => {
  await withForms(true, () => {
    assert.equal(validateAppSpec(makeSpec(), { profile: 'deploy' }).ok, true);
    const refused = (form, entityExtra = {}) => {
      const spec = makeSpec({ form });
      Object.assign(spec.entities[0], entityExtra);
      const v = validateAppSpec(spec, { profile: 'deploy' });
      assert.equal(v.ok, false, JSON.stringify(form));
      return v.errors.join('\n');
    };
    assert.match(refused({ reconcile: 'additive' }), /reconcile must be "declared"/);
    assert.match(refused({ prune: false }), /never deletes what the spec omits; remove "prune"/);
    assert.match(refused({ isDefault: true }), /isDefault is not supported on a declared form/);
    assert.match(refused({ deactivateOtherMainForms: true }), /deactivateOtherMainForms is not supported on a declared form/);
    assert.match(refused({ securityRoles: ['Salesperson'] }), /securityRoles is not supported on a declared form/);
    assert.match(refused({}, { mainFormOrder: ['Declared Item'] }), /cannot be listed in entities\[\]\.mainFormOrder/);
    const twice = makeSpec();
    twice.forms.push({ ...twice.forms[0], name: 'DECLARED ITEM' });
    assert.match(validateAppSpec(twice, { profile: 'deploy' }).errors.join('\n'), /same key \(form:contoso_item\/main\/declared item\)/);
  });
});

test('an explicit false flag is accepted on a declared form only', async () => {
  await withForms(true, () => {
    const options = { fieldOptions: { contoso_code: { readOnly: false, hidden: false } } };
    assert.equal(validateAppSpec(makeSpec({ form: options }), { profile: 'deploy' }).ok, true);
    const legacy = validateAppSpec(makeSpec({ declared: false, form: options }), { profile: 'deploy' });
    assert.match(legacy.errors.join('\n'), /sets readOnly: false, which the build cannot apply/);
  });
  await withForms(false, () => {
    const off = validateAppSpec(makeSpec({ declared: false, form: { fieldOptions: { contoso_code: { readOnly: false } } } }), { profile: 'deploy' });
    assert.match(off.errors.join('\n'), /sets readOnly: false, which the build cannot apply/);
  });
});

test('spec-lint does not advise prune: false on a declared form, and still does elsewhere', async () => {
  // A flag on a field no layout places; the auto layout (no tabs) is what the advice is about.
  const lintOf = (declared) => {
    const spec = makeSpec({ declared, form: { tabs: undefined, fieldOptions: { contoso_other: { readOnly: true } } } });
    return lintAppSpec(spec).warnings.join('\n');
  };
  await withForms(true, () => {
    assert.match(lintOf(false), /\(prune: false keeps the rest of the form\)/);
    const declared = lintOf(true);
    assert.match(declared, /contoso_other/);
    assert.doesNotMatch(declared, /prune: false/);
  });
});

// --- the forms phase ---------------------------------------------------------------------------------------------------------

test('with the build path off, an undeclared form sends exactly the requests it sent with the path on', async () => {
  const run = (on) => withForms(on, async () => {
    const org = createFakeBuildOrg({ entities: ENTITIES });
    const r = await build(org, newDir(), makeSpec({ declared: false }));
    assert.equal(r.err, undefined, chainText(r.err));
    return shape(r.calls);
  });
  const off = await run(false);
  assert.ok(off.some((c) => c.startsWith('POST /systemforms')), 'the legacy form is created');
  assert.deepEqual(await run(true), off);
});

test('a declared form is created once, published once with its table, and a rebuild sends no form write and no publish', async () => {
  await withForms(true, async () => {
    const org = createFakeBuildOrg({ entities: ENTITIES });
    const dir = newDir();
    const first = await build(org, dir, makeSpec());
    assert.equal(first.err, undefined, chainText(first.err));
    assert.equal(formPosts(first).length, 1);
    assert.deepEqual(first.tablePublishes, [['contoso_item']]);
    const g = storeOf(org, dir).readGroup('form', KEY);
    assert.equal(rootOrigin(g.committed), 'created');
    assert.equal(g.committed.publication.state, 'confirmed');
    assert.equal(first.out.created.formIds && Object.values(first.out.created.formIds)[0], g.committed.root.id);
    const again = await build(org, dir, makeSpec());
    assert.equal(again.err, undefined, chainText(again.err));
    assert.deepEqual(formWrites(again), []);
    assert.deepEqual(again.tablePublishes, []);
  });
});

// An organization with a second language (3082) provisioned beside its base one: the saved read of a form carries a caption in it
// beside the base one on each cell whose caption has text, and the published read never returns one (helpers/platform-labels.js).
// The caption the published read cannot carry is not compared, so the table publish of a declared form is confirmed there too.
function twoLanguages(org, lcid = 3082) {
  return org.intercept((r) => r.method === 'GET' && /^\/systemforms/.test(r.path), async (r) => {
    const res = await org.fake.httpClient.get(`${org.origin}/api/data/v9.2${r.path}`);
    const savedLayer = /RetrieveUnpublished/.test(r.path);
    const read = (row) => (row && typeof row.formxml === 'string' ? { ...row, formxml: savedLayer ? withSecondLanguageCaptions(row.formxml, lcid) : withoutLanguage(row.formxml, lcid) } : row);
    return { ...res, body: res.body && Array.isArray(res.body.value) ? { ...res.body, value: res.body.value.map(read) } : read(res.body) };
  });
}

test('in an organization of two languages a declared form is created and its table publish confirmed; a rebuild sends nothing and a changed declaration publishes once', async () => {
  await withForms(true, async () => {
    const org = createFakeBuildOrg({ entities: ENTITIES });
    twoLanguages(org);
    const dir = newDir();
    const first = await build(org, dir, makeSpec(), { publicationSettle: { sleep: async () => {} } });
    assert.equal(first.err, undefined, chainText(first.err));
    assert.equal(formPosts(first).length, 1);
    assert.deepEqual(first.tablePublishes, [['contoso_item']]);
    const id = storeOf(org, dir).readGroup('form', KEY).committed.root.id;
    assert.equal(storeOf(org, dir).readGroup('form', KEY).committed.publication.state, 'confirmed');
    const saved = String((await org.fake.httpClient.get(`${org.origin}/api/data/v9.2/systemforms(${id})/Microsoft.Dynamics.CRM.RetrieveUnpublished()?$select=formxml`)).body.formxml);
    assert.ok(!saved.includes('languagecode="3082"'), 'the fake org itself holds one language; the second is in its reads');
    const again = await build(org, dir, makeSpec(), { publicationSettle: { sleep: async () => {} } });
    assert.equal(again.err, undefined, chainText(again.err));
    assert.deepEqual(formWrites(again), []);
    assert.deepEqual(again.tablePublishes, []);
    const changed = makeSpec();
    changed.forms[0].tabs[0].sections[0].fields = ['contoso_code', 'contoso_name'];
    const moved = await build(org, dir, changed, { publicationSettle: { sleep: async () => {} } });
    assert.equal(moved.err, undefined, chainText(moved.err));
    assert.deepEqual(moved.tablePublishes, [['contoso_item']]);
    assert.equal(storeOf(org, dir).readGroup('form', KEY).committed.publication.state, 'confirmed');
  });
});

test('a declared form found unbound halts through the build halt naming the typed adoption approval, and binds with it', async () => {
  await withForms(true, async () => {
    const org = createFakeBuildOrg({ entities: ENTITIES });
    assert.equal((await build(org, newDir(), makeSpec())).err, undefined);
    const dir = newDir(); // a fresh workspace: no binding for the form the first build created
    // A form that already holds the declared layout needs no write: nothing is sent and nothing is bound.
    const same = await build(org, dir, makeSpec());
    assert.equal(same.err, undefined, chainText(same.err));
    assert.deepEqual(same.writes, []);
    assert.equal(storeOf(org, dir).readGroup('form', KEY).committed, null);
    // One the spec changes is a first binding of a form this run did not create.
    const changed = makeSpec();
    changed.forms[0].tabs[0].sections[0].fields = ['contoso_code', 'contoso_name'];
    const halted = await build(org, dir, changed);
    assert.ok(halted.err, 'the unbound form is not taken over');
    assert.equal(halted.err.code, 'form-layout-adoption-not-authorized');
    assert.equal(halted.err.transient, false);
    assert.match(halted.err.message, /declared form "contoso_item\/main\/declared item"/);
    assert.ok(halted.err.message.includes(`(approve with --authorize "adopt:form:${KEY}")`), halted.err.message);
    // The phase runner wraps the halt the helper threw; that halt is the build's own (managedStop), with the finding it names.
    const own = (() => { for (let e = halted.err; e; e = e.cause) if (Array.isArray(e.findings)) return e; return null; })();
    assert.ok(own, chainText(halted.err));
    assert.equal(own.name, 'BuildHalt');
    assert.equal(own.code, 'form-layout-adoption-not-authorized');
    assert.deepEqual(own.findings.map((f) => f.code), ['form-layout-adoption-not-authorized']);
    assert.deepEqual(formWrites(halted), [], 'nothing is written over the unbound form');
    assert.deepEqual(halted.tablePublishes, []);
    assert.equal(storeOf(org, dir).readGroup('form', KEY).committed, null);
    // An approval of another family or key does not approve it.
    assert.equal((await build(org, dir, changed, { authorizedAdoption: new Set([`view:${KEY}`]) })).err.code, halted.err.code);
    const bound = await build(org, dir, changed, { authorizedAdoption: new Set([`form:${KEY}`]) });
    assert.equal(bound.err, undefined, chainText(bound.err));
    assert.deepEqual(formPosts(bound), [], 'no second form');
    assert.equal(rootOrigin(storeOf(org, dir).readGroup('form', KEY).committed), 'adopted');
    // Later commits need no new grant.
    const later = makeSpec();
    later.forms[0].tabs[0].label = 'Summary';
    const relabelled = await build(org, dir, makeSpec());
    assert.equal(relabelled.err, undefined, chainText(relabelled.err));
    assert.ok(formWrites(relabelled).length > 0, 'the change is written');
  });
});

test('a lost publish answer the org applied is confirmed by the next build, which stays withheld, and the one after is clean', async () => {
  await withForms(true, async () => {
    const org = createFakeBuildOrg({ entities: ENTITIES });
    const dir = newDir();
    const restore = losePublish(org, { applied: true });
    const first = await build(org, dir, makeSpec());
    restore();
    assert.ok(first.err, 'the lost answer stops the build');
    assert.equal(storeOf(org, dir).readGroup('form', KEY).committed.publication.state === 'confirmed', false);
    const second = await build(org, dir, makeSpec());
    assert.deepEqual(second.tablePublishes, [], 'the changed published layer is the witness: nothing is sent again');
    assert.equal(storeOf(org, dir).readGroup('form', KEY).committed.publication.state, 'confirmed');
    const third = await build(org, dir, makeSpec());
    assert.equal(third.err, undefined, chainText(third.err));
    assert.deepEqual(third.tablePublishes, []);
    assert.deepEqual(formWrites(third), []);
  });
});

// Every hash a publication records and every read that confirms it are in one domain: the saved layer as the saved/published
// comparison sees it (systemform-published.js savedCompared). In a two-language organization the raw saved row differs from it,
// so a debt recorded in the raw domain would never read as published, and a fresh run would publish the table again.
test('in an organization of two languages a lost publish answer the org applied is confirmed read-only by the next build', async () => {
  await withForms(true, async () => {
    const org = createFakeBuildOrg({ entities: ENTITIES });
    twoLanguages(org);
    const dir = newDir();
    const noWait = { publicationSettle: { sleep: async () => {} } };
    const restore = losePublish(org, { applied: true });
    const first = await build(org, dir, makeSpec(), noWait);
    restore();
    assert.ok(first.err, 'the lost answer stops the build');
    assert.notEqual(storeOf(org, dir).readGroup('form', KEY).committed.publication.state, 'confirmed');
    const second = await build(org, dir, makeSpec(), noWait);
    assert.deepEqual(second.tablePublishes, [], 'the applied publish is never sent again');
    assert.deepEqual(formWrites(second), []);
    assert.equal(storeOf(org, dir).readGroup('form', KEY).committed.publication.state, 'confirmed');
    const third = await build(org, dir, makeSpec(), noWait);
    assert.equal(third.err, undefined, chainText(third.err));
    assert.deepEqual(third.tablePublishes, []);
    assert.deepEqual(formWrites(third), []);
  });
});

test('a lost publish answer the org never applied blocks the table in every later build, with the approval as data', async () => {
  await withForms(true, async () => {
    const org = createFakeBuildOrg({ entities: ENTITIES });
    const dir = newDir();
    const restore = losePublish(org, { applied: false });
    assert.ok((await build(org, dir, makeSpec())).err);
    restore();
    for (const n of [2, 3]) {
      const r = await build(org, dir, makeSpec());
      assert.ok(r.err, `run ${n} stops`);
      const blocked = (() => { for (let e = r.err; e; e = e.cause) if (e.approval) return e; return null; })();
      assert.ok(blocked, `run ${n}: the refusal carries its data`);
      assert.equal(blocked.code, 'managed-publication-unconfirmed');
      assert.match(blocked.dispatchToken, /\S/);
      assert.equal(blocked.approval, riskKey(blocked.dispatchToken), 'the approval names the scope and that dispatch');
      assert.match(blocked.remedy, /\S/);
      assert.deepEqual(r.tablePublishes, [], `run ${n} sends no publish`);
    }
  });
});

// --- the CLI: publication-risk ------------------------------------------------------------------------------------------------

// The typed approval a stop prints for one lost publish: its scope and that dispatch's token.
const riskKey = (token, table = 'contoso_item') => `publication-risk:table:${table}/${token}`;
const DISPATCH = '0f8fad5b-d9cb-469f-a165-70867728950e';

test('--authorize publication-risk is its own typed key: never implied by an untyped key or another family', () => {
  const spec = makeSpec();
  // The scope is matched in any case; the dispatch is kept exactly as printed.
  const typed = authorizationKeys(['--authorize', `publication-risk:table:Contoso_Item/${DISPATCH}`], spec);
  assert.equal(typed.error, null);
  assert.deepEqual([...typed.publicationRisk], [riskKey(DISPATCH)]);
  for (const other of ['contoso_item', 'publication-risk', 'overwrite:view:contoso_item']) {
    assert.equal(authorizationKeys(['--authorize', other], spec).publicationRisk.size, 0, other);
  }
  // A key that names no dispatch is refused: a decision about the scope alone could reach a publish the maker never saw.
  for (const bad of ['publication-risk:table:contoso_item', 'publication-risk:table:contoso_item/', `publication-risk:table:not a table/${DISPATCH}`, `publication-risk:table:contoso_item/a b`]) {
    const parsed = authorizationKeys(['--authorize', bad], spec);
    assert.match(String(parsed.error), /is not publication-risk:table:<table>\/<dispatch>/, bad);
    assert.equal(parsed.publicationRisk.size, 0, bad);
  }
});

test('the CLI prints the remedy and typed approval from the refusal, records only that exact approval, stays stopped, and the next run publishes', async () => {
  await withForms(true, async () => {
    const org = createFakeBuildOrg({ entities: ENTITIES });
    const dir = newDir();
    const forms = (s, o) => runSdkBuild(s, { ...o, phases: ['forms'] });
    const cli = async (extra = {}) => {
      const barrier = createPublicationBarrier();
      const sendObserver = createAttemptSendObserver();
      const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: org.origin, httpClient: gatedClient(org, barrier, sendObserver) });
      await sdk.initWorkspace();
      const said = [];
      const mark = org.calls.length;
      let err;
      try {
        await buildModelApp(makeSpec(), { apply: true, env: org.origin, workspaceDir: dir, appDir: dir, retryDelayMs: 0, ...extra }, { sdk, provisionSdk: sdk, runBuild: forms, publicationBarrier: barrier, sendObserver, warn: (w) => said.push(String(w)), log: () => {} });
      } catch (e) { err = e; }
      return { err, said: said.join('\n'), tablePublishes: org.tablePublishes(mark) };
    };
    const restore = losePublish(org, { applied: false });
    assert.ok((await cli()).err);
    restore();
    const unapproved = await cli();
    assert.ok(unapproved.err);
    const token = (/dispatch (\S+?)\)/.exec(unapproved.said) || [])[1];
    assert.ok(token, unapproved.said);
    assert.equal(token, storeOf(org, dir).readGroup('form', KEY).committed.publication.dispatchToken);
    assert.ok(unapproved.said.includes(`run the build again with --authorize ${riskKey(token)}`), unapproved.said);
    assert.doesNotMatch(unapproved.said, /accepted the risk/);
    // Another scope, another dispatch of this scope, or --allow-destructive, records nothing.
    const wrong = await cli({ allowDestructive: true, publicationRisk: new Set([riskKey(token, 'contoso_other'), riskKey(DISPATCH)]) });
    assert.doesNotMatch(wrong.said, /accepted the risk/);
    assert.deepEqual(wrong.tablePublishes, []);
    const accepted = await cli({ publicationRisk: new Set([riskKey(token)]) });
    assert.ok(accepted.err, 'acceptance is a risk decision, not a proof: the run stays stopped');
    assert.ok(accepted.said.includes(`accepted the risk of dispatch ${token} (${riskKey(token)})`), accepted.said);
    assert.deepEqual(accepted.tablePublishes, []);
    const next = await cli();
    assert.equal(next.err, undefined, chainText(next.err));
    assert.deepEqual(next.tablePublishes, [['contoso_item']]);
    assert.equal(storeOf(org, dir).readGroup('form', KEY).committed.publication.state, 'confirmed');
  });
});

// One CLI invocation (buildModelApp) over `dir`, with the transport the CLI builds, running only `phases`.
async function cliRun(org, dir, spec, extra = {}, phases = ['forms']) {
  const barrier = createPublicationBarrier();
  const sendObserver = createAttemptSendObserver();
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: org.origin, httpClient: gatedClient(org, barrier, sendObserver) });
  await sdk.initWorkspace();
  const said = [];
  const mark = org.calls.length;
  let err;
  let out;
  try {
    out = await buildModelApp(spec, { apply: true, env: org.origin, workspaceDir: dir, appDir: dir, retryDelayMs: 0, ...extra }, { sdk, provisionSdk: sdk, runBuild: (s, o) => runSdkBuild(s, { ...o, phases }), publicationBarrier: barrier, sendObserver, warn: (w) => said.push(String(w)), log: (w) => said.push(String(w)) });
  } catch (e) { err = e; }
  const calls = org.calls.slice(mark);
  return { err, out, said: said.join('\n'), writes: calls.filter((c) => c.method !== 'GET'), tablePublishes: org.tablePublishes(mark) };
}

// The printed approval is accepted wherever the stop comes from: with the form still declared (the forms phase), with its
// declaration removed (nothing in the forms phase stops on it), and on the app-shell path (the app write is withheld).
for (const { name, removed, phases, publish = false } of [
  { name: 'its declaration removed, the forms phase', removed: true, phases: ['forms'] },
  { name: 'its declaration removed, the app write withheld', removed: true, phases: ['forms', 'app-shell'] },
  { name: 'still declared, the app write withheld', removed: false, phases: ['forms', 'app-shell'] },
  { name: 'still declared, --publish: the app write withheld before the publish phase', removed: false, phases: ['forms', 'app-shell', 'publish'], publish: true },
  { name: 'its declaration removed, --publish: the app write withheld before the publish phase', removed: true, phases: ['forms', 'app-shell', 'publish'], publish: true },
]) {
  test(`publication risk (${name}): the exact printed approval is accepted before any write, that run stays stopped, and the next run publishes`, async () => {
    await withForms(true, async () => {
      const org = createFakeBuildOrg({ entities: ENTITIES });
      const dir = newDir();
      const restore = losePublish(org, { applied: false });
      assert.ok((await cliRun(org, dir, makeSpec(), { publish }, phases)).err);
      restore();
      const spec = makeSpec();
      if (removed) spec.forms = [];
      const token = storeOf(org, dir).readGroup('form', KEY).committed.publication.dispatchToken;
      // Without the approval, or with another one, --allow-destructive or --approve all, nothing is accepted.
      for (const extra of [{}, { allowDestructive: true, approve: 'all', publicationRisk: new Set([riskKey(token, 'contoso_other'), riskKey(DISPATCH)]) }]) {
        const denied = await cliRun(org, dir, spec, { publish, ...extra }, phases);
        assert.doesNotMatch(denied.said, /accepted the risk/);
        assert.deepEqual(denied.tablePublishes, []);
        assert.equal(storeOf(org, dir).readGroup('form', KEY).committed.publication.dispatchToken, token);
      }
      const accepted = await cliRun(org, dir, spec, { publish, publicationRisk: new Set([riskKey(token)]) }, phases);
      assert.ok(accepted.err, 'acceptance is a risk decision, not a proof: the run stays stopped');
      assert.equal(accepted.err.code, 'publication-risk-accepted');
      assert.ok(accepted.said.includes(`accepted the risk of dispatch ${token} (${riskKey(token)})`), accepted.said);
      assert.deepEqual(accepted.writes, [], 'the accepting run sends nothing');
      assert.equal(storeOf(org, dir).readGroup('form', KEY).committed.publication.state, 'owed');
      const next = await cliRun(org, dir, spec, { publish }, phases);
      assert.doesNotMatch(next.said, /accepted the risk|publication-risk:table:contoso_item/);
      // With --publish the publish phase publishes the spec's tables as well, so that run publishes the table more than once.
      if (publish) assert.ok(next.tablePublishes.length >= 1 && next.tablePublishes.every((t) => t.length === 1 && t[0] === 'contoso_item'), JSON.stringify(next.tablePublishes));
      else assert.deepEqual(next.tablePublishes, [['contoso_item']], 'the next run publishes the table');
      assert.equal(storeOf(org, dir).readGroup('form', KEY).committed.publication.state, 'confirmed');
    });
  });
}

// --- publication-risk: a key is bound to the dispatch it was printed for, and is taken only as a run starts -----------------

const riskGrants = (org, dir) => storeOf(org, dir).snapshot().envelope.publicationRiskAcceptances || [];
const riskPub = (org, dir) => storeOf(org, dir).readGroup('form', KEY).committed.publication;

// A first run whose table publish loses its answer and that the org never applied: the form's publish is unconfirmed under D1.
async function lostDispatch() {
  const org = createFakeBuildOrg({ entities: { ...ENTITIES, contoso_other: { attributes: { contoso_name: 'String', contoso_code: 'String' } } } });
  const dir = newDir();
  const restore = losePublish(org, { applied: false });
  const initial = await cliRun(org, dir, makeSpec());
  restore();
  assert.ok(initial.err, chainText(initial.err));
  const token = riskPub(org, dir).dispatchToken;
  assert.ok(token);
  return { org, dir, token };
}

// Another publisher's authoritative not-started answer for `token`, then its own new dispatch of the same table, lost too.
function replaceDispatch(org, dir, token) {
  const s = storeOf(org, dir);
  s.notePublishOutcome({ token, outcome: 'definite-no-start' });
  const next = require('node:crypto').randomUUID();
  s.markPublishDispatch({ groups: [{ family: 'form', key: KEY }], scope: { type: 'table', table: 'contoso_item' }, token: next });
  s.notePublishOutcome({ token: next, outcome: 'unconfirmed' });
  return next;
}

// One CLI invocation that counts the attempts that entered the engine and may be handed its store.
async function cliCounting(org, dir, spec, extra = {}, store = null) {
  const barrier = createPublicationBarrier();
  const sendObserver = createAttemptSendObserver();
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: org.origin, httpClient: gatedClient(org, barrier, sendObserver) });
  await sdk.initWorkspace();
  const said = [];
  const mark = org.calls.length;
  let err;
  let phasesEntered = 0;
  try {
    await buildModelApp(spec, { apply: true, env: org.origin, workspaceDir: dir, appDir: dir, retryDelayMs: 0, ...extra }, {
      sdk, provisionSdk: sdk, publicationBarrier: barrier, sendObserver, warn: (w) => said.push(String(w)), log: (w) => said.push(String(w)),
      ...(store ? { bindingGroups: { store } } : {}),
      runBuild: (s, o) => { phasesEntered += 1; return runSdkBuild(s, { ...o, phases: ['forms'] }); },
    });
  } catch (e) { err = e; }
  return { err, phasesEntered, said: said.join('\n'), writes: org.calls.slice(mark).filter((c) => c.method !== 'GET') };
}

test('publication risk: the key printed for one dispatch never accepts a later dispatch of the same table, and is reported unused', async () => {
  await withForms(true, async () => {
    const { org, dir, token } = await lostDispatch();
    const shown = await cliRun(org, dir, makeSpec());
    assert.ok(shown.said.includes(`--authorize ${riskKey(token)}`), shown.said);
    const parsed = authorizationKeys(['--authorize', riskKey(token)], makeSpec());
    assert.equal(parsed.error, null);
    const next = replaceDispatch(org, dir, token);
    const text = fs.readFileSync(storeOf(org, dir).file, 'utf8');
    const spec = makeSpec();
    spec.forms = [];
    const result = await cliRun(org, dir, spec, { publicationRisk: parsed.publicationRisk });
    assert.notEqual(result.err && result.err.code, 'publication-risk-accepted', chainText(result.err));
    assert.deepEqual(riskGrants(org, dir), [], 'a decision about the earlier dispatch is not a decision about its successor');
    assert.equal(fs.readFileSync(storeOf(org, dir).file, 'utf8'), text, 'nothing is recorded');
    assert.equal(riskPub(org, dir).dispatchToken, next);
    assert.ok(result.said.includes(`--authorize ${riskKey(token)} was not used`), result.said);
    assert.deepEqual(result.writes, []);
  });
});

test('publication risk: a key given while nothing is blocked is reported unused and accepts no publish this run loses later', async () => {
  await withForms(true, async () => {
    const org = createFakeBuildOrg({ entities: ENTITIES });
    const dir = newDir();
    const restore = losePublish(org, { applied: false });
    const result = await cliRun(org, dir, makeSpec(), { publicationRisk: new Set([riskKey(DISPATCH), 'publication-risk:table:contoso_item']) });
    restore();
    assert.ok(result.err, 'the lost publish stops the run');
    assert.deepEqual(riskGrants(org, dir), [], 'a key supplied before the dispatch existed accepts nothing');
    assert.ok(['dispatching', 'unconfirmed'].includes(riskPub(org, dir).state), riskPub(org, dir).state);
    assert.ok(result.said.includes(`--authorize ${riskKey(DISPATCH)} was not used`), result.said);
    assert.doesNotMatch(result.said, /accepted the risk/);
    // The stop prints the approval of the dispatch it lost, for the next run.
    assert.ok(result.said.includes(`--authorize ${riskKey(riskPub(org, dir).dispatchToken)}`), result.said);
  });
});

test('publication risk: a dispatch replaced between the start snapshot and the acceptance is refused before any write, and the run goes on as before', async () => {
  await withForms(true, async () => {
    const { org, dir, token } = await lostDispatch();
    const store = storeOf(org, dir);
    const accept = store.acceptUncertainPublication;
    let newer;
    store.acceptUncertainPublication = (args) => {
      if (!newer) newer = replaceDispatch(org, dir, token);
      return accept(args);
    };
    const spec = makeSpec();
    spec.forms = [];
    const result = await cliCounting(org, dir, spec, { publicationRisk: new Set([riskKey(token)]) }, store);
    assert.ok(newer);
    assert.deepEqual(riskGrants(org, dir), []);
    assert.equal(riskPub(org, dir).dispatchToken, newer);
    assert.match(result.said, /was not recorded: the store refused it before writing anything/);
    assert.notEqual(result.err && result.err.code, 'publication-risk-record-unconfirmed', chainText(result.err));
  });
});

test('publication risk: an acceptance whose store replacement lost its answer halts before any phase and sends nothing; the next run reads it afresh', async () => {
  await withForms(true, async () => {
    const { org, dir, token } = await lostDispatch();
    let fault = true;
    const atomic = require('../lib/apply-snapshot-store.js');
    const store = openManagedBindings({
      workspaceDir: dir, environment: org.origin, appUniqueName: APP, solutionUniqueName: SOLUTION,
      deps: { writeFileAtomic(file, text) {
        atomic.writeFileAtomic(file, text);
        if (fault && (JSON.parse(text).publicationRiskAcceptances || []).some((x) => x.dispatchToken === token)) {
          fault = false;
          throw Object.assign(new Error('answer lost after the replacement'), { code: 'EIO' });
        }
      } },
    });
    // A second declared form on another table: a run that went on would write it.
    const spec = makeSpec();
    spec.entities.push({ ...structuredClone(spec.entities[0]), schemaName: 'contoso_other' });
    spec.forms.unshift({ ...structuredClone(spec.forms[0]), entity: 'contoso_other', name: 'Other Item' });
    const result = await cliCounting(org, dir, spec, { publicationRisk: new Set([riskKey(token)]) }, store);
    assert.equal(fault, false, 'the replacement was written and its answer lost');
    assert.ok(riskGrants(org, dir).some((x) => x.dispatchToken === token), 'the decision is durable');
    assert.equal(result.err && result.err.code, 'publication-risk-record-unconfirmed', chainText(result.err));
    assert.equal(result.err.stopsServiceWrites, true);
    assert.equal(result.phasesEntered, 0, 'no phase is entered');
    assert.deepEqual(result.writes, [], 'nothing is sent');
    assert.doesNotMatch(String(result.err.message), /stays blocked/);
    assert.match(String(result.err.message), /may or may not be recorded/);
    // The next run, given no key, reads the store afresh: the publish is owed again, and it pays it.
    const next = await cliRun(org, dir, makeSpec());
    assert.equal(next.err, undefined, chainText(next.err));
    assert.deepEqual(next.tablePublishes, [['contoso_item']]);
    assert.equal(riskPub(org, dir).state, 'confirmed');
  });
});

test('publication risk: a completed build reports a typed key that matched no blocked dispatch, and records nothing', async () => {
  await withForms(true, async () => {
    const org = createFakeBuildOrg({ entities: ENTITIES });
    const dir = newDir();
    const result = await cliRun(org, dir, makeSpec(), { publicationRisk: new Set([riskKey(DISPATCH, 'contoso_other')]) });
    assert.equal(result.err, undefined, chainText(result.err));
    assert.deepEqual(riskGrants(org, dir), []);
    assert.ok(result.said.includes(`--authorize ${riskKey(DISPATCH, 'contoso_other')} was not used`), result.said);
  });
});

// A maker added a control for contoso_code to the deployed form (its saved and published layers alike), which the spec does not
// place on it.
function addForeignControl(org, name) {
  const cell = '<row><cell id="{0b0b0b0b-1111-4222-8333-444444444444}" showlabel="true" visible="true"><labels><label description="Code" languagecode="1033" /></labels><control id="contoso_code" classid="{4273EDBD-AC1D-40D3-9FB2-095C621B552D}" datafieldname="contoso_code" disabled="false" /></cell></row>';
  const rows = org.fake.rows('systemforms').filter((row) => row.data.name === name);
  assert.equal(rows.length, 1);
  for (const row of rows) {
    row.data.formxml = row.data.formxml.replace('</row></rows></section>', `</row>${cell}</rows></section>`);
    if (row.publishedData) row.publishedData.formxml = row.data.formxml;
  }
}
const nameOnly = (declared) => makeSpec({ declared, form: { tabs: [{ name: 'general', label: 'General', sections: [{ name: 'main', label: 'Main', fields: ['contoso_name'] }] }] } });

test('a control a maker added to a declared form is not refused as a destructive removal: the build keeps it and goes on', async () => {
  await withForms(true, async () => {
    const org = createFakeBuildOrg({ entities: ENTITIES });
    const dir = newDir();
    const spec = nameOnly(true);
    const first = await cliRun(org, dir, spec);
    assert.equal(first.err, undefined, chainText(first.err));
    assert.equal(first.out && first.out.ok === false, false, JSON.stringify(first.out && first.out.errors));
    addForeignControl(org, 'Declared Item');
    const next = await cliRun(org, dir, spec);
    assert.equal(next.err, undefined, chainText(next.err));
    assert.equal(next.out && next.out.ok === false, false, JSON.stringify(next.out && next.out.errors));
    assert.doesNotMatch(next.said, /destructive/);
    const row = org.fake.rows('systemforms').find((r) => r.data.name === 'Declared Item');
    assert.match(row.data.formxml, /datafieldname="contoso_code"/, 'the foreign control is kept');
  });
});

test('control: the same control on a plain explicit form is still refused before any write, and a run given --authorize is told that it approves none of it', async () => {
  await withForms(true, async () => {
    const org = createFakeBuildOrg({ entities: ENTITIES });
    const dir = newDir();
    const spec = nameOnly(false);
    const first = await cliRun(org, dir, spec);
    assert.equal(first.err, undefined, chainText(first.err));
    addForeignControl(org, 'Declared Item');
    for (const extra of [{}, { authorizedAdoption: new Set([`form:${KEY}`]) }]) {
      const refused = await cliRun(org, dir, spec, extra);
      assert.equal(refused.out && refused.out.ok, false);
      const text = refused.out.errors.join('\n');
      assert.match(text, /refusing 1 destructive operation\(s\) without --allow-destructive/);
      assert.match(text, /form "Declared Item" \(contoso_item\) — removes field\(s\): contoso_code/);
      assert.equal(/the --authorize keys given approve none of them/.test(text), !!extra.authorizedAdoption, text);
      assert.deepEqual(refused.writes, []);
    }
  });
});
// --- the round trip: the typed form approval, verify and the explicit managed download ----------------------------------------

test('--authorize adopt|overwrite:form:<key> is read in any case; an untyped key names the single declared form; an ambiguous or undeclared one is refused', async () => {
  await withForms(true, () => {
    const spec = makeSpec();
    const typed = authorizationKeys(['--authorize', 'adopt:form:Contoso_Item/Main/Declared Item', '--authorize', `overwrite:form:${KEY}`], spec);
    assert.equal(typed.error, null);
    assert.deepEqual([...typed.adopt], [`form:${KEY}`]);
    assert.deepEqual([...typed.overwrite], [`form:${KEY}`]);
    const untyped = authorizationKeys(['--authorize', 'adopt:contoso_item/Main/Declared Item'], spec);
    assert.equal(untyped.error, null);
    assert.deepEqual([...untyped.adopt], [`form:${KEY}`]);
    for (const key of ['adopt:form:contoso_item/main/other form', 'adopt:form:contoso_item', 'adopt:contoso_item/main/other form']) {
      const r = authorizationKeys(['--authorize', key], spec);
      assert.match(String(r.error), /approves an artifact the spec does not declare/, key);
      assert.equal(r.adopt.size + r.overwrite.size, 0, key);
    }
    // A declared view whose `<table>/<name>` spells the form's key: the untyped key could mean either.
    const both = makeSpec();
    both.views = [{ entity: 'contoso_item', name: 'Main/Declared Item', reconcile: 'declared', columns: ['contoso_name'] }];
    const ambiguous = authorizationKeys(['--authorize', 'adopt:contoso_item/Main/Declared Item'], both);
    assert.match(String(ambiguous.error), /could approve more than one declared artifact/);
    assert.ok(ambiguous.error.includes(`adopt:form:${KEY}`) && ambiguous.error.includes('adopt:view:contoso_item/Main/Declared Item'), ambiguous.error);
    assert.equal(ambiguous.adopt.size, 0);
  });
  await withForms(false, () => {
    const off = authorizationKeys(['--authorize', `adopt:form:${KEY}`], makeSpec());
    assert.match(String(off.error), /approves an artifact the spec does not declare/);
    assert.equal(off.adopt.size, 0);
  });
});

// verify's reader as the CLI builds it (verify-model-app.js readerFor): a declared form is read by its bound id on a throwaway SDK
// (isolatedReaderFor), never the build's. The table, column and sitemap reads verify also makes are answered plainly.
async function verifyReader(org) {
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(newDir()), instanceUrl: org.origin, httpClient: org.httpClient });
  await sdk.initWorkspace();
  const cli = readerFor(sdk, APP, { isolatedReader: isolatedReaderFor(org.origin, { httpClient: org.httpClient }) });
  const formReads = [];
  return {
    formReads,
    cli,
    read: {
      findTable: async () => ({ logicalName: 'contoso_item' }),
      findColumns: async () => [{ logicalName: 'contoso_name' }, { logicalName: 'contoso_code' }],
      queryRecords: (table, o) => sdk.queryRecords(table, o),
      sitemapXml: async () => '<SiteMap><Area><Group><SubArea Entity="contoso_item"/></Group></Area></SiteMap>',
      declaredForm: async (id) => { formReads.push(id); return cli.declaredForm(id); },
    },
  };
}
const managedChecks = (r) => r.checks.filter((c) => c.kind === 'managed-form');
const manifestOf = (org, dir) => readVerifyManifest({ workspaceDir: dir, environment: org.origin, appUniqueName: APP, solutionUniqueName: SOLUTION });
const reordered = () => { const s = makeSpec(); s.forms[0].tabs[0].sections[0].fields = ['contoso_code', 'contoso_name']; return s; };

test('verify holds a bound declared form to its declaration by a fresh read of its id, and fails it on a declaration the form does not hold', async () => {
  await withForms(true, async () => {
    const org = createFakeBuildOrg({ entities: ENTITIES });
    const dir = newDir();
    assert.equal((await build(org, dir, makeSpec())).err, undefined);
    const id = storeOf(org, dir).readGroup('form', KEY).committed.root.id;
    const { read, formReads } = await verifyReader(org);
    const pass = await verifySpec(makeSpec(), read, { managedManifest: manifestOf(org, dir) });
    assert.deepEqual(managedChecks(pass).map((c) => [c.name, c.present]), [[`${KEY} (${id})`, true]]);
    assert.deepEqual(formReads, [id], 'read by the bound id');
    assert.deepEqual((pass.unverified || []).filter((u) => u.startsWith('managed:')), []);
    const fail = await verifySpec(reordered(), read, { managedManifest: manifestOf(org, dir) });
    const [check] = managedChecks(fail);
    assert.equal(check.present, false);
    assert.match(check.detail, /form-field-order: the fields of 'main' read contoso_name, contoso_code, not contoso_code, contoso_name/);
    assert.ok(fail.missing.some((m) => m.kind === 'managed-form'), 'a failing bound form fails verify');
    // A child the group proved, now gone from the form, fails it too, even where the declaration still matches.
    const group = manifestOf(org, dir);
    const [locator] = Object.keys(group.groups[0].consumerState.children);
    group.groups[0].consumerState.children[locator].id = '00000000-0000-0000-0000-0000000000aa';
    assert.match(managedChecks(await verifySpec(makeSpec(), read, { managedManifest: group }))[0].detail, /form-managed-child: .* is not on the form/);
  });
});

test('verify lists a bound form whose publication is not confirmed as unverified, and a reader that cannot read by id never passes it', async () => {
  await withForms(true, async () => {
    const org = createFakeBuildOrg({ entities: ENTITIES });
    const dir = newDir();
    const restore = losePublish(org, { applied: false });
    assert.ok((await build(org, dir, makeSpec())).err);
    restore();
    const { read } = await verifyReader(org);
    const r = await verifySpec(makeSpec(), read, { managedManifest: manifestOf(org, dir) });
    assert.ok(r.unverified.some((u) => u.startsWith(`managed:form ${KEY} (its publication is not confirmed`)), JSON.stringify(r.unverified));
    assert.equal(managedChecks(r)[0].present, true, 'the saved form is still checked');
    const { declaredForm, ...plain } = read;
    void declaredForm;
    const blind = await verifySpec(makeSpec(), plain, { managedManifest: manifestOf(org, dir) });
    assert.deepEqual(managedChecks(blind), []);
    assert.ok(blind.unverified.includes(`managed:form ${KEY} (this reader cannot read a form by id)`), JSON.stringify(blind.unverified));
  });
});

// The default-form and Main Form Set checks a table's forms carry, by kind: what verify expects of the forms the build orders.
const ORDER_KINDS = new Set(['form-default', 'form-default-unique', 'form-order', 'form-order-served']);
const orderChecks = (r) => r.checks.filter((c) => ORDER_KINDS.has(c.kind)).map((c) => [c.kind, c.name, c.present]);
// A table the spec owns (not `existing`, named with the publisher prefix): there the build's implicit first-Main-form default applies.
const ownTableSpec = (opts) => { const s = makeSpec(opts); s.entities[0].existing = false; return s; };
const plainItem = () => ({ entity: 'contoso_item', name: 'Plain Item', formType: 'Main', tabs: [{ name: 'general', label: 'General', sections: [{ name: 'main', label: 'Main', fields: ['contoso_name'] }] }] });

test('verify expects no default flag or form order of a declared form, as the build sets neither on it', async () => {
  await withForms(true, async () => {
    const org = createFakeBuildOrg({ entities: ENTITIES });
    const dir = newDir();
    const spec = ownTableSpec();
    assert.equal((await build(org, dir, spec)).err, undefined);
    const { read, cli } = await verifyReader(org);
    const r = await verifySpec(spec, { ...read, formRow: (e, id) => cli.formRow(e, id) }, { managedManifest: manifestOf(org, dir) });
    assert.deepEqual(orderChecks(r), [], 'a declared form carries no default-form or form-order expectation');
    assert.deepEqual(r.missing.filter((m) => /^form/.test(m.kind)), [], JSON.stringify(r.missing));
    assert.equal(managedChecks(r)[0].present, true);
  });
});

test('verify still holds a plain Main form beside a declared one to the default and the order the build gave it', async () => {
  await withForms(true, async () => {
    const org = createFakeBuildOrg({ entities: ENTITIES });
    const dir = newDir();
    const spec = ownTableSpec();
    spec.forms.push(plainItem());
    assert.equal((await build(org, dir, spec)).err, undefined);
    const { read, cli } = await verifyReader(org);
    const r = await verifySpec(spec, { ...read, formRow: (e, id) => cli.formRow(e, id) }, { managedManifest: manifestOf(org, dir) });
    assert.deepEqual(orderChecks(r), [
      ['form-default', 'contoso_item.Plain Item', true],
      ['form-order', 'contoso_item: Plain Item', true],
    ]);
  });
  // With the feature off the same form is plain, and is the table's implicit default as it always was.
  await withForms(false, async () => {
    const org = createFakeBuildOrg({ entities: ENTITIES });
    const dir = newDir();
    const spec = ownTableSpec({ declared: false });
    assert.equal((await build(org, dir, spec)).err, undefined);
    const { read, cli } = await verifyReader(org);
    const r = await verifySpec(spec, { ...read, formRow: (e, id) => cli.formRow(e, id) }, {});
    assert.deepEqual(orderChecks(r), [
      ['form-default', 'contoso_item.Declared Item', true],
      ['form-order', 'contoso_item: Declared Item', true],
    ]);
  });
});

// download-model-app.js main with its side effects replaced: the download's SDK is a real one over the fake org (it answers the app's
// unique name itself), and runDownload answers the spec a download of this app would hydrate (forms[] empty, as every download) and the
// publisher it read (`publisher`: this app's own, verified, unless a test says otherwise).
async function download(org, out, argv, extra = {}, publisher = { prefix: 'contoso', resolved: true }) {
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(newDir()), instanceUrl: org.origin, httpClient: org.httpClient });
  await sdk.initWorkspace();
  const dl = Object.create(sdk);
  dl.queryRecords = async (table, o) => (table === 'appmodule' ? [{ uniquename: APP }] : sdk.queryRecords(table, o));
  const downloaded = makeSpec({ declared: false });
  downloaded.forms = [];
  const emitted = [];
  const said = [];
  let exited = null;
  const mark = org.calls.length;
  await downloadMain({
    argv: ['--env', org.origin, '--app', '00000000-0000-0000-0000-00000000a221', '--out', out, ...argv],
    stderr: { write: (text) => { said.push(String(text)); return true; } },
    exit: (code) => { exited = code; },
    emitResult: (ok, payload) => emitted.push({ ok, payload }),
    preflightAuth: async () => ({ ok: true }),
    makeDownloadSdk: async () => ({ sdk: dl, cleanup() {} }),
    makeGenpageSdk: () => ({}),
    runDownload: async () => ({ ok: true, spec: downloaded, pages: [], entities: ['contoso_item'], webResources: [], droppedSubareas: 0, droppedSubareaDetails: [], publisher }),
    ...extra,
  });
  const specFile = path.join(out, 'app-spec.json');
  return { emitted, said: said.join(''), exited, calls: org.calls.slice(mark), written: fs.existsSync(specFile) ? JSON.parse(fs.readFileSync(specFile, 'utf8')) : null };
}
const storeFileOf = (org, dir) => path.join(dir, storeFileName(environmentFingerprint(org.origin), APP, SOLUTION));

// A declared form with an onload handler, and the script library it calls, built together.
const LIBRARY = 'contoso_/scripts/item.js';
const LIBRARY_SOURCE = 'var Item = { onLoad: function () {} };\n';
function handledSpec() {
  const s = makeSpec({ form: { events: [{ event: 'onload', library: LIBRARY, function: 'Item.onLoad' }] } });
  s.webResources = [{ name: LIBRARY, displayName: 'Item script', type: 'js', content: LIBRARY_SOURCE }];
  return s;
}
// The library's row as the build left it, made the unmanaged row a maker's own build leaves (the fake's create keeps no management flag).
function libraryRow(org) {
  const row = [...org.resources.values()].find((r) => r.name === LIBRARY);
  assert.ok(row, 'the build created the library');
  row.ismanaged = false;
  return row;
}
const libraryWrites = (calls) => calls.filter((c) => c.method !== 'GET' && /^\/webresources(?:et)?(?:[?(]|$)/i.test(c.path));

test('the explicit managed download restores a proved form with its handler library, declared external, and a rebuild from it writes no library where it exists', async () => {
  await withForms(true, async () => {
    const org = createFakeBuildOrg({ entities: ENTITIES });
    const dir = newDir();
    const built = handledSpec();
    assert.equal((await build(org, dir, built, { phases: ['web-resources', 'forms'] })).err, undefined);
    const row = libraryRow(org);
    const out = newDir();
    const r = await download(org, out, ['--include-managed', '--managed-manifest', storeFileOf(org, dir)]);
    assert.equal(r.emitted[0].ok, true, JSON.stringify(r.emitted) + r.said);
    assert.deepEqual(r.emitted[0].payload.managedForms, { restored: [KEY], stale: [], libraries: [{ name: LIBRARY, forms: [KEY] }] });
    assert.equal('managedFragments' in r.emitted[0].payload, false);
    assert.deepEqual((fs.existsSync(path.join(out, '.maker-workspace')) ? fs.readdirSync(path.join(out, '.maker-workspace')) : []).filter((n) => n.startsWith('managed-fragments')), []);
    assert.deepEqual(r.written.forms, built.forms, 'the declaration it was built from');
    assert.deepEqual(r.written.webResources, [{ name: LIBRARY, displayName: 'Item script', type: 'js', contentBase64: row.publishedContent, external: true }]);
    assert.equal(Buffer.from(row.publishedContent, 'base64').toString('utf8'), LIBRARY_SOURCE);
    assert.match(r.said, new RegExp(`NOTE: handler library '${LIBRARY}' of managed form ${KEY} was downloaded into webResources\\[\\] as external`));
    assert.deepEqual(libraryWrites(r.calls), [], 'the download writes nothing');
    assert.equal(r.calls.filter((c) => /^\/webresources(?:et)?\?/i.test(c.path)).length, 1, 'the library is read once');
    // The spec as written rebuilds where it was downloaded from: the library is reused as it is (external: its content is neither written
    // nor compared) and the form binds it.
    const again = await build(org, dir, r.written, { phases: ['web-resources', 'forms'] });
    assert.equal(again.err, undefined, chainText(again.err));
    assert.deepEqual(libraryWrites(again.calls), []);
    // Where it is missing, a build creates it from the downloaded content.
    const fresh = createFakeBuildOrg({ entities: ENTITIES });
    assert.equal((await build(fresh, newDir(), { ...r.written, forms: [] }, { phases: ['web-resources'] })).err, undefined);
    const made = [...fresh.resources.values()].find((x) => x.name === LIBRARY);
    assert.equal(made && made.content, row.publishedContent);
  });
});

test('the explicit managed download refuses a handler library it cannot prove is this publisher\'s own unmanaged script, and writes that form ready to paste', async () => {
  await withForms(true, async () => {
    const org = createFakeBuildOrg({ entities: ENTITIES });
    const dir = newDir();
    const built = handledSpec();
    assert.equal((await build(org, dir, built, { phases: ['web-resources', 'forms'] })).err, undefined);
    const row = libraryRow(org);
    const kept = { ...row };
    const flags = ['--include-managed', '--managed-manifest', storeFileOf(org, dir)];
    const byName = (c) => c.method === 'GET' && /^\/webresources(?:et)?\?/i.test(c.path);
    const cases = [
      ['managed', () => { row.ismanaged = true; }, /it is managed$/],
      ['management unknown', () => { delete row.ismanaged; }, /whether it is managed is not known$/],
      ['not a script', () => { row.webresourcetype = 1; }, /it is not a script$/],
      ['no content', () => { row.publishedContent = ''; }, /it has no content$/],
      ['another prefix', () => ({ prefix: 'fabrikam', resolved: true }), /its name does not carry this publisher's prefix 'fabrikam_'$/],
      ['unverified prefix', () => ({ prefix: 'contoso', resolved: false }), /publisher prefix was not verified/],
      ['no publisher', () => null, /publisher prefix was not verified/],
      ['not found', () => org.intercept(byName, () => ({ status: 200, headers: {}, body: { value: [] } })), /it was not found$/],
      ['two rows', () => org.intercept(byName, () => ({ status: 200, headers: {}, body: { value: [{ ...kept, content: kept.publishedContent }, { ...kept, content: kept.publishedContent }] } })), /more than one web resource answers its name$/],
      // One matching row on a page the server says continues is not one row: the lookup reads `top: 2`, so a next link means
      // more rows answer the name than were read.
      ['cut short', () => org.intercept(byName, () => ({ status: 200, headers: {}, body: { value: [{ ...kept, content: kept.publishedContent }], '@odata.nextLink': `${org.origin}/api/data/v9.2/webresourceset?page=2` } })), /its lookup was cut short, so it is not known to be the only web resource of its name$/],
      ['read refused', () => org.intercept(byName, () => ({ status: 403, headers: {}, body: { error: { code: '0x80040220', message: 'no read privilege' } } })), /it could not be read \(.*\)$/],
    ];
    for (const [label, arrange, why] of cases) {
      Object.keys(row).forEach((k) => delete row[k]);
      Object.assign(row, kept);
      const arranged = arrange();
      const publisher = arranged === null ? null : arranged && arranged.prefix ? arranged : { prefix: 'contoso', resolved: true };
      const out = newDir();
      const r = await download(org, out, flags, {}, publisher);
      if (typeof arranged === 'function') arranged();
      assert.equal(r.emitted[0].ok, true, label);
      const { managedForms } = r.emitted[0].payload;
      assert.deepEqual(managedForms.restored, [], label);
      assert.equal('libraries' in managedForms, false, label);
      assert.match(managedForms.stale[0].reason, new RegExp(`^its onload handler library '${LIBRARY}' was not downloaded: `), label);
      assert.match(managedForms.stale[0].reason, why, label);
      assert.deepEqual(r.written.forms, [], label);
      assert.equal(r.written.webResources, undefined, label);
      const { file } = r.emitted[0].payload.managedFragments;
      assert.equal(path.dirname(file), path.join(out, '.maker-workspace'), label);
      assert.match(path.basename(file), /^managed-fragments-\d{8}T\d{6}Z-[0-9a-f]{6}\.json$/, label);
      assert.deepEqual(r.emitted[0].payload.managedFragments, { file, keys: [{ family: 'form', key: KEY }] }, label);
      const fragments = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.deepEqual(fragments.items, [{ family: 'form', key: KEY, reason: managedForms.stale[0].reason, needs: [{ webResource: LIBRARY }], paste: { forms: built.forms } }], label);
      // Pasted with the library it needs, the downloaded spec validates.
      const pasted = { ...r.written, webResources: [built.webResources[0]], forms: fragments.items[0].paste.forms };
      assert.equal(validateAppSpec(pasted, { profile: 'plan', reconstructed: true }).ok, true, label);
    }
    Object.keys(row).forEach((k) => delete row[k]);
    Object.assign(row, kept);
    // A form left out for anything else gets no fragment: nothing proved it.
    const refusing = await download(org, newDir(), flags, {
      validateAppSpec: (s, o) => ((s.forms || []).length ? { ok: false, errors: ['forms: not in this download'], warnings: [] } : validateAppSpec(s, o)),
    });
    assert.equal(refusing.emitted[0].ok, true);
    assert.match(refusing.emitted[0].payload.managedForms.stale[0].reason, /does not validate in the downloaded spec/);
    assert.equal('managedFragments' in refusing.emitted[0].payload, false);
    assert.equal(refusing.written.webResources, undefined, 'a library is committed only with its form');
  });
});

// A download that cannot replace app-spec.json must say so before it writes anything else. With no generative pages there is no page
// tree to check, so the managed download's pending fragments file is the first thing it could write; it is written only once the spec is known to be replaceable.
test('a managed download with no generative pages refuses a spec it cannot replace before it writes its fragments file, and a plain one writes nothing before its spec', async () => {
  await withForms(true, async () => {
    const org = createFakeBuildOrg({ entities: ENTITIES });
    const dir = newDir();
    assert.equal((await build(org, dir, handledSpec(), { phases: ['web-resources', 'forms'] })).err, undefined);
    // A managed library leaves its form ready to paste: a pending fragment, so the managed download has a fragments file to write.
    libraryRow(org).ismanaged = true;
    const flags = ['--include-managed', '--managed-manifest', storeFileOf(org, dir)];
    const tree = (root) => fs.readdirSync(root, { recursive: true }).sort().map((n) => {
      const file = path.join(root, n);
      return fs.lstatSync(file).isDirectory() ? `${n}/` : `${n}=${fs.readFileSync(file, 'utf8')}`;
    });
    // Another name for the maker's spec: replacing it would break that link, which the download refuses.
    const linked = () => {
      const out = newDir();
      fs.writeFileSync(path.join(out, 'app-spec.json'), '{"maker":true}');
      fs.linkSync(path.join(out, 'app-spec.json'), path.join(newDir(), 'spec-twin.json'));
      return out;
    };

    const managedOut = linked();
    const before = tree(managedOut);
    await assert.rejects(download(org, managedOut, flags), (e) => {
      assert.deepEqual(tree(managedOut), before, 'no fragments file, no baseline, and the maker\'s spec as it was');
      assert.equal(e.code, 'UNSAFE_OUTPUT');
      assert.equal(e.reason, 'hard-link');
      assert.match(e.message, /The download stopped before replacing anything:/);
      return true;
    });

    const plainOut = linked();
    const plainBefore = tree(plainOut);
    await assert.rejects(download(org, plainOut, []), (e) => e.code === 'UNSAFE_OUTPUT' && e.reason === 'hard-link' && !/The download stopped before replacing anything/.test(e.message));
    assert.deepEqual(tree(plainOut), plainBefore, 'the plain download\'s spec write is its first write');

    // The same download over a spec it can replace still writes the fragments file and the spec.
    const writable = newDir();
    fs.writeFileSync(path.join(writable, 'app-spec.json'), '{"maker":true}');
    const ok = await download(org, writable, flags);
    assert.equal(ok.emitted[0].ok, true, JSON.stringify(ok.emitted) + ok.said);
    assert.ok(fs.existsSync(ok.emitted[0].payload.managedFragments.file));
    assert.deepEqual(ok.written.forms, [], 'the form is left to its fragment');
  });
});

test('the explicit managed download restores a proved declared form from the named binding store, and names any it cannot restore', async () => {
  await withForms(true, async () => {
    const org = createFakeBuildOrg({ entities: ENTITIES });
    const dir = newDir();
    assert.equal((await build(org, dir, makeSpec())).err, undefined);
    const id = storeOf(org, dir).readGroup('form', KEY).committed.root.id;
    const flags = ['--include-managed', '--managed-manifest', storeFileOf(org, dir)];
    const restored = await download(org, newDir(), flags);
    assert.equal(restored.emitted.length, 1);
    assert.equal(restored.emitted[0].ok, true, JSON.stringify(restored.emitted));
    assert.deepEqual(restored.emitted[0].payload.managedForms, { restored: [KEY], stale: [] });
    assert.deepEqual(restored.written.forms, makeSpec().forms, 'the declaration it was built from, as written');
    // A form that cannot be read is named, left out, and the rest of the download is written.
    const gone = org.intercept((c) => c.method === 'GET' && c.path.toLowerCase().startsWith(`/systemforms(${id})`), () => ({ status: 404, headers: {}, body: { error: { code: '0x80040217', message: 'systemform does not exist' } } }));
    const unread = await download(org, newDir(), flags);
    gone();
    assert.equal(unread.emitted[0].ok, true);
    assert.deepEqual(unread.emitted[0].payload.managedForms.restored, []);
    assert.match(unread.emitted[0].payload.managedForms.stale[0].reason, new RegExp(`form ${id} could not be read`));
    assert.match(unread.said, new RegExp(`WARNING: managed form ${KEY} was not restored: form ${id} could not be read`));
    assert.deepEqual(unread.written.forms, []);
    // One whose declaration the downloaded spec cannot hold is named and left out; the spec is still written.
    const refusing = await download(org, newDir(), flags, {
      validateAppSpec: (s, o) => ((s.forms || []).length ? { ok: false, errors: ['forms: not in this download'], warnings: [] } : validateAppSpec(s, o)),
    });
    assert.equal(refusing.emitted[0].ok, true);
    assert.match(refusing.emitted[0].payload.managedForms.stale[0].reason, /does not validate in the downloaded spec \(forms: not in this download\)/);
    assert.deepEqual(refusing.written.forms, []);
  });
});

test('the explicit managed download refuses a store file that is not this app\'s, or one flag without the other; without them it reads no form', async () => {
  await withForms(true, async () => {
    const org = createFakeBuildOrg({ entities: ENTITIES });
    const dir = newDir();
    assert.equal((await build(org, dir, makeSpec())).err, undefined);
    const copy = path.join(newDir(), 'managed-manifest.json');
    fs.copyFileSync(storeFileOf(org, dir), copy);
    const out = newDir();
    const wrong = await download(org, out, ['--include-managed', '--managed-manifest', copy]);
    assert.equal(wrong.emitted[0].ok, false);
    assert.equal(wrong.emitted[0].payload.code, 'managed-manifest-unusable');
    assert.match(wrong.emitted[0].payload.error, /is not the managed binding store of app contoso_declaredforms .*Nothing was written/);
    assert.equal(wrong.written, null, 'nothing is written');
    for (const argv of [['--include-managed'], ['--managed-manifest', storeFileOf(org, dir)]]) {
      const usage = await download(org, newDir(), argv);
      assert.equal(usage.exited, 1, argv.join(' '));
      assert.deepEqual(usage.emitted, []);
    }
    const plain = await download(org, newDir(), []);
    assert.equal(plain.emitted[0].ok, true);
    assert.equal('managedForms' in plain.emitted[0].payload, false);
    assert.deepEqual(plain.calls.filter((c) => /^\/systemforms/i.test(c.path)), [], 'no form is read');
    assert.deepEqual(plain.written.forms, []);
  });
});

test('the enabled feature through the CLI: the printed typed approval binds the form, verify passes then fails a changed declaration, and the managed download restores it', async () => {
  await withForms(true, async () => {
    const org = createFakeBuildOrg({ entities: ENTITIES });
    assert.equal((await build(org, newDir(), makeSpec())).err, undefined, 'another workspace made the form');
    const appDir = newDir();
    const dir = path.join(appDir, '.maker-workspace');
    fs.mkdirSync(dir);
    const changed = reordered();
    const { read } = await verifyReader(org);
    const cli = async (spec, extra = {}) => {
      const barrier = createPublicationBarrier();
      const sendObserver = createAttemptSendObserver();
      const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: org.origin, httpClient: gatedClient(org, barrier, sendObserver) });
      await sdk.initWorkspace();
      let verified = null;
      let err;
      try {
        await buildModelApp(spec, { apply: true, env: org.origin, workspaceDir: dir, appDir, retryDelayMs: 0, ...extra }, {
          sdk, provisionSdk: sdk, runBuild: (s, o) => runSdkBuild(s, { ...o, phases: ['forms'] }), publicationBarrier: barrier, sendObserver, warn: () => {}, log: () => {},
          verify: async (s, o) => { verified = await verifySpec(s, read, o); return verified; },
        });
      } catch (e) { err = e; }
      return { err, verified };
    };
    const halted = await cli(changed);
    assert.ok(halted.err, 'the unbound form is not taken over');
    const printed = /--authorize "([^"]+)"/.exec(halted.err.message);
    assert.ok(printed, halted.err.message);
    assert.equal(printed[1], `adopt:form:${KEY}`);
    const keys = authorizationKeys(['--authorize', printed[1]], changed);
    assert.equal(keys.error, null);
    const bound = await cli(changed, { authorizedAdoption: keys.adopt, verify: true });
    assert.equal(bound.err, undefined, chainText(bound.err));
    assert.equal(rootOrigin(storeOf(org, dir).readGroup('form', KEY).committed), 'adopted');
    assert.deepEqual(managedChecks(bound.verified).map((c) => c.present), [true], 'the inline verify reads the bound form');
    const standalone = await verifySpec(makeSpec(), read, { managedManifest: manifestOf(org, dir) });
    assert.equal(managedChecks(standalone)[0].present, false, 'the form no longer holds the original declaration');
    const downloaded = await download(org, newDir(), ['--include-managed', '--managed-manifest', storeFileOf(org, dir)]);
    assert.deepEqual(downloaded.emitted[0].payload.managedForms, { restored: [KEY], stale: [] });
    assert.deepEqual(downloaded.written.forms, changed.forms);
  });
});

// --- the wiring's edges: hosts resolved the way the build resolves them, earlier publications, the kept declaration ---------

// A self-related table: a lookup to its own parent, so a form of it can host a quick view and a sub-grid of the same table.
const LINKED = { contoso_item: { attributes: { contoso_name: 'String', contoso_code: 'String', contoso_parent: 'Lookup' } } };
function linkedSpec() {
  const s = makeSpec();
  s.relationships = [{ type: 'OneToMany', schemaName: 'contoso_item_parent', referenced: 'contoso_item', referencing: 'contoso_item', lookup: { schemaName: 'contoso_parent', displayName: 'Parent' } }];
  return s;
}
const formXmlOf = async (org, id) => String((await org.fake.httpClient.get(`${org.origin}/api/data/v9.2/systemforms(${id})?$select=formxml`)).body.formxml || '');

test('a declared Main embeds a QuickView built in the same run, legacy or declared: both forms are made and the table is published once', async () => {
  await withForms(true, async () => {
    for (const declaredTarget of [false, true]) {
      const s = linkedSpec();
      s.forms[0].quickViews = [{ lookup: 'contoso_parent', targetEntity: 'contoso_item', form: 'Item QV' }];
      const qv = { ...makeSpec().forms[0], name: 'Item QV', formType: 'QuickView' };
      if (!declaredTarget) delete qv.reconcile;
      s.forms.push(qv);
      assert.equal(validateAppSpec(s, { profile: 'deploy' }).ok, true, 'the mixed spec is valid');
      const org = createFakeBuildOrg({ entities: LINKED });
      const dir = newDir();
      const r = await build(org, dir, s);
      assert.equal(r.err, undefined, `${declaredTarget ? 'declared' : 'legacy'} target: ${chainText(r.err)}`);
      assert.equal(formPosts(r).length, 2);
      assert.deepEqual(r.tablePublishes, [['contoso_item']], 'one publish, after both forms');
      const qvId = r.out.created.formIds['contoso_item|QuickView|Item QV'];
      assert.match(String(qvId), /^[0-9a-f-]{36}$/i);
      const mainId = storeOf(org, dir).readGroup('form', KEY).committed.root.id;
      assert.ok((await formXmlOf(org, mainId)).toLowerCase().includes(qvId.toLowerCase()), 'the declared host shows the QuickView built this run');
    }
  });
});

test('verify resolves a sub-grid\'s view the way the build does: a changed view name fails, an unknown or ambiguous one is never matched by any view', async () => {
  await withForms(true, async () => {
    const s = linkedSpec();
    s.views = [{ entity: 'contoso_item', name: 'First View', columns: ['contoso_name'] }, { entity: 'contoso_item', name: 'Second View', columns: ['contoso_name', 'contoso_code'] }];
    s.forms[0].subgrids = [{ childEntity: 'contoso_item', view: 'First View', label: 'Children' }];
    const org = createFakeBuildOrg({ entities: LINKED });
    const dir = newDir();
    const built = await build(org, dir, s, { phases: ['views', 'forms'] });
    assert.equal(built.err, undefined, chainText(built.err));
    const { read } = await verifyReader(org);
    const run = (spec) => verifySpec(spec, read, { phases: ['forms'], managedManifest: manifestOf(org, dir) });
    const managedUnverified = (r) => (r.unverified || []).filter((u) => u.startsWith('managed:'));
    const same = await run(s);
    assert.deepEqual(managedChecks(same).map((c) => c.present), [true], JSON.stringify(managedChecks(same)));
    assert.deepEqual(managedUnverified(same), []);
    // The spec now names the other view: the form still shows the first, so it is not what the spec declares.
    const renamed = structuredClone(s);
    renamed.forms[0].subgrids[0].view = 'Second View';
    const [changed] = managedChecks(await run(renamed));
    assert.equal(changed.present, false, 'a different declared view is not the stored target');
    assert.match(changed.detail, /form-host: the form does not show subgrid contoso_item_parent contoso_item [0-9a-f-]{36}/);
    // A view the spec declares and the environment does not hold: the grid the build would embed cannot exist.
    const ghost = structuredClone(s);
    ghost.views.push({ entity: 'contoso_item', name: 'Ghost View', columns: ['contoso_name'] });
    ghost.forms[0].subgrids[0].view = 'Ghost View';
    const [missing] = managedChecks(await run(ghost));
    assert.equal(missing.present, false);
    assert.match(missing.detail, /the view 'Ghost View' of 'contoso_item' that the sub-grid shows is not in the environment/);
    // Two views answer the name, or the read fails: the host is listed unverified and left out, never matched to any view.
    for (const [why, answer, words] of [
      ['ambiguous', () => ({ status: 200, headers: {}, body: { value: [{ savedqueryid: '00000000-0000-0000-0000-0000000000b1' }, { savedqueryid: '00000000-0000-0000-0000-0000000000b2' }] } }), /could not be identified: more than one view answers/],
      ['unreadable', () => ({ status: 500, headers: {}, body: { error: { code: '0x80040216', message: 'unexpected' } } }), /could not be read/],
    ]) {
      const restore = org.intercept((c) => c.method === 'GET' && /^\/savedqueries\?/.test(c.path) && decodeURIComponent(c.path).includes("name eq 'First View'"), answer);
      const r = await run(s);
      restore();
      assert.deepEqual(managedChecks(r).map((c) => c.present), [true], why);
      assert.equal(managedUnverified(r).length, 1, `${why}: ${JSON.stringify(r.unverified)}`);
      assert.match(managedUnverified(r)[0], new RegExp(`^managed:form ${KEY} \\(the view 'First View' of 'contoso_item' that the sub-grid shows ${words.source}`), why);
    }
  });
});

test('an earlier publication of a form table is confirmed read-only when its declaration is gone, beside a form still declared on another table', async () => {
  await withForms(true, async () => {
    const entities = { ...ENTITIES, contoso_other: { attributes: { contoso_name: 'String' } } };
    const twoTables = () => {
      const s = makeSpec();
      s.entities.push({ schemaName: 'contoso_other', displayName: 'Other', existing: true, primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' } });
      s.forms.push({ entity: 'contoso_other', name: 'Declared Other', formType: 'Main', reconcile: 'declared', tabs: [{ name: 'general', label: 'General', sections: [{ name: 'main', label: 'Main', fields: ['contoso_name'] }] }] });
      return s;
    };
    for (const kept of [true, false]) {
      const org = createFakeBuildOrg({ entities });
      const dir = newDir();
      const restore = losePublish(org, { applied: true });
      const first = await build(org, dir, twoTables());
      restore();
      assert.ok(first.err, 'the lost answer stops the build');
      assert.equal(storeOf(org, dir).readGroup('form', KEY).committed.publication.state, 'unconfirmed');
      // The next build declares no form on contoso_item: only the other form, or none at all.
      const omitted = twoTables();
      omitted.forms = kept ? omitted.forms.slice(1) : [];
      const next = await build(org, dir, omitted);
      assert.equal(storeOf(org, dir).readGroup('form', KEY).committed.publication.state, 'confirmed', `kept=${kept}: confirmed by its changed published layer`);
      assert.equal(next.tablePublishes.some((t) => t.includes('contoso_item')), false, `kept=${kept}: never sent again`);
      const after = await build(org, dir, omitted);
      assert.equal(after.err, undefined, `kept=${kept}: ${chainText(after.err)}`);
      assert.equal(after.tablePublishes.some((t) => t.includes('contoso_item')), false);
    }
  });
});

test('autoSubgrids is kept in the declaration the form commits and comes back from the managed download, true or false as written', async () => {
  await withForms(true, async () => {
    for (const auto of [true, false]) {
      const s = linkedSpec();
      s.forms[0].autoSubgrids = auto;
      s.views = [{ entity: 'contoso_item', name: 'Children', columns: ['contoso_name'] }];
      assert.equal(validateAppSpec(s, { profile: 'deploy' }).ok, true);
      const org = createFakeBuildOrg({ entities: LINKED });
      const dir = newDir();
      const r = await build(org, dir, s, { phases: ['views', 'forms'] });
      assert.equal(r.err, undefined, chainText(r.err));
      const group = storeOf(org, dir).readGroup('form', KEY).committed;
      const formXml = await formXmlOf(org, group.root.id);
      assert.equal(/contoso_item_parent/i.test(formXml), auto, `auto=${auto}: the generated grid is on the form only when asked`);
      assert.equal('control:subgrid:contoso_item_parent' in group.consumerState.children, auto, `auto=${auto}: the generated grid is a child the group proves`);
      assert.equal(group.originalDeclaration.autoSubgrids, auto, `auto=${auto}: the original declaration`);
      assert.equal(group.consumerState.declaration.autoSubgrids, auto, `auto=${auto}: the declaration the download restores`);
      const downloaded = await download(org, newDir(), ['--include-managed', '--managed-manifest', storeFileOf(org, dir)]);
      assert.deepEqual(downloaded.emitted[0].payload.managedForms, { restored: [KEY], stale: [] });
      assert.equal(downloaded.written.forms[0].autoSubgrids, auto);
    }
  });
});

test('a managed download carries no binding: an identical rebuild elsewhere stays unbound, and its first binding needs adopt:form', async () => {
  await withForms(true, async () => {
    const org = createFakeBuildOrg({ entities: ENTITIES });
    const dir = newDir();
    assert.equal((await build(org, dir, makeSpec())).err, undefined);
    const downloaded = await download(org, newDir(), ['--include-managed', '--managed-manifest', storeFileOf(org, dir)]);
    const fresh = newDir();
    const same = await build(org, fresh, downloaded.written);
    assert.equal(same.err, undefined, chainText(same.err));
    assert.deepEqual(same.writes, []);
    assert.equal(storeOf(org, fresh).readGroup('form', KEY).committed, null, 'an identical no-op binds nothing');
    const changed = structuredClone(downloaded.written);
    changed.forms[0].tabs[0].sections[0].fields.reverse();
    const halted = await build(org, fresh, changed);
    assert.equal(halted.err && halted.err.code, 'form-layout-adoption-not-authorized');
    assert.deepEqual(halted.writes, []);
    assert.equal((await build(org, fresh, changed, { authorizedAdoption: new Set([`form:${KEY}`]) })).err, undefined);
  });
});

test('a build with no binding store halts through the build halt before any form write; one with an unreadable store before any read', async () => {
  await withForms(true, async () => {
    const org = createFakeBuildOrg({ entities: ENTITIES });
    const noStore = await build(org, newDir(), makeSpec(), { bindingGroups: { store: null, debt: [], absent: true } });
    const own = (() => { for (let e = noStore.err; e; e = e.cause) if (Array.isArray(e.findings)) return e; return null; })();
    assert.ok(own, chainText(noStore.err));
    assert.equal(own.name, 'BuildHalt');
    assert.equal(own.code, 'managed-binding-port-unavailable');
    assert.deepEqual(noStore.writes, []);
    const dir = newDir();
    assert.equal((await build(org, dir, makeSpec())).err, undefined);
    fs.writeFileSync(storeFileOf(org, dir), '{ not json');
    const corrupt = await build(org, dir, makeSpec());
    assert.equal(corrupt.err && corrupt.err.code, 'managed-binding-store-unreadable');
    assert.deepEqual(corrupt.calls, [], 'nothing is read or written');
  });
});

test('a bound form whose local copy holds unsent edits stops the build before anything is fetched over it or written', async () => {
  await withForms(true, async () => {
    const org = createFakeBuildOrg({ entities: ENTITIES });
    const dir = newDir();
    assert.equal((await build(org, dir, makeSpec())).err, undefined);
    const id = storeOf(org, dir).readGroup('form', KEY).committed.root.id;
    const local = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: org.origin, httpClient: org.httpClient });
    await local.initWorkspace();
    await local.fetchArtifact('form', id, { overwrite: true });
    await local.updateElement('form', id, '/tabs/0/label', 'UNSENT MAKER CAPTION');
    for (const n of [1, 2]) {
      const r = await build(org, dir, reordered());
      assert.equal(r.err && r.err.code, 'create-completion-required', `run ${n}: ${chainText(r.err)}`);
      assert.match(chainText(r.err), /the local copy of the form .* differs from the server's/);
      assert.deepEqual(r.writes, [], `run ${n}: nothing written`);
      assert.deepEqual(r.tablePublishes, []);
      const copy = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: org.origin, httpClient: org.httpClient });
      await copy.initWorkspace();
      assert.equal((await copy.getArtifact('form', id)).tabs[0].label, 'UNSENT MAKER CAPTION', `run ${n}: the copy is kept`);
    }
  });
});

test('a form create whose answer is lost is never sent again: the next build binds it only under adopt:form, then publishes once', async () => {
  await withForms(true, async () => {
    const org = createFakeBuildOrg({ entities: ENTITIES });
    const dir = newDir();
    let n = 0;
    const restore = org.intercept((c) => c.method === 'POST' && /^\/systemforms(?:\?|$)/.test(c.path) && n++ === 0, async (c) => {
      await org.fake.httpClient.post(`${org.origin}/api/data/v9.2${c.path}`, c.body);
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    });
    const lost = await build(org, dir, makeSpec());
    restore();
    assert.ok(lost.err, 'the lost answer stops the build');
    assert.equal(storeOf(org, dir).readGroup('form', KEY).committed, null);
    const unapproved = await build(org, dir, makeSpec());
    assert.equal(unapproved.err && unapproved.err.code, 'managed-adoption-required', chainText(unapproved.err));
    assert.ok(chainText(unapproved.err).includes(`adopt:form:${KEY}`), chainText(unapproved.err));
    assert.deepEqual(unapproved.writes, []);
    const approved = await build(org, dir, makeSpec(), { authorizedAdoption: new Set([`form:${KEY}`]) });
    assert.equal(approved.err, undefined, chainText(approved.err));
    assert.deepEqual(formPosts(approved), [], 'no second form');
    assert.deepEqual(approved.tablePublishes, [['contoso_item']]);
    assert.equal(rootOrigin(storeOf(org, dir).readGroup('form', KEY).committed), 'adopted');
    assert.equal(org.calls.filter((c) => c.method === 'POST' && /^\/systemforms(?:\?|$)/.test(c.path)).length, 1, 'one create in all');
  });
});

test('a declared form too large for one attempt\'s reservation is refused through the build halt before anything is prepared or sent', async () => {
  await withForms(true, async () => {
    const attributes = { contoso_name: 'String' };
    const sections = [];
    for (let s = 0; s < 64; s += 1) {
      const fields = Array.from({ length: 64 }, (_, f) => `contoso_f${String(s).padStart(2, '0')}_${String(f).padStart(2, '0')}`);
      for (const f of fields) attributes[f] = 'String';
      sections.push({ name: `sec_${s}`, label: `Section ${s}`, columns: 2, fields });
    }
    const spec = makeSpec({ form: { tabs: [{ name: 'general', label: 'General', sections }] } });
    const org = createFakeBuildOrg({ entities: { contoso_item: { attributes } } });
    const dir = newDir();
    const r = await build(org, dir, spec);
    assert.equal(r.err && r.err.code, 'managed-binding-store-full', chainText(r.err));
    assert.match(chainText(r.err), /nothing was sent/);
    assert.deepEqual(r.writes, []);
    assert.deepEqual(storeOf(org, dir).readGroup('form', KEY), { committed: null, pending: null, effects: [] }, 'nothing prepared');
  });
});

// --- a removed declaration whose form a maker deleted ---------------------------------------------------------------------

// A maker deleted the form `id`: each request by its id answers the missing-row 404 (0x80040217), and every systemforms
// collection read leaves it out. `saved`/`published` answer one layer otherwise ('present' passes it through, a function
// answers or throws) to show what is NOT absence.
const missingRow = (id) => ({ status: 404, headers: {}, body: { error: { code: '0x80040217', message: `systemform With Id = ${id} Does Not Exist` } } });
const passThrough = (org, r) => org.fake.httpClient.get(`${org.origin}/api/data/v9.2${r.path}`);
function deleteForm(org, rawId, { saved = missingRow, published = missingRow } = {}) {
  const id = String(rawId).toLowerCase();
  const byId = (r) => r.path.toLowerCase().startsWith(`/systemforms(${id})`);
  const presenceReads = [];
  const restore = org.intercept((r) => byId(r) || (r.method === 'GET' && /^\/systemforms(\/Microsoft\.Dynamics\.CRM\.RetrieveUnpublishedMultiple\(\))?\?/.test(r.path)), async (r) => {
    if (byId(r)) {
      const layer = /\/Microsoft\.Dynamics\.CRM\.RetrieveUnpublished\(\)/.test(r.path) ? saved : published;
      presenceReads.push(r.path);
      return r.method === 'GET' && layer === 'present' ? passThrough(org, r) : (typeof layer === 'function' ? layer(id) : missingRow(id));
    }
    const res = await passThrough(org, r);
    return res.body && Array.isArray(res.body.value) ? { ...res, body: { ...res.body, value: res.body.value.filter((row) => String(row.formid || '').toLowerCase() !== id) } } : res;
  });
  return { restore, presenceReads };
}
const removedForm = () => { const s = makeSpec(); s.forms = []; return s; };
const retiredOf = (org, dir) => storeOf(org, dir).snapshot().envelope.retiredGroups || [];
const retiredNotices = (warns) => warns.filter((w) => /managed-root-retired/.test(w));
const buildWarned = async (org, dir, spec, opts = {}) => { const warns = []; const r = await build(org, dir, spec, { ...opts, warn: (m) => warns.push(m) }); return { ...r, warns }; };

// A committed form owing its table's publish, definitely not sent: a changed declaration commits, then the read of its
// layers before the publish fails, so nothing is sent and the debt stays owed with no dispatch token.
async function owedForm(org, dir) {
  assert.equal((await build(org, dir, makeSpec())).err, undefined);
  const { root, generation } = storeOf(org, dir).readGroup('form', KEY).committed;
  const recommitted = () => { const c = storeOf(org, dir).readGroup('form', KEY).committed; return !!c && c.generation !== generation; };
  const restore = org.intercept((r) => r.method === 'GET' && r.path === `/systemforms(${root.id})?$select=formid,name,description,formxml` && recommitted(),
    async () => ({ status: 503, headers: {}, body: { error: { code: '0x80040216', message: 'unavailable' } } }));
  const second = await build(org, dir, reordered());
  restore();
  assert.equal(second.err && second.err.code, 'managed-publication-unverified', chainText(second.err));
  const pub = storeOf(org, dir).readGroup('form', KEY).committed.publication;
  assert.deepEqual([pub.state, pub.dispatchToken], ['owed', null]);
  return root.id;
}

test('a removed declared form whose form was deleted, owing an unsent publish of its table, is retired once on two-layer proof, and the next build is clean', async () => {
  await withForms(true, async () => {
    const org = createFakeBuildOrg({ entities: ENTITIES });
    const dir = newDir();
    const id = await owedForm(org, dir);
    const { presenceReads } = deleteForm(org, id);
    const first = await buildWarned(org, dir, removedForm());
    assert.equal(first.err, undefined, chainText(first.err));
    assert.deepEqual(first.writes, [], 'nothing written to the environment');
    assert.deepEqual(first.tablePublishes, []);
    assert.equal(retiredNotices(first.warns).length, 1);
    assert.match(retiredNotices(first.warns)[0], new RegExp(`declared form "${KEY}": managed-root-retired .*${id}`));
    assert.deepEqual(presenceReads.slice(0, 2).map((p) => p.replace(GUID, '<id>')), [
      '/systemforms(<id>)/Microsoft.Dynamics.CRM.RetrieveUnpublished()?$select=formid,name,description,formxml',
      '/systemforms(<id>)?$select=formid,name,description,formxml',
    ], 'the saved layer, then the published one, by the bound id');
    assert.deepEqual(storeOf(org, dir).readGroup('form', KEY), { committed: null, pending: null, effects: [] });
    assert.deepEqual(retiredOf(org, dir).map((e) => [e.family, e.key, e.rootId, e.reason, e.publication]), [['form', KEY, id, 'root-absent', 'owed']]);
    const again = await buildWarned(org, dir, removedForm());
    assert.equal(again.err, undefined, chainText(again.err));
    assert.deepEqual([again.writes, again.tablePublishes, retiredNotices(again.warns)], [[], [], []]);
    assert.equal(retiredOf(org, dir).length, 1, 'retired once');
  });
});

test('a removed declared form whose form was deleted fails verify until a build retires it; a legacy form on its table then publishes', async () => {
  await withForms(true, async () => {
    const org = createFakeBuildOrg({ entities: ENTITIES });
    const dir = newDir();
    assert.equal((await build(org, dir, makeSpec())).err, undefined);
    const { root, publication } = storeOf(org, dir).readGroup('form', KEY).committed;
    assert.equal(publication.state, 'confirmed');
    deleteForm(org, root.id);
    const { read } = await verifyReader(org);
    const before = await verifySpec(removedForm(), read, { managedManifest: manifestOf(org, dir) });
    assert.deepEqual(managedChecks(before).map((c) => c.present), [false], 'the bound form is gone');
    const r = await buildWarned(org, dir, removedForm());
    assert.equal(r.err, undefined, chainText(r.err));
    assert.equal(retiredNotices(r.warns).length, 1);
    assert.deepEqual(retiredOf(org, dir).map((e) => [e.key, e.publication]), [[KEY, 'confirmed']]);
    const after = await verifySpec(removedForm(), read, { managedManifest: manifestOf(org, dir) });
    assert.deepEqual(managedChecks(after), []);
    assert.deepEqual((after.unverified || []).filter((u) => u.startsWith('managed:')), []);
    // A legacy form on the same table: its publish no longer covers the deleted form.
    const legacy = removedForm();
    legacy.forms = [{ entity: 'contoso_item', name: 'Legacy Item', formType: 'Main', tabs: [{ name: 'general', label: 'General', sections: [{ name: 'main', label: 'Main', fields: ['contoso_name'] }] }] }];
    for (let n = 0; n < 2; n += 1) {
      const b = await build(org, dir, legacy);
      assert.equal(b.err, undefined, chainText(b.err));
    }
  });
});

test('a removed declared form is kept, and nothing retired, unless both layers answer the missing row: present, 403, timeout or another 404', async () => {
  const timeout = () => { throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }); };
  const forbidden = () => ({ status: 403, headers: {}, body: { error: { code: '0x80040220', message: 'no privilege' } } });
  const otherNotFound = () => ({ status: 404, headers: {}, body: { error: { code: '0x80060888', message: 'Resource not found for the segment' } } });
  const cases = [
    ['the saved layer present', { saved: 'present' }],
    ['the published layer present', { published: 'present' }],
    ['a 403 on the saved read', { saved: forbidden }],
    ['a timeout on the published read', { published: timeout }],
    ['a 404 with another code', { published: otherNotFound }],
  ];
  for (const [name, layers] of cases) {
    await withForms(true, async () => {
      const org = createFakeBuildOrg({ entities: ENTITIES });
      const dir = newDir();
      const id = await owedForm(org, dir);
      const before = storeOf(org, dir).readGroup('form', KEY).committed;
      deleteForm(org, id, layers);
      const r = await buildWarned(org, dir, removedForm());
      assert.deepEqual(retiredNotices(r.warns), [], name);
      assert.deepEqual(retiredOf(org, dir), [], name);
      const kept = storeOf(org, dir).readGroup('form', KEY).committed;
      assert.deepEqual([kept.generation, kept.root.id], [before.generation, before.root.id], `${name}: kept`);
      // A form present in either layer is not gone: the run goes on as it always did. Any other answer proves nothing,
      // so the owed publish still stops on the unreadable layers, nothing sent.
      if (Object.values(layers).includes('present')) return;
      assert.equal(r.err && r.err.code, 'managed-publication-unverified', `${name}: ${chainText(r.err)}`);
      assert.deepEqual([r.writes, r.tablePublishes], [[], []], name);
      assert.deepEqual(kept, before, `${name}: kept as it was`);
    });
  }
});

test('a deleted form is never retired over a publish that may have been sent, while still declared, or with the build path off', async () => {
  // A publish whose answer was lost: it could still land, so the scope stays blocked with its typed approval.
  await withForms(true, async () => {
    const org = createFakeBuildOrg({ entities: ENTITIES });
    const dir = newDir();
    const restore = losePublish(org, { applied: false });
    await build(org, dir, makeSpec());
    restore();
    const { root, publication } = storeOf(org, dir).readGroup('form', KEY).committed;
    assert.equal(publication.state, 'unconfirmed');
    deleteForm(org, root.id);
    for (let n = 0; n < 2; n += 1) {
      const r = await buildWarned(org, dir, removedForm());
      assert.equal(r.err && r.err.code, 'managed-publication-unconfirmed', chainText(r.err));
      assert.deepEqual([r.writes, retiredNotices(r.warns)], [[], []]);
    }
    assert.equal(storeOf(org, dir).readGroup('form', KEY).committed.publication.state, 'unconfirmed');
    assert.deepEqual(retiredOf(org, dir), []);
  });
  // Still declared: its bound form missing is repaired explicitly, never retired by the build.
  await withForms(true, async () => {
    const org = createFakeBuildOrg({ entities: ENTITIES });
    const dir = newDir();
    assert.equal((await build(org, dir, makeSpec())).err, undefined);
    deleteForm(org, storeOf(org, dir).readGroup('form', KEY).committed.root.id);
    const r = await buildWarned(org, dir, makeSpec());
    assert.match(chainText(r.err), /form-layout-bound-row-missing/);
    assert.deepEqual(retiredNotices(r.warns), []);
    assert.deepEqual(retiredOf(org, dir), []);
  });
  // The build path off: nothing is declared, so nothing is read for the group or retired.
  const org = createFakeBuildOrg({ entities: ENTITIES });
  const dir = newDir();
  await withForms(true, async () => { assert.equal((await build(org, dir, makeSpec())).err, undefined); });
  const { presenceReads } = deleteForm(org, storeOf(org, dir).readGroup('form', KEY).committed.root.id);
  await withForms(false, async () => {
    const r = await buildWarned(org, dir, removedForm());
    assert.deepEqual([presenceReads, retiredNotices(r.warns), retiredOf(org, dir)], [[], [], []]);
    assert.notEqual(storeOf(org, dir).readGroup('form', KEY).committed, null);
  });
});

// The retirement is bound to the store as observed BEFORE the two layer reads. Here another run settles the owed publish
// against a live published layer (confirmPublished, no dispatch: owed becomes not-needed) while this build reads the saved
// layer: the same generation and root, and a state that is itself retirable. Only the observation tells the store the
// group moved after the proof's read, so the retirement is refused and nothing is written for it: this invocation keeps the
// form's table fenced and ends incomplete, and the next build observes and reads again.
test('a store change between the observation and the retirement refuses the retirement of a removed deleted form; the next build retires it', async () => {
  await withForms(true, async () => {
    const org = createFakeBuildOrg({ entities: ENTITIES });
    const dir = newDir();
    const id = await owedForm(org, dir);
    const before = storeOf(org, dir).readGroup('form', KEY).committed;
    let raced = 0;
    const saved = (rowId) => {
      if (!raced) {
        raced += 1;
        storeOf(org, dir).confirmPublished({ groups: [{ family: 'form', key: KEY, generation: before.generation }], token: null, proof: { publishedSha256: before.publication.desiredSha256 || 'a'.repeat(64) } });
      }
      return missingRow(rowId);
    };
    const { restore } = deleteForm(org, id, { saved });
    const r = await buildWarned(org, dir, removedForm());
    assert.equal(raced, 1, 'the concurrent change landed between the observation and the retirement');
    assert.deepEqual(retiredNotices(r.warns), []);
    assert.deepEqual(retiredOf(org, dir), [], 'nothing is retired on a proof about an older state');
    assert.ok(r.warns.some((w) => w.includes(`declared form "${KEY}"`) && w.includes('managed-binding-generation-conflict') && w.includes('its retirement could not be confirmed')), r.warns.join('\n'));
    assert.notEqual(r.err, undefined, 'this invocation does not end clean');
    assert.equal(r.barrier.checkAppWrite({ added: ['contoso_item'] }).ok, false, 'and keeps the table fenced in it');
    assert.deepEqual(r.writes, []);
    const kept = storeOf(org, dir).readGroup('form', KEY).committed;
    assert.deepEqual([kept.generation, kept.root.id, kept.publication.state], [before.generation, before.root.id, 'not-needed'], 'the concurrent change is kept');
    restore();
    const { presenceReads } = deleteForm(org, id);
    const next = await buildWarned(org, dir, removedForm());
    assert.equal(next.err, undefined, chainText(next.err));
    assert.equal(presenceReads.length, 2, 'the next build reads both layers again');
    assert.equal(retiredNotices(next.warns).length, 1);
    assert.deepEqual(retiredOf(org, dir).map((e) => [e.key, e.publication]), [[KEY, 'not-needed']]);
  });
});

// A refused retirement leaves this invocation's cached store from before the race. Another invocation that, while this one
// reads the published layer, commits a new owed generation, prepares an attempt, or marks a carried publish dispatching, and a
// form that is there again, must still find the form's table fenced for the rest of this invocation: no app write admits the
// table, a plain publish naming it is not sent, and the run ends incomplete naming the form.
for (const state of ['owed', 'pending', 'dispatching']) {
  test(`a retirement refused because another invocation left the removed form ${state} fences its table for the rest of this invocation`, async () => {
    await withForms(true, async () => {
      const org = createFakeBuildOrg({ entities: ENTITIES });
      const dir = newDir();
      assert.equal((await build(org, dir, makeSpec())).err, undefined);
      const g = storeOf(org, dir).readGroup('form', KEY).committed;
      let raced = 0;
      let restore = () => {};
      const published = (rowId) => {
        if (!raced) {
          raced += 1;
          const other = storeOf(org, dir);
          if (state === 'dispatching') {
            other.markPublishDispatch({ groups: [], carried: [{ family: 'form', key: KEY, generation: g.generation, savedSha256: 'a'.repeat(64), publishedSha256: 'a'.repeat(64) }], scope: g.publication.scope, token: 'concurrent-publish' });
          } else {
            const token = other.prepareAttempt({ family: 'form', key: KEY, baseGeneration: g.generation, root: g.root, knownScopes: [g.publication.scope], declarationSha256: 'a'.repeat(64), declaration: g.originalDeclaration });
            if (state === 'owed') {
              other.markSending(token, { proofVersion: 1, proofSchema: g.proofSchema, rootId: g.root.id, baseProofSha256: null, sentProjectionSha256: 'b'.repeat(64), preservationSha256: 'c'.repeat(64), baseObservation: null, children: [] });
              other.noteSaved(token, { proof: g.proof, acknowledgedRoot: false });
              other.commitGroup({ token, baseGeneration: g.generation, records: g.records, proof: g.proof, consumerState: g.consumerState, publication: { scope: g.publication.scope, state: 'owed', desiredSha256: 'd'.repeat(64), dispatchToken: null } });
            }
          }
          restore();
        }
        return missingRow(rowId);
      };
      ({ restore } = deleteForm(org, g.root.id, { published }));
      const r = await buildWarned(org, dir, removedForm());
      restore();
      assert.equal(raced, 1, 'the concurrent change landed during the published read');
      assert.deepEqual(retiredOf(org, dir), []);
      assert.ok(r.warns.some((w) => w.includes(`declared form "${KEY}"`) && w.includes('managed-binding-generation-conflict') && w.includes('its retirement could not be confirmed') && w.includes('the next build reads it again')), r.warns.join('\n'));
      assert.match(chainText(r.err), new RegExp(`managed form "${KEY}" \\(its retirement could not be confirmed`));
      assert.deepEqual([r.writes, r.tablePublishes], [[], []]);
      assert.equal(r.barrier.checkAppWrite({ added: ['contoso_item'] }).ok, false, 'no app write admits its table');
      const mark = org.calls.length;
      await gatedClient(org, r.barrier).post(`${org.origin}/api/data/v9.2/PublishXml`, { ParameterXml: '<importexportxml><entities><entity>contoso_item</entity></entities></importexportxml>' }).catch(() => {});
      assert.deepEqual(org.tablePublishes(mark), [], 'a plain publish naming its table is not sent');
    });
  });
}

// The same race, with the spec now holding a plain form of the removed one's name, its tab and section labels changed (a
// real edit the plain path would push), and the app written and published. This invocation's cached store is from before
// the race, so nothing in it says the form is held: the unconfirmed retirement ends the invocation before any write, so the
// plain path writes no form and creates no second one (the replacement included), and no app write or publish goes ahead.
for (const state of ['owed', 'pending', 'dispatching', 'replacement']) {
  test(`after a retirement refused because another invocation left the removed form ${state}, a plain form of its name writes and publishes nothing`, async () => {
    await withForms(true, async () => {
      const org = createFakeBuildOrg({ entities: ENTITIES });
      const dir = newDir();
      assert.equal((await build(org, dir, makeSpec())).err, undefined);
      const g = storeOf(org, dir).readGroup('form', KEY).committed;
      const newId = '99999999-9999-4999-8999-999999999999';
      let raced = 0;
      let restore = () => {};
      const published = (rowId) => {
        if (!raced) {
          raced += 1;
          const other = storeOf(org, dir);
          if (state === 'dispatching') {
            other.markPublishDispatch({ groups: [], carried: [{ family: 'form', key: KEY, generation: g.generation, savedSha256: 'a'.repeat(64), publishedSha256: 'a'.repeat(64) }], scope: g.publication.scope, token: 'concurrent-publish' });
          } else if (state === 'replacement') {
            const { observation } = other.observeRetirement({ family: 'form', key: KEY });
            other.retireAbsentGroup({ family: 'form', key: KEY, generation: g.generation, rootId: g.root.id, observation, evidence: { kind: 'root-absent', rootId: g.root.id, saved: 'not-found', published: 'not-found' } });
            other.prepareAttempt({ family: 'form', key: KEY, baseGeneration: null, root: { ...g.root, id: newId }, knownScopes: [g.publication.scope], declarationSha256: 'a'.repeat(64), declaration: g.originalDeclaration });
          } else {
            const token = other.prepareAttempt({ family: 'form', key: KEY, baseGeneration: g.generation, root: g.root, knownScopes: [g.publication.scope], declarationSha256: 'a'.repeat(64), declaration: g.originalDeclaration });
            if (state === 'owed') {
              other.markSending(token, { proofVersion: 1, proofSchema: g.proofSchema, rootId: g.root.id, baseProofSha256: null, sentProjectionSha256: 'b'.repeat(64), preservationSha256: 'c'.repeat(64), baseObservation: null, children: [] });
              other.noteSaved(token, { proof: g.proof, acknowledgedRoot: false });
              other.commitGroup({ token, baseGeneration: g.generation, records: g.records, proof: g.proof, consumerState: g.consumerState, publication: { scope: g.publication.scope, state: 'owed', desiredSha256: 'd'.repeat(64), dispatchToken: null } });
            }
          }
          // The replacement's old form stays deleted; the others' form is there again.
          if (state !== 'replacement') restore();
        }
        return missingRow(rowId);
      };
      ({ restore } = deleteForm(org, g.root.id, { published }));
      const r = await buildWarned(org, dir, makeSpec({ declared: false, form: { tabs: [{ name: 'general', label: 'Changed plain label', sections: [{ name: 'main', label: 'Changed plain section', fields: ['contoso_name', 'contoso_code'] }] }] } }), { phases: ['forms', 'app-shell', 'publish'], publish: true });
      restore();
      assert.equal(raced, 1, 'the concurrent change landed during the published read');
      assert.ok(r.warns.some((w) => w.includes(`declared form "${KEY}"`) && w.includes('its retirement could not be confirmed')), r.warns.join('\n'));
      assert.equal(r.err && r.err.code, 'managed-not-settled', chainText(r.err));
      assert.deepEqual(shape(formWrites(r)), [], 'the plain path writes no form and creates none');
      assert.deepEqual(shape(r.writes.filter((c) => /^\/(appmodules|sitemaps|PublishXml|PublishAllXml|AddAppComponents)/i.test(c.path))), [], 'no app write or publish goes ahead');
      assert.deepEqual(r.tablePublishes, []);
      assert.notEqual(r.err, undefined);
      const now = storeOf(org, dir).readGroup('form', KEY);
      if (state === 'owed') assert.equal(now.committed.publication.state, 'owed', 'the concurrent debt is kept, not paid');
      if (state === 'dispatching') assert.equal(now.committed.publication.state, 'dispatching', 'the concurrent dispatch is kept');
      if (state === 'pending' || state === 'replacement') assert.notEqual(now.pending, null, 'the concurrent attempt is kept');
      assert.equal(r.barrier.checkAppWrite({ added: ['contoso_item'] }).ok, false, 'no app write admits its table');
    });
  });
}

// A plain form that IS a removed declaration whose managed state is not settled, read before the build (no race): an attempt
// another build started on it (the replacement, a fresh create under a new id after the old form was retired, included), a
// publish still owed, or one that may have been sent. The plain path finds a form by its name or formId only, so it would
// PATCH the saved layer that change owes, or create a second form beside one that may still land. It refuses that form,
// coded, before any request for it.
const prepareOn = (org, dir, g, { replacement = false } = {}) => {
  const store = storeOf(org, dir);
  if (replacement) {
    const { observation } = store.observeRetirement({ family: 'form', key: KEY });
    store.retireAbsentGroup({ family: 'form', key: KEY, generation: g.generation, rootId: g.root.id, observation, evidence: { kind: 'root-absent', rootId: g.root.id, saved: 'not-found', published: 'not-found' } });
  }
  return store.prepareAttempt({ family: 'form', key: KEY, baseGeneration: replacement ? null : g.generation, root: replacement ? { ...g.root, id: '99999999-9999-4999-8999-999999999999' } : g.root, knownScopes: [g.publication.scope], declarationSha256: 'a'.repeat(64), declaration: g.originalDeclaration });
};
const changedPlain = (form = {}) => makeSpec({ declared: false, form: { tabs: [{ name: 'general', label: 'Changed plain label', sections: [{ name: 'main', label: 'Changed plain section', fields: ['contoso_name', 'contoso_code'] }] }], ...form } });
const appOrPublish = (r) => shape(r.writes.filter((c) => /^\/(appmodules|sitemaps|PublishXml|PublishAllXml|AddAppComponents)/i.test(c.path)));
for (const state of ['pending', 'replacement', 'owed', 'dispatching', 'pending, pinned by formId']) {
  test(`a plain form that is a removed declared form left ${state} is refused before any write; other plain forms are not held`, async () => {
    await withForms(true, async () => {
      const org = createFakeBuildOrg({ entities: ENTITIES });
      const dir = newDir();
      assert.equal((await build(org, dir, makeSpec())).err, undefined);
      const g = storeOf(org, dir).readGroup('form', KEY).committed;
      let restore = () => {};
      if (state === 'replacement') {
        ({ restore } = deleteForm(org, g.root.id));
        prepareOn(org, dir, g, { replacement: true });
      } else if (state === 'dispatching') {
        storeOf(org, dir).markPublishDispatch({ groups: [], carried: [{ family: 'form', key: KEY, generation: g.generation, savedSha256: 'a'.repeat(64), publishedSha256: 'a'.repeat(64) }], scope: g.publication.scope, token: 'concurrent-publish' });
      } else {
        const token = prepareOn(org, dir, g);
        if (state === 'owed') {
          const other = storeOf(org, dir);
          other.markSending(token, { proofVersion: 1, proofSchema: g.proofSchema, rootId: g.root.id, baseProofSha256: null, sentProjectionSha256: 'b'.repeat(64), preservationSha256: 'c'.repeat(64), baseObservation: null, children: [] });
          other.noteSaved(token, { proof: g.proof, acknowledgedRoot: false });
          other.commitGroup({ token, baseGeneration: g.generation, records: g.records, proof: g.proof, consumerState: g.consumerState, publication: { scope: g.publication.scope, state: 'owed', desiredSha256: 'd'.repeat(64), dispatchToken: null } });
        }
      }
      const before = storeOf(org, dir).readGroup('form', KEY);
      const spec = state === 'pending, pinned by formId' ? changedPlain({ name: 'Renamed Item', formId: g.root.id }) : changedPlain();
      const r = await buildWarned(org, dir, spec, { phases: ['forms', 'app-shell', 'publish'], publish: true });
      restore();
      assert.equal(r.err && r.err.code, 'managed-form-unsettled', chainText(r.err));
      assert.match(chainText(r.err), new RegExp(`managed-form-unsettled: form "[^"]+" of contoso_item is the form the removed managed declaration "${KEY}" holds`));
      assert.deepEqual(shape(formWrites(r)), [], 'no form is created or changed');
      assert.deepEqual(appOrPublish(r), [], 'no app write or publish goes ahead');
      assert.deepEqual(storeOf(org, dir).readGroup('form', KEY), before, 'the managed state is kept as it was');
    });
  });
}

// The same identity, reached one build after another: a declared create whose answer was lost (the form landed, the attempt
// stays pending), then the declaration removed. With the tab label changed the plain path would PATCH the form the attempt
// may still own; with it unchanged it would write nothing, and is refused all the same.
for (const changed of [true, false]) {
  test(`a declared create whose answer was lost, then removed: the plain form of its name is refused (label changed: ${changed})`, async () => {
    await withForms(true, async () => {
      const org = createFakeBuildOrg({ entities: ENTITIES });
      const dir = newDir();
      let intercepted = 0;
      const restore = org.intercept((c) => c.method === 'POST' && /^\/systemforms(?:\?|$)/.test(c.path) && intercepted++ === 0, async (c) => {
        await org.fake.httpClient.post(`${org.origin}/api/data/v9.2${c.path}`, c.body);
        throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      });
      const first = await build(org, dir, makeSpec());
      restore();
      assert.notEqual(first.err, undefined);
      assert.notEqual(storeOf(org, dir).readGroup('form', KEY).pending, null);
      const r = await buildWarned(org, dir, changed ? changedPlain() : makeSpec({ declared: false }), { phases: ['forms', 'app-shell', 'publish'], publish: true });
      assert.equal(r.err && r.err.code, 'managed-form-unsettled', chainText(r.err));
      assert.deepEqual(shape(formWrites(r)), [], 'the form the lost create made is not changed, and no second one is made');
      assert.deepEqual(appOrPublish(r), []);
      assert.equal(org.fake.rows('systemforms').filter((row) => /Changed plain/.test(row.data.formxml || '')).length, 0);
      assert.notEqual(storeOf(org, dir).readGroup('form', KEY).pending, null, 'the attempt is kept for the build that settles it');
    });
  });
}

// What must not change: the refusal is the one form's, not its table's. A removed declared form left pending holds a plain form
// of its own name; another plain form of the same table is built as it always was. And a removed declared form whose group is
// settled (committed, its publish not needed, no attempt) holds nothing: an unchanged plain form of its name builds clean.
test('a removed declared form left pending holds only its own name: another plain form of its table is still created', async () => {
  await withForms(true, async () => {
    const org = createFakeBuildOrg({ entities: ENTITIES });
    const dir = newDir();
    assert.equal((await build(org, dir, makeSpec())).err, undefined);
    prepareOn(org, dir, storeOf(org, dir).readGroup('form', KEY).committed);
    const spec = makeSpec({ declared: false, form: { name: 'Another Item' } });
    const r = await buildWarned(org, dir, spec);
    assert.notEqual(r.err && r.err.code, 'managed-form-unsettled', chainText(r.err));
    assert.equal(formPosts(r).length, 1, 'the other form is created');
    assert.ok(org.fake.rows('systemforms').some((row) => row.data.name === 'Another Item'));
  });
});
test('a settled removed declared form does not hold an unchanged plain form of its name: the build is clean', async () => {
  await withForms(true, async () => {
    const org = createFakeBuildOrg({ entities: ENTITIES });
    const dir = newDir();
    assert.equal((await build(org, dir, makeSpec())).err, undefined);
    const r = await buildWarned(org, dir, makeSpec({ declared: false }));
    assert.equal(r.err, undefined, chainText(r.err));
    assert.deepEqual(shape(formWrites(r)), []);
  });
});

// The plain path finds a form by the name it is COMPILED with, and a plain form with no `name` is compiled as `<entity> form`. So a
// declared form named "contoso_item form" whose create lost its answer (a pending attempt under `contoso_item/main/contoso_item form`)
// is held for a plain form that omits its name too, before any request: the guard keys the compiled name, not the raw spec. The
// control writes the name out.
const { formLayoutKey } = require('../lib/form-layout-reconcile.js');
for (const mode of ['no name', 'the same name']) {
  test(`a declared create whose answer was lost keeps its compiled name held: a plain form with ${mode} is refused before any write`, async () => {
    await withForms(true, async () => {
      const org = createFakeBuildOrg({ entities: ENTITIES });
      const dir = newDir();
      const declared = makeSpec({ form: { name: 'contoso_item form' } });
      assert.deepEqual(validateAppSpec(declared, { profile: 'deploy' }).errors, []);
      let intercepted = 0;
      const restore = org.intercept((c) => c.method === 'POST' && /^\/systemforms(?:\?|$)/.test(c.path) && intercepted++ === 0, async (c) => {
        await org.fake.httpClient.post(`${org.origin}/api/data/v9.2${c.path}`, c.body);
        throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      });
      const first = await build(org, dir, declared);
      restore();
      assert.ok(first.err);
      const key = formLayoutKey(declared.forms[0]);
      const before = storeOf(org, dir).readGroup('form', key);
      assert.ok(before.pending, chainText(first.err));
      const spec = makeSpec({ declared: false, form: { name: 'contoso_item form' } });
      if (mode === 'no name') delete spec.forms[0].name;
      spec.forms[0].tabs[0].label = 'Changed plain label';
      assert.deepEqual(validateAppSpec(spec, { profile: 'deploy' }).errors, []);
      const r = await build(org, dir, spec, { phases: ['forms', 'app-shell', 'publish'], publish: true });
      assert.deepEqual(shape(formWrites(r)), [], 'a defaulted name does not get past the hold on the pending form');
      assert.equal(r.err && r.err.code, 'managed-form-unsettled', chainText(r.err));
      assert.match(chainText(r.err), /form "contoso_item form" of contoso_item is the form the removed managed declaration "contoso_item\/main\/contoso_item form" holds/);
      assert.deepEqual(appOrPublish(r), []);
      assert.equal(org.fake.rows('systemforms').filter((row) => /Changed plain label/.test(row.data.formxml || '')).length, 0);
      assert.deepEqual(storeOf(org, dir).readGroup('form', key), before, 'the pending attempt is kept as it was');
    });
  });
}

// What the compiled-name hold must not reach: it stays scoped to the table and the form type, so a Quick Create form of the held Main
// form's name is still created; a formId names the held root whatever its case; and a SETTLED removed declared form with a changed
// plain form keeps the behaviour it had (the plain path saves it, and the managed table publisher stops the publish of the table its
// committed group still holds, create-completion-required), which this hold is not about.
const prepareKey = (org, dir, g) => storeOf(org, dir).prepareAttempt({ family: 'form', key: KEY, baseGeneration: g.generation, root: g.root, knownScopes: [g.publication.scope], declarationSha256: 'a'.repeat(64), declaration: g.originalDeclaration });
test('a plain form of the held form\u2019s name and another type is not the held managed form: it is created', async () => {
  await withForms(true, async () => {
    const org = createFakeBuildOrg({ entities: ENTITIES });
    const dir = newDir();
    assert.equal((await build(org, dir, makeSpec())).err, undefined);
    prepareKey(org, dir, storeOf(org, dir).readGroup('form', KEY).committed);
    const r = await build(org, dir, makeSpec({ declared: false, form: { formType: 'QuickCreate' } }));
    assert.notEqual(r.err && r.err.code, 'managed-form-unsettled', chainText(r.err));
    assert.ok(r.writes.some((c) => c.method === 'POST' && /^\/systemforms/.test(c.path) && c.body.type === 7), 'the Quick Create form is created');
  });
});
test('a plain form whose formId names the held root in upper case is refused before any write', async () => {
  await withForms(true, async () => {
    const org = createFakeBuildOrg({ entities: ENTITIES });
    const dir = newDir();
    assert.equal((await build(org, dir, makeSpec())).err, undefined);
    const g = storeOf(org, dir).readGroup('form', KEY).committed;
    prepareKey(org, dir, g);
    const r = await build(org, dir, makeSpec({ declared: false, form: { name: 'Different', formId: g.root.id.toUpperCase() } }));
    assert.equal(r.err && r.err.code, 'managed-form-unsettled', chainText(r.err));
    assert.deepEqual(r.writes, []);
  });
});
test('a settled removed declared form with a changed plain form keeps its earlier behaviour: saved, then its table publish is stopped', async () => {
  await withForms(true, async () => {
    const org = createFakeBuildOrg({ entities: ENTITIES });
    const dir = newDir();
    assert.equal((await build(org, dir, makeSpec())).err, undefined);
    const spec = makeSpec({ declared: false });
    spec.forms[0].tabs[0].label = 'Changed plain label';
    const r = await build(org, dir, spec);
    assert.notEqual(r.err && r.err.code, 'managed-form-unsettled', chainText(r.err));
    assert.match(chainText(r.err), /create-completion-required/);
    assert.ok(r.writes.some((c) => c.method === 'PATCH' && /^\/systemforms/.test(c.path)));
    assert.equal(r.writes.some((c) => /PublishXml|PublishAllXml/.test(c.path)), false);
  });
});

// Both retirement passes run before the first service write, in order (dashboards, then forms), and one halt names every key they
// could not confirm; the next invocation proceeds.
test('both retirement passes run before any write, the halt names every key, and the next invocation proceeds', async () => {
  await withForms(true, async () => {
    const org = createFakeBuildOrg({ entities: ENTITIES });
    const dir = newDir();
    const seeded = makeSpec();
    seeded.dashboards = [{ name: 'Ops', key: 'ops', reconcile: 'declared', description: 'Daily', tiles: [{ key: 'map', type: 'iframe', url: 'https://contoso.example/map', name: 'Map' }] }];
    // The fake org publishes tables only; a dashboard's publish promotes its saved layer the same way.
    const restoreDashboardPublish = org.intercept((c) => c.method === 'POST' && c.path === '/PublishXml' && /<dashboards>/.test(c.body.ParameterXml), async (c) => {
      for (const [, id] of c.body.ParameterXml.matchAll(/<dashboard>([^<]+)<\/dashboard>/g)) {
        const row = org.fake.rows('systemforms').find((x) => x.data.formid.toLowerCase() === id.replace(/[{}]/g, '').toLowerCase());
        assert.ok(row);
        row.version += 1;
        row.publishedVersion = row.version;
        row.publishedData = structuredClone(row.data);
      }
      return { status: 204, headers: {}, body: null };
    });
    // A dashboard tile is created, so the build reads the organization's languages (one here).
    assert.equal((await build(org, dir, seeded, { phases: ['forms', 'dashboards'], provisionedLanguages: async () => [1033] })).err, undefined);
    restoreDashboardPublish();
    const store = storeOf(org, dir);
    const order = [];
    store.observeRetirement = (arg) => {
      order.push(`${arg.family}:${arg.key}`);
      throw Object.assign(new Error('observation unavailable once'), { code: 'managed-binding-store-busy' });
    };
    const spec = makeSpec();
    spec.forms = [];
    spec.dashboards = [];
    const r = await build(org, dir, spec, { bindingGroups: { store }, phases: undefined, publish: true });
    assert.deepEqual(order, ['dashboard:ops', `form:${KEY}`]);
    assert.equal(r.err && r.err.code, 'managed-not-settled', chainText(r.err));
    assert.equal(r.err.name, 'BuildHalt');
    assert.equal(r.err.phase, 'preflight');
    assert.equal(r.err.transient, false);
    assert.equal(r.err.stopsServiceWrites, true);
    assert.deepEqual(r.err.findings.map((f) => f.key), ['ops', KEY]);
    assert.doesNotMatch(chainText(r.err), /approve with|--authorize|--allow-destructive/);
    assert.deepEqual(r.writes, []);
    assert.equal((await build(org, dir, spec, { phases: [] })).err, undefined);
  });
});

// Through the CLI's retry loop: an earlier attempt saved a change to another table's form and its publish failed transiently (the
// halt carries the publish it owes); the retry stops at a retirement it cannot confirm. Nothing is sent after that halt, not even
// the earlier attempt's owed publish. The halt says which attempt stopped and what the earlier one left, and the next invocation
// publishes it (the debt stays recoverable). With no earlier attempt, the halt is the attempt's own.
for (const retry of [false, true]) {
  test(`through the CLI, a retirement it cannot confirm ends the run with nothing sent after it (earlier attempt: ${retry})`, async () => {
    await withForms(true, async () => {
      const org = createFakeBuildOrg({ entities: { ...ENTITIES, contoso_other: { attributes: { contoso_name: 'String', contoso_code: 'String' } } } });
      const dir = newDir();
      assert.equal((await build(org, dir, makeSpec())).err, undefined);
      const spec = makeSpec({ declared: false, form: { entity: 'contoso_other', name: 'Other Item' } });
      spec.entities.push({ ...spec.entities[0], schemaName: 'contoso_other' });
      assert.equal((await build(org, dir, spec)).err, undefined);
      spec.forms[0].tabs[0].label = 'Changed for retry';
      const store = storeOf(org, dir);
      const originalObserve = store.observeRetirement;
      const barrier = createPublicationBarrier();
      const observer = createAttemptSendObserver();
      const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: org.origin, httpClient: gatedClient(org, barrier, observer) });
      await sdk.initWorkspace();
      let attempts = 0;
      let afterHalt = null;
      let error;
      const halts = [];
      const warnings = [];
      store.observeRetirement = (arg) => {
        if (!retry || attempts === 2) {
          afterHalt = org.calls.length;
          throw Object.assign(new Error('observation unavailable'), { code: 'managed-binding-store-busy' });
        }
        return originalObserve(arg);
      };
      const restore = org.intercept((c) => retry && attempts === 1 && c.method === 'POST' && c.path === '/PublishXml' && /contoso_other/.test(JSON.stringify(c.body)),
        async () => ({ status: 503, headers: {}, body: { error: { code: '0x8004f50c', message: 'Service unavailable' } } }));
      try {
        await buildModelApp(spec, { apply: true, publish: true, env: org.origin, workspaceDir: dir, appDir: dir, retryDelayMs: 0, maxRetries: 1 }, {
          sdk, provisionSdk: sdk, bindingGroups: { store }, publicationBarrier: barrier, sendObserver: observer,
          runBuild: async (s, o) => {
            attempts += 1;
            try { return await runSdkBuild(s, { ...o, phases: ['forms', 'app-shell', 'publish'] }); } catch (e) { halts.push({ code: e.code, owed: e.owedPublishes }); throw e; }
          },
          log: () => {}, warn: (m) => warnings.push(m), sleep: async () => {},
        });
      } catch (e) {
        error = e;
      }
      restore();
      assert.equal(attempts, retry ? 2 : 1);
      assert.equal(error && error.code, 'managed-not-settled', chainText(error));
      assert.notEqual(afterHalt, null);
      assert.deepEqual(shape(org.calls.slice(afterHalt).filter((c) => c.method !== 'GET')), [], 'no service write is sent after the unconfirmed retirement');
      if (!retry) {
        assert.doesNotMatch(error.message, /That is attempt/);
        return;
      }
      assert.deepEqual(halts.map((h) => h.code), ['reconciled-publish-failed', 'managed-not-settled']);
      assert.ok(halts[0].owed && halts[0].owed.length, 'the first attempt owed its table publish');
      assert.match(error.message, /That is attempt 2 of this run: an earlier attempt ended on a transient failure and was retried, and what it had already sent stays as it is; nothing more is sent in this run\./);
      assert.deepEqual(error.findings.map((f) => f.key), [KEY]);
      assert.ok(warnings.some((w) => /an earlier attempt of this run saved and did not publish .*Other Item.* until the next build publishes it/.test(w)), warnings.join('\n'));
      // The debt stays recoverable: the next invocation reads the store afresh, keeps the form it finds, and publishes the table.
      const next = await build(org, dir, spec, { phases: ['forms', 'app-shell', 'publish'], publish: true });
      assert.equal(next.err, undefined, chainText(next.err));
      assert.ok(next.writes.some((c) => c.method === 'POST' && c.path === '/PublishXml' && /contoso_other/.test(JSON.stringify(c.body))), 'the next build publishes the saved change');
    });
  });
}

// --- a key declared again after its root was retired -------------------------------------------------------------------------

// A form made by a build, then retired once both layers proved it gone (an org with no form row stands in for the deletion), so
// the store's key has a new incarnation and the old id is the retired one. Answers the org that lost the row, the retired id,
// the incarnation's id and the ids the old group recorded.
async function retiredForm(dir) {
  const original = createFakeBuildOrg({ entities: ENTITIES });
  assert.equal((await build(original, dir, makeSpec())).err, undefined);
  const old = storeOf(original, dir).readGroup('form', KEY).committed;
  const org = createFakeBuildOrg({ entities: ENTITIES });
  const retired = await buildWarned(org, dir, removedForm());
  assert.equal(retired.err, undefined, chainText(retired.err));
  assert.equal(retiredNotices(retired.warns).length, 1);
  // Read from the envelope, not incarnations(), so a build without incarnations fails on what it sends, not on an accessor.
  const reborn = (storeOf(org, dir).snapshot().envelope.incarnations || []).find((x) => x.family === 'form' && x.key === KEY) || {};
  return { org, original, old: old.root.id, reborn: reborn.rootId, oldIds: new Set(old.records.map((r) => String(r.id).toLowerCase())) };
}

for (const fresh of [false, true]) {
  test(`a declared form declared again after its root was retired is created and bound under a fresh id, never the retired one, and the next build is write-free (${fresh ? 'a fresh' : 'the same'} workspace)`, async () => {
    await withForms(true, async () => {
      const dir = newDir();
      const { org, old, reborn, oldIds } = await retiredForm(dir);
      const ws = fresh ? newDir() : dir;
      if (fresh) fs.copyFileSync(storeFileOf(org, dir), storeFileOf(org, ws));
      const first = await build(org, ws, makeSpec());
      assert.equal(first.err, undefined, chainText(first.err));
      assert.ok(!formPosts(first).map((c) => String(c.body.formid).toLowerCase()).includes(old), 'the retired id is never created again');
      assert.deepEqual(formPosts(first).map((c) => String(c.body.formid).toLowerCase()), [reborn], 'one create, under the incarnation');
      assert.ok(!JSON.stringify(first.writes).toLowerCase().includes(old), 'no write names the retired id');
      assert.deepEqual(first.tablePublishes, [['contoso_item']]);
      const bound = storeOf(org, ws).readGroup('form', KEY).committed;
      assert.deepEqual([bound.root.id, rootOrigin(bound)], [reborn, 'created']);
      const reused = bound.records.map((r) => String(r.id).toLowerCase()).filter((id) => id !== 'notescontrol' && oldIds.has(id));
      assert.deepEqual(reused, [], 'every child is derived under the new root');
      const second = await build(org, ws, makeSpec());
      assert.equal(second.err, undefined, chainText(second.err));
      assert.deepEqual([formWrites(second), second.tablePublishes], [[], []]);
      assert.equal(storeOf(org, ws).readGroup('form', KEY).committed.generation, bound.generation);
    });
  });
}

test('a declared form declared again after retirement keeps its incarnation through a lost create answer: resumed or adopted under that id, never a second one', async () => {
  await withForms(true, async () => {
    for (const applied of [false, true]) {
      const dir = newDir();
      const { org, old, reborn } = await retiredForm(dir);
      let n = 0;
      const restore = org.intercept((c) => c.method === 'POST' && /^\/systemforms(?:\?|$)/.test(c.path) && n++ === 0, async (c) => {
        if (applied) await org.fake.httpClient.post(`${org.origin}/api/data/v9.2${c.path}`, c.body);
        throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      });
      const lost = await build(org, dir, makeSpec());
      restore();
      assert.ok(lost.err, `applied=${applied}: the lost answer stops the build`);
      assert.ok(!formPosts(lost).map((c) => String(c.body.formid).toLowerCase()).includes(old), 'the retired id is never created again');
      assert.deepEqual(formPosts(lost).map((c) => String(c.body.formid).toLowerCase()), [reborn]);
      assert.equal(storeOf(org, dir).readGroup('form', KEY).pending.root.id, reborn, 'the attempt holds the incarnation');
      const next = await build(org, dir, makeSpec(), applied ? { authorizedAdoption: new Set([`form:${KEY}`]) } : {});
      assert.equal(next.err, undefined, `applied=${applied}: ${chainText(next.err)}`);
      assert.deepEqual(formPosts(next).map((c) => String(c.body.formid).toLowerCase()), applied ? [] : [reborn], applied ? 'the landed create is adopted, not sent again' : 'the unsent create is sent again under the same id');
      assert.equal(storeOf(org, dir).readGroup('form', KEY).committed.root.id, reborn);
      assert.ok(!JSON.stringify([lost.writes, next.writes]).toLowerCase().includes(old));
    }
  });
});

test('a namesake made after a declared form was retired is not adopted without adopt:form, and with it is bound by its own id', async () => {
  await withForms(true, async () => {
    const dir = newDir();
    const { org, original, old, reborn } = await retiredForm(dir);
    const id = '33333333-3333-4333-8333-333333333333';
    const row = original.fake.rows('systemforms').find((r) => r.data.formid === old).data;
    await org.fake.httpClient.post(`${org.origin}/api/data/v9.2/systemforms`, { ...row, formid: id });
    await org.fake.httpClient.post(`${org.origin}/api/data/v9.2/PublishXml`, { ParameterXml: '<importexportxml><entities><entity>contoso_item</entity></entities></importexportxml>' });
    const refused = await build(org, dir, reordered());
    assert.equal(refused.err && refused.err.code, 'form-layout-adoption-not-authorized', chainText(refused.err));
    assert.deepEqual(refused.writes, []);
    assert.deepEqual(storeOf(org, dir).readGroup('form', KEY), { committed: null, pending: null, effects: [] });
    const approved = await build(org, dir, reordered(), { authorizedAdoption: new Set([`form:${KEY}`]) });
    assert.equal(approved.err, undefined, chainText(approved.err));
    assert.deepEqual(formPosts(approved), []);
    assert.equal(storeOf(org, dir).readGroup('form', KEY).committed.root.id, id);
    assert.notEqual(id, reborn);
  });
});
// The catalog selects an incarnation by its canonical identity too: a form name the identity algorithm folds to the retired
// one (here an accent) is another plan key but the same artifact, so it takes the retired key's incarnation, never the
// retired stable id, and the retained SDK workspace's copy of the retired row is never pushed.
test('a declared form declared again after retirement under a name the identity algorithm folds to the same artifact is created under the incarnation, never the retired id', async () => {
  await withForms(true, async () => {
    const dir = newDir();
    const { org, old, reborn } = await retiredForm(dir);
    const changed = makeSpec({ form: { name: 'Déclared Item' } });
    const first = await build(org, dir, changed);
    assert.equal(first.err, undefined, chainText(first.err));
    assert.deepEqual(formPosts(first).map((c) => String(c.body.formid).toLowerCase()), [reborn], 'one create, under the incarnation of the same identity');
    const next = await build(org, dir, changed);
    assert.equal(next.err, undefined, chainText(next.err));
    assert.deepEqual(formWrites(next), []);
    assert.ok(!JSON.stringify([first.writes, next.writes]).toLowerCase().includes(old), 'no write names the retired id');
  });
});

// A plan made from a store read before the key's root was retired twice is refused under the lease by its incarnation
// epoch: the store's fence never compares the plan only with the last retired root.
test('a build handed a binding store read before two retirements of a declared form never prepares or creates an earlier retired root', async () => {
  await withForms(true, async () => {
    const dir = newDir();
    const original = createFakeBuildOrg({ entities: ENTITIES });
    const stale = storeOf(original, dir);
    assert.equal((await build(original, dir, makeSpec())).err, undefined);
    const old = storeOf(original, dir).readGroup('form', KEY).committed.root.id;
    const second = createFakeBuildOrg({ entities: ENTITIES });
    assert.equal((await buildWarned(second, dir, removedForm())).err, undefined);
    assert.equal((await build(second, dir, makeSpec())).err, undefined);
    const current = createFakeBuildOrg({ entities: ENTITIES });
    assert.equal((await buildWarned(current, dir, removedForm())).err, undefined);
    const [inc] = storeOf(current, dir).incarnations();
    assert.equal(inc.epoch, 2);
    const before = fs.readFileSync(storeFileOf(current, dir), 'utf8');
    const got = await build(current, dir, makeSpec(), { bindingGroups: { store: stale } });
    assert.match(chainText(got.err), /managed-binding-generation-conflict/);
    assert.deepEqual(formPosts(got), [], 'nothing is sent');
    assert.equal(fs.readFileSync(storeFileOf(current, dir), 'utf8'), before, 'nothing is written');
    const next = await build(current, dir, makeSpec());
    assert.equal(next.err, undefined, chainText(next.err));
    assert.deepEqual(formPosts(next).map((c) => String(c.body.formid).toLowerCase()), [inc.rootId], 'created under the current incarnation');
    assert.ok(!JSON.stringify(next.writes).toLowerCase().includes(old));
  });
});
