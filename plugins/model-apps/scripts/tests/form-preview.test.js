'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { renderFormWireframe, renderForms } = require('../lib/form-preview.js');

function spec() {
  return {
    solution: { uniqueName: 'X', publisherPrefix: 'new' }, app: { name: 'X' },
    entities: [
      { schemaName: 'new_wo', displayName: 'Work Order', hasNotes: true,
        primaryAttribute: { schemaName: 'new_number', displayName: 'Order Number', autoNumberFormat: 'WO-{SEQNUM:5}' },
        columns: [
          { schemaName: 'new_status', displayName: 'Status', type: 'Choice', options: ['New', 'Done'] },
          { schemaName: 'new_cost', displayName: 'Total Cost', type: 'Money' },
          { schemaName: 'new_when', displayName: 'Scheduled', type: 'DateTime' },
        ] },
      { schemaName: 'new_assign', displayName: 'Assignment', primaryAttribute: { schemaName: 'new_name', displayName: 'Name' }, columns: [] },
    ],
    relationships: [{ type: 'OneToMany', referenced: 'new_wo', referencing: 'new_assign', lookup: { schemaName: 'new_woid', displayName: 'WO' } }],
    forms: [
      { entity: 'new_wo', name: 'Work Order',
        tabs: [{ label: 'Details', sections: [{ label: 'Order', columns: 2, fields: ['new_number', 'new_status', 'new_cost', 'new_when'] }] }],
        subgrids: [{ childEntity: 'new_assign', view: 'Assignments', label: 'Assignments' }],
        events: [{ event: 'onchange', attribute: 'new_status', library: 'x.js', function: 'X.onStatus' }] },
    ],
  };
}

test('renderFormWireframe shows title, section, fields+widgets, notes, sub-grids, and JS', () => {
  const w = renderFormWireframe(spec(), spec().forms[0]);
  assert.match(w, /Work Order/);
  assert.match(w, /Order/);            // section header
  assert.match(w, /Order Number \*/);  // primary attribute, required
  assert.match(w, /# auto/);           // AutoNumber widget hint
  assert.match(w, /▼ select/);         // Choice widget hint
  assert.match(w, /\$ amount/);        // Money widget hint
  assert.match(w, /date\/time/);       // DateTime widget hint
  assert.match(w, /Notes \/ Timeline/); // Notes section from hasNotes
  assert.match(w, /Sub-grids/);
  assert.match(w, /Assignments/);
  assert.match(w, /Form JS/);
  assert.match(w, /X\.onStatus/);
});

test('renderForms renders all forms and honors an entity filter', () => {
  const s = spec();
  assert.match(renderForms(s), /Work Order/);
  assert.strictEqual(renderForms(s, 'new_missing'), "(no forms in spec for 'new_missing')");
});
