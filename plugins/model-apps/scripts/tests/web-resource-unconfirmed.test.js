'use strict';
// A web resource whose publication the bundled SDK could not confirm (WEB_RESOURCE_UNVERIFIED) — at every place the build writes one: the spec's web
// resources, the generated app icon and the page manifest.
//
// The SDK writes a web resource, publishes it, and reads its PUBLISHED content back (a plain GET by id); when the publish fails or the read-back cannot
// confirm the content it throws WebResourceUnverifiedError — after the row exists, with its id, and with the failure as its non-enumerable `cause`. A
// second create of the name is refused. Before the build handled it, the step threw before it recorded the row or added it to the solution, and every
// run after that found the name and reused the row untouched: outside the solution, its content never confirmed. Now the build records the row (in the
// run's result, and in the workspace: lib/web-resource-records.js), adds it to the solution, and stops with what a run again does — which is to write the
// content again by id (the page manifest: unless its published copy already holds that content, which is kept), never to create the name again. Held here:
//   1. the record itself;
//   2. the build's retry policy for the error: it is judged by the failure it carries, and when it carries none — the read-back differed — it is run again;
//   3. each site, over the real bundle and the stateful fake of helpers/fake-app-build-org.js (a web resource held in a saved and a published layer, a plain
//      read answering the published one), with the customization lock refusing the publish: the halt, the row in the solution, the record, the next run —
//      the build's own re-run and a new invocation — writing the content again by id (the manifest: or keeping a published copy that already holds it),
//      and an unchanged rebuild after it sending what it always did.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../vendor/cds-maker-sdk.cjs');
const { createMakerSdk: createClientSdk } = require('../lib/maker-sdk.js');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const { runSdkBuild, appUniqueName } = require('../lib/sdk-build.js');
const { withAppBuildLease } = require('../lib/app-operation-lease.js');
const { requireSuccessfulPush } = require('../lib/entity-provision.js');
const { buildModelApp, isTransientHalt } = require('../build-model-app.js');
const { retryPolicyFor, judgeFailure, RETRY } = require('../lib/retry-policy.js');
const { openUnconfirmedWebResources, readUnconfirmedWebResources, unconfirmedRecordPath, PREFIX } = require('../lib/web-resource-records.js');
const { createFakeBuildOrg } = require('./helpers/fake-app-build-org.js');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tempDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-unconfirmed-')); dirs.push(d); return d; };
const ENV = 'https://contoso.crm.dynamics.com';
const ID_A = '11111111-aaaa-4aaa-8aaa-111111111111';
const ID_B = '22222222-bbbb-4bbb-8bbb-222222222222';
const LOCK = { code: '0x80071151', message: 'Cannot start the requested operation [Publish] because there is another [WorkflowSetState] running at this moment.' };
const base64 = (text) => Buffer.from(text, 'utf8').toString('base64');

// --- 1. the record ------------------------------------------------------------------------------------------------------------------------------------------

test('the record: a row noted is read back by any letter case of its name, by the next run too; cleared, it is gone, and the file with its last entry', () => {
  const dir = tempDir();
  const run = openUnconfirmedWebResources({ workspaceDir: dir, environment: ENV });
  assert.equal(run.idOf('contoso_/a.js'), undefined, 'nothing recorded yet, and no file');
  assert.equal(run.note('contoso_/a.js', ID_A.toUpperCase()), true, 'on disk');
  assert.equal(run.note('contoso_/b.js', ID_B), true);
  assert.equal(run.idOf('CONTOSO_/A.JS'), ID_A, 'a name is compared as Dataverse compares it; the id is kept in lower case');
  const next = openUnconfirmedWebResources({ workspaceDir: dir, environment: ENV });
  assert.equal(next.idOf('contoso_/b.js'), ID_B, 'the next run reads what this one recorded');
  assert.deepEqual([...readUnconfirmedWebResources(dir, ENV).values()].map((e) => [e.name, e.id]), [['contoso_/a.js', ID_A], ['contoso_/b.js', ID_B]]);
  next.clear('contoso_/a.js');
  assert.equal(openUnconfirmedWebResources({ workspaceDir: dir, environment: ENV }).idOf('contoso_/a.js'), undefined);
  next.clear('contoso_/b.js');
  assert.equal(fs.existsSync(unconfirmedRecordPath(dir, ENV)), false, 'an empty record is no file');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith(PREFIX)), []);
});

test('the record is one file per environment, and another environment\'s rows are not this one\'s', () => {
  const dir = tempDir();
  openUnconfirmedWebResources({ workspaceDir: dir, environment: ENV }).note('contoso_/a.js', ID_A);
  assert.equal(openUnconfirmedWebResources({ workspaceDir: dir, environment: 'https://fabrikam.crm.dynamics.com' }).idOf('contoso_/a.js'), undefined);
  assert.equal(openUnconfirmedWebResources({ workspaceDir: dir, environment: `${ENV}/` }).idOf('contoso_/a.js'), ID_A, 'the same origin, written another way');
});

test('the record never stops a build: a damaged file is "nothing recorded", said once; with no workspace or environment nothing is recorded, and a note says so', () => {
  const dir = tempDir();
  fs.writeFileSync(unconfirmedRecordPath(dir, ENV), '{ not json');
  const warnings = [];
  const run = openUnconfirmedWebResources({ workspaceDir: dir, environment: ENV, warn: (w) => warnings.push(w) });
  assert.equal(run.idOf('contoso_/a.js'), undefined);
  assert.equal(run.idOf('contoso_/b.js'), undefined);
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.match(warnings[0], /could not be read .*so this build reuses every web resource that exists as it is/);
  for (const options of [{}, { workspaceDir: dir }, { environment: ENV }]) {
    const none = openUnconfirmedWebResources(options);
    assert.equal(none.note('contoso_/a.js', ID_A), false, JSON.stringify(options));
    assert.equal(none.idOf('contoso_/a.js'), undefined);
  }
  assert.equal(openUnconfirmedWebResources({ workspaceDir: dir, environment: ENV }).note('contoso_/a.js', 'not-a-guid'), false, 'an id that is no id is not recorded');
});

// --- 2. the retry policy ------------------------------------------------------------------------------------------------------------------------------------
//
// The REAL SDK's error, made by the real bundle over a transport that answers the create, the publish and the read-back as each case asks. Its `cause` is not
// enumerable — what the policy reads is reached all the same.
async function sdkError({ publish = { status: 204 }, readBack } = {}) {
  let saved;
  const answer = (a) => ({ status: a.status, headers: a.headers || {}, body: a.body === undefined ? {} : a.body });
  const httpClient = {
    get: async (url) => (/\/webresourceset\(/.test(url) ? answer(readBack ? readBack(saved) : { status: 200, body: { content: saved } }) : answer({ status: 200, body: { value: [] } })),
    post: async (url, body) => {
      if (/\/webresourceset$/.test(url)) { saved = body.content; return { status: 204, headers: { 'odata-entityid': `${ENV}/api/data/v9.2/webresourceset(${ID_A})` }, body: {} }; }
      return answer(publish);
    },
    patch: async () => answer({ status: 204 }),
    delete: async () => answer({ status: 204 }),
    put: async () => answer({ status: 204 }),
  };
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(tempDir()), instanceUrl: ENV, httpClient });
  await sdk.initWorkspace();
  return sdk.createWebResource({ name: 'contoso_/scripts/sql_timeout_try_again_later.js', type: 'js', content: 'var Form = {};' }).then(() => assert.fail('the create was confirmed'), (e) => e);
}

test('retry policy: WEB_RESOURCE_UNVERIFIED is judged by the failure it carries — a lock, a 503 or a reset is run again, a 400, 401, 403, 404 or 412 is not — read through a cause that is not enumerable', async () => {
  const cases = [
    ['the publish refused by the customization lock (429 0x80071151)', { publish: { status: 429, body: { error: LOCK } } }, RETRY.SERVICE],
    ['the publish answered 503', { publish: { status: 503, body: { error: { message: 'Service Unavailable' } } } }, RETRY.SERVICE],
    ['the publish answered 500 with the lock\'s code', { publish: { status: 500, body: { error: LOCK } } }, RETRY.SERVICE],
    ['the publish refused 400', { publish: { status: 400, body: { error: { code: '0x80040216', message: 'An unexpected error occurred. SQL timeout, try again later' } } } }, RETRY.NEVER],
    ['the publish refused 401', { publish: { status: 401, body: {} } }, RETRY.NEVER],
    ['the publish refused 403', { publish: { status: 403, body: { error: { code: '0x80040220', message: 'Principal user is missing prvPublishCustomizations privilege. Try again later.' } } } }, RETRY.NEVER],
    ['the publish answered 412 (the SDK\'s typed VERSION_CONFLICT)', { publish: { status: 412, body: {} } }, RETRY.NEVER],
    ['the read-back answered 404', { readBack: () => ({ status: 404, body: { error: { message: 'Does Not Exist' } } }) }, RETRY.NEVER],
    ['the read-back answered 503', { readBack: () => ({ status: 503, body: {} }) }, RETRY.SERVICE],
    ['the read-back answered other content (no cause)', { readBack: () => ({ status: 200, body: { content: base64('var Old = {};') } }) }, RETRY.SERVICE],
    ['the read-back carried no content (no cause)', { readBack: () => ({ status: 200, body: { content: null } }) }, RETRY.SERVICE],
  ];
  for (const [what, answers, policy] of cases) {
    const error = await sdkError(answers);
    assert.equal(error.code, 'WEB_RESOURCE_UNVERIFIED', what);
    assert.equal(error.id, ID_A, `${what}: the row is named`);
    assert.ok(!Object.keys(error).includes('cause'), `${what}: the cause is not enumerable`);
    assert.equal(retryPolicyFor(error), policy, what);
    assert.equal(isTransientHalt(error), policy === RETRY.SERVICE, `${what}: the build's own re-run decides alike`);
    // The build's own error around it (the halt's cause), whose words name the web resource: judged the same, and no word of either is read.
    const wrapped = Object.assign(new Error(`${error.message} — this build recorded the row as its own`, { cause: error }), { code: 'WEB_RESOURCE_UNVERIFIED', id: error.id });
    assert.equal(retryPolicyFor(wrapped), policy, `${what}: around the build's own error`);
    assert.equal(judgeFailure(wrapped).text.includes('sql_timeout'), false, `${what}: the name is never read`);
  }
});

test('retry policy: the wrapper alone, with no failure behind it, is run again — and an error of another code that carries no cause is still a typed refusal', () => {
  const unconfirmed = Object.assign(new Error('Web resource \'contoso_/a.js\' (id) was written and published, but the published content is not what was sent'), { code: 'WEB_RESOURCE_UNVERIFIED', id: ID_A });
  assert.equal(retryPolicyFor(unconfirmed), RETRY.SERVICE);
  assert.equal(judgeFailure(unconfirmed).unconfirmed, true);
  assert.equal(retryPolicyFor(Object.assign(new Error('x'), { code: 'VALIDATION_ERROR' })), RETRY.NEVER, 'the neighbour: a typed refusal stays one');
  assert.equal(retryPolicyFor(Object.assign(new Error('x'), { code: 'WEB_RESOURCE_UNVERIFIED', cause: { transient: false } })), RETRY.NEVER, 'a cause that says never is final');
});

// --- 3. the sites, over the real bundle --------------------------------------------------------------------------------------------------------------------

// What the customization lock answers a publish it refuses, and the fake's intercept of the publishes that name a web resource: `refusals` of them are refused.
const lockRefused = () => ({ status: 429, headers: {}, body: { error: LOCK } });
const namesWebResource = (c) => c.method === 'POST' && c.path === '/PublishXml' && /<webresource>/.test(c.body.ParameterXml);
function refuseWebResourcePublishes(org, refusals = 1) {
  let left = refusals;
  return org.intercept((c) => namesWebResource(c) && left > 0 && (left -= 1, true), lockRefused);
}

function scenario({ realClient = false } = {}) {
  const org = createFakeBuildOrg({ entities: {} });
  const dir = tempDir();
  const warnings = [];
  const wire = [];
  const httpClient = realClient ? createAzHttpClient(org.origin, {
    getToken: () => 'offline-resource-reset-token',
    sleep: async () => {},
    request: async (request) => {
      wire.push({ ...request, recoveryId: openUnconfirmedWebResources({ workspaceDir: dir, environment: org.origin }).idOf(SCRIPT) });
      const verb = request.method.toLowerCase();
      const options = { headers: request.headers };
      const response = ['get', 'delete'].includes(verb)
        ? await org.httpClient[verb](request.url, options)
        : await org.httpClient[verb](request.url, request.body ? JSON.parse(request.body) : undefined, options);
      return { statusCode: response.status, headers: response.headers || {}, body: typeof response.body === 'string' ? response.body : JSON.stringify(response.body) };
    },
  }) : org.httpClient;
  async function build(spec, { phases = ['web-resources'], workspaceDir = dir, ...extra } = {}) {
    const sdk = (realClient ? createClientSdk : createMakerSdk)({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: org.origin, httpClient });
    await sdk.initWorkspace();
    const mark = org.calls.length;
    try {
      const outcome = await runSdkBuild(spec, { sdk, apply: true, publish: true, phases, workspaceDir, appDir: dir, env: org.origin, warn: (w) => warnings.push(String(w)), ...extra });
      return { outcome, mark, calls: org.calls.slice(mark) };
    } catch (halt) {
      return { halt, mark, calls: org.calls.slice(mark) };
    }
  }
  const row = (name) => [...org.resources.values()].find((r) => r.name === name);
  return { org, dir, build, row, warnings, wire };
}

const SCRIPT = 'contoso_/scripts/form.js';
const SCRIPT_CODE = 'var Form = { onLoad: function () {} };';
const spec = (webResources = [{ name: SCRIPT, type: 'js', content: SCRIPT_CODE }]) => ({
  solution: { uniqueName: 'ContosoReview', displayName: 'Contoso Review', publisherPrefix: 'contoso' },
  app: { name: 'Publish Review', uniqueName: 'contoso_publishreview' },
  entities: [{ schemaName: 'contoso_item', displayName: 'Item', existing: true, primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns: [] }],
  webResources,
});
const writesOf = (calls) => calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path.replace(/\([0-9a-f-]{36}\)/i, '(id)')}${c.path === '/PublishXml' ? ` ${/<(\w+)>[^<]*<\/\1><\/\w+><\/importexportxml>/.exec(c.body.ParameterXml)[1]}` : ''}${c.path === '/AddSolutionComponent' ? ` ${c.body.ComponentId === undefined ? '' : 'web resource'}` : ''}`);
const added = (calls, id) => calls.filter((c) => c.method === 'POST' && c.path === '/AddSolutionComponent' && String(c.body.ComponentId).toLowerCase() === id);

test('a spec web resource whose publish the lock refuses: the build stops naming it, unconfirmed and not lost — the row is in the solution and recorded, and the build\'s own retry runs again', async () => {
  const s = scenario();
  refuseWebResourcePublishes(s.org);
  const first = await s.build(spec());
  assert.ok(first.halt, 'the build stopped');
  const id = s.row(SCRIPT).webresourceid;
  assert.equal(first.halt.code, 'WEB_RESOURCE_UNVERIFIED');
  assert.equal(first.halt.phase, 'web-resources');
  assert.match(first.halt.message, new RegExp(`Web resource '${SCRIPT.replace(/[/.]/g, '\\$&')}' \\(${id}\\)`), 'it names the web resource and its id');
  assert.match(first.halt.message, /this build recorded the row as its own and added it to the solution\. Its publication is UNCONFIRMED, not lost: run the build again — it writes the content again by that id, publishes it and reads it back/);
  assert.match(first.halt.message, /run the build again — it writes the content again by that id, publishes it and reads it back \(the call the message names is made for you\)\.$/, 'written again whatever was published: the stop promises the write');
  assert.equal(added(first.calls, id).length, 1, 'the row is added to the solution as the success path adds it');
  assert.equal(openUnconfirmedWebResources({ workspaceDir: s.dir, environment: s.org.origin }).idOf(SCRIPT), id, 'and recorded for the next run');
  assert.equal(retryPolicyFor(first.halt), RETRY.SERVICE, 'a lock is the service\'s to clear');
  assert.equal(isTransientHalt(first.halt), true, 'so the build runs again');
  assert.equal(s.row(SCRIPT).publishedContent, undefined, 'nothing of it is published');
});

test('the run that follows writes it again by id — no second create of the name — publishes and reads it back, puts it in the solution and clears the record; the run after that sends what any rebuild does', async () => {
  const s = scenario();
  refuseWebResourcePublishes(s.org);
  await s.build(spec());
  const id = s.row(SCRIPT).webresourceid;
  const next = await s.build(spec());
  assert.ok(next.outcome && next.outcome.ok, String(next.halt && next.halt.message));
  assert.deepEqual(writesOf(next.calls), ['PATCH /webresourceset(id)', 'POST /PublishXml webresource', 'POST /AddSolutionComponent web resource'], 'written again by id: never POSTed');
  assert.ok(next.calls.some((c) => c.method === 'GET' && c.path === `/webresourceset(${id})?$select=content`), 'and its published content read back');
  assert.ok(!next.calls.some((c) => c.method === 'GET' && /^\/webresourceset\?/.test(c.path)), 'the name is not even looked up: the record names the row');
  assert.equal(s.row(SCRIPT).publishedContent, base64(SCRIPT_CODE), 'what is published is what the spec says');
  assert.equal(fs.existsSync(unconfirmedRecordPath(s.dir, s.org.origin)), false, 'confirmed, the record is gone');
  assert.equal(next.outcome.created.webResources[SCRIPT], id);
  // An unchanged rebuild after it: the name is found and reused, exactly as for a web resource whose first write was confirmed.
  const quiet = scenario();
  await quiet.build(spec());
  const clean = await quiet.build(spec());
  const after = await s.build(spec());
  assert.deepEqual(writesOf(after.calls), [], 'nothing written');
  assert.deepEqual(after.calls.map((c) => `${c.method} ${c.path}`), clean.calls.map((c) => `${c.method} ${c.path}`), 'and the same requests as a rebuild of a web resource whose first write was confirmed');
});

function followEmittedResetAdvice(dir) {
  let advice;
  try {
    // Select the real shared remedy with a by-value refusal; the resource's write, unverified error
    // and recovery below still traverse the actual bundle and production HTTP client.
    requireSuccessfulPush({ saved: false, error: { code: 'ARTIFACT_ALREADY_EXISTS', message: 'An owned fixture row already exists.' } }, 'owned fixture');
  } catch (halt) {
    assert.equal(halt.code, 'already-exists');
    advice = halt.message;
  }
  assert.match(advice, /stop any other build or teardown/);
  assert.match(advice, /then delete everything in it except /);
  // Read the emitted preservation names, e.g. `last-applied.json` or `page-ownership.*.json`,
  // instead of giving this test a separate keep-list that could conceal missing operator advice.
  const patterns = [...advice.matchAll(/\b[a-z][a-z0-9-]*(?:\.[a-z0-9*-]+)*\.json\b/g)].map(([name]) => {
    const literal = (part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${name.split('*').map(literal).join('.*')}$`);
  });
  assert.ok(patterns.length >= 3, 'the emitted rule names the baseline, approval and page records');
  const removed = [];
  for (const name of fs.readdirSync(dir)) {
    if (patterns.some((pattern) => pattern.test(name))) continue;
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

for (const stalePublished of [false, true]) {
  test(`workspace reset ${stalePublished ? 'does not turn unconfirmed published content into successful stale reuse' : 'retains the recovery identity of a never-published partial resource'} through the real client`, async (t) => {
    const s = scenario({ realClient: true });
    const stop = stalePublished ? s.org.intercept(namesWebResource, () => {
      s.row(SCRIPT).publishedContent = base64('var Form = { old: true };');
      return { status: 204, headers: {}, body: null };
    }) : refuseWebResourcePublishes(s.org);
    const first = await s.build(spec());
    stop();
    assert.equal(first.halt && first.halt.code, 'WEB_RESOURCE_UNVERIFIED');
    const row = s.row(SCRIPT);
    const id = row.webresourceid;
    const receipt = unconfirmedRecordPath(s.dir, s.org.origin);
    assert.equal(openUnconfirmedWebResources({ workspaceDir: s.dir, environment: s.org.origin }).idOf(SCRIPT), id);
    assert.equal(s.wire.filter((request) => request.method === 'POST' && new URL(request.url).pathname.endsWith('/PublishXml')).length, 1);
    assert.equal(row.publishedContent, stalePublished ? base64('var Form = { old: true };') : undefined);

    fs.writeFileSync(path.join(s.dir, 'last-applied.json'), '{"baseline":"keep"}\n');
    fs.writeFileSync(path.join(s.dir, 'destructive-approval.json'), '{"approved":"keep"}\n');
    const pages = require('../lib/page-ownership-records.js');
    pages.recordPageCreation(s.dir, 'contoso_reset', 'overview', ID_A, 'Overview', s.org.origin);
    pages.recordPagePending(s.dir, 'contoso_reset', 'detail', ID_B, 'Detail', s.org.origin, 'a'.repeat(64));
    pages.recordPageTeardown(s.dir, 'contoso_reset', [{ id: ID_A, key: 'overview', name: 'Overview' }], s.org.origin);
    const existingStores = new Map(fs.readdirSync(s.dir)
      .filter((name) => ['last-applied.json', 'destructive-approval.json'].includes(name) || name.startsWith('page-ownership.'))
      .map((name) => [name, fs.readFileSync(path.join(s.dir, name))]));
    assert.equal(existingStores.size, 5, 'baseline, approval and all three page-record kinds coexist with the resource receipt');
    fs.writeFileSync(path.join(s.dir, 'reset-cache.json'), '{"cache":"discard"}\n');
    fs.mkdirSync(path.join(s.dir, 'reset-cache'));
    fs.writeFileSync(path.join(s.dir, 'reset-cache', 'artifact.json'), '{"cache":"discard"}\n');
    const removed = followEmittedResetAdvice(s.dir);
    assert.ok(removed.includes('reset-cache.json') && removed.includes('reset-cache'), 'nonessential files and cached directories are reset');
    assert.equal(fs.existsSync(path.join(s.dir, 'manifest.json')), false, 'the SDK manifest is reconstructible cache, not an essential record');
    for (const [name, bytes] of existingStores) assert.deepEqual(fs.readFileSync(path.join(s.dir, name)), bytes, `${name} is preserved byte for byte`);

    const mark = s.wire.length;
    const next = await s.build(spec());
    const sent = s.wire.slice(mark);
    const creates = sent.filter((request) => request.method === 'POST' && new URL(request.url).pathname.endsWith('/webresourceset'));
    const patches = sent.filter((request) => request.method === 'PATCH');
    t.diagnostic(JSON.stringify({ stalePublished, resultOk: next.outcome && next.outcome.ok, failureCode: next.halt && next.halt.code, creates: creates.length, patches: patches.length }));
    assert.equal(next.outcome && next.outcome.ok, true, 'following the emitted reset must recover instead of retrying a refused duplicate create');
    assert.equal(row.publishedContent, base64(SCRIPT_CODE), 'a successful rebuild must publish the intended bytes, not silently reuse stale content');
    assert.equal(next.outcome.created.webResources[SCRIPT], id, 'the original durable id is retained');
    assert.equal(creates.length, 0, 'reset does not authorize another create by name');
    assert.equal(patches.length, 1);
    assert.equal(new URL(patches[0].url).pathname.endsWith(`/webresourceset(${id})`), true);
    assert.equal(JSON.parse(patches[0].body).content, base64(SCRIPT_CODE));
    const verified = sent.findIndex((request) => request.method === 'GET' && new URL(request.url).pathname.endsWith(`/webresourceset(${id})`) && new URL(request.url).searchParams.get('$select') === 'content');
    assert.ok(verified > sent.indexOf(patches[0]), 'published content is verified after rewriting the original row');
    assert.equal(sent[verified].recoveryId, id, 'verification still has the durable receipt');
    assert.equal(sent.filter((request) => request.method === 'POST' && new URL(request.url).pathname.endsWith('/PublishXml')).length, 1);
    assert.equal(fs.existsSync(receipt), false, 'only successful recovery clears the receipt');
    for (const [name, bytes] of existingStores) assert.deepEqual(fs.readFileSync(path.join(s.dir, name)), bytes, `${name} also survives recovery`);
  });
}

test('a write again that the lock refuses too keeps the record and stops again, and a quiet run then converges — one create in three runs', async () => {
  const s = scenario();
  refuseWebResourcePublishes(s.org, 2);
  await s.build(spec());
  const id = s.row(SCRIPT).webresourceid;
  const second = await s.build(spec());
  assert.equal(second.halt && second.halt.code, 'WEB_RESOURCE_UNVERIFIED');
  assert.deepEqual(writesOf(second.calls), ['PATCH /webresourceset(id)', 'POST /PublishXml webresource', 'POST /AddSolutionComponent web resource'], 'the second attempt wrote by id too');
  assert.equal(openUnconfirmedWebResources({ workspaceDir: s.dir, environment: s.org.origin }).idOf(SCRIPT), id, 'still recorded');
  const third = await s.build(spec());
  assert.ok(third.outcome && third.outcome.ok, String(third.halt && third.halt.message));
  assert.equal(s.row(SCRIPT).publishedContent, base64(SCRIPT_CODE));
  assert.equal(s.org.calls.filter((c) => c.method === 'POST' && c.path === '/webresourceset').length, 1, 'one create in three runs');
});

test('an unconfirmed update still names the web resource, not only the id the SDK reports', async () => {
  const s = scenario();
  refuseWebResourcePublishes(s.org, 2);
  await s.build(spec());
  const again = await s.build(spec());
  assert.equal(again.halt && again.halt.code, 'WEB_RESOURCE_UNVERIFIED');
  assert.match(again.halt.message, /Web resource 'contoso_\/scripts\/form\.js'/);
});

test('a missing recorded row whose name another maker now holds is refused without writing or adopting that replacement', async () => {
  const s = scenario();
  refuseWebResourcePublishes(s.org);
  await s.build(spec());
  const gone = s.row(SCRIPT).webresourceid;
  s.org.resources.delete(gone);
  s.org.resources.set(ID_B, { webresourceid: ID_B, name: SCRIPT, content: base64('var Theirs = {};'), publishedContent: base64('var Theirs = {};') });
  const next = await s.build(spec());
  assert.equal(next.halt && next.halt.code, 'WEB_RESOURCE_IDENTITY_CONFLICT');
  assert.equal(retryPolicyFor(next.halt), RETRY.NEVER);
  assert.deepEqual(writesOf(next.calls), ['PATCH /webresourceset(id)'], 'only the write to the old id was attempted; never a second create or a write to the replacement');
  assert.equal(s.org.resources.get(ID_B).content, base64('var Theirs = {};'));
  assert.equal(openUnconfirmedWebResources({ workspaceDir: s.dir, environment: s.org.origin }).idOf(SCRIPT), gone, 'the unresolved receipt is kept');
});

test('a recorded resource whose id now reads as another name is refused before writing it', async () => {
  const s = scenario();
  refuseWebResourcePublishes(s.org);
  await s.build(spec());
  const resource = s.row(SCRIPT);
  resource.name = 'fabrikam_/foreign.js';
  resource.content = resource.publishedContent = base64('var Theirs = {};');
  const next = await s.build(spec());
  assert.equal(next.halt && next.halt.code, 'WEB_RESOURCE_IDENTITY_CONFLICT');
  assert.equal(retryPolicyFor(next.halt), RETRY.NEVER);
  assert.deepEqual(writesOf(next.calls), []);
  assert.equal(resource.content, base64('var Theirs = {};'));
  assert.equal(openUnconfirmedWebResources({ workspaceDir: s.dir, environment: s.org.origin }).idOf(SCRIPT), resource.webresourceid);
});

test('a write again whose publish is accepted and publishes the OLD content is caught by the read-back: the build stops again, is run again, and a quiet run converges', async () => {
  const s = scenario();
  // A row this build created and whose last write it could not confirm, published since with the old content (measured under the lock: a later accepted
  // publish published the OLD content).
  const id = '44444444-dddd-4ddd-8ddd-444444444444';
  s.org.resources.set(id, { webresourceid: id, name: SCRIPT, content: base64('var Old = {};'), publishedContent: base64('var Old = {};') });
  openUnconfirmedWebResources({ workspaceDir: s.dir, environment: s.org.origin }).note(SCRIPT, id);
  const stale = s.org.intercept((c) => namesWebResource(c), () => ({ status: 204, headers: {}, body: null }));
  const run = await s.build(spec());
  stale();
  assert.equal(run.halt && run.halt.code, 'WEB_RESOURCE_UNVERIFIED', 'the read-back found the published content is not what was written');
  assert.match(run.halt.message, /the published content is not what was sent/);
  assert.equal(retryPolicyFor(run.halt), RETRY.SERVICE, 'with no failure behind it, the build runs again');
  assert.equal(openUnconfirmedWebResources({ workspaceDir: s.dir, environment: s.org.origin }).idOf(SCRIPT), id, 'still recorded');
  const quiet = await s.build(spec());
  assert.ok(quiet.outcome && quiet.outcome.ok, String(quiet.halt && quiet.halt.message));
  assert.equal(s.row(SCRIPT).publishedContent, base64(SCRIPT_CODE));
  assert.equal(s.org.calls.filter((c) => c.method === 'POST' && c.path === '/webresourceset').length, 0, 'never created');
});

test('the build\'s own re-run of the halt writes it again by id in the same invocation — the record carries the row from one attempt to the next', async () => {
  const s = scenario();
  refuseWebResourcePublishes(s.org);
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(s.dir), instanceUrl: s.org.origin, httpClient: s.org.httpClient });
  await sdk.initWorkspace();
  const result = await buildModelApp(spec(), { apply: true, publish: true, maxRetries: 3, retryDelayMs: 0, appDir: s.dir, workspaceDir: s.dir }, {
    sdk,
    warn: (w) => s.warnings.push(String(w)),
    runBuild: (runSpec, options) => runSdkBuild(runSpec, { ...options, phases: ['web-resources'], env: s.org.origin }),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(writesOf(s.org.calls), ['POST /webresourceset', 'POST /PublishXml webresource', 'POST /AddSolutionComponent web resource', 'PATCH /webresourceset(id)', 'POST /PublishXml webresource', 'POST /AddSolutionComponent web resource'], 'one create; the second attempt wrote it again by id');
  assert.equal(s.row(SCRIPT).publishedContent, base64(SCRIPT_CODE));
});

// Two builds that share the workspace recover the same row. A writes it again by its recorded id and verifies the write; while A waits for the answer
// to its membership add, B writes the same row again from a newer spec, the lock refuses B's publish, and B records its unconfirmed write — under the
// same id, since it is the same row. A's clear comes after that: it must take only the entry A verified, so that the next build writes B's content again
// by id instead of reusing the row with A's content published.
//
// A build of this release can no longer run inside another of the same app and workspace: the build lease (lib/app-operation-lease.js) refuses it
// before it writes anything. The record's revisions are still what guards against a writer the lease does not hold back — a build of an earlier
// release, which takes no build lease — so B runs here with A's lease, which an apply borrows when it is handed it, and so runs beside A as such a
// writer would.
test('a recovery whose membership add is answered after another build recorded a later, unconfirmed write of the same row leaves that record: the next build writes the newer content again by id', async () => {
  const s = scenario();
  refuseWebResourcePublishes(s.org);
  await s.build(spec());
  const id = s.row(SCRIPT).webresourceid;
  const NEWER = 'var Form = { onLoad: function () { return 2; } };';
  let other;
  let lease;
  const stop = s.org.intercept((c) => c.method === 'POST' && c.path === '/AddSolutionComponent' && String(c.body.ComponentId).toLowerCase() === id, async (c) => {
    stop();
    refuseWebResourcePublishes(s.org);
    other = await s.build(spec([{ name: SCRIPT, type: 'js', content: NEWER }]), { buildLease: lease });
    return s.org.fake.httpClient.post(`${s.org.origin}/api/data/v9.2${c.path}`, c.body);
  });
  const recovered = await withAppBuildLease({ workspaceDir: s.dir, appUniqueName: appUniqueName(spec()) }, (held) => { lease = held; return s.build(spec(), { buildLease: held }); });
  assert.ok(recovered.outcome && recovered.outcome.ok, String(recovered.halt && recovered.halt.message));
  assert.ok(other && other.halt, 'the other build ran while A waited for its add, and stopped');
  assert.equal(other.halt.code, 'WEB_RESOURCE_UNVERIFIED', 'its write of the same row unconfirmed');
  assert.equal(openUnconfirmedWebResources({ workspaceDir: s.dir, environment: s.org.origin }).idOf(SCRIPT), id, 'A\'s clear left the record of that later write');
  assert.equal(s.row(SCRIPT).publishedContent, base64(SCRIPT_CODE), 'what is published is still what A verified');
  const next = await s.build(spec([{ name: SCRIPT, type: 'js', content: NEWER }]));
  assert.ok(next.outcome && next.outcome.ok, String(next.halt && next.halt.message));
  assert.deepEqual(writesOf(next.calls), ['PATCH /webresourceset(id)', 'POST /PublishXml webresource', 'POST /AddSolutionComponent web resource'], 'the next build writes the row again by id');
  assert.equal(s.row(SCRIPT).publishedContent, base64(NEWER), 'and what is published is the newer content');
  assert.equal(fs.existsSync(unconfirmedRecordPath(s.dir, s.org.origin)), false, 'confirmed, the record is gone');
});

test('a web resource of the name that this build did not write — or whose write it confirmed — is reused untouched, as before: not written, not added', async () => {
  const s = scenario();
  // Another maker's row, published: it is in the plain read by name.
  const theirs = '33333333-cccc-4ccc-8ccc-333333333333';
  s.org.resources.set(theirs, { webresourceid: theirs, name: SCRIPT, content: base64('var Theirs = {};'), publishedContent: base64('var Theirs = {};') });
  const run = await s.build(spec());
  assert.ok(run.outcome && run.outcome.ok);
  assert.deepEqual(writesOf(run.calls), [], 'not one write');
  assert.equal(s.org.resources.get(theirs).publishedContent, base64('var Theirs = {};'), 'their content stands');
  assert.equal(run.outcome.created.webResources[SCRIPT], theirs, 'and it is the one the build uses');
});

test('a row the record names that is gone by the next run is created again, as on a first build — and the record of it is replaced', async () => {
  const s = scenario();
  refuseWebResourcePublishes(s.org);
  await s.build(spec());
  const gone = s.row(SCRIPT).webresourceid;
  s.org.resources.delete(gone);
  const next = await s.build(spec());
  assert.ok(next.outcome && next.outcome.ok, String(next.halt && next.halt.message));
  assert.deepEqual(writesOf(next.calls), ['PATCH /webresourceset(id)', 'POST /webresourceset', 'POST /PublishXml webresource', 'POST /AddSolutionComponent web resource'], 'the write by id found nothing (404), so it was created');
  assert.notEqual(s.row(SCRIPT).webresourceid, gone);
  assert.equal(fs.existsSync(unconfirmedRecordPath(s.dir, s.org.origin)), false);
});

test('without a workspace nothing is recorded, and the halt requires recovery by the known id instead of an automatic phase replay', async () => {
  const s = scenario();
  refuseWebResourcePublishes(s.org);
  const run = await s.build(spec(), { workspaceDir: null });
  assert.equal(run.halt && run.halt.code, 'WEB_RESOURCE_UNVERIFIED');
  assert.match(run.halt.message, /this build added it to the solution, but could not save its local recovery record\. Its publication is UNCONFIRMED, not lost/);
  assert.match(run.halt.message, /will not automatically retry it without that record/);
  assert.deepEqual(fs.readdirSync(s.dir).filter((f) => f.startsWith(PREFIX)), []);
});

test('a write whose receipt cannot be saved is not automatically replayed, whether no workspace was supplied or the receipt path is blocked', async () => {
  for (const blocked of [false, true]) {
    const s = scenario();
    if (blocked) fs.mkdirSync(unconfirmedRecordPath(s.dir, s.org.origin));
    refuseWebResourcePublishes(s.org);
    const first = await s.build(spec(), blocked ? {} : { workspaceDir: null });
    assert.equal(first.halt && first.halt.code, 'WEB_RESOURCE_UNVERIFIED');
    assert.equal(isTransientHalt(first.halt), false, 'without durable identity a phase replay could create the same name again');
    if (blocked) {
      assert.match(first.halt.message, /could not save.*record/i);
      assert.doesNotMatch(first.halt.message, /had no workspace/);
    }
    assert.equal(added(first.calls, s.row(SCRIPT).webresourceid).length, 1, 'failed persistence does not skip solution membership');
  }
});

test('the solution add refused beside the unconfirmed publish: the halt says so, and the run that follows adds it', async () => {
  const s = scenario();
  refuseWebResourcePublishes(s.org);
  const stop = s.org.intercept((c) => c.method === 'POST' && c.path === '/AddSolutionComponent', () => ({ status: 429, headers: {}, body: { error: LOCK } }));
  const first = await s.build(spec());
  stop();
  assert.match(first.halt.message, /this build recorded the row as its own and could not add it to the solution \(.*429.*; a run again adds it\)/);
  const id = s.row(SCRIPT).webresourceid;
  const next = await s.build(spec());
  assert.ok(next.outcome && next.outcome.ok);
  assert.equal(added(next.calls, id).length, 1);
});

test('a solution-add 404 after a verified recovery does not retire the resource receipt or create the name again', async () => {
  const s = scenario();
  refuseWebResourcePublishes(s.org);
  await s.build(spec());
  const id = s.row(SCRIPT).webresourceid;
  const refuseAdd = s.org.intercept((c) => c.method === 'POST' && c.path === '/AddSolutionComponent', () => ({ status: 404, headers: {}, body: { error: { message: 'solution was not found' } } }));
  const next = await s.build(spec());
  refuseAdd();
  assert.equal(next.halt && next.halt.code, 'CONNECTION_ERROR');
  assert.equal(openUnconfirmedWebResources({ workspaceDir: s.dir, environment: s.org.origin }).idOf(SCRIPT), id);
  assert.equal(s.org.calls.filter((c) => c.method === 'POST' && c.path === '/webresourceset').length, 1, 'a membership failure cannot justify another create');
  const final = await s.build(spec());
  assert.ok(final.outcome && final.outcome.ok);
  assert.equal(added(final.calls, id).length, 1);
});

test('a permanent solution-add refusal stops automatic replay even when publication was refused transiently', async () => {
  const s = scenario();
  refuseWebResourcePublishes(s.org);
  s.org.intercept((c) => c.method === 'POST' && c.path === '/AddSolutionComponent', () => ({ status: 403, headers: {}, body: { error: { message: 'missing solution component privilege' } } }));
  const first = await s.build(spec());
  assert.equal(first.halt && first.halt.code, 'WEB_RESOURCE_UNVERIFIED');
  assert.equal(retryPolicyFor(first.halt), RETRY.NEVER);
  assert.match(first.halt.message, /could not add it to the solution/);
  assert.equal(openUnconfirmedWebResources({ workspaceDir: s.dir, environment: s.org.origin }).idOf(SCRIPT), s.row(SCRIPT).webresourceid);
});

// --- the generated app icon --------------------------------------------------------------------------------------------------------------------------------

const APP_SPEC = () => ({
  ...spec([]),
  appShell: { areas: [{ label: 'Main', groups: [{ label: 'Records', subAreas: [{ entity: 'contoso_item', title: 'Items' }] }] }] },
});
const ICON = 'contoso_publishreview_icon';

test('the generated app icon whose publish the lock refuses: the app step stops naming it, the icon is in the solution and recorded — and the next run writes it again by id and builds the app with it', async () => {
  const s = scenario();
  // An environment with no icon of that name yet (the fake answers one by default, as for an app built before).
  const noIcon = s.org.intercept((c) => c.method === 'GET' && /^\/webresources(et)?\?/.test(c.path) && c.path.includes('_icon') && !s.row(ICON), () => ({ status: 200, headers: {}, body: { value: [] } }));
  refuseWebResourcePublishes(s.org);
  const first = await s.build(APP_SPEC(), { phases: ['app-shell'] });
  noIcon();
  assert.equal(first.halt && first.halt.code, 'WEB_RESOURCE_UNVERIFIED', String(first.halt && first.halt.message));
  assert.equal(first.halt.phase, 'app-shell');
  const id = s.row(ICON).webresourceid;
  assert.match(first.halt.message, new RegExp(`'${ICON}' \\(${id}\\)`));
  assert.match(first.halt.message, /Its publication is UNCONFIRMED, not lost: run the build again — it writes the content again by that id, publishes it and reads it back \(the call the message names is made for you\)\.$/, 'the icon is written again whatever was published: the stop promises the write');
  assert.equal(added(first.calls, id).length, 1, 'in the solution');
  assert.equal(s.org.appId(), undefined, 'the app is not written over an icon that is not confirmed');
  const next = await s.build(APP_SPEC(), { phases: ['app-shell'] });
  assert.ok(next.outcome && next.outcome.ok, String(next.halt && next.halt.message));
  assert.equal(s.org.calls.filter((c) => c.method === 'POST' && c.path === '/webresourceset').length, 1, 'the icon is never created again');
  assert.ok(next.calls.some((c) => c.method === 'PATCH' && c.path === `/webresourceset(${id})`), 'it is written again by id');
  assert.equal(next.outcome.created.webResources[ICON], id);
  const app = s.org.calls.find((c) => c.method === 'POST' && /^\/appmodules(\?|$)/.test(c.path));
  assert.ok(app, 'and the app is created');
  assert.equal(String(app.body.webresourceid).toLowerCase(), id, 'with that icon');
  assert.equal(fs.existsSync(unconfirmedRecordPath(s.dir, s.org.origin)), false);
});

test('the generated icon recovers by id inside the build retry loop without creating the app or icon twice', async () => {
  const s = scenario();
  s.org.intercept((c) => c.method === 'GET' && /^\/webresources(et)?\?/.test(c.path) && c.path.includes('_icon') && !s.row(ICON), () => ({ status: 200, headers: {}, body: { value: [] } }));
  refuseWebResourcePublishes(s.org);
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(s.dir), instanceUrl: s.org.origin, httpClient: s.org.httpClient });
  await sdk.initWorkspace();
  const result = await buildModelApp(APP_SPEC(), { apply: true, publish: true, maxRetries: 3, retryDelayMs: 0, appDir: s.dir, workspaceDir: s.dir }, {
    sdk,
    runBuild: (runSpec, options) => runSdkBuild(runSpec, { ...options, phases: ['app-shell'], env: s.org.origin }),
  });
  assert.equal(result.ok, true);
  assert.equal(s.org.calls.filter((c) => c.method === 'POST' && c.path === '/webresourceset').length, 1);
  assert.equal(s.org.calls.filter((c) => c.method === 'POST' && /^\/appmodules(\?|$)/.test(c.path)).length, 1);
  assert.equal(s.row(ICON).publishedContent, s.row(ICON).content);
});

// --- the page manifest -------------------------------------------------------------------------------------------------------------------------------------
//
// The pages go through the REAL page backend over the stateful fake of the page service, as in publish-scope-real-bundle.test.js; the manifest is a web
// resource of the app's fake. The page's identity is the manifest, the page list, and the workspace's creation receipts: what a run after an unconfirmed
// manifest write does is proven here — it binds the page it created by its receipt, creates no second page, and writes the manifest again by id where its
// published copy is not what the run wants, or keeps that copy where it is.
const { makeGenpageSdk } = require('../lib/genpage-sdk.js');
const { FakeGenPageServer, ACCOUNT_TABLE } = require('./helpers/fake-genpage-server.js');
const PAGE_CODE = "import * as React from 'react';\nexport default function Overview() { return <div>Overview</div>; }\n";
const MANIFEST = 'contoso_publishreview_pagemanifest';

function pageScenario(t) {
  const s = scenario();
  const server = new FakeGenPageServer();
  server.serveTable({ ...ACCOUNT_TABLE, logicalName: 'contoso_page_only', schemaName: 'contoso_PageOnly', entitySetName: 'contoso_page_onlys' });
  s.org.fake.seedDefaultViews('contoso_page_only', 'Page Data');
  const pages = makeGenpageSdk(s.org.origin, { httpClient: server.http() });
  const placement = makeGenpageSdk(s.org.origin, { httpClient: s.org.httpClient });
  t.after(async () => { await pages.dispose(); await placement.dispose(); });
  const created = [];
  const backend = {
    enumerateEnv: (...args) => pages.enumerateEnv(...args),
    fileVersions: (...args) => pages.fileVersions(...args),
    projectVersions: (...args) => pages.projectVersions(...args),
    publishedDiffers: (...args) => pages.publishedDiffers(...args),
    read: (...args) => pages.read(...args),
    create: async (options) => {
      const result = await pages.create(options);
      created.push(result.pageId);
      s.org.pages.set(result.pageId, { uxagentprojectid: result.pageId, name: options.name, componentstate: 0 });
      return result;
    },
    update: (...args) => pages.update(...args),
    placeInApp: (appId, options) => placement.placeInApp(appId, options),
  };
  fs.writeFileSync(path.join(s.dir, 'Overview.tsx'), PAGE_CODE);
  fs.writeFileSync(path.join(s.dir, 'Details.tsx'), PAGE_CODE.replace(/Overview/g, 'Details'));
  const pageSpec = ({ details = false } = {}) => {
    const out = APP_SPEC();
    out.schemaVersion = 2;
    out.entities.push({ schemaName: 'contoso_page_only', displayName: 'Page data', existing: true, primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns: [] });
    out.pages = [{ key: 'overview', name: 'Overview', dataSources: ['contoso_page_only'], source: { kind: 'tsx', codeFile: 'Overview.tsx' } }];
    out.appShell.areas[0].groups[0].subAreas.push({ page: 'overview', title: 'Overview' });
    if (details) {
      out.pages.push({ key: 'details', name: 'Details', dataSources: ['contoso_page_only'], source: { kind: 'tsx', codeFile: 'Details.tsx' } });
      out.appShell.areas[0].groups[0].subAreas.push({ page: 'details', title: 'Details' });
    }
    return out;
  };
  const manifest = () => {
    const wr = s.row(MANIFEST);
    return wr && wr.publishedContent ? JSON.parse(Buffer.from(wr.publishedContent, 'base64').toString('utf8')) : null;
  };
  return { ...s, backend, created, pageSpec, manifest, build: (built, options = {}) => s.build(built, { phases: ['app-shell', 'pages', 'publish'], genpage: backend, ...options }) };
}
const manifestCreates = (calls) => calls.filter((c) => c.method === 'POST' && c.path === '/webresourceset' && c.body.name === MANIFEST).length;
const listsPages = (m) => (m && Array.isArray(m.pages) ? m.pages.map((p) => p.pageId).filter(Boolean).sort() : []);

test('a page manifest whose first write the lock refuses: the pages step stops naming it, the manifest is in the solution and recorded; the next run creates no second page and writes the manifest again by id', async (t) => {
  const p = pageScenario(t);
  refuseWebResourcePublishes(p.org);
  const first = await p.build(p.pageSpec());
  assert.equal(first.halt && first.halt.code, 'WEB_RESOURCE_UNVERIFIED', String(first.halt && first.halt.message));
  assert.equal(first.halt.phase, 'pages');
  const id = p.row(MANIFEST).webresourceid;
  assert.match(first.halt.message, new RegExp(`'${MANIFEST}' \\(${id}\\)`));
  assert.equal(p.created.length, 1, 'the page was created');
  assert.equal(added(first.calls, id).length, 1, 'the manifest is in the solution');
  assert.equal(p.manifest(), null, 'and nothing of it is published');
  const next = await p.build(p.pageSpec());
  assert.ok(next.outcome && next.outcome.ok, String(next.halt && next.halt.message));
  assert.equal(p.created.length, 1, 'no second page: the run binds the page it created by its creation receipt');
  assert.equal(manifestCreates(p.org.calls), 1, 'and never creates the manifest\'s name again');
  assert.ok(next.calls.some((c) => c.method === 'PATCH' && c.path === `/webresourceset(${id})`), 'it writes it by the id the record holds — no plain read finds a manifest never published');
  assert.deepEqual(listsPages(p.manifest()), p.created, 'the published manifest names the page');
  assert.equal(fs.existsSync(unconfirmedRecordPath(p.dir, p.org.origin)), false);
});

// What the stop for the manifest says the next build does is what that build does. The manifest is first compared with its PUBLISHED copy
// (persistPageManifest): where that copy already holds the content the build would write it is kept, and otherwise written again by id. Live,
// a manifest created and never published — each of its publishes refused — was read back with that content by the run that followed, and
// kept — so the stop must not promise a write, as it does for the spec's web resources and the generated icon, which are written again
// whatever was published. The fake's plain read answers only a row's published copy; the first case sets it to what the platform answered there.
test('the stop for a page manifest whose publication was not confirmed says the next build keeps a published copy that already holds the content, or writes it again by id — and that build does one or the other', async (t) => {
  const MANIFEST_ADVICE = /Its publication is UNCONFIRMED, not lost: run the build again — it reads the published copy and keeps it if it already holds the content that build would write; otherwise it writes the content again by that id, publishes it and reads it back \(the call the message names is made for you\)\.$/;
  for (const kept of [true, false]) {
    const p = pageScenario(t);
    refuseWebResourcePublishes(p.org);
    const first = await p.build(p.pageSpec());
    assert.equal(first.halt && first.halt.code, 'WEB_RESOURCE_UNVERIFIED', String(first.halt && first.halt.message));
    assert.match(first.halt.message, MANIFEST_ADVICE, 'the manifest\'s stop says what the next build does in either case');
    assert.doesNotMatch(first.halt.message, /run the build again — it writes the content again by that id/, 'and does not promise a write');
    assert.equal(retryPolicyFor(first.halt), RETRY.SERVICE, 'a lock is still the service\'s to clear');
    assert.equal(isTransientHalt(first.halt), true, 'so the build still runs again');
    const row = p.row(MANIFEST);
    assert.equal(added(first.calls, row.webresourceid).length, 1, 'the row is in the solution already');
    if (kept) row.publishedContent = row.content;
    const next = await p.build(p.pageSpec());
    assert.ok(next.outcome && next.outcome.ok, String(next.halt && next.halt.message));
    const manifestWrites = next.calls.filter((c) => c.method !== 'GET' && /^\/webresourceset/.test(c.path));
    if (kept) assert.deepEqual(manifestWrites, [], 'the published copy holds the content: kept, not written');
    else assert.deepEqual(manifestWrites.map((c) => `${c.method} ${c.path}`), [`PATCH /webresourceset(${row.webresourceid})`], 'the published copy does not: written again by id');
    assert.equal(manifestCreates(p.org.calls), 1, 'never created a second time');
    assert.equal(fs.existsSync(unconfirmedRecordPath(p.dir, p.org.origin)), false, 'either way the record is cleared');
    assert.deepEqual(listsPages(p.manifest()), p.created);
  }
});

test('the same, inside one invocation: the build\'s own re-run of the halt binds the page it created, writes the manifest by id and finishes', async (t) => {
  const p = pageScenario(t);
  refuseWebResourcePublishes(p.org);
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(p.dir), instanceUrl: p.org.origin, httpClient: p.org.httpClient });
  await sdk.initWorkspace();
  const result = await buildModelApp(p.pageSpec(), { apply: true, publish: true, maxRetries: 3, retryDelayMs: 0, appDir: p.dir, workspaceDir: p.dir }, {
    sdk,
    warn: (w) => p.warnings.push(String(w)),
    runBuild: (runSpec, options) => runSdkBuild(runSpec, { ...options, phases: ['app-shell', 'pages', 'publish'], env: p.org.origin, genpage: p.backend }),
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors || result.halt));
  assert.equal(p.created.length, 1, 'one page');
  assert.equal(manifestCreates(p.org.calls), 1, 'one create of the manifest');
  assert.deepEqual(listsPages(p.manifest()), p.created);
});

test('a manifest UPDATE whose publish the lock refuses — a second page added: the next run reads the published manifest (the old one), binds the new page by its receipt, and writes the manifest again by the id it read', async (t) => {
  const p = pageScenario(t);
  const first = await p.build(p.pageSpec());
  assert.ok(first.outcome && first.outcome.ok, String(first.halt && first.halt.message));
  const id = p.row(MANIFEST).webresourceid;
  // The publish of the manifest that names the new page — the write made right after its create — is the one the lock refuses.
  let refusals = 1;
  p.org.intercept((c) => namesWebResource(c) && p.created.length === 2 && refusals > 0 && (refusals -= 1, true), lockRefused);
  const second = await p.build(p.pageSpec({ details: true }));
  assert.equal(second.halt && second.halt.code, 'WEB_RESOURCE_UNVERIFIED', String(second.halt && second.halt.message));
  assert.equal(p.created.length, 2, 'the second page was created');
  assert.deepEqual(listsPages(p.manifest()), [p.created[0]], 'the published manifest does not name the new page');
  const third = await p.build(p.pageSpec({ details: true }));
  assert.ok(third.outcome && third.outcome.ok, String(third.halt && third.halt.message));
  assert.equal(p.created.length, 2, 'no third page');
  assert.equal(manifestCreates(p.org.calls), 1, 'one create of the manifest, in three runs');
  assert.ok(third.calls.some((c) => c.method === 'PATCH' && c.path === `/webresourceset(${id})`));
  assert.deepEqual(listsPages(p.manifest()), [...p.created].sort());
  assert.equal(fs.existsSync(unconfirmedRecordPath(p.dir, p.org.origin)), false);
});

test('an unconfirmed manifest update names the manifest and recovers inside one invocation without another page', async (t) => {
  const p = pageScenario(t);
  await p.build(p.pageSpec());
  let left = 1;
  p.org.intercept((c) => namesWebResource(c) && p.created.length === 2 && left > 0 && (left -= 1, true), lockRefused);
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(p.dir), instanceUrl: p.org.origin, httpClient: p.org.httpClient });
  await sdk.initWorkspace();
  const halts = [];
  const result = await buildModelApp(p.pageSpec({ details: true }), { apply: true, publish: true, maxRetries: 3, retryDelayMs: 0, appDir: p.dir, workspaceDir: p.dir }, {
    sdk,
    runBuild: async (runSpec, options) => {
      try { return await runSdkBuild(runSpec, { ...options, phases: ['app-shell', 'pages', 'publish'], env: p.org.origin, genpage: p.backend }); }
      catch (e) { halts.push(e); throw e; }
    },
  });
  assert.equal(result.ok, true);
  assert.equal(halts.length, 1);
  assert.match(halts[0].message, /Web resource 'contoso_publishreview_pagemanifest'/);
  assert.equal(p.created.length, 2);
  assert.equal(manifestCreates(p.org.calls), 1);
  assert.deepEqual(listsPages(p.manifest()), [...p.created].sort());
});

test('a published manifest whose id contradicts the unconfirmed receipt is refused before page work, never overwritten as the build\'s own row', async (t) => {
  const p = pageScenario(t);
  await p.build(p.pageSpec());
  const original = p.row(MANIFEST);
  openUnconfirmedWebResources({ workspaceDir: p.dir, environment: p.org.origin }).note(MANIFEST, original.webresourceid);
  p.org.resources.delete(original.webresourceid);
  p.org.resources.set(ID_B, { ...original, webresourceid: ID_B });
  const next = await p.build(p.pageSpec({ details: true }));
  assert.equal(next.halt && next.halt.code, 'WEB_RESOURCE_IDENTITY_CONFLICT');
  assert.equal(retryPolicyFor(next.halt), RETRY.NEVER);
  assert.equal(p.created.length, 1, 'identity is checked before creating another page');
  assert.ok(!next.calls.some((c) => c.method !== 'GET' && c.path.includes(ID_B)), 'no write or add of the replacement');
  assert.equal(p.org.resources.get(ID_B).content, original.content);
  assert.equal(openUnconfirmedWebResources({ workspaceDir: p.dir, environment: p.org.origin }).idOf(MANIFEST), original.webresourceid);
});

test('a recorded manifest renamed to another resource is refused before page writes even though its old name is absent', async (t) => {
  const p = pageScenario(t);
  refuseWebResourcePublishes(p.org);
  await p.build(p.pageSpec());
  const resource = p.row(MANIFEST);
  resource.name = 'fabrikam_/foreign_manifest.js';
  resource.publishedContent = resource.content;
  const next = await p.build(p.pageSpec({ details: true }));
  assert.equal(next.halt && next.halt.code, 'WEB_RESOURCE_IDENTITY_CONFLICT');
  assert.equal(p.created.length, 1);
  assert.ok(!next.calls.some((c) => c.method === 'PATCH' && c.path.includes(resource.webresourceid)));
  assert.equal(openUnconfirmedWebResources({ workspaceDir: p.dir, environment: p.org.origin }).idOf(MANIFEST), resource.webresourceid);
});

test('an unchanged rebuild of an app with pages writes no manifest, and reads no record file it does not have — the requests are what they were', async (t) => {
  const p = pageScenario(t);
  await p.build(p.pageSpec());
  const again = await p.build(p.pageSpec());
  assert.ok(again.outcome && again.outcome.ok);
  assert.ok(!again.calls.some((c) => c.method !== 'GET' && /webresourceset/.test(c.path)), 'no write of any web resource');
  assert.ok(!again.calls.some((c) => namesWebResource(c)), 'and no publish of one');
});

test('a publish refused for good (403) stops the build once — the row is still recorded and in the solution — and the run after the cause is resolved writes it again by id', async () => {
  const s = scenario();
  const refusal = s.org.intercept((c) => namesWebResource(c), () => ({ status: 403, headers: {}, body: { error: { code: '0x80040220', message: 'Principal user is missing prvPublishCustomizations privilege. Try again later.' } } }));
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(s.dir), instanceUrl: s.org.origin, httpClient: s.org.httpClient });
  await sdk.initWorkspace();
  const halted = await buildModelApp(spec(), { apply: true, publish: true, maxRetries: 3, retryDelayMs: 0, appDir: s.dir, workspaceDir: s.dir }, {
    sdk,
    warn: (w) => s.warnings.push(String(w)),
    runBuild: (runSpec, options) => runSdkBuild(runSpec, { ...options, phases: ['web-resources'], env: s.org.origin }),
  }).then(() => assert.fail('a refused publish is no success'), (e) => e);
  assert.equal(halted.code, 'WEB_RESOURCE_UNVERIFIED');
  assert.equal(retryPolicyFor(halted), RETRY.NEVER, 'a 403 is a verdict');
  assert.equal(s.org.calls.filter((c) => namesWebResource(c)).length, 1, 'so the build did not run again');
  assert.match(halted.message, /Resolve that failure first/, 'the SDK\u2019s words say to resolve the cause first');
  const id = s.row(SCRIPT).webresourceid;
  assert.equal(added(s.org.calls, id).length, 1, 'the row is in the solution');
  assert.equal(openUnconfirmedWebResources({ workspaceDir: s.dir, environment: s.org.origin }).idOf(SCRIPT), id, 'and recorded');
  refusal();
  const next = await s.build(spec());
  assert.ok(next.outcome && next.outcome.ok, String(next.halt && next.halt.message));
  assert.deepEqual(writesOf(next.calls), ['PATCH /webresourceset(id)', 'POST /PublishXml webresource', 'POST /AddSolutionComponent web resource']);
  assert.equal(s.row(SCRIPT).publishedContent, base64(SCRIPT_CODE));
});
