'use strict';
// The title of a page's entry in an app's navigation is written in the ENVIRONMENT's base language — a title in a language the environment has not provisioned does not
// show — through the REAL vendored SDK, over an environment whose only language is German (1031). `genpage.js add-to-app` reads the language and says so to the backend;
// `genpage-upload.js --add-to-sitemap` is the other way a page enters an app, and it must do the same: the SDK titles an entry in its own default, 1033, when it is told
// nothing, and the upload reported success for an entry the environment's users saw with no title.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeGenpageSdk } = require('../lib/genpage-sdk.js');
const { readMarker } = require('../lib/genpage-base.js');
const { main: upload } = require('../genpage-upload.js');
const { main: verbs } = require('../genpage.js');
const { FakeGenPageServer, INSTANCE, appTransport, APP_ID, APP_EXISTING_PAGE_ID } = require('./helpers/fake-genpage-server.js');

const OTHER = '77777777-7777-4777-8777-777777777777';
const SOURCE = "import * as React from 'react';\nexport default function Page() { return <div>Hallo</div>; }\n";

const folders = [];
test.after(() => { for (const folder of folders) fs.rmSync(folder, { recursive: true, force: true }); });
const tmp = () => { const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-lang-')); folders.push(folder); return folder; };

// An environment whose only language is German, with an app whose navigation is German and names one page.
function germanEnvironment(appOptions) {
  const server = new FakeGenPageServer();
  server.languages = { base: 1031, provisioned: [1031], available: [1031] };
  server.seedPage(APP_EXISTING_PAGE_ID, { name: 'Vorhanden' });
  const app = appTransport(server, appOptions);
  app.state.xml = app.state.xml.replace(/1033/g, '1031');
  app.state.publishedXml = app.state.xml;
  const made = [];
  const makeBackend = () => makeGenpageSdk(INSTANCE, { httpClient: app.http, mkdtempSync: (prefix) => { const dir = fs.mkdtempSync(prefix); made.push(dir); return dir; } });
  return { server, app, makeBackend, made };
}
const emit = (ok, payload) => ({ ok, ...payload });
// The entry of `pageId` in the saved navigation, with the language and text of each of its titles: [['1031', 'Uebersicht']].
function titlesOf(xml, pageId) {
  const entry = new RegExp(`<SubArea\\b[^>]*GenPageId="${pageId}"[^>]*>([\\s\\S]*?)</SubArea>`, 'i').exec(xml);
  assert.ok(entry, `the navigation names page ${pageId}: ${xml}`);
  return [...entry[1].matchAll(/<Title\b[^>]*LCID="(\d+)"[^>]*Title="([^"]*)"/g)].map((m) => [m[1], m[2]]);
}
function uploadArgs(file, extra = []) {
  return ['--env', INSTANCE, '--app-id', APP_ID, '--code-file', file, '--name', 'Uebersicht', '--prompt', 'p', '--agent-message', 'm', '--add-to-sitemap', ...extra];
}
function codeFile() {
  const file = path.join(tmp(), 'page.tsx');
  fs.writeFileSync(file, SOURCE);
  return file;
}

test('REAL BUNDLE: genpage-upload.js --add-to-sitemap titles the new entry in the environment\'s base language — German here — and not in 1033, which the environment has not provisioned', async () => {
  const { app, makeBackend, made } = germanEnvironment();
  const out = await upload(uploadArgs(codeFile()), { makeGenpageSdk: makeBackend, emit });
  assert.strictEqual(out.ok, true, JSON.stringify(out));
  assert.strictEqual(out.addedToSitemap, true);
  assert.deepStrictEqual(titlesOf(app.state.publishedXml, out.pageId), [['1031', 'Uebersicht']], 'the published entry carries its title in 1031 and in no other language');
  assert.deepStrictEqual(titlesOf(app.state.publishedXml, APP_EXISTING_PAGE_ID), [['1031', 'Existing']], 'the entry that was there is as it was');
  for (const dir of made) assert.ok(!fs.existsSync(dir), 'the throwaway workspace is removed before the report');
});

test('REAL BUNDLE: genpage.js add-to-app titles the entry in the same language — the way the upload now does', async () => {
  const { server, app, makeBackend } = germanEnvironment();
  server.seedPage(OTHER, { name: 'Uebersicht' });
  const out = await verbs(['add-to-app', '--env', INSTANCE, '--app-id', APP_ID, '--page-id', OTHER], { makeGenpageSdk: makeBackend, emit, stderr: () => {} });
  assert.strictEqual(out.ok, true, JSON.stringify(out));
  assert.strictEqual(out.languageCode, 1031);
  assert.deepStrictEqual(titlesOf(app.state.publishedXml, OTHER), [['1031', 'Uebersicht']]);
});

test('REAL BUNDLE: a placement the upload could not make because the environment\'s languages could not be read is completed by running it again — and the completion titles the entry in German too', async () => {
  const { server, app, makeBackend } = germanEnvironment();
  const file = codeFile();
  // The page is written and published; the placement then needs the language, and the read of it fails.
  server.failOn = (method, requestPath) => (/^\/organizations\?\$select=languagecode/.test(requestPath) ? 503 : undefined);
  const first = await upload(uploadArgs(file), { makeGenpageSdk: makeBackend, emit });
  assert.strictEqual(first.ok, false, JSON.stringify(first));
  assert.match(first.error, /was created and published, but its placement in app .*'s navigation is unfinished: the environment's base language, which the entry's title is written in, could not be read \(HTTP 503 from .*languagecode.*\); no other language is assumed in its place\. This run changed nothing in the app's navigation\. /);
  assert.match(first.error, /To finish it, run the same command again with --page-id \S+ added and nothing else changed.*node scripts\/genpage\.js add-to-app .*--page-id /, 'the way on is named');
  assert.doesNotMatch(first.error, /NOT added|did not look at|saved navigation/, 'nothing is said about the navigation that this run did not learn');
  assert.ok(!('saved' in first), 'and it is not reported as a placement that was saved: on a first attempt there is no entry to have been');
  assert.ok(first.pageId, 'the id is reported, so the page can be completed');
  assert.deepStrictEqual(server.published, [first.pageId], 'the page is published');
  assert.ok(!app.state.xml.toLowerCase().includes(first.pageId), 'and the navigation was not written with a title in another language');
  assert.strictEqual(readMarker(file).unfinished, 'place');

  // The advice, as given: the same command with --page-id added.
  server.failOn = undefined;
  const second = await upload([...uploadArgs(file), '--page-id', first.pageId], { makeGenpageSdk: makeBackend, emit });
  assert.strictEqual(second.ok, true, JSON.stringify(second));
  assert.strictEqual(second.addedToSitemap, true);
  assert.deepStrictEqual(titlesOf(app.state.publishedXml, first.pageId), [['1031', 'Uebersicht']], 'the completion titled the entry in the base language');
  assert.strictEqual(readMarker(file).unfinished, undefined, 'finished');
});

// The run that COMPLETES a placement reads the language too, and the read can fail when an earlier run has already put the page in the app's saved navigation — its publish was what failed — or even
// in the published one (the app was published by someone else meanwhile). The failed read says nothing about either layer, and the report must not either: not "NOT added", which sends the user to
// add a page the navigation holds. It says what this run knows and did, and the marker keeps the placement unfinished, so the same command completes it once the language can be read.
for (const publishedBeforeRetry of [false, true]) {
  test(`REAL BUNDLE: a language that cannot be read while the upload COMPLETES a placement an earlier run saved does not say the page was NOT added (${publishedBeforeRetry ? 'the app was published meanwhile' : 'the app is still unpublished'})`, async () => {
    const { server, app, makeBackend } = germanEnvironment({ publishFailures: 1 });
    const file = codeFile();
    // The first run writes the page and saves the navigation, and the app's publish fails: the page is in the saved navigation, and the report says so.
    const first = await upload(uploadArgs(file), { makeGenpageSdk: makeBackend, emit });
    assert.strictEqual(first.ok, false, JSON.stringify(first));
    assert.match(first.error, /it is placed in app .*'s saved navigation, but the app's publish is not finished/);
    assert.ok(app.state.xml.toLowerCase().includes(first.pageId), 'the page is in the saved navigation');
    assert.ok(!app.state.publishedXml.toLowerCase().includes(first.pageId), 'and not in the published one');
    assert.strictEqual(readMarker(file).unfinished, 'place');
    if (publishedBeforeRetry) {
      await app.http.post(`${INSTANCE}/api/data/v9.0/PublishXml`, { ParameterXml: `<importexportxml><appmodules><appmodule>${APP_ID}</appmodule></appmodules></importexportxml>` });
      assert.ok(app.state.publishedXml.toLowerCase().includes(first.pageId), 'now it is in both');
    }

    // The documented retry, in an environment whose languages cannot be read: nothing about the app is touched, and what is said is only what is known.
    const before = { xml: app.state.xml, publishedXml: app.state.publishedXml, writes: app.state.writes.length, publishes: app.state.publishAttempts, pages: server.state.projects.size };
    server.failOn = (method, requestPath) => (/^\/organizations\?\$select=languagecode/.test(requestPath) ? 503 : undefined);
    const second = await upload([...uploadArgs(file), '--page-id', first.pageId], { makeGenpageSdk: makeBackend, emit });
    assert.strictEqual(second.ok, false, JSON.stringify(second));
    assert.doesNotMatch(second.error, /NOT added|Add the page to the app navigation in Maker/, 'the page is in the saved navigation: it is not "not added"');
    assert.ok(!('saved' in second), 'nothing is claimed about the saved navigation either: this run did not look at it');
    assert.match(second.error, /was saved and published, but its placement in app .*'s navigation is unfinished: the environment's base language, which the entry's title is written in, could not be read \(HTTP 503 from .*languagecode.*\); no other language is assumed in its place\. This run changed nothing in the app's navigation, and did not look at what an earlier run saved or published there, so the page may already be in it\. /);
    assert.match(second.error, new RegExp(`To finish it, run the same command again with --page-id ${first.pageId} added and nothing else changed.*node scripts/genpage\\.js add-to-app --env \\S+ --app-id ${APP_ID} --page-id ${first.pageId}`));
    assert.strictEqual(second.pageId, first.pageId);
    assert.deepStrictEqual({ xml: app.state.xml, publishedXml: app.state.publishedXml, writes: app.state.writes.length, publishes: app.state.publishAttempts, pages: server.state.projects.size }, before, 'the run that could not read the language changed nothing: no write, no publish, no second page');
    assert.strictEqual(readMarker(file).unfinished, 'place', 'the placement is still unfinished');

    // The language can be read again: the same command finishes it, and the entry is in German in what runs.
    server.failOn = undefined;
    const third = await upload([...uploadArgs(file), '--page-id', first.pageId], { makeGenpageSdk: makeBackend, emit });
    assert.strictEqual(third.ok, true, JSON.stringify(third));
    assert.deepStrictEqual(titlesOf(app.state.publishedXml, first.pageId), [['1031', 'Uebersicht']]);
    assert.strictEqual(readMarker(file).unfinished, undefined, 'finished');
    assert.strictEqual(server.state.projects.size, before.pages, 'and still one page');
  });
}

test('REAL BUNDLE: an upload that only pins the views of its tables — no placement — does not read the environment\'s languages: no title is written', async () => {
  const { server, app, makeBackend } = germanEnvironment();
  const reads = [];
  server.afterRequest = (request) => { if (/languagecode|RetrieveProvisionedLanguages|RetrieveAvailableLanguages/.test(request.path)) reads.push(request.path); };
  const out = await upload(['--env', INSTANCE, '--app-id', APP_ID, '--code-file', codeFile(), '--name', 'Uebersicht', '--prompt', 'p', '--agent-message', 'm'], { makeGenpageSdk: makeBackend, emit });
  assert.strictEqual(out.ok, true, JSON.stringify(out));
  assert.deepStrictEqual(reads, [], 'nothing about the languages was asked');
  assert.deepStrictEqual(app.state.writes, [], 'and the app was not written: no table, no placement');
});
