'use strict';
// REAL-BUNDLE integration tests for the hardening-2 migration. These drive the re-vendored SDK
// (scripts/vendor/cds-maker-sdk.cjs) through the pure intent compiler + the generic mutation surface
// exactly as the build engine does (createFormShell: minimal createArtifact -> addElement whole tabs
// -> drop the seed tab; sub-grids/quick-views as control cells; events at /bag/c), capturing the real
// serialized wire payloads. The mock-based sdk-build.test.js covers the ENGINE orchestration; these
// lock the COMPILER<->ADAPTER contract that the mock cannot (real formxml, adapter defaulting, 412).
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');
const ai = require('../lib/artifact-intent.js');
const { formFacts } = require('./wire-facts.js');

const SUBGRID_CLASS_ID = 'E7A81278-8635-4D9E-8D4D-59480B391C5B';
const NOTES_CLASS_ID = '06375649-C143-495E-A496-C962E5B4488E';

const tempDirs = [];
test.after(() => { for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true }); });

// A real SDK bound to a capturing httpClient. `meta` maps a logical entity name -> attribute-type map
// so the adapter's push-time metadata defaulting (T4) resolves a field's control classId.
async function freshSdk(capture, meta) {
  const { createMakerSdk, createNodeWorkspaceStorage } = require(BUNDLE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h2-real-'));
  tempDirs.push(dir);
  const httpClient = {
    get: async (url) => {
      // EntityDefinitions attribute metadata lookup (drives classId/label defaulting on push).
      const m = /EntityDefinitions\(LogicalName='([^']+)'\)/.exec(url);
      if (m && meta && meta[m[1]]) {
        const attrs = Object.entries(meta[m[1]]).map(([logicalName, AttributeType]) => ({ LogicalName: logicalName, AttributeType }));
        return { status: 200, headers: {}, body: { LogicalName: m[1], EntitySetName: `${m[1]}s`, Attributes: attrs } };
      }
      return { status: 200, headers: {}, body: {} };
    },
    post: async (url, body) => { if (capture) capture.push({ url, body }); return { status: 204, headers: { 'odata-entityid': 'https://x/y(11111111-1111-1111-1111-111111111111)' }, body: {} }; },
    patch: async (url, body) => { if (capture) capture.push({ url, body }); return { status: 204, headers: {}, body: {} }; },
    delete: async () => ({ status: 204, headers: {}, body: {} }),
    put: async () => ({ status: 204, headers: {}, body: {} }),
  };
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: 'https://example.crm.dynamics.com', httpClient });
  await sdk.initWorkspace();
  return sdk;
}

// Mirror the engine's createFormShell sequence: minimal create, append each compiled tab (ids minted
// by addElement), drop the seed tab. Returns the form id.
async function buildFormShell(sdk, intent) {
  const art = await sdk.createArtifact('form', { name: intent.name, entityLogicalName: intent.entityLogicalName, formType: intent.formType, status: intent.status });
  for (const tab of intent.tabs) await sdk.addElement('form', art.id, '/tabs', tab);
  await sdk.removeElement('form', art.id, '/tabs/0');
  return art.id;
}

const custSpec = {
  solution: { publisherPrefix: 'new' },
  entities: [{ schemaName: 'new_customer', displayName: 'Customer', primaryAttribute: { schemaName: 'new_name', displayName: 'Name' },
    columns: [{ schemaName: 'new_tier', displayName: 'Tier', type: 'Choice', options: ['Free', 'Pro'] }], hasNotes: true }],
  relationships: [{ type: 'OneToMany', referenced: 'new_customer', referencing: 'new_ticket', lookup: { schemaName: 'new_CustomerId', displayName: 'Customer' } }],
  forms: [{ entity: 'new_customer', name: 'Customer', layout: 'auto', notes: true }],
};

test('PARITY: the rewired form path reproduces the pre-swap golden facts (fields, order, required, notes)', async () => {
  const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'parity-golden.json'), 'utf8')).form;
  const cap = [];
  const sdk = await freshSdk(cap);
  const intent = ai.compileFormIntent(custSpec, custSpec.forms[0], { notesClassId: NOTES_CLASS_ID });
  const id = await buildFormShell(sdk, intent);
  await sdk.pushArtifact('form', id);
  const formxml = (cap.find((c) => /systemforms/.test(c.url)) || {}).body.formxml;
  const facts = formFacts(formxml);
  assert.deepStrictEqual(facts.fields, golden.fields, 'field set + order + required flags match the pre-swap engine');
  assert.strictEqual(facts.notesControl, golden.notesControl, 'the Notes/timeline control is present as before');
});

test('multi-tab / multi-section explicit layout serializes every tab, section and field', async () => {
  const spec = {
    entities: [{ schemaName: 'new_customer', primaryAttribute: { schemaName: 'new_name', displayName: 'Name' },
      columns: [{ schemaName: 'new_a', type: 'Text' }, { schemaName: 'new_b', type: 'Text' }, { schemaName: 'new_c', type: 'Text' }] }],
    forms: [{ entity: 'new_customer', name: 'M', tabs: [
      { label: 'General', sections: [{ label: 'Names', columns: 2, fields: ['new_name', 'new_a'] }] },
      { label: 'Details', sections: [{ label: 'More', columns: 1, fields: ['new_b'] }, { label: 'Extra', columns: 1, fields: ['new_c'] }] },
    ] }],
  };
  const cap = [];
  const sdk = await freshSdk(cap);
  const intent = ai.compileFormIntent(spec, spec.forms[0], { notesClassId: NOTES_CLASS_ID });
  assert.strictEqual(intent.tabs.length, 2, 'two tabs compiled');
  const id = await buildFormShell(sdk, intent);
  await sdk.pushArtifact('form', id);
  const formxml = String((cap.find((c) => /systemforms/.test(c.url)) || {}).body.formxml);
  for (const f of ['new_name', 'new_a', 'new_b', 'new_c']) assert.match(formxml, new RegExp(`datafieldname="${f}"`), `${f} present in formxml`);
  // Every <column> MUST carry the required `width` attribute or live Dataverse rejects the form
  // ("required attribute 'width' is missing"). The plugin sets width explicitly AND (hardening-3) the
  // SDK's normalizeColumn now also defaults a synthesized column's width to 100% — see the dedicated
  // SDK-default test below. The fake httpClient does not schema-validate, so this assertion is the guard.
  assert.ok((formxml.match(/<column\b[^>]*>/g) || []).length > 0, 'formxml has columns');
  assert.ok(!/<column\b(?![^>]*\bwidth=)/.test(formxml), 'every <column> carries a width attribute');
  assert.match(formxml, /Title="General"|<label description="General"/, 'General tab labelled');
  assert.match(formxml, /Details|<label description="Details"/, 'Details tab present');
});

test('#8 authored column width: a synthesized form column with NO explicit width serializes as width="100%" (hardening-3 SDK safety net)', async () => {
  // hardening-3 SDK: FormAdapter.normalizeColumn defaults an AUTHORED (fully-synthesized bag) column's
  // width to '100%' when it is undefined, so a widthless authored column can never emit invalid formxml.
  // The plugin still sets width explicitly for exact control, so STRIP it here to prove the SDK safety
  // net works independently — a re-vendor that drops this default would regress the reconcile-add path
  // (a field added to a fetched form without an explicit width) into broken formxml.
  const spec = {
    entities: [{ schemaName: 'new_customer', primaryAttribute: { schemaName: 'new_name', displayName: 'Name' },
      columns: [{ schemaName: 'new_a', type: 'Text' }] }],
    forms: [{ entity: 'new_customer', name: 'W', tabs: [
      { label: 'General', sections: [{ label: 'Names', columns: 1, fields: ['new_name', 'new_a'] }] },
    ] }],
  };
  const cap = [];
  const sdk = await freshSdk(cap);
  const intent = ai.compileFormIntent(spec, spec.forms[0], { notesClassId: NOTES_CLASS_ID });
  // Remove the plugin-set width from every tab column so ONLY the SDK default can supply it.
  for (const tab of intent.tabs) for (const col of (tab.columns || [])) delete col.width;
  const id = await buildFormShell(sdk, intent);
  await sdk.pushArtifact('form', id);
  const formxml = String((cap.find((c) => /systemforms/.test(c.url)) || {}).body.formxml);
  assert.ok((formxml.match(/<column\b[^>]*>/g) || []).length > 0, 'formxml has columns');
  assert.ok(!/<column\b(?![^>]*\bwidth=)/.test(formxml), 'every <column> still carries a width (the SDK defaulted it)');
  assert.match(formxml, /<column\b[^>]*width="100%"/, 'the SDK-defaulted width is 100%');
});

test('metadata-derived control types: passing only fieldName lets the adapter classId a Lookup vs a text field (T4)', async () => {
  // The adapter fetches attribute metadata on push and derives each bound field's control classId from
  // its Dataverse AttributeType — the plugin never precomputes classId. Stub two attribute types.
  const meta = { new_customer: { new_name: 'String', new_ownerid: 'Lookup' } };
  const spec = { entities: [{ schemaName: 'new_customer', primaryAttribute: { schemaName: 'new_name', displayName: 'Name' }, columns: [] }],
    forms: [{ entity: 'new_customer', name: 'M', tabs: [{ label: 'G', sections: [{ label: 'S', columns: 1, fields: ['new_name', 'new_ownerid'] }] }] }] };
  const cap = [];
  const sdk = await freshSdk(cap, meta);
  const intent = ai.compileFormIntent(spec, spec.forms[0], {});
  const id = await buildFormShell(sdk, intent);
  await sdk.pushArtifact('form', id);
  const formxml = String((cap.find((c) => /systemforms/.test(c.url)) || {}).body.formxml);
  // Lookup control classid (0d2c745a-…) differs from the single-line text control — the adapter picked
  // it purely from AttributeType 'Lookup'. We assert the two fields do NOT share one classid.
  const classOf = (field) => (new RegExp(`datafieldname="${field}"[^>]*classid="\\{?([0-9a-fA-F-]+)`).exec(formxml) || new RegExp(`classid="\\{?([0-9a-fA-F-]+)[^>]*datafieldname="${field}"`).exec(formxml) || [])[1];
  const nameCls = classOf('new_name');
  const lookupCls = classOf('new_ownerid');
  assert.ok(nameCls, 'the text field has an adapter-defaulted classid');
  assert.ok(lookupCls, 'the lookup field has an adapter-defaulted classid');
  assert.notStrictEqual(String(nameCls).toUpperCase(), String(lookupCls).toUpperCase(), 'Lookup vs String get DIFFERENT control classids (metadata-derived, not plugin-fixed)');
});

test('#5 sub-grid is added as its OWN full-width section and serializes relationship, target, view id + title', async () => {
  const cap = [];
  const sdk = await freshSdk(cap);
  const intent = ai.compileFormIntent(custSpec, custSpec.forms[0], { notesClassId: NOTES_CLASS_ID });
  const id = await buildFormShell(sdk, intent);
  // The engine now appends a whole sub-grid SECTION to a column's /sections (not a cell into an
  // existing field section's rows) — exercise that real path through the vendored serializer.
  const secPtr = ai.firstColumnSectionsPointer(await sdk.getArtifact('form', id));
  await sdk.addElement('form', id, secPtr, ai.subgridSectionIntent({ subgridClassId: SUBGRID_CLASS_ID, targetEntity: 'new_ticket', relationshipName: 'new_customer_new_ticket', viewId: '{00000000-0000-0000-0000-0000000000v1}', label: 'Tickets' }));
  await sdk.pushArtifact('form', id);
  const formxml = String((cap.find((c) => /systemforms/.test(c.url)) || {}).body.formxml);
  assert.match(formxml, /new_customer_new_ticket/, 'RelationshipName is serialized');
  assert.match(formxml, /new_ticket/, 'target entity is serialized');
  assert.ok(formxml.toUpperCase().includes(SUBGRID_CLASS_ID), 'the sub-grid control classid is serialized');
  assert.match(formxml, /Tickets/, 'the section/grid title (child display name) is serialized');
});

test('events author + MERGE at /bag/c: appending to an existing <events> region adds a second handler without a duplicate root', async () => {
  const cap = [];
  const sdk = await freshSdk(cap);
  const intent = ai.compileFormIntent(custSpec, custSpec.forms[0], { notesClassId: NOTES_CLASS_ID });
  const id = await buildFormShell(sdk, intent);
  // First handler -> new region.
  let bagC = ((await sdk.getArtifact('form', id)).bag.c) || [];
  const nextI = bagC.reduce((m, e) => Math.max(m, e.i), -1) + 1;
  await sdk.addElement('form', id, '/bag/c', { i: nextI, node: ai.formEventsRegionIntent([{ event: 'onload', library: 'a.js', function: 'A.onLoad' }]) });
  // Second handler -> append to the SAME region's children (the merge path the engine uses on rebuild).
  bagC = (await sdk.getArtifact('form', id)).bag.c;
  const regionIdx = bagC.findIndex((e) => e.node && e.node.n === 'events');
  await sdk.addElement('form', id, `/bag/c/${regionIdx}/node/c`, ai.formEventsRegionIntent([{ event: 'onsave', library: 'a.js', function: 'A.onSave' }]).c[0]);
  await sdk.pushArtifact('form', id);
  const formxml = String((cap.find((c) => /systemforms/.test(c.url)) || {}).body.formxml);
  assert.match(formxml, /A\.onLoad/, 'first handler serialized');
  assert.match(formxml, /A\.onSave/, 'second handler serialized');
  assert.strictEqual((formxml.match(/<events\b/g) || []).length, 1, 'exactly ONE <events> root (merged, not duplicated)');
});

test('field removal: removeElement on the cell pointer drops the field from the pushed formxml', async () => {
  const cap = [];
  const sdk = await freshSdk(cap);
  const intent = ai.compileFormIntent(custSpec, custSpec.forms[0], { notesClassId: NOTES_CLASS_ID });
  const id = await buildFormShell(sdk, intent);
  const ptr = ai.findFieldCellPointer(await sdk.getArtifact('form', id), 'new_tier');
  assert.ok(ptr, 'the new_tier cell is located');
  await sdk.removeElement('form', id, ptr);
  await sdk.pushArtifact('form', id);
  const formxml = String((cap.find((c) => /systemforms/.test(c.url)) || {}).body.formxml);
  assert.match(formxml, /datafieldname="new_name"/, 'primary field kept');
  assert.ok(!/datafieldname="new_tier"/.test(formxml), 'removed field is gone');
});

test('412 conflict: pushArtifact resolves to { success:false, error } (the signal requireSuccessfulPush halts on)', async () => {
  const { createMakerSdk, createNodeWorkspaceStorage } = require(BUNDLE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h2-412-'));
  tempDirs.push(dir);
  const FID = '22222222-2222-2222-2222-222222222222';
  const formXml = '<form><tabs><tab name="g"><columns><column><sections><section><rows/></section></sections></column></columns></tab></tabs></form>';
  const httpClient = {
    get: async () => ({ status: 200, headers: { etag: 'W/"1"' }, body: { formid: FID, name: 'F', type: 2, objecttypecode: 'account', formxml: formXml } }),
    post: async () => ({ status: 204, headers: {}, body: {} }),
    patch: async () => ({ status: 412, headers: {}, body: { error: { message: 'precondition failed' } } }),
    delete: async () => ({ status: 204, headers: {}, body: {} }),
    put: async () => ({ status: 204, headers: {}, body: {} }),
  };
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: 'https://example.crm.dynamics.com', httpClient });
  await sdk.initWorkspace();
  await sdk.fetchArtifact('form', FID);
  await sdk.updateElement('form', FID, '/tabs/0', { expanded: false });
  const result = await sdk.pushArtifact('form', FID);
  // `saved` is the renamed `success`; accept either so this pins the contract, not the bundle.
  assert.strictEqual(result.saved !== undefined ? result.saved : result.success, false, 'a 412 is signalled by a failed PushResult, NOT a thrown error');
  assert.ok(result.error, 'the conflict carries an error the engine reports');
});

// ---------------------------------------------------------------------------
// TOPOLOGY primitives (#575). The engine converges an existing form onto an explicit layout by
// appending tabs/columns/sections, patching a section in place and moving cells between sections.
// sdk-build.test.js covers the ORCHESTRATION against a mock; these lock the four SDK behaviors
// that orchestration assumes, against the REAL bundle -- a mock proves only self-consistency.
// ---------------------------------------------------------------------------

const secIntent = (name, label, columns, cells) => ({ name, label, visible: true, showLabel: true, columns, rows: cells.length ? [{ cells }] : [] });
const fcell = (fn) => ({ control: { fieldName: fn, isRequired: false } });
const META3 = { new_customer: { new_name: 'String', new_tier: 'Picklist', new_note: 'Memo', new_amt: 'Money' } };

async function seedTwoSectionForm(sdk) {
  const art = await sdk.createArtifact('form', { name: 'T', entityLogicalName: 'new_customer', formType: 'Main' });
  await sdk.addElement('form', art.id, '/tabs', { name: 'tab_general', label: 'General', expanded: true, visible: true,
    columns: [{ width: '100%', sections: [
      secIntent('section_general', 'General', 1, [fcell('new_name'), fcell('new_tier')]),
      secIntent('section_more', 'More', 1, []),
    ] }] });
  await sdk.removeElement('form', art.id, '/tabs/0');
  return art.id;
}

test('REAL BUNDLE topology: an existing form gains a tab and a section, and a section widens in place', async () => {
  const sdk = await freshSdk(null, META3);
  const id = await seedTwoSectionForm(sdk);
  await sdk.addElement('form', id, '/tabs', { name: 'tab_audit', label: 'Audit', expanded: true, visible: true,
    columns: [{ width: '100%', sections: [secIntent('section_audit', 'Audit', 2, [])] }] });
  await sdk.addElement('form', id, '/tabs/0/columns/0/sections', secIntent('section_added', 'Added', 2, []));
  await sdk.updateElement('form', id, '/tabs/0/columns/0/sections/0', { columns: 2 });
  const form = await sdk.getArtifact('form', id);
  assert.deepStrictEqual((form.tabs || []).map((x) => x.name), ['tab_general', 'tab_audit'], 'the tab is appended, not replaced');
  const sections = form.tabs[0].columns[0].sections;
  assert.deepStrictEqual(sections.map((s) => s.name), ['section_general', 'section_more', 'section_added']);
  assert.strictEqual(sections[0].columns, 2, 'an EXISTING section is widened in place');
  assert.strictEqual((sections[0].rows || []).length, 1, 'and keeps its rows -- updateElement MERGES');
});

test('REAL BUNDLE topology: a field cell moves between sections and serializes under the new one', async () => {
  const cap = [];
  const sdk = await freshSdk(cap, META3);
  const id = await seedTwoSectionForm(sdk);
  // section_more is deployed EMPTY, so a row must be seeded before a cell can move into it.
  await sdk.addElement('form', id, '/tabs/0/columns/0/sections/1/rows', { cells: [] });
  let form = await sdk.getArtifact('form', id);
  const from = ai.findFieldCellLocation(form, 'new_tier');
  assert.strictEqual(from.sectionPointer, '/tabs/0/columns/0/sections/0', 'precondition: it starts in section_general');
  await sdk.moveElement('form', id, from.cellPointer, '/tabs/0/columns/0/sections/1/rows/0/cells', { index: 0 });
  form = await sdk.getArtifact('form', id);
  assert.strictEqual(ai.findFieldCellLocation(form, 'new_tier').sectionPointer, '/tabs/0/columns/0/sections/1', 'it now lives in section_more');
  assert.strictEqual(ai.findFieldCellLocation(form, 'new_name').sectionPointer, '/tabs/0/columns/0/sections/0', 'and its neighbour did not follow it');
  const res = await sdk.pushArtifact('form', id);
  assert.notStrictEqual(res && res.success, false, 'the restructured form still pushes');
  const formxml = (cap.find((c) => /systemforms/.test(c.url)) || {}).body.formxml;
  const more = /<section[^>]*name="section_more"[\s\S]*?<\/section>/.exec(formxml);
  assert.ok(more && /datafieldname="new_tier"/.test(more[0]), 'new_tier serializes INSIDE section_more');
});

test('REAL BUNDLE layout: multi-column tabs and cell spans reach the serialized formxml', async () => {
  const cap = [];
  const sdk = await freshSdk(cap, META3);
  const art = await sdk.createArtifact('form', { name: 'W', entityLogicalName: 'new_customer', formType: 'Main' });
  await sdk.addElement('form', art.id, '/tabs', { name: 'tab_w', label: 'W', expanded: true, visible: true, columns: [
    { width: '60%', sections: [secIntent('sec_l', 'L', 2, [Object.assign(fcell('new_name'), { colspan: 2 }), fcell('new_tier')])] },
    { width: '40%', sections: [secIntent('sec_r', 'R', 1, [Object.assign(fcell('new_note'), { rowspan: 2 })])] },
  ] });
  await sdk.removeElement('form', art.id, '/tabs/0');
  await sdk.pushArtifact('form', art.id);
  const formxml = (cap.find((c) => /systemforms/.test(c.url)) || {}).body.formxml;
  assert.ok(/<column width="60%">/.test(formxml) && /<column width="40%">/.test(formxml), 'both form-columns carry their authored width');
  // The SDK encodes an N-column section as N repeated "1"s, so columns:2 serializes as columns="11".
  assert.ok(/name="sec_l"[^>]*columns="11"/.test(formxml), 'a 2-column section serializes as columns="11"');
  const nameCell = /<cell[^>]*colspan="2"[^>]*>[\s\S]*?datafieldname="new_name"/.exec(formxml);
  assert.ok(nameCell, 'an authored colspan reaches the cell attribute');
  assert.ok(/<cell[^>]*rowspan="2"[^>]*>[\s\S]*?datafieldname="new_note"/.test(formxml), 'an authored rowspan reaches the cell attribute');
});

// ---------------------------------------------------------------------------
// UNKNOWN FORM KEYS. The SDK now REFUSES a tab/section property it does not recognise instead of
// dropping it at serialization. `validateFormLayoutKeys` (app-spec.js) rejects the same keys at
// author time, and the two are deliberately kept BOTH: the spec gate fails before any workspace or
// network call and names the real mechanism, while this upstream check is the backstop for anything
// that reaches the SDK by another route.
//
// Pinned here because the refusal lives in the VENDORED BUNDLE: a re-vendor that lost it would
// silently reopen the silent-drop hole, and every spec-level test would still pass.
// ---------------------------------------------------------------------------

test('REAL BUNDLE: an unrecognised tab or section property is refused, not silently dropped', async () => {
  const baseSection = { name: 's0', label: 'S', visible: true, showLabel: true, columns: 1, rows: [] };
  const attempt = async (tabExtra, sectionExtra) => {
    const sdk = await freshSdk(null, META3);
    const art = await sdk.createArtifact('form', { name: 'K', entityLogicalName: 'new_customer', formType: 'Main' });
    try {
      await sdk.addElement('form', art.id, '/tabs', Object.assign(
        { name: 't0', label: 'T', visible: true, columns: [{ width: '100%', sections: [Object.assign({}, baseSection, sectionExtra)] }] },
        tabExtra));
      return null;
    } catch (e) { return String(e && e.message); }
  };

  // The four keys app-spec.js names in FORM_LAYOUT_KEY_HINTS, i.e. the ones an author actually
  // reaches for. Each must be refused rather than accepted-and-dropped.
  for (const [what, tabExtra, sectionExtra] of [
    ['tab showLabel', { showLabel: false }, null],
    ['tab labelPosition', { labelPosition: 'top' }, null],
    ['section labelPosition', null, { labelPosition: 'top' }],
    ['section locked', null, { locked: true }],
  ]) {
    const err = await attempt(tabExtra, sectionExtra);
    assert.ok(err, `${what}: the SDK must refuse it, not accept and drop it`);
    assert.match(err, /not a (tab|section) property/, `${what}: refusal should name the offending property — got ${err}`);
  }

  // And the converse, which is what keeps the plugin's allow-list from being over-restrictive: every
  // key the compiler actually emits is still accepted.
  assert.strictEqual(await attempt({ expanded: true }, { columns: 2 }), null,
    'the properties the compiler emits must remain accepted');
});
// --- The real SDK's addElement POSITION contract -------------------------------------------------
// The row re-pack that follows a span widening inserts a row immediately below the widened one. It
// does that with `addElement(..., { position: { index } })`, and the SDK resolves position as
// `undefined | 'end' | 'start' | { index } | { before } | { after } ` — testing `'index' in position`.
//
// A BARE NUMBER therefore throws, and the test mock originally accepted one: the whole suite passed
// green while every real insertion failed with "Cannot use 'in' operator to search for 'index' in 1".
// Only the real bundle can hold this contract honest, so it is pinned here.
test('real SDK: addElement inserts at { position: { index } } and REJECTS a bare number', async () => {
  const sdk = await freshSdk(null, null);
  const art = await sdk.createArtifact('form', {
    name: 'PositionContract', entityLogicalName: 'new_customer', formType: 'Main', status: 'Draft',
  });
  await sdk.addElement('form', art.id, '/tabs', {
    name: 'tab_general', label: 'General', expanded: true, visible: true,
    columns: [{ width: '100%', sections: [{ name: 'section_general', label: 'General', visible: true, showLabel: true, columns: 2,
      rows: [{ cells: [{ control: { fieldName: 'new_name' } }] }, { cells: [{ control: { fieldName: 'new_tier' } }] }] }] }],
  });
  await sdk.removeElement('form', art.id, '/tabs/0');
  const rowsPtr = '/tabs/0/columns/0/sections/0/rows';

  // Insert BETWEEN the two existing rows — the case the re-pack depends on.
  await sdk.addElement('form', art.id, rowsPtr, { cells: [] }, { position: { index: 1 } });
  let form = await sdk.getArtifact('form', art.id);
  let rows = form.tabs[0].columns[0].sections[0].rows;
  assert.strictEqual(rows.length, 3, 'a row was inserted');
  assert.strictEqual((rows[0].cells[0].control || {}).fieldName, 'new_name');
  assert.strictEqual((rows[1].cells || []).length, 0, 'the NEW row lands at index 1, between the two');
  assert.strictEqual((rows[2].cells[0].control || {}).fieldName, 'new_tier');

  // The contract the mock got wrong: a bare number is not a position. Written as an explicit
  // try/catch with a real `await` so the repo's "every SDK call is awaited" guard still sees it —
  // an `assert.rejects(() => sdk...)` thunk hides the call from that check.
  let threw = null;
  try {
    await sdk.addElement('form', art.id, rowsPtr, { cells: [] }, { position: 1 });
  } catch (e) { threw = e; }
  assert.ok(threw && /index/.test(String(threw.message)),
    `a bare numeric position must be rejected, not silently appended; got ${threw && threw.message}`);

  // Omitting position still appends, which is what every other call site relies on.
  await sdk.addElement('form', art.id, rowsPtr, { cells: [] });
  form = await sdk.getArtifact('form', art.id);
  rows = form.tabs[0].columns[0].sections[0].rows;
  assert.strictEqual(rows.length, 4, 'an omitted position appends');
  assert.strictEqual((rows[3].cells || []).length, 0);
});
