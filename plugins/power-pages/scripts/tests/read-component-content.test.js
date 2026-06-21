'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  extractMergeFields,
  reattachContent,
  classifyFieldValue,
  MERGE_FIELDS_BY_TYPE,
} = require('../lib/read-component-content');

// ---- classifyFieldValue ----
test('classifyFieldValue: multi-line is text', () => {
  assert.equal(classifyFieldValue('line1\nline2'), 'text');
  assert.equal(classifyFieldValue('a\r\nb'), 'text');
});
test('classifyFieldValue: json object/array is text', () => {
  assert.equal(classifyFieldValue('{"a":1}'), 'text');
  assert.equal(classifyFieldValue('[1,2,3]'), 'text');
});
test('classifyFieldValue: short single-line scalar is scalar', () => {
  assert.equal(classifyFieldValue('true'), 'scalar');
  assert.equal(classifyFieldValue('Microsoft Entra ID'), 'scalar');
  assert.equal(classifyFieldValue('https://example.com/path'), 'scalar');
});
test('classifyFieldValue: malformed json-looking string falls back to scalar', () => {
  assert.equal(classifyFieldValue('{not json}'), 'scalar');
});
test('classifyFieldValue: non-string is scalar', () => {
  assert.equal(classifyFieldValue(42), 'scalar');
  assert.equal(classifyFieldValue(true), 'scalar');
});

// ---- extractMergeFields: web template (type 8) ----
test('extractMergeFields: web template extracts source as text', () => {
  const content = JSON.stringify({ source: '{% assign x = 1 %}\r\n<ul></ul>' });
  const r = extractMergeFields(8, content);
  assert.equal(r.mergeStrategy, 'text');
  assert.equal(r.mergeFields.length, 1);
  assert.equal(r.mergeFields[0].key, 'source');
  assert.equal(r.mergeFields[0].isText, true);
  assert.match(r.mergeFields[0].value, /assign x/);
  assert.equal(r.envelope.source, '{% assign x = 1 %}\r\n<ul></ul>');
});

// ---- content snippet (type 7) ----
test('extractMergeFields: content snippet extracts value, preserves metadata in envelope', () => {
  const content = JSON.stringify({ contentsnippetlanguageid: 'lang', display_name: 'Site name', type: 756150000, value: 'Hello\nWorld', websiteid: 'site' });
  const r = extractMergeFields(7, content);
  assert.equal(r.mergeStrategy, 'text');
  assert.equal(r.mergeFields[0].key, 'value');
  assert.equal(r.envelope.display_name, 'Site name');
  assert.equal(r.envelope.type, 756150000);
});

// ---- web page (type 2) ----
test('extractMergeFields: web page with copy is text', () => {
  const content = JSON.stringify({ title: 'Profile', partialurl: 'profile', copy: '<p>hi</p>\r\n<p>there</p>' });
  const r = extractMergeFields(2, content);
  assert.equal(r.mergeStrategy, 'text');
  assert.equal(r.mergeFields[0].key, 'copy');
});
test('extractMergeFields: web page WITHOUT copy is binary (no mergeable text field)', () => {
  const content = JSON.stringify({ title: 'assets', partialurl: 'assets', isroot: true });
  const r = extractMergeFields(2, content);
  assert.equal(r.mergeStrategy, 'binary');
  assert.equal(r.mergeFields.length, 0);
});

// ---- site setting (type 9) ----
test('extractMergeFields: scalar site setting is scalar strategy', () => {
  const content = JSON.stringify({ value: 'false' });
  const r = extractMergeFields(9, content);
  assert.equal(r.mergeStrategy, 'scalar');
  assert.equal(r.mergeFields[0].key, 'value');
  assert.equal(r.mergeFields[0].isText, false);
});
test('extractMergeFields: JSON-blob site setting is text strategy', () => {
  const content = JSON.stringify({ value: '{"a":1,"b":2}' });
  const r = extractMergeFields(9, content);
  assert.equal(r.mergeStrategy, 'text');
  assert.equal(r.mergeFields[0].isText, true);
});

// ---- web file (type 3) ----
test('extractMergeFields: web file is binary (bytes not in content envelope)', () => {
  const content = JSON.stringify({ partialurl: 'index.html', websiteid: 'site' });
  const r = extractMergeFields(3, content);
  assert.equal(r.mergeStrategy, 'binary');
  assert.equal(r.mergeFields.length, 0);
  assert.equal(MERGE_FIELDS_BY_TYPE[3].length, 0);
});

// ---- malformed content ----
test('extractMergeFields: malformed JSON content yields binary + parseError', () => {
  const r = extractMergeFields(8, '{not valid json');
  assert.equal(r.mergeStrategy, 'binary');
  assert.equal(r.mergeFields.length, 0);
  assert.ok(r.parseError);
});
test('extractMergeFields: empty content yields binary, envelope null', () => {
  const r = extractMergeFields(8, null);
  assert.equal(r.envelope, null);
  assert.equal(r.mergeStrategy, 'binary');
});
test('extractMergeFields: unknown type yields binary', () => {
  const r = extractMergeFields(999, JSON.stringify({ foo: 'bar' }));
  assert.equal(r.mergeStrategy, 'binary');
});

// ---- reattachContent (inverse — for write-back fallback) ----
test('reattachContent: swaps merged field, preserves all other metadata', () => {
  const envelope = { source: 'OLD', someMeta: 'keep', langId: 'abc' };
  const next = reattachContent(envelope, { source: 'MERGED' });
  const parsed = JSON.parse(next);
  assert.equal(parsed.source, 'MERGED');
  assert.equal(parsed.someMeta, 'keep');
  assert.equal(parsed.langId, 'abc');
});
test('reattachContent: does not mutate the original envelope', () => {
  const envelope = { source: 'OLD' };
  reattachContent(envelope, { source: 'NEW' });
  assert.equal(envelope.source, 'OLD');
});
test('reattachContent: rejects bad inputs', () => {
  assert.throws(() => reattachContent(null, { a: 1 }), /envelope/);
  assert.throws(() => reattachContent({ a: 1 }, null), /updates/);
});
test('reattachContent: round-trips with extractMergeFields (web template)', () => {
  const original = JSON.stringify({ source: 'ORIGINAL\r\nLIQUID', someFlag: true });
  const { envelope } = extractMergeFields(8, original);
  const rewrapped = reattachContent(envelope, { source: 'MERGED\r\nLIQUID' });
  const parsed = JSON.parse(rewrapped);
  assert.equal(parsed.source, 'MERGED\r\nLIQUID');
  assert.equal(parsed.someFlag, true);
});
