'use strict';
// Teardown engine coverage: the pure plan (order + omissions), dry-run purity, and the
// resolve→delete execution against a stateful mock SDK — happy path, not-found skips, the
// table not-found tolerance, appaction cascade 404s, and best-effort continue-on-error.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { planTeardown, runTeardown, deleteStep, odataStr, KIND_HANDLERS } = require(path.join(__dirname, '..', 'lib', 'sdk-teardown.js'));
const { appUniqueName } = require(path.join(__dirname, '..', 'lib', 'sdk-build.js'));

const desk = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'samples', 'app-spec.support-desk.json'), 'utf8'));

// A spec exercising every teardown kind (app, dashboards, commands, web resources, tables, solution).
function fullSpec() {
  const s = JSON.parse(JSON.stringify(desk));
  s.webResources = [{ name: 'new_ticket.js', type: 'js', content: '' }];
  s.commands = [{ entity: 'new_ticket', label: 'Escalate', library: 'new_ticket.js', function: 'Ticket.escalate' }];
  s.dashboards = [{ name: 'Operations', tiles: [] }];
  return s;
}

// A stateful mock SDK: preload the artifacts that "exist", answer resolveArtifact by kind/identity,
// and mutate on delete. Records every call for order assertions.
function mockSdk(state = {}) {
  const db = {
    appmodules: state.appmodules || {},        // uniquename -> { appmoduleid, name, appModuleIdUnique? }
    dashboards: state.dashboards || {},        // name -> { formid, name }
    appactions: state.appactions || {},        // entity -> [{ appactionid, buttonlabeltext }]
    forms: state.forms || {},                  // `${entity}:${name}` -> { formid, name }
    charts: state.charts || {},                // `${entity}:${name}` -> { savedqueryvisualizationid, name }
    views: state.views || {},                  // `${entity}:${name}` -> { savedqueryid, name }
    relationships: new Set(state.relationships || []), // schemaNames
    webresources: state.webresources || {},    // name -> { webresourceid, name }
    tables: new Set(state.tables || []),       // logical names (custom — created by a build)
    systemTables: new Set(state.systemTables || []), // logical names (non-custom / reused)
    solutions: state.solutions || {},          // uniquename -> { solutionid, uniquename }
    globalchoices: new Set(state.globalchoices || []), // option set names
  };
  const calls = [];

  const resolveArtifact = async (kind, identity) => {
    calls.push({ method: 'resolveArtifact', kind, identity });
    if (kind === 'app') {
      const row = db.appmodules[identity.uniqueName];
      return row ? [{ id: row.appmoduleid, name: row.name, appModuleIdUnique: row.appModuleIdUnique || row.appmoduleidunique }] : [];
    }
    if (kind === 'dashboard') {
      const row = db.dashboards[identity.name];
      return row ? [{ id: row.formid, name: row.name }] : [];
    }
    if (kind === 'command') {
      const acts = db.appactions[identity.entity];
      return (acts && acts.length) ? [{ id: identity.entity, entity: identity.entity }] : [];
    }
    if (kind === 'form') {
      const key = `${identity.entity}:${identity.name}`;
      const row = db.forms[key];
      return row ? [{ id: row.formid, name: row.name }] : [];
    }
    if (kind === 'chart') {
      const key = `${identity.entity}:${identity.name}`;
      const row = db.charts[key];
      return row ? [{ id: row.savedqueryvisualizationid, name: row.name }] : [];
    }
    if (kind === 'view') {
      const key = `${identity.entity}:${identity.name}`;
      const row = db.views[key];
      return row ? [{ id: row.savedqueryid, name: row.name }] : [];
    }
    if (kind === 'webResource') {
      const row = db.webresources[identity.name];
      return row ? [{ id: row.webresourceid, name: row.name }] : [];
    }
    if (kind === 'solution') {
      const row = db.solutions[identity.uniqueName];
      return row ? [{ id: row.solutionid, name: row.uniquename }] : [];
    }
    return [];
  };

  const deleteAppCascade = async (appModuleId, appModuleIdUnique) => {
    calls.push({ method: 'deleteAppCascade', appModuleId, appModuleIdUnique });
    for (const k of Object.keys(db.appmodules)) {
      if (db.appmodules[k].appmoduleid === appModuleId) {
        delete db.appmodules[k];
        return;
      }
    }
  };

  const deleteRemoteArtifact = async (type, id) => {
    calls.push({ method: 'deleteRemoteArtifact', type, id });
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

  const findTables = async (query, _opts) => {
    calls.push({ method: 'findTables', query });
    const q = String(query).toLowerCase();
    const out = [];
    if (db.tables.has(q)) out.push({ logicalName: q, schemaName: q, entitySetName: `${q}s`, isCustom: true });
    if (db.systemTables.has(q)) out.push({ logicalName: q, schemaName: q, entitySetName: `${q}s`, isCustom: false });
    return out;
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

  return { resolveArtifact, deleteAppCascade, deleteRemoteArtifact, deleteRelationship, deleteWebResource, deleteTable, findTables, deleteSolution, deleteGlobalOptionSet, calls, db };
}

// --- planTeardown (pure) ----------------------------------------------------------------

test('plan is ordered app -> dashboards -> commands -> forms -> charts -> views -> resetDefaultViews -> relationships -> tables -> web-resources -> solution', () => {
  const steps = planTeardown(fullSpec());
  const kinds = steps.map((s) => s.kind);
  // Gap 6: resetDefaultViews steps (drop parent lookups from un-deletable default views) precede the
  // relationships. fullSpec's ticket + comment are 1:N children, so both get a reset step.
  assert.deepStrictEqual(kinds, ['app', 'dashboard', 'commands', 'form', 'form', 'form', 'chart', 'chart', 'view', 'view', 'view', 'resetDefaultViews', 'resetDefaultViews', 'relationship', 'relationship', 'table', 'table', 'table', 'webResource', 'webResource', 'webResource', 'solution']);
});

// Regression (found by live teardown): a table's icon web resource is referenced by the table, so
// it must be planned AFTER the table; and the build's generated default app icon web resource must
// be cleaned up or it leaks as an orphan the spec never declared.
test('a table-icon web resource is torn down AFTER its table, and the generated app icon is cleaned up', () => {
  const spec = {
    solution: { uniqueName: 'IconSln', publisherPrefix: 'new' },
    app: { name: 'Icon App' },
    entities: [{ schemaName: 'new_widget', primaryAttribute: { schemaName: 'new_name' }, columns: [], vectorIcon: 'new_widgeticon.svg' }],
    webResources: [{ name: 'new_widgeticon.svg', type: 'svg', content: '<svg/>' }],
    appShell: { areas: [{ label: 'A', groups: [{ label: 'G', subAreas: [{ entity: 'new_widget' }] }] }] },
  };
  const steps = planTeardown(spec);
  const kinds = steps.map((s) => s.kind);
  const tableIdx = kinds.indexOf('table');
  const firstWrIdx = kinds.indexOf('webResource');
  assert.ok(tableIdx !== -1 && firstWrIdx !== -1, 'both a table and a web resource are planned');
  assert.ok(tableIdx < firstWrIdx, 'web resources are torn down after tables (the table-icon WR is referenced by the table)');
  const wrNames = steps.filter((s) => s.kind === 'webResource').map((s) => s.target.name);
  assert.ok(wrNames.includes('new_widgeticon.svg'), 'the declared table-icon web resource is torn down');
  assert.ok(wrNames.includes(`${appUniqueName(spec)}_icon`), 'the generated default app icon web resource is torn down (no orphan)');
});

// Regression (found by live teardown): a QuickView form referenced by another form's quickViews[]
// must be deleted AFTER its host form. The host embeds a quick-view CONTROL referencing the QV form,
// so deleting the QV form first makes Dataverse 400 ("referenced by 1 other component"); the later
// table cascade does not reliably clean it (a QV form on a surviving/reused table would leak).
test('a QuickView form referenced by another form is torn down AFTER its host form', () => {
  const spec = {
    solution: { uniqueName: 'QvSln', publisherPrefix: 'new' },
    app: { name: 'QV App' },
    entities: [
      { schemaName: 'new_customer', primaryAttribute: { schemaName: 'new_name' }, columns: [] },
      { schemaName: 'new_ticket', primaryAttribute: { schemaName: 'new_subject' }, columns: [] },
    ],
    relationships: [{ type: 'OneToMany', referenced: 'new_customer', referencing: 'new_ticket', lookup: { schemaName: 'new_CustomerId', displayName: 'Customer' } }],
    forms: [
      // The QV form is listed BEFORE its host in the spec array — the plan must still order it last.
      { entity: 'new_customer', name: 'Customer QV', formType: 'QuickView' },
      { entity: 'new_ticket', name: 'Ticket Main', formType: 'Main', quickViews: [{ lookup: 'new_customerid', targetEntity: 'new_customer', form: 'Customer QV', label: 'Customer' }] },
    ],
  };
  const formNames = planTeardown(spec).filter((s) => s.kind === 'form').map((s) => s.target.name);
  const hostIdx = formNames.indexOf('Ticket Main');
  const qvIdx = formNames.indexOf('Customer QV');
  assert.ok(hostIdx !== -1 && qvIdx !== -1, 'both forms are planned');
  assert.ok(hostIdx < qvIdx, 'the host form is torn down before the QuickView form it references');
});

test('the generated app-icon teardown step is skipped when the spec sets an explicit app.icon', () => {
  const spec = {
    solution: { uniqueName: 'IconSln2', publisherPrefix: 'new' },
    app: { name: 'Icon App 2', icon: 'new_appicon.png' },
    entities: [{ schemaName: 'new_widget2', primaryAttribute: { schemaName: 'new_name' }, columns: [] }],
    webResources: [{ name: 'new_appicon.png', type: 'png', contentBase64: '' }],
    appShell: { areas: [{ label: 'A', groups: [{ label: 'G', subAreas: [{ entity: 'new_widget2' }] }] }] },
  };
  const wrNames = planTeardown(spec).filter((s) => s.kind === 'webResource').map((s) => s.target.name);
  assert.ok(!wrNames.includes(`${appUniqueName(spec)}_icon`), 'no generated-icon step when app.icon is explicit');
  assert.ok(wrNames.includes('new_appicon.png'), 'the explicit app.icon WR is still torn down via webResources[]');
});

test('teardown computes the SAME publisher-prefixed relationship name as the build for a system-table rel', () => {
  // Build and teardown must agree on the schema name or teardown can't find the relationship. The
  // default name for a 1:N to a system table (systemuser) is auto-prefixed — planTeardown must
  // produce that identical prefixed name (threads spec.solution.publisherPrefix, like the build).
  const spec = {
    solution: { uniqueName: 'S', publisherPrefix: 'contoso' },
    entities: [
      { schemaName: 'systemuser', primaryAttribute: { schemaName: 'fullname' } },
      { schemaName: 'contoso_teammember', primaryAttribute: { schemaName: 'contoso_name' } },
    ],
    relationships: [{ type: 'OneToMany', referenced: 'systemuser', referencing: 'contoso_teammember', lookup: { schemaName: 'contoso_LinkedUserId', displayName: 'Linked User' } }],
  };
  const relStep = planTeardown(spec).find((s) => s.kind === 'relationship');
  assert.ok(relStep, 'a relationship teardown step exists');
  assert.strictEqual(relStep.target.schemaName, 'contoso_systemuser_teammember');
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
  const { deletedIds, skippedIds } = await deleteStep(sdk, KIND_HANDLERS.view, [{ id: 'v1', name: 'Active X' }]);
  assert.deepStrictEqual(deletedIds, [], 'undeletable system view is not counted as deleted and does not throw');
  assert.deepStrictEqual(skippedIds, ['v1'], 'undeletable system view is recorded as skipped');
});

test('deleteStep tolerates a relationship already-gone 400 ("...but 0 were found") as deleted', async () => {
  const sdk = { deleteRelationship: async () => { const e = new Error('There should be one and only one relationship related to the entity relationship with id cb989759-967a-f111-9d0f-7ced8d711dbf, but 0 were found'); e.statusCode = 400; throw e; } };
  const { deletedIds, skippedIds } = await deleteStep(sdk, KIND_HANDLERS.relationship, [{ id: 'new_a_new_b', schemaName: 'new_a_new_b' }]);
  assert.deepStrictEqual(deletedIds, ['new_a_new_b'], 'an already-gone relationship (0 were found) is counted as deleted, not thrown');
  assert.deepStrictEqual(skippedIds, [], 'not recorded as undeletable');
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
    resolveArtifact: async (kind, identity) => {
      if (kind === 'form') { const e = new Error("The entity with a name = 'new_ghost' was not found in the MetadataCache"); e.statusCode = 400; throw e; }
      if (kind === 'solution') return [{ id: 'sol-1', name: 'S' }];
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

// --- app teardown (via resolveArtifact + deleteAppCascade) ------------------------------

test('app teardown resolves via resolveArtifact and delegates the full cascade to deleteAppCascade', async () => {
  const cascadeCalls = [];
  const sdk = {
    resolveArtifact: async (kind, identity) => {
      if (kind === 'app') return [{ id: 'app-1', name: 'A', appModuleIdUnique: 'u-1' }];
      return [];
    },
    deleteAppCascade: async (appModuleId, appModuleIdUnique) => { cascadeCalls.push({ appModuleId, appModuleIdUnique }); },
  };
  const h = KIND_HANDLERS.app;
  const items = await h.resolve(sdk, { uniqueName: 'new_a' });
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].id, 'app-1');
  assert.strictEqual(items[0].appModuleIdUnique, 'u-1');
  await h.del(sdk, items[0]);
  assert.strictEqual(cascadeCalls.length, 1, 'deleteAppCascade called once');
  assert.strictEqual(cascadeCalls[0].appModuleId, 'app-1', 'app module id passed');
  assert.strictEqual(cascadeCalls[0].appModuleIdUnique, 'u-1', 'unique id passed (deleteAppCascade handles sitemap + genpage internally)');
});

test('app teardown skips when app not found (resolve returns [])', async () => {
  const cascadeCalls = [];
  const sdk = {
    resolveArtifact: async () => [],
    deleteAppCascade: async (...args) => { cascadeCalls.push(args); },
  };
  const h = KIND_HANDLERS.app;
  const items = await h.resolve(sdk, { uniqueName: 'new_a' });
  assert.strictEqual(items.length, 0, 'empty resolve when app not found');
  assert.strictEqual(cascadeCalls.length, 0, 'no cascade when resolve returns []');
});

// deleteAppCascade now returns a structured { success, deleted, failures } result (older vendored
// bundles returned void). The app `del` handler must surface a GENUINE child-cleanup failure as a
// thrown error (so the teardown reports ok=false with the leftover), tolerate a not-found child
// failure (already cascaded away — not a leftover), and stay backward-compatible with a void return.
test('app teardown surfaces a genuine deleteAppCascade cascade failure (orphaned sitemap/genpage) as a thrown error', async () => {
  const sdk = {
    deleteAppCascade: async () => ({
      success: false,
      deleted: [{ type: 'app', id: 'app-1' }],
      failures: [{ operation: 'delete', type: 'sitemap', id: 'sm-1', error: new Error('server exploded') }],
    }),
  };
  await assert.rejects(
    () => KIND_HANDLERS.app.del(sdk, { id: 'app-1', name: 'A', appModuleIdUnique: 'u-1' }),
    /orphaned rows remain.*sitemap sm-1: server exploded/,
    'a real child-cleanup failure must be surfaced, not swallowed'
  );
});

test('app teardown tolerates a not-found deleteAppCascade child failure (already cascaded away)', async () => {
  const notFound = new Error('sitemap not found');
  notFound.statusCode = 404;
  const sdk = {
    deleteAppCascade: async () => ({
      success: false,
      deleted: [{ type: 'app', id: 'app-1' }],
      failures: [{ operation: 'delete', type: 'sitemap', id: 'sm-1', error: notFound }],
    }),
  };
  await assert.doesNotReject(
    () => KIND_HANDLERS.app.del(sdk, { id: 'app-1', name: 'A', appModuleIdUnique: 'u-1' }),
    'a not-found child (already gone) is not a leftover and must not fail the step'
  );
});

test('app teardown treats a clean deleteAppCascade result and a void return alike (no throw)', async () => {
  const cleanSdk = { deleteAppCascade: async () => ({ success: true, deleted: [{ type: 'app', id: 'app-1' }], failures: [] }) };
  const voidSdk = { deleteAppCascade: async () => undefined }; // older bundle contract
  await assert.doesNotReject(() => KIND_HANDLERS.app.del(cleanSdk, { id: 'app-1', name: 'A', appModuleIdUnique: 'u-1' }));
  await assert.doesNotReject(() => KIND_HANDLERS.app.del(voidSdk, { id: 'app-1', name: 'A', appModuleIdUnique: 'u-1' }));
});

test('runTeardown reports ok=false and records the app step when a deleteAppCascade child cleanup fails, but continues to later steps', async () => {
  const solutionDeletes = [];
  const sdk = {
    resolveArtifact: async (kind) => {
      if (kind === 'app') return [{ id: 'app-1', name: 'A', appModuleIdUnique: 'u-1' }];
      if (kind === 'solution') return [{ id: 'sol-1', name: 'ContosoApp' }];
      return [];
    },
    deleteAppCascade: async () => ({
      success: false,
      deleted: [{ type: 'app', id: 'app-1' }],
      failures: [{ operation: 'delete', type: 'genPage', id: 'gp-1', error: new Error('locked') }],
    }),
    deleteSolution: async (id) => { solutionDeletes.push(id); },
  };
  const spec = { app: { name: 'A' }, solution: { uniqueName: 'ContosoApp', publisherPrefix: 'new' } };
  const events = [];
  const r = await runTeardown(spec, { apply: true }, { sdk, emit: (e) => events.push(e) });
  assert.strictEqual(r.ok, false, 'a cascade child-cleanup failure makes the whole run not-ok');
  assert.ok(r.errors.some((e) => /app module "A"/.test(e.step || '') && /genPage gp-1: locked/.test(e.message)), 'the app step error names the orphaned genPage');
  assert.ok(events.some((e) => e.phase === 'app' && e.status === 'error'), 'the app step emits an error status');
  assert.deepStrictEqual(solutionDeletes, ['sol-1'], 'best-effort: the solution step still ran after the app failure');
});

// A main form the build promoted to the entity default (Gap 2) can't be deleted until a stock form
// is restored as the active default. The form handler reverses that before deleting.
test('form teardown restores a stock main form (reactivate + re-default) BEFORE deleting a promoted main form', async () => {
  const calls = [];
  const sdk = {
    queryRecords: async (e) => { calls.push(['queryRecords', e]); return [{ formid: 'ours', formactivationstate: 1, isdefault: true }, { formid: 'stock', formactivationstate: 0, isdefault: false }]; },
    updateRecord: async (e, id, data) => { calls.push(['updateRecord', id, data]); },
    deleteRemoteArtifact: async (t, id) => { calls.push(['delete', id]); },
  };
  await KIND_HANDLERS.form.del(sdk, { id: 'ours', name: 'F', entity: 'new_x', isMain: true });
  assert.ok(calls.some((c) => c[0] === 'updateRecord' && c[1] === 'stock' && c[2].formactivationstate === 1), 'the deactivated stock form is reactivated');
  assert.ok(calls.some((c) => c[0] === 'updateRecord' && c[1] === 'stock' && c[2].isdefault === true), 'the stock form is re-defaulted (demoting ours)');
  const reIdx = calls.findIndex((c) => c[0] === 'updateRecord' && c[2].isdefault === true);
  const delIdx = calls.findIndex((c) => c[0] === 'delete');
  assert.ok(reIdx !== -1 && reIdx < delIdx, 'the stock form is restored before our form is deleted');
});

test('form teardown of a non-main form does not touch systemform default/activation', async () => {
  const calls = [];
  const sdk = {
    queryRecords: async () => { calls.push('q'); return []; },
    updateRecord: async () => { calls.push('u'); },
    deleteRemoteArtifact: async () => { calls.push('d'); },
  };
  await KIND_HANDLERS.form.del(sdk, { id: 'qc', name: 'QC', entity: 'new_x', isMain: false });
  assert.deepStrictEqual(calls, ['d'], 'only the delete runs for a non-main (quick-create/quick-view) form');
});

// Gap 6: before deleting a relationship, teardown resets the child entity's un-deletable default
// views to a lookup-free column set (they'd otherwise block the relationship delete).
test('resetDefaultViews resets an entity\'s default views to the given (lookup-free) column set via enrichDefaultViews', async () => {
  const calls = [];
  const sdk = { enrichDefaultViews: async (logical, cols) => { calls.push({ logical, cols }); return { updated: [] }; } };
  await KIND_HANDLERS.resetDefaultViews.del(sdk, { id: 'new_task', cols: [{ name: 'new_name', width: 300, order: 0 }] });
  assert.strictEqual(calls.length, 1, 'the default views are reset once');
  assert.strictEqual(calls[0].logical, 'new_task');
  assert.ok(!calls[0].cols.some((c) => c.name === 'new_projectid'), 'reset to a column set without the parent lookup');
});

test('planTeardown adds a resetDefaultViews step only for entities that have a 1:N parent lookup', () => {
  const spec = {
    solution: { uniqueName: 'S', publisherPrefix: 'new' }, app: { name: 'A' },
    entities: [
      { schemaName: 'new_project', primaryAttribute: { schemaName: 'new_name' }, columns: [] },
      { schemaName: 'new_task', primaryAttribute: { schemaName: 'new_name' }, columns: [] },
    ],
    relationships: [{ type: 'OneToMany', referenced: 'new_project', referencing: 'new_task', lookup: { schemaName: 'new_ProjectId' } }],
  };
  const resets = planTeardown(spec).filter((s) => s.kind === 'resetDefaultViews').map((s) => s.target.entityLogical);
  assert.deepStrictEqual(resets, ['new_task'], 'only the child (referencing) entity needs its default views reset');
});

// --- dry-run ----------------------------------------------------------------------------

test('dry-run emits the whole plan as skips and never calls SDK', async () => {
  const events = [];
  const throwingSdk = { queryRecords: () => { throw new Error('dry-run must not call SDK'); } };
  const r = await runTeardown(fullSpec(), { apply: false }, { sdk: throwingSdk, emit: (e) => events.push(e) });
  assert.strictEqual(r.dryRun, true);
  assert.strictEqual(r.plan.length, 22); // +1 generated app-icon WR, +1 page-manifest WR, +2 resetDefaultViews (ticket, comment)
  const terminal = events.filter((e) => e.status !== 'start');
  assert.ok(terminal.every((e) => e.status === 'skip'));
  assert.strictEqual(terminal.length, 22);
});

test('apply without an sdk throws', async () => {
  await assert.rejects(() => runTeardown(fullSpec(), { apply: true }, {}), /requires deps\.sdk/);
});

// --- apply (execution) ------------------------------------------------------------------

test('apply deletes every declared artifact in dependency order', async () => {
  const spec = fullSpec();
  const sdk = mockSdk({
    appmodules: { new_supportdesk: { appmoduleid: 'app-1', name: 'Support Desk', appModuleIdUnique: 'u-app-1' } },
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
  const dels = sdk.calls.filter((c) => c.method !== 'resolveArtifact' && c.method !== 'queryRecords' && c.method !== 'findTables');
  const idx = (method, arg) => dels.findIndex((c) => c.method === method && (!arg || (c.type === arg || c.logical === arg || c.id === arg || c.schemaName === arg)));
  assert.ok(idx('deleteRemoteArtifact', 'command') < idx('deleteWebResource'), 'commands before web resource');
  assert.ok(idx('deleteAppCascade') < idx('deleteTable'), 'app before tables');
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
  assert.strictEqual(r.skipped.length, 15); // app, dashboard, commands, 3 forms, 2 charts, 3 views, webResource, generated app-icon WR, page-manifest WR, solution
  assert.strictEqual((r.deleted.table || []).length, 3); // tables counted as deleted (tolerateNotFound)
  assert.strictEqual((r.deleted.relationship || []).length, 2); // relationships counted as deleted (tolerateNotFound)
  // Only table/relationship deletes were attempted (synthetic items); other kinds skipped before delete
  const deletesDone = sdk.calls.filter((c) => c.method !== 'resolveArtifact' && c.method !== 'queryRecords' && c.method !== 'findTables');
  assert.ok(deletesDone.every((c) => c.method === 'deleteTable' || c.method === 'deleteRelationship'), 'only table/relationship deletes attempted');
});

test('table deleteTable not-found error counts as deleted (cosmetic 404)', async () => {
  const sdk = mockSdk({ tables: ['new_customer', 'new_ticket', 'new_comment'], solutions: { ContosoSupportDesk: { solutionid: 'sol-1', uniquename: 'ContosoSupportDesk' } } });
  const r = await runTeardown(desk, { apply: true }, { sdk });
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.strictEqual((r.deleted.table || []).length, 3);
  assert.strictEqual(sdk.db.tables.size, 0);
});

test('teardown skips a reused SYSTEM table (isCustom=false): no delete, no error', async () => {
  const sdk = mockSdk({ systemTables: ['account'], solutions: { S: { solutionid: 'sol-1', uniquename: 'S' } } });
  const spec = { solution: { uniqueName: 'S', publisherPrefix: 'new' }, entities: [{ schemaName: 'account', primaryAttribute: { schemaName: 'name' } }] };
  const r = await runTeardown(spec, { apply: true }, { sdk });
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.ok(!sdk.calls.some((c) => c.method === 'deleteTable'), 'no deleteTable attempted for a system table');
  assert.ok(r.skipped.some((s) => s.includes('table account') && /system table/.test(s)), 'system table recorded as a skip with reason');
});

test('teardown skips a table flagged existing:true (reused custom table): survives, no discovery', async () => {
  const sdk = mockSdk({ tables: ['new_shared'], solutions: { S: { solutionid: 'sol-1', uniquename: 'S' } } });
  const spec = { solution: { uniqueName: 'S', publisherPrefix: 'new' }, entities: [{ schemaName: 'new_shared', existing: true, primaryAttribute: { schemaName: 'new_name' } }] };
  const r = await runTeardown(spec, { apply: true }, { sdk });
  assert.strictEqual(r.ok, true);
  assert.ok(!sdk.calls.some((c) => c.method === 'deleteTable'), 'no deleteTable for an existing:true table');
  assert.ok(!sdk.calls.some((c) => c.method === 'findTables'), 'existing:true short-circuits before discovery');
  assert.ok(r.skipped.some((s) => s.includes('table new_shared') && /existing: true/.test(s)), 'flagged table recorded as a skip');
  assert.ok(sdk.db.tables.has('new_shared'), 'the reused table survives teardown');
});

test('teardown deletes a created custom table but skips a reused system table in the same spec', async () => {
  const sdk = mockSdk({ tables: ['new_order'], systemTables: ['account'], solutions: { S: { solutionid: 'sol-1', uniquename: 'S' } } });
  const spec = { solution: { uniqueName: 'S', publisherPrefix: 'new' }, entities: [
    { schemaName: 'new_order', primaryAttribute: { schemaName: 'new_name' } },
    { schemaName: 'account', primaryAttribute: { schemaName: 'name' } },
  ] };
  const r = await runTeardown(spec, { apply: true }, { sdk });
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  const tableDels = sdk.calls.filter((c) => c.method === 'deleteTable').map((c) => c.logical);
  assert.deepStrictEqual(tableDels, ['new_order'], 'only the created custom table is deleted');
  assert.ok(!sdk.db.tables.has('new_order'), 'created table deleted; system table left intact');
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

test('the page manifest web resource is ALWAYS torn down (even when the spec no longer declares pages, I5)', () => {
  const base = { solution: { uniqueName: 'PgSln', publisherPrefix: 'new' }, app: { name: 'Pages App' },
    entities: [{ schemaName: 'new_widget', primaryAttribute: { schemaName: 'new_name' }, columns: [] }],
    appShell: { areas: [{ label: 'A', groups: [{ label: 'G', subAreas: [{ entity: 'new_widget' }] }] }] } };
  const manifest = `${appUniqueName(base)}_pagemanifest`;
  assert.ok(planTeardown({ ...base, pages: [{ key: 'overview', name: 'Overview', source: { kind: 'tsx', codeFile: 'o.tsx' } }] }).some((s) => s.kind === 'webResource' && s.target.name === manifest), 'with pages');
  assert.ok(planTeardown(base).some((s) => s.kind === 'webResource' && s.target.name === manifest), 'without pages — the derived manifest is still cleaned up');
});

test('deleteStep tolerates a not-found error for non-tolerateNotFound kinds', async () => {
  const sdk = {
    deleteWebResource: async (id) => {
      const err = new Error('Not found');
      err.statusCode = 404;
      throw err;
    },
  };
  const { deletedIds } = await deleteStep(sdk, KIND_HANDLERS.webResource, [{ id: 'wr-1' }]);
  assert.deepStrictEqual(deletedIds, ['wr-1']);
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
    resolveArtifact: async (kind, identity) => {
      if (kind === 'app') return [];
      if (kind === 'solution') return [{ id: 'sol-1', name: 'AiTest' }];
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

// ── Restricted-solution skip (found by live teardown of a DOWNLOADED spec): a downloaded spec whose
// real solution wasn't recovered defaults its solution to the built-in 'Default', which Dataverse
// refuses to delete ("Attempting to delete a restricted solution Default", HTTP 400). Teardown must
// SKIP restricted system solutions (Active/Default/Basic) with an auditable reason — not error. ──
test('teardown SKIPS a restricted system solution (uniquename Default) without erroring', async () => {
  const spec = { app: { name: 'X' }, solution: { uniqueName: 'Default', publisherPrefix: 'new' }, entities: [] };
  // Default exists in the org (as it always does); teardown must not attempt to delete it.
  const sdk = mockSdk({ solutions: { Default: { solutionid: 'sol-def', uniquename: 'Default' } } });
  const res = await runTeardown(spec, { apply: true }, { sdk });
  assert.strictEqual(res.ok, true, 'a restricted solution is skipped, not an error');
  assert.ok(
    res.skipped.some((s) => /solution/i.test(s) && /restricted/i.test(s)),
    `expected a restricted-solution skip reason, got ${JSON.stringify(res.skipped)}`
  );
  assert.ok(!sdk.calls.some((c) => c.method === 'deleteSolution'), 'must NOT attempt to delete the restricted solution');
});

test('teardown still deletes a real (non-restricted) solution — regression', async () => {
  const spec = { app: { name: 'X' }, solution: { uniqueName: 'NucleoLive2', publisherPrefix: 'new' }, entities: [] };
  const sdk = mockSdk({ solutions: { NucleoLive2: { solutionid: 'sol-real', uniquename: 'NucleoLive2' } } });
  const res = await runTeardown(spec, { apply: true }, { sdk });
  assert.strictEqual(res.ok, true);
  assert.ok(
    sdk.calls.some((c) => c.method === 'deleteSolution' && c.id === 'sol-real'),
    'the real solution must still be deleted'
  );
  assert.ok(res.deleted.solution && res.deleted.solution.includes('sol-real'));
});

