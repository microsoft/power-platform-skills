'use strict';
// REAL BUNDLE: the app's NAME and DESCRIPTION on a rebuild, and why its ICON is not among them.
//
// The plugin's `applyAppHeader` (sdk-build.js) edits an existing app's header text on the artifact a fetch just read, so that the
// ONE push that already writes the sitemap writes it too. That leans on SDK behaviour the plugin's own unit tests can only stub:
//   1. a fetched app carries `name` and `description` (the adapter reads `description` as '' when the row has none), so
//      `updateElement('/name')` and `updateElement('/description')` have a path to write;
//   2. the push PATCHes the appmodule header — `name` and `description`, plus `aiappdescription` only when the artifact says
//      something about it — only when the artifact holds one of them differently from the row, conditioned on the row's token
//      the fetch read; an equal header is never written, so a rebuild that changes nothing PATCHes no appmodule;
//   3. the header PATCH carries no `webresourceid`: an app's icon is written at create and cannot be changed by a push, even
//      when the artifact is given one — which is why the build REPORTS an icon the spec names that the app does not have, and
//      does not pretend to apply it;
//   4. a never-published app refuses the header write (the SDK throws APP_DRAFT_HEADER_NOT_WRITABLE), which the build turns into
//      the precise "publish first" halt — so an edited description is no longer silently left unwritten on such an app.
// A re-vendor could change any of them with every plugin test still green, so each is pinned here against the real bundle over a
// fake Dataverse, the way app-ai-description-real-bundle.test.js pins the routing description.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { appDef, applyAppHeader, applyAppHeaderText, applyAppAiDescription, pushAppHeader } = require('../lib/sdk-build.js');

const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');
const APP_ID = '11111111-1111-1111-1111-111111111111';
const APP_UNIQUE = 'new_probeapp';
const APP_IDUNIQUE = '33333333-3333-3333-3333-333333333333';
const TABLE_METADATA_ID = '22222222-2222-2222-2222-222222222222';
const SITEMAP_ID = '55555555-5555-5555-5555-555555555555';
const SITEMAP_XML = '<SiteMap IntroducedVersion="7.0.0.0"><Area Id="area_0" ShowGroups="true"><Titles><Title LCID="1033" Title="Main" /></Titles>'
  + '<Group Id="group_0_0"><Titles><Title LCID="1033" Title="Main" /></Titles>'
  + '<SubArea Id="sub_0_0_0" Entity="new_torder" Client="All" Sku="All"><Titles><Title LCID="1033" Title="Orders" /></Titles></SubArea>'
  + '</Group></Area></SiteMap>';
const ROUTING = 'Dispatch work: assigning and rescheduling tickets.';

const tempDirs = [];
test.after(() => { for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true }); });

// A real SDK over a fake Dataverse holding one app. `headerStatus` is the status the appmodule PATCH answers (400 is how Dataverse
// refuses a header write on a never-published appmodule); `state` is read on every call, so a test can change the server under the SDK.
async function freshSdk({ name = 'Probe', description = 'Tickets', headerStatus = 204 } = {}) {
  const { createMakerSdk, createNodeWorkspaceStorage } = require(BUNDLE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-header-text-'));
  tempDirs.push(dir);
  const writes = [];
  const state = { name, description, headerStatus, etag: 'W/"1"', ai: undefined };
  const appRow = () => ({ appmoduleid: APP_ID, appmoduleidunique: APP_IDUNIQUE, name: state.name, uniquename: APP_UNIQUE, description: state.description, componentstate: 0, ...(state.ai !== undefined ? { aiappdescription: state.ai } : {}), '@odata.etag': state.etag });
  const sitemapRow = () => ({ sitemapid: SITEMAP_ID, sitemapnameunique: APP_UNIQUE, sitemapxml: SITEMAP_XML, '@odata.etag': state.etag });
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
        return { status: 200, headers: { etag: state.etag }, body: multi ? { value: [sitemapRow()] } : sitemapRow() };
      }
      if (/\/appmodules/.test(url)) {
        const multi = /RetrieveUnpublishedMultiple/i.test(url) || /\/appmodules\?/.test(url);
        return { status: 200, headers: { etag: state.etag }, body: multi ? { value: [appRow()] } : appRow() };
      }
      return { status: 200, headers: {}, body: { value: [] } };
    },
    post: async (url, body) => { writes.push({ verb: 'post', url: String(url), body }); return { status: 204, headers: { 'odata-entityid': `https://x/y(${APP_ID})` }, body: {} }; },
    patch: async (url, body, options) => {
      const ifMatch = (options && options.headers && options.headers['If-Match']) || null;
      writes.push({ verb: 'patch', url: String(url), body, ifMatch });
      if (/\/appmodules\(/.test(url)) {
        if (state.headerStatus !== 204) {
          const message = state.headerStatus === 400 ? 'The retrieval of version numbers failed.' : 'The version of the existing record doesn\'t match the RowVersion property provided.';
          return { status: state.headerStatus, headers: {}, body: { error: { code: '0x80060882', message } } };
        }
        if (body && body.name !== undefined) state.name = body.name;
        if (body && body.description !== undefined) state.description = body.description;
        if (body && body.aiappdescription !== undefined) state.ai = body.aiappdescription;
      }
      return { status: 204, headers: { etag: 'W/"2"' }, body: {} };
    },
    delete: async () => ({ status: 204, headers: {}, body: {} }),
    put: async () => ({ status: 204, headers: {}, body: {} }),
  };
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: 'https://contoso.crm.dynamics.com', httpClient });
  await sdk.initWorkspace();
  return { sdk, writes, state };
}

const spec = (app = {}) => ({
  solution: { uniqueName: 'probe', publisherPrefix: 'new' },
  app: { name: 'Probe', description: 'Tickets', ...app },
  appShell: { areas: [{ label: 'Main', groups: [{ label: 'Main', subAreas: [{ entity: 'new_torder', label: 'Orders' }] }] }] },
});
const headerWrites = (writes) => writes.filter((w) => w.verb === 'patch' && /\/appmodules\(/.test(w.url));
// What a rebuild of an existing app does: edit the fetched copy, rewrite its sitemap, push once.
async function rebuild(sdk, s, apply = applyAppHeader) {
  await sdk.fetchArtifact('app', APP_ID);
  const changed = await apply(sdk, s, APP_ID);
  await sdk.updateElement('app', APP_ID, '/siteMap', appDef(s, { forms: {}, views: {}, charts: {} }).siteMap);
  const pushed = await sdk.pushArtifact('app', APP_ID);
  return { changed, pushed };
}

test('REAL BUNDLE: a fetched app carries its name and description, and both can be edited in place', async () => {
  const { sdk } = await freshSdk();
  const fetched = await sdk.fetchArtifact('app', APP_ID);
  assert.strictEqual(fetched.name, 'Probe');
  assert.strictEqual(fetched.description, 'Tickets');
  assert.strictEqual(fetched.uniqueName, APP_UNIQUE, 'the unique name is the identity the build finds it by');
  await sdk.updateElement('app', APP_ID, '/name', 'Help Desk');
  await sdk.updateElement('app', APP_ID, '/description', 'Track tickets');
  const edited = await sdk.getArtifact('app', APP_ID);
  assert.deepStrictEqual([edited.name, edited.description, edited.uniqueName], ['Help Desk', 'Track tickets', APP_UNIQUE]);
});

test('REAL BUNDLE: an edited description and a rename are written by ONE header PATCH, on the row token the fetch read, with the sitemap', async () => {
  const { sdk, writes, state } = await freshSdk();
  const { changed, pushed } = await rebuild(sdk, spec({ name: 'Help Desk', description: 'Track tickets, orders and escalations.' }));
  assert.strictEqual(changed, true);
  assert.strictEqual(pushed.saved, true, JSON.stringify(pushed.error && pushed.error.message));
  const header = headerWrites(writes);
  assert.strictEqual(header.length, 1, 'one header write');
  assert.deepStrictEqual(header[0].body, { name: 'Help Desk', description: 'Track tickets, orders and escalations.' }, 'the text, and no routing description the spec did not set');
  assert.strictEqual(header[0].ifMatch, 'W/"1"', 'conditioned on the row version the fetch read — never an unconditional write');
  assert.ok(writes.some((w) => /\/sitemaps\(/.test(w.url)), 'the same push wrote the sitemap');
  assert.deepStrictEqual([state.name, state.description], ['Help Desk', 'Track tickets, orders and escalations.'], 'and the row holds it');
});

test('REAL BUNDLE: the unique name is never written, whatever the artifact is told', async () => {
  const { sdk, writes } = await freshSdk();
  await rebuild(sdk, spec({ name: 'Help Desk' }));
  const header = headerWrites(writes);
  assert.strictEqual(header.length, 1);
  assert.ok(!('uniquename' in header[0].body), `the header PATCH carries ${Object.keys(header[0].body).join(', ')}`);
});

test('REAL BUNDLE: a header that already matches the spec is not PATCHed — the sitemap alone is written', async () => {
  const { sdk, writes } = await freshSdk();
  const { changed, pushed } = await rebuild(sdk, spec());
  assert.strictEqual(changed, false, 'nothing to edit');
  assert.strictEqual(pushed.saved, true);
  assert.strictEqual(headerWrites(writes).length, 0, 'the appmodule row is left alone');
  assert.ok(writes.some((w) => /\/sitemaps\(/.test(w.url)), 'the sitemap is written as ever');
});

test('REAL BUNDLE: a spec that leaves the description out, or writes the empty one a download does, never blanks the deployed text', async () => {
  for (const [what, app] of [['an empty description', { description: '' }], ['a blank one', { description: '   ' }], ['none', { description: undefined }]]) {
    const { sdk, writes, state } = await freshSdk({ description: 'Typed in the maker.' });
    const s = spec(app);
    if (app.description === undefined) delete s.app.description;
    const { changed } = await rebuild(sdk, s);
    assert.strictEqual(changed, false, what);
    assert.strictEqual(headerWrites(writes).length, 0, what);
    assert.strictEqual(state.description, 'Typed in the maker.', what);
  }
});

test('REAL BUNDLE: the text and the routing description are written together by one header PATCH', async () => {
  const { sdk, writes } = await freshSdk();
  const { changed } = await rebuild(sdk, spec({ description: 'Track tickets.', aiDescription: ROUTING }));
  assert.strictEqual(changed, true);
  const header = headerWrites(writes);
  assert.strictEqual(header.length, 1);
  assert.deepStrictEqual(header[0].body, { name: 'Probe', description: 'Track tickets.', aiappdescription: ROUTING });
});

test('REAL BUNDLE: the routing description\'s own helper still decides on its own, unchanged by the text edits', async () => {
  const { sdk } = await freshSdk();
  await sdk.fetchArtifact('app', APP_ID);
  assert.strictEqual(await applyAppAiDescription(sdk, spec({ description: 'Track tickets.' }), APP_ID), false, 'no routing description in the spec');
  assert.strictEqual(await applyAppHeaderText(sdk, spec({ description: 'Track tickets.' }), APP_ID), true, 'the text differs');
  assert.strictEqual(await applyAppHeaderText(sdk, spec({ description: 'Track tickets.' }), APP_ID), false, 'and is then the artifact\'s own');
});

test('REAL BUNDLE: an app\'s icon is NOT written by a push, even when the artifact is handed one', async () => {
  const { sdk, writes } = await freshSdk();
  await sdk.fetchArtifact('app', APP_ID);
  assert.ok(!('iconWebResourceId' in (await sdk.getArtifact('app', APP_ID))), 'a fetched app does not carry its icon');
  await sdk.addElement('app', APP_ID, '', { iconWebResourceId: '11111111-2222-3333-4444-555555555555' });
  await sdk.updateElement('app', APP_ID, '/description', 'Track tickets.');
  assert.strictEqual((await sdk.pushArtifact('app', APP_ID)).saved, true);
  const header = headerWrites(writes);
  assert.strictEqual(header.length, 1);
  assert.ok(!('webresourceid' in header[0].body), `the header PATCH carries ${Object.keys(header[0].body).join(', ')}: an icon is written at create only`);
  assert.ok(!writes.some((w) => w.body && typeof w.body === 'object' && 'webresourceid' in w.body), 'no write carries the icon');
});

test('REAL BUNDLE: a never-published app refuses the header write, and the build says to publish it first', async () => {
  const { sdk } = await freshSdk({ headerStatus: 400 });
  await sdk.fetchArtifact('app', APP_ID);
  assert.strictEqual(await applyAppHeader(sdk, spec({ description: 'Track tickets.' }), APP_ID), true);
  // The raw SDK throws rather than resolving saved:false; pushAppHeader turns it into the precise halt, which resets the copy.
  await assert.rejects(sdk.pushArtifact('app', APP_ID), (e) => e && e.code === 'APP_DRAFT_HEADER_NOT_WRITABLE');
  await assert.rejects(pushAppHeader(sdk, APP_ID, 'Probe', true), (e) => e.code === 'app-header-unpublished' && /never been published/.test(e.message) && /name, description or routing description/.test(e.message));
});

test('REAL BUNDLE: the same never-published app takes a rebuild that changes no header text — only an edit meets the refusal', async () => {
  const { sdk, writes } = await freshSdk({ headerStatus: 400 });
  const { changed, pushed } = await rebuild(sdk, spec());
  assert.strictEqual(changed, false);
  assert.strictEqual(pushed.saved, true, 'the sitemap write does not need the header');
  assert.strictEqual(headerWrites(writes).length, 0);
});
