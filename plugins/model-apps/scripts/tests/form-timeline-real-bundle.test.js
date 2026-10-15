'use strict';
// REAL BUNDLE: the Notes timeline in the shape Dynamics renders (GitHub #680) — what the vendored SDK
// serializes for a new host, how a rebuild repairs a host an older build wrote, and what `--verify` says.
// The mock-SDK suites prove the engine's decisions; these prove the SDK really writes and re-reads the shape.
const test = require('node:test');
const assert = require('node:assert');
const ai = require('../lib/artifact-intent.js');
const { runSdkBuild } = require('../lib/sdk-build.js');
const { renderFormWireframe } = require('../lib/form-preview.js');
const { createHarness, seedForm, verifyForms, sectionXml, collapseEmptyRows, clone, NOTES_CLASS_ID, DEFAULT_ATTRIBUTES } = require('./helpers/form-store-harness.js');

const PLATFORM_CONTROL = '<control id="notescontrol" classid="{06375649-C143-495E-A496-C962E5B4488E}" disabled="false" isrequired="false" />';

function specFor({ layout = 'explicit', notes = true } = {}) {
  return {
    $schemaVersion: '1.0',
    solution: { uniqueName: 'Timeline', displayName: 'Timeline', publisherPrefix: 'new' },
    app: { name: 'Timeline', uniqueName: 'new_timeline' },
    entities: [{ schemaName: 'new_ticket', displayName: 'Ticket', pluralName: 'Tickets', existing: true,
      primaryAttribute: { schemaName: 'new_name', displayName: 'Name' },
      columns: [
        { schemaName: 'new_code', displayName: 'Code', type: 'Text' },
        { schemaName: 'new_notes', displayName: 'Notes', type: 'Memo' },
        { schemaName: 'new_area', displayName: 'Area', type: 'Text' },
      ] }],
    forms: [layout === 'explicit'
      ? { entity: 'new_ticket', name: 'Main', notes, tabs: [{ name: 'tab_a', label: 'A', sections: [
        { name: 'sec_main', label: 'Main', columns: 2, fields: ['new_name', 'new_code'] },
        { name: 'sec_more', label: 'More', columns: 1, fields: ['new_notes', 'new_area'] },
      ] }] }
      : { entity: 'new_ticket', name: 'Main', notes }],
  };
}

// What every build before this change wrote for the Notes section: the timeline as an ordinary unbound control
// (the SDK mints its id) in a one-row cell, with nothing under it.
const oldNotesSection = () => ({
  name: 'section_notes', label: 'Notes', visible: true, showLabel: true, columns: 1,
  rows: [{ cells: [{ control: { classId: NOTES_CLASS_ID, fieldName: null, label: 'Notes', showLabel: false, parameters: {} } }] }],
});

// The compiled form with its Notes section swapped for `host` — a form an older build, or a maker, left behind.
function compiledTabs(spec, host) {
  const tabs = ai.compileFormIntent(spec, spec.forms[0], { notesClassId: NOTES_CLASS_ID }).tabs;
  const sections = tabs[0].columns[0].sections;
  const at = sections.findIndex((s) => s.name === 'section_notes');
  if (host === null) sections.splice(at, 1);
  else if (host) sections[at] = host;
  return tabs;
}

const sectionsOf = (form) => form.tabs.flatMap((t) => t.columns.flatMap((c) => c.sections));
const sectionOf = (form, name) => sectionsOf(form).find((s) => s.name === name);
const cellsOf = (section) => section.rows.flatMap((r) => r.cells);
const controlIds = (xml) => [...String(xml).matchAll(/<control\b[^>]*\bid="([^"]*)"/g)].map((m) => m[1]);
const attrsOf = (tag) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
const layoutMutations = (mutations) => mutations.filter((m) => ['addElement', 'updateElement', 'moveElement', 'removeElement'].includes(m.method));

const harnesses = [];
const newHarness = (options) => { const h = createHarness(options); harnesses.push(h); return h; };
test.after(() => { for (const h of harnesses) h.cleanup(); });

// --- (a) a new host ---------------------------------------------------------------------------------------

test('timeline: a NEW Notes host is serialized as notescontrol in a 23-row cell with auto=false, followed by 22 empty rows', async () => {
  const h = newHarness();
  const spec = specFor();
  await seedForm(h, compiledTabs(spec));
  const xml = h.store.row.formxml;
  const host = sectionXml(xml, 'section_notes');

  // The control: the platform's fixed id and class id, nothing else generated about it.
  assert.ok(host.includes(PLATFORM_CONTROL), `the timeline control is exactly ${PLATFORM_CONTROL}; got ${host.slice(0, 700)}`);
  // The cell: tall, `auto="false"`, labelled "Notes" with its label hidden — the attributes of the platform's own cell.
  const cellTag = /<cell\b[^>]*>/.exec(host)[0];
  const { id, ...cellAttrs } = attrsOf(cellTag);
  assert.deepStrictEqual(cellAttrs, { showlabel: 'false', colspan: '1', rowspan: '23', auto: 'false' });
  assert.match(id, /^[0-9a-f-]{36}$/, 'the cell keeps a generated identity');
  assert.match(host, /<labels><label description="Notes" languagecode="1033" \/><\/labels><control /, 'the cell carries the "Notes" label');
  // The section: still ours — `section_notes`, labelled "Notes" — holding the host row then the 22 rows it spans.
  assert.match(host, /^<section id="[0-9a-f-]{36}" name="section_notes" showlabel="true" visible="true" columns="1"><labels><label description="Notes" languagecode="1033" \/><\/labels><rows>/);
  assert.match(collapseEmptyRows(host), /<\/cell><\/row><row \/>×22<\/rows><\/section>$/, 'exactly 22 empty rows follow the host row, and nothing else');
  assert.strictEqual((host.match(/<row\b/g) || []).length, 23);
  // …and no duplicate control id anywhere on the form.
  const ids = controlIds(xml);
  assert.strictEqual(ids.filter((x) => x === 'notescontrol').length, 1, 'exactly one notescontrol');
  assert.strictEqual(new Set(ids).size, ids.length, `control ids are unique: ${ids.join(', ')}`);
  // The field sections around it are as before: the host is the LAST section of the first tab's column.
  assert.ok(xml.indexOf('name="sec_more"') < xml.indexOf('name="section_notes"'));
});

test('timeline: the engine\u2019s own create path writes the same host (runSdkBuild over a table with no form yet)', async () => {
  for (const layout of ['explicit', 'auto']) {
    const h = newHarness();
    delete h.store.row.formxml; // no form on the table: the build has to create it
    const spec = specFor({ layout });
    const { sdk } = await h.freshSdk();
    const built = await runSdkBuild(spec, { sdk, apply: true, phases: ['forms'] });
    assert.strictEqual(built.ok, true, `${layout}: ${JSON.stringify(built.error || built.halt || '')}`);
    assert.ok(h.store.row.formxml, `${layout}: the build created the form`);
    const host = collapseEmptyRows(sectionXml(h.store.row.formxml, 'section_notes'));
    assert.ok(host.includes(PLATFORM_CONTROL), `${layout}: ${host.slice(0, 600)}`);
    assert.match(host, /rowspan="23"[^>]*auto="false"|auto="false"[^>]*rowspan="23"/);
    assert.match(host, /<row \/>×22<\/rows><\/section>$/);
    const verified = await verifyForms(h, spec);
    assert.strictEqual(verified.checks.find((c) => c.kind === 'form-timeline').present, true, `${layout}: ${JSON.stringify(verified.missing)}`);
  }
});

test('timeline: hasNotes on the table asks for it too, and a form that does not ask has no Notes section', async () => {
  const withTable = specFor({ notes: false });
  withTable.entities[0].hasNotes = true;
  const asked = ai.compileFormIntent(withTable, withTable.forms[0], { notesClassId: NOTES_CLASS_ID });
  assert.strictEqual(asked.__notes, true);
  assert.ok(asked.tabs[0].columns[0].sections.some((s) => s.name === 'section_notes' && s.rows.length === 23));
  const plain = ai.compileFormIntent(specFor({ notes: false }), specFor({ notes: false }).forms[0], { notesClassId: NOTES_CLASS_ID });
  assert.strictEqual(plain.__notes, false);
  assert.ok(!plain.tabs[0].columns[0].sections.some((s) => s.name === 'section_notes'));
});

// --- (b) converge an existing form -------------------------------------------------------------------------

for (const layout of ['explicit', 'auto']) {
  test(`timeline: a rebuild repairs an OLD-shape host in place (${layout} layout), and a second rebuild changes nothing`, async () => {
    const h = newHarness();
    const spec = specFor({ layout });
    await seedForm(h, compiledTabs(spec, oldNotesSection()));
    const before = clone(await (await h.freshSdk()).sdk.fetchArtifact('form', h.formId));
    const hostBefore = sectionOf(before, 'section_notes');
    const timelineBefore = cellsOf(hostBefore)[0];
    // The premise: the host really is the old shape — a generated id, a one-row cell, no rows under it.
    assert.notStrictEqual(timelineBefore.control.id, 'notescontrol');
    assert.match(timelineBefore.control.id, /^[0-9a-f-]{36}$/);
    assert.strictEqual(timelineBefore.rowspan, 1);
    assert.strictEqual(hostBefore.rows.length, 1);
    assert.ok(!h.store.row.formxml.includes('notescontrol'));

    // --verify says so BEFORE the repair: the fix is not applied.
    const unrepaired = await verifyForms(h, spec);
    const failing = unrepaired.checks.find((c) => c.kind === 'form-timeline');
    assert.strictEqual(failing.present, false);
    assert.match(failing.detail, /does not render: the control id is '[0-9a-f-]{36}', not 'notescontrol' and its cell spans 1 row — run a full build of the spec \(not --changed-only, which skips a spec that has not changed\) to repair it in place/);
    assert.strictEqual(unrepaired.ok, false);

    const first = await h.freshSdk();
    const warnings = [];
    const built = await runSdkBuild(spec, { sdk: first.sdk, apply: true, phases: ['forms'], warn: (m) => warnings.push(String(m)) });
    assert.strictEqual(built.ok, true);
    assert.ok(warnings.some((w) => /repaired the Notes section's timeline in place .*'notescontrol'.*23-row cell and 22 empty row/.test(w)), `the repair is reported; got ${JSON.stringify(warnings)}`);
    const writes = layoutMutations(first.mutations);
    assert.strictEqual(writes.length, 1, `one atomic write; got ${JSON.stringify(writes.map((m) => [m.method, m.args[2]]))}`);
    assert.strictEqual(writes[0].method, 'updateElement');
    assert.match(writes[0].args[2], /\/sections\/\d+\/rows$/, 'the host\u2019s rows are replaced whole');

    const after = clone(await (await h.freshSdk()).sdk.fetchArtifact('form', h.formId));
    const hostAfter = sectionOf(after, 'section_notes');
    const timelineAfter = cellsOf(hostAfter)[0];
    // Same section, same position, same cell and control identity — only the shape changed.
    assert.strictEqual(hostAfter.id, hostBefore.id);
    assert.deepStrictEqual(sectionsOf(after).map((s) => s.name), sectionsOf(before).map((s) => s.name), 'every section keeps its place');
    assert.strictEqual(timelineAfter.id, timelineBefore.id, 'the cell is the same cell');
    assert.strictEqual(timelineAfter.control.id, 'notescontrol');
    assert.strictEqual(timelineAfter.rowspan, 23);
    assert.strictEqual(hostAfter.rows.length, 23);
    assert.ok(hostAfter.rows.slice(1).every((r) => r.cells.length === 0));
    assert.strictEqual(timelineAfter.control.classId, timelineBefore.control.classId);
    for (const section of sectionsOf(before)) {
      if (section.name === 'section_notes') continue;
      assert.deepStrictEqual(sectionOf(after, section.name), section, `${section.name} is untouched`);
    }
    // What the server holds.
    const xml = h.store.row.formxml;
    const host = sectionXml(xml, 'section_notes');
    assert.ok(host.includes(PLATFORM_CONTROL));
    // The repaired cell keeps the attributes it was written with (here its `visible="true"`) and gains the platform's.
    const repairedCell = attrsOf(/<cell\b[^>]*>/.exec(host)[0]);
    assert.deepStrictEqual({ showlabel: repairedCell.showlabel, colspan: repairedCell.colspan, rowspan: repairedCell.rowspan, auto: repairedCell.auto },
      { showlabel: 'false', colspan: '1', rowspan: '23', auto: 'false' });
    assert.match(collapseEmptyRows(host), /<\/cell><\/row><row \/>×22<\/rows><\/section>$/);
    assert.ok(host.includes(`id="${timelineBefore.id}"`), 'the cell id survives the serialize');
    const ids = controlIds(xml);
    assert.strictEqual(new Set(ids).size, ids.length, 'control ids stay unique');

    const repaired = await verifyForms(h, spec);
    assert.strictEqual(repaired.checks.find((c) => c.kind === 'form-timeline').present, true, JSON.stringify(repaired.missing));
    assert.strictEqual(repaired.ok, true, JSON.stringify(repaired.missing));

    // Idempotent: nothing left to repair, so nothing is written and the form is the same bytes.
    const second = await h.freshSdk();
    const xmlBefore = h.store.row.formxml;
    const again = await runSdkBuild(spec, { sdk: second.sdk, apply: true, phases: ['forms'] });
    assert.strictEqual(again.ok, true);
    assert.deepStrictEqual(second.mutations, [], 'a rebuild of an already-correct form mutates nothing');
    assert.strictEqual(h.store.row.formxml, xmlBefore);
  });
}

test('timeline: a host the maker already sized keeps its span; only what it lacks is written', async () => {
  const h = newHarness();
  const spec = specFor();
  const sized = oldNotesSection();
  sized.rows[0].cells[0].rowspan = 8;
  for (let i = 0; i < 7; i += 1) sized.rows.push({ cells: [] });
  await seedForm(h, compiledTabs(spec, sized));
  const { sdk } = await h.freshSdk();
  await runSdkBuild(spec, { sdk, apply: true, phases: ['forms'] });
  const after = clone(await (await h.freshSdk()).sdk.fetchArtifact('form', h.formId));
  const host = sectionOf(after, 'section_notes');
  assert.strictEqual(cellsOf(host)[0].control.id, 'notescontrol', 'the id is repaired');
  assert.strictEqual(cellsOf(host)[0].rowspan, 8, 'the span the maker chose is respected');
  assert.strictEqual(host.rows.length, 8, 'and no rows are added beyond what it spans');
});

// --- any height: the platform's forms differ, and a maker can resize the timeline -----------------------------

// The Notes host as the platform or a maker leaves it: a timeline cell `rowspan` rows tall under `notescontrol`
// with `below` rows after its own, an `auto` attribute only when given, `colspan` wide in a section of `columns`.
function tallNotesSection({ rowspan, below = rowspan - 1, auto, colspan = 1, columns = 1 }) {
  const host = ai.notesSectionIntent(NOTES_CLASS_ID);
  host.columns = columns;
  const cell = host.rows[0].cells[0];
  cell.rowspan = rowspan;
  cell.colspan = colspan;
  cell.bag = { a: [['showlabel', 'false'], ['colspan', String(colspan)], ['rowspan', String(rowspan)], ...(auto === undefined ? [] : [['auto', auto]])], c: [] };
  host.rows = [host.rows[0], ...Array.from({ length: below }, () => ({ cells: [] }))];
  return host;
}
const cellTagOf = (xml) => /<cell\b[^>]*>/.exec(sectionXml(xml, 'section_notes'))[0];

// What the platform's own forms carry: Account's timeline is 20 rows tall with no `auto`, Contact's 5 rows tall and
// two columns wide with `auto="false"`, the reported form's 23 — each followed by exactly the rows it spans.
const PLATFORM_HEIGHTS = [
  { label: '20 rows, no auto (as on Account)', host: { rowspan: 20 } },
  { label: '5 rows, 2 columns wide, auto=false (as on Contact)', host: { rowspan: 5, auto: 'false', colspan: 2, columns: 2 } },
  { label: '23 rows, auto=false (as written for a new host)', host: { rowspan: 23, auto: 'false' } },
  { label: '2 rows', host: { rowspan: 2 } },
];

for (const layout of ['explicit', 'auto']) {
  for (const { label, host } of PLATFORM_HEIGHTS) {
    test(`timeline: a host of ${label} is already in shape (${layout} layout) — verify passes and a rebuild writes nothing`, async () => {
      const h = newHarness();
      const spec = specFor({ layout });
      await seedForm(h, compiledTabs(spec, tallNotesSection(host)));
      const xml = h.store.row.formxml;
      const before = clone(await (await h.freshSdk()).sdk.fetchArtifact('form', h.formId));
      assert.strictEqual(sectionOf(before, 'section_notes').rows.length, host.rowspan, 'the premise: exactly the rows the cell spans');

      const verified = (await verifyForms(h, spec)).checks.find((c) => c.kind === 'form-timeline');
      assert.strictEqual(verified.present, true, verified.detail);

      const run = await h.freshSdk();
      assert.strictEqual((await runSdkBuild(spec, { sdk: run.sdk, apply: true, phases: ['forms'] })).ok, true);
      assert.deepStrictEqual(layoutMutations(run.mutations), [], 'nothing about the host is rewritten — not its height, its width or its auto');
      assert.strictEqual(h.store.row.formxml, xml);
      assert.deepStrictEqual(clone(await (await h.freshSdk()).sdk.fetchArtifact('form', h.formId)), before);
    });
  }
}

test('timeline: a host that only lacks rows is given them to ITS height, and the build writes no auto for it', async () => {
  for (const layout of ['explicit', 'auto']) {
    const h = newHarness();
    const spec = specFor({ layout });
    await seedForm(h, compiledTabs(spec, tallNotesSection({ rowspan: 8, below: 3 })));
    assert.ok(!cellTagOf(h.store.row.formxml).includes('auto='), 'the premise: a cell with no auto attribute');

    const unbacked = (await verifyForms(h, spec)).checks.find((c) => c.kind === 'form-timeline');
    assert.strictEqual(unbacked.present, false, `${layout}: the engine's own host with a span its rows do not back is a fix not applied`);
    assert.match(unbacked.detail, /the deployed form's timeline does not render: its cell spans 8 rows but only 3 row\(s\) follow it — run a full build of the spec \(not --changed-only, which skips a spec that has not changed\) to repair it in place/);

    const run = await h.freshSdk();
    const warnings = [];
    assert.strictEqual((await runSdkBuild(spec, { sdk: run.sdk, apply: true, phases: ['forms'], warn: (m) => warnings.push(String(m)) })).ok, true);
    const writes = layoutMutations(run.mutations);
    assert.deepStrictEqual(writes.map((m) => [m.method, /\/sections\/\d+\/rows$/.test(m.args[2])]), [['updateElement', true]], `${layout}: one write of the host's rows`);
    assert.ok(warnings.some((w) => /a 8-row cell and 7 empty row\(s\) under it/.test(w)), JSON.stringify(warnings));
    const host = sectionOf(clone(await (await h.freshSdk()).sdk.fetchArtifact('form', h.formId)), 'section_notes');
    assert.deepStrictEqual([cellsOf(host)[0].rowspan, host.rows.length], [8, 8], 'its own height, backed');
    assert.ok(!cellTagOf(h.store.row.formxml).includes('auto='), `${layout}: no auto was added to a cell that only needed rows`);
    assert.strictEqual((await verifyForms(h, spec)).checks.find((c) => c.kind === 'form-timeline').present, true);
    const again = await h.freshSdk();
    assert.strictEqual((await runSdkBuild(spec, { sdk: again.sdk, apply: true, phases: ['forms'] })).ok, true);
    assert.deepStrictEqual(again.mutations, []);
  }
});

test('timeline: a maker\u2019s own timeline is judged by its id and span — rows the build cannot add to it are not a failure — and is left as it is', async () => {
  const h = newHarness();
  const spec = specFor();
  const tabs = compiledTabs(spec, null);
  const own = tallNotesSection({ rowspan: 8, below: 0 });
  own.name = 'maker_timeline';
  tabs[0].columns[0].sections.push(own);
  await seedForm(h, tabs);
  const before = h.store.row.formxml;
  assert.strictEqual((await verifyForms(h, spec)).checks.find((c) => c.kind === 'form-timeline').present, true);
  const run = await h.freshSdk();
  assert.strictEqual((await runSdkBuild(spec, { sdk: run.sdk, apply: true, phases: ['forms'] })).ok, true);
  assert.deepStrictEqual(layoutMutations(run.mutations), []);
  assert.strictEqual(h.store.row.formxml, before);
});

test('timeline: a host a maker widened WITH its timeline keeps its width, and one whose timeline still fits one column is narrowed as before', async () => {
  const h = newHarness();
  const spec = specFor();
  const wideTimeline = tallNotesSection({ rowspan: 5, auto: 'false', colspan: 2, columns: 2 });
  await seedForm(h, compiledTabs(spec, wideTimeline));
  const run = await h.freshSdk();
  assert.strictEqual((await runSdkBuild(spec, { sdk: run.sdk, apply: true, phases: ['forms'] })).ok, true);
  const host = sectionOf(clone(await (await h.freshSdk()).sdk.fetchArtifact('form', h.formId)), 'section_notes');
  assert.deepStrictEqual([host.columns, cellsOf(host)[0].colspan], [2, 2], 'a cell is never left wider than its section');
  assert.deepStrictEqual(layoutMutations(run.mutations), []);

  // Widened in the maker with the timeline still one column wide: the engine\u2019s own width wins, as it always did.
  const narrow = newHarness();
  await seedForm(narrow, compiledTabs(spec, tallNotesSection({ rowspan: 23, auto: 'false', colspan: 1, columns: 2 })));
  const second = await narrow.freshSdk();
  assert.strictEqual((await runSdkBuild(spec, { sdk: second.sdk, apply: true, phases: ['forms'] })).ok, true);
  assert.strictEqual(sectionOf(clone(await (await narrow.freshSdk()).sdk.fetchArtifact('form', narrow.formId)), 'section_notes').columns, 1);
});

test('timeline: a rebuild writes the repair in ONE edit, so an interrupted write leaves the old host and a retry converges', async () => {
  const h = newHarness();
  const spec = specFor();
  await seedForm(h, compiledTabs(spec, oldNotesSection()));
  const first = await h.freshSdk();
  const before = clone(await first.sdk.fetchArtifact('form', h.formId));
  const original = first.sdk.updateElement.bind(first.sdk);
  let injected = false;
  first.sdk.updateElement = async (...args) => {
    if (args[0] === 'form' && /\/rows$/.test(args[2])) { injected = true; throw new Error('injected write failure'); }
    return original(...args);
  };
  await assert.rejects(() => runSdkBuild(spec, { sdk: first.sdk, apply: true, phases: ['forms'] }), /injected write failure/);
  assert.ok(injected, 'the fault was actually exercised');
  assert.deepStrictEqual(clone(await first.sdk.getArtifact('form', h.formId)), before, 'a failed write leaves the form as it was — never half a host');
  const retry = await h.freshSdk(first.dir);
  await retry.sdk.fetchArtifact('form', h.formId);
  assert.strictEqual((await runSdkBuild(spec, { sdk: retry.sdk, apply: true, phases: ['forms'] })).ok, true);
  const host = sectionOf(await retry.sdk.getArtifact('form', h.formId), 'section_notes');
  assert.strictEqual(host.rows.length, 23);
  assert.strictEqual(cellsOf(host)[0].control.id, 'notescontrol');
});

// --- never touch what is not the engine's; never mint a second `notescontrol` --------------------------------

// A timeline a maker added — the platform's own shape, under a section of their own name.
const makerTimelineSection = () => ({ name: 'maker_timeline', label: 'Timeline', visible: true, showLabel: false, columns: 1, rows: ai.notesSectionIntent(NOTES_CLASS_ID).rows });

for (const layout of ['explicit', 'auto']) {
  test(`timeline: a maker's own timeline is never touched, and no second notescontrol is created (${layout} layout)`, async () => {
    const h = newHarness();
    const spec = specFor({ layout });
    const tabs = compiledTabs(spec, null); // no engine host
    tabs[0].columns[0].sections.push(makerTimelineSection());
    await seedForm(h, tabs);
    const before = clone(await (await h.freshSdk()).sdk.fetchArtifact('form', h.formId));
    const xmlBefore = h.store.row.formxml;

    const first = await h.freshSdk();
    const warnings = [];
    const built = await runSdkBuild(spec, { sdk: first.sdk, apply: true, phases: ['forms'], warn: (m) => warnings.push(String(m)) });
    assert.strictEqual(built.ok, true);
    const after = clone(await (await h.freshSdk()).sdk.fetchArtifact('form', h.formId));
    assert.deepStrictEqual(sectionsOf(after).map((s) => s.name), sectionsOf(before).map((s) => s.name), 'no Notes section was added beside it');
    assert.deepStrictEqual(sectionOf(after, 'maker_timeline'), sectionOf(before, 'maker_timeline'), 'the maker\u2019s timeline is byte-for-byte what it was');
    assert.strictEqual(controlIds(h.store.row.formxml).filter((x) => x === 'notescontrol').length, 1, 'still exactly one notescontrol');
    assert.ok(built.skipped.layout.some((m) => /no Notes section was added — a control on this form already uses the id 'notescontrol'/.test(m)),
      `the declined add is reported on the result; got ${JSON.stringify(built.skipped.layout)}`);
    assert.ok(warnings.some((m) => /no Notes section was added/.test(m)));
    assert.strictEqual(h.store.row.formxml, xmlBefore, 'nothing was written');
    // The form carries a timeline that renders, so verify is satisfied by it.
    const verified = await verifyForms(h, spec);
    assert.strictEqual(verified.checks.find((c) => c.kind === 'form-timeline').present, true);
  });
}

test('timeline: an old host is left as it is, and reported, when another control already holds the id notescontrol', async () => {
  const h = newHarness();
  const spec = specFor();
  const tabs = compiledTabs(spec, oldNotesSection());
  tabs[0].columns[0].sections.push(makerTimelineSection());
  await seedForm(h, tabs);
  const before = clone(await (await h.freshSdk()).sdk.fetchArtifact('form', h.formId));
  const xmlBefore = h.store.row.formxml;
  const { sdk, mutations } = await h.freshSdk();
  const built = await runSdkBuild(spec, { sdk, apply: true, phases: ['forms'] });
  assert.strictEqual(built.ok, true);
  assert.deepStrictEqual(layoutMutations(mutations), [], 'no write: the id cannot be renamed, so nothing is half-applied');
  assert.deepStrictEqual(clone(await (await h.freshSdk()).sdk.fetchArtifact('form', h.formId)), before);
  assert.strictEqual(h.store.row.formxml, xmlBefore);
  assert.ok(built.skipped.layout.some((m) => /Notes section's timeline was left as it is — its control id cannot become 'notescontrol'/.test(m)), JSON.stringify(built.skipped.layout));
  assert.ok(built.skipped.layout.some((m) => /Remove or rename one of the two in the maker, then run a full build of the spec \(not --changed-only, which skips a spec that has not changed\)\./.test(m)), 'the report says what to do, and that it takes a full build');
  assert.strictEqual(controlIds(h.store.row.formxml).filter((x) => x === 'notescontrol').length, 1);
});

test('timeline: a host a maker added a field to is not repaired — it is reported, and verify keeps failing until it is replaced', async () => {
  const h = newHarness();
  const spec = specFor();
  spec.forms[0].prune = false; // the maker's field is not in the layout: without this the build would prune it first
  const host = oldNotesSection();
  host.rows.push({ cells: [ai.fieldCellIntent('new_extra')] });
  await seedForm(h, compiledTabs(spec, host));
  const before = clone(await (await h.freshSdk()).sdk.fetchArtifact('form', h.formId));
  const { sdk, mutations } = await h.freshSdk();
  const built = await runSdkBuild(spec, { sdk, apply: true, phases: ['forms'] });
  assert.deepStrictEqual(layoutMutations(mutations).filter((m) => /section_notes|\/sections\/\d+\/rows$/.test(JSON.stringify(m.args[2]))), [], 'the host is not written');
  assert.deepStrictEqual(sectionOf(clone(await (await h.freshSdk()).sdk.fetchArtifact('form', h.formId)), 'section_notes'), sectionOf(before, 'section_notes'));
  assert.ok(built.skipped.layout.some((m) => /Notes section's timeline was left as it is — the section also holds other controls/.test(m)), JSON.stringify(built.skipped.layout));
  assert.ok(built.skipped.layout.some((m) => /Move them out of it, or delete the section, in the maker, then run a full build of the spec \(not --changed-only, which skips a spec that has not changed\) to get a timeline that renders\./.test(m)), 'the report says what to do, and that it takes a full build');
  const verified = await verifyForms(h, spec);
  const check = verified.checks.find((c) => c.kind === 'form-timeline');
  assert.strictEqual(check.present, false, 'the fix was not applied, and verify says so');
  // …and says what a build will NOT do about it, rather than sending the maker to build again — and which control it is.
  assert.match(check.detail, /the Notes section also holds the field 'new_extra', which a build does not remove, so the build leaves the section as it is; move it out of it, or delete the section, in the maker, then run a full build of the spec/);
  assert.doesNotMatch(check.detail, /repair it in place/);
});

// The repair rewrites only the host's own rows, so it waits for every step that can take another control out of the
// host — the prune of a field the layout dropped, the move of one a `fieldOptions` anchor places elsewhere — and runs
// when the host is as clean as this build will leave it. Run first, it would refuse a host that the same build is about
// to empty, and `--verify` would fail until a second build.
test('timeline: a field the layout dropped is pruned out of the old Notes section first, so the SAME build repairs the timeline', async () => {
  const h = newHarness();
  const spec = specFor(); // an explicit layout: prune is on, and new_extra is not in it
  const host = oldNotesSection();
  host.rows.push({ cells: [ai.fieldCellIntent('new_extra')] });
  await seedForm(h, compiledTabs(spec, host));
  assert.ok(h.store.row.formxml.includes('new_extra'), 'the premise: the stray field is on the form, in the Notes section');
  const before = clone(await (await h.freshSdk()).sdk.fetchArtifact('form', h.formId));
  const hostBefore = sectionOf(before, 'section_notes');
  const first = await h.freshSdk();
  const built = await runSdkBuild(spec, { sdk: first.sdk, apply: true, phases: ['forms'] });
  assert.strictEqual(built.ok, true);
  assert.deepStrictEqual(built.skipped.layout.filter((m) => /Notes section/.test(m)), [], 'the repair was not refused');
  const after = clone(await (await h.freshSdk()).sdk.fetchArtifact('form', h.formId));
  assert.ok(!h.store.row.formxml.includes('new_extra'), 'the stray field was pruned');
  const repaired = sectionOf(after, 'section_notes');
  assert.strictEqual(repaired.id, hostBefore.id, 'the same section');
  assert.strictEqual(cellsOf(repaired)[0].id, cellsOf(hostBefore)[0].id, 'the same cell');
  assert.deepStrictEqual([cellsOf(repaired).length, cellsOf(repaired)[0].control.id, cellsOf(repaired)[0].rowspan, repaired.rows.length], [1, 'notescontrol', 23, 23]);
  assert.strictEqual((await verifyForms(h, spec)).checks.find((c) => c.kind === 'form-timeline').present, true, 'verify passes after ONE build');
  const second = await h.freshSdk();
  assert.strictEqual((await runSdkBuild(spec, { sdk: second.sdk, apply: true, phases: ['forms'] })).ok, true);
  assert.deepStrictEqual(second.mutations, [], 'and a second build has nothing to do');
});

for (const layout of ['explicit', 'auto']) {
  test(`timeline: a field a \`fieldOptions\` anchor moves out of the old Notes section does not stop the same build repairing it (${layout} layout)`, async () => {
    const h = newHarness();
    const spec = specFor({ layout });
    if (layout === 'explicit') spec.forms[0].prune = false; // the field is the maker's, so it stays — placed after new_area by the anchor
    spec.forms[0].fieldOptions = { new_extra: { after: 'new_area' } };
    const host = oldNotesSection();
    host.rows.push({ cells: [ai.fieldCellIntent('new_extra')] });
    await seedForm(h, compiledTabs(spec, host));
    const first = await h.freshSdk();
    const built = await runSdkBuild(spec, { sdk: first.sdk, apply: true, phases: ['forms'] });
    assert.strictEqual(built.ok, true);
    assert.deepStrictEqual(built.skipped.layout.filter((m) => /Notes section/.test(m)), [], 'the repair was not refused');
    const after = clone(await (await h.freshSdk()).sdk.fetchArtifact('form', h.formId));
    const fields = cellsOf(sectionOf(after, layout === 'explicit' ? 'sec_more' : 'section_general')).map((c) => c.control.fieldName);
    assert.strictEqual(fields[fields.indexOf('new_area') + 1], 'new_extra', `the anchor placed it right after new_area: ${fields.join(', ')}`);
    const repaired = sectionOf(after, 'section_notes');
    assert.deepStrictEqual([cellsOf(repaired).length, cellsOf(repaired)[0].control.id, repaired.rows.length], [1, 'notescontrol', 23]);
    assert.strictEqual((await verifyForms(h, spec)).checks.find((c) => c.kind === 'form-timeline').present, true);
  });
}

test('timeline: a field the layout declares in another section is moved out of the old Notes section, and the same build repairs it', async () => {
  const h = newHarness();
  const spec = specFor();
  spec.forms[0].tabs[0].sections[1].fields.push('new_extra'); // declared in sec_more, but the form has it in the Notes section
  const host = oldNotesSection();
  host.rows.push({ cells: [ai.fieldCellIntent('new_extra')] });
  const tabs = compiledTabs(spec, host);
  const more = tabs[0].columns[0].sections.find((s) => s.name === 'sec_more');
  more.rows = more.rows.filter((r) => !r.cells.some((c) => c.control.fieldName === 'new_extra'));
  await seedForm(h, tabs);
  const first = await h.freshSdk();
  const built = await runSdkBuild(spec, { sdk: first.sdk, apply: true, phases: ['forms'] });
  assert.strictEqual(built.ok, true);
  const after = clone(await (await h.freshSdk()).sdk.fetchArtifact('form', h.formId));
  assert.ok(cellsOf(sectionOf(after, 'sec_more')).some((c) => c.control.fieldName === 'new_extra'), 'the field is in its own section');
  assert.deepStrictEqual(built.skipped.layout.filter((m) => /Notes section/.test(m)), []);
  assert.strictEqual(cellsOf(sectionOf(after, 'section_notes'))[0].control.id, 'notescontrol');
  assert.strictEqual((await verifyForms(h, spec)).checks.find((c) => c.kind === 'form-timeline').present, true);
});

// `--verify` runs on the form as it is published, BEFORE the build's field passes have taken out of the old Notes section the
// fields the spec prunes or places elsewhere, and a build judges what the section still holds only after them. So verify has
// to predict those passes: judging the published form as it stands would tell the maker to move by hand a field the build
// moves or removes itself, when one plain build repairs the timeline. Each case seeds the old Notes section holding the
// given fields, asks verify, builds and asks again — the advice has to be what the build then does.
const MOVED_BY_ANCHOR = /\(fieldOptions places it after 'new_area', so it is moved there\) out of the Notes section$/;
const holdsAndKeeps = (what) => new RegExp(`the Notes section also holds ${what}, which a build does not remove, so the build leaves the section as it is; move (?:it|them) out of it, or delete the section, in the maker, then run a full build of the spec`);
// A field the form has more than once is one verify does not predict (a build acts on one of its cells, and which one is not the
// published order): it says it cannot tell, and neither promises the repair nor sends the maker to do the build's work.
const WHICH_CELL = 'a build acts on one cell of such a field, and which one depends on how it arranges the form';
const IF_LEFT = 'If its report says the timeline was left as it is, move (?:that cell|those cells) out of the section in the maker and run a full build again';
// Where the advice is not "a full build repairs it" — the section holds something that stays, or another control holds the id — what
// it cannot tell is whether the build takes the field out first.
const cannotTell = (what) => new RegExp(`verify cannot tell whether the build (?:also )?takes ${what} out of the Notes section first — ${WHICH_CELL}\\. ${IF_LEFT}`);
// Where a full build would repair the timeline but for what verify cannot tell, the advice says what the build does unless it leaves the
// field — a condition, not a promise.
const mayLeave = (what) => new RegExp(`; the build repairs the timeline in place unless it leaves ${what} in the Notes section, and verify cannot tell whether it does — ${WHICH_CELL}\\. ${IF_LEFT}`);
const anchored = (spec, anchors, over = {}) => { Object.assign(spec.forms[0], over, { fieldOptions: anchors }); return spec; };
const withoutPrune = (spec) => Object.assign(spec.forms[0], { prune: false }) && spec;
const WEB_RESOURCE_CELL = { control: { classId: '9FDF5F91-88B1-47F4-AD53-C11EFBB3E0D8', fieldName: null, label: 'Web resource', showLabel: false, parameters: {} } };
// Two fields anchored one after the other: the build places new_other beside new_area first, and new_extra beside it once it is there.
const CHAIN = { new_other: { after: 'new_area' }, new_extra: { after: 'new_other' } };
const CHAIN_MOVED = /the field 'new_other' \(fieldOptions places it after 'new_area', so it is moved there\) and the field 'new_extra' \(fieldOptions places it after 'new_other', so it is moved there\) out of the Notes section$/;
// Three: every link is moved out, whichever order the spec lists them in and the form holds them.
const CHAIN3 = { new_third: { after: 'new_extra' }, new_extra: CHAIN.new_extra, new_other: CHAIN.new_other };
const CHAIN3_MOVED = /the field 'new_third' \(fieldOptions places it after 'new_extra', so it is moved there\), the field 'new_other' \(fieldOptions places it after 'new_area', so it is moved there\) and the field 'new_extra' \(fieldOptions places it after 'new_other', so it is moved there\) out of the Notes section$/;

const verifyBeforeBuild = [
  // What the build takes out of the section: verify says so, and the SAME build repairs the timeline.
  { name: 'a field the layout does not list, with prune on', spec: () => specFor(),
    repairs: /\(your layout does not list it, so it is removed\) out of the Notes section, and removing a field needs --allow-destructive$/ },
  // Moved beside its anchor and then pruned, in that order: the removal is what the maker is told, because that is what ends up happening.
  { name: 'a field the layout does not list that a fieldOptions anchor also places', spec: () => anchored(specFor(), { new_extra: { after: 'new_area' } }),
    repairs: /\(your layout does not list it, so it is removed\) out of the Notes section, and removing a field needs --allow-destructive$/ },
  { name: 'a field the layout declares in another section', spec: () => { const s = specFor(); s.forms[0].tabs[0].sections[1].fields.push('new_extra'); return s; },
    repairs: /\(your layout places it in section 'sec_more', so it is moved there\) out of the Notes section$/ },
  { name: 'a field a fieldOptions anchor moves, on an explicit layout with prune off', spec: () => anchored(specFor(), { new_extra: { after: 'new_area' } }, { prune: false }), repairs: MOVED_BY_ANCHOR },
  { name: 'a field a fieldOptions anchor moves, on an auto layout', spec: () => anchored(specFor({ layout: 'auto' }), { new_extra: { after: 'new_area' } }), repairs: MOVED_BY_ANCHOR },
  { name: 'a field whose anchor the layout places but the form does not have yet', spec: () => anchored(specFor(), { new_extra: { after: 'new_code' } }, { prune: false }), formWithout: ['new_code'], repairs: /fieldOptions places it after 'new_code'/ },
  { name: 'a field anchored to a field that is itself moved out of the section', hostFields: ['new_other', 'new_extra'],
    spec: () => { const s = specFor(); s.forms[0].tabs[0].sections[1].fields.push('new_other'); return anchored(s, { new_extra: { after: 'new_other' } }, { prune: false }); },
    repairs: /the field 'new_other' \(your layout places it in section 'sec_more', so it is moved there\) and the field 'new_extra' \(fieldOptions places it after 'new_other', so it is moved there\) out of the Notes section$/ },
  // An anchor that is itself anchored is moved out first (dependency order), and the field anchored to it follows — however the spec lists them.
  { name: 'a chain of anchors that both sit in the section, on an auto layout', hostFields: ['new_other', 'new_extra'], spec: () => anchored(specFor({ layout: 'auto' }), CHAIN), repairs: CHAIN_MOVED },
  { name: 'a chain of anchors that both sit in the section, on an explicit layout with prune off', hostFields: ['new_other', 'new_extra'], spec: () => anchored(specFor(), CHAIN, { prune: false }), repairs: CHAIN_MOVED },
  { name: 'a chain of anchors the spec lists last link first', hostFields: ['new_other', 'new_extra'],
    spec: () => anchored(specFor({ layout: 'auto' }), { new_extra: CHAIN.new_extra, new_other: CHAIN.new_other }), repairs: CHAIN_MOVED },
  // One inspector answers for every cell of the section, and the walks for a chain's cells overlap: with three links the walk for the
  // first cell passes through the links the next questions start from.
  { name: 'a chain of three anchors that all sit in the section, the spec listing the last link first', hostFields: ['new_third', 'new_other', 'new_extra'],
    spec: () => anchored(specFor({ layout: 'auto' }), CHAIN3), repairs: CHAIN3_MOVED },
  // What the build leaves where it is: the maker moves it, verify says which control it is, and the build refuses as told.
  { name: 'a field an explicit layout with prune off does not mention', spec: () => withoutPrune(specFor()), stays: holdsAndKeeps("the field 'new_extra'") },
  { name: 'a field an auto layout does not mention', spec: () => specFor({ layout: 'auto' }), stays: holdsAndKeeps("the field 'new_extra'") },
  { name: 'a field anchored to a column neither the form nor the layout has', spec: () => anchored(specFor(), { new_extra: { after: 'new_unlisted' } }, { prune: false }), stays: holdsAndKeeps("the field 'new_extra'") },
  { name: 'a field anchored to another field that stays in the same section', hostFields: ['new_extra', 'new_other'],
    spec: () => anchored(specFor(), { new_extra: { after: 'new_other' } }, { prune: false }), stays: holdsAndKeeps("the field 'new_extra' and the field 'new_other'") },
  { name: 'a chain of anchors whose first link has no anchor of its own', hostFields: ['new_other', 'new_extra'],
    spec: () => anchored(specFor({ layout: 'auto' }), { new_extra: { after: 'new_other' } }), stays: holdsAndKeeps("the field 'new_other' and the field 'new_extra'") },
  // Both at once: the field goes, the maker's own control does not — so the maker is told about that one only, and what the build does first.
  { name: 'a field the build prunes and a control of the maker\u2019s own', hostCells: [WEB_RESOURCE_CELL], spec: () => specFor(),
    stays: holdsAndKeeps('1 other control'), staysFirst: /the build first takes the field 'new_extra' \(your layout does not list it, so it is removed\) out of the Notes section, and removing a field needs --allow-destructive$/ },
  // A field the form has twice, one cell of it in the section: which cell a build acts on is not the published order, so verify says
  // it cannot tell — here the layout's own section comes first and the build leaves the section's cell (and reports it).
  { name: 'a field the section holds a second time, the layout having placed its first cell', hostFields: ['new_code'], alsoElsewhere: true, spec: () => specFor(),
    cannotTell: mayLeave("the field 'new_code' \\(it is on the form more than once\\)") },
];

for (const c of verifyBeforeBuild) {
  test(`timeline: verify before the build and the build itself agree about ${c.name}`, async () => {
    const hostFields = c.hostFields || ['new_extra'];
    const h = newHarness({ attributes: { ...DEFAULT_ATTRIBUTES, new_other: 'String', new_third: 'String' } });
    const spec = c.spec();
    const host = oldNotesSection();
    for (const field of hostFields) host.rows.push({ cells: [ai.fieldCellIntent(field)] });
    for (const cell of c.hostCells || []) host.rows.push({ cells: [clone(cell)] });
    const tabs = compiledTabs(spec, host);
    // The form holds these fields in the Notes section alone (except the case that says otherwise).
    const onlyInHost = c.alsoElsewhere ? [] : hostFields.concat(c.formWithout || []);
    for (const section of tabs[0].columns[0].sections) {
      if (section.name !== 'section_notes') section.rows = section.rows.filter((r) => !r.cells.some((cell) => onlyInHost.includes(cell.control.fieldName)));
    }
    await seedForm(h, tabs);
    const timelineCheck = async () => (await verifyForms(h, spec)).checks.find((k) => k.kind === 'form-timeline');

    // BEFORE the build.
    const before = await timelineCheck();
    assert.strictEqual(before.present, false);
    assert.match(before.detail, /^the deployed form's timeline does not render: the control id is '[0-9a-f-]{36}', not 'notescontrol' and its cell spans 1 row — /);
    if (c.repairs) {
      assert.match(before.detail, /— run a full build of the spec \(not --changed-only, which skips a spec that has not changed\) to repair it in place; the build first takes /);
      assert.match(before.detail, c.repairs);
      assert.doesNotMatch(before.detail, /move (?:it|them) out of it|leaves? (?:it|the section) as it is|cannot tell/, 'the maker is not sent to do what the build does');
    } else if (c.cannotTell) {
      assert.match(before.detail, c.cannotTell);
      assert.doesNotMatch(before.detail, /which a build does not remove|so the build leaves the section as it is|the build first takes|to repair it in place/, 'no promise of a repair and no certain refusal');
    } else {
      assert.match(before.detail, c.stays);
      assert.doesNotMatch(before.detail, /repair it in place|cannot tell/);
      if (c.staysFirst) assert.match(before.detail, c.staysFirst);
      else assert.doesNotMatch(before.detail, /the build first takes/);
    }

    // THE BUILD — with no preflight, as a build with --allow-destructive is.
    const first = await h.freshSdk();
    const built = await runSdkBuild(spec, { sdk: first.sdk, apply: true, phases: ['forms'] });
    assert.strictEqual(built.ok, true);
    const refusals = built.skipped.layout.filter((m) => /Notes section's timeline was left as it is/.test(m));
    const after = await timelineCheck();
    if (c.repairs) {
      assert.deepStrictEqual(refusals, [], 'the build repaired the timeline in one run');
      assert.strictEqual(after.present, true, `verify passes after ONE build; got ${after.detail}`);
    } else if (c.cannotTell) {
      assert.strictEqual(refusals.length, 1, JSON.stringify(built.skipped.layout));
      assert.strictEqual(after.present, false, 'nothing was repaired, so verify still fails');
      assert.match(after.detail, c.cannotTell, 'and still says it cannot tell which cell a build acts on');
    } else {
      assert.strictEqual(refusals.length, 1, JSON.stringify(built.skipped.layout));
      assert.match(refusals[0], /the section also holds other controls/);
      assert.strictEqual(after.present, false, 'nothing was repaired, so verify still fails');
      assert.match(after.detail, c.stays, 'and still says what to move');
      assert.doesNotMatch(after.detail, /the build first takes/, 'what the build took out is gone');
    }
  });
}

// A field the published form holds in more than one cell is one verify does not predict: a build acts on ONE cell of a field in
// each pass, the first it finds once the topology pass has reordered the sections — and that is not the published order. Each case
// seeds a form whose published order differs from the build's (or whose field the prune removes one cell at a time), then asks
// verify, builds and asks again: whichever way the build goes, what verify said has to have been true.
// Verify, then the build (with no preflight, as a build with --allow-destructive is), then verify again, on the form `h` holds.
async function verifyBuildVerify(h, spec) {
  const timeline = async () => (await verifyForms(h, spec)).checks.find((k) => k.kind === 'form-timeline');
  const before = await timeline();
  const run = await h.freshSdk();
  const warnings = [];
  const built = await runSdkBuild(spec, { sdk: run.sdk, apply: true, phases: ['forms'], warn: (m) => warnings.push(String(m)) });
  assert.strictEqual(built.ok, true, JSON.stringify(built.error || built.halt || ''));
  const refusals = built.skipped.layout.filter((m) => /Notes section's timeline was left as it is/.test(m));
  return { before, built, warnings, refusals, after: await timeline() };
}
// The old Notes section holding a cell of each of `fields`.
const hostHolding = (...fields) => { const host = oldNotesSection(); for (const f of fields) host.rows.push({ cells: [ai.fieldCellIntent(f)] }); return host; };
const columnOf = (tabs, tab = 0) => tabs[tab].columns[0];
const namedIn = (column, ...names) => names.map((n) => column.sections.find((s) => s.name === n));
const TWICE = "the field 'new_code' \\(it is on the form more than once\\)";

test('timeline: a field the build orders ahead of the Notes section is the cell it acts on — verify, which sees the published order, does not promise the repair', async () => {
  // new_code is declared in sec_main, which the form publishes AFTER the Notes section, with a cell of new_code in each. The
  // build puts sec_main back in the layout's order first, so ITS cell is the one it finds first and the Notes section's stays.
  const h = newHarness();
  const spec = specFor();
  spec.forms[0].tabs[0].sections = [
    { name: 'sec_main', label: 'Main', columns: 2, fields: ['new_name', 'new_code'] },
    { name: 'sec_more', label: 'More', columns: 1, fields: ['new_notes'] },
    { name: 'sec_tail', label: 'Tail', columns: 1, fields: ['new_area'] },
  ];
  const tabs = compiledTabs(spec, hostHolding('new_code'));
  columnOf(tabs).sections = namedIn(columnOf(tabs), 'sec_more', 'sec_tail', 'section_notes', 'sec_main');
  await seedForm(h, tabs);
  const { before, built, warnings, refusals, after } = await verifyBuildVerify(h, spec);

  assert.strictEqual(before.present, false);
  assert.match(before.detail, mayLeave(TWICE));
  assert.doesNotMatch(before.detail, /the build first takes|which a build does not remove|to repair it in place/, 'neither the promise of a repair nor the certain refusal');
  // What the build does: it reorders the sections, finds sec_main's cell first, leaves the section's, and says so.
  assert.ok(warnings.some((m) => /moved \d+ section\(s\) in tab 'tab_a'.*to put them in the layout's order/.test(m)), JSON.stringify(warnings));
  assert.strictEqual(refusals.length, 1, JSON.stringify(built.skipped.layout));
  assert.strictEqual(after.present, false);
  assert.match(after.detail, mayLeave(TWICE), 'and verify, asked again, still says it cannot tell — the cell is still there to be moved out');
});

test('timeline: a section the build moves to another tab takes its cell of a field with it — verify does not send the maker to do what the build then does', async () => {
  // sec_code is declared in tab_b but published ahead of the Notes section in tab_a; the Notes section holds a second cell of new_code.
  // The build moves sec_code to tab_b first, so the Notes section's cell is the one it finds first — and moves into sec_code.
  const h = newHarness();
  const spec = specFor();
  spec.forms[0].tabs = [
    { name: 'tab_a', label: 'A', sections: [{ name: 'sec_main', label: 'Main', columns: 2, fields: ['new_name'] }, { name: 'sec_more', label: 'More', columns: 1, fields: ['new_notes', 'new_area'] }] },
    { name: 'tab_b', label: 'B', sections: [{ name: 'sec_code', label: 'Code', columns: 1, fields: ['new_code'] }] },
  ];
  const tabs = compiledTabs(spec, hostHolding('new_code'));
  columnOf(tabs).sections.unshift(columnOf(tabs, 1).sections.shift());
  await seedForm(h, tabs);
  const { before, built, warnings, refusals, after } = await verifyBuildVerify(h, spec);

  assert.match(before.detail, mayLeave(TWICE));
  assert.doesNotMatch(before.detail, /which a build does not remove|so the build leaves the section as it is|to repair it in place/, 'the maker is not sent to move what the build moves');
  assert.ok(warnings.some((m) => /moved section 'sec_code' from tab 'tab_a'.*to tab 'tab_b'/.test(m)), JSON.stringify(warnings));
  assert.deepStrictEqual(refusals, [], JSON.stringify(built.skipped.layout));
  assert.strictEqual(after.present, true, `verify passes after ONE build; got ${after.detail}`);
  const form = clone(await (await h.freshSdk()).sdk.fetchArtifact('form', h.formId));
  assert.deepStrictEqual(cellsOf(sectionOf(form, 'sec_code')).map((c) => c.control.fieldName), ['new_code', 'new_code'], 'both cells of the field are in the section the layout declares');
  assert.ok(!cellsOf(sectionOf(form, 'section_notes')).some((c) => c.control.fieldName), 'and none is left in the Notes section');
});

test('timeline: a pruned field the form has twice is removed one cell per run — verify cannot tell the first run, and is exact once one cell is left', async () => {
  // new_extra is in sec_main (the first cell) and in the Notes section, and the layout does not list it. The prune removes one cell
  // of a field per run, so the Notes section's survives the first build and the timeline is not repaired until the second.
  const h = newHarness();
  const spec = specFor();
  const tabs = compiledTabs(spec, hostHolding('new_extra'));
  sectionOf({ tabs }, 'sec_main').rows.push({ cells: [ai.fieldCellIntent('new_extra')] });
  await seedForm(h, tabs);
  const one = await verifyBuildVerify(h, spec);

  assert.match(one.before.detail, mayLeave("the field 'new_extra' \\(it is on the form more than once\\)"));
  assert.match(one.before.detail, /run a full build again \(removing a field needs --allow-destructive\)$/, 'a removal, which needs the flag');
  assert.doesNotMatch(one.before.detail, /which a build does not remove/, 'a build does remove it — one cell a run');
  assert.strictEqual(one.refusals.length, 1, 'the first build prunes the cell in sec_main and leaves the timeline');
  assert.ok(!cellsOf(sectionOf(clone(await (await h.freshSdk()).sdk.fetchArtifact('form', h.formId)), 'sec_main')).some((c) => c.control.fieldName === 'new_extra'));
  // With ONE cell left the field is predicted, and the build then does exactly that.
  assert.strictEqual(one.after.present, false);
  assert.match(one.after.detail, /to repair it in place; the build first takes the field 'new_extra' \(your layout does not list it, so it is removed\) out of the Notes section, and removing a field needs --allow-destructive$/);
  assert.doesNotMatch(one.after.detail, /cannot tell|which a build does not remove/);
  const two = await verifyBuildVerify(h, spec);
  assert.deepStrictEqual(two.refusals, [], 'the second build repairs the timeline');
  assert.strictEqual(two.after.present, true);
});

test('timeline: a field that no pass touches stays whichever cell a build acts on, so verify says so plainly — and names the second cell of a field the section holds twice', async () => {
  const h = newHarness();
  const spec = withoutPrune(specFor());
  const tabs = compiledTabs(spec, hostHolding('new_extra', 'new_extra'));
  sectionOf({ tabs }, 'sec_main').rows.push({ cells: [ai.fieldCellIntent('new_extra')] });
  await seedForm(h, tabs);
  const { before, refusals, after } = await verifyBuildVerify(h, spec);
  const advice = /the Notes section also holds the field 'new_extra' and a second cell of the field 'new_extra', which a build does not remove, so the build leaves the section as it is; move them out of it, or delete the section, in the maker, then run a full build of the spec/;
  assert.match(before.detail, advice);
  assert.doesNotMatch(before.detail, /cannot tell|repair it in place/);
  assert.strictEqual(refusals.length, 1);
  assert.match(after.detail, advice, 'and the build leaves the form as it was');
});

test('timeline: an anchored field the form has twice is not predicted on an auto layout either — the build moves the cell it finds first, and verify says it cannot tell', async () => {
  const h = newHarness();
  const spec = anchored(specFor({ layout: 'auto' }), { new_extra: { after: 'new_area' } });
  const tabs = compiledTabs(spec, hostHolding('new_extra'));
  sectionOf({ tabs }, 'section_general').rows.push({ cells: [ai.fieldCellIntent('new_extra')] });
  await seedForm(h, tabs);
  const { before, refusals, after } = await verifyBuildVerify(h, spec);
  assert.match(before.detail, mayLeave("the field 'new_extra' \\(it is on the form more than once\\)"));
  assert.doesNotMatch(before.detail, /the build first takes|which a build does not remove|to repair it in place/);
  // The build moves the first cell (section_general's) beside new_area and leaves the Notes section's, which it reports.
  assert.strictEqual(refusals.length, 1);
  assert.match(after.detail, mayLeave("the field 'new_extra' \\(it is on the form more than once\\)"));
});

test('timeline: an anchor the form has twice, one cell of it in the Notes section, is not relied on — verify says it cannot tell where the build finds it', async () => {
  // new_code is in the Notes section (published first) and in section_general; new_extra, in the Notes section, is anchored to it.
  // The build finds the anchor's first cell in the Notes section, where it places nothing, and the anchor's own cell stays there
  // anyway — so the section is left whatever happens to new_extra, which verify says it cannot tell.
  const h = newHarness();
  const spec = anchored(specFor({ layout: 'auto' }), { new_extra: { after: 'new_code' } });
  const tabs = compiledTabs(spec, hostHolding('new_code', 'new_extra'));
  columnOf(tabs).sections = namedIn(columnOf(tabs), 'section_notes', 'section_general');
  await seedForm(h, tabs);
  const { before, refusals, after } = await verifyBuildVerify(h, spec);
  assert.match(before.detail, /the Notes section also holds the field 'new_code', which a build does not remove, so the build leaves the section as it is; move it out of it, or delete the section, in the maker, then run a full build of the spec/);
  assert.match(before.detail, cannotTell("the field 'new_extra' \\(its anchor 'new_code' is on the form more than once\\)"));
  assert.doesNotMatch(before.detail, /repair it in place|the build first takes/);
  assert.strictEqual(refusals.length, 1);
  assert.strictEqual(after.present, false);
});

test('timeline: a chain of anchors that reaches a field the form has twice names THAT field — the anchor between has one cell, and the build moves it', async () => {
  // new_extra is anchored after new_other, which is anchored after new_area; the form has new_area twice (section_general and the Notes
  // section) and new_other once. Verify cannot tell where the build finds new_area, so it cannot tell for either field — but the reason
  // it gives for new_extra must not call new_other, which has one cell, a field the form has more than once.
  const h = newHarness({ attributes: { ...DEFAULT_ATTRIBUTES, new_other: 'String' } });
  const spec = anchored(specFor({ layout: 'auto' }), { new_extra: { after: 'new_other' }, new_other: { after: 'new_area' } });
  await seedForm(h, compiledTabs(spec, hostHolding('new_other', 'new_extra', 'new_area')));
  const cellsOfField = (form, field) => sectionsOf(form).flatMap(cellsOf).filter((c) => c.control && c.control.fieldName === field).length;
  const published = clone(await (await h.freshSdk()).sdk.fetchArtifact('form', h.formId));
  assert.deepStrictEqual([cellsOfField(published, 'new_other'), cellsOfField(published, 'new_area')], [1, 2], 'the premise: only new_area is on the form twice');
  const { before, refusals, after } = await verifyBuildVerify(h, spec);

  assert.match(before.detail, holdsAndKeeps("the field 'new_area'"));
  assert.match(before.detail, cannotTell("the field 'new_other' \\(its anchor 'new_area' is on the form more than once\\) and the field 'new_extra' \\(its anchor 'new_other' follows 'new_area', which is on the form more than once\\)"));
  assert.doesNotMatch(before.detail, /its anchor 'new_other' is on the form more than once/);
  // What the build does: both fields go beside new_area; the section keeps the cell of new_area (which no rule moves) and is left, and said so.
  const form = clone(await (await h.freshSdk()).sdk.fetchArtifact('form', h.formId));
  assert.deepStrictEqual(cellsOf(sectionOf(form, 'section_notes')).map((c) => c.control.fieldName).filter(Boolean), ['new_area']);
  assert.strictEqual(refusals.length, 1);
  assert.strictEqual(after.present, false);
});

test('timeline: a taken notescontrol id and a field the form has twice — verify names the id and still says it cannot tell, and freeing the id alone does not repair the timeline', async () => {
  // new_code is in sec_main and in the old Notes section; sec_more holds a control of the maker's that already uses the id. Which cell
  // of new_code a build acts on is not the published order, so whether the section is clear once the id is free is what verify cannot
  // tell — and were that dropped while the id is named, freeing the id would look like the whole repair.
  const spec = specFor();
  const h = newHarness();
  const tabs = compiledTabs(spec, hostHolding('new_code'));
  sectionOf({ tabs }, 'sec_more').rows.push({ cells: [{ control: { ...WEB_RESOURCE_CELL.control, id: 'notescontrol' } }] });
  await seedForm(h, tabs);
  const taken = await verifyBuildVerify(h, spec);
  assert.match(taken.before.detail, /another control on the form already uses the id 'notescontrol', so a build cannot give this timeline that id; remove or rename one of the two in the maker, then run a full build of the spec \(not --changed-only, which skips a spec that has not changed\)/);
  assert.match(taken.before.detail, cannotTell(TWICE));
  assert.doesNotMatch(taken.before.detail, /repair it in place|the build first takes/);
  assert.strictEqual(taken.refusals.length, 1, JSON.stringify(taken.built.skipped.layout));
  assert.strictEqual(taken.after.present, false);
  assert.match(taken.after.detail, cannotTell(TWICE));
  // The maker frees the id — the same form without that control — and ONE full build still leaves the timeline: the note was needed.
  const freed = newHarness();
  await seedForm(freed, compiledTabs(spec, hostHolding('new_code')));
  const next = await verifyBuildVerify(freed, spec);
  assert.match(next.before.detail, mayLeave(TWICE));
  assert.strictEqual(next.refusals.length, 1, JSON.stringify(next.built.skipped.layout));
  assert.strictEqual(next.after.present, false);
});

test('timeline: an auto layout that never had Notes gets the host when the spec asks for it, once', async () => {
  const h = newHarness();
  const spec = specFor({ layout: 'auto' });
  await seedForm(h, compiledTabs(spec, null));
  assert.ok(!h.store.row.formxml.includes('section_notes'));
  const first = await h.freshSdk();
  const warnings = [];
  assert.strictEqual((await runSdkBuild(spec, { sdk: first.sdk, apply: true, phases: ['forms'], warn: (m) => warnings.push(String(m)) })).ok, true);
  assert.ok(warnings.some((w) => /added the Notes section \(timeline\)/.test(w)));
  const host = collapseEmptyRows(sectionXml(h.store.row.formxml, 'section_notes'));
  assert.ok(host.includes(PLATFORM_CONTROL));
  assert.match(host, /<row \/>×22<\/rows><\/section>$/);
  const second = await h.freshSdk();
  assert.strictEqual((await runSdkBuild(spec, { sdk: second.sdk, apply: true, phases: ['forms'] })).ok, true);
  assert.deepStrictEqual(second.mutations, [], 'the second build adds no second host');
  assert.strictEqual((h.store.row.formxml.match(/name="section_notes"/g) || []).length, 1);
});

// --- (c) the consumers of form topology accept the new shape ------------------------------------------------

test('timeline: verify finds no timeline, an old one and a platform one — and asks nothing of a form that did not ask', async () => {
  const spec = specFor({ layout: 'auto' });
  const h = newHarness();
  await seedForm(h, compiledTabs(spec, null));
  const none = (await verifyForms(h, spec)).checks.find((c) => c.kind === 'form-timeline');
  assert.strictEqual(none.present, false);
  assert.match(none.detail, /asks for the Notes timeline, but the deployed form has no timeline control — run a full build of the spec \(not --changed-only, which skips a spec that has not changed\) to add it/);

  const quiet = specFor({ layout: 'auto', notes: false });
  assert.strictEqual((await verifyForms(h, quiet)).checks.some((c) => c.kind === 'form-timeline'), false, 'a form that did not ask is not checked');
  const quickCreate = specFor({ layout: 'auto' });
  quickCreate.forms[0].formType = 'QuickCreate';
  assert.strictEqual((await verifyForms(h, quickCreate)).checks.some((c) => c.kind === 'form-timeline'), false, 'a QuickCreate form hosts no timeline');
});

test('timeline: a field with no declared section is never placed into the Notes host, even when the host comes first', async () => {
  const h = newHarness();
  // An auto layout whose form a maker reordered so the Notes host is the first section.
  const spec = specFor({ layout: 'auto' });
  const tabs = compiledTabs(spec);
  const sections = tabs[0].columns[0].sections;
  sections.unshift(sections.pop());
  const general = sections.find((s) => s.name === 'section_general');
  general.rows = general.rows.filter((r) => !r.cells.some((c) => c.control.fieldName === 'new_area')); // new_area is missing from the form
  await seedForm(h, tabs);
  const { sdk } = await h.freshSdk();
  assert.strictEqual((await runSdkBuild(spec, { sdk, apply: true, phases: ['forms'] })).ok, true);
  const after = clone(await (await h.freshSdk()).sdk.fetchArtifact('form', h.formId));
  assert.ok(cellsOf(sectionOf(after, 'section_general')).some((c) => c.control.fieldName === 'new_area'), 'new_area lands in the field section');
  assert.deepStrictEqual(cellsOf(sectionOf(after, 'section_notes')).map((c) => c.control.fieldName), [null], 'the host still holds only its timeline');
  assert.strictEqual(sectionOf(after, 'section_notes').rows.length, 23, 'and its spacer rows');
});

test('timeline: fieldOptions.after never anchors a placement inside the Notes host, so no field lands among its spacer rows', async () => {
  const h = newHarness();
  const spec = specFor();
  spec.forms[0].prune = false;
  spec.forms[0].fieldOptions = { new_area: { after: 'new_extra' } };
  spec.entities[0].columns.push({ schemaName: 'new_extra', displayName: 'Extra', type: 'Text' });
  // new_extra sits in the host (a maker put it there); new_area is in the field section and is asked to follow it.
  const host = ai.notesSectionIntent(NOTES_CLASS_ID);
  host.rows.push({ cells: [ai.fieldCellIntent('new_extra')] });
  await seedForm(h, compiledTabs(spec, host));
  const before = clone(await (await h.freshSdk()).sdk.fetchArtifact('form', h.formId));
  const { sdk } = await h.freshSdk();
  const built = await runSdkBuild(spec, { sdk, apply: true, phases: ['forms'] });
  assert.strictEqual(built.ok, true);
  const after = clone(await (await h.freshSdk()).sdk.fetchArtifact('form', h.formId));
  assert.deepStrictEqual(sectionOf(after, 'section_notes'), sectionOf(before, 'section_notes'), 'the host is exactly as it was');
  assert.ok(built.skipped.layout.some((m) => /placement of 'new_area' after 'new_extra' was skipped - the anchor sits in a section the build owns/.test(m)), JSON.stringify(built.skipped.layout));
});

test('timeline: a host a maker widened is not re-flowed, so its spacer rows survive the rebuild that narrows the grid', async () => {
  const h = newHarness();
  const spec = specFor();
  const wide = ai.notesSectionIntent(NOTES_CLASS_ID);
  wide.columns = 2;
  await seedForm(h, compiledTabs(spec, wide));
  const { sdk, mutations } = await h.freshSdk();
  assert.strictEqual((await runSdkBuild(spec, { sdk, apply: true, phases: ['forms'] })).ok, true);
  const host = sectionOf(clone(await (await h.freshSdk()).sdk.fetchArtifact('form', h.formId)), 'section_notes');
  assert.strictEqual(host.columns, 1, 'the engine\u2019s own grid width is converged as before');
  assert.strictEqual(host.rows.length, 23, 'the 22 rows its cell spans are kept');
  assert.strictEqual(cellsOf(host)[0].rowspan, 23);
  // Kept — not deleted by a re-flow and written back by the timeline repair that follows: the only write is the width.
  assert.deepStrictEqual(layoutMutations(mutations).map((m) => [m.method, m.args[3]]), [['updateElement', { columns: 1 }]]);
});

test('timeline: the form wireframe shows one Notes / Timeline block and nothing for the 22 rows it spans', () => {
  const spec = specFor({ layout: 'auto' });
  const wire = renderFormWireframe(spec, spec.forms[0]);
  assert.strictEqual((wire.match(/Notes \/ Timeline/g) || []).length, 1);
  const without = renderFormWireframe(specFor({ layout: 'auto', notes: false }), specFor({ layout: 'auto', notes: false }).forms[0]);
  assert.strictEqual(wire.split('\n').length - without.split('\n').length, 2, 'the block is a rule and one description line');
});
