'use strict';
// Generative pages embedded in a Main form (forms[].genPages, pages[].placement) — lib/form-page-embeds.js: the spec gate, the plan over a
// form as read, and the apply through the build's create journal. The last test runs the REAL vendored SDK against a stub that stores one
// systemform row, so the typed genPage binding, the ids the SDK allocates and its own missing-page refusal are the bundle's, not a fake's.
const test = require('node:test');
const assert = require('node:assert');
const { validateFormPageEmbeds, planFormPageEmbeds, applyFormPageEmbeds, requireEmbedsApplied, runFormPageEmbeds, PAGE_ROWSPAN } = require('../lib/form-page-embeds.js');
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

test('an add is sent under the ids the create port reserved, from inside the port, so intent is recorded before the push', async () => {
  const creates = createCreatesPortDouble();
  const atPush = [];
  const provision = fakeProvision(formArtifact([general(FIELD_ROWS())]), { onPush: () => {
    atPush.push([creates.stateOf('formPageEmbed', KEY), creates.stateOf('formPageEmbed', NOTES_KEY)]);
    return { type: 'form', id: FORM, saved: true };
  } });
  const ctx = ctxFor(provision, { creates });
  const spec = specWith({ genPages: [{ ...EMBED, inputData: { secretish: 'value-not-for-results' } }, { key: 'notes', page: 'case-notes', tab: 'tab_general', section: 'section_general', after: 'new_name' }] });
  const result = await applyFormPageEmbeds(await planFormPageEmbeds(spec, ctx), ctx);

  assert.deepStrictEqual(atPush, [['sending', 'sending']], 'both creates were recorded as being sent when the form push began');
  assert.deepStrictEqual([creates.stateOf('formPageEmbed', KEY), creates.stateOf('formPageEmbed', NOTES_KEY)], ['complete', 'complete'], 'and settled by the push answer');
  const sendRecord = (label) => creates.events.find((e) => e[0] === 'record' && e[1] === label && e[2] === 'sending')[3];
  for (const key of [KEY, NOTES_KEY]) {
    const reserved = sendRecord(key);
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

test('a push whose answer is lost leaves the creates unknown, and the next build neither re-adds blindly nor duplicates a landed embed', async () => {
  for (const landed of [false, true]) {
    const creates = createCreatesPortDouble();
    const provision = fakeProvision(formArtifact([general(FIELD_ROWS())]));
    let saved = clone(provision.current());
    provision.fetchArtifact = async (kind, id) => { provision.calls.push(['fetch', kind, id]); return clone(saved); };
    provision.pushArtifact = async () => {
      provision.calls.push(['push']);
      if (landed) saved = clone(provision.current());
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    };
    const ctx = ctxFor(provision, { creates });
    const spec = specWith({ genPages: [{ ...EMBED, after: 'new_name' }] });
    await assert.rejects(applyFormPageEmbeds(await planFormPageEmbeds(spec, ctx), ctx), (e) => e.code === 'ECONNRESET');
    assert.strictEqual(creates.stateOf('formPageEmbed', KEY), 'unknown', 'a push with no answer is an unknown outcome');
    assert.deepStrictEqual(ctx.queued, []);

    // The next build reads the form again.
    creates.newInvocation();
    const before = provision.calls.length;
    const next = ctxFor(provision, { creates });
    const plan = await planFormPageEmbeds(spec, next);
    if (landed) {
      // It landed: the page is on the form, found and kept — not added a second time.
      assert.deepStrictEqual(plan.operations.map((o) => o.action), ['none']);
      const result = await applyFormPageEmbeds(plan, next);
      assert.deepStrictEqual([result.saved, provision.calls.slice(before).map((c) => c[0])], [[], ['fetch']]);
    } else {
      // It did not (or not yet): the add is the port's to refuse until a maker settles what the lost send left behind.
      await assert.rejects(applyFormPageEmbeds(plan, next), (e) => e.code === 'CREATION_PENDING_UNKNOWN' && e.outcome === 'unknown');
      assert.deepStrictEqual(provision.calls.slice(before).map((c) => c[0]), ['fetch'], 'nothing edited, nothing pushed');
    }
  }
});

test('a push the SDK refuses before writing is a refusal to the create port, and the next build sends the same ids', async () => {
  const creates = createCreatesPortDouble();
  let refuse = true;
  const pushedIds = [];
  const provision = fakeProvision(formArtifact([general(FIELD_ROWS())]), { onPush: (current) => {
    pushedIds.push(rowsOf(current)[1].cells[0].control.id);
    if (refuse) throw Object.assign(new Error('Refusing to push the form: it embeds generative page(s) that do not exist in this environment.'), { code: 'FORM_GENPAGE_TARGET_NOT_FOUND' });
    return { type: 'form', id: FORM, saved: true };
  } });
  const ctx = ctxFor(provision, { creates });
  const spec = specWith({ genPages: [{ ...EMBED, after: 'new_name' }] });
  await assert.rejects(applyFormPageEmbeds(await planFormPageEmbeds(spec, ctx), ctx), (e) => e.code === 'FORM_GENPAGE_TARGET_NOT_FOUND');
  assert.strictEqual(creates.stateOf('formPageEmbed', KEY), 'refused', 'refused before any write, not unknown');

  refuse = false;
  creates.newInvocation();
  const fresh = fakeProvision(formArtifact([general(FIELD_ROWS())]), { onPush: (current) => { pushedIds.push(rowsOf(current)[1].cells[0].control.id); return { type: 'form', id: FORM, saved: true }; } });
  const next = ctxFor(fresh, { creates });
  const result = await applyFormPageEmbeds(await planFormPageEmbeds(spec, next), next);
  assert.deepStrictEqual(result.saved.map((s) => s.action), ['add']);
  assert.strictEqual(pushedIds[1], pushedIds[0], 'the retry sent the same reserved control id');
  assert.strictEqual(creates.stateOf('formPageEmbed', KEY), 'complete');
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

  // The cell a binding names is gone: the embed is added again, under the ids the port recorded for the key.
  const gone = fakeProvision(formArtifact([general(FIELD_ROWS())]));
  const again = ctxFor(gone, { creates: ctx.creates, bindings: ctx.bindings });
  result = await applyFormPageEmbeds(await planFormPageEmbeds(at('case-notes'), again), again);
  assert.deepStrictEqual(result.managedBindings.map((b) => [b.id, b.origin]), [[first.id, 'created']], 'the same control id as before');
  rows = rowsOf(gone.current());
  assert.strictEqual(rows[1].cells[0].control.id, first.id);
});

test('the apply refuses an add with no create port, a requested embed that is not applied halts the build, and refusals and unknowns write nothing', async () => {
  const provision = fakeProvision(formArtifact([general(FIELD_ROWS())]));
  const ctx = { ...ctxFor(provision), creates: undefined };
  const plan = await planFormPageEmbeds(specWith({ genPages: [EMBED] }), ctx);
  plan.operations.push({ key: 'k', kind: 'formPageEmbed', action: 'refuse', reason: 'page-embedded-elsewhere', target: plan.operations[0].target });
  plan.unknown.push({ key: 'u', kind: 'formPageEmbed', reason: 'page-not-built' });
  const result = await applyFormPageEmbeds(plan, ctx);
  assert.deepStrictEqual(result.refused.map((r) => r.reason), ['page-embedded-elsewhere', 'create-journal-unavailable']);
  assert.deepStrictEqual(result.unknown.map((u) => u.key), ['u']);
  assert.deepStrictEqual([result.saved, result.pendingPublish, ctx.queued], [[], [], []]);
  assert.deepStrictEqual(provision.calls.map((c) => c[0]), ['fetch'], 'no add, no push');

  assert.throws(() => requireEmbedsApplied(result), (e) => e.name === 'BuildHalt' && e.code === 'form-page-embeds-incomplete' && e.transient === false
    && JSON.stringify(e.notApplied) === JSON.stringify([
      { key: 'k', kind: 'formPageEmbed', reason: 'page-embedded-elsewhere', outcome: 'refused' },
      { key: KEY, kind: 'formPageEmbed', reason: 'create-journal-unavailable', outcome: 'refused' },
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
  assert.strictEqual(creates.stateOf('formPageEmbed', KEY), 'refused', 'a 412 is a complete answer that wrote nothing');
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

  // No create journal: nothing is written, and the build halts.
  const noJournal = fakeProvision(formArtifact([general(FIELD_ROWS())]));
  const ctx2 = stepCtx(noJournal, { creates: undefined });
  await assert.rejects(runFormPageEmbeds(specWith({ genPages: [EMBED] }), ctx2), (e) => halted(e, [[KEY, 'refused', 'create-journal-unavailable']]));
  assert.deepStrictEqual([noJournal.calls.map((c) => c[0]), ctx2.reports[0].managedBindings], [['fetch'], []]);

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

test('REAL BUNDLE: the embed round-trips through the SDK — reserved ids persisted, spacer rows kept, retarget in place, missing page refused before any write', async () => {
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
    const reserved = creates.events.find((e) => e[0] === 'record' && e[1] === KEY && e[2] === 'sending')[3];
    assert.deepStrictEqual([placed.id, placed.control.id], [reserved.childIds.cell, reserved.childIds.control], 'the form persisted the ids the port reserved');
    assert.deepStrictEqual(placed.control.bag.a.find((p) => p[0] === 'uniqueid'), ['uniqueid', `{${reserved.id}}`]);
    const [binding] = first.result.managedBindings;
    assert.deepStrictEqual([binding.id, binding.cellId], [placed.control.id, placed.id], 'the ids the binding records are the ones the form persisted');

    assert.deepStrictEqual((await run([{ ...EMBED, after: 'new_name', inputData: { mode: 'compact' } }])).writes, [], 'a rebuild with the same embed writes nothing');

    // The key now names another page: its cell is retargeted in place.
    pagesInEnv.add(OTHER_PAGE);
    const retargeted = await run([{ ...EMBED, page: 'case-notes', after: 'new_name', inputData: { mode: 'full' } }], { 'case-notes': OTHER_PAGE });
    assert.deepStrictEqual([retargeted.writes, retargeted.result.saved.map((s) => s.action)], [['patch'], ['update']]);
    rows = await readRows();
    assert.deepStrictEqual([rows[1].cells[0].id, rows[1].cells[0].control.id, rows[1].cells[0].control.genPage], [placed.id, placed.control.id, { pageId: OTHER_PAGE, inputData: { mode: 'full' } }]);
    assert.deepStrictEqual(shape(rows).filter((s) => s.includes(':')), ['Q:6'], 'one embed on the form, not two');
    pagesInEnv.delete(OTHER_PAGE);

    // A page that is gone by push time is the SDK's own refusal, before any write — a refusal to the create port, not an unknown.
    const writesBefore = h.writes.length;
    await assert.rejects(run([{ key: 'other', page: 'case-summary', tab: 'tab_general', section: 'section_general' }, { ...EMBED, page: 'case-notes', after: 'new_name', inputData: { mode: 'full' } }, { key: 'third', page: 'case-third', tab: 'tab_general', section: 'section_general' }], { 'case-summary': PAGE, 'case-notes': OTHER_PAGE, 'case-third': guid(44) }),
      (e) => e.code === 'FORM_GENPAGE_TARGET_NOT_FOUND');
    assert.strictEqual(h.writes.length, writesBefore, 'the refused push wrote nothing');
    assert.strictEqual(creates.stateOf('formPageEmbed', 'new_ticket|Main|Main#third'), 'refused');
    assert.ok(pageChecks.some((url) => url.includes(guid(44))), 'the refusal came from the SDK checking the page');

    // A PATCH whose answer is lost: the create is unknown, never "created".
    creates.newInvocation();
    pagesInEnv.add(guid(44));
    losePatchAnswer = true;
    await assert.rejects(run([{ ...EMBED, page: 'case-notes', after: 'new_name', inputData: { mode: 'full' } }, { key: 'third', page: 'case-third', tab: 'tab_general', section: 'section_general' }], { 'case-notes': OTHER_PAGE, 'case-third': guid(44) }));
    assert.strictEqual(creates.stateOf('formPageEmbed', 'new_ticket|Main|Main#third'), 'unknown');
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
