'use strict';
// Declared form layout (`forms[].reconcile: "declared"`): the spec's bound fields are placed exactly
// where it declares them on an EXISTING form, while every control the spec does not declare stays
// exactly where it is.
//
// Without the opt-in the build keeps its additive behaviour (sdk-build's field/topology passes): it adds
// missing fields and nudges spans, and never takes a maker's arrangement apart. With it, for each
// declared section:
//   - the cells of declared fields are taken out and packed again in the declared order, reading order
//     (row by row, left to right), each at the first free slot at or after the previous one;
//   - every other cell (a maker's field, a sub-grid, a web resource) is a FIXED OBSTACLE: it keeps its
//     row and column, and the declared cells flow around it;
//   - a free slot that a later cell must skip is held by a spacer cell (`control: null`, the SDK's own
//     shape for one), because a FormXML row cannot otherwise express "leave this column empty";
//   - a declared field found in another section moves here; its old section keeps every other cell where
//     it was, the same way;
//   - a row this pack empties is kept (empty) while a maker's cell sits below it: dropping it would move
//     every later row up, and with it controls the spec does not own.
// Positions come from the column-slot model (form-occupancy.js slotGrid), not the width-only rowOccupancy
// the additive path uses: keeping a maker's cell in column 1 beside a row-spanning cell needs positions.
//
// What is owned: the order, the section and the spans of the declared fields, the column count of a
// declared section when the spec states it, plus readOnly / hidden when the spec states them. An explicit
// `false` clears the flag, but only on a declared field's own control; a flag the spec leaves out is left as
// it is. Existing cells keep their ids, labels and every other property (the SDK round-trips them), so a
// re-run with nothing to change sends nothing.
//
// New cells (a declared field the form does not hold yet, and a spacer) are children of the form: their
// cell and control ids are reserved through the creation-identity port (ctx.creates.run) BEFORE the write,
// so an interrupted push is recovered by the same ids instead of minting a second set. The SDK keeps an id
// it is given and mints one only for a cell or control without one.
//
// The baseline is the FULL layout projection of the form — where every field control sits, with its spans
// and flags, and each section's column count — whatever the spec declares today, with a hash per part
// (reconcile-common partsDriftVerdict). So a spec that starts declaring a flag, or a field the form already
// holds, is an edit and not drift, while a part someone else changed since the last build still refuses.
//
// Refusals (nothing is written for that form): a field declared twice, a field the form holds in more
// than one place (in any section), a declared section the form does not have, a maker's cell that no
// longer fits the section (it overruns the grid), a layout changed outside the spec since the last build,
// a first edit of a form the spec has not managed before without adoption approval, and a new cell the
// creation-identity port did not allow.

const { slotGrid } = require('./form-occupancy.js');
const { fieldCellIntent, isNonFieldControl, findSectionLocation, findFieldCellLocations } = require('./artifact-intent.js');
const { formColumnsOf } = require('./app-spec.js');
const {
  emptyResult,
  operation,
  refusal,
  isAuthorized,
  lookupBinding,
  bindingRecord,
  partsDriftVerdict,
  projectionBaseline,
  createThroughPort,
  pushIfChanged,
  queuePublication,
  canonicalJson,
  rulesOf,
} = require('./reconcile-common.js');

const KIND = 'form-layout';
const ARTIFACT = 'form';

function isDeclaredForm(form) {
  return !!form && form.reconcile === 'declared';
}

function formLayoutKey(form) {
  return `${String((form && (form.table || form.entity)) || '').toLowerCase()}/${String((form && form.name) || '').toLowerCase()}`;
}

// readOnly / hidden as the author wrote them: true, false, or undefined (said nothing). The additive
// compiler keeps only `true` (it must never un-hide a maker's control), so the declared path reads the
// raw entries itself.
const triState = (v) => (v === true ? true : v === false ? false : undefined);

function declaredFlags(formSpec) {
  const flags = {};
  const take = (name, src) => {
    const key = String(name || '').toLowerCase();
    if (!key || !src || typeof src !== 'object') return;
    const cur = flags[key] || (flags[key] = {});
    for (const k of ['readOnly', 'hidden']) if (triState(src[k]) !== undefined) cur[k] = triState(src[k]);
  };
  const fo = formSpec && formSpec.fieldOptions;
  if (fo && typeof fo === 'object' && !Array.isArray(fo)) for (const k of Object.keys(fo)) take(k, fo[k]);
  // Inline entries win over the form-level fieldOptions default, as they do in the additive compiler.
  // Both tab shapes the spec accepts are walked: `tabs[].sections` and `tabs[].columns[].sections`
  // (formColumnsOf is the compiler's own reading of them).
  for (const tab of rawTabs(formSpec)) {
    for (const column of formColumnsOf(tab)) {
      for (const section of (column && column.sections) || []) {
        for (const entry of (section && section.fields) || []) if (entry && typeof entry === 'object') take(entry.name, entry);
      }
    }
  }
  return flags;
}

const rawTabs = (formSpec) => (formSpec && Array.isArray(formSpec.tabs) ? formSpec.tabs : []);

// The column count the spec STATES for the section at (ti, ci, si), or undefined. The compiled intent always
// carries a count (the compiler defaults an omitted one to 1), so reading it there would make an omitted
// width shrink a maker's wider section. The compiled value is used when one was stated: it is already capped
// for the form type (a Quick Create section is one column).
function statedWidth(formSpec, ti, ci, si, compiled) {
  const tab = rawTabs(formSpec)[ti];
  const column = tab ? formColumnsOf(tab)[ci] : null;
  const section = column && Array.isArray(column.sections) ? column.sections[si] : null;
  return section && typeof section.columns === 'number' ? compiled : undefined;
}

/**
 * The declared layout of a form: its sections that hold bound fields, each with its fields in reading
 * order. Section names, field order and spans come from the COMPILED intent (compileFormIntent), so they
 * cannot disagree with what the create path builds; readOnly / hidden come from the raw spec, keeping
 * an explicit false. Non-field controls (sub-grids, notes, quick views) are not part of it.
 *   { sections: [{ section, columns?, fields: [{ name, colspan?, rowspan?, readOnly?, hidden? }] }], duplicates: [name],
 *     templates: { name: compiled cell } }
 * `columns` is set only when the spec states the section's width; `templates` is the compiled cell of each
 * field, the starting point for a cell the form does not hold yet (it carries isRequired).
 */
function declaredLayoutOf(formSpec, intentTabs) {
  const flags = declaredFlags(formSpec);
  const sections = [];
  const seen = new Set();
  const duplicates = [];
  const templates = {};
  (intentTabs || []).forEach((tab, ti) => {
    ((tab && tab.columns) || []).forEach((column, ci) => {
      ((column && column.sections) || []).forEach((section, si) => {
        const fields = [];
        for (const row of (section && section.rows) || []) {
          for (const cell of (row && row.cells) || []) {
            const control = cell && cell.control;
            if (!control || !control.fieldName || isNonFieldControl(control)) continue;
            const name = String(control.fieldName).toLowerCase();
            if (seen.has(name)) { duplicates.push(name); continue; }
            seen.add(name);
            templates[name] = cell;
            const f = { name };
            if (cell.colspan !== undefined) f.colspan = cell.colspan;
            if (cell.rowspan !== undefined) f.rowspan = cell.rowspan;
            Object.assign(f, flags[name] || {});
            fields.push(f);
          }
        }
        if (!fields.length) return;
        const entry = { section: section.name, fields };
        const width = statedWidth(formSpec, ti, ci, si, section.columns);
        if (width !== undefined) entry.columns = width;
        sections.push(entry);
      });
    });
  });
  return { sections, duplicates, templates };
}

const fieldOf = (cell) => {
  const control = cell && cell.control;
  if (!control || !control.fieldName || isNonFieldControl(control)) return '';
  return String(control.fieldName).toLowerCase();
};
const isSpacer = (cell) => !!cell && !cell.control;
const clone = (v) => JSON.parse(JSON.stringify(v));

/**
 * Pack one section. `rows` are its live rows, `width` its column count, `fields` the declared fields
 * that belong here (in order), `owned` the set of every declared field name on the form (a declared
 * field of another section that sits here is moved out), and `carried` the live cell of each declared
 * field wherever it currently is (name -> cell), so a moved or repacked cell keeps its ids and state.
 * `templates` (name -> compiled cell) is the starting point of a cell the form does not hold yet, and
 * `sectionKey` names the section in the identity keys of new cells.
 * Answers { rows, fresh } or { refused: code }. `fresh` lists every cell this pack made new, by position in
 * `rows`, with the creation-identity keys its ids are reserved under:
 *   [{ row, cell, keys: { cell: 'cell:<field>' | 'spacer:<section>:<r>:<c>', control?: 'control:<field>' } }]
 */
function packDeclaredLayout({ rows, width, fields = [], owned = new Set(), carried = {}, templates = {}, sectionKey = '' }) {
  const w = Math.max(1, Math.min(4, Math.floor(Number(width)) || 1));
  const live = slotGrid(rows, w);
  const cellAt = (p) => rows[p.row].cells[p.cell];
  const mobile = (cell) => isSpacer(cell) || owned.has(fieldOf(cell));
  for (const o of live.overflow) {
    if (!mobile(rows[o.row].cells[o.cell])) return { refused: 'form-layout-obstacle-unplaceable' };
  }
  const grid = [];
  const rowAt = (r) => {
    while (grid.length <= r) grid.push(new Array(w).fill(null));
    return grid[r];
  };
  // The cells this pack creates, with their identity keys (see `fresh` above).
  const made = new Map();
  // Live spacers by slot: a spacer re-emitted where one already stands is the same cell (same id), so an
  // unchanged layout serializes byte-for-byte as it was read.
  const liveSpacers = {};
  // The last row a fixed obstacle starts on: rows above it may not be dropped (see the row loop below).
  let lastFixed = -1;
  for (const p of live.placed) {
    const cell = cellAt(p);
    if (isSpacer(cell)) liveSpacers[`${p.r},${p.c}`] = cell;
    else if (!mobile(cell)) {
      for (let y = p.r; y < p.r + p.rowspan; y += 1) for (let x = p.c; x < p.c + p.colspan; x += 1) rowAt(y)[x] = { origin: [p.r, p.c] };
      rowAt(p.r)[p.c] = { origin: [p.r, p.c], cell, colspan: p.colspan, rowspan: p.rowspan };
      lastFixed = Math.max(lastFixed, p.r);
    }
  }
  const isFree = (r, c, span, rowspan) => {
    if (c + span > w) return false;
    for (let y = r; y < r + rowspan; y += 1) for (let x = c; x < c + span; x += 1) if (rowAt(y)[x]) return false;
    return true;
  };
  let cr = 0;
  let cc = 0;
  for (const f of fields) {
    const was = carried[f.name];
    const span = Math.min(w, Math.max(1, Number(f.colspan !== undefined ? f.colspan : was && was.colspan) || 1));
    const rowspan = Math.max(1, Number(f.rowspan !== undefined ? f.rowspan : was && was.rowspan) || 1);
    let r = cr;
    let c = cc;
    while (!isFree(r, c, span, rowspan)) {
      c += 1;
      if (c + span > w) { r += 1; c = 0; }
    }
    const cell = was ? clone(was) : newFieldCell(f.name, templates[f.name]);
    if (!was) made.set(cell, { cell: `cell:${f.name}`, control: `control:${f.name}` });
    if (f.colspan !== undefined || (was && Number(was.colspan) > w)) cell.colspan = span;
    if (f.rowspan !== undefined) cell.rowspan = rowspan;
    if (f.readOnly === true) cell.control.isReadOnly = true;
    else if (f.readOnly === false && cell.control.isReadOnly !== undefined) cell.control.isReadOnly = false;
    if (f.hidden === true) cell.visible = false;
    else if (f.hidden === false && cell.visible !== undefined) cell.visible = true;
    for (let y = r; y < r + rowspan; y += 1) for (let x = c; x < c + span; x += 1) rowAt(y)[x] = { origin: [r, c] };
    rowAt(r)[c] = { origin: [r, c], cell, colspan: span, rowspan };
    if (c + span >= w) { cr = r + 1; cc = 0; } else { cr = r; cc = c + span; }
  }
  // Rows past the live section that only a span reaches into are not added: the span renders without
  // them, and adding them would make every later run see a change that is not there.
  let lastContent = -1;
  for (let r = 0; r < grid.length; r += 1) if (grid[r].some((slot) => slot && slot.origin[0] === r)) lastContent = r;
  const out = [];
  for (let r = 0; r < grid.length; r += 1) {
    if (r > lastContent && r >= rows.length) break;
    const cells = [];
    let spacers = [];
    let reserved = false;
    for (let c = 0; c < w; c += 1) {
      const slot = grid[r][c];
      if (!slot) {
        // A maker's own spacer is kept where it stands (it holds a slot nothing declared needs); a new
        // one is only written when a later cell in the row must skip this slot.
        const kept = liveSpacers[`${r},${c}`];
        if (kept) { cells.push(...spacers, kept); spacers = []; } else {
          const spacer = { control: null };
          made.set(spacer, { cell: `spacer:${sectionKey}:${r}:${c}` });
          spacers.push(spacer);
        }
        continue;
      }
      const [or, oc] = slot.origin;
      if (or === r && oc === c) {
        cells.push(...spacers, slot.cell);
        spacers = [];
      } else if (or < r) {
        reserved = true;
      }
    }
    // A row that holds nothing and is not crossed by a span above is a blank line. One the maker left
    // (empty in the live layout, and not emptied by this pack) stays. One this pack emptied goes — but
    // only below the last maker's cell: dropping a row above one moves that cell (and every later row)
    // up, which is moving a control the spec does not own. There the row is kept, empty.
    const liveRow = rows[r];
    const wasEmpty = liveRow && !((liveRow.cells || []).length);
    if (!cells.length && !reserved && !wasEmpty && r > lastFixed) continue;
    out.push(liveRow && !cells.length && wasEmpty ? liveRow : { ...(liveRow ? clone(liveRow) : {}), cells });
  }
  const fresh = [];
  out.forEach((row, ri) => (row.cells || []).forEach((cell, ci) => {
    if (made.has(cell)) fresh.push({ row: ri, cell: ci, keys: made.get(cell) });
  }));
  return { rows: out, fresh };
}

// A cell for a declared field the form does not hold yet: the compiled cell (it carries isRequired and the
// flags the spec sets to true) when there is one, else the bare field cell. Never with ids: those are
// reserved through the creation-identity port and set at write time.
function newFieldCell(name, template) {
  const cell = template ? clone(template) : fieldCellIntent(name);
  delete cell.id;
  if (!cell.control) cell.control = { fieldName: name };
  delete cell.control.id;
  return cell;
}

// The FULL layout projection of a form, by part: `field:<name>` is every placement of that field control
// (section, slot, spans, readOnly, hidden — whatever the spec declares), and `columns:<section>` each
// section's column count. A field the form holds twice has both placements in its part. Non-field
// controls are not ownable here and are left out; their slots are guarded by the packer, not the baseline.
function formProjection(tabs) {
  const parts = {};
  (tabs || []).forEach((tab, ti) => ((tab && tab.columns) || []).forEach((column, ci) => ((column && column.sections) || []).forEach((section, si) => {
    const name = (section && section.name) || `/tabs/${ti}/columns/${ci}/sections/${si}`;
    parts[`columns:${name}`] = section.columns === undefined ? null : section.columns;
    const rows = section.rows || [];
    const g = slotGrid(rows, section.columns);
    for (const p of g.placed) {
      const cell = rows[p.row].cells[p.cell];
      const field = fieldOf(cell);
      if (!field) continue;
      (parts[`field:${field}`] || (parts[`field:${field}`] = [])).push({
        section: name, r: p.r, c: p.c, colspan: p.colspan, rowspan: p.rowspan,
        readOnly: !!(cell.control && cell.control.isReadOnly === true), hidden: cell.visible === false,
      });
    }
  })));
  for (const k of Object.keys(parts)) if (Array.isArray(parts[k])) parts[k].sort((a, b) => (canonicalJson(a) < canonicalJson(b) ? -1 : 1));
  return parts;
}

/**
 * Plan the declared layout of one form.
 *   input: { form: formSpec, formId, intentTabs (compileFormIntent(spec, form).tabs), sdk, created? }
 *   plan:  { key, formId, action: null|'noChange'|'update', sections: [{ pointer, rows, columns?, fresh }], tabs?,
 *            baseline: { intentSha256, partsSha256 }, desiredSha, operations, refused, unknown, origin }
 * `created` is true when this build made the form, which needs no adoption approval.
 */
async function planDeclaredFormLayout({ form, formId, intentTabs, sdk, created = false }, ctx = {}) {
  const key = formLayoutKey(form);
  const plan = { key, formId, table: String((form && (form.table || form.entity)) || '').toLowerCase(), action: null, sections: [], operations: [], refused: [], unknown: [], origin: created ? 'created' : 'adopted' };
  if (!isDeclaredForm(form)) return plan;
  const declared = declaredLayoutOf(form, intentTabs);
  if (declared.duplicates.length) {
    plan.refused.push(refusal(key, 'form-layout-duplicate-field', `a field is placed more than once on this form: ${[...new Set(declared.duplicates)].join(', ')}`));
    return plan;
  }
  let live;
  try {
    await sdk.fetchArtifact(ARTIFACT, formId);
    live = await sdk.getArtifact(ARTIFACT, formId);
  } catch (_) {
    plan.unknown.push(refusal(key, 'form-unreadable', 'the form could not be read'));
    return plan;
  }
  const owned = new Set();
  for (const s of declared.sections) for (const f of s.fields) owned.add(f.name);

  // Where each declared section is, and where each declared field's live cell is.
  const targets = [];
  for (const s of declared.sections) {
    const loc = findSectionLocation(live, s.section);
    if (!loc) {
      plan.refused.push(refusal(key, 'form-layout-section-missing', `the form has no section named ${s.section}`));
      return plan;
    }
    targets.push({ ...s, loc });
  }
  const carried = {};
  const touched = new Map();
  for (const t of targets) touched.set(t.loc.pointer, { loc: t.loc, fields: t.fields, width: t.columns !== undefined ? t.columns : t.loc.section.columns });
  for (const name of owned) {
    // Every live placement counts, in any section: picking the one in the declared section would quietly
    // decide which of two controls the spec owns, and leave the other one where it is.
    const found = findFieldCellLocations(live, name);
    if (found.length > 1) {
      plan.refused.push(refusal(key, 'form-layout-field-ambiguous', `the form holds ${name} in more than one place`));
      return plan;
    }
    if (!found.length) continue;
    const l = found[0];
    const section = sectionAt(live.tabs, l.sectionPointer);
    carried[name] = section.rows[l.rowIndex].cells[l.cellIndex];
    if (!touched.has(l.sectionPointer)) touched.set(l.sectionPointer, { loc: { pointer: l.sectionPointer, section }, fields: [], width: section.columns });
  }

  const desiredTabs = clone(live.tabs || []);
  let widthChanged = false;
  for (const [pointer, t] of touched) {
    const rows = t.loc.section.rows || [];
    const sectionKey = t.loc.section.name || pointer;
    const packed = packDeclaredLayout({ rows, width: t.width, fields: t.fields, owned, carried, templates: declared.templates, sectionKey });
    if (packed.refused) {
      plan.refused.push(refusal(key, packed.refused, `a control the spec does not declare no longer fits section ${sectionKey}`));
      return plan;
    }
    // The section's width is written with its rows: rows packed for two columns in a section that stays at
    // one would overflow it.
    const columns = Number(t.width) !== Number(t.loc.section.columns) ? t.width : undefined;
    if (columns === undefined && canonicalJson(packed.rows) === canonicalJson(rows)) continue;
    if (columns !== undefined) widthChanged = true;
    const entry = { pointer, rows: packed.rows, fresh: packed.fresh };
    if (columns !== undefined) entry.columns = columns;
    plan.sections.push(entry);
    setAt(desiredTabs, pointer.replace(/^\/tabs/, ''), 'rows', packed.rows);
    if (columns !== undefined) setAt(desiredTabs, pointer.replace(/^\/tabs/, ''), 'columns', columns);
  }
  // The baseline is the whole layout projection, the drift check judges only the parts this run changes
  // (see the header and reconcile-common partsDriftVerdict).
  const liveParts = formProjection(live.tabs);
  const desiredParts = formProjection(desiredTabs);
  plan.baseline = projectionBaseline(desiredParts);
  plan.desiredSha = plan.baseline.intentSha256;

  const binding = await lookupBinding(ctx, KIND, key);
  if (binding) plan.origin = binding.origin === 'created' ? 'created' : 'adopted';
  const verdict = partsDriftVerdict(binding, liveParts, desiredParts);
  const unapproved = verdict === 'unbound' && !created && !isAuthorized(ctx.authorizedAdoption, key);
  if (!plan.sections.length) {
    // Nothing to write: not a refusal, but no binding either unless adoption was approved (bindsUnchanged).
    plan.action = 'noChange';
    plan.bindUnchanged = !unapproved;
    return plan;
  }
  if (unapproved) {
    plan.refused.push(refusal(key, 'form-layout-adoption-not-authorized', 'this form exists and the spec has not managed its layout before; approve adopting it first'));
    return plan;
  }
  if (verdict === 'drift' && !isAuthorized(ctx.authorizedOverwrite, key)) {
    plan.refused.push(refusal(key, 'form-layout-drift', 'the layout of declared fields changed outside the spec since the last build; refresh the spec or approve the overwrite'));
    return plan;
  }
  plan.action = 'update';
  // More than one section changes when a field moves between sections, and a section's width changes with
  // its rows: one /tabs mutation writes all of it, so a failure cannot leave the field in both sections or
  // in neither, or rows packed for a width the section does not have.
  if (plan.sections.length > 1 || widthChanged) plan.tabs = desiredTabs;
  plan.operations.push(operation({ key, kind: KIND, target: formId, action: 'update', publicationScopes: [{ type: ARTIFACT, id: formId, table: plan.table }] }));
  return plan;
}

function setAt(tabs, rest, prop, value) {
  const m = /^\/(\d+)\/columns\/(\d+)\/sections\/(\d+)$/.exec(rest);
  tabs[Number(m[1])].columns[Number(m[2])].sections[Number(m[3])][prop] = value;
}

function sectionAt(tabs, pointer) {
  const m = /^\/tabs\/(\d+)\/columns\/(\d+)\/sections\/(\d+)$/.exec(pointer);
  return tabs[Number(m[1])].columns[Number(m[2])].sections[Number(m[3])];
}

// The planned write with the reserved ids set on every new cell: `/tabs` when the plan writes more than one
// section or a width, else the one section's rows. The plan itself is left as it was (a retry re-runs this).
function materialize(plan, childIds) {
  const tabs = plan.tabs ? clone(plan.tabs) : null;
  const sections = plan.sections.map((s) => {
    const rows = tabs ? sectionAt(tabs, s.pointer).rows : clone(s.rows);
    for (const f of s.fresh || []) {
      const cell = rows[f.row].cells[f.cell];
      cell.id = childIds[f.keys.cell];
      if (f.keys.control && cell.control) cell.control.id = childIds[f.keys.control];
    }
    return { pointer: s.pointer, rows };
  });
  return { tabs, sections };
}

async function applyDeclaredFormLayout(plan, { sdk }, ctx = {}) {
  const result = emptyResult();
  result.refused.push(...plan.refused);
  result.unknown.push(...plan.unknown);
  if (plan.refused.length || plan.unknown.length || !plan.action) return result;
  const record = () => bindingRecord(ctx, { kind: KIND, key: plan.key, id: plan.formId, origin: plan.origin, ...plan.baseline });
  if (plan.action === 'noChange') {
    result.unchanged.push({ key: plan.key, kind: KIND, id: plan.formId });
    if (plan.bindUnchanged) result.managedBindings.push(record());
    return result;
  }
  const write = async (childIds) => {
    const out = materialize(plan, childIds);
    try {
      if (out.tabs) await sdk.updateElement(ARTIFACT, plan.formId, '/tabs', out.tabs);
      else await sdk.updateElement(ARTIFACT, plan.formId, `${out.sections[0].pointer}/rows`, out.sections[0].rows);
    } catch (err) {
      return { outcome: 'refused', local: true, code: 'VALIDATION_ERROR', rules: rulesOf(err) };
    }
    return pushIfChanged(sdk, ARTIFACT, plan.formId);
  };
  // Every new cell and control gets its ids from the creation-identity port before anything is sent, so
  // an answer lost after the push is recovered by those same ids rather than a second set the SDK mints.
  const childKeys = plan.sections.flatMap((s) => (s.fresh || []).flatMap((f) => Object.values(f.keys)));
  let pushed = null;
  if (childKeys.length) {
    const run = await createThroughPort(ctx, { kind: KIND, key: plan.key, identity: [plan.formId], childKeys }, async (ids) => {
      pushed = await write(ids.childIds || {});
      return pushed;
    });
    if (run.status === 'adopted') {
      // The maker resolved an earlier lost write by naming the cells it made. Nothing is written or bound
      // now: the next run reads the form as it is and, if that write landed, finds nothing left to do.
      result.refused.push(refusal(plan.key, 'creation-adopted-rerun', 'the cells an earlier write added were resolved; run again to apply the spec'));
      return result;
    }
    if (!pushed) {
      // The port refused before anything was written (no port, an unresolved earlier create, ...).
      if (run.status === 'unknown') result.unknown.push(refusal(plan.key, 'form-layout-write-unknown', 'the form write did not report its outcome; check the form'));
      else result.refused.push(refusal(plan.key, run.code, 'new form cells need the creation-identity port, and it did not allow this write; nothing was written'));
      return result;
    }
  } else {
    pushed = await write({});
  }
  if (pushed.outcome === 'refused') {
    const message = pushed.local ? 'the SDK refused the layout before writing it' : 'the form was not saved';
    result.refused.push({ ...refusal(plan.key, 'form-layout-rejected', message), rules: pushed.rules || [] });
    return result;
  }
  if (pushed.outcome === 'unknown') {
    result.unknown.push(refusal(plan.key, 'form-layout-write-unknown', 'the form write did not report its outcome; check the form'));
    return result;
  }
  result.saved.push({ key: plan.key, kind: KIND, id: plan.formId });
  const scope = { type: ARTIFACT, id: plan.formId, table: plan.table };
  if (queuePublication(ctx, scope)) result.pendingPublish.push(scope);
  result.managedBindings.push(record());
  return result;
}
module.exports = {
  isDeclaredForm,
  formLayoutKey,
  declaredLayoutOf,
  packDeclaredLayout,
  formProjection,
  planDeclaredFormLayout,
  applyDeclaredFormLayout,
};
