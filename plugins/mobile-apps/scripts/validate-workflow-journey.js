#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { contractHash } = require('./experience-patterns');
const { contextEnrichmentRevision } = require('./resolve-context-enrichment');
const { workflowJourneyRevision } = require('./resolve-workflow-journey');

const ROOT_KEYS = [
  'schemaVersion', 'decisionOwner', 'experienceContractSha256', 'contextEnrichmentSha256', 'journeyId', 'journeyKind',
  'primaryOutcome', 'entryPoints', 'resume', 'declaredStateFields', 'stages', 'completionGuards', 'actions',
  'stateActions', 'signatureComponents', 'continuityKeys', 'scenarios', 'capabilityComposition',
];
const REQUIRED_ROOT_KEYS = ROOT_KEYS.filter((key) => key !== 'decisionOwner');
const JOURNEY_KINDS = new Set([
  'discovery-with-nested-flow', 'linear-resumable', 'capture-led-linear', 'progress-resumable',
  'staged-choice', 'stateful-overview', 'durable-destinations',
]);
const ORDERED_KINDS = new Set(['linear-resumable', 'capture-led-linear', 'progress-resumable', 'staged-choice']);

function exactKeys(value, allowed, required, label, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  const keys = Object.keys(value);
  const missing = required.filter((key) => !keys.includes(key));
  const unknown = keys.filter((key) => !allowed.includes(key));
  if (missing.length) errors.push(`${label} is missing keys: ${missing.join(', ')}`);
  if (unknown.length) errors.push(`${label} has unknown keys: ${unknown.join(', ')}`);
}

function uniqueIds(items, label, errors) {
  const seen = new Set();
  for (const item of items) {
    if (!/^[a-z][a-z0-9-]*$/.test(String(item?.id || '')) || seen.has(item.id)) errors.push(`${label} contains an invalid or duplicated id ${item?.id || '<missing>'}`);
    seen.add(item?.id);
  }
  return seen;
}

function validateWorkflowJourney(contract, context = {}) {
  const errors = [];
  exactKeys(contract, ROOT_KEYS, REQUIRED_ROOT_KEYS, 'workflowJourney', errors);
  if (contract?.schemaVersion !== 1) errors.push('workflowJourney.schemaVersion must be 1');
  if (contract?.decisionOwner !== undefined && !['deterministic-hint', 'model', 'legacy'].includes(contract.decisionOwner)) errors.push('workflowJourney.decisionOwner is invalid');
  if (!JOURNEY_KINDS.has(contract?.journeyKind)) errors.push('workflowJourney.journeyKind is invalid');
  if (context.experienceContract && contract?.experienceContractSha256 !== contractHash(context.experienceContract)) errors.push('workflow journey does not match the Experience Contract');
  if (context.contextContract && contract?.contextEnrichmentSha256 !== contextEnrichmentRevision(context.contextContract)) errors.push('workflow journey does not match the Context Enrichment Contract');
  if (!Array.isArray(contract?.entryPoints) || !contract.entryPoints.length) errors.push('workflowJourney.entryPoints must be non-empty');
  exactKeys(contract?.resume, ['supported', 'restoreLastCompletedStage', 'restoreDraftData', 'visibleOnPrimaryScreen'], ['supported', 'restoreLastCompletedStage', 'restoreDraftData', 'visibleOnPrimaryScreen'], 'workflowJourney.resume', errors);
  if (contract?.resume?.supported === false && (contract.resume.restoreLastCompletedStage || contract.resume.restoreDraftData || contract.resume.visibleOnPrimaryScreen)) errors.push('non-resumable journey cannot restore or display draft state');
  const stateFields = new Set(Array.isArray(contract?.declaredStateFields) ? contract.declaredStateFields : []);
  if (!stateFields.size) errors.push('workflowJourney.declaredStateFields must be non-empty');
  const stages = Array.isArray(contract?.stages) ? contract.stages : [];
  if (!stages.length) errors.push('workflowJourney.stages must be non-empty');
  const stageIds = uniqueIds(stages, 'workflowJourney.stages', errors);
  const stageScreenIds = new Set();
  stages.forEach((stage, index) => {
    exactKeys(stage, ['id', 'label', 'order', 'screenIds', 'completionRuleId', 'evidence'], ['id', 'label', 'order', 'screenIds', 'completionRuleId', 'evidence'], `workflowJourney.stages[${index}]`, errors);
    if (stage?.order !== index + 1) errors.push(`workflowJourney.stages[${index}].order must be ${index + 1}`);
    if (!Array.isArray(stage?.screenIds) || !stage.screenIds.length) errors.push(`workflowJourney.stages[${index}].screenIds must be non-empty`);
    for (const screenId of stage?.screenIds || []) stageScreenIds.add(screenId);
    if (!stage?.evidence || typeof stage.evidence.text !== 'string' || !Number.isInteger(stage.evidence.start) || !Number.isInteger(stage.evidence.end) || stage.evidence.end <= stage.evidence.start) errors.push(`workflowJourney.stages[${index}].evidence is invalid`);
    if (context.briefText && stage?.evidence && context.briefText.slice(stage.evidence.start, stage.evidence.end) !== stage.evidence.text) errors.push(`workflowJourney.stages[${index}].evidence does not match the confirmed brief`);
  });
  const guards = Array.isArray(contract?.completionGuards) ? contract.completionGuards : [];
  const guardIds = uniqueIds(guards, 'workflowJourney.completionGuards', errors);
  for (const [index, guard] of guards.entries()) {
    exactKeys(guard, ['id', 'expression', 'referencedFields', 'blockingMessage'], ['id', 'expression', 'referencedFields', 'blockingMessage'], `workflowJourney.completionGuards[${index}]`, errors);
    if (!Array.isArray(guard?.referencedFields) || !guard.referencedFields.length) errors.push(`workflowJourney.completionGuards[${index}].referencedFields must be non-empty`);
    for (const field of guard?.referencedFields || []) {
      if (!stateFields.has(field)) errors.push(`completion guard ${guard.id} references undeclared state field ${field}`);
      if (!String(guard.expression || '').includes(field)) errors.push(`completion guard ${guard.id} expression omits referenced field ${field}`);
    }
    if (!/^[A-Za-z0-9_.\s=!<>&|'-]+$/.test(String(guard?.expression || ''))) errors.push(`completion guard ${guard?.id || index} uses unsupported expression syntax`);
  }
  for (const stage of stages) if (!guardIds.has(stage.completionRuleId)) errors.push(`stage ${stage.id} references unknown completion rule ${stage.completionRuleId}`);
  const actions = Array.isArray(contract?.actions) ? contract.actions : [];
  const actionIds = uniqueIds(actions, 'workflowJourney.actions', errors);
  for (const action of actions) {
    if (!stageIds.has(action?.stageId)) errors.push(`action ${action?.id} references unknown stage ${action?.stageId}`);
    if (!['route', 'domain-operation', 'local'].includes(action?.kind)) errors.push(`action ${action?.id} has invalid kind`);
    if (!['primary', 'secondary', 'destructive'].includes(action?.semanticRole)) errors.push(`action ${action?.id} has invalid semantic role`);
  }
  const stateActions = Array.isArray(contract?.stateActions) ? contract.stateActions : [];
  const stateKeys = new Set();
  for (const [index, stateAction] of stateActions.entries()) {
    const stateKey = `${stateAction?.screenId}:${stateAction?.state}`;
    if (stateKeys.has(stateKey)) errors.push(`workflowJourney.stateActions duplicates ${stateKey}`);
    stateKeys.add(stateKey);
    if (!stageScreenIds.has(stateAction?.screenId)) errors.push(`state action references screen outside the journey: ${stateAction?.screenId}`);
    if (!actionIds.has(stateAction?.primaryAction)) errors.push(`state action ${stateKey} references unknown primary action ${stateAction?.primaryAction}`);
    if (stateAction?.guardId !== null && !guardIds.has(stateAction.guardId)) errors.push(`state action ${stateKey} references unknown guard ${stateAction?.guardId}`);
    const buckets = ['enabledActions', 'disabledActions', 'hiddenActions'];
    for (const bucket of buckets) {
      if (!Array.isArray(stateAction?.[bucket])) errors.push(`workflowJourney.stateActions[${index}].${bucket} must be an array`);
      for (const actionId of stateAction?.[bucket] || []) if (!actionIds.has(actionId)) errors.push(`state action ${stateKey} references unknown action ${actionId}`);
    }
    if (!(stateAction?.enabledActions || []).includes(stateAction?.primaryAction)) errors.push(`state action ${stateKey} must enable its single primary action`);
    if ((stateAction?.disabledActions || []).includes(stateAction?.primaryAction) || (stateAction?.hiddenActions || []).includes(stateAction?.primaryAction)) errors.push(`state action ${stateKey} cannot disable or hide its primary action`);
    if (stateAction?.state === 'incomplete') {
      const stage = stages.find((candidate) => candidate.screenIds.includes(stateAction.screenId));
      const laterStageIds = new Set(stages.filter((candidate) => candidate.order > (stage?.order || 0)).map((candidate) => candidate.id));
      const laterActions = actions.filter((action) => laterStageIds.has(action.stageId)).map((action) => action.id);
      const blocked = new Set([...(stateAction.disabledActions || []), ...(stateAction.hiddenActions || [])]);
      if (laterActions.some((actionId) => !blocked.has(actionId))) errors.push(`incomplete state ${stateKey} exposes an action from a later required stage`);
    }
  }
  const signatures = Array.isArray(contract?.signatureComponents) ? contract.signatureComponents : [];
  const kinds = new Set(signatures.map((item) => item.kind));
  if (ORDERED_KINDS.has(contract?.journeyKind) && stages.length > 1 && !kinds.has('workflow-stepper')) errors.push('ordered multi-stage journey requires a workflow-stepper signature');
  if ((!ORDERED_KINDS.has(contract?.journeyKind) || stages.length < 2) && kinds.has('workflow-stepper')) errors.push('non-staged journey cannot invent a workflow-stepper signature');
  if (contract?.resume?.supported && contract.resume.visibleOnPrimaryScreen && !kinds.has('resume-draft-module')) errors.push('visible resume behavior requires a resume-draft-module signature');
  const continuityKeys = Array.isArray(contract?.continuityKeys) ? contract.continuityKeys : [];
  if (!continuityKeys.length) errors.push('workflowJourney.continuityKeys must be non-empty');
  for (const key of continuityKeys) if (!stateFields.has(key)) errors.push(`continuity key ${key} is not a declared state field`);
  const scenarios = Array.isArray(contract?.scenarios) ? contract.scenarios : [];
  if (!scenarios.length) errors.push('workflowJourney.scenarios must be non-empty');
  const scenarioIds = new Set();
  for (const [index, scenario] of scenarios.entries()) {
    if (!/^[a-z][a-z0-9-]*$/.test(String(scenario?.id || '')) || scenarioIds.has(scenario.id)) errors.push(`workflowJourney.scenarios[${index}].id is invalid or duplicated`);
    scenarioIds.add(scenario?.id);
    if (!stageIds.has(scenario?.currentStageId)) errors.push(`scenario ${scenario?.id} references unknown current stage ${scenario?.currentStageId}`);
    if (!Number.isInteger(scenario?.completedStageCount) || !Number.isInteger(scenario?.requiredStageCount) || scenario.completedStageCount > scenario.requiredStageCount || scenario.requiredStageCount !== stages.length) errors.push(`scenario ${scenario?.id} has inconsistent stage progress`);
    const currentStage = stages.find((stage) => stage.id === scenario?.currentStageId);
    const expectedCurrentOrder = Math.min((scenario?.completedStageCount || 0) + 1, stages.length);
    if (currentStage && scenario.completedStageCount < scenario.requiredStageCount && currentStage.order !== expectedCurrentOrder) errors.push(`scenario ${scenario?.id} current stage does not follow completed progress`);
    if (contract?.resume?.supported && !['saved-draft', 'resumed'].includes(scenario?.draftState)) errors.push(`resumable scenario ${scenario?.id} requires persisted draft state`);
    if (!contract?.resume?.supported && scenario?.draftState !== 'not-applicable') errors.push(`non-resumable scenario ${scenario?.id} cannot claim draft state`);
    for (const blocker of scenario?.completionBlockers || []) if (!guardIds.has(blocker)) errors.push(`scenario ${scenario?.id} references unknown completion blocker ${blocker}`);
    if (currentStage && scenario.completedStageCount < scenario.requiredStageCount && !scenario.completionBlockers.includes(currentStage.completionRuleId)) errors.push(`scenario ${scenario?.id} must block on its current stage completion rule`);
    for (const key of continuityKeys) {
      if (!Object.prototype.hasOwnProperty.call(scenario?.continuityValues || {}, key)) errors.push(`scenario ${scenario?.id} is missing continuity value ${key}`);
    }
    if (scenario?.continuityValues?.primaryRecordId !== scenario?.primaryRecordId
      || scenario?.continuityValues?.displayReference !== scenario?.displayReference
      || scenario?.continuityValues?.offlineState !== scenario?.offlineState
      || scenario?.continuityValues?.currentStageId !== scenario?.currentStageId
      || scenario?.continuityValues?.completedStageCount !== scenario?.completedStageCount
      || scenario?.continuityValues?.requiredStageCount !== scenario?.requiredStageCount) {
      errors.push(`scenario ${scenario?.id} continuity values do not match its canonical story fields`);
    }
    const completedFlags = stages.filter((stage) => scenario?.continuityValues?.[`stage.${stage.id}.complete`] === true).length;
    if (completedFlags !== scenario?.completedStageCount) errors.push(`scenario ${scenario?.id} completed stage flags do not match completedStageCount`);
  }
  const screenIds = new Set((context.screenContract?.screens || []).map((screen) => screen.id));
  if (screenIds.size) {
    for (const screenId of stageScreenIds) if (!screenIds.has(screenId)) errors.push(`journey screen ${screenId} is absent from the Screen Contract`);
    for (const screen of context.screenContract.screens || []) {
      if (!stageScreenIds.has(screen.id) || !screen.primaryAction?.id) continue;
      const incomplete = stateActions.find((item) => item.screenId === screen.id && item.state === 'incomplete');
      if (!incomplete || incomplete.primaryAction !== screen.primaryAction.id) errors.push(`journey incomplete state for ${screen.id} must preserve Screen Contract primary action ${screen.primaryAction.id}`);
    }
  }
  const domainOperations = new Set((context.domainModel?.operations || []).map((operation) => operation.key));
  for (const action of actions) {
    if (action.kind === 'domain-operation' && domainOperations.size && !domainOperations.has(action.target)) errors.push(`action ${action.id} references unknown domain operation ${action.target}`);
    if (action.kind === 'route' && screenIds.size && !screenIds.has(action.target)) errors.push(`action ${action.id} references unknown route screen ${action.target}`);
  }
  for (const composition of contract?.capabilityComposition || []) {
    if (!['on-demand', 'supporting', 'primary'].includes(composition?.mode)) errors.push(`capability ${composition?.capability} has invalid composition mode`);
    if (!Array.isArray(composition?.fallbackStates) || !['loading', 'permission-denied', 'unavailable'].every((state) => composition.fallbackStates.includes(state))) errors.push(`capability ${composition?.capability} lacks required fallback states`);
    if (composition?.mode !== 'primary' && composition?.maxViewportShare > 0.32) errors.push(`non-primary capability ${composition?.capability} exceeds its static viewport budget`);
  }
  return { valid: errors.length === 0, errors, revision: errors.length ? null : workflowJourneyRevision(contract) };
}

function main(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--contract') args.contract = argv[++index];
    else if (argv[index] === '--brief') args.brief = argv[++index];
    else if (argv[index] === '--experience-contract') args.experienceContract = argv[++index];
    else if (argv[index] === '--context-contract') args.contextContract = argv[++index];
    else if (argv[index] === '--screen-contract') args.screenContract = argv[++index];
    else if (argv[index] === '--domain-model') args.domainModel = argv[++index];
    else if (argv[index] === '--json') args.json = true;
  }
  if (!args.projectRoot) {
    process.stderr.write('Usage: node validate-workflow-journey.js --project-root <dir> [--contract .tmp/workflow-journey-contract.json] [--brief brief.md] [--experience-contract .tmp/experience-contract.json] [--context-contract .tmp/context-enrichment-contract.json] [--screen-contract .tmp/experience-screen-contract.json] [--domain-model .tmp/prototype-domain-model.json] [--json]\n');
    return 2;
  }
  try {
    const root = path.resolve(args.projectRoot);
    const readJson = (relativePath, optional = false) => {
      const filePath = path.resolve(root, relativePath);
      return optional && !fs.existsSync(filePath) ? null : JSON.parse(fs.readFileSync(filePath, 'utf8'));
    };
    const result = validateWorkflowJourney(readJson(args.contract || '.tmp/workflow-journey-contract.json'), {
      briefText: fs.readFileSync(path.resolve(root, args.brief || 'brief.md'), 'utf8'),
      experienceContract: readJson(args.experienceContract || '.tmp/experience-contract.json'),
      contextContract: readJson(args.contextContract || '.tmp/context-enrichment-contract.json'),
      screenContract: readJson(args.screenContract || '.tmp/experience-screen-contract.json', true),
      domainModel: readJson(args.domainModel || '.tmp/prototype-domain-model.json', true),
    });
    if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else if (result.valid) process.stdout.write(`Workflow journey valid: ${result.revision}\n`);
    else result.errors.forEach((error) => process.stderr.write(`- ${error}\n`));
    return result.valid ? 0 : 2;
  } catch (error) {
    process.stderr.write(`validate-workflow-journey: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { validateWorkflowJourney };