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
//   verifyFormPageEmbed(formxml, embed, pageId) -> { ok, reason? }      pure: whether a deployed form shows the page as the embed declares it
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

// The embed step runs in the pages phase, after the pages exist. A run whose phases build the forms but not the pages would save every
// form the spec names and end without one embed it asks for, and nothing would say so. Refused before anything is written (phase
// 'preflight', never retried: a run again selects the same phases); the halt names each embed key. Every other phase set is let through:
// a run with the pages phase embeds (or says form-not-built when it has no forms), and one with neither builds no form to embed on.
function requirePagesPhaseForEmbeds(spec, phases) {
  if (!hasFormPageEmbeds(spec) || !Array.isArray(phases) || !phases.includes('forms') || phases.includes('pages')) return undefined;
  const notApplied = [];
  for (const f of spec.forms) {
    if (!f || !Array.isArray(f.genPages)) continue;
    const formKey = appSpec().formIdentityKey(f);
    for (const e of f.genPages) notApplied.push({ key: `${formKey}#${e && e.key}`, kind: OPERATION_KIND, reason: 'pages-phase-not-selected', outcome: 'unknown' });
  }
  const { BuildHalt } = require('./entity-provision.js');
  const { RETRY } = require('./retry-policy.js');
  const halt = new BuildHalt(`the generative pages requested on forms are embedded by the pages phase, which this run does not include: ${notApplied.map((m) => m.key).join(', ')}. `
    + 'The build stopped before writing anything; run it with the pages phase (a full build).', { phase: 'preflight', code: 'form-page-embeds-incomplete', recoverable: false, retry: RETRY.NEVER });
  halt.notApplied = notApplied;
  throw halt;
}

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

// The forms of `spec` that embed `page`, with the embed: the genPages entries naming the page (by key in a schemaVersion 2 spec, by name before).
function formEmbedsOfPage(spec, page) {
  const ref = pageRefOf(spec || {}, page);
  const found = [];
  if (!isText(ref)) return found;
  for (const form of (spec && Array.isArray(spec.forms) ? spec.forms : [])) {
    for (const embed of (form && Array.isArray(form.genPages) ? form.genPages : [])) if (embed && embed.page === ref) found.push({ form, embed });
  }
  return found;
}

// Whether a deployed form shows `pageId` as `embed` declares it — the verify side of a page placed on a form, which has no sitemap entry to
// be checked by. Read from the form's own FormXML, in the shape the SDK writes (adapters/formGenPageEmbed.ts), for example
//   <tab name="tab_general">…<section name="section_general">…<rows>
//     <row><cell><control id="new_name" datafieldname="new_name"/></cell></row>
//     <row><cell id="{…}" rowspan="6"><control id="{…}" uniqueid="{8e1f…}" classid="{F9A8A302-…}"/></cell></row> …
//   <controlDescriptions><controlDescription forControl="{8e1f…}">
//     <customControl name="MscrmControls.UxAgentControl" formFactor="2"><parameters>
//       <RefId type="SingleLine.Text" static="true">11111111-0000-4000-8000-000000000001</RefId>
//       <PageInput type="SingleLine.Text" static="true">{"data":{"mode":"compact"}}</PageInput></parameters></customControl> … (one per form factor)
// A control shows a page exactly when the SDK's typed projection of the form gives it a `genPage` (projectGenPageEmbeds), by the same rule
// (isRecognizedEmbed, classifyBinding): a control in a cell of the form body, unbound (no `datafieldname`), of the page-control class (`classid`
// trimmed, outer braces dropped, upper-cased), whose `uniqueid` names — as a GUID: trimmed, lower-cased, braces only as a pair — the first
// description in the form's own `controlDescriptions`; and every `MscrmControls.UxAgentControl` entry of that description (the name as written)
// has, in its first `parameters`, a static RefId naming one GUID and, if it has a PageInput, a static one, all entries alike. RefId and
// PageInput are read as their text nodes: character references decoded, CDATA sections taken as written, comments and child elements left
// out. (The SDK also requires a Main form; the spec gate allows genPages on a Main form only.) A description for no control on the form (an
// orphan) shows nothing. Then the place — tab, section, and with `after` the row below that field with no other field's row between, the rule
// the plan holds an existing cell to — and the input (PageInput's `data`, read as the SDK reads it: inputDataFrom) must be the declared ones.
// The SDK does not export the parser behind the projection, so the rule is followed here, and a test holds the two to the same answers.
// Answers { ok: true } or { ok: false, reason } with reason form-xml-unreadable | not-embedded | embedded-more-than-once | binding-unsupported |
// placement-differs | input-differs. Pure: the caller reads the form.
const UX_AGENT_CONTROL = 'MscrmControls.UxAgentControl';
const PAGE_CONTROL_CLASS = 'F9A8A302-114E-466A-B582-6771B2AE0D92';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMBED_XML = new Set(['tab', 'section', 'row', 'control', 'controlDescriptions', 'controlDescription', 'customControl', 'parameters', 'RefId', 'PageInput']);
const BODY_CELL = /(?:^|\/)tabs\/tab\/columns\/column\/sections\/section\/rows\/row\/cell$/;
// The SDK's normGuid: '' for anything that is not one GUID.
const idIn = (text) => {
  let t = typeof text === 'string' ? text.trim().toLowerCase() : '';
  if (t.startsWith('{') && t.endsWith('}')) t = t.slice(1, -1);
  return GUID.test(t) ? t : '';
};
const classOf = (control) => String(control.attrs.classid || '').trim().replace(/^\{|\}$/g, '').toUpperCase();
// The text nodes an element holds directly, as a parser hands them over. The span's inner XML is split into CDATA sections, comments,
// processing instructions and tags (a quoted attribute value may hold '>'), e.g. `&#48;<!-- id --><![CDATA[1111…]]>` → '0' + '1111…'.
const MARKUP = /(<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(?:"[^"]*"|'[^']*'|[^'">])*>)/;

function verifyFormPageEmbed(formxml, embed, pageId) {
  // Lazy for the same reason as appSpec(): page-reference-guard.js and sitemap-pages.js reach app-spec.js, which requires this file.
  const { readXmlElements } = require('./strict-xml.js');
  const { elementText } = require('./page-reference-guard.js');
  const { decodeXmlEntities } = require('./sitemap-pages.js');
  const want = idIn(pageId);
  const read = typeof formxml === 'string' && formxml ? readXmlElements(formxml, (name) => EMBED_XML.has(name), { spans: true }) : { ok: false };
  if (!want || !read.ok) return { ok: false, reason: 'form-xml-unreadable' };
  const els = read.elements;
  const within = (outer, e) => e.start > outer.start && e.end <= outer.end;
  const valueOf = (e) => {
    let depth = 0;
    let text = '';
    for (const part of elementText(formxml, e.start, e.end).split(MARKUP)) {
      if (part.startsWith('<![CDATA[')) { if (!depth) text += part.slice(9, -3); } else if (part.startsWith('<!--') || part.startsWith('<?')) continue;
      else if (part.startsWith('</')) depth -= 1;
      else if (part.startsWith('<')) { if (!part.endsWith('/>')) depth += 1; } else if (!depth) text += decodeXmlEntities(part);
    }
    return text;
  };
  const childOf = (parent, name) => els.find((e) => e.name === name && within(parent, e) && e.path === `${parent.path}/${parent.name}`);

  // uniqueid -> what each UxAgentControl entry of its description names: the static page id ('' when none) and the PageInput text. Only the
  // first `controlDescriptions` under the form's root element is read, and in it the first description for each uniqueid, as the SDK does.
  const bindings = new Map();
  const region = els.find((e) => e.name === 'controlDescriptions' && !e.path.includes('/'));
  for (const d of region ? els.filter((e) => e.name === 'controlDescription' && within(region, e) && e.path === `${region.path}/controlDescriptions`) : []) {
    const uid = idIn(d.attrs.forControl);
    if (!uid || bindings.has(uid)) continue;
    bindings.set(uid, []);
    for (const control of els.filter((e) => e.name === 'customControl' && within(d, e) && e.path === `${d.path}/controlDescription` && e.attrs.name === UX_AGENT_CONTROL)) {
      const params = childOf(control, 'parameters');
      const ref = params && childOf(params, 'RefId');
      const input = params && childOf(params, 'PageInput');
      const page = ref && ref.attrs.static === 'true' && (!input || input.attrs.static === 'true') ? idIn(valueOf(ref)) : '';
      bindings.get(uid).push({ page, input: input ? valueOf(input) : undefined });
    }
  }
  const hits = [];
  for (const control of els.filter((e) => e.name === 'control' && BODY_CELL.test(e.path) && !e.attrs.datafieldname && classOf(e) === PAGE_CONTROL_CLASS)) {
    const entries = bindings.get(idIn(control.attrs.uniqueid)) || [];
    if (!entries.some((x) => x.page === want)) continue;
    if (!entries.every((x) => x.page === want && x.input === entries[0].input)) return { ok: false, reason: 'binding-unsupported' };
    hits.push({ control, input: entries[0].input });
  }
  if (hits.length !== 1) return { ok: false, reason: hits.length ? 'embedded-more-than-once' : 'not-embedded' };
  const [{ control, input }] = hits;

  // Elements come in document order, so the last one that contains the control is the innermost.
  const around = (name) => els.filter((e) => e.name === name && within(e, control)).pop();
  const tab = around('tab');
  const section = around('section');
  if (lower(tab.attrs.name || '') !== lower(embed.tab) || lower(section.attrs.name || '') !== lower(embed.section)) return { ok: false, reason: 'placement-differs' };
  if (embed.after !== undefined) {
    const rows = els.filter((e) => e.name === 'row' && within(section, e));
    const fieldsIn = (row) => els.filter((e) => e.name === 'control' && within(row, e) && isText(e.attrs.datafieldname)).map((e) => lower(e.attrs.datafieldname));
    const at = rows.findIndex((r) => within(r, control));
    const afterRow = rows.findIndex((r) => fieldsIn(r).includes(lower(embed.after)));
    if (afterRow < 0 || at <= afterRow || rows.slice(afterRow + 1, at).some((r) => fieldsIn(r).length)) return { ok: false, reason: 'placement-differs' };
  }
  let data;
  try { const parsed = input === undefined ? undefined : JSON.parse(input); data = isObject(parsed) && isObject(parsed.data) ? parsed.data : undefined; } catch { data = undefined; }
  if (inputHash(data) !== inputHash(embed.inputData)) return { ok: false, reason: 'input-differs' };
  return { ok: true };
}

function bindingOf(op, ids, origin) {
  return { kind: op.kind, key: op.key, id: ids.controlId || null, cellId: ids.cellId || null, ...(ids.uniqueId ? { uniqueId: ids.uniqueId } : {}), parentKey: op.target.formKey,
    formId: op.target.formId, pageKey: op.target.pageKey, pageId: op.target.pageId, intentSha256: op.intentSha256, origin };
}

module.exports = { validateFormPageEmbeds, planFormPageEmbeds, applyFormPageEmbeds, requireEmbedsApplied, runFormPageEmbeds, hasFormPageEmbeds, requirePagesPhaseForEmbeds, verifyFormPageEmbed, formEmbedsOfPage, sitemapPageRefs, EMBED_KEYS, PLACEMENTS, PAGE_ROWSPAN };
