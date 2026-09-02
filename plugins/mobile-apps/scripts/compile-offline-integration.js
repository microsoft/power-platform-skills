#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { canonicalJson, sha256Hex } = require('./lib/product-experience-contracts');

const DEFAULT_PERSISTENCE = '.tmp/persistence-contract.json';
const DEFAULT_OUTPUT = '.tmp/offline-integration-contract.json';
const RUNTIME_STATES = [
  'connection-status',
  'queued',
  'syncing',
  'failed',
  'retry',
  'conflict',
];
const ADAPTERS = {
  dataverse: 'dataverse-mobile-offline-profile',
  mixed: 'mixed-owner-offline-adapters',
  'connector-only': 'connector-offline-adapter',
  'local-prototype': 'local-repository',
};

function compileMediaBindings(persistence, scenario) {
  if (!scenario) return [];
  if (scenario.contractType !== 'scenario-facts') {
    throw new Error('Offline media bindings require a scenario-facts contract');
  }
  if (scenario.persistenceRevision !== persistence.persistenceRevision) {
    throw new Error('Scenario facts are stale for the current persistence contract');
  }
  const scenarioContent = structuredClone(scenario);
  const scenarioRevision = scenarioContent.scenarioRevision;
  delete scenarioContent.scenarioRevision;
  if (scenarioRevision !== sha256Hex(canonicalJson(scenarioContent))) {
    throw new Error('Scenario facts scenarioRevision does not match content');
  }
  const assets = new Map((scenario.mediaAssets || []).map((asset) => [asset.key, asset]));
  const bindings = [];
  for (const screen of scenario.screenBindings || []) {
    for (const assetKey of screen.mediaAssetKeys || []) {
      const asset = assets.get(assetKey);
      if (!asset) throw new Error(`Scenario screen ${screen.screenId} references missing media ${assetKey}`);
      bindings.push({
        screenId: screen.screenId,
        assetKey,
        source: structuredClone(asset.source),
        fallback: asset.fallback,
        aspectRatio: asset.aspectRatio,
        fit: asset.fit,
        focalPoint: asset.focalPoint,
      });
    }
  }
  return bindings.sort((left, right) => (
    left.screenId.localeCompare(right.screenId) || left.assetKey.localeCompare(right.assetKey)
  ));
}

function compileOfflineIntegration(persistence, scenario = null) {
  if (!persistence || typeof persistence !== 'object' || Array.isArray(persistence)) {
    throw new Error('Persistence contract must be an object');
  }
  const offline = persistence.offline || { selected: false, source: 'not-selected' };
  if (!offline.selected) return null;
  if (!['explicit-request', 'foreground-confirmation'].includes(offline.source)) {
    throw new Error('Offline integration requires explicit request or foreground confirmation');
  }
  const adapter = ADAPTERS[persistence.mode];
  if (!adapter) throw new Error(`Unsupported persistence mode ${persistence.mode || '(missing)'}`);
  const mediaBindings = compileMediaBindings(persistence, scenario);
  const contract = {
    schemaVersion: 1,
    contractType: 'offline-integration-contract',
    persistenceRevision: persistence.persistenceRevision,
    owner: 'offline-package',
    adapter,
    integrationSlots: [
      'app-shell-connection-status',
      'repository-write-boundary',
      'package-sync-recovery',
    ],
    runtimeStates: RUNTIME_STATES,
    mediaCacheOwner: 'offline-package',
    mediaBindings,
    scenarioRevision: scenario?.scenarioRevision || null,
    mobileOfflineProfileRequired: ['dataverse', 'mixed'].includes(persistence.mode),
    dataverseConceptIds: persistence.dataverseConceptIds || [],
    connectorConceptIds: persistence.connectorConceptIds || [],
    localConceptIds: persistence.localConceptIds || [],
    productScopeChanges: [],
    navigationChanges: [],
    domainTableChanges: [],
  };
  contract.integrationRevision = sha256Hex(canonicalJson(contract));
  return contract;
}

function comparableExperience(experience) {
  if (!experience) return null;
  return {
    primaryGoal: experience.primaryGoal,
    primaryIntent: experience.primaryIntent,
    workflowShape: experience.workflowShape,
    informationDensity: experience.informationDensity,
    interactionTempo: experience.interactionTempo,
    decisionRisk: experience.decisionRisk,
    contentEmphasis: experience.contentEmphasis,
    collaborationMode: experience.collaborationMode,
    visualPersonality: experience.visualPersonality,
    mediaStrategy: experience.mediaStrategy,
    accessibilityPriorities: experience.accessibilityPriorities,
    firstViewport: experience.firstViewport,
    signatureExperience: experience.signatureExperience,
    forbiddenDefaults: experience.forbiddenDefaults,
  };
}

function comparablePersistence(persistence) {
  if (!persistence) return null;
  const copy = structuredClone(persistence);
  // The revision hashes the offline decision itself, so comparing it after removing
  // `offline` would make every valid on/off pair look like ownership drift. Scenario
  // and integration contracts separately bind the exact current persistence revision.
  delete copy.offline;
  delete copy.persistenceRevision;
  return copy;
}

function validateOfflineInvariance(baseline, candidate) {
  const errors = [];
  const compare = (code, label, left, right) => {
    if (canonicalJson(left) !== canonicalJson(right)) {
      errors.push({ code, message: `Offline selection changed ${label}` });
    }
  };
  compare('offline-product-scope-drift', 'Product Scope', baseline.scope, candidate.scope);
  compare(
    'offline-screen-pack-drift',
    'screen build packs',
    baseline.buildPack?.packs || baseline.buildPack,
    candidate.buildPack?.packs || candidate.buildPack,
  );
  compare(
    'offline-design-intent-drift',
    'Product Experience design intent',
    comparableExperience(baseline.experience),
    comparableExperience(candidate.experience),
  );
  compare(
    'offline-persistence-owner-drift',
    'persistence ownership',
    comparablePersistence(baseline.persistence),
    comparablePersistence(candidate.persistence),
  );
  return { ok: errors.length === 0, errors };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--persistence') args.persistence = argv[++index];
    else if (argv[index] === '--scenario') args.scenario = argv[++index];
    else if (argv[index] === '--output') args.output = argv[++index];
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!args.projectRoot) throw new Error('--project-root is required');
  return args;
}

function main(argv = process.argv) {
  try {
    const args = parseArgs(argv);
    const projectRoot = path.resolve(args.projectRoot);
    const persistence = JSON.parse(fs.readFileSync(
      path.resolve(projectRoot, args.persistence || DEFAULT_PERSISTENCE),
      'utf8',
    ));
    const output = path.resolve(projectRoot, args.output || DEFAULT_OUTPUT);
    const scenario = args.scenario
      ? JSON.parse(fs.readFileSync(path.resolve(projectRoot, args.scenario), 'utf8'))
      : null;
    const contract = compileOfflineIntegration(persistence, scenario);
    if (!contract) {
      fs.rmSync(output, { force: true });
      process.stdout.write(`${JSON.stringify({ ok: true, selected: false, output: null })}\n`);
      return 0;
    }
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const temporary = `${output}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(contract, null, 2)}\n`);
      fs.renameSync(temporary, output);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      selected: true,
      output,
      adapter: contract.adapter,
      mediaBindingCount: contract.mediaBindings.length,
      revision: contract.integrationRevision,
    }, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`compile-offline-integration: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  ADAPTERS,
  RUNTIME_STATES,
  compileMediaBindings,
  compileOfflineIntegration,
  main,
  validateOfflineInvariance,
};
