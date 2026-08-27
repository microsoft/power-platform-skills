'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { compileScreenBuildPack } = require('../compile-screen-build-pack');
const { contractHash, deriveExperienceFromBrief, foundationContract, primaryComposition } = require('../experience-patterns');
const { resolveContextEnrichment } = require('../resolve-context-enrichment');
const { resolveWorkflowJourney } = require('../resolve-workflow-journey');
const { validate } = require('../validate-experience-contract');
const { validateScreenBuildPack } = require('../validate-screen-build-pack');

const resolverScript = path.resolve(__dirname, '..', 'resolve-navigation-contract.js');

const prompts = {
  flight: 'Create a mobile app for showcasing inventory items to flight passengers. This app will be used in flight for selling travel accessories, beauty products and watches. The app should have clean aesthetics, should be accessible and easy to use.',
  gym: 'Create an app for maintining and auditing equipment at gym user should be able to get maintence records of equipment by scanning a qr code, the company owns multiple gyms, the app should support tracking issues, on going repairs, upcoming maintennce and warranty for equipments',
};

function requiredScreen(id, route, archetype, outcome, productRole, navigation = undefined, capabilityComposition = undefined) {
  return {
    id,
    route,
    file: `${route.replace('/(app)/', 'app/(app)/')}.tsx`,
    archetype,
    outcome,
    productRole,
    ...(navigation ? { navigation } : {}),
    ...(capabilityComposition ? { capabilityComposition } : {}),
  };
}

function createNormalPack(context, brief, requiredScreens, keyFlowId, finalizeExperience = (candidate) => candidate) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'normal-prototype-composition-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
  fs.mkdirSync(path.join(root, 'brand'), { recursive: true });
  const experience = finalizeExperience(deriveExperienceFromBrief(brief));
  const contextContract = resolveContextEnrichment(brief, experience);
  const preScreenJourney = resolveWorkflowJourney(brief, experience, contextContract);
  const foundation = foundationContract(experience);
  const keyFlow = requiredScreens.find((screen) => screen.id === keyFlowId);
  const v1 = {
    schemaVersion: 1,
    experienceContractSha256: contractHash(experience),
    primaryScreen: { route: '/(app)/home', file: 'app/(app)/home.tsx', ...primaryComposition(experience) },
    keyFlow: { route: keyFlow.route, file: keyFlow.file, outcome: keyFlow.outcome },
    requiredScreens,
  };
  const files = {
    'experience-contract.json': experience,
    'context-enrichment-contract.json': contextContract,
    'workflow-journey-contract.json': preScreenJourney,
    'experience-foundation-contract.json': foundation,
    'experience-screen-contract.json': v1,
    'dataverse-schema-contract.json': {
      planningMode: 'prototype',
      executionEligible: false,
      tables: requiredScreens
        .filter((screen) => !['Profile'].includes(screen.id))
        .slice(0, 4)
        .map((screen) => ({ logicalName: `cr_${screen.id.toLowerCase()}`, displayName: screen.id, serviceRequired: true })),
    },
  };
  for (const [name, value] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, '.tmp', name), `${JSON.stringify(value, null, 2)}\n`);
  }
  fs.writeFileSync(path.join(root, 'brief.md'), brief);
  fs.writeFileSync(path.join(root, 'brand', 'design-system.md'), '# Design\n\n## Product Experience Primitives\n');
  fs.writeFileSync(path.join(root, 'brand', 'tokens.ts'), 'export const tokens = {} as const;\n');
  fs.writeFileSync(path.join(root, 'native-app-plan.md'), [
    '# Prototype', '',
    '## Design', '', '### Product Experience Contract',
    `- Primary job: ${experience.primaryJob}`,
    `- Entry mode: ${experience.entryMode}`,
    `- Primary action: ${experience.firstViewport.primaryAction}`,
    `- Primary surface: ${experience.primarySurface}`,
    `- Asset policy: ${experience.assetPolicy.connectivity} / ${experience.assetPolicy.media}`,
    '- Prompt evidence: verified brief spans', '',
    '## Screens', '', '### Screen Map',
    '| Screen | Route | File |', '| --- | --- | --- |',
    '| Home | /(app)/home | app/(app)/home.tsx |',
    ...requiredScreens.map((screen) => `| ${screen.id} | ${screen.route} | ${screen.file} |`),
  ].join('\n'));
  const resolved = spawnSync(process.execPath, [resolverScript, '--project-root', root], { encoding: 'utf8' });
  assert.equal(resolved.status, 0, resolved.stderr);
  const pack = compileScreenBuildPack(root);
  fs.writeFileSync(path.join(root, '.tmp', 'screen-build-pack.json'), `${JSON.stringify(pack, null, 2)}\n`);
  assert.deepEqual(validateScreenBuildPack(root, pack), { issues: [], staleTargets: [] });
  assert.deepEqual(validate(root, 'plan'), []);
  return { root, pack };
}

test('exact flight prompt reaches a discovery composition through the normal v1 planner path', (context) => {
  const { pack } = createNormalPack(context, prompts.flight, [
    requiredScreen('Categories', '/(app)/categories', 'List', 'Browse product categories.', 'durable-destination'),
    requiredScreen('Bag', '/(app)/bag', 'List', 'Review selected products and availability.', 'durable-destination'),
    requiredScreen('ProductDetail', '/(app)/products/[productId]', 'Detail', 'Inspect product media, price, and availability.', 'nested-detail', { parentRoute: '/(app)/home' }),
    requiredScreen('Profile', '/(app)/profile', 'Detail', 'Review profile and sign out.', 'global-utility'),
  ], 'ProductDetail');
  assert.equal(pack.screenContractVersion, 2);
  assert.deepEqual(pack.navigation.destinations.map((destination) => destination.rootScreenId), ['Home', 'Categories', 'Bag']);
  assert.equal(pack.screens.find((screen) => screen.id === 'Home').compositionGuidance.profile, 'discovery-merchandising');
  assert.equal(pack.screens.find((screen) => screen.id === 'Categories').compositionGuidance.profile, 'collection-browser');
  assert.equal(pack.screens.find((screen) => screen.id === 'ProductDetail').compositionGuidance.profile, 'record-detail');
});

test('AI-finalized gym prompt reaches scan-first overview, queue, capture, and detail profiles through the normal v1 path', (context) => {
  const { pack } = createNormalPack(context, prompts.gym, [
    requiredScreen('Equipment', '/(app)/equipment', 'List', 'Browse equipment and maintenance state.', 'durable-destination'),
    requiredScreen('Work', '/(app)/work', 'List', 'Review issues, repairs, and upcoming maintenance.', 'durable-destination'),
    requiredScreen('ScanEquipment', '/(app)/equipment/scan', 'Modal-Sheet', 'Identify equipment and continue to its records.', 'immersive-modal', { parentRoute: '/(app)/equipment', kind: 'modal' }, [{ capability: 'barcode-scanner', mode: 'on-demand', fallbackStates: ['loading', 'permission-denied', 'unavailable', 'manual-entry'], maxViewportShare: 0.24 }]),
    requiredScreen('EquipmentDetail', '/(app)/equipment/[equipmentId]', 'Detail', 'Review maintenance, repair, and warranty details.', 'nested-detail', { parentRoute: '/(app)/equipment' }),
    requiredScreen('Profile', '/(app)/profile', 'Detail', 'Review profile and sign out.', 'global-utility'),
  ], 'ScanEquipment', (candidate) => ({
    ...candidate,
    decisionOwner: 'model',
    audience: 'employee',
    primaryJob: 'Find equipment and act on its maintenance record.',
    interactionMode: 'operate',
    contentModel: ['records', 'locations', 'tasks'],
    primarySurface: 'decision-led-overview',
    entryMode: 'overview',
    navigationModel: 'tabs-stack',
    primaryScreen: { ...candidate.primaryScreen, compositionKind: 'overview' },
    firstViewport: {
      focalPoint: 'Current gym, equipment lookup, and records needing attention',
      regionOrder: ['context', 'primary-action', 'feature', 'supporting-content'],
      primaryAction: 'Scan equipment',
      contentDensity: 'balanced',
    },
    signatureMotifs: ['scan-entry', 'attention-queue'],
    forbiddenDefaults: ['generic-dashboard-card-grid', 'unprioritized-metrics', 'always-mounted-scanner'],
    visualCharacter: 'confident-utility',
    confidence: 'high',
    assumptions: ['Scan opens an on-demand capture route while Home retains current-gym and attention context.'],
  }));
  assert.equal(pack.screenContractVersion, 2);
  assert.deepEqual(pack.navigation.destinations.map((destination) => destination.rootScreenId), ['Home', 'Equipment', 'Work']);
  assert.equal(pack.experience.firstViewport.primaryAction, 'Scan equipment');
  assert.equal(pack.screens.find((screen) => screen.id === 'Home').compositionGuidance.profile, 'attention-led-overview');
  assert.equal(pack.screens.find((screen) => screen.id === 'Equipment').compositionGuidance.profile, 'operational-queue');
  assert.equal(pack.screens.find((screen) => screen.id === 'Work').compositionGuidance.profile, 'operational-queue');
  assert.equal(pack.screens.find((screen) => screen.id === 'ScanEquipment').compositionGuidance.profile, 'focused-capture');
  assert.equal(pack.screens.find((screen) => screen.id === 'EquipmentDetail').compositionGuidance.profile, 'record-detail');
});

test('multi-screen work reaches queue, guided work, evidence, and confirmation profiles through the normal path', (context) => {
  const brief = 'Field staff view expected shipments, then record received and damaged line quantities, then inspect damage evidence, and finally confirm receipt.';
  const { pack } = createNormalPack(context, brief, [
    requiredScreen('ExpectedShipments', '/(app)/shipments', 'List', 'View expected shipments and status warnings.', 'durable-destination'),
    requiredScreen('ReceiveShipment', '/(app)/shipments/receive', 'Form', 'Record received and damaged line quantities.', 'bounded-flow-step', { parentRoute: '/(app)/shipments' }),
    requiredScreen('InspectEvidence', '/(app)/shipments/inspect', 'Form', 'Inspect damage evidence and item details.', 'bounded-flow-step', { parentRoute: '/(app)/shipments' }),
    requiredScreen('ConfirmReceipt', '/(app)/shipments/confirm', 'Form', 'Confirm the completed receipt.', 'bounded-flow-step', { parentRoute: '/(app)/shipments' }),
    requiredScreen('Profile', '/(app)/profile', 'Detail', 'Review profile and sign out.', 'global-utility'),
  ], 'ReceiveShipment');
  assert.equal(pack.screens.find((screen) => screen.id === 'ExpectedShipments').compositionGuidance.profile, 'operational-queue');
  assert.equal(pack.screens.find((screen) => screen.id === 'ReceiveShipment').compositionGuidance.profile, 'guided-work-step');
  assert.equal(pack.screens.find((screen) => screen.id === 'InspectEvidence').compositionGuidance.profile, 'guided-work-step');
  assert.equal(pack.screens.find((screen) => screen.id === 'ConfirmReceipt').compositionGuidance.profile, 'review-confirmation');
  assert.deepEqual(pack.screens.find((screen) => screen.id === 'ConfirmReceipt').compositionGuidance.structuralRoles, [
    'stage-context', 'decision-inputs', 'supporting-evidence', 'confirmation-context', 'primary-action',
  ]);
});
