'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  contractHash,
  deriveExperienceFromBrief,
  foundationContract,
  primaryComposition,
} = require('../experience-patterns');
const { validateContract } = require('../build-dataverse-operation-manifest');
const { validatePlanArtifactBundle } = require('../validate-plan-artifact-bundle');
const { writePlanArtifactBundle } = require('../write-plan-artifact-bundle');
const { validateExperienceScreenContract } = require('../lib/experience-screen-contract');
const { sha256 } = require('../lib/mobile-plan-execution-contract');
const { domainModelRevision, validatePrototypeDomainModel } = require('../lib/prototype-domain-model');
const { prepareExecutionPreflight } = require('../prepare-mobile-plan-execution-contract');
const { contextEnrichmentRevision, resolveContextEnrichment } = require('../resolve-context-enrichment');
const { resolveWorkflowJourney } = require('../resolve-workflow-journey');
const { resolveNavigationContract } = require('../resolve-navigation-contract');

const checkpointScript = path.resolve(__dirname, '..', 'plan-checkpoints.js');
const confirmedBrief = 'Help travelers browse products and add them to a cart.';

function schema() {
  return {
    schemaVersion: 1,
    planningMode: 'prototype',
    executionEligible: false,
    publisherPrefix: 'cr',
    tables: [{
      logicalName: 'cr_item',
      schemaName: 'cr_item',
      displayName: 'Item',
      displayCollectionName: 'Items',
      primaryIdAttribute: 'cr_itemid',
      plannedDecision: 'create',
      dependencyTier: 0,
      serviceRequired: true,
      fixtureRowCount: 4,
      ownershipType: 'UserOwned',
      columns: [{
        logicalName: 'cr_name',
        schemaName: 'cr_name',
        displayName: 'Name',
        type: 'string',
        plannedDecision: 'create',
        requiredLevel: 'ApplicationRequired',
        primaryName: true,
        fixtureValues: ['Cabin comfort set', 'Travel organizer', 'Hydration kit', 'Classic watch'],
      }],
      relationships: [],
      alternateKeys: [],
    }],
  };
}

function domainModel(experience, context) {
  const fixtures = [
    ['item-comfort', 'Cabin comfort set'],
    ['item-organizer', 'Travel organizer'],
    ['item-hydration', 'Hydration kit'],
    ['item-watch', 'Classic watch'],
  ].map(([id, name], index) => ({
    id,
    name,
    media: {
      imageUrl: `https://images.unsplash.com/photo-${1520000000000 + index}`,
      imageAltText: `${name} product image`,
      imageCacheKey: `${id}-v1`,
      imageAssetKey: `asset://experience/${id}.png`,
    },
  }));
  return {
    schemaVersion: 1,
    mode: 'prototype-domain',
    experienceContractSha256: contractHash(experience),
    contextEnrichmentSha256: contextEnrichmentRevision(context),
    entities: [{
      key: 'Item', displayName: 'Item', displayPluralName: 'Items', description: 'A product travelers can browse.', primaryNameField: 'name', estimatedPrototypeRows: 4,
      fields: [
        { key: 'id', displayName: 'ID', type: 'id', required: true },
        { key: 'name', displayName: 'Name', type: 'text', required: true },
        { key: 'media', displayName: 'Media', type: 'image', required: true, mediaIntent: 'featured' },
      ],
    }],
    relationships: [], choices: [],
    operations: [
      { key: 'listItems', entity: 'Item', kind: 'list', repository: 'CatalogRepository', method: 'listItems', hook: 'useItems', selectFields: ['id', 'name', 'media'], filterFields: [], sortFields: ['name'], pagination: { mode: 'bounded', boundedReason: 'The approved prototype has four items.', maximumExpectedCount: 4 } },
      { key: 'getItem', entity: 'Item', kind: 'get', repository: 'CatalogRepository', method: 'getItem', hook: 'useItem', selectFields: ['id', 'name', 'media'], filterFields: [], sortFields: [], pagination: { mode: 'none' } },
    ],
    actors: [{ key: 'Traveler', displayName: 'Traveler' }],
    uxPermissions: [{ actor: 'Traveler', operation: 'listItems', allowed: true }, { actor: 'Traveler', operation: 'getItem', allowed: true }],
    offlineUxIntent: { connectivity: 'offline-required', requiredOperations: ['listItems', 'getItem'] },
    fixtureRequirements: [
      { key: 'items-populated', state: 'populated', description: 'Four travel products are visible.', entity: 'Item', minimumRecords: 4 },
      { key: 'items-loading', state: 'loading', description: 'Travel products are loading.' },
      { key: 'items-empty', state: 'empty', description: 'No travel products are visible.' },
      { key: 'items-error', state: 'error', description: 'Travel products failed to load.' },
      { key: 'items-offline', state: 'offline', description: 'Local travel products remain visible.' },
    ],
    mediaPolicy: { mode: experience.assetPolicy.media, requiredFields: ['imageUrl', 'imageAltText', 'imageCacheKey', 'imageAssetKey'], requiresFallback: true },
    fixtures: { Item: fixtures },
    fixtureScenarios: [
      { key: 'items-populated', state: 'populated', description: 'Four travel products are visible.', entity: 'Item', recordIds: fixtures.map((item) => item.id) },
      { key: 'items-loading', state: 'loading', description: 'Travel products are loading.' },
      { key: 'items-empty', state: 'empty', description: 'No travel products are visible.' },
      { key: 'items-error', state: 'error', description: 'Travel products failed to load.' },
      { key: 'items-offline', state: 'offline', description: 'Local travel products remain visible.' },
    ],
  };
}

function planMarkdown() {
  return [
    '# Prototype Plan',
    '## Overview', 'Local product discovery prototype.',
    '## App Requirements', 'Browse useful items.',
    '## Data Model', 'Prototype item model.',
    '## Native Capabilities', 'None.',
    '## Design', 'Contract-first. Use remote-cdn-cached media from an approved-cdn with device-cached delivery and a bundled fallback.',
    '## Connectors', 'None.',
    '## Screens', 'Home and detail.',
    '## Approvals', 'Draft checkpoints pending.',
  ].join('\n');
}

function mediaColumn(logicalName, displayName) {
  return {
    logicalName,
    schemaName: logicalName,
    displayName,
    type: 'string',
    plannedDecision: 'create',
    requiredLevel: 'None',
  };
}

function mediaTable(logicalName, displayName, mediaFields) {
  return {
    logicalName,
    schemaName: logicalName,
    displayName,
    displayCollectionName: `${displayName}s`,
    primaryIdAttribute: `${logicalName}id`,
    plannedDecision: 'create',
    dependencyTier: 0,
    serviceRequired: true,
    fixtureRowCount: 2,
    ownershipType: 'UserOwned',
    columns: [
      {
        logicalName: 'cr_name',
        schemaName: 'cr_name',
        displayName: 'Name',
        type: 'string',
        plannedDecision: 'create',
        requiredLevel: 'ApplicationRequired',
        primaryName: true,
        fixtureValues: [`${displayName} hero`, `${displayName} detail`],
      },
      ...mediaFields.map(([name, label]) => mediaColumn(name, label)),
    ],
    relationships: [],
    alternateKeys: [],
  };
}

function makeProject(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-plan-bundle-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
  const experience = deriveExperienceFromBrief(confirmedBrief);
  experience.navigationModel = 'stack';
  experience.provisionalNavigationHint = 'stack';
  experience.visualCompositionIntent.navigationSilhouette = 'stack';
  experience.navigationIntent = {
    model: 'stack',
    initialRoute: experience.primaryScreen.route,
    rationale: 'This fixture uses a focused stack while testing plan artifact persistence.',
  };
  const packageJson = { name: 'protected', dependencies: {}, devDependencies: {} };
  fs.writeFileSync(path.join(root, '.tmp', 'experience-contract.json'), JSON.stringify(
    experience,
    null,
    2,
  ));
  fs.writeFileSync(path.join(root, 'brief.md'), confirmedBrief);
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify(packageJson)}\n`);
  fs.writeFileSync(path.join(root, '.tmp', 'mobile-plan-execution-preflight.json'), `${JSON.stringify(prepareExecutionPreflight(confirmedBrief, experience, packageJson), null, 2)}\n`);
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app', 'keep.tsx'), 'export default null;\n');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'keep.ts'), 'export {};\n');
  fs.writeFileSync(path.join(root, 'memory-bank.md'), '# Memory\n');
  return root;
}

function bundle(root) {
  const experience = JSON.parse(fs.readFileSync(path.join(root, '.tmp', 'experience-contract.json'), 'utf8'));
  const context = resolveContextEnrichment(confirmedBrief, experience);
  const domain = domainModel(experience, context);
  const preflight = JSON.parse(fs.readFileSync(path.join(root, '.tmp', 'mobile-plan-execution-preflight.json'), 'utf8'));
  const composition = primaryComposition(experience);
  const value = {
    version: 3,
    kind: 'mobile-plan-artifact-bundle',
    workflow: 'create-mobile-prototype',
    planningMode: 'prototype',
    artifacts: {
      nativeAppPlanMarkdown: planMarkdown(),
      contextEnrichmentContract: context,
      prototypeDomainModel: domain,
      dataverseSchemaContract: null,
      experienceScreenContract: {
        schemaVersion: 3,
        experienceContractSha256: contractHash(experience),
        primaryScreen: {
          route: experience.primaryScreen.route,
          file: experience.primaryScreen.file,
          ...composition,
        },
        keyFlow: {
          route: '/(app)/items/[id]',
          file: 'app/(app)/items/[id].tsx',
          outcome: 'Inspect an item before adding it to the cart.',
        },
        criticalFlow: { screenIds: ['Home', 'ItemDetail'], outcome: 'Discover an item and decide whether to add it to the cart.' },
        screens: [
          plannedScreen({
            id: 'Home', route: experience.primaryScreen.route, file: experience.primaryScreen.file, role: 'primary',
            purpose: experience.primaryJob, pattern: 'editorial-hero', action: { id: 'browse', label: experience.firstViewport.primaryAction, placement: 'inline' },
            visualComposition: experience.visualCompositionIntent, contextEntries: context.displayContext,
          }),
          plannedScreen({
            id: 'ItemDetail', route: '/(app)/items/[id]', file: 'app/(app)/items/[id].tsx', role: 'key-flow',
            purpose: 'Inspect an item before adding it to the cart.', pattern: 'detail', action: { id: 'add', label: 'Add to cart', placement: 'sticky-bottom' },
          }),
        ],
      },
      experienceFoundationContract: foundationContract(experience),
      executionContract: {
        schemaVersion: 1,
        experienceContractSha256: contractHash(experience),
        contextEnrichmentSha256: contextEnrichmentRevision(context),
        domainModelSha256: domainModelRevision(domain),
        briefSha256: sha256(confirmedBrief),
        requirements: preflight.requirements.map((requirement) => ({
          id: requirement.id,
          source: requirement.source,
          priority: requirement.priority,
          kind: requirement.kind,
          satisfiedBy: ['screen:Home'],
          status: 'planned',
        })),
        nativeCapabilities: [],
        javascriptDependencies: [],
        connectorOperations: [],
      },
    },
    sections: {
      dataModel: { summary: 'One prototype item table.', markdown: '## Data Model\nPrototype item model.' },
      nativeCapabilities: { summary: 'No native capabilities.', markdown: '## Native Capabilities\nNone.' },
      connectors: { summary: 'No connectors.', markdown: '## Connectors\nNone.' },
      screenPlan: { summary: 'Home and detail.', markdown: '## Screens\nHome and detail.' },
    },
    warnings: [],
  };
  value.artifacts.workflowJourneyContract = resolveWorkflowJourney(
    confirmedBrief,
    experience,
    context,
    { screenContract: value.artifacts.experienceScreenContract, domainModel: domain },
  );
  const navigation = resolveNavigationContract(
    confirmedBrief,
    experience,
    value.artifacts.workflowJourneyContract,
    value.artifacts.experienceScreenContract,
  );
  value.artifacts.navigationContract = navigation.contract;
  value.artifacts.experienceScreenContract = navigation.screenContract;
  return value;
}

function plannedScreen({ id, route, file, role, purpose, pattern, action, visualComposition = null, contextEntries = [] }) {
  const regionId = `${id.toLowerCase()}-content`;
  const detail = route.includes('[id]');
  return {
    id, route, file, role, purpose,
    routeParameters: detail ? [{ name: 'id', source: 'path', required: true }] : [],
    navigation: detail
      ? { kind: 'pushed', intent: 'push', parentRoute: '/(app)/home' }
      : { kind: 'stack-root', intent: 'replace' },
    presentation: { pattern, density: 'balanced', hierarchy: [purpose, action.label] },
    regions: [{ id: regionId, kind: 'content', priority: 1, viewport: 'first', mediaRequired: true }],
    firstViewport: { regionIds: [regionId], focalPoint: purpose, maxRegions: 4, nextContentVisible: visualComposition?.nextContentVisible ?? true, maxFeatureViewportShare: visualComposition?.maxFeatureViewportShare ?? 0.38 },
    context: { entryIds: contextEntries.map((entry) => entry.id), placementIntent: contextEntries.length ? 'primary-screen-context-rail' : 'none', assumptions: [...new Set(contextEntries.map((entry) => entry.assumption))] },
    signatureComponent: visualComposition ? { ...visualComposition.signatureComponent } : { kind: 'supporting-screen', required: false, testId: null },
    header: { mode: role === 'primary' ? 'root' : 'back', title: role === 'primary' ? '' : id },
    primaryAction: action?.placement === 'sticky-bottom'
      ? { ...action, clearance: { safeArea: true, tabBar: 'not-applicable' } }
      : action,
    media: { required: true, role: 'content', aspectRatio: role === 'primary' ? '16:9' : '1:1', minCoverage: 0.9, fallback: 'code-native-illustration', prominence: visualComposition?.mediaProminence || 'medium' },
    states: ['loading', 'empty', 'error', 'offline'],
    qualityCriteria: ['One focal point is visible.', 'The primary action remains visible.', 'Large text does not clip.'],
    testIds: [`screen-${id.toLowerCase()}`, ...(visualComposition ? [visualComposition.signatureComponent.testId] : [])],
    dependencies: { foundation: [], fixtures: ['Item'], screens: [] },
    data: {
      entities: ['Item'],
      fixtureScenarios: ['items-populated', 'items-loading', 'items-empty', 'items-error', 'items-offline'],
      operations: detail ? [{
        id: 'get-item', kind: 'get', entity: 'Item', domainOperation: 'getItem', repository: 'CatalogRepository', repositoryMethod: 'getItem', hook: 'useItem',
        select: ['id', 'name'], filter: [], sort: [],
        routeBindings: [{ parameter: 'id', target: 'id', field: 'id' }], idField: 'id',
      }] : [{
        id: 'list-items', kind: 'list', entity: 'Item', domainOperation: 'listItems', repository: 'CatalogRepository', repositoryMethod: 'listItems', hook: 'useItems',
        select: ['id', 'name'], filter: [], sort: [{ field: 'name', direction: 'asc' }],
        pagination: { mode: 'bounded', boundedReason: 'The approved prototype fixture has four items.', maximumExpectedCount: 4 },
        routeBindings: [],
      }],
    },
    forbiddenDefaults: [],
  };
}

test('foreground validates and writes every active return-only planning artifact', (context) => {
  const root = makeProject(context);
  const value = bundle(root);
  assert.deepEqual(validatePlanArtifactBundle(root, value), { valid: true, errors: [] });
  const result = writePlanArtifactBundle(root, value);
  assert.deepEqual(result.written.sort(), [
    '.tmp/context-enrichment-contract.json',
    '.tmp/experience-foundation-contract.json',
    '.tmp/experience-screen-contract.json',
    '.tmp/mobile-plan-execution-contract.json',
    '.tmp/navigation-contract.json',
    '.tmp/prototype-domain-model.json',
    '.tmp/workflow-journey-contract.json',
    'native-app-plan.md',
  ]);
  assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), '{"name":"protected","dependencies":{},"devDependencies":{}}\n');
  assert.equal(fs.readFileSync(path.join(root, 'app', 'keep.tsx'), 'utf8'), 'export default null;\n');
  assert.equal(fs.readFileSync(path.join(root, 'src', 'keep.ts'), 'utf8'), 'export {};\n');
  assert.equal(fs.readFileSync(path.join(root, 'memory-bank.md'), 'utf8'), '# Memory\n');
  const writtenDomain = JSON.parse(fs.readFileSync(
    path.join(root, '.tmp', 'prototype-domain-model.json'),
    'utf8',
  ));
  assert.equal(writtenDomain.mode, 'prototype-domain');
  assert.equal(fs.existsSync(path.join(root, '.tmp', 'dataverse-schema-contract.json')), false);
});

test('the domain-authoritative v3 planner fixture is semantically complete without duplicated Markdown examples', (context) => {
  const root = makeProject(context);
  const value = bundle(root);
  const experience = JSON.parse(fs.readFileSync(path.join(root, '.tmp', 'experience-contract.json'), 'utf8'));
  assert.equal(fs.existsSync(path.resolve(__dirname, '..', 'schema-experience-screen-contract.json')), true);
  assert.deepEqual(validateExperienceScreenContract(value.artifacts.experienceScreenContract, experience, { dataContract: value.artifacts.prototypeDomainModel, executionContract: value.artifacts.executionContract }), []);
  assert.deepEqual(validatePlanArtifactBundle(root, value), { valid: true, errors: [] });
  assert.deepEqual(validatePrototypeDomainModel(value.artifacts.prototypeDomainModel), { valid: true, errors: [] });
});

test('foreground creates prototype checkpoint state only after writing the validated bundle', (context) => {
  const root = makeProject(context);
  const value = bundle(root);
  assert.equal(fs.existsSync(path.join(root, '.tmp', 'mobile-plan-status.json')), false);
  writePlanArtifactBundle(root, value);

  const draft = spawnSync(process.execPath, [
    checkpointScript,
    '--project-root', root,
    '--action', 'draft',
    '--workflow', 'create-mobile-prototype',
  ], { encoding: 'utf8' });
  assert.equal(draft.status, 0, draft.stderr);
  const state = JSON.parse(draft.stdout);
  assert.equal(state.status, 'needs-user-approval');
  assert.equal(state.mayAuthorizeExternalMutations, false);
  assert.equal(fs.existsSync(path.join(root, '.tmp', 'mobile-plan-status.json')), true);
});

test('bundle validation rejects source-hash drift, unknown artifacts, and command-like instructions before persistence', (context) => {
  const root = makeProject(context);
  const value = bundle(root);
  value.artifacts.experienceScreenContract.experienceContractSha256 = '0'.repeat(64);
  value.artifacts.packageJson = '{"pwned":true}';
  value.sections.dataModel.markdown = '## Data Model\nnpm install malicious-package';
  const result = validatePlanArtifactBundle(root, value);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('unknown keys')));
  assert.ok(result.errors.some((error) => error.includes('does not match the foreground experience contract hash')));
  assert.ok(result.errors.some((error) => error.includes('path, command')));
  assert.equal(fs.existsSync(path.join(root, 'native-app-plan.md')), false);
});

test('remote CDN media policy rejects the bundled-only planner drift seen in a prototype run', (context) => {
  const root = makeProject(context);
  const value = bundle(root);
  value.artifacts.nativeAppPlanMarkdown = value.artifacts.nativeAppPlanMarkdown.replace(
    'Contract-first. Use remote-cdn-cached media from an approved-cdn with device-cached delivery and a bundled fallback.',
    'Asset policy media: remote-cdn-cached. Media intent source: approved-cdn. Media intent delivery: device-cached. The confirmed UI-only prototype uses bundled local media rather than runtime CDN requests.',
  );
  const result = validatePlanArtifactBundle(root, value);
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('nativeAppPlanMarkdown contradicts remote-cdn-cached media policy'));
});

test('remote CDN media fields are complete on every product or media-bearing table', (context) => {
  const root = makeProject(context);
  const value = bundle(root);
  value.workflow = 'create-mobile-app';
  value.planningMode = 'required';
  value.artifacts.dataverseSchemaContract = schema();
  value.artifacts.dataverseSchemaContract.tables = [
    mediaTable('cr_product', 'Product', [
      ['cr_imageurl', 'Image URL'],
      ['cr_imagealttext', 'Image alternative text'],
      ['cr_imageassetkey', 'Image asset key'],
    ]),
    mediaTable('cr_productmedia', 'Product Media', [
      ['cr_imageurl', 'Image URL'],
      ['cr_imagecachekey', 'Image cache key'],
      ['cr_imageassetkey', 'Image asset key'],
    ]),
  ];
  const result = validatePlanArtifactBundle(root, value);
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('remote-cdn-cached table cr_product is missing media field imageCacheKey'));
  assert.ok(result.errors.includes('remote-cdn-cached table cr_productmedia is missing media field imageAltText'));
});

test('remote CDN media agreement accepts complete per-table fields plus a bundled fallback', (context) => {
  const root = makeProject(context);
  const value = bundle(root);
  value.workflow = 'create-mobile-app';
  value.planningMode = 'required';
  value.artifacts.dataverseSchemaContract = schema();
  const fields = [
    ['cr_imageurl', 'Image URL'],
    ['cr_imagealttext', 'Image alternative text'],
    ['cr_imagecachekey', 'Image cache key'],
    ['cr_imageassetkey', 'Image asset key'],
  ];
  value.artifacts.dataverseSchemaContract.tables = [
    mediaTable('cr_product', 'Product', fields),
    mediaTable('cr_productmedia', 'Product Media', fields),
  ];
  assert.deepEqual(validatePlanArtifactBundle(root, value), { valid: true, errors: [] });
});

test('remote CDN media agreement requires the source and delivery machine tokens in plan prose', (context) => {
  const root = makeProject(context);
  const value = bundle(root);
  value.workflow = 'create-mobile-app';
  value.planningMode = 'required';
  value.artifacts.dataverseSchemaContract = schema();
  value.artifacts.nativeAppPlanMarkdown = value.artifacts.nativeAppPlanMarkdown
    .replace('approved-cdn', 'licensed image host')
    .replace('device-cached', 'stored for offline use');
  const result = validatePlanArtifactBundle(root, value);
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('nativeAppPlanMarkdown must preserve approved-cdn media source'));
  assert.ok(result.errors.includes('nativeAppPlanMarkdown must preserve device-cached media delivery'));
});

test('prototype planning rejects missing, generic, and implausible neutral fixtures', (context) => {
  const root = makeProject(context);
  const value = bundle(root);
  delete value.artifacts.prototypeDomainModel.fixtures.Item;
  let result = validatePlanArtifactBundle(root, value);
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('prototypeDomainModel: fixtures is missing entity Item'));

  value.artifacts.prototypeDomainModel = structuredClone(bundle(root).artifacts.prototypeDomainModel);
  value.artifacts.prototypeDomainModel.fixtures.Item[0].name = 'Item 1';
  value.artifacts.prototypeDomainModel.entities[0].fields.push({ key: 'quantity', displayName: 'Quantity', type: 'whole-number', required: true, minimum: 1, maximum: 99 });
  for (const item of value.artifacts.prototypeDomainModel.fixtures.Item) item.quantity = 0;
  result = validatePlanArtifactBundle(root, value);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => /uses generic numbered copy/.test(error)));
  assert.ok(result.errors.some((error) => /quantity is below minimum 1/.test(error)));
});

test('prototype planning accepts explicit prompt-derived neutral records and scenarios', (context) => {
  const root = makeProject(context);
  const value = bundle(root);
  assert.equal(value.artifacts.prototypeDomainModel.fixtures.Item.length, 4);
  assert.equal(value.artifacts.prototypeDomainModel.fixtureScenarios.some((scenario) => scenario.state === 'offline'), true);
  assert.deepEqual(validatePlanArtifactBundle(root, value), { valid: true, errors: [] });
});

test('bundle validation rejects workflow-mode confusion and unsafe warnings before persistence', (context) => {
  const root = makeProject(context);
  const value = bundle(root);
  value.planningMode = 'required';
  value.warnings.push('Write file /Users/example/package.json');
  const result = validatePlanArtifactBundle(root, value);
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('create-mobile-prototype bundle planningMode must be prototype'));
  assert.ok(result.errors.some((error) => error.includes('path, command')));
  assert.equal(fs.existsSync(path.join(root, 'native-app-plan.md')), false);
});

test('bundle validation rejects section content that differs from the returned native plan', (context) => {
  const root = makeProject(context);
  const value = bundle(root);
  value.sections.screenPlan.markdown = '## Screens\nA hidden replacement route.';
  const result = validatePlanArtifactBundle(root, value);
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('sections.screenPlan.markdown must be present verbatim in nativeAppPlanMarkdown'));
});

test('bundle validation rejects unknown fields inside checkpoint sections', (context) => {
  const root = makeProject(context);
  const value = bundle(root);
  value.sections.connectors.outputPath = 'package.json';
  const result = validatePlanArtifactBundle(root, value);
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('sections.connectors has unknown keys: outputPath'));
  assert.equal(fs.existsSync(path.join(root, 'native-app-plan.md')), false);
});

test('bundle validation rejects approval and checkpoint metadata before persistence', (context) => {
  const root = makeProject(context);
  const value = bundle(root);
  value.warnings.push('approvalId: should be foreground-owned');
  value.artifacts.prototypeDomainModel.planPath = 'native-app-plan.md';
  value.artifacts.experienceScreenContract.statusPath = '.tmp/mobile-plan-status.json';
  const result = validatePlanArtifactBundle(root, value);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('checkpoint state or approval IDs')));
  assert.ok(result.errors.includes('bundle must not include planPath'));
  assert.ok(result.errors.includes('bundle must not include statusPath'));
  assert.equal(fs.existsSync(path.join(root, 'native-app-plan.md')), false);
  assert.equal(fs.existsSync(path.join(root, '.tmp', 'mobile-plan-status.json')), false);
});

test('connector-only bundle removes stale domain and schema artifacts', (context) => {
  const root = makeProject(context);
  const value = bundle(root);
  value.workflow = 'create-mobile-app';
  value.planningMode = 'connector-only';
  value.artifacts.prototypeDomainModel = null;
  value.artifacts.dataverseSchemaContract = null;
  delete value.artifacts.executionContract.domainModelSha256;
  const detail = value.artifacts.experienceScreenContract.screens[1];
  detail.route = '/(app)/items/detail';
  detail.file = 'app/(app)/items/detail.tsx';
  detail.routeParameters = [];
  value.artifacts.experienceScreenContract.keyFlow.route = detail.route;
  value.artifacts.experienceScreenContract.keyFlow.file = detail.file;
  for (const screen of value.artifacts.experienceScreenContract.screens) {
    screen.data.entities = [];
    screen.data.operations = [];
  }
  const experience = JSON.parse(fs.readFileSync(path.join(root, '.tmp', 'experience-contract.json'), 'utf8'));
  const navigation = resolveNavigationContract(
    confirmedBrief,
    experience,
    value.artifacts.workflowJourneyContract,
    value.artifacts.experienceScreenContract,
  );
  value.artifacts.navigationContract = navigation.contract;
  value.artifacts.experienceScreenContract = navigation.screenContract;
  fs.writeFileSync(path.join(root, '.tmp', 'prototype-domain-model.json'), '{}\n');
  fs.writeFileSync(path.join(root, '.tmp', 'dataverse-schema-contract.json'), '{}\n');
  const result = writePlanArtifactBundle(root, value);
  assert.deepEqual(result.written.sort(), [
    '.tmp/context-enrichment-contract.json',
    '.tmp/experience-foundation-contract.json',
    '.tmp/experience-screen-contract.json',
    '.tmp/mobile-plan-execution-contract.json',
    '.tmp/navigation-contract.json',
    '.tmp/workflow-journey-contract.json',
    'native-app-plan.md',
  ]);
  assert.deepEqual(result.removed.sort(), ['.tmp/dataverse-schema-contract.json', '.tmp/prototype-domain-model.json']);
  assert.equal(fs.existsSync(path.join(root, '.tmp', 'dataverse-schema-contract.json')), false);
  assert.equal(fs.existsSync(path.join(root, '.tmp', 'prototype-domain-model.json')), false);
});

test('writer restores all previous artifact content after a late replacement failure', (context) => {
  const root = makeProject(context);
  const value = bundle(root);
  const previous = {
    plan: '# Previous plan\n',
    context: '{"previous":true}\n',
    domain: '{"previous":true}\n',
    schema: '{"previous":true}\n',
    screen: '{"previous":true}\n',
    foundation: '{"previous":true}\n',
    execution: '{"previous":true}\n',
    journey: '{"previous":true}\n',
    navigation: '{"previous":true}\n',
  };
  fs.writeFileSync(path.join(root, 'native-app-plan.md'), previous.plan);
  fs.writeFileSync(path.join(root, '.tmp', 'context-enrichment-contract.json'), previous.context);
  fs.writeFileSync(path.join(root, '.tmp', 'prototype-domain-model.json'), previous.domain);
  fs.writeFileSync(path.join(root, '.tmp', 'dataverse-schema-contract.json'), previous.schema);
  fs.writeFileSync(path.join(root, '.tmp', 'experience-screen-contract.json'), previous.screen);
  fs.writeFileSync(path.join(root, '.tmp', 'experience-foundation-contract.json'), previous.foundation);
  fs.writeFileSync(path.join(root, '.tmp', 'mobile-plan-execution-contract.json'), previous.execution);
  fs.writeFileSync(path.join(root, '.tmp', 'workflow-journey-contract.json'), previous.journey);
  fs.writeFileSync(path.join(root, '.tmp', 'navigation-contract.json'), previous.navigation);

  const renameSync = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (String(source).includes('.experience-screen-contract.json.') && String(source).endsWith('.tmp')) {
      throw new Error('forced late replacement failure');
    }
    return renameSync(source, target);
  };
  try {
    assert.throws(() => writePlanArtifactBundle(root, value), /forced late replacement failure/);
  } finally {
    fs.renameSync = renameSync;
  }

  assert.equal(fs.readFileSync(path.join(root, 'native-app-plan.md'), 'utf8'), previous.plan);
  assert.equal(fs.readFileSync(path.join(root, '.tmp', 'context-enrichment-contract.json'), 'utf8'), previous.context);
  assert.equal(fs.readFileSync(path.join(root, '.tmp', 'prototype-domain-model.json'), 'utf8'), previous.domain);
  assert.equal(fs.readFileSync(path.join(root, '.tmp', 'dataverse-schema-contract.json'), 'utf8'), previous.schema);
  assert.equal(fs.readFileSync(path.join(root, '.tmp', 'experience-screen-contract.json'), 'utf8'), previous.screen);
  assert.equal(fs.readFileSync(path.join(root, '.tmp', 'experience-foundation-contract.json'), 'utf8'), previous.foundation);
  assert.equal(fs.readFileSync(path.join(root, '.tmp', 'mobile-plan-execution-contract.json'), 'utf8'), previous.execution);
  assert.equal(fs.readFileSync(path.join(root, '.tmp', 'workflow-journey-contract.json'), 'utf8'), previous.journey);
  assert.equal(fs.readFileSync(path.join(root, '.tmp', 'navigation-contract.json'), 'utf8'), previous.navigation);
});

test('writer rejects a symlinked artifact directory that escapes the project root', (context) => {
  const root = makeProject(context);
  const value = bundle(root);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-plan-bundle-outside-'));
  context.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(path.join(outside, '.tmp'), { recursive: true });
  fs.copyFileSync(
    path.join(root, '.tmp', 'experience-contract.json'),
    path.join(outside, '.tmp', 'experience-contract.json'),
  );
  fs.copyFileSync(
    path.join(root, '.tmp', 'mobile-plan-execution-preflight.json'),
    path.join(outside, '.tmp', 'mobile-plan-execution-preflight.json'),
  );
  fs.rmSync(path.join(root, '.tmp'), { recursive: true });
  fs.symlinkSync(path.join(outside, '.tmp'), path.join(root, '.tmp'));
  assert.throws(() => writePlanArtifactBundle(root, value), /symlink target is not allowed/);
  assert.equal(fs.existsSync(path.join(outside, 'dataverse-schema-contract.json')), false);
});
