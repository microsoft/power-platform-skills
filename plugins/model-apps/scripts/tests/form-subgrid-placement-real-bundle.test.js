'use strict';
// REAL BUNDLE: where a form's sub-grid sections go (forms[].subgrids[].tab / column / after / before) — what the
// build writes for a new grid, how a rebuild moves an older one into place, what it never touches, and what
// `--verify` says about it. The vendored SDK serializes and re-reads every form here, against a stub HTTP client
// that stores one systemform row. The pure rules and the spec gate are in form-subgrid-placement.test.js.
const test = require('node:test');
const assert = require('node:assert');
const ai = require('../lib/artifact-intent.js');
const { runSdkBuild } = require('../lib/sdk-build.js');
const { createHarness, seedForm, verifyForms, clone, NOTES_CLASS_ID, SUBGRID_CLASS_ID, VIEW_ID } = require('./helpers/form-store-harness.js');

const TASK = 'new_ticket_new_task';
const COMMENT = 'new_ticket_new_comment';
const GRID_TASK = `section_grid_${TASK}`;
const GRID_COMMENT = `section_grid_${COMMENT}`;

function specFor({ layout = 'explicit', subgrids = [], notes = false, mutate } = {}) {
  const spec = {
    $schemaVersion: '1.0',
    solution: { uniqueName: 'Grids', displayName: 'Grids', publisherPrefix: 'new' },
    app: { name: 'Grids', uniqueName: 'new_grids' },
    entities: [
      { schemaName: 'new_ticket', displayName: 'Ticket', pluralName: 'Tickets', existing: true,
        primaryAttribute: { schemaName: 'new_name', displayName: 'Name' },
        columns: [
          { schemaName: 'new_code', displayName: 'Code', type: 'Text' },
          { schemaName: 'new_notes', displayName: 'Notes', type: 'Memo' },
          { schemaName: 'new_area', displayName: 'Area', type: 'Text' },
          { schemaName: 'new_extra', displayName: 'Extra', type: 'Text' },
        ] },
      { schemaName: 'new_task', displayName: 'Task', pluralName: 'Tasks', existing: true, primaryAttribute: { schemaName: 'new_name', displayName: 'Name' }, columns: [] },
      { schemaName: 'new_comment', displayName: 'Comment', pluralName: 'Comments', existing: true, primaryAttribute: { schemaName: 'new_name', displayName: 'Name' }, columns: [] },
    ],
    relationships: [
      { type: 'OneToMany', referenced: 'new_ticket', referencing: 'new_task', lookup: { schemaName: 'new_TicketId', displayName: 'Ticket' } },
      { type: 'OneToMany', referenced: 'new_ticket', referencing: 'new_comment', lookup: { schemaName: 'new_TicketId2', displayName: 'Ticket' } },
    ],
    forms: [layout === 'explicit'
      ? { entity: 'new_ticket', name: 'Main', notes, subgrids, tabs: [
        { name: 'tab_a', label: 'A', sections: [
          { name: 'sec_main', label: 'Main', columns: 2, fields: ['new_name', 'new_code'] },
          { name: 'sec_more', label: 'More', columns: 1, fields: ['new_notes', 'new_area'] },
        ] },
        { name: 'tab_b', label: 'B', sections: [{ name: 'sec_b', label: 'B', columns: 1, fields: [] }] },
      ] }
      : layout === 'columns'
        ? { entity: 'new_ticket', name: 'Main', notes, subgrids, tabs: [{ name: 'tab_a', label: 'A', columns: [
          { width: '50%', sections: [{ name: 'sec_left', label: 'Left', columns: 1, fields: ['new_name', 'new_code'] }] },
          { width: '50%', sections: [{ name: 'sec_right', label: 'Right', columns: 1, fields: ['new_notes', 'new_area'] }] },
        ] }] }
        : { entity: 'new_ticket', name: 'Main', notes, subgrids }],
  };
  if (mutate) mutate(spec);
  return spec;
}

const compiledTabs = (spec) => ai.compileFormIntent(spec, spec.forms[0], { notesClassId: NOTES_CLASS_ID }).tabs;
const layoutOf = (form) => form.tabs.map((t) => t.columns.map((c) => c.sections.map((s) => s.name)));
const sectionsOf = (form) => form.tabs.flatMap((t) => t.columns.flatMap((c) => c.sections));
const sectionOf = (form, name) => sectionsOf(form).find((s) => s.name === name);
const idsByName = (form) => Object.fromEntries(sectionsOf(form).map((s) => [s.name, s.id]));
const cellsOf = (section) => section.rows.flatMap((r) => r.cells);
const layoutMutations = (mutations) => mutations.filter((m) => ['addElement', 'updateElement', 'moveElement', 'removeElement'].includes(m.method));
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const masked = (value) => JSON.parse(JSON.stringify(value).replace(GUID, '<id>'));

const harnesses = [];
const newHarness = (options) => { const h = createHarness(options); harnesses.push(h); return h; };
test.after(() => { for (const h of harnesses) h.cleanup(); });

const fetched = async (h) => clone(await (await h.freshSdk()).sdk.fetchArtifact('form', h.formId));
const gridChecks = async (h, spec) => (await verifyForms(h, spec)).checks.filter((c) => c.kind === 'form-subgrid');

// One build of the forms phase over a fresh SDK, with what it wrote and said.
async function build(h, spec) {
  const run = await h.freshSdk();
  const warnings = [];
  const built = await runSdkBuild(spec, { sdk: run.sdk, apply: true, phases: ['forms'], warn: (m) => warnings.push(String(m)) });
  assert.strictEqual(built.ok, true, JSON.stringify(built.error || built.halt || ''));
  return { built, warnings, mutations: run.mutations, writes: layoutMutations(run.mutations) };
}

// --- no placement: what the build has always written ------------------------------------------------------

// A spec whose grids say nothing about where they go must build the form it always did. The writes below are what
// the build made before the keys existed — recorded, with generated ids masked — so a change to the path an
// unplaced grid takes shows up here whatever else the placement logic does.
const GRID_ADD = (relationshipName, target, label) => ['addElement', 'form', '<id>', '/tabs/0/columns/0/sections', {
  name: `section_grid_${relationshipName}`, label, visible: true, showLabel: true, columns: 1,
  rows: [{ cells: [{ control: { classId: SUBGRID_CLASS_ID, label, parameters: {
    TargetEntityType: target, ViewId: '<id>', IsUserView: 'false', RelationshipName: relationshipName, ChartGridMode: 'Grid', RecordsPerPage: '10' } } }] }],
}];
const recorded = (writes) => masked(writes.map((m) => [m.method, ...m.args]));

test('no placement: an explicit layout gets each grid appended to the end of the first tab\'s first form-column, as it always did', async () => {
  const h = newHarness(); delete h.store.row.formxml;
  const spec = specFor({ subgrids: [{ childEntity: 'new_task' }, { childEntity: 'new_comment', label: 'Notes about it' }] });
  const first = await build(h, spec);
  assert.deepStrictEqual(first.writes.map((m) => [m.method, m.args[2]]), [
    ['addElement', '/tabs'], ['addElement', '/tabs'], ['removeElement', '/tabs/0'], ['updateElement', '/bag/c/2'],
    ['addElement', '/tabs/0/columns/0/sections'], ['addElement', '/tabs/0/columns/0/sections'],
  ]);
  const grids = recorded(first.writes.slice(-2));
  assert.deepStrictEqual(grids, [GRID_ADD(TASK, 'new_task', 'Tasks'), GRID_ADD(COMMENT, 'new_comment', 'Notes about it')]);
  assert.ok(first.writes.slice(-2).every((m) => m.args.length === 4), 'no position, no option: the call the build always made');
  assert.deepStrictEqual(layoutOf(await fetched(h)), [[['sec_main', 'sec_more', GRID_TASK, GRID_COMMENT]], [['sec_b']]]);
  assert.deepStrictEqual(await gridChecks(h, spec), [], 'a grid that places nothing is held to no place');
  const again = await build(h, spec);
  assert.deepStrictEqual(again.mutations, [], 'a rebuild writes nothing');
});

test('no placement: an auto layout gets its grid the same way, and an existing form is appended to once', async () => {
  const h = newHarness(); delete h.store.row.formxml;
  const spec = specFor({ layout: 'auto', subgrids: [{ childEntity: 'new_task' }] });
  const first = await build(h, spec);
  assert.deepStrictEqual(recorded(first.writes.slice(-1)), [GRID_ADD(TASK, 'new_task', 'Tasks')]);
  assert.deepStrictEqual(layoutOf(await fetched(h)), [[['section_general', GRID_TASK]]]);

  const existing = newHarness();
  const withTwo = specFor({ subgrids: [{ childEntity: 'new_task' }, { childEntity: 'new_comment' }] });
  await seedForm(existing, compiledTabs(withTwo));
  const added = await build(existing, withTwo);
  assert.deepStrictEqual(added.writes.map((m) => [m.method, m.args[2], m.args.length]), [
    ['addElement', '/tabs/0/columns/0/sections', 4], ['addElement', '/tabs/0/columns/0/sections', 4]]);
  assert.deepStrictEqual(layoutOf(await fetched(existing)), [[['sec_main', 'sec_more', GRID_TASK, GRID_COMMENT]], [['sec_b']]]);
  assert.deepStrictEqual((await build(existing, withTwo)).mutations, []);
});

test('no placement: a grid the maker moved is never moved back, and a grid in a section of the maker\'s own is left alone', async () => {
  const h = newHarness(); delete h.store.row.formxml;
  const unplaced = specFor({ subgrids: [{ childEntity: 'new_task' }] });
  await build(h, unplaced);
  // The maker drags the engine's grid section into the second tab, in the designer.
  const moving = await h.freshSdk();
  await moving.sdk.fetchArtifact('form', h.formId);
  await moving.sdk.moveElement('form', h.formId, `/tabs/0/columns/0/sections/2`, '/tabs/1/columns/0/sections', { index: 1 });
  await moving.sdk.pushArtifact('form', h.formId);
  assert.deepStrictEqual(layoutOf(await fetched(h)), [[['sec_main', 'sec_more']], [['sec_b', GRID_TASK]]]);
  const rebuilt = await build(h, unplaced);
  assert.deepStrictEqual(rebuilt.mutations, [], 'nothing the spec did not place is moved');
  assert.deepStrictEqual(layoutOf(await fetched(h)), [[['sec_main', 'sec_more']], [['sec_b', GRID_TASK]]]);
});

test('no placement: naming the first tab is the same form as naming nothing', async () => {
  const plain = newHarness(); delete plain.store.row.formxml;
  await build(plain, specFor({ subgrids: [{ childEntity: 'new_task' }] }));
  const named = newHarness(); delete named.store.row.formxml;
  const { writes } = await build(named, specFor({ subgrids: [{ childEntity: 'new_task', tab: 'tab_a' }] }));
  assert.deepStrictEqual(masked(await fetched(named)), masked(await fetched(plain)));
  assert.deepStrictEqual(masked(named.store.row.formxml), masked(plain.store.row.formxml));
  assert.ok(writes.slice(-1).every((m) => m.args.length === 4), 'appended to the end of the column, with no position');
});

// --- a NEW grid goes where the spec says -------------------------------------------------------------------

test('placed: a new grid is created between the sections the spec names — in a one-column section of its own, with one write', async () => {
  const h = newHarness(); delete h.store.row.formxml;
  const spec = specFor({ subgrids: [{ childEntity: 'new_task', after: 'sec_main' }] });
  const { writes, warnings, mutations } = await build(h, spec);
  const form = await fetched(h);
  assert.deepStrictEqual(layoutOf(form), [[['sec_main', GRID_TASK, 'sec_more']], [['sec_b']]]);
  const grid = sectionOf(form, GRID_TASK);
  assert.deepStrictEqual({ columns: grid.columns, label: grid.label, showLabel: grid.showLabel, rows: grid.rows.length }, { columns: 1, label: 'Tasks', showLabel: true, rows: 1 });
  assert.strictEqual(grid.rows[0].cells[0].control.parameters.RelationshipName, TASK);
  const adds = writes.filter((m) => m.method === 'addElement' && /sections$/.test(m.args[2]));
  assert.strictEqual(adds.length, 1);
  assert.deepStrictEqual(adds[0].args[4], { position: { index: 1 } }, 'written at its place, not appended and moved');
  assert.deepStrictEqual(mutations.filter((m) => m.method === 'moveElement'), []);
  assert.deepStrictEqual(warnings, [], 'a new form needs no report');
  // The server holds it in that order, and verify reads it back where it is.
  const xml = h.store.row.formxml;
  assert.ok(xml.indexOf('name="sec_main"') < xml.indexOf(`name="${GRID_TASK}"`) && xml.indexOf(`name="${GRID_TASK}"`) < xml.indexOf('name="sec_more"'));
  assert.match(xml, /<RelationshipName>new_ticket_new_task<\/RelationshipName>/);
  const [check] = await gridChecks(h, spec);
  assert.deepStrictEqual([check.name, check.present, check.detail], ['new_ticket.Main: sub-grid new_task', true, '']);
  assert.deepStrictEqual((await build(h, spec)).mutations, [], 'idempotent: a rebuild writes nothing');
});

test('placed: before a section, and after the last one — ahead of the Notes section the build appends', async () => {
  const before = newHarness(); delete before.store.row.formxml;
  await build(before, specFor({ subgrids: [{ childEntity: 'new_task', before: 'sec_main' }] }));
  assert.deepStrictEqual(layoutOf(await fetched(before))[0], [[GRID_TASK, 'sec_main', 'sec_more']]);

  const last = newHarness(); delete last.store.row.formxml;
  const spec = specFor({ notes: true, subgrids: [{ childEntity: 'new_task', after: 'sec_more' }] });
  await build(last, spec);
  assert.deepStrictEqual(layoutOf(await fetched(last))[0], [['sec_main', 'sec_more', GRID_TASK, 'section_notes']]);
  assert.strictEqual((await gridChecks(last, spec))[0].present, true);
});

test('placed: a new grid is added to a form that already exists at its place, in one write, with the other sections where they were', async () => {
  const h = newHarness();
  const spec = specFor({ subgrids: [{ childEntity: 'new_task', after: 'sec_main' }] });
  await seedForm(h, compiledTabs(specFor()));
  const before = await fetched(h);
  const { writes, warnings } = await build(h, spec);
  assert.strictEqual(writes.length, 1, JSON.stringify(writes.map((m) => [m.method, m.args[2]])));
  assert.deepStrictEqual([writes[0].method, writes[0].args[2], writes[0].args[4]], ['addElement', '/tabs/0/columns/0/sections', { position: { index: 1 } }]);
  assert.deepStrictEqual(warnings, []);
  const after = await fetched(h);
  assert.deepStrictEqual(layoutOf(after), [[['sec_main', GRID_TASK, 'sec_more']], [['sec_b']]]);
  for (const name of ['sec_main', 'sec_more', 'sec_b']) assert.deepStrictEqual(sectionOf(after, name), sectionOf(before, name), `${name} is untouched`);
});

test('placed: grids that share an anchor go in the order they are declared; declaring them the other way round moves one grid', async () => {
  const h = newHarness(); delete h.store.row.formxml;
  const both = (a, b) => specFor({ subgrids: [{ childEntity: a, after: 'sec_main' }, { childEntity: b, after: 'sec_main' }] });
  await build(h, both('new_task', 'new_comment'));
  assert.deepStrictEqual(layoutOf(await fetched(h))[0], [['sec_main', GRID_TASK, GRID_COMMENT, 'sec_more']]);
  const ids = idsByName(await fetched(h));

  const flipped = both('new_comment', 'new_task');
  const { writes, warnings } = await build(h, flipped);
  assert.deepStrictEqual(writes.map((m) => [m.method, m.args[2], m.args[4]]), [['moveElement', '/tabs/0/columns/0/sections/2', { index: 1 }]], 'the comment grid, from the third place to the second');
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /^form Main: moved the sub-grid for 'new_comment' \(section 'section_grid_new_ticket_new_comment'\) to sit directly after section 'sec_main', in tab 'tab_a' \(form-column 1\), where subgrids\[\] places it\.$/);
  const form = await fetched(h);
  assert.deepStrictEqual(layoutOf(form)[0], [['sec_main', GRID_COMMENT, GRID_TASK, 'sec_more']]);
  assert.deepStrictEqual(idsByName(form), ids, 'the same sections, in another order');
  assert.ok((await gridChecks(h, flipped)).every((c) => c.present));
  assert.deepStrictEqual((await build(h, flipped)).mutations, []);
});

test('placed: each grid ends directly beside its own anchor — before one section, after another — and the sections between move for no grid', async () => {
  const h = newHarness(); delete h.store.row.formxml;
  await build(h, specFor({ subgrids: [{ childEntity: 'new_task', after: 'sec_main' }, { childEntity: 'new_comment', after: 'sec_main' }] }));
  const ids = idsByName(await fetched(h));
  const spec = specFor({ subgrids: [{ childEntity: 'new_comment', before: 'sec_main' }, { childEntity: 'new_task', after: 'sec_more' }] });
  const { writes } = await build(h, spec);
  assert.deepStrictEqual(layoutOf(await fetched(h))[0], [[GRID_COMMENT, 'sec_main', 'sec_more', GRID_TASK]]);
  assert.strictEqual(writes.length, 2, 'one move for each grid');
  assert.deepStrictEqual(idsByName(await fetched(h)), ids, 'no section was made or lost');
  assert.ok((await gridChecks(h, spec)).every((c) => c.present));
  assert.deepStrictEqual((await build(h, spec)).mutations, []);
});

test('placed: a grid that names a tab goes to the end of that tab; one that names a form-column goes to the end of that form-column', async () => {
  const tabs = newHarness(); delete tabs.store.row.formxml;
  const inB = specFor({ subgrids: [{ childEntity: 'new_task', tab: 'tab_b' }] });
  await build(tabs, inB);
  assert.deepStrictEqual(layoutOf(await fetched(tabs)), [[['sec_main', 'sec_more']], [['sec_b', GRID_TASK]]]);
  assert.strictEqual((await gridChecks(tabs, inB))[0].present, true);

  const columns = newHarness(); delete columns.store.row.formxml;
  const second = specFor({ layout: 'columns', subgrids: [{ childEntity: 'new_task', tab: 'tab_a', column: 1 }] });
  await build(columns, second);
  assert.deepStrictEqual(layoutOf(await fetched(columns)), [[['sec_left'], ['sec_right', GRID_TASK]]]);
  assert.strictEqual((await gridChecks(columns, second))[0].present, true);
  assert.deepStrictEqual((await build(columns, second)).mutations, []);

  // A spec that names only the tab accepts any form-column of it: a grid already in the second one stays.
  const anyColumn = specFor({ layout: 'columns', subgrids: [{ childEntity: 'new_task', tab: 'tab_a' }] });
  assert.deepStrictEqual((await build(columns, anyColumn)).mutations, [], 'naming the tab alone is membership of the tab');
  assert.strictEqual((await gridChecks(columns, anyColumn))[0].present, true);
});

test('placed: an anchor in the second form-column puts the grid in that form-column, beside its anchor', async () => {
  const h = newHarness(); delete h.store.row.formxml;
  const spec = specFor({ layout: 'columns', subgrids: [{ childEntity: 'new_task', after: 'sec_right' }, { childEntity: 'new_comment', before: 'sec_left' }] });
  await build(h, spec);
  assert.deepStrictEqual(layoutOf(await fetched(h)), [[[GRID_COMMENT, 'sec_left'], ['sec_right', GRID_TASK]]]);
  assert.ok((await gridChecks(h, spec)).every((c) => c.present));
});

test('placed: an auto layout places a grid before or after its one section, and a tab-only grid in its one tab', async () => {
  const h = newHarness(); delete h.store.row.formxml;
  const spec = specFor({ layout: 'auto', subgrids: [{ childEntity: 'new_task', before: 'section_general' }, { childEntity: 'new_comment', after: 'section_general' }] });
  await build(h, spec);
  assert.deepStrictEqual(layoutOf(await fetched(h)), [[[GRID_TASK, 'section_general', GRID_COMMENT]]]);
  assert.ok((await gridChecks(h, spec)).every((c) => c.present));
  assert.deepStrictEqual((await build(h, spec)).mutations, []);

  const tabOnly = newHarness(); delete tabOnly.store.row.formxml;
  const named = specFor({ layout: 'auto', subgrids: [{ childEntity: 'new_task', tab: 'tab_general' }] });
  await build(tabOnly, named);
  assert.deepStrictEqual(layoutOf(await fetched(tabOnly)), [[['section_general', GRID_TASK]]]);
  assert.strictEqual((await gridChecks(tabOnly, named))[0].present, true);
});

test('placed: grids the spec places and grids added by autoSubgrids sit together; the added ones go to the end', async () => {
  const h = newHarness(); delete h.store.row.formxml;
  const spec = specFor({ subgrids: [{ childEntity: 'new_task', after: 'sec_main' }], mutate: (s) => { s.forms[0].autoSubgrids = true; } });
  await build(h, spec);
  assert.deepStrictEqual(layoutOf(await fetched(h))[0], [['sec_main', GRID_TASK, 'sec_more', GRID_COMMENT]]);
  assert.deepStrictEqual((await build(h, spec)).mutations, []);
});

// --- a rebuild CONVERGES an older form ---------------------------------------------------------------------

test('converge: a rebuild moves the grid an older build appended to the end of the form into the place the spec now gives it', async () => {
  const h = newHarness(); delete h.store.row.formxml;
  await build(h, specFor({ subgrids: [{ childEntity: 'new_task' }] })); // what every earlier version wrote
  const old = await fetched(h);
  assert.deepStrictEqual(layoutOf(old)[0], [['sec_main', 'sec_more', GRID_TASK]]);
  const ids = idsByName(old);
  const gridBefore = sectionOf(old, GRID_TASK);

  const spec = specFor({ subgrids: [{ childEntity: 'new_task', after: 'sec_main' }] });
  const stale = await gridChecks(h, spec);
  assert.strictEqual(stale[0].present, false, 'verify says the fix is not applied');
  assert.match(stale[0].detail, /the grid is not directly after section 'sec_main' in tab 'tab_a' form-column 1: 'sec_more' sits between them/);

  const { writes, warnings } = await build(h, spec);
  assert.deepStrictEqual(writes.map((m) => [m.method, m.args[2], m.args[3], m.args[4]]), [['moveElement', '/tabs/0/columns/0/sections/2', '/tabs/0/columns/0/sections', { index: 1 }]], 'the GRID moves, once; nothing is added, removed or rewritten');
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /^form Main: moved the sub-grid for 'new_task' \(section 'section_grid_new_ticket_new_task'\) to sit directly after section 'sec_main', in tab 'tab_a' \(form-column 1\), where subgrids\[\] places it\.$/);
  const after = await fetched(h);
  assert.deepStrictEqual(layoutOf(after)[0], [['sec_main', GRID_TASK, 'sec_more']]);
  assert.deepStrictEqual(idsByName(after), ids, 'the same sections — no grid was deleted and made again');
  assert.deepStrictEqual(sectionOf(after, GRID_TASK), gridBefore, 'the grid section, its cell and its control are what they were');
  assert.strictEqual((await gridChecks(h, spec))[0].present, true);
  assert.deepStrictEqual((await build(h, spec)).mutations, [], 'a second rebuild writes nothing');
});

// --- the form the released builds deployed ---------------------------------------------------------------------

// An explicit-layout Main form with `notes: true` and one sub-grid, as every release before this one deployed it: the
// first tab's sections in the order sec_summary, sec_money, section_notes, section_grid_<relationship> — the grid BEHIND
// the Notes section, since the grid was appended to the end of the column after the Notes section was — and the
// timeline as it was written then: a generated control id in a one-row cell, no rows under it, no `auto`.
const releasedSpec = (subgrid) => specFor({ notes: true, subgrids: [subgrid], mutate: (s) => {
  s.forms[0].tabs = [{ name: 'tab_a', label: 'A', sections: [
    { name: 'sec_summary', label: 'Summary', columns: 2, fields: ['new_name', 'new_code'] },
    { name: 'sec_money', label: 'Money', columns: 1, fields: ['new_notes', 'new_area'] },
  ] }];
} });
const releasedNotesHost = () => ({ name: 'section_notes', label: 'Notes', visible: true, showLabel: true, columns: 1,
  rows: [{ cells: [{ control: { classId: NOTES_CLASS_ID, fieldName: null, label: 'Notes', showLabel: false, parameters: {} } }] }] });
const engineGridSection = () => ai.subgridSectionIntent({ subgridClassId: SUBGRID_CLASS_ID, targetEntity: 'new_task', relationshipName: TASK, viewId: VIEW_ID, label: 'Tasks' });
async function seedReleased(h, spec) {
  const tabs = compiledTabs(spec);
  const sections = tabs[0].columns[0].sections;
  sections[sections.findIndex((s) => s.name === 'section_notes')] = releasedNotesHost();
  sections.push(engineGridSection());
  await seedForm(h, tabs);
}
const RELEASED_ORDER = ['sec_summary', 'sec_money', 'section_notes', GRID_TASK];

for (const [label, subgrid, expected] of [
  ['with no placement, where it is', { childEntity: 'new_task' }, RELEASED_ORDER],
  ['after the first section — mid-form, ahead of the Notes section', { childEntity: 'new_task', after: 'sec_summary' }, ['sec_summary', GRID_TASK, 'sec_money', 'section_notes']],
  ['after the last section — directly after it, not behind the Notes section', { childEntity: 'new_task', after: 'sec_money' }, ['sec_summary', 'sec_money', GRID_TASK, 'section_notes']],
  ['before the first section', { childEntity: 'new_task', before: 'sec_summary' }, [GRID_TASK, 'sec_summary', 'sec_money', 'section_notes']],
  ['in its tab only, where it is', { childEntity: 'new_task', tab: 'tab_a' }, RELEASED_ORDER],
]) {
  test(`released form: a rebuild repairs the timeline in place and puts the grid ${label} — the same sections, in the order a new form gets`, async () => {
    const h = newHarness();
    const spec = releasedSpec(subgrid);
    await seedReleased(h, spec);
    const before = await fetched(h);
    assert.deepStrictEqual(layoutOf(before), [[RELEASED_ORDER]], 'the premise: the grid behind the Notes section');
    const timelineBefore = cellsOf(sectionOf(before, 'section_notes'))[0];
    assert.match(timelineBefore.control.id, /^[0-9a-f-]{36}$/, 'the premise: a generated control id');
    assert.deepStrictEqual([timelineBefore.rowspan, sectionOf(before, 'section_notes').rows.length], [1, 1], 'a one-row cell with nothing under it');
    assert.ok(!h.store.row.formxml.includes('notescontrol'), 'no notescontrol anywhere on the form');
    const gridId = sectionOf(before, GRID_TASK).id;
    const placed = expected !== RELEASED_ORDER;
    assert.strictEqual((await verifyForms(h, spec)).checks.find((c) => c.kind === 'form-timeline').present, false, 'verify: the timeline fix is not applied');
    if (placed) assert.strictEqual((await gridChecks(h, spec))[0].present, false, 'verify: the grid is not where the spec places it');

    const { writes } = await build(h, spec);
    const after = await fetched(h);
    assert.deepStrictEqual(layoutOf(after), [[expected]]);
    // The timeline is repaired in place: the same section and the same cell, now the shape Dynamics renders.
    const host = sectionOf(after, 'section_notes');
    assert.strictEqual(host.id, sectionOf(before, 'section_notes').id);
    assert.strictEqual(cellsOf(host)[0].id, timelineBefore.id);
    assert.deepStrictEqual([cellsOf(host)[0].control.id, cellsOf(host)[0].rowspan, host.rows.length], ['notescontrol', 23, 23]);
    // The grid is the same section, moved when the spec places it elsewhere — and it is the ONLY thing that moves:
    // not an authored section, not the Notes section.
    assert.strictEqual(sectionOf(after, GRID_TASK).id, gridId);
    const moves = writes.filter((m) => m.method === 'moveElement');
    assert.deepStrictEqual(moves.map((m) => m.args[2]), placed ? ['/tabs/0/columns/0/sections/3'] : [], 'the grid section, from where it was');
    assert.deepStrictEqual(writes.filter((m) => m.method !== 'moveElement').map((m) => [m.method, m.args[2].replace(/sections\/\d+/, 'sections/N')]), [['updateElement', '/tabs/0/columns/0/sections/N/rows']], 'the timeline repair is one write of the host\u2019s rows');
    for (const name of ['sec_summary', 'sec_money']) assert.deepStrictEqual(sectionOf(after, name), sectionOf(before, name), `${name} is untouched`);
    // Verify is clean, a second rebuild writes nothing, and a new form built from the same spec has the same order.
    const verified = await verifyForms(h, spec);
    assert.strictEqual(verified.checks.find((c) => c.kind === 'form-timeline').present, true);
    if (placed) assert.strictEqual((await gridChecks(h, spec))[0].present, true);
    assert.deepStrictEqual((await build(h, spec)).mutations, []);
    const created = newHarness(); delete created.store.row.formxml;
    await build(created, spec);
    assert.deepStrictEqual(layoutOf(await fetched(created)), layoutOf(after), 'a rebuilt form and a new one agree');
  });
}

test('released form, auto layout: the grid behind the Notes section is put directly after the one section, and the timeline repaired in place', async () => {
  const h = newHarness();
  const spec = specFor({ layout: 'auto', notes: true, subgrids: [{ childEntity: 'new_task', after: 'section_general' }] });
  const tabs = compiledTabs(spec);
  const sections = tabs[0].columns[0].sections;
  sections[sections.findIndex((s) => s.name === 'section_notes')] = releasedNotesHost();
  sections.push(engineGridSection());
  await seedForm(h, tabs);
  const before = await fetched(h);
  assert.deepStrictEqual(layoutOf(before), [[['section_general', 'section_notes', GRID_TASK]]]);
  const { writes } = await build(h, spec);
  const after = await fetched(h);
  assert.deepStrictEqual(layoutOf(after), [[['section_general', GRID_TASK, 'section_notes']]]);
  assert.strictEqual(sectionOf(after, GRID_TASK).id, sectionOf(before, GRID_TASK).id);
  assert.strictEqual(sectionOf(after, 'section_notes').id, sectionOf(before, 'section_notes').id);
  assert.deepStrictEqual([cellsOf(sectionOf(after, 'section_notes'))[0].control.id, sectionOf(after, 'section_notes').rows.length], ['notescontrol', 23]);
  assert.deepStrictEqual(writes.map((m) => m.method).sort(), ['moveElement', 'updateElement']);
  assert.ok((await gridChecks(h, spec)).every((c) => c.present));
  assert.strictEqual((await verifyForms(h, spec)).checks.find((c) => c.kind === 'form-timeline').present, true);
  assert.deepStrictEqual((await build(h, spec)).mutations, []);
  const created = newHarness(); delete created.store.row.formxml;
  await build(created, spec);
  assert.deepStrictEqual(layoutOf(await fetched(created)), layoutOf(after));
});

test('placed: a section a maker put between the grid and its anchor stays where it is, behind the grid — only the grid moves', async () => {
  const h = newHarness();
  const spec = specFor({ subgrids: [{ childEntity: 'new_task', after: 'sec_main' }], mutate: (s) => { s.forms[0].prune = false; } });
  const tabs = compiledTabs(specFor());
  const maker = { name: 'maker_section', label: 'Maker', visible: true, showLabel: true, columns: 1, rows: [{ cells: [ai.fieldCellIntent('new_extra')] }] };
  tabs[0].columns[0].sections.push(maker, engineGridSection());
  await seedForm(h, tabs);
  const before = await fetched(h);
  assert.deepStrictEqual(layoutOf(before)[0], [['sec_main', 'sec_more', 'maker_section', GRID_TASK]]);
  const unplaced = (await gridChecks(h, spec))[0];
  assert.strictEqual(unplaced.present, false);
  assert.match(unplaced.detail, /the grid is not directly after section 'sec_main' in tab 'tab_a' form-column 1: 'sec_more', 'maker_section' sit between them/);

  const { writes } = await build(h, spec);
  assert.deepStrictEqual(writes.map((m) => [m.method, m.args[2], m.args[4]]), [['moveElement', '/tabs/0/columns/0/sections/3', { index: 1 }]]);
  const after = await fetched(h);
  assert.deepStrictEqual(layoutOf(after)[0], [['sec_main', GRID_TASK, 'sec_more', 'maker_section']]);
  assert.deepStrictEqual(sectionOf(after, 'maker_section'), sectionOf(before, 'maker_section'), 'the maker\u2019s section is exactly what it was');
  assert.strictEqual((await gridChecks(h, spec))[0].present, true);
  assert.deepStrictEqual((await build(h, spec)).mutations, []);
});

test('placed: a grid moves DOWN the column too — to sit directly after a later section, ahead of the section that follows it', async () => {
  const h = newHarness(); delete h.store.row.formxml;
  const three = (subgrid) => specFor({ subgrids: [subgrid], mutate: (s) => { s.forms[0].tabs[0].sections.push({ name: 'sec_third', label: 'Third', columns: 1, fields: ['new_extra'] }); } });
  await build(h, three({ childEntity: 'new_task', after: 'sec_main' }));
  assert.deepStrictEqual(layoutOf(await fetched(h))[0], [['sec_main', GRID_TASK, 'sec_more', 'sec_third']]);
  const spec = three({ childEntity: 'new_task', after: 'sec_more' });
  const { writes } = await build(h, spec);
  assert.deepStrictEqual(writes.map((m) => [m.method, m.args[2], m.args[4]]), [['moveElement', '/tabs/0/columns/0/sections/1', { index: 2 }]]);
  assert.deepStrictEqual(layoutOf(await fetched(h))[0], [['sec_main', 'sec_more', GRID_TASK, 'sec_third']]);
  assert.strictEqual((await gridChecks(h, spec))[0].present, true);
  assert.deepStrictEqual((await build(h, spec)).mutations, []);
});

test('placed: two grids before one section sit in front of it in declared order, the one declared last against the section — new, or rebuilt from the end', async () => {
  const spec = specFor({ subgrids: [{ childEntity: 'new_task', before: 'sec_more' }, { childEntity: 'new_comment', before: 'sec_more' }] });
  const created = newHarness(); delete created.store.row.formxml;
  await build(created, spec);
  assert.deepStrictEqual(layoutOf(await fetched(created))[0], [['sec_main', GRID_TASK, GRID_COMMENT, 'sec_more']]);
  assert.ok((await gridChecks(created, spec)).every((c) => c.present));

  const old = newHarness(); delete old.store.row.formxml;
  await build(old, specFor({ subgrids: [{ childEntity: 'new_comment' }, { childEntity: 'new_task' }] }));
  assert.deepStrictEqual(layoutOf(await fetched(old))[0], [['sec_main', 'sec_more', GRID_COMMENT, GRID_TASK]], 'what an earlier build left: both at the end, the other way round');
  await build(old, spec);
  assert.deepStrictEqual(layoutOf(await fetched(old))[0], [['sec_main', GRID_TASK, GRID_COMMENT, 'sec_more']]);
  assert.ok((await gridChecks(old, spec)).every((c) => c.present));
  assert.deepStrictEqual((await build(old, spec)).mutations, []);
});

test('converge: a grid moves to another tab or form-column when the spec moves its placement, and keeps its section', async () => {
  const h = newHarness(); delete h.store.row.formxml;
  await build(h, specFor({ subgrids: [{ childEntity: 'new_task', tab: 'tab_b' }] }));
  const ids = idsByName(await fetched(h));
  const toA = specFor({ subgrids: [{ childEntity: 'new_task', tab: 'tab_a' }] });
  const { writes, warnings } = await build(h, toA);
  assert.deepStrictEqual(writes.map((m) => [m.method, m.args[2], m.args[3], m.args[4]]), [['moveElement', '/tabs/1/columns/0/sections/1', '/tabs/0/columns/0/sections', { index: 2 }]]);
  assert.match(warnings[0], /^form Main: moved the sub-grid for 'new_task' \(section 'section_grid_new_ticket_new_task'\) from tab 'tab_b' \(form-column 1\) to tab 'tab_a' \(form-column 1\), where subgrids\[\] places it\.$/);
  assert.deepStrictEqual(layoutOf(await fetched(h)), [[['sec_main', 'sec_more', GRID_TASK]], [['sec_b']]]);
  assert.strictEqual(idsByName(await fetched(h))[GRID_TASK], ids[GRID_TASK]);
  assert.deepStrictEqual((await build(h, toA)).mutations, []);

  // Between form-columns of one tab, then to the anchor's column.
  const cols = newHarness(); delete cols.store.row.formxml;
  await build(cols, specFor({ layout: 'columns', subgrids: [{ childEntity: 'new_task', tab: 'tab_a', column: 1 }] }));
  const toFirst = specFor({ layout: 'columns', subgrids: [{ childEntity: 'new_task', column: 0 }] });
  await build(cols, toFirst);
  assert.deepStrictEqual(layoutOf(await fetched(cols)), [[['sec_left', GRID_TASK], ['sec_right']]]);
  const toAnchor = specFor({ layout: 'columns', subgrids: [{ childEntity: 'new_task', after: 'sec_right' }] });
  await build(cols, toAnchor);
  assert.deepStrictEqual(layoutOf(await fetched(cols)), [[['sec_left'], ['sec_right', GRID_TASK]]]);
  assert.deepStrictEqual((await build(cols, toAnchor)).mutations, []);
  assert.ok((await gridChecks(cols, toAnchor)).every((c) => c.present));
});

test('converge: taking the placement out of the spec leaves the grid where it is — it is never moved for a spec that says nothing', async () => {
  const h = newHarness(); delete h.store.row.formxml;
  await build(h, specFor({ subgrids: [{ childEntity: 'new_task', after: 'sec_main' }] }));
  const placed = await fetched(h);
  assert.deepStrictEqual((await build(h, specFor({ subgrids: [{ childEntity: 'new_task' }] }))).mutations, []);
  assert.deepStrictEqual(await fetched(h), placed);
});

test('converge: a grid the maker put in a section of their own is never moved, the build says so, and verify keeps failing until it is placed', async () => {
  const h = newHarness();
  const spec = specFor({ subgrids: [{ childEntity: 'new_task', after: 'sec_main' }] });
  const tabs = compiledTabs(specFor());
  tabs[0].columns[0].sections.push(ai.subgridSectionIntent({ subgridClassId: SUBGRID_CLASS_ID, targetEntity: 'new_task', relationshipName: TASK, viewId: VIEW_ID, label: 'My tasks', sectionName: 'maker_grid' }));
  await seedForm(h, tabs);
  const before = h.store.row.formxml;
  const { built, mutations, warnings } = await build(h, spec);
  assert.deepStrictEqual(layoutMutations(mutations), [], 'nothing was written');
  assert.strictEqual(h.store.row.formxml, before);
  assert.deepStrictEqual(layoutOf(await fetched(h))[0], [['sec_main', 'sec_more', 'maker_grid']]);
  const note = /the sub-grid for 'new_task' sits in section 'maker_grid', which this build did not create, so it was left there\. Move that section in the maker, or delete it to let the build place a grid of its own\./;
  assert.ok(built.skipped.layout.some((m) => note.test(m)), JSON.stringify(built.skipped.layout));
  assert.ok(warnings.some((m) => note.test(m)));
  const [check] = await gridChecks(h, spec);
  assert.strictEqual(check.present, false, 'the grid is not where the spec places it, and verify says so');
});

test('converge: a grid in a section the maker made is left alone WITHOUT a report when it is already where the spec puts it', async () => {
  // The report says "move that section in the maker" — advice for a grid that is not in place. One that already is has
  // nothing to move, and a notice repeated on every rebuild is one the maker learns to ignore.
  const makerGrid = () => ai.subgridSectionIntent({ subgridClassId: SUBGRID_CLASS_ID, targetEntity: 'new_task', relationshipName: TASK, viewId: VIEW_ID, label: 'My tasks', sectionName: 'maker_grid' });
  for (const [label, subgrid, put] of [
    ['directly after its anchor', { childEntity: 'new_task', after: 'sec_main' }, (tabs) => tabs[0].columns[0].sections.splice(1, 0, makerGrid())],
    ['directly before its anchor', { childEntity: 'new_task', before: 'sec_more' }, (tabs) => tabs[0].columns[0].sections.splice(1, 0, makerGrid())],
    ['in the tab it names', { childEntity: 'new_task', tab: 'tab_b' }, (tabs) => tabs[1].columns[0].sections.push(makerGrid())],
    ['in the form-column it names', { childEntity: 'new_task', tab: 'tab_a', column: 0 }, (tabs) => tabs[0].columns[0].sections.push(makerGrid())],
  ]) {
    const h = newHarness();
    const spec = specFor({ subgrids: [subgrid] });
    const tabs = compiledTabs(specFor());
    put(tabs);
    await seedForm(h, tabs);
    assert.strictEqual((await gridChecks(h, spec))[0].present, true, `${label}: the premise — verify finds the grid in place`);
    const before = h.store.row.formxml;
    for (const run of ['first', 'second']) {
      const { built, mutations, warnings } = await build(h, spec);
      assert.deepStrictEqual(layoutMutations(mutations), [], `${label}, ${run} build: nothing is written`);
      assert.deepStrictEqual(built.skipped.layout, [], `${label}, ${run} build: nothing is reported`);
      assert.deepStrictEqual(warnings, [], `${label}, ${run} build`);
    }
    assert.strictEqual(h.store.row.formxml, before);
  }
});

test('converge: an anchor the deployed form does not have is reported, and the grid is added at the end of the first tab rather than lost', async () => {
  const h = newHarness();
  const spec = specFor({ layout: 'auto', subgrids: [{ childEntity: 'new_task', after: 'section_general' }] });
  const tabs = compiledTabs(spec);
  tabs[0].columns[0].sections[0].name = 'details'; // a form the maker built: no section carries the name the compiler gives an auto layout
  await seedForm(h, tabs);
  const { built, writes } = await build(h, spec);
  assert.deepStrictEqual(writes.map((m) => [m.method, m.args[2], m.args.length]), [['addElement', '/tabs/0/columns/0/sections', 4]]);
  assert.deepStrictEqual(layoutOf(await fetched(h)), [[['details', GRID_TASK]]]);
  assert.ok(built.skipped.layout.some((m) => /the sub-grid for 'new_task' was not placed after section 'section_general' — the deployed form has no such section or tab to place it by, so it was added at the end of the first tab\. Adjust the layout in the maker\./.test(m)), JSON.stringify(built.skipped.layout));
  const [check] = await gridChecks(h, spec);
  assert.strictEqual(check.present, false);
  assert.match(check.detail, /its anchor section 'section_general' is not on the deployed form, so where the grid sits cannot be proven/);
  assert.deepStrictEqual((await build(h, spec)).writes, [], 'a grid that is on the form is not added again');
});

test('converge: an anchor matched by label under another name is the anchor, and the grid lands beside the section the build matched', async () => {
  const h = newHarness();
  const spec = specFor({ subgrids: [{ childEntity: 'new_task', after: 'sec_main' }] });
  const tabs = compiledTabs(specFor());
  tabs[0].columns[0].sections[0].name = 'renamed_in_designer';
  await seedForm(h, tabs);
  const { writes } = await build(h, spec);
  assert.deepStrictEqual(writes.map((m) => [m.method, m.args[4]]), [['addElement', { position: { index: 1 } }]]);
  assert.deepStrictEqual(layoutOf(await fetched(h))[0], [['renamed_in_designer', GRID_TASK, 'sec_more']]);
  assert.strictEqual((await gridChecks(h, spec))[0].present, true);
});

// Adding or moving a section changes the index of every section after it, and the sweep of vacated sections that
// follows the grids decides which section the layout claims by where each recorded target RESOLVES to — which only
// the recorded index can tell apart when two sections share a name (a real one, and an emptied copy an older
// build left in another tab). A target left pointing at the wrong index resolves to the first of the two.
for (const how of ['added', 'moved in', 'moved out']) {
  test(`converge: the sweep of an emptied same-named section still finds the section the layout claims after a grid was ${how}`, async () => {
    const h = newHarness();
    const placing = how === 'moved out' ? { childEntity: 'new_task', tab: 'tab_a' } : { childEntity: 'new_task', before: 'sec_more' };
    const spec = specFor({ subgrids: [placing], mutate: (s) => { s.forms[0].tabs[0].sections.pop(); s.forms[0].tabs[0].sections[0].fields = ['new_name', 'new_code']; s.forms[0].tabs[1].sections[0] = { name: 'sec_more', label: 'More', columns: 1, fields: ['new_notes', 'new_area'] }; } });
    const tabs = compiledTabs(spec);
    const real = tabs[1].columns[0].sections[0];
    const twin = clone(real); // the copy an older build left: the same name, in the first tab, still holding the fields
    real.rows = [];
    tabs[0].columns[0].sections.push(twin);
    const engineGrid = ai.subgridSectionIntent({ subgridClassId: SUBGRID_CLASS_ID, targetEntity: 'new_task', relationshipName: TASK, viewId: VIEW_ID, label: 'Tasks' });
    if (how === 'moved in') tabs[0].columns[0].sections.push(engineGrid);
    if (how === 'moved out') tabs[1].columns[0].sections.unshift(engineGrid);
    await seedForm(h, tabs);
    const gridId = how === 'added' ? null : idsByName(await fetched(h))[GRID_TASK];

    const { warnings } = await build(h, spec);
    const form = await fetched(h);
    const expected = how === 'moved out' ? [[['sec_main', GRID_TASK]], [['sec_more']]] : [[['sec_main']], [[GRID_TASK, 'sec_more']]];
    assert.deepStrictEqual(layoutOf(form), expected, 'the emptied copy is reclaimed, not spared as if it were the claimed section');
    assert.ok(warnings.some((w) => /removed the now-empty section 'sec_more'/.test(w)), JSON.stringify(warnings));
    assert.strictEqual(sectionOf(form, 'sec_more').rows.reduce((n, r) => n + r.cells.length, 0), 2, 'the real section holds the fields');
    if (gridId) assert.strictEqual(idsByName(form)[GRID_TASK], gridId, 'the grid is the same section');
    assert.ok((await gridChecks(h, spec)).every((c) => c.present));
    assert.deepStrictEqual((await build(h, spec)).mutations, [], 'settled');
  });
}

test('converge: a field is still pruned from its section when a grid was added or moved in front of it', async () => {
  for (const how of ['added', 'moved']) {
    const h = newHarness();
    const old = specFor({ mutate: (s) => { s.forms[0].tabs[0].sections[1].fields.push('new_extra'); } });
    await seedForm(h, compiledTabs(old));
    if (how === 'moved') {
      const first = specFor({ subgrids: [{ childEntity: 'new_task' }], mutate: (s) => { s.forms[0].tabs[0].sections[1].fields.push('new_extra'); } });
      await build(h, first); // the grid at the end, the stale field still on the form
      assert.match(h.store.row.formxml, /new_extra/);
    }
    const spec = specFor({ subgrids: [{ childEntity: 'new_task', after: 'sec_main' }] }); // new_extra is no longer in the layout
    await build(h, spec);
    const form = await fetched(h);
    assert.deepStrictEqual(layoutOf(form)[0], [['sec_main', GRID_TASK, 'sec_more']], how);
    assert.ok(!h.store.row.formxml.includes('new_extra'), `${how}: the field is pruned from sec_more`);
    assert.strictEqual(sectionOf(form, GRID_TASK).rows.length, 1, `${how}: the grid section was not the one pruned`);
    assert.ok(h.store.row.formxml.includes('datafieldname="new_notes"') && h.store.row.formxml.includes('datafieldname="new_area"'), `${how}: sec_more keeps its other fields`);
    assert.deepStrictEqual((await build(h, spec)).mutations, [], `${how}: settled`);
  }
});

// --- a field the build ADDS is written to its own section, whatever a grid does to the sections' indices -------------

// A field new to the form is held in the plan until every positioning step is done, and the sub-grids are placed in
// between. A grid section added or moved in the middle of a column changes the index of every section behind it, so a
// field remembered by index would be written into whichever section holds that index by then — the grid's — or into
// none, which halts the forms phase. The field must land in the section it was meant for.

// The form as it was deployed before `field` was on it: the compiled tabs with that field's cell taken out.
const withoutField = (tabs, field) => {
  for (const section of tabs.flatMap((t) => t.columns.flatMap((c) => c.sections))) {
    for (const row of section.rows) row.cells = row.cells.filter((c) => !(c.control && c.control.fieldName === field));
    section.rows = section.rows.filter((r) => r.cells.length);
  }
  return tabs;
};
const fieldsOf = (section) => cellsOf(section).map((c) => c.control && c.control.fieldName).filter(Boolean);

for (const released of [false, true]) {
  test(`pending field: a field new to an auto form is written to the form's own section when a grid is put before that section${released ? ' — on the form the released builds deployed' : ''}`, async () => {
    const h = newHarness();
    const spec = specFor({ layout: 'auto', notes: released, subgrids: [{ childEntity: 'new_task', before: 'section_general' }] });
    const tabs = withoutField(compiledTabs(spec), 'new_extra');
    if (released) {
      const sections = tabs[0].columns[0].sections;
      sections[sections.findIndex((s) => s.name === 'section_notes')] = releasedNotesHost();
      sections.push(engineGridSection());
    }
    await seedForm(h, tabs);
    assert.ok(!h.store.row.formxml.includes('new_extra'), 'the premise: the field is not on the form');

    await build(h, spec);
    const after = await fetched(h);
    assert.deepStrictEqual(layoutOf(after), [[released ? [GRID_TASK, 'section_general', 'section_notes'] : [GRID_TASK, 'section_general']]]);
    assert.deepStrictEqual(fieldsOf(sectionOf(after, GRID_TASK)), [], 'the grid section holds no field');
    assert.strictEqual(cellsOf(sectionOf(after, GRID_TASK)).length, 1, 'only its grid');
    assert.ok(fieldsOf(sectionOf(after, 'section_general')).includes('new_extra'), 'new_extra is in the section the form always had');
    assert.deepStrictEqual((await build(h, spec)).mutations, [], 'settled: nothing is left to correct on a second build');
  });
}

test('pending field: a field in a section the spec adds is written to that section when a grid is put in front of it', async () => {
  const h = newHarness();
  await seedForm(h, compiledTabs(specFor()));
  const spec = specFor({ subgrids: [{ childEntity: 'new_task', after: 'sec_more' }], mutate: (s) => { s.forms[0].tabs[0].sections.push({ name: 'sec_new', label: 'New', columns: 1, fields: ['new_extra'] }); } });
  await build(h, spec);
  const after = await fetched(h);
  assert.deepStrictEqual(layoutOf(after), [[['sec_main', 'sec_more', GRID_TASK, 'sec_new']], [['sec_b']]]);
  assert.deepStrictEqual(fieldsOf(sectionOf(after, 'sec_new')), ['new_extra'], 'the new section holds its field');
  assert.deepStrictEqual(fieldsOf(sectionOf(after, GRID_TASK)), [], 'the grid section holds none');
  const topology = (await verifyForms(h, spec)).checks.find((c) => c.kind === 'form-topology');
  assert.strictEqual(topology.present, true, topology.detail);
  assert.ok((await gridChecks(h, spec)).every((c) => c.present));
  assert.deepStrictEqual((await build(h, spec)).mutations, [], 'one build is enough');
});

// A section that already lists a field the form has is a weak test of this: the build moves a new field beside its
// listed neighbour afterwards, which repairs a wrong landing. These give the FIRST field to a section with no
// neighbour to go by — `sec_b`, which the layout declares empty and the spec now gives `new_extra`.
for (const [how, first, next, expected] of [
  ['is added in front of it', null, { before: 'sec_b' }, [[['sec_main', 'sec_more']], [[GRID_TASK, 'sec_b']]]],
  ['leaves its form-column for another tab', { before: 'sec_b' }, { tab: 'tab_a' }, [[['sec_main', 'sec_more', GRID_TASK]], [['sec_b']]]],
  ['moves down past it', { before: 'sec_b' }, { after: 'sec_b' }, [[['sec_main', 'sec_more']], [['sec_b', GRID_TASK]]]],
  ['moves up from behind it', { after: 'sec_b' }, { before: 'sec_b' }, [[['sec_main', 'sec_more']], [[GRID_TASK, 'sec_b']]]],
]) {
  test(`pending field: the first field of a section is written to that section when the grid ${how} — the forms phase does not halt`, async () => {
    const h = newHarness(); delete h.store.row.formxml;
    await build(h, specFor({ subgrids: first ? [Object.assign({ childEntity: 'new_task' }, first)] : [] }));
    const spec = specFor({ subgrids: [Object.assign({ childEntity: 'new_task' }, next)], mutate: (s) => { s.forms[0].tabs[1].sections[0].fields.push('new_extra'); } });
    await build(h, spec);
    const after = await fetched(h);
    assert.deepStrictEqual(layoutOf(after), expected);
    assert.deepStrictEqual(fieldsOf(sectionOf(after, 'sec_b')), ['new_extra']);
    assert.deepStrictEqual(fieldsOf(sectionOf(after, GRID_TASK)), [], 'the grid section holds none');
    assert.ok((await gridChecks(h, spec)).every((c) => c.present));
    assert.deepStrictEqual((await build(h, spec)).mutations, [], 'settled');
  });
}

test('pending field: the grid sits between two sections and moves to another tab while the section behind it gains a field — the build does not halt', async () => {
  const h = newHarness(); delete h.store.row.formxml;
  await build(h, specFor({ subgrids: [{ childEntity: 'new_task', after: 'sec_main' }] }));
  assert.deepStrictEqual(layoutOf(await fetched(h))[0], [['sec_main', GRID_TASK, 'sec_more']], 'the premise: sec_main, the grid, sec_more');
  const spec = specFor({ subgrids: [{ childEntity: 'new_task', tab: 'tab_b' }], mutate: (s) => { s.forms[0].tabs[0].sections[1].fields.push('new_extra'); } });
  await build(h, spec);
  const after = await fetched(h);
  assert.deepStrictEqual(layoutOf(after), [[['sec_main', 'sec_more']], [['sec_b', GRID_TASK]]]);
  assert.ok(fieldsOf(sectionOf(after, 'sec_more')).includes('new_extra'), 'the new field is in sec_more');
  assert.deepStrictEqual(fieldsOf(sectionOf(after, GRID_TASK)), []);
  assert.ok((await gridChecks(h, spec)).every((c) => c.present));
  assert.deepStrictEqual((await build(h, spec)).mutations, [], 'settled');
});

test('pending field: with two sections of one name, the field goes to the one the layout claims — not the first of that name in the form', async () => {
  // The copy an older build left behind (empty, in the first tab) shares the name of the real section; a grid placed
  // before the real one shifts it, so a lookup by name alone would hand the field to the copy.
  const h = newHarness();
  const tabsOf = (fields) => [
    { name: 'tab_a', label: 'A', sections: [{ name: 'sec_main', label: 'Main', columns: 2, fields: ['new_name', 'new_code'] }] },
    { name: 'tab_b', label: 'B', sections: [{ name: 'sec_more', label: 'More', columns: 1, fields }] },
  ];
  const tabs = compiledTabs(specFor({ mutate: (s) => { s.forms[0].tabs = tabsOf([]); } }));
  tabs[0].columns[0].sections.push({ name: 'sec_more', label: 'More', visible: true, showLabel: true, columns: 1, rows: [] });
  await seedForm(h, tabs);
  const spec = specFor({ subgrids: [{ childEntity: 'new_task', before: 'sec_more' }], mutate: (s) => { s.forms[0].tabs = tabsOf(['new_extra']); } });
  await build(h, spec);
  const form = await fetched(h);
  assert.deepStrictEqual(layoutOf(form), [[['sec_main', 'sec_more']], [[GRID_TASK, 'sec_more']]], 'the copy stays where it was; the grid is ahead of the real section');
  const [copy, real] = sectionsOf(form).filter((s) => s.name === 'sec_more');
  assert.deepStrictEqual(fieldsOf(real), ['new_extra'], 'the real section holds the field');
  assert.deepStrictEqual(fieldsOf(copy), [], 'the copy holds nothing');
  assert.deepStrictEqual(fieldsOf(sectionOf(form, GRID_TASK)), []);
  assert.deepStrictEqual((await build(h, spec)).mutations, [], 'settled');
});

test('pending field: a section that is gone by the time its field is written does not halt the build — the field goes to the first field section, and is reported', async () => {
  const h = newHarness(); delete h.store.row.formxml;
  await build(h, specFor({ subgrids: [{ childEntity: 'new_task', before: 'sec_b' }] })); // tab_b: the grid, then sec_b
  const spec = specFor({ subgrids: [{ childEntity: 'new_task', tab: 'tab_a' }], mutate: (s) => { s.forms[0].tabs[1].sections[0].fields.push('new_extra'); } });
  const run = await h.freshSdk();
  const moveElement = run.sdk.moveElement.bind(run.sdk);
  run.sdk.moveElement = async (...args) => {
    const moved = await moveElement(...args);
    await run.sdk.removeElement('form', h.formId, '/tabs/1/columns/0/sections/0'); // sec_b — first in its column once the grid has left
    return moved;
  };
  const warnings = [];
  const built = await runSdkBuild(spec, { sdk: run.sdk, apply: true, phases: ['forms'], warn: (m) => warnings.push(String(m)) });
  assert.strictEqual(built.ok, true, JSON.stringify(built.error || built.halt || ''));
  const after = await fetched(h);
  assert.ok(!sectionOf(after, 'sec_b'), 'the premise: the section the field was queued for is gone');
  assert.ok(fieldsOf(sectionOf(after, 'sec_main')).includes('new_extra'), 'the form\u2019s first field section took the field');
  assert.deepStrictEqual(fieldsOf(sectionOf(after, GRID_TASK)), [], 'the grid section did not');
  assert.ok(built.skipped.layout.some((m) => /'new_extra' was added to the first section of the form — the section the layout names for it was no longer there/.test(m)), JSON.stringify(built.skipped.layout));
  assert.ok(warnings.some((m) => /'new_extra' was added to the first section of the form/.test(m)));
});

test('pending field: on the form the released builds deployed, a field in a section the spec adds is written to it when the grid moves in front of it', async () => {
  const h = newHarness();
  await seedReleased(h, releasedSpec({ childEntity: 'new_task' }));
  const spec = releasedSpec({ childEntity: 'new_task', after: 'sec_money' });
  spec.forms[0].tabs[0].sections.push({ name: 'sec_extra', label: 'Extra', columns: 1, fields: ['new_extra'] });
  await build(h, spec);
  const after = await fetched(h);
  assert.deepStrictEqual(layoutOf(after), [[['sec_summary', 'sec_money', GRID_TASK, 'sec_extra', 'section_notes']]]);
  assert.deepStrictEqual(fieldsOf(sectionOf(after, 'sec_extra')), ['new_extra']);
  assert.deepStrictEqual(fieldsOf(sectionOf(after, GRID_TASK)), []);
  assert.deepStrictEqual(fieldsOf(sectionOf(after, 'section_notes')), [], 'nor does the Notes section take it');
  const verified = await verifyForms(h, spec);
  assert.ok(verified.checks.filter((c) => ['form-topology', 'form-timeline', 'form-subgrid'].includes(c.kind)).every((c) => c.present), JSON.stringify(verified.missing));
  assert.deepStrictEqual((await build(h, spec)).mutations, []);
  const created = newHarness(); delete created.store.row.formxml;
  await build(created, spec);
  assert.deepStrictEqual(layoutOf(await fetched(created)), layoutOf(after), 'a rebuilt form and a new one agree');
});

test('converge: a move is ONE write, so an interrupted rebuild leaves the form as it was and a retry converges', async () => {
  const h = newHarness(); delete h.store.row.formxml;
  await build(h, specFor({ subgrids: [{ childEntity: 'new_task' }] }));
  const spec = specFor({ subgrids: [{ childEntity: 'new_task', after: 'sec_main' }] });
  const first = await h.freshSdk();
  const before = clone(await first.sdk.fetchArtifact('form', h.formId));
  const original = first.sdk.moveElement.bind(first.sdk);
  let injected = false;
  first.sdk.moveElement = async (...args) => { injected = true; throw new Error('injected write failure'); };
  await assert.rejects(() => runSdkBuild(spec, { sdk: first.sdk, apply: true, phases: ['forms'] }), /injected write failure/);
  assert.ok(injected, 'the fault was exercised');
  assert.deepStrictEqual(clone(await first.sdk.getArtifact('form', h.formId)), before);
  first.sdk.moveElement = original;
  assert.strictEqual((await runSdkBuild(spec, { sdk: first.sdk, apply: true, phases: ['forms'] })).ok, true);
  assert.deepStrictEqual(layoutOf(clone(await first.sdk.getArtifact('form', h.formId)))[0], [['sec_main', GRID_TASK, 'sec_more']]);
});
