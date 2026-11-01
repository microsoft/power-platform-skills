'use strict';
// Declared form layouts (forms[].reconcile: "declared") wired into the build: the spec gate, the forms phase's dispatch to the
// managed form helper (lib/form-layout-reconcile.js reconcileDeclaredForm), the halt it is given, the per-table publish the
// managed publisher owes, and the CLI's typed `publication-risk:<scopeKey>` acceptance after a publish whose answer was lost.
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
const { DECLARED_FEATURES } = require('../lib/declared-features.js');
const { createFakeBuildOrg } = require('./helpers/fake-app-build-org.js');
const { gatedClient } = require('./helpers/gated-fake-client.js');

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
async function build(org, dir, spec, opts = {}) {
  const barrier = createPublicationBarrier();
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
  return { out, err, calls, writes: calls.filter((c) => c.method !== 'GET'), tablePublishes: org.tablePublishes(mark) };
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
    assert.ok(v.errors.includes("forms: 'Declared Item' — reconcile is supported only on views, charts and web resources; leave it out (this artifact keeps the existing build behaviour)"), JSON.stringify(v.errors));
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
      assert.equal(blocked.approval, 'publication-risk:table:contoso_item');
      assert.match(blocked.dispatchToken, /\S/);
      assert.match(blocked.remedy, /\S/);
      assert.deepEqual(r.tablePublishes, [], `run ${n} sends no publish`);
    }
  });
});

// --- the CLI: publication-risk ------------------------------------------------------------------------------------------------

test('--authorize publication-risk is its own typed key: never implied by an untyped key or another family', () => {
  const spec = makeSpec();
  const typed = authorizationKeys(['--authorize', 'publication-risk:table:Contoso_Item'], spec);
  assert.equal(typed.error, null);
  assert.deepEqual([...typed.publicationRisk], ['publication-risk:table:contoso_item']);
  for (const other of ['contoso_item', 'publication-risk', 'overwrite:view:contoso_item']) {
    assert.equal(authorizationKeys(['--authorize', other], spec).publicationRisk.size, 0, other);
  }
  assert.match(String(authorizationKeys(['--authorize', 'publication-risk:table:not a table'], spec).error), /is not publication-risk:table:<table>/);
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
    const token = /dispatch (\S+?)\)/.exec(unapproved.said);
    assert.ok(token, unapproved.said);
    assert.match(unapproved.said, /run the build again with --authorize publication-risk:table:contoso_item/);
    assert.doesNotMatch(unapproved.said, /accepted the risk/);
    // Another key, or --allow-destructive, records nothing.
    const wrong = await cli({ allowDestructive: true, publicationRisk: new Set(['publication-risk:table:contoso_other']) });
    assert.doesNotMatch(wrong.said, /accepted the risk/);
    assert.deepEqual(wrong.tablePublishes, []);
    const accepted = await cli({ publicationRisk: new Set(['publication-risk:table:contoso_item']) });
    assert.ok(accepted.err, 'acceptance is a risk decision, not a proof: the run stays stopped');
    assert.match(accepted.said, /accepted the risk of dispatch \S+ \(publication-risk:table:contoso_item\)/);
    assert.deepEqual(accepted.tablePublishes, []);
    const next = await cli();
    assert.equal(next.err, undefined, chainText(next.err));
    assert.deepEqual(next.tablePublishes, [['contoso_item']]);
    assert.equal(storeOf(org, dir).readGroup('form', KEY).committed.publication.state, 'confirmed');
  });
});
