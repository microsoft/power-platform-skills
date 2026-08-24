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
const { domainModelRevision, validatePrototypeDomainModel } = require('./lib/prototype-domain-model');
const { contextEnrichmentRevision } = require('./resolve-context-enrichment');
const { validateContextEnrichment } = require('./validate-context-enrichment');
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

function projectOwnedFile(projectRoot, relativePath, label) {
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) throw new Error(`${label} contains an unsafe path.`);
  const root = path.resolve(projectRoot);
  const target = path.resolve(root, relativePath);
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error(`${label} escapes the project root: ${relativePath}`);
  let cursor = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`${label} contains a symlink: ${relativePath}`);
  }
  if (!fs.existsSync(target) || !fs.lstatSync(target).isFile()) throw new Error(`${label} is missing: ${relativePath}`);
  return target;
}

function aggregateProjectFilesHash(projectRoot, relativePaths, label) {
  if (!Array.isArray(relativePaths) || !relativePaths.length) throw new Error(`${label} must contain at least one file.`);
  const files = [...new Set(relativePaths)].sort().map((relativePath) => ({
    path: relativePath.split(path.sep).join('/'),
    sha256: sha256(fs.readFileSync(projectOwnedFile(projectRoot, relativePath, label))),
  }));
  return sha256(stableStringify(files));
}

function domainLayerHash(projectRoot, manifestRelativePath = '.mobile-app/prototype-domain-manifest.json') {
  const manifestPath = projectOwnedFile(projectRoot, manifestRelativePath, 'Prototype domain manifest');
  const manifest = readJson(manifestPath, 'Prototype domain manifest');
  if (manifest.schemaVersion !== 1 || manifest.mode !== 'prototype-domain' || !Array.isArray(manifest.files) || !manifest.files.length) {
    throw new Error('Prototype domain manifest is incomplete.');
  }
  const filesHash = aggregateProjectFilesHash(projectRoot, manifest.files, 'Prototype domain layer');
  return sha256(stableStringify({
    schemaVersion: manifest.schemaVersion,
    mode: manifest.mode,
    domainModelRevision: manifest.domainModelRevision,
    contextEnrichmentRevision: manifest.contextEnrichmentRevision || null,
    files: [...new Set(manifest.files)].sort(),
    filesHash,
  }));
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
  const primarySpec = screenContract.screens.find((screen) => screen.role === 'primary');
  const visual = contract.visualCompositionIntent;
  if (!primarySpec?.signatureComponent?.required || primarySpec.signatureComponent.testId !== visual.signatureComponent.testId) throw new Error('Primary screen signature component does not match visualCompositionIntent.');
  if (primarySpec.firstViewport?.nextContentVisible !== visual.nextContentVisible || primarySpec.firstViewport?.maxFeatureViewportShare > visual.maxFeatureViewportShare) throw new Error('Primary screen first viewport does not match visualCompositionIntent.');
  const requiredContextIds = (context.contextContract?.displayContext || []).filter((entry) => entry.placementIntent === 'primary-screen-context-rail').map((entry) => entry.id);
  if (requiredContextIds.some((id) => !primarySpec.context?.entryIds?.includes(id))) throw new Error('Primary screen drops required Context Enrichment entries.');
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

function normalizedDomainEntity(entity) {
  return {
    logicalName: String(entity.key),
    displayName: String(entity.displayName || entity.key),
    fields: (entity.fields || []).map((field) => ({
      name: String(field.key),
      type: String(field.type),
      lookupTarget: field.referenceTarget || null,
    })),
  };
}

function inferredDataMode(projectRoot) {
  const statePath = path.join(projectRoot, '.mobile-app', 'state.json');
  if (fs.existsSync(statePath)) return readJson(statePath, 'Lifecycle state').dataMode;
  const powerPath = path.join(projectRoot, 'power.config.json');
  const environmentPath = path.join(projectRoot, '.resolved-environment.json');
  const manifestPath = path.join(projectRoot, '.datamodel-manifest.json');
  const mappingPath = path.join(projectRoot, '.tmp', 'dataverse-repository-mapping.json');
  if (![powerPath, environmentPath, manifestPath, mappingPath].every((filePath) => fs.existsSync(filePath))) return 'prototype';
  const power = readJson(powerPath, 'Power Apps config');
  const environment = readJson(environmentPath, 'Resolved environment');
  const environmentId = String(power.environmentId || '');
  return environmentId
    && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(environmentId)
    && environmentId.toLowerCase() === String(environment.environmentId || '').toLowerCase()
    ? 'dataverse'
    : 'prototype';
}

function dataIntent(projectRoot, experienceContract, contextContract) {
  const domainPath = path.join(projectRoot, '.tmp', 'prototype-domain-model.json');
  if (!fs.existsSync(domainPath)) throw new Error('Prototype domain model is missing: .tmp/prototype-domain-model.json');
  const domainModel = readJson(domainPath, 'Prototype domain model');
  const validation = validatePrototypeDomainModel(domainModel, {
    experienceContractSha256: contractHash(experienceContract),
    contextEnrichmentSha256: contextEnrichmentRevision(contextContract),
  });
  if (!validation.valid) throw new Error(`Prototype domain model is invalid: ${validation.errors.join('; ')}`);
  const dataMode = inferredDataMode(projectRoot);
  const entityContracts = domainModel.entities.map(normalizedDomainEntity);
  return {
    adapter: dataMode === 'dataverse' || dataMode === 'transitioning' ? 'dataverse-repository' : 'mock-repository',
    entities: domainModel.entities.map((entity) => entity.key),
    entityContracts,
    contract: domainModel,
    path: '.tmp/prototype-domain-model.json',
    hash: sha256(fs.readFileSync(domainPath, 'utf8')),
  };
}

function domainDataSurface(projectRoot) {
  const directory = path.join(projectRoot, 'src', 'data', 'hooks');
  if (!fs.existsSync(directory)) return { hooks: new Set(), repositories: new Set() };
  const hooks = new Set();
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isFile() && /^use[A-Z].*\.ts$/.test(entry.name)) hooks.add(path.basename(entry.name, '.ts'));
  }
  const contractsPath = path.join(projectRoot, 'src', 'data', 'contracts.ts');
  const repositories = new Set();
  if (fs.existsSync(contractsPath)) {
    const source = fs.readFileSync(contractsPath, 'utf8');
    let match;
    const pattern = /export interface\s+([A-Z][A-Za-z0-9]*Repository)\b/g;
    while ((match = pattern.exec(source)) !== null) repositories.add(match[1]);
  }
  return { hooks, repositories };
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
    canonicalRecord: { mapper: 'domain-record', stableId: 'id' },
    availability: {
      required: availabilityAction,
      entities: availabilityEntities,
      stateProperty: 'availabilityState',
      predicate: 'isDomainRecordActionable',
      disabledActionId: availabilityAction ? screen.primaryAction.id : null,
    },
    relatedMedia: {
      required: Boolean(screen.media?.required && relationships.length),
      resolver: 'resolveDomainMedia',
      join: 'repository-relationship',
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

function screenRecord(screen, data, contract, contextContract) {
  const entities = screen.data.entities.length ? screen.data.entities : data.entities;
  const foundationFiles = screen.dependencies.foundation.map((component) => `foundation:${component}`);
  const fixtureDependencies = screen.dependencies.fixtures.length
    ? screen.dependencies.fixtures.map((fixture) => `fixture:${fixture}`)
    : entities.map((entity) => `fixture:${entity}`);
  const firstViewportRegionIds = new Set(screen.firstViewport.regionIds);
  const firstViewportRegions = screen.regions.filter((region) => firstViewportRegionIds.has(region.id));
  const mediaSharesViewport = screen.media.required
    && (firstViewportRegions.length > 1 || screen.primaryAction?.placement === 'inline');
  const contextEntries = screen.context.entryIds
    .map((id) => contextContract.displayContext.find((entry) => entry.id === id))
    .filter(Boolean)
    .map((entry) => ({ ...entry, testId: `experience-context-${entry.id}` }));
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
    signatureComponent: screen.signatureComponent,
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
    testIds: [...new Set([...screen.testIds, ...contextEntries.map((entry) => entry.testId)])],
    forbiddenDefaults: screen.forbiddenDefaults,
    data: {
      adapter: data.adapter,
      entities,
      fixtureScenarios: screen.data.fixtureScenarios,
      sourceModule: '@/data',
      domainModel: '.tmp/prototype-domain-model.json',
      hooks: [...new Set(screen.data.operations.map((operation) => operation.hook))],
      recordIdentity: 'stable-primary-key',
      mediaPolicy: contract.assetPolicy.media,
      mediaFields: ['imageUrl', 'imageAltText', 'imageCacheKey', 'imageAssetKey'],
      operations: screen.data.operations,
      runtimeBindings: screenRuntimeBindings(screen, data, entities),
    },
    context: {
      placementIntent: screen.context.placementIntent,
      entries: contextEntries,
      assumptions: screen.context.assumptions,
      forbiddenInferences: contextContract.forbiddenInferences,
    },
  };
}

function revisionForPack(pack) {
  const copy = { ...pack };
  delete copy.revision;
  return sha256(stableStringify(copy));
}

function screenWorkOrder(pack, screenId) {
  const screen = pack.screens.find((candidate) => candidate.id === screenId);
  if (!screen) throw new Error(`Screen ${screenId} is not present in the build pack.`);
  return {
    packRevision: pack.revision,
    target: { screenId: screen.id, route: screen.route, file: screen.file },
    experience: pack.experience,
    context: pack.context,
    design: pack.design,
    shell: { safeAreaOwner: pack.shell.safeAreaOwner, rootSafeAreaProviderOnly: pack.shell.rootSafeAreaProviderOnly, headerMode: screen.headerMode },
    navigation: screen.navigation,
    execution: pack.execution,
    fixtures: pack.fixtures,
    screen,
    constraints: {
      ownership: 'single-screen-file',
      allowedDataImport: '@/data',
      forbiddenImports: ['@/generated', '@/data/fixtures', '@/data/repositories'],
      stableIdentity: 'domain-record-id',
    },
  };
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function safeOutputPath(projectRoot, value, label) {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const target = path.resolve(root, value);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error(`${label} must remain inside the project root.`);
  let cursor = root;
  for (const part of path.relative(root, path.dirname(target)).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`${label} parent must not contain a symlink.`);
  }
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error(`${label} must not be a symlink.`);
  return target;
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
  const contextPath = requiredFile(root, '.tmp/context-enrichment-contract.json', 'Context Enrichment Contract');
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
  const contextContract = readJson(contextPath, 'Context Enrichment Contract');
  const contextValidation = validateContextEnrichment(contextContract, { experienceContract: contract, briefText: fs.readFileSync(briefPath, 'utf8') });
  if (!contextValidation.valid) throw new Error(`Context Enrichment Contract is invalid: ${contextValidation.errors.join('; ')}`);
  const data = dataIntent(root, contract, contextContract);
  const domainManifestRelativePath = '.mobile-app/prototype-domain-manifest.json';
  const domainManifest = readJson(projectOwnedFile(root, domainManifestRelativePath, 'Prototype domain manifest'), 'Prototype domain manifest');
  if (domainManifest.domainModelRevision !== domainModelRevision(data.contract)
    || domainManifest.contextEnrichmentRevision !== contextEnrichmentRevision(contextContract)) {
    throw new Error('Prototype domain manifest is stale for the current Domain or Context contract.');
  }
  const dataSurface = domainDataSurface(root);
  const context = { dataContract: data.contract, executionContract, contextContract };
  validateInputs(contract, screenContract, foundation, context);
  for (const operation of screenContract.screens.flatMap((screen) => screen.data?.operations || [])) {
    if (!dataSurface.hooks.has(operation.hook)) throw new Error(`Domain hook ${operation.hook} is missing from src/data/hooks.`);
    if (!dataSurface.repositories.has(operation.repository)) throw new Error(`Repository ${operation.repository} is missing from src/data/contracts.ts.`);
  }
  const executionValidation = validateMobilePlanExecutionContract(executionContract, {
    briefText: fs.readFileSync(briefPath, 'utf8'),
    experienceContractSha256: contractHash(contract),
    contextEnrichmentSha256: contextEnrichmentRevision(contextContract),
    domainModelSha256: domainModelRevision(data.contract),
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
  const foundationRuntimePaths = foundation.primitives.map((primitive) => primitive.file);
  const foundationRuntimeHash = aggregateProjectFilesHash(root, foundationRuntimePaths, 'Experience foundation runtime');
  const normalizedScreens = normalizeScreenContract(screenContract, contract, screenMap, foundationComponents);
  const screens = normalizedScreens.map((screen) => screenRecord(screen, data, contract, contextContract));
  const primaryScreen = screens.find((screen) => screen.role === 'primary');
  const keyFlowScreen = screens.find((screen) => screen.role === 'key-flow');
  const designRecipePath = path.join(root, 'brand', 'design-recipe.json');
  const hasDesignRecipe = fs.existsSync(designRecipePath);
  const designRecipe = hasDesignRecipe
    ? readJson(designRecipePath, 'Design recipe')
    : resolveDesignRecipe(contract, screenContract, null, context);
  const criticalIds = screenContract.schemaVersion >= 2
    ? screenContract.criticalFlow.screenIds
    : [primaryScreen.id, keyFlowScreen.id];
  const verticalSlice = screens.filter((screen) => criticalIds.includes(screen.id));
  const remainingScreens = screens.filter((screen) => !criticalIds.includes(screen.id));
  const sourcePaths = {
    confirmedBrief: path.relative(root, briefPath).split(path.sep).join('/'),
    packageManifest: 'package.json',
    experienceContract: '.tmp/experience-contract.json',
    screenContract: '.tmp/experience-screen-contract.json',
    contextEnrichment: '.tmp/context-enrichment-contract.json',
    foundationContract: '.tmp/experience-foundation-contract.json',
    foundationRuntime: foundationRuntimePaths,
    designSystem: 'brand/design-system.md',
    tokens: 'brand/tokens.ts',
    domainModel: data.path,
    domainLayer: domainManifestRelativePath,
    executionContract: '.tmp/mobile-plan-execution-contract.json',
    designRecipe: hasDesignRecipe ? 'brand/design-recipe.json' : null,
  };
  const pack = {
    schemaVersion: 2,
    screenContractVersion: screenContract.schemaVersion,
    sources: {
      confirmedBrief: sha256(fs.readFileSync(briefPath, 'utf8')),
      packageManifest: sha256(fs.readFileSync(packagePath, 'utf8')),
      experienceContract: sha256(fs.readFileSync(experiencePath, 'utf8')),
      screenContract: sha256(fs.readFileSync(screenPath, 'utf8')),
      contextEnrichment: sha256(fs.readFileSync(contextPath, 'utf8')),
      foundationContract: sha256(fs.readFileSync(foundationPath, 'utf8')),
      foundationRuntime: foundationRuntimeHash,
      designRecipe: hasDesignRecipe ? sha256(fs.readFileSync(designRecipePath, 'utf8')) : sha256(stableStringify(designRecipe)),
      domainModel: data.hash,
      domainLayer: domainLayerHash(root, domainManifestRelativePath),
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
    context: {
      mode: contextContract.contextMode,
      forbiddenInferences: contextContract.forbiddenInferences,
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
      domainModelPath: data.path,
      assetManifest: 'assets/experience/manifest.json',
      dataModule: 'src/data/index.ts',
      mediaAdapter: 'src/data/media.ts',
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
        maxConcurrency: Math.min(5, Math.max(1, verticalSlice.length)), dependsOn: ['foundations'], gates: ['typecheck', 'static-quality-review'],
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
        ? ['confirmedBrief', 'packageManifest', 'screenContract', 'contextEnrichment', 'foundationRuntime', 'designRecipe', 'tokens', 'domainModel', 'domainLayer', 'executionContract']
        : ['confirmedBrief', 'packageManifest', 'experienceContract', 'screenContract', 'contextEnrichment', 'foundationContract', 'foundationRuntime', 'designRecipe', 'tokens', 'domainModel', 'domainLayer', 'executionContract']])),
      fixtureDependencies: Object.fromEntries(data.entities.map((entity) => [entity, ['confirmedBrief', 'experienceContract', 'contextEnrichment', 'domainModel', 'domainLayer', 'executionContract']])),
      validatorDependencies: {
        experience: ['confirmedBrief', 'packageManifest', 'experienceContract', 'screenContract', 'contextEnrichment', 'foundationContract', 'foundationRuntime', 'domainLayer', 'executionContract'],
        staticComposition: ['confirmedBrief', 'packageManifest', 'experienceContract', 'screenContract', 'contextEnrichment', 'foundationContract', 'foundationRuntime', 'designRecipe', 'tokens', 'domainLayer', 'executionContract'],
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
    const output = safeOutputPath(root, args.output || '.tmp/screen-build-pack.json', 'Screen build pack output');
    writeJsonAtomic(output, pack);
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
  aggregateProjectFilesHash,
  domainLayerHash,
  domainDataSurface,
  parseScreenMap,
  revisionForPack,
  screenWorkOrder,
  sha256,
  stableStringify,
};
