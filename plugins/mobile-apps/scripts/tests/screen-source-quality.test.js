'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { validateScreenSourceContract } = require('../lib/screen-source-contract');

function screen(overrides = {}) {
  return {
    id: 'EditAsset',
    route: '/(app)/assets/edit',
    role: 'key-flow',
    regions: [],
    firstViewport: { regionIds: [] },
    primaryAction: null,
    testIds: [],
    data: { entities: [], operations: [] },
    ...overrides,
  };
}

test('source quality accepts accessible input and reduced-motion handling', () => {
  const source = [
    'const reduceMotion = useReducedMotion();',
    'const entering = reduceMotion ? undefined : FadeIn;',
    'return <KeyboardAvoidingView>',
    '<TextInput accessibilityLabel="Asset name" />',
    '<Pressable accessibilityRole="button" accessibilityLabel="Save asset"><Icon /></Pressable>',
    '<Animated.View entering={entering} />',
    '</KeyboardAvoidingView>;',
  ].join('\n');
  assert.deepEqual(validateScreenSourceContract(source, screen()), []);
});

test('source quality rejects inaccessible controls, disabled Dynamic Type, and unguarded motion', () => {
  const source = [
    'return <YStack>',
    '<Text allowFontScaling={false}>Asset</Text>',
    '<TextInput />',
    '<Pressable width={24} height={24}><Icon /></Pressable>',
    '<Animated.View entering={FadeIn} />',
    '</YStack>;',
  ].join('\n');
  const rules = new Set(validateScreenSourceContract(source, screen()).map((issue) => issue.rule));
  assert.ok(rules.has('dynamic-type-disabled'));
  assert.ok(rules.has('keyboard-avoidance-missing'));
  assert.ok(rules.has('custom-control-role-missing'));
  assert.ok(rules.has('custom-control-label-missing'));
  assert.ok(rules.has('undersized-touch-target'));
  assert.ok(rules.has('reduced-motion-missing'));
});

test('declaring reduced-motion state without using it does not bypass animation validation', () => {
  const source = [
    'const reduceMotion = useReducedMotion();',
    'return <Animated.View entering={FadeIn} />;',
  ].join('\n');
  assert.ok(validateScreenSourceContract(source, screen()).some((issue) => issue.rule === 'reduced-motion-missing'));
});

test('an unrelated reduced-motion ternary does not guard an animation call', () => {
  const source = [
    'const reduceMotion = useReducedMotion();',
    'return <View>{reduceMotion ? null : null}<Button onPress={() => Animated.timing(value, {}).start()} /></View>;',
  ].join('\n');
  assert.ok(validateScreenSourceContract(source, screen()).some((issue) => issue.rule === 'reduced-motion-missing'));
});

test('reduced-motion branch cannot select a different animation', () => {
  const source = [
    'const reduceMotion = useReducedMotion();',
    'const entering = reduceMotion ? FadeIn : FadeOut;',
    'return <Animated.View entering={entering} />;',
  ].join('\n');
  assert.ok(validateScreenSourceContract(source, screen()).some((issue) => issue.rule === 'reduced-motion-missing'));
});

test('input accepts a labelled FormField or matching native label', () => {
  const formField = '<KeyboardAvoidingView><FormField label="Asset name"><Input /></FormField></KeyboardAvoidingView>';
  assert.equal(validateScreenSourceContract(formField, screen()).some((issue) => issue.rule === 'input-label-missing'), false);

  const nativeLabel = '<KeyboardAvoidingView><Label htmlFor="asset-name">Asset name</Label><TextInput nativeID="asset-name" /></KeyboardAvoidingView>';
  assert.equal(validateScreenSourceContract(nativeLabel, screen()).some((issue) => issue.rule === 'input-label-missing'), false);
});

test('empty and undefined input labels do not satisfy accessibility naming', () => {
  for (const input of [
    '<TextInput accessibilityLabel="" />',
    '<TextInput accessibilityLabel={undefined} />',
    '<TextInput accessibilityLabel={true ? "" : ""} />',
    '<FormField label={undefined}><Input /></FormField>',
  ]) {
    const source = `<KeyboardAvoidingView>${input}</KeyboardAvoidingView>`;
    assert.ok(validateScreenSourceContract(source, screen()).some((issue) => issue.rule === 'input-label-missing'));
  }
});

test('durable roots materialize labeled Profile access when Profile is not a destination', () => {
  const navigationContract = {
    globalRoutePolicy: {
      profileAccess: 'header-action',
      profileRoute: '/(app)/profile',
    },
  };
  const durable = screen({ navigation: { role: 'durable-destination' } });
  const valid = '<ScreenShell headerMode="root" title="Assets" rightAction={<Button accessibilityLabel="Open Profile" onPress={() => router.push("/(app)/profile")} />}><YStack /></ScreenShell>';
  assert.equal(validateScreenSourceContract(valid, durable, { navigationContract }).some((issue) => issue.rule === 'profile-header-action-missing'), false);

  const missing = '<ScreenShell headerMode="root" title="Assets"><YStack /></ScreenShell>';
  assert.ok(validateScreenSourceContract(missing, durable, { navigationContract }).some((issue) => issue.rule === 'profile-header-action-missing'));
});

test('sticky actions require calculated scroll, tab, and safe-area clearance', () => {
  const sticky = screen({
    primaryAction: {
      id: 'save-asset',
      label: 'Save asset',
      placement: 'sticky-bottom',
      clearance: { safeArea: true, tabBar: 'above' },
    },
    testIds: ['save-asset'],
  });
  const valid = [
    'const contentBottomInset = useBottomActionClearance({ actionHeight: 72, tabBarHeight: 64, spacing: 16 });',
    'return <ScreenShell scroll={false}>',
    '<ScrollView contentContainerStyle={{ paddingBottom: contentBottomInset }}><Text>Last record</Text></ScrollView>',
    '<BottomActionBar safeArea tabBarClearance="above"><Button testID="save-asset">Save asset</Button></BottomActionBar>',
    '</ScreenShell>;',
  ].join('\n');
  assert.deepEqual(validateScreenSourceContract(valid, sticky), []);

  const clipped = '<ScreenShell scroll={false}><ScrollView><Text>Last record</Text></ScrollView><BottomActionBar safeArea tabBarClearance="above"><Button testID="save-asset">Save asset</Button></BottomActionBar></ScreenShell>';
  const rules = new Set(validateScreenSourceContract(clipped, sticky).map((issue) => issue.rule));
  assert.ok(rules.has('sticky-content-clearance-missing'));
});

test('compiled route and operation actions require rendered controls and exact handlers', () => {
  const actionScreen = screen({
    actionBindings: [
      { id: 'open-detail', testId: 'action-open-detail', handlerName: 'handleOpenDetail', executor: { kind: 'route', intent: 'push', route: '/(app)/items/detail' } },
      { id: 'save-item', testId: 'action-save-item', handlerName: 'handleSaveItem', availabilityName: 'isSaveItemAvailable', availability: [{ reason: 'Complete the required value.' }], executor: { kind: 'operation', mode: 'mutation', hook: 'useSaveItem' } },
    ],
  });
  const valid = [
    'const saveItem = useSaveItem();',
    'const isSaveItemAvailable = Boolean(name);',
    'const handleOpenDetail = () => router.push("/(app)/items/detail");',
    'const handleSaveItem = () => saveItem.mutate({ name: "Draft" });',
    'return <YStack>',
    '<Button testID="action-open-detail" onPress={handleOpenDetail}>Open</Button>',
    '<Button testID="action-save-item" onPress={handleSaveItem} disabled={!isSaveItemAvailable}>Save</Button>',
    '<Text>Complete the required value.</Text>',
    '</YStack>;',
  ].join('\n');
  assert.deepEqual(validateScreenSourceContract(valid, actionScreen), []);

  const decorative = 'return <YStack><Button testID="action-open-detail">Open</Button><Button testID="action-save-item">Save</Button></YStack>;';
  const rules = new Set(validateScreenSourceContract(decorative, actionScreen).map((issue) => issue.rule));
  assert.ok(rules.has('action-handler-not-wired'));
  assert.ok(rules.has('action-handler-missing'));
  assert.ok(rules.has('action-route-not-executed'));
  assert.ok(rules.has('action-hook-missing'));
  assert.ok(rules.has('action-operation-not-executed'));

  const misplacedExecutors = [
    'const saveItem = useSaveItem();',
    'const isSaveItemAvailable = true;',
    'const handleOpenDetail = () => {};',
    'const handleSaveItem = () => {};',
    'const runSomethingElse = () => { router.push("/(app)/items/detail"); saveItem.mutate({}); };',
    'return <YStack>',
    '<Button testID="action-open-detail" onPress={handleOpenDetail}>Open</Button>',
    '<Button testID="action-save-item" onPress={handleSaveItem} disabled={!isSaveItemAvailable}>Save</Button>',
    '<Text>Complete the required value.</Text>',
    '</YStack>;',
  ].join('\n');
  const misplacedRules = new Set(validateScreenSourceContract(misplacedExecutors, actionScreen).map((issue) => issue.rule));
  assert.ok(misplacedRules.has('action-route-not-executed'));
  assert.ok(misplacedRules.has('action-operation-not-executed'));
});

test('compiled real-app actions require the collision-resolved generated service method', () => {
  const actionScreen = screen({
    actionBindings: [{
      id: 'save-choice', testId: 'action-save-choice', handlerName: 'handleSaveChoice', availability: [],
      executor: { kind: 'operation', provider: 'generated-service', service: 'Cr1_itemsv2Service', serviceMethod: 'create' },
    }],
  });
  const valid = [
    'const handleSaveChoice = async () => { const result = await Cr1_itemsv2Service.create({ cr1_name: name }); if (!result.success) throw new Error("Save failed"); };',
    'return <Button testID="action-save-choice" onPress={handleSaveChoice}>Save choice</Button>;',
  ].join('\n');
  assert.deepEqual(validateScreenSourceContract(valid, actionScreen), []);
  const guessed = valid.replace('Cr1_itemsv2Service.create', 'Cr1_itemsService.create');
  assert.ok(validateScreenSourceContract(guessed, actionScreen).some((issue) => issue.rule === 'action-service-not-executed'));
});

test('compiled local and host actions require their exact commands inside each handler', () => {
  const actionScreen = screen({
    actionBindings: [
      { id: 'select-mode', testId: 'action-select-mode', handlerName: 'handleSelectMode', availability: [], executor: { kind: 'local', commandName: 'executeSelectMode' } },
      { id: 'sign-out', testId: 'action-sign-out', handlerName: 'handleSignOut', availability: [], executor: { kind: 'host', commandName: 'executeHostSignOut' } },
    ],
  });
  const valid = [
    'const executeSelectMode = () => setMode("compact");',
    'const executeHostSignOut = signOut;',
    'const handleSelectMode = () => executeSelectMode();',
    'const handleSignOut = () => executeHostSignOut();',
    'return <YStack><Button testID="action-select-mode" onPress={handleSelectMode}>Mode</Button><Button testID="action-sign-out" onPress={handleSignOut}>Sign out</Button></YStack>;',
  ].join('\n');
  assert.deepEqual(validateScreenSourceContract(valid, actionScreen), []);
  const empty = valid.replace('const handleSignOut = () => executeHostSignOut();', 'const handleSignOut = () => {};');
  assert.ok(validateScreenSourceContract(empty, actionScreen).some((issue) => issue.rule === 'action-command-not-executed'));
});

test('compiled icon actions require the exact icon, accessible label, and bound badge value', () => {
  const actionScreen = screen({
    actionBindings: [{
      id: 'open-selection', testId: 'action-open-selection', handlerName: 'handleOpenSelection', availability: [],
      executor: { kind: 'route', intent: 'push', route: '/(app)/selection' },
      controlHint: {
        kind: 'icon-button', iconName: 'bag-handle-outline', labelMode: 'accessible-only',
        badge: { source: { kind: 'state', path: 'selectionCount' }, valueName: 'openSelectionBadgeValue' },
      },
    }],
  });
  const valid = [
    'const openSelectionBadgeValue = selectionCount;',
    'const handleOpenSelection = () => router.push("/(app)/selection");',
    'return <Button testID="action-open-selection" accessibilityLabel="Open selection" onPress={handleOpenSelection}>',
    '<Ionicons name="bag-handle-outline" /><Text>{openSelectionBadgeValue}</Text>',
    '</Button>;',
  ].join('\n');
  assert.deepEqual(validateScreenSourceContract(valid, actionScreen), []);
  const missing = valid
    .replace(' accessibilityLabel="Open selection"', '')
    .replace('bag-handle-outline', 'list-outline')
    .replace('<Text>{openSelectionBadgeValue}</Text>', '');
  const rules = new Set(validateScreenSourceContract(missing, actionScreen).map((issue) => issue.rule));
  assert.ok(rules.has('action-icon-not-rendered'));
  assert.ok(rules.has('action-accessible-label-missing'));
  assert.ok(rules.has('action-badge-not-rendered'));
});
