#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validateJsonSchema } = require('./lib/json-schema-lite');
const { isKnownIconIntent } = require('./lib/navigation-icons');

const SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, 'schema-screen-action-contract.json'), 'utf8'));
const NUMERIC_TYPES = new Set(['whole-number', 'decimal', 'money']);

function screenEntries(screenContract) {
  if (Array.isArray(screenContract?.screens)) return screenContract.screens;
  const entries = [];
  const primary = screenContract?.primaryScreen;
  if (primary) entries.push({ id: 'Home', route: primary.route, role: 'primary', primaryAction: primary.primaryAction ? { id: 'primary-action' } : null });
  for (const screen of screenContract?.requiredScreens || []) entries.push({ ...screen, role: screen.route === screenContract?.keyFlow?.route ? 'key-flow' : 'supporting' });
  if (screenContract?.keyFlow && !entries.some((screen) => screen.route === screenContract.keyFlow.route)) {
    entries.push({ id: 'KeyFlow', ...screenContract.keyFlow, role: 'key-flow', primaryAction: { id: 'key-flow-primary-action' } });
  }
  return entries;
}

function fieldMapForOperation(operation, domainModel) {
  const entity = (domainModel?.entities || []).find((candidate) => candidate.key === operation?.entity);
  return new Map((entity?.fields || []).map((field) => [field.key, field]));
}

function tableAliases(table) {
  return new Set([table?.logicalName, table?.adaptedLogicalName, table?.schemaName].filter(Boolean));
}

function tableForEntity(schema, entity) {
  return (schema?.tables || []).find((table) => tableAliases(table).has(entity)) || null;
}

function tableFieldNames(table) {
  return new Set([
    table?.primaryIdAttribute,
    ...(table?.columns || []).flatMap((column) => [column.logicalName, column.adaptedLogicalName, column.schemaName]),
  ].filter(Boolean));
}

function validateValueSource(source, label, errors) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return;
  if (source.kind === 'constant') {
    if (!Object.prototype.hasOwnProperty.call(source, 'value')) errors.push(`${label} constant source requires value`);
  } else if (typeof source.path !== 'string' || !source.path.trim()) {
    errors.push(`${label} ${source.kind || 'value'} source requires path`);
  }
}

function validateScreenActionContract(contract, context = {}) {
  const errors = validateJsonSchema(contract, SCHEMA).map((error) => `schema${error}`);
  const screens = screenEntries(context.screenContract);
  const screenById = new Map(screens.map((screen) => [screen.id, screen]));
  const structuredOperations = screenEntries(context.screenContract).flatMap((screen) => (screen.data?.operations || []).map((operation) => ({
    ...operation,
    key: operation.domainOperation || operation.id,
    method: operation.repositoryMethod,
    filterFields: (operation.filter || []).map((filter) => filter.field),
  })));
  const operations = new Map([
    ...structuredOperations.map((operation) => [operation.key, operation]),
    ...(context.domainModel?.operations || []).map((operation) => [operation.key, operation]),
  ]);
  const connectorOperations = new Set((context.executionContract?.connectorOperations || []).map((operation) => operation.id));
  const serviceSurface = new Map((context.serviceSurface?.entries || []).map((entry) => [entry.entity, entry]));
  const actions = Array.isArray(contract?.actions) ? contract.actions : [];
  const actionById = new Map();
  for (const [index, action] of actions.entries()) {
    const label = `actions[${index}]`;
    if (actionById.has(action?.id)) errors.push(`${label}.id duplicates ${action.id}`);
    else if (action?.id) actionById.set(action.id, action);
    const screen = screenById.get(action?.screenId);
    if (!screen) errors.push(`${label}.screenId does not resolve: ${action?.screenId || '<missing>'}`);
    const executor = action?.executor || {};
    if (action?.semanticRole === 'primary' && !['inline', 'sticky-bottom', 'header', 'floating'].includes(action?.placement)) errors.push(`${label}.placement is invalid for a primary action`);
    if (['route', 'operation', 'connector', 'native', 'local', 'host'].includes(executor.kind)
      && (typeof executor.target !== 'string' || !executor.target.trim())) errors.push(`${label}.executor ${executor.kind} requires target`);
    if (executor.kind === 'route') {
      if (!screenById.has(executor.target)) errors.push(`${label}.executor route target does not resolve: ${executor.target}`);
      if (!['navigate', 'push', 'replace', 'present'].includes(executor.intent)) errors.push(`${label}.executor route requires intent`);
    }
    if (executor.kind === 'operation') {
      const operation = operations.get(executor.target);
      if (!operation) {
        if (typeof executor.entity !== 'string' || !executor.entity.trim() || !['list', 'get', 'create', 'update', 'delete'].includes(executor.operationKind)) {
          errors.push(`${label}.executor unresolved operation requires entity and operationKind: ${executor.target}`);
        } else {
          const table = tableForEntity(context.dataverseSchema, executor.entity);
          if (context.dataverseSchema && !table) errors.push(`${label}.executor entity does not resolve in the Dataverse contract: ${executor.entity}`);
          if (table) {
            const fields = tableFieldNames(table);
            for (const binding of action.inputs || []) if (!fields.has(binding.target)) errors.push(`${label}.inputs target ${binding.target} is not a Dataverse field on ${executor.entity}`);
          }
          if (context.phase !== 'build') {
            // Generated services do not exist during planning. The entity and
            // operation intent are resolved after collision-safe generation.
          } else {
            const service = [...serviceSurface.values()].find((entry) => entry.entity === executor.entity || (entry.aliases || []).includes(executor.entity));
            const methodByKind = { list: 'getAll', get: 'get', create: 'create', update: 'update', delete: 'delete' };
            const method = methodByKind[executor.operationKind];
            if (!service || service.status !== 'available' || !service.methods.includes(method)) errors.push(`${label}.executor operation target does not resolve on generated service: ${executor.target}`);
          }
        }
      } else {
        const expectedMode = ['list', 'get'].includes(operation.kind) ? 'query' : 'mutation';
        if (executor.mode !== expectedMode) errors.push(`${label}.executor mode must be ${expectedMode} for ${operation.kind}`);
        const writable = new Set([...(operation.writeFields || []), 'id']);
        const readableInputs = new Set([...(operation.filterFields || []), 'id', 'cursor', 'pageSize']);
        const inputs = expectedMode === 'mutation' ? writable : readableInputs;
        for (const binding of action.inputs || []) if (!inputs.has(binding.target)) errors.push(`${label}.inputs target ${binding.target} is not accepted by operation ${operation.key}`);
      }
    }
    if (executor.kind === 'connector' && !connectorOperations.has(executor.target)) errors.push(`${label}.executor connector target does not resolve: ${executor.target}`);
    if (executor.kind === 'native') {
      const capabilities = new Set((screen?.capabilityComposition || []).map((composition) => composition.capability));
      if (!capabilities.has(executor.target)) errors.push(`${label}.executor native capability is not planned on ${action.screenId}: ${executor.target}`);
      if (typeof executor.command !== 'string' || !executor.command.trim()) errors.push(`${label}.executor native requires command`);
    }
    if (executor.kind === 'sequence') {
      if (!Array.isArray(executor.steps) || !executor.steps.length) errors.push(`${label}.executor sequence requires steps`);
      if (!['ordered-stop-on-error', 'ordered-retry-safe'].includes(executor.policy)) errors.push(`${label}.executor sequence requires policy`);
    }
    for (const [bindingIndex, binding] of (action.inputs || []).entries()) validateValueSource(binding?.source, `${label}.inputs[${bindingIndex}].source`, errors);
    const routeParameters = new Set((screen?.routeParameters || []).map((parameter) => parameter.name));
    const contextEntries = new Set((context.contextContract?.displayContext || []).flatMap((entry) => [entry.id, entry.sourceBinding]).filter(Boolean));
    for (const [bindingIndex, binding] of (action.inputs || []).entries()) {
      const source = binding?.source;
      if (source?.kind === 'route' && !routeParameters.has(source.path)) errors.push(`${label}.inputs[${bindingIndex}] route source does not resolve: ${source.path}`);
      if (source?.kind === 'context' && !contextEntries.has(source.path)) errors.push(`${label}.inputs[${bindingIndex}] context source does not resolve: ${source.path}`);
    }
    for (const [conditionIndex, condition] of (action.availability || []).entries()) {
      const conditionLabel = `${label}.availability[${conditionIndex}]`;
      validateValueSource(condition?.left, `${conditionLabel}.left`, errors);
      if (!['truthy', 'falsy'].includes(condition?.operator)) {
        if (!condition?.right) errors.push(`${conditionLabel}.right is required for ${condition?.operator}`);
        else validateValueSource(condition.right, `${conditionLabel}.right`, errors);
      }
    }
    const control = action.controlHint;
    if (control?.iconIntent && !isKnownIconIntent(control.iconIntent)) errors.push(`${label}.controlHint iconIntent is unsupported: ${control.iconIntent}`);
    if (control?.kind === 'icon-button' && !control.iconIntent) errors.push(`${label}.controlHint icon-button requires iconIntent`);
    if (control?.labelMode === 'accessible-only' && !control.iconIntent) errors.push(`${label}.controlHint accessible-only requires iconIntent`);
    if (action?.semanticRole === 'primary' && control?.labelMode === 'accessible-only') errors.push(`${label}.controlHint cannot hide a primary action label`);
    if (control?.badge) {
      validateValueSource(control.badge.source, `${label}.controlHint.badge.source`, errors);
      if (!['record', 'state', 'context', 'result'].includes(control.badge.source?.kind)) errors.push(`${label}.controlHint badge requires a dynamic record, state, context, or result source`);
      if (control.badge.source?.kind === 'context' && !contextEntries.has(control.badge.source.path)) errors.push(`${label}.controlHint badge context source does not resolve: ${control.badge.source.path}`);
    }
    if (control?.kind === 'stepper') {
      if (typeof control.field !== 'string' || !control.field.trim()) errors.push(`${label}.controlHint stepper requires field`);
      if (!['immediate', 'local-draft', 'on-action'].includes(control.commit)) errors.push(`${label}.controlHint stepper requires commit`);
      if (executor.kind === 'operation') {
        const operation = operations.get(executor.target);
        const field = fieldMapForOperation(operation, context.domainModel).get(control.field);
        if (context.domainModel && (!field || !NUMERIC_TYPES.has(field.type))) errors.push(`${label}.controlHint stepper field must resolve to a numeric operation entity field`);
        if (operation && !new Set(operation.writeFields || []).has(control.field) && control.commit !== 'local-draft') errors.push(`${label}.controlHint stepper field is not writable by operation ${operation.key}`);
        if (control.minimum?.kind === 'field-constraint' && field?.minimum === undefined) errors.push(`${label}.controlHint minimum requests a missing field constraint`);
        if (control.maximum?.kind === 'field-constraint' && field?.maximum === undefined) errors.push(`${label}.controlHint maximum requests a missing field constraint`);
      }
      for (const bound of ['minimum', 'maximum']) if (control?.[bound]) validateValueSource(control[bound], `${label}.controlHint.${bound}`, errors);
    }
  }
  for (const action of actions) {
    if (action?.executor?.kind !== 'sequence') continue;
    for (const step of action.executor.steps || []) {
      if (!actionById.has(step)) errors.push(`action ${action.id} sequence references unknown action ${step}`);
      if (step === action.id) errors.push(`action ${action.id} sequence cannot reference itself`);
      const stepAction = actionById.get(step);
      if (stepAction && stepAction.screenId !== action.screenId) errors.push(`action ${action.id} sequence step ${step} belongs to another screen`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(actionId) {
    if (visiting.has(actionId)) {
      errors.push(`action sequence contains a cycle at ${actionId}`);
      return;
    }
    if (visited.has(actionId)) return;
    visiting.add(actionId);
    const action = actionById.get(actionId);
    if (action?.executor?.kind === 'sequence') for (const step of action.executor.steps || []) if (actionById.has(step)) visit(step);
    visiting.delete(actionId);
    visited.add(actionId);
  }
  for (const actionId of actionById.keys()) visit(actionId);
  for (const state of context.workflowJourney?.stateActions || []) {
    for (const actionId of new Set([state.primaryAction, ...(state.enabledActions || [])])) {
      const action = actionById.get(actionId);
      if (!action || action.screenId !== state.screenId) errors.push(`journey state ${state.screenId}/${state.state} enables ${actionId} without a same-screen executable action`);
    }
  }
  for (const screen of screens) {
    const expectsPrimary = screen.role === 'primary' || screen.role === 'key-flow' || Boolean(screen.primaryAction);
    if (!expectsPrimary) continue;
    const primaryActions = actions.filter((action) => action.screenId === screen.id && action.semanticRole === 'primary');
    if (primaryActions.length !== 1) errors.push(`screen ${screen.id} requires exactly one executable primary action; found ${primaryActions.length}`);
  }
  return { valid: errors.length === 0, errors };
}

function parseArgs(argv) {
  const args = { phase: 'build' };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--contract') args.contract = argv[++index];
    else if (argv[index] === '--phase') args.phase = argv[++index];
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args.projectRoot) {
    process.stderr.write('Usage: node validate-screen-action-contract.js --project-root <dir> [--contract .tmp/screen-action-contract.json] [--phase plan|build]\n');
    return 2;
  }
  try {
    const root = fs.realpathSync(path.resolve(args.projectRoot));
    const read = (relativePath, optional = false) => {
      const filePath = path.resolve(root, relativePath);
      if (optional && !fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    };
    const contract = read(args.contract || '.tmp/screen-action-contract.json');
    const result = validateScreenActionContract(contract, {
      screenContract: read('.tmp/experience-screen-contract.json'),
      domainModel: read('.tmp/prototype-domain-model.json', true),
      executionContract: read('.tmp/mobile-plan-execution-contract.json', true),
      serviceSurface: read('.tmp/generated-service-surface.json', true),
      dataverseSchema: read('.tmp/dataverse-schema-contract.json', true),
      contextContract: read('.tmp/context-enrichment-contract.json', true),
      workflowJourney: read('.tmp/workflow-journey-contract.json', true),
      phase: args.phase,
    });
    if (!result.valid) throw new Error(result.errors.join('; '));
    process.stdout.write(`Screen action contract valid: ${contract.actions.length} action(s)\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`validate-screen-action-contract: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main, parseArgs, screenEntries, validateScreenActionContract };
