'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('./style-site-fixtures');

test('the pinned parser and attribute codec work from the shipped bundle without package installation', (t) => {
  const f = fixture(t);
  const folder = path.resolve(__dirname, '../vendor/css-tools');
  const copy = path.join(f.work, 'isolated-css-tools.cjs');
  fs.copyFileSync(path.join(folder, 'css-tools.cjs'), copy);
  const { cssTree, propertyData, decodeHTMLAttribute, escapeAttribute } = require(copy);
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8'));
  assert.equal(cssTree.version, manifest.dependencies['css-tree']);
  assert.equal(cssTree.parse('.pp-card { display:grid; }').type, 'StyleSheet');
  assert.ok(propertyData.animation.computed.includes('animation-duration'));
  assert.equal(decodeHTMLAttribute('A &amp; B &quot;font&quot;'), 'A & B "font"');
  assert.equal(escapeAttribute('A & B "font"'), 'A &amp; B &quot;font&quot;');
  for (const name of ['css-tree', 'entities', 'mdn-data', 'source-map-js']) {
    assert.ok(fs.statSync(path.join(folder, `LICENSE.${name}`)).size > 100);
  }
  const lock = JSON.parse(fs.readFileSync(path.join(folder, 'package-lock.json'), 'utf8'));
  for (const item of Object.values(lock.packages)) {
    if (item.resolved) assert.ok(item.resolved.startsWith('https://registry.npmjs.org/'), 'Use portable public-registry lockfile URLs.');
  }
});
