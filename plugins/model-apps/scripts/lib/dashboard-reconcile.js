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
// record per declared tile commit together, or not at all. A root-only binding is never written. Before any write the
// whole dashboard is checked, and any of these stops it with its code (the build's halt; nothing is sent):
//   * the creation record of this dashboard is not settled (`dashboard-creation-record-unsettled`): its ids are held
//     for the run, so no dashboard publish and no app publish ships them;
//   * a table-scoped or non-Standard row, two tiles pinned to one control, one control on two live cells, a bound or
//     pinned tile whose control is gone (never re-added), a type change, an unresolved target, drift without approval;
//   * a published layer that cannot be read, or a workspace copy holding edits the server has not seen (no overwrite
//     bypass: such a copy is a maker's unsent work, or another path's, and a fetch with overwrite would drop it).
//
// Proof (proofSchema `dashboard-v1`): the expected proof persisted before the send names every managed tile's control
// id with the association of its type, cell, section and tab, and the sha256 of the INTENDED projection: the root's
// type, scope and description, and each managed tile's key, id, type, containers and full ownable parts. A fresh read
// must reproduce it exactly. Preservation is proven over the FOREIGN tiles (every control the declaration does not
// own), whole, so a run that stopped after the service accepted its change cannot bind or publish what someone changed
// on the dashboard since: recovery recomputes both hashes from a fresh read and the expected proof alone.
//
// Publication goes through ONE adapter (publishDeclaredDashboard) over publishManagedScope: one permit, one scope, the
// dashboard's own id in a `<dashboard>` envelope. A layer read that fails there is a hold for the run, never a retry.
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
const { runManagedFeature, publishManagedScope, CREATION_RECORD_UNSETTLED, PUBLICATION_UNVERIFIED } = contract;
// The send boundary's refusal of a request that names other publish targets than its permit's one scope. Older
// contracts never answer it; the literal keeps this adapter working on both.
const PUBLICATION_REFUSED = contract.PUBLICATION_REFUSED || 'managed-publication-refused';
const { readSystemFormPublication } = require('./systemform-published.js');

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
 * The hash of a dashboard's managed projection: the root's type, scope and description, and every managed tile —
 * key, control id, type, containers and full ownable parts — in key order. Built from the INTENDED state before the
 * send, and from a fresh read in the proof; the two must be equal.
 */
function projectionSha256(root, tiles) {
  const sorted = [...tiles].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return sha({ root, tiles: sorted });
}

/**
 * The hash of everything the declaration does NOT own: each foreign component whole — its id, type, name, spans,
 * every parameter and its cell bag — in id order. A component's `position` is left out: it is an index the SDK
 * assigns on read, and an append after the occupied layout moves no foreign cell.
 */
function preservationSha256(components, managedIds) {
  const foreign = (components || [])
    .filter((c) => !managedIds.has(bareId(c.id)))
    .map((c) => ({ id: bareId(c.id), type: c.type, name: c.name === undefined ? null : c.name, colspan: c.colspan === undefined ? null : c.colspan, rowspan: c.rowspan === undefined ? null : c.rowspan, parameters: c.parameters || {}, bag: c.bag || null }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return sha(foreign);
}

/** The hash a publication debt is kept in: name, description and formxml of one systemform layer. */
function layerSha256(row) {
  return sha({ name: row.name, description: row.description, formxml: row.formxml });
}

const rootProjection = (description) => ({ dashboardType: 'Standard', global: true, description: String(description == null ? '' : description) });

/** Read a dashboard by exact id from the service (never the workspace copy); throws what the read threw. */
async function readDashboard(sdk, id) {
  await sdk.fetchArtifact(KIND, id, { overwrite: true });
  return (await sdk.getArtifact(KIND, id)) || null;
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
 * Read and preflight one declared dashboard: GET only, and every refusal is a coded throw before any write.
 * Answers the resolution plan() turns into the expected proof.
 */
async function resolveDashboard(s, committed, pending) {
  const { dashboard, key, sdk, catalog, approvals } = s;
  // The creation guard runs first, inside the managed run (after registerKnown): a retained creation record names a
  // dashboard id this build may have created and not settled, and runManagedFeature quarantines every known id of a
  // stop with this code, so neither a dashboard publish nor an app publish ships it.
  if (s.retainedCreationIds.length) throw stop(CREATION_RECORD_UNSETTLED, `the creation record of dashboard "${key}" is not settled; it is not written or published in this run`);
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

  // A copy holding edits the server has not seen is someone's unsent work: the overwrite fetch below would drop it.
  if (await hasUnsyncedEdits(sdk, KIND, id)) throw stop('workspace-copy-unsent-edits', `the workspace copy of dashboard "${key}" holds edits that were never sent; push or discard them before the build reconciles it`);

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
  const adoptable = !!committed || source === 'pinned' || isApproved(approvals.adopt, KIND, key);
  if (!refusals.length && writes && !adoptable) refuse(key, 'dashboard-adoption-not-authorized', 'the dashboard exists and is not yet managed by this spec; approve adopting it first');
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

/** The expected proof of a resolution, persisted before the send; null when nothing is to be sent or bound. */
function planDashboard(s, resolution, committed) {
  const r = resolution;
  const managedIds = new Set(r.entries.map((e) => e.controlId));
  const savedSha = r.create ? null : layerSha256(r.pub.saved);
  if (!r.create && r.writes === 0) {
    if (!r.adoptable) return { noop: true };
    const recorded = committed && r.entries.every((e) => e.record && e.record.intentSha256 === projectionBaseline(e.liveParts).intentSha256);
    const rootRec = committed && committed.records.find((x) => x.kind === KIND && x.key === s.key);
    const rootSame = !!rootRec && rootRec.intentSha256 === projectionBaseline({ description: r.desiredRoot.description }).intentSha256;
    const owes = committed && committed.publication && committed.publication.state === 'owed';
    // A true no-op: the committed group already says what is there, and nothing new must be published. Otherwise the
    // group is (re)bound without a content write, its publication owed when the saved layer is not live.
    if (!r.pending && recorded && rootSame && committed.proof.savedSha256 === savedSha && (r.pub.state === 'equal' || owes)) return { noop: true };
  }
  const tiles = r.entries.map((e) => ({ key: e.tileKey, id: e.controlId, type: e.component.type, cell: e.place.cell, section: e.place.section, tab: e.place.tab, parts: e.desired }));
  const children = r.entries.map((e) => ({ kind: TILE_KIND, key: e.tileKey, namespaceParentId: r.id, id: e.controlId, associationSha256: associationOf(e.tileKey, e.component.type, e.place) }));
  const expected = {
    proofVersion: 1,
    proofSchema: PROOF_SCHEMA,
    rootId: r.id,
    baseProofSha256: committed ? committed.proof.semanticSha256 : null,
    sentProjectionSha256: projectionSha256(rootProjection(r.desiredRoot.description), tiles),
    preservationSha256: preservationSha256(r.create ? [] : r.live.components, managedIds),
    baseObservation: r.create ? null : { rowVersion: null, savedSha256: savedSha },
    children,
  };
  return {
    root: { kind: KIND, key: s.key, id: r.id },
    expected,
    declarationSha256: sha({ name: s.dashboard.name, description: s.dashboard.description === undefined ? null : s.dashboard.description, tiles: s.dashboard.tiles }),
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
 * in their roles; the managed projection exactly the one sent; the foreign tiles exactly as before.
 */
async function proveDashboard(s, expected, applied) {
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
  const components = art.components || [];
  const layout = layoutOf(art.bag);
  const missing = [];
  const mismatch = [];
  const tiles = [];
  const found = [];
  for (const child of expected.children) {
    const hits = components.filter((c) => bareId(c.id) === child.id);
    if (hits.length !== 1) { (hits.length ? mismatch : missing).push(child.key); continue; }
    const place = placeOf(hits[0], layout);
    if (associationOf(child.key, hits[0].type, place) !== child.associationSha256) { mismatch.push(child.key); continue; }
    const parts = liveTile(hits[0], hits[0].type);
    tiles.push({ key: child.key, id: child.id, type: hits[0].type, ...place, parts });
    found.push({ child, parts, place, type: hits[0].type });
  }
  const created = expected.baseObservation === null;
  let seedIds = [];
  if (created) {
    const { childIds } = s.catalog.reserveChildren(KIND, key, { actualRootId: id, children: SEED_CHILDREN });
    seedIds = [childIds[SEED_TAB], childIds[SEED_SECTION]];
    if (!seedInPlace(layout, { tab: seedIds[0], section: seedIds[1] })) missing.push(key);
  }
  if (missing.length) throw stop('create-completion-required', `a part of dashboard "${key}" is not on the stored dashboard (${missing.join(', ')}); complete or remove it in Maker, then run again`);
  if (mismatch.length) throw stop('dashboard-stored-mismatch', `the stored dashboard "${key}" does not hold what was written (${mismatch.join(', ')}); check the dashboard`);
  const semantic = projectionSha256(rootProjection(art.description), tiles);
  const preserved = preservationSha256(components, new Set(expected.children.map((c) => c.id)));
  // What is stored now is not what was sent, or a tile the spec does not own changed: binding or publishing it would
  // claim content this build never wrote — after a crash, someone's edit made since.
  if (semantic !== expected.sentProjectionSha256 || preserved !== expected.preservationSha256) {
    throw stop('create-completion-required', `the stored dashboard "${key}" is not the one this build sent; it was not bound or published`);
  }

  const { committed } = store.readGroup(KIND, key);
  const prior = (kind, k) => (committed ? committed.records.find((x) => x.kind === kind && x.key === k) : null);
  // A record this group does not hold yet claims `created` only on this run's acknowledged write; a recovered one
  // (a lost answer) is adopted, as the store requires.
  const originOf = (kind, k, createdNow) => {
    const old = prior(kind, k);
    if (old) return old.origin;
    return applied && createdNow ? 'created' : 'adopted';
  };
  const record = (kind, k, rid, parts, extra) => ({
    formatVersion: 1, appUniqueName: s.ctx.appUniqueName, environmentFingerprint: s.ctx.environmentFingerprint,
    kind, key: k, id: rid, ...projectionBaseline(parts), ...extra,
  });
  const createdTiles = new Set((applied && applied.createdTiles) || []);
  const records = [
    ...found.map(({ child, parts }) => record(TILE_KIND, child.key, child.id, parts, { origin: originOf(TILE_KIND, child.key, createdTiles.has(child.key)), parentKey: key })),
    record(KIND, key, id, { description: String(art.description == null ? '' : art.description) }, { origin: originOf(KIND, key, !!(applied && applied.createdRoot)) }),
  ];
  const savedSha = layerSha256(pub.saved);
  const scope = scopeOf(id);
  return {
    savedProof: { savedSha256: savedSha },
    acknowledgedRoot: true,
    records,
    proof: { savedSha256: savedSha, semanticSha256: semantic, preservationSha256: preserved, expectedChildrenSha256: expected.children.length ? sha(expected.children) : null },
    consumerState: {
      declaration: { key, scopeType: 'Standard', tiles: expected.children.map((c) => c.key) },
      tiles: Object.fromEntries(found.map(({ child, place, type }) => [child.key, { id: child.id, type, cell: place.cell, section: place.section, tab: place.tab }])),
      seedIds,
    },
    publication: pub.state === 'equal'
      ? { scope, state: 'not-needed', desiredSha256: null, dispatchToken: null }
      : { scope, state: 'owed', desiredSha256: savedSha, dispatchToken: null },
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
 *   retainedCreationIds  the ids the dashboard creation record (dashboard-creation-records.js) still retains for this
 *                        dashboard: any of them stops it with `dashboard-creation-record-unsettled`;
 *   resolvedId           the id the build found by name for an unbound dashboard, or none;
 *   approvals            { adopt, overwrite, destructive }: the --authorize sets, keyed `dashboard:<key>` (and
 *                        `dashboard:<key>/<tile>` for a tile's overwrite);
 *   ensureMembership     solution membership of the root ({ root, records, recovering });
 *   ctx                  { appUniqueName, environmentFingerprint } the records are written for.
 * Answers runManagedFeature's { result, committedGroup } plus { key, id }. Every failure throws the build's halt, and
 * every id this dashboard is known by stays quarantined for the run (no dashboard publish, no app publish of it).
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
  };
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
      resolve: async ({ committed, pending }) => {
        if (!catalog || typeof catalog.identityFor !== 'function') throw stop('dashboard-spec-invalid', `${label} has no create catalog`);
        resolution = await resolveDashboard(s, committed, pending);
        id = resolution.id;
        return resolution;
      },
      plan: async ({ resolution: r, committed }) => planDashboard(s, r, committed),
      apply: async ({ resolution: r }) => applyDashboard(s, r),
      prove: async ({ expected, applied }) => { id = expected.rootId; return proveDashboard(s, expected, applied); },
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
 * The layer reader of the `dashboard` family, and of no other: `(group) => { savedSha256, publishedSha256 }` from a fresh
 * read of both layers of the group's root row, hashed as its `publication.desiredSha256` was (layerSha256; a row never
 * published reads as sha256(null)). publishManagedScope asks it for every committed group the scope covers. A group of
 * another family is not read here: the throw makes the publish `managed-publication-unverified`, so the scope is
 * fenced, never published past a group nothing proved. Readers for other families belong to their own features.
 */
function dashboardLayerReader(sdk) {
  return async (group) => {
    if (!group || group.family !== KIND) {
      throw Object.assign(new Error(`no dashboard layer reader for managed ${group && group.family} "${group && group.key}"`), { code: PUBLICATION_UNVERIFIED });
    }
    const read = await readSystemFormPublication(sdk.dataverse, group.root.id);
    return { savedSha256: layerSha256(read.saved), publishedSha256: read.published ? layerSha256(read.published) : sha(null) };
  };
}

/**
 * THE one path a declared dashboard's publication takes: publishManagedScope with exactly one scope — this
 * dashboard's own id — and one group, published by the SDK's `<dashboard>` envelope:
 *   POST PublishXml {"ParameterXml":"<importexportxml><dashboards><dashboard>ID</dashboard></dashboards></importexportxml>"}
 * The pre-send check covers this group whatever its state; no sibling is filtered or skipped here. Outcomes:
 *   - `managed-publication-unverified` (a layer read failed before the send) is a HOLD: the scope is blocked for the
 *     rest of the run and the answer says `held`; it is never retried in the run;
 *   - `managed-publication-refused` (the request named other targets than this dashboard) is a REFUSAL: nothing was
 *     sent, the scope is blocked for the run, and the error is rethrown so the build stops on it;
 *   - `{ sent: false, withheld: true }` (the barrier withholds the scope, or a pending attempt covers it) is returned
 *     as it is, the debt still owed;
 *   - every other error (pending, unconfirmed, create-completion-required on a drifted saved layer) is rethrown, the
 *     scope blocked for the run.
 * Every managed dashboard publish goes through here, so a change of the publication contract touches one place.
 * Answers { sent, withheld, held, confirmed, code? }.
 */
async function publishDeclaredDashboard({ store, barrier, sdk, key, id, newToken } = {}) {
  const gate = barrier || store;
  const scope = scopeOf(id);
  try {
    const out = await publishManagedScope({
      store, barrier: gate, scope, groups: [{ family: KIND, key }], path: `declared dashboard "${key}"`, newToken,
      readLayers: dashboardLayerReader(sdk),
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
  layerSha256,
  settleDeclaredDashboard,
  publishDeclaredDashboard,
};
