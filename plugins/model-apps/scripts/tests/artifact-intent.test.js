'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const {
  compileFormIntent,
  fieldCellIntent,
  notesCellIntent,
  notesSectionIntent,
  subgridCellIntent,
  quickViewCellIntent,
  formEventsRegionIntent,
  viewColumnsIntent,
  formFieldLogicals,
  firstSectionRowsPointer,
  sectionRowsPointer,
  findFieldCellPointer,
  findSectionLocation,
  findSectionById,
} = require(path.join(__dirname, '..', 'lib', 'artifact-intent.js'));

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeSpec(extra) {
  return Object.assign({
    solution: { uniqueName: 'TestSol', publisherPrefix: 'new' },
    app: { name: 'Test App' },
    entities: [
      {
        schemaName: 'new_item',
        displayName: 'Item',
        primaryAttribute: { schemaName: 'new_name', displayName: 'Name' },
        columns: [
          { schemaName: 'new_status', displayName: 'Status', type: 'Choice', options: ['Open', 'Closed'] },
          { schemaName: 'new_cost', displayName: 'Cost', type: 'Money' },
        ],
      },
    ],
    relationships: [],
  }, extra || {});
}

// Spec with > 6 fields (primary + 6 columns = 7) to trigger 2-column auto layout.
function makeHeavySpec() {
  return {
    solution: { uniqueName: 'S', publisherPrefix: 'new' },
    app: { name: 'A' },
    entities: [{
      schemaName: 'new_item',
      primaryAttribute: { schemaName: 'new_name' },
      columns: [
        { schemaName: 'new_f1', type: 'Text' },
        { schemaName: 'new_f2', type: 'Text' },
        { schemaName: 'new_f3', type: 'Text' },
        { schemaName: 'new_f4', type: 'Text' },
        { schemaName: 'new_f5', type: 'Text' },
        { schemaName: 'new_f6', type: 'Text' },
      ]
    }],
    relationships: []
  };
}

// ---------------------------------------------------------------------------
// fieldCellIntent
// ---------------------------------------------------------------------------

test('fieldCellIntent: returns minimal bound-field cell — omits classId, label, type, id, visible', () => {
  const cell = fieldCellIntent('new_Name');
  assert.strictEqual(cell.control.fieldName, 'new_name', 'fieldName is lowercased');
  // SDK T4: adapter derives classId and label from Dataverse attribute metadata.
  // If we emitted them here they would drift from the adapter's values.
  assert.ok(!('classId' in cell.control), 'classId must be omitted (SDK T4)');
  assert.ok(!('label' in cell.control), 'label must be omitted (SDK T4)');
  assert.ok(!('type' in cell.control), 'type must be omitted');
  assert.ok(!('isRequired' in cell.control), 'isRequired omitted when not required');
  assert.ok(!('id' in cell), 'cell id must be omitted');
  assert.ok(!('visible' in cell), 'visible must be omitted');
  assert.ok(!('colspan' in cell), 'colspan must be omitted');
  assert.ok(!('rowspan' in cell), 'rowspan must be omitted');
});

test('fieldCellIntent: includes isRequired only when true, omits when false or undefined', () => {
  const req = fieldCellIntent('new_name', { isRequired: true });
  assert.strictEqual(req.control.isRequired, true);

  const notReq = fieldCellIntent('new_name', { isRequired: false });
  assert.ok(!('isRequired' in notReq.control), 'isRequired omitted when false');

  const noOpts = fieldCellIntent('new_name');
  assert.ok(!('isRequired' in noOpts.control), 'isRequired omitted with no opts');
});

test('fieldCellIntent: includes label only when passed as an explicit override', () => {
  const withLabel = fieldCellIntent('new_name', { label: 'Override Name' });
  assert.strictEqual(withLabel.control.label, 'Override Name');

  const noLabel = fieldCellIntent('new_name', {});
  assert.ok(!('label' in noLabel.control), 'label omitted when not passed');
});

// ---------------------------------------------------------------------------
// notesCellIntent / notesSectionIntent
// ---------------------------------------------------------------------------

test('notesCellIntent: returns the platform timeline cell with the passed-in classId', () => {
  const cell = notesCellIntent('notes-class-guid');
  assert.deepStrictEqual(cell, {
    // A tall cell the empty rows under it are the height of, with the attributes the platform's cell carries.
    rowspan: 23,
    bag: { a: [['showlabel', 'false'], ['colspan', '1'], ['rowspan', '23'], ['auto', 'false']], c: [] },
    control: {
      // The one control id Dynamics renders a timeline under — a generated id is published and never shown.
      id: 'notescontrol',
      classId: 'notes-class-guid',
      fieldName: null,
      label: 'Notes',
      showLabel: false,
      parameters: {}
    }
  });
});

test('notesCellIntent: coerces classId to string (undefined becomes "undefined")', () => {
  const cell = notesCellIntent(undefined);
  assert.strictEqual(typeof cell.control.classId, 'string');
});

test('notesSectionIntent: the section holds the timeline row, then the 22 empty rows its cell spans', () => {
  const sec = notesSectionIntent('notes-class-guid');
  assert.strictEqual(sec.name, 'section_notes');
  assert.strictEqual(sec.label, 'Notes');
  assert.strictEqual(sec.visible, true);
  assert.strictEqual(sec.showLabel, true);
  assert.strictEqual(sec.columns, 1);
  assert.strictEqual(sec.rows.length, 23);
  assert.strictEqual(sec.rows[0].cells.length, 1);
  assert.strictEqual(sec.rows[0].cells[0].control.classId, 'notes-class-guid');
  assert.strictEqual(sec.rows[0].cells[0].control.id, 'notescontrol');
  assert.strictEqual(sec.rows[0].cells[0].rowspan, 23);
  assert.ok(sec.rows.slice(1).every(function (r) { return Array.isArray(r.cells) && r.cells.length === 0; }), 'the other 22 rows are empty');
});

// ---------------------------------------------------------------------------
// subgridCellIntent
// ---------------------------------------------------------------------------

test('subgridCellIntent: returns exact shape (proven by SDK form.workflow.test.ts)', () => {
  const cell = subgridCellIntent({
    subgridClassId: 'sg-class-guid',
    targetEntity: 'new_ticket',
    relationshipName: 'new_customer_new_ticket',
    viewId: 'view-guid',
    label: 'Tickets'
  });
  assert.strictEqual(cell.control.classId, 'sg-class-guid');
  assert.strictEqual(cell.control.label, 'Tickets');
  assert.deepStrictEqual(cell.control.parameters, {
    TargetEntityType: 'new_ticket',
    ViewId: 'view-guid',
    IsUserView: 'false',
    RelationshipName: 'new_customer_new_ticket',
    ChartGridMode: 'Grid',
    RecordsPerPage: '10'
  });
  // fieldName is not present — subgrid is not a bound-field control
  assert.ok(!('fieldName' in cell.control), 'fieldName not present on subgrid cell');
});

// ---------------------------------------------------------------------------
// quickViewCellIntent
// ---------------------------------------------------------------------------

test('quickViewCellIntent: returns exact shape (proven by SDK form.workflow.test.ts)', () => {
  const cell = quickViewCellIntent({
    quickViewClassId: 'qv-class-guid',
    lookupFieldName: 'New_CustomerId',
    targetEntity: 'new_customer',
    quickViewFormId: 'qvform-guid',
    label: 'Customer Info'
  });
  assert.strictEqual(cell.control.classId, 'qv-class-guid');
  assert.strictEqual(cell.control.fieldName, 'new_customerid', 'lookupFieldName lowercased');
  assert.strictEqual(cell.control.label, 'Customer Info');
  assert.strictEqual(
    cell.control.parameters.QuickForms,
    '<QuickFormIds><QuickFormId entityname="new_customer">qvform-guid</QuickFormId></QuickFormIds>'
  );
  assert.strictEqual(cell.control.parameters.ControlMode, 'Edit');
});

// ---------------------------------------------------------------------------
// formEventsRegionIntent
// ---------------------------------------------------------------------------

test('formEventsRegionIntent: returns correct events region node structure', () => {
  const region = formEventsRegionIntent([
    { event: 'onload', library: 'new_form.js', function: 'Form.onLoad' },
    { event: 'onsave', library: 'new_form.js', function: 'Form.onSave' },
  ]);
  assert.strictEqual(region.n, 'events');
  assert.deepStrictEqual(region.a, []);
  assert.strictEqual(region.c.length, 2);

  const onload = region.c[0];
  assert.strictEqual(onload.n, 'event');
  const onloadAttrs = Object.fromEntries(onload.a);
  assert.strictEqual(onloadAttrs.name, 'onload');
  assert.strictEqual(onloadAttrs.application, 'false');
  assert.strictEqual(onloadAttrs.active, 'false');
  // 'attribute' must NOT appear on onload — only onchange carries it
  assert.ok(!onload.a.some(function (pair) { return pair[0] === 'attribute'; }),
    'onload must not have attribute');

  const handlers = onload.c[0];
  assert.strictEqual(handlers.n, 'Handlers');
  assert.deepStrictEqual(handlers.a, []);
  const handler = handlers.c[0];
  assert.strictEqual(handler.n, 'Handler');
  const handlerAttrs = Object.fromEntries(handler.a);
  assert.strictEqual(handlerAttrs.functionName, 'Form.onLoad');
  assert.strictEqual(handlerAttrs.libraryName, 'new_form.js');
  assert.strictEqual(handlerAttrs.enabled, 'true');
  assert.strictEqual(handlerAttrs.parameters, '');
  assert.strictEqual(handlerAttrs.passExecutionContext, 'true');
  // handlerUniqueId must NOT be present — the adapter mints it at serialize time
  assert.ok(!handler.a.some(function (pair) { return pair[0] === 'handlerUniqueId'; }),
    'handlerUniqueId must be omitted');
  assert.deepStrictEqual(handler.c, []);
});

test('formEventsRegionIntent: onchange event includes attribute, onload/onsave do not', () => {
  const region = formEventsRegionIntent([
    { event: 'onchange', library: 'new_form.js', function: 'Form.onChange', attribute: 'new_status' },
  ]);
  const ev = region.c[0];
  const attrPair = ev.a.find(function (pair) { return pair[0] === 'attribute'; });
  assert.ok(attrPair, 'onchange must have attribute');
  assert.strictEqual(attrPair[1], 'new_status');
});

test('formEventsRegionIntent: empty events array returns empty c array', () => {
  const region = formEventsRegionIntent([]);
  assert.deepStrictEqual(region.c, []);
});

// ---------------------------------------------------------------------------
// viewColumnsIntent
// ---------------------------------------------------------------------------

test('viewColumnsIntent: normalizes names to lowercase, defaults width to 100, adds order', () => {
  const result = viewColumnsIntent([
    { name: 'New_Subject' },
    { name: 'new_priority', width: 200 },
    { name: 'New_DATE', width: 0 }, // width: 0 is falsy → default 100
  ]);
  assert.deepStrictEqual(result, [
    { name: 'new_subject', width: 100, order: 0 },
    { name: 'new_priority', width: 200, order: 1 },
    { name: 'new_date', width: 100, order: 2 },
  ]);
});

test('viewColumnsIntent: empty input returns empty array', () => {
  assert.deepStrictEqual(viewColumnsIntent([]), []);
  assert.deepStrictEqual(viewColumnsIntent(), []);
});

// ---------------------------------------------------------------------------
// compileFormIntent — topology
// ---------------------------------------------------------------------------

test('compileFormIntent: result has required top-level fields', () => {
  const spec = makeSpec();
  const result = compileFormIntent(spec, { entity: 'new_item', name: 'Item Form' });
  assert.strictEqual(result.entityLogicalName, 'new_item');
  assert.strictEqual(result.name, 'Item Form');
  assert.strictEqual(result.formType, 'Main');
  assert.strictEqual(result.status, 'Active');
  assert.ok(Array.isArray(result.tabs));
  assert.strictEqual(typeof result.__explicitLayout, 'boolean');
});

test('compileFormIntent: auto layout produces NEW topology (columns layer present)', () => {
  const spec = makeSpec();
  const result = compileFormIntent(spec, { entity: 'new_item' });
  const tab = result.tabs[0];
  // Each tab must have exactly ONE column wrapping its sections (new SDK topology).
  assert.ok(Array.isArray(tab.columns), 'tab.columns must be an array');
  assert.strictEqual(tab.columns.length, 1, 'exactly one FormColumn per tab');
  const col = tab.columns[0];
  assert.ok(Array.isArray(col.sections), 'column.sections must be an array');
  // Old topology property must not be present on the tab
  assert.ok(!('sections' in tab), 'tab must not have sections directly (old topology)');
});

test('compileFormIntent: auto layout tab has name, label, expanded, visible', () => {
  const spec = makeSpec();
  const result = compileFormIntent(spec, { entity: 'new_item' });
  const tab = result.tabs[0];
  assert.strictEqual(tab.name, 'tab_general');
  assert.strictEqual(tab.label, 'General');
  assert.strictEqual(tab.expanded, true);
  assert.strictEqual(tab.visible, true);
});

test('compileFormIntent: auto layout — 1-column section for ≤6 fields', () => {
  // primary + 2 columns = 3 cells → ≤6 → 1 column
  const spec = makeSpec();
  const result = compileFormIntent(spec, { entity: 'new_item' });
  const section = result.tabs[0].columns[0].sections[0];
  assert.strictEqual(section.columns, 1);
  assert.strictEqual(result.__explicitLayout, false);
});

test('compileFormIntent: auto layout — 2-column section for >6 fields', () => {
  // primary + 6 columns = 7 cells → >6 → 2 columns
  const spec = makeHeavySpec();
  const result = compileFormIntent(spec, { entity: 'new_item' });
  const section = result.tabs[0].columns[0].sections[0];
  assert.strictEqual(section.columns, 2);
  // rows should have 2 cells each (except possibly the last)
  assert.strictEqual(section.rows[0].cells.length, 2);
});

test('compileFormIntent: QuickCreate clamps section columns to 1 regardless of field count', () => {
  // 7 cells would normally produce 2 columns, but QuickCreate caps at 1
  const spec = makeHeavySpec();
  const result = compileFormIntent(spec, { entity: 'new_item', formType: 'QuickCreate' });
  const section = result.tabs[0].columns[0].sections[0];
  assert.strictEqual(section.columns, 1);
  assert.strictEqual(result.formType, 'QuickCreate');
});

test('compileFormIntent: auto layout field cells omit classId and label (SDK T4)', () => {
  const spec = makeSpec();
  const result = compileFormIntent(spec, { entity: 'new_item' });
  const allCells = result.tabs[0].columns[0].sections[0].rows.flatMap(function (r) { return r.cells; });
  for (const cell of allCells) {
    assert.ok(!('classId' in cell.control), 'classId must be absent from field cell');
    assert.ok(!('label' in cell.control), 'label must be absent from field cell');
  }
});

test('compileFormIntent: auto layout marks primary field isRequired:true', () => {
  const spec = makeSpec();
  const result = compileFormIntent(spec, { entity: 'new_item' });
  const cells = result.tabs[0].columns[0].sections[0].rows.flatMap(function (r) { return r.cells; });
  const primaryCell = cells.find(function (c) { return c.control.fieldName === 'new_name'; });
  assert.ok(primaryCell, 'primary field cell present');
  assert.strictEqual(primaryCell.control.isRequired, true);
});

test('compileFormIntent: auto layout includes lookup columns from relationships', () => {
  const spec = Object.assign({}, makeSpec(), {
    relationships: [{
      type: 'OneToMany',
      referenced: 'new_customer',
      referencing: 'new_item',
      lookup: { schemaName: 'new_CustomerId', displayName: 'Customer' }
    }]
  });
  const result = compileFormIntent(spec, { entity: 'new_item' });
  const cells = result.tabs[0].columns[0].sections[0].rows.flatMap(function (r) { return r.cells; });
  const lookupCell = cells.find(function (c) { return c.control.fieldName === 'new_customerid'; });
  assert.ok(lookupCell, 'lookup column from relationship must appear on auto form');
});

test('compileFormIntent: __primaryField is entity primaryAttribute lowercased', () => {
  const spec = makeSpec();
  const result = compileFormIntent(spec, { entity: 'new_item' });
  assert.strictEqual(result.__primaryField, 'new_name');
});

test('compileFormIntent: __primaryField is undefined when entity not found in spec', () => {
  const spec = makeSpec();
  const result = compileFormIntent(spec, { entity: 'new_unknown' });
  assert.strictEqual(result.__primaryField, undefined);
});

// ---------------------------------------------------------------------------
// compileFormIntent — explicit layout
// ---------------------------------------------------------------------------

test('compileFormIntent: explicit layout honors authored tabs, sections, columns', () => {
  const spec = makeSpec();
  const formSpec = {
    entity: 'new_item',
    name: 'My Form',
    tabs: [{
      name: 'tab_main',
      label: 'Main Details',
      sections: [{
        name: 'sec_core',
        label: 'Core',
        columns: 2,
        fields: ['new_name', 'new_status', 'new_cost']
      }]
    }]
  };
  const result = compileFormIntent(spec, formSpec);
  assert.strictEqual(result.__explicitLayout, true);
  assert.strictEqual(result.tabs.length, 1);
  const tab = result.tabs[0];
  assert.strictEqual(tab.name, 'tab_main');
  assert.strictEqual(tab.label, 'Main Details');
  // Still wrapped in a FormColumn (new topology)
  assert.strictEqual(tab.columns.length, 1);
  const section = tab.columns[0].sections[0];
  assert.strictEqual(section.name, 'sec_core');
  assert.strictEqual(section.label, 'Core');
  assert.strictEqual(section.columns, 2);
  // 3 fields in 2-column rows → first row has 2 cells
  assert.strictEqual(section.rows[0].cells.length, 2);
  assert.strictEqual(section.rows[0].cells[0].control.fieldName, 'new_name');
  assert.strictEqual(section.rows[0].cells[1].control.fieldName, 'new_status');
  assert.strictEqual(section.rows[1].cells[0].control.fieldName, 'new_cost');
});

test('compileFormIntent: explicit layout clamps section.columns to maxCols (QuickCreate = 1)', () => {
  const spec = makeSpec();
  const formSpec = {
    entity: 'new_item',
    formType: 'QuickCreate',
    tabs: [{
      sections: [{ columns: 3, fields: ['new_name', 'new_status'] }]
    }]
  };
  const result = compileFormIntent(spec, formSpec);
  const section = result.tabs[0].columns[0].sections[0];
  assert.strictEqual(section.columns, 1, 'QuickCreate clamps authored 3 to 1');
});

test('compileFormIntent: explicit layout defaults tab/section names when omitted', () => {
  const spec = makeSpec();
  const formSpec = {
    entity: 'new_item',
    tabs: [{ sections: [{ fields: ['new_name'] }] }]
  };
  const result = compileFormIntent(spec, formSpec);
  assert.strictEqual(result.tabs[0].name, 'tab_0');
  assert.strictEqual(result.tabs[0].columns[0].sections[0].name, 'section_0_0');
});

// ---------------------------------------------------------------------------
// compileFormIntent — notes section gating
// ---------------------------------------------------------------------------

test('compileFormIntent: notes section appended when form.notes=true on a Main form', () => {
  const spec = makeSpec();
  const result = compileFormIntent(
    spec,
    { entity: 'new_item', notes: true },
    { notesClassId: 'notes-class-guid' }
  );
  const sections = result.tabs[0].columns[0].sections;
  const notesSection = sections[sections.length - 1];
  assert.strictEqual(notesSection.name, 'section_notes');
  assert.strictEqual(notesSection.label, 'Notes');
  assert.strictEqual(notesSection.showLabel, true);
  assert.strictEqual(notesSection.columns, 1);
  assert.strictEqual(notesSection.rows[0].cells[0].control.classId, 'notes-class-guid');
});

test('compileFormIntent: notes section appended when entity.hasNotes=true on a Main form', () => {
  const spec = {
    solution: { uniqueName: 'S', publisherPrefix: 'new' }, app: { name: 'A' },
    entities: [{
      schemaName: 'new_item', hasNotes: true,
      primaryAttribute: { schemaName: 'new_name' }, columns: []
    }],
    relationships: []
  };
  const result = compileFormIntent(spec, { entity: 'new_item' }, { notesClassId: 'ng' });
  const sections = result.tabs[0].columns[0].sections;
  assert.ok(sections.some(function (s) { return s.name === 'section_notes'; }),
    'notes section added via entity.hasNotes');
});

test('compileFormIntent: notes section NOT added on QuickCreate (even with form.notes=true)', () => {
  const spec = makeSpec();
  const result = compileFormIntent(
    spec,
    { entity: 'new_item', formType: 'QuickCreate', notes: true }
  );
  const sections = result.tabs[0].columns[0].sections;
  assert.ok(!sections.some(function (s) { return s.name === 'section_notes'; }),
    'QuickCreate must not have notes section');
});

test('compileFormIntent: notes section NOT added when neither form.notes nor entity.hasNotes', () => {
  const spec = makeSpec();
  const result = compileFormIntent(spec, { entity: 'new_item' });
  const sections = result.tabs[0].columns[0].sections;
  assert.ok(!sections.some(function (s) { return s.name === 'section_notes'; }),
    'no notes section without opt-in');
});

test('compileFormIntent: the Notes section is the platform timeline host, on an auto and an explicit layout alike', () => {
  const spec = makeSpec();
  const layouts = [
    { entity: 'new_item', notes: true },
    { entity: 'new_item', notes: true, tabs: [{ name: 'tab_a', label: 'A', sections: [{ name: 'sec_a', columns: 1, fields: ['new_name'] }] }] },
  ];
  for (const formSpec of layouts) {
    const def = compileFormIntent(spec, formSpec, { notesClassId: 'ng' });
    assert.strictEqual(def.__notes, true, 'the def records that the form asked for the timeline');
    const sections = def.tabs[0].columns[0].sections;
    const host = sections[sections.length - 1];
    assert.strictEqual(host.name, 'section_notes', 'appended last, as before');
    assert.strictEqual(host.rows.length, 23, 'the timeline row and the 22 rows its cell spans');
    const timeline = host.rows[0].cells[0];
    assert.strictEqual(timeline.control.id, 'notescontrol');
    assert.strictEqual(timeline.rowspan, 23);
    assert.deepStrictEqual(timeline.bag.a.find(function (p) { return p[0] === 'auto'; }), ['auto', 'false']);
    assert.ok(host.rows.slice(1).every(function (r) { return r.cells.length === 0; }));
    // Nothing about it reads as a field: not bound, so it is never placed, pruned or moved as one.
    assert.deepStrictEqual(formFieldLogicals(def), formFieldLogicals(compileFormIntent(spec, Object.assign({}, formSpec, { notes: false }))));
  }
});

test('compileFormIntent: __notes is false for a form that did not ask, and for a form that cannot host the timeline', () => {
  const spec = makeSpec();
  assert.strictEqual(compileFormIntent(spec, { entity: 'new_item' }).__notes, false);
  assert.strictEqual(compileFormIntent(spec, { entity: 'new_item', formType: 'QuickCreate', notes: true }).__notes, false);
  assert.strictEqual(compileFormIntent(spec, { entity: 'new_item', formType: 'QuickView', notes: true }).__notes, false);
});

// ---------------------------------------------------------------------------
// formFieldLogicals
// ---------------------------------------------------------------------------

test('formFieldLogicals: walks new topology (columns layer), dedupes, excludes null-fieldName controls', () => {
  // Build a form intent manually with the new topology
  const formJson = {
    tabs: [{
      columns: [{
        sections: [{
          rows: [
            { cells: [{ control: { fieldName: 'new_name' } }, { control: { fieldName: 'new_status' } }] },
            // notes control: fieldName is null → excluded
            { cells: [{ control: { fieldName: null } }] },
            // duplicate (different case) → deduped
            { cells: [{ control: { fieldName: 'NEW_NAME' } }] },
          ]
        }]
      }]
    }]
  };
  const result = formFieldLogicals(formJson);
  assert.deepStrictEqual(result, ['new_name', 'new_status']);
});

test('formFieldLogicals: EXCLUDES a quick-view control though it binds a lookup fieldName (regression: reconcile must not delete the quick-view on rebuild)', () => {
  const QUICK_VIEW = '5C5600E0-1D6E-4205-A272-BE80DA87FD42';
  const SUBGRID = 'E7A81278-8635-4D9E-8D4D-59480B391C5B';
  const NOTES = '06375649-C143-495E-A496-C962E5B4488E';
  const formJson = {
    tabs: [{ columns: [{ sections: [{ rows: [
      { cells: [{ control: { fieldName: 'new_name' } }] },
      // a quick-view control binds the host lookup as fieldName — it is NOT a form field
      { cells: [{ control: { classId: QUICK_VIEW, fieldName: 'new_customerid' } }] },
      // a sub-grid control (no fieldName) and a notes control — excluded as before
      { cells: [{ control: { classId: SUBGRID, parameters: { RelationshipName: 'r' } } }] },
      { cells: [{ control: { classId: NOTES, fieldName: null } }] },
    ] }] }] }],
  };
  assert.deepStrictEqual(formFieldLogicals(formJson), ['new_name'], 'only the real bound field is counted');
  // The prune resolves a dropped logical to a cell via findFieldCellPointer — it must NEVER resolve
  // the quick-view's lookup to the quick-view control cell (which would delete the quick-view).
  assert.strictEqual(findFieldCellPointer(formJson, 'new_customerid'), null, 'the quick-view lookup is not a removable field cell');
  assert.match(findFieldCellPointer(formJson, 'new_name'), /\/rows\/0\/cells\/0$/, 'a genuine bound field still resolves');
});

test('formFieldLogicals: works end-to-end on compileFormIntent output', () => {
  const spec = {
    solution: { uniqueName: 'S', publisherPrefix: 'new' }, app: { name: 'A' },
    entities: [{
      schemaName: 'new_task', primaryAttribute: { schemaName: 'new_name', displayName: 'T' },
      columns: [{ schemaName: 'new_priority', type: 'Text' }], hasNotes: true
    }],
    relationships: [{
      type: 'OneToMany', referenced: 'new_project', referencing: 'new_task',
      lookup: { schemaName: 'new_ProjectId', displayName: 'Project' }
    }],
  };
  const result = compileFormIntent(spec, { entity: 'new_task', notes: true }, { notesClassId: 'ng' });
  // primary + new_priority + lookup (new_projectid) → 3 bound fields; notes excluded
  assert.deepStrictEqual(formFieldLogicals(result), ['new_name', 'new_priority', 'new_projectid']);
});

test('formFieldLogicals: returns empty array for empty form', () => {
  assert.deepStrictEqual(formFieldLogicals({ tabs: [] }), []);
  assert.deepStrictEqual(formFieldLogicals({}), []);
});

// ---------------------------------------------------------------------------
// Pointer helpers
// ---------------------------------------------------------------------------

test('sectionRowsPointer: builds correct JSON pointer', () => {
  assert.strictEqual(sectionRowsPointer(0, 0, 0), '/tabs/0/columns/0/sections/0/rows');
  assert.strictEqual(sectionRowsPointer(1, 2, 3), '/tabs/1/columns/2/sections/3/rows');
});

test('firstSectionRowsPointer: finds pointer to first section with rows in new topology', () => {
  const formJson = {
    tabs: [{
      columns: [{
        sections: [{ rows: [] }]
      }]
    }]
  };
  assert.strictEqual(firstSectionRowsPointer(formJson), '/tabs/0/columns/0/sections/0/rows');
});

test('firstSectionRowsPointer: returns empty string when no sections found', () => {
  assert.strictEqual(firstSectionRowsPointer({ tabs: [] }), '');
  assert.strictEqual(firstSectionRowsPointer({ tabs: [{ columns: [] }] }), '');
  assert.strictEqual(firstSectionRowsPointer({ tabs: [{ columns: [{ sections: [] }] }] }), '');
  assert.strictEqual(firstSectionRowsPointer({}), '');
});

test('firstSectionRowsPointer: skips tabs/columns with no sections', () => {
  const formJson = {
    tabs: [
      { columns: [{ sections: [] }] },           // no sections — skip
      { columns: [{ sections: [{ rows: [] }] }] } // has a section — match
    ]
  };
  assert.strictEqual(firstSectionRowsPointer(formJson), '/tabs/1/columns/0/sections/0/rows');
});

test('findFieldCellPointer: returns correct pointer for a bound field', () => {
  const formJson = {
    tabs: [{
      columns: [{
        sections: [{
          rows: [
            { cells: [
              { control: { fieldName: 'new_name' } },
              { control: { fieldName: 'new_status' } }
            ]}
          ]
        }]
      }]
    }]
  };
  assert.strictEqual(
    findFieldCellPointer(formJson, 'new_name'),
    '/tabs/0/columns/0/sections/0/rows/0/cells/0'
  );
  assert.strictEqual(
    findFieldCellPointer(formJson, 'new_status'),
    '/tabs/0/columns/0/sections/0/rows/0/cells/1'
  );
});

test('findFieldCellPointer: returns null when field not present', () => {
  const formJson = { tabs: [{ columns: [{ sections: [{ rows: [{ cells: [{ control: { fieldName: 'new_name' } }] }] }] }] }] };
  assert.strictEqual(findFieldCellPointer(formJson, 'new_missing'), null);
});

test('findFieldCellPointer: matching is case-insensitive', () => {
  const formJson = { tabs: [{ columns: [{ sections: [{ rows: [{ cells: [{ control: { fieldName: 'new_name' } }] }] }] }] }] };
  assert.strictEqual(
    findFieldCellPointer(formJson, 'NEW_NAME'),
    '/tabs/0/columns/0/sections/0/rows/0/cells/0'
  );
});

test('findFieldCellPointer: skips null-fieldName controls (notes/subgrid)', () => {
  const formJson = {
    tabs: [{
      columns: [{
        sections: [{
          rows: [{
            cells: [
              { control: { fieldName: null } },  // notes control — no fieldName
              { control: { fieldName: 'new_status' } }
            ]
          }]
        }]
      }]
    }]
  };
  assert.strictEqual(
    findFieldCellPointer(formJson, 'new_status'),
    '/tabs/0/columns/0/sections/0/rows/0/cells/1'
  );
  // null fieldName must not match anything
  assert.strictEqual(findFieldCellPointer(formJson, ''), null);
});

// A section is found by name, and by the id the SDK mints for it. The id is what a caller holding a section across
// the addition or removal of the sections around it finds it again by — a section's index moves, and a name can be
// shared by a real section and the emptied copy an older build left, or be missing.
const sectionTree = (...tabs) => ({ tabs: tabs.map((columns) => ({ columns: columns.map((sections) => ({ sections })) })) });

test('findSectionLocation: finds a section by name across the whole form, case-insensitively, with where it is', () => {
  const form = sectionTree([[{ id: 'a', name: 'sec_one' }, { id: 'b', name: 'Sec_Two' }]], [[{ id: 'c', name: 'sec_three' }], [{ id: 'd', name: 'sec_four' }]]);
  const hit = findSectionLocation(form, 'SEC_TWO');
  assert.deepStrictEqual([hit.pointer, hit.rowsPointer, hit.tabIndex, hit.columnIndex, hit.sectionIndex, hit.section.id], ['/tabs/0/columns/0/sections/1', '/tabs/0/columns/0/sections/1/rows', 0, 0, 1, 'b']);
  assert.strictEqual(findSectionLocation(form, 'sec_four').pointer, '/tabs/1/columns/1/sections/0');
  assert.strictEqual(findSectionLocation(form, 'sec_nope'), null);
  assert.strictEqual(findSectionLocation(form, ''), null);
  assert.strictEqual(findSectionLocation({}, 'sec_one'), null);
});

test('findSectionLocation: `accept` hides a same-named section from the lookup, and the first the caller accepts is the one found', () => {
  const form = sectionTree([[{ id: 'host', name: 'section_notes', host: true }, { id: 'mine', name: 'section_notes' }]]);
  assert.strictEqual(findSectionLocation(form, 'section_notes').section.id, 'host', 'document order');
  assert.strictEqual(findSectionLocation(form, 'section_notes', (s) => !s.host).section.id, 'mine');
  assert.strictEqual(findSectionLocation(form, 'section_notes', () => false), null);
});

test('findSectionById: finds a section by its id wherever it is, and still finds it after sections were added or taken out ahead of it', () => {
  const sections = [{ id: '0F0F0F0F-0000-4000-8000-000000000001', name: 'sec_one' }, { id: '0f0f0f0f-0000-4000-8000-000000000002', name: 'sec_two' }];
  const form = sectionTree([[sections[0], sections[1]]], [[{ id: 'tab-two-section', name: 'sec_b' }]]);
  assert.strictEqual(findSectionById(form, sections[1].id).pointer, '/tabs/0/columns/0/sections/1');
  assert.strictEqual(findSectionById(form, '0f0f0f0f-0000-4000-8000-000000000001').pointer, '/tabs/0/columns/0/sections/0', 'case does not matter');
  assert.strictEqual(findSectionById(form, 'tab-two-section').pointer, '/tabs/1/columns/0/sections/0');
  // A section is added ahead of sec_two, and one is taken out of its column: the same section, found at its new place.
  form.tabs[0].columns[0].sections.unshift({ id: 'grid', name: 'section_grid_x' });
  assert.strictEqual(findSectionById(form, sections[1].id).pointer, '/tabs/0/columns/0/sections/2');
  form.tabs[0].columns[0].sections.splice(0, 2);
  const hit = findSectionById(form, sections[1].id);
  assert.deepStrictEqual([hit.pointer, hit.rowsPointer, hit.tabIndex, hit.columnIndex, hit.sectionIndex, hit.section.name], ['/tabs/0/columns/0/sections/0', '/tabs/0/columns/0/sections/0/rows', 0, 0, 0, 'sec_two']);
});

test('findSectionById: a section that is not there, an id that is blank, and a section with no id are all null — never another section', () => {
  const form = sectionTree([[{ id: 'a', name: 'sec_one' }, { name: 'no_id' }, { id: '', name: 'blank_id' }, { id: null, name: 'null_id' }]]);
  assert.strictEqual(findSectionById(form, 'zzz'), null);
  for (const blank of ['', null, undefined]) assert.strictEqual(findSectionById(form, blank), null, `id ${JSON.stringify(blank)}`);
  assert.strictEqual(findSectionById({}, 'a'), null);
  assert.strictEqual(findSectionById({ tabs: [{}, { columns: [{}] }] }, 'a'), null);
  assert.strictEqual(findSectionById(form, 'a').section.name, 'sec_one');
});

// The App Spec has documented `enabled`, `passExecutionContext` and `parameters` on
// `forms[].events[]` all along, but the intent builder HARDCODED all three and never read the
// authored values. An author who wrote `"enabled": false` got a handler that ran anyway — the
// worst shape of bug, because the spec, the docs and the deployed form all disagreed silently.
test('form event handler honours enabled / passExecutionContext / parameters', () => {
  const attrsOf = (region) => {
    const handler = region.c[0].c[0].c[0];
    return Object.fromEntries(handler.a);
  };

  // Defaults: both flags true, parameters empty — what an author wiring a handler almost always wants.
  const def = attrsOf(formEventsRegionIntent([{ event: 'onload', library: 'new_lib.js', function: 'onLoad' }]));
  assert.strictEqual(def.enabled, 'true');
  assert.strictEqual(def.passExecutionContext, 'true');
  assert.strictEqual(def.parameters, '');

  // Authored values must actually reach the FormXML.
  const set = attrsOf(formEventsRegionIntent([{
    event: 'onload', library: 'new_lib.js', function: 'onLoad',
    enabled: false, passExecutionContext: false, parameters: 'a,b',
  }]));
  assert.strictEqual(set.enabled, 'false', 'enabled:false must disable the handler, not be discarded');
  assert.strictEqual(set.passExecutionContext, 'false');
  assert.strictEqual(set.parameters, 'a,b');

  // FormXML attribute values are strings, so booleans must be rendered rather than passed through.
  for (const [k, v] of Object.entries(set)) assert.strictEqual(typeof v, 'string', k + ' must serialize as a string');
});

test('form event parameters accepts an explicit empty string and ignores null', () => {
  const attrsOf = (ev) => Object.fromEntries(formEventsRegionIntent([ev]).c[0].c[0].c[0].a);
  assert.strictEqual(attrsOf({ event: 'onsave', library: 'l.js', function: 'f', parameters: '' }).parameters, '');
  // Dataverse writes parameters="" itself, so an absent value is the empty string, not a dropped attribute.
  assert.strictEqual(attrsOf({ event: 'onsave', library: 'l.js', function: 'f', parameters: null }).parameters, '');
});

test('explicit layout: colspan/rowspan are emitted only when they exceed the adapter default', () => {
  const spec = makeSpec();
  const form = { entity: 'new_item', name: 'Item', layout: 'explicit', tabs: [{ label: 'General', sections: [
    { label: 'Details', columns: 2, fields: [{ name: 'new_name', colspan: 2 }, 'new_status', { name: 'new_cost', rowspan: 2 }] },
  ] }] };
  const intent = compileFormIntent(spec, form);
  const cells = intent.tabs[0].columns[0].sections[0].rows.flatMap((r) => r.cells);
  const byField = Object.fromEntries(cells.map((c) => [c.control.fieldName, c]));
  assert.strictEqual(byField.new_name.colspan, 2, 'an authored colspan reaches the cell');
  assert.strictEqual(byField.new_cost.rowspan, 2, 'an authored rowspan reaches the cell');
  // An ordinary cell must carry NO span key: emitting the default would overwrite a span a maker
  // widened by hand on a form the spec never claimed to own that of.
  assert.ok(!('colspan' in byField.new_status), 'no colspan is written for a field that did not ask');
  assert.ok(!('rowspan' in byField.new_status), 'no rowspan is written for a field that did not ask');
});

test('explicit layout: a colspan cell consumes its full width when packing rows', () => {
  const spec = makeSpec();
  const form = { entity: 'new_item', name: 'Item', layout: 'explicit', tabs: [{ label: 'G', sections: [
    { label: 'D', columns: 2, fields: [{ name: 'new_name', colspan: 2 }, 'new_status', 'new_cost'] },
  ] }] };
  const rows = compileFormIntent(spec, form).tabs[0].columns[0].sections[0].rows;
  // Packing by cell COUNT would put new_name and new_status in row 0, even though new_name already
  // spans the whole 2-column section.
  assert.deepStrictEqual(rows.map((r) => r.cells.map((c) => c.control.fieldName)), [['new_name'], ['new_status', 'new_cost']]);
});

test('explicit layout: tab expanded/visible and section visible are author-controlled', () => {
  const spec = makeSpec();
  const form = { entity: 'new_item', name: 'Item', layout: 'explicit', tabs: [
    { label: 'Collapsed', expanded: false, sections: [{ label: 'A', fields: ['new_name'] }] },
    { label: 'Hidden', visible: false, sections: [{ label: 'B', visible: false, fields: ['new_status'] }] },
  ] };
  const intent = compileFormIntent(spec, form);
  assert.strictEqual(intent.tabs[0].expanded, false, 'expanded: false collapses the tab');
  assert.strictEqual(intent.tabs[0].visible, true, 'and leaves visibility alone');
  assert.strictEqual(intent.tabs[1].visible, false);
  assert.strictEqual(intent.tabs[1].columns[0].sections[0].visible, false);
});

test('explicit layout: multi-column tabs split width evenly unless authored', () => {
  const spec = makeSpec();
  const form = { entity: 'new_item', name: 'Item', layout: 'explicit', tabs: [{ label: 'G', columns: [
    { sections: [{ label: 'L', fields: ['new_name'] }] },
    { sections: [{ label: 'M', fields: ['new_status'] }] },
    { sections: [{ label: 'R', fields: ['new_cost'] }] },
  ] }] };
  const cols = compileFormIntent(spec, form).tabs[0].columns;
  assert.deepStrictEqual(cols.map((c) => c.width), ['34%', '33%', '33%'], 'widths total exactly 100');
  // Generated section names stay collision-free across columns while column 0 keeps the legacy
  // `section_<tab>_<i>` form, so already-deployed single-column forms still match themselves.
  assert.deepStrictEqual(cols.map((c) => c.sections[0].name), ['section_0_0', 'section_0_1_0', 'section_0_2_0']);
});

test('fieldCellIntent writes a span the author EXPRESSED, including an explicit 1', () => {
  // The real asymmetry is OMISSION vs VALUE, not 1 vs >1. An ordinary cell never passes a span at
  // all, so the "don't overwrite a hand-widened designer span" concern is served by omission — and
  // it is asserted below. Folding an explicit 1 to undefined additionally made a RESET
  // unrepresentable: 2 -> 1 compiled to "no colspan" and the deployed cell stayed at 2.
  assert.strictEqual(fieldCellIntent('new_name', { colspan: 1 }).colspan, 1, 'an explicit 1 is a claim and must be written');
  assert.strictEqual(fieldCellIntent('new_name', { rowspan: 1 }).rowspan, 1);
  assert.strictEqual(fieldCellIntent('new_name', { colspan: 3 }).colspan, 3);
  // The concern the old rule was protecting, stated directly: saying NOTHING must write nothing.
  assert.ok(!('colspan' in fieldCellIntent('new_name', {})), 'omission must not emit a span');
  assert.ok(!('rowspan' in fieldCellIntent('new_name', {})), 'omission must not emit a span');
  assert.ok(!('colspan' in fieldCellIntent('new_name', { colspan: undefined })), 'an undefined span is omission');
});
