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
//   5. a header whose name or description is not plain text (a text per language) is never sent, and the one text does not hold the other back. The SDK
//      writes only the texts that changed, and neither compares nor writes a text REMOVED from the copy (`removeElement('app', id, '/name')`). So the build
//      edits the plain text beside a localized one on its own — the localized text keeps every translation — and takes the text that is not plain off the
//      copy right before the push (pushAppHeader), which is the one place that pushes a copy. Only that text's OWN edit is held back, with a warning, and the
//      routing description is applied as usual (the tests at the end of this file);
//   6. the SDK decides for itself whether the header is written: when its OWN comparison read of the header fails (503, 403, a thrown error, an empty 200)
//      it writes every text the copy holds. A text taken off the copy is not on it, so it is not written even then. And the client every SDK is made with
//      still refuses a PATCH of an app module row whose name or description is not a string (lib/app-header-text.js), for a copy the build did not clean:
//      nothing that is not plain text reaches the wire, and the push fails with APP_HEADER_NOT_PLAIN_TEXT before the navigation is written (the last tests of this file).
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
const ICON_ID = '77777777-7777-4777-8777-777777777777';
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
  // The web resource a first build creates (the generated app icon) is held in two layers, as the platform holds it: the POST writes the
  // SAVED content, a PublishXml that names the row (`<webresources><webresource>{id}</webresource></webresources>`) copies it to the
  // PUBLISHED layer, and the plain read by id — the read-back the SDK makes after its publish, `GET /webresourceset({id})?$select=content`
  // — answers the published content. A row no publish has named answers 404 here (assumed: the plain read of a never-published web resource
  // is not measured; the build's own create always publishes).
  const webResources = new Map();
  const httpClient = {
    get: async (url) => {
      const wr = /\/webresourceset\(([0-9a-f-]{36})\)\?\$select=content$/i.exec(String(url));
      if (wr) {
        const row = webResources.get(wr[1].toLowerCase());
        return row && row.published !== undefined ? { status: 200, headers: {}, body: { webresourceid: wr[1], content: row.published } } : { status: 404, headers: {}, body: { error: { message: 'Does Not Exist' } } };
      }
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
    post: async (url, body) => {
      writes.push({ verb: 'post', url: String(url), body });
      if (/\/webresourceset$/.test(String(url))) {
        webResources.set(ICON_ID, { saved: body.content });
        return { status: 204, headers: { 'odata-entityid': `https://contoso.crm.dynamics.com/api/data/v9.2/webresourceset(${ICON_ID})` }, body: {} };
      }
      if (/\/PublishXml$/.test(String(url))) {
        for (const [, id] of String((body && body.ParameterXml) || '').matchAll(/<webresource>([^<]+)<\/webresource>/g)) {
          const row = webResources.get(id.toLowerCase());
          if (row) row.published = row.saved;
        }
      }
      return { status: 204, headers: { 'odata-entityid': `https://x/y(${APP_ID})` }, body: {} };
    },
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
// What a rebuild of an existing app does: edit the fetched copy, rewrite its sitemap, push once — through pushAppHeader, the one place the build pushes a
// copy, so that a text of the header that is not plain is taken off the copy as it is in a build. `changed` is what the header edit answered (applyAppHeader:
// { changed, routing, replaced, held }).
async function rebuild(sdk, s, apply = applyAppHeader) {
  await sdk.fetchArtifact('app', APP_ID);
  const changed = await apply(sdk, s, APP_ID);
  await sdk.updateElement('app', APP_ID, '/siteMap', appDef(s, { forms: {}, views: {}, charts: {} }).siteMap);
  const pushed = await pushAppHeader(sdk, APP_ID, s.app.name, changed);
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

// A header text that is not plain — a text per language (a map keyed by LCID), a list, a number — is never sent, as a map or as a scalar. The adapter hands
// back one string per column for a real app, so this is a safety net for a shape the SDK may return, served here by the fake. What it must guarantee is the same
// in every case: the text is neither edited nor sent, and its own edit — only that — is held back and reported. The other text and the routing description are
// applied as usual and written alone (the SDK sends only what changed), with the navigation.
const localizedText = (english, french) => ({ 1033: english, 1036: french });
// [what, the header the environment holds, the spec's app, the header PATCH bodies the build sends, the text its edits replaced, the warnings it gives]
const HELD_CASES = [
  ['a localized name beside a changed description', { name: localizedText('Probe', 'Sonde') }, { description: 'Changed' },
    [{ description: 'Changed' }], { description: 'Tickets' }, []],
  ['a localized description beside a changed name', { description: localizedText('Tickets', 'Billets') }, { name: 'Help Desk' },
    [{ name: 'Help Desk' }], { name: 'Probe' }, []],
  ['a localized description beside a changed name and a changed description', { description: localizedText('Tickets', 'Billets') }, { name: 'Help Desk', description: 'Changed' },
    [{ name: 'Help Desk' }], { name: 'Probe' },
    [/^app "Help Desk": its description was not applied: it is localized \(2 languages: 1033, 1036\), and a rebuild does not replace a localized text — it cannot tell which language the spec's text is for, nor that the other translations would be kept\. Change it in Power Apps\.$/]],
  ['two localized texts beside a routing description', { name: localizedText('Probe', 'Sonde'), description: localizedText('Tickets', 'Billets') }, { aiDescription: ROUTING },
    [{ aiappdescription: ROUTING }], {}, []],
  ['a localized name beside a routing description', { name: localizedText('Probe', 'Sonde') }, { aiDescription: ROUTING },
    [{ aiappdescription: ROUTING }], {}, []],
  ['a list for the name beside a changed description', { name: ['Probe'] }, { description: 'Changed' },
    [{ description: 'Changed' }], { description: 'Tickets' },
    [/^app "Probe": its name was not applied: the app's name could not be read as plain text \(it came back as a list\), so a rebuild does not replace it\. Change it in Power Apps\.$/]],
  ['a number for the description beside a changed name', { description: 7 }, { name: 'Help Desk' },
    [{ name: 'Help Desk' }], { name: 'Probe' },
    [/^app "Help Desk": its description was not applied: the app's description could not be read as plain text \(it came back as a number\), so a rebuild does not replace it\. Change it in Power Apps\.$/]],
];

for (const [what, initial, app, bodies, replaced, expected] of HELD_CASES) {
  test(`REAL BUNDLE: ${what} — what changed is written alone, the text that is not plain is never sent, and the build says what it left`, async () => {
    const { sdk, writes, state } = await freshSdk(initial);
    await sdk.fetchArtifact('app', APP_ID);
    const warnings = [];
    const s = spec(app);
    const header = await applyAppHeader(sdk, s, APP_ID, { warn: (m) => warnings.push(m) });
    await sdk.updateElement('app', APP_ID, '/siteMap', appDef(s, { forms: {}, views: {}, charts: {} }).siteMap);
    const pushed = await pushAppHeader(sdk, APP_ID, 'Probe', header, undefined, (m) => warnings.push(m));
    assert.strictEqual(pushed.saved, true, JSON.stringify(pushed.error && pushed.error.message));
    assert.deepStrictEqual(header.replaced, replaced, 'the text its edits replaced');
    assert.deepStrictEqual(headerWrites(writes).map((w) => w.body), bodies, 'one PATCH, of what changed alone');
    assert.deepStrictEqual(state.refused, [], 'and nothing a String column cannot take was ever sent');
    for (const [key, value] of Object.entries(initial)) assert.deepStrictEqual(state[key], value, `the environment still holds the maker's ${key}, every translation of it`);
    assert.strictEqual(sitemapWrites(writes).length, 1, 'the navigation is written, as it always is');
    assert.strictEqual(warnings.length, expected.length, JSON.stringify(warnings));
    for (const re of expected) assert.ok(warnings.some((w) => re.test(w)), `${re} in ${JSON.stringify(warnings)}`);
  });
}

// The two cases that decide the policy, named for what they pin: the plain text beside a localized one is written on its own, whichever it is, and the localized one keeps
// every translation (the environment's row is read back after the push).
test('REAL BUNDLE: a localized name with a changed plain description — only the description is written, and the name\'s translations are untouched', async () => {
  const name = localizedText('Probe', 'Sonde');
  const { sdk, writes, state } = await freshSdk({ name });
  const built = await runSdkBuild(spec({ uniqueName: APP_UNIQUE, description: 'Track tickets.' }), { sdk, apply: true, publish: true, genpage: fakeGenpage(), workspaceDir: workspaceDir(), env: 'https://contoso.crm.dynamics.com', phases: ['app-shell', 'publish'] });
  assert.strictEqual(built.ok, true);
  assert.deepStrictEqual(headerWrites(writes).map((w) => [w.body, w.ifMatch]), [[{ description: 'Track tickets.' }, 'W/"1"']], 'the description alone, conditioned on the row token the fetch read');
  assert.deepStrictEqual([state.name, state.description], [name, 'Track tickets.'], 'the row holds the new description and the name\'s translations');
});

test('REAL BUNDLE: a localized description with a changed plain name — only the name is written, and the description\'s translations are untouched', async () => {
  const description = localizedText('Tickets', 'Billets');
  const { sdk, writes, state } = await freshSdk({ description });
  const built = await runSdkBuild(spec({ uniqueName: APP_UNIQUE, name: 'Help Desk' }), { sdk, apply: true, publish: true, genpage: fakeGenpage(), workspaceDir: workspaceDir(), env: 'https://contoso.crm.dynamics.com', phases: ['app-shell', 'publish'] });
  assert.strictEqual(built.ok, true);
  assert.deepStrictEqual(headerWrites(writes).map((w) => [w.body, w.ifMatch]), [[{ name: 'Help Desk' }, 'W/"1"']]);
  assert.deepStrictEqual([state.name, state.description], ['Help Desk', description]);
});

// What the build leans on to keep a text off the wire: a text REMOVED from the copy is neither compared nor written, the copy is clean once the push has saved,
// and a plain fetch brings the maker's text back (the next run starts from the environment's header, not from a copy without one).
test('REAL BUNDLE: the text taken off the copy is not written, the copy is clean after the push, and a plain fetch brings the maker\'s text back', async () => {
  const name = localizedText('Probe', 'Sonde');
  const { sdk, writes } = await freshSdk({ name });
  const { pushed } = await rebuild(sdk, spec({ description: 'Changed' }));
  assert.strictEqual(pushed.saved, true);
  const afterPush = await sdk.getArtifact('app', APP_ID);
  assert.strictEqual(afterPush.name, undefined, 'the copy no longer holds the name the build kept off the wire');
  assert.strictEqual(afterPush.description, 'Changed');
  assert.strictEqual((await sdk.listArtifacts('app')).find((a) => a.id === APP_ID).isDirty, false, 'a push that saved leaves the copy clean: nothing is left for the next run to refuse');
  assert.deepStrictEqual(headerWrites(writes).map((w) => w.body), [{ description: 'Changed' }]);
  assert.deepStrictEqual((await sdk.fetchArtifact('app', APP_ID)).name, name, 'and the next run\'s fetch reads the environment\'s name again, translations included');
});

// The edit of a text is applied to the copy, and a text that is not plain is taken off it only when a push follows: the header edit alone leaves the copy as the fetch read it,
// so a run that does not push (the routing description of a page-backed app, say) leaves no edit behind for the next run to refuse (refuseUnpushedAppCopy).
test('REAL BUNDLE: applying a header over a text that is not plain changes nothing on the copy but the edits: it is taken off only by the push', async () => {
  const name = localizedText('Probe', 'Sonde');
  const { sdk } = await freshSdk({ name });
  await sdk.fetchArtifact('app', APP_ID);
  const header = await applyAppHeader(sdk, spec(), APP_ID, { warn: () => assert.fail('nothing to say: the spec asks for nothing the header does not already hold') });
  assert.deepStrictEqual([header.changed, header.routing, header.replaced], [false, false, {}]);
  assert.deepStrictEqual(header.held.map(({ key }) => key), ['name'], 'the text that has to stay off the wire');
  assert.deepStrictEqual((await sdk.getArtifact('app', APP_ID)).name, name, 'still on the copy');
  assert.strictEqual((await sdk.listArtifacts('app')).find((a) => a.id === APP_ID).isDirty, false, 'and the copy is clean');
});

// A never-published app takes no write to its header until it is published: the SDK throws before it writes the navigation, the build puts the edited text back, and the same
// copy then saves the navigation. The text taken off the copy stays off it for that second push, and is never in either request.
test('REAL BUNDLE: a never-published app over a localized name — the description edit is not applied and put back, the name is in neither push, and the navigation is written', async () => {
  const name = localizedText('Probe', 'Sonde');
  const { sdk, writes, state } = await freshSdk({ name, headerStatus: 400 });
  const s = spec({ description: 'Track tickets.' });
  await sdk.fetchArtifact('app', APP_ID);
  const warnings = [];
  const header = await applyAppHeader(sdk, s, APP_ID, { warn: (m) => warnings.push(m) });
  await sdk.updateElement('app', APP_ID, '/siteMap', appDef(s, { forms: {}, views: {}, charts: {} }).siteMap);
  const pushed = await pushAppHeader(sdk, APP_ID, 'Probe', header, undefined, (m) => warnings.push(m));
  assert.strictEqual(pushed.saved, true, JSON.stringify(pushed.error && pushed.error.message));
  assert.deepStrictEqual(headerWrites(writes).map((w) => w.body), [{ description: 'Track tickets.' }], 'the one refused header PATCH carried the description alone, never the name');
  assert.strictEqual(sitemapWrites(writes).length, 1, 'and the push without it wrote the navigation');
  assert.strictEqual(warnings.length, 1, JSON.stringify(warnings));
  assert.match(warnings[0], /^app "Probe": its description was not applied: the app was never published; publish it in Power Apps and re-run\./);
  assert.deepStrictEqual([state.name, state.description], [name, 'Tickets'], 'the environment is as it was');
  const held = await sdk.getArtifact('app', APP_ID);
  assert.deepStrictEqual([held.name, held.description], [undefined, 'Tickets'], 'the description is put back, and the name stays off the copy');
});

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

test('REAL BUNDLE: a transport that refuses a non-string name or description is never asked to — the build\'s push is the description and the navigation', async () => {
  // The consequence the guard prevents, with a fake that refuses what a String column cannot take: the header PATCH answers 400, and the SDK
  // throws before it writes the navigation, so one text of the header would have stopped the app step. Taken off the copy, it is not in the request.
  const { sdk, writes, state } = await freshSdk({ name: localizedText('Probe', 'Sonde') });
  const warnings = [];
  await sdk.fetchArtifact('app', APP_ID);
  const s = spec({ description: 'Changed' });
  const header = await applyAppHeader(sdk, s, APP_ID, { warn: (m) => warnings.push(m) });
  await sdk.updateElement('app', APP_ID, '/siteMap', appDef(s, { forms: {}, views: {}, charts: {} }).siteMap);
  const pushed = requireSuccessfulPush(await pushAppHeader(sdk, APP_ID, 'Probe', header), 'app Probe');
  assert.strictEqual(pushed.saved, true);
  assert.deepStrictEqual(state.refused, []);
  assert.deepStrictEqual(headerWrites(writes).map((w) => w.body), [{ description: 'Changed' }]);
  assert.strictEqual(sitemapWrites(writes).length, 1);
  assert.match(sitemapWrites(writes)[0].body.sitemapxml, /Entity="new_torder"/, 'the navigation the run built is what was written');
});

// The whole app step, through runSdkBuild, over the same fake: the build goes on past a text it will not edit — the other text and the routing description are
// written alone, then the navigation, the publish of the app and, with the pages phase, the finalizer that is then the app's only writer.
test('REAL BUNDLE: a complete rebuild over a header that is not plain text finishes — what changed written alone, navigation written, app published (with and without the pages phase)', async () => {
  for (const [what, initial, app, bodies] of [
    ['a localized name beside a changed description', { name: localizedText('Probe', 'Sonde') }, { description: 'Changed' }, [{ description: 'Changed' }]],
    ['a localized description beside a routing description', { description: localizedText('Tickets', 'Billets') }, { aiDescription: ROUTING }, [{ aiappdescription: ROUTING }]],
    // Both texts off the copy: the SDK is supplied none of them, and the routing description is what its one PATCH carries.
    ['two localized texts beside a routing description', { name: localizedText('Probe', 'Sonde'), description: localizedText('Tickets', 'Billets') }, { aiDescription: ROUTING }, [{ aiappdescription: ROUTING }]],
  ]) {
    for (const pages of [false, true]) {
      const { sdk, writes, state } = await freshSdk(initial);
      const warnings = [];
      const built = await runSdkBuild(spec({ uniqueName: APP_UNIQUE, ...app }), { sdk, apply: true, publish: true, genpage: fakeGenpage(), workspaceDir: workspaceDir(), env: 'https://contoso.crm.dynamics.com',
        phases: pages ? ['app-shell', 'pages', 'publish'] : ['app-shell', 'publish'], warn: (m) => warnings.push(m) });
      const label = `${what}${pages ? ', with the pages phase' : ''}`;
      assert.strictEqual(built.ok, true, label);
      assert.deepStrictEqual(headerWrites(writes).map((w) => w.body), bodies, `${label}: one header PATCH, of what changed alone`);
      assert.deepStrictEqual(state.refused, [], label);
      for (const [key, value] of Object.entries(initial)) assert.deepStrictEqual(state[key], value, `${label}: the maker's ${key} is as it was`);
      assert.strictEqual(sitemapWrites(writes).length, 1, `${label}: the navigation is written once`);
      const published = writes.filter((w) => /\/PublishXml/.test(w.url) && /<appmodule>/.test((w.body || {}).ParameterXml || ''));
      assert.ok(published.length > 0 && writes.indexOf(published[0]) > writes.indexOf(sitemapWrites(writes)[0]), `${label}: the app is published after its navigation`);
      assert.deepStrictEqual(warnings.filter((w) => /was not applied/.test(w)), [], `${label}: nothing was left unapplied`);
    }
  }
  // The neighbour: the same rebuild of a plain header writes it, as before.
  const { sdk, writes } = await freshSdk();
  const built = await runSdkBuild(spec({ uniqueName: APP_UNIQUE, name: 'Help Desk', description: 'Changed' }), { sdk, apply: true, publish: true, genpage: fakeGenpage(), workspaceDir: workspaceDir(), env: 'https://contoso.crm.dynamics.com', phases: ['app-shell', 'publish'] });
  assert.strictEqual(built.ok, true);
  assert.deepStrictEqual(headerWrites(writes).map((w) => w.body), [{ name: 'Help Desk', description: 'Changed' }]);
});

// --- the SDK's OWN comparison read fails: a text taken off the copy is not written, and the client is the last line of defence ------------------------------------
//
// The SDK's push of an app decides for itself whether the header is written: it reads the header and compares it with the copy's, and when that read cannot be made (HTTP 503 or 403, a transport that
// throws, a 200 with no row) it writes EVERY text the copy holds. So the build takes the text that is not plain off the copy right before the push (pushAppHeader): a text that is not on the copy is not written
// even then, and the build goes on. Pinned here with a fault in the fake server. For a copy the build did not clean — the page backend's push of the app, say — the client the SDK is made with
// (lib/app-header-text.js, wired in lib/maker-sdk.js, the one way a script makes an SDK) is the last line of defence: it refuses a PATCH that carries such a text before any byte is sent, the push fails with the
// typed error, and since the SDK writes the header first, it wrote nothing of its navigation either.

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
  ['a localized name', localizedText('Probe', 'Sonde'), /the app's name is localized \(2 languages: 1033, 1036\)\. Nothing was sent/, null],
  // The spec's name is not one of a list's entries, so the name's own edit is held back and reported (a localized name that holds the spec's text needs no word).
  ['an array-valued name', ['Probe'], /the app's name could not be read as plain text \(it came back as a list\)\. Nothing was sent/, /^app "Probe": its name was not applied: the app's name could not be read as plain text \(it came back as a list\), so a rebuild does not replace it\./],
];
const PUSH_SITES = [['app-shell + publish', false], ['app-shell + pages + publish', true]];

for (const [faultWhat, fault] of COMPARISON_FAULTS) {
  for (const [shapeWhat, shape, , ownEditWarning] of PROTECTED_NAMES) {
    for (const [siteWhat, pages] of PUSH_SITES) {
      test(`REAL BUNDLE: ${faultWhat} on the SDK's own comparison read, over ${shapeWhat}, ${siteWhat} — the text that is not plain is never sent: the changed description is written alone, and the build finishes`, async () => {
        const f = await freshSdk({ name: shape, existingIcon: true });
        const injected = failComparisonRead(f, fault);
        const warnings = [];
        // A changed description beside the protected name: the build applies it, takes the name off the copy, and the SDK is then asked to push the copy.
        const built = await runSdkBuild(spec({ uniqueName: APP_UNIQUE, description: 'Changed' }), {
          sdk: f.sdk, apply: true, publish: true, genpage: fakeGenpage(), workspaceDir: workspaceDir(), env: 'https://contoso.crm.dynamics.com',
          phases: pages ? ['app-shell', 'pages', 'publish'] : ['app-shell', 'publish'], warn: (m) => warnings.push(m),
        });
        assert.strictEqual(built.ok, true);
        assert.strictEqual(injected.reads.length, 1, 'the fault reached the SDK\'s one comparison read of the header');
        // The read could not be made, so the SDK wrote every text the copy held: the description — on the row's token, as for a plain header — and not the name, which was no longer on the copy.
        assert.deepStrictEqual(headerWrites(f.writes).map((w) => [w.body, w.ifMatch]), [[{ description: 'Changed' }, 'W/"1"']]);
        assert.deepStrictEqual(f.state.refused, [], 'nothing a String column cannot take reached the server');
        assert.strictEqual(sitemapWrites(f.writes).length, 1, 'the navigation is written once');
        const published = f.writes.filter((w) => /\/PublishXml/.test(w.url) && /<appmodule>/.test((w.body || {}).ParameterXml || ''));
        assert.ok(published.length > 0 && f.writes.indexOf(published[0]) > f.writes.indexOf(sitemapWrites(f.writes)[0]), 'the app is published after its navigation');
        assert.deepStrictEqual([f.state.name, f.state.description], [shape, 'Changed'], 'the name is still the maker\'s, and the description is the spec\'s');
        assert.deepStrictEqual(warnings.filter((w) => /was not applied/.test(w)).map((w) => ownEditWarning && ownEditWarning.test(w)), ownEditWarning ? [true] : [], 'only the name\'s own edit, when the spec\'s name is not one the text already holds, is left unapplied');
      });
    }
  }
}

// The same fault with nothing edited at all (`changed: false`) — the case a hold on the edits cannot see: the SDK is still asked to push the copy, and writes the texts it holds. The text that is not plain is off the
// copy, so only the other one is written: the copy's own, which is the row's (the SDK has no row to compare it with), on the row's token, as for a header that is plain. Both off: nothing is left to write.
// [what, the header the environment holds, the text the guard names in its refusal of a copy that still holds it, the header PATCH bodies the push makes]
const PROTECTED_HEADERS = [
  ...PROTECTED_NAMES.map(([what, name, described]) => [what, { name }, described, [{ description: 'Tickets' }]]),
  ['a localized description', { description: localizedText('Tickets', 'Billets') }, /the app's description is localized \(2 languages: 1033, 1036\)\. Nothing was sent/, [{ name: 'Probe' }]],
  ['a list for the description', { description: ['Tickets'] }, /the app's description could not be read as plain text \(it came back as a list\)\. Nothing was sent/, [{ name: 'Probe' }]],
  ['a localized name and description', { name: localizedText('Probe', 'Sonde'), description: localizedText('Tickets', 'Billets') },
    /the app's name is localized \(2 languages: 1033, 1036\) and its description is localized \(2 languages: 1033, 1036\)\. Nothing was sent/, []],
];
for (const [faultWhat, fault] of COMPARISON_FAULTS) {
  for (const [shapeWhat, initial, , bodies] of PROTECTED_HEADERS) {
    test(`REAL BUNDLE: ${faultWhat} on the comparison read, over ${shapeWhat} and an edit of nothing — the push goes on without the text that is not plain, and the other text is written as it is`, async () => {
      const f = await freshSdk(initial);
      await f.sdk.fetchArtifact('app', APP_ID);
      const header = await applyAppHeader(f.sdk, spec(), APP_ID, { warn: () => {} });
      assert.deepStrictEqual([header.changed, header.routing, header.replaced], [false, false, {}], 'the build edited nothing (an array-valued or number text is reported as not applied; a localized one that holds the spec\'s text, or one the spec does not set, is silent)');
      const injected = failComparisonRead(f, fault);
      const pushed = await pushAppHeader(f.sdk, APP_ID, 'Probe', header);
      assert.strictEqual(pushed.saved, true, JSON.stringify(pushed.error && pushed.error.message));
      assert.strictEqual(injected.reads.length, 1);
      assert.deepStrictEqual(headerWrites(f.writes).map((w) => w.body), bodies);
      assert.deepStrictEqual(f.state.refused, []);
      assert.strictEqual(sitemapWrites(f.writes).length, 1, 'and the navigation is written');
      for (const [key, value] of Object.entries(initial)) assert.deepStrictEqual(f.state[key], value, `the maker's ${key} is as it was`);
    });
  }
}

// The client is the last line of defence, and it stays: the build's push never carries such a text, but a push of a copy that still holds one — which the build did not make — is refused with the typed error, before
// a byte is sent, when the SDK's read fails. Nothing was written, not even the navigation, and a re-run finds the read answering.
for (const [faultWhat, fault] of COMPARISON_FAULTS) {
  for (const [shapeWhat, initial, described] of PROTECTED_HEADERS) {
    test(`REAL BUNDLE: ${faultWhat} on the comparison read, over ${shapeWhat}, pushed as the SDK holds it — the client refuses the write with the typed error before a byte is sent`, async () => {
      const f = await freshSdk(initial);
      await f.sdk.fetchArtifact('app', APP_ID);
      const injected = failComparisonRead(f, fault);
      await assert.rejects(f.sdk.pushArtifact('app', APP_ID), (e) => {
        assert.ok(e instanceof SdkError, 'the SDK rethrew the client\'s error as it is');
        assert.strictEqual(e.code, NOT_PLAIN);
        assert.strictEqual(e.transient, false);
        assert.match(e.message, described);
        return true;
      });
      assert.strictEqual(injected.reads.length, 1);
      assert.deepStrictEqual([headerWrites(f.writes), f.state.refused, sitemapWrites(f.writes)], [[], [], []], 'nothing was sent, and the SDK writes the header first, so the navigation was not written either');
      // The copy is as the fetch read it, so a re-run's push — the read answers now — finds it equal to the row and sends no header at all.
      assert.deepStrictEqual((await f.sdk.pushArtifact('app', APP_ID)).saved, true);
      assert.deepStrictEqual(headerWrites(f.writes), []);
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
