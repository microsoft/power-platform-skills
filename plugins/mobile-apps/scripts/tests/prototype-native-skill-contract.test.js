'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const policy = require('../native-capabilities.json');
const { photoCaptureSource } = require('../lib/prototype-generator');

const root = path.resolve(__dirname, '../..');
const skill = fs.readFileSync(path.join(root, 'skills/add-native/SKILL.md'), 'utf8');
const helper = fs.readFileSync(path.join(root, 'skills/add-native/add-camera/SKILL.md'), 'utf8');
const table = skill.slice(skill.indexOf('## Supported capabilities'));
const row = (id) => table.split('\n').find((line) => line.startsWith(`| \`${id}\``));

test('camera and gallery skill outputs match the actual shared wrapper and catalogue paths', () => {
  for (const id of ['camera', 'image-picker']) {
    const entry = policy.capabilities.find((item) => item.id === id);
    assert.equal(entry.wrapper, 'src/native/camera.ts');
    assert.ok(row(id).includes(`| \`${entry.wrapper}\` |`));
    assert.ok(row(id).includes(`| \`${entry.package}\` |`));
  }
  assert.doesNotMatch(row('image-picker'), /imagePicker\.ts/);
  const source = helper.match(/Create `src\/native\/camera\.ts`[\s\S]*?```typescript\n([\s\S]*?)\n```/)?.[1];
  assert.ok(source, 'The routed helper must contain its actual shared implementation');
  assert.match(source, /import \* as ImagePicker from 'expo-image-picker'/);
  assert.match(source, /export async function takePhoto\(/);
  assert.match(source, /export async function pickImage\(/);
});

test('prototype gallery capture remains separately enabled through the real compiler', () => {
  const entry = policy.capabilities.find((item) => item.id === 'image-picker');
  assert.equal(entry.prototypeWrapper, 'src/data/capture.ts');
  const gallery = photoCaptureSource({ nativeCapabilities: [{ id: 'image-picker' }] });
  const disabled = photoCaptureSource({ nativeCapabilities: [] });
  assert.match(gallery, /allowedSources: \["library"\]/);
  assert.match(disabled, /allowedSources: \[\]/);
  assert.doesNotMatch(disabled, /import \* as ImagePicker/);
  assert.doesNotMatch(gallery, /src\/native\/imagePicker/);
});

test('date-time-picker remains explicit screen usage, never an invented wrapper', () => {
  const entry = policy.capabilities.find((item) => item.id === 'date-time-picker');
  assert.equal(entry.wrapper, undefined);
  assert.match(row('date-time-picker'), /screen-level component usage/);
  assert.match(row('date-time-picker'), /explicitly selected approved form screen/);
  assert.match(row('date-time-picker'), /no `\/add-native` wrapper/);
});
