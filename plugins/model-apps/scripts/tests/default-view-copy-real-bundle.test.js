'use strict';
// The default views of a table read while the table is not yet in the server's metadata cache.
//
// Measured live, on the first build of a fresh table: the build's read of a default view
// (`savedqueries(<id>)/Microsoft.Dynamics.CRM.RetrieveUnpublished()`) answered `"returnedtypecode": "none"`, so the SDK's
// copy of the view named no table, and the save of the new columns sent `returnedtypecode: "none"` back, which Dataverse
// refuses: 400 0x80040203 "Saved Query cannot have returnedTypeCode of 0 and a non null fetchXml". The copy was then dirty,
// and the SDK keeps a dirty copy on a plain fetch while the server's etag has not moved, so every retry and every later run
// sent the same copy and was refused the same way, while the server had long answered the right table.
//
// These tests drive the REAL vendored SDK, through the CLI's retry loop, against the stateful fake Dataverse
// (helpers/fake-dataverse.js) with that lag modelled on the wire: the first reads of a default view answer no table, and a
// save that names none is refused. Every test name starts "default view copy:".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../vendor/cds-maker-sdk.cjs');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { inOwnFolder } = require('./helpers/own-app-folder.js');
const { runSdkBuild: runSdkBuildInPlace } = require('../lib/sdk-build.js');
const { buildModelApp: buildModelAppInPlace } = require('../build-model-app.js');
const { createFakeDataverse } = require('./helpers/fake-dataverse.js');

const buildModelApp = inOwnFolder(buildModelAppInPlace);
const runSdkBuild = inOwnFolder(runSdkBuildInPlace);

const TABLE = 'new_ticket';
const NO_TABLE_WORDS = 'Saved Query cannot have returnedTypeCode of 0 and a non null fetchXml';
const READ_OF_ONE_VIEW = /\/savedqueries\(([0-9a-f-]{36})\)\/Microsoft\.Dynamics\.CRM\.RetrieveUnpublished\(\)/i;
const SAVE_OF_ONE_VIEW = /\/savedqueries\(([0-9a-f-]{36})\)/i;

const spec = () => ({
  $schemaVersion: '1.0',
  solution: { uniqueName: 'ContosoSD', displayName: 'Contoso SD', publisherPrefix: 'new' },
  app: { name: 'Support Desk', uniqueName: 'new_supportdesk' },
  entities: [
    { schemaName: TABLE, displayName: 'Ticket', pluralName: 'Tickets', enrichDefaultViews: true,
      primaryAttribute: { schemaName: 'new_name', displayName: 'Name' },
      columns: [{ schemaName: 'new_code', displayName: 'Code', type: 'Text' }, { schemaName: 'new_area', displayName: 'Area', type: 'Text' }] },
  ],
  views: [],
  forms: [],
  charts: [],
});

// The fake environment with the table's platform-made "Active Tickets" / "Inactive Tickets" pair, and the lag on the wire:
//   - the first `noTableReads` reads of a default view, counted across both views and all attempts, answer it as the server
//     did live: the row with `"returnedtypecode": "none"` and its fetchxml still naming `<entity name="new_ticket">`;
//   - a save whose body names no table is refused as the server did: 400 { error: { code: '0x80040203', message: NO_TABLE_WORDS } };
//   - `refuseSaves` more saves are refused with the same answer whatever they carry: the server lagging behind a correct request,
//     the case the earlier retry was written for.
// `saves` lists every PATCH of a view that reached the wire, with the table its body named.
function environment({ noTableReads = 0, refuseSaves = 0 } = {}) {
  const fake = createFakeDataverse({ entities: { [TABLE]: { attributes: { new_name: 'String', new_code: 'String', new_area: 'String' } } } });
  fake.seedDefaultViews(TABLE, 'Tickets');
  let laggingReads = noTableReads;
  let refused = refuseSaves;
  const saves = [];
  const base = fake.httpClient;
  const httpClient = {
    ...base,
    get: async (url, options) => {
      const answer = await base.get(url, options);
      if (laggingReads > 0 && READ_OF_ONE_VIEW.test(url) && answer.status === 200) {
        laggingReads -= 1;
        return { ...answer, body: { ...answer.body, returnedtypecode: 'none' } };
      }
      return answer;
    },
    patch: async (url, body, options) => {
      const view = SAVE_OF_ONE_VIEW.exec(url);
      if (view) {
        saves.push({ id: view[1].toLowerCase(), returnedtypecode: body && body.returnedtypecode });
        const namesNone = body && Object.prototype.hasOwnProperty.call(body, 'returnedtypecode') && body.returnedtypecode !== TABLE;
        if (namesNone || refused > 0) {
          if (!namesNone) refused -= 1;
          fake.requests.push({ method: 'PATCH', path: new URL(url).pathname.replace(/^.*\/api\/data\/v[\d.]+/, ''), refused: true });
          return { status: 400, headers: {}, body: { error: { code: '0x80040203', message: NO_TABLE_WORDS } } };
        }
      }
      return base.patch(url, body, options);
    },
  };
  const views = () => fake.rows('savedqueries').map((row) => row.data);
  return { fake, httpClient, saves, views, setLaggingReads: (n) => { laggingReads = n; } };
}

const sdkOver = async (env, dir) => {
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: 'https://contoso.crm.dynamics.com', httpClient: env.httpClient });
  await sdk.initWorkspace();
  return sdk;
};

// One invocation of the CLI (`build --apply`, the views phase only), with the CLI's own retry loop: three retries at most, so at
// most four attempts. `created` says whether this invocation created the table (an attempt's acknowledged create puts it in
// `createdTables`, which every later attempt shares).
async function invoke(env, dir, { created }) {
  const sdk = await sdkOver(env, dir);
  const events = [];
  const journal = { path: 'x', record: (e) => events.push(e), close: () => {} };
  let attempts = 0;
  const runBuild = (s, o) => {
    attempts += 1;
    if (created) o.createdTables.add(TABLE);
    return runSdkBuildInPlace(s, { ...o, phases: ['views'] });
  };
  let result = null;
  let halt = null;
  try {
    result = await buildModelApp(spec(), { apply: true, env: 'https://x', retryDelayMs: 0 }, { sdk, journal, runBuild, log: () => {}, warn: () => {} });
  } catch (err) { halt = err; }
  return { result, halt, attempts, retries: events.filter((e) => e.status === 'retry').length, sdk };
}

const defaultViewIds = (env) => env.views().filter((v) => /^(Active|Inactive) Tickets$/.test(v.name)).map((v) => v.savedqueryid.toLowerCase());
const columnsOf = (layoutxml) => [...String(layoutxml).matchAll(/<cell name="([^"]+)"/g)].map((m) => m[1]);

test('default view copy: on a table this invocation created, a view read with no table is never sent, and the next attempt reads it again and saves it with its table', async () => {
  for (const noTableReads of [1, 2, 3]) {
    const env = environment({ noTableReads });
    const run = await invoke(env, makeTempDir('view-copy-'), { created: true });
    assert.equal(run.halt, null, `${noTableReads}: no halt (${run.halt && run.halt.message})`);
    assert.equal(run.result && run.result.ok, true, `${noTableReads}: the build completed`);
    assert.deepEqual(env.saves.filter((s) => s.returnedtypecode !== TABLE), [], `${noTableReads}: no save that names no table was sent: ${JSON.stringify(env.saves)}`);
    assert.equal(env.saves.length, 2, `${noTableReads}: one save per default view, each sent once: ${JSON.stringify(env.saves)}`);
    assert.ok(run.attempts <= 4, `${noTableReads}: within the CLI's bound (${run.attempts} attempts)`);
    assert.equal(run.retries, noTableReads, `${noTableReads}: one retry per read that answered no table`);
    for (const v of env.views().filter((x) => defaultViewIds(env).includes(x.savedqueryid.toLowerCase()))) {
      assert.equal(v.returnedtypecode, TABLE, `${v.name} still names its table`);
      assert.deepEqual(columnsOf(v.layoutxml).slice(0, 3), ['new_name', 'new_code', 'new_area'], `${v.name} was enriched: ${v.layoutxml}`);
    }
  }
});

// The live sequence end to end: the first build of the table during the lag, the CLI's later attempts in the same invocation, then
// a plain run again on the same workspace once the server answers the table. The build never edits a copy that names no table, so
// what the stopped invocation leaves is a CLEAN copy, which the next run replaces and saves with no file deleted by hand.
test('default view copy: a table whose views never resolve stops after the CLI\'s three retries with nothing sent, and a plain run again recovers once the server answers the table', async () => {
  const env = environment({ noTableReads: 100 });
  const dir = makeTempDir('view-copy-');
  const run = await invoke(env, dir, { created: true });
  assert.ok(run.halt || (run.result && run.result.ok === false), 'the build stopped');
  const halt = run.halt;
  assert.equal(halt && halt.code, 'default-view-table-unresolved', `the stop says why: ${halt && halt.message}`);
  assert.match(String(halt.message), /returnedtypecode "none", so it was not edited and nothing was sent/);
  assert.equal(run.retries, 3, 'three retries, then the halt');
  assert.equal(run.attempts, 4);
  assert.deepEqual(env.saves, [], 'no save was sent at all');
  const left = (await run.sdk.listArtifacts('view')).filter((a) => defaultViewIds(env).includes(a.id.toLowerCase()));
  assert.ok(left.length >= 1, 'the stopped run left a copy of the view it read');
  assert.deepEqual(left.map((a) => [a.entityLogicalName, a.isDirty]), left.map(() => ['none', false]), 'the copy it left names no table and holds nothing of its own');
  env.setLaggingReads(0);
  const again = await invoke(env, dir, { created: false });
  assert.equal(again.halt, null, again.halt && again.halt.message);
  assert.equal(again.retries, 0);
  assert.deepEqual(env.saves.map((s) => s.returnedtypecode), [TABLE, TABLE], 'each view saved once, naming its table');
});
test('default view copy: the server refusing a save that names the table is still the lag it was on a table this invocation created, and the resend succeeds', async () => {
  const env = environment({ refuseSaves: 1 });
  const run = await invoke(env, makeTempDir('view-copy-'), { created: true });
  assert.equal(run.halt, null, run.halt && run.halt.message);
  assert.equal(run.retries, 1);
  assert.equal(env.saves.length, 3, 'the refused save, then one save of each view');
  assert.deepEqual(env.saves.map((s) => s.returnedtypecode), [TABLE, TABLE, TABLE], 'every save named the table');
});

test('default view copy: on a table this invocation did not create, the same read is final, at once, and nothing is sent', async () => {
  const env = environment({ noTableReads: 100 });
  const run = await invoke(env, makeTempDir('view-copy-'), { created: false });
  assert.equal(run.halt && run.halt.code, 'default-view-table-unresolved', run.halt && run.halt.message);
  assert.equal(run.retries, 0, 'no retry');
  assert.equal(run.attempts, 1);
  assert.deepEqual(env.saves, []);
});

// The SDK's copy of a default view read during the lag ("Active Tickets"), in a workspace of its own; the lag is over when this returns.
//   - by default the copy is what this build leaves: read, never edited (clean);
//   - `stepColumns` writes the step's own new columns into it and does not save them: what a build before the guard left, stopped
//     after the save it was refused;
//   - `edit` ([pointer, value]) is a further change nobody sent, made with the SDK as a maker's would be.
async function poisonedWorkspace(env, { stepColumns = false, edit } = {}) {
  const dir = makeTempDir('view-copy-');
  env.setLaggingReads(100);
  const sdk = await sdkOver(env, dir);
  const id = defaultViewIds(env).find((x) => env.views().find((v) => v.savedqueryid.toLowerCase() === x).name === 'Active Tickets');
  await sdk.fetchArtifact('view', id);
  const copy = await sdk.getArtifact('view', id);
  assert.equal(copy.entityLogicalName, 'none', 'the copy read during the lag names no table');
  if (stepColumns) await sdk.updateElement('view', id, '/columns', [...copy.columns, { ...copy.columns[0], name: 'new_code', id: undefined }].map((c) => Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined))));
  if (edit) await sdk.updateElement('view', id, edit[0], edit[1]);
  const dirty = (await sdk.listArtifacts('view')).find((a) => a.id.toLowerCase() === id).isDirty;
  assert.equal(dirty, Boolean(stepColumns || edit), 'the copy holds an unsent edit exactly when one was made');
  env.setLaggingReads(0);
  return { dir, id };
}

// The bytes of the copy and of the SDK's record of it, as the workspace holds them.
const copyBytes = (dir, id) => [path.join(dir, 'views', `${id}.json`), path.join(dir, '.metadata', 'views', `${id}.meta.json`)].map((f) => fs.readFileSync(f).toString('base64'));

test('default view copy: a later run over a workspace that holds a clean copy naming no table recovers by itself, also once the server\'s row has moved', async () => {
  for (const moved of [false, true]) {
    const env = environment();
    const { dir, id } = await poisonedWorkspace(env);
    if (moved) env.fake.rows('savedqueries').find((row) => row.data.savedqueryid.toLowerCase() === id).version += 1;
    const run = await invoke(env, dir, { created: false });
    assert.equal(run.halt, null, `moved=${moved}: ${run.halt && run.halt.message}`);
    assert.equal(run.retries, 0, `moved=${moved}: the first attempt saved them`);
    assert.deepEqual(env.saves.map((s) => s.returnedtypecode), [TABLE, TABLE], `moved=${moved}: each view saved once, naming its table`);
    const saved = env.views().find((v) => v.savedqueryid.toLowerCase() === id);
    assert.deepEqual(columnsOf(saved.layoutxml).slice(0, 3), ['new_name', 'new_code', 'new_area'], `moved=${moved}: the step's own columns were saved`);
    const copy = await (await sdkOver(env, dir)).diffArtifact('view', id);
    assert.deepEqual(copy.changes, [], `moved=${moved}: the copy is the server's again`);
  }
});

test('default view copy: a copy whose only unsent change is the table it names is replaced, as nothing else can be lost, and saved with its table', async () => {
  const env = environment();
  const dir = makeTempDir('view-copy-');
  const sdk = await sdkOver(env, dir);
  const id = defaultViewIds(env)[0];
  await sdk.fetchArtifact('view', id);
  await sdk.updateElement('view', id, '/entityLogicalName', 'none');
  assert.deepEqual((await sdk.diffArtifact('view', id)).changes.map((c) => c.pointer), ['/entityLogicalName']);
  const run = await invoke(env, dir, { created: false });
  assert.equal(run.halt, null, run.halt && run.halt.message);
  assert.deepEqual(env.saves.map((s) => s.returnedtypecode), [TABLE, TABLE], 'each view saved once, naming its table');
});

// A copy naming no table that also holds a change nobody sent is never replaced, whoever made the change: a diff cannot say whose. The
// step stops before it edits or writes anything, and the copy and its record are kept byte for byte. Each change is tried on the copy
// a build before the guard left (its own columns unsent) and on the clean copy this build leaves. The columns' width and order are a
// maker's values, not the step's; the SDK's next local edit is made to fail, so a copy replaced before that edit would show.
test('default view copy: a copy naming no table that holds any other unsent change is kept byte for byte, and the step stops before it writes anything', async () => {
  const changes = [
    ['the step\'s own columns', null],
    ['a description', ['/description', 'kept by hand']],
    ['a maker\'s column width', ['/columns/0/width', 777]],
    ['a maker\'s column order', ['/columns/0/order', 99]],
  ];
  for (const [label, edit] of changes) {
    for (const stepColumns of edit ? [true, false] : [true]) {
      const what = `${label}${edit && stepColumns ? ' over the step\'s own columns' : ''}`;
      const env = environment();
      const { dir, id } = await poisonedWorkspace(env, { stepColumns, edit });
      const sdk = await sdkOver(env, dir);
      const before = copyBytes(dir, id);
      const original = await sdk.getArtifact('view', id);
      sdk.updateElement = async () => { throw Object.assign(new Error('the next local edit could not be written'), { code: 'local-edit-failed', transient: false }); };
      const mark = env.fake.mark();
      const halt = await runSdkBuild(spec(), { sdk, apply: true, phases: ['views'] }).then(() => null, (e) => e);
      assert.ok(halt, `${what}: the build stopped`);
      assert.equal(halt.code, 'workspace-copy-unsent-edits', `${what}: ${halt.message}`);
      assert.match(halt.message, new RegExp(`default view ${id} of ${TABLE}.*the local copy was kept`));
      assert.match(halt.message, /a layout kept on the server survives the next build only with that table's enrichDefaultViews: false, since the build otherwise writes its own columns/);
      assert.deepEqual(env.saves, [], `${what}: nothing was saved`);
      assert.deepEqual(env.fake.writeCounts(mark), {}, `${what}: nothing was written`);
      assert.deepEqual(copyBytes(dir, id), before, `${what}: the copy and its record are kept byte for byte`);
      const kept = await sdk.getArtifact('view', id);
      assert.deepEqual(kept.columns, original.columns, `${what}: the columns are the ones the copy held`);
      assert.equal(kept.description, original.description, `${what}: so is the description`);
      assert.equal(kept.entityLogicalName, 'none', `${what}: the copy was not replaced`);
    }
  }
});
// Every request of the views step of a build whose views are healthy, the first build of the table and an unchanged rebuild alike: the
// lookup of the table's default views, then per view the SDK's fetch (its etag, then the saved layer) and the save; the publish the SDK
// makes of the saved views, with the reads around it by which it checks what it publishes. The guard reads only the workspace, so this
// is the trail of the build before it, request for request.
test('default view copy: a healthy build sends exactly what it did before the guard', async () => {
  const env = environment();
  const dir = makeTempDir('view-copy-');
  const fetchOf = (v) => [`GET /savedqueries(${v})`, `GET /savedqueries(${v})/Microsoft.Dynamics.CRM.RetrieveUnpublished()`];
  const savedLayerOf = (v) => [`GET /savedqueries(${v})/Microsoft.Dynamics.CRM.RetrieveUnpublished()`, `GET /savedqueries(${v})`];
  const expected = [
    'GET /savedqueries',
    ...fetchOf('<active>'), 'PATCH /savedqueries(<active>)',
    ...fetchOf('<inactive>'), 'PATCH /savedqueries(<inactive>)',
    ...savedLayerOf('<active>'), ...savedLayerOf('<inactive>'),
    'POST /PublishXml',
    ...fetchOf('<active>'), ...fetchOf('<inactive>'),
  ];
  for (const pass of ['first build', 'unchanged rebuild']) {
    const mark = env.fake.mark();
    const run = await invoke(env, dir, { created: pass === 'first build' });
    assert.equal(run.halt, null, run.halt && run.halt.message);
    const [active, inactive] = defaultViewIds(env);
    const label = (id) => (id.toLowerCase() === active ? '<active>' : id.toLowerCase() === inactive ? '<inactive>' : id);
    const trail = env.fake.since(mark).map((e) => `${e.method} ${e.path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, label)}`);
    assert.deepEqual(trail, expected, `${pass}: ${trail.join('\n')}`);
  }
});