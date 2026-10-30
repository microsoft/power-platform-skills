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
//   requireEmbedsApplied(result)      -> throws a BuildHalt when a requested embed was refused or its outcome is unknown
// The plan runs after the pages phase has created the pages, because an embed names a page by its id. Ownership of the PAGE stays with
// the page's own create receipt; an embed is a reference to it, which is why deleting an embedded page is refused (page-reference-guard.js).
// A result names keys, ids and codes only — never a value, a token or a raw error.
const { sha256 } = require('./hash.js');
const { stableStringify } = require('./phase-diff.js');
const { isPlainJson } = require('./page-content.js');
const { rowOccupancy, fitsGrid } = require('./form-occupancy.js');

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
const cellsIn = (row) => (row && Array.isArray(row.cells) ? row.cells : []);
const fieldOf = (c) => (c && c.control && isText(c.control.fieldName) ? lower(c.control.fieldName) : null);
const controlIdOf = (c) => (c && c.control && isText(c.control.id) ? lower(c.control.id) : null);

// The row span the SDK gives a page cell when none is authored (adapters/formGenPageEmbed.ts GENPAGE_EMBED_ROWSPAN): the cell's own row and
// a reserved slot in each of the next five. A page is therefore added as a BLOCK — its row and five empty rows under it — so the span covers
// rows that hold nothing and every row that was below the insert point keeps the occupancy it had. Inserted as one row after the first of
// two fields in a one-column section, the span would sit on top of the second field and make a valid section overfull (form-occupancy.js).
const PAGE_ROWSPAN = 6;
const PAGE_BLOCK_ROWS = PAGE_ROWSPAN;

// What the embed means, hashed: the form, the page, where it sits and what it is given. A change of any of them is a new intent.
function intentOf(f, e) {
  return sha256(`form-page-embed/1\n${stableStringify({ form: appSpec().formIdentityKey(f), key: e.key, page: e.page, tab: lower(e.tab), section: lower(e.section), after: e.after === undefined ? null : lower(e.after), inputData: e.inputData === undefined ? null : e.inputData })}`);
}

// The section rows after the planned adds are made, in the order the apply makes them (see orderAdds): each add is a page row and
// PAGE_BLOCK_ROWS - 1 empty rows at its planned index.
function rowsAfterAdds(rows, adds) {
  const out = rows.slice();
  for (const op of orderAdds(adds)) out.splice(op.index, 0, ...blockOf({ cellId: 'planned', controlId: 'planned', uniqueId: 'planned' }, op));
  return out;
}

// Indexes were planned against the form as read: adds go last-index-first, and at one index in reverse spec order — so no add moves a row
// a later add was planned at, and embeds that share a place end up in the order the spec lists them.
function orderAdds(adds) {
  return adds.map((op, at) => ({ op, at }))
    .sort((a, b) => (a.op.pointer === b.op.pointer ? (b.op.index - a.op.index) || (b.at - a.at) : (a.op.pointer < b.op.pointer ? -1 : 1)))
    .map((x) => x.op);
}

// The rows one add writes. The three ids are the ones the create port allocated for this embed before the push: the control's
// `uniqueid` (the key the SDK files the page binding under), the cell's id and the control's id. The SDK keeps ids it is given and mints only
// missing ones (mintEmbedIdentity); the `uniqueid` goes in the control's bag the way the SDK itself writes it, braced (setUniqueId).
function blockOf(ids, op) {
  const page = { cells: [{ id: ids.cellId, colspan: 1, rowspan: PAGE_ROWSPAN,
    control: { id: ids.controlId, bag: { a: [['uniqueid', `{${ids.uniqueId}}`]], c: [] }, genPage: { ...op.genPage } } }] };
  return [page, ...Array.from({ length: PAGE_BLOCK_ROWS - 1 }, () => ({ cells: [] }))];
}

// ctx: { formIdOf(formSpec) -> id|null, pageIdOf(pageRef) -> id|null, provision: { fetchArtifact }, managed: { lookup(kind, key) } }.
// A form or a page this build has not (yet) got an id for is UNKNOWN, not refused: nothing can be said about an embed whose ends are not there.
// `managed.lookup` is the build's managed-binding port: the embed an earlier build made for a key is found
// by the control id its binding records, BEFORE anything is matched by page — so a key whose page changed is retargeted in place, not added
// a second time. Without that port no embed can be told apart from another key's, so the plan says unknown (fail closed) and reads nothing.
async function planFormPageEmbeds(spec, ctx) {
  const operations = [];
  const unknown = [];
  const forms = (spec && Array.isArray(spec.forms)) ? spec.forms : [];
  const managed = ctx && ctx.managed && typeof ctx.managed.lookup === 'function' ? ctx.managed : null;
  for (const f of forms) {
    if (!f || !Array.isArray(f.genPages) || !f.genPages.length) continue;
    const formKey = appSpec().formIdentityKey(f);
    const formId = await ctx.formIdOf(f);
    if (!formId || !managed) {
      for (const e of f.genPages) unknown.push({ key: `${formKey}#${e.key}`, kind: OPERATION_KIND, reason: formId ? 'managed-bindings-unavailable' : 'form-not-built' });
      continue;
    }
    // Every binding of this form's embeds, first: a cell one key's binding names is not another key's to adopt by its page.
    const bindings = new Map();
    const claimedBy = new Map();
    for (const e of f.genPages) {
      const key = `${formKey}#${e.key}`;
      const found = await managed.lookup(OPERATION_KIND, key);
      if (found && typeof found === 'object' && isText(found.id)) {
        bindings.set(key, found);
        claimedBy.set(lower(found.id), key);
      }
    }
    // A fresh read: placement and the "already embedded?" answer must be about the form as it is now, not a workspace copy.
    const artifact = await ctx.provision.fetchArtifact('form', formId);
    const cells = [...cellsOf(artifact)];
    const adds = [];
    for (const e of f.genPages) {
      const key = `${formKey}#${e.key}`;
      const pageId = await ctx.pageIdOf(e.page);
      if (!pageId) { unknown.push({ key, kind: OPERATION_KIND, reason: 'page-not-built' }); continue; }
      const base = { key, kind: OPERATION_KIND, destructive: false, publicationScopes: [`form:${formId}`],
        target: { formId, formKey, table: lower(f.entity || ''), embedKey: e.key, pageKey: e.page, pageId }, intentSha256: intentOf(f, e), preconditions: { pageExists: pageId } };
      const refuse = (reason) => operations.push({ ...base, action: 'refuse', reason });
      const sections = liveSections(artifact, e.tab, e.section);
      if (sections.length !== 1) { refuse(sections.length ? 'section-ambiguous' : 'section-not-found'); continue; }
      const [target] = sections;
      const rows = Array.isArray(target.section.rows) ? target.section.rows : [];
      const afterRow = e.after === undefined ? null : rows.findIndex((r) => cellsIn(r).some((c) => fieldOf(c) === lower(e.after)));
      if (afterRow !== null && afterRow < 0) { refuse('after-field-not-found'); continue; }

      const bound = bindings.get(key);
      let hit = null;
      let origin = 'adopted';
      if (bound) {
        hit = cells.find((x) => controlIdOf(x.cell) === lower(bound.id)) || null;
        // The control the binding names is still there but holds no page: someone made it something else. It is not this feature's to overwrite.
        if (hit && !genPageOf(hit.cell)) { refuse('bound-control-not-a-page'); continue; }
        if (hit) origin = bound.origin === 'created' ? 'created' : 'adopted';
      }
      const onPage = cells.filter((x) => x !== hit && samePage(genPageOf(x.cell) && genPageOf(x.cell).pageId, pageId));
      if (hit) {
        // Retargeting this key's cell to a page another cell of the form already shows would show it twice.
        if (onPage.length) { refuse('page-embedded-elsewhere'); continue; }
      } else {
        if (onPage.length > 1) { refuse('page-embedded-more-than-once'); continue; }
        if (onPage.length === 1) {
          const owner = claimedBy.get(controlIdOf(onPage[0].cell));
          if (owner && owner !== key) { refuse('cell-bound-to-another-embed'); continue; }
          [hit] = onPage;
        }
      }

      if (hit) {
        // Moving a cell someone placed elsewhere is a layout change this feature does not own; say so instead of relocating it.
        if (hit.sectionPointer !== target.pointer) { refuse('page-embedded-elsewhere'); continue; }
        // A requested place is checked, not assumed: the cell must sit below the `after` field with no other field's row between them.
        // A cell elsewhere in the section is refused rather than moved or reported unchanged — its intent (which names the place) is
        // then not recorded as applied. Without `after` the position is the maker's.
        if (afterRow !== null && (hit.rowIndex <= afterRow || rows.slice(afterRow + 1, hit.rowIndex).some((r) => cellsIn(r).some((c) => fieldOf(c) !== null)))) {
          refuse('placement-differs');
          continue;
        }
        const current = genPageOf(hit.cell);
        const ids = { cellId: hit.cell.id || null, controlId: (hit.cell.control && hit.cell.control.id) || null };
        const retarget = !samePage(current.pageId, pageId);
        if (!retarget && inputHash(current.inputData) === inputHash(e.inputData)) { operations.push({ ...base, action: 'none', origin, ...ids }); continue; }
        // The typed binding is edited in place — a new page id for a key whose page changed, else the one the form holds, with the input — so
        // the cell, its ids and its bag stay.
        operations.push({ ...base, action: 'update', origin, ...ids, pointer: `${hit.pointer}/control/genPage`,
          value: { pageId: retarget ? pageId : current.pageId, ...(e.inputData !== undefined ? { inputData: e.inputData } : {}) } });
        continue;
      }

      const columns = Number(target.section.columns);
      if (!Number.isInteger(columns) || columns < 1) { refuse('section-geometry-unknown'); continue; }
      const index = afterRow === null ? rows.length : afterRow + 1;
      // A row-spanning cell above the insert point that still reserves a slot there would come to span the new rows instead of the ones it
      // spans now — a different layout. Refused before anything is written.
      const at = rowOccupancy([...rows.slice(0, index), { cells: [] }]).pop();
      if (at.reserved > 0) { refuse('placement-inside-row-span'); continue; }
      const op = { ...base, action: 'add', pointer: `${target.pointer}/rows`, index, columns,
        genPage: { pageId, ...(e.inputData !== undefined ? { inputData: e.inputData } : {}) } };
      adds.push({ op, rows });
    }
    // The section as it would be after every add planned for it must still fit its grid; a section that would not is refused as a whole.
    const byPointer = new Map();
    for (const a of adds) {
      if (!byPointer.has(a.op.pointer)) byPointer.set(a.op.pointer, { rows: a.rows, ops: [] });
      byPointer.get(a.op.pointer).ops.push(a.op);
    }
    for (const { rows, ops } of byPointer.values()) {
      if (fitsGrid(rows, ops[0].columns) && !fitsGrid(rowsAfterAdds(rows, ops), ops[0].columns)) {
        for (const op of ops) operations.push({ ...op, action: 'refuse', reason: 'placement-overfills-section' });
      } else {
        operations.push(...ops);
      }
    }
  }
  return { operations, unknown };
}

// ctx: { provision: { addElement, updateElement, pushArtifact }, creates: { run }, publication: { queue }, warn }.
// Every add goes through ctx.creates.run, the build's create port: it allocates the ids an add is sent under (the control's uniqueid, the
// cell's id, the control's id) and calls the add's execute once. The runs of a form's adds are nested, and the innermost one makes the local
// edits under the ids every run allocated and pushes the form — one push per changed form. The port keeps no record and sends nothing again:
// a push that failed is the build's failure like any other form push, and the next build plans from the form as it reads it then. A push
// that fails by value halts the build the way every other form push does (requireSuccessfulPush), and a page that went away between plan and
// push is the SDK's refusal (FORM_GENPAGE_TARGET_NOT_FOUND), propagated unchanged.
async function applyFormPageEmbeds(plan, ctx) {
  const result = { saved: [], unchanged: [], pendingPublish: [], refused: [], unknown: [...((plan && plan.unknown) || [])], managedBindings: [] };
  const byForm = new Map();
  for (const op of (plan && plan.operations) || []) {
    if (op.action === 'refuse') { result.refused.push({ key: op.key, kind: op.kind, reason: op.reason }); continue; }
    if (op.action === 'none') {
      result.unchanged.push({ key: op.key, kind: op.kind, id: op.controlId });
      result.managedBindings.push(bindingOf(op, op, op.origin || 'adopted'));
      continue;
    }
    if (!byForm.has(op.target.formId)) byForm.set(op.target.formId, []);
    byForm.get(op.target.formId).push(op);
  }
  const hasPort = ctx.creates && typeof ctx.creates.run === 'function';
  for (const [formId, ops] of byForm) {
    // Updates go first (an add would shift the row an update points at), then the adds (orderAdds).
    const updates = ops.filter((op) => op.action === 'update');
    let adds = orderAdds(ops.filter((op) => op.action === 'add'));
    if (adds.length && !hasPort) {
      // Fail closed: the port allocates the ids an add is sent under, and the binding the build records names them.
      for (const op of adds) result.refused.push({ key: op.key, kind: op.kind, reason: 'create-port-unavailable' });
      adds = [];
    }
    if (!updates.length && !adds.length) continue;
    const ids = new Map();
    const sent = { pushed: false };
    const writeAndPush = async () => {
      for (const op of updates) await ctx.provision.updateElement('form', formId, op.pointer, op.value);
      for (const op of adds) {
        if (!ids.has(op)) continue;
        const block = blockOf(ids.get(op), op);
        for (let r = 0; r < block.length; r++) await ctx.provision.addElement('form', formId, op.pointer, block[r], { position: { index: op.index + r } });
      }
      sent.pushed = true;
      return ctx.provision.pushArtifact('form', formId);
    };
    const level = async (i) => {
      if (i === adds.length) return updates.length || ids.size ? writeAndPush() : undefined;
      const op = adds[i];
      const ran = await ctx.creates.run({ kind: op.kind, key: op.key, identity: { formId, intentSha256: op.intentSha256 }, childKeys: ['cell', 'control'] },
        ({ id, childIds }) => {
          ids.set(op, { uniqueId: id, cellId: childIds.cell, controlId: childIds.control });
          return level(i + 1);
        });
      return ran ? ran.result : undefined;
    };
    // A form whose push failed (thrown, or refused by value) is not saved, and the forms before it were: the failure carries the result so far,
    // with this form's embeds as unknown, so the caller reports the earlier saves and records their bindings before it stops.
    try {
      const pushed = await level(0);
      if (!sent.pushed) continue;
      const { requireSuccessfulPush } = require('./entity-provision.js');
      requireSuccessfulPush(pushed, `form ${ops[0].target.formKey} page embeds`, ctx.warn);
    } catch (error) {
      for (const op of [...updates, ...adds]) result.unknown.push({ key: op.key, kind: op.kind, reason: 'form-push-failed' });
      throw withEmbeds(error, result);
    }
    // Saved: recorded before the publish is queued, so a queue that fails cannot take back a save the push acknowledged.
    result.pendingPublish.push({ kind: 'form', id: formId });
    for (const op of updates) {
      result.saved.push({ key: op.key, kind: op.kind, action: op.action, id: op.controlId || null });
      result.managedBindings.push(bindingOf(op, op, op.origin || 'adopted'));
    }
    for (const op of adds) {
      if (!ids.has(op)) continue;
      const got = ids.get(op);
      result.saved.push({ key: op.key, kind: op.kind, action: op.action, id: got.controlId });
      result.managedBindings.push(bindingOf(op, got, 'created'));
    }
    if (ctx.publication && typeof ctx.publication.queue === 'function') {
      try {
        await ctx.publication.queue({ kind: 'form', id: formId, table: ops[0].target.table, label: `form ${ops[0].target.formKey} page embeds` });
      } catch (error) {
        throw withEmbeds(error, result);
      }
    }
  }
  return result;
}

// The step's result so far, on the failure that stopped it (`embeds`, as requireEmbedsApplied's halt carries it). A failure that already
// carries one, or cannot carry one (not an object, frozen), is left as it is: it propagates either way.
function withEmbeds(error, result) {
  if (error && typeof error === 'object' && error.embeds === undefined && Object.isExtensible(error)) error.embeds = result;
  return error;
}

// A requested embed that was refused or whose outcome is unknown leaves the build incomplete: the maker asked for it. The
// halt names keys and reasons only; what WAS saved stays reported in `result` (the caller reports it before it stops).
function requireEmbedsApplied(result, phase = 'pages') {
  const missing = [...((result && result.refused) || []).map((r) => ({ ...r, outcome: 'refused' })), ...((result && result.unknown) || []).map((u) => ({ ...u, outcome: 'unknown' }))];
  if (!missing.length) return result;
  const { BuildHalt } = require('./entity-provision.js');
  const { RETRY } = require('./retry-policy.js');
  const words = missing.map((m) => `${m.key} (${m.outcome}: ${m.reason})`).join(', ');
  const halt = new BuildHalt(`the generative pages requested on forms were not all embedded: ${words}`, { phase, code: 'form-page-embeds-incomplete', recoverable: false, retry: RETRY.NEVER });
  halt.notApplied = missing.map(({ key, kind, reason, outcome }) => ({ key, kind, reason, outcome }));
  // What this step DID save stays with the halt, so the build reports it (and records its bindings) before it stops: a partial save is said, not lost.
  halt.embeds = result;
  throw halt;
}

// The page id a build holds for a page reference. The build keeps them in a Map (sdk-build.js reconcilePageIds -> keyToId); a plain object is
// read by own property only, so a key such as 'constructor' is not an id.
function pageIdFrom(keyToId, ref) {
  if (keyToId instanceof Map) return keyToId.get(ref) || null;
  if (keyToId && typeof keyToId === 'object' && Object.prototype.hasOwnProperty.call(keyToId, ref)) return keyToId[ref] || null;
  return null;
}

const hasFormPageEmbeds = (spec) => !!(spec && Array.isArray(spec.forms) && spec.forms.some((f) => f && Array.isArray(f.genPages) && f.genPages.length));

// The build's whole step, so the wiring is one call: plan (fresh form reads), apply (adds through the create port), then report what was saved and
// halt on anything requested that was not applied. ctx = planFormPageEmbeds' and applyFormPageEmbeds' ctx, with `keyToId` (the build's page
// ids) instead of `pageIdOf`, and `report(result)` — called with the result before any halt, so a partial save is reported and its bindings
// recorded. A spec with no form embed reads and writes nothing, and the step answers null.
async function runFormPageEmbeds(spec, ctx = {}) {
  if (!hasFormPageEmbeds(spec)) return null;
  const pageIdOf = typeof ctx.pageIdOf === 'function' ? ctx.pageIdOf : (ref) => pageIdFrom(ctx.keyToId, ref);
  const plan = await planFormPageEmbeds(spec, { ...ctx, pageIdOf });
  let result;
  try {
    result = await applyFormPageEmbeds(plan, ctx);
  } catch (error) {
    // A form that failed after another was saved: the earlier save is reported (and its bindings recorded) before the failure propagates.
    if (error && error.embeds && typeof ctx.report === 'function') await ctx.report(error.embeds);
    throw error;
  }
  if (typeof ctx.report === 'function') await ctx.report(result);
  return requireEmbedsApplied(result, ctx.phase || 'pages');
}

function bindingOf(op, ids, origin) {
  return { kind: op.kind, key: op.key, id: ids.controlId || null, cellId: ids.cellId || null, ...(ids.uniqueId ? { uniqueId: ids.uniqueId } : {}), parentKey: op.target.formKey,
    formId: op.target.formId, pageKey: op.target.pageKey, pageId: op.target.pageId, intentSha256: op.intentSha256, origin };
}

module.exports = { validateFormPageEmbeds, planFormPageEmbeds, applyFormPageEmbeds, requireEmbedsApplied, runFormPageEmbeds, hasFormPageEmbeds, sitemapPageRefs, EMBED_KEYS, PLACEMENTS, PAGE_ROWSPAN };
