'use strict';
// REAL-BUNDLE contract tests for sitemap chrome removal (AB#6688906).
//
// The report was "sitemap reconciliation retains obsolete Icon when switching to VectorIcon". The SDK
// half of that is fixed upstream, but MEASURING it here changed the conclusion about the plugin, so
// both halves are pinned below and each says which path it speaks for.
//
// RE-ATTACHED REWRITE (what `sdk-build.js` does for an existing app since AB#6726727)
//   `appDef` projects the sitemap fresh from the App Spec, and `adoptLiveSitemap` re-attaches each node
//   to the live node it corresponds to, keeping that node's `bag` — every attribute and child the App
//   Spec cannot describe. It used to hand `updateElement` the bag-less tree, which could not carry a
//   dropped `icon` forward but also rebuilt every live node from scratch: a designer-made dashboard
//   entry lost its launcher Url and its icon. So the plugin now depends on the SDK's removal rule for
//   a dropped chrome attribute, exactly like an in-place reconcile — which is what the first test pins.
//
// IN-PLACE MUTATE (what the SDK's own reproduction does)
//   The fetched node keeps its `bag`, so `mergeAttrs` carried the deployed `Icon` forward forever. This
//   is the real defect, and the fix is what these tests exist to keep.
//
// The SDK's own Jest suite cannot run in this repo (its `canvas` native module is built for the
// Node-20 ABI), so these are the only executable checks of that fix available here.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { adoptLiveSitemap } = require('../lib/sitemap-merge.js');

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
async function freshSdk() {
  const { createMakerSdk, createNodeWorkspaceStorage } = require(BUNDLE);
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
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: 'https://example.crm.dynamics.com', httpClient });
  await sdk.initWorkspace();
  return { sdk, lastSitemapXml: () => posted[posted.length - 1] || '' };
}

/** The `<SubArea …>` start tag only — an Area-level `Icon` must never satisfy a SubArea assertion. */
const subAreaTag = (xml) => (/<SubArea\b[^>]*>/.exec(xml) || [''])[0];

test('REAL BUNDLE: the plugin\u2019s rewrite removes a dropped Icon and keeps the rest of the live node', async () => {
  const { sdk, lastSitemapXml } = await freshSdk();
  const deployed = await sdk.fetchArtifact('app', APP_ID);
  assert.strictEqual(deployed.siteMap.areas[0].groups[0].subAreas[0].icon, 'contoso_legacy.png',
    'precondition: the deployed app really does carry the legacy raster icon');

  // Exactly what `sdk-build.js` does for an existing app: appDef's bag-less tree (its positional ids),
  // re-attached to the live nodes, then written.
  const desired = {
    areas: [{ id: 'area_0', title: 'Main', groups: [{ id: 'group_0_0', title: 'Main', subAreas: [{ id: 'sub_0_0_0', type: 'Entity', entity: 'new_torder', title: 'Orders', vectorIcon: VECTOR_REF }] }] }],
  };
  const { siteMap } = adoptLiveSitemap(desired, (await sdk.getArtifact('app', APP_ID)).siteMap);
  await sdk.updateElement('app', APP_ID, '/siteMap', siteMap);
  await sdk.pushArtifact('app', APP_ID);

  const tag = subAreaTag(lastSitemapXml());
  assert.ok(tag, 'a sitemap was serialized and written');
  assert.match(tag, /VectorIcon="\$webresource:contoso_vec\.svg"/);
  // `\sIcon=` cannot match inside `VectorIcon=` — the preceding character is `r`.
  assert.doesNotMatch(tag, /\sIcon="/, 'the legacy raster icon the spec dropped must not survive');
  // The node is the live one, not a replacement: its id and the chrome the App Spec cannot describe
  // survive (AB#6726727).
  assert.match(tag, /Id="Sub1"/);
  assert.match(tag, /ResourceId="Contoso\.SubRes"/);
  assert.match(tag, /ToolTipResourseId="Contoso\.Tip"/);
  // Chrome the App Spec DOES model stays the spec's to decide: this spec names no Area icon, so the
  // deployed one is removed, as it was before (a downloaded spec carries it, so a round trip keeps it).
  const areaTag = (/<Area\b[^>]*>/.exec(lastSitemapXml()) || [''])[0];
  assert.match(areaTag, /Id="Area1"/);
  assert.doesNotMatch(areaTag, /\sIcon="/);
  assert.match(areaTag, /ResourceId="Contoso\.AreaRes"/, 'while the Area keeps what the spec cannot describe');
});

test('REAL BUNDLE: an IN-PLACE reconcile drops a removed Icon while keeping the rest of the bag', async () => {
  // The shape that actually regressed. Before the fix this serialized BOTH `Icon="contoso_legacy.png"`
  // and the new `VectorIcon`, and the deployed app went on rendering the stale raster — MEASURED
  // against the pre-uptake bundle, which fails this test.
  const { sdk, lastSitemapXml } = await freshSdk();
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
