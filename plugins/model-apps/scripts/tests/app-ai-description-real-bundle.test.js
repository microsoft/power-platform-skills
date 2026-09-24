'use strict';
// REAL BUNDLE: the app routing description (`app.aiDescription` -> `appmodule.aiappdescription`, #583).
//
// The plugin's `applyAppAiDescription` and `haltOnUnpublishedAppHeader` lean on five SDK behaviours that
// its own unit tests can only stub:
//   1. a fetched app carries `aiDescription` ONLY when the row has a value;
//   2. `updateElement('/aiDescription')` on such an app rejects with PATH_NOT_FOUND, while an
//      `addElement` at the artifact root adds the key;
//   3. the push PATCHes `aiappdescription` only when the value is set AND differs from the draft row —
//      so an equal value, or a spec that leaves it out, never touches a platform-written description;
//   4. a 412 on that PATCH RESOLVES `{ saved:false }` with a VERSION_CONFLICT error rather than throwing,
//      which is the shape the plugin's pending-draft halt keys on;
//   5. after such a refused push, a plain fetch refuses to discard the unpushed copy once the server has
//      moved (LOCAL_EDITS_WOULD_BE_LOST), and `{ overwrite: true }` resets it — which is why the halt
//      resets the copy before telling the operator to publish and re-run.
// A re-vendor could change any of them with every plugin test still green, so each is pinned here
// against the real bundle over a fake Dataverse — the same way sitemap-icon-real-bundle.test.js pins
// the sitemap write.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { appDef, applyAppAiDescription, haltOnUnpublishedAppHeader, pushAppHeader } = require('../lib/sdk-build.js');
const { requireSuccessfulPush } = require('../lib/entity-provision.js');

const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');
const APP_ID = '11111111-1111-1111-1111-111111111111';
const APP_UNIQUE = 'new_probeapp';
const APP_IDUNIQUE = '33333333-3333-3333-3333-333333333333';
const TABLE_METADATA_ID = '22222222-2222-2222-2222-222222222222';
const SITEMAP_ID = '55555555-5555-5555-5555-555555555555';
// Every app the plugin creates carries an icon, and the SDK requires one at create (see
// header-nav-real-bundle.test.js).
const APP_ICON_ID = '11111111-2222-3333-4444-555555555555';
const WANT = 'Dispatch work: assigning and rescheduling tickets. Prefer My Work for your own items.';

const SITEMAP_XML = '<SiteMap IntroducedVersion="7.0.0.0"><Area Id="area_0" ShowGroups="true"><Titles><Title LCID="1033" Title="Main" /></Titles>'
  + '<Group Id="group_0_0"><Titles><Title LCID="1033" Title="Main" /></Titles>'
  + '<SubArea Id="sub_0_0_0" Entity="new_torder" Client="All" Sku="All"><Titles><Title LCID="1033" Title="Orders" /></Titles></SubArea>'
  + '</Group></Area></SiteMap>';

const tempDirs = [];
test.after(() => { for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true }); });

/**
 * A real SDK over a fake Dataverse holding one app. `ai` is the row's `aiappdescription` (omitted when
 * undefined), `componentstate` its draft state, and `headerStatus` the status the appmodule PATCH answers.
 * All three live on the returned `state`, which the fake reads on every call, so a test can change the
 * server under the SDK — e.g. the operator publishing between two runs, which also moves the etag.
 */
async function freshSdk({ ai, componentstate = 0, headerStatus = 204, sitemapStatus = 204 } = {}) {
  const { createMakerSdk, createNodeWorkspaceStorage } = require(BUNDLE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-description-'));
  tempDirs.push(dir);
  const writes = [];
  const reads = [];
  const state = { ai, componentstate, headerStatus, sitemapStatus, etag: 'W/"1"' };
  const appRow = () => ({ appmoduleid: APP_ID, appmoduleidunique: APP_IDUNIQUE, name: 'Probe', uniquename: APP_UNIQUE, description: 'Tickets', componentstate: state.componentstate, ...(state.ai !== undefined ? { aiappdescription: state.ai } : {}), '@odata.etag': state.etag });
  const sitemapRow = () => ({ sitemapid: SITEMAP_ID, sitemapnameunique: APP_UNIQUE, sitemapxml: SITEMAP_XML, '@odata.etag': state.etag });
  const httpClient = {
    get: async (url) => {
      reads.push(String(url));
      const m = /EntityDefinitions\(LogicalName='([^']+)'\)/.exec(url);
      if (m) return { status: 200, headers: {}, body: { LogicalName: m[1], MetadataId: TABLE_METADATA_ID, EntitySetName: `${m[1]}s` } };
      if (/\/appmodulecomponents/.test(url)) {
        // componenttype 62 is the SITEMAP component; 1 is a table. The filter arrives URL-encoded.
        const wantsSitemap = /componenttype(%20| )eq(%20| )62/.test(url);
        return { status: 200, headers: {}, body: { value: wantsSitemap ? [{ objectid: SITEMAP_ID, componenttype: 62 }] : [{ objectid: TABLE_METADATA_ID, componenttype: 1 }] } };
      }
      // A collection read (`?$filter=…` or RetrieveUnpublishedMultiple) answers `{ value: [...] }`; a
      // by-id read answers the row itself.
      if (/\/sitemaps/.test(url)) {
        const multi = /RetrieveUnpublishedMultiple/i.test(url) || /\/sitemaps\?/.test(url);
        return { status: 200, headers: { etag: state.etag }, body: multi ? { value: [sitemapRow()] } : sitemapRow() };
      }
      if (/\/appmodules/.test(url)) {
        // The halt's own draft read. While a draft exists, put the PUBLISHED row first, so the test proves
        // the unpublished layer is found wherever it sits: the live platform returned only the draft row,
        // but does not document that. The SDK's own reads never select componentstate, so they are unaffected.
        if (/componentstate/.test(decodeURIComponent(url)) && state.componentstate === 1) {
          return { status: 200, headers: {}, body: { value: [{ ...appRow(), componentstate: 0 }, appRow()] } };
        }
        const multi = /RetrieveUnpublishedMultiple/i.test(url) || /\/appmodules\?/.test(url);
        return { status: 200, headers: { etag: state.etag }, body: multi ? { value: [appRow()] } : appRow() };
      }
      if (/\/roles/.test(url)) return { status: 200, headers: {}, body: { value: [{ roleid: '66666666-6666-6666-6666-666666666666' }] } };
      return { status: 200, headers: {}, body: { value: [] } };
    },
    post: async (url, body) => {
      writes.push({ verb: 'post', url: String(url), body });
      return { status: 204, headers: { 'odata-entityid': `https://x/y(${APP_ID})` }, body: {} };
    },
    patch: async (url, body) => {
      writes.push({ verb: 'patch', url: String(url), body });
      if (/\/appmodules\(/.test(url)) {
        if (state.headerStatus !== 204) {
          // 400 is how Dataverse refuses a header write on a never-published appmodule; the SDK recognises
          // it by this phrase and THROWS APP_DRAFT_HEADER_NOT_WRITABLE. 412 is the returned conflict.
          const message = state.headerStatus === 400 ? 'The retrieval of version numbers failed.' : 'The version of the existing record doesn\'t match the RowVersion property provided.';
          return { status: state.headerStatus, headers: {}, body: { error: { code: '0x80060882', message } } };
        }
        if (body && body.aiappdescription !== undefined) state.ai = body.aiappdescription;
        // LIVE-MEASURED: a header write that is not yet published leaves the row an unpublished layer.
        state.componentstate = 1;
      }
      if (/\/sitemaps\(/.test(url) && state.sitemapStatus !== 204) {
        return { status: state.sitemapStatus, headers: {}, body: { error: { code: '0x80060882', message: 'The version of the existing record doesn\'t match the RowVersion property provided.' } } };
      }
      return { status: 204, headers: { etag: 'W/"2"' }, body: {} };
    },
    delete: async () => ({ status: 204, headers: {}, body: {} }),
    put: async () => ({ status: 204, headers: {}, body: {} }),
  };
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: 'https://contoso.crm.dynamics.com', httpClient });
  await sdk.initWorkspace();
  return { sdk, writes, reads, state };
}

const spec = (aiDescription) => ({
  solution: { uniqueName: 'probe', publisherPrefix: 'new' },
  app: { name: 'Probe', description: 'Tickets', ...(aiDescription !== undefined ? { aiDescription } : {}) },
  appShell: { areas: [{ label: 'Main', groups: [{ label: 'Main', subAreas: [{ entity: 'new_torder', label: 'Orders' }] }] }] },
});
const headerWrites = (writes) => writes.filter((w) => /\/appmodules/.test(w.url) && w.body && typeof w.body === 'object');
const anyWriteCarries = (writes) => writes.some((w) => w.body && typeof w.body === 'object' && 'aiappdescription' in w.body);

test('REAL BUNDLE: a new app is created with the routing description the plugin projects', async () => {
  const { sdk, writes } = await freshSdk();
  const def = appDef(spec(WANT), { forms: {}, views: {}, charts: {} }, { iconWebResourceId: APP_ICON_ID });
  const art = await sdk.createArtifact('app', def);
  await sdk.pushArtifact('app', art.id);
  const create = writes.find((w) => w.verb === 'post' && /\/appmodules\b/.test(w.url) && w.body && w.body.uniquename);
  assert.ok(create, `an appmodule create was posted; writes: ${JSON.stringify(writes.map((w) => `${w.verb} ${w.url}`))}`);
  assert.strictEqual(create.body.aiappdescription, WANT);
});

test('REAL BUNDLE: an app with none has no key, refuses an update, and gets it ADDED and written', async () => {
  const { sdk, writes } = await freshSdk();
  const fetched = await sdk.fetchArtifact('app', APP_ID);
  assert.ok(!('aiDescription' in fetched), 'a fetched app carries the key only when the row has a value');
  // The contract the helper's add-vs-update branch exists for.
  // sdk-async-ok: the promise is handed to assert.rejects, which awaits it.
  await assert.rejects(sdk.updateElement('app', APP_ID, '/aiDescription', WANT), (e) => e && e.code === 'PATH_NOT_FOUND');

  assert.strictEqual(await applyAppAiDescription(sdk, spec(WANT), APP_ID), true);
  const res = await sdk.pushArtifact('app', APP_ID);
  assert.strictEqual(res.saved, true, JSON.stringify(res.error && res.error.message));
  const header = headerWrites(writes);
  assert.strictEqual(header.length, 1, 'one header write');
  assert.strictEqual(header[0].body.aiappdescription, WANT);
  assert.strictEqual(header[0].body.description, 'Tickets', 'the tile description rides through unchanged');
});

test('REAL BUNDLE: a different value is updated in place and written', async () => {
  const { sdk, writes } = await freshSdk({ ai: 'Old routing text.' });
  assert.strictEqual((await sdk.fetchArtifact('app', APP_ID)).aiDescription, 'Old routing text.');
  assert.strictEqual(await applyAppAiDescription(sdk, spec(WANT), APP_ID), true);
  assert.strictEqual((await sdk.pushArtifact('app', APP_ID)).saved, true);
  assert.deepStrictEqual(headerWrites(writes).map((w) => w.body.aiappdescription), [WANT]);
});

test('REAL BUNDLE: an equal value, or a spec without one, never writes the header', async () => {
  for (const [what, row, want] of [['an equal value', WANT, WANT], ['a spec without one', 'Written by the platform.', undefined]]) {
    const { sdk, writes } = await freshSdk({ ai: row });
    await sdk.fetchArtifact('app', APP_ID);
    assert.strictEqual(await applyAppAiDescription(sdk, spec(want), APP_ID), false, what);
    // The rebuild still rewrites the sitemap, exactly as the existing-app path does.
    await sdk.updateElement('app', APP_ID, '/siteMap', appDef(spec(want), { forms: {}, views: {}, charts: {} }).siteMap);
    assert.strictEqual((await sdk.pushArtifact('app', APP_ID)).saved, true, what);
    assert.ok(writes.some((w) => /\/sitemaps\(/.test(w.url)), `${what}: the sitemap was written`);
    assert.strictEqual(headerWrites(writes).length, 0, `${what}: the appmodule header is not PATCHed`);
    assert.ok(!anyWriteCarries(writes), `${what}: no write carries aiappdescription`);
  }
});

test('REAL BUNDLE: a 412 on the header resolves saved:false, and only a PROVEN draft is re-explained', async () => {
  for (const [componentstate, expected] of [[1, 'app-header-unpublished'], [0, 'version-conflict']]) {
    const { sdk, reads } = await freshSdk({ ai: 'Route Q1', componentstate, headerStatus: 412 });
    await sdk.fetchArtifact('app', APP_ID);
    assert.strictEqual(await applyAppAiDescription(sdk, spec(WANT), APP_ID), true);
    const res = await sdk.pushArtifact('app', APP_ID);
    // The by-value shape the halt keys on. Were the SDK to THROW here instead, the plugin's halt would
    // never run and the operator would get a raw SDK error.
    assert.strictEqual(res.saved, false);
    assert.strictEqual(res.error && res.error.code, 'VERSION_CONFLICT');
    // …and the refused request is named, which is how the halt tells the header's 412 from the sitemap's.
    assert.match(String(res.error.detail), /^Version conflict \(412\) from https:\/\/contoso\.crm\.dynamics\.com\/api\/data\/v[\d.]+\/appmodules\(11111111-1111-1111-1111-111111111111\)$/);

    const readsBefore = reads.length;
    let halt;
    try {
      await haltOnUnpublishedAppHeader(sdk, APP_ID, res, 'Probe');
      requireSuccessfulPush(res, 'app Probe');
    } catch (e) { halt = e; }
    assert.ok(halt, 'the refused push halts');
    assert.strictEqual(halt.code, expected, `componentstate ${componentstate}: ${halt.message}`);
    const draftRead = reads.slice(readsBefore).find((u) => /RetrieveUnpublishedMultiple/.test(u) && /componentstate/.test(u));
    assert.ok(draftRead, 'the draft state is read through the SDK\'s own Dataverse client');
    assert.match(decodeURIComponent(draftRead), /appmoduleid eq 11111111-1111-1111-1111-111111111111/);
  }
});

// The SDK writes an app header first and its sitemap second. A 412 on the SITEMAP — someone saved a
// sitemap edit since this run's fetch — comes after this push's header write has committed, so the draft
// read finds the unpublished layer that write just left. It is still a concurrent edit: the copy is kept,
// and a blind re-run stops instead of overwriting the other edit.
test('REAL BUNDLE: a sitemap 412 after the header committed is a concurrent edit, and the copy is kept', async () => {
  const { sdk, state, reads } = await freshSdk({ ai: 'Route Q1', sitemapStatus: 412 });
  await sdk.fetchArtifact('app', APP_ID);
  assert.strictEqual(await applyAppAiDescription(sdk, spec(WANT), APP_ID), true);
  const readsBefore = reads.length;
  const res = await pushAppHeader(sdk, APP_ID, 'Probe', true);
  assert.deepStrictEqual([state.ai, state.componentstate], [WANT, 1], 'precondition: the header PATCH committed and left the unpublished layer');
  assert.strictEqual(res.saved, false);
  assert.match(String(res.error && res.error.detail), /^Version conflict \(412\) from https:\/\/contoso\.crm\.dynamics\.com\/api\/data\/v[\d.]+\/sitemaps\(55555555-5555-5555-5555-555555555555\)$/);
  assert.throws(() => requireSuccessfulPush(res, 'app Probe'), (e) => e.code === 'version-conflict');
  assert.ok(!reads.slice(readsBefore).some((u) => /componentstate/.test(decodeURIComponent(u))), 'not re-diagnosed as a pending draft');
  // Someone saved the sitemap: the server has moved, and the kept copy stops the re-run's plain fetch.
  state.etag = 'W/"9"';
  await assert.rejects(sdk.fetchArtifact('app', APP_ID), (e) => e && e.code === 'LOCAL_EDITS_WOULD_BE_LOST');
});

test('REAL BUNDLE: after the pending-draft halt, "publish, then re-run" really converges', async () => {
  // Run 1 is refused; the operator publishes, which settles the draft and MOVES the server's etag; run 2
  // does exactly what the build does — a plain fetch, then the helper, then a push.
  const run1 = async ({ halt }) => {
    const env = await freshSdk({ ai: 'Route Q1', componentstate: 1, headerStatus: 412 });
    await env.sdk.fetchArtifact('app', APP_ID);
    await applyAppAiDescription(env.sdk, spec(WANT), APP_ID);
    const res = await env.sdk.pushArtifact('app', APP_ID);
    assert.strictEqual(res.saved, false);
    if (halt) await assert.rejects(haltOnUnpublishedAppHeader(env.sdk, APP_ID, res, 'Probe'), (e) => e.code === 'app-header-unpublished' && !/\.maker-workspace/.test(e.message));
    Object.assign(env.state, { componentstate: 0, headerStatus: 204, etag: 'W/"8"' });
    return env;
  };

  // CONTROL — why the halt resets the copy: without it, the re-run's plain fetch refuses to discard the
  // refused push's edits now that the server has moved, and the re-run halts again.
  const control = await run1({ halt: false });
  await assert.rejects(control.sdk.fetchArtifact('app', APP_ID), (e) => e && e.code === 'LOCAL_EDITS_WOULD_BE_LOST');

  const { sdk, state } = await run1({ halt: true });
  const fetched = await sdk.fetchArtifact('app', APP_ID);
  assert.strictEqual(fetched.aiDescription, 'Route Q1', 'the re-run sees the server again, not the refused edit');
  assert.strictEqual(await applyAppAiDescription(sdk, spec(WANT), APP_ID), true);
  assert.strictEqual((await sdk.pushArtifact('app', APP_ID)).saved, true);
  assert.strictEqual(state.ai, WANT, 'the routing description lands on the re-run');
});

test('REAL BUNDLE: a never-published app THROWS its header refusal, and pushAppHeader turns it into the precise halt', async () => {
  // The raw SDK throws rather than resolving saved:false — the shape pushAppHeader exists to catch.
  const raw = await freshSdk({ headerStatus: 400 });
  await raw.sdk.fetchArtifact('app', APP_ID);
  await applyAppAiDescription(raw.sdk, spec(WANT), APP_ID);
  // sdk-async-ok: the promise is handed to assert.rejects, which awaits it.
  await assert.rejects(raw.sdk.pushArtifact('app', APP_ID), (e) => e && e.code === 'APP_DRAFT_HEADER_NOT_WRITABLE');

  const { sdk, state } = await freshSdk({ headerStatus: 400 });
  await sdk.fetchArtifact('app', APP_ID);
  assert.strictEqual(await applyAppAiDescription(sdk, spec(WANT), APP_ID), true);
  await assert.rejects(pushAppHeader(sdk, APP_ID, 'Probe', true), (e) => e.code === 'app-header-unpublished' && /never been published/.test(e.message) && !/\.maker-workspace/.test(e.message));

  // The operator publishes (the header becomes writable and the etag moves); the re-run converges.
  Object.assign(state, { headerStatus: 204, etag: 'W/"8"' });
  assert.ok(!('aiDescription' in await sdk.fetchArtifact('app', APP_ID)), 'the reset copy is the server\'s, not the refused edit');
  assert.strictEqual(await applyAppAiDescription(sdk, spec(WANT), APP_ID), true);
  assert.strictEqual((await pushAppHeader(sdk, APP_ID, 'Probe', true)).saved, true);
  assert.strictEqual(state.ai, WANT);
});