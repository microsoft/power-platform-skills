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
const META = { new_name: 'String', new_code: 'String', new_notes: 'Memo', new_area: 'String', new_extra: 'String' };
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
  const freshSdk = async (workspaceDir) => {
    const dir = workspaceDir || fs.mkdtempSync(path.join(os.tmpdir(), 'form-reconcile-rt-'));
    if (!workspaceDir) dirs.push(dir);
    const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir),
      instanceUrl: 'https://contoso.crm.dynamics.com', httpClient });
    await sdk.initWorkspace();
    const mutations = [];
    // These wrappers record calls but delegate every operation to the real bundle. A fresh workspace
    // for each apply prevents an idempotency assertion from relying on the first apply's local cache.
    for (const method of ['createArtifact', 'addElement', 'updateElement', 'moveElement', 'removeElement', 'updateRecord', 'setFormSecurityRoles']) {
      const original = sdk[method].bind(sdk);
      sdk[method] = async (...args) => {
        const mutation = { method, args: clone(args) };
        mutations.push(mutation);
        const result = await original(...args);
        if (args[0] === 'form' && ['addElement', 'updateElement', 'moveElement', 'removeElement'].includes(method)) {
          mutation.snapshot = clone(await sdk.getArtifact('form', args[1]));
        }
        return result;
      };
    }
    return { sdk, mutations, dir };
  };
  return { store, writes, reads, freshSdk };
}

async function positionFixture({ fields = ['new_area', 'new_name'], fieldOptions = { new_code: { after: 'new_area' } },
  rows = [['new_area', 'new_name'], ['new_code']], columns = 2, sourceRows = null } = {}) {
  const spec = specFor();
  spec.entities[0].columns.push({ schemaName: 'new_extra', displayName: 'Extra', type: 'Text' });
  spec.forms = [{
    entity: 'new_ticket', name: 'Main', prune: false,
    tabs: [{ name: 'main', sections: [
      { name: 'fields', columns, fields },
      ...(sourceRows ? [{ name: 'source', columns: 2, fields: ['new_notes'] }] : []),
    ] }], fieldOptions,
  }];
  const h = await harness();
  const seed = await h.freshSdk();
  const art = await seed.sdk.createArtifact('form', { name: 'Main', entityLogicalName: 'new_ticket', formType: 'Main' });
  const tabs = ai.compileFormIntent(spec, spec.forms[0]).tabs;
  const cells = (list) => list.map((entry) => typeof entry === 'string'
    ? ai.fieldCellIntent(entry) : ai.fieldCellIntent(entry.name, entry));
  tabs[0].columns[0].sections[0].rows = rows.map((list) => ({ cells: cells(list) }));
  if (sourceRows) tabs[0].columns[0].sections[1].rows = sourceRows.map((list) => ({ cells: cells(list) }));
  for (const tab of tabs) await seed.sdk.addElement('form', art.id, '/tabs', tab);
  await seed.sdk.removeElement('form', art.id, '/tabs/0');
  await seed.sdk.pushArtifact('form', art.id);
  return { ...h, spec };
}

const layoutMutation = ({ method, args }) => args[0] === 'form'
  && ['addElement', 'updateElement', 'moveElement', 'removeElement'].includes(method);
const namesIn = (form, name = 'fields') => sectionOf(form, name).rows.map((r) => r.cells.map((c) => c.control.fieldName));
function assertUniqueIdentities(form) {
  const cells = sectionsOf(form).flatMap(cellsOf);
  for (const values of [cells.map((c) => c.id), cells.map((c) => c.control && c.control.id)]) {
    const ids = values.filter(Boolean).map((id) => String(id).replace(/[{}]/g, '').toLowerCase());
    assert.strictEqual(new Set(ids).size, ids.length, 'each cell/control identity occurs only once');
  }
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

for (const newField of [false, true]) {
  test(`${newField ? 'new listed middle field' : 'after into a full row'} survives real SDK serialize-fetch-verify and a fresh second apply`, async () => {
    const spec = specFor();
    spec.forms = [{
      entity: 'new_ticket', name: 'Main', prune: false,
      tabs: [{ name: 'main', sections: [{
        name: 'fields', columns: 2, fields: newField ? ['new_area', 'new_code', 'new_name'] : ['new_area', 'new_name'],
      }] }],
      ...(newField ? {} : { fieldOptions: { new_code: { after: 'new_area' } } }),
    }];
    const { store, freshSdk } = await harness();
    const seed = await freshSdk();
    const art = await seed.sdk.createArtifact('form', { name: 'Main', entityLogicalName: 'new_ticket', formType: 'Main' });
    const tabs = ai.compileFormIntent(spec, spec.forms[0]).tabs;
    const section = tabs[0].columns[0].sections[0];
    section.rows = [{ cells: [ai.fieldCellIntent('new_area'), ai.fieldCellIntent('new_name')] }];
    if (!newField) section.rows.push({ cells: [ai.fieldCellIntent('new_code', { readOnly: true, hidden: true })] });
    for (const tab of tabs) await seed.sdk.addElement('form', art.id, '/tabs', tab);
    await seed.sdk.removeElement('form', art.id, '/tabs/0');
    await seed.sdk.pushArtifact('form', art.id);

    const first = await freshSdk();
    const before = clone(await first.sdk.fetchArtifact('form', FORM_ID));
    const beforeCells = cellsOf(sectionOf(before, 'fields'));
    const built = await runSdkBuild(spec, { sdk: first.sdk, apply: true, phases: ['forms'] });
    assert.strictEqual(built.ok, true);
    const layoutWrites = first.mutations.filter(layoutMutation);
    assert.strictEqual(layoutWrites.length, 1, 'the real reconciliation must atomically replace the complete planned rows');
    assert.strictEqual(layoutWrites[0].method, 'updateElement');
    assert.match(layoutWrites[0].args[2], /\/rows$/);

    const fetched = await freshSdk();
    const after = await fetched.sdk.fetchArtifact('form', FORM_ID);
    const afterSection = sectionOf(after, 'fields');
    assert.deepStrictEqual(afterSection.rows.map((r) => r.cells.map((c) => c.control.fieldName)),
      [['new_area', 'new_code'], ['new_name']], 'the serialized row split preserves flat adjacency');
    const { fitsGrid } = require('../lib/form-occupancy.js');
    assert.strictEqual(fitsGrid(afterSection.rows, afterSection.columns), true);
    for (const beforeCell of beforeCells) {
      const actual = cellsOf(afterSection).find((c) => c.control.fieldName === beforeCell.control.fieldName);
      assert.strictEqual(actual.id, beforeCell.id, 'the existing cell identity survives serialization');
      assert.deepStrictEqual(actual.control, beforeCell.control, 'the existing control identity and maker-set state survive');
      assert.strictEqual(actual.visible, beforeCell.visible);
    }
    const liveReader = readerFor(fetched.sdk, spec.app.uniqueName);
    const read = {
      findTable: async () => ({ logicalName: 'new_ticket' }),
      findColumns: async () => Object.keys(META).map((logicalName) => ({ logicalName })),
      sitemapXml: async () => '', queryRecords: liveReader.queryRecords, formTopology: liveReader.formTopology,
    };
    const verified = await verifySpec(spec, read);
    assert.strictEqual(verified.ok, true, JSON.stringify(verified.missing));
    assert.ok(verified.checks.some((c) => c.kind === 'form-topology'));

    const xml = store.row.formxml;
    // Merging only the two serialized rows recreates the original three-column overflow. Verify
    // must still reject it even though the field set, section placement and adjacency are right.
    store.row.formxml = xml.replace(/<\/row>\s*<row\b[^>]*>/, '');
    assert.notStrictEqual(store.row.formxml, xml);
    const rejected = await verifySpec(spec, read);
    assert.strictEqual(rejected.ok, false);
    assert.match(rejected.checks.find((c) => c.kind === 'form-topology').detail,
      /section 'fields' row 1 carries 3 columns of content in a 2-column section/);
    store.row.formxml = xml;

    const second = await freshSdk();
    assert.strictEqual((await runSdkBuild(spec, { sdk: second.sdk, apply: true, phases: ['forms'] })).ok, true);
    assert.deepStrictEqual(second.mutations, [], 'a fresh workspace fetched from the server issues no second-apply form mutations');
    assert.strictEqual(store.row.formxml, xml, 'the readback is persistent, not only an in-memory no-op');
  });
}

test('field placement: a failed row commit leaves the pre-move or full planned artifact, and a same-workspace retry converges', async () => {
  const { spec, freshSdk, store } = await positionFixture();
  const first = await freshSdk();
  const before = clone(await first.sdk.fetchArtifact('form', FORM_ID));
  const planned = clone(before);
  const section = sectionOf(planned, 'fields');
  const [area, name] = section.rows[0].cells;
  const code = section.rows[1].cells[0];
  section.rows = [{ ...section.rows[0], cells: [area, code] }, { cells: [name] }];
  const original = first.sdk.updateElement.bind(first.sdk);
  let injected = false;
  first.sdk.updateElement = async (...args) => {
    const [kind, , pointer, patch] = args;
    // Before the fix this intercepts the final trim, after the old row and its duplicate trailing
    // cell were already persisted. An atomic rows replacement hits the same failure before writing.
    if (kind === 'form' && (pointer.endsWith('/rows') || (pointer.endsWith('/rows/0')
      && patch.cells && patch.cells.some((c) => c.control.fieldName === 'new_code')))) {
      injected = true;
      throw new Error('injected layout write failure');
    }
    return original(...args);
  };
  await assert.rejects(() => runSdkBuild(spec, { sdk: first.sdk, apply: true, phases: ['forms'] }), /injected layout write failure/);
  assert.strictEqual(injected, true, 'the mutation fault must actually be exercised');
  const interrupted = clone(await first.sdk.getArtifact('form', FORM_ID));
  const originalShape = JSON.stringify(namesIn(before));
  assert.deepStrictEqual(interrupted, JSON.stringify(namesIn(interrupted)) === originalShape ? before : planned,
    'a failed placement cannot persist an overflowing row plus a duplicated trailing cell');
  assertUniqueIdentities(interrupted);

  const retry = await freshSdk(first.dir);
  await retry.sdk.fetchArtifact('form', FORM_ID);
  assert.strictEqual((await runSdkBuild(spec, { sdk: retry.sdk, apply: true, phases: ['forms'] })).ok, true);
  const recovered = await retry.sdk.getArtifact('form', FORM_ID);
  assert.deepStrictEqual(namesIn(recovered), [['new_area', 'new_code'], ['new_name']]);
  assertUniqueIdentities(recovered);
  const xml = store.row.formxml;
  const second = await freshSdk(first.dir);
  assert.strictEqual((await runSdkBuild(spec, { sdk: second.sdk, apply: true, phases: ['forms'] })).ok, true);
  assert.deepStrictEqual(second.mutations.filter(layoutMutation), [], 'recovery persists a no-op layout');
  assert.strictEqual(store.row.formxml, xml);
});

for (const [scenario, options] of [
  ['existing full-row move', {}],
  ['new middle field', { fields: ['new_area', 'new_code', 'new_name'], fieldOptions: {}, rows: [['new_area', 'new_name']] }],
  ['cross-section narrowing', {
    columns: 1, rows: [['new_area'], ['new_name']],
    sourceRows: [[{ name: 'new_code', colspan: 2 }], ['new_notes']],
  }],
]) {
  test(`field placement: ${scenario} survives a fault before and after every layout mutation`, async () => {
    const h = await positionFixture(options);
    const originalXml = h.store.row.formxml;
    const reference = await h.freshSdk();
    const before = clone(await reference.sdk.fetchArtifact('form', FORM_ID));
    assert.strictEqual((await runSdkBuild(h.spec, { sdk: reference.sdk, apply: true, phases: ['forms'] })).ok, true);
    const planned = clone(await reference.sdk.getArtifact('form', FORM_ID));
    const steps = reference.mutations.filter(layoutMutation);
    assert.ok(steps.length > 0, 'the fixture requires a real placement');
    assert.deepStrictEqual(namesIn(planned), options.columns === 1
      ? [['new_area'], ['new_code'], ['new_name']] : [['new_area', 'new_code'], ['new_name']]);
    for (let step = 1; step <= steps.length; step += 1) for (const edge of ['before', 'after']) {
      h.store.row.formxml = originalXml;
      const attempt = await h.freshSdk();
      let writes = 0;
      let injected = false;
      for (const method of ['addElement', 'updateElement', 'moveElement', 'removeElement']) {
        const original = attempt.sdk[method].bind(attempt.sdk);
        attempt.sdk[method] = async (...args) => {
          const ordinal = args[0] === 'form' ? ++writes : 0;
          if (ordinal === step && edge === 'before') {
            injected = true;
            throw new Error('injected layout write failure');
          }
          const result = await original(...args);
          if (ordinal === step && edge === 'after') {
            injected = true;
            throw new Error('injected layout write failure');
          }
          return result;
        };
      }
      await assert.rejects(() => runSdkBuild(h.spec, { sdk: attempt.sdk, apply: true, phases: ['forms'] }), /injected layout write failure/);
      assert.strictEqual(injected, true, `${scenario}, ${edge} step ${step}: fault is reached`);
      const interrupted = clone(await attempt.sdk.getArtifact('form', FORM_ID));
      const shape = JSON.stringify(namesIn(interrupted));
      assert.ok(shape === JSON.stringify(namesIn(before)) || shape === JSON.stringify(namesIn(planned)),
        `${scenario}, ${edge} step ${step}: no intermediate layout may be persisted (${shape})`);
      if (scenario !== 'new middle field') {
        // pushArtifact re-parses serialized XML, adding empty row bags and updating span attributes.
        // Compare against the complete pre-push mutation snapshot, not those serialization defaults.
        assert.deepStrictEqual(interrupted, shape === JSON.stringify(namesIn(before)) ? before : steps[steps.length - 1].snapshot,
          'a narrowing cannot be persisted separately from its cross-section move');
      }
      for (const old of sectionsOf(before).flatMap(cellsOf)) {
        const retained = sectionsOf(interrupted).flatMap(cellsOf).filter((c) => c.id === old.id);
        assert.strictEqual(retained.length, 1, 'each existing cell survives once, including its identity');
        assert.strictEqual(retained[0].control.id, old.control.id);
      }
      assertUniqueIdentities(interrupted);
      const retry = await h.freshSdk(attempt.dir);
      assert.strictEqual((await runSdkBuild(h.spec, { sdk: retry.sdk, apply: true, phases: ['forms'] })).ok, true);
      const recovered = await retry.sdk.getArtifact('form', FORM_ID);
      assert.deepStrictEqual(namesIn(recovered), namesIn(planned), `${scenario}: a new SDK over the same workspace converges`);
      assertUniqueIdentities(recovered);
      const again = await h.freshSdk(attempt.dir);
      assert.strictEqual((await runSdkBuild(h.spec, { sdk: again.sdk, apply: true, phases: ['forms'] })).ok, true);
      assert.deepStrictEqual(again.mutations.filter(layoutMutation), [], `${scenario}: the second recovery apply changes no layout`);
    }
    assert.strictEqual(steps.length, 1, 'new creation and all dependent row changes are one artifact mutation');
  });
}

test('field placement: dependent anchors remain satisfied after new-field insertion and a fresh second apply', async () => {
  const h = await positionFixture({
    fields: ['new_area', 'new_extra', 'new_name'],
    fieldOptions: { new_notes: { after: 'new_code' }, new_code: { after: 'new_area' } },
    rows: [['new_area', 'new_code'], ['new_notes', 'new_name']],
  });
  const first = await h.freshSdk();
  assert.strictEqual((await runSdkBuild(h.spec, { sdk: first.sdk, apply: true, phases: ['forms'] })).ok, true);
  const after = await first.sdk.getArtifact('form', FORM_ID);
  assert.deepStrictEqual(namesIn(after), [['new_area', 'new_code'], ['new_notes'], ['new_extra'], ['new_name']],
    'position code before its dependent notes, after placing the new extra field');
  assertUniqueIdentities(after);
  const xml = h.store.row.formxml;
  const second = await h.freshSdk(first.dir);
  assert.strictEqual((await runSdkBuild(h.spec, { sdk: second.sdk, apply: true, phases: ['forms'] })).ok, true);
  assert.deepStrictEqual(second.mutations.filter(layoutMutation), [], 'a fresh second apply issues no moves or row updates');
  assert.strictEqual(h.store.row.formxml, xml);
});
