'use strict';
// Declared reconciliation for an existing dashboard (`dashboards[].reconcile: "declared"`).
//
// Without the opt-in, an existing dashboard is reused as it is: tile edits in the spec are never
// applied on a rebuild (sdk-build's dashboards phase). With it, every tile the spec declares carries
// a stable `key`, and the dashboard converges tile by tile:
//   * a keyed tile already bound to a live control (by the managed binding, or by an explicit
//     environment-bound `componentId` the first time) gets the AUTHORED parts of the tile written —
//     its target view/chart/url/web resource, and its name/colspan/rowspan when the spec sets them;
//   * a keyed tile with no live control is appended, with a control id from the creation port so an
//     interrupted run cannot add it twice;
//   * everything else is kept: live control ids, positions, cell bags, the platform's per-tile
//     defaults the spec never authored (RecordsPerPage, EnableQuickFind, HeaderColorCode, ...) and
//     every tile the spec does not list. A tile the spec omits is never removed.
// A type change (a list tile declared as a chart) is refused: the SDK cannot retype a control in
// place, and replacing it would drop the live control's id and bag.
//
// Identity of the DASHBOARD: an existing managed binding is the authority. A bound dashboard is
// edited by its bound id only — a pin or an id the build resolved by name that names another row is
// refused (dashboard-binding-mismatch), and a bound dashboard that is gone is refused
// (dashboard-bound-row-missing), never re-resolved. Unbound, the build hands over the id it resolved
// (pinned dashboardId, recorded creations, the single-name lookup with its solution check) or none;
// with none, the dashboard is created HERE through the creation-identity port (ctx.creates.run) with
// its tiles' control ids reserved as children, so an interrupted create can be recovered.
// Each tile's control id is claimed by one key only: two keys pinned or bound to one control refuse.
//
// Baselines are FULL projections (reconcile-common projectionBaseline): a tile records its name,
// colspan, rowspan and owned parameters whatever the spec declares; the dashboard records its
// description. Drift is judged on the parts a run writes, so a description changed outside the spec
// is refused before it is overwritten, and starting or stopping to declare a part is an edit.
//
// Tile options are resolved by the build's own dashboardTileOpts and turned into a component by its
// dashboardComponent, injected as `resolveTile` / `toComponent` so the mapping exists once.
//// Measured through the real bundle (dashboard-reconcile-real-bundle.test.js): updateElement on
// `/components/<i>/name|rowspan|parameters/<P>` rewrites only that cell's label/attribute/parameter;
// the foreign custom-control cell, the tab/section bags and the control descriptions come back
// byte-identical; addElement keeps a provided control `id`.

const {
  canonicalJson,
  emptyResult,
  operation,
  refusal,
  isAuthorized,
  lookupBinding,
  bindingRecord,
  bindsUnchanged,
  pushIfChanged,
  pushChecked,
  projectionBaseline,
  partsDriftVerdict,
  boundIdentity,
  createThroughPort,
  normalizeGuid,
  queuePublication,
  rulesOf,
} = require('./reconcile-common.js');

const KIND = 'dashboard';
const TILE_KIND = 'dashboard-tile';
const KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;
// The <parameters> a spec tile AUTHORS, per tile type. The rest of what dashboardComponent emits
// (IsUserView, ChartGridMode, RecordsPerPage) are creation defaults: owning them would reset a
// maker's per-tile settings on every rebuild.
const OWNED_PARAMS = {
  chart: ['TargetEntityType', 'ViewId', 'VisualizationId'],
  list: ['TargetEntityType', 'ViewId'],
  iframe: ['Url'],
  webresource: ['WebResourceName'],
};
const GUID_PARAMS = new Set(['ViewId', 'VisualizationId']);

const lc = (s) => String(s == null ? '' : s).toLowerCase();
const bareId = (id) => String(id == null ? '' : id).replace(/[{}]/g, '').toLowerCase();

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
  (dashboard.tiles || []).forEach((t, i) => {
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

const TILE_SIZE_PARTS = ['name', 'colspan', 'rowspan'];
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
  if (typeof tile.name === 'string' && tile.name) out.name = tile.name;
  if (tile.colspan) out.colspan = tile.colspan;
  if (tile.rowspan) out.rowspan = tile.rowspan;
  return out;
}

const changedParts = (live, desired) => Object.keys(desired).filter((k) => canonicalJson(desired[k]) !== canonicalJson(live[k]));
const sameParams = (type, a, b) => (OWNED_PARAMS[type] || []).every((p) => a[paramPart(p)] === b[paramPart(p)]);
const isNotFound = (err) => !!err && (err.statusCode === 404 || err.status === 404);
const rootDescription = (dashboard) => (typeof dashboard.description === 'string' && dashboard.description.trim() ? dashboard.description.trim() : undefined);

/**
 * Plan one declared dashboard. GET only.
 * @param {{ dashboard: object, dashboardId?: string, sdk: object, resolveTile: Function, toComponent: Function }} input
 *   dashboardId — the id the build resolved for an unbound dashboard, or none (then it is created here)
 *   resolveTile(tile) -> the build's dashboardTileOpts(spec, tile, result)
 *   toComponent(opts, index) -> the build's dashboardComponent(opts, index)
 */
async function planDashboardReconcile({ dashboard, dashboardId, sdk, resolveTile, toComponent }, ctx = {}) {
  const key = dashboardKey(dashboard);
  const plan = { key, dashboardId: null, action: null, tiles: [], description: undefined, operations: [], refused: [], unknown: [] };
  const errors = validateDeclaredDashboard(dashboard || {});
  if (errors.length) {
    plan.errors = errors;
    plan.refused.push(refusal(key, 'dashboard-spec-invalid', 'the declared dashboard does not compile (see validation)'));
    return plan;
  }
  const dashBinding = await lookupBinding(ctx, KIND, key);
  const ident = boundIdentity(dashBinding, { pinnedId: dashboard.dashboardId, resolvedId: dashboardId, code: 'dashboard-binding-mismatch', key });
  if (ident.refusal) {
    plan.refused.push(ident.refusal);
    return plan;
  }
  plan.dashboardId = ident.id ? normalizeGuid(ident.id) || null : null;
  if (ident.id && !plan.dashboardId) {
    plan.refused.push(refusal(key, 'dashboard-spec-invalid', 'the dashboard id is not a GUID'));
    return plan;
  }
  if (!plan.dashboardId) return planDashboardCreate(plan, dashboard, resolveTile, toComponent);

  let live;
  try {
    await sdk.fetchArtifact(KIND, plan.dashboardId);
    live = await sdk.getArtifact(KIND, plan.dashboardId);
  } catch (err) {
    if (dashBinding && isNotFound(err)) plan.refused.push(refusal(key, 'dashboard-bound-row-missing', 'the dashboard this key is bound to is gone; repair the binding explicitly before it can be recreated'));
    else plan.unknown.push(refusal(key, 'dashboard-unreadable', 'the dashboard could not be read'));
    return plan;
  }
  if (!live || live.dashboardType !== 'Standard') {
    plan.refused.push(refusal(key, 'dashboard-interactive-unsupported', 'only a standard dashboard is reconciled; it was left as it is'));
    return plan;
  }
  plan.origin = dashBinding ? dashBinding.origin : 'adopted';
  const pinned = !!dashboard.dashboardId;
  const liveById = new Map((live.components || []).map((c, i) => [bareId(c.id), { c, i }]));
  const claimed = new Map();
  let writes = 0;
  let appendAt = (live.components || []).length;

  for (const tile of dashboard.tiles || []) {
    const tileKey = `${key}/${tile.key}`;
    let component;
    try {
      component = toComponent(resolveTile(tile), appendAt);
    } catch {
      plan.refused.push(refusal(tileKey, 'dashboard-tile-unresolved', 'the tile\'s view, chart or web resource could not be resolved'));
      continue;
    }
    const binding = await lookupBinding(ctx, TILE_KIND, tileKey);
    const tileIdent = boundIdentity(binding, { pinnedId: tile.componentId, code: 'dashboard-tile-binding-mismatch', key: tileKey });
    if (tileIdent.refusal) {
      plan.refused.push(tileIdent.refusal);
      continue;
    }
    const boundId = tileIdent.id ? bareId(tileIdent.id) : '';
    const entry = { tile, tileKey, component, origin: binding ? binding.origin : 'adopted' };
    if (boundId) {
      if (claimed.has(boundId)) {
        plan.refused.push(refusal(tileKey, 'dashboard-tile-claimed-twice', `the tile's control is already managed under '${claimed.get(boundId)}'; one control belongs to one key`));
        continue;
      }
      const hit = liveById.get(boundId);
      if (!hit) {
        if (!isAuthorized(ctx.authorizedOverwrite, tileKey)) {
          plan.refused.push(refusal(tileKey, binding ? 'dashboard-tile-missing' : 'dashboard-tile-pinned-not-found', 'the tile this spec manages is no longer on the dashboard; approve adding it again'));
          continue;
        }
      } else {
        claimed.set(boundId, tileKey);
        entry.liveId = hit.c.id;
        entry.index = hit.i;
        if (hit.c.type !== component.type) {
          plan.refused.push(refusal(tileKey, 'dashboard-tile-type-change', 'the tile\'s type cannot change in place; remove the tile in Maker or give it a new key'));
          continue;
        }
        const liveParts = liveTile(hit.c, component.type);
        const desired = desiredTile(tile, component, liveParts);
        entry.baseline = projectionBaseline(desired);
        entry.changed = changedParts(liveParts, desired);
        if (!entry.changed.length) {
          entry.action = 'noChange';
        } else {
          if (partsDriftVerdict(binding, liveParts, desired) === 'drift' && !isAuthorized(ctx.authorizedOverwrite, tileKey)) {
            plan.refused.push(refusal(tileKey, 'dashboard-tile-drift', 'an authored part of the tile was changed outside the spec; refresh the spec or approve the overwrite'));
            continue;
          }
          entry.action = 'update';
          writes += 1;
        }
        plan.tiles.push(entry);
        plan.operations.push(operation({ key: tileKey, kind: TILE_KIND, target: entry.liveId, action: entry.action }));
        continue;
      }
    }
    const added = desiredTile(tile, component, liveTile(component, component.type));
    // A new tile. When this dashboard is not managed yet, a live tile showing the same target is
    // almost certainly this tile created by an earlier build: appending would show it twice.
    if (!dashBinding) {
      const twin = (live.components || []).find((c) => !claimed.has(bareId(c.id)) && c.type === component.type && sameParams(c.type, liveTile(c, c.type), added));
      if (twin) {
        plan.refused.push(refusal(tileKey, 'dashboard-tile-match-unpinned', 'a live tile already shows this target; set the tile\'s componentId to adopt it'));
        continue;
      }
    }
    entry.baseline = projectionBaseline(added);
    entry.action = 'create';
    entry.appendIndex = appendAt;
    appendAt += 1;
    writes += 1;
    plan.tiles.push(entry);
    plan.operations.push(operation({ key: tileKey, kind: TILE_KIND, target: null, action: 'create' }));
  }

  const liveRoot = { description: String(live.description || '') };
  const want = rootDescription(dashboard);
  const desiredRoot = { description: want !== undefined ? want : liveRoot.description };
  plan.rootBaseline = projectionBaseline(desiredRoot);
  if (desiredRoot.description !== liveRoot.description) {
    if (partsDriftVerdict(dashBinding, liveRoot, desiredRoot) === 'drift' && !isAuthorized(ctx.authorizedOverwrite, key)) {
      plan.refused.push(refusal(key, 'dashboard-drift', 'the dashboard description was changed outside the spec; refresh the spec or approve the overwrite'));
    } else {
      plan.description = want;
      writes += 1;
    }
  }
  if (plan.refused.length) return plan;
  if (writes === 0) {
    plan.action = 'noChange';
    plan.bindUnchanged = bindsUnchanged(dashBinding, ctx, key, pinned);
    return plan;
  }
  if (!dashBinding && !pinned && !isAuthorized(ctx.authorizedAdoption, key)) {
    plan.refused.push(refusal(key, 'dashboard-adoption-not-authorized', 'the dashboard exists and is not yet managed by this spec; approve adopting it first'));
    return plan;
  }
  plan.action = 'update';
  plan.operations.push(operation({ key, kind: KIND, target: plan.dashboardId, action: 'update', publicationScopes: [{ type: KIND, id: plan.dashboardId }] }));
  return plan;
}

/** A dashboard with no binding and no id from the build: every tile is a child of its create. */
function planDashboardCreate(plan, dashboard, resolveTile, toComponent) {
  const tiles = dashboard.tiles || [];
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    const tileKey = `${plan.key}/${tile.key}`;
    if (tile.componentId !== undefined) {
      plan.refused.push(refusal(tileKey, 'dashboard-tile-pinned-not-found', 'the tile names a control on a dashboard this build did not find; remove the componentId or bind the dashboard'));
      continue;
    }
    let component;
    try {
      component = toComponent(resolveTile(tile), i);
    } catch {
      plan.refused.push(refusal(tileKey, 'dashboard-tile-unresolved', 'the tile\'s view, chart or web resource could not be resolved'));
      continue;
    }
    plan.tiles.push({ tile, tileKey, component, action: 'create', origin: 'created' });
  }
  if (plan.refused.length) return plan;
  const description = rootDescription(dashboard);
  plan.action = 'create';
  plan.createArtifact = { name: dashboard.name, ...(description !== undefined ? { description } : {}) };
  plan.operations.push(operation({ key: plan.key, kind: KIND, target: null, action: 'create', publicationScopes: [{ type: KIND }] }));
  return plan;
}

/** Re-read a dashboard and return its live components by bare control id, or null when unreadable. */
async function rereadDashboard(sdk, id) {
  try {
    await sdk.fetchArtifact(KIND, id);
    const art = await sdk.getArtifact(KIND, id);
    if (!art) return null;
    return { art, byId: new Map((art.components || []).map((c) => [bareId(c.id), c])) };
  } catch {
    return null;
  }
}

/**
 * Bindings for the dashboard and the tiles whose controls are on it now, from a re-read: what a
 * created or adopted row actually holds is what the next run compares with.
 */
function bindingsFromLive(ctx, plan, id, live, idOf, origin) {
  const out = [];
  for (const e of plan.tiles) {
    const c = live.byId.get(bareId(idOf(e)));
    if (!c) continue;
    const parts = liveTile(c, c.type);
    out.push(bindingRecord(ctx, { kind: TILE_KIND, key: e.tileKey, id: bareId(c.id), parentKey: plan.key, origin: idOf(e) === e.liveId ? e.origin : origin, ...projectionBaseline(parts) }));
  }
  out.push(bindingRecord(ctx, { kind: KIND, key: plan.key, id: bareId(id), origin: plan.origin || origin, ...projectionBaseline({ description: String(live.art.description || '') }) }));
  return out;
}

/** Create a missing declared dashboard with its tiles through the creation-identity port. */
async function applyDashboardCreate(plan, sdk, ctx, result) {
  let saved = false;
  const created = await createThroughPort(ctx, { kind: KIND, key: plan.key, identity: [plan.createArtifact.name], childKeys: plan.tiles.map((e) => e.tileKey) }, async ({ id, childIds }) => {
    const art = await sdk.createArtifact(KIND, { ...plan.createArtifact, id });
    // The port recorded `id` before this send; a dashboard stored under another id could not be recovered.
    if (normalizeGuid(art && art.id) !== normalizeGuid(id)) return { outcome: 'refused', code: 'CREATE_ID_NOT_KEPT' };
    for (const e of plan.tiles) await sdk.addElement(KIND, id, '/components', { ...e.component, id: childIds[e.tileKey] });
    if (ctx.witness && typeof ctx.witness === 'function') {
      ctx.witness({ kind: KIND, key: plan.key, id, expected: await expectedDashboardProjection(sdk, id) });
    }
    const pushed = await pushChecked(sdk, KIND, id);
    saved = pushed.outcome === 'saved';
    return pushed;
  });
  const id = created.id ? normalizeGuid(created.id) || String(created.id) : null;
  const childIdOf = (e) => (created.childIds || {})[e.tileKey];
  if (created.status === 'created' && saved) {
    const scope = { type: KIND, id };
    result.saved.push({ key: plan.key, kind: KIND, id, created: true, tiles: plan.tiles.map((e) => e.tile.key), description: plan.createArtifact.description !== undefined });
    queuePublication(ctx, scope);
    result.pendingPublish.push({ key: plan.key, scope });
    const live = await rereadDashboard(sdk, id);
    if (live) result.managedBindings.push(...bindingsFromLive(ctx, plan, id, live, childIdOf, 'created'));
    else result.unknown.push(refusal(plan.key, 'dashboard-created-unreadable', 'the dashboard was created but could not be read back to record its baseline'));
  } else if (created.status === 'adopted') {
    const live = id ? await rereadDashboard(sdk, id) : null;
    if (live) {
      result.managedBindings.push(...bindingsFromLive(ctx, plan, id, live, childIdOf, 'created'));
      result.refused.push(refusal(plan.key, 'creation-adopted-rerun', 'the dashboard an earlier create made was bound; run again to apply the spec to it'));
    } else {
      result.refused.push(refusal(plan.key, 'creation-adopted-row-missing', 'the dashboard the resolved create named could not be read; repair the binding explicitly'));
    }
  } else if (created.status === 'refused') {
    result.refused.push({ ...refusal(plan.key, /^creation-/.test(created.code) ? created.code : 'dashboard-create-refused', 'the dashboard was not created; nothing was written'), rules: created.rules || [] });
  } else {
    result.unknown.push(refusal(plan.key, 'dashboard-write-unknown', 'the dashboard create did not report its outcome; check the dashboards'));
  }
  return result;
}

/**
 * Apply a dashboard plan. A plan with any refusal or unknown writes nothing.
 * `ctx.witness({kind, key, id, expected})`, when given, receives the artifact as it stands right
 * before the push: the `expected` an `inspectArtifact('dashboard', id, { expected })` compares the
 * saved row with.
 */
async function applyDashboardReconcile(plan, { sdk }, ctx = {}) {
  const result = emptyResult();
  result.refused.push(...plan.refused);
  result.unknown.push(...plan.unknown);
  if (plan.refused.length || plan.unknown.length || !plan.action) return result;
  if (plan.action === 'create') return applyDashboardCreate(plan, sdk, ctx, result);
  const id = plan.dashboardId;
  const tileRecord = (e, controlId, origin) => bindingRecord(ctx, { kind: TILE_KIND, key: e.tileKey, id: bareId(controlId), parentKey: plan.key, origin, ...e.baseline });
  const dashRecord = () => bindingRecord(ctx, { kind: KIND, key: plan.key, id, origin: plan.origin, ...plan.rootBaseline });
  if (plan.action === 'noChange') {
    result.unchanged.push({ key: plan.key, kind: KIND, id });
    if (!plan.bindUnchanged) return result;
    for (const e of plan.tiles) result.managedBindings.push(tileRecord(e, e.liveId, e.origin));
    result.managedBindings.push(dashRecord());
    return result;
  }
  const creates = plan.tiles.filter((e) => e.action === 'create');
  const write = async (minted) => {
    try {
      for (const e of plan.tiles.filter((t) => t.action === 'update')) {
        for (const part of e.changed) {
          const value = part.startsWith('parameters/') ? e.component.parameters[part.slice('parameters/'.length)] : e.tile[part];
          await sdk.updateElement(KIND, id, `/components/${e.index}/${part}`, value);
        }
      }
      for (const e of creates) await sdk.addElement(KIND, id, '/components', { ...e.component, id: minted[e.tileKey] });
      if (plan.description !== undefined) await sdk.updateElement(KIND, id, '/description', plan.description);
    } catch (err) {
      return { outcome: 'refused', code: 'VALIDATION_ERROR', rules: rulesOf(err) };
    }
    if (ctx.witness && typeof ctx.witness === 'function') {
      ctx.witness({ kind: KIND, key: plan.key, id, expected: await expectedDashboardProjection(sdk, id) });
    }
    return pushIfChanged(sdk, KIND, id);
  };
  let pushed;
  let minted = {};
  if (creates.length) {
    const run = await createThroughPort(ctx, { kind: TILE_KIND, key: plan.key, identity: [id], childKeys: creates.map((e) => e.tileKey) }, async (ids) => {
      minted = ids.childIds;
      pushed = await write(ids.childIds);
      return pushed;
    });
    if (run.status === 'adopted') {
      // The maker resolved an earlier lost tile create by naming the controls it made: nothing is
      // written now; the named controls that are on the dashboard are bound and the next run edits.
      const live = await rereadDashboard(sdk, id);
      if (live) {
        result.managedBindings.push(...bindingsFromLive(ctx, { ...plan, tiles: creates }, id, live, (e) => (run.childIds || {})[e.tileKey], 'created'));
        result.refused.push(refusal(plan.key, 'creation-adopted-rerun', 'the tiles an earlier create added were bound; run again to apply the spec'));
      } else {
        result.unknown.push(refusal(plan.key, 'dashboard-unreadable', 'the dashboard could not be read to bind the resolved tiles'));
      }
      return result;
    }
    if (run.status === 'refused' && /^creation-/.test(run.code)) {
      for (const e of creates) result.refused.push(refusal(e.tileKey, run.code, 'a new keyed tile needs the creation-identity port, and it did not allow this create; nothing was written'));
      return result;
    }
    if (run.status === 'unknown' && !pushed) pushed = { outcome: 'unknown' };
  } else {
    pushed = await write({});
  }
  if (!pushed || pushed.outcome === 'unknown') {
    result.unknown.push(refusal(plan.key, 'dashboard-write-unknown', 'the dashboard write did not report its outcome; check the dashboard'));
    return result;
  }
  if (pushed.outcome === 'refused') {
    result.refused.push({ ...refusal(plan.key, 'dashboard-rejected', 'the SDK refused the dashboard edit before anything was sent'), rules: pushed.rules || [] });
    return result;
  }
  const parts = plan.tiles.filter((e) => e.action !== 'noChange').map((e) => e.tile.key);
  if (pushed.outcome === 'saved') {
    result.saved.push({ key: plan.key, kind: KIND, id, tiles: parts, description: plan.description !== undefined });
    const scope = { type: KIND, id };
    queuePublication(ctx, scope);
    result.pendingPublish.push({ key: plan.key, scope });
  } else {
    result.unchanged.push({ key: plan.key, kind: KIND, id });
  }
  for (const e of plan.tiles) {
    result.managedBindings.push(e.action === 'create' ? tileRecord(e, minted[e.tileKey], 'created') : tileRecord(e, e.liveId, e.origin));
  }
  result.managedBindings.push(dashRecord());
  return result;
}
/**
 * The expected projection for the dashboard witness: a deep copy of the workspace artifact as it
 * stands NOW (call it after the edits, before the push). `inspectArtifact('dashboard', id,
 * { expected })` then says whether the saved row holds it. `present` alone is not content equality.
 */
async function expectedDashboardProjection(sdk, id) {
  const art = await sdk.getArtifact(KIND, id);
  return art ? JSON.parse(JSON.stringify(art)) : null;
}

module.exports = {
  isDeclaredDashboard,
  dashboardKey,
  validateDeclaredDashboard,
  planDashboardReconcile,
  applyDashboardReconcile,
  expectedDashboardProjection,
  OWNED_PARAMS,
};
