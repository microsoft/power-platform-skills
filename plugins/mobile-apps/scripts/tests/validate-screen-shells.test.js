'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { validateScreenShells } = require('../validate-screen-shells');
const { applyNavigationShell } = require('../apply-navigation-shell');

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
      dataModule: 'src/data/index.ts',
    },
    screens: [
      { route: '/(app)/home', file: 'app/(app)/home.tsx', headerMode: 'root' },
      { route: '/(app)/products/[id]', file: 'app/(app)/products/[id].tsx', headerMode: 'back' },
    ],
  });
}

const dataModuleSource = [
  "export { resolveDomainMedia } from './media';",
  "export { PrototypeDataProvider } from './PrototypeDataProvider';",
  'export function isDomainRecordActionable() { return true; }',
  '',
].join('\n');

test('accepts provider-only root layout and pack-matched route shells', (context) => {
  const root = makeProject(context, {
    '.tmp/screen-build-pack.json': buildPack(),
    'assets/experience/manifest.json': JSON.stringify({ assets: {}, fallbacks: {} }),
    'src/data/index.ts': dataModuleSource,
    'src/data/PrototypeDataProvider.tsx': 'export function PrototypeDataProvider({ children }) { return children; }\n',
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
    'src/data/index.ts': dataModuleSource,
    'src/data/PrototypeDataProvider.tsx': 'export function PrototypeDataProvider({ children }) { return children; }\n',
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

test('fails closed when pack-declared media or domain data artifacts are absent', (context) => {
  const root = makeProject(context, {
    '.tmp/screen-build-pack.json': buildPack(),
    'app/_layout.tsx': "export default function Root() { return <SafeAreaProvider><Slot /></SafeAreaProvider>; }\n",
    'app/(app)/home.tsx': "import { ScreenShell } from '@/components'; export default function Home() { return <ScreenShell headerMode=\"root\" title=\"Home\" />; }\n",
    'app/(app)/products/[id].tsx': "import { ScreenShell } from '@/components'; export default function Detail() { return <ScreenShell headerMode=\"back\" title=\"Detail\" />; }\n",
  });

  const rules = validateScreenShells(root).map((issue) => issue.rule);
  assert.ok(rules.includes('missing-local-asset-manifest'));
  assert.ok(rules.includes('missing-domain-data-module'));
});

test('composes deterministic navigation shell validation and catches shared-layout drift', (context) => {
  const navigation = {
    schemaVersion: 1,
    model: 'stack',
    initialDestinationId: 'home',
    destinationCount: 1,
    destinations: [{ id: 'home', label: 'Home', purpose: 'Open Home', order: 1, rootScreenId: 'Home', route: '/(app)/home', iconIntent: 'home', durabilityEvidence: ['hasStableRoot'], independentJob: true, statePolicy: 'preserve', badgeBinding: null, nestedScreenIds: ['ProductDetail'], testId: 'navigation-destination-home' }],
    flows: [{ id: 'flow-product-detail', ownerDestinationId: 'home', presentation: 'nested-stack', screenIds: ['ProductDetail'], tabVisibility: 'not-applicable', dismissBehavior: 'nearest-stack-back', completionDestinationId: 'home', cancelDestinationId: 'home', deepLinkRestoration: 'activate-owner-and-build-back-path' }],
    accessibility: { labelsRequired: true, selectedStateRequired: true, badgesHaveAccessibleValues: true, minimumTouchTarget: 44 },
  };
  const screens = { screens: [
    { id: 'Home', route: '/(app)/home', file: 'app/(app)/home.tsx', navigation: { kind: 'stack-root' } },
    { id: 'ProductDetail', route: '/(app)/products/[id]', file: 'app/(app)/products/[id].tsx', navigation: { kind: 'pushed', presentation: 'nested-stack' } },
  ] };
  const root = makeProject(context, {
    '.tmp/screen-build-pack.json': buildPack(),
    '.tmp/navigation-contract.json': JSON.stringify(navigation),
    '.tmp/experience-screen-contract.json': JSON.stringify(screens),
    'package.json': '{"dependencies":{"expo-router":"55.0.14"}}',
    'assets/experience/manifest.json': JSON.stringify({ assets: {}, fallbacks: {} }),
    'src/data/index.ts': dataModuleSource,
    'src/data/PrototypeDataProvider.tsx': 'export function PrototypeDataProvider({ children }) { return children; }\n',
    'app/_layout.tsx': 'export default function Root() { return <SafeAreaProvider><Slot /></SafeAreaProvider>; }\n',
    'app/(app)/_layout.tsx': "import { Stack } from 'expo-router/stack';\nexport default function AppLayout() {\n  return (<Stack />);\n}\n",
    'app/(app)/home.tsx': "import { ScreenShell } from '@/components'; export default function Home() { return <ScreenShell headerMode=\"root\" title=\"Home\" />; }\n",
    'app/(app)/products/[id].tsx': "import { ScreenShell } from '@/components'; export default function Detail() { return <ScreenShell headerMode=\"back\" title=\"Detail\" />; }\n",
  });
  applyNavigationShell(root, navigation, screens);
  assert.deepEqual(validateScreenShells(root), []);
  fs.appendFileSync(path.join(root, 'src/navigation/AppNavigationShell.tsx'), '\n// drift\n');
  assert.ok(validateScreenShells(root).some((issue) => issue.rule === 'navigation-shell-file-drift'));
});
