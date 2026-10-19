'use strict';
// REAL BUNDLE: the app's NAME and DESCRIPTION on a rebuild, and why its ICON is not among them.
//
// The plugin's `applyAppHeader` (sdk-build.js) edits an existing app's header text on the artifact a fetch just read, so that the
// ONE push that already writes the sitemap writes it too. That leans on SDK behaviour the plugin's own unit tests can only stub:
//   1. a fetched app carries `name` and `description` (the adapter reads `description` as '' when the row has none), so
//      `updateElement('/name')` and `updateElement('/description')` have a path to write;
//   2. the push PATCHes only the appmodule header texts the artifact holds differently from the row — `name`, `description`, and `aiappdescription` only when
//      the artifact says something about it — in one request conditioned on the row's token the fetch read; an equal header is never written, so a rebuild
//      that changes nothing PATCHes no appmodule;
//   3. the header PATCH carries no `webresourceid`: an app's icon is written at create and cannot be changed by a push, even
//      when the artifact is given one — which is why the build REPORTS an icon the spec names that the app does not have, and
//      does not pretend to apply it;
//   4. a never-published app refuses the header write (the SDK throws APP_DRAFT_HEADER_NOT_WRITABLE, before it writes its sitemap and
//      having modified nothing), and it writes the header only when the artifact holds one that differs from the row's — so the
//      build puts the fetched text back, which makes the next push a sitemap-only push, and reports the edit as not applied
//      (an explicitly authored routing description cannot be set aside this way, and halts);
//   5. a header whose name or description is not plain text (a text per language) is never sent: while either is not plain the build makes no
//      header edit at all — the other text's, nor a routing description — and reports each as not applied (the tests at the end of this file).
//      The hold is the plugin's own and does not rest on the PATCH carrying both texts: the SDK writes only the texts that changed (the pin below);
//   6. the hold is on the workspace copy, and the SDK decides for itself whether the header is written: when its OWN comparison read of the
//      header fails (503, 403, a thrown error, an empty 200) it writes the copy's header as it is. So the client every SDK is made with refuses a
//      PATCH of an app module row whose name or description is not a string (lib/app-header-text.js): nothing that is not plain text reaches the
//      wire, the push fails with APP_HEADER_NOT_PLAIN_TEXT before the navigation is written, and a re-run finishes (the last tests of this file).
// A re-vendor could change any of them with every plugin test still green, so each is pinned here against the real bundle over a
// fake Dataverse, the way app-ai-description-real-bundle.test.js pins the routing description.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { appDef, applyAppHeader, applyAppHeaderText, applyAppAiDescription, pushAppHeader, runSdkBuild } = require('../lib/sdk-build.js');
const { requireSuccessfulPush } = require('../lib/entity-provision.js');
const { SdkError } = require('../lib/maker-sdk.js');
const { isTransientHalt } = require('../build-model-app.js');
const { fakeGenpage } = require('./helpers/fake-genpage.js');

const NOT_PLAIN = 'APP_HEADER_NOT_PLAIN_TEXT';
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
// The SDK is made through lib/maker-sdk.js, as every script makes its SDK: the client it is handed is the one the plugin's scripts get, with the
// header guard of lib/app-header-text.js. `state.fault` fails the SDK's own comparison read of the header (failComparisonRead).
async function freshSdk({ name = 'Probe', description = 'Tickets', headerStatus = 204, existingIcon = false } = {}) {
  const { createMakerSdk, createNodeWorkspaceStorage } = require('../lib/maker-sdk.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-header-text-'));
  tempDirs.push(dir);
  const writes = [];
  // `refused` collects every header PATCH that carried a `name` or `description` that is not a string (see the PATCH handler below).
  const state = { name, description, headerStatus, etag: 'W/"1"', ai: undefined, refused: [], fault: null };
  const appRow = () => ({ appmoduleid: APP_ID, appmoduleidunique: APP_IDUNIQUE, name: state.name, uniquename: APP_UNIQUE, description: state.description, componentstate: 0, ...(state.ai !== undefined ? { aiappdescription: state.ai } : {}), '@odata.etag': state.etag });
  const sitemapRow = () => ({ sitemapid: SITEMAP_ID, sitemapnameunique: APP_UNIQUE, sitemapxml: SITEMAP_XML, '@odata.etag': state.etag });
  const httpClient = {
    get: async (url) => {
      // The SDK's own comparison read of the header: the one read of the app module row that selects the routing description, made inside its push of an app.
      const fault = state.fault;
      if (fault && fault.armed && fault.reads.length === 0 && /\/appmodules\/Microsoft\.Dynamics\.CRM\.RetrieveUnpublishedMultiple\(\)/i.test(url) && /aiappdescription/.test(url)) {
        fault.reads.push(String(url));
        if (fault.kind === 'throw') throw new Error('the comparison read of the header failed');
        if (fault.kind === 'empty') return { status: 200, headers: {}, body: {} };
        return { status: Number(fault.kind), headers: {}, body: { error: { message: 'the comparison read of the header was refused' } } };
      }
      // An app that already has its icon: the build then creates no web resource for one (a first build does, and publishes it).
      if (existingIcon && /\/webresources(?:et)?(?:\?|$)/.test(url)) return { status: 200, headers: {}, body: { value: [{ webresourceid: '66666666-6666-6666-6666-666666666666', webresourcetype: 11 }] } };
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
        // `name` and `description` are String columns, so an object or a list in either is no value they can take. How the platform words
        // that refusal is not measured; the fixture only has to refuse, so a build that sends one shows as a failed push, not just a body.
        if (body && ['name', 'description'].some((key) => body[key] !== undefined && typeof body[key] !== 'string')) {
          state.refused.push({ url: String(url), body });
          return { status: 400, headers: {}, body: { error: { message: 'A value that is not a string was sent for a String column.' } } };
        }
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
  assert.deepStrictEqual(header[0].body, { description: 'Track tickets.', aiappdescription: ROUTING }, 'the texts that changed, and not the name the spec leaves as it is');
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

// WHAT the SDK writes of the header: only the texts that CHANGED. It used to write the artifact's `name` AND `description` in every header PATCH — whichever of
// them an edit changed, and for an edit of the routing description alone — because it wrote the copy, not the edit. Since cds-maker-sdk 9a0c9f03 it writes the fields
// that differ from the row it has just read, in one request still conditioned on the row's token (and every field the copy holds when that read cannot be made).
// An edit of one text therefore does not send the other. Pinned here: the plugin's build leans on it to write one text of a header whose other text it must not send.
test('REAL BUNDLE: a header PATCH carries only the texts that changed — an edit of one does not send the other, and a routing edit sends neither', async () => {
  const text = await freshSdk();
  await rebuild(text.sdk, spec({ description: 'Changed' }));
  assert.deepStrictEqual(headerWrites(text.writes).map((w) => w.body), [{ description: 'Changed' }], 'the name the spec did not change is not sent');
  const name = await freshSdk();
  await rebuild(name.sdk, spec({ name: 'Help Desk' }));
  assert.deepStrictEqual(headerWrites(name.writes).map((w) => w.body), [{ name: 'Help Desk' }], 'and neither is the description');
  const routing = await freshSdk();
  await rebuild(routing.sdk, spec({ aiDescription: ROUTING }));
  assert.deepStrictEqual(headerWrites(routing.writes).map((w) => w.body), [{ aiappdescription: ROUTING }], 'a routing edit sends neither text');
});

// A header text that is not plain — a text per language (a map keyed by LCID), a list, a number — is never sent, as a map or as a scalar. The
// adapter hands back one string per column for a real app, so this is a safety net for a shape the SDK may return, served here by the fake;
// what it must guarantee is the same in every case: an edit that would put the text on the wire is held back and reported, and the push that
// follows is the navigation alone.
const localizedText = (english, french) => ({ 1033: english, 1036: french });
const HELD_CASES = [
  ['a localized name beside a changed description', { name: localizedText('Probe', 'Sonde') }, { description: 'Changed' },
    [/^app "Probe": its description was not applied: the app's name is localized \(2 languages: 1033, 1036\), and the app's name and description are written in one request, so changing its description would send the name too — a rebuild never sends a text that is not plain\. Change it in Power Apps\.$/]],
  ['a localized description beside a changed name', { description: localizedText('Tickets', 'Billets') }, { name: 'Help Desk' },
    [/^app "Help Desk": its name was not applied: the app's description is localized \(2 languages: 1033, 1036\), and the app's name and description are written in one request, so changing its name would send the description too — a rebuild never sends a text that is not plain\. Change it in Power Apps\.$/]],
  ['a localized description beside a changed name and a changed description', { description: localizedText('Tickets', 'Billets') }, { name: 'Help Desk', description: 'Changed' },
    [/^app "Help Desk": its name was not applied: the app's description is localized/, /^app "Help Desk": its description was not applied: it is localized \(2 languages: 1033, 1036\)/]],
  ['two localized texts beside a routing description', { name: localizedText('Probe', 'Sonde'), description: localizedText('Tickets', 'Billets') }, { aiDescription: ROUTING },
    [/^app "Probe": its routing description \(app\.aiDescription\) was not applied: the app's name is localized \(2 languages: 1033, 1036\) and its description is localized \(2 languages: 1033, 1036\), and the app's name, description and routing description are written in one request, so changing it would send both too — a rebuild never sends a text that is not plain\. Change it in Power Apps\.$/]],
  ['a localized name beside a routing description', { name: localizedText('Probe', 'Sonde') }, { aiDescription: ROUTING },
    [/^app "Probe": its routing description \(app\.aiDescription\) was not applied: the app's name is localized/]],
  ['a list for the name beside a changed description', { name: ['Probe'] }, { description: 'Changed' },
    [/^app "Probe": its description was not applied: the app's name could not be read as plain text \(it came back as a list\), and the app's name and description are written in one request/,
      /^app "Probe": its name was not applied: the app's name could not be read as plain text \(it came back as a list\), so a rebuild does not replace it/]],
  ['a number for the description beside a changed name', { description: 7 }, { name: 'Help Desk' },
    [/^app "Help Desk": its name was not applied: the app's description could not be read as plain text \(it came back as a number\), and the app's name and description are written in one request/,
      /^app "Help Desk": its description was not applied: the app's description could not be read as plain text \(it came back as a number\), so a rebuild does not replace it/]],
];

for (const [what, initial, app, expected] of HELD_CASES) {
  test(`REAL BUNDLE: ${what} — no text is sent for the edit, the navigation still is, and the build says what it left`, async () => {
    const { sdk, writes, state } = await freshSdk(initial);
    const fetched = JSON.parse(JSON.stringify(await sdk.fetchArtifact('app', APP_ID)));
    const warnings = [];
    const s = spec(app);
    const header = await applyAppHeader(sdk, s, APP_ID, { warn: (m) => warnings.push(m) });
    await sdk.updateElement('app', APP_ID, '/siteMap', appDef(s, { forms: {}, views: {}, charts: {} }).siteMap);
    const pushed = await pushAppHeader(sdk, APP_ID, 'Probe', header, undefined, (m) => warnings.push(m));
    assert.strictEqual(pushed.saved, true, JSON.stringify(pushed.error && pushed.error.message));
    assert.deepStrictEqual([header.changed, header.routing, header.replaced], [false, false, {}], 'nothing of the header was edited');
    assert.deepStrictEqual(headerWrites(writes), [], 'no PATCH of the appmodule at all');
    assert.deepStrictEqual(state.refused, [], 'and nothing a String column cannot take was ever sent');
    assert.strictEqual(sitemapWrites(writes).length, 1, 'the navigation is written, as it always is');
    const held = await sdk.getArtifact('app', APP_ID);
    assert.deepStrictEqual([held.name, held.description], [fetched.name, fetched.description], 'the copy still holds the header exactly as it was fetched');
    assert.strictEqual(warnings.length, expected.length, JSON.stringify(warnings));
    for (const re of expected) assert.ok(warnings.some((w) => re.test(w)), `${re} in ${JSON.stringify(warnings)}`);
  });
}

test('REAL BUNDLE: a header text that is not plain, beside edits that need nothing from it, stays silent and writes nothing', async () => {
  // The spec says nothing new: its name is one of the localized name\u2019s own entries and it sets no description.
  const { sdk, writes } = await freshSdk({ name: localizedText('Probe', 'Sonde'), description: localizedText('Tickets', 'Billets') });
  const warnings = [];
  const { changed, pushed } = await rebuild(sdk, spec(), (...args) => applyAppHeader(...args, { warn: (m) => warnings.push(m) }));
  assert.strictEqual(changed.changed, false);
  assert.strictEqual(pushed.saved, true);
  assert.deepStrictEqual(warnings, []);
  assert.deepStrictEqual(headerWrites(writes), []);
});

test('REAL BUNDLE: a transport that refuses a non-string name or description is never asked to — the build\'s push is the navigation alone', async () => {
  // The consequence the guard prevents, with a fake that refuses what a String column cannot take: the header PATCH answers 400, and the SDK
  // throws before it writes the navigation, so one text of the header would have stopped the app step. Held back, there is no such request.
  const { sdk, writes, state } = await freshSdk({ name: localizedText('Probe', 'Sonde') });
  const warnings = [];
  await sdk.fetchArtifact('app', APP_ID);
  const s = spec({ description: 'Changed' });
  const header = await applyAppHeader(sdk, s, APP_ID, { warn: (m) => warnings.push(m) });
  await sdk.updateElement('app', APP_ID, '/siteMap', appDef(s, { forms: {}, views: {}, charts: {} }).siteMap);
  const pushed = requireSuccessfulPush(await pushAppHeader(sdk, APP_ID, 'Probe', header), 'app Probe');
  assert.strictEqual(pushed.saved, true);
  assert.deepStrictEqual(state.refused, []);
  assert.strictEqual(sitemapWrites(writes).length, 1);
  assert.match(sitemapWrites(writes)[0].body.sitemapxml, /Entity="new_torder"/, 'the navigation the run built is what was written');
});

// The whole app step, through runSdkBuild, over the same fake: the build goes on past a header it will not edit — to the navigation, the
// publish of the app and, with the pages phase, the finalizer that is then the app's only writer.
test('REAL BUNDLE: a complete rebuild over a header that is not plain text finishes — navigation written, app published, nothing sent for the header (with and without the pages phase)', async () => {
  for (const [what, initial, app, wanted] of [
    ['a localized name beside a changed description', { name: localizedText('Probe', 'Sonde') }, { description: 'Changed' }, /^app "Probe": its description was not applied: the app's name is localized/],
    ['a localized description beside a routing description', { description: localizedText('Tickets', 'Billets') }, { aiDescription: ROUTING }, /^app "Probe": its routing description \(app\.aiDescription\) was not applied: the app's description is localized/],
  ]) {
    for (const pages of [false, true]) {
      const { sdk, writes, state } = await freshSdk(initial);
      const warnings = [];
      const built = await runSdkBuild(spec({ uniqueName: APP_UNIQUE, ...app }), { sdk, apply: true, publish: true, genpage: fakeGenpage(), workspaceDir: workspaceDir(), env: 'https://contoso.crm.dynamics.com',
        phases: pages ? ['app-shell', 'pages', 'publish'] : ['app-shell', 'publish'], warn: (m) => warnings.push(m) });
      const label = `${what}${pages ? ', with the pages phase' : ''}`;
      assert.strictEqual(built.ok, true, label);
      assert.deepStrictEqual(headerWrites(writes), [], `${label}: no header PATCH`);
      assert.deepStrictEqual(state.refused, [], label);
      assert.strictEqual(sitemapWrites(writes).length, 1, `${label}: the navigation is written once`);
      const published = writes.filter((w) => /\/PublishXml/.test(w.url) && /<appmodule>/.test((w.body || {}).ParameterXml || ''));
      assert.ok(published.length > 0 && writes.indexOf(published[0]) > writes.indexOf(sitemapWrites(writes)[0]), `${label}: the app is published after its navigation`);
      assert.strictEqual(warnings.filter((w) => wanted.test(w)).length, 1, `${label}: ${JSON.stringify(warnings)}`);
    }
  }
  // The neighbour: the same rebuild of a plain header writes it, as before.
  const { sdk, writes } = await freshSdk();
  const built = await runSdkBuild(spec({ uniqueName: APP_UNIQUE, name: 'Help Desk', description: 'Changed' }), { sdk, apply: true, publish: true, genpage: fakeGenpage(), workspaceDir: workspaceDir(), env: 'https://contoso.crm.dynamics.com', phases: ['app-shell', 'publish'] });
  assert.strictEqual(built.ok, true);
  assert.deepStrictEqual(headerWrites(writes).map((w) => w.body), [{ name: 'Help Desk', description: 'Changed' }]);
});

// --- the SDK's OWN comparison read fails: the client is the last line of defence ----------------------------------------------------------------------------
//
// Everything above holds the header on the workspace COPY. But the SDK's push of an app decides for itself whether the header is written: it reads the header and compares it with the
// copy's, and its "write needed" flag starts true and only a 2xx answer sets it — so a read that cannot be made (HTTP 503 or 403, a transport that throws) leaves the flag true, and a 200 with no row
// is compared with an empty header, which differs: the header is written from the copy as it is, a text that is not plain included, even when the build edited nothing at all. Pinned here with a fault in the fake server. The client the SDK is made
// with (lib/app-header-text.js, wired in lib/maker-sdk.js, the one way a script makes an SDK) refuses that PATCH before any byte is sent: the push fails with the typed error, and since the
// SDK writes the header first, it wrote nothing of its navigation either.

// Fails that read once, inside a push of an app: `kind` is an HTTP status ('503', '403'), 'throw' (the transport throws) or 'empty' (HTTP 200 with no row). Armed only inside the push of an
// app: the build's own reads of the app select the same columns and must answer — its recovery reads the app again.
function failComparisonRead({ sdk, state }, kind) {
  state.fault = { kind, armed: false, reads: [] };
  const push = sdk.pushArtifact.bind(sdk);
  sdk.pushArtifact = async (...args) => {
    state.fault.armed = args[0] === 'app';
    try {
      return await push(...args);
    } finally {
      state.fault.armed = false;
    }
  };
  return state.fault;
}

function workspaceDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-header-workspace-'));
  tempDirs.push(dir);
  return dir;
}

const COMPARISON_FAULTS = [['HTTP 503', '503'], ['HTTP 403', '403'], ['a thrown error', 'throw'], ['an empty HTTP 200', 'empty']];
const PROTECTED_NAMES = [
  ['a localized name', localizedText('Probe', 'Sonde'), /the app's name is localized \(2 languages: 1033, 1036\)\. Nothing was sent/],
  ['an array-valued name', ['Probe'], /the app's name could not be read as plain text \(it came back as a list\)\. Nothing was sent/],
];
const PUSH_SITES = [['app-shell + publish', false], ['app-shell + pages + publish', true]];

for (const [faultWhat, fault] of COMPARISON_FAULTS) {
  for (const [shapeWhat, shape, described] of PROTECTED_NAMES) {
    for (const [siteWhat, pages] of PUSH_SITES) {
      test(`REAL BUNDLE: ${faultWhat} on the SDK's own comparison read, over ${shapeWhat}, ${siteWhat} — the header write is refused before a byte is sent, nothing is written, and the re-run finishes`, async () => {
        const f = await freshSdk({ name: shape, existingIcon: true });
        const injected = failComparisonRead(f, fault);
        const warnings = [];
        const phase = pages ? 'pages' : 'app-shell';
        const genpage = fakeGenpage();
        const workspace = workspaceDir();
        // A changed description beside the protected name: the build holds it back (and says so), and the SDK is then asked to push the copy.
        const run = () => runSdkBuild(spec({ uniqueName: APP_UNIQUE, description: 'Changed' }), {
          sdk: f.sdk, apply: true, publish: true, genpage, workspaceDir: workspace, env: 'https://contoso.crm.dynamics.com',
          phases: pages ? ['app-shell', 'pages', 'publish'] : ['app-shell', 'publish'], warn: (m) => warnings.push(m),
        });
        await assert.rejects(run(), (halt) => {
          assert.strictEqual(halt.name, 'BuildHalt');
          assert.strictEqual(halt.code, NOT_PLAIN, 'the halt carries the typed code');
          assert.strictEqual(halt.phase, phase);
          assert.match(halt.message, new RegExp(`^${phase} failed: Refused before anything was sent: the write of app ${APP_ID}'s header would have carried a text that is not plain — `));
          assert.match(halt.message, described);
          assert.match(halt.message, /Nothing was sent, so the app is as it was, and the push stopped before it wrote the app's navigation\. /);
          assert.match(halt.message, /Run it again: a re-run normally succeeds\. If the same refusal comes back, make the app's name and description plain text in Power Apps\.$/);
          assert.ok(halt.cause instanceof SdkError, 'the SDK rethrew the client\'s error as it is');
          assert.strictEqual(halt.cause.code, NOT_PLAIN);
          assert.strictEqual(halt.cause.transient, false);
          assert.strictEqual(isTransientHalt(halt), false, 'the build does not run the phase again on its own');
          return true;
        });
        assert.strictEqual(injected.reads.length, 1, 'the fault reached the SDK\'s one comparison read of the header');
        assert.deepStrictEqual(headerWrites(f.writes), [], 'no PATCH of the appmodule was sent');
        assert.deepStrictEqual(f.state.refused, [], 'so nothing a String column cannot take reached the server');
        assert.deepStrictEqual(sitemapWrites(f.writes), [], 'and the navigation was not written: the SDK writes the header first');
        // No PATCH of anything, and the app not published. (What a rebuild does before its push — the app's solution membership, an idempotent add — is not the push's.) The one publish
        // before the push is the request that publishes, ahead of the app's write, the tables whose forms that write adds (publishTablesBeforeApp): it is made before the push is tried,
        // whichever way the push then ends, and it names tables only.
        assert.deepStrictEqual(f.writes.filter((w) => w.verb === 'patch'), []);
        const publishes = f.writes.filter((w) => /\/PublishXml/.test(w.url)).map((w) => String((w.body || {}).ParameterXml || ''));
        assert.ok(publishes.length <= 1 && publishes.every((xml) => /^<importexportxml><entities>(<entity>[a-z_]+<\/entity>)+<\/entities><\/importexportxml>$/.test(xml)), `at most the one request for the tables before the app, and no publish of the app: ${JSON.stringify(publishes)}`);
        assert.deepStrictEqual([f.state.name, f.state.description], [shape, 'Tickets'], 'the app is as it was');
        assert.strictEqual(warnings.filter((w) => /^app "Probe": its description was not applied: the app's name /.test(w)).length, 1, `the held-back description is still reported, once: ${JSON.stringify(warnings)}`);

        // A re-run — the read answers now — finds the copy equal to the row, sends no header, and writes the navigation. (It also shows the failed push left the workspace copy as the
        // server has it: a copy holding the refused run's edits would be refused as unpushed.)
        const rerun = await run();
        assert.strictEqual(rerun.ok, true);
        assert.deepStrictEqual(headerWrites(f.writes), [], 're-run: still no header PATCH');
        assert.deepStrictEqual(f.state.refused, [], 're-run: nothing that is not plain text was sent');
        assert.strictEqual(sitemapWrites(f.writes).length, 1, 're-run: the navigation is written, once');
        const published = f.writes.filter((w) => /\/PublishXml/.test(w.url) && /<appmodule>/.test((w.body || {}).ParameterXml || ''));
        assert.ok(published.length > 0 && f.writes.indexOf(published[0]) > f.writes.indexOf(sitemapWrites(f.writes)[0]), 're-run: the app is published after its navigation');
        assert.deepStrictEqual([f.state.name, f.state.description], [shape, 'Tickets'], 're-run: the header is still the maker\'s');
      });
    }
  }
}

// The same fault one level down, with nothing edited at all (`changed: false`) — the case a hold on the workspace copy cannot see: the SDK is still asked to push the copy, and writes its header.
// The description is judged exactly as the name is, and both together are named together.
const PROTECTED_HEADERS = [
  ...PROTECTED_NAMES.map(([what, name, described]) => [what, { name }, described, { name }]),
  ['a localized description', { description: localizedText('Tickets', 'Billets') }, /the app's description is localized \(2 languages: 1033, 1036\)\. Nothing was sent/, { description: localizedText('Tickets', 'Billets') }],
  ['a list for the description', { description: ['Tickets'] }, /the app's description could not be read as plain text \(it came back as a list\)\. Nothing was sent/, { description: ['Tickets'] }],
  ['a localized name and description', { name: localizedText('Probe', 'Sonde'), description: localizedText('Tickets', 'Billets') },
    /the app's name is localized \(2 languages: 1033, 1036\) and its description is localized \(2 languages: 1033, 1036\)\. Nothing was sent/, { name: localizedText('Probe', 'Sonde'), description: localizedText('Tickets', 'Billets') }],
];
for (const [faultWhat, fault] of COMPARISON_FAULTS) {
  for (const [shapeWhat, initial, described, held] of PROTECTED_HEADERS) {
    test(`REAL BUNDLE: ${faultWhat} on the comparison read, over ${shapeWhat} and an edit of nothing — the push of the copy is refused with the typed error, and the copy is put back as the server has it`, async () => {
      const f = await freshSdk(initial);
      await f.sdk.fetchArtifact('app', APP_ID);
      const header = await applyAppHeader(f.sdk, spec(), APP_ID, { warn: () => {} });
      assert.deepStrictEqual(header, { changed: false, routing: false, replaced: {} }, 'the build edited nothing (an array-valued or number text is reported as not applied; a localized one that holds the spec\'s text, or one the spec does not set, is silent)');
      const injected = failComparisonRead(f, fault);
      await assert.rejects(pushAppHeader(f.sdk, APP_ID, 'Probe', header), (e) => {
        assert.ok(e instanceof SdkError);
        assert.strictEqual(e.code, NOT_PLAIN);
        assert.match(e.message, described);
        return true;
      });
      assert.strictEqual(injected.reads.length, 1);
      assert.deepStrictEqual([headerWrites(f.writes), f.state.refused, sitemapWrites(f.writes)], [[], [], []]);
      const kept = await f.sdk.getArtifact('app', APP_ID);
      assert.deepStrictEqual([kept.name, kept.description], [held.name || 'Probe', held.description || 'Tickets'], 'the copy holds what the server holds');
    });
  }
}

// What must NOT change: the guard looks at what would be SENT, not at why. A header that is plain text still has the SDK write it from the copy when the comparison read cannot be made —
// the same text the row holds, on the row's token, as it always did — and the rest of the push goes on.
test('REAL BUNDLE: a failed comparison read over a PLAIN header still has the header written from the copy, as the SDK always did — and the navigation after it', async () => {
  for (const [what, fault] of COMPARISON_FAULTS) {
    const f = await freshSdk();
    const injected = failComparisonRead(f, fault);
    const { changed, pushed } = await rebuild(f.sdk, spec());
    assert.strictEqual(changed.changed, false, what);
    assert.strictEqual(pushed.saved, true, `${what}: ${JSON.stringify(pushed.error && pushed.error.message)}`);
    assert.strictEqual(injected.reads.length, 1, what);
    assert.deepStrictEqual(headerWrites(f.writes).map((w) => w.body), [{ name: 'Probe', description: 'Tickets' }], `${what}: the copy's own text`);
    assert.strictEqual(headerWrites(f.writes)[0].ifMatch, 'W/"1"', `${what}: on the row's token`);
    assert.strictEqual(sitemapWrites(f.writes).length, 1, `${what}: and the navigation is written`);
    assert.deepStrictEqual(f.state.refused, [], what);
  }
});

test('REAL BUNDLE: a header edit that needs no refusal is untouched by the guard — a plain edit, written once, on the token the fetch read', async () => {
  const f = await freshSdk();
  const { changed, pushed } = await rebuild(f.sdk, spec({ name: 'Help Desk', description: 'Track tickets.', aiDescription: ROUTING }));
  assert.strictEqual(changed.changed, true);
  assert.strictEqual(pushed.saved, true);
  assert.deepStrictEqual(headerWrites(f.writes).map((w) => [w.body, w.ifMatch]), [[{ name: 'Help Desk', description: 'Track tickets.', aiappdescription: ROUTING }, 'W/"1"']]);
  assert.deepStrictEqual(f.state.refused, []);
});
