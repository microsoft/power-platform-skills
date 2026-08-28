'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { commandDef, runSdkBuild, planFor, resolvePhases, compileFormIntent, formFieldLogicals, viewDef, appDef, defaultViewColumns, enrichesDefaultViews, artifactIdentityQuery, resolveExistingFormId, FORM_TYPE_CODE, dashboardTileOpts, PHASES, appUniqueName, personaRoleSpecFor } = require('../lib/sdk-build.js');
const { validateAppSpec } = require('../lib/app-spec.js');

// Real GUIDs (Imp9) for the three-authority sitemap mock. SELF_* identify THIS app's appmodule + sitemap
// so fetchSitemap(appUnique) resolves to opts.liveSitemapXml; otherApps get synthetic ids. Ids that flow
// through the GenPageId/GUID extractors in a test MUST be real 36-char GUIDs.
const APP_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const SELF_UNIQUE_VALUE = 'c0ffee00-0000-4000-8000-00000000dddd';
const SELF_SITEMAP_ID = '5111e0f2-0000-4000-8000-0000000000aa';
// A valid, page-less sitemap (passes sitemap-pages.isMalformed) — the default membership for a build that
// does not seed opts.liveSitemapXml.
const EMPTY_SITEMAP_XML = '<SiteMap><Area><Group></Group></Area></SiteMap>';

// Stage a fresh temp appDir with a minimal valid .tsx for each IMPLEMENTED page. Task 8's pages-phase
// scan READS canonical source from disk, so any pages-phase test must have real files (not a bare
// 'o.tsx' string). Optional `bodyByCodeFile` overrides a page's source (e.g. to inject navigation).
function stagePages(pages, bodyByCodeFile = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkb-pages-'));
  for (const p of pages || []) {
    const cf = (p.source && p.source.codeFile) || p.codeFile;
    if (!cf) continue;
    const f = path.join(dir, cf);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, bodyByCodeFile[cf] || 'export default function P(){ return null; }', 'utf8');
  }
  return dir;
}

test('appUniqueName prefers spec.app.uniqueName (real immutable identity) over the display-name derivation', () => {
  // A DOWNLOADED spec carries the real uniquename → used verbatim so a rebuild resolves the EXISTING app
  // even after a display-name rename (deriving from the mutable name would miss it and duplicate — Sol F1).
  assert.strictEqual(
    appUniqueName({ solution: { publisherPrefix: 'crba3' }, app: { name: 'Zava App 2', uniqueName: 'crba3_zavaapp' } }),
    'crba3_zavaapp', 'the real uniquename is used, NOT the derived crba3_zavaapp2');
  // An AUTHORED create-fresh spec has no uniqueName → derive from publisher prefix + display name (unchanged).
  assert.strictEqual(
    appUniqueName({ solution: { publisherPrefix: 'new' }, app: { name: 'Support Desk' } }),
    'new_supportdesk', 'a create-fresh spec still derives the uniquename from prefix + display name');
});

// Customer 1:N Tickets: a Choice column, sample data with $parent, a view, a Choice chart,
// and a parent form with a child sub-grid.
function makeSpec(extra = {}) {
  return Object.assign({
    solution: { uniqueName: 'ContosoSD', displayName: 'Contoso SD', publisherPrefix: 'new' },
    app: { name: 'Support Desk', description: 'Tickets' },
    entities: [
      { schemaName: 'new_customer', displayName: 'Customer', primaryAttribute: { schemaName: 'new_name', displayName: 'Name' },
        columns: [{ schemaName: 'new_tier', displayName: 'Tier', type: 'Choice', options: ['Free', 'Pro'] }] },
      { schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'new_subject', displayName: 'Subject' },
        columns: [{ schemaName: 'new_priority', displayName: 'Priority', type: 'Choice', options: ['Low', 'High'] }] },
    ],
    relationships: [{ type: 'OneToMany', referenced: 'new_customer', referencing: 'new_ticket', lookup: { schemaName: 'new_CustomerId', displayName: 'Customer' } }],
    views: [{ entity: 'new_ticket', name: 'Active Tickets', columns: ['new_subject', 'new_priority'] }],
    charts: [{ entity: 'new_ticket', name: 'By Priority', chartType: 'Pie', groupBy: 'new_priority', measure: 'count' }],
    forms: [{ entity: 'new_customer', name: 'Customer', layout: 'auto', subgrids: [{ childEntity: 'new_ticket', view: 'Active Tickets', label: 'Tickets' }] }],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Records', subAreas: [{ entity: 'new_customer', title: 'Customers' }] }] }] },
    sampleData: {
      new_customer: [{ new_name: 'Acme', new_tier: 'Pro' }],
      new_ticket: [{ new_subject: 'Down', new_priority: 'High', $parent: { entity: 'new_customer', match: { new_name: 'Acme' } } }],
    },
  }, extra);
}

// --- Minimal JsonPointer + artifact-store helpers so the mock SDK can simulate the generic
// mutation surface (addElement/updateElement/removeElement/getArtifact) the engine now uses. Ids
// are NOT minted here (the engine/tests don't assert on minted layout ids — the real bundle mints
// them; see the real-bundle tests). This keeps the mock hermetic and fast.
function jpTokens(ptr) { return ptr === '' ? [] : ptr.split('/').slice(1).map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~')); }
function jpGet(obj, ptr) { let cur = obj; for (const t of jpTokens(ptr)) { if (cur == null) return undefined; cur = cur[t]; } return cur; }
function jpSet(obj, ptr, val) { const toks = jpTokens(ptr); const last = toks.pop(); let cur = obj; for (const t of toks) cur = cur[t]; cur[last] = val; }
function jpRemove(obj, ptr) { const toks = jpTokens(ptr); const last = toks.pop(); let cur = obj; for (const t of toks) cur = cur[t]; if (Array.isArray(cur)) cur.splice(Number(last), 1); else delete cur[last]; }
const clone = (v) => JSON.parse(JSON.stringify(v));
// A form with the given bound fields laid out in one tab/column/section (NEW SDK topology). Used to
// seed both a freshly-created form's default shell and a "fetched existing" form for reconcile tests.
function seedForm(id, fields) {
  return { id, tabs: [{ id: 'seedtab', name: 'tab_general', label: 'General', expanded: true, visible: true,
    columns: [{ sections: [{ id: 'seedsec', name: 'section_general', label: 'General', visible: true, showLabel: false, columns: 1,
      rows: (fields || []).map((fn) => ({ cells: [{ control: { fieldName: fn } }] })) }] }] }],
    bag: { a: [], c: [] } };
}

// `existingTables`: { logical: { entitySetName, columns:[logical...], relationships:[schema...] } }
function mockSdk(opts = {}) {
  const calls = [];
  let idc = 0;
  const ex = opts.existingTables || {};
  const store = {}; // `${type}:${id}` -> in-memory artifact (form/view/app), mutated by the generic surface
  const sdk = {
    queryRecords: async (e, o) => {
      calls.push({ name: 'queryRecords', args: [e, o] });
      const filter = (o && o.filter) || '';
      if (e === 'solution') return opts.solutionExists ? [{ solutionid: 's' }] : [];
      if (e === 'webresource') {
        if (/_pagemanifest'/.test(filter)) return opts.pageManifest ? [{ webresourceid: opts.manifestId || 'wr-manifest', content: opts.pageManifest }] : [];
        return opts.existingWebResource ? [{ webresourceid: 'wr-existing' }] : [];
      }
      // appmodule / appmodulecomponent / sitemap answer the fetchSitemap + fetchAppsForPages reads (Imp9).
      // FILTERED appmodule (fetchSitemap for one app) echoes a resolvable row for ANY uniquename — self
      // resolves to SELF_SITEMAP_ID (→ opts.liveSitemapXml); a named otherApp resolves to its own sitemap.
      // UNFILTERED appmodule (fetchAppsForPages) lists self + otherApps; self is skipped by excludeAppUnique
      // (or, when opts.selfAppUnique is unset, by fetchAppsForPages's own falsy-uniquename guard).
      if (e === 'appmodule') {
        const m = filter.match(/uniquename eq '([^']+)'/);
        if (m) {
          const oi = (opts.otherApps || []).findIndex((a) => a.uniquename === m[1]);
          if (oi >= 0) return [{ appmoduleid: `app-${oi + 2}`, appmoduleidunique: `uv-${oi + 2}`, uniquename: m[1] }];
          return [{ appmoduleid: APP_ID, appmoduleidunique: SELF_UNIQUE_VALUE, uniquename: m[1] }];
        }
        if (opts.failAppList) throw new Error('appmodule list failed'); // shared-check fail-closed
        const rows = [{ appmoduleid: APP_ID, appmoduleidunique: SELF_UNIQUE_VALUE, uniquename: opts.selfAppUnique }];
        (opts.otherApps || []).forEach((a, i) => rows.push({ appmoduleid: `app-${i + 2}`, appmoduleidunique: `uv-${i + 2}`, uniquename: a.uniquename }));
        return rows;
      }
      if (e === 'appmodulecomponent') {
        if (opts.failSitemap) return []; // membership read failure → sitemap-component-not-found
        const uv = (filter.match(/_appmoduleidunique_value eq (\S+)/) || [])[1];
        if (uv === SELF_UNIQUE_VALUE) return [{ objectid: SELF_SITEMAP_ID, componenttype: 62 }];
        const idx = (opts.otherApps || []).findIndex((_, i) => `uv-${i + 2}` === uv);
        return [{ objectid: `sm-${idx + 2}`, componenttype: 62 }];
      }
      if (e === 'sitemap') {
        // ensureSitemapInSolution queries by sitemapnameunique → sitemapid; fetchSitemap queries by sitemapid → sitemapxml.
        if (/sitemapnameunique eq/.test(filter)) return [{ sitemapid: 'sm-1' }];
        const smId = (filter.match(/sitemapid eq (\S+)/) || [])[1];
        if (smId === SELF_SITEMAP_ID) return [{ sitemapxml: opts.liveSitemapXml || EMPTY_SITEMAP_XML }];
        const idx = Number(String(smId).replace('sm-', '')) - 2;
        return [{ sitemapxml: (opts.otherApps && opts.otherApps[idx] && opts.otherApps[idx].sitemapxml) || '<SiteMap/>' }];
      }
      // systemform queries come from THREE build paths, distinguished by their filter:
      //   1. resolveExistingFormId (id resolution): `objecttypecode … and name eq '…' and type eq <code>`
      //      → the ONE matching form (name+type is unique). Returns 'form-existing' when artifactsExist.
      //   2. resolveExistingFormId by pinned id: `formid eq <guid>` → that row (objecttypecode echoed back).
      //   3. promoteDefaultForm deactivation: `objecttypecode … and type eq 2` (NO name) → every Main form
      //      (our reconciled one + a blank stock "Information" form to deactivate).
      if (e === 'systemform') {
        if (/formid eq /.test(filter)) { const id = (filter.match(/formid eq (\S+)/) || [])[1]; return [{ formid: id, objecttypecode: opts.formIdEntity || 'new_ticket' }]; }
        if (/name eq '/.test(filter)) return opts.artifactsExist ? [{ formid: 'form-existing' }] : []; // (1) id resolution — single match
        return opts.artifactsExist ? [{ formid: 'form-existing', isdefault: true }, { formid: 'stock-info', isdefault: false }] : []; // (3) deactivation set
      }
      if (e === 'savedquery') {
        // Default-view / subgrid default lookup (filters by querytype): a default view exists.
        // Artifact idempotency (name eq filter) is now handled by findArtifact, not queryRecords.
        return [{ savedqueryid: `defview-${filter.match(/'([^']+)'/)?.[1] || 'x'}`, isdefault: true }];
      }
      // Sample-data idempotency lookup (entity-set query: [primary, <logical>id] + `<primary> eq '...'`).
      if (opts.sampleDataExists && ((o && o.select) || []).length === 2 && /id$/.test((o.select || [])[1]) && /eq '/.test(filter)) {
        const [primaryField, idField] = o.select;
        const names = [...filter.matchAll(/eq '([^']+)'/g)].map((m) => m[1]);
        return names.map((n, i) => ({ [primaryField]: n, [idField]: `${idField}-existing-${i}` }));
      }
      return opts.noPublisher ? [] : [{ publisherid: 'pub-1' }];
    },
    // Artifact idempotency: reuse existing view/chart/form/app when opts.artifactsExist is set.
    findArtifact: async (kind, identity) => {
      calls.push({ name: 'findArtifact', args: [kind, identity] });
      if (!opts.artifactsExist) return null;
      if (kind === 'view') return 'view-existing';
      if (kind === 'chart') return 'chart-existing';
      if (kind === 'form') return 'form-existing';
      if (kind === 'app') return 'app-existing';
      return null;
    },
    // Discovery seam mirrored from the vendored bundle. The teardown engine — and now the additive
    // commands/dashboards reconcile — uses resolveArtifact for the `dashboard`/`command` kinds that
    // findArtifact does NOT support. Returns [{ id, name?/entity? }]. Honors seeded existing artifacts
    // (opts.existingDashboards / opts.existingCommands) AND anything created into `store` this run, so a
    // rebuild in the same test observes the first run's artifacts — proving the reconcile never duplicates.
    resolveArtifact: async (kind, identity) => {
      calls.push({ name: 'resolveArtifact', args: [kind, identity] });
      const out = [];
      if (kind === 'dashboard') {
        for (const n of opts.existingDashboards || []) out.push({ id: `dashboard-existing-${n}`, name: n });
        for (const k of Object.keys(store)) if (k.startsWith('dashboard:') && store[k].name) out.push({ id: store[k].id, name: store[k].name });
        return identity && identity.name != null ? out.filter((o) => o.name === identity.name) : out;
      }
      if (kind === 'command') {
        for (const e of opts.existingCommands || []) out.push({ id: `command-existing-${e}`, entity: e });
        for (const k of Object.keys(store)) if (k.startsWith('command:') && store[k].entityLogicalName) out.push({ id: store[k].id, entity: store[k].entityLogicalName });
        return identity && identity.entity != null ? out.filter((o) => o.entity === identity.entity) : out;
      }
      return [];
    },
    createWebResource: async (o) => { calls.push({ name: 'createWebResource', args: [o] }); return { id: `wr-${++idc}`, name: o.name }; },
    updateWebResource: async (id, o) => { calls.push({ name: 'updateWebResource', args: [id, o] }); return {}; },
    fetchArtifact: async (t, id) => {
      calls.push({ name: 'fetchArtifact', args: [t, id] });
      // Seed the store to mimic a fetched, deployed artifact so reconcile can read + mutate it.
      if (!store[`${t}:${id}`]) {
        if (t === 'form') store[`${t}:${id}`] = seedForm(id, opts.existingFormFields || []);
        else if (t === 'view') store[`${t}:${id}`] = { id, columns: (opts.existingViewColumns || []).slice() };
        else if (t === 'app') store[`${t}:${id}`] = { id, siteMap: opts.existingSitemap ? JSON.parse(JSON.stringify(opts.existingSitemap)) : { areas: [] } };
        else store[`${t}:${id}`] = { id };
      }
      return store[`${t}:${id}`];
    },
    createPublisher: async (o) => { calls.push({ name: 'createPublisher', args: [o] }); return { id: 'pub-new' }; },
    createSolution: async (o) => { calls.push({ name: 'createSolution', args: [o] }); return { id: 'sol-1' }; },
    findTables: async (q, o) => { calls.push({ name: 'findTables', args: [q, o] }); const t = ex[String(q).toLowerCase()]; return t ? [{ logicalName: String(q).toLowerCase(), schemaName: q, displayName: q, entitySetName: t.entitySetName, isCustom: true }] : []; },
    findColumns: async (logical) => { calls.push({ name: 'findColumns', args: [logical] }); const t = ex[logical]; return ((t && t.columns) || []).map((c) => ({ logicalName: c, schemaName: c, displayName: c, attributeType: 'String', isCustom: true })); },
    fetchEntityMetadata: async (logical) => { calls.push({ name: 'fetchEntityMetadata', args: [logical] }); const t = ex[logical]; return { logicalName: logical, displayName: logical, entitySetName: (t && t.entitySetName) || `${logical}s`, attributes: ((t && t.columns) || []).map((c) => ({ logicalName: c })), relationships: ((t && t.relationships) || []).map((s) => ({ schemaName: s, type: 'OneToMany' })) }; },
    createTable: async (o) => { calls.push({ name: 'createTable', args: [o] }); if (opts.failTable === o.schemaName) throw new Error('boom'); return { logicalName: o.schemaName.toLowerCase(), entitySetName: `${o.schemaName.toLowerCase()}s`, metadataId: `tbl-${o.schemaName}` }; },
    updateTable: async (l, o) => { calls.push({ name: 'updateTable', args: [l, o] }); return {}; },
    createColumn: async (e, o) => { calls.push({ name: 'createColumn', args: [e, o] }); return { logicalName: o.schemaName.toLowerCase(), metadataId: `col-${o.schemaName}` }; },
    createRelationship: async (o) => { calls.push({ name: 'createRelationship', args: [o] }); return { schemaName: o.schemaName, metadataId: `rel-${o.schemaName}` }; },
    createGlobalOptionSet: async (o) => { calls.push({ name: 'createGlobalOptionSet', args: [o] }); return { name: o.name, metadataId: `gc-${o.name}` }; },
    createCustomerColumn: async (e, o) => { calls.push({ name: 'createCustomerColumn', args: [e, o] }); return { logicalName: o.schemaName.toLowerCase(), metadataId: `col-${o.schemaName}` }; },
    insertStatusValue: async (e, o) => { calls.push({ name: 'insertStatusValue', args: [e, o] }); if (opts.statusExists) { const err = new Error('HTTP 400: a status value with this name already exists'); err.statusCode = 400; throw err; } return 100000001; },
    createAlternateKey: async (e, o) => {
      calls.push({ name: 'createAlternateKey', args: [e, o] });
      if (opts.altKeyExists) { const err = new Error(`HTTP 400 from /Keys: An attribute or relationship with the name '${o.schemaName}' already exists`); err.statusCode = 400; throw err; }
      if (opts.altKeyError) { const err = new Error('HTTP 400 from /Keys: key attribute is not valid'); err.statusCode = 400; throw err; }
      return { logicalName: o.schemaName.toLowerCase() };
    },
    createRecordsBulk: async (e, rows) => { calls.push({ name: 'createRecordsBulk', args: [e, rows] }); return rows.map((_, i) => `${e}-${i}`); },
    seedRecordGraph: async (groups, opts) => {
      calls.push({ name: 'seedRecordGraph', args: [groups, opts] });
      const createdIds = {};
      for (const g of groups) createdIds[g.entityLogical] = g.records.map((_, i) => `${g.entityLogical}-${i}`);
      return { createdIds };
    },
    enrichDefaultViews: async (logical, cols, o2) => { calls.push({ name: 'enrichDefaultViews', args: [logical, cols, o2] }); return { updated: [`defview-${logical}`] }; },
    createArtifact: (t, def) => {
      calls.push({ name: 'createArtifact', args: [t, def] });
      const id = `${t}-${++idc}`;
      let art;
      if (t === 'form') { art = seedForm(id, []); art.name = def.name; art.entityLogicalName = def.entityLogicalName; art.formType = def.formType; art.status = def.status; }
      else if (t === 'dashboard') art = Object.assign({ id, components: [] }, def);
      else art = Object.assign({ id }, def);
      art.id = id;
      store[`${t}:${id}`] = art;
      return clone(art);
    },
    getArtifact: async (t, id) => { await Promise.resolve();
      calls.push({ name: 'getArtifact', args: [t, id] });
      return store[`${t}:${id}`] || { id };
    },
    // Generic mutation surface (mirrors the SDK). The mock does NOT mint layout ids (tests don't
    // assert on them); it just maintains a coherent in-memory tree so getArtifact/firstSectionRowsPointer
    // and reconcile see the effects of adds/removes.
    addElement: async (t, id, ptr, el) => { await Promise.resolve();
      calls.push({ name: 'addElement', args: [t, id, ptr, el] });
      const art = store[`${t}:${id}`] || (store[`${t}:${id}`] = { id });
      const arr = jpGet(art, ptr);
      if (Array.isArray(arr)) arr.push(clone(el));
      return clone(art);
    },
    updateElement: async (t, id, ptr, patch) => { await Promise.resolve();
      calls.push({ name: 'updateElement', args: [t, id, ptr, patch] });
      const art = store[`${t}:${id}`] || (store[`${t}:${id}`] = { id });
      jpSet(art, ptr, clone(patch));
      return clone(art);
    },
    removeElement: async (t, id, ptr) => { await Promise.resolve();
      calls.push({ name: 'removeElement', args: [t, id, ptr] });
      const art = store[`${t}:${id}`];
      if (art) jpRemove(art, ptr);
      return clone(art || { id });
    },
    updateRecord: async (e, id, data) => { calls.push({ name: 'updateRecord', args: [e, id, data] }); },
    pushArtifact: async (t, id) => { calls.push({ name: 'pushArtifact', args: [t, id] }); return { type: t, id, saved: true, shipped: false, publish: { kind: 'notRequested' } }; },
    addSolutionComponent: async (o) => { calls.push({ name: 'addSolutionComponent', args: [o] }); },
    publishArtifact: async (t, id) => { calls.push({ name: 'publishArtifact', args: [t, id] }); return { type: t, id, shipped: true, publish: { kind: 'verified' } }; },
    setEntityIcon: async (logical, icons) => { calls.push({ name: 'setEntityIcon', args: [logical, icons] }); return { id: logical }; },
    getAiReadiness: async (opts) => { calls.push({ name: 'getAiReadiness', args: [opts] }); return { enabled: true }; },
    setAppAiFeatures: async (appUnique, flags, opts) => { calls.push({ name: 'setAppAiFeatures', args: [appUnique, flags, opts] }); return { applied: Object.keys(flags).filter((k) => flags[k]), skipped: [] }; },
    configureRowSummary: async (promptSpec, opts) => { calls.push({ name: 'configureRowSummary', args: [promptSpec, opts] }); return { modelId: 'model-' + promptSpec.entityLogicalName, aiSkillConfigId: 'skill-' + promptSpec.entityLogicalName }; },
    // Security authoring. createPersonaRole echoes a RoleResult; opts.roleConflict simulates the SEC-1
    // fail-closed (a hand-built same-name role) so the security phase's BuildHalt is testable. opts.rolesExist
    // marks the reused path. associateRecords records the app<->role link; opts.associateDuplicate simulates a
    // re-run's duplicate-$ref rejection so ensureAppAvailableToRole's idempotent swallow is testable.
    createPersonaRole: async (spec) => {
      calls.push({ name: 'createPersonaRole', args: [spec] });
      if (opts.roleConflict) throw new Error(`A role named '${spec.persona}' already exists in this business unit and was not created by the SDK`);
      const privs = [...(spec.jobs || []).flatMap((j) => j.privileges || []), ...(spec.additionalPrivileges || [])];
      return { roleId: `role-${spec.persona}`, name: spec.persona, reused: !!opts.rolesExist, appliedPrivileges: privs.map((p) => ({ entity: p.entity, privilegeName: `prv-${p.entity}`, privilegeType: (p.access || [])[0] || 'Read', scope: p.scope || 'user' })), assignedTeams: (spec.assignTo && spec.assignTo.teams) || [], assignedUsers: (spec.assignTo && spec.assignTo.users) || [] };
    },
    associateRecords: async (e, id, o) => { calls.push({ name: 'associateRecords', args: [e, id, o] }); if (opts.associateDuplicate) { const err = new Error('HTTP 400 from /appmodules(x)/appmoduleroles_association/$ref: A record with matching key values already exists.'); err.statusCode = 400; err.cause = { error: { code: '0x80060891', message: 'duplicate' } }; throw err; } if (opts.associateFail) { const err = new Error('HTTP 400 from ...: bad request'); err.statusCode = 400; err.cause = { error: { code: '0x80040203', message: 'invalid argument' } }; throw err; } },
    disassociateRecords: async (e, id, rel, targetId) => { calls.push({ name: 'disassociateRecords', args: [e, id, rel, targetId] }); if (opts.dissociateGone) { const err = new Error('HTTP 404 from ...: does not exist'); err.statusCode = 404; throw err; } },
    deleteSecurityRole: async (id) => { calls.push({ name: 'deleteSecurityRole', args: [id] }); },
  };
  return { sdk, calls };
}
const find = (calls, name) => calls.filter((c) => c.name === name);
const has = (calls, name) => calls.some((c) => c.name === name);
// Flatten cells from an addElement 4th-arg value, which is either { cells:[...] } (a field/quick-view
// row add) or a whole section { rows:[{cells:[...]}] } (a #5 sub-grid section). Sub-grid extractions
// use this so they find the control regardless of whether it was added as a bare cell or a section.
const cellsFromAdd = (v) => {
  if (!v) return [];
  if (Array.isArray(v.cells)) return v.cells;
  if (Array.isArray(v.rows)) return v.rows.flatMap((r) => r.cells || []);
  return [];
};

test('dry-run emits a plan and writes nothing', async () => {
  const { sdk, calls } = mockSdk();
  const events = [];
  const r = await runSdkBuild(makeSpec(), { sdk, apply: false, sampleData: true, publish: true, emit: (e) => events.push(e) });
  assert.strictEqual(r.dryRun, true);
  assert.strictEqual(calls.length, 0);
  assert.ok(r.plan.some((l) => l.includes('solution ContosoSD')));
  assert.ok(events.every((e) => e.status === 'skip'));
});

test('fresh build runs phases in order and creates everything', async () => {
  const { sdk, calls } = mockSdk();
  const events = [];
  await runSdkBuild(makeSpec(), { sdk, apply: true, sampleData: true, publish: true, emit: (e) => events.push(e) });
  // phase order: first appearance of each phase follows PHASES order
  const firstIdx = {};
  events.forEach((e, i) => { if (firstIdx[e.phase] === undefined) firstIdx[e.phase] = i; });
  const seen = PHASES.filter((p) => firstIdx[p] !== undefined);
  const sortedByAppearance = seen.slice().sort((a, b) => firstIdx[a] - firstIdx[b]);
  assert.deepStrictEqual(seen, sortedByAppearance, 'phases appear in canonical order');
  // key writes present
  assert.ok(has(calls, 'createSolution'));
  assert.strictEqual(find(calls, 'createTable').length, 2);
  assert.strictEqual(find(calls, 'createRelationship').length, 1);
  assert.strictEqual(find(calls, 'seedRecordGraph').length, 2);
  assert.ok(find(calls, 'createArtifact').length >= 4); // 1 view + 1 chart + 1 form + 1 app
});

test('Choice column passes value/label option pairs', async () => {
  const { sdk, calls } = mockSdk();
  await runSdkBuild(makeSpec(), { sdk, apply: true });
  const tier = find(calls, 'createColumn').find((c) => c.args[1].schemaName === 'new_tier');
  assert.strictEqual(tier.args[1].type, 'choice');
  assert.deepStrictEqual(tier.args[1].options, [{ value: 100000000, label: 'Free' }, { value: 100000001, label: 'Pro' }]);
});

test('relationship schema name differs from the lookup column name', async () => {
  const { sdk, calls } = mockSdk();
  await runSdkBuild(makeSpec(), { sdk, apply: true });
  const rel = find(calls, 'createRelationship')[0].args[0];
  assert.strictEqual(rel.referencedEntity, 'new_customer');
  assert.strictEqual(rel.referencingEntity, 'new_ticket');
  assert.strictEqual(rel.lookupSchemaName, 'new_CustomerId');
  assert.strictEqual(rel.schemaName, 'new_customer_new_ticket');
});

test('sample data translates $parent into a lookup bind (entity-set resolved via the SDK)', async () => {
  const { sdk, calls } = mockSdk();
  await runSdkBuild(makeSpec(), { sdk, apply: true, sampleData: true });
  const call = find(calls, 'seedRecordGraph').find((c) => c.args[0][0].entityLogical === 'new_ticket');
  const rec = call.args[0][0].records[0];
  assert.deepStrictEqual(rec.binds, [{ navProperty: 'new_CustomerId', parentEntity: 'new_customer', parentIndex: 0 }]);
  assert.strictEqual(rec.body['new_CustomerId@odata.bind'], undefined, 'the bind URL is formed by the SDK, not baked into the body');
  assert.strictEqual(rec.body.$parent, undefined);
  assert.strictEqual(rec.body.new_priority, 100000001);
  assert.strictEqual(await call.args[1].entitySetFor('new_customer'), 'new_customers');
});

test('form sub-grid references the child view id and relationship name', async () => {
  const { sdk, calls } = mockSdk();
  await runSdkBuild(makeSpec(), { sdk, apply: true });
  // Sub-grid is now a control cell added via addElement (generic SDK surface)
  const SUBGRID_CLS = 'E7A81278-8635-4D9E-8D4D-59480B391C5B';
  const normCls = (c) => String(c || '').replace(/[{}]/g, '').toUpperCase();
  const subCtrls = find(calls, 'addElement')
    .flatMap((c) => cellsFromAdd(c.args[3]))
    .map((cell) => cell.control)
    .filter((ctrl) => ctrl && normCls(ctrl.classId) === SUBGRID_CLS);
  const sub = subCtrls.find((ctrl) => ctrl.parameters.TargetEntityType === 'new_ticket');
  assert.ok(sub, 'sub-grid control found');
  assert.strictEqual(sub.parameters.TargetEntityType, 'new_ticket');
  assert.strictEqual(sub.parameters.RelationshipName, 'new_customer_new_ticket');
  assert.strictEqual(sub.parameters.ViewId, 'view-1');
});

test('idempotent: an existing table is reused — no createTable, and only missing columns added', async () => {
  const { sdk, calls } = mockSdk({ existingTables: { new_customer: { entitySetName: 'new_customers', columns: ['new_name', 'new_tier'], relationships: [] } } });
  await runSdkBuild(makeSpec(), { sdk, apply: true });
  const tablesCreated = find(calls, 'createTable').map((c) => c.args[0].schemaName);
  assert.ok(!tablesCreated.includes('new_customer'), 'existing table not re-created');
  assert.ok(tablesCreated.includes('new_ticket'), 'missing table still created');
  // new_customer's columns already exist -> no createColumn for new_tier
  assert.ok(!find(calls, 'createColumn').some((c) => c.args[0] === 'new_customer'), 'existing columns not re-added');
});

test('idempotent: an existing relationship is skipped', async () => {
  const { sdk, calls } = mockSdk({ existingTables: { new_customer: { entitySetName: 'new_customers', columns: [], relationships: ['new_customer_new_ticket'] } } });
  await runSdkBuild(makeSpec(), { sdk, apply: true });
  assert.strictEqual(find(calls, 'createRelationship').length, 0, 'existing relationship not re-created');
});

test('existing-table entity-set name comes from findTables (sample-data binding works)', async () => {
  const { sdk, calls } = mockSdk({ existingTables: { new_customer: { entitySetName: 'new_customerset', columns: ['new_name', 'new_tier'], relationships: [] } } });
  await runSdkBuild(makeSpec(), { sdk, apply: true, sampleData: true });
  const call = find(calls, 'seedRecordGraph').find((c) => c.args[0][0].entityLogical === 'new_ticket');
  assert.strictEqual(await call.args[1].entitySetFor('new_customer'), 'new_customerset', 'existing-table entity-set resolved for the SDK bind');
});

test('artifacts added to the solution by component type (view 26 / chart 59 / form 60 / generated app-icon WR 61 / sitemap 62 / app 80)', async () => {
  const { sdk, calls } = mockSdk();
  await runSdkBuild(makeSpec(), { sdk, apply: true });
  const types = find(calls, 'addSolutionComponent').map((c) => c.args[0].componentType).sort((a, b) => a - b);
  // 61 = the generated default app-icon web resource; 62 = the app's sitemap (added explicitly so
  // export from the app's own solution is complete).
  assert.deepStrictEqual(types, [26, 59, 60, 61, 62, 80]);
});

test('app icon: a default SVG icon is generated in-solution and set as the app tile icon', async () => {
  const { sdk, calls } = mockSdk();
  await runSdkBuild(makeSpec(), { sdk, apply: true, phases: ['solution', 'data-model', 'web-resources', 'app-shell'] });
  // The generated icon web resource is created (name <appUniqueName>_icon, type svg) ...
  const wr = find(calls, 'createWebResource').find((c) => /_icon$/.test(c.args[0].name));
  assert.ok(wr, 'a default app-icon web resource is created');
  assert.strictEqual(wr.args[0].type, 'svg');
  // ... and the app is created carrying that icon's id as iconWebResourceId.
  const appCreate = find(calls, 'createArtifact').find((c) => c.args[0] === 'app');
  assert.ok(appCreate.args[1].iconWebResourceId, 'app def carries an iconWebResourceId');
});

test('app icon: an explicit spec.app.icon (declared web resource) is used instead of generating one', async () => {
  const spec = makeSpec({
    app: { name: 'Support Desk', description: 'Tickets', icon: 'new_appicon' },
    webResources: [{ name: 'new_appicon', type: 'png', contentBase64: 'AAAA' }],
  });
  const { sdk, calls } = mockSdk();
  await runSdkBuild(spec, { sdk, apply: true, phases: ['solution', 'data-model', 'web-resources', 'app-shell'] });
  // No generated <appUniqueName>_icon web resource is created (the author's icon is reused).
  assert.ok(!find(calls, 'createWebResource').some((c) => /_icon$/.test(c.args[0].name)), 'no generated icon when app.icon is set');
  const appCreate = find(calls, 'createArtifact').find((c) => c.args[0] === 'app');
  assert.ok(appCreate.args[1].iconWebResourceId, 'app def carries the explicit icon id');
});

test('sitemap: the app sitemap is added to the solution (componenttype 62)', async () => {
  const { sdk, calls } = mockSdk();
  await runSdkBuild(makeSpec(), { sdk, apply: true, phases: ['solution', 'data-model', 'app-shell'] });
  assert.ok(find(calls, 'addSolutionComponent').some((c) => c.args[0].componentType === 62 && c.args[0].componentId === 'sm-1'), 'sitemap added to solution as component 62');
});

test('sitemap: an existing (edit) app also gets its sitemap added to the solution', async () => {
  const { sdk, calls } = mockSdk({ artifactsExist: true }); // findArtifact('app') -> existing
  await runSdkBuild(makeSpec(), { sdk, apply: true, phases: ['solution', 'data-model', 'app-shell'] });
  assert.ok(!find(calls, 'createArtifact').some((c) => c.args[0] === 'app'), 'no duplicate app created on the edit path');
  assert.ok(find(calls, 'addSolutionComponent').some((c) => c.args[0].componentType === 62 && c.args[0].componentId === 'sm-1'), 'sitemap added to solution on the edit path too');
});

test('Tier 1 data model: global choices, rich column types, customer, status, alt keys, N:N', async () => {
  const spec = makeSpec();
  spec.globalChoices = [{ name: 'new_severity', displayName: 'Severity', options: ['Low', 'High'] }];
  spec.entities[0].columns.push(
    { schemaName: 'new_ref', displayName: 'Ref', type: 'AutoNumber', autoNumberFormat: 'C-{SEQNUM:5}' },
    { schemaName: 'new_sev', displayName: 'Severity', type: 'Choice', globalChoice: 'new_severity' },
    { schemaName: 'new_owner', displayName: 'Owner', type: 'Customer' },
    { schemaName: 'new_photo', displayName: 'Photo', type: 'Image', maxSizeKb: 5120 },
    { schemaName: 'new_score', displayName: 'Score', type: 'Decimal', minValue: 0, maxValue: 100, precision: 2 }
  );
  spec.entities[0].statusReasons = [{ label: 'In Review', state: 'Active' }];
  spec.entities[0].alternateKeys = [{ schemaName: 'new_namekey', displayName: 'Name Key', columns: ['new_name'] }];
  spec.relationships.push({ type: 'ManyToMany', entity1: 'new_customer', entity2: 'new_ticket' });
  const { sdk, calls } = mockSdk();
  await runSdkBuild(spec, { sdk, apply: true });

  assert.strictEqual(find(calls, 'createGlobalOptionSet')[0].args[0].name, 'new_severity');
  const col = (n) => find(calls, 'createColumn').find((c) => c.args[1].schemaName === n).args[1];
  assert.strictEqual(col('new_sev').globalChoiceMetadataId, 'gc-new_severity', 'choice binds the global set');
  assert.strictEqual(col('new_ref').autoNumberFormat, 'C-{SEQNUM:5}');
  assert.strictEqual(col('new_photo').maxSizeKb, 5120);
  assert.deepStrictEqual([col('new_score').minValue, col('new_score').maxValue, col('new_score').precision], [0, 100, 2]);
  assert.strictEqual(find(calls, 'createCustomerColumn')[0].args[1].schemaName, 'new_owner', 'customer via createCustomerColumn');
  assert.strictEqual(find(calls, 'insertStatusValue')[0].args[1].label, 'In Review');
  assert.strictEqual(find(calls, 'createAlternateKey')[0].args[1].schemaName, 'new_namekey');
  const nn = find(calls, 'createRelationship').find((c) => c.args[0].type === 'ManyToMany');
  assert.strictEqual(nn.args[0].entity1, 'new_customer');
  assert.strictEqual(nn.args[0].entity2, 'new_ticket');
});

// --- Tier 2: UI + logic (web resources + form event handlers) --------------------------
function specWithFormJs() {
  const spec = makeSpec();
  spec.webResources = [
    { name: 'new_ticket.js', displayName: 'Ticket Scripts', type: 'js', content: 'var Ticket={onLoad:function(){},onPriority:function(){}};' },
  ];
  // wire handlers onto the customer form (makeSpec's only form)
  spec.forms[0].events = [
    { event: 'onload', library: 'new_ticket.js', function: 'Ticket.onLoad' },
    { event: 'onchange', attribute: 'new_tier', library: 'new_ticket.js', function: 'Ticket.onPriority', enabled: true },
  ];
  return spec;
}

test('Tier 2: web resource is created, added to the solution (type 61), and its id captured', async () => {
  const { sdk, calls } = mockSdk();
  await runSdkBuild(specWithFormJs(), { sdk, apply: true });
  const wr = find(calls, 'createWebResource')[0].args[0];
  assert.strictEqual(wr.name, 'new_ticket.js');
  assert.strictEqual(wr.type, 'js');
  assert.ok(wr.content.includes('onLoad'));
  const comps = find(calls, 'addSolutionComponent').map((c) => c.args[0].componentType);
  assert.ok(comps.includes(61), 'web resource added to solution as component type 61');
});

test('Tier 2: idempotent — an existing web resource is reused (no createWebResource)', async () => {
  const { sdk, calls } = mockSdk({ existingWebResource: true });
  const events = [];
  await runSdkBuild(specWithFormJs(), { sdk, apply: true, emit: (e) => events.push(e) });
  assert.strictEqual(find(calls, 'createWebResource').length, 0, 'existing web resource not re-created');
  assert.ok(events.some((e) => e.status === 'skip' && /web resource new_ticket\.js \(exists/.test(e.label)));
});

test('table icon: an entity vectorIcon/icon sets the table icon via setEntityIcon after web resources', async () => {
  const spec = makeSpec({
    webResources: [
      { name: 'new_widgeticon', type: 'svg', content: '<svg/>' },
      { name: 'new_widgeticon_png', type: 'png', contentBase64: 'AAAA' },
    ],
    entities: [
      { schemaName: 'new_widget', displayName: 'Widget', primaryAttribute: { schemaName: 'new_name', displayName: 'Name' },
        vectorIcon: 'new_widgeticon', icon: 'new_widgeticon_png' },
    ],
    relationships: [], views: [], charts: [], forms: [], sampleData: {},
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Records', subAreas: [{ entity: 'new_widget', title: 'Widgets' }] }] }] },
  });
  const { sdk, calls } = mockSdk();
  await runSdkBuild(spec, { sdk, apply: true, phases: ['solution', 'data-model', 'web-resources'] });
  const icon = find(calls, 'setEntityIcon');
  assert.strictEqual(icon.length, 1, 'setEntityIcon called once');
  assert.strictEqual(icon[0].args[0], 'new_widget');
  assert.strictEqual(icon[0].args[1].vector, 'new_widgeticon');
  assert.strictEqual(icon[0].args[1].medium, 'new_widgeticon_png');
  // Ordering: the web resource must be created BEFORE the table icon points at it.
  const wrIdx = calls.findIndex((c) => c.name === 'createWebResource');
  const iconIdx = calls.findIndex((c) => c.name === 'setEntityIcon');
  assert.ok(wrIdx >= 0 && wrIdx < iconIdx, 'web resource created before setEntityIcon');
});

test('table icon: skipped (not failed) when the table is not built this run', async () => {
  const spec = makeSpec({
    webResources: [{ name: 'new_widgeticon', type: 'svg', content: '<svg/>' }],
    entities: [{ schemaName: 'new_widget', displayName: 'Widget', primaryAttribute: { schemaName: 'new_name', displayName: 'Name' }, vectorIcon: 'new_widgeticon' }],
    relationships: [], views: [], charts: [], forms: [], sampleData: {},
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Records', subAreas: [{ entity: 'new_widget', title: 'Widgets' }] }] }] },
  });
  const { sdk, calls } = mockSdk();
  const events = [];
  // Only run web-resources (no data-model) — the table isn't built this run.
  await runSdkBuild(spec, { sdk, apply: true, phases: ['solution', 'web-resources'], emit: (e) => events.push(e) });
  assert.strictEqual(find(calls, 'setEntityIcon').length, 0, 'setEntityIcon not called');
  assert.ok(events.some((e) => e.status === 'skip' && /table icon for new_widget \(table not built/.test(e.label)), 'icon step skipped with a clear reason');
});

test('Tier 2: form events are wired (fetch -> addFormEventHandler -> push -> publish) with mapped opts', async () => {
  const { sdk, calls } = mockSdk();
  await runSdkBuild(specWithFormJs(), { sdk, apply: true });
  const formId = find(calls, 'createArtifact').find((c) => c.args[0] === 'form').args; // ['form', def]
  assert.ok(has(calls, 'fetchArtifact'), 'form fetched before wiring handlers');
  // Form events are now wired by adding an <events> region to /bag/c (generic SDK surface)
  const attrOf = (node, key) => ((node.a || []).find((a) => a[0] === key) || [])[1];
  const evRegionCall = find(calls, 'addElement').find((c) =>
    c.args[0] === 'form' && c.args[2] === '/bag/c' && c.args[3] && c.args[3].node && c.args[3].node.n === 'events'
  );
  assert.ok(evRegionCall, 'events region added to /bag/c');
  const evNodes = evRegionCall.args[3].node.c;
  assert.strictEqual(evNodes.length, 2, '2 event nodes');
  const onloadNode = evNodes.find((e) => attrOf(e, 'name') === 'onload');
  const onchangeNode = evNodes.find((e) => attrOf(e, 'name') === 'onchange');
  assert.ok(onloadNode, 'onload event node found');
  assert.strictEqual(attrOf(onloadNode.c[0].c[0], 'libraryName'), 'new_ticket.js');
  assert.strictEqual(attrOf(onloadNode.c[0].c[0], 'functionName'), 'Ticket.onLoad');
  assert.strictEqual(attrOf(onloadNode.c[0].c[0], 'passExecutionContext'), 'true');
  assert.ok(onchangeNode, 'onchange event node found');
  assert.strictEqual(attrOf(onchangeNode, 'attribute'), 'new_tier', 'onchange attribute lower-cased');
  // a form with events publishes itself after the re-push
  assert.ok(find(calls, 'publishArtifact').some((c) => c.args[0] === 'form'), 'form published after wiring');
  assert.ok(formId, 'form artifact created');
});

test('Tier 2: planFor and totals account for web resources and event wiring', async () => {
  const labels = planFor(specWithFormJs(), { phases: PHASES }).map((p) => p.label);
  assert.ok(labels.some((l) => /web resource new_ticket\.js/.test(l)));
  assert.ok(labels.some((l) => /wire 2 event handler\(s\) on new_customer/.test(l)));
  // web-resources phase only runs when selected
  const onlyWr = planFor(specWithFormJs(), { phases: ['web-resources'] }).map((p) => p.phase);
  assert.ok(onlyWr.length && onlyWr.every((p) => p === 'web-resources'));
});

// --- Tier 2.x: SDK fix uptake (AutoNumber primary, N:N sub-grids) + folded build steps ----
test('AutoNumber primary column flows to createTable.primaryColumnAutoNumberFormat', async () => {
  const spec = makeSpec();
  spec.entities[1].primaryAttribute.autoNumberFormat = 'WO-{SEQNUM:5}';
  const { sdk, calls } = mockSdk();
  await runSdkBuild(spec, { sdk, apply: true });
  const ct = find(calls, 'createTable').find((c) => c.args[0].schemaName === 'new_ticket');
  assert.strictEqual(ct.args[0].primaryColumnAutoNumberFormat, 'WO-{SEQNUM:5}');
  // a table without the format doesn't carry the option
  const other = find(calls, 'createTable').find((c) => c.args[0].schemaName === 'new_customer');
  assert.strictEqual(other.args[0].primaryColumnAutoNumberFormat, undefined);
});

test('formDef forces single-column sections for a field-heavy QuickCreate form', () => {
  const spec = makeSpec();
  const cust = spec.entities.find((e) => e.schemaName === 'new_customer');
  cust.columns = Array.from({ length: 8 }, (_, i) => ({ schemaName: `new_c${i}`, displayName: `C${i}`, type: 'Text' }));
  const main = compileFormIntent(spec, { entity: 'new_customer', name: 'M', formType: 'Main', layout: 'auto' });
  const qc = compileFormIntent(spec, { entity: 'new_customer', name: 'QC', formType: 'QuickCreate', layout: 'auto' });
  // New topology: tab → columns[0] → sections[0]
  assert.strictEqual(main.tabs[0].columns[0].sections[0].columns, 2, 'Main form is 2-column when field-heavy (>6 fields)');
  assert.strictEqual(qc.tabs[0].columns[0].sections[0].columns, 1, 'QuickCreate form is forced to a single column');
});

test('formDef clamps an explicitly authored multi-column section to 1 for QuickCreate', () => {
  const spec = makeSpec();
  const qc = compileFormIntent(spec, { entity: 'new_customer', name: 'QC', formType: 'QuickCreate',
    tabs: [{ label: 'G', sections: [{ label: 'S', columns: 3, fields: ['new_name', 'new_tier'] }] }] });
  // New topology: tab → columns[0] → sections[0]
  assert.strictEqual(qc.tabs[0].columns[0].sections[0].columns, 1, 'authored 3-column section clamped to 1 on a QuickCreate form');
});

// --- Gap 3: auto-derive 1:N parent lookups into forms + default views ------------------------
// Walk the new topology (tab → columns[] → sections[]) to extract bound field names.
function autoFormFields(def) {
  return def.tabs.flatMap((t) => (t.columns || []).flatMap((col) =>
    col.sections.flatMap((s) => s.rows.flatMap((r) => r.cells.map((c) => c.control && c.control.fieldName).filter(Boolean)))));
}
const lookupSpec = () => ({
  solution: { uniqueName: 'S', publisherPrefix: 'new' },
  app: { name: 'A' },
  entities: [
    { schemaName: 'new_project', primaryAttribute: { schemaName: 'new_name', displayName: 'Name' }, columns: [] },
    { schemaName: 'new_task', primaryAttribute: { schemaName: 'new_name', displayName: 'Title' }, columns: [{ schemaName: 'new_priority', displayName: 'Priority', type: 'Text' }] },
  ],
  relationships: [
    { type: 'OneToMany', referenced: 'new_project', referencing: 'new_task', lookup: { schemaName: 'new_ProjectId', displayName: 'Project' } },
  ],
});

test('formDef auto-layout places the 1:N parent lookup on the child form (lookups come from relationships[], not columns[])', () => {
  const def = compileFormIntent(lookupSpec(), { entity: 'new_task', name: 'Task', layout: 'auto' });
  assert.ok(autoFormFields(def).includes('new_projectid'), 'parent lookup new_projectid is auto-placed on the child form');
});

test('formDef auto-layout does NOT add a lookup on the parent side (parent has no lookup column)', () => {
  const def = compileFormIntent(lookupSpec(), { entity: 'new_project', name: 'Project', layout: 'auto' });
  assert.ok(!autoFormFields(def).includes('new_projectid'), 'the parent form has no child lookup');
});

test('defaultViewColumns includes the 1:N parent lookup (Gap 6); includeLookups:false gives the teardown reset set', () => {
  const spec = lookupSpec();
  const task = spec.entities.find((e) => e.schemaName === 'new_task');
  const cols = defaultViewColumns(spec, task).map((c) => c.name);
  assert.ok(cols.includes('new_projectid'), 'the parent lookup is surfaced on the built-in default views');
  assert.ok(cols.includes('new_priority'), 'scalar columns are still included');
  const scalar = defaultViewColumns(spec, task, { includeLookups: false }).map((c) => c.name);
  assert.ok(!scalar.includes('new_projectid'), 'includeLookups:false drops the lookup (what teardown resets the default views to)');
});

test('#2 defaultViewColumns never truncates a parent lookup even when scalars would fill the cap', () => {
  // A lookup-heavy table: 8 scalar columns + 1 parent lookup. Before #2, scalars filled the 6-extra cap
  // and the parent lookup was dropped. Now the lookup is guaranteed to land (scalars yield a slot).
  const spec = {
    solution: { uniqueName: 'S', publisherPrefix: 'new' },
    entities: [
      { schemaName: 'new_project', primaryAttribute: { schemaName: 'new_name' }, columns: [] },
      { schemaName: 'new_task', primaryAttribute: { schemaName: 'new_name' }, columns: [
        { schemaName: 'new_a', type: 'Text' }, { schemaName: 'new_b', type: 'Text' },
        { schemaName: 'new_c', type: 'Text' }, { schemaName: 'new_d', type: 'Text' },
        { schemaName: 'new_e', type: 'Text' }, { schemaName: 'new_f', type: 'Text' },
        { schemaName: 'new_g', type: 'Text' }, { schemaName: 'new_h', type: 'Text' },
      ] },
    ],
    relationships: [
      { type: 'OneToMany', referenced: 'new_project', referencing: 'new_task', lookup: { schemaName: 'new_ProjectId' } },
    ],
  };
  const task = spec.entities.find((e) => e.schemaName === 'new_task');
  const cols = defaultViewColumns(spec, task).map((c) => c.name);
  assert.ok(cols.includes('new_projectid'), 'the parent lookup is included despite 8 scalar columns');
  // still bounded (primary + up to DEFAULT_VIEW_MAX_EXTRA), and the lookup occupies one of the extra slots.
  assert.ok(cols.length <= 7, `stays within the cap (got ${cols.length})`);
  assert.strictEqual(cols[0], 'new_name', 'primary first');
});

test('an N:N sub-grid uses the ManyToMany relationship schema name', async () => {
  const spec = makeSpec();
  spec.entities.push({ schemaName: 'new_tag', displayName: 'Tag', primaryAttribute: { schemaName: 'new_label', displayName: 'Label' }, columns: [] });
  spec.relationships.push({ type: 'ManyToMany', entity1: 'new_customer', entity2: 'new_tag' });
  spec.views.push({ entity: 'new_tag', name: 'All Tags', columns: ['new_label'] });
  spec.forms[0].subgrids.push({ childEntity: 'new_tag', view: 'All Tags', label: 'Tags' });
  const { sdk, calls } = mockSdk();
  await runSdkBuild(spec, { sdk, apply: true });
  // Sub-grid is now a control cell added via addElement (generic SDK surface)
  const SUBGRID_CLS28 = 'E7A81278-8635-4D9E-8D4D-59480B391C5B';
  const normCls28 = (c) => String(c || '').replace(/[{}]/g, '').toUpperCase();
  const subCtrls28 = find(calls, 'addElement')
    .flatMap((c) => cellsFromAdd(c.args[3]))
    .map((cell) => cell.control)
    .filter((ctrl) => ctrl && normCls28(ctrl.classId) === SUBGRID_CLS28);
  const sub = subCtrls28.find((ctrl) => ctrl.parameters.TargetEntityType === 'new_tag');
  assert.ok(sub, 'N:N sub-grid is placed on the form');
  assert.strictEqual(sub.parameters.RelationshipName, 'new_customer_new_tag');
});

test('a sub-grid with no explicit or built view falls back to the child default public view', async () => {
  const spec = makeSpec();
  // A child entity with NO custom view (common for a plain N:N target).
  spec.entities.push({ schemaName: 'new_tag', displayName: 'Tag', primaryAttribute: { schemaName: 'new_label', displayName: 'Label' }, columns: [] });
  spec.relationships.push({ type: 'ManyToMany', entity1: 'new_customer', entity2: 'new_tag' });
  spec.forms[0].subgrids.push({ childEntity: 'new_tag', label: 'Tags' }); // no `view`
  const { sdk, calls } = mockSdk();
  await runSdkBuild(spec, { sdk, apply: true });
  // Sub-grid is now a control cell added via addElement (generic SDK surface)
  const SUBGRID_CLS29 = 'E7A81278-8635-4D9E-8D4D-59480B391C5B';
  const normCls29 = (c) => String(c || '').replace(/[{}]/g, '').toUpperCase();
  const subCtrls29 = find(calls, 'addElement')
    .flatMap((c) => cellsFromAdd(c.args[3]))
    .map((cell) => cell.control)
    .filter((ctrl) => ctrl && normCls29(ctrl.classId) === SUBGRID_CLS29);
  const sub = subCtrls29.find((ctrl) => ctrl.parameters.TargetEntityType === 'new_tag');
  assert.ok(sub, 'sub-grid still placed (not skipped)');
  assert.ok(sub.parameters.ViewId, 'a view id was resolved from the default public view');
  assert.ok(has(calls, 'queryRecords'), 'the child default view was looked up');
});

test('a sub-grid whose child has no resolvable view at all is skipped, not fatal', async () => {
  const spec = makeSpec();
  spec.entities.push({ schemaName: 'new_tag', displayName: 'Tag', primaryAttribute: { schemaName: 'new_label', displayName: 'Label' }, columns: [] });
  spec.relationships.push({ type: 'ManyToMany', entity1: 'new_customer', entity2: 'new_tag' });
  spec.forms[0].subgrids.push({ childEntity: 'new_tag', label: 'Tags' });
  const { sdk, calls } = mockSdk();
  sdk.queryRecords = async () => []; // no default view exists
  const events = [];
  await runSdkBuild(spec, { sdk, apply: true, emit: (e) => events.push(e) });
  const sub = find(calls, 'addSubGrid').map((c) => c.args[1]).find((s) => s.targetEntity === 'new_tag');
  assert.strictEqual(sub, undefined, 'unresolvable sub-grid is dropped');
  assert.ok(events.some((e) => e.status === 'skip' && /sub-grid Tags/.test(e.label)), 'a skip was emitted for it');
});

test('#5 a sub-grid is placed in its OWN full-width (1-column) section, titled with the child display name', async () => {
  const spec = makeSpec();
  spec.entities.find((e) => e.schemaName === 'new_ticket').pluralName = 'Tickets';
  spec.forms[0].subgrids = [{ childEntity: 'new_ticket', view: 'Active Tickets' }]; // no explicit label
  const { sdk, calls } = mockSdk();
  await runSdkBuild(spec, { sdk, apply: true });
  const SUBGRID = 'E7A81278-8635-4D9E-8D4D-59480B391C5B';
  const norm = (c) => String(c || '').replace(/[{}]/g, '').toUpperCase();
  // The sub-grid is added as a whole SECTION appended to a column's /sections array (not a cell
  // spliced into an existing field section's rows).
  const gridSection = find(calls, 'addElement')
    .filter((c) => /\/sections$/.test(c.args[2]))
    .map((c) => c.args[3])
    .find((sec) => sec && (sec.rows || []).some((r) => (r.cells || []).some((cell) => cell.control && norm(cell.control.classId) === SUBGRID)));
  assert.ok(gridSection, 'sub-grid is placed in its own section (appended to /sections)');
  assert.strictEqual(gridSection.columns, 1, 'the sub-grid section is full-width (1 column)');
  const ctrl = gridSection.rows[0].cells[0].control;
  assert.strictEqual(ctrl.parameters.TargetEntityType, 'new_ticket');
  assert.strictEqual(gridSection.label, 'Tickets', 'section title is the child plural display name, not the logical name');
  assert.strictEqual(ctrl.label, 'Tickets', 'control label is the display name too');
});

test('#5 subgrid label falls back to displayName when no pluralName, and an explicit label still wins', async () => {
  const SUBGRID = 'E7A81278-8635-4D9E-8D4D-59480B391C5B';
  const norm = (c) => String(c || '').replace(/[{}]/g, '').toUpperCase();
  const gridSectionFor = (calls) => find(calls, 'addElement')
    .filter((c) => /\/sections$/.test(c.args[2]))
    .map((c) => c.args[3])
    .find((sec) => sec && (sec.rows || []).some((r) => (r.cells || []).some((cell) => cell.control && norm(cell.control.classId) === SUBGRID)));

  // No pluralName -> singular displayName ('Ticket').
  const s1 = makeSpec();
  s1.forms[0].subgrids = [{ childEntity: 'new_ticket', view: 'Active Tickets' }];
  const m1 = mockSdk();
  await runSdkBuild(s1, { sdk: m1.sdk, apply: true });
  assert.strictEqual(gridSectionFor(m1.calls).label, 'Ticket', 'falls back to the singular display name');

  // Explicit label overrides everything.
  const s2 = makeSpec();
  s2.entities.find((e) => e.schemaName === 'new_ticket').pluralName = 'Tickets';
  s2.forms[0].subgrids = [{ childEntity: 'new_ticket', view: 'Active Tickets', label: 'Open Work' }];
  const m2 = mockSdk();
  await runSdkBuild(s2, { sdk: m2.sdk, apply: true });
  assert.strictEqual(gridSectionFor(m2.calls).label, 'Open Work', 'explicit label wins');
});

test('Gap 7: forms[].autoSubgrids adds a sub-grid for each child relationship not already declared', async () => {
  const spec = makeSpec();
  const custForm = spec.forms.find((f) => f.entity === 'new_customer');
  custForm.autoSubgrids = true;
  custForm.subgrids = []; // no explicit sub-grids — the auto pass supplies them
  const { sdk, calls } = mockSdk();
  await runSdkBuild(spec, { sdk, apply: true });
  // Sub-grid is now a control cell added via addElement (generic SDK surface)
  const SUBGRID_CLS31 = 'E7A81278-8635-4D9E-8D4D-59480B391C5B';
  const normCls31 = (c) => String(c || '').replace(/[{}]/g, '').toUpperCase();
  const subCtrls31 = find(calls, 'addElement')
    .flatMap((c) => cellsFromAdd(c.args[3]))
    .map((cell) => cell.control)
    .filter((ctrl) => ctrl && normCls31(ctrl.classId) === SUBGRID_CLS31);
  const sub = subCtrls31.find((ctrl) => ctrl.parameters.TargetEntityType === 'new_ticket');
  assert.ok(sub, 'a sub-grid for the child (new_ticket) was auto-added to the parent form');
  assert.strictEqual(sub.parameters.RelationshipName, 'new_customer_new_ticket');
});

test('a junction sample row binds multiple parents via $parents', async () => {
  const spec = {
    solution: { uniqueName: 'J', displayName: 'J', publisherPrefix: 'new' }, app: { name: 'J', description: '' },
    entities: [
      { schemaName: 'new_wo', displayName: 'WO', primaryAttribute: { schemaName: 'new_name', displayName: 'Name' }, columns: [] },
      { schemaName: 'new_tech', displayName: 'Tech', primaryAttribute: { schemaName: 'new_name', displayName: 'Name' }, columns: [] },
      { schemaName: 'new_assign', displayName: 'Assign', primaryAttribute: { schemaName: 'new_name', displayName: 'Name' }, columns: [] },
    ],
    relationships: [
      { type: 'OneToMany', referenced: 'new_wo', referencing: 'new_assign', lookup: { schemaName: 'new_woid', displayName: 'WO' } },
      { type: 'OneToMany', referenced: 'new_tech', referencing: 'new_assign', lookup: { schemaName: 'new_techid', displayName: 'Tech' } },
    ],
    views: [], charts: [], forms: [], appShell: { areas: [] },
    sampleData: {
      new_wo: [{ new_name: 'WO1' }], new_tech: [{ new_name: 'T1' }],
      new_assign: [{ new_name: 'A1', $parents: [{ entity: 'new_wo', match: { new_name: 'WO1' } }, { entity: 'new_tech', match: { new_name: 'T1' } }] }],
    },
  };
  const { sdk, calls } = mockSdk();
  await runSdkBuild(spec, { sdk, apply: true, sampleData: true });
  const call = find(calls, 'seedRecordGraph').find((c) => c.args[0][0].entityLogical === 'new_assign');
  const rec = call.args[0][0].records[0];
  assert.deepStrictEqual(rec.binds, [
    { navProperty: 'new_woid', parentEntity: 'new_wo', parentIndex: 0 },
    { navProperty: 'new_techid', parentEntity: 'new_tech', parentIndex: 0 },
  ]);
  assert.strictEqual(rec.body.$parents, undefined);
});

test('a sample row sets a custom status reason (statecode + captured statuscode value)', async () => {
  const spec = makeSpec();
  spec.entities[1].statusReasons = [{ label: 'Escalated', state: 'Active' }];
  spec.sampleData.new_ticket[0].statusReason = 'Escalated';
  const { sdk, calls } = mockSdk();
  await runSdkBuild(spec, { sdk, apply: true, sampleData: true });
  const rec = find(calls, 'seedRecordGraph').find((c) => c.args[0][0].entityLogical === 'new_ticket').args[0][0].records[0];
  assert.strictEqual(rec.body.statuscode, 100000001, 'value captured from insertStatusValue');
  assert.strictEqual(rec.body.statecode, 0, 'Active state');
  assert.strictEqual(rec.body.statusReason, undefined, 'sentinel stripped from the body');
});

// --- Live-build hardening: global-choice sample labels, alt-key idempotency, status guard ---

test('a global-choice sample value is resolved from its label to the option int', async () => {
  const spec = makeSpec();
  spec.globalChoices = [{ name: 'new_tierset', displayName: 'Tier', options: ['Platinum', 'Gold', 'Silver', 'Bronze'] }];
  // make new_customer.new_tier a GLOBAL choice (makeSpec ships it inline) and set a label.
  spec.entities[0].columns[0] = { schemaName: 'new_tier', displayName: 'Tier', type: 'Choice', globalChoice: 'new_tierset' };
  spec.sampleData.new_customer[0].new_tier = 'Silver';
  const { sdk, calls } = mockSdk();
  await runSdkBuild(spec, { sdk, apply: true, sampleData: true });
  const rec = find(calls, 'seedRecordGraph').find((c) => c.args[0][0].entityLogical === 'new_customer').args[0][0].records[0];
  assert.strictEqual(rec.body.new_tier, 100000002, 'global-choice label resolved to 100000000+index');
});

test('alt-key creation is idempotent: an already-exists error is a skip, not a halt', async () => {
  const spec = makeSpec();
  spec.entities[0].alternateKeys = [{ schemaName: 'new_namekey', displayName: 'Name Key', columns: ['new_name'] }];
  const { sdk, calls } = mockSdk({ altKeyExists: true });
  const events = [];
  await runSdkBuild(spec, { sdk, apply: true, emit: (e) => events.push(e) }); // must NOT throw
  assert.ok(has(calls, 'createAlternateKey'), 'createAlternateKey was attempted');
  assert.ok(events.some((e) => e.status === 'skip' && /alt key new_customer\.new_namekey \(exists\)/.test(e.label)), 'duplicate alt key emits a skip');
  assert.ok(has(calls, 'createArtifact'), 'the build continued past the duplicate alt key');
});

test('status reasons are idempotent: an already-exists insert is skipped (no halt), value still captured', async () => {
  const spec = makeSpec();
  spec.entities[1].statusReasons = [{ label: 'Escalated', state: 'Active' }];
  spec.sampleData.new_ticket[0].statusReason = 'Escalated';
  const { sdk, calls } = mockSdk({ statusExists: true });
  const events = [];
  await runSdkBuild(spec, { sdk, apply: true, sampleData: true, emit: (e) => events.push(e) }); // must NOT throw
  assert.ok(events.some((e) => e.status === 'skip' && /status reason new_ticket: Escalated \(exists\)/.test(e.label)), 'duplicate status reason emits a skip');
  const rec = find(calls, 'seedRecordGraph').find((c) => c.args[0][0].entityLogical === 'new_ticket').args[0][0].records[0];
  assert.strictEqual(rec.body.statuscode, 100000000, 'pinned value captured even when the insert was skipped');
  assert.strictEqual(rec.body.statecode, 0);
});

test('status reasons pin a deterministic value (passed explicitly so re-runs are idempotent)', async () => {
  const spec = makeSpec();
  spec.entities[1].statusReasons = [{ label: 'Escalated', state: 'Active' }, { label: 'On Hold', state: 'Active' }];
  const { sdk, calls } = mockSdk();
  await runSdkBuild(spec, { sdk, apply: true });
  const vals = find(calls, 'insertStatusValue').map((c) => c.args[1].value);
  assert.deepStrictEqual(vals, [100000000, 100000001], 'explicit publisher-range values, indexed per entity');
});

test('quick-create / quick-view forms build with their formType; Notes stays on Main only', async () => {
  const spec = makeSpec();
  spec.entities[1].hasNotes = true; // new_ticket
  spec.forms.push(
    { entity: 'new_ticket', name: 'Ticket', formType: 'Main', layout: 'auto' },
    { entity: 'new_ticket', name: 'Ticket Quick Create', formType: 'QuickCreate', layout: 'auto' },
    { entity: 'new_ticket', name: 'Ticket Card', formType: 'QuickView', layout: 'auto' }
  );
  const { sdk, calls } = mockSdk();
  await runSdkBuild(spec, { sdk, apply: true });
  const formDefs = find(calls, 'createArtifact').filter((c) => c.args[0] === 'form').map((c) => c.args[1]);
  const byName = (n) => formDefs.find((d) => d.name === n);
  assert.strictEqual(byName('Customer').formType, 'Main', 'default form type is Main');
  assert.strictEqual(byName('Ticket Quick Create').formType, 'QuickCreate');
  assert.strictEqual(byName('Ticket Card').formType, 'QuickView');
  // Notes check: map form name → form id (idc increments per createArtifact + createWebResource in mock)
  // then look at addElement('/tabs', tab) calls to find the Notes section in the new topology.
  let idcCount = 0;
  const formIdByName = {};
  for (const c of calls) {
    if (c.name === 'createArtifact') { idcCount++; if (c.args[0] === 'form') formIdByName[c.args[1].name] = `form-${idcCount}`; }
    else if (c.name === 'createWebResource') idcCount++;
  }
  const formHasNotes = (name) => {
    const fid = formIdByName[name];
    return find(calls, 'addElement').some((c) =>
      c.args[0] === 'form' && c.args[1] === fid && c.args[2] === '/tabs' &&
      (c.args[3].columns || []).some((col) => (col.sections || []).some((s) => s.name === 'section_notes'))
    );
  };
  assert.ok(formHasNotes('Ticket'), 'Main form carries the Notes section');
  assert.ok(!formHasNotes('Ticket Quick Create'), 'QuickCreate form has no Notes section');
  assert.ok(!formHasNotes('Ticket Card'), 'QuickView form has no Notes section');
});

test('commands: a functional button is built with a JS on-click action + static visibility', async () => {
  const spec = makeSpec();
  spec.webResources = [{ name: 'new_ticket.js', type: 'js', content: 'var T={escalate:function(){}};' }];
  spec.commands = [
    { entity: 'new_ticket', label: 'Escalate', location: 'MainTab', library: 'new_ticket.js', function: 'T.escalate', disabled: true },
  ];
  const { sdk, calls } = mockSdk();
  await runSdkBuild(spec, { sdk, apply: true });
  const cmd = find(calls, 'createArtifact').find((c) => c.args[0] === 'command');
  assert.ok(cmd, 'command artifact created');
  const def = cmd.args[1];
  assert.strictEqual(def.entityLogicalName, 'new_ticket');
  const ctrl = def.commandBars[0].groups[0].controls[0];
  assert.strictEqual(def.commandBars[0].location, 'MainTab');
  assert.strictEqual(def.commandBars[0].groups[0].title, '', 'loose-controls group (empty title) — no parentless group row');
  assert.strictEqual(def.commandBars[0].groups[0].id, '', 'loose group carries an empty id (emitted as loose controls)');
  assert.strictEqual(ctrl.label, 'Escalate');
  assert.strictEqual(ctrl.command, ctrl.id, 'command references its own appactionid');
  assert.strictEqual(ctrl.action.type, 'javascript');
  assert.strictEqual(ctrl.action.functionName, 'T.escalate');
  assert.ok(ctrl.action.webResourceId, 'on-click resolved to the created web-resource id');
  assert.strictEqual(ctrl.disabled, true);
  assert.ok(find(calls, 'pushArtifact').some((c) => c.args[0] === 'command'), 'command pushed');
});

test('dashboards: chart + list tiles resolve the created view/visualization ids', async () => {
  const spec = makeSpec(); // has view "Active Tickets" + chart "By Priority" on new_ticket
  spec.dashboards = [
    { name: 'Ops', tiles: [
      { type: 'chart', chart: 'By Priority', view: 'Active Tickets' },
      { type: 'list', view: 'Active Tickets', name: 'Recent' },
    ] },
  ];
  const { sdk, calls } = mockSdk();
  await runSdkBuild(spec, { sdk, apply: true });
  const dash = find(calls, 'createArtifact').find((c) => c.args[0] === 'dashboard');
  assert.ok(dash && dash.args[1].name === 'Ops', 'dashboard artifact created');
  // Dashboard tiles are now added via addElement('/components', dashboardComponent(...))
  const tileComps = find(calls, 'addElement')
    .filter((c) => c.args[0] === 'dashboard' && c.args[2] === '/components')
    .map((c) => c.args[3]);
  assert.strictEqual(tileComps.length, 2);
  const chart = tileComps.find((t) => t.type === 'chart');
  assert.strictEqual(chart.parameters.TargetEntityType, 'new_ticket', 'entity derived from the view');
  assert.ok(chart.parameters.ViewId, 'view id resolved');
  // `VisualizationId`, NOT `ChartId`. This assertion previously named the wrong parameter, so the
  // suite agreed with a bug that failed the whole dashboards phase on a real environment with a
  // 400: "The element 'parameters' has invalid child element 'ChartId'". A mock cannot validate
  // FormXML against the platform schema, so the wire NAME has to be pinned explicitly here.
  assert.ok(chart.parameters.VisualizationId, 'chart visualization id resolved');
  assert.strictEqual(chart.parameters.ChartId, undefined,
    'the rejected `ChartId` spelling is not emitted (it is not a legal <parameters> child)');
  const list = tileComps.find((t) => t.type === 'list');
  assert.strictEqual(list.name, 'Recent');
  assert.ok(list.parameters.ViewId);
  // added to the solution as a systemform (60) and pushed
  assert.ok(find(calls, 'pushArtifact').some((c) => c.args[0] === 'dashboard'));
  assert.ok(find(calls, 'addSolutionComponent').some((c) => c.args[0].componentType === 60));
});

test('dashboards: an existing dashboard is reused (no duplicate) and reported in result.created', async () => {
  const spec = makeSpec();
  spec.dashboards = [{ name: 'Ops', tiles: [{ type: 'list', view: 'Active Tickets', name: 'Recent' }] }];
  const { sdk, calls } = mockSdk({ existingDashboards: ['Ops'] });
  const result = await runSdkBuild(spec, { sdk, apply: true });
  // The old code create-duplicated every run; the reconcile must NOT create when one already exists.
  assert.ok(!find(calls, 'createArtifact').some((c) => c.args[0] === 'dashboard'), 'no duplicate dashboard created');
  // The existing id is still threaded into result.created so downstream references resolve.
  assert.strictEqual(result.created.dashboards.Ops, 'dashboard-existing-Ops');
  assert.ok(find(calls, 'resolveArtifact').some((c) => c.args[0] === 'dashboard' && c.args[1].name === 'Ops'), 'discovered via resolveArtifact');
});

test('dashboards: a new dashboard is still created + pushed + added to the solution', async () => {
  const spec = makeSpec();
  spec.dashboards = [{ name: 'Ops', tiles: [{ type: 'list', view: 'Active Tickets', name: 'Recent' }] }];
  const { sdk, calls } = mockSdk(); // nothing pre-exists
  const result = await runSdkBuild(spec, { sdk, apply: true });
  assert.ok(find(calls, 'createArtifact').some((c) => c.args[0] === 'dashboard'), 'dashboard created when absent');
  assert.ok(find(calls, 'pushArtifact').some((c) => c.args[0] === 'dashboard'), 'dashboard pushed');
  assert.ok(result.created.dashboards.Ops, 'created id recorded');
});

test('commands: an existing command bar is reused (no duplicate) and reported in result.created', async () => {
  const spec = makeSpec();
  spec.webResources = [{ name: 'new_ticket.js', type: 'js', content: 'var T={a:function(){}};' }];
  spec.commands = [{ entity: 'new_ticket', label: 'A', library: 'new_ticket.js', function: 'T.a' }];
  const { sdk, calls } = mockSdk({ existingCommands: ['new_ticket'] });
  const result = await runSdkBuild(spec, { sdk, apply: true });
  assert.ok(!find(calls, 'createArtifact').some((c) => c.args[0] === 'command'), 'no duplicate command created');
  assert.strictEqual(result.created.commands.new_ticket, 'command-existing-new_ticket');
  assert.ok(find(calls, 'resolveArtifact').some((c) => c.args[0] === 'command' && c.args[1].entity === 'new_ticket'), 'discovered via resolveArtifact');
});

test('commands: a new command bar is still created + pushed', async () => {
  const spec = makeSpec();
  spec.webResources = [{ name: 'new_ticket.js', type: 'js', content: 'var T={a:function(){}};' }];
  spec.commands = [{ entity: 'new_ticket', label: 'A', library: 'new_ticket.js', function: 'T.a' }];
  const { sdk, calls } = mockSdk();
  const result = await runSdkBuild(spec, { sdk, apply: true });
  assert.ok(find(calls, 'createArtifact').some((c) => c.args[0] === 'command'), 'command created when absent');
  assert.strictEqual(typeof result.created.commands.new_ticket, 'string');
});

test('commands: planFor lists a command bar per entity', () => {
  const spec = makeSpec();
  spec.webResources = [{ name: 'new_ticket.js', type: 'js', content: 'x' }];
  spec.commands = [
    { entity: 'new_ticket', label: 'A', library: 'new_ticket.js', function: 'X.a' },
    { entity: 'new_ticket', label: 'B', library: 'new_ticket.js', function: 'X.b' },
  ];
  const labels = planFor(spec, { phases: PHASES }).map((p) => p.label);
  assert.ok(labels.some((l) => /command bar for new_ticket \(2 button\(s\)\)/.test(l)));
});

test('quick-view placement: a QuickView form is embedded on a host form via a lookup (addQuickViewControl)', async () => {
  const spec = makeSpec();
  spec.forms = [
    { entity: 'new_ticket', name: 'Ticket', formType: 'Main', layout: 'auto',
      quickViews: [{ lookup: 'new_CustomerId', targetEntity: 'new_customer', form: 'Customer QV', label: 'Customer' }] },
    { entity: 'new_customer', name: 'Customer QV', formType: 'QuickView', layout: 'auto' },
  ];
  const { sdk, calls } = mockSdk();
  await runSdkBuild(spec, { sdk, apply: true });
  // Quick-view is now a control cell added via addElement (generic SDK surface)
  const QUICKVIEW_CLS = '5C5600E0-1D6E-4205-A272-BE80DA87FD42';
  const normClsQV = (c) => String(c || '').replace(/[{}]/g, '').toUpperCase();
  const qvCall = find(calls, 'addElement').find((c) =>
    c.args[0] === 'form' && (c.args[3] && c.args[3].cells || []).some((cell) => cell.control && normClsQV(cell.control.classId) === QUICKVIEW_CLS)
  );
  assert.ok(qvCall, 'one quick-view control placed');
  const qvCtrl = (qvCall.args[3].cells || []).find((cell) => cell.control && normClsQV(cell.control.classId) === QUICKVIEW_CLS).control;
  const hostId = qvCall.args[1];
  assert.strictEqual(qvCtrl.fieldName, 'new_customerid', 'lookup lower-cased');
  // targetEntity is encoded in the QuickForms XML (entityname attribute)
  assert.ok(qvCtrl.parameters.QuickForms.includes('entityname="new_customer"'), 'target entity in QuickForms XML');
  // quickViewFormId is in the QuickForms XML; must not equal the host form's id
  const qvFormIdMatch = qvCtrl.parameters.QuickForms.match(/<QuickFormId[^>]*>([^<]+)<\/QuickFormId>/);
  const quickViewFormId = qvFormIdMatch && qvFormIdMatch[1];
  assert.ok(quickViewFormId && quickViewFormId !== hostId, 'resolved to the QuickView form id (not the host)');
  assert.ok(find(calls, 'fetchArtifact').some((c) => c.args[0] === 'form'), 'host form fetched before placement');
  assert.ok(find(calls, 'publishArtifact').some((c) => c.args[0] === 'form'), 'host form published after placement');
  assert.ok(planFor(spec, { phases: PHASES }).some((p) => /place 1 quick-view\(s\) on new_ticket/.test(p.label)), 'plan lists the placement step');
});

test('quick-view placement halts clearly when the referenced form was not built', async () => {
  const spec = makeSpec();
  spec.forms = [
    { entity: 'new_ticket', name: 'Ticket', formType: 'Main', layout: 'auto',
      quickViews: [{ lookup: 'new_CustomerId', targetEntity: 'new_customer', form: 'Nope' }] },
  ];
  const { sdk } = mockSdk();
  await assert.rejects(runSdkBuild(spec, { sdk, apply: true }), /quick-view references form 'Nope' on 'new_customer' which wasn't built/);
});

test('commands: loose buttons + a flyout with children build to the right shape (one loose group)', async () => {
  const spec = makeSpec();
  spec.webResources = [{ name: 'new_ticket.js', type: 'js', content: 'x' }];
  spec.commands = [
    { entity: 'new_ticket', label: 'Loose', library: 'new_ticket.js', function: 'T.loose' },
    { entity: 'new_ticket', label: 'More', type: 'FlyoutAnchor', children: [
      { label: 'Child A', library: 'new_ticket.js', function: 'T.a' },
      { label: 'Child B', library: 'new_ticket.js', function: 'T.b' },
    ] },
  ];
  const { sdk, calls } = mockSdk();
  await runSdkBuild(spec, { sdk, apply: true });
  const def = find(calls, 'createArtifact').find((c) => c.args[0] === 'command').args[1];
  const groups = def.commandBars[0].groups;
  assert.strictEqual(groups.length, 1, 'one loose group per location (no parentless titled groups)');
  assert.strictEqual(groups[0].title, '', 'loose group: empty title');
  assert.strictEqual(groups[0].id, '', 'loose group: empty id');
  const flyout = groups[0].controls.find((c) => c.type === 'FlyoutAnchor');
  assert.ok(flyout, 'flyout control built');
  assert.strictEqual(flyout.children.length, 2, 'flyout carries its child buttons (adapter synthesizes the intervening group)');
  assert.ok(!flyout.action, 'flyout container has no on-click of its own');
  assert.strictEqual(flyout.children[0].action.functionName, 'T.a', 'child button carries the JS on-click');
  assert.strictEqual(flyout.children[0].command, flyout.children[0].id, 'child references its own appactionid');
});

test('app-shell: a DashBoard subarea references a built dashboard (the SDK auto-pins it as a component)', () => {
  const spec = makeSpec();
  spec.dashboards = [{ name: 'Ops', tiles: [{ type: 'list', view: 'Active Tickets', name: 'Recent' }] }];
  spec.appShell.areas[0].groups[0].subAreas.push({ dashboard: 'Ops', title: 'Overview' });
  const def = appDef(spec, { forms: {}, views: {}, charts: {}, dashboards: { Ops: 'dash-123' } });
  const subs = def.siteMap.areas[0].groups[0].subAreas;
  const dash = subs.find((s) => s.type === 'DashBoard');
  assert.ok(dash, 'DashBoard subarea emitted');
  assert.strictEqual(dash.dashboardId, 'dash-123', 'resolved to the built dashboard id');
  assert.strictEqual(subs.find((s) => s.type === 'Entity').entity, 'new_customer', 'entity subarea still works alongside');
});

test('app-shell: a DashBoard subarea for an unbuilt dashboard throws a clear error', () => {
  const spec = makeSpec();
  spec.appShell.areas[0].groups[0].subAreas.push({ dashboard: 'Missing', title: 'X' });
  assert.throws(() => appDef(spec, { forms: {}, views: {}, charts: {}, dashboards: {} }), /references dashboard 'Missing' which wasn't built/);
});

test('app-shell: entity-subarea icons round-trip — a BARE token vectorIcon is dropped, a VALID platform (path/$webresource) vectorIcon is emitted, and an OOB icon path is preserved VERBATIM (case-sensitive)', () => {
  const spec = makeSpec();
  spec.appShell.areas[0].icon = 'New_AreaIcon.png';
  spec.appShell.areas[0].vectorIcon = 'Home';
  // Entity subarea 0: a bare Fluent token vectorIcon (breaks the designer) → dropped; a bare-name icon → lowercased.
  spec.appShell.areas[0].groups[0].subAreas[0].icon = 'New_SubIcon.png';
  spec.appShell.areas[0].groups[0].subAreas[0].vectorIcon = 'Grid';
  // Entity subarea 1: a VALID platform vectorIcon (svg path) + an OOB icon path (mixed case) — both must round-trip.
  const OOB = '/WebResources/msdyn_OmnichannelBase/_imgs/SitemapIcon/CDSEntity';
  const SVG = '/WebResources/crba3_/icons/approval.svg';
  spec.appShell.areas[0].groups[0].subAreas.push({ entity: spec.entities[0].schemaName, title: 'Custom', icon: OOB, vectorIcon: SVG });
  spec.appShell.areas[0].groups[0].subAreas.push({ url: 'https://x', title: 'Help', vectorIcon: '/_imgs/x.svg' });
  const def = appDef(spec, { forms: {}, views: {}, charts: {}, dashboards: {} });
  const area = def.siteMap.areas[0];
  const sub0 = area.groups[0].subAreas[0];
  const custom = area.groups[0].subAreas.find((s) => s.title === 'Custom');
  const urlSub = area.groups[0].subAreas.find((s) => s.type === 'URL');
  assert.strictEqual(area.icon, 'new_areaicon.png');
  assert.strictEqual(area.vectorIcon, 'Home', 'area vectorIcon is kept (areas are out of the reported bug scope)');
  // Area OOB/platform icon path must ALSO be preserved verbatim (not lower-cased) — same rule as subareas.
  const areaOob = appDef((() => { const s = makeSpec(); s.appShell.areas[0].icon = OOB; return s; })(), { forms: {}, views: {}, charts: {}, dashboards: {} }).siteMap.areas[0];
  assert.strictEqual(areaOob.icon, OOB, 'an OOB AREA icon path is preserved VERBATIM (case-sensitive), not lower-cased');
  assert.strictEqual(sub0.icon, 'new_subicon.png', 'a bare-name icon is lowercased (web-resource names are case-insensitive)');
  assert.strictEqual(sub0.vectorIcon, undefined, 'a BARE-TOKEN entity vectorIcon is dropped (would break the designer)');
  assert.strictEqual(custom.vectorIcon, SVG, 'a VALID platform vectorIcon on an entity subarea is now EMITTED (Symptom A fix)');
  assert.strictEqual(custom.icon, OOB, 'an OOB icon PATH is preserved VERBATIM — never lower-cased (case-sensitive path)');
  assert.strictEqual(urlSub.vectorIcon, '/_imgs/x.svg', 'a non-entity (url) subarea keeps vectorIcon (an SVG path is valid there)');
});

test('app-shell: a page subarea resolves to a GenPage subarea with the built genPageId', () => {
  const spec = makeSpec();
  spec.pages = [{ name: 'Overview', codeFile: 'o.tsx' }];
  spec.appShell.areas[0].groups[0].subAreas.push({ page: 'Overview', title: 'Overview' });
  const def = appDef(spec, { forms: {}, views: {}, charts: {}, dashboards: {}, pages: { Overview: 'gp-1' } });
  const sub = def.siteMap.areas[0].groups[0].subAreas.find((s) => s.type === 'GenPage');
  assert.ok(sub, 'GenPage subarea emitted');
  assert.strictEqual(sub.genPageId, 'gp-1');
});

test('app-shell: a page subarea for an unbuilt page throws a clear error', () => {
  const spec = makeSpec();
  spec.appShell.areas[0].groups[0].subAreas.push({ page: 'Missing', title: 'X' });
  assert.throws(() => appDef(spec, { forms: {}, views: {}, charts: {}, dashboards: {}, pages: {} }), /references page 'Missing' which wasn't built/);
});

test('pages phase uploads each page (no --add-to-sitemap) then finalizes the sitemap with GenPage subareas', async () => {
  const spec = makeSpec();
  spec.pages = [{ name: 'Overview', codeFile: 'o.tsx', prompt: 'kpis', dataSources: ['new_customer'] }];
  spec.appShell.areas[0].groups[0].subAreas.push({ page: 'Overview', title: 'Overview' });
  const appDir = stagePages(spec.pages);
  try {
    const { sdk, calls } = mockSdk();
    const uploads = [];
    const genpageCli = { enumerateEnv: async () => ({ ok: true, ids: [], pages: [] }), upload: async (o) => { uploads.push(o); return { pageId: 'gp-1' }; } };
    await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'] });
    assert.strictEqual(uploads.length, 1, 'one page uploaded');
    const setDef = find(calls, 'updateElement').find((c) => c.args[2] === '/siteMap');
    assert.ok(setDef.args[3].areas[0].groups[0].subAreas.some((s) => s.type === 'GenPage' && s.genPageId === 'gp-1'), 'GenPage subarea in the finalized sitemap');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('app-shell creates the app WITHOUT unbuilt page subareas (app_early ordering)', async () => {
  const spec = makeSpec();
  spec.pages = [{ name: 'Overview', codeFile: 'o.tsx' }];
  spec.appShell.areas[0].groups[0].subAreas.push({ page: 'Overview', title: 'Overview' });
  const appDir = stagePages(spec.pages);
  try {
    const { sdk, calls } = mockSdk();
    const genpageCli = { enumerateEnv: async () => ({ ok: true, ids: [], pages: [] }), upload: async () => ({ pageId: 'gp-1' }) };
    await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'] });
    const appCreate = find(calls, 'createArtifact').find((c) => c.args[0] === 'app');
    assert.ok(!appCreate.args[1].siteMap.areas[0].groups[0].subAreas.some((s) => s.type === 'GenPage'), 'no GenPage subarea at app-create time');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('pages phase reuses an existing page by MANIFEST+EXISTENCE (not by name) — UPDATE in place, no duplicate', async () => {
  const spec = makeSpec();
  spec.schemaVersion = 2;
  spec.pages = [{ key: 'overview', name: 'Overview', source: { kind: 'tsx', codeFile: 'o.tsx' } }];
  spec.appShell.areas[0].groups[0].subAreas.push({ page: 'overview', title: 'Overview' });
  const appUnique = appUniqueName(spec);
  const appDir = stagePages(spec.pages);
  try {
    const REUSE = '9a1c2b3d-4e5f-4061-8072-0839455a6b7c';
    // The manifest maps overview -> REUSE; REUSE exists env-wide AND is a member of THIS app's sitemap →
    // reconcile reuses it (an UPDATE). Display names are no longer an identity source (the old name match).
    const existing = Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: REUSE }] }), 'utf8').toString('base64');
    const sm = `<SiteMap><Area><Group><SubArea GenPageId="${REUSE}" Title="Overview"/></Group></Area></SiteMap>`;
    const { sdk } = mockSdk({ pageManifest: existing, manifestId: 'wr-manifest', selfAppUnique: appUnique, liveSitemapXml: sm });
    const uploads = [];
    const genpageCli = { enumerateEnv: async () => ({ ok: true, ids: [REUSE], pages: [{ pageId: REUSE, name: 'Overview' }] }), upload: async (o) => { uploads.push(o); return { pageId: o.pageId || REUSE }; } };
    await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'] });
    assert.strictEqual(uploads.length, 1, 'one upload');
    assert.strictEqual(uploads[0].pageId, REUSE, 'existing page UPDATEd via its manifest id, not duplicated');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('defaultViewColumns: primary first (wide) + declared columns, capped at 7, skipping wide types', () => {
  const entity = {
    schemaName: 'new_ticket',
    primaryAttribute: { schemaName: 'new_subject', displayName: 'Subject' },
    columns: [
      { schemaName: 'new_priority', type: 'Choice' },
      { schemaName: 'new_notes', type: 'Memo' },
      { schemaName: 'new_a', type: 'Text' }, { schemaName: 'new_b', type: 'Text' },
      { schemaName: 'new_c', type: 'Text' }, { schemaName: 'new_d', type: 'Text' },
      { schemaName: 'new_e', type: 'Text' }, { schemaName: 'new_f', type: 'Text' },
    ],
  };
  const cols = defaultViewColumns({}, entity);
  assert.strictEqual(cols[0].name, 'new_subject');
  assert.strictEqual(cols[0].width, 300);
  assert.ok(!cols.some((c) => c.name === 'new_notes'), 'Memo skipped');
  assert.ok(cols.length <= 7, 'capped at 7 total');
  assert.deepStrictEqual(cols.map((c) => c.order), cols.map((_, i) => i));
});

test('enrichesDefaultViews: needs a non-primary column and honors the opt-out', () => {
  const bare = { schemaName: 'new_x', primaryAttribute: { schemaName: 'new_name' }, columns: [] };
  assert.strictEqual(enrichesDefaultViews({}, bare), false);
  const rich = { schemaName: 'new_y', primaryAttribute: { schemaName: 'new_name' }, columns: [{ schemaName: 'new_p', type: 'Choice' }] };
  assert.strictEqual(enrichesDefaultViews({}, rich), true);
  assert.strictEqual(enrichesDefaultViews({}, { ...rich, enrichDefaultViews: false }), false);
});

test('views phase enriches default views via the SDK (one call per enrichable entity)', async () => {
  const spec = makeSpec();
  const { sdk, calls } = mockSdk();
  await runSdkBuild(spec, { sdk, apply: true, phases: ['solution', 'data-model', 'views'] });
  const enrichCalls = find(calls, 'enrichDefaultViews');
  assert.ok(enrichCalls.length >= 2, 'a default view enriched per entity');
  const custCall = enrichCalls.find((c) => c.args[0] === 'new_customer');
  assert.ok(custCall, 'customer default views enriched');
  assert.strictEqual(custCall.args[1][0].name, 'new_name', 'columns start with the primary column');
  assert.ok(custCall.args[1].some((col) => col.name === 'new_tier'), 'includes the declared column');
});

test('views phase skips default-view enrichment when opted out (enrichDefaultViews:false)', async () => {
  const spec = makeSpec();
  spec.entities.forEach((e) => { e.enrichDefaultViews = false; });
  const { sdk, calls } = mockSdk();
  await runSdkBuild(spec, { sdk, apply: true, phases: ['solution', 'data-model', 'views'] });
  assert.strictEqual(find(calls, 'enrichDefaultViews').length, 0, 'no enrichment when opted out');
});

test('artifactIdentityQuery: view/chart/form use (entity, name); form scopes by TYPE when known; others null', () => {
  assert.match(artifactIdentityQuery('view', { name: 'V', entityLogicalName: 'new_t' }).filter, /returnedtypecode eq 'new_t' and name eq 'V'/);
  assert.strictEqual(artifactIdentityQuery('view', { name: 'V', entityLogicalName: 'new_t' }).set, 'savedquery');
  assert.match(artifactIdentityQuery('chart', { name: 'C', entityLogicalName: 'new_t' }).filter, /primaryentitytypecode eq 'new_t' and name eq 'C'/);
  assert.match(artifactIdentityQuery('form', { name: "O'Brien", entityLogicalName: 'new_t' }).filter, /name eq 'O''Brien'/);
  // A known formType adds `type eq <code>` so a Main identity never collides with a same-named Quick View.
  assert.match(artifactIdentityQuery('form', { name: 'Information', entityLogicalName: 'new_t', formType: 'Main' }).filter, /name eq 'Information' and type eq 2$/);
  assert.match(artifactIdentityQuery('form', { name: 'Information', entityLogicalName: 'new_t', formType: 'QuickView' }).filter, /type eq 6$/);
  // No formType → name-only (back-compat), no `type eq`.
  assert.doesNotMatch(artifactIdentityQuery('form', { name: 'Information', entityLogicalName: 'new_t' }).filter, /type eq/);
  assert.match(artifactIdentityQuery('app', { name: 'A', uniqueName: 'new_a' }).filter, /uniquename eq 'new_a'/);
  assert.strictEqual(artifactIdentityQuery('command', { name: 'X' }), null);
});

// ── resolveExistingFormId: disambiguate a form by (entity, name, TYPE) — Dataverse form names are unique
// only per (entity, type), so a table's same-named Main / Quick View / Card forms must not collide. ──
test('resolveExistingFormId scopes by TYPE so a Main edit matches ONLY the Main form among same-named siblings', async () => {
  const seen = [];
  const provision = { queryRecords: async (e, o) => { seen.push(o.filter); return e === 'systemform' ? [{ formid: 'main-1' }] : []; } };
  const id = await resolveExistingFormId(provision, { entityLogicalName: 'zava_javavendor', name: 'Information', formType: 'Main' });
  assert.strictEqual(id, 'main-1');
  assert.match(seen[0], /objecttypecode eq 'zava_javavendor' and name eq 'Information' and type eq 2/, 'query scopes by objecttypecode + name + type eq 2 (Main)');
});

test('resolveExistingFormId maps every authored formType to its systemform.type code', async () => {
  const codeFor = async (formType) => {
    let captured;
    const provision = { queryRecords: async (e, o) => { captured = o.filter; return []; } };
    await resolveExistingFormId(provision, { entityLogicalName: 't', name: 'n', formType });
    return (captured.match(/type eq (\d+)/) || [])[1];
  };
  assert.strictEqual(await codeFor('Main'), '2');
  assert.strictEqual(await codeFor('QuickView'), '6');
  assert.strictEqual(await codeFor('QuickCreate'), '7');
  assert.deepStrictEqual(FORM_TYPE_CODE, { Main: 2, QuickView: 6, QuickCreate: 7, Card: 11 });
});

test('resolveExistingFormId returns null when the form is not deployed yet (→ a fresh create)', async () => {
  const provision = { queryRecords: async () => [] };
  assert.strictEqual(await resolveExistingFormId(provision, { entityLogicalName: 't', name: 'n', formType: 'Main' }), null);
});

test('resolveExistingFormId treats a "not found in the MetadataCache" 400 (brand-new table) as NOT FOUND, not a hard error', async () => {
  // A fresh build queries systemform for a table that does not exist yet → Dataverse 400. A form on a
  // non-existent table definitionally does not exist, so return null (build creates it; the fail-closed
  // preflight must NOT halt on this) — mirroring the SDK findArtifact this replaced.
  const provision = { queryRecords: async () => { const e = new Error("The entity with a name = 'ftx_widget' was not found in the MetadataCache"); e.statusCode = 400; throw e; } };
  assert.strictEqual(await resolveExistingFormId(provision, { entityLogicalName: 'ftx_widget', name: 'Information', formType: 'Main' }), null);
});

test('resolveExistingFormId RE-THROWS a non-metadata error (a transient failure must still fail closed)', async () => {
  const provision = { queryRecords: async () => { const e = new Error('429 Too Many Requests'); e.statusCode = 429; throw e; } };
  await assert.rejects(
    () => resolveExistingFormId(provision, { entityLogicalName: 't', name: 'n', formType: 'Main' }),
    /429/);
});

test('resolveExistingFormId throws an ACTIONABLE error on the residual same-(entity,type,name) collision (suggests forms[].formId)', async () => {
  // Two forms share entity+type+name — type scoping can't disambiguate; refuse to guess (fail-closed).
  const provision = { queryRecords: async () => [{ formid: 'a-1' }, { formid: 'a-2' }] };
  await assert.rejects(
    () => resolveExistingFormId(provision, { entityLogicalName: 'zava_javavendor', name: 'Information', formType: 'Main' }),
    (err) => /forms\[\]\.formId/.test(err.message) && /a-1/.test(err.message));
});

test('resolveExistingFormId honors a pinned forms[].formId — resolves by id and verifies the entity + type', async () => {
  const provision = { queryRecords: async (e, o) => {
    assert.match(o.filter, /formid eq 3024db08-9559-4d89-be11-d5cefa01a21f/, 'resolves by id (unquoted Edm.Guid)');
    return [{ formid: '3024db08-9559-4d89-be11-d5cefa01a21f', objecttypecode: 'zava_javavendor', type: 2, name: 'Information' }];
  } };
  const id = await resolveExistingFormId(provision, { entityLogicalName: 'zava_javavendor', name: 'Information', formType: 'Main', formId: '3024db08-9559-4d89-be11-d5cefa01a21f' });
  assert.strictEqual(id, '3024db08-9559-4d89-be11-d5cefa01a21f');
});

test('resolveExistingFormId rejects a pinned formId of the WRONG type (a Quick View id under formType:"Main")', async () => {
  const provision = { queryRecords: async () => [{ formid: 'f-1', objecttypecode: 'zava_javavendor', type: 6, name: 'Information' }] }; // type 6 = Quick View
  await assert.rejects(
    () => resolveExistingFormId(provision, { entityLogicalName: 'zava_javavendor', name: 'Information', formType: 'Main', formId: '3024db08-9559-4d89-be11-d5cefa01a21f' }),
    (err) => /type-6 form/.test(err.message) && /formType "Main"/.test(err.message));
});

test('resolveExistingFormId rejects a pinned formId whose NAME differs from the spec (never reconcile an unrelated form)', async () => {
  const provision = { queryRecords: async () => [{ formid: 'f-1', objecttypecode: 'zava_javavendor', type: 2, name: 'Some Other Form' }] };
  await assert.rejects(
    () => resolveExistingFormId(provision, { entityLogicalName: 'zava_javavendor', name: 'Information', formType: 'Main', formId: '3024db08-9559-4d89-be11-d5cefa01a21f' }),
    (err) => /is named 'Some Other Form'/.test(err.message) && /not 'Information'/.test(err.message));
});

test('resolveExistingFormId rejects a formId that belongs to a DIFFERENT table (never reconcile the wrong form)', async () => {
  const provision = { queryRecords: async () => [{ formid: 'f-1', objecttypecode: 'other_table', type: 2, name: 'Information' }] };
  await assert.rejects(
    () => resolveExistingFormId(provision, { entityLogicalName: 'zava_javavendor', name: 'Information', formType: 'Main', formId: '3024db08-9559-4d89-be11-d5cefa01a21f' }),
    /belongs to table 'other_table'/);
});

test('resolveExistingFormId rejects a malformed formId (guards the unquoted OData Guid interpolation)', async () => {
  const provision = { queryRecords: async () => { throw new Error('should not query on a bad id'); } };
  await assert.rejects(
    () => resolveExistingFormId(provision, { entityLogicalName: 't', name: 'n', formType: 'Main', formId: "not-a-guid' or 1 eq 1" }),
    /is not a valid GUID/);
});

test('resolveExistingFormId THROWS (does not create) when a pinned formId is absent — a stale pin must not mint a duplicate every rerun', async () => {
  const provision = { queryRecords: async () => [] };
  await assert.rejects(
    () => resolveExistingFormId(provision, { entityLogicalName: 't', name: 'n', formType: 'Main', formId: '3024db08-9559-4d89-be11-d5cefa01a21f' }),
    (err) => /pinned formId .* does not exist/.test(err.message));
});

test('idempotency: existing view/chart/form/app are reused, not re-created (no duplicates on re-run)', async () => {
  const spec = makeSpec();
  const { sdk, calls } = mockSdk({ artifactsExist: true });
  await runSdkBuild(spec, { sdk, apply: true, phases: ['solution', 'data-model', 'views', 'charts', 'forms', 'app-shell'] });
  const created = find(calls, 'createArtifact').map((c) => c.args[0]);
  assert.ok(!created.includes('view'), 'existing view reused (no createArtifact view)');
  assert.ok(!created.includes('chart'), 'existing chart reused');
  assert.ok(!created.includes('form'), 'existing form reused');
  assert.ok(!created.includes('app'), 'existing app reused');
});

// --- Gap 1/2: update-in-place (reconcile) for forms + views; stock-form reuse -----------------

// REBUILD IDEMPOTENCE — the highest-value regression net for the reconcile path, and the one the
// suite was missing. Every other reconcile test starts from an EMPTY deployed form, so "re-add
// everything" and "add only what's missing" produce identical call logs and no test can tell them
// apart. Running the build twice against the SAME mock store makes the second pass observe the
// first pass's artifacts, so a reconcile that has stopped reading the deployed form correctly
// shows up as duplicate work.
//
// Concretely, this is the test that fails when a `provision.getArtifact(...)` in reconcileForm or
// addSubgrids loses its `await`: the un-awaited Promise makes `formFieldLogicals` return `[]` and
// `hasSubgrid` return false, so the second build re-adds every field and splices a second
// sub-grid — on a real org, a visibly corrupted form behind a 2xx and a green build.
test('REBUILD idempotency: a second build over the same deployed form re-adds no field and no duplicate sub-grid', async () => {
  const spec = makeSpec();
  // artifactsExist makes both passes reconcile the SAME 'form-existing' row; the deployed form
  // starts empty, so pass 1 populates it and pass 2 must find its own work already done.
  const { sdk, calls } = mockSdk({ artifactsExist: true });
  const phases = ['solution', 'data-model', 'views', 'charts', 'forms'];

  await runSdkBuild(spec, { sdk, apply: true, phases });
  const firstPass = find(calls, 'addElement');
  assert.ok(firstPass.length > 0, 'pass 1 populated the deployed form (otherwise pass 2 proves nothing)');

  calls.length = 0; // same array the mock pushes into — measure ONLY the second pass
  await runSdkBuild(spec, { sdk, apply: true, phases });

  const readded = find(calls, 'addElement')
    .flatMap((c) => (c.args[3] && c.args[3].cells) || [])
    .filter((cell) => cell && cell.control && cell.control.fieldName)
    .map((cell) => cell.control.fieldName);
  assert.deepStrictEqual(readded, [],
    `pass 2 re-added field(s) already on the deployed form: ${JSON.stringify(readded)} — the `
    + 'reconcile is not reading the deployed form (check that every getArtifact is awaited)');

  // A sub-grid is spliced as a whole SECTION, not a field cell, so it needs its own assertion.
  const sections = find(calls, 'addElement').filter((c) => /\/sections$/.test(String(c.args[2])));
  assert.deepStrictEqual(sections.map((c) => c.args[2]), [],
    'pass 2 spliced another sub-grid section — hasSubgrid did not see the one pass 1 added');
});

test('form update-in-place: an existing form is reconciled (addField per spec field), not recreated', async () => {
  const { sdk, calls } = mockSdk({ artifactsExist: true });
  await runSdkBuild(makeSpec(), { sdk, apply: true, phases: ['solution', 'data-model', 'views', 'charts', 'forms'] });
  assert.ok(!find(calls, 'createArtifact').some((c) => c.args[0] === 'form'), 'no new form created on edit');
  // Fields are now applied via the generic addElement surface (addField was retired)
  const fieldCells = find(calls, 'addElement')
    .map((c) => (c.args[3] && c.args[3].cells) || []).flat()
    .filter((cell) => cell.control && cell.control.fieldName && !cell.control.classId);
  assert.ok(fieldCells.length > 0, 'spec fields re-applied via the idempotent addElement (field cells, no classId)');
  assert.ok(find(calls, 'fetchArtifact').some((c) => c.args[0] === 'form' && c.args[1] === 'form-existing'), 'form fetched before reconcile');
  assert.ok(find(calls, 'publishArtifact').some((c) => c.args[0] === 'form'), 'form published so the edit goes live');
});

test('form reconcile: an explicit-layout edit REMOVES a field dropped from the spec (add-only reconcile kept stale fields)', async () => {
  const spec = makeSpec();
  // Author controls the exact field set via explicit tabs, listing only name + tier.
  spec.forms = [{ entity: 'new_customer', name: 'Customer', layout: 'explicit',
    tabs: [{ label: 'General', sections: [{ label: 'Details', columns: 1, fields: ['new_name', 'new_tier'] }] }] }];
  // The deployed form still carries an extra field the edited spec no longer lists.
  const { sdk, calls } = mockSdk({ artifactsExist: true, existingFormFields: ['new_name', 'new_tier', 'new_obsolete'] });
  await runSdkBuild(spec, { sdk, apply: true, phases: ['solution', 'data-model', 'forms'] });
  // Fields are removed via removeElement (retired removeField); pointer encodes field position
  const removals = find(calls, 'removeElement');
  assert.deepStrictEqual(removals.map((c) => c.args[2]), ['/tabs/0/columns/0/sections/0/rows/2/cells/0'], 'only the cell for new_obsolete (row 2) is removed');
});

test('form reconcile: an AUTO layout is additive — a deployed field not in the spec is NOT pruned (Maker adds survive)', async () => {
  // makeSpec's new_customer form is layout:auto; a manual Maker field must not be stripped.
  const { sdk, calls } = mockSdk({ artifactsExist: true, existingFormFields: ['new_name', 'new_tier', 'new_manual'] });
  await runSdkBuild(makeSpec(), { sdk, apply: true, phases: ['solution', 'data-model', 'forms'] });
  assert.strictEqual(find(calls, 'removeElement').length, 0, 'auto layout never removes fields');
});

test('form reconcile: the entity primary field is never pruned, even when an explicit layout omits it', async () => {
  const spec = makeSpec();
  // Explicit layout omits the primary (new_name) — authors often rely on the header primary field.
  spec.forms = [{ entity: 'new_customer', name: 'Customer', layout: 'explicit',
    tabs: [{ label: 'General', sections: [{ label: 'Details', columns: 1, fields: ['new_tier'] }] }] }];
  const { sdk, calls } = mockSdk({ artifactsExist: true, existingFormFields: ['new_name', 'new_tier', 'new_extra'] });
  await runSdkBuild(spec, { sdk, apply: true, phases: ['solution', 'data-model', 'forms'] });
  // Fields removed via removeElement; pointer row index identifies the field
  const removedPtrs = find(calls, 'removeElement').map((c) => c.args[2]);
  assert.ok(!removedPtrs.some((ptr) => /\/rows\/0\//.test(ptr)), 'the primary field (row 0, new_name) is protected from pruning');
  assert.ok(removedPtrs.some((ptr) => /\/rows\/2\//.test(ptr)), 'a genuinely dropped field (row 2, new_extra) is still removed');
});

test('Gap 2: our (custom) main form is promoted to the entity default (isdefault) and NOTHING is deactivated', async () => {
  const { sdk, calls } = mockSdk({ artifactsExist: true });
  await runSdkBuild(makeSpec(), { sdk, apply: true, phases: ['solution', 'data-model', 'forms'] });
  const upd = find(calls, 'updateRecord').filter((c) => c.args[0] === 'systemform');
  assert.ok(upd.some((c) => c.args[2] && c.args[2].isdefault === true), 'our main form is marked isdefault=true');
  // Deactivation is destructive (disables sibling/role-based + env-wide OOB forms), so it must NOT happen.
  assert.ok(!upd.some((c) => c.args[2] && Object.prototype.hasOwnProperty.call(c.args[2], 'formactivationstate')), 'no form is deactivated');
  assert.ok(
    find(calls, 'queryRecords').some((c) => c.args[0] === 'systemform' && /name eq '/.test((c.args[1] || {}).filter || '') && /type eq 2/.test((c.args[1] || {}).filter || '')),
    'form resolved by (entity, name, TYPE) — the type-scoped query targets our Main form, not a same-named Quick View / Card sibling'
  );
});

test('#6 opt-in: forms[].deactivateOtherMainForms deactivates OTHER active main forms on our custom table', async () => {
  const spec = makeSpec();
  spec.forms = [{ entity: 'new_customer', name: 'Customer', layout: 'auto', deactivateOtherMainForms: true }];
  const { sdk, calls } = mockSdk({ artifactsExist: true });
  await runSdkBuild(spec, { sdk, apply: true, phases: ['solution', 'data-model', 'forms'] });
  const upd = find(calls, 'updateRecord').filter((c) => c.args[0] === 'systemform');
  assert.ok(upd.some((c) => c.args[2] && c.args[2].isdefault === true), 'our form is still promoted default');
  // The OTHER main form (the mock's stock-info) is deactivated (formactivationstate 0); ours is not.
  const deacts = upd.filter((c) => c.args[2] && c.args[2].formactivationstate === 0);
  assert.ok(deacts.some((c) => c.args[1] === 'stock-info'), 'the stock Information form is deactivated');
  assert.ok(!deacts.some((c) => c.args[1] === 'form-existing'), 'our own form is never deactivated');
  assert.ok(
    find(calls, 'queryRecords').some((c) => c.args[0] === 'systemform' && /type eq 2/.test((c.args[1] || {}).filter || '')),
    'queried the entity main forms (type 2) to find the ones to deactivate'
  );
});

test('#6 deactivation NEVER runs on a reused/system table even when the form flags it', async () => {
  const spec = makeSpec();
  spec.entities[0].existing = true; // mark new_customer as reused/system
  spec.forms = [{ entity: spec.entities[0].schemaName, name: 'Reused', layout: 'auto', deactivateOtherMainForms: true }];
  const { sdk, calls } = mockSdk({ artifactsExist: true });
  await runSdkBuild(spec, { sdk, apply: true, phases: ['solution', 'data-model', 'forms'] });
  const upd = find(calls, 'updateRecord').filter((c) => c.args[0] === 'systemform');
  assert.ok(!upd.some((c) => c.args[2] && c.args[2].formactivationstate === 0), 'no deactivation on a reused/system table even when flagged');
  assert.ok(!upd.some((c) => c.args[2] && c.args[2].isdefault === true), 'and the reused table default is never re-pointed');
});

test('#6 (hardening) if the isdefault promote FAILS, the other forms are NOT deactivated (no bricked default)', async () => {
  const spec = makeSpec();
  spec.forms = [{ entity: 'new_customer', name: 'Customer', layout: 'auto', deactivateOtherMainForms: true }];
  const { sdk, calls } = mockSdk({ artifactsExist: true });
  // Make ONLY the isdefault promote fail; other systemform writes (a deactivation) would still record.
  const realUpdate = sdk.updateRecord;
  sdk.updateRecord = async (e, id, data) => {
    if (e === 'systemform' && data && data.isdefault === true) throw new Error('promote failed');
    return realUpdate(e, id, data);
  };
  await runSdkBuild(spec, { sdk, apply: true, phases: ['solution', 'data-model', 'forms'] });
  const upd = find(calls, 'updateRecord').filter((c) => c.args[0] === 'systemform');
  assert.ok(!upd.some((c) => c.args[2] && c.args[2].formactivationstate === 0),
    'a failed promote must skip deactivation so the entity is not left with a deactivated default and no active default');
});

test('Gap 2: a Main form on a reused/system table is NOT promoted (never re-points a shared table default form)', async () => {
  // A system table (not prefixed with the solution publisher prefix, or flagged existing) must never
  // have its default form touched — that is an environment-wide side effect on shared data.
  const spec = makeSpec();
  spec.entities[0].existing = true; // mark the first entity as reused
  const reusedEntity = spec.entities[0].schemaName.toLowerCase();
  spec.forms = [{ entity: spec.entities[0].schemaName, type: 'main', name: 'Reused Form', layout: 'auto' }];
  const { sdk, calls } = mockSdk({ artifactsExist: true });
  await runSdkBuild(spec, { sdk, apply: true, phases: ['solution', 'data-model', 'forms'] });
  const promotedReused = find(calls, 'updateRecord').some((c) => c.args[0] === 'systemform' && c.args[2] && c.args[2].isdefault === true);
  assert.ok(!promotedReused, `no isdefault write for the reused table ${reusedEntity}`);
});

test('view update-in-place: an existing view has its columns reconciled (existing UNION spec) via setViewColumns', async () => {
  // Seed the deployed view with a manually-added column that a union must preserve.
  const { sdk, calls } = mockSdk({ artifactsExist: true, existingViewColumns: [{ name: 'new_manual', width: 100, order: 0 }] });
  await runSdkBuild(makeSpec(), { sdk, apply: true, phases: ['solution', 'data-model', 'views'] });
  assert.ok(!find(calls, 'createArtifact').some((c) => c.args[0] === 'view'), 'no new view created on edit');
  // View columns are now reconciled via updateElement('/columns') (setViewColumns was retired)
  const setCols = find(calls, 'updateElement').filter((c) => c.args[2] === '/columns');
  assert.ok(setCols.length > 0, 'view columns reconciled via updateElement(/columns)');
  assert.ok(setCols[0].args[3].map((c) => c.name).includes('new_manual'), 'a manually-added column is preserved (union, not replace)');
});

test('chart update-in-place is unsupported: an existing chart is skipped with a reason, not silently rebuilt', async () => {
  const events = [];
  const { sdk, calls } = mockSdk({ artifactsExist: true });
  await runSdkBuild(makeSpec(), { sdk, apply: true, phases: ['solution', 'data-model', 'charts'], emit: (e) => events.push(e) });
  assert.ok(!find(calls, 'createArtifact').some((c) => c.args[0] === 'chart'), 'existing chart not recreated');
  assert.ok(events.some((e) => e.phase === 'charts' && e.status === 'skip' && /aren't applied on rebuild/.test(e.label)), 'existing chart skipped with a clear reason');
});

test('formFieldLogicals extracts bound field names (excludes the notes control), deduped + lowercased', () => {
  const spec = {
    solution: { uniqueName: 'S', publisherPrefix: 'new' }, app: { name: 'A' },
    entities: [{ schemaName: 'new_task', primaryAttribute: { schemaName: 'new_name', displayName: 'T' }, columns: [{ schemaName: 'new_priority', displayName: 'P', type: 'Text' }], hasNotes: true }],
    relationships: [{ type: 'OneToMany', referenced: 'new_project', referencing: 'new_task', lookup: { schemaName: 'new_ProjectId', displayName: 'Project' } }],
  };
  const def = compileFormIntent(spec, { entity: 'new_task', name: 'T', layout: 'auto', notes: true }, { notesClassId: 'notes-classid' });
  assert.deepStrictEqual(formFieldLogicals(def), ['new_name', 'new_priority', 'new_projectid']);
});

test('edit flow: an existing (page-less) app has its sitemap rewritten so subarea edits land', async () => {
  // Re-running the build against an app that already exists must not silently drop requested
  // subarea add/rename/reorder edits (the sitemap was previously write-once on create).
  const spec = makeSpec();
  const { sdk, calls } = mockSdk({ artifactsExist: true }); // findArtifact('app') -> 'app-existing'
  await runSdkBuild(spec, { sdk, apply: true, phases: ['solution', 'data-model', 'views', 'charts', 'forms', 'app-shell'] });
  // No duplicate app is created...
  assert.ok(!find(calls, 'createArtifact').some((c) => c.args[0] === 'app'), 'no duplicate app created');
  // ...but the sitemap + components are rewritten from the current spec.
  // Sitemap is now updated via updateElement('app', id, '/siteMap', siteMap) (setAppDefinition retired)
  const setDef = find(calls, 'updateElement').find((c) => c.args[1] === 'app-existing' && c.args[2] === '/siteMap');
  assert.ok(setDef, 'existing app sitemap rewritten via updateElement(/siteMap)');
  const subs = setDef.args[3].areas[0].groups[0].subAreas;
  assert.ok(subs.some((s) => s.type === 'Entity' && s.entity === 'new_customer'), 'entity subarea present in rewritten sitemap');
  // Fetched into this session's workspace before push (also fixes cross-session publish), then
  // pushed + published so the nav change actually goes live.
  assert.ok(find(calls, 'fetchArtifact').some((c) => c.args[0] === 'app' && c.args[1] === 'app-existing'), 'app fetched (workspace hydration) before push');
  assert.ok(find(calls, 'pushArtifact').some((c) => c.args[0] === 'app' && c.args[1] === 'app-existing'), 'app pushed');
  assert.ok(find(calls, 'publishArtifact').some((c) => c.args[0] === 'app' && c.args[1] === 'app-existing'), 'page-less app published so the nav updates');
});

test('idempotency: absent artifacts are created as normal', async () => {
  const spec = makeSpec();
  const { sdk, calls } = mockSdk();
  await runSdkBuild(spec, { sdk, apply: true, phases: ['solution', 'data-model', 'views', 'charts', 'forms'] });
  const created = find(calls, 'createArtifact').map((c) => c.args[0]);
  assert.ok(created.includes('view') && created.includes('chart') && created.includes('form'), 'artifacts created when absent');
});

test('sample-data seeding is delegated to the SDK record-graph seeder', async () => {
  const spec = makeSpec();
  const { sdk, calls } = mockSdk();
  await runSdkBuild(spec, { sdk, apply: true, sampleData: true, phases: ['solution', 'data-model', 'sample-data'] });
  const seeded = find(calls, 'seedRecordGraph');
  const totalRecords = seeded.reduce((n, c) => n + c.args[0].reduce((m, g) => m + g.records.length, 0), 0);
  assert.strictEqual(totalRecords, 2, 'both sample rows handed to seedRecordGraph');
  // Resolve-by-name idempotency (reuse of existing rows) is enforced inside the SDK
  // (cds-maker-sdk RecordGraphApi.test.ts), not in the plugin.
});

test('sample-data groups are seeded parents-before-children (topological order)', async () => {
  const spec = makeSpec();
  const { sdk, calls } = mockSdk();
  await runSdkBuild(spec, { sdk, apply: true, sampleData: true, phases: ['solution', 'data-model', 'sample-data'] });
  const order = find(calls, 'seedRecordGraph').map((c) => c.args[0][0].entityLogical);
  assert.ok(order.indexOf('new_customer') < order.indexOf('new_ticket'), 'parent seeded before child');
});

test('alt-key creation still halts on a genuine (non-duplicate) error', async () => {
  const spec = makeSpec();
  spec.entities[0].alternateKeys = [{ schemaName: 'new_namekey', displayName: 'Name Key', columns: ['new_name'] }];
  const { sdk } = mockSdk({ altKeyError: true });
  await assert.rejects(runSdkBuild(spec, { sdk, apply: true }), /data-model failed/);
});

test('statusReason without the data-model phase halts loudly (no silent default status)', async () => {
  const spec = makeSpec();
  spec.entities[1].statusReasons = [{ label: 'Escalated', state: 'Active' }];
  spec.sampleData.new_ticket[0].statusReason = 'Escalated';
  const { sdk } = mockSdk();
  // skip data-model -> the status value is never captured; the guard must halt.
  await assert.rejects(
    runSdkBuild(spec, { sdk, apply: true, sampleData: true, phases: resolvePhases({ skip: ['data-model'] }) }),
    /status value wasn't captured/
  );
});

test('view filters: no-value ops, in/not-in groups, and Choice-label resolution', () => {
  const spec = makeSpec();
  const def = viewDef(spec, { entity: 'new_ticket', name: 'My Open', columns: ['new_subject'], activeOnly: true,
    filters: [
      { attr: 'ownerid', op: 'eq-userid' },
      { attr: 'new_priority', op: 'not-in', values: ['Low'] },
      { attr: 'modifiedon', op: 'this-week' },
    ] });
  const conds = def.filters.conditions;
  assert.ok(conds.some((c) => c.attribute === 'statecode' && c.value === '0'), 'activeOnly retained');
  const owner = conds.find((c) => c.attribute === 'ownerid');
  assert.strictEqual(owner.operator, 'eq-userid');
  assert.strictEqual(owner.value, undefined, 'no-value operator omits value');
  assert.ok(conds.some((c) => c.attribute === 'modifiedon' && c.operator === 'this-week' && c.value === undefined));
  const grp = def.filters.groups.find((g) => g.type === 'and');
  assert.ok(grp, 'not-in becomes a nested AND group');
  assert.strictEqual(grp.conditions[0].operator, 'ne');
  assert.strictEqual(grp.conditions[0].value, '100000000', "'Low' resolved to its option int");
});

test('formDef honors explicit tabs/sections/columns', () => {
  const def = compileFormIntent(makeSpec(), { entity: 'new_customer', name: 'C', tabs: [{ label: 'Main', sections: [{ label: 'Details', columns: 2, fields: ['new_name', 'new_tier'] }] }] }, {});
  const sec = def.tabs[0].columns[0].sections[0];
  assert.strictEqual(sec.label, 'Details');
  assert.strictEqual(sec.columns, 2);
  assert.strictEqual(sec.rows[0].cells.length, 2, '2-column section packs 2 cells per row');
  assert.strictEqual(sec.rows[0].cells[0].control.fieldName, 'new_name');
});

test('data-model + sample-data emit a stable phase/label sequence (parity anchor)', async () => {
  const { sdk } = mockSdk();
  const events = [];
  const desk = makeSpec();
  await runSdkBuild(desk, { sdk, apply: true, sampleData: true, emit: (e) => events.push(e) });
  const terminal = events.filter((e) => e.status !== 'start');
  // one monotonic counter across all phases
  const ns = terminal.map((e) => e.n);
  assert.deepStrictEqual(ns, [...ns].sort((a, b) => a - b));
  assert.strictEqual(new Set(ns).size, ns.length);
  // data-model creates the three tables + their columns; sample-data creates 3 record steps
  assert.ok(terminal.some((e) => e.phase === 'data-model' && /table new_ticket/.test(e.label)));
  assert.ok(terminal.filter((e) => e.phase === 'sample-data').length >= 1);
});

test('formDef auto lays out primary + columns; adds Notes when the entity has notes', () => {
  const spec = makeSpec();
  spec.entities[0].hasNotes = true;
  const def = compileFormIntent(spec, { entity: 'new_customer', name: 'C', layout: 'auto' }, { notesClassId: 'notes-classid' });
  const fields = def.tabs[0].columns[0].sections[0].rows.flatMap((r) => r.cells).map((c) => c.control.fieldName);
  assert.deepStrictEqual(fields, ['new_name', 'new_tier']);
  assert.ok(def.tabs[0].columns[0].sections.some((s) => s.name === 'section_notes'), 'a Notes section is added');
});

test('publish (opt-in) publishes one artifact per entity + the app', async () => {
  const { sdk, calls } = mockSdk();
  await runSdkBuild(makeSpec(), { sdk, apply: true, publish: true });
  const pubs = find(calls, 'publishArtifact').map((c) => c.args[0]);
  assert.ok(pubs.includes('app'));
  assert.ok(pubs.includes('form') || pubs.includes('view'), 'entity customizations published');
});

// --- Security personas / roles (Group N P1) ------------------------------------------------
const personaSpec = () => makeSpec({
  personas: [
    { persona: 'Ticket Agent', jobs: [
      { name: 'Work tickets', privileges: [{ entity: 'New_Ticket', access: ['read', 'write', 'create'], scope: 'businessUnit' }] },
      { name: 'See customers', privileges: [{ entity: 'new_customer', access: ['read'] }] },
    ] },
    { persona: 'Dispatcher', appAccess: false, jobs: [
      { name: 'Assign', privileges: [{ entity: 'new_ticket', access: ['read', 'assign'], scope: 'organization' }] },
    ] },
  ],
});

test('personaRoleSpecFor maps jobs + lower-cases entities + injects an organization-scoped appmodule read', () => {
  const spec = personaSpec();
  const mapped = personaRoleSpecFor(spec.personas[0]);
  assert.strictEqual(mapped.persona, 'Ticket Agent');
  assert.strictEqual(mapped.jobs[0].privileges[0].entity, 'new_ticket', 'entity lower-cased to a logical name');
  const app = (mapped.additionalPrivileges || []).find((p) => p.entity === 'appmodule');
  assert.ok(app && app.access.includes('read') && app.scope === 'organization', 'appmodule read injected at org scope');
});

test('personaRoleSpecFor honors appAccess:false — no appmodule read injected', () => {
  const spec = personaSpec();
  const mapped = personaRoleSpecFor(spec.personas[1]); // Dispatcher: appAccess:false
  assert.ok(!(mapped.additionalPrivileges || []).some((p) => p.entity === 'appmodule'), 'no appmodule read for an opted-out persona');
});

test('personaRoleSpecFor trims the persona name (canonical identity matches the SDK + teardown/verify)', () => {
  const mapped = personaRoleSpecFor({ persona: '  Ticket Agent  ', jobs: [{ name: 'w', privileges: [{ entity: 'New_Ticket', access: ['read'] }] }] });
  assert.strictEqual(mapped.persona, 'Ticket Agent');
  assert.strictEqual(mapped.jobs[0].privileges[0].entity, 'new_ticket');
});

test('security phase: appAccess:false DISSOCIATES the app from the role (converges away app access)', async () => {
  const { sdk, calls } = mockSdk();
  await runSdkBuild(personaSpec(), { sdk, apply: true });
  // Ticket Agent (app-access) → associate; Dispatcher (appAccess:false) → dissociate.
  const assoc = find(calls, 'associateRecords');
  const disassoc = find(calls, 'disassociateRecords');
  assert.strictEqual(assoc.length, 1, 'only the app-access persona is associated');
  assert.strictEqual(disassoc.length, 1, 'the opted-out persona is dissociated');
  assert.strictEqual(disassoc[0].args[0], 'appmodule');
  assert.strictEqual(disassoc[0].args[2], 'appmoduleroles_association');
});

test('security phase: a role solution-membership failure FAILS the build (not silently swallowed)', async () => {
  // A role missing from the solution silently breaks export/import, so the phase must fail-closed.
  const { sdk } = mockSdk();
  sdk.addSolutionComponent = async (o) => { if (o.componentType === 20) throw new Error('solution add failed'); };
  await assert.rejects(runSdkBuild(personaSpec(), { sdk, apply: true }), /solution add failed/);
});

test('security phase: a REUSED role is STILL added to the solution (idempotent re-add repairs membership)', async () => {
  const { sdk, calls } = mockSdk({ rolesExist: true });
  await runSdkBuild(personaSpec(), { sdk, apply: true });
  // AddSolutionComponent is idempotent server-side, so membership is re-ensured on every run (a role that
  // missed the add on a prior run — created, add failed, then reused — is repaired here).
  assert.strictEqual(find(calls, 'addSolutionComponent').filter((c) => c.args[0].componentType === 20).length, 2, 'both reused roles re-ensured in the solution');
});

test('security phase: a duplicate app<->role association (realistic 400 + 0x80060891) is swallowed', async () => {
  const { sdk, calls } = mockSdk({ associateDuplicate: true });
  const r = await runSdkBuild(personaSpec(), { sdk, apply: true }); // must NOT throw
  assert.ok(r.created.roles['Ticket Agent']);
  assert.ok(find(calls, 'associateRecords').length >= 1);
});

test('security phase: a NON-duplicate association failure HALTS the build (not mistaken for idempotency)', async () => {
  const { sdk } = mockSdk({ associateFail: true });
  await assert.rejects(runSdkBuild(personaSpec(), { sdk, apply: true }), /bad request|invalid argument/);
});

test('security phase: authors one role per persona, adds each to the solution, associates the app for app-access personas', async () => {
  const { sdk, calls } = mockSdk();
  const r = await runSdkBuild(personaSpec(), { sdk, apply: true });
  assert.strictEqual(find(calls, 'createPersonaRole').length, 2, 'one createPersonaRole per persona');
  assert.ok(r.created.roles['Ticket Agent'] && r.created.roles['Dispatcher'], 'RoleResult captured per persona');
  // Each role is added to the app's solution (componentType 20 = Role).
  assert.strictEqual(find(calls, 'addSolutionComponent').filter((c) => c.args[0].componentType === 20).length, 2);
  // Only the app-access persona (Ticket Agent) is associated to the app module (Dispatcher opted out).
  const assoc = find(calls, 'associateRecords');
  assert.strictEqual(assoc.length, 1, 'only the app-access persona is linked to the app');
  assert.strictEqual(assoc[0].args[0], 'appmodule');
  assert.strictEqual(assoc[0].args[2].relationshipName, 'appmoduleroles_association');
  assert.strictEqual(assoc[0].args[2].targetEntity, 'role');
});

test('security phase: a SEC-1 conflict (foreign same-name role) halts the build fail-closed', async () => {
  const { sdk } = mockSdk({ roleConflict: true });
  await assert.rejects(
    runSdkBuild(personaSpec(), { sdk, apply: true }),
    (e) => e.phase === 'security' && e.code === 'security-role-failed' && /could not be authored/.test(e.message)
  );
});

test('security phase: a duplicate app<->role association on re-run is swallowed as idempotent success', async () => {
  const { sdk, calls } = mockSdk({ associateDuplicate: true });
  const r = await runSdkBuild(personaSpec(), { sdk, apply: true }); // must NOT throw
  assert.ok(r.created.roles['Ticket Agent'], 'role still authored despite the duplicate-association rejection');
  assert.ok(find(calls, 'associateRecords').length >= 1);
});

test('security phase: planFor lists one role item per persona', () => {
  const items = planFor(personaSpec(), {}).filter((i) => i.phase === 'security');
  assert.strictEqual(items.length, 2);
  assert.ok(items.some((i) => i.label.includes('security role "Ticket Agent" (2 jobs)')));
  assert.ok(items.some((i) => i.label.includes('security role "Dispatcher" (1 job)')));
});

test('security phase: a spec with no personas makes no security calls', async () => {
  const { sdk, calls } = mockSdk();
  await runSdkBuild(makeSpec(), { sdk, apply: true });
  assert.strictEqual(find(calls, 'createPersonaRole').length, 0);
  assert.strictEqual(find(calls, 'associateRecords').length, 0);
});

test('resolvePhases honors only/skip/from/to', () => {
  assert.deepStrictEqual(resolvePhases({ only: ['views', 'charts'] }), ['views', 'charts']);
  assert.deepStrictEqual(resolvePhases({ skip: ['data-model', 'sample-data', 'publish'] }), ['solution', 'web-resources', 'views', 'charts', 'forms', 'business-rules', 'commands', 'dashboards', 'app-shell', 'pages', 'ai-features', 'security']);
  assert.deepStrictEqual(resolvePhases({ from: 'views' }), ['views', 'charts', 'forms', 'business-rules', 'commands', 'dashboards', 'app-shell', 'pages', 'ai-features', 'security', 'publish']);
  assert.deepStrictEqual(resolvePhases({ to: 'data-model' }), ['solution', 'data-model']);
});

test('phase selection: --only views,charts,forms,app-shell skips the data model', async () => {
  const { sdk, calls } = mockSdk();
  await runSdkBuild(makeSpec(), { sdk, apply: true, phases: resolvePhases({ only: ['views', 'charts', 'forms', 'app-shell'] }) });
  assert.strictEqual(find(calls, 'createTable').length, 0);
  assert.strictEqual(find(calls, 'createSolution').length, 0);
  assert.ok(find(calls, 'createArtifact').length >= 4, 'artifacts still built');
});

test('an SDK failure halts with a BuildHalt carrying the phase', async () => {
  const { sdk } = mockSdk({ failTable: 'new_customer' });
  await assert.rejects(
    () => runSdkBuild(makeSpec(), { sdk, apply: true }),
    (err) => { assert.strictEqual(err.name, 'BuildHalt'); assert.strictEqual(err.phase, 'data-model'); return true; }
  );
});

test('planFor reflects the selected phases', () => {
  const labels = planFor(makeSpec(), { sampleData: true, publish: true, phases: PHASES }).map((p) => p.label);
  assert.ok(labels.some((l) => l.includes('table new_customer')));
  assert.ok(labels.some((l) => l.includes('form for new_customer (sub-grids: new_ticket)')));
  const onlyViews = planFor(makeSpec(), { phases: ['views'] }).map((p) => p.phase);
  assert.ok(onlyViews.every((p) => p === 'views'));
});

test('planFor lists the generated app-icon step by default, but omits it when app.icon is set', () => {
  const gen = planFor(makeSpec(), { phases: PHASES }).map((p) => p.label);
  assert.ok(gen.some((l) => /app icon \(generated\)/.test(l)), 'default plan generates an app icon');
  const withIcon = planFor(makeSpec({ app: { name: 'Support Desk', description: 'x', icon: 'new_appicon' }, webResources: [{ name: 'new_appicon', type: 'png', contentBase64: 'AAAA' }] }), { phases: PHASES }).map((p) => p.label);
  assert.ok(!withIcon.some((l) => /app icon \(generated\)/.test(l)), 'no generated icon step when app.icon is supplied');
});

test('ai-features phase enables app features and configures summaries for candidate tables', async () => {
  const spec = makeSpec({ ai: { appFeatures: { formFill: true }, summaries: { default: 'auto' } } });
  const { sdk, calls } = mockSdk();
  const result = await runSdkBuild(spec, { sdk, apply: true, phases: ['ai-features'] });
  assert.strictEqual(find(calls, 'setAppAiFeatures').length, 1, 'setAppAiFeatures called once');
  assert.ok(find(calls, 'configureRowSummary').length >= 1, 'configureRowSummary called for candidate table(s)');
  const featureCall = find(calls, 'setAppAiFeatures')[0];
  assert.ok(featureCall.args[0].includes('support'), 'app unique name derived from spec (contains app name slug)');
  assert.strictEqual(featureCall.args[1].formFill, true, 'formFill flag merged from spec.ai.appFeatures');
  assert.ok(result.created.ai && result.created.ai.appFeatures, 'appFeatures populated on result');
  assert.ok(result.created.ai.summaries && Object.keys(result.created.ai.summaries).length >= 1, 'summaries populated on result');
});

test('ai-features phase: summaries.default=off skips all row-summary calls', async () => {
  const spec = makeSpec({ ai: { summaries: { default: 'off' } } });
  const { sdk, calls } = mockSdk();
  await runSdkBuild(spec, { sdk, apply: true, phases: ['ai-features'] });
  assert.strictEqual(find(calls, 'setAppAiFeatures').length, 1, 'app features still enabled');
  assert.strictEqual(find(calls, 'configureRowSummary').length, 0, 'no row summaries when default is off');
});

test('ai-features phase: spec without spec.ai is a no-op', async () => {
  const { sdk, calls } = mockSdk();
  await runSdkBuild(makeSpec(), { sdk, apply: true, phases: ['ai-features'] });
  assert.strictEqual(find(calls, 'setAppAiFeatures').length, 0, 'setAppAiFeatures not called without spec.ai');
  assert.strictEqual(find(calls, 'configureRowSummary').length, 0, 'configureRowSummary not called without spec.ai');
});

// ── AI app-feature non-success buckets (ADO 6603383) ───────────────────────────────────────────
// `setAppAiFeatures` reports FIVE buckets and `applied` is the ONLY success one. The build must
// surface every non-success bucket: silently dropping one reproduces the false PASS this fix exists
// to remove (a feature the platform never stored being reported as a clean build). `unverified` and
// `failed` were added by a later SDK revision, so this pins that they are surfaced too — not just
// the original `notPersisted`.
const aiProblemSpec = () => makeSpec({ ai: { appFeatures: { formFill: true }, summaries: { default: 'off' } } });
const withAiResult = (result) => {
  const { sdk, calls } = mockSdk();
  sdk.setAppAiFeatures = async (appUnique, flags, opts) => { calls.push({ name: 'setAppAiFeatures', args: [appUnique, flags, opts] }); return result; };
  return { sdk, calls };
};

test('ai-features phase: notPersisted / unverified / failed are each surfaced as a warning event', async () => {
  const { sdk } = withAiResult({
    applied: ['nlChart'], skipped: ['m365'],
    notPersisted: ['formFill'], unverified: ['nlSearch'], failed: ['other'],
    outcomes: [],
  });
  const events = [];
  await runSdkBuild(aiProblemSpec(), { sdk, apply: true, phases: ['ai-features'], emit: (e) => events.push(e) });
  const warnings = events.filter((e) => e.phase === 'ai-features' && e.status === 'skip');
  assert.ok(warnings.some((e) => /NOT PERSISTED: formFill/.test(e.label)), 'notPersisted surfaced');
  assert.ok(warnings.some((e) => /UNVERIFIED: nlSearch/.test(e.label)), 'unverified surfaced');
  assert.ok(warnings.some((e) => /FAILED: other/.test(e.label)), 'failed surfaced');
});

test('ai-features phase: an all-applied result emits no warning events', async () => {
  const { sdk } = withAiResult({ applied: ['formFill'], skipped: [], notPersisted: [], unverified: [], failed: [], outcomes: [] });
  const events = [];
  await runSdkBuild(aiProblemSpec(), { sdk, apply: true, phases: ['ai-features'], emit: (e) => events.push(e) });
  assert.strictEqual(events.filter((e) => e.phase === 'ai-features' && e.status === 'skip').length, 0);
});

test('ai-features phase: a result missing the newer buckets does not throw (older SDK shape)', async () => {
  // The vendored bundle and the plugin are versioned together, but a partial result must degrade to
  // "nothing to warn about" rather than crash the whole build on a missing array.
  const { sdk } = withAiResult({ applied: ['formFill'], skipped: [] });
  const events = [];
  await runSdkBuild(aiProblemSpec(), { sdk, apply: true, phases: ['ai-features'], emit: (e) => events.push(e) });
  assert.strictEqual(events.filter((e) => e.phase === 'ai-features' && e.status === 'error').length, 0, 'no error events');
});

test('ai-features phase: passes a raised verify budget so a fresh app module is not falsely reported', async () => {
  // Regression guard for a live false `notPersisted`: this phase runs moments after app-shell CREATED
  // the app module, and the SDK's default budget (4 attempts / 500ms linear ~= 3s) expired before the
  // appsettings override row became queryable -- a build of a brand-new app reported notPersisted for
  // every feature while the rows demonstrably existed seconds later.
  const spec = makeSpec({ ai: { appFeatures: { formFill: true }, summaries: { default: 'off' } } });
  const { sdk, calls } = mockSdk();
  await runSdkBuild(spec, { sdk, apply: true, phases: ['ai-features'] });
  const opts = find(calls, 'setAppAiFeatures')[0].args[2];
  assert.ok(opts.verifyAttempts > 4, `expected a raised attempt budget, got ${opts.verifyAttempts}`);
  assert.ok(opts.verifyDelayMs >= 1000, `expected a raised backoff, got ${opts.verifyDelayMs}`);
  // The solution scope must survive alongside the new knobs.
  assert.ok(opts.solutionUniqueName, 'solutionUniqueName still passed');
});

test('ai-features phase: passes the appmoduleid it just created so the write is provable PRE-publish', async () => {
  // A freshly created appmodule is not readable until it is PUBLISHED, so the SDK's by-NAME lookup
  // (the only piece of verification that needs it) fails here and every feature lands `unverified`.
  // The build already holds the id from app-shell, so it must hand it over rather than make the SDK
  // guess. Run BOTH phases so app-shell populates result.created.app first.
  const spec = makeSpec({ ai: { appFeatures: { formFill: true }, summaries: { default: 'off' } } });
  const { sdk, calls } = mockSdk();
  const result = await runSdkBuild(spec, { sdk, apply: true, phases: ['app-shell', 'ai-features'] });
  const opts = find(calls, 'setAppAiFeatures')[0].args[2];
  assert.ok(result.created.app, 'app-shell produced an app id');
  assert.strictEqual(opts.appModuleId, result.created.app, 'the created app id must be passed through');
});

test('ai-features phase: omits appModuleId when the app was not created in this run', async () => {
  // A partial run (--from ai-features) has no app id. Passing `null` would be rejected by the SDK's
  // GUID validation and fail the whole phase, so it must be omitted and the SDK left to resolve by
  // name — which works, because an app that predates this run is published and therefore readable.
  const spec = makeSpec({ ai: { appFeatures: { formFill: true }, summaries: { default: 'off' } } });
  const { sdk, calls } = mockSdk();
  await runSdkBuild(spec, { sdk, apply: true, phases: ['ai-features'] });
  const opts = find(calls, 'setAppAiFeatures')[0].args[2];
  assert.strictEqual(opts.appModuleId, undefined, 'no app id in this run means the option is absent, not null');
});

test('ai-features phase: the post-publish retry FETCHES and PUBLISHES the app before re-writing', async () => {
  // The exact sequence measured to work live, in order. Publishing without first fetching the app,
  // or writing without publishing, both left the override rows absent — so the ordering is the fix,
  // not an incidental detail.
  const spec = makeSpec({ ai: { appFeatures: { formFill: true }, summaries: { default: 'off' } } });
  const { sdk, calls } = mockSdk();
  let call = 0;
  sdk.setAppAiFeatures = async (appUnique, flags, opts) => {
    calls.push({ name: 'setAppAiFeatures', args: [appUnique, flags, opts] });
    call += 1;
    return call === 1
      ? { applied: [], skipped: [], notPersisted: ['formFill'], unverified: [], failed: [], outcomes: [] }
      : { applied: ['formFill'], skipped: [], notPersisted: [], unverified: [], failed: [], outcomes: [] };
  };
  const result = await runSdkBuild(spec, { sdk, apply: true, phases: ['app-shell', 'ai-features'] });
  const idxOf = (pred) => calls.findIndex(pred);
  const firstWrite = idxOf((c) => c.name === 'setAppAiFeatures');
  const fetchIdx = calls.findIndex((c, i) => i > firstWrite && c.name === 'fetchArtifact' && c.args[0] === 'app');
  const pubIdx = calls.findIndex((c, i) => i > firstWrite && c.name === 'publishArtifact' && c.args[0] === 'app');
  const retryIdx = calls.findIndex((c, i) => i > firstWrite && c.name === 'setAppAiFeatures');
  assert.ok(fetchIdx > -1, 'the app is re-fetched before the retry');
  assert.ok(pubIdx > fetchIdx, 'the publish follows the fetch');
  assert.ok(retryIdx > pubIdx, 'the retry write follows the publish');
  assert.strictEqual(calls[pubIdx].args[1], result.created.app, 'the app built in this run is the one published');
});

test('ai-features phase: a failing post-publish retry leaves the original verdict standing', async () => {
  // Best-effort: a throw during the fetch/publish/retry must not fail the build. The original
  // non-success verdict simply stands and is reported.
  const spec = makeSpec({ ai: { appFeatures: { formFill: true }, summaries: { default: 'off' } } });
  const { sdk, calls } = mockSdk();
  sdk.setAppAiFeatures = async (appUnique, flags, opts) => {
    calls.push({ name: 'setAppAiFeatures', args: [appUnique, flags, opts] });
    return { applied: [], skipped: [], notPersisted: ['formFill'], unverified: [], failed: [], outcomes: [] };
  };
  sdk.publishArtifact = async (type, id) => { calls.push({ name: 'publishArtifact', args: [type, id] }); throw new Error('publish is throttled'); };
  const events = [];
  const result = await runSdkBuild(spec, { sdk, apply: true, phases: ['app-shell', 'ai-features'], emit: (e) => events.push(e) });
  assert.ok(result.ok, 'the build still completes');
  assert.ok(
    events.some((e) => e.phase === 'ai-features' && e.status === 'skip' && /NOT PERSISTED: formFill/.test(e.label)),
    'the unapplied feature is still reported'
  );
});

test('ai-features phase: RE-ISSUES the write after publish for anything that did not apply', async () => {
  // LIVE-MEASURED, on two different apps, changing only this variable: a write issued while the app
  // is freshly created returns `notPersisted` and a direct `appsettings` query shows NO override row
  // at all — the write itself is a no-op, not a slow read. Fetching + publishing that same app and
  // re-issuing the IDENTICAL call produced all four `applied` and four real rows. Merely re-PROVING
  // after publish therefore cannot fix it (there is nothing to find); the write must be re-issued.
  const spec = makeSpec({ ai: { appFeatures: { formFill: true }, summaries: { default: 'off' } } });
  const { sdk, calls } = mockSdk();
  let call = 0;
  sdk.setAppAiFeatures = async (appUnique, flags, opts) => {
    calls.push({ name: 'setAppAiFeatures', args: [appUnique, flags, opts] });
    // First (pre-publish) write no-ops the way the platform does; the retry after publish lands.
    call += 1;
    return call === 1
      ? { applied: [], skipped: [], notPersisted: ['formFill'], unverified: [], failed: [], outcomes: [{ feature: 'formFill', status: 'notPersisted', reason: 'no override observed' }] }
      : { applied: ['formFill'], skipped: [], notPersisted: [], unverified: [], failed: [], outcomes: [{ feature: 'formFill', status: 'applied', appOverrideExists: true }] };
  };
  const events = [];
  const result = await runSdkBuild(spec, { sdk, apply: true, phases: ['app-shell', 'ai-features'], emit: (e) => events.push(e) });
  const writes = find(calls, 'setAppAiFeatures');
  assert.strictEqual(writes.length, 2, `expected a post-publish retry write, got ${writes.length}`);
  // The retry must be scoped to the features that did NOT apply — re-writing an applied feature is
  // needless churn against a rate-limited settings API.
  assert.deepStrictEqual(Object.keys(writes[1].args[1]), ['formFill'], 'the retry targets only the unapplied features');
  const af = result.created.ai.appFeatures;
  assert.deepStrictEqual(af.applied, ['formFill'], 'the corrected verdict is reflected in the result');
  assert.deepStrictEqual(af.notPersisted, [], 'the stale non-success bucket is cleared');
  assert.strictEqual(events.filter((e) => e.phase === 'ai-features' && e.status === 'skip').length, 0, 'no warning once the retry succeeds');
});

test('ai-features phase: a retry that still fails is reported honestly, not swallowed', async () => {
  const spec = makeSpec({ ai: { appFeatures: { formFill: true }, summaries: { default: 'off' } } });
  const { sdk, calls } = mockSdk();
  sdk.setAppAiFeatures = async (appUnique, flags, opts) => {
    calls.push({ name: 'setAppAiFeatures', args: [appUnique, flags, opts] });
    return { applied: [], skipped: [], notPersisted: ['formFill'], unverified: [], failed: [], outcomes: [{ feature: 'formFill', status: 'notPersisted', reason: 'no override observed' }] };
  };
  const events = [];
  await runSdkBuild(spec, { sdk, apply: true, phases: ['app-shell', 'ai-features'], emit: (e) => events.push(e) });
  const warnings = events.filter((e) => e.phase === 'ai-features' && e.status === 'skip');
  assert.ok(warnings.some((e) => /NOT PERSISTED: formFill/.test(e.label)), 'a genuinely failing feature still warns');
});

test('ai-features phase: the recovery reason names the path that actually recovered the feature', async () => {
  // Two recovery paths land in the same bucket: the post-publish RE-ISSUE, and the override-row
  // PROOF. Reporting "applied by the re-issue" for something the proof merely found would be the
  // same report-what-you-did-not-verify failure this phase exists to remove.
  const spec = makeSpec({ ai: { appFeatures: { formFill: true }, summaries: { default: 'off' } } });
  const { sdk, calls } = mockSdk();
  // The retry never applies anything, so recovery can only come from the proof path.
  sdk.setAppAiFeatures = async (appUnique, flags, opts) => {
    calls.push({ name: 'setAppAiFeatures', args: [appUnique, flags, opts] });
    return { applied: [], skipped: [], notPersisted: ['formFill'], unverified: [], failed: [], outcomes: [{ feature: 'formFill', status: 'notPersisted' }] };
  };
  // ...but the override row IS present, so the proof recovers it.
  sdk.queryRecords = async (logical) => {
    if (logical === 'appmodule') return [{ appmoduleid: 'app-guid' }];
    if (logical === 'settingdefinition') return [{ settingdefinitionid: 'def-guid' }];
    if (logical === 'appsetting') return [{ value: '1' }];
    return [];
  };
  const result = await runSdkBuild(spec, { sdk, apply: true, phases: ['app-shell', 'ai-features'] });
  const outcome = (result.created.ai.appFeatures.outcomes || []).find((o) => o.feature === 'formFill');
  assert.strictEqual(outcome.status, 'applied');
  assert.match(outcome.reason, /override-row proof/, `the proof path must not claim the re-issue applied it: ${outcome.reason}`);
});

test('ai-features phase: a not-persisted warning carries a real sequential step index, not `total`', async () => {
  // Regression guard for a reviewed defect: this warning was once emitted by hand with
  // `n: runner.total`, so the CLI printed `[total/total]` for it and the progress counter jumped.
  // `runner.skip` shares the same monotonic counter as `runner.run`, which is why the warning must
  // go through it rather than a bespoke emit.
  const spec = makeSpec({ ai: { appFeatures: { formFill: true }, summaries: { default: 'off' } } });
  const { sdk, calls } = mockSdk();
  sdk.setAppAiFeatures = async (appUnique, flags, opts) => {
    calls.push({ name: 'setAppAiFeatures', args: [appUnique, flags, opts] });
    return { applied: [], skipped: [], notPersisted: ['formFill'], unverified: [], failed: [], outcomes: [] };
  };
  const events = [];
  await runSdkBuild(spec, { sdk, apply: true, phases: ['app-shell', 'ai-features'], emit: (e) => events.push(e) });
  const warn = events.find((e) => e.phase === 'ai-features' && e.status === 'skip' && /NOT PERSISTED/.test(e.label));
  assert.ok(warn, 'the warning is emitted');
  assert.ok(Number.isInteger(warn.n) && warn.n > 0, `step index must be a real number, got ${warn.n}`);
  // Every terminal event shares one counter, so the warning's index must be strictly greater than
  // the step before it — the exact property a hard-coded `total` destroys.
  const terminal = events.filter((e) => e.status === 'ok' || e.status === 'skip' || e.status === 'error');
  const idx = terminal.indexOf(warn);
  assert.ok(idx > 0, 'the warning is not the first terminal event');
  assert.strictEqual(warn.n, terminal[idx - 1].n + 1, `expected a sequential index, got ${terminal[idx - 1].n} -> ${warn.n}`);
});

test('ai-features phase: a bucket the plugin does not know about is still reported, not dropped', async () => {
  // The buckets are derived from the RESULT, not a fixed list: a non-success bucket added by a
  // future SDK revision must surface verbatim rather than vanish, which is the very bug class this
  // phase exists to remove. (A fixed three-key table silently dropped anything new.)
  const { sdk } = withAiResult({ applied: [], skipped: [], notPersisted: [], unverified: [], failed: [], rejected: ['formFill'], outcomes: [] });
  const events = [];
  await runSdkBuild(aiProblemSpec(), { sdk, apply: true, phases: ['ai-features'], emit: (e) => events.push(e) });
  const warnings = events.filter((e) => e.phase === 'ai-features' && e.status === 'skip');
  assert.ok(warnings.some((e) => /REJECTED: formFill/.test(e.label)), `unknown bucket not surfaced: ${JSON.stringify(warnings.map((w) => w.label))}`);
});

test('ai-features phase: a feature the SDK mis-reports is RE-PROVEN against the override row', async () => {
  // Live-driven: the SDK's build-time proof returns `notPersisted` with appOverrideExists:false for
  // a fresh build while `appsettings` demonstrably holds every requested value (re-running it
  // out-of-band reports all four applied). Printing that as NOT PERSISTED is a false alarm that
  // also contradicts --verify, which proves the same rows and passes. So anything not in `applied`
  // is re-proved here against the identical oracle the verifier uses.
  const { sdk } = withAiResult({ applied: [], skipped: [], notPersisted: ['formFill'], unverified: [], failed: [], outcomes: [{ feature: 'formFill', status: 'notPersisted', reason: 'no override observed' }] });
  sdk.queryRecords = async (set) => {
    if (set === 'appmodule') return [{ appmoduleid: 'APPID' }];
    if (set === 'settingdefinition') return [{ settingdefinitionid: 'DEFID' }];
    if (set === 'appsetting') return [{ value: '1' }]; // the row IS there
    return [];
  };
  const events = [];
  const r = await runSdkBuild(aiProblemSpec(), { sdk, apply: true, phases: ['ai-features'], emit: (e) => events.push(e) });
  assert.strictEqual(events.filter((e) => e.phase === 'ai-features' && e.status === 'skip').length, 0, 'no false NOT PERSISTED warning');
  assert.ok(r.ok, 'build still succeeds');
});

test('ai-features phase: re-proving does NOT mask a feature that genuinely did not persist', async () => {
  // The re-confirmation must only ever UPGRADE a proven feature. When the override row really is
  // absent the warning has to survive, or the fix would reinstate the false PASS.
  const { sdk } = withAiResult({ applied: [], skipped: [], notPersisted: ['formFill'], unverified: [], failed: [], outcomes: [{ feature: 'formFill', status: 'notPersisted', reason: 'no override observed for FormFillBarUXEnabled' }] });
  sdk.queryRecords = async (set) => {
    if (set === 'appmodule') return [{ appmoduleid: 'APPID' }];
    if (set === 'settingdefinition') return [{ settingdefinitionid: 'DEFID' }];
    return []; // no override row
  };
  const events = [];
  await runSdkBuild(aiProblemSpec(), { sdk, apply: true, phases: ['ai-features'], emit: (e) => events.push(e) });
  const warn = events.find((e) => e.phase === 'ai-features' && e.status === 'skip');
  assert.ok(warn, 'a genuinely unpersisted feature must still warn');
  // ...and it must carry the SDK's OWN reason, not a canned bucket description.
  assert.match(warn.label, /no override observed for FormFillBarUXEnabled/);
});

test('ai-features phase: an override holding the WRONG value is not treated as proven', async () => {
  const { sdk } = withAiResult({ applied: [], skipped: [], notPersisted: ['formFill'], unverified: [], failed: [], outcomes: [] });
  sdk.queryRecords = async (set) => {
    if (set === 'appmodule') return [{ appmoduleid: 'APPID' }];
    if (set === 'settingdefinition') return [{ settingdefinitionid: 'DEFID' }];
    if (set === 'appsetting') return [{ value: '0' }]; // requested true -> '1'
    return [];
  };
  const events = [];
  await runSdkBuild(aiProblemSpec(), { sdk, apply: true, phases: ['ai-features'], emit: (e) => events.push(e) });
  assert.ok(events.some((e) => e.phase === 'ai-features' && e.status === 'skip'), 'a wrong-valued override must still warn');
});

test('ai-features planFor: spec.ai adds enable + per-table summary plan entries', () => {
  const spec = makeSpec({ ai: { appFeatures: { formFill: true }, summaries: { default: 'auto' } } });
  const items = planFor(spec, { phases: ['ai-features'] });
  assert.ok(items.some((i) => i.phase === 'ai-features' && i.label === 'enable app AI features'));
  assert.ok(items.some((i) => i.phase === 'ai-features' && /row summary for/.test(i.label)));
});

test('ai-features planFor: summaries.default=off suppresses per-table summary plan entries', () => {
  const spec = makeSpec({ ai: { summaries: { default: 'off' } } });
  const items = planFor(spec, { phases: ['ai-features'] });
  assert.ok(items.some((i) => i.label === 'enable app AI features'));
  assert.ok(!items.some((i) => /row summary for/.test(i.label)));
});

test('dashboardTileOpts id-passthrough: a tile carrying viewId/visualizationId + entity binds to existing ids (round-tripped dashboard)', () => {
  const spec = { views: [], charts: [] };
  const result = { created: { views: {}, charts: {} } };
  const chart = dashboardTileOpts(spec, { type: 'chart', name: 'By Status', entity: 'New_OhProject', viewId: 'v-1', visualizationId: 'c-1' }, result);
  assert.strictEqual(chart.type, 'chart');
  assert.strictEqual(chart.targetEntity, 'new_ohproject');
  assert.strictEqual(chart.viewId, 'v-1');
  assert.strictEqual(chart.visualizationId, 'c-1');
  const list = dashboardTileOpts(spec, { type: 'list', name: 'Active', entity: 'new_ohproject', viewId: 'v-1' }, result);
  assert.strictEqual(list.type, 'list');
  assert.strictEqual(list.viewId, 'v-1');
});

test('dashboardTileOpts name-based still resolves from result.created (author-declared dashboard)', () => {
  const spec = { views: [{ name: 'V', entity: 'new_ohproject' }], charts: [{ name: 'C', entity: 'new_ohproject' }] };
  const result = { created: { views: { 'new_ohproject|V': 'view-id' }, charts: { C: 'chart-id' } } };
  const chart = dashboardTileOpts(spec, { type: 'chart', chart: 'C', view: 'V' }, result);
  assert.strictEqual(chart.viewId, 'view-id');
  assert.strictEqual(chart.visualizationId, 'chart-id');
  assert.strictEqual(chart.targetEntity, 'new_ohproject');
});

test('dashboardTileOpts keys created.views by entity|name so same-named views across entities do not cross-wire', () => {
  // Two entities each own a view named "Active" — a name-only key would bind BOTH tiles to whichever
  // view id was created last. With entity|name keying each tile binds its own entity's view.
  const spec = { views: [{ name: 'Active', entity: 'new_a' }, { name: 'Active', entity: 'new_b' }], charts: [] };
  const result = { created: { views: { 'new_a|Active': 'view-a', 'new_b|Active': 'view-b' }, charts: {} } };
  const listA = dashboardTileOpts(spec, { type: 'list', view: 'Active', entity: 'new_a' }, result);
  assert.strictEqual(listA.viewId, 'view-a', 'new_a tile binds the new_a Active view');
  const listB = dashboardTileOpts(spec, { type: 'list', view: 'Active', entity: 'new_b' }, result);
  assert.strictEqual(listB.viewId, 'view-b', 'new_b tile binds the new_b Active view');
});

test('pages phase (v2, page key != name): result.created.pages is keyed by KEY so the sitemap finalize resolves', async () => {
  const spec = makeSpec();
  spec.schemaVersion = 2;
  spec.pages = [{ key: 'overview', name: 'Overview', source: { kind: 'tsx', codeFile: 'o.tsx' } }];
  spec.appShell.areas[0].groups[0].subAreas.push({ page: 'overview', title: 'Overview' });
  const appDir = stagePages(spec.pages);
  try {
    const { sdk, calls } = mockSdk();
    const genpageCli = { enumerateEnv: async () => ({ ok: true, ids: [], pages: [] }), upload: async () => ({ pageId: 'gp-1' }) };
    await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'] });
    const setDef = find(calls, 'updateElement').find((c) => c.args[2] === '/siteMap');
    assert.ok(setDef.args[3].areas[0].groups[0].subAreas.some((s) => s.type === 'GenPage' && s.genPageId === 'gp-1'), 'GenPage subarea resolved by KEY (was unresolved when keyed by name)');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('pages phase persists the manifest on a SINGLE-page first build (one create, type js, add-to-solution, ZERO update)', async () => {
  const spec = makeSpec();
  spec.pages = [{ name: 'Overview', codeFile: 'o.tsx' }];
  const appDir = stagePages(spec.pages);
  try {
    const { sdk, calls } = mockSdk();
    const genpageCli = { enumerateEnv: async () => ({ ok: true, ids: [], pages: [] }), upload: async () => ({ pageId: 'gp-1' }) };
    await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'] });
    const created = find(calls, 'createWebResource').map((c) => c.args[0]).find((o) => /_pagemanifest$/.test(o.name));
    assert.strictEqual(created.type, 'js');
    assert.deepStrictEqual(JSON.parse(created.content).pages[0], { key: 'Overview', name: 'Overview', pageId: 'gp-1' });
    assert.strictEqual(find(calls, 'updateWebResource').length, 0, 'one create writes the final content; the final persist is deduped → ZERO updates (I6)');
    assert.ok(find(calls, 'addSolutionComponent').some((c) => c.args[0].componentType === 61), 'manifest added to the solution');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('pages phase persists the manifest per-create on a MULTI-page first build (one create + one update, I6)', async () => {
  const spec = makeSpec();
  spec.pages = [{ name: 'Overview', codeFile: 'o.tsx' }, { name: 'Detail', codeFile: 'd.tsx' }];
  const appDir = stagePages(spec.pages);
  try {
    const { sdk, calls } = mockSdk();
    const genpageCli = { enumerateEnv: async () => ({ ok: true, ids: [], pages: [] }), upload: async (o) => ({ pageId: o.name === 'Detail' ? 'gp-d' : 'gp-o' }) };
    await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'] });
    assert.strictEqual(find(calls, 'createWebResource').filter((c) => /_pagemanifest$/.test(c.args[0].name)).length, 1, 'manifest created once (first mint)');
    assert.strictEqual(find(calls, 'updateWebResource').length, 1, 'the second mint UPDATES the manifest in place (immediate persist-after-each-create)');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('pages phase updates the manifest IN PLACE on a rebuild whose page ids changed (no dup create)', async () => {
  const spec = makeSpec();
  spec.schemaVersion = 2;
  spec.pages = [{ key: 'overview', name: 'Overview', source: { kind: 'tsx', codeFile: 'o.tsx' } }, { key: 'detail', name: 'Detail', source: { kind: 'tsx', codeFile: 'd.tsx' } }];
  const appUnique = appUniqueName(spec);
  const appDir = stagePages(spec.pages);
  try {
    const OV = 'a11c9d20-0000-4000-8000-0000000000a1';
    // overview is manifested + live (env + this app's sitemap) → UPDATE; detail is new (absent → CREATE).
    const existing = Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: OV }] }), 'utf8').toString('base64');
    const sm = `<SiteMap><Area><Group><SubArea GenPageId="${OV}"/></Group></Area></SiteMap>`;
    const { sdk, calls } = mockSdk({ pageManifest: existing, manifestId: 'wr-manifest', selfAppUnique: appUnique, liveSitemapXml: sm });
    const genpageCli = { enumerateEnv: async () => ({ ok: true, ids: [OV], pages: [{ pageId: OV, name: 'Overview' }] }), upload: async (o) => ({ pageId: o.pageId || 'a22c9d20-0000-4000-8000-0000000000d2' }) };
    await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'] });
    assert.ok(!find(calls, 'createWebResource').some((c) => /_pagemanifest$/.test(c.args[0].name)), 'manifest not re-created on rebuild');
    assert.ok(find(calls, 'updateWebResource').some((c) => c.args[0] === 'wr-manifest'), 'manifest updated in place');
    assert.ok(find(calls, 'addSolutionComponent').some((c) => c.args[0].componentType === 61), 'solution membership re-asserted every run');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('pages phase HALTS fail-closed when EXISTENCE enumeration fails — never treats it as empty, uploads nothing', async () => {
  const spec = makeSpec();
  spec.pages = [{ name: 'Overview', codeFile: 'o.tsx' }];
  const appDir = stagePages(spec.pages);
  try {
    const { sdk } = mockSdk();
    let uploaded = 0;
    // enumerateEnv is env-wide EXISTENCE (Task 2). A failed listing must HALT — never collapse to "no pages".
    const genpageCli = { enumerateEnv: async () => ({ ok: false, ids: [], error: 'auth expired' }), upload: async () => { uploaded += 1; return { pageId: 'gp-1' }; } };
    await assert.rejects(
      runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'] }),
      (e) => e && e.phase === 'pages' && e.code === 'pages-existence-failed'
    );
    assert.strictEqual(uploaded, 0);
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('pages phase HALTS when the app id is absent (I1 recovery guard — do NOT resume from --from pages)', async () => {
  const spec = makeSpec();
  spec.pages = [{ name: 'Overview', codeFile: 'o.tsx' }];
  const appDir = stagePages(spec.pages);
  try {
    const { sdk } = mockSdk();
    const genpageCli = { enumerateEnv: async () => ({ ok: true, ids: [], pages: [] }), upload: async () => ({ pageId: 'gp-1' }) };
    await assert.rejects(
      runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: ['pages'] }),
      (e) => e && e.phase === 'pages' && e.code === 'pages-requires-app'
    );
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('planFor emits one step per page + a manifest step (alignment)', () => {
  const spec = makeSpec();
  spec.pages = [{ name: 'Overview', codeFile: 'o.tsx' }, { name: 'Detail', codeFile: 'd.tsx' }];
  const labels = planFor(spec, { phases: PHASES }).map((p) => p.label);
  assert.strictEqual(labels.filter((l) => /^page "/.test(l)).length, 2, 'one step per page');
  assert.ok(labels.includes(`page manifest ${appUniqueName(spec)}_pagemanifest`), 'plan lists the manifest step');
});

// A prior deployed sitemap that ALREADY carries a GenPage subarea (the previous good deployment).
const PRIOR_SITEMAP = { areas: [{ title: 'Main', groups: [{ title: 'Pages', subAreas: [{ type: 'GenPage', genPageId: 'gp-prev', title: 'Overview' }] }] }] };
const hasGenPage = (sm, id) => (sm.areas || []).some((a) => (a.groups || []).some((g) => (g.subAreas || []).some((s) => s.type === 'GenPage' && s.genPageId === id)));

test('C2: an EXISTING page-backed app does NOT push its sitemap in app-shell — an enumeration failure PRESERVES the prior sitemap', async () => {
  const spec = makeSpec();
  spec.schemaVersion = 2;
  spec.pages = [{ key: 'overview', name: 'Overview', source: { kind: 'tsx', codeFile: 'o.tsx' } }];
  spec.appShell.areas[0].groups[0].subAreas.push({ page: 'overview', title: 'Overview' });
  const appDir = stagePages(spec.pages);
  try {
    const { sdk, calls } = mockSdk({ artifactsExist: true, existingSitemap: PRIOR_SITEMAP });
    const genpageCli = { enumerateEnv: async () => ({ ok: false, ids: [], error: 'boom' }), upload: async () => ({ pageId: 'gp-1' }) };
    await assert.rejects(
      runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'] }),
      (e) => e && e.code === 'pages-existence-failed'
    );
    assert.ok(!find(calls, 'updateElement').some((c) => c.args[2] === '/siteMap'), 'NO sitemap write in app-shell (deferred) and the finalizer was never reached');
    const deployed = await sdk.fetchArtifact('app', 'app-existing');
    assert.ok(hasGenPage(deployed.siteMap, 'gp-prev'), 'the PRIOR deployed sitemap (gp-prev) is intact — nav was not stripped');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('C2: an EXISTING page-backed app writes its sitemap ONCE, in the finalizer, with GenPage subareas resolved', async () => {
  const spec = makeSpec();
  spec.schemaVersion = 2;
  spec.pages = [{ key: 'overview', name: 'Overview', source: { kind: 'tsx', codeFile: 'o.tsx' } }];
  spec.appShell.areas[0].groups[0].subAreas.push({ page: 'overview', title: 'Overview' });
  const appDir = stagePages(spec.pages);
  try {
    const { sdk, calls } = mockSdk({ artifactsExist: true, existingSitemap: PRIOR_SITEMAP });
    const genpageCli = { enumerateEnv: async () => ({ ok: true, ids: [], pages: [] }), upload: async () => ({ pageId: 'gp-1' }) };
    await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'] });
    const sitemapWrites = find(calls, 'updateElement').filter((c) => c.args[2] === '/siteMap');
    assert.strictEqual(sitemapWrites.length, 1, 'exactly one sitemap write — the finalizer');
    assert.ok(sitemapWrites[0].args[3].areas[0].groups[0].subAreas.some((s) => s.type === 'GenPage' && s.genPageId === 'gp-1'));
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('C2: an EXISTING app with NO page subareas still pushes its sitemap in app-shell (unchanged behavior)', async () => {
  const spec = makeSpec(); // entity subarea only, no pages
  const { sdk, calls } = mockSdk({ artifactsExist: true, existingSitemap: PRIOR_SITEMAP });
  await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir: process.cwd(), phases: ['solution', 'data-model', 'app-shell'] });
  assert.ok(find(calls, 'updateElement').some((c) => c.args[2] === '/siteMap'), 'a no-page existing app keeps pushing its sitemap in app-shell');
});

// ── Plan 5 three-authority safety gates: existence-driven crash-safety (C1), discriminated reads,
//    destructive-removal (Imp6) and cross-app shared-page (Imp5) HALTs. Real GUIDs (Imp9). ─────────────
const GP_O = '13ecbc57-a3a4-4132-b0a2-a6c6b12691e8';
const GP_D = '5c0a4889-45fd-46ea-91a8-ff876914d644';
const overviewSpec = () => {
  const spec = makeSpec();
  spec.schemaVersion = 2;
  spec.pages = [{ key: 'overview', name: 'Overview', source: { kind: 'tsx', codeFile: 'o.tsx' } }];
  spec.appShell.areas[0].groups[0].subAreas.push({ page: 'overview', title: 'Overview' });
  return spec;
};

test('pages: crash-after-create convergence — a manifest id in EXISTENCE but NOT in the sitemap is UPDATED, never re-created (C1)', async () => {
  const spec = overviewSpec();
  const appUnique = appUniqueName(spec);
  const appDir = stagePages(spec.pages);
  try {
    const existing = Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: GP_O }] }), 'utf8').toString('base64');
    // EXISTENCE has GP_O (created + manifested); the SITEMAP is empty (the finalizer died before the subarea).
    const { sdk } = mockSdk({ pageManifest: existing, manifestId: 'wr-manifest', selfAppUnique: appUnique, liveSitemapXml: EMPTY_SITEMAP_XML });
    const uploads = [];
    const genpageCli = { enumerateEnv: async () => ({ ok: true, ids: [GP_O], pages: [{ pageId: GP_O, name: 'Overview' }] }), upload: async (o) => { uploads.push(o); return { pageId: o.pageId || GP_O }; } };
    await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'] });
    assert.strictEqual(uploads.length, 1, 'exactly one upload');
    assert.strictEqual(uploads[0].pageId, GP_O, 'UPDATE in place by the existing id, never a duplicate CREATE');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('pages: a MEMBERSHIP (sitemap) read failure HALTS pages-sitemap-read-failed, uploads nothing', async () => {
  const spec = overviewSpec();
  const appDir = stagePages(spec.pages);
  try {
    const { sdk } = mockSdk({ failSitemap: true }); // fetchSitemap returns ok:false (component not found)
    let uploaded = 0;
    const genpageCli = { enumerateEnv: async () => ({ ok: true, ids: [], pages: [] }), upload: async () => { uploaded += 1; return { pageId: GP_O }; } };
    await assert.rejects(
      runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'] }),
      (e) => e && e.phase === 'pages' && e.code === 'pages-sitemap-read-failed'
    );
    assert.strictEqual(uploaded, 0);
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('pages: a PRESENT but corrupt page manifest HALTS pages-manifest-corrupt (never reconciles as no-identity)', async () => {
  const spec = overviewSpec();
  const appUnique = appUniqueName(spec);
  const appDir = stagePages(spec.pages);
  try {
    const garbage = Buffer.from('this is not manifest json { pages', 'utf8').toString('base64'); // present + unparseable
    const { sdk } = mockSdk({ pageManifest: garbage, manifestId: 'wr-manifest', selfAppUnique: appUnique, liveSitemapXml: EMPTY_SITEMAP_XML });
    let uploaded = 0;
    const genpageCli = { enumerateEnv: async () => ({ ok: true, ids: [GP_O], pages: [{ pageId: GP_O, name: 'Overview' }] }), upload: async () => { uploaded += 1; return { pageId: GP_O }; } };
    await assert.rejects(
      runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'] }),
      (e) => e && e.phase === 'pages' && e.code === 'pages-manifest-corrupt'
    );
    assert.strictEqual(uploaded, 0, 'a corrupt manifest halts before any upload — does not recreate existing pages');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('pages: a spec pageId that disagrees with a live manifest id HALTS pages-identity-conflict', async () => {
  const spec = overviewSpec();
  const GP_A = '7f1e2d3c-4b5a-4968-8071-2c3d4e5f6a7b';
  spec.pages[0].pageId = GP_A; // spec claims GP_A; the manifest maps overview -> GP_O; both live, they DISAGREE
  const appUnique = appUniqueName(spec);
  const appDir = stagePages(spec.pages);
  try {
    const existing = Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: GP_O }] }), 'utf8').toString('base64');
    const { sdk } = mockSdk({ pageManifest: existing, manifestId: 'wr-manifest', selfAppUnique: appUnique, liveSitemapXml: EMPTY_SITEMAP_XML });
    let uploaded = 0;
    const genpageCli = { enumerateEnv: async () => ({ ok: true, ids: [GP_O, GP_A], pages: [{ pageId: GP_O, name: 'Overview' }, { pageId: GP_A, name: 'Other' }] }), upload: async () => { uploaded += 1; return { pageId: GP_A }; } };
    await assert.rejects(
      runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'] }),
      (e) => e && e.phase === 'pages' && e.code === 'pages-identity-conflict'
    );
    assert.strictEqual(uploaded, 0);
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('pages: a live page the spec dropped HALTS pages-removed with ZERO sitemap writes; --allow-destructive detaches (no delete)', async () => {
  const spec = overviewSpec(); // keeps overview, DROPS order-detail (still live in manifest + sitemap)
  const appUnique = appUniqueName(spec);
  const appDir = stagePages(spec.pages);
  try {
    const existing = Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: GP_O }, { key: 'order-detail', name: 'Order Detail', pageId: GP_D }] }), 'utf8').toString('base64');
    const sm = `<SiteMap><Area><Group><SubArea GenPageId="${GP_O}"/><SubArea GenPageId="${GP_D}"/></Group></Area></SiteMap>`;
    const mkOpts = () => ({ pageManifest: existing, manifestId: 'wr-manifest', selfAppUnique: appUnique, liveSitemapXml: sm });
    const cli = () => ({ enumerateEnv: async () => ({ ok: true, ids: [GP_O, GP_D], pages: [{ pageId: GP_O, name: 'Overview' }, { pageId: GP_D, name: 'Order Detail' }] }), upload: async (o) => ({ pageId: o.pageId || GP_O }) });
    const m1 = mockSdk(mkOpts());
    await assert.rejects(
      runSdkBuild(spec, { sdk: m1.sdk, apply: true, env: 'https://x', appDir, genpageCli: cli(), phases: ['solution', 'data-model', 'app-shell', 'pages'] }),
      (e) => e && e.phase === 'pages' && e.code === 'pages-removed'
    );
    assert.ok(!find(m1.calls, 'updateElement').some((c) => c.args[2] === '/siteMap'), 'ZERO sitemap writes on the removal HALT (no strip before the gate)');
    // --allow-destructive: the build proceeds and DETACHES order-detail (finalize omits its SubArea); no delete.
    const m2 = mockSdk(mkOpts());
    await runSdkBuild(spec, { sdk: m2.sdk, apply: true, allowDestructive: true, env: 'https://x', appDir, genpageCli: cli(), phases: ['solution', 'data-model', 'app-shell', 'pages'] });
    const finalize = find(m2.calls, 'updateElement').find((c) => c.args[2] === '/siteMap');
    assert.ok(finalize, 'finalize wrote the detached sitemap');
    const genIds = (finalize.args[3].areas || []).flatMap((a) => (a.groups || []).flatMap((g) => (g.subAreas || []).map((s) => s.genPageId)));
    assert.ok(!genIds.includes(GP_D), 'the dropped page GP_D is detached from the sitemap');
    assert.ok(!m2.calls.some((c) => /delete/i.test(c.name)), 'detach-only: no page-record delete call');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('pages: spec.pages=[] on an EXISTING app that still has live pages HALTS pages-removed (empty pages does NOT bypass the gate)', async () => {
  const spec = makeSpec(); spec.schemaVersion = 2; // no spec.pages, no page subareas
  const appUnique = appUniqueName(spec);
  const appDir = stagePages([]);
  try {
    const existing = Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: GP_O }] }), 'utf8').toString('base64');
    const sm = `<SiteMap><Area><Group><SubArea GenPageId="${GP_O}"/></Group></Area></SiteMap>`;
    const { sdk, calls } = mockSdk({ artifactsExist: true, existingSitemap: PRIOR_SITEMAP, pageManifest: existing, manifestId: 'wr-manifest', selfAppUnique: appUnique, liveSitemapXml: sm });
    const genpageCli = { enumerateEnv: async () => ({ ok: true, ids: [GP_O], pages: [{ pageId: GP_O, name: 'Overview' }] }), upload: async (o) => ({ pageId: o.pageId || GP_O }) };
    await assert.rejects(
      runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'] }),
      (e) => e && e.phase === 'pages' && e.code === 'pages-removed'
    );
    assert.ok(!find(calls, 'updateElement').some((c) => c.args[2] === '/siteMap'), 'no sitemap write before the removal gate (existing-app write deferred)');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('pages: spec.pages=[] with --allow-destructive DETACHES all live pages (page-less sitemap via finalizer, no throw, no delete)', async () => {
  const spec = makeSpec(); spec.schemaVersion = 2; // no spec.pages, no page subareas
  const appUnique = appUniqueName(spec);
  const appDir = stagePages([]);
  try {
    const existing = Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: GP_O }] }), 'utf8').toString('base64');
    const sm = `<SiteMap><Area><Group><SubArea GenPageId="${GP_O}"/></Group></Area></SiteMap>`;
    const { sdk, calls } = mockSdk({ artifactsExist: true, existingSitemap: PRIOR_SITEMAP, pageManifest: existing, manifestId: 'wr-manifest', selfAppUnique: appUnique, liveSitemapXml: sm });
    const genpageCli = { enumerateEnv: async () => ({ ok: true, ids: [GP_O], pages: [{ pageId: GP_O, name: 'Overview' }] }), upload: async (o) => ({ pageId: o.pageId || GP_O }) };
    await runSdkBuild(spec, { sdk, apply: true, allowDestructive: true, env: 'https://x', appDir, genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'] });
    const finalize = find(calls, 'updateElement').find((c) => c.args[2] === '/siteMap');
    assert.ok(finalize, 'the page-less sitemap was finalized (existing-app write via the finalizer)');
    const genIds = (finalize.args[3].areas || []).flatMap((a) => (a.groups || []).flatMap((g) => (g.subAreas || []).map((s) => s.genPageId).filter(Boolean)));
    assert.strictEqual(genIds.length, 0, 'all GenPage subareas detached — no genpages remain in the sitemap');
    assert.ok(!calls.some((c) => /delete/i.test(c.name)), 'detach-only: no page-record delete');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('pages: app-shell-only run (pages EXCLUDED) HALTS rather than orphan live genpages via a page-less sitemap (whole-branch review)', async () => {
  const spec = makeSpec(); spec.schemaVersion = 2; // page-less spec, no page subareas
  const appUnique = appUniqueName(spec);
  const appDir = stagePages([]);
  try {
    const sm = `<SiteMap><Area><Group><SubArea GenPageId="${GP_O}"/></Group></Area></SiteMap>`; // live app HAS a genpage
    const mk = () => mockSdk({ artifactsExist: true, existingSitemap: PRIOR_SITEMAP, selfAppUnique: appUnique, liveSitemapXml: sm });
    // pages phase EXCLUDED — the removal gate cannot run; the app-shell guard must fail-closed.
    await assert.rejects(
      runSdkBuild(spec, { sdk: mk().sdk, apply: true, env: 'https://x', appDir, phases: ['solution', 'data-model', 'app-shell'] }),
      (e) => e && e.phase === 'app-shell' && e.code === 'pages-removed',
      'a page-less app-shell-only rewrite over an app with live genpages must HALT without --allow-destructive',
    );
    // With --allow-destructive it proceeds (detaches by writing the page-less sitemap).
    const { sdk, calls } = mk();
    await runSdkBuild(spec, { sdk, apply: true, allowDestructive: true, env: 'https://x', appDir, phases: ['solution', 'data-model', 'app-shell'] });
    assert.ok(find(calls, 'updateElement').some((c) => c.args[2] === '/siteMap'), 'with --allow-destructive the page-less sitemap is written (detach)');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('pages: a page shared across TWO app sitemaps HALTS pages-shared-across-apps (Imp5) — --allow-destructive does NOT bypass', async () => {
  const spec = overviewSpec();
  const appUnique = appUniqueName(spec);
  const appDir = stagePages(spec.pages);
  try {
    const existing = Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: GP_O }] }), 'utf8').toString('base64');
    const sitemapWithO = `<SiteMap><Area><Group><SubArea GenPageId="${GP_O}" Title="Overview"/></Group></Area></SiteMap>`;
    // THIS app reuses GP_O; contoso_secondapp's sitemap ALSO references GP_O → shared → HALT (never auto-modify).
    const mk = () => mockSdk({ pageManifest: existing, manifestId: 'wr-manifest', selfAppUnique: appUnique, liveSitemapXml: sitemapWithO, otherApps: [{ uniquename: 'contoso_secondapp', sitemapxml: sitemapWithO }] });
    const cli = () => ({ enumerateEnv: async () => ({ ok: true, ids: [GP_O], pages: [{ pageId: GP_O, name: 'Overview' }] }), upload: async (o) => ({ pageId: o.pageId || GP_O }) });
    await assert.rejects(
      runSdkBuild(spec, { sdk: mk().sdk, apply: true, env: 'https://x', appDir, genpageCli: cli(), phases: ['solution', 'data-model', 'app-shell', 'pages'] }),
      (e) => e && e.phase === 'pages' && e.code === 'pages-shared-across-apps'
    );
    // The shared HALT has no escape by design — --allow-destructive must NOT authorize cross-app mutation.
    await assert.rejects(
      runSdkBuild(spec, { sdk: mk().sdk, apply: true, allowDestructive: true, env: 'https://x', appDir, genpageCli: cli(), phases: ['solution', 'data-model', 'app-shell', 'pages'] }),
      (e) => e && e.code === 'pages-shared-across-apps'
    );
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('pages: an UNREADABLE other-app sitemap HALTS pages-shared-check-failed (fail-closed — cannot prove non-sharing)', async () => {
  const spec = overviewSpec();
  const appUnique = appUniqueName(spec);
  const appDir = stagePages(spec.pages);
  try {
    const existing = Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: GP_O }] }), 'utf8').toString('base64');
    // The other app's sitemap XML is truncated (fails isMalformed) → fetchSitemap ok:false → unreadable.
    const { sdk } = mockSdk({ pageManifest: existing, manifestId: 'wr-manifest', selfAppUnique: appUnique, liveSitemapXml: EMPTY_SITEMAP_XML, otherApps: [{ uniquename: 'contoso_badapp', sitemapxml: '<SiteMap><Area' }] });
    const genpageCli = { enumerateEnv: async () => ({ ok: true, ids: [GP_O], pages: [{ pageId: GP_O, name: 'Overview' }] }), upload: async (o) => ({ pageId: o.pageId || GP_O }) };
    await assert.rejects(
      runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'] }),
      (e) => e && e.phase === 'pages' && e.code === 'pages-shared-check-failed'
    );
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('pages: an env app-list failure HALTS pages-shared-check-failed (fail-closed on the shared scan)', async () => {
  const spec = overviewSpec();
  const appUnique = appUniqueName(spec);
  const appDir = stagePages(spec.pages);
  try {
    const existing = Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: GP_O }] }), 'utf8').toString('base64');
    // failAppList: the UNFILTERED appmodule list (fetchAppsForPages) throws; the FILTERED read (membership) still works.
    const { sdk } = mockSdk({ pageManifest: existing, manifestId: 'wr-manifest', selfAppUnique: appUnique, liveSitemapXml: EMPTY_SITEMAP_XML, failAppList: true });
    const genpageCli = { enumerateEnv: async () => ({ ok: true, ids: [GP_O], pages: [{ pageId: GP_O, name: 'Overview' }] }), upload: async (o) => ({ pageId: o.pageId || GP_O }) };
    await assert.rejects(
      runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'] }),
      (e) => e && e.phase === 'pages' && e.code === 'pages-shared-check-failed'
    );
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('pages: a single-app env passes the shared-page check (reads no other sitemaps) and reuses the page', async () => {
  const spec = overviewSpec();
  const appUnique = appUniqueName(spec);
  const appDir = stagePages(spec.pages);
  try {
    const existing = Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: GP_O }] }), 'utf8').toString('base64');
    const sm = `<SiteMap><Area><Group><SubArea GenPageId="${GP_O}"/></Group></Area></SiteMap>`;
    const { sdk } = mockSdk({ pageManifest: existing, manifestId: 'wr-manifest', selfAppUnique: appUnique, liveSitemapXml: sm }); // no otherApps
    const uploads = [];
    const genpageCli = { enumerateEnv: async () => ({ ok: true, ids: [GP_O], pages: [{ pageId: GP_O, name: 'Overview' }] }), upload: async (o) => { uploads.push(o); return { pageId: o.pageId || GP_O }; } };
    await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'] });
    assert.strictEqual(uploads.length, 1);
    assert.strictEqual(uploads[0].pageId, GP_O, 'reused (UPDATE); a single-app env has no other app to share with');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('a by-value publish failure reaches the warn channel through the whole build', async () => {
  // The unit tests pin reportPartialPush; this pins that the ENGINE is wired to it. Before the fix a
  // build in which every publish failed reported ok:true with zero warnings and zero error events —
  // proven by probe — because all nine call sites discarded the result. A wiring break would restore
  // exactly that, and no unit test can see it.
  const { sdk, calls } = mockSdk();
  sdk.publishArtifact = async (type, id) => {
    calls.push({ name: 'publishArtifact', args: [type, id] });
    return { type, id, shipped: false, publish: { kind: 'failed', error: new Error('PublishXml 503') } };
  };
  const warnings = [];
  const spec = makeSpec();
  const result = await runSdkBuild(spec, { sdk, apply: true, publish: true, warn: (m) => warnings.push(m) });

  assert.ok(result.ok, 'a failed publish does not fail the build — the writes committed');
  assert.ok(calls.some((c) => c.name === 'publishArtifact'), 'the publish phase actually ran');
  assert.ok(
    warnings.some((w) => /publish .* FAILED/.test(w) && /PublishXml 503/.test(w)),
    'the failure must surface with its cause; got: ' + JSON.stringify(warnings)
  );
});

test('app.newLook writes the NewLookAlwaysOn app setting, scoped to the app and solution', async () => {
  const { sdk, calls } = mockSdk();
  const saved = [];
  sdk.saveSettingValue = async (name, value, opts) => { saved.push({ name, value, opts }); };
  const spec = makeSpec();
  spec.app.newLook = true;

  const r = await runSdkBuild(spec, { sdk, apply: true });
  assert.ok(r.ok, JSON.stringify(r.errors || []));
  assert.strictEqual(saved.length, 1, 'exactly one setting write: ' + JSON.stringify(saved));
  assert.strictEqual(saved[0].name, 'NewLookAlwaysOn');
  assert.strictEqual(saved[0].value, 'true', 'the value is a STRING — Dataverse setting values are strings');
  assert.ok(saved[0].opts.appUniqueName, 'scoped to the app, not the org');
  assert.ok(saved[0].opts.solutionUniqueName, 'attributed to the solution so it travels on export/import');
  assert.strictEqual(r.created.newLook, true);
  void calls;
});

test('the new look is OPT-IN — absent or false writes nothing', async () => {
  for (const value of [undefined, false]) {
    const { sdk } = mockSdk();
    const saved = [];
    sdk.saveSettingValue = async (n, v, o) => { saved.push({ n, v, o }); };
    const spec = makeSpec();
    if (value !== undefined) spec.app.newLook = value;
    const r = await runSdkBuild(spec, { sdk, apply: true });
    assert.ok(r.ok);
    assert.deepStrictEqual(saved, [], `newLook=${value} must write no setting`);
  }
});

test('a failed new-look write does not fail the build, but is never reported as success', async () => {
  // The definition is a platform feature that rolls out by tenant; a tenant without it must still get
  // a working app on the classic shell rather than a failed build. But a silent success would be
  // worse than the failure — the caller must be able to tell the difference.
  const { sdk } = mockSdk();
  sdk.saveSettingValue = async () => { throw new Error('setting definition not found'); };
  const spec = makeSpec();
  spec.app.newLook = true;
  const warnings = [];
  const r = await runSdkBuild(spec, { sdk, apply: true, warn: (m) => warnings.push(m) });

  assert.ok(r.ok, 'the build still succeeds — the app is fully functional');
  assert.strictEqual(r.created.newLook, false, 'and the result says plainly that it was NOT applied');
  assert.ok(
    warnings.some((w) => /new look/i.test(w) && /setting definition not found/.test(w)),
    'the cause is surfaced: ' + JSON.stringify(warnings)
  );
});

// The Wave 2 header/navigation refresh. Written through the SDK's dedicated
// `setHeaderAndNavigationRefresh` rather than a raw setting write, because the encoding is a trap:
// it is a `datatype = 0` (Number) TRI-STATE where ON is '2', not '1', and writing '1' is ACCEPTED by
// the API and then silently fails to enable the feature. Delegating means the plugin cannot get that
// wrong, and these tests pin the delegation rather than re-encoding the value here.
test('app.headerNavigationRefresh delegates to the SDK API with the created app id', async () => {
  const { sdk } = mockSdk();
  const calls = [];
  sdk.setHeaderAndNavigationRefresh = async (appId, enabled) => { calls.push({ appId, enabled }); return 'created'; };
  const spec = makeSpec();
  spec.app.headerNavigationRefresh = true;

  const r = await runSdkBuild(spec, { sdk, apply: true });
  assert.ok(r.ok, JSON.stringify(r.errors || []));
  assert.strictEqual(calls.length, 1, 'exactly one call: ' + JSON.stringify(calls));
  assert.strictEqual(calls[0].enabled, true);
  assert.strictEqual(calls[0].appId, r.created.app, 'the APP MODULE id, not the unique name — the setting row is keyed by parentappmoduleid');
  assert.strictEqual(r.created.headerNavigationRefresh, true);
  assert.strictEqual(r.created.headerNavigationRefreshOutcome, 'created', 'the outcome is recorded verbatim so a caller can tell a fresh enable from a no-op re-run');
});

test('the header/navigation refresh is a DIFFERENT setting from the new look', async () => {
  // Both are per-app settings and both can be on, but they are separate settingdefinition rows and
  // enabling one must not enable the other. Conflating them would silently under-deliver whichever
  // one the author actually asked for.
  const { sdk } = mockSdk();
  const saved = [];
  const hdr = [];
  sdk.saveSettingValue = async (name, value, opts) => { saved.push({ name, value, opts }); };
  sdk.setHeaderAndNavigationRefresh = async (appId, enabled) => { hdr.push({ appId, enabled }); return 'created'; };

  // newLook alone must not touch header/nav
  const a = makeSpec(); a.app.newLook = true;
  const ra = await runSdkBuild(a, { sdk, apply: true });
  assert.ok(ra.ok);
  assert.strictEqual(saved.length, 1, 'newLook wrote its own setting');
  assert.deepStrictEqual(hdr, [], 'newLook must NOT enable the header/navigation refresh');
  assert.strictEqual(ra.created.headerNavigationRefresh, undefined);

  // header/nav alone must not touch newLook
  saved.length = 0; hdr.length = 0;
  const b = makeSpec(); b.app.headerNavigationRefresh = true;
  const rb = await runSdkBuild(b, { sdk, apply: true });
  assert.ok(rb.ok);
  assert.strictEqual(hdr.length, 1, 'header/nav was written');
  assert.deepStrictEqual(saved, [], 'the header/navigation refresh must NOT enable the new look');
  assert.strictEqual(rb.created.newLook, undefined);

  // both together: two independent writes
  saved.length = 0; hdr.length = 0;
  const c = makeSpec(); c.app.newLook = true; c.app.headerNavigationRefresh = true;
  const rc = await runSdkBuild(c, { sdk, apply: true });
  assert.ok(rc.ok);
  assert.strictEqual(saved.length, 1, 'both set: new look written');
  assert.strictEqual(hdr.length, 1, 'both set: header/nav written');
  assert.strictEqual(rc.created.newLook, true);
  assert.strictEqual(rc.created.headerNavigationRefresh, true);
});

test('the header/navigation refresh honours BOTH values — false actively disables', async () => {
  // NOT symmetry for its own sake. Verified against the real vendored bundle (offline, by capturing
  // the writes a push issues): the SDK defaults the app artifact's
  // `headerAndNavigationRefresh` to TRUE and pushing a new app writes '2' (ON) unprompted, so the
  // platform default is ON. Treating `false` as "do nothing" would silently leave the feature ON for
  // an author who explicitly asked for it off — the exact silent-disagreement class this build keeps
  // having to fix. So `false` must be an ACTIVE write of the OFF value.
  for (const value of [true, false]) {
    const { sdk } = mockSdk();
    const calls = [];
    sdk.setHeaderAndNavigationRefresh = async (a, e) => { calls.push({ a, e }); return 'updated'; };
    const spec = makeSpec();
    spec.app.headerNavigationRefresh = value;
    const r = await runSdkBuild(spec, { sdk, apply: true });
    assert.ok(r.ok);
    assert.strictEqual(calls.length, 1, `headerNavigationRefresh=${value} must issue exactly one write`);
    assert.strictEqual(calls[0].e, value, `the requested value ${value} must be passed through, not coerced`);
    assert.strictEqual(r.created.headerNavigationRefresh, value);
  }
});

test('the header/navigation refresh is only touched when the author states a preference', async () => {
  // Absent means "no opinion" — leave the platform default alone rather than fighting it.
  const { sdk } = mockSdk();
  const calls = [];
  sdk.setHeaderAndNavigationRefresh = async (a, e) => { calls.push({ a, e }); return 'created'; };
  const spec = makeSpec();
  const r = await runSdkBuild(spec, { sdk, apply: true });
  assert.ok(r.ok);
  assert.deepStrictEqual(calls, [], 'an absent headerNavigationRefresh must make no call');
  assert.strictEqual(r.created.headerNavigationRefresh, undefined);
});

test('a failed header/navigation write does not fail the build, but is never reported as success', async () => {
  // Public preview, rolls out by tenant. The SDK throws a PLAIN Error (not an SdkError subclass)
  // when the environment lacks the setting definition, so the catch here is deliberately broad.
  const { sdk } = mockSdk();
  sdk.setHeaderAndNavigationRefresh = async () => { throw new Error("App setting 'HeaderAndNavigationRefresh' is not available in this environment"); };
  const spec = makeSpec();
  spec.app.headerNavigationRefresh = true;
  const warnings = [];

  const r = await runSdkBuild(spec, { sdk, apply: true, warn: (m) => warnings.push(m) });
  assert.ok(r.ok, 'a rolling-out preview setting must not fail an otherwise-good build');
  // 'unknown', NOT false. On failure the row keeps whatever the platform defaulted it to — which for
  // a new app is ON — so reporting `false` would be as wrong as reporting success.
  assert.strictEqual(r.created.headerNavigationRefresh, 'unknown',
    'a failed write reports the truth (unknown), not the value that was asked for and not its opposite');
  assert.ok(
    warnings.some((w) => /header and navigation refresh/i.test(w) && /not available in this environment/.test(w)),
    'the real cause reaches the caller; got: ' + JSON.stringify(warnings)
  );
});

test('app.headerNavigationRefresh must be a boolean', () => {
  // A string "false" is truthy in JS and would silently turn the feature ON for an author who meant
  // to disable it — the same trap the newLook validation exists to close.
  for (const bad of ['true', 'false', 1, 0, {}, []]) {
    const spec = makeSpec();
    spec.app.headerNavigationRefresh = bad;
    const v = validateAppSpec(spec);
    assert.ok(
      (v.errors || []).some((e) => /app.headerNavigationRefresh must be a boolean/.test(e)),
      `headerNavigationRefresh=${JSON.stringify(bad)} must be rejected`
    );
  }
  for (const good of [true, false, undefined]) {
    const spec = makeSpec();
    if (good !== undefined) spec.app.headerNavigationRefresh = good;
    const v = validateAppSpec(spec);
    assert.ok(!(v.errors || []).some((e) => /headerNavigationRefresh/.test(e)), `${good} must be accepted`);
  }
});

// --- command buttons must be HANDED the record (live-measured) ----------------------------------
//
// `onclickeventjavascriptparameters` null means the function is invoked with NO arguments, so the
// near-universal handler shape `function doThing(primaryControl) { primaryControl.getAttribute(…) }`
// throws on its first property access and the button silently does nothing. Reported by a user as
// "nothing happens when I press Escalate"; the build, the deployed rows and `--verify` all looked
// perfect, because the failure is client-side only.
//
// The codes come from the platform's own maker-authored commands on a live org:
//   form (location 0)    [{"type":5}]               PrimaryControl
//   grid (location 1)    [{"type":12},{"type":24}]  SelectedControl + SelectedControlSelectedItemIds
test('a JS command defaults to receiving the primary control', () => {
  const spec = {
    webResources: [{ name: 'x.js', type: 'js', content: '//' }],
    commands: [{ entity: 'new_t', label: 'Go', library: 'x.js', function: 'Ns.go' }],
  };
  const def = commandDef('new_t', spec.commands, { 'x.js': 'wr-1' });
  const control = def.commandBars[0].groups[0].controls[0];
  assert.strictEqual(control.action.parameters, '[{"type":5,"value":null}]',
    'without this the handler is called with no arguments and the button does nothing');
});

test('flyout CHILDREN also receive the primary control', () => {
  // The children are the actual buttons a user clicks; missing parameters there is the same bug.
  const cmds = [{
    entity: 'new_t', label: 'Set status', type: 'FlyoutAnchor',
    children: [{ label: 'Closed', library: 'x.js', function: 'Ns.close' }],
  }];
  const def = commandDef('new_t', cmds, { 'x.js': 'wr-1' });
  const child = def.commandBars[0].groups[0].controls[0].children[0];
  assert.strictEqual(child.action.parameters, '[{"type":5,"value":null}]');
});

test('a grid command gets the grid shape, not the form one', () => {
  const cmds = [{ entity: 'new_t', label: 'Bulk', location: 'HomeTab', library: 'x.js', function: 'Ns.bulk' }];
  const def = commandDef('new_t', cmds, { 'x.js': 'wr-1' });
  assert.strictEqual(def.commandBars[0].groups[0].controls[0].action.parameters,
    '[{"type":12,"value":null},{"type":24,"value":null}]');
});

test('an explicit parameters value always wins, including empty', () => {
  // An author with a genuinely argument-less function must be able to say so.
  const cmds = [
    { entity: 'new_t', label: 'A', library: 'x.js', function: 'Ns.a', parameters: '[{"type":99,"value":1}]' },
    { entity: 'new_t', label: 'B', library: 'x.js', function: 'Ns.b', parameters: '' },
  ];
  const def = commandDef('new_t', cmds, { 'x.js': 'wr-1' });
  const [a, b] = def.commandBars[0].groups[0].controls;
  assert.strictEqual(a.action.parameters, '[{"type":99,"value":1}]');
  assert.strictEqual(b.action.parameters, '');
});

test('a flyout ANCHOR has no action at all', () => {
  // The anchor only opens the menu; giving it parameters would imply a handler it does not have.
  const cmds = [{
    entity: 'new_t', label: 'Menu', type: 'FlyoutAnchor',
    children: [{ label: 'One', library: 'x.js', function: 'Ns.one' }],
  }];
  const def = commandDef('new_t', cmds, { 'x.js': 'wr-1' });
  assert.strictEqual(def.commandBars[0].groups[0].controls[0].action, undefined);
});
