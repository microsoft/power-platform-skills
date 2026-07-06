'use strict';
// Teardown engine: reverse the model-app-maker build — delete exactly the artifacts a given
// App Spec declares, in dependency-safe order, via the Dataverse Web API. This is the
// first-class, classifier-safe counterpart to the manual delete recipe used during live
// verification: it only ever touches artifacts whose identity is resolved from a name/logical/
// uniquename the spec itself declares (an exact-match OData filter per artifact), so it can
// never wildcard-scan or remove unrelated org data.
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
// executes it via an injected `request(method, apiPath, body?) -> { status, data }` and emits the
// same { phase, status, label, n, total, detail? } progress events the build engine does, so the
// orchestrator narrates teardown with the identical phase-grouped, status-marked log.

const { topoOrderEntities } = require('./_graph.js');
const { appUniqueName, commandsByEntity } = require('./sdk-build.js');

// OData v4 string-literal escaping: a single quote inside a literal is doubled.
function odataStr(v) {
  return String(v == null ? '' : v).replace(/'/g, "''");
}

// Pull Dataverse's structured error message out of a non-2xx response for a readable detail.
function errMsg(res) {
  const d = res && res.data;
  if (d && d.error && d.error.message) return d.error.message;
  if (typeof d === 'string' && d) return d;
  return `HTTP ${res && res.status}`;
}

function isOk(res) {
  return res && res.status >= 200 && res.status < 300;
}

// Per-kind resolve (read-only id lookup, exact-name filtered) + delete handlers. `resolve`
// returns the concrete artifacts to delete ([] when nothing matches — already gone / never
// built). `del` deletes one. A 404 on delete is tolerated as "already gone" (e.g. a flyout
// appaction cascade removes its child buttons) — except for EntityDefinitions, whose delete
// returns a COSMETIC 404 even on success, so we confirm the actual outcome with a follow-up GET.
const KIND_HANDLERS = {
  app: {
    async resolve(request, target) {
      const res = await request('GET', `appmodules?$select=appmoduleid,name&$filter=uniquename eq '${odataStr(target.uniqueName)}'`);
      if (!isOk(res)) throw new Error(`app lookup failed: ${errMsg(res)}`);
      return ((res.data && res.data.value) || []).map((x) => ({ id: x.appmoduleid, name: x.name }));
    },
    del: (request, item) => request('DELETE', `appmodules(${item.id})`),
  },
  dashboard: {
    async resolve(request, target) {
      // Dashboards are systemform rows (type 0); the name filter disambiguates them from forms.
      const res = await request('GET', `systemforms?$select=formid,name&$filter=name eq '${odataStr(target.name)}' and type eq 0`);
      if (!isOk(res)) throw new Error(`dashboard lookup failed: ${errMsg(res)}`);
      return ((res.data && res.data.value) || []).map((x) => ({ id: x.formid, name: x.name }));
    },
    del: (request, item) => request('DELETE', `systemforms(${item.id})`),
  },
  commands: {
    async resolve(request, target) {
      const res = await request('GET', `appactions?$select=appactionid,buttonlabeltext&$filter=contextvalue eq '${odataStr(target.entity)}'`);
      if (!isOk(res)) throw new Error(`command lookup failed: ${errMsg(res)}`);
      return ((res.data && res.data.value) || []).map((x) => ({ id: x.appactionid, name: x.buttonlabeltext }));
    },
    del: (request, item) => request('DELETE', `appactions(${item.id})`),
  },
  webResource: {
    async resolve(request, target) {
      const res = await request('GET', `webresourceset?$select=webresourceid,name&$filter=name eq '${odataStr(target.name)}'`);
      if (!isOk(res)) throw new Error(`web resource lookup failed: ${errMsg(res)}`);
      return ((res.data && res.data.value) || []).map((x) => ({ id: x.webresourceid, name: x.name }));
    },
    del: (request, item) => request('DELETE', `webresourceset(${item.id})`),
  },
  table: {
    async resolve(request, target) {
      const res = await request('GET', `EntityDefinitions(LogicalName='${odataStr(target.logical)}')?$select=LogicalName`);
      if (isOk(res) && res.data && res.data.LogicalName) return [{ id: target.logical, logical: target.logical }];
      if (res && res.status === 404) return [];
      throw new Error(`table lookup failed: ${errMsg(res)}`);
    },
    del: (request, item) => request('DELETE', `EntityDefinitions(LogicalName='${odataStr(item.logical)}')`),
    // EntityDefinitions DELETE answers a cosmetic 404 ("Could not find an entity…") even when it
    // succeeded; confirm with a GET (a 404 there means the table is actually gone).
    cosmetic404: true,
    async confirmGone(request, item) {
      const res = await request('GET', `EntityDefinitions(LogicalName='${odataStr(item.logical)}')?$select=LogicalName`);
      return res && res.status === 404;
    },
  },
  solution: {
    async resolve(request, target) {
      const res = await request('GET', `solutions?$select=solutionid,uniquename&$filter=uniquename eq '${odataStr(target.uniqueName)}'`);
      if (!isOk(res)) throw new Error(`solution lookup failed: ${errMsg(res)}`);
      return ((res.data && res.data.value) || []).map((x) => ({ id: x.solutionid, name: x.uniquename }));
    },
    del: (request, item) => request('DELETE', `solutions(${item.id})`),
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

// Delete the resolved artifacts for one plan step. Returns the ids deleted (a 404 counts as
// already-gone). Throws only on a genuine failure (a non-404 error, or an EntityDefinitions
// delete whose confirming GET shows the table still present).
async function deleteStep(request, handler, items) {
  const deletedIds = [];
  for (const item of items) {
    const res = await handler.del(request, item);
    if (isOk(res)) { deletedIds.push(item.id); continue; }
    if (res && res.status === 404) {
      if (handler.cosmetic404) {
        if (await handler.confirmGone(request, item)) { deletedIds.push(item.id); continue; }
        throw new Error(`delete returned 404 but ${item.logical || item.id} still exists`);
      }
      deletedIds.push(item.id); // already gone (e.g. cascade) — tolerate
      continue;
    }
    throw new Error(errMsg(res));
  }
  return deletedIds;
}

// Execute a teardown. Dry-run (default) emits the plan (no I/O) and returns { ok, dryRun, plan }.
// Apply resolves each step's live id(s) and deletes them, emitting per-step status. Best-effort:
// a failed step is recorded and teardown CONTINUES (halting mid-way would strand orphans), then
// ok=false with an `errors[]` is returned. deps: { request(method, apiPath, body?), emit(event) }.
async function runTeardown(spec, opts = {}, deps = {}) {
  const emit = deps.emit || (() => undefined);
  const request = deps.request;
  const apply = opts.apply === true;
  const plan = planTeardown(spec);
  const total = plan.length;

  if (!apply) {
    plan.forEach((p, i) => emit({ phase: p.phase, status: 'skip', label: p.label, n: i + 1, total }));
    return { ok: true, dryRun: true, plan: plan.map((p) => p.label) };
  }
  if (typeof request !== 'function') {
    throw new Error('runTeardown requires deps.request when apply is true');
  }

  const result = { ok: true, dryRun: false, deleted: {}, skipped: [], errors: [] };
  let n = 0;
  for (const step of plan) {
    const myN = (n += 1);
    emit({ phase: step.phase, status: 'start', label: step.label, n: myN, total });
    const handler = KIND_HANDLERS[step.kind];
    try {
      const items = await handler.resolve(request, step.target);
      if (!items.length) {
        result.skipped.push(step.label);
        emit({ phase: step.phase, status: 'skip', label: `${step.label} (not found)`, n: myN, total });
        continue;
      }
      const deletedIds = await deleteStep(request, handler, items);
      (result.deleted[step.kind] = result.deleted[step.kind] || []).push(...deletedIds);
      emit({ phase: step.phase, status: 'ok', label: `${step.label} (${deletedIds.length} deleted)`, n: myN, total });
    } catch (err) {
      result.ok = false;
      const message = String((err && err.message) || err);
      result.errors.push({ step: step.label, message });
      emit({ phase: step.phase, status: 'error', label: step.label, n: myN, total, detail: message });
      // best-effort: continue to the next step so a single failure doesn't strand the rest.
    }
  }
  return result;
}

module.exports = { planTeardown, runTeardown, deleteStep, odataStr, KIND_HANDLERS };
