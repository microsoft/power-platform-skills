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
const { readerFor, isolatedReaderFor } = require('../verify-model-app.js');
const { main: downloadMain } = require('../download-model-app.js');
const { verifySpec } = require('../lib/verify-spec.js');
const { readVerifyManifest } = require('../lib/declared-form-io.js');
const { storeFileName } = require('../lib/managed-bindings.js');
const { environmentFingerprint } = require('../lib/page-ownership-records.js');
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

// download-model-app.js main with its side effects replaced: the download's SDK is a real one over the fake org (it answers the app's
// unique name itself), and runDownload answers the spec a download of this app would hydrate (forms[] empty, as every download).
async function download(org, out, argv, extra = {}) {
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
    runDownload: async () => ({ ok: true, spec: downloaded, pages: [], entities: ['contoso_item'], webResources: [], droppedSubareas: 0, droppedSubareaDetails: [] }),
    ...extra,
  });
  const specFile = path.join(out, 'app-spec.json');
  return { emitted, said: said.join(''), exited, calls: org.calls.slice(mark), written: fs.existsSync(specFile) ? JSON.parse(fs.readFileSync(specFile, 'utf8')) : null };
}
const storeFileOf = (org, dir) => path.join(dir, storeFileName(environmentFingerprint(org.origin), APP, SOLUTION));

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
