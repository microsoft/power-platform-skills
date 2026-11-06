'use strict';
// Guards four reported defects:
//   AB#6648516 — no per-field read-only/locked control on forms
//   AB#6651241 — no per-field hidden/visibility control on forms
//   AB#6651439 — no targeted form-control reordering (explicit layout pruned unlisted fields)
//   AB#6651696 — auto form layout added Big Integer columns that cannot render
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
const { makeTempDir } = require('./helpers/temp-dirs.js');

const {
  compileFormIntent,
  fieldCellIntent,
  formFieldLogicals,
  findFieldCellLocation,
  findFieldCellLocations,
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
  assert.deepStrictEqual(normalizeFieldEntry('New_Name'), { name: 'new_name', readOnly: false, hidden: false, after: undefined, colspan: undefined, rowspan: undefined });
  assert.deepStrictEqual(normalizeFieldEntry({ name: 'New_B', after: 'New_A' }), { name: 'new_b', readOnly: false, hidden: false, after: 'new_a', colspan: undefined, rowspan: undefined });
});

test('normalizeFieldEntry keeps an explicit span, including 1, and drops only omission', () => {
  // An explicit `colspan: 1` is the author CLAIMING the default, which is different from saying
  // nothing. The old rule folded both to undefined, so a reset from 2 to 1 was unrepresentable and
  // the deployed cell kept its old span — live-reproduced across two applies.
  assert.strictEqual(normalizeFieldEntry({ name: 'a', colspan: 1 }).colspan, 1);
  assert.strictEqual(normalizeFieldEntry({ name: 'a', rowspan: 1 }).rowspan, 1);
  assert.strictEqual(normalizeFieldEntry({ name: 'a', colspan: 2 }).colspan, 2);
  assert.strictEqual(normalizeFieldEntry({ name: 'a', rowspan: 3 }).rowspan, 3);
  // Omission stays omission — this is what keeps an ordinary cell from overwriting a span widened
  // by hand in the designer.
  assert.strictEqual(normalizeFieldEntry({ name: 'a' }).colspan, undefined);
  assert.strictEqual(normalizeFieldEntry('a').colspan, undefined);
  // Non-numeric, fractional and nonsensical values must not reach the serializer as-is.
  assert.strictEqual(normalizeFieldEntry({ name: 'a', colspan: 'wide' }).colspan, undefined);
  assert.strictEqual(normalizeFieldEntry({ name: 'a', colspan: 0 }).colspan, undefined);
  assert.strictEqual(normalizeFieldEntry({ name: 'a', colspan: -2 }).colspan, undefined);
  assert.strictEqual(normalizeFieldEntry({ name: 'a', colspan: 2.7 }).colspan, 2);
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

test('after: a chain declared in REVERSE dependency order still produces a create order that satisfies it', () => {
  // The anchor walk is in entity-column order, not the author's fieldOptions order, so a single pass
  // can place a field against an anchor that is itself relocated later — leaving a create order that
  // violates its own anchors, which the first rebuild then silently "fixes". The reorder therefore
  // runs to a fixed point. Declaration order must not matter.
  //
  // The fixture matters: the chain must have a NON-PARTICIPATING cell between the anchor and its
  // dependent, or the dependency-violating move is a no-op and single-pass code passes too. Here the
  // second move must cross `new_duedate`. Verified red-green — the pre-fix single-pass body yields
  // `new_name, new_daysremaining, new_duedate, new_points`, which does not satisfy its own anchors.
  const forward = specWithBigInt({ fieldOptions: { new_daysremaining: { after: 'new_name' }, new_points: { after: 'new_daysremaining' } } });
  const reverse = specWithBigInt({ fieldOptions: { new_points: { after: 'new_daysremaining' }, new_daysremaining: { after: 'new_name' } } });
  const want = ['new_name', 'new_daysremaining', 'new_points', 'new_duedate'];
  assert.deepStrictEqual(logicalsOf(compileFormIntent(forward, forward.forms[0])), want);
  assert.deepStrictEqual(logicalsOf(compileFormIntent(reverse, reverse.forms[0])), want, 'declaration order changed the result');
});

test('validation rejects two fields anchored after the SAME field (they would fight forever)', () => {
  const spec = specWithBigInt({ fieldOptions: { new_points: { after: 'new_duedate' }, new_daysremaining: { after: 'new_duedate' } } });
  // Each build moves one to anchor+1 and then the other, displacing the first — a no-op pair
  // re-issued on every rebuild, which is exactly the non-convergence the anchor work exists to end.
  assert.ok(errsFor(spec).some((e) => /both anchored after 'new_duedate'/.test(e)), errsFor(spec).join(' | '));
});

test('validation rejects an anchor cycle — no order satisfies it', () => {
  const two = specWithBigInt({ fieldOptions: { new_points: { after: 'new_duedate' }, new_duedate: { after: 'new_points' } } });
  assert.ok(errsFor(two).some((e) => /form a cycle/.test(e)), errsFor(two).join(' | '));
  const three = specWithBigInt({ fieldOptions: { new_points: { after: 'new_duedate' }, new_duedate: { after: 'new_daysremaining' }, new_daysremaining: { after: 'new_points' } } });
  assert.ok(errsFor(three).some((e) => /form a cycle/.test(e)), errsFor(three).join(' | '));
  // A plain chain is NOT a cycle and must stay legal.
  const chain = specWithBigInt({ fieldOptions: { new_points: { after: 'new_duedate' }, new_daysremaining: { after: 'new_points' } } });
  assert.deepStrictEqual(errsFor(chain), []);
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

test('findFieldCellLocations returns EVERY cell of a field the form holds more than once, in form order — and findFieldCellLocation the first', () => {
  const quickView = { fieldName: 'b', classId: '{5C5600E0-1D6E-4205-A272-BE80DA87FD42}' };
  const form = {
    tabs: [
      { columns: [{ sections: [{ rows: [
        { cells: [{ control: { fieldName: 'a' } }, { control: { fieldName: 'B' } }] },
        { cells: [{ control: quickView }] },
      ] }, { rows: [{ cells: [{ control: { fieldName: 'b' } }] }] }] }] },
      { columns: [{ sections: [{ rows: [{ cells: [{ control: { fieldName: 'b' } }] }] }] }] },
    ],
  };
  const all = findFieldCellLocations(form, 'b');
  assert.deepStrictEqual(all.map((l) => l.cellPointer), [
    '/tabs/0/columns/0/sections/0/rows/0/cells/1',
    '/tabs/0/columns/0/sections/1/rows/0/cells/0',
    '/tabs/1/columns/0/sections/0/rows/0/cells/0',
  ], 'each placement, across sections and tabs, matched case-insensitively — and never the quick-view control that carries the field as its lookup');
  assert.deepStrictEqual(all[0], findFieldCellLocation(form, 'b'), 'the first is the one findFieldCellLocation gives');
  assert.deepStrictEqual(findFieldCellLocations(form, 'a').length, 1);
  assert.deepStrictEqual(findFieldCellLocations(form, 'zzz'), []);
  assert.deepStrictEqual(findFieldCellLocations({}, 'b'), [], 'a form with no tabs has no cells');
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

// A form-level span reaches the compiler through mergeFieldOptions exactly as an inline one does, so
// it must meet the same rules. Before, a bad value was dropped in silence, and a form-level rowspan
// skipped the trailing rule entirely: under an auto layout `{ new_points: { rowspan: 2 } }` compiled
// a reservation directly above the next field.
test('validation checks a fieldOptions span the way it checks an inline one', () => {
  for (const bad of [0, -1, 1.5, 'abc', '2']) {
    const errs = errsFor(specWithBigInt({ fieldOptions: { new_points: { colspan: bad } } }));
    assert.ok(errs.some((e) => /fieldOptions\['new_points'\] has colspan .* whole number/.test(e)), `colspan ${JSON.stringify(bad)}: ${errs.join(' | ')}`);
  }
  for (const good of [1, 2, 4]) {
    assert.deepStrictEqual(errsFor(specWithBigInt({ fieldOptions: { new_points: { colspan: good } } })), [], `colspan ${good}`);
  }
});

test('validation rejects a form-level rowspan above 1 under either layout, and still allows rowspan 1', () => {
  const auto = specWithBigInt({ fieldOptions: { new_points: { rowspan: 2 } } });
  const explicit = specWithBigInt({
    layout: 'explicit',
    fieldOptions: { new_points: { rowspan: 2 } },
    tabs: [{ label: 'G', sections: [{ columns: 2, fields: ['new_name', 'new_points', 'new_duedate'] }] }],
  });
  for (const [lbl, spec] of [['auto', auto], ['explicit', explicit]]) {
    const errs = errsFor(spec);
    assert.ok(errs.some((e) => /sets rowspan 2, which only an explicit layout can place safely/.test(e) && /"name": "new_points", "rowspan": 2/.test(e)), `${lbl}: ${errs.join(' | ')}`);
  }
  // rowspan 1 is the explicit "narrow back" claim and places nothing beneath the cell.
  assert.deepStrictEqual(errsFor(specWithBigInt({ fieldOptions: { new_points: { rowspan: 1 } } })), []);
  // The inline route stays open for the one safe position — the LAST field of a section.
  const inlineLast = specWithBigInt({
    layout: 'explicit',
    tabs: [{ label: 'G', sections: [{ columns: 2, fields: ['new_name', 'new_duedate', { name: 'new_points', rowspan: 2 }] }] }],
  });
  assert.deepStrictEqual(errsFor(inlineLast), []);
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

// --- layout: 'explicit' with no tabs -------------------------------------------------------------
//
// PR review: `validateFormFieldOptions` treats `layout: 'explicit'` as an explicit layout even
// without `tabs`, but `compileFormIntent` takes the explicit path only when `tabs` is an ARRAY. So
// such a spec validated green and then compiled an AUTO layout, while `prune` and the field
// positioning rules read to the author as explicit-layout behaviour.
//
// Rejected rather than warned: the two layouts differ in whether a rebuild REMOVES deployed fields,
// so guessing wrong is destructive.

const { validateAppSpec: validateSpec } = require('../lib/app-spec.js');
const { compileFormIntent: compileIntent } = require('../lib/artifact-intent.js');

function layoutSpec(form) {
  return {
    solution: { uniqueName: 'L', displayName: 'L', publisherPrefix: 'new' },
    app: { name: 'L App', description: 'd' },
    entities: [{
      schemaName: 'new_ticket', displayName: 'Ticket', pluralName: 'Tickets',
      primaryAttribute: { schemaName: 'new_subject', displayName: 'Subject' },
      columns: [{ schemaName: 'new_notes', displayName: 'Notes', type: 'Memo' }],
    }],
    forms: [{ entity: 'new_ticket', name: 'F', ...form }],
    appShell: { areas: [{ label: 'M', groups: [{ label: 'G', subAreas: [{ entity: 'new_ticket', title: 'T' }] }] }] },
  };
}

test("layout: 'explicit' with no tabs[] is a spec ERROR", () => {
  const errs = validateSpec(layoutSpec({ layout: 'explicit' }), { profile: 'plan' }).errors || [];
  assert.ok(errs.some((e) => /layout is 'explicit' but no tabs\[\] were authored/.test(e)),
    `expected an explicit-without-tabs error, got ${JSON.stringify(errs)}`);
});

test("layout: 'explicit' WITH tabs[] is fine, and so is the auto layout", () => {
  assert.deepStrictEqual(validateSpec(layoutSpec({
    layout: 'explicit',
    tabs: [{ label: 'General', sections: [{ label: 'D', columns: 1, fields: ['new_notes'] }] }],
  }), { profile: 'plan' }).errors || [], []);
  assert.deepStrictEqual(validateSpec(layoutSpec({ layout: 'auto' }), { profile: 'plan' }).errors || [], []);
  assert.deepStrictEqual(validateSpec(layoutSpec({}), { profile: 'plan' }).errors || [], []);
});

test('__explicitLayout reports what was COMPILED, not what was requested', () => {
  // The compiler falls through to the AUTO branch when `tabs` is not an array. Reporting that as an
  // explicit layout would tell the engine's reconcile to PRUNE deployed fields against a layout
  // nobody authored — a destructive action taken on the strength of a flag that was merely asked for.
  const askedSpec = layoutSpec({ layout: 'explicit' });
  const asked = compileIntent(askedSpec, askedSpec.forms[0]);
  assert.strictEqual(asked.__explicitLayout, false,
    'no tabs were authored, so no explicit layout was compiled');

  const realSpec = layoutSpec({
    layout: 'explicit',
    tabs: [{ label: 'General', sections: [{ label: 'D', columns: 1, fields: ['new_notes'] }] }],
  });
  const real = compileIntent(realSpec, realSpec.forms[0]);
  assert.strictEqual(real.__explicitLayout, true, 'an authored tabs layout IS explicit');
});

// ---------------------------------------------------------------------------
// fieldOptions keys: one closed list, shared with the inline field entry
// ---------------------------------------------------------------------------
//
// A `fieldOptions` entry was checked only for the VALUES of the keys the build reads. Any other key
// (a typo such as `readOnlyy`, a casing slip such as `colSpan`, a key of another object such as a
// subgrid's `before`) validated clean and then disappeared: the compiler projects only readOnly,
// hidden, after, colspan and rowspan, so the build succeeded and the option was never applied. The
// inline `fields[]` entry already refused an unknown key as an error, so the map now does the same,
// over the same five keys. `name` is not one of them: in the map, the KEY names the field.

const { createMakerSdk, createNodeWorkspaceStorage } = require('../vendor/cds-maker-sdk.cjs');
const { buildModelApp } = require('../build-model-app.js');
const { createFakeBuildOrg } = require('./helpers/fake-app-build-org.js');
const { runScript } = require('./helpers/run-with-fakes.js');

const OPTION_KEYS_ALLOWED = '(allowed: readOnly, hidden, after, colspan, rowspan)';
const unknownOptionKey = (field, key, hint = '') =>
  `form 'Item' (table new_item): unknown key '${key}' on fieldOptions['${field}']${hint} ${OPTION_KEYS_ALLOWED}`;
const readOnlyTypo = () => specWithBigInt({ fieldOptions: { new_points: { readOnlyy: true } } });

test('validation rejects a misspelled fieldOptions key, naming the form, table, field and key, the key it most likely meant and the keys allowed', () => {
  assert.deepStrictEqual(errsFor(readOnlyTypo()), [unknownOptionKey('new_points', 'readOnlyy', " — did you mean 'readOnly'?")]);
});

test('validation rejects a span- or anchor-like key that a fieldOptions entry does not take', () => {
  // `colSpan` differs from a real key only in case, `before` is a subgrid's placement key, and
  // `span` is no key at all, so only the first has a likely meaning to offer.
  const errs = errsFor(specWithBigInt({ fieldOptions: {
    new_points: { colSpan: 2 },
    new_duedate: { before: 'new_name' },
    new_daysremaining: { span: 2 },
  } }));
  assert.deepStrictEqual(errs, [
    unknownOptionKey('new_points', 'colSpan', " — did you mean 'colspan'?"),
    unknownOptionKey('new_duedate', 'before'),
    unknownOptionKey('new_daysremaining', 'span'),
  ]);
});

test('validation rejects the unknown key of an entry that mixes it with valid keys, and still checks the valid ones', () => {
  const errs = errsFor(specWithBigInt({ fieldOptions: {
    new_points: { readOnly: true, hiden: true },
    new_duedate: { hidden: false, readOnlyy: true },
  } }));
  assert.deepStrictEqual(errs.filter((e) => /unknown key/.test(e)), [
    unknownOptionKey('new_points', 'hiden', " — did you mean 'hidden'?"),
    unknownOptionKey('new_duedate', 'readOnlyy', " — did you mean 'readOnly'?"),
  ]);
  // A valid key beside an unknown one keeps its own check: `hidden: false` is still refused, and
  // `readOnly: true` adds nothing.
  assert.strictEqual(errs.length, 3, errs.join(' | '));
  assert.ok(errs.some((e) => /fieldOptions\['new_duedate'\] sets hidden: false/.test(e)), errs.join(' | '));
});

test("validation rejects 'name' inside a fieldOptions entry, because the map key already names the field", () => {
  // An inline `fields[]` entry carries its `name`; a map entry is keyed by it. Accepting `name` here
  // would let `{ "new_a": { "name": "new_b" } }` say two different things about which field it means.
  const errs = errsFor(specWithBigInt({ fieldOptions: { new_points: { name: 'new_points', readOnly: true } } }));
  assert.deepStrictEqual(errs, [unknownOptionKey('new_points', 'name', " — a fieldOptions entry is keyed by the field's logical name, so it takes no 'name'")]);
});

test("validation points a fieldOptions 'visible' at 'hidden', the option that hides a field", () => {
  // Tabs and sections take `visible`, so it is a likely key to reach for; no near spelling explains it.
  const errs = errsFor(specWithBigInt({ fieldOptions: { new_points: { visible: false } } }));
  assert.deepStrictEqual(errs, [unknownOptionKey('new_points', 'visible', " — to keep the field on the form but not show it, use 'hidden': true")]);
});

test('a fieldOptions key that collides with Object.prototype is reported as itself, never as a native function', () => {
  // JSON.parse makes each of these an OWN key of the entry. A hint table that is a plain object would
  // answer `constructor` with Object's own function and splice its source into the message. The form
  // has no name here, so the message names it by its table alone.
  const entry = JSON.parse('{ "constructor": true, "toString": 1 }');
  const errs = errsFor(specWithBigInt({ name: undefined, fieldOptions: { new_points: entry } }));
  assert.deepStrictEqual(errs, ['constructor', 'toString'].map((k) => `form 'new_item': unknown key '${k}' on fieldOptions['new_points'] ${OPTION_KEYS_ALLOWED}`));
});

test('an inline field entry keeps its own contract: name plus the same five options, and an unknown key is still refused', () => {
  // The layout check already refused these; the shared list must not change what an inline entry
  // accepts or how a refusal reads.
  const spec = specWithBigInt({
    layout: 'explicit',
    tabs: [{ label: 'G', sections: [{ label: 'D', columns: 1, fields: ['new_name', { name: 'new_points', readOnlyy: true }, { name: 'new_duedate', readonly: true }] }] }],
  });
  assert.deepStrictEqual(errsFor(spec), [
    "form 'Item': unknown key 'readOnlyy' on tab 'G' section 'D' field 'new_points' (allowed: name, readOnly, hidden, after, colspan, rowspan)",
    "form 'Item': unknown key 'readonly' on tab 'G' section 'D' field 'new_duedate' — did you mean 'readOnly'? (allowed: name, readOnly, hidden, after, colspan, rowspan)",
  ]);
});

test('each of the five options still validates and compiles exactly as before, form-level and inline', () => {
  const none = { readOnly: false, hidden: false, after: undefined, colspan: undefined, rowspan: undefined };
  const shape = (c) => [c.control.fieldName, c.control.isReadOnly, c.visible, c.colspan, c.rowspan];

  // Form-level, under the AUTO layout (its only route). The one-column auto section clamps the
  // cell's colspan to 1, while the raw span survives for the reconcile.
  const auto = specWithBigInt({ fieldOptions: {
    new_name: { readOnly: true },
    new_duedate: { hidden: true },
    new_daysremaining: { after: 'New_DueDate' },
    new_points: { colspan: 2, rowspan: 1 },
  } });
  assert.deepStrictEqual(errsFor(auto), []);
  assert.deepStrictEqual(fieldOptionsMap(auto.forms[0]), {
    new_name: { name: 'new_name', ...none, readOnly: true },
    new_duedate: { name: 'new_duedate', ...none, hidden: true },
    new_daysremaining: { name: 'new_daysremaining', ...none, after: 'new_duedate' },
    new_points: { name: 'new_points', ...none, colspan: 2, rowspan: 1 },
  });
  const autoIntent = compileFormIntent(auto, auto.forms[0]);
  assert.deepStrictEqual(autoCells(autoIntent).map(shape), [
    ['new_name', true, undefined, undefined, undefined],
    ['new_duedate', undefined, false, undefined, undefined],
    ['new_daysremaining', undefined, undefined, undefined, undefined],
    ['new_points', undefined, undefined, 1, 1],
  ]);
  assert.deepStrictEqual(autoIntent.__fieldPositions, { new_daysremaining: 'new_duedate' });
  assert.deepStrictEqual(autoIntent.__fieldSpans, { new_points: { colspan: 2, rowspan: 1 } });

  // Inline, on an EXPLICIT layout: a rowspan above 1 is legal on the last field of its section.
  const explicit = specWithBigInt({
    layout: 'explicit',
    tabs: [{ label: 'G', sections: [{ label: 'D', columns: 2, fields: [
      { name: 'New_Name', readOnly: true },
      { name: 'new_duedate', hidden: true },
      { name: 'new_daysremaining', colspan: 2 },
      { name: 'new_points', rowspan: 2 },
    ] }] }],
  });
  assert.deepStrictEqual(errsFor(explicit), []);
  assert.deepStrictEqual(explicit.forms[0].tabs[0].sections[0].fields.map(normalizeFieldEntry), [
    { name: 'new_name', ...none, readOnly: true },
    { name: 'new_duedate', ...none, hidden: true },
    { name: 'new_daysremaining', ...none, colspan: 2 },
    { name: 'new_points', ...none, rowspan: 2 },
  ]);
  const explicitIntent = compileFormIntent(explicit, explicit.forms[0]);
  assert.deepStrictEqual(explicitIntent.tabs[0].columns[0].sections[0].rows.map((r) => r.cells.map(shape)), [
    [['new_name', true, undefined, undefined, undefined], ['new_duedate', undefined, false, undefined, undefined]],
    [['new_daysremaining', undefined, undefined, 2, undefined]],
    [['new_points', undefined, undefined, undefined, 2]],
  ]);
  assert.deepStrictEqual(explicitIntent.__fieldSpans, { new_daysremaining: { colspan: 2 }, new_points: { rowspan: 2 } });
});

test('the compiler projects exactly the option keys validation accepts, from either route', () => {
  const { FIELD_OPTION_KEYS } = require(path.join(__dirname, '..', 'lib', 'app-spec.js'));
  assert.deepStrictEqual([...FIELD_OPTION_KEYS], ['readOnly', 'hidden', 'after', 'colspan', 'rowspan']);
  assert.ok(Object.isFrozen(FIELD_OPTION_KEYS), 'the shared list cannot be widened at run time');
  for (const projected of [normalizeFieldEntry('new_a'), normalizeFieldEntry({ name: 'new_a', readOnly: true }), fieldOptionsMap({ fieldOptions: { new_a: {} } }).new_a]) {
    assert.deepStrictEqual(Object.keys(projected), ['name', ...FIELD_OPTION_KEYS]);
  }
  // A key added to the list must arrive with a value it is known to take, so this table has to move
  // with it: each key, on its own, validates and reaches the projection.
  const sample = { readOnly: true, hidden: true, after: 'new_name', colspan: 2, rowspan: 1 };
  assert.deepStrictEqual(Object.keys(sample), [...FIELD_OPTION_KEYS]);
  for (const key of FIELD_OPTION_KEYS) {
    const spec = specWithBigInt({ fieldOptions: { new_points: { [key]: sample[key] } } });
    assert.deepStrictEqual(errsFor(spec), [], key);
    assert.strictEqual(fieldOptionsMap(spec.forms[0]).new_points[key], sample[key], key);
  }
});

test('a key outside the list never reaches the compiled form, even where validation is bypassed', () => {
  const spec = specWithBigInt({ fieldOptions: { new_points: { readOnly: true, readOnlyy: true, hiden: true } } });
  assert.deepStrictEqual(fieldOptionsMap(spec.forms[0]).new_points, { name: 'new_points', readOnly: true, hidden: false, after: undefined, colspan: undefined, rowspan: undefined });
  assert.deepStrictEqual(cellFor(compileFormIntent(spec, spec.forms[0]), 'new_points'), { control: { fieldName: 'new_points', isReadOnly: true } });
});

test('the build refuses a misspelled fieldOptions key before any request reaches the environment, on a dry run and on an apply', async () => {
  // The real vendored SDK over a fake Dataverse that records every request it is sent.
  const org = createFakeBuildOrg({ entities: { new_item: { attributes: { new_name: 'String' } } } });
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(makeTempDir('field-option-keys-')), instanceUrl: org.origin, httpClient: org.httpClient });
  for (const opts of [{ apply: false, livePlan: true }, { apply: true, publish: true }]) {
    const r = await buildModelApp(readOnlyTypo(), { ...opts, env: org.origin, retryDelayMs: 0 }, { sdk, provisionSdk: sdk, sleep: async () => {}, log: () => {}, warn: () => {} });
    assert.strictEqual(r.ok, false, JSON.stringify(opts));
    assert.deepStrictEqual(r.errors, [unknownOptionKey('new_points', 'readOnlyy', " — did you mean 'readOnly'?")], JSON.stringify(opts));
  }
  assert.deepStrictEqual(org.calls, [], 'no request reached the environment');
});

test('the build command refuses the same spec on a dry run before it reads a token or sends a request', () => {
  // A dry run reads the environment for its plan unless --no-live-plan is given, so a spec that
  // validated would be sent requests here.
  const r = runScript('build-model-app.js', ['--env', 'https://contoso.crm.dynamics.com', '--spec', (dir) => `@${path.join(dir, 'app-spec.json')}`], {
    files: { 'app-spec.json': JSON.stringify(readOnlyTypo()) },
  });
  assert.strictEqual(r.status, 1, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout).errors, [unknownOptionKey('new_points', 'readOnlyy', " — did you mean 'readOnly'?")]);
  assert.deepStrictEqual(r.requests, [], 'no request was sent');
  assert.deepStrictEqual(r.tokenReads, { dataverse: 0, powerApps: 0 }, 'no token was read');
});

// A spec that a release before this check accepted can carry such a key: the build ignored it then and built
// the form without the option. Every path that builds or plans a build keeps the refusal above. The paths that
// only READ a spec to act on what was deployed take the same finding as a warning, so an app built from it can
// still be torn down, previewed and verified: the structural profile (teardown and preview) always, and
// read-only verification through `fieldOptionKeys: 'warn'`, which only verify-model-app.js passes.

const { lintSpec } = require('../lint-app-spec.js');
const { scriptsMatching } = require('./helpers/production-scripts.js');
const READ_ONLY_TYPO = unknownOptionKey('new_points', 'readOnlyy', " — did you mean 'readOnly'?");

test('an unknown fieldOptions key stays an error under every profile that builds, and is a warning in the same words under the structural profile', () => {
  for (const profile of ['design', 'plan', 'deploy']) {
    const result = validateAppSpec(readOnlyTypo(), { profile });
    assert.strictEqual(result.ok, false, profile);
    assert.deepStrictEqual(result.errors, [READ_ONLY_TYPO], profile);
    assert.deepStrictEqual(result.warnings, [], profile);
  }
  const structural = validateAppSpec(readOnlyTypo(), { profile: 'structural' });
  assert.strictEqual(structural.ok, true, JSON.stringify(structural.errors));
  assert.deepStrictEqual(structural.errors, []);
  assert.deepStrictEqual(structural.warnings, [READ_ONLY_TYPO]);
  // The lint, the authoring flow's gate, reports it as a schema error under its default and every profile that builds.
  for (const options of [undefined, { profile: 'design' }, { profile: 'plan' }, { profile: 'deploy' }]) {
    const report = lintSpec(readOnlyTypo(), options);
    assert.strictEqual(report.ok, false, JSON.stringify(options));
    assert.ok(report.errors.includes(`schema: ${READ_ONLY_TYPO}`), `${JSON.stringify(options)}: ${JSON.stringify(report.errors)}`);
  }
});

test('fieldOptionKeys: "warn" moves this finding to the warnings under the deploy profile, and no other value or downgrade moves it', () => {
  const lenient = validateAppSpec(readOnlyTypo(), { profile: 'deploy', fieldOptionKeys: 'warn' });
  assert.strictEqual(lenient.ok, true, JSON.stringify(lenient.errors));
  assert.deepStrictEqual(lenient.errors, []);
  assert.deepStrictEqual(lenient.warnings, [READ_ONLY_TYPO]);
  for (const options of [{}, { fieldOptionKeys: true }, { fieldOptionKeys: 'WARN' }, { fieldOptionKeys: 'error' }, { columnValues: 'warn' }, { relationshipCollisions: 'warn' }]) {
    const result = validateAppSpec(readOnlyTypo(), { profile: 'deploy', ...options });
    assert.deepStrictEqual(result.errors, [READ_ONLY_TYPO], JSON.stringify(options));
  }
});

test('the downgrade moves nothing but this finding: a malformed entry, a value the build cannot apply, an inline unknown key and any other problem stay errors', () => {
  // One explicit form carries each neighbour of the finding: an inline entry with an unknown key, a form-level
  // entry that is not an object, and `readOnly: false` beside the misspelled key; the table has a column of no known type.
  const spec = () => {
    const s = specWithBigInt({
      layout: 'explicit',
      prune: false,
      tabs: [{ label: 'G', sections: [{ label: 'D', columns: 1, fields: ['new_name', { name: 'new_duedate', readOnlyy: true }] }] }],
      fieldOptions: { new_points: { readOnly: false, readOnlyy: true }, new_daysremaining: 'hidden' },
    });
    s.entities[0].columns.push({ schemaName: 'new_bad', type: 'Nope' });
    return s;
  };
  const strict = validateAppSpec(spec(), { profile: 'deploy' });
  assert.ok(strict.errors.includes(READ_ONLY_TYPO), JSON.stringify(strict.errors));
  const kept = strict.errors.filter((e) => e !== READ_ONLY_TYPO);
  assert.strictEqual(kept.length, 4, JSON.stringify(kept));
  for (const options of [{ profile: 'structural' }, { profile: 'deploy', fieldOptionKeys: 'warn' }]) {
    const result = validateAppSpec(spec(), options);
    const label = JSON.stringify(options);
    assert.strictEqual(result.ok, false, label);
    assert.deepStrictEqual(result.errors, kept, label);
    assert.deepStrictEqual(result.warnings, [READ_ONLY_TYPO], label);
  }
  for (const pattern of [/column new_bad has unknown type 'Nope'/, /fieldOptions\['new_daysremaining'\] must be an object/, /fieldOptions\['new_points'\] sets readOnly: false/, /unknown key 'readOnlyy' on tab 'G' section 'D' field 'new_duedate'/]) {
    assert.ok(kept.some((e) => pattern.test(e)), `${pattern} stays an error: ${JSON.stringify(kept)}`);
  }
});

test('no script but the verify CLI passes the fieldOptions key downgrade', () => {
  assert.deepStrictEqual(scriptsMatching(/fieldOptionKeys\s*:\s*['"]warn['"]/), ['verify-model-app.js']);
});
