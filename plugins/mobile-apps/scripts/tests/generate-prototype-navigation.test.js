'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const script = path.resolve(__dirname, '..', 'generate-prototype-navigation.js');

function plan(rows, contracts) {
  return `# Test app\n\n## Screens\n\n### Navigation Pattern\n\n**Tabs + Stack**\n\n### Screen Map\n\n| Screen | Route | File | Presentation | Archetype | Purpose | Data | Native | Source |\n|---|---|---|---|---|---|---|---|---|\n${rows.join('\n')}\n\n### Navigation Contracts\n\n| Route | Path params | Query params (union across all senders) | Intent | Returns to caller |\n|---|---|---|---|---|\n${contracts.join('\n')}\n\n### Per-Screen Specs\n`;
}

function project(t, markdown) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prototype-navigation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'app', '(app)'), { recursive: true });
  fs.mkdirSync(path.join(root, 'brand'), { recursive: true });
  fs.writeFileSync(path.join(root, 'native-app-plan.md'), markdown);
  fs.writeFileSync(path.join(root, 'brand', 'tokens.ts'), 'export const tokens = { color: { primary: "#000", textMuted: "#555" }, size: { iconSize: 24 } } as const;\n');
  fs.writeFileSync(path.join(root, 'app', '(app)', '_layout.tsx'), `import { Redirect, Stack } from 'expo-router';\nimport { useAuth } from '@microsoft/power-apps-native-host';\nimport { dataMode } from '../../src/config/dataMode';\n\nexport default function AppLayout() {\n  const { isSignedIn, isLoading } = useAuth();\n  if (dataMode !== 'prototype' && !isLoading && !isSignedIn) return <Redirect href="/login" />;\n  return (\n    <Stack screenOptions={{ headerShown: false }} />\n  );\n}\n`);
  return root;
}

test('generates noun-labelled tabs from navigation contracts using brand tokens', (t) => {
  const root = project(t, plan([
    '| Inspections | `/(app)/inspections` | `app/(app)/inspections/index.tsx` | default | Tab-root | Queue | local | - | new |',
    '| Inspection detail | `/(app)/inspections/[id]` | `app/(app)/inspections/[id].tsx` | default | Detail | Detail | local | - | new |',
    '| Assets | `/(app)/assets` | `app/(app)/assets.tsx` | default | Tab-root | Assets | local | - | new |',
    '| Profile | `/(app)/profile` | `app/(app)/profile.tsx` | default | Tab-root | Profile | local | - | new |',
  ], [
    '| `/(app)/inspections` | - | - | `navigate` | Tab root |',
    '| `/(app)/inspections/[id]` | `id: string` | - | `push` | Back |',
    '| `/(app)/assets` | - | - | `navigate` | Tab root |',
    '| `/(app)/profile` | - | - | `navigate` | Tab root |',
  ]));
  const result = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const layout = fs.readFileSync(path.join(root, 'app', '(app)', '_layout.tsx'), 'utf8');
  assert.match(layout, /title: "Inspections"/);
  assert.match(layout, /title: "Assets"/);
  assert.match(layout, /title: "Profile"/);
  assert.match(layout, /tabBarActiveTintColor: tokens\.color\.primary/);
  assert.match(layout, /tabBarInactiveTintColor: tokens\.color\.textMuted/);
  assert.match(layout, /tabBarTestID: "device-tab:inspections"/);
  assert.match(layout, /tabBarTestID: "device-tab:assets"/);
  assert.doesNotMatch(layout, /statusSuccess|statusWarning|statusDanger|statusInfo/);
  assert.match(layout, /dataMode !== 'prototype'/);
  const inner = fs.readFileSync(path.join(root, 'app', '(app)', 'inspections', '_layout.tsx'), 'utf8');
  assert.match(inner, /Stack\.Screen name="index"/);
  assert.match(inner, /Stack\.Screen name="\[id\]"/);
});

test('rejects more than one furniture tab before writing', (t) => {
  const root = project(t, plan([
    '| Home | `/(app)/home` | `app/(app)/home.tsx` | default | Tab-root | Home | local | - | new |',
    '| Profile | `/(app)/profile` | `app/(app)/profile.tsx` | default | Tab-root | Profile | local | - | new |',
  ], [
    '| `/(app)/home` | - | - | `navigate` | Tab root |',
    '| `/(app)/profile` | - | - | `navigate` | Tab root |',
  ]));
  const before = fs.readFileSync(path.join(root, 'app', '(app)', '_layout.tsx'), 'utf8');
  const result = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /at most one furniture tab/);
  assert.equal(fs.readFileSync(path.join(root, 'app', '(app)', '_layout.tsx'), 'utf8'), before);
});

test('rejects command-style tab labels and non-navigate tab contracts', (t) => {
  const verbRoot = project(t, plan([
    '| Manage Assets | `/(app)/assets` | `app/(app)/assets.tsx` | default | Tab-root | Assets | local | - | new |',
  ], ['| `/(app)/assets` | - | - | `navigate` | Tab root |']));
  const verb = spawnSync(process.execPath, [script, verbRoot], { encoding: 'utf8' });
  assert.equal(verb.status, 1);
  assert.match(verb.stderr, /starts with a command/);

  const intentRoot = project(t, plan([
    '| Assets | `/(app)/assets` | `app/(app)/assets.tsx` | default | Tab-root | Assets | local | - | new |',
  ], ['| `/(app)/assets` | - | - | `push` | Back |']));
  const intent = spawnSync(process.execPath, [script, intentRoot], { encoding: 'utf8' });
  assert.equal(intent.status, 1);
  assert.match(intent.stderr, /must use navigate intent/);
});