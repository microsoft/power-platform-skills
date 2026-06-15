'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyChangeSet, isWebFile, DEFAULT_CHURN_PATTERNS, WEB_FILE_TYPE_NAMES,
} = require('../lib/classify-change-set');

function webFile(filePath, extra = {}) {
  return { componentType: 'Web File', componentName: filePath.split('/').pop(), filePath, ...extra };
}
function configItem(type, name) {
  return { componentType: type, componentName: name, filePath: `/${type}/${name}.yml` };
}

// ===== isWebFile =====

test('isWebFile recognises the web-file type names', () => {
  assert.equal(isWebFile({ componentType: 'Web File' }), true);
  assert.equal(isWebFile({ componenttypename: 'WebFile' }), true);
  assert.equal(isWebFile({ componentType: 'Web Template' }), false);
  assert.equal(isWebFile({ componentType: 'Entity' }), false);
});

test('DEFAULT_CHURN_PATTERNS is a non-empty list of RegExp', () => {
  assert.ok(DEFAULT_CHURN_PATTERNS.length > 0);
  for (const p of DEFAULT_CHURN_PATTERNS) assert.ok(p instanceof RegExp);
});

// ===== classify: config vs churn =====

test('hashed bundle web files → churn', () => {
  const items = [
    webFile('/assets/app.4f3a9c12.js'),
    webFile('/assets/styles-9ab12cd3.css'),
    webFile('/assets/app.4f3a9c12.js.map'),
    webFile('/assets/vendor.min.js'),
  ];
  const r = classifyChangeSet(items);
  assert.equal(r.summary.churnCount, 4);
  assert.equal(r.summary.configCount, 0);
});

test('web templates / pages / site settings / schema → config (never churn)', () => {
  const items = [
    configItem('Web Template', 'Header'),
    configItem('Web Page', 'Pricing'),
    configItem('Site Setting', 'Header/OutputCache'),
    configItem('Entity', 'Account'),
    configItem('Attribute', 'name'),
  ];
  const r = classifyChangeSet(items);
  assert.equal(r.summary.configCount, 5);
  assert.equal(r.summary.churnCount, 0);
});

test('mixed set splits correctly with per-type breakdown', () => {
  const items = [
    configItem('Web Template', 'Header'),
    configItem('Web Page', 'Pricing'),
    webFile('/assets/app.4f3a9c12.js'),
    webFile('/assets/app.4f3a9c12.js.map'),
    webFile('/build/chunk-vendors.83f2.js'),
  ];
  const r = classifyChangeSet(items);
  assert.equal(r.summary.total, 5);
  assert.equal(r.summary.configCount, 2);
  assert.equal(r.summary.churnCount, 3);
  assert.equal(r.summary.configByType['Web Template'], 1);
  assert.equal(r.summary.churnByType['Web File'], 3);
});

// ===== fail-toward-config =====

test('a NON-hashed web file (e.g. an authored .js content file) → config, not churn', () => {
  // A web file that doesn't match a churn pattern must NOT be hidden as churn.
  const items = [webFile('/web-files/custom-logic.js')];
  const r = classifyChangeSet(items);
  assert.equal(r.summary.configCount, 1, 'authored web file stays visible as config');
  assert.equal(r.summary.churnCount, 0);
});

test('a non-web-file component that happens to have a hashed-looking path → config', () => {
  // Only web files can be churn; a Web Template is always config even if its
  // path looked hash-y.
  const items = [{ componentType: 'Web Template', componentName: 'x', filePath: '/t/x.4f3a9c12.js' }];
  const r = classifyChangeSet(items);
  assert.equal(r.summary.configCount, 1);
  assert.equal(r.summary.churnCount, 0);
});

// ===== overridable patterns =====

test('custom churnPatterns override the default set', () => {
  const items = [webFile('/custom/thing.bundle.js'), webFile('/assets/app.4f3a9c12.js')];
  // Override: only treat ".bundle.js" as churn; the hashed default no longer applies.
  const r = classifyChangeSet(items, { churnPatterns: [/\.bundle\.js$/] });
  assert.equal(r.summary.churnCount, 1);
  assert.equal(r.bundleChurn[0].filePath, '/custom/thing.bundle.js');
  assert.equal(r.summary.configCount, 1, 'hashed file is config under the override');
});

// ===== robustness =====

test('empty / non-array input yields an empty split', () => {
  assert.deepEqual(classifyChangeSet([]).summary, { total: 0, configCount: 0, churnCount: 0, configByType: {}, churnByType: {} });
  assert.equal(classifyChangeSet(null).summary.total, 0);
});

test('accepts the full list-pending-changes envelope shape (probes filePath)', () => {
  const items = [
    { componentId: 'a', componentName: 'app.4f3a9c12.js', componentType: 'Web File', filePath: '/assets/app.4f3a9c12.js', changeType: 'Modify' },
  ];
  const r = classifyChangeSet(items);
  assert.equal(r.summary.churnCount, 1);
});
