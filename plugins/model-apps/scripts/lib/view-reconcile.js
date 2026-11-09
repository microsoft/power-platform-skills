'use strict';
// Declared view reconciliation — `views[].reconcile: "declared"`.
//
// The legacy path (sdk-build reconcileView) only UNIONS new columns into an existing view and
// warns that authored filters and sort are not reapplied. A declared view instead converges the
// authored parts of the view to the spec:
//   * columns, in the declared order (a column may come from a joined table);
//   * the base filter (with `activeOnly`, as viewDef builds it) and filters on joined tables;
//   * sort, including sort on a joined table;
//   * joins — `linkEntities: [{ name, from, to, alias?, linkType?, filters? }]`;
//   * the description, when the spec sets one.
// Everything else round-trips through the SDK's lossless bags (types/view.ts `fetchBag`/
// `layoutBag`): per-cell attributes, link-entity options, the Quick Find filter, undeclared joins.
//
// Two things the typed layer cannot carry are REFUSED rather than written over:
//   * a base filter the typed tree cannot represent (multi-<value> `in` conditions, a link-entity
//     inside a filter). MEASURED on the bundle: such a view reads back with an EMPTY typed filter,
//     and writing a typed filter then emits a SECOND <filter> beside the untouched original — the
//     view would AND both instead of replacing the old one, so the edit is refused;
//   * a live joined-table column the bundle reads back without its join (a layout cell
//     `acct.name` whose <attribute> carries no alias). MEASURED: any columns write re-emits such
//     a cell as `<attribute name="acct.name" />` on the BASE table — an attribute that does not
//     exist — so a declared columns change on that view is refused.
//
// Identity: an existing managed binding is the authority — a bound view is edited by its bound id
// and nothing else (a same-name replacement is never followed; a pin that names another view is a
// conflict to repair). Unbound, an optional `viewId` (environment-bound edit pin), else the exact
// name on the table (the SDK refuses an ambiguous name). A view no binding owns is shown as an
// adoption and needs approval before its first write; a bound view whose owned parts were changed
// elsewhere (drift) is refused until the spec is refreshed or the overwrite is approved. A no-op
// sends nothing.
//
// The baseline a binding records is the FULL ownable projection (all columns, filters, sort, every
// join, the description) — not only the parts the spec declares today — so starting or stopping to
// declare a join or a description is an edit, never drift. Drift is judged on the parts this run
// writes (reconcile-common partsDriftVerdict).
//
// A new declared view is created here, through the creation port (ctx.creates.run), under the id the
// port allocated for this create, and its binding records the baseline of what was created.
//
// The apply records the publish it needs in `pendingPublish`; the publish is queued only once the
// whole result has settled with no refusal and no unknown (commitPublication).

const {
  emptyResult,
  operation,
  refusal,
  readFailure,
  isAuthorized,
  approvalKey,
  isApproved,
  lookupBinding,
  bindingRecord,
  bindsUnchanged,
  canonicalJson,
  pushIfChanged,
  commitPublication,
  normalizeGuid,
  rulesOf,
  projectionBaseline,
  partsDriftVerdict,
  boundIdentity,
  createThroughPort,
  pushChecked,
} = require('./reconcile-common.js');

const NAME_RE = /^[a-z_][a-z0-9_]{0,127}$/i;
const LINK_TYPES = new Set(['inner', 'outer']);

/** True when a view spec opted into declared reconciliation; anything else keeps the legacy union path. */
function isDeclaredView(v) {
  return !!v && v.reconcile === 'declared';
}

/**
 * The plan key of a declared view that compiles: its authored `key`, else `<table>/<name>`. The one rule, shared by the
 * planner and by the stable create catalog (creates-stable-build.js), so a create is always looked up under the key it
 * was reserved for.
 */
function declaredViewKey(v) {
  return typeof v.key === 'string' && v.key ? v.key : `${String(v.entity).toLowerCase()}/${v.name}`;
}

const lc = (s) => String(s).toLowerCase();
const refNameOf = (link) => lc(link.alias || link.name);

function compileConditions(list, { at, entity, refs, resolveValue, errors }) {
  const conditions = [];
  const groups = [];
  (list || []).forEach((f, i) => {
    if (!f || typeof f !== 'object' || typeof f.attr !== 'string' || !NAME_RE.test(f.attr)) {
      errors.push({ path: `${at}[${i}]`, message: 'a filter needs attr (a column logical name)' });
      return;
    }
    const scope = f.relatedEntity === undefined ? undefined : lc(f.relatedEntity);
    if (scope !== undefined && (!refs || !refs.has(scope))) {
      errors.push({ path: `${at}[${i}].relatedEntity`, message: `'${f.relatedEntity}' is not the alias or name of a declared join` });
      return;
    }
    // A condition on a joined table resolves its choice labels on THAT table: `statecode: 'Open'` on
    // a joined contact is contact's option set, not the view's own table's.
    const table = scope !== undefined ? refs.get(scope) : entity;
    const attr = lc(f.attr);
    const op = f.op || 'eq';
    const scoped = (c) => (scope ? { ...c, entityname: scope } : c);
    if (op === 'in' || op === 'not-in') {
      if (!Array.isArray(f.values) || f.values.length === 0) {
        errors.push({ path: `${at}[${i}].values`, message: `'${op}' needs a non-empty values list` });
        return;
      }
      // As viewDef builds it: the SDK's typed condition is single-valued, so in/not-in become a
      // nested or/and group of eq/ne conditions.
      const subOp = op === 'in' ? 'eq' : 'ne';
      groups.push({ type: op === 'in' ? 'or' : 'and', conditions: f.values.map((x) => scoped({ attribute: attr, operator: subOp, value: String(resolveValue(table, attr, x)) })), groups: [] });
      return;
    }
    const cond = { attribute: attr, operator: op };
    if (f.value !== undefined) cond.value = String(resolveValue(table, attr, f.value));
    conditions.push(scoped(cond));
  });
  return { conditions, groups };
}

/**
 * Compile a declared view spec into the typed parts it owns. Pure.
 * @param {object} v  the App Spec view
 * @param {object} [o] { primaryName, resolveValue(entity, attr, value) } — resolveValue maps an option
 *                     label to its value as viewDef's resolveFilterValue does; default is String.
 * @returns {{ errors: Array<{path,message}>, intent: object|null }}
 */
function compileViewIntent(v, o = {}) {
  const errors = [];
  const at = 'views[]';
  const resolveValue = typeof o.resolveValue === 'function' ? o.resolveValue : (_e, _a, x) => x;
  if (!v || typeof v.entity !== 'string' || typeof v.name !== 'string') {
    return { errors: [{ path: at, message: 'a view needs entity and name' }], intent: null };
  }
  const entity = lc(v.entity);
  if (v.viewId !== undefined && !normalizeGuid(v.viewId)) errors.push({ path: `${at}.viewId`, message: 'viewId must be a GUID' });

  const links = [];
  const refs = new Map(); // alias-or-name -> joined table logical name
  (v.linkEntities || []).forEach((l, i) => {
    const p = `${at}.linkEntities[${i}]`;
    if (!l || typeof l !== 'object') { errors.push({ path: p, message: 'a join must be an object' }); return; }
    for (const k of ['name', 'from', 'to']) {
      if (typeof l[k] !== 'string' || !NAME_RE.test(l[k])) errors.push({ path: `${p}.${k}`, message: `${k} must be a logical name` });
    }
    if (l.alias !== undefined && (typeof l.alias !== 'string' || !NAME_RE.test(l.alias))) errors.push({ path: `${p}.alias`, message: 'alias must be a simple name' });
    if (l.linkType !== undefined && !LINK_TYPES.has(l.linkType)) errors.push({ path: `${p}.linkType`, message: 'linkType must be inner or outer' });
    if (typeof l.name !== 'string') return;
    const ref = refNameOf(l);
    if (refs.has(ref)) errors.push({ path: `${p}.alias`, message: `two joins are both called '${ref}'; give each its own alias` });
    refs.set(ref, lc(l.name));
    const link = { name: lc(l.name), from: lc(l.from || ''), to: lc(l.to || '') };
    if (l.alias) link.alias = lc(l.alias);
    if (l.linkType) link.linkType = l.linkType;
    if (l.filters !== undefined) {
      const c = compileConditions(l.filters, { at: `${p}.filters`, entity: link.name, refs: null, resolveValue, errors });
      link.filters = { type: 'and', conditions: c.conditions, groups: c.groups };
    }
    links.push(link);
  });

  const columns = [];
  const seenCols = new Set();
  const declaredCols = v.columns && v.columns.length ? v.columns : (o.primaryName ? [o.primaryName] : []);
  declaredCols.forEach((c, i) => {
    const p = `${at}.columns[${i}]`;
    const col = typeof c === 'string' ? { name: c } : c;
    if (!col || typeof col.name !== 'string' || !/^[a-z_][a-z0-9_.]{0,255}$/i.test(col.name)) {
      errors.push({ path: p, message: 'a column needs a logical name' });
      return;
    }
    const out = {};
    if (col.relatedEntity !== undefined) {
      const scope = lc(col.relatedEntity);
      if (!refs.has(scope)) { errors.push({ path: `${p}.relatedEntity`, message: `'${col.relatedEntity}' is not the alias or name of a declared join` }); return; }
      const source = lc(col.sourceAttribute || col.name.split('.').pop());
      out.name = col.name.includes('.') ? lc(col.name) : `${scope}.${source}`;
      out.relatedEntity = scope;
      out.sourceAttribute = source;
    } else {
      if (col.name.includes('.')) { errors.push({ path: `${p}.relatedEntity`, message: 'a joined-table column must name its join in relatedEntity' }); return; }
      out.name = lc(col.name);
    }
    if (col.width !== undefined) {
      if (!Number.isInteger(col.width) || col.width < 0) { errors.push({ path: `${p}.width`, message: 'width must be a whole number of pixels' }); return; }
      out.width = col.width;
    }
    if (seenCols.has(out.name)) { errors.push({ path: p, message: `column '${out.name}' is listed twice` }); return; }
    seenCols.add(out.name);
    columns.push(out);
  });

  const base = compileConditions(v.filters, { at: `${at}.filters`, entity, refs, resolveValue, errors });
  if (v.activeOnly !== false) base.conditions.unshift({ attribute: 'statecode', operator: 'eq', value: '0' });
  const sort = [];
  (v.sort || []).forEach((s, i) => {
    if (!s || typeof s.attr !== 'string' || !NAME_RE.test(s.attr)) { errors.push({ path: `${at}.sort[${i}]`, message: 'a sort needs attr' }); return; }
    const scope = s.relatedEntity === undefined ? '' : lc(s.relatedEntity);
    if (scope && !refs.has(scope)) { errors.push({ path: `${at}.sort[${i}].relatedEntity`, message: `'${s.relatedEntity}' is not the alias or name of a declared join` }); return; }
    // '' is EXPLICITLY the view's own table (types/view.ts SortExpression.entityname): a declared
    // sort without a join must not inherit the scope an old <order> had.
    sort.push({ attribute: lc(s.attr), descending: s.dir === 'desc', entityname: scope });
  });

  const intent = {
    key: declaredViewKey(v),
    entity,
    name: v.name,
    viewId: v.viewId !== undefined ? normalizeGuid(v.viewId) : '',
    columns,
    filters: { type: 'and', conditions: base.conditions, groups: base.groups },
    sort,
    linkEntities: links,
    description: typeof v.description === 'string' && v.description.trim() ? v.description.trim() : undefined,
  };
  return { errors, intent: errors.length ? null : intent };
}

/** The ViewArtifact (without id) a NEW declared view is created from — viewDef plus joins. */
function viewCreateArtifact(intent) {
  return {
    name: intent.name,
    description: intent.description || '',
    entityLogicalName: intent.entity,
    queryType: 0,
    isDefault: false,
    columns: intent.columns.map((c, i) => ({ ...c, width: c.width === undefined ? 100 : c.width, order: i })),
    filters: intent.filters,
    sort: intent.sort,
    linkEntities: intent.linkEntities,
  };
}

// --- the live side ---------------------------------------------------------------------------

/** Count the <condition> nodes under a HybridBag node, recursively. Bag nodes are { n, a, c }. */
function countConditions(node) {
  if (!node || typeof node !== 'object') return 0;
  const kids = Array.isArray(node.c) ? node.c : [];
  return (node.n === 'condition' ? 1 : 0) + kids.reduce((s, k) => s + countConditions(k && k.node ? k.node : k), 0);
}
function hasNode(node, test) {
  if (!node || typeof node !== 'object') return false;
  if (test(node)) return true;
  return (Array.isArray(node.c) ? node.c : []).some((k) => hasNode(k && k.node ? k.node : k, test));
}
const attrOf = (node, name) => ((Array.isArray(node.a) ? node.a : []).find((p) => p[0] === name) || [])[1];
const typedConditionCount = (g) => (g ? (g.conditions || []).length + (g.groups || []).reduce((s, x) => s + typedConditionCount(x), 0) : 0);

/**
 * True when the view's BASE filter holds something the typed tree does not show. The fetch bag is
 * lossless: { a, c: [{ i, node: { n: 'entity', a, c: [ {n:'attribute'}, {n:'filter', c:[...]}, ... ] } }] }.
 * The entity-level <filter> nodes (except the Quick Find one, `isquickfindfields="1"`, which the
 * typed layer models separately as findColumns) must hold exactly the conditions the typed filter
 * shows, with no multi-<value> condition and no link-entity inside.
 */
function hasUnrepresentableFilter(view) {
  const bag = view && view.fetchBag;
  if (!bag || !Array.isArray(bag.c)) return false;
  const entityNode = (bag.c.map((k) => (k && k.node ? k.node : k)).find((n) => n && n.n === 'entity'));
  if (!entityNode) return false;
  const filters = (entityNode.c || []).filter((n) => n && n.n === 'filter' && attrOf(n, 'isquickfindfields') !== '1');
  const inBag = filters.reduce((s, f) => s + countConditions(f), 0);
  if (inBag !== typedConditionCount(view.filters)) return true;
  return filters.some((f) => hasNode(f, (n) => n.n === 'link-entity' || (n.n === 'condition' && (n.c || []).some((k) => k && k.n === 'value'))));
}

/** A live joined-table cell the bundle read back without its join (see the header). */
function hasUnboundRelatedColumn(view) {
  return (view.columns || []).some((c) => String(c.name).includes('.') && !c.relatedEntity);
}

/**
 * The FULL ownable projection of a live view: every part a declared view can own, whatever this spec
 * declares today (see the header). Joins are normalised (name/from/to/alias/linkType/filters).
 */
function liveFull(view) {
  return {
    columns: (view.columns || []).slice().sort((a, b) => a.order - b.order).map((c) => {
      const o = { name: lc(c.name) };
      if (c.relatedEntity) { o.relatedEntity = lc(c.relatedEntity); o.sourceAttribute = lc(c.sourceAttribute || ''); }
      o.width = c.width;
      return o;
    }),
    filters: view.filters || { type: 'and', conditions: [], groups: [] },
    sort: (view.sort || []).map((s) => ({ attribute: lc(s.attribute), descending: !!s.descending, entityname: lc(s.entityname || '') })),
    linkEntities: (view.linkEntities || []).map(normLink),
    description: String(view.description || ''),
  };
}
function normLink(l) {
  const o = { name: lc(l.name), from: lc(l.from), to: lc(l.to) };
  if (l.alias) o.alias = lc(l.alias);
  if (l.linkType) o.linkType = l.linkType;
  if (l.filters && ((l.filters.conditions || []).length || (l.filters.groups || []).length)) o.filters = l.filters;
  return o;
}

/**
 * The full projection after this run: the declared parts laid over the live ones. Widths the spec
 * left out come from the live column; a declared join replaces the live join with the same
 * alias/name, an undeclared live join is kept, a new one is appended; an undeclared description is
 * kept as it is.
 */
function desiredFull(intent, live) {
  const liveWidth = new Map(live.columns.map((c) => [c.name, c.width]));
  const declared = new Map(intent.linkEntities.map((l) => [refNameOf(l), normLink(l)]));
  const kept = live.linkEntities.map((l) => declared.get(refNameOf(l)) || l);
  const keptRefs = new Set(kept.map(refNameOf));
  return {
    columns: intent.columns.map((c) => ({ ...c, width: c.width !== undefined ? c.width : (liveWidth.has(c.name) ? liveWidth.get(c.name) : 100) })),
    filters: intent.filters,
    sort: intent.sort,
    linkEntities: [...kept, ...[...declared.values()].filter((l) => !keptRefs.has(refNameOf(l)))],
    description: intent.description !== undefined ? intent.description : live.description,
  };
}

const PARTS = ['columns', 'filters', 'sort', 'linkEntities', 'description'];

/** True when a thrown read says the row is not there (HTTP 404), as opposed to "could not read". */
const isNotFound = (err) => !!err && (err.statusCode === 404 || err.status === 404);

/**
 * Plan one declared view. GET only.
 * @returns {{ key, intent, viewId, action, changed, createArtifact?, desired?, baseline?, origin?, operations, refused, unknown }}
 */
async function planViewReconcile({ view, sdk, resolveValue, primaryName }, ctx = {}) {
  const { errors, intent } = compileViewIntent(view, { resolveValue, primaryName });
  const key = intent ? intent.key : `${lc((view && view.entity) || '')}/${(view && view.name) || ''}`;
  const plan = { key, intent, viewId: null, action: null, changed: [], operations: [], refused: [], unknown: [] };
  if (errors.length) {
    plan.refused.push(refusal(key, 'view-spec-invalid', 'the declared view does not compile (see validation)'));
    plan.errors = errors;
    return plan;
  }
  const binding = await lookupBinding(ctx, 'view', key);
  const who = boundIdentity(binding, { pinnedId: intent.viewId, code: 'view-binding-mismatch', key });
  if (who.refusal) {
    plan.refused.push(who.refusal);
    return plan;
  }
  let id = who.id ? normalizeGuid(who.id) || who.id : '';
  // A stable create identity (lib/creates-stable-build.js) is looked for at its own id before any name lookup. A row found there
  // is only an OBSERVATION: it gives the id to read, never a binding, so the plan below treats it as unbound (adopting it needs
  // the adoption approval, as any unbound row does).
  if (!id && !binding && ctx.managed && typeof ctx.managed.observe === 'function') {
    try {
      id = normalizeGuid(await ctx.managed.observe('view', key)) || '';
    } catch (err) {
      plan.unknown.push(readFailure(key, 'view-lookup-unreadable', 'whether the view exists could not be read', err));
      return plan;
    }
  }
  if (!id) {
    try {
      id = normalizeGuid(await sdk.findArtifact('view', { name: intent.name, entity: intent.entity }));
    } catch (err) {
      // The SDK refuses a name two rows share (AMBIGUOUS_ARTIFACT): choosing one would edit a row the spec
      // may not mean, so the maker names it instead. Any other failure leaves existence unknown; the read's own failure is
      // kept with it, so the build can tell a table it has only just created, not yet in the metadata cache, from a real
      // failure (sdk-build.js, freshLagOf).
      if (err && err.code === 'AMBIGUOUS_ARTIFACT') plan.refused.push(refusal(key, 'view-name-ambiguous', 'several views on the table have this name; rename or remove the extra one before it can be managed'));
      else plan.unknown.push(readFailure(key, 'view-lookup-unreadable', 'whether the view exists could not be read', err));
      return plan;
    }
  }
  if (!id) {
    plan.action = 'create';
    plan.createArtifact = viewCreateArtifact(intent);
    plan.operations.push(operation({ key, kind: 'view', target: null, action: 'create', publicationScopes: [{ type: 'view', table: intent.entity }] }));
    return plan;
  }
  plan.viewId = id;
  let current;
  try {
    await sdk.fetchArtifact('view', id);
    current = await sdk.getArtifact('view', id);
  } catch (err) {
    if (binding && isNotFound(err)) plan.refused.push(refusal(key, 'view-bound-row-missing', 'the view this key is bound to is gone; repair the binding explicitly before it can be recreated'));
    else if (intent.viewId) plan.refused.push(refusal(key, 'view-pinned-not-found', 'the pinned viewId could not be read in this environment'));
    else plan.unknown.push(refusal(key, 'view-unreadable', 'the view could not be read'));
    return plan;
  }
  if (!current || lc(current.entityLogicalName || '') !== intent.entity) {
    plan.refused.push(refusal(key, 'view-pinned-wrong-table', 'the pinned view belongs to another table'));
    return plan;
  }
  const live = liveFull(current);
  const desired = desiredFull(intent, live);
  plan.changed = PARTS.filter((p) => canonicalJson(desired[p]) !== canonicalJson(live[p]));
  plan.desired = desired;
  plan.baseline = projectionBaseline(desired);
  // The row as it was read before any change: an edit's base observation (lib/creates-stable-build.js), so the store never
  // takes an answer to that edit for a create (managed-bindings.js rootCreateAcknowledged).
  plan.observedSha256 = projectionBaseline(live).intentSha256;

  const verdict = partsDriftVerdict(binding, live, desired);
  plan.origin = binding ? binding.origin : 'adopted';
  const publicationScopes = [{ type: 'view', id, table: intent.entity }];
  if (plan.changed.length === 0) {
    plan.action = 'noChange';
    plan.bindUnchanged = bindsUnchanged(binding, ctx, approvalKey('view', key), !!intent.viewId);
    plan.operations.push(operation({ key, kind: 'view', target: id, action: 'noChange' }));
    return plan;
  }
  if (verdict === 'drift' && !isApproved(ctx.authorizedOverwrite, 'view', key)) {
    plan.refused.push(refusal(key, 'view-drift', 'an owned part of the view was changed outside the spec; refresh the spec or approve the overwrite'));
    return plan;
  }
  if (verdict === 'unbound' && !intent.viewId && !isApproved(ctx.authorizedAdoption, 'view', key)) {
    plan.refused.push(refusal(key, 'view-adoption-not-authorized', 'the view exists and is not yet managed by this spec; approve adopting it first'));
    return plan;
  }
  if (plan.changed.includes('filters') && hasUnrepresentableFilter(current)) {
    plan.refused.push(refusal(key, 'view-filter-unrepresentable', 'the view\'s current filter cannot be represented, so it cannot be replaced; it was left as it is'));
    return plan;
  }
  if (plan.changed.includes('columns') && hasUnboundRelatedColumn(current)) {
    plan.refused.push(refusal(key, 'view-related-column-unrepresentable', 'a joined-table column on the view cannot be rewritten faithfully; the columns were left as they are'));
    return plan;
  }
  const removedColumns = live.columns.filter((c) => !desired.columns.some((d) => d.name === c.name));
  const destructive = removedColumns.length > 0 || (plan.changed.includes('filters') && typedConditionCount(live.filters) > 0);
  if (removedColumns.length > 0 && !isAuthorized(ctx.authorizedDestructive, key)) {
    plan.refused.push(refusal(key, 'view-columns-removal-not-authorized', 'the declared columns remove columns the view shows; that needs approval'));
    return plan;
  }
  plan.action = 'update';
  plan.operations.push(operation({ key, kind: 'view', target: id, action: 'update', destructive, publicationScopes }));
  return plan;
}

/** Re-read a view and answer the baseline of what the server holds, or null when it cannot be read. */
async function readBaseline(sdk, id) {
  try {
    await sdk.fetchArtifact('view', id);
    const fresh = await sdk.getArtifact('view', id);
    return fresh ? projectionBaseline(liveFull(fresh)) : null;
  } catch {
    return null;
  }
}

/** Create a new declared view through the creation port (see the header). */
async function applyViewCreate(plan, sdk, ctx, result) {
  const created = await createThroughPort(ctx, { kind: 'view', key: plan.key, identity: [plan.intent.entity, plan.intent.name], childKeys: [] }, async ({ id }) => {
    const art = await sdk.createArtifact('view', { ...plan.createArtifact, id });
    // The view must be stored under the id this create was given: the result, the binding and the
    // solution bookkeeping all name that id, so a create that does not keep it is refused before
    // anything is pushed.
    if (normalizeGuid(art && art.id) !== normalizeGuid(id)) return { outcome: 'refused', code: 'CREATE_ID_NOT_KEPT' };
    // The stable port pins the create request to the draft it made (creates-stable-build.js materialised): the push may then
    // send only the body that draft produces, and a draft edited meanwhile is refused unsent and kept as it is.
    if (ctx.creates && typeof ctx.creates.materialised === 'function') await ctx.creates.materialised({ kind: 'view', id, artifact: art });
    return pushChecked(sdk, 'view', id);
  });
  const id = created.id ? normalizeGuid(created.id) || String(created.id) : null;
  if (created.status === 'created' || created.status === 'matched') {
    // 'matched' (the stable port only): the push found the row already at the reserved id. It is handled as a create —
    // saved, joined to the solution, published once — but bound as adopted: this push is no receipt that this run made it.
    const origin = created.status === 'created' ? 'created' : 'adopted';
    const scope = { type: 'view', id, table: plan.intent.entity };
    result.saved.push({ key: plan.key, kind: 'view', id, created: true, parts: PARTS.slice() });
    result.pendingPublish.push({ key: plan.key, scope });
    // The baseline is what the server is SEEN to hold. A create that cannot be read back records no
    // binding (the intent is not a substitute for the stored view) and stays unknown.
    const baseline = await readBaseline(sdk, id);
    if (baseline) result.managedBindings.push(bindingRecord(ctx, { kind: 'view', key: plan.key, id, origin, ...baseline }));
    else result.unknown.push(refusal(plan.key, 'view-created-unreadable', 'the view was created but could not be read back to record its baseline'));
  } else if (created.status === 'adopted') {
    // The maker resolved a lost create by naming the view it made: bind it to what it holds now and
    // write nothing; the next run reconciles it like any bound view.
    const baseline = id ? await readBaseline(sdk, id) : null;
    if (baseline) {
      result.managedBindings.push(bindingRecord(ctx, { kind: 'view', key: plan.key, id, origin: 'created', ...baseline }));
      result.refused.push(refusal(plan.key, 'creation-adopted-rerun', 'the view an earlier create made was bound; run again to apply the spec to it'));
    } else {
      result.refused.push(refusal(plan.key, 'creation-adopted-row-missing', 'the view the resolved create named could not be read; repair the binding explicitly'));
    }
  } else if (created.status === 'refused') {
    result.refused.push({ ...refusal(plan.key, /^creation-/.test(created.code) ? created.code : 'view-create-refused', 'the view was not created; nothing was written'), rules: created.rules || [] });
  } else {
    // The create may have been stored: its table's publication is recorded (withheld) so the build's
    // publication barrier keeps the table unpublished (publication-barrier.js).
    result.pendingPublish.push({ key: plan.key, scope: { type: 'view', id, table: plan.intent.entity } });
    result.unknown.push(refusal(plan.key, 'view-write-unknown', 'the view create did not report its outcome; check the table\'s views'));
  }
  return result;
}

/**
 * Apply a view plan. A plan with a refusal or unknown writes nothing. The publish the apply needs is
 * queued only when the whole result settles cleanly (commitPublication).
 */
async function applyViewReconcile(plan, { sdk }, ctx = {}) {
  return commitPublication(ctx, await applyViewPlan(plan, sdk, ctx));
}

async function applyViewPlan(plan, sdk, ctx) {
  const result = emptyResult();
  result.refused.push(...plan.refused);
  result.unknown.push(...plan.unknown);
  if (plan.refused.length || plan.unknown.length || !plan.action) return result;
  if (plan.action === 'create') return applyViewCreate(plan, sdk, ctx, result);
  const id = plan.viewId;
  const record = () => bindingRecord(ctx, { kind: 'view', key: plan.key, id, origin: plan.origin, ...plan.baseline });
  if (plan.action === 'noChange') {
    result.unchanged.push({ key: plan.key, kind: 'view', id });
    if (plan.bindUnchanged) result.managedBindings.push(record());
    return result;
  }
  const d = plan.desired;
  try {
    for (const part of plan.changed) {
      if (part === 'columns') {
        await sdk.updateElement('view', id, '/columns', d.columns.map((c, i) => ({ ...c, order: i })));
      } else if (part === 'linkEntities') {
        // Declared joins replace the live join with the same alias/name; undeclared live joins are
        // kept as the SDK read them (their bags carry options the typed join does not).
        const current = await sdk.getArtifact('view', id);
        const declared = new Map(plan.intent.linkEntities.map((l) => [refNameOf(l), normLink(l)]));
        const kept = (current.linkEntities || []).map((l) => declared.get(refNameOf(l)) || l);
        const keptRefs = new Set(kept.map(refNameOf));
        const joins = [...kept, ...[...declared.values()].filter((l) => !keptRefs.has(refNameOf(l)))];
        // A view with no join has no `linkEntities` member at all, and updateElement replaces only an
        // existing pointer (PATH_NOT_FOUND otherwise): the first join is ADDED at the artifact root.
        if (current.linkEntities === undefined) await sdk.addElement('view', id, '', { linkEntities: joins });
        else await sdk.updateElement('view', id, '/linkEntities', joins);
      } else {
        await sdk.updateElement('view', id, `/${part}`, d[part]);
      }
    }
  } catch (err) {
    result.refused.push({ ...refusal(plan.key, 'view-rejected', 'the SDK refused the view edit before anything was sent'), rules: rulesOf(err) });
    return result;
  }
  const pushed = await pushIfChanged(sdk, 'view', id);
  if (pushed.outcome === 'unchanged') {
    result.unchanged.push({ key: plan.key, kind: 'view', id });
    result.managedBindings.push(record());
  } else if (pushed.outcome === 'saved') {
    result.saved.push({ key: plan.key, kind: 'view', id, parts: plan.changed.slice() });
    result.pendingPublish.push({ key: plan.key, scope: { type: 'view', id, table: plan.intent.entity } });
    result.managedBindings.push(record());
  } else if (pushed.outcome === 'refused') {
    result.refused.push({ ...refusal(plan.key, 'view-rejected', 'the SDK refused the view edit before anything was sent'), rules: pushed.rules || [] });
  } else {
    // The write may have been stored: recorded (withheld) for the publication barrier.
    result.pendingPublish.push({ key: plan.key, scope: { type: 'view', id, table: plan.intent.entity } });
    result.unknown.push(refusal(plan.key, 'view-write-unknown', 'the view write did not report its outcome; check the view'));
  }
  return result;
}
module.exports = {
  isDeclaredView,
  declaredViewKey,
  compileViewIntent,
  viewCreateArtifact,
  planViewReconcile,
  applyViewReconcile,
  hasUnrepresentableFilter,
  hasUnboundRelatedColumn,
  liveFull,
  desiredFull,
  PARTS,
};
