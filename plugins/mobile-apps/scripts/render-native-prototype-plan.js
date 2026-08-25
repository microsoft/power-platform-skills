#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { safeExistingProjectFile, safeProjectOutput } = require('./lib/project-path');

const DESIGN_START = '<!-- prototype-semantic-design-intent:start -->';
const DESIGN_END = '<!-- prototype-semantic-design-intent:end -->';
const ASSUMPTIONS_START = '<!-- prototype-semantic-assumptions:start -->';
const ASSUMPTIONS_END = '<!-- prototype-semantic-assumptions:end -->';
const PRODUCT_STRUCTURE_START = '<!-- prototype-product-structure:start -->';
const PRODUCT_STRUCTURE_END = '<!-- prototype-product-structure:end -->';

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

function escapeCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function canonicalBlock(start, value, end) {
  return [start, '```json', JSON.stringify(value, null, 2), '```', end].join('\n');
}

function renderDataModel(semanticPlan, domainModel) {
  const entities = domainModel.entities.map((entity) => `| ${escapeCell(entity.displayName)} | ${escapeCell(entity.description)} | ${entity.fields.length} | ${entity.estimatedPrototypeRows} |`).join('\n');
  const relationships = domainModel.relationships.length
    ? domainModel.relationships.map((relationship) => `- ${relationship.parent} -> ${relationship.child} (${relationship.cardinality}, ${relationship.deleteBehavior || 'unspecified'} delete)`).join('\n')
    : '- No cross-entity relationships.';
  const operations = domainModel.operations.map((operation) => `- \`${operation.key}\`: ${operation.kind} ${operation.entity} through ${operation.repository}.${operation.method} / ${operation.hook}; failures: ${(operation.failureStates || []).join(', ') || 'contract default'}`).join('\n');
  return [
    '## Data Model',
    '',
    '| Entity | Meaning | Fields | Fixture rows |',
    '| --- | --- | ---: | ---: |',
    entities,
    '',
    '### Relationships',
    relationships,
    '',
    '### Operations',
    operations,
    '',
    `Offline behavior: ${domainModel.offlineUxIntent.connectivity}. ${domainModel.offlineUxIntent.pendingSyncBehavior || ''} ${domainModel.offlineUxIntent.resumeBehavior || ''}`.trim(),
    `Fixture scenarios: ${domainModel.fixtureScenarios.map((scenario) => scenario.key).join(', ')}.`,
  ].join('\n');
}

function renderNativeCapabilities(semanticPlan, executionContract) {
  const rationale = new Map(semanticPlan.capabilitySelections.map((selection) => [selection.capabilityId, selection]));
  const rows = executionContract.nativeCapabilities.length
    ? executionContract.nativeCapabilities.map((capability) => {
      const selection = rationale.get(capability.id);
      return `| ${escapeCell(capability.capability)} | ${escapeCell(selection?.owningScreenId || '')} | ${escapeCell(selection?.rationale || 'Foreground preflight requirement')} | ${escapeCell(capability.execution)} |`;
    }).join('\n')
    : '| None | Not applicable | No native capability is required. | none |';
  return [
    '## Native Capabilities',
    '',
    '| Capability | Owning screen | Product rationale | Execution |',
    '| --- | --- | --- | --- |',
    rows,
  ].join('\n');
}

function renderConnectors(semanticPlan, executionContract) {
  const rationale = new Map(semanticPlan.connectorIntentBindings.map((binding) => [binding.operationId, binding]));
  const rows = executionContract.connectorOperations.length
    ? executionContract.connectorOperations.map((connector) => {
      const binding = rationale.get(connector.id);
      return `| ${escapeCell(connector.connector)} | ${escapeCell(connector.operation)} | ${escapeCell((binding?.screenIds || []).join(', '))} | ${escapeCell(binding?.rationale || 'Foreground connector requirement')} |`;
    }).join('\n')
    : '| None | None | Not applicable | Prototype remains local and fail-closed. |';
  return [
    '## Connectors',
    '',
    '| Connector | Operation | Screens | Product rationale |',
    '| --- | --- | --- | --- |',
    rows,
  ].join('\n');
}

function renderScreens(semanticPlan, bundle) {
  const contract = bundle.artifacts.experienceScreenContract;
  const navigation = bundle.artifacts.navigationContract;
  const rows = contract.screens.map((screen) => `| ${escapeCell(screen.id)} | ${escapeCell(screen.productRole)} | ${escapeCell(screen.route)} | ${escapeCell(screen.file)} | ${escapeCell(screen.purpose)} | ${escapeCell(screen.navigation.role)} |`).join('\n');
  return [
    '## Screens',
    '',
    `Navigation model: ${navigation.model}. Initial destination: ${navigation.initialDestinationId}.`,
    `Launch: ${navigation.routingPolicy.launchRoute}. Resume policy: ${navigation.routingPolicy.resumeRoutePolicy}${navigation.routingPolicy.resumeRoute ? ` at ${navigation.routingPolicy.resumeRoute}` : ''}.`,
    '',
    '| Screen | Product role | Route | File | Outcome | Navigation ownership |',
    '| --- | --- | --- | --- | --- | --- |',
    rows,
    '',
    `Critical flow: ${contract.criticalFlow.screenIds.join(' -> ')}. ${contract.criticalFlow.outcome}`,
    '',
    '### Product Structure',
    canonicalBlock(PRODUCT_STRUCTURE_START, semanticPlan.screens.productStructure, PRODUCT_STRUCTURE_END),
  ].join('\n');
}

function renderDesign(semanticPlan, experienceContract) {
  return [
    '## Design',
    '',
    '### Product Experience Contract',
    `- Primary job: ${experienceContract.primaryJob}`,
    `- Entry mode: ${experienceContract.entryMode}`,
    `- Primary action: ${experienceContract.firstViewport.primaryAction}`,
    `- Primary surface: ${experienceContract.primarySurface}`,
    `- Asset policy: ${experienceContract.assetPolicy.connectivity} / ${experienceContract.assetPolicy.media}`,
    `- Media source: ${experienceContract.mediaIntent.source}`,
    `- Media delivery: ${experienceContract.mediaIntent.delivery}`,
    `- Prompt evidence: ${(experienceContract.promptEvidence?.primaryJob || []).map((item) => item.text).filter(Boolean).join('; ') || 'validated foreground brief'}`,
    '',
    '### Semantic Design Intent',
    canonicalBlock(DESIGN_START, semanticPlan.designIntent, DESIGN_END),
  ].join('\n');
}

function renderRequirements(executionContract) {
  return [
    '## App Requirements',
    '',
    ...executionContract.requirements.map((requirement) => `- [${requirement.status === 'planned' ? 'x' : ' '}] ${requirement.source} -> ${requirement.satisfiedBy.join(', ')}${requirement.reason ? ` (${requirement.reason})` : ''}`),
  ].join('\n');
}

function renderNativePrototypePlan(semanticPlan, bundle, experienceContract) {
  if (!bundle.artifacts.navigationContract) throw new Error('final Navigation Contract is required before rendering Markdown');
  const dataModel = renderDataModel(semanticPlan, bundle.artifacts.prototypeDomainModel);
  const nativeCapabilities = renderNativeCapabilities(semanticPlan, bundle.artifacts.executionContract);
  const connectors = renderConnectors(semanticPlan, bundle.artifacts.executionContract);
  const screenPlan = renderScreens(semanticPlan, bundle);
  const design = renderDesign(semanticPlan, experienceContract);
  const assumptions = [
    '### Assumptions',
    canonicalBlock(ASSUMPTIONS_START, semanticPlan.assumptions, ASSUMPTIONS_END),
  ].join('\n');
  const markdown = [
    '# Mobile Prototype Plan',
    '',
    '## Overview',
    '',
    experienceContract.primaryJob,
    '',
    'This is a local prototype plan. It selects no Power Platform environment and authorizes no external mutation.',
    '',
    renderRequirements(bundle.artifacts.executionContract),
    '',
    dataModel,
    '',
    nativeCapabilities,
    '',
    design,
    '',
    connectors,
    '',
    screenPlan,
    '',
    '## Approvals',
    '',
    'One consolidated local prototype review is required. Approval cannot authorize external mutation.',
    '',
    assumptions,
    '',
  ].join('\n');
  return {
    markdown,
    sections: {
      dataModel: { summary: `${bundle.artifacts.prototypeDomainModel.entities.length} neutral entities with realistic connected fixtures.`, markdown: dataModel },
      nativeCapabilities: { summary: `${bundle.artifacts.executionContract.nativeCapabilities.length} foreground-supported native capabilities.`, markdown: nativeCapabilities },
      connectors: { summary: `${bundle.artifacts.executionContract.connectorOperations.length} connector intentions, fail-closed in prototype mode.`, markdown: connectors },
      screenPlan: { summary: `${bundle.artifacts.experienceScreenContract.screens.length} screens using ${bundle.artifacts.navigationContract.model}.`, markdown: screenPlan },
    },
  };
}

function main(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--semantic-plan') args.semanticPlan = argv[++index];
    else if (argv[index] === '--bundle') args.bundle = argv[++index];
  }
  if (!args.projectRoot) {
    process.stderr.write('Usage: node render-native-prototype-plan.js --project-root <dir> [--semantic-plan .tmp/prototype-semantic-plan.json] [--bundle .tmp/plan-artifact-bundle.json]\n');
    return 2;
  }
  try {
    const root = fs.realpathSync(path.resolve(args.projectRoot));
    const semanticPlan = readJson(safeExistingProjectFile(root, args.semanticPlan || '.tmp/prototype-semantic-plan.json', 'prototype semantic plan'), 'prototype semantic plan');
    const bundlePath = safeExistingProjectFile(root, args.bundle || '.tmp/plan-artifact-bundle.json', 'prototype plan bundle');
    const bundle = readJson(bundlePath, 'prototype plan bundle');
    const experience = readJson(safeExistingProjectFile(root, '.tmp/experience-contract.json', 'Experience Contract'), 'Experience Contract');
    const rendered = renderNativePrototypePlan(semanticPlan, bundle, experience);
    bundle.artifacts.nativeAppPlanMarkdown = rendered.markdown;
    bundle.sections = rendered.sections;
    writeJsonAtomic(safeProjectOutput(root, args.bundle || '.tmp/plan-artifact-bundle.json', 'rendered prototype plan bundle'), bundle);
    process.stdout.write('Native prototype plan rendered deterministically.\n');
    return 0;
  } catch (error) {
    process.stderr.write(`render-native-prototype-plan: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  ASSUMPTIONS_END,
  ASSUMPTIONS_START,
  DESIGN_END,
  DESIGN_START,
  PRODUCT_STRUCTURE_END,
  PRODUCT_STRUCTURE_START,
  canonicalBlock,
  renderNativePrototypePlan,
};
