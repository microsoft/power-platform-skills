'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const entry = fs.readFileSync(path.join(root, 'agents/screen-builder.md'), 'utf8');

test('screen builder entry stays bounded and conditionally loads owned references', () => {
  assert.ok(entry.trimEnd().split('\n').length <= 180);
  assert.ok(Buffer.byteLength(entry) <= 12 * 1024);
  const references = [...entry.matchAll(/\]\((references\/screen-builder\/[^)]+)\)/g)];
  assert.ok(references.length > 0);
  for (const [, reference] of references) {
    assert.ok(fs.existsSync(path.join(root, 'agents', reference)), reference);
  }
  assert.match(entry, /only when its trigger applies/);
  assert.match(entry, /API\/import sample is optional/);
  assert.match(entry, /existing artifacts, not a new work-order or sidecar/);
});

test('builder keeps child ownership and truthful outcomes separate from presentation', () => {
  assert.match(entry, /Write \*\*only `target_file`\*\*/);
  assert.match(entry, /Never ask the user questions, enter plan mode/);
  assert.match(entry, /root layout\/gesture-provider repairs/);
  assert.match(entry, /result\.success/);
  assert.match(entry, /Live empty results stay empty/);
  assert.match(entry, /motion: none/);
  assert.match(entry, /No universal large header\/search, bottom CTA/);
  assert.match(entry, /normalizeDataverseGuid/);
  assert.match(entry, /NEVER use `expo-haptics`/);
  assert.match(entry, /validate-mobile-files\.js/);
  for (const status of ['DONE', 'DONE_WITH_CONCERNS:', 'NEEDS_CONTEXT:', 'BLOCKED:']) {
    assert.ok(entry.includes(status));
  }
});
