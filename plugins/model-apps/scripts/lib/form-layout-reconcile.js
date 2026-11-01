'use strict';
// Declared form layout (`forms[].reconcile: "declared"`): the spec's bound fields sit exactly where it
// declares them, while every control the spec does not declare keeps exactly where it is.
//
// Without the opt-in the build keeps its additive behaviour (sdk-build's field/topology passes). With it:
//   - EXISTING form (planDeclaredFormLayout + applyDeclaredFormLayout): for each declared section the
//     cells of declared fields are packed again in the declared reading order, each at the first free
//     slot at or after the previous one. Every other cell — a maker's field, a sub-grid, a quick view, a
//     timeline, a spacer this build did not write, a row's own payload — is a FIXED OBSTACLE that keeps
//     its row, column and spans as they are at the section's OLD width. A declared field found in another
//     section moves here in the same write, keeping its ids and metadata. A free slot a later cell must
//     skip is held by a spacer cell (`control: null`, the SDK's shape for one); only spacers this build
//     recorded as its own may be recycled. A row this pack empties is kept while a maker's cell sits at
//     or below it, or while the row carries a payload of its own, so nothing the spec does not own moves
//     up or is dropped. A section is never moved and a section the spec places in a form column the tab
//     lacks refuses; an existing sub-grid / quick view must already show what is requested (a different
//     target, or any stated placement, refuses rather than being silently kept).
//   - NEW form (applyDeclaredFormCreate): the complete composite — packed fields, the timeline, sub-grids,
//     quick views and event handlers — is built locally with every id supplied (root through the
//     creation port, tabs / sections / cells / controls as its child ids) and sent in ONE push; then a
//     fresh read-back proves it before anything is bound or published.
// Positions come from the column-slot model (form-occupancy.js slotGrid), not the width-only
// rowOccupancy the additive path uses: a maker's cell in column 1 beside a row-spanning cell needs one.
//
// What is owned: the order, the section and the spans of declared fields, the width of a declared
// section when the spec states it, readOnly / hidden when the spec states them (an explicit false
// clears the flag), the declared tabs and sections, and a requested timeline / sub-grid / quick view
// that is missing. Labels, isRequired, PCF parameters and events of existing cells are never inferred
// from compiler defaults.
//
// Identities. The form's binding (kind 'form-layout') baselines the FULL layout projection
// (formProjection: every field placement and each section's width) with a hash per part, so a part
// someone else changed since the last build refuses as drift while a newly declared part is an edit.
// Every tab, section, cell and control the build relies on is recorded as an ordinary child binding
// (kind 'form-layout-child', `parentKey` = the form's key); a container is found by its recorded id,
// else by a unique name in its exact parent, and a helper-owned spacer is recognised only by its
// recorded id at its recorded slot. A recorded field cell / control or host is authoritative: when the
// form now holds another cell for that field, the build refuses (create-completion-required) instead of
// following the field name. The stored row must also be the form type and table the key names. Every
// child — in the first create and on any later run — takes its id from ONE creation family: the form's
// kind and key under the actual form id as parent, so a re-run after an unsettled add finds that id.
//
// Proof. After a write a fresh read must hold every id written, the owned projection, a rendering
// timeline, each requested host target and handler, and — compared with the form as it was read before
// the write — every container, row payload and cell the spec does not own; anything else is unknown.
// An authoritative native match from the creation port is never a creation: it is taken only as an
// approved adoption with the same proof, and saved as `matched`.
//
// Entry points for the coordinator: reconcileDeclaredForm (binding first, then the coordinator's resolution
// — the creation port's continuation, else the name — then plan/apply or create; it never settles: the
// coordinator settles its result through the shared createFeatureSettlement), declaredHostsOf and
// verifyDeclaredForm.
//
// Publication. Helpers never publish: a write that was sent records its scope in `pendingPublish`, and
// the coordinator's settlement (reconcile-common commitPublication, publication-barrier.js) queues it
// only when the whole result settled cleanly. A refused or unknown write keeps the entry, marked
// withheld, so the table stays unpublished for the rest of the run.

const { slotGrid } = require('./form-occupancy.js');
const { placementOf } = require('./form-subgrid-placement.js');
const {
  fieldCellIntent,
  isNonFieldControl,
  findFieldCellLocations,
  subgridSectionIntent,
  quickViewCellIntent,
  formEventsRegionIntent,
  sectionGridWidth,
} = require('./artifact-intent.js');
const { formColumnsOf } = require('./app-spec.js');
const {
  TIMELINE_CLASS_ID,
  TIMELINE_CONTROL_ID,
  timelineRowsIntent,
  wantsTimeline,
  timelinesOf,
  timelineProblem,
  timelineRefusal,
  controlIdTaken,
} = require('./form-timeline.js');
const { runManagedCreate } = require('./managed-create.js');
const {
  emptyResult,
  refusal,
  isAuthorized,
  lookupBinding,
  boundIdentity,
  bindingRecord,
  partsDriftVerdict,
  projectionBaseline,
  pushChecked,
  canonicalJson,
  normalizeGuid,
} = require('./reconcile-common.js');

const KIND = 'form-layout';
// Binding records of the tabs, sections, cells, controls and spacers a declared form relies on.
const CHILD_KIND = 'form-layout-child';
// New children of an EXISTING form are reserved under the SAME creation request family as the form's own
// create — kind 'form-layout', the form's key, its child key — with the actual form id as `parentId`. A
// stable creation port derives a child's id from (kind, key, child key), so a cell added on a later run
// gets the id it would have had if the form had been created with it, and a re-run after an unsettled
// add finds that very id on the form.
const ARTIFACT = 'form';
// Stable platform control class ids (the SDK's ControlClassIds), the same constants sdk-build uses.
const SUBGRID_CLASS_ID = 'E7A81278-8635-4D9E-8D4D-59480B391C5B';
const QUICK_VIEW_CLASS_ID = '5C5600E0-1D6E-4205-A272-BE80DA87FD42';
const FORM_EVENTS = new Set(['onload', 'onsave', 'onchange']);
// Marker properties on the planned tree. They never reach the SDK: materialize strips them.
//   __fresh  child key of an object this build adds (its id comes from the creation port)
//   __track  child key of an existing object the binding records
//   __skey   the key a section's helper spacers are recorded under
//   __repaired  a timeline host replaced whole by the repair (its old cells are not obstacles)
const MARKERS = ['__fresh', '__track', '__skey', '__repaired'];

const lc = (v) => String(v == null ? '' : v).trim().toLowerCase();
const idText = (v) => normalizeGuid(v) || lc(v);
const sameId = (a, b) => !!idText(a) && idText(a) === idText(b);
const clone = (v) => JSON.parse(JSON.stringify(v));

function isDeclaredForm(form) {
  return !!form && form.reconcile === 'declared';
}

const tableOf = (form) => lc(form && (form.table || form.entity));
const formTypeOf = (form) => (form && form.formType) || 'Main';
// A form type as the systemform `type` code, so the spec's name ('QuickView'), the SDK's name and a raw
// code compare alike (systemform type: Main 2, QuickViewForm 6, QuickCreate 7, Card 11 —
// https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/systemform).
const FORM_TYPE_CODES = { main: 2, quickview: 6, quickviewform: 6, quickcreate: 7, card: 11 };
const formTypeCode = (t) => {
  const named = FORM_TYPE_CODES[lc(t).replace(/[^a-z]/g, '')];
  if (named !== undefined) return named;
  return Number.isFinite(Number(t)) && String(t).trim() !== '' ? Number(t) : lc(t);
};

// The form type is part of the key: a Main and a Quick Create form of one table may share a name, and
// they are different forms.
function formLayoutKey(form) {
  return `${tableOf(form)}/${lc(formTypeOf(form))}/${lc(form && form.name)}`;
}

// readOnly / hidden as the author wrote them: true, false, or undefined (said nothing). The additive
// compiler keeps only `true` (it must never un-hide a maker's control), so the declared path reads the
// raw entries itself. Spans likewise: the compiled cell carries a span already clamped to the compiled
// section, and an omitted span compiles to nothing, so only a number the author wrote is an edit.
const triState = (v) => (v === true ? true : v === false ? false : undefined);
const rawTabs = (formSpec) => (formSpec && Array.isArray(formSpec.tabs) ? formSpec.tabs : []);

function declaredOptions(formSpec) {
  const out = {};
  const take = (name, src) => {
    const key = lc(name);
    if (!key || !src || typeof src !== 'object') return;
    const cur = out[key] || (out[key] = {});
    for (const k of ['readOnly', 'hidden']) if (triState(src[k]) !== undefined) cur[k] = triState(src[k]);
    for (const k of ['colspan', 'rowspan']) if (typeof src[k] === 'number' && src[k] >= 1) cur[k] = Math.floor(src[k]);
  };
  const fo = formSpec && formSpec.fieldOptions;
  if (fo && typeof fo === 'object' && !Array.isArray(fo)) for (const k of Object.keys(fo)) take(k, fo[k]);
  // Inline entries win over the form-level fieldOptions default, as in the additive compiler. Both tab
  // shapes the spec accepts are walked — `tabs[].sections` and `tabs[].columns[].sections` — through
  // formColumnsOf, the compiler's own reading of them.
  for (const tab of rawTabs(formSpec)) {
    for (const column of formColumnsOf(tab)) {
      for (const section of (column && column.sections) || []) {
        for (const entry of (section && section.fields) || []) if (entry && typeof entry === 'object') take(entry.name, entry);
      }
    }
  }
  return out;
}

// The column count the spec STATES for the section at (ti, ci, si), or undefined. The compiled intent
// always carries one (an omitted width compiles to 1), so reading it there would make an omitted width
// shrink a maker's wider section. When stated, the compiled value is used: it is already capped for the
// form type (a Quick Create or Quick View section is one column).
function statedWidth(formSpec, ti, ci, si, compiled) {
  const tab = rawTabs(formSpec)[ti];
  const column = tab ? formColumnsOf(tab)[ci] : null;
  const section = column && Array.isArray(column.sections) ? column.sections[si] : null;
  return section && typeof section.columns === 'number' ? compiled : undefined;
}

const fieldOf = (cell) => {
  const control = cell && cell.control;
  if (!control || !control.fieldName || isNonFieldControl(control)) return '';
  return lc(control.fieldName);
};
const isSpacer = (cell) => !!cell && !cell.control;
const rowHasPayload = (row) => !!row && !!row.bag && typeof row.bag === 'object'
  && ((Array.isArray(row.bag.a) && row.bag.a.length > 0) || (Array.isArray(row.bag.c) && row.bag.c.length > 0));

/**
 * The declared layout of a form, from its COMPILED intent (compileFormIntent) so section names and field
 * order cannot disagree with what the create path builds, and from the raw spec for flags and spans.
 *   { auto, sections: [{ tab, section, ci, columns?, fields: [{ name, colspan?, rowspan?, readOnly?, hidden? }],
 *     compiledTab, compiledSection }], duplicates: [name], templates: { name: compiled cell } }
 * `auto` is true when the spec authored no tabs: the compiler then invents a 'section_general' that the
 * deployed form need not have, so an existing form keeps its own geometry (see planDeclaredFormLayout).
 * Non-field controls (sub-grids, the timeline, quick views) are not part of it.
 */
function declaredLayoutOf(formSpec, intentTabs) {
  const options = declaredOptions(formSpec);
  const auto = !Array.isArray(formSpec && formSpec.tabs);
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
            const name = fieldOf(cell);
            if (!name) continue;
            if (seen.has(name)) { duplicates.push(name); continue; }
            seen.add(name);
            templates[name] = cell;
            fields.push({ name, ...(options[name] || {}) });
          }
        }
        if (!fields.length) return;
        // `columnsStated`: the spec wrote this tab in the `tabs[].columns[].sections` shape, so the column a
        // section sits in is part of what it asks for. In the `tabs[].sections` shape the column is unstated.
        const rawTab = rawTabs(formSpec)[ti];
        const columnsStated = !!rawTab && Array.isArray(rawTab.columns);
        const entry = { tab: tab.name, section: section.name, ci, columnsStated, fields, compiledTab: tab, compiledSection: section };
        const width = auto ? undefined : statedWidth(formSpec, ti, ci, si, section.columns);
        if (width !== undefined) entry.columns = width;
        sections.push(entry);
      });
    });
  });
  return { auto, sections, duplicates, templates };
}

const clampWidth = (w) => Math.max(1, Math.min(4, Math.floor(Number(w)) || 1));

// The explicit flags of a declared field on its own control. An explicit false is written where the
// control holds the flag (isReadOnly:false, visible:true); an omitted flag is left as it is.
function applyFlags(cell, f) {
  if (!cell.control) return;
  if (f.readOnly === true) cell.control.isReadOnly = true;
  else if (f.readOnly === false && cell.control.isReadOnly === true) cell.control.isReadOnly = false;
  if (f.hidden === true) cell.visible = false;
  else if (f.hidden === false && cell.visible === false) cell.visible = true;
}

// A cell for a declared field the form does not hold yet: the compiled cell (it carries isRequired and
// the flags the spec sets to true) without ids or compiled spans — the ids come from the creation port
// at write time, the spans from the raw spec.
function newFieldCell(name, template) {
  const cell = template ? clone(template) : fieldCellIntent(name);
  for (const k of ['id', 'colspan', 'rowspan', ...MARKERS]) delete cell[k];
  if (!cell.control) cell.control = { fieldName: name };
  delete cell.control.id;
  cell.__fresh = `cell:${name}`;
  cell.control.__fresh = `control:${name}`;
  return cell;
}

/**
 * Pack one section.
 *   rows         its live rows (a new section: [])
 *   width        the width the section will have; oldWidth the width it has now (coordinates of every
 *                obstacle are frozen at oldWidth, then must still fit at width)
 *   fields       the declared fields that belong here, in order
 *   owned        every declared field name the pack may move (a declared field of another section that
 *                sits here is moved out)
 *   carried      the live cell of each declared field wherever it is (name -> cell), so a moved or repacked
 *                cell keeps its ids, label, parameters and every other property
 *   templates    name -> compiled cell, the starting point of a cell the form does not hold yet
 *   sectionKey   names the section in the child keys of new spacers
 *   ownedSpacers lowercased ids of spacers this build recorded at their current slot: the only spacers it
 *                may drop or recycle; every other spacer is an obstacle
 *   append       start packing after the last obstacle instead of at the top (adding fields to a section
 *                whose existing cells all stay)
 * Answers { rows } — new cells carry `__fresh` child keys, carried ones `__track` — or { refused: code }.
 */
function packDeclaredLayout({ rows = [], width, oldWidth, fields = [], owned = new Set(), carried = {}, templates = {}, sectionKey = '', ownedSpacers = new Set(), append = false }) {
  const w = clampWidth(width);
  const ow = clampWidth(oldWidth === undefined ? width : oldWidth);
  const live = slotGrid(rows, ow);
  // A row's own payload — attributes or child nodes on the <row> element beyond its cells, read as a
  // non-empty `bag` (the SDK's round-trip store), e.g. `<row data-x="1">` → { cells, bag: { a: [['data-x',
  // '1']], c: [] } }; a plain row reads `bag: { a: [], c: [] }` — is a fixed obstacle like a maker's cell:
  // the row is never dropped, and no row above it is.
  const payloadRows = new Set();
  rows.forEach((row, r) => { if (rowHasPayload(row)) payloadRows.add(r); });
  const cellAt = (p) => rows[p.row].cells[p.cell];
  const ownedSpacer = (cell) => isSpacer(cell) && !!cell.id && ownedSpacers.has(idText(cell.id));
  const mobile = (cell) => ownedSpacer(cell) || (!!fieldOf(cell) && owned.has(fieldOf(cell)));
  for (const o of live.overflow) {
    if (!mobile(rows[o.row].cells[o.cell])) return { refused: 'form-layout-obstacle-unplaceable' };
  }
  const grid = [];
  const rowAt = (r) => {
    while (grid.length <= r) grid.push(new Array(w).fill(null));
    return grid[r];
  };
  // Helper-owned spacers by slot: one re-emitted where it already stands is the same cell (same id), so an
  // unchanged layout serializes byte-for-byte as it was read.
  const recyclable = {};
  // The last row an obstacle covers: rows above it may not be dropped (see the row loop below).
  let lastFixed = payloadRows.size ? Math.max(...payloadRows) : -1;
  let cr = 0;
  let cc = 0;
  for (const p of live.placed) {
    const cell = cellAt(p);
    if (mobile(cell)) {
      if (isSpacer(cell)) recyclable[`${p.r},${p.c}`] = cell;
      continue;
    }
    // Narrowing that would cut through an obstacle is refused: a maker's control is never clamped or
    // moved to make the declared width fit.
    if (p.c + p.colspan > w) return { refused: 'form-layout-narrowing-refused' };
    for (let y = p.r; y < p.r + p.rowspan; y += 1) for (let x = p.c; x < p.c + p.colspan; x += 1) rowAt(y)[x] = { origin: [p.r, p.c] };
    rowAt(p.r)[p.c] = { origin: [p.r, p.c], cell, colspan: p.colspan, rowspan: p.rowspan };
    lastFixed = Math.max(lastFixed, p.r + p.rowspan - 1);
    if (append && (p.r > cr || (p.r === cr && p.c + p.colspan > cc))) { cr = p.r; cc = p.c + p.colspan; }
  }
  if (cc >= w) { cr += 1; cc = 0; }
  const isFree = (r, c, span, rowspan) => {
    if (c + span > w) return false;
    for (let y = r; y < r + rowspan; y += 1) for (let x = c; x < c + span; x += 1) if (rowAt(y)[x]) return false;
    return true;
  };
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
    let cell;
    if (was) {
      cell = clone(was);
      for (const k of MARKERS) delete cell[k];
      cell.__track = `cell:${f.name}`;
      if (cell.control && cell.control.id) cell.control.__track = `control:${f.name}`;
    } else {
      cell = newFieldCell(f.name, templates[f.name]);
      if (f.readOnly === false) cell.control.isReadOnly = false;
    }
    if (f.colspan !== undefined || (was && Number(was.colspan) > w)) cell.colspan = span;
    if (f.rowspan !== undefined) cell.rowspan = rowspan;
    applyFlags(cell, f);
    for (let y = r; y < r + rowspan; y += 1) for (let x = c; x < c + span; x += 1) rowAt(y)[x] = { origin: [r, c] };
    rowAt(r)[c] = { origin: [r, c], cell, colspan: span, rowspan };
    if (c + span >= w) { cr = r + 1; cc = 0; } else { cr = r; cc = c + span; }
  }
  // Rows past the live section that only a span reaches into are not added: the span renders without
  // them, and adding them would make every later run see a change that is not there.
  let lastContent = -1;
  for (let r = 0; r < grid.length; r += 1) if (grid[r].some((slot) => slot && slot.origin[0] === r)) lastContent = r;
  const out = [];
  for (let r = 0; r < grid.length || r < rows.length; r += 1) {
    if (r > lastContent && r >= rows.length) break;
    const slots = grid[r] || new Array(w).fill(null);
    const cells = [];
    let pending = [];
    let reserved = false;
    for (let c = 0; c < w; c += 1) {
      const slot = slots[c];
      if (!slot) {
        // A free slot is written only when a later cell of the row must skip it — as the helper spacer
        // already standing there, else a new one. A trailing free slot needs nothing.
        pending.push(recyclable[`${r},${c}`] || { control: null, __fresh: `spacer:${sectionKey}:${r}:${c}` });
        continue;
      }
      const [or, oc] = slot.origin;
      if (or === r && oc === c) {
        cells.push(...pending, slot.cell);
        pending = [];
      } else {
        // A slot a span from above covers: the row's cells flow around it, so it takes no cell, and a
        // spacer is never written over it.
        pending = [];
        if (or < r) reserved = true;
      }
    }
    // A row that holds nothing and is not crossed by a span above is a blank line. One the maker left
    // (empty in the live layout) stays. One this pack emptied goes — but only below the last row an
    // obstacle covers: dropping a row above one moves that control (and every later row) up.
    const liveRow = rows[r];
    const wasEmpty = !!liveRow && !((liveRow.cells || []).length);
    if (!cells.length && !reserved && !wasEmpty && !payloadRows.has(r) && r > lastFixed) continue;
    out.push(liveRow && !cells.length && wasEmpty ? liveRow : { ...(liveRow ? clone(liveRow) : {}), cells });
  }
  return { rows: out };
}

/**
 * Slot-packed rows for the cells of one section of a NEW declared form, in their compiled order. The
 * compiler's width-only rowsFromCells lets a cell after a middle row-spanning one run past the grid; this
 * reserves the spanned columns on the rows beneath. Plain intent cells, no markers.
 */
function declaredSlotRows(cells, width) {
  const fields = [];
  const templates = {};
  for (const cell of cells || []) {
    const name = fieldOf(cell);
    if (!name) continue;
    templates[name] = cell;
    const f = { name };
    if (typeof cell.colspan === 'number') f.colspan = cell.colspan;
    if (typeof cell.rowspan === 'number') f.rowspan = cell.rowspan;
    fields.push(f);
  }
  const packed = packDeclaredLayout({ rows: [], width, fields, owned: new Set(fields.map((f) => f.name)), templates });
  return stripMarkers(packed.rows.map((row) => ({ ...row, cells: row.cells.map((cell) => {
    const c = { ...cell, control: cell.control ? { ...cell.control } : cell.control };
    const t = templates[fieldOf(c)];
    if (t && t.colspan !== undefined && c.colspan === undefined) c.colspan = t.colspan;
    return c;
  }) })));
}

// Where a section stands, qualified by its tab and form column: `<tab name>/<column index>/<section name>`
// (`#<index>` for a nameless tab or section). Section names are unique only within a tab, so a bare name
// would make a section of another tab — and a field moved into it — look like the declared one.
function sectionPath(tab, ti, ci, section, si) {
  return `${lc(tab && tab.name) || `#${ti}`}/${ci}/${lc(section && section.name) || `#${si}`}`;
}

// The FULL layout projection of a form, by part: `field:<name>` is every placement of that field control
// (its qualified section path, slot, spans, readOnly, hidden), and `columns:<section path>` each section's
// column count (a section moved to another tab or form column is another part). A field the form holds
// twice has both placements in its part, and two sections at one path both widths in theirs. Non-field
// controls are not ownable here; their slots are guarded by the packer, validateDesired and the stored
// proof's foreign inventory, not the baseline.
function formProjection(tabs) {
  const parts = {};
  const push = (k, v) => (parts[k] || (parts[k] = [])).push(v);
  eachSection(tabs, (section, pointer, tab) => {
    const at = /^\/tabs\/(\d+)\/columns\/(\d+)\/sections\/(\d+)$/.exec(pointer);
    const where = sectionPath(tab, Number(at[1]), Number(at[2]), section, Number(at[3]));
    push(`columns:${where}`, { width: section.columns === undefined ? null : section.columns });
    const rows = section.rows || [];
    const g = slotGrid(rows, section.columns);
    for (const p of g.placed) {
      const cell = rows[p.row].cells[p.cell];
      const field = fieldOf(cell);
      if (!field) continue;
      push(`field:${field}`, {
        section: where, r: p.r, c: p.c, colspan: p.colspan, rowspan: p.rowspan,
        readOnly: !!(cell.control && cell.control.isReadOnly === true), hidden: cell.visible === false,
      });
    }
  });
  for (const k of Object.keys(parts)) parts[k].sort((a, b) => (canonicalJson(a) < canonicalJson(b) ? -1 : 1));
  return parts;
}

function eachSection(tabs, fn) {
  (tabs || []).forEach((tab, ti) => ((tab && tab.columns) || []).forEach((column, ci) => ((column && column.sections) || []).forEach((section, si) => {
    fn(section, `/tabs/${ti}/columns/${ci}/sections/${si}`, tab);
  })));
}

function eachCell(tabs, fn) {
  eachSection(tabs, (section, pointer) => ((section && section.rows) || []).forEach((row, ri) => ((row && row.cells) || []).forEach((cell, ci) => {
    if (cell) fn(cell, section, pointer, ri, ci);
  })));
}

function sectionAt(tabs, pointer) {
  const m = /^\/tabs\/(\d+)\/columns\/(\d+)\/sections\/(\d+)$/.exec(pointer);
  return tabs[Number(m[1])].columns[Number(m[2])].sections[Number(m[3])];
}

function stripObject(o) {
  if (o && typeof o === 'object') for (const k of MARKERS) delete o[k];
}

// Remove every marker from a tree of tabs (or rows); answers the same tree.
function stripMarkers(tree) {
  const walk = (v) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== 'object') return;
    stripObject(v);
    for (const k of ['columns', 'sections', 'rows', 'cells']) if (Array.isArray(v[k])) walk(v[k]);
    if (v.control && typeof v.control === 'object') stripObject(v.control);
  };
  walk(tree);
  return tree;
}

// Every `__fresh` child key in a planned tree, in document order.
function freshKeys(tabs) {
  const keys = [];
  const take = (o) => { if (o && o.__fresh) keys.push(o.__fresh); };
  for (const tab of tabs || []) {
    take(tab);
    eachSection([tab], (section) => {
      take(section);
      for (const row of section.rows || []) for (const cell of row.cells || []) { take(cell); if (cell) take(cell.control); }
    });
  }
  return keys;
}

// Every id the tree carries — tabs, sections, cells and controls — lowercased, with the duplicates.
function treeIds(tabs) {
  const all = [];
  const take = (o) => { if (o && o.id !== undefined && o.id !== null && o.id !== '') all.push(idText(o.id)); };
  for (const tab of tabs || []) take(tab);
  eachSection(tabs, (section) => take(section));
  eachCell(tabs, (cell) => { take(cell); take(cell.control); });
  const seen = new Set();
  const duplicates = new Set();
  for (const id of all) { if (seen.has(id)) duplicates.add(id); seen.add(id); }
  return { ids: seen, duplicates: [...duplicates] };
}

/**
 * The planned tree with ids set: each `__fresh` object takes its id from the creation port, markers are
 * stripped. Answers { tabs, ids } where `ids` maps every recorded child key to its id — fresh children,
 * tracked existing ones, and each helper spacer under `spacer:<section key>:<row>:<column>` at the slot it
 * lands in (the slot is part of the key: a spacer is the build's only where the build put it).
 * `ownedSpacers` are the lowercased ids of the helper spacers the plan recycled.
 */
function materialize(planned, childIds = {}, ownedSpacers = []) {
  const tabs = clone(planned);
  const ids = {};
  const freshIds = [];
  const helperSpacers = new Set(ownedSpacers.map(idText));
  const settle = (o) => {
    if (!o || typeof o !== 'object') return;
    if (o.__fresh) {
      const id = childIds[o.__fresh];
      if (id) { o.id = id; freshIds.push(id); }
      if (/^spacer:/.test(o.__fresh)) { if (id) helperSpacers.add(idText(id)); } else if (id) ids[o.__fresh] = id;
    } else if (o.__track && o.id) {
      ids[o.__track] = o.id;
    }
  };
  const spacerSections = [];
  for (const tab of tabs) settle(tab);
  eachSection(tabs, (section) => {
    settle(section);
    if (section.__skey) spacerSections.push(section);
    for (const row of section.rows || []) for (const cell of row.cells || []) { settle(cell); if (cell) settle(cell.control); }
  });
  for (const section of spacerSections) {
    const rows = section.rows || [];
    for (const p of slotGrid(rows, section.columns).placed) {
      const cell = rows[p.row].cells[p.cell];
      if (isSpacer(cell) && cell.id && helperSpacers.has(idText(cell.id))) ids[`spacer:${section.__skey}:${p.r}:${p.c}`] = cell.id;
    }
  }
  stripMarkers(tabs);
  return { tabs, ids, freshIds, helperSpacers: [...helperSpacers] };
}

const childBindingKey = (key, childKey) => `${key}#${childKey}`;
const codeError = (code) => Object.assign(new Error(code), { code });

// Re-read the form from the server into the workspace (overwrite: a stale local copy must never pass for
// the stored one) and answer it, { missing: true } when the row is gone, or null when it cannot be read.
async function readForm(sdk, formId) {
  try {
    await sdk.fetchArtifact(ARTIFACT, formId, { overwrite: true });
    const form = await sdk.getArtifact(ARTIFACT, formId);
    return form && Array.isArray(form.tabs) ? form : null;
  } catch (err) {
    const status = err && (err.status || err.statusCode);
    const code = String((err && err.code) || '');
    if (status === 404 || /NOT_FOUND/i.test(code)) return { missing: true };
    return null;
  }
}

// The form's handlers, keyed `<event>|<attribute>|<function>|<library>`: an onchange handler is known by the
// field it runs for too (the `attribute` of its <event> node), so the same function on two fields is two
// handlers; onload and onsave carry no attribute. They live in
// the root bag's <events> region, one <event name=".."> per handler whose first child's first child is the
// <Handler functionName=".." libraryName=".."> node, e.g. (as the SDK holds it)
//   { n: 'events', c: [ { n: 'event', a: [['name','onload'], ...], c: [ { n: 'Handlers', c: [ { n: 'Handler',
//     a: [['functionName','app.onLoad'], ['libraryName','new_/app.js'], ...] } ] } ] } ] }
function handlerKeysOf(form) {
  const keys = new Set();
  const attrOf = (node, name) => (((node && node.a) || []).find((a) => a[0] === name) || [])[1];
  for (const entry of ((form && form.bag && form.bag.c) || [])) {
    if (!entry || !entry.node || entry.node.n !== 'events') continue;
    for (const evNode of entry.node.c || []) {
      for (const handlers of (evNode && evNode.c) || []) {
        for (const handler of (handlers && handlers.c) || []) {
          keys.add(keyOfHandler(attrOf(evNode, 'name'), attrOf(evNode, 'attribute'), attrOf(handler, 'functionName'), attrOf(handler, 'libraryName')));
        }
      }
    }
  }
  return keys;
}
const keyOfHandler = (event, attribute, fn, library) => `${event}|${event === 'onchange' ? lc(attribute) : ''}|${fn}|${library}`;
const handlerKey = (ev) => keyOfHandler(ev.event, ev.attribute, ev.function, ev.library);
const requestedHandlers = (events) => (events || []).filter((ev) => ev && FORM_EVENTS.has(ev.event) && ev.library && ev.function);

// Add `handlers` (all of them must be missing) to the form's <events> region in the local copy — a new
// region when there is none, else appended to it — exactly as sdk-build's wireFormEvents does, so the
// handlers travel in the same push as the layout.
async function addHandlers(sdk, formId, handlers) {
  if (!handlers.length) return;
  const bagC = ((((await sdk.getArtifact(ARTIFACT, formId)) || {}).bag) || {}).c || [];
  const regionIdx = bagC.findIndex((e) => e && e.node && e.node.n === 'events');
  if (regionIdx < 0) {
    const nextI = bagC.reduce((max, e) => Math.max(max, Number(e && e.i)), -1) + 1;
    await sdk.addElement(ARTIFACT, formId, '/bag/c', { i: nextI, node: formEventsRegionIntent(handlers) });
    return;
  }
  for (const ev of handlers) await sdk.addElement(ARTIFACT, formId, `/bag/c/${regionIdx}/node/c`, formEventsRegionIntent([ev]).c[0]);
}

// What a declared write must leave exactly as it was: every cell the build does not own (by id, else by its
// slot) with its slot, spans and whole content; every section's own properties and parent (tab and form
// column) — its rows and width are compared elsewhere; every tab's own properties and its columns' widths
// and bags; and every row's own payload (row attributes and children) at its section and row index. `owned` are the
// ids of the cells and controls the build owns (written, recycled or repaired); `fresh` the ids of the tabs
// and sections it added. Answers { key: value } for canonical comparison.
function foreignInventory(tabs, { owned = new Set(), fresh = new Set() } = {}) {
  const out = {};
  const omit = (o, keys) => { const c = { ...o }; for (const k of keys) delete c[k]; return c; };
  (tabs || []).forEach((tab, ti) => {
    const tabKey = idText(tab && tab.id) || `#${ti}`;
    if (!fresh.has(idText(tab && tab.id))) {
      out[`tab:${tabKey}`] = canonicalJson({ ...omit(tab, ['columns']), columns: ((tab && tab.columns) || []).map((c) => omit(c || {}, ['sections'])) });
    }
    ((tab && tab.columns) || []).forEach((column, ci) => ((column && column.sections) || []).forEach((section, si) => {
      const where = idText(section.id) || sectionPath(tab, ti, ci, section, si);
      // A section's width is owned (when stated) and proven by formProjection; the SDK mirrors it in the raw
      // attribute bag too (`columns`, e.g. "11" for two), so that attribute is left out here.
      const own = omit(section, ['rows', 'columns']);
      if (own.bag && Array.isArray(own.bag.a)) own.bag = { ...own.bag, a: own.bag.a.filter((a) => !(Array.isArray(a) && lc(a[0]) === 'columns')) };
      if (!fresh.has(idText(section.id))) out[`section:${where}`] = canonicalJson({ parent: `${tabKey}|${ci}`, own });
      const rows = section.rows || [];
      // A row's own payload is the maker's at its coordinate: the packer keeps such a row where it stands and
      // every row above it (packDeclaredLayout), so the same payload on another row is a moved one.
      rows.forEach((row, ri) => {
        if (rowHasPayload(row)) out[`row:${where}|${ri}`] = canonicalJson(row.bag);
      });
      for (const p of slotGrid(rows, section.columns).placed) {
        const cell = rows[p.row].cells[p.cell];
        if (!cell || owned.has(idText(cell.id)) || (cell.control && owned.has(idText(cell.control.id)))) continue;
        out[`cell:${idText(cell.id) || `${where}|${p.r},${p.c}`}`] = canonicalJson({ at: `${where}|${p.r},${p.c},${p.colspan},${p.rowspan}`, cell });
      }
    }));
  });
  return out;
}

// Where every object with an id stands, typed: a tab (with its name), a section in its tab and form column,
// a cell in its section at its slot with the field it shows, a control in its cell with the field it binds
// and its class. Answers { '<lowercased id>': '<canonical placement>' }; an id held twice answers both
// placements joined by a newline (canonical JSON holds none), so it can never equal a single one. Ids alone prove nothing about association: two
// field controls whose ids were swapped hold the same id set, and only this map tells them apart.
// `classOf(id)` says whether a control's class counts: the store fills in the default class of a field
// control the write sent without one, so the readback is compared on class only where the write named it.
function structureOf(tabs, classOf = () => true) {
  const out = {};
  const put = (id, value) => {
    const k = idText(id);
    if (!k) return;
    const v = canonicalJson(value);
    out[k] = out[k] === undefined ? v : `${out[k]}\n${v}`;
  };
  (tabs || []).forEach((tab, ti) => {
    const tabRef = idText(tab && tab.id) || `#${ti}`;
    put(tab && tab.id, { type: 'tab', name: lc(tab && tab.name) });
    ((tab && tab.columns) || []).forEach((column, ci) => ((column && column.sections) || []).forEach((section, si) => {
      const sectionRef = idText(section && section.id) || sectionPath(tab, ti, ci, section, si);
      put(section && section.id, { type: 'section', parent: `${tabRef}|${ci}` });
      const rows = (section && section.rows) || [];
      for (const p of slotGrid(rows, section.columns).placed) {
        const cell = rows[p.row].cells[p.cell];
        if (!cell) continue;
        put(cell.id, { type: 'cell', parent: sectionRef, r: p.r, c: p.c, field: fieldOf(cell) || null });
        if (cell.control) {
          put(cell.control.id, { type: 'control', parent: idText(cell.id) || `${sectionRef}|${p.r},${p.c}`, field: lc(cell.control.fieldName) || null, classId: classOf(idText(cell.control.id)) ? idText(cell.control.classId) || null : null });
        }
      }
    }));
  });
  return out;
}

// The requested sub-grid and quick view targets every one of which the stored form must show.
const hostTargetsOf = (hosts) => [
  ...((hosts && hosts.subgrids) || []).map(requestedSubgridTarget),
  ...((hosts && hosts.quickViews) || []).map(requestedQuickViewTarget),
];

// Every placement of each declared field on the live form: name -> [{ pointer, cell }].
function placementsOf(tabs, names) {
  const out = {};
  eachCell(tabs, (cell, section, pointer) => {
    const name = fieldOf(cell);
    if (name && names.has(name)) (out[name] || (out[name] = [])).push({ pointer, cell, section });
  });
  return out;
}

// The ids this build recorded for `childKeys` of the form `key`: { childKey: id } (unrecorded keys absent).
async function recordedChildren(ctx, key, childKeys) {
  const out = {};
  for (const childKey of new Set(childKeys)) {
    const rec = await lookupBinding(ctx, CHILD_KIND, childBindingKey(key, childKey));
    if (rec && rec.id) out[childKey] = rec.id;
  }
  return out;
}

// Where a section stands: { tab, ci } (the tab object and the index of the form column holding it), or null.
function parentOf(tabs, section) {
  for (const tab of tabs) {
    const columns = (tab && tab.columns) || [];
    for (let ci = 0; ci < columns.length; ci += 1) if (((columns[ci] && columns[ci].sections) || []).includes(section)) return { tab, ci };
  }
  return null;
}

// The lowercased ids of the spacers of `section` this build recorded at the slot they stand in now.
async function recordedSpacers(ctx, key, sectionKey, section) {
  const owned = new Set();
  const rows = (section && section.rows) || [];
  for (const p of slotGrid(rows, section.columns).placed) {
    const cell = rows[p.row].cells[p.cell];
    if (!isSpacer(cell) || !cell.id) continue;
    const rec = await lookupBinding(ctx, CHILD_KIND, childBindingKey(key, `spacer:${sectionKey}:${p.r}:${p.c}`));
    if (rec && sameId(rec.id, cell.id)) owned.add(idText(cell.id));
  }
  return owned;
}

// A container the build relies on: by its recorded id first (a rename by the maker keeps it the same
// tab or section), else by a unique name among `candidates` (its exact parent). Answers
// { found } | { missing: true } (recorded but gone) | { ambiguous: true } | {} (nothing there yet).
async function resolveContainer(ctx, key, childKey, candidates, everywhere, name) {
  const rec = await lookupBinding(ctx, CHILD_KIND, childBindingKey(key, childKey));
  if (rec) {
    const found = everywhere.find((o) => sameId(o.id, rec.id));
    return found ? { found } : { missing: true };
  }
  const named = candidates.filter((o) => lc(o && o.name) === lc(name));
  if (named.length > 1) return { ambiguous: true };
  return named.length ? { found: named[0] } : {};
}

function freshTab(compiledTab, childKey) {
  const tab = clone(compiledTab);
  delete tab.id;
  tab.columns = ((compiledTab && compiledTab.columns) || [{}]).map((c) => {
    const column = clone(c);
    delete column.id;
    column.sections = [];
    return column;
  });
  if (!tab.columns.length) tab.columns.push({ sections: [] });
  tab.__fresh = childKey;
  return tab;
}

function freshSection(compiledSection, childKey, columns) {
  const section = clone(compiledSection);
  delete section.id;
  section.rows = [];
  section.columns = columns;
  section.__fresh = childKey;
  return section;
}

// The target a special host control shows, as comparable text — a sub-grid's relationship, child table and
// view; a quick view's lookup, target table and quick view form — or '' for any other control. The quick
// view's form travels as an XML fragment in its QuickForms parameter, e.g.
//   <QuickFormIds><QuickFormId entityname="contact">{0d4f...}</QuickFormId></QuickFormIds>
// (braces and case vary; the build writes it unbraced through quickViewCellIntent, and one quick view
// control names one form).
function hostTarget(control) {
  if (!control) return '';
  const p = control.parameters || {};
  if (sameId(control.classId, SUBGRID_CLASS_ID)) {
    return `subgrid|${lc(p.RelationshipName)}|${lc(p.TargetEntityType)}|${idText(p.ViewId)}`;
  }
  if (sameId(control.classId, QUICK_VIEW_CLASS_ID)) {
    const m = /<QuickFormId\b[^>]*\bentityname\s*=\s*"([^"]*)"[^>]*>\s*([^<]*?)\s*<\/QuickFormId>/i.exec(String(p.QuickForms || ''));
    return `quickview|${lc(control.fieldName)}|${lc(m && m[1])}|${idText(m && m[2])}`;
  }
  return '';
}
const requestedSubgridTarget = (sg) => `subgrid|${lc(sg.relationshipName)}|${lc(sg.targetEntity)}|${idText(sg.viewId)}`;
const requestedQuickViewTarget = (qv) => `quickview|${lc(qv.lookupFieldName)}|${lc(qv.targetEntity)}|${idText(qv.quickViewFormId)}`;
const statesPlacement = (host) => host.placement !== undefined && host.placement !== null;

// The requested sub-grids and quick views. A host the form already carries must already be what the spec
// asks for — same target (child table and view; target table and quick view form) — and, when this build
// recorded its cell and control, be those very objects; it is then left exactly as it is. A missing one is
// added (a sub-grid as its own section on the first tab, a quick view as a new last row of `qvSection`).
// Refuses, rather than substituting something else for the request:
//   - a host the form carries twice (which one is meant is not this build's to choose);
//   - an existing host that shows another target (retargeting a maker's control is not a supported edit);
//   - any stated placement (this build cannot honour one without moving a control it does not own, and a
//     host already on the form is never moved);
//   - a recorded host that is gone or was replaced (create-completion-required, as for any child);
//   - a request whose target the build could not resolve (no view, no quick view form).
// `recorded` maps child keys to the ids this build recorded. Answers a refusal code or ''.
function addHosts(tabs, hosts, qvSection, recorded = {}) {
  const subgrids = (hosts && hosts.subgrids) || [];
  const quickViews = (hosts && hosts.quickViews) || [];
  const cells = [];
  eachCell(tabs, (cell) => { if (cell.control) cells.push(cell); });
  const replaced = (live, kind, name) => {
    const rc = recorded[`cell:${kind}:${name}`];
    const rk = recorded[`control:${kind}:${name}`];
    return (rc && !sameId(live.id, rc)) || (rk && !sameId(live.control.id, rk));
  };
  const wasRecorded = (kind, name) => !!(recorded[`cell:${kind}:${name}`] || recorded[`control:${kind}:${name}`]);
  // An existing host that is what the spec asks for is recorded as the build's, so a later run can tell
  // it from a replacement.
  const track = (live, kind, name) => {
    if (live.id && !live.__fresh) live.__track = `cell:${kind}:${name}`;
    if (live.control.id && !live.control.__fresh) live.control.__track = `control:${kind}:${name}`;
  };
  for (const sg of subgrids) {
    const rel = lc(sg.relationshipName);
    if (sg.unresolved || !rel || !sg.viewId) return 'form-prerequisite-missing';
    const live = cells.filter((c) => sameId(c.control.classId, SUBGRID_CLASS_ID) && lc(c.control.parameters && c.control.parameters.RelationshipName) === rel);
    if (live.length > 1) return 'form-host-ambiguous';
    if (statesPlacement(sg)) return 'form-host-unsupported';
    if (live.length) {
      if (replaced(live[0], 'subgrid', rel)) return 'create-completion-required';
      if (hostTarget(live[0].control) !== requestedSubgridTarget(sg)) return 'form-host-target-mismatch';
      track(live[0], 'subgrid', rel);
      continue;
    }
    if (wasRecorded('subgrid', rel)) return 'create-completion-required';
    if (!tabs.length || !tabs[0].columns || !tabs[0].columns.length) return 'form-layout-no-home-section';
    const section = subgridSectionIntent({ subgridClassId: SUBGRID_CLASS_ID, targetEntity: sg.targetEntity, relationshipName: sg.relationshipName, viewId: sg.viewId, label: sg.label });
    section.__fresh = `section:subgrid:${rel}`;
    section.rows[0].cells[0].__fresh = `cell:subgrid:${rel}`;
    section.rows[0].cells[0].control.__fresh = `control:subgrid:${rel}`;
    tabs[0].columns[0].sections.push(section);
  }
  for (const qv of quickViews) {
    const lookup = lc(qv.lookupFieldName);
    if (qv.unresolved || !lookup || !qv.quickViewFormId) return 'form-prerequisite-missing';
    const live = cells.filter((c) => sameId(c.control.classId, QUICK_VIEW_CLASS_ID) && lc(c.control.fieldName) === lookup);
    if (live.length > 1) return 'form-host-ambiguous';
    if (statesPlacement(qv)) return 'form-host-unsupported';
    if (live.length) {
      if (replaced(live[0], 'quickview', lookup)) return 'create-completion-required';
      if (hostTarget(live[0].control) !== requestedQuickViewTarget(qv)) return 'form-host-target-mismatch';
      track(live[0], 'quickview', lookup);
      continue;
    }
    if (wasRecorded('quickview', lookup)) return 'create-completion-required';
    if (!qvSection) return 'form-layout-no-home-section';
    const cell = quickViewCellIntent({ quickViewClassId: QUICK_VIEW_CLASS_ID, lookupFieldName: qv.lookupFieldName, targetEntity: qv.targetEntity, quickViewFormId: qv.quickViewFormId, label: qv.label });
    cell.__fresh = `cell:quickview:${lookup}`;
    cell.control.__fresh = `control:quickview:${lookup}`;
    const width = clampWidth(qvSection.columns);
    if (width > 1) cell.colspan = width;
    (qvSection.rows || (qvSection.rows = [])).push({ cells: [cell] });
  }
  return '';
}

// Make sure a form that asks for the timeline carries one that renders. Answers a refusal code or ''.
//   - none at all: a Notes section is added at the end of the first tab's first column — unless another
//     control already holds the id `notescontrol` or a section is already named section_notes, where adding
//     one would make a second;
//   - one that renders: nothing;
//   - exactly one that does not, alone in its section: its rows are replaced by the platform's shape
//     (the cell keeps its id). Rows are written whole because the rows a span needs would otherwise be
//     inserted under it, moving whatever sits there — a host with other controls refuses instead;
//   - more than one, none rendering: which one to repair is not this build's to choose.
function ensureTimeline(tabs, notesTemplate) {
  const found = timelinesOf(tabs);
  if (found.some((t) => !timelineProblem(t, { host: false }))) return '';
  if (found.length > 1) return 'form-timeline-ambiguous';
  if (found.length === 1) {
    const t = found[0];
    if (!t.onlyCell || timelineRefusal(tabs, t)) return 'form-timeline-unsupported-host';
    const rows = timelineRowsIntent(TIMELINE_CLASS_ID);
    if (t.cell.id) rows[0].cells[0].id = t.cell.id;
    t.section.rows = rows;
    t.section.__repaired = true;
    return '';
  }
  let notesNamed = false;
  eachSection(tabs, (section) => { if (lc(section.name) === 'section_notes') notesNamed = true; });
  if (notesNamed || controlIdTaken(tabs, TIMELINE_CONTROL_ID)) return 'form-timeline-unsupported-host';
  if (!tabs.length || !tabs[0].columns || !tabs[0].columns.length) return 'form-layout-no-home-section';
  const section = notesTemplate ? clone(notesTemplate) : { name: 'section_notes', label: 'Notes', columns: 1, rows: timelineRowsIntent(TIMELINE_CLASS_ID) };
  stripMarkers([{ columns: [{ sections: [section] }] }]);
  delete section.id;
  section.__fresh = 'section:timeline';
  const cell = section.rows[0].cells[0];
  delete cell.id;
  cell.__fresh = 'cell:timeline';
  // The control keeps the fixed id the platform renders a timeline under; it is not minted.
  tabs[0].columns[0].sections.push(section);
  return '';
}

// The compiled Notes section of a form intent, or null (compileFormIntent appends it to the first tab).
function notesSectionOf(intentTabs) {
  let out = null;
  eachSection(intentTabs, (section) => { if (!out && timelinesOf([{ columns: [{ sections: [section] }] }]).length) out = section; });
  return out;
}

// Every cell with an id, by id: where it stands (section id or name, slot, spans).
function slotsById(tabs) {
  const out = new Map();
  eachSection(tabs, (section, pointer) => {
    if (section.__repaired) return;
    const rows = section.rows || [];
    const where = idText(section.id) || lc(section.name) || pointer;
    for (const p of slotGrid(rows, section.columns).placed) {
      const cell = rows[p.row].cells[p.cell];
      if (cell && cell.id) out.set(idText(cell.id), `${where}|${p.r},${p.c},${p.colspan},${p.rowspan}`);
    }
  });
  return out;
}

/**
 * The last check before anything is sent, on the planned tree against the live one. Answers a refusal
 * code or ''.
 *   - every section that changes fits the form type's width cap and its cells fit its grid;
 *   - every declared field is on the form exactly once, in the section it was declared in;
 *   - every cell the build does not own that has an id stands where it stood: same section, slot and spans.
 */
function validateDesired(liveTabs, planned, { formType, declaredHome = {}, mobileIds = new Set(), repairedIds = new Set() }) {
  const liveSections = new Map();
  eachSection(liveTabs, (section) => { if (section.id) liveSections.set(idText(section.id), canonicalJson(section)); });
  const stripped = stripMarkers(clone(planned));
  let problem = '';
  eachSection(planned, (section, pointer) => {
    if (problem) return;
    const now = sectionAt(stripped, pointer);
    if (!section.__fresh && section.id && liveSections.get(idText(section.id)) === canonicalJson(now)) return;
    const width = Number(section.columns) || 1;
    if (width > sectionGridWidth({ columns: 4 }, formType) || width < 1) { problem = 'form-layout-width-refused'; return; }
    if (slotGrid(section.rows || [], width).overflow.length) problem = 'form-layout-obstacle-unplaceable';
  });
  if (problem) return problem;
  const counts = {};
  eachCell(planned, (cell, section) => {
    const name = fieldOf(cell);
    if (!name || declaredHome[name] === undefined) return;
    counts[name] = (counts[name] || 0) + 1;
    if (declaredHome[name] !== null && declaredHome[name] !== section) problem = 'form-layout-not-placed';
  });
  if (problem) return problem;
  for (const name of Object.keys(declaredHome)) if (counts[name] !== 1) return 'form-layout-not-placed';
  const after = slotsById(planned);
  for (const [id, slot] of slotsById(liveTabs)) {
    if (mobileIds.has(id) || repairedIds.has(id)) continue;
    if (after.get(id) !== slot) return 'form-layout-obstacle-moved';
  }
  return '';
}

/**
 * Plan the declared layout of an EXISTING form. Reads the form; writes nothing.
 *   form        the RAW spec form (its `reconcile`, flags and spans are read from it — a compiled def carries
 *               none of them, so passing one plans nothing)
 *   spec        the app spec (wantsTimeline)
 *   formId      the id the coordinator resolved by table, type and name, or undefined
 *   intentTabs  compileFormIntent(...).tabs for this form
 *   hosts       { subgrids: [{ targetEntity, relationshipName, viewId, label, placement?, unresolved? }],
 *                 quickViews: [{ lookupFieldName, targetEntity, quickViewFormId, label, placement?, unresolved? }] }
 *               (declaredHostsOf builds it from the spec form and the compiled def)
 *   events      the form's requested handlers ([{ event, library, function, attribute? }]); the ones the
 *               form lacks are added in the same push as the layout
 * Answers { key, action: null|'noChange'|'update'|'create', refused, unknown, ... }: 'create' when the form
 * does not exist and nothing is bound (the caller then runs applyDeclaredFormCreate).
 *
 * What this build recorded is authoritative: a form of another type or table under the resolved id, or a
 * recorded tab, section, field cell or control, timeline or host that is gone or was replaced by another
 * object, refuses before anything is written — it is never re-found by name and silently re-bound.
 */
async function planDeclaredFormLayout({ form, spec, formId, intentTabs, sdk, hosts, events, continuation = false }, ctx = {}) {
  const key = formLayoutKey(form);
  const plan = { key, formId: formId || null, table: tableOf(form), formType: formTypeOf(form), name: lc(form && form.name), action: null, refused: [], unknown: [], origin: 'adopted' };
  if (!isDeclaredForm(form)) return plan;
  const refuse = (code, message) => { plan.refused.push(refusal(key, code, message)); return plan; };
  const layout = declaredLayoutOf(form, intentTabs);
  if (layout.duplicates.length) return refuse('form-layout-duplicate-field', `the spec places ${[...new Set(layout.duplicates)].join(', ')} more than once; a declared field has one place`);
  const binding = await lookupBinding(ctx, KIND, key);
  const bound = boundIdentity(binding, { resolvedId: formId, code: 'form-layout-binding-mismatch', key });
  if (bound.refusal) { plan.refused.push(bound.refusal); return plan; }
  if (binding) plan.origin = binding.origin === 'created' ? 'created' : 'adopted';
  // A continuation is the row at the id the creation port derived for this key, unbound: this key's own
  // earlier create whose settlement did not finish (for example its solution membership failed, so its
  // bindings were not recorded). It is the build's, not an adoption.
  plan.continued = !binding && continuation === true && !!bound.id;
  if (plan.continued) plan.origin = 'created';
  // Child records count only under the form's root binding: bindAll records the root last, so child
  // records without one are what is left of a group whose recording stopped part way.
  const records = binding ? ctx : {};
  if (!bound.id) { plan.action = 'create'; return plan; }
  plan.formId = bound.id;
  const live = await readForm(sdk, bound.id);
  if (live && live.missing) {
    if (binding) return refuse('form-layout-bound-row-missing', 'the form this key is bound to was not found; repair the binding explicitly before it can be recreated');
    plan.unknown.push(refusal(key, 'form-unreadable', 'the form could not be read'));
    return plan;
  }
  if (!live) { plan.unknown.push(refusal(key, 'form-unreadable', 'the form could not be read')); return plan; }
  // The row must be the form the key names: a Main row under a Quick View key (or another table's form) is
  // a different form, whatever its layout looks like.
  if ((live.formType && formTypeCode(live.formType) !== formTypeCode(plan.formType)) || (live.entityLogicalName && plan.table && lc(live.entityLogicalName) !== plan.table)) {
    return refuse('form-layout-identity-mismatch', `form ${bound.id} is a ${live.formType || '?'} form of '${live.entityLogicalName || '?'}', not the ${plan.formType} form of '${plan.table}' this spec declares; nothing was written`);
  }
  const formType = live.formType || formTypeOf(form);
  const liveTabs = clone(live.tabs);
  const tabs = clone(live.tabs);
  const names = new Set(layout.sections.flatMap((s) => s.fields.map((f) => f.name)));
  const placements = placementsOf(tabs, names);
  const twice = Object.keys(placements).filter((n) => placements[n].length > 1);
  if (twice.length) return refuse('form-layout-field-ambiguous', `the form holds ${twice.join(', ')} more than once; remove the extra cells in the form designer first`);
  const carried = {};
  for (const n of Object.keys(placements)) carried[n] = placements[n][0].cell;
  const wantsTimelineToo = wantsTimeline(spec, form);
  const recorded = await recordedChildren(records, key, [
    ...[...names].flatMap((n) => [`cell:${n}`, `control:${n}`]),
    ...(wantsTimelineToo ? ['cell:timeline'] : []),
    ...((hosts && hosts.subgrids) || []).flatMap((sg) => [`cell:subgrid:${lc(sg.relationshipName)}`, `control:subgrid:${lc(sg.relationshipName)}`]),
    ...((hosts && hosts.quickViews) || []).flatMap((qv) => [`cell:quickview:${lc(qv.lookupFieldName)}`, `control:quickview:${lc(qv.lookupFieldName)}`]),
  ]);
  for (const n of names) {
    const rc = recorded[`cell:${n}`];
    const rk = recorded[`control:${n}`];
    if (!rc && !rk) continue;
    const cell = carried[n];
    if (!cell || (rc && !sameId(cell.id, rc)) || (rk && !(cell.control && sameId(cell.control.id, rk)))) {
      return refuse('create-completion-required', `the cell of '${n}' this form was built with is gone or was replaced by another one; restore it, or repair the binding, before the layout is written again`);
    }
  }
  if (recorded['cell:timeline'] && !timelinesOf(tabs).some((t) => t.cell && sameId(t.cell.id, recorded['cell:timeline']))) {
    return refuse('create-completion-required', 'the timeline this form was built with is gone or was replaced; restore it, or repair the binding, before the layout is written again');
  }
  const mobileIds = new Set();
  for (const n of Object.keys(carried)) if (carried[n].id) mobileIds.add(idText(carried[n].id));
  const declaredHome = {};
  // Which sections are repacked: the declared ones, and every section a declared field must leave.
  const packs = new Map();
  const packOf = (section, sectionKey) => {
    if (!packs.has(section)) packs.set(section, { section, sectionKey, fields: [], width: undefined, oldWidth: section.__fresh ? undefined : section.columns, append: false });
    return packs.get(section);
  };
  let qvSection = null;
  if (!layout.auto) {
    const allTabs = () => tabs;
    const allSections = () => { const out = []; eachSection(tabs, (s) => out.push(s)); return out; };
    for (const entry of layout.sections) {
      const tKey = `tab:${lc(entry.tab)}`;
      const t = await resolveContainer(records, key, tKey, allTabs(), allTabs(), entry.tab);
      if (t.missing) return refuse('create-completion-required', `the tab '${entry.tab}' this form was built with is gone; run a full build after restoring it, or repair the binding`);
      if (t.ambiguous) return refuse('form-layout-container-ambiguous', `the form has more than one tab named '${entry.tab}'`);
      let tab = t.found;
      if (tab) { if (tab.id) tab.__track = tKey; } else { tab = freshTab(entry.compiledTab, tKey); tabs.push(tab); }
      // The column a section is declared in must exist: placing it in another column instead would put
      // the layout somewhere the spec did not ask for.
      if (!((tab.columns || [])[entry.ci])) {
        return refuse('form-layout-column-unsupported', `the spec puts the section '${entry.section}' in column ${entry.ci + 1} of the tab '${entry.tab}', which has ${(tab.columns || []).length}; adding a form column to an existing tab is not supported — add it in the form designer first`);
      }
      const sKey = `section:${lc(entry.tab)}/${lc(entry.section)}`;
      const inTab = [];
      eachSection([tab], (s) => inTab.push(s));
      const s = await resolveContainer(records, key, sKey, inTab, allSections(), entry.section);
      if (s.missing) return refuse('create-completion-required', `the section '${entry.section}' this form was built with is gone; run a full build after restoring it, or repair the binding`);
      if (s.ambiguous) return refuse('form-layout-container-ambiguous', `the tab '${entry.tab}' has more than one section named '${entry.section}'`);
      let section = s.found;
      if (section) {
        // A section is never moved: one standing under another tab — or, when the spec states columns, in
        // another column — than the spec declares refuses.
        const where = parentOf(tabs, section);
        if (!where || where.tab !== tab || (entry.columnsStated && where.ci !== entry.ci)) {
          return refuse('form-layout-container-moved', `the section '${entry.section}' stands somewhere other than the tab and column the spec declares; moving a section is not supported — move it in the form designer, or declare it where it is`);
        }
        if (section.id) section.__track = sKey;
      } else {
        section = freshSection(entry.compiledSection, sKey, entry.columns !== undefined ? entry.columns : (entry.compiledSection.columns || 1));
        const column = tab.columns[entry.ci];
        (column.sections || (column.sections = [])).push(section);
      }
      const p = packOf(section, `${lc(entry.tab)}/${lc(entry.section)}`);
      p.fields.push(...entry.fields);
      if (entry.columns !== undefined) p.width = entry.columns;
      for (const f of entry.fields) declaredHome[f.name] = section;
      if (!qvSection) qvSection = section;
    }
    for (const n of Object.keys(placements)) {
      const from = placements[n][0].section;
      if (!packs.has(from)) packOf(from, `~${lc(from.name) || idText(from.id)}`);
    }
  } else {
    // No authored tabs: the compiler's section_general is its own invention, so the deployed form keeps its
    // geometry. Declared fields it holds keep their place (their stated spans and flags are applied there);
    // the ones it lacks are added after the last cell of the home section — the section of the first
    // declared field the form holds, else the first section of the first tab.
    const fields = layout.sections.flatMap((s) => s.fields);
    let home = null;
    for (const f of fields) if (carried[f.name]) { home = placements[f.name][0].section; break; }
    if (!home) eachSection(tabs, (s) => { if (!home && !timelinesOf([{ columns: [{ sections: [s] }] }]).length) home = s; });
    const missing = fields.filter((f) => !carried[f.name]);
    if (missing.length && !home) return refuse('form-layout-no-home-section', 'the form has no section to add the declared fields to');
    for (const f of fields) {
      const cell = carried[f.name];
      if (!cell) { declaredHome[f.name] = null; continue; }
      declaredHome[f.name] = null;
      if (f.colspan !== undefined) cell.colspan = f.colspan;
      if (f.rowspan !== undefined) cell.rowspan = f.rowspan;
      applyFlags(cell, f);
    }
    if (missing.length) {
      const p = packOf(home, `~${lc(home.name) || idText(home.id)}`);
      p.fields.push(...missing);
      p.append = true;
      p.inPlace = true;
    }
    qvSection = home;
  }
  for (const p of packs.values()) {
    const ownedSpacers = p.section.__fresh ? new Set() : await recordedSpacers(records, key, p.sectionKey, p.section);
    for (const id of ownedSpacers) mobileIds.add(id);
    const width = p.width !== undefined ? p.width : (p.section.columns || 1);
    const packed = packDeclaredLayout({
      rows: p.section.rows || [], width, oldWidth: p.oldWidth !== undefined ? p.oldWidth : width, fields: p.fields,
      // An append in place moves nothing that is already there, declared fields included.
      owned: p.inPlace ? new Set() : names, carried, templates: layout.templates, sectionKey: p.sectionKey, ownedSpacers, append: p.append,
    });
    if (packed.refused) return refuse(packed.refused, packed.refused === 'form-layout-narrowing-refused'
      ? 'the declared width would cut through a control the spec does not own; move it in the form designer first'
      : 'a control the spec does not own does not fit its section as it stands; fix the section in the form designer first');
    p.section.rows = packed.rows;
    if (p.width !== undefined) p.section.columns = p.width;
    p.section.__skey = p.sectionKey;
  }
  // The live ids of a timeline host the repair rewrites whole, which are therefore not obstacles.
  const repairedIds = new Set();
  if (wantsTimelineToo) {
    const code = ensureTimeline(tabs, notesSectionOf(intentTabs));
    if (code) return refuse(code, code === 'form-timeline-ambiguous'
      ? 'the form has more than one timeline and none of them renders; remove the extra ones in the form designer first'
      : 'the timeline cannot be added or repaired without moving a control the spec does not own; fix the Notes section in the form designer first');
    eachSection(liveTabs, (s, pointer) => {
      const now = sectionAt(tabs, pointer);
      if (now && now.__repaired) for (const row of s.rows || []) for (const cell of row.cells || []) if (cell && cell.id) repairedIds.add(idText(cell.id));
    });
    // The one timeline the form now carries is the build's to record (a later run checks it is still there).
    const found = timelinesOf(tabs);
    if (found.length === 1 && found[0].cell && found[0].cell.id && !found[0].cell.__fresh) found[0].cell.__track = 'cell:timeline';
  }
  const hostCode = addHosts(tabs, hosts, qvSection, recorded);
  if (hostCode) return refuse(hostCode, {
    'form-host-ambiguous': 'the form holds a requested sub-grid or quick view more than once; remove the extra one in the form designer first',
    'form-host-unsupported': 'a stated placement for a sub-grid or quick view is not supported on a declared form: a new one cannot be placed without moving a control the spec does not own, and an existing one is never moved; remove the placement',
    'form-host-target-mismatch': 'a requested sub-grid or quick view is already on the form showing another view, table or quick view form; retargeting it is not supported — change it in the form designer, or request what it shows',
    'form-prerequisite-missing': 'a requested sub-grid or quick view names a view, relationship or quick view form that was not found',
    'create-completion-required': 'a sub-grid or quick view this form was built with is gone or was replaced; restore it, or repair the binding, before the layout is written again',
  }[hostCode] || 'the form has no section to add the requested controls to');
  const problem = validateDesired(liveTabs, tabs, { formType, declaredHome, mobileIds, repairedIds });
  if (problem) return refuse(problem, 'the planned layout would move a control the spec does not own or leave a declared field out of place; nothing was written');
  const desired = stripMarkers(clone(tabs));
  plan.planned = tabs;
  plan.freshKeys = freshKeys(tabs);
  plan.ownedSpacers = [...mobileIds];
  plan.liveParts = formProjection(liveTabs);
  plan.desiredParts = formProjection(desired);
  plan.wantsTimeline = wantsTimelineToo;
  plan.liveTabs = liveTabs;
  plan.mobileIds = [...mobileIds];
  plan.repairedIds = [...repairedIds];
  plan.hostTargets = hostTargetsOf(hosts);
  plan.handlers = requestedHandlers(events);
  const haveHandlers = handlerKeysOf(live);
  plan.addHandlers = plan.handlers.filter((ev, i) => !haveHandlers.has(handlerKey(ev)) && plan.handlers.findIndex((o) => handlerKey(o) === handlerKey(ev)) === i);
  const tabsUnchanged = canonicalJson(desired) === canonicalJson(liveTabs);
  if (tabsUnchanged && !plan.addHandlers.length) {
    plan.action = 'noChange';
    plan.bindUnchanged = !!binding || plan.continued || isAuthorized(ctx.authorizedAdoption, key);
    return plan;
  }
  const verdict = tabsUnchanged ? (binding ? 'none' : 'unbound') : partsDriftVerdict(binding, plan.liveParts, plan.desiredParts);
  if (verdict === 'drift' && !isAuthorized(ctx.authorizedOverwrite, key)) {
    return refuse('form-layout-drift', 'the layout of a declared field was changed outside the spec since the last build; refresh the spec or approve the overwrite');
  }
  if (verdict === 'unbound' && !plan.continued && !isAuthorized(ctx.authorizedAdoption, key)) {
    return refuse('form-layout-adoption-not-authorized', 'this form exists and the spec has not managed its layout before; approve adopting it first');
  }
  plan.action = 'update';
  return plan;
}

const scopeOf = (key, formId, table) => ({ key, scope: { type: ARTIFACT, id: String(formId), table } });

// The child records first, the root binding LAST: the shared settlement records a result's bindings one by
// one and stops at the first that fails, and a later run trusts child records only under a root binding
// (planDeclaredFormLayout), so a group whose recording stopped part way steers nothing. The root holds the
// full layout projection as stored; each child record (tab, section, cell, control, helper spacer) only
// says "this object is the build's", its intent being its id.
function bindAll(result, ctx, { key, formId, tabs, ids, origin, freshKeys: fresh = [] }) {
  const base = projectionBaseline(formProjection(tabs));
  const created = new Set(fresh);
  for (const childKey of Object.keys(ids).sort()) {
    const id = ids[childKey];
    result.managedBindings.push(bindingRecord(ctx, {
      kind: CHILD_KIND, key: childBindingKey(key, childKey), id, parentKey: key,
      intentSha256: projectionBaseline({ [childKey]: idText(id) }).intentSha256, origin: created.has(childKey) ? 'created' : origin,
    }));
  }
  result.managedBindings.push(bindingRecord(ctx, { kind: KIND, key, id: formId, intentSha256: base.intentSha256, partsSha256: base.partsSha256, origin }));
}

// Prove a write by a fresh read. The stored form must be the form the key names (type and table); every
// id the write carried must be on it; every declared field placement and section width must be what was
// sent; a requested timeline must render, every requested sub-grid / quick view target and handler must
// be there; and — on an existing form — everything the build does not own (foreignInventory of the form as
// it was read before the write) must be exactly as it was. Answers { tabs } or { refused | unknown: [code,
// message] }.
//   expect  { formType, table, wantsTimeline, hostTargets, handlers, liveTabs?, mobileIds?, repairedIds? }
async function proveStored(sdk, formId, written, expect = {}) {
  const back = await readForm(sdk, formId);
  if (!back || back.missing) return { unknown: ['form-layout-unverified', 'the form could not be read back after the write; check it before the table is published'] };
  if ((back.formType && expect.formType && formTypeCode(back.formType) !== formTypeCode(expect.formType))
    || (back.entityLogicalName && expect.table && lc(back.entityLogicalName) !== expect.table)) {
    return { unknown: ['form-layout-identity-mismatch', 'the stored form is not of the type and table the spec declares; check it before the table is published'] };
  }
  const stored = treeIds(back.tabs).ids;
  const lost = Object.keys(written.ids).filter((k) => !stored.has(idText(written.ids[k])));
  if (lost.length) return { refused: ['create-completion-required', `the stored form lacks ${lost.length} of the tabs, sections or cells this build wrote; run a full build again`] };
  // Every object the write carried must stand where it was sent and be what it was sent as: the same type,
  // parent, slot and field. Present ids are not enough (see structureOf).
  const sentAt = structureOf(written.tabs);
  const keptAt = structureOf(back.tabs, (id) => sentAt[id] === undefined || !sentAt[id].includes('"classId":null'));
  const moved = Object.keys(sentAt).filter((id) => keptAt[id] !== sentAt[id]);
  if (moved.length) {
    return { unknown: ['form-layout-not-stored', `the stored form holds ${moved.length} of the tabs, sections, cells or controls this build wrote in another place or bound to another field; check it before the table is published`] };
  }
  if (canonicalJson(formProjection(back.tabs)) !== canonicalJson(formProjection(written.tabs))) {
    return { unknown: ['form-layout-not-stored', 'the stored form does not hold the layout this build wrote; check it before the table is published'] };
  }
  if (expect.wantsTimeline && !timelinesOf(back.tabs).some((t) => !timelineProblem(t, { host: false }))) {
    return { unknown: ['form-timeline-unverified', 'the stored form does not carry a timeline that renders; check it before the table is published'] };
  }
  const shown = new Set();
  eachCell(back.tabs, (cell) => { const t = hostTarget(cell.control); if (t) shown.add(t); });
  const haveHandlers = handlerKeysOf(back);
  if ((expect.hostTargets || []).some((t) => !shown.has(t)) || (expect.handlers || []).some((ev) => !haveHandlers.has(handlerKey(ev)))) {
    return { unknown: ['form-layout-not-stored', 'the stored form lacks a requested sub-grid, quick view or event handler; check it before the table is published'] };
  }
  if (expect.liveTabs) {
    const owned = new Set([...Object.values(written.ids), ...(written.helperSpacers || []), ...(expect.mobileIds || []), ...(expect.repairedIds || [])].map(idText));
    const fresh = new Set((written.freshIds || []).map(idText));
    const before = foreignInventory(expect.liveTabs, { owned, fresh });
    const after = foreignInventory(back.tabs, { owned, fresh });
    if (canonicalJson(before) !== canonicalJson(after)) {
      return { unknown: ['form-layout-not-stored', 'the stored form does not hold a control, row or container the spec does not own as it was before the write; check it before the table is published'] };
    }
  }
  return { tabs: back.tabs, back, ids: observedIds(written.ids, keptAt, sentAt) };
}

// The child ids to bind, taken from the stored form: each recorded child key with the id the stored form
// holds at the placement the write sent it to (proveStored has just required every one to match).
function observedIds(ids, keptAt, sentAt) {
  const out = {};
  for (const k of Object.keys(ids)) if (keptAt[idText(ids[k])] !== undefined && keptAt[idText(ids[k])] === sentAt[idText(ids[k])]) out[k] = ids[k];
  return out;
}

// Classify a runManagedCreate answer for a form write. `sent` says whether a push was attempted that may
// have reached the service (a refused push did not).
function settleWrite(result, key, out, { complete, sent, pending }) {
  if (out.status === 'created' && complete) return true;
  if (sent) result.pendingPublish.push(pending);
  if (out.status === 'adopted') {
    result.refused.push(refusal(key, 'creation-adopted-rerun', 'an earlier create of this form was resolved; run the build again so it re-reads the form before writing'));
  } else if (out.status === 'refused') {
    result.refused.push({ ...refusal(key, 'form-layout-rejected', `the form was not saved (${out.code || 'refused'})`), ...(out.rules && out.rules.length ? { rules: out.rules } : {}) });
  } else {
    // 'unknown', a 'created' answer without every child id, and — on an update — an SDK-native 'matched'
    // answer (an update adopts no row, so a match there is not an outcome this write can prove).
    result.unknown.push(refusal(key, out.status === 'matched' ? 'form-layout-create-matched' : 'form-layout-write-unknown', 'the form write did not settle; check the form — the next run re-reads it before writing'));
  }
  return false;
}

/**
 * Apply a plan from planDeclaredFormLayout: ONE '/tabs' update (plus the missing event handlers) and ONE
 * push. New children take their ids from the creation port under the SAME request family as the form's own
 * create (kind 'form-layout', the form's key, the child key; `parentId` the actual form id); then a fresh
 * read proves the write — owned parts and everything the build does not own — before the form and its
 * children are bound. Never publishes: a write that may have been sent records its scope in
 * `pendingPublish` for the coordinator's settlement.
 */
async function applyDeclaredFormLayout(plan, { sdk }, ctx = {}) {
  const result = emptyResult();
  result.refused.push(...plan.refused);
  result.unknown.push(...plan.unknown);
  if (plan.refused.length || plan.unknown.length || !plan.action || plan.action === 'create') return result;
  if (plan.action === 'noChange') {
    result.unchanged.push({ key: plan.key, kind: KIND, id: plan.formId, managed: plan.bindUnchanged === true, ...(plan.continued ? { continued: true } : {}) });
    if (plan.bindUnchanged) {
      const m = materialize(plan.planned, {}, plan.ownedSpacers);
      bindAll(result, ctx, { key: plan.key, formId: plan.formId, tabs: m.tabs, ids: m.ids, origin: plan.origin });
    }
    return result;
  }
  let written = null;
  let pushed = null;
  const edit = async (childIds) => {
    const m = materialize(plan.planned, childIds || {}, plan.ownedSpacers);
    if (treeIds(m.tabs).duplicates.length) throw codeError('FORM_LAYOUT_DUPLICATE_ID');
    written = m;
    await sdk.updateElement(ARTIFACT, plan.formId, '/tabs', m.tabs);
    await addHandlers(sdk, plan.formId, plan.addHandlers || []);
    pushed = await pushChecked(sdk, ARTIFACT, plan.formId);
    return pushed;
  };
  let out;
  if (plan.freshKeys.length) {
    out = await runManagedCreate(ctx, {
      kind: KIND, key: plan.key,
      identity: { table: plan.table, formType: plan.formType, name: plan.name, parentId: String(plan.formId) },
      childKeys: plan.freshKeys,
    }, async (ids) => edit(ids.childIds));
  } else {
    try {
      const answer = await edit(null);
      out = { status: answer.outcome === 'saved' ? 'created' : answer.outcome, code: answer.code, rules: answer.rules, childIds: {} };
    } catch (err) {
      // A local element edit threw: nothing was sent (the next run fetches with overwrite).
      out = { status: 'refused', code: (err && err.code) || 'LOCAL_EDIT_FAILED' };
    }
  }
  const complete = !!written && (!plan.freshKeys.length || plan.freshKeys.every((k) => normalizeGuid((out.childIds || {})[k])));
  const pending = scopeOf(plan.key, plan.formId, plan.table);
  const sent = !!pushed && pushed.outcome !== 'refused';
  if (!settleWrite(result, plan.key, out, { complete, sent, pending })) return result;
  result.pendingPublish.push(pending);
  const proof = await proveStored(sdk, plan.formId, written, {
    formType: plan.formType, table: plan.table, wantsTimeline: plan.wantsTimeline, hostTargets: plan.hostTargets, handlers: plan.handlers,
    liveTabs: plan.liveTabs, mobileIds: plan.mobileIds, repairedIds: plan.repairedIds,
  });
  if (proof.refused) { result.refused.push(refusal(plan.key, ...proof.refused)); return result; }
  if (proof.unknown) { result.unknown.push(refusal(plan.key, ...proof.unknown)); return result; }
  result.saved.push({ key: plan.key, kind: KIND, id: plan.formId, ...(plan.continued ? { continued: true } : {}), ...(plan.freshKeys.length ? { childIds: out.childIds } : {}) });
  bindAll(result, ctx, { key: plan.key, formId: plan.formId, tabs: proof.tabs, ids: proof.ids, origin: plan.origin, freshKeys: plan.freshKeys });
  return result;
}

// The complete tree of a NEW declared form, every object marked with the child key its id is reserved
// under. Sections of field cells only are packed again by slot (the compiler's width-only rows let a
// cell after a middle row-spanning one run past the grid); any other section keeps its compiled rows.
// Answers { tabs } or { refused: code }.
function plannedCreateTabs(intentTabs) {
  const tabs = stripMarkers(clone(intentTabs || []));
  const keys = new Set();
  let clash = false;
  const mark = (o, childKey) => {
    if (keys.has(childKey)) clash = true;
    keys.add(childKey);
    delete o.id;
    o.__fresh = childKey;
  };
  let refused = '';
  tabs.forEach((tab, ti) => {
    const tName = lc(tab.name) || `#${ti}`;
    mark(tab, `tab:${tName}`);
    for (const column of tab.columns || []) {
      delete column.id;
      ((column && column.sections) || []).forEach((section, si) => {
        const sName = lc(section.name) || `#${si}`;
        const sk = `${tName}/${sName}`;
        const hostsTimeline = timelinesOf([{ columns: [{ sections: [section] }] }]).length > 0;
        mark(section, hostsTimeline ? 'section:timeline' : `section:${sk}`);
        const cells = (section.rows || []).flatMap((row) => (row && row.cells) || []);
        if (cells.length && cells.every((cell) => fieldOf(cell))) {
          const templates = {};
          const fields = cells.map((cell) => {
            templates[fieldOf(cell)] = cell;
            return { name: fieldOf(cell), ...(typeof cell.colspan === 'number' ? { colspan: cell.colspan } : {}), ...(typeof cell.rowspan === 'number' ? { rowspan: cell.rowspan } : {}) };
          });
          const packed = packDeclaredLayout({ rows: [], width: section.columns || 1, fields, owned: new Set(fields.map((f) => f.name)), templates, sectionKey: sk });
          if (packed.refused) { refused = packed.refused; return; }
          section.rows = packed.rows;
          section.__skey = sk;
          return;
        }
        (section.rows || []).forEach((row, ri) => ((row && row.cells) || []).forEach((cell, ci) => {
          if (!cell) return;
          const field = fieldOf(cell);
          const at = field || `${sk}:${ri}:${ci}`;
          if (hostsTimeline && cell.control && cell.control.id === TIMELINE_CONTROL_ID) { mark(cell, 'cell:timeline'); return; }
          mark(cell, `cell:${at}`);
          if (cell.control) { delete cell.control.id; cell.control.__fresh = `control:${at}`; }
        }));
      });
    }
  });
  if (refused) return { refused };
  return clash ? { refused: 'form-layout-container-ambiguous' } : { tabs };
}

/**
 * Create a NEW declared form whole: the packed field layout, the timeline, the requested sub-grids and quick
 * views and the event handlers are built locally with every id supplied — the form's through the creation
 * port (kind 'form-layout'), each tab, section, cell and control as one of its child ids — and sent in ONE
 * push. A fresh read then proves the stored form before anything is bound; the scope is left in
 * `pendingPublish` for the coordinator's settlement.
 *   def     compileFormIntent(...) for the form (name, entityLogicalName, formType, status, description, tabs)
 *   events  the form's handlers ({ event, library, function }); default: the raw form's `events`
 *   beforePush(id)  optional: the coordinator's local edits of the new row that travel in the same push
 * An authoritative SDK-native match (port status 'matched', evidence 'sdk-adopted-exact') is never a
 * creation: with approved adoption and a full stored proof it is saved as `matched` and bound 'adopted';
 * without approval it refuses (the scope stays withheld).
 */
async function applyDeclaredFormCreate({ form, spec, def, sdk, hosts, events, beforePush }, ctx = {}) {
  const result = emptyResult();
  if (!isDeclaredForm(form)) return result;
  const key = formLayoutKey(form);
  const refuse = (code, message) => { result.refused.push(refusal(key, code, message)); return result; };
  const layout = declaredLayoutOf(form, def && def.tabs);
  if (layout.duplicates.length) return refuse('form-layout-duplicate-field', `the spec places ${[...new Set(layout.duplicates)].join(', ')} more than once; a declared field has one place`);
  if (await lookupBinding(ctx, KIND, key)) return refuse('form-layout-bound-row-missing', 'the form this key is bound to was not found; repair the binding explicitly before it can be recreated');
  const built = plannedCreateTabs(def && def.tabs);
  if (built.refused) return refuse(built.refused, 'the declared layout does not fit its sections; nothing was created');
  const tabs = built.tabs;
  const wanted = wantsTimeline(spec, form);
  if (wanted) {
    const code = ensureTimeline(tabs, null);
    if (code || !timelinesOf(tabs).some((t) => !timelineProblem(t, { host: true }))) return refuse('form-timeline-unsupported-host', 'the new form\'s timeline would not render; nothing was created');
  }
  let firstFields = null;
  eachSection(tabs, (s) => { if (!firstFields && s.__skey) firstFields = s; });
  const hostCode = addHosts(tabs, hosts, firstFields);
  if (hostCode) return refuse(hostCode, 'a requested sub-grid or quick view cannot be added to the new form; nothing was created');
  const formType = (def && def.formType) || formTypeOf(form);
  let geometry = '';
  eachSection(tabs, (s) => {
    const width = Number(s.columns) || 1;
    if (width > sectionGridWidth({ columns: 4 }, formType) || slotGrid(s.rows || [], width).overflow.length) geometry = 'form-layout-invalid';
  });
  if (geometry) return refuse(geometry, 'a section of the new form does not fit its grid; nothing was created');
  const handlers = requestedHandlers(events || (form && form.events));
  const childKeys = freshKeys(tabs);
  const table = tableOf(form) || lc(def && def.entityLogicalName);
  let written = null;
  let pushed = null;
  const out = await runManagedCreate(ctx, { kind: KIND, key, identity: { table, formType, name: lc(def && def.name) }, childKeys }, async ({ id, childIds }) => {
    const m = materialize(tabs, childIds || {});
    if (treeIds(m.tabs).duplicates.length) throw codeError('FORM_LAYOUT_DUPLICATE_ID');
    const art = await sdk.createArtifact(ARTIFACT, {
      id, name: def.name, entityLogicalName: def.entityLogicalName, formType, status: def.status,
      ...(def.description ? { description: def.description } : {}),
    });
    // The id is the form's identity for every later run; a store that minted its own would orphan it.
    if (!art || !sameId(art.id, id)) throw codeError('CREATE_ID_NOT_KEPT');
    const seed = (((await sdk.getArtifact(ARTIFACT, id)) || {}).tabs || []).length;
    // In order: addElement appends, and tab order is the on-form order. The adapter's seed tab(s) go
    // after, only once the declared tabs are in, so the form is never tab-less.
    for (const tab of m.tabs) await sdk.addElement(ARTIFACT, id, '/tabs', tab);
    if (m.tabs.length) for (let i = 0; i < seed; i += 1) await sdk.removeElement(ARTIFACT, id, '/tabs/0');
    await addHandlers(sdk, id, handlers);
    // The coordinator's own local edits of the new row that must travel in this push (e.g. the form's
    // display order); it must not push or publish.
    if (typeof beforePush === 'function') await beforePush(id);
    written = m;
    pushed = await pushChecked(sdk, ARTIFACT, id);
    return pushed;
  });
  const formId = normalizeGuid(out.id) ? String(out.id) : '';
  const complete = !!written && !!formId && childKeys.every((k) => normalizeGuid((out.childIds || {})[k]));
  const pending = scopeOf(key, formId || out.id || '', table);
  const sent = !!pushed && pushed.outcome !== 'refused';
  const expect = { formType, table, wantsTimeline: wanted, hostTargets: hostTargetsOf(hosts), handlers };
  if (out.status === 'matched' && complete) {
    // The SDK answered an authoritative exact match for the row it was asked to create: the row is not this
    // build's creation, so it is taken only as an approved adoption, and only once a fresh read proves it
    // holds everything this create asked for. It is never counted as created.
    result.pendingPublish.push(pending);
    if (!isAuthorized(ctx.authorizedAdoption, key)) {
      return refuse('form-layout-adoption-not-authorized', 'the service already held this form; approve adopting it, then run the build again');
    }
    const proof = await proveStored(sdk, formId, written, expect);
    if (proof.refused) { result.refused.push(refusal(key, ...proof.refused)); return result; }
    if (proof.unknown) { result.unknown.push(refusal(key, ...proof.unknown)); return result; }
    result.saved.push({ key, kind: KIND, id: formId, matched: true, evidence: out.evidence, childIds: out.childIds });
    bindAll(result, ctx, { key, formId, tabs: proof.tabs, ids: proof.ids, origin: 'adopted' });
    return result;
  }
  if (!settleWrite(result, key, out, { complete, sent, pending })) return result;
  result.pendingPublish.push(pending);
  const proof = await proveStored(sdk, formId, written, expect);
  if (proof.refused) { result.refused.push(refusal(key, ...proof.refused)); return result; }
  if (proof.unknown) { result.unknown.push(refusal(key, ...proof.unknown)); return result; }
  result.saved.push({ key, kind: KIND, id: formId, created: true, childIds: out.childIds });
  bindAll(result, ctx, { key, formId, tabs: proof.tabs, ids: proof.ids, origin: 'created', freshKeys: childKeys });
  return result;
}

/**
 * The requested hosts of a declared form, as planDeclaredFormLayout / applyDeclaredFormCreate take them.
 *   specForm  the RAW spec form
 *   def       its compiled intent after sdk-build's forms phase set `def.__subgrids` (entries
 *             { targetEntity, relationshipName, viewId, label, placement?: { raw, resolved } })
 *   quickViewFormIdOf(targetEntity, formName)  the id of the QuickView form the build resolved, or ''
 * The legacy pass silently drops a sub-grid with no relationship or view and a placement it cannot resolve;
 * a declared form must not: such a request comes back `unresolved` (refused as form-prerequisite-missing)
 * and any stated placement is carried (refused as form-host-unsupported) rather than ignored.
 */
function declaredHostsOf(specForm, def, { quickViewFormIdOf } = {}) {
  const compiled = (def && def.__subgrids) || [];
  const byTarget = new Map(compiled.map((sg) => [lc(sg.targetEntity), sg]));
  const subgrids = [];
  const seen = new Set();
  for (const raw of (specForm && specForm.subgrids) || []) {
    const target = lc(raw && raw.childEntity);
    seen.add(target);
    const sg = byTarget.get(target);
    const placement = placementOf(raw);
    if (!sg) { subgrids.push({ targetEntity: target, relationshipName: '', viewId: '', label: raw && raw.label, unresolved: true, ...(placement ? { placement } : {}) }); continue; }
    subgrids.push({ targetEntity: sg.targetEntity, relationshipName: sg.relationshipName, viewId: sg.viewId, label: sg.label, ...(placement ? { placement } : {}) });
  }
  // autoSubgrids entries the compiler added for undeclared children carry no placement.
  for (const sg of compiled) if (!seen.has(lc(sg.targetEntity))) subgrids.push({ targetEntity: sg.targetEntity, relationshipName: sg.relationshipName, viewId: sg.viewId, label: sg.label });
  const quickViews = ((specForm && specForm.quickViews) || []).map((qv) => {
    const complete = qv && qv.lookup && qv.targetEntity && qv.form;
    const id = complete && typeof quickViewFormIdOf === 'function' ? quickViewFormIdOf(lc(qv.targetEntity), qv.form) : '';
    // The spec gate does not reject a placement key on a quick view, so one stated here is carried (and
    // refused as form-host-unsupported) like a sub-grid's, never dropped.
    const placement = placementOf(qv);
    return {
      lookupFieldName: lc(qv && qv.lookup), targetEntity: lc(qv && qv.targetEntity), quickViewFormId: id || '', label: qv && qv.label,
      ...(id ? {} : { unresolved: true }),
      ...(placement ? { placement } : {}),
    };
  });
  return { subgrids, quickViews };
}

/**
 * Reconcile ONE declared form end to end, in the order the design requires: the form's binding first,
 * then (only when nothing is bound) the coordinator's resolution, then plan and apply — or the whole
 * create. Never publishes and never settles.
 *   input  { form, spec, def, sdk, hosts, events, beforePush, resolveExisting }
 *          resolveExisting()  the coordinator's resolution of an unbound form, answering
 *            { id, continuation: true }  the row at the id the creation port derived for this key (its
 *                                        own earlier create, continued without an adoption; no
 *                                        2.21.0 port protects forms, so sdk-build never answers it), or
 *            '<id>' | { id }             the one form of this table, type and name (sdk-build
 *                                        resolveExistingFormId: edited only with the adoption approval), or
 *            undefined                   nothing there: the form is created.
 *          A throw (an ambiguous name) becomes the refusal form-layout-resolve-refused.
 * Answers the FeatureResult plus { formId, action }.
 */
async function reconcileDeclaredForm(input, ctx = {}) {
  const { form, spec, def, sdk, hosts, events, beforePush, resolveExisting } = input || {};
  const key = formLayoutKey(form);
  const binding = await lookupBinding(ctx, KIND, key);
  let formId = binding && binding.id ? String(binding.id) : undefined;
  let continuation = false;
  if (!formId && typeof resolveExisting === 'function') {
    try {
      const found = await resolveExisting();
      if (found && typeof found === 'object') {
        formId = found.id ? String(found.id) : undefined;
        continuation = !!formId && found.continuation === true;
      } else {
        formId = found ? String(found) : undefined;
      }
    } catch (err) {
      const result = emptyResult();
      result.refused.push(refusal(key, 'form-layout-resolve-refused', (err && err.message) || String(err)));
      return { ...result, formId: null, action: null };
    }
  }
  const plan = await planDeclaredFormLayout({ form, spec, formId, intentTabs: def && def.tabs, sdk, hosts, events, continuation }, ctx);
  if (plan.action === 'create' && !plan.refused.length && !plan.unknown.length) {
    const r = await applyDeclaredFormCreate({ form, spec, def, sdk, hosts, events, beforePush }, ctx);
    const made = r.saved.find((s) => s.key === key);
    return { ...r, formId: made ? made.id : null, action: 'create' };
  }
  const r = await applyDeclaredFormLayout(plan, { sdk }, ctx);
  return { ...r, formId: plan.formId, action: plan.action };
}

/**
 * The verify oracle of a declared form against a stored form (verify-spec's reader), pure. Checks only
 * what the spec states: the form's type and table; each declared section in its declared tab (and form
 * column, when the spec states columns) with its stated width; each declared field exactly once, in its
 * section, in the declared reading order, with its stated spans and explicit flags; a requested timeline
 * that renders; each requested sub-grid / quick view target; each requested handler. Anything the spec
 * omits is unconstrained. Answers [{ code, message }] (empty when the form is as declared).
 *   input  { form, spec, intentTabs, hosts, events, liveForm, manifest }
 *          manifest  optional: this form's formManifestEntry from the last settled build. With it the
 *                    stored form must also be that id (form-identity), keep every bound child as the
 *                    kind and field it was bound as (form-managed-child), and hold the entry's host
 *                    targets and handlers. Without it nothing beyond the spec is asked.
 * A sub-grid host whose viewId is '' (verify cannot resolve the build's created views) matches any
 * stored sub-grid of the same relationship and child table.
 */
function verifyDeclaredForm({ form, spec, intentTabs, hosts, events, liveForm, manifest } = {}) {
  const issues = [];
  const issue = (code, message) => issues.push({ code, message });
  if (!isDeclaredForm(form)) return issues;
  if (!liveForm || !Array.isArray(liveForm.tabs)) { issue('form-missing', 'the declared form was not found'); return issues; }
  if ((liveForm.formType && formTypeCode(liveForm.formType) !== formTypeCode(formTypeOf(form)))
    || (liveForm.entityLogicalName && tableOf(form) && lc(liveForm.entityLogicalName) !== tableOf(form))) {
    issue('form-identity', `the form is a ${liveForm.formType} form of '${liveForm.entityLogicalName}', not the declared ${formTypeOf(form)} form of '${tableOf(form)}'`);
    return issues;
  }
  if (manifest && liveForm.id && !sameId(liveForm.id, manifest.id)) {
    issue('form-identity', `the form read is ${liveForm.id}, not ${manifest.id}, the form this build bound`);
    return issues;
  }
  const tabs = liveForm.tabs;
  const layout = declaredLayoutOf(form, intentTabs);
  const names = new Set(layout.sections.flatMap((s) => s.fields.map((f) => f.name)));
  const at = {};
  eachSection(tabs, (section, pointer) => {
    const rows = section.rows || [];
    for (const p of slotGrid(rows, section.columns).placed) {
      const cell = rows[p.row].cells[p.cell];
      const name = fieldOf(cell);
      if (name && names.has(name)) (at[name] || (at[name] = [])).push({ section, pointer, p, cell });
    }
  });
  for (const entry of layout.sections) {
    let section = null;
    if (!layout.auto) {
      const tab = tabs.find((t) => lc(t.name) === lc(entry.tab));
      if (!tab) { issue('form-container', `the tab '${entry.tab}' is missing`); continue; }
      (tab.columns || []).forEach((column, ci) => ((column && column.sections) || []).forEach((s) => {
        if (lc(s.name) === lc(entry.section) && (!entry.columnsStated || ci === entry.ci)) section = s;
      }));
      if (!section) { issue('form-container', `the section '${entry.section}' is not in the tab '${entry.tab}'${entry.columnsStated ? ` column ${entry.ci + 1}` : ''}`); continue; }
      if (entry.columns !== undefined && Number(section.columns) !== Number(entry.columns)) issue('form-width', `the section '${entry.section}' has ${section.columns} column(s), not ${entry.columns}`);
    }
    const placed = [];
    for (const f of entry.fields) {
      const found = at[f.name] || [];
      if (found.length !== 1) { issue('form-field-count', `'${f.name}' is on the form ${found.length} time(s), not once`); continue; }
      const { p, cell } = found[0];
      if (section && found[0].section !== section) { issue('form-field-section', `'${f.name}' is not in the section '${entry.section}'`); continue; }
      placed.push({ name: f.name, r: p.r, c: p.c });
      if (f.colspan !== undefined && p.colspan !== f.colspan) issue('form-field-span', `'${f.name}' spans ${p.colspan} column(s), not ${f.colspan}`);
      if (f.rowspan !== undefined && p.rowspan !== f.rowspan) issue('form-field-span', `'${f.name}' spans ${p.rowspan} row(s), not ${f.rowspan}`);
      const readOnly = !!(cell.control && cell.control.isReadOnly === true);
      if (f.readOnly !== undefined && readOnly !== f.readOnly) issue('form-field-flag', `'${f.name}' is ${readOnly ? '' : 'not '}read-only`);
      const hidden = cell.visible === false;
      if (f.hidden !== undefined && hidden !== f.hidden) issue('form-field-flag', `'${f.name}' is ${hidden ? '' : 'not '}hidden`);
    }
    // Reading order: row by row, then column. Only checked within a section the spec lays out.
    if (section) {
      const read = placed.slice().sort((a, b) => a.r - b.r || a.c - b.c).map((x) => x.name);
      if (read.join('|') !== placed.map((x) => x.name).join('|')) issue('form-field-order', `the fields of '${entry.section}' read ${read.join(', ')}, not ${placed.map((x) => x.name).join(', ')}`);
    }
  }
  if (wantsTimeline(spec, form) && !timelinesOf(tabs).some((t) => !timelineProblem(t, { host: false }))) issue('form-timeline', 'the form has no timeline that renders');
  const shown = new Set();
  eachCell(tabs, (cell) => { const t = hostTarget(cell.control); if (t) shown.add(t); });
  // A sub-grid whose view the reader could not resolve (viewId '') is matched on its relationship and target;
  // the manifest's targets (the ones this build stored) are matched exactly.
  const isShown = (t) => shown.has(t) || (/^subgrid\|[^|]*\|[^|]*\|$/.test(t) && [...shown].some((s) => s.startsWith(t)));
  const wantedTargets = [...new Set([...hostTargetsOf(hosts), ...((manifest && manifest.hosts) || [])])];
  for (const t of wantedTargets) if (!isShown(t)) issue('form-host', `the form does not show ${t.replace(/\|+$/, '').replace(/\|/g, ' ')}`);
  const have = handlerKeysOf(liveForm);
  const wantedHandlers = requestedHandlers(events || form.events);
  for (const ev of wantedHandlers) if (!have.has(handlerKey(ev))) issue('form-event', `the ${ev.event} handler ${ev.function} (${ev.library})${ev.event === 'onchange' && ev.attribute ? ` for ${ev.attribute}` : ''} is missing`);
  const asked = new Set(wantedHandlers.map(handlerKey));
  for (const k of (manifest && manifest.handlers) || []) if (!asked.has(k) && !have.has(k)) issue('form-event', `the handler ${k.split('|').filter(Boolean).join(' ')} this build stored is missing`);
  if (manifest) for (const problem of managedChildProblems(manifest.children, liveForm.tabs)) issue('form-managed-child', problem);
  return issues;
}

// What each managed child key says its object is: `tab:<name>` a tab, `section:<tab>/<section>` a section,
// `cell:<field>` / `control:<field>` the cell / control of that field, `spacer:...` a spacer cell, and the
// host and timeline keys (`cell:subgrid:<rel>`, `control:quickview:<lookup>`, `cell:timeline`) a cell or
// control whose field is not the key's.
function childKind(childKey) {
  const [head, ...rest] = String(childKey).split(':');
  const type = head === 'spacer' ? 'cell' : head;
  const field = (head === 'cell' || head === 'control') && rest.length === 1 && rest[0] !== 'timeline' ? lc(rest[0]) : undefined;
  return { type, field, spacer: head === 'spacer' };
}

// The managed children (manifest `children`, { childKey: id }) the stored form does not hold as what their
// key says: gone, held twice, or now another kind of object or bound to another field.
function managedChildProblems(children, tabs) {
  const at = structureOf(tabs);
  const out = [];
  for (const childKey of Object.keys(children || {}).sort()) {
    const id = idText(children[childKey]);
    const placed = at[id];
    if (placed === undefined) { out.push(`the ${childKey} this build bound (${children[childKey]}) is not on the form`); continue; }
    if (placed.includes('\n')) { out.push(`the ${childKey} this build bound (${children[childKey]}) is on the form more than once`); continue; }
    const got = JSON.parse(placed);
    const want = childKind(childKey);
    if (got.type !== want.type || (want.field !== undefined && got.field !== want.field) || (want.spacer && got.field !== null)) {
      out.push(`the ${childKey} this build bound (${children[childKey]}) is now a ${got.type}${got.field ? ` of '${got.field}'` : ''}`);
    }
  }
  return out;
}

// The raw spec keys of a declared form the manifest keeps so an explicit download can restore it: what the
// spec declared, never the stored form's content (no bags, maker controls or labels the spec omits).
const DECLARED_FORM_KEYS = ['entity', 'name', 'formType', 'reconcile', 'layout', 'prune', 'notes', 'tabs', 'subgrids', 'quickViews', 'events'];
const declaredSpecOf = (form) => {
  const out = {};
  for (const k of DECLARED_FORM_KEYS) if (form && form[k] !== undefined) out[k] = clone(form[k]);
  return out;
};

/**
 * The shared artifact manifest's entry for ONE declared form whose result settled cleanly (design §9.3:
 * canonical declarations, ids and hashes only). null for anything that did not settle or was not bound
 * (an unmanaged no-change), so failed work contributes no applied declaration.
 *   input  { form (RAW spec form), result (reconcileDeclaredForm's), hosts, events }
 * Answers { kind, key, id, formType, table, intentSha256, partsSha256, children: { childKey: id },
 *           hosts: [target], handlers: [handler key], declared: { raw spec keys } }.
 */
function formManifestEntry({ form, result, hosts, events } = {}) {
  if (!isDeclaredForm(form) || !result || (result.refused || []).length || (result.unknown || []).length) return null;
  const key = formLayoutKey(form);
  const bindings = result.managedBindings || [];
  const root = bindings.find((b) => b && b.kind === KIND && b.key === key);
  if (!root || !root.id) return null;
  const children = {};
  for (const b of bindings) if (b && b.kind === CHILD_KIND && String(b.key).startsWith(`${key}#`)) children[String(b.key).slice(key.length + 1)] = String(b.id);
  return {
    kind: KIND, key, id: String(root.id), formType: formTypeOf(form), table: tableOf(form),
    intentSha256: root.intentSha256, partsSha256: root.partsSha256, children,
    hosts: hostTargetsOf(hosts).sort(),
    handlers: [...new Set(requestedHandlers(events || (form && form.events)).map(handlerKey))].sort(),
    declared: declaredSpecOf(form),
  };
}

/**
 * Explicit download (hydrate-spec): the declared form a manifest entry restores for the downloaded form, only
 * when the entry is this form's (same id, type and table), every managed child is still what it was bound
 * as, and the stored layout projection is the one the build recorded. Answers { form } (the declared raw
 * form to put in the spec) or { stale: reason } (hydrate the form as today and report it unverified).
 *   input  entry (formManifestEntry's), { formId, liveForm (the SDK form: formType, entityLogicalName, tabs) }
 */
function hydrateDeclaredForm(entry, { formId, liveForm } = {}) {
  if (!entry || entry.kind !== KIND || !entry.id || !entry.partsSha256 || !entry.declared || !isDeclaredForm(entry.declared)) return { stale: 'the manifest entry is not a declared form entry' };
  if (!sameId(entry.id, formId)) return { stale: `the manifest names form ${entry.id}, not ${formId}` };
  if (!liveForm || !Array.isArray(liveForm.tabs)) return { stale: 'the form could not be read' };
  if ((liveForm.formType && formTypeCode(liveForm.formType) !== formTypeCode(entry.formType)) || (liveForm.entityLogicalName && lc(liveForm.entityLogicalName) !== lc(entry.table))) {
    return { stale: `the form is a ${liveForm.formType} form of '${liveForm.entityLogicalName}', not the ${entry.formType} form of '${entry.table}' the manifest names` };
  }
  const moved = managedChildProblems(entry.children, liveForm.tabs);
  if (moved.length) return { stale: moved[0] };
  if (canonicalJson(projectionBaseline(formProjection(liveForm.tabs)).partsSha256) !== canonicalJson(entry.partsSha256)) {
    return { stale: 'the form\'s layout changed after the build that wrote the manifest' };
  }
  return { form: clone(entry.declared) };
}

module.exports = {
  KIND,
  CHILD_KIND,
  isDeclaredForm,
  formLayoutKey,
  declaredOptions,
  declaredLayoutOf,
  packDeclaredLayout,
  declaredSlotRows,
  formProjection,
  planDeclaredFormLayout,
  applyDeclaredFormLayout,
  applyDeclaredFormCreate,
  declaredHostsOf,
  reconcileDeclaredForm,
  verifyDeclaredForm,
  formManifestEntry,
  hydrateDeclaredForm,
};
