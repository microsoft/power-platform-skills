'use strict';
// Reconciliation must survive the real adapter's move indices, serialization and subsequent fetch,
// not merely agree with an in-memory SDK mock or a freshly compiled form.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../vendor/cds-maker-sdk.cjs');
const ai = require('../lib/artifact-intent.js');
const { runSdkBuild } = require('../lib/sdk-build.js');
const { verifySpec } = require('../lib/verify-spec.js');
const { readerFor } = require('../verify-model-app.js');

const guid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FORM_ID = guid(1);
const NOTES_CLASS_ID = '06375649-C143-495E-A496-C962E5B4488E';
const SUBGRID_CLASS_ID = 'E7A81278-8635-4D9E-8D4D-59480B391C5B';
const META = { new_name: 'String', new_code: 'String', new_notes: 'Memo', new_area: 'String' };
const clone = (v) => JSON.parse(JSON.stringify(v));
const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const specFor = () => ({
  $schemaVersion: '1.0',
  solution: { uniqueName: 'Reconcile', displayName: 'Reconcile', publisherPrefix: 'new' },
  app: { name: 'Reconcile', uniqueName: 'new_reconcile' },
  entities: [{ schemaName: 'new_ticket', displayName: 'Ticket', pluralName: 'Tickets', existing: true,
    primaryAttribute: { schemaName: 'new_name', displayName: 'Name' },
    columns: [
      { schemaName: 'new_code', displayName: 'Code', type: 'Text' },
      { schemaName: 'new_notes', displayName: 'Notes', type: 'Memo' },
      { schemaName: 'new_area', displayName: 'Area', type: 'Text' },
    ] }],
  forms: [{ entity: 'new_ticket', name: 'Main', notes: true, prune: false, tabs: [
    { name: 'tab_a', label: 'A', columns: [
      { width: '70%', sections: [
        { name: 'sec_dest', label: 'Destination', visible: false, showLabel: false, columns: 1, fields: ['new_name'] },
        { name: 'sec_src', label: 'Source', columns: 2, fields: ['new_code'] },
        { name: 'sec_extra', label: 'Extra', columns: 1, fields: ['new_notes'] },
      ] },
      { width: '30%', sections: [{ name: 'sec_right', label: 'Right', fields: [] }] },
    ] },
    { name: 'tab_b', label: 'B', expanded: false, sections: [
      { name: 'sec_b', label: 'B', fields: ['new_area'] },
    ] },
  ] }],
});

function existingTabs(spec) {
  const tabs = ai.compileFormIntent(spec, spec.forms[0], { notesClassId: NOTES_CLASS_ID }).tabs;
  const sections = tabs[0].columns[0].sections;
  const byName = (name) => sections.find((s) => s.name === name);
  const source = byName('sec_src');
  const destination = byName('sec_dest');
  const cell = destination.rows[0].cells[0];
  cell.colspan = 2;
  // Maker-set state has no authored flag to reassert on every apply, so it must travel with the
  // moved cell without obscuring the width/order no-op check with deliberate flag reassertions.
  cell.visible = false;
  cell.control.isReadOnly = true;
  source.rows.unshift({ cells: [cell] });
  destination.rows = [];
  const grid = ai.subgridSectionIntent({ subgridClassId: SUBGRID_CLASS_ID, targetEntity: 'new_task',
    relationshipName: 'new_ticket_tasks', viewId: guid(2), label: 'Tasks' });
  tabs[0].columns[0].sections = [source, grid, byName('sec_extra'), destination];
  // The timeline is deliberately outside the compiler's first tab. It belongs to the engine, not
  // to the authored container order, and must not be dragged back or recreated during reconciliation.
  tabs[1].columns[0].sections.push(byName('section_notes'));
  let next = 10;
  for (const tab of tabs) {
    tab.id = guid(next++);
    for (const col of tab.columns) for (const section of col.sections) {
      section.id = guid(next++);
      for (const row of section.rows) for (const c of row.cells) {
        c.id = guid(next++);
        if (c.control) c.control.id = guid(next++);
      }
    }
  }
  return tabs.reverse();
}

async function harness() {
  const store = { row: { formid: FORM_ID, name: 'Main', objecttypecode: 'new_ticket', type: 2, isdefault: true } };
  const writes = [];
  const reads = [];
  let revision = 1;
  const response = (body, status = 200) => ({ status, headers: { etag: `W/"${revision}"` }, body });
  const httpClient = {
    get: async (url) => {
      reads.push(url);
      const decoded = decodeURIComponent(url);
      if (/EntityDefinitions\(LogicalName='new_ticket'\)/.test(decoded)) {
        return response({ LogicalName: 'new_ticket', EntitySetName: 'new_tickets',
          Attributes: Object.entries(META).map(([LogicalName, AttributeType]) => ({ LogicalName, AttributeType })) });
      }
      if (/EntityDefinitions\(LogicalName='systemform'\)/.test(decoded)) return response({ EntitySetName: 'systemforms' });
      if (/systemforms\(/i.test(url)) {
        assert.ok(store.row.formxml, 'a fetch reads the previously serialized form');
        return response(clone(store.row));
      }
      if (/\/systemforms(?:\?|$)/i.test(url)) return response({ value: [clone(store.row)] });
      assert.fail(`unexpected GET: ${url}`);
    },
    post: async (url, body) => {
      writes.push({ method: 'post', url, body: clone(body) });
      if (/\/systemforms(?:\?|$)/i.test(url)) {
        assert.ok(!store.row.formxml, 'only the fixture may create a form; reconciliation must reuse it');
        store.row = { ...store.row, ...body, formid: FORM_ID };
        return { ...response({}, 204), headers: { 'odata-entityid': `https://contoso.crm.dynamics.com/api/data/v9.2/systemforms(${FORM_ID})` } };
      }
      if (/\/(?:PublishXml|AddSolutionComponent)(?:\?|$)/.test(url)) return response({}, 204);
      assert.fail(`unexpected POST: ${url}`);
    },
    patch: async (url, body) => {
      assert.match(url, /\/systemforms\(/i);
      writes.push({ method: 'patch', url, body: clone(body) });
      store.row = { ...store.row, ...body };
      revision += 1;
      return response({}, 204);
    },
    put: async (url) => assert.fail(`unexpected PUT: ${url}`),
    delete: async (url) => assert.fail(`unexpected DELETE: ${url}`),
  };
  const freshSdk = async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'form-reconcile-rt-'));
    dirs.push(dir);
    const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir),
      instanceUrl: 'https://contoso.crm.dynamics.com', httpClient });
    await sdk.initWorkspace();
    const mutations = [];
    // These wrappers record calls but delegate every operation to the real bundle. A fresh workspace
    // for each apply prevents an idempotency assertion from relying on the first apply's local cache.
    for (const method of ['createArtifact', 'addElement', 'updateElement', 'moveElement', 'removeElement', 'updateRecord', 'setFormSecurityRoles']) {
      const original = sdk[method].bind(sdk);
      sdk[method] = async (...args) => { mutations.push({ method, args: clone(args) }); return original(...args); };
    }
    return { sdk, mutations };
  };
  return { store, writes, reads, freshSdk };
}

const sectionsOf = (form) => form.tabs.flatMap((t) => t.columns.flatMap((c) => c.sections));
const sectionOf = (form, name) => sectionsOf(form).find((s) => s.name === name);
const cellsOf = (section) => section.rows.flatMap((r) => r.cells);
const identities = (form) => ({
  tabs: form.tabs.map((t) => [t.name, t.id]).sort(),
  sections: sectionsOf(form).map((s) => [s.name, s.id]).sort(),
  cells: sectionsOf(form).flatMap((s) => cellsOf(s).map((c) => [c.id, c.control && c.control.id])).sort(),
});

test('reconcile narrowed field and reordered containers survives serialize-fetch-verify', async () => {
  const spec = specFor();
  const { store, writes, reads, freshSdk } = await harness();
  const seed = await freshSdk();
  const art = await seed.sdk.createArtifact('form', { name: 'Main', entityLogicalName: 'new_ticket', formType: 'Main' });
  for (const tab of existingTabs(spec)) await seed.sdk.addElement('form', art.id, '/tabs', tab);
  await seed.sdk.removeElement('form', art.id, '/tabs/0');
  await seed.sdk.pushArtifact('form', art.id);
  const beforeXml = store.row.formxml;
  const first = await freshSdk();
  const before = clone(await first.sdk.fetchArtifact('form', FORM_ID));
  assert.deepStrictEqual(before.tabs.map((t) => t.name), ['tab_b', 'tab_a'], 'the deployed tabs really start out of order');
  const originalCell = cellsOf(sectionOf(before, 'sec_src')).find((c) => c.control.fieldName === 'new_name');
  assert.strictEqual(originalCell.colspan, 2, 'the deployed cell is wider than its destination');
  const beforeIds = identities(before);
  for (const entry of [...beforeIds.tabs, ...beforeIds.sections]) assert.ok(entry[1], `a container has a real identity: ${entry}`);
  for (const entry of beforeIds.cells) assert.ok(entry[0] && entry[1], `a cell and its control have real identities: ${entry}`);
  const start = writes.length;
  const warnings = [];
  const built = await runSdkBuild(spec, { sdk: first.sdk, apply: true, phases: ['forms'], warn: (m) => warnings.push(String(m)) });
  assert.strictEqual(built.ok, true);
  assert.strictEqual(built.created.forms.new_ticket, FORM_ID, 'the existing form is reused');
  assert.ok(writes.slice(start).some((w) => w.method === 'patch' && typeof w.body.formxml === 'string'),
    'the real reconciliation must push FormXML, not just mutate a local tree');
  for (const kind of ['tabs', 'sections', 'cells']) {
    assert.ok(first.mutations.some((m) => m.method === 'moveElement' && new RegExp(`/${kind}/\\d+$`).test(m.args[2])),
      `the real reconciliation moves existing ${kind}`);
  }
  const xml = store.row.formxml;
  assert.notStrictEqual(xml, beforeXml);

  const fetched = await freshSdk();
  const after = await fetched.sdk.fetchArtifact('form', FORM_ID);
  assert.deepStrictEqual(after.tabs.map((t) => t.name), ['tab_a', 'tab_b']);
  assert.deepStrictEqual(after.tabs[0].columns[0].sections.filter((s) => !s.name.startsWith('section_')).map((s) => s.name),
    ['sec_dest', 'sec_src', 'sec_extra'], 'the authored sections have their authored relative order');
  assert.deepStrictEqual(identities(after), identities(before), 'tabs, sections, cells and controls are moved, not recreated');
  const moved = cellsOf(sectionOf(after, 'sec_dest')).find((c) => c.control.fieldName === 'new_name');
  assert.ok(moved, 'the field is fetched in its destination section');
  assert.strictEqual(moved.id, originalCell.id);
  assert.strictEqual(moved.colspan, 1, 'an undeclared span is narrowed to the destination grid');
  assert.strictEqual(moved.visible, originalCell.visible, 'the move preserves maker-set visibility');
  assert.deepStrictEqual(moved.control, originalCell.control, 'the same control retains its maker-set state');
  for (const section of sectionsOf(after)) for (const row of section.rows) {
    assert.ok(row.cells.reduce((sum, c) => sum + (Number(c.colspan) || 1), 0) <= section.columns,
      `no row overflows section ${section.name}: ${JSON.stringify(row)}`);
  }
  for (const name of ['section_grid_new_ticket_tasks', 'section_notes']) {
    assert.deepStrictEqual(sectionOf(after, name), sectionOf(before, name), `${name} is untouched, including its control and identities`);
    const hostTab = (form) => form.tabs.find((t) => t.columns.some((c) => c.sections.some((s) => s.name === name))).id;
    assert.strictEqual(hostTab(after), hostTab(before), `${name} stays in its deployed tab`);
  }
  assert.strictEqual(warnings.filter((w) => /new_name.*spanned 2 columns/.test(w)).length, 1, 'the narrowing is reported once');

  const liveReader = readerFor(fetched.sdk, spec.app.uniqueName);
  const read = { findTable: async () => ({ logicalName: 'new_ticket' }),
    findColumns: async () => Object.keys(META).map((logicalName) => ({ logicalName })),
    sitemapXml: async () => '', queryRecords: liveReader.queryRecords, formTopology: liveReader.formTopology };
  const verified = await verifySpec(spec, read);
  assert.ok(verified.checks.some((c) => c.kind === 'form-topology'), 'verification actually checks the layout');
  assert.strictEqual(verified.ok, true, JSON.stringify(verified.missing));
  assert.ok(reads.some((url) => /systemforms.*formxml/i.test(decodeURIComponent(url))), 'the real reader queries the recorded server XML');

  const controlAt = xml.search(/<control\b[^>]*\bdatafieldname="new_name"/);
  assert.ok(controlAt > 0);
  const cellAt = xml.lastIndexOf('<cell', controlAt);
  const cellEnd = xml.indexOf('>', cellAt) + 1;
  const wide = xml.slice(cellAt, cellEnd).replace(/colspan="1"/, 'colspan="2"');
  store.row.formxml = xml.slice(0, cellAt) + wide + xml.slice(cellEnd);
  assert.notStrictEqual(store.row.formxml, xml, 'the negative control changes only the moved cell width');
  const rejected = await verifySpec(spec, read);
  assert.strictEqual(rejected.ok, false, 'an overflowing serialized form must not verify');
  assert.match(rejected.checks.find((c) => c.kind === 'form-topology').detail,
    /section 'sec_dest' row 1 carries 2 columns of content in a 1-column section/);
  store.row.formxml = xml;

  const second = await freshSdk();
  const again = await runSdkBuild(spec, { sdk: second.sdk, apply: true, phases: ['forms'], warn: (m) => warnings.push(String(m)) });
  assert.strictEqual(again.ok, true);
  assert.deepStrictEqual(second.mutations, [], 'a second apply of the fetched serialized form makes no form mutation');
  assert.strictEqual(store.row.formxml, xml, 'the serialized form is stable across the second apply');
  assert.strictEqual(warnings.filter((w) => /new_name.*spanned 2 columns/.test(w)).length, 1, 'the second apply reports no further narrowing');
});
