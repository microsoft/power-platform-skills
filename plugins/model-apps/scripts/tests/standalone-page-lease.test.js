'use strict';
// withStandalonePagesLease: a page edit made outside a build takes the app's pages lease — the very lock the build's pages phase takes — so a build
// (or another edit) of the same app in the same workspace refuses it instead of interleaving writes. Through the real SDK bundle: the app's unique
// name the lease is keyed by is read from the service's saved layer.

require('./helpers/own-temp-folder.js');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeGenpageSdk } = require('../lib/genpage-sdk.js');
const { withStandalonePagesLease, GENPAGE_APP_LEASE_UNRESOLVED } = require('../lib/standalone-page-lease.js');
const { acquireAppPagesLease, applyWorkspaceOf } = require('../lib/app-operation-lease.js');
const { appUniqueName } = require('../lib/sdk-build.js');
const { FakeGenPageServer, INSTANCE, ACCOUNT_TABLE, appTransport, APP_ID, APP_EXISTING_PAGE_ID, APP_VIEW_ID } = require('./helpers/fake-genpage-server.js');
const { withAppComponents } = require('./helpers/fake-app-components.js');

const PAGE = '0d6a3f3e-8c55-4b0e-9b7c-6f2a5d1e4c21';
const ACCOUNT_ID = '70816501-edb9-4740-a16c-6a5efbc05d84';
const FORM_KEPT = 'b1e7d0a4-3c1f-4a83-9f0a-2c5d1e6f7a01';

async function inWorld(fn) {
  const server = new FakeGenPageServer();
  server.serveTable(ACCOUNT_TABLE);
  server.seedPage(APP_EXISTING_PAGE_ID, { name: 'Existing', config: { dataSources: ['account'], model: '' } });
  server.seedPage(PAGE, { name: 'Overview', config: { dataSources: ['account'], model: '' } });
  const app = appTransport(server);
  const world = withAppComponents(app, {
    tables: [{ logicalName: 'account', entitySetName: 'accounts', metadataId: ACCOUNT_ID, title: 'Accounts',
      forms: [{ id: FORM_KEPT, inApp: true }], views: [{ id: APP_VIEW_ID, inApp: true, isDefault: true }], charts: [] }],
  });
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-lease-'));
  const genpage = makeGenpageSdk(INSTANCE, { httpClient: world.http });
  try {
    return await fn({ app, genpage, appDir });
  } finally {
    await genpage.dispose();
    fs.rmSync(appDir, { recursive: true, force: true });
  }
}

test('REAL BUNDLE: an edit outside a build is refused while a build of the same app holds the pages lease, and writes nothing', async () => {
  await inWorld(async ({ app, genpage, appDir }) => {
    // The build keys its lease by the spec's unique name; the fake app's is 'contoso_review'. A build spelling it in other case still contends.
    const held = acquireAppPagesLease(applyWorkspaceOf({ appDir }), appUniqueName({ app: { uniqueName: 'Contoso_Review' } }));
    let ran = 0;
    try {
      await assert.rejects(withStandalonePagesLease({ genpage, appId: APP_ID, appDir }, async () => { ran += 1; return genpage.placeInApp(APP_ID, { pages: [{ pageId: PAGE, title: 'Overview' }], dataSources: ['account'], languageCode: 1033 }); }),
        (e) => e.code === 'pages-locked');
    } finally {
      held.release();
    }
    assert.deepStrictEqual([ran, app.state.writes, app.state.publishAttempts], [0, [], 0], 'nothing ran, nothing was written or published');

    // Free again: the edit runs under the lease, and lets it go when it ends.
    const placed = await withStandalonePagesLease({ genpage, appId: APP_ID, appDir }, () => genpage.placeInApp(APP_ID, { pages: [{ pageId: PAGE, title: 'Overview' }], dataSources: ['account'], languageCode: 1033 }));
    assert.strictEqual(placed.appEdited, true);
    acquireAppPagesLease(applyWorkspaceOf({ appDir }), 'contoso_review').release();
  });
});

test('REAL BUNDLE: the lease is named from the app\'s saved layer, an app that is not there is refused before anything runs, and a failed edit lets the lease go', async () => {
  await inWorld(async ({ app, genpage, appDir }) => {
    const reads = [];
    const named = [];
    const acquire = (ws, unique, deps) => { named.push([ws, unique]); return acquireAppPagesLease(ws, unique, deps); };
    assert.strictEqual(await genpage.appUniqueName(APP_ID), 'contoso_review');
    await withStandalonePagesLease({ genpage, appId: APP_ID, appDir, acquire }, async () => reads.push('ran'));
    assert.deepStrictEqual(named, [[path.join(appDir, '.maker-workspace'), 'contoso_review']]);

    // The fake answers every app read with its one app: an id that is not that app's names no lease.
    let ran = 0;
    await assert.rejects(withStandalonePagesLease({ genpage, appId: '11111111-2222-3333-4444-555555555555', appDir }, async () => { ran += 1; }),
      (e) => e.code === GENPAGE_APP_LEASE_UNRESOLVED && e.outcome === 'nothing');
    await assert.rejects(withStandalonePagesLease({ genpage: {}, appId: APP_ID, appDir }, async () => { ran += 1; }), (e) => e.code === GENPAGE_APP_LEASE_UNRESOLVED);
    assert.strictEqual(ran, 0);

    await assert.rejects(withStandalonePagesLease({ genpage, appId: APP_ID, appDir }, async () => { throw new Error('the edit failed'); }), /the edit failed/);
    acquireAppPagesLease(applyWorkspaceOf({ appDir }), 'contoso_review').release();
    assert.deepStrictEqual(app.state.writes, []);
  });
});
