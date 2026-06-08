'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  renderPrDescription, escapeMd, groupByChangeType,
} = require('../lib/ado-render-pr-description');

test('ado-render-pr-description: escapeMd escapes special chars', () => {
  assert.equal(escapeMd('a*b_c'), 'a\\*b\\_c');
  assert.equal(escapeMd('[link](url)'), '\\[link\\]\\(url\\)');
  assert.equal(escapeMd(null), '');
  assert.equal(escapeMd(undefined), '');
  assert.equal(escapeMd('plain'), 'plain');
});

test('ado-render-pr-description: groupByChangeType buckets correctly', () => {
  const g = groupByChangeType([
    { changeType: 'Add', componentName: 'a' },
    { changeType: 'Modify', componentName: 'b' },
    { changeType: 'Delete', componentName: 'c' },
    { changeType: 'Unknown', componentName: 'd' },
    null,
  ]);
  assert.equal(g.Add.length, 1);
  assert.equal(g.Modify.length, 1);
  assert.equal(g.Delete.length, 1);
  assert.equal(g.Other.length, 1);
});

test('ado-render-pr-description: throws on non-array', () => {
  assert.throws(() => renderPrDescription(null), /items must be an array/);
});

test('ado-render-pr-description: empty items → empty-changes message', () => {
  const r = renderPrDescription([]);
  assert.equal(r.stats.total, 0);
  assert.equal(r.stats.added, 0);
  assert.match(r.markdown, /no component changes/i);
  assert.match(r.markdown, /No detectable component changes/);
});

test('ado-render-pr-description: stats reflect input', () => {
  const items = [
    { changeType: 'Add', componentName: 'a' },
    { changeType: 'Add', componentName: 'b' },
    { changeType: 'Modify', componentName: 'c' },
    { changeType: 'Delete', componentName: 'd' },
  ];
  const r = renderPrDescription(items);
  assert.equal(r.stats.added, 2);
  assert.equal(r.stats.modified, 1);
  assert.equal(r.stats.deleted, 1);
  assert.equal(r.stats.total, 4);
  assert.match(r.summary, /2 added, 1 modified, 1 deleted/);
});

test('ado-render-pr-description: markdown has Summary and Changes sections', () => {
  const items = [
    { changeType: 'Add', componentName: 'MyPage', componentType: 'mspp_webpage' },
  ];
  const r = renderPrDescription(items);
  assert.match(r.markdown, /## Summary/);
  assert.match(r.markdown, /## Changes/);
  assert.match(r.markdown, /### Added \(1\)/);
  assert.match(r.markdown, /\*\*MyPage\*\*/);
  assert.match(r.markdown, /`mspp_webpage`/);
});

test('ado-render-pr-description: commitMessage rendered as blockquote', () => {
  const items = [{ changeType: 'Add', componentName: 'x' }];
  const r = renderPrDescription(items, { commitMessage: 'feat: add x' });
  assert.match(r.markdown, /Commit message/);
  assert.match(r.markdown, /> feat: add x/);
});

test('ado-render-pr-description: multi-line commitMessage is quoted per line', () => {
  const items = [{ changeType: 'Add', componentName: 'x' }];
  const r = renderPrDescription(items, { commitMessage: 'feat: add x\n\nWith details.' });
  // escapeMd escapes the trailing '.' → '\.'
  assert.match(r.markdown, /> feat: add x\n> \n> With details\\\./);
});

test('ado-render-pr-description: title appended to summary', () => {
  const items = [{ changeType: 'Add', componentName: 'x' }];
  const r = renderPrDescription(items, { title: 'Sprint 7 sync' });
  assert.match(r.summary, /^Sprint 7 sync \(1 added\)$/);
  assert.match(r.markdown, /\*\*Sprint 7 sync\*\*/);
});

test('ado-render-pr-description: custom footer overrides default', () => {
  const items = [{ changeType: 'Add', componentName: 'x' }];
  const r = renderPrDescription(items, { footer: '_Custom footer_' });
  assert.match(r.markdown, /_Custom footer_/);
  assert.ok(!r.markdown.includes('ado-render-pr-description'));
});

test('ado-render-pr-description: component name with markdown chars is escaped', () => {
  const items = [
    { changeType: 'Add', componentName: 'My_Page*Name' },
  ];
  const r = renderPrDescription(items);
  assert.match(r.markdown, /My\\_Page\\\*Name/);
});

test('ado-render-pr-description: section omitted when empty', () => {
  const items = [{ changeType: 'Add', componentName: 'only-added' }];
  const r = renderPrDescription(items);
  assert.match(r.markdown, /### Added/);
  assert.ok(!/### Modified/.test(r.markdown));
  assert.ok(!/### Deleted/.test(r.markdown));
});

test('ado-render-pr-description: filePath appears as italic suffix', () => {
  const items = [
    { changeType: 'Modify', componentName: 'X', componentType: 'mspp_webfile', filePath: 'public/x.js' },
  ];
  const r = renderPrDescription(items);
  assert.match(r.markdown, /_public\/x\\.js_/);
});

test('ado-render-pr-description: Other bucket appears when changeType unknown', () => {
  const items = [{ changeType: 'Mystery', componentName: 'q' }];
  const r = renderPrDescription(items);
  assert.match(r.markdown, /### Other \(1\)/);
  assert.equal(r.stats.other, 1);
});
