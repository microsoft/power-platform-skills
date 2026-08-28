'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '../..');
const read = (relativePath) => fs.readFileSync(path.join(pluginRoot, relativePath), 'utf8');

test('Home launches scanner workflows without embedding the live viewfinder', () => {
  const planner = read('agents/screen-planner.md');
  const builder = read('agents/screen-builder.md');
  const templates = read('shared/references/screen-templates.md');
  const philosophy = read('shared/references/mobile-design-philosophy.md');
  const cameraSkill = read('skills/add-native/add-camera/SKILL.md');

  assert.match(planner, /Home may expose a clearly labeled[\s\S]+must never mount[\s\S]+BarcodeScannerView/);
  assert.match(planner, /Scanner surface[\s\S]+`dedicated-full-screen`[\s\S]+`scan-geofence-gate`/);
  assert.match(builder, /may mount[\s\S]+`BarcodeScannerView` only when its own per-screen spec declares[\s\S]+`Scanner surface: dedicated-full-screen`/);
  assert.match(builder, /Never import or render raw `CameraView` in a screen/);
  assert.match(templates, /`scan-geofence-gate`[\s\S]+never use this pattern on Home/);
  assert.match(philosophy, /Home may launch a scan flow, but it never contains the live camera or barcode/);
  assert.match(cameraSkill, /approved per-screen spec must declare[\s\S]+`Scanner surface: dedicated-full-screen`/);
});

test('Expo drawer navigation is dependency-backed and selected without a five-tab ambiguity', () => {
  const packageJson = JSON.parse(read('template/package.json'));
  const planner = read('agents/screen-planner.md');
  const orchestrator = read('skills/create-mobile-app/SKILL.md');
  const sample = read('shared/samples/_layout-drawer.tsx');

  assert.strictEqual(packageJson.dependencies['@react-navigation/drawer'], '7.13.9');
  assert.match(planner, /\*\*Tabs\*\* \| 3–5 top-level destinations/);
  assert.match(planner, /\*\*Drawer\*\* \| 6\+ top-level destinations/);
  assert.match(planner, /Use Tabs for five peer destinations[\s\S]+Drawer when hierarchy/);
  assert.match(orchestrator, /import \{ Drawer \} from 'expo-router\/drawer'/);
  assert.match(orchestrator, /headerShown: true/);
  assert.match(orchestrator, /import \{ DrawerToggleButton \} from '@react-navigation\/drawer'/);
  assert.match(orchestrator, /Add `headerShown: false` to every folder-backed/);
  assert.match(sample, /template-pinned @react-navigation\/drawer/);
  assert.match(sample, /drawerActiveTintColor: theme\.accentBase/);
  assert.match(sample, /headerShown: false/);
});
