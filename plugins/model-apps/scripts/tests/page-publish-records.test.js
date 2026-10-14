'use strict';
// lib/page-publish-records.js — the record a build keeps of the pages it has PUBLISHED, so that a rebuild does not publish a page that is already live. It is a cache: anything that is not a
// clear "yes" reads as "nothing is known to be published", which costs a publish and nothing else, so the reader never throws and the writer's failure is the caller's warning.
//
// What it records per page: the fingerprint of the content published and the versionnumber of EVERY file row of the page as read right after the publish. A page skips its publish only while
// the file rows read now are exactly those (`sameFileVersions`) — see the module's header for the measured facts, and sdk-build-pages-deploy.test.js for the build's use of it.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readPublishedPages, writePublishedPages, publishedRecordPath, sameFileVersions, PREFIX } = require('../lib/page-publish-records.js');
const { sha256 } = require('../lib/hash.js');

const ENV = 'https://contoso.crm.dynamics.com';
const OTHER_ENV = 'https://fabrikam.crm.dynamics.com';
const APP = 'contoso_app';
const ONE = '11111111-0000-4000-8000-000000000001';
const TWO = '22222222-0000-4000-8000-000000000002';
const ROW_A = 'f0000000-0000-4000-8000-00000000000a';
const ROW_B = 'f0000000-0000-4000-8000-00000000000b';
const HASH_A = sha256('content a');
const HASH_B = sha256('content b');
const files = (a = '1001', b = '1002') => new Map([[ROW_A, a], [ROW_B, b]]);
const entry = (fingerprint, rows = files()) => ({ fingerprint, files: rows });

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'page-published-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('what was written is what is read: the pages, the content each was published with and the versions of its files, for that app and environment', (t) => {
  const dir = workspace(t);
  writePublishedPages(dir, APP, ENV, new Map([[TWO, entry(HASH_B, files('2001', '2002'))], [ONE, entry(HASH_A)]]));
  assert.deepStrictEqual([...readPublishedPages(dir, APP, ENV)], [[ONE, { fingerprint: HASH_A, files: files() }], [TWO, { fingerprint: HASH_B, files: files('2001', '2002') }]]);
  const file = publishedRecordPath(dir, APP, ENV);
  assert.ok(path.basename(file).startsWith(PREFIX) && /\.[0-9a-f]{64}\.json$/.test(file), 'a file of its own, named by the hash of the app and environment');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.endsWith('\n'));
  const record = JSON.parse(text);
  assert.deepStrictEqual(Object.keys(record.pages), [ONE, TWO], 'sorted: the same pages are the same bytes, whatever order they were published in');
  assert.deepStrictEqual(record.pages[ONE], { fingerprint: HASH_A, files: { [ROW_A]: '1001', [ROW_B]: '1002' } });
  assert.deepStrictEqual(Object.keys(record).sort(), ['appUniqueName', 'environmentFingerprint', 'pages', 'schemaVersion']);
  assert.strictEqual(record.schemaVersion, 2);
  assert.deepStrictEqual(fs.readdirSync(dir), [path.basename(file)], 'no temporary file is left beside it');
  assert.ok(!text.includes(ENV), 'it stores a hash of the environment, not its address');
});

test('the files of an entry are sorted too — the same versions are the same bytes — and an entry may have none', (t) => {
  const dir = workspace(t);
  writePublishedPages(dir, APP, ENV, new Map([[ONE, entry(HASH_A, new Map([[ROW_B, '1002'], [ROW_A, '1001']]))], [TWO, { fingerprint: HASH_B }]]));
  const record = JSON.parse(fs.readFileSync(publishedRecordPath(dir, APP, ENV), 'utf8'));
  assert.deepStrictEqual(Object.keys(record.pages[ONE].files), [ROW_A, ROW_B]);
  assert.ok(!('files' in record.pages[TWO]), 'a page recorded with no versions has no files key');
  assert.deepStrictEqual(readPublishedPages(dir, APP, ENV).get(TWO), { fingerprint: HASH_B, files: null });
});

test('a write REPLACES the record: a page that is no longer in the map is no longer recorded', (t) => {
  const dir = workspace(t);
  writePublishedPages(dir, APP, ENV, new Map([[ONE, entry(HASH_A)], [TWO, entry(HASH_B)]]));
  writePublishedPages(dir, APP, ENV, new Map([[TWO, entry(HASH_A)]]));
  assert.deepStrictEqual([...readPublishedPages(dir, APP, ENV).keys()], [TWO]);
  assert.strictEqual(readPublishedPages(dir, APP, ENV).get(TWO).fingerprint, HASH_A);
});

test('the record belongs to ONE app in ONE environment — another environment, or another app, in the same folder reads nothing and has a file of its own', (t) => {
  const dir = workspace(t);
  writePublishedPages(dir, APP, ENV, new Map([[ONE, entry(HASH_A)]]));
  assert.strictEqual(readPublishedPages(dir, APP, OTHER_ENV).size, 0, 'another environment: its pages are other pages');
  assert.strictEqual(readPublishedPages(dir, 'fabrikam_app', ENV).size, 0, 'another app');
  writePublishedPages(dir, APP, OTHER_ENV, new Map([[TWO, entry(HASH_B)]]));
  assert.deepStrictEqual([...readPublishedPages(dir, APP, ENV).keys()], [ONE], 'writing another scope leaves this one as it was');
  assert.deepStrictEqual([...readPublishedPages(dir, APP, OTHER_ENV).keys()], [TWO]);
  assert.strictEqual(fs.readdirSync(dir).filter((name) => name.startsWith(PREFIX)).length, 2);
  // An app's unique name is case-insensitive in Dataverse, and so is its record; an origin is read by its canonical form (`URL.origin`).
  assert.deepStrictEqual([...readPublishedPages(dir, 'Contoso_App', `${ENV}/`).keys()], [ONE]);
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
  const record = (over = {}) => JSON.stringify({ schemaVersion: 2, environmentFingerprint: fingerprint, appUniqueName: APP, pages: { [ONE]: entry(HASH_A, { [ROW_A]: '1001' }) }, ...over });
  for (const [what, text] of [
    ['torn', '{"schemaVersion":2,"pages":{'],
    ['empty', ''],
    ['not an object', '[1,2]'],
    ['another schema version', record({ schemaVersion: 3 })],
    ['no schema version', record({ schemaVersion: undefined })],
    ['another environment inside the file', record({ environmentFingerprint: sha256('https://fabrikam.crm.dynamics.com') })],
    ['another app inside the file', record({ appUniqueName: 'fabrikam_app' })],
    ['pages as a list', record({ pages: [ONE] })],
    ['no pages', record({ pages: undefined })],
  ]) {
    fs.writeFileSync(file, text, 'utf8');
    assert.strictEqual(readPublishedPages(dir, APP, ENV).size, 0, what);
  }
  fs.writeFileSync(file, record({ pages: {
    [ONE]: { fingerprint: HASH_A },
    'not-a-guid': { fingerprint: HASH_B },
    [TWO]: { fingerprint: 'not a hash' },
    '33333333-0000-4000-8000-000000000003': 42,
    '44444444-0000-4000-8000-000000000004': HASH_A,
    '55555555-0000-4000-8000-000000000005': {},
  } }), 'utf8');
  assert.deepStrictEqual([...readPublishedPages(dir, APP, ENV).keys()], [ONE], 'only the entry that is a page id with a content hash is read');
  fs.writeFileSync(file, record({ pages: { 'ABCDEF12-0000-4000-8000-00000000000A': { fingerprint: HASH_A } } }), 'utf8');
  assert.strictEqual(readPublishedPages(dir, APP, ENV).size, 0, 'ids are recorded lower case; one that is not was not written by this module');
});

test('an entry whose files are not a clear set keeps its fingerprint and loses its files — none, an empty set, a key that is no row id, a value that is no version — never a set trimmed to the rows that look right', (t) => {
  const dir = workspace(t);
  const file = publishedRecordPath(dir, APP, ENV);
  const fingerprint = sha256(new URL(ENV).origin.toLowerCase());
  const read = (filesValue) => {
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, environmentFingerprint: fingerprint, appUniqueName: APP, pages: { [ONE]: { fingerprint: HASH_A, files: filesValue } } }), 'utf8');
    return readPublishedPages(dir, APP, ENV).get(ONE);
  };
  assert.deepStrictEqual(read({ [ROW_A]: '1001' }), { fingerprint: HASH_A, files: new Map([[ROW_A, '1001']]) }, 'a clear set is read');
  for (const [what, value] of [
    ['absent', undefined],
    ['null', null],
    ['an empty set', {}],
    ['a list', [ROW_A]],
    ['a key that is not a row id', { [ROW_A]: '1001', 'not-a-row': '1002' }],
    ['a version that is a number, not the digits it was written as', { [ROW_A]: 1001 }],
    ['a version that is no whole number', { [ROW_A]: '10.5' }],
    ['a version that is empty', { [ROW_A]: '' }],
    ['a version of more digits than a 64-bit integer has', { [ROW_A]: '1'.repeat(20) }],
    ['one row good and one bad', { [ROW_A]: '1001', [ROW_B]: 'x' }],
  ]) {
    assert.deepStrictEqual(read(value), { fingerprint: HASH_A, files: null }, what);
  }
});

test('a record of the earlier format (schema version 1: a hash per page, no versions) is read as entries with no files — which never skip a publish — and the next write makes it the current format', (t) => {
  const dir = workspace(t);
  const file = publishedRecordPath(dir, APP, ENV);
  const fingerprint = sha256(new URL(ENV).origin.toLowerCase());
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, environmentFingerprint: fingerprint, appUniqueName: APP, pages: { [ONE]: HASH_A, [TWO]: 'not a hash', 'not-a-guid': HASH_B } }), 'utf8');
  assert.deepStrictEqual([...readPublishedPages(dir, APP, ENV)], [[ONE, { fingerprint: HASH_A, files: null }]]);
  writePublishedPages(dir, APP, ENV, readPublishedPages(dir, APP, ENV));
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual([record.schemaVersion, record.pages], [2, { [ONE]: { fingerprint: HASH_A } }]);
});

test('a folder, an oversized file or a link in place of the record is not read', (t) => {
  const dir = workspace(t);
  const file = publishedRecordPath(dir, APP, ENV);
  fs.mkdirSync(file);
  assert.strictEqual(readPublishedPages(dir, APP, ENV).size, 0, 'a folder');
  fs.rmdirSync(file);

  // Large, but otherwise a record in good standing: without the size limit it would be read.
  const fingerprint = sha256(new URL(ENV).origin.toLowerCase());
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, environmentFingerprint: fingerprint, appUniqueName: APP, pages: { [ONE]: { fingerprint: HASH_A } }, pad: 'x'.repeat((1 << 20) + 1) }), 'utf8');
  assert.strictEqual(readPublishedPages(dir, APP, ENV).size, 0, 'a file larger than any record of this kind');
  fs.rmSync(file);

  writePublishedPages(dir, APP, ENV, new Map([[ONE, entry(HASH_A)]]));
  const real = path.join(dir, 'real.json');
  fs.renameSync(file, real);
  try { fs.symlinkSync(real, file, 'file'); } catch (e) {
    if (e && (e.code === 'EPERM' || e.code === 'EACCES')) return; // a Windows account that may not make links
    throw e;
  }
  assert.strictEqual(readPublishedPages(dir, APP, ENV).size, 0, 'a link: the record is read only where this module wrote it');
});

test('writing: a non-id or non-hash is not written, a files set that is not clear is left out, the folder is made when it is missing, and a record that cannot be written throws what the write threw', (t) => {
  const dir = workspace(t);
  const inner = path.join(dir, 'a', 'b');
  writePublishedPages(inner, APP, ENV, new Map([
    [ONE, entry(HASH_A, new Map([[ROW_A, '1001'], ['not-a-row', '1002']]))],
    ['nope', entry(HASH_B)],
    [TWO, { fingerprint: 'nope' }],
    ['33333333-0000-4000-8000-000000000003', null],
  ]));
  const written = JSON.parse(fs.readFileSync(publishedRecordPath(inner, APP, ENV), 'utf8')).pages;
  assert.deepStrictEqual(Object.keys(written), [ONE], 'only the entry that is a page id with a hash is in the file');
  assert.deepStrictEqual(written[ONE], { fingerprint: HASH_A }, 'and a set with a key that is no row id is not written at all');
  assert.deepStrictEqual([...readPublishedPages(inner, APP, ENV)], [[ONE, { fingerprint: HASH_A, files: null }]]);

  // The record's name is taken by a folder: the rename onto it fails, no temporary file is left, and the caller — the build — says so once.
  const taken = publishedRecordPath(dir, APP, OTHER_ENV);
  fs.mkdirSync(taken);
  assert.throws(() => writePublishedPages(dir, APP, OTHER_ENV, new Map([[ONE, entry(HASH_A)]])));
  assert.deepStrictEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);

  // Not a folder at all.
  const file = path.join(dir, 'a-file');
  fs.writeFileSync(file, 'x');
  assert.throws(() => writePublishedPages(file, APP, ENV, new Map([[ONE, entry(HASH_A)]])));
});

test('sameFileVersions: only the very same rows with the very same versions are the same — a version moved, a row added, a row removed, no record, or a set nobody could read is not', () => {
  const recorded = files('1001', '1002');
  assert.strictEqual(sameFileVersions(recorded, files('1001', '1002')), true);
  assert.strictEqual(sameFileVersions(recorded, new Map([[ROW_B, '1002'], [ROW_A, '1001']])), true, 'whatever order the rows come in');
  assert.strictEqual(sameFileVersions(recorded, files('1001', '1003')), false, 'a version moved');
  assert.strictEqual(sameFileVersions(recorded, new Map([[ROW_A, '1001']])), false, 'a row removed');
  assert.strictEqual(sameFileVersions(recorded, new Map([...files(), ['f0000000-0000-4000-8000-00000000000c', '1004']])), false, 'a row added');
  assert.strictEqual(sameFileVersions(recorded, new Map([[ROW_A, '1001'], ['f0000000-0000-4000-8000-00000000000c', '1002']])), false, 'a row replaced by another with the same version');
  assert.strictEqual(sameFileVersions(recorded, null), false, 'a read that was not one consistent set');
  assert.strictEqual(sameFileVersions(recorded, undefined), false);
  assert.strictEqual(sameFileVersions(null, files()), false, 'a record with no versions');
  assert.strictEqual(sameFileVersions(new Map(), new Map()), false, 'no rows at all is not a state anyone saw');
});

test('the page-ownership readers do not see it: a record of what was published is not a receipt, and blocks nothing', (t) => {
  const dir = workspace(t);
  const { readPageOwnership, checkPageOwnershipClearable } = require('../lib/page-ownership-records.js');
  writePublishedPages(dir, APP, ENV, new Map([[ONE, entry(HASH_A)]]));
  assert.deepStrictEqual(readPageOwnership(dir, APP, ENV), { created: [], teardown: [] });
  assert.deepStrictEqual(checkPageOwnershipClearable(dir), { ok: true }, 'it keeps --clear-workspace from clearing nothing');
});
