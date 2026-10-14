'use strict';
// lib/page-publish-records.js — the record a build keeps of the pages it has PUBLISHED, so that a rebuild does not publish a page that is already live. It is a cache: anything that is not a
// clear "yes" reads as "nothing is known to be published", which costs a publish and nothing else, so the reader never throws and the writer's failure is the caller's warning.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readPublishedPages, writePublishedPages, publishedRecordPath, PREFIX } = require('../lib/page-publish-records.js');
const { sha256 } = require('../lib/hash.js');

const ENV = 'https://contoso.crm.dynamics.com';
const OTHER_ENV = 'https://fabrikam.crm.dynamics.com';
const APP = 'contoso_app';
const ONE = '11111111-0000-4000-8000-000000000001';
const TWO = '22222222-0000-4000-8000-000000000002';
const HASH_A = sha256('content a');
const HASH_B = sha256('content b');

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'page-published-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('what was written is what is read: the pages and the content each was published with, for that app and environment', (t) => {
  const dir = workspace(t);
  writePublishedPages(dir, APP, ENV, new Map([[TWO, HASH_B], [ONE, HASH_A]]));
  assert.deepStrictEqual([...readPublishedPages(dir, APP, ENV)], [[ONE, HASH_A], [TWO, HASH_B]]);
  const file = publishedRecordPath(dir, APP, ENV);
  assert.ok(path.basename(file).startsWith(PREFIX) && /\.[0-9a-f]{64}\.json$/.test(file), 'a file of its own, named by the hash of the app and environment');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.endsWith('\n'));
  assert.deepStrictEqual(Object.keys(JSON.parse(text).pages), [ONE, TWO], 'sorted: the same pages are the same bytes, whatever order they were published in');
  assert.deepStrictEqual(Object.keys(JSON.parse(text)).sort(), ['appUniqueName', 'environmentFingerprint', 'pages', 'schemaVersion']);
  assert.deepStrictEqual(fs.readdirSync(dir), [path.basename(file)], 'no temporary file is left beside it');
  assert.ok(!text.includes(ENV), 'it stores a hash of the environment, not its address');
});

test('a write REPLACES the record: a page that is no longer in the map is no longer recorded', (t) => {
  const dir = workspace(t);
  writePublishedPages(dir, APP, ENV, new Map([[ONE, HASH_A], [TWO, HASH_B]]));
  writePublishedPages(dir, APP, ENV, new Map([[TWO, HASH_A]]));
  assert.deepStrictEqual([...readPublishedPages(dir, APP, ENV)], [[TWO, HASH_A]]);
});

test('the record belongs to ONE app in ONE environment — another environment, or another app, in the same folder reads nothing and has a file of its own', (t) => {
  const dir = workspace(t);
  writePublishedPages(dir, APP, ENV, new Map([[ONE, HASH_A]]));
  assert.strictEqual(readPublishedPages(dir, APP, OTHER_ENV).size, 0, 'another environment: its pages are other pages');
  assert.strictEqual(readPublishedPages(dir, 'fabrikam_app', ENV).size, 0, 'another app');
  writePublishedPages(dir, APP, OTHER_ENV, new Map([[TWO, HASH_B]]));
  assert.deepStrictEqual([...readPublishedPages(dir, APP, ENV)], [[ONE, HASH_A]], 'writing another scope leaves this one as it was');
  assert.deepStrictEqual([...readPublishedPages(dir, APP, OTHER_ENV)], [[TWO, HASH_B]]);
  assert.strictEqual(fs.readdirSync(dir).filter((name) => name.startsWith(PREFIX)).length, 2);
  // An app's unique name is case-insensitive in Dataverse, and so is its record; an origin is read by its canonical form (`URL.origin`).
  assert.deepStrictEqual([...readPublishedPages(dir, 'Contoso_App', `${ENV}/`)], [[ONE, HASH_A]]);
});

test('nothing recorded reads as nothing known: no workspace, no folder, no file — and a read never throws', (t) => {
  const dir = workspace(t);
  assert.strictEqual(readPublishedPages(undefined, APP, ENV).size, 0);
  assert.strictEqual(readPublishedPages(path.join(dir, 'never-made'), APP, ENV).size, 0);
  assert.strictEqual(readPublishedPages(dir, APP, ENV).size, 0);
  assert.strictEqual(readPublishedPages(dir, APP, 'not a url').size, 0, 'an environment that is not an origin cannot have a record');
  assert.strictEqual(readPublishedPages(dir, APP, 'http://contoso.crm.dynamics.com').size, 0, 'nor one that is not HTTPS');
  assert.deepStrictEqual(fs.readdirSync(dir), [], 'and reading creates nothing');
});

test('a record that is damaged, of another version or shape, or written for another scope is "nothing is known" — and an entry that is not a page id with a hash is dropped, not the rest', (t) => {
  const dir = workspace(t);
  const file = publishedRecordPath(dir, APP, ENV);
  const fingerprint = sha256(new URL(ENV).origin.toLowerCase());
  const record = (over = {}) => JSON.stringify({ schemaVersion: 1, environmentFingerprint: fingerprint, appUniqueName: APP, pages: { [ONE]: HASH_A }, ...over });
  for (const [what, text] of [
    ['torn', '{"schemaVersion":1,"pages":{'],
    ['empty', ''],
    ['not an object', '[1,2]'],
    ['another schema version', record({ schemaVersion: 2 })],
    ['another environment inside the file', record({ environmentFingerprint: sha256('https://fabrikam.crm.dynamics.com') })],
    ['another app inside the file', record({ appUniqueName: 'fabrikam_app' })],
    ['pages as a list', record({ pages: [ONE] })],
    ['no pages', record({ pages: undefined })],
  ]) {
    fs.writeFileSync(file, text, 'utf8');
    assert.strictEqual(readPublishedPages(dir, APP, ENV).size, 0, what);
  }
  fs.writeFileSync(file, record({ pages: { [ONE]: HASH_A, 'not-a-guid': HASH_B, [TWO]: 'not a hash', '33333333-0000-4000-8000-000000000003': 42 } }), 'utf8');
  assert.deepStrictEqual([...readPublishedPages(dir, APP, ENV)], [[ONE, HASH_A]], 'only the entry that is a page id with a content hash is read');
  fs.writeFileSync(file, record({ pages: { 'ABCDEF12-0000-4000-8000-00000000000A': HASH_A } }), 'utf8');
  assert.strictEqual(readPublishedPages(dir, APP, ENV).size, 0, 'ids are recorded lower case; one that is not was not written by this module');
});

test('a folder, an oversized file or a link in place of the record is not read', (t) => {
  const dir = workspace(t);
  const file = publishedRecordPath(dir, APP, ENV);
  fs.mkdirSync(file);
  assert.strictEqual(readPublishedPages(dir, APP, ENV).size, 0, 'a folder');
  fs.rmdirSync(file);

  // Large, but otherwise a record in good standing: without the size limit it would be read.
  const fingerprint = sha256(new URL(ENV).origin.toLowerCase());
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, environmentFingerprint: fingerprint, appUniqueName: APP, pages: { [ONE]: HASH_A }, pad: 'x'.repeat((1 << 20) + 1) }), 'utf8');
  assert.strictEqual(readPublishedPages(dir, APP, ENV).size, 0, 'a file larger than any record of this kind');
  fs.rmSync(file);

  writePublishedPages(dir, APP, ENV, new Map([[ONE, HASH_A]]));
  const real = path.join(dir, 'real.json');
  fs.renameSync(file, real);
  try { fs.symlinkSync(real, file, 'file'); } catch (e) {
    if (e && (e.code === 'EPERM' || e.code === 'EACCES')) return; // a Windows account that may not make links
    throw e;
  }
  assert.strictEqual(readPublishedPages(dir, APP, ENV).size, 0, 'a link: the record is read only where this module wrote it');
});

test('writing: a non-id or non-hash is not written, the folder is made when it is missing, and a record that cannot be written throws what the write threw', (t) => {
  const dir = workspace(t);
  const inner = path.join(dir, 'a', 'b');
  writePublishedPages(inner, APP, ENV, new Map([[ONE, HASH_A], ['nope', HASH_B], [TWO, 'nope']]));
  assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(publishedRecordPath(inner, APP, ENV), 'utf8')).pages), [ONE], 'only the entry that is a page id with a hash is in the file');
  assert.deepStrictEqual([...readPublishedPages(inner, APP, ENV)], [[ONE, HASH_A]]);

  // The record's name is taken by a folder: the rename onto it fails, no temporary file is left, and the caller — the build — says so once.
  const taken = publishedRecordPath(dir, APP, OTHER_ENV);
  fs.mkdirSync(taken);
  assert.throws(() => writePublishedPages(dir, APP, OTHER_ENV, new Map([[ONE, HASH_A]])));
  assert.deepStrictEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);

  // Not a folder at all.
  const file = path.join(dir, 'a-file');
  fs.writeFileSync(file, 'x');
  assert.throws(() => writePublishedPages(file, APP, ENV, new Map([[ONE, HASH_A]])));
});

test('the page-ownership readers do not see it: a record of what was published is not a receipt, and blocks nothing', (t) => {
  const dir = workspace(t);
  const { readPageOwnership, checkPageOwnershipClearable } = require('../lib/page-ownership-records.js');
  writePublishedPages(dir, APP, ENV, new Map([[ONE, HASH_A]]));
  assert.deepStrictEqual(readPageOwnership(dir, APP, ENV), { created: [], teardown: [] });
  assert.deepStrictEqual(checkPageOwnershipClearable(dir), { ok: true }, 'it keeps --clear-workspace from clearing nothing');
});
