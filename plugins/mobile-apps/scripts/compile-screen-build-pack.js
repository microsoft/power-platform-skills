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
const { normalizeScreenContract, validateExperienceScreenContract } = require('./lib/experience-screen-contract');
const { validateMobilePlanExecutionContract } = require('./lib/mobile-plan-execution-contract');
const { resolveDesignRecipe } = require('./resolve-design-recipe');

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

function validateInputs(contract, screenContract, foundation, context) {
  const issues = validateExperienceContract(contract);
  if (issues.length) throw new Error(`Experience contract is invalid: ${issues.join('; ')}`);
  if (screenContract?.schemaVersion !== 3 || screenContract.experienceContractSha256 !== contractHash(contract)) {
    throw new Error('Experience screen contract must be a current schema-version-3 contract. Re-plan legacy v1/v2 screens before building.');
  }
  const screenIssues = validateExperienceScreenContract(screenContract, contract, context);
  if (screenIssues.length) throw new Error(`Experience screen contract is invalid: ${screenIssues.join('; ')}`);
  const composition = primaryComposition(contract);
  const primary = screenContract.primaryScreen;
  if (!primary || primary.route !== contract.primaryScreen.route || primary.file !== contract.primaryScreen.file || primary.compositionKind !== composition.compositionKind) {
    throw new Error('Experience screen contract does not match the primary composition.');
  }
  const keyFlow = screenContract.keyFlow;
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

function activeDataTable(table) {
  return table?.logicalName
    && table.serviceRequired !== false
    && String(table.plannedDecision || table.decision || '').toLowerCase() !== 'defer';
}

function normalizedDataEntity(table) {
  const fields = (table.columns || table.fields || [])
    .filter((field) => String(field.plannedDecision || field.decision || '').toLowerCase() !== 'defer')
    .map((field) => ({
      name: String(field.logicalName || field.name || ''),
      type: String(field.type || field.attributeType || '').toLowerCase(),
      lookupTarget: field.lookupTarget || field.target || null,
    }))
    .filter((field) => field.name);
  return {
    logicalName: String(table.logicalName),
    displayName: String(table.displayName || table.logicalName),
    fields,
  };
}

function dataIntent(projectRoot) {
  const schemaPath = path.join(projectRoot, '.tmp', 'dataverse-schema-contract.json');
  const prototypePath = path.join(projectRoot, 'src', 'generated', '.prototype-manifest.json');
  if (fs.existsSync(schemaPath)) {
    const schema = readJson(schemaPath, 'Data intent');
    const tables = Array.isArray(schema?.tables) ? schema.tables : [];
    const entityContracts = tables.filter(activeDataTable).map(normalizedDataEntity);
    return {
      adapter: schema.planningMode === 'prototype' ? 'local' : 'dataverse',
      entities: entityContracts.map((table) => table.displayName),
      entityContracts,
      contract: schema,
      path: '.tmp/dataverse-schema-contract.json',
      hash: sha256(fs.readFileSync(schemaPath, 'utf8')),
    };
  }
  if (fs.existsSync(prototypePath)) {
    const manifest = readJson(prototypePath, 'Prototype data intent');
    const entityContracts = Array.isArray(manifest.tableSchemas)
      ? manifest.tableSchemas.filter(activeDataTable).map(normalizedDataEntity)
      : (manifest.tables || []).map((logicalName) => normalizedDataEntity({ logicalName }));
    return {
      adapter: 'local',
      entities: entityContracts.map((table) => table.displayName),
      entityContracts,
      contract: manifest,
      path: 'src/generated/.prototype-manifest.json',
      hash: sha256(fs.readFileSync(prototypePath, 'utf8')),
    };
  }
  throw new Error('Data intent is missing: expected .tmp/dataverse-schema-contract.json or src/generated/.prototype-manifest.json.');
}

function generatedServiceSurface(projectRoot) {
  const directory = path.join(projectRoot, 'src', 'generated', 'services');
  if (!fs.existsSync(directory)) return {};
  const surface = {};
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts') || ['index.ts', 'dataSourcesInfo.ts'].includes(entry.name)) continue;
    const source = fs.readFileSync(path.join(directory, entry.name), 'utf8');
    const methods = new Set();
    for (const pattern of [/(?:static\s+)?async\s+([A-Za-z_$][\w$]*)\s*\(/g, /^\s*([A-Za-z_$][\w$]*)\s*:\s*async\s*\(/gm]) {
      let match;
      while ((match = pattern.exec(source)) !== null) methods.add(match[1]);
    }
    surface[path.basename(entry.name, '.ts')] = [...methods].sort();
  }
  return surface;
}

function semanticEntityName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function resolveDataEntity(data, value) {
  const key = semanticEntityName(value);
  return (data.entityContracts || []).find((entity) => [entity.logicalName, entity.displayName]
    .some((candidate) => semanticEntityName(candidate) === key));
}

function availabilityField(entity) {
  return entity?.fields.find((field) => /available|availability|inventory|stock/i.test(field.name))?.name || null;
}

function relationshipMediaEntity(entity) {
  const semantic = `${entity?.logicalName || ''} ${entity?.displayName || ''}`;
  return /media|image|photo|asset|artwork/i.test(semantic);
}

function aggregateEntity(entity) {
  return /cart|basket|selection|saved|favorite|notification|message|order.?line|line.?item/i
    .test(`${entity?.logicalName || ''} ${entity?.displayName || ''}`);
}

function screenRuntimeBindings(screen, data, entities) {
  const scoped = entities.map((entity) => resolveDataEntity(data, entity)).filter(Boolean);
  const availabilityEntities = scoped
    .map((entity) => ({ entity: entity.logicalName, field: availabilityField(entity) }))
    .filter((binding) => binding.field);
  const actionText = `${screen.primaryAction?.label || ''} ${screen.purpose || ''}`;
  const scenarios = (screen.data.fixtureScenarios || []).map((scenario) => (
    typeof scenario === 'string' ? scenario : JSON.stringify(scenario)
  )).join(' ');
  const availabilityAction = Boolean(screen.primaryAction && availabilityEntities.length && (
    screen.presentation?.pattern === 'detail'
    || /\b(?:add|select|choose|reserve|book|buy|purchase|order|checkout|confirm|submit|save)\b/i.test(actionText)
    || /\b(?:unavailable|out[ -]of[ -]stock|sold[ -]out|cannot be (?:added|selected|chosen|reserved|booked))\b/i.test(scenarios)
  ));
  const scopedNames = new Set(scoped.map((entity) => entity.logicalName));
  const relationships = scoped.flatMap((source) => source.fields
    .map((field) => ({ field, target: field.lookupTarget ? resolveDataEntity(data, field.lookupTarget) : null }))
    .filter(({ target }) => target && scopedNames.has(target.logicalName))
    .map(({ field, target }) => ({
      sourceEntity: source.logicalName,
      sourceField: field.name,
      targetEntity: target.logicalName,
    })))
    .filter((relationship) => relationshipMediaEntity(resolveDataEntity(data, relationship.sourceEntity)));
  const aggregateEntities = scoped.filter(aggregateEntity).map((entity) => entity.logicalName);
  return {
    canonicalRecord: { mapper: 'toExperienceRecord', stableId: 'id' },
    availability: {
      required: availabilityAction,
      entities: availabilityEntities,
      stateProperty: 'availabilityState',
      predicate: 'isExperienceRecordActionable',
      disabledActionId: availabilityAction ? screen.primaryAction.id : null,
    },
    relatedMedia: {
      required: Boolean(screen.media?.required && relationships.length),
      resolver: 'resolveExperienceMedia',
      join: 'relatedExperienceRecords',
      relationships,
    },
    aggregateFreshness: {
      requiredWhenRendered: aggregateEntities.length > 0,
      entities: aggregateEntities,
      policy: 'focus-revalidate-after-mutation',
      hook: 'useFocusEffect',
    },
  };
}

function screenRecord(screen, data, contract) {
  const entities = screen.data.entities.length ? screen.data.entities : data.entities;
  const foundationFiles = screen.dependencies.foundation.map((component) => `foundation:${component}`);
  const fixtureDependencies = screen.dependencies.fixtures.length
    ? screen.dependencies.fixtures.map((fixture) => `fixture:${fixture}`)
    : entities.map((entity) => `fixture:${entity}`);
  const firstViewportRegionIds = new Set(screen.firstViewport.regionIds);
  const firstViewportRegions = screen.regions.filter((region) => firstViewportRegionIds.has(region.id));
  const mediaSharesViewport = screen.media.required
    && (firstViewportRegions.length > 1 || screen.primaryAction?.placement === 'inline');
  return {
    id: screen.id,
    route: screen.route,
    file: screen.file,
    role: screen.role,
    routeParameters: screen.routeParameters,
    navigation: screen.navigation,
    contractSource: screen.contractSource,
    headerMode: screen.header.mode,
    header: screen.header,
    purpose: screen.purpose,
    presentation: screen.presentation,
    regions: screen.regions,
    firstViewport: {
      ...screen.firstViewport,
      visiblePrimaryAction: Boolean(screen.primaryAction),
      primaryActionPlacement: screen.primaryAction?.placement || 'none',
    },
    primaryAction: screen.primaryAction,
    media: {
      ...screen.media,
      source: contract.mediaIntent?.source || 'bundled',
      delivery: contract.mediaIntent?.delivery || (contract.assetPolicy.media === 'remote-cdn-cached' ? 'device-cached' : 'bundled'),
      sizing: screen.media.required
        ? mediaSharesViewport ? 'responsive-clamped' : 'responsive-aspect'
        : 'not-applicable',
      maxViewportShare: screen.media.required ? mediaSharesViewport ? 0.55 : 0.72 : 0,
    },
    states: screen.states,
    qualityCriteria: screen.qualityCriteria,
    dependencies: {
      foundation: screen.dependencies.foundation,
      fixtures: screen.dependencies.fixtures.length ? screen.dependencies.fixtures : entities,
      screens: screen.dependencies.screens,
      artifacts: [...foundationFiles, ...fixtureDependencies],
    },
    testIds: screen.testIds,
    forbiddenDefaults: screen.forbiddenDefaults,
    data: {
      adapter: data.adapter,
      entities,
      fixtureScenarios: screen.data.fixtureScenarios,
      viewModel: 'src/generated/experience-view-model.ts',
      recordIdentity: 'stable-primary-key',
      mediaPolicy: contract.assetPolicy.media,
      mediaFields: ['imageUrl', 'imageAltText', 'imageCacheKey', 'imageAssetKey'],
      operations: screen.data.operations,
      runtimeBindings: screenRuntimeBindings(screen, data, entities),
    },
  };
}

function revisionForPack(pack) {
  const copy = { ...pack };
  delete copy.revision;
  return sha256(stableStringify(copy));
}

function compactExecutionContract(executionContract) {
  return {
    requirementIds: executionContract.requirements.filter((item) => item.status === 'planned').map((item) => item.id),
    nativeCapabilities: executionContract.nativeCapabilities.map((item) => ({
      id: item.id,
      capability: item.capability,
      execution: item.execution,
    })),
    javascriptDependencies: executionContract.javascriptDependencies,
    connectorOperations: executionContract.connectorOperations,
  };
}

function compileScreenBuildPack(projectRoot) {
  const root = path.resolve(projectRoot);
  const experiencePath = requiredFile(root, '.tmp/experience-contract.json', 'Experience contract');
  const screenPath = requiredFile(root, '.tmp/experience-screen-contract.json', 'Experience screen contract');
  const foundationPath = requiredFile(root, '.tmp/experience-foundation-contract.json', 'Experience foundation contract');
  const executionPath = requiredFile(root, '.tmp/mobile-plan-execution-contract.json', 'Mobile plan execution contract');
  const briefPath = fs.existsSync(path.join(root, '.tmp', 'experience-brief.md'))
    ? path.join(root, '.tmp', 'experience-brief.md')
    : requiredFile(root, 'brief.md', 'Confirmed brief');
  const packagePath = requiredFile(root, 'package.json', 'Package manifest');
  const planPath = path.join(root, 'native-app-plan.md');
  const tokensPath = requiredFile(root, 'brand/tokens.ts', 'Design tokens');
  const contract = readJson(experiencePath, 'Experience contract');
  const screenContract = readJson(screenPath, 'Experience screen contract');
  const foundation = readJson(foundationPath, 'Experience foundation contract');
  const executionContract = readJson(executionPath, 'Mobile plan execution contract');
  const data = dataIntent(root);
  const serviceSurface = generatedServiceSurface(root);
  const context = { dataContract: data.contract, executionContract, serviceSurface };
  validateInputs(contract, screenContract, foundation, context);
  const executionValidation = validateMobilePlanExecutionContract(executionContract, {
    briefText: fs.readFileSync(briefPath, 'utf8'),
    experienceContractSha256: contractHash(contract),
    screenContract,
    dataContract: data.contract,
    packageJson: readJson(packagePath, 'Package manifest'),
  });
  if (!executionValidation.valid) throw new Error(`Mobile plan execution contract is invalid: ${executionValidation.errors.join('; ')}`);
  const packageJson = readJson(packagePath, 'Package manifest');
  const installedDependencies = { ...(packageJson.dependencies || {}), ...(packageJson.devDependencies || {}) };
  for (const dependency of executionContract.javascriptDependencies) {
    if (installedDependencies[dependency.package] !== dependency.version) {
      throw new Error(`Approved dependency ${dependency.package}@${dependency.version} must be installed exactly before build-pack compilation.`);
    }
  }
  const screenMap = screenContract.schemaVersion === 1
    ? parseScreenMap(fs.readFileSync(requiredFile(root, 'native-app-plan.md', 'Native app plan'), 'utf8'))
    : [];
  const primary = screenContract.primaryScreen;
  const keyFlow = screenContract.keyFlow;
  const foundationComponents = foundation.primitives.map((primitive) => primitive.component);
  const normalizedScreens = normalizeScreenContract(screenContract, contract, screenMap, foundationComponents);
  const screens = normalizedScreens.map((screen) => screenRecord(screen, data, contract));
  const primaryScreen = screens.find((screen) => screen.role === 'primary');
  const keyFlowScreen = screens.find((screen) => screen.role === 'key-flow');
  const designRecipePath = path.join(root, 'brand', 'design-recipe.json');
  const hasDesignRecipe = fs.existsSync(designRecipePath);
  const designRecipe = hasDesignRecipe
    ? readJson(designRecipePath, 'Design recipe')
    : resolveDesignRecipe(contract, screenContract);
  const criticalIds = screenContract.schemaVersion >= 2
    ? screenContract.criticalFlow.screenIds
    : [primaryScreen.id, keyFlowScreen.id];
  const verticalSlice = screens.filter((screen) => criticalIds.includes(screen.id));
  const remainingScreens = screens.filter((screen) => !criticalIds.includes(screen.id));
  const sourcePaths = {
    experienceContract: '.tmp/experience-contract.json',
    screenContract: '.tmp/experience-screen-contract.json',
    foundationContract: '.tmp/experience-foundation-contract.json',
    designSystem: 'brand/design-system.md',
    tokens: 'brand/tokens.ts',
    dataIntent: data.path,
    executionContract: '.tmp/mobile-plan-execution-contract.json',
    designRecipe: hasDesignRecipe ? 'brand/design-recipe.json' : null,
  };
  const pack = {
    schemaVersion: 2,
    screenContractVersion: screenContract.schemaVersion,
    sources: {
      experienceContract: sha256(fs.readFileSync(experiencePath, 'utf8')),
      screenContract: sha256(fs.readFileSync(screenPath, 'utf8')),
      foundationContract: sha256(fs.readFileSync(foundationPath, 'utf8')),
      designRecipe: hasDesignRecipe ? sha256(fs.readFileSync(designRecipePath, 'utf8')) : sha256(stableStringify(designRecipe)),
      dataIntent: data.hash,
      executionContract: sha256(fs.readFileSync(executionPath, 'utf8')),
      tokens: sha256(fs.readFileSync(tokensPath, 'utf8')),
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
      mediaIntent: contract.mediaIntent || designRecipe.mediaTreatment,
      presentationIntent: contract.presentationIntent || designRecipe.hierarchy,
      navigationIntent: contract.navigationIntent || { model: contract.navigationModel, initialRoute: contract.primaryScreen.route, rationale: 'Legacy experience contract.' },
      forbiddenDefaults: contract.forbiddenDefaults,
      firstViewport: contract.firstViewport,
      signatureMotifs: contract.signatureMotifs,
      promptEvidence: contract.promptEvidence,
    },
    design: {
      tokensPath: 'brand/tokens.ts',
      designSystemPath: 'brand/design-system.md',
      recipePath: hasDesignRecipe ? 'brand/design-recipe.json' : null,
      recipe: designRecipe,
      primitives: foundation.primitives.map((primitive) => ({
        motif: primitive.motif,
        component: primitive.component,
        file: primitive.file,
        testID: primitive.testID,
      })),
    },
    shell: {
      safeAreaOwner: 'screen',
      rootSafeAreaProviderOnly: true,
      headerModes: Object.fromEntries(screens.map((screen) => [screen.route, screen.headerMode])),
    },
    navigation: {
      initialRoute: primary.route,
      keyFlowRoute: keyFlow.route,
      routes: screens.map((screen) => screen.route),
      criticalFlow: { screenIds: criticalIds, outcome: screenContract.criticalFlow?.outcome || keyFlow.outcome },
    },
    execution: compactExecutionContract(executionContract),
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
    builderWaves: [
      {
        id: 'foundations', kind: 'foundation', targets: foundationComponents,
        maxConcurrency: Math.min(5, Math.max(1, foundationComponents.length)), dependsOn: [], gates: ['typecheck'],
      },
      {
        id: 'vertical-slice', kind: 'screen', targets: verticalSlice.map((screen) => screen.id),
        maxConcurrency: Math.min(5, Math.max(1, verticalSlice.length)), dependsOn: ['foundations'], gates: ['typecheck', 'native-visual-review'],
      },
      ...(remainingScreens.length ? [{
        id: 'remaining-screens', kind: 'screen', targets: remainingScreens.map((screen) => screen.id),
        maxConcurrency: Math.min(5, remainingScreens.length), dependsOn: ['vertical-slice'], gates: ['typecheck'],
      }] : []),
    ],
    buildOrder: [
      ...foundation.primitives.map((primitive) => ({ kind: 'foundation', id: primitive.component, file: primitive.file, dependsOn: [] })),
      { kind: 'screen', id: primaryScreen.id, route: primaryScreen.route, dependsOn: foundation.primitives.map((primitive) => primitive.component) },
      ...screens.filter((screen) => screen.id !== primaryScreen.id).map((screen) => ({
        kind: 'screen', id: screen.id, route: screen.route,
        dependsOn: [...foundationComponents, ...screen.dependencies.screens],
      })),
    ],
    invalidation: {
      screenDependencies: Object.fromEntries(screens.map((screen) => [screen.id, screen.role === 'supporting'
        ? ['screenContract', 'designRecipe', 'tokens', 'dataIntent', 'executionContract']
        : ['experienceContract', 'screenContract', 'foundationContract', 'designRecipe', 'tokens', 'dataIntent', 'executionContract']])),
      fixtureDependencies: Object.fromEntries(data.entities.map((entity) => [entity, ['experienceContract', 'dataIntent', 'executionContract']])),
      validatorDependencies: {
        experience: ['experienceContract', 'screenContract', 'foundationContract', 'executionContract'],
        nativeVisual: ['experienceContract', 'screenContract', 'foundationContract', 'designRecipe', 'tokens', 'executionContract'],
      },
    },
  };
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
  compactExecutionContract,
  compileScreenBuildPack,
  generatedServiceSurface,
  parseScreenMap,
  revisionForPack,
  sha256,
  stableStringify,
};
