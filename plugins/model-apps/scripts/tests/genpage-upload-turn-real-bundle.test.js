'use strict';
// genpage-upload.js --turn-id / --app-dir through the REAL vendored SDK: the turn's record decides what a run IS. An upload whose create answered with a page id and did
// not finish is told to run again with --page-id added; under a turn that run is still the create its record names, and it finishes the page with ONE turn in its
// history. Anything else the upload would do differently under the same id is refused with nothing written. Without the flags nothing changes.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeGenpageSdk } = require('../lib/genpage-sdk.js');
const { main: upload } = require('../genpage-upload.js');
const genpageBase = require('../lib/genpage-base.js');
const { readMarker, markerPath } = genpageBase;
const { FakeGenPageServer, INSTANCE, ACCOUNT_TABLE, appTransport, APP_ID, APP_EXISTING_PAGE_ID } = require('./helpers/fake-genpage-server.js');

const TURN = '6f1c2a4e-9b3d-47a1-b85c-0e2f7d914a63';
const SOURCE = "import * as React from 'react';\nexport default function Page() { return <div>Turn</div>; }\n";
const folders = [];
test.after(() => { for (const folder of folders) fs.rmSync(folder, { recursive: true, force: true }); });
const tmp = () => { const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-turn-up-')); folders.push(folder); return folder; };
const emit = (ok, payload) => ({ ok, ...payload });

function world() {
  const server = new FakeGenPageServer();
  server.serveTable(ACCOUNT_TABLE);
  server.seedPage(APP_EXISTING_PAGE_ID, { name: 'Existing' });
  const app = appTransport(server);
  const makeBackend = (env, deps) => makeGenpageSdk(INSTANCE, { ...deps, httpClient: app.http });
  const dir = tmp();
  const file = path.join(dir, 'page.tsx');
  fs.writeFileSync(file, SOURCE);
  const appDir = path.join(dir, 'app');
  fs.mkdirSync(appDir);
  const run = (extra = [], turn = ['--turn-id', TURN, '--app-dir', appDir], change = (a) => a, deps = {}) => upload(change(['--env', INSTANCE, '--app-id', APP_ID, '--code-file', file, '--name', 'Turned', '--prompt', 'p', '--agent-message', 'm', '--data-sources', 'account', '--add-to-sitemap', ...turn, ...extra]), { makeGenpageSdk: makeBackend, emit, reportCompletion: async () => {}, appDir, ...deps });
  const mark = () => ({ writes: server.writes().length, published: server.published.length, pages: server.state.projects.size, xml: app.state.xml });
  const record = () => path.join(appDir, '.maker-workspace', 'turns', `${TURN}.json`);
  return { server, app, run, mark, record, appDir, file };
}
const pageEntries = (xml, pageId) => (xml.match(new RegExp(`GenPageId="${pageId}"`, 'gi')) || []).length;

test('REAL BUNDLE: a create whose publish failed, run again with the returned --page-id under the same turn, is still that create: published and placed, one page, one turn', async () => {
  const { server, app, run, mark, record } = world();
  const pagesBefore = server.state.projects.size;
  server.failOn = (method, p) => (method === 'POST' && /PublishXml/.test(p) ? 400 : undefined);
  const first = await run();
  assert.strictEqual(first.ok, false, JSON.stringify(first));
  assert.match(first.error, /run the same command again with --page-id/);
  assert.ok(first.pageId && first.turn && first.turn.id === TURN, `the failure keeps the page id and the turn: ${JSON.stringify(first)}`);
  assert.ok(fs.existsSync(record()));
  server.failOn = undefined;
  const second = await run(['--page-id', first.pageId]);
  assert.strictEqual(second.ok, true, JSON.stringify(second));
  assert.deepStrictEqual([second.pageId, second.updated, second.addedToSitemap, second.turn.intent], [first.pageId, false, true, first.turn.intent]);
  assert.strictEqual(server.state.projects.size, pagesBefore + 1, 'one page');
  assert.strictEqual(server.messagesOf(first.pageId).length, 2, 'one turn in the page\'s history');
  assert.ok(server.published.includes(first.pageId));
  assert.strictEqual(pageEntries(app.state.publishedXml, first.pageId), 1, 'placed once');
  // The same command again changes nothing more.
  const third = await run(['--page-id', first.pageId]);
  assert.strictEqual(third.ok, true, JSON.stringify(third));
  assert.strictEqual(server.messagesOf(first.pageId).length, 2);
  assert.strictEqual(pageEntries(app.state.publishedXml, first.pageId), 1);
});

test('REAL BUNDLE: a create whose app publish failed after its navigation was saved is finished by the same command run again — with or without the returned --page-id: the app is published, the page is live in it, and only then is the marker cleared', async () => {
  for (const withId of [false, true]) {
    const { server, app, run, file } = world();
    app.state.failures = 1;
    const first = await run();
    assert.strictEqual(first.ok, false, JSON.stringify(first));
    assert.match(first.error, /saved navigation/);
    assert.strictEqual(first.turn.id, TURN);
    assert.deepStrictEqual([pageEntries(app.state.xml, first.pageId), pageEntries(app.state.publishedXml, first.pageId)], [1, 0], 'saved, not live');
    assert.strictEqual(readMarker(file).unfinished, 'place');
    const publishes = app.state.publishAttempts;
    const second = await run(withId ? ['--page-id', first.pageId] : []);
    assert.strictEqual(second.ok, true, JSON.stringify(second));
    assert.deepStrictEqual([second.pageId, second.updated, second.turn.intent], [first.pageId, false, first.turn.intent]);
    assert.ok(app.state.publishAttempts > publishes, `${withId}: the app was published again`);
    assert.strictEqual(pageEntries(app.state.publishedXml, first.pageId), 1, `${withId}: the page is in the navigation that runs`);
    assert.strictEqual(server.messagesOf(first.pageId).length, 2, 'one turn');
    const marker = readMarker(file);
    assert.ok(marker && marker.pageId === first.pageId && !marker.unfinished, `finished, and the marker says so: ${JSON.stringify(marker)}`);
  }
});

test('REAL BUNDLE: a resumed create whose app publish fails again keeps the marker unfinished — a success is never reported for a page the live navigation does not show', async () => {
  const { app, run, file } = world();
  app.state.failures = 2;
  const first = await run();
  assert.strictEqual(first.ok, false);
  const second = await run();
  assert.strictEqual(second.ok, false, JSON.stringify(second));
  assert.strictEqual(second.turn.id, TURN);
  assert.strictEqual(pageEntries(app.state.publishedXml, first.pageId), 0);
  assert.strictEqual(readMarker(file).unfinished, 'place');
});

// The base marker is never the proof that a placement is finished. A resumed create whose marker is gone, malformed, or was never written (its write failed) cannot
// tell from it whether the earlier run left the placement saved and unpublished, so it asks the app: the app is published and the page proven live, or it fails.
const LOST_MARKER = {
  missing: ({ file }) => fs.unlinkSync(markerPath(file)),
  malformed: ({ file }) => fs.writeFileSync(markerPath(file), '{"unfinished":'),
};
for (const [state, lose] of Object.entries(LOST_MARKER)) {
  test(`REAL BUNDLE: a resumed create whose completion marker is ${state} is finished only when the app is published and the page is seen live — the saved navigation is not proof`, async () => {
    const w = world();
    const { server, app, run, file, record } = w;
    app.state.failures = 1;
    const first = await run();
    assert.strictEqual(first.ok, false, JSON.stringify(first));
    assert.deepStrictEqual([pageEntries(app.state.xml, first.pageId), pageEntries(app.state.publishedXml, first.pageId)], [1, 0], 'saved, not live');
    const retained = fs.readFileSync(record(), 'utf8');
    lose(w);
    assert.strictEqual(readMarker(file), null);
    const publishes = app.state.publishAttempts;
    const second = await run();
    assert.strictEqual(second.ok, true, JSON.stringify(second));
    assert.deepStrictEqual([second.pageId, second.updated, second.turn.intent], [first.pageId, false, first.turn.intent]);
    assert.ok(app.state.publishAttempts > publishes, `${state}: the app was published again`);
    assert.strictEqual(pageEntries(app.state.publishedXml, first.pageId), 1, `${state}: the page is in the navigation that runs`);
    assert.strictEqual(server.messagesOf(first.pageId).length, 2, 'one turn');
    assert.strictEqual(fs.readFileSync(record(), 'utf8'), retained, 'the turn record is not rewritten');
    const marker = readMarker(file);
    assert.ok(marker && marker.pageId === first.pageId && !marker.unfinished, `finished, and the marker says so: ${JSON.stringify(marker)}`);
  });
}

test('REAL BUNDLE: a create whose marker could not be written is finished by the same command only once the app is published and the page is seen live', async () => {
  const { app, run, file } = world();
  app.state.failures = 1;
  const refuse = () => { throw Object.assign(new Error('marker write refused'), { code: 'EACCES' }); };
  const first = await run([], undefined, undefined, { base: { ...genpageBase, writeMarker: refuse } });
  assert.strictEqual(first.ok, false, JSON.stringify(first));
  assert.strictEqual(readMarker(file), null);
  assert.match(first.error, /run the same command again with the same turn id/, 'the failure says how to finish it without the marker');
  assert.strictEqual(first.code, 'GENPAGE_APP_PUBLISH_FAILED');
  const publishes = app.state.publishAttempts;
  const second = await run();
  assert.strictEqual(second.ok, true, JSON.stringify(second));
  assert.ok(app.state.publishAttempts > publishes, 'the app was published again');
  assert.strictEqual(pageEntries(app.state.publishedXml, first.pageId), 1);
});

test('REAL BUNDLE: a resumed create with no completion marker whose app publish fails again reports a coded failure — never a success', async () => {
  const { app, run, file } = world();
  app.state.failures = 2;
  const first = await run();
  assert.strictEqual(first.ok, false);
  fs.unlinkSync(markerPath(file));
  const second = await run();
  assert.strictEqual(second.ok, false, JSON.stringify(second));
  assert.strictEqual(second.code, 'GENPAGE_APP_PUBLISH_FAILED');
  assert.strictEqual(second.turn.id, TURN);
  assert.strictEqual(pageEntries(app.state.publishedXml, first.pageId), 0);
  assert.strictEqual(readMarker(file).unfinished, 'place', 'this run recorded what it left unfinished');
});

test('REAL BUNDLE: a completion marker that cannot be read refuses a resumed create with nothing sent, coded GENPAGE_TURN_STATE_UNAVAILABLE; a fresh turn is not affected', async () => {
  const { app, run, mark, file } = world();
  const unreadable = { base: { ...genpageBase, readMarker: () => { throw Object.assign(new Error('completion marker unavailable'), { code: 'EIO' }); } } };
  app.state.failures = 1;
  const first = await run();
  assert.strictEqual(first.ok, false);
  const at = { ...mark(), appPublishes: app.state.publishAttempts };
  const second = await run([], undefined, undefined, unreadable);
  assert.strictEqual(second.ok, false, JSON.stringify(second));
  assert.deepStrictEqual([second.code, second.outcome, second.turnId], ['GENPAGE_TURN_STATE_UNAVAILABLE', 'nothing', TURN]);
  assert.doesNotMatch(second.error, /leave the turn id out|without --turn-id/);
  assert.deepStrictEqual({ ...mark(), appPublishes: app.state.publishAttempts }, at, 'nothing sent');
  assert.strictEqual(readMarker(file).unfinished, 'place');
  // Only a resumed create depends on the marker: the first run of a fresh turn proceeds as it would without one.
  const fresh = world();
  const out = await fresh.run([], undefined, undefined, unreadable);
  assert.strictEqual(out.ok, true, JSON.stringify(out));
  assert.strictEqual(pageEntries(fresh.app.state.publishedXml, out.pageId), 1);
});

test('REAL BUNDLE: without --turn-id a placement failure reads as it did — no code is added to the answer', async () => {
  const { app, run } = world();
  app.state.failures = 1;
  const out = await run([], []);
  assert.strictEqual(out.ok, false, JSON.stringify(out));
  assert.match(out.error, /saved navigation/);
  assert.strictEqual(out.code, undefined);
  assert.strictEqual(out.turn, undefined);
});

test('REAL BUNDLE: a create whose whole answer was lost, run again as it was, resumes the page its record names — one page, one turn, placed', async () => {
  const { server, app, run } = world();
  const pagesBefore = server.state.projects.size;
  server.afterCommit = () => { server.failOn = (method) => (method === 'GET' ? 403 : undefined); throw new Error('Request failed: read ECONNRESET'); };
  const first = await run();
  assert.strictEqual(first.ok, false, JSON.stringify(first));
  assert.strictEqual(first.outcome, 'unknown');
  assert.strictEqual(first.turnId, TURN, 'an unknown outcome names the turn it was made under');
  server.afterCommit = undefined;
  server.failOn = undefined;
  const second = await run();
  assert.strictEqual(second.ok, true, JSON.stringify(second));
  assert.strictEqual(second.pageId, first.pageId);
  assert.strictEqual(server.state.projects.size, pagesBefore + 1);
  assert.strictEqual(server.messagesOf(second.pageId).length, 2);
  assert.strictEqual(pageEntries(app.state.publishedXml, second.pageId), 1);
});

test('REAL BUNDLE: under a bound turn, an upload that would do anything else — no placement, another title, other tables, overwriting, another page — is refused with nothing written', async () => {
  const { run, mark, appDir } = world();
  const made = await run();
  assert.strictEqual(made.ok, true, JSON.stringify(made));
  const at = mark();
  const changed = [
    ['no placement', [], (a) => a.filter((x) => x !== '--add-to-sitemap')],
    ['another title', [], (a) => a.map((x) => (x === 'Turned' ? 'Renamed' : x))],
    ['other tables', [], (a) => a.map((x) => (x === 'account' ? 'contact' : x))],
    ['no app', [], (a) => { const i = a.indexOf('--app-id'); return a.filter((x, j) => j !== i && j !== i + 1 && x !== '--add-to-sitemap'); }],
    ['overwriting a changed deployed page', ['--overwrite-deployed'], undefined],
    ['the update of another page', ['--page-id', APP_EXISTING_PAGE_ID], undefined],
  ];
  for (const [what, extra, change] of changed) {
    const out = await run(extra, undefined, change);
    assert.strictEqual(out.ok, false, `${what}: ${JSON.stringify(out)}`);
    assert.strictEqual(out.code, 'GENPAGE_TURN_ID_REUSED', `${what}: ${JSON.stringify(out)}`);
    assert.strictEqual(out.outcome, 'nothing', what);
    assert.deepStrictEqual(mark(), at, `${what}: nothing written`);
  }
  // --turn-id without --app-dir is a usage error: the turn's record lives in that app folder. (--app-dir alone is the pages lease's folder: see the test below.)
  const out = await run([], ['--turn-id', TURN]);
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /--turn-id and --app-dir go together/);
  assert.deepStrictEqual(mark(), at);
});
test('REAL BUNDLE: under a turn, a base language that cannot be read refuses the upload before anything is written — no page and no turn record', async () => {
  const { server, run, mark, record } = world();
  const at = mark();
  server.failOn = (method, p) => (method === 'GET' && /organizations/.test(p) ? 503 : undefined);
  const out = await run();
  assert.strictEqual(out.ok, false, JSON.stringify(out));
  assert.strictEqual(out.outcome, 'nothing');
  assert.deepStrictEqual(mark(), at);
  assert.ok(!fs.existsSync(record()), 'no record: nothing was bound');
});

test('REAL BUNDLE: without --turn-id the upload is as it was — no turn, no record folder', async () => {
  const { run, appDir } = world();
  const out = await run([], []);
  assert.strictEqual(out.ok, true, JSON.stringify(out));
  assert.strictEqual(out.turn, undefined);
  assert.strictEqual(out.turnId, undefined);
  assert.ok(!fs.existsSync(path.join(appDir, '.maker-workspace', 'turns')), 'no turn store: nothing was bound');
});

test('REAL BUNDLE: --app-dir without --turn-id is the folder of the app pages lease, as it was — an ordinary upload, no turn and no turn store', async () => {
  const { run, appDir } = world();
  const out = await run([], ['--app-dir', appDir], undefined, { appDir: undefined });
  assert.strictEqual(out.ok, true, JSON.stringify(out));
  assert.strictEqual(out.addedToSitemap, true);
  assert.strictEqual(out.turn, undefined);
  assert.strictEqual(out.turnId, undefined);
  assert.ok(fs.existsSync(path.join(appDir, '.maker-workspace')), 'the lease was taken in the folder --app-dir names');
  assert.ok(!fs.existsSync(path.join(appDir, '.maker-workspace', 'turns')), 'no turn store: nothing was bound');
});

