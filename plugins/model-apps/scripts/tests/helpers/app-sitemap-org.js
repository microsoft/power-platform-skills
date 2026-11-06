'use strict';
// A fake Dataverse for the REAL vendored SDK that holds one app and its sitemap, for tests of how an environment's navigation titles are read and written
// in each language. It is the transport of the plugin's own az-token HttpClient (`createAzHttpClient`), so the SDK is driven through the real client — and the client's
// rules (a request is a FULL URL under the environment, or it is refused) hold for everything a test makes it send, the download's read of the base language included.
// It answers the reads `fetchArtifact('app')` and an app push make, the base-language read a download makes (`organizations?$select=languagecode&$top=1`), and records
// every request and every sitemap the SDK writes:
//
//   const org = createSitemapOrg({ xml: sitemapXml({ area: { 3082: 'Trabajo' } }), baseLanguage: 3082 });
//   const { sdk, dispose } = await createSdk(org, { languageCode: 3082 });     // the SDK as a build makes it: in the language it writes titles in
//   org.requests            every request, in order, as { method, path } with the path below the host, decoded
//   org.written()           the sitemap XML the SDK last wrote, or '' when it wrote none
//
// `org.httpClient` is the SDK's HttpClient, which `makeDownloadSdk(env, { httpClient })` takes too. `organizationAnswer()` replaces the answer to the base-language read
// (a low-level answer: `{ statusCode, headers, body }`, or `{ error }` for a request that failed).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAzHttpClient } = require('../../lib/sdk-http-client.js');

const BUNDLE = path.resolve(__dirname, '..', '..', 'vendor', 'cds-maker-sdk.cjs');
const ENV = 'https://contoso.crm.dynamics.com';
const APP_ID = '11111111-1111-1111-1111-111111111111';
const APP_UNIQUE_ID = '22222222-2222-2222-2222-222222222222';
const APP_UNIQUE = 'contoso_casemanagement';
const SITEMAP_ID = '33333333-3333-3333-3333-333333333333';
const DASH = '44444444-4444-4444-4444-444444444444';
const TABLE_METADATA_ID = '55555555-5555-5555-5555-555555555555';
const ROLE_ID = '66666666-6666-6666-6666-666666666666';

const json = (statusCode, body, headers = {}) => ({ statusCode, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

// `{ 1033: 'Work', 3082: 'Trabajo' }` as the `<Titles>` the platform stores: one `<Title LCID="…" Title="…" />` per language. No languages is no `<Titles>` at all, as
// for a table entry, which the app shows under the table's own name.
const titles = (byLanguage) => {
  const entries = Object.entries(byLanguage || {});
  return entries.length ? `<Titles>${entries.map(([lcid, title]) => `<Title LCID="${lcid}" Title="${title}" />`).join('')}</Titles>` : '';
};

// The sitemap the app designer writes for one area, one group and two entries: a table and a dashboard. Each of area, group and dashboard takes its titles by language.
const sitemapXml = ({ area = {}, group = {}, dashboard = {} } = {}) => '<SiteMap IntroducedVersion="7.0.0.0">'
  + `<Area Id="area_0" ShowGroups="true" ResourceId="SitemapDesigner.NewTitle" DescriptionResourceId="SitemapDesigner.NewTitle" IntroducedVersion="7.0.0.0">${titles(area)}`
  + `<Group Id="group_0_0" ResourceId="SitemapDesigner.NewGroup" DescriptionResourceId="SitemapDesigner.NewGroup" ToolTipResourseId="SitemapDesigner.Unknown" IntroducedVersion="7.0.0.0" IsProfile="false">${titles(group)}`
  + '<SubArea Id="sub_0_0_0" Entity="contoso_case" ResourceId="SitemapDesigner.NewSubArea" Client="All,Outlook,OutlookLaptopClient,OutlookWorkstationClient,Web" Sku="All,OnPremise,Live,SPLA" AvailableOffline="true" PassParams="false" />'
  + `<SubArea Id="sub_0_0_1" DefaultDashboard="${DASH}" Url="/workplace/home_dashboards.aspx" ResourceId="SitemapDesigner.NewSubArea" Client="All,Outlook,OutlookLaptopClient,OutlookWorkstationClient,Web" Sku="All,OnPremise,Live,SPLA" AvailableOffline="true" PassParams="false">${titles(dashboard)}</SubArea>`
  + '</Group></Area></SiteMap>';

function createSitemapOrg({ xml, baseLanguage = 1033, organizationAnswer } = {}) {
  const requests = [];
  const writes = [];
  const appRow = () => ({ appmoduleid: APP_ID, appmoduleidunique: APP_UNIQUE_ID, name: 'Case Management', uniquename: APP_UNIQUE, description: '', '@odata.etag': 'W/"1"' });
  const sitemapRow = () => ({ sitemapid: SITEMAP_ID, sitemapnameunique: APP_UNIQUE, sitemapxml: xml, '@odata.etag': 'W/"1"' });
  const etag = { etag: 'W/"1"' };
  const written = (where, body) => {
    let parsed;
    try { parsed = body ? JSON.parse(body) : undefined; } catch { parsed = undefined; }
    if (/\/sitemaps\b/.test(where) && parsed && parsed.sitemapxml) writes.push(String(parsed.sitemapxml));
  };
  async function request({ url, method, body }) {
    const u = new URL(url);
    const where = decodeURIComponent(u.pathname + u.search);
    requests.push({ method, path: where });
    if (method === 'POST') {
      written(where, body);
      return { statusCode: 204, headers: { 'odata-entityid': `${ENV}/api/data/v9.0/appmodules(${APP_ID})` }, body: '' };
    }
    if (method === 'PATCH') {
      written(where, body);
      return { statusCode: 204, headers: {}, body: '' };
    }
    if (method !== 'GET') return { statusCode: 204, headers: {}, body: '' };
    if (/\/organizations\?/.test(where)) {
      return organizationAnswer ? organizationAnswer() : json(200, { value: [{ organizationid: '77777777-7777-7777-7777-777777777777', languagecode: baseLanguage }] });
    }
    const metadata = /EntityDefinitions\(LogicalName='([^']+)'\)/.exec(where);
    if (metadata) return json(200, { LogicalName: metadata[1], MetadataId: TABLE_METADATA_ID, EntitySetName: `${metadata[1]}s` });
    if (/\/appmodulecomponents/.test(where)) {
      const wantsSitemap = /componenttype eq 62/.test(where);
      return json(200, { value: wantsSitemap ? [{ objectid: SITEMAP_ID, componenttype: 62 }] : [{ objectid: TABLE_METADATA_ID, componenttype: 1 }] });
    }
    if (/\/sitemaps/.test(where)) {
      const many = /RetrieveUnpublishedMultiple/i.test(where) || /\/sitemaps\?/.test(where);
      return json(200, many ? { value: [sitemapRow()] } : sitemapRow(), etag);
    }
    if (/\/appmodules/.test(where)) {
      const many = /RetrieveUnpublishedMultiple/i.test(where) || /\/appmodules\?/.test(where);
      return json(200, many ? { value: [appRow()] } : appRow(), etag);
    }
    if (/\/roles/.test(where)) return json(200, { value: [{ roleid: ROLE_ID }] });
    return json(200, { value: [] });
  }
  const httpClient = createAzHttpClient(ENV, { getToken: () => 'token', request, sleep: async () => {} });
  return { httpClient, request, requests, written: () => writes[writes.length - 1] || '' };
}

// The real SDK over that org, in a throwaway workspace `dispose` removes. `languageCode` is the construction-time language the SDK reads and writes sitemap titles in.
async function createSdk(org, { languageCode } = {}) {
  const { createMakerSdk, createNodeWorkspaceStorage } = require(BUNDLE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-sitemap-org-'));
  const sdk = createMakerSdk({
    workspaceStorage: createNodeWorkspaceStorage(dir),
    instanceUrl: ENV,
    httpClient: org.httpClient,
    ...(languageCode ? { languageCode } : {}),
  });
  await sdk.initWorkspace();
  return { sdk, dispose: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

module.exports = { createSitemapOrg, createSdk, sitemapXml, titles, json, ENV, APP_ID, APP_UNIQUE, DASH };
