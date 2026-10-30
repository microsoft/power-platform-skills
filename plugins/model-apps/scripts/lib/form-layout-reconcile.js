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
//     it was, the same way.
// Positions come from the column-slot model (form-occupancy.js slotGrid), not the width-only rowOccupancy
// the additive path uses: keeping a maker's cell in column 1 beside a row-spanning cell needs positions.
//
// What is owned: the order, the section and the spans of the declared fields, plus readOnly / hidden when
// the spec states them. An explicit `false` clears the flag, but only on a declared field's own control;
// a flag the spec leaves out is left as it is. Existing cells keep their ids, labels and every other
// property (the SDK round-trips them), so a re-run with nothing to change sends nothing.
//
// Refusals (nothing is written for that form): a field declared twice, a field the form holds in more
// than one place, a declared section the form does not have, a maker's cell that no longer fits the
// section (it overruns the grid), a layout changed outside the spec since the last build, and a first
// edit of a form the spec has not managed before without adoption approval.

const { slotGrid } = require('./form-occupancy.js');
const { fieldCellIntent, isNonFieldControl, findSectionLocation, findFieldCellLocations } = require('./artifact-intent.js');
const {
  emptyResult,
  operation,
  refusal,
  isAuthorized,
  lookupBinding,
  bindingRecord,
  driftVerdict,
  pushIfChanged,
  queuePublication,
  intentSha256,
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
  for (const tab of (formSpec && formSpec.tabs) || []) {
    for (const section of (tab && tab.sections) || []) {
      for (const entry of (section && section.fields) || []) if (entry && typeof entry === 'object') take(entry.name, entry);
    }
  }
  return flags;
}

/**
 * The declared layout of a form: its sections that hold bound fields, each with its fields in reading
 * order. Section names, field order and spans come from the COMPILED intent (compileFormIntent), so they
 * cannot disagree with what the create path builds; readOnly / hidden come from the raw spec, keeping
 * an explicit false. Non-field controls (sub-grids, notes, quick views) are not part of it.
 *   { sections: [{ section, columns, fields: [{ name, colspan?, rowspan?, readOnly?, hidden? }] }], duplicates: [name] }
 */
function declaredLayoutOf(formSpec, intentTabs) {
  const flags = declaredFlags(formSpec);
  const sections = [];
  const seen = new Set();
  const duplicates = [];
  for (const tab of intentTabs || []) {
    for (const column of (tab && tab.columns) || []) {
      for (const section of (column && column.sections) || []) {
        const fields = [];
        for (const row of (section && section.rows) || []) {
          for (const cell of (row && row.cells) || []) {
            const control = cell && cell.control;
            if (!control || !control.fieldName || isNonFieldControl(control)) continue;
            const name = String(control.fieldName).toLowerCase();
            if (seen.has(name)) { duplicates.push(name); continue; }
            seen.add(name);
            const f = { name };
            if (cell.colspan !== undefined) f.colspan = cell.colspan;
            if (cell.rowspan !== undefined) f.rowspan = cell.rowspan;
            Object.assign(f, flags[name] || {});
            fields.push(f);
          }
        }
        if (fields.length) sections.push({ section: section.name, columns: section.columns, fields });
      }
    }
  }
  return { sections, duplicates };
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
 * Answers { rows } or { refused: code }.
 */
function packDeclaredLayout({ rows, width, fields = [], owned = new Set(), carried = {} }) {
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
  // Live spacers by slot: a spacer re-emitted where one already stands is the same cell (same id), so an
  // unchanged layout serializes byte-for-byte as it was read.
  const liveSpacers = {};
  for (const p of live.placed) {
    const cell = cellAt(p);
    if (isSpacer(cell)) liveSpacers[`${p.r},${p.c}`] = cell;
    else if (!mobile(cell)) {
      for (let y = p.r; y < p.r + p.rowspan; y += 1) for (let x = p.c; x < p.c + p.colspan; x += 1) rowAt(y)[x] = { origin: [p.r, p.c] };
      rowAt(p.r)[p.c] = { origin: [p.r, p.c], cell, colspan: p.colspan, rowspan: p.rowspan };
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
    const cell = was ? clone(was) : fieldCellIntent(f.name);
    if (f.colspan !== undefined || (was && Number(was.colspan) > w)) cell.colspan = span;
    if (f.rowspan !== undefined) cell.rowspan = rowspan;
    if (f.readOnly === true) cell.control.isReadOnly = true;
    else if (f.readOnly === false && was) cell.control.isReadOnly = false;
    if (f.hidden === true) cell.visible = false;
    else if (f.hidden === false && was) cell.visible = true;
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
        if (kept) { cells.push(...spacers, kept); spacers = []; } else spacers.push({ control: null });
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
    // (empty in the live layout, and not emptied by this pack) stays; one this pack emptied goes.
    const liveRow = rows[r];
    const wasEmpty = liveRow && !((liveRow.cells || []).length);
    if (!cells.length && !reserved && !wasEmpty) continue;
    out.push(liveRow && !cells.length && wasEmpty ? liveRow : { ...(liveRow ? clone(liveRow) : {}), cells });
  }
  return { rows: out };
}

// The owned part of a section's layout, for the drift check: where each declared field sits, plus the
// spans and flags the spec states. Undeclared properties are not owned, so a maker changing them is not drift.
function projectSection(sectionName, rows, width, declaredByName) {
  const g = slotGrid(rows, width);
  const out = [];
  for (const p of g.placed) {
    const cell = rows[p.row].cells[p.cell];
    const name = fieldOf(cell);
    const f = declaredByName[name];
    if (!f) continue;
    const e = { section: sectionName, name, r: p.r, c: p.c };
    if (f.colspan !== undefined) e.colspan = p.colspan;
    if (f.rowspan !== undefined) e.rowspan = p.rowspan;
    if (f.readOnly !== undefined) e.readOnly = !!(cell.control && cell.control.isReadOnly === true);
    if (f.hidden !== undefined) e.hidden = cell.visible === false;
    out.push(e);
  }
  return out;
}

const sortProjection = (list) => list.sort((a, b) => canonicalJson(a) < canonicalJson(b) ? -1 : 1);

/**
 * Plan the declared layout of one form.
 *   input: { form: formSpec, formId, intentTabs (compileFormIntent(spec, form).tabs), sdk, created? }
 *   plan:  { key, formId, action: null|'noChange'|'update', sections: [{ pointer, rows }], tabs?, desiredSha,
 *            operations, refused, unknown, origin }
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
  const declaredByName = {};
  for (const s of declared.sections) for (const f of s.fields) { owned.add(f.name); declaredByName[f.name] = f; }

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
  for (const t of targets) touched.set(t.loc.pointer, { loc: t.loc, fields: t.fields, width: t.columns || t.loc.section.columns });
  for (const name of owned) {
    const found = findFieldCellLocations(live, name);
    const home = targets.find((t) => t.fields.some((f) => f.name === name));
    const inHome = found.filter((l) => l.sectionPointer === home.loc.pointer);
    const pick = inHome.length ? inHome : found;
    if (pick.length > 1) {
      plan.refused.push(refusal(key, 'form-layout-field-ambiguous', `the form holds ${name} in more than one place`));
      return plan;
    }
    if (!pick.length) continue;
    const l = pick[0];
    const section = findSectionWhereByPointer(live, l.sectionPointer);
    carried[name] = section.rows[l.rowIndex].cells[l.cellIndex];
    if (!touched.has(l.sectionPointer)) touched.set(l.sectionPointer, { loc: { pointer: l.sectionPointer, section }, fields: [], width: section.columns });
  }

  const liveProjection = [];
  const desiredProjection = [];
  for (const [pointer, t] of touched) {
    const rows = t.loc.section.rows || [];
    const packed = packDeclaredLayout({ rows, width: t.width, fields: t.fields, owned, carried });
    if (packed.refused) {
      plan.refused.push(refusal(key, packed.refused, `a control the spec does not declare no longer fits section ${t.loc.section.name || pointer}`));
      return plan;
    }
    const name = t.loc.section.name || pointer;
    liveProjection.push(...projectSection(name, rows, t.loc.section.columns, declaredByName));
    desiredProjection.push(...projectSection(name, packed.rows, t.width, declaredByName));
    // Declared fields the form does not hold yet are new cells: not in the live projection.
    if (canonicalJson(packed.rows) !== canonicalJson(rows)) plan.sections.push({ pointer, rows: packed.rows });
  }
  const liveSha = intentSha256(sortProjection(liveProjection));
  plan.desiredSha = intentSha256(sortProjection(desiredProjection));

  const binding = await lookupBinding(ctx, KIND, key);
  if (binding) plan.origin = binding.origin === 'created' ? 'created' : 'adopted';
  const verdict = driftVerdict(binding, liveSha, plan.desiredSha);
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
  // More than one section changes when a field moves between sections: one /tabs mutation writes the
  // whole move, so a failure cannot leave the field in both sections or in neither.
  if (plan.sections.length > 1) {
    const tabs = clone(live.tabs || []);
    for (const s of plan.sections) setAt(tabs, s.pointer.replace(/^\/tabs/, ''), 'rows', s.rows);
    plan.tabs = tabs;
  }
  plan.operations.push(operation({ key, kind: KIND, target: formId, action: 'update', publicationScopes: [{ type: ARTIFACT, id: formId, table: plan.table }] }));
  return plan;
}

function findSectionWhereByPointer(form, pointer) {
  const m = /^\/tabs\/(\d+)\/columns\/(\d+)\/sections\/(\d+)$/.exec(pointer);
  return form.tabs[Number(m[1])].columns[Number(m[2])].sections[Number(m[3])];
}

function setAt(tabs, rest, prop, value) {
  const m = /^\/(\d+)\/columns\/(\d+)\/sections\/(\d+)$/.exec(rest);
  tabs[Number(m[1])].columns[Number(m[2])].sections[Number(m[3])][prop] = value;
}

async function applyDeclaredFormLayout(plan, { sdk }, ctx = {}) {
  const result = emptyResult();
  result.refused.push(...plan.refused);
  result.unknown.push(...plan.unknown);
  if (plan.refused.length || plan.unknown.length || !plan.action) return result;
  const record = () => bindingRecord(ctx, { kind: KIND, key: plan.key, id: plan.formId, intentSha256: plan.desiredSha, origin: plan.origin });
  if (plan.action === 'noChange') {
    result.unchanged.push({ key: plan.key, kind: KIND, id: plan.formId });
    if (plan.bindUnchanged) result.managedBindings.push(record());
    return result;
  }
  try {
    if (plan.tabs) await sdk.updateElement(ARTIFACT, plan.formId, '/tabs', plan.tabs);
    else await sdk.updateElement(ARTIFACT, plan.formId, `${plan.sections[0].pointer}/rows`, plan.sections[0].rows);
  } catch (err) {
    result.refused.push({ ...refusal(plan.key, 'form-layout-rejected', 'the SDK refused the layout before writing it'), rules: rulesOf(err) });
    return result;
  }
  const pushed = await pushIfChanged(sdk, ARTIFACT, plan.formId);
  if (pushed.outcome === 'refused') {
    result.refused.push({ ...refusal(plan.key, 'form-layout-rejected', 'the form was not saved'), rules: pushed.rules || [] });
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
  planDeclaredFormLayout,
  applyDeclaredFormLayout,
};
