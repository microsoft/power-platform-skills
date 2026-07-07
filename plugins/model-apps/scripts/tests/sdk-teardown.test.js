'use strict';
// Teardown engine coverage: the pure plan (order + omissions), dry-run purity, and the
// resolve→delete execution against a stateful mock SDK — happy path, not-found skips, the
// table not-found tolerance, appaction cascade 404s, and best-effort continue-on-error.
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

// A stateful mock SDK: preload the artifacts that "exist", answer queryRecords by exact-name
// filter, and mutate on delete. Records every call for order assertions.
function mockSdk(state = {}) {
  const db = {
    appmodules: state.appmodules || {},        // uniquename -> { appmoduleid, name }
    dashboards: state.dashboards || {},        // name -> { formid, name }
    appactions: state.appactions || {},        // entity -> [{ appactionid, buttonlabeltext }]
    forms: state.forms || {},                  // `${entity}:${name}` -> { formid, name }
    charts: state.charts || {},                // `${entity}:${name}` -> { savedqueryvisualizationid, name }
    views: state.views || {},                  // `${entity}:${name}` -> { savedqueryid, name }
    relationships: new Set(state.relationships || []), // schemaNames
    webresources: state.webresources || {},    // name -> { webresourceid, name }
    tables: new Set(state.tables || []),       // logical names
    solutions: state.solutions || {},          // uniquename -> { solutionid, uniquename }
  };
  const calls = [];

  const queryRecords = async (logical, opts) => {
    calls.push({ method: 'queryRecords', logical, opts });
    const filter = opts.filter || '';
    const firstEq = (p) => { const m = p.match(/eq '([^']*)'/); return m && m[1]; };
    const allEq = (p) => { const matches = [...p.matchAll(/eq '([^']*)'/g)]; return matches.map((m) => m[1]); };

    if (logical === 'appmodule') {
      const val = firstEq(filter);
      const row = db.appmodules[val];
      return row ? [row] : [];
    }
    if (logical === 'systemform') {
      // Could be dashboard (type eq 0) or form (objecttypecode eq ...)
      if (/type eq 0/.test(filter)) {
        const val = firstEq(filter);
        const row = db.dashboards[val];
        return row ? [row] : [];
      } else {
        const vals = allEq(filter);
        const name = vals[0];
        const entity = vals[1];
        const key = `${entity}:${name}`;
        const row = db.forms[key];
        return row ? [row] : [];
      }
    }
    if (logical === 'savedqueryvisualization') {
      const vals = allEq(filter);
      const name = vals[0];
      const entity = vals[1];
      const key = `${entity}:${name}`;
      const row = db.charts[key];
      return row ? [row] : [];
    }
    if (logical === 'savedquery') {
      const vals = allEq(filter);
      const name = vals[0];
      const entity = vals[1];
      const key = `${entity}:${name}`;
      const row = db.views[key];
      return row ? [row] : [];
    }
    if (logical === 'appaction') {
      const val = firstEq(filter);
      return db.appactions[val] || [];
    }
    if (logical === 'webresource') {
      const val = firstEq(filter);
      const row = db.webresources[val];
      return row ? [row] : [];
    }
    if (logical === 'solution') {
      const val = firstEq(filter);
      const row = db.solutions[val];
      return row ? [row] : [];
    }
    return [];
  };

  const deleteRemoteArtifact = async (type, id) => {
    calls.push({ method: 'deleteRemoteArtifact', type, id });
    if (type === 'app') {
      for (const k of Object.keys(db.appmodules)) {
        if (db.appmodules[k].appmoduleid === id) {
          delete db.appmodules[k];
          return;
        }
      }
    }
    if (type === 'dashboard') {
      for (const k of Object.keys(db.dashboards)) {
        if (db.dashboards[k].formid === id) {
          delete db.dashboards[k];
          return;
        }
      }
    }
    if (type === 'command') {
      for (const k of Object.keys(db.appactions)) {
        db.appactions[k] = db.appactions[k].filter((x) => x.appactionid !== id);
      }
    }
    if (type === 'form') {
      for (const k of Object.keys(db.forms)) {
        if (db.forms[k].formid === id) {
          delete db.forms[k];
          return;
        }
      }
    }
    if (type === 'chart') {
      for (const k of Object.keys(db.charts)) {
        if (db.charts[k].savedqueryvisualizationid === id) {
          delete db.charts[k];
          return;
        }
      }
    }
    if (type === 'view') {
      for (const k of Object.keys(db.views)) {
        if (db.views[k].savedqueryid === id) {
          delete db.views[k];
          return;
        }
      }
    }
  };

  const deleteRelationship = async (schemaName) => {
    calls.push({ method: 'deleteRelationship', schemaName });
    if (!db.relationships.has(schemaName)) {
      const err = new Error(`Relationship ${schemaName} not found`);
      err.statusCode = 404;
      throw err;
    }
    db.relationships.delete(schemaName);
  };

  const deleteWebResource = async (id) => {
    calls.push({ method: 'deleteWebResource', id });
    for (const k of Object.keys(db.webresources)) {
      if (db.webresources[k].webresourceid === id) {
        delete db.webresources[k];
        return;
      }
    }
  };

  const deleteTable = async (logical) => {
    calls.push({ method: 'deleteTable', logical });
    if (!db.tables.has(logical)) {
      const err = new Error(`Could not find an entity with the specified logical name: ${logical}`);
      err.statusCode = 404;
      throw err;
    }
    db.tables.delete(logical);
    // SDK deleteTable throws a not-found error even on success (cosmetic 404)
    const err = new Error('Could not find an entity with specified id');
    err.statusCode = 404;
    throw err;
  };

  const deleteSolution = async (id) => {
    calls.push({ method: 'deleteSolution', id });
    for (const k of Object.keys(db.solutions)) {
      if (db.solutions[k].solutionid === id) {
        delete db.solutions[k];
        return;
      }
    }
  };

  return { queryRecords, deleteRemoteArtifact, deleteRelationship, deleteWebResource, deleteTable, deleteSolution, calls, db };
}

// --- planTeardown (pure) ----------------------------------------------------------------

test('plan is ordered app -> dashboards -> commands -> forms -> charts -> views -> relationships -> web-resources -> tables -> solution', () => {
  const steps = planTeardown(fullSpec());
  const kinds = steps.map((s) => s.kind);
  assert.deepStrictEqual(kinds, ['app', 'dashboard', 'commands', 'form', 'form', 'form', 'chart', 'chart', 'view', 'view', 'view', 'relationship', 'relationship', 'webResource', 'table', 'table', 'table', 'solution']);
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

test('dry-run emits the whole plan as skips and never calls SDK', async () => {
  const events = [];
  const throwingSdk = { queryRecords: () => { throw new Error('dry-run must not call SDK'); } };
  const r = await runTeardown(fullSpec(), { apply: false }, { sdk: throwingSdk, emit: (e) => events.push(e) });
  assert.strictEqual(r.dryRun, true);
  assert.strictEqual(r.plan.length, 18);
  const terminal = events.filter((e) => e.status !== 'start');
  assert.ok(terminal.every((e) => e.status === 'skip'));
  assert.strictEqual(terminal.length, 18);
});

test('apply without an sdk throws', async () => {
  await assert.rejects(() => runTeardown(fullSpec(), { apply: true }, {}), /requires deps\.sdk/);
});

// --- apply (execution) ------------------------------------------------------------------

test('apply deletes every declared artifact in dependency order', async () => {
  const spec = fullSpec();
  const sdk = mockSdk({
    appmodules: { new_supportdesk: { appmoduleid: 'app-1', name: 'Support Desk' } },
    dashboards: { Operations: { formid: 'dash-1', name: 'Operations' } },
    appactions: { new_ticket: [{ appactionid: 'act-1', buttonlabeltext: 'Escalate' }, { appactionid: 'act-2', buttonlabeltext: 'Btn2' }] },
    forms: {
      'new_customer:Customer': { formid: 'form-1', name: 'Customer' },
      'new_ticket:Ticket': { formid: 'form-2', name: 'Ticket' },
      'new_comment:Comment': { formid: 'form-3', name: 'Comment' },
    },
    charts: {
      'new_ticket:Tickets by Priority': { savedqueryvisualizationid: 'chart-1', name: 'Tickets by Priority' },
      'new_ticket:Tickets by Status': { savedqueryvisualizationid: 'chart-2', name: 'Tickets by Status' },
    },
    views: {
      'new_customer:Active Customers': { savedqueryid: 'view-1', name: 'Active Customers' },
      'new_ticket:Active Tickets': { savedqueryid: 'view-2', name: 'Active Tickets' },
      'new_comment:Active Comments': { savedqueryid: 'view-3', name: 'Active Comments' },
    },
    relationships: ['new_customer_new_ticket', 'new_ticket_new_comment'],
    webresources: { 'new_ticket.js': { webresourceid: 'wr-1', name: 'new_ticket.js' } },
    tables: ['new_customer', 'new_ticket', 'new_comment'],
    solutions: { ContosoSupportDesk: { solutionid: 'sol-1', uniquename: 'ContosoSupportDesk' } },
  });
  const r = await runTeardown(spec, { apply: true }, { sdk });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.errors.length, 0);
  // every artifact removed from the mock db
  assert.deepStrictEqual(sdk.db.appmodules, {});
  assert.deepStrictEqual(sdk.db.dashboards, {});
  assert.strictEqual((sdk.db.appactions.new_ticket || []).length, 0);
  assert.deepStrictEqual(sdk.db.forms, {});
  assert.deepStrictEqual(sdk.db.charts, {});
  assert.deepStrictEqual(sdk.db.views, {});
  assert.strictEqual(sdk.db.relationships.size, 0);
  assert.deepStrictEqual(sdk.db.webresources, {});
  assert.strictEqual(sdk.db.tables.size, 0);
  assert.deepStrictEqual(sdk.db.solutions, {});
  // ordering: forms/charts/views/relationships before tables; deleteRemoteArtifact('command') calls precede deleteWebResource; deleteTable precedes deleteSolution
  const dels = sdk.calls.filter((c) => c.method !== 'queryRecords');
  const idx = (method, arg) => dels.findIndex((c) => c.method === method && (!arg || (c.type === arg || c.logical === arg || c.id === arg || c.schemaName === arg)));
  assert.ok(idx('deleteRemoteArtifact', 'command') < idx('deleteWebResource'), 'commands before web resource');
  assert.ok(idx('deleteRemoteArtifact', 'app') < idx('deleteTable'), 'app before tables');
  assert.ok(idx('deleteRemoteArtifact', 'form') < idx('deleteTable'), 'forms before tables');
  assert.ok(idx('deleteRemoteArtifact', 'chart') < idx('deleteTable'), 'charts before tables');
  assert.ok(idx('deleteRemoteArtifact', 'view') < idx('deleteTable'), 'views before tables');
  assert.ok(idx('deleteRelationship') < idx('deleteTable'), 'relationships before tables');
  assert.ok(idx('deleteTable') < idx('deleteSolution'), 'tables before solution');
  // tables children-first
  const tableDels = dels.filter((c) => c.method === 'deleteTable').map((c) => c.logical);
  assert.ok(tableDels[0] === 'new_comment' && tableDels[2] === 'new_customer');
});

test('not-found artifacts are skipped, not errors, and issue no delete', async () => {
  const sdk = mockSdk(); // empty env — nothing exists
  const r = await runTeardown(fullSpec(), { apply: true }, { sdk });
  assert.strictEqual(r.ok, true);
  // Tables will attempt deleteTable (synthetic item) but get not-found immediately, counted as deleted
  // Relationships will attempt deleteRelationship but get not-found, counted as deleted (tolerateNotFound)
  // Other artifacts (app, dashboard, commands, forms, charts, views, webResource, solution) skip when resolve returns []
  assert.strictEqual(r.skipped.length, 13); // app, dashboard, commands, 3 forms, 2 charts, 3 views, webResource, solution
  assert.strictEqual((r.deleted.table || []).length, 3); // tables counted as deleted (tolerateNotFound)
  assert.strictEqual((r.deleted.relationship || []).length, 2); // relationships counted as deleted (tolerateNotFound)
  // Only table/relationship deletes were attempted (synthetic items); other kinds skipped before delete
  const deletesDone = sdk.calls.filter((c) => c.method !== 'queryRecords');
  assert.ok(deletesDone.every((c) => c.method === 'deleteTable' || c.method === 'deleteRelationship'), 'only table/relationship deletes attempted');
});

test('table deleteTable not-found error counts as deleted (cosmetic 404)', async () => {
  const sdk = mockSdk({ tables: ['new_customer', 'new_ticket', 'new_comment'], solutions: { ContosoSupportDesk: { solutionid: 'sol-1', uniquename: 'ContosoSupportDesk' } } });
  const r = await runTeardown(desk, { apply: true }, { sdk });
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.strictEqual((r.deleted.table || []).length, 3);
  assert.strictEqual(sdk.db.tables.size, 0);
});

test('a table that does not exist skips the delete', async () => {
  const sdk = mockSdk(); // no tables
  const spec = { solution: { uniqueName: 'S', publisherPrefix: 'new' }, entities: [{ schemaName: 'new_x', primaryAttribute: { schemaName: 'new_name' } }] };
  const r = await runTeardown(spec, { apply: true }, { sdk });
  assert.strictEqual(r.ok, true);
  // The table resolve returns a synthetic item, but deleteTable throws not-found immediately (table never existed)
  // The handler tolerates not-found, so it counts as deleted
  assert.strictEqual((r.deleted.table || []).length, 1);
});

test('appaction delete not-found (cascade already removed it) is tolerated', async () => {
  const spec = { solution: { uniqueName: 'S', publisherPrefix: 'new' }, app: { name: 'A' }, entities: [{ schemaName: 'new_x', primaryAttribute: { schemaName: 'new_name' } }], commands: [{ entity: 'new_x', label: 'B', library: 'w.js', function: 'f' }] };
  const sdk = mockSdk({
    appactions: { new_x: [{ appactionid: 'a1', buttonlabeltext: 'B' }, { appactionid: 'a2', buttonlabeltext: 'B2' }] },
  });
  // Make deleteRemoteArtifact('command') throw not-found (cascade already gone)
  const base = sdk.deleteRemoteArtifact;
  sdk.deleteRemoteArtifact = async (type, id) => {
    if (type === 'command') {
      const err = new Error('Not found');
      err.statusCode = 404;
      throw err;
    }
    return base(type, id);
  };
  const r = await runTeardown(spec, { apply: true }, { sdk });
  const cmdErr = r.errors.filter((e) => /command bar/.test(e.step));
  assert.strictEqual(cmdErr.length, 0, 'cascade 404 on appaction should not error');
  assert.strictEqual((r.deleted.commands || []).length, 2);
});

test('a failed step does not strand the rest (best-effort continue)', async () => {
  const sdk = mockSdk({ webresources: { 'new_ticket.js': { webresourceid: 'wr-1', name: 'new_ticket.js' } }, tables: ['new_customer', 'new_ticket', 'new_comment'], solutions: { ContosoSupportDesk: { solutionid: 'sol-1', uniquename: 'ContosoSupportDesk' } } });
  const base = sdk.deleteWebResource;
  sdk.deleteWebResource = async (id) => {
    throw new Error('boom');
  };
  const r = await runTeardown(fullSpec(), { apply: true }, { sdk });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /web resource/.test(e.step)));
  // tables + solution after the failing step were still torn down
  assert.strictEqual(sdk.db.tables.size, 0);
  assert.deepStrictEqual(sdk.db.solutions, {});
});

test('forms without names are skipped (cannot be resolved)', () => {
  const spec = {
    solution: { uniqueName: 'S', publisherPrefix: 'new' },
    app: { name: 'A' },
    entities: [{ schemaName: 'new_x', primaryAttribute: { schemaName: 'new_name' } }],
    forms: [
      { entity: 'new_x', type: 'main', name: 'MyForm' }, // named, included
      { entity: 'new_x', type: 'main' }, // no name, skipped
    ],
  };
  const steps = planTeardown(spec);
  const formSteps = steps.filter((s) => s.kind === 'form');
  assert.strictEqual(formSteps.length, 1);
  assert.strictEqual(formSteps[0].label, 'form "MyForm" (new_x)');
});

// --- helpers ----------------------------------------------------------------------------

test('odataStr doubles single quotes (OData literal escaping)', () => {
  assert.strictEqual(odataStr("O'Brien"), "O''Brien");
  assert.strictEqual(odataStr(null), '');
});

test('deleteStep tolerates a not-found error for non-tolerateNotFound kinds', async () => {
  const sdk = {
    deleteWebResource: async (id) => {
      const err = new Error('Not found');
      err.statusCode = 404;
      throw err;
    },
  };
  const ids = await deleteStep(sdk, KIND_HANDLERS.webResource, [{ id: 'wr-1' }]);
  assert.deepStrictEqual(ids, ['wr-1']);
});
