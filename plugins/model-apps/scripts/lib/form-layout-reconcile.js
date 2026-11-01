'use strict';
// Declared form layout (`forms[].reconcile: "declared"`): the spec's bound fields sit exactly where it
// declares them, while every control the spec does not declare keeps exactly where it is.
//
// Without the opt-in the build keeps its additive behaviour (sdk-build's field/topology passes). With it:
//   - EXISTING form (planDeclaredFormLayout): for each declared section the cells of declared fields are
//     packed again in the declared reading order, each at the first free slot at or after the previous one.
//     Every other cell — a maker's field, a sub-grid, a quick view, a timeline, a spacer this build did not
//     write, a row's own payload — is a FIXED OBSTACLE that keeps its row, column and spans as they are at
//     the section's OLD width. A declared field found in another section moves here in the same write,
//     keeping its ids and metadata. A free slot a later cell must skip is held by a spacer cell (`control:
//     null`, the SDK's shape for one); only spacers this build recorded as its own, still where it put them,
//     may be recycled. A row this pack empties is kept while a maker's cell sits at or below it, or while the
//     row carries a payload of its own, so nothing the spec does not own moves up or is dropped. A section is
//     never moved and a section the spec places in a form column the tab lacks refuses; an existing sub-grid
//     / quick view must already show what is requested (a different target, or any stated placement,
//     refuses rather than being silently kept).
//   - NEW form (planCreate): the complete composite — packed fields, the timeline, sub-grids, quick views
//     and event handlers — is built locally with every id supplied (the form's and each child's from the
//     creation catalog) and sent in ONE push.
// Positions come from the column-slot model (form-occupancy.js slotGrid), not the width-only
// rowOccupancy the additive path uses: a maker's cell in column 1 beside a row-spanning cell needs one.
//
// What is owned: the order, the section and the spans of declared fields, the width of a declared
// section when the spec states it, readOnly / hidden when the spec states them (an explicit false
// clears the flag), the declared tabs and sections, and a requested timeline / sub-grid / quick view
// that is missing. Labels, isRequired, PCF parameters and events of existing cells are never inferred
// from compiler defaults.
//
// Settlement. A declared form is one managed group (managed-bindings.js, family 'form'): the form as root
// and every tab, section, cell, control and helper spacer the build relies on as a child, keyed by what it
// is (see childOf). reconcileDeclaredForm runs it through managed-feature-contract.js runManagedFeature:
// the attempt and the complete expected proof are persisted BEFORE the one push, the stored form is proved
// from a fresh read against that expected proof, and the whole group is committed in one store write. A
// pending attempt found later is proved the same way and never sent again. The root record baselines the
// FULL layout projection (formProjection) with a hash per part, so a part someone else changed since the
// last build refuses as drift while a newly declared part is an edit. A recorded child is authoritative:
// a recorded tab, section, field cell or host that is gone or was replaced refuses
// (create-completion-required) instead of being re-found by name.
//
// Proof (projectFormComposite / proveFormComposite). One composite proof serves the write, recovery,
// verify, publication and download: each child's ASSOCIATION (what it is and where it stands — its parent,
// name or field, slot and spans, class and host target), the SEMANTIC projection of the form (layout, every
// handler, host targets, the rendering timeline) and the PRESERVATION of everything the spec does not own.
// Ids alone prove nothing: two sub-grids whose targets were swapped under unchanged ids hold the same ids.
//
// Publication. The committed group records the publication it owes; publishDeclaredFormTable pays it per
// table through managed-feature-contract.js publishManagedScope — the only way this helper publishes —
// once the table's forms have settled, a no-op included.

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
const { runManagedFeature, publishManagedScope } = require('./managed-feature-contract.js');
const { rootCreateAcknowledged } = require('./managed-bindings.js');
const { readSystemFormPublication, readSystemFormRootPresence, systemFormLayerSha256 } = require('./systemform-published.js');
const { publishTablesXml } = require('./table-publish.js');
const { hasUnsyncedEdits } = require('./unsynced-edits.js');
const {
  refusal,
  isApproved,
  partsDriftVerdict,
  projectionBaseline,
  pushChecked,
  canonicalJson,
  normalizeGuid,
  intentSha256,
} = require('./reconcile-common.js');

// The managed binding family of a declared form (managed-bindings.js), and the schema of its composite proof.
const FAMILY = 'form';
const PROOF_SCHEMA = 'form-composite-v1';
// The SDK artifact type of a form.
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

/**
 * The planned tree with ids set: each `__fresh` object takes its id from `childIds` (the creation catalog's
 * reservation), markers are stripped. Answers { tabs, ids, freshIds, fresh } where `ids` maps every child locator
 * the write relies on — fresh objects and tracked existing ones (`__track`) — to its id, and `fresh` is the set of
 * locators this write adds.
 */
function materialize(planned, childIds = {}) {
  const tabs = clone(planned);
  const ids = {};
  const freshIds = [];
  const fresh = new Set();
  const settle = (o) => {
    if (!o || typeof o !== 'object') return;
    if (o.__fresh) {
      const id = childIds[o.__fresh];
      if (id) { o.id = id; freshIds.push(id); ids[o.__fresh] = id; fresh.add(o.__fresh); }
    } else if (o.__track && o.id) {
      ids[o.__track] = o.id;
    }
  };
  for (const tab of tabs) settle(tab);
  eachSection(tabs, (section) => {
    settle(section);
    for (const row of section.rows || []) for (const cell of row.cells || []) { settle(cell); if (cell) settle(cell.control); }
  });
  stripMarkers(tabs);
  return { tabs, ids, freshIds, fresh };
}

const codeError = (code, message) => Object.assign(new Error(message || code), { code });

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
function handlerEntriesOf(form) {
  const out = [];
  const attrOf = (node, name) => (((node && node.a) || []).find((a) => a[0] === name) || [])[1];
  for (const entry of ((form && form.bag && form.bag.c) || [])) {
    if (!entry || !entry.node || entry.node.n !== 'events') continue;
    for (const evNode of entry.node.c || []) {
      for (const handlers of (evNode && evNode.c) || []) {
        for (const handler of (handlers && handlers.c) || []) {
          out.push({
            key: keyOfHandler(attrOf(evNode, 'name'), attrOf(evNode, 'attribute'), attrOf(handler, 'functionName'), attrOf(handler, 'libraryName')),
            options: handlerOptionsOf(handler),
          });
        }
      }
    }
  }
  return out;
}
const handlerKeysOf = (form) => new Set(handlerEntriesOf(form).map((h) => h.key));
const keyOfHandler = (event, attribute, fn, library) => `${event}|${event === 'onchange' ? lc(attribute) : ''}|${fn}|${library}`;
const handlerKey = (ev) => keyOfHandler(ev.event, ev.attribute, ev.function, ev.library);
const requestedHandlers = (events) => (events || []).filter((ev) => ev && FORM_EVENTS.has(ev.event) && ev.library && ev.function);
// The options a <Handler> node carries, as comparable text: enabled and passExecutionContext as lower-cased flags
// ('true'/'false'), parameters exactly. An attribute the node lacks reads as '' — never as a default — so a handler
// whose options cannot be shown equal to the declared ones is never certified as declared.
function handlerOptionsOf(node) {
  const at = (name) => (((node && node.a) || []).find((a) => Array.isArray(a) && a[0] === name) || [])[1];
  const text = (v) => (v === undefined || v === null ? '' : String(v));
  return canonicalJson({ enabled: lc(at('enabled')), parameters: text(at('parameters')), passExecutionContext: lc(at('passExecutionContext')) });
}
// The options a declared handler is written with (formEventsRegionIntent: enabled and passExecutionContext true unless
// stated false, parameters '' when absent), comparable with handlerOptionsOf.
const requestedOptionsOf = (ev) => handlerOptionsOf(formEventsRegionIntent([ev]).c[0].c[0].c[0]);
// The declared handlers whose identity the form holds with other options — or which the spec declares twice with
// different options. Changing the options of a handler that is already on the form is not supported (a write adds only
// missing handlers), so these refuse before anything is written, and verify and download never pass them.
function handlerOptionConflicts(form, events) {
  const live = handlerEntriesOf(form);
  const wanted = new Map();
  const out = [];
  for (const ev of requestedHandlers(events)) {
    const k = handlerKey(ev);
    const opts = requestedOptionsOf(ev);
    if (wanted.has(k) && wanted.get(k) !== opts) { out.push(ev); continue; }
    wanted.set(k, opts);
    if (live.some((h) => h.key === k && h.options !== opts)) out.push(ev);
  }
  return out;
}
const handlerLabel = (ev) => `the ${ev.event} handler ${ev.function} (${ev.library})${ev.event === 'onchange' && ev.attribute ? ` for ${ev.attribute}` : ''}`;

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

// The ids the form's committed managed group holds for `childKeys`: { childKey: id } (unrecorded keys absent).
// `recorded` is that group's { childKey: id } (recordedLocators); a form with no committed group has none.
function recordedChildren(recorded, childKeys) {
  const out = {};
  for (const childKey of new Set(childKeys)) if (recorded[childKey]) out[childKey] = recorded[childKey];
  return out;
}

// The { childKey: id } of the committed group of the form `key`: every child record is keyed `<form key>#<child key>`
// under the form's root record (see childRecords).
function recordedLocators(committed, key) {
  const out = {};
  for (const rec of (committed && committed.records) || []) {
    if (rec.parentKey === key && String(rec.key).startsWith(`${key}#`)) out[String(rec.key).slice(key.length + 1)] = String(rec.id);
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

// The spacers of `section` this build recorded at the slot they stand in now ({ lowercased id: locator }): a helper
// spacer is known by its slot (`spacer:<section key>:<row>:<column>`), and is the build's only while its last proof
// still holds — `holds(id, locator)` — so a stale record of a spacer an earlier write dropped steers nothing.
function recordedSpacers(recorded, sectionKey, section, holds = () => true) {
  const owned = new Map();
  const rows = (section && section.rows) || [];
  for (const p of slotGrid(rows, section.columns).placed) {
    const cell = rows[p.row].cells[p.cell];
    if (!isSpacer(cell) || !cell.id) continue;
    const locator = `spacer:${sectionKey}:${p.r}:${p.c}`;
    const id = recorded[locator];
    if (id && sameId(id, cell.id) && holds(idText(cell.id), locator)) owned.set(idText(cell.id), locator);
  }
  return owned;
}

// A container the build relies on: by its recorded id first, else by a unique name among `candidates` (its exact
// parent). One found by its recorded id must still carry the declared name: the spec maps each declared field to a
// qualified tab/section, so a recorded tab or section the maker renamed (or two sections whose names were exchanged)
// is not the declared one any more, and planning into it would bind the spec's fields to another container. Answers
// { found } | { missing: true } (recorded but gone) | { renamed: <its name> } | { ambiguous: true } | {} (nothing there yet).
function resolveContainer(recorded, childKey, candidates, everywhere, name) {
  const id = recorded[childKey];
  if (id) {
    const found = everywhere.find((o) => sameId(o.id, id));
    if (!found) return { missing: true };
    return lc(found.name) === lc(name) ? { found } : { renamed: String(found.name || '') };
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
 *   live        the stored form as just read ({ formType, entityLogicalName, tabs, bag })
 *   ctx         { baseline (the committed root record, or null), recorded ({ locator: id } of the committed
 *               group's records), children (the last proof's { locator: { id, kind, associationSha256 } }),
 *               authorizedAdoption, authorizedOverwrite (true, or a Set or array of family-typed keys: only
 *               `form:<key>` approves this form, reconcile-common.js approvalKey) }
 * Answers { key, action: null|'noChange'|'update', refused, unknown, planned, freshKeys, mobileIds, repairedIds,
 * addHandlers, ... }. A form that does not exist yet is not planned here: reconcileDeclaredForm builds it whole
 * with planCreate.
 *
 * What this build recorded is authoritative: a form of another type or table under the resolved id, or a
 * recorded tab, section, field cell or control, timeline or host that is gone or was replaced by another
 * object, refuses before anything is written — it is never re-found by name and silently re-bound.
 */
function planDeclaredFormLayout({ form, spec, formId, live, intentTabs, hosts, events }, ctx = {}) {
  const key = formLayoutKey(form);
  const plan = { key, formId: formId || null, table: tableOf(form), formType: formTypeOf(form), name: lc(form && form.name), action: null, refused: [], unknown: [] };
  if (!isDeclaredForm(form)) return plan;
  const refuse = (code, message) => { plan.refused.push(refusal(key, code, message)); return plan; };
  const layout = declaredLayoutOf(form, intentTabs);
  if (layout.duplicates.length) return refuse('form-layout-duplicate-field', `the spec places ${[...new Set(layout.duplicates)].join(', ')} more than once; a declared field has one place`);
  // The committed group's root record (the full layout baseline) and its { childKey: id }. Child records
  // exist only inside a committed group, which the store writes whole, so no partial group can steer this.
  const binding = ctx.baseline || null;
  const records = ctx.recorded || {};
  if (!live || !Array.isArray(live.tabs)) { plan.unknown.push(refusal(key, 'form-unreadable', 'the form could not be read')); return plan; }
  // An id the form holds twice makes every association ambiguous: nothing can be proved about it, so nothing is written.
  const liveComposite = compositeOf(live.tabs);
  if (liveComposite.duplicates.length) return refuse('form-layout-duplicate-id', `the form holds ${liveComposite.duplicates.length} id(s) more than once; fix the form in the form designer first`);
  const lastChildren = ctx.children || {};
  const holds = (id, locator) => !!lastChildren[locator] && sameId(lastChildren[locator].id, id)
    && variantHashes(liveComposite.at.get(id)).includes(lastChildren[locator].associationSha256);
  // The row must be the form the key names: a Main row under a Quick View key (or another table's form) is
  // a different form, whatever its layout looks like.
  if ((live.formType && formTypeCode(live.formType) !== formTypeCode(plan.formType)) || (live.entityLogicalName && plan.table && lc(live.entityLogicalName) !== plan.table)) {
    return refuse('form-layout-identity-mismatch', `form ${plan.formId} is a ${live.formType || '?'} form of '${live.entityLogicalName || '?'}', not the ${plan.formType} form of '${plan.table}' this spec declares; nothing was written`);
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
  const recorded = recordedChildren(records, [
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
      const t = resolveContainer(records, tKey, allTabs(), allTabs(), entry.tab);
      if (t.missing) return refuse('create-completion-required', `the tab '${entry.tab}' this form was built with is gone; run a full build after restoring it, or repair the binding`);
      if (t.renamed !== undefined) return refuse('form-layout-container-moved', `the tab this form was built with as '${entry.tab}' is now named '${t.renamed}'; renaming a declared tab is not supported — rename it back in the form designer, or repair the binding`);
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
      const s = resolveContainer(records, sKey, inTab, allSections(), entry.section);
      if (s.missing) return refuse('create-completion-required', `the section '${entry.section}' this form was built with is gone; run a full build after restoring it, or repair the binding`);
      if (s.renamed !== undefined) return refuse('form-layout-container-moved', `the section this form was built with as '${entry.section}' is now named '${s.renamed}'; renaming or exchanging declared sections is not supported — rename it back in the form designer, or repair the binding`);
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
    const spacerLocators = p.section.__fresh ? new Map() : recordedSpacers(records, p.sectionKey, p.section, holds);
    const ownedSpacers = new Set(spacerLocators.keys());
    for (const id of ownedSpacers) mobileIds.add(id);
    // A recycled spacer stays where it stands, so it keeps its locator; one the pack drops is simply not in the tree.
    for (const row of p.section.rows || []) for (const cell of row.cells || []) if (cell && spacerLocators.has(idText(cell.id))) cell.__track = spacerLocators.get(idText(cell.id));
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
  // A host section (the timeline's or a sub-grid's) an earlier run of this form added stays the build's: it is tracked
  // under its recorded locator wherever its recorded id still stands, so every later proof keeps checking it (and an
  // unchanged form stays a no-op rather than a re-baseline that drops it from the proof).
  eachSection(tabs, (s) => {
    if (!s || !s.id || s.__fresh || s.__track) return;
    const locator = Object.keys(records).find((l) => /^section:(timeline$|subgrid:)/.test(l) && sameId(records[l], s.id));
    if (locator) s.__track = locator;
  });
  const problem = validateDesired(liveTabs, tabs, { formType, declaredHome, mobileIds, repairedIds });
  if (problem) return refuse(problem, 'the planned layout would move a control the spec does not own or leave a declared field out of place; nothing was written');
  const desired = stripMarkers(clone(tabs));
  plan.planned = tabs;
  plan.freshKeys = freshKeys(tabs);
  plan.liveParts = formProjection(liveTabs);
  plan.desiredParts = formProjection(desired);
  plan.wantsTimeline = wantsTimelineToo;
  plan.liveTabs = liveTabs;
  plan.mobileIds = [...mobileIds];
  plan.repairedIds = [...repairedIds];
  plan.hostTargets = hostTargetsOf(hosts);
  plan.handlers = requestedHandlers(events);
  const optionConflict = handlerOptionConflicts(live, events)[0];
  if (optionConflict) return refuse('form-handler-options-unsupported', `${handlerLabel(optionConflict)} is on the form with other options (enabled, parameters or passExecutionContext) than the spec declares, or is declared twice with different ones; changing the options of an existing handler is not supported — change them in the form designer, or declare what the form holds`);
  const haveHandlers = handlerKeysOf(live);
  plan.addHandlers = plan.handlers.filter((ev, i) => !haveHandlers.has(handlerKey(ev)) && plan.handlers.findIndex((o) => handlerKey(o) === handlerKey(ev)) === i);
  const tabsUnchanged = canonicalJson(desired) === canonicalJson(liveTabs);
  if (tabsUnchanged && !plan.addHandlers.length) {
    plan.action = 'noChange';
    plan.bindUnchanged = !!binding || isApproved(ctx.authorizedAdoption, FAMILY, key);
    return plan;
  }
  const verdict = tabsUnchanged ? (binding ? 'none' : 'unbound') : partsDriftVerdict(binding, plan.liveParts, plan.desiredParts);
  if (verdict === 'drift' && !isApproved(ctx.authorizedOverwrite, FAMILY, key)) {
    return refuse('form-layout-drift', `the layout of a declared field was changed outside the spec since the last build; refresh the spec or approve the overwrite (${FAMILY}:${key})`);
  }
  if (verdict === 'unbound' && !isApproved(ctx.authorizedAdoption, FAMILY, key)) {
    return refuse('form-layout-adoption-not-authorized', `this form exists and the spec has not managed its layout before; approve adopting it first (${FAMILY}:${key})`);
  }
  plan.action = 'update';
  return plan;
}

// ---------------------------------------------------------------------------------------------------------
// Child identities. Every tab, section, cell, control and helper spacer the build relies on is a child of the
// form's managed group, named by a LOCATOR that says what it is — never by where it happens to stand:
//   tab:<tab>                        formTab           [tab]
//   section:<tab>/<section>          formSection       [tab, section]
//   section:timeline                 formHostSection   ['timeline', 'timeline']
//   section:subgrid:<relationship>   formHostSection   ['subgrid', relationship]
//   cell:timeline                    formHostCell      ['timeline', 'timeline']   (its control keeps `notescontrol`)
//   cell|control:subgrid:<rel>       formHostCell / formHostControl  ['subgrid', rel]
//   cell|control:quickview:<lookup>  formHostCell / formHostControl  ['quickView', lookup]
//   cell|control:<field>             formCell / formControl          [form key, field]
//   spacer:<section key>:<row>:<col> formSpacer        [<section key>:<row>:<col>] (the slot it was created at)
// A new child takes its id from the creation catalog (creates-catalog.js reserveChildren) under the ACTUAL form
// id, so the id a re-run derives for an unsettled add is the one already on the form. A locator the catalog has
// no slot for is refused before anything is written.
// ---------------------------------------------------------------------------------------------------------
const CONTAINER_KINDS = new Set(['formTab', 'formSection', 'formHostSection']);

function childOf(formKey, locator) {
  const m = /^(tab|section|cell|control|spacer):(.+)$/.exec(String(locator || ''));
  if (!m) return null;
  const [, head, rest] = m;
  if (head === 'tab') return { childKind: 'formTab', keyParts: [rest] };
  if (head === 'spacer') return { childKind: 'formSpacer', keyParts: [rest] };
  if (head === 'section') {
    if (rest === 'timeline') return { childKind: 'formHostSection', keyParts: ['timeline', 'timeline'] };
    const sg = /^subgrid:(.+)$/.exec(rest);
    if (sg) return { childKind: 'formHostSection', keyParts: ['subgrid', sg[1]] };
    const slash = rest.indexOf('/');
    if (slash <= 0 || slash === rest.length - 1) return null;
    return { childKind: 'formSection', keyParts: [rest.slice(0, slash), rest.slice(slash + 1)] };
  }
  if (rest === 'timeline') return head === 'cell' ? { childKind: 'formHostCell', keyParts: ['timeline', 'timeline'] } : null;
  const host = /^(subgrid|quickview):(.+)$/.exec(rest);
  if (host) return { childKind: head === 'cell' ? 'formHostCell' : 'formHostControl', keyParts: [host[1] === 'quickview' ? 'quickView' : 'subgrid', host[2]] };
  if (rest.includes(':')) return null;
  return { childKind: head === 'cell' ? 'formCell' : 'formControl', keyParts: [formKey, rest] };
}

// The catalog intent of a declared form: what the coordinator registers with createIntentCatalog so the form's
// id (and every child id) is derived from its key.
function formCatalogIntent(form, { solution } = {}) {
  return {
    catalogKind: FAMILY,
    key: formLayoutKey(form),
    scope: { kind: 'table', solution, table: tableOf(form) },
    declaration: { formType: formTypeOf(form), name: lc(form && form.name) },
  };
}

// Reserve ids for `locators` (new children) under the actual form id. Answers { locator: id }.
function reserveChildIds(catalog, key, formId, locators) {
  if (!locators.length) return {};
  if (new Set(locators).size !== locators.length) throw codeError('form-layout-container-ambiguous', 'the planned form names one child twice');
  const children = locators.map((locator) => {
    const c = childOf(key, locator);
    if (!c) throw codeError('create-identity-unsupported', `the form child "${locator}" has no stable identity`);
    return { locator, ...c };
  });
  const { childIds } = catalog.reserveChildren(FAMILY, key, { actualRootId: formId, children });
  return childIds || {};
}

// ---------------------------------------------------------------------------------------------------------
// The composite proof (projectFormComposite / proveFormComposite). One projection of a stored form serves the
// write's proof, recovery, verify, the publication decision and hydrate:
//   association  what each child IS, by id: a tab (name), a section (its tab and form column, and name), a cell
//                (its section, slot, spans and field), a control (its cell, field, class and host target — the
//                relationship, table and view of a sub-grid; the lookup, table and form of a quick view). Ids
//                alone prove nothing: two sub-grids whose targets were swapped under unchanged ids hold the same
//                id set and differ only here;
//   semantic     what the form shows: type, table, the full field layout projection, every handler node
//                (event, attribute, library, function, enabled, parameters, execution context), the multiset of
//                host targets and the number of timelines that render;
//   preservation what a declared write must leave as it was: every cell, row payload, tab and section the build
//                does not own (foreignInventory) and — on an existing form — the root bag outside its events
//                region (header, footer, navigation, libraries...).
// ---------------------------------------------------------------------------------------------------------
const omitKeys = (o, keys) => { const c = { ...(o || {}) }; for (const k of keys) delete c[k]; return c; };

// Every id the tree holds, with the association variants it may prove: containers answer a 'fresh' variant (a
// container this build added: its name and parent only, because the store fills in its own defaults) and a
// 'kept' one (a container that was already there: every property it had, which must survive); a control answers
// a variant with its class and one without (a field control sent without a class gets the store's default).
// Answers { at: Map(id -> [variant]), duplicates: [id] }.
function compositeOf(tabs) {
  const at = new Map();
  const duplicates = new Set();
  const put = (id, variants) => {
    const k = idText(id);
    if (!k) return;
    if (at.has(k)) { if (k !== TIMELINE_CONTROL_ID) duplicates.add(k); return; }
    at.set(k, variants);
  };
  (tabs || []).forEach((tab, ti) => {
    const tabRef = idText(tab && tab.id) || `#${ti}`;
    const name = lc(tab && tab.name);
    put(tab && tab.id, [
      { type: 'tab', v: 'fresh', name },
      { type: 'tab', v: 'kept', name, own: omitKeys(tab, ['columns', ...MARKERS]), columns: ((tab && tab.columns) || []).map((c) => omitKeys(c, ['sections'])) },
    ]);
    ((tab && tab.columns) || []).forEach((column, ci) => ((column && column.sections) || []).forEach((section, si) => {
      const sectionRef = idText(section && section.id) || sectionPath(tab, ti, ci, section, si);
      const parent = `${tabRef}|${ci}`;
      const own = omitKeys(section, ['rows', 'columns', ...MARKERS]);
      if (own.bag && Array.isArray(own.bag.a)) own.bag = { ...own.bag, a: own.bag.a.filter((a) => !(Array.isArray(a) && lc(a[0]) === 'columns')) };
      put(section && section.id, [
        { type: 'section', v: 'fresh', parent, name: lc(section && section.name) },
        { type: 'section', v: 'kept', parent, name: lc(section && section.name), own },
      ]);
      const rows = (section && section.rows) || [];
      for (const p of slotGrid(rows, section.columns).placed) {
        const cell = rows[p.row].cells[p.cell];
        if (!cell) continue;
        put(cell.id, [{ type: 'cell', parent: sectionRef, r: p.r, c: p.c, colspan: p.colspan, rowspan: p.rowspan, field: fieldOf(cell) || null }]);
        if (cell.control) {
          const base = { type: 'control', parent: idText(cell.id) || `${sectionRef}|${p.r},${p.c}`, field: lc(cell.control.fieldName) || null, target: hostTarget(cell.control) || null };
          put(cell.control.id, [{ ...base, classId: idText(cell.control.classId) || null }, { ...base, classId: null }]);
        }
      }
    }));
  });
  return { at, duplicates: [...duplicates] };
}

const variantHashes = (variants) => (variants || []).map((v) => intentSha256(v));

// Every handler node of the root bag's <events> region, canonical and sorted (a multiset): the per-handler
// `handlerUniqueId` the store mints is left out and attributes are compared as a set. Shape, as the SDK holds it:
//   { n: 'event', a: [['name','onload'], ['application','false'], ['active','false']], c: [ { n: 'Handlers',
//     c: [ { n: 'Handler', a: [['functionName','app.onLoad'], ['libraryName','new_/app.js'], ['handlerUniqueId','{…}'],
//     ['enabled','true'], ['passExecutionContext','true'], ['parameters','']] } ] } ] }
function handlerNodesOf(bag) {
  const norm = (node) => {
    if (!node || typeof node !== 'object') return node;
    const a = ((node.a || []).filter((x) => Array.isArray(x) && lc(x[0]) !== 'handleruniqueid')).map((x) => [x[0], x[1]]);
    a.sort((x, y) => (String(x[0]) < String(y[0]) ? -1 : String(x[0]) > String(y[0]) ? 1 : 0));
    return { n: node.n, a, c: (node.c || []).map(norm) };
  };
  const out = [];
  for (const entry of (bag && bag.c) || []) {
    if (!entry || !entry.node || entry.node.n !== 'events') continue;
    for (const ev of entry.node.c || []) out.push(canonicalJson(norm(ev)));
  }
  return out.sort();
}

// The root bag a write must not change: its attributes and every entry but the <events> region (whose handlers
// the semantic projection covers node by node).
const rootBagOf = (bag) => ({
  a: (bag && bag.a) || [],
  c: ((bag && bag.c) || []).filter((e) => !(e && e.node && e.node.n === 'events')),
});

function hostTargetsShown(tabs) {
  const out = [];
  eachCell(tabs, (cell) => { const t = hostTarget(cell.control); if (t) out.push(t); });
  return out.sort();
}

/** The semantic projection of a form ({ formType, entityLogicalName, tabs, bag }). */
function projectFormComposite(form) {
  const tabs = (form && form.tabs) || [];
  return {
    formType: formTypeCode(form && form.formType),
    table: lc(form && form.entityLogicalName),
    layout: formProjection(tabs),
    handlers: handlerNodesOf(form && form.bag),
    hosts: hostTargetsShown(tabs),
    timelines: timelinesOf(tabs).filter((t) => !timelineProblem(t, { host: false })).length,
  };
}

// What a write must preserve, given the children it owns: owned cells and controls are left out of the
// inventory, owned containers are proven by their association instead.
function preservationOf(form, children, { update }) {
  const owned = new Set();
  const containers = new Set();
  for (const c of children || []) (CONTAINER_KINDS.has(c.kind) ? containers : owned).add(idText(c.id));
  return {
    tree: foreignInventory((form && form.tabs) || [], { owned, fresh: containers }),
    root: update ? rootBagOf(form && form.bag) : null,
  };
}

const savedShaOf = (form) => intentSha256({ formType: form.formType, entityLogicalName: form.entityLogicalName, tabs: form.tabs, bag: form.bag || null });

/**
 * Prove a stored form against an expected proof (the one persisted before the send). Answers { comp } or throws
 * a coded error: a child that is gone `create-completion-required`; anything else that differs
 * `form-layout-unproved`. Used by the write's proof, recovery, verify and hydrate.
 */
function proveFormComposite(form, expected) {
  if (!form || !Array.isArray(form.tabs)) throw codeError('create-completion-required', 'the form was not found');
  const comp = compositeOf(form.tabs);
  if (comp.duplicates.length) throw codeError('form-layout-duplicate-id', `the form holds ${comp.duplicates.length} id(s) more than once`);
  for (const child of expected.children || []) {
    const variants = comp.at.get(idText(child.id));
    if (!variants) throw codeError('create-completion-required', `the ${child.key.split('#').pop()} this build placed is not on the form`);
    if (!variantHashes(variants).includes(child.associationSha256)) throw codeError('form-layout-unproved', `the ${child.key.split('#').pop()} this build placed is now something else or stands somewhere else`);
  }
  if (intentSha256(projectFormComposite(form)) !== expected.sentProjectionSha256) {
    throw codeError('form-layout-unproved', 'the stored form does not show the layout, handlers, hosts or timeline that were sent');
  }
  if (intentSha256(preservationOf(form, expected.children, { update: expected.baseObservation !== null })) !== expected.preservationSha256) {
    throw codeError('form-layout-unproved', 'the stored form does not hold something the spec does not own as it was before the write');
  }
  return { comp };
}

// The bag after `handlers` are added the way addHandlers adds them: a new <events> region when there is none,
// else appended to it.
function withHandlers(bag, handlers) {
  const out = clone(bag || { a: [], c: [] });
  if (!handlers.length) return out;
  if (!Array.isArray(out.c)) out.c = [];
  const regionIdx = out.c.findIndex((e) => e && e.node && e.node.n === 'events');
  if (regionIdx < 0) {
    const nextI = out.c.reduce((max, e) => Math.max(max, Number(e && e.i)), -1) + 1;
    out.c.push({ i: nextI, node: formEventsRegionIntent(handlers) });
  } else {
    const region = out.c[regionIdx].node;
    region.c = [...(region.c || []), ...handlers.map((ev) => formEventsRegionIntent([ev]).c[0])];
  }
  return out;
}

// The raw spec keys of a declared form the managed group keeps so verify and an explicit download can restore it:
// what the spec declared, never the stored form's content. `fieldOptions` is kept as written, so an explicit false
// stays distinct from an absent flag.
const DECLARATION_KEYS = ['entity', 'table', 'name', 'formType', 'reconcile', 'layout', 'notes', 'tabs', 'fieldOptions', 'subgrids', 'quickViews', 'events'];
function declarationOf(form) {
  const out = {};
  for (const k of DECLARATION_KEYS) if (form && form[k] !== undefined) out[k] = clone(form[k]);
  return out;
}

// The expected children of a materialized tree: one per recorded locator, with its association hash ('fresh'
// variant for a container this write adds, 'kept' for one that was there).
function expectedChildrenOf(key, formId, m) {
  const comp = compositeOf(m.tabs);
  if (comp.duplicates.length) throw codeError('form-layout-duplicate-id', 'the planned form holds an id twice');
  return Object.keys(m.ids).sort().map((locator) => {
    const c = childOf(key, locator);
    if (!c) throw codeError('create-identity-unsupported', `the form child "${locator}" has no stable identity`);
    const id = idText(m.ids[locator]);
    const variants = comp.at.get(id) || [];
    const pick = CONTAINER_KINDS.has(c.childKind) && !m.fresh.has(locator) ? variants[1] : variants[0];
    if (!pick) throw codeError('create-identity-unsupported', `the form child "${locator}" is not in the planned form`);
    return { kind: c.childKind, key: `${key}#${locator}`, namespaceParentId: idText(formId), id, associationSha256: intentSha256(pick) };
  });
}

// The child-create receipt a write's save answer stands for ({ kind, key, id }): the expected children this plan
// reserved as NEW (`m.fresh`) and sends in its one push. A child whose id the live form already holds (`liveTabs`; null
// for a create) was there before this write, so it is never claimed as made by it, whatever the plan marked it.
function newChildrenOf(key, children, m, liveTabs) {
  const there = liveTabs ? compositeOf(liveTabs).at : new Map();
  return children
    .filter((c) => m.fresh.has(c.key.slice(key.length + 1)) && !there.has(idText(c.id)))
    .map((c) => ({ kind: c.kind, key: c.key, id: c.id }));
}

// The complete tree of a NEW declared form, every object marked with its locator. Sections of field cells only
// are packed again by slot (the compiler's width-only rows let a cell after a middle row-spanning one run past the
// grid); any other section keeps its compiled rows, its cells named by what they hold. Answers { tabs } or
// { refused: code }.
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
          if (hostsTimeline && cell.control && cell.control.id === TIMELINE_CONTROL_ID) { mark(cell, 'cell:timeline'); return; }
          const field = fieldOf(cell);
          // A cell is named by what it holds; one that holds nothing is a spacer of its section at the slot it
          // was created at. Any other control (a compiled host the declared path does not add itself) has no
          // stable name and refuses.
          let at = '';
          if (field) at = field;
          else if (!cell.control) { mark(cell, `spacer:${sk}:${ri}:${ci}`); return; }
          else if (sameId(cell.control.classId, SUBGRID_CLASS_ID)) at = `subgrid:${lc(cell.control.parameters && cell.control.parameters.RelationshipName)}`;
          else if (sameId(cell.control.classId, QUICK_VIEW_CLASS_ID)) at = `quickview:${lc(cell.control.fieldName)}`;
          if (!at || /:$/.test(at)) { refused = 'create-identity-unsupported'; return; }
          mark(cell, `cell:${at}`);
          delete cell.control.id;
          cell.control.__fresh = `control:${at}`;
        }));
      });
    }
  });
  if (refused) return { refused };
  return clash ? { refused: 'form-layout-container-ambiguous' } : { tabs };
}

/**
 * The planned tree of a NEW declared form: the packed field layout, the timeline, the requested sub-grids and
 * quick views, every object marked with its locator. Pure. Answers { tabs, formType, handlers } or throws a coded
 * refusal.
 */
function planCreate({ form, spec, def, hosts, events }) {
  const layout = declaredLayoutOf(form, def && def.tabs);
  if (layout.duplicates.length) throw codeError('form-layout-duplicate-field', `the spec places ${[...new Set(layout.duplicates)].join(', ')} more than once; a declared field has one place`);
  const built = plannedCreateTabs(def && def.tabs);
  if (built.refused) throw codeError(built.refused, 'the declared layout of the new form cannot be built with a stable identity for every object; nothing was created');
  const tabs = built.tabs;
  if (wantsTimeline(spec, form)) {
    const code = ensureTimeline(tabs, null);
    if (code || !timelinesOf(tabs).some((t) => !timelineProblem(t, { host: true }))) throw codeError('form-timeline-unsupported-host', 'the new form\'s timeline would not render; nothing was created');
  }
  let firstFields = null;
  eachSection(tabs, (s) => { if (!firstFields && s.__skey) firstFields = s; });
  const hostCode = addHosts(tabs, hosts, firstFields);
  if (hostCode) throw codeError(hostCode, 'a requested sub-grid or quick view cannot be added to the new form; nothing was created');
  const formType = (def && def.formType) || formTypeOf(form);
  let geometry = '';
  eachSection(tabs, (s) => {
    const width = Number(s.columns) || 1;
    if (width > sectionGridWidth({ columns: 4 }, formType) || slotGrid(s.rows || [], width).overflow.length) geometry = 'form-layout-invalid';
  });
  if (geometry) throw codeError(geometry, 'a section of the new form does not fit its grid; nothing was created');
  const optionConflict = handlerOptionConflicts(null, events || (form && form.events))[0];
  if (optionConflict) throw codeError('form-handler-options-unsupported', `${handlerLabel(optionConflict)} is declared twice with different options; nothing was created`);
  return { tabs, formType, handlers: requestedHandlers(events || (form && form.events)) };
}

/**
 * The requested hosts of a declared form, as reconcileDeclaredForm and planDeclaredFormLayout take them.
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

// The build's halt factory and solution membership are required, never defaulted: a stand-in halt would let a stop the
// build cannot see pass for one, and a no-op membership would commit a group whose form is outside the solution. Both
// are checked before anything is read or written (managed-not-settled).
const requiredPort = (name) => codeError('managed-not-settled', `a declared form settles only with the build's ${name}`);

// The place of a container as a read of `comp` (compositeOf) sees it: its name and, for a section, its tab and form
// column — the 'fresh' association variant, which a maker's label or flag edit does not change.
const placeShaOf = (comp, id) => {
  const v = (comp.at.get(idText(id)) || []).find((x) => x && x.v === 'fresh');
  return v ? intentSha256(v) : null;
};

// consumerState.children: each child's id, kind and proved association; a container also records the place the proof
// saw it in (placeSha256), so a later run can refuse a container that now stands or is named otherwise even where the
// unchanged-layout path would re-baseline without a write.
const childrenStateOf = (children, tabs) => {
  const comp = compositeOf(tabs || []);
  const out = {};
  for (const c of children) {
    out[c.key.slice(c.key.indexOf('#') + 1)] = {
      id: c.id, kind: c.kind, associationSha256: c.associationSha256,
      ...(CONTAINER_KINDS.has(c.kind) ? { placeSha256: placeShaOf(comp, c.id) } : {}),
    };
  }
  return out;
};

// The containers this plan relies on that the committed group recorded, now named or standing elsewhere than its last
// proof saw them (a tracked host section included). A recorded container with no recorded place is never assumed in
// place. Answers the first such locator, or null.
function movedContainer(children, lastChildren, tabs) {
  const comp = compositeOf(tabs);
  for (const c of children) {
    if (!CONTAINER_KINDS.has(c.kind)) continue;
    const locator = c.key.slice(c.key.indexOf('#') + 1);
    const was = lastChildren[locator];
    if (!was) continue;
    if (!was.placeSha256 || was.placeSha256 !== placeShaOf(comp, c.id)) return locator;
  }
  return null;
}

// Whether the last proof's children are exactly the children this plan relies on, each still standing where that
// proof saw it. The association is compared against every variant the stored object may prove (a container the
// build added is proved by its name and parent, a control sent without a class by its default one), so a form
// created by the build and read back unchanged is a no-op rather than a re-baseline.
function stillProven(children, lastChildren, tabs) {
  if (children.length !== Object.keys(lastChildren).length) return false;
  const comp = compositeOf(tabs);
  return children.every((c) => {
    const was = lastChildren[c.key.slice(c.key.indexOf('#') + 1)];
    return !!was && was.kind === c.kind && sameId(was.id, c.id) && variantHashes(comp.at.get(idText(c.id))).includes(was.associationSha256);
  });
}

/**
 * Reconcile ONE declared form through the managed settlement (managed-feature-contract.js runManagedFeature):
 * resolve, plan, persist the attempt and its expected proof, ONE push, a fresh read proved against that expected
 * proof, solution membership, and one atomic commit of the whole group. A pending attempt found on disk is recovered
 * under its own token: continued when its send window proves nothing it sent was carried out (needs ctx.sendObserver),
 * sent again as the same create when its root reads absent in both layers (resumeCreate), and otherwise proved by its
 * stored expected proof and committed, never sent again. Each resend rebuilds exactly the plan the attempt recorded
 * (same ids, expected proof, declaration and publication) or stops. Never publishes: the committed group records the
 * publication it owes, and the caller pays it per table with publishDeclaredFormTable — after a no-op too.
 *   input  { form (RAW spec form), spec, def (compileFormIntent's), sdk, hosts (declaredHostsOf), events,
 *            beforePush(id) (optional local edits of a new row that travel in its push),
 *            resolveExisting() (only for a form the store does not hold: '<id>' | { id } of the one form of this
 *            table, type and name, else undefined; a throw is form-layout-resolve-refused) }
 *   ctx    { store, barrier?, halt (required: the build's halt factory, managedStop), catalog (creates-catalog.js, with
 *            formCatalogIntent registered), ensureMembership({ root, records, recovering }) (required: the form's
 *            solution membership), authorizedAdoption, authorizedOverwrite (the form family's own approvals: true, or a
 *            Set or array of family-typed keys; only `form:<key>` approves this form), sendObserver? (the build's
 *            createAttemptSendObserver, installed on the transport sdk.dataverse sends through), phase? }
 *   A missing halt or ensureMembership is refused (managed-not-settled) before anything is read or written. A local
 *   copy of the bound or pending form with edits the service has not seen is refused before anything is read over it
 *   (create-completion-required, category workspace-copy-unsent-edits), a recovery included. A form whose create this
 *   run never had acknowledged is bound only under the `form:<key>` adoption approval (managed-adoption-required).
 *   A write that fails puts the local copy back as the service holds it (a create's copy is removed), so the
 *   next run's dirty-copy refusal meets only edits this build did not make.
 *   Only this run's own CREATE answer acknowledges the root (origin `created`); an edit's answer acknowledges only
 *   the children the plan reserved as new and sent (the child-create receipt), so a form that was already there is
 *   `adopted` at any id, and the cells this build adds to it are `created`. The plan answers the authored declaration
 *   (declarationOf), which the attempt records before anything is sent; the commit keeps it as the group's
 *   originalDeclaration and as consumerState.declaration (what verify and download restore), a recovery's included.
 * Answers { key, formId, action: 'noop'|'noChange'|'update'|'create'|'recovered', continued?, resumed?, group }. Every refusal, unknown
 * outcome or failed proof throws the error the halt factory makes (the build stops; the form's table is withheld).
 */
async function reconcileDeclaredForm(input, ctx = {}) {
  const { form, spec, def, sdk, hosts, events, beforePush, resolveExisting } = input || {};
  const key = formLayoutKey(form);
  const table = tableOf(form) || lc(def && def.entityLogicalName);
  const scope = { type: 'table', table };
  const phase = ctx.phase || 'forms';
  const label = `declared form "${key}"`;
  if (!isDeclaredForm(form)) return { key, formId: null, action: null, group: null };
  if (typeof ctx.halt !== 'function') throw requiredPort('halt factory (halt)');
  if (typeof ctx.ensureMembership !== 'function') throw requiredPort('solution membership (ensureMembership)');
  const { halt, ensureMembership } = ctx;
  const { store, catalog } = ctx;
  if (!store || typeof store.readGroup !== 'function') {
    const stopped = halt(phase, label, 'managed-binding-port-unavailable', { cause: codeError('managed-binding-port-unavailable', 'a declared form settles only through the managed binding store') });
    if (!(stopped instanceof Error)) throw codeError('managed-not-settled', `${label} did not settle, and the halt factory made no error to stop the build with`);
    throw stopped;
  }
  const envelope = store.snapshot().envelope;
  const recordOf = (fields) => ({ formatVersion: 1, appUniqueName: envelope.appUniqueName, environmentFingerprint: envelope.environmentFingerprint, ...fields });
  const declaration = declarationOf(form);
  const declarationSha256 = intentSha256(declaration);
  const state = { formId: null, action: null };
  const { committed: knownCommitted, pending: knownPending } = store.readGroup(FAMILY, key);
  const knownId = idText((knownCommitted && knownCommitted.root.id) || (knownPending && knownPending.root.id));

  // On EVERY path, a recovery included, and before anything reads into the workspace: a local copy of the bound or
  // pending form that holds edits the service has not seen (an earlier run's unsent edit, or a maker's by hand) is
  // never planned over or replaced. Recovery and resolve re-read the form with a fetch that overwrites the copy, so the
  // check must come first, and it only diffs (no request, no fetch). A copy the workspace does not hold reads clean.
  const preflight = async ({ committed, pending }) => {
    const id = idText((committed && committed.root.id) || (pending && pending.root.id));
    if (id && await hasUnsyncedEdits(sdk, ARTIFACT, id)) {
      throw Object.assign(codeError('create-completion-required', `the local copy of the form ${id} in the workspace differs from the server's (an edit an earlier run did not send, or one made by hand), or could not be compared; nothing was read over it or written, and the copy was kept. Put any change you want to keep into the spec, refresh the local copy from the server, then re-run`), { category: 'workspace-copy-unsent-edits' });
    }
  };

  const resolve = async ({ committed, pending, continuing, resuming }) => {
    if (form.prune === true) throw codeError('form-layout-prune-unsupported', 'a declared form does not delete what the spec omits; remove "prune"');
    if (Array.isArray(form.genPages) && form.genPages.length) throw codeError('form-page-embeds-incomplete', 'generative pages embedded in a declared form are not supported yet; remove "genPages" or the declared mode');
    const layout = declaredLayoutOf(form, def && def.tabs);
    if (layout.duplicates.length) throw codeError('form-layout-duplicate-field', `the spec places ${[...new Set(layout.duplicates)].join(', ')} more than once; a declared field has one place`);
    let formId = idText((committed && committed.root.id) || (pending && pending.root.id));
    let create = false;
    if ((continuing || resuming) && !committed && pending && pending.expected && pending.expected.baseObservation === null) {
      // The same create sent again under its own id (runManagedFeature's recovery): its send window proved nothing it
      // sent was carried out (continuing), or the row reads absent in both layers (resuming). Nothing is read: a row
      // under this id that appeared since can only make the create fail on its primary key.
      state.formId = formId;
      return { formId, create: true };
    }
    if (!formId && typeof resolveExisting === 'function') {
      let found;
      try { found = await resolveExisting(); } catch (err) {
        throw codeError('form-layout-resolve-refused', (err && err.message) || String(err));
      }
      formId = idText(found && typeof found === 'object' ? found.id : found);
    }
    if (!formId) {
      if (!catalog || typeof catalog.identityFor !== 'function') throw codeError('create-identity-unsupported', 'a new declared form takes its id from the creation catalog, and none was given');
      formId = idText(catalog.identityFor(FAMILY, key).id);
      create = true;
    }
    state.formId = formId;
    if (pending && !pending.expected && !committed) {
      // A prepared attempt that was never sent: whether its row exists is read, never assumed.
      const probe = await readForm(sdk, formId);
      if (!probe) throw codeError('form-unreadable', 'the form could not be read');
      create = !!probe.missing;
    }
    if (create) {
      // createArtifact writes its copy over whatever the workspace holds under this id; a copy with edits the
      // service never saw is not this run's to replace (the preflight saw no id to check for a first create).
      if (await hasUnsyncedEdits(sdk, ARTIFACT, formId)) {
        throw Object.assign(codeError('create-completion-required', `the workspace holds a local copy of the form ${formId} that this build did not make and the service has not seen; nothing was created over it. Remove it from the workspace, then re-run`), { category: 'workspace-copy-unsent-edits' });
      }
      return { formId, create: true };
    }
    // The preflight diffed the bound or pending form; a form found by resolveExisting is diffed here, before its read.
    if (await hasUnsyncedEdits(sdk, ARTIFACT, formId)) {
      throw Object.assign(codeError('create-completion-required', 'the local copy of this form holds edits the service has not seen; refresh it before the layout is written'), { category: 'workspace-copy-unsent-edits' });
    }
    const live = await readForm(sdk, formId);
    if (live && live.missing) {
      throw codeError(committed ? 'form-layout-bound-row-missing' : 'form-unreadable', committed
        ? 'the form this key is bound to was not found; repair the binding explicitly before it can be recreated'
        : 'the form could not be read');
    }
    if (!live) throw codeError('form-unreadable', 'the form could not be read');
    // Both layers must be readable before anything is written: a publication this write will owe can be judged
    // only against a published layer that can be read (a failed read is managed-publication-unverified).
    await readSystemFormPublication(sdk.dataverse, formId);
    return { formId, create: false, live };
  };

  const plan = async ({ resolution, committed }) => {
    const { formId } = resolution;
    const root = { kind: FAMILY, key, id: formId };
    const baseProofSha256 = committed ? intentSha256(committed.proof) : null;
    const publication = { scope, state: 'owed' };
    if (resolution.create) {
      const pc = planCreate({ form, spec, def, hosts, events });
      const keys = freshKeys(pc.tabs);
      const childIds = reserveChildIds(catalog, key, formId, keys);
      const m = materialize(pc.tabs, childIds);
      if (keys.some((k) => !m.ids[k])) throw codeError('create-identity-unsupported', 'the creation catalog did not name every object of the new form');
      const children = expectedChildrenOf(key, formId, m);
      const planned = { formType: pc.formType, entityLogicalName: (def && def.entityLogicalName) || table, tabs: m.tabs, bag: withHandlers({ a: [], c: [] }, pc.handlers) };
      state.action = 'create';
      return {
        root, declarationSha256, declaration, publication, create: true, m, handlers: pc.handlers, formType: pc.formType,
        newChildren: newChildrenOf(key, children, m, null),
        expected: {
          proofVersion: 1, proofSchema: PROOF_SCHEMA, rootId: formId, baseProofSha256,
          sentProjectionSha256: intentSha256(projectFormComposite(planned)),
          preservationSha256: intentSha256(preservationOf(planned, children, { update: false })),
          baseObservation: null, children,
        },
      };
    }
    const { live } = resolution;
    const recorded = recordedLocators(committed, key);
    const baseline = committed ? (committed.records.find((r) => r.kind === FAMILY && r.key === key) || null) : null;
    const p = planDeclaredFormLayout({ form, spec, formId, live, intentTabs: def && def.tabs, hosts, events }, {
      baseline, recorded, children: (committed && committed.consumerState && committed.consumerState.children) || {},
      authorizedAdoption: ctx.authorizedAdoption, authorizedOverwrite: ctx.authorizedOverwrite,
    });
    const stopOn = p.refused[0] || p.unknown[0];
    if (stopOn) throw codeError(stopOn.code, stopOn.message);
    if (p.action === 'noChange' && !committed && !p.bindUnchanged) { state.action = 'noop'; return { noop: true }; }
    const fresh = p.freshKeys || [];
    const m = materialize(p.planned, reserveChildIds(catalog, key, formId, fresh));
    if (fresh.some((k) => !m.ids[k])) throw codeError('create-identity-unsupported', 'the creation catalog did not name every object this write adds');
    const children = expectedChildrenOf(key, formId, m);
    // Before any write, bind-only or no-change re-baseline: every container the committed group recorded must still
    // be named and stand where its last proof saw it. Otherwise the unchanged-layout path would re-baseline the moved
    // association as the group's own (no override approval changes that: moving a container is not supported).
    const lastChildren = (committed && committed.consumerState && committed.consumerState.children) || {};
    const moved = committed ? movedContainer(children, lastChildren, live.tabs) : null;
    if (moved) throw codeError('form-layout-container-moved', `the ${moved.startsWith('tab:') ? 'tab' : 'section'} '${moved.slice(moved.indexOf(':') + 1)}' this form was built with is now named or placed otherwise; moving or renaming it is not supported — put it back in the form designer, or repair the binding`);
    const planned = { formType: live.formType, entityLogicalName: live.entityLogicalName, tabs: m.tabs, bag: withHandlers(live.bag, p.addHandlers || []) };
    // Nothing the spec does not own may change: the planned tree must keep every foreign cell, row payload, tab,
    // section and root bag entry exactly as the live form holds them (the declared fields this plan moves, the
    // helper spacers it recycles or drops, and a timeline host it repairs are the build's).
    const movable = [...children, ...[...p.mobileIds, ...p.repairedIds].map((id) => ({ kind: 'formCell', id }))];
    if (intentSha256(preservationOf(live, movable, { update: true })) !== intentSha256(preservationOf(planned, movable, { update: true }))) {
      throw codeError('form-layout-obstacle-moved', 'the planned layout would change a control, row or container the spec does not own; nothing was written');
    }
    const savedSha256 = savedShaOf(live);
    if (p.action === 'noChange' && committed && committed.proof && committed.proof.savedSha256 === savedSha256
      && stillProven(children, (committed.consumerState && committed.consumerState.children) || {}, live.tabs)
      && intentSha256(committed.consumerState ? committed.consumerState.declaration : null) === declarationSha256) {
      state.action = 'noop';
      return { noop: true };
    }
    state.action = p.action;
    return {
      root, declarationSha256, declaration, publication: p.action === 'update' ? publication : null, update: p.action === 'update', m, addHandlers: p.addHandlers || [],
      newChildren: newChildrenOf(key, children, m, live.tabs),
      expected: {
        proofVersion: 1, proofSchema: PROOF_SCHEMA, rootId: formId, baseProofSha256,
        sentProjectionSha256: intentSha256(projectFormComposite(planned)),
        preservationSha256: intentSha256(preservationOf(planned, children, { update: true })),
        baseObservation: { rowVersion: null, savedSha256 }, children,
      },
    };
  };

  const apply = async ({ plan: p }) => {
    const formId = p.root.id;
    if (!p.create && !p.update) {
      // A bind-only attempt (an unchanged form whose group is recorded or re-baselined): nothing is sent.
      return { sent: false, acknowledged: false };
    }
    let pushed;
    try {
      pushed = await (p.create ? sendCreate(p, formId) : sendUpdate(p, formId));
    } catch (err) {
      await resetOwnCopy(p, formId);
      throw err;
    }
    // The save answer acknowledges what this request made: the root only when it was the root's CREATE, and the
    // children the plan reserved as new and sent in it.
    if (pushed.outcome === 'saved') return { sent: true, acknowledged: true, created: !!p.create, newChildren: p.newChildren || [] };
    await resetOwnCopy(p, formId);
    if (pushed.outcome === 'refused') throw codeError('form-layout-rejected', `the form was not saved (${pushed.code || 'refused'})`);
    throw codeError('form-layout-write-unknown', 'the form write did not settle; the next run proves it from a fresh read before anything else');
  };
  // The local SDK materialisation and its ONE push. A recovery that sends the attempt again (continuing, resuming)
  // redoes it whole, exactly as a first run does, from the copy the preflight proved clean.
  const sendCreate = async (p, formId) => {
    const art = await sdk.createArtifact(ARTIFACT, {
      id: formId, name: def.name, entityLogicalName: def.entityLogicalName, formType: p.formType, status: def.status,
      ...(def.description ? { description: def.description } : {}),
    });
    // The id is the form's identity for every later run; a store that minted its own would orphan it.
    if (!art || !sameId(art.id, formId)) throw codeError('form-layout-write-unknown', 'the new form did not keep the id it was created with');
    const seed = (((await sdk.getArtifact(ARTIFACT, formId)) || {}).tabs || []).length;
    // In order: addElement appends, and tab order is the on-form order. The adapter's seed tab(s) go after, only
    // once the declared tabs are in, so the form is never tab-less.
    for (const tab of p.m.tabs) await sdk.addElement(ARTIFACT, formId, '/tabs', tab);
    if (p.m.tabs.length) for (let i = 0; i < seed; i += 1) await sdk.removeElement(ARTIFACT, formId, '/tabs/0');
    await addHandlers(sdk, formId, p.handlers);
    if (typeof beforePush === 'function') await beforePush(formId);
    return pushChecked(sdk, ARTIFACT, formId);
  };
  const sendUpdate = async (p, formId) => {
    await sdk.updateElement(ARTIFACT, formId, '/tabs', p.m.tabs);
    await addHandlers(sdk, formId, p.addHandlers);
    return pushChecked(sdk, ARTIFACT, formId);
  };
  // A write that failed (a local edit that threw, a refused push, an answer that never came) leaves this run's own
  // edit in the workspace copy, and the CLI's workspace is durable: the next run's preflight would read it as an
  // unsent edit and refuse, so the attempt could never be continued. The copy held nothing else (the preflight or
  // resolve proved it clean, or absent, just before), so it is put back as the service holds it, as sdk-build.js
  // resetUnsettledCopy does for views and charts: a create's never-synced copy is removed (a local delete, no
  // request), an edit's copy is re-read with overwrite (a read, which the send window does not count). Best-effort:
  // a reset that fails leaves the copy, and the next run refuses it rather than plan over it.
  const resetOwnCopy = async (p, formId) => {
    try {
      if (p.create) await sdk.deleteArtifact(ARTIFACT, formId);
      else await sdk.fetchArtifact(ARTIFACT, formId, { overwrite: true });
    } catch { /* see above */ }
  };

  const prove = async ({ token, expected, applied, recovering, declaration: provedDeclaration }) => {
    const formId = expected.rootId;
    const back = await readForm(sdk, formId);
    if (!back || back.missing) throw codeError(back && back.missing ? 'create-completion-required' : 'form-layout-unverified', 'the form could not be read back after the write');
    if ((back.formType && formTypeCode(back.formType) !== formTypeCode(formTypeOf(form))) || (back.entityLogicalName && table && lc(back.entityLogicalName) !== table)) {
      throw codeError('form-layout-identity-mismatch', 'the stored form is not of the type and table the spec declares');
    }
    proveFormComposite(back, expected);
    const layers = await readSystemFormPublication(sdk.dataverse, formId);
    const { committed, pending } = store.readGroup(FAMILY, key);
    const differs = layers.state !== 'equal';
    let publication;
    if (differs && ((applied && applied.sent) || recovering)) {
      // Hashed exactly as the shared form reader (LAYER_READERS.form) hashes the saved layer it will compare.
      publication = { scope, state: 'owed', desiredSha256: systemFormLayerSha256(layers.saved), dispatchToken: null };
    } else if (differs && committed && committed.publication && committed.publication.state === 'owed') {
      // Debt this group already owed stays owed for exactly what it owed: if the saved layer has moved on since,
      // the publish refuses it (the saved layer is not ours to put live).
      publication = { ...committed.publication, dispatchToken: null };
    } else {
      publication = { scope, state: 'not-needed', desiredSha256: null, dispatchToken: null };
    }
    // What a write's own answer acknowledged, from this run's answer or, in a recovery, from what this same attempt
    // durably recorded of its answer (noteSaved); never a later read, and never the id the row happens to have.
    //   - The ROOT only when that answer was to the root's CREATE: an edit of a row that was already there (an adopted
    //     form, even one standing at the catalog's id) made nothing, and the store refuses the flag on such an attempt.
    //     Its first binding needs the form's typed adoption approval at that commit, a recovery before it included;
    //     once bound, later commits follow the managed drift and overwrite rules and need no new grant.
    //   - A CHILD by the receipt: the cells, controls, sections and tabs the plan reserved as new and sent in that one
    //     push (apply's `newChildren`), so cells this build adds to an approved adopted form are recorded as created.
    // A recovery is committed from the attempt's own receipt, so it answers none of its own.
    const own = pending && pending.token === token ? pending : null;
    const rootCreated = recovering ? rootCreateAcknowledged(own) : !!(applied && applied.acknowledged && applied.created);
    const receipt = recovering ? [] : (applied && applied.acknowledged ? applied.newChildren || [] : []);
    const receipted = new Set((recovering ? (own && own.acknowledgedChildCreates) || [] : receipt).map((c) => `${c.kind}\u0000${c.key}\u0000${idText(c.id)}`));
    const old = new Map(((committed && committed.records) || []).map((r) => [`${r.kind}\u0000${r.key}`, r]));
    const originOf = (kind, recKey, id, isRoot) => {
      const was = old.get(`${kind}\u0000${recKey}`);
      if (was) return was.origin;
      if (rootCreated) return 'created';
      return !isRoot && receipted.has(`${kind}\u0000${recKey}\u0000${idText(id)}`) ? 'created' : 'adopted';
    };
    // The declaration this attempt was planned from: the one it recorded (the wrapper's `declaration`, on recovery
    // always the attempt's, never today's spec). An attempt an earlier build prepared without one is recorded only
    // when today's declaration is the one it hashed; otherwise none, so verify and download never restore one that
    // was not proved.
    const attemptDeclarationSha256 = own ? own.declarationSha256 : declarationSha256;
    const proved = provedDeclaration !== undefined ? provedDeclaration : (attemptDeclarationSha256 === declarationSha256 ? declaration : null);
    const provedFieldOptions = proved && proved.fieldOptions !== undefined ? proved.fieldOptions : null;
    const base = projectionBaseline(formProjection(back.tabs));
    const partsSha256 = { ...base.partsSha256, 'spec:fieldOptions': intentSha256(provedFieldOptions) };
    const records = [
      recordOf({ kind: FAMILY, key, id: formId, intentSha256: base.intentSha256, partsSha256, origin: originOf(FAMILY, key, formId, true) }),
      ...expected.children.map((c) => recordOf({
        kind: c.kind, key: c.key, id: c.id, intentSha256: c.associationSha256, parentKey: key,
        origin: originOf(c.kind, c.key, c.id, false),
      })),
    ];
    const proof = {
      savedSha256: savedShaOf(back),
      semanticSha256: intentSha256(projectFormComposite(back)),
      preservationSha256: expected.preservationSha256,
      expectedChildrenSha256: expected.children.length ? intentSha256(expected.children) : null,
    };
    return {
      savedProof: proof, acknowledgedRoot: rootCreated, acknowledgedChildCreates: receipt, records, proof, proofSchema: PROOF_SCHEMA, publication,
      consumerState: {
        // What verify and an explicit download restore: the declaration this attempt's proof was built from.
        declaration: proved,
        children: childrenStateOf(expected.children, back.tabs),
        proofSchema: PROOF_SCHEMA,
      },
    };
  };

  const { result, committedGroup } = await runManagedFeature({
    phase, family: FAMILY, key, label, knownScopes: [scope], knownIds: knownId ? [knownId] : [],
    store, barrier: ctx.barrier, halt, preflight, resolve, plan, apply, prove, ensureMembership,
    // The build's send observer (createAttemptSendObserver), installed on the transport sdk.dataverse sends through:
    // with it, an attempt whose window proves nothing it sent was carried out is continued under its own token.
    ...(ctx.sendObserver ? { sendObserver: ctx.sendObserver } : {}),
    // A committed form whose earlier publish may have been sent and is not proved live (its answer was lost) is never
    // changed over it: with the client, the wrapper first confirms that publish read-only by the shared form layer
    // reader, so the new generation owes its own publish. Without one, or when the read cannot confirm it, the run stops
    // (managed-publication-unconfirmed) before anything is prepared or sent.
    client: sdk && sdk.dataverse,
    // A create no answer acknowledged: is its row there, in either layer, under the id it was sent with? A read that
    // fails is managed-publication-unverified, left to the wrapper to quarantine.
    resumeCreate: async ({ pending }) => ({ root: await readSystemFormRootPresence(sdk && sdk.dataverse, pending.root.id) }),
    // A form whose create this run never had acknowledged (a lost answer, or a row found by resolveExisting) is bound
    // only under the form family's own typed adoption approval, `form:<key>` (ctx.authorizedAdoption: true, or a Set
    // or array of typed keys); a fresh read that proves it is no approval, and neither is an approval of another family.
    adoptionApproved: isApproved(ctx.authorizedAdoption, FAMILY, key) === true,
  });
  const formId = state.formId || (committedGroup && committedGroup.root.id) || null;
  const action = result.recovered ? 'recovered' : (state.action || (result.noop ? 'noop' : null));
  return {
    key, formId, action, ...(result.continued ? { continued: true } : {}), ...(result.resumed ? { resumed: true } : {}),
    group: committedGroup || null,
  };
}

/**
 * Pay the publication the committed declared forms of ONE table owe, at most once, through the shared managed
 * publication (managed-feature-contract.js publishManagedScope) — the only way this helper publishes. Call it once
 * per table after its forms settled, a no-op included (a retry that changes nothing still owes what an earlier run
 * saved and did not publish).
 *   { store, barrier, sdk, table, keys }  keys: the form keys this run settled on the table; every committed form
 *   group whose debt names the table is covered with them (a table publish ships all of them at once). sdk.dataverse
 *   is the client every covered group's layers are read with, each by its own family's shared reader.
 * The request is one plain PublishXml naming only the table. Answers { sent, withheld, confirmed }. A withheld scope
 * answers { sent: false, withheld: true }. Any other outcome is a hold: the scope is blocked for the run and the error
 * is rethrown with `hold: true` (and `refusal: true` when the send boundary refused the request unsent).
 */
async function publishDeclaredFormTable({ store, barrier, sdk, table, keys = [] } = {}) {
  const t = lc(table);
  const scope = { type: 'table', table: t };
  const gate = barrier || store;
  const groups = [];
  const seen = new Set();
  const add = (key) => { if (!seen.has(key)) { seen.add(key); groups.push({ family: FAMILY, key }); } };
  for (const key of keys) add(key);
  for (const unit of store.snapshot().units()) {
    const pub = unit.family === FAMILY && unit.group && unit.group.publication;
    if (pub && pub.scope && pub.scope.type === 'table' && lc(pub.scope.table) === t) add(unit.key);
  }
  try {
    return await publishManagedScope({
      // Every committed group on the table, of any family, is read by its own family's shared reader
      // (managed-layer-readers.js LAYER_READERS, the default); this helper supplies none and replaces none.
      store, barrier, scope, groups, client: sdk && sdk.dataverse, path: `declared forms of ${t}`,
      publish: async () => {
        const r = await publishTablesXml(sdk.dataverse, [t]);
        if (!r.ok) throw codeError('form-publish-failed', r.reason || `the table ${t} was not published`);
      },
    });
  } catch (err) {
    const code = (err && err.code) || 'managed-not-settled';
    try { if (gate && typeof gate.blockScope === 'function') gate.blockScope(scope, `declared forms of ${t} (${code})`); } catch { /* the rethrow below still stops */ }
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), { code, hold: true, ...(code === 'managed-publication-refused' ? { refusal: true } : {}) });
  }
}

/**
 * The verify oracle of a declared form against a stored form (verify-spec's reader), pure. Checks only
 * what the spec states: the form's type and table; each declared section in its declared tab (and form
 * column, when the spec states columns) with its stated width; each declared field exactly once, in its
 * section, in the declared reading order, with its stated spans and explicit flags; a requested timeline
 * that renders; each requested sub-grid / quick view target; each requested handler. Anything the spec
 * omits is unconstrained. Answers [{ code, message }] (empty when the form is as declared).
 *   input  { form, spec, intentTabs, hosts, events, liveForm, group }
 *          group  optional: this form's committed managed group (store.readGroup('form', key).committed, or the
 *                 `group` of a snapshot unit). With it the stored form must also be that id (form-identity) and
 *                 hold every child of the group's last proof as what and where it was proved — a sub-grid or
 *                 quick view still showing its target, a field cell in its section and slot (form-managed-child).
 * A sub-grid host whose viewId is '' (verify cannot resolve the build's created views) matches any
 * stored sub-grid of the same relationship and child table.
 */
function verifyDeclaredForm({ form, spec, intentTabs, hosts, events, liveForm, group } = {}) {
  const issues = [];
  const issue = (code, message) => issues.push({ code, message });
  if (!isDeclaredForm(form)) return issues;
  if (!liveForm || !Array.isArray(liveForm.tabs)) { issue('form-missing', 'the declared form was not found'); return issues; }
  if ((liveForm.formType && formTypeCode(liveForm.formType) !== formTypeCode(formTypeOf(form)))
    || (liveForm.entityLogicalName && tableOf(form) && lc(liveForm.entityLogicalName) !== tableOf(form))) {
    issue('form-identity', `the form is a ${liveForm.formType} form of '${liveForm.entityLogicalName}', not the declared ${formTypeOf(form)} form of '${tableOf(form)}'`);
    return issues;
  }
  if (group && liveForm.id && !sameId(liveForm.id, group.root && group.root.id)) {
    issue('form-identity', `the form read is ${liveForm.id}, not ${group.root && group.root.id}, the form this build bound`);
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
  const shown = new Set(hostTargetsShown(tabs));
  // A sub-grid whose view the reader could not resolve (viewId '') is matched on its relationship and target.
  const isShown = (t) => shown.has(t) || (/^subgrid\|[^|]*\|[^|]*\|$/.test(t) && [...shown].some((s) => s.startsWith(t)));
  for (const t of hostTargetsOf(hosts)) if (!isShown(t)) issue('form-host', `the form does not show ${t.replace(/\|+$/, '').replace(/\|/g, ' ')}`);
  const have = handlerKeysOf(liveForm);
  const requested = events || form.events;
  for (const ev of requestedHandlers(requested)) if (!have.has(handlerKey(ev))) issue('form-event', `${handlerLabel(ev)} is missing`);
  // Present is not enough: the declared options must be the ones the form holds.
  for (const ev of handlerOptionConflicts(liveForm, requested)) issue('form-event', `${handlerLabel(ev)} is on the form with other options (enabled, parameters or passExecutionContext) than the spec declares`);
  if (group) for (const problem of managedChildProblems(group, liveForm.tabs)) issue('form-managed-child', problem);
  return issues;
}

// The children of a committed group's last proof the stored form does not hold as what and where they were proved:
// gone, or now associated otherwise (another field, section, slot, target or class). `group.consumerState.children`
// lists exactly the children of that proof ({ locator: { id, kind, associationSha256 } }); a record the group keeps
// from an older proof (a helper spacer a later pack dropped) is not one of them.
function managedChildProblems(group, tabs) {
  const children = group && group.consumerState && group.consumerState.children;
  if (!children || typeof children !== 'object') return ['the managed group carries no child state to check'];
  const comp = compositeOf(tabs);
  const out = [];
  for (const locator of Object.keys(children).sort()) {
    const c = children[locator];
    const variants = comp.at.get(idText(c.id));
    if (comp.duplicates.includes(idText(c.id))) out.push(`the ${locator} this build bound (${c.id}) is on the form more than once`);
    else if (!variants) out.push(`the ${locator} this build bound (${c.id}) is not on the form`);
    else if (!variantHashes(variants).includes(c.associationSha256)) out.push(`the ${locator} this build bound (${c.id}) is now another object or stands somewhere else`);
  }
  return out;
}

/**
 * Explicit download (hydrate-spec): the declared form a committed managed group restores for the downloaded form,
 * only when the group is this form's (same id, type and table), every child of its last proof is still what and where
 * it was proved, and the form still shows exactly what that proof saw — its layout, every handler, every sub-grid and
 * quick view target and its timeline (the semantic hash). Answers { form } (the declared raw form to put in the spec,
 * `fieldOptions` included as written) or { stale: reason } (hydrate the form as today and report it unverified).
 *   group  store.readGroup('form', key).committed, or the `group` of a snapshot unit
 */
function hydrateDeclaredForm(group, { formId, liveForm } = {}) {
  const declared = group && group.consumerState && group.consumerState.declaration;
  if (!group || group.family !== FAMILY || !group.root || !group.proof || !declared || !isDeclaredForm(declared)) return { stale: 'the managed group holds no proved declared form' };
  if (!sameId(group.root.id, formId)) return { stale: `the managed group names form ${group.root.id}, not ${formId}` };
  if (!liveForm || !Array.isArray(liveForm.tabs)) return { stale: 'the form could not be read' };
  if ((liveForm.formType && formTypeCode(liveForm.formType) !== formTypeCode(formTypeOf(declared))) || (liveForm.entityLogicalName && lc(liveForm.entityLogicalName) !== tableOf(declared))) {
    return { stale: `the form is a ${liveForm.formType} form of '${liveForm.entityLogicalName}', not the ${formTypeOf(declared)} form of '${tableOf(declared)}' the managed group names` };
  }
  const moved = managedChildProblems(group, liveForm.tabs);
  if (moved.length) return { stale: moved[0] };
  if (intentSha256(projectFormComposite(liveForm)) !== group.proof.semanticSha256) {
    return { stale: 'the form\'s layout, handlers, sub-grids, quick views or timeline changed after the build that proved it' };
  }
  // The declaration restores only handlers the form holds as declared: a declared handler that is missing, or held
  // with other options, was never stored, so the declaration is not certified.
  const have = handlerKeysOf(liveForm);
  const unstored = requestedHandlers(declared.events).find((ev) => !have.has(handlerKey(ev))) || handlerOptionConflicts(liveForm, declared.events)[0];
  if (unstored) return { stale: `${handlerLabel(unstored)} is not on the form as the managed group declares it` };
  return { form: clone(declared) };
}

module.exports = {
  FAMILY,
  PROOF_SCHEMA,
  isDeclaredForm,
  formLayoutKey,
  formCatalogIntent,
  declaredOptions,
  declaredLayoutOf,
  packDeclaredLayout,
  declaredSlotRows,
  formProjection,
  projectFormComposite,
  proveFormComposite,
  planDeclaredFormLayout,
  declaredHostsOf,
  reconcileDeclaredForm,
  publishDeclaredFormTable,
  verifyDeclaredForm,
  hydrateDeclaredForm,
};
