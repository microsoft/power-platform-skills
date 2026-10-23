'use strict';
// lib/dashboard-tiles.js: which tile of a deployed dashboard a custom control hosts. The download (which leaves such a tile out of
// the spec) and verify (which does not hold it to a chart and view of its table) share this one classification, so it is pinned
// here once — and so is the fact that neither of them keeps a copy of its own.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { hostsCustomControl, NATIVE_GRID_CLASS_ID } = require('../lib/dashboard-tiles.js');

const CUSTOM = '{F9A8A302-114E-466A-B582-6771B2AE0D92}';

test('a list or chart tile on the native grid class is not hosted, in any spelling of the class', () => {
  const spellings = [
    '{E7A81278-8635-4d9e-8D4D-59480B391C5B}', // as the platform writes it in a dashboard
    '{E7A81278-8635-4D9E-8D4D-59480B391C5B}',
    '{e7a81278-8635-4d9e-8d4d-59480b391c5b}',
    'E7A81278-8635-4D9E-8D4D-59480B391C5B',
    'e7a81278-8635-4d9e-8d4d-59480b391c5b',
  ];
  for (const type of ['list', 'chart']) {
    for (const classId of spellings) assert.strictEqual(hostsCustomControl({ type, classId }), false, `${type} on ${classId}`);
  }
});

test('a list or chart tile on any other class is hosted by a custom control', () => {
  const others = [CUSTOM, CUSTOM.toLowerCase(), CUSTOM.replace(/[{}]/g, ''), '{00000000-0000-4000-8000-000000000000}', '{E7A81278-8635-4D9E-8D4D-59480B391C5C}'];
  for (const type of ['list', 'chart']) {
    for (const classId of others) assert.strictEqual(hostsCustomControl({ type, classId }), true, `${type} on ${classId}`);
  }
});

test('a tile with no class is read as native, and a tile of any other type is never reported', () => {
  for (const component of [{ type: 'list' }, { type: 'chart' }, { type: 'chart', classId: '' }, { type: 'list', classId: null }, { type: 'chart', classId: '{}' }]) {
    assert.strictEqual(hostsCustomControl(component), false, JSON.stringify(component));
  }
  // The Assistant, a custom control that is no grid or chart, an iframe and a web resource keep the handling they always had.
  for (const type of ['assistant', 'unknown', 'iframe', 'webresource', 'timeline', 'powerbi', 'stream', undefined]) {
    assert.strictEqual(hostsCustomControl({ type, classId: CUSTOM }), false, String(type));
  }
  for (const component of [null, undefined, {}]) assert.strictEqual(hostsCustomControl(component), false, String(component));
});

test('the native class is the bare upper-case GUID the comparison makes of every spelling', () => {
  assert.strictEqual(NATIVE_GRID_CLASS_ID, 'E7A81278-8635-4D9E-8D4D-59480B391C5B');
});

test('the download and verify use this classification, and neither defines one of its own', () => {
  const scripts = path.resolve(__dirname, '..');
  for (const file of ['download-model-app.js', path.join('lib', 'verify-spec.js')]) {
    const source = fs.readFileSync(path.join(scripts, file), 'utf8');
    assert.match(source, /const \{ hostsCustomControl \} = require\('\.\/(?:lib\/)?dashboard-tiles\.js'\);/, `${file} requires lib/dashboard-tiles.js`);
    assert.match(source, /\bhostsCustomControl\(/, `${file} asks it`);
    assert.doesNotMatch(source, /\b(?:const|let|function)\s+(?:hostsCustomControl|NATIVE_GRID_CLASS_ID|bareClassId)\b/, `${file} keeps no copy of it`);
  }
});
