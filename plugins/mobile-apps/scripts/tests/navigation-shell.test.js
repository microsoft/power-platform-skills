'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { applyNavigationShell, navigationShellArtifacts } = require('../apply-navigation-shell');
const { validateNavigationShell } = require('../validate-navigation-shell');

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'navigation-shell-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'app', '(app)'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { 'expo-router': '55.0.14', '@expo/vector-icons': '15.1.1', '@react-navigation/drawer': '7.9.4' } }));
  fs.writeFileSync(path.join(root, 'app', '(app)', '_layout.tsx'), `import { Redirect } from 'expo-router';
import { Stack } from 'expo-router/stack';
import { useAuth } from '@microsoft/power-apps-native-host';
export default function AppLayout() {
  const { isSignedIn, isLoading } = useAuth();
  if (!isLoading && !isSignedIn) return <Redirect href="/login" />;
  return (<Stack screenOptions={{ headerShown: false }} />);
}
`);
  return root;
}

function navigation(model = 'tabs-stack') {
  const destinations = [
    ['home', 'Home', '/(app)/home', 'Home', 'home'],
    ['records', 'Records', '/(app)/records', 'Records', 'list'],
    ['drafts', 'Drafts', '/(app)/drafts', 'Drafts', 'draft'],
  ].map(([id, label, route, rootScreenId, iconIntent], index) => ({ id, label, purpose: `Open ${label}`, order: index + 1, rootScreenId, route, iconIntent, durabilityEvidence: ['hasStableRoot'], independentJob: true, statePolicy: 'preserve', badgeBinding: null, nestedScreenIds: id === 'records' ? ['RecordDetail'] : [], testId: `navigation-destination-${id}` }));
  return {
    schemaVersion: 1, model, initialDestinationId: 'home', destinationCount: destinations.length, destinations,
    flows: [{ id: 'flow-record-detail', ownerDestinationId: 'records', presentation: 'nested-stack', screenIds: ['RecordDetail'], tabVisibility: 'visible', dismissBehavior: 'nearest-stack-back', completionDestinationId: 'records', cancelDestinationId: 'records', deepLinkRestoration: 'activate-owner-and-build-back-path' }],
    accessibility: { labelsRequired: true, selectedStateRequired: true, badgesHaveAccessibleValues: true, minimumTouchTarget: 44 },
  };
}

function screens() {
  return {
    screens: [
      { id: 'Home', route: '/(app)/home', file: 'app/(app)/home.tsx', navigation: { kind: 'tab-root' } },
      { id: 'Records', route: '/(app)/records', file: 'app/(app)/records/index.tsx', navigation: { kind: 'tab-root' } },
      { id: 'Drafts', route: '/(app)/drafts', file: 'app/(app)/drafts.tsx', navigation: { kind: 'tab-root' } },
      { id: 'RecordDetail', route: '/(app)/records/[id]', file: 'app/(app)/records/[id].tsx', navigation: { kind: 'pushed', presentation: 'nested-stack' } },
      { id: 'Capture', route: '/(app)/capture', file: 'app/(app)/capture.tsx', navigation: { kind: 'modal', presentation: 'full-screen-modal' } },
    ],
  };
}

test('applies labeled tabs, inner stacks, and hidden temporary routes without changing auth guard', (t) => {
  const root = project(t);
  const contract = navigation();
  const screenContract = screens();
  applyNavigationShell(root, contract, screenContract);
  const shell = fs.readFileSync(path.join(root, 'src/navigation/AppNavigationShell.tsx'), 'utf8');
  assert.match(shell, /<Tabs/);
  assert.match(shell, /from 'expo-router\/tabs'/);
  assert.match(shell, /tabBarAccessibilityLabel: "Records"/);
  assert.match(shell, /tabBarTestID: "navigation-destination-records"/);
  assert.match(shell, /name="capture" options=\{\{ href: null \}\}/);
  assert.equal(fs.existsSync(path.join(root, 'app/(app)/records/_layout.tsx')), true);
  assert.match(fs.readFileSync(path.join(root, 'app/(app)/records/_layout.tsx'), 'utf8'), /from 'expo-router\/stack'/);
  const layout = fs.readFileSync(path.join(root, 'app/(app)/_layout.tsx'), 'utf8');
  assert.match(layout, /useAuth/);
  assert.match(layout, /<Redirect href="\/login"/);
  assert.match(layout, /<AppNavigationShell \/>/);
  assert.deepEqual(validateNavigationShell(root, contract, screenContract), []);
});

test('shell validation catches a builder edit to shared navigation', (t) => {
  const root = project(t);
  const contract = navigation();
  const screenContract = screens();
  applyNavigationShell(root, contract, screenContract);
  fs.appendFileSync(path.join(root, 'src/navigation/AppNavigationShell.tsx'), '\n// screen-builder edit\n');
  assert.ok(validateNavigationShell(root, contract, screenContract).some((item) => item.rule === 'navigation-shell-file-drift'));
});

test('generated navigators use Expo Router subpath entry points', () => {
  const screenContract = screens();
  const sourceFor = (model) => navigationShellArtifacts(navigation(model), screenContract)['src/navigation/AppNavigationShell.tsx'];
  assert.match(sourceFor('tabs-stack'), /from 'expo-router\/tabs'/);
  assert.match(sourceFor('drawer'), /from 'expo-router\/drawer'/);
  assert.match(sourceFor('stack'), /from 'expo-router\/stack'/);
  assert.doesNotMatch([sourceFor('tabs-stack'), sourceFor('drawer'), sourceFor('stack')].join('\n'), /from 'expo-router';/);
});

test('drawer shell requires the template-pinned navigation client', (t) => {
  const root = project(t);
  const packagePath = path.join(root, 'package.json');
  fs.writeFileSync(packagePath, '{"dependencies":{"expo-router":"55.0.14","@expo/vector-icons":"15.1.1"}}');
  assert.throws(() => applyNavigationShell(root, navigation('drawer'), screens()), /@react-navigation\/drawer@7\.9\.4/);
});

test('navigation shell preflights every generated runtime import', (t) => {
  const root = project(t);
  const packagePath = path.join(root, 'package.json');
  fs.writeFileSync(packagePath, '{"dependencies":{}}');
  assert.throws(() => applyNavigationShell(root, navigation('stack'), screens()), /install expo-router/);
  fs.writeFileSync(packagePath, '{"dependencies":{"expo-router":"55.0.14"}}');
  assert.throws(() => applyNavigationShell(root, navigation(), screens()), /install @expo\/vector-icons/);
});