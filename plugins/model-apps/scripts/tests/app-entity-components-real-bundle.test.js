'use strict';
// REAL-BUNDLE contract tests for app TABLE (entity) components — ADO 6612527.
//
// The reported defect: an app built by the SDK came back with its Account/Contact/Activity table
// components replaced by two rows reading `<AppModuleComponent type="1" schemaName="entity" />`,
// and the malformed app then broke unrelated app-processing and metadata-discovery paths. Root
// cause: a table was pinned as an `@odata.type` INSTANCE —
//   { '@odata.type': 'Microsoft.Dynamics.CRM.entity', entityid: <MetadataId> }
// — but `entity` is itself a real Dataverse table (metadata-as-data), so the platform pinned the
// `entity` TABLE, exactly as asked. A table is now pinned by an OData entity REFERENCE instead:
//   { '@odata.id': '<EntitySetName>(<MetadataId>)' }
// where the SET SEGMENT decides the resulting objectid.
//
// Every guarantee below is one the ENGINE depends on but no mock-based test can see, because the
// mocks in sdk-build.test.js stub `pushArtifact` wholesale. These drive the real vendored bundle.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');
const { appDef } = require('../lib/sdk-build.js');
// Every app the PLUGIN creates carries an icon: `ensureAppIcon` (sdk-build.js) resolves the author's
// `spec.app.icon` or generates an SVG web resource, and `appDef` passes its id as
// `iconWebResourceId`. These tests drive the SDK directly, so they must supply one too or they are
// exercising a path production never takes.
//
// The SDK now REQUIRES it: `appmodule.webresourceid` is a required attribute, and when no explicit id
// is given it auto-resolves an IMAGE web resource (PNG/JPG/GIF/ICO/SVG) and throws
// `APP_ICON_UNRESOLVED` if the environment has none. Previously it fell back to ANY unmanaged web
// resource — which on an org whose images are all managed returned a JAVASCRIPT file, and the platform
// rejected the create with an opaque "dependent component WebResource does not exist". Failing fast
// with a clear message is the better behaviour; these tests just have to stop relying on the old
// silent fallback. A synthetic id is right here — the mock transport never dereferences it.
const APP_ICON_ID = '11111111-2222-3333-4444-555555555555';

const APP_ID = '11111111-1111-1111-1111-111111111111';
const APP_UNIQUE_ID = '33333333-3333-3333-3333-333333333333';
/** Stable per-table MetadataIds so a component's objectid can be traced back to its table. */
const META = {
  account: 'aaaaaaaa-0000-0000-0000-000000000001',
  contact: 'aaaaaaaa-0000-0000-0000-000000000002',
  activitypointer: 'aaaaaaaa-0000-0000-0000-000000000003',
};
const SET_NAME = { account: 'accounts', contact: 'contacts', activitypointer: 'activitypointers' };

const tempDirs = [];
test.after(() => { for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true }); });

/** The reporter's exact scenario: three OOB tables, all in the sitemap. */
function specFor(tables) {
  return {
    solution: { uniqueName: 'EntCompA', publisherPrefix: 'contoso' },
    app: { name: 'Customer Management', description: '' },
    entities: tables.map((t) => ({ schemaName: t, primaryAttribute: { schemaName: 'name' }, columns: [] })),
    appShell: {
      areas: [{ label: 'Main', groups: [{ label: 'Records', subAreas: tables.map((t) => ({ entity: t, title: t })) }] }],
    },
  };
}

/**
 * A real SDK over a fake Dataverse. `opts`:
 *   unresolvable    - table logical name whose EntityDefinitions read returns nothing
 *   componentRows   - override what the post-write read-back reports (models a lying platform)
 *   componentStatus - HTTP status for the component read-back
 *   noAppUnique     - the app read returns no `appmoduleidunique`
 */
function freshSdk(tables, opts = {}) {
  const { createMakerSdk } = require(BUNDLE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entcomp-'));
  tempDirs.push(dir);
  const reqs = [];
  const httpClient = {
    get: async (url) => {
      reqs.push({ method: 'GET', url });
      // GET /EntityDefinitions(LogicalName='account')?$select=MetadataId,EntitySetName
      const m = /EntityDefinitions\(LogicalName='([^']+)'\)/.exec(url);
      if (m) {
        const logical = m[1];
        if (opts.unresolvable === logical) return { status: 404, headers: {}, body: null };
        return { status: 200, headers: {}, body: { LogicalName: logical, MetadataId: META[logical] || 'aaaaaaaa-0000-0000-0000-0000000000ff', EntitySetName: SET_NAME[logical] || `${logical}s` } };
      }
      if (/\/appmodulecomponents/.test(url)) {
        if (opts.componentStatus) return { status: opts.componentStatus, headers: {}, body: null };
        const rows = opts.componentRows !== undefined
          ? opts.componentRows
          : tables.map((t) => ({ objectid: META[t], componenttype: 1 }));
        return { status: 200, headers: {}, body: { value: rows } };
      }
      if (/\/appmodules/.test(url)) {
        const row = { appmoduleid: APP_ID, ...(opts.noAppUnique ? {} : { appmoduleidunique: APP_UNIQUE_ID }) };
        return { status: 200, headers: {}, body: /RetrieveUnpublishedMultiple/i.test(url) ? { value: [row] } : row };
      }
      return { status: 200, headers: {}, body: {} };
    },
    post: async (url, body) => {
      reqs.push({ method: 'POST', url, body });
      return { status: 204, headers: { 'odata-entityid': `https://x/y(${APP_ID})` }, body: {} };
    },
    patch: async (url, body) => { reqs.push({ method: 'PATCH', url, body }); return { status: 204, headers: {}, body: {} }; },
    delete: async () => ({ status: 204, headers: {}, body: {} }),
    put: async () => ({ status: 204, headers: {}, body: {} }),
  };
  const sdk = createMakerSdk({ workspacePath: dir, instanceUrl: 'https://example.crm.dynamics.com', httpClient });
  sdk.initWorkspace();
  return { sdk, reqs };
}

async function pushApp(sdk, tables) {
  const def = appDef(specFor(tables), { forms: {}, views: {}, charts: {}, dashboards: {} });
  const art = sdk.createArtifact('app', { name: def.name, uniqueName: 'contoso_customermanagement', description: '', siteMap: def.siteMap, components: def.components, iconWebResourceId: APP_ICON_ID });
  return sdk.pushArtifact('app', art.id);
}
const addComponentsCall = (reqs) => reqs.find((r) => r.method === 'POST' && /AddAppComponents/i.test(r.url));

test('REAL BUNDLE: sitemap tables are pinned as OData REFERENCES, never as `entity` instances', async () => {
  // The regression that shipped: an `@odata.type` instance payload naming the `entity` table pinned
  // the metadata table itself, producing `schemaName="entity"` in the export.
  const tables = ['account', 'contact', 'activitypointer'];
  const { sdk, reqs } = freshSdk(tables);
  await pushApp(sdk, tables);
  const call = addComponentsCall(reqs);
  assert.ok(call, 'AddAppComponents must be called');
  const sent = JSON.stringify(call.body);
  assert.ok(!/Microsoft\.Dynamics\.CRM\.entity\b/.test(sent), `a table must NOT be sent as an entity INSTANCE: ${sent}`);
  assert.ok(!/"entityid"/.test(sent), `\`entityid\` was the broken key: ${sent}`);
  for (const t of tables) {
    assert.ok(
      new RegExp(`${SET_NAME[t]}\\(`).test(sent),
      `table '${t}' must be pinned by its entity-set reference '${SET_NAME[t]}(...)': ${sent}`
    );
  }
});

test('REAL BUNDLE: every declared table is pinned — none is silently dropped', async () => {
  // The reported app had THREE sitemap tables but only TWO (junk) components, which is only
  // explicable as one having been dropped before the call. N components must produce N rows;
  // AddAppComponents does not de-duplicate.
  const tables = ['account', 'contact', 'activitypointer'];
  const { sdk, reqs } = freshSdk(tables);
  await pushApp(sdk, tables);
  const comps = addComponentsCall(reqs).body.Components || [];
  const refs = comps.map((c) => c['@odata.id']).filter(Boolean);
  assert.strictEqual(refs.length, tables.length, `expected one reference per table, got ${JSON.stringify(refs)}`);
});

test('REAL BUNDLE: an UNRESOLVABLE table refuses the whole push rather than pinning the rest', async () => {
  // Fail closed: one bad component fails the entire AddAppComponents call (zero rows), so pinning
  // "the rest" would leave nav pointing at a table the app does not contain. The refusal must NAME
  // the table so the message is actionable.
  const tables = ['account', 'contact'];
  const { sdk, reqs } = freshSdk(tables, { unresolvable: 'contact' });
  await assert.rejects(() => pushApp(sdk, tables), (e) => {
    assert.ok(/contact/.test(e.message), `the refusal must name the table: ${e.message}`);
    return true;
  });
  assert.ok(!addComponentsCall(reqs), 'nothing may be pinned when a table cannot be resolved');
});

test('REAL BUNDLE: components are READ BACK and a missing one fails, even though the write returned 2xx', async () => {
  // The architectural defect behind 6612527: AddAppComponents returned 204 for every corrupt app.
  // A 2xx says the request was accepted, not which rows it wrote. Model a platform that accepts the
  // write and stores only one of the two tables.
  const tables = ['account', 'contact'];
  const { sdk } = freshSdk(tables, { componentRows: [{ objectid: META.account, componenttype: 1 }] });
  await assert.rejects(() => pushApp(sdk, tables), (e) => {
    assert.ok(/contact/.test(e.message), `the failure must name the missing table: ${e.message}`);
    return true;
  });
});

test('REAL BUNDLE: the exact 6612527 corruption is caught — components present but pointing at `entity`', async () => {
  // "Some table component exists" was true of the corrupt apps too, so the check must compare
  // OBJECTIDs, not counts. Here two rows come back (matching the reporter's two junk rows) but both
  // carry the `entity` table's MetadataId instead of account's/contact's.
  const ENTITY_TABLE_META = 'eeeeeeee-0000-0000-0000-00000000000e';
  const tables = ['account', 'contact'];
  const { sdk } = freshSdk(tables, {
    componentRows: [
      { objectid: ENTITY_TABLE_META, componenttype: 1 },
      { objectid: ENTITY_TABLE_META, componenttype: 1 },
    ],
  });
  await assert.rejects(() => pushApp(sdk, tables), (e) => {
    assert.ok(/account/.test(e.message) && /contact/.test(e.message), `both tables must be reported missing: ${e.message}`);
    return true;
  });
});

test('REAL BUNDLE: an INCONCLUSIVE read-back fails closed (cannot check is not fine)', async () => {
  for (const opts of [{ componentStatus: 503 }, { noAppUnique: true }]) {
    const tables = ['account'];
    const { sdk } = freshSdk(tables, opts);
    await assert.rejects(() => pushApp(sdk, tables), `expected a refusal for ${JSON.stringify(opts)}`);
  }
});

test('REAL BUNDLE: an app with no sitemap tables neither pins nor verifies (no phantom work)', async () => {
  // A page-only app has nothing to pin; the verification must not invent a failure, and the SDK
  // should not spend a network call on an empty component list.
  const { sdk, reqs } = freshSdk([]);
  const def = appDef(
    { solution: { uniqueName: 'EntCompB', publisherPrefix: 'contoso' }, app: { name: 'Pageless', description: '' }, entities: [],
      appShell: { areas: [{ label: 'Main', groups: [{ label: 'G', subAreas: [{ url: 'https://x/y', title: 'Link' }] }] }] } },
    { forms: {}, views: {}, charts: {}, dashboards: {} }
  );
  const art = sdk.createArtifact('app', { name: def.name, uniqueName: 'contoso_pageless', description: '', siteMap: def.siteMap, components: def.components, iconWebResourceId: APP_ICON_ID });
  await assert.doesNotReject(sdk.pushArtifact('app', art.id));
  const call = addComponentsCall(reqs);
  const refs = call ? (call.body.Components || []).filter((c) => c['@odata.id']) : [];
  assert.strictEqual(refs.length, 0, 'no table references for an app with no entity subareas');
});
