'use strict';
// An app with NO TABLES, through its whole lifecycle — over the REAL vendored SDK, the plugin's own HTTP client and the stateful fake
// Dataverse the lifecycle tests share (helpers/fake-lifecycle-org.js, helpers/lifecycle-harness.js), each command run the way its CLI
// runs it.
//
// A model-driven app need not have a table: `apps.js create --page-id` makes one whose navigation holds only generative pages. The App
// Spec validator refused every spec with no table (`at least one entity is required`), in every profile, so:
//   * the download of such an app wrote its page folders, then refused the spec it had made and wrote no spec and no baseline;
//   * no build could make such an app, though the build has made a new app whose navigation holds only pages since it learned to create
//     the pages first (lifecycle-pages-first-real-bundle.test.js, whose spec still needed a table it did not show).
// The rule now refuses only a spec with no table AND no navigation entry (app-spec-without-tables.test.js), and the cases pin, by what
// reached the wire and what the environment holds:
//   * an app made by apps.js of one page downloads to a spec with no tables, its page and its baseline, and that spec rebuilds into the
//     same environment and verifies, creating no page and no app;
//   * a spec with no tables is planned by a dry run, built from nothing (the page, then the app with it), rebuilt unchanged, verified and
//     torn down to the environment it started from;
//   * an app with no table and no navigation entry is still refused by the download, before it writes anything.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createLifecycleOrg } = require('./helpers/fake-lifecycle-org.js');
const { createLifecycleHarness, seedForeignWork, diffContents } = require('./helpers/lifecycle-harness.js');
const { createApp } = require('../apps.js');
const { validateAppSpec } = require('../lib/app-spec.js');

// The app apps.js makes, around a page made beforehand, as a maker does with /genpage.
const MADE_UNIQUE = 'contoso_accountmetrics';
const MADE_PAGE = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
// The app the build makes from a spec with no tables: one page, which reads a table the environment already has.
const BUILT_UNIQUE = 'contoso_notables';
const PAGE_NAME = 'Kitchen Page';
function noTablesSpec() {
  return {
    schemaVersion: 2,
    solution: { uniqueName: 'ContosoNoTables', displayName: 'Contoso No Tables', publisherPrefix: 'contoso' },
    app: { name: 'No Tables', description: 'An app whose navigation is one generative page, and which has no table of its own.' },
    entities: [],
    pages: [{ key: 'overview', name: PAGE_NAME, purpose: 'A page over accounts.', dataSources: ['account'], source: { kind: 'tsx', codeFile: 'KitchenPage.tsx' } }],
    appShell: { areas: [{ label: 'Work', groups: [{ label: 'Pages', subAreas: [{ page: 'overview', title: PAGE_NAME }] }] }] },
  };
}
const spec = noTablesSpec();

// A request that creates a generative page (in the page service's change set, or alone) or an app.
const createsPage = (r) => r.method === 'POST' && (/^\/uxagentprojects(\?|$)/.test(r.path) || (r.operations || []).some((o) => o.method === 'POST' && /(^|\/)uxagentprojects(\?|$)/.test(String(o.path))));
const createsApp = (r) => r.method === 'POST' && /^\/appmodules(\?|$)/.test(r.path);

// A measured step ran: it did not throw, and every request it sent is one the fake models.
const ran = (step, label) => {
  assert.ok(step, `${label} ran`);
  if (step.error) throw step.error;
  assert.deepEqual(step.unexpected, [], `every request ${label} sent is one the fake models`);
  return step;
};

// A fake environment with another maker's work in it.
async function environment(prefix) {
  const org = createLifecycleOrg();
  await seedForeignWork(org);
  const root = makeTempDir(prefix);
  return { org, root, harness: createLifecycleHarness(org, root), seed: org.inventory(), seedContents: org.contents() };
}

// MADE: a page, then an app made around it by apps.js — its navigation holds the page and nothing else, and it has no table.
async function madeOfOnePage() {
  const env = await environment('lifecycle-no-tables-made-');
  env.org.pageServer.seedPage(MADE_PAGE, { name: 'Overview' });
  env.org.pageServer.publishProject(env.org.pageServer.state, MADE_PAGE);
  const made = await createApp({ env: env.org.origin, name: 'Account Metrics', solution: 'Default', pageIds: [MADE_PAGE], uniqueName: MADE_UNIQUE, publish: true }, env.harness.client);
  assert.equal(made.ok, true, JSON.stringify(made));
  assert.deepEqual(env.org.unexpected, [], 'every request apps.js sent is one the fake models');
  return env;
}
let madeP;
const made = () => madeP || (madeP = (async () => {
  const env = await madeOfOnePage();
  env.out = path.join(env.root, 'download');
  env.download = await env.harness.measure(() => env.harness.download(MADE_UNIQUE, env.out));
  return env;
})());

test('no tables: an app made of one generative page downloads — a spec with no tables, the page and the baseline — and the spec is one the build and verify take', async () => {
  const env = await made();
  const s = ran(env.download, 'the download');
  const { emitted, spec: downloaded } = s.value;
  assert.equal(emitted && emitted.ok, true, JSON.stringify(emitted));
  assert.deepEqual(s.writes, {}, 'a download writes nothing to the environment');
  assert.equal(emitted.payload.entities, 0);
  assert.equal(emitted.payload.pages, 1);
  assert.deepEqual(downloaded.entities, [], 'the app has no table, and the spec says so');
  assert.deepEqual(downloaded.pages.map((p) => p.pageId), [MADE_PAGE]);
  assert.deepEqual(downloaded.appShell.areas.flatMap((a) => a.groups.flatMap((g) => g.subAreas.map((sa) => sa.page))), [downloaded.pages[0].key], 'its navigation is the page');
  for (const file of ['app-spec.json', path.join('pages', MADE_PAGE, 'page.tsx'), path.join('.maker-workspace', 'last-applied.json')]) {
    assert.ok(fs.existsSync(path.join(env.out, file)), `${file} is written`);
  }
  for (const opts of [{ profile: 'plan', reconstructed: true }, { profile: 'deploy' }, { profile: 'structural' }]) {
    assert.deepEqual(validateAppSpec(downloaded, opts).errors, [], JSON.stringify(opts));
  }
});

test('no tables: the downloaded spec rebuilds into the same environment from its folder and verifies — no page and no app is created', async () => {
  const env = await made();
  const downloaded = ran(env.download, 'the download').value.spec;
  const rebuild = ran(await env.harness.measure(() => env.harness.build(downloaded, { appFolder: env.out, workspace: path.join(env.out, '.maker-workspace') })), 'the rebuild');
  assert.equal(rebuild.value.result.ok, true, JSON.stringify(rebuild.value.result.errors));
  const requests = env.org.since(rebuild.mark);
  assert.equal(requests.filter(createsApp).length, 0, 'the app is found by its unique name, not created again');
  assert.ok(!requests.some(createsPage), 'the page is found by its id, not created again');
  assert.deepEqual(env.org.find('appmodules', (a) => a.uniquename === MADE_UNIQUE).length, 1);
  assert.deepEqual(rebuild.value.result.verify && { ok: rebuild.value.result.verify.ok, missing: rebuild.value.result.verify.missing }, { ok: true, missing: [] }, 'verify passes');
});

// BUILT: the same kind of app, made by the build from a spec with no tables.
let builtP;
const built = () => builtP || (builtP = (async () => {
  const env = await environment('lifecycle-no-tables-built-');
  env.build = await env.harness.measure(() => env.harness.build(spec));
  return env;
})());
const holds = (org) => {
  const sitemap = org.find('sitemaps', (m) => m.sitemapnameunique === BUILT_UNIQUE)[0];
  return {
    apps: org.find('appmodules', (a) => a.uniquename === BUILT_UNIQUE).length,
    navigation: (String((sitemap && sitemap.sitemapxml) || '').match(/<SubArea\b[^>]*>/g) || []).map((tag) => ((/\bGenPageId="([^"]+)"/.exec(tag) || [])[1] || 'not a page').toLowerCase()),
    pages: [...org.pageServer.state.projects.values()].filter((p) => p.name === PAGE_NAME).map((p) => String(p.id).toLowerCase()),
  };
};

test('no tables: a dry run plans the app and writes nothing', async () => {
  const env = await environment('lifecycle-no-tables-dry-');
  const dry = ran(await env.harness.measure(() => env.harness.build(spec, { apply: false })), 'the dry run');
  assert.equal(dry.value.result.ok, true, JSON.stringify(dry.value.result.errors));
  assert.deepEqual(dry.writes, {}, 'a dry run writes nothing');
  assert.deepEqual(env.org.inventory(), env.seed);
});

test('no tables: built from nothing — the page, then the app whose first navigation holds it — and verify passes', async () => {
  const env = await built();
  const build = ran(env.build, 'the build');
  assert.equal(build.value.result.ok, true, JSON.stringify(build.value.result.errors));
  const requests = env.org.since(build.mark);
  const pageCreate = requests.findIndex(createsPage);
  const appCreate = requests.findIndex(createsApp);
  assert.ok(pageCreate >= 0 && appCreate > pageCreate, `the page is created (${pageCreate}) before the app (${appCreate})`);
  assert.equal(requests.filter(createsPage).length, 1);
  assert.equal(requests.filter(createsApp).length, 1);
  const after = holds(env.org);
  assert.equal(after.apps, 1);
  assert.equal(after.pages.length, 1);
  assert.deepEqual(after.navigation, after.pages, 'the navigation holds the page, and nothing else');
  assert.ok(!(build.writes['POST EntityDefinitions'] || 0), 'and no table is made');
  assert.deepEqual(build.value.result.verify && { ok: build.value.result.verify.ok, missing: build.value.result.verify.missing }, { ok: true, missing: [] }, 'verify passes');
});

test('no tables: an unchanged rebuild creates nothing', async () => {
  const env = await built();
  const before = holds(env.org);
  const rebuild = ran(await env.harness.measure(() => env.harness.build(spec)), 'the rebuild');
  assert.equal(rebuild.value.result.ok, true, JSON.stringify(rebuild.value.result.errors));
  const requests = env.org.since(rebuild.mark);
  assert.equal(requests.filter(createsApp).length, 0);
  assert.ok(!requests.some(createsPage));
  assert.deepEqual(holds(env.org), before);
});

test('no tables: the teardown deletes everything the build made, and nothing else', async () => {
  const env = await built();
  const teardown = ran(await env.harness.measure(() => env.harness.teardown(spec)), 'the teardown');
  assert.equal(teardown.value.result.ok, true, JSON.stringify(teardown.value.result.errors));
  assert.deepEqual(holds(env.org), { apps: 0, navigation: [], pages: [] });
  // Back to the seed, but for the publisher the build made for the prefix: a teardown never deletes a publisher (other solutions may share it).
  const now = env.org.inventory();
  const madePublishers = now.rows.publishers.filter((p) => !env.seed.rows.publishers.includes(p));
  assert.equal(madePublishers.length, 1, 'the build made one publisher, for its prefix');
  assert.deepEqual({ ...now, rows: { ...now.rows, publishers: now.rows.publishers.filter((p) => !madePublishers.includes(p)) } }, env.seed, 'every other row is as it was before the build');
  assert.deepEqual(diffContents(env.seedContents, env.org.contents(), { added: false }), [], 'and every one of them holds what it held');
});

// NEIGHBOUR: an app with no table AND no navigation entry is still nothing a spec can describe. The download refuses it before it writes
// anything: a folder holding an earlier download of the app keeps it as it was.
test('no tables: an app with no table and no navigation entry is refused by the download before it writes anything', async () => {
  const env = await madeOfOnePage();
  const out = path.join(env.root, 'download');
  const first = ran(await env.harness.measure(() => env.harness.download(MADE_UNIQUE, out)), 'the first download');
  assert.equal(first.value.emitted.ok, true, JSON.stringify(first.value.emitted));
  const snapshot = () => {
    const files = {};
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else files[path.relative(out, full)] = fs.readFileSync(full, 'utf8');
      }
    };
    walk(out);
    return files;
  };
  const before = snapshot();
  // A maker empties the app's navigation in the designer and publishes it: Dataverse accepts an empty navigation on an UPDATE (app-navigation.js).
  const send = async (method, where, body) => {
    const res = await env.org.request({ url: `${env.org.API}${where}`, method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.ok(res.statusCode < 300, `${method} ${where} answered ${res.statusCode}: ${res.body}`);
  };
  const sitemap = env.org.find('sitemaps', (m) => m.sitemapnameunique === MADE_UNIQUE)[0];
  const app = env.org.find('appmodules', (a) => a.uniquename === MADE_UNIQUE)[0];
  await send('PATCH', `/sitemaps(${sitemap.sitemapid})`, { sitemapxml: '<SiteMap IntroducedVersion="7.0.0.0"><Area Id="area_0"><Group Id="group_0" /></Area></SiteMap>' });
  await send('POST', '/PublishXml', { ParameterXml: `<importexportxml><appmodules><appmodule>${app.appmoduleid}</appmodule></appmodules></importexportxml>` });
  const refused = ran(await env.harness.measure(() => env.harness.download(MADE_UNIQUE, out)), 'the second download');
  assert.equal(refused.value.emitted.ok, false);
  assert.equal(refused.value.emitted.payload.error, 'downloaded App Spec failed validation');
  assert.deepEqual(refused.value.emitted.payload.errors, ['at least one entity is required — or, for an app with no tables, an entry in appShell (a page, a dashboard or a URL)']);
  assert.deepEqual(snapshot(), before, 'the folder holds exactly what the earlier download wrote');
});
