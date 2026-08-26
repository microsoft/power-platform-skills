'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { jsxElements, validateCompositionSource, validateScreenSourceContract } = require('../lib/screen-source-contract');

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

test('primary composition requires authored density, domain metadata, and no floating settings action', () => {
  const composition = {
    id: 'resumable-work-home',
    markerTestId: 'composition-recipe-resumable-work-home',
    requiredCardRecipeTestIds: ['composition-card-resume-card'],
    minimumVisibleRecords: 2,
    requiredMetadata: ['status', 'next-action'],
    requireCollectionBinding: true,
    maxStepperStages: 4,
    forbidFloatingUtilityActions: true,
  };
  const primary = screen({ role: 'primary' });
  const valid = [
    '<YStack testID="composition-recipe-resumable-work-home">',
    '{records.map((record) => <RecordRow key={record.id} testID="composition-card-resume-card" status={record.status} accessibilityLabel="Resume next action" />)}',
    '</YStack>',
  ].join('\n');
  const validIssues = [];
  validateCompositionSource(valid, primary, jsxElements(valid), validIssues, { designRecipe: { composition } });
  assert.deepEqual(validIssues, []);

  const sparse = [
    '<YStack>',
    '<StatusSummary>Summary</StatusSummary>',
    '<FloatingActionButton accessibilityLabel="Settings" style={{ position: "absolute" }} />',
    '</YStack>',
  ].join('\n');
  const sparseIssues = [];
  validateCompositionSource(sparse, primary, jsxElements(sparse), sparseIssues, { designRecipe: { composition } });
  const rules = new Set(sparseIssues.map((issue) => issue.rule));
  assert.ok(rules.has('composition-recipe-marker-missing'));
  assert.ok(rules.has('first-viewport-content-too-sparse'));
  assert.ok(rules.has('composition-domain-metadata-missing'));
  assert.ok(rules.has('floating-settings-action'));
});
