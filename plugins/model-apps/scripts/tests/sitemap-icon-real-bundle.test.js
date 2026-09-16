'use strict';
// REAL-BUNDLE contract tests for sitemap chrome removal (AB#6688906).
//
// The report was "sitemap reconciliation retains obsolete Icon when switching to VectorIcon". The SDK
// half of that is fixed upstream, but MEASURING it here changed the conclusion about the plugin, so
// both halves are pinned below and each says which path it speaks for.
//
// WHOLE-NODE REPLACE (what `sdk-build.js` does — `updateElement('app', id, '/siteMap', appDef(...).siteMap)`)
//   `appDef` projects the sitemap fresh from the App Spec, so the node handed to `updateElement` is a
//   brand-new object tree with no `bag`. Nothing is merged forward, so a dropped `icon` cannot survive
//   — MEASURED identical on the pre- and post-fix bundles. The plugin never exhibited AB#6688906 here.
//
// IN-PLACE MUTATE (what the SDK's own reproduction does, and what any future in-place reconcile would)
//   The fetched node keeps its `bag`, so `mergeAttrs` carried the deployed `Icon` forward forever. This
//   is the real defect, and the fix is what these tests exist to keep.
//
// Both are worth pinning. The first documents a load-bearing and non-obvious property of the plugin's
// path — full replacement — which a change to in-place reconcile would silently reverse, walking the
// plugin straight into the bug. The second is the only executable check of the fix available here (the
// SDK's own Jest suite cannot run in this repo: its `canvas` native module is built for the Node-20 ABI).
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');

const APP_ID = '11111111-1111-1111-1111-111111111111';
const APP_UNIQUE = 'new_probeapp';
const APP_IDUNIQUE = '33333333-3333-3333-3333-333333333333';
const TABLE_METADATA_ID = '22222222-2222-2222-2222-222222222222';
const SITEMAP_ID = '55555555-5555-5555-5555-555555555555';

// A DEPLOYED sitemap carrying the legacy raster `Icon` plus chrome the plugin never emits
// (`Contoso.*` resource ids). The chrome is what makes "was the bag carried forward?" observable
// independently of the icon, so a test cannot pass for the wrong reason.
const DEPLOYED_SITEMAP_XML =
  '<SiteMap IntroducedVersion="7.0.0.0">'
  + '<Area Id="Area1" Icon="/WebResources/contoso_area.png" ShowGroups="true" ResourceId="Contoso.AreaRes">'
  + '<Titles><Title LCID="1033" Title="Main" /></Titles>'
  + '<Group Id="Group1" ResourceId="Contoso.GroupRes"><Titles><Title LCID="1033" Title="Main" /></Titles>'
  + '<SubArea Id="Sub1" Entity="new_torder" Icon="contoso_legacy.png" ResourceId="Contoso.SubRes" ToolTipResourseId="Contoso.Tip" Client="All" Sku="All">'
  + '<Titles><Title LCID="1033" Title="Orders" /></Titles>'
  + '</SubArea></Group></Area></SiteMap>';

const VECTOR_REF = '$webresource:contoso_vec.svg';

const tempDirs = [];
test.after(() => { for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true }); });

/** A real SDK over a fake Dataverse holding {@link DEPLOYED_SITEMAP_XML}. */
function freshSdk() {
  const { createMakerSdk } = require(BUNDLE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitemap-icon-'));
  tempDirs.push(dir);
  const posted = [];
  const appRow = () => ({ appmoduleid: APP_ID, appmoduleidunique: APP_IDUNIQUE, name: 'Probe', uniquename: APP_UNIQUE, description: '' });
  const sitemapRow = () => ({ sitemapid: SITEMAP_ID, sitemapnameunique: APP_UNIQUE, sitemapxml: DEPLOYED_SITEMAP_XML, '@odata.etag': 'W/"1"' });
  const httpClient = {
    get: async (url) => {
      const m = /EntityDefinitions\(LogicalName='([^']+)'\)/.exec(url);
      if (m) return { status: 200, headers: {}, body: { LogicalName: m[1], MetadataId: TABLE_METADATA_ID, EntitySetName: `${m[1]}s` } };
      if (/\/appmodulecomponents/.test(url)) {
        // componenttype 62 is the SITEMAP component; 1 is a table. The filter arrives URL-encoded
        // (`componenttype%20eq%2062`), so accept either spacing.
        const wantsSitemap = /componenttype(%20| )eq(%20| )62/.test(url);
        return { status: 200, headers: {}, body: { value: wantsSitemap ? [{ objectid: SITEMAP_ID, componenttype: 62 }] : [{ objectid: TABLE_METADATA_ID, componenttype: 1 }] } };
      }
      // A collection read (`/sitemaps?$filter=…` or the RetrieveUnpublishedMultiple function) answers
      // with `{ value: [...] }`; a by-id read answers with the row itself.
      if (/\/sitemaps/.test(url)) {
        const multi = /RetrieveUnpublishedMultiple/i.test(url) || /\/sitemaps\?/.test(url);
        return { status: 200, headers: { etag: 'W/"1"' }, body: multi ? { value: [sitemapRow()] } : sitemapRow() };
      }
      if (/\/appmodules/.test(url)) {
        const multi = /RetrieveUnpublishedMultiple/i.test(url) || /\/appmodules\?/.test(url);
        return { status: 200, headers: { etag: 'W/"1"' }, body: multi ? { value: [appRow()] } : appRow() };
      }
      if (/\/roles/.test(url)) return { status: 200, headers: {}, body: { value: [{ roleid: '66666666-6666-6666-6666-666666666666' }] } };
      return { status: 200, headers: {}, body: { value: [] } };
    },
    post: async (url, body) => {
      if (/\/sitemaps\b/.test(url) && body && body.sitemapxml) posted.push(String(body.sitemapxml));
      return { status: 204, headers: { 'odata-entityid': `https://x/y(${APP_ID})` }, body: {} };
    },
    patch: async (url, body) => {
      if (/\/sitemaps\(/.test(url) && body && body.sitemapxml) posted.push(String(body.sitemapxml));
      return { status: 204, headers: {}, body: {} };
    },
    delete: async () => ({ status: 204, headers: {}, body: {} }),
    put: async () => ({ status: 204, headers: {}, body: {} }),
  };
  const sdk = createMakerSdk({ workspacePath: dir, instanceUrl: 'https://example.crm.dynamics.com', httpClient });
  sdk.initWorkspace();
  return { sdk, lastSitemapXml: () => posted[posted.length - 1] || '' };
}

/** The `<SubArea …>` start tag only — an Area-level `Icon` must never satisfy a SubArea assertion. */
const subAreaTag = (xml) => (/<SubArea\b[^>]*>/.exec(xml) || [''])[0];

test('REAL BUNDLE: the plugin\u2019s whole-/siteMap replace cannot carry a dropped Icon forward', async () => {
  const { sdk, lastSitemapXml } = freshSdk();
  const deployed = await sdk.fetchArtifact('app', APP_ID);
  assert.strictEqual(deployed.siteMap.areas[0].groups[0].subAreas[0].icon, 'contoso_legacy.png',
    'precondition: the deployed app really does carry the legacy raster icon');

  // Exactly what `sdk-build.js` does: hand `updateElement` a freshly projected siteMap. `appDef` is a
  // pure function of the App Spec, so this tree has no `bag` anywhere in it.
  await sdk.updateElement('app', APP_ID, '/siteMap', {
    areas: [{ id: 'Area1', title: 'Main', groups: [{ id: 'Group1', title: 'Main', subAreas: [{ id: 'Sub1', type: 'Entity', entity: 'new_torder', title: 'Orders', vectorIcon: VECTOR_REF }] }] }],
  });
  await sdk.pushArtifact('app', APP_ID);

  const tag = subAreaTag(lastSitemapXml());
  assert.ok(tag, 'a sitemap was serialized and written');
  assert.match(tag, /VectorIcon="\$webresource:contoso_vec\.svg"/);
  // `\sIcon=` cannot match inside `VectorIcon=` — the preceding character is `r`.
  assert.doesNotMatch(tag, /\sIcon="/, 'the legacy raster icon must not survive the replace');

  // The OTHER half of the same fact, asserted so the mechanism is unambiguous: the deployed bag is
  // DISCARDED, not merged. That is why no icon can survive — and it is also why maker-authored chrome
  // the App Spec does not model does not survive a rebuild either. That trade-off is pre-existing and
  // deliberate (the spec is the source of truth for the sitemap); it is pinned here so a future move
  // to in-place reconcile is a visible decision rather than an accident.
  assert.doesNotMatch(tag, /Contoso\.SubRes/, 'the deployed bag is replaced, not merged');
});

test('REAL BUNDLE: an IN-PLACE reconcile drops a removed Icon while keeping the rest of the bag', async () => {
  // The shape that actually regressed. Before the fix this serialized BOTH `Icon="contoso_legacy.png"`
  // and the new `VectorIcon`, and the deployed app went on rendering the stale raster — MEASURED
  // against the pre-uptake bundle, which fails this test.
  const { sdk, lastSitemapXml } = freshSdk();
  const art = await sdk.fetchArtifact('app', APP_ID);
  const sub = art.siteMap.areas[0].groups[0].subAreas[0];
  delete sub.icon;
  sub.vectorIcon = VECTOR_REF;

  await sdk.updateElement('app', APP_ID, '/siteMap', art.siteMap);
  await sdk.pushArtifact('app', APP_ID);

  const tag = subAreaTag(lastSitemapXml());
  assert.match(tag, /VectorIcon="\$webresource:contoso_vec\.svg"/);
  assert.doesNotMatch(tag, /\sIcon="/, 'the dropped icon must be REMOVED, not merged forward');
  // Removal is per-node and per-key. Everything else the deployed sitemap carried still rides through,
  // which is what distinguishes a removal from a rebuild — and is the guarantee an in-place reconcile
  // exists to provide.
  assert.match(tag, /ResourceId="Contoso\.SubRes"/, 'unrelated bagged chrome survives');
  assert.match(tag, /ToolTipResourseId="Contoso\.Tip"/);
  // Scoped to the node the caller changed: the Area still has its own icon.
  assert.match(lastSitemapXml(), /Icon="\/WebResources\/contoso_area\.png"/, 'the Area icon is untouched');
});
