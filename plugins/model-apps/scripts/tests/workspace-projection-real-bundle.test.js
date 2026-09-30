'use strict';
// REAL BUNDLE: a workspace saved by an earlier version of this plugin, read by the SDK it vendors now.
//
// The SDK stamps every workspace copy with the version of the parsers that projected it
// (`projectionVersion`) and REFUSES to push a copy stamped with another version
// (ARTIFACT_PROJECTION_STALE): after a parser change, an untouched part of an old copy reads as edited,
// and pushing it could overwrite server content nobody touched. Every re-vendor that raises the version
// makes every existing `.maker-workspace` "old". The upgrade stays invisible because of two SDK
// behaviours the build relies on, pinned here:
//   1. a plain fetch RE-READS a clean old copy (no unpushed edits) and stamps it current — and the build
//      fetches every existing form, view, chart and app before it edits one;
//   2. a plain fetch KEEPS a copy that still holds unpushed edits (an interrupted build's) while the
//      server has not moved, so that copy is refused at push — and the build then names the step an
//      operator can take, instead of the SDK's own `fetchArtifact(...)` advice.
// Driven against the app artifact over a fake Dataverse (the same shape as
// app-ai-description-real-bundle.test.js), because the projection check is the same for every type.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { makeRunner, BuildHalt } = require('../lib/entity-provision.js');

const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');
const APP_ID = '11111111-1111-1111-1111-111111111111';
const APP_UNIQUE = 'new_probeapp';
const TABLE_METADATA_ID = '22222222-2222-2222-2222-222222222222';
const SITEMAP_ID = '55555555-5555-5555-5555-555555555555';
const SITEMAP_XML = '<SiteMap IntroducedVersion="7.0.0.0"><Area Id="area_0" ShowGroups="true"><Titles><Title LCID="1033" Title="Main" /></Titles>'
  + '<Group Id="group_0_0"><Titles><Title LCID="1033" Title="Main" /></Titles>'
  + '<SubArea Id="sub_0_0_0" Entity="new_torder" Client="All" Sku="All"><Titles><Title LCID="1033" Title="Orders" /></Titles></SubArea>'
  + '</Group></Area></SiteMap>';

const tempDirs = [];
test.after(() => { for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true }); });

async function freshSdk() {
  const { createMakerSdk, createNodeWorkspaceStorage } = require(BUNDLE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'projection-'));
  tempDirs.push(dir);
  const writes = [];
  const appRow = () => ({ appmoduleid: APP_ID, appmoduleidunique: '33333333-3333-3333-3333-333333333333', name: 'Probe', uniquename: APP_UNIQUE, description: 'Tickets', componentstate: 0, '@odata.etag': 'W/"1"' });
  const sitemapRow = () => ({ sitemapid: SITEMAP_ID, sitemapnameunique: APP_UNIQUE, sitemapxml: SITEMAP_XML, '@odata.etag': 'W/"1"' });
  const httpClient = {
    get: async (url) => {
      const m = /EntityDefinitions\(LogicalName='([^']+)'\)/.exec(url);
      if (m) return { status: 200, headers: {}, body: { LogicalName: m[1], MetadataId: TABLE_METADATA_ID, EntitySetName: `${m[1]}s` } };
      if (/\/appmodulecomponents/.test(url)) {
        // componenttype 62 is the SITEMAP component; 1 is a table. The filter arrives URL-encoded.
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
      return { status: 200, headers: {}, body: { value: [] } };
    },
    post: async (url, body) => { writes.push({ verb: 'post', url: String(url), body }); return { status: 204, headers: {}, body: {} }; },
    patch: async (url, body) => { writes.push({ verb: 'patch', url: String(url), body }); return { status: 204, headers: { etag: 'W/"2"' }, body: {} }; },
    delete: async () => ({ status: 204, headers: {}, body: {} }),
    put: async () => ({ status: 204, headers: {}, body: {} }),
  };
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: 'https://contoso.crm.dynamics.com', httpClient });
  await sdk.initWorkspace();
  return { sdk, dir, writes };
}

// Stamp the stored copy the way the plugin's previous SDK left it. The vendored SDK that shipped with
// 2.10.0 wrote projection 3; nothing else about the copy changes, which is exactly the upgraded state.
function stampOlderProjection(dir, id) {
  const metaFile = path.join(dir, '.metadata', 'apps', `${id}.meta.json`);
  assert.ok(fs.existsSync(metaFile), `the SDK keeps the app's metadata at ${metaFile}`);
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  assert.ok(Number.isInteger(meta.projectionVersion) && meta.projectionVersion > 3,
    `precondition: the vendored SDK stamps a projection newer than 3 (got ${meta.projectionVersion})`);
  fs.writeFileSync(metaFile, JSON.stringify({ ...meta, projectionVersion: 3 }), 'utf8');
}

const appWrites = (writes) => writes.filter((w) => w.verb === 'patch' && /\/appmodules\(/.test(w.url));

test('REAL BUNDLE: a clean copy from an earlier projection is refused at push, and a plain fetch re-reads it', async () => {
  const { sdk, dir, writes } = await freshSdk();
  await sdk.fetchArtifact('app', APP_ID);
  stampOlderProjection(dir, APP_ID);

  // The hazard is real: an old copy is never pushed as it stands.
  await assert.rejects(sdk.pushArtifact('app', APP_ID), (e) => e && e.code === 'ARTIFACT_PROJECTION_STALE');
  assert.strictEqual(writes.length, 0, 'the refusal writes nothing');

  // The build's existing-app path is exactly this: a plain fetch, then its edits, then the push.
  await sdk.fetchArtifact('app', APP_ID);
  await sdk.updateElement('app', APP_ID, '/description', 'Tickets and orders');
  const pushed = await sdk.pushArtifact('app', APP_ID);
  assert.strictEqual(pushed.saved, true, 'the re-read copy pushes');
  assert.strictEqual(appWrites(writes).length, 1, 'with one header write');
  assert.strictEqual(appWrites(writes)[0].body.description, 'Tickets and orders');
});

test('REAL BUNDLE: an old copy holding unpushed edits is kept by a plain fetch and refused at push, and the halt names the workspace to delete', async () => {
  const { sdk, dir, writes } = await freshSdk();
  await sdk.fetchArtifact('app', APP_ID);
  // An earlier build edited its copy and stopped before the push.
  await sdk.updateElement('app', APP_ID, '/description', 'Edited by an interrupted build');
  stampOlderProjection(dir, APP_ID);

  const kept = await sdk.fetchArtifact('app', APP_ID);
  assert.strictEqual(kept.description, 'Edited by an interrupted build', 'the server has not moved, so the plain fetch keeps the unpushed copy');

  const events = [];
  const runner = makeRunner({ emit: (e) => events.push(e), total: 1 });
  await assert.rejects(
    () => runner.run('app-shell', 'app "Probe"', () => sdk.pushArtifact('app', APP_ID)),
    (err) => {
      assert.ok(err instanceof BuildHalt, 'the refusal halts the build');
      assert.strictEqual(err.code, 'ARTIFACT_PROJECTION_STALE', 'with the SDK code kept for the caller');
      assert.match(err.message, /Refusing to push app/, 'the SDK reason stays in the message');
      assert.match(err.message, /earlier version of this plugin/, 'it says where the copy came from');
      assert.match(err.message, /Delete the \.maker-workspace directory \(or the --workspace one\) and re-run/,
        'and names the step an operator can take');
      return true;
    });
  assert.strictEqual(writes.length, 0, 'nothing was written');
  assert.ok(events.some((e) => e.status === 'error' && e.phase === 'app-shell'), 'the failure is reported on the phase');
});

test('the runner adds no remedy to an SDK error it has none for', async () => {
  const { SdkError } = require(BUNDLE);
  const runner = makeRunner({ emit: () => {}, total: 1 });
  await assert.rejects(
    () => runner.run('forms', 'form "Customer"', async () => { throw new SdkError('PATH_NOT_FOUND', 'No node at /tabs/9'); }),
    (err) => {
      assert.strictEqual(err.message, 'forms failed: No node at /tabs/9');
      assert.strictEqual(err.code, 'PATH_NOT_FOUND');
      return true;
    });
});
