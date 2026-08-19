'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const script = path.resolve(__dirname, '..', '..', 'skills', 'create-mobile-prototype', 'scripts', 'configure-prototype-runtime.js');

function makeProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prototype-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = {
    'package.json': JSON.stringify({ name: 'field-inspection', scripts: { dev: 'expo start', predev: 'npm run generate-schemas' } }, null, 2),
    'app/index.tsx': `import { Redirect } from 'expo-router';\nimport { useAuth } from '@microsoft/power-apps-native-host';\nexport default function Index() {\n  const { isLoading, isSignedIn } = useAuth();\n  if (isLoading) return null;\n  return isSignedIn ? <Redirect href="/(app)/home" /> : <Redirect href="/login" />;\n}\n`,
    'app/(app)/_layout.tsx': `import { Redirect, Stack } from 'expo-router';\nimport { useAuth } from '@microsoft/power-apps-native-host';\nexport default function AppLayout() {\n  const { isSignedIn, isLoading } = useAuth();\n  if (!isLoading && !isSignedIn) {\n    return <Redirect href="/login" />;\n  }\n  return <Stack />;\n}\n`,
  };
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
  }
  return root;
}

function run(root, mode, route) {
  return spawnSync(process.execPath, [script, root, mode, ...(route ? [route] : [])], { encoding: 'utf8' });
}

test('enables a no-auth local prototype runtime idempotently', (t) => {
  const root = makeProject(t);
  const first = run(root, 'prototype', '/(app)/inspections');
  assert.equal(first.status, 0, first.stderr);

  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.match(packageJson.scripts.predev, /prototype mode/);
  assert.match(fs.readFileSync(path.join(root, 'src/config/dataMode.ts'), 'utf8'), /dataMode: 'prototype' \| 'dataverse' = 'prototype'/);
  assert.match(fs.readFileSync(path.join(root, 'src/config/dataMode.ts'), 'utf8'), /\/\(app\)\/inspections/);
  assert.match(fs.readFileSync(path.join(root, 'app/index.tsx'), 'utf8'), /dataMode === 'prototype'/);
  assert.match(fs.readFileSync(path.join(root, 'app/(app)/_layout.tsx'), 'utf8'), /dataMode !== 'prototype'/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'power.config.json'), 'utf8')).databaseReferences, {});
  assert.equal(fs.existsSync(path.join(root, 'src/generated/connectorSchemas.ts')), true);

  const second = run(root, 'prototype', '/(app)/inspections');
  assert.equal(second.status, 0, second.stderr);
  assert.equal((fs.readFileSync(path.join(root, 'app/index.tsx'), 'utf8').match(/dataMode === 'prototype'/g) || []).length, 1);
});

test('switches to Dataverse mode and restores the original predev command', (t) => {
  const root = makeProject(t);
  assert.equal(run(root, 'prototype').status, 0);

  const result = run(root, 'dataverse');
  assert.equal(result.status, 0, result.stderr);
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts.predev, 'npm run generate-schemas');
  assert.match(fs.readFileSync(path.join(root, 'src/config/dataMode.ts'), 'utf8'), /dataMode: 'prototype' \| 'dataverse' = 'dataverse'/);
  assert.match(fs.readFileSync(path.join(root, 'app/index.tsx'), 'utf8'), /dataMode === 'prototype'/);
});

test('refuses to restore without a recorded runtime backup', (t) => {
  const root = makeProject(t);
  const result = run(root, 'dataverse');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /runtime-backup\.json is missing/);
});