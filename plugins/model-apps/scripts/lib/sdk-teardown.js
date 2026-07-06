'use strict';
// Teardown engine: reverse the model-app-maker build — delete exactly the artifacts a given
// App Spec declares, in dependency-safe order, via the SDK's delete methods. This is the
// first-class, classifier-safe counterpart to the manual delete recipe used during live
// verification: it only ever touches artifacts whose identity is resolved from a name/logical/
// uniquename the spec itself declares (an exact-match queryRecords filter per artifact), so it
// can never wildcard-scan or remove unrelated org data.
//
// Order (each the mirror of the build's create order — dependents before their dependencies):
//   1. app          — the app module (references the sitemap + dashboard/form/view/chart components)
//   2. dashboards    — systemform (type 0) rows, pinned as app components
//   3. commands      — appactions per entity (they reference the web-resource JS; delete first)
//   4. web-resources — webresourceset rows (the form/command JS)
//   5. tables        — EntityDefinitions in REVERSE-topological order (a child's lookup references
//                      its parent, so children/referencing tables delete first). Deleting a table
//                      cascades its forms/views/charts/relationships/columns.
//   6. solution      — the (now-empty) solution container, deleted last.
//
// planTeardown(spec) is pure (no I/O) — the dry-run plan + the unit-test surface. runTeardown
// executes it via an injected SDK client and emits the same { phase, status, label, n, total,
// detail? } progress events the build engine does, so the orchestrator narrates teardown with
// the identical phase-grouped, status-marked log.

const { topoOrderEntities } = require('./_graph.js');
const { appUniqueName, commandsByEntity } = require('./sdk-build.js');

// OData v4 string-literal escaping: a single quote inside a literal is doubled.
function odataStr(v) {
  return String(v == null ? '' : v).replace(/'/g, "''");
}

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
  return /not found|does not exist|could not find/.test(msg);
}

// Per-kind resolve (read-only id lookup, exact-name filtered) + delete handlers via SDK methods.
// `resolve` returns the concrete artifacts to delete ([] when nothing matches — already gone /
// never built). `del` deletes one. A not-found error on delete is tolerated as "already gone"
// (e.g. a flyout appaction cascade removes its child buttons) — except for tables, whose
// deleteTable throws a not-found error even on success, so we use isNotFound to treat it as gone.
const KIND_HANDLERS = {
  app: {
    async resolve(sdk, target) {
      const rows = await sdk.queryRecords('appmodule', { select: ['appmoduleid', 'name'], filter: `uniquename eq '${odataStr(target.uniqueName)}'`, top: 1 });
      return (rows || []).map((x) => ({ id: x.appmoduleid, name: x.name }));
    },
    del: (sdk, item) => sdk.deleteRemoteArtifact('app', item.id),
  },
  dashboard: {
    async resolve(sdk, target) {
      // Dashboards are systemform rows (type 0); the name filter disambiguates them from forms.
      const rows = await sdk.queryRecords('systemform', { select: ['formid', 'name'], filter: `name eq '${odataStr(target.name)}' and type eq 0`, top: 10 });
      return (rows || []).map((x) => ({ id: x.formid, name: x.name }));
    },
    del: (sdk, item) => sdk.deleteRemoteArtifact('dashboard', item.id),
  },
  commands: {
    async resolve(sdk, target) {
      const rows = await sdk.queryRecords('appaction', { select: ['appactionid', 'buttonlabeltext'], filter: `contextvalue eq '${odataStr(target.entity)}'`, top: 100 });
      return (rows || []).map((x) => ({ id: x.appactionid, name: x.buttonlabeltext }));
    },
    del: (sdk, item) => sdk.deleteRemoteArtifact('command', item.id),
  },
  webResource: {
    async resolve(sdk, target) {
      const rows = await sdk.queryRecords('webresource', { select: ['webresourceid', 'name'], filter: `name eq '${odataStr(target.name)}'`, top: 1 });
      return (rows || []).map((x) => ({ id: x.webresourceid, name: x.name }));
    },
    del: (sdk, item) => sdk.deleteWebResource(item.id),
  },
  table: {
    async resolve(sdk, target) {
      // For tables, we don't pre-resolve; deleteTable itself checks existence. Return a
      // synthetic item so deleteStep proceeds to the delete call.
      return [{ id: target.logical, logical: target.logical }];
    },
    del: (sdk, item) => sdk.deleteTable(item.logical),
    // deleteTable throws a not-found error even on success; treat any not-found as gone.
    tolerateNotFound: true,
  },
  solution: {
    async resolve(sdk, target) {
      const rows = await sdk.queryRecords('solution', { select: ['solutionid', 'uniquename'], filter: `uniquename eq '${odataStr(target.uniqueName)}'`, top: 1 });
      return (rows || []).map((x) => ({ id: x.solutionid, name: x.uniquename }));
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
  for (const wr of spec.webResources || []) {
    steps.push({ kind: 'webResource', phase: 'web-resources', label: `web resource ${wr.name}`, target: { name: wr.name } });
  }
  // Tables in REVERSE topological order: topoOrderEntities lists parents-before-children (build
  // order); teardown deletes children-before-parents so a still-referenced parent never blocks.
  for (const e of topoOrderEntities(spec).slice().reverse()) {
    steps.push({ kind: 'table', phase: 'tables', label: `table ${e.schemaName}`, target: { logical: e.schemaName.toLowerCase(), schemaName: e.schemaName } });
  }
  if (spec.solution) {
    steps.push({ kind: 'solution', phase: 'solution', label: `solution ${spec.solution.uniqueName}`, target: { uniqueName: spec.solution.uniqueName } });
  }
  return steps;
}

// Delete the resolved artifacts for one plan step via SDK methods. Returns the ids deleted (a
// not-found error counts as already-gone when tolerateNotFound is set). Throws only on a genuine
// failure (a non-not-found error).
async function deleteStep(sdk, handler, items) {
  const deletedIds = [];
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
      throw err;
    }
  }
  return deletedIds;
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
  if (!sdk || typeof sdk.queryRecords !== 'function') {
    throw new Error('runTeardown requires deps.sdk when apply is true');
  }

  const result = { ok: true, dryRun: false, deleted: {}, skipped: [], errors: [] };
  let n = 0;
  for (const step of plan) {
    const myN = (n += 1);
    emit({ phase: step.phase, status: 'start', label: step.label, n: myN, total });
    const handler = KIND_HANDLERS[step.kind];
    try {
      const items = await handler.resolve(sdk, step.target);
      if (!items.length) {
        result.skipped.push(step.label);
        emit({ phase: step.phase, status: 'skip', label: `${step.label} (not found)`, n: myN, total });
        continue;
      }
      const deletedIds = await deleteStep(sdk, handler, items);
      (result.deleted[step.kind] = result.deleted[step.kind] || []).push(...deletedIds);
      emit({ phase: step.phase, status: 'ok', label: `${step.label} (${deletedIds.length} deleted)`, n: myN, total });
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
