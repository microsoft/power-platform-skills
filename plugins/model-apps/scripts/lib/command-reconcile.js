'use strict';
// Managed command reconciliation (keyed modern commands).
//
// The legacy commands phase builds a whole bar once and then SKIPS any table that already has a
// bar ("button edits aren't applied on rebuild, recreate to change"), and its builder mints a fresh
// random id for every control on every run and drops an explicit `hidden: false`/`disabled: false`.
// So an author could not rename a button, change its handler, or re-enable it, and two runs could
// never agree on which row a button is.
//
// A command that carries a stable `key` (and every child under it) opts into managed behaviour:
//   * identity is the key path (`<table>/<key>[/<childKey>...]`), mapped to the actual `appactionid`
//     through the managed binding the build persists. A caption is NEVER identity — two buttons may
//     share one, and a rename must keep the row;
//   * an existing control is adopted only by an explicit `rowId`, or by exactly one proven context
//     match (same parent, bar, type and JavaScript action — library, function AND the parameters the
//     control would be created with) when the maker approved adoption. Several candidates refuse
//     rather than guess. One handler commonly dispatches on its parameters, so a row that calls the
//     same function with other parameters is another command, not this one;
//   * the full bar is fetched and edited in place, so foreign rows, flyout group rows and every
//     row's residual columns (the SDK's `bag`) are kept;
//   * a declared label/icon/action/parameters/hidden/disabled is applied, explicit `false` included;
//     an omitted one keeps whatever the row holds;
//   * changing an existing row's type or bar is refused (nothing written). The platform cannot
//     change those columns on a row, and delete-and-recreate would lose the row id and any
//     reference to it;
//   * a new child under an existing flyout inherits the flyout's actual Location (the SDK does this
//     when the child states none); a child that states another bar is refused;
//   * nothing is ever removed: a control dropped from the spec stays on the bar;
//   * a run with nothing to change sends no push at all.
//
// SDK facts this relies on (vendored bundle, CommandAdapter/CommandApi):
//   * a fetched control's `id` is derived from the row NAME and is not unique; its row id is the
//     bag's `appactionid` (also in `control.command`) — see rowIdOf;
//   * a push PATCHes every existing emitted row, POSTs new rows and DELETEs rows that were in the
//     fetched snapshot and are now missing — hence "never remove a control from the tree";
//   * a type/location edit on an existing row is refused before any write
//     (COMMAND_IMMUTABLE_COLUMN_CHANGED) and a new child at another Location than its parent is
//     refused too (COMMAND_CHILD_LOCATION_MISMATCH). This module refuses both itself, earlier, so
//     the outcome is a per-control refusal and not a failed push.
//   * a new control's `id` becomes its `appactionid`. New ids come from the build's creation port
//     (`ctx.creates.run`), which records them BEFORE the push so an interrupted run can be resumed
//     against the same rows rather than create a second copy.

const {
  canonicalJson, intentSha256, emptyResult, operation, refusal, isAuthorized,
  lookupBinding, bindingRecord, driftVerdict, pushIfChanged, normalizeGuid, createThroughPort, boundIdentity,
} = require('./reconcile-common.js');

const KIND = 'command';
const KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const BARS = ['MainTab', 'HomeTab', 'ContextualTab'];
const CONTAINER_TYPES = new Set(['FlyoutAnchor', 'SplitButton']);
const TYPES = new Set(['Button', 'FlyoutAnchor', 'SplitButton']);
// The inspection surface each bar is written to (types/inspection.ts: MainTab -> form 0,
// HomeTab -> homeGrid 1, ContextualTab -> subGrid 2).
const SURFACE_OF_BAR = { MainTab: 'form', HomeTab: 'homeGrid', ContextualTab: 'subGrid' };
const KIND_OF_TYPE = { Button: 'button', FlyoutAnchor: 'flyout', SplitButton: 'split' };

/** The bar a stored numeric Location belongs to — the SDK's own locationToBar (0/4 form, 1/5 home grid, else contextual). */
function barOfLocation(location) {
  if (location === 0 || location === 4) return 'MainTab';
  if (location === 1 || location === 5) return 'HomeTab';
  return 'ContextualTab';
}

function bagValue(bag, key) {
  if (!bag || !Array.isArray(bag.a)) return undefined;
  for (const [k, v] of bag.a) if (k === key) return v;
  return undefined;
}

/**
 * The persisted row id of a fetched control: the bag's `appactionid`, else `command`, else `id` —
 * the SDK's effectiveRowId. `control.id` alone is NOT unique (it is derived from the row name).
 */
function rowIdOf(control) {
  const bagged = bagValue(control && control.bag, 'appactionid');
  const raw = (typeof bagged === 'string' && bagged.trim()) ? bagged : (control && (control.command || control.id));
  return normalizeGuid(raw) || String(raw || '').toLowerCase();
}

/** True when an entity's commands opt into managed behaviour (any of them carries a key). */
function isManagedEntity(cmds) {
  const keyed = (c) => !!(c && (c.key !== undefined || (Array.isArray(c.children) && c.children.some(keyed))));
  return (cmds || []).some(keyed);
}

/**
 * Validation of the managed command fields. Pure; the app-spec validator calls it.
 * @returns {{ errors: string[], warnings: string[] }}
 */
function validateManagedCommands(spec) {
  const errors = [];
  const warnings = [];
  const byEntity = new Map();
  for (const c of (spec && spec.commands) || []) {
    const e = String((c && c.entity) || '').toLowerCase();
    if (!byEntity.has(e)) byEntity.set(e, []);
    byEntity.get(e).push(c);
  }
  for (const [entity, cmds] of byEntity) {
    if (!isManagedEntity(cmds)) {
      for (const c of cmds) if (c && c.rowId !== undefined) errors.push(`commands: '${entity}' — rowId is only allowed on a command that has a key`);
      continue;
    }
    const rowIds = new Set();
    const walk = (list, parentPath, parentBar, where) => {
      const seen = new Set();
      for (const c of list) {
        if (!c || typeof c !== 'object') continue;
        if (typeof c.key !== 'string' || !KEY_RE.test(c.key)) {
          errors.push(`commands: '${entity}'${where} — every command on a table with keyed commands needs a key (letters, digits, '_', '.', '-'; at most 64)`);
          continue;
        }
        const keyPath = parentPath ? `${parentPath}/${c.key}` : c.key;
        if (seen.has(c.key)) errors.push(`commands: '${entity}' — key '${keyPath}' is used twice`);
        seen.add(c.key);
        const type = c.type || 'Button';
        if (!TYPES.has(type)) errors.push(`commands: '${entity}/${keyPath}' — type must be Button, FlyoutAnchor or SplitButton`);
        if (c.location !== undefined && !BARS.includes(c.location)) errors.push(`commands: '${entity}/${keyPath}' — location must be MainTab, HomeTab or ContextualTab`);
        const bar = parentBar || c.location || 'MainTab';
        if (parentBar && c.location !== undefined && c.location !== parentBar) {
          errors.push(`commands: '${entity}/${keyPath}' — a child is served only at its parent's location (${parentBar}); it cannot state ${c.location}`);
        }
        for (const flag of ['hidden', 'disabled']) {
          if (c[flag] !== undefined && typeof c[flag] !== 'boolean') errors.push(`commands: '${entity}/${keyPath}' — ${flag} must be true or false`);
        }
        if (c.rowId !== undefined) {
          const id = normalizeGuid(c.rowId);
          if (!id) errors.push(`commands: '${entity}/${keyPath}' — rowId must be a GUID`);
          else if (rowIds.has(id)) errors.push(`commands: '${entity}/${keyPath}' — rowId is used by another command`);
          else rowIds.add(id);
        }
        if (c.position !== undefined || c.after !== undefined || c.before !== undefined) {
          errors.push(`commands: '${entity}/${keyPath}' — placing a control at a position in an existing bar is not supported; new controls are appended`);
        }
        if (Array.isArray(c.children) && c.children.length) {
          if (!CONTAINER_TYPES.has(type)) errors.push(`commands: '${entity}/${keyPath}' — only a FlyoutAnchor or SplitButton has children`);
          walk(c.children, keyPath, bar, ` under '${keyPath}'`);
        }
      }
    };
    walk(cmds, '', '', '');
  }
  return { errors, warnings };
}

/** The desired tree of one entity's commands, with actions resolved to web-resource ids. */
function desiredTree(entity, cmds, opts, refused) {
  const webResources = (opts && opts.webResources) || {};
  const build = (c, parentPath, parentBar) => {
    const keyPath = parentPath ? `${parentPath}/${c.key}` : c.key;
    const bar = parentBar || c.location || 'MainTab';
    const node = {
      keyPath,
      bindingKey: `${entity}/${keyPath}`,
      rowId: c.rowId !== undefined ? normalizeGuid(c.rowId) : '',
      type: c.type || 'Button',
      label: c.label,
      icon: c.icon,
      hidden: typeof c.hidden === 'boolean' ? c.hidden : undefined,
      disabled: typeof c.disabled === 'boolean' ? c.disabled : undefined,
      bar,
      isChild: !!parentBar,
      action: undefined,
      children: [],
    };
    if (c.library && c.function) {
      const wrId = normalizeGuid(webResources[c.library]);
      if (!wrId) refused.push(refusal(node.bindingKey, 'command-web-resource-missing', 'the command names a web resource this build has no id for; declare it in webResources'));
      node.action = { webResourceId: wrId, functionName: String(c.function), parameters: c.parameters };
    }
    if (Array.isArray(c.children)) node.children = c.children.map((ch) => build(ch, keyPath, bar));
    return node;
  };
  return (cmds || []).map((c) => build(c, '', ''));
}

/** Every control of a fetched bar, by row id, with its parent row id and bar. */
function indexLive(artifact) {
  const byRow = new Map();
  const visit = (control, parentRowId, bar, menuPath) => {
    const rowId = rowIdOf(control);
    const stored = bagValue(control.bag, 'location');
    const liveBar = typeof stored === 'number' ? barOfLocation(stored) : (typeof control.location === 'number' ? barOfLocation(control.location) : bar);
    const entry = { control, rowId, parentRowId, bar: liveBar, menuPath };
    if (rowId) byRow.set(rowId, entry);
    for (const ch of control.children || []) visit(ch, rowId, liveBar, [...menuPath, control.label || '']);
  };
  for (const b of (artifact && artifact.commandBars) || []) {
    for (const g of b.groups || []) for (const c of g.controls || []) visit(c, null, b.location, []);
  }
  return byRow;
}

function paramsCanon(p) {
  if (p === undefined || p === null) return '';
  if (typeof p === 'string') {
    try { return canonicalJson(JSON.parse(p)); } catch { return p; }
  }
  return canonicalJson(p);
}

function actionSig(action) {
  if (!action || !action.functionName) return '';
  return `${normalizeGuid(action.webResourceId)}|${action.functionName}`;
}

/** The parameters a node's control runs with: the stated ones, else the bar default a new control gets. */
function effectiveParameters(node, defaultParameters) {
  if (!node.action) return undefined;
  if (node.action.parameters !== undefined) return node.action.parameters;
  const defaults = defaultParameters || {};
  return defaults[node.bar] !== undefined ? defaults[node.bar] : defaults.MainTab;
}

/** The owned fields of a control — what a binding's intentSha256 covers. */
function ownedProjection(control) {
  const a = control && control.action;
  return {
    type: control && control.type,
    label: control && control.label !== undefined ? String(control.label) : '',
    icon: (control && control.icon) || '',
    action: a && a.functionName
      ? { webResourceId: normalizeGuid(a.webResourceId), functionName: a.functionName, parameters: paramsCanon(a.parameters) }
      : null,
    hidden: !!(control && control.hidden === true),
    disabled: !!(control && control.disabled === true),
  };
}

/** The edits a desired node makes to a live control (declared fields only). Returns the patch object. */
function editsFor(node, live) {
  const patch = {};
  if (node.label !== undefined && String(node.label) !== String(live.label || '')) patch.label = node.label;
  if (node.icon !== undefined && String(node.icon || '') !== String(live.icon || '')) patch.icon = node.icon;
  if (node.action) {
    const la = live.action || {};
    const sameRes = normalizeGuid(la.webResourceId) === node.action.webResourceId;
    const sameFn = la.functionName === node.action.functionName;
    const sameParams = node.action.parameters === undefined || paramsCanon(la.parameters) === paramsCanon(node.action.parameters);
    if (!sameRes || !sameFn || !sameParams) {
      patch.action = {
        type: 'javascript',
        webResourceId: node.action.webResourceId,
        functionName: node.action.functionName,
        parameters: node.action.parameters !== undefined ? node.action.parameters : la.parameters,
      };
    }
  }
  // A stored flag the row does not carry reads as false (the platform default), so an explicit
  // false over an absent flag is not a change; an explicit false over a stored true IS, and is sent.
  if (node.hidden !== undefined && node.hidden !== (live.hidden === true)) patch.hidden = node.hidden;
  if (node.disabled !== undefined && node.disabled !== (live.disabled === true)) patch.disabled = node.disabled;
  return patch;
}

/**
 * Resolve every desired node to a live row (or to "new"), without writing anything.
 * @param {object} [defaultParameters]  bar -> default parameters text (what a new control would run with)
 * @returns {Promise<{ resolved: Map<string, object>, refused: object[] }>}
 */
async function resolveManagedCommands(entity, nodes, liveIndex, ctx, defaultParameters) {
  const resolved = new Map(); // keyPath -> { node, live|null, origin, binding }
  const refused = [];
  const claimed = new Set();
  // Mark a node and its whole subtree as not applicable: a child cannot be placed under a parent
  // that was not resolved.
  const block = (node, live, origin, binding, code, message) => {
    if (code) refused.push(refusal(node.bindingKey, code, message));
    resolved.set(node.keyPath, { node, live, origin, binding, blocked: true });
    for (const ch of node.children) block(ch, null, 'created', null, '', '');
  };
  const visit = async (node, parentRowId, parentIsNew) => {
    let live = null;
    let origin = 'created';
    const binding = await lookupBinding(ctx, KIND, node.bindingKey);
    if (binding) {
      // The binding names the row; an explicit rowId naming ANOTHER row contradicts it. Editing the
      // bound row would ignore what the maker wrote, and following the pin would orphan the bound
      // row, so the contradiction is refused before anything is resolved or written.
      const { refusal: conflict } = boundIdentity(binding, { pinnedId: node.rowId, code: 'command-binding-mismatch', key: node.bindingKey });
      if (conflict) return block(node, null, 'adopted', binding, conflict.code, conflict.message);
      live = liveIndex.get(normalizeGuid(binding.id) || String(binding.id).toLowerCase()) || null;
      origin = binding.origin === 'adopted' ? 'adopted' : 'created';
      if (!live) {
        // The bound row is gone. Creating a new one would mint a new identity the maker has not
        // chosen, so this needs an explicit repair decision (the creation port's resolution route).
        return block(node, null, origin, binding, 'command-bound-row-missing', 'the row this command is bound to is not on the bar; repair the binding explicitly before it can be recreated');
      }
    } else if (node.rowId) {
      live = liveIndex.get(node.rowId) || null;
      origin = 'adopted';
      if (!live) return block(node, null, origin, null, 'command-row-not-found', 'no control with the stated rowId is on this table\'s bar');
    } else if (!parentIsNew && node.action) {
      // Context adoption: same parent, same bar, same type, same JavaScript library + function +
      // parameters (the stated ones, else the bar default this control would be created with).
      // A caption is deliberately not part of it. A control without an action has no context
      // strong enough to prove it is "the same" control, so it is never adopted this way.
      const want = actionSig(node.action);
      const wantParams = paramsCanon(effectiveParameters(node, defaultParameters));
      const candidates = [...liveIndex.values()].filter((e) => !claimed.has(e.rowId)
        && e.parentRowId === parentRowId
        && (parentRowId !== null || e.bar === node.bar)
        && e.control.type === node.type
        && actionSig(e.control.action) === want
        && paramsCanon(e.control.action && e.control.action.parameters) === wantParams);
      if (candidates.length > 1) {
        return block(node, null, 'adopted', null, 'command-adoption-ambiguous', 'several existing controls match this command; name the one to manage with rowId');
      }
      if (candidates.length === 1) {
        if (!isAuthorized(ctx && ctx.authorizedAdoption, node.bindingKey)) {
          return block(node, null, 'adopted', null, 'command-adoption-not-authorized', 'an existing control matches this command; approve adopting it (or name it with rowId) before it is managed');
        }
        live = candidates[0];
        origin = 'adopted';
      }
    }
    if (live) {
      if (claimed.has(live.rowId)) return block(node, null, origin, binding, 'command-row-claimed-twice', 'two commands resolve to the same control');
      claimed.add(live.rowId);
      if (live.parentRowId !== parentRowId) {
        return block(node, live, origin, binding, 'command-parent-changed', 'the control sits under a different parent than the spec declares; moving a control is not supported');
      }
    }
    resolved.set(node.keyPath, { node, live, origin, binding, blocked: false });
    for (const ch of node.children) await visit(ch, live ? live.rowId : null, !live);
    return undefined;
  };
  for (const n of nodes) await visit(n, null, false);
  return { resolved, refused };
}

/**
 * Plan the managed reconciliation of one table's commands. Fetches the bar (GET only).
 * @param {object} args
 * @param {string} args.entity      table logical name (lowercase)
 * @param {object[]} args.commands  the spec's commands for this table
 * @param {object} args.sdk         the build's SDK (fetchArtifact/getArtifact)
 * @param {object} [args.webResources]       web-resource name -> id
 * @param {object} [args.defaultParameters]  bar -> default parameters text for a NEW control with an action
 * @param {object} ctx
 */
async function planCommandReconcile({ entity, commands, sdk, webResources, defaultParameters }, ctx = {}) {
  const ent = String(entity).toLowerCase();
  const plan = { entity: ent, managed: isManagedEntity(commands), operations: [], refused: [], unknown: [], live: null, resolved: null, nodes: [], defaultParameters: defaultParameters || {} };
  if (!plan.managed) return plan;
  const { errors } = validateManagedCommands({ commands: (commands || []).map((c) => ({ ...c, entity: ent })) });
  if (errors.length) {
    plan.refused.push(refusal(`${ent}`, 'command-spec-invalid', 'the keyed commands of this table do not validate; run validation for details'));
    return plan;
  }
  if (!ctx.managed || typeof ctx.managed.lookup !== 'function') {
    plan.refused.push(refusal(`${ent}`, 'managed-binding-port-unavailable', 'keyed commands need the managed-binding store, which this build does not provide'));
    return plan;
  }
  plan.nodes = desiredTree(ent, commands, { webResources }, plan.refused);
  try {
    await sdk.fetchArtifact(KIND, ent);
    plan.live = (await sdk.getArtifact(KIND, ent)) || { id: ent, entityLogicalName: ent, commandBars: [] };
  } catch {
    plan.unknown.push({ key: ent, code: 'command-bar-unreadable' });
    return plan;
  }
  const liveIndex = indexLive(plan.live);
  const { resolved, refused } = await resolveManagedCommands(ent, plan.nodes, liveIndex, ctx, plan.defaultParameters);
  plan.resolved = resolved;
  plan.refused.push(...refused);

  for (const { node, live, binding, blocked } of resolved.values()) {
    if (blocked) continue;
    const target = { table: ent, keyPath: node.keyPath, rowId: live ? live.rowId : null };
    if (!live) {
      // A new child's bar is its parent's by construction (desiredTree), and a child stating
      // another bar fails validation above — so a new child never carries its own Location and
      // the SDK places it at the parent's actual one.
      plan.operations.push(operation({ key: node.bindingKey, kind: KIND, target, action: 'create' }));
      continue;
    }
    if (live.control.type !== node.type) {
      plan.refused.push(refusal(node.bindingKey, 'command-immutable-type', 'an existing control\'s type cannot be changed; nothing was written'));
      continue;
    }
    if (!node.isChild && live.bar !== node.bar) {
      plan.refused.push(refusal(node.bindingKey, 'command-immutable-location', 'an existing control cannot move to another command bar; nothing was written'));
      continue;
    }
    const patch = editsFor(node, live.control);
    const finalSha = intentSha256(ownedProjection({ ...live.control, ...patch }));
    const verdict = driftVerdict(binding, intentSha256(ownedProjection(live.control)), finalSha);
    if (verdict === 'drift' && Object.keys(patch).length && !isAuthorized(ctx.authorizedOverwrite, node.bindingKey)) {
      plan.refused.push(refusal(node.bindingKey, 'command-drift', 'the control was changed outside this spec since it was last applied; refresh the spec or approve overwriting it'));
      continue;
    }
    plan.operations.push(operation({ key: node.bindingKey, kind: KIND, target, action: Object.keys(patch).length ? 'update' : 'noChange' }));
    live.patch = patch;
  }
  return plan;
}

function newControl(node, id, defaultParameters) {
  const control = { id, command: id, type: node.type, label: node.label !== undefined ? node.label : '' };
  if (node.icon) control.icon = node.icon;
  if (node.action) {
    control.action = {
      type: 'javascript',
      webResourceId: node.action.webResourceId,
      functionName: node.action.functionName,
      parameters: effectiveParameters(node, defaultParameters),
    };
  }
  // Explicit booleans are written as given — `false` included — so the row's stored state is the
  // spec's, not whatever the platform defaults to.
  if (node.hidden !== undefined) control.hidden = node.hidden;
  if (node.disabled !== undefined) control.disabled = node.disabled;
  return control;
}

/**
 * Apply a plan. Refusals stop the WHOLE table (a partial bar edit is not offered): a refused
 * control means nothing on that bar is written, which keeps "refused" meaning "not applied".
 * @returns {Promise<object>} FeatureResult
 */
async function applyCommandReconcile(plan, { sdk }, ctx = {}) {
  const result = emptyResult();
  if (!plan.managed) return result;
  result.refused.push(...plan.refused);
  result.unknown.push(...plan.unknown);
  if (plan.refused.length || plan.unknown.length || !plan.live) return result;

  const creates = plan.operations.filter((o) => o.action === 'create');
  const updates = plan.operations.filter((o) => o.action === 'update');
  const bindingsFor = (ids) => {
    const out = [];
    for (const { node, live, origin } of plan.resolved.values()) {
      const id = live ? live.rowId : ids && ids[node.keyPath];
      if (!id) continue;
      const parentKey = node.isChild ? `${plan.entity}/${node.keyPath.split('/').slice(0, -1).join('/')}` : undefined;
      const state = live ? { ...live.control, ...(live.patch || {}) } : newControl(node, id, plan.defaultParameters);
      out.push(bindingRecord(ctx, { kind: KIND, key: node.bindingKey, id, parentKey, intentSha256: intentSha256(ownedProjection(state)), origin: live ? origin : 'created' }));
    }
    return out;
  };

  if (!creates.length && !updates.length) {
    for (const o of plan.operations) result.unchanged.push({ key: o.key, kind: KIND, id: o.target.rowId });
    result.managedBindings.push(...bindingsFor(null));
    return result;
  }
  if (creates.length && (!ctx.creates || typeof ctx.creates.run !== 'function')) {
    for (const o of creates) result.refused.push(refusal(o.key, 'creation-port-unavailable', 'a new keyed control needs the creation-identity port, which this build does not provide'));
    return result;
  }

  // Edit a deep copy of the fetched tree: updates in place, new controls appended.
  const bars = JSON.parse(JSON.stringify(plan.live.commandBars || []));
  const editedIndex = indexLive({ commandBars: bars });
  const write = async (ids) => {
    for (const { node, live } of plan.resolved.values()) {
      if (live && live.patch && Object.keys(live.patch).length) Object.assign(editedIndex.get(live.rowId).control, live.patch);
    }
    const created = new Map();
    const place = (node, parentControl) => {
      const control = newControl(node, ids[node.keyPath], plan.defaultParameters);
      created.set(node.keyPath, control);
      if (parentControl) {
        parentControl.children = parentControl.children || [];
        parentControl.children.push(control);
      } else {
        let bar = bars.find((b) => b.location === node.bar);
        if (!bar) { bar = { location: node.bar, groups: [] }; bars.push(bar); }
        if (!bar.groups.length) bar.groups.push({ id: '', title: '', controls: [] });
        bar.groups[0].controls = bar.groups[0].controls || [];
        bar.groups[0].controls.push(control);
      }
    };
    // Pre-order, so a new parent exists before its new children are placed under it.
    const walk = (node, parentControl) => {
      const r = plan.resolved.get(node.keyPath);
      if (!r || r.blocked) return;
      let here = null;
      if (r.live) here = editedIndex.get(r.live.rowId).control;
      else { place(node, parentControl); here = created.get(node.keyPath); }
      for (const ch of node.children) walk(ch, here);
    };
    for (const n of plan.nodes) walk(n, null);
    await sdk.updateElement(KIND, plan.entity, '/commandBars', bars);
    return pushIfChanged(sdk, KIND, plan.entity);
  };

  let pushed;
  let ids = null;
  if (creates.length) {
    // One create operation per table: the new controls are its child slots, keyed by key path, so a
    // re-run after a lost answer sends the same rows again under the same ids.
    const created = await createThroughPort(ctx, { kind: KIND, key: plan.entity, identity: [plan.entity], childKeys: creates.map((o) => o.target.keyPath) }, async (minted) => {
      ids = minted.childIds;
      return write(minted.childIds);
    });
    if (created.status === 'adopted') return recordAdopted(plan, sdk, ctx, created.childIds, result);
    if (created.status === 'refused') {
      if (/^creation-/.test(created.code)) result.refused.push(refusal(plan.entity, created.code, 'the creation-identity port did not allow creating controls on this bar now; nothing was written'));
      else for (const o of [...creates, ...updates]) result.refused.push(refusal(o.key, created.code || 'PUSH_NOT_SAVED', 'the command bar push was refused; nothing was written'));
      return result;
    }
    if (created.status === 'unknown') {
      for (const o of [...creates, ...updates]) result.unknown.push({ key: o.key, code: created.code || 'WRITE_OUTCOME_UNKNOWN' });
      return result;
    }
    ids = ids || created.childIds;
  } else {
    try {
      pushed = await write({});
    } catch (err) {
      const code = err && typeof err.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(err.code) ? err.code : 'WRITE_OUTCOME_UNKNOWN';
      for (const o of updates) result.unknown.push({ key: o.key, code });
      return result;
    }
    if (!pushed || pushed.outcome === 'unknown') {
      for (const o of updates) result.unknown.push({ key: o.key, code: (pushed && pushed.code) || 'WRITE_OUTCOME_UNKNOWN' });
      return result;
    }
    if (pushed.outcome === 'refused') {
      for (const o of updates) result.refused.push(refusal(o.key, pushed.code || 'PUSH_NOT_SAVED', 'the command bar push was refused; nothing was written'));
      return result;
    }
  }
  for (const o of plan.operations) {
    const id = o.target.rowId || (ids && ids[o.target.keyPath]) || null;
    (o.action === 'noChange' ? result.unchanged : result.saved).push({ key: o.key, kind: KIND, id });
  }
  result.managedBindings.push(...bindingsFor(ids));
  return result;
}

/**
 * The maker resolved an earlier create of this bar whose answer was lost by naming the rows it made
 * (the port's `adopt` resolution). Nothing is written now: the bar is re-read, every named row that
 * is really there is bound to the spec's key (with the baseline of what it holds now), and the run
 * reports `creation-adopted-rerun` so a second run reconciles those rows like any bound control.
 */
async function recordAdopted(plan, sdk, ctx, childIds, result) {
  let index;
  try {
    await sdk.fetchArtifact(KIND, plan.entity);
    index = indexLive((await sdk.getArtifact(KIND, plan.entity)) || { commandBars: [] });
  } catch {
    result.unknown.push({ key: plan.entity, code: 'command-bar-unreadable' });
    return result;
  }
  let missing = false;
  for (const { node, live } of plan.resolved.values()) {
    if (live) continue;
    const id = normalizeGuid(childIds && childIds[node.keyPath]);
    const row = id && index.get(id);
    if (!row) { missing = true; continue; }
    const parentKey = node.isChild ? `${plan.entity}/${node.keyPath.split('/').slice(0, -1).join('/')}` : undefined;
    result.managedBindings.push(bindingRecord(ctx, { kind: KIND, key: node.bindingKey, id, parentKey, intentSha256: intentSha256(ownedProjection(row.control)), origin: 'created' }));
  }
  result.refused.push(missing
    ? refusal(plan.entity, 'creation-adopted-row-missing', 'a control the resolved create named is not on the bar; repair the binding explicitly before it can be created')
    : refusal(plan.entity, 'creation-adopted-rerun', 'the controls an earlier create made were bound; run again to apply the spec to them'));
  return result;
}

/**
 * The inspection queries that VERIFY managed controls: one per bound control, by row id
 * (the identity), with the caption only as the cross-check the SDK compares exactly. `expect`
 * says what the stored state should make the inspection answer. Each flag is TRI-STATE: an omitted
 * spec flag leaves whatever the row holds, so the spec cannot predict it and the expectation is
 * `undefined` — "not constrained", never a guessed `false`:
 *   served: false when the control or an ancestor is declared disabled — the runtime serves an
 *           `isdisabled` row on no surface (SDK inspection docs), so its verdict is not `present`;
 *           true only when the control and every ancestor declare `disabled: false`; else undefined;
 *   hidden: the declared hidden flag, else undefined;
 *   ancestorHidden: true when an ancestor declares `hidden: true`; false when there is no ancestor
 *           or every ancestor declares `hidden: false`; else undefined.
 * A control with no binding yet is not verifiable by id and is left out (caption discovery is not
 * verification).
 *
 * `menuPath` is the captions of the control's flyout/split ancestors, which the SDK compares exactly
 * (an omitted menuPath means "top level"). An ancestor whose caption the spec omits keeps whatever
 * caption its row holds, so the spec cannot predict it: the caption is then read from `live` (the
 * fetched command bar) on the row BOUND to that ancestor — the identity, never a caption search. When
 * it cannot be read that way (no `live`, the ancestor not bound or not on the bar), the descendant is
 * returned with `query: null` and `unverifiable: 'command-ancestor-caption-undeclared'` rather than
 * queried under an invented "" caption, which would call a correctly placed control misplaced.
 * @param {string} entity
 * @param {object[]} commands  the spec's commands for this table
 * @param {(key: string) => (object|null)} bindingOf  managed binding by key
 * @param {object} [live]  the table's fetched command bar (sdk.getArtifact('command', entity))
 */
function expectedCommandQueries(entity, commands, bindingOf, live) {
  const ent = String(entity).toLowerCase();
  const out = [];
  const liveIndex = live ? indexLive(live) : null;
  // The caption an ancestor contributes to its descendants' menuPath, or null when it cannot be known.
  const captionOf = (c, b) => {
    if (c.label !== undefined && c.label !== null) return String(c.label);
    if (!liveIndex || !b || !b.id) return null;
    const row = liveIndex.get(normalizeGuid(b.id) || String(b.id).toLowerCase());
    return row ? String(row.control.label || '') : null;
  };
  // Tri-state folds: true wins; false only when every member is a declared false; else unknown.
  const anyOf = (a, b) => (a === true || b === true ? true : a === false && b === false ? false : undefined);
  const walk = (list, parentPath, bar, menuPath, ancestorDisabled, ancestorHidden) => {
    for (const c of list || []) {
      if (!c || typeof c.key !== 'string') continue;
      const keyPath = parentPath ? `${parentPath}/${c.key}` : c.key;
      const key = `${ent}/${keyPath}`;
      const here = bar || c.location || 'MainTab';
      const b = bindingOf(key);
      const disabled = typeof c.disabled === 'boolean' ? c.disabled : undefined;
      const hidden = typeof c.hidden === 'boolean' ? c.hidden : undefined;
      const disabledHere = anyOf(disabled, ancestorDisabled);
      if (b && b.id && menuPath.includes(null)) {
        out.push({ key, table: ent, query: null, unverifiable: 'command-ancestor-caption-undeclared' });
      } else if (b && b.id) {
        out.push({
          key,
          table: ent,
          query: {
            rowId: normalizeGuid(b.id) || String(b.id),
            surface: SURFACE_OF_BAR[here],
            ...(c.label !== undefined ? { label: String(c.label) } : {}),
            menuPath,
            kind: KIND_OF_TYPE[c.type || 'Button'],
          },
          expect: { served: disabledHere === undefined ? undefined : !disabledHere, hidden, ancestorHidden },
        });
      }
      if (Array.isArray(c.children)) walk(c.children, keyPath, here, [...menuPath, captionOf(c, b)], disabledHere, anyOf(ancestorHidden, hidden));
    }
  };
  walk(commands, '', '', [], false, false);
  return out;
}

module.exports = {
  isManagedEntity,
  validateManagedCommands,
  resolveManagedCommands,
  planCommandReconcile,
  applyCommandReconcile,
  expectedCommandQueries,
  // exported for tests and the verify projection
  rowIdOf,
  ownedProjection,
  indexLive,
};
