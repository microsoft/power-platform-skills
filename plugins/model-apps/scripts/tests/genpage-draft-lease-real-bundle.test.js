'use strict';
// The navigation verbs through the REAL vendored SDK, end to end from the command line:
//   --draft   saves the app's navigation and publishes nothing; the answer says what was saved and what runs as the service was read to say, never
//             that the change is live.
//   the lease add-to-app, remove-from-app and an upload that places its page take the app's pages lease, the very lock a build's pages phase holds:
//             while a build of the same app holds it, each is refused with `pages-locked` and `outcome: 'nothing'`, and nothing is written.
require('./helpers/own-temp-folder.js');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeGenpageSdk } = require('../lib/genpage-sdk.js');
const { acquireAppPagesLease, applyWorkspaceOf } = require('../lib/app-operation-lease.js');
const genpageMain = require('../genpage.js').main;
const uploadMain = require('../genpage-upload.js').main;
const genpageBase = require('../lib/genpage-base.js');
const { FakeGenPageServer, INSTANCE, ACCOUNT_TABLE, appTransport, APP_ID, APP_EXISTING_PAGE_ID, APP_VIEW_ID } = require('./helpers/fake-genpage-server.js');
const { withAppComponents } = require('./helpers/fake-app-components.js');

const OTHER = '6b0d2c1e-5a4f-4e3d-9c2b-1a0f9e8d7c61';
const ACCOUNT_ID = '5e4d3c2b-1a0f-4e9d-8c7b-6a5f4e3d2c10';
const FORM_KEPT = '4d3c2b1a-0f9e-4d8c-8b6a-5f4e3d2c1b01';
const SOURCE = "import * as React from 'react';\nexport default function Page() { return <div>Hello</div>; }\n";

const folders = [];
test.after(() => { for (const folder of folders) fs.rmSync(folder, { recursive: true, force: true }); });
const tmp = () => { const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-draft-lease-')); folders.push(folder); return folder; };

// `wrap` sees the backend each run makes (to watch what a verb asks of it); `wrapHttp` the transport it is made over (to fail one read).
async function inWorld(fn, { wrap = (backend) => backend, wrapHttp = (http) => http } = {}) {
  const server = new FakeGenPageServer();
  server.serveTable(ACCOUNT_TABLE);
  server.seedPage(APP_EXISTING_PAGE_ID, { name: 'Existing', config: { dataSources: ['account'], model: '' } });
  server.seedPage(OTHER, { name: 'Other', config: { dataSources: ['account'], model: '' } });
  const app = appTransport(server);
  const world = withAppComponents(app, {
    tables: [{ logicalName: 'account', entitySetName: 'accounts', metadataId: ACCOUNT_ID, title: 'Accounts',
      forms: [{ id: FORM_KEPT, inApp: true }], views: [{ id: APP_VIEW_ID, inApp: true, isDefault: true }], charts: [] }],
  });
  const made = [];
  const http = wrapHttp(world.http);
  const makeBackend = () => wrap(makeGenpageSdk(INSTANCE, {
    httpClient: http,
    mkdtempSync: (prefix) => { const dir = fs.mkdtempSync(prefix); made.push(dir); return dir; },
  }));
  const appDir = tmp();
  const deps = { appDir, makeGenpageSdk: makeBackend, emit: (ok, payload) => ({ ok, ...payload }), stderr: () => {},
    // A usage error is thrown, not an exit: a flag a command does not know fails the test that used it, not the whole file.
    usageError: (message) => { throw new Error(`usage: ${message}`); } };
  await fn({ server, app, world, appDir, verbs: (argv) => genpageMain(argv, deps), upload: (argv) => uploadMain(argv, deps) });
  for (const dir of made) assert.ok(!fs.existsSync(dir), `the throwaway workspace ${dir} is removed`);
}

const namesPage = (xml, id) => String(xml).toLowerCase().includes(`genpageid="${id}"`);

test('REAL BUNDLE: add-to-app --draft saves the entry and publishes nothing — the answer says it is saved and not published, from what the service was read to say', async () => {
  await inWorld(async ({ app, verbs }) => {
    const publishedBefore = app.state.publishedXml;
    const out = await verbs(['add-to-app', '--env', INSTANCE, '--app-id', APP_ID, '--page-id', OTHER, '--draft']);
    assert.strictEqual(out.ok, true, JSON.stringify(out));
    assert.strictEqual(out.added, true);
    assert.strictEqual(out.published, false, 'a draft never says it is published');
    assert.strictEqual(out.placementState, 'saved', JSON.stringify(out));
    assert.ok(out.pendingPublish, `the saved change waiting for a publish is named: ${JSON.stringify(out)}`);
    assert.strictEqual(app.state.publishAttempts, 0, 'nothing was published');
    assert.ok(namesPage(app.state.xml, OTHER), 'the saved navigation names the page');
    assert.ok(!namesPage(app.state.publishedXml, OTHER), 'what runs does not');
    assert.strictEqual(app.state.publishedXml, publishedBefore, 'the published navigation is untouched');
  });
});

test('REAL BUNDLE: the add-to-app --draft answer is the draft\'s and nothing else — the placement is asked for a save only, never with a publish of the caller\'s, and no publish rides the answer', async () => {
  const asked = [];
  const wrap = (backend) => {
    const placeInApp = backend.placeInApp.bind(backend);
    backend.placeInApp = (appId, options) => { asked.push(options); return placeInApp(appId, options); };
    return backend;
  };
  await inWorld(async ({ app, verbs }) => {
    const out = await verbs(['add-to-app', '--env', INSTANCE, '--app-id', APP_ID, '--page-id', OTHER, '--draft']);
    assert.strictEqual(out.ok, true, JSON.stringify(out));
    assert.deepStrictEqual(Object.keys(out).filter((key) => key !== 'warnings').sort(),
      ['added', 'alreadyPlaced', 'appEdited', 'appId', 'dataSources', 'languageCode', 'ok', 'pageId', 'pendingPublish', 'pinnedViews', 'placementState', 'published', 'title'].sort());
    assert.deepStrictEqual([out.published, out.pendingPublish, out.placementState], [false, true, 'saved']);
    assert.strictEqual(asked.length, 1);
    assert.strictEqual(asked[0].publish, false, 'a draft is asked for');
    for (const key of ['publishApp', 'finish', 'finishIfUnpublished', 'beforeAppWrite']) assert.strictEqual(asked[0][key], undefined, `the page CLI's draft hands over no ${key}`);
    assert.strictEqual(app.state.publishAttempts, 0, 'nothing was published');
  }, { wrap });
});

test('REAL BUNDLE: remove-from-app --draft takes the entry out of the saved navigation only — the page is said to still show in what runs', async () => {
  await inWorld(async ({ app, verbs }) => {
    const out = await verbs(['remove-from-app', '--env', INSTANCE, '--app-id', APP_ID, '--page-id', APP_EXISTING_PAGE_ID, '--draft']);
    assert.strictEqual(out.ok, true, JSON.stringify(out));
    assert.strictEqual(out.published, false);
    assert.strictEqual(out.liveState, 'shown', `the published navigation still shows the page: ${JSON.stringify(out)}`);
    assert.strictEqual(app.state.publishAttempts, 0, 'nothing was published');
    assert.ok(!namesPage(app.state.xml, APP_EXISTING_PAGE_ID), 'the saved navigation no longer names it');
    assert.ok(namesPage(app.state.publishedXml, APP_EXISTING_PAGE_ID), 'what runs still does');
  });
});

test('REAL BUNDLE: while a build of the same app holds its pages lease, add-to-app, remove-from-app and an upload that places its page are each refused and write nothing', async () => {
  await inWorld(async ({ server, app, appDir, verbs, upload }) => {
    // The build keys the lease by the app's unique name; the fake app's is 'contoso_review'.
    const held = acquireAppPagesLease(applyWorkspaceOf({ appDir }), 'contoso_review');
    const xmlBefore = app.state.xml;
    const publishedBefore = app.state.publishedXml;
    const pagesBefore = JSON.stringify([...server.state.projects.keys()].sort());
    try {
      const refusedAs = (out, what) => {
        assert.strictEqual(out.ok, false, `${what}: ${JSON.stringify(out)}`);
        assert.strictEqual(out.code, 'pages-locked', `${what}: ${JSON.stringify(out)}`);
        assert.strictEqual(out.outcome, 'nothing', `${what}: nothing was written`);
      };
      refusedAs(await verbs(['add-to-app', '--env', INSTANCE, '--app-id', APP_ID, '--page-id', OTHER]), 'add-to-app');
      refusedAs(await verbs(['remove-from-app', '--env', INSTANCE, '--app-id', APP_ID, '--page-id', APP_EXISTING_PAGE_ID]), 'remove-from-app');
      const file = path.join(tmp(), 'page.tsx');
      fs.writeFileSync(file, SOURCE);
      refusedAs(await upload(['--env', INSTANCE, '--app-id', APP_ID, '--code-file', file, '--name', 'Fresh page', '--data-sources', 'account', '--prompt', 'p', '--agent-message', 'm', '--add-to-sitemap']), 'upload --add-to-sitemap');
      assert.strictEqual(app.state.xml, xmlBefore, 'the saved navigation is untouched');
      assert.strictEqual(app.state.publishedXml, publishedBefore, 'the published navigation is untouched');
      assert.strictEqual(app.state.publishAttempts, 0, 'nothing was published');
      assert.strictEqual(JSON.stringify([...server.state.projects.keys()].sort()), pagesBefore, 'no page was created');
    } finally {
      held.release();
    }
    // Released, the same edit goes through: the refusal was the lease and nothing else.
    const after = await verbs(['add-to-app', '--env', INSTANCE, '--app-id', APP_ID, '--page-id', OTHER]);
    assert.strictEqual(after.ok, true, JSON.stringify(after));
  });
});

// The app's unique name names its lease, and is read before the edit (lib/standalone-page-lease.js). A read that fails — the service unavailable, or an answer that is
// not the collection asked for — leaves the lease unresolvable: each command is refused with one JSON result, GENPAGE_APP_LEASE_UNRESOLVED and outcome "nothing", the
// read's own failure in its message, nothing written, and the backend's throwaway workspace removed (inWorld). The command is never left to throw with nothing on stdout.
const NAME_READ = /RetrieveUnpublishedMultiple\(\)\?\$select=appmoduleid,uniquename&/;
for (const [label, answer] of [['the service is unavailable', { status: 503, body: { error: { code: '0x80040216', message: 'Service unavailable' } } }], ['the answer is not a collection', { status: 200, body: { value: 'not rows' } }]]) {
  test(`REAL BUNDLE: when the app's unique name cannot be read (${label}), add-to-app, remove-from-app and an upload that names the app are each refused as a result, writing nothing`, async () => {
    let reads = 0;
    const wrapHttp = (http) => ({ ...http, get: async (url, opts) => {
      if (NAME_READ.test(decodeURIComponent(String(url)))) { reads += 1; return answer; }
      return http.get(url, opts);
    } });
    await inWorld(async ({ server, app, verbs, upload }) => {
      const xmlBefore = app.state.xml;
      const publishedBefore = app.state.publishedXml;
      const pagesBefore = JSON.stringify([...server.state.projects.keys()].sort());
      const refusedAs = async (run, what) => {
        let out;
        await assert.doesNotReject(async () => { out = await run(); }, `${what}: the refusal is a result, not a throw`);
        assert.strictEqual(out.ok, false, `${what}: ${JSON.stringify(out)}`);
        assert.strictEqual(out.code, 'GENPAGE_APP_LEASE_UNRESOLVED', `${what}: ${JSON.stringify(out)}`);
        assert.strictEqual(out.outcome, 'nothing', `${what}: nothing was written`);
        assert.strictEqual(out.appId, APP_ID);
        assert.match(out.error, /could not be read/, `${what}: the read's failure is said`);
      };
      await refusedAs(() => verbs(['add-to-app', '--env', INSTANCE, '--app-id', APP_ID, '--page-id', OTHER]), 'add-to-app');
      await refusedAs(() => verbs(['remove-from-app', '--env', INSTANCE, '--app-id', APP_ID, '--page-id', APP_EXISTING_PAGE_ID, '--draft']), 'remove-from-app --draft');
      const file = path.join(tmp(), 'page.tsx');
      fs.writeFileSync(file, SOURCE);
      let emitted = 0;
      const counted = (argv) => upload(argv).then((out) => { emitted += 1; return out; });
      await refusedAs(() => counted(['--env', INSTANCE, '--app-id', APP_ID, '--code-file', file, '--name', 'Fresh page', '--data-sources', 'account', '--prompt', 'p', '--agent-message', 'm']), 'upload --app-id');
      assert.strictEqual(emitted, 1, 'the upload emits exactly one result');
      assert.ok(reads >= 3, `the name was asked for by each command (${reads})`);
      assert.strictEqual(app.state.xml, xmlBefore, 'the saved navigation is untouched');
      assert.strictEqual(app.state.publishedXml, publishedBefore, 'the published navigation is untouched');
      assert.strictEqual(app.state.publishAttempts, 0, 'nothing was published');
      assert.strictEqual(JSON.stringify([...server.state.projects.keys()].sort()), pagesBefore, 'no page was created');
    }, { wrapHttp });
  });
}

// Any failure to take the lease — here its workspace cannot be made, because --app-dir names a file — comes before the upload reads or writes anything for the page,
// so it is a refusal with one JSON result and outcome "nothing" (its own code kept), as `genpage.js` reports it. A failure inside the deploy is not (see above).
test('REAL BUNDLE: an upload whose lease cannot be taken for any reason is refused as a result, writing nothing; add-to-app says the same', async () => {
  await inWorld(async ({ server, app, verbs, upload }) => {
    const dir = tmp();
    const notAFolder = path.join(dir, 'app-folder.txt');
    fs.writeFileSync(notAFolder, 'a file, not a folder\n');
    const file = path.join(dir, 'page.tsx');
    fs.writeFileSync(file, SOURCE);
    const pagesBefore = JSON.stringify([...server.state.projects.keys()].sort());
    let out;
    await assert.doesNotReject(async () => { out = await upload(['--env', INSTANCE, '--app-id', APP_ID, '--app-dir', notAFolder, '--code-file', file, '--name', 'Fresh page', '--data-sources', 'account', '--prompt', 'p', '--agent-message', 'm']); }, 'the refusal is a result, not a throw');
    assert.strictEqual(out.ok, false, JSON.stringify(out));
    assert.strictEqual(out.code, 'UNSAFE_OUTPUT', JSON.stringify(out));
    assert.deepStrictEqual([out.outcome, out.appId], ['nothing', APP_ID]);
    const verb = await verbs(['add-to-app', '--env', INSTANCE, '--app-id', APP_ID, '--page-id', OTHER, '--app-dir', notAFolder]);
    assert.deepStrictEqual([verb.ok, verb.code, verb.outcome, verb.appId], [false, 'UNSAFE_OUTPUT', 'nothing', APP_ID], JSON.stringify(verb));
    assert.strictEqual(app.state.publishAttempts, 0, 'nothing was published');
    assert.strictEqual(JSON.stringify([...server.state.projects.keys()].sort()), pagesBefore, 'no page was created');
  });
});

// The neighbour that must not change: a failure once the deploy is entered keeps its own handling — it is never relabelled a lease refusal that wrote nothing.
test('REAL BUNDLE: a failure inside an upload that holds the lease keeps its own result — it is not relabelled a refusal that wrote nothing', async () => {
  const wrap = (backend) => {
    backend.create = async () => { throw Object.assign(new Error('the page could not be written'), { code: 'GENPAGE_TEST_WRITE_FAILED' }); };
    return backend;
  };
  await inWorld(async ({ upload }) => {
    const file = path.join(tmp(), 'page.tsx');
    fs.writeFileSync(file, SOURCE);
    const out = await upload(['--env', INSTANCE, '--app-id', APP_ID, '--code-file', file, '--name', 'Fresh page', '--data-sources', 'account', '--prompt', 'p', '--agent-message', 'm']);
    assert.strictEqual(out.ok, false, JSON.stringify(out));
    assert.strictEqual(out.code, 'GENPAGE_TEST_WRITE_FAILED', JSON.stringify(out));
    assert.notStrictEqual(out.outcome, 'nothing', 'a failure inside the deploy is not said to have written nothing');
  }, { wrap });
});
// Page-content drafts through the uploader (`--draft`): the page is saved and NOT published, and with `--add-to-sitemap` its placement is a draft too — the app is
// neither published nor asked to publish anything before its write. The answer is the backend's draft answer: `saved`, `pendingPublish`, `draftFingerprint` (never
// `fingerprint`), and `publish` skipped as a draft. The lease is the same as any upload's that names an app.
const SOURCE_2 = "import * as React from 'react';\nexport default function Page() { return <div>Hello again</div>; }\n";
const publishesOf = (server, id) => server.published.filter((p) => String(p).toLowerCase() === String(id).toLowerCase()).length;
const placementsAsked = [];
const watchPlacements = (backend) => {
  const placeInApp = backend.placeInApp.bind(backend);
  backend.placeInApp = (appId, options) => { placementsAsked.push(options); return placeInApp(appId, options); };
  return backend;
};
const assertDraftPlacements = (what) => {
  assert.ok(placementsAsked.length >= 1, `${what}: the app was placed into`);
  for (const options of placementsAsked) {
    assert.strictEqual(options.publish, false, `${what}: the placement is a draft — ${JSON.stringify(options)}`);
    for (const key of ['publishApp', 'finish', 'finishIfUnpublished', 'beforeAppWrite']) assert.strictEqual(options[key], undefined, `${what}: a draft placement hands over no ${key}`);
  }
  placementsAsked.length = 0;
};
const assertDraftAnswer = (out, what) => {
  assert.strictEqual(out.ok, true, `${what}: ${JSON.stringify(out)}`);
  assert.strictEqual(out.draft, true, `${what}: the answer says it is a draft`);
  assert.deepStrictEqual([out.publish && out.publish.kind, out.publish && out.publish.reason], ['skipped', 'draft'], `${what}: ${JSON.stringify(out)}`);
  assert.strictEqual(typeof out.draftFingerprint, 'string', `${what}: the draft's hash is draftFingerprint`);
  assert.strictEqual(out.fingerprint, undefined, `${what}: a draft never carries a published fingerprint`);
};

test('REAL BUNDLE: an upload --draft saves the page and publishes nothing — a create placed with --add-to-sitemap, an update, and an update with nothing new each answer as a draft', async () => {
  placementsAsked.length = 0;
  await inWorld(async ({ server, app, upload }) => {
    const publishedNavigation = app.state.publishedXml;
    const folder = tmp();
    const file = path.join(folder, 'page.tsx');
    fs.writeFileSync(file, SOURCE);
    const created = await upload(['--env', INSTANCE, '--app-id', APP_ID, '--code-file', file, '--name', 'Draft page', '--data-sources', 'account', '--prompt', 'p', '--agent-message', 'm', '--add-to-sitemap', '--draft']);
    assertDraftAnswer(created, 'create --draft');
    assert.deepStrictEqual([created.saved, created.pendingPublish, created.placementState, created.addedToSitemap], [true, true, 'saved', true], JSON.stringify(created));
    assert.strictEqual(publishesOf(server, created.pageId), 0, 'the page was not published');
    assert.ok(namesPage(app.state.xml, created.pageId), 'the saved navigation names the page');
    assert.strictEqual(app.state.publishedXml, publishedNavigation, 'what runs is untouched');
    assert.strictEqual(app.state.publishAttempts, 0, 'the app was not published');
    assertDraftPlacements('create --draft --add-to-sitemap');
    const marker = genpageBase.readMarker(file);
    assert.strictEqual(marker.pageId, created.pageId, 'the base marker records the page, as for any upload');
    assert.ok(!marker.unfinished, 'a draft saved as asked is not an unfinished upload that a later run would publish');

    const existing = path.join(folder, 'existing.tsx');
    fs.writeFileSync(existing, SOURCE_2);
    const before = publishesOf(server, APP_EXISTING_PAGE_ID);
    const updated = await upload(['--env', INSTANCE, '--app-id', APP_ID, '--page-id', APP_EXISTING_PAGE_ID, '--code-file', existing, '--data-sources', 'account', '--prompt', 'p', '--agent-message', 'm', '--overwrite-deployed', '--draft']);
    assertDraftAnswer(updated, 'update --draft');
    assert.deepStrictEqual([updated.saved, updated.pendingPublish, updated.updated], [true, true, true], JSON.stringify(updated));
    assert.strictEqual(publishesOf(server, APP_EXISTING_PAGE_ID), before, 'the update was not published');
    assert.strictEqual(app.state.publishAttempts, 0, 'pinning the page\'s views did not publish the app');
    assertDraftPlacements('update --draft (views pinned)');

    const again = await upload(['--env', INSTANCE, '--app-id', APP_ID, '--page-id', APP_EXISTING_PAGE_ID, '--code-file', existing, '--prompt', 'p', '--agent-message', 'm', '--draft']);
    assertDraftAnswer(again, 'unchanged update --draft');
    assert.deepStrictEqual([again.unchanged, again.saved, again.pendingPublish], [true, false, null], `nothing new was saved, and whether it is live is not known: ${JSON.stringify(again)}`);
    assert.strictEqual(publishesOf(server, APP_EXISTING_PAGE_ID), before, 'still not published');

    // The neighbour: the same update without --draft publishes the page, as every upload always has, and says nothing of a draft.
    const published = await upload(['--env', INSTANCE, '--app-id', APP_ID, '--page-id', APP_EXISTING_PAGE_ID, '--code-file', existing, '--prompt', 'p', '--agent-message', 'm']);
    assert.strictEqual(published.ok, true, JSON.stringify(published));
    assert.strictEqual(publishesOf(server, APP_EXISTING_PAGE_ID), before + 1, 'an ordinary upload publishes');
    for (const key of ['draft', 'saved', 'pendingPublish', 'draftFingerprint', 'placementState', 'publish']) assert.strictEqual(published[key], undefined, `an ordinary upload's answer is as it was: no ${key}`);
  }, { wrap: watchPlacements });
});

test('REAL BUNDLE: upload --draft is refused before anything is read when its value is not a yes or no, or when the page it names is one this tool must still publish to finish', async () => {
  await inWorld(async ({ server, app, upload }) => {
    const folder = tmp();
    const file = path.join(folder, 'page.tsx');
    fs.writeFileSync(file, SOURCE);
    const pagesBefore = JSON.stringify([...server.state.projects.keys()].sort());
    const odd = await upload(['--env', INSTANCE, '--app-id', APP_ID, '--code-file', file, '--prompt', 'p', '--agent-message', 'm', '--draft=maybe']);
    assert.strictEqual(odd.ok, false, JSON.stringify(odd));
    assert.match(odd.error, /--draft takes no value/);
    // A page an earlier upload created and could not publish is completed by PUBLISHING it; a draft publishes nothing, so it would leave the page unpublished and its marker cleared.
    fs.writeFileSync(genpageBase.markerPath(file), JSON.stringify({ version: 1, pageId: OTHER, appId: APP_ID, deployedSha256: 'a'.repeat(64), localSha256: 'a'.repeat(64), source: 'upload', unfinished: 'publish' }));
    const completing = await upload(['--env', INSTANCE, '--app-id', APP_ID, '--page-id', OTHER, '--code-file', file, '--prompt', 'p', '--agent-message', 'm', '--draft']);
    assert.strictEqual(completing.ok, false, JSON.stringify(completing));
    assert.match(completing.error, /not finished.*drop --draft/s);
    assert.strictEqual(JSON.stringify([...server.state.projects.keys()].sort()), pagesBefore, 'no page was created');
    assert.strictEqual(app.state.publishAttempts, 0, 'nothing was published');
    // `--draft=false` is an ordinary upload.
    const plain = await upload(['--env', INSTANCE, '--code-file', path.join(folder, 'page.tsx'), '--prompt', 'p', '--agent-message', 'm', '--draft=false']);
    assert.strictEqual(plain.ok, true, JSON.stringify(plain));
    assert.strictEqual(publishesOf(server, plain.pageId), 1, 'published, as an upload with no --draft is');
    assert.strictEqual(plain.draft, undefined);
  });
});
