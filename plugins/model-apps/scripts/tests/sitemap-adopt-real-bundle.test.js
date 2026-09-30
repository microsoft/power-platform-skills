'use strict';
// REAL-BUNDLE tests for rewriting an existing app's sitemap (AB#6726727).
//
// Reported: an unrelated edit to an app rebuilt its designer-made dashboard entry
//   <SubArea Id="ops_dashboard" Url="/workplace/home_dashboards.aspx" DefaultDashboard="…" Client="All,Web" AvailableOffline="false">
// as a brand-new one
//   <SubArea Id="sub_0_0_0" DefaultDashboard="…" ResourceId="SitemapDesigner.NewSubArea" Client="All,Outlook,…" Sku="…" AvailableOffline="true" PassParams="false">
// and the dashboard's icon became a placeholder. The runtime shows the dashboard glyph only for a
// subarea whose Url is the dashboard launcher, and the SDK serializes a node that arrives without its
// fetched `bag` from scratch — which is what every existing-app build handed it.
//
// These drive the real `appDef`, the real `adoptLiveSitemap` and the real vendored SDK over a fake
// Dataverse, and read the sitemap XML the SDK actually writes.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { appDef } = require('../lib/sdk-build.js');
const { adoptLiveSitemap, chromeByTargetKey, describeSitemapNotes } = require('../lib/sitemap-merge.js');
const { subareaDashboardHasLauncher, subareaHasDashboard } = require('../lib/verify-spec.js');

const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');
const APP_ID = '11111111-1111-1111-1111-111111111111';
const APP_UNIQUE = 'new_eventcenter';
const APP_IDUNIQUE = '33333333-3333-3333-3333-333333333333';
const TABLE_METADATA_ID = '22222222-2222-2222-2222-222222222222';
const SITEMAP_ID = '55555555-5555-5555-5555-555555555555';
const DASH = '280948ec-7bbb-5279-b106-2bdd09451a3a';

// The designer-made entry, with the formatting Dataverse really uses: a braced upper-case GUID and a
// second-language title the App Spec cannot express.
const LEGACY_DASHBOARD_TAG = `<SubArea Id="ops_dashboard" Url="/workplace/home_dashboards.aspx" DefaultDashboard="{${DASH.toUpperCase()}}" Client="All,Web" AvailableOffline="false">`;
const deployedXml = ({ dashTitle = 'Event operations', dashTag = LEGACY_DASHBOARD_TAG } = {}) =>
  '<SiteMap IntroducedVersion="7.0.0.0">'
  + '<Area Id="area_ops" ShowGroups="true" ResourceId="Contoso.AreaRes"><Titles><Title LCID="1033" Title="Operations" /><Title LCID="1036" Title="Opérations" /></Titles>'
  + '<Group Id="grp_main" ResourceId="Contoso.GroupRes" IsProfile="false"><Titles><Title LCID="1033" Title="Main" /></Titles>'
  + `${dashTag}<Titles><Title LCID="1033" Title="${dashTitle}" /><Title LCID="1036" Title="Opérations (FR)" /></Titles></SubArea>`
  + '<SubArea Id="feedback_sub" Entity="new_feedback" Client="All,Web" AvailableOffline="false" ResourceId="Contoso.FeedbackRes"><Titles><Title LCID="1033" Title="Feedback" /></Titles></SubArea>'
  + '</Group></Area></SiteMap>';

const tempDirs = [];
test.after(() => { for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true }); });

/** A real SDK over a fake Dataverse whose app carries `xml` as its sitemap. */
async function freshSdk(xml) {
  const { createMakerSdk, createNodeWorkspaceStorage } = require(BUNDLE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitemap-adopt-'));
  tempDirs.push(dir);
  const written = [];
  const appRow = () => ({ appmoduleid: APP_ID, appmoduleidunique: APP_IDUNIQUE, name: 'Event Center', uniquename: APP_UNIQUE, description: '' });
  const sitemapRow = () => ({ sitemapid: SITEMAP_ID, sitemapnameunique: APP_UNIQUE, sitemapxml: xml, '@odata.etag': 'W/"1"' });
  const httpClient = {
    get: async (url) => {
      const m = /EntityDefinitions\(LogicalName='([^']+)'\)/.exec(url);
      if (m) return { status: 200, headers: {}, body: { LogicalName: m[1], MetadataId: TABLE_METADATA_ID, EntitySetName: `${m[1]}s` } };
      if (/\/appmodulecomponents/.test(url)) {
        const wantsSitemap = /componenttype(%20| )eq(%20| )62/.test(url);
        return { status: 200, headers: {}, body: { value: wantsSitemap ? [{ objectid: SITEMAP_ID, componenttype: 62 }] : [{ objectid: TABLE_METADATA_ID, componenttype: 1 }] } };
      }
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
      if (/\/sitemaps\b/.test(url) && body && body.sitemapxml) written.push(String(body.sitemapxml));
      return { status: 204, headers: { 'odata-entityid': `https://x/y(${APP_ID})` }, body: {} };
    },
    patch: async (url, body) => {
      if (/\/sitemaps\(/.test(url) && body && body.sitemapxml) written.push(String(body.sitemapxml));
      return { status: 204, headers: {}, body: {} };
    },
    delete: async () => ({ status: 204, headers: {}, body: {} }),
    put: async () => ({ status: 204, headers: {}, body: {} }),
  };
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: 'https://contoso.crm.dynamics.com', httpClient });
  await sdk.initWorkspace();
  return { sdk, lastXml: () => written[written.length - 1] || '' };
}

// The downloaded spec's view of that app, with one unrelated edit: a vector icon on Feedback.
const specFor = ({ dashTitle = 'Event operations', feedbackIcon } = {}) => ({
  solution: { uniqueName: 'EventCenter', publisherPrefix: 'new' },
  app: { name: 'Event Center', uniqueName: APP_UNIQUE },
  appShell: { areas: [{ label: 'Operations', groups: [{ label: 'Main', subAreas: [
    { dashboard: 'Command Center - Event operations', title: dashTitle },
    { entity: 'new_feedback', title: 'Feedback', ...(feedbackIcon ? { vectorIcon: feedbackIcon } : {}) },
  ] }] }] },
});
const CREATED = { dashboards: { 'Command Center - Event operations': DASH } };

/** What the build does for an existing app: fetch, appDef, re-attach, write, push. */
async function rebuild(xml, spec, opts = {}) {
  const { sdk, lastXml } = await freshSdk(xml);
  await sdk.fetchArtifact('app', APP_ID);
  const live = await sdk.getArtifact('app', APP_ID);
  const { siteMap, notes } = adoptLiveSitemap(appDef(spec, CREATED).siteMap, live.siteMap, opts);
  await sdk.updateElement('app', APP_ID, '/siteMap', siteMap);
  await sdk.pushArtifact('app', APP_ID);
  return { xml: lastXml(), notes };
}
const tagOf = (xml, re) => ((xml.match(/<SubArea\b[^>]*>/g) || []).find((t) => re.test(t)) || '');

test('REAL BUNDLE: an unrelated edit leaves a designer-made dashboard entry byte-for-byte as it was', async () => {
  const { xml } = await rebuild(deployedXml(), specFor({ feedbackIcon: '$webresource:new_feedback.svg' }));
  assert.ok(xml, 'a sitemap was written');
  assert.ok(xml.includes(`${LEGACY_DASHBOARD_TAG}<Titles><Title LCID="1033" Title="Event operations" /><Title LCID="1036" Title="Opérations (FR)" /></Titles></SubArea>`),
    `the dashboard entry must round-trip unchanged:\n${xml}`);
  assert.doesNotMatch(xml, /SitemapDesigner\.NewSubArea|sub_0_0_0/, 'no node was rebuilt from scratch');
  // The edit itself landed, on the entry's own node, keeping everything else that node carried.
  const feedback = tagOf(xml, /Entity="new_feedback"/);
  assert.match(feedback, /Id="feedback_sub"/);
  assert.match(feedback, /VectorIcon="\$webresource:new_feedback\.svg"/);
  assert.match(feedback, /ResourceId="Contoso\.FeedbackRes"/);
  assert.match(feedback, /AvailableOffline="false"/);
  // Areas and groups keep their ids, attributes and other-language titles too.
  assert.match(xml, /<Area Id="area_ops" ShowGroups="true" ResourceId="Contoso\.AreaRes"><Titles><Title LCID="1033" Title="Operations" \/><Title LCID="1036" Title="Opérations" \/><\/Titles>/);
  assert.match(xml, /<Group Id="grp_main" ResourceId="Contoso\.GroupRes" IsProfile="false">/);
  assert.ok(subareaHasDashboard(xml, DASH) && subareaDashboardHasLauncher(xml, DASH), 'verify passes the entry');
});

test('REAL BUNDLE: an entry an earlier build wrote without the launcher Url gets it back', async () => {
  // The damaged shape from the report. Verify's new check fails it; a rebuild repairs it in place.
  const damaged = `<SubArea Id="sub_0_0_0" DefaultDashboard="${DASH}" ResourceId="SitemapDesigner.NewSubArea" Client="All,Outlook,OutlookLaptopClient,OutlookWorkstationClient,Web" Sku="All,OnPremise,Live,SPLA" AvailableOffline="true" PassParams="false">`;
  const before = deployedXml({ dashTag: damaged });
  assert.ok(subareaHasDashboard(before, DASH) && !subareaDashboardHasLauncher(before, DASH), 'precondition: verify now FAILS the damaged entry');
  const { xml } = await rebuild(before, specFor());
  const tag = tagOf(xml, /DefaultDashboard=/);
  assert.match(tag, /Id="sub_0_0_0"/, 'the same node, not a replacement');
  assert.match(tag, /Url="\/workplace\/home_dashboards\.aspx"/);
  assert.ok(subareaDashboardHasLauncher(xml, DASH));
});

test('REAL BUNDLE: a fresh app\u2019s dashboard entry is written the way the designer writes one', async () => {
  const { sdk, lastXml } = await freshSdk('<SiteMap></SiteMap>');
  const def = appDef(specFor(), CREATED, { iconWebResourceId: '77777777-7777-7777-7777-777777777777' });
  const art = await sdk.createArtifact('app', def);
  await sdk.pushArtifact('app', art.id);
  const xml = lastXml();
  assert.match(tagOf(xml, /DefaultDashboard=/), /Url="\/workplace\/home_dashboards\.aspx"/);
  assert.ok(subareaDashboardHasLauncher(xml, DASH));
});

test('REAL BUNDLE: a nav title renamed in the designer after the download is kept, not reverted', async () => {
  // Downloaded as 'Command Center - Event operations', renamed to 'Event operations' in the designer,
  // then an unrelated edit is built from the stale spec.
  const stale = specFor({ dashTitle: 'Command Center - Event operations', feedbackIcon: '$webresource:new_feedback.svg' });
  const baseline = specFor({ dashTitle: 'Command Center - Event operations' });
  const { xml, notes } = await rebuild(deployedXml({ dashTitle: 'Event operations' }), stale, { baseChrome: chromeByTargetKey(baseline, CREATED) });
  assert.match(xml, /<Title LCID="1033" Title="Event operations" \/>/, 'the designer rename survives');
  assert.doesNotMatch(xml, /Command Center - Event operations/);
  const lines = describeSitemapNotes(notes);
  assert.ok(lines.some((l) => /kept the environment's title 'Event operations'/.test(l)), JSON.stringify(lines));
  // Without a baseline the spec wins — and the build says so rather than doing it silently.
  const noBase = await rebuild(deployedXml({ dashTitle: 'Event operations' }), stale);
  assert.match(noBase.xml, /Title="Command Center - Event operations"/);
  assert.ok(describeSitemapNotes(noBase.notes).some((l) => /title changes from 'Event operations' to the spec's 'Command Center - Event operations'/.test(l)));
});

test('REAL BUNDLE: a title the spec itself changes is applied, with nothing to report', async () => {
  const baseline = specFor();
  const edited = specFor({ dashTitle: 'Live operations' });
  const { xml, notes } = await rebuild(deployedXml(), edited, { baseChrome: chromeByTargetKey(baseline, CREATED) });
  assert.match(xml, /<Title LCID="1033" Title="Live operations" \/><Title LCID="1036" Title="Opérations \(FR\)" \/>/, 'patched in place; the French title stays');
  assert.deepStrictEqual(describeSitemapNotes(notes), []);
});
