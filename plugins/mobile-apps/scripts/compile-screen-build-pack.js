#!/usr/bin/env node
'use strict';

/**
 * Compile the approved product contracts into one compact, immutable assembly
 * sheet for parallel screen builders. It deliberately stores pointers and
 * decisions rather than copying the large Markdown references the planners use.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  contractHash,
  foundationContract,
  primaryComposition,
  validateExperienceContract,
} = require('./experience-patterns');
const { normalizeScreenContract } = require('./lib/experience-screen-contract');
const { buildRouteManifest, validateRouteManifest, writeAtomic: writeRouteManifestAtomic } = require('./route-manifest');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function requiredFile(projectRoot, relativePath, label) {
  const filePath = path.join(projectRoot, relativePath);
  if (!fs.existsSync(filePath)) throw new Error(`${label} is missing: ${relativePath}`);
  return filePath;
}

function toCells(line) {
  return line.split('|').slice(1, -1).map((cell) => cell.trim());
}

function parseScreenMap(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const index = lines.findIndex((line) => line.trim().toLowerCase() === '### screen map');
  if (index < 0) return [];
  const table = [];
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor].trim();
    if (/^#{1,3}\s+/.test(line)) break;
    if (line.startsWith('|')) table.push(line);
  }
  if (table.length < 2) return [];
  const headers = toCells(table[0]).map((value) => value.toLowerCase());
  const routeIndex = headers.indexOf('route');
  const fileIndex = headers.indexOf('file');
  const screenIndex = headers.indexOf('screen');
  if (routeIndex < 0 || fileIndex < 0 || screenIndex < 0) return [];
  return table.slice(2)
    .filter((line) => !/^\|(?:\s*:?-{3,}:?\s*\|)+$/.test(line))
    .map(toCells)
    .filter((cells) => cells.length > Math.max(routeIndex, fileIndex, screenIndex))
    .map((cells) => ({
      id: cells[screenIndex] || '',
      route: cells[routeIndex] || '',
      file: cells[fileIndex] || '',
    }))
    .filter((screen) => screen.id && screen.route && screen.file);
}

function identifier(value) {
  const words = String(value || '')
    .replace(/\([^)]*\)/g, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('') || 'Screen';
}

function testIdSegment(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

function validateInputs(contract, screenContract, foundation, normalizedScreens) {
  const issues = validateExperienceContract(contract);
  if (issues.length) throw new Error(`Experience contract is invalid: ${issues.join('; ')}`);
  if (![1, 2, 3].includes(screenContract?.schemaVersion) || screenContract.experienceContractSha256 !== contractHash(contract)) {
    throw new Error('Experience screen contract is missing or stale.');
  }
  const composition = primaryComposition(contract);
  const primary = screenContract.primaryScreen || normalizedScreens.find((screen) => screen.role === 'primary');
  if (!primary || primary.route !== contract.primaryScreen.route || primary.file !== contract.primaryScreen.file || primary.compositionKind !== composition.compositionKind) {
    throw new Error('Experience screen contract does not match the primary composition.');
  }
  const keyFlow = screenContract.keyFlow || normalizedScreens.find((screen) => screen.role === 'key-flow');
  if (!keyFlow || typeof keyFlow.route !== 'string' || keyFlow.route === primary.route || typeof keyFlow.file !== 'string' || typeof keyFlow.outcome !== 'string') {
    throw new Error('Experience screen contract requires a non-primary keyFlow.');
  }
  const expectedFoundation = foundationContract(contract);
  if (foundation?.schemaVersion !== 1 || foundation.experienceContractSha256 !== expectedFoundation.experienceContractSha256) {
    throw new Error('Experience foundation contract is missing or stale.');
  }
  const primitives = Array.isArray(foundation.primitives) ? foundation.primitives : [];
  if (primitives.length < 2 || primitives.length > 5) throw new Error('Experience foundation contract must contain 2-5 primitives.');
  for (const expected of expectedFoundation.primitives) {
    if (!primitives.some((primitive) => primitive?.motif === expected.motif && primitive.component === expected.component && primitive.file === expected.file && primitive.testID === expected.testID)) {
      throw new Error(`Experience foundation primitive is invalid: ${expected.motif}.`);
    }
  }
}

function dataIntent(projectRoot) {
  const domainPath = path.join(projectRoot, '.tmp', 'prototype-domain-model.json');
  const schemaPath = path.join(projectRoot, '.tmp', 'dataverse-schema-contract.json');
  const prototypePath = path.join(projectRoot, 'src', 'generated', '.prototype-manifest.json');
  if (fs.existsSync(domainPath)) {
    const domain = readJson(domainPath, 'Prototype domain model');
    return {
      adapter: 'local',
      entities: (domain.entities || []).map((entity) => entity.key || entity.displayName).filter(Boolean),
      path: '.tmp/prototype-domain-model.json',
      hash: sha256(fs.readFileSync(domainPath, 'utf8')),
    };
  }
  if (fs.existsSync(schemaPath)) {
    const schema = readJson(schemaPath, 'Data intent');
    const tables = Array.isArray(schema.tables) ? schema.tables : [];
    return {
      adapter: schema.planningMode === 'prototype' ? 'local' : 'dataverse',
      entities: tables.filter((table) => table.serviceRequired !== false && table.logicalName).map((table) => table.displayName || table.logicalName),
      path: '.tmp/dataverse-schema-contract.json',
      hash: sha256(fs.readFileSync(schemaPath, 'utf8')),
    };
  }
  if (fs.existsSync(prototypePath)) {
    const manifest = readJson(prototypePath, 'Prototype data intent');
    return {
      adapter: 'local',
      entities: Array.isArray(manifest.tables) ? manifest.tables : [],
      path: 'src/generated/.prototype-manifest.json',
      hash: sha256(fs.readFileSync(prototypePath, 'utf8')),
    };
  }
  throw new Error('Data intent is missing: expected .tmp/dataverse-schema-contract.json or src/generated/.prototype-manifest.json.');
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function semanticColorRoles() {
  return [
    ['brand-accent', 'limited-brand-emphasis', '$accentDeep'],
    ['primary-action', 'single-state-primary-action', '$accentBase'],
    ['selection', 'selected-navigation-or-option', '$accentSoft'],
    ['warning', 'blocked-progress-or-risk', '$statusPending'],
    ['error', 'invalid-or-failed-state', '$statusOverdue'],
    ['destructive', 'destructive-action-only', '$statusOverdue'],
    ['success', 'completed-or-confirmed-state', '$statusComplete'],
    ['informational', 'neutral-context-or-help', '$color10'],
  ].map(([role, intent, token]) => ({ role, intent, token }));
}

function cardRecipes() {
  return [
    { id: 'FeatureCard', purpose: 'focal-feature', density: 'balanced', anatomy: ['media-or-status', 'context', 'title', 'supporting-copy', 'primary-action'], mediaAspectRatio: '16:9', maxPrimaryActions: 1, dynamicHeight: true, maxTitleLines: 2 },
    { id: 'ProductCard', purpose: 'product-selection', density: 'balanced', anatomy: ['image', 'category', 'name', 'price', 'availability', 'action'], mediaAspectRatio: '4:3', maxPrimaryActions: 1, dynamicHeight: true, maxTitleLines: 2 },
    { id: 'RecordRow', purpose: 'record-navigation', density: 'dense', anatomy: ['identifier', 'status', 'metadata', 'disclosure'], mediaAspectRatio: null, maxPrimaryActions: 0, dynamicHeight: true, maxTitleLines: 2 },
    { id: 'ResumeCard', purpose: 'workflow-resume', density: 'balanced', anatomy: ['current-work', 'progress', 'saved-state', 'continue-action'], mediaAspectRatio: null, maxPrimaryActions: 1, dynamicHeight: true, maxTitleLines: 2 },
    { id: 'CategoryTile', purpose: 'category-navigation', density: 'balanced', anatomy: ['semantic-icon-or-image', 'short-label'], mediaAspectRatio: '1:1', maxPrimaryActions: 1, dynamicHeight: true, maxTitleLines: 2 },
    { id: 'StatusSummary', purpose: 'status-and-next-action', density: 'dense', anatomy: ['semantic-status', 'supporting-context', 'next-action'], mediaAspectRatio: null, maxPrimaryActions: 1, dynamicHeight: true, maxTitleLines: 2 },
  ];
}

function designRecipe(contract, primary, navigation, foundation) {
  const compositions = {
    'product-led-discovery': {
      id: 'product-discovery-home',
      requiredCardRecipes: ['FeatureCard', 'ProductCard', 'CategoryTile'],
      minimumVisibleRecords: 2,
      requiredMetadata: ['price', 'availability'],
      maxStepperStages: 0,
    },
    'task-led-workflow': {
      id: 'resumable-work-home',
      requiredCardRecipes: ['ResumeCard', 'RecordRow', 'StatusSummary'],
      minimumVisibleRecords: 2,
      requiredMetadata: ['status', 'next-action'],
      maxStepperStages: 4,
    },
    'decision-led-overview': {
      id: 'decision-overview-home',
      requiredCardRecipes: ['StatusSummary', 'RecordRow'],
      minimumVisibleRecords: 2,
      requiredMetadata: ['status', 'updated-at'],
      maxStepperStages: 0,
    },
  };
  const composition = compositions[contract.primarySurface] || {
    id: 'focused-tool-home',
    requiredCardRecipes: ['RecordRow', 'StatusSummary'],
    minimumVisibleRecords: 1,
    requiredMetadata: ['status'],
    maxStepperStages: 3,
  };
  return {
    hierarchy: {
      focalPoint: primary.firstViewport?.focalPoint || contract.firstViewport.focalPoint,
      maxFirstViewportRegions: primary.firstViewport?.maxRegions || contract.firstViewport.regionOrder.length,
      maxFeatureViewportShare: primary.firstViewport?.maxFeatureViewportShare || 0.4,
      nextContentVisible: primary.firstViewport?.nextContentVisible !== false,
    },
    actions: { primaryPlacement: primary.primaryAction?.placement || 'inline', maxPrimaryActionsPerState: 1 },
    navigation: { model: navigation.model, destinationCount: navigation.destinationCount, preserveNestedTabs: navigation.model === 'tabs-stack' },
    signatureComponent: primary.signatureComponent,
    density: contract.firstViewport.contentDensity,
    visualCharacter: contract.visualCharacter,
    media: { policy: contract.assetPolicy.media, fallbackRequired: contract.assetPolicy.media !== 'not-applicable' },
    spacing: { minimumControlSize: 44, minimumContentGap: 8 },
    semanticColorRoles: semanticColorRoles(),
    cardRecipes: cardRecipes(),
    composition: {
      ...composition,
      markerTestId: `composition-recipe-${composition.id}`,
      requiredCardRecipeTestIds: composition.requiredCardRecipes.map((recipe) => `composition-card-${testIdSegment(recipe)}`),
      forbidFloatingUtilityActions: true,
      requireCollectionBinding: composition.minimumVisibleRecords > 1,
    },
  };
}

function applicableStates(screen, journey) {
  const states = new Set(screen.states || []);
  const dataDriven = (screen.data?.entities || []).length > 0 || (screen.data?.operations || []).length > 0;
  if (dataDriven) ['populated', 'loading', 'empty', 'error', 'offline', 'retry'].forEach((state) => states.add(state));
  if ((screen.capabilityComposition || []).length) ['permission-denied', 'unavailable'].forEach((state) => states.add(state));
  if ((screen.data?.operations || []).some((operation) => ['create', 'update', 'delete'].includes(operation.kind))) states.add('success');
  const staged = (journey?.stages || []).some((stage) => stage.screenIds.includes(screen.id));
  if (journey?.resume?.supported && staged) ['interrupted', 'resumed'].forEach((state) => states.add(state));
  return [...states];
}

function enrichScreen(screen, basic, data, journey, contextContract) {
  const stage = (journey?.stages || []).find((item) => item.screenIds.includes(screen.id));
  const stateActions = (journey?.stateActions || []).filter((item) => item.screenId === screen.id);
  const guardedActions = stateActions
    .filter((item) => item.guardId)
    .map((item) => ({
      actionId: item.primaryAction,
      guardId: item.guardId,
      falseBehavior: 'disabled-with-reason',
      blockingMessage: (journey?.completionGuards || []).find((guard) => guard.id === item.guardId)?.blockingMessage || 'Complete the required work before continuing.',
    }));
  const signatureComponents = (journey?.signatureComponents || []).filter((component) => (
    (component.requiredOnStageScreens && stage)
    || (component.placement === 'primary-screen' && screen.role === 'primary')
    || (!component.requiredOnStageScreens && component.placement !== 'primary-screen' && stage)
  ));
  if (screen.signatureComponent?.required && screen.signatureComponent.testId
    && !signatureComponents.some((component) => component.testId === screen.signatureComponent.testId)) {
    signatureComponents.push({ ...screen.signatureComponent, placement: 'screen-contract', semanticRole: 'signature' });
  }
  const contextEntries = (contextContract?.displayContext || []).filter((entry) => (screen.context?.entryIds || []).includes(entry.id));
  const primaryAction = screen.primaryAction ? { ...screen.primaryAction } : null;
  const firstRegionCount = screen.firstViewport?.regionIds?.length || 0;
  const mediaRequired = screen.media?.required === true;
  const enriched = {
    ...basic,
    ...screen,
    productRole: screen.productRole || (screen.role === 'primary'
      ? 'durable-destination'
      : screen.role === 'key-flow' ? 'bounded-flow-step' : 'nested-detail'),
    headerMode: screen.header?.mode || basic.headerMode,
    firstViewport: {
      ...screen.firstViewport,
      visiblePrimaryAction: Boolean(primaryAction),
      primaryActionPlacement: primaryAction?.placement || 'none',
    },
    context: {
      ...screen.context,
      entries: contextEntries,
      forbiddenInferences: contextContract?.forbiddenInferences || [],
    },
    primaryAction,
    media: {
      ...screen.media,
      source: screen.media?.source || 'domain-fixture',
      delivery: contractMediaDelivery(basic.data.mediaPolicy),
      sizing: mediaRequired ? (firstRegionCount > 1 || primaryAction?.placement === 'inline' ? 'responsive-clamped' : 'responsive-aspect') : 'not-applicable',
      maxViewportShare: mediaRequired ? Math.min(screen.firstViewport?.maxFeatureViewportShare || 0.4, firstRegionCount > 1 ? 0.6 : 0.8) : 0,
    },
    states: applicableStates(screen, journey),
    dependencies: {
      ...screen.dependencies,
      artifacts: [...new Set([...(screen.dependencies?.artifacts || []), '.tmp/experience-contract.json', '.tmp/navigation-contract.json'])],
    },
    data: {
      ...basic.data,
      ...screen.data,
      adapter: data.adapter,
      viewModel: 'src/generated/experience-view-model.ts',
      recordIdentity: 'stable-primary-key',
      mediaPolicy: basic.data.mediaPolicy,
      mediaFields: basic.data.mediaFields,
    },
    journey: {
      journeyId: journey?.journeyId || null,
      journeyKind: journey?.journeyKind || null,
      stageId: stage?.id || null,
      stageOrder: stage?.order || null,
      visibleStages: (journey?.stages || []).map(({ id, label, order }) => ({ id, label, order })),
      completionRuleIds: stage ? [stage.completionRuleId] : [],
      resumeBehavior: journey?.resume?.supported ? 'restore-current-stage-and-draft' : 'none',
      continuityBindings: (journey?.continuityKeys || []).map((key) => ({ key, source: 'workflow-state' })),
    },
    actionState: { primaryActionId: primaryAction?.id || null, stateActions, guardedActions },
    signatureComponents,
    testIds: [...new Set([
      ...(screen.testIds || basic.testIds || []),
      ...signatureComponents.map((component) => component.testId).filter(Boolean),
    ])],
    semanticColorRoles: semanticColorRoles(),
    capabilityComposition: screen.capabilityComposition || [],
    layoutBudgets: {
      maxFocalViewportShare: screen.firstViewport?.maxFeatureViewportShare || 0.4,
      requiredFirstViewportRegions: [...(screen.firstViewport?.regionIds || [])],
      requireJourneyContext: Boolean(stage && (journey?.stages || []).length > 1),
      maxReservedFooterShare: 0.2,
      stickySurfaceOrder: [
        'content',
        ...(primaryAction?.placement === 'sticky-bottom' ? ['primary-action'] : []),
        ...(screen.navigation?.kind === 'tab-root' ? ['tabs'] : []),
        'safe-area',
      ],
    },
    contractSource: screen.contractSource || 'structured',
  };
  enriched.states = applicableStates(enriched, journey);
  return enriched;
}

function contractMediaDelivery(mediaPolicy) {
  if (mediaPolicy === 'local-first') return 'bundled';
  if (mediaPolicy === 'remote-cdn-cached') return 'remote-cached-with-bundled-fallback';
  if (mediaPolicy === 'remote-allowed') return 'remote-with-bundled-fallback';
  return 'not-applicable';
}

function builderWaves(screens, criticalFlow, foundation) {
  return [
    { id: 'foundations', kind: 'foundation', targets: foundation.primitives.map((primitive) => primitive.component), dependsOn: [] },
    ...chunks(screens, 5).map((wave, index) => ({
      id: `screens-${index + 1}`,
      kind: 'screen',
      targets: wave.map((screen) => screen.id),
      dependsOn: ['foundations'],
      maxConcurrency: Math.min(5, wave.length),
      gates: ['typecheck', 'static-quality-review'],
    })),
  ];
}

function screenRecord(screen, primary, keyFlow, foundation, data, contract) {
  const isPrimary = screen.route === primary.route;
  const isKeyFlow = screen.route === keyFlow.route;
  const foundationComponents = foundation.primitives.map((primitive) => primitive.component);
  return {
    id: isPrimary ? 'Home' : isKeyFlow ? identifier(keyFlow.route) : identifier(screen.id),
    route: screen.route,
    file: screen.file,
    role: isPrimary ? 'primary' : isKeyFlow ? 'key-flow' : 'supporting',
    headerMode: isPrimary ? 'root' : 'back',
    purpose: isPrimary ? contract.primaryJob : isKeyFlow ? keyFlow.outcome : `Support ${contract.primaryJob.toLowerCase()}`,
    firstViewport: isPrimary
      ? [...contract.firstViewport.regionOrder.map((region) => `experience-region-${region}`), ...foundationComponents]
      : [],
    primaryAction: isPrimary ? contract.firstViewport.primaryAction : null,
    states: ['loading', 'empty', 'error', 'offline'],
    dependencies: isPrimary
      ? [...foundation.primitives.map((primitive) => primitive.file), ...data.entities.map((entity) => `fixture:${entity}`)]
      : isKeyFlow
        ? [`screen:${primary.route}`, ...foundation.primitives.map((primitive) => primitive.file)]
        : [],
    testIds: isPrimary
      ? primary.runtimeMarkers
      : isKeyFlow
        ? ['experience-key-flow']
        : [],
    data: {
      adapter: data.adapter,
      entities: data.entities,
      viewModel: 'src/generated/experience-view-model.ts',
      recordIdentity: 'stable-primary-key',
      mediaPolicy: contract.assetPolicy.media,
      mediaFields: ['imageUrl', 'imageAltText', 'imageCacheKey', 'imageAssetKey'],
    },
  };
}

function revisionForPack(pack) {
  const copy = { ...pack };
  delete copy.revision;
  return sha256(stableStringify(copy));
}

function uiContractProjection(pack) {
  return {
    productStructure: pack.productStructure,
    capabilityBindings: pack.capabilityBindings,
    journey: pack.journey,
    shell: pack.shell,
    navigation: pack.navigation,
    design: {
      hierarchy: pack.design?.recipe?.hierarchy,
      actions: pack.design?.recipe?.actions,
      navigation: pack.design?.recipe?.navigation,
      signatureComponent: pack.design?.recipe?.signatureComponent,
      primitives: pack.design?.primitives,
      signatureComponents: pack.design?.signatureComponents,
      tokenSourceBindings: pack.design?.tokenSourceBindings,
      escapePolicy: pack.design?.escapePolicy,
    },
    screens: (pack.screens || []).map((screen) => ({
      id: screen.id,
      route: screen.route,
      role: screen.role,
      productRole: screen.productRole,
      purpose: screen.purpose,
      navigation: screen.navigation,
      headerMode: screen.headerMode,
      regions: screen.regions,
      firstViewport: screen.firstViewport,
      signatureComponent: screen.signatureComponent,
      primaryAction: screen.primaryAction,
      journey: screen.journey,
      actionState: screen.actionState,
      signatureComponents: screen.signatureComponents,
      semanticColorRoles: screen.semanticColorRoles,
      capabilityComposition: screen.capabilityComposition,
      layoutBudgets: screen.layoutBudgets,
      ux: screen.ux,
    })),
  };
}

function uiContractFingerprint(pack) {
  return sha256(stableStringify(uiContractProjection(pack)));
}

function compileScreenBuildPack(projectRoot) {
  const root = path.resolve(projectRoot);
  const experiencePath = requiredFile(root, '.tmp/experience-contract.json', 'Experience contract');
  const screenPath = requiredFile(root, '.tmp/experience-screen-contract.json', 'Experience screen contract');
  const foundationPath = requiredFile(root, '.tmp/experience-foundation-contract.json', 'Experience foundation contract');
  const planPath = requiredFile(root, 'native-app-plan.md', 'Native app plan');
  const designSystemPath = requiredFile(root, 'brand/design-system.md', 'Design recipe');
  const tokensPath = requiredFile(root, 'brand/tokens.ts', 'Design tokens');
  const contract = readJson(experiencePath, 'Experience contract');
  const screenContract = readJson(screenPath, 'Experience screen contract');
  const foundation = readJson(foundationPath, 'Experience foundation contract');
  const data = dataIntent(root);
  const screenMap = parseScreenMap(fs.readFileSync(planPath, 'utf8'));
  const normalizedScreens = normalizeScreenContract(
    screenContract,
    contract,
    screenMap,
    foundation.primitives.map((primitive) => primitive.component),
  );
  validateInputs(contract, screenContract, foundation, normalizedScreens);
  const primary = screenContract.primaryScreen || normalizedScreens.find((screen) => screen.role === 'primary');
  const keyFlow = screenContract.keyFlow || normalizedScreens.find((screen) => screen.role === 'key-flow');
  const contextPath = path.join(root, '.tmp', 'context-enrichment-contract.json');
  const journeyPath = path.join(root, '.tmp', 'workflow-journey-contract.json');
  const navigationPath = path.join(root, '.tmp', 'navigation-contract.json');
  const richContract = screenContract.schemaVersion >= 2 && fs.existsSync(journeyPath) && fs.existsSync(navigationPath);
  const contextContract = fs.existsSync(contextPath) ? readJson(contextPath, 'Context enrichment contract') : null;
  const journey = fs.existsSync(journeyPath) ? readJson(journeyPath, 'Workflow journey') : null;
  const navigation = fs.existsSync(navigationPath) ? readJson(navigationPath, 'Navigation contract') : null;
  const mergedScreens = [...screenMap];
  for (const screen of [
    { id: 'Home', route: primary.route, file: primary.file },
    { id: identifier(keyFlow.route), route: keyFlow.route, file: keyFlow.file },
  ]) {
    if (!mergedScreens.some((candidate) => candidate.route === screen.route)) mergedScreens.push(screen);
  }
  const screens = mergedScreens.map((screen) => {
    const basic = screenRecord(screen, primary, keyFlow, foundation, data, contract);
    const structured = normalizedScreens.find((candidate) => candidate.route === screen.route);
    if (!structured) return basic;
    return richContract ? enrichScreen(structured, basic, data, journey, contextContract) : { ...basic, ux: structured };
  });
  const primaryScreen = screens.find((screen) => screen.role === 'primary');
  const keyFlowScreen = screens.find((screen) => screen.role === 'key-flow');
  const sourcePaths = {
    experienceContract: '.tmp/experience-contract.json',
    screenContract: '.tmp/experience-screen-contract.json',
    foundationContract: '.tmp/experience-foundation-contract.json',
    designSystem: 'brand/design-system.md',
    tokens: 'brand/tokens.ts',
    dataIntent: data.path,
    ...(fs.existsSync(path.join(root, '.tmp', 'workflow-journey-contract.json'))
      ? { workflowJourney: '.tmp/workflow-journey-contract.json' }
      : {}),
    ...(fs.existsSync(path.join(root, '.tmp', 'navigation-contract.json'))
      ? { navigationContract: '.tmp/navigation-contract.json' }
      : {}),
  };
  const pack = {
    schemaVersion: richContract ? 2 : 1,
    ...(richContract ? { screenContractVersion: screenContract.schemaVersion } : {}),
    sources: {
      experienceContract: sha256(fs.readFileSync(experiencePath, 'utf8')),
      screenContract: sha256(fs.readFileSync(screenPath, 'utf8')),
      foundationContract: sha256(fs.readFileSync(foundationPath, 'utf8')),
      designRecipe: sha256(`${fs.readFileSync(designSystemPath, 'utf8')}\n${fs.readFileSync(tokensPath, 'utf8')}`),
      dataIntent: data.hash,
      ...(sourcePaths.workflowJourney
        ? { workflowJourney: sha256(fs.readFileSync(path.join(root, sourcePaths.workflowJourney), 'utf8')) }
        : {}),
      ...(sourcePaths.navigationContract
        ? { navigationContract: sha256(fs.readFileSync(path.join(root, sourcePaths.navigationContract), 'utf8')) }
        : {}),
    },
    sourcePaths,
    experience: {
      audience: contract.audience,
      primaryJob: contract.primaryJob,
      interactionMode: contract.interactionMode,
      entryMode: contract.entryMode,
      primarySurface: contract.primarySurface,
      contentModel: contract.contentModel,
      assetPolicy: contract.assetPolicy,
      forbiddenDefaults: contract.forbiddenDefaults,
      firstViewport: contract.firstViewport,
      signatureMotifs: contract.signatureMotifs,
      promptEvidence: contract.promptEvidence,
    },
    design: {
      tokensPath: 'brand/tokens.ts',
      designSystemPath: 'brand/design-system.md',
      primitives: foundation.primitives.map((primitive) => ({
        motif: primitive.motif,
        component: primitive.component,
        file: primitive.file,
        testID: primitive.testID,
      })),
      ...(richContract ? {
        recipe: designRecipe(contract, screens.find((screen) => screen.role === 'primary'), navigation, foundation),
        signatureComponents: foundation.primitives.map((primitive) => ({ kind: primitive.motif, component: primitive.component, testId: primitive.testID })),
        tokenSourceBindings: { palette: 'brand/tokens.ts', typography: 'brand/tokens.ts', semantics: 'brand/design-system.md' },
        escapePolicy: { explicitOptionalModesOnly: true, industryPresetForbidden: true },
      } : {}),
    },
    shell: {
      safeAreaOwner: 'screen',
      rootSafeAreaProviderOnly: true,
      headerModes: Object.fromEntries(screens.map((screen) => [screen.route, screen.headerMode])),
    },
    journey,
    navigation: navigation
      ? { ...navigation, criticalFlow: screenContract.criticalFlow }
      : {
          initialRoute: primary.route,
          keyFlowRoute: keyFlow.route,
          routes: screens.map((screen) => screen.route),
        },
    fixtures: {
      adapter: data.adapter,
      entities: data.entities,
      assetPolicy: contract.assetPolicy.media,
      dataIntentPath: data.path,
      assetManifest: 'assets/experience/manifest.json',
      viewModel: 'src/generated/experience-view-model.ts',
      recordIdentity: 'stable-primary-key',
      mediaPolicy: contract.assetPolicy.media,
      mediaManifest: 'assets/experience/manifest.json',
      mediaFields: ['imageUrl', 'imageAltText', 'imageCacheKey', 'imageAssetKey'],
    },
    screens,
    ...(richContract ? {
      productStructure: {
        primaryScreenId: navigation.routingPolicy.primaryScreenId,
        launchScreenId: navigation.routingPolicy.launchScreenId,
        resumeScreenId: navigation.routingPolicy.resumeScreenId,
        criticalFlowScreenIds: [...screenContract.criticalFlow.screenIds],
      },
      capabilityBindings: screens.flatMap((screen) => (screen.capabilityComposition || []).map((capability) => ({ screenId: screen.id, ...capability }))),
      builderWaves: builderWaves(screens, screenContract.criticalFlow, foundation),
    } : {}),
    buildOrder: [
      ...foundation.primitives.map((primitive) => ({ kind: 'foundation', id: primitive.component, file: primitive.file, dependsOn: [] })),
      { kind: 'screen', id: primaryScreen.id, route: primaryScreen.route, dependsOn: foundation.primitives.map((primitive) => primitive.component) },
      { kind: 'screen', id: keyFlowScreen.id, route: keyFlowScreen.route, dependsOn: [primaryScreen.id, ...foundation.primitives.map((primitive) => primitive.component)] },
      ...screens.filter((screen) => !['primary', 'key-flow'].includes(screen.role)).map((screen) => ({ kind: 'screen', id: screen.id, route: screen.route, dependsOn: [primaryScreen.id] })),
    ],
    invalidation: {
      screenDependencies: Object.fromEntries(screens.map((screen) => [screen.id, screen.role === 'supporting'
        ? ['screenContract', 'designRecipe', 'dataIntent']
        : ['experienceContract', 'screenContract', 'foundationContract', 'designRecipe', 'dataIntent']])),
      fixtureDependencies: Object.fromEntries(data.entities.map((entity) => [entity, ['experienceContract', 'dataIntent']])),
      validatorDependencies: {
        experience: ['experienceContract', 'screenContract', 'foundationContract'],
        nativeVisual: ['experienceContract', 'screenContract', 'foundationContract', 'designRecipe'],
      },
    },
  };
  if (richContract) pack.uiContractFingerprint = uiContractFingerprint(pack);
  pack.revision = revisionForPack(pack);
  return pack;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--output') args.output = argv[++index];
    else if (argv[index] === '--json') args.json = true;
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args.projectRoot) {
    process.stderr.write('Usage: node compile-screen-build-pack.js --project-root <dir> [--output <path>] [--json]\n');
    return 2;
  }
  try {
    const root = path.resolve(args.projectRoot);
    const pack = compileScreenBuildPack(root);
    const output = path.resolve(root, args.output || '.tmp/screen-build-pack.json');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(pack, null, 2)}\n`);
    if (pack.schemaVersion === 2) {
      const routeManifest = buildRouteManifest(pack);
      const routeErrors = validateRouteManifest(routeManifest, pack);
      if (routeErrors.length) throw new Error(`Route manifest is invalid: ${routeErrors.join('; ')}`);
      writeRouteManifestAtomic(path.join(root, '.tmp', 'route-manifest.json'), routeManifest);
    }
    if (args.json) process.stdout.write(`${JSON.stringify({ output, revision: pack.revision }, null, 2)}\n`);
    else process.stdout.write(`Screen build pack written: ${output} (${pack.revision})\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`BLOCKED: screen build pack: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  compileScreenBuildPack,
  parseScreenMap,
  revisionForPack,
  sha256,
  stableStringify,
  uiContractFingerprint,
  uiContractProjection,
};