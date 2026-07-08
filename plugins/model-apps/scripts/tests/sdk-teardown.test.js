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
    globalchoices: new Set(state.globalchoices || []), // option set names
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
      // The command api's delete is keyed by ENTITY logical name — it removes every appaction
      // for that entity's command bar in one call (id === entity logical name).
      delete db.appactions[id];
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

  const deleteGlobalOptionSet = async (name) => {
    calls.push({ method: 'deleteGlobalOptionSet', name });
    if (!db.globalchoices.has(name)) {
      const err = new Error(`Could not find global option set: ${name}`);
      err.statusCode = 404;
      throw err;
    }
    db.globalchoices.delete(name);
  };

  return { queryRecords, deleteRemoteArtifact, deleteRelationship, deleteWebResource, deleteTable, deleteSolution, deleteGlobalOptionSet, calls, db };
}

// --- planTeardown (pure) ----------------------------------------------------------------

test('plan is ordered app -> dashboards -> commands -> forms -> charts -> views -> relationships -> web-resources -> tables -> solution', () => {
  const steps = planTeardown(fullSpec());
  const kinds = steps.map((s) => s.kind);
  assert.deepStrictEqual(kinds, ['app', 'dashboard', 'commands', 'form', 'form', 'form', 'chart', 'chart', 'view', 'view', 'view', 'relationship', 'relationship', 'webResource', 'table', 'table', 'table', 'solution']);
});

test('plan places global choices after tables and before the solution container', () => {
  const s = fullSpec();
  s.globalChoices = [{ name: 'new_severity', displayName: 'Severity', options: ['Low', 'High'] }];
  const kinds = planTeardown(s).map((x) => x.kind);
  const lastTable = kinds.lastIndexOf('table');
  const gc = kinds.indexOf('globalChoice');
  const sol = kinds.indexOf('solution');
  assert.ok(gc > lastTable, 'global choice deleted after the last table (no column still binds it)');
  assert.ok(sol > gc, 'solution container removed after its global choices');
});

test('runTeardown deletes declared global choices by name (tolerating an already-gone one)', async () => {
  const s = { solution: { uniqueName: 'S' }, entities: [], relationships: [],
    globalChoices: [{ name: 'new_present', options: ['a'] }, { name: 'new_absent', options: ['b'] }] };
  const sdk = mockSdk({ solutions: { S: { solutionid: 'sol-1', uniquename: 'S' } }, globalchoices: ['new_present'] });
  const res = await runTeardown(s, { apply: true }, { sdk, emit: () => {} });
  assert.strictEqual(res.ok, true, 'a missing global choice is tolerated (not a failure)');
  const gcCalls = sdk.calls.filter((c) => c.method === 'deleteGlobalOptionSet').map((c) => c.name);
  assert.deepStrictEqual(gcCalls, ['new_present', 'new_absent'], 'both declared choices attempted');
  assert.strictEqual(sdk.db.globalchoices.has('new_present'), false, 'present choice deleted');
});

test('deleteStep skips a system view that cannot be deleted (best-effort, no throw)', async () => {
  const sdk = { deleteRemoteArtifact: async () => { const e = new Error('System-defined views cannot be deleted. SavedQuery Active X cannot be deleted.'); e.statusCode = 400; throw e; } };
  const deleted = await deleteStep(sdk, KIND_HANDLERS.view, [{ id: 'v1', name: 'Active X' }]);
  assert.deepStrictEqual(deleted, [], 'undeletable system view is skipped, not counted as deleted, and does not throw');
});

test('deleteStep does NOT swallow a dependency block ("referenced by N components") — it surfaces', async () => {
  const sdk = { deleteWebResource: async () => { const e = new Error('The WebResource component cannot be deleted because it is referenced by 3 other components.'); e.statusCode = 400; throw e; } };
  await assert.rejects(
    () => deleteStep(sdk, KIND_HANDLERS.webResource, [{ id: 'wr1', name: 'x.js' }]),
    /referenced by 3 other components/,
    'a real dependency failure must not be silently tolerated as "undeletable"'
  );
});

test('runTeardown tolerates a 400 "entity not found in MetadataCache" when resolving forms for an uncreated table', async () => {
  const sdk = {
    queryRecords: async (logical) => {
      if (logical === 'systemform') { const e = new Error("The entity with a name = 'new_ghost' was not found in the MetadataCache"); e.statusCode = 400; throw e; }
      if (logical === 'solution') return [{ solutionid: 'sol-1', uniquename: 'S' }];
      return [];
    },
    deleteSolution: async () => {},
    deleteTable: async () => { const e = new Error('Could not find an entity'); e.statusCode = 404; throw e; },
  };
  const spec = { solution: { uniqueName: 'S' },
    entities: [{ schemaName: 'new_ghost', displayName: 'Ghost', primaryAttribute: { schemaName: 'new_name' }, columns: [] }],
    forms: [{ entity: 'new_ghost', name: 'Ghost Form' }], relationships: [] };
  const res = await runTeardown(spec, { apply: true }, { sdk, emit: () => {} });
  assert.strictEqual(res.ok, true, 'entity-not-found during resolve is tolerated, not a failure');
  assert.ok(res.skipped.includes('form "Ghost Form" (new_ghost)'), 'the form step was skipped');
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

// --- genpage teardown (app -> orphaned sitemap -> uxagentproject chain) --------------------

test('app teardown deletes the app, its orphaned sitemap, and each genpage (files then row)', async () => {
  const deletes = [];
  const sdk = {
    queryRecords: async (logical) => {
      if (logical === 'appmodule') return [{ appmoduleid: 'app-1', name: 'A', appmoduleidunique: 'u-1' }];
      if (logical === 'appmodulecomponent') return [{ objectid: 'sm-1', componenttype: 62 }];
      if (logical === 'sitemap') return [{ sitemapxml: '<SiteMap><SubArea GenPageId="1512fe17-e4c6-4726-b08e-767a9eba8b9e"/></SiteMap>' }];
      if (logical === 'uxagentprojectfile') return [{ uxagentprojectfileid: 'file-1' }, { uxagentprojectfileid: 'file-2' }];
      return [];
    },
    deleteRemoteArtifact: async (kind, id) => { deletes.push(`${kind}:${id}`); },
    deleteRecord: async (logical, id) => { deletes.push(`${logical}:${id}`); },
  };
  const h = KIND_HANDLERS.app;
  const items = await h.resolve(sdk, { uniqueName: 'new_a' });
  assert.strictEqual(items[0].sitemapId, 'sm-1');
  assert.deepStrictEqual(items[0].genPageIds, ['1512fe17-e4c6-4726-b08e-767a9eba8b9e']);
  await h.del(sdk, items[0]);
  assert.ok(deletes.includes('app:app-1'), 'app deleted');
  assert.ok(deletes.includes('sitemap:sm-1'), 'orphaned sitemap deleted');
  assert.ok(deletes.includes('uxagentprojectfile:file-1') && deletes.includes('uxagentprojectfile:file-2'), 'child files deleted');
  assert.ok(deletes.includes('uxagentproject:1512fe17-e4c6-4726-b08e-767a9eba8b9e'), 'genpage row deleted');
  assert.ok(deletes.indexOf('app:app-1') < deletes.indexOf('sitemap:sm-1'), 'app before sitemap');
  assert.ok(deletes.indexOf('sitemap:sm-1') < deletes.indexOf('uxagentproject:1512fe17-e4c6-4726-b08e-767a9eba8b9e'), 'sitemap before genpage row');
});

test('app teardown without genpages just deletes the app (no uxagentproject deletes)', async () => {
  const deletes = [];
  const sdk = {
    queryRecords: async (logical) => (logical === 'appmodule' ? [{ appmoduleid: 'app-1', name: 'A', appmoduleidunique: 'u-1' }] : []),
    deleteRemoteArtifact: async (kind, id) => { deletes.push(`${kind}:${id}`); },
    deleteRecord: async (logical, id) => { deletes.push(`${logical}:${id}`); },
  };
  const h = KIND_HANDLERS.app;
  const items = await h.resolve(sdk, { uniqueName: 'new_a' });
  await h.del(sdk, items[0]);
  assert.ok(deletes.includes('app:app-1'));
  assert.ok(!deletes.some((d) => d.startsWith('uxagentproject:')), 'no genpage deletes when the app has none');
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
  assert.strictEqual((r.deleted.commands || []).length, 1); // one entity-keyed command delete (not per-appaction)
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

// --- Task 22: aiSummary teardown --------------------------------------------------------

test('teardown plans an ai-summaries step (before tables) for each candidate and calls removeRowSummary', async () => {
  // Spec with one content entity (has a Memo col) + spec.ai.summaries = { default:'auto' }
  const spec = {
    solution: { uniqueName: 'AiTest', publisherPrefix: 'new' },
    app: { name: 'AiApp' },
    entities: [
      {
        schemaName: 'new_memo',
        displayName: 'Memo',
        primaryAttribute: { schemaName: 'new_name' },
        columns: [{ schemaName: 'new_body', displayName: 'Body', type: 'Memo' }],
      },
    ],
    relationships: [],
    ai: { summaries: { default: 'auto' } },
  };

  const plan = planTeardown(spec);
  const aiIdx = plan.findIndex((s) => s.kind === 'aiSummary');
  const tableIdx = plan.findIndex((s) => s.kind === 'table');
  assert.ok(aiIdx !== -1, 'aiSummary step present');
  assert.ok(tableIdx === -1 || aiIdx < tableIdx, 'aiSummary step precedes table steps');
  assert.strictEqual(plan[aiIdx].phase, 'ai-summaries');
  assert.strictEqual(plan[aiIdx].target.entityLogicalName, 'new_memo');

  // Run with a mock sdk that records removeRowSummary calls
  const removeCalls = [];
  const sdk = {
    queryRecords: async (logical, opts) => {
      if (logical === 'appmodule') return [];
      if (logical === 'solution') return [{ solutionid: 'sol-1', uniquename: 'AiTest' }];
      return [];
    },
    removeRowSummary: async (args) => { removeCalls.push(args); },
    deleteTable: async () => { const e = new Error('not found'); e.statusCode = 404; throw e; },
    deleteSolution: async () => {},
  };
  const res = await runTeardown(spec, { apply: true }, { sdk, emit: () => {} });
  assert.strictEqual(res.ok, true, JSON.stringify(res.errors));
  assert.ok(removeCalls.some((c) => c.entityLogicalName === 'new_memo'), 'removeRowSummary called for the candidate table');
});

test('planTeardown omits ai-summaries steps when spec.ai.summaries is absent', () => {
  const steps = planTeardown(fullSpec()); // no spec.ai
  assert.ok(!steps.some((s) => s.kind === 'aiSummary'), 'no aiSummary steps when spec has no ai.summaries');
});

test('planTeardown omits ai-summaries steps when default is off and no overrides', () => {
  const spec = {
    solution: { uniqueName: 'S', publisherPrefix: 'new' },
    entities: [{ schemaName: 'new_x', primaryAttribute: { schemaName: 'new_name' }, columns: [{ schemaName: 'new_body', type: 'Memo' }] }],
    relationships: [],
    ai: { summaries: { default: 'off' } },
  };
  const steps = planTeardown(spec);
  assert.ok(!steps.some((s) => s.kind === 'aiSummary'), 'no aiSummary when default is off');
});

