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

test('notesCellIntent: returns exact shape with passed-in classId', () => {
  const cell = notesCellIntent('notes-class-guid');
  assert.deepStrictEqual(cell, {
    control: {
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

test('notesSectionIntent: wraps notesCellIntent in the correct section structure', () => {
  const sec = notesSectionIntent('notes-class-guid');
  assert.strictEqual(sec.name, 'section_notes');
  assert.strictEqual(sec.label, 'Notes');
  assert.strictEqual(sec.visible, true);
  assert.strictEqual(sec.showLabel, true);
  assert.strictEqual(sec.columns, 1);
  assert.strictEqual(sec.rows.length, 1);
  assert.strictEqual(sec.rows[0].cells.length, 1);
  assert.strictEqual(sec.rows[0].cells[0].control.classId, 'notes-class-guid');
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
