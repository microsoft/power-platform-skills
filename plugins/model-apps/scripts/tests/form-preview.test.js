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

test('renderFormWireframe shows multi-tab forms, truncates wide labels, and falls back to lookup hints', () => {
  const s = {
    solution: { uniqueName: 'X', publisherPrefix: 'new' },
    app: { name: 'X' },
    entities: [{
      schemaName: 'new_case',
      displayName: 'Case',
      primaryAttribute: { schemaName: 'new_name', displayName: 'Case Name' },
      columns: [{
        schemaName: 'new_description',
        displayName: 'Long description 🚀 '.repeat(8),
        type: 'Memo',
      }, {
        schemaName: 'new_notes',
        displayName: 'Notes',
        type: 'Memo',
      }],
    }],
    relationships: [],
    forms: [{
      entity: 'new_case',
      name: 'Case',
      tabs: [
        { label: 'Summary', sections: [{ label: 'Basics', fields: ['new_name'] }] },
        { label: 'Details', sections: [
          { label: 'Narrative', fields: ['new_description', 'new_missinglookupid'] },
          { label: 'Notes', fields: ['new_notes'] },
        ] },
      ],
    }],
  };

  const w = renderFormWireframe(s, s.forms[0]);

  assert.match(w, /Tabs:\s+‹Summary›\s+Details/);
  assert.match(w, /▾ Details/);
  assert.match(w, /…/, 'wide labels are clipped instead of breaking the wireframe border');
  assert.match(w, /\[text area\]/, 'Memo columns keep their multiline widget hint');
  assert.match(w, /new_missinglookupid\s+\[lookup\]/, 'unknown fields are treated as relationship lookups');
});

test('the wireframe shows a multi-column tab as columns, and a collapsed tab as collapsed', () => {
  const s = spec();
  s.forms = [{ entity: 'new_wo', name: 'WO', layout: 'explicit', tabs: [
    { name: 't1', label: 'Main', columns: [
      { width: '65%', sections: [{ name: 'a', label: 'Left', columns: 1, fields: ['new_status'] }] },
      { width: '35%', sections: [{ name: 'b', label: 'Right', columns: 1, fields: ['new_cost'] }] },
    ] },
    { name: 't2', label: 'Extra', expanded: false, sections: [{ name: 'c', label: 'More', columns: 1, fields: ['new_number'] }] },
  ] }];
  const out = renderFormWireframe(s, s.forms[0]);
  // The wireframe IS the approval gate: showing two form-columns stacked as one, or a collapsed
  // tab as open, promises a layout the build does not deploy.
  assert.match(out, /column 1 of 2.*65%/, `multi-column split not shown:\n${out}`);
  assert.match(out, /column 2 of 2.*35%/);
  assert.match(out, /Extra.*\(collapsed\)/, `collapsed state not shown:\n${out}`);
});

// The wireframe IS the layout approval gate, so anything it omits is something the user approves
// without seeing. Two states were invisible: a hidden tab when it is the ONLY tab (the banner was
// gated on tab count), and a section whose heading Dataverse will not render at all.
test('the wireframe shows a hidden single tab, and a showLabel:false section as having no heading', () => {
  const s = spec();
  s.forms = [{ entity: 'new_wo', name: 'WO', layout: 'explicit', tabs: [
    { name: 't1', label: 'Only', visible: false,
      sections: [{ name: 'a', label: 'Suppressed Heading', showLabel: false, columns: 1, fields: ['new_status'] }] },
  ] }];
  const out = renderFormWireframe(s, s.forms[0]);
  assert.match(out, /\(hidden\)/, `a hidden tab must be shown even as the only tab:\n${out}`);
  assert.ok(!/Suppressed Heading/.test(out), `a showLabel:false section must not promise a heading:\n${out}`);
  assert.match(out, /no heading/, 'and the preview should say so explicitly');
});

test('a single-column tab shows no column banner (the common case stays clean)', () => {
  const s = spec();
  s.forms = [{ entity: 'new_wo', name: 'WO', layout: 'explicit', tabs: [
    { name: 't1', label: 'Main', sections: [{ name: 'a', label: 'Only', columns: 1, fields: ['new_status'] }] },
  ] }];
  assert.doesNotMatch(renderFormWireframe(s, s.forms[0]), /column 1 of/);
});
