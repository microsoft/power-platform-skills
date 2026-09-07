'use strict';

const { revision, assertRevision } = require('./prototype-files');
const { validateRules } = require('./authoring-rules');
const { validateRecord } = require('./prototype-repository-core');
const { isMediaAssetReference, projectSamplePhoto, validateScenarioImages } = require('./prototype-images');

const TYPES = new Set(['text', 'number', 'boolean', 'datetime', 'choice', 'lookup', 'photo']);
const OPERATIONS = new Set(['list', 'get', 'create', 'update', 'delete']);
const ID = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;
const RESERVED = new Set(['id', '__proto__', 'prototype', ...Object.getOwnPropertyNames(Object.prototype)]);
const TYPE_RESERVED = new Set([
  'EntityMap', 'EntityId', 'PhotoReference', 'SampleImageAsset', 'SampleImageBinding', 'SampleImageProvenance',
  'PrototypeImage', 'PrototypeImageProps', 'break', 'case', 'catch', 'class', 'const', 'continue',
  'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally',
  'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch',
  'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static',
  'implements', 'interface', 'package', 'private', 'protected', 'public', 'await',
  'string', 'number', 'boolean', 'unknown', 'never', 'any', 'object', 'undefined',
]);

function object(value, label, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  if (keys) for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`${label} has unsupported field ${key}`);
  }
  return value;
}

function identifier(value, label) {
  if (typeof value !== 'string' || !ID.test(value) || RESERVED.has(value)) {
    throw new Error(`${label} must be a conservative, non-reserved identifier`);
  }
  return value;
}

function entries(values, label, maximum = 100) {
  if (!Array.isArray(values) || values.length > maximum) throw new Error(`${label} must be a bounded array`);
  const ids = new Set();
  for (const value of values) {
    object(value, label);
    identifier(value.id, `${label}.id`);
    if (ids.has(value.id)) throw new Error(`Duplicate ${label} ID ${value.id}`);
    ids.add(value.id);
  }
  return new Map(values.map((value) => [value.id, value]));
}

function label(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error(`${name} must be bounded text`);
}

function validateDomain(domain) {
  object(domain, 'domain', ['schemaVersion', 'appInstanceId', 'schemaVersionNumber', 'entities', 'actions']);
  if (domain.schemaVersion !== 1 || !Number.isSafeInteger(domain.schemaVersionNumber) || domain.schemaVersionNumber < 1) {
    throw new Error('Domain requires schemaVersion 1 and a positive schemaVersionNumber');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(domain.appInstanceId || '')) {
    throw new Error('Domain requires a stable appInstanceId, never a Metro URL');
  }
  const entities = entries(domain.entities, 'entity', 50);
  for (const entity of entities.values()) {
    if (TYPE_RESERVED.has(entity.id)) throw new Error(`Entity ID ${entity.id} collides with a reserved generated/TypeScript type`);
    object(entity, 'entity', ['id', 'label', 'fields', 'operations']);
    label(entity.label, 'entity.label');
    const fields = entries(entity.fields, 'field');
    if (!fields.size) throw new Error(`${entity.id} has no fields`);
    for (const field of fields.values()) {
      object(field, 'field', ['id', 'label', 'type', 'required', 'options', 'targetEntityId']);
      label(field.label, 'field.label');
      if (!TYPES.has(field.type)) throw new Error(`Unsupported field type ${field.type}`);
      if (field.required !== undefined && typeof field.required !== 'boolean') throw new Error('required must be boolean');
      if (field.type === 'choice') {
        const options = entries(field.options, 'choice', 100);
        if (!options.size) throw new Error('Choice requires options');
        for (const option of options.values()) {
          object(option, 'choice', ['id', 'label']);
          label(option.label, 'choice.label');
        }
      } else if (field.options !== undefined) throw new Error('Only a choice may declare options');
      if (field.type === 'lookup') {
        if (!entities.has(field.targetEntityId)) throw new Error(`Unknown lookup target ${field.targetEntityId}`);
      } else if (field.targetEntityId !== undefined) throw new Error('Only a lookup may declare targetEntityId');
    }
    if (!Array.isArray(entity.operations) || !entity.operations.length
      || new Set(entity.operations).size !== entity.operations.length
      || entity.operations.some((operation) => !OPERATIONS.has(operation))) throw new Error('Invalid entity operations');
    if (entity.operations.includes('update') && !entity.operations.includes('get')) {
      throw new Error('Update requires get so validation can merge the current record');
    }
  }
  const actions = entries(domain.actions, 'action');
  for (const action of actions.values()) {
    object(action, 'action', ['id', 'label', 'entityId', 'operation']);
    label(action.label, 'action.label');
    const entity = entities.get(action.entityId);
    const operations = action.operation === 'save' ? ['create', 'update'] : [action.operation];
    if (!entity || operations.some((operation) => !['create', 'update', 'delete'].includes(operation)
      || !entity.operations.includes(operation))) throw new Error(`Action ${action.id} has no matching entity operation`);
  }
  return structuredClone(domain);
}

function validateBindings(domain, bindings, persistence) {
  object(bindings, 'bindings', ['schemaVersion', 'entities']);
  if (bindings.schemaVersion !== 1 || !Array.isArray(bindings.entities)) throw new Error('Invalid prototype bindings');
  const owners = new Map(persistence.conceptOwners.map((entry) => [entry.conceptId, entry]));
  const seenEntities = new Set();
  const seenConcepts = new Set();
  for (const binding of bindings.entities) {
    object(binding, 'binding', ['entityId', 'conceptId']);
    if (!domain.entities.some((entity) => entity.id === binding.entityId)
      || seenEntities.has(binding.entityId) || seenConcepts.has(binding.conceptId)) {
      throw new Error('Every domain entity must have exactly one unique concept binding');
    }
    const owner = owners.get(binding.conceptId);
    if (!owner || !['local', 'transient'].includes(owner.owner)) {
      throw new Error(`Prototype entity ${binding.entityId} must bind an approved local/transient concept`);
    }
    seenEntities.add(binding.entityId);
    seenConcepts.add(binding.conceptId);
  }
  if (seenEntities.size !== domain.entities.length) throw new Error('Prototype entity binding is missing');
  for (const owner of owners.values()) {
    if (owner.owner === 'local' && !seenConcepts.has(owner.conceptId)) {
      throw new Error(`Local concept ${owner.conceptId} has no repository`);
    }
  }
  return bindings;
}

function projectFixtures(domain, bindings, facts) {
  if (facts.contractType !== 'scenario-facts') throw new Error('Fixtures require the canonical scenario-facts contract');
  assertRevision(facts, 'scenarioRevision', 'Scenario facts');
  const mediaErrors = validateScenarioImages(facts.records, facts.mediaAssets);
  if (mediaErrors.length) throw new Error(`Canonical scenario images: ${mediaErrors[0].message}`);
  const mediaAssets = new Map(facts.mediaAssets.map((asset) => [asset.key, asset]));
  const byConcept = new Map(bindings.entities.map((binding) => [binding.conceptId, binding.entityId]));
  const entities = Object.fromEntries(domain.entities.map((entity) => [entity.id, []]));
  for (const fact of facts.records) {
    const entityId = byConcept.get(fact.conceptId);
    if (!entityId) continue; // Presentation facts stay in the canonical screen projection.
    const entity = domain.entities.find((entry) => entry.id === entityId);
    const record = { ...structuredClone(fact.fields), id: fact.id };
    for (const [field, value] of Object.entries(record)) {
      if (!isMediaAssetReference(value)) continue;
      if (!entity.fields.some((entry) => entry.id === field && entry.type === 'photo')) {
        throw new Error(`Canonical image binding ${fact.conceptId}/${fact.id}/${field} must target an exact photo field`);
      }
      record[field] = projectSamplePhoto(mediaAssets.get(value.mediaAssetKey), { recordId: fact.id, conceptId: fact.conceptId, field });
    }
    validateRecord(entity, record);
    if (entities[entityId].some((entry) => entry.id === record.id)) throw new Error(`Duplicate fixture ID ${record.id}`);
    entities[entityId].push(record);
  }
  for (const entity of domain.entities) for (const record of entities[entity.id]) {
    for (const field of entity.fields.filter((entry) => entry.type === 'lookup')) {
      if (record[field.id] && !entities[field.targetEntityId].some((entry) => entry.id === record[field.id])) {
        throw new Error(`Fixture lookup ${entity.id}.${field.id} has no canonical target`);
      }
    }
  }
  return { schemaVersion: 1, scenarioRevision: facts.scenarioRevision, entities };
}

function compilePrototype(domainInput, bindings, source, rules = { schemaVersion: 1, rules: [] }) {
  const domain = validateDomain(domainInput);
  if (source.persistence.mode !== 'local-prototype') throw new Error('Explicit prototype creation requires local-prototype persistence');
  assertRevision(source.persistence, 'persistenceRevision', 'Persistence contract');
  validateBindings(domain, bindings, source.persistence);
  if (source.facts.persistenceRevision !== source.persistence.persistenceRevision
    || source.facts.scopeRevision !== source.persistence.scopeRevision) {
    throw new Error('Canonical scenario facts do not match current persistence/scope');
  }
  const fixtures = projectFixtures(domain, bindings, source.facts);
  const validatedRules = validateRules(domain, rules);
  return {
    domain, bindings, rules: validatedRules, fixtures,
    inputRevisions: {
      domain: revision(domain), bindings: revision(bindings), rules: revision(validatedRules),
      persistence: source.persistence.persistenceRevision, scenario: source.facts.scenarioRevision,
    },
  };
}

module.exports = { validateDomain, validateBindings, validateRecord, projectFixtures, compilePrototype, identifier };
