'use strict';
// Where a form's sub-grid sections go — forms[].subgrids[].tab / column / after / before.
//
// The rules (lib/form-subgrid-placement.js), what the spec gate and the lint say about a placement, what `--verify`
// reads off a deployed form, and how the wireframe and the plan show it. What the BUILD does with a placement —
// where a new grid goes, how a rebuild moves an older one — is proven against the real SDK bundle in
// form-subgrid-placement-real-bundle.test.js.
const test = require('node:test');
const assert = require('node:assert');
const placement = require('../lib/form-subgrid-placement.js');
const { validateAppSpec, formLayoutNames, subgridPlacementProblems, subgridRelationshipName } = require('../lib/app-spec.js');
const { lintAppSpec } = require('../lib/spec-lint.js');
const { compileFormIntent } = require('../lib/artifact-intent.js');
const { verifySpec } = require('../lib/verify-spec.js');
const { renderFormWireframe } = require('../lib/form-preview.js');
const { renderAppSpecDoc } = require('../lib/app-spec-doc.js');

const SUBGRID_CLASS = '{E7A81278-8635-4D9E-8D4D-59480B391C5B}';

// --- the spec these tests place grids in -----------------------------------------------------------------

const specWith = (subgrids, form = {}) => ({
  $schemaVersion: '1.0',
  solution: { uniqueName: 'Grids', displayName: 'Grids', publisherPrefix: 'new' },
  app: { name: 'Grids', uniqueName: 'new_grids' },
  entities: [
    { schemaName: 'new_ticket', displayName: 'Ticket', pluralName: 'Tickets', primaryAttribute: { schemaName: 'new_name', displayName: 'Name' },
      columns: [{ schemaName: 'new_code', displayName: 'Code', type: 'Text' }, { schemaName: 'new_notes', displayName: 'Notes', type: 'Memo' }, { schemaName: 'new_area', displayName: 'Area', type: 'Text' }] },
    { schemaName: 'new_task', displayName: 'Task', pluralName: 'Tasks', primaryAttribute: { schemaName: 'new_name', displayName: 'Name' }, columns: [] },
    { schemaName: 'new_comment', displayName: 'Comment', pluralName: 'Comments', primaryAttribute: { schemaName: 'new_name', displayName: 'Name' }, columns: [] },
  ],
  relationships: [
    { type: 'OneToMany', referenced: 'new_ticket', referencing: 'new_task', lookup: { schemaName: 'new_TicketId', displayName: 'Ticket' } },
    { type: 'OneToMany', referenced: 'new_ticket', referencing: 'new_comment', lookup: { schemaName: 'new_TicketId2', displayName: 'Ticket' } },
  ],
  forms: [Object.assign({ entity: 'new_ticket', name: 'Main', subgrids, tabs: [
    { name: 'tab_a', label: 'A', sections: [
      { name: 'sec_main', label: 'Main', columns: 2, fields: ['new_name', 'new_code'] },
      { name: 'sec_more', label: 'More', columns: 1, fields: ['new_notes'] },
    ] },
    { name: 'tab_b', label: 'B', sections: [{ name: 'sec_b', label: 'B', columns: 1, fields: ['new_area'] }] },
  ] }, form)],
  appShell: { areas: [{ label: 'M', groups: [{ label: 'G', subAreas: [{ entity: 'new_ticket', title: 'Tickets' }] }] }] },
});
const twoColumnTab = () => ({ tabs: [{ name: 'tab_a', label: 'A', columns: [
  { width: '50%', sections: [{ name: 'sec_left', label: 'Left', columns: 1, fields: ['new_name', 'new_code'] }] },
  { width: '50%', sections: [{ name: 'sec_right', label: 'Right', columns: 1, fields: ['new_notes', 'new_area'] }] },
] }] });
const autoForm = (subgrids) => { const s = specWith(subgrids); delete s.forms[0].tabs; return s; };

// --- the pure rules ---------------------------------------------------------------------------------------

test('placement: placementOf reads the four keys, lower-cased, and ignores what is not a name or a whole number', () => {
  assert.deepStrictEqual(placement.placementOf({ childEntity: 'new_task', tab: ' Tab_A ', column: 1, after: 'SEC_Main' }), { tab: 'tab_a', column: 1, after: 'sec_main' });
  assert.deepStrictEqual(placement.placementOf({ childEntity: 'new_task', before: 'sec_more' }), { before: 'sec_more' });
  // Nothing declared, or nothing usable: null — which is what keeps a spec without the keys on the original path.
  assert.strictEqual(placement.placementOf({ childEntity: 'new_task', view: 'V', label: 'L' }), null);
  assert.strictEqual(placement.placementOf({ childEntity: 'new_task', tab: '', after: 5, before: null, column: -1 }), null);
  assert.strictEqual(placement.placementOf({ childEntity: 'new_task', column: 1.5 }), null);
  assert.deepStrictEqual(placement.placementOf({ childEntity: 'new_task', column: 0 }), { column: 0 }, 'column 0 is a placement');
  for (const bad of [null, undefined, 'x', 7, [], [{ tab: 'a' }]]) assert.strictEqual(placement.placementOf(bad), null);
});

const LAYOUT = [
  { name: 'tab_a', columns: [{ sections: ['sec_main', 'sec_more'] }, { sections: ['sec_side'] }] },
  { name: 'tab_b', columns: [{ sections: ['sec_b'] }] },
];

test('placement: resolvePlacement finds the tab, form-column and anchor a placement names', () => {
  assert.deepStrictEqual(placement.resolvePlacement(LAYOUT, { after: 'sec_main' }), { ok: true, tabIndex: 0, columnIndex: 0, createColumn: 0, anchor: { name: 'sec_main', side: 'after' } });
  assert.deepStrictEqual(placement.resolvePlacement(LAYOUT, { before: 'sec_side' }), { ok: true, tabIndex: 0, columnIndex: 1, createColumn: 1, anchor: { name: 'sec_side', side: 'before' } });
  assert.deepStrictEqual(placement.resolvePlacement(LAYOUT, { after: 'sec_b', tab: 'tab_b', column: 0 }), { ok: true, tabIndex: 1, columnIndex: 0, createColumn: 0, anchor: { name: 'sec_b', side: 'after' } });
  // A tab (and column) only: membership of the tab; the column is `undefined` — any of them — until one is named.
  assert.deepStrictEqual(placement.resolvePlacement(LAYOUT, { tab: 'tab_b' }), { ok: true, tabIndex: 1, columnIndex: undefined, createColumn: 0, anchor: null });
  assert.deepStrictEqual(placement.resolvePlacement(LAYOUT, { tab: 'tab_a', column: 1 }), { ok: true, tabIndex: 0, columnIndex: 1, createColumn: 1, anchor: null });
  assert.deepStrictEqual(placement.resolvePlacement(LAYOUT, { column: 1 }), { ok: true, tabIndex: 0, columnIndex: 1, createColumn: 1, anchor: null }, 'the first tab when none is named');
});

test('placement: resolvePlacement says what is wrong as a code, for each way a placement can fail', () => {
  const code = (p) => placement.resolvePlacement(LAYOUT, p).code;
  assert.strictEqual(code({ after: 'sec_main', before: 'sec_more' }), 'both');
  assert.strictEqual(code({ after: 'sec_nope' }), 'anchor');
  assert.strictEqual(code({ tab: 'tab_nope' }), 'tab');
  assert.strictEqual(code({ tab: 'tab_a', column: 2 }), 'column');
  assert.strictEqual(code({ tab: 'tab_b', after: 'sec_main' }), 'anchor-tab');
  assert.strictEqual(code({ column: 1, after: 'sec_main' }), 'anchor-column');
  assert.strictEqual(placement.resolvePlacement(LAYOUT, { tab: 'tab_a', after: 'sec_main', column: 0 }).ok, true, 'a tab and column that agree with the anchor are fine');
  assert.strictEqual(placement.resolvePlacement([], { tab: 'a' }).ok, false);
});

test('placement: columnSequence puts a grid right after / before its anchor and keeps grids that share one in declared order', () => {
  const authored = ['a', 'b', 'c'];
  const names = (seq) => seq.map((t) => (t.section !== undefined ? t.section : `#${t.grid}`));
  assert.deepStrictEqual(names(placement.columnSequence(authored, [{ key: 'g1', after: 'a' }])), ['a', '#g1', 'b', 'c']);
  assert.deepStrictEqual(names(placement.columnSequence(authored, [{ key: 'g1', before: 'a' }])), ['#g1', 'a', 'b', 'c']);
  assert.deepStrictEqual(names(placement.columnSequence(authored, [{ key: 'g1', after: 'c' }])), ['a', 'b', 'c', '#g1']);
  // Two grids after one section: the first declared is the first after it.
  assert.deepStrictEqual(names(placement.columnSequence(authored, [{ key: 'g1', after: 'a' }, { key: 'g2', after: 'a' }])), ['a', '#g1', '#g2', 'b', 'c']);
  // Two before one section: still declared order, both ahead of it.
  assert.deepStrictEqual(names(placement.columnSequence(authored, [{ key: 'g1', before: 'b' }, { key: 'g2', before: 'b' }])), ['a', '#g1', '#g2', 'b', 'c']);
  assert.deepStrictEqual(names(placement.columnSequence(authored, [{ key: 'g1', after: 'a' }, { key: 'g2', before: 'c' }, { key: 'g3', after: 'b' }])), ['a', '#g1', 'b', '#g3', '#g2', 'c']);
  // An anchor this column does not hold (the spec gate refuses it) is not a reason to lose the grid.
  assert.deepStrictEqual(names(placement.columnSequence(authored, [{ key: 'g1', after: 'zzz' }])), ['a', 'b', 'c', '#g1']);
  assert.deepStrictEqual(names(placement.columnSequence(authored, [])), ['a', 'b', 'c']);
});

test('placement: neighbourOf names the token an anchored grid must sit directly beside — the nearest toward its anchor that is on the form', () => {
  const seq = placement.columnSequence(['a', 'b', 'c'], [{ key: 'g1', after: 'a' }, { key: 'g2', after: 'a' }, { key: 'g3', before: 'c' }, { key: 'g4', before: 'c' }]);
  const nameOf = (t) => (t.section !== undefined ? t.section : t.grid);
  assert.deepStrictEqual(seq.map(nameOf), ['a', 'g1', 'g2', 'b', 'g3', 'g4', 'c']);
  const near = (key, absent = []) => {
    const hit = placement.neighbourOf(seq, key, (t) => !absent.includes(nameOf(t)));
    return hit && `${nameOf(hit.token)}:${hit.side}`;
  };
  // An `after` grid sits behind the one declared before it, which sits behind the anchor…
  assert.strictEqual(near('g1'), 'a:after');
  assert.strictEqual(near('g2'), 'g1:after');
  // …and a `before` grid in front of the one declared after it, which sits in front of the anchor.
  assert.strictEqual(near('g4'), 'c:before');
  assert.strictEqual(near('g3'), 'g4:before');
  // A grid the form does not have is not a neighbour: the next one toward the anchor is.
  assert.strictEqual(near('g2', ['g1']), 'a:after');
  assert.strictEqual(near('g3', ['g4']), 'c:before');
  // Nothing toward the anchor on the form — the anchor itself is missing — or a grid the sequence does not hold.
  assert.strictEqual(near('g1', ['a']), null);
  assert.strictEqual(near('g4', ['c']), null);
  assert.strictEqual(near('g9'), null);
  assert.strictEqual(placement.neighbourOf([], 'g1', () => true), null);
});

const gridControl = (rel, shape) => (shape === 'xml'
  ? { classId: SUBGRID_CLASS, relationshipName: rel }
  : { classId: SUBGRID_CLASS.replace(/[{}]/g, ''), parameters: { RelationshipName: rel } });
const treeOf = (shape) => [{ columns: [{ sections: [
  { name: 'sec_main', rows: [{ cells: [{ control: { classId: '{4273EDBD-AC1D-40D3-9FB2-095C621B552D}', fieldName: 'new_name' } }] }] },
  { name: 'maker_grid', rows: [{ cells: [{ control: gridControl('new_ticket_new_task', shape) }] }] },
  { name: 'section_grid_new_ticket_new_task', rows: [{ cells: [{ control: gridControl('NEW_Ticket_New_Task', shape) }] }] },
  { name: 'section_grid_new_ticket_new_comment', rows: [{ cells: [{ control: gridControl('new_ticket_new_comment', shape) }] }] },
] }] }];

for (const shape of ['sdk', 'xml']) {
  test(`placement: findGridSection finds the section holding a relationship's grid, preferring the engine's own (${shape} tree)`, () => {
    const tabs = treeOf(shape);
    const hit = placement.findGridSection(tabs, 'new_ticket_new_task');
    assert.deepStrictEqual({ ti: hit.ti, ci: hit.ci, si: hit.si, engine: hit.engine }, { ti: 0, ci: 0, si: 2, engine: true }, 'the engine host wins over a maker section that holds the same relationship, whatever the case');
    assert.strictEqual(placement.findGridSection(tabs, 'new_ticket_new_comment').si, 3);
    assert.strictEqual(placement.findGridSection(tabs, 'new_ticket_new_other'), null);
    // Only a section a maker made holds it: found, and said not to be the build's.
    const onlyMaker = [{ columns: [{ sections: [tabs[0].columns[0].sections[1]] }] }];
    const found = placement.findGridSection(onlyMaker, 'new_ticket_new_task');
    assert.deepStrictEqual({ si: found.si, engine: found.engine }, { si: 0, engine: false });
    // A control of another class that names the same parameter is not a grid.
    const notAGrid = [{ columns: [{ sections: [{ name: 'x', rows: [{ cells: [{ control: Object.assign(gridControl('new_ticket_new_task', shape), { classId: '4273EDBD-AC1D-40D3-9FB2-095C621B552D' }) }] }] }] }] }];
    assert.strictEqual(placement.findGridSection(notAGrid, 'new_ticket_new_task'), null);
  });
}

test('placement: splitSubgrids separates the grids that say where they go from the rest, and drops a placement the layout cannot resolve', () => {
  const layout = formLayoutNames(specWith([]).forms[0]);
  const { placed, unplaced } = placement.splitSubgrids(layout, [
    { childEntity: 'new_task', after: 'sec_main' },
    { childEntity: 'new_comment' },
    { childEntity: 'new_extra', tab: 'tab_nope' },
  ]);
  assert.deepStrictEqual(placed.map((p) => [p.index, p.sg.childEntity]), [[0, 'new_task']]);
  assert.deepStrictEqual(unplaced.map((sg) => sg.childEntity), ['new_comment', 'new_extra']);
});

test('placement: columnItems draws a column in the order a build leaves it — anchored grids among the sections, the rest after the Notes section', () => {
  const layout = [{ name: 'tab_a', columns: [{ sections: ['sec_main', 'sec_more'] }] }];
  const compiled = [{ name: 'sec_main' }, { name: 'sec_more' }, { name: 'section_notes' }];
  const placed = placement.splitSubgrids(layout, [
    { childEntity: 'g_after_main', after: 'sec_main' },
    { childEntity: 'g_tab_only', tab: 'tab_a' },
    { childEntity: 'g_before_more', before: 'sec_more' },
    { childEntity: 'g_unplaced' },
  ]).placed;
  const names = placement.columnItems(layout, 0, 0, compiled, placed).map((i) => (i.section ? i.section.name : i.subgrid.childEntity));
  assert.deepStrictEqual(names, ['sec_main', 'g_after_main', 'g_before_more', 'sec_more', 'section_notes', 'g_tab_only']);
  // A column nothing is placed in comes back as it is.
  assert.deepStrictEqual(placement.columnItems(layout, 0, 1, [{ name: 'x' }], placed).map((i) => i.section.name), ['x']);
});

// The compiled column lists the sections the layout declares, in the layout's order, and then the Notes section the
// compiler appends. A section is told from another by where it is in that list, not by its name: a layout may declare
// a section named `section_notes` too — a natural name for a section of note fields — and a lookup by name would find
// that one for both, dropping the Notes section the compiler added from the column, and with it the timeline a form
// asks for.
test('placement: columnItems tells the layout\u2019s sections from the compiler\u2019s by place, so an authored `section_notes` does not hide the Notes section', () => {
  const layout = [{ name: 'tab_a', columns: [{ sections: ['sec_main', 'section_notes'] }] }];
  const authoredNotes = { name: 'section_notes', which: 'authored' };
  const compiled = [{ name: 'sec_main' }, authoredNotes, { name: 'section_notes', which: 'compiler' }];
  const itemsFor = (subgrids) => placement.columnItems(layout, 0, 0, compiled, placement.splitSubgrids(layout, subgrids).placed);
  const shown = (items) => items.map((i) => (i.subgrid ? `grid:${i.subgrid.childEntity}` : i.section.which || i.section.name));

  assert.deepStrictEqual(shown(itemsFor([{ childEntity: 'g1', after: 'sec_main' }])), ['sec_main', 'grid:g1', 'authored', 'compiler']);
  assert.deepStrictEqual(shown(itemsFor([{ childEntity: 'g1', after: 'section_notes' }])), ['sec_main', 'authored', 'grid:g1', 'compiler'], 'the grid goes after the layout\u2019s section, ahead of the compiler\u2019s');
  assert.deepStrictEqual(shown(itemsFor([{ childEntity: 'g1', before: 'section_notes' }, { childEntity: 'g2', tab: 'tab_a' }])), ['sec_main', 'grid:g1', 'authored', 'compiler', 'grid:g2']);
  // Each section is the very object the compiler made, and says whether the layout or the compiler wrote it.
  const items = itemsFor([{ childEntity: 'g1', after: 'sec_main' }]);
  assert.strictEqual(items[2].section, authoredNotes);
  assert.deepStrictEqual(items.filter((i) => i.section).map((i) => i.engine), [false, false, true]);
  assert.deepStrictEqual(placement.columnItems(layout, 0, 0, compiled, []).map((i) => i.engine), [false, false, true], 'a column nothing is placed in says so too');
});

test('placement: columnSequence says where each layout section is, which is how a compiled column is read by place', () => {
  assert.deepStrictEqual(placement.columnSequence(['a', 'b'], [{ key: 'g', after: 'a' }]).map((t) => (t.section !== undefined ? [t.section, t.at] : ['grid', t.grid])), [['a', 0], ['grid', 'g'], ['b', 1]]);
});

test('placement: the names an auto layout is placed by are the ones the compiler gives it', () => {
  // Pinned in both directions: placement.js writes the literals, artifact-intent.js (the compiler) writes the same ones.
  const form = { entity: 'new_ticket', name: 'Main' };
  const compiled = compileFormIntent(specWith([]), form, {});
  assert.deepStrictEqual(compiled.tabs.map((t) => t.name), [placement.AUTO_TAB_NAME]);
  assert.deepStrictEqual(compiled.tabs[0].columns[0].sections.map((s) => s.name).filter((n) => n !== 'section_notes'), [placement.AUTO_SECTION_NAME]);
  assert.deepStrictEqual(formLayoutNames(form), [{ name: 'tab_general', columns: [{ sections: ['section_general'] }] }]);
});

test('placement: formLayoutNames names the tabs, form-columns and sections an explicit layout declares, lower-cased, generating the names the compiler would', () => {
  const layout = formLayoutNames({ tabs: [
    { name: 'Tab_A', columns: [{ sections: [{ name: 'Sec_One' }, {}] }, { sections: [{ name: 'sec_two' }] }] },
    { label: 'Unnamed', sections: [{ label: 'x' }] },
  ] });
  assert.strictEqual(layout[0].name, 'tab_a');
  assert.strictEqual(layout[0].columns.length, 2);
  assert.strictEqual(layout[0].columns[0].sections[0], 'sec_one');
  assert.match(layout[0].columns[0].sections[1], /^\S+$/, 'an unnamed section gets the generated name');
  assert.deepStrictEqual(layout[0].columns[1].sections, ['sec_two']);
  assert.match(layout[1].name, /^\S+$/, 'an unnamed tab gets the generated name');
});

// --- the spec gate and the lint -----------------------------------------------------------------------------

const gate = (spec) => validateAppSpec(spec).errors.filter((e) => /subgrid/.test(e));
const lint = (spec) => lintAppSpec(spec).errors.filter((e) => /subgrid/.test(e));

test('spec gate: a valid placement is accepted — by validateAppSpec and the lint alike', () => {
  const ok = [
    [{ childEntity: 'new_task', after: 'sec_main' }],
    [{ childEntity: 'new_task', before: 'sec_more' }],
    [{ childEntity: 'new_task', tab: 'tab_b' }],
    [{ childEntity: 'new_task', tab: 'tab_a', after: 'SEC_MAIN' }],
    [{ childEntity: 'new_task', tab: 'tab_a', column: 0 }],
    [{ childEntity: 'new_task', after: 'sec_main' }, { childEntity: 'new_comment', after: 'sec_main' }],
    [{ childEntity: 'new_task' }],
  ];
  for (const subgrids of ok) {
    const spec = specWith(subgrids);
    assert.deepStrictEqual(validateAppSpec(spec).errors, [], JSON.stringify(subgrids));
    assert.deepStrictEqual(lintAppSpec(spec).errors, [], JSON.stringify(subgrids));
  }
  const twoCols = specWith([{ childEntity: 'new_task', tab: 'tab_a', column: 1 }], twoColumnTab());
  assert.deepStrictEqual(validateAppSpec(twoCols).errors, []);
  const afterRight = specWith([{ childEntity: 'new_task', after: 'sec_right', column: 1 }], twoColumnTab());
  assert.deepStrictEqual(validateAppSpec(afterRight).errors, []);
  // An auto layout is one tab, `tab_general`, holding one section, `section_general`.
  for (const sg of [{ after: 'section_general' }, { before: 'section_general' }, { tab: 'tab_general' }, { tab: 'tab_general', column: 0 }]) {
    const spec = autoForm([Object.assign({ childEntity: 'new_task' }, sg)]);
    assert.deepStrictEqual(validateAppSpec(spec).errors, [], JSON.stringify(sg));
    assert.deepStrictEqual(lintAppSpec(spec).errors, [], JSON.stringify(sg));
  }
});

const INVALID = [
  ['an anchor section the form does not declare', { childEntity: 'new_task', after: 'sec_nope' }, /places the grid after section 'sec_nope', which this form does not declare \(its sections: sec_main, sec_more, sec_b\)/],
  ['a before-anchor the form does not declare', { childEntity: 'new_task', before: 'sec_nope' }, /places the grid before section 'sec_nope', which this form does not declare/],
  ['after and before together', { childEntity: 'new_task', after: 'sec_main', before: 'sec_more' }, /sets both 'after' and 'before' — give one/],
  ['a tab the form does not declare', { childEntity: 'new_task', tab: 'tab_nope' }, /places the grid in tab 'tab_nope', which this form does not declare \(its tabs: tab_a, tab_b\)/],
  ['a form-column the tab does not have', { childEntity: 'new_task', tab: 'tab_a', column: 3 }, /places the grid in column 3 of tab 'tab_a', which has 1 form-column\(s\) — count from 0/],
  ['an anchor in another tab than the one named', { childEntity: 'new_task', tab: 'tab_b', after: 'sec_main' }, /after section 'sec_main', which is in tab 'tab_a', not in tab 'tab_b'/],
  ['an anchor in another form-column than the one named', { childEntity: 'new_task', after: 'sec_main', column: 1 }, /after section 'sec_main', which is in form-column 0 of its tab, not 1/],
  ['a tab that is not a string', { childEntity: 'new_task', tab: 5 }, /has tab 5 — it must be the name of a tab on this form, as a non-empty string/],
  ['an anchor that is not a string', { childEntity: 'new_task', after: ['sec_main'] }, /has after \["sec_main"\] — it must be the name of a section on this form, as a non-empty string/],
  ['an empty before-anchor', { childEntity: 'new_task', before: '  ' }, /has before "  " — it must be the name of a section/],
  ['a column that is not a whole number', { childEntity: 'new_task', tab: 'tab_a', column: 1.5 }, /has column 1.5 — it must be a whole number from 0/],
  ['a negative column', { childEntity: 'new_task', tab: 'tab_a', column: -1 }, /has column -1 — it must be a whole number from 0/],
];

for (const [label, subgrid, message] of INVALID) {
  test(`spec gate: ${label} is an error, and the lint says the same`, () => {
    const spec = specWith([subgrid]);
    const errors = gate(spec);
    assert.strictEqual(errors.length, 1, JSON.stringify(errors));
    assert.match(errors[0], /^form new_ticket: subgrid 'new_task' /);
    assert.match(errors[0], message);
    assert.deepStrictEqual(lint(spec), [`Form new_ticket ${errors[0].slice('form new_ticket: '.length)}`], 'the lint reports the same problem, worded for the same form');
    assert.strictEqual(validateAppSpec(spec).ok, false);
  });
}

test('spec gate: an auto layout is placed only by the names it has, and the message says so', () => {
  const spec = autoForm([{ childEntity: 'new_task', after: 'sec_main' }]);
  const [error] = gate(spec);
  assert.match(error, /places the grid after section 'sec_main', which this form does not declare \(its sections: section_general\) \(an auto layout has the one tab 'tab_general' holding the one section 'section_general' — declare tabs\[\] for more\)/);
  assert.match(gate(autoForm([{ childEntity: 'new_task', tab: 'tab_a' }]))[0], /tab 'tab_a', which this form does not declare \(its tabs: tab_general\) \(an auto layout/);
});

test('spec gate: a grid placed in the second form-column of its tab is judged against that form-column\'s sections', () => {
  const spec = specWith([{ childEntity: 'new_task', after: 'sec_left', column: 1 }], twoColumnTab());
  assert.match(gate(spec)[0], /after section 'sec_left', which is in form-column 0 of its tab, not 1/);
});

test('spec gate: every grid of a form is judged, each by its own entry', () => {
  const spec = specWith([{ childEntity: 'new_task', after: 'sec_nope' }, { childEntity: 'new_comment', tab: 'tab_nope' }]);
  const errors = gate(spec);
  assert.strictEqual(errors.length, 2);
  assert.match(errors[0], /subgrid 'new_task'/);
  assert.match(errors[1], /subgrid 'new_comment'/);
});

// A form holds ONE grid per relationship: the build finds a grid by it, and an entry whose grid is already there adds
// nothing. So of two entries for one relationship only one can say where the grid goes, and the other's placement could
// never be honoured — silently, and `--verify` could not tell. Refused when an entry places the grid: those keys are new,
// so no spec that built before is turned away. A repeat that places nothing is what specs have always been able to carry
// (the build has always ignored the extra), so it is only a warning.
const dupes = (spec) => validateAppSpec(spec).errors.filter((e) => /more than once/.test(e));
const dupeWarnings = (spec) => validateAppSpec(spec).warnings.filter((w) => /more than once/.test(w));

for (const [label, subgrids] of [
  ['two placements that disagree', [{ childEntity: 'new_task', after: 'sec_main' }, { childEntity: 'new_task', after: 'sec_more' }]],
  ['a placement and a plain repeat after it', [{ childEntity: 'new_task', after: 'sec_main' }, { childEntity: 'new_task' }]],
  ['a plain entry and a placement after it', [{ childEntity: 'new_task' }, { childEntity: 'new_task', before: 'sec_more' }]],
  ['the same placement twice', [{ childEntity: 'new_task', tab: 'tab_b' }, { childEntity: 'new_task', tab: 'tab_b' }]],
  ['the same table spelled in another case', [{ childEntity: 'new_task', after: 'sec_main' }, { childEntity: 'NEW_Task', after: 'sec_more' }]],
]) {
  test(`spec gate: a relationship listed twice is an error when an entry places the grid — ${label} — and the lint says the same`, () => {
    const spec = specWith(subgrids);
    const errors = dupes(spec);
    assert.strictEqual(errors.length, 1, JSON.stringify(validateAppSpec(spec).errors));
    assert.match(errors[0], /^form new_ticket: subgrids lists the sub-grid for 'new_task' more than once \(subgrids\[0\], subgrids\[1\]\) — a form holds one grid per relationship, so only one entry can say where it goes; keep one$/);
    assert.deepStrictEqual(lintAppSpec(spec).errors.filter((e) => /more than once/.test(e)), [`Form new_ticket ${errors[0].slice('form new_ticket: '.length)}`], 'the lint reports the same problem, worded for the same form');
    assert.strictEqual(validateAppSpec(spec).ok, false);
    assert.strictEqual(lintAppSpec(spec).ok, false);
    assert.deepStrictEqual(dupeWarnings(spec), [], 'one message, not an error and a warning');
  });
}

test('spec gate: a relationship listed twice with no placement is a warning — the spec built before, and the build has always ignored the extra entry', () => {
  const spec = specWith([{ childEntity: 'new_task', view: 'Active' }, { childEntity: 'new_comment' }, { childEntity: 'new_task', label: 'Other' }]);
  assert.deepStrictEqual(dupes(spec), []);
  assert.deepStrictEqual(dupeWarnings(spec), ["form new_ticket: subgrids lists the sub-grid for 'new_task' more than once (subgrids[0], subgrids[2]) — a form holds one grid per relationship, so the build adds one and ignores the rest"]);
  assert.strictEqual(validateAppSpec(spec).ok, true);
  assert.deepStrictEqual(lintAppSpec(spec).warnings.filter((w) => /more than once/.test(w)), ["Form new_ticket subgrids lists the sub-grid for 'new_task' more than once (subgrids[0], subgrids[2]) — a form holds one grid per relationship, so the build adds one and ignores the rest"]);
  assert.strictEqual(lintAppSpec(spec).ok, true);
});

test('spec gate: different tables, a table with no relationship, and a form that cannot host grids at all are not "listed twice"', () => {
  assert.deepStrictEqual(dupes(specWith([{ childEntity: 'new_task', after: 'sec_main' }, { childEntity: 'new_comment', after: 'sec_main' }])), []);
  const none = specWith([{ childEntity: 'new_ticket', after: 'sec_main' }, { childEntity: 'new_ticket', after: 'sec_more' }]); // no relationship from a ticket to a ticket
  assert.deepStrictEqual(dupes(none), [], 'the missing relationship is its own error');
  assert.ok(validateAppSpec(none).errors.some((e) => /no OneToMany or ManyToMany relationship/.test(e)));
  const quick = specWith([{ childEntity: 'new_task', after: 'sec_main' }, { childEntity: 'new_task', after: 'sec_more' }], { formType: 'QuickCreate' });
  assert.deepStrictEqual(dupes(quick), [], 'a QuickCreate form already fails for hosting a grid at all');
  assert.deepStrictEqual(lintAppSpec(quick).errors.filter((e) => /more than once/.test(e)), []);
});

test('spec gate: a placement on a form that is not a Main form adds nothing to the error that form already gets for hosting a grid', () => {
  const spec = specWith([{ childEntity: 'new_task', after: 'sec_nope', tab: 5 }], { formType: 'QuickCreate' });
  const errors = validateAppSpec(spec).errors.filter((e) => /sub-?grid/i.test(e));
  assert.strictEqual(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /QuickCreate forms can't host sub-grids \(Main forms only\)/);
  assert.doesNotMatch(errors[0], /sec_nope|has tab/);
  const linted = lintAppSpec(spec).errors.filter((e) => /sub-?grid/i.test(e));
  assert.strictEqual(linted.length, 1, JSON.stringify(linted));
  assert.match(linted[0], /sub-grids are Main-form only/);
});

test('spec gate: a spec without placement keys is judged exactly as it was', () => {
  const spec = specWith([{ childEntity: 'new_task', view: 'Tasks', label: 'Tasks' }, { childEntity: 'new_comment' }]);
  assert.deepStrictEqual(validateAppSpec(spec).errors, []);
  assert.deepStrictEqual(lintAppSpec(spec).errors, []);
  assert.deepStrictEqual(validateAppSpec(spec).warnings, []);
  assert.deepStrictEqual(subgridPlacementProblems(spec.forms[0], spec.forms[0].subgrids[0]), []);
  assert.deepStrictEqual(subgridPlacementProblems(spec.forms[0], null), []);
});

test('spec gate: a key nothing reads on a sub-grid is a warning, naming the key it probably meant — in the gate and the lint alike', () => {
  const spec = specWith([{ childEntity: 'new_task', afterSection: 'sec_main', View: 'Tasks', Column: 1, position: 'top' }]);
  const hint = (key, meant) => `subgrid 'new_task' has the key '${key}', which nothing reads${meant ? ` — did you mean '${meant}'?` : ''} (the keys are childEntity, view, label, tab, column, after, before)`;
  const expected = [hint('afterSection', 'after'), hint('View', 'view'), hint('Column', 'column'), hint('position')];
  assert.deepStrictEqual(validateAppSpec(spec).warnings.filter((w) => /has the key/.test(w)), expected.map((m) => `form new_ticket: ${m}`));
  assert.deepStrictEqual(lintAppSpec(spec).warnings.filter((w) => /has the key/.test(w)), expected.map((m) => `Form new_ticket ${m}`));
  // A warning, never an error: entries written before the keys existed may carry extras the build never read.
  assert.strictEqual(validateAppSpec(spec).ok, true);
  assert.strictEqual(lintAppSpec(spec).ok, true);
  // Every key the entry does read is silent.
  const known = specWith([{ childEntity: 'new_task', view: 'V', label: 'L', tab: 'tab_a', column: 0, after: 'sec_main' }]);
  assert.deepStrictEqual(validateAppSpec(known).warnings.filter((w) => /has the key/.test(w)), []);
  assert.deepStrictEqual(lintAppSpec(known).warnings.filter((w) => /has the key/.test(w)), []);
});

test('spec gate: subgridRelationshipName names the 1:N a grid shows, and null when the two tables have none', () => {
  const spec = specWith([]);
  assert.strictEqual(subgridRelationshipName(spec, 'new_ticket', 'new_task'), 'new_ticket_new_task');
  assert.strictEqual(subgridRelationshipName(spec, 'NEW_TICKET', 'New_Comment'), 'new_ticket_new_comment');
  assert.strictEqual(subgridRelationshipName(spec, 'new_task', 'new_ticket'), null);
});

// --- --verify -----------------------------------------------------------------------------------------------

// A deployed form as the read-back gives it: the sections of each form-column of each tab, each section holding a
// bound field or a sub-grid. Only what verify reads: names, labels, the grid's class id and RelationshipName.
const field = (name) => `<cell><control datafieldname="${name}" /></cell>`;
const grid = (rel) => `<cell><control id="g" classid="${SUBGRID_CLASS}" disabled="false" isrequired="false"><parameters><TargetEntityType>x</TargetEntityType><RelationshipName>${rel}</RelationshipName></parameters></control></cell>`;
const sectionXml = (name, cell, label) => `<section name="${name}"${label ? '' : ''}><labels><label description="${label || name}" languagecode="1033" /></labels><rows><row>${cell}</row></rows></section>`;
const gridSection = (rel, name) => sectionXml(name || `section_grid_${rel}`, grid(rel), rel);
const column = (...sections) => `<column width="100%"><sections>${sections.join('')}</sections></column>`;
const tabXml = (name, ...columns) => `<tab name="${name}"><labels><label description="${name}" languagecode="1033" /></labels><columns>${columns.join('')}</columns></tab>`;
const formXml = (...tabs) => `<form><tabs>${tabs.join('')}</tabs></form>`;
const MAIN = sectionXml('sec_main', field('new_name') + field('new_code'), 'Main');
const MORE = sectionXml('sec_more', field('new_notes'), 'More');
const SEC_B = sectionXml('sec_b', field('new_area'), 'B');
const TASK = 'new_ticket_new_task';
const COMMENT = 'new_ticket_new_comment';

const readerFor = (xml) => ({
  findTable: async () => ({ logicalName: 'new_ticket' }),
  findColumns: async () => [{ logicalName: 'new_name' }, { logicalName: 'new_code' }, { logicalName: 'new_notes' }, { logicalName: 'new_area' }],
  sitemapXml: async () => '',
  queryRecords: async (set) => (set === 'systemform' ? [{ formid: 'f1', name: 'Main', objecttypecode: 'new_ticket', type: 2, isdefault: true }] : []),
  formTopology: async () => xml,
});
const gridChecks = async (spec, xml) => (await verifySpec(spec, readerFor(xml))).checks.filter((c) => c.kind === 'form-subgrid');

test('verify: a grid directly after its anchor passes; the same grid anywhere else fails and says where it is', async () => {
  const spec = specWith([{ childEntity: 'new_task', after: 'sec_main' }]);
  const right = await gridChecks(spec, formXml(tabXml('tab_a', column(MAIN, gridSection(TASK), MORE)), tabXml('tab_b', column(SEC_B))));
  assert.deepStrictEqual(right.map((c) => [c.name, c.present, c.detail]), [['new_ticket.Main: sub-grid new_task', true, '']]);

  const atEnd = await gridChecks(spec, formXml(tabXml('tab_a', column(MAIN, MORE, gridSection(TASK))), tabXml('tab_b', column(SEC_B))));
  assert.strictEqual(atEnd[0].present, false);
  assert.match(atEnd[0].detail, /deployed where the spec does not place it — the grid is not directly after section 'sec_main' in tab 'tab_a' form-column 1: 'sec_more' sits between them/);

  const otherTab = await gridChecks(spec, formXml(tabXml('tab_a', column(MAIN, MORE)), tabXml('tab_b', column(SEC_B, gridSection(TASK)))));
  assert.strictEqual(otherTab[0].present, false);
  assert.match(otherTab[0].detail, /the grid is in tab 'tab_b' form-column 1, but the spec places it after section 'sec_main', in tab 'tab_a' form-column 1/);

  const above = await gridChecks(spec, formXml(tabXml('tab_a', column(gridSection(TASK), MAIN, MORE)), tabXml('tab_b', column(SEC_B))));
  assert.match(above[0].detail, /the grid is above section 'sec_main' in tab 'tab_a' form-column 1, but the spec places it directly after it/);
});

// "Directly" means nothing sits between the grid and its anchor — not the Notes section a build appends to the end of
// the first tab, and not a section a maker added. A form an earlier version built has the grid BEHIND the Notes
// section, which is not where a fresh build puts it.
test('verify: a section between a grid and its anchor — the Notes section, or a maker\u2019s own — is a grid not placed', async () => {
  const spec = specWith([{ childEntity: 'new_task', after: 'sec_more' }]);
  const notes = sectionXml('section_notes', `<cell><control id="notescontrol" classid="{06375649-C143-495E-A496-C962E5B4488E}" /></cell>`, 'Notes');
  const behindNotes = await gridChecks(spec, formXml(tabXml('tab_a', column(MAIN, MORE, notes, gridSection(TASK))), tabXml('tab_b', column(SEC_B))));
  assert.strictEqual(behindNotes[0].present, false);
  assert.match(behindNotes[0].detail, /the grid is not directly after section 'sec_more' in tab 'tab_a' form-column 1: 'section_notes' sits between them/);
  const beforeNotes = await gridChecks(spec, formXml(tabXml('tab_a', column(MAIN, MORE, gridSection(TASK), notes)), tabXml('tab_b', column(SEC_B))));
  assert.strictEqual(beforeNotes[0].present, true, beforeNotes[0].detail);

  const maker = sectionXml('maker_section', field('new_area'), 'Maker');
  const two = await gridChecks(spec, formXml(tabXml('tab_a', column(MAIN, MORE, maker, notes, gridSection(TASK))), tabXml('tab_b', column(SEC_B))));
  assert.match(two[0].detail, /'maker_section', 'section_notes' sit between them/);

  const before = specWith([{ childEntity: 'new_task', before: 'sec_more' }]);
  const notDirectly = await gridChecks(before, formXml(tabXml('tab_a', column(MAIN, gridSection(TASK), maker, MORE)), tabXml('tab_b', column(SEC_B))));
  assert.match(notDirectly[0].detail, /the grid is not directly before section 'sec_more' in tab 'tab_a' form-column 1: 'maker_section' sits between them/);
  const below = await gridChecks(before, formXml(tabXml('tab_a', column(MAIN, MORE, gridSection(TASK))), tabXml('tab_b', column(SEC_B))));
  assert.match(below[0].detail, /the grid is below section 'sec_more' in tab 'tab_a' form-column 1, but the spec places it directly before it/);
});

test('verify: a grid the build would move says to run a FULL build; one in a section a maker made says what the maker has to do', async () => {
  const spec = specWith([{ childEntity: 'new_task', after: 'sec_main' }]);
  const engine = (await gridChecks(spec, formXml(tabXml('tab_a', column(MAIN, MORE, gridSection(TASK))), tabXml('tab_b', column(SEC_B)))))[0];
  assert.strictEqual(engine.present, false);
  // --changed-only skips a spec that has not changed, so a form an older build left never reaches the fix by it.
  assert.match(engine.detail, /— run a full build of the spec \(not --changed-only, which skips a spec that has not changed\) to move it$/);

  const maker = (await gridChecks(spec, formXml(tabXml('tab_a', column(MAIN, MORE, gridSection(TASK, 'maker_grid'))), tabXml('tab_b', column(SEC_B)))))[0];
  assert.strictEqual(maker.present, false);
  assert.match(maker.detail, /— it sits in a section a build did not create, so a build leaves it there — move that section in the maker, or delete it to let a build place a grid of its own$/);
  assert.doesNotMatch(maker.detail, /full build/, 'a full build would not move it, so it is not what the maker is told to do');
});

test('verify: a grid that is not on the form at all is reported by the relationship it should show', async () => {
  const spec = specWith([{ childEntity: 'new_task', after: 'sec_main' }]);
  const [check] = await gridChecks(spec, formXml(tabXml('tab_a', column(MAIN, MORE)), tabXml('tab_b', column(SEC_B))));
  assert.strictEqual(check.present, false);
  assert.match(check.detail, /the grid for relationship new_ticket_new_task is not on the deployed form/);
});

// The spec gate refuses a relationship listed twice with a placement, but verify is also a library: a spec that reached it
// without the gate must not pass an entry the build could not honour. The grid sits where the FIRST entry puts it.
test('verify: a relationship listed twice fails for the entry after the first, whatever the form holds — never a second pass', async () => {
  const spec = specWith([{ childEntity: 'new_task', after: 'sec_main' }, { childEntity: 'new_task', after: 'sec_more' }]);
  const checks = await gridChecks(spec, formXml(tabXml('tab_a', column(MAIN, gridSection(TASK), MORE)), tabXml('tab_b', column(SEC_B))));
  assert.deepStrictEqual(checks.map((c) => [c.name, c.present]), [['new_ticket.Main: sub-grid new_task', true], ['new_ticket.Main: sub-grid new_task', false]]);
  assert.match(checks[1].detail, /^the sub-grid for new_ticket_new_task is listed more than once, and a form holds one grid per relationship — only the first entry's placement is checked$/);
  const elsewhere = await gridChecks(spec, formXml(tabXml('tab_a', column(MAIN, MORE, gridSection(TASK))), tabXml('tab_b', column(SEC_B))));
  assert.deepStrictEqual(elsewhere.map((c) => c.present), [false, false]);
});

test('verify: before-anchors, shared anchors and several grids are each checked to sit directly beside what the spec names', async () => {
  const spec = specWith([{ childEntity: 'new_task', after: 'sec_main' }, { childEntity: 'new_comment', after: 'sec_main' }, { childEntity: 'new_extra_none', tab: 'tab_b' }]);
  // new_extra_none has no relationship, so it is never placed and never judged.
  const inOrder = await gridChecks(spec, formXml(tabXml('tab_a', column(MAIN, gridSection(TASK), gridSection(COMMENT), MORE)), tabXml('tab_b', column(SEC_B))));
  assert.deepStrictEqual(inOrder.map((c) => c.present), [true, true]);
  const swapped = await gridChecks(spec, formXml(tabXml('tab_a', column(MAIN, gridSection(COMMENT), gridSection(TASK), MORE)), tabXml('tab_b', column(SEC_B))));
  assert.deepStrictEqual(swapped.map((c) => c.present), [false, false], 'a grid declared later that sits ahead of the one declared before it, and the one it now keeps from the anchor');
  assert.match(swapped[0].detail, /the grid is not directly after section 'sec_main' in tab 'tab_a' form-column 1: 'section_grid_new_ticket_new_comment' sits between them/);
  assert.match(swapped[1].detail, /the grid is above sub-grid 'new_task' in tab 'tab_a' form-column 1, but the spec places it directly after it/);
  // A grid declared later sits against the one declared before it, so a section between them is a problem too.
  const apart = await gridChecks(spec, formXml(tabXml('tab_a', column(MAIN, gridSection(TASK), MORE, gridSection(COMMENT))), tabXml('tab_b', column(SEC_B))));
  assert.deepStrictEqual(apart.map((c) => c.present), [true, false]);
  assert.match(apart[1].detail, /the grid is not directly after sub-grid 'new_task' in tab 'tab_a' form-column 1: 'sec_more' sits between them/);

  const before = specWith([{ childEntity: 'new_task', before: 'sec_main' }]);
  assert.strictEqual((await gridChecks(before, formXml(tabXml('tab_a', column(gridSection(TASK), MAIN, MORE)), tabXml('tab_b', column(SEC_B)))))[0].present, true);
  assert.strictEqual((await gridChecks(before, formXml(tabXml('tab_a', column(MAIN, gridSection(TASK), MORE)), tabXml('tab_b', column(SEC_B)))))[0].present, false);

  // Two grids before one section: the one declared last sits against it, the one declared first in front of that.
  const both = specWith([{ childEntity: 'new_task', before: 'sec_more' }, { childEntity: 'new_comment', before: 'sec_more' }]);
  assert.deepStrictEqual((await gridChecks(both, formXml(tabXml('tab_a', column(MAIN, gridSection(TASK), gridSection(COMMENT), MORE)), tabXml('tab_b', column(SEC_B))))).map((c) => c.present), [true, true]);
  assert.deepStrictEqual((await gridChecks(both, formXml(tabXml('tab_a', column(MAIN, gridSection(COMMENT), gridSection(TASK), MORE)), tabXml('tab_b', column(SEC_B))))).map((c) => c.present), [false, false]);
});

test('verify: a tab-only placement is a question of which tab (and form-column) holds the grid, not of its place in it', async () => {
  const spec = specWith([{ childEntity: 'new_task', tab: 'tab_b' }]);
  assert.strictEqual((await gridChecks(spec, formXml(tabXml('tab_a', column(MAIN, MORE)), tabXml('tab_b', column(gridSection(TASK), SEC_B)))))[0].present, true, 'anywhere in the tab');
  const wrong = (await gridChecks(spec, formXml(tabXml('tab_a', column(MAIN, MORE, gridSection(TASK))), tabXml('tab_b', column(SEC_B)))))[0];
  assert.strictEqual(wrong.present, false);
  assert.match(wrong.detail, /the grid is in tab 'tab_a', but the spec places it in tab 'tab_b'/);

  const twoCols = specWith([{ childEntity: 'new_task', tab: 'tab_a', column: 1 }], twoColumnTab());
  const left = sectionXml('sec_left', field('new_name') + field('new_code'), 'Left');
  const right = sectionXml('sec_right', field('new_notes') + field('new_area'), 'Right');
  assert.strictEqual((await gridChecks(twoCols, formXml(tabXml('tab_a', column(left), column(right, gridSection(TASK))))))[0].present, true);
  const inFirst = (await gridChecks(twoCols, formXml(tabXml('tab_a', column(left, gridSection(TASK)), column(right)))))[0];
  assert.strictEqual(inFirst.present, false);
  assert.match(inFirst.detail, /the grid is in form-column 1 of tab 'tab_a', but the spec places it in form-column 2/);
});

test('verify: an anchor the deployed form no longer has makes the placement unprovable — a failure, not a skip', async () => {
  const spec = specWith([{ childEntity: 'new_task', after: 'sec_main' }]);
  const [check] = await gridChecks(spec, formXml(tabXml('tab_a', column(MORE, gridSection(TASK))), tabXml('tab_b', column(SEC_B))));
  assert.strictEqual(check.present, false);
  assert.match(check.detail, /its anchor section 'sec_main' is not on the deployed form, so where the grid sits cannot be proven/);
});

test('verify: an anchor the build matched by label under another name is the anchor, as it is for every other placement', async () => {
  const spec = specWith([{ childEntity: 'new_task', after: 'sec_main' }]);
  const renamed = sectionXml('renamed_in_designer', field('new_name') + field('new_code'), 'Main');
  const [check] = await gridChecks(spec, formXml(tabXml('tab_a', column(renamed, gridSection(TASK), MORE)), tabXml('tab_b', column(SEC_B))));
  assert.strictEqual(check.present, true, check.detail);
});

test('verify: an auto layout is checked by the names the compiler gives it', async () => {
  const spec = autoForm([{ childEntity: 'new_task', before: 'section_general' }]);
  const general = sectionXml('section_general', field('new_name') + field('new_code'), 'Details');
  const good = await gridChecks(spec, formXml(tabXml('tab_general', column(gridSection(TASK), general))));
  assert.deepStrictEqual(good.map((c) => c.present), [true]);
  const bad = await gridChecks(spec, formXml(tabXml('tab_general', column(general, gridSection(TASK)))));
  assert.strictEqual(bad[0].present, false);
  const missing = await gridChecks(spec, formXml(tabXml('tab_general', column(sectionXml('details', field('new_name'), 'Details'), gridSection(TASK)))));
  assert.match(missing[0].detail, /its anchor section 'section_general' is not on the deployed form/);
});

test('verify: a spec whose grids place nothing gets no placement check, and a grid a maker moved is not held to a place the spec never named', async () => {
  const spec = specWith([{ childEntity: 'new_task' }, { childEntity: 'new_comment', label: 'Comments' }]);
  const xml = formXml(tabXml('tab_a', column(MAIN, gridSection(COMMENT), MORE)), tabXml('tab_b', column(SEC_B, gridSection(TASK))));
  assert.deepStrictEqual(await gridChecks(spec, xml), []);
});

test('verify: a relationship name read from the FormXML is read as text, whatever its case or surrounding space', async () => {
  const spec = specWith([{ childEntity: 'new_task', after: 'sec_main' }]);
  const cell = `<cell><control id="g" classid="${SUBGRID_CLASS.toLowerCase()}"><parameters><relationshipname>\n   NEW_Ticket_New_Task\n</relationshipname></parameters></control></cell>`;
  const [check] = await gridChecks(spec, formXml(tabXml('tab_a', column(MAIN, sectionXml('section_grid_new_ticket_new_task', cell, 'Tasks'), MORE)), tabXml('tab_b', column(SEC_B))));
  assert.strictEqual(check.present, true, check.detail);
});

// --- the wireframe and the plan -----------------------------------------------------------------------------

const PREVIEW_SPEC = () => specWith([{ childEntity: 'new_task', after: 'sec_main' }, { childEntity: 'new_comment', tab: 'tab_b' }, { childEntity: 'new_other', label: 'Others' }], { notes: true });
const PREVIEW_LINES = (spec) => renderFormWireframe(spec, spec.forms[0]).split('\n').map((l) => l.replace(/^│ /, '').replace(/ ?[┄]*\s*│$/, '').trimEnd());

test('wireframe: a grid that says where it goes is drawn there, among the sections; the others stay in the Sub-grids block', () => {
  const spec = PREVIEW_SPEC();
  spec.entities.push({ schemaName: 'new_other', displayName: 'Other', primaryAttribute: { schemaName: 'new_name', displayName: 'Name' }, columns: [] });
  const text = renderFormWireframe(spec, spec.forms[0]);
  const at = (needle) => { const i = text.indexOf(needle); assert.ok(i >= 0, `${needle} is drawn`); return i; };
  // tab A: Main, then the grid placed after it, then More, then the Notes section — in the order a build leaves them.
  assert.ok(at('Main ┄') < at('▦ new_task') && at('▦ new_task') < at('More ┄') && at('More ┄') < at('Notes / Timeline'));
  assert.match(text, /▦ new_task ┄+ │\n│ +\(sub-grid {2}→ {2}new_task\)/);
  // tab B: the grid that names only the tab is at the end of that tab.
  assert.ok(at('▾ B') < at('▦ new_comment') && at('B ┄') < at('▦ new_comment'));
  // The grid that says nothing stays where the wireframe always listed it, after the last tab.
  assert.ok(at('▦ new_comment') < at('▦ Sub-grids') && at('▦ Sub-grids') < at('• Others'));
  assert.doesNotMatch(text, /• new_task|• new_comment/, 'a placed grid is not listed twice');
  assert.match(text, /• Others {2}→ {2}new_other/);
});

test('wireframe: a form whose grids place nothing is drawn exactly as before — one block after the last tab', () => {
  const spec = specWith([{ childEntity: 'new_task', label: 'Tasks' }]);
  const lines = PREVIEW_LINES(spec);
  assert.ok(lines.some((l) => /▦ Sub-grids/.test(l)));
  assert.ok(lines.some((l) => /• Tasks {2}→ {2}new_task/.test(l)));
  assert.ok(!lines.some((l) => /\(sub-grid/.test(l)));
});

test('wireframe: a placement the layout cannot resolve is left in the Sub-grids block, as the build leaves it', () => {
  const spec = specWith([{ childEntity: 'new_task', after: 'sec_nope' }]);
  const text = renderFormWireframe(spec, spec.forms[0]);
  assert.match(text, /▦ Sub-grids/);
  assert.match(text, /• new_task {2}→ {2}new_task/);
});

test('wireframe: an auto layout draws a grid before or after its one section', () => {
  const spec = autoForm([{ childEntity: 'new_task', before: 'section_general' }, { childEntity: 'new_comment', after: 'section_general' }]);
  const text = renderFormWireframe(spec, spec.forms[0]);
  assert.ok(text.indexOf('▦ new_task') < text.indexOf('(no heading)') && text.indexOf('(no heading)') < text.indexOf('▦ new_comment'), text);
  assert.doesNotMatch(text, /▦ Sub-grids/);
});

// A layout may declare a section named `section_notes` — a natural name for a section of note fields — and the compiler
// adds its own Notes section under the same name. The wireframe tells them apart by place in the column, not by name:
// the layout's section is drawn with its fields and the compiler's is the one Notes / Timeline block, whether or not a
// grid is placed in that column.
test('wireframe: a layout section named section_notes is drawn with its fields, and the Notes section the form asks for is still there — with or without a placed grid', () => {
  const withNotes = (subgrids) => specWith(subgrids, { notes: true, tabs: [{ name: 'tab_a', label: 'A', sections: [
    { name: 'sec_main', label: 'Main', columns: 1, fields: ['new_name'] },
    { name: 'section_notes', label: 'Note fields', columns: 1, fields: ['new_notes'] },
  ] }] });
  const without = renderFormWireframe(withNotes([]), withNotes([]).forms[0]);
  const placed = withNotes([{ childEntity: 'new_task', after: 'sec_main' }]);
  const text = renderFormWireframe(placed, placed.forms[0]);
  for (const [which, wire] of [['no grid placed', without], ['a grid placed in the column', text]]) {
    assert.strictEqual((wire.match(/Notes \/ Timeline/g) || []).length, 1, `${which}: one Notes / Timeline block — the compiler's`);
    assert.match(wire, /Note fields ┄/, `${which}: the layout's section is drawn under its own heading`);
    assert.match(wire, /Notes {2}/, `${which}: …with its field`);
    assert.ok(wire.indexOf('Note fields') < wire.indexOf('Notes / Timeline'), `${which}: ahead of the Notes section, where a build puts it`);
  }
  assert.ok(text.indexOf('Main ┄') < text.indexOf('▦ new_task') && text.indexOf('▦ new_task') < text.indexOf('Note fields'), 'the grid is drawn after sec_main');
});

test('plan: the Forms table shows where a grid is placed, and nothing for a grid that says nothing', () => {
  const spec = specWith([
    { childEntity: 'new_task', after: 'sec_main' },
    { childEntity: 'new_comment', tab: 'tab_b', column: 0 },
  ]);
  assert.match(renderAppSpecDoc(spec), /\| Main \| new_ticket \| Main \| explicit \(2 tabs\) \| new_task \(after sec_main\), new_comment \(tab tab_b, column 0\) \|/);
  const plain = specWith([{ childEntity: 'new_task' }, { childEntity: 'new_comment' }]);
  assert.match(renderAppSpecDoc(plain), /\| explicit \(2 tabs\) \| new_task, new_comment \|/);
  const odd = specWith([{ childEntity: 'new_task', tab: 7, after: ['x'], before: 'a|b' }]);
  assert.match(renderAppSpecDoc(odd), /\| new_task \(before a\\\|b\) \|/, 'a value that is not a name is skipped, and a pipe cannot break the table');
});
