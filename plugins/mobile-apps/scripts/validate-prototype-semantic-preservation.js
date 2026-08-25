#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { compileRouteGraph, compileScreenContext, compileSignatureComponent } = require('./compile-prototype-plan-bundle');
const { safeExistingProjectFile, safeProjectOutput } = require('./lib/project-path');
const { semanticPlanRevision, sha256 } = require('./lib/prototype-semantic-plan');
const { stableStringify } = require('./resolve-context-enrichment');
const {
  ASSUMPTIONS_END,
  ASSUMPTIONS_START,
  DESIGN_END,
  DESIGN_START,
  PRODUCT_STRUCTURE_END,
  PRODUCT_STRUCTURE_START,
  renderNativePrototypePlan,
} = require('./render-native-prototype-plan');

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  fs.renameSync(temporaryPath, filePath);
}

function escapePointer(value) {
  return String(value).replace(/~/g, '~0').replace(/\//g, '~1');
}

function compareExact(source, target, sourcePath, targetPath, errors) {
  if (stableStringify(source) === stableStringify(target)) return;
  if (Array.isArray(source) && Array.isArray(target)) {
    if (source.length !== target.length) errors.push({ sourcePath, targetPath, message: `array length changed from ${source.length} to ${target.length}` });
    const length = Math.min(source.length, target.length);
    for (let index = 0; index < length; index += 1) compareExact(source[index], target[index], `${sourcePath}/${index}`, `${targetPath}/${index}`, errors);
    return;
  }
  if (source && target && typeof source === 'object' && typeof target === 'object' && !Array.isArray(source) && !Array.isArray(target)) {
    for (const key of Object.keys(source)) {
      const sourceChild = `${sourcePath}/${escapePointer(key)}`;
      const targetChild = `${targetPath}/${escapePointer(key)}`;
      if (!Object.prototype.hasOwnProperty.call(target, key)) errors.push({ sourcePath: sourceChild, targetPath: targetChild, message: 'protected value is missing' });
      else compareExact(source[key], target[key], sourceChild, targetChild, errors);
    }
    for (const key of Object.keys(target)) if (!Object.prototype.hasOwnProperty.call(source, key)) errors.push({ sourcePath: `${sourcePath}/${escapePointer(key)}`, targetPath: `${targetPath}/${escapePointer(key)}`, message: 'compiler introduced an unowned semantic value' });
    return;
  }
  errors.push({ sourcePath, targetPath, message: `protected value changed from ${JSON.stringify(source)} to ${JSON.stringify(target)}` });
}

function extractMarkedJson(markdown, start, end, label) {
  const startIndex = markdown.indexOf(start);
  const endIndex = markdown.indexOf(end);
  if (startIndex < 0 || endIndex <= startIndex) throw new Error(`${label} markers are missing`);
  const block = markdown.slice(startIndex + start.length, endIndex).trim();
  const match = block.match(/^```json\s*\n([\s\S]*?)\n```$/);
  if (!match) throw new Error(`${label} must be a canonical JSON block`);
  return JSON.parse(match[1]);
}

function expectedNavigationModel(intent) {
  if (intent.stackOnlyEvidence.length) return 'stack';
  if (!intent.tabsStackRecommendation.recommended) return 'stack';
  return intent.durableDestinations.length > 5 ? 'drawer' : 'tabs-stack';
}

function validateNavigationIntent(intent, contract, errors) {
  const destinationByScreen = new Map(contract.destinations.map((destination) => [destination.rootScreenId, destination]));
  const expectedModel = expectedNavigationModel(intent);
  if (contract.model !== expectedModel) errors.push({ sourcePath: '/navigationIntent/tabsStackRecommendation', targetPath: '/artifacts/navigationContract/model', message: `expected ${expectedModel}, received ${contract.model}` });
  const initial = contract.destinations.find((destination) => destination.id === contract.initialDestinationId);
  if (initial?.rootScreenId !== intent.primaryDestinationScreenId) errors.push({ sourcePath: '/navigationIntent/primaryDestinationScreenId', targetPath: '/artifacts/navigationContract/initialDestinationId', message: 'primary destination changed' });
  for (const [index, semantic] of intent.durableDestinations.entries()) {
    const target = destinationByScreen.get(semantic.screenId);
    if (!target) {
      errors.push({ sourcePath: `/navigationIntent/durableDestinations/${index}`, targetPath: '/artifacts/navigationContract/destinations', message: 'durable destination is missing' });
      continue;
    }
    compareExact(semantic.label, target.label, `/navigationIntent/durableDestinations/${index}/label`, `/artifacts/navigationContract/destinations/${target.id}/label`, errors);
    compareExact(semantic.iconIntent, target.iconIntent, `/navigationIntent/durableDestinations/${index}/iconIntent`, `/artifacts/navigationContract/destinations/${target.id}/iconIntent`, errors);
    compareExact(semantic.badgeBinding, target.badgeBinding, `/navigationIntent/durableDestinations/${index}/badgeBinding`, `/artifacts/navigationContract/destinations/${target.id}/badgeBinding`, errors);
    const revisit = intent.revisitPatterns.find((pattern) => pattern.screenId === semantic.screenId);
    for (const evidence of [
      `revisit:${revisit.frequency}`,
      `evidence:${revisit.evidence}`,
      `jobs:${intent.jobStructure.mode}`,
      ...(revisit.preservesState ? ['preserves-state'] : []),
      ...(revisit.crossSessionValue ? ['cross-session-value'] : []),
    ]) if (!target.durabilityEvidence.includes(evidence)) errors.push({ sourcePath: `/navigationIntent/revisitPatterns/${semantic.screenId}`, targetPath: `/artifacts/navigationContract/destinations/${target.id}/durabilityEvidence`, message: `missing ${evidence}` });
  }
  for (const [index, nested] of intent.nestedScreenTabVisibility.entries()) {
    const flow = contract.flows.find((candidate) => candidate.screenIds.includes(nested.screenId));
    const expected = contract.model === 'stack' ? 'not-applicable' : nested.visibility;
    if (!flow || flow.tabVisibility !== expected) errors.push({ sourcePath: `/navigationIntent/nestedScreenTabVisibility/${index}`, targetPath: `/artifacts/navigationContract/flows/${nested.screenId}/tabVisibility`, message: `expected ${expected}` });
  }
  compareExact(intent.stackOnlyEvidence, contract.decision.stackOnlyEvidence, '/navigationIntent/stackOnlyEvidence', '/artifacts/navigationContract/decision/stackOnlyEvidence', errors);
  for (const evidence of intent.jobStructure.evidence) if (!contract.decision.evidence.includes(evidence)) errors.push({ sourcePath: '/navigationIntent/jobStructure/evidence', targetPath: '/artifacts/navigationContract/decision/evidence', message: `missing ${evidence}` });
  const tabsEvidence = `tabs-stack:${intent.tabsStackRecommendation.recommended ? 'recommended' : 'not-recommended'}:${intent.tabsStackRecommendation.rationale}`;
  if (!contract.decision.evidence.includes(tabsEvidence)) errors.push({ sourcePath: '/navigationIntent/tabsStackRecommendation', targetPath: '/artifacts/navigationContract/decision/evidence', message: 'tabs-stack rationale changed' });
}

function validateScreenItem(semantic, target, index, semanticPlan, routes, foundation, experienceContract, errors) {
  if (!target) {
    errors.push({ sourcePath: `/screens/items/${index}`, targetPath: '/artifacts/experienceScreenContract/screens', message: `screen ${semantic.id} is missing` });
    return;
  }
  for (const key of ['id', 'role', 'productRole', 'purpose', 'presentation', 'regions', 'firstViewport', 'header', 'states', 'qualityCriteria', 'testIds', 'data', 'forbiddenDefaults']) {
    compareExact(semantic[key], target[key], `/screens/items/${index}/${key}`, `/artifacts/experienceScreenContract/screens/${semantic.id}/${key}`, errors);
  }
  compareExact(
    compileScreenContext(semantic.context, semanticPlan.__bundle.artifacts.contextEnrichmentContract),
    target.context,
    `/screens/items/${index}/context`,
    `/artifacts/experienceScreenContract/screens/${semantic.id}/context`,
    errors,
  );
  compareExact(
    compileSignatureComponent(semantic.signatureComponent, experienceContract),
    target.signatureComponent,
    `/screens/items/${index}/signatureComponent`,
    `/artifacts/experienceScreenContract/screens/${semantic.id}/signatureComponent`,
    errors,
  );
  compareExact(semantic.media, target.media, `/screens/items/${index}/media`, `/artifacts/experienceScreenContract/screens/${semantic.id}/media`, errors);
  const { destinationScreenId, ...action } = semantic.primaryAction || {};
  if (semantic.primaryAction === null) compareExact(null, target.primaryAction, `/screens/items/${index}/primaryAction`, `/artifacts/experienceScreenContract/screens/${semantic.id}/primaryAction`, errors);
  else {
    for (const key of Object.keys(action)) compareExact(action[key], target.primaryAction?.[key], `/screens/items/${index}/primaryAction/${key}`, `/artifacts/experienceScreenContract/screens/${semantic.id}/primaryAction/${key}`, errors);
    if (destinationScreenId) compareExact(routes.get(destinationScreenId).route, target.primaryAction?.destination, `/screens/items/${index}/primaryAction/destinationScreenId`, `/artifacts/experienceScreenContract/screens/${semantic.id}/primaryAction/destination`, errors);
  }
  compareExact(semantic.routeIntent.parameters, target.routeParameters, `/screens/items/${index}/routeIntent/parameters`, `/artifacts/experienceScreenContract/screens/${semantic.id}/routeParameters`, errors);
  compareExact(routes.get(semantic.id).route, target.route, `/screens/items/${index}/routeIntent/pathSegments`, `/artifacts/experienceScreenContract/screens/${semantic.id}/route`, errors);
  compareExact(routes.get(semantic.id).file, target.file, `/screens/items/${index}/routeIntent/pathSegments`, `/artifacts/experienceScreenContract/screens/${semantic.id}/file`, errors);
  if (semantic.routeIntent.parentScreenId) compareExact(routes.get(semantic.routeIntent.parentScreenId).route, target.navigation?.parentRoute, `/screens/items/${index}/routeIntent/parentScreenId`, `/artifacts/experienceScreenContract/screens/${semantic.id}/navigation/parentRoute`, errors);
  compareExact(semantic.dependencies.fixtures, target.dependencies.fixtures, `/screens/items/${index}/dependencies/fixtures`, `/artifacts/experienceScreenContract/screens/${semantic.id}/dependencies/fixtures`, errors);
  compareExact(semantic.dependencies.screens, target.dependencies.screens, `/screens/items/${index}/dependencies/screens`, `/artifacts/experienceScreenContract/screens/${semantic.id}/dependencies/screens`, errors);
  const primitiveByMotif = new Map(foundation.primitives.map((primitive) => [primitive.motif, primitive.component]));
  compareExact(semantic.foundationMotifs.map((motif) => primitiveByMotif.get(motif)), target.dependencies.foundation, `/screens/items/${index}/foundationMotifs`, `/artifacts/experienceScreenContract/screens/${semantic.id}/dependencies/foundation`, errors);
  for (const stageId of semantic.journeyStageIds) {
    const stage = semanticPlan.__bundle.artifacts.workflowJourneyContract.stages.find((candidate) => candidate.id === stageId);
    if (!stage?.screenIds.includes(semantic.id)) errors.push({ sourcePath: `/screens/items/${index}/journeyStageIds`, targetPath: `/artifacts/workflowJourneyContract/stages/${stageId}/screenIds`, message: `screen ${semantic.id} is not bound to stage ${stageId}` });
  }
}

function validatePrototypeSemanticPreservation(semanticPlan, bundle, experienceContract) {
  const errors = [];
  const domain = bundle.artifacts.prototypeDomainModel;
  const domainMappings = {
    entities: 'entities', relationships: 'relationships', choices: 'choices', operations: 'operations', actors: 'actors', uxPermissions: 'uxPermissions',
    offlineIntent: 'offlineUxIntent', fixtureRequirements: 'fixtureRequirements', mediaPolicy: 'mediaPolicy', fixtures: 'fixtures', scenarios: 'fixtureScenarios',
  };
  for (const [sourceKey, targetKey] of Object.entries(domainMappings)) compareExact(semanticPlan.domain[sourceKey], domain[targetKey], `/domain/${sourceKey}`, `/artifacts/prototypeDomainModel/${targetKey}`, errors);

  const routes = compileRouteGraph(semanticPlan, experienceContract);
  const foundation = bundle.artifacts.experienceFoundationContract;
  const screens = new Map(bundle.artifacts.experienceScreenContract.screens.map((screen) => [screen.id, screen]));
  Object.defineProperty(semanticPlan, '__bundle', { value: bundle, enumerable: false, configurable: true });
  semanticPlan.screens.items.forEach((screen, index) => validateScreenItem(screen, screens.get(screen.id), index, semanticPlan, routes, foundation, experienceContract, errors));
  delete semanticPlan.__bundle;

  const markdown = bundle.artifacts.nativeAppPlanMarkdown;
  try {
    compareExact(semanticPlan.designIntent, extractMarkedJson(markdown, DESIGN_START, DESIGN_END, 'design intent'), '/designIntent', '/artifacts/nativeAppPlanMarkdown#semantic-design-intent', errors);
  } catch (error) {
    errors.push({ sourcePath: '/designIntent', targetPath: '/artifacts/nativeAppPlanMarkdown#semantic-design-intent', message: error.message });
  }
  try {
    compareExact(semanticPlan.assumptions, extractMarkedJson(markdown, ASSUMPTIONS_START, ASSUMPTIONS_END, 'assumptions'), '/assumptions', '/artifacts/nativeAppPlanMarkdown#assumptions', errors);
  } catch (error) {
    errors.push({ sourcePath: '/assumptions', targetPath: '/artifacts/nativeAppPlanMarkdown#assumptions', message: error.message });
  }
  try {
    compareExact(semanticPlan.screens.productStructure, extractMarkedJson(markdown, PRODUCT_STRUCTURE_START, PRODUCT_STRUCTURE_END, 'product structure'), '/screens/productStructure', '/artifacts/nativeAppPlanMarkdown#product-structure', errors);
  } catch (error) {
    errors.push({ sourcePath: '/screens/productStructure', targetPath: '/artifacts/nativeAppPlanMarkdown#product-structure', message: error.message });
  }
  compareExact(semanticPlan.warnings, bundle.warnings, '/warnings', '/warnings', errors);
  const rerendered = renderNativePrototypePlan(semanticPlan, bundle, experienceContract);
  compareExact(rerendered.markdown, markdown, '/designIntent', '/artifacts/nativeAppPlanMarkdown', errors);
  compareExact(rerendered.sections, bundle.sections, '/screens', '/sections', errors);

  const preflightRequirements = bundle.artifacts.executionContract.requirements;
  for (const [index, binding] of semanticPlan.requirementBindings.entries()) {
    const requirement = preflightRequirements[binding.requirementOrdinal];
    compareExact(binding.satisfiedBy, requirement?.satisfiedBy, `/requirementBindings/${index}/satisfiedBy`, `/artifacts/executionContract/requirements/${binding.requirementOrdinal}/satisfiedBy`, errors);
    compareExact(binding.status, requirement?.status, `/requirementBindings/${index}/status`, `/artifacts/executionContract/requirements/${binding.requirementOrdinal}/status`, errors);
    if (binding.reason) compareExact(binding.reason, requirement?.reason, `/requirementBindings/${index}/reason`, `/artifacts/executionContract/requirements/${binding.requirementOrdinal}/reason`, errors);
  }
  for (const [index, selection] of semanticPlan.capabilitySelections.entries()) {
    if (!bundle.artifacts.executionContract.nativeCapabilities.some((capability) => capability.id === selection.capabilityId)) errors.push({ sourcePath: `/capabilitySelections/${index}`, targetPath: '/artifacts/executionContract/nativeCapabilities', message: `capability ${selection.capabilityId} is missing` });
  }
  for (const [index, binding] of semanticPlan.connectorIntentBindings.entries()) {
    if (!bundle.artifacts.executionContract.connectorOperations.some((connector) => connector.id === binding.operationId)) errors.push({ sourcePath: `/connectorIntentBindings/${index}`, targetPath: '/artifacts/executionContract/connectorOperations', message: `connector operation ${binding.operationId} is missing` });
  }
  validateNavigationIntent(semanticPlan.navigationIntent, bundle.artifacts.navigationContract, errors);
  const structure = semanticPlan.screens.productStructure;
  const routing = bundle.artifacts.navigationContract.routingPolicy;
  compareExact(structure.primaryScreenId, routing.primaryScreenId, '/screens/productStructure/primaryScreenId', '/artifacts/navigationContract/routingPolicy/primaryScreenId', errors);
  compareExact(structure.launchRoute, routing.launchScreenId, '/screens/productStructure/launchRoute', '/artifacts/navigationContract/routingPolicy/launchScreenId', errors);
  compareExact(structure.launchRationale, routing.launchRationale, '/screens/productStructure/launchRationale', '/artifacts/navigationContract/routingPolicy/launchRationale', errors);
  compareExact(structure.resumeRoute, routing.resumeScreenId, '/screens/productStructure/resumeRoute', '/artifacts/navigationContract/routingPolicy/resumeScreenId', errors);
  compareExact(structure.resumeRoutePolicy, routing.resumeRoutePolicy, '/screens/productStructure/resumeRoutePolicy', '/artifacts/navigationContract/routingPolicy/resumeRoutePolicy', errors);
  compareExact(structure.resumeRationale, routing.resumeRationale, '/screens/productStructure/resumeRationale', '/artifacts/navigationContract/routingPolicy/resumeRationale', errors);
  compareExact(structure.keyFlowScreenIds[0], routing.keyFlowEntryScreenId, '/screens/productStructure/keyFlowScreenIds/0', '/artifacts/navigationContract/routingPolicy/keyFlowEntryScreenId', errors);
  return {
    schemaVersion: 1,
    semanticPlanSha256: semanticPlanRevision(semanticPlan),
    finalBundleSha256: sha256(stableStringify(bundle)),
    valid: errors.length === 0,
    errors,
  };
}

function main(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--semantic-plan') args.semanticPlan = argv[++index];
    else if (argv[index] === '--bundle') args.bundle = argv[++index];
    else if (argv[index] === '--output') args.output = argv[++index];
  }
  if (!args.projectRoot) {
    process.stderr.write('Usage: node validate-prototype-semantic-preservation.js --project-root <dir> [--semantic-plan .tmp/prototype-semantic-plan.json] [--bundle .tmp/plan-artifact-bundle.json]\n');
    return 2;
  }
  try {
    const root = fs.realpathSync(path.resolve(args.projectRoot));
    const semanticPlan = readJson(safeExistingProjectFile(root, args.semanticPlan || '.tmp/prototype-semantic-plan.json', 'prototype semantic plan'), 'prototype semantic plan');
    const bundle = readJson(safeExistingProjectFile(root, args.bundle || '.tmp/plan-artifact-bundle.json', 'prototype plan bundle'), 'prototype plan bundle');
    const experience = readJson(safeExistingProjectFile(root, '.tmp/experience-contract.json', 'Experience Contract'), 'Experience Contract');
    const report = validatePrototypeSemanticPreservation(semanticPlan, bundle, experience);
    writeJsonAtomic(safeProjectOutput(root, args.output || '.tmp/prototype-semantic-preservation.json', 'prototype semantic preservation report'), report);
    if (!report.valid) throw new Error(report.errors.map((error) => `${error.sourcePath} -> ${error.targetPath}: ${error.message}`).join('; '));
    process.stdout.write('Prototype semantic preservation passed.\n');
    return 0;
  } catch (error) {
    process.stderr.write(`validate-prototype-semantic-preservation: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  compareExact,
  extractMarkedJson,
  validateNavigationIntent,
  validatePrototypeSemanticPreservation,
};
