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
const { SDK_ROLE_MARKER } = require(path.join(__dirname, '..', 'lib', 'app-spec.js'));

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

  // Form resolution now runs through resolveExistingFormId (type-scoped systemform query), not
  // resolveArtifact. Model it: a `formid eq <id>` lookup echoes the row; an (objecttypecode, name[, type])
  // lookup finds the single form in db.forms. Test forms are all Main (type 2), so type isn't tracked.
  const queryRecords = async (entitySet, opts) => {
    calls.push({ method: 'queryRecords', entitySet });
    const filter = (opts && opts.filter) || '';
    // The app's solution, and which dashboards it holds (componenttype 60). Every dashboard the build
    // creates is added to the app's solution, so each seeded dashboard is a member unless listed in
    // state.foreignDashboards.
    if (entitySet === 'solution') {
      const m = filter.match(/uniquename eq '([^']*)'/);
      const row = m && db.solutions[m[1]];
      return row ? [{ solutionid: row.solutionid }] : [];
    }
    if (entitySet === 'solutioncomponent' && /componenttype eq 60/.test(filter)) {
      return Object.values(db.dashboards).map((d) => d.formid)
        .filter((id) => filter.includes(`objectid eq ${String(id).toLowerCase()}`) && !(state.foreignDashboards || []).includes(id))
        .map((objectid) => ({ objectid }));
    }
    if (entitySet === 'systemform') {
      const idm = filter.match(/formid eq (\S+)/);
      if (idm) {
        for (const k of Object.keys(db.forms)) {
          if (db.forms[k].formid === idm[1]) { const [ent, nm] = k.split(':'); return [{ formid: db.forms[k].formid, objecttypecode: ent, type: 2, name: db.forms[k].name || nm }]; }
        }
        return [];
      }
      const ent = (filter.match(/objecttypecode eq '([^']*)'/) || [])[1];
      const nm = (filter.match(/name eq '([^']*)'/) || [])[1];
      if (ent && nm != null) { const row = db.forms[`${ent}:${nm}`]; return row ? [{ formid: row.formid }] : []; }
    }
    return [];
  };

  return { resolveArtifact, queryRecords, deleteAppCascade, deleteRemoteArtifact, deleteRelationship, deleteWebResource, deleteTable, findTables, deleteSolution, deleteGlobalOptionSet, calls, db };
}

// --- planTeardown (pure) ----------------------------------------------------------------

test('plan is ordered app -> dashboards -> commands -> forms -> charts -> views -> resetDefaultViews -> relationships -> tables -> web-resources -> solution', () => {
  const steps = planTeardown(fullSpec());
  const kinds = steps.map((s) => s.kind);
  // Gap 6: resetDefaultViews steps (drop parent lookups from un-deletable default views) precede the
  // relationships. fullSpec's ticket + comment are 1:N children, so both get a reset step.
  assert.deepStrictEqual(kinds, ['app', 'genpage', 'dashboard', 'commands', 'form', 'form', 'form', 'chart', 'chart', 'view', 'view', 'view', 'resetDefaultViews', 'resetDefaultViews', 'relationship', 'relationship', 'table', 'table', 'table', 'webResource', 'webResource', 'webResource', 'solution']);
});

// Regression (found by LIVE teardown of a self-referencing hierarchy): a 1:N whose referenced and
// referencing tables are the SAME table is removed by the table delete. Deleting it on its own first
// fails — its lookup sits on the same table that hosts the form still referencing it — so teardown
// printed `✗ relationship … referenced by 2 other components` and exited NON-ZERO on a run that then
// deleted the table and left the environment completely clean. Self-referencing hierarchies became a
// mainstream shape once sample data could seed them (#544), so this cry-wolf is now routine.
test('#544 a SELF-referencing relationship is deleted AFTER its table, not before', () => {
  const spec = {
    solution: { uniqueName: 'HierSln', publisherPrefix: 'new' },
    app: { name: 'Hier App' },
    entities: [{ schemaName: 'new_org', primaryAttribute: { schemaName: 'new_name' }, columns: [] }],
    relationships: [{ type: 'OneToMany', referenced: 'new_org', referencing: 'new_org', lookup: { schemaName: 'new_ParentOrgId' } }],
    appShell: { areas: [{ label: 'A', groups: [{ label: 'G', subAreas: [{ entity: 'new_org' }] }] }] },
  };
  const steps = planTeardown(spec);
  const kinds = steps.map((s) => s.kind);
  const relIdx = kinds.indexOf('relationship');
  const tblIdx = kinds.indexOf('table');
  assert.ok(relIdx !== -1, 'it is still planned — deferring, not skipping, is what keeps it safe');
  assert.ok(tblIdx !== -1 && tblIdx < relIdx, 'the table delete (which cascades it) comes first');
});

// If the table is RETAINED, the deferred delete is what stops the relationship leaking. The spec
// cannot tell a retained table from a deleted one (live discovery also skips non-custom tables),
// which is why this is an ordering change rather than a skip.
test('#544 a self-referencing relationship on an EXISTING (retained) table is still planned', () => {
  const spec = {
    solution: { uniqueName: 'HierSln', publisherPrefix: 'new' },
    app: { name: 'Hier App' },
    entities: [{ schemaName: 'new_org', primaryAttribute: { schemaName: 'new_name' }, columns: [], existing: true }],
    relationships: [{ type: 'OneToMany', referenced: 'new_org', referencing: 'new_org', lookup: { schemaName: 'new_ParentOrgId' } }],
    appShell: { areas: [{ label: 'A', groups: [{ label: 'G', subAreas: [{ entity: 'new_org' }] }] }] },
  };
  assert.strictEqual(planTeardown(spec).filter((s) => s.kind === 'relationship').length, 1);
});

// The `relationship` kind already tolerates not-found, which is what makes the deferral safe when
// the table delete cascaded it away. Asserting it here so a future change to that flag is caught.
test('#544 the relationship kind tolerates not-found (what makes the deferral safe)', () => {
  assert.strictEqual(KIND_HANDLERS.relationship.tolerateNotFound, true);
});

// And a normal two-table relationship is untouched by the narrowing — still BEFORE the tables.
test('#544 a relationship between two DIFFERENT tables is still planned before the tables', () => {
  const spec = {
    solution: { uniqueName: 'S', publisherPrefix: 'new' },
    app: { name: 'A' },
    entities: [
      { schemaName: 'new_parent', primaryAttribute: { schemaName: 'new_name' }, columns: [] },
      { schemaName: 'new_child', primaryAttribute: { schemaName: 'new_name' }, columns: [] },
    ],
    relationships: [{ type: 'OneToMany', referenced: 'new_parent', referencing: 'new_child', lookup: { schemaName: 'new_ParentId' } }],
    appShell: { areas: [{ label: 'A', groups: [{ label: 'G', subAreas: [{ entity: 'new_parent' }] }] }] },
  };
  const kinds = planTeardown(spec).map((s) => s.kind);
  assert.strictEqual(kinds.filter((k) => k === 'relationship').length, 1);
  assert.ok(kinds.indexOf('relationship') < kinds.indexOf('table'), 'unchanged ordering for a two-table relationship');
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

test('planTeardown SKIPS an external:true web resource (a re-declared shared/referenced nav icon must not be deleted)', () => {
  const spec = {
    solution: { uniqueName: 'IconSln3', publisherPrefix: 'new' },
    app: { name: 'Icon App 3' },
    entities: [{ schemaName: 'new_widget3', primaryAttribute: { schemaName: 'new_name' }, columns: [] }],
    webResources: [
      { name: 'new_owned.js', type: 'js', content: 'x' },                                   // this app's own → deleted
      { name: 'new_navicon.svg', type: 'svg', contentBase64: 'PHN2Zz4=', external: true },  // re-declared reference → skipped
    ],
    appShell: { areas: [{ label: 'A', groups: [{ label: 'G', subAreas: [{ entity: 'new_widget3' }] }] }] },
  };
  const wrNames = planTeardown(spec).filter((s) => s.kind === 'webResource').map((s) => s.target.name);
  assert.ok(wrNames.includes('new_owned.js'), 'an owned (non-external) web resource is still torn down');
  assert.ok(!wrNames.includes('new_navicon.svg'), 'an external:true web resource is NOT deleted (fail-safe against a shared resource)');
});

test('planTeardown does NOT schedule the derived generated-app-icon delete when its name collides with an external declared WR (Sol: derived cleanup must honor the external skip)', () => {
  const spec = {
    solution: { uniqueName: 'IconSln4', publisherPrefix: 'new' },
    app: { name: 'IconApp4' }, // no app.icon → the generated-icon branch runs
    entities: [{ schemaName: 'new_widget4', primaryAttribute: { schemaName: 'new_name' }, columns: [] }],
    appShell: { areas: [{ label: 'A', groups: [{ label: 'G', subAreas: [{ entity: 'new_widget4' }] }] }] },
  };
  const generatedIcon = `${appUniqueName(spec)}_icon`; // the derived generated-app-icon name
  // A shared nav icon happens to be re-declared under exactly the generated-icon name, flagged external.
  spec.webResources = [{ name: generatedIcon, type: 'svg', contentBase64: 'PHN2Zz4=', external: true }];
  const wrSteps = planTeardown(spec).filter((s) => s.kind === 'webResource' && s.target.name === generatedIcon);
  assert.strictEqual(wrSteps.length, 0, 'no delete step for a generated-icon name that is a declared external WR (the loop protected it; the derived branch must not clobber that)');
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

// A blocked relationship delete must name what is holding it. Dataverse returns only a COUNT, which
// is a dead end on the retained-table path (`existing: true`), where the blocker is typically a form
// the build authored but the CURRENT spec no longer declares — so teardown cannot plan its deletion.
function dependencyBlockSdk({ dataverse } = {}) {
  return {
    deleteRelationship: async () => {
      const e = new Error('The EntityRelationship(cc5fe264-1fb1-f111-aaad-70a8a59c16bf) component cannot be deleted because it is referenced by 2 other components. For a list of referenced components, use the RetrieveDependenciesForDeleteRequest.');
      e.statusCode = 400;
      throw e;
    },
    ...(dataverse ? { dataverse } : {}),
  };
}

test('a dependency-blocked relationship names the blocking components instead of just a count', async () => {
  // Mirrors the live shapes: RelationshipDefinitions resolves the MetadataId, the dependency read
  // returns componenttype 60 (SystemForm), and the form's name comes from `systemforms`.
  const seen = [];
  const dataverse = {
    get: async (p) => {
      seen.push(p);
      if (p.startsWith('/RelationshipDefinitions')) return { status: 200, body: { value: [{ MetadataId: 'cc5fe264-1fb1-f111-aaad-70a8a59c16bf' }] } };
      if (p.startsWith('/RetrieveDependenciesForDelete')) return { status: 200, body: { value: [{ dependentcomponenttype: 60, dependentcomponentobjectid: '5bebe418-1cbd-47c9-91b3-c5a3a31edcb2' }] } };
      if (p.startsWith('/systemforms(')) return { status: 200, body: { name: 'Self Ref Acct Form' } };
      return { status: 404, body: null };
    },
  };
  await assert.rejects(
    () => deleteStep(dependencyBlockSdk({ dataverse }), KIND_HANDLERS.relationship, [{ id: 'pp668_account_account', schemaName: 'pp668_account_account' }]),
    (err) => {
      assert.match(err.message, /referenced by 2 other components/, 'keeps the platform text so isDependencyBlocked still matches');
      assert.match(err.message, /Still referenced by: form "Self Ref Acct Form" \(5bebe418-1cbd-47c9-91b3-c5a3a31edcb2\)/);
      assert.match(err.message, /re-run teardown/, 'tells the operator what to do next');
      return true;
    }
  );
  assert.ok(seen.some((p) => p.includes("SchemaName eq 'pp668_account_account'")), 'resolves the relationship by schema name');
  assert.ok(seen.some((p) => p.includes('ComponentType=10')), 'asks for EntityRelationship dependencies');
});

test('the dependency diagnostic is fail-quiet: without a raw client the platform error is unchanged', async () => {
  // Diagnostics layered on an already-failing delete must never replace a real error with a worse
  // one, so an SDK with no `dataverse` (older callers, unit-test doubles) rethrows verbatim.
  await assert.rejects(
    () => deleteStep(dependencyBlockSdk(), KIND_HANDLERS.relationship, [{ id: 'r1', schemaName: 'r1' }]),
    (err) => {
      assert.match(err.message, /referenced by 2 other components/);
      assert.ok(!/Still referenced by/.test(err.message), 'no half-built diagnostic is appended');
      return true;
    }
  );
});

test('the dependency diagnostic falls back to the raw error when the dependency read fails', async () => {
  const dataverse = { get: async () => { throw new Error('metadata read unavailable'); } };
  await assert.rejects(
    () => deleteStep(dependencyBlockSdk({ dataverse }), KIND_HANDLERS.relationship, [{ id: 'r1', schemaName: 'r1' }]),
    (err) => {
      assert.match(err.message, /referenced by 2 other components/);
      assert.ok(!/metadata read unavailable/.test(err.message), 'the diagnostic failure never masks the real one');
      return true;
    }
  );
});

test('KIND_HANDLERS.form resolve is type-scoped so teardown never deletes a same-named sibling of another type', async () => {
  const queries = [];
  const sdk = {
    queryRecords: async (e, o) => { if (e === 'systemform') { queries.push((o || {}).filter || ''); return [{ formid: 'main-1' }]; } return []; },
    deleteRemoteArtifact: async () => {}, updateRecord: async () => {},
  };
  const items = await KIND_HANDLERS.form.resolve(sdk, { name: 'Information', entity: 'zava_javavendor', formType: 'Main', isMain: true });
  assert.deepStrictEqual(items, [{ id: 'main-1', name: 'Information', entity: 'zava_javavendor', isMain: true }], 'resolves exactly ONE form (the Main), not every same-named row');
  assert.match(queries[0], /objecttypecode eq 'zava_javavendor' and name eq 'Information' and type eq 2/, 'the teardown lookup is type-scoped (Main=2) — a same-named Quick View / Card is never resolved for deletion');
});

test('runTeardown tolerates a 400 "entity not found in MetadataCache" when resolving forms for an uncreated table', async () => {
  const sdk = {
    // Form resolution now runs through resolveExistingFormId → queryRecords('systemform'); an uncreated
    // table's metadata read 400s there, which teardown must tolerate (skip the step), not fail on.
    queryRecords: async (entitySet) => { if (entitySet === 'systemform') { const e = new Error("The entity with a name = 'new_ghost' was not found in the MetadataCache"); e.statusCode = 400; throw e; } return []; },
    resolveArtifact: async (kind) => (kind === 'solution' ? [{ id: 'sol-1', name: 'S' }] : []),
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
  assert.strictEqual(cascadeCalls[0].appModuleIdUnique, 'u-1', 'unique id passed (deleteAppCascade removes the sitemap; generative pages are a separate step)');
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
  // Best-effort: the run carried on past the app failure to the solution step — which, after a failed
  // step, keeps the solution so a re-run can still tell the app's dashboards apart (see below).
  assert.ok(events.some((e) => e.phase === 'solution' && e.status === 'skip' && e.skip === 'kept'), 'the solution step was reached and deliberately kept');
  assert.deepStrictEqual(solutionDeletes, [], 'the solution survives for the re-run');
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

// The dashboard lookup is by NAME, so it can return other apps' dashboards. Deleting every match took
// those with it. Ownership now comes from the app's solution: only the dashboards it holds are deleted,
// and with no real solution to ask none is.
test('teardown deletes only the dashboards the app\'s solution holds, never another app\'s namesake', async () => {
  const spec = { solution: { uniqueName: 'ContosoSln', publisherPrefix: 'new' }, app: { name: 'A' }, entities: [], dashboards: [{ name: 'Operations', tiles: [] }] };
  const run = async (ids, { inSolution, solutionExists = true, failRead = false, sln, noSolution = false } = {}) => {
    const deleted = [];
    const events = [];
    const sdk = {
      resolveArtifact: async (kind) => (kind === 'dashboard' ? ids.map((id) => ({ id, name: 'Operations' })) : kind === 'solution' ? [{ id: 'sol-1', name: 'ContosoSln' }] : []),
      deleteRemoteArtifact: async (type, id) => { deleted.push(id); },
      deleteAppCascade: async () => {},
      deleteSolution: async (id) => { deleted.push(`solution ${id}`); },
      queryRecords: async (set, opts) => {
        if (failRead && set === 'solutioncomponent') throw new Error(failRead);
        if (set === 'solution') return solutionExists ? [{ solutionid: 'sol-1' }] : [];
        if (set === 'solutioncomponent') return (inSolution || []).filter((id) => opts.filter.includes(`objectid eq ${id}`)).map((objectid) => ({ objectid }));
        return [];
      },
    };
    const which = noSolution ? { app: spec.app, entities: [], dashboards: spec.dashboards } : sln ? { ...spec, solution: { ...spec.solution, uniqueName: sln } } : spec;
    const r = await runTeardown(which, { apply: true }, { sdk, emit: (e) => events.push(e) });
    const skip = events.find((e) => e.status === 'skip' && /^dashboard "Operations"/.test(e.label));
    return { deleted: deleted.filter((d) => !/^solution /.test(d)), skip, r, events, solutionDeleted: deleted.includes('solution sol-1') };
  };
  assert.deepStrictEqual((await run(['d-foreign', 'd-ours'], { inSolution: ['d-ours'] })).deleted, ['d-ours'], 'the namesake outside the solution survives');
  assert.deepStrictEqual((await run(['d-1', 'd-2'], { inSolution: ['d-1', 'd-2'] })).deleted, ['d-1', 'd-2'], 'every one the solution holds is this app\'s');
  const foreign = await run(['d-foreign'], { inSolution: [] });
  assert.deepStrictEqual(foreign.deleted, [], 'a lone namesake the solution does not hold is not this build\'s');
  assert.ok(foreign.skip && /none is in this app's solution 'ContosoSln'/.test(foreign.skip.label) && foreign.skip.skip === 'kept', JSON.stringify(foreign.skip));
  // An unreadable solution proves nothing, so nothing is deleted — and it is a FAILED step, not a skip.
  // As a skip it left no error behind, so the solution step then deleted the one thing a re-run needs to
  // tell this app's dashboards from same-named ones. A read error that says "not found" (a proxy's 404)
  // must not slip through runTeardown's not-found shortcut either.
  for (const failRead of ['HTTP 503', 'HTTP 404 Not Found']) {
    const unreadable = await run(['d-ours'], { inSolution: ['d-ours'], failRead });
    assert.deepStrictEqual(unreadable.deleted, [], `${failRead}: nothing is deleted`);
    assert.strictEqual(unreadable.r.ok, false, `${failRead}: the step fails`);
    assert.ok(unreadable.r.errors.some((e) => /^dashboard "Operations"/.test(e.step) && e.message.includes(`could not read solution 'ContosoSln'`) && e.message.includes(failRead)), JSON.stringify(unreadable.r.errors));
    assert.strictEqual(unreadable.skip, undefined, `${failRead}: not reported as a skip`);
    assert.strictEqual(unreadable.solutionDeleted, false, `${failRead}: the solution survives for the re-run`);
    assert.ok(unreadable.events.some((e) => e.phase === 'solution' && e.status === 'skip' && e.skip === 'kept' && /kept — 1 earlier step\(s\) failed/.test(e.label)), JSON.stringify(unreadable.events.filter((e) => e.phase === 'solution')));
  }
  assert.strictEqual((await run(['d-ours'], { inSolution: ['d-ours'] })).solutionDeleted, true, 'a readable solution is still deleted once every step succeeds');
  // The named solution is gone (e.g. a re-run after a completed teardown): a lone namesake can only
  // be somebody else's now, so it is kept — the name posture would have deleted it.
  const gone = await run(['d-foreign'], { solutionExists: false });
  assert.deepStrictEqual(gone.deleted, []);
  assert.match(gone.skip.label, /solution 'ContosoSln' no longer exists/);
  // No real solution to ask — the built-in container a download may leave in the spec holds every
  // dashboard, so it proves nothing. A lone match used to be deleted here, and a re-run after this
  // app's own was gone then deleted another app's namesake; now none is deleted, single or several.
  const lone = await run(['d-1'], { sln: 'Default' });
  assert.deepStrictEqual(lone.deleted, [], 'a lone match may be another app\'s namesake');
  assert.ok(lone.skip && lone.skip.skip === 'kept' && /solution 'Default' is a built-in container that holds every dashboard/.test(lone.skip.label), JSON.stringify(lone.skip));
  assert.deepStrictEqual((await run(['d-1', 'd-2'], { sln: 'Default' })).deleted, [], 'several cannot be told apart either');
  const unnamed = await run(['d-1'], { noSolution: true });
  assert.deepStrictEqual(unnamed.deleted, []);
  assert.match(unnamed.skip.label, /this spec names no solution, so nothing proves a dashboard named 'Operations' is this app's/);
});

// The solution is what a re-run asks to tell this app's dashboards from same-named ones. Deleted after
// a failed step, it left the retry nothing to prove them by: the retry kept them for good, and their
// tiles then blocked the chart and view deletes on every later run. So a teardown with a failed step
// keeps it; a clean one still deletes it.
test('teardown keeps the solution while an earlier step failed, so a re-run can still tell which dashboards are the app\'s', async () => {
  const spec = { solution: { uniqueName: 'ContosoSln', publisherPrefix: 'new' }, app: { name: 'A' }, entities: [], dashboards: [{ name: 'Operations', tiles: [] }] };
  const run = async (failDashboard) => {
    const calls = [];
    const events = [];
    const sdk = {
      resolveArtifact: async (kind) => (kind === 'dashboard' ? [{ id: 'd-ours', name: 'Operations' }] : kind === 'solution' ? [{ id: 'sol-1', name: 'ContosoSln' }] : []),
      deleteRemoteArtifact: async (type, id) => { calls.push(`delete ${type} ${id}`); if (failDashboard) throw new Error('HTTP 429 Too Many Requests'); },
      deleteAppCascade: async () => {},
      deleteSolution: async (id) => { calls.push(`delete solution ${id}`); },
      queryRecords: async (set, opts) => {
        if (set === 'solution') return [{ solutionid: 'sol-1' }];
        if (set === 'solutioncomponent') return opts.filter.includes('objectid eq d-ours') ? [{ objectid: 'd-ours' }] : [];
        return [];
      },
    };
    const r = await runTeardown(spec, { apply: true }, { sdk, emit: (e) => events.push(e) });
    return { r, calls, solutionSkip: events.find((e) => e.status === 'skip' && /^solution ContosoSln/.test(e.label)) };
  };
  const failed = await run(true);
  assert.strictEqual(failed.r.ok, false);
  assert.ok(!failed.calls.includes('delete solution sol-1'), 'the solution survives a failed step');
  assert.ok(failed.solutionSkip && failed.solutionSkip.skip === 'kept' && /kept — 1 earlier step\(s\) failed/.test(failed.solutionSkip.label), JSON.stringify(failed.solutionSkip));
  const clean = await run(false);
  assert.strictEqual(clean.r.ok, true, JSON.stringify(clean.r.errors));
  assert.ok(clean.calls.includes('delete solution sol-1'), 'a clean teardown still deletes it');
});

// A built-in container is never deleted and proves nothing about ownership, so after a failed step it
// keeps its own skip reason — "kept for the re-run" would promise evidence it cannot give.
test('a built-in solution keeps its own skip after a failed step, never the "kept for a re-run" one', async () => {
  const sdk = mockSdk({ webresources: { 'new_ticket.js': { webresourceid: 'wr-1', name: 'new_ticket.js' } }, tables: ['new_customer', 'new_ticket', 'new_comment'] });
  sdk.deleteWebResource = async () => { throw new Error('boom'); };
  const spec = fullSpec();
  spec.solution = { ...spec.solution, uniqueName: 'Default' };
  const r = await runTeardown(spec, { apply: true }, { sdk });
  assert.strictEqual(r.ok, false);
  assert.ok(r.skipped.includes('solution Default (restricted system solution)'), JSON.stringify(r.skipped));
  assert.ok(!r.skipped.some((s) => /re-run needs this solution/.test(s)));
});

// The name lookup reads one page of ten; the app's own dashboard can sort beyond it (see
// findDashboardsByName). Teardown must still find — and delete — it.
test('teardown deletes the app\'s dashboard even when it sorts beyond the first lookup page', async () => {
  const spec = { solution: { uniqueName: 'ContosoSln', publisherPrefix: 'new' }, app: { name: 'A' }, entities: [], dashboards: [{ name: 'Operations', tiles: [] }] };
  const foreign = Array.from({ length: 10 }, (_, i) => ({ id: `d-foreign-${i}`, name: 'Operations' }));
  const deleted = [];
  const sdk = {
    resolveArtifact: async (kind) => (kind === 'dashboard' ? foreign : []),
    deleteRemoteArtifact: async (type, id) => { deleted.push(id); },
    deleteAppCascade: async () => {},
    queryRecords: async (set, opts) => {
      if (set === 'systemform') return [...foreign, { id: 'd-ours' }].map((d) => ({ formid: d.id, name: 'Operations' }));
      if (set === 'solution') return [{ solutionid: 'sol-1' }];
      if (set === 'solutioncomponent') return opts.filter.includes('objectid eq d-ours') ? [{ objectid: 'd-ours' }] : [];
      return [];
    },
  };
  const r = await runTeardown(spec, { apply: true }, { sdk });
  assert.deepStrictEqual(deleted, ['d-ours'], JSON.stringify(r.skipped));
});

// #587 item 6: `existing: true` is ONE ownership policy across tables, relationships and global
// choices. A download flags everything it recovers that way because it cannot prove this build created
// it — but only tables were protected, so tearing down a downloaded spec still deleted their
// relationships (removing the lookup column, and its data, from a table teardown RETAINS) and their
// possibly-shared global option sets.
const ownershipSpec = (flag) => ({
  solution: { uniqueName: 'S', publisherPrefix: 'new' }, app: { name: 'A' },
  entities: [
    { schemaName: 'new_project', ...(flag ? { existing: true } : {}), primaryAttribute: { schemaName: 'new_name' }, columns: [{ schemaName: 'new_stage', displayName: 'Stage', type: 'Choice', globalChoice: 'new_stage' }] },
    { schemaName: 'new_task', ...(flag ? { existing: true } : {}), primaryAttribute: { schemaName: 'new_name' }, columns: [{ schemaName: 'new_due', displayName: 'Due', type: 'DateTime' }] },
  ],
  relationships: [
    { type: 'OneToMany', referenced: 'new_project', referencing: 'new_task', lookup: { schemaName: 'new_ProjectId' }, ...(flag ? { existing: true } : {}) },
    { type: 'ManyToMany', entity1: 'new_project', entity2: 'new_task', ...(flag ? { existing: true } : {}) },
  ],
  globalChoices: [{ name: 'new_stage', options: ['Plan', 'Build'], ...(flag ? { existing: true } : {}) }],
});
const ownershipRun = async (flag) => {
  const sdk = mockSdk({ tables: ['new_project', 'new_task'], relationships: ['new_project_new_task', 'new_new_project_new_task'], globalchoices: ['new_stage'] });
  sdk.enrichDefaultViews = async (logical) => { sdk.calls.push({ method: 'enrichDefaultViews', logical }); return { updated: [] }; };
  const events = [];
  await runTeardown(ownershipSpec(flag), { apply: true }, { sdk, emit: (e) => events.push(e) });
  return { sdk, events };
};

test('teardown retains relationships and global choices flagged existing, exactly like tables (#587 item 6)', async () => {
  const { sdk, events } = await ownershipRun(true);
  const writes = sdk.calls.filter((c) => /^(delete|enrich)/.test(c.method)).map((c) => c.method);
  assert.deepStrictEqual(writes.filter((m) => m !== 'deleteAppCascade' && m !== 'deleteSolution'), [],
    'nothing the download recovered may be deleted — nor may a retained table\'s default views be rewritten');
  for (const prefix of ['relationship ', 'global choice ', 'table ']) {
    // Events carry the skip reason inside the label: `<label> (<reason>)`.
    const skips = events.filter((e) => e.status === 'skip' && String(e.label).startsWith(prefix));
    assert.ok(skips.length && skips.every((e) => /existing: true/.test(e.label)), `${prefix.trim()}: ${JSON.stringify(skips)}`);
  }
});

test('control: an author-built spec still tears down its own relationships and global choices (#587 item 6)', async () => {
  const { sdk } = await ownershipRun(false);
  const methods = sdk.calls.map((c) => c.method);
  assert.strictEqual(methods.filter((m) => m === 'deleteRelationship').length, 2, 'both relationships this build created are deleted');
  assert.ok(methods.includes('deleteGlobalOptionSet'), 'and its global choice');
  assert.ok(methods.includes('enrichDefaultViews'), 'and the child\'s default views are still reset first');
});

// The reset exists only to undo lookups the BUILD surfaced on a table's default views, ahead of that
// relationship's delete. So it follows the build's own enrichment decision (enrichesDefaultViews) and
// needs a relationship that will actually be deleted — otherwise it rewrites views nobody asked it to.
test('resetDefaultViews is planned only where the build enriched the views AND a deleted relationship puts a lookup there', () => {
  const resetsFor = (mutate) => {
    const s = ownershipSpec(false);
    mutate(s);
    return planTeardown(s).filter((st) => st.kind === 'resetDefaultViews').map((st) => st.target.entityLogical);
  };
  assert.deepStrictEqual(resetsFor(() => {}), ['new_task'], 'baseline: the child of a relationship this build deletes');
  assert.deepStrictEqual(resetsFor((s) => { s.entities[1].existing = true; }), [], 'a retained table the build never enriched is left alone');
  assert.deepStrictEqual(resetsFor((s) => { s.entities[1].existing = true; s.entities[1].enrichDefaultViews = true; }), ['new_task'],
    'unless the author opted it into enrichment — then the build did surface the lookup');
  assert.deepStrictEqual(resetsFor((s) => { s.entities[1].enrichDefaultViews = false; }), [], 'enrichment switched off: nothing to undo');
  assert.deepStrictEqual(resetsFor((s) => { s.relationships[0].existing = true; }), [], 'its relationship is retained: no delete to unblock');
});

// --- dry-run ----------------------------------------------------------------------------

test('dry-run emits the whole plan as skips and never calls SDK', async () => {
  const events = [];
  const throwingSdk = { queryRecords: () => { throw new Error('dry-run must not call SDK'); } };
  const r = await runTeardown(fullSpec(), { apply: false }, { sdk: throwingSdk, emit: (e) => events.push(e) });
  assert.strictEqual(r.dryRun, true);
  assert.strictEqual(r.plan.length, 23); // +1 genpage step, +1 generated app-icon WR, +1 page-manifest WR, +2 resetDefaultViews (ticket, comment)
  const terminal = events.filter((e) => e.status !== 'start');
  assert.ok(terminal.every((e) => e.status === 'skip'));
  assert.strictEqual(terminal.length, 23);
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
  assert.strictEqual(r.skipped.length, 16); // app, genpage, dashboard, commands, 3 forms, 2 charts, 3 views, webResource, generated app-icon WR, page-manifest WR, solution
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
  // tables after the failing step were still torn down
  assert.strictEqual(sdk.db.tables.size, 0);
  // ...but not the solution container: a re-run needs it to tell the app's dashboards from namesakes
  assert.deepStrictEqual(Object.keys(sdk.db.solutions), ['ContosoSupportDesk']);
  assert.ok(r.skipped.some((s) => /^solution ContosoSupportDesk \(kept — 1 earlier step\(s\) failed/.test(s)), JSON.stringify(r.skipped));
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

function businessRuleTeardownSdk(rows, { refuseActivatedCopyOnce = false, refuseActivatedCopyAlways = false, staleGoneIds = [] } = {}) {
  const live = new Map(rows.map((r) => [String(r.workflowid), { ...r }]));
  const calls = [];
  const staleGone = new Set(staleGoneIds.map(String));
  const refused = new Set();
  return {
    calls,
    async resolveArtifact(kind) {
      calls.push({ method: 'resolveArtifact', kind });
      return [];
    },
    async queryRecords(entitySet, opts = {}) {
      calls.push({ method: 'queryRecords', entitySet, filter: String(opts.filter || '') });
      if (entitySet !== 'workflow') return [];
      const filter = String(opts.filter || '');
      const wantsType1 = /type eq 1/.test(filter);
      const wantsType2 = /type eq 2/.test(filter);
      return [...live.values()].filter((r) => {
        if (!/category eq 2/.test(filter) || !filter.includes(`name eq '${r.name}'`) || !filter.includes(`primaryentity eq '${r.primaryentity}'`)) return false;
        if (wantsType1 && wantsType2) return r.type === 1 || r.type === 2;
        if (wantsType1) return r.type === 1;
        if (wantsType2) return r.type === 2;
        return true;
      });
    },
    async updateRecord(entitySet, id, data) {
      calls.push({ method: 'updateRecord', entitySet, id, data });
      const row = live.get(String(id));
      // The real SDK routes updateRecord through `ensureSuccess`, so a PATCH against a row that no
      // longer exists THROWS 404. Silently no-op'ing here let a fallback that deactivated an
      // already-DELETED definition look like working defence-in-depth when it could never fire.
      if (!row) {
        const err = new Error(`workflow ${id} not found`);
        err.statusCode = 404;
        throw err;
      }
      Object.assign(row, data);
    },
    async deleteRecord(entitySet, id) {
      calls.push({ method: 'deleteRecord', entitySet, id });
      const row = live.get(String(id));
      if (staleGone.has(String(id)) && !row) {
        const err = new Error('workflow not found');
        err.statusCode = 404;
        throw err;
      }
      if ((refuseActivatedCopyAlways || refuseActivatedCopyOnce) && row && row.type === 2 && (refuseActivatedCopyAlways || !refused.has(String(id)))) {
        refused.add(String(id));
        const err = new Error('The requested action is not supported for activated business rules.');
        err.statusCode = 405;
        throw err;
      }
      if (!row) {
        const err = new Error('workflow not found');
        err.statusCode = 404;
        throw err;
      }
      live.delete(String(id));
    },
    async deleteTable(logical) {
      calls.push({ method: 'deleteTable', logical });
      const err = new Error('Could not find an entity with the specified logical name');
      err.statusCode = 404;
      throw err;
    },
  };
}

test('active business-rule teardown deletes the DEFINITION first, then the activated copy, then the table', async () => {
  const sdk = businessRuleTeardownSdk([
    { workflowid: 'def-1', name: 'Gate', primaryentity: 'new_ticket', category: 2, type: 1, statecode: 1 },
    { workflowid: 'active-1', name: 'Gate', primaryentity: 'new_ticket', category: 2, type: 2, statecode: 1, _parentworkflowid_value: 'def-1' },
  ]);
  const spec = {
    solution: { uniqueName: 'S', publisherPrefix: 'new' },
    entities: [{ schemaName: 'new_ticket', primaryAttribute: { schemaName: 'new_name' } }],
    businessRules: [{ entity: 'new_ticket', name: 'Gate' }],
  };
  const res = await runTeardown(spec, { apply: true }, { sdk, emit: () => {} });
  assert.strictEqual(res.ok, true, JSON.stringify(res.errors));
  assert.deepStrictEqual(res.deleted.businessRules, ['def-1', 'active-1'], 'both workflow rows are counted as this step\'s responsibility');
  const writes = sdk.calls.filter((c) => c.method === 'deleteRecord' || c.method === 'deleteTable');
  // Live-measured order. The definition holds a cascade-restrict reference to the activated copy via
  // `workflow_active_workflow`, so the copy CANNOT be deleted first:
  //   405 "Cascade Delete failed due to cascade restrict relation. Restricting entity Workflow has
  //        Id: <type-1> and is collected by Relationship with name: workflow_active_workflow."
  // Deleting the definition releases it, and the now-orphaned copy deletes cleanly — but ONLY while
  // its table still exists. After the table drop it is undeletable forever (400 0x80041102), which
  // is why both rows must precede the tables phase.
  assert.deepStrictEqual(writes.map((c) => c.method === 'deleteRecord' ? `${c.entitySet}:${c.id}` : `table:${c.logical}`), [
    'workflow:def-1',
    'workflow:active-1',
    'table:new_ticket',
  ]);
});

test('draft-only business-rule teardown keeps the existing definition-only behavior', async () => {
  const sdk = businessRuleTeardownSdk([
    { workflowid: 'def-1', name: 'Draft Gate', primaryentity: 'new_ticket', category: 2, type: 1, statecode: 0 },
  ]);
  const items = await KIND_HANDLERS.businessRules.resolve(sdk, { entity: 'new_ticket', name: 'Draft Gate' });
  assert.deepStrictEqual(items.map((i) => i.id), ['def-1']);
  await deleteStep(sdk, KIND_HANDLERS.businessRules, items);
  assert.deepStrictEqual(
    sdk.calls.filter((c) => c.method === 'updateRecord' || c.method === 'deleteRecord').map((c) => `${c.method}:${c.id}`),
    ['deleteRecord:def-1'],
    'a never-activated Draft rule is still just deleted directly'
  );
});

test('business-rule teardown makes ONE attempt at the activated copy — no retry that cannot succeed', async () => {
  const sdk = businessRuleTeardownSdk([
    { workflowid: 'def-1', name: 'Gate', primaryentity: 'new_ticket', category: 2, type: 1, statecode: 1 },
    { workflowid: 'active-1', name: 'Gate', primaryentity: 'new_ticket', category: 2, type: 2, statecode: 1, _parentworkflowid_value: 'def-1' },
  ], { refuseActivatedCopyAlways: true });
  const spec = {
    solution: { uniqueName: 'S', publisherPrefix: 'new' },
    entities: [{ schemaName: 'new_ticket', primaryAttribute: { schemaName: 'new_name' } }],
    businessRules: [{ entity: 'new_ticket', name: 'Gate' }],
  };
  await runTeardown(spec, { apply: true }, { sdk, emit: () => {} });
  const writes = sdk.calls.filter((c) => c.method === 'deleteRecord' || c.method === 'updateRecord').map((c) => (
    c.method === 'updateRecord' ? `update:${c.id}` : `delete:${c.id}`
  ));
  // Definition first (deactivate -> delete), then exactly ONE attempt at the copy. An earlier
  // version deactivated `parentDefinitionId` and re-issued the same delete, which reads like
  // defence in depth but cannot work: the definition row is already gone by then, so the deactivate
  // 404s and the retry is byte-identical to the call that just failed. It only looked correct
  // because the mock silently no-op'd updateRecord on a missing row.
  assert.deepStrictEqual(writes, ['update:def-1', 'delete:def-1', 'delete:active-1'],
    `expected exactly one copy-delete attempt and no post-delete retry; got: ${writes.join(' | ')}`);
  assert.strictEqual(writes.filter((w) => w === 'delete:active-1').length, 1, 'the copy delete was retried');
});

test('business-rule teardown is idempotent when a resolved activated copy is already gone', async () => {
  const sdk = businessRuleTeardownSdk([
    { workflowid: 'def-1', name: 'Gate', primaryentity: 'new_ticket', category: 2, type: 1, statecode: 0 },
    { workflowid: 'active-1', name: 'Gate', primaryentity: 'new_ticket', category: 2, type: 2, statecode: 1, _parentworkflowid_value: 'def-1' },
  ]);
  const items = await KIND_HANDLERS.businessRules.resolve(sdk, { entity: 'new_ticket', name: 'Gate' });
  // Simulate a re-run race: the row existed at resolve time but another teardown already removed it.
  sdk.calls.length = 0;
  await sdk.deleteRecord('workflow', 'active-1');
  sdk.calls.length = 0;
  const r = await deleteStep(sdk, KIND_HANDLERS.businessRules, items);
  assert.deepStrictEqual(r.deletedIds, ['def-1', 'active-1'], 'already-gone rows count as removed rather than failing the run');
  assert.deepStrictEqual(r.skippedIds, []);
});

test('business-rule teardown reports a failure when the activated copy still cannot be removed', async () => {
  const sdk = businessRuleTeardownSdk([
    { workflowid: 'def-1', name: 'Gate', primaryentity: 'new_ticket', category: 2, type: 1, statecode: 1 },
    { workflowid: 'active-1', name: 'Gate', primaryentity: 'new_ticket', category: 2, type: 2, statecode: 1, _parentworkflowid_value: 'def-1' },
  ], { refuseActivatedCopyAlways: true });
  const spec = {
    solution: { uniqueName: 'S', publisherPrefix: 'new' },
    entities: [{ schemaName: 'new_ticket', primaryAttribute: { schemaName: 'new_name' } }],
    businessRules: [{ entity: 'new_ticket', name: 'Gate' }],
  };
  const res = await runTeardown(spec, { apply: true }, { sdk, emit: () => {} });
  assert.strictEqual(res.ok, false, 'an undeleted activated copy makes teardown report a failed step');
  assert.ok(res.errors.some((e) => /business rule "Gate"/.test(e.step) && /not supported/.test(e.message)), 'the failure names the business-rule step and platform reason');
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

test('planTeardown omits ai-summaries steps when the spec has no `ai` block at all', () => {
  const steps = planTeardown(fullSpec()); // no spec.ai
  assert.ok(!steps.some((s) => s.kind === 'aiSummary'), 'no aiSummary steps when the spec opts out of ai entirely');
});

// The regression this section now guards, found by a LIVE teardown rather than by review.
//
// The build calls `selectSummaryTables` UNCONDITIONALLY whenever `spec.ai` exists, so a spec that
// carries only `ai.appFeatures` still gets a row summary per eligible table. Teardown used to plan
// its removal only `if (spec.ai && spec.ai.summaries)`, so for exactly that spec it planned nothing —
// and the orphaned `msdyn_aimodel` references the table, so Dataverse then REFUSED the table delete:
//   ✗ table new_uptakeorder — HTTP 400 … referenced by 1 other components
// Teardown finished "with errors" having left the table and everything in it behind.
//
// Asserted as build/teardown SYMMETRY rather than as "an aiSummary step exists": the two must plan
// over the identical set, which is the property that was violated, and a one-off existence check
// would not catch the next divergence (`default: 'off'` plus a per-table opt-in, say).
test('teardown plans a row-summary removal for a spec with ai.appFeatures and NO summaries block', () => {
  const { selectSummaryTables } = require(path.join(__dirname, '..', 'lib', 'ai-candidates.js'));
  const spec = {
    solution: { uniqueName: 'AiTest', publisherPrefix: 'new' },
    app: { name: 'AiApp' },
    entities: [
      { schemaName: 'new_memo', displayName: 'Memo', primaryAttribute: { schemaName: 'new_name' }, columns: [{ schemaName: 'new_body', displayName: 'Body', type: 'Memo' }] },
    ],
    relationships: [],
    ai: { appFeatures: { formFill: true } }, // no `summaries` — the shape that regressed
  };

  const built = selectSummaryTables(spec).map((s) => String(s).toLowerCase());
  assert.deepStrictEqual(built, ['new_memo'], 'precondition: the BUILD would create a summary here');

  const plan = planTeardown(spec);
  const planned = plan.filter((s) => s.kind === 'aiSummary').map((s) => s.target.entityLogicalName);
  assert.deepStrictEqual(planned, built, 'teardown must plan exactly the set the build creates');

  const aiIdx = plan.findIndex((s) => s.kind === 'aiSummary');
  const tableIdx = plan.findIndex((s) => s.kind === 'table');
  assert.ok(tableIdx === -1 || aiIdx < tableIdx,
    'the summary must be removed BEFORE the table, or Dataverse refuses the table delete');
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

// --- Security persona roles (Group N P1) ---------------------------------------------------

test('planTeardown orders persona roles AFTER forms and before the data model', () => {
  const spec = Object.assign(fullSpec(), { personas: [
    { persona: 'Agent', jobs: [{ name: 'w', privileges: [{ entity: 'new_ticket', access: ['read'] }] }] },
    { persona: 'Lead', jobs: [{ name: 'm', privileges: [{ entity: 'new_ticket', access: ['read', 'write'] }] }] },
  ] });
  const kinds = planTeardown(spec).map((s) => s.kind);
  assert.strictEqual(kinds[0], 'app');
  // Generative pages are torn down immediately after the app (the SDK no longer cascades them).
  assert.strictEqual(kinds[1], 'genpage');

  // Roles come AFTER forms. `forms[].securityRoles` writes the role id into the form's formxml as a
  // `<DisplayConditions>` entry, and the platform treats that as a real dependency.
  // MEASURED live: deleting the role first answered
  //   HTTP 400 ... The Role(<id>) component cannot be deleted because it is referenced by 1 other
  //   components
  // and the identical delete returned 204 with zero reported dependencies once the forms were gone.
  assert.ok(kinds.indexOf('role') > kinds.lastIndexOf('form'),
    `roles must be deleted after every form; order was ${JSON.stringify(kinds)}`);

  // And still BEFORE any relationship/table delete — the original reason they were early. A role
  // holding a table's privileges can block that table's delete, so this constraint has to survive
  // the move rather than be traded away for the one above.
  assert.ok(kinds.lastIndexOf('role') < kinds.indexOf('relationship'), 'roles before relationships/tables');
  assert.strictEqual(kinds.filter((k) => k === 'role').length, 2, 'both personas are still planned');
});

test('role handler resolves ONLY SDK-authored (marker) unmanaged roles — never a foreign same-name role', async () => {
  const rows = [
    { roleid: 'r1', name: 'Agent', description: SDK_ROLE_MARKER, ismanaged: false }, // ours → delete
    { roleid: 'r2', name: 'Agent', description: 'hand-built by an admin', ismanaged: false }, // foreign → skip (SEC-1)
    { roleid: 'r3', name: 'Agent', description: SDK_ROLE_MARKER, ismanaged: true }, // managed → skip
  ];
  const sdk = { queryRecords: async (entity) => (entity === 'businessunit' ? [{ businessunitid: '00000000-0000-0000-0000-000000000001' }] : entity === 'appmodule' ? [] : rows), deleteSecurityRole: async () => {} };
  const items = await KIND_HANDLERS.role.resolve(sdk, { name: 'Agent' });
  assert.deepStrictEqual(items, [{ id: 'r1', name: 'Agent' }]);
});

test('role handler SKIPS a role still associated with another app (never breaks a shared persona role)', async () => {
  // Teardown deletes the app first, so a remaining app association means another app shares this role.
  const sdk = {
    queryRecords: async (entity) => {
      if (entity === 'businessunit') return [{ businessunitid: '00000000-0000-0000-0000-000000000001' }];
      if (entity === 'appmodule') return [{ appmoduleid: 'other-app' }]; // still used by another app
      return [{ roleid: '11111111-1111-1111-1111-111111111111', name: 'Agent', description: SDK_ROLE_MARKER, ismanaged: false }];
    },
    deleteSecurityRole: async () => {},
  };
  assert.deepStrictEqual(await KIND_HANDLERS.role.resolve(sdk, { name: 'Agent' }), [], 'a role another app still uses must not be deleted');
});

test('role handler FAILS CLOSED when the business unit cannot be resolved (deletes nothing — no cross-BU risk)', async () => {
  // A destructive op must never fall back to a name-only match; an unresolvable BU → delete nothing.
  const sdk = { queryRecords: async (entity) => (entity === 'businessunit' ? [] : [{ roleid: 'r1', description: SDK_ROLE_MARKER, ismanaged: false }]), deleteSecurityRole: async () => {} };
  assert.deepStrictEqual(await KIND_HANDLERS.role.resolve(sdk, { name: 'Agent' }), []);
});

test('role handler del() deletes by role id via deleteSecurityRole', async () => {
  const deleted = [];
  const sdk = { deleteSecurityRole: async (id) => deleted.push(id) };
  await KIND_HANDLERS.role.del(sdk, { id: 'r1', name: 'Agent' });
  assert.deepStrictEqual(deleted, ['r1']);
});

test('role handler resolves nothing (deletes nothing) when the bundle lacks role support — fail-safe', async () => {
  assert.deepStrictEqual(await KIND_HANDLERS.role.resolve({}, { name: 'Agent' }), []);
});

test('role handler swallows a query failure by resolving nothing (never deletes an unproven role)', async () => {
  const sdk = { queryRecords: async () => { throw new Error('no role table'); }, deleteSecurityRole: async () => {} };
  assert.deepStrictEqual(await KIND_HANDLERS.role.resolve(sdk, { name: 'Agent' }), []);
});

test('role handler scopes the role query to the resolved root business unit (prevents cross-BU over-delete)', async () => {
  const BU = '00000000-0000-0000-0000-000000000042';
  const queries = [];
  const sdk = {
    queryRecords: async (entity, opts) => {
      queries.push({ entity, filter: opts.filter });
      if (entity === 'businessunit') return [{ businessunitid: BU }]; // root BU (no explicit persona BU)
      return [{ roleid: 'r1', name: 'Agent', description: SDK_ROLE_MARKER, ismanaged: false }];
    },
    deleteSecurityRole: async () => {},
  };
  const items = await KIND_HANDLERS.role.resolve(sdk, { name: 'Agent' });
  assert.deepStrictEqual(items, [{ id: 'r1', name: 'Agent' }]);
  const roleQ = queries.find((q) => q.entity === 'role');
  assert.ok(roleQ.filter.includes(`_businessunitid_value eq ${BU}`), `role query must be BU-scoped: ${roleQ.filter}`);
});

test('role handler uses an explicit persona businessUnitId (no root-BU lookup needed)', async () => {
  const BU = '00000000-0000-0000-0000-0000000000ab';
  const queries = [];
  const sdk = {
    queryRecords: async (entity, opts) => { queries.push({ entity, filter: opts.filter }); return entity === 'role' ? [{ roleid: 'r1', description: SDK_ROLE_MARKER, ismanaged: false }] : []; },
    deleteSecurityRole: async () => {},
  };
  await KIND_HANDLERS.role.resolve(sdk, { name: 'Agent', businessUnitId: BU });
  assert.ok(!queries.some((q) => q.entity === 'businessunit'), 'an explicit BU skips the root-BU lookup');
  assert.ok(queries.find((q) => q.entity === 'role').filter.includes(`_businessunitid_value eq ${BU}`));
});

test('planTeardown trims the persona name in the role step (matches the SDK-created name)', () => {
  const spec = Object.assign(fullSpec(), { personas: [{ persona: '  Agent  ', jobs: [{ name: 'w', privileges: [{ entity: 'new_ticket', access: ['read'] }] }] }] });
  const roleStep = planTeardown(spec).find((s) => s.kind === 'role');
  assert.strictEqual(roleStep.target.name, 'Agent');
});


// ---------------------------------------------------------------------------------------------
// Generative pages: the SDK's deleteAppCascade no longer removes them, so teardown
// owns that decision for the pages IT authored. These pin who deletes what, and when it backs off.
// ---------------------------------------------------------------------------------------------

// A minimal SDK stand-in for the genpage handler: the page manifest (in a web resource) that says
// which pages this build authored, and the live `uxagentproject` rows used to skip ones already
// gone. The `uxagentprojectfile` branch exists ONLY so tests can prove the handler never touches
// it — deleting the project cascades to its files, and deleting them ourselves would gut a page
// the platform is about to refuse to delete.
function genpageSdk({ manifestPages = [], livePages = [], files = {} } = {}) {
  const deleted = [];
  const queried = [];
  const manifestJson = JSON.stringify({ schemaVersion: 1, pages: manifestPages });
  const sdk = {
    async queryRecords(entity, opts = {}) {
      queried.push(entity);
      const filter = String(opts.filter || '');
      if (entity === 'webresource') {
        return [{ content: Buffer.from(manifestJson, 'utf8').toString('base64') }];
      }
      if (entity === 'uxagentproject') {
        return livePages.filter((id) => filter.toLowerCase().includes(id.toLowerCase())).map((id) => ({ uxagentprojectid: id }));
      }
      if (entity === 'uxagentprojectfile') {
        const owner = (/_uxagentprojectid_value eq ([0-9a-f-]+)/i.exec(filter) || [])[1] || '';
        return (files[owner.toLowerCase()] || []).map((id) => ({ uxagentprojectfileid: id }));
      }
      return [];
    },
    async deleteRecord(entity, id) {
      deleted.push(`${entity}:${id}`);
    },
  };
  return { sdk, deleted, queried };
}
const PAGE_1 = '11111111-1111-4111-8111-111111111111';
const PAGE_2 = '22222222-2222-4222-8222-222222222222';

test('genpage resolve returns only pages the manifest says WE authored', async () => {
  const { sdk } = genpageSdk({
    manifestPages: [{ key: 'overview', name: 'Overview', pageId: PAGE_1 }],
    livePages: [PAGE_1, PAGE_2], // PAGE_2 exists but is not ours
  });
  const items = await KIND_HANDLERS.genpage.resolve(sdk, { manifestName: 'new_app_pagemanifest' });
  assert.deepStrictEqual(items.map((i) => i.id), [PAGE_1]);
});

// Deleting the project cascades to its files (the uxagentproject -> uxagentprojectfile
// relationship is CascadeConfiguration Delete=Cascade), so ONE delete is both necessary and
// sufficient. Deleting files ourselves first would be destructive — see the skip test below.
test('genpage del deletes ONLY the project row and never touches its files', async () => {
  const { sdk, deleted, queried } = genpageSdk({ files: { [PAGE_1.toLowerCase()]: ['f1', 'f2'] } });
  await KIND_HANDLERS.genpage.del(sdk, { id: PAGE_1, name: 'Overview' });
  assert.deepStrictEqual(deleted, [`uxagentproject:${PAGE_1}`]);
  assert.ok(!queried.includes('uxagentprojectfile'), 'must not enumerate the page files');
});

// Dataverse is the authority on whether a page is still in use: saving an app that surfaces a page
// creates a real dependency, and the DELETE then fails with "cannot be deleted because it is
// referenced by N other components" (live-measured, published or not). The delete IS the check —
// there is no pre-flight scan to go stale. (The stronger form of this — asserting the files survive
// — is below; this one pins the deleted/skipped bookkeeping.)
test('genpage records a still-referenced page as SKIPPED, not a failure', async () => {
  const err = new Error('The uxagentproject(11111111) component cannot be deleted because it is referenced by 1 other components.');
  const sdk = {
    async queryRecords() { return []; },
    async deleteRecord() { throw err; },
  };
  const r = await deleteStep(sdk, KIND_HANDLERS.genpage, [{ id: PAGE_1, name: 'Overview' }]);
  assert.deepStrictEqual(r.deletedIds, []);
  assert.deepStrictEqual(r.skippedIds, [PAGE_1]);
});

// A referenced page is a normal outcome, so the run must say so in the operator's words. Reporting
// it as "undeletable" — the wording reserved for system/managed artifacts — would send someone
// hunting a platform problem that does not exist.
test('a dependency block reports as "still referenced", never "undeletable"', async () => {
  const err = new Error('The uxagentproject(11111111) component cannot be deleted because it is referenced by 1 other components.');
  const sdk = {
    async queryRecords() { return []; },
    async deleteRecord() { throw err; },
  };
  const r = await deleteStep(sdk, KIND_HANDLERS.genpage, [{ id: PAGE_1, name: 'Overview' }]);
  assert.deepStrictEqual(r.skipped, [{ id: PAGE_1, reason: 'referenced' }]);
  assert.deepStrictEqual(r.skippedIds, [PAGE_1], 'union list still populated for count-only callers');
});

test('a system/managed artifact still reports as "undeletable", not "referenced"', async () => {
  const sdk = { deleteRemoteArtifact: async () => { const e = new Error('System-defined views cannot be deleted. SavedQuery Active X cannot be deleted.'); e.statusCode = 400; throw e; } };
  const r = await deleteStep(sdk, KIND_HANDLERS.view, [{ id: 'v1', name: 'Active X' }]);
  assert.deepStrictEqual(r.skipped, [{ id: 'v1', reason: 'undeletable' }]);
});

test('a dependency block is still a FAILURE for kinds that did not opt in', async () => {
  const err = new Error('The savedquery(x) component cannot be deleted because it is referenced by 1 other components.');
  const handler = { del: async () => { throw err; } };
  await assert.rejects(() => deleteStep({}, handler, [{ id: 'v1' }]), /referenced by/);
});

// THE regression this ordering exists for. Dataverse tracks a dependency on the page ROW
// (component type 10372) but NOT on its files (10373): measured on pages an app sitemap
// references, the project reports 1 dependent and its DELETE is refused, while every one of its
// files reports ZERO dependents and would delete cleanly. So if the handler deleted files first,
// a skipped page would be left as an empty shell for the app that still references it.
test('a still-referenced page is SKIPPED with its files left completely intact', async () => {
  const err = new Error('The uxagentproject(11111111) component cannot be deleted because it is referenced by 1 other components.');
  const deleted = [];
  const sdk = {
    // The page HAS files — a handler that enumerated and deleted them first would destroy the
    // content of a page the platform then refuses to delete.
    async queryRecords(entity) {
      return entity === 'uxagentprojectfile'
        ? [{ uxagentprojectfileid: 'f1' }, { uxagentprojectfileid: 'f2' }]
        : [];
    },
    async deleteRecord(entity, id) {
      deleted.push(`${entity}:${id}`);
      if (entity === 'uxagentproject') throw err;
    },
  };
  const r = await deleteStep(sdk, KIND_HANDLERS.genpage, [{ id: PAGE_1, name: 'Overview' }]);
  assert.deepStrictEqual(r.skippedIds, [PAGE_1]);
  assert.deepStrictEqual(r.deletedIds, []);
  assert.deepStrictEqual(
    deleted,
    [`uxagentproject:${PAGE_1}`],
    'the page delete must be the ONLY write attempted — its files must survive the skip'
  );
});

test('genpage resolve ignores live pages the manifest does not claim', async () => {
  const { sdk } = genpageSdk({
    manifestPages: [{ key: 'overview', name: 'Overview', pageId: PAGE_1 }],
    livePages: [PAGE_1, PAGE_2],
  });
  const items = await KIND_HANDLERS.genpage.resolve(sdk, { manifestName: 'new_app_pagemanifest' });
  assert.deepStrictEqual(items.map((i) => i.id), [PAGE_1]);
});

test('genpage deletes nothing when the live-existence query fails (cannot prove what is ours)', async () => {
  const sdk = {
    async queryRecords(entity) {
      if (entity === 'webresource') return [{ content: Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: PAGE_1 }] }), 'utf8').toString('base64') }];
      throw new Error('uxagentproject query failed');
    },
    async deleteRecord() {},
  };
  const items = await KIND_HANDLERS.genpage.resolve(sdk, { manifestName: 'new_app_pagemanifest' });
  assert.deepStrictEqual(items, []);
});

test('genpage skips a page the manifest claims but that no longer exists', async () => {
  const { sdk } = genpageSdk({
    manifestPages: [{ key: 'gone', name: 'Gone', pageId: PAGE_1 }],
    livePages: [], // already deleted by hand
  });
  const items = await KIND_HANDLERS.genpage.resolve(sdk, { manifestName: 'new_app_pagemanifest' });
  assert.deepStrictEqual(items, []);
});

test('genpage deletes nothing when the manifest is absent or unreadable', async () => {
  const sdk = { async queryRecords() { throw new Error('no manifest'); }, async deleteRecord() {} };
  const items = await KIND_HANDLERS.genpage.resolve(sdk, { manifestName: 'new_app_pagemanifest' });
  assert.deepStrictEqual(items, []);
});

// --- command teardown: delete order must respect the real hierarchy depth -----------------------
//
// A flyout is THREE levels: anchor (no parent) -> intervening group (parent = anchor) -> buttons
// (parent = group). `_parentappactionid_value` is set on the group AND on the leaves, so ordering by
// "has a parent" collapses them into one bucket and can delete the group while its buttons still
// hang off it — which Dataverse rejects. Seen for real while resetting a command bar by hand: a leaf
// answered 404 because its group had already gone, i.e. the platform cascaded rather than the order
// being right.
//
// Also: the individual rows must go BEFORE the bar. They are the ones holding the web-resource
// dependency that previously stranded a form-JS resource at teardown.
test('command teardown deletes deepest-first, rows before the bar', async () => {
  const ANCHOR = 'a-anchor';
  const GROUP = 'b-group';
  const LEAF1 = 'c-leaf1';
  const LEAF2 = 'd-leaf2';
  const TOP = 'e-top';
  const sdk = {
    resolveArtifact: async () => [{ id: 'bar-1', entity: 'new_ticket' }],
    queryRecords: async (entity) => {
      assert.strictEqual(entity, 'appaction');
      // Deliberately returned shallow-first, so a correct implementation must REORDER them.
      return [
        { appactionid: ANCHOR, _parentappactionid_value: null },
        { appactionid: TOP, _parentappactionid_value: null },
        { appactionid: GROUP, _parentappactionid_value: ANCHOR },
        { appactionid: LEAF1, _parentappactionid_value: GROUP },
        { appactionid: LEAF2, _parentappactionid_value: GROUP },
      ];
    },
  };
  const items = await KIND_HANDLERS.commands.resolve(sdk, { entity: 'new_ticket', ownsTable: true });
  const order = items.map((i) => i.id);

  const pos = (id) => order.indexOf(id);
  assert.ok(pos(LEAF1) < pos(GROUP), `leaf must precede its group: ${order.join(' -> ')}`);
  assert.ok(pos(LEAF2) < pos(GROUP), `leaf must precede its group: ${order.join(' -> ')}`);
  assert.ok(pos(GROUP) < pos(ANCHOR), `group must precede its anchor: ${order.join(' -> ')}`);
  assert.ok(pos(LEAF1) < pos(TOP), 'deeper rows come before unrelated top-level rows');
  assert.strictEqual(order[order.length - 1], 'bar-1', 'the bar is deleted LAST, after every row');
});

test('command teardown survives a self-referential parent pointer', async () => {
  // Depth is computed by walking parent pointers; a cycle must not spin forever. Bad data is not
  // hypothetical here — these rows are written by several different tools.
  const sdk = {
    resolveArtifact: async () => [],
    queryRecords: async () => [
      { appactionid: 'x', _parentappactionid_value: 'y' },
      { appactionid: 'y', _parentappactionid_value: 'x' },
    ],
  };
  const items = await KIND_HANDLERS.commands.resolve(sdk, { entity: 'new_ticket', ownsTable: true });
  assert.strictEqual(items.length, 2, 'both rows are still scheduled for deletion');
});

test('command teardown still refuses to touch a bar on a table the spec does not own', async () => {
  // The fail-closed rule that predates all of this: deleting the bar on an adopted table would
  // destroy another app's buttons.
  const sdk = {
    resolveArtifact: async () => { throw new Error('must not resolve'); },
    queryRecords: async () => { throw new Error('must not query'); },
  };
  const res = await KIND_HANDLERS.commands.resolve(sdk, { entity: 'account', ownsTable: false });
  assert.deepStrictEqual(res.items, []);
  assert.match(res.skipReason, /existing\/external table/);
});

test('command teardown proceeds with the bar when the row listing fails', async () => {
  // Best-effort: an unreadable appaction list must not block the bar delete, which is the
  // pre-existing behaviour.
  const sdk = {
    resolveArtifact: async () => [{ id: 'bar-1', entity: 'new_ticket' }],
    queryRecords: async () => { throw new Error('HTTP 401'); },
  };
  const items = await KIND_HANDLERS.commands.resolve(sdk, { entity: 'new_ticket', ownsTable: true });
  assert.deepStrictEqual(items.map((i) => i.id), ['bar-1']);
});

test('a column visualization on a RETAINED table is cleared at teardown', () => {
  // A visualization is a controlconfiguration row bound to the attribute, so it goes with the table
  // when the table is deleted. A table flagged `existing: true` is deliberately KEPT, and its
  // columns would otherwise keep a renderer this spec applied — residue on somebody else's table.
  const spec = fullSpec();
  spec.entities.push({
    schemaName: 'account', displayName: 'Account', pluralName: 'Accounts', existing: true,
    primaryAttribute: { schemaName: 'name', displayName: 'Name' },
    columns: [{ schemaName: 'new_score', displayName: 'Score', type: 'Integer', visualization: 'StarRating' }],
  });
  const steps = planTeardown(spec, {});
  const viz = steps.filter((s) => s.kind === 'columnVisualization');
  assert.strictEqual(viz.length, 1, `expected one clear step, got ${JSON.stringify(viz.map((v) => v.label))}`);
  assert.strictEqual(viz[0].target.entityLogical, 'account');
  assert.strictEqual(viz[0].target.columnLogical, 'new_score');
  // Before the tables phase: a table we DO own takes its configurations with it, so ordering the
  // clear after the delete would just 404.
  const tableIdx = steps.findIndex((s) => s.kind === 'table');
  assert.ok(steps.indexOf(viz[0]) < tableIdx, 'the clear must precede the tables phase');
});

test('a clear candidate is planned for every declared visualization, ownership decided at resolve', () => {
  // Planning cannot know whether a table survives: `existing: true` is one reason, but a SYSTEM table
  // is retained by live detection the plan has no access to, and such a spec need not carry the flag.
  // So a candidate is planned for each declared visualization and the resolver establishes ownership
  // — it reads the current value and skips unless it still matches what this spec authored.
  const spec = fullSpec();
  spec.entities[0].columns = [{ schemaName: 'new_score', displayName: 'Score', type: 'Integer', visualization: 'StarRating' }];
  const steps = planTeardown(spec, {}).filter((s) => s.kind === 'columnVisualization');
  assert.strictEqual(steps.length, 1);
  assert.strictEqual(steps[0].target.authored, 'StarRating', 'the authored value is what makes the clear safe');
});

test('teardown does NOT clear a visualization somebody else changed', async () => {
  // The configuration row is shared by every app showing the column, and the build PATCHes an
  // existing row rather than creating a private one. Blindly writing 'None' would erase a renderer
  // another maker set after this spec built.
  const calls = [];
  const sdk = {
    getColumnVisualization: async () => 'HeatMap',            // someone changed it
    setColumnVisualization: async (...a) => { calls.push(a); },
  };
  const res = await KIND_HANDLERS.columnVisualization.resolve(sdk, { entityLogical: 'account', columnLogical: 'new_score', authored: 'StarRating' });
  assert.deepStrictEqual(res.items, [], 'nothing to delete when the value is not ours');
  assert.match(res.skipReason, /someone else changed it/);
  assert.strictEqual(calls.length, 0, 'and nothing is written');
});

test('teardown clears a visualization that still matches what this spec authored', async () => {
  const sdk = { getColumnVisualization: async () => 'StarRating', setColumnVisualization: async () => {} };
  const items = await KIND_HANDLERS.columnVisualization.resolve(sdk, { entityLogical: 'account', columnLogical: 'new_score', authored: 'StarRating' });
  assert.strictEqual(items.length, 1);
});

test('teardown skips quietly where the visualization preview is not provisioned', async () => {
  const err = new Error("Resource not found for the segment 'controlconfigurations'.");
  err.statusCode = 404;
  const sdk = { getColumnVisualization: async () => { throw err; } };
  const res = await KIND_HANDLERS.columnVisualization.resolve(sdk, { entityLogical: 'account', columnLogical: 'new_score', authored: 'StarRating' });
  assert.deepStrictEqual(res.items, []);
  assert.match(res.skipReason, /not provisioned/);
});

test('an unreadable current value is left alone rather than cleared', async () => {
  // Fail closed: if ownership cannot be established, doing nothing is the safe outcome.
  const err = new Error('403 forbidden');
  err.statusCode = 403;
  const sdk = { getColumnVisualization: async () => { throw err; } };
  const res = await KIND_HANDLERS.columnVisualization.resolve(sdk, { entityLogical: 'account', columnLogical: 'new_score', authored: 'StarRating' });
  assert.deepStrictEqual(res.items, []);
  assert.match(res.skipReason, /could not read/);
});

test('clearing a visualization writes None through the SDK', async () => {
  const calls = [];
  const sdk = { setColumnVisualization: async (e, c, v) => { calls.push([e, c, v]); } };
  await KIND_HANDLERS.columnVisualization.del(sdk, { entityLogical: 'account', columnLogical: 'new_score' });
  assert.deepStrictEqual(calls, [['account', 'new_score', 'None']]);
});

// --- the teardown business-rule filter is built explicitly, not string-patched ------------------
//
// PR review: this filter used to be `businessRuleFilter(...).replace('type eq 1', '(type eq 1 or
// type eq 2)')`, which coupled teardown to the exact spelling of a function in another module. Any
// reordering or whitespace change there would silently stop the widening — the type-2 activated copy
// would survive the table delete, and #493's residue would return with every test still green.
//
// LIVE-VERIFIED that the widening matters: teardown of a genuinely activated rule reports
// "2 deleted" — the definition AND the platform's activated copy.

test('teardown resolves BOTH the definition and the activated copy (type 1 and type 2)', async () => {
  const queries = [];
  const sdk = {
    queryRecords: async (set, opts) => { queries.push({ set, opts }); return []; },
    updateRecord: async () => {},
    deleteRecord: async () => {},
  };
  await KIND_HANDLERS.businessRules.resolve(sdk, { name: "Lock O'Brien", entity: 'New_Ticket' });

  assert.strictEqual(queries.length, 1);
  const f = queries[0].opts.filter;
  assert.match(f, /\(type eq 1 or type eq 2\)/, 'both row types must be in scope for teardown');
  assert.match(f, /category eq 2/, 'business rules only — never a classic workflow');
  assert.match(f, /primaryentity eq 'new_ticket'/, 'the entity is lower-cased, and the rule is table-scoped');
  // An apostrophe must be OData-escaped by doubling, or the filter is malformed AND injectable.
  assert.match(f, /name eq 'Lock O''Brien'/, "a quote in the name must be escaped, not passed through");
});

test('the teardown filter does NOT depend on businessRuleFilter\'s spelling', async () => {
  // The specific brittleness that was reported. `businessRuleFilter` is the BUILD's definition-only
  // query; teardown must not derive from its text. Asserted on the source so a re-introduction of the
  // `.replace(...)` coupling fails here rather than silently in production.
  //
  // COMMENTS ARE STRIPPED FIRST. The fix's own comment quotes the old pattern verbatim to explain
  // what changed, and a naive source scan matched that prose — a test that fails on its own
  // documentation is worse than no test.
  const raw = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-teardown.js'), 'utf8');
  const code = raw
    .split(/\r?\n/)
    // No `$` anchor: this file is CRLF, and in JS `.` does not match `\r`, so `.*$` never reached the
    // end of a line that still carried one — the strip silently did nothing and this test failed on
    // its own documentation.
    .map((l) => l.replace(/^\s*\/\/.*/, ''))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');           // block comments
  assert.doesNotMatch(code, /businessRuleFilter\([^)]*\)\s*\.replace\(/,
    'teardown must not string-patch businessRuleFilter output');
  // And it must not import the symbol at all, so the coupling cannot creep back in another form.
  const importLine = code.split('\n').find((l) => l.includes("require('./sdk-build.js')")) || '';
  assert.ok(importLine, 'the sdk-build import line must still be findable for this check to mean anything');
  assert.strictEqual(importLine.includes('businessRuleFilter'), false,
    `teardown must not import businessRuleFilter; got: ${importLine.trim().slice(0, 160)}`);
});

// #587 item 7 — the role resolver read the appmodule<->role association to avoid deleting a role
// ANOTHER app still uses, but a failed read set `sharedWithAnotherApp = false`, i.e. "not shared",
// leaving the role eligible for deletion. That is the wrong direction for a destructive decision,
// and it was inconsistent with the very same function: a failure to resolve the business unit
// already returns [] and deletes nothing.
//
// Cost of being wrong each way: fail-closed leaves a role behind that an operator can delete by
// hand; fail-open silently strips permissions from a DIFFERENT app that shares the persona.
test('#587 a role whose sharing check cannot be read is retained, not deleted', async () => {
  const ROLE_ID = '11111111-2222-4333-8444-555555555555';
  const sdkWith = (appmodule) => ({
    deleteSecurityRole: async () => {},
    queryRecords: async (set) => {
      if (set === 'businessunit') return [{ businessunitid: '44444444-4444-4444-4444-444444444444' }];
      if (set === 'role') return [{ roleid: ROLE_ID, name: 'Dispatcher', description: SDK_ROLE_MARKER, ismanaged: false }];
      if (set === 'appmodule') return appmodule();
      return [];
    },
  });

  // CONTROLS first, so a blanket "never delete anything" regression cannot pass this test.
  const deletable = await KIND_HANDLERS.role.resolve(sdkWith(() => []), { name: 'Dispatcher' });
  assert.deepStrictEqual(deletable, [{ id: ROLE_ID, name: 'Dispatcher' }],
    'a role no app still references must remain deletable');

  const shared = await KIND_HANDLERS.role.resolve(sdkWith(() => [{ appmoduleid: 'other-app' }]), { name: 'Dispatcher' });
  assert.deepStrictEqual(shared, [], 'a role another app still references must be retained');

  // The fix: an UNREADABLE sharing check must behave like "shared", not like "not shared".
  const unreadable = await KIND_HANDLERS.role.resolve(
    sdkWith(() => { throw new Error('403 read denied'); }), { name: 'Dispatcher' });
  assert.deepStrictEqual(unreadable, [],
    'an unreadable sharing check must fail CLOSED and retain the role');
});

// #587 item 5 — teardown continued after the APP delete failed. The app module is the dependency
// ROOT: tables, forms, views and charts are its components. Continuing past a failed app delete
// therefore strips a LIVE app of everything it renders, leaving a broken app in the environment —
// strictly worse than stopping and leaving a consistent one for the operator to retry.
//
// Continue-on-error is right for the steps AFTER the root is gone (one undeletable view should not
// strand the rest); it is wrong for the root itself.
test('#587 a failed app delete stops dependent teardown instead of stripping a live app', async () => {
  const seed = {
    appmodules: { [appUniqueName(desk)]: { appmoduleid: 'app-1', name: 'Support Desk' } },
    tables: ['new_customer', 'new_ticket', 'new_comment'],
    solutions: { ContosoSupportDesk: { solutionid: 'sol-1', uniquename: 'ContosoSupportDesk' } },
  };
  const base = mockSdk(seed);
  const sdk = {
    ...base,
    deleteAppCascade: async () => { throw new Error('HTTP 400 app delete refused'); },
  };
  const r = await runTeardown(desk, { apply: true }, { sdk, emit: () => {} });

  assert.strictEqual(r.ok, false, 'a failed app delete must fail the run');
  const destructive = base.calls.filter((c) => /^delete/.test(c.method) && c.method !== 'deleteAppCascade');
  assert.deepStrictEqual(destructive.map((c) => c.method), [],
    'nothing dependent may be deleted once the app itself was not removed');
  assert.ok(r.errors.some((e) => /app delete refused/.test(e.message)), 'the real cause must be reported');
  assert.strictEqual(base.db.tables.size, 3, 'the tables the live app renders must still be there');
});

// The distinction that makes the rule safe. `app.del` ALSO throws when the app record WAS removed
// and only a cascade cleanup step failed — aborting there would strand MORE orphans, not fewer. So
// the abort is conditioned on the app not being proven deleted, not on "the app step threw".
test('#587 a cascade-cleanup failure still lets teardown continue — the app itself is gone', async () => {
  const seed = {
    appmodules: { [appUniqueName(desk)]: { appmoduleid: 'app-1', name: 'Support Desk' } },
    tables: ['new_customer', 'new_ticket', 'new_comment'],
    solutions: { ContosoSupportDesk: { solutionid: 'sol-1', uniquename: 'ContosoSupportDesk' } },
  };
  const base = mockSdk(seed);
  const sdk = {
    ...base,
    deleteAppCascade: async (id, unique) => {
      await base.deleteAppCascade(id, unique); // the app row really is removed
      return { success: false, deleted: [], retained: [], failures: [{ operation: 'delete', type: 'sitemap', id: 's1', error: new Error('HTTP 500 cleanup failed') }] };
    },
  };
  const r = await runTeardown(desk, { apply: true }, { sdk, emit: () => {} });

  assert.strictEqual(r.ok, false, 'the cleanup failure is still a failure');
  assert.strictEqual(base.db.tables.size, 0,
    'the app is gone, so its dependents must still be torn down rather than left orphaned');
});

// The SDK's deleteAppCascade deletes remotely and THEN tidies its local workspace copy of the app, so a
// failure in that second, local step rejects the whole call after the app is already gone. Teardown read
// the rejection as "the app was not deleted" and abandoned every dependent step — leaving them all behind
// while reporting the app as still there.
test('an app delete that fails AFTER the app is gone still tears down its dependents, and says so', async () => {
  const seed = {
    appmodules: { [appUniqueName(desk)]: { appmoduleid: 'app-1', name: 'Support Desk' } },
    tables: ['new_customer', 'new_ticket', 'new_comment'],
    solutions: { ContosoSupportDesk: { solutionid: 'sol-1', uniquename: 'ContosoSupportDesk' } },
  };
  const base = mockSdk(seed);
  const sdk = {
    ...base,
    deleteAppCascade: async (id, unique) => {
      await base.deleteAppCascade(id, unique); // the remote delete really happened
      const err = new Error("EPERM: operation not permitted, unlink 'workspace\\apps\\app-1.json'");
      err.code = 'EPERM';
      throw err;
    },
  };
  const r = await runTeardown(desk, { apply: true }, { sdk, emit: () => {} });

  assert.strictEqual(r.ok, false, 'something did fail, and the run must say so');
  assert.ok(r.errors.some((e) => /app "Support Desk" was deleted, but the delete call then failed: EPERM/.test(e.message)), JSON.stringify(r.errors));
  assert.strictEqual(base.db.tables.size, 0, 'the app is gone, so its dependents are torn down');
  assert.ok(!r.skipped.some((s) => /not attempted/.test(s)), 'nothing may be reported as abandoned for an app that was deleted');
});

// Control for the rule above: a 404 whose app is CONFIRMED gone is a clean delete, handled (and
// verified) by deleteStep — it must not be turned into the "failed after the delete" error.
test('a 404 from an app delete whose app is confirmed gone is still a clean delete', async () => {
  const seed = {
    appmodules: { [appUniqueName(desk)]: { appmoduleid: 'app-1', name: 'Support Desk' } },
    tables: ['new_customer', 'new_ticket', 'new_comment'],
    solutions: { ContosoSupportDesk: { solutionid: 'sol-1', uniquename: 'ContosoSupportDesk' } },
  };
  const base = mockSdk(seed);
  const sdk = {
    ...base,
    deleteAppCascade: async (id, unique) => {
      await base.deleteAppCascade(id, unique);
      const err = new Error('appmodule not found');
      err.statusCode = 404;
      throw err;
    },
  };
  const r = await runTeardown(desk, { apply: true }, { sdk, emit: () => {} });
  assert.deepStrictEqual(r.errors, [], 'a confirmed-absent 404 is not a failure');
  assert.strictEqual(base.db.tables.size, 0);
  // The resolve, plus ONE confirming read by deleteStep — the handler leaves a 404 to it rather than
  // asking the platform the same question twice.
  assert.strictEqual(base.calls.filter((c) => c.method === 'resolveArtifact' && c.kind === 'app').length, 2);
});

// A 404 is not proof either. The abort added above is DOWNSTREAM of deleteStep, which treats any not-found error
// as a successful delete. But the SDK also throws 404 when an ATOMIC app+sitemap changeset is
// ROLLED BACK by the platform — the app is still there. That was recorded as a phantom delete, the
// abort never fired, and dependent teardown went on to strip a live app: `ok: true`, no errors.
//
// For the dependency ROOT, "not found" must be MEASURED, not inferred.
test('#587 a rolled-back atomic app delete is not mistaken for a successful one', async () => {
  const seed = {
    appmodules: { [appUniqueName(desk)]: { appmoduleid: 'app-1', name: 'Support Desk' } },
    tables: ['new_customer', 'new_ticket', 'new_comment'],
    solutions: { ContosoSupportDesk: { solutionid: 'sol-1', uniquename: 'ContosoSupportDesk' } },
  };
  const base = mockSdk(seed);
  const sdk = {
    ...base,
    // The app row is deliberately LEFT IN PLACE: the changeset rolled back.
    deleteAppCascade: async (id, unique) => {
      base.calls.push({ method: 'deleteAppCascade', appModuleId: id, appModuleIdUnique: unique });
      const err = new Error('The atomic delete of app and sitemap was rolled back');
      err.statusCode = 404;
      throw err;
    },
  };
  const r = await runTeardown(desk, { apply: true }, { sdk, emit: () => {} });

  assert.strictEqual(r.ok, false, 'a rolled-back delete must not report success');
  assert.deepStrictEqual(r.deleted.app || [], [], 'and must not be recorded as a deleted app');
  const destructive = base.calls.filter((c) => /^delete/.test(c.method) && c.method !== 'deleteAppCascade');
  assert.deepStrictEqual(destructive.map((c) => c.method), [],
    'the app is still live, so nothing it renders may be deleted');
  assert.strictEqual(base.db.tables.size, 3, 'its tables must survive');
});

// The CONTROL that keeps the rule honest: an app genuinely already gone (a re-run of a completed
// teardown) must still be tolerated, or every second teardown would fail.
test('#587 an app that is genuinely absent is still tolerated as already deleted', async () => {
  const base = mockSdk({
    appmodules: { [appUniqueName(desk)]: { appmoduleid: 'app-1', name: 'Support Desk' } },
    tables: ['new_customer', 'new_ticket', 'new_comment'],
    solutions: { ContosoSupportDesk: { solutionid: 'sol-1', uniquename: 'ContosoSupportDesk' } },
  });
  const sdk = {
    ...base,
    deleteAppCascade: async (id, unique) => {
      // Remove the row (it really is gone), THEN report 404 — the shape a cascade race produces.
      await base.deleteAppCascade(id, unique);
      const err = new Error('Not Found');
      err.statusCode = 404;
      throw err;
    },
  };
  const r = await runTeardown(desk, { apply: true }, { sdk, emit: () => {} });
  assert.strictEqual(r.ok, true, `a genuinely-absent app is not a failure: ${JSON.stringify(r.errors)}`);
  assert.strictEqual(base.db.tables.size, 0, 'and its dependents are still torn down');
});

// The OTHER branch of the same resolver, pinned so it is not "fixed" later without being thought
// through. A roleid that is not a GUID skips the association query entirely — deliberately:
// FORM_GUID_RE is an injection guard on the OData filter, not an existence check. Every Dataverse
// roleid is an Edm.Guid, so an id failing it never came from the platform and has no app
// association to protect.
// Making it fail closed was considered and rejected: no real row benefits, and role ownership would
// start depending on id formatting.
test('#587 a non-GUID role id still resolves — the GUID test is an injection guard, not a safety check', async () => {
  const sdk = {
    deleteSecurityRole: async () => {},
    queryRecords: async (set) => {
      if (set === 'businessunit') return [{ businessunitid: '44444444-4444-4444-4444-444444444444' }];
      if (set === 'role') return [{ roleid: 'r1', name: 'Dispatcher', description: SDK_ROLE_MARKER, ismanaged: false }];
      return [];
    },
  };
  assert.deepStrictEqual(await KIND_HANDLERS.role.resolve(sdk, { name: 'Dispatcher' }),
    [{ id: 'r1', name: 'Dispatcher' }]);
});
