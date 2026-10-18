'use strict';
// REAL BUNDLE: Main Form Set order is stored in a form's published formxml DisplayConditions. The
// build relies on the SDK preserving roles/fallback while changing only Order, and on refusing an
// order-only write when there is no DisplayConditions element to attach it to.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { runSdkBuild } = require('../lib/sdk-build.js');

const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');
const FORM_ID = '11111111-1111-1111-1111-111111111111';
const ROLE_A = '22222222-2222-2222-2222-222222222222';
const ROLE_B = '33333333-3333-3333-3333-333333333333';
// systemform.type of a Main form. The SDK reads the type of every form it reads or writes by id and refuses a row of
// another kind (a dashboard is 0), or one that answers no type, so the row must carry it as the platform's does.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/systemform#BKMK_Type
const FORM_TYPE_MAIN = 2;

const tempDirs = [];
test.after(() => { for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true }); });

// The columns a `$select` names, as the platform answers them: a column that was not selected is not in the body
// (the SDK's own checks run on the columns it asked for, so a read that forgets `type` must see it missing here too),
// and `RetrieveUnpublished()` leaves out a selected column whose value is null.
function selectedColumns(url, row) {
  const select = /[?&]\$select=([^&]*)/.exec(String(url));
  const present = Object.entries(row).filter(([column, value]) => value !== null || column.startsWith('@'));
  if (!select) return Object.fromEntries(present);
  const wanted = new Set(decodeURIComponent(select[1]).split(',').map((c) => c.trim()));
  return Object.fromEntries(present.filter(([column]) => wanted.has(column) || column.startsWith('@')));
}

async function freshSdk(initialXml, { type = FORM_TYPE_MAIN } = {}) {
  const { createMakerSdk, createNodeWorkspaceStorage } = require(BUNDLE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'form-order-sdk-'));
  tempDirs.push(dir);
  const calls = [];
  const state = { formxml: initialXml, etag: 'W/"form-etag-1"' };
  const httpClient = {
    get: async (url) => {
      calls.push({ verb: 'get', url: String(url) });
      if (/RetrieveUnpublished\(\)/.test(url)) {
        const row = { formid: FORM_ID, formxml: state.formxml, type, '@odata.etag': state.etag };
        return { status: 200, headers: {}, body: selectedColumns(url, row) };
      }
      if (/\/systemforms\(/.test(url)) {
        return { status: 200, headers: {}, body: { formid: FORM_ID, '@odata.etag': state.etag } };
      }
      return { status: 200, headers: {}, body: { value: [] } };
    },
    patch: async (url, body, options) => {
      calls.push({ verb: 'patch', url: String(url), body, options });
      if (body && body.formxml) state.formxml = body.formxml;
      state.etag = 'W/"form-etag-2"';
      return { status: 204, headers: {}, body: {} };
    },
    post: async () => ({ status: 204, headers: {}, body: {} }),
    delete: async () => ({ status: 204, headers: {}, body: {} }),
    put: async () => ({ status: 204, headers: {}, body: {} }),
  };
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: 'https://contoso.crm.dynamics.com', httpClient });
  await sdk.initWorkspace();
  return { sdk, calls, state };
}

const patchCall = (calls) => calls.find((c) => c.verb === 'patch');
const withoutDisplayConditions = (xml) => String(xml).replace(/<DisplayConditions\b[^>]*>(?:.|\n)*?<\/DisplayConditions>/, '').replace(/<DisplayConditions\b[^>]*\/>/, '');

test('getFormSecurityRoles reads DisplayConditions Order and returns undefined when none exists', async () => {
  const live = '<form><tabs><tab name="general" /></tabs><DisplayConditions Order="0" FallbackForm="true"><Everyone /></DisplayConditions></form>';
  const withOrder = await freshSdk(live);
  assert.deepStrictEqual(await withOrder.sdk.getFormSecurityRoles(FORM_ID), { everyone: true, fallbackForm: true, order: 0 });

  const withoutOrder = await freshSdk('<form><tabs><tab name="general" /></tabs></form>');
  assert.strictEqual(await withoutOrder.sdk.getFormSecurityRoles(FORM_ID), undefined);
});

test('setFormSecurityRoles order-only write preserves Everyone, FallbackForm, untouched XML, and uses the read etag', async () => {
  const original = '<form><tabs><tab name="general"><labels><label description="General" languagecode="1033" /></labels></tab></tabs><DisplayConditions Order="0" FallbackForm="true"><Everyone /></DisplayConditions></form>';
  const { sdk, calls } = await freshSdk(original);

  await sdk.setFormSecurityRoles(FORM_ID, { order: 2 });

  const patch = patchCall(calls);
  assert.ok(patch, 'the SDK must PATCH the form row');
  assert.match(patch.body.formxml, /Order="2"/);
  assert.match(patch.body.formxml, /FallbackForm="true"/);
  assert.match(patch.body.formxml, /<Everyone\s*\/>/);
  assert.strictEqual(patch.options.headers['If-Match'], 'W/"form-etag-1"');
  assert.strictEqual(withoutDisplayConditions(patch.body.formxml), withoutDisplayConditions(original), 'tabs and other formxml stay byte-for-byte unchanged');
});

test('order-only write on a role-restricted form preserves both roles and FallbackForm=false', async () => {
  const original = `<form><tabs><tab name="general" /></tabs><DisplayConditions Order="0" FallbackForm="false"><Role Id="{${ROLE_A}}" /><Role Id="{${ROLE_B}}" /></DisplayConditions></form>`;
  const { sdk, calls } = await freshSdk(original);

  await sdk.setFormSecurityRoles(FORM_ID, { order: 2 });

  const xml = patchCall(calls).body.formxml;
  assert.match(xml, /Order="2"/);
  assert.match(xml, /FallbackForm="false"/);
  assert.match(xml, new RegExp(`<Role Id="\\{${ROLE_A}\\}"\\s*/>`));
  assert.match(xml, new RegExp(`<Role Id="\\{${ROLE_B}\\}"\\s*/>`));
  assert.strictEqual(withoutDisplayConditions(xml), withoutDisplayConditions(original));
});

test('a DisplayConditions with no Order — what a form the SDK creates carries — reads as order undefined, and an order-only write adds the attribute and keeps Everyone and FallbackForm', async () => {
  // The forms phase writes Order 0..n-1 onto the Main forms it was asked to order (writeFormOrder), and a form it just created starts
  // with none: the first form is written too.
  const original = '<form><tabs><tab name="general" /></tabs><DisplayConditions FallbackForm="true"><Everyone /></DisplayConditions></form>';
  const { sdk, calls } = await freshSdk(original);
  const stored = await sdk.getFormSecurityRoles(FORM_ID);
  assert.strictEqual(stored.order, undefined);
  assert.strictEqual(stored.everyone, true);
  assert.strictEqual(stored.fallbackForm, true);

  await sdk.setFormSecurityRoles(FORM_ID, { order: 0 });

  const xml = patchCall(calls).body.formxml;
  assert.match(xml, /<DisplayConditions\b[^>]*Order="0"[^>]*>/);
  assert.match(xml, /FallbackForm="true"/);
  assert.match(xml, /<Everyone\s*\/>/);
  assert.strictEqual(withoutDisplayConditions(xml), withoutDisplayConditions(original), 'the rest of the form is unchanged');
});

test('forms without DisplayConditions refuse order-only writes, while everyone+fallback+order adds the element', async () => {
  const original = '<form><tabs><tab name="general" /></tabs></form>';
  const { sdk, calls } = await freshSdk(original);

  await assert.rejects(sdk.setFormSecurityRoles(FORM_ID, { order: 2 }), /without `roleIds` or `everyone`/);
  assert.strictEqual(calls.some((c) => c.verb === 'patch'), false, 'the refused order-only write must not PATCH');

  await sdk.setFormSecurityRoles(FORM_ID, { everyone: true, fallbackForm: true, order: 1 });

  const xml = patchCall(calls).body.formxml;
  assert.match(xml, /<DisplayConditions\b[^>]*Order="1"[^>]*FallbackForm="true"[^>]*>/);
  assert.match(xml, /<Everyone\s*\/>/);
  assert.strictEqual(withoutDisplayConditions(xml), withoutDisplayConditions(original), 'adding DisplayConditions leaves the existing form body unchanged');
});

// A form's id is all the forms phase hands the SDK, and `systemforms` also holds every dashboard (type 0) and the
// form kinds the SDK does not model. Reading or rewriting such a row as a form would project it through the Main-form
// grammar and write the re-serialized document back, so the SDK refuses a row of another kind — from the `type` the
// read already selects — before it parses or writes anything. The plugin checks a pinned id first (resolveExistingFormId);
// this is the second line, for an id that changed kind or was passed by mistake.
test('a dashboard\u2019s id is refused as a form: nothing is read into a form, nothing is written', async () => {
  const live = '<form><tabs><tab name="general" /></tabs><DisplayConditions Order="0" FallbackForm="true"><Everyone /></DisplayConditions></form>';
  const dashboard = await freshSdk(live, { type: 0 });
  await assert.rejects(dashboard.sdk.getFormSecurityRoles(FORM_ID), (e) => e.code === 'SYSTEMFORM_KIND_MISMATCH' && /it is a dashboard \(type 0\)/.test(e.message));
  await assert.rejects(dashboard.sdk.setFormSecurityRoles(FORM_ID, { order: 2 }), (e) => e.code === 'SYSTEMFORM_KIND_MISMATCH' && /Nothing was written/.test(e.message));
  assert.strictEqual(dashboard.calls.some((c) => c.verb === 'patch'), false, 'no PATCH reached the row');
  assert.strictEqual(dashboard.state.formxml, live, 'the row is as it was');

  // A kind the SDK does not model reads the same: a task flow form (type 9) is no Main form either.
  const taskFlow = await freshSdk(live, { type: 9 });
  await assert.rejects(taskFlow.sdk.setFormSecurityRoles(FORM_ID, { order: 2 }), (e) => e.code === 'SYSTEMFORM_KIND_MISMATCH' && /task flow form \(type 9\)/.test(e.message));
  assert.strictEqual(taskFlow.calls.some((c) => c.verb === 'patch'), false);
});

test('a row whose type cannot be read is refused too, never taken for a Main form', async () => {
  const live = '<form><tabs><tab name="general" /></tabs><DisplayConditions Order="0" FallbackForm="true"><Everyone /></DisplayConditions></form>';
  const untyped = await freshSdk(live, { type: null });
  await assert.rejects(untyped.sdk.getFormSecurityRoles(FORM_ID), (e) => e.code === 'SYSTEMFORM_KIND_MISMATCH' && /type could not be read/.test(e.message));
  await assert.rejects(untyped.sdk.setFormSecurityRoles(FORM_ID, { order: 2 }), (e) => e.code === 'SYSTEMFORM_KIND_MISMATCH');
  assert.strictEqual(untyped.calls.some((c) => c.verb === 'patch'), false);
});

// The build places a Main form it creates on a table whose order it does not set IN ITS CREATE
// (createInPlace, sdk-build.js): it finds the <DisplayConditions> the SDK gives the new form in its root
// bag and writes the form's order into it before the first push. The SDK gives it no Order (a form with
// none takes no slot in the maker's form order: GetFormsOrderInfo says -1 for it), so the build ADDS the
// attribute, first, as the maker's own file has it. This pins the SDK side of that: if the node moved or
// were rebuilt at push time, forms would silently be created with no order again.
test('a new form carries <DisplayConditions FallbackForm="true"> with no Order in its root bag, and the Order the build adds to it before the first push is what the create writes', async () => {
  const { createMakerSdk, createNodeWorkspaceStorage } = require(BUNDLE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'form-order-create-'));
  tempDirs.push(dir);
  const posts = [];
  const httpClient = {
    get: async (url) => {
      const meta = /EntityDefinitions\(LogicalName='([^']+)'\)/.exec(url);
      return { status: 200, headers: {}, body: meta ? { LogicalName: meta[1], EntitySetName: `${meta[1]}s`, ObjectTypeCode: 10001, MetadataId: '44444444-4444-4444-4444-444444444444' } : { value: [] } };
    },
    post: async (url, body) => { posts.push({ url: String(url), body }); return { status: 204, headers: { 'OData-EntityId': `${url}(55555555-5555-5555-5555-555555555555)` }, body: undefined }; },
    patch: async () => ({ status: 204, headers: {}, body: {} }),
    delete: async () => ({ status: 204, headers: {}, body: {} }),
    put: async () => ({ status: 204, headers: {}, body: {} }),
  };
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: 'https://contoso.crm.dynamics.com', httpClient });
  await sdk.initWorkspace();

  const art = await sdk.createArtifact('form', { name: 'Work Item \u2014 Board', entityLogicalName: 'new_workitem', formType: 'Main' });
  const local = await sdk.getArtifact('form', art.id);
  const at = local.bag.c.findIndex((e) => e && e.node && e.node.n === 'DisplayConditions');
  assert.ok(at >= 0, `no DisplayConditions in the new form's root bag: ${JSON.stringify(local.bag.c.map((e) => e.node && e.node.n))}`);
  assert.deepStrictEqual(local.bag.c[at].node.a, [['FallbackForm', 'true']], 'access is unchanged (everyone, fallback) and the form takes no slot in the form order');
  assert.deepStrictEqual(local.bag.c[at].node.c.map((c) => c.n), ['Everyone']);

  // What createInPlace writes: the order goes first, the attributes the SDK gave the node stay.
  const entry = JSON.parse(JSON.stringify(local.bag.c[at]));
  entry.node.a = [['Order', '7'], ...entry.node.a];
  await sdk.updateElement('form', art.id, `/bag/c/${at}`, entry);
  await sdk.pushArtifact('form', art.id);

  const create = posts.find((p) => /\/systemforms(\?|$)/.test(p.url));
  assert.ok(create, 'the form is created with one POST');
  const xml = String(create.body && create.body.formxml);
  assert.match(xml, /<DisplayConditions Order="7" FallbackForm="true"><Everyone \/><\/DisplayConditions>/);
  assert.strictEqual((xml.match(/<DisplayConditions\b/g) || []).length, 1, 'one element, not a second default one');
  assert.match(xml, /<header\b/, 'the rest of the form is written as the SDK built it');
});

// --- the whole forms phase, on the real bundle ---------------------------------------------------------------------
//
// `runSdkBuild` over the vendored SDK and a small fake org that keeps EVERY systemform row. The tests above pin what
// the SDK does with one form; these pin what the build asks of it across a table's forms — which writes it makes, and
// what each form's stored <DisplayConditions> says afterwards. The build tests that model the environment
// (form-order-build.test.js, over helpers/mock-sdk.js) are checked against these answers, not only against their model.
const TABLE = 'new_workitem';
const STD = 'Work Item';
const ALT = 'My Work \u2014 Work Item';
const SUM = 'Work Item \u2014 Summary';
const guid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// The `Order` in a form's formxml <DisplayConditions>, or undefined when the element has none.
const storedOrder = (formxml) => {
  const attribute = /<DisplayConditions\b[^>]*\sOrder="(-?\d+)"/.exec(String(formxml));
  return attribute ? Number(attribute[1]) : undefined;
};

const mainFormsSpec = (names, { existing = false } = {}) => ({
  solution: { uniqueName: 'FO', displayName: 'FO', publisherPrefix: 'new' },
  app: { name: 'FO App', description: 'd' },
  entities: [{
    schemaName: TABLE, displayName: 'Work Item', pluralName: 'Work Items',
    primaryAttribute: { schemaName: 'new_name', displayName: 'Name' },
    columns: [{ schemaName: 'new_notes', displayName: 'Notes', type: 'Memo' }],
    ...(existing ? { existing: true } : {}),
  }],
  forms: names.map((name) => ({ entity: TABLE, name, formType: 'Main' })),
  appShell: { areas: [{ label: 'Main', groups: [{ label: 'W', subAreas: [{ entity: TABLE, title: 'Work Items' }] }] }] },
});

function fakeFormsOrg(seed = []) {
  const rows = new Map();
  const revisions = new Map();
  const requests = [];
  const addRow = (row) => {
    rows.set(row.formid, { type: FORM_TYPE_MAIN, objecttypecode: TABLE, formactivationstate: 1, isdefault: false, ...row });
    revisions.set(row.formid, 1);
  };
  seed.forEach(addRow);
  // The filters the build sends for a form, as the platform evaluates them:
  //   objecttypecode eq 'new_workitem' and name eq 'Work Item' and type eq 2
  //   objecttypecode eq 'new_workitem' and type eq 2 and formactivationstate eq 1
  //   formid eq 00000000-0000-4000-8000-000000000001
  const matching = (filter) => [...rows.values()].filter((row) => {
    const byId = /^formid eq (\S+)$/.exec(filter);
    if (byId) return row.formid === byId[1];
    const table = /objecttypecode eq '([^']+)'/.exec(filter);
    const name = / name eq '((?:[^']|'')*)'/.exec(filter);
    const type = / type eq (\d+)/.exec(filter);
    return (!table || row.objecttypecode === table[1])
      && (!name || row.name === name[1].replace(/''/g, "'"))
      && (!type || Number(row.type) === Number(type[1]))
      && (!/ formactivationstate eq 1/.test(filter) || row.formactivationstate === 1);
  });
  const reply = (body, status = 200, headers = {}) => ({ status, headers, body });
  const idOf = (url) => (/\/systemforms\(([0-9a-f-]+)\)/i.exec(url) || [])[1];
  const httpClient = {
    get: async (url) => {
      const decoded = decodeURIComponent(url);
      requests.push({ method: 'get', url: decoded });
      if (/EntityDefinitions\(LogicalName='systemform'\)/.test(decoded)) return reply({ EntitySetName: 'systemforms' });
      if (decoded.includes(`EntityDefinitions(LogicalName='${TABLE}')/Attributes`)) {
        return reply({ value: [{ LogicalName: 'new_name', AttributeType: 'String' }, { LogicalName: 'new_notes', AttributeType: 'Memo' }] });
      }
      if (decoded.includes(`EntityDefinitions(LogicalName='${TABLE}')`)) {
        return reply({ LogicalName: TABLE, EntitySetName: `${TABLE}s`, ObjectTypeCode: 10001, MetadataId: guid(900) });
      }
      const id = idOf(decoded);
      if (id && /RetrieveUnpublished\(\)/.test(decoded)) {
        // The unpublished document's content token. The row's own token, read separately, is the one a PATCH sends back.
        return reply(selectedColumns(url, { ...rows.get(id), '@odata.etag': `W/"content-${revisions.get(id)}"` }));
      }
      if (id) return reply({ formid: id, '@odata.etag': `W/"row-${revisions.get(id)}"` }, 200, { etag: `W/"row-${revisions.get(id)}"` });
      if (/\/systemforms(?:\?|$)/.test(decoded)) {
        const filter = (/\$filter=([^&]*)/.exec(decoded) || [])[1] || '';
        const top = Number((/\$top=(\d+)/.exec(decoded) || [])[1] || Infinity);
        return reply({ value: matching(filter).slice(0, top).map((row) => selectedColumns(url, row)) });
      }
      return assert.fail(`unexpected GET: ${decoded}`);
    },
    post: async (url, body) => {
      const decoded = decodeURIComponent(url);
      requests.push({ method: 'post', url: decoded, body });
      if (/\/systemforms(?:\?|$)/.test(decoded)) {
        // The SDK sends the id it minted for the new form as `formid`, and the platform keeps it.
        const id = body.formid || guid(rows.size + 1);
        addRow({ ...body, formid: id });
        return reply(undefined, 204, { 'odata-entityid': `https://contoso.crm.dynamics.com/api/data/v9.0/systemforms(${id})` });
      }
      if (/\/(?:AddSolutionComponent|PublishXml)(?:\?|$)/.test(decoded)) return reply({}, 204);
      return assert.fail(`unexpected POST: ${decoded}`);
    },
    patch: async (url, body) => {
      const decoded = decodeURIComponent(url);
      requests.push({ method: 'patch', url: decoded, body });
      const id = idOf(decoded);
      assert.ok(rows.has(id), `a PATCH of a form that does not exist: ${decoded}`);
      Object.assign(rows.get(id), body);
      revisions.set(id, revisions.get(id) + 1);
      return reply({}, 204);
    },
    put: async (url) => assert.fail(`unexpected PUT: ${url}`),
    delete: async (url) => assert.fail(`unexpected DELETE: ${url}`),
  };
  // A new SDK over a new workspace each time: a rebuild must not lean on an earlier run's local copy.
  const newSdk = async () => {
    const { createMakerSdk, createNodeWorkspaceStorage } = require(BUNDLE);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'form-order-org-'));
    tempDirs.push(dir);
    const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: 'https://contoso.crm.dynamics.com', httpClient });
    await sdk.initWorkspace();
    return sdk;
  };
  const byName = (name) => [...rows.values()].find((row) => row.name === name);
  const creates = () => requests.filter((r) => r.method === 'post' && /\/systemforms(?:\?|$)/.test(r.url));
  // The writes of a form's formxml after its create, as [form name, the Order the write leaves in it].
  const formxmlWrites = () => requests
    .filter((r) => r.method === 'patch' && r.body && r.body.formxml !== undefined)
    .map((r) => [rows.get(idOf(r.url)).name, storedOrder(r.body.formxml)]);
  return { rows, requests, byName, creates, formxmlWrites, newSdk };
}

async function buildForms(spec, sdk) {
  const warnings = [];
  const res = await runSdkBuild(spec, { sdk, apply: true, phases: ['forms'], emit: () => {}, warn: (m) => warnings.push(String(m)) });
  return { res, warnings };
}

test('forms phase on the real bundle, a table the spec creates: every Main form is written its place — the first too, a new form has no Order — and a rebuild writes none', async () => {
  const org = fakeFormsOrg();
  const spec = mainFormsSpec([STD, ALT, SUM]);
  const built = await buildForms(spec, await org.newSdk());
  assert.strictEqual(built.res.ok, true);

  // The create is the SDK's own, with no Order: a table the spec orders is ordered after every form exists.
  assert.strictEqual(org.creates().length, 3);
  for (const create of org.creates()) {
    assert.match(create.body.formxml, /<DisplayConditions FallbackForm="true"><Everyone \/><\/DisplayConditions>/);
  }
  assert.deepStrictEqual([STD, ALT, SUM].map((name) => storedOrder(org.byName(name).formxml)), [0, 1, 2]);
  assert.deepStrictEqual(org.formxmlWrites().sort((a, b) => a[1] - b[1]), [[STD, 0], [ALT, 1], [SUM, 2]], 'one write per form, the first included: it is not found already at 0');
  for (const name of [STD, ALT, SUM]) {
    assert.match(org.byName(name).formxml, /<DisplayConditions\b[^>]*FallbackForm="true"[^>]*><Everyone \/>/, `${name}: an order-only write keeps everyone and fallback`);
  }
  assert.deepStrictEqual([STD, ALT, SUM].map((name) => org.byName(name).isdefault), [true, false, false]);

  const written = org.formxmlWrites().length;
  const rebuilt = await buildForms(spec, await org.newSdk());
  assert.strictEqual(rebuilt.res.ok, true);
  assert.strictEqual(org.formxmlWrites().length, written, 'a rebuild finds every order in place and writes none');
  assert.deepStrictEqual(rebuilt.warnings.filter((w) => /form order/.test(w)), []);
});

test('forms phase on the real bundle, a table the spec does not order: a new Main form is created already after the table\u2019s other Main forms, in its create', async () => {
  const ordered = '<form><tabs /><DisplayConditions Order="5" FallbackForm="true"><Everyone /></DisplayConditions></form>';
  const unordered = '<form><tabs /></form>';
  const org = fakeFormsOrg([
    { formid: guid(100), name: STD, isdefault: true, formxml: ordered },
    { formid: guid(101), name: 'Information', formxml: unordered },
  ]);
  const { res, warnings } = await buildForms(mainFormsSpec([ALT], { existing: true }), await org.newSdk());
  assert.strictEqual(res.ok, true);

  // The highest order among the others (5), plus 1, plus the form's index among the spec's Main forms of the table (0).
  assert.strictEqual(org.creates().length, 1);
  assert.match(org.creates()[0].body.formxml, /<DisplayConditions Order="6" FallbackForm="true"><Everyone \/><\/DisplayConditions>/);
  assert.strictEqual(storedOrder(org.byName(ALT).formxml), 6);
  assert.deepStrictEqual(org.formxmlWrites(), [], 'no separate order write: the order is part of the create');
  assert.strictEqual(org.byName(STD).formxml, ordered, 'the form the table opens with is not touched');
  assert.strictEqual(org.byName('Information').formxml, unordered, 'nor is a form the spec does not declare');
  // A form with no order is served after every form that has one, so the new form still comes before it: the build says so.
  assert.ok(warnings.some((w) => /before 'Information', which has no form order/.test(w)), JSON.stringify(warnings));
});

// helpers/mock-sdk.js stands in for the SDK in the build tests that run a whole build. A stand-in that models a created
// form differently from the bundle makes those tests pin the wrong behaviour — the first new form of a table the spec
// orders needs an order write only because the bundle gives it none — so the parts that decide it are compared here:
// the <DisplayConditions> a created form carries, and how a read and a write of its roles answer afterwards.
test('the shared SDK mock creates a form as the real bundle does, and answers the same reads and writes of its roles', async () => {
  const { makeSimpleMockSdk } = require('./helpers/mock-sdk.js');
  const real = await fakeFormsOrg().newSdk();
  const mock = makeSimpleMockSdk().sdk;
  const definition = { name: 'Probe', entityLogicalName: TABLE, formType: 'Main' };
  const realArtifact = await real.createArtifact('form', definition);
  const mockArtifact = await mock.createArtifact('form', definition);
  const conditionsOf = async (sdk, artifact) => {
    const bag = (await sdk.getArtifact('form', artifact.id)).bag.c;
    return (bag.find((e) => e && e.node && e.node.n === 'DisplayConditions') || {}).node;
  };
  assert.deepStrictEqual(await conditionsOf(mock, mockArtifact), await conditionsOf(real, realArtifact));

  const realId = (await real.pushArtifact('form', realArtifact.id)).id;
  const mockId = (await mock.pushArtifact('form', mockArtifact.id)).id;
  const sameRoles = async (when) => assert.deepStrictEqual(await mock.getFormSecurityRoles(mockId), await real.getFormSecurityRoles(realId), when);
  await sameRoles('as created');
  assert.strictEqual((await real.getFormSecurityRoles(realId)).order, undefined, 'the bundle gives a created form no order');

  // Each write is applied to both: an order alone, a role list (which replaces everyone and keeps the order and the
  // fallback setting), attributes alone on a role list, everyone again, and `{}`, which removes the element.
  for (const write of [{ order: 0 }, { roleIds: [ROLE_A, ROLE_B] }, { order: 4, fallbackForm: false }, { everyone: true }, {}]) {
    await real.setFormSecurityRoles(realId, write);
    await mock.setFormSecurityRoles(mockId, write);
    await sameRoles(`after ${JSON.stringify(write)}`);
  }
  assert.strictEqual(await real.getFormSecurityRoles(realId), undefined, 'the element is gone');
  // With no element to attach them to, an order alone is refused by both.
  await assert.rejects(real.setFormSecurityRoles(realId, { order: 1 }), /no <DisplayConditions> to attach them to/);
  await assert.rejects(mock.setFormSecurityRoles(mockId, { order: 1 }), /no <DisplayConditions> to attach them to/);
});
