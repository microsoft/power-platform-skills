#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const {
  loadTypeScript,
  validateScreenImplementation,
} = require('../validate-screen-implementation');

function parseArgs(argv) {
  const index = argv.indexOf('--project-root');
  if (index < 0 || !argv[index + 1]) throw new Error('--project-root is required');
  return { projectRoot: path.resolve(argv[index + 1]) };
}

const { projectRoot } = parseArgs(process.argv.slice(2));
const typescript = loadTypeScript(projectRoot);
const workOrder = {
  screenId: 'equipment',
  testIds: [
    'screen-equipment',
    'focal-equipment',
    'media-equipment',
    'sticky-action-equipment',
    'primary-action-equipment',
  ],
  scenarioFacts: {
    screenId: 'equipment',
    headline: 'Treadmill TM-014',
  },
  pack: {
    screenId: 'equipment',
    implementationContract: {
      testIds: {
        screen: 'screen-equipment',
        focal: 'focal-equipment',
        media: 'media-equipment',
        stickyAction: 'sticky-action-equipment',
        primaryAction: 'primary-action-equipment',
      },
      routeParams: ['equipmentId'],
      requiredOperations: [{ kind: 'read', entity: 'Equipment' }],
      identityPrimary: 'Equipment name',
      navigationTitle: 'Equipment',
      primaryActionLabel: 'Start inspection',
      primaryActionPlacement: 'sticky-bottom',
      mediaBinding: 'asset:equipment-tm-014-photo',
      mediaFallback: 'Equipment identity placeholder',
      safeAreaBottomRole: 'tab-bar',
    },
  },
};

const valid = `
import { Image } from 'expo-image';
import { useLocalSearchParams } from 'expo-router';
export default function EquipmentScreen() {
  const { equipmentId } = useLocalSearchParams<{ equipmentId: string }>();
  const item = RecordsService.get(equipmentId);
  const mediaKey = 'equipment-tm-014-photo';
  const mediaFallback = 'Equipment identity placeholder';
  return <YStack testID="screen-equipment">
    <YStack testID="focal-equipment"><Text>Treadmill TM-014</Text></YStack>
    <Image testID="media-equipment" source={{ uri: mediaKey }} onError={() => mediaFallback} />
    <BottomActionBar testID="sticky-action-equipment" bottomInsetRole="tab-bar">
      <Button testID="primary-action-equipment">Start inspection</Button>
    </BottomActionBar>
  </YStack>;
}
`;

assert.deepEqual(
  validateScreenImplementation({ sourceText: valid, workOrder, typescript }).errors,
  [],
);

const cases = [
  ['required-test-id-missing', valid.replace('primary-action-equipment', 'wrong-action')],
  ['route-param-missing', valid.replace('equipmentId: string', 'id: string')],
  ['domain-operation-missing', valid.replace('RecordsService.get(equipmentId)', 'String(equipmentId)')],
  ['media-component-missing', valid.replace('<Image testID="media-equipment"', '<View testID="media-equipment"')],
  ['media-binding-missing', valid.replace("'equipment-tm-014-photo'", "'other-photo'")],
  ['media-fallback-missing', valid.replace("'Equipment identity placeholder'", "'Other fallback'")],
  ['sticky-safe-area-mismatch', valid.replace('bottomInsetRole="tab-bar"', 'bottomInsetRole="screen"')],
  ['screen-owns-navigation-shell', valid.replace(
    '<YStack testID="screen-equipment">',
    '<YStack testID="screen-equipment"><Tabs />',
  )],
];
for (const [code, sourceText] of cases) {
  const result = validateScreenImplementation({ sourceText, workOrder, typescript });
  assert.ok(result.errors.some((item) => item.code === code), `${code} was not reported`);
}

process.stdout.write('screen implementation AST smoke passed (1 valid, 8 rejected)\n');
