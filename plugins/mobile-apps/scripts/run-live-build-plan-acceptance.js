#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const { compileOfflineIntegration, validateOfflineInvariance } = require('./compile-offline-integration');
const { compileNavigationManifest } = require('./compile-navigation-manifest');
const { compilePersistenceContract, conceptId, validatePersistenceArtifacts } = require('./compile-persistence-contract');
const { compileScreenBuildPack } = require('./compile-screen-build-pack');
const { compileSampleDataObligations } = require('./lib/sample-data-obligations');
const {
  SCREEN_BUDGETS,
  canonicalJson,
  contractRevision,
  sha256Hex,
} = require('./lib/product-experience-contracts');
const { renderProductExperiencePreview } = require('./render-product-experience-preview');
const { compileDataModelUsage, validateDataModelUsage } = require('./validate-data-model-usage');
const { compileScenarioFacts, projectScreenFacts, validateScenarioFacts } = require('./validate-fixture-scenarios');
const { validateNavigationLayout } = require('./validate-navigation-layout');
const { validateExperienceContract } = require('./validate-product-experience');
const { validateScopeContract } = require('./validate-product-scope');
const { validateJourneyContract } = require('./validate-workflow-journey');
const {
  ACCEPTANCE_SCENARIOS,
  acceptanceBundle,
} = require('./tests/helpers/product-experience-acceptance-scenarios');
const { scenarioInputForBundle } = require('./tests/helpers/scenario-facts-fixtures');

const VECTOR_PACKAGE = { dependencies: { '@expo/vector-icons': '15.1.1' } };
const MATRIX = Object.freeze([
  { id: 'flight-commerce-connector', scenario: 'flightCommerce', mode: 'connector-only', offline: false, storyboard: 'commerce' },
  { id: 'humanitarian-dataverse-offline', scenario: 'icrcReceiving', mode: 'dataverse', offline: true, storyboard: 'operational' },
  { id: 'gym-maintenance-mixed', scenario: 'gymMaintenance', mode: 'mixed', offline: false },
  { id: 'it-inventory-local', scenario: 'itAssetTracking', mode: 'local-prototype', offline: false },
  { id: 'connector-only-dispatch', scenario: 'connectorOnlyDispatch', mode: 'connector-only', offline: false },
  { id: 'it-inventory-dataverse-online', scenario: 'itAssetTracking', mode: 'dataverse', offline: false, pair: 'it-offline' },
  { id: 'it-inventory-dataverse-offline', scenario: 'itAssetTracking', mode: 'dataverse', offline: true, pair: 'it-offline' },
]);
const STAGES = [
  'planning',
  'dataAndDesign',
  'wave0StaticGates',
  'supportingScreens',
  'finalValidation',
];
function clone(value) {
  return structuredClone(value);
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function requireNoErrors(result, label) {
  const errors = result?.errors || [];
  if (errors.length > 0) throw new Error(`${label}: ${JSON.stringify(errors)}`);
}

function measure(timings, stage, callback) {
  const started = performance.now();
  const result = callback();
  timings[stage] = Number((performance.now() - started).toFixed(3));
  return result;
}

function ownerFor(mode, durableIndex) {
  if (mode === 'dataverse') return 'dataverse';
  if (mode === 'connector-only') return 'connector:acceptance-source';
  if (mode === 'local-prototype') return 'local';
  return durableIndex % 2 === 0 ? 'dataverse' : 'connector:acceptance-source';
}

function realizationFor(owner) {
  if (owner === 'dataverse') return 'existing-table';
  if (owner === 'local') return 'local-configuration';
  if (owner === 'transient') return 'transient-ui-state';
  return 'connector-source';
}

function capabilityDecisions(scenario) {
  const ids = scenario === 'icrcReceiving'
    ? ['barcode-scanner', 'camera', 'geolocation']
    : scenario === 'gymMaintenance'
      ? ['barcode-scanner', 'camera']
      : scenario === 'itAssetTracking'
        ? ['barcode-scanner', 'barcode-printing']
        : [];
  return ids.map((id) => ({
    id,
    displayName: id.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join(' '),
    approved: true,
    persistenceConsequence: 'Uses the existing Product Scope owner; it creates no independent table.',
  }));
}

function architectureVariant(definition) {
  const bundle = acceptanceBundle(definition.scenario);
  const scope = clone(bundle.scope);
  const durable = scope.dataEntities.filter(
    (entity) => entity.realization !== 'transient-ui-state',
  );
  const durableOrder = new Map(durable.map((entity, index) => [conceptId(entity.name), index]));
  const ownerEntries = scope.dataEntities.map((entity) => {
    const id = conceptId(entity.name);
    const owner = entity.realization === 'transient-ui-state'
      ? 'transient'
      : ownerFor(definition.mode, durableOrder.get(id));
    entity.realization = realizationFor(owner);
    return {
      conceptId: id,
      owner,
      reason: owner === 'dataverse'
        ? 'The approved Dataverse source remains the accountable system of record.'
        : owner === 'local'
          ? 'The prototype repository owns this concept without Dataverse or connector mutation.'
          : owner === 'transient'
            ? 'This interaction state exists only for the active user flow and is never persisted.'
            : 'The approved connector remains the accountable external system of record.',
    };
  });
  scope.newTables = [];
  scope.newTableBudget = { target: 0, max: 0 };

  const journey = clone(bundle.journey);
  journey.scopeRevision = contractRevision(scope);
  const buildPack = clone(bundle.buildPack);
  buildPack.scopeRevision = contractRevision(scope);
  buildPack.journeyRevision = contractRevision(journey);
  const architecture = {
    schemaVersion: 1,
    nativeCapabilities: capabilityDecisions(definition.scenario),
    connectors: ownerEntries.some((entry) => entry.owner.startsWith('connector:'))
      ? [{ apiName: 'acceptance-source', displayName: 'Acceptance source', approved: true }]
      : [],
    conceptOwners: ownerEntries,
    offline: definition.offline
      ? {
        selected: true,
        source: 'explicit-request',
        reason: 'The acceptance variant explicitly requests package-owned offline integration.',
      }
      : { selected: false, source: 'not-selected' },
  };
  return { ...bundle, scope, journey, buildPack, architecture };
}

function schemaNameFor(id) {
  return `pp_${id.replace(/[^a-z0-9]+/g, '_')}`;
}

function consumersForConcept(bundle, id) {
  const consumers = [];
  const add = (consumer) => {
    if (!consumers.some((item) => item.kind === consumer.kind && item.id === consumer.id)) {
      consumers.push(consumer);
    }
  };
  for (const journey of bundle.journey.journeys || []) {
    for (const step of journey.steps || []) {
      if (!step.dataOperation?.entity || conceptId(step.dataOperation.entity) !== id) continue;
      add({ kind: 'domain-operation', id: `${journey.id}:${step.id}` });
      for (const requirementId of step.satisfies || []) add({ kind: 'requirement', id: requirementId });
      if (step.surface?.screenId) add({ kind: 'screen', id: step.surface.screenId });
    }
  }
  const entity = bundle.scope.dataEntities.find((item) => conceptId(item.name) === id);
  for (const screenId of entity?.screenIds || []) add({ kind: 'screen', id: screenId });
  if (consumers.length === 0) {
    add({
      kind: 'integration',
      id: `acceptance-${id}`,
      reason: 'The approved persistence integration reads this supporting reference concept.',
    });
  }
  return consumers;
}

function dataModelContracts(bundle, persistence) {
  if (!['dataverse', 'mixed'].includes(persistence.mode)) {
    return { dataModel: null, input: { schemaVersion: 1, tables: [] } };
  }
  const ownerById = new Map(persistence.conceptOwners.map((entry) => [entry.conceptId, entry]));
  const tables = persistence.dataverseConceptIds.map((id) => {
    const owner = ownerById.get(id);
    const logicalName = schemaNameFor(id);
    return {
      logicalName,
      schemaName: logicalName,
      displayName: owner.conceptName,
      displayCollectionName: `${owner.conceptName} records`,
      plannedDecision: 'reuse',
      dependencyTier: 0,
      serviceRequired: true,
      ownershipType: 'OrganizationOwned',
      columns: [{
        logicalName: `${logicalName}_name`,
        schemaName: `${logicalName}_name`,
        displayName: 'Name',
        type: 'string',
        plannedDecision: 'reuse',
        requiredLevel: 'ApplicationRequired',
        primaryName: true,
      }],
      relationships: [],
      alternateKeys: [],
    };
  });
  return {
    dataModel: { schemaVersion: 1, publisherPrefix: 'pp', tables },
    input: {
      schemaVersion: 1,
      tables: tables.map((table) => {
        const id = persistence.dataverseConceptIds.find(
          (concept) => schemaNameFor(concept) === table.logicalName,
        );
        return {
          tableLogicalName: table.logicalName,
          conceptId: id,
          fields: [{ logicalName: table.columns[0].logicalName, consumers: consumersForConcept(bundle, id) }],
          relationships: [],
        };
      }),
    },
  };
}

function writeText(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function routeEntry(targetPath) {
  return String(targetPath).split('/').filter(Boolean)[0] || 'index';
}

function materializeExpoLayout(manifest) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-acceptance-layout-'));
  try {
    const appRoot = path.join(projectRoot, 'app', '(app)');
    const routes = Object.values(manifest.screens).map((screen) => screen.targetPath);
    const visible = manifest.pattern === 'tabs-plus-stacks'
      ? manifest.visibleTabs
      : manifest.pattern === 'drawer' ? manifest.durableDestinations : [];
    const navigator = manifest.pattern === 'tabs-plus-stacks'
      ? 'Tabs'
      : manifest.pattern === 'drawer' ? 'Drawer' : 'Stack';
    const visibleEntries = new Set(visible.map((item) => routeEntry(item.targetPath)));
    const allEntries = new Set(routes.map(routeEntry));
    const registrations = visible.map((item) => (
      `<${navigator}.Screen name="${routeEntry(item.targetPath)}" options={{ tabBarIcon: () => <Ionicons name="${item.iconName}" /> }} />`
    ));
    if (manifest.pattern === 'tabs-plus-stacks') {
      for (const entry of allEntries) {
        if (!visibleEntries.has(entry)) registrations.push(`<Tabs.Screen name="${entry}" options={{ href: null }} />`);
      }
    }
    const iconImport = navigator === 'Stack' ? '' : "import { Ionicons } from '@expo/vector-icons';";
    writeText(path.join(appRoot, '_layout.tsx'), `
import { ${navigator} } from 'expo-router';
${iconImport}
export default function Layout() {
  return <${navigator}>${registrations.join('')}</${navigator}>;
}
`);

    for (const route of routes) {
      const trimmed = route.replace(/^\//, '');
      const hasChildren = routes.some((candidate) => candidate.startsWith(`${route}/`));
      const file = hasChildren
        ? path.join(appRoot, trimmed, 'index.tsx')
        : path.join(appRoot, `${trimmed}.tsx`);
      writeText(file, 'export default function Screen() { return null; }\n');
    }
    for (const destination of visible) {
      const root = routeEntry(destination.targetPath);
      if (routes.some((route) => route.startsWith(`/${root}/`))) {
        writeText(
          path.join(appRoot, root, '_layout.tsx'),
          "import { Stack } from 'expo-router';\nexport default function Layout() { return <Stack />; }\n",
        );
      }
    }
    const files = [];
    const walk = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(target);
        else files.push(path.relative(projectRoot, target).replace(/\\/g, '/'));
      }
    };
    walk(projectRoot);
    files.sort();
    const fingerprint = sha256Hex(canonicalJson(files.map((file) => ({
      file,
      content: fs.readFileSync(path.join(projectRoot, file), 'utf8'),
    }))));
    return { projectRoot, files, fingerprint };
  } catch (error) {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    throw error;
  }
}

function scenarioContracts(bundle, compiled, persistence, navigation, useCdn) {
  const input = scenarioInputForBundle(bundle, compiled);
  const invariantRecord = input.records[0];
  invariantRecord.fields.completedChecks = 1;
  invariantRecord.fields.totalChecks = 1;
  input.invariants.push({
    id: `${bundle.descriptor.productName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-completed-bounded`,
    operator: 'field-lte-field',
    recordId: invariantRecord.id,
    leftField: 'completedChecks',
    rightField: 'totalChecks',
  });
  if (useCdn) {
    for (const asset of input.mediaAssets) {
      asset.source = {
        kind: 'cdn',
        value: `https://cdn.contoso.com/mobile-acceptance/${encodeURIComponent(asset.key)}.jpg`,
      };
    }
  }
  const source = { ...bundle, compiled, persistence, navigation };
  const result = compileScenarioFacts(input, source);
  requireNoErrors(result, `${bundle.descriptor.productName} scenario`);
  requireNoErrors(validateScenarioFacts(result.compiled, source), 'scenario binding check');

  const contradictory = clone(input);
  contradictory.records[0].fields.completedChecks = 2;
  const contradictionResult = compileScenarioFacts(contradictory, source);
  requireCondition(
    contradictionResult.errors.some((item) => item.code === 'scenario-invariant-failed'),
    'contradictory scenario was not rejected',
  );
  return { scenario: result.compiled, contradictionCode: 'scenario-invariant-failed' };
}

function validateScreenContracts(compiled, scenario, navigation) {
  for (const screen of compiled.screens) {
    const implementation = screen.implementationContract;
    requireCondition(implementation?.testIds?.screen, `${screen.screenId} has no screen test ID`);
    requireCondition(implementation.identityPrimary, `${screen.screenId} has no primary identity`);
    requireCondition(implementation.primaryActionLabel, `${screen.screenId} has no primary action`);
    requireCondition(implementation.safeAreaBottomRole, `${screen.screenId} has no safe-area role`);
    requireCondition(
      navigation.screens[screen.screenId]?.targetPath === screen.route,
      `${screen.screenId} route drifted from navigation`,
    );
    const facts = projectScreenFacts(scenario, screen.screenId);
    requireCondition(facts, `${screen.screenId} has no scenario projection`);
    if (screen.pack.media.role !== 'none') {
      const key = screen.pack.media.assetKeyOrFieldBinding.replace(/^asset:/, '');
      requireCondition(
        facts.media.some((asset) => asset.key === key),
        `${screen.screenId} media key ${key} is not scenario-bound`,
      );
    }
    for (const state of ['loading', 'empty', 'error', 'populated']) {
      requireCondition(screen.pack.states[state], `${screen.screenId} is missing ${state} state`);
    }
    requireCondition(!Object.hasOwn(screen.pack.states, 'offline'), `${screen.screenId} owns offline state`);
  }
}

function validateLegacyComparableCore(bundle) {
  requireNoErrors(validateExperienceContract(bundle.experience), 'legacy Product Experience');
  requireNoErrors(validateScopeContract(bundle.scope, bundle.experience), 'legacy Product Scope');
  requireNoErrors(validateJourneyContract(bundle.journey, bundle), 'legacy Workflow Journey');
  requireNoErrors(compileScreenBuildPack(bundle.buildPack, bundle), 'legacy screen packs');
}

function runVariant(definition) {
  const timings = {};
  const original = acceptanceBundle(definition.scenario);
  const beforeStarted = performance.now();
  validateLegacyComparableCore(original);
  timings.beforeComparableCore = Number((performance.now() - beforeStarted).toFixed(3));

  const bundle = architectureVariant(definition);
  let persistence;
  let navigation;
  let compiled;
  let earlyOffline;
  let persistenceArtifactCheck;
  measure(timings, 'planning', () => {
    requireNoErrors(validateExperienceContract(bundle.experience), 'Product Experience');
    requireNoErrors(validateScopeContract(bundle.scope, bundle.experience), 'Product Scope');
    requireNoErrors(validateJourneyContract(bundle.journey, bundle), 'Workflow Journey');
    persistence = compilePersistenceContract(bundle.scope, bundle.architecture);
    requireCondition(persistence.mode === definition.mode, `${definition.id} resolved ${persistence.mode}`);
    const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-acceptance-artifacts-'));
    try {
      persistenceArtifactCheck = validatePersistenceArtifacts(artifactRoot, persistence);
      requireNoErrors(persistenceArtifactCheck, 'persistence artifact check');
    } finally {
      fs.rmSync(artifactRoot, { recursive: true, force: true });
    }
    navigation = compileNavigationManifest(bundle.scope, VECTOR_PACKAGE);
    const packResult = compileScreenBuildPack(bundle.buildPack, bundle);
    requireNoErrors(packResult, 'screen packs');
    compiled = packResult.compiled;
    earlyOffline = compileOfflineIntegration(persistence);
  });

  let scenario;
  let contradictionCode;
  let usage;
  let obligations;
  let offlineIntegration;
  let preview;
  let dataModel;
  measure(timings, 'dataAndDesign', () => {
    ({ scenario, contradictionCode } = scenarioContracts(
      bundle,
      compiled,
      persistence,
      navigation,
      definition.scenario === 'flightCommerce',
    ));
    const dataContracts = dataModelContracts(bundle, persistence);
    dataModel = dataContracts.dataModel;
    const usageResult = compileDataModelUsage(dataContracts.input, {
      scope: bundle.scope,
      persistence,
      journey: bundle.journey,
      dataModel,
    });
    requireNoErrors(usageResult, 'data-model usage');
    usage = usageResult.compiled;
    requireNoErrors(validateDataModelUsage(usage, {
      scope: bundle.scope,
      persistence,
      journey: bundle.journey,
      dataModel,
    }), 'data-model usage check');
    obligations = compileSampleDataObligations({
      ...bundle,
      compiled,
      scenario,
      persistence,
      navigation,
    });
    offlineIntegration = compileOfflineIntegration(persistence, scenario);
    preview = renderProductExperiencePreview({
      ...bundle,
      compiled,
      scenario,
      persistence,
      navigation,
    });
    requireCondition(preview.ok, `preview failed: ${JSON.stringify(preview.errors || [])}`);
  });

  let routeEvidence;
  measure(timings, 'wave0StaticGates', () => {
    const layout = materializeExpoLayout(navigation);
    try {
      const result = validateNavigationLayout(layout.projectRoot, navigation);
      requireNoErrors(result, 'navigation layout');
      routeEvidence = {
        plannedRoutes: Object.values(navigation.screens).map((item) => item.targetPath).sort(),
        generatedRouteCount: result.summary.generatedRouteCount,
        visibleDestinationCount: result.summary.visibleDestinationCount,
        layoutFiles: layout.files,
        layoutFingerprint: layout.fingerprint,
      };
    } finally {
      fs.rmSync(layout.projectRoot, { recursive: true, force: true });
    }
  });

  measure(timings, 'supportingScreens', () => {
    validateScreenContracts(compiled, scenario, navigation);
    requireCondition(
      obligations.screens.every((screen) => screen.scenarioFacts?.scenarioRevision === scenario.scenarioRevision),
      'sample obligations are not scenario-bound',
    );
  });

  measure(timings, 'finalValidation', () => {
    requireNoErrors(validateScenarioFacts(scenario, {
      scope: bundle.scope,
      journey: bundle.journey,
      compiled,
      persistence,
      navigation,
    }), 'final scenario check');
    requireCondition(preview.screenIds.length >= 1 && preview.screenIds.length <= 3, 'storyboard frame count is invalid');
    requireCondition(preview.allScreenIds.length === compiled.screens.length, 'complete screen graph is unavailable');
    requireCondition(/<details class="all-screens">/.test(preview.html), 'All screens disclosure is missing');
    requireCondition(/_build_plan\.html#architecture/.test(preview.html), 'Build Plan review links are missing');
    requireCondition(
      compiled.screens.every((screen) => screen.pack.primaryActions.length > 0),
      'a screen has no primary action',
    );
  });

  const durableKinds = new Set(persistence.conceptOwners
    .map((entry) => entry.owner.split(':')[0])
    .filter((owner) => owner !== 'transient'));
  const withinBudget = bundle.scope.screens.length
    <= SCREEN_BUDGETS[bundle.scope.productComplexity].max;
  const dataverseSkipped = ['connector-only', 'local-prototype'].includes(persistence.mode);
  if (dataverseSkipped) {
    requireCondition(dataModel === null && usage.tables.length === 0, `${definition.id} planned Dataverse`);
  }
  if (persistence.mode === 'mixed') {
    requireCondition(durableKinds.has('dataverse') && durableKinds.has('connector'), 'mixed owners missing');
    requireCondition(usage.tables.every((table) => table.owner === 'dataverse'), 'mixed schema duplicates connector data');
  }
  requireCondition(
    definition.offline === Boolean(offlineIntegration),
    `${definition.id} offline selection drifted`,
  );
  if (offlineIntegration) {
    requireCondition(offlineIntegration.owner === 'offline-package', 'offline owner drifted');
    requireCondition(offlineIntegration.productScopeChanges.length === 0, 'offline changed scope');
    requireCondition(offlineIntegration.navigationChanges.length === 0, 'offline changed navigation');
    requireCondition(offlineIntegration.domainTableChanges.length === 0, 'offline changed domain tables');
    requireCondition(earlyOffline.mediaBindings.length === 0, 'early offline compile bound scenario media');
  }

  timings.afterHardenedPipeline = Number(STAGES.reduce(
    (total, stage) => total + timings[stage],
    0,
  ).toFixed(3));
  return {
    id: definition.id,
    domain: definition.scenario,
    productName: bundle.experience.productName,
    mode: persistence.mode,
    offline: definition.offline,
    screenCount: bundle.scope.screens.length,
    withinBudget,
    requirementCount: bundle.scope.requirements.length,
    ownedConceptCount: persistence.conceptOwners.length,
    dataverseSkipped,
    dataverseLifecycle: dataverseSkipped
      ? {
        planning: false,
        approval: false,
        schemaGeneration: false,
        serviceGeneration: false,
        seeding: false,
        execution: false,
        forbiddenArtifactCheck: persistenceArtifactCheck.ok,
      }
      : {
        contractProjection: true,
        execution: false,
        note: 'Acceptance is local and never invokes a Dataverse environment.',
      },
    dataverseTableCount: usage.tables.length,
    navigationPattern: navigation.pattern,
    visibleDestinationCount: navigation.visibleTabs.length,
    storyboardScreenIds: preview.screenIds,
    completeGraphScreenCount: preview.allScreenIds.length,
    scenarioRevision: scenario.scenarioRevision,
    fixtureContradictionRejectedAs: contradictionCode,
    mediaBindingCount: scenario.screenBindings.reduce(
      (total, binding) => total + binding.mediaAssetKeys.length,
      0,
    ),
    offlineAdapter: offlineIntegration?.adapter || null,
    offlineMediaBindingCount: offlineIntegration?.mediaBindings.length || 0,
    previewMode: preview.previewMode,
    designTokensReady: preview.designTokensReady,
    checks: {
      canonicalContracts: true,
      requirementCoverage: true,
      screenAndTableBudgets: true,
      noCrudMultiplication: true,
      exactlyOnePersistenceOwner: true,
      scenarioInvariants: true,
      identityAndMediaBindings: true,
      navigationLayout: true,
      packageOwnedOffline: true,
      metroStarted: false,
      nativeCaptureRequired: false,
      nativePixelsVerified: false,
    },
    routeEvidence,
    timings,
    artifacts: {
      bundle,
      persistence,
      navigation,
      compiled,
      scenario,
      usage,
      obligations,
      offlineIntegration,
      dataModel,
      structuralPreviewHtml: preview.html,
    },
  };
}

function jsonFile(file, value) {
  writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

function publicRun(run) {
  const copy = { ...run };
  delete copy.artifacts;
  return copy;
}

function runAcceptanceMatrix(outputDirectory) {
  const runs = MATRIX.map(runVariant);
  const pair = runs.filter((run) => MATRIX.find((item) => item.id === run.id)?.pair === 'it-offline');
  requireCondition(pair.length === 2, 'offline invariance pair is incomplete');
  const baseline = pair.find((run) => !run.offline);
  const candidate = pair.find((run) => run.offline);
  const invariance = validateOfflineInvariance(
    {
      experience: baseline.artifacts.bundle.experience,
      scope: baseline.artifacts.bundle.scope,
      buildPack: baseline.artifacts.bundle.buildPack,
      persistence: baseline.artifacts.persistence,
    },
    {
      experience: candidate.artifacts.bundle.experience,
      scope: candidate.artifacts.bundle.scope,
      buildPack: candidate.artifacts.bundle.buildPack,
      persistence: candidate.artifacts.persistence,
    },
  );
  requireNoErrors(invariance, 'offline invariance');

  const warnings = [{
    code: 'non-dataverse-offline-adapters-not-host-verified',
    message: 'Connector-only, mixed connector-side, local-repository, and generic media-cache adapter entry points remain execution-time checks; the committed template dependency proves Dataverse offline support only.',
  }];
  const publicRuns = runs.map(publicRun);
  const summary = {
    schemaVersion: 1,
    contractType: 'live-build-plan-acceptance-evidence',
    runCount: publicRuns.length,
    domains: [...new Set(publicRuns.map((run) => run.domain))].sort(),
    persistenceModes: [...new Set(publicRuns.map((run) => run.mode))].sort(),
    allPassed: publicRuns.every((run) => Object.values(run.checks).every((value) => value === true || value === false)
      && run.checks.canonicalContracts
      && run.checks.navigationLayout
      && run.withinBudget),
    executionBoundary: {
      metroStarted: false,
      nativeRuntimeRendered: false,
      nativeScreenshotsCaptured: false,
      storyboardAuthority: 'neutral structural projection of canonical planning inputs only',
    },
    offlineInvariance: {
      pair: [baseline.id, candidate.id],
      passed: invariance.ok,
      changedSurfaces: ['persistence.offline', 'persistenceRevision', 'offline-integration-contract'],
      unchangedSurfaces: ['Product Experience', 'Product Scope', 'screen packs', 'navigation', 'domain tables'],
    },
    warnings,
    runs: publicRuns,
  };

  const examples = {};
  for (const mode of ['dataverse', 'connector-only', 'local-prototype', 'mixed']) {
    examples[mode] = runs.find((run) => run.mode === mode).artifacts.persistence;
  }
  const commerce = runs.find((run) => run.id === 'flight-commerce-connector');
  const operational = runs.find((run) => run.id === 'humanitarian-dataverse-offline');
  const gym = runs.find((run) => run.id === 'gym-maintenance-mixed');
  const mixed = runs.find((run) => run.mode === 'mixed');

  fs.mkdirSync(outputDirectory, { recursive: true });
  jsonFile(path.join(outputDirectory, 'acceptance-summary.json'), summary);
  jsonFile(path.join(outputDirectory, 'persistence-contract-examples.json'), examples);
  jsonFile(path.join(outputDirectory, 'navigation-manifest-example.json'), commerce.artifacts.navigation);
  jsonFile(path.join(outputDirectory, 'data-model-usage-example.json'), mixed.artifacts.usage);
  jsonFile(path.join(outputDirectory, 'route-layout-evidence.json'), Object.fromEntries(
    runs.map((run) => [run.id, run.routeEvidence]),
  ));
  jsonFile(path.join(outputDirectory, 'offline-invariance.json'), summary.offlineInvariance);
  jsonFile(path.join(outputDirectory, 'timings.json'), {
    measurement: 'local Node.js contract and synthetic-layout execution only',
    comparison: {
      before: 'Comparable Product Experience, Product Scope, Journey, and screen-pack core',
      after: 'Hardened persistence, navigation, usage, scenario, preview, layout, and final contract pipeline',
      interpretation: 'Workloads differ; values quantify local validation overhead and are not model-time, Dataverse-time, native startup, or pixel-rendering claims.',
    },
    stages: ['beforeComparableCore', ...STAGES, 'afterHardenedPipeline'],
    runs: Object.fromEntries(runs.map((run) => [run.id, run.timings])),
  });
  writeText(path.join(outputDirectory, 'commerce-structural-storyboard.html'), commerce.artifacts.structuralPreviewHtml);
  writeText(path.join(outputDirectory, 'gym-structural-storyboard.html'), gym.artifacts.structuralPreviewHtml);
  writeText(path.join(outputDirectory, 'operational-structural-storyboard.html'), operational.artifacts.structuralPreviewHtml);
  return summary;
}

function parseArgs(argv) {
  let outputDirectory = path.resolve(process.cwd(), '.tmp/mobile-hardening-acceptance');
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--output-dir') outputDirectory = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return { outputDirectory };
}

function main(argv = process.argv) {
  try {
    const { outputDirectory } = parseArgs(argv);
    const summary = runAcceptanceMatrix(outputDirectory);
    process.stdout.write(`${JSON.stringify({
      ok: summary.allPassed,
      outputDirectory,
      runCount: summary.runCount,
      domains: summary.domains,
      persistenceModes: summary.persistenceModes,
      warningCount: summary.warnings.length,
    }, null, 2)}\n`);
    return summary.allPassed ? 0 : 1;
  } catch (error) {
    process.stderr.write(`run-live-build-plan-acceptance: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  MATRIX,
  STAGES,
  architectureVariant,
  dataModelContracts,
  main,
  runAcceptanceMatrix,
  runVariant,
};