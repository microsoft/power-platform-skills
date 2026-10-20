'use strict';

// Exercise identity through the real SDK and HTTP client over the strict, stateful lifecycle backend.
// A matching name is deliberately a decoy: it must never override a current-layer type-62 component.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createLifecycleOrg } = require('./helpers/fake-lifecycle-org.js');
const { appSitemapLinkRows } = require('./helpers/app-sitemap-link-rows.js');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../lib/maker-sdk.js');
const { runDownload } = require('../download-model-app.js');

const APP = '11111111-1111-4111-8111-111111111111';
const LAYER = '22222222-2222-4222-8222-222222222222';
const SITEMAP = '33333333-3333-4333-8333-333333333333';
const DECOY = '44444444-4444-4444-8444-444444444444';
const COMPONENT = '55555555-5555-4555-8555-555555555555';
const OTHER_APP = '66666666-6666-4666-8666-666666666666';
const OTHER_LAYER = '77777777-7777-4777-8777-777777777777';
const OLD_LAYER = '88888888-8888-4888-8888-888888888888';
const MISSING = '99999999-9999-4999-8999-999999999999';
const UNIQUE = 'contoso_linked';
const xml = (target) => `<SiteMap><Area Id="work"><Group Id="main"><SubArea Id="nav" Url="https://contoso.example/${target}" /></Group></Area></SiteMap>`;
const isForwardLink = (req) => {
  const u = new URL(req.url);
  const filter = u.searchParams.get('$filter') || '';
  return req.method === 'GET' && u.pathname.endsWith('/appmodulecomponents')
    && filter.includes(`_appmoduleidunique_value eq ${LAYER}`) && filter.includes('componenttype eq 62');
};
const navigationUrl = (app) => app.siteMap.areas[0].groups[0].subAreas[0].url;

async function fixture({ savedOnly = false, component = true, sameName = false } = {}) {
  const org = createLifecycleOrg();
  const root = makeTempDir('app-sitemap-link-');
  const wire = [];
  const faults = { answer: null };
  async function send(method, resource, body) {
    const result = await org.request({
      method, url: `${org.API}/${resource}`, headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.ok(result.statusCode >= 200 && result.statusCode < 300, `${method} ${resource}: ${result.body}`);
    return result;
  }
  const app = (id, layer, uniqueName) => send('POST', 'appmodules', {
    appmoduleid: id, appmoduleidunique: layer, uniquename: uniqueName, name: uniqueName, description: 'Original', clienttype: 4,
  });
  const pin = (layer, sitemap, id) => send('POST', 'appmodulecomponents', {
    ...(id ? { appmodulecomponentid: id } : {}), _appmoduleidunique_value: layer, objectid: sitemap, componenttype: 62, rootcomponentbehavior: 0,
  });
  await app(APP, LAYER, UNIQUE);
  await send('POST', 'sitemaps', { sitemapid: SITEMAP, sitemapname: 'Owned Navigation', sitemapnameunique: sameName ? UNIQUE : 'contoso_navigation', sitemapxml: xml('owned') });
  if (!sameName) await send('POST', 'sitemaps', { sitemapid: DECOY, sitemapname: 'Decoy', sitemapnameunique: UNIQUE, sitemapxml: xml('decoy') });
  if (component) await pin(LAYER, SITEMAP, COMPONENT);
  if (!savedOnly) {
    await send('POST', 'PublishXml', { ParameterXml: `<importexportxml><appmodules><appmodule>${APP}</appmodule></appmodules><sitemaps><sitemap>${SITEMAP}</sitemap>${sameName ? '' : `<sitemap>${DECOY}</sitemap>`}</sitemaps></importexportxml>` });
  }
  const httpClient = createAzHttpClient(org.origin, {
    getToken: () => 'offline-sitemap-link-token', sleep: async () => {},
    request: async (req) => {
      wire.push(req);
      const answer = faults.answer ? await faults.answer(req) : undefined;
      return answer === undefined ? org.request(req) : answer;
    },
  });
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(path.join(root, 'workspace')), instanceUrl: org.origin, httpClient });
  await sdk.initWorkspace();
  async function share({ stale = false } = {}) {
    await app(OTHER_APP, OTHER_LAYER, 'contoso_other');
    await pin(stale ? OLD_LAYER : OTHER_LAYER, SITEMAP);
  }
  return { sdk, org, root, wire, faults, send, pin, share };
}

function noWrites(f, mark, before) {
  assert.deepEqual(f.org.writes(mark), [], 'no header, sitemap, component, publish or delete was sent');
  assert.deepEqual(f.org.contents(), before, 'every saved and published row is unchanged');
  assert.deepEqual(f.org.unexpected, [], 'the backend understood every actual request');
}

test('link-row fixtures filter by both layer and sitemap and project the actual selected columns', () => {
  const apps = [{ appmoduleid: APP, appmoduleidunique: LAYER, componentstate: 1 }];
  const components = [
    { _appmoduleidunique_value: LAYER, objectid: SITEMAP, componenttype: 62 },
    { _appmoduleidunique_value: OTHER_LAYER, objectid: DECOY, componenttype: 62 },
    { _appmoduleidunique_value: LAYER, objectid: DECOY, componenttype: 1 },
  ];
  const get = (query) => appSitemapLinkRows(`https://contoso.crm.dynamics.com/api/data/v9.0/${query}`, { apps, components });
  assert.deepEqual(get(`appmodulecomponents?$select=objectid&$filter=_appmoduleidunique_value eq ${LAYER} and componenttype eq 62`), [{ objectid: SITEMAP }]);
  assert.deepEqual(get(`appmodulecomponents?$select=_appmoduleidunique_value&$filter=componenttype eq 62 and objectid eq ${DECOY}`), [{ _appmoduleidunique_value: OTHER_LAYER }]);
  assert.deepEqual(get(`appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=appmoduleid&$filter=appmoduleidunique eq ${OTHER_LAYER}`), []);
  assert.equal(get('appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=appmoduleid,appmoduleidunique,uniquename,componentstate'), undefined, 'the plugin-wide draft scan is not a per-app identity lookup');
  assert.equal(get('roles?$select=roleid'), undefined, 'unrelated reads are not invented');
  assert.throws(() => get(`appmodulecomponents?$select=unknown&$filter=componenttype eq 62 and objectid eq ${SITEMAP}`), /Unmodeled/);
});

test('REAL BUNDLE: current-layer type-62 navigation wins over a same-name decoy and an old layer', async () => {
  const f = await fixture();
  await f.pin(OLD_LAYER, DECOY);
  const mark = f.org.mark();
  const before = f.org.contents();
  assert.equal(navigationUrl(await f.sdk.fetchArtifact('app', APP)), 'https://contoso.example/owned');
  noWrites(f, mark, before);
  assert.ok(f.wire.some(isForwardLink), 'the current layer, not the matching sitemap name, was resolved');
});

test('REAL BUNDLE: saved-only and renamed navigation is fetched without publishing or borrowing the decoy', async () => {
  const f = await fixture({ savedOnly: true });
  await f.send('PATCH', `sitemaps(${SITEMAP})`, { sitemapnameunique: 'contoso_renamed_navigation', sitemapxml: xml('saved-only') });
  const mark = f.org.mark();
  const before = f.org.contents();
  assert.equal(navigationUrl(await f.sdk.fetchArtifact('app', APP)), 'https://contoso.example/saved-only');
  noWrites(f, mark, before);
  assert.equal(f.org.rowsOf('appmodules').get(APP).published, null);
});

test('REAL BUNDLE: a pending current layer wins even when the published app row is returned first', async () => {
  const f = await fixture();
  await f.pin(OLD_LAYER, DECOY);
  f.faults.answer = (req) => {
    const u = new URL(req.url);
    if (u.pathname.includes('/appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()')
        && (u.searchParams.get('$select') || '').includes('componentstate')) {
      return { statusCode: 200, headers: {}, body: JSON.stringify({ value: [
        { appmoduleid: APP, appmoduleidunique: OLD_LAYER, componentstate: 0 },
        { appmoduleid: APP, appmoduleidunique: LAYER, componentstate: 1 },
      ] }) };
    }
    return undefined;
  };
  const mark = f.org.mark();
  const before = f.org.contents();
  assert.equal(navigationUrl(await f.sdk.fetchArtifact('app', APP)), 'https://contoso.example/owned');
  noWrites(f, mark, before);
});

const identityFaults = ['missing-layer', 'ambiguous-current-layer', 'missing-sitemap', 'ambiguous-component', 'failed-component'];
for (const [fault, operation] of identityFaults.flatMap((fault) => ['fetch', 'delete'].map((operation) => [fault, operation]))) {
  test(`REAL BUNDLE: ${fault} refuses ${operation} instead of using the same-name decoy`, async () => {
    const f = await fixture();
    if (fault === 'missing-sitemap') await f.send('PATCH', `appmodulecomponents(${COMPONENT})`, { objectid: MISSING });
    if (fault === 'ambiguous-component') await f.pin(LAYER, DECOY);
    f.faults.answer = (req) => {
      const u = new URL(req.url);
      if (['missing-layer', 'ambiguous-current-layer'].includes(fault) && u.pathname.includes('/appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()')
          && (u.searchParams.get('$select') || '').includes('componentstate')) {
        const rows = fault === 'missing-layer' ? [{ appmoduleid: APP, componentstate: 0 }] : [
          { appmoduleid: APP, appmoduleidunique: LAYER, componentstate: 1 },
          { appmoduleid: APP, appmoduleidunique: OTHER_LAYER, componentstate: 1 },
        ];
        return { statusCode: 200, headers: {}, body: JSON.stringify({ value: rows }) };
      }
      if (fault === 'failed-component' && isForwardLink(req)) return { statusCode: 503, headers: {}, body: '{"error":{"message":"injected read failure"}}' };
      return undefined;
    };
    const mark = f.org.mark();
    const before = f.org.contents();
    await assert.rejects(operation === 'fetch' ? f.sdk.fetchArtifact('app', APP) : f.sdk.deleteAppCascade(APP, LAYER),
      (e) => e.code === 'APP_SITEMAP_UNRESOLVED');
    await assert.rejects(async () => await f.sdk.getArtifact('app', APP), (e) => e.code === 'ARTIFACT_NOT_FOUND', 'no partial app is persisted');
    noWrites(f, mark, before);
  });
}

test('REAL BUNDLE: a same-name fallback pinned by another live app is a graceful failed download with no output', async () => {
  const f = await fixture({ component: false, sameName: true });
  await f.share();
  const outDir = path.join(f.root, 'download');
  fs.mkdirSync(outDir);
  const genpage = { read: async () => { throw new Error('page reads must not start'); } };
  const mark = f.org.mark();
  const before = f.org.contents();
  const result = await runDownload({ sdk: f.sdk, genpage, outDir, appId: APP, appUnique: UNIQUE });
  assert.equal(result.ok, false);
  assert.match(result.error, /cannot read app /);
  assert.match(result.error, /navigation of app .*not this app's/);
  assert.deepEqual(fs.readdirSync(outDir), [], 'no success-shaped partial spec or page folders');
  noWrites(f, mark, before);
});

test('REAL BUNDLE: a same-name fallback shared after fetch refuses the push before any write', async () => {
  const f = await fixture({ component: false, sameName: true });
  await f.sdk.fetchArtifact('app', APP);
  await f.sdk.updateElement('app', APP, '/description', 'My edit');
  await f.share();
  const mark = f.org.mark();
  const before = f.org.contents();
  await assert.rejects(f.sdk.pushArtifact('app', APP), (e) => e.code === 'APP_SITEMAP_SHARED');
  noWrites(f, mark, before);
});

for (const method of ['deleteRemoteArtifact', 'deleteAppCascade']) {
  test(`REAL BUNDLE: ${method} refuses a component-linked sitemap another current app pins`, async () => {
    const f = await fixture();
    await f.share();
    assert.equal(navigationUrl(await f.sdk.fetchArtifact('app', APP)), 'https://contoso.example/owned', 'a component-linked shared sitemap remains readable');
    const mark = f.org.mark();
    const before = f.org.contents();
    await assert.rejects(f.sdk[method](...(method === 'deleteAppCascade' ? [APP, LAYER] : ['app', APP])), (e) => e.code === 'APP_SITEMAP_SHARED');
    noWrites(f, mark, before);
  });
}

test('REAL BUNDLE: an inconclusive reverse-owner read refuses delete before either row is touched', async () => {
  const f = await fixture();
  f.faults.answer = (req) => {
    const u = new URL(req.url);
    if (u.pathname.endsWith('/appmodulecomponents') && (u.searchParams.get('$filter') || '').includes(`objectid eq ${SITEMAP}`)) {
      return { statusCode: 503, headers: {}, body: '{"error":{"message":"injected owner read failure"}}' };
    }
    return undefined;
  };
  const mark = f.org.mark();
  const before = f.org.contents();
  await assert.rejects(f.sdk.deleteAppCascade(APP, LAYER), (e) => e.code === 'APP_SITEMAP_UNRESOLVED');
  noWrites(f, mark, before);
});

test('REAL BUNDLE: an old-layer pin is not mistaken for another app currently sharing the sitemap', async () => {
  const f = await fixture();
  await f.share({ stale: true });
  const otherBefore = structuredClone(f.org.rowsOf('appmodules').get(OTHER_APP));
  const decoyBefore = structuredClone(f.org.rowsOf('sitemaps').get(DECOY));
  const result = await f.sdk.deleteAppCascade(APP, LAYER);
  assert.equal(result.success, true, JSON.stringify(result.failures));
  assert.equal(f.org.rowsOf('appmodules').has(APP), false);
  assert.equal(f.org.rowsOf('sitemaps').has(SITEMAP), false);
  assert.deepEqual(f.org.rowsOf('appmodules').get(OTHER_APP), otherBefore);
  assert.deepEqual(f.org.rowsOf('sitemaps').get(DECOY), decoyBefore);
  assert.deepEqual(f.org.unexpected, []);
});

test('REAL BUNDLE: a relink after fetch refuses the held copy before its header or old sitemap is written', async () => {
  const f = await fixture();
  await f.sdk.fetchArtifact('app', APP);
  await f.sdk.updateElement('app', APP, '/description', 'My edit');
  await f.send('PATCH', `appmodulecomponents(${COMPONENT})`, { objectid: DECOY });
  const mark = f.org.mark();
  const before = f.org.contents();
  await assert.rejects(f.sdk.pushArtifact('app', APP), (e) => e.code === 'APP_SITEMAP_UNRESOLVED' && /no longer|now/.test(e.message));
  noWrites(f, mark, before);
});

for (const operation of ['fetch', 'delete']) {
  test(`REAL BUNDLE: a relink during ${operation}'s final identity proof refuses before persisting or deleting`, async () => {
    const f = await fixture();
    let reads = 0;
    f.faults.answer = (req) => {
      if (isForwardLink(req) && ++reads === 2) {
        // Another writer relinks this owned fixture between the two proof reads. Only this component
        // changes; the SDK must neither persist a partial app nor write either candidate sitemap.
        f.org.rowsOf('appmodulecomponents').get(COMPONENT).data.objectid = DECOY;
      }
      return undefined;
    };
    const mark = f.org.mark();
    const before = f.org.contents();
    await assert.rejects(operation === 'fetch' ? f.sdk.fetchArtifact('app', APP) : f.sdk.deleteAppCascade(APP, LAYER),
      (e) => e.code === 'APP_SITEMAP_UNRESOLVED');
    assert.equal(reads, 2, 'the link is re-read after the sitemap, not trusted from its first snapshot');
    assert.deepEqual(f.org.writes(mark), []);
    await assert.rejects(async () => await f.sdk.getArtifact('app', APP), (e) => e.code === 'ARTIFACT_NOT_FOUND');
    const after = f.org.contents();
    delete before[`row appmodulecomponents ${COMPONENT}`];
    delete after[`row appmodulecomponents ${COMPONENT}`];
    assert.deepEqual(after, before, 'the injected relink is the only change');
    assert.deepEqual(f.org.unexpected, []);
  });
}
