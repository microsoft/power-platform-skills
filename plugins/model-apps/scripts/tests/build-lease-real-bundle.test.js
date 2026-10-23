'use strict';
// The build lease (lib/app-operation-lease.js) over the REAL vendored SDK, the plugin's own HTTP client and the stateful fake Dataverse of
// helpers/fake-lifecycle-org.js, through the harness the lifecycle tests share (helpers/lifecycle-harness.js): two builds of one app started
// in one workspace, the second while the first is inside a window where two builds would each create what only one may.
//
// Before the lease, the overlap was measured live: two builds in one workspace both looked up the app's generated icon (`<app>_icon`), both
// found nothing, and both created one and added it to the solution; one app create then failed with a 412. So a barrier holds the first build
// INSIDE such a window — at its request that looks the icon up, at the write of a web resource its spec authors, at the create of an app whose
// navigation holds only pages (made at the end of the pages phase) — and the second build is started then. It is refused (`build-locked`) and
// sends nothing; the first is released once that refusal is seen — never after waiting for a request of the second's, which would not come —
// and creates one of each. A build without the lease sends the second build's lookup too, and the barrier, released once both lookups are in,
// lets both builds create an icon: what these tests fail on there.
//
// And what the lease changes for nobody else: a teardown still deletes the one icon its lookup (`$top=1`) answers, not every row of that name;
// a build that runs alone sends exactly the requests it sent before the lease.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createLifecycleOrg } = require('./helpers/fake-lifecycle-org.js');
const { createLifecycleHarness, ICON_SVG } = require('./helpers/lifecycle-harness.js');
const { appUniqueName } = require('../lib/sdk-build.js');
const { sha256 } = require('../lib/hash.js');

// One table and an app over it, with a generated icon (the spec names none). `authored` adds a web resource the spec authors; `pagesOnly` makes
// the navigation one generative page, so the app is created at the end of the pages phase (the page's source is the file the harness writes into
// the app folder, KitchenPage.tsx).
function raceSpec({ authored = false, pagesOnly = false } = {}) {
  return {
    schemaVersion: 2,
    solution: { uniqueName: 'ContosoLeaseRace', displayName: 'Contoso Lease Race', publisherPrefix: 'contoso' },
    app: { name: 'Lease Race' },
    entities: [{ schemaName: 'contoso_project', displayName: 'Project', pluralName: 'Projects', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns: [] }],
    ...(authored ? { webResources: [{ name: 'contoso_leaserace.svg', displayName: 'Lease Race Image', type: 'svg', content: ICON_SVG }] } : {}),
    ...(pagesOnly ? { pages: [{ key: 'overview', name: 'Race Page', purpose: 'A page over projects.', dataSources: ['contoso_project'], source: { kind: 'tsx', codeFile: 'KitchenPage.tsx' } }] } : {}),
    appShell: { areas: [{ label: 'Work', groups: [{ label: 'Records', subAreas: [pagesOnly ? { page: 'overview', title: 'Race Page' } : { entity: 'contoso_project', title: 'Projects' }] }] }] },
  };
}
const APP = appUniqueName(raceSpec());
const ICON = `${APP}_icon`;

// A request as the fake's transport receives it, read for matching: the path below the API root, the query decoded, the body parsed.
//   GET /api/data/v9.2/webresourceset?$select=webresourceid&$filter=name eq 'contoso_leaserace_icon'&$top=1
const pathOf = (req) => decodeURIComponent(new URL(req.url).pathname).replace(/^\/api\/data\/v9\.\d/, '');
const queryOf = (req) => decodeURIComponent(new URL(req.url).search);
const bodyOf = (req) => { try { return JSON.parse(req.body); } catch { return null; } };

const looksUpIcon = (r) => r.method === 'GET' && r.path === '/webresourceset' && r.query.includes(`name eq '${ICON}'`);
const writesWebResource = (name) => (r) => r.method === 'POST' && r.path === '/webresourceset' && r.body && r.body.name === name;
const createsApp = (r) => r.method === 'POST' && r.path === '/appmodules';

// A fake environment whose transport holds every request `holdIf` matches until `release()`, and records every request (`wire`) as it arrives —
// a held one included. `holding(n)` resolves once n requests are held.
function raceEnvironment(holdIf) {
  const org = createLifecycleOrg();
  const wire = [];
  const held = [];
  const waiters = [];
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  const request = async (req) => {
    const entry = { method: req.method, path: pathOf(req), query: queryOf(req), body: bodyOf(req) };
    wire.push(entry);
    if (holdIf && holdIf(entry)) {
      held.push(entry);
      for (const w of waiters.splice(0)) w();
      await released;
    }
    return org.request(req);
  };
  const holding = (n) => new Promise((resolve) => {
    const check = () => (held.length >= n ? resolve() : waiters.push(check));
    check();
  });
  const harness = createLifecycleHarness({ ...org, request }, makeTempDir('build-lease-race-'));
  if (!fs.existsSync(path.join(harness.appDir, 'KitchenPage.tsx'))) throw new Error('the harness writes the page source');
  return { org, harness, wire, held, holding, release };
}

// The first build held in its window, a second build of the same app started in the same workspace, and the first released once the second has
// settled — or, where nothing refuses the second, once the second's own request reached the window as well. Answers what each came to, and the
// requests the second sent before it settled.
async function overlap(env, spec) {
  const first = env.harness.build(spec).then((r) => r, (e) => ({ error: e }));
  await env.holding(1);
  const mark = env.wire.length;
  // The second build's SDK keeps its copies apart from the first's: the command makes none for an apply its lease refuses.
  const second = env.harness.build(spec, { sdkWorkspace: makeTempDir('build-lease-second-sdk-') }).then((r) => r, (e) => ({ error: e }));
  let sentBySecond = null;
  await Promise.race([second.then(() => { sentBySecond = env.wire.slice(mark); }), env.holding(2)]);
  env.release();
  return { first: await first, second: await second, sentBySecond };
}

const refusedAsLocked = (outcome) => {
  const e = outcome.error;
  assert.ok(e, `the second build was refused, not run: ${JSON.stringify(outcome.result && { ok: outcome.result.ok, errors: outcome.result.errors })}`);
  assert.strictEqual(e.code, 'build-locked', String(e.stack));
  assert.strictEqual(e.retry, 'never');
};
const built = (outcome, what) => {
  assert.ok(!outcome.error, `${what}: ${outcome.error && outcome.error.stack}`);
  assert.strictEqual(outcome.result.ok, true, `${what}: ${JSON.stringify(outcome.result.errors)}`);
};
const noLockLeft = (env) => {
  const lock = path.join(env.harness.workspaceDir, `app-build.${sha256(APP.toLowerCase())}.lock`);
  assert.ok(!fs.existsSync(lock), 'no build lock is left');
};

test('two first builds of one app in one workspace cannot create its generated icon twice: the second is refused before it sends a request, and the first makes one icon and one app', async () => {
  const env = raceEnvironment(looksUpIcon);
  const { first, second, sentBySecond } = await overlap(env, raceSpec());
  // The counts first: where nothing refuses the second build, they are what shows the race.
  assert.strictEqual(env.wire.filter(writesWebResource(ICON)).length, 1, 'one icon create');
  assert.strictEqual(env.org.find('webresourceset', (w) => w.name === ICON).length, 1, 'the environment holds one icon');
  assert.strictEqual(env.wire.filter(createsApp).length, 1, 'one app create');
  assert.strictEqual(env.org.find('appmodules', (a) => a.uniquename === APP).length, 1, 'and one app');
  assert.strictEqual(env.held.length, 1, 'one lookup reached the window');
  refusedAsLocked(second);
  assert.deepStrictEqual(sentBySecond, [], 'the second build sent nothing — not even the lookup');
  built(first, 'the first build');
  noLockLeft(env);
});

test('a second build is refused while the first writes a web resource its spec authors', async () => {
  {
    const env = raceEnvironment(writesWebResource('contoso_leaserace.svg'));
    const { first, second, sentBySecond } = await overlap(env, raceSpec({ authored: true }));
    assert.strictEqual(env.wire.filter(writesWebResource('contoso_leaserace.svg')).length, 1, 'one write of the authored web resource');
    assert.strictEqual(env.org.find('webresourceset', (w) => w.name === 'contoso_leaserace.svg').length, 1);
    refusedAsLocked(second);
    assert.deepStrictEqual(sentBySecond, [], 'the second build sent nothing');
    built(first, 'the first build');
    noLockLeft(env);
  }
});

test('a second build is refused while the first creates, at the end of its pages, an app whose navigation holds only pages', async () => {
  {
    const env = raceEnvironment(createsApp);
    const { first, second, sentBySecond } = await overlap(env, raceSpec({ pagesOnly: true }));
    assert.strictEqual(env.wire.filter(createsApp).length, 1, 'one app create');
    assert.strictEqual(env.org.find('appmodules', (a) => a.uniquename === APP).length, 1);
    refusedAsLocked(second);
    assert.deepStrictEqual(sentBySecond, [], 'the second build sent nothing');
    built(first, 'the first build');
    noLockLeft(env);
  }
});

test('a teardown deletes the one generated icon its lookup answers ($top=1) — a second row of that name, in the app\'s solution, is not deleted', async () => {
  const env = raceEnvironment(null);
  const spec = raceSpec();
  built(await env.harness.build(spec).then((r) => r, (e) => ({ error: e })), 'the build');
  const [builtIcon] = env.org.find('webresourceset', (w) => w.name === ICON);
  assert.ok(builtIcon, 'the build made the icon');
  // Another row of the same name, added to the same solution — as a build without the lease could have left.
  const planted = '33333333-0000-4000-8000-000000000001';
  const res = await env.org.request({
    url: `${env.org.API}/webresourceset`, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'MSCRM.SolutionUniqueName': spec.solution.uniqueName },
    body: JSON.stringify({ webresourceid: planted, name: ICON, displayname: 'Lease Race Icon', webresourcetype: 11, content: Buffer.from(ICON_SVG).toString('base64') }),
  });
  assert.ok(res.statusCode < 300, `planted: ${res.statusCode} ${res.body}`);
  const mark = env.wire.length;
  const { result } = await env.harness.teardown(spec);
  assert.ok(result, 'the teardown ran');
  const lookups = env.wire.slice(mark).filter(looksUpIcon);
  assert.ok(lookups.length >= 1, 'the teardown looked the icon up by name');
  for (const l of lookups) assert.ok(/\$top=1(&|$)/.test(l.query), `by its name, for one row: ${l.query}`);
  assert.deepStrictEqual(env.org.find('webresourceset', (w) => w.name === ICON).map((w) => w.webresourceid), [planted], 'the icon the lookup answered is deleted; the other row is kept');
});

// What a build that runs alone sends, by `METHOD entity set` — ids, keys and queries left out — as the build sent it before the lease (2.18.0),
// for the first build and an unchanged rebuild of the same spec. The lease is a file in the workspace: a build that meets no other sends exactly
// this, and a request the lease added would show here.
const ALONE = {
  build: {
    'GET /appmodulecomponents': 5,
    'GET /appmodules': 4,
    'GET /appmodules()': 2,
    'GET /appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()': 4,
    'GET /appsettings/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()': 1,
    'GET /EntityDefinitions': 1,
    'GET /EntityDefinitions()': 11,
    'GET /EntityDefinitions()/Attributes': 1,
    'GET /publishers': 1,
    'GET /roles': 1,
    'GET /savedqueries': 1,
    'GET /savedqueryvisualizations': 1,
    'GET /settingdefinitions': 1,
    'GET /sitemaps': 2,
    'GET /sitemaps()': 1,
    'GET /sitemaps/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()': 1,
    'GET /solutions': 2,
    'GET /systemforms': 1,
    'GET /webresourceset': 2,
    'GET /webresourceset()': 2,
    'POST /AddAppComponents': 1,
    'POST /AddSolutionComponent': 4,
    'POST /appmodules': 1,
    'POST /appmodules()/appmoduleroles_association/$ref': 1,
    'POST /appsettings': 1,
    'POST /EntityDefinitions': 1,
    'POST /publishers': 1,
    'POST /PublishXml': 5,
    'POST /sitemaps': 1,
    'POST /solutions': 1,
    'POST /webresourceset': 2,
  },
  rebuild: {
    'GET /appmodulecomponents': 19,
    'GET /appmodules': 6,
    'GET /appmodules()': 6,
    'GET /appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()': 22,
    'GET /EntityDefinitions': 1,
    'GET /EntityDefinitions()': 10,
    'GET /EntityDefinitions()/Attributes': 2,
    'GET /savedqueries': 1,
    'GET /savedqueryvisualizations': 1,
    'GET /sitemaps': 3,
    'GET /sitemaps()': 6,
    'GET /sitemaps/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()': 6,
    'GET /solutioncomponents': 1,
    'GET /solutions': 3,
    'GET /systemforms': 1,
    'GET /systemforms/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()': 1,
    'GET /uxagentprojects': 1,
    'GET /webresourceset': 3,
    'PATCH /sitemaps()': 1,
    'POST /AddAppComponents': 1,
    'POST /PublishXml': 3,
  },
};
//   PATCH /EntityDefinitions(LogicalName='contoso_project')/Attributes(3f…)  ->  'PATCH /EntityDefinitions()/Attributes()'
const multiset = (requests) => {
  const out = {};
  for (const r of requests) {
    const key = `${r.method} ${r.path.replace(/\([^)]*\)/g, '()')}`;
    out[key] = (out[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
};

test('a build that meets no other sends the requests it sent before the lease: its first build and an unchanged rebuild', async () => {
  const env = raceEnvironment(null);
  const spec = raceSpec({ authored: true });
  const first = env.wire.length;
  built(await env.harness.build(spec).then((r) => r, (e) => ({ error: e })), 'the build');
  const afterBuild = env.wire.length;
  built(await env.harness.build(spec).then((r) => r, (e) => ({ error: e })), 'the rebuild');
  const seen = { build: multiset(env.wire.slice(first, afterBuild)), rebuild: multiset(env.wire.slice(afterBuild)) };
  if (process.env.PRINT_ALONE) process.stdout.write(`# ALONE ${JSON.stringify(seen)}\n`);
  assert.deepStrictEqual(seen, ALONE);
});
