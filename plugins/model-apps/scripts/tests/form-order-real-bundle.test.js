'use strict';
// REAL BUNDLE: Main Form Set order is stored in a form's published formxml DisplayConditions. The
// build relies on the SDK preserving roles/fallback while changing only Order, and on refusing an
// order-only write when there is no DisplayConditions element to attach it to.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

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
// bag and replaces that node before the first push. This pins the SDK side of that: if the node moved or
// were rebuilt at push time, forms would silently be created at Order 0 again.
test('a new form carries <DisplayConditions Order="0"> in its root bag, and an edit to it before the first push is what the create writes', async () => {
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
  assert.deepStrictEqual(local.bag.c[at].node.a, [['Order', '0'], ['FallbackForm', 'true']]);
  assert.deepStrictEqual(local.bag.c[at].node.c.map((c) => c.n), ['Everyone']);

  const entry = JSON.parse(JSON.stringify(local.bag.c[at]));
  entry.node.a = entry.node.a.map(([n, v]) => (n === 'Order' ? [n, '7'] : [n, v]));
  await sdk.updateElement('form', art.id, `/bag/c/${at}`, entry);
  await sdk.pushArtifact('form', art.id);

  const create = posts.find((p) => /\/systemforms(\?|$)/.test(p.url));
  assert.ok(create, 'the form is created with one POST');
  const xml = String(create.body && create.body.formxml);
  assert.match(xml, /<DisplayConditions Order="7" FallbackForm="true"><Everyone \/><\/DisplayConditions>/);
  assert.strictEqual((xml.match(/<DisplayConditions\b/g) || []).length, 1, 'one element, not a second default one');
  assert.match(xml, /<header\b/, 'the rest of the form is written as the SDK built it');
});
