'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ICON_NAMES,
  inferIconIntent,
  isKnownIconIntent,
  resolveIconName,
} = require('../lib/navigation-icons');

const cases = [
  ['Home overview', 'home'],
  ['Browse catalog', 'browse'],
  ['Categories', 'categories'],
  ['Shopping bag', 'bag'],
  ['Profile', 'profile'],
  ['Settings', 'settings'],
  ['Expected shipments', 'shipments'],
  ['Saved drafts', 'drafts'],
  ['Monthly inspections', 'inspections'],
  ['Ongoing repairs', 'repairs'],
  ['Upcoming maintenance', 'maintenance'],
  ['Warranty coverage', 'warranty'],
  ['Scan QR', 'scan'],
  ['Print barcode', 'barcode'],
  ['Damage camera', 'camera'],
  ['GPS location', 'location'],
  ['Recipient signature', 'signature'],
  ['Print label', 'print'],
  ['Activity history', 'history'],
  ['Attention alerts', 'alerts'],
  ['Messages inbox', 'messages'],
  ['Search assets', 'search'],
  ['Filter records', 'filter'],
  ['Add item', 'add'],
  ['Edit asset', 'edit'],
  ['Delete record', 'delete'],
  ['Retry load', 'retry'],
];

test('semantic icon intents cover product destinations and actions with verified Ionicons names', () => {
  for (const [label, expected] of cases) {
    const intent = inferIconIntent(label);
    assert.equal(intent, expected, label);
    assert.equal(isKnownIconIntent(intent), true, label);
    assert.match(resolveIconName(intent), /^[a-z][a-z0-9-]*-outline$/, label);
  }
  assert.equal(new Set(Object.values(ICON_NAMES)).size, Object.keys(ICON_NAMES).length);
});

test('unknown concepts use the documented list fallback instead of apps-outline', () => {
  assert.equal(inferIconIntent('Miscellaneous workspace'), 'list');
  assert.equal(resolveIconName('unknown-intent'), 'list-outline');
  assert.equal(isKnownIconIntent('unknown-intent'), false);
});
