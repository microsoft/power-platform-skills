'use strict';
// Quick Find columns and Dataverse search, declared on a table:
//
//   entities[].quickFind              { findColumns: ['name', 'emailaddress1'] }
//   entities[].searchEnabled          true | false
//   entities[].changeTrackingEnabled  true   (only `true` — tracking cannot be switched off)
//
// The Quick Find FIND columns are what a grid's search box (and a lookup's search) match typed
// text against. They live in the table's Quick Find VIEW, in its `<filter isquickfindfields="1">`;
// the SDK models that filter as `ViewArtifact.findColumns` (types/view.ts) and refuses a typed
// write it cannot represent faithfully (`view-find-filter-unsupported`). This module:
//   1. resolves the ONE Quick Find view by the SDK's exact-one rule — the single listed view with
//      `queryType === 4 && isDefault` (a table can hold several querytype-4 views, and more than
//      one default; zero or several is ambiguous, and nothing is guessed);
//   2. fetches it, and writes `findColumns` only when the declared list differs from the stored
//      one, so an ordinary rebuild sends nothing;
//   3. queues the table's publication (Quick Find uses the list once the view is published).
// The rest of the view — its template conditions (`statecode eq 0`), columns, sort and the find
// filter's own attributes — round-trips through the SDK's bags untouched.
//
// Search (searchEnabled/changeTrackingEnabled) is a TABLE flag written by the table phase; this
// module only checks the request against the table's live settings (`checkSearchRequest`): turning
// search on for an untracked table needs `changeTrackingEnabled: true` in the same spec. Tracking is
// one-way, so it is never inferred, and the organization-wide search switch is never touched.

const {
  emptyResult,
  operation,
  refusal,
  isAuthorized,
  pushIfChanged,
  queuePublication,
} = require('./reconcile-common.js');

const NAME_RE = /^[a-z_][a-z0-9_]{0,127}$/i;

/** Shape errors for one table's Quick Find/search fields. Each error is { path, message }. */
function validateQuickFindSpec(entity, at = 'entities[]') {
  const errors = [];
  if (!entity || typeof entity !== 'object') return errors;
  const qf = entity.quickFind;
  if (qf !== undefined) {
    if (!qf || typeof qf !== 'object' || Array.isArray(qf)) {
      errors.push({ path: `${at}.quickFind`, message: 'quickFind must be an object: { findColumns: [...] }' });
    } else if (!Array.isArray(qf.findColumns)) {
      errors.push({ path: `${at}.quickFind.findColumns`, message: 'findColumns must be a list of column logical names' });
    } else {
      const seen = new Set();
      qf.findColumns.forEach((c, i) => {
        if (typeof c !== 'string' || !NAME_RE.test(c)) {
          errors.push({ path: `${at}.quickFind.findColumns[${i}]`, message: 'a find column must be a column logical name' });
          return;
        }
        const k = c.toLowerCase();
        if (seen.has(k)) errors.push({ path: `${at}.quickFind.findColumns[${i}]`, message: `'${c}' is listed twice` });
        seen.add(k);
      });
    }
  }
  if (entity.searchEnabled !== undefined && typeof entity.searchEnabled !== 'boolean') {
    errors.push({ path: `${at}.searchEnabled`, message: 'searchEnabled must be true or false' });
  }
  if (entity.changeTrackingEnabled !== undefined && entity.changeTrackingEnabled !== true) {
    // Change tracking cannot be turned off once on, so `false` would promise something the platform
    // will not do; leaving the field out is how a spec says "do not change it".
    errors.push({ path: `${at}.changeTrackingEnabled`, message: 'changeTrackingEnabled can only be true (tracking cannot be switched off); leave it out to keep the current setting' });
  }
  return errors;
}

/**
 * Check a search request against the table's live settings — the `tables[]` entry of the SDK's
 * `getSearchSettings({ tables: [entity] })` (api/SearchApi.ts: { changeTrackingEnabled,
 * syncToSearchIndex, searchEnabled, canEnableSearch, ... }). Returns null when the request may go
 * ahead, else a refusal. A table missing from the answer is refused, never assumed.
 */
function checkSearchRequest(entityName, entity, liveTable) {
  const key = `${entityName}/search`;
  if (!entity || entity.searchEnabled !== true) return null;
  if (!liveTable) return refusal(key, 'search-table-unreadable', 'the table\'s search settings could not be read, so search was not turned on');
  if (liveTable.canEnableSearch === false) return refusal(key, 'search-not-allowed', 'this table cannot be added to Dataverse search');
  if (liveTable.changeTrackingEnabled !== true && entity.changeTrackingEnabled !== true) {
    return refusal(key, 'search-needs-change-tracking', 'Dataverse search needs change tracking on this table; add changeTrackingEnabled: true to turn it on (it cannot be turned off again)');
  }
  return null;
}

/**
 * What a verify step should find for a table's Quick Find/search declaration: the stored find
 * list (exact, in order) and, when search was requested, the table's search flags. A configured
 * index does NOT prove the index holds rows; the projection says so by carrying no row claim.
 */
function expectedQuickFindProjection(entityName, entity) {
  const out = { table: entityName };
  if (entity && entity.quickFind && Array.isArray(entity.quickFind.findColumns)) {
    out.findColumns = entity.quickFind.findColumns.map((c) => String(c).toLowerCase());
  }
  if (entity && typeof entity.searchEnabled === 'boolean') out.searchEnabled = entity.searchEnabled;
  if (entity && entity.changeTrackingEnabled === true) out.changeTrackingEnabled = true;
  return out;
}

const lower = (list) => (list || []).map((c) => String(c).toLowerCase());
const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Plan one table's Quick Find edit. GET only.
 * Returns { key, entity, viewId, desired, stored, operations, refused, unknown }.
 */
async function planQuickFind({ entity, quickFind, sdk }, ctx = {}) {
  const key = `${entity}/quickFind`;
  const plan = { key, entity, viewId: null, desired: null, stored: null, operations: [], refused: [], unknown: [] };
  if (!quickFind || !Array.isArray(quickFind.findColumns)) return plan;
  const shape = validateQuickFindSpec({ quickFind });
  if (shape.length) {
    plan.refused.push(refusal(key, 'quick-find-spec-invalid', 'the declared Quick Find list is not a list of distinct column names'));
    return plan;
  }
  plan.desired = lower(quickFind.findColumns);

  let listed;
  try {
    listed = await sdk.fetchArtifactList('view', { entityLogicalName: entity });
  } catch {
    plan.unknown.push(refusal(key, 'quick-find-views-unreadable', 'the table\'s views could not be listed, so its Quick Find view could not be found'));
    return plan;
  }
  const mine = (listed || []).filter((v) => v && String(v.entityLogicalName || entity).toLowerCase() === entity.toLowerCase());
  // A summary without queryType/isDefault is an incomplete list (an older bundle): it cannot prove
  // there is exactly one candidate, so it is refused rather than read as "not a Quick Find view".
  if (mine.some((v) => typeof v.queryType !== 'number' || typeof v.isDefault !== 'boolean')) {
    plan.refused.push(refusal(key, 'quick-find-list-incomplete', 'the view list did not say which view is the Quick Find view'));
    return plan;
  }
  const candidates = mine.filter((v) => v.queryType === 4 && v.isDefault === true);
  if (candidates.length === 0) {
    plan.refused.push(refusal(key, 'quick-find-view-not-found', 'the table has no default Quick Find view, so the find columns were not written'));
    return plan;
  }
  if (candidates.length > 1) {
    plan.refused.push(refusal(key, 'quick-find-view-ambiguous', 'the table has more than one default Quick Find view; none was chosen'));
    return plan;
  }
  plan.viewId = String(candidates[0].id);

  let view;
  try {
    await sdk.fetchArtifact('view', plan.viewId);
    view = await sdk.getArtifact('view', plan.viewId);
  } catch {
    plan.unknown.push(refusal(key, 'quick-find-view-unreadable', 'the Quick Find view could not be read'));
    return plan;
  }
  if (!view || !Array.isArray(view.findColumns)) {
    // `undefined` is NOT "no find columns" in the SDK: it means the stored find filter cannot be
    // represented as a list (a literal constraint, a nested or join-scoped filter), and a typed
    // write would discard what the list cannot show.
    plan.refused.push(refusal(key, 'quick-find-filter-unsupported', 'the Quick Find view\'s find filter cannot be represented as a list of columns; it was left as it is'));
    return plan;
  }
  plan.stored = lower(view.findColumns);
  if (sameList(plan.stored, plan.desired)) {
    plan.operations.push(operation({ key, kind: 'quickFind', target: plan.viewId, action: 'noChange' }));
    return plan;
  }
  const removed = plan.stored.filter((c) => !plan.desired.includes(c));
  if (plan.desired.length === 0 && !isAuthorized(ctx.authorizedDestructive, key)) {
    // An empty list leaves the search box matching nothing — destructive, so it needs the build's
    // normal plan authorization.
    plan.refused.push(refusal(key, 'quick-find-empty-not-authorized', 'an empty find list removes every Quick Find column; it needs approval'));
    return plan;
  }
  plan.operations.push(operation({
    key,
    kind: 'quickFind',
    target: plan.viewId,
    action: 'update',
    destructive: removed.length > 0,
    publicationScopes: [{ type: 'entity', table: entity }],
  }));
  return plan;
}

/** Apply a Quick Find plan: write the list, push only on a real change, queue the table publish. */
async function applyQuickFind(plan, { sdk }, ctx = {}) {
  const result = emptyResult();
  result.refused.push(...plan.refused);
  result.unknown.push(...plan.unknown);
  const op = plan.operations[0];
  if (!op || plan.refused.length || plan.unknown.length) return result;
  if (op.action === 'noChange') {
    result.unchanged.push({ key: plan.key, kind: 'quickFind', id: plan.viewId });
    return result;
  }
  try {
    await sdk.updateElement('view', plan.viewId, '/findColumns', plan.desired.slice());
  } catch {
    // The SDK validates the list as it is written (a duplicate, a non-name) — a local refusal.
    result.refused.push(refusal(plan.key, 'quick-find-rejected', 'the SDK refused the find list before anything was sent'));
    return result;
  }
  const pushed = await pushIfChanged(sdk, 'view', plan.viewId);
  if (pushed.outcome === 'unchanged') {
    result.unchanged.push({ key: plan.key, kind: 'quickFind', id: plan.viewId });
  } else if (pushed.outcome === 'saved') {
    result.saved.push({ key: plan.key, kind: 'quickFind', id: plan.viewId });
    const scope = { type: 'entity', table: plan.entity };
    queuePublication(ctx, scope);
    result.pendingPublish.push({ key: plan.key, scope });
  } else if (pushed.outcome === 'refused') {
    // e.g. view-find-column-type-unsupported (a NEW decimal/identifier column has no search
    // template) or view-find-column-unresolved (no such column): nothing was sent.
    result.refused.push({ ...refusal(plan.key, 'quick-find-rejected', 'the SDK refused the find list before anything was sent'), rules: pushed.rules || [] });
  } else {
    result.unknown.push(refusal(plan.key, 'quick-find-write-unknown', 'the Quick Find write did not report its outcome; check the view'));
  }
  return result;
}

module.exports = {
  validateQuickFindSpec,
  checkSearchRequest,
  expectedQuickFindProjection,
  planQuickFind,
  applyQuickFind,
};
