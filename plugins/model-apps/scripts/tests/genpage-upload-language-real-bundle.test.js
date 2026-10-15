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
  assert.match(first.error, /was created and published, but NOT added to app .*'s navigation: the environment's base language, which the entry's title is written in, could not be read \(HTTP 503 from .*languagecode.*\); no other language is assumed in its place/);
  assert.match(first.error, /Add the page to the app navigation with node scripts\/genpage\.js add-to-app .*or run the same command again with --page-id/, 'the way on is named');
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

test('REAL BUNDLE: an upload that only pins the views of its tables — no placement — does not read the environment\'s languages: no title is written', async () => {
  const { server, app, makeBackend } = germanEnvironment();
  const reads = [];
  server.afterRequest = (request) => { if (/languagecode|RetrieveProvisionedLanguages|RetrieveAvailableLanguages/.test(request.path)) reads.push(request.path); };
  const out = await upload(['--env', INSTANCE, '--app-id', APP_ID, '--code-file', codeFile(), '--name', 'Uebersicht', '--prompt', 'p', '--agent-message', 'm'], { makeGenpageSdk: makeBackend, emit });
  assert.strictEqual(out.ok, true, JSON.stringify(out));
  assert.deepStrictEqual(reads, [], 'nothing about the languages was asked');
  assert.deepStrictEqual(app.state.writes, [], 'and the app was not written: no table, no placement');
});
