'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const {
  tallyByType,
  formatTallyMarkdown,
  formatTallyText,
  labelForType,
  COMPONENT_TYPE_LABELS,
} = require('../lib/component-type-tally');

const CLI = require.resolve('../lib/component-type-tally.js');

test('labelForType: known types resolve to human labels', () => {
  assert.equal(labelForType(1), 'Entity');
  assert.equal(labelForType(61), 'WebResource');
  assert.equal(labelForType(62), 'SiteMap');
});

test('labelForType: unknown types fall back to "Type N"', () => {
  assert.equal(labelForType(9999), 'Type 9999');
});

test('labelForType: null/undefined → "Unknown"', () => {
  assert.equal(labelForType(null), 'Unknown');
  assert.equal(labelForType(undefined), 'Unknown');
});

test('formatTallyMarkdown: O2 — suppresses redundant "(N other)" when every item is "other"', () => {
  // changetype null → "other" bucket. All 143 fall into "other".
  const items = Array.from({ length: 143 }, () => ({ componenttype: 1, changetype: null }));
  const md = formatTallyMarkdown(tallyByType(items));
  assert.match(md, /143 Entity/, 'shows the clean total');
  assert.doesNotMatch(md, /143 other/, 'no redundant "(143 other)" suffix');
  assert.doesNotMatch(md, /\(.*other.*\)/, 'no other-only parenthetical');
});

test('formatTallyMarkdown: still shows a breakdown when there is a real change-type mix', () => {
  const items = [
    { componenttype: 1, changetype: 1 },
    { componenttype: 1, changetype: 2 },
    { componenttype: 1, changetype: null },
  ];
  const md = formatTallyMarkdown(tallyByType(items));
  assert.match(md, /\(1 create, 1 update, 1 other\)/, 'real mix keeps the full breakdown');
});

test('tallyByType: groups by type and counts changetype breakdown', () => {
  const items = [
    { componenttype: 1, changetype: 1 },
    { componenttype: 1, changetype: 1 },
    { componenttype: 1, changetype: 2 },
    { componenttype: 61, changetype: 2 },
    { componenttype: 61, changetype: 3 },
  ];
  const out = tallyByType(items);
  assert.equal(out.length, 2);
  // sorted desc by total
  assert.equal(out[0].label, 'Entity');
  assert.equal(out[0].total, 3);
  assert.deepEqual(out[0].byChangeType, { create: 2, update: 1, delete: 0, other: 0 });
  assert.equal(out[1].label, 'WebResource');
  assert.equal(out[1].total, 2);
  assert.deepEqual(out[1].byChangeType, { create: 0, update: 1, delete: 1, other: 0 });
});

test('tallyByType: accepts both camelCase and lowercased keys (mirror list-pending-changes output)', () => {
  const items = [
    { componentType: 1, changeType: 1 },     // camelCase
    { componenttype: 1, changetype: 2 },     // lowercase
  ];
  const out = tallyByType(items);
  assert.equal(out.length, 1);
  assert.equal(out[0].total, 2);
});

test('tallyByType: empty array → empty result', () => {
  assert.deepEqual(tallyByType([]), []);
});

test('tallyByType: throws on non-array input (catches the no-items-shape bug at the API boundary)', () => {
  assert.throws(() => tallyByType({}), /items must be an array/);
  assert.throws(() => tallyByType(null), /items must be an array/);
});

test('formatTallyMarkdown: renders 1 line per type with breakdown', () => {
  const items = [
    { componenttype: 1, changetype: 1 },
    { componenttype: 1, changetype: 2 },
    { componenttype: 61, changetype: 2 },
  ];
  const md = formatTallyMarkdown(tallyByType(items));
  assert.match(md, /- 2 Entity \(1 create, 1 update\)/);
  assert.match(md, /- 1 WebResource \(1 update\)/);
});

test('formatTallyMarkdown: truncates at maxLines and shows "+ N more"', () => {
  // 8 distinct types — default cap is 6
  const items = [];
  for (let t = 1; t <= 8; t++) items.push({ componenttype: t * 10, changetype: 1 });
  const md = formatTallyMarkdown(tallyByType(items));
  const lines = md.split('\n');
  assert.equal(lines.length, 7, 'expected 6 type lines + 1 summary line');
  assert.match(lines[6], /\+ 2 more component type\(s\) \(2 components\)/);
});

test('formatTallyMarkdown: empty tally → italic placeholder', () => {
  assert.equal(formatTallyMarkdown([]), '_(no components)_');
});

test('formatTallyText: one-line summary with total + inline labels + "+N more"', () => {
  const items = [];
  for (let t = 1; t <= 5; t++) items.push({ componenttype: t * 10, changetype: 1 });
  const text = formatTallyText(tallyByType(items));
  assert.match(text, /^5 components — /);
  assert.match(text, /\+2 more$/);
});

test('formatTallyText: empty → "0 components"', () => {
  assert.equal(formatTallyText([]), '0 components');
});

test('CLI: --items-file + --format markdown writes markdown to stdout', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-cli-'));
  const itemsFile = path.join(tmp, 'items.json');
  fs.writeFileSync(itemsFile, JSON.stringify({ items: [
    { componenttype: 1, changetype: 1 },
    { componenttype: 61, changetype: 2 },
  ] }));
  const r = spawnSync(process.execPath, [CLI, '--items-file', itemsFile, '--format', 'markdown'], { encoding: 'utf8' });
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /- 1 Entity \(1 create\)/);
  assert.match(r.stdout, /- 1 WebResource \(1 update\)/);
});

test('CLI: --items-file is required', () => {
  const r = spawnSync(process.execPath, [CLI], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--items-file <path> is required/);
});

test('CLI: --format must be json|markdown|text', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-cli-'));
  const itemsFile = path.join(tmp, 'items.json');
  fs.writeFileSync(itemsFile, JSON.stringify([]));
  const r = spawnSync(process.execPath, [CLI, '--items-file', itemsFile, '--format', 'bogus'], { encoding: 'utf8' });
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--format must be json\|markdown\|text/);
});

test('COMPONENT_TYPE_LABELS is frozen (immutable catalog)', () => {
  assert.throws(() => { COMPONENT_TYPE_LABELS[1] = 'NOPE'; }, /TypeError|Cannot assign/);
});
