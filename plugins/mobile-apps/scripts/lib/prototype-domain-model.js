'use strict';

const crypto = require('node:crypto');

const DOMAIN_TYPES = new Set([
  'id', 'text', 'multiline-text', 'boolean', 'whole-number', 'decimal', 'money',
  'date', 'date-time', 'choice', 'multi-choice', 'reference', 'image', 'file',
  'url', 'email', 'phone',
]);
const RESERVED_DATAVERSE_KEYS = new Set([
  'adaptedLogicalName', 'adaptedSchemaName', 'alternateKeys', 'attributeType',
  'cascadeConfiguration', 'entitySetName', 'executionEligible', 'logicalName',
  'metadataId', 'ownershipType', 'plannedDecision', 'publisherPrefix',
  'requiredLevel', 'schemaName', 'serviceRequired',
]);
const ISO_CURRENCY = /^[A-Z]{3}$/;
const GENERIC_NAME = /^(?:product|category|item|record|row|sample|test|example)\s*#?\d+$/i;

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

function exactKeys(value, allowed, required, label, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  const actual = Object.keys(value);
  const missing = required.filter((key) => !actual.includes(key));
  const unknown = actual.filter((key) => !allowed.includes(key));
  if (missing.length) errors.push(`${label} is missing keys: ${missing.join(', ')}`);
  if (unknown.length) errors.push(`${label} has unknown keys: ${unknown.join(', ')}`);
}

function unique(items, key, label, errors) {
  const seen = new Set();
  for (const item of items) {
    const value = item?.[key];
    if (!value) continue;
    if (seen.has(value)) errors.push(`${label} contains duplicate ${value}`);
    seen.add(value);
  }
}

function findReservedMetadata(value, path = 'domainModel', findings = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findReservedMetadata(item, `${path}[${index}]`, findings));
    return findings;
  }
  if (!value || typeof value !== 'object') return findings;
  for (const [key, child] of Object.entries(value)) {
    if (RESERVED_DATAVERSE_KEYS.has(key)) findings.push(`${path}.${key}`);
    findReservedMetadata(child, `${path}.${key}`, findings);
  }
  return findings;
}

function validateFieldValue(field, value, choices, entities, label, errors) {
  if (value === null || value === undefined) {
    if (field.required) errors.push(`${label} is required`);
    return;
  }
  if (field.type === 'id' && (typeof value !== 'string' || !value.trim())) errors.push(`${label} must be a non-empty opaque string ID`);
  if (['text', 'multiline-text', 'url', 'email', 'phone', 'date', 'date-time'].includes(field.type) && typeof value !== 'string') errors.push(`${label} must be a string`);
  if (field.type === 'boolean' && typeof value !== 'boolean') errors.push(`${label} must be boolean`);
  if (['whole-number', 'decimal'].includes(field.type) && (typeof value !== 'number' || !Number.isFinite(value))) errors.push(`${label} must be numeric`);
  if (field.type === 'whole-number' && !Number.isInteger(value)) errors.push(`${label} must be an integer`);
  if (typeof value === 'number') {
    if (field.minimum !== undefined && value < field.minimum) errors.push(`${label} is below minimum ${field.minimum}`);
    if (field.maximum !== undefined && value > field.maximum) errors.push(`${label} is above maximum ${field.maximum}`);
  }
  if (field.type === 'money') {
    if (!value || typeof value !== 'object' || typeof value.amount !== 'number' || !Number.isFinite(value.amount) || !ISO_CURRENCY.test(String(value.currencyCode || ''))) errors.push(`${label} must be { amount, currencyCode } with an ISO currency code`);
  }
  if (field.type === 'choice') {
    const choice = choices.get(field.choiceKey);
    if (!choice?.has(value)) errors.push(`${label} uses invalid choice key ${value}`);
  }
  if (field.type === 'multi-choice') {
    const choice = choices.get(field.choiceKey);
    if (!Array.isArray(value) || value.some((item) => !choice?.has(item))) errors.push(`${label} contains an invalid multi-choice key`);
  }
  if (field.type === 'reference' && typeof value !== 'string') errors.push(`${label} must contain a referenced opaque ID`);
  if (field.type === 'image') {
    if (!value || typeof value !== 'object' || typeof value.imageAltText !== 'string' || !value.imageAltText.trim() || typeof value.imageAssetKey !== 'string' || !value.imageAssetKey.trim()) errors.push(`${label} must contain imageAltText and imageAssetKey`);
    if (value?.imageUrl !== undefined && (typeof value.imageUrl !== 'string' || !/^https:\/\//i.test(value.imageUrl))) errors.push(`${label}.imageUrl must be HTTPS when supplied`);
  }
  if (field.type === 'file') {
    if (!value || typeof value !== 'object' || typeof value.fileName !== 'string' || !value.fileName.trim() || typeof value.mimeType !== 'string' || !value.mimeType.trim()) errors.push(`${label} must contain fileName and mimeType`);
    if (value?.localUri !== undefined && typeof value.localUri !== 'string') errors.push(`${label}.localUri must be a string when supplied`);
  }
  if (field.type === 'reference' && !entities.has(field.referenceTarget)) errors.push(`${label} references unknown target ${field.referenceTarget}`);
}

function validatePrototypeDomainModel(model) {
  const errors = [];
  const rootKeys = ['schemaVersion', 'mode', 'entities', 'relationships', 'choices', 'operations', 'actors', 'uxPermissions', 'offlineUxIntent', 'fixtures', 'fixtureScenarios'];
  exactKeys(model, rootKeys, rootKeys, 'domainModel', errors);
  if (model?.schemaVersion !== 1) errors.push('domainModel.schemaVersion must be 1');
  if (model?.mode !== 'prototype-domain') errors.push('domainModel.mode must be prototype-domain');
  for (const finding of findReservedMetadata(model)) errors.push(`${finding} is Dataverse-specific and forbidden in prototype-domain mode`);

  const entities = Array.isArray(model?.entities) ? model.entities : [];
  const relationships = Array.isArray(model?.relationships) ? model.relationships : [];
  const choices = Array.isArray(model?.choices) ? model.choices : [];
  const operations = Array.isArray(model?.operations) ? model.operations : [];
  const actors = Array.isArray(model?.actors) ? model.actors : [];
  if (!entities.length) errors.push('domainModel.entities must be non-empty');
  if (!operations.length) errors.push('domainModel.operations must be non-empty');
  unique(entities, 'key', 'domainModel.entities', errors);
  unique(relationships, 'key', 'domainModel.relationships', errors);
  unique(choices, 'key', 'domainModel.choices', errors);
  unique(operations, 'key', 'domainModel.operations', errors);
  unique(operations, 'hook', 'domainModel.operations hooks', errors);
  unique(actors, 'key', 'domainModel.actors', errors);
  const repositoryMethods = new Set();
  for (const operation of operations) {
    const identity = `${operation.repository}.${operation.method}`;
    if (repositoryMethods.has(identity)) errors.push(`domainModel.operations contains duplicate repository method ${identity}`);
    repositoryMethods.add(identity);
  }

  const entityMap = new Map(entities.map((entity) => [entity.key, entity]));
  const choiceMap = new Map(choices.map((choice) => [choice.key, new Set((Array.isArray(choice.options) ? choice.options : []).map((option) => option.key))]));
  const operationMap = new Map(operations.map((operation) => [operation.key, operation]));
  for (const [choiceIndex, choice] of choices.entries()) {
    const label = `domainModel.choices[${choiceIndex}]`;
    exactKeys(choice, ['key', 'options'], ['key', 'options'], label, errors);
    if (!Array.isArray(choice?.options) || choice.options.length < 2) errors.push(`${label}.options must contain at least two values`);
    const options = Array.isArray(choice?.options) ? choice.options : [];
    unique(options, 'key', `${label}.options`, errors);
    for (const [optionIndex, option] of options.entries()) exactKeys(option, ['key', 'label'], ['key', 'label'], `${label}.options[${optionIndex}]`, errors);
  }
  for (const [entityIndex, entity] of entities.entries()) {
    const label = `domainModel.entities[${entityIndex}]`;
    const allowed = ['key', 'displayName', 'displayPluralName', 'description', 'primaryNameField', 'estimatedPrototypeRows', 'fields'];
    exactKeys(entity, allowed, allowed, label, errors);
    if (!/^[A-Z][A-Za-z0-9]*$/.test(String(entity?.key || '')) || /^cr/i.test(entity?.key || '')) errors.push(`${label}.key must be a neutral PascalCase key`);
    const fields = Array.isArray(entity?.fields) ? entity.fields : [];
    if (!Array.isArray(entity?.fields)) errors.push(`${label}.fields must be an array`);
    unique(fields, 'key', `${label}.fields`, errors);
    const fieldMap = new Map(fields.map((field) => [field.key, field]));
    const idFields = fields.filter((field) => field.type === 'id');
    if (idFields.length !== 1) errors.push(`${label} requires exactly one id field`);
    if (!fieldMap.has(entity.primaryNameField)) errors.push(`${label}.primaryNameField does not exist`);
    for (const [fieldIndex, field] of fields.entries()) {
      const fieldLabel = `${label}.fields[${fieldIndex}]`;
      const allowedField = ['key', 'displayName', 'type', 'required', 'maximumLength', 'minimum', 'maximum', 'precision', 'choiceKey', 'referenceTarget', 'mediaIntent', 'dateSemantics'];
      exactKeys(field, allowedField, ['key', 'displayName', 'type', 'required'], fieldLabel, errors);
      if (!DOMAIN_TYPES.has(field.type)) errors.push(`${fieldLabel}.type is invalid`);
      if (['choice', 'multi-choice'].includes(field.type) && !choiceMap.has(field.choiceKey)) errors.push(`${fieldLabel}.choiceKey does not exist`);
      if (field.type === 'reference' && !entityMap.has(field.referenceTarget)) errors.push(`${fieldLabel}.referenceTarget does not exist`);
      if (field.minimum !== undefined && field.maximum !== undefined && field.minimum > field.maximum) errors.push(`${fieldLabel}.minimum exceeds maximum`);
    }
  }

  for (const [relationshipIndex, relationship] of relationships.entries()) {
    exactKeys(relationship, ['key', 'parent', 'child', 'cardinality', 'childField', 'required'], ['key', 'parent', 'child', 'cardinality', 'childField', 'required'], `domainModel.relationships[${relationshipIndex}]`, errors);
    const parent = entityMap.get(relationship.parent);
    const child = entityMap.get(relationship.child);
    if (!parent || !child) errors.push(`relationship ${relationship.key} references an unknown entity`);
    const childField = (Array.isArray(child?.fields) ? child.fields : []).find((field) => field.key === relationship.childField);
    if (!childField || childField.type !== 'reference' || childField.referenceTarget !== relationship.parent) errors.push(`relationship ${relationship.key} childField must be a reference to ${relationship.parent}`);
  }

  for (const [operationIndex, operation] of operations.entries()) {
    const operationLabel = `domainModel.operations[${operationIndex}]`;
    exactKeys(operation, ['key', 'entity', 'kind', 'repository', 'method', 'hook', 'selectFields', 'filterFields', 'sortFields', 'writeFields', 'pagination'], ['key', 'entity', 'kind', 'repository', 'method', 'hook', 'selectFields', 'filterFields', 'sortFields', 'pagination'], operationLabel, errors);
    if (!['list', 'get', 'create', 'update', 'delete'].includes(operation.kind)) errors.push(`${operationLabel}.kind is invalid`);
    if (!/^[A-Z][A-Za-z0-9]*Repository$/.test(String(operation.repository || ''))) errors.push(`${operationLabel}.repository is invalid`);
    if (!/^use[A-Z][A-Za-z0-9]*$/.test(String(operation.hook || ''))) errors.push(`${operationLabel}.hook is invalid`);
    exactKeys(operation.pagination, ['mode', 'pageSize', 'maximumExpectedCount', 'boundedReason'], ['mode'], `${operationLabel}.pagination`, errors);
    const entity = entityMap.get(operation.entity);
    if (!entity) {
      errors.push(`operation ${operation.key} references unknown entity ${operation.entity}`);
      continue;
    }
    const fields = new Set((Array.isArray(entity.fields) ? entity.fields : []).map((field) => field.key));
    const operationFieldLists = ['selectFields', 'filterFields', 'sortFields', 'writeFields'];
    for (const fieldList of operationFieldLists) {
      if (operation[fieldList] !== undefined && !Array.isArray(operation[fieldList])) errors.push(`${operationLabel}.${fieldList} must be an array`);
    }
    const operationFields = operationFieldLists.flatMap((fieldList) => Array.isArray(operation[fieldList]) ? operation[fieldList] : []);
    for (const field of operationFields) {
      if (!fields.has(field)) errors.push(`operation ${operation.key} references unknown field ${field}`);
    }
    if (['list', 'get'].includes(operation.kind) && !(operation.selectFields || []).length) errors.push(`operation ${operation.key} requires selectFields`);
    if (['create', 'update'].includes(operation.kind) && !(operation.writeFields || []).length) errors.push(`operation ${operation.key} requires writeFields`);
    if (operation.kind === 'list') {
      const pagination = operation.pagination || {};
      if (!['bounded', 'cursor'].includes(pagination.mode)) errors.push(`list operation ${operation.key} requires bounded or cursor pagination`);
      if (pagination.mode === 'bounded' && (!pagination.boundedReason || !Number.isInteger(pagination.maximumExpectedCount))) errors.push(`bounded operation ${operation.key} requires boundedReason and maximumExpectedCount`);
      if (pagination.mode === 'cursor' && !Number.isInteger(pagination.pageSize)) errors.push(`cursor operation ${operation.key} requires pageSize`);
    }
  }

  for (const [actorIndex, actor] of actors.entries()) exactKeys(actor, ['key', 'displayName'], ['key', 'displayName'], `domainModel.actors[${actorIndex}]`, errors);
  const permissions = Array.isArray(model?.uxPermissions) ? model.uxPermissions : [];
  if (!Array.isArray(model?.uxPermissions)) errors.push('domainModel.uxPermissions must be an array');
  for (const [permissionIndex, permission] of permissions.entries()) {
    exactKeys(permission, ['actor', 'operation', 'allowed'], ['actor', 'operation', 'allowed'], `domainModel.uxPermissions[${permissionIndex}]`, errors);
    if (!actors.some((actor) => actor.key === permission.actor)) errors.push(`permission references unknown actor ${permission.actor}`);
    if (!operationMap.has(permission.operation)) errors.push(`permission references unknown operation ${permission.operation}`);
  }
  const offlineOperations = Array.isArray(model?.offlineUxIntent?.requiredOperations) ? model.offlineUxIntent.requiredOperations : [];
  if (!Array.isArray(model?.offlineUxIntent?.requiredOperations)) errors.push('domainModel.offlineUxIntent.requiredOperations must be an array');
  for (const key of offlineOperations) {
    if (!operationMap.has(key)) errors.push(`offlineUxIntent references unknown operation ${key}`);
  }
  exactKeys(model?.offlineUxIntent, ['connectivity', 'requiredOperations', 'notes'], ['connectivity', 'requiredOperations'], 'domainModel.offlineUxIntent', errors);

  const fixtures = model?.fixtures && typeof model.fixtures === 'object' && !Array.isArray(model.fixtures) ? model.fixtures : {};
  const allIds = new Map();
  for (const [entityKey, rows] of Object.entries(fixtures)) {
    const entity = entityMap.get(entityKey);
    if (!entity) {
      errors.push(`fixtures contains unknown entity ${entityKey}`);
      continue;
    }
    if (!Array.isArray(rows)) {
      errors.push(`fixtures.${entityKey} must be an array`);
      continue;
    }
    const entityFields = Array.isArray(entity.fields) ? entity.fields : [];
    const idField = entityFields.find((field) => field.type === 'id')?.key;
    for (const [rowIndex, row] of rows.entries()) {
      const rowLabel = `fixtures.${entityKey}[${rowIndex}]`;
      const id = row?.[idField];
      if (typeof id !== 'string' || !id.trim()) errors.push(`${rowLabel}.${idField} must be a stable opaque ID`);
      else if (allIds.has(id)) errors.push(`${rowLabel} duplicates ID ${id} from ${allIds.get(id)}`);
      else allIds.set(id, rowLabel);
      for (const field of entityFields) validateFieldValue(field, row?.[field.key], choiceMap, entityMap, `${rowLabel}.${field.key}`, errors);
      const name = row?.[entity.primaryNameField];
      if (typeof name === 'string' && GENERIC_NAME.test(name.trim())) errors.push(`${rowLabel}.${entity.primaryNameField} uses generic numbered copy`);
      for (const key of Object.keys(row || {})) {
        if (!entityFields.some((field) => field.key === key)) errors.push(`${rowLabel} contains unknown field ${key}`);
      }
    }
    if (rows.length !== entity.estimatedPrototypeRows) errors.push(`fixtures.${entityKey} row count does not match estimatedPrototypeRows`);
  }
  for (const entity of entities) {
    if (!Object.prototype.hasOwnProperty.call(fixtures, entity.key)) errors.push(`fixtures is missing entity ${entity.key}`);
  }
  for (const entity of entities) {
    const referenceFields = (Array.isArray(entity.fields) ? entity.fields : []).filter((field) => field.type === 'reference');
    for (const [rowIndex, row] of (fixtures[entity.key] || []).entries()) {
      for (const field of referenceFields) {
        const value = row[field.key];
        if (value !== null && value !== undefined && !allIds.has(value)) errors.push(`fixtures.${entity.key}[${rowIndex}].${field.key} references missing ID ${value}`);
      }
    }
  }
  const productRows = fixtures.Product || [];
  const inventoryById = new Map(productRows.map((row) => [row.id, row.inventoryQuantity]));
  for (const [index, item] of (fixtures.CartItem || []).entries()) {
    if (typeof item.quantity === 'number' && item.quantity < 0) errors.push(`fixtures.CartItem[${index}].quantity cannot be negative`);
    const inventory = inventoryById.get(item.productId);
    if (Number.isFinite(inventory) && item.quantity > inventory) errors.push(`fixtures.CartItem[${index}].quantity exceeds product inventory`);
  }

  const scenarios = Array.isArray(model?.fixtureScenarios) ? model.fixtureScenarios : [];
  unique(scenarios, 'key', 'domainModel.fixtureScenarios', errors);
  for (const requiredState of ['loading', 'empty', 'error', 'offline']) {
    if (!scenarios.some((scenario) => scenario.state === requiredState)) errors.push(`fixtureScenarios requires ${requiredState} state`);
  }
  for (const [scenarioIndex, scenario] of scenarios.entries()) {
    exactKeys(scenario, ['key', 'state', 'description', 'entity', 'recordIds'], ['key', 'state', 'description'], `domainModel.fixtureScenarios[${scenarioIndex}]`, errors);
    if (scenario.entity && !entityMap.has(scenario.entity)) errors.push(`fixture scenario ${scenario.key} references unknown entity ${scenario.entity}`);
    for (const id of scenario.recordIds || []) if (!allIds.has(id)) errors.push(`fixture scenario ${scenario.key} references missing ID ${id}`);
  }

  return { valid: errors.length === 0, errors };
}

function domainModelRevision(model) {
  return sha256(stableStringify(model));
}

module.exports = {
  DOMAIN_TYPES,
  domainModelRevision,
  stableStringify,
  validatePrototypeDomainModel,
};