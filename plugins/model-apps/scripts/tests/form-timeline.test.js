'use strict';
// The timeline's shape (lib/form-timeline.js): what the compiler writes, what a deployed timeline lacks, and
// what the build and verify read it by — and verify's model of what a build does with the other cells of a
// Notes host (notesHostInspector). Pure — the real-bundle tests prove the SDK serializes it, and that the model
// agrees with a real build.
const test = require('node:test');
const assert = require('node:assert');
const {
  TIMELINE_CLASS_ID, TIMELINE_CONTROL_ID, TIMELINE_ROWSPAN, TIMELINE_AUTO,
  isTimelineControl, timelineCellIntent, timelineRowsIntent, wantsTimeline,
  timelineInSection, timelinesOf, controlIdTaken, timelineRepairPlan, timelineProblem,
  timelineRefusal, timelineVerifyProblem,
} = require('../lib/form-timeline.js');
const { rowOccupancy, strandedRows } = require('../lib/form-occupancy.js');
// verify's model of what a build does with the other cells of a Notes host (see the last tests here).
const { notesHostInspector } = require('../lib/verify-spec.js');

// The shape an older build wrote: a control with a generated id in a one-row cell.
const oldHost = (over = {}) => ({
  name: 'section_notes', columns: 1,
  rows: [{ cells: [Object.assign({ rowspan: 1, control: { id: '9d6a0e0a-1b6c-4c4b-8f30-0a1f9a1d3c11', classId: TIMELINE_CLASS_ID.toLowerCase(), fieldName: null } }, over)] }],
});
const platformHost = () => ({
  name: 'section_notes', columns: 1,
  rows: timelineRowsIntent(TIMELINE_CLASS_ID),
});
// A host as the platform or a maker leaves it: a timeline cell `rowspan` rows tall under `notescontrol`, with
// `below` rows after its own (N-1 by default) and an `auto` attribute only when given.
const tallHost = ({ rowspan, below = rowspan - 1, auto, colspan = 1 }) => {
  const cell = { rowspan, colspan, control: { id: 'notescontrol', classId: TIMELINE_CLASS_ID, fieldName: null } };
  if (auto !== undefined) cell.bag = { a: [['auto', auto]], c: [] };
  return { name: 'section_notes', columns: colspan, rows: [{ cells: [cell] }, ...Array.from({ length: below }, () => ({ cells: [] }))] };
};

test('timeline: the platform shape is control id notescontrol, a 23-row cell with auto=false, and 22 empty rows', () => {
  assert.strictEqual(TIMELINE_CONTROL_ID, 'notescontrol');
  assert.strictEqual(TIMELINE_ROWSPAN, 23);
  const cell = timelineCellIntent(TIMELINE_CLASS_ID);
  assert.strictEqual(cell.control.id, 'notescontrol');
  assert.strictEqual(cell.control.classId, TIMELINE_CLASS_ID);
  assert.strictEqual(cell.control.fieldName, null);
  assert.strictEqual(cell.control.showLabel, false);
  assert.strictEqual(cell.control.label, 'Notes');
  assert.strictEqual(cell.rowspan, 23);
  assert.deepStrictEqual(cell.bag.a.find((p) => p[0] === 'auto'), ['auto', 'false']);
  // The platform spells these out and the SDK would omit them as defaults, so they are in the bag too.
  assert.deepStrictEqual(cell.bag.a.find((p) => p[0] === 'showlabel'), ['showlabel', 'false']);
  assert.deepStrictEqual(cell.bag.a.find((p) => p[0] === 'rowspan'), ['rowspan', '23']);
  const rows = timelineRowsIntent(TIMELINE_CLASS_ID);
  assert.strictEqual(rows.length, 23);
  assert.strictEqual(rows[0].cells.length, 1);
  assert.deepStrictEqual(rows.slice(1), Array.from({ length: 22 }, () => ({ cells: [] })), '22 empty spacer rows');
  assert.notStrictEqual(rows[1], rows[2], 'each spacer row is its own object (the SDK mints identity per node)');
});

test('timeline: a 23-row span over 22 spacer rows occupies one column of a one-column section, and no spacer is stranded', () => {
  const rows = platformHost().rows;
  const occupancy = rowOccupancy(rows);
  assert.strictEqual(occupancy.length, 23);
  assert.ok(occupancy.every((o) => o.used <= 1), 'no row overflows the one-column section');
  assert.deepStrictEqual(occupancy.slice(1).map((o) => o.reserved), Array(22).fill(1), 'every spacer row is reserved by the span above');
  // The empty-row prune keeps a row a span still reserves: asked about the whole span, it removes nothing.
  assert.deepStrictEqual(strandedRows(rows, 0, 23), []);
  assert.deepStrictEqual(strandedRows(rows, 5, 1), []);
  // …and it does remove them once nothing reserves them, so the guard is the span and not the empty row.
  assert.deepStrictEqual(strandedRows(rows.slice(1), 0, 22), Array.from({ length: 22 }, (_, i) => 21 - i));
});

test('timeline: only an unbound control of the timeline class is a timeline, whichever way the class id is written', () => {
  for (const classId of [TIMELINE_CLASS_ID, TIMELINE_CLASS_ID.toLowerCase(), `{${TIMELINE_CLASS_ID}}`, `{${TIMELINE_CLASS_ID.toLowerCase()}}`]) {
    assert.strictEqual(isTimelineControl({ classId, fieldName: null }), true, classId);
    assert.strictEqual(isTimelineControl({ classId }), true, `${classId} without a field name (published FormXML)`);
  }
  assert.strictEqual(isTimelineControl({ classId: TIMELINE_CLASS_ID, fieldName: 'new_name' }), false, 'a bound control is a field');
  assert.strictEqual(isTimelineControl({ classId: 'E7A81278-8635-4D9E-8D4D-59480B391C5B' }), false);
  assert.strictEqual(isTimelineControl(null), false);
});

test('timeline: a form asks for the timeline through notes:true or its table\u2019s hasNotes, on a Main form only', () => {
  const spec = { entities: [{ schemaName: 'new_a', hasNotes: true }, { schemaName: 'new_b' }] };
  assert.strictEqual(wantsTimeline(spec, { entity: 'new_b', notes: true }), true);
  assert.strictEqual(wantsTimeline(spec, { entity: 'NEW_A' }), true, 'hasNotes on the table, matched ignoring case');
  assert.strictEqual(wantsTimeline(spec, { entity: 'new_b' }), false);
  assert.strictEqual(wantsTimeline(spec, { entity: 'new_b', notes: 'yes' }), false, 'only a boolean true asks');
  for (const formType of ['QuickCreate', 'QuickView']) assert.strictEqual(wantsTimeline(spec, { entity: 'new_a', formType, notes: true }), false, formType);
  assert.strictEqual(wantsTimeline(spec, { entity: 'new_a', formType: 'Main' }), true);
  assert.strictEqual(wantsTimeline(spec, { entity: 'new_unknown' }), false, 'a form of an undeclared table has no hasNotes to read');
});

test('timeline: it is found in the SDK tree and in the published-FormXML parse alike, with where it sits', () => {
  const sdkShape = platformHost();
  const found = timelineInSection(sdkShape);
  assert.deepStrictEqual([found.rowIndex, found.cellIndex, found.rowspan, found.rowsBelow, found.onlyCell, found.id, found.auto], [0, 0, 23, 22, true, 'notescontrol', 'false']);
  // verify's parse of `<cell colspan="1" rowspan="23" auto="false"><control id="notescontrol" classid="{…}" />` + 22 `<row />`
  const parsed = { rows: [{ cells: [{ colspan: 1, rowspan: 23, auto: 'false', control: { id: 'notescontrol', classId: `{${TIMELINE_CLASS_ID}}` } }] }, ...Array.from({ length: 22 }, () => ({ cells: [] }))] };
  const again = timelineInSection(parsed);
  assert.deepStrictEqual([again.rowspan, again.rowsBelow, again.id, again.auto], [23, 22, 'notescontrol', 'false']);
  assert.strictEqual(timelineInSection({ rows: [{ cells: [{ control: { fieldName: 'new_name' } }] }] }), null);
  assert.strictEqual(timelineInSection({}), null);
  // A host a maker added a field to is not "only" the timeline.
  const mixed = oldHost();
  mixed.rows.push({ cells: [{ control: { fieldName: 'new_x' } }] });
  assert.strictEqual(timelineInSection(mixed).onlyCell, false);
  // The first timeline in reading order is the one reported, wherever it is.
  const form = { tabs: [{ columns: [{ sections: [{ rows: [] }, platformHost()] }, { sections: [oldHost()] }] }] };
  assert.deepStrictEqual(timelinesOf(form.tabs).map((t) => [t.ti, t.ci, t.si]), [[0, 0, 1], [0, 1, 0]]);
});

test('timeline repair plan: an old host lacks the id, the span, the rows under it and auto — a platform host lacks nothing', () => {
  assert.deepStrictEqual(timelineRepairPlan(timelineInSection(oldHost())), { id: 'notescontrol', rowspan: 23, addRows: 22, auto: 'false' });
  assert.deepStrictEqual(timelineRepairPlan(timelineInSection(platformHost())), {});
  // Only what is missing is planned: a maker who fixed the id by hand keeps it.
  const idOnly = oldHost();
  idOnly.rows[0].cells[0].control.id = 'notescontrol';
  assert.deepStrictEqual(timelineRepairPlan(timelineInSection(idOnly)), { rowspan: 23, addRows: 22, auto: 'false' });
});

test('timeline repair plan: a span the maker already set above one row is respected; only the rows that back it are added', () => {
  const sized = oldHost({ rowspan: 8 });
  sized.rows[0].cells[0].control.id = 'notescontrol';
  sized.rows[0].cells[0].bag = { a: [['auto', 'false']], c: [] };
  assert.deepStrictEqual(timelineRepairPlan(timelineInSection(sized)), { addRows: 7 }, 'kept at 8, with the 7 rows it spans');
  for (let i = 0; i < 7; i += 1) sized.rows.push({ cells: [] });
  assert.deepStrictEqual(timelineRepairPlan(timelineInSection(sized)), {}, 'a host the maker sized is already in shape');
  const partial = platformHost();
  partial.rows.length = 10;
  assert.deepStrictEqual(timelineRepairPlan(timelineInSection(partial)), { addRows: 13 }, 'rows a maker deleted are put back');
});

// Platform forms do not share one height: the timeline on Account, Contact and others is a cell of 20, 5, 23 rows,
// each followed by exactly the rows it spans, and a maker can resize it in the designer. `auto="false"` is on some
// and absent on others, and the cell is one column wide or two. None of that is a defect to repair.
test('timeline repair plan: a cell of any height with the rows it spans is in shape — whatever its auto and its width', () => {
  for (const host of [
    tallHost({ rowspan: 20 }), // no `auto`, as on the Account form
    tallHost({ rowspan: 5, auto: 'false', colspan: 2 }), // as on the Contact form
    tallHost({ rowspan: 23, auto: 'false' }),
    tallHost({ rowspan: 2 }),
    tallHost({ rowspan: 40, auto: 'true' }),
  ]) {
    const found = timelineInSection(host);
    assert.deepStrictEqual(timelineRepairPlan(found), {}, `${found.rowspan} rows, auto ${found.auto}`);
    assert.strictEqual(timelineProblem(found), '');
    assert.strictEqual(timelineProblem(found, { host: true }), '', 'the engine\u2019s own host included');
  }
  // Rows a resize left behind are not the build's to delete.
  assert.deepStrictEqual(timelineRepairPlan(timelineInSection(tallHost({ rowspan: 5, below: 22 }))), {});
});

test('timeline repair plan: a cell that only lacks rows is given those rows — to ITS height, not the platform\u2019s — and auto is not written for it', () => {
  assert.deepStrictEqual(timelineRepairPlan(timelineInSection(tallHost({ rowspan: 5, below: 1 }))), { addRows: 3 });
  assert.deepStrictEqual(timelineRepairPlan(timelineInSection(tallHost({ rowspan: 20, below: 0, auto: 'false' }))), { addRows: 19 });
  // `auto` comes with converting a cell an older build wrote (a new id or a new span), never by itself.
  const wrongId = tallHost({ rowspan: 8 });
  wrongId.rows[0].cells[0].control.id = '9d6a0e0a-1b6c-4c4b-8f30-0a1f9a1d3c11';
  assert.deepStrictEqual(timelineRepairPlan(timelineInSection(wrongId)), { id: 'notescontrol', auto: 'false' });
  assert.deepStrictEqual(timelineRepairPlan(timelineInSection(tallHost({ rowspan: 8, auto: 'true' }))), {}, 'a value a maker set is not overwritten while nothing else needs writing');
});

test('timeline problem: a generated id and a one-row cell are why it does not render; the spacer rows and auto are not the verdict', () => {
  assert.strictEqual(timelineProblem(timelineInSection(platformHost())), '');
  assert.match(timelineProblem(timelineInSection(oldHost())), /control id is '9d6a0e0a-1b6c-4c4b-8f30-0a1f9a1d3c11', not 'notescontrol' and its cell spans 1 row/);
  const noId = timelineInSection({ rows: [{ cells: [{ rowspan: 23, control: { classId: TIMELINE_CLASS_ID } }] }] });
  assert.match(timelineProblem(noId), /control id is '\(none\)'/);
  const bareButTall = platformHost();
  bareButTall.rows.length = 1;
  delete bareButTall.rows[0].cells[0].bag;
  assert.strictEqual(timelineProblem(timelineInSection(bareButTall)), '', 'the verdict is the id and the span, which a maker\u2019s own timeline also has');
  assert.strictEqual(TIMELINE_AUTO, 'false');
});

test('timeline problem: the engine\u2019s own host is judged by its rows too — the build converges them — and a maker\u2019s timeline is not', () => {
  const unbacked = timelineInSection(tallHost({ rowspan: 20, below: 3 }));
  assert.strictEqual(timelineProblem(unbacked), '', 'a timeline a maker added: the id and the span');
  assert.strictEqual(timelineProblem(unbacked, { host: true }), 'its cell spans 20 rows but only 3 row(s) follow it');
  assert.strictEqual(timelineProblem(timelineInSection(tallHost({ rowspan: 20, below: 19 })), { host: true }), '');
  assert.strictEqual(timelineProblem(timelineInSection(tallHost({ rowspan: 5, below: 30 })), { host: true }), '', 'more rows than the span needs is not a problem');
  // Both reasons are said when both hold.
  const both = tallHost({ rowspan: 1 });
  both.rows[0].cells[0].control.id = 'generated';
  assert.match(timelineProblem(timelineInSection(both), { host: true }), /^the control id is 'generated', not 'notescontrol' and its cell spans 1 row$/);
});

test('timeline control id: a second `notescontrol` is detected wherever it is, and the control itself is excepted', () => {
  const host = platformHost();
  const other = { rows: [{ cells: [{ control: { id: 'NotesControl', classId: 'x' } }] }] };
  const tabs = [{ columns: [{ sections: [host, other] }] }];
  assert.strictEqual(controlIdTaken(tabs, 'notescontrol'), true);
  assert.strictEqual(controlIdTaken(tabs, 'notescontrol', host.rows[0].cells[0].control), true, 'the other one still counts');
  assert.strictEqual(controlIdTaken([{ columns: [{ sections: [host] }] }], 'notescontrol', host.rows[0].cells[0].control), false, 'a control is not a duplicate of itself');
  assert.strictEqual(controlIdTaken([], 'notescontrol'), false);
});

// --- why a build declines to repair a host, and what --verify says to do about it ---------------------------------

// The published form's tabs, holding the given sections in one form-column. `isHost` is what verify asks of a section:
// whether it is the engine's own Notes host (the section the compiler names `section_notes`).
const formTabs = (...sections) => [{ columns: [{ sections }] }];
const isHost = (section) => section.name === 'section_notes';
const makerControl = (id) => ({ name: 'maker_section', rows: [{ cells: [{ control: { id, classId: '{9fdf5f91-88b1-47f4-ad53-c11efbb3e0d8}' } }] }] });
const hostWith = (...more) => { const host = oldHost(); for (const cell of more) host.rows.push({ cells: [cell] }); return host; };

test('timeline refusal: a host the build can repair has none — an old one, a short one, a host already in shape', () => {
  for (const host of [oldHost(), tallHost({ rowspan: 20, below: 3 }), platformHost()]) {
    const tabs = formTabs(host);
    assert.strictEqual(timelineRefusal(tabs, timelineInSection(host)), null);
  }
});

test('timeline refusal: a host that also holds another control is refused — and its other control is why, not the id', () => {
  const host = hostWith({ control: { fieldName: 'new_x' } });
  assert.strictEqual(timelineRefusal(formTabs(host), timelineInSection(host)), 'other-controls');
  // A host already in shape needs nothing, so it is never refused for what else it holds.
  const inShape = platformHost();
  inShape.rows.push({ cells: [{ control: { fieldName: 'new_x' } }] });
  assert.strictEqual(timelineRefusal(formTabs(inShape), timelineInSection(inShape)), null);
  // Both reasons at once: the build tests the section's other controls first, so it is the one reported.
  const both = hostWith({ control: { fieldName: 'new_x' } });
  assert.strictEqual(timelineRefusal(formTabs(both, makerControl('notescontrol')), timelineInSection(both)), 'other-controls');
});

test('timeline refusal: an old host whose id another control already holds is refused — a host that has the id itself is not', () => {
  const host = oldHost();
  assert.strictEqual(timelineRefusal(formTabs(host, makerControl('notescontrol')), timelineInSection(host)), 'id-taken');
  assert.strictEqual(timelineRefusal(formTabs(host, makerControl('NotesControl')), timelineInSection(host)), 'id-taken', 'ids compared ignoring case');
  assert.strictEqual(timelineRefusal(formTabs(host, makerControl('something_else')), timelineInSection(host)), null);
  // The host's own id is not "taken": only a second control by that id is.
  const idRight = oldHost();
  idRight.rows[0].cells[0].control.id = 'notescontrol';
  assert.strictEqual(timelineRefusal(formTabs(idRight), timelineInSection(idRight)), null);
});

const FULL_BUILD = /run a full build of the spec \(not --changed-only, which skips a spec that has not changed\)/;

test('timeline verify: a form that carries a timeline that renders has nothing to report — whoever added it', () => {
  assert.strictEqual(timelineVerifyProblem(formTabs(platformHost()), isHost), '');
  assert.strictEqual(timelineVerifyProblem(formTabs(tallHost({ rowspan: 5 })), isHost), '');
  // A timeline a maker added, in a section of their own, is as good as the engine's.
  const own = tallHost({ rowspan: 8 });
  own.name = 'maker_timeline';
  assert.strictEqual(timelineVerifyProblem(formTabs(oldHost(), own), isHost), '', 'one that renders is enough, whatever else is on the form');
});

test('timeline verify: an old host the build can repair says to run a FULL build — --changed-only skips a spec that has not changed', () => {
  const problem = timelineVerifyProblem(formTabs(oldHost()), isHost);
  assert.match(problem, /^the deployed form's timeline does not render: the control id is '9d6a0e0a-1b6c-4c4b-8f30-0a1f9a1d3c11', not 'notescontrol' and its cell spans 1 row — /);
  assert.match(problem, FULL_BUILD);
  assert.match(problem, /to repair it in place$/);
});

test('timeline verify: a host the build declines to repair says why, and does not promise a repair it will not make', () => {
  const crowded = timelineVerifyProblem(formTabs(hostWith({ control: { fieldName: 'new_x' } })), isHost);
  assert.match(crowded, /^the deployed form's timeline does not render: /);
  assert.match(crowded, /the Notes section also holds other controls, so a build leaves it as it is; move them out of it, or delete the section, in the maker, then run a full build/);
  assert.match(crowded, FULL_BUILD);
  assert.doesNotMatch(crowded, /repair it in place/);

  const taken = timelineVerifyProblem(formTabs(oldHost(), makerControl('notescontrol')), isHost);
  assert.match(taken, /another control on the form already uses the id 'notescontrol', so a build cannot give this timeline that id; remove or rename one of the two in the maker, then run a full build/);
  assert.match(taken, FULL_BUILD);
  assert.doesNotMatch(taken, /repair it in place/);
});

test('timeline verify: the engine\u2019s own host is the one reported when a maker\u2019s timeline does not render either', () => {
  const own = tallHost({ rowspan: 1 });
  own.name = 'maker_timeline';
  own.rows[0].cells[0].control.id = 'maker_notes';
  const problem = timelineVerifyProblem(formTabs(own, oldHost()), isHost);
  assert.match(problem, /control id is '9d6a0e0a-1b6c-4c4b-8f30-0a1f9a1d3c11'/, 'the host, which the build repairs');
  assert.doesNotMatch(problem, /maker_notes/);
});

test('timeline verify: a timeline the maker added that does not render is left alone by the build — it adds its own Notes section beside it, unless the id is taken', () => {
  const own = tallHost({ rowspan: 1 });
  own.name = 'maker_timeline';
  own.rows[0].cells[0].control.id = 'maker_notes';
  const free = timelineVerifyProblem(formTabs(own), isHost);
  assert.match(free, /^the deployed form's timeline does not render: the control id is 'maker_notes', not 'notescontrol' and its cell spans 1 row — it is a timeline the build did not add, so a build leaves it as it is; run a full build/);
  assert.match(free, FULL_BUILD);
  assert.match(free, /to add the Notes section beside it$/);

  // The same timeline holding the id, in a one-row cell: no second `notescontrol` is made, so a full build is no remedy.
  const holder = tallHost({ rowspan: 1 });
  holder.name = 'maker_timeline';
  const blocked = timelineVerifyProblem(formTabs(holder), isHost);
  assert.match(blocked, /^the deployed form's timeline does not render: its cell spans 1 row — it is a timeline the build did not add, so a build leaves it as it is, and adds no Notes section while a control uses the id 'notescontrol'; fix it in the maker \(the id 'notescontrol' and a cell spanning more than one row\) or delete it, then run a full build/);
});

test('timeline verify: a form with no timeline is told to run a full build to add one — unless another control holds the id a timeline needs', () => {
  const none = timelineVerifyProblem(formTabs({ name: 'section_general', rows: [{ cells: [{ control: { fieldName: 'new_name' } }] }] }), isHost);
  assert.match(none, /^the spec asks for the Notes timeline, but the deployed form has no timeline control — run a full build of the spec/);
  assert.match(none, FULL_BUILD);
  assert.match(none, /to add it$/);
  assert.match(timelineVerifyProblem([], isHost), /has no timeline control — run a full build/, 'a form with no tabs at all');

  const blocked = timelineVerifyProblem(formTabs(makerControl('notescontrol')), isHost);
  assert.match(blocked, /^the spec asks for the Notes timeline, but the deployed form has no timeline control, and another control already uses the id 'notescontrol' that a timeline needs, so a build adds none — remove or rename that control in the maker, then run a full build/);
  assert.doesNotMatch(blocked, /to add it/);
});

// --- what a build does with the host's OTHER cells before it judges the section ----------------------------------------

test('timeline: the cells a section holds besides its timeline are reported with it — spacer rows are not cells', () => {
  assert.deepStrictEqual(timelineInSection(platformHost()).others, []);
  assert.deepStrictEqual(timelineInSection(oldHost()).others, []);
  const field = { control: { fieldName: 'new_x' } };
  const web = { control: { classId: '{9fdf5f91-88b1-47f4-ad53-c11efbb3e0d8}' } };
  const host = hostWith(field, web);
  host.rows.push({ cells: [] });
  const found = timelineInSection(host);
  assert.strictEqual(found.others.length, 2);
  assert.strictEqual(found.others[0], field, 'the very cells of the tree, so a caller can tell which is which');
  assert.strictEqual(found.others[1], web);
  assert.strictEqual(found.onlyCell, false);
});

test('timeline refusal: a cell the build takes out first is no obstacle — one that stays still is, and so is an id another control holds', () => {
  const stray = { control: { fieldName: 'new_x' } };
  const kept = { control: { fieldName: 'new_y' } };
  const one = hostWith(stray);
  const oneFound = timelineInSection(one);
  assert.strictEqual(timelineRefusal(formTabs(one), oneFound), 'other-controls', 'judged as published, every other cell counts');
  assert.strictEqual(timelineRefusal(formTabs(one), oneFound, { leaving: [stray] }), null);
  assert.strictEqual(timelineRefusal(formTabs(one), oneFound, { leaving: [{ control: { fieldName: 'new_x' } }] }), 'other-controls', 'a cell is itself, not whatever looks like it');
  const two = hostWith(stray, kept);
  assert.strictEqual(timelineRefusal(formTabs(two), timelineInSection(two), { leaving: [stray] }), 'other-controls', 'the one that stays refuses');
  assert.strictEqual(timelineRefusal(formTabs(two), timelineInSection(two), { leaving: [stray, kept] }), null);
  // The id is its own reason: a cell leaving frees nothing another control holds.
  assert.strictEqual(timelineRefusal(formTabs(one, makerControl('notescontrol')), oneFound, { leaving: [stray] }), 'id-taken');
});

test('timeline verify: a field the build takes out of the host first is not left to the maker — the advice is to build, and says what the build does first', () => {
  const tabs = formTabs(hostWith({ control: { fieldName: 'new_x' } }));
  const removed = timelineVerifyProblem(tabs, isHost, { inspect: () => ({ name: "the field 'new_x'", goes: 'your layout does not list it, so it is removed', destructive: true }) });
  assert.match(removed, /^the deployed form's timeline does not render: .* — run a full build of the spec \(not --changed-only, which skips a spec that has not changed\) to repair it in place; the build first takes the field 'new_x' \(your layout does not list it, so it is removed\) out of the Notes section, and removing a field needs --allow-destructive$/);
  assert.doesNotMatch(removed, /move (?:it|them) out|as it is/);
  // A move is not a removal: nothing there needs the flag.
  const moved = timelineVerifyProblem(tabs, isHost, { inspect: () => ({ name: "the field 'new_x'", goes: "your layout places it in section 'sec_more', so it is moved there" }) });
  assert.match(moved, /to repair it in place; the build first takes the field 'new_x' \(your layout places it in section 'sec_more', so it is moved there\) out of the Notes section$/);
  assert.doesNotMatch(moved, /--allow-destructive/);
  // A cell it cannot name is still said to go.
  assert.match(timelineVerifyProblem(tabs, isHost, { inspect: () => ({ goes: 'it is moved' }) }), /the build first takes a control \(it is moved\) out of the Notes section$/);
  // Several are each named, and the flag is for the removal among them.
  const cells = [{ control: { fieldName: 'new_a' } }, { control: { fieldName: 'new_b' } }, { control: { fieldName: 'new_c' } }];
  const verdicts = new Map([
    [cells[0], { name: "the field 'new_a'", goes: 'moved' }],
    [cells[1], { name: "the field 'new_b'", goes: 'removed', destructive: true }],
    [cells[2], { name: "the field 'new_c'", goes: 'moved too' }],
  ]);
  const several = timelineVerifyProblem(formTabs(hostWith(...cells)), isHost, { inspect: (cell) => verdicts.get(cell) });
  assert.match(several, /; the build first takes the field 'new_a' \(moved\), the field 'new_b' \(removed\) and the field 'new_c' \(moved too\) out of the Notes section, and removing a field needs --allow-destructive$/);
});

test('timeline verify: a host that still holds what the build leaves is told which control to move, and what the build takes out first', () => {
  const leaves = { control: { fieldName: 'new_a' } };
  const keeps = { control: { fieldName: 'new_b' } };
  const web = { control: { classId: '{9fdf5f91-88b1-47f4-ad53-c11efbb3e0d8}' } };
  const verdicts = new Map([
    [leaves, { name: "the field 'new_a'", goes: 'your layout does not list it, so it is removed', destructive: true }],
    [keeps, { name: "the field 'new_b'" }],
  ]);
  const inspect = (cell) => verdicts.get(cell); // nothing for a cell it knows nothing about
  const one = timelineVerifyProblem(formTabs(hostWith(leaves, keeps)), isHost, { inspect });
  assert.match(one, / — the Notes section also holds the field 'new_b', which a build does not remove, so the build leaves the section as it is; move it out of it, or delete the section, in the maker, then run a full build of the spec \(not --changed-only, which skips a spec that has not changed\); the build first takes the field 'new_a' \(your layout does not list it, so it is removed\) out of the Notes section, and removing a field needs --allow-destructive$/);
  assert.doesNotMatch(one, /repair it in place/);
  // What it cannot name is counted.
  assert.match(timelineVerifyProblem(formTabs(hostWith(keeps, web)), isHost, { inspect }), /also holds the field 'new_b' and 1 other control, which a build does not remove, so the build leaves the section as it is; move them out of it, or delete the section/);
  const unnamed = timelineVerifyProblem(formTabs(hostWith(web, { control: { classId: '{e7a81278-8635-4d9e-8d4d-59480b391c5b}' } })), isHost, { inspect });
  assert.match(unnamed, /also holds 2 other controls, which a build does not remove, so the build leaves the section as it is; move them out of it/);
  assert.doesNotMatch(unnamed, /the build first takes/);
  assert.match(timelineVerifyProblem(formTabs(hostWith(web)), isHost, { inspect: () => undefined }), /also holds 1 other control, which a build does not remove, so the build leaves the section as it is; move it out of it/, 'no verdict is a control that stays');
});

test('timeline verify: a cell verify cannot predict is neither promised to go nor left to the maker — it says it cannot tell, and what to do if the build leaves it', () => {
  const field = { control: { fieldName: 'new_x' } };
  const twice = { name: "the field 'new_x'", unsure: 'it is on the form more than once' };
  const problem = timelineVerifyProblem(formTabs(hostWith(field)), isHost, { inspect: () => twice });
  assert.match(problem, /^the deployed form's timeline does not render: .* — run a full build of the spec \(not --changed-only, which skips a spec that has not changed\); the build repairs the timeline in place unless it leaves the field 'new_x' \(it is on the form more than once\) in the Notes section, and verify cannot tell whether it does — a build acts on one cell of such a field, and which one depends on how it arranges the form\. If its report says the timeline was left as it is, move that cell out of the section in the maker and run a full build again$/);
  // It is not a control that stays (the build may well take it out), and it is not one the build takes out either — and the repair
  // is not promised: whether it happens is exactly what verify cannot tell.
  assert.doesNotMatch(problem, /which a build does not remove|so the build leaves the section as it is|the build first takes|to repair it in place/);
  // A removal it might be says what that needs.
  assert.match(timelineVerifyProblem(formTabs(hostWith(field)), isHost, { inspect: () => Object.assign({ destructive: true }, twice) }), /run a full build again \(removing a field needs --allow-destructive\)$/);
  // The same field held twice is named once, and the cells are plural.
  const two = timelineVerifyProblem(formTabs(hostWith(field, { control: { fieldName: 'new_x' } })), isHost, { inspect: () => twice });
  assert.match(two, /unless it leaves the field 'new_x' \(it is on the form more than once\) in the Notes section, and verify cannot tell whether it does/);
  assert.strictEqual(two.split("the field 'new_x'").length - 1, 1, 'named once');
  assert.match(two, /move those cells out of the section in the maker/);
  // A cell it cannot name is still said to be one it cannot tell about.
  assert.match(timelineVerifyProblem(formTabs(hostWith(field)), isHost, { inspect: () => ({ unsure: 'it is a mystery' }) }), /unless it leaves a control \(it is a mystery\) in the Notes section, and verify cannot tell whether it does/);
  // Different fields are each named, with their own reason — as alternatives: the repair fails if the build leaves either.
  const verdicts = new Map();
  const cells = [{ control: { fieldName: 'new_a' } }, { control: { fieldName: 'new_b' } }];
  verdicts.set(cells[0], { name: "the field 'new_a'", unsure: 'it is on the form more than once' });
  verdicts.set(cells[1], { name: "the field 'new_b'", unsure: "its anchor 'new_z' is on the form more than once" });
  assert.match(timelineVerifyProblem(formTabs(hostWith(...cells)), isHost, { inspect: (cell) => verdicts.get(cell) }), /unless it leaves the field 'new_a' \(it is on the form more than once\) or the field 'new_b' \(its anchor 'new_z' is on the form more than once\) in the Notes section, and verify cannot tell whether it does/);
});

test('timeline verify: a taken id does not hide what verify cannot tell — freeing the id leaves the cell to the build, and the advice says so', () => {
  const field = { control: { fieldName: 'new_x' } };
  const twice = { name: "the field 'new_x'", unsure: 'it is on the form more than once' };
  const taken = (inspect, ...cells) => timelineVerifyProblem(formTabs(hostWith(...(cells.length ? cells : [field])), makerControl('notescontrol')), isHost, { inspect });
  const problem = taken(() => twice);
  assert.match(problem, /^the deployed form's timeline does not render: .* — another control on the form already uses the id 'notescontrol', so a build cannot give this timeline that id; remove or rename one of the two in the maker, then run a full build of the spec \(not --changed-only, which skips a spec that has not changed\); verify cannot tell whether the build takes the field 'new_x' \(it is on the form more than once\) out of the Notes section first — a build acts on one cell of such a field, and which one depends on how it arranges the form\. If its report says the timeline was left as it is, move that cell out of the section in the maker and run a full build again$/);
  assert.doesNotMatch(problem, /repair it in place|which a build does not remove|so the build leaves the section as it is/);
  // A removal it might be says what that needs.
  assert.match(taken(() => Object.assign({ destructive: true }, twice)), /run a full build again \(removing a field needs --allow-destructive\)$/);
  // What a build takes out first is not said while the id is the reason, so what it cannot tell is not something it "also" takes out.
  const goes = { control: { fieldName: 'new_a' } };
  const verdicts = new Map([[goes, { name: "the field 'new_a'", goes: 'moved' }], [field, twice]]);
  const mixed = taken((cell) => verdicts.get(cell), goes, field);
  assert.match(mixed, /then run a full build of the spec \(not --changed-only, which skips a spec that has not changed\); verify cannot tell whether the build takes the field 'new_x' \(it is on the form more than once\) out of the Notes section first/);
  assert.doesNotMatch(mixed, /the build first takes|also takes|the field 'new_a'/);
  // Nothing it cannot tell, nothing more to say: the id is the whole advice.
  assert.doesNotMatch(taken(() => ({ name: "the field 'new_x'", goes: 'moved' })), /cannot tell/);
  assert.doesNotMatch(taken(() => ({ name: "the field 'new_x'" })), /cannot tell/);
});

test('timeline verify: what a build takes out first, what it leaves and what verify cannot tell are each said once, in that order', () => {
  const leaves = { control: { fieldName: 'new_a' } };
  const keeps = { control: { fieldName: 'new_b' } };
  const maybe = { control: { fieldName: 'new_c' } };
  const verdicts = new Map([
    [leaves, { name: "the field 'new_a'", goes: 'your layout does not list it, so it is removed', destructive: true }],
    [keeps, { name: "the field 'new_b'" }],
    [maybe, { name: "the field 'new_c'", unsure: 'it is on the form more than once' }],
  ]);
  const inspect = (cell) => verdicts.get(cell);
  // Something that certainly stays: the build refuses whatever it does about the rest, and the maker is told to move it.
  const all = timelineVerifyProblem(formTabs(hostWith(leaves, keeps, maybe)), isHost, { inspect });
  assert.match(all, / — the Notes section also holds the field 'new_b', which a build does not remove, so the build leaves the section as it is; move it out of it, or delete the section, in the maker, then run a full build of the spec \(not --changed-only, which skips a spec that has not changed\); the build first takes the field 'new_a' \(your layout does not list it, so it is removed\) out of the Notes section, and removing a field needs --allow-destructive; verify cannot tell whether the build also takes the field 'new_c' \(it is on the form more than once\) out of the Notes section first — /);
  assert.doesNotMatch(all, /the field 'new_c'.*which a build does not remove/, 'what verify cannot tell is not called a control that stays');
  // With nothing taken out first there is nothing for the build to "also" take.
  const noneFirst = timelineVerifyProblem(formTabs(hostWith(keeps, maybe)), isHost, { inspect });
  assert.match(noneFirst, /, then run a full build of the spec \(not --changed-only, which skips a spec that has not changed\); verify cannot tell whether the build takes the field 'new_c' \(it is on the form more than once\) out of the Notes section first — /);
  assert.doesNotMatch(noneFirst, /also takes|the build first takes/);
  // Nothing certain in the way: the build is to be run, and what it may leave is said after what it will take.
  const some = timelineVerifyProblem(formTabs(hostWith(leaves, maybe)), isHost, { inspect });
  assert.match(some, /— run a full build of the spec \(not --changed-only, which skips a spec that has not changed\); the build first takes the field 'new_a' \(your layout does not list it, so it is removed\) out of the Notes section, and removing a field needs --allow-destructive; the build repairs the timeline in place unless it leaves the field 'new_c' \(it is on the form more than once\) in the Notes section, and verify cannot tell whether it does — /);
  assert.doesNotMatch(some, /move it out of it, or delete the section|to repair it in place/);
});

test('timeline verify: the inspector is asked about nothing a form that renders or a host holding only its timeline has, and the id is the reason whatever it says goes', () => {
  let asked = 0;
  const inspect = () => { asked += 1; return {}; };
  assert.strictEqual(timelineVerifyProblem(formTabs(platformHost()), isHost, { inspect }), '');
  assert.match(timelineVerifyProblem(formTabs(oldHost()), isHost, { inspect }), /to repair it in place$/);
  assert.strictEqual(asked, 0);
  const stray = { control: { fieldName: 'new_x' } };
  const taken = timelineVerifyProblem(formTabs(hostWith(stray), makerControl('notescontrol')), isHost, { inspect: () => ({ name: "the field 'new_x'", goes: 'moved' }) });
  assert.match(taken, /another control on the form already uses the id 'notescontrol', so a build cannot give this timeline that id; remove or rename one of the two in the maker, then run a full build/);
  assert.doesNotMatch(taken, /repair it in place|the build first takes/);
});

// --- verify's model of what a build does with a host's other cells -----------------------------------------------------
//
// `notesHostInspector(spec, form, publishedTabs)` answers, for each other cell of the Notes host: what to call it, whether the
// build takes it out before it judges the section and why, and whether that removes a field. Each case pins one rule;
// form-timeline-real-bundle.test.js proves the answers agree with what a real build does.
const ticketSpec = (form) => ({
  entities: [{ schemaName: 'new_ticket', primaryAttribute: { schemaName: 'new_name' }, columns: [{ schemaName: 'new_code' }, { schemaName: 'new_area' }, { schemaName: 'new_extra' }] }],
  forms: [Object.assign({ entity: 'new_ticket', name: 'Main', notes: true }, form)],
});
// An explicit layout: new_name and new_code in sec_main, new_area in sec_more — and new_extra in neither.
const explicitForm = (over = {}) => Object.assign({ tabs: [{ name: 'tab_a', sections: [{ name: 'sec_main', fields: ['new_name', 'new_code'] }, { name: 'sec_more', fields: ['new_area'] }] }] }, over);
const fieldCell = (fieldName) => ({ control: { fieldName } });
const fieldSection = (name, ...fields) => ({ name, rows: fields.map((f) => ({ cells: [fieldCell(f)] })) });
// What the inspector says about `cell` once the form is published as `sections` (the Notes host among them).
const inspected = (form, sections, cell) => {
  const spec = ticketSpec(form);
  return notesHostInspector(spec, spec.forms[0], formTabs(...sections))(cell);
};
const WEB_RESOURCE = '{9fdf5f91-88b1-47f4-ad53-c11efbb3e0d8}';
const QUICK_VIEW = '{5C5600E0-1D6E-4205-A272-BE80DA87FD42}';
const SUBGRID = '{E7A81278-8635-4D9E-8D4D-59480B391C5B}';

test('notes host inspector: a field an explicit layout declares in another section is moved there — an auto layout moves nothing', () => {
  const stray = fieldCell('new_area'); // sec_more's field, sitting in the Notes host
  const sections = [fieldSection('sec_main', 'new_name', 'new_code'), hostWith(stray)];
  assert.deepStrictEqual(inspected(explicitForm(), sections, stray), { name: "the field 'new_area'", goes: "your layout places it in section 'sec_more', so it is moved there" });
  assert.deepStrictEqual(inspected({}, sections, stray), { name: "the field 'new_area'" }, 'an auto layout declares no section for a field');
});

test('notes host inspector: a field the layout does not list is removed — unless prune is off, the layout is auto, or it is the primary field', () => {
  const stray = fieldCell('new_extra');
  const sections = [fieldSection('sec_main', 'new_name', 'new_code'), fieldSection('sec_more', 'new_area'), hostWith(stray)];
  assert.deepStrictEqual(inspected(explicitForm(), sections, stray), { name: "the field 'new_extra'", goes: 'your layout does not list it, so it is removed', destructive: true });
  assert.deepStrictEqual(inspected(explicitForm({ prune: false }), sections, stray), { name: "the field 'new_extra'" });
  assert.deepStrictEqual(inspected({}, sections, stray), { name: "the field 'new_extra'" });
  // The primary field is never pruned: the build keeps it wherever it is, even when the layout does not list it.
  const primary = fieldCell('new_name');
  const withoutPrimary = explicitForm({ tabs: [{ name: 'tab_a', sections: [{ name: 'sec_main', fields: ['new_code'] }] }] });
  assert.deepStrictEqual(inspected(withoutPrimary, [fieldSection('sec_main', 'new_code'), hostWith(primary)], primary), { name: "the field 'new_name'" });
  // A published form may spell a logical name in any case; the build and the prune compare them lower-cased.
  const shouting = fieldCell('NEW_EXTRA');
  assert.deepStrictEqual(inspected(explicitForm(), [fieldSection('sec_main', 'new_name'), hostWith(shouting)], shouting), { name: "the field 'new_extra'", goes: 'your layout does not list it, so it is removed', destructive: true });
});

test('notes host inspector: a field a fieldOptions anchor places beside its anchor is moved there — on any layout, and whatever prune says', () => {
  const stray = fieldCell('new_extra');
  const sections = [fieldSection('sec_main', 'new_name', 'new_code'), fieldSection('sec_more', 'new_area'), hostWith(stray)];
  const anchored = (over) => ({ fieldOptions: { new_extra: { after: 'new_area' } }, ...over });
  const placed = { name: "the field 'new_extra'", goes: "fieldOptions places it after 'new_area', so it is moved there" };
  assert.deepStrictEqual(inspected(explicitForm(anchored({ prune: false })), sections, stray), placed);
  assert.deepStrictEqual(inspected(anchored(), sections, stray), placed, 'an auto layout too');
  // Anchored AND pruned: the build moves it and then removes it, and the removal is what the maker is told.
  const both = inspected(explicitForm(anchored()), sections, stray);
  assert.strictEqual(both.destructive, true);
  assert.match(both.goes, /does not list it, so it is removed/);
});

test('notes host inspector: an anchor the build cannot place a field beside leaves the field where it is', () => {
  const stray = fieldCell('new_extra');
  const kept = { name: "the field 'new_extra'" };
  const placed = (anchor) => ({ name: "the field 'new_extra'", goes: `fieldOptions places it after '${anchor}', so it is moved there` });
  const form = (anchor, over = {}) => explicitForm({ prune: false, fieldOptions: { new_extra: { after: anchor } }, ...over });
  // An anchor that is not on the form, and that the layout does not place: nothing to place the field beside.
  assert.deepStrictEqual(inspected(form('new_unlisted'), [fieldSection('sec_main', 'new_name', 'new_code'), hostWith(stray)], stray), kept);
  // An anchor in a section the build owns — the Notes host itself, or a sub-grid's — where no field is ever placed.
  const other = fieldCell('new_other');
  assert.deepStrictEqual(inspected(form('new_other'), [fieldSection('sec_main', 'new_name'), hostWith(stray, other)], stray), kept, 'the anchor is in the Notes host too');
  const gridHolding = (field) => ({ name: 'section_grid_new_child', rows: [{ cells: [{ control: { classId: SUBGRID } }] }, { cells: [fieldCell(field)] }] });
  assert.deepStrictEqual(inspected(form('new_other'), [fieldSection('sec_main', 'new_name'), gridHolding('new_other'), hostWith(stray)], stray), kept, 'the anchor is in a sub-grid\u2019s section');
  // …unless the layout declares the anchor in a section of its own: the build moves it there before it positions anything.
  assert.deepStrictEqual(inspected(form('new_code'), [fieldSection('sec_main', 'new_name'), gridHolding('new_code'), hostWith(stray)], stray), placed('new_code'));
  // An anchor the form does not have yet, but the layout places: the build adds it before it positions anything.
  assert.deepStrictEqual(inspected(form('new_code'), [fieldSection('sec_main', 'new_name'), hostWith(stray)], stray), placed('new_code'));
  assert.deepStrictEqual(inspected({ fieldOptions: { new_extra: { after: 'new_code' } } }, [fieldSection('section_general', 'new_name'), hostWith(stray)], stray), placed('new_code'), 'an auto layout places the table\u2019s columns');
  assert.deepStrictEqual(inspected({ fieldOptions: { new_extra: { after: 'new_unlisted' } } }, [fieldSection('section_general', 'new_name'), hostWith(stray)], stray), kept, 'but not a column it does not have');
  // An anchor in the host that the layout declares elsewhere is moved out first, and the field follows it.
  const moved = fieldCell('new_other');
  const layout = form('new_other', { tabs: [{ name: 'tab_a', sections: [{ name: 'sec_main', fields: ['new_name', 'new_code'] }, { name: 'sec_more', fields: ['new_area', 'new_other'] }] }] });
  assert.deepStrictEqual(inspected(layout, [fieldSection('sec_main', 'new_name', 'new_code'), hostWith(stray, moved)], stray), placed('new_other'));
  assert.deepStrictEqual(inspected(layout, [fieldSection('sec_main', 'new_name', 'new_code'), hostWith(stray, moved)], moved), { name: "the field 'new_other'", goes: "your layout places it in section 'sec_more', so it is moved there" });
});

test('notes host inspector: a field anchored to an anchor that is itself moved out of the host follows it — the build places anchored fields in dependency order', () => {
  const other = fieldCell('new_other');
  const extra = fieldCell('new_extra');
  const sections = [fieldSection('section_general', 'new_name', 'new_code', 'new_area'), hostWith(other, extra)];
  const after = (anchor) => ({ goes: `fieldOptions places it after '${anchor}', so it is moved there` });
  // new_other goes after new_area first (new_area is not anchored itself), and new_extra after new_other once it is there.
  const chain = { new_other: { after: 'new_area' }, new_extra: { after: 'new_other' } };
  assert.deepStrictEqual(inspected({ fieldOptions: chain }, sections, other), { name: "the field 'new_other'", ...after('new_area') });
  assert.deepStrictEqual(inspected({ fieldOptions: chain }, sections, extra), { name: "the field 'new_extra'", ...after('new_other') });
  // The order the spec lists them in decides nothing: the build sorts them by what they depend on.
  const reversed = { new_extra: { after: 'new_other' }, new_other: { after: 'new_area' } };
  assert.deepStrictEqual(inspected({ fieldOptions: reversed }, sections, extra), { name: "the field 'new_extra'", ...after('new_other') });
  // On an explicit layout with prune off, where the layout names neither field.
  assert.deepStrictEqual(inspected(explicitForm({ prune: false, fieldOptions: chain }), [fieldSection('sec_more', 'new_area'), hostWith(other, extra)], extra), { name: "the field 'new_extra'", ...after('new_other') });
  // A longer chain: every link in the host is followed out.
  const third = fieldCell('new_third');
  const long = { new_third: { after: 'new_extra' }, new_extra: { after: 'new_other' }, new_other: { after: 'new_area' } };
  assert.deepStrictEqual(inspected({ fieldOptions: long }, [fieldSection('section_general', 'new_name', 'new_area'), hostWith(other, extra, third)], third), { name: "the field 'new_third'", ...after('new_extra') });
  // A chain that never leaves the host moves nothing: the head has no anchor of its own, or its anchor is not on the form.
  const stuck = { new_extra: { after: 'new_other' } };
  assert.deepStrictEqual(inspected({ fieldOptions: stuck }, sections, extra), { name: "the field 'new_extra'" });
  const lost = { new_extra: { after: 'new_other' }, new_other: { after: 'new_unlisted' } };
  assert.deepStrictEqual(inspected({ fieldOptions: lost }, sections, extra), { name: "the field 'new_extra'" });
  // A cycle is never placed (the build refuses it), and the walk ends rather than going round for ever.
  const cycle = { new_extra: { after: 'new_other' }, new_other: { after: 'new_extra' } };
  assert.deepStrictEqual(inspected({ fieldOptions: cycle }, sections, extra), { name: "the field 'new_extra'" });
  assert.deepStrictEqual(inspected({ fieldOptions: cycle }, sections, other), { name: "the field 'new_other'" });
});

test('notes host inspector: one inspector answers for every cell of a chain of three anchors — what it works out for one cell does not use up what the next needs', () => {
  // `--verify` asks the SAME inspector about each cell of the host in turn, and the walks overlap: the one for the head of the chain
  // passes through the links the later questions start from, so a walk must not leave anything behind for the next.
  const [other, extra, third] = ['new_other', 'new_extra', 'new_third'].map(fieldCell);
  const long = { new_third: { after: 'new_extra' }, new_extra: { after: 'new_other' }, new_other: { after: 'new_area' } };
  const spec = ticketSpec({ fieldOptions: long });
  const inspect = notesHostInspector(spec, spec.forms[0], formTabs(fieldSection('section_general', 'new_name', 'new_area'), hostWith(other, extra, third)));
  const after = (anchor) => ({ goes: `fieldOptions places it after '${anchor}', so it is moved there` });
  const expected = new Map([
    [other, { name: "the field 'new_other'", ...after('new_area') }],
    [extra, { name: "the field 'new_extra'", ...after('new_other') }],
    [third, { name: "the field 'new_third'", ...after('new_extra') }],
  ]);
  // The head of the chain first, then the rest, and again the other way round.
  for (const cell of [third, extra, other, other, extra, third]) assert.deepStrictEqual(inspect(cell), expected.get(cell));
});

test('notes host inspector: a field the form has more than once is not predicted when a pass would act on it — which cell a build acts on is not the published order', () => {
  // A build acts on ONE cell of a field per pass, the first it finds once it has reordered the sections — so with a cell in
  // sec_main and one in the Notes host, whether the host's goes depends on an order that is not the published one.
  const inHost = fieldCell('new_code');
  const unsure = { name: "the field 'new_code'", unsure: 'it is on the form more than once' };
  assert.deepStrictEqual(inspected(explicitForm(), [fieldSection('sec_main', 'new_name', 'new_code'), hostWith(inHost)], inHost), unsure);
  assert.deepStrictEqual(inspected(explicitForm(), [hostWith(inHost), fieldSection('sec_main', 'new_name', 'new_code')], inHost), unsure, 'in either published order');
  // Whatever the pass is: a removal (and it says so, since that takes --allow-destructive), an anchor — on an auto layout too.
  const extra = fieldCell('new_extra');
  const withExtra = [fieldSection('sec_main', 'new_name', 'new_code', 'new_extra'), fieldSection('sec_more', 'new_area'), hostWith(extra)];
  assert.deepStrictEqual(inspected(explicitForm(), withExtra, extra), { name: "the field 'new_extra'", unsure: 'it is on the form more than once', destructive: true });
  const anchored = { fieldOptions: { new_extra: { after: 'new_area' } } };
  assert.deepStrictEqual(inspected(explicitForm({ prune: false, ...anchored }), withExtra, extra), { name: "the field 'new_extra'", unsure: 'it is on the form more than once' });
  assert.deepStrictEqual(inspected(anchored, withExtra, extra), { name: "the field 'new_extra'", unsure: 'it is on the form more than once' });
  // A field no pass touches stays whichever of its cells is acted on, so that is still said plainly — the host's cell is named
  // as the second cell of a field the host holds twice, and never as a field that both goes and stays.
  const inHostTwice = [fieldCell('new_extra'), fieldCell('new_extra'), fieldCell('new_extra')];
  const twice = [fieldSection('sec_main', 'new_name', 'new_code', 'new_extra'), hostWith(...inHostTwice)];
  const names = inHostTwice.map((cell) => inspected(explicitForm({ prune: false }), twice, cell).name);
  assert.deepStrictEqual(names, ["the field 'new_extra'", "a second cell of the field 'new_extra'", "another cell of the field 'new_extra'"]);
  assert.deepStrictEqual(inspected({}, twice, inHostTwice[1]), { name: "a second cell of the field 'new_extra'" }, 'an auto layout touches nothing either');
  // …while a field the layout does place, held twice by the host, is said once and not named as both leaving and staying.
  const placed = [fieldCell('new_code'), fieldCell('new_code')];
  const heldTwice = [fieldSection('sec_main', 'new_name'), hostWith(...placed)];
  for (const cell of placed) assert.deepStrictEqual(inspected(explicitForm(), heldTwice, cell), unsure);
});

test('notes host inspector: an anchor the form has more than once is only relied on where every cell of it is in a section the build does not own', () => {
  const stray = fieldCell('new_extra');
  const anchoredAfter = (anchor, over = {}) => explicitForm({ prune: false, fieldOptions: { new_extra: { after: anchor } }, ...over });
  const placed = { name: "the field 'new_extra'", goes: "fieldOptions places it after 'new_code', so it is moved there" };
  // Two cells, both in ordinary sections: whichever the build finds first, the field is placed beside it.
  assert.deepStrictEqual(inspected(anchoredAfter('new_code'), [fieldSection('sec_main', 'new_name', 'new_code'), fieldSection('sec_more', 'new_code'), hostWith(stray)], stray), placed);
  // One of them in the Notes host: which one the build finds first is not the published order.
  const unsure = { name: "the field 'new_extra'", unsure: "its anchor 'new_code' is on the form more than once" };
  assert.deepStrictEqual(inspected(anchoredAfter('new_code'), [fieldSection('sec_main', 'new_name', 'new_code'), hostWith(stray, fieldCell('new_code'))], stray), unsure);
  assert.deepStrictEqual(inspected(anchoredAfter('new_code'), [hostWith(stray, fieldCell('new_code')), fieldSection('sec_main', 'new_name', 'new_code')], stray), unsure, 'in either published order');
  // A single cell of the anchor in the host is another matter: the build knows which it is, and takes it out first (as above).
  assert.deepStrictEqual(inspected(anchoredAfter('new_code'), [fieldSection('sec_main', 'new_name'), hostWith(stray, fieldCell('new_code'))], stray), placed, 'the layout declares new_code in sec_main');
  // A field whose anchor has ONE cell but is itself anchored to a field the form has twice is not predicted either — and the reason
  // names the field the form has twice, never an anchor that has one cell.
  const other = fieldCell('new_other');
  const third = fieldCell('new_third');
  const twice = [fieldSection('section_general', 'new_name', 'new_code'), hostWith(third, stray, other, fieldCell('new_code'))];
  const links = (anchors) => ({ fieldOptions: anchors });
  const two = links({ new_other: { after: 'new_code' }, new_extra: { after: 'new_other' } });
  assert.deepStrictEqual(inspected(two, twice, other), { name: "the field 'new_other'", unsure: "its anchor 'new_code' is on the form more than once" });
  assert.deepStrictEqual(inspected(two, twice, stray), { name: "the field 'new_extra'", unsure: "its anchor 'new_other' follows 'new_code', which is on the form more than once" });
  // However many links lie between the field and the one the form has twice, each is traced.
  const three = links({ new_other: { after: 'new_code' }, new_extra: { after: 'new_other' }, new_third: { after: 'new_extra' } });
  assert.deepStrictEqual(inspected(three, twice, third), { name: "the field 'new_third'", unsure: "its anchor 'new_extra' follows 'new_other', which follows 'new_code', which is on the form more than once" });
  // When it is the middle link that the form has twice, that link IS the anchor, and is said to be on the form more than once.
  const middle = [fieldSection('section_general', 'new_name', 'new_other'), hostWith(stray, fieldCell('new_other'))];
  assert.deepStrictEqual(inspected(two, middle, stray), { name: "the field 'new_extra'", unsure: "its anchor 'new_other' is on the form more than once" });
});

test('notes host inspector: a control that is not a bound field is never taken out — a quick view carries a field name and is still not one', () => {
  const web = { control: { classId: WEB_RESOURCE } };
  const quickView = { control: { fieldName: 'new_extra', classId: QUICK_VIEW } }; // binds a lookup's name, not that field
  const grid = { control: { classId: SUBGRID } };
  const spacer = {};
  const sections = [fieldSection('sec_main', 'new_name', 'new_code'), hostWith(web, quickView, grid, spacer)];
  for (const cell of [web, quickView, grid, spacer, undefined]) assert.deepStrictEqual(inspected(explicitForm(), sections, cell), {});
});

test('notes host inspector: a quick view is not a cell of the lookup it names — it does not make the host\u2019s own cell of that field a second one', () => {
  // The layout declares the lookup in sec_more; sec_main holds a quick view that names it; the host holds the field itself.
  const layout = explicitForm({ tabs: [{ name: 'tab_a', sections: [{ name: 'sec_main', fields: ['new_name'] }, { name: 'sec_more', fields: ['new_parentid'] }] }] });
  const field = fieldCell('new_parentid');
  const quickView = { control: { fieldName: 'new_parentid', classId: QUICK_VIEW } };
  const sections = [{ name: 'sec_main', rows: [{ cells: [fieldCell('new_name')] }, { cells: [quickView] }] }, hostWith(field)];
  assert.deepStrictEqual(inspected(layout, sections, field), { name: "the field 'new_parentid'", goes: "your layout places it in section 'sec_more', so it is moved there" });
  // …and the same as an anchor: a quick view in an ordinary section is not where the build finds the anchor.
  const anchored = explicitForm({ prune: false, fieldOptions: { new_extra: { after: 'new_parentid' } } });
  const stray = fieldCell('new_extra');
  assert.deepStrictEqual(inspected(anchored, [{ name: 'sec_main', rows: [{ cells: [quickView] }] }, hostWith(stray)], stray), { name: "the field 'new_extra'" });
});

test('notes host inspector: a layout the compiler cannot read predicts nothing, so every cell is in the way, as for a form nothing is known about', () => {
  const stray = fieldCell('new_extra');
  const broken = explicitForm({ tabs: [{ name: 'tab_a', sections: [{ name: 'sec_main', fields: 'new_name' }] }] }); // `fields` is not a list
  const spec = ticketSpec(broken);
  const tabs = formTabs(hostWith(stray));
  const inspect = notesHostInspector(spec, spec.forms[0], tabs);
  assert.strictEqual(inspect, undefined);
  assert.match(timelineVerifyProblem(tabs, isHost, { inspect }), /the Notes section also holds other controls, so a build leaves it as it is; move them out of it/);
});
