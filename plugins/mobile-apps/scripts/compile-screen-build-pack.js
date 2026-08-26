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
const { resolveIconName } = require('./lib/navigation-icons');
const { buildRouteManifest, validateRouteManifest, writeAtomic: writeRouteManifestAtomic } = require('./route-manifest');
const { validateScreenActionContract } = require('./validate-screen-action-contract');

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

function actionHandlerName(actionId) {
  return `handle${identifier(actionId)}`;
}

function actionAvailabilityName(actionId) {
  return `is${identifier(actionId)}Available`;
}

function actionCommandName(executor) {
  if (!['local', 'host'].includes(executor?.kind)) return null;
  return `execute${executor.kind === 'host' ? 'Host' : ''}${identifier(executor.target)}`;
}

function actionBadgeValueName(actionId) {
  const name = identifier(actionId);
  return `${name.charAt(0).toLowerCase()}${name.slice(1)}BadgeValue`;
}

function compileActionBindings(actions, screens, domainModel, screenContract, executionContract, serviceSurface = null) {
  const screenById = new Map(screens.map((screen) => [screen.id, screen]));
  const structuredOperations = (screenContract?.screens || []).flatMap((screen) => (screen.data?.operations || []).map((operation) => ({
    ...operation,
    key: operation.domainOperation || operation.id,
    method: operation.repositoryMethod,
  })));
  const operationByKey = new Map([
    ...structuredOperations.map((operation) => [operation.key, operation]),
    ...(domainModel?.operations || []).map((operation) => [operation.key, operation]),
  ]);
  const connectorScreenOperations = new Map((screenContract?.screens || []).flatMap((screen) => (
    (screen.data?.operations || [])
      .filter((operation) => operation.kind === 'connector')
      .map((operation) => [operation.connectorOperationId, operation])
  )));
  const connectorExecution = new Map((executionContract?.connectorOperations || []).map((operation) => [operation.id, operation]));
  const serviceByEntity = new Map((serviceSurface?.entries || []).flatMap((entry) => (
    [entry.entity, ...(entry.aliases || [])].map((entity) => [entity, entry])
  )));
  const methodByKind = { list: 'getAll', get: 'get', create: 'create', update: 'update', delete: 'delete' };
  return (actions || []).map((action) => {
    const executor = action.executor || {};
    const targetScreen = executor.kind === 'route' ? screenById.get(executor.target) : null;
    const operation = executor.kind === 'operation' ? operationByKey.get(executor.target) : null;
    const generatedService = executor.kind === 'operation' && !operation ? serviceByEntity.get(executor.entity) : null;
    const connectorOperation = executor.kind === 'connector' ? connectorScreenOperations.get(executor.target) : null;
    return {
      id: action.id,
      label: action.label,
      screenId: action.screenId,
      semanticRole: action.semanticRole,
      placement: action.placement,
      testId: `action-${action.id}`,
      handlerName: actionHandlerName(action.id),
      availabilityName: actionAvailabilityName(action.id),
      executor: {
        ...executor,
        ...(['local', 'host'].includes(executor.kind) ? { commandName: actionCommandName(executor) } : {}),
        ...(targetScreen ? { route: targetScreen.route } : {}),
        ...(operation ? {
          provider: 'domain-hook',
          operationKind: operation.kind,
          entity: operation.entity,
          repository: operation.repository,
          repositoryMethod: operation.method,
          hook: operation.hook,
          writeFields: [...(operation.writeFields || [])],
        } : {}),
        ...(generatedService?.status === 'available' ? {
          provider: 'generated-service',
          operationKind: executor.operationKind,
          entity: executor.entity,
          service: generatedService.service,
          serviceModule: generatedService.serviceModule,
          serviceMethod: methodByKind[executor.operationKind],
        } : {}),
        ...(connectorOperation ? {
          repository: connectorOperation.repository,
          repositoryMethod: connectorOperation.repositoryMethod,
          hook: connectorOperation.hook,
          connectorExecutionId: connectorExecution.get(executor.target)?.id || executor.target,
        } : {}),
      },
      inputs: (action.inputs || []).map((binding) => ({ ...binding, source: { ...binding.source } })),
      availability: (action.availability || []).map((condition) => ({
        ...condition,
        left: { ...condition.left },
        ...(condition.right ? { right: { ...condition.right } } : {}),
      })),
      ...(action.controlHint ? {
        controlHint: {
          ...action.controlHint,
          ...(action.controlHint.iconIntent ? { iconName: resolveIconName(action.controlHint.iconIntent) } : {}),
          ...(action.controlHint.badge ? {
            badge: {
              ...action.controlHint.badge,
              source: { ...action.controlHint.badge.source },
              valueName: actionBadgeValueName(action.id),
            },
          } : {}),
        },
      } : {}),
      ...(action.pendingLabel ? { pendingLabel: action.pendingLabel } : {}),
      ...(action.failureMessage ? { failureMessage: action.failureMessage } : {}),
    };
  });
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

const COMPOSITION_PROFILES = Object.freeze({
  'discovery-merchandising': {
    structuralRoles: ['journey-context', 'curated-feature', 'category-navigation', 'product-collection'],
    recommendedRecipes: ['FeatureCard', 'CategoryTile', 'ProductCard'],
    interactionPatterns: ['contextual-discovery', 'bounded-category-switching', 'purposeful-media-collection'],
  },
  'availability-discovery': {
    structuralRoles: ['selection-context', 'availability-focus', 'guided-choice', 'supporting-options'],
    recommendedRecipes: ['StatusSummary', 'FeatureCard', 'RecordRow'],
    interactionPatterns: ['bounded-choice', 'availability-feedback', 'visible-selection-state'],
  },
  'learning-continuation': {
    structuralRoles: ['learning-context', 'progress-summary', 'next-learning-step', 'supporting-content'],
    recommendedRecipes: ['StatusSummary', 'ResumeCard', 'FeatureCard'],
    interactionPatterns: ['progressive-disclosure', 'continue-action', 'progress-feedback'],
  },
  'conversation-attention': {
    structuralRoles: ['workspace-context', 'attention-summary', 'conversation-collection', 'next-conversation-action'],
    recommendedRecipes: ['StatusSummary', 'RecordRow'],
    interactionPatterns: ['attention-ordering', 'unread-state', 'dense-conversation-rows'],
  },
  'content-feed': {
    structuralRoles: ['feed-context', 'fresh-content', 'content-collection', 'creator-action'],
    recommendedRecipes: ['FeatureCard', 'RecordRow'],
    interactionPatterns: ['content-continuation', 'bounded-reactions', 'creator-entry'],
  },
  'priority-workspace': {
    structuralRoles: ['work-context', 'priority-work', 'status-and-next-action', 'supporting-collection'],
    recommendedRecipes: ['StatusSummary', 'FeatureCard', 'RecordRow'],
    interactionPatterns: ['priority-ordering', 'visible-next-action', 'dense-operational-rows'],
  },
  'staged-workspace': {
    structuralRoles: ['work-context', 'workflow-progress', 'current-work', 'supporting-collection'],
    recommendedRecipes: ['StatusSummary', 'ResumeCard', 'RecordRow'],
    interactionPatterns: ['stage-progress', 'continue-action', 'dense-operational-rows'],
  },
  'attention-led-overview': {
    structuralRoles: ['scope-context', 'decision-summary', 'attention-queue', 'supporting-collection'],
    recommendedRecipes: ['StatusSummary', 'FeatureCard', 'RecordRow'],
    interactionPatterns: ['decision-ordering', 'status-distribution', 'quick-actions'],
  },
  'focused-capture': {
    structuralRoles: ['task-context', 'capture-surface', 'manual-fallback', 'result-feedback'],
    recommendedRecipes: ['StatusSummary', 'FeatureCard'],
    interactionPatterns: ['permission-aware-capture', 'manual-fallback', 'result-confirmation'],
  },
  'guided-onboarding': {
    structuralRoles: ['step-context', 'value-preview', 'guided-input', 'forward-action'],
    recommendedRecipes: ['FeatureCard', 'StatusSummary'],
    interactionPatterns: ['single-step-focus', 'progressive-disclosure', 'forward-action'],
  },
  'operational-queue': {
    structuralRoles: ['queue-context', 'filter-controls', 'grouped-record-collection', 'record-status-metadata'],
    recommendedRecipes: ['StatusSummary', 'RecordRow'],
    interactionPatterns: ['bounded-filtering', 'status-ordering', 'dense-operational-rows'],
  },
  'collection-browser': {
    structuralRoles: ['collection-context', 'filter-or-category-controls', 'record-collection', 'record-navigation'],
    recommendedRecipes: ['CategoryTile', 'ProductCard', 'RecordRow'],
    interactionPatterns: ['bounded-filtering', 'visible-selection-state', 'record-navigation'],
  },
  'guided-work-step': {
    structuralRoles: ['stage-context', 'work-inputs', 'exception-summary', 'primary-actions'],
    recommendedRecipes: ['StatusSummary', 'RecordRow'],
    interactionPatterns: ['grouped-work-inputs', 'exception-callout', 'persistent-actions'],
  },
  'review-confirmation': {
    structuralRoles: ['stage-context', 'decision-inputs', 'supporting-evidence', 'confirmation-context', 'primary-action'],
    recommendedRecipes: ['StatusSummary', 'RecordRow'],
    interactionPatterns: ['segmented-decision', 'evidence-section', 'confirmation-summary'],
  },
  'record-detail': {
    structuralRoles: ['record-identity', 'decision-summary', 'detail-sections', 'record-actions'],
    recommendedRecipes: ['StatusSummary', 'FeatureCard', 'RecordRow'],
    interactionPatterns: ['grouped-detail-sections', 'status-context', 'bounded-actions'],
  },
  'focused-form': {
    structuralRoles: ['form-context', 'grouped-inputs', 'validation-summary', 'primary-action'],
    recommendedRecipes: ['StatusSummary'],
    interactionPatterns: ['grouped-inputs', 'inline-validation', 'persistent-actions'],
  },
  'record-collection': {
    structuralRoles: ['collection-context', 'filter-controls', 'record-collection', 'collection-action'],
    recommendedRecipes: ['StatusSummary', 'RecordRow'],
    interactionPatterns: ['bounded-filtering', 'dense-record-rows', 'record-navigation'],
  },
  'utility-detail': {
    structuralRoles: ['utility-context', 'settings-sections', 'support-actions'],
    recommendedRecipes: ['StatusSummary', 'RecordRow'],
    interactionPatterns: ['grouped-settings', 'clear-labels', 'separated-destructive-action'],
  },
  'supporting-content': {
    structuralRoles: ['screen-context', 'primary-content', 'supporting-content', 'screen-action'],
    recommendedRecipes: ['FeatureCard', 'RecordRow'],
    interactionPatterns: ['clear-hierarchy', 'bounded-actions'],
  },
});

function primaryCompositionProfile(contract, journey) {
  if (contract.primarySurface === 'product-led-discovery') return 'discovery-merchandising';
  if (contract.primarySurface === 'availability-led-discovery') return 'availability-discovery';
  if (contract.primarySurface === 'learning-journey') return 'learning-continuation';
  if (contract.primarySurface === 'conversation-led-inbox') return 'conversation-attention';
  if (contract.primarySurface === 'content-led-feed') return 'content-feed';
  if (contract.primarySurface === 'task-led-workflow') return (journey?.stages || []).length > 1 ? 'staged-workspace' : 'priority-workspace';
  if (contract.primarySurface === 'decision-led-overview') return 'attention-led-overview';
  if (contract.primarySurface === 'capture-led-utility') return 'focused-capture';
  if (contract.primarySurface === 'guided-onboarding') return 'guided-onboarding';
  return 'supporting-content';
}

function supportingCompositionProfile(screen, contract, journey) {
  if (screen.navigation?.role === 'global-utility') return 'utility-detail';
  if (screen.navigation?.role === 'immersive-modal' || screen.presentation?.pattern === 'capture') return 'focused-capture';
  if (screen.navigation?.role === 'durable-destination'
    && ['compact-list', 'image-list', 'image-card-grid', 'timeline'].includes(screen.presentation?.pattern)) {
    return ['operate', 'track'].includes(contract.interactionMode) ? 'operational-queue' : 'collection-browser';
  }
  const stage = (journey?.stages || []).find((item) => (item.screenIds || []).includes(screen.id));
  if (stage) {
    const finalStage = stage.order === (journey?.stages || []).length && (journey?.stages || []).length > 1;
    return finalStage ? 'review-confirmation' : 'guided-work-step';
  }
  if (screen.presentation?.pattern === 'detail') return 'record-detail';
  if (screen.presentation?.pattern === 'form' || screen.presentation?.pattern === 'guided-flow') return 'focused-form';
  if (['compact-list', 'image-list', 'image-card-grid', 'timeline'].includes(screen.presentation?.pattern)) return 'record-collection';
  return 'supporting-content';
}

function deriveCompositionGuidance(screen, contract, journey) {
  const profile = screen.role === 'primary'
    ? primaryCompositionProfile(contract, journey)
    : supportingCompositionProfile(screen, contract, journey);
  const policy = COMPOSITION_PROFILES[profile];
  return {
    version: 1,
    source: 'deterministic-compiler',
    enforcement: 'advisory-with-structural-baseline',
    profile,
    structuralRoles: [...policy.structuralRoles],
    recommendedRecipes: [...policy.recommendedRecipes],
    interactionPatterns: [...policy.interactionPatterns],
    density: screen.presentation?.density || contract.firstViewport.contentDensity,
    equivalentImplementationsAllowed: true,
    absencePolicy: 'fall-back-to-screen-contract-and-domain-layout-decisions',
  };
}

function designRecipe(contract, primary, navigation, foundation) {
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

function enrichScreen(screen, basic, data, journey, contextContract, contract, actionBindings = []) {
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
  const declaredContextIds = screen.context?.entryIds || [];
  const primaryContextIds = screen.role === 'primary' && declaredContextIds.length === 0
    ? (contextContract?.displayContext || [])
      .filter((entry) => entry.placementIntent === 'primary-screen-context-rail')
      .map((entry) => entry.id)
    : [];
  const contextEntryIds = declaredContextIds.length ? declaredContextIds : primaryContextIds;
  const contextEntries = (contextContract?.displayContext || []).filter((entry) => contextEntryIds.includes(entry.id));
  const primaryBinding = actionBindings.find((action) => action.semanticRole === 'primary');
  const primaryAction = screen.primaryAction
    ? { ...screen.primaryAction, ...(primaryBinding ? { id: primaryBinding.id, label: primaryBinding.label, binding: primaryBinding.id, placement: primaryBinding.placement } : {}) }
    : primaryBinding
      ? { id: primaryBinding.id, label: primaryBinding.label, binding: primaryBinding.id, placement: primaryBinding.placement }
      : null;
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
      entryIds: contextEntryIds,
      placementIntent: contextEntries.length
        ? (screen.context?.placementIntent === 'none' ? contextEntries[0].placementIntent : screen.context?.placementIntent || contextEntries[0].placementIntent)
        : 'none',
      assumptions: [...new Set([...(screen.context?.assumptions || []), ...contextEntries.map((entry) => entry.assumption)])],
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
    actionBindings,
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
  enriched.compositionGuidance = deriveCompositionGuidance(enriched, contract, journey);
  return enriched;
}

function contractMediaDelivery(mediaPolicy) {
  if (mediaPolicy === 'local-first') return 'bundled';
  if (mediaPolicy === 'remote-cdn-cached') return 'remote-cached-with-bundled-fallback';
  if (mediaPolicy === 'remote-allowed') return 'remote-with-bundled-fallback';
  return 'not-applicable';
}

function builderWaves(screens, criticalFlow, foundation) {
  const criticalIds = [...new Set(criticalFlow?.screenIds || screens.filter((screen) => ['primary', 'key-flow'].includes(screen.role)).map((screen) => screen.id))];
  const supporting = screens.filter((screen) => !criticalIds.includes(screen.id));
  return [
    { id: 'foundations', kind: 'foundation', targets: foundation.primitives.map((primitive) => primitive.component), dependsOn: [] },
    { id: 'native-canary', kind: 'screen', targets: criticalIds, dependsOn: ['foundations'] },
    ...chunks(supporting, 5).map((wave, index) => ({ id: `supporting-${index + 1}`, kind: 'screen', targets: wave.map((screen) => screen.id), dependsOn: [index === 0 ? 'native-canary' : `supporting-${index}`] })),
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
    actionBindings: pack.actionBindings,
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
      actionBindings: screen.actionBindings,
      signatureComponents: screen.signatureComponents,
      semanticColorRoles: screen.semanticColorRoles,
      capabilityComposition: screen.capabilityComposition,
      layoutBudgets: screen.layoutBudgets,
      compositionGuidance: screen.compositionGuidance,
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
  const domainModel = data.path === '.tmp/prototype-domain-model.json' ? readJson(path.join(root, data.path), 'Prototype domain model') : null;
  const dataverseSchema = data.path === '.tmp/dataverse-schema-contract.json' ? readJson(path.join(root, data.path), 'Dataverse schema contract') : null;
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
  const primaryScreenId = normalizedScreens.find((screen) => screen.route === primary.route)?.id || 'Home';
  const keyFlowScreenId = normalizedScreens.find((screen) => screen.route === keyFlow.route)?.id || identifier(keyFlow.route);
  const criticalFlow = Array.isArray(screenContract.criticalFlow?.screenIds)
    && screenContract.criticalFlow.screenIds.length >= 2
    ? screenContract.criticalFlow
    : {
        screenIds: [...new Set([primaryScreenId, keyFlowScreenId])],
        outcome: screenContract.criticalFlow?.outcome || keyFlow.outcome,
      };
  const contextPath = path.join(root, '.tmp', 'context-enrichment-contract.json');
  const journeyPath = path.join(root, '.tmp', 'workflow-journey-contract.json');
  const navigationPath = path.join(root, '.tmp', 'navigation-contract.json');
  const actionPath = path.join(root, '.tmp', 'screen-action-contract.json');
  const executionPath = path.join(root, '.tmp', 'mobile-plan-execution-contract.json');
  const serviceSurfacePath = path.join(root, '.tmp', 'generated-service-surface.json');
  const richContract = screenContract.schemaVersion >= 2 && fs.existsSync(journeyPath) && fs.existsSync(navigationPath);
  const contextContract = fs.existsSync(contextPath) ? readJson(contextPath, 'Context enrichment contract') : null;
  const journey = fs.existsSync(journeyPath) ? readJson(journeyPath, 'Workflow journey') : null;
  const navigation = fs.existsSync(navigationPath) ? readJson(navigationPath, 'Navigation contract') : null;
  const actionContract = fs.existsSync(actionPath) ? readJson(actionPath, 'Screen action contract') : null;
  const executionContract = fs.existsSync(executionPath) ? readJson(executionPath, 'Mobile plan execution contract') : null;
  const serviceSurface = fs.existsSync(serviceSurfacePath) ? readJson(serviceSurfacePath, 'Generated service surface') : null;
  if (actionContract) {
    const actionValidation = validateScreenActionContract(actionContract, {
      screenContract: { ...screenContract, screens: normalizedScreens },
      domainModel,
      executionContract,
      serviceSurface,
      dataverseSchema,
      workflowJourney: journey,
      phase: 'build',
    });
    if (!actionValidation.valid) throw new Error(`Screen action contract is invalid: ${actionValidation.errors.join('; ')}`);
  }
  const mergedScreens = [...screenMap];
  for (const screen of [
    { id: 'Home', route: primary.route, file: primary.file },
    { id: identifier(keyFlow.route), route: keyFlow.route, file: keyFlow.file },
  ]) {
    if (!mergedScreens.some((candidate) => candidate.route === screen.route)) mergedScreens.push(screen);
  }
  const compiledActions = compileActionBindings(actionContract?.actions || [], normalizedScreens, domainModel, screenContract, executionContract, serviceSurface);
  const screens = mergedScreens.map((screen) => {
    const basic = screenRecord(screen, primary, keyFlow, foundation, data, contract);
    const structured = normalizedScreens.find((candidate) => candidate.route === screen.route);
    if (!structured) return basic;
    const screenActions = compiledActions.filter((action) => action.screenId === structured.id);
    return richContract ? enrichScreen(structured, basic, data, journey, contextContract, contract, screenActions) : { ...basic, ux: structured };
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
    ...(fs.existsSync(path.join(root, '.tmp', 'context-enrichment-contract.json'))
      ? { contextContract: '.tmp/context-enrichment-contract.json' }
      : {}),
    ...(fs.existsSync(path.join(root, '.tmp', 'navigation-contract.json'))
      ? { navigationContract: '.tmp/navigation-contract.json' }
      : {}),
    ...(actionContract ? { actionContract: '.tmp/screen-action-contract.json' } : {}),
    ...(serviceSurface ? { serviceSurface: '.tmp/generated-service-surface.json' } : {}),
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
      ...(sourcePaths.contextContract
        ? { contextContract: sha256(fs.readFileSync(path.join(root, sourcePaths.contextContract), 'utf8')) }
        : {}),
      ...(sourcePaths.navigationContract
        ? { navigationContract: sha256(fs.readFileSync(path.join(root, sourcePaths.navigationContract), 'utf8')) }
        : {}),
      ...(sourcePaths.actionContract
        ? { actionContract: sha256(fs.readFileSync(path.join(root, sourcePaths.actionContract), 'utf8')) }
        : {}),
      ...(sourcePaths.serviceSurface
        ? { serviceSurface: sha256(fs.readFileSync(path.join(root, sourcePaths.serviceSurface), 'utf8')) }
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
      ? { ...navigation, criticalFlow }
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
        criticalFlowScreenIds: [...criticalFlow.screenIds],
      },
      capabilityBindings: screens.flatMap((screen) => (screen.capabilityComposition || []).map((capability) => ({ screenId: screen.id, ...capability }))),
      actionBindings: compiledActions,
      builderWaves: builderWaves(screens, criticalFlow, foundation),
    } : {}),
    buildOrder: [
      ...foundation.primitives.map((primitive) => ({ kind: 'foundation', id: primitive.component, file: primitive.file, dependsOn: [] })),
      { kind: 'screen', id: primaryScreen.id, route: primaryScreen.route, dependsOn: foundation.primitives.map((primitive) => primitive.component) },
      { kind: 'screen', id: keyFlowScreen.id, route: keyFlowScreen.route, dependsOn: [primaryScreen.id, ...foundation.primitives.map((primitive) => primitive.component)] },
      ...screens.filter((screen) => !['primary', 'key-flow'].includes(screen.role)).map((screen) => ({ kind: 'screen', id: screen.id, route: screen.route, dependsOn: [primaryScreen.id] })),
    ],
    invalidation: {
      screenDependencies: Object.fromEntries(screens.map((screen) => [screen.id, screen.role === 'supporting'
        ? ['screenContract', 'designRecipe', 'dataIntent', ...(sourcePaths.workflowJourney ? ['workflowJourney'] : []), ...(sourcePaths.contextContract ? ['contextContract'] : []), ...(sourcePaths.navigationContract ? ['navigationContract'] : []), ...(sourcePaths.actionContract ? ['actionContract'] : []), ...(sourcePaths.serviceSurface ? ['serviceSurface'] : [])]
        : ['experienceContract', 'screenContract', 'foundationContract', 'designRecipe', 'dataIntent', ...(sourcePaths.workflowJourney ? ['workflowJourney'] : []), ...(sourcePaths.contextContract ? ['contextContract'] : []), ...(sourcePaths.navigationContract ? ['navigationContract'] : []), ...(sourcePaths.actionContract ? ['actionContract'] : []), ...(sourcePaths.serviceSurface ? ['serviceSurface'] : [])]])),
      fixtureDependencies: Object.fromEntries(data.entities.map((entity) => [entity, ['experienceContract', 'dataIntent']])),
      validatorDependencies: {
        experience: ['experienceContract', 'screenContract', 'foundationContract'],
        nativeVisual: ['experienceContract', 'screenContract', 'foundationContract', 'designRecipe', ...(sourcePaths.workflowJourney ? ['workflowJourney'] : []), ...(sourcePaths.navigationContract ? ['navigationContract'] : []), ...(sourcePaths.actionContract ? ['actionContract'] : [])],
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
  COMPOSITION_PROFILES,
  actionBadgeValueName,
  actionAvailabilityName,
  actionCommandName,
  actionHandlerName,
  compileActionBindings,
  compileScreenBuildPack,
  deriveCompositionGuidance,
  parseScreenMap,
  revisionForPack,
  sha256,
  stableStringify,
  uiContractFingerprint,
  uiContractProjection,
};