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
// Identity of the DASHBOARD itself stays with the build (pinned dashboardId, recorded creations,
// the single-name lookup with its solution check); this module is handed the id it resolved.
// Tile options are resolved by the build's own dashboardTileOpts and turned into a component by its
// dashboardComponent, injected as `resolveTile` / `toComponent` so the mapping exists once.
//
// Measured through the real bundle (dashboard-reconcile-real-bundle.test.js): updateElement on
// `/components/<i>/name|rowspan|parameters/<P>` rewrites only that cell's label/attribute/parameter;
// the foreign custom-control cell, the tab/section bags and the control descriptions come back
// byte-identical; addElement keeps a provided control `id`.

const {
  canonicalJson,
  intentSha256,
  emptyResult,
  operation,
  refusal,
  isAuthorized,
  lookupBinding,
  bindingRecord,
  driftVerdict,
  pushIfChanged,
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
  (dashboard.tiles || []).forEach((t, i) => {
    const at = `tiles[${i}]`;
    if (!t || typeof t.key !== 'string' || !KEY_RE.test(t.key)) errors.push(`${at}: key is required in declared mode (letters, digits, '_', '.', '-'; at most 64)`);
    else if (seen.has(t.key)) errors.push(`${at}: key '${t.key}' is used twice`);
    else seen.add(t.key);
    if (t && t.componentId !== undefined && !normalizeGuid(t.componentId)) errors.push(`${at}: componentId must be a GUID`);
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

/** The owned projection of a declared tile, from the component the build would create for it. */
function desiredTile(tile, component) {
  const out = { type: component.type, parameters: {} };
  for (const p of OWNED_PARAMS[component.type]) out.parameters[p] = paramValue(p, component.parameters[p]);
  if (typeof tile.name === 'string' && tile.name) out.name = tile.name;
  if (tile.colspan) out.colspan = tile.colspan;
  if (tile.rowspan) out.rowspan = tile.rowspan;
  return out;
}

/** The same projection read from a live component, restricted to what `desired` owns. */
function liveTile(component, desired) {
  const out = { type: component.type, parameters: {} };
  for (const p of Object.keys(desired.parameters)) out.parameters[p] = paramValue(p, (component.parameters || {})[p]);
  if (desired.name !== undefined) out.name = component.name;
  if (desired.colspan !== undefined) out.colspan = component.colspan;
  if (desired.rowspan !== undefined) out.rowspan = component.rowspan;
  return out;
}

const sameOwned = (a, b) => canonicalJson(a) === canonicalJson(b);

/**
 * Plan one declared dashboard the build resolved to `dashboardId`. GET only.
 * @param {{ dashboard: object, dashboardId: string, sdk: object, resolveTile: Function, toComponent: Function }} input
 *   resolveTile(tile) -> the build's dashboardTileOpts(spec, tile, result)
 *   toComponent(opts, index) -> the build's dashboardComponent(opts, index)
 */
async function planDashboardReconcile({ dashboard, dashboardId, sdk, resolveTile, toComponent }, ctx = {}) {
  const key = dashboardKey(dashboard);
  const plan = { key, dashboardId: normalizeGuid(dashboardId), action: null, tiles: [], description: undefined, operations: [], refused: [], unknown: [] };
  const errors = validateDeclaredDashboard(dashboard || {});
  if (errors.length || !plan.dashboardId) {
    plan.errors = errors.length ? errors : ['dashboardId is required'];
    plan.refused.push(refusal(key, 'dashboard-spec-invalid', 'the declared dashboard does not compile (see validation)'));
    return plan;
  }
  let live;
  try {
    await sdk.fetchArtifact(KIND, plan.dashboardId);
    live = await sdk.getArtifact(KIND, plan.dashboardId);
  } catch {
    plan.unknown.push(refusal(key, 'dashboard-unreadable', 'the dashboard could not be read'));
    return plan;
  }
  if (!live || live.dashboardType !== 'Standard') {
    plan.refused.push(refusal(key, 'dashboard-interactive-unsupported', 'only a standard dashboard is reconciled; it was left as it is'));
    return plan;
  }
  const dashBinding = await lookupBinding(ctx, KIND, key);
  plan.origin = dashBinding ? dashBinding.origin : 'adopted';
  const pinned = !!dashboard.dashboardId;
  const liveById = new Map((live.components || []).map((c, i) => [bareId(c.id), { c, i }]));
  const claimed = new Set();
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
    const desired = desiredTile(tile, component);
    const desiredSha = intentSha256(desired);
    const binding = await lookupBinding(ctx, TILE_KIND, tileKey);
    const boundId = binding ? bareId(binding.id) : normalizeGuid(tile.componentId);
    const entry = { tile, tileKey, desired, desiredSha, component, origin: binding ? binding.origin : 'adopted' };
    if (boundId) {
      const hit = liveById.get(boundId);
      if (!hit) {
        if (!isAuthorized(ctx.authorizedOverwrite, tileKey)) {
          plan.refused.push(refusal(tileKey, binding ? 'dashboard-tile-missing' : 'dashboard-tile-pinned-not-found', 'the tile this spec manages is no longer on the dashboard; approve adding it again'));
          continue;
        }
      } else {
        claimed.add(boundId);
        entry.liveId = hit.c.id;
        entry.index = hit.i;
        if (hit.c.type !== desired.type) {
          plan.refused.push(refusal(tileKey, 'dashboard-tile-type-change', 'the tile\'s type cannot change in place; remove the tile in Maker or give it a new key'));
          continue;
        }
        const liveOwned = liveTile(hit.c, desired);
        if (sameOwned(liveOwned, desired)) {
          entry.action = 'noChange';
        } else {
          const verdict = driftVerdict(binding, intentSha256(liveOwned), desiredSha);
          if (verdict === 'drift' && !isAuthorized(ctx.authorizedOverwrite, tileKey)) {
            plan.refused.push(refusal(tileKey, 'dashboard-tile-drift', 'an authored part of the tile was changed outside the spec; refresh the spec or approve the overwrite'));
            continue;
          }
          entry.action = 'update';
          entry.changed = changedParts(liveOwned, desired);
          writes += 1;
        }
        plan.tiles.push(entry);
        plan.operations.push(operation({ key: tileKey, kind: TILE_KIND, target: entry.liveId, action: entry.action }));
        continue;
      }
    }
    // A new tile. When this dashboard is not managed yet, a live tile showing the same target is
    // almost certainly this tile created by an earlier build: appending would show it twice.
    if (!dashBinding) {
      const twin = (live.components || []).find((c) => !claimed.has(bareId(c.id)) && c.type === desired.type
        && sameOwned(liveTile(c, { parameters: desired.parameters }).parameters, desired.parameters));
      if (twin) {
        plan.refused.push(refusal(tileKey, 'dashboard-tile-match-unpinned', 'a live tile already shows this target; set the tile\'s componentId to adopt it'));
        continue;
      }
    }
    entry.action = 'create';
    entry.appendIndex = appendAt;
    appendAt += 1;
    writes += 1;
    plan.tiles.push(entry);
    plan.operations.push(operation({ key: tileKey, kind: TILE_KIND, target: null, action: 'create' }));
  }

  if (typeof dashboard.description === 'string' && dashboard.description.trim()) {
    const want = dashboard.description.trim();
    if (String(live.description || '') !== want) {
      plan.description = want;
      writes += 1;
    }
  }
  if (plan.refused.length) return plan;
  if (writes === 0) {
    plan.action = 'noChange';
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

function changedParts(live, desired) {
  const out = [];
  for (const k of ['name', 'colspan', 'rowspan']) if (desired[k] !== undefined && live[k] !== desired[k]) out.push(k);
  for (const p of Object.keys(desired.parameters)) if (live.parameters[p] !== desired.parameters[p]) out.push(`parameters/${p}`);
  return out;
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
  const id = plan.dashboardId;
  const tileRecord = (e, controlId, origin) => bindingRecord(ctx, { kind: TILE_KIND, key: e.tileKey, id: bareId(controlId), parentKey: plan.key, intentSha256: e.desiredSha, origin });
  const dashRecord = () => bindingRecord(ctx, { kind: KIND, key: plan.key, id, intentSha256: intentSha256({ tiles: plan.tiles.map((e) => e.tileKey), description: plan.description }), origin: plan.origin });
  if (plan.action === 'noChange') {
    result.unchanged.push({ key: plan.key, kind: KIND, id });
    for (const e of plan.tiles) result.managedBindings.push(tileRecord(e, e.liveId, e.origin));
    result.managedBindings.push(dashRecord());
    return result;
  }
  const creates = plan.tiles.filter((e) => e.action === 'create');
  if (creates.length && (!ctx.creates || typeof ctx.creates.run !== 'function')) {
    for (const e of creates) result.refused.push(refusal(e.tileKey, 'creation-port-unavailable', 'a new keyed tile needs the creation-identity port, which this build does not provide'));
    return result;
  }
  const write = async (minted) => {
    try {
      for (const e of plan.tiles.filter((t) => t.action === 'update')) {
        for (const part of e.changed) {
          const value = part.startsWith('parameters/') ? e.component.parameters[part.slice('parameters/'.length)] : e.desired[part];
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
  try {
    if (creates.length) {
      const run = await ctx.creates.run({ kind: TILE_KIND, key: plan.key, identity: [id], childKeys: creates.map((e) => e.tileKey) }, async (ids) => {
        minted = ids.childIds;
        return write(ids.childIds);
      });
      pushed = run && run.result;
    } else {
      pushed = await write({});
    }
  } catch (err) {
    if (err && err.code === 'CREATION_PENDING_UNKNOWN') {
      result.refused.push(refusal(plan.key, 'creation-pending-unknown', 'an earlier attempt to add tiles to this dashboard has an unknown outcome; resolve it before writing again'));
    } else {
      result.unknown.push(refusal(plan.key, 'dashboard-write-unknown', 'the dashboard write did not report its outcome; check the dashboard'));
    }
    return result;
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

/**
 * Bindings for a declared dashboard the BUILD just created through its existing path, which adds
 * the spec's tiles in order onto an empty dashboard: component i is tile i. Read from the workspace
 * artifact before the push (the expected projection), so the ids are the ones the push sends.
 */
function createdDashboardBindings({ dashboard, artifact, resolveTile, toComponent }, ctx = {}) {
  const key = dashboardKey(dashboard);
  const comps = (artifact && artifact.components) || [];
  const out = [];
  (dashboard.tiles || []).forEach((tile, i) => {
    if (!tile || !tile.key || !comps[i]) return;
    const desired = desiredTile(tile, toComponent(resolveTile(tile), i));
    out.push(bindingRecord(ctx, { kind: TILE_KIND, key: `${key}/${tile.key}`, id: bareId(comps[i].id), parentKey: key, intentSha256: intentSha256(desired), origin: 'created' }));
  });
  out.push(bindingRecord(ctx, { kind: KIND, key, id: bareId(artifact.id), intentSha256: intentSha256({ tiles: out.map((b) => b.key), description: undefined }), origin: 'created' }));
  return out;
}

module.exports = {
  isDeclaredDashboard,
  dashboardKey,
  validateDeclaredDashboard,
  planDashboardReconcile,
  applyDashboardReconcile,
  expectedDashboardProjection,
  createdDashboardBindings,
  OWNED_PARAMS,
};
