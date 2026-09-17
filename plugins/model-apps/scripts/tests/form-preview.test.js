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

// The same hole as the hidden-single-tab case above, reached through the OTHER state flag: the
// banner was gated on `tabLabels.length > 1 || tab.visible === false`, so a lone COLLAPSED tab
// rendered no banner at all and previewed exactly like an ordinary open one — even though the
// comment above the line said collapsed state must be shown because this is the approval gate.
test('the wireframe shows a collapsed tab even when it is the only tab', () => {
  const s = spec();
  s.forms = [{ entity: 'new_wo', name: 'WO', layout: 'explicit', tabs: [
    { name: 't1', label: 'Only', expanded: false,
      sections: [{ name: 'a', label: 'Details', columns: 1, fields: ['new_status'] }] },
  ] }];
  const out = renderFormWireframe(s, s.forms[0]);
  assert.match(out, /\(collapsed\)/, `a collapsed tab must be shown even as the only tab:\n${out}`);
  assert.match(out, /▸/, 'and it must render with the collapsed marker, not the open one');
});

// The negative half of the rule: a lone tab in its DEFAULT state still gets no banner, so the
// common case stays uncluttered. Without this, "always show the banner" would pass the two tests
// above while making every single-tab wireframe noisier.
test('the wireframe still omits the banner for a single tab in its default state', () => {
  const s = spec();
  s.forms = [{ entity: 'new_wo', name: 'WO', layout: 'explicit', tabs: [
    { name: 't1', label: 'Only', sections: [{ name: 'a', label: 'Details', columns: 1, fields: ['new_status'] }] },
  ] }];
  const out = renderFormWireframe(s, s.forms[0]);
  assert.ok(!/▾ Only/.test(out), `an ordinary single tab needs no state banner:\n${out}`);
});

test('a single-column tab shows no column banner (the common case stays clean)', () => {
  const s = spec();
  s.forms = [{ entity: 'new_wo', name: 'WO', layout: 'explicit', tabs: [
    { name: 't1', label: 'Main', sections: [{ name: 'a', label: 'Only', columns: 1, fields: ['new_status'] }] },
  ] }];
  assert.doesNotMatch(renderFormWireframe(s, s.forms[0]), /column 1 of/);
});

// #591 — the wireframe is the form APPROVAL gate, but every bound cell rendered as an ordinary
// visible, editable field regardless of authored state. A maker could approve an apparently
// editable required field that deploys read-only, or a field they believe is visible that deploys
// hidden. Hidden tabs and sections were already annotated for exactly this reason; cells were not.
//
// Hidden cells are annotated rather than OMITTED, deliberately: the approval artifact should show
// that the field exists and is intentionally hidden, which dropping it cannot convey.
function stateSpec(fields, fieldOptions) {
  const s = spec();
  s.forms = [{
    entity: 'new_wo', name: 'WO', layout: 'explicit',
    tabs: [{ name: 't1', label: 'Main', columns: [{ sections: [{ name: 'a', label: 'Order', columns: 1, fields }] }] }],
  }];
  if (fieldOptions) s.forms[0].fieldOptions = fieldOptions;
  return s;
}
const render = (s) => renderFormWireframe(s, s.forms[0]);

test('the wireframe annotates a read-only field, a hidden field, and one that is both', () => {
  const plain = render(stateSpec(['new_status']));
  assert.match(plain, /Status/);
  assert.doesNotMatch(plain, /read-only|hidden/, `an ordinary field must carry NO state annotation:\n${plain}`);

  const ro = render(stateSpec([{ name: 'new_status', readOnly: true }]));
  assert.match(ro, /Status.*\(read-only\)/, `a read-only field must be annotated:\n${ro}`);

  const hid = render(stateSpec([{ name: 'new_status', hidden: true }]));
  assert.match(hid, /Status.*\(hidden\)/, `a hidden field must be annotated:\n${hid}`);
  assert.match(hid, /Status/, 'and must still be LISTED — omitting it hides the field from the approval');

  const both = render(stateSpec([{ name: 'new_status', hidden: true, readOnly: true }]));
  assert.match(both, /Status.*\(hidden, read-only\)/, `both states must be reported together:\n${both}`);
});

// The same state can be authored inline on the field entry OR through the form's `fieldOptions`
// map. They compile to the same cell, so the preview must not depend on which one the author used.
test('the wireframe annotates field state authored through fieldOptions as well as inline', () => {
  const viaOptions = render(stateSpec(['new_status', 'new_cost'], {
    new_status: { readOnly: true },
    new_cost: { hidden: true },
  }));
  assert.match(viaOptions, /Status.*\(read-only\)/, `fieldOptions readOnly must be shown:\n${viaOptions}`);
  assert.match(viaOptions, /Total Cost.*\(hidden\)/, `fieldOptions hidden must be shown:\n${viaOptions}`);
});

// The annotation sits BEFORE the widget hint on purpose. Cells are clipped to the column width —
// about 30 columns in a two-column section — so an annotation appended after the widget is exactly
// what `clip()` truncates away, and the approval gate would go back to hiding the state while
// looking like it reports it. Ordering by importance makes truncation degrade the widget instead.
test('field state survives clipping in a narrow two-column section', () => {
  const s = stateSpec([{ name: 'new_cost', readOnly: true }, { name: 'new_when', hidden: true }]);
  s.forms[0].tabs[0].columns[0].sections[0].columns = 2;
  const out = render(s);
  assert.match(out, /\(read-only\)/, `read-only state must survive a narrow column:\n${out}`);
  assert.match(out, /\(hidden\)/, `hidden state must survive a narrow column:\n${out}`);
});

// Putting the state before the widget is necessary but NOT sufficient. With a long display name in
// a two-column section the annotation itself is what `clip()` cuts, producing "(read-o…" or
// "(hidden, read-on…" — a half-printed state flag, which is precisely the silent-state failure the
// annotation exists to prevent. A truncated LABEL is still recognisable; a truncated state is not.
//
// So the renderer gives up the decorative widget hint first, and truncates the NAME after that,
// but never the state.
test('a long field name never truncates the state annotation', () => {
  const s = spec();
  s.entities[0].columns.push({
    schemaName: 'new_verylongfieldname',
    displayName: 'Extremely Long Inspection Field Name For Clipping',
    type: 'Money',
  });
  s.forms = [{
    entity: 'new_wo', name: 'WO', layout: 'explicit',
    tabs: [{ name: 't1', label: 'Main', columns: [{ sections: [{
      name: 'a', label: 'Order', columns: 2,
      fields: [{ name: 'new_verylongfieldname', hidden: true, readOnly: true }, { name: 'new_cost', readOnly: true }],
    }] }] }],
  }];
  const out = renderFormWireframe(s, s.forms[0]);
  assert.match(out, /\(hidden, read-only\)/, `the full state must survive a long name:\n${out}`);
  assert.match(out, /\(read-only\)/, `the second cell's state must survive too:\n${out}`);
  // And the guarantee stated positively: no rendered line may contain a state tag that was cut off.
  assert.doesNotMatch(out, /\((?:hidden|read-only)[^)]*…/, `a state tag was truncated mid-word:\n${out}`);
});
