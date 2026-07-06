'use strict';
// Teardown engine coverage: the pure plan (order + omissions), dry-run purity, and the
// resolve→delete execution against a stateful mock env — happy path, not-found skips, the
// EntityDefinitions cosmetic-404, appaction cascade 404s, and best-effort continue-on-error.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { planTeardown, runTeardown, deleteStep, odataStr, KIND_HANDLERS } = require(path.join(__dirname, '..', 'lib', 'sdk-teardown.js'));

const desk = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'samples', 'app-spec.support-desk.json'), 'utf8'));

// A spec exercising every teardown kind (app, dashboards, commands, web resources, tables, solution).
function fullSpec() {
  const s = JSON.parse(JSON.stringify(desk));
  s.webResources = [{ name: 'new_ticket.js', type: 'js', content: '' }];
  s.commands = [{ entity: 'new_ticket', label: 'Escalate', library: 'new_ticket.js', function: 'Ticket.escalate' }];
  s.dashboards = [{ name: 'Operations', tiles: [] }];
  return s;
}

// A stateful mock Dataverse env: preload the artifacts that "exist", answer resolve GETs by
// exact-name filter, and mutate on DELETE. Records every call for order assertions.
function mockEnv(state = {}) {
  const db = {
    appmodules: state.appmodules || {},        // uniquename -> id
    dashboards: state.dashboards || {},        // name -> id
    appactions: state.appactions || {},        // entity -> [ids]
    webresources: state.webresources || {},    // name -> id
    tables: new Set(state.tables || []),       // logical names
    solutions: state.solutions || {},          // uniquename -> id
  };
  const calls = [];
  const firstEq = (p) => { const m = p.match(/eq '([^']*)'/); return m && m[1]; };
  const logicalOf = (p) => { const m = p.match(/LogicalName='([^']*)'/); return m && m[1]; };
  const idOf = (p) => { const m = p.match(/\(([^)]+)\)/); return m && m[1]; }; // by-id deletes only (EntityDefinitions uses logicalOf)

  const request = async (method, apiPath, body) => {
    calls.push({ method, apiPath, body });
    if (method === 'GET') {
      if (apiPath.startsWith('appmodules?')) { const v = firstEq(apiPath); const id = db.appmodules[v]; return listRes(id ? [{ appmoduleid: id, name: v }] : []); }
      if (apiPath.startsWith('systemforms?')) { const v = firstEq(apiPath); const id = db.dashboards[v]; return listRes(id ? [{ formid: id, name: v }] : []); }
      if (apiPath.startsWith('appactions?')) { const v = firstEq(apiPath); const ids = db.appactions[v] || []; return listRes(ids.map((id) => ({ appactionid: id, buttonlabeltext: 'b' }))); }
      if (apiPath.startsWith('webresourceset?')) { const v = firstEq(apiPath); const id = db.webresources[v]; return listRes(id ? [{ webresourceid: id, name: v }] : []); }
      if (apiPath.startsWith('EntityDefinitions(')) { const l = logicalOf(apiPath); return db.tables.has(l) ? { status: 200, data: { LogicalName: l } } : { status: 404, data: { error: { message: 'does not exist' } } }; }
      if (apiPath.startsWith('solutions?')) { const v = firstEq(apiPath); const id = db.solutions[v]; return listRes(id ? [{ solutionid: id, uniquename: v }] : []); }
    }
    if (method === 'DELETE') {
      if (apiPath.startsWith('appmodules(')) { removeById(db.appmodules, idOf(apiPath)); return { status: 204, data: null }; }
      if (apiPath.startsWith('systemforms(')) { removeById(db.dashboards, idOf(apiPath)); return { status: 204, data: null }; }
      if (apiPath.startsWith('appactions(')) { const id = idOf(apiPath); removeFromLists(db.appactions, id); return { status: 204, data: null }; }
      if (apiPath.startsWith('webresourceset(')) { removeById(db.webresources, idOf(apiPath)); return { status: 204, data: null }; }
      if (apiPath.startsWith('EntityDefinitions(')) { const l = logicalOf(apiPath); db.tables.delete(l); return { status: 404, data: { error: { message: 'Could not find an entity with specified id' } } }; } // cosmetic 404
      if (apiPath.startsWith('solutions(')) { removeById(db.solutions, idOf(apiPath)); return { status: 204, data: null }; }
    }
    return { status: 404, data: null };
  };
  return { request, calls, db };
  function listRes(value) { return { status: 200, data: { value } }; }
  function removeById(map, id) { for (const k of Object.keys(map)) if (map[k] === id) delete map[k]; }
  function removeFromLists(map, id) { for (const k of Object.keys(map)) map[k] = map[k].filter((x) => x !== id); }
}

// --- planTeardown (pure) ----------------------------------------------------------------

test('plan is ordered app -> dashboards -> commands -> web-resources -> tables -> solution', () => {
  const steps = planTeardown(fullSpec());
  const kinds = steps.map((s) => s.kind);
  assert.deepStrictEqual(kinds, ['app', 'dashboard', 'commands', 'webResource', 'table', 'table', 'table', 'solution']);
});

test('tables are torn down children-first (reverse topological order)', () => {
  const steps = planTeardown(desk).filter((s) => s.kind === 'table').map((s) => s.target.logical);
  // relationships: customer -> ticket -> comment ; teardown deletes comment, ticket, then customer.
  assert.deepStrictEqual(steps, ['new_comment', 'new_ticket', 'new_customer']);
});

test('plan omits sections the spec does not declare', () => {
  const steps = planTeardown({ solution: { uniqueName: 'S', publisherPrefix: 'new' }, entities: [{ schemaName: 'new_x', primaryAttribute: { schemaName: 'new_name' } }] });
  assert.deepStrictEqual(steps.map((s) => s.kind), ['table', 'solution']);
});

test('app target uses the derived app uniquename, solution target the solution uniquename', () => {
  const steps = planTeardown(desk);
  const app = steps.find((s) => s.kind === 'app');
  const sol = steps.find((s) => s.kind === 'solution');
  assert.strictEqual(app.target.uniqueName, 'new_supportdesk'); // `${prefix}_${name}` sanitized+lowercased
  assert.strictEqual(sol.target.uniqueName, 'ContosoSupportDesk');
});

// --- dry-run ----------------------------------------------------------------------------

test('dry-run emits the whole plan as skips and never calls request', async () => {
  const events = [];
  const throwingRequest = () => { throw new Error('dry-run must not touch the network'); };
  const r = await runTeardown(fullSpec(), { apply: false }, { request: throwingRequest, emit: (e) => events.push(e) });
  assert.strictEqual(r.dryRun, true);
  assert.strictEqual(r.plan.length, 8);
  const terminal = events.filter((e) => e.status !== 'start');
  assert.ok(terminal.every((e) => e.status === 'skip'));
  assert.strictEqual(terminal.length, 8);
});

test('apply without a request function throws', async () => {
  await assert.rejects(() => runTeardown(fullSpec(), { apply: true }, {}), /requires deps\.request/);
});

// --- apply (execution) ------------------------------------------------------------------

test('apply deletes every declared artifact in dependency order', async () => {
  const spec = fullSpec();
  const env = mockEnv({
    appmodules: { new_supportdesk: 'app-1' },
    dashboards: { Operations: 'dash-1' },
    appactions: { new_ticket: ['act-1', 'act-2'] },
    webresources: { 'new_ticket.js': 'wr-1' },
    tables: ['new_customer', 'new_ticket', 'new_comment'],
    solutions: { ContosoSupportDesk: 'sol-1' },
  });
  const r = await runTeardown(spec, { apply: true }, { request: env.request });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.errors.length, 0);
  // every artifact removed from the mock db
  assert.deepStrictEqual(env.db.appmodules, {});
  assert.deepStrictEqual(env.db.dashboards, {});
  assert.strictEqual((env.db.appactions.new_ticket || []).length, 0);
  assert.deepStrictEqual(env.db.webresources, {});
  assert.strictEqual(env.db.tables.size, 0);
  assert.deepStrictEqual(env.db.solutions, {});
  // ordering: appaction deletes precede the web-resource delete; tables precede the solution delete
  const dels = env.calls.filter((c) => c.method === 'DELETE').map((c) => c.apiPath);
  const idx = (re) => dels.findIndex((p) => re.test(p));
  assert.ok(idx(/appactions\(/) < idx(/webresourceset\(/), 'appactions before web resource');
  assert.ok(idx(/appmodules\(/) < idx(/EntityDefinitions\(/), 'app before tables');
  assert.ok(idx(/EntityDefinitions\(/) < idx(/solutions\(/), 'tables before solution');
  // tables children-first
  const tableDels = dels.filter((p) => /EntityDefinitions\(/.test(p));
  assert.ok(/new_comment/.test(tableDels[0]) && /new_customer/.test(tableDels[2]));
});

test('not-found artifacts are skipped, not errors, and issue no DELETE', async () => {
  const env = mockEnv(); // empty env — nothing exists
  const r = await runTeardown(fullSpec(), { apply: true }, { request: env.request });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.skipped.length, 8);
  assert.strictEqual(env.calls.filter((c) => c.method === 'DELETE').length, 0);
});

test('EntityDefinitions cosmetic 404 counts as deleted (confirmed gone by follow-up GET)', async () => {
  const env = mockEnv({ tables: ['new_customer', 'new_ticket', 'new_comment'], solutions: { ContosoSupportDesk: 'sol-1' } });
  const r = await runTeardown(desk, { apply: true }, { request: env.request });
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.strictEqual((r.deleted.table || []).length, 3);
  assert.strictEqual(env.db.tables.size, 0);
});

test('a table whose delete 404s but is still present is a real error', async () => {
  // A mock whose EntityDefinitions DELETE 404s WITHOUT removing the table (confirm GET still 200).
  const request = async (method, apiPath) => {
    if (method === 'GET' && apiPath.startsWith('EntityDefinitions(')) return { status: 200, data: { LogicalName: 'x' } };
    if (method === 'DELETE' && apiPath.startsWith('EntityDefinitions(')) return { status: 404, data: { error: { message: 'cosmetic' } } };
    return { status: 200, data: { value: [] } };
  };
  const spec = { solution: { uniqueName: 'S', publisherPrefix: 'new' }, entities: [{ schemaName: 'new_x', primaryAttribute: { schemaName: 'new_name' } }] };
  const r = await runTeardown(spec, { apply: true }, { request });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /still exists/.test(e.message)));
});

test('appaction delete 404 (cascade already removed it) is tolerated', async () => {
  const spec = { solution: { uniqueName: 'S', publisherPrefix: 'new' }, app: { name: 'A' }, entities: [{ schemaName: 'new_x', primaryAttribute: { schemaName: 'new_name' } }], commands: [{ entity: 'new_x', label: 'B', library: 'w.js', function: 'f' }] };
  const request = async (method, apiPath) => {
    if (method === 'GET' && apiPath.startsWith('appactions?')) return { status: 200, data: { value: [{ appactionid: 'a1' }, { appactionid: 'a2' }] } };
    if (method === 'DELETE' && apiPath.startsWith('appactions(')) return { status: 404, data: null }; // cascade already gone
    if (method === 'GET') return { status: 404, data: null }; // app/table/solution absent
    return { status: 204, data: null };
  };
  const r = await runTeardown(spec, { apply: true }, { request });
  const cmdErr = r.errors.filter((e) => /command bar/.test(e.step));
  assert.strictEqual(cmdErr.length, 0, 'cascade 404 on appaction should not error');
  assert.strictEqual((r.deleted.commands || []).length, 2);
});

test('a failed step does not strand the rest (best-effort continue)', async () => {
  const env = mockEnv({ webresources: { 'new_ticket.js': 'wr-1' }, tables: ['new_customer', 'new_ticket', 'new_comment'], solutions: { ContosoSupportDesk: 'sol-1' } });
  const base = env.request;
  const request = async (method, apiPath, body) => {
    if (method === 'DELETE' && apiPath.startsWith('webresourceset(')) return { status: 500, data: { error: { message: 'boom' } } };
    return base(method, apiPath, body);
  };
  const r = await runTeardown(fullSpec(), { apply: true }, { request });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /web resource/.test(e.step)));
  // tables + solution after the failing step were still torn down
  assert.strictEqual(env.db.tables.size, 0);
  assert.deepStrictEqual(env.db.solutions, {});
});

// --- helpers ----------------------------------------------------------------------------

test('odataStr doubles single quotes (OData literal escaping)', () => {
  assert.strictEqual(odataStr("O'Brien"), "O''Brien");
  assert.strictEqual(odataStr(null), '');
});

test('deleteStep tolerates a plain 404 for non-cosmetic kinds', async () => {
  const request = async () => ({ status: 404, data: null });
  const ids = await deleteStep(request, KIND_HANDLERS.webResource, [{ id: 'wr-1' }]);
  assert.deepStrictEqual(ids, ['wr-1']);
});
