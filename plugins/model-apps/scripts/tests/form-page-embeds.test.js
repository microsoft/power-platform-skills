'use strict';
// Generative pages embedded in a Main form (forms[].genPages, pages[].placement) — lib/form-page-embeds.js: the spec gate, the plan over a
// form as read, and the apply through the build's create journal. The last test runs the REAL vendored SDK against a stub that stores one
// systemform row, so the typed genPage binding, the ids the SDK allocates and its own missing-page refusal are the bundle's, not a fake's.
const test = require('node:test');
const assert = require('node:assert');
const { validateFormPageEmbeds, planFormPageEmbeds, applyFormPageEmbeds } = require('../lib/form-page-embeds.js');
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
const cell = (control, id) => ({ id: `cell-${id}`, control: { id: `ctl-${id}`, ...control } });
function formArtifact(sections) {
  return { id: FORM, tabs: [{ name: 'tab_general', columns: sections.map((s) => ({ sections: [s] })) }] };
}
function fakeProvision(artifact) {
  const calls = [];
  let current = clone(artifact);
  return {
    calls,
    current: () => current,
    fetchArtifact: async (kind, id) => { calls.push(['fetch', kind, id]); return clone(current); },
    getArtifact: async () => clone(current),
    addElement: async (kind, id, pointer, element, opts) => {
      calls.push(['add', pointer, opts.position.index, clone(element)]);
      const rows = pointer.split('/').slice(1).reduce((n, p) => n[p], current);
      const n = calls.length;
      rows.splice(opts.position.index, 0, { cells: element.cells.map((c) => ({ id: `new-cell-${n}`, control: { id: `new-ctl-${n}`, ...c.control } })) });
    },
    updateElement: async (kind, id, pointer, value) => {
      calls.push(['update', pointer, clone(value)]);
      const parts = pointer.split('/').slice(1);
      const last = parts.pop();
      parts.reduce((n, p) => n[p], current)[last] = clone(value);
    },
    pushArtifact: async (kind, id) => { calls.push(['push', kind, id]); return { type: kind, id, saved: true }; },
  };
}
const ctxFor = (provision, { formId = FORM, pages = { 'case-summary': PAGE, 'case-notes': OTHER_PAGE } } = {}) => {
  const runs = [];
  const queued = [];
  return {
    runs, queued, provision,
    formIdOf: async () => formId,
    pageIdOf: async (ref) => pages[ref] || null,
    creates: { run: async (desc, execute) => { runs.push(desc); return execute(); } },
    publication: { queue: (target) => queued.push(target) },
    warn: () => {},
  };
};
const general = (rows) => ({ name: 'section_general', rows });
const FIELD_ROWS = () => [{ cells: [cell({ fieldName: 'new_name' }, 'name')] }, { cells: [cell({ fieldName: 'new_code' }, 'code')] }];

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
  assert.deepStrictEqual({ action: add.action, pointer: add.pointer, index: add.index, element: add.element, destructive: add.destructive, publicationScopes: add.publicationScopes },
    { action: 'add', pointer: '/tabs/0/columns/0/sections/0/rows', index: 1, element: { cells: [{ control: { genPage: { pageId: PAGE, inputData: { mode: 'compact' } } } }] }, destructive: false, publicationScopes: [`form:${FORM}`] });
  assert.deepStrictEqual(provision.calls.map((c) => c[0]), ['fetch'], 'a plan only reads');
  // Without `after` the new row goes at the end of the section.
  const appended = await planFormPageEmbeds(specWith({ genPages: [EMBED] }), ctxFor(fakeProvision(formArtifact([general(FIELD_ROWS())]))));
  assert.strictEqual(appended.operations[0].index, 2);

  const embedded = (inputData, id = 'emb') => ({ cells: [cell({ classId: 'F9A8A302-114E-466A-B582-6771B2AE0D92', genPage: { pageId: PAGE.toUpperCase(), ...(inputData ? { inputData } : {}) } }, id)] });
  ({ plan } = await planOf([general([...FIELD_ROWS(), embedded({ mode: 'compact' })])]));
  assert.deepStrictEqual(plan.operations.map((o) => [o.action, o.cellId, o.controlId]), [['none', 'cell-emb', 'ctl-emb']], 'the same page and input is already there (page ids compare case-insensitively)');

  ({ plan } = await planOf([general([...FIELD_ROWS(), embedded({ mode: 'full' })])]));
  assert.deepStrictEqual(plan.operations.map((o) => [o.action, o.pointer, o.value]),
    [['update', '/tabs/0/columns/0/sections/0/rows/2/cells/0/control/genPage', { pageId: PAGE.toUpperCase(), inputData: { mode: 'compact' } }]],
    'a changed input edits the typed binding in place, keeping the page id the form holds');

  const refusedFor = async (sections, embed = { ...EMBED, after: 'new_name' }) => (await planFormPageEmbeds(specWith({ genPages: [embed] }), ctxFor(fakeProvision(formArtifact(sections))))).operations.map((o) => [o.action, o.reason]);
  assert.deepStrictEqual(await refusedFor([general(FIELD_ROWS()), { name: 'section_side', rows: [embedded(undefined)] }]), [['refuse', 'page-embedded-elsewhere']]);
  assert.deepStrictEqual(await refusedFor([general([embedded(undefined, 'a'), embedded(undefined, 'b')])]), [['refuse', 'page-embedded-more-than-once']]);
  assert.deepStrictEqual(await refusedFor([general(FIELD_ROWS())], { ...EMBED, after: 'new_missing' }), [['refuse', 'after-field-not-found']]);
  assert.deepStrictEqual(await refusedFor([{ name: 'section_side', rows: [] }]), [['refuse', 'section-not-found']]);
  assert.deepStrictEqual(await refusedFor([general([]), general([])]), [['refuse', 'section-ambiguous']]);

  // A form or a page the build has no id for is unknown — and an unbuilt form is not even read.
  ({ plan, provision } = await planOf([general(FIELD_ROWS())], { formId: null }));
  assert.deepStrictEqual([plan.operations, plan.unknown.map((u) => u.reason), provision.calls], [[], ['form-not-built'], []]);
  ({ plan } = await planOf([general(FIELD_ROWS())], { pages: {} }));
  assert.deepStrictEqual([plan.operations, plan.unknown.map((u) => u.reason)], [[], ['page-not-built']]);
});

test('the apply adds through the create journal, pushes each changed form once, queues its publication, and reports no values', async () => {
  const spec = specWith({ genPages: [{ ...EMBED, inputData: { secretish: 'value-not-for-results' } }, { key: 'notes', page: 'case-notes', tab: 'tab_general', section: 'section_general', after: 'new_name' }] });
  const foreign = cell({ fieldName: 'new_code', bag: { a: [['x', 'kept']] } }, 'code');
  const provision = fakeProvision(formArtifact([general([{ cells: [cell({ fieldName: 'new_name' }, 'name')] }, { cells: [foreign] }])]));
  const ctx = ctxFor(provision);
  const plan = await planFormPageEmbeds(spec, ctx);
  const result = await applyFormPageEmbeds(plan, ctx);

  assert.deepStrictEqual(provision.calls.map((c) => c.slice(0, 3)), [['fetch', 'form', FORM], ['add', '/tabs/0/columns/0/sections/0/rows', 2], ['add', '/tabs/0/columns/0/sections/0/rows', 1], ['push', 'form', FORM]],
    'the later row first, so the earlier insert does not move it; one push');
  const rows = provision.current().tabs[0].columns[0].sections[0].rows;
  assert.deepStrictEqual(rows.map((r) => r.cells[0].control.fieldName || r.cells[0].control.genPage.pageId), ['new_name', OTHER_PAGE, 'new_code', PAGE]);
  assert.deepStrictEqual(rows[2].cells[0], foreign, 'a foreign control is untouched');
  assert.deepStrictEqual(ctx.runs.map((r) => [r.kind, r.key, r.childKeys]), [['formPageEmbed', 'new_ticket|Main|Main#summary', ['cell', 'control']], ['formPageEmbed', 'new_ticket|Main|Main#notes', ['cell', 'control']]]);
  assert.deepStrictEqual(ctx.queued, [{ kind: 'form', id: FORM }]);
  assert.deepStrictEqual(result.pendingPublish, [{ kind: 'form', id: FORM }]);
  assert.deepStrictEqual(result.saved.map((s) => [s.key, s.action, s.id]).sort(), [['new_ticket|Main|Main#notes', 'add', 'new-ctl-3'], ['new_ticket|Main|Main#summary', 'add', 'new-ctl-2']]);
  assert.deepStrictEqual(result.managedBindings.map((b) => [b.key, b.id, b.cellId, b.parentKey, b.pageId, b.origin, /^[0-9a-f]{64}$/.test(b.intentSha256)]).sort(),
    [['new_ticket|Main|Main#notes', 'new-ctl-3', 'new-cell-3', 'new_ticket|Main|Main', OTHER_PAGE, 'created', true], ['new_ticket|Main|Main#summary', 'new-ctl-2', 'new-cell-2', 'new_ticket|Main|Main', PAGE, 'created', true]]);
  assert.deepStrictEqual([result.refused, result.unknown, result.unchanged], [[], [], []]);
  assert.doesNotMatch(JSON.stringify(result), /value-not-for-results/, 'a result carries no input value');

  // Re-planned against what it wrote: nothing to do, and nothing is written or published.
  const again = await planFormPageEmbeds(spec, ctx);
  const before = provision.calls.length;
  const second = await applyFormPageEmbeds(again, ctx);
  assert.deepStrictEqual([second.saved, second.pendingPublish, second.unchanged.map((u) => u.id).sort()], [[], [], ['new-ctl-2', 'new-ctl-3']]);
  assert.deepStrictEqual(provision.calls.slice(before).map((c) => c[0]), []);
  assert.deepStrictEqual(ctx.queued.length, 1);
});

test('the apply refuses an add with no create journal, and refusals and unknowns write nothing', async () => {
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
});

test('a push that fails by value halts like every other form push, before publication is queued', async () => {
  const provision = fakeProvision(formArtifact([general(FIELD_ROWS())]));
  provision.pushArtifact = async () => ({ type: 'form', id: FORM, saved: false, error: { code: 'VERSION_CONFLICT', message: '412' } });
  const ctx = ctxFor(provision);
  const plan = await planFormPageEmbeds(specWith({ genPages: [EMBED] }), ctx);
  await assert.rejects(applyFormPageEmbeds(plan, ctx), (e) => e.code === 'version-conflict');
  assert.deepStrictEqual(ctx.queued, []);
});

test('REAL BUNDLE: the embed round-trips through the SDK — typed binding, allocated ids kept, input edited in place, missing page refused before any write', async () => {
  const pagesInEnv = new Set([PAGE]);
  const pageChecks = [];
  // The SDK checks that an embedded page exists before it writes the form (uxagentprojects RetrieveUnpublishedMultiple); the harness stub
  // stores forms only, so that one read is answered here from `pagesInEnv`.
  const createSdk = (options) => createMakerSdk({ ...options, httpClient: { ...options.httpClient, get: async (url) => {
    if (!/uxagentprojects/.test(url)) return options.httpClient.get(url);
    pageChecks.push(url);
    const id = (decodeURIComponent(url).match(/uxagentprojectid eq ([0-9a-f-]{36})/i) || [])[1];
    return { status: 200, headers: {}, body: { value: id && pagesInEnv.has(id.toLowerCase()) ? [{ uxagentprojectid: id }] : [] } };
  } } });
  const h = createHarness({ formId: FORM, createSdk });
  try {
    await seedForm(h, [{ name: 'tab_general', label: 'General', columns: [{ sections: [{ name: 'section_general', label: 'General',
      rows: [{ cells: [{ control: { fieldName: 'new_name' } }] }, { cells: [{ control: { fieldName: 'new_code' } }] }] }] }] }]);
    const run = async (genPages, pages = { 'case-summary': PAGE }) => {
      const { sdk } = await h.freshSdk();
      const ctx = ctxFor(sdk, { pages });
      const writes = h.writes.length;
      const result = await applyFormPageEmbeds(await planFormPageEmbeds(specWith({ genPages }), ctx), ctx);
      return { result, writes: h.writes.slice(writes).map((w) => w.method) };
    };
    const readRows = async () => (await (await h.freshSdk()).sdk.fetchArtifact('form', FORM)).tabs[0].columns[0].sections[0].rows;

    const first = await run([{ ...EMBED, after: 'new_name', inputData: { mode: 'compact' } }]);
    assert.deepStrictEqual(first.writes, ['patch'], 'one form write');
    let rows = await readRows();
    const placed = rows[1].cells[0];
    assert.deepStrictEqual(placed.control.genPage, { pageId: PAGE, inputData: { mode: 'compact' } });
    assert.strictEqual(rows[2].cells[0].control.fieldName, 'new_code');
    const [binding] = first.result.managedBindings;
    assert.deepStrictEqual([binding.id, binding.cellId], [placed.control.id, placed.id], 'the ids the binding records are the ones the form persisted');

    assert.deepStrictEqual((await run([{ ...EMBED, after: 'new_name', inputData: { mode: 'compact' } }])).writes, [], 'a rebuild with the same embed writes nothing');

    const edited = await run([{ ...EMBED, after: 'new_name', inputData: { mode: 'full' } }]);
    assert.deepStrictEqual([edited.writes, edited.result.saved.map((s) => s.action)], [['patch'], ['update']]);
    rows = await readRows();
    assert.deepStrictEqual([rows[1].cells[0].id, rows[1].cells[0].control.id, rows[1].cells[0].control.genPage], [placed.id, placed.control.id, { pageId: PAGE, inputData: { mode: 'full' } }]);

    // A page the build has no id for is unknown and nothing is written; a page that is gone by push time is the SDK's own refusal.
    const unbuilt = await run([{ ...EMBED, after: 'new_name', inputData: { mode: 'full' } }, { key: 'other', page: 'case-notes', tab: 'tab_general', section: 'section_general' }]);
    assert.deepStrictEqual([unbuilt.writes, unbuilt.result.unknown.map((u) => u.reason)], [[], ['page-not-built']]);
    const writesBefore = h.writes.length;
    await assert.rejects(run([{ ...EMBED, after: 'new_name', inputData: { mode: 'full' } }, { key: 'other', page: 'case-notes', tab: 'tab_general', section: 'section_general' }], { 'case-summary': PAGE, 'case-notes': OTHER_PAGE }),
      (e) => e.code === 'FORM_GENPAGE_TARGET_NOT_FOUND');
    assert.strictEqual(h.writes.length, writesBefore, 'the refused push wrote nothing');
    assert.strictEqual((await readRows()).length, 3);
    assert.ok(pageChecks.some((url) => url.includes(OTHER_PAGE)), 'the refusal came from the SDK checking the page');
  } finally {
    h.cleanup();
  }
});
