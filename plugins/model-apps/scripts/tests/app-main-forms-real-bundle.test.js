'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { appDef } = require('../lib/sdk-build.js');
const { applyAppMainForms, resolveMainForms } = require('../lib/app-components.js');
const { membershipSpec, APP, PUBLISHED, FORM_A, FORM_B, META, ICON } = require('./helpers/app-membership-sdk.js');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../vendor/cds-maker-sdk.cjs');
const SITEMAP = '55555555-0000-4000-8000-000000000001';

async function bundleSdk(t, { duplicateNames = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'main-forms-bundle-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const writes = [];
  let sitemapXml = '<SiteMap><Area Id="A"><Titles><Title LCID="1033" Title="Main"/></Titles><Group Id="G">'
    + '<Titles><Title LCID="1033" Title="Records"/></Titles><SubArea Id="Items" Entity="contoso_item">'
    + '<Titles><Title LCID="1033" Title="Items"/></Titles></SubArea></Group></Area></SiteMap>';
  const appRow = { appmoduleid: APP, appmoduleidunique: PUBLISHED, componentstate: 0, name: 'Membership', uniquename: 'contoso_membership', description: '' };
  const sitemapRow = () => ({ sitemapid: SITEMAP, sitemapxml: sitemapXml, sitemapname: 'Membership', sitemapnameunique: 'contoso_membership' });
  const httpClient = {
    get: async (url) => {
      const parsed = new URL(url);
      const filter = parsed.searchParams.get('$filter') || '';
      let body = { value: [] };
      if (url.includes('EntityDefinitions')) body = { MetadataId: META.contoso_item, EntitySetName: 'contoso_items' };
      else if (url.includes('/appmodules')) body = parsed.pathname.endsWith(`appmodules(${APP})`) ? appRow : { value: [appRow] };
      else if (url.includes('/appmodulecomponents')) {
        body = { value: filter.includes('componenttype eq 60')
          ? [{ objectid: FORM_A, componenttype: 60 }]
          : filter.includes('componenttype eq 62') ? [{ objectid: SITEMAP, componenttype: 62 }]
          : [{ objectid: META.contoso_item, componenttype: 1 }] };
      } else if (url.includes('/sitemaps')) {
        body = parsed.pathname.includes('/sitemaps(') ? sitemapRow() : { value: [sitemapRow()] };
      } else if (url.includes('/systemforms')) {
        body = { value: [FORM_A, FORM_B].map((formid, index) => ({
          formid, name: duplicateNames || index === 0 ? 'Summary' : 'Alternate', formactivationstate: 1,
        })) };
      }
      return { status: 200, headers: { ETag: 'W/"1"' }, body };
    },
    post: async (url, body) => {
      writes.push({ url, body });
      const id = body.appmoduleid || body.sitemapid || APP;
      return { status: 204, headers: { 'odata-entityid': `https://contoso.crm.dynamics.com/api/data/v9.2/appmodules(${id})` }, body: null };
    },
    patch: async (url, body) => {
      writes.push({ url, body });
      if (body.sitemapxml !== undefined) sitemapXml = body.sitemapxml;
      return { status: 200, headers: { ETag: 'W/"2"' }, body: { sitemapid: SITEMAP, '@odata.etag': 'W/"2"' } };
    },
    delete: async () => ({ status: 204, headers: {}, body: null }),
    put: async () => ({ status: 204, headers: {}, body: null }),
  };
  const sdk = createMakerSdk({
    workspaceStorage: createNodeWorkspaceStorage(directory),
    instanceUrl: 'https://contoso.crm.dynamics.com', httpClient,
  });
  await sdk.initWorkspace();
  return { sdk, writes };
}

test('REAL BUNDLE: the plugin definition sends only the allowed Main id through create serialization', async (t) => {
  const { sdk, writes } = await bundleSdk(t);
  const definition = appDef(membershipSpec({ hidden: false }), { forms: { contoso_item: FORM_B } },
    { mainFormsByTable: { contoso_item: [FORM_A] }, iconWebResourceId: ICON });
  const artifact = await sdk.createArtifact('app', { ...definition, id: APP });
  const result = await sdk.pushArtifact('app', artifact.id);
  assert.equal(result.saved, true, JSON.stringify(result));
  const pin = writes.find((write) => write.url.endsWith('/AddAppComponents'));
  assert.ok(pin, 'the real SDK must perform the component write');
  assert.deepEqual(pin.body.Components.filter((component) => component.formid).map((component) => component.formid), [FORM_A]);
  assert.ok(!JSON.stringify(pin.body).includes(FORM_B), 'the excluded created Main id must never reach AddAppComponents');
});

test('REAL BUNDLE: explicitly pinning an excluded Main id refuses create before any app write', async (t) => {
  const { sdk, writes } = await bundleSdk(t);
  const definition = appDef(membershipSpec({ hidden: false }), {},
    { mainFormsByTable: { contoso_item: [FORM_A] }, iconWebResourceId: ICON });
  definition.components.forms = [FORM_B];
  await assert.rejects(async () => {
    const artifact = await sdk.createArtifact('app', { ...definition, id: APP });
    const result = await sdk.pushArtifact('app', artifact.id);
    if (result.saved === false) throw result.error;
  }, /outside its allow-list|conflict/);
  assert.deepEqual(writes, [], 'catalog validation must precede appmodule, sitemap and component writes');
});

test('REAL BUNDLE: a fetched app accepts the root directive and its update never sends an excluded Main id', async (t) => {
  const { sdk, writes } = await bundleSdk(t);
  await sdk.fetchArtifact('app', APP);
  const fetched = await sdk.getArtifact('app', APP);
  assert.equal(fetched.components && fetched.components.mainFormsByTable, undefined, 'a server fetch does not reconstruct the directive');
  await applyAppMainForms(sdk, APP, { contoso_item: [FORM_A] });
  const result = await sdk.pushArtifact('app', APP);
  assert.equal(result.saved, true, JSON.stringify(result));
  const pin = writes.find((write) => write.url.endsWith('/AddAppComponents'));
  assert.ok(pin, 'the real SDK update must apply the fetched directive');
  assert.deepEqual(pin.body.Components.filter((component) => component.formid).map((component) => component.formid), [FORM_A]);
  assert.ok(!JSON.stringify(pin.body).includes(FORM_B));
});

test('REAL BUNDLE: a pinned formId cannot bypass active name ambiguity before any app write', async (t) => {
  const { sdk, writes } = await bundleSdk(t, { duplicateNames: true });
  const spec = membershipSpec({ hidden: false });
  spec.forms = [{ entity: 'contoso_item', name: 'Summary', formId: FORM_A }];
  await assert.rejects(async () => {
    const mainFormsByTable = await resolveMainForms(sdk.dataverse, spec, { 'contoso_item|Main|Summary': FORM_A });
    const definition = appDef(spec, { forms: { contoso_item: FORM_A } }, { mainFormsByTable, iconWebResourceId: ICON });
    const artifact = await sdk.createArtifact('app', { ...definition, id: APP });
    const result = await sdk.pushArtifact('app', artifact.id);
    if (result.saved === false) throw result.error;
  }, (error) => error.code === 'APP_MAIN_FORM_AMBIGUOUS' && /Summary.*contoso_item/.test(error.message));
  assert.deepEqual(writes, [], 'ambiguity must be refused before appmodule, sitemap, component or publish writes');
});
