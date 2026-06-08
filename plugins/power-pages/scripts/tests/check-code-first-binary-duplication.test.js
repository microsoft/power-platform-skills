'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  checkCodeFirstBinaryDuplication, classifyItem, baseName,
} = require('../lib/check-code-first-binary-duplication');

test('check-code-first-binary-duplication: baseName strips dir and ext', () => {
  assert.equal(baseName('foo/bar/MyControl.dll'), 'MyControl');
  assert.equal(baseName('MyControl.zip'), 'MyControl');
  assert.equal(baseName('plain'), 'plain');
  assert.equal(baseName(''), '');
});

test('check-code-first-binary-duplication: classifyItem detects .dll as binary', () => {
  const c = classifyItem({ filePath: 'plugins/MyAsm.dll' });
  assert.equal(c.isBinary, true);
  assert.equal(c.kind, 'pluginassembly');
});

test('check-code-first-binary-duplication: classifyItem detects pluginassembly type', () => {
  const c = classifyItem({ componentType: 'pluginassembly' });
  assert.equal(c.isBinary, true);
  assert.equal(c.kind, 'pluginassembly');
});

test('check-code-first-binary-duplication: classifyItem detects PCF source under PCFControls/', () => {
  const c = classifyItem({ filePath: 'PCFControls/MyCtrl/ControlManifest.Input.xml' });
  assert.equal(c.isSource, true);
  assert.equal(c.kind, 'pcf');
});

test('check-code-first-binary-duplication: classifyItem detects .cs as plugin source', () => {
  const c = classifyItem({ filePath: 'src/MyPlugin.cs' });
  assert.equal(c.isSource, true);
  assert.equal(c.kind, 'pluginassembly');
});

test('check-code-first-binary-duplication: classifyItem returns false for plain webpage', () => {
  const c = classifyItem({ componentType: 'mspp_webpage', filePath: 'about.html' });
  assert.equal(c.isBinary, false);
  assert.equal(c.isSource, false);
});

test('check-code-first-binary-duplication: throws on non-array', () => {
  assert.throws(() => checkCodeFirstBinaryDuplication(null), /items must be an array/);
});

test('check-code-first-binary-duplication: empty items → no warnings', () => {
  const r = checkCodeFirstBinaryDuplication([]);
  assert.equal(r.totalCodeFirstComponents, 0);
  assert.deepEqual(r.warnings, []);
});

test('check-code-first-binary-duplication: pluginassembly DLL + matching .cs source → warns', () => {
  const items = [
    { componentId: 'b1', componentName: 'MyPlugin', componentType: 'pluginassembly', filePath: 'plugins/MyPlugin.dll' },
    { componentId: 's1', componentName: 'MyPlugin', filePath: 'src/MyPlugin.cs' },
  ];
  const r = checkCodeFirstBinaryDuplication(items);
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].kind, 'pluginassembly');
  assert.equal(r.warnings[0].binaryItem.componentId, 'b1');
  assert.equal(r.warnings[0].sourceItems.length, 1);
});

test('check-code-first-binary-duplication: PCF binary alone (no source) → no warning', () => {
  const items = [
    { componentId: 'b', componentName: 'PcfA', componentType: 'customcontrol', filePath: 'controls/PcfA.zip' },
  ];
  const r = checkCodeFirstBinaryDuplication(items);
  assert.equal(r.warnings.length, 0);
});

test('check-code-first-binary-duplication: PCF source alone (no binary) → no warning', () => {
  const items = [
    { componentId: 's', componentName: 'PcfA', filePath: 'PCFControls/PcfA/ControlManifest.Input.xml' },
    { componentId: 's2', componentName: 'PcfA', filePath: 'PCFControls/PcfA/index.tsx' },
  ];
  const r = checkCodeFirstBinaryDuplication(items);
  assert.equal(r.warnings.length, 0);
});

test('check-code-first-binary-duplication: PCF binary + matching source → warns', () => {
  const items = [
    { componentId: 'b', componentName: 'MyCtrl', componentType: 'customcontrol', filePath: 'controls/MyCtrl.zip' },
    { componentId: 's', componentName: 'MyCtrl', filePath: 'PCFControls/MyCtrl/index.tsx' },
  ];
  const r = checkCodeFirstBinaryDuplication(items);
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].kind, 'pcf');
});

test('check-code-first-binary-duplication: no spurious warning when names differ', () => {
  const items = [
    { componentId: 'b', componentName: 'PluginA', componentType: 'pluginassembly', filePath: 'plugins/PluginA.dll' },
    { componentId: 's', componentName: 'PluginB', filePath: 'src/PluginB.cs' },
  ];
  const r = checkCodeFirstBinaryDuplication(items);
  assert.equal(r.warnings.length, 0);
});

test('check-code-first-binary-duplication: ok is always true', () => {
  const items = [
    { componentId: 'b', componentName: 'X', componentType: 'pluginassembly', filePath: 'X.dll' },
    { componentId: 's', componentName: 'X', filePath: 'X.cs' },
  ];
  const r = checkCodeFirstBinaryDuplication(items);
  assert.equal(r.ok, true);
});
