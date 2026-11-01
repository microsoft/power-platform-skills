'use strict';
// The page-reference guard (lib/page-reference-guard.js) on an environment with thousands of forms, through the real bundle and the plugin's own HttpClient.
//
// The guard reads every system form of every table, with its formxml, in both layers. Measured on an environment of 3700 forms, ONE answer of the saved layer
// took 80 s — longer than the client's 60 s read timeout — so the read was cut off with ECONNRESET on every attempt and every page delete, and every teardown
// that included pages, failed closed. Asked for 100 forms at a time (`Prefer: odata.maxpagesize=100`), each read takes a few seconds and the scan reads them
// all. helpers/large-form-environment.js models those costs; the fake org of helpers/fake-apps-org.js answers everything else.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../lib/maker-sdk.js');
const { makeGenpageSdk } = require('../lib/genpage-sdk.js');
const { runTeardown } = require('../lib/sdk-teardown.js');
const { manifestResourceName } = require('../lib/page-manifest.js');
const { createFakeAppsOrg, json } = require('./helpers/fake-apps-org.js');
const { appSitemapLinkRows } = require('./helpers/app-sitemap-link-rows.js');
const { largeFormEnvironment, plainForms } = require('./helpers/large-form-environment.js');

const ORIGIN = 'https://contoso.crm.dynamics.com';
const PAGE = '11111111-1111-4111-8111-111111111111';
const APP = '33333333-3333-4333-8333-333333333333';
const LAYER = '44444444-4444-4444-8444-444444444444';
const SITEMAP = '55555555-5555-4555-8555-555555555555';
const MANIFEST_ID = '66666666-6666-4666-8666-666666666666';
const SOLUTION_ID = '88888888-8888-4888-8888-888888888888';
const APP_NAME = 'contoso_probe';
const FORMS = 3700;
const READ_TIMEOUT_MS = 60000;

// A form that embeds PAGE (the shape the SDK writes: a cell control and a UxAgentControl whose static RefId is the page id).
const EMBEDDING = '<form><tabs><tab name="general"/></tabs><controlDescriptions><controlDescription forControl="{bbbbbbbb-0000-4000-8000-000000000001}">'
  + `<customControl name="MscrmControls.UxAgentControl" formFactor="2"><parameters><RefId type="SingleLine.Text" static="true">${PAGE}</RefId></parameters></customControl>`
  + '</controlDescription></controlDescriptions></form>';
// FORMS forms in both layers; `embedded` puts the page on one form of the SAVED layer only, near the end of it, so only a scan that reads every page sees it.
function environmentForms({ embedded = false } = {}) {
  const forms = plainForms(FORMS);
  if (embedded) forms.splice(FORMS - 50, 0, { formid: 'eeeeeeee-0000-4000-8000-000000000001', objecttypecode: 'new_ticket', name: 'Ticket', type: 2, formxml: EMBEDDING, layer: 'saved' });
  return forms;
}

function tempDirs(t) {
  const dirs = [];
  t.after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });
  return (what) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), `contoso-${what}-`)); dirs.push(dir); return dir; };
}

// What the scan cost: the client sends a read again after a reset, so a read cut off at the timeout shows here once per attempt.
function assertEveryReadInsideTheTimeout(env) {
  const { reads, slowestMs } = env.cost();
  assert.ok(env.log.every((e) => e.outcome === 200), `no read was cut off: ${JSON.stringify(env.log.filter((e) => e.outcome !== 200).slice(0, 3))}`);
  assert.ok(slowestMs < READ_TIMEOUT_MS / 10, `every read well inside the 60 s timeout (slowest ${slowestMs} ms)`);
  assert.ok(env.log.every((e) => e.prefer === 'odata.maxpagesize=100'), 'every read, continuations included, asks for 100 forms');
  assert.deepStrictEqual(env.log.map((e) => e.rows).filter((rows) => rows > 100), []);
  assert.strictEqual(reads, 2 * Math.ceil(FORMS / 100), 'one read per 100 forms in each layer');
}

// ── the environment, as measured ─────────────────────────────────────────────────────────────────────────────────────

test(`the modelled environment ends an UNPAGED saved-layer read of ${FORMS} forms as the live run did: cut off at the 60 s timeout, sent again, then a transport failure`, async () => {
  const env = largeFormEnvironment({ forms: environmentForms(), origin: ORIGIN });
  const client = createAzHttpClient(ORIGIN, { getToken: () => 'test-token', request: env.wrap(async () => { throw new Error('only forms are read here'); }), sleep: async () => {} });
  await assert.rejects(client.get(`${ORIGIN}/api/data/v9.0/systemforms/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=formid,objecttypecode,name,type,formxml`), /read ECONNRESET/);
  // The client's six attempts (lib/sdk-http-client.js): the first and five more, each cut off at the timeout.
  assert.deepStrictEqual(env.log.map((e) => [e.layer, e.rows, e.ms, e.outcome]), Array.from({ length: 6 }, () => ['saved', FORMS, READ_TIMEOUT_MS, 'ECONNRESET']));
});

// ── the standalone delete ─────────────────────────────────────────────────────────────────────────────────────────────

async function deleteWorld(t, forms, alter = null) {
  // One app (an environment always has some), whose navigation names no page: the navigation check the delete makes first passes.
  const org = createFakeAppsOrg({
    apps: [{ appmoduleid: APP, appmoduleidunique: LAYER, name: 'Contoso Probe', uniquename: APP_NAME, componentstate: 0, '@odata.etag': 'W/"1001"' }],
    sitemaps: [{ sitemapid: SITEMAP, sitemapnameunique: APP_NAME, sitemapxml: '<SiteMap><Area Id="a"><Group Id="g"><SubArea Id="s" Entity="account"/></Group></Area></SiteMap>', componentstate: 0, '@odata.etag': 'W/"2001"' }],
    pages: [{ id: PAGE, name: 'Overview' }],
    answer: (req) => {
      if (req.method !== 'GET') return null;
      const linked = appSitemapLinkRows(`${ORIGIN}/api/data/v9.0${req.path}`, { apps: org.state.apps, components: [{ _appmoduleidunique_value: LAYER, objectid: SITEMAP, componenttype: 62 }] });
      return linked === undefined ? null : json(200, { value: linked });
    },
  });
  const env = largeFormEnvironment({ forms, origin: ORIGIN, alter });
  const client = createAzHttpClient(ORIGIN, { getToken: () => 'test-token', request: env.wrap(org.request), sleep: async () => {} });
  const tmp = tempDirs(t);
  const genpage = makeGenpageSdk(ORIGIN, { httpClient: client, mkdtempSync: () => tmp('genpage') });
  t.after(() => genpage.dispose());
  return { org, env, genpage };
}

test(`REAL BUNDLE: a page delete on an environment of ${FORMS} forms reads every form of both layers, 100 at a time, each read well inside the timeout — and deletes the page`, async (t) => {
  const { org, env, genpage } = await deleteWorld(t, environmentForms());
  const out = await genpage.delete(PAGE, { allowDestructive: true });
  assert.strictEqual(out.deleted, true);
  assertEveryReadInsideTheTimeout(env);
  assert.deepStrictEqual(org.writes().map((w) => `${w.method} ${w.path}`).filter((w) => w.startsWith('DELETE /uxagentprojects(')), [`DELETE /uxagentprojects(${PAGE})`]);
  assert.deepStrictEqual(org.unexpected, []);
});

test(`REAL BUNDLE: on the same environment a form that embeds the page — in the saved layer, past the 3600th form — still refuses the delete: nothing deleted`, async (t) => {
  const { org, env, genpage } = await deleteWorld(t, environmentForms({ embedded: true }));
  await assert.rejects(genpage.delete(PAGE, { allowDestructive: true }), (e) => {
    assert.strictEqual(e.code, 'GENPAGE_EMBEDDED_IN_FORM', e.message);
    assert.deepStrictEqual(e.references.map((r) => r.forms.map((f) => [f.table, f.layer])), [[['new_ticket', 'saved']]]);
    return true;
  });
  assert.ok(env.log.every((e) => e.outcome === 200));
  assert.deepStrictEqual(org.writes(), [], 'no write at all');
});

// ── the teardown page prelude ─────────────────────────────────────────────────────────────────────────────────────────

// A published app whose navigation names the page, the page manifest that lists it, and the environment's forms. What the fake org does not model — the app's
// sitemap component, the manifest and the web resource and solution deletes — is answered here, as in teardown-navigation-proof-real-bundle.test.js.
async function teardownWorld(t, forms, alter = null) {
  const tmp = tempDirs(t);
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: PAGE }] })).toString('base64');
  const org = createFakeAppsOrg({
    solutions: [{ solutionid: SOLUTION_ID, uniquename: 'ContosoCore', friendlyname: 'Contoso Core', ismanaged: false }],
    apps: [{ appmoduleid: APP, appmoduleidunique: LAYER, name: 'Contoso Probe', uniquename: APP_NAME, componentstate: 0, '@odata.etag': 'W/"1001"' }],
    sitemaps: [{ sitemapid: SITEMAP, sitemapnameunique: APP_NAME, sitemapxml: `<SiteMap><Area Id="a"><Group Id="g"><SubArea Id="p" GenPageId="${PAGE}" Title="Overview"/></Group></Area></SiteMap>`, componentstate: 0, '@odata.etag': 'W/"2001"' }],
    pages: [{ id: PAGE, name: 'Overview' }],
    answer: (req) => {
      if (req.method === 'GET') {
        const linked = appSitemapLinkRows(`${ORIGIN}/api/data/v9.0${req.path}`, { apps: org.state.apps, components: [{ _appmoduleidunique_value: LAYER, objectid: SITEMAP, componenttype: 62 }] });
        if (linked !== undefined) return json(200, { value: linked });
      }
      if (req.method === 'GET' && req.path.startsWith('/webresourceset')) {
        const name = (/name eq '([^']+)'/.exec(req.path) || [])[1];
        return json(200, { value: name === manifestResourceName(APP_NAME) ? [{ webresourceid: MANIFEST_ID, name, content: manifest }] : [] });
      }
      if (req.method === 'DELETE' && /^\/(webresourceset|solutions)\(/.test(req.path)) return { statusCode: 204, headers: {}, body: '' };
      return null;
    },
  });
  const env = largeFormEnvironment({ forms, origin: ORIGIN, alter });
  const client = createAzHttpClient(ORIGIN, { getToken: () => 'test-token', request: env.wrap(org.request), sleep: async () => {} });
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(tmp('sdk')), instanceUrl: ORIGIN, httpClient: client });
  await sdk.initWorkspace();
  const spec = { solution: { uniqueName: 'ContosoCore', publisherPrefix: 'contoso' }, app: { uniqueName: APP_NAME, name: 'Contoso Probe' }, pages: [{ key: 'overview', name: 'Overview' }] };
  const workspaceDir = tmp('workspace');
  const teardown = () => runTeardown(spec, { apply: true, env: ORIGIN, workspaceDir }, { sdk });
  return { org, env, teardown };
}

test(`REAL BUNDLE: a teardown with a page, on an environment of ${FORMS} forms, reads every form 100 at a time before it deletes anything — and deletes the page`, async (t) => {
  const { org, env, teardown } = await teardownWorld(t, environmentForms());
  const result = await teardown();
  assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
  assert.deepStrictEqual(result.deleted.genpage, [PAGE]);
  assertEveryReadInsideTheTimeout(env);
  assert.ok(org.writes().some((w) => w.method === 'DELETE' && w.path === `/uxagentprojects(${PAGE})`));
});

test('REAL BUNDLE: the same teardown, the page embedded in a saved form, deletes nothing', async (t) => {
  const { org, env, teardown } = await teardownWorld(t, environmentForms({ embedded: true }));
  const result = await teardown();
  assert.strictEqual(result.ok, false);
  assert.match(JSON.stringify(result.errors), /embedded in/);
  assert.ok(env.log.every((e) => e.outcome === 200));
  assert.deepStrictEqual(org.writes().filter((w) => w.method === 'DELETE'), [], 'not the app, not the page, not the solution');
});

// ── pages that are not one complete list ──────────────────────────────────────────────────────────────────────────────

// 250 forms in both layers and, in the SAVED layer only, a form at position 120 that embeds the page (a card form: no form type is skipped). Read 100 at a time,
// the embedding form is on the saved layer's second page — the page each case below spoils.
function spoiledForms() {
  const forms = plainForms(250);
  forms.splice(120, 0, { formid: 'eeeeeeee-0000-4000-8000-000000000001', objecttypecode: 'new_ticket', name: 'Ticket', type: 11, formxml: EMBEDDING, layer: 'saved' });
  return forms;
}
const SPOILED = {
  // The second saved page answers the FIRST page's forms again, with a continuation that goes on to the third: every URL is new, but the forms 100 to 199 —
  // the embedding one among them — are never answered.
  'a page that repeats another': {
    alter: ({ layer, at, body, all }) => { if (layer === 'saved' && at === 100) body.value = all.slice(0, 100); },
    refusal: /form f0000000-0000-4000-8000-000000000000 came back twice/,
  },
  // Every saved answer counts the layer's 251 forms, and the second leaves out one: the embedding form.
  'a page short of the count its answer declares': {
    alter: ({ layer, at, body, all }) => {
      if (layer !== 'saved') return;
      body['@odata.count'] = all.length;
      if (at === 100) body.value = body.value.filter((f) => f.type !== 11);
    },
    refusal: /the answer counts 251 forms but its pages held 250/,
  },
};

for (const [what, { alter, refusal }] of Object.entries(SPOILED)) {
  test(`REAL BUNDLE: a page delete whose saved-layer scan has ${what} is refused — nothing deleted`, async (t) => {
    const { org, genpage } = await deleteWorld(t, spoiledForms(), alter);
    await assert.rejects(genpage.delete(PAGE, { allowDestructive: true }), (e) => {
      assert.strictEqual(e.code, 'GENPAGE_FORM_REFERENCES_UNREADABLE', e.message);
      assert.match(e.message, /saved layer could not all be read/);
      assert.match(e.message, refusal);
      return true;
    });
    assert.deepStrictEqual(org.writes(), [], 'no write at all');
    assert.deepStrictEqual(org.unexpected, []);
  });

  test(`REAL BUNDLE: a teardown whose saved-layer scan has ${what} deletes nothing`, async (t) => {
    const { org, teardown } = await teardownWorld(t, spoiledForms(), alter);
    const result = await teardown();
    assert.strictEqual(result.ok, false);
    assert.match(JSON.stringify(result.errors), refusal);
    assert.deepStrictEqual(org.writes().filter((w) => w.method === 'DELETE'), [], 'not the app, not the page, not the solution');
    assert.deepStrictEqual(org.unexpected, []);
  });
}

test('REAL BUNDLE: a count every saved answer declares, with every form on its pages, is no refusal — the embedding form is found', async (t) => {
  const { org, genpage } = await deleteWorld(t, spoiledForms(), ({ layer, body, all }) => { if (layer === 'saved') body['@odata.count'] = all.length; });
  await assert.rejects(genpage.delete(PAGE, { allowDestructive: true }), (e) => e.code === 'GENPAGE_EMBEDDED_IN_FORM');
  assert.deepStrictEqual(org.writes(), []);
});