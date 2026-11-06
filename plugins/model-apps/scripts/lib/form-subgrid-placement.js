'use strict';
// Where a form's sub-grid sections go — forms[].subgrids[].tab / column / after / before.
//
// PURE: no I/O, no SDK. The spec gate (app-spec.js), the build (sdk-build.js), `--verify` (verify-spec.js) and
// the wireframe (form-preview.js) all read placement through this module, so none of them can disagree about
// what a placement means. The layout it works against is the list of tabs, form-columns and sections a form
// DECLARES, under the names the compiler gives them (`formLayoutNames`, app-spec.js, which owns the
// generated-name rules); an auto layout is its one tab, `tab_general`, holding one section, `section_general`.
//
// What a placement says:
//   after / before   the grid's section sits in the form-column of the named section, DIRECTLY after / directly
//                    before it: nothing sits between them but the grids that share the anchor and are declared
//                    ahead of it, which keep the order they are declared in. A build puts a new grid there, and a
//                    rebuild moves one that is elsewhere — the GRID moves; no section of the layout, a maker's own
//                    section or the Notes section is ever moved to make room, so those that sat between are
//                    simply left behind it. It is where a fresh build puts the grid, so a rebuilt form and a new
//                    one agree.
//   tab [+ column]   the grid's section is in that tab — in form-column `column` when given, else any — and
//                    is put at the END of that column when it is created or has to be moved there. Within the
//                    column it is left where it is.
//   (nothing)        as before this existed: the end of the first tab's first form-column, and never moved.
// Only the engine's own grid section for a relationship is ever moved to honour a placement.

const { isEngineHostSection } = require('./form-container-match.js');

// The names the compiler gives an auto layout's only tab and section (artifact-intent.js writes the same
// literals; a test pins the two together).
const AUTO_TAB_NAME = 'tab_general';
const AUTO_SECTION_NAME = 'section_general';
// The platform's class id for the sub-grid control (the SDK's ControlClassIds.SubgridControl).
const SUBGRID_CLASS_ID = 'E7A81278-8635-4D9E-8D4D-59480B391C5B';

const sameId = (a, b) => String(a == null ? '' : a).replace(/[{}]/g, '').trim().toLowerCase()
  === String(b == null ? '' : b).replace(/[{}]/g, '').trim().toLowerCase();

// The relationship a sub-grid control shows, whichever tree shape the control comes from: the SDK's form artifact
// keeps it in `parameters.RelationshipName`, verify's parse of published FormXML in `relationshipName` (read from
//   <control classid="{E7A81278-…}"><parameters><RelationshipName>new_customer_new_ticket</RelationshipName>…).
const relationshipOf = (control) => String((control && (control.relationshipName
  || (control.parameters && control.parameters.RelationshipName))) || '');

// The section a form holds the sub-grid for `relationshipName` in — the first, with the engine's own `section_grid_…`
// host preferred when several hold it — and where it is: { ti, ci, si, section, engine }, or null. `engine` says the
// build owns the section (a host, see isEngineHostSection); a grid a maker put in a section of their own is found
// too, but is not the build's to move. `tabs` is the form's tabs array in either tree shape.
function findGridSection(tabs, relationshipName) {
  const want = String(relationshipName).toLowerCase();
  let found = null;
  (tabs || []).forEach((tab, ti) => ((tab && tab.columns) || []).forEach((column, ci) => ((column && column.sections) || []).forEach((section, si) => {
    const holds = ((section && section.rows) || []).some((row) => ((row && row.cells) || []).some((cell) => {
      const control = cell && cell.control;
      return !!control && sameId(control.classId, SUBGRID_CLASS_ID) && relationshipOf(control).toLowerCase() === want;
    }));
    if (!holds) return;
    const hit = { ti, ci, si, section, engine: isEngineHostSection(section) };
    if (!found || (hit.engine && !found.engine)) found = hit;
  })));
  return found;
}

// What an entry declares, normalized: names lower-cased (every container comparison is), `column` a whole
// number. Anything else is ignored here — the spec gate reports it; the build never sees it. `null` when the
// entry declares no placement at all, which is what keeps a spec without these keys on the original path.
function placementOf(sg) {
  if (!sg || typeof sg !== 'object' || Array.isArray(sg)) return null;
  const name = (v) => (typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : undefined);
  const out = {};
  if (name(sg.tab) !== undefined) out.tab = name(sg.tab);
  if (Number.isInteger(sg.column) && sg.column >= 0) out.column = sg.column;
  if (name(sg.after) !== undefined) out.after = name(sg.after);
  if (name(sg.before) !== undefined) out.before = name(sg.before);
  return Object.keys(out).length ? out : null;
}

const anchorOf = (placement) => (placement && placement.after ? { name: placement.after, side: 'after' }
  : placement && placement.before ? { name: placement.before, side: 'before' } : null);

// Resolve a placement against a layout (`[{ name, columns: [{ sections: [name…] }] }]`, names lower-cased).
//   ok            → { ok: true, tabIndex, columnIndex, anchor }
//                   `columnIndex` is the column the placement is about: the anchor's, or the one `column` names.
//                   Without an anchor and without `column` it is `undefined` ("any column of the tab") and
//                   `createColumn` (0) is where a new grid goes.
//   not ok        → { ok: false, code, … } — what is wrong, as data the caller words.
function resolvePlacement(layout, placement) {
  const tabs = Array.isArray(layout) ? layout : [];
  const p = placement || {};
  const anchor = anchorOf(p);
  if (p.after && p.before) return { ok: false, code: 'both' };
  if (anchor) {
    for (let ti = 0; ti < tabs.length; ti += 1) {
      for (let ci = 0; ci < tabs[ti].columns.length; ci += 1) {
        if (!tabs[ti].columns[ci].sections.includes(anchor.name)) continue;
        if (p.tab !== undefined && p.tab !== tabs[ti].name) return { ok: false, code: 'anchor-tab', anchor, actualTab: tabs[ti].name };
        if (p.column !== undefined && p.column !== ci) return { ok: false, code: 'anchor-column', anchor, actualColumn: ci };
        return { ok: true, tabIndex: ti, columnIndex: ci, createColumn: ci, anchor };
      }
    }
    return { ok: false, code: 'anchor', anchor };
  }
  const tabIndex = p.tab === undefined ? 0 : tabs.findIndex((t) => t.name === p.tab);
  if (tabIndex < 0 || tabIndex >= tabs.length) return { ok: false, code: 'tab' };
  if (p.column !== undefined && p.column >= tabs[tabIndex].columns.length) return { ok: false, code: 'column', tabIndex, columns: tabs[tabIndex].columns.length };
  return { ok: true, tabIndex, columnIndex: p.column, createColumn: p.column === undefined ? 0 : p.column, anchor: null };
}

// The relative order of one form-column's sections of the layout and the grids anchored in it.
//   authored   the column's section names in the layout's order (lower-cased)
//   grids      [{ key, after?, before? }] — the anchored grids placed in this column, in declared order
// Returns tokens `{ section, at }` | `{ grid, after?, before? }`; `at` is the section's place in `authored`, which is
// its place in the compiled column too (columnItems reads the column by it). A grid goes right after (before) its
// anchor, and after (before) the grids already put there, so grids sharing an anchor stay in declared order. A grid
// whose anchor is not in this column — a case the spec gate refuses — goes last rather than being dropped.
function columnSequence(authored, grids) {
  const seq = (authored || []).map((name, at) => ({ section: name, at }));
  for (const g of grids || []) {
    const token = { grid: g.key };
    if (g.after) token.after = g.after;
    if (g.before) token.before = g.before;
    const anchorName = g.after || g.before;
    const at = seq.findIndex((t) => t.section === anchorName);
    if (at < 0) { seq.push(token); continue; }
    if (g.after) {
      let i = at + 1;
      while (i < seq.length && seq[i].grid !== undefined && seq[i].after === g.after) i += 1;
      seq.splice(i, 0, token);
    } else {
      seq.splice(at, 0, token);
    }
  }
  return seq;
}

// A token's name for a message: a section by name, a grid by what it shows.
const tokenLabel = (token, gridLabel) => (token.section !== undefined ? `section '${token.section}'` : `sub-grid '${gridLabel ? gridLabel(token.grid) : token.grid}'`);

// The token an ANCHORED grid must sit directly beside, and on which side: for an `after` grid the nearest token
// before it in `seq` that `present(token)` says is on the form, for a `before` grid the nearest one after it.
// "Nearest" because what sits between a grid and its anchor in the sequence is only the grids that share the
// anchor and are declared ahead of it — and a form may not have one of those (no relationship, no view), in which
// case the grid sits beside the anchor itself. Build and `--verify` both ask this, so they cannot disagree about
// the place a grid has. null when nothing toward the anchor is present, i.e. the anchor is not on the form.
function neighbourOf(seq, gridKey, present) {
  const list = seq || [];
  const k = list.findIndex((t) => t.grid === gridKey);
  if (k < 0) return null;
  const side = list[k].after ? 'after' : 'before';
  const step = side === 'after' ? -1 : 1;
  for (let j = k + step; j >= 0 && j < list.length; j += step) {
    if (present(list[j])) return { token: list[j], side };
  }
  return null;
}

// A form's sub-grids split into those that say where they go — and whose placement the layout resolves, each with
// its resolution and its position in the list — and the rest, which a build leaves at the end of the first tab's
// first form-column. A placement the layout cannot resolve is one the spec gate refuses and a build ignores, so it
// does not place a grid here either.
function splitSubgrids(layout, subgrids) {
  const placed = [];
  const unplaced = [];
  (subgrids || []).forEach((sg, index) => {
    const raw = placementOf(sg);
    const resolved = raw ? resolvePlacement(layout, raw) : null;
    if (resolved && resolved.ok) placed.push({ index, sg, resolved });
    else unplaced.push(sg);
  });
  return { placed, unplaced };
}

// One compiled form-column's sections in the order a build leaves them, with the placed grids set among them:
//   · the layout's own sections and the anchored grids, in columnSequence's order;
//   · then whatever the compiler added after the authored sections (the Notes section);
//   · then the grids that name only a tab (and column), which a build appends to the end of the column.
// Returns [{ section, engine } | { subgrid }]. For the consumers that draw or synthesize the layout a spec asks for
// rather than read a deployed one — the wireframe and the offline verify reader.
//
// The compiled column lists the layout's sections first, in the layout's order, and then what the compiler added, so
// a section is told from another by its PLACE in that list and never by its name: a layout may declare a section
// named `section_notes` (a natural name for a section of note fields) and the compiler's own Notes section carries
// the same one. Matching by name would find the layout's for both and drop the compiler's from the column — and with
// it the timeline the form asks for. `engine` says the compiler added the section (it is not the layout's).
function columnItems(layout, tabIndex, columnIndex, sections, placed) {
  const list = sections || [];
  const authored = (((layout[tabIndex] || {}).columns || [])[columnIndex] || { sections: [] }).sections;
  const item = (section, at) => ({ section, engine: at >= authored.length });
  const here = (placed || []).filter((p) => p.resolved.tabIndex === tabIndex
    && (p.resolved.anchor ? p.resolved.columnIndex : p.resolved.createColumn) === columnIndex);
  if (!here.length) return list.map(item);
  const anchored = here.filter((p) => p.resolved.anchor).map((p) => ({ key: p.index, [p.resolved.anchor.side]: p.resolved.anchor.name }));
  const items = [];
  for (const token of columnSequence(authored, anchored)) {
    if (token.section === undefined) items.push({ subgrid: here.find((p) => p.index === token.grid).sg });
    else if (list[token.at]) items.push(item(list[token.at], token.at));
  }
  list.forEach((section, at) => { if (at >= authored.length) items.push(item(section, at)); });
  for (const p of here) if (!p.resolved.anchor) items.push({ subgrid: p.sg });
  return items;
}

module.exports = { AUTO_TAB_NAME, AUTO_SECTION_NAME, SUBGRID_CLASS_ID, relationshipOf, findGridSection, placementOf, anchorOf, resolvePlacement, columnSequence, neighbourOf, tokenLabel, splitSubgrids, columnItems };
