'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  compileNavigationManifest,
} = require('../compile-navigation-manifest');
const { validateNavigationLayout } = require('../validate-navigation-layout');

const VECTOR_PACKAGE = {
  dependencies: { '@expo/vector-icons': '15.1.1' },
};

function screen(id, classification = 'durable-destination', overrides = {}) {
  return {
    id,
    route: `/${id}`,
    title: id.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join(' '),
    purpose: `Complete the ${id} job without leaving the approved product flow.`,
    userFacing: true,
    pattern: classification === 'nested-detail' ? 'detail' : 'overview',
    jobIds: [`${id}-job`],
    classification,
    justification: `The ${id} job needs this distinct product surface.`,
    ...overrides,
  };
}

function scope(overrides = {}) {
  const screens = overrides.screens || [
    screen('home'),
    screen('work'),
    screen('settings'),
  ];
  return {
    contractType: 'product-scope',
    screens,
    navigation: {
      pattern: 'tabs-plus-stacks',
      durableDestinationIds: screens
        .filter((item) => item.classification === 'durable-destination')
        .map((item) => item.id),
      visibleTabIds: ['home', 'work', 'settings'],
      authenticated: false,
      profileAccess: 'not-applicable',
      returnHomeMechanism: 'The Home tab returns to the primary product workspace.',
      ...overrides.navigation,
    },
  };
}

test('nested details inherit their canonical parent tab shell', () => {
  const source = scope({
    screens: [
      screen('home'),
      screen('work'),
      screen('settings'),
      screen('equipment-detail', 'nested-detail', {
        route: '/work/equipment/[equipmentId]',
        parentScreenId: 'work',
      }),
    ],
  });

  const manifest = compileNavigationManifest(source, VECTOR_PACKAGE);
  assert.deepEqual(manifest.visibleTabs.map((item) => item.destinationId), [
    'home',
    'work',
    'settings',
  ]);
  assert.deepEqual(manifest.screens['equipment-detail'], {
    parentTabId: 'work',
    tabVisible: true,
    headerMode: 'back',
    backBehavior: 'stack-pop',
    targetPath: '/work/equipment/[equipmentId]',
    hideTabsReason: null,
  });
});

test('authenticated Profile stays reachable without becoming a tab', () => {
  const source = scope({
    screens: [
      screen('home'),
      screen('work'),
      screen('settings'),
      screen('profile', 'nested-detail', { parentScreenId: 'settings' }),
    ],
    navigation: {
      authenticated: true,
      profileScreenId: 'profile',
      profileAccess: 'account-action',
    },
  });

  const manifest = compileNavigationManifest(source, VECTOR_PACKAGE);
  assert.equal(manifest.visibleTabs.some((item) => item.destinationId === 'profile'), false);
  assert.deepEqual(manifest.profile, {
    screenId: 'profile',
    access: 'account-action',
    visibleTab: false,
  });
});

test('Profile is a tab only when declared as a visible durable destination', () => {
  const source = scope({
    screens: [screen('home'), screen('work'), screen('profile')],
    navigation: {
      durableDestinationIds: ['home', 'work', 'profile'],
      visibleTabIds: ['home', 'work', 'profile'],
      authenticated: true,
      profileScreenId: 'profile',
      profileAccess: 'tab',
    },
  });

  const manifest = compileNavigationManifest(source, VECTOR_PACKAGE);
  assert.equal(manifest.visibleTabs.at(-1).destinationId, 'profile');
  assert.equal(manifest.profile.visibleTab, true);
});

test('stack-only manifests preserve a deterministic return mechanism', () => {
  const source = scope({
    screens: [
      screen('start'),
      screen('confirm', 'bounded-flow-step', { parentScreenId: 'start' }),
    ],
    navigation: {
      pattern: 'stack-only',
      durableDestinationIds: ['start'],
      visibleTabIds: [],
      stackOnlyReason: 'One bounded journey owns the complete application flow.',
      returnHomeMechanism: 'Completion or Back returns to Start.',
    },
  });

  const manifest = compileNavigationManifest(source, VECTOR_PACKAGE);
  assert.equal(manifest.pattern, 'stack-only');
  assert.equal(manifest.returnHomeMechanism, 'Completion or Back returns to Start.');
  assert.equal(manifest.screens.confirm.backBehavior, 'stack-pop');
});

test('drawer manifests preserve all declared durable destinations in order', () => {
  const screens = ['home', 'work', 'sites', 'reports', 'settings', 'history']
    .map((id) => screen(id));
  const source = scope({
    screens,
    navigation: {
      pattern: 'drawer',
      durableDestinationIds: screens.map((item) => item.id),
      visibleTabIds: [],
      drawerReason: 'Six independently revisited workspaces need a labeled hierarchy.',
    },
  });

  const manifest = compileNavigationManifest(source, VECTOR_PACKAGE);
  assert.deepEqual(
    manifest.durableDestinations.map((item) => item.destinationId),
    screens.map((item) => item.id),
  );
  assert.equal(manifest.visibleTabs.length, 0);
});

test('navigation compilation rejects a missing native icon package', () => {
  assert.throws(
    () => compileNavigationManifest(scope(), { dependencies: {} }),
    /@expo\/vector-icons/,
  );
});

test('navigation compilation rejects duplicate canonical route paths', () => {
  const source = scope({
    screens: [
      screen('home'),
      screen('work'),
      screen('settings'),
      screen('first-review', 'nested-detail', {
        route: '/work/review',
        parentScreenId: 'work',
      }),
      screen('second-review', 'nested-detail', {
        route: '/work/review/',
        parentScreenId: 'work',
      }),
    ],
  });
  assert.throws(
    () => compileNavigationManifest(source, VECTOR_PACKAGE),
    /first-review and second-review claim the same route \/work\/review/,
  );
});

function write(projectRoot, relativePath, content = 'export default function Screen() { return null; }\n') {
  const file = path.join(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function tabsProject(manifest) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'navigation-layout-'));
  write(projectRoot, '.tmp/navigation-manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  write(projectRoot, 'app/(app)/_layout.tsx', `
    import { Tabs } from 'expo-router';
    import { Ionicons } from '@expo/vector-icons';
    export default function Layout() {
      return <Tabs>
        <Tabs.Screen name="home" options={{ tabBarIcon: () => <Ionicons name="home-outline" /> }} />
        <Tabs.Screen name="work" options={{ tabBarIcon: () => <Ionicons name="clipboard-outline" /> }} />
        <Tabs.Screen name="settings" options={{ tabBarIcon: () => <Ionicons name="settings-outline" /> }} />
      </Tabs>;
    }
  `);
  write(projectRoot, 'app/(app)/home.tsx');
  write(projectRoot, 'app/(app)/work/index.tsx');
  write(projectRoot, 'app/(app)/work/_layout.tsx', `
    import { Stack } from 'expo-router';
    export default function WorkLayout() {
      return <Stack><Stack.Screen name="index" /><Stack.Screen name="equipment/[equipmentId]" /></Stack>;
    }
  `);
  write(projectRoot, 'app/(app)/work/equipment/[equipmentId].tsx');
  write(projectRoot, 'app/(app)/settings/index.tsx');
  write(projectRoot, 'app/(app)/settings/_layout.tsx', `
    import { Stack } from 'expo-router';
    export default function SettingsLayout() {
      return <Stack><Stack.Screen name="index" /><Stack.Screen name="profile" /></Stack>;
    }
  `);
  write(projectRoot, 'app/(app)/settings/profile.tsx');
  return projectRoot;
}

test('generated Expo tabs and nested routes match the manifest', (context) => {
  const source = scope({
    screens: [
      screen('home'),
      screen('work'),
      screen('settings'),
      screen('equipment-detail', 'nested-detail', {
        route: '/work/equipment/[equipmentId]',
        parentScreenId: 'work',
      }),
      screen('profile', 'nested-detail', {
        route: '/settings/profile',
        parentScreenId: 'settings',
      }),
    ],
    navigation: {
      authenticated: true,
      profileScreenId: 'profile',
      profileAccess: 'account-action',
    },
  });
  const manifest = compileNavigationManifest(source, VECTOR_PACKAGE);
  const projectRoot = tabsProject(manifest);
  context.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

  const result = validateNavigationLayout(projectRoot, manifest);
  assert.deepEqual(result.errors, []);
  assert.equal(result.summary.visibleDestinationCount, 3);
  assert.equal(result.summary.routeCount, 5);
});

test('layout validation rejects duplicate planned routes in a hand-edited manifest', (context) => {
  const source = scope({
    screens: [
      screen('home'),
      screen('work'),
      screen('settings'),
      screen('equipment-detail', 'nested-detail', {
        route: '/work/equipment/[equipmentId]',
        parentScreenId: 'work',
      }),
    ],
  });
  const manifest = compileNavigationManifest(source, VECTOR_PACKAGE);
  manifest.screens.settings.targetPath = '/work';
  const projectRoot = tabsProject(manifest);
  context.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

  const result = validateNavigationLayout(projectRoot, manifest);
  assert.ok(result.errors.some((item) => item.code === 'duplicate-planned-route'));
});

test('layout validation rejects missing tabs, wrong icons, and phantom entries', (context) => {
  const source = scope({
    screens: [screen('home'), screen('work'), screen('settings')],
  });
  const manifest = compileNavigationManifest(source, VECTOR_PACKAGE);
  const projectRoot = tabsProject(manifest);
  context.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  write(projectRoot, 'app/(app)/_layout.tsx', `
    import { Tabs } from 'expo-router';
    export default function Layout() {
      return <Tabs>
        <Tabs.Screen name="home" options={{ tabBarIcon: () => 'wrong-icon' }} />
        <Tabs.Screen name="settings" />
        <Tabs.Screen name="extra" />
      </Tabs>;
    }
  `);
  write(projectRoot, 'app/(app)/extra.tsx');

  const result = validateNavigationLayout(projectRoot, manifest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.code === 'missing-visible-destination'));
  assert.ok(result.errors.some((item) => item.code === 'navigation-icon-mismatch'));
  assert.ok(result.errors.some((item) => item.code === 'phantom-visible-destination'));
});
