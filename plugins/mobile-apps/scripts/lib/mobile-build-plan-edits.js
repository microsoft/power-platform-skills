'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  contractApprovalContent,
  normalizedContract,
  sha256,
  stableJson,
  validateContract,
} = require('../build-dataverse-operation-manifest');
const { validateScopeContract } = require('../validate-product-scope');
const { validatePlanningDecisions } = require('../validate-dataverse-planning-decisions');
const {
  ARTIFACTS,
  EDIT_JOURNAL_ARTIFACT,
  PROGRESS_ARTIFACT,
  editableContractContent,
  hasExecutionStarted,
  nextProgressState,
  resolveInsideProject,
  revisionOf,
  writeBuildPlan,
} = require('./mobile-build-plan');

const MAX_EDITS = 100;
const STALE_DATA_MODEL_ARTIFACTS = [
  ARTIFACTS.pipeline,
  ARTIFACTS.dataverseManifest,
  '.tmp/dataverse-reconciliation-scope.json',
  '.tmp/dataverse-execution-reconciliation.json',
];
const COLUMN_FIELDS = [
  'logicalName',
  'schemaName',
  'displayName',
  'description',
  'type',
  'plannedDecision',
  'requiredLevel',
  'primaryName',
  'lookupTarget',
  'options',
  'defaultValue',
  'format',
  'formatName',
  'dateTimeBehavior',
  'maxLength',
  'minValue',
  'maxValue',
  'precision',
  'precisionSource',
  'maxSizeInKB',
  'maxHeight',
  'maxWidth',
  'adaptedLogicalName',
  'adaptedSchemaName',
  'reason',
];
const TABLE_FIELDS = [
  'schemaName',
  'displayName',
  'displayCollectionName',
  'description',
  'plannedDecision',
  'dependencyTier',
  'serviceRequired',
  'ownershipType',
  'hasActivities',
  'hasNotes',
  'isAvailableOffline',
  'changeTrackingEnabled',
  'adaptedLogicalName',
  'adaptedSchemaName',
  'reason',
];
const RELATIONSHIP_FIELDS = [
  'kind',
  'schemaName',
  'displayName',
  'plannedDecision',
  'serviceRequired',
  'parentTable',
  'childTable',
  'entity1',
  'entity2',
  'intersectTable',
  'adaptedSchemaName',
  'adaptedIntersectTable',
  'reason',
  'lookup',
];

function readJson(projectRoot, relativePath) {
  const file = resolveInsideProject(projectRoot, relativePath);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function copyAllowed(source, allowed, label) {
  assertPlainObject(source, label);
  const unexpected = Object.keys(source).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new Error(`${label} contains unsupported field(s): ${unexpected.join(', ')}`);
  }
  return Object.fromEntries(
    allowed.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]),
  );
}

function logicalName(value, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]*$/i.test(normalized)) {
    throw new Error(`${label} must be a Dataverse logical name`);
  }
  return normalized;
}

function findTable(contract, requestedName) {
  const normalizedName = logicalName(requestedName, 'tableLogicalName');
  const table = contract.tables.find((item) => item.logicalName.toLowerCase() === normalizedName);
  if (!table) throw new Error(`Unknown table: ${normalizedName}`);
  return table;
}

function columnFromInput(input, defaults = {}) {
  const supplied = copyAllowed(input, COLUMN_FIELDS, 'column');
  const normalizedName = logicalName(
    supplied.logicalName || defaults.logicalName,
    'column.logicalName',
  );
  return {
    ...defaults,
    ...supplied,
    logicalName: normalizedName,
    schemaName: String(supplied.schemaName || defaults.schemaName || normalizedName).trim(),
    displayName: String(supplied.displayName || defaults.displayName || normalizedName).trim(),
    type: String(supplied.type || defaults.type || 'string').trim(),
    plannedDecision: String(
      supplied.plannedDecision || defaults.plannedDecision || 'create',
    ).trim().toLowerCase(),
    requiredLevel: String(supplied.requiredLevel || defaults.requiredLevel || 'None').trim(),
  };
}

function tableFieldsFromInput(input) {
  const result = copyAllowed(input, TABLE_FIELDS, 'table');
  for (const field of ['schemaName', 'displayName', 'displayCollectionName']) {
    if (result[field] !== undefined) result[field] = String(result[field]).trim();
  }
  if (result.plannedDecision !== undefined) {
    result.plannedDecision = String(result.plannedDecision).trim().toLowerCase();
  }
  if (result.dependencyTier !== undefined) result.dependencyTier = Number(result.dependencyTier);
  return result;
}

function synchronizeScopeTable(scope, previousTable, table, mapping) {
  if (!scope) return null;
  const previousName = previousTable?.displayName || previousTable?.logicalName;
  const displayName = table.displayName || table.logicalName;
  const entityIndex = (scope.dataEntities || []).findIndex(
    (entity) => entity.name === previousName || entity.name === displayName,
  );
  const tableIndex = (scope.newTables || []).findIndex(
    (entry) => entry.name === previousName || entry.name === displayName,
  );
  if (previousTable && !mapping && entityIndex < 0 && tableIndex < 0) return scope;
  if (!previousTable && !mapping) {
    throw new Error('scope mapping is required when adding a table to an authored Product Scope');
  }

  const isNew = ['create', 'adapt'].includes(table.plannedDecision);
  const currentEntity = entityIndex >= 0 ? scope.dataEntities[entityIndex] : null;
  const entity = {
    name: displayName,
    role: mapping?.role || currentEntity?.role || 'supporting',
    realization: isNew ? 'new-table' : 'existing-table',
    screenIds: mapping?.screenIds || currentEntity?.screenIds || [],
    ...(mapping?.note || currentEntity?.note
      ? { note: mapping?.note || currentEntity.note }
      : {}),
  };
  if (entityIndex >= 0) scope.dataEntities[entityIndex] = entity;
  else scope.dataEntities.push(entity);

  if (isNew) {
    const currentTable = tableIndex >= 0 ? scope.newTables[tableIndex] : null;
    const jobIds = mapping?.jobIds || currentTable?.jobIds;
    const lifecycleJustification = mapping?.lifecycleJustification
      || currentTable?.lifecycleJustification;
    if (!Array.isArray(jobIds) || jobIds.length === 0 || !lifecycleJustification) {
      throw new Error('new table scope mapping requires jobIds and lifecycleJustification');
    }
    const scopeTable = { name: displayName, jobIds, lifecycleJustification };
    if (tableIndex >= 0) scope.newTables[tableIndex] = scopeTable;
    else scope.newTables.push(scopeTable);
  } else if (tableIndex >= 0) {
    scope.newTables.splice(tableIndex, 1);
  }
  return scope;
}

function addTable(contract, scope, command) {
  const normalizedName = logicalName(command.logicalName, 'logicalName');
  if (contract.tables.some((table) => table.logicalName.toLowerCase() === normalizedName)) {
    throw new Error(`Table already exists: ${normalizedName}`);
  }
  const fields = tableFieldsFromInput(command.table || {});
  const plannedDecision = fields.plannedDecision || 'create';
  if (['create', 'adapt'].includes(plannedDecision)
    && !normalizedName.startsWith(`${contract.publisherPrefix.toLowerCase()}_`)) {
    throw new Error(`New table names must use publisher prefix ${contract.publisherPrefix}_`);
  }
  const primaryLogicalName = logicalName(
    command.primaryColumn?.logicalName || `${contract.publisherPrefix}_name`,
    'primaryColumn.logicalName',
  );
  const primaryColumn = columnFromInput(command.primaryColumn || {
    logicalName: primaryLogicalName,
  }, {
    logicalName: primaryLogicalName,
    schemaName: primaryLogicalName,
    displayName: 'Name',
    type: 'string',
    plannedDecision: ['create', 'adapt'].includes(plannedDecision) ? 'create' : 'reuse',
    requiredLevel: 'ApplicationRequired',
    primaryName: true,
  });
  const table = {
    logicalName: normalizedName,
    schemaName: fields.schemaName || normalizedName,
    displayName: fields.displayName || normalizedName,
    displayCollectionName: fields.displayCollectionName || `${fields.displayName || normalizedName}s`,
    plannedDecision,
    dependencyTier: fields.dependencyTier ?? 0,
    serviceRequired: fields.serviceRequired ?? true,
    ownershipType: fields.ownershipType || 'UserOwned',
    ...fields,
    columns: [primaryColumn],
    relationships: [],
    alternateKeys: [],
  };
  contract.tables.push(table);
  synchronizeScopeTable(scope, null, table, command.scope);
  return { target: normalizedName };
}

function updateTable(contract, scope, command) {
  const table = findTable(contract, command.tableLogicalName);
  const previous = structuredClone(table);
  Object.assign(table, tableFieldsFromInput(command.table || {}));
  synchronizeScopeTable(scope, previous, table, command.scope);
  return { target: table.logicalName };
}

function addColumn(contract, command) {
  const table = findTable(contract, command.tableLogicalName);
  const column = columnFromInput(command.column);
  if (table.columns.some((item) => item.logicalName.toLowerCase() === column.logicalName)) {
    throw new Error(`Column already exists: ${table.logicalName}.${column.logicalName}`);
  }
  table.columns.push(column);
  return { target: `${table.logicalName}.${column.logicalName}` };
}

function updateColumn(contract, command) {
  const table = findTable(contract, command.tableLogicalName);
  const normalizedName = logicalName(command.columnLogicalName, 'columnLogicalName');
  const index = table.columns.findIndex(
    (column) => column.logicalName.toLowerCase() === normalizedName,
  );
  if (index < 0) throw new Error(`Unknown column: ${table.logicalName}.${normalizedName}`);
  if (command.column?.logicalName
    && logicalName(command.column.logicalName, 'column.logicalName') !== normalizedName) {
    throw new Error('Column logical names cannot be changed in the Build Plan');
  }
  table.columns[index] = columnFromInput(command.column || {}, table.columns[index]);
  return { target: `${table.logicalName}.${normalizedName}` };
}

function removeRelationship(contract, tableName, schemaName) {
  const table = findTable(contract, tableName);
  const normalizedSchema = String(schemaName || '').trim().toLowerCase();
  const index = table.relationships.findIndex(
    (relationship) => relationship.schemaName.toLowerCase() === normalizedSchema,
  );
  if (index < 0) throw new Error(`Unknown relationship: ${schemaName}`);
  const [relationship] = table.relationships.splice(index, 1);
  if (relationship.kind !== 'many-to-one') return relationship;

  const child = findTable(contract, relationship.childTable || table.logicalName);
  const lookupName = relationship.lookup?.logicalName?.toLowerCase();
  const stillUsed = contract.tables.some((owner) => owner.relationships.some((candidate) => (
    candidate.kind === 'many-to-one'
    && (candidate.childTable || owner.logicalName).toLowerCase() === child.logicalName
    && candidate.lookup?.logicalName?.toLowerCase() === lookupName
  )));
  if (!stillUsed) {
    const lookupIndex = child.columns.findIndex(
      (column) => column.logicalName.toLowerCase() === lookupName,
    );
    if (lookupIndex >= 0) child.columns.splice(lookupIndex, 1);
  }
  return relationship;
}

function addRelationship(contract, command) {
  const input = copyAllowed(command.relationship, RELATIONSHIP_FIELDS, 'relationship');
  const schemaName = String(input.schemaName || '').trim();
  if (!schemaName) throw new Error('relationship.schemaName is required');
  if (contract.tables.some((table) => table.relationships.some(
    (candidate) => candidate.schemaName.toLowerCase() === schemaName.toLowerCase(),
  ))) {
    throw new Error(`Relationship already exists: ${schemaName}`);
  }
  const decision = String(input.plannedDecision || 'create').trim().toLowerCase();
  let owner;
  let relationship;
  if (input.kind === 'many-to-one') {
    const parent = findTable(contract, input.parentTable);
    const child = findTable(contract, input.childTable);
    owner = child;
    const lookup = columnFromInput(input.lookup || {}, {
      logicalName: input.lookup?.logicalName,
      schemaName: input.lookup?.schemaName || input.lookup?.logicalName,
      displayName: input.lookup?.displayName || parent.displayName || parent.logicalName,
      type: 'lookup',
      plannedDecision: decision,
      requiredLevel: input.lookup?.requiredLevel || 'None',
      lookupTarget: parent.logicalName,
    });
    lookup.type = 'lookup';
    lookup.lookupTarget = parent.logicalName;
    lookup.plannedDecision = decision;
    const lookupIndex = child.columns.findIndex(
      (column) => column.logicalName.toLowerCase() === lookup.logicalName,
    );
    if (lookupIndex >= 0) child.columns[lookupIndex] = lookup;
    else child.columns.push(lookup);
    relationship = {
      kind: input.kind,
      schemaName,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      plannedDecision: decision,
      parentTable: parent.logicalName,
      childTable: child.logicalName,
      lookup: {
        logicalName: lookup.logicalName,
        schemaName: lookup.schemaName,
        displayName: lookup.displayName,
        requiredLevel: lookup.requiredLevel,
      },
    };
  } else if (input.kind === 'many-to-many') {
    const entity1 = findTable(contract, input.entity1);
    const entity2 = findTable(contract, input.entity2);
    owner = entity1;
    relationship = {
      kind: input.kind,
      schemaName,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      plannedDecision: decision,
      entity1: entity1.logicalName,
      entity2: entity2.logicalName,
      intersectTable: logicalName(input.intersectTable, 'relationship.intersectTable'),
      ...(input.serviceRequired === undefined
        ? {}
        : { serviceRequired: Boolean(input.serviceRequired) }),
    };
  } else {
    throw new Error('relationship.kind must be many-to-one or many-to-many');
  }
  owner.relationships.push(relationship);
  return { target: schemaName };
}

function updateRelationship(contract, command) {
  removeRelationship(contract, command.tableLogicalName, command.relationshipSchemaName);
  return addRelationship(contract, command);
}

function invalidateApprovalReceipt(receipt, now) {
  if (!receipt) return null;
  const next = structuredClone(receipt);
  const keys = new Set([
    ...Object.keys(next.approvals || {}),
    'dataModel',
    'nativeCapabilities',
    'connectors',
    'screenPlan',
  ]);
  next.approvals = Object.fromEntries([...keys].map((key) => {
    const record = { ...(next.approvals?.[key] || {}) };
    delete record.approvedAt;
    delete record.approvedContractSha256;
    return [key, {
      ...record,
      status: 'pending',
      invalidatedAt: now,
      invalidationReason: 'data-model-edited',
    }];
  }));
  for (const key of ['experience', 'screenPlan', 'implementation']) {
    if (!next[key] || typeof next[key] !== 'object') continue;
    next[key] = {
      ...next[key],
      status: 'pending',
      invalidatedAt: now,
      invalidationReason: 'data-model-edited',
    };
    delete next[key].approvedAt;
  }
  delete next.approvedPlanSha256;
  delete next.approvedContractSha256;
  delete next.approvedContract;
  delete next.serviceRequiredTables;
  delete next.integritySha256;
  next.invalidatedAt = now;
  next.invalidationReason = 'data-model-edited';
  next.integritySha256 = sha256(stableJson(next));
  return next;
}

function transactionalFiles(projectRoot, writes, removals = []) {
  const targets = [...new Set([...Object.keys(writes), ...removals])];
  const originals = new Map();
  const temporary = new Map();
  for (const relativePath of targets) {
    const file = resolveInsideProject(projectRoot, relativePath);
    if (fs.existsSync(file)) {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`Build Plan artifact must be a regular file: ${relativePath}`);
      }
      originals.set(relativePath, fs.readFileSync(file));
    } else {
      originals.set(relativePath, null);
    }
  }
  try {
    for (const [relativePath, value] of Object.entries(writes)) {
      const file = resolveInsideProject(projectRoot, relativePath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.tmp-${process.pid}-${Date.now()}-${temporary.size}`;
      fs.writeFileSync(temp, Buffer.isBuffer(value) ? value : stableJson(value), {
        mode: 0o600,
      });
      temporary.set(relativePath, temp);
    }
    for (const [relativePath, temp] of temporary) {
      fs.renameSync(temp, resolveInsideProject(projectRoot, relativePath));
    }
    for (const relativePath of removals) {
      fs.rmSync(resolveInsideProject(projectRoot, relativePath), { force: true });
    }
  } catch (error) {
    for (const [relativePath, bytes] of originals) {
      const file = resolveInsideProject(projectRoot, relativePath);
      if (bytes === null) fs.rmSync(file, { force: true });
      else {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, bytes);
      }
    }
    throw error;
  } finally {
    for (const temp of temporary.values()) fs.rmSync(temp, { force: true });
  }
}

function applyDataModelEdit(projectRoot, command, now = new Date().toISOString()) {
  assertPlainObject(command, 'edit command');
  if (hasExecutionStarted(projectRoot)) {
    throw new Error('Dataverse execution has started; use /edit-app for schema changes');
  }
  const current = readJson(projectRoot, ARTIFACTS.dataModel);
  if (!current) throw new Error('Data model contract is not available yet');
  const currentContent = contractApprovalContent(current);
  const currentRevision = revisionOf(currentContent);
  if (command.expectedRevision !== currentRevision) {
    const error = new Error('Data model changed since this Build Plan view was loaded');
    error.code = 'revision-conflict';
    error.currentRevision = currentRevision;
    throw error;
  }
  const contract = structuredClone(currentContent);
  const scope = readJson(projectRoot, ARTIFACTS.scope);
  const nextScope = scope ? structuredClone(scope) : null;
  let edited;
  if (command.type === 'add-table') edited = addTable(contract, nextScope, command);
  else if (command.type === 'update-table') edited = updateTable(contract, nextScope, command);
  else if (command.type === 'add-column') edited = addColumn(contract, command);
  else if (command.type === 'update-column') edited = updateColumn(contract, command);
  else if (command.type === 'add-relationship') edited = addRelationship(contract, command);
  else if (command.type === 'update-relationship') edited = updateRelationship(contract, command);
  else throw new Error(`Unsupported data model edit: ${command.type || '(missing)'}`);

  const contractValidation = validateContract(contract);
  if (!contractValidation.valid) {
    throw new Error(`Data model edit is invalid: ${contractValidation.errors.join('; ')}`);
  }
  const normalized = normalizedContract(contract);
  const planningSnapshot = readJson(
    projectRoot,
    '.tmp/dataverse-foreground-planning-snapshot.json',
  );
  if (planningSnapshot) {
    const evidenceValidation = validatePlanningDecisions(normalized, planningSnapshot);
    if (!evidenceValidation.valid) {
      const missing = evidenceValidation.contextNames.length > 0
        ? ` Missing full detail for: ${evidenceValidation.contextNames.join(', ')}.`
        : '';
      throw new Error(
        `Data model edit needs refreshed Dataverse evidence: ${evidenceValidation.errors.join('; ')}.${missing}`,
      );
    }
  }
  let scopeValidation = null;
  if (nextScope && stableJson(nextScope) !== stableJson(scope)) {
    scopeValidation = validateScopeContract(
      nextScope,
      readJson(projectRoot, ARTIFACTS.experience),
    );
    if (!scopeValidation.ok) {
      throw new Error(`Product Scope edit is invalid: ${scopeValidation.errors.map(
        (item) => item.message || String(item),
      ).join('; ')}`);
    }
  }

  const nextRevision = revisionOf(editableContractContent(normalized));
  const receipt = invalidateApprovalReceipt(readJson(projectRoot, ARTIFACTS.approvals), now);
  const editJournal = readJson(projectRoot, EDIT_JOURNAL_ARTIFACT) || {
    schemaVersion: 1,
    edits: [],
  };
  editJournal.edits = [...editJournal.edits, {
    at: now,
    type: command.type,
    target: edited.target,
    previousRevision: currentRevision,
    revision: nextRevision,
    approvalState: 'pending',
  }].slice(-MAX_EDITS);
  const progress = nextProgressState(readJson(projectRoot, PROGRESS_ARTIFACT), {
    phase: 'data-model',
    status: 'waiting',
    detail: 'Data model changed; Gate 1 reapproval is required',
  }, now);
  const writes = {
    [ARTIFACTS.dataModel]: normalized,
    [EDIT_JOURNAL_ARTIFACT]: editJournal,
    [PROGRESS_ARTIFACT]: progress,
  };
  if (receipt) writes[ARTIFACTS.approvals] = receipt;
  if (scopeValidation) writes[ARTIFACTS.scope] = nextScope;
  transactionalFiles(projectRoot, writes, STALE_DATA_MODEL_ARTIFACTS.filter(
    (relativePath) => fs.existsSync(resolveInsideProject(projectRoot, relativePath)),
  ));
  writeBuildPlan(projectRoot);
  return {
    ok: true,
    type: command.type,
    target: edited.target,
    previousRevision: currentRevision,
    revision: nextRevision,
    requiresReapproval: true,
    scopeWarnings: scopeValidation?.warnings || [],
  };
}

module.exports = {
  applyDataModelEdit,
  invalidateApprovalReceipt,
  transactionalFiles,
};