'use strict';
// The explicit managed download's restore of declared views (views[].reconcile "declared", createIdentity "stable-v1"): each view a
// committed view group of the build's binding store proves this app CREATED is written back into views[] as a declaration that
// rebuilds it exactly, and every other is named. Nothing here writes, binds or publishes.
//
// Why a view needs more than a proof check. A view group keeps no declaration (lib/creates-stable-build.js records the row, its
// projection baseline and its publication, not the spec it came from), so the declaration is INVERTED from the live row. An inverse
// that guessed would be worse than none: a rebuild of a guessed declaration rewrites the view. So the inverse is accepted only when
//   - the row is the one the store bound (exact id, the table it was built on), the build created it (origin "created"), its last
//     publish settled, and it is still exactly what the build proved (projection baseline, and saved layer = published layer);
//   - the view uses only what a declaration can say: a flat AND of conditions, `in`/`not-in` groups exactly as the compiler builds
//     them, joins one level deep with their own flat filters, and nothing in the lossless fetch bag the typed tree does not show
//     (an aggregate, a quick-find filter, a nested join, a multi-<value> condition, an order the sort list does not hold); and
//   - the declaration, compiled back (view-reconcile.js compileViewIntent), equals the row part for part, and the build's own
//     planner, given the store's binding, answers noChange for it: a rebuild from the downloaded spec sends nothing for this view.
//
// The shape it writes: the view's current table and name, `reconcile: "declared"`, every column with its width in order, every
// sort, every join, and `activeOnly: false` with EVERY observed condition listed, statecode eq 0 included. Writing the default
// active filter instead would be a guess about intent the row cannot prove. Option values are written as the numbers the service
// holds, never as labels: a number is not resolved again (sdk-build.js resolveFilterValue), so it cannot move to another option.
// `key` is written only when the store's key is not the default `<table>/<name>` one, so the build looks the binding up under the
// key it was made with. `viewId` pins the exact row: the download is a snapshot of this app in THIS environment (the store is too),
// and the pin keeps a rebuild from ever following a same-named row; in another environment the pin refuses rather than guesses.
const { normalizeGuid, projectionBaseline, canonicalJson } = require('./reconcile-common.js');
const { readManagedFormFile } = require('./declared-form-io.js');
const { readSavedQueryLayers } = require('./savedquery-published.js');
const { omission } = require('./managed-restore-report.js');
const viewReconcile = require('./view-reconcile.js');
const { compareVersions, isPluginVersion, CREATE_IDENTITY_MIN_VERSION } = require('./app-spec.js');

const FAMILY = 'view';
const SETTLED = new Set(['confirmed', 'not-needed']);
const lc = (v) => String(v == null ? '' : v).toLowerCase();
const isNotFound = (err) => !!err && (err.statusCode === 404 || err.status === 404);
// The keys of the SDK's typed view (types/view.ts) the inverse reads. A key outside these is something the typed layer shows that a
// declaration cannot say, so the view is not inverted.
const COLUMN_KEYS = new Set(['name', 'width', 'order', 'relatedEntity', 'sourceAttribute']);
const CONDITION_KEYS = new Set(['attribute', 'operator', 'value', 'entityname']);
const LINK_KEYS = new Set(['name', 'from', 'to', 'alias', 'linkType', 'filters']);
const SORT_KEYS = new Set(['attribute', 'descending', 'entityname']);
const onlyKeys = (o, allowed) => !!o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every((k) => allowed.has(k) || o[k] === undefined);

class Unsupported extends Error {}
const unsupported = (why) => { throw new Unsupported(why); };

// A condition value as the declaration writes it. An integer the service holds (an option value, a count) is written as a number:
// the build resolves only a STRING as an option label (sdk-build.js resolveFilterValue, lib/view-filter-labels.js), so a number
// compiles back to exactly this text. Anything else stays the text the service holds.
function valueOf(text) {
  if (typeof text !== 'string') unsupported('a condition value that is not text');
  return /^-?\d{1,15}$/.test(text) && String(Number(text)) === text ? Number(text) : text;
}

// One typed filter ({ type: 'and', conditions, groups }) as declaration filters, or Unsupported. A condition becomes
// { attr, op, value? , relatedEntity? }; a group becomes in/not-in only when it is exactly what compileConditions builds for one: an
// 'or' of eq (in) or an 'and' of ne (not-in) conditions on ONE attribute of ONE scope, with no nested group. Every other tree (an
// OR of different columns, a nested mix) is refused, never flattened. `scoped` says whether a condition may name a join.
function filtersOf(tree, { scoped }) {
  if (!tree || typeof tree !== 'object' || tree.type !== 'and') unsupported('a filter that is not a plain AND');
  if (!onlyKeys(tree, new Set(['type', 'conditions', 'groups']))) unsupported('a filter with parts the typed tree does not name');
  const out = [];
  const scopeOf = (c) => {
    const scope = c.entityname === undefined || c.entityname === '' ? undefined : lc(c.entityname);
    if (scope !== undefined && !scoped) unsupported('a join filter condition on another table');
    return scope;
  };
  for (const c of tree.conditions || []) {
    if (!onlyKeys(c, CONDITION_KEYS) || typeof c.attribute !== 'string' || typeof c.operator !== 'string') unsupported('a condition the typed tree does not name');
    if (c.operator === 'in' || c.operator === 'not-in') unsupported('a single-condition in/not-in');
    const f = { attr: lc(c.attribute), op: c.operator };
    if (c.value !== undefined) f.value = valueOf(c.value);
    const scope = scopeOf(c);
    if (scope !== undefined) f.relatedEntity = scope;
    out.push(f);
  }
  for (const g of tree.groups || []) {
    if (!g || (g.type !== 'or' && g.type !== 'and') || (g.groups || []).length || !(g.conditions || []).length) unsupported('a nested filter group');
    const sub = g.type === 'or' ? 'eq' : 'ne';
    const first = g.conditions[0];
    const scope = onlyKeys(first, CONDITION_KEYS) ? scopeOf(first) : undefined;
    for (const c of g.conditions) {
      if (!onlyKeys(c, CONDITION_KEYS) || c.operator !== sub || lc(c.attribute) !== lc(first.attribute) || c.value === undefined || scopeOf(c) !== scope) {
        unsupported('a filter group that is not one in/not-in list');
      }
    }
    const f = { attr: lc(first.attribute), op: g.type === 'or' ? 'in' : 'not-in', values: g.conditions.map((c) => valueOf(c.value)) };
    if (scope !== undefined) f.relatedEntity = scope;
    out.push(f);
  }
  return out;
}

const bagNodes = (node) => (node && Array.isArray(node.c) ? node.c.map((k) => (k && k.node ? k.node : k)).filter((n) => n && typeof n === 'object') : []);
const bagAttr = (node, name) => ((Array.isArray(node.a) ? node.a : []).find((p) => p[0] === name) || [])[1];
const countIn = (node, name) => bagNodes(node).reduce((s, k) => s + countIn(k, name), 0) + (node && node.n === name ? 1 : 0);
const typedCount = (g) => (g ? (g.conditions || []).length + (g.groups || []).reduce((s, x) => s + typedCount(x), 0) : 0);

// What the lossless fetch bag holds that the typed tree does not show: the fetch is { a, c: [{ i, node: { n: 'entity', a, c } }] },
// each node { n, a: [[name, value]], c }. A view whose query does more than its typed parts say is not inverted: the declaration
// would rebuild a different query in a new environment, and say nothing true about this one.
function bagIssue(view) {
  const bag = view.fetchBag;
  const entity = bagNodes(bag).find((n) => n.n === 'entity');
  if (!bag || !entity) return 'no readable query';
  if (lc(bagAttr(bag, 'aggregate')) === 'true' || lc(bagAttr(bag, 'distinct')) === 'true' || bagAttr(bag, 'top') !== undefined || bagAttr(bag, 'count') !== undefined) {
    return 'an aggregate, distinct or limited query';
  }
  const kids = bagNodes(entity);
  if (kids.some((n) => !['attribute', 'all-attributes', 'order', 'filter', 'link-entity'].includes(n.n))) return 'a query node the typed tree does not show';
  if (kids.some((n) => n.n === 'filter' && bagAttr(n, 'isquickfindfields') === '1')) return 'a quick-find filter';
  if (viewReconcile.hasUnrepresentableFilter(view)) return 'a filter the typed tree does not show';
  const links = kids.filter((n) => n.n === 'link-entity');
  const typedLinks = Array.isArray(view.linkEntities) ? view.linkEntities : [];
  if (links.length !== typedLinks.length) return 'a join the typed tree does not show';
  for (const link of links) {
    const inner = bagNodes(link);
    if (inner.some((n) => !['attribute', 'all-attributes', 'order', 'filter'].includes(n.n))) return 'a nested join or a join part the typed tree does not show';
    const ref = lc(bagAttr(link, 'alias') || bagAttr(link, 'name'));
    const typed = typedLinks.find((l) => lc(l.alias || l.name) === ref);
    const filters = inner.filter((n) => n.n === 'filter');
    if (!typed || filters.reduce((s, f) => s + countIn(f, 'condition'), 0) !== typedCount(typed.filters)) return 'a join filter the typed tree does not show';
    if (filters.some((f) => countIn(f, 'link-entity') || countIn(f, 'value'))) return 'a join filter the typed tree does not show';
  }
  if (countIn(entity, 'order') !== (view.sort || []).length) return 'an order the sort list does not show';
  return null;
}

/**
 * The declaration that rebuilds `view` (a typed view the SDK read, types/view.ts) under the store key `key`, or { unsupported: why }.
 * Pure: it reads only `view`. See the header for the shape and what is refused. Whether the declaration REALLY rebuilds the view is
 * not decided here: restoreManagedViews compiles it back and asks the planner.
 */
function viewDeclarationFromLive(view, { key } = {}) {
  try {
    if (!view || typeof view !== 'object' || typeof view.entityLogicalName !== 'string' || typeof view.name !== 'string' || !view.name.trim()) unsupported('no table or name');
    if (view.queryType !== 0) unsupported('not a public view (queryType is not 0)');
    if (viewReconcile.hasUnboundRelatedColumn(view)) unsupported('a joined-table column read back without its join');
    const issue = bagIssue(view);
    if (issue) unsupported(issue);
    const entity = lc(view.entityLogicalName);
    const declaration = { entity, name: view.name, reconcile: 'declared' };
    if (typeof key === 'string' && key && key !== `${entity}/${view.name}`) declaration.key = key;
    const columns = (view.columns || []).slice();
    if (!columns.length) unsupported('no columns');
    if (columns.some((c) => !onlyKeys(c, COLUMN_KEYS) || typeof c.name !== 'string' || !Number.isInteger(c.width) || c.width < 0 || typeof c.order !== 'number')) {
      unsupported('a column the declaration cannot say');
    }
    declaration.columns = columns.sort((a, b) => a.order - b.order).map((c) => {
      const o = { name: lc(c.name) };
      if (c.relatedEntity) {
        o.relatedEntity = lc(c.relatedEntity);
        const source = lc(c.sourceAttribute || '');
        if (source && source !== o.name.split('.').pop()) o.sourceAttribute = source;
      }
      o.width = c.width;
      return o;
    });
    if (typeof view.description === 'string' && view.description.trim()) declaration.description = view.description;
    const sort = (view.sort || []).map((s) => {
      if (!onlyKeys(s, SORT_KEYS) || typeof s.attribute !== 'string') unsupported('a sort the declaration cannot say');
      const o = { attr: lc(s.attribute) };
      if (s.descending) o.dir = 'desc';
      if (s.entityname) o.relatedEntity = lc(s.entityname);
      return o;
    });
    if (sort.length) declaration.sort = sort;
    // Every observed condition, the active filter too: activeOnly false says the list below is the whole filter.
    declaration.activeOnly = false;
    const filters = filtersOf(view.filters || { type: 'and', conditions: [], groups: [] }, { scoped: true });
    if (filters.length) declaration.filters = filters;
    const links = (view.linkEntities || []).map((l) => {
      if (!onlyKeys(l, LINK_KEYS)) unsupported('a join part the declaration cannot say');
      const o = { name: lc(l.name), from: lc(l.from), to: lc(l.to) };
      if (l.alias) o.alias = lc(l.alias);
      if (l.linkType) o.linkType = l.linkType;
      if (l.filters) {
        const f = filtersOf(l.filters, { scoped: false });
        if (f.length) o.filters = f;
      }
      return o;
    });
    if (links.length) declaration.linkEntities = links;
    return { declaration };
  } catch (e) {
    if (e instanceof Unsupported) return { unsupported: e.message };
    throw e;
  }
}

// The primary name column of `table` as the build would default a view's columns to it (sdk-build.js primaryNameOf).
function primaryNameOf(spec, table) {
  const e = ((spec && spec.entities) || []).find((x) => x && lc(x.schemaName) === table);
  return e && e.primaryAttribute && e.primaryAttribute.schemaName ? lc(e.primaryAttribute.schemaName) : `${table}name`;
}

// Option values are written as numbers (valueOf), and a number is never resolved again, so the compile here keeps every value as
// it is, as the build's resolver does for a number.
const keepValue = (_t, _a, x) => x;

// createIdentity's plugin floor, keeping a higher one the spec already names (the rule of app-components.js setAppThemeFloor).
const floorOf = (current) => (isPluginVersion(current) && compareVersions(current, CREATE_IDENTITY_MIN_VERSION) > 0 ? current : CREATE_IDENTITY_MIN_VERSION);

/**
 * The explicit managed download's restore of declared views (--include-managed --managed-manifest <file>). For each committed view
 * group of the store file, in key order, the view is restored into `spec.views` (mutated) only when every check of the header holds
 * and the downloaded spec still validates with it (`validate`, the download's own validator); a restored view also restores the
 * spec's `createIdentity: "stable-v1"` (only a stable build keeps view groups, so the store itself is the proof of the regime) with
 * its plugin floor. Every other group is answered as an omission (lib/managed-restore-report.js) with a fixed reason, never
 * silently dropped. Answers { restored: [{ key, id }], omitted: [omission] }; a store file that cannot be used throws
 * `managed-manifest-unusable` (readManagedFormFile).
 */
async function restoreManagedViews({ sdk, spec, file, environment, appUniqueName, solutionUniqueName, validate }) {
  const { groups, pending, invalid } = readManagedFormFile({ file, environment, appUniqueName, solutionUniqueName }, FAMILY);
  const restored = [];
  const omitted = [
    ...pending.map((p) => omission({ kind: 'view', key: p.key, code: 'pending' })),
    ...invalid.map((p) => omission({ kind: 'view', key: p.key, code: 'invalid' })),
  ];
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key);
    const id = normalizeGuid(group.root && group.root.id);
    const left = (code, name) => omitted.push(omission({ kind: 'view', id, key, name, code }));
    const record = id ? (group.records || []).find((r) => r && r.kind === FAMILY && normalizeGuid(r.id) === id) : null;
    if (!record) { left('invalid'); continue; }
    if (record.origin !== 'created') { left('not-created'); continue; }
    const publication = group.publication || {};
    if (!SETTLED.has(publication.state)) { left('publication-unsettled'); continue; }
    let art;
    try {
      await sdk.fetchArtifact('view', id, { overwrite: true });
      art = await sdk.getArtifact('view', id);
    } catch (e) {
      left(isNotFound(e) ? 'missing' : 'unread');
      continue;
    }
    if (!art || typeof art !== 'object') { left('missing'); continue; }
    const name = typeof art.name === 'string' ? art.name : undefined;
    const table = lc(publication.scope && publication.scope.table);
    if (normalizeGuid(art.id) !== id || !table || lc(art.entityLogicalName) !== table) { left('wrong-table', name); continue; }
    const live = viewReconcile.liveFull(art);
    const observed = projectionBaseline(live).intentSha256;
    const baseline = group.consumerState && group.consumerState.baseline;
    if (observed !== record.intentSha256 || (baseline && baseline.intentSha256 !== observed)) { left('changed', name); continue; }
    let layers;
    try {
      layers = await readSavedQueryLayers(FAMILY, sdk.dataverse, group);
    } catch {
      left('unread', name);
      continue;
    }
    if (layers.savedSha256 !== layers.publishedSha256) { left('unpublished-changes', name); continue; }
    if (publication.state === 'confirmed' && publication.desiredSha256 && publication.desiredSha256 !== layers.savedSha256) { left('changed', name); continue; }
    const inverse = viewDeclarationFromLive(art, { key });
    if (!inverse.declaration) { left('unsupported', name); continue; }
    const declaration = { ...inverse.declaration, viewId: id };
    if (viewReconcile.declaredViewKey(declaration) !== key) { left('key-mismatch', name); continue; }
    const primaryName = primaryNameOf(spec, table);
    const { errors, intent } = viewReconcile.compileViewIntent(declaration, { resolveValue: keepValue, primaryName });
    const desired = intent && viewReconcile.desiredFull(intent, live);
    if (errors.length || !desired || viewReconcile.PARTS.some((p) => canonicalJson(desired[p]) !== canonicalJson(live[p]))) { left('not-equivalent', name); continue; }
    // The build's own planner, given exactly the binding the store holds: a rebuild must answer noChange, bind as it is, and send
    // nothing. GET only (view-reconcile.js planViewReconcile).
    let plan;
    try {
      plan = await viewReconcile.planViewReconcile({ view: declaration, sdk, resolveValue: keepValue, primaryName }, {
        managed: { lookup: async (kind, k) => (kind === FAMILY && k === key ? record : null) },
      });
    } catch {
      left('unread', name);
      continue;
    }
    if (plan.action !== 'noChange' || !plan.bindUnchanged || plan.refused.length || plan.unknown.length || normalizeGuid(plan.viewId) !== id) { left('would-change', name); continue; }
    const views = Array.isArray(spec.views) ? spec.views : [];
    const at = views.findIndex((v) => v && lc(v.entity) === table && v.name === declaration.name);
    const next = at >= 0 ? views.map((v, i) => (i === at ? declaration : v)) : [...views, declaration];
    const candidate = { ...spec, views: next, createIdentity: 'stable-v1', minimumPluginVersion: floorOf(spec.minimumPluginVersion) };
    const check = validate(candidate);
    if (!check || !check.ok) { left('invalid-in-spec', name); continue; }
    spec.views = next;
    spec.createIdentity = candidate.createIdentity;
    spec.minimumPluginVersion = candidate.minimumPluginVersion;
    restored.push({ key, id });
  }
  return { restored, omitted };
}

module.exports = { restoreManagedViews, viewDeclarationFromLive };
