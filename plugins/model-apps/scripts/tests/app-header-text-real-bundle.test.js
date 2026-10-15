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
//   4. a never-published app refuses the header write (the SDK throws APP_DRAFT_HEADER_NOT_WRITABLE, before it writes its sitemap and
//      having modified nothing), and it writes the header only when the artifact holds one that differs from the row's — so the
//      build puts the fetched text back, which makes the next push a sitemap-only push, and reports the edit as not applied
//      (an explicitly authored routing description cannot be set aside this way, and halts);
//   5. a header whose name or description is not plain text (a text per language) is never replaced by a scalar.
// A re-vendor could change any of them with every plugin test still green, so each is pinned here against the real bundle over a
// fake Dataverse, the way app-ai-description-real-bundle.test.js pins the routing description.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { appDef, applyAppHeader, applyAppHeaderText, applyAppAiDescription, pushAppHeader } = require('../lib/sdk-build.js');
const { requireSuccessfulPush } = require('../lib/entity-provision.js');

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
const sitemapWrites = (writes) => writes.filter((w) => w.verb === 'patch' && /\/sitemaps\(/.test(w.url));
// What a rebuild of an existing app does: edit the fetched copy, rewrite its sitemap, push once. `changed` is what the header edit
// answered (applyAppHeader: { changed, routing, replaced }).
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
  assert.strictEqual(changed.changed, true);
  assert.deepStrictEqual(changed.replaced, { name: 'Probe', description: 'Tickets' }, 'the fetched text each edit replaced is kept, to put back if the push is refused');
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
  assert.strictEqual(changed.changed, false, 'nothing to edit');
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
    assert.strictEqual(changed.changed, false, what);
    assert.strictEqual(headerWrites(writes).length, 0, what);
    assert.strictEqual(state.description, 'Typed in the maker.', what);
  }
});

test('REAL BUNDLE: the text and the routing description are written together by one header PATCH', async () => {
  const { sdk, writes } = await freshSdk();
  const { changed } = await rebuild(sdk, spec({ description: 'Track tickets.', aiDescription: ROUTING }));
  assert.strictEqual(changed.changed, true);
  assert.strictEqual(changed.routing, true);
  const header = headerWrites(writes);
  assert.strictEqual(header.length, 1);
  assert.deepStrictEqual(header[0].body, { name: 'Probe', description: 'Track tickets.', aiappdescription: ROUTING });
});

test('REAL BUNDLE: the routing description\'s own helper still decides on its own, unchanged by the text edits', async () => {
  const { sdk } = await freshSdk();
  await sdk.fetchArtifact('app', APP_ID);
  assert.strictEqual(await applyAppAiDescription(sdk, spec({ description: 'Track tickets.' }), APP_ID), false, 'no routing description in the spec');
  assert.deepStrictEqual(await applyAppHeaderText(sdk, spec({ description: 'Track tickets.' }), APP_ID), { description: 'Tickets' }, 'the text differs: what it replaced is answered');
  assert.deepStrictEqual(await applyAppHeaderText(sdk, spec({ description: 'Track tickets.' }), APP_ID), {}, 'and is then the artifact\'s own');
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

// A never-published app refuses the header write with a 400 the SDK turns into APP_DRAFT_HEADER_NOT_WRITABLE, THROWN before its sitemap
// write ("Nothing was modified by this call"), and it writes the header only when the artifact holds one that differs from the row's.
// So the refusal of an edit of the app's TEXT leaves the sitemap unwritten and everything else of the build waiting on it — unless the
// fetched text is put back first, which makes the very next push a sitemap-only one, as a rebuild with no text edit always is. The routing
// description is an explicit request that cannot be honoured, so it halts instead; a 412 is a concurrent edit and is never retried.
test('REAL BUNDLE: a never-published app refuses the header write — the SDK throws, and nothing was written by that call', async () => {
  const { sdk, writes } = await freshSdk({ headerStatus: 400 });
  await sdk.fetchArtifact('app', APP_ID);
  assert.strictEqual((await applyAppHeader(sdk, spec({ description: 'Track tickets.' }), APP_ID)).changed, true);
  await assert.rejects(sdk.pushArtifact('app', APP_ID), (e) => e && e.code === 'APP_DRAFT_HEADER_NOT_WRITABLE' && /Nothing was modified by this call/.test(e.message));
  assert.strictEqual(headerWrites(writes).length, 1, 'the one header PATCH, refused');
  assert.strictEqual(sitemapWrites(writes).length, 0, 'and the sitemap is not written after it');
});

test('REAL BUNDLE: a text edit on a never-published app is NOT applied — the header is put back and the same copy then saves the navigation', async () => {
  const { sdk, writes, state } = await freshSdk({ headerStatus: 400 });
  const s = spec({ name: 'Help Desk', description: 'Track tickets.' });
  await sdk.fetchArtifact('app', APP_ID);
  const header = await applyAppHeader(sdk, s, APP_ID);
  assert.strictEqual(header.routing, false);
  await sdk.updateElement('app', APP_ID, '/siteMap', appDef(s, { forms: {}, views: {}, charts: {} }).siteMap);
  const warnings = [];
  const pushed = await pushAppHeader(sdk, APP_ID, 'Help Desk', header, undefined, (m) => warnings.push(m));
  assert.strictEqual(pushed.saved, true, JSON.stringify(pushed.error && pushed.error.message));
  assert.deepStrictEqual(writes.filter((w) => w.verb === 'patch').map((w) => (/\/appmodules\(/.test(w.url) ? 'header' : /\/sitemaps\(/.test(w.url) ? 'sitemap' : w.url)), ['header', 'sitemap'],
    'the refused header write, then the sitemap — the retry sends no header write at all');
  assert.deepStrictEqual(headerWrites(writes)[0].body, { name: 'Help Desk', description: 'Track tickets.' }, 'what was refused is the text edit');
  assert.deepStrictEqual([state.name, state.description], ['Probe', 'Tickets'], 'the row is as it was');
  const held = await sdk.getArtifact('app', APP_ID);
  assert.deepStrictEqual([held.name, held.description], ['Probe', 'Tickets'], 'and so is the copy');
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /^app "Help Desk": its name and description were not applied: the app was never published; publish it in Power Apps and re-run\./);
  assert.match(sitemapWrites(writes)[0].body.sitemapxml, /Entity="new_torder"/, 'the navigation the push wrote is the one the run built');
  // Once the operator has published the app, the next run applies the text.
  Object.assign(state, { headerStatus: 204, etag: 'W/"8"' });
  await sdk.fetchArtifact('app', APP_ID);
  const again = await applyAppHeader(sdk, s, APP_ID);
  assert.strictEqual(again.changed, true);
  assert.strictEqual((await pushAppHeader(sdk, APP_ID, 'Help Desk', again)).saved, true);
  assert.deepStrictEqual([state.name, state.description], ['Help Desk', 'Track tickets.']);
});

test('REAL BUNDLE: the routing description on a never-published app halts with the precise refusal — beside a text edit too, and never retried without it', async () => {
  for (const [what, app] of [['alone', { aiDescription: ROUTING }], ['beside a text edit', { description: 'Track tickets.', aiDescription: ROUTING }]]) {
    const { sdk, writes } = await freshSdk({ headerStatus: 400 });
    await sdk.fetchArtifact('app', APP_ID);
    const header = await applyAppHeader(sdk, spec(app), APP_ID);
    assert.strictEqual(header.routing, true, what);
    await assert.rejects(pushAppHeader(sdk, APP_ID, 'Probe', header, undefined, () => assert.fail('nothing is reported as not applied over a halt')),
      (e) => e.code === 'app-header-unpublished' && /never been published/.test(e.message) && /name, description or routing description/.test(e.message), what);
    assert.strictEqual(headerWrites(writes).length, 1, `${what}: one refused header PATCH`);
    assert.strictEqual(sitemapWrites(writes).length, 0, `${what}: the sitemap is not written without the routing description`);
  }
  // The same call as the routing-description tests make, with the bare flag: still the halt.
  const { sdk } = await freshSdk({ headerStatus: 400 });
  await sdk.fetchArtifact('app', APP_ID);
  await applyAppAiDescription(sdk, spec({ aiDescription: ROUTING }), APP_ID);
  await assert.rejects(pushAppHeader(sdk, APP_ID, 'Probe', true), (e) => e.code === 'app-header-unpublished');
});

test('REAL BUNDLE: a 412 on a push that carried a text edit is a concurrent edit — returned as the conflict, never retried and never skipped', async () => {
  const { sdk, writes, state } = await freshSdk({ headerStatus: 412 });
  await sdk.fetchArtifact('app', APP_ID);
  const header = await applyAppHeader(sdk, spec({ description: 'Track tickets.' }), APP_ID);
  const warnings = [];
  const pushed = await pushAppHeader(sdk, APP_ID, 'Probe', header, undefined, (m) => warnings.push(m));
  assert.strictEqual(pushed.saved, false);
  assert.strictEqual(pushed.error && pushed.error.code, 'VERSION_CONFLICT');
  assert.throws(() => requireSuccessfulPush(pushed, 'app Probe'), (e) => e.code === 'version-conflict');
  assert.strictEqual(headerWrites(writes).length, 1, 'one attempt');
  assert.strictEqual(sitemapWrites(writes).length, 0);
  assert.deepStrictEqual(warnings, []);
  assert.strictEqual(state.description, 'Tickets', 'the other writer\u2019s row is intact');
});

test('REAL BUNDLE: the same never-published app takes a rebuild that changes no header text — only an edit meets the refusal', async () => {
  const { sdk, writes } = await freshSdk({ headerStatus: 400 });
  const { changed, pushed } = await rebuild(sdk, spec());
  assert.strictEqual(changed.changed, false);
  assert.strictEqual(pushed.saved, true, 'the sitemap write does not need the header');
  assert.strictEqual(headerWrites(writes).length, 0);
});

// Both columns are localizable, and a plain write of the base-language text has not been measured to keep the translations beside it
// against an environment. Until it has, a header that holds a text per language is never replaced by a scalar.
test('REAL BUNDLE: a localized name and description are never replaced by a scalar, and no header PATCH carries one', async () => {
  const name = { 1033: 'Probe', 1036: 'Sonde' };
  const description = { 1033: 'Tickets', 1036: 'Billets' };
  const { sdk, writes } = await freshSdk({ name, description });
  const fetched = await sdk.fetchArtifact('app', APP_ID);
  assert.deepStrictEqual([fetched.name, fetched.description], [name, description], 'the fetched header holds a text per language, as the fake serves it');
  const warnings = [];
  // The unchanged-name, changed-description case: the spec\u2019s name is the English text, only its description is new.
  const header = await applyAppHeader(sdk, spec({ description: 'Updated description' }), APP_ID, { warn: (m) => warnings.push(m) });
  assert.strictEqual(header.changed, false, 'nothing could be applied');
  assert.deepStrictEqual(header.replaced, {});
  const held = await sdk.getArtifact('app', APP_ID);
  assert.deepStrictEqual([held.name, held.description], [name, description], 'both are still maps');
  assert.strictEqual(warnings.length, 1, JSON.stringify(warnings));
  assert.match(warnings[0], /^app "Probe": its description was not applied: it is localized \(2 languages: 1033, 1036\)/);
  // The push that follows is the sitemap-only push a rebuild with no edit makes.
  await sdk.updateElement('app', APP_ID, '/siteMap', appDef(spec(), { forms: {}, views: {}, charts: {} }).siteMap);
  const pushed = await pushAppHeader(sdk, APP_ID, 'Probe', header);
  assert.strictEqual(pushed.saved, true, JSON.stringify(pushed.error && pushed.error.message));
  assert.strictEqual(headerWrites(writes).length, 0, 'no PATCH of the appmodule at all');
  assert.strictEqual(sitemapWrites(writes).length, 1);
});

test('REAL BUNDLE: a localized header with a changed name is left alone as well, and so is the one that cannot be read as text', async () => {
  for (const [what, name, description] of [['localized', { 1033: 'Probe', 1036: 'Sonde' }, { 1033: 'Tickets', 1036: 'Billets' }], ['unreadable', ['Probe'], 7]]) {
    const { sdk, writes } = await freshSdk({ name, description });
    await sdk.fetchArtifact('app', APP_ID);
    const warnings = [];
    const header = await applyAppHeader(sdk, spec({ name: 'Help Desk', description: 'Updated description' }), APP_ID, { warn: (m) => warnings.push(m) });
    assert.strictEqual(header.changed, false, what);
    assert.strictEqual(warnings.length, 2, `${what}: ${JSON.stringify(warnings)}`);
    assert.strictEqual((await pushAppHeader(sdk, APP_ID, 'Help Desk', header)).saved, true, what);
    assert.strictEqual(headerWrites(writes).length, 0, what);
  }
});
