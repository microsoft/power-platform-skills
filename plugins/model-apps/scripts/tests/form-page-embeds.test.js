'use strict';
// Generative pages embedded in a Main form (forms[].genPages, pages[].placement) — lib/form-page-embeds.js: the spec gate, the plan over a
// form as read, and the apply through the build's create port. The last test runs the REAL vendored SDK against a stub that stores one
// systemform row, so the typed genPage binding, the ids the SDK allocates and its own missing-page refusal are the bundle's, not a fake's.
const test = require('node:test');
const assert = require('node:assert');
const { validateFormPageEmbeds, planFormPageEmbeds, applyFormPageEmbeds, requireEmbedsApplied, runFormPageEmbeds, requirePagesPhaseForEmbeds, verifyFormPageEmbed, formEmbedsOfPage, PAGE_ROWSPAN } = require('../lib/form-page-embeds.js');
const { createCreatesPortDouble } = require('./helpers/creates-port-double.js');
const { createMakerSdk } = require('../vendor/cds-maker-sdk.cjs');
const { createHarness, seedForm, guid, clone } = require('./helpers/form-store-harness.js');

const PAGE = guid(42);
const OTHER_PAGE = guid(43);
const FORM = guid(1);

function specWith({ genPages, placement, sitemap = true, schemaVersion = 2, formType, tabs } = {}) {
  return {
    schemaVersion,
    pages: [
      { key: 'case-summary', name: 'Case Summary', ...(placement ? { placement } : {}) },
      { key: 'case-notes', name: 'Case Notes' },
    ],
    appShell: { areas: [{ groups: [{ subAreas: [{ title: 'Notes', page: schemaVersion >= 2 ? 'case-notes' : 'Case Notes' }, ...(sitemap ? [{ title: 'Summary', page: schemaVersion >= 2 ? 'case-summary' : 'Case Summary' }] : [])] }] }] },
    forms: [{ entity: 'new_ticket', name: 'Main', ...(formType ? { formType } : {}),
      tabs: tabs || [{ name: 'tab_general', sections: [{ name: 'section_general', fields: ['new_name', 'new_code'] }] }],
      ...(genPages ? { genPages } : {}) }],
  };
}
const EMBED = { key: 'summary', page: 'case-summary', tab: 'tab_general', section: 'section_general' };

test('the spec gate accepts a well-formed embed and names each malformed one', () => {
  assert.deepStrictEqual(validateFormPageEmbeds(specWith({ genPages: [{ ...EMBED, after: 'new_name', inputData: { mode: 'compact', n: [1, null] } }] })), { errors: [], warnings: [] });
  // A legacy spec names pages by name, and a spec without genPages is untouched.
  assert.deepStrictEqual(validateFormPageEmbeds(specWith({ schemaVersion: 1, genPages: [{ ...EMBED, page: 'Case Summary' }] })).errors, []);
  assert.deepStrictEqual(validateFormPageEmbeds(specWith()).errors, []);

  const errorsOf = (opts) => validateFormPageEmbeds(specWith(opts)).errors;
  const one = (opts, pattern) => {
    const errors = errorsOf(opts);
    assert.ok(errors.some((e) => pattern.test(e)), `${pattern} in ${JSON.stringify(errors)}`);
  };
  one({ placement: 'dialog' }, /placement must be one of sitemap, form/);
  one({ genPages: {} }, /genPages must be an array/);
  one({ formType: 'QuickCreate', genPages: [EMBED] }, /Main form only/);
  one({ genPages: [{ ...EMBED, Tab: 'x' }] }, /unknown key 'Tab'/);
  one({ genPages: [{ ...EMBED, key: '' }] }, /key must be a non-empty string/);
  one({ genPages: [EMBED, { ...EMBED, page: 'case-notes' }] }, /duplicate key 'summary'/);
  one({ genPages: [{ ...EMBED, page: 'nope' }] }, /page 'nope' is not declared/);
  one({ genPages: [EMBED, { ...EMBED, key: 'again' }] }, /embedded twice in this form/);
  one({ genPages: [{ ...EMBED, tab: 'tab_other' }] }, /tab 'tab_other' is not on this form/);
  one({ genPages: [{ ...EMBED, section: 'section_other' }] }, /section 'section_other' is not in tab/);
  one({ genPages: [{ ...EMBED, section: undefined }] }, /tab and section are both required/);
  one({ genPages: [EMBED], tabs: [{ name: 'tab_general', columns: [{ sections: [{ name: 'section_general' }] }, { sections: [{ name: 'section_general' }] }] }] }, /names more than one section/);
  one({ genPages: [{ ...EMBED, after: 7 }] }, /after must name a field/);
  one({ genPages: [{ ...EMBED, inputData: [1] }] }, /inputData must be a JSON object/);
  one({ genPages: [{ ...EMBED, inputData: { at: new Date(0) } }] }, /inputData must be a JSON object/);
  one({ genPages: [{ ...EMBED, inputData: { n: Infinity } }] }, /inputData must be a JSON object/);
  // A form-only page needs an embed, and the sitemap must not also link it.
  one({ placement: 'form', sitemap: false }, /placement is 'form' but no form's genPages embeds it/);
  one({ placement: 'form', genPages: [EMBED] }, /placement is 'form' but the sitemap links it/);
  assert.deepStrictEqual(errorsOf({ placement: 'form', sitemap: false, genPages: [EMBED] }), []);
});

// A form as the SDK's artifact shows it: tabs[].columns[].sections[].rows[].cells[].control.
const cell = (control, id, extra = {}) => ({ id: `cell-${id}`, ...extra, control: { id: `ctl-${id}`, ...control } });
function formArtifact(sections) {
  return { id: FORM, tabs: [{ name: 'tab_general', columns: sections.map((s) => ({ sections: [s] })) }] };
}
function fakeProvision(artifact, { onPush } = {}) {
  const calls = [];
  let current = clone(artifact);
  let minted = 0;
  return {
    calls,
    current: () => current,
    fetchArtifact: async (kind, id) => { calls.push(['fetch', kind, id]); return clone(current); },
    getArtifact: async () => clone(current),
    // As the SDK does (mintEmbedIdentity): ids a cell or control is given are kept; only missing ones are minted.
    addElement: async (kind, id, pointer, element, opts) => {
      calls.push(['add', pointer, opts.position.index, clone(element)]);
      const rows = pointer.split('/').slice(1).reduce((n, p) => n[p], current);
      rows.splice(opts.position.index, 0, { cells: element.cells.map((c) => { minted += 1; return { ...clone(c), id: c.id || `minted-cell-${minted}`, control: { ...clone(c.control), id: (c.control && c.control.id) || `minted-ctl-${minted}` } }; }) });
    },
    updateElement: async (kind, id, pointer, value) => {
      calls.push(['update', pointer, clone(value)]);
      const parts = pointer.split('/').slice(1);
      const last = parts.pop();
      parts.reduce((n, p) => n[p], current)[last] = clone(value);
    },
    pushArtifact: async (kind, id) => {
      calls.push(['push', kind, id]);
      if (onPush) return onPush(current);
      return { type: kind, id, saved: true };
    },
  };
}
const ctxFor = (provision, { formId = FORM, pages = { 'case-summary': PAGE, 'case-notes': OTHER_PAGE }, bindings = new Map(), creates = createCreatesPortDouble() } = {}) => {
  const queued = [];
  return {
    queued, provision, creates, bindings,
    formIdOf: async () => formId,
    pageIdOf: async (ref) => pages[ref] || null,
    managed: { lookup: async (kind, key) => bindings.get(`${kind}|${key}`) || null },
    publication: { queue: (target) => queued.push(target) },
    warn: () => {},
  };
};
// What the build records from a result's managedBindings, so the next plan finds them by key.
const keep = (ctx, result) => { for (const b of result.managedBindings) ctx.bindings.set(`${b.kind}|${b.key}`, b); };
const general = (rows, columns = 1) => ({ name: 'section_general', columns, rows });
const FIELD_ROWS = () => [{ cells: [cell({ fieldName: 'new_name' }, 'name')] }, { cells: [cell({ fieldName: 'new_code' }, 'code')] }];
const KEY = 'new_ticket|Main|Main#summary';
const NOTES_KEY = 'new_ticket|Main|Main#notes';
// A row as a short word: a field's name, the page a cell embeds (with its row span), or '-' for an empty row.
const shape = (rows) => rows.map((r) => (r.cells.length ? r.cells.map((c) => c.control.fieldName || `${c.control.genPage.pageId === PAGE ? 'P' : c.control.genPage.pageId === OTHER_PAGE ? 'Q' : '?'}:${c.rowspan || 1}`).join('+') : '-'));
const rowsOf = (artifact, s = 0) => artifact.tabs[0].columns[s].sections[0].rows;

test('the plan adds, keeps, updates in place, and refuses what it does not own', async () => {
  const spec = specWith({ genPages: [{ ...EMBED, after: 'new_name', inputData: { mode: 'compact' } }] });
  const planOf = async (sections, opts) => {
    const provision = fakeProvision(formArtifact(sections));
    return { plan: await planFormPageEmbeds(spec, ctxFor(provision, opts)), provision };
  };

  let { plan, provision } = await planOf([general(FIELD_ROWS())]);
  assert.deepStrictEqual(plan.unknown, []);
  assert.strictEqual(plan.operations.length, 1);
  const [add] = plan.operations;
  assert.deepStrictEqual({ action: add.action, pointer: add.pointer, index: add.index, genPage: add.genPage, destructive: add.destructive, publicationScopes: add.publicationScopes },
    { action: 'add', pointer: '/tabs/0/columns/0/sections/0/rows', index: 1, genPage: { pageId: PAGE, inputData: { mode: 'compact' } }, destructive: false, publicationScopes: [`form:${FORM}`] });
  assert.deepStrictEqual(provision.calls.map((c) => c[0]), ['fetch'], 'a plan only reads');
  // Without `after` the new row goes at the end of the section.
  const appended = await planFormPageEmbeds(specWith({ genPages: [EMBED] }), ctxFor(fakeProvision(formArtifact([general(FIELD_ROWS())]))));
  assert.strictEqual(appended.operations[0].index, 2);

  const embedded = (inputData, id = 'emb') => ({ cells: [cell({ classId: 'F9A8A302-114E-466A-B582-6771B2AE0D92', genPage: { pageId: PAGE.toUpperCase(), ...(inputData ? { inputData } : {}) } }, id)] });
  ({ plan } = await planOf([general([...FIELD_ROWS().slice(0, 1), embedded({ mode: 'compact' }), ...FIELD_ROWS().slice(1)])]));
  assert.deepStrictEqual(plan.operations.map((o) => [o.action, o.cellId, o.controlId, o.origin]), [['none', 'cell-emb', 'ctl-emb', 'adopted']], 'the same page and input is already there (page ids compare case-insensitively)');

  ({ plan } = await planOf([general([...FIELD_ROWS().slice(0, 1), embedded({ mode: 'full' }), ...FIELD_ROWS().slice(1)])]));
  assert.deepStrictEqual(plan.operations.map((o) => [o.action, o.pointer, o.value]),
    [['update', '/tabs/0/columns/0/sections/0/rows/1/cells/0/control/genPage', { pageId: PAGE.toUpperCase(), inputData: { mode: 'compact' } }]],
    'a changed input edits the typed binding in place, keeping the page id the form holds');

  const refusedFor = async (sections, embed = { ...EMBED, after: 'new_name' }) => (await planFormPageEmbeds(specWith({ genPages: [embed] }), ctxFor(fakeProvision(formArtifact(sections))))).operations.map((o) => [o.action, o.reason]);
  assert.deepStrictEqual(await refusedFor([general(FIELD_ROWS()), { name: 'section_side', columns: 1, rows: [embedded(undefined)] }]), [['refuse', 'page-embedded-elsewhere']]);
  assert.deepStrictEqual(await refusedFor([general([...FIELD_ROWS(), embedded(undefined, 'a'), embedded(undefined, 'b')])]), [['refuse', 'page-embedded-more-than-once']]);
  assert.deepStrictEqual(await refusedFor([general(FIELD_ROWS())], { ...EMBED, after: 'new_missing' }), [['refuse', 'after-field-not-found']]);
  assert.deepStrictEqual(await refusedFor([{ name: 'section_side', rows: [] }]), [['refuse', 'section-not-found']]);
  assert.deepStrictEqual(await refusedFor([general([]), general([])]), [['refuse', 'section-ambiguous']]);
  assert.deepStrictEqual(await refusedFor([{ name: 'section_general', rows: FIELD_ROWS() }]), [['refuse', 'section-geometry-unknown']], 'a section whose column count is not known is not a grid this plan can check');

  // A form or a page the build has no id for is unknown — and an unbuilt form is not even read.
  ({ plan, provision } = await planOf([general(FIELD_ROWS())], { formId: null }));
  assert.deepStrictEqual([plan.operations, plan.unknown.map((u) => u.reason), provision.calls], [[], ['form-not-built'], []]);
  ({ plan } = await planOf([general(FIELD_ROWS())], { pages: {} }));
  assert.deepStrictEqual([plan.operations, plan.unknown.map((u) => u.reason)], [[], ['page-not-built']]);
  // Without the managed-binding port no embed can be told apart from another key's: unknown, and the form is not read.
  provision = fakeProvision(formArtifact([general(FIELD_ROWS())]));
  plan = await planFormPageEmbeds(spec, { ...ctxFor(provision), managed: undefined });
  assert.deepStrictEqual([plan.operations, plan.unknown.map((u) => u.reason), provision.calls], [[], ['managed-bindings-unavailable'], []]);
});

test('an embed is added as its page row and five empty rows, so the section keeps fitting its grid; a place inside a row span is refused', async () => {
  const { fitsGrid } = require('../lib/form-occupancy.js');
  // One column, `after` the first of two fields: the page's six-row span must not sit on the second field.
  let provision = fakeProvision(formArtifact([general(FIELD_ROWS())]));
  let ctx = ctxFor(provision);
  const spec = specWith({ genPages: [{ ...EMBED, after: 'new_name' }] });
  let result = await applyFormPageEmbeds(await planFormPageEmbeds(spec, ctx), ctx);
  let rows = rowsOf(provision.current());
  assert.deepStrictEqual(shape(rows), ['new_name', `P:${PAGE_ROWSPAN}`, '-', '-', '-', '-', '-', 'new_code']);
  assert.ok(fitsGrid(rows, 1), 'the one-column section still fits');
  assert.deepStrictEqual(result.saved.map((s) => s.action), ['add']);
  keep(ctx, result);
  // Unchanged rebuild: nothing to do, nothing written.
  const before = provision.calls.length;
  result = await applyFormPageEmbeds(await planFormPageEmbeds(spec, ctx), ctx);
  assert.deepStrictEqual([result.saved, result.unchanged.map((u) => u.key), provision.calls.slice(before).map((c) => c[0])], [[], [KEY], ['fetch']]);

  // Two columns with a carried span: A spans rows 0-1. After C (row 1) the insert point is free; after A it is inside A's span.
  const carried = () => general([
    { cells: [cell({ fieldName: 'new_a' }, 'a', { rowspan: 2 }), cell({ fieldName: 'new_b' }, 'b')] },
    { cells: [cell({ fieldName: 'new_c' }, 'c')] },
    { cells: [cell({ fieldName: 'new_d' }, 'd'), cell({ fieldName: 'new_e' }, 'e')] },
  ], 2);
  const twoCol = (after) => specWith({ genPages: [{ ...EMBED, after }], tabs: [{ name: 'tab_general', sections: [{ name: 'section_general', fields: ['new_a', 'new_b', 'new_c', 'new_d', 'new_e'] }] }] });
  provision = fakeProvision(formArtifact([carried()]));
  ctx = ctxFor(provision);
  const inside = await planFormPageEmbeds(twoCol('new_a'), ctx);
  assert.deepStrictEqual(inside.operations.map((o) => [o.action, o.reason]), [['refuse', 'placement-inside-row-span']]);
  result = await applyFormPageEmbeds(inside, ctx);
  assert.deepStrictEqual([result.refused.map((r) => r.reason), provision.calls.map((c) => c[0])], [['placement-inside-row-span'], ['fetch']], 'refused before any write');
  assert.ok(fitsGrid(rowsOf(provision.current()), 2));
  ctx = ctxFor(provision);
  result = await applyFormPageEmbeds(await planFormPageEmbeds(twoCol('new_c'), ctx), ctx);
  rows = rowsOf(provision.current());
  assert.deepStrictEqual(shape(rows), ['new_a+new_b', 'new_c', `P:${PAGE_ROWSPAN}`, '-', '-', '-', '-', '-', 'new_d+new_e']);
  assert.ok(fitsGrid(rows, 2), 'the two-column section still fits');

  // Several embeds: at one place they keep the spec's order; at two places neither insert moves the other's.
  const both = (afterNotes) => specWith({ genPages: [{ ...EMBED, after: 'new_name' }, { key: 'notes', page: 'case-notes', tab: 'tab_general', section: 'section_general', after: afterNotes }] });
  for (const [afterNotes, want] of [
    ['new_name', ['new_name', 'P:6', '-', '-', '-', '-', '-', 'Q:6', '-', '-', '-', '-', '-', 'new_code']],
    ['new_code', ['new_name', 'P:6', '-', '-', '-', '-', '-', 'new_code', 'Q:6', '-', '-', '-', '-', '-']],
  ]) {
    provision = fakeProvision(formArtifact([general(FIELD_ROWS())]));
    ctx = ctxFor(provision);
    result = await applyFormPageEmbeds(await planFormPageEmbeds(both(afterNotes), ctx), ctx);
    rows = rowsOf(provision.current());
    assert.deepStrictEqual(shape(rows), want);
    assert.ok(fitsGrid(rows, 1));
    assert.deepStrictEqual(provision.calls.filter((c) => c[0] === 'push').length, 1, 'one push per form');
    keep(ctx, result);
    const again = await applyFormPageEmbeds(await planFormPageEmbeds(both(afterNotes), ctx), ctx);
    assert.deepStrictEqual([again.saved, again.refused, again.unchanged.map((u) => u.key).sort()], [[], [], [NOTES_KEY, KEY]], 'and a rebuild finds both in place');
  }
});

test('an add is sent under the ids the create port allocated, from inside the port\'s one execute per add, in one push for the form', async () => {
  const creates = createCreatesPortDouble();
  const atPush = [];
  const provision = fakeProvision(formArtifact([general(FIELD_ROWS())]), { onPush: () => {
    atPush.push(creates.events.map((e) => e.slice(0, 2)));
    return { type: 'form', id: FORM, saved: true };
  } });
  const ctx = ctxFor(provision, { creates });
  const spec = specWith({ genPages: [{ ...EMBED, inputData: { secretish: 'value-not-for-results' } }, { key: 'notes', page: 'case-notes', tab: 'tab_general', section: 'section_general', after: 'new_name' }] });
  const result = await applyFormPageEmbeds(await planFormPageEmbeds(spec, ctx), ctx);

  assert.strictEqual(atPush.length, 1, 'one push');
  assert.deepStrictEqual(atPush[0].filter((e) => e[0] === 'execute').map((e) => e[1]).sort(), [KEY, NOTES_KEY].sort(), 'the push is made inside each add\'s execute, once each');
  assert.deepStrictEqual(creates.events.length, 4, 'nothing ran after the push');
  for (const key of [KEY, NOTES_KEY]) {
    const reserved = creates.idsOf(key);
    const placed = [...rowsOf(provision.current())].flatMap((r) => r.cells).find((c) => c.control.id === reserved.childIds.control);
    assert.ok(placed, `${key}: the control carries the reserved control id`);
    assert.strictEqual(placed.id, reserved.childIds.cell, `${key}: the cell carries the reserved cell id`);
    assert.deepStrictEqual(placed.control.bag.a, [['uniqueid', `{${reserved.id}}`]], `${key}: the control's uniqueid is the reserved root id`);
    const binding = result.managedBindings.find((b) => b.key === key);
    assert.deepStrictEqual([binding.id, binding.cellId, binding.uniqueId, binding.origin], [reserved.childIds.control, reserved.childIds.cell, reserved.id, 'created']);
  }
  assert.deepStrictEqual(provision.calls.filter((c) => c[0] === 'push').length, 1, 'one push for the form');
  assert.deepStrictEqual(ctx.queued, [{ kind: 'form', id: FORM, table: 'new_ticket', label: 'form new_ticket|Main|Main page embeds' }], 'the table is named, so the build can owe its publish');
  assert.doesNotMatch(JSON.stringify(result), /value-not-for-results/, 'a result carries no input value');
});

test('a push that fails is the build\'s failure as it came: the port runs each add once and sends nothing again, and nothing is reported saved', async () => {
  for (const failure of [Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    Object.assign(new Error('Refusing to push the form: it embeds generative page(s) that do not exist in this environment.'), { code: 'FORM_GENPAGE_TARGET_NOT_FOUND' })]) {
    const creates = createCreatesPortDouble();
    const provision = fakeProvision(formArtifact([general(FIELD_ROWS())]), { onPush: () => { throw failure; } });
    const ctx = ctxFor(provision, { creates });
    const spec = specWith({ genPages: [{ ...EMBED, after: 'new_name' }] });
    await assert.rejects(applyFormPageEmbeds(await planFormPageEmbeds(spec, ctx), ctx), (err) => err === failure);
    assert.deepStrictEqual(creates.events.map((ev) => ev.slice(0, 2)), [['allocate', KEY], ['execute', KEY]], 'one execute, no second send');
    assert.deepStrictEqual([provision.calls.filter((c) => c[0] === 'push').length, ctx.queued], [1, []]);
  }
});

test('an embed is found by its key\'s binding first: a new page retargets the cell in place, a changed place is refused, another key\'s cell is not adopted', async () => {
  const provision = fakeProvision(formArtifact([general(FIELD_ROWS())]));
  const ctx = ctxFor(provision);
  const at = (page, after = 'new_name', inputData) => specWith({ genPages: [{ ...EMBED, page, after, ...(inputData ? { inputData } : {}) }] });
  let result = await applyFormPageEmbeds(await planFormPageEmbeds(at('case-summary'), ctx), ctx);
  keep(ctx, result);
  const [first] = result.managedBindings;

  // The same key now names another page: the cell its binding names is edited in place — the old page is not left behind.
  let plan = await planFormPageEmbeds(at('case-notes'), ctx);
  assert.deepStrictEqual(plan.operations.map((o) => [o.action, o.controlId, o.value]), [['update', first.id, { pageId: OTHER_PAGE }]]);
  result = await applyFormPageEmbeds(plan, ctx);
  keep(ctx, result);
  let rows = rowsOf(provision.current());
  assert.deepStrictEqual(shape(rows), ['new_name', 'Q:6', '-', '-', '-', '-', '-', 'new_code']);
  assert.deepStrictEqual([rows[1].cells[0].id, rows[1].cells[0].control.id], [first.cellId, first.id], 'same cell, same control');
  assert.deepStrictEqual(result.managedBindings.map((b) => [b.key, b.id, b.pageId]), [[KEY, first.id, OTHER_PAGE]]);

  // A changed place is refused, not reported unchanged, and no binding records the new intent.
  plan = await planFormPageEmbeds(at('case-notes', 'new_code'), ctx);
  result = await applyFormPageEmbeds(plan, ctx);
  assert.deepStrictEqual([result.refused.map((r) => r.reason), result.unchanged, result.managedBindings], [['placement-differs'], [], []]);
  // Without `after` the place is the maker's: unchanged.
  result = await applyFormPageEmbeds(await planFormPageEmbeds(specWith({ genPages: [{ ...EMBED, page: 'case-notes' }] }), ctx), ctx);
  assert.deepStrictEqual(result.unchanged.map((u) => u.id), [first.id]);

  // A cell another key's binding names is not adopted by page: the key 'summary' asking for Q finds Q in 'notes''s cell.
  const claimed = ctxFor(provision);
  claimed.bindings.set(`formPageEmbed|${NOTES_KEY}`, { kind: 'formPageEmbed', key: NOTES_KEY, id: first.id });
  plan = await planFormPageEmbeds(specWith({ genPages: [{ ...EMBED, page: 'case-notes', after: 'new_name' }, { key: 'notes', page: 'case-summary', tab: 'tab_general', section: 'section_general', after: 'new_code' }] }), claimed);
  assert.deepStrictEqual(plan.operations.map((o) => [o.key, o.action, o.reason]), [[KEY, 'refuse', 'cell-bound-to-another-embed'], [NOTES_KEY, 'refuse', 'placement-differs']], 'and the key that owns the cell is held to its own place');

  // The cell a binding names is gone: the embed is added again, once, under the ids the port allocates for this add, and the binding names them.
  const gone = fakeProvision(formArtifact([general(FIELD_ROWS())]));
  const again = ctxFor(gone, { creates: ctx.creates, bindings: ctx.bindings });
  result = await applyFormPageEmbeds(await planFormPageEmbeds(at('case-notes'), again), again);
  rows = rowsOf(gone.current());
  assert.deepStrictEqual(shape(rows), ['new_name', 'Q:6', '-', '-', '-', '-', '-', 'new_code']);
  assert.deepStrictEqual(result.managedBindings.map((b) => [b.id, b.origin]), [[rows[1].cells[0].control.id, 'created']], 'the binding names the control the form now holds');
});

test('the apply refuses an add with no create port, a requested embed that is not applied halts the build, and refusals and unknowns write nothing', async () => {
  const provision = fakeProvision(formArtifact([general(FIELD_ROWS())]));
  const ctx = { ...ctxFor(provision), creates: undefined };
  const plan = await planFormPageEmbeds(specWith({ genPages: [EMBED] }), ctx);
  plan.operations.push({ key: 'k', kind: 'formPageEmbed', action: 'refuse', reason: 'page-embedded-elsewhere', target: plan.operations[0].target });
  plan.unknown.push({ key: 'u', kind: 'formPageEmbed', reason: 'page-not-built' });
  const result = await applyFormPageEmbeds(plan, ctx);
  assert.deepStrictEqual(result.refused.map((r) => r.reason), ['page-embedded-elsewhere', 'create-port-unavailable']);
  assert.deepStrictEqual(result.unknown.map((u) => u.key), ['u']);
  assert.deepStrictEqual([result.saved, result.pendingPublish, ctx.queued], [[], [], []]);
  assert.deepStrictEqual(provision.calls.map((c) => c[0]), ['fetch'], 'no add, no push');

  assert.throws(() => requireEmbedsApplied(result), (e) => e.name === 'BuildHalt' && e.code === 'form-page-embeds-incomplete' && e.transient === false
    && JSON.stringify(e.notApplied) === JSON.stringify([
      { key: 'k', kind: 'formPageEmbed', reason: 'page-embedded-elsewhere', outcome: 'refused' },
      { key: KEY, kind: 'formPageEmbed', reason: 'create-port-unavailable', outcome: 'refused' },
      { key: 'u', kind: 'formPageEmbed', reason: 'page-not-built', outcome: 'unknown' }]));
  const clean = { saved: [{ key: KEY }], unchanged: [], pendingPublish: [], refused: [], unknown: [], managedBindings: [] };
  assert.strictEqual(requireEmbedsApplied(clean), clean);
});

test('a push that fails by value halts like every other form push, before publication is queued', async () => {
  const creates = createCreatesPortDouble();
  const provision = fakeProvision(formArtifact([general(FIELD_ROWS())]));
  provision.pushArtifact = async () => ({ type: 'form', id: FORM, saved: false, error: { code: 'VERSION_CONFLICT', message: '412', statusCode: 412 } });
  const ctx = ctxFor(provision, { creates });
  const plan = await planFormPageEmbeds(specWith({ genPages: [EMBED] }), ctx);
  await assert.rejects(applyFormPageEmbeds(plan, ctx), (e) => e.code === 'version-conflict');
  assert.deepStrictEqual(ctx.queued, []);
  assert.deepStrictEqual(creates.events.filter((e) => e[0] === 'execute').length, 1, 'sent once, not again');
});

test('the build step reads page ids from the build\'s Map, reports what it saved, then halts on each requested embed it could not apply', async () => {
  const stepCtx = (provision, extra = {}) => {
    const ctx = ctxFor(provision);
    delete ctx.pageIdOf;
    const reports = [];
    return { ...ctx, keyToId: new Map([['case-summary', PAGE]]), report: (r) => reports.push(r), reports, ...extra };
  };
  const notesEmbed = { key: 'notes', page: 'case-notes', tab: 'tab_general', section: 'section_general', after: 'new_code' };
  const halted = (e, expected) => e.name === 'BuildHalt' && e.code === 'form-page-embeds-incomplete'
    && JSON.stringify(e.notApplied.map((m) => [m.key, m.outcome, m.reason])) === JSON.stringify(expected);

  // A page the build has not got an id for (its stage did not run, or failed): what could be applied is saved and reported, and the build halts.
  const provision = fakeProvision(formArtifact([general(FIELD_ROWS())]));
  const ctx = stepCtx(provision);
  await assert.rejects(runFormPageEmbeds(specWith({ genPages: [{ ...EMBED, after: 'new_name' }, notesEmbed] }), ctx), (e) => halted(e, [[NOTES_KEY, 'unknown', 'page-not-built']])
    && e.embeds === ctx.reports[0]);
  assert.strictEqual(ctx.reports.length, 1, 'reported before the halt');
  assert.deepStrictEqual(ctx.reports[0].saved.map((s) => s.key), [KEY], 'the page the Map names was embedded');
  assert.deepStrictEqual(ctx.reports[0].managedBindings.map((b) => b.key), [KEY], 'no binding is claimed for the page that was not built');
  assert.deepStrictEqual(ctx.queued, [{ kind: 'form', id: FORM, table: 'new_ticket', label: 'form new_ticket|Main|Main page embeds' }]);

  // No create port: nothing is written, and the build halts.
  const noPort = fakeProvision(formArtifact([general(FIELD_ROWS())]));
  const ctx2 = stepCtx(noPort, { creates: undefined });
  await assert.rejects(runFormPageEmbeds(specWith({ genPages: [EMBED] }), ctx2), (e) => halted(e, [[KEY, 'refused', 'create-port-unavailable']]));
  assert.deepStrictEqual([noPort.calls.map((c) => c[0]), ctx2.reports[0].managedBindings], [['fetch'], []]);

  // Two live sections answer to the requested name: nothing is guessed, nothing written.
  const twice = fakeProvision(formArtifact([general(FIELD_ROWS()), general(FIELD_ROWS())]));
  const ctx3 = stepCtx(twice);
  await assert.rejects(runFormPageEmbeds(specWith({ genPages: [EMBED] }), ctx3), (e) => halted(e, [[KEY, 'refused', 'section-ambiguous']]));
  assert.deepStrictEqual([twice.calls.map((c) => c[0]), ctx3.reports[0].managedBindings, ctx3.creates.events], [['fetch'], [], []]);

  // A spec with no form embed reads nothing and answers null; one whose embeds all apply answers the result.
  const idle = fakeProvision(formArtifact([general(FIELD_ROWS())]));
  assert.strictEqual(await runFormPageEmbeds(specWith({}), stepCtx(idle)), null);
  assert.deepStrictEqual(idle.calls, []);
  const ok = await runFormPageEmbeds(specWith({ genPages: [EMBED] }), stepCtx(fakeProvision(formArtifact([general(FIELD_ROWS())]))));
  assert.deepStrictEqual(ok.saved.map((s) => s.key), [KEY]);
});

test('a run that builds the forms but not the pages refuses a spec with form embeds before anything is written; every other phase set is let through', () => {
  const PHASES = ['solution', 'data-model', 'sample-data', 'forms', 'app-shell', 'pages', 'publish'];
  const embedded = specWith({ genPages: [EMBED, { key: 'notes', page: 'case-notes', tab: 'tab_general', section: 'section_general' }] });
  assert.throws(() => requirePagesPhaseForEmbeds(embedded, ['solution', 'data-model', 'forms', 'app-shell']), (e) => e.name === 'BuildHalt'
    && e.code === 'form-page-embeds-incomplete' && e.phase === 'preflight' && e.transient === false && /before writing anything/.test(e.message)
    && JSON.stringify(e.notApplied) === JSON.stringify([
      { key: KEY, kind: 'formPageEmbed', reason: 'pages-phase-not-selected', outcome: 'unknown' },
      { key: NOTES_KEY, kind: 'formPageEmbed', reason: 'pages-phase-not-selected', outcome: 'unknown' }]));
  // Let through: every phase; pages with forms; pages without forms (the embed step then says form-not-built); no forms at all; a spec with no embed.
  for (const phases of [PHASES, ['forms', 'pages'], ['pages'], ['solution', 'data-model', 'sample-data']]) assert.strictEqual(requirePagesPhaseForEmbeds(embedded, phases), undefined, phases.join(','));
  assert.strictEqual(requirePagesPhaseForEmbeds(specWith({}), ['solution', 'data-model', 'forms', 'app-shell']), undefined, 'no embed: a forms-only run is as before');
});

// Two forms, each embedding the same page; the second form's provision and publication can be made to fail. A saved form stays saved.
function twoForms({ secondPush, queue } = {}) {
  const SECOND = guid(2);
  const first = fakeProvision(formArtifact([general(FIELD_ROWS())]));
  const second = fakeProvision({ ...formArtifact([general(FIELD_ROWS())]), id: SECOND }, { onPush: secondPush });
  const provision = Object.fromEntries(['fetchArtifact', 'addElement', 'updateElement', 'pushArtifact'].map((name) => [name, (...args) => (args[1] === SECOND ? second : first)[name](...args)]));
  const spec = specWith({ genPages: [EMBED] });
  spec.forms.push({ ...clone(spec.forms[0]), name: 'Second' });
  const reports = [];
  const ctx = { ...ctxFor(provision), formIdOf: async (f) => (f.name === 'Main' ? FORM : SECOND), report: (r) => reports.push(r) };
  if (queue) ctx.publication = { queue };
  return { first, second, spec, ctx, reports, SECOND_KEY: 'new_ticket|Main|Second#summary' };
}

test('a later form whose push fails does not lose an earlier form\'s acknowledged save: it is reported with its binding, and the failure propagates as it came', async () => {
  const failures = [
    ['a lost answer', () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); }, (e) => e.code === 'ECONNRESET'],
    ['a refusal by value', () => ({ type: 'form', saved: false, error: { code: 'VERSION_CONFLICT', message: '412', statusCode: 412 } }), (e) => e.code === 'version-conflict'],
  ];
  for (const [what, secondPush, isFailure] of failures) {
    const { first, spec, ctx, reports, SECOND_KEY } = twoForms({ secondPush });
    let error;
    await assert.rejects(runFormPageEmbeds(spec, ctx), (e) => { error = e; return isFailure(e); }, what);
    assert.strictEqual(first.calls.filter((c) => c[0] === 'push').length, 1, `${what}: the first form was pushed`);
    assert.strictEqual(reports.length, 1, `${what}: what was saved is reported before the failure propagates`);
    const [report] = reports;
    assert.strictEqual(error.embeds, report, `${what}: the failure carries the same result`);
    assert.deepStrictEqual(report.saved.map((s) => [s.key, s.action]), [[KEY, 'add']], `${what}: the first form's save`);
    assert.deepStrictEqual(report.managedBindings.map((b) => [b.key, b.formId, b.origin]), [[KEY, FORM, 'created']], `${what}: and its binding`);
    assert.deepStrictEqual(report.pendingPublish, [{ kind: 'form', id: FORM }]);
    assert.deepStrictEqual(report.unknown.map((u) => [u.key, u.reason]), [[SECOND_KEY, 'form-push-failed']], `${what}: the failed form's embed is not claimed saved`);
    assert.deepStrictEqual(ctx.queued.map((q) => q.id), [FORM], `${what}: only the saved form owes a publish`);
  }
});

test('a publication queue that fails after an acknowledged push keeps the save: it is reported with its binding, and the failure propagates', async () => {
  const boom = Object.assign(new Error('queue unavailable'), { code: 'QUEUE_DOWN' });
  const { spec, ctx, reports } = twoForms({ queue: () => { throw boom; } });
  await assert.rejects(runFormPageEmbeds(spec, ctx), (e) => e === boom && e.embeds !== undefined && e.embeds === reports[0], 'the queue failure propagates, carrying what was saved');
  assert.deepStrictEqual([reports.length, reports[0].saved.map((s) => s.key), reports[0].managedBindings.map((b) => b.key), reports[0].pendingPublish], [1, [KEY], [KEY], [{ kind: 'form', id: FORM }]]);
});

test('every form saved: one report, the same result shape as before, and no failure fields', async () => {
  const { spec, ctx, reports, SECOND_KEY } = twoForms();
  const result = await runFormPageEmbeds(spec, ctx);
  assert.strictEqual(reports.length, 1);
  assert.strictEqual(reports[0], result);
  assert.deepStrictEqual(Object.keys(result), ['saved', 'unchanged', 'pendingPublish', 'refused', 'unknown', 'managedBindings']);
  assert.deepStrictEqual([result.saved.map((s) => s.key), result.unknown, result.refused, result.pendingPublish.length, ctx.queued.length], [[KEY, SECOND_KEY], [], [], 2, 2]);
});

// A deployed Main form as FormXML: a field row, then the page's cell (control uniqueid `body`), and the UxAgentControl description of
// `forControl` naming `ref`. Every piece can be taken out or changed to make the form not show the page as declared.
const PANEL = guid(800);
function embedXml({ ref = PAGE, body = `{${PANEL}}`, forControl = `{${PANEL}}`, tab = 'tab_general', section = 'section_general', pageInput, refStatic = 'true', extraRows = '', twice = false, factors = ['2'] } = {}) {
  const panel = body === null ? '' : `<row><cell id="{${guid(801)}}"><control id="${guid(802)}" uniqueid="${body}" classid="{F9A8A302-114E-466A-B582-6771B2AE0D92}"/></cell></row>`;
  const again = twice ? `<row><cell><control id="${guid(803)}" uniqueid="{${guid(804)}}" classid="{F9A8A302-114E-466A-B582-6771B2AE0D92}"/></cell></row>` : '';
  const entry = (factor) => `<customControl name="MscrmControls.UxAgentControl" formFactor="${factor}"><parameters><RefId type="SingleLine.Text" static="${refStatic}">${ref}</RefId>${pageInput === undefined ? '' : `<PageInput type="SingleLine.Text" static="true">${pageInput}</PageInput>`}</parameters></customControl>`;
  const description = (id) => `<controlDescription forControl="${id}">${factors.map(entry).join('')}</controlDescription>`;
  return `<form><tabs><tab name="${tab}"><columns><column width="100%"><sections><section name="${section}" columns="1"><rows>`
    + `<row><cell><control id="new_name" datafieldname="new_name"/></cell></row>${extraRows}${panel}${again}<row><cell><control id="new_code" datafieldname="new_code"/></cell></row>`
    + `</rows></section></sections></column></columns></tab></tabs><controlDescriptions>${description(forControl)}${twice ? description(`{${guid(804)}}`) : ''}</controlDescriptions></form>`;
}

test('a form-placed page is verified by its embed on the form: the page, the place and the input the spec declares; a missing control, another page, an orphan description, another place or input is not', () => {
  const ok = { ok: true };
  const embed = { ...EMBED, after: 'new_name' };
  assert.deepStrictEqual(verifyFormPageEmbed(embedXml(), embed, PAGE), ok, 'the form shows the page where the spec puts it');
  assert.deepStrictEqual(verifyFormPageEmbed(embedXml({ ref: `{${PAGE.toUpperCase()}}`, factors: ['2', '0', '1'] }), EMBED, `{${PAGE}}`), ok, 'braces, case and every form factor are one page id');
  const input = { mode: 'compact', n: 2 };
  assert.deepStrictEqual(verifyFormPageEmbed(embedXml({ pageInput: '{&quot;data&quot;:{&quot;n&quot;:2,&quot;mode&quot;:&quot;compact&quot;}}' }), { ...embed, inputData: input }, PAGE), ok, 'the input the form hands the page, escaped as XML text');
  assert.deepStrictEqual(verifyFormPageEmbed(embedXml({ pageInput: '<![CDATA[{"data":{"mode":"compact","n":2}}]]>' }), { ...embed, inputData: input }, PAGE), ok, 'or in a CDATA section');

  const reason = (xml, e = embed, id = PAGE) => verifyFormPageEmbed(xml, e, id).reason;
  assert.strictEqual(reason(embedXml({ body: null })), 'not-embedded', 'no control on the form: the description alone is an orphan');
  assert.strictEqual(reason(embedXml({ forControl: `{${guid(899)}}` })), 'not-embedded', 'a description for a control that is not there');
  assert.strictEqual(reason(embedXml({ ref: OTHER_PAGE })), 'not-embedded', 'the control shows another page');
  assert.strictEqual(reason(embedXml({ refStatic: 'false' })), 'not-embedded', 'a page taken from a column is no declared page');
  assert.strictEqual(reason(embedXml({ factors: [] })), 'not-embedded', 'a description with no page control');
  assert.strictEqual(reason(embedXml({ twice: true, forControl: `{${PANEL}}` })), 'embedded-more-than-once');
  assert.strictEqual(reason(`<form><controlDescriptions><controlDescription forControl="{${PANEL}}"><customControl name="MscrmControls.UxAgentControl"><parameters><RefId static="true">${PAGE}</RefId></parameters></customControl><customControl name="MscrmControls.UxAgentControl"><parameters><RefId static="true">${OTHER_PAGE}</RefId></parameters></customControl></controlDescription></controlDescriptions><tabs><tab name="tab_general"><columns><column><sections><section name="section_general"><rows><row><cell><control uniqueid="{${PANEL}}" classid="{F9A8A302-114E-466A-B582-6771B2AE0D92}"/></cell></row></rows></section></sections></column></columns></tab></tabs></form>`, EMBED), 'binding-unsupported', 'form factors that disagree name no one page');
  assert.strictEqual(reason(embedXml({ tab: 'tab_other' })), 'placement-differs', 'another tab');
  assert.strictEqual(reason(embedXml({ section: 'section_other' })), 'placement-differs', 'another section');
  assert.strictEqual(reason(embedXml(), { ...EMBED, after: 'new_code' }), 'placement-differs', 'above the field it should follow');
  assert.strictEqual(reason(embedXml({ extraRows: '<row><cell><control id="new_area" datafieldname="new_area"/></cell></row>' })), 'placement-differs', 'another field between');
  assert.strictEqual(reason(embedXml(), { ...EMBED, after: 'new_gone' }), 'placement-differs', 'the field it should follow is not there');
  assert.strictEqual(reason(embedXml({ pageInput: '{"data":{"mode":"full"}}' }), { ...embed, inputData: { mode: 'compact' } }), 'input-differs');
  assert.strictEqual(reason(embedXml(), { ...embed, inputData: { mode: 'compact' } }), 'input-differs', 'an input the form does not hand over');
  assert.strictEqual(reason(embedXml({ pageInput: '{"data":{"mode":"full"}}' })), 'input-differs', 'an input the spec does not declare');
  for (const bad of [null, '', '<form><tabs>', 42]) assert.strictEqual(reason(bad), 'form-xml-unreadable', String(bad));
  // A place the embed does not ask for (no `after`) is the maker's: the cell may sit anywhere in its section.
  assert.deepStrictEqual(verifyFormPageEmbed(embedXml({ extraRows: '<row><cell><control id="new_area" datafieldname="new_area"/></cell></row>' }), EMBED, PAGE), ok);
});

test('the forms that embed a page are the ones whose genPages name it, by key in a schemaVersion 2 spec and by name before it', () => {
  const v2 = specWith({ genPages: [EMBED], placement: 'form', sitemap: false });
  assert.deepStrictEqual(formEmbedsOfPage(v2, v2.pages[0]).map(({ form, embed }) => [form.name, embed.key]), [['Main', 'summary']]);
  assert.deepStrictEqual(formEmbedsOfPage(v2, v2.pages[1]), [], 'a page no form embeds');
  const v1 = specWith({ genPages: [{ ...EMBED, page: 'Case Summary' }], schemaVersion: 1 });
  assert.deepStrictEqual(formEmbedsOfPage(v1, v1.pages[0]).map(({ embed }) => embed.key), ['summary']);
  assert.deepStrictEqual(formEmbedsOfPage(specWith({}), v2.pages[0]), [], 'no embeds at all');
});

test('REAL BUNDLE: the embed round-trips through the SDK — the port\'s ids persisted, spacer rows kept, retarget in place, missing page refused before any write', async () => {
  const pagesInEnv = new Set([PAGE]);
  const pageChecks = [];
  let losePatchAnswer = false;
  // The SDK checks that an embedded page exists before it writes the form (uxagentprojects RetrieveUnpublishedMultiple); the harness stub
  // stores forms only, so that one read is answered here from `pagesInEnv`.
  const createSdk = (options) => createMakerSdk({ ...options, httpClient: { ...options.httpClient,
    get: async (url) => {
      if (!/uxagentprojects/.test(url)) return options.httpClient.get(url);
      pageChecks.push(url);
      const id = (decodeURIComponent(url).match(/uxagentprojectid eq ([0-9a-f-]{36})/i) || [])[1];
      return { status: 200, headers: {}, body: { value: id && pagesInEnv.has(id.toLowerCase()) ? [{ uxagentprojectid: id }] : [] } };
    },
    // A PATCH that is stored but whose answer is lost on the way back.
    patch: async (url, body) => {
      const answer = await options.httpClient.patch(url, body);
      if (losePatchAnswer) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      return answer;
    },
  } });
  const h = createHarness({ formId: FORM, createSdk });
  const creates = createCreatesPortDouble();
  const bindings = new Map();
  try {
    await seedForm(h, [{ name: 'tab_general', label: 'General', columns: [{ sections: [{ name: 'section_general', label: 'General',
      rows: [{ cells: [{ control: { fieldName: 'new_name' } }] }, { cells: [{ control: { fieldName: 'new_code' } }] }] }] }] }]);
    const run = async (genPages, pages = { 'case-summary': PAGE }) => {
      const { sdk } = await h.freshSdk();
      const ctx = ctxFor(sdk, { pages, creates, bindings });
      const writes = h.writes.length;
      const result = await applyFormPageEmbeds(await planFormPageEmbeds(specWith({ genPages }), ctx), ctx);
      keep(ctx, result);
      return { result, writes: h.writes.slice(writes).map((w) => w.method) };
    };
    const readRows = async () => (await (await h.freshSdk()).sdk.fetchArtifact('form', FORM)).tabs[0].columns[0].sections[0].rows;
    const { fitsGrid } = require('../lib/form-occupancy.js');

    const first = await run([{ ...EMBED, after: 'new_name', inputData: { mode: 'compact' } }]);
    assert.deepStrictEqual(first.writes, ['patch'], 'one form write');
    let rows = await readRows();
    assert.deepStrictEqual(shape(rows), ['new_name', `P:${PAGE_ROWSPAN}`, '-', '-', '-', '-', '-', 'new_code'], 'the page block round-trips, empty rows included');
    assert.ok(fitsGrid(rows, 1), 'the saved section fits its grid');
    const placed = rows[1].cells[0];
    assert.deepStrictEqual(placed.control.genPage, { pageId: PAGE, inputData: { mode: 'compact' } });
    const reserved = creates.idsOf(KEY);
    assert.deepStrictEqual([placed.id, placed.control.id], [reserved.childIds.cell, reserved.childIds.control], 'the form persisted the ids the port allocated');
    assert.deepStrictEqual(placed.control.bag.a.find((p) => p[0] === 'uniqueid'), ['uniqueid', `{${reserved.id}}`]);
    const [binding] = first.result.managedBindings;
    assert.deepStrictEqual([binding.id, binding.cellId], [placed.control.id, placed.id], 'the ids the binding records are the ones the form persisted');
    assert.deepStrictEqual(verifyFormPageEmbed(h.store.row.formxml, { ...EMBED, after: 'new_name', inputData: { mode: 'compact' } }, PAGE), { ok: true }, 'the FormXML the SDK wrote is verified as the spec declares it');

    assert.deepStrictEqual((await run([{ ...EMBED, after: 'new_name', inputData: { mode: 'compact' } }])).writes, [], 'a rebuild with the same embed writes nothing');

    // The key now names another page: its cell is retargeted in place.
    pagesInEnv.add(OTHER_PAGE);
    const retargeted = await run([{ ...EMBED, page: 'case-notes', after: 'new_name', inputData: { mode: 'full' } }], { 'case-notes': OTHER_PAGE });
    assert.deepStrictEqual([retargeted.writes, retargeted.result.saved.map((s) => s.action)], [['patch'], ['update']]);
    rows = await readRows();
    assert.deepStrictEqual([rows[1].cells[0].id, rows[1].cells[0].control.id, rows[1].cells[0].control.genPage], [placed.id, placed.control.id, { pageId: OTHER_PAGE, inputData: { mode: 'full' } }]);
    assert.deepStrictEqual(shape(rows).filter((s) => s.includes(':')), ['Q:6'], 'one embed on the form, not two');
    const notesEmbed = { ...EMBED, page: 'case-notes', after: 'new_name', inputData: { mode: 'full' } };
    assert.deepStrictEqual([verifyFormPageEmbed(h.store.row.formxml, notesEmbed, OTHER_PAGE), verifyFormPageEmbed(h.store.row.formxml, { ...EMBED, after: 'new_name', inputData: { mode: 'compact' } }, PAGE)],
      [{ ok: true }, { ok: false, reason: 'not-embedded' }], 'the retargeted form shows the new page and no longer the old one');
    pagesInEnv.delete(OTHER_PAGE);

    // A page that is gone by push time is the SDK's own refusal, before any write, propagated as it came.
    const writesBefore = h.writes.length;
    await assert.rejects(run([{ key: 'other', page: 'case-summary', tab: 'tab_general', section: 'section_general' }, { ...EMBED, page: 'case-notes', after: 'new_name', inputData: { mode: 'full' } }, { key: 'third', page: 'case-third', tab: 'tab_general', section: 'section_general' }], { 'case-summary': PAGE, 'case-notes': OTHER_PAGE, 'case-third': guid(44) }),
      (e) => e.code === 'FORM_GENPAGE_TARGET_NOT_FOUND');
    assert.strictEqual(h.writes.length, writesBefore, 'the refused push wrote nothing');
    assert.ok(pageChecks.some((url) => url.includes(guid(44))), 'the refusal came from the SDK checking the page');

    // A PATCH whose answer is lost: the failure propagates, and nothing is reported saved.
    pagesInEnv.add(guid(44));
    losePatchAnswer = true;
    await assert.rejects(run([{ ...EMBED, page: 'case-notes', after: 'new_name', inputData: { mode: 'full' } }, { key: 'third', page: 'case-third', tab: 'tab_general', section: 'section_general' }], { 'case-notes': OTHER_PAGE, 'case-third': guid(44) }),
      (e) => /socket hang up/.test(e.message));
  } finally {
    h.cleanup();
  }
});

test('REAL BUNDLE: the build step embeds through the SDK with the build\'s page-id Map, and a page it has no id for halts it after the save is reported', async () => {
  const createSdk = (options) => createMakerSdk({ ...options, httpClient: { ...options.httpClient,
    get: async (url) => {
      if (!/uxagentprojects/.test(url)) return options.httpClient.get(url);
      const id = (decodeURIComponent(url).match(/uxagentprojectid eq ([0-9a-f-]{36})/i) || [])[1];
      return { status: 200, headers: {}, body: { value: id && id.toLowerCase() === PAGE ? [{ uxagentprojectid: id }] : [] } };
    },
  } });
  const h = createHarness({ formId: FORM, createSdk });
  try {
    await seedForm(h, [{ name: 'tab_general', label: 'General', columns: [{ sections: [{ name: 'section_general', label: 'General',
      rows: [{ cells: [{ control: { fieldName: 'new_name' } }] }, { cells: [{ control: { fieldName: 'new_code' } }] }] }] }] }]);
    const { sdk } = await h.freshSdk();
    const ctx = ctxFor(sdk);
    delete ctx.pageIdOf;
    const reports = [];
    const writes = h.writes.length;
    await assert.rejects(runFormPageEmbeds(specWith({ genPages: [{ ...EMBED, after: 'new_name' }, { key: 'notes', page: 'case-notes', tab: 'tab_general', section: 'section_general' }] }),
      { ...ctx, keyToId: new Map([['case-summary', PAGE]]), report: (r) => reports.push(r) }),
    (e) => e.code === 'form-page-embeds-incomplete' && e.notApplied.length === 1 && e.notApplied[0].key === NOTES_KEY && e.notApplied[0].reason === 'page-not-built');
    assert.deepStrictEqual(h.writes.slice(writes).map((w) => w.method), ['patch'], 'one form write, for the page that was built');
    const rows = (await (await h.freshSdk()).sdk.fetchArtifact('form', FORM)).tabs[0].columns[0].sections[0].rows;
    assert.deepStrictEqual(shape(rows), ['new_name', `P:${PAGE_ROWSPAN}`, '-', '-', '-', '-', '-', 'new_code']);
    assert.deepStrictEqual(reports[0].managedBindings.map((b) => [b.key, b.id]), [[KEY, rows[1].cells[0].control.id]]);
    assert.deepStrictEqual(ctx.queued.map((q) => [q.kind, q.id, q.table]), [['form', FORM, 'new_ticket']]);
  } finally {
    h.cleanup();
  }
});

test('REAL BUNDLE: the verifier sees a page on a form exactly where the SDK\'s typed projection does — an unbound page-control class, its RefId read as decoded text', async () => {
  const CLASS = 'F9A8A302-114E-466A-B582-6771B2AE0D92';
  const cases = [
    // [what, formxml, shows the page]
    ['an ordinary text control class', embedXml().replace(CLASS, '4273EDBD-AC1D-40d3-9FB2-095C621B552D'), false],
    ['a page-control class bound to a column', embedXml().replace(`id="${guid(802)}"`, `id="${guid(802)}" datafieldname="new_name"`), false],
    ['a control with no class', embedXml().replace(` classid="{${CLASS}}"`, ''), false],
    ['a description entry whose control name is cased otherwise', embedXml().replace('MscrmControls.UxAgentControl', 'mscrmcontrols.uxagentcontrol'), false],
    ['a RefId with one brace', embedXml({ ref: `{${PAGE}` }), false],
    ['a RefId in a CDATA section', embedXml({ ref: `<![CDATA[${PAGE}]]>` }), true],
    ['a RefId with a character reference', embedXml({ ref: `&#48;${PAGE.slice(1)}` }), true],
    ['a RefId with a hex character reference and a comment', embedXml({ ref: `&#x30;<!-- id -->${PAGE.slice(1)}` }), true],
    ['the class in lower case, an empty column binding', embedXml().replace(`{${CLASS}}`, CLASS.toLowerCase()).replace(`id="${guid(802)}"`, `id="${guid(802)}" datafieldname=""`), true],
    ['the page control as the SDK writes it', embedXml(), true],
  ];
  const h = createHarness({ formId: FORM });
  try {
    const seen = [];
    for (const [what, xml] of cases) {
      h.store.row.formxml = xml;
      const control = rowsOf(await (await h.freshSdk()).sdk.fetchArtifact('form', FORM))[1].cells[0].control;
      seen.push([what, Boolean(control.genPage && control.genPage.pageId === PAGE), verifyFormPageEmbed(xml, EMBED, PAGE).ok]);
    }
    assert.deepStrictEqual(seen.map(([what, projected]) => [what, projected]), cases.map(([what, , shows]) => [what, shows]), 'what the SDK projects');
    assert.deepStrictEqual(seen.map(([what, , verified]) => [what, verified]), cases.map(([what, , shows]) => [what, shows]), 'the verifier agrees with it');
  } finally {
    h.cleanup();
  }
});