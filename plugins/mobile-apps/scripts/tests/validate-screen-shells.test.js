'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { validateScreenShells } = require('../validate-screen-shells');

function makeProject(context, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-screen-shells-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  return root;
}

function buildPack() {
  return JSON.stringify({
    fixtures: {
      assetManifest: 'assets/experience/manifest.json',
      viewModel: 'src/generated/experience-view-model.ts',
    },
    screens: [
      { route: '/(app)/home', file: 'app/(app)/home.tsx', headerMode: 'root' },
      { route: '/(app)/products/[id]', file: 'app/(app)/products/[id].tsx', headerMode: 'back' },
    ],
  });
}

const viewModelSource = [
  'export function toExperienceRecord() {}',
  'export function getExperienceAsset() {}',
  'export function isExperienceRecordActionable() {}',
  'export function relatedExperienceRecords() {}',
  '',
].join('\n');

test('accepts provider-only root layout and pack-matched route shells', (context) => {
  const root = makeProject(context, {
    '.tmp/screen-build-pack.json': buildPack(),
    'assets/experience/manifest.json': JSON.stringify({ assets: {}, fallbacks: {} }),
    'src/generated/experience-view-model.ts': viewModelSource,
    'app/_layout.tsx': "export default function Root() { return <SafeAreaProvider><Slot /></SafeAreaProvider>; }\n",
    'app/(app)/home.tsx': "import { ScreenShell } from '@/components'; export default function Home() { return <ScreenShell headerMode=\"root\" title=\"Home\" />; }\n",
    'app/(app)/products/[id].tsx': "import { ScreenShell } from '@/components'; export default function Detail() { return <ScreenShell headerMode=\"back\" title=\"Detail\" />; }\n",
  });

  assert.deepEqual(validateScreenShells(root), []);
});

test('reports root and route safe-area ownership plus header-mode drift', (context) => {
  const root = makeProject(context, {
    '.tmp/screen-build-pack.json': buildPack(),
    'assets/experience/manifest.json': JSON.stringify({ assets: {}, fallbacks: {} }),
    'src/generated/experience-view-model.ts': viewModelSource,
    'app/_layout.tsx': "export default function Root() { return <SafeAreaView><Slot /></SafeAreaView>; }\n",
    'app/(app)/home.tsx': "import { SafeAreaView } from 'react-native-safe-area-context'; export default function Home() { return <SafeAreaView />; }\n",
    'app/(app)/products/[id].tsx': "import { ScreenShell } from '@/components'; export default function Detail() { return <ScreenShell headerMode=\"root\" title=\"Detail\" />; }\n",
  });

  const rules = validateScreenShells(root).map((issue) => issue.rule);
  assert.ok(rules.includes('root-safe-area-slot-wrapper'));
  assert.ok(rules.includes('missing-screen-shell'));
  assert.ok(rules.includes('duplicate-route-safe-area'));
  assert.ok(rules.includes('header-mode-implementation-drift'));
});

test('fails closed when pack-declared media or view-model artifacts are absent', (context) => {
  const root = makeProject(context, {
    '.tmp/screen-build-pack.json': buildPack(),
    'app/_layout.tsx': "export default function Root() { return <SafeAreaProvider><Slot /></SafeAreaProvider>; }\n",
    'app/(app)/home.tsx': "import { ScreenShell } from '@/components'; export default function Home() { return <ScreenShell headerMode=\"root\" title=\"Home\" />; }\n",
    'app/(app)/products/[id].tsx': "import { ScreenShell } from '@/components'; export default function Detail() { return <ScreenShell headerMode=\"back\" title=\"Detail\" />; }\n",
  });

  const rules = validateScreenShells(root).map((issue) => issue.rule);
  assert.ok(rules.includes('missing-local-asset-manifest'));
  assert.ok(rules.includes('missing-experience-view-model'));
});
