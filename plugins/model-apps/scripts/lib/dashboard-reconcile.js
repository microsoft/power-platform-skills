'use strict';
// Declared reconciliation of a global Standard dashboard (`dashboards[].reconcile: "declared"`) on the managed
// settlement (managed-feature-contract.js runManagedFeature, managed-bindings.js).
//
// Without the opt-in, an existing dashboard is reused as it is: tile edits in the spec are never applied on a rebuild.
// With it, every tile the spec declares carries a stable `key` and the dashboard follows the spec tile by tile:
//   * a keyed tile bound to a live control (by the committed group, or the first time by an explicit `componentId`)
//     gets its AUTHORED parts written: its target view/chart/url/web resource, and its name/colspan/rowspan when the
//     spec sets them, as same-type edits only;
//   * a keyed tile with no binding and no pin is appended after the occupied layout, with its control AND cell ids
//     derived from the create catalog (creates-catalog.js) under the dashboard's id, so a lost answer is proven by
//     exact id;
//   * everything else is kept: live control ids, positions, cell bags, foreign tiles, every tile the spec omits (an
//     omitted tile is never deleted) and the platform's per-tile defaults the spec never authored (RecordsPerPage, ...).
// A missing dashboard is created under its catalog id with its seed tab and section ids from the catalog too.
//
// The dashboard and its tiles are ONE managed group (family `dashboard`): the root record and one `dashboard-tile`
// record per declared tile commit together, or not at all. A root-only binding is never written.
//
// The wrapper's `preflight` runs on EVERY path — an ordinary run and every recovery of an earlier attempt — before
// anything is read into the workspace, proved or sent, and stops the dashboard (quarantined, the attempt kept) when:
//   * the creation record of this dashboard is not settled (`dashboard-creation-record-unsettled`): its ids are held
//     for the run, so no dashboard publish and no app publish ships them;
//   * a workspace copy of any id this dashboard may be holds edits the server has not seen (`create-completion-required`,
//     category `workspace-copy-unsent-edits`; no overwrite bypass: such a copy is a maker's unsent work, or another
//     path's, and the fetch with overwrite every read here makes would drop it).
// Then, before any write, the whole dashboard is checked, and any of these stops it with its code (nothing is sent):
//   * a table-scoped or non-Standard row, two tiles pinned to one control, one control on two live cells, a bound or
//     pinned tile whose control is gone (never re-added), a type change, an unresolved target, drift without approval;
//   * a published layer that cannot be read; a write to a dashboard this spec does not manage yet without its typed
//     adoption approval (`dashboard:<key>`; a pin names the row, it is not the maker's consent to manage it).
//
// Proof (proofSchema `dashboard-v1`): the expected proof persisted before the send names every managed tile's control
// id with the association of its type, cell, section and tab, and the sha256 of the INTENDED projection: the root's
// type, scope and description, and each managed tile's key, id, type, containers and full ownable parts. A fresh read
// must reproduce it exactly. Preservation is proven over everything the declaration does NOT own: the whole layout
// (every foreign cell and control, the tabs, sections and rows and their order) with each managed cell kept in place
// with only its authored parts taken out (its spans, the label its name is read from, its owned parameters), so its
// other attributes, labels and parameters (showlabel, RecordsPerPage, ...) are proved too. The expected proof binds the
// cells a run appends — ids, order and non-authored parameters — so the proof cuts exactly those from the end of the
// first section and nothing else; a create's proof requires that what remains is the catalog seed alone. Both hashes
// are taken from the saved row whose hash the publication records. So a run that stopped after the service accepted its
// change cannot bind or publish what someone changed on the dashboard since: recovery recomputes both hashes from a
// fresh read and the expected proof alone.
//
// Publication debt has a provenance: it is owed only for this attempt's own proved content write (the attempt's
// planned publication), or carried over from the committed group's unsent debt. A read that finds the saved layer
// ahead of the published one — someone's draft — never makes a debt, so it is never published by this build.
//
// The committed consumer state keeps the canonical declaration (consumerState.declaration): every field the spec
// authors, with its authored value as written, and only those, an absent field absent. A change of authorship alone
// rebinds without a content write. The plan hands it to the attempt before the send, so the attempt records the
// declaration it is sent with: a recovery commits that one, never today's spec and never null, and the next run
// reconciles today's spec against it. Verify and hydrate read it back with committedDeclaration.
//
// Publication goes through ONE adapter (publishDeclaredDashboard) over publishManagedScope: one permit, one scope, the
// dashboard's own id in a `<dashboard>` envelope. Its layers are read by the shared `dashboard` reader of
// lib/managed-layer-readers.js, so the publication debt records the hash that reader answers (systemFormLayerSha256).
// A layer read that fails there is a hold for the run, never a retry.
//
// Tile options are resolved by the build's own dashboardTileOpts and turned into a component by its dashboardComponent
// (sdk-build.js), injected as `resolveTile` / `toComponent` so that mapping exists once.

const crypto = require('node:crypto');
const {
  canonicalJson,
  isApproved,
  projectionBaseline,
  partsDriftVerdict,
  pushChecked,
  pushIfChanged,
  normalizeGuid,
  rulesOf,
} = require('./reconcile-common.js');
const { hasUnsyncedEdits } = require('./unsynced-edits.js');
const contract = require('./managed-feature-contract.js');
const { runManagedFeature, publishManagedScope, CREATION_RECORD_UNSETTLED, PUBLICATION_UNVERIFIED, PUBLICATION_REFUSED } = contract;
const { readSystemFormPublication, readSystemFormRootPresence, systemFormLayerSha256 } = require('./systemform-published.js');

const KIND = 'dashboard';
const TILE_KIND = 'dashboard-tile';
const PROOF_SCHEMA = 'dashboard-v1';
const KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;
// The <parameters> a spec tile AUTHORS, per tile type. The rest of what dashboardComponent emits (IsUserView,
// ChartGridMode, RecordsPerPage) are creation defaults: owning them would reset a maker's per-tile settings on
// every rebuild.
const OWNED_PARAMS = {
  chart: ['TargetEntityType', 'ViewId', 'VisualizationId'],
  list: ['TargetEntityType', 'ViewId'],
  iframe: ['Url'],
  webresource: ['WebResourceName'],
};
const GUID_PARAMS = new Set(['ViewId', 'VisualizationId']);
// Catalog locators of a dashboard's children (creates-capabilities.js CHILD_KINDS).
const SEED_TAB = 'seed-tab';
const SEED_SECTION = 'seed-section';
const SEED_CHILDREN = [
  { locator: SEED_TAB, childKind: 'dashboardSeedTab', keyParts: ['seed-tab'] },
  { locator: SEED_SECTION, childKind: 'dashboardSeedSection', keyParts: ['seed-section'] },
];
const controlLocator = (tileKey) => `control:${tileKey}`;
const cellLocator = (tileKey) => `cell:${tileKey}`;
const tileChildren = (tileKey) => [
  { locator: controlLocator(tileKey), childKind: 'dashboardControl', keyParts: [tileKey, 'control'] },
  { locator: cellLocator(tileKey), childKind: 'dashboardCell', keyParts: [tileKey, 'cell'] },
];

const lc = (s) => String(s == null ? '' : s).toLowerCase();
const bareId = (id) => String(id == null ? '' : id).replace(/[{}]/g, '').toLowerCase();
const braced = (id) => `{${bareId(id)}}`;
const sha = (value) => crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
const isNotFound = (err) => !!err && (err.statusCode === 404 || err.status === 404);
const positiveInt = (v) => Number.isInteger(v) && v > 0;
// A declared dashboard is a GLOBAL one: the SDK reads a row's `objecttypecode` into `entityLogicalName`, null for
// "none" and the table's logical name for a dashboard that belongs to a table.
const isGlobal = (art) => !!art && (art.entityLogicalName === null || art.entityLogicalName === undefined);
const scopeOf = (id) => ({ type: KIND, id: bareId(id) });

/** A coded stop; runManagedFeature hands its code to the build's halt. `details` ride along for the report. */
function stop(code, message, details = {}) {
  return Object.assign(new Error(message), { code }, details);
}

function isDeclaredDashboard(d) {
  return !!d && d.reconcile === 'declared';
}

function dashboardKey(dashboard) {
  return dashboard && typeof dashboard.key === 'string' && dashboard.key ? dashboard.key : lc(String((dashboard && dashboard.name) || '').trim());
}

/** Shape errors of a declared dashboard (validation surfaces the same list). */
function validateDeclaredDashboard(dashboard) {
  const errors = [];
  const seen = new Set();
  const pinnedIds = new Map();
  if (dashboard && dashboard.description !== undefined && typeof dashboard.description !== 'string') {
    errors.push('description must be a string; omit it to keep the live description, or set "" to clear it');
  }
  const tiles = dashboard && Array.isArray(dashboard.tiles) ? dashboard.tiles : [];
  if (!tiles.length) errors.push('tiles[] is required in declared mode');
  tiles.forEach((t, i) => {
    const at = `tiles[${i}]`;
    if (!t || typeof t.key !== 'string' || !KEY_RE.test(t.key)) errors.push(`${at}: key is required in declared mode (letters, digits, '_', '.', '-'; at most 64)`);
    else if (seen.has(t.key)) errors.push(`${at}: key '${t.key}' is used twice`);
    else seen.add(t.key);
    if (t && t.componentId !== undefined && !normalizeGuid(t.componentId)) errors.push(`${at}: componentId must be a GUID`);
    else if (t && t.componentId !== undefined) {
      const cid = normalizeGuid(t.componentId);
      if (pinnedIds.has(cid)) errors.push(`${at}: componentId '${cid}' is already pinned by tiles[${pinnedIds.get(cid)}]; one control belongs to one key`);
      else pinnedIds.set(cid, i);
    }
    if (t && !OWNED_PARAMS[t.type]) errors.push(`${at}: type must be one of ${Object.keys(OWNED_PARAMS).join('|')}`);
    if (t && t.name !== undefined && (typeof t.name !== 'string' || !t.name)) errors.push(`${at}: name must be a non-empty string when set`);
    for (const span of ['colspan', 'rowspan']) {
      if (t && t[span] !== undefined && !positiveInt(t[span])) errors.push(`${at}: ${span} must be a positive integer when set`);
    }
  });
  return errors;
}

/** Owned value of a parameter, normalized the way the platform compares it. */
function paramValue(name, value) {
  if (value === undefined || value === null) return '';
  if (GUID_PARAMS.has(name)) return bareId(value);
  if (name === 'TargetEntityType') return lc(value);
  return String(value);
}

const paramPart = (p) => `parameters/${p}`;

/** The FULL ownable projection of a live (or about-to-be-added) component of `type`. */
function liveTile(component, type) {
  const out = {};
  out.name = component.name === undefined || component.name === null ? null : String(component.name);
  out.colspan = component.colspan === undefined ? null : component.colspan;
  out.rowspan = component.rowspan === undefined ? null : component.rowspan;
  for (const p of OWNED_PARAMS[type] || []) out[paramPart(p)] = paramValue(p, (component.parameters || {})[p]);
  return out;
}

/** The full projection after this run: the authored parts of `tile` laid over `live`. */
function desiredTile(tile, component, live) {
  const out = { ...live };
  for (const p of OWNED_PARAMS[component.type]) out[paramPart(p)] = paramValue(p, component.parameters[p]);
  if (tile.name !== undefined) out.name = tile.name;
  if (tile.colspan !== undefined) out.colspan = tile.colspan;
  if (tile.rowspan !== undefined) out.rowspan = tile.rowspan;
  return out;
}

const changedParts = (live, desired) => Object.keys(desired).filter((k) => canonicalJson(desired[k]) !== canonicalJson(live[k]));
const sameParams = (type, a, b) => (OWNED_PARAMS[type] || []).every((p) => a[paramPart(p)] === b[paramPart(p)]);

/** Whether every owned target of a resolved component names something: a view, chart, url or web resource. */
function targetsResolved(component) {
  return (OWNED_PARAMS[component.type] || []).every((p) => {
    const v = component.parameters && component.parameters[p];
    if (GUID_PARAMS.has(p)) return !!normalizeGuid(v);
    return typeof v === 'string' && v.trim() !== '';
  });
}

// The SDK's hybrid bag: an element is { n, a: [[name, value], ...], c: [child, ...] }, where a child is either
// an element or, at the root, a positioned wrapper { i, node: element }, e.g.
//   {"a":[],"c":[{"i":0,"node":{"n":"tabs","a":[],"c":[{"n":"tab","a":[["id","{…}"]],"c":[…]}]}}]}
const nodeOf = (child) => (child && child.node) || child;
const childrenNamed = (el, name) => ((el && el.c) || []).map(nodeOf).filter((x) => x && x.n === name);
const attrOf = (el, name) => {
  const pair = ((el && el.a) || []).find((p) => Array.isArray(p) && p[0] === name);
  return pair ? pair[1] : undefined;
};

/**
 * The first section of the first tab's first column, as the SDK indexes positions (indexCellsByPosition): tabs,
 * columns, sections and rows are each flattened across their container elements. null when the bag has no such
 * section — a layout this helper does not append into.
 */
function firstSection(bag) {
  const tab = childrenNamed(bag, 'tabs').flatMap((t) => childrenNamed(t, 'tab'))[0];
  const column = childrenNamed(tab, 'columns').flatMap((c) => childrenNamed(c, 'column'))[0];
  const section = childrenNamed(column, 'sections').flatMap((s) => childrenNamed(s, 'section'))[0];
  return section ? { tab, section, rows: childrenNamed(section, 'rows').flatMap((r) => childrenNamed(r, 'row')) } : null;
}

/**
 * Where each container and cell of a bag sits: every `tab` id, every `section` id with the tab that holds it, and
 * every `cell` id with its section and tab — bare and lowercased, a repeated id listed once per element. A role is
 * the element's name, so an id found on a section is never taken for a tab.
 */
function layoutOf(bag) {
  const out = { tabs: [], sections: [], cells: [] };
  const walk = (el, tab, section) => {
    if (!el || typeof el !== 'object') return;
    const id = attrOf(el, 'id') ? bareId(attrOf(el, 'id')) : '';
    if (el.n === 'tab') {
      out.tabs.push(id);
      tab = id;
    } else if (el.n === 'section') {
      out.sections.push({ id, tab });
      section = id;
    } else if (el.n === 'cell') {
      out.cells.push({ id, section, tab });
    }
    for (const child of el.c || []) walk(nodeOf(child), tab, section);
  };
  walk(bag, null, null);
  return out;
}

/**
 * Whether the catalog's seed tab and section of a create are where the create put them: exactly one `tab` element
 * carries the tab id, exactly one `section` element carries the section id, and that section is in that tab.
 */
function seedInPlace(layout, seed) {
  const tab = bareId(seed && seed.tab);
  const section = bareId(seed && seed.section);
  if (!tab || !section) return false;
  const sections = layout.sections.filter((s) => s.id === section);
  return layout.tabs.filter((t) => t === tab).length === 1 && sections.length === 1 && sections[0].tab === tab;
}

/** The cell id carried by a component's bag (parseCell keeps the cell's attributes there). */
const cellIdOf = (component) => bareId(attrOf(component && component.bag, 'id'));

/** Where a component's cell sits in `layout`: { cell, section, tab }, with '' for what the bag does not say. */
function placeOf(component, layout) {
  const cell = cellIdOf(component);
  const hits = layout.cells.filter((c) => c.id === cell);
  return hits.length === 1 ? { cell, section: hits[0].section || '', tab: hits[0].tab || '' } : { cell, section: '', tab: '' };
}

/** What one expected child is bound to: its key, type and containers. Its hash is the child's associationSha256. */
const associationOf = (tileKey, type, place) => sha({ tileKey, type, cell: place.cell, section: place.section, tab: place.tab });

/**
 * The hash of a dashboard's managed projection: the root's type, scope and description, and every managed tile — key,
 * control id, type, containers and full ownable parts — in key order. Built from the INTENDED state before the send, and
 * from a fresh read in the proof; the two must be equal.
 */
function projectionSha256(root, tiles) {
  const sorted = [...tiles].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return sha({ root, tiles: sorted });
}

/** A managed tile's parameters the spec does NOT author (RecordsPerPage, ChartGridMode, ...), as the platform keeps them. */
function unownedParams(type, parameters) {
  const owned = new Set(OWNED_PARAMS[type] || []);
  const out = {};
  for (const [k, v] of Object.entries(parameters || {})) if (!owned.has(k)) out[k] = v === undefined || v === null ? '' : String(v);
  return out;
}

// The cell attributes a declared tile authors: its spans. The semantic projection compares them.
const AUTHORED_CELL_ATTRS = new Set(['colspan', 'rowspan']);
// The SDK's default language (its DEFAULT_LCID): the label a tile's name is read from when the caller names no other.
const DEFAULT_LCID = 1033;

const mapChildren = (el, fn) => ({ ...el, c: (el.c || []).map((ch) => (ch && ch.node ? { ...ch, node: fn(ch.node) } : fn(ch))) });
const withoutAttrs = (el, names) => ({ ...el, a: (el.a || []).filter((p) => !(Array.isArray(p) && names.has(p[0]))) });

/**
 * A managed cell with exactly the parts the declaration authors taken out, so the semantic projection compares those
 * and preservation compares everything else:
 *   - the cell's colspan and rowspan;
 *   - the `description` of the label the SDK reads the tile's name from: in the cell's first <labels>, the <label> whose
 *     languagecode is the SDK's language, else the first one (the SDK's own rule for a tile's name);
 *   - the owned <parameters> of its control (OWNED_PARAMS of its type).
 * Everything else in the cell stays and is proved: its other attributes (showlabel, auto, ...), every other label and
 * language, the control's attributes, its non-authored parameters (RecordsPerPage, ...) and any other child.
 */
function strippedManagedCell(cell, type, languageCode) {
  const owned = new Set(OWNED_PARAMS[type] || []);
  const labels = childrenNamed(childrenNamed(cell, 'labels')[0], 'label');
  const named = labels.find((l) => attrOf(l, 'languagecode') === String(languageCode)) || labels[0] || null;
  const description = new Set(['description']);
  return mapChildren(withoutAttrs(cell, AUTHORED_CELL_ATTRS), (child) => {
    if (child && child.n === 'labels') return mapChildren(child, (l) => (l === named ? withoutAttrs(l, description) : l));
    if (child && child.n === 'control') {
      return mapChildren(child, (p) => (p && p.n === 'parameters' ? { ...p, c: (p.c || []).filter((x) => !owned.has(nodeOf(x) && nodeOf(x).n)) } : p));
    }
    return child;
  });
}

/**
 * The layout as the declaration does NOT own it: the whole bag (tabs, columns, sections, rows and their order, every
 * foreign cell and its control, the root's other parts), each managed cell — a cell whose one control is a managed
 * tile's — kept in place by strippedManagedCell. `managedTypes` maps each managed control id (bare) to its tile type.
 * null for no bag.
 */
function preservedLayout(bag, managedTypes, languageCode) {
  if (!bag) return null;
  const walk = (el) => {
    if (!el || typeof el !== 'object') return el;
    if (el.n === 'cell') {
      const controls = childrenNamed(el, 'control');
      const id = controls.length === 1 ? bareId(attrOf(controls[0], 'id')) : '';
      // A cell with several controls is never stripped: an authored change in it then fails the proof (fail closed).
      if (id && managedTypes.has(id)) return strippedManagedCell(el, managedTypes.get(id), languageCode);
    }
    return mapChildren(el, walk);
  };
  return walk(bag);
}

/**
 * The hash of everything the declaration does NOT own: the preserved layout above, and `appended` — the cells a planned
 * append adds, in the order it adds them, as [{ id, parameters }] with each one's non-authored parameters (empty for a
 * read of what is stored). A component's `position` is not hashed: it is an index the SDK assigns on read; the layout
 * tree carries the order it is derived from.
 */
function preservationSha256(bag, managedTypes, languageCode, appended = []) {
  return sha({ layout: preservedLayout(bag, managedTypes, languageCode), appended });
}

/**
 * `bag` without the last `count` cells of its first section in reading order (rows flattened across their <rows>
 * containers, as the SDK indexes them), and without each row those cells emptied. That is exactly what an append adds:
 * the SDK fills the free columns of the last occupied row of the first section, then adds rows after it. Answers
 * { bag, removed } — `removed` the control ids of the cut cells in reading order — or null when one of those cells does
 * not hold exactly one control of `removable`: nothing else is ever cut. The input is not changed.
 */
function withoutTrailingCells(bag, count, removable) {
  if (!count) return { bag, removed: [] };
  if (!bag) return null;
  const copy = JSON.parse(JSON.stringify(bag));
  const first = firstSection(copy);
  if (!first) return null;
  const slots = [];
  for (const rowsEl of childrenNamed(first.section, 'rows')) {
    for (const row of childrenNamed(rowsEl, 'row')) for (const cell of childrenNamed(row, 'cell')) slots.push({ rowsEl, row, cell });
  }
  if (slots.length < count) return null;
  const tail = slots.slice(slots.length - count);
  const removed = [];
  for (const { cell } of tail) {
    const controls = childrenNamed(cell, 'control');
    const id = controls.length === 1 ? bareId(attrOf(controls[0], 'id')) : '';
    if (!id || !removable.has(id)) return null;
    removed.push(id);
  }
  const cut = new Set(tail.map((t) => t.cell));
  const emptied = new Set();
  for (const { row } of tail) {
    row.c = (row.c || []).filter((ch) => !cut.has(nodeOf(ch)));
    if (!childrenNamed(row, 'cell').length) emptied.add(row);
  }
  for (const { rowsEl } of tail) rowsEl.c = (rowsEl.c || []).filter((ch) => !emptied.has(nodeOf(ch)));
  return { bag: copy, removed };
}

/**
 * Whether a created dashboard, its appended tiles cut away, is the catalog seed and nothing else: exactly the seed tab,
 * exactly the seed section in it, and no row, cell or control left. A create adds no row of its own (the SDK drops the
 * seed's placeholder row when it appends the first tile), so anything left is someone else's content.
 */
function seedSkeletonOnly(bag, seed) {
  const layout = layoutOf(bag);
  let rows = 0;
  let controls = 0;
  const walk = (el) => {
    if (!el || typeof el !== 'object') return;
    if (el.n === 'row') rows += 1;
    if (el.n === 'control') controls += 1;
    for (const ch of el.c || []) walk(nodeOf(ch));
  };
  walk(bag);
  return layout.tabs.length === 1 && layout.tabs[0] === bareId(seed.tab) &&
    layout.sections.length === 1 && layout.sections[0].id === bareId(seed.section) && layout.sections[0].tab === bareId(seed.tab) &&
    !layout.cells.length && !rows && !controls;
}

/**
 * Whether `art` holds what the expected proof's preservation hash says was there before the send, with the planned
 * append on top and nothing else. The hash binds the appended cells' ids, order and non-authored parameters, so only a
 * cut of exactly those cells — and none of a pre-existing one, whose id the hash also binds — can match it:
 *   - an edit of an existing dashboard: some count of trailing cells of the first section (0 when nothing was appended)
 *     is cut, and the rest must hash as the layout the plan read;
 *   - a create: every managed cell is cut, the rest must be the seed alone (seedSkeletonOnly), and the cut cells must
 *     be the planned ones in the planned order.
 */
function preservedSinceSend(art, managedTypes, languageCode, expectedSha256, seed) {
  const byId = new Map(((art && art.components) || []).map((c) => [bareId(c.id), c]));
  const appendedOf = (removed) => removed.map((id) => ({ id, parameters: unownedParams(managedTypes.get(id), (byId.get(id) || {}).parameters) }));
  if (seed) {
    const cut = withoutTrailingCells(art && art.bag, managedTypes.size, new Set(managedTypes.keys()));
    return !!cut && seedSkeletonOnly(cut.bag, seed) && sha({ layout: null, appended: appendedOf(cut.removed) }) === expectedSha256;
  }
  for (let count = 0; count <= managedTypes.size; count += 1) {
    const cut = withoutTrailingCells(art && art.bag, count, new Set(managedTypes.keys()));
    // A longer cut contains the cell that stopped this one, so it cannot succeed either.
    if (!cut) return false;
    if (preservationSha256(cut.bag, managedTypes, languageCode, appendedOf(cut.removed)) === expectedSha256) return true;
  }
  return false;
}

/**
 * THE read-only projection of a stored dashboard: the one surface the proof, verify and hydrate share, so that no later
 * reader rebuilds a looser one. It reads and writes nothing. Call it with ONE input object:
 *
 *   const artifact = await sdk.getArtifact('dashboard', id);   // after sdk.fetchArtifact('dashboard', id, { overwrite: true })
 *   const p = projectDashboard(artifact, { ...committedProjectionInput(group), languageCode: sdk.languageCode });
 *   const certified = p.invalid.length === 0 && p.missing.length === 0 && p.duplicated.length === 0 &&
 *     p.semanticSha256 === group.proof.semanticSha256 && p.preservationSha256 === group.proof.preservationSha256;
 *
 * Every one of those five checks is needed: a tile in `missing` or `duplicated` is absent from both hashes.
 *   art           the dashboard as the SDK reads it;
 *   managed       the managed tiles by key and bare control id, [{ key, id }];
 *   seedIds       [tabId, sectionId] of the catalog seed for a dashboard this build created, [] otherwise. When given,
 *                 the seed tab and section must each be on exactly one element of their role, the section in the tab;
 *   languageCode  the SDK's language (sdk.languageCode; 1033 when omitted): which label a tile's name is read from.
 * Answers:
 *   root                { dashboardType, global, description } as read. Both hashes are of the root as read, so a
 *                       table-scoped or non-Standard root never matches a committed proof (always Standard and global);
 *   invalid             why the root or seed is not one a declared dashboard may be: 'dashboard-interactive-unsupported'
 *                       (not Standard), 'dashboard-scope-unsupported' (belongs to a table), 'dashboard-seed-unrecognized'
 *                       (seedIds is neither empty nor two ids), 'dashboard-seed-not-in-place' (the seed is not where the
 *                       create put it; also listed in `missing` as 'seed');
 *   tiles               each managed tile found exactly once: { key, id, type, cell, section, tab, parts };
 *   missing, duplicated the managed keys found on no tile or on several;
 *   semanticSha256      the managed projection (a committed group's proof.semanticSha256);
 *   preservationSha256  everything the declaration does not own: the whole layout with each managed cell's authored
 *                       parts taken out (strippedManagedCell) — every foreign cell and control, every tab, section and
 *                       row and their order, and each managed cell's other attributes, labels and parameters (a
 *                       committed group's proof.preservationSha256).
 */
function projectDashboard(art, { managed = [], seedIds = [], languageCode = DEFAULT_LCID } = {}) {
  const components = (art && art.components) || [];
  const layout = layoutOf(art && art.bag);
  const root = rootProjection(art && art.dashboardType, isGlobal(art), art && art.description);
  const invalid = [];
  if (root.dashboardType !== 'Standard') invalid.push('dashboard-interactive-unsupported');
  if (!root.global) invalid.push('dashboard-scope-unsupported');
  const tiles = [];
  const types = new Map();
  const missing = [];
  const duplicated = [];
  for (const { key, id } of managed) {
    const hits = components.filter((c) => bareId(c.id) === bareId(id));
    if (hits.length !== 1) { (hits.length ? duplicated : missing).push(key); continue; }
    const c = hits[0];
    tiles.push({ key, id: bareId(id), type: c.type, ...placeOf(c, layout), parts: liveTile(c, c.type) });
    types.set(bareId(id), c.type);
  }
  if (!Array.isArray(seedIds) || (seedIds.length !== 0 && seedIds.length !== 2)) {
    invalid.push('dashboard-seed-unrecognized');
  } else if (seedIds.length && !seedInPlace(layout, { tab: seedIds[0], section: seedIds[1] })) {
    invalid.push('dashboard-seed-not-in-place');
    missing.push('seed');
  }
  return {
    root,
    invalid,
    tiles,
    missing,
    duplicated,
    semanticSha256: projectionSha256(root, tiles),
    preservationSha256: preservationSha256(art ? art.bag : null, types, languageCode),
  };
}

/**
 * projectDashboard's `managed` and `seedIds` for a committed dashboard group: the managed tiles from
 * consumerState.tiles, and the catalog seed ids the store keeps (consumerState.seedIds) only on the commit of the
 * attempt that created the dashboard — every later commit records none, and nothing then checks the seed.
 */
function committedProjectionInput(group) {
  const cs = (group && group.consumerState) || {};
  return {
    managed: Object.entries(cs.tiles || {}).map(([key, t]) => ({ key, id: bareId(t.id) })),
    seedIds: Array.isArray(cs.seedIds) ? [...cs.seedIds] : [],
  };
}

// Every field a declared dashboard and its tiles may author (the app spec's dashboards[] entry, plus the declared
// mode's `reconcile`, `key` and tile `componentId`). The canonical declaration keeps exactly the ones the spec sets,
// each with its value as authored: an absent field stays absent, so "not authored" and "authored as the live value"
// stay different, and the declaration read back is the spec entry itself. A field outside these lists has no effect on
// what the build writes, and is not kept.
const DECLARED_FIELDS = ['reconcile', 'key', 'name', 'description', 'dashboardId', 'tiles'];
const DECLARED_TILE_FIELDS = ['key', 'type', 'name', 'view', 'chart', 'entity', 'viewId', 'visualizationId', 'url', 'webResource', 'componentId', 'colspan', 'rowspan'];

/**
 * The canonical declaration of a declared dashboard: the ORIGINAL declaration the attempt records before its send
 * (prepareAttempt `declaration`) and the group commits as consumerState.declaration; `declarationSha256` hashes it.
 * Free text (names, descriptions, view and chart names, urls) is kept as authored: the binding store accepts it in a
 * declaration and refuses, before anything is written or sent (`managed-declaration-refused`), a value it must not
 * hold, such as a token or a credential in a url.
 */
function canonicalDeclaration(dashboard) {
  const pick = (from, fields) => {
    const out = {};
    for (const f of fields) if (from[f] !== undefined) out[f] = from[f];
    return out;
  };
  const out = pick(dashboard || {}, DECLARED_FIELDS);
  if (Array.isArray(out.tiles)) out.tiles = out.tiles.map((t) => pick(t || {}, DECLARED_TILE_FIELDS));
  return out;
}

/**
 * The declaration a committed dashboard group was settled for, read back as the spec entry it was authored as (a deep
 * copy: changing it changes nothing stored), or null for a group committed without one. It is what verify compares
 * the spec with and what hydrate writes back; it passes validateDeclaredDashboard as the spec did.
 */
function committedDeclaration(group) {
  const d = group && group.consumerState ? group.consumerState.declaration : null;
  return d && typeof d === 'object' ? JSON.parse(JSON.stringify(d)) : null;
}

const rootProjection = (dashboardType, global, description) => ({
  dashboardType: dashboardType === undefined ? null : dashboardType,
  global: !!global,
  description: String(description == null ? '' : description),
});
// The root a declared dashboard is written as and proved against: global and Standard.
const declaredRoot = (description) => rootProjection('Standard', true, description);

/** Read a dashboard by exact id from the service (never the workspace copy); throws what the read threw. */
async function readDashboard(sdk, id) {
  await sdk.fetchArtifact(KIND, id, { overwrite: true });
  return (await sdk.getArtifact(KIND, id)) || null;
}

const snapshotSha256 = (art) => sha(JSON.parse(JSON.stringify({ name: art.name, description: art.description, layoutType: art.layoutType, components: art.components, bag: art.bag })));

/**
 * The dashboard as stored in ONE saved row: `saved` is the row readSystemFormPublication answered,
 *   { formid, name, description, formxml }
 * (its RetrieveUnpublished layer, the row systemFormLayerSha256 hashes), turned into the SDK's artifact by the SDK's own
 * dashboard adapter — the very function its fetch uses — so its components and bag are parsed exactly as `art`'s were.
 * The root's type and table come from `art` (the publication read does not select them; nor does the layer hash cover
 * them). Throws `dashboard-unreadable` when the SDK offers no such adapter or cannot parse the row: without it no proof
 * can be bound to the hashed row.
 */
function savedSnapshot(sdk, art, saved, key) {
  const reg = sdk && sdk.registrations && typeof sdk.registrations.get === 'function' ? sdk.registrations.get(KIND) : null;
  const adapter = reg && reg.adapter;
  if (!adapter || typeof adapter.toArtifact !== 'function') throw stop('dashboard-unreadable', `the SDK offers no reader of a dashboard row, so dashboard "${key}" cannot be proved against its saved row`);
  let parsed;
  try {
    parsed = JSON.parse(JSON.stringify(adapter.toArtifact({ formid: saved.formid, name: saved.name, description: saved.description, formxml: saved.formxml })));
  } catch (err) {
    throw stop('dashboard-unreadable', `the saved row of dashboard "${key}" could not be read as a dashboard`, { cause: err });
  }
  return { ...art, name: parsed.name, description: parsed.description, layoutType: parsed.layoutType, components: parsed.components, bag: parsed.bag };
}

/** Replace the seed tab's and section's ids in the SDK's freshly generated local seed; throws on any other shape. */
function reseedBag(seedBag, tabId, sectionId) {
  const bag = JSON.parse(JSON.stringify(seedBag || {}));
  const found = { tab: [], section: [] };
  const walk = (el) => {
    if (!el || typeof el !== 'object') return;
    if ((el.n === 'tab' || el.n === 'section') && (el.a || []).some((p) => Array.isArray(p) && p[0] === 'id')) found[el.n].push(el);
    for (const child of el.c || []) walk(nodeOf(child));
  };
  walk(bag);
  if (found.tab.length !== 1 || found.section.length !== 1) throw stop('dashboard-seed-unrecognized', 'the SDK seeded a dashboard layout this build does not recognize; nothing was sent');
  found.tab[0].a.find((p) => p[0] === 'id')[1] = braced(tabId);
  found.section[0].a.find((p) => p[0] === 'id')[1] = braced(sectionId);
  return bag;
}

const newTileComponent = (e) => ({ ...e.component, id: braced(e.controlId), bag: { a: [['id', braced(e.cellId)]], c: [] } });

function resolveComponent(tile, index, resolveTile, toComponent) {
  let component;
  try {
    component = toComponent(resolveTile(tile), index);
  } catch {
    component = null;
  }
  return component && OWNED_PARAMS[component.type] && targetsResolved(component) ? component : null;
}

/**
 * The wrapper's preflight (runManagedFeature `preflight`), run on every path before anything is read into the
 * workspace, proved or sent; it reads nothing from the service and writes nothing. Refuses by throwing:
 *   - a retained creation record of this dashboard (`dashboard-creation-record-unsettled`): runManagedFeature
 *     quarantines every id it knows by then — the retained ids, the pin, the name lookup, the catalog id and the
 *     committed and pending roots — so neither a dashboard publish nor an app publish ships any of them;
 *   - a workspace copy with edits the server has not seen, of ANY id this dashboard may be read under: the committed
 *     root, the pending root, the pin, the name lookup and the catalog id. Every read here fetches with overwrite, so
 *     such a copy is checked before the first one. `create-completion-required`, category `workspace-copy-unsent-edits`:
 *     the maker saves the edit into the spec or discards the copy; an identical rerun stops the same way.
 *     A copy the SDK cannot diff reads as edited (hasUnsyncedEdits fails open), so a doubtful copy is never dropped.
 */
async function preflightDashboard(s, { committed, pending }) {
  const { key, sdk, dashboard, catalog } = s;
  if (s.retainedCreationIds.length) throw stop(CREATION_RECORD_UNSETTLED, `the creation record of dashboard "${key}" is not settled; it is not written or published in this run`);
  const ids = [committed && committed.root.id, pending && pending.root && pending.root.id, dashboard && dashboard.dashboardId, s.resolvedId];
  try { ids.push(catalog.identityFor(KIND, key).derivedId); } catch { /* not in the catalog: resolve stops it */ }
  for (const id of [...new Set(ids.map(normalizeGuid).filter(Boolean))]) {
    if (await hasUnsyncedEdits(sdk, KIND, id)) {
      throw stop('create-completion-required', `the workspace copy of dashboard "${key}" holds edits that were never sent; save them into the spec or discard the copy before the build reconciles it`, { category: 'workspace-copy-unsent-edits', id });
    }
  }
}

/**
 * Read and check one declared dashboard: GET only, and every refusal is a coded throw before any write.
 * Answers the resolution plan() turns into the expected proof. The preflight above has already run.
 */
async function resolveDashboard(s, committed, pending) {
  const { dashboard, key, sdk, catalog, approvals } = s;
  const errors = validateDeclaredDashboard(dashboard);
  if (errors.length) throw stop('dashboard-spec-invalid', `declared dashboard "${key}" does not compile: ${errors.join('; ')}`, { errors });

  const records = committed ? committed.records : [];
  const boundId = committed ? bareId(committed.root.id) : '';
  const pin = normalizeGuid(dashboard.dashboardId);
  const named = normalizeGuid(s.resolvedId);
  const others = [pin, named].filter(Boolean);
  if (boundId ? others.some((o) => o !== boundId) : new Set(others).size > 1) {
    throw stop('dashboard-binding-mismatch', `declared dashboard "${key}" is bound to one dashboard and the spec or the name lookup names another; settle which one it is before the build writes it`);
  }
  const derived = catalog.identityFor(KIND, key).derivedId;
  const id = boundId || pin || named || derived;
  const source = boundId ? 'bound' : pin ? 'pinned' : named ? 'named' : 'derived';

  let live = null;
  try {
    live = await readDashboard(sdk, id);
  } catch (err) {
    if (!isNotFound(err)) throw stop('dashboard-unreadable', `dashboard "${key}" could not be read`, { cause: err });
  }
  if (!live) {
    if (source === 'bound') throw stop('dashboard-bound-row-missing', `the dashboard "${key}" is bound to is gone; repair the binding explicitly before it can be recreated`);
    if (source !== 'derived') throw stop('dashboard-pinned-not-found', `the dashboard "${key}" names is not in the environment; remove the id or bind the dashboard`);
    return resolveCreate(s, id, pending);
  }

  let pub;
  try {
    pub = await readSystemFormPublication(sdk.dataverse, id);
  } catch (err) {
    throw stop('dashboard-published-unreadable', `whether the saved state of dashboard "${key}" is published could not be read`, { cause: err });
  }
  if (live.dashboardType !== 'Standard') throw stop('dashboard-interactive-unsupported', `dashboard "${key}" is not a standard dashboard; only a standard one is reconciled, and it was left as it is`);
  if (!isGlobal(live)) throw stop('dashboard-scope-unsupported', `dashboard "${key}" belongs to a table; only a global dashboard is reconciled, and it was left as it is`);
  // The plan below is built from the SDK's read, and its base observation hashes the publication read's saved row: two
  // GETs. They must be one snapshot, or the plan would describe one row and record the hash of another.
  if (snapshotSha256(savedSnapshot(sdk, live, pub.saved, key)) !== snapshotSha256(live)) {
    throw stop('dashboard-unreadable', `dashboard "${key}" changed while it was read; nothing was sent, run again`);
  }

  const components = live.components || [];
  const occurrences = new Map();
  components.forEach((c, i) => occurrences.set(bareId(c.id), [...(occurrences.get(bareId(c.id)) || []), i]));
  // A control id on two live cells: an edit by id could land on either, so nothing is written.
  if ([...occurrences.values()].some((at) => at.length > 1)) throw stop('dashboard-live-control-duplicate', `one control id appears on more than one tile of dashboard "${key}"; repair it in Maker first`);

  const layout = layoutOf(live.bag);
  const rootRecord = records.find((r) => r.kind === KIND && r.key === key) || null;
  const refusals = [];
  const refuse = (k, code, message) => refusals.push({ key: k, code, message });
  const claimed = new Set();
  const entries = [];
  const additions = [];
  let writes = 0;
  for (const tile of dashboard.tiles) {
    const tileKey = `${key}/${tile.key}`;
    const component = resolveComponent(tile, 0, s.resolveTile, s.toComponent);
    if (!component) { refuse(tileKey, 'dashboard-tile-unresolved', 'the tile\'s view, chart, url or web resource could not be resolved'); continue; }
    const record = records.find((r) => r.kind === TILE_KIND && r.key === tileKey) || null;
    const recId = record ? bareId(record.id) : '';
    const pinned = normalizeGuid(tile.componentId);
    if (recId && pinned && recId !== pinned) { refuse(tileKey, 'dashboard-tile-binding-mismatch', 'the tile is bound to one control and its componentId names another; repair the binding explicitly'); continue; }
    const controlId = recId || pinned;
    const entry = { tile, tileKey, component, record };
    if (controlId) {
      if (claimed.has(controlId)) { refuse(tileKey, 'dashboard-tile-claimed-twice', 'the tile\'s control is already managed under another key; one control belongs to one key'); continue; }
      claimed.add(controlId);
      const at = occurrences.get(controlId);
      // Never re-added, whatever the approvals: the key already had a control, and a second one would be a
      // replacement the binding never named.
      if (!at) { refuse(tileKey, record ? 'dashboard-tile-missing' : 'dashboard-tile-pinned-not-found', 'the tile this spec manages is not on the dashboard; restore it in Maker or repair the binding explicitly'); continue; }
      const hit = components[at[0]];
      if (hit.type !== component.type) { refuse(tileKey, 'dashboard-tile-type-change', 'the tile\'s type cannot change in place; remove the tile in Maker or give it a new key'); continue; }
      Object.assign(entry, { controlId, index: at[0], place: placeOf(hit, layout), origin: record ? record.origin : 'adopted' });
      entry.liveParts = liveTile(hit, component.type);
      entry.desired = desiredTile(tile, component, entry.liveParts);
      entry.changed = changedParts(entry.liveParts, entry.desired);
      if (entry.changed.length) {
        // Judged only on the parts this run writes: a part someone else changed and the spec leaves alone is theirs.
        if (partsDriftVerdict(record, entry.liveParts, entry.desired) === 'drift' && !isApproved(approvals.overwrite, KIND, tileKey)) {
          refuse(tileKey, 'dashboard-tile-drift', 'an authored part of the tile was changed outside the spec; refresh the spec or approve the overwrite');
          continue;
        }
        writes += 1;
      }
      entries.push(entry);
      continue;
    }
    entry.desired = desiredTile(tile, component, liveTile(component, component.type));
    // A new tile on a dashboard this spec does not manage yet: a live tile showing the same target is almost
    // certainly this tile created by an earlier build, and appending would show it twice.
    if (!committed) {
      const twin = components.find((c) => !claimed.has(bareId(c.id)) && c.type === component.type && sameParams(c.type, liveTile(c, c.type), entry.desired));
      if (twin) { refuse(tileKey, 'dashboard-tile-match-unpinned', 'a live tile already shows this target; set the tile\'s componentId to adopt it'); continue; }
    }
    entry.origin = 'created';
    additions.push(entry);
    entries.push(entry);
    writes += 1;
  }

  if (additions.length && !refusals.length) {
    // A new tile goes AFTER the occupied layout: its position must map to no existing cell, or the SDK overlays that
    // cell with it. The row count of the first section is the first row index no cell can occupy. The SDK appends into
    // that section and, on the way, drops every row of it with no control in any cell (its cleanup of the seed
    // placeholder): an existing empty or spacer row of a maker's layout would be lost, so such a layout is refused.
    const first = firstSection(live.bag);
    const hasControl = (row) => childrenNamed(row, 'cell').some((cell) => childrenNamed(cell, 'control').length > 0);
    if (!first || first.rows.some((row) => !hasControl(row))) {
      for (const e of additions) refuse(e.tileKey, 'dashboard-layout-unsupported', 'a tile cannot be added to this dashboard\'s layout without changing rows it already has; add it in Maker');
    } else {
      const { childIds } = catalog.reserveChildren(KIND, key, { actualRootId: id, children: additions.flatMap((e) => tileChildren(e.tile.key)) });
      const place = { section: bareId(attrOf(first.section, 'id')), tab: bareId(attrOf(first.tab, 'id')) };
      additions.forEach((e, j) => {
        e.controlId = childIds[controlLocator(e.tile.key)];
        e.cellId = childIds[cellLocator(e.tile.key)];
        // A live control that already carries the reserved id is an earlier append whose binding was lost: adopting
        // it is the maker's call (pin it), never a second append under the same id.
        if (occurrences.has(e.controlId)) refuse(e.tileKey, 'dashboard-tile-match-unpinned', 'a live tile already carries the id this build reserves for the tile; set the tile\'s componentId to adopt it');
        e.place = { cell: e.cellId, ...place };
        e.component = s.toComponent(s.resolveTile(e.tile), first.rows.length + j);
      });
    }
  }

  const liveRoot = { description: String(live.description == null ? '' : live.description) };
  const desiredRoot = { description: typeof dashboard.description === 'string' ? dashboard.description : liveRoot.description };
  let description;
  if (desiredRoot.description !== liveRoot.description) {
    if (partsDriftVerdict(rootRecord, liveRoot, desiredRoot) === 'drift' && !isApproved(approvals.overwrite, KIND, key)) {
      refuse(key, 'dashboard-drift', 'the dashboard description was changed outside the spec; refresh the spec or approve the overwrite');
    } else if (desiredRoot.description === '' && !isApproved(approvals.destructive, KIND, key)) {
      refuse(key, 'dashboard-description-clear-not-authorized', 'clearing the dashboard description removes text the dashboard holds; approve the destructive change');
    } else {
      description = desiredRoot.description;
      writes += 1;
    }
  }
  // A dashboard this spec does not manage yet is written only with its typed adoption approval. A pin names the row;
  // it is not the maker's consent to manage it, and the wrapper and the store refuse to bind an existing root without
  // that approval anyway — refusing here keeps the content unwritten rather than written and then left unbound.
  const adoptable = !!committed || s.adoptApproved;
  if (!refusals.length && writes && !adoptable) refuse(key, 'dashboard-adoption-not-authorized', `the dashboard exists and is not yet managed by this spec; approve adopting it first (dashboard:${key})`);
  if (refusals.length) throw stop(refusals[0].code, `declared dashboard "${key}": ${refusals.map((r) => `${r.key}: ${r.message}`).join('; ')}`, { refusals });

  return { create: false, id, source, live, pub, layout, entries, additions, description, desiredRoot, writes, adoptable, pending: !!pending };
}

/** A dashboard no id names that is not there: it is created under its catalog id, every tile a catalog child of it. */
function resolveCreate(s, id, pending) {
  const { dashboard, key } = s;
  const refusals = [];
  const entries = [];
  dashboard.tiles.forEach((tile, i) => {
    const tileKey = `${key}/${tile.key}`;
    if (tile.componentId !== undefined) { refusals.push({ key: tileKey, code: 'dashboard-tile-pinned-not-found', message: 'the tile names a control on a dashboard this build did not find; remove the componentId or bind the dashboard' }); return; }
    const component = resolveComponent(tile, i, s.resolveTile, s.toComponent);
    if (!component) { refusals.push({ key: tileKey, code: 'dashboard-tile-unresolved', message: 'the tile\'s view, chart, url or web resource could not be resolved' }); return; }
    entries.push({ tile, tileKey, component, origin: 'created', desired: desiredTile(tile, component, liveTile(component, component.type)) });
  });
  if (refusals.length) throw stop(refusals[0].code, `declared dashboard "${key}": ${refusals.map((r) => `${r.key}: ${r.message}`).join('; ')}`, { refusals });
  const { childIds } = s.catalog.reserveChildren(KIND, key, { actualRootId: id, children: [...SEED_CHILDREN, ...dashboard.tiles.flatMap((t) => tileChildren(t.key))] });
  const seed = { tab: childIds[SEED_TAB], section: childIds[SEED_SECTION] };
  for (const e of entries) {
    e.controlId = childIds[controlLocator(e.tile.key)];
    e.cellId = childIds[cellLocator(e.tile.key)];
    e.place = { cell: e.cellId, section: seed.section, tab: seed.tab };
  }
  const description = typeof dashboard.description === 'string' ? dashboard.description : '';
  return { create: true, id, source: 'derived', seed, entries, additions: entries, description, desiredRoot: { description }, writes: 1 + entries.length, adoptable: true, pending: !!pending };
}

/**
 * The expected proof of a resolution, persisted before the send; { noop: true } when nothing is to be sent or bound.
 * Rebuilt from the same declaration and the same service state it answers the same plan, which is what a continued or
 * resumed attempt (runManagedFeature `continuing` / `resuming`) must reproduce: the root id is the bound, pinned,
 * name-found or catalog id, the child ids are catalog ids, and every hash is of the declaration and the read.
 */
function planDashboard(s, resolution, committed) {
  const r = resolution;
  const savedSha = r.create ? null : systemFormLayerSha256(r.pub.saved);
  const declaration = canonicalDeclaration(s.dashboard);
  if (!r.create && r.writes === 0) {
    if (!r.adoptable) return { noop: true };
    const recorded = committed && r.entries.every((e) => e.record && e.record.intentSha256 === projectionBaseline(e.liveParts).intentSha256);
    const rootRec = committed && committed.records.find((x) => x.kind === KIND && x.key === s.key);
    const rootSame = !!rootRec && rootRec.intentSha256 === projectionBaseline({ description: r.desiredRoot.description }).intentSha256;
    const declared = committed && canonicalJson(committed.consumerState && committed.consumerState.declaration) === canonicalJson(declaration);
    // A true no-op: the committed group already says what is there and what the spec declares. Whether the published
    // layer is behind the saved one does not matter here: only debt the group already owes is published (below), and
    // a read never makes a debt. Otherwise the group is (re)bound without a content write.
    if (!r.pending && recorded && rootSame && declared && committed.proof.savedSha256 === savedSha) return { noop: true };
  }
  const tiles = r.entries.map((e) => ({ key: e.tileKey, id: e.controlId, type: e.component.type, cell: e.place.cell, section: e.place.section, tab: e.place.tab, parts: e.desired }));
  const children = r.entries.map((e) => ({ kind: TILE_KIND, key: e.tileKey, namespaceParentId: r.id, id: e.controlId, associationSha256: associationOf(e.tileKey, e.component.type, e.place) }));
  // What the declaration does not own, as the send leaves it: the layout read now (each bound managed cell with its
  // authored parts taken out), plus the cells this run appends, in the order it appends them, with the non-authored
  // parameters it gives them. A create has no layout before the send: its proof checks the rest is the seed alone.
  const managedTypes = new Map(r.entries.map((e) => [e.controlId, e.component.type]));
  const appended = r.additions.map((e) => ({ id: e.controlId, parameters: unownedParams(e.component.type, e.component.parameters) }));
  const expected = {
    proofVersion: 1,
    proofSchema: PROOF_SCHEMA,
    rootId: r.id,
    baseProofSha256: committed ? committed.proof.semanticSha256 : null,
    sentProjectionSha256: projectionSha256(declaredRoot(r.desiredRoot.description), tiles),
    preservationSha256: r.create ? sha({ layout: null, appended }) : preservationSha256(r.live.bag, managedTypes, s.languageCode, appended),
    baseObservation: r.create ? null : { rowVersion: null, savedSha256: savedSha },
    children,
  };
  return {
    root: { kind: KIND, key: s.key, id: r.id },
    expected,
    declarationSha256: sha(declaration),
    // The original declaration, recorded with the attempt before the send and committed with the group: a recovery
    // commits this one, not the spec of the run that recovers it.
    declaration,
    // The debt this attempt may create: only for its own content write. A rebind without one owes nothing new.
    publication: r.writes ? { scope: scopeOf(r.id), state: 'owed' } : null,
  };
}

/** Send the planned change once: a create, or the edits and appends of an existing dashboard, in one push. */
async function applyDashboard(s, r) {
  const { sdk, key } = s;
  const id = r.id;
  if (!r.writes) return { createdRoot: false, createdTiles: [] };
  let pushed;
  try {
    if (r.create) {
      const art = await sdk.createArtifact(KIND, { name: s.dashboard.name, ...(r.description ? { description: r.description } : {}), id });
      // The catalog id is the expected proof's root: a dashboard stored under another id could not be recovered.
      if (normalizeGuid(art && art.id) !== id) throw stop('dashboard-create-id-not-kept', `the SDK did not keep the id of dashboard "${key}"; nothing was sent`);
      await sdk.updateElement(KIND, id, '/bag', reseedBag(art.bag, r.seed.tab, r.seed.section));
      for (const e of r.entries) await sdk.addElement(KIND, id, '/components', newTileComponent(e));
    } else {
      for (const e of r.entries.filter((x) => x.changed && x.changed.length)) {
        for (const part of e.changed) {
          const value = part.startsWith('parameters/') ? e.component.parameters[part.slice('parameters/'.length)] : e.desired[part];
          await sdk.updateElement(KIND, id, `/components/${e.index}/${part}`, value);
        }
      }
      for (const e of r.additions) await sdk.addElement(KIND, id, '/components', newTileComponent(e));
      if (r.description !== undefined) await sdk.updateElement(KIND, id, '/description', r.description);
    }
  } catch (err) {
    if (err && err.code === 'dashboard-create-id-not-kept') throw err;
    throw stop(err && err.code === 'dashboard-seed-unrecognized' ? err.code : 'dashboard-rejected', `the edit of dashboard "${key}" was refused before it was sent`, { cause: err, rules: rulesOf(err) });
  }
  pushed = r.create ? await pushChecked(sdk, KIND, id) : await pushIfChanged(sdk, KIND, id);
  if (pushed.outcome === 'refused') throw stop('dashboard-rejected', `the edit of dashboard "${key}" was refused`, { rules: pushed.rules || [] });
  if (pushed.outcome === 'unknown') throw stop('dashboard-write-unknown', `the write of dashboard "${key}" did not report its outcome; check the dashboard`);
  return { createdRoot: r.create, createdTiles: r.additions.map((e) => e.tileKey) };
}

/**
 * The all-or-error proof of the stored dashboard against `expected` alone (a recovery has no plan): every expected
 * control once, in its expected cell, section and tab with its type; for a create, the catalog seed tab and section
 * in their roles; the managed projection exactly the one sent; everything the declaration does not own exactly as
 * before.
 */
async function proveDashboard(s, expected, applied, { token = null, recovering = false, declaration } = {}) {
  const { sdk, key, store } = s;
  const id = expected.rootId;
  let art;
  let pub;
  try {
    art = await readDashboard(sdk, id);
  } catch (err) {
    throw stop('dashboard-unreadable', `dashboard "${key}" was written and could not be read back to prove it`, { cause: err });
  }
  try {
    pub = await readSystemFormPublication(sdk.dataverse, id);
  } catch (err) {
    throw stop('dashboard-published-unreadable', `whether the saved state of dashboard "${key}" is published could not be read`, { cause: err });
  }
  if (!art || art.dashboardType !== 'Standard' || !isGlobal(art)) throw stop('dashboard-stored-mismatch', `the stored dashboard "${key}" is not a global standard dashboard`);
  // Everything below is proved on the saved row the publication read answered — the one whose hash becomes the
  // committed savedSha256 and the publication's desired hash — never on the SDK's earlier read of it: a change landing
  // between the two GETs would otherwise be published without ever having been proved.
  const saved = savedSnapshot(sdk, art, pub.saved, key);
  const created = expected.baseObservation === null;
  let seedIds = [];
  let seed = null;
  if (created) {
    const { childIds } = s.catalog.reserveChildren(KIND, key, { actualRootId: id, children: SEED_CHILDREN });
    seedIds = [childIds[SEED_TAB], childIds[SEED_SECTION]];
    seed = { tab: seedIds[0], section: seedIds[1] };
  }
  const projected = projectDashboard(saved, { managed: expected.children.map((c) => ({ key: c.key, id: c.id })), seedIds, languageCode: s.languageCode });
  if (projected.invalid.some((code) => code === 'dashboard-interactive-unsupported' || code === 'dashboard-scope-unsupported')) {
    throw stop('dashboard-stored-mismatch', `the stored dashboard "${key}" is not a global standard dashboard`);
  }
  const missing = projected.missing.map((k) => (k === 'seed' ? key : k));
  const mismatch = [...projected.duplicated];
  const found = [];
  for (const t of projected.tiles) {
    const child = expected.children.find((c) => c.key === t.key);
    if (associationOf(t.key, t.type, t) !== child.associationSha256) { mismatch.push(t.key); continue; }
    found.push({ child, parts: t.parts, place: { cell: t.cell, section: t.section, tab: t.tab }, type: t.type });
  }
  if (missing.length) throw stop('create-completion-required', `a part of dashboard "${key}" is not on the stored dashboard (${missing.join(', ')}); complete or remove it in Maker, then run again`);
  if (mismatch.length) throw stop('dashboard-stored-mismatch', `the stored dashboard "${key}" does not hold what was written (${mismatch.join(', ')}); check the dashboard`);
  const semantic = projected.semanticSha256;
  const managedTypes = new Map(projected.tiles.map((t) => [t.id, t.type]));
  // What is stored now is not what was sent, or a part the spec does not own changed, or content was added that the
  // send did not add (on a create: anything but the seed and the planned tiles): binding or publishing it would claim
  // content this build never wrote — after a crash, someone's edit made since.
  if (semantic !== expected.sentProjectionSha256 || !preservedSinceSend(saved, managedTypes, s.languageCode, expected.preservationSha256, seed)) {
    throw stop('create-completion-required', `the stored dashboard "${key}" is not the one this build sent; it was not bound or published`);
  }
  // The committed preservation is the plain one of the stored row, as projectDashboard answers it to verify and hydrate.
  const preserved = projected.preservationSha256;

  const { committed, pending } = store.readGroup(KIND, key);
  const attempt = recovering ? (pending && (!token || pending.token === token) ? pending : null) : null;
  // The root create is acknowledged only by this run's own answer to its create, never by a read. A recovered
  // attempt counts it only when the attempt itself durably recorded that acknowledgement before the run stopped.
  const rootCreateAcknowledged = recovering
    ? created && !!attempt && (attempt.acknowledgedRoot === true || !!(attempt.savedObservation && attempt.savedObservation.acknowledgedRoot === true))
    : !!(applied && applied.createdRoot);
  const prior = (kind, k) => (committed ? committed.records.find((x) => x.kind === kind && x.key === k) : null);
  // A record this group does not hold yet claims `created` only when this attempt's root create is acknowledged (the
  // store allows `created` on nothing else): tiles appended to a dashboard that already existed are `adopted`, the
  // dashboard being someone else's row this build now manages. A recovered one (a lost answer) is adopted too.
  const originOf = (kind, k, createdNow) => {
    const old = prior(kind, k);
    if (old) return old.origin;
    return rootCreateAcknowledged && createdNow ? 'created' : 'adopted';
  };
  const record = (kind, k, rid, parts, extra) => ({
    formatVersion: 1, appUniqueName: s.ctx.appUniqueName, environmentFingerprint: s.ctx.environmentFingerprint,
    kind, key: k, id: rid, ...projectionBaseline(parts), ...extra,
  });
  // On a recovered create every expected child was created with the root; otherwise only this run's own additions.
  const createdTiles = new Set(recovering ? (created ? expected.children.map((c) => c.key) : []) : ((applied && applied.createdTiles) || []));
  const records = [
    ...found.map(({ child, parts }) => record(TILE_KIND, child.key, child.id, parts, { origin: originOf(TILE_KIND, child.key, createdTiles.has(child.key)), parentKey: key })),
    record(KIND, key, id, { description: String(saved.description == null ? '' : saved.description) }, { origin: originOf(KIND, key, created) }),
  ];
  // The debt's desired hash is the one the shared `dashboard` layer reader answers, so publishManagedScope compares like with like.
  const savedSha = systemFormLayerSha256(pub.saved);
  const scope = scopeOf(id);
  const notNeeded = { scope, state: 'not-needed', desiredSha256: null, dispatchToken: null };
  // Publication provenance: a debt is owed only for THIS attempt's proved content write (its planned publication — the
  // attempt record's when recovering, this run's plan otherwise), or carried over unchanged from the committed group's
  // own unsent debt. A saved layer read ahead of the published one is someone's draft (a Maker save, another tool's
  // write) and never becomes this build's debt: publishing it would put live what the build did not write.
  const plannedPub = recovering ? (attempt ? attempt.publication : null) : (s.lastPlan ? s.lastPlan.publication : null);
  let publication = notNeeded;
  if (plannedPub && plannedPub.state === 'owed') {
    publication = pub.state === 'equal' ? notNeeded : { scope, state: 'owed', desiredSha256: savedSha, dispatchToken: null };
  } else if (committed && committed.publication && committed.publication.state === 'owed' && pub.state !== 'equal') {
    publication = { ...committed.publication };
  }
  // The declaration this attempt was sent with: the one the attempt recorded before the send (the wrapper's
  // `declaration`; on a recovery always the attempt's), never rebuilt from today's spec. It must be the one the
  // attempt's declaration hash names, or the commit would bind a declaration the attempt was not planned with. Only an
  // attempt recorded without a declaration (before attempts kept one) falls back to the hash rule: today's spec when it
  // hashes the same, else unknown (null), and the next run reconciles today's spec.
  const sentDeclarationSha = recovering ? (attempt ? attempt.declarationSha256 : null) : (s.lastPlan ? s.lastPlan.declarationSha256 : null);
  let keptDeclaration;
  if (declaration && typeof declaration === 'object') {
    if (sha(declaration) !== sentDeclarationSha) {
      throw stop('create-completion-required', `the declaration recorded for dashboard "${key}" is not the one its change was planned with; it was not bound or published`);
    }
    keptDeclaration = declaration;
  } else {
    const canonical = canonicalDeclaration(s.dashboard);
    keptDeclaration = sha(canonical) === sentDeclarationSha ? canonical : null;
  }
  return {
    savedProof: { savedSha256: savedSha },
    // Acknowledged only by this run's own answer to its create: never on a recovery, never from a read.
    acknowledgedRoot: !recovering && !!(applied && applied.createdRoot),
    records,
    proof: { savedSha256: savedSha, semanticSha256: semantic, preservationSha256: preserved, expectedChildrenSha256: expected.children.length ? sha(expected.children) : null },
    consumerState: {
      declaration: keptDeclaration,
      tiles: Object.fromEntries(found.map(({ child, place, type }) => [child.key, { id: child.id, type, cell: place.cell, section: place.section, tab: place.tab }])),
      seedIds,
    },
    publication,
    proofSchema: PROOF_SCHEMA,
  };
}

/**
 * Settle one declared dashboard on the managed settlement. Arguments:
 *   dashboard            the spec entry (`reconcile: "declared"`);
 *   catalog              the plan's create catalog (creates-catalog.js createIntentCatalog), holding this dashboard's
 *                        intent: { catalogKind: 'dashboard', key: dashboardKey(dashboard), scope, declaration };
 *   sdk                  the maker SDK, its `dataverse` client behind the run's publication barrier;
 *   store, barrier, halt the managed binding handle, the run's publication barrier, the build's halt factory;
 *   resolveTile, toComponent   the build's dashboardTileOpts and dashboardComponent;
 *   retainedCreationIds  the ids the dashboard creation record still retains for this dashboard's name: the build's
 *                        openDashboardCreations(...).idsOf(dashboard.name) (dashboard-creation-records.js), [] when it
 *                        answers none. Any of them stops it with `dashboard-creation-record-unsettled`;
 *   resolvedId           for a dashboard no committed group binds, the one id the build's name lookup singled out —
 *                        findDashboardsByName(sdk, dashboard.name) in sdk-build.js, narrowed to this app's solution when
 *                        it answers several — or none. It is where the dashboard is looked for, never consent to manage it;
 *   approvals            { adopt, overwrite, destructive }: the --authorize sets, keyed `dashboard:<key>` (and
 *                        `dashboard:<key>/<tile>` for a tile's overwrite). `adopt` holding `dashboard:<key>` is the
 *                        ONLY consent to manage a dashboard this build did not create (a pin is not);
 *   ensureMembership     solution membership of the root ({ root, records, recovering });
 *   sendObserver         the build-wide send observer (managed-feature-contract.js createAttemptSendObserver, installed
 *                        on the client every send goes through), or none: with it, an attempt proven unsent continues;
 *   ctx                  { appUniqueName, environmentFingerprint } the records are written for.
 * Answers runManagedFeature's { result, committedGroup } plus { key, id }. Every failure throws the build's halt, and
 * every id this dashboard is known by stays quarantined for the run (no dashboard publish, no app publish of it).
 *
 * What an answer means, by how this build came to hold the dashboard:
 *   - inspection: a dashboard no group binds that already matches the spec, without `dashboard:<key>` adoption
 *     approval, answers { result: { noop: true } } and committedGroup null. It is read, never bound, never published;
 *   - acknowledged create: this run's own create answer acknowledged the new root; the root and its tiles commit with
 *     origin `created`, and only their write is owed a publication;
 *   - committed ownership: a group already binds the dashboard; a run writes only what the spec authors, proves the rest
 *     unchanged, and owes a publication only for its own proved write;
 *   - unacknowledged adoption: an existing dashboard, or a created root whose create answer was lost, binds only with
 *     `dashboard:<key>` adoption approval (its records origin `adopted`); without it nothing is bound or published, and
 *     an attempt and its proof are kept for the run that has the approval.
 */
async function settleDeclaredDashboard(args) {
  const { dashboard, catalog, sdk, store, halt, ensureMembership } = args || {};
  const barrier = args.barrier || store;
  const key = dashboardKey(dashboard);
  const s = {
    dashboard, key, catalog, sdk, store,
    resolveTile: args.resolveTile, toComponent: args.toComponent,
    retainedCreationIds: (args.retainedCreationIds || []).map(normalizeGuid).filter(Boolean),
    resolvedId: args.resolvedId || null,
    approvals: args.approvals || {},
    ctx: args.ctx || {},
    languageCode: (sdk && sdk.languageCode) || DEFAULT_LCID,
    lastPlan: null,
  };
  s.adoptApproved = isApproved(s.approvals.adopt, KIND, key) === true;
  const label = `declared dashboard "${key}"`;
  // Every row id this dashboard may be: the retained creation ids, the pin, the name lookup and the catalog id. The
  // wrapper registers them first and adds the committed and pending roots itself.
  const known = [...s.retainedCreationIds, normalizeGuid(dashboard && dashboard.dashboardId), normalizeGuid(s.resolvedId)];
  try { known.push(catalog.identityFor(KIND, key).derivedId); } catch { /* not in the catalog: resolve stops it below */ }
  const knownIds = [...new Set(known.filter(Boolean))];
  let resolution = null;
  let id = null;
  let run;
  try {
    run = await runManagedFeature({
      phase: 'dashboards', family: KIND, key, label, knownScopes: [], knownIds, store, barrier, halt,
      ...(args.sendObserver ? { sendObserver: args.sendObserver } : {}),
      adoptionApproved: s.adoptApproved,
      preflight: async ({ committed, pending }) => preflightDashboard(s, { committed, pending }),
      // A create names its root id (the catalog id), so an attempt whose create no answer acknowledged is resumed when
      // both layers of that row read absent; a read that fails is the wrapper's hold (never caught here).
      resumeCreate: async ({ pending }) => ({ root: await readSystemFormRootPresence(sdk.dataverse, pending.root.id) }),
      resolve: async ({ committed, pending }) => {
        if (!catalog || typeof catalog.identityFor !== 'function') throw stop('dashboard-spec-invalid', `${label} has no create catalog`);
        resolution = await resolveDashboard(s, committed, pending);
        id = resolution.id;
        return resolution;
      },
      plan: async ({ resolution: r, committed }) => {
        s.lastPlan = planDashboard(s, r, committed);
        return s.lastPlan;
      },
      apply: async ({ resolution: r }) => applyDashboard(s, r),
      prove: async ({ token, expected, applied, recovering, declaration }) => { id = expected.rootId; return proveDashboard(s, expected, applied, { token, recovering, declaration }); },
      ensureMembership,
    });
  } catch (err) {
    // Second belt (the wrapper is the first): a dashboard that did not settle, whatever step failed, keeps every row
    // id it is known by withheld for the run — the bound, pinned, name-found, catalog and resolved ids. The wrapper
    // quarantines only the steps whose failure leaves the saved state unproved and holds an attempt it sent; an
    // earlier owed publish of a known row must not ship through the app publish while this declaration is stopped
    // either. A new dashboard no id names yet has no row to withhold.
    const stored = [];
    try {
      const { committed, pending } = store.readGroup(KIND, key);
      if (committed) stored.push(committed.root.id);
      if (pending && pending.expected) stored.push(pending.expected.rootId);
    } catch { /* an unreadable group: the wrapper already fenced what it could name */ }
    const ids = [...new Set([...knownIds, normalizeGuid(id), ...stored.map(normalizeGuid)].filter(Boolean))];
    if (ids.length && typeof barrier.quarantine === 'function') {
      try { barrier.quarantine(ids.map(scopeOf), ids, `${label} (it did not settle)`); } catch { /* the halt below still stops the build */ }
    }
    throw err;
  }
  return { ...run, key, id: id || (run.committedGroup && run.committedGroup.root.id) || null };
}

/**
 * THE one path a declared dashboard's publication takes: publishManagedScope with exactly one scope — this
 * dashboard's own id — and one group, published by the SDK's `<dashboard>` envelope:
 *   POST PublishXml {"ParameterXml":"<importexportxml><dashboards><dashboard>ID</dashboard></dashboards></importexportxml>"}
 * The pre-send check reads every committed group on the scope with its family's shared reader
 * (lib/managed-layer-readers.js; a dashboard is a systemform row, read by readSystemFormLayers) over the SDK's
 * Dataverse client; no group is filtered or skipped here, and this adapter brings no reader of its own. A publication
 * left uncertain by an earlier run (sent, its confirmation not written) is confirmed by that read first, not resent.
 * Outcomes:
 *   - `managed-publication-unverified` (a layer read failed before the send) is a HOLD: the scope is blocked for the
 *     rest of the run and the answer says `held`; it is never retried in the run;
 *   - `managed-publication-refused` (the request named other targets than this dashboard) is a REFUSAL: nothing was
 *     sent, the scope is blocked for the run, and the error is rethrown so the build stops on it;
 *   - `{ sent: false, withheld: true }` (the barrier withholds the scope, or a pending attempt covers it) is returned
 *     as it is, the debt still owed;
 *   - every other error (pending, unconfirmed, create-completion-required on a drifted saved layer, and
 *     `managed-publication-reader-missing` — a covered family with no shared reader, a defect no rerun in the run heals)
 *     is rethrown, the scope blocked for the run.
 * Every managed dashboard publish goes through here, so a change of the publication contract touches one place.
 * Answers { sent, withheld, held, confirmed, code? }.
 */
async function publishDeclaredDashboard({ store, barrier, sdk, key, id, newToken } = {}) {
  const gate = barrier || store;
  const scope = scopeOf(id);
  try {
    const out = await publishManagedScope({
      store, barrier: gate, scope, groups: [{ family: KIND, key }], path: `declared dashboard "${key}"`, newToken,
      client: sdk.dataverse,
      publish: async () => {
        await sdk.fetchArtifact(KIND, scope.id);
        await sdk.publishArtifact(KIND, scope.id);
      },
    });
    return { ...out, held: false };
  } catch (err) {
    if (err && err.code === PUBLICATION_UNVERIFIED) {
      gate.blockScope(scope, `declared dashboard "${key}" (its saved and published layers could not be read)`);
      return { sent: false, withheld: true, held: true, confirmed: [], code: err.code };
    }
    // Fail closed on any other stop: a refusal, an unproved send or a drifted saved layer leaves nothing on this
    // dashboard shown safe to put live, so no later path in the run may publish it.
    gate.blockScope(scope, err && err.code === PUBLICATION_REFUSED
      ? `declared dashboard "${key}" (its publish named other targets and was refused)`
      : `declared dashboard "${key}" (its publish did not settle)`);
    throw err;
  }
}

module.exports = {
  KIND,
  TILE_KIND,
  PROOF_SCHEMA,
  OWNED_PARAMS,
  isDeclaredDashboard,
  dashboardKey,
  validateDeclaredDashboard,
  liveTile,
  layoutOf,
  seedInPlace,
  projectDashboard,
  committedProjectionInput,
  canonicalDeclaration,
  committedDeclaration,
  settleDeclaredDashboard,
  publishDeclaredDashboard,
};
