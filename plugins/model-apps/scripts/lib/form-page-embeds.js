'use strict';
// Generative pages embedded in a Main form: `forms[].genPages` in an App Spec, built as form cells whose control carries the SDK's typed
// `genPage` binding — `cell.control.genPage = { pageId, inputData? }` (types/form.ts, FormControl.genPage). The SDK owns the rest of that
// control (class id, label, row span) and refuses a push whose embedded page is not in the environment (FORM_GENPAGE_TARGET_NOT_FOUND),
// so a form can never be saved pointing at a page that is not there.
//
// Spec shape:
//   pages:  [{ key: 'case-summary', placement: 'form', ... }]          placement 'sitemap' (the default) | 'form'
//   forms:  [{ entity: 'incident', name: 'Case', genPages: [
//             { key: 'summary', page: 'case-summary', tab: 'general', section: 'details', after: 'title', inputData: { mode: 'compact' } } ] }]
//
// The three roles follow the feature-helper contract every build feature uses:
//   validateFormPageEmbeds(spec)      -> { errors, warnings }               pure, no service
//   planFormPageEmbeds(spec, ctx)     -> { operations, unknown }            reads the forms, writes nothing
//   applyFormPageEmbeds(plan, ctx)    -> { saved, unchanged, pendingPublish, refused, unknown, managedBindings }
// The plan runs after the pages phase has created the pages, because an embed names a page by its id. Ownership of the PAGE stays with
// the page's own create receipt; an embed is a reference to it, which is why deleting an embedded page is refused (page-reference-guard.js).
// A result names keys, ids and codes only — never a value, a token or a raw error.
const { sha256 } = require('./hash.js');
const { stableStringify } = require('./phase-diff.js');
const { isPlainJson } = require('./page-content.js');

const EMBED_KEYS = ['key', 'page', 'tab', 'section', 'after', 'inputData'];
const PLACEMENTS = ['sitemap', 'form'];
const OPERATION_KIND = 'formPageEmbed';

const lower = (v) => String(v).toLowerCase();
const isText = (v) => typeof v === 'string' && v.trim() !== '';
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const formTypeOf = (f) => (f && f.formType) || 'Main';
const formLabel = (f) => `form '${(f && (f.name || f.entity)) || '?'}'`;
const pageRefOf = (spec, p) => ((spec.schemaVersion || 0) >= 2 ? p && p.key : p && p.name);
// app-spec.js is asked lazily: its spec gate calls validateFormPageEmbeds, so a top-level require here would be a cycle.
const appSpec = () => require('./app-spec.js');

// The page references the sitemap holds (appShell.areas[].groups[].subAreas[].page) — a key in a schemaVersion 2 spec, a name before it.
function sitemapPageRefs(spec) {
  const refs = new Set();
  for (const area of (spec.appShell && Array.isArray(spec.appShell.areas) ? spec.appShell.areas : [])) {
    for (const group of (area && Array.isArray(area.groups) ? area.groups : [])) {
      for (const sub of (group && Array.isArray(group.subAreas) ? group.subAreas : [])) if (sub && isText(sub.page)) refs.add(sub.page);
    }
  }
  return refs;
}

// Where a tab/section pair lands on the form the spec describes, by the names the build gives it (formLayoutNames: the authored name, else
// the generated one, lower-cased). A section name may legally repeat across a tab's form-columns, and then "section X" names no one place.
function resolveSpecSection(layout, tab, section) {
  const tabs = layout.filter((t) => t.name === lower(tab));
  if (tabs.length !== 1) return tabs.length ? 'ambiguous-tab' : 'no-tab';
  const hits = tabs[0].columns.reduce((n, col) => n + col.sections.filter((s) => s === lower(section)).length, 0);
  return hits === 1 ? 'ok' : hits ? 'ambiguous-section' : 'no-section';
}

function validateFormPageEmbeds(spec) {
  const errors = [];
  const warnings = [];
  if (!spec || typeof spec !== 'object') return { errors, warnings };
  const pages = Array.isArray(spec.pages) ? spec.pages : [];
  const forms = Array.isArray(spec.forms) ? spec.forms : [];
  const declared = new Set(pages.map((p) => pageRefOf(spec, p)).filter(isText));
  const embedded = new Set();

  for (const p of pages) {
    if (p && p.placement !== undefined && !PLACEMENTS.includes(p.placement)) {
      errors.push(`page '${pageRefOf(spec, p) || '?'}': placement must be one of ${PLACEMENTS.join(', ')} (got ${JSON.stringify(p.placement)})`);
    }
  }

  for (const f of forms) {
    if (!f || f.genPages === undefined) continue;
    const label = formLabel(f);
    if (!Array.isArray(f.genPages)) { errors.push(`${label}: genPages must be an array`); continue; }
    if (f.genPages.length && formTypeOf(f) !== 'Main') {
      // The SDK refuses a genPage control on any other form type (genpage-embed-main-form-only); say so before a build gets there.
      errors.push(`${label}: genPages is allowed on a Main form only (this form is ${formTypeOf(f)})`);
      continue;
    }
    const layout = appSpec().formLayoutNames(f);
    const keys = new Set();
    const pagesHere = new Set();
    f.genPages.forEach((e, i) => {
      if (!isObject(e)) { errors.push(`${label}: genPages[${i}] must be an object`); return; }
      const at = `${label} genPages[${i}]${isText(e.key) ? ` '${e.key}'` : ''}`;
      for (const k of Object.keys(e)) if (!EMBED_KEYS.includes(k)) errors.push(`${at}: unknown key '${k}' (the keys are ${EMBED_KEYS.join(', ')})`);
      if (!isText(e.key)) errors.push(`${at}: key must be a non-empty string`);
      else if (keys.has(e.key)) errors.push(`${at}: duplicate key '${e.key}' in this form`);
      else keys.add(e.key);
      if (!isText(e.page)) errors.push(`${at}: page must name a declared page`);
      else if (!declared.has(e.page)) errors.push(`${at}: page '${e.page}' is not declared in pages[]`);
      else if (pagesHere.has(e.page)) errors.push(`${at}: page '${e.page}' is embedded twice in this form`);
      else { pagesHere.add(e.page); embedded.add(e.page); }
      if (!isText(e.tab) || !isText(e.section)) errors.push(`${at}: tab and section are both required`);
      else {
        const where = resolveSpecSection(layout, e.tab, e.section);
        if (where === 'no-tab') errors.push(`${at}: tab '${e.tab}' is not on this form`);
        else if (where === 'ambiguous-tab') errors.push(`${at}: tab '${e.tab}' names more than one tab on this form`);
        else if (where === 'no-section') errors.push(`${at}: section '${e.section}' is not in tab '${e.tab}'`);
        else if (where === 'ambiguous-section') errors.push(`${at}: section '${e.section}' names more than one section in tab '${e.tab}' — give the sections distinct names`);
      }
      if (e.after !== undefined && !isText(e.after)) errors.push(`${at}: after must name a field (a column logical name)`);
      // inputData is stored in the form as static JSON and handed to the page as its input; it is never evaluated, so only JSON's own values fit.
      if (e.inputData !== undefined && !(isObject(e.inputData) && isPlainJson(e.inputData))) errors.push(`${at}: inputData must be a JSON object`);
    });
  }

  // A form-only page has no other way in: it must be embedded somewhere, and the sitemap must not also link it (that is placement 'sitemap').
  const inSitemap = sitemapPageRefs(spec);
  for (const p of pages) {
    if (!p || p.placement !== 'form') continue;
    const ref = pageRefOf(spec, p);
    if (!embedded.has(ref)) errors.push(`page '${ref}': placement is 'form' but no form's genPages embeds it`);
    if (inSitemap.has(ref)) errors.push(`page '${ref}': placement is 'form' but the sitemap links it — use placement 'sitemap' for a page in both`);
  }
  return { errors, warnings };
}

// Every cell of a form artifact (tabs[].columns[].sections[].rows[].cells[]) with its JSON pointer.
function* cellsOf(artifact) {
  const tabs = (artifact && Array.isArray(artifact.tabs)) ? artifact.tabs : [];
  for (let t = 0; t < tabs.length; t++) {
    const cols = Array.isArray(tabs[t] && tabs[t].columns) ? tabs[t].columns : [];
    for (let c = 0; c < cols.length; c++) {
      const secs = Array.isArray(cols[c] && cols[c].sections) ? cols[c].sections : [];
      for (let s = 0; s < secs.length; s++) {
        const rows = Array.isArray(secs[s] && secs[s].rows) ? secs[s].rows : [];
        for (let r = 0; r < rows.length; r++) {
          const cells = Array.isArray(rows[r] && rows[r].cells) ? rows[r].cells : [];
          for (let k = 0; k < cells.length; k++) {
            yield { cell: cells[k], sectionPointer: `/tabs/${t}/columns/${c}/sections/${s}`, rowIndex: r, pointer: `/tabs/${t}/columns/${c}/sections/${s}/rows/${r}/cells/${k}` };
          }
        }
      }
    }
  }
}

// The sections of the live form named `section` inside the tab named `tab`, by the names the form carries (case-insensitive).
function liveSections(artifact, tab, section) {
  const found = [];
  const tabs = (artifact && Array.isArray(artifact.tabs)) ? artifact.tabs : [];
  tabs.forEach((t, ti) => {
    if (!t || lower(t.name) !== lower(tab)) return;
    (Array.isArray(t.columns) ? t.columns : []).forEach((col, ci) => {
      (Array.isArray(col && col.sections) ? col.sections : []).forEach((s, si) => {
        if (s && lower(s.name) === lower(section)) found.push({ pointer: `/tabs/${ti}/columns/${ci}/sections/${si}`, section: s });
      });
    });
  });
  return found;
}

const genPageOf = (cell) => (cell && cell.control && isObject(cell.control.genPage) ? cell.control.genPage : null);
const samePage = (a, b) => isText(a) && isText(b) && lower(a) === lower(b);
const inputHash = (v) => stableStringify(v === undefined ? null : v);

// What the embed means, hashed: the form, the page, where it sits and what it is given. A change of any of them is a new intent.
function intentOf(f, e) {
  return sha256(`form-page-embed/1\n${stableStringify({ form: appSpec().formIdentityKey(f), key: e.key, page: e.page, tab: lower(e.tab), section: lower(e.section), after: e.after === undefined ? null : lower(e.after), inputData: e.inputData === undefined ? null : e.inputData })}`);
}

// ctx: { formIdOf(formSpec) -> id|null, pageIdOf(pageRef) -> id|null, provision: { fetchArtifact } }. A form or a page this build has
// not (yet) got an id for is UNKNOWN, not refused: nothing can be said about an embed whose ends are not there.
async function planFormPageEmbeds(spec, ctx) {
  const operations = [];
  const unknown = [];
  const forms = (spec && Array.isArray(spec.forms)) ? spec.forms : [];
  for (const f of forms) {
    if (!f || !Array.isArray(f.genPages) || !f.genPages.length) continue;
    const formKey = appSpec().formIdentityKey(f);
    const formId = await ctx.formIdOf(f);
    if (!formId) {
      for (const e of f.genPages) unknown.push({ key: `${formKey}#${e.key}`, kind: OPERATION_KIND, reason: 'form-not-built' });
      continue;
    }
    // A fresh read: placement and the "already embedded?" answer must be about the form as it is now, not a workspace copy.
    const artifact = await ctx.provision.fetchArtifact('form', formId);
    for (const e of f.genPages) {
      const key = `${formKey}#${e.key}`;
      const pageId = await ctx.pageIdOf(e.page);
      if (!pageId) { unknown.push({ key, kind: OPERATION_KIND, reason: 'page-not-built' }); continue; }
      const base = { key, kind: OPERATION_KIND, destructive: false, publicationScopes: [`form:${formId}`],
        target: { formId, formKey, embedKey: e.key, pageKey: e.page, pageId }, intentSha256: intentOf(f, e), preconditions: { pageExists: pageId } };
      const refuse = (reason) => operations.push({ ...base, action: 'refuse', reason });
      const sections = liveSections(artifact, e.tab, e.section);
      if (sections.length !== 1) { refuse(sections.length ? 'section-ambiguous' : 'section-not-found'); continue; }
      const [target] = sections;
      // Every cell already bound to this page, anywhere on the form. Foreign controls are only ever read here.
      const existing = [...cellsOf(artifact)].filter((x) => samePage(genPageOf(x.cell) && genPageOf(x.cell).pageId, pageId));
      if (existing.length > 1) { refuse('page-embedded-more-than-once'); continue; }
      if (existing.length === 1) {
        const [hit] = existing;
        // Moving a cell someone placed elsewhere is a layout change this feature does not own; say so instead of relocating it.
        if (hit.sectionPointer !== target.pointer) { refuse('page-embedded-elsewhere'); continue; }
        const current = genPageOf(hit.cell);
        const ids = { cellId: hit.cell.id || null, controlId: (hit.cell.control && hit.cell.control.id) || null };
        if (inputHash(current.inputData) === inputHash(e.inputData)) { operations.push({ ...base, action: 'none', ...ids }); continue; }
        // The typed binding is edited in place — the page id the form holds, with the new input — so the cell, its ids and its bag stay.
        operations.push({ ...base, action: 'update', ...ids, pointer: `${hit.pointer}/control/genPage`,
          value: { pageId: current.pageId, ...(e.inputData !== undefined ? { inputData: e.inputData } : {}) } });
        continue;
      }
      const rows = Array.isArray(target.section.rows) ? target.section.rows : [];
      let index = rows.length;
      if (e.after !== undefined) {
        const row = rows.findIndex((r) => (Array.isArray(r && r.cells) ? r.cells : []).some((c) => c && c.control && isText(c.control.fieldName) && lower(c.control.fieldName) === lower(e.after)));
        if (row < 0) { refuse('after-field-not-found'); continue; }
        index = row + 1;
      }
      operations.push({ ...base, action: 'add', pointer: `${target.pointer}/rows`, index,
        element: { cells: [{ control: { genPage: { pageId, ...(e.inputData !== undefined ? { inputData: e.inputData } : {}) } } }] } });
    }
  }
  return { operations, unknown };
}

// The cell and control ids the SDK allocated for the row added at `pointer`[index] — read back from the workspace copy so the binding
// records the ids the push will persist (a later rebuild finds the cell by them, not by position).
async function allocatedIds(ctx, formId, pointer, index) {
  const art = await ctx.provision.getArtifact('form', formId);
  const rows = pointer.split('/').slice(1).reduce((node, part) => (node == null ? node : node[part]), art);
  const cell = Array.isArray(rows) && rows[index] && Array.isArray(rows[index].cells) ? rows[index].cells[0] : null;
  return { cellId: (cell && cell.id) || null, controlId: (cell && cell.control && cell.control.id) || null };
}

// ctx: { provision: { addElement, updateElement, getArtifact, pushArtifact }, creates: { run }, publication: { queue }, warn }.
// An add goes through ctx.creates.run (the build's create journal), so this feature keeps no journal of its own. One push per changed form;
// a push that fails by value halts the build the way every other form push does (requireSuccessfulPush), and a thrown SDK refusal —
// FORM_GENPAGE_TARGET_NOT_FOUND when the page went away between plan and push — propagates unchanged.
async function applyFormPageEmbeds(plan, ctx) {
  const result = { saved: [], unchanged: [], pendingPublish: [], refused: [], unknown: [...((plan && plan.unknown) || [])], managedBindings: [] };
  const byForm = new Map();
  for (const op of (plan && plan.operations) || []) {
    if (op.action === 'refuse') { result.refused.push({ key: op.key, kind: op.kind, reason: op.reason }); continue; }
    if (op.action === 'none') {
      result.unchanged.push({ key: op.key, kind: op.kind, id: op.controlId });
      result.managedBindings.push(bindingOf(op, op, 'adopted'));
      continue;
    }
    if (!byForm.has(op.target.formId)) byForm.set(op.target.formId, []);
    byForm.get(op.target.formId).push(op);
  }
  for (const [formId, ops] of byForm) {
    const done = [];
    // Row indexes were planned against the form as read. Updates go first (an add would shift the row an update points at), then adds
    // last-index-first, and at one index in reverse spec order — so no add moves a row a later write was planned at, and embeds that share
    // a place end up in the order the spec lists them.
    const updates = ops.filter((op) => op.action === 'update');
    const adds = ops.map((op, at) => ({ op, at })).filter((x) => x.op.action === 'add')
      .sort((a, b) => (a.op.pointer === b.op.pointer ? (b.op.index - a.op.index) || (b.at - a.at) : (a.op.pointer < b.op.pointer ? -1 : 1)))
      .map((x) => x.op);
    const ordered = [...updates, ...adds];
    for (const op of ordered) {
      if (op.action === 'update') {
        await ctx.provision.updateElement('form', formId, op.pointer, op.value);
        done.push({ op, ids: { cellId: op.cellId, controlId: op.controlId }, origin: 'adopted' });
        continue;
      }
      if (!ctx.creates || typeof ctx.creates.run !== 'function') {
        // Fail closed: an add without the build's create journal would be a write nobody recorded the intent of.
        result.refused.push({ key: op.key, kind: op.kind, reason: 'create-journal-unavailable' });
        continue;
      }
      const ids = await ctx.creates.run({ kind: op.kind, key: op.key, identity: { formId, pageId: op.target.pageId, embedKey: op.target.embedKey }, childKeys: ['cell', 'control'] }, async () => {
        await ctx.provision.addElement('form', formId, op.pointer, op.element, { position: { index: op.index } });
        return allocatedIds(ctx, formId, op.pointer, op.index);
      });
      done.push({ op, ids: ids || {}, origin: 'created' });
    }
    if (!done.length) continue;
    const { requireSuccessfulPush } = require('./entity-provision.js');
    requireSuccessfulPush(await ctx.provision.pushArtifact('form', formId), `form ${done[0].op.target.formKey} page embeds`, ctx.warn);
    if (ctx.publication && typeof ctx.publication.queue === 'function') ctx.publication.queue({ kind: 'form', id: formId });
    result.pendingPublish.push({ kind: 'form', id: formId });
    for (const { op, ids, origin } of done) {
      result.saved.push({ key: op.key, kind: op.kind, action: op.action, id: ids.controlId || null });
      result.managedBindings.push(bindingOf(op, ids, origin));
    }
  }
  return result;
}

function bindingOf(op, ids, origin) {
  return { kind: op.kind, key: op.key, id: ids.controlId || null, cellId: ids.cellId || null, parentKey: op.target.formKey,
    formId: op.target.formId, pageKey: op.target.pageKey, pageId: op.target.pageId, intentSha256: op.intentSha256, origin };
}

module.exports = { validateFormPageEmbeds, planFormPageEmbeds, applyFormPageEmbeds, sitemapPageRefs, EMBED_KEYS, PLACEMENTS };
