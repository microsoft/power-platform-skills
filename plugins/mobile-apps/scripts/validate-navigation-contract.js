#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { contractHash } = require('./experience-patterns');
const { workflowJourneyRevision } = require('./resolve-workflow-journey');
const { navigationContractRevision, screenGraphRevision } = require('./resolve-navigation-contract');

const ACTION_DESTINATION = /\b(?:scan|add|create|capture|pay|submit|sync|search|edit|delete|confirm)\b/i;

function validateNavigationContract(contract, context = {}) {
  const errors = [];
  if (contract?.schemaVersion !== 1) errors.push('navigationContract.schemaVersion must be 1');
  if (context.experienceContract && contract?.experienceContractSha256 !== contractHash(context.experienceContract)) errors.push('navigation contract does not match the Experience Contract');
  if (context.workflowJourney && contract?.workflowContractSha256 !== workflowJourneyRevision(context.workflowJourney)) errors.push('navigation contract does not match the Workflow Journey Contract');
  if (context.screenContract && contract?.screenGraphSha256 !== screenGraphRevision(context.screenContract)) errors.push('navigation contract does not match the final Screen Graph');
  if (!['tabs-stack', 'stack', 'drawer'].includes(contract?.model)) errors.push('navigationContract.model is invalid');
  const destinations = Array.isArray(contract?.destinations) ? contract.destinations : [];
  if (!destinations.length || contract?.destinationCount !== destinations.length) errors.push('navigation destinationCount does not match destinations');
  if (contract?.model === 'tabs-stack' && (destinations.length < 3 || destinations.length > 5)) errors.push('tabs-stack requires 3-5 durable destinations');
  if (contract?.model === 'drawer' && destinations.length <= 5) errors.push('drawer requires more than five durable destinations');
  if (contract?.model === 'stack' && (!contract.decision?.stackOnlyReason || !contract.decision?.stackOnlyEvidence?.length || !contract.decision?.returnHomeMechanism)) errors.push('stack-only navigation requires reason, evidence, and return-home mechanism');
  const destinationIds = new Set();
  const destinationScreens = new Set();
  const routes = new Set();
  const labels = new Set();
  for (const [index, destination] of destinations.entries()) {
    if (!/^[a-z][a-z0-9-]*$/.test(String(destination?.id || '')) || destinationIds.has(destination.id)) errors.push(`navigation destination ${index} has invalid or duplicate id`);
    destinationIds.add(destination?.id);
    if (!destination?.rootScreenId || destinationScreens.has(destination.rootScreenId)) errors.push(`navigation destination ${destination?.id} has missing or duplicate root screen`);
    destinationScreens.add(destination?.rootScreenId);
    if (!destination?.route?.startsWith('/') || routes.has(destination.route)) errors.push(`navigation destination ${destination?.id} has invalid or duplicate route`);
    routes.add(destination?.route);
    const label = String(destination?.label || '').toLowerCase();
    if (!label || labels.has(label)) errors.push(`navigation destination ${destination?.id} has missing or duplicate label`);
    labels.add(label);
    if (ACTION_DESTINATION.test(label)) errors.push(`navigation destination ${destination?.id} represents an action rather than a stable area`);
    if (destination?.order !== index + 1) errors.push(`navigation destination ${destination?.id} order must be ${index + 1}`);
    if (destination?.independentJob !== true || destination?.statePolicy !== 'preserve' || !destination?.durabilityEvidence?.length) errors.push(`navigation destination ${destination?.id} lacks durable independent-state evidence`);
  }
  if (!destinationIds.has(contract?.initialDestinationId)) errors.push('initial destination is not registered');
  const screenIds = new Set((context.screenContract?.screens || []).map((screen) => screen.id));
  const routeByScreenId = new Map((context.screenContract?.screens || []).map((screen) => [screen.id, screen.route]));
  const routing = contract?.routingPolicy;
  if (!routing || !screenIds.has(routing.primaryScreenId) || !screenIds.has(routing.launchScreenId)) errors.push('navigation routing policy requires known primary and launch screens');
  if (routing && routeByScreenId.get(routing.launchScreenId) !== routing.launchRoute) errors.push('navigation launch route does not match its screen');
  if (routing?.resumeScreenId === null && routing?.resumeRoute !== null) errors.push('navigation null resume screen requires null route');
  if (routing?.resumeScreenId && (!screenIds.has(routing.resumeScreenId) || routeByScreenId.get(routing.resumeScreenId) !== routing.resumeRoute)) errors.push('navigation resume route does not match its screen');
  if (routing?.resumeRoutePolicy === 'none' && routing.resumeScreenId !== null) errors.push('navigation none resume policy requires null screen');
  if (routing?.resumeRoutePolicy === 'home' && routing.resumeScreenId !== routing.primaryScreenId) errors.push('navigation home resume policy requires the primary screen');
  if (routing?.keyFlowEntryScreenId && !screenIds.has(routing.keyFlowEntryScreenId)) errors.push('navigation key-flow entry screen is unknown');
  for (const destination of destinations) if (screenIds.size && !screenIds.has(destination.rootScreenId)) errors.push(`destination root ${destination.rootScreenId} is absent from the Screen Graph`);
  const ownedScreens = new Set(destinationScreens);
  for (const flow of contract?.flows || []) {
    if (!destinationIds.has(flow?.ownerDestinationId)) errors.push(`flow ${flow?.id} has unknown owner destination`);
    if (!destinationIds.has(flow?.completionDestinationId) || !destinationIds.has(flow?.cancelDestinationId)) errors.push(`flow ${flow?.id} has invalid completion or cancel destination`);
    if (!flow?.screenIds?.length) errors.push(`flow ${flow?.id} has no screens`);
    for (const screenId of flow?.screenIds || []) {
      if (ownedScreens.has(screenId)) errors.push(`screen ${screenId} has multiple navigation owners`);
      ownedScreens.add(screenId);
      if (screenIds.size && !screenIds.has(screenId)) errors.push(`flow screen ${screenId} is absent from the Screen Graph`);
    }
    if (flow?.presentation !== 'nested-stack' && (flow.tabVisibility !== 'covered-by-modal' || !/return-to-owner/i.test(flow.dismissBehavior || ''))) errors.push(`modal flow ${flow?.id} must cover tabs and return to its owner`);
  }
  if (screenIds.size) for (const screenId of screenIds) if (!ownedScreens.has(screenId)) errors.push(`screen ${screenId} has no destination or flow owner`);
  if (contract?.adaptivePresentation?.destinationIdentityStableAcrossSizes !== true) errors.push('adaptive presentation must preserve destination identity');
  if (contract?.accessibility?.labelsRequired !== true || contract?.accessibility?.selectedStateRequired !== true || contract?.accessibility?.minimumTouchTarget < 44) errors.push('navigation accessibility contract is incomplete');
  return { valid: errors.length === 0, errors, revision: errors.length ? null : navigationContractRevision(contract) };
}

function main(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--contract') args.contract = argv[++index];
    else if (argv[index] === '--experience-contract') args.experienceContract = argv[++index];
    else if (argv[index] === '--workflow-contract') args.workflowContract = argv[++index];
    else if (argv[index] === '--screen-contract') args.screenContract = argv[++index];
    else if (argv[index] === '--json') args.json = true;
  }
  if (!args.projectRoot) {
    process.stderr.write('Usage: node validate-navigation-contract.js --project-root <dir> [--contract .tmp/navigation-contract.json] [--experience-contract <path>] [--workflow-contract <path>] [--screen-contract <path>] [--json]\n');
    return 2;
  }
  try {
    const root = path.resolve(args.projectRoot);
    const readJson = (value, fallback) => JSON.parse(fs.readFileSync(path.resolve(root, value || fallback), 'utf8'));
    const result = validateNavigationContract(readJson(args.contract, '.tmp/navigation-contract.json'), {
      experienceContract: readJson(args.experienceContract, '.tmp/experience-contract.json'),
      workflowJourney: readJson(args.workflowContract, '.tmp/workflow-journey-contract.json'),
      screenContract: readJson(args.screenContract, '.tmp/experience-screen-contract.json'),
    });
    if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else if (result.valid) process.stdout.write(`Navigation contract valid: ${result.revision}\n`);
    else result.errors.forEach((error) => process.stderr.write(`- ${error}\n`));
    return result.valid ? 0 : 2;
  } catch (error) {
    process.stderr.write(`validate-navigation-contract: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { validateNavigationContract };