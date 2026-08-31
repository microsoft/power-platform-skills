'use strict';
// Per-field form control options: read-only, hidden, targeted repositioning, plus the auto-layout
// exclusion of column types the Unified Interface cannot render.
//
// Covers ADO 6648516 (no per-field read-only), 6651241 (no per-field hidden), 6651439 (no targeted
// reordering — explicit layout prunes unlisted fields), and 6651696 (auto layout places BigInt
// columns that render "Error loading control").
//
// The SDK-facing shapes asserted here were MEASURED against the vendored bundle, not read off its
// types. The FormXml serializer emits:
//   <cell    id="…" showlabel="…" visible="${cell.visible}"      colspan="…" rowspan="…">
//   <control id="…" classid="…"  disabled="${control.isReadOnly}" isrequired="…">
// so visibility is a CELL property and read-only is a CONTROL property. Writing either onto the
// wrong object is silently dropped at serialize time, which is exactly the failure these tests pin.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const {
  compileFormIntent,
  fieldCellIntent,
  formFieldLogicals,
  findFieldCellLocation,
  normalizeFieldEntry,
  fieldOptionsMap,
  NON_FORM_RENDERABLE_TYPES,
} = require(path.join(__dirname, '..', 'lib', 'artifact-intent.js'));
const { validateAppSpec } = require(path.join(__dirname, '..', 'lib', 'app-spec.js'));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// One table carrying a BigInt alongside ordinary scalars, so an exclusion test cannot pass merely
// because nothing else was on the form.
function specWithBigInt(formExtra) {
  return {
    solution: { uniqueName: 'S', publisherPrefix: 'new' },
    app: { name: 'A' },
    entities: [{
      schemaName: 'new_item',
      displayName: 'Item',
      primaryAttribute: { schemaName: 'new_name', displayName: 'Name' },
      columns: [
        { schemaName: 'new_duedate', displayName: 'Due Date', type: 'DateTime' },
        { schemaName: 'new_tracking', displayName: 'External Tracking Number', type: 'BigInt' },
        { schemaName: 'new_points', displayName: 'Story Points', type: 'Integer' },
        { schemaName: 'new_daysremaining', displayName: 'Days Remaining', type: 'Integer' },
      ],
    }],
    relationships: [],
    forms: [Object.assign({ entity: 'new_item', name: 'Item' }, formExtra || {})],
  };
}

const logicalsOf = (intent) => formFieldLogicals(intent);
// Walk to the single auto-layout section's cells so a test can assert on cell/control shape.
const autoCells = (intent) => intent.tabs[0].columns[0].sections[0].rows.flatMap((r) => r.cells);
const cellFor = (intent, logical) => autoCells(intent).find((c) => c.control && c.control.fieldName === logical);

// ---------------------------------------------------------------------------
// fieldCellIntent — the cell/control shape
// ---------------------------------------------------------------------------

test('fieldCellIntent: readOnly lands on the CONTROL as isReadOnly (the serializer reads control.isReadOnly)', () => {
  const cell = fieldCellIntent('new_number', { readOnly: true });
  assert.strictEqual(cell.control.isReadOnly, true);
  assert.strictEqual(cell.control.fieldName, 'new_number');
  assert.ok(!('visible' in cell), 'read-only must not touch cell visibility');
});

test('fieldCellIntent: hidden lands on the CELL as visible:false (the serializer reads cell.visible)', () => {
  const cell = fieldCellIntent('new_points', { hidden: true });
  assert.strictEqual(cell.visible, false);
  assert.ok(!('isReadOnly' in cell.control), 'hidden must not disable the control');
});

test('fieldCellIntent: neither flag is written when not asked for — the build never emits the negation', () => {
  const cell = fieldCellIntent('new_name', { isRequired: true });
  assert.ok(!('visible' in cell), 'an ordinary field must not pin visible:true');
  assert.ok(!('isReadOnly' in cell.control), 'an ordinary field must not pin isReadOnly:false');
  // Writing the negation would overwrite a lock/hide a maker applied by hand on every rebuild.
  assert.deepStrictEqual(Object.keys(cell), ['control']);
});

test('fieldCellIntent: both flags compose on one field', () => {
  const cell = fieldCellIntent('new_secret', { readOnly: true, hidden: true, isRequired: true });
  assert.strictEqual(cell.control.isReadOnly, true);
  assert.strictEqual(cell.control.isRequired, true);
  assert.strictEqual(cell.visible, false);
});

// ---------------------------------------------------------------------------
// 6651696 — BigInt is not form-renderable
// ---------------------------------------------------------------------------

test('auto layout omits BigInt columns — UCI has no control for them ("Error loading control")', () => {
  const spec = specWithBigInt();
  const intent = compileFormIntent(spec, spec.forms[0]);
  const fields = logicalsOf(intent);
  assert.ok(!fields.includes('new_tracking'), `BigInt placed on the auto form: ${fields.join(', ')}`);
});

test('auto layout still places every OTHER scalar type — the BigInt skip is not an over-broad filter', () => {
  const spec = specWithBigInt();
  const fields = logicalsOf(compileFormIntent(spec, spec.forms[0]));
  for (const expected of ['new_name', 'new_duedate', 'new_points', 'new_daysremaining']) {
    assert.ok(fields.includes(expected), `${expected} missing from the auto form: ${fields.join(', ')}`);
  }
});

test('an EXPLICIT layout still honours an authored BigInt — the author is not overridden, only warned', () => {
  const spec = specWithBigInt({
    layout: 'explicit',
    tabs: [{ label: 'General', sections: [{ label: 'D', columns: 1, fields: ['new_name', 'new_tracking'] }] }],
  });
  const fields = logicalsOf(compileFormIntent(spec, spec.forms[0]));
  assert.ok(fields.includes('new_tracking'), 'explicit layout must place what the author listed');
  const res = validateAppSpec(spec, { profile: 'deploy' });
  assert.ok(res.warnings.some((w) => /new_tracking/.test(w) && /BigInt/i.test(w)), `expected a BigInt warning, got: ${res.warnings.join(' | ')}`);
});

test('NON_FORM_RENDERABLE_TYPES is keyed by App Spec type name, matching entity.columns[].type', () => {
  assert.ok(NON_FORM_RENDERABLE_TYPES.has('BigInt'));
  assert.ok(!NON_FORM_RENDERABLE_TYPES.has('Integer'), 'Integer renders fine and must not be excluded');
});

// ---------------------------------------------------------------------------
// 6648516 / 6651241 — reaching the flags from both layouts
// ---------------------------------------------------------------------------

test('fieldOptions reaches an AUTO layout — the only route, since auto has no field list', () => {
  const spec = specWithBigInt({ fieldOptions: { new_points: { hidden: true }, new_duedate: { readOnly: true } } });
  const intent = compileFormIntent(spec, spec.forms[0]);
  assert.strictEqual(cellFor(intent, 'new_points').visible, false);
  assert.strictEqual(cellFor(intent, 'new_duedate').control.isReadOnly, true);
  assert.ok(!('visible' in cellFor(intent, 'new_name')), 'an unlisted field is untouched');
});

test('an EXPLICIT layout accepts an inline object field entry', () => {
  const spec = specWithBigInt({
    layout: 'explicit',
    tabs: [{ label: 'G', sections: [{ label: 'D', columns: 1, fields: ['new_name', { name: 'new_points', readOnly: true }, { name: 'new_duedate', hidden: true }] }] }],
  });
  const intent = compileFormIntent(spec, spec.forms[0]);
  const cells = intent.tabs[0].columns[0].sections[0].rows.flatMap((r) => r.cells);
  const byName = (n) => cells.find((c) => c.control.fieldName === n);
  assert.strictEqual(byName('new_points').control.isReadOnly, true);
  assert.strictEqual(byName('new_duedate').visible, false);
  assert.ok(!('isReadOnly' in byName('new_name').control));
});

test('a plain string field entry still works — the object form is additive, not a migration', () => {
  const spec = specWithBigInt({
    layout: 'explicit',
    tabs: [{ label: 'G', sections: [{ label: 'D', columns: 1, fields: ['new_name', 'new_points'] }] }],
  });
  const intent = compileFormIntent(spec, spec.forms[0]);
  assert.deepStrictEqual(logicalsOf(intent), ['new_name', 'new_points']);
});

test('an inline entry OVERRIDES the form-level fieldOptions default for the same field', () => {
  const spec = specWithBigInt({
    layout: 'explicit',
    fieldOptions: { new_points: { readOnly: true, hidden: true } },
    tabs: [{ label: 'G', sections: [{ label: 'D', columns: 1, fields: [{ name: 'new_points', readOnly: true }] }] }],
  });
  const intent = compileFormIntent(spec, spec.forms[0]);
  const cell = intent.tabs[0].columns[0].sections[0].rows[0].cells[0];
  assert.strictEqual(cell.control.isReadOnly, true);
  // hidden came only from the form-level default, which still applies where the inline entry is silent.
  assert.strictEqual(cell.visible, false);
});

test('normalizeFieldEntry lower-cases both name and anchor (every downstream compare is lower-case)', () => {
  assert.deepStrictEqual(normalizeFieldEntry('New_Name'), { name: 'new_name', readOnly: false, hidden: false, after: undefined });
  assert.deepStrictEqual(normalizeFieldEntry({ name: 'New_B', after: 'New_A' }), { name: 'new_b', readOnly: false, hidden: false, after: 'new_a' });
});

test('fieldOptionsMap ignores a non-object entry rather than throwing on a half-typed spec', () => {
  const map = fieldOptionsMap({ fieldOptions: { a: { readOnly: true }, b: 'nope', c: null } });
  assert.deepStrictEqual(Object.keys(map), ['a']);
});

// ---------------------------------------------------------------------------
// 6651439 — targeted repositioning
// ---------------------------------------------------------------------------

test('after: an anchored field is repositioned in the compiled AUTO order (create and rebuild agree)', () => {
  const spec = specWithBigInt({ fieldOptions: { new_daysremaining: { after: 'new_duedate' } } });
  const fields = logicalsOf(compileFormIntent(spec, spec.forms[0]));
  // Declaration order is name, duedate, points, daysremaining (tracking is excluded as BigInt).
  assert.deepStrictEqual(fields, ['new_name', 'new_duedate', 'new_daysremaining', 'new_points']);
});

test('after: the def carries __fieldPositions and NO cell leaks an `after` key to the SDK', () => {
  const spec = specWithBigInt({ fieldOptions: { new_daysremaining: { after: 'new_duedate' } } });
  const intent = compileFormIntent(spec, spec.forms[0]);
  assert.deepStrictEqual(intent.__fieldPositions, { new_daysremaining: 'new_duedate' });
  // A cell is pushed verbatim through addElement; `after` is not part of the SDK cell model, so it
  // must never appear there or it would be rejected or serialized into the FormXml.
  for (const cell of autoCells(intent)) {
    assert.ok(!('after' in cell), 'a cell leaked `after`');
    assert.ok(!('after' in cell.control), 'a control leaked `after`');
  }
});

test('after: a chain resolves against the running order, so b-after-a then c-after-b reads naturally', () => {
  const spec = specWithBigInt({ fieldOptions: { new_points: { after: 'new_name' }, new_daysremaining: { after: 'new_points' } } });
  const fields = logicalsOf(compileFormIntent(spec, spec.forms[0]));
  assert.deepStrictEqual(fields, ['new_name', 'new_points', 'new_daysremaining', 'new_duedate']);
});

test('after: moving a field FORWARD (source before anchor) lands directly after the anchor, not one past it', () => {
  // The compensation case the naive implementation gets wrong: splicing the source out first shifts
  // the anchor DOWN by one, so an anchor index captured before the removal overshoots.
  // Declaration order: name(0), duedate(1), points(2), daysremaining(3).
  const spec = specWithBigInt({ fieldOptions: { new_name: { after: 'new_points' } } });
  const fields = logicalsOf(compileFormIntent(spec, spec.forms[0]));
  assert.deepStrictEqual(fields, ['new_duedate', 'new_points', 'new_name', 'new_daysremaining'],
    'new_name must sit immediately after new_points, not after new_daysremaining');
});

test('after: a cell never carries the anchor, even if a caller passes one to fieldCellIntent', () => {
  // `after` is engine-only metadata. A cell is pushed verbatim through addElement, so any stray key
  // would be rejected by the structural validator or serialized into the FormXml.
  const cell = fieldCellIntent('new_points', { readOnly: true, hidden: true, after: 'new_name', isRequired: true });
  assert.deepStrictEqual(Object.keys(cell).sort(), ['control', 'visible']);
  assert.deepStrictEqual(Object.keys(cell.control).sort(), ['fieldName', 'isReadOnly', 'isRequired']);
});

test('after: an anchor that is not on the form is ignored, not an error (it may be a column we do not place)', () => {
  const spec = specWithBigInt({ fieldOptions: { new_points: { after: 'new_tracking' } } });
  const fields = logicalsOf(compileFormIntent(spec, spec.forms[0]));
  assert.deepStrictEqual(fields, ['new_name', 'new_duedate', 'new_points', 'new_daysremaining'], 'order unchanged');
});

test('after: an anchored field CONVERGES in a 2-column section — a rebuild of a correct form issues no move', () => {
  // The auto layout switches to 2 columns above 6 fields, so this is the common shape, not an edge
  // case. A section is a grid: `[a|b] [c|d]` reads a, b, c, d, so a field can sit correctly
  // immediately after its anchor while living in the NEXT row. Testing row-local adjacency reported
  // that as misplaced and moved it on every rebuild, leaving a 3-cell row in a 2-column section.
  const spec = {
    solution: { uniqueName: 'S', publisherPrefix: 'new' },
    app: { name: 'A' },
    entities: [{
      schemaName: 'new_item', displayName: 'Item',
      primaryAttribute: { schemaName: 'new_name', displayName: 'Name' },
      columns: ['new_c1', 'new_c2', 'new_c3', 'new_c4', 'new_c5', 'new_c6', 'new_c7'].map((n) => ({ schemaName: n, type: 'Text' })),
    }],
    relationships: [],
    forms: [{ entity: 'new_item', name: 'F', fieldOptions: { new_c6: { after: 'new_c1' } } }],
  };
  const intent = compileFormIntent(spec, spec.forms[0]);
  const section = intent.tabs[0].columns[0].sections[0];
  assert.strictEqual(section.columns, 2, 'this fixture must produce the 2-column layout the bug needs');

  // The compiled form is already correct: c6 sits flat-adjacent after c1, in the next row.
  const form = { tabs: intent.tabs };
  const from = findFieldCellLocation(form, 'new_c6');
  const to = findFieldCellLocation(form, 'new_c1');
  assert.notStrictEqual(from.rowIndex, to.rowIndex, 'the fixture must straddle a row boundary, or it proves nothing');
  assert.strictEqual(from.sectionPointer, to.sectionPointer);
  assert.strictEqual(from.flatIndex, to.flatIndex + 1,
    'c6 must be flat-adjacent after c1 — this is the condition the reconcile uses to skip the move');
});

test('after: an anchor is recorded even for a field this layout does not place (the prune:false case)', () => {
  // Validation permits a form-level anchor for a field an explicit layout does not list — that IS
  // the documented `prune: false` use: position a control on a deployed form without re-declaring
  // the rest of it. Recording anchors only for PLACED fields made that combination silently inert.
  const spec = specWithBigInt({
    layout: 'explicit',
    prune: false,
    fieldOptions: { new_daysremaining: { after: 'new_duedate' } },
    tabs: [{ label: 'G', sections: [{ columns: 1, fields: ['new_name'] }] }],
  });
  const intent = compileFormIntent(spec, spec.forms[0]);
  assert.deepStrictEqual(logicalsOf(intent), ['new_name'], 'the layout still places only what it lists');
  assert.deepStrictEqual(intent.__fieldPositions, { new_daysremaining: 'new_duedate' },
    'the anchor must survive for the reconcile to apply against the deployed form');
  assert.deepStrictEqual(validateAppSpec(spec, { profile: 'deploy' }).errors, []);
});

test('prune: __prune defaults true and is false only when the form opts out', () => {
  const base = specWithBigInt({ layout: 'explicit', tabs: [{ label: 'G', sections: [{ fields: ['new_name'] }] }] });
  assert.strictEqual(compileFormIntent(base, base.forms[0]).__prune, true);
  const opted = specWithBigInt({ layout: 'explicit', prune: false, tabs: [{ label: 'G', sections: [{ fields: ['new_name'] }] }] });
  assert.strictEqual(compileFormIntent(opted, opted.forms[0]).__prune, false);
});

// ---------------------------------------------------------------------------
// findFieldCellLocation — the move target maths
// ---------------------------------------------------------------------------

test('findFieldCellLocation returns the containing arrays, indices, and the SECTION-FLAT position', () => {
  const form = {
    tabs: [{ columns: [{ sections: [{ rows: [
      { cells: [{ control: { fieldName: 'a' } }, { control: { fieldName: 'b' } }] },
      { cells: [{ control: { fieldName: 'c' } }] },
    ] }] }] }],
  };
  assert.deepStrictEqual(findFieldCellLocation(form, 'b'), {
    sectionPointer: '/tabs/0/columns/0/sections/0',
    rowsPointer: '/tabs/0/columns/0/sections/0/rows',
    rowPointer: '/tabs/0/columns/0/sections/0/rows/0',
    cellsPointer: '/tabs/0/columns/0/sections/0/rows/0/cells',
    cellPointer: '/tabs/0/columns/0/sections/0/rows/0/cells/1',
    rowIndex: 0, cellIndex: 1, flatIndex: 1, rowCellCount: 2,
  });
  // `c` is in the NEXT row but is flat-adjacent to `b` — the case row-local adjacency gets wrong.
  const c = findFieldCellLocation(form, 'c');
  assert.strictEqual(c.flatIndex, 2, 'flatIndex must continue across rows, not reset per row');
  assert.strictEqual(c.rowIndex, 1);
  assert.strictEqual(c.rowCellCount, 1, 'a lone cell is detected so the ROW can be moved');
  assert.strictEqual(findFieldCellLocation(form, 'zzz'), null);
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const errsFor = (spec) => validateAppSpec(spec, { profile: 'deploy' }).errors;
const warnsFor = (spec) => validateAppSpec(spec, { profile: 'deploy' }).warnings;

test('validation rejects readOnly:false — the build only ever writes the ENABLED state', () => {
  const spec = specWithBigInt({ fieldOptions: { new_points: { readOnly: false } } });
  assert.ok(errsFor(spec).some((e) => /readOnly: false/.test(e)), errsFor(spec).join(' | '));
});

test('validation rejects hidden:false for the same reason', () => {
  const spec = specWithBigInt({ fieldOptions: { new_points: { hidden: false } } });
  assert.ok(errsFor(spec).some((e) => /hidden: false/.test(e)));
});

test('validation rejects a non-boolean flag rather than coercing it ("false" is truthy)', () => {
  const spec = specWithBigInt({ fieldOptions: { new_points: { readOnly: 'true' } } });
  assert.ok(errsFor(spec).some((e) => /readOnly must be a boolean/.test(e)));
});

test('validation rejects `after` inside an explicit tabs layout — two competing orderings', () => {
  const spec = specWithBigInt({
    layout: 'explicit',
    tabs: [{ label: 'G', sections: [{ fields: [{ name: 'new_points', after: 'new_name' }, 'new_name'] }] }],
  });
  assert.ok(errsFor(spec).some((e) => /cannot use 'after' for a field an explicit tabs layout already lists/.test(e)), errsFor(spec).join(' | '));
});

test('validation rejects a form-level `after` for a field the explicit layout LISTS (create and rebuild would disagree)', () => {
  // The create path honours the authored list; the reconcile applies the anchor. Allowing both makes
  // the same spec produce one order on a new form and another on its first rebuild.
  const spec = specWithBigInt({
    layout: 'explicit',
    fieldOptions: { new_points: { after: 'new_name' } },
    tabs: [{ label: 'G', sections: [{ fields: ['new_name', 'new_points'] }] }],
  });
  assert.ok(errsFor(spec).some((e) => /cannot use 'after' for a field an explicit tabs layout already lists/.test(e)), errsFor(spec).join(' | '));
});

test('validation ALLOWS a form-level `after` for a field the explicit layout does not list (the prune:false case)', () => {
  const spec = specWithBigInt({
    layout: 'explicit',
    prune: false,
    fieldOptions: { new_daysremaining: { after: 'new_duedate' } },
    tabs: [{ label: 'G', sections: [{ fields: ['new_name'] }] }],
  });
  assert.deepStrictEqual(errsFor(spec), [], 'positioning a control the layout does not re-declare is the whole point of prune:false');
});

test('validation rejects a non-array fields[] instead of letting the compiler throw a raw TypeError', () => {
  // A string is iterable and every character IS a string, so a naive per-entry check passes and the
  // compiler then dies on `(s.fields || []).map is not a function`.
  const spec = specWithBigInt({ layout: 'explicit', tabs: [{ label: 'G', sections: [{ fields: 'new_name' }] }] });
  assert.ok(errsFor(spec).some((e) => /fields must be an array/.test(e)), errsFor(spec).join(' | '));
});

test('validation rejects a self-anchor', () => {
  const spec = specWithBigInt({ fieldOptions: { new_points: { after: 'new_points' } } });
  assert.ok(errsFor(spec).some((e) => /after itself/.test(e)));
});

test('validation rejects a fieldOptions map that is not an object', () => {
  assert.ok(errsFor(specWithBigInt({ fieldOptions: ['new_points'] })).some((e) => /fieldOptions must be an object/.test(e)));
  assert.ok(errsFor(specWithBigInt({ fieldOptions: { new_points: 'readOnly' } })).some((e) => /must be an object/.test(e)));
});

test('validation rejects a field entry object with no name', () => {
  const spec = specWithBigInt({ layout: 'explicit', tabs: [{ label: 'G', sections: [{ fields: [{ readOnly: true }] }] }] });
  assert.ok(errsFor(spec).some((e) => /missing a string 'name'/.test(e)));
});

test('validation rejects a field entry that is neither a string nor an object', () => {
  const spec = specWithBigInt({ layout: 'explicit', tabs: [{ label: 'G', sections: [{ fields: [42] }] }] });
  assert.ok(errsFor(spec).some((e) => /must be a column logical name or an object/.test(e)));
});

test('validation warns that prune:false is meaningless on an auto layout', () => {
  assert.ok(warnsFor(specWithBigInt({ prune: false })).some((w) => /prune: false has no effect on an auto layout/.test(w)));
});

test('validation rejects a non-boolean prune', () => {
  assert.ok(errsFor(specWithBigInt({ prune: 'no' })).some((e) => /prune must be a boolean/.test(e)));
});

test('a spec using every new option validates clean', () => {
  const spec = specWithBigInt({ fieldOptions: { new_points: { readOnly: true }, new_duedate: { hidden: true }, new_daysremaining: { after: 'new_duedate' } } });
  const res = validateAppSpec(spec, { profile: 'deploy' });
  assert.deepStrictEqual(res.errors, [], res.errors.join(' | '));
});

test('validation does not THROW on a non-iterable fields (the BigInt scan re-iterates the same array)', () => {
  // The array guard `continue`s the FIRST loop only; the explicit-layout BigInt scan re-iterates
  // `s.fields`, so a non-iterable value threw a raw TypeError out of validateAppSpec and discarded
  // the correct finding the first loop had already pushed.
  for (const bad of [{}, 3, true]) {
    const spec = specWithBigInt({ layout: 'explicit', tabs: [{ label: 'G', sections: [{ fields: bad }] }] });
    let res;
    assert.doesNotThrow(() => { res = validateAppSpec(spec, { profile: 'deploy' }); }, `threw on fields: ${JSON.stringify(bad)}`);
    assert.ok(res.errors.some((e) => /fields must be an array/.test(e)), `no finding for fields: ${JSON.stringify(bad)}`);
  }
});
