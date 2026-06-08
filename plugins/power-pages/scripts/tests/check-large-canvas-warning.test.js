'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  checkLargeCanvasWarning, isCanvasApp, CANVAS_APP_TYPES, CANVAS_FILE_REGEX,
} = require('../lib/check-large-canvas-warning');

test('check-large-canvas-warning: CANVAS_APP_TYPES contains common variants', () => {
  assert.ok(CANVAS_APP_TYPES.has('canvasapp'));
  assert.ok(CANVAS_APP_TYPES.has('mscanvasapp'));
});

test('check-large-canvas-warning: CANVAS_FILE_REGEX matches .msapp', () => {
  assert.ok(CANVAS_FILE_REGEX.test('apps/MyApp.msapp'));
  assert.ok(CANVAS_FILE_REGEX.test('MyApp.MSAPP'));
  assert.ok(!CANVAS_FILE_REGEX.test('apps/MyApp.zip'));
});

test('check-large-canvas-warning: isCanvasApp by componentType', () => {
  assert.ok(isCanvasApp({ componentType: 'canvasapp' }));
  assert.ok(isCanvasApp({ componentType: 'CanvasApp' }));
  assert.ok(!isCanvasApp({ componentType: 'mspp_webpage' }));
});

test('check-large-canvas-warning: isCanvasApp by filePath', () => {
  assert.ok(isCanvasApp({ filePath: 'src/MyApp.msapp' }));
  assert.ok(!isCanvasApp({ filePath: 'src/MyApp.zip' }));
});

test('check-large-canvas-warning: throws on non-array', () => {
  assert.throws(() => checkLargeCanvasWarning(null), /items must be an array/);
});

test('check-large-canvas-warning: empty items → no warnings', () => {
  const r = checkLargeCanvasWarning([]);
  assert.equal(r.totalCanvasApps, 0);
  assert.deepEqual(r.warnings, []);
});

test('check-large-canvas-warning: non-canvas items ignored', () => {
  const items = [
    { componentType: 'mspp_webpage', estimatedBytes: 16 * 1024 * 1024 },
    { componentType: 'mspp_webfile', estimatedBytes: 16 * 1024 * 1024 },
  ];
  const r = checkLargeCanvasWarning(items);
  assert.equal(r.totalCanvasApps, 0);
  assert.equal(r.warnings.length, 0);
});

test('check-large-canvas-warning: small canvas → no warning', () => {
  // 1 MB raw → encoded ~1.33 MB → 7.8% of cap → no warn
  const items = [{ componentName: 'SmallApp', componentType: 'canvasapp', estimatedBytes: 1024 * 1024 }];
  const r = checkLargeCanvasWarning(items);
  assert.equal(r.totalCanvasApps, 1);
  assert.equal(r.warnings.length, 0);
});

test('check-large-canvas-warning: canvas in warn band (70-90%) → severity warn', () => {
  // 10 MB raw → encoded ~13.33 MB → 78% of 17 MB cap
  const items = [{ componentName: 'WarnApp', componentType: 'canvasapp', estimatedBytes: 10 * 1024 * 1024 }];
  const r = checkLargeCanvasWarning(items);
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].severity, 'warn');
  assert.ok(r.warnings[0].percentOfCap >= 70 && r.warnings[0].percentOfCap < 90);
});

test('check-large-canvas-warning: canvas in critical band (90-100%) → severity critical', () => {
  // 12 MB raw → encoded ~16 MB → 94% of cap
  const items = [{ componentName: 'CritApp', componentType: 'canvasapp', estimatedBytes: 12 * 1024 * 1024 }];
  const r = checkLargeCanvasWarning(items);
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].severity, 'critical');
});

test('check-large-canvas-warning: canvas over cap excluded (validate-file-sizes owns it)', () => {
  // 14 MB raw → encoded ~18.67 MB → over cap → NOT included here
  const items = [{ componentName: 'BlockApp', componentType: 'canvasapp', estimatedBytes: 14 * 1024 * 1024 }];
  const r = checkLargeCanvasWarning(items);
  assert.equal(r.totalCanvasApps, 1);
  assert.equal(r.warnings.length, 0);
});

test('check-large-canvas-warning: detected via .msapp filename even if componentType missing', () => {
  const items = [{ componentName: 'AppX', filePath: 'apps/AppX.msapp', estimatedBytes: 11 * 1024 * 1024 }];
  const r = checkLargeCanvasWarning(items);
  assert.equal(r.totalCanvasApps, 1);
  assert.equal(r.warnings.length, 1);
});

test('check-large-canvas-warning: ok is always true (informational)', () => {
  const items = [{ componentType: 'canvasapp', estimatedBytes: 12 * 1024 * 1024 }];
  const r = checkLargeCanvasWarning(items);
  assert.equal(r.ok, true);
});
