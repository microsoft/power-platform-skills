'use strict';
// Teardown engine: reverse the app-builder build — delete exactly the artifacts a given
// App Spec declares, in dependency-safe order, via the SDK's delete methods. This is the
// first-class, classifier-safe counterpart to the manual delete recipe used during live
// verification: it only ever touches artifacts whose identity is resolved from a name/logical/
// uniquename the spec itself declares (an exact-match queryRecords filter per artifact), so it
// can never wildcard-scan or remove unrelated org data.
//
// Order (each the mirror of the build's create order — dependents before their dependencies):
//   1. app          — the app module (references the sitemap + dashboard/form/view/chart components)
//   2. dashboards    — systemform (type 0) rows, pinned as app components
//   3. commands      — appactions per entity (they reference the web-resource JS; delete first).
//                      The SDK's command delete is ENTITY-keyed (removes every appaction on that
//                      entity's bar in one call), so this passes the entity logical name, not an id.
//   4. forms         — systemform rows per entity (forms reference views/web-resources; deleted before tables)
//   5. charts        — savedqueryvisualization rows per entity (deleted before tables)
//   6. views         — savedquery rows per entity (deleted before tables)
//   7. relationships — OneToMany/ManyToMany relationships (deleted before tables)
//   8. tables        — EntityDefinitions in REVERSE-topological order (a child's lookup references
//                      its parent, so children/referencing tables delete first). Deleting a table
//                      does NOT cascade forms/views/charts/relationships when cross-references exist
//                      (e.g. a form subgrid references another table's view), so teardown deletes
//                      them explicitly first.
//   9. web-resources — webresourceset rows (form/command JS, table-icon SVG/raster images, and the
//                      build's generated default app icon) — deleted AFTER tables: a table's icon
//                      web resource is referenced by the TABLE itself, so it can't be removed until
//                      the table is gone (form JS is referenced by forms, already deleted above).
//  10. global-choices — shared option sets, deleted after the tables whose columns bound them.
//  11. solution      — the (now-empty) solution container, deleted last.
//
// planTeardown(spec) is pure (no I/O) — the dry-run plan + the unit-test surface. runTeardown
// executes it via an injected SDK client and emits the same { phase, status, label, n, total,
// detail? } progress events the build engine does, so the orchestrator narrates teardown with
// the identical phase-grouped, status-marked log.

const { topoOrderEntities } = require('./_graph.js');
const { appUniqueName, commandsByEntity, defaultViewColumns } = require('./sdk-build.js');
const { relationshipSchemaName, manyToManySchemaName, lookupColumnsFor } = require('./app-spec.js');
const { selectSummaryTables } = require('./ai-candidates.js');

// OData v4 string-literal escaping lives in ./odata.js. `odataStr` is kept as a backward-compatible
// alias because it is part of this module's exported (and unit-tested) surface.
const { odataLit } = require('./odata.js');
const odataStr = odataLit;

// Extract a readable error message from an SDK error or exception.
function errMsg(err) {
  if (err && err.message) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

// Detect if an SDK error is a "not found" (404-like) — used to treat already-gone artifacts
// as skips rather than failures. The SDK throws typed errors with status codes.
function isNotFound(err) {
  if (!err) return false;
  const status = err.statusCode || err.status || (err.cause && (err.cause.statusCode || err.cause.status));
  if (status === 404) return true;
  const msg = String((err && err.message) || '').toLowerCase();
  // "...but 0 were found" is Dataverse's signal that the record targeted for delete (e.g. a
  // RelationshipDefinitions metadata id that no longer resolves — already cascaded away) does not
  // exist; treat it as already-gone. Only zero counts (">1 were found" is a genuine ambiguity error).
  return /not found|does not exist|could not find|but 0 were found/.test(msg);
}

// Detect a system/managed artifact that Dataverse refuses to delete (e.g. the auto-generated
// "Active <Entity>" view whose name a spec view may reuse). It is not ours to remove, so a
// teardown skips it instead of failing — the same best-effort spirit as isNotFound. Deliberately
// NARROW: it must NOT match a dependency block ("...cannot be deleted because it is referenced by
// N other components"), which is a genuine leftover the teardown must surface, not swallow.
function isUndeletable(err) {
  if (!err) return false;
  const msg = String((err && err.message) || '').toLowerCase();
  if (/referenced by/.test(msg)) return false; // dependency block — a real failure, not a system artifact
  return /system-defined|system managed|system-managed/.test(msg);
}

// Before deleting a MAIN form the build promoted to the entity default (Gap 2), restore a stock
// main form as the active default — Dataverse refuses to delete the default form and refuses to
// leave a table with zero active main forms. Reactivates any deactivated stock forms and re-defaults
// one of them, which demotes our form so it becomes deletable. Best-effort: a failure just means the
// subsequent delete may report the platform's own error. Mirrors the build's promoteDefaultForm.
async function restoreStockMainForm(sdk, entityLogical, formIdToDelete) {
  if (typeof sdk.queryRecords !== 'function' || typeof sdk.updateRecord !== 'function') return;
  let forms;
  try {
    forms = await sdk.queryRecords('systemform', {
      select: ['formid', 'formactivationstate', 'isdefault'],
      filter: `objecttypecode eq '${odataStr(entityLogical)}' and type eq 2`,
      top: 50,
    });
  } catch {
    return;
  }
  const others = (forms || []).filter((f) => String(f.formid) !== String(formIdToDelete));
  for (const f of others) {
    if (f.formactivationstate !== 1) {
      try { await sdk.updateRecord('systemform', String(f.formid), { formactivationstate: 1 }); } catch { /* best-effort */ }
    }
  }
  if (others[0]) {
    try { await sdk.updateRecord('systemform', String(others[0].formid), { isdefault: true }); } catch { /* best-effort */ }
  }
}

// Per-kind resolve (id lookup via sdk.resolveArtifact) + delete handlers via SDK methods.
// `resolve` returns the concrete artifacts to delete ([] when nothing matches — already gone /
// never built). `del` deletes one. A not-found error on delete is tolerated as "already gone"
// (e.g. a flyout appaction cascade removes its child buttons) — except for tables, whose
// deleteTable throws a not-found error even on success, so we use isNotFound to treat it as gone.
const KIND_HANDLERS = {
  app: {
    async resolve(sdk, target) {
      const items = await sdk.resolveArtifact('app', { uniqueName: target.uniqueName });
      return (items || []).map((x) => ({ id: x.id, name: x.name, appModuleIdUnique: x.appModuleIdUnique }));
    },
    // deleteAppCascade fail-fast-deletes the app module, then best-effort cleans up the
    // orphaned sitemap + generative-page rows (uxagentproject[file]). It returns a structured
    // { success, deleted, failures } result (older vendored bundles returned void). The app
    // record itself is gone once this resolves, but an individual child-cleanup step can still
    // fail — which the old void contract swallowed, silently leaving orphaned rows while the
    // teardown reported a clean delete. Surface any GENUINE child failure so the run reports
    // ok=false with the exact leftovers. A not-found child failure means the row already
    // cascaded away (not a leftover), so it is tolerated — the same best-effort spirit as the
    // step-level isNotFound handling in deleteStep.
    async del(sdk, item) {
      const result = await sdk.deleteAppCascade(item.id, item.appModuleIdUnique);
      const failures = (result && Array.isArray(result.failures) ? result.failures : []).filter(
        (f) => !isNotFound(f && f.error)
      );
      if (failures.length) {
        const detail = failures
          .map((f) => `${f.operation} ${f.type}${f.id ? ` ${f.id}` : ''}: ${errMsg(f.error)}`)
          .join('; ');
        throw new Error(
          `app "${item.name}" deleted, but ${failures.length} cascade cleanup step(s) failed (orphaned rows remain): ${detail}`
        );
      }
    },
  },
  dashboard: {
    async resolve(sdk, target) {
      const items = await sdk.resolveArtifact('dashboard', { name: target.name });
      return (items || []).map((x) => ({ id: x.id, name: x.name }));
    },
    del: (sdk, item) => sdk.deleteRemoteArtifact('dashboard', item.id),
  },
  commands: {
    // The SDK's command delete is keyed by ENTITY — one call removes every appaction on that
    // entity's command bar. resolveArtifact returns items when commands exist; map to a single
    // entity-keyed item so del removes the whole bar in one call.
    async resolve(sdk, target) {
      const items = await sdk.resolveArtifact('command', { entity: target.entity });
      return (items || []).map((x) => ({ id: x.id, entity: x.entity || target.entity }));
    },
    del: (sdk, item) => sdk.deleteRemoteArtifact('command', item.entity),
  },
  form: {
    async resolve(sdk, target) {
      const items = await sdk.resolveArtifact('form', { name: target.name, entity: target.entity });
      return (items || []).map((x) => ({ id: x.id, name: x.name, entity: target.entity, isMain: target.isMain }));
    },
    async del(sdk, item) {
      // A main form the build promoted to default can't be deleted until a stock form is restored
      // as the active default (reverse of Gap 2's promote) — otherwise Dataverse blocks the delete.
      if (item.isMain) await restoreStockMainForm(sdk, item.entity, item.id);
      await sdk.deleteRemoteArtifact('form', item.id);
    },
  },
  chart: {
    async resolve(sdk, target) {
      const items = await sdk.resolveArtifact('chart', { name: target.name, entity: target.entity });
      return (items || []).map((x) => ({ id: x.id, name: x.name }));
    },
    del: (sdk, item) => sdk.deleteRemoteArtifact('chart', item.id),
  },
  view: {
    async resolve(sdk, target) {
      const items = await sdk.resolveArtifact('view', { name: target.name, entity: target.entity });
      return (items || []).map((x) => ({ id: x.id, name: x.name }));
    },
    del: (sdk, item) => sdk.deleteRemoteArtifact('view', item.id),
  },
  relationship: {
    // No pre-resolve: delete by schema name directly (like the table handler's synthetic item).
    async resolve(sdk, target) {
      return [{ id: target.schemaName, schemaName: target.schemaName }];
    },
    del: (sdk, item) => sdk.deleteRelationship(item.schemaName),
    tolerateNotFound: true, // a relationship already removed (e.g. by a prior table delete) is "gone"
  },
  // Gap 6: the build adds parent lookups to the built-in Active/Inactive default views, which can't be
  // deleted — a lookup column on them references the relationship and blocks its delete. Before the
  // relationships phase, reset those default views to a lookup-free column set so the relationship
  // (and then the tables) can be removed. Best-effort; enrichDefaultViews resolves+sets+publishes.
  resetDefaultViews: {
    async resolve(sdk, target) {
      return [{ id: target.entityLogical, cols: target.cols }];
    },
    async del(sdk, item) {
      if (typeof sdk.enrichDefaultViews === 'function') {
        try { await sdk.enrichDefaultViews(item.id, item.cols); } catch { /* best-effort — a reset that fails just leaves the surfacing lookup, which the delete will then report */ }
      }
    },
  },
  webResource: {
    async resolve(sdk, target) {
      const items = await sdk.resolveArtifact('webResource', { name: target.name });
      return (items || []).map((x) => ({ id: x.id, name: x.name }));
    },
    del: (sdk, item) => sdk.deleteWebResource(item.id),
  },
  table: {
    // Only tear down tables THIS build created. Skip (never delete):
    //  · a table the spec explicitly flags as pre-existing (`existing: true`) — a reused custom
    //    table owned elsewhere; and
    //  · any non-custom/system table (account, contact, …) — never created by a build, and
    //    Dataverse refuses to delete it, so a delete attempt would only surface a noisy error.
    // A table that can't be discovered is treated as already-gone: fall through to the delete
    // call, which tolerates the cosmetic/absent 404 (see tolerateNotFound).
    async resolve(sdk, target) {
      if (target.existing) {
        return { items: [], skipReason: 'reused table (existing: true) — not created by this build' };
      }
      let table = null;
      try {
        const hits = await sdk.findTables(target.logical, { top: 50 });
        table = (hits || []).find((t) => String(t.logicalName).toLowerCase() === target.logical) || null;
      } catch { table = null; }
      if (table && table.isCustom === false) {
        return { items: [], skipReason: 'system table — not created by this build' };
      }
      return [{ id: target.logical, logical: target.logical }];
    },
    del: (sdk, item) => sdk.deleteTable(item.logical),
    // deleteTable throws a not-found error even on success; treat any not-found as gone.
    tolerateNotFound: true,
  },
  globalChoice: {
    // Deleted by name (the SDK has no id lister); a synthetic item drives deleteStep, mirroring
    // the table/relationship handlers. Runs AFTER tables so no column still binds the option set.
    async resolve(sdk, target) {
      return [{ id: target.name, name: target.name }];
    },
    del: (sdk, item) => sdk.deleteGlobalOptionSet(item.name),
    tolerateNotFound: true, // absent, or a shared choice already removed, is "gone"
  },
  aiSummary: {
    // AI row-summary records reference the table and would block its delete; remove them first.
    // removeRowSummary is a no-op when the record is absent, so this is safe/idempotent.
    async resolve(sdk, target) {
      return [{ id: target.entityLogicalName, entityLogicalName: target.entityLogicalName }];
    },
    async del(sdk, item) {
      if (sdk.removeRowSummary) {
        try { await sdk.removeRowSummary({ entityLogicalName: item.entityLogicalName }); } catch { /* best-effort */ }
      }
    },
  },
  solution: {
    async resolve(sdk, target) {
      const items = await sdk.resolveArtifact('solution', { uniqueName: target.uniqueName });
      return (items || []).map((x) => ({ id: x.id, name: x.name }));
    },
    del: (sdk, item) => sdk.deleteSolution(item.id),
  },
};

// Build the ordered teardown plan from an App Spec. Pure — no I/O. Each step names exactly one
// artifact target (resolved live at execution time). Steps whose spec section is absent are
// simply omitted, so a partial spec tears down only what it declares.
function planTeardown(spec) {
  const steps = [];
  if (spec.app && spec.solution) {
    steps.push({ kind: 'app', phase: 'app', label: `app module "${spec.app.name}"`, target: { uniqueName: appUniqueName(spec) } });
  }
  for (const d of spec.dashboards || []) {
    steps.push({ kind: 'dashboard', phase: 'dashboards', label: `dashboard "${d.name}"`, target: { name: d.name } });
  }
  for (const entity of Object.keys(commandsByEntity(spec))) {
    steps.push({ kind: 'commands', phase: 'commands', label: `command bar for ${entity}`, target: { entity } });
  }
  // Delete forms so a QuickView form referenced by another form's `quickViews[]` is removed AFTER its
  // HOST form. The host embeds a quick-view CONTROL that references the QV form, so deleting the QV
  // form first makes Dataverse 400 ("cannot be deleted because it is referenced by 1 other
  // component"). Relying on the later table-delete cascade to clean the orphan is fragile (it does
  // not fire for a QV form on a REUSED/surviving table), so order the delete: hosts first, referenced
  // quick-view forms last.
  const referencedQvForms = new Set();
  for (const f of spec.forms || []) for (const qv of f.quickViews || []) if (qv && qv.form) referencedQvForms.add(qv.form);
  const namedForms = (spec.forms || []).filter((f) => f.name);
  const orderedForms = [
    ...namedForms.filter((f) => !referencedQvForms.has(f.name)),
    ...namedForms.filter((f) => referencedQvForms.has(f.name)),
  ];
  for (const f of orderedForms) {
    // Main forms get promoted to the entity default at build time; teardown reverses that before
    // deleting (restoreStockMainForm), so flag them here.
    const isMain = String(f.formType || f.type || 'main').toLowerCase() === 'main';
    steps.push({ kind: 'form', phase: 'forms', label: `form "${f.name}" (${f.entity})`, target: { name: f.name, entity: String(f.entity).toLowerCase(), isMain } });
  }
  for (const c of spec.charts || []) {
    steps.push({ kind: 'chart', phase: 'charts', label: `chart "${c.name}" (${c.entity})`, target: { name: c.name, entity: String(c.entity).toLowerCase() } });
  }
  for (const v of spec.views || []) {
    steps.push({ kind: 'view', phase: 'views', label: `view "${v.name}" (${v.entity})`, target: { name: v.name, entity: String(v.entity).toLowerCase() } });
  }
  // Gap 6: before deleting relationships, reset each child entity's built-in default views to a
  // lookup-free column set — the build surfaces parent lookups there, and a lookup column on an
  // un-deletable default view blocks the relationship's delete. Only entities that actually have a
  // 1:N lookup need it. Pure: defaultViewColumns(...,{includeLookups:false}) computes the reset set.
  for (const e of spec.entities || []) {
    const logical = e.schemaName.toLowerCase();
    if (!lookupColumnsFor(spec, logical).length) continue;
    steps.push({ kind: 'resetDefaultViews', phase: 'views', label: `reset default views for ${logical} (drop parent lookups)`, target: { entityLogical: logical, cols: defaultViewColumns(spec, e, { includeLookups: false }) } });
  }
  for (const r of spec.relationships || []) {
    const schema = r.type === 'ManyToMany' ? manyToManySchemaName(r, spec.solution && spec.solution.publisherPrefix) : relationshipSchemaName(r, spec.solution && spec.solution.publisherPrefix);
    steps.push({ kind: 'relationship', phase: 'relationships', label: `relationship ${schema}`, target: { schemaName: schema } });
  }
  // AI row-summary records must be removed BEFORE tables: the summary record references the
  // table and would block its delete. Reuses selectSummaryTables to respect default:'off' + overrides.
  if (spec.ai && spec.ai.summaries) {
    for (const schema of selectSummaryTables(spec)) {
      const logical = String(schema).toLowerCase();
      steps.push({ kind: 'aiSummary', phase: 'ai-summaries', label: `row summary ${logical}`, target: { entityLogicalName: logical } });
    }
  }
  // Tables in REVERSE topological order: topoOrderEntities lists parents-before-children (build
  // order); teardown deletes children-before-parents so a still-referenced parent never blocks.
  for (const e of topoOrderEntities(spec).slice().reverse()) {
    steps.push({ kind: 'table', phase: 'tables', label: `table ${e.schemaName}`, target: { logical: e.schemaName.toLowerCase(), schemaName: e.schemaName, existing: e.existing === true } });
  }
  // Web resources AFTER tables (see the order note in the file header): a form's JS is referenced
  // by its form (deleted in the forms phase), but a table's vector/raster ICON web resource is
  // referenced by the TABLE — Dataverse rejects the delete with "referenced by N other components"
  // while the table still exists, so it must come after the tables phase.
  for (const wr of spec.webResources || []) {
    steps.push({ kind: 'webResource', phase: 'web-resources', label: `web resource ${wr.name}`, target: { name: wr.name } });
  }
  // The build generates a default app icon web resource (`<appUnique>_icon`) in the solution when
  // the spec sets no explicit app.icon; it is referenced by the app module (deleted first), so it
  // is safe to delete here. Without this step it leaks as an orphan the spec never declared (the
  // solution delete removes the container, not the underlying webresource row). Skipped when
  // app.icon is set — that image is a declared webResources[] entry handled by the loop above.
  if (spec.app && spec.solution && !spec.app.icon) {
    const generatedIcon = `${appUniqueName(spec)}_icon`;
    steps.push({ kind: 'webResource', phase: 'web-resources', label: `web resource ${generatedIcon} (generated app icon)`, target: { name: generatedIcon } });
  }
  // Global option sets last (before the solution container): every column that bound one lives
  // on a table deleted above, so the shared choice now has no dependents blocking its delete.
  for (const gc of spec.globalChoices || []) {
    steps.push({ kind: 'globalChoice', phase: 'global-choices', label: `global choice ${gc.name}`, target: { name: gc.name } });
  }
  if (spec.solution) {
    steps.push({ kind: 'solution', phase: 'solution', label: `solution ${spec.solution.uniqueName}`, target: { uniqueName: spec.solution.uniqueName } });
  }
  return steps;
}

// Delete the resolved artifacts for one plan step via SDK methods. Returns `{ deletedIds,
// skippedIds }` — `skippedIds` are artifacts that exist but cannot be removed (system/managed),
// surfaced so a destructive run is auditable rather than silently reporting "(0 deleted)". A
// not-found error counts as already-gone. Throws only on a genuine failure (non-not-found,
// non-undeletable).
async function deleteStep(sdk, handler, items) {
  const deletedIds = [];
  const skippedIds = [];
  for (const item of items) {
    try {
      await handler.del(sdk, item);
      deletedIds.push(item.id);
    } catch (err) {
      if (handler.tolerateNotFound && isNotFound(err)) {
        // Table delete throws not-found even on success; treat as deleted
        deletedIds.push(item.id);
        continue;
      }
      if (isNotFound(err)) {
        // Already gone (e.g. cascade) — tolerate
        deletedIds.push(item.id);
        continue;
      }
      if (isUndeletable(err)) {
        // A system/managed artifact (e.g. an auto-generated "Active <Entity>" view that shares
        // the spec view's name) — not ours to remove. Record it as skipped without failing.
        skippedIds.push(item.id);
        continue;
      }
      throw err;
    }
  }
  return { deletedIds, skippedIds };
}

// Execute a teardown. Dry-run (default) emits the plan (no I/O) and returns { ok, dryRun, plan }.
// Apply resolves each step's live id(s) and deletes them, emitting per-step status. Best-effort:
// a failed step is recorded and teardown CONTINUES (halting mid-way would strand orphans), then
// ok=false with an `errors[]` is returned. deps: { sdk (MakerSdk client), emit(event) }.
async function runTeardown(spec, opts = {}, deps = {}) {
  const emit = deps.emit || (() => undefined);
  const sdk = deps.sdk;
  const apply = opts.apply === true;
  const plan = planTeardown(spec);
  const total = plan.length;

  if (!apply) {
    plan.forEach((p, i) => emit({ phase: p.phase, status: 'skip', label: p.label, n: i + 1, total }));
    return { ok: true, dryRun: true, plan: plan.map((p) => p.label) };
  }
  if (!sdk || typeof sdk.resolveArtifact !== 'function') {
    throw new Error('runTeardown requires deps.sdk when apply is true');
  }

  const result = { ok: true, dryRun: false, deleted: {}, skipped: [], errors: [] };
  let n = 0;
  for (const step of plan) {
    const myN = (n += 1);
    emit({ phase: step.phase, status: 'start', label: step.label, n: myN, total });
    const handler = KIND_HANDLERS[step.kind];
    try {
      let resolved;
      try {
        resolved = await handler.resolve(sdk, step.target);
      } catch (resolveErr) {
        // Resolving forms/charts/views filters by an entity's typecode; if that entity was never
        // created (partial build) or is already gone, Dataverse answers 400 "entity ... not found
        // in the MetadataCache". There is nothing to delete — treat it as an empty resolution.
        if (isNotFound(resolveErr)) { resolved = []; } else { throw resolveErr; }
      }
      // resolve returns either an array of items, or `{ items, skipReason }` when the step is
      // intentionally NOT torn down (e.g. a reused/system table the build did not create). The
      // reason is surfaced so a destructive run is auditable rather than silently omitting it.
      const items = Array.isArray(resolved) ? resolved : (resolved.items || []);
      const skipReason = Array.isArray(resolved) ? null : resolved.skipReason;
      if (!items.length) {
        result.skipped.push(skipReason ? `${step.label} (${skipReason})` : step.label);
        emit({ phase: step.phase, status: 'skip', label: `${step.label} (${skipReason || 'not found'})`, n: myN, total });
        continue;
      }
      const { deletedIds, skippedIds } = await deleteStep(sdk, handler, items);
      (result.deleted[step.kind] = result.deleted[step.kind] || []).push(...deletedIds);
      if (skippedIds.length) {
        result.skipped.push(`${step.label} (${skippedIds.length} undeletable — skipped)`);
      }
      const summary = skippedIds.length
        ? `${deletedIds.length} deleted, ${skippedIds.length} undeletable`
        : `${deletedIds.length} deleted`;
      emit({ phase: step.phase, status: 'ok', label: `${step.label} (${summary})`, n: myN, total });
    } catch (err) {
      result.ok = false;
      const message = errMsg(err);
      result.errors.push({ step: step.label, message });
      emit({ phase: step.phase, status: 'error', label: step.label, n: myN, total, detail: message });
      // best-effort: continue to the next step so a single failure doesn't strand the rest.
    }
  }
  return result;
}

module.exports = { planTeardown, runTeardown, deleteStep, odataStr, KIND_HANDLERS };
