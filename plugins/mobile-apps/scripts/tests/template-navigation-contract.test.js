'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '..', '..');

test('template installs every runtime dependency imported by generated navigation shells', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'template', 'package.json'), 'utf8'));
  assert.equal(packageJson.dependencies['expo-router'], '55.0.14');
  assert.equal(packageJson.dependencies['@expo/vector-icons'], '15.1.1');
  assert.equal(packageJson.dependencies['@react-navigation/drawer'], '7.9.4');
  assert.ok(packageJson.dependencies['react-native-gesture-handler']);
  assert.ok(packageJson.dependencies['react-native-reanimated']);
  assert.ok(packageJson.dependencies['react-native-worklets']);
});

test('drawer sample and creation workflow use the dependency-protected Expo Router entry point', () => {
  const sample = fs.readFileSync(path.join(pluginRoot, 'shared', 'samples', '_layout-drawer.tsx'), 'utf8');
  const workflow = fs.readFileSync(path.join(pluginRoot, 'skills', 'create-mobile-app', 'SKILL.md'), 'utf8');
  const protectedLayout = fs.readFileSync(path.join(pluginRoot, 'template', 'app', '(app)', '_layout.tsx'), 'utf8');
  assert.match(sample, /from 'expo-router\/drawer'/);
  assert.match(protectedLayout, /from 'expo-router\/stack'/);
  assert.match(workflow, /from 'expo-router\/tabs'/);
  assert.match(workflow, /from 'expo-router\/stack'/);
  assert.match(workflow, /from 'expo-router\/drawer'/);
  assert.doesNotMatch(`${sample}\n${protectedLayout}`, /import \{ (?:Stack|Tabs|Drawer) \} from 'expo-router'/);
  assert.doesNotMatch(sample, /do NOT add it manually/i);
});