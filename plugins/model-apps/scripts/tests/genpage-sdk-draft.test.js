'use strict';
// Drafts (`publish: false`) of the page backend (lib/genpage-sdk.js), through the REAL vendored SDK bundle over the stateful fake of the page tables and one app
// (helpers/fake-genpage-server.js). What these pin:
//   - a draft create / update / placement / removal saves and sends NO PublishXml — neither the page's nor the app's — and says so apart from the publish
//     (`saved`, `pendingPublish`, `placementState`); its content hash is `draftFingerprint`, never the `fingerprint` a caller keeps as proof of a publish;
//   - a draft never says more about the app that runs than was read from its published navigation.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { makeGenpageSdk } = require('../lib/genpage-sdk.js');
const { FakeGenPageServer, INSTANCE, ACCOUNT_TABLE, appTransport, APP_ID, APP_EXISTING_PAGE_ID } = require('./helpers/fake-genpage-server.js');
const { SCRIPTS_DIR, productionScripts, scriptLabel, withoutComments } = require('./helpers/production-scripts.js');

const OTHER = '77777777-7777-4777-8777-777777777777';
const SOURCE = "import * as React from 'react';\nexport default function Page() { return <div>Draft</div>; }\n";
const SOURCE_2 = "import * as React from 'react';\nexport default function Page() { return <div>Second</div>; }\n";

async function inWorld(fn) {
  const server = new FakeGenPageServer();
  server.serveTable(ACCOUNT_TABLE);
  server.seedPage(APP_EXISTING_PAGE_ID, { name: 'Existing', config: { dataSources: ['account'], model: '' } });
  server.seedPage(OTHER, { name: 'Other', config: { dataSources: ['account'], model: '' }, prompt: 'Make it' });
  const app = appTransport(server);
  const made = [];
  const backend = (extra = {}) => makeGenpageSdk(INSTANCE, {
    httpClient: app.http,
    ...extra,
    mkdtempSync: (prefix) => { const dir = fs.mkdtempSync(prefix); made.push(dir); return dir; },
  });
  const opened = [];
  const open = (extra) => { const genpage = backend(extra); opened.push(genpage); return genpage; };
  try {
    return await fn({ server, app, genpage: open(), open });
  } finally {
    for (const genpage of opened) await genpage.dispose();
    for (const dir of made) assert.ok(!fs.existsSync(dir), `the throwaway workspace ${dir} is removed by dispose()`);
  }
}

const namesPage = (xml, id) => String(xml || '').toLowerCase().includes(`genpageid="${id}"`);
// Every PublishXml of the run, the page's and the app's: the fake server's own, and the app transport's.
const publishes = (server, app) => [...server.writes().filter((w) => /PublishXml/.test(w)), ...app.state.writes.filter((w) => /PublishXml/.test(String(w)))].length + server.published.length + app.state.publishAttempts;

test('REAL BUNDLE: a draft create and a draft update save the page and send no PublishXml — the result says saved and pending, and its hash is not a published one', async () => {
  await inWorld(async ({ server, app, genpage }) => {
    const created = await genpage.create({ name: 'Draft page', source: SOURCE, dataSources: ['account'], prompt: 'p', publish: false });
    assert.deepStrictEqual([created.publish.kind, created.publish.reason, created.saved, created.pendingPublish], ['skipped', 'draft', true, true]);
    assert.strictEqual(created.fingerprint, undefined, 'a draft gives no fingerprint a caller would keep as proof of a publish');
    assert.match(created.draftFingerprint, /^[0-9a-f]{64}$/);
    assert.ok(server.state.projects.has(created.pageId), 'the page is saved');
    assert.strictEqual(publishes(server, app), 0, 'no PublishXml was sent');

    const updated = await genpage.update(created.pageId, { source: SOURCE_2, prompt: 'second', publish: false });
    assert.deepStrictEqual([updated.publish.kind, updated.publish.reason, updated.saved, updated.pendingPublish, updated.fingerprint], ['skipped', 'draft', true, true, undefined]);
    const again = await genpage.update(created.pageId, { source: SOURCE_2, publish: false });
    assert.deepStrictEqual([again.unchanged, again.publish.reason, again.saved, again.pendingPublish], [true, 'draft', false, null], 'a draft of what the page holds saves nothing and cannot say whether it is live');
    assert.strictEqual(publishes(server, app), 0, 'still no PublishXml');

    // The default is unchanged: the same update without `publish: false` publishes, and only then is there a fingerprint.
    const published = await genpage.update(created.pageId, { source: SOURCE_2 });
    assert.strictEqual(published.publish.kind === 'skipped', false);
    assert.match(published.fingerprint, /^[0-9a-f]{64}$/);
    assert.deepStrictEqual(server.published, [created.pageId]);
  });
});

test('REAL BUNDLE: a draft placement and a draft removal save the app\'s navigation and publish nothing — the app that runs is as it was, and the page stays', async () => {
  await inWorld(async ({ server, app, genpage }) => {
    const placed = await genpage.placeInApp(APP_ID, { pages: [{ pageId: OTHER, title: 'Other' }], publish: false });
    assert.deepStrictEqual([placed.added, placed.appEdited, placed.published, placed.pendingPublish, placed.placementState], [[OTHER], true, false, true, 'saved']);
    assert.ok(namesPage(app.state.xml, OTHER) && !namesPage(app.state.publishedXml, OTHER), 'saved, not published');
    assert.strictEqual(app.state.publishAttempts, 0);

    // Published now (as a maker would), then taken out as a draft: the saved navigation loses it, the published one still names it.
    await genpage.placeInApp(APP_ID, { pages: [{ pageId: OTHER, title: 'Other' }], finishIfUnpublished: true });
    const attempts = app.state.publishAttempts;
    assert.ok(namesPage(app.state.publishedXml, OTHER));
    const removed = await genpage.removeFromApp(APP_ID, OTHER, { publish: false });
    assert.deepStrictEqual([removed.appEdited, removed.published, removed.pendingPublish, removed.placementState, removed.wasInNavigation], [true, false, true, 'saved', true]);
    assert.ok(!namesPage(app.state.xml, OTHER) && namesPage(app.state.publishedXml, OTHER), 'saved without the page; the app that runs still shows it');
    assert.strictEqual(app.state.publishAttempts, attempts, 'the draft removal published nothing');
    assert.ok(server.state.projects.has(OTHER), 'a draft removal keeps the page');
    // The published navigation still names the page, so it cannot be deleted yet.
    await assert.rejects(genpage.delete(OTHER, { allowDestructive: true }), (e) => e.outcome === 'nothing');
    assert.ok(server.state.projects.has(OTHER));

    const nothingToSave = await genpage.removeFromApp(APP_ID, OTHER, { publish: false });
    assert.deepStrictEqual([nothingToSave.appEdited, nothingToSave.published, nothingToSave.pendingPublish], [false, false, true]);
    assert.strictEqual(app.state.publishAttempts, attempts);
  });
});

test('a draft is asked for with false only, and a draft placement cannot also finish a placement or publish before the app\'s write — all refused before anything is read', async () => {
  await inWorld(async ({ server, app, genpage }) => {
    const before = server.requests.length;
    await assert.rejects(genpage.update(OTHER, { source: SOURCE, publish: 'false' }), (e) => e.code === 'GENPAGE_ARGUMENT_INVALID' && e.outcome === 'nothing');
    for (const extra of [{ finish: true }, { finishIfUnpublished: true }, { beforeAppWrite: async () => {} }]) {
      await assert.rejects(genpage.placeInApp(APP_ID, { pages: [{ pageId: OTHER }], publish: false, ...extra }), (e) => e.code === 'GENPAGE_DRAFT_UNSUPPORTED' && e.outcome === 'nothing');
    }
    assert.strictEqual(server.requests.length, before, 'nothing was read');
    assert.deepStrictEqual([app.state.writes, server.writes()], [[], []]);
  });
});

// ── Drafts come only from the page CLI: the build's guarded publish and a draft never meet ──

// The text of every `.<name>(…)` call in `code` (comments already blanked), to its matching parenthesis.
function callsIn(code, name) {
  const calls = [];
  const re = new RegExp(`\\.${name}\\(`, 'g');
  let match;
  while ((match = re.exec(code))) {
    let depth = 0;
    let at = match.index + match[0].length - 1;
    for (; at < code.length; at += 1) {
      if (code[at] === '(') depth += 1;
      else if (code[at] === ')' && (depth -= 1) === 0) break;
    }
    calls.push(code.slice(match.index, at + 1));
  }
  return calls;
}

test('the build never asks for a draft placement: only scripts/genpage.js spells `publish: false` into placeInApp, and the build\'s one placement always hands over beforeAppWrite — which a draft is refused with', () => {
  const drafting = [];
  for (const file of productionScripts()) {
    const code = withoutComments(fs.readFileSync(file, 'utf8'));
    for (const call of callsIn(code, 'placeInApp')) if (/\bpublish\s*:\s*false\b|\bdraft\b/i.test(call)) drafting.push(scriptLabel(file));
  }
  assert.deepStrictEqual(drafting, ['genpage.js'], 'add-to-app --draft is the one placement that asks for a draft');

  const build = withoutComments(fs.readFileSync(path.join(SCRIPTS_DIR, 'lib', 'sdk-build.js'), 'utf8'));
  const placements = callsIn(build, 'placeInApp');
  assert.strictEqual(placements.length, 1, 'the build places through one call (appWriters.placeViews)');
  assert.match(placements[0], /\bbeforeAppWrite\s*:/, 'the build always hands over beforeAppWrite');
  const asks = callsIn(build, 'placeViews');
  assert.ok(asks.length >= 1, 'the build asks for a placement');
  for (const call of asks) assert.doesNotMatch(call, /\bpublish\s*:|\bdraft\b/i, `the build's placement asks for no draft: ${call}`);
});

test('REAL BUNDLE: a draft placement never calls the caller\'s publishApp — the guarded publish is only for a placement that publishes — and no publish rides its answer', async () => {
  await inWorld(async ({ server, app, genpage }) => {
    let asked = 0;
    const publishApp = async () => { asked += 1; return { publish: { kind: 'verified' } }; };
    const placed = await genpage.placeInApp(APP_ID, { pages: [{ pageId: OTHER, title: 'Other' }], publish: false, publishApp });
    assert.deepStrictEqual([placed.added, placed.appEdited, placed.published, placed.pendingPublish, placed.placementState], [[OTHER], true, false, true, 'saved']);
    assert.strictEqual(asked, 0, 'publishApp was never called');
    assert.strictEqual(placed.appPublish, undefined, 'the answer carries no appPublish');
    assert.strictEqual(publishes(server, app), 0, 'nothing was published');
    assert.ok(namesPage(app.state.xml, OTHER) && !namesPage(app.state.publishedXml, OTHER), 'saved, not published');
  });
});

// ── A draft never says more about the app that runs than was read ──

test('REAL BUNDLE: a draft of content the page already holds answers as a draft even when a publish receipt matches — no fingerprint, the draft reason', async () => {
  await inWorld(async ({ server, genpage }) => {
    const published = await genpage.update(OTHER, { source: SOURCE_2 });
    const attempts = server.published.length;
    const draft = await genpage.update(OTHER, { source: SOURCE_2, publish: false, publishedFingerprint: published.fingerprint });
    assert.deepStrictEqual([draft.unchanged, draft.publish.kind, draft.publish.reason, draft.saved, draft.pendingPublish, draft.fingerprint, draft.draftFingerprint], [true, 'skipped', 'draft', false, null, undefined, published.fingerprint]);
    assert.strictEqual(server.published.length, attempts);
  });
});

test('REAL BUNDLE: a draft removal of a page the app that runs never showed does not say that it still shows there — what it says is read from the published navigation', async () => {
  await inWorld(async ({ server, app, genpage }) => {
    await genpage.placeInApp(APP_ID, { pages: [{ pageId: OTHER, title: 'Other' }], publish: false });
    assert.ok(!namesPage(app.state.publishedXml, OTHER));
    const removed = await genpage.removeFromApp(APP_ID, OTHER, { publish: false });
    assert.deepStrictEqual([removed.appEdited, removed.published, removed.pendingPublish, removed.placementState, removed.liveState], [true, false, true, 'saved', 'not-shown']);
    assert.ok(!removed.warnings.some((w) => /still shows in the app that runs|cannot be deleted before then/.test(w)), removed.warnings.join(' | '));
    assert.ok(removed.warnings.some((w) => /the app that runs does not show it either/.test(w)));
    assert.strictEqual(app.state.publishAttempts, 0);

    // Published, then taken out as a draft: now the app that runs does show it, and the answer says so.
    await genpage.placeInApp(APP_ID, { pages: [{ pageId: OTHER, title: 'Other' }], finishIfUnpublished: true });
    const shown = await genpage.removeFromApp(APP_ID, OTHER, { publish: false });
    assert.strictEqual(shown.liveState, 'shown');
    assert.ok(shown.warnings.some((w) => /still shows in the app that runs until the app is published/.test(w)));
    const nothingToSave = await genpage.removeFromApp(APP_ID, OTHER, { publish: false });
    assert.deepStrictEqual([nothingToSave.placementState, nothingToSave.liveState, nothingToSave.pendingPublish], ['unchanged', 'shown', true]);
    assert.ok(server.state.projects.has(OTHER));
  });
});