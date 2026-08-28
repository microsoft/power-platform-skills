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
//   1a. pages        — generative pages (uxagentproject + files) this build AUTHORED, per the page
//                      manifest. The SDK's deleteAppCascade no longer removes them: a
//                      page is REFERENCED by an app, not owned by one — another app's sitemap, or a
//                      form's UxAgentControl `RefId` in formxml, can point at the same row — so the
//                      SDK reports them and the owner decides. Runs AFTER the app so the app's own
//                      sitemap reference is already gone and the only dependency the platform can
//                      still report is a GENUINE other consumer; such a page is SKIPPED, not deleted.
//   1b. roles        — persona security roles. Deleted right after the app (BEFORE the data model): a
//                      role holding a soon-to-be-deleted table's privileges could otherwise block that
//                      table's delete. SEC-1: only roles the SDK itself authored (marked on the role
//                      description) are deleted — never a hand-built or managed same-name role.
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
const { appUniqueName, commandsByEntity, defaultViewColumns, resolveExistingFormId, resolveRoleBusinessUnit, roleBuClause, businessRuleFilter } = require('./sdk-build.js');
const { manifestResourceName, parseManifestBase64 } = require('./page-manifest.js');
const { relationshipSchemaName, manyToManySchemaName, lookupColumnsFor, SDK_ROLE_MARKER, canonicalPersonaName, FORM_GUID_RE } = require('./app-spec.js');
const { selectSummaryTables } = require('./ai-candidates.js');
const { isRestrictedSolution } = require('./system-solutions.js');

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
// Dataverse refused a delete because another component still references the record:
// "The <entity>(<id>) component cannot be deleted because it is referenced by N other components."
// For MOST kinds that is a genuine leftover the teardown must surface. For a generative page it is
// the correct, expected answer — the page belongs to whoever still points at it — so only handlers
// that opt in via `tolerateDependencyBlock` treat it as a skip.
function isDependencyBlocked(err) {
  if (!err) return false;
  const msg = String((err && err.message) || '').toLowerCase();
  return /cannot be deleted because it is referenced by/.test(msg) || /referenced by \d+ other component/.test(msg);
}

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
    // deleteAppCascade fail-fast-deletes the app module together with its sitemap (atomically), and
    // returns a structured { success, deleted, failures, retained } result (older vendored bundles
    // returned void). It deliberately does NOT delete the app's generative pages — a `uxagentproject`
    // is referenced by an app, not owned by one, so it reports them in `retained` and the owner
    // decides. The `genpage` step that follows is that decision: it deletes the pages
    // THIS build authored, per the page manifest, skipping any another app still references.
    //
    // The app record itself is gone once this resolves, but a cleanup step can still fail — which the
    // old void contract swallowed, silently leaving orphaned rows while teardown reported a clean
    // delete. Surface any GENUINE failure so the run reports ok=false with the exact leftovers. A
    // not-found failure means the row already cascaded away (not a leftover), so it is tolerated —
    // the same best-effort spirit as the step-level isNotFound handling in deleteStep.
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
  // Generative pages the build authored. The SDK's `deleteAppCascade` deliberately does NOT delete
  // these: a `uxagentproject` is REFERENCED by an app, not owned by one, so the SDK
  // reports them in `retained` and leaves the decision to the caller. WE are the caller that CREATED
  // them, and the page manifest is the durable record of exactly which pages this build authored —
  // so teardown deletes those, and only those.
  //
  // Safety is delegated to DATAVERSE, not inferred from a scan. Verified against a live environment:
  // saving an app that surfaces a page creates a real solution dependency, and DELETE on that page
  // returns 400 "component cannot be deleted because it is referenced by N other components" —
  // whether or not the app is published. The dependency clears only when the referencing sitemap is
  // removed AND published, or when the app+sitemap are deleted outright (which is what the step
  // before this one just did).
  //
  // So the delete IS the check. Attempting it and reading the platform's answer beats a pre-flight
  // scan: it is authoritative (the platform's own dependency graph, not our model of it), and it has
  // no TOCTOU window — a pre-check can go stale between the check and the delete, this cannot.
  //
  // KNOWN GAP, measured rather than assumed: that graph covers SITEMAP references only. A page
  // embedded in a FORM through the `MscrmControls.UxAgentControl` PCF is NOT tracked — a form was
  // built with a page in its `RefId`, saved and published, and the page still reported ZERO
  // dependents and deleted with a 204. The form's own required-components list names the PCF
  // (component type 66) and never the page, because `RefId` is an opaque
  // `static="true" type="SingleLine.Text"` value the platform cannot know is a reference.
  // We accept that gap here because this step only ever deletes pages THIS build authored and is
  // tearing down the app that owns them; it is not closable by asking the platform, and a formxml
  // scan is the only thing that would close it.
  genpage: {
    // A page another app still references is a SKIP, not a failure — see isDependencyBlocked.
    tolerateDependencyBlock: true,
    async resolve(sdk, target) {
      if (typeof sdk.queryRecords !== 'function') return [];
      // The manifest lives in a web resource this same teardown deletes later (web-resources phase),
      // so it is still readable here.
      let manifest = null;
      try {
        const rows = await sdk.queryRecords('webresource', {
          select: ['content'],
          filter: `name eq '${odataStr(target.manifestName)}'`,
          top: 1,
        });
        if (rows && rows[0] && rows[0].content) manifest = parseManifestBase64(rows[0].content);
      } catch {
        // No manifest readable → nothing provably ours → delete nothing. Leaving a row behind is
        // recoverable; deleting a page we cannot prove we authored is not.
        return [];
      }
      const authored = [];
      for (const p of (manifest && manifest.pages) || []) {
        if (p && typeof p.pageId === 'string' && FORM_GUID_RE.test(p.pageId)) {
          authored.push({ id: p.pageId, name: p.name || p.key || p.pageId });
        }
      }
      if (!authored.length) return [];

      // Only pages that still exist (a re-run, or a maker deleting one by hand, is not a failure).
      try {
        const filter = authored.map((a) => `uxagentprojectid eq ${String(a.id).toLowerCase()}`).join(' or ');
        const rows = await sdk.queryRecords('uxagentproject', { select: ['uxagentprojectid'], filter });
        const live = new Set((rows || []).map((r) => String(r.uxagentprojectid).toLowerCase()));
        return authored.filter((a) => live.has(String(a.id).toLowerCase()));
      } catch {
        return [];
      }
    },
    // Delete ONLY the project row. Its `uxagentprojectfile` children go with it: the
    // uxagentproject_uxagentprojectfile_uxagentprojectid relationship is CascadeConfiguration
    // Delete=Cascade, verified end to end — one DELETE of a real pac-created page removed the
    // project and all four of its file rows, none orphaned.
    //
    // Deleting the files ourselves first would be actively DESTRUCTIVE. Dataverse tracks a
    // dependency on the PROJECT row (component type 10372) but NOT on its files (10373):
    // measured on pages that an app sitemap references, the project reports 1 dependent and its
    // DELETE is refused, while every one of its files reports ZERO dependents and would delete
    // cleanly. So a files-first order would strip the content out of a page the platform is about
    // to refuse to delete, leaving the app that still references it pointing at an empty shell —
    // exactly the data loss this step exists to avoid. One delete, and the platform decides.
    async del(sdk, item) {
      await sdk.deleteRecord('uxagentproject', item.id);
    },
  },
  dashboard: {
    async resolve(sdk, target) {
      const items = await sdk.resolveArtifact('dashboard', { name: target.name });
      return (items || []).map((x) => ({ id: x.id, name: x.name }));
    },
    del: (sdk, item) => sdk.deleteRemoteArtifact('dashboard', item.id),
  },
  role: {
    // Persona security role. There is no resolveArtifact('role'), and deleteSecurityRole takes a role
    // id (not a name) and does NOT re-check ownership — so resolve queries the roles table by the SAME
    // (name, business-unit) identity the SDK created it under and returns ONLY rows the SDK authored
    // (SEC-1: the ownership marker on the description, unmanaged). Scoping by BU is load-bearing: a
    // name-only query would match — and deletion would then remove — a same-named SDK role in a DIFFERENT
    // business unit that belongs to another app (cross-BU data loss). A hand-built or managed role that
    // merely shares the persona name is left untouched.
    async resolve(sdk, target) {
      if (typeof sdk.queryRecords !== 'function' || typeof sdk.deleteSecurityRole !== 'function') return [];
      let rows;
      try {
        // Scope to the persona's business unit (explicit, else the org root BU the SDK defaults to). This
        // is a DESTRUCTIVE op, so if the BU can't be resolved we FAIL CLOSED and delete nothing — a
        // name-only fallback could delete a same-named SDK role in another BU that belongs to another app.
        const bu = await resolveRoleBusinessUnit((e, o) => sdk.queryRecords(e, o), target.businessUnitId, target._buCache || (target._buCache = {}));
        if (!bu) return [];
        // Roles table (logical `role`, set `roles`). name is an exact-match literal — never a wildcard —
        // so this can only ever resolve the persona's own role(s) in its BU.
        rows = await sdk.queryRecords('role', {
          select: ['roleid', 'name', 'description', 'ismanaged'],
          filter: `name eq '${odataStr(target.name)}'${roleBuClause(bu)}`,
          top: 50,
        });
      } catch {
        // A query failure (e.g. an old bundle without role support) means we cannot prove ownership,
        // so delete NOTHING rather than risk removing a role we did not author.
        return [];
      }
      // Marker + unmanaged + in-BU proves WE authored this role. One more guard against cross-app data
      // loss: teardown deletes the app FIRST, so if the role is STILL associated with any app module, that
      // association belongs to ANOTHER app that shares this (same name+BU) persona — deleting the role
      // would break that app. Skip those; delete only roles no app still uses (this app's link is already
      // gone, or a data-only role). Best-effort: if the association check can't run, fall back to the
      // BU+marker decision (delete) — the extra guard only ever REMOVES candidates, never adds them.
      const owned = (rows || []).filter((r) => r.ismanaged !== true && (r.description || '') === SDK_ROLE_MARKER && r.roleid);
      const kept = [];
      for (const r of owned) {
        const id = String(r.roleid);
        let sharedWithAnotherApp = false;
        if (FORM_GUID_RE.test(id)) {
          try {
            // OData `any()` over the appmodule<->role N:N (live-verified). id is a Dataverse GUID (Edm.Guid,
            // unquoted) validated above, so interpolation is injection-safe.
            const apps = await sdk.queryRecords('appmodule', { select: ['appmoduleid'], filter: `appmoduleroles_association/any(x:x/roleid eq ${id})`, top: 1 });
            sharedWithAnotherApp = Array.isArray(apps) && apps.length > 0;
          } catch { sharedWithAnotherApp = false; }
        }
        if (!sharedWithAnotherApp) kept.push({ id, name: target.name });
      }
      return kept;
    },
    del: (sdk, item) => sdk.deleteSecurityRole(item.id),
    tolerateNotFound: true, // a role already deleted (e.g. by a prior teardown) is "gone"
  },
  businessRules: {
    // A business rule is a `workflows` row (category 2), not something the SDK models as a deletable
    // artifact kind — so resolve and delete it over queryRecords/deleteRecord like the row it is.
    //
    // Scoped by (category, name, primaryentity) so a same-named rule on another table is never
    // touched. An ACTIVE rule cannot be deleted, so it is deactivated first; that is a separate
    // round trip and the platform runs it asynchronously (a WorkflowSetState job), which is why a
    // solution uninstall immediately afterwards can transiently 429 — see the teardown notes.
    async resolve(sdk, target) {
      const rows = await sdk.queryRecords('workflow', {
        select: ['workflowid', 'statecode'],
        // DEFINITION rows only (see businessRuleFilter in sdk-build.js). Activating a rule makes the
        // platform create a second `type 2` activated copy whose parent is the definition; the
        // platform refuses to delete that copy directly (405) and removes it with its parent. An
        // unfiltered query therefore produced a guaranteed per-rule teardown failure.
        filter: businessRuleFilter(target.name, target.entity),
        top: 50,
      });
      return (rows || []).map((r) => ({ id: r.workflowid, name: target.name, statecode: r.statecode }));
    },
    async del(sdk, item) {
      // Deactivate before delete. Dataverse refuses to delete an activated process, and the error it
      // returns names neither the rule nor the reason clearly.
      if (item.statecode === 1) {
        try { await sdk.updateRecord('workflow', item.id, { statecode: 0, statuscode: 1 }); } catch { /* fall through: the delete below reports the real failure */ }
      }
      return sdk.deleteRecord('workflow', item.id);
    },
    tolerateNotFound: true,
  },
  commands: {
    // The vendored SDK models a table's command bar as ONE artifact per entity (identity = entity):
    // resolveArtifact('command', { entity }) returns that single per-entity artifact and
    // deleteRemoteArtifact('command', entity) removes the whole bar in one call — there is NO per-button
    // delete in the SDK surface, and the build's command phase is discover-then-skip (it only CREATES a
    // bar when none pre-existed — see sdk-build.js §14). So on an entity that carries pre-existing/foreign
    // buttons, deleting the bar would destroy buttons this spec never authored. FAIL-CLOSED FIX (PR #229
    // review): planTeardown flags `ownsTable` = "this spec creates the underlying table". We only delete
    // the bar for a spec-created NEW table (no foreign buttons can exist on a brand-new table); for a
    // command on an existing/external table we SKIP the delete and surface an auditable skip reason,
    // rather than risk destroying another app's command buttons. Precise per-button scoping on an adopted
    // bar would need a per-appaction delete capability in @maker-studio/cds-maker-sdk (SDK follow-up).
    async resolve(sdk, target) {
      if (!target.ownsTable) {
        return { items: [], skipReason: "command bar on an existing/external table is not deleted — the SDK deletes the whole bar and cannot scope to this spec's buttons (per-button delete unsupported); remove it manually if intended" };
      }
      const items = await sdk.resolveArtifact('command', { entity: target.entity });
      const bar = (items || []).map((x) => ({ id: x.id, entity: x.entity || target.entity, kind: 'bar' }));

      // The bar delete does NOT remove the individual `appaction` rows. LIVE-MEASURED: after a
      // teardown that deleted the table itself, five appaction rows for that entity survived, and
      // the three leaf buttons still referenced the form-JS web resource — which then could not be
      // deleted ("referenced by 3 other components", componenttype 10344 = modern command). So the
      // stranded rows are what blocked the web resource, not a platform dependency leak.
      //
      // Safe only because this branch already requires `ownsTable`: the table is one this spec
      // creates, so no foreign app can own buttons on it. Scoped to `contextvalue` (the entity the
      // command is bound to) for the same reason.
      //
      // CHILDREN FIRST: see the depth computation below — a flyout hierarchy is three levels deep,
      // so ordering has to be by real ancestor depth, not by "has a parent".
      let rows = [];
      try {
        rows = await sdk.queryRecords('appaction', {
          select: ['appactionid', '_parentappactionid_value'],
          filter: `contextvalue eq '${odataLit(target.entity)}'`,
          top: 200,
        });
      } catch {
        // Best-effort: if the rows cannot be listed, the bar delete below still runs and the web
        // resource simply reports its dependency, which is the pre-existing behaviour.
        rows = [];
      }
      // DEEPEST FIRST, by real ancestor depth. A flyout is three levels — anchor (no parent), an
      // intervening group (parent = anchor), then the buttons (parent = group) — so
      // `_parentappactionid_value` is set on BOTH the group and the leaves. Sorting merely by "has a
      // parent" puts them in the same bucket in arbitrary order, which can delete the group while its
      // buttons still hang off it; Dataverse rejects deleting a parent that still has children.
      // (Observed while resetting a command bar by hand: a leaf came back 404 because its group had
      // already gone — the platform happened to cascade, which is luck, not ordering.)
      //
      // So walk the parent pointers to a true depth and delete the deepest rows first.
      const byId = new Map((rows || []).map((r) => [r.appactionid, r]));
      const depthOf = (r) => {
        let d = 0;
        let cur = r;
        // Bounded by the row count so a cyclic/self-referential pointer cannot spin forever.
        for (let i = 0; i < byId.size + 1 && cur && cur._parentappactionid_value; i += 1) {
          cur = byId.get(cur._parentappactionid_value);
          d += 1;
        }
        return d;
      };
      const leaves = (rows || [])
        .slice()
        .sort((a, b) => depthOf(b) - depthOf(a))
        .map((r) => ({ id: r.appactionid, entity: target.entity, kind: 'row' }));
      // Rows BEFORE the bar: the individual rows are the ones holding the web-resource dependency,
      // and deleting them first makes the outcome deterministic instead of depending on whatever the
      // bar delete happens to cascade.
      return [...leaves, ...bar];
    },
    del: (sdk, item) => (item.kind === 'row'
      ? sdk.deleteRecord('appaction', item.id)
      : sdk.deleteRemoteArtifact('command', item.entity)),
    // A row the bar delete already removed reads as gone, not as a failure.
    tolerateNotFound: true,
  },
  form: {
    async resolve(sdk, target) {
      // Resolve by (entity, name, TYPE) or a pinned formId — NOT name alone — so tearing down a Main form
      // never ALSO deletes the table's same-named Quick View / Card siblings (Sol review: the old name-only
      // resolveArtifact returned every match and del() deleted each). resolveExistingFormId returns the ONE
      // intended form (null if absent → nothing to delete; throws on a residual (entity,type,name) collision
      // → teardown halts fail-closed rather than delete an arbitrary form).
      const id = await resolveExistingFormId(sdk, { entityLogicalName: target.entity, name: target.name, formType: target.formType, formId: target.formId });
      return id ? [{ id, name: target.name, entity: target.entity, isMain: target.isMain }] : [];
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
      // A built-in system solution (Active/Default/Basic) can never be deleted — Dataverse 400s
      // ("Attempting to delete a restricted solution ..."). A downloaded spec whose real solution
      // wasn't recovered defaults its solution to 'Default' (see download-model-app recoverAppSolution),
      // so a spec-driven teardown of such a download would otherwise error here. Skip it with an
      // auditable reason instead — the `{ items, skipReason }` shape marks the step skipped, not failed.
      if (isRestrictedSolution(target.uniqueName)) {
        return { items: [], skipReason: 'restricted system solution' };
      }
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
    // Generative pages, AFTER the app. The SDK no longer deletes them — a page is
    // referenced by an app, not owned by one, so the SDK reports them and the owner decides. We are
    // the owner: the page manifest records exactly which pages this build authored. Ordered after the
    // app so the app's own sitemap reference is already gone and any dependency the platform still
    // reports belongs to a GENUINE other consumer. Emitted for every app-bearing spec (not gated on
    // spec.pages) so a spec that dropped its pages still cleans up what it previously created;
    // resolve is a no-op when the manifest is absent or lists nothing.
    steps.push({
      kind: 'genpage',
      phase: 'pages',
      label: 'generative pages authored by this app',
      target: { manifestName: manifestResourceName(appUniqueName(spec)) },
    });
  }
  // Persona security roles — deleted right after the app, before the data model (a role holding a
  // table's privileges could block that table's delete). The role handler is SEC-1 safe (marker-gated)
  // and BU-scoped. Uses the TRIMMED (canonical) persona name so it matches the name the SDK created.
  for (const p of spec.personas || []) {
    const name = canonicalPersonaName(p);
    if (!name) continue;
    steps.push({ kind: 'role', phase: 'security', label: `security role "${name}"`, target: { name, businessUnitId: p.businessUnitId } });
  }
  for (const d of spec.dashboards || []) {
    steps.push({ kind: 'dashboard', phase: 'dashboards', label: `dashboard "${d.name}"`, target: { name: d.name } });
  }
  // Command bars: FAIL-CLOSED (data-loss guard, PR #229 review). Only tear down the bar for a table
  // THIS spec CREATES (existing !== true) — a brand-new table has no pre-existing foreign buttons, and
  // its own table delete cascades the bar anyway. A command on an EXISTING/external table is left alone,
  // because the SDK deletes the WHOLE entity command bar and cannot scope to this spec's buttons (see the
  // commands handler). Validation guarantees a command's entity is one of spec.entities, so the
  // `existing` flag cleanly distinguishes spec-created tables from adopted ones.
  const specCreatedTables = new Set((spec.entities || []).filter((e) => e.existing !== true).map((e) => String(e.schemaName).toLowerCase()));
  for (const entity of Object.keys(commandsByEntity(spec))) {
    steps.push({ kind: 'commands', phase: 'commands', label: `command bar for ${entity}`, target: { entity, ownsTable: specCreatedTables.has(String(entity).toLowerCase()) } });
  }
  // Business rules BEFORE forms and tables: a rule is a workflow row bound to the entity, and an
  // ACTIVE one blocks changes to what it references. It is also its own artifact rather than
  // something a table delete cascades away.
  for (const r of spec.businessRules || []) {
    const entity = String(r.entity).toLowerCase();
    steps.push({ kind: 'businessRules', phase: 'business-rules', label: `business rule "${r.name}" (${entity})`, target: { entity, name: r.name } });
  }
  // Delete forms so a QuickView form referenced by another form's `quickViews[]` is removed AFTER its
  // HOST form. The host embeds a quick-view CONTROL that references the QV form, so deleting the QV
  // form first makes Dataverse 400 ("cannot be deleted because it is referenced by 1 other
  // component"). Relying on the later table-delete cascade to clean the orphan is fragile (it does
  // not fire for a QV form on a REUSED/surviving table), so order the delete: hosts first, referenced
  // quick-view forms last.
  const referencedQv = new Set();
  for (const f of spec.forms || []) for (const qv of f.quickViews || []) if (qv && qv.form && qv.targetEntity) referencedQv.add(`${String(qv.targetEntity).toLowerCase()}|${qv.form}`);
  // A form is a "referenced quick-view" only if it is a QuickView whose (entity, name) a host embeds —
  // NOT merely a same NAME as some referenced QV (a same-named Main host must stay in the hosts-first
  // group, else it'd be ordered after its own QV and the QV delete would 400 on the host reference; Sol).
  const isReferencedQv = (f) => (f.formType || 'Main') === 'QuickView' && referencedQv.has(`${String(f.entity).toLowerCase()}|${f.name}`);
  const namedForms = (spec.forms || []).filter((f) => f.name);
  const orderedForms = [
    ...namedForms.filter((f) => !isReferencedQv(f)),
    ...namedForms.filter((f) => isReferencedQv(f)),
  ];
  for (const f of orderedForms) {
    // Main forms get promoted to the entity default at build time; teardown reverses that before
    // deleting (restoreStockMainForm), so flag them here.
    const isMain = String(f.formType || f.type || 'main').toLowerCase() === 'main';
    steps.push({ kind: 'form', phase: 'forms', label: `form "${f.name}" (${f.entity})`, target: { name: f.name, entity: String(f.entity).toLowerCase(), formType: f.formType, formId: f.formId, isMain } });
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
  const declaredWrNames = new Set(
    (spec.webResources || []).map((w) => w && w.name && String(w.name).toLowerCase()).filter(Boolean));
  for (const wr of spec.webResources || []) {
    // `external:true` marks a web resource this app merely REFERENCES (a re-declared path/`$webresource`
    // nav icon whose ownership can't be proven exclusive — see download-model-app iconWebResources). The
    // build creates-if-missing so the icon works, but teardown must NOT delete it: a WR another app shares
    // would break there (fail-safe — an orphan is recoverable, a deleted shared resource is not; same
    // posture as the `existing:true` protection on downloaded tables). Skip it.
    if (wr.external === true) continue;
    steps.push({ kind: 'webResource', phase: 'web-resources', label: `web resource ${wr.name}`, target: { name: wr.name } });
  }
  // The build generates a default app icon web resource (`<appUnique>_icon`) in the solution when
  // the spec sets no explicit app.icon; it is referenced by the app module (deleted first), so it
  // is safe to delete here. Without this step it leaks as an orphan the spec never declared (the
  // solution delete removes the container, not the underlying webresource row). Skipped when
  // app.icon is set — that image is a declared webResources[] entry handled by the loop above.
  // ALSO skipped when the derived name collides with a DECLARED webResources[] entry: if that entry is
  // `external:true` the loop deliberately protected it (a shared nav icon named `<appUnique>_icon`), so
  // this derived delete must not clobber the skip and delete a shared resource (Sol review, High); if it
  // is a normal declared entry the loop already scheduled it, so skipping here just avoids a duplicate.
  if (spec.app && spec.solution && !spec.app.icon) {
    const generatedIcon = `${appUniqueName(spec)}_icon`;
    if (!declaredWrNames.has(generatedIcon.toLowerCase())) {
      steps.push({ kind: 'webResource', phase: 'web-resources', label: `web resource ${generatedIcon} (generated app icon)`, target: { name: generatedIcon } });
    }
  }
  // The build derives a `<appUnique>_pagemanifest` web resource for EVERY app-bearing spec (not just
  // those currently declaring pages). Always emit its teardown step so a spec that dropped its pages
  // still cleans up the derived manifest. The manifest is referenced only by the (already-deleted) app
  // module, so leaving it behind would orphan it in the solution. A not-found delete is idempotent —
  // an app that never had pages adds a harmless no-op step. NOT gated on spec.pages (I5). Same
  // declared-name guard as the generated icon (protect an `external` collision; avoid a duplicate).
  if (spec.app && spec.solution) {
    const manifestName = manifestResourceName(appUniqueName(spec));
    if (!declaredWrNames.has(manifestName.toLowerCase())) {
      steps.push({ kind: 'webResource', phase: 'web-resources', label: `web resource ${manifestName} (page manifest)`, target: { name: manifestName } });
    }
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
// skippedIds, skipped }` — artifacts that exist but were not removed, surfaced so a destructive run
// is auditable rather than silently reporting "(0 deleted)". `skipped` carries a REASON per id
// because the two cases mean opposite things to an operator:
//
//   - `undeletable`  — a system/managed artifact that can never be removed. Nothing to act on.
//   - `referenced`   — the platform refused because something else still points at it. The record
//                      is perfectly deletable once that consumer releases it; for a generative page
//                      this is the CORRECT, expected outcome, not a defect.
//
// Reporting both as "undeletable" would send an operator hunting a platform problem that isn't
// there. `skippedIds` is retained as the union of both for callers that only need the count.
// A not-found error counts as already-gone. Throws only on a genuine failure.
async function deleteStep(sdk, handler, items) {
  const deletedIds = [];
  const skipped = [];
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
      if (handler.tolerateDependencyBlock && isDependencyBlocked(err)) {
        // The platform refused because something else still references this record. For a
        // generative page that is the CORRECT outcome, not a leftover: the page belongs to whoever
        // still points at it, and Dataverse is the authority on that (live-measured — saving an app
        // that surfaces a page creates the dependency, published or not). Recorded as `referenced`
        // rather than `undeletable` so the run stays auditable AND the operator is told the truth:
        // nothing is broken, someone else is still using it.
        skipped.push({ id: item.id, reason: 'referenced' });
        continue;
      }
      if (isUndeletable(err)) {
        // A system/managed artifact (e.g. an auto-generated "Active <Entity>" view that shares
        // the spec view's name) — not ours to remove. Record it as skipped without failing.
        skipped.push({ id: item.id, reason: 'undeletable' });
        continue;
      }
      throw err;
    }
  }
  return { deletedIds, skippedIds: skipped.map((s) => s.id), skipped };
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
      const { deletedIds, skipped } = await deleteStep(sdk, handler, items);
      (result.deleted[step.kind] = result.deleted[step.kind] || []).push(...deletedIds);
      // Report each skip reason in its own words. "undeletable" tells an operator there is nothing
      // to do; "still referenced" tells them another consumer holds it — a different situation with
      // a different (possibly no) follow-up.
      const referenced = skipped.filter((s) => s.reason === 'referenced').length;
      const undeletable = skipped.filter((s) => s.reason === 'undeletable').length;
      const parts = [];
      if (undeletable) parts.push(`${undeletable} undeletable`);
      if (referenced) parts.push(`${referenced} still referenced`);
      if (parts.length) {
        result.skipped.push(`${step.label} (${parts.join(', ')} — skipped)`);
      }
      const summary = [`${deletedIds.length} deleted`, ...parts].join(', ');
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
