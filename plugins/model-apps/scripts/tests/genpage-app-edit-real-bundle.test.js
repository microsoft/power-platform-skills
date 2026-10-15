'use strict';
// A page edit of an app — a page placed in its navigation (`add-to-app`, an upload's `--add-to-sitemap`), taken out of it (`remove-from-app`), or the default view of
// its tables pinned (the build's pin and an upload that names an app) — changes the app's navigation and the views it pins, and NOTHING else of the app's components.
//
// What the REAL vendored SDK does when it is not held to that: every push of an existing app ends with ONE AddAppComponents whose list the SDK derives from the
// sitemap — for each Entity sub-area, the table, every active Main form of it, every active public view and every chart — whether or not the app has them. The
// call only adds, so an app whose maker took a Main form, a view or a chart out of it gets them back, and the edit publishes them. `appTransport` alone models an app
// whose navigation holds generative pages only, which derives nothing and is why no test saw it; these run the page backend against an app with an Entity sub-area
// and components the maker excluded (helpers/fake-app-components.js), and read the AddAppComponents bodies the app received.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeGenpageSdk } = require('../lib/genpage-sdk.js');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../lib/maker-sdk.js');
const { makeAppComponentScope } = require('../lib/app-component-scope.js');
const { runSdkBuild, appUniqueName } = require('../lib/sdk-build.js');
const { main: genpageVerbs } = require('../genpage.js');
const { main: upload } = require('../genpage-upload.js');
const { FakeGenPageServer, INSTANCE, ACCOUNT_TABLE, appTransport, APP_ID, APP_EXISTING_PAGE_ID, APP_VIEW_ID } = require('./helpers/fake-genpage-server.js');
const { withAppComponents } = require('./helpers/fake-app-components.js');

const OTHER = '77777777-7777-4777-8777-777777777777';
const ACCOUNT_ID = '88888888-8888-4888-8888-888888888888';
const FORM_KEPT = '99999999-9999-4999-8999-999999999991';
const FORM_EXCLUDED = '99999999-9999-4999-8999-999999999992';
const VIEW_EXCLUDED = '99999999-9999-4999-8999-999999999994';
const CHART_EXCLUDED = '99999999-9999-4999-8999-999999999993';
const SOURCE = "import * as React from 'react';\nexport default function Page() { return <div>Hello</div>; }\n";

const folders = [];
test.after(() => { for (const folder of folders) fs.rmSync(folder, { recursive: true, force: true }); });
const tmp = () => { const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-edit-')); folders.push(folder); return folder; };

// An app whose navigation opens `account` (and names a generative page), in which the maker took out one Main form, one public view and the chart of that table:
//   forms   FORM_KEPT is the app's, FORM_EXCLUDED is active and was taken out
//   views   APP_VIEW_ID is the table's default view — in the app when `defaultViewPinned` — and VIEW_EXCLUDED is another public view that was taken out
//   charts  CHART_EXCLUDED was taken out
// OTHER is a page that no navigation names.
async function inWorld(fn, { defaultViewPinned = true } = {}) {
  const server = new FakeGenPageServer();
  server.serveTable(ACCOUNT_TABLE);
  server.seedPage(APP_EXISTING_PAGE_ID, { name: 'Existing', config: { dataSources: ['account'], model: '' } });
  server.seedPage(OTHER, { name: 'Other', config: { dataSources: ['account'], model: '' } });
  const app = appTransport(server);
  const world = withAppComponents(app, {
    tables: [{
      logicalName: 'account', entitySetName: 'accounts', metadataId: ACCOUNT_ID, title: 'Accounts',
      forms: [{ id: FORM_KEPT, inApp: true }, { id: FORM_EXCLUDED, inApp: false }],
      views: [{ id: APP_VIEW_ID, inApp: defaultViewPinned, isDefault: true }, { id: VIEW_EXCLUDED, inApp: false }],
      charts: [{ id: CHART_EXCLUDED, inApp: false }],
    }],
  });
  const made = [];
  const makeBackend = () => makeGenpageSdk(INSTANCE, {
    httpClient: world.http,
    mkdtempSync: (prefix) => { const dir = fs.mkdtempSync(prefix); made.push(dir); return dir; },
  });
  const genpage = makeBackend();
  try {
    return await fn({ server, app, world, genpage, makeBackend });
  } finally {
    await genpage.dispose();
    for (const dir of made) assert.ok(!fs.existsSync(dir), `the throwaway workspace ${dir} is removed by dispose()`);
  }
}

const sorted = (ids) => [...ids].sort();
const namesPage = (xml, id) => xml.toLowerCase().includes(`genpageid="${id}"`);
const viewRef = (id) => ({ '@odata.type': 'Microsoft.Dynamics.CRM.savedquery', savedqueryid: id });
// The app's current layer is as the maker left it — the table, the one form, the default view when it is pinned and no chart: nothing the edit under test did added to it — and
// none of what the maker took out was ever in a body the app received.
function assertMembership(world, { views = [APP_VIEW_ID] } = {}) {
  assert.deepStrictEqual(
    { tables: sorted(world.members.tables), forms: sorted(world.members.forms), views: sorted(world.members.views), charts: sorted(world.members.charts) },
    { tables: [ACCOUNT_ID], forms: [FORM_KEPT], views: sorted(views), charts: [] },
    'the app holds the components the maker left it — the form, the view and the chart that were taken out are still out',
  );
  const sent = JSON.stringify(world.additions());
  for (const [what, id] of [['Main form', FORM_EXCLUDED], ['public view', VIEW_EXCLUDED], ['chart', CHART_EXCLUDED]]) assert.ok(!sent.includes(id), `the excluded ${what} ${id} was never posted to the app`);
}

test('REAL BUNDLE: add-to-app changes the navigation and nothing else — no Main form, view or chart the maker excluded comes back, and no AddAppComponents is sent when no view is to be pinned', async () => {
  await inWorld(async ({ app, world, genpage }) => {
    const placed = await genpage.placeInApp(APP_ID, { pages: [{ pageId: OTHER, title: 'Other' }], dataSources: ['account'], finishIfUnpublished: true });
    assert.deepStrictEqual([placed.added, placed.pinnedViews, placed.appEdited, placed.provedPublished, placed.warnings], [[OTHER], [], true, true, []], 'the default view is already in the app: nothing to pin');
    assert.deepStrictEqual(world.additions(), [], 'the page edit sent no AddAppComponents: nothing the sitemap names needs to be added');
    assertMembership(world);
    for (const [layer, xml] of [['saved', app.state.xml], ['published', app.state.publishedXml]]) {
      assert.ok(namesPage(xml, OTHER) && namesPage(xml, APP_EXISTING_PAGE_ID), `${layer}: the new entry and the one that was there`);
      assert.match(xml, /Entity="account"/, `${layer}: the table's own entry stays`);
    }
    assert.strictEqual(app.state.publishAttempts, 1, 'one publish');
  });
});

test('REAL BUNDLE: add-to-app pins the default view of the page\'s table — that view alone is added: not the other public view, the Main form or the chart that were taken out', async () => {
  await inWorld(async ({ world, genpage }) => {
    const placed = await genpage.placeInApp(APP_ID, { pages: [{ pageId: OTHER, title: 'Other' }], dataSources: ['account'], finishIfUnpublished: true });
    assert.deepStrictEqual([placed.added, placed.pinnedViews, placed.warnings], [[OTHER], [APP_VIEW_ID], []]);
    assert.deepStrictEqual(world.additions(), [{ AppId: APP_ID, Components: [viewRef(APP_VIEW_ID)] }], 'exactly the view that was asked to be pinned');
    assert.deepStrictEqual(world.added(), { tables: [], forms: [], views: [APP_VIEW_ID], charts: [] });
    assertMembership(world);
  }, { defaultViewPinned: false });
});

test('REAL BUNDLE: remove-from-app takes the page\'s entry out and adds nothing — the Main form and the chart the maker excluded stay out, and the table\'s own entry stays', async () => {
  await inWorld(async ({ app, world, genpage }) => {
    const out = await genpage.removeFromApp(APP_ID, APP_EXISTING_PAGE_ID);
    assert.deepStrictEqual(out, { removed: [{ area: 'Main', group: 'Pages', count: 1 }], wasInNavigation: true, appEdited: true, published: true, entriesLeft: 1, provedPublished: true, warnings: [] });
    assert.deepStrictEqual(world.additions(), [], 'the removal sent no AddAppComponents');
    assertMembership(world);
    for (const [layer, xml] of [['saved', app.state.xml], ['published', app.state.publishedXml]]) {
      assert.ok(!namesPage(xml, APP_EXISTING_PAGE_ID), `${layer}: the page's entry is gone`);
      assert.match(xml, /Entity="account"/, `${layer}: the table's own entry stays`);
    }
    assert.strictEqual(app.state.publishAttempts, 1, 'one publish');
  });
});

test('REAL BUNDLE: the pin of a page\'s table — the build\'s, with no page to place — adds the named view alone: the Main form, the other public view and the chart that were taken out are not added', async () => {
  await inWorld(async ({ app, world, genpage }) => {
    const placed = await genpage.placeInApp(APP_ID, { pages: [], dataSources: ['account'] });
    assert.deepStrictEqual([placed.added, placed.pinnedViews, placed.appEdited, placed.warnings], [[], [APP_VIEW_ID], true, []]);
    assert.deepStrictEqual(world.additions(), [{ AppId: APP_ID, Components: [viewRef(APP_VIEW_ID)] }], 'one AddAppComponents, for the one view');
    assert.deepStrictEqual(world.added(), { tables: [], forms: [], views: [APP_VIEW_ID], charts: [] });
    assertMembership(world);
    assert.strictEqual(app.state.publishAttempts, 1);

    // A rebuild: the view is in the app now, so nothing is read for a write and nothing is written.
    const writes = app.state.writes.length;
    const again = await genpage.placeInApp(APP_ID, { pages: [], dataSources: ['account'] });
    assert.deepStrictEqual([again.pinnedViews, again.appEdited], [[], false]);
    assert.strictEqual(app.state.writes.length, writes);
    assert.strictEqual(app.state.publishAttempts, 1);
  }, { defaultViewPinned: false });
});

test('REAL BUNDLE: edits one after another on one backend — a placement, a pin, a removal — each limited to what it owns, and the app ends as the maker left it plus the one view', async () => {
  await inWorld(async ({ world, genpage }) => {
    await genpage.placeInApp(APP_ID, { pages: [{ pageId: OTHER, title: 'Other' }], dataSources: ['account'], finishIfUnpublished: true });
    await genpage.removeFromApp(APP_ID, OTHER);
    await genpage.placeInApp(APP_ID, { pages: [{ pageId: OTHER, title: 'Other' }], finishIfUnpublished: true });
    await genpage.removeFromApp(APP_ID, APP_EXISTING_PAGE_ID);
    assert.deepStrictEqual(world.additions(), [{ AppId: APP_ID, Components: [viewRef(APP_VIEW_ID)] }], 'only the first edit owned a component');
    assertMembership(world);
  }, { defaultViewPinned: false });
});

// What the limit leaves as the SDK has it: the post it lets through is the SDK's own, so its refusal is the SDK's to report — a pin the service refuses is a warning of the push, the
// page is placed and the app published all the same — and the SDK's check of the tables an app's navigation opens is as it was.
test('REAL BUNDLE: a pin the service refuses is a warning, as it was — the page is placed, the app is published, and the view that was refused is not in the app', async () => {
  await inWorld(async ({ world, app }) => {
    const refusing = {
      ...world.http,
      post: async (url, body, options) => (url.endsWith('/AddAppComponents')
        ? { status: 400, headers: {}, body: { error: { message: 'The savedquery does not exist.' } } }
        : world.http.post(url, body, options)),
    };
    const genpage = makeGenpageSdk(INSTANCE, { httpClient: refusing });
    try {
      const placed = await genpage.placeInApp(APP_ID, { pages: [{ pageId: OTHER, title: 'Other' }], dataSources: ['account'], finishIfUnpublished: true });
      assert.deepStrictEqual([placed.added, placed.provedPublished], [[OTHER], true]);
      assert.strictEqual(placed.warnings.length, 1);
      assert.match(placed.warnings[0], /one or more components were not pinned \(.*HTTP 400.*The savedquery does not exist\./);
      assert.ok(namesPage(app.state.publishedXml, OTHER));
      assertMembership(world, { views: [] });
    } finally {
      await genpage.dispose();
    }
  }, { defaultViewPinned: false });
});

test('REAL BUNDLE: an edit of an app whose navigation opens a table the app does not hold does not add it — the SDK says so in a warning, as it checks every push — and nothing else is added either', async () => {
  const server = new FakeGenPageServer();
  server.serveTable(ACCOUNT_TABLE);
  server.seedPage(APP_EXISTING_PAGE_ID, { name: 'Existing', config: { dataSources: ['account'], model: '' } });
  server.seedPage(OTHER, { name: 'Other', config: { dataSources: ['account'], model: '' } });
  const app = appTransport(server);
  const world = withAppComponents(app, {
    tables: [{
      logicalName: 'account', entitySetName: 'accounts', metadataId: ACCOUNT_ID, title: 'Accounts', inApp: false,
      forms: [{ id: FORM_KEPT, inApp: true }, { id: FORM_EXCLUDED, inApp: false }],
      views: [{ id: APP_VIEW_ID, inApp: true, isDefault: true }],
      charts: [{ id: CHART_EXCLUDED, inApp: false }],
    }],
  });
  const genpage = makeGenpageSdk(INSTANCE, { httpClient: world.http });
  try {
    const placed = await genpage.placeInApp(APP_ID, { pages: [{ pageId: OTHER, title: 'Other' }], dataSources: ['account'], finishIfUnpublished: true });
    assert.deepStrictEqual([placed.added, placed.provedPublished], [[OTHER], true]);
    assert.strictEqual(placed.warnings.length, 1);
    assert.match(placed.warnings[0], /1 declared table\(s\) are NOT components of the app .* 'account' \(expected objectid 88888888-8888-4888-8888-888888888888\)/);
    assert.deepStrictEqual(world.additions(), [], 'the table is not added by a page edit, nor is anything else');
    assert.deepStrictEqual([...world.members.tables], []);
  } finally {
    await genpage.dispose();
  }
});

test('REAL BUNDLE: an app whose navigation names generative pages only gets the same pin as before — one AddAppComponents with the view, whatever the environment holds', async () => {
  const server = new FakeGenPageServer();
  server.serveTable(ACCOUNT_TABLE);
  server.seedPage(APP_EXISTING_PAGE_ID, { name: 'Existing', config: { dataSources: ['account'], model: '' } });
  server.seedPage(OTHER, { name: 'Other', config: { dataSources: ['account'], model: '' } });
  const app = appTransport(server);
  const genpage = makeGenpageSdk(INSTANCE, { httpClient: app.http });
  try {
    const placed = await genpage.placeInApp(APP_ID, { pages: [{ pageId: OTHER, title: 'Other' }], dataSources: ['account'], finishIfUnpublished: true });
    assert.deepStrictEqual([placed.pinnedViews, placed.warnings], [[APP_VIEW_ID], []]);
    assert.deepStrictEqual(app.state.writes.filter((write) => write.kind === 'components').map((write) => write.body), [{ AppId: APP_ID, Components: [viewRef(APP_VIEW_ID)] }]);
  } finally {
    await genpage.dispose();
  }
});

// The page verbs and the upload over the same app: what the user runs is what is held to it.
test('REAL BUNDLE: `genpage.js add-to-app` and `remove-from-app` over the app — the results carry no warning and the components are as the maker left them', async () => {
  await inWorld(async ({ world, makeBackend }) => {
    const run = (argv) => genpageVerbs(argv, { makeGenpageSdk: makeBackend, emit: (ok, payload) => ({ ok, ...payload }), stderr: () => {} });
    const added = await run(['add-to-app', '--env', INSTANCE, '--app-id', APP_ID, '--page-id', OTHER]);
    assert.deepStrictEqual([added.ok, added.added, added.pinnedViews, added.warnings], [true, true, [APP_VIEW_ID], undefined], JSON.stringify(added));
    const removed = await run(['remove-from-app', '--env', INSTANCE, '--app-id', APP_ID, '--page-id', APP_EXISTING_PAGE_ID]);
    assert.deepStrictEqual([removed.ok, removed.wasInNavigation, removed.warnings], [true, true, undefined], JSON.stringify(removed));
    assert.deepStrictEqual(world.additions(), [{ AppId: APP_ID, Components: [viewRef(APP_VIEW_ID)] }]);
    assertMembership(world);
  }, { defaultViewPinned: false });
});

test('REAL BUNDLE: `genpage-upload.js --add-to-sitemap` over the app — the page is placed and the default view of its table pinned; nothing else of the app\'s components is added', async () => {
  await inWorld(async ({ app, world, makeBackend }) => {
    const dir = tmp();
    const file = path.join(dir, 'page.tsx');
    fs.writeFileSync(file, SOURCE);
    const out = await upload(['--env', INSTANCE, '--app-id', APP_ID, '--code-file', file, '--name', 'Fresh page', '--data-sources', 'account', '--prompt', 'p', '--agent-message', 'm', '--add-to-sitemap'], {
      makeGenpageSdk: makeBackend, emit: (ok, payload) => ({ ok, ...payload }),
    });
    assert.strictEqual(out.ok, true, JSON.stringify(out));
    assert.strictEqual(out.addedToSitemap, true);
    assert.ok(namesPage(app.state.publishedXml, out.pageId), 'the page is in what runs');
    assert.deepStrictEqual(world.additions(), [{ AppId: APP_ID, Components: [viewRef(APP_VIEW_ID)] }], 'one AddAppComponents, for the default view');
    assertMembership(world);
  }, { defaultViewPinned: false });
});

// The build's pages phase pins the default view of the tables its pages read once the pages are written — one `placeInApp` with no page. The phase runs here as the build runs it
// (the page backend is the real one over the app; only the app and manifest inventory the phase reads is a small stand-in), on an app the maker took components out of.
test('REAL BUNDLE: the build\'s pin of the tables its pages read — the pages phase over the real backend — adds the default view alone: nothing the maker excluded comes back', async () => {
  const LAYER = '33333333-3333-4333-8333-333333333333';
  const SITEMAP = '44444444-4444-4444-8444-444444444444';
  const WEB_RESOURCE = '55555555-5555-4555-8555-555555555599';
  await inWorld(async ({ world, genpage }) => {
    const appDir = tmp();
    fs.writeFileSync(path.join(appDir, 'page.tsx'), SOURCE);
    const { pageId } = await genpage.create({ name: 'Overview', source: SOURCE, dataSources: ['account'] });
    const spec = {
      schemaVersion: 2,
      solution: { uniqueName: 'EditProbe', displayName: 'Edit Probe', publisherPrefix: 'contoso' },
      app: { name: 'Edit Probe' },
      entities: [],
      pages: [{ key: 'overview', name: 'Overview', source: { kind: 'tsx', codeFile: 'page.tsx' }, dataSources: ['account'] }],
      appShell: { areas: [{ label: 'Main', groups: [{ label: 'Pages', subAreas: [{ page: 'overview' }] }] }] },
    };
    // The inventory the pages phase reads of the app it is asked to build in: its row, its sitemap and the manifest that says which page is which.
    let manifest = JSON.stringify({ schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId }] });
    const row = { appmoduleid: APP_ID, appmoduleidunique: LAYER, uniquename: appUniqueName(spec), componentstate: 0 };
    const inventory = {
      queryRecords: async (table) => {
        if (table === 'appmodule') return [row];
        if (table === 'appmodulecomponent') return [{ objectid: SITEMAP, componenttype: 62 }];
        if (table === 'sitemap') return [{ sitemapxml: `<SiteMap><Area><Group><SubArea GenPageId="${pageId}"/></Group></Area></SiteMap>` }];
        if (table === 'webresource') return [{ webresourceid: WEB_RESOURCE, content: Buffer.from(manifest).toString('base64') }];
        if (table === 'solution') return [];
        throw new Error(`unexpected inventory query: ${table}`);
      },
      updateWebResource: async (id, { content }) => { manifest = content; },
      addSolutionComponent: async () => {},
      dataverse: { get: async () => ({ status: 200, body: { value: [row] } }) },
    };
    const warnings = [];
    const built = await runSdkBuild(spec, {
      sdk: inventory, apply: true, env: INSTANCE, appDir, workspaceDir: path.join(appDir, '.maker-workspace'), phases: ['pages'], genpage,
      changedOnly: { fastApply: true, resolvedAppId: APP_ID, skipSitemapFinalize: true }, warn: (message) => warnings.push(message),
    });
    assert.strictEqual(built.ok, true, JSON.stringify(built));
    assert.deepStrictEqual(warnings, []);
    assert.deepStrictEqual(world.additions(), [{ AppId: APP_ID, Components: [viewRef(APP_VIEW_ID)] }], 'one AddAppComponents, for the one view the pin names');
    assert.deepStrictEqual(world.added(), { tables: [], forms: [], views: [APP_VIEW_ID], charts: [] });
    assertMembership(world);
  }, { defaultViewPinned: false });
});

// ── The limit holds when the SDK's request is not the one it reads ──────────────────────────────────────────────────────────────────────────────────────
// app-component-scope.test.js holds the limit's own rules against a transport that only records. These make the SDK ITSELF push the app through the limit, with its request changed on the way —
// as a bundle that posted differently would change it — and show what a user would see: the push's own warning, nothing sent to the app, and the app's components as the maker left them.
// (The requests the bundle sends today are the tests above: a re-vendor that changes their shape fails there first.)
const MISSING_VIEW = '99999999-9999-4999-8999-99999999999a';
const isAddAppComponents = (request) => /addappcomponents/i.test(request.url);

// A page edit of the app through the SDK, as `placeInApp` makes one for a pin: the views `pinned` are put in the app's components, and the push is made while the edit owns `owned`. `change`, when
// given, sits between the SDK and the limit and rewrites each request as [url, body] -> [url, body]. `reached` is what got past the limit to the app.
async function pinThrough(world, { pinned, owned = pinned, change = null }) {
  const scope = makeAppComponentScope();
  const reached = [];
  const limited = scope.wrap({ ...world.http, post: async (url, body, options) => { reached.push({ url: String(url), body }); return world.http.post(url, body, options); } });
  const sdk = createMakerSdk({
    workspaceStorage: createNodeWorkspaceStorage(tmp()),
    instanceUrl: INSTANCE,
    httpClient: change ? new Proxy({}, {
      get: (_, key) => (key === 'post' ? (url, body, options) => limited.post(...change(url, body), options) : typeof limited[key] === 'function' ? limited[key].bind(limited) : limited[key]),
      has: (_, key) => key in limited,
    }) : limited,
  });
  await sdk.initWorkspace();
  const app = await sdk.fetchArtifact('app', APP_ID, { overwrite: true });
  if (app.components === undefined) await sdk.addElement('app', APP_ID, '', { components: { views: pinned } });
  else if (app.components.views === undefined) await sdk.addElement('app', APP_ID, '/components', { views: pinned });
  else await sdk.updateElement('app', APP_ID, '/components/views', [...app.components.views, ...pinned]);
  const pushed = await scope.limit(APP_ID, { views: owned }, () => sdk.pushArtifact('app', APP_ID));
  return { pushed, reached };
}

test('REAL BUNDLE: the SDK pushes the app through the limit — the control for what follows: its derived list is cut to the one view the edit pins, with no warning', async () => {
  await inWorld(async ({ world }) => {
    const { pushed, reached } = await pinThrough(world, { pinned: [APP_VIEW_ID] });
    assert.strictEqual(pushed.saved, true, JSON.stringify(pushed));
    assert.deepStrictEqual(pushed.warnings || [], []);
    assert.deepStrictEqual(reached.filter(isAddAppComponents).map((request) => request.body), [{ AppId: APP_ID, Components: [viewRef(APP_VIEW_ID)] }]);
    assert.deepStrictEqual(world.added(), { tables: [], forms: [], views: [APP_VIEW_ID], charts: [] });
    assertMembership(world);
  }, { defaultViewPinned: false });
});

test('REAL BUNDLE: a request the limit cannot read is refused, and the SDK reports it as a warning of the push — nothing reaches the app, and no pin is claimed that was not made', async () => {
  const drifts = [
    ['a body that is JSON text', (url, body) => [url, isAddAppComponents({ url }) ? JSON.stringify(body) : body], /was NOT sent: its body is not the \{ AppId, Components/],
    ['an address in another spelling', (url, body) => [url.replace('AddAppComponents', 'addappcomponents'), body], /was NOT sent: its address \(.*addappcomponents\) .*AddAppComponents/],
    ['an address with a trailing slash', (url, body) => [isAddAppComponents({ url }) ? `${url}/` : url, body], /was NOT sent: its address \(.*AddAppComponents\/\)/],
    ['a view that is an OData reference', (url, body) => [url, isAddAppComponents({ url }) ? { ...body, Components: body.Components.map((c) => (c.savedqueryid ? { '@odata.id': `savedqueries(${c.savedqueryid})` } : c)) } : body], new RegExp(`was NOT sent: its list does not carry the view ${APP_VIEW_ID} the edit pins`)],
  ];
  for (const [label, change, said] of drifts) {
    await inWorld(async ({ world }) => {
      const { pushed, reached } = await pinThrough(world, { pinned: [APP_VIEW_ID], change });
      assert.strictEqual(pushed.saved, true, `${label}: the push is the SDK's to report, and the sitemap it wrote is saved: ${JSON.stringify(pushed)}`);
      assert.strictEqual((pushed.warnings || []).length, 1, `${label}: ${JSON.stringify(pushed.warnings)}`);
      assert.match(pushed.warnings[0], /one or more components were not pinned \(/, label);
      assert.match(pushed.warnings[0], said, label);
      assert.deepStrictEqual(reached.filter(isAddAppComponents), [], `${label}: no AddAppComponents reached the app, limited or not`);
      assert.deepStrictEqual(world.additions(), [], label);
      assertMembership(world, { views: [] });
    }, { defaultViewPinned: false });
  }
});

test('REAL BUNDLE: a pin the SDK\'s list does not carry is a warning and not a no-op — the view the edit owns and the SDK did not post is named, and nothing is sent', async () => {
  await inWorld(async ({ world }) => {
    const { pushed, reached } = await pinThrough(world, { pinned: [APP_VIEW_ID], owned: [APP_VIEW_ID, MISSING_VIEW] });
    assert.strictEqual(pushed.saved, true, JSON.stringify(pushed));
    assert.strictEqual(pushed.warnings.length, 1, JSON.stringify(pushed.warnings));
    assert.match(pushed.warnings[0], new RegExp(`was NOT sent: its list does not carry the view ${MISSING_VIEW} the edit pins`));
    assert.ok(!pushed.warnings[0].includes(APP_VIEW_ID), 'the view that is carried is not named');
    assert.deepStrictEqual(reached.filter(isAddAppComponents), []);
    assertMembership(world, { views: [] });
  }, { defaultViewPinned: false });
});
