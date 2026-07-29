'use strict';
// Guards the vendored, self-contained SDK bundle (scripts/vendor/cds-maker-sdk.cjs):
// it must load in plain Node (no browser), construct, serialize every artifact type
// headlessly via the xmldom DOM shim, and build a real Dataverse push payload.
// Rebuild the bundle with: node scripts/_vendor-build/build.js  (see _vendor-build/).
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');
// The migration's pure intent helpers, used to drive the generic surface in the CONTRACT tests below.
const { formEventsRegionIntent, findFieldCellPointer } = require('../lib/artifact-intent.js');

// Track temp workspace dirs created by the smoke tests and remove them once the suite finishes,
// so repeated runs don't leak directories into the test runner's temp folder.
const tempDirs = [];
function mkTempWorkspace(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function freshSdk(capture) {
  const { createMakerSdk } = require(BUNDLE);
  const ws = mkTempWorkspace('sdk-smoke-');
  const httpClient = {
    get: async () => ({ status: 200, headers: {}, body: {} }),
    post: async (url, body) => {
      if (capture) capture.push({ url, body });
      return { status: 204, headers: { 'odata-entityid': 'https://x/y(11111111-1111-1111-1111-111111111111)' }, body: {} };
    },
    patch: async () => ({ status: 204, headers: {}, body: {} }),
    delete: async () => ({ status: 204, headers: {}, body: {} }),
    put: async () => ({ status: 204, headers: {}, body: {} }),
  };
  const sdk = createMakerSdk({ workspacePath: ws, instanceUrl: 'https://example.crm.dynamics.com', httpClient });
  sdk.initWorkspace();
  return sdk;
}

test('vendored bundle exports createMakerSdk', () => {
  const mod = require(BUNDLE);
  // hardening-2 exposes the FACTORY (the only entry the engine uses); the MakerSdk class is no
  // longer a public export.
  assert.strictEqual(typeof mod.createMakerSdk, 'function');
});

test('createArtifact serializes every artifact type headlessly (no browser)', () => {
  const sdk = freshSdk();
  for (const [type, def] of [
    ['view', { entityLogicalName: 'account', name: 'Smoke View' }],
    ['chart', { entityLogicalName: 'account', name: 'Smoke Chart' }],
    ['form', { entityLogicalName: 'account', name: 'Smoke Form' }],
    ['app', { name: 'Smoke App' }],
  ]) {
    const a = sdk.createArtifact(type, def);
    assert.ok(a && a.id, `${type} artifact should have an id`);
  }
});

test('pushArtifact builds a real FormXML payload headlessly', async () => {
  const capture = [];
  const sdk = freshSdk(capture);
  const form = sdk.createArtifact('form', { entityLogicalName: 'account', name: 'Push Test Form' });
  const result = await sdk.pushArtifact('form', form.id);
  assert.strictEqual(result.success, true);
  assert.ok(capture.length > 0, 'a POST should have been issued');
  const body = capture[0].body;
  assert.ok(typeof body.formxml === 'string' && body.formxml.includes('<form'), 'payload carries FormXML');
});

test('createWebResource posts base64 content + the right webresourcetype (Tier 2)', async () => {
  const capture = [];
  const sdk = freshSdk(capture);
  await sdk.createWebResource({ name: 'new_smoke.js', displayName: 'Smoke', type: 'js', content: 'function f(){return 1;}', publish: false });
  const post = capture.find((c) => /webresourceset/.test(c.url));
  assert.ok(post, 'a POST to /webresourceset was issued');
  assert.strictEqual(post.body.webresourcetype, 3, 'js -> webresourcetype 3');
  assert.strictEqual(post.body.name, 'new_smoke.js');
  // content must be base64 (headless btoa/Buffer path), decoding back to the source
  assert.strictEqual(Buffer.from(post.body.content, 'base64').toString('utf8'), 'function f(){return 1;}');
});

test('vendored SDK exposes the AI methods', () => {
  const { createMakerSdk } = require(BUNDLE);
  const sdk = createMakerSdk({ workspacePath: require('os').tmpdir(), instanceUrl: 'https://x/', httpClient: { get: async () => ({}), post: async () => ({}), patch: async () => ({}), delete: async () => ({}), put: async () => ({}) } });
  for (const m of ['retrieveSetting', 'saveSettingValue', 'getAiReadiness', 'setAppAiFeatures', 'configureRowSummary', 'removeRowSummary']) {
    assert.strictEqual(typeof sdk[m], 'function', `sdk.${m} should be a function`);
  }
});

test('vendored SDK exposes the consolidation methods', () => {
  const { createMakerSdk } = require('../vendor/cds-maker-sdk.cjs');
  const sdk = createMakerSdk({ workspacePath: require('os').tmpdir(), instanceUrl: 'https://x/', httpClient: { get: async () => ({}), post: async () => ({}), patch: async () => ({}), delete: async () => ({}), put: async () => ({}) } });
  for (const m of ['resolveArtifact', 'findArtifact', 'deleteAppCascade', 'seedRecordGraph', 'enrichDefaultViews']) {
    assert.strictEqual(typeof sdk[m], 'function', `sdk.${m} should be a function`);
  }
});

test('CONTRACT: a canonical /bag/c <events> region wires a handler into the retained FormXML headlessly (Tier 2)', () => {
  const { createMakerSdk } = require(BUNDLE);
  const ws = mkTempWorkspace('sdk-evt-');
  const FID = '22222222-2222-2222-2222-222222222222';
  const formXml = '<form><tabs><tab name="general"><columns><column><sections><section><rows /></section></sections></column></columns></tab></tabs></form>';
  let pushedXml = '';
  const httpClient = {
    get: async () => ({ status: 200, headers: { etag: 'W/"1"' }, body: { formid: FID, name: 'F', type: 2, objecttypecode: 'account', formxml: formXml } }),
    post: async () => ({ status: 204, headers: {}, body: {} }),
    patch: async (url, body) => { pushedXml = String((body && body.formxml) || ''); return { status: 204, headers: {}, body: {} }; },
    delete: async () => ({ status: 204, headers: {}, body: {} }),
    put: async () => ({ status: 204, headers: {}, body: {} }),
  };
  const sdk = createMakerSdk({ workspacePath: ws, instanceUrl: 'https://example.crm.dynamics.com', httpClient });
  sdk.initWorkspace();
  return sdk.fetchArtifact('form', FID).then(async (fetched) => {
    assert.ok(fetched, 'form fetched');
    // The engine wires form JS by adding the root-bag <events> region via the generic surface (the
    // retired addFormEventHandler is gone). The adapter mints the handlerUniqueId at serialize.
    const bagC = (fetched.bag && fetched.bag.c) || [];
    const nextI = bagC.reduce((m, e) => Math.max(m, e.i), -1) + 1;
    sdk.addElement('form', FID, '/bag/c', { i: nextI, node: formEventsRegionIntent([{ event: 'onload', library: 'new_smoke.js', function: 'Ticket.onLoad' }]) });
    await sdk.pushArtifact('form', FID);
    assert.match(pushedXml, /Ticket\.onLoad/, 'the handler function is baked into the pushed formxml');
    assert.match(pushedXml, /handlerUniqueId/, 'the adapter minted the handlerUniqueId the caller omitted');
  });
});

test('CONTRACT: removeElement drops a bound field from a fetched form (reconcile can DELETE a field, not only add)', async () => {
  const { createMakerSdk } = require(BUNDLE);
  const ws = mkTempWorkspace('sdk-rmfield-');
  const FID = '22222222-2222-2222-2222-222222222222';
  // A fetched form whose retained formxml carries two bound fields (name + tier). The skill's form
  // reconcile removes a field the edited spec dropped — findFieldCellPointer locates the cell and
  // removeElement drops it. This locks that the bundle can do it via the generic surface.
  const formXml =
    '<form><tabs><tab id="{11111111-1111-1111-1111-111111111111}" name="general"><columns><column><sections>' +
    '<section id="{55555555-5555-5555-5555-555555555555}" name="sec" columns="1"><rows>' +
    '<row><cell id="{c1}"><control id="new_name" classid="{4273EDBD-AC1D-40d3-9FB2-095C621B552D}" datafieldname="new_name" /></cell></row>' +
    '<row><cell id="{c2}"><control id="new_tier" classid="{4273EDBD-AC1D-40d3-9FB2-095C621B552D}" datafieldname="new_tier" /></cell></row>' +
    '</rows></section></sections></column></columns></tab></tabs></form>';
  let pushedXml = '';
  const httpClient = {
    get: async () => ({ status: 200, headers: { etag: 'W/"1"' }, body: { formid: FID, name: 'F', type: 2, objecttypecode: 'new_customer', formxml: formXml } }),
    post: async () => ({ status: 204, headers: {}, body: {} }),
    patch: async (url, body) => { pushedXml = String((body && body.formxml) || ''); return { status: 204, headers: {}, body: {} }; },
    delete: async () => ({ status: 204, headers: {}, body: {} }),
    put: async () => ({ status: 204, headers: {}, body: {} }),
  };
  const sdk = createMakerSdk({ workspacePath: ws, instanceUrl: 'https://example.crm.dynamics.com', httpClient });
  sdk.initWorkspace();
  await sdk.fetchArtifact('form', FID);
  const ptr = findFieldCellPointer(sdk.getArtifact('form', FID), 'new_tier');
  assert.ok(ptr, 'the cell hosting the dropped field is located in the canonical tree');
  sdk.removeElement('form', FID, ptr);
  await sdk.pushArtifact('form', FID);
  assert.ok(/datafieldname="new_name"/.test(pushedXml), 'the kept field survives the push');
  assert.ok(!/datafieldname="new_tier"/.test(pushedXml), 'the removed field is gone from the pushed formxml');
});

// --- SDK safety-boundary contract invariants ------------------------------------------------
// Lock the behaviors the SKILL depends on so a future SDK hardening (GUID normalizer, safe DOM
// element factory, percent-encoding OData query builder) can't silently break the skill when the
// vendored bundle is rebuilt. Each test passes today AND must keep passing after the boundaries
// land — the assertions are chosen so a contract-breaking change (GUID-validating a logical name,
// double-encoding a filter, rejecting free-text XML values) fails here.

// A capturing httpClient that records every request and answers EntityDefinitions set-name lookups
// so queryRecords can resolve a logical name -> entity-set name headlessly.
function captureClient() {
  const reqs = [];
  const metaBody = (url) => {
    const ln = (url.match(/LogicalName='([^']+)'/) || [])[1] || 'x';
    return { MetadataId: '33333333-3333-3333-3333-333333333333', EntitySetName: `${ln}s`, LogicalName: ln };
  };
  const client = {
    get: async (url) => {
      reqs.push({ method: 'GET', url });
      if (/EntityDefinitions\(LogicalName=/i.test(url)) return { status: 200, headers: {}, body: metaBody(url) };
      return { status: 200, headers: {}, body: { value: [] } };
    },
    post: async (url, body) => { reqs.push({ method: 'POST', url, body }); return { status: 204, headers: { 'odata-entityid': 'https://x/y(44444444-4444-4444-4444-444444444444)' }, body: {} }; },
    patch: async (url, body) => { reqs.push({ method: 'PATCH', url, body }); return { status: 204, headers: {}, body: {} }; },
    delete: async (url) => { reqs.push({ method: 'DELETE', url }); return { status: 204, headers: {}, body: {} }; },
    put: async (url, body) => { reqs.push({ method: 'PUT', url, body }); return { status: 204, headers: {}, body: {} }; },
  };
  return { client, reqs };
}
function sdkWith(client) {
  const { createMakerSdk } = require(BUNDLE);
  const ws = mkTempWorkspace('sdk-contract-');
  const sdk = createMakerSdk({ workspacePath: ws, instanceUrl: 'https://example.crm.dynamics.com', httpClient: client });
  sdk.initWorkspace();
  return sdk;
}
// The wire $filter, decoded exactly once by URLSearchParams. Equals the raw OData filter whether the
// SDK sends it unencoded (today) or single-encoded (after the query builder lands); a DOUBLE-encoded
// value decodes to a still-encoded string and fails the equality — catching the classic regression.
function filterOf(url) {
  return new URL(url).searchParams.get('$filter');
}

test('CONTRACT: queryRecords transmits a raw quoted-string OData filter that round-trips (raw filters stay supported; no double-encoding)', async () => {
  const { client, reqs } = captureClient();
  const sdk = sdkWith(client);
  const raw = `uniquename eq 'new_a b' and ismanaged eq false`;
  await sdk.queryRecords('appmodule', { select: ['appmoduleid', 'name'], filter: raw, top: 1 });
  const get = reqs.find((r) => r.method === 'GET' && /appmodules\?/.test(r.url));
  assert.ok(get, 'a GET to the resolved entity set was issued');
  assert.strictEqual(filterOf(get.url), raw, 'the raw filter must survive transport exactly once');
});

test('CONTRACT: queryRecords transmits an UNQUOTED GUID-literal filter unchanged (the solutioncomponent/sitemap pattern the skill uses)', async () => {
  const { client, reqs } = captureClient();
  const sdk = sdkWith(client);
  const raw = `objectid eq 11111111-1111-1111-1111-111111111111`;
  await sdk.queryRecords('solutioncomponent', { select: ['_solutionid_value'], filter: raw, top: 1 });
  const get = reqs.find((r) => r.method === 'GET' && /solutioncomponents\?/.test(r.url));
  assert.strictEqual(filterOf(get.url), raw);
});

test('CONTRACT: name-based SDK methods accept logical/unique names verbatim (never forced through GUID validation)', async () => {
  const { client, reqs } = captureClient();
  const sdk = sdkWith(client);
  // The skill passes NAMES (not GUIDs) to these — a GUID normalizer applied here would reject them.
  await sdk.resolveArtifact('app', { uniqueName: 'new_app' });           // teardown/verify resolve-by-name
  await sdk.setEntityIcon('contoso_widget', { vector: 'contoso_icon', publish: false }); // table icon by logical name
  await sdk.createRelationship({ type: 'OneToMany', schemaName: 'contoso_systemuser_teammember', referencedEntity: 'systemuser', referencingEntity: 'contoso_teammember', lookupSchemaName: 'contoso_LinkedUserId', lookupDisplayName: 'Linked User' });
  try { await sdk.deleteTable('account'); } catch { /* the SDK's deleteTable throws a cosmetic not-found even on success */ }
  // Decode each URL before matching: the SDK's OData query builder single-encodes query
  // values (spaces -> %20, `$select` commas -> %2C), so a raw-string regex would miss the
  // name even though it transmitted fine. The GUID-validation guard is unaffected — if any
  // name-based method had rejected its name argument, the awaits above would have thrown
  // before reaching these assertions. decodeURIComponent recovers the raw names to prove
  // they survived transport (path segments like LogicalName='account' are unencoded already).
  const wire = reqs.map((r) => `${r.method} ${decodeURIComponent(r.url)} ${JSON.stringify(r.body || '')}`).join('\n');
  assert.match(wire, /uniquename eq 'new_app'/i, 'resolveArtifact accepted a unique name');
  assert.match(wire, /contoso_widget/i, 'setEntityIcon accepted a table logical name');
  assert.match(wire, /systemuser/, 'createRelationship kept the system-table logical name');
  assert.match(wire, /LogicalName='account'/i, 'deleteTable accepted a table logical name');
});

test('CONTRACT: free-text sitemap titles/URLs are XML-escaped, not rejected (a safe DOM factory must escape VALUES, only validate NAMES)', async () => {
  const { createMakerSdk } = require(BUNDLE);
  const { appDef } = require('../lib/sdk-build.js');
  const spec = {
    solution: { uniqueName: 'EscA', publisherPrefix: 'new' },
    app: { name: 'R&D <Ops> "Hub"', description: 'a & b < c > d' },
    entities: [{ schemaName: 'new_o', primaryAttribute: { schemaName: 'new_name' }, columns: [] }],
    appShell: { areas: [{ label: 'Sales & Ops', groups: [{ label: 'A & B', subAreas: [
      { entity: 'new_o', title: 'Tom & "Jerry" <x>' },
      { url: 'https://x/y?a=1&b=2&c=<z>', title: 'Link & Go' },
    ] }] }] },
  };
  const def = appDef(spec, { forms: {}, views: {}, charts: {}, dashboards: {} });
  // Drive the PUBLIC surface (the AppAdapter class is no longer a bundle export): create the app and
  // capture the sitemapxml the push serializes.
  let sitemapXml = '';
  const ws = mkTempWorkspace('sdk-esc-');
  const httpClient = {
    get: async () => ({ status: 200, headers: {}, body: {} }),
    post: async (url, body) => { if (/\/sitemaps\b/.test(url) && body && body.sitemapxml) sitemapXml = String(body.sitemapxml); return { status: 204, headers: { 'odata-entityid': 'https://x/y(11111111-1111-1111-1111-111111111111)' }, body: {} }; },
    patch: async () => ({ status: 204, headers: {}, body: {} }),
    delete: async () => ({ status: 204, headers: {}, body: {} }),
    put: async () => ({ status: 204, headers: {}, body: {} }),
  };
  const sdk = createMakerSdk({ workspacePath: ws, instanceUrl: 'https://example.crm.dynamics.com', httpClient });
  sdk.initWorkspace();
  const art = sdk.createArtifact('app', { name: spec.app.name, uniqueName: 'new_escapp', description: spec.app.description, siteMap: def.siteMap, components: def.components });
  await assert.doesNotReject(sdk.pushArtifact('app', art.id), 'special-char titles/URLs must serialize, not throw');
  assert.ok(sitemapXml, 'the sitemap was serialized and posted');
  assert.match(sitemapXml, /&amp;/, 'ampersands in titles/URLs are escaped');
  assert.match(sitemapXml, /a=1&amp;b=2/, 'URL query separators are escaped in the attribute value (not lost or left raw)');
  assert.ok(!/<Title[^>]*>[^<]*&(?!amp;|lt;|gt;|quot;|apos;|#)/.test(sitemapXml), 'no raw unescaped ampersand inside a Title');
});

test('CONTRACT: vendored deleteAppCascade returns a structured { success, deleted, failures } result surfacing child-cleanup failures (teardown relies on this to report orphaned sitemap/genpage rows)', async () => {
  // The app delete succeeds but the cascaded sitemap delete fails (a locked/500 row). The old
  // void contract swallowed this; the skill's teardown now reads result.failures to flag the
  // orphan, so the bundle MUST keep returning the structured result after a re-vendor.
  const APP_ID = '77777777-7777-7777-7777-777777777777';
  const APP_UNIQUE = '88888888-8888-8888-8888-888888888888';
  const SITEMAP_ID = '99999999-9999-9999-9999-999999999999';
  const client = {
    get: async (url) => {
      if (/EntityDefinitions\(LogicalName=/i.test(url)) {
        const ln = (url.match(/LogicalName='([^']+)'/) || [])[1] || 'x';
        return { status: 200, headers: {}, body: { MetadataId: '33333333-3333-3333-3333-333333333333', EntitySetName: `${ln}s`, LogicalName: ln } };
      }
      // appmodulecomponent (type 62) resolves the app's sitemap id...
      if (/\/appmodulecomponents\?/.test(url)) return { status: 200, headers: {}, body: { value: [{ objectid: SITEMAP_ID, componenttype: 62 }] } };
      // ...and the sitemap row has no GenPageId, so there are no generative pages to cascade.
      if (/\/sitemaps\?/.test(url)) return { status: 200, headers: {}, body: { value: [{ sitemapxml: '<SiteMap></SiteMap>' }] } };
      return { status: 200, headers: {}, body: { value: [] } };
    },
    post: async () => ({ status: 204, headers: {}, body: {} }),
    patch: async () => ({ status: 204, headers: {}, body: {} }),
    delete: async (url) => {
      // The DELETE /sitemaps(<id>) child cleanup fails; the DELETE /appmodules(<id>) primary succeeds.
      if (/\/sitemaps\(/.test(url)) return { status: 500, headers: {}, body: { error: { message: 'sitemap locked' } } };
      return { status: 204, headers: {}, body: {} };
    },
    put: async () => ({ status: 204, headers: {}, body: {} }),
  };
  const sdk = sdkWith(client);
  const result = await sdk.deleteAppCascade(APP_ID, APP_UNIQUE);
  assert.ok(result && typeof result === 'object', 'deleteAppCascade returns a structured result (not void)');
  assert.strictEqual(result.success, false, 'a failed child cleanup makes success=false');
  assert.ok(Array.isArray(result.deleted) && result.deleted.some((d) => d.type === 'app'), 'the primary app delete is reported in deleted[]');
  assert.ok(Array.isArray(result.failures) && result.failures.some((f) => f.type === 'sitemap'), 'the orphaned sitemap cleanup failure is surfaced in failures[]');
});

test('CONTRACT: vendored seedRecordGraph returns { createdIds: { <entity>: [ids] } } (the sample-data phase reads createdIds to bind children)', async () => {
  // The build's sample-data phase (entity-provision.js) calls
  //   sdk.seedRecordGraph([{ entityLogical, matchOn?, records:[{ body, binds }] }],
  //                       { entitySetFor, createdIds })
  // and destructures `createdIds`, then reads createdIds[<entityLogical>] to bind children — so
  // the bundle MUST keep returning that exact shape (not a bare id array) across a re-vendor.
  // Stub CreateMultiple ({ Ids:[...] }) + an empty resolve-by-name GET; entitySetFor supplies the
  // set name so no EntityDefinitions lookup is needed.
  const client = {
    get: async (url) => {
      // The SDK resolves the collection URL from EntityDefinitions when no set name is cached.
      const meta = /EntityDefinitions\(LogicalName='([^']+)'\)/.exec(url);
      if (meta) return { status: 200, headers: {}, body: { EntitySetName: `${meta[1]}s`, LogicalName: meta[1] } };
      return { status: 200, headers: {}, body: { value: [] } };
    },
    post: async (url, body) => {
      if (/CreateMultiple/.test(url)) {
        const n = ((body && body.Targets) || []).length;
        return { status: 200, headers: {}, body: { Ids: Array.from({ length: n }, (_, i) => `wid-${i}`) } };
      }
      return { status: 204, headers: {}, body: {} };
    },
    patch: async () => ({ status: 204, headers: {}, body: {} }),
    delete: async () => ({ status: 204, headers: {}, body: {} }),
    put: async () => ({ status: 204, headers: {}, body: {} }),
  };
  const sdk = sdkWith(client);
  const group = {
    entityLogical: 'new_widget',
    matchOn: 'new_name',
    records: [{ body: { new_name: 'A' }, binds: [] }, { body: { new_name: 'B' }, binds: [] }],
  };
  const result = await sdk.seedRecordGraph([group], { createdIds: {} });
  assert.ok(result && typeof result === 'object', 'seedRecordGraph returns a structured result');
  assert.ok(result.createdIds && typeof result.createdIds === 'object', 'result carries a createdIds map keyed by entity logical name');
  assert.deepStrictEqual(result.createdIds.new_widget, ['wid-0', 'wid-1'], 'createdIds[<entity>] lists the new row ids in order');
});

// --- SDK backlog capability fills (re-vendored from cds-maker-sdk hardening-3) -------------------
// These lock the four NEW behaviors the skill now wires: quick-create table flag, OData pagination,
// idempotent global choice, and authored-column full width. Each drives the real vendored bundle so a
// future re-vendor that regresses the behavior fails HERE (the mock-based engine tests can't catch it).

test('CONTRACT: updateTable({ quickCreateEnabled }) PUTs IsQuickCreateEnabled on the entity (the quick-create table flag)', async () => {
  // The build's data-model phase calls sdk.updateTable(logical, { quickCreateEnabled: true }) to enable
  // "Allow quick create" so an authored Quick Create form is reachable from the inline "+ New". The SDK
  // GET-then-PUTs the full EntityDefinitions row with IsQuickCreateEnabled set (a plain Edm.Boolean flag).
  const { client, reqs } = captureClient();
  const sdk = sdkWith(client);
  await sdk.updateTable('contoso_widget', { quickCreateEnabled: true });
  const put = reqs.find((r) => r.method === 'PUT' && /EntityDefinitions\(/i.test(r.url));
  assert.ok(put, 'updateTable issues a PUT to EntityDefinitions');
  assert.strictEqual(put.body && put.body.IsQuickCreateEnabled, true, 'the PUT body sets IsQuickCreateEnabled=true');
});

test('CONTRACT: queryRecords({ paginate:true }) follows @odata.nextLink to completion (full env-wide list, no single-page cap)', async () => {
  // The cross-app page-sharing scan (sitemap-pages.js) enumerates EVERY appmodule with paginate:true so
  // it can never miss an app past the ~5000-row server page. getAbsolute(nextLink) routes back through
  // the injected httpClient.get, so page the result by inspecting the URL for the next-page marker.
  const reqs = [];
  const client = {
    get: async (url) => {
      reqs.push(url);
      if (/EntityDefinitions\(LogicalName=/i.test(url)) return { status: 200, headers: {}, body: { EntitySetName: 'appmodules', LogicalName: 'appmodule' } };
      if (/[?&]nextpage=1/.test(url)) return { status: 200, headers: {}, body: { value: [{ appmoduleid: 'a2' }] } };
      return { status: 200, headers: {}, body: { value: [{ appmoduleid: 'a1' }], '@odata.nextLink': 'https://example.crm.dynamics.com/api/data/v9.0/appmodules?nextpage=1' } };
    },
    post: async () => ({ status: 204, headers: {}, body: {} }),
    patch: async () => ({ status: 204, headers: {}, body: {} }),
    delete: async () => ({ status: 204, headers: {}, body: {} }),
    put: async () => ({ status: 204, headers: {}, body: {} }),
  };
  const sdk = sdkWith(client);
  const rows = await sdk.queryRecords('appmodule', { select: ['appmoduleid'], paginate: true });
  assert.deepStrictEqual(rows.map((r) => r.appmoduleid), ['a1', 'a2'], 'both pages are returned (nextLink was followed)');
  assert.strictEqual(reqs.filter((u) => /appmodules/.test(u)).length, 2, 'exactly two data pages were fetched');
});

test('CONTRACT: queryRecords rejects paginate combined with top or fetchXml (both silently cap the result)', async () => {
  // Dataverse honors $top as a hard cap and omits @odata.nextLink; FetchXML pages via a cookie, not
  // @odata.nextLink. Either combined with paginate would silently return one page, so the SDK throws
  // BEFORE any request — the scan must never pass top alongside paginate.
  const { client } = captureClient();
  const sdk = sdkWith(client);
  await assert.rejects(() => sdk.queryRecords('appmodule', { paginate: true, top: 1 }), /paginate.*top/i, 'paginate + top is rejected');
  await assert.rejects(() => sdk.queryRecords('appmodule', { paginate: true, fetchXml: '<fetch/>' }), /paginate.*fetchXml|fetchXml.*paginate/i, 'paginate + fetchXml is rejected');
});

test('CONTRACT: queryRecords({ paginate:true }) THROWS on a malformed page instead of silently dropping rows', async () => {
  // A well-formed OData collection page always carries `value` as an array (empty only on the last page).
  // A missing/null/non-array `value` — or a bare-string `value` that `for..of` would iterate char-by-char
  // — must fail LOUD (returning partial results silently under-counts, which is dangerous for the
  // cross-app page scan and cascade-delete enumeration). The single-page (non-paginate) path stays lenient.
  const meta = (url) => { const ln = (url.match(/LogicalName='([^']+)'/) || [])[1] || 'x'; return { status: 200, headers: {}, body: { MetadataId: '33333333-3333-3333-3333-333333333333', EntitySetName: `${ln}s`, LogicalName: ln } }; };

  // (a) malformed MID-pagination: page 1 is a valid page + nextLink, page 2 has value:null → THROW (not page-1-only).
  const midClient = {
    get: async (url) => {
      if (/EntityDefinitions\(LogicalName=/i.test(url)) return meta(url);
      if (/[?&]np=1/.test(url)) return { status: 200, headers: {}, body: { value: null } };
      return { status: 200, headers: {}, body: { value: [{ appmoduleid: 'a1' }], '@odata.nextLink': 'https://example.crm.dynamics.com/api/data/v9.0/appmodules?np=1' } };
    },
    post: async () => ({ status: 204, headers: {}, body: {} }), patch: async () => ({ status: 204, headers: {}, body: {} }), delete: async () => ({ status: 204, headers: {}, body: {} }), put: async () => ({ status: 204, headers: {}, body: {} }),
  };
  await assert.rejects(() => sdkWith(midClient).queryRecords('appmodule', { paginate: true }), /malformed page|value/i, 'a null mid-pagination value throws, not a silent page-1-only result');

  // (b) bare-string `value` on the FIRST page → THROW (never fabricate single-char "rows" via for..of).
  const strClient = {
    get: async (url) => { if (/EntityDefinitions\(LogicalName=/i.test(url)) return meta(url); return { status: 200, headers: {}, body: { value: 'abc' } }; },
    post: async () => ({ status: 204, headers: {}, body: {} }), patch: async () => ({ status: 204, headers: {}, body: {} }), delete: async () => ({ status: 204, headers: {}, body: {} }), put: async () => ({ status: 204, headers: {}, body: {} }),
  };
  await assert.rejects(() => sdkWith(strClient).queryRecords('appmodule', { paginate: true }), /malformed page|value/i, 'a bare-string value throws (no char-row fabrication)');

  // (c) the single-page (non-paginate) path is UNCHANGED — a missing value is leniently treated as empty.
  const lenientClient = {
    get: async (url) => { if (/EntityDefinitions\(LogicalName=/i.test(url)) return meta(url); return { status: 200, headers: {}, body: {} }; },
    post: async () => ({ status: 204, headers: {}, body: {} }), patch: async () => ({ status: 204, headers: {}, body: {} }), delete: async () => ({ status: 204, headers: {}, body: {} }), put: async () => ({ status: 204, headers: {}, body: {} }),
  };
  const rows = await sdkWith(lenientClient).queryRecords('appmodule', {});
  assert.deepStrictEqual(rows, [], 'the non-paginate single-page path stays lenient (missing value → empty)');
});

test('CONTRACT: createGlobalOptionSet is idempotent by Name — reuses an existing set (no duplicate POST), fixing rebuild id-loss', async () => {
  // On a rebuild the option set already exists. The SDK probes GlobalOptionSetDefinitions(Name=...) and
  // REUSES the existing MetadataId instead of a duplicate-Name POST that would fail — so the engine
  // captures the id and columns bind to it (the old behavior lost the id and fell back to inline options).
  const reqs = [];
  const existingClient = {
    get: async (url) => {
      reqs.push({ method: 'GET', url });
      if (/GlobalOptionSetDefinitions\(Name=/i.test(url)) return { status: 200, headers: {}, body: { MetadataId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' } };
      return { status: 200, headers: {}, body: { value: [] } };
    },
    post: async (url, body) => { reqs.push({ method: 'POST', url, body }); return { status: 204, headers: { 'odata-entityid': 'https://x/y(bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb)' }, body: {} }; },
    patch: async () => ({ status: 204, headers: {}, body: {} }),
    delete: async () => ({ status: 204, headers: {}, body: {} }),
    put: async () => ({ status: 204, headers: {}, body: {} }),
  };
  const reuseSdk = sdkWith(existingClient);
  const reused = await reuseSdk.createGlobalOptionSet({ name: 'new_sev', displayName: 'Sev', options: [{ value: 100000000, label: 'Low' }] });
  assert.strictEqual(reused.metadataId, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'the existing set MetadataId is returned');
  assert.strictEqual(reqs.filter((r) => r.method === 'POST').length, 0, 'no duplicate-Name POST is issued when the set already exists');

  // Absent (404 probe) → a normal create POST happens.
  const created = [];
  const absentClient = {
    get: async (url) => { if (/GlobalOptionSetDefinitions\(Name=/i.test(url)) return { status: 404, headers: {}, body: {} }; return { status: 200, headers: {}, body: { value: [] } }; },
    post: async (url, body) => { created.push({ url, body }); return { status: 204, headers: { 'odata-entityid': 'https://x/y(cccccccc-cccc-cccc-cccc-cccccccccccc)' }, body: {} }; },
    patch: async () => ({ status: 204, headers: {}, body: {} }),
    delete: async () => ({ status: 204, headers: {}, body: {} }),
    put: async () => ({ status: 204, headers: {}, body: {} }),
  };
  const freshSdk2 = sdkWith(absentClient);
  await freshSdk2.createGlobalOptionSet({ name: 'new_sev', displayName: 'Sev', options: [{ value: 100000000, label: 'Low' }] });
  assert.strictEqual(created.length, 1, 'an absent set (404 probe) is created with one POST');
  assert.ok(/GlobalOptionSetDefinitions/i.test(created[0].url), 'the create POSTs to GlobalOptionSetDefinitions');
});

// --- Security authoring surface (Group N P1) -----------------------------------------------

test('CONTRACT: the vendored facade exposes the security-authoring methods the engine calls', () => {
  const sdk = freshSdk();
  for (const m of ['createPersonaRole', 'createSecurityRole', 'deleteSecurityRole', 'associateRecords']) {
    assert.strictEqual(typeof sdk[m], 'function', `facade must expose ${m}()`);
  }
});

test('CONTRACT: the vendored bundle still carries the exact SDK role-ownership marker the plugin hardcodes', () => {
  // teardown + verify re-implement the SEC-1 ownership guard by string-matching this marker (the SDK
  // does not export it). If a re-vendored bundle changes the marker text, teardown would stop
  // recognizing its own roles (leak) and verify would false-fail — so pin the exact string here.
  const { SDK_ROLE_MARKER } = require('../lib/app-spec.js');
  const bundle = fs.readFileSync(BUNDLE, 'utf8');
  assert.ok(bundle.includes(SDK_ROLE_MARKER), `the vendored bundle must contain the role marker '${SDK_ROLE_MARKER}'`);
});


