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

// A resumed create's placement is finished only on PROOF that the app that runs shows the page. The backend publishes the app and reads its published navigation back;
// a read that fails is not an error there (`provedPublished: false`, with a warning: the publish was accepted and may yet take effect), so the upload has to read that
// answer itself. These hold the app's publish as accepted-but-not-taken-effect and refuse the published-navigation read, after each way a create can be left unfinished:
// the marker gone, malformed, still readable (the marker's own `finish` path), and a create whose page publish failed before it was ever placed.
const NAV_PROOF_CASES = ['missing', 'malformed', 'readable', 'never-placed'];
const markerAfter = (file, marker) => {
  if (marker === 'missing' || marker === 'never-placed') fs.unlinkSync(markerPath(file));
  if (marker === 'malformed') fs.writeFileSync(markerPath(file), '{"unfinished":');
};
// The app's publish answers as accepted but its published navigation stays as it was, and the published sitemap read (not the saved one, `RetrieveUnpublished`)
// answers 403 — after the first app publish only, for a create that has not been placed yet (its sitemap token is read before that).
function unprovable(app, { afterPublishOnly }) {
  const post = app.http.post;
  const get = app.http.get;
  const seen = { publishes: 0, proofReads: 0 };
  app.http.post = async (url, body, options) => {
    const appPublish = url.endsWith('/PublishXml') && /<appmodules>/.test((body && body.ParameterXml) || '');
    const before = app.state.publishedXml;
    const answer = await post(url, body, options);
    if (appPublish) { seen.publishes += 1; app.state.publishedXml = before; }
    return answer;
  };
  app.http.get = async (url, options) => {
    const route = new URL(url).pathname;
    if (/\/sitemaps\b/.test(route) && !/RetrieveUnpublished/.test(route) && (!afterPublishOnly || seen.publishes > 0)) {
      seen.proofReads += 1;
      return { status: 403, headers: {}, body: { error: { message: 'Published navigation read denied' } } };
    }
    return get(url, options);
  };
  seen.restore = () => { app.http.post = post; app.http.get = get; };
  return seen;
}

for (const marker of NAV_PROOF_CASES) {
  test(`REAL BUNDLE: a resumed create whose published navigation cannot be read back is NOT finished (${marker} marker) — coded GENPAGE_APP_PUBLISH_UNPROVEN, never "nothing", the marker kept unfinished, and the same command again proves it`, async () => {
    const { server, app, run, file, record } = world();
    if (marker === 'never-placed') server.failOn = (method, p) => (method === 'POST' && /PublishXml/.test(p) ? 400 : undefined);
    else app.state.failures = 1;
    const first = await run();
    server.failOn = undefined;
    assert.strictEqual(first.ok, false, JSON.stringify(first));
    assert.strictEqual(pageEntries(app.state.publishedXml, first.pageId), 0);
    const held = fs.readFileSync(record(), 'utf8');
    markerAfter(file, marker);
    const seen = unprovable(app, { afterPublishOnly: marker === 'never-placed' });
    const second = await run();
    assert.ok(seen.publishes > 0, 'the app was published');
    assert.ok(seen.proofReads > 0, 'its published navigation was asked for');
    assert.strictEqual(second.ok, false, `unreadable proof must not finish the requested placement: ${JSON.stringify(second)}`);
    assert.strictEqual(second.code, 'GENPAGE_APP_PUBLISH_UNPROVEN');
    assert.notStrictEqual(second.outcome, 'nothing', 'the run wrote: it is never "nothing"');
    assert.strictEqual(second.addedToSitemap, undefined);
    assert.strictEqual(second.pageId, first.pageId);
    assert.strictEqual(second.turn && second.turn.intent, first.turn.intent, 'the same turn');
    assert.match(second.error, /same turn id/);
    assert.ok((second.warnings || []).some((w) => /could not be read back/.test(w)), JSON.stringify(second.warnings));
    assert.strictEqual(readMarker(file).unfinished, 'place', 'the marker still says the placement is unfinished');
    assert.strictEqual(fs.readFileSync(record(), 'utf8'), held, 'the turn record is unchanged');
    assert.strictEqual(pageEntries(app.state.publishedXml, first.pageId), 0, 'not live');
    // Once the published navigation can be read (and the publish takes effect), the same command finishes it.
    seen.restore();
    const third = await run();
    assert.strictEqual(third.ok, true, JSON.stringify(third));
    assert.strictEqual(third.pageId, first.pageId);
    assert.strictEqual(pageEntries(app.state.publishedXml, first.pageId), 1, 'live once');
    assert.ok(!readMarker(file).unfinished, 'finished');
  });
}

test('REAL BUNDLE: a resumed create whose READABLE published navigation does not show the page is refused, GENPAGE_APP_PUBLISH_UNPROVEN, the marker kept unfinished', async () => {
  const { app, run, file } = world();
  app.state.failures = 1;
  const first = await run();
  assert.strictEqual(first.ok, false);
  fs.unlinkSync(markerPath(file));
  const post = app.http.post;
  app.http.post = async (url, body, options) => {
    const before = app.state.publishedXml;
    const answer = await post(url, body, options);
    if (url.endsWith('/PublishXml') && /<appmodules>/.test((body && body.ParameterXml) || '')) app.state.publishedXml = before;
    return answer;
  };
  const second = await run();
  assert.strictEqual(second.ok, false, JSON.stringify(second));
  assert.strictEqual(second.code, 'GENPAGE_APP_PUBLISH_UNPROVEN');
  assert.strictEqual(readMarker(file).unfinished, 'place');
});

test('REAL BUNDLE: a resumed create already live with no marker is proven by READING the published navigation — the app is not written or published again', async () => {
  const { app, run, file } = world();
  const first = await run();
  assert.strictEqual(first.ok, true, JSON.stringify(first));
  fs.unlinkSync(markerPath(file));
  const publishes = app.state.publishAttempts;
  const writes = app.state.writes.length;
  let publishedReads = 0;
  const get = app.http.get;
  app.http.get = async (url, options) => {
    if (/\/sitemaps\b/.test(new URL(url).pathname) && !/RetrieveUnpublished/.test(url)) publishedReads += 1;
    return get(url, options);
  };
  const second = await run();
  assert.strictEqual(second.ok, true, JSON.stringify(second));
  assert.ok(publishedReads > 0, 'the published navigation was read');
  assert.strictEqual(app.state.publishAttempts, publishes, 'no app publish');
  assert.strictEqual(app.state.writes.length, writes, 'no app write');
  assert.strictEqual(pageEntries(app.state.publishedXml, first.pageId), 1);
});

test('REAL BUNDLE: a completion-marker store that throws refuses a resumed create before a backend is even made', async () => {
  const { app, run } = world();
  app.state.failures = 1;
  assert.strictEqual((await run()).ok, false);
  let backends = 0;
  const out = await run([], undefined, undefined, {
    base: { ...genpageBase, readMarker() { throw new Error('unavailable'); } },
    makeGenpageSdk() { backends += 1; throw new Error('must never be reached'); },
  });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.code, 'GENPAGE_TURN_STATE_UNAVAILABLE');
  assert.strictEqual(out.outcome, 'nothing');
  assert.strictEqual(backends, 0);
});

test('REAL BUNDLE: without --turn-id, completing a placement whose published navigation cannot be read back reads as it did — finished, with the warning, no code', async () => {
  const { app, run, file } = world();
  app.state.failures = 1;
  const first = await run([], []);
  assert.strictEqual(first.ok, false, JSON.stringify(first));
  assert.strictEqual(readMarker(file).unfinished, 'place');
  unprovable(app, { afterPublishOnly: false });
  const second = await run(['--page-id', first.pageId], []);
  assert.strictEqual(second.ok, true, JSON.stringify(second));
  assert.strictEqual(second.code, undefined);
  assert.strictEqual(second.turn, undefined);
  assert.ok((second.warnings || []).some((w) => /could not be read back/.test(w)), JSON.stringify(second.warnings));
  assert.ok(!readMarker(file).unfinished, 'finished');
});