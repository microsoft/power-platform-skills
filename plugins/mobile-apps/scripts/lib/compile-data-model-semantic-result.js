'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  normalizedContract,
  sha256,
  stableJson,
  validateContract,
} = require('../build-dataverse-operation-manifest');
const {
  lexicalCompare,
  materializeEnvelopeSet,
  sealWorkOrder,
} = require('./agent-return-envelope');
const { validateJsonSchema } = require('./json-schema-lite');

const SCHEMA_VERSION = 1;
const RESULT_TYPE = 'data-model-semantic-v1';
const SCHEMA_PATH = path.join(__dirname, '..', 'schema-data-model-semantic-result.json');
const DECISION_MAP = new Map([
  ['reuse', 'reuse'],
  ['extend', 'extend'],
  ['new', 'create'],
  ['adapt', 'adapt'],
  ['defer', 'defer'],
  ['unverified', 'unverified'],
]);
const TYPE_MAP = new Map([
  ['text', 'string'],
  ['long-text', 'memo'],
  ['whole-number', 'integer'],
  ['big-integer', 'bigint'],
  ['decimal', 'decimal'],
  ['floating-point', 'double'],
  ['currency', 'money'],
  ['date', 'date'],
  ['date-time', 'datetime'],
  ['boolean', 'boolean'],
  ['choice', 'choice'],
  ['multi-choice', 'multiselectchoice'],
  ['image', 'image'],
  ['file', 'file'],
]);

let schemaCache;

function schema() {
  if (!schemaCache) schemaCache = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  return schemaCache;
}

function semanticToken(value) {
  const token = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/^[^:]*:/, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!token) throw new Error(`cannot derive a mechanical name from ${value}`);
  return /^[a-z]/.test(token) ? token : `x_${token}`;
}

function boundedLogicalName(prefix, source, suffix = '') {
  const token = `${semanticToken(source)}${suffix}`;
  const candidate = `${prefix}_${token}`;
  if (candidate.length <= 63) return candidate;
  const digest = sha256(candidate).slice(0, 8);
  return `${candidate.slice(0, 54)}_${digest}`;
}

function normalizedDecision(value) {
  return DECISION_MAP.get(String(value || '').toLowerCase());
}

function stableSort(values, key) {
  return [...values].sort((left, right) => lexicalCompare(String(key(left)), String(key(right))));
}

function trimValue(value) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(trimValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, trimValue(child)]));
}

function normalizeSemanticResult(value) {
  const result = trimValue(structuredClone(value));
  const validation = validateSemanticResult(result);
  if (!validation.valid) {
    throw new Error(`Invalid semantic data model: ${validation.errors.join('; ')}`);
  }
  result.requirements = stableSort(result.requirements.map((requirement) => ({
    ...requirement,
    coveredBy: [...requirement.coveredBy].sort(lexicalCompare),
  })), (requirement) => requirement.requirementId);
  result.entities = stableSort(result.entities.map((entity) => ({
    ...entity,
    owningRequirementIds: [...(entity.owningRequirementIds || [])].sort(lexicalCompare),
    fields: stableSort(entity.fields.map((field) => ({
      ...field,
      options: field.options
        ? [...field.options].sort((left, right) => left.order - right.order
          || lexicalCompare(left.optionId, right.optionId))
        : undefined,
    })), (field) => field.fieldId),
  })), (entity) => entity.entityId);
  result.relationships = stableSort(result.relationships, (relationship) => relationship.relationshipId);
  result.operations = stableSort(result.operations.map((operation) => ({
    ...operation,
    inputIntent: [...operation.inputIntent].sort(lexicalCompare),
    selectFieldIds: [...operation.selectFieldIds].sort(lexicalCompare),
    filterIntent: stableSort(operation.filterIntent, (filter) => `${filter.fieldId}:${filter.operator}:${filter.input}`),
    sortIntent: [...operation.sortIntent].sort((left, right) => left.order - right.order
      || lexicalCompare(left.fieldId, right.fieldId)),
    mutationFieldIds: [...operation.mutationFieldIds].sort(lexicalCompare),
  })), (operation) => operation.operationId);
  result.fixtureScenarios = stableSort(result.fixtureScenarios.map((fixture) => ({
    ...fixture,
    entityIds: [...fixture.entityIds].sort(lexicalCompare),
    requirementIds: [...fixture.requirementIds].sort(lexicalCompare),
  })), (fixture) => fixture.scenarioId);
  for (const field of ['assumptions', 'risks', 'concerns']) {
    result[field] = [...result[field]].sort(lexicalCompare);
  }
  return JSON.parse(JSON.stringify(result));
}

function validateSemanticResult(value) {
  const errors = validateJsonSchema(value, schema());
  if (errors.length > 0) return { valid: false, errors };

  const allIds = new Map();
  const entities = new Map();
  const fields = new Map();
  const requirements = new Set(value.requirements.map((item) => item.requirementId));
  const register = (id, kind) => {
    if (allIds.has(id)) errors.push(`${id} is duplicated as ${kind} and ${allIds.get(id)}`);
    else allIds.set(id, kind);
  };
  value.requirements.forEach((item) => register(item.requirementId, 'requirement'));
  for (const entity of value.entities) {
    register(entity.entityId, 'entity');
    entities.set(entity.entityId, entity);
    const ownFields = new Set();
    for (const field of entity.fields) {
      register(field.fieldId, 'field');
      if (ownFields.has(field.fieldId)) errors.push(`${entity.entityId} duplicates ${field.fieldId}`);
      ownFields.add(field.fieldId);
      fields.set(field.fieldId, entity.entityId);
      if (['reuse', 'adapt', 'unverified'].includes(field.decision)
        && !field.existingLogicalName) {
        errors.push(`${field.fieldId} ${field.decision} requires existingLogicalName`);
      }
      if (field.uniqueIntent && !field.uniqueDecision) {
        errors.push(`${field.fieldId} uniqueIntent requires uniqueDecision`);
      }
      if (!field.uniqueIntent && field.uniqueDecision) {
        errors.push(`${field.fieldId} uniqueDecision requires uniqueIntent`);
      }
      const choice = ['choice', 'multi-choice', 'boolean'].includes(field.typeIntent);
      if (choice && (!field.options || field.options.length === 0)) {
        errors.push(`${field.fieldId} ${field.typeIntent} requires options`);
      }
      if (!choice && field.options) errors.push(`${field.fieldId} options require a choice type`);
      if (field.options) {
        const orders = field.options.map((option) => option.order);
        if (new Set(orders).size !== orders.length) {
          errors.push(`${field.fieldId} choice option order values must be unique`);
        }
        if (field.typeIntent === 'boolean' && field.options.length !== 2) {
          errors.push(`${field.fieldId} Boolean semantics require exactly two options`);
        }
      }
    }
    const primary = entity.fields.find((field) => field.fieldId === entity.primaryDisplayField);
    if (!primary) errors.push(`${entity.entityId} primaryDisplayField is not one of its fields`);
    else if (primary.typeIntent !== 'text') {
      errors.push(`${entity.entityId} primaryDisplayField must use text typeIntent`);
    } else if (['defer', 'unverified'].includes(primary.decision)) {
      errors.push(`${entity.entityId} primaryDisplayField cannot be ${primary.decision}`);
    }
    if (['reuse', 'extend', 'adapt', 'unverified'].includes(entity.decision)
      && !entity.existingLogicalName) {
      errors.push(`${entity.entityId} ${entity.decision} requires existingLogicalName`);
    }
    if (entity.decision === 'reuse'
      && entity.fields.some((field) => ['new', 'adapt'].includes(field.decision))) {
      errors.push(`${entity.entityId} reuse cannot add or adapt fields`);
    }
    if (['new', 'adapt'].includes(entity.decision)
      && entity.fields.some((field) => field.decision === 'reuse')) {
      errors.push(`${entity.entityId} ${entity.decision} cannot reuse fields on its new target`);
    }
    for (const requirementId of entity.owningRequirementIds || []) {
      if (!requirements.has(requirementId)) {
        errors.push(`${entity.entityId} references unknown requirement ${requirementId}`);
      }
    }
  }
  if (value.mode === 'dataverse-required' && value.entities.length === 0) {
    errors.push('dataverse-required mode requires at least one semantic entity');
  }

  for (const relationship of value.relationships) {
    register(relationship.relationshipId, 'relationship');
    if (!entities.has(relationship.fromEntityId)) {
      errors.push(`${relationship.relationshipId} has unknown fromEntityId ${relationship.fromEntityId}`);
    }
    if (!entities.has(relationship.toEntityId)) {
      errors.push(`${relationship.relationshipId} has unknown toEntityId ${relationship.toEntityId}`);
    }
    if (['reuse', 'adapt', 'unverified'].includes(relationship.decision)
      && !relationship.existingSchemaName) {
      errors.push(`${relationship.relationshipId} ${relationship.decision} requires existingSchemaName`);
    }
    if (relationship.cardinalityIntent !== 'many-to-many'
      && ['reuse', 'adapt', 'unverified'].includes(relationship.decision)
      && !relationship.existingLookupLogicalName) {
      errors.push(`${relationship.relationshipId} ${relationship.decision} requires existingLookupLogicalName`);
    }
    if (relationship.cardinalityIntent === 'many-to-many'
      && ['reuse', 'adapt', 'unverified'].includes(relationship.decision)
      && !relationship.existingIntersectTable) {
      errors.push(`${relationship.relationshipId} ${relationship.decision} requires existingIntersectTable`);
    }
  }

  for (const operation of value.operations) {
    register(operation.operationId, 'operation');
    if (!entities.has(operation.entityId)) {
      errors.push(`${operation.operationId} references unknown entity ${operation.entityId}`);
      continue;
    }
    const operationFields = [
      ...operation.selectFieldIds,
      ...operation.mutationFieldIds,
      ...operation.filterIntent.map((filter) => filter.fieldId),
      ...operation.sortIntent.map((sort) => sort.fieldId),
    ];
    for (const fieldId of operationFields) {
      if (!fields.has(fieldId)) errors.push(`${operation.operationId} references unknown field ${fieldId}`);
      else if (fields.get(fieldId) !== operation.entityId) {
        errors.push(`${operation.operationId} field ${fieldId} belongs to another entity`);
      }
    }
    for (const filter of operation.filterIntent) {
      if (!operation.inputIntent.includes(filter.input)) {
        errors.push(`${operation.operationId} filter input ${filter.input} is undeclared`);
      }
    }
    const sortOrders = operation.sortIntent.map((sort) => sort.order);
    if (new Set(sortOrders).size !== sortOrders.length) {
      errors.push(`${operation.operationId} sort order values must be unique`);
    }
  }

  for (const fixture of value.fixtureScenarios) {
    register(fixture.scenarioId, 'scenario');
    fixture.entityIds.forEach((entityId) => {
      if (!entities.has(entityId)) errors.push(`${fixture.scenarioId} references unknown entity ${entityId}`);
    });
    fixture.requirementIds.forEach((requirementId) => {
      if (!requirements.has(requirementId)) {
        errors.push(`${fixture.scenarioId} references unknown requirement ${requirementId}`);
      }
    });
  }

  for (const requirement of value.requirements) {
    for (const coveredBy of requirement.coveredBy) {
      if (!allIds.has(coveredBy)) {
        errors.push(`${requirement.requirementId} is covered by unknown semantic ID ${coveredBy}`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

function entityIdentities(semantic, publisherPrefix) {
  const identities = new Map();
  for (const entity of semantic.entities) {
    const decision = normalizedDecision(entity.decision);
    const existing = entity.existingLogicalName;
    const generated = entity.approvedLogicalName
      || boundedLogicalName(publisherPrefix, entity.entityId);
    const logicalName = ['reuse', 'extend', 'adapt', 'unverified'].includes(decision)
      ? existing
      : generated;
    identities.set(entity.entityId, {
      logicalName,
      schemaName: logicalName,
      effectiveLogicalName: decision === 'adapt' ? generated : logicalName,
      adaptedLogicalName: decision === 'adapt' ? generated : null,
      adaptedSchemaName: decision === 'adapt' ? generated : null,
    });
  }
  return identities;
}

function fieldIdentity(field, publisherPrefix) {
  const decision = normalizedDecision(field.decision);
  const generated = field.approvedLogicalName
    || boundedLogicalName(publisherPrefix, field.fieldId);
  const logicalName = ['reuse', 'adapt', 'unverified'].includes(decision)
    ? field.existingLogicalName
    : generated;
  return {
    logicalName,
    schemaName: logicalName,
    adaptedLogicalName: decision === 'adapt' ? generated : undefined,
    adaptedSchemaName: decision === 'adapt' ? generated : undefined,
  };
}

function contractOptions(field) {
  if (!field.options) return undefined;
  return field.options.map((option, index) => ({
    value: field.typeIntent === 'boolean' ? index : 100000000 + index,
    label: option.label,
  }));
}

function columnFromField(field, entity, publisherPrefix) {
  const identity = fieldIdentity(field, publisherPrefix);
  const validation = field.validation || {};
  return JSON.parse(JSON.stringify({
    ...identity,
    displayName: field.displayName,
    description: field.purpose,
    type: TYPE_MAP.get(field.typeIntent),
    plannedDecision: normalizedDecision(field.decision),
    requiredLevel: field.required ? 'ApplicationRequired' : 'None',
    primaryName: entity.primaryDisplayField === field.fieldId,
    options: contractOptions(field),
    maxLength: validation.maxLength,
    minValue: validation.minValue,
    maxValue: validation.maxValue,
    precision: validation.precision,
    format: validation.format,
    behavior: validation.dateTimeBehavior,
    maxSizeInKB: validation.maxSizeInKB,
    maxWidth: validation.maxWidth,
    maxHeight: validation.maxHeight,
    semanticFieldId: field.fieldId,
    purpose: field.purpose,
  }));
}

function dependencyTiers(semantic) {
  const outgoing = new Map(semantic.entities.map((entity) => [entity.entityId, []]));
  const indegree = new Map(semantic.entities.map((entity) => [entity.entityId, 0]));
  for (const relationship of semantic.relationships) {
    if (relationship.decision === 'defer' || relationship.cardinalityIntent === 'many-to-many') continue;
    const parent = relationship.cardinalityIntent === 'many-to-one'
      ? relationship.toEntityId
      : relationship.fromEntityId;
    const child = relationship.cardinalityIntent === 'many-to-one'
      ? relationship.fromEntityId
      : relationship.toEntityId;
    outgoing.get(parent).push(child);
    indegree.set(child, indegree.get(child) + 1);
  }
  const queue = [...indegree.entries()].filter(([, count]) => count === 0)
    .map(([entityId]) => entityId).sort(lexicalCompare);
  const tiers = new Map(semantic.entities.map((entity) => [entity.entityId, 0]));
  let visited = 0;
  while (queue.length > 0) {
    const current = queue.shift();
    visited += 1;
    for (const child of outgoing.get(current).sort(lexicalCompare)) {
      tiers.set(child, Math.max(tiers.get(child), tiers.get(current) + 1));
      indegree.set(child, indegree.get(child) - 1);
      if (indegree.get(child) === 0) {
        queue.push(child);
        queue.sort(lexicalCompare);
      }
    }
  }
  if (visited !== semantic.entities.length) {
    throw new Error('semantic relationships contain a dependency cycle');
  }
  return tiers;
}

function compileContract(semantic, publisherPrefix) {
  if (semantic.mode !== 'dataverse-required') return null;
  if (!/^[a-z][a-z0-9]*$/i.test(String(publisherPrefix || ''))) {
    throw new Error('publisherPrefix is required without an underscore for Dataverse mode');
  }
  const prefix = publisherPrefix.toLowerCase();
  const identities = entityIdentities(semantic, prefix);
  const tiers = dependencyTiers(semantic);
  const tables = semantic.entities.map((entity) => {
    const identity = identities.get(entity.entityId);
    return {
      logicalName: identity.logicalName,
      schemaName: identity.schemaName,
      ...(identity.adaptedLogicalName ? {
        adaptedLogicalName: identity.adaptedLogicalName,
        adaptedSchemaName: identity.adaptedSchemaName,
      } : {}),
      displayName: entity.displayName,
      displayCollectionName: entity.pluralDisplayName,
      description: entity.purpose,
      plannedDecision: normalizedDecision(entity.decision),
      dependencyTier: tiers.get(entity.entityId),
      serviceRequired: entity.serviceRequired,
      ownershipType: entity.ownershipIntent === 'organization'
        ? 'OrganizationOwned'
        : 'UserOwned',
      hasActivities: Boolean(entity.behavior?.activities),
      hasNotes: Boolean(entity.behavior?.notes),
      isAvailableOffline: entity.behavior?.offlineAvailable !== false,
      changeTrackingEnabled: entity.behavior?.changeTracking !== false,
      scopeRole: entity.scopeRole,
      owningRequirements: entity.owningRequirementIds || [],
      lifecycleJustification: entity.lifecycle || entity.purpose,
      reason: entity.decisionRationale,
      targetEvidence: entity.targetEvidence,
      semanticEntityId: entity.entityId,
      columns: entity.fields.map((field) => columnFromField(field, entity, prefix)),
      relationships: [],
      alternateKeys: entity.fields.filter((field) => field.uniqueIntent).map((field) => {
        const column = fieldIdentity(field, prefix);
        const decision = normalizedDecision(field.uniqueDecision);
        const generated = boundedLogicalName(prefix, `${entity.entityId}-${field.fieldId}`, '_key');
        const schemaName = ['reuse', 'adapt', 'unverified'].includes(decision)
          ? field.existingKeySchemaName
          : generated;
        return JSON.parse(JSON.stringify({
          schemaName,
          displayName: `${field.displayName} key`,
          plannedDecision: decision,
          columns: [column.logicalName],
          adaptedSchemaName: decision === 'adapt' ? generated : undefined,
          semanticFieldId: field.fieldId,
        }));
      }),
    };
  });
  const tableByEntity = new Map(semantic.entities.map((entity, index) => [entity.entityId, tables[index]]));
  for (const relationship of semantic.relationships) {
    const from = tableByEntity.get(relationship.fromEntityId);
    const to = tableByEntity.get(relationship.toEntityId);
    const cardinality = relationship.cardinalityIntent;
    const child = cardinality === 'many-to-one' ? from : to;
    const parent = cardinality === 'many-to-one' ? to : from;
    const decision = normalizedDecision(relationship.decision);
    const generatedSchemaName = relationship.approvedSchemaName
      || boundedLogicalName(prefix, relationship.relationshipId);
    const schemaName = ['reuse', 'adapt', 'unverified'].includes(decision)
      ? relationship.existingSchemaName
      : generatedSchemaName;
    if (cardinality === 'many-to-many') {
      const generatedIntersect = relationship.approvedIntersectTable
        || boundedLogicalName(prefix, relationship.relationshipId, '_link');
      const intersectTable = ['reuse', 'adapt', 'unverified'].includes(decision)
        ? relationship.existingIntersectTable
        : generatedIntersect;
      from.relationships.push(JSON.parse(JSON.stringify({
        kind: 'many-to-many',
        schemaName,
        plannedDecision: decision,
        adaptedSchemaName: decision === 'adapt' ? generatedSchemaName : undefined,
        entity1: from.logicalName,
        entity2: to.logicalName,
        intersectTable,
        adaptedIntersectTable: decision === 'adapt' ? generatedIntersect : undefined,
        serviceRequired: Boolean(relationship.serviceRequired),
        reason: relationship.purpose,
        semanticRelationshipId: relationship.relationshipId,
      })));
      continue;
    }
    const generatedLookup = relationship.approvedLookupLogicalName
      || boundedLogicalName(prefix, `${relationship.toEntityId}-lookup`, 'id');
    const lookupName = ['reuse', 'adapt', 'unverified'].includes(decision)
      ? relationship.existingLookupLogicalName
      : generatedLookup;
    const requiredLevel = relationship.required ? 'ApplicationRequired' : 'None';
    if (child.columns.some((column) => column.logicalName === lookupName)) {
      throw new Error(`${relationship.relationshipId} lookup collides with field ${lookupName}`);
    }
    child.columns.push({
      logicalName: lookupName,
      schemaName: lookupName,
      displayName: parent.displayName,
      description: relationship.purpose,
      type: 'lookup',
      plannedDecision: decision,
      requiredLevel,
      lookupTarget: parent.logicalName,
      adaptedLogicalName: decision === 'adapt' ? generatedLookup : undefined,
      adaptedSchemaName: decision === 'adapt' ? generatedLookup : undefined,
      semanticRelationshipId: relationship.relationshipId,
    });
    child.relationships.push(JSON.parse(JSON.stringify({
      kind: 'many-to-one',
      schemaName,
      plannedDecision: decision,
      adaptedSchemaName: decision === 'adapt' ? generatedSchemaName : undefined,
      parentTable: parent.logicalName,
      childTable: child.logicalName,
      lookup: {
        logicalName: lookupName,
        schemaName: lookupName,
        displayName: parent.displayName,
        requiredLevel,
        adaptedLogicalName: decision === 'adapt' ? generatedLookup : undefined,
        adaptedSchemaName: decision === 'adapt' ? generatedLookup : undefined,
      },
      deleteBehavior: {
        'remove-link': 'RemoveLink',
        restrict: 'Restrict',
        cascade: 'Cascade',
      }[relationship.deleteBehaviorIntent],
      serviceRequired: Boolean(relationship.serviceRequired),
      reason: relationship.purpose,
      semanticRelationshipId: relationship.relationshipId,
    })));
  }
  const candidate = { schemaVersion: 1, publisherPrefix: prefix, tables };
  const validation = validateContract(candidate);
  if (!validation.valid) {
    throw new Error(`Compiled Dataverse contract is invalid: ${validation.errors.join('; ')}`);
  }
  return normalizedContract(candidate);
}

function tableCell(value) {
  return String(value ?? '—').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function listOrNone(values) {
  return values.length > 0 ? values.join(', ') : 'None.';
}

function renderMarkdown(semantic, contract, semanticResultHash, contractHash, snapshotHash) {
  const tableBySemanticId = new Map((contract?.tables || []).map((table) => [table.semanticEntityId, table]));
  const lines = [
    '## Data Model',
    '',
    '### Summary',
    `- **Product domain:** ${semantic.summary.productDomain}`,
    `- **Persistence mode:** ${semantic.mode}`,
    `- **Rationale:** ${semantic.summary.persistenceRationale}`,
    `- **Entities:** ${semantic.entities.length}`,
    `- **Relationships:** ${semantic.relationships.length}`,
    `- **Operations:** ${semantic.operations.length}`,
    '',
    '### Requirement Coverage',
    '| Requirement | Statement | Covered by |',
    '|---|---|---|',
    ...semantic.requirements.map((requirement) => (
      `| \`${tableCell(requirement.requirementId)}\` | ${tableCell(requirement.statement)} | ${requirement.coveredBy.map((id) => `\`${tableCell(id)}\``).join(', ')} |`
    )),
    '',
    '### Target Reconciliation',
    '| Entity | Purpose | Decision | Logical name | Ownership | Service required | Evidence |',
    '|---|---|---|---|---|---|---|',
    ...semantic.entities.map((entity) => {
      const table = tableBySemanticId.get(entity.entityId);
      const logicalName = table
        ? (table.adaptedLogicalName || table.logicalName)
        : 'not applicable';
      return `| ${tableCell(entity.displayName)} | ${tableCell(entity.purpose)} | ${tableCell(entity.decision)} | \`${tableCell(logicalName)}\` | ${tableCell(entity.ownershipIntent)} | ${entity.serviceRequired ? 'yes' : 'no'} | ${tableCell(entity.targetEvidence?.summary || 'Not supplied')} |`;
    }),
  ];
  for (const entity of semantic.entities) {
    const table = tableBySemanticId.get(entity.entityId);
    lines.push(
      '',
      `### ${entity.displayName} Fields`,
      '| Field | Purpose | Type intent | Required | Decision | Logical name | Choice semantics |',
      '|---|---|---|---|---|---|---|',
      ...entity.fields.map((field) => {
        const column = table?.columns.find((item) => item.semanticFieldId === field.fieldId);
        const choices = field.options?.map((option) => option.label).join(' → ') || '—';
        return `| ${tableCell(field.displayName)} | ${tableCell(field.purpose)} | ${field.typeIntent} | ${field.required ? 'yes' : 'no'} | ${field.decision} | \`${tableCell(column?.adaptedLogicalName || column?.logicalName || 'not applicable')}\` | ${tableCell(choices)} |`;
      }),
    );
  }
  lines.push(
    '',
    '### Relationships',
    '| Relationship | From | To | Cardinality | Required | Decision | Purpose |',
    '|---|---|---|---|---|---|---|',
    ...semantic.relationships.map((relationship) => `| \`${relationship.relationshipId}\` | \`${relationship.fromEntityId}\` | \`${relationship.toEntityId}\` | ${relationship.cardinalityIntent} | ${relationship.required ? 'yes' : 'no'} | ${relationship.decision} | ${tableCell(relationship.purpose)} |`),
    '',
    '### Domain Operations',
    '| Operation | Kind | Entity | Inputs | Selects | Filters | Pagination | Purpose |',
    '|---|---|---|---|---|---|---|---|',
    ...semantic.operations.map((operation) => `| \`${operation.operationId}\` | ${operation.kind} | \`${operation.entityId}\` | ${tableCell(listOrNone(operation.inputIntent))} | ${tableCell(listOrNone(operation.selectFieldIds))} | ${tableCell(listOrNone(operation.filterIntent.map((filter) => `${filter.fieldId} ${filter.operator} ${filter.input}`)))} | ${operation.paginationIntent} | ${tableCell(operation.purpose)} |`),
    '',
    '### Fixture Scenarios',
    '| Scenario | Purpose | Entities | Requirements |',
    '|---|---|---|---|',
    ...semantic.fixtureScenarios.map((fixture) => `| \`${fixture.scenarioId}\` | ${tableCell(fixture.purpose)} | ${tableCell(fixture.entityIds.join(', '))} | ${tableCell(listOrNone(fixture.requirementIds))} |`),
    '',
    '### ER Diagram',
    '```mermaid',
    'erDiagram',
  );
  for (const entity of semantic.entities) {
    const mermaidName = semanticToken(entity.entityId).toUpperCase();
    lines.push(`  ${mermaidName} {`);
    for (const field of entity.fields) {
      const marker = entity.primaryDisplayField === field.fieldId ? ' PK' : '';
      lines.push(`    ${TYPE_MAP.get(field.typeIntent) || field.typeIntent} ${semanticToken(field.fieldId)}${marker}`);
    }
    lines.push('  }');
  }
  for (const relationship of semantic.relationships) {
    const from = semanticToken(relationship.fromEntityId).toUpperCase();
    const to = semanticToken(relationship.toEntityId).toUpperCase();
    const edge = relationship.cardinalityIntent === 'many-to-many'
      ? '}o--o{'
      : relationship.cardinalityIntent === 'many-to-one' ? '}o--||' : '||--o{';
    lines.push(`  ${from} ${edge} ${to} : "${relationship.relationshipId.replaceAll('"', '')}"`);
  }
  lines.push('```');
  if (contract) {
    const tiers = new Map();
    contract.tables.forEach((table) => {
      if (!tiers.has(table.dependencyTier)) tiers.set(table.dependencyTier, []);
      tiers.get(table.dependencyTier).push(table.adaptedLogicalName || table.logicalName);
    });
    lines.push(
      '',
      '### Creation Order (for `/add-dataverse`)',
      '| Tier | Tables |',
      '|---|---|',
      ...[...tiers.entries()].sort(([left], [right]) => left - right)
        .map(([tier, names]) => `| ${tier} | ${names.sort(lexicalCompare).map((name) => `\`${name}\``).join(', ')} |`),
    );
  }
  lines.push(
    '',
    '### Assumptions',
    ...((semantic.assumptions.length ? semantic.assumptions : ['None.']).map((item) => `- ${item}`)),
    '',
    '### Risks and Concerns',
    ...(([...semantic.risks, ...semantic.concerns].length
      ? [...semantic.risks, ...semantic.concerns]
      : ['None.']).map((item) => `- ${item}`)),
    '',
    '### Provenance',
    `- Semantic result: \`${semanticResultHash}\``,
    `- Dataverse contract: ${contractHash ? `\`${contractHash}\`` : 'not applicable'}`,
    `- Dataverse snapshot: ${snapshotHash ? `\`${snapshotHash}\`` : 'not supplied'}`,
    '',
  );
  return lines.join('\n');
}

function validateCompilationReceipt(receipt, semantic, markdown, contract, snapshotHash) {
  const errors = [];
  const semanticHash = sha256(stableJson(semantic));
  const contractHash = contract ? sha256(stableJson(contract)) : null;
  if (receipt?.schemaVersion !== 1) errors.push('receipt schemaVersion must equal 1');
  if (receipt?.semanticResultHash !== semanticHash) errors.push('semanticResultHash mismatch');
  if (receipt?.markdownRenderedFrom !== semanticHash) errors.push('markdownRenderedFrom mismatch');
  if (receipt?.contractRenderedFrom !== semanticHash) errors.push('contractRenderedFrom mismatch');
  if (receipt?.markdownHash !== sha256(markdown)) errors.push('markdownHash mismatch');
  if (receipt?.contractHash !== contractHash) errors.push('contractHash mismatch');
  if ((receipt?.snapshotHash ?? null) !== (snapshotHash ?? null)) errors.push('snapshotHash mismatch');
  if (receipt?.validated !== true) errors.push('receipt must be validated');
  return { valid: errors.length === 0, errors };
}

function compileDataModelSemanticResult(value, {
  publisherPrefix = null,
  snapshotHash = null,
  productScopeRevision = null,
} = {}) {
  if (snapshotHash !== null && !/^[a-f0-9]{64}$/i.test(snapshotHash)) {
    throw new Error('snapshotHash must be null or a SHA-256 value');
  }
  const semantic = normalizeSemanticResult(value);
  const semanticResultHash = sha256(stableJson(semantic));
  const contract = compileContract(semantic, publisherPrefix);
  const contractHash = contract ? sha256(stableJson(contract)) : null;
  const markdown = renderMarkdown(
    semantic,
    contract,
    semanticResultHash,
    contractHash,
    snapshotHash,
  );
  const receipt = {
    schemaVersion: 1,
    semanticResultHash,
    markdownRenderedFrom: semanticResultHash,
    contractRenderedFrom: semanticResultHash,
    markdownHash: sha256(markdown),
    contractHash,
    snapshotHash,
    productScopeRevision,
    validated: true,
  };
  const receiptValidation = validateCompilationReceipt(
    receipt,
    semantic,
    markdown,
    contract,
    snapshotHash,
  );
  if (!receiptValidation.valid) {
    throw new Error(`Compilation receipt is invalid: ${receiptValidation.errors.join('; ')}`);
  }
  return { semantic, markdown, contract, receipt };
}

function materializeDataModelCompilation(compilation, {
  projectRoot,
  semanticTarget,
  markdownTarget,
  contractTarget = null,
  receiptTarget,
  fileSystem = fs,
} = {}) {
  const artifacts = [
    { artifactId: 'semantic:data-model', targetPath: semanticTarget, content: stableJson(compilation.semantic) },
    { artifactId: 'section:data-model', targetPath: markdownTarget, content: compilation.markdown },
    ...(compilation.contract ? [{
      artifactId: 'contract:dataverse-schema',
      targetPath: contractTarget,
      content: stableJson(compilation.contract),
    }] : []),
    { artifactId: 'receipt:data-model-compilation', targetPath: receiptTarget, content: stableJson(compilation.receipt) },
  ];
  if (artifacts.some((artifact) => !artifact.targetPath)) {
    throw new Error('all compiled output target paths are required');
  }
  const workOrder = sealWorkOrder({
    schemaVersion: 1,
    agent: 'foreground-data-model-compiler',
    workOrderId: 'compile:data-model',
    attempt: 1,
    context: { semanticResultHash: compilation.receipt.semanticResultHash },
    artifacts: artifacts.map(({ artifactId, targetPath }) => ({ artifactId, targetPath })),
  });
  const responseText = JSON.stringify({
    schemaVersion: 1,
    status: 'ready',
    agent: workOrder.agent,
    inputFingerprint: workOrder.inputFingerprint,
    artifacts,
    concerns: [],
    clarification: null,
  });
  return materializeEnvelopeSet([{ workOrder, responseText }], {
    projectRoot,
    fileSystem,
    validateStagedArtifacts(staged) {
      const byId = new Map(staged.map((artifact) => [artifact.artifactId, artifact]));
      const semantic = JSON.parse(fileSystem.readFileSync(byId.get('semantic:data-model').stagedPath, 'utf8'));
      const markdown = fileSystem.readFileSync(byId.get('section:data-model').stagedPath, 'utf8');
      const contractArtifact = byId.get('contract:dataverse-schema');
      const contract = contractArtifact
        ? JSON.parse(fileSystem.readFileSync(contractArtifact.stagedPath, 'utf8'))
        : null;
      const receipt = JSON.parse(fileSystem.readFileSync(
        byId.get('receipt:data-model-compilation').stagedPath,
        'utf8',
      ));
      const findings = validateSemanticResult(semantic).errors;
      if (contract) findings.push(...validateContract(contract).errors);
      findings.push(...validateCompilationReceipt(
        receipt,
        semantic,
        markdown,
        contract,
        receipt.snapshotHash,
      ).errors);
      return findings;
    },
  });
}

module.exports = {
  RESULT_TYPE,
  SCHEMA_PATH,
  SCHEMA_VERSION,
  boundedLogicalName,
  compileContract,
  compileDataModelSemanticResult,
  materializeDataModelCompilation,
  normalizeSemanticResult,
  renderMarkdown,
  validateCompilationReceipt,
  validateSemanticResult,
};