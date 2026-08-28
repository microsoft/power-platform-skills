#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  compareDerivedColumn,
  normalizeOptions,
  validateOptions,
} = require('./lib/derived-metadata');
const {
  canonicalAttributeType,
  validateSnapshot,
} = require('./create-dataverse-snapshot');
const { operationFingerprint } = require('./dataverse-request');

const CONTRACT_SCHEMA_VERSION = 1;
const APPROVAL_RECEIPT_SCHEMA_VERSION = 1;
const MANIFEST_SCHEMA_VERSION = 2;
const PUBLISH_CHECKPOINT_SCHEMA_VERSION = 2;
const DEFAULT_MAX_RECONCILIATION_AGE_MS = 10 * 60 * 1000;
const PHASE_ORDER = [
  'tableCreates',
  'extensions',
  'relationships',
  'alternateKeys',
  'publish',
];
const DECISIONS = new Set([
  'reuse',
  'extend',
  'create',
  'adapt',
  'defer',
  'unverified',
]);
const CONTRACT_DECISIONS = new Set([
  'reuse',
  'extend',
  'create',
  'adapt',
  'defer',
  'unverified',
]);
const DERIVED_COLUMN_TYPES = new Set([
  'boolean',
  'choice',
  'multiselectchoice',
  'lookup',
  'computed',
]);
const NULL_SOURCE_TYPE_IS_ORDINARY_TYPES = new Set([
  'file',
  'image',
  'lookup',
  'memo',
  'multiline',
]);
const MUTATING_DECISIONS = new Set(['create', 'extend', 'adapt']);
const MAX_IMAGE_SIZE_IN_KB = 30 * 1024;
const MAX_FILE_SIZE_IN_KB = 10 * 1024 * 1024;
const ADAPTATION_KINDS = new Set(['existing-object', 'hidden-name-collision']);
const HIDDEN_COLLISION_CODES = new Set(['0x80044363', '0x80060890']);

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const value = argv[index + 1];
    if (value !== undefined && !String(value).startsWith('--')) {
      args[token.slice(2)] = value;
      index += 1;
    } else {
      args[token.slice(2)] = true;
    }
  }
  return args;
}

function normalizeUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '').toLowerCase();
}

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function stableClone(value) {
  if (Array.isArray(value)) return value.map(stableClone);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value)
    .sort((left, right) => left.localeCompare(right))
    .reduce((result, key) => {
      result[key] = stableClone(value[key]);
      return result;
    }, {});
}

function stableJson(value) {
  return `${JSON.stringify(stableClone(value), null, 2)}\n`;
}

function atomicWriteJson(file, value, fileSystem = fs) {
  fileSystem.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fileSystem.writeFileSync(temporary, stableJson(value), 'utf8');
    fileSystem.renameSync(temporary, file);
  } finally {
    if (fileSystem.existsSync(temporary)) fileSystem.rmSync(temporary, { force: true });
  }
}

function label(value) {
  return {
    '@odata.type': 'Microsoft.Dynamics.CRM.Label',
    LocalizedLabels: [{
      '@odata.type': 'Microsoft.Dynamics.CRM.LocalizedLabel',
      Label: value,
      LanguageCode: 1033,
    }],
  };
}

function requiredLevel(value) {
  return { Value: value || 'None' };
}

function contractItemId(kind, ...parts) {
  return [kind, ...parts.map(normalizeName)].join(':');
}

function uniqueByNormalizedName(items, nameOf, labelText, errors) {
  const seen = new Set();
  for (const [index, item] of items.entries()) {
    const name = String(nameOf(item) || '').trim();
    if (!name) {
      errors.push(`${labelText}[${index}] requires a logical or schema name`);
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) errors.push(`${labelText} contains duplicate ${name}`);
    seen.add(key);
  }
}

function validateLogicalName(value, labelText, errors) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]*$/i.test(value)) {
    errors.push(`${labelText} must be a Dataverse logical/schema name`);
  }
}

function logicalNameFromSchemaName(value) {
  return normalizeName(value);
}

function validateSchemaLogicalIdentity(logicalName, schemaName, labelText, errors) {
  validateLogicalName(logicalName, `${labelText}.logicalName`, errors);
  validateLogicalName(schemaName, `${labelText}.schemaName`, errors);
  if (
    typeof logicalName === 'string'
    && typeof schemaName === 'string'
    && logicalNameFromSchemaName(schemaName) !== normalizeName(logicalName)
  ) {
    errors.push(
      `${labelText}.schemaName must resolve to logicalName ${normalizeName(logicalName)} `
      + 'under Dataverse casing rules',
    );
  }
}

function isSha256(value) {
  return /^[a-f0-9]{64}$/i.test(String(value || ''));
}

function isHiddenNameCollisionAdapt(table) {
  return normalizeName(table?.plannedDecision) === 'adapt'
    && table?.adaptationKind === 'hidden-name-collision';
}

function validateHiddenCollisionEvidence(table, prefix, errors) {
  const evidence = table.collisionEvidence;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    errors.push(`${prefix}.collisionEvidence is required for hidden-name-collision Adapt`);
    return;
  }
  if (!HIDDEN_COLLISION_CODES.has(normalizeName(evidence.code))) {
    errors.push(`${prefix}.collisionEvidence.code is not an approved hidden collision code`);
  }
  if (typeof evidence.operationId !== 'string' || !evidence.operationId.trim()) {
    errors.push(`${prefix}.collisionEvidence.operationId is required`);
  }
  for (const field of [
    'operationFingerprint',
    'priorManifestSha256',
    'priorReconciliationSha256',
  ]) {
    if (!isSha256(evidence[field])) {
      errors.push(`${prefix}.collisionEvidence.${field} must be a SHA-256 value`);
    }
  }
  if (!Number.isFinite(Date.parse(evidence.observedAt))) {
    errors.push(`${prefix}.collisionEvidence.observedAt must be an ISO timestamp`);
  }
}

function validateAdaptationPolicy(policy) {
  const errors = [];
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    return { valid: false, errors: ['adaptationPolicy must be an object'] };
  }
  if (policy.schemaVersion !== 1) errors.push('adaptationPolicy.schemaVersion must be 1');
  if (policy.automaticTechnicalRename !== true) {
    errors.push('adaptationPolicy.automaticTechnicalRename must be true');
  }
  if (policy.semanticChangesRequireApproval !== true) {
    errors.push('adaptationPolicy.semanticChangesRequireApproval must be true');
  }
  if (!Array.isArray(policy.allowedCollisionCodes)
    || policy.allowedCollisionCodes.length === 0
    || policy.allowedCollisionCodes.some(
      (code) => !HIDDEN_COLLISION_CODES.has(normalizeName(code)),
    )) {
    errors.push('adaptationPolicy.allowedCollisionCodes must contain only approved codes');
  }
  if (!Array.isArray(policy.alternativeSuffixes)
    || policy.alternativeSuffixes.length === 0
    || policy.alternativeSuffixes.some((suffix) => !/^[a-z0-9]+$/i.test(String(suffix)))) {
    errors.push('adaptationPolicy.alternativeSuffixes must be a non-empty safe suffix array');
  }
  if (!Number.isInteger(policy.maxAttempts)
    || policy.maxAttempts < 1
    || policy.maxAttempts > 20) {
    errors.push('adaptationPolicy.maxAttempts must be an integer from 1 to 20');
  }
  return { valid: errors.length === 0, errors };
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function normalizeColumnType(value) {
  return String(value || '').replace(/[\s_-]/g, '').toLowerCase();
}

function dataverseType(column) {
  const type = normalizeColumnType(column.type);
  const mapping = {
    string: 'String',
    text: 'String',
    memo: 'Memo',
    multiline: 'Memo',
    integer: 'Integer',
    wholenumber: 'Integer',
    bigint: 'BigInt',
    decimal: 'Decimal',
    double: 'Double',
    float: 'Double',
    money: 'Money',
    currency: 'Money',
    datetime: 'DateTime',
    date: 'DateTime',
    boolean: 'Boolean',
    choice: 'Picklist',
    picklist: 'Picklist',
    multiselectchoice: 'Virtual',
    lookup: 'Lookup',
    image: 'Image',
    file: 'File',
    computed: String(column.attributeType || ''),
    calculated: String(column.attributeType || ''),
    rollup: String(column.attributeType || ''),
    formula: String(column.attributeType || ''),
  };
  return mapping[type] || String(column.attributeType || column.type || '');
}

function typeName(column) {
  const type = normalizeColumnType(column.type);
  if (type === 'multiselectchoice') return 'MultiSelectPicklistType';
  if (type === 'file') return 'FileType';
  if (type === 'image') return 'ImageType';
  const liveType = dataverseType(column);
  return liveType ? `${liveType}Type` : '';
}

function isComputedColumn(column) {
  return ['computed', 'calculated', 'rollup', 'formula'].includes(
    normalizeColumnType(column.type),
  ) || Number(column.sourceType || 0) !== 0;
}

function validateContract(contract) {
  const errors = [];
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    return { valid: false, errors: ['contract must be an object'] };
  }
  if (contract.schemaVersion !== CONTRACT_SCHEMA_VERSION) {
    errors.push(`contract.schemaVersion must equal ${CONTRACT_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(contract.tables)) errors.push('contract.tables must be an array');
  if (typeof contract.publisherPrefix !== 'string' || !contract.publisherPrefix.trim()) {
    errors.push('contract.publisherPrefix is required');
  }
  if (contract.publisherPrefix && !/^[a-z][a-z0-9]*$/i.test(contract.publisherPrefix)) {
    errors.push('contract.publisherPrefix must not contain an underscore');
  }
  if (contract.approvedPlanSha256 !== undefined
    && !/^[a-f0-9]{64}$/i.test(String(contract.approvedPlanSha256))) {
    errors.push('contract.approvedPlanSha256 must be a SHA-256 hex value when supplied');
  }
  if (contract.approvedContractSha256 !== undefined
    && !/^[a-f0-9]{64}$/i.test(String(contract.approvedContractSha256))) {
    errors.push('contract.approvedContractSha256 must be a SHA-256 hex value when supplied');
  }
  if (contract.approvalReceiptSha256 !== undefined
    && !/^[a-f0-9]{64}$/i.test(String(contract.approvalReceiptSha256))) {
    errors.push('contract.approvalReceiptSha256 must be a SHA-256 hex value when supplied');
  }
  if (errors.length > 0 || !Array.isArray(contract.tables)) {
    return { valid: false, errors };
  }

  uniqueByNormalizedName(
    contract.tables,
    (table) => table.logicalName,
    'contract.tables',
    errors,
  );

  for (const [tableIndex, table] of contract.tables.entries()) {
    const prefix = `contract.tables[${tableIndex}]`;
    validateSchemaLogicalIdentity(
      table.logicalName,
      table.schemaName || table.logicalName,
      prefix,
      errors,
    );
    if (!CONTRACT_DECISIONS.has(normalizeName(table.plannedDecision))) {
      errors.push(`${prefix}.plannedDecision must use the reconciliation taxonomy`);
    }
    if (!Number.isInteger(table.dependencyTier) || table.dependencyTier < 0) {
      errors.push(`${prefix}.dependencyTier must be a non-negative integer`);
    }
    if (typeof table.serviceRequired !== 'boolean') {
      errors.push(`${prefix}.serviceRequired must be boolean`);
    }
    if (!Array.isArray(table.columns)) errors.push(`${prefix}.columns must be an array`);
    if (!Array.isArray(table.relationships)) {
      errors.push(`${prefix}.relationships must be an array`);
    }
    if (!Array.isArray(table.alternateKeys)) {
      errors.push(`${prefix}.alternateKeys must be an array`);
    }
    if (normalizeName(table.plannedDecision) === 'adapt') {
      const adaptationKind = table.adaptationKind || 'existing-object';
      if (!ADAPTATION_KINDS.has(adaptationKind)) {
        errors.push(`${prefix}.adaptationKind is invalid`);
      }
      validateSchemaLogicalIdentity(
        table.adaptedLogicalName,
        table.adaptedSchemaName,
        `${prefix}.adapted`,
        errors,
      );
      if (adaptationKind === 'hidden-name-collision') {
        validateHiddenCollisionEvidence(table, prefix, errors);
      }
    }

    const columns = Array.isArray(table.columns) ? table.columns : [];
    uniqueByNormalizedName(columns, (column) => column.logicalName, `${prefix}.columns`, errors);
    for (const [columnIndex, column] of columns.entries()) {
      const columnPrefix = `${prefix}.columns[${columnIndex}]`;
      const columnDecision = normalizeName(column.plannedDecision);
      const columnType = normalizeColumnType(column.type);
      validateSchemaLogicalIdentity(
        column.logicalName,
        column.schemaName || column.logicalName,
        columnPrefix,
        errors,
      );
      if (!CONTRACT_DECISIONS.has(normalizeName(column.plannedDecision))) {
        errors.push(`${columnPrefix}.plannedDecision must use the reconciliation taxonomy`);
      }
      if (!columnType) errors.push(`${columnPrefix}.type is required`);
      if (MUTATING_DECISIONS.has(columnDecision)
        && (column.primaryId === true
          || (table.primaryIdAttribute
            && normalizeName(column.logicalName) === normalizeName(table.primaryIdAttribute)))) {
        errors.push(`${columnPrefix} cannot mutate the server-owned primary ID`);
      }
      if (columnType === 'image' && MUTATING_DECISIONS.has(columnDecision)) {
        if (typeof column.canStoreFullImage !== 'boolean') {
          errors.push(`${columnPrefix}.canStoreFullImage must be boolean for an Image mutation`);
        }
        if (!Number.isInteger(column.maxSizeInKB)
          || column.maxSizeInKB < 1
          || column.maxSizeInKB > MAX_IMAGE_SIZE_IN_KB) {
          errors.push(
            `${columnPrefix}.maxSizeInKB must be an integer from 1 to ${MAX_IMAGE_SIZE_IN_KB}`,
          );
        }
        for (const thumbnailField of ['maxHeight', 'maxWidth']) {
          if (hasOwn(column, thumbnailField)) {
            errors.push(
              `${columnPrefix}.${thumbnailField} is observed thumbnail metadata and cannot be configured`,
            );
          }
        }
      }
      if (columnType === 'file' && MUTATING_DECISIONS.has(columnDecision)
        && (!Number.isInteger(column.maxSizeInKB)
          || column.maxSizeInKB < 1
          || column.maxSizeInKB > MAX_FILE_SIZE_IN_KB)) {
        errors.push(
          `${columnPrefix}.maxSizeInKB must be an integer from 1 to ${MAX_FILE_SIZE_IN_KB}`,
        );
      }
      if (normalizeName(column.plannedDecision) === 'adapt') {
        validateSchemaLogicalIdentity(
          column.adaptedLogicalName,
          column.adaptedSchemaName,
          `${columnPrefix}.adapted`,
          errors,
        );
      }
      if (normalizeColumnType(column.type) === 'lookup' && !column.lookupTarget) {
        errors.push(`${columnPrefix}.lookupTarget is required for a lookup`);
      }
      if (
        ['choice', 'multiselectchoice', 'boolean'].includes(normalizeColumnType(column.type))
        && (!Array.isArray(column.options) || column.options.length === 0)
      ) {
        errors.push(`${columnPrefix}.options must be a non-empty array`);
      } else if (['choice', 'multiselectchoice', 'boolean'].includes(
        normalizeColumnType(column.type),
      )) {
        errors.push(...validateOptions(
          column.options,
          columnPrefix,
          normalizeColumnType(column.type) === 'boolean',
        ));
      }
      if (normalizeColumnType(column.type) === 'bigint') {
        for (const field of ['minValue', 'maxValue']) {
          if (hasOwn(column, field) && !Number.isSafeInteger(column[field])) {
            errors.push(`${columnPrefix}.${field} must be a safely representable integer`);
          }
        }
      }
    }

    const primaryNames = columns.filter((column) => column.primaryName);
    if (['create', 'adapt'].includes(normalizeName(table.plannedDecision))
      && primaryNames.length !== 1) {
      errors.push(`${prefix} create/adapt tables require exactly one primaryName column`);
    } else if (
      ['create', 'adapt'].includes(normalizeName(table.plannedDecision))
      && !['string', 'text'].includes(normalizeColumnType(primaryNames[0]?.type))
    ) {
      errors.push(`${prefix} primaryName column must be string/text`);
    } else if (
      ['create', 'adapt'].includes(normalizeName(table.plannedDecision))
      && normalizeName(primaryNames[0]?.plannedDecision) === 'defer'
    ) {
      errors.push(`${prefix} primaryName column cannot be deferred`);
    }
    if (normalizeName(table.plannedDecision) === 'reuse') {
      for (const column of columns) {
        if (['create', 'adapt'].includes(normalizeName(column.plannedDecision))) {
          errors.push(
            `${prefix} reuse table cannot authorize ${column.plannedDecision} `
            + `column ${column.logicalName}`,
          );
        }
      }
    }

    const relationships = Array.isArray(table.relationships) ? table.relationships : [];
    uniqueByNormalizedName(
      relationships,
      (relationship) => relationship.schemaName,
      `${prefix}.relationships`,
      errors,
    );
    for (const [relationshipIndex, relationship] of relationships.entries()) {
      const relationshipPrefix = `${prefix}.relationships[${relationshipIndex}]`;
      validateLogicalName(
        relationship.schemaName,
        `${relationshipPrefix}.schemaName`,
        errors,
      );
      if (!['many-to-one', 'many-to-many'].includes(relationship.kind)) {
        errors.push(`${relationshipPrefix}.kind must be many-to-one or many-to-many`);
      }
      if (!CONTRACT_DECISIONS.has(normalizeName(relationship.plannedDecision))) {
        errors.push(`${relationshipPrefix}.plannedDecision must use the reconciliation taxonomy`);
      }
      if (relationship.serviceRequired !== undefined
        && typeof relationship.serviceRequired !== 'boolean') {
        errors.push(`${relationshipPrefix}.serviceRequired must be boolean when supplied`);
      }
      if (normalizeName(relationship.plannedDecision) === 'adapt') {
        validateLogicalName(
          relationship.adaptedSchemaName,
          `${relationshipPrefix}.adaptedSchemaName`,
          errors,
        );
      }
      if (relationship.kind === 'many-to-one') {
        validateLogicalName(
          relationship.parentTable,
          `${relationshipPrefix}.parentTable`,
          errors,
        );
        validateLogicalName(
          relationship.childTable || table.logicalName,
          `${relationshipPrefix}.childTable`,
          errors,
        );
        validateSchemaLogicalIdentity(
          relationship.lookup?.logicalName,
          relationship.lookup?.schemaName || relationship.lookup?.logicalName,
          `${relationshipPrefix}.lookup`,
          errors,
        );
        if (normalizeName(relationship.plannedDecision) === 'adapt') {
          validateSchemaLogicalIdentity(
            relationship.lookup?.adaptedLogicalName,
            relationship.lookup?.adaptedSchemaName,
            `${relationshipPrefix}.lookup.adapted`,
            errors,
          );
        }
      } else {
        validateLogicalName(
          relationship.entity1,
          `${relationshipPrefix}.entity1`,
          errors,
        );
        validateLogicalName(
          relationship.entity2,
          `${relationshipPrefix}.entity2`,
          errors,
        );
        validateLogicalName(
          relationship.intersectTable,
          `${relationshipPrefix}.intersectTable`,
          errors,
        );
        if (normalizeName(relationship.plannedDecision) === 'adapt') {
          validateLogicalName(
            relationship.adaptedIntersectTable,
            `${relationshipPrefix}.adaptedIntersectTable`,
            errors,
          );
        }
      }
    }

    const alternateKeys = Array.isArray(table.alternateKeys) ? table.alternateKeys : [];
    uniqueByNormalizedName(
      alternateKeys,
      (key) => key.schemaName,
      `${prefix}.alternateKeys`,
      errors,
    );
    for (const [keyIndex, key] of alternateKeys.entries()) {
      const keyPrefix = `${prefix}.alternateKeys[${keyIndex}]`;
      validateLogicalName(key.schemaName, `${keyPrefix}.schemaName`, errors);
      if (!CONTRACT_DECISIONS.has(normalizeName(key.plannedDecision))) {
        errors.push(`${keyPrefix}.plannedDecision must use the reconciliation taxonomy`);
      }
      if (normalizeName(key.plannedDecision) === 'adapt') {
        validateLogicalName(
          key.adaptedSchemaName,
          `${keyPrefix}.adaptedSchemaName`,
          errors,
        );
      }
      if (!Array.isArray(key.columns) || key.columns.length === 0) {
        errors.push(`${keyPrefix}.columns must be a non-empty array`);
      }
    }
  }

  const tableByName = new Map(
    contract.tables.map((table) => [normalizeName(table.logicalName), table]),
  );
  const relationshipBackedLookups = new Set();
  const effectiveTableNames = new Set();
  for (const table of contract.tables) {
    const effectiveName = normalizeName(
      normalizeName(table.plannedDecision) === 'adapt'
        ? table.adaptedLogicalName
        : table.logicalName,
    );
    if (effectiveTableNames.has(effectiveName)) {
      errors.push(`contract tables resolve to duplicate effective name ${effectiveName}`);
    }
    effectiveTableNames.add(effectiveName);
    const effectiveColumns = new Set();
    for (const column of table.columns || []) {
      const effectiveColumn = normalizeName(
        normalizeName(column.plannedDecision) === 'adapt'
          ? column.adaptedLogicalName
          : column.logicalName,
      );
      if (effectiveColumns.has(effectiveColumn)) {
        errors.push(
          `${table.logicalName} columns resolve to duplicate effective name ${effectiveColumn}`,
        );
      }
      effectiveColumns.add(effectiveColumn);
    }
  }
  for (const table of contract.tables) {
    for (const relationship of table.relationships || []) {
      const endpointNames = relationship.kind === 'many-to-one'
        ? [relationship.parentTable, relationship.childTable || table.logicalName]
        : [relationship.entity1, relationship.entity2];
      for (const endpoint of endpointNames) {
        if (!tableByName.has(normalizeName(endpoint))) {
          errors.push(
            `${relationship.schemaName} endpoint ${endpoint} must be represented as a contract table`,
          );
        }
      }
      if (relationship.kind === 'many-to-one') {
        const child = tableByName.get(normalizeName(relationship.childTable || table.logicalName));
        const lookup = child?.columns?.find(
          (column) => normalizeName(column.logicalName)
            === normalizeName(relationship.lookup?.logicalName),
        );
        if (!lookup || normalizeColumnType(lookup.type) !== 'lookup') {
          errors.push(
            `${relationship.schemaName} lookup must match a lookup column on its child table`,
          );
        } else if (
          normalizeName(lookup.lookupTarget) !== normalizeName(relationship.parentTable)
        ) {
          errors.push(`${relationship.schemaName} lookup target does not match parentTable`);
        } else if (
          normalizeName(lookup.plannedDecision)
          !== normalizeName(relationship.plannedDecision)
        ) {
          errors.push(
            `${relationship.schemaName} decision must match its lookup column decision`,
          );
        } else if (
          relationship.lookup.requiredLevel !== undefined
          && String(relationship.lookup.requiredLevel || 'None')
            !== String(lookup.requiredLevel || 'None')
        ) {
          errors.push(
            `${relationship.schemaName} lookup requiredLevel must match `
            + `${child.logicalName}.${lookup.logicalName}`,
          );
        } else if (
          normalizeName(relationship.plannedDecision) === 'adapt'
          && (
            normalizeName(relationship.lookup.adaptedLogicalName)
              !== normalizeName(lookup.adaptedLogicalName)
            || logicalNameFromSchemaName(relationship.lookup.adaptedSchemaName)
              !== logicalNameFromSchemaName(lookup.adaptedSchemaName)
          )
        ) {
          errors.push(
            `${relationship.schemaName} adapted lookup identity must match `
            + `${child.logicalName}.${lookup.logicalName}`,
          );
        } else {
          relationshipBackedLookups.add(
            `${normalizeName(relationship.childTable || table.logicalName)}:`
            + `${normalizeName(relationship.lookup.logicalName)}`,
          );
        }
      }
    }
    const columnsByName = new Map(
      (table.columns || []).map((column) => [normalizeName(column.logicalName), column]),
    );
    for (const key of table.alternateKeys || []) {
      for (const columnName of key.columns || []) {
        const column = columnsByName.get(normalizeName(columnName));
        if (!column) {
          errors.push(`${key.schemaName} references missing column ${columnName}`);
        } else if (
          ['file', 'image', 'memo', 'multiline', 'multiselectchoice', 'lookup']
            .includes(normalizeColumnType(column.type))
          || isComputedColumn(column)
        ) {
          errors.push(`${key.schemaName} uses unsupported alternate-key column ${columnName}`);
        } else if (
          !['defer', 'unverified'].includes(normalizeName(key.plannedDecision))
          && ['defer', 'unverified'].includes(normalizeName(column.plannedDecision))
        ) {
          errors.push(
            `${key.schemaName} cannot depend on ${columnName} with decision `
            + `${column.plannedDecision}`,
          );
        }
      }
    }
  }
  for (const table of contract.tables) {
    for (const column of table.columns || []) {
      if (normalizeColumnType(column.type) !== 'lookup') continue;
      const lookupId = `${normalizeName(table.logicalName)}:${normalizeName(column.logicalName)}`;
      if (!relationshipBackedLookups.has(lookupId)) {
        errors.push(
          `${table.logicalName}.${column.logicalName} lookup has no matching many-to-one relationship`,
        );
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

function normalizedContract(contract) {
  const normalized = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    publisherPrefix: String(contract.publisherPrefix).trim().toLowerCase(),
    ...(contract.approvedPlanSha256
      ? { approvedPlanSha256: String(contract.approvedPlanSha256).toLowerCase() }
      : {}),
    ...(contract.approvedContractSha256
      ? { approvedContractSha256: String(contract.approvedContractSha256).toLowerCase() }
      : {}),
    ...(contract.approvalReceiptSha256
      ? { approvalReceiptSha256: String(contract.approvalReceiptSha256).toLowerCase() }
      : {}),
    tables: contract.tables.map((table) => ({
      ...table,
      logicalName: normalizeName(table.logicalName),
      schemaName: String(table.schemaName || table.logicalName).trim(),
      plannedDecision: normalizeName(table.plannedDecision),
      adaptedLogicalName: table.adaptedLogicalName
        ? normalizeName(table.adaptedLogicalName)
        : undefined,
      adaptedSchemaName: table.adaptedSchemaName
        ? String(table.adaptedSchemaName).trim()
        : undefined,
      columns: table.columns.map((column) => ({
        ...column,
        logicalName: normalizeName(column.logicalName),
        schemaName: String(column.schemaName || column.logicalName).trim(),
        plannedDecision: normalizeName(column.plannedDecision),
        adaptedLogicalName: column.adaptedLogicalName
          ? normalizeName(column.adaptedLogicalName)
          : undefined,
        adaptedSchemaName: column.adaptedSchemaName
          ? String(column.adaptedSchemaName).trim()
          : undefined,
        options: column.options ? normalizeOptions(column.options) : undefined,
      })).sort((left, right) => (
        Number(right.primaryName) - Number(left.primaryName)
        || left.logicalName.localeCompare(right.logicalName)
      )),
      relationships: table.relationships.map((relationship) => ({
        ...relationship,
        schemaName: String(relationship.schemaName).trim(),
        plannedDecision: normalizeName(relationship.plannedDecision),
        parentTable: relationship.parentTable
          ? normalizeName(relationship.parentTable)
          : undefined,
        childTable: relationship.childTable
          ? normalizeName(relationship.childTable)
          : undefined,
        entity1: relationship.entity1 ? normalizeName(relationship.entity1) : undefined,
        entity2: relationship.entity2 ? normalizeName(relationship.entity2) : undefined,
        intersectTable: relationship.intersectTable
          ? normalizeName(relationship.intersectTable)
          : undefined,
        adaptedIntersectTable: relationship.adaptedIntersectTable
          ? normalizeName(relationship.adaptedIntersectTable)
          : undefined,
        adaptedSchemaName: relationship.adaptedSchemaName
          ? String(relationship.adaptedSchemaName).trim()
          : undefined,
        lookup: relationship.lookup
          ? {
            ...relationship.lookup,
            logicalName: normalizeName(relationship.lookup.logicalName),
            schemaName: String(
              relationship.lookup.schemaName || relationship.lookup.logicalName,
            ).trim(),
            adaptedLogicalName: relationship.lookup.adaptedLogicalName
              ? normalizeName(relationship.lookup.adaptedLogicalName)
              : undefined,
            adaptedSchemaName: relationship.lookup.adaptedSchemaName
              ? String(relationship.lookup.adaptedSchemaName).trim()
              : undefined,
          }
          : undefined,
      })).sort((left, right) => left.schemaName.localeCompare(right.schemaName)),
      alternateKeys: table.alternateKeys.map((key) => ({
        ...key,
        schemaName: String(key.schemaName).trim(),
        plannedDecision: normalizeName(key.plannedDecision),
        columns: [...key.columns].map(normalizeName).sort((left, right) => left.localeCompare(right)),
      })).sort((left, right) => left.schemaName.localeCompare(right.schemaName)),
    })).sort((left, right) => (
      left.dependencyTier - right.dependencyTier
      || left.logicalName.localeCompare(right.logicalName)
    )),
  };
  const normalizedTableByName = new Map(
    normalized.tables.map((table) => [table.logicalName, table]),
  );
  for (const owner of normalized.tables) {
    for (const relationship of owner.relationships) {
      if (relationship.kind !== 'many-to-one') continue;
      const child = normalizedTableByName.get(
        normalizeName(relationship.childTable || owner.logicalName),
      );
      const lookupColumn = child?.columns.find(
        (column) => column.logicalName === normalizeName(relationship.lookup.logicalName),
      );
      if (lookupColumn) {
        relationship.lookup.requiredLevel = lookupColumn.requiredLevel || 'None';
      }
    }
  }
  return JSON.parse(JSON.stringify(normalized));
}

function contractApprovalContent(contract) {
  const content = normalizedContract(contract);
  delete content.approvedPlanSha256;
  delete content.approvedContractSha256;
  delete content.approvalReceiptSha256;
  return content;
}

function declaredServiceRequiredTableNames(contract) {
  const normalized = contractApprovalContent(contract);
  const names = [];
  for (const table of normalized.tables) {
    if (table.serviceRequired && table.plannedDecision !== 'defer') {
      names.push(
        table.plannedDecision === 'adapt'
          ? table.adaptedLogicalName
          : table.logicalName,
      );
    }
    for (const relationship of table.relationships) {
      if (relationship.kind !== 'many-to-many'
        || !relationship.serviceRequired
        || relationship.plannedDecision === 'defer') continue;
      names.push(
        relationship.plannedDecision === 'adapt'
          ? relationship.adaptedIntersectTable
          : relationship.intersectTable,
      );
    }
  }
  return [...new Set(names.map(normalizeName))]
    .sort((left, right) => left.localeCompare(right));
}

function normalizeServiceDependencies(serviceDependencies) {
  const errors = [];
  if (!serviceDependencies
    || typeof serviceDependencies !== 'object'
    || Array.isArray(serviceDependencies)) {
    return { valid: false, errors: ['service dependencies must be an object'] };
  }
  if (serviceDependencies.schemaVersion !== APPROVAL_RECEIPT_SCHEMA_VERSION) {
    errors.push(
      `service dependencies schemaVersion must equal ${APPROVAL_RECEIPT_SCHEMA_VERSION}`,
    );
  }
  if (!Array.isArray(serviceDependencies.serviceRequiredTables)) {
    errors.push('service dependencies serviceRequiredTables must be an array');
    return { valid: false, errors };
  }
  const tables = [];
  const seen = new Set();
  for (const [index, item] of serviceDependencies.serviceRequiredTables.entries()) {
    const prefix = `serviceRequiredTables[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    const logicalName = normalizeName(item.logicalName);
    validateLogicalName(logicalName, `${prefix}.logicalName`, errors);
    if (seen.has(logicalName)) errors.push(`${prefix}.logicalName must be unique`);
    seen.add(logicalName);
    if (!Array.isArray(item.consumers)
      || item.consumers.length === 0
      || item.consumers.some(
        (consumer) => typeof consumer !== 'string' || !consumer.trim(),
      )) {
      errors.push(`${prefix}.consumers must be a non-empty string array`);
    }
    tables.push({
      logicalName,
      consumers: [...new Set((item.consumers || [])
        .map((consumer) => String(consumer).trim())
        .filter(Boolean))]
        .sort((left, right) => left.localeCompare(right)),
    });
  }
  tables.sort((left, right) => left.logicalName.localeCompare(right.logicalName));
  return { valid: errors.length === 0, errors, tables };
}

function validateApprovalReceipt(approvalReceipt, {
  contract,
  planBytes,
}) {
  const errors = [];
  if (!approvalReceipt
    || typeof approvalReceipt !== 'object'
    || Array.isArray(approvalReceipt)) {
    return { valid: false, errors: ['mobile plan approval receipt must be an object'] };
  }
  if (approvalReceipt.schemaVersion !== APPROVAL_RECEIPT_SCHEMA_VERSION) {
    errors.push(
      `mobile plan approval receipt schemaVersion must equal ${APPROVAL_RECEIPT_SCHEMA_VERSION}`,
    );
  }
  if (approvalReceipt.workflow !== 'create-mobile-app') {
    errors.push('mobile plan approval receipt workflow must equal create-mobile-app');
  }
  const requiredApprovals = [
    'dataModel',
    'nativeCapabilities',
    'connectors',
    'screenPlan',
  ];
  for (const approval of requiredApprovals) {
    const record = approvalReceipt.approvals?.[approval];
    if (record?.status !== 'approved') {
      errors.push(`mobile plan approval receipt ${approval} status must be approved`);
    }
    if (!record?.approvedAt || !Number.isFinite(Date.parse(record.approvedAt))) {
      errors.push(`mobile plan approval receipt ${approval} approvedAt is invalid`);
    }
  }
  const withoutIntegrity = { ...approvalReceipt };
  delete withoutIntegrity.integritySha256;
  if (approvalReceipt.integritySha256 !== sha256(stableJson(withoutIntegrity))) {
    errors.push('mobile plan approval receipt integrity hash does not match');
  }
  if (!planBytes?.length) {
    errors.push('native-app-plan.md is required');
  } else if (approvalReceipt.approvedPlanSha256 !== sha256(planBytes)) {
    errors.push('mobile plan approval receipt plan hash does not match native-app-plan.md');
  }
  const contractValidation = validateContract(contract);
  if (!contractValidation.valid) {
    errors.push(...contractValidation.errors.map((error) => `contract: ${error}`));
    return { valid: false, errors };
  }
  const approvedContractValidation = validateContract(approvalReceipt.approvedContract);
  if (!approvedContractValidation.valid) {
    errors.push(...approvedContractValidation.errors.map(
      (error) => `approved contract: ${error}`,
    ));
  }
  const contractContent = contractApprovalContent(contract);
  if (approvalReceipt.approvedContractSha256
    !== sha256(stableJson(approvalReceipt.approvedContract))) {
    errors.push('mobile plan approval receipt contract hash does not match its content');
  }
  if (stableJson(approvalReceipt.approvedContract) !== stableJson(contractContent)) {
    errors.push('structured contract content does not match the approved contract');
  }
  if (approvalReceipt.approvedContractSha256 !== sha256(stableJson(contractContent))) {
    errors.push('structured contract hash does not match the approved contract hash');
  }
  if (approvalReceipt.approvals?.dataModel?.approvedContractSha256
    !== approvalReceipt.approvedContractSha256) {
    errors.push(
      'data-model approval record does not match the approved contract hash',
    );
  }
  const hiddenCollisionTables = (contract.tables || []).filter(isHiddenNameCollisionAdapt);
  if (hiddenCollisionTables.length > 0) {
    const policyValidation = validateAdaptationPolicy(approvalReceipt.adaptationPolicy);
    if (!policyValidation.valid) {
      errors.push(...policyValidation.errors.map(
        (error) => `mobile plan approval receipt: ${error}`,
      ));
    } else {
      const allowedCodes = new Set(
        approvalReceipt.adaptationPolicy.allowedCollisionCodes.map(normalizeName),
      );
      for (const table of hiddenCollisionTables) {
        if (!allowedCodes.has(normalizeName(table.collisionEvidence?.code))) {
          errors.push(
            `mobile plan approval receipt does not authorize collision code `
            + `${table.collisionEvidence?.code || '<missing>'}`,
          );
        }
      }
    }
  }
  const dependencyValidation = normalizeServiceDependencies({
    schemaVersion: approvalReceipt.schemaVersion,
    serviceRequiredTables: approvalReceipt.serviceRequiredTables,
  });
  if (!dependencyValidation.valid) {
    errors.push(...dependencyValidation.errors.map(
      (error) => `mobile plan approval receipt: ${error}`,
    ));
  } else {
    const declaredServices = declaredServiceRequiredTableNames(contractContent);
    const approvedServices = dependencyValidation.tables.map((item) => item.logicalName);
    if (stableJson(declaredServices) !== stableJson(approvedServices)) {
      errors.push(
        'approved service dependencies do not exactly match contract '
        + 'serviceRequired declarations',
      );
    }
  }
  return { valid: errors.length === 0, errors };
}

function bindContractToPlan(contract, planBytes, approvalReceipt) {
  if (!planBytes?.length) throw new Error('native-app-plan.md is required');
  const validation = validateApprovalReceipt(approvalReceipt, {
    contract,
    planBytes,
  });
  if (!validation.valid) {
    throw new Error(`Invalid mobile plan approval receipt: ${validation.errors.join('; ')}`);
  }
  return normalizedContract({
    ...contract,
    approvedPlanSha256: sha256(planBytes),
    approvedContractSha256: approvalReceipt.approvedContractSha256,
    approvalReceiptSha256: approvalReceipt.integritySha256,
  });
}

function reconciliationScope(contract) {
  const validation = validateContract(contract);
  if (!validation.valid) {
    throw new Error(`Invalid schema contract: ${validation.errors.join('; ')}`);
  }
  const normalized = normalizedContract(contract);
  const intersectNames = normalized.tables.flatMap((table) => (
    table.relationships
      .filter((relationship) => relationship.kind === 'many-to-many')
      .map((relationship) => normalizeName(
        relationship.adaptedIntersectTable || relationship.intersectTable,
      ))
  ));
  const proposedIntersectNames = normalized.tables.flatMap((table) => (
    table.relationships
      .filter((relationship) => (
        relationship.kind === 'many-to-many'
        && ['create', 'adapt'].includes(relationship.plannedDecision)
      ))
      .map((relationship) => normalizeName(
        relationship.adaptedIntersectTable || relationship.intersectTable,
      ))
  ));
  return {
    schemaVersion: 1,
    exactTables: [...new Set([
      ...normalized.tables.map((table) => normalizeName(
        table.plannedDecision === 'adapt'
          ? table.adaptedLogicalName
          : table.logicalName,
      )),
      ...intersectNames,
    ])].sort((left, right) => left.localeCompare(right)),
    proposedTables: [...new Set([
      ...normalized.tables
        .filter((table) => ['create', 'adapt'].includes(table.plannedDecision))
        .map((table) => normalizeName(
          table.plannedDecision === 'adapt'
            ? table.adaptedLogicalName
            : table.logicalName,
        )),
      ...proposedIntersectNames,
    ])].sort((left, right) => left.localeCompare(right)),
  };
}

function snapshotIndexes(snapshot) {
  const inventoryByName = new Map(
    (snapshot.inventory || []).map((table) => [normalizeName(table.logicalName), table]),
  );
  const tableByName = new Map(
    (snapshot.tables || []).map((table) => [normalizeName(table.logicalName), table]),
  );
  const proposedByName = new Map(
    (snapshot.proposedNameChecks?.checked || [])
      .map((item) => [normalizeName(item.logicalName), item]),
  );
  const exactRequested = new Set(
    (snapshot.exactNameResolution?.requestedTables || []).map(normalizeName),
  );
  const exactLoaded = new Set(
    (snapshot.exactNameResolution?.loadedTables || []).map(normalizeName),
  );
  const exactUnavailable = new Set(
    (snapshot.exactNameResolution?.unavailableTables || []).map(normalizeName),
  );
  return {
    inventoryByName,
    tableByName,
    proposedByName,
    exactRequested,
    exactLoaded,
    exactUnavailable,
  };
}

function absenceProven(logicalName, indexes) {
  const key = normalizeName(logicalName);
  return indexes.proposedByName.get(key)?.status === 'missing'
    || (indexes.exactRequested.has(key) && indexes.exactUnavailable.has(key));
}

function presence(logicalName, indexes) {
  const key = normalizeName(logicalName);
  return {
    inventory: indexes.inventoryByName.get(key) || null,
    detail: indexes.tableByName.get(key) || null,
    exactLoaded: indexes.exactLoaded.has(key),
    proposed: indexes.proposedByName.get(key) || null,
  };
}

function isCustomName(logicalName, publisherPrefix) {
  return normalizeName(logicalName).startsWith(`${normalizeName(publisherPrefix)}_`);
}

function metadataValue(value) {
  if (value && typeof value === 'object' && hasOwn(value, 'Value')) return value.Value;
  return value;
}

function compareRequiredEvidence(reasons, liveColumn, field, expected, {
  labelText = field,
  compare = (actual, planned) => actual === planned,
} = {}) {
  const actual = metadataValue(liveColumn[field]);
  if (actual === null || actual === undefined || actual === '') {
    reasons.push(`${labelText} evidence is missing`);
  } else if (!compare(actual, expected)) {
    reasons.push(`${labelText} mismatch: expected ${expected}, got ${actual}`);
  }
}

function expectedColumnConstraints(column) {
  const type = normalizeColumnType(column.type);
  const constraints = [];
  if (type === 'string' || type === 'text') {
    constraints.push(
      ['maxLength', Number(column.maxLength ?? 200), 'MaxLength',
        (actual, expected) => Number(actual) >= expected],
      ['formatName', column.format || 'Text', 'FormatName'],
    );
  } else if (type === 'memo' || type === 'multiline') {
    constraints.push(
      ['maxLength', Number(column.maxLength ?? 10000), 'MaxLength',
        (actual, expected) => Number(actual) >= expected],
      ['format', column.format || 'TextArea', 'Format'],
    );
  } else if (type === 'integer' || type === 'wholenumber') {
    constraints.push(
      ['minValue', Number(column.minValue ?? -2147483648), 'MinValue',
        (actual, expected) => Number(actual) <= expected],
      ['maxValue', Number(column.maxValue ?? 2147483647), 'MaxValue',
        (actual, expected) => Number(actual) >= expected],
      ['format', column.format || 'None', 'Format'],
    );
  } else if (type === 'bigint') {
    if (hasOwn(column, 'minValue')) {
      constraints.push(
        ['minValue', column.minValue, 'MinValue',
          (actual, expected) => Number(actual) <= expected],
      );
    }
    if (hasOwn(column, 'maxValue')) {
      constraints.push(
        ['maxValue', column.maxValue, 'MaxValue',
          (actual, expected) => Number(actual) >= expected],
      );
    }
  } else if (['decimal', 'double', 'float'].includes(type)) {
    constraints.push(
      ['minValue', Number(column.minValue ?? -100000000000), 'MinValue',
        (actual, expected) => Number(actual) <= expected],
      ['maxValue', Number(column.maxValue ?? 100000000000), 'MaxValue',
        (actual, expected) => Number(actual) >= expected],
      ['precision', Number(column.precision ?? 2), 'Precision'],
    );
  } else if (type === 'money' || type === 'currency') {
    constraints.push(
      ['minValue', Number(column.minValue ?? -922337203685477), 'MinValue',
        (actual, expected) => Number(actual) <= expected],
      ['maxValue', Number(column.maxValue ?? 922337203685477), 'MaxValue',
        (actual, expected) => Number(actual) >= expected],
      ['precision', Number(column.precision ?? 2), 'Precision'],
      ['precisionSource', Number(column.precisionSource ?? 2), 'PrecisionSource'],
    );
  } else if (type === 'datetime' || type === 'date') {
    constraints.push(
      ['format', type === 'date' ? 'DateOnly' : (column.format || 'DateAndTime'), 'Format'],
      ['dateTimeBehavior', column.behavior || 'UserLocal', 'DateTimeBehavior'],
    );
  } else if (type === 'boolean') {
    constraints.push(['defaultValue', Boolean(column.defaultValue), 'DefaultValue']);
  } else if (type === 'image') {
    constraints.push(
      ['maxSizeInKB', Number(column.maxSizeInKB), 'MaxSizeInKB',
        (actual, expected) => Number(actual) >= expected],
      ['canStoreFullImage', Boolean(column.canStoreFullImage), 'CanStoreFullImage'],
    );
  } else if (type === 'file') {
    constraints.push(
      ['maxSizeInKB', Number(column.maxSizeInKB ?? 32768), 'MaxSizeInKB',
        (actual, expected) => Number(actual) >= expected],
    );
  }
  return constraints;
}

function baseColumnCompatibility(column, liveColumn) {
  if (!liveColumn) return { compatible: false, reasons: ['column is absent'] };
  const reasons = [];
  const expectedType = dataverseType(column);
  const liveType = canonicalAttributeType(liveColumn.type, liveColumn.typeName);
  if (liveType !== expectedType) {
    reasons.push(`type mismatch: expected ${expectedType}, got ${liveType || '<missing>'}`);
  }
  const expectedTypeName = typeName(column);
  if (expectedTypeName) {
    if (!liveColumn.typeName) {
      reasons.push('type-name evidence is missing');
    } else if (liveColumn.typeName !== expectedTypeName) {
      reasons.push(
        `type-name mismatch: expected ${expectedTypeName}, got ${liveColumn.typeName}`,
      );
    }
  }
  const normalizedColumnType = normalizeColumnType(column.type);
  if (!hasOwn(liveColumn, 'sourceType')) {
    reasons.push('SourceType evidence is missing');
  } else if (liveColumn.sourceType === null
    && !NULL_SOURCE_TYPE_IS_ORDINARY_TYPES.has(normalizedColumnType)) {
    reasons.push('SourceType evidence is missing');
  } else if (!DERIVED_COLUMN_TYPES.has(normalizedColumnType)
    && Number(liveColumn.sourceType) !== 0) {
    reasons.push(`ordinary column has SourceType ${liveColumn.sourceType}`);
  }
  compareRequiredEvidence(
    reasons,
    liveColumn,
    'requiredLevel',
    column.requiredLevel || 'None',
    { labelText: 'RequiredLevel' },
  );
  if (hasOwn(column, 'primaryName')) {
    compareRequiredEvidence(
      reasons,
      liveColumn,
      'primaryName',
      Boolean(column.primaryName),
      {
        labelText: 'IsPrimaryName',
        compare: (actual, expected) => Boolean(actual) === expected,
      },
    );
  }
  for (const [field, expected, labelText, compare] of expectedColumnConstraints(column)) {
    compareRequiredEvidence(reasons, liveColumn, field, expected, {
      labelText,
      compare,
    });
  }
  return { compatible: reasons.length === 0, reasons };
}

function derivedExpected(tableName, column) {
  const kind = normalizeColumnType(column.type);
  if (kind === 'lookup') {
    return {
      table: tableName,
      logicalName: column.logicalName,
      kind: 'lookup',
      type: 'Lookup',
      sourceType: 0,
      lookupTarget: normalizeName(column.lookupTarget),
    };
  }
  if (kind === 'choice' || kind === 'multiselectchoice') {
    return {
      table: tableName,
      logicalName: column.logicalName,
      kind: 'choice',
      type: dataverseType(column),
      sourceType: 0,
      options: column.options,
    };
  }
  if (kind === 'boolean') {
    return {
      table: tableName,
      logicalName: column.logicalName,
      kind: 'boolean',
      type: 'Boolean',
      sourceType: 0,
      options: column.options,
    };
  }
  if (isComputedColumn(column)) {
    return {
      table: tableName,
      logicalName: column.logicalName,
      kind: 'computed',
      type: dataverseType(column),
      sourceType: Number(column.sourceType),
      sourceTypeMask: Number(column.sourceTypeMask),
      formulaDefinition: column.formulaDefinition,
    };
  }
  return null;
}

function columnCompatibility(tableName, column, liveColumn) {
  const base = baseColumnCompatibility(column, liveColumn);
  if (!base.compatible) return base;
  const expected = derivedExpected(tableName, column);
  if (!expected) return base;
  const compared = compareDerivedColumn(expected, {
    type: liveColumn.type,
    sourceType: liveColumn.sourceType,
    sourceTypeMask: liveColumn.sourceTypeMask,
    lookupTargets: liveColumn.lookupTargets,
    options: liveColumn.choices,
    formulaDefinition: liveColumn.formulaDefinition || liveColumn.formula,
  });
  return compared;
}

function columnPayload(column, effectiveLogicalName = column.logicalName) {
  const type = normalizeColumnType(column.type);
  const schemaName = column.adaptedSchemaName
    || (effectiveLogicalName === column.logicalName
      ? column.schemaName
      : effectiveLogicalName);
  const common = {
    SchemaName: schemaName,
    DisplayName: label(column.displayName || schemaName),
    RequiredLevel: requiredLevel(column.requiredLevel),
  };
  if (column.primaryName) common.IsPrimaryName = true;

  if (type === 'string' || type === 'text') {
    return {
      '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
      ...common,
      MaxLength: Number(column.maxLength || 200),
      FormatName: { Value: column.format || 'Text' },
    };
  }
  if (type === 'memo' || type === 'multiline') {
    return {
      '@odata.type': 'Microsoft.Dynamics.CRM.MemoAttributeMetadata',
      ...common,
      MaxLength: Number(column.maxLength || 10000),
      Format: column.format || 'TextArea',
    };
  }
  if (type === 'integer' || type === 'wholenumber') {
    return {
      '@odata.type': 'Microsoft.Dynamics.CRM.IntegerAttributeMetadata',
      ...common,
      MinValue: Number(column.minValue ?? -2147483648),
      MaxValue: Number(column.maxValue ?? 2147483647),
      Format: column.format || 'None',
    };
  }
  if (type === 'bigint') {
    const payload = {
      '@odata.type': 'Microsoft.Dynamics.CRM.BigIntAttributeMetadata',
      ...common,
    };
    if (hasOwn(column, 'minValue')) payload.MinValue = column.minValue;
    if (hasOwn(column, 'maxValue')) payload.MaxValue = column.maxValue;
    return payload;
  }
  if (type === 'decimal' || type === 'double' || type === 'float') {
    const metadataType = type === 'decimal' ? 'Decimal' : 'Double';
    return {
      '@odata.type': `Microsoft.Dynamics.CRM.${metadataType}AttributeMetadata`,
      ...common,
      MinValue: Number(column.minValue ?? -100000000000),
      MaxValue: Number(column.maxValue ?? 100000000000),
      Precision: Number(column.precision ?? 2),
    };
  }
  if (type === 'money' || type === 'currency') {
    return {
      '@odata.type': 'Microsoft.Dynamics.CRM.MoneyAttributeMetadata',
      ...common,
      MinValue: Number(column.minValue ?? -922337203685477),
      MaxValue: Number(column.maxValue ?? 922337203685477),
      Precision: Number(column.precision ?? 2),
      PrecisionSource: Number(column.precisionSource ?? 2),
    };
  }
  if (type === 'datetime' || type === 'date') {
    return {
      '@odata.type': 'Microsoft.Dynamics.CRM.DateTimeAttributeMetadata',
      ...common,
      Format: type === 'date' ? 'DateOnly' : (column.format || 'DateAndTime'),
      DateTimeBehavior: { Value: column.behavior || 'UserLocal' },
    };
  }
  if (type === 'boolean') {
    const options = normalizeOptions(column.options);
    const falseOption = options.find((option) => option.value === 0);
    const trueOption = options.find((option) => option.value === 1);
    return {
      '@odata.type': 'Microsoft.Dynamics.CRM.BooleanAttributeMetadata',
      ...common,
      DefaultValue: Boolean(column.defaultValue),
      OptionSet: {
        '@odata.type': 'Microsoft.Dynamics.CRM.BooleanOptionSetMetadata',
        TrueOption: { Value: 1, Label: label(trueOption.label) },
        FalseOption: { Value: 0, Label: label(falseOption.label) },
      },
    };
  }
  if (type === 'choice' || type === 'multiselectchoice') {
    const metadataType = type === 'choice'
      ? 'PicklistAttributeMetadata'
      : 'MultiSelectPicklistAttributeMetadata';
    return {
      '@odata.type': `Microsoft.Dynamics.CRM.${metadataType}`,
      ...common,
      OptionSet: {
        '@odata.type': 'Microsoft.Dynamics.CRM.OptionSetMetadata',
        IsGlobal: false,
        OptionSetType: 'Picklist',
        Options: normalizeOptions(column.options).map((option) => ({
          Value: option.value,
          Label: label(option.label),
        })),
      },
    };
  }
  if (type === 'image') {
    return {
      '@odata.type': 'Microsoft.Dynamics.CRM.ImageAttributeMetadata',
      ...common,
      MaxSizeInKB: Number(column.maxSizeInKB),
      CanStoreFullImage: Boolean(column.canStoreFullImage),
    };
  }
  if (type === 'file') {
    return {
      '@odata.type': 'Microsoft.Dynamics.CRM.FileAttributeMetadata',
      ...common,
      MaxSizeInKB: Number(column.maxSizeInKB || 32768),
    };
  }
  throw new Error(`Unsupported ordinary column type: ${column.type}`);
}

function tablePayload(table, effectiveName, ordinaryColumns) {
  const primaryName = ordinaryColumns.find((column) => column.primaryName);
  if (!primaryName) throw new Error(`${table.logicalName} has no primary-name column`);
  const attributes = ordinaryColumns.map((column) => (
    columnPayload(column, column.effectiveLogicalName)
  ));
  const schemaNames = attributes.map((attribute) => normalizeName(attribute.SchemaName));
  if (new Set(schemaNames).size !== schemaNames.length) {
    throw new Error(`${table.logicalName} has duplicate inline column SchemaName values`);
  }
  if (attributes.filter((attribute) => attribute.IsPrimaryName).length !== 1) {
    throw new Error(`${table.logicalName} must have exactly one inline primary-name column`);
  }
  return {
    '@odata.type': 'Microsoft.Dynamics.CRM.EntityMetadata',
    SchemaName: table.adaptedSchemaName
      || (effectiveName === table.logicalName ? table.schemaName : effectiveName),
    DisplayName: label(table.displayName || effectiveName),
    DisplayCollectionName: label(
      table.displayCollectionName || `${table.displayName || effectiveName}s`,
    ),
    OwnershipType: table.ownershipType || 'UserOwned',
    HasActivities: Boolean(table.hasActivities),
    HasNotes: Boolean(table.hasNotes),
    IsAvailableOffline: table.isAvailableOffline !== false,
    ChangeTrackingEnabled: table.changeTrackingEnabled !== false,
    PrimaryNameAttribute: normalizeName(primaryName.effectiveLogicalName),
    Attributes: attributes,
  };
}

function plannedCascadeConfiguration(relationship) {
  return {
    Assign: relationship.cascadeConfiguration?.Assign || 'NoCascade',
    Delete: relationship.cascadeConfiguration?.Delete
      || relationship.deleteBehavior
      || 'RemoveLink',
    Merge: relationship.cascadeConfiguration?.Merge || 'NoCascade',
    Reparent: relationship.cascadeConfiguration?.Reparent || 'NoCascade',
    Share: relationship.cascadeConfiguration?.Share || 'NoCascade',
    Unshare: relationship.cascadeConfiguration?.Unshare || 'NoCascade',
    RollupView: relationship.cascadeConfiguration?.RollupView || 'NoCascade',
  };
}

function cascadeConfigurationMatches(actual, expected) {
  return actual
    && Object.entries(expected).every(([key, value]) => (
      hasOwn(actual, key) && actual[key] === value
    ));
}

function relationshipPayload(relationship, aliases) {
  if (relationship.kind === 'many-to-one') {
    const childTable = aliases.tables.get(normalizeName(
      relationship.childTable,
    )) || normalizeName(relationship.childTable);
    const parentTable = aliases.tables.get(normalizeName(
      relationship.parentTable,
    )) || normalizeName(relationship.parentTable);
    const lookupName = relationship.lookup.adaptedLogicalName || aliases.columns.get(
      `${childTable}:${normalizeName(relationship.lookup.logicalName)}`,
    ) || normalizeName(relationship.lookup.logicalName);
    return {
      '@odata.type': 'Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata',
      SchemaName: relationship.adaptedSchemaName || relationship.schemaName,
      ReferencedEntity: parentTable,
      ReferencingEntity: childTable,
      Lookup: {
        '@odata.type': 'Microsoft.Dynamics.CRM.LookupAttributeMetadata',
        SchemaName: relationship.lookup.adaptedSchemaName
          || relationship.lookup.schemaName
          || lookupName,
        DisplayName: label(relationship.lookup.displayName || lookupName),
        RequiredLevel: requiredLevel(relationship.lookup.requiredLevel),
      },
      AssociatedMenuConfiguration: {
        Behavior: 'UseCollectionName',
        Group: 'Details',
        Order: 10000,
      },
      CascadeConfiguration: plannedCascadeConfiguration(relationship),
    };
  }

  const entity1 = aliases.tables.get(normalizeName(relationship.entity1))
    || normalizeName(relationship.entity1);
  const entity2 = aliases.tables.get(normalizeName(relationship.entity2))
    || normalizeName(relationship.entity2);
  return {
    '@odata.type': 'Microsoft.Dynamics.CRM.ManyToManyRelationshipMetadata',
    SchemaName: relationship.adaptedSchemaName || relationship.schemaName,
    Entity1LogicalName: entity1,
    Entity2LogicalName: entity2,
    IntersectEntityName: relationship.adaptedIntersectTable || relationship.intersectTable,
    Entity1AssociatedMenuConfiguration: {
      Behavior: 'UseLabel',
      Group: 'Details',
      Label: label(relationship.entity2DisplayCollectionName || entity2),
      Order: 10000,
    },
    Entity2AssociatedMenuConfiguration: {
      Behavior: 'UseLabel',
      Group: 'Details',
      Label: label(relationship.entity1DisplayCollectionName || entity1),
      Order: 10000,
    },
  };
}

function keyPayload(key, aliases, effectiveTable) {
  return {
    '@odata.type': 'Microsoft.Dynamics.CRM.EntityKeyMetadata',
    SchemaName: key.adaptedSchemaName || key.schemaName,
    DisplayName: label(key.displayName || `${key.schemaName} Key`),
    KeyAttributes: key.columns.map((column) => (
      aliases.columns.get(`${effectiveTable}:${normalizeName(column)}`) || normalizeName(column)
    )),
  };
}

function makeDecision({
  itemId,
  itemType,
  requestedName,
  effectiveName,
  decision,
  operation,
  reason,
  table,
}) {
  if (!DECISIONS.has(decision)) throw new Error(`Invalid decision ${decision}`);
  return {
    itemId,
    itemType,
    table: table || null,
    requestedName,
    effectiveName,
    decision,
    operation,
    reason,
  };
}

function compatibleTableColumns(table, liveTable) {
  const liveByName = new Map(
    (liveTable?.columns || []).map((column) => [normalizeName(column.logicalName), column]),
  );
  return table.columns.map((column) => {
    const targetName = normalizeName(column.adaptedLogicalName || column.logicalName);
    const liveColumn = liveByName.get(targetName);
    return {
      column,
      targetName,
      liveColumn,
      comparison: liveColumn
        ? columnCompatibility(liveTable.logicalName, {
          ...column,
          logicalName: targetName,
        }, liveColumn)
        : null,
    };
  });
}

function tableCreateCompatibility(table, effectiveName, liveTable) {
  const reasons = [];
  const primaryName = table.columns.find((column) => column.primaryName);
  const expected = {
    schemaName: normalizeName(
      table.adaptedSchemaName
      || (effectiveName === table.logicalName ? table.schemaName : effectiveName),
    ),
    displayName: table.displayName || effectiveName,
    displayCollectionName: table.displayCollectionName
      || `${table.displayName || effectiveName}s`,
    ownershipType: table.ownershipType || 'UserOwned',
    hasActivities: Boolean(table.hasActivities),
    hasNotes: Boolean(table.hasNotes),
    isAvailableOffline: table.isAvailableOffline !== false,
    changeTrackingEnabled: table.changeTrackingEnabled !== false,
    primaryNameAttribute: normalizeName(
      primaryName?.adaptedLogicalName || primaryName?.logicalName,
    ),
  };
  const comparisons = [
    ['schemaName', expected.schemaName, (actual, planned) => normalizeName(actual) === planned],
    ['displayName', expected.displayName],
    ['displayCollectionName', expected.displayCollectionName],
    ['ownershipType', expected.ownershipType,
      (actual, planned) => normalizeName(actual) === normalizeName(planned)],
    ['hasActivities', expected.hasActivities],
    ['hasNotes', expected.hasNotes],
    ['isAvailableOffline', expected.isAvailableOffline],
    ['changeTrackingEnabled', expected.changeTrackingEnabled],
    ['primaryNameAttribute', expected.primaryNameAttribute,
      (actual, planned) => normalizeName(actual) === planned],
  ];
  for (const [field, planned, compare = (actual, value) => actual === value] of comparisons) {
    if (!hasOwn(liveTable, field)
      || liveTable[field] === null
      || liveTable[field] === undefined) {
      reasons.push(`${field} evidence is missing`);
    } else if (!compare(liveTable[field], planned)) {
      reasons.push(`${field} mismatch: expected ${planned}, got ${liveTable[field]}`);
    }
  }
  return { compatible: reasons.length === 0, reasons };
}

function relationshipExists(relationship, snapshotTable, aliases) {
  if (!snapshotTable) return { verified: false, exists: false, compatible: false };
  const expectedSchema = normalizeName(
    relationship.adaptedSchemaName || relationship.schemaName,
  );
  if (relationship.kind === 'many-to-one') {
    const expectedTarget = aliases.tables.get(normalizeName(relationship.parentTable))
      || normalizeName(relationship.parentTable);
    const expectedLookup = normalizeName(
      relationship.lookup.adaptedLogicalName || relationship.lookup.logicalName,
    );
    const candidates = snapshotTable.manyToOneRelationships || [];
    const existing = candidates.find((item) => (
      normalizeName(item.schemaName) === expectedSchema
      || normalizeName(item.lookupColumn) === expectedLookup
    ));
    if (!existing) return { verified: true, exists: false, compatible: false };
    return {
      verified: true,
      exists: true,
      compatible: normalizeName(existing.schemaName) === expectedSchema
        && normalizeName(existing.targetTable) === expectedTarget
        && normalizeName(existing.lookupColumn) === expectedLookup
        && cascadeConfigurationMatches(
          existing.cascadeConfiguration,
          plannedCascadeConfiguration(relationship),
        ),
      existing,
    };
  }
  const expectedIntersect = normalizeName(
    relationship.adaptedIntersectTable || relationship.intersectTable,
  );
  const existing = (snapshotTable.manyToManyRelationships || []).find((item) => (
    normalizeName(item.schemaName) === expectedSchema
    || normalizeName(item.intersectTable) === expectedIntersect
  ));
  if (!existing) return { verified: true, exists: false, compatible: false };
  const expected = new Set([
    aliases.tables.get(normalizeName(relationship.entity1))
      || normalizeName(relationship.entity1),
    aliases.tables.get(normalizeName(relationship.entity2))
      || normalizeName(relationship.entity2),
  ]);
  const actual = new Set([normalizeName(existing.entity1), normalizeName(existing.entity2)]);
  return {
    verified: true,
    exists: true,
    compatible: normalizeName(existing.schemaName) === expectedSchema
      && normalizeName(existing.intersectTable) === expectedIntersect
      && expected.size === actual.size
      && [...expected].every((name) => actual.has(name)),
    existing,
  };
}

function keyExists(key, snapshotTable, aliases, effectiveTable) {
  if (!snapshotTable) return { verified: false, exists: false, compatible: false };
  const expectedColumns = key.columns.map((column) => (
    aliases.columns.get(`${effectiveTable}:${normalizeName(column)}`) || normalizeName(column)
  )).sort();
  const expectedSchema = normalizeName(key.adaptedSchemaName || key.schemaName);
  const existing = (snapshotTable.alternateKeys || []).find((item) => (
    normalizeName(item.schemaName) === expectedSchema
    || JSON.stringify((item.columns || []).map(normalizeName).sort()) === JSON.stringify(expectedColumns)
  ));
  if (!existing) return { verified: true, exists: false, compatible: false };
  const actualColumns = (existing.columns || []).map(normalizeName).sort();
  return {
    verified: true,
    exists: true,
    compatible: normalizeName(existing.schemaName) === expectedSchema
      && JSON.stringify(actualColumns) === JSON.stringify(expectedColumns)
      && normalizeName(existing.status) !== 'failed',
    existing,
  };
}

function operation(index, id, phase, apiPath, body, solution) {
  return {
    index,
    id,
    phase,
    method: 'POST',
    apiPath,
    body,
    solution,
  };
}

function requiresFullImageConfiguration(column) {
  return normalizeColumnType(column?.type) === 'image'
    && column.canStoreFullImage === true;
}

function imageConfigurationOperation(
  index,
  tableLogicalName,
  column,
  solution,
) {
  const columnLogicalName = normalizeName(
    column.effectiveLogicalName || column.adaptedLogicalName || column.logicalName,
  );
  return {
    ...operation(
      index,
      `configure-image:${tableLogicalName}:${columnLogicalName}`,
      'extensions',
      `EntityDefinitions(LogicalName='${tableLogicalName}')/Attributes(`
        + `LogicalName='${columnLogicalName}')`,
      {
        ...columnPayload(column, columnLogicalName),
        AttributeTypeName: { Value: 'ImageType' },
        CanStoreFullImage: true,
      },
      solution,
    ),
    method: 'PUT',
  };
}

function repairableFullImageConfiguration(column, liveColumn) {
  if (!requiresFullImageConfiguration(column) || !liveColumn) return false;
  const actualMaxSizeInKB = Number(liveColumn.maxSizeInKB);
  if (!Number.isFinite(actualMaxSizeInKB) || actualMaxSizeInKB < 1) return false;
  if (liveColumn.canStoreFullImage === true
    && actualMaxSizeInKB >= Number(column.maxSizeInKB)) {
    return false;
  }
  return baseColumnCompatibility({
    ...column,
    canStoreFullImage: Boolean(liveColumn.canStoreFullImage),
    maxSizeInKB: actualMaxSizeInKB,
  }, liveColumn).compatible;
}

function isImageConfigurationOperation(item) {
  const match = String(item?.id || '').match(
    /^configure-image:([a-z][a-z0-9_]*):([a-z][a-z0-9_]*)$/i,
  );
  if (!match) return false;
  const tableLogicalName = normalizeName(match[1]);
  const columnLogicalName = normalizeName(match[2]);
  const body = item.body || {};
  return item.phase === 'extensions'
    && item.enclosingPhase === 'extensions'
    && item.method === 'PUT'
    && item.apiPath === `EntityDefinitions(LogicalName='${tableLogicalName}')/Attributes(`
      + `LogicalName='${columnLogicalName}')`
    && body['@odata.type'] === 'Microsoft.Dynamics.CRM.ImageAttributeMetadata'
    && normalizeName(body.SchemaName) === columnLogicalName
    && body.AttributeTypeName?.Value === 'ImageType'
    && body.CanStoreFullImage === true
    && Number.isInteger(body.MaxSizeInKB)
    && body.MaxSizeInKB >= 1
    && body.MaxSizeInKB <= MAX_IMAGE_SIZE_IN_KB
    && !hasOwn(body, 'MaxHeight')
    && !hasOwn(body, 'MaxWidth')
    && body.IsPrimaryId !== true;
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function publishCheckpointCore({
  context,
  planSha256,
  structuredSchemaSha256,
  tables,
  createdAt,
  rollForwards = [],
}) {
  const checkpoint = {
    schemaVersion: PUBLISH_CHECKPOINT_SCHEMA_VERSION,
    createdAt,
    binding: {
      environmentId: context.environmentId,
      environmentUrl: String(context.environmentUrl).replace(/\/+$/, ''),
      tenantId: context.tenantId || null,
      publisherPrefix: normalizeName(context.publisherPrefix),
      solutionUniqueName: context.solutionUniqueName,
      planSha256,
      structuredSchemaSha256,
    },
    tables: [...new Set(tables.map(normalizeName))]
      .sort((left, right) => left.localeCompare(right)),
  };
  if (rollForwards.length > 0) checkpoint.rollForwards = stableClone(rollForwards);
  return checkpoint;
}

function createPublishCheckpoint(options) {
  const checkpoint = publishCheckpointCore(options);
  checkpoint.integritySha256 = sha256(stableJson(checkpoint));
  return checkpoint;
}

function validatePublishCheckpoint(checkpoint, {
  context,
  planSha256,
  structuredSchemaSha256,
  allowedTables,
}) {
  const errors = [];
  if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) {
    return { valid: false, errors: ['publish checkpoint must be an object'] };
  }
  if (checkpoint.schemaVersion !== PUBLISH_CHECKPOINT_SCHEMA_VERSION) {
    errors.push(
      `publish checkpoint schemaVersion must equal ${PUBLISH_CHECKPOINT_SCHEMA_VERSION}`,
    );
  }
  const withoutIntegrity = { ...checkpoint };
  delete withoutIntegrity.integritySha256;
  if (checkpoint.integritySha256 !== sha256(stableJson(withoutIntegrity))) {
    errors.push('publish checkpoint integrity hash does not match');
  }
  const binding = checkpoint.binding || {};
  if (binding.environmentId !== context.environmentId) {
    errors.push('publish checkpoint environmentId mismatch');
  }
  if (normalizeUrl(binding.environmentUrl) !== normalizeUrl(context.environmentUrl)) {
    errors.push('publish checkpoint environmentUrl mismatch');
  }
  if (context.tenantId && normalizeName(binding.tenantId) !== normalizeName(context.tenantId)) {
    errors.push('publish checkpoint tenantId mismatch');
  }
  if (normalizeName(binding.publisherPrefix) !== normalizeName(context.publisherPrefix)) {
    errors.push('publish checkpoint publisherPrefix mismatch');
  }
  if (binding.solutionUniqueName !== context.solutionUniqueName) {
    errors.push('publish checkpoint solutionUniqueName mismatch');
  }
  if (binding.planSha256 !== planSha256) errors.push('publish checkpoint plan hash mismatch');
  if (binding.structuredSchemaSha256 !== structuredSchemaSha256) {
    errors.push('publish checkpoint structured schema hash mismatch');
  }
  if (!Array.isArray(checkpoint.tables) || checkpoint.tables.length === 0) {
    errors.push('publish checkpoint tables must be a non-empty array');
  } else {
    const normalizedTables = checkpoint.tables.map(normalizeName);
    if (new Set(normalizedTables).size !== normalizedTables.length) {
      errors.push('publish checkpoint tables must be unique');
    }
    for (const table of normalizedTables) {
      if (!/^[a-z][a-z0-9_]*$/i.test(table)) {
        errors.push(`publish checkpoint table ${table} is malformed`);
      } else if (allowedTables && !allowedTables.has(table)) {
        errors.push(`publish checkpoint table ${table} is outside the bound contract`);
      }
    }
  }
  if (typeof checkpoint.createdAt !== 'string'
    || Number.isNaN(Date.parse(checkpoint.createdAt))) {
    errors.push('publish checkpoint createdAt must be an ISO timestamp');
  }
  if (checkpoint.rollForwards !== undefined) {
    if (!Array.isArray(checkpoint.rollForwards)) {
      errors.push('publish checkpoint rollForwards must be an array');
    } else {
      for (const [index, rollForward] of checkpoint.rollForwards.entries()) {
        const prefix = `publish checkpoint rollForwards[${index}]`;
        if (!/^[a-f0-9]{64}$/i.test(String(rollForward?.previousIntegritySha256 || ''))) {
          errors.push(`${prefix}.previousIntegritySha256 is malformed`);
        }
        const previousCheckpoint = rollForward?.previousCheckpoint;
        if (!previousCheckpoint || typeof previousCheckpoint !== 'object') {
          errors.push(`${prefix}.previousCheckpoint must preserve the prior artifact`);
        } else {
          const previousWithoutIntegrity = { ...previousCheckpoint };
          delete previousWithoutIntegrity.integritySha256;
          if (previousCheckpoint.integritySha256
            !== sha256(stableJson(previousWithoutIntegrity))
            || previousCheckpoint.integritySha256
              !== rollForward.previousIntegritySha256) {
            errors.push(`${prefix}.previousCheckpoint integrity does not match`);
          }
          if (stableJson(previousCheckpoint.binding)
            !== stableJson(rollForward.previousBinding)
            || stableJson(previousCheckpoint.tables)
              !== stableJson(rollForward.previousTables)) {
            errors.push(`${prefix}.previousCheckpoint evidence does not match`);
          }
        }
        if (!Array.isArray(rollForward?.previousTables)
          || rollForward.previousTables.length === 0) {
          errors.push(`${prefix}.previousTables must preserve prior table evidence`);
        }
        if (!Array.isArray(rollForward?.tableMappings)) {
          errors.push(`${prefix}.tableMappings must be an array`);
        }
        if (!/^[a-f0-9]{64}$/i.test(String(
          rollForward?.collisionOperationFingerprint || '',
        ))) {
          errors.push(`${prefix}.collisionOperationFingerprint is malformed`);
        }
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

function operationAffectedPublishTables(operation) {
  if (String(operation?.id || '').startsWith('create-table:')) {
    return [logicalNameFromSchemaName(operation.body?.SchemaName)];
  }
  if (String(operation?.id || '').startsWith('extend-column:')
    || String(operation?.id || '').startsWith('configure-image:')
    || String(operation?.id || '').startsWith('create-key:')) {
    const match = String(operation.apiPath || '').match(
      /EntityDefinitions\(LogicalName='([^']+)'\)/,
    );
    return match ? [normalizeName(match[1])] : [];
  }
  if (String(operation?.id || '').startsWith('create-relationship:')) {
    const table = operation.body?.ReferencingEntity || operation.body?.Entity1LogicalName;
    return table ? [normalizeName(table)] : [];
  }
  return [];
}

function revisedEquivalentOperation(previousOperation, previousManifest, normalized, context) {
  const expectedItemType = String(previousOperation?.id || '').startsWith('create-table:')
    ? 'table'
    : String(previousOperation?.id || '').startsWith('extend-column:')
      || String(previousOperation?.id || '').startsWith('configure-image:')
      ? 'column'
      : String(previousOperation?.id || '').startsWith('create-relationship:')
        ? 'relationship'
        : String(previousOperation?.id || '').startsWith('create-key:')
          ? 'key'
          : null;
  let decision = (previousManifest.decisions || []).find(
    (item) => item.operation === previousOperation.id
      && item.itemType === expectedItemType,
  );
  const imageConfigurationMatch = String(previousOperation?.id || '').match(
    /^configure-image:([a-z][a-z0-9_]*):([a-z][a-z0-9_]*)$/i,
  );
  if (!decision && imageConfigurationMatch) {
    const previousTable = normalizeName(imageConfigurationMatch[1]);
    const previousColumn = normalizeName(imageConfigurationMatch[2]);
    decision = (previousManifest.decisions || []).find((item) => (
      item.itemType === 'column'
      && normalizeName(item.effectiveName) === previousColumn
      && normalizeName(
        previousManifest.aliases?.tables?.[normalizeName(item.table)] || item.table,
      ) === previousTable
    ));
  }
  if (!decision) return null;
  const table = normalized.tables.find(
    (item) => item.logicalName === normalizeName(
      decision.itemType === 'table' ? decision.requestedName : decision.table,
    ),
  );
  if (!table) return null;
  const aliases = { tables: new Map(), columns: new Map() };
  for (const candidate of normalized.tables) {
    if (candidate.plannedDecision === 'adapt') {
      aliases.tables.set(candidate.logicalName, normalizeName(candidate.adaptedLogicalName));
    }
    const effectiveTable = candidate.plannedDecision === 'adapt'
      ? normalizeName(candidate.adaptedLogicalName)
      : candidate.logicalName;
    for (const column of candidate.columns) {
      if (column.plannedDecision === 'adapt') {
        aliases.columns.set(
          `${effectiveTable}:${column.logicalName}`,
          normalizeName(column.adaptedLogicalName),
        );
      }
    }
  }
  const effectiveTable = aliases.tables.get(table.logicalName) || table.logicalName;

  if (decision.itemType === 'table') {
    if (!['create', 'adapt'].includes(table.plannedDecision)) return null;
    const ordinaryColumns = table.columns
      .filter((column) => (
        ['create', 'adapt'].includes(column.plannedDecision)
        && normalizeColumnType(column.type) !== 'lookup'
        && !isComputedColumn(column)
      ))
      .map((column) => ({
        ...column,
        effectiveLogicalName: normalizeName(column.adaptedLogicalName || column.logicalName),
      }));
    return operation(
      0,
      `create-table:${effectiveTable}`,
      'tableCreates',
      'EntityDefinitions',
      tablePayload(table, effectiveTable, ordinaryColumns),
      context.solutionUniqueName,
    );
  }
  if (decision.itemType === 'column') {
    const column = table.columns.find(
      (item) => item.logicalName === normalizeName(decision.requestedName),
    );
    if (!column || !['create', 'adapt'].includes(column.plannedDecision)
      || normalizeColumnType(column.type) === 'lookup' || isComputedColumn(column)) {
      return null;
    }
    const effectiveColumn = normalizeName(
      column.adaptedLogicalName || column.logicalName,
    );
    if (String(previousOperation?.id || '').startsWith('configure-image:')) {
      if (!requiresFullImageConfiguration(column)) return null;
      return imageConfigurationOperation(
        0,
        effectiveTable,
        { ...column, effectiveLogicalName: effectiveColumn },
        context.solutionUniqueName,
      );
    }
    return operation(
      0,
      `extend-column:${effectiveTable}:${effectiveColumn}`,
      'extensions',
      `EntityDefinitions(LogicalName='${effectiveTable}')/Attributes`,
      columnPayload(column, effectiveColumn),
      context.solutionUniqueName,
    );
  }
  if (decision.itemType === 'relationship') {
    const relationship = table.relationships.find(
      (item) => normalizeName(item.schemaName) === normalizeName(decision.requestedName),
    );
    if (!relationship || !['create', 'adapt'].includes(relationship.plannedDecision)) {
      return null;
    }
    const payload = relationshipPayload(relationship, aliases);
    return operation(
      0,
      `create-relationship:${normalizeName(payload.SchemaName)}`,
      'relationships',
      'RelationshipDefinitions',
      payload,
      context.solutionUniqueName,
    );
  }
  if (decision.itemType === 'key') {
    const key = table.alternateKeys.find(
      (item) => normalizeName(item.schemaName) === normalizeName(decision.requestedName),
    );
    if (!key || !['create', 'adapt'].includes(key.plannedDecision)) return null;
    const payload = keyPayload(key, aliases, effectiveTable);
    return operation(
      0,
      `create-key:${effectiveTable}:${normalizeName(payload.SchemaName)}`,
      'alternateKeys',
      `EntityDefinitions(LogicalName='${effectiveTable}')/Keys`,
      payload,
      context.solutionUniqueName,
    );
  }
  return null;
}

function rollForwardPublishCheckpoint({
  checkpoint,
  previousManifest,
  journal,
  contract,
  approvalReceipt,
  contractBytes,
  planBytes,
  context,
  rolledAt = new Date().toISOString(),
}) {
  const contractValidation = validateContract(contract);
  if (!contractValidation.valid) {
    throw new Error(`Invalid revised schema contract: ${contractValidation.errors.join('; ')}`);
  }
  if (!contractBytes?.length || !planBytes?.length) {
    throw new Error('revised contract and plan bytes are required');
  }
  const normalized = normalizedContract(contract);
  const planSha256 = sha256(planBytes);
  const structuredSchemaSha256 = sha256(contractBytes);
  const approvalValidation = validateApprovalReceipt(approvalReceipt, {
    contract,
    planBytes,
  });
  if (!approvalValidation.valid) {
    throw new Error(
      `Invalid revised mobile plan approval receipt: ${approvalValidation.errors.join('; ')}`,
    );
  }
  if (normalized.approvedPlanSha256 !== planSha256) {
    throw new Error(
      'revised structured schema approvedPlanSha256 does not match native-app-plan.md',
    );
  }
  if (normalized.approvedContractSha256
      !== approvalReceipt.approvedContractSha256
    || normalized.approvalReceiptSha256
      !== approvalReceipt.integritySha256) {
    throw new Error('revised structured schema approval binding does not match receipt');
  }
  if (normalizeName(normalized.publisherPrefix) !== normalizeName(context.publisherPrefix)) {
    throw new Error('revised publisherPrefix does not match execution context');
  }

  const priorCheckpointValidation = validatePublishCheckpoint(checkpoint, {
    context,
    planSha256: checkpoint?.binding?.planSha256,
    structuredSchemaSha256: checkpoint?.binding?.structuredSchemaSha256,
  });
  if (!priorCheckpointValidation.valid) {
    throw new Error(
      `Invalid prior publish checkpoint: ${priorCheckpointValidation.errors.join('; ')}`,
    );
  }
  if (!previousManifest || previousManifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new Error('previous manifest schemaVersion is invalid');
  }
  const previousWithoutIntegrity = { ...previousManifest };
  delete previousWithoutIntegrity.integritySha256;
  if (previousManifest.integritySha256 !== sha256(stableJson(previousWithoutIntegrity))) {
    throw new Error('previous manifest integrity hash does not match');
  }
  if (stableJson(previousManifest.publishCheckpoint) !== stableJson(checkpoint)) {
    throw new Error('prior publish checkpoint does not match the previous manifest');
  }
  if (previousManifest.binding?.planSha256 !== checkpoint.binding.planSha256
    || previousManifest.binding?.structuredSchemaSha256
      !== checkpoint.binding.structuredSchemaSha256
    || previousManifest.binding?.environmentId !== context.environmentId
    || normalizeUrl(previousManifest.binding?.environmentUrl)
      !== normalizeUrl(context.environmentUrl)
    || previousManifest.binding?.solutionUniqueName !== context.solutionUniqueName) {
    throw new Error('previous manifest/checkpoint execution binding mismatch');
  }
  if (!journal || journal.schemaVersion !== 1
    || normalizeUrl(journal.binding?.environmentUrl) !== normalizeUrl(context.environmentUrl)
    || (journal.binding?.solution || null) !== (context.solutionUniqueName || null)
    || journal.inFlight?.failure?.collision !== true
    || journal.inFlight?.manifestHash !== previousManifest.integritySha256) {
    throw new Error('collision journal is missing or bound to different prior execution');
  }

  const previousOperations = (previousManifest.execution?.phases || [])
    .flatMap((phase) => phase.operations || []);
  const operationByFingerprint = new Map();
  for (const [position, operation] of previousOperations.entries()) {
    if (operation.index !== position) {
      throw new Error('previous manifest operation order is invalid');
    }
    const fingerprint = operationFingerprint(operation, context.solutionUniqueName);
    if (operationByFingerprint.has(fingerprint)) {
      throw new Error('previous manifest contains duplicate stable operation identities');
    }
    operationByFingerprint.set(fingerprint, operation);
  }
  const collisionOperation = operationByFingerprint.get(journal.inFlight.fingerprint);
  if (!collisionOperation
    || collisionOperation.id !== journal.inFlight.operationId) {
    throw new Error('collision journal operation is not present in the previous manifest');
  }

  const currentByRequestedName = new Map(normalized.tables.map((table) => [
    table.logicalName,
    table.plannedDecision === 'adapt'
      ? normalizeName(table.adaptedLogicalName)
      : table.logicalName,
  ]));
  const allowedTables = new Set(currentByRequestedName.values());
  const priorTables = checkpoint.tables.map(normalizeName);
  const excludedTables = priorTables.filter((table) => !allowedTables.has(table));
  const collisionTables = new Set(operationAffectedPublishTables(collisionOperation));
  const tableMappings = [];
  for (const excludedTable of excludedTables) {
    if (!collisionTables.has(excludedTable)) {
      throw new Error(
        `checkpoint table ${excludedTable} is outside the revised contract without `
        + 'collision evidence',
      );
    }
    const priorDecision = (previousManifest.decisions || []).find((decision) => (
      decision.itemType === 'table'
      && normalizeName(decision.effectiveName) === excludedTable
    ));
    const replacement = priorDecision
      ? currentByRequestedName.get(normalizeName(priorDecision.requestedName))
      : null;
    if (!replacement || !allowedTables.has(replacement) || replacement === excludedTable) {
      throw new Error(
        `collision table ${excludedTable} has no in-contract revised replacement`,
      );
    }
    tableMappings.push({
      requestedName: normalizeName(priorDecision.requestedName),
      from: excludedTable,
      to: replacement,
    });
  }

  const supersededCollisionFingerprints = new Set(
    (journal.recoveries || [])
      .filter((recovery) => (
        recovery.outcome === 'fresh-reconciliation-confirmed-superseded-collision'
      ))
      .map((recovery) => recovery.fingerprint),
  );
  for (const completedFingerprint of Object.keys(journal.completed || {})) {
    if (supersededCollisionFingerprints.has(completedFingerprint)) continue;
    const completedOperation = operationByFingerprint.get(completedFingerprint);
    if (!completedOperation) {
      throw new Error(
        `completed fingerprint ${completedFingerprint} is absent from the previous manifest`,
      );
    }
    const equivalentOperation = revisedEquivalentOperation(
      completedOperation,
      previousManifest,
      normalized,
      context,
    );
    if (!equivalentOperation
      || operationFingerprint(equivalentOperation, context.solutionUniqueName)
        !== completedFingerprint) {
      throw new Error(
        `completed metadata component ${completedOperation.id} was removed or changed `
        + 'in the revised structured contract',
      );
    }
    for (const table of operationAffectedPublishTables(completedOperation)) {
      if (!allowedTables.has(table)) {
        throw new Error(
          `completed metadata write for ${table} would be lost from the revised contract`,
        );
      }
    }
  }

  const activeTables = [
    ...priorTables.filter((table) => allowedTables.has(table)),
    ...tableMappings.map((mapping) => mapping.to),
  ];
  const rollForwards = [
    ...(checkpoint.rollForwards || []),
    {
      rolledAt,
      previousIntegritySha256: checkpoint.integritySha256,
      previousCheckpoint: stableClone(checkpoint),
      previousBinding: stableClone(checkpoint.binding),
      previousTables: [...priorTables],
      collisionOperationId: collisionOperation.id,
      collisionOperationFingerprint: journal.inFlight.fingerprint,
      tableMappings,
    },
  ];
  const rolled = createPublishCheckpoint({
    context,
    planSha256,
    structuredSchemaSha256,
    tables: activeTables,
    createdAt: checkpoint.createdAt,
    rollForwards,
  });
  const validation = validatePublishCheckpoint(rolled, {
    context,
    planSha256,
    structuredSchemaSha256,
    allowedTables,
  });
  if (!validation.valid) {
    throw new Error(`Rolled publish checkpoint is invalid: ${validation.errors.join('; ')}`);
  }
  return rolled;
}

function buildManifest({
  contract,
  approvalReceipt,
  reconciliation,
  planBytes,
  contractBytes,
  reconciliationBytes,
  context,
  publishCheckpoint = null,
  now = new Date().toISOString(),
  maxReconciliationAgeMs = DEFAULT_MAX_RECONCILIATION_AGE_MS,
}) {
  const contractValidation = validateContract(contract);
  if (!contractValidation.valid) {
    throw new Error(`Invalid schema contract: ${contractValidation.errors.join('; ')}`);
  }
  const normalized = normalizedContract(contract);
  const snapshot = reconciliation;
  const snapshotValidation = validateSnapshot(reconciliation, {
    environmentUrl: context.environmentUrl,
    tenantId: context.tenantId || undefined,
  });
  if (!snapshotValidation.valid) {
    throw new Error(
      `Invalid Dataverse execution reconciliation: ${snapshotValidation.errors.join('; ')}`,
    );
  }
  if (reconciliation.purpose !== 'execution-reconciliation'
    || reconciliation.reconciliation?.boundedExactNames !== true
    || reconciliation.reconciliation?.fullInventoryRead !== false) {
    throw new Error(
      'execution reconciliation must be a fresh bounded exact-name artifact',
    );
  }
  const expectedScope = reconciliationScope(normalized);
  const actualExactTables = [...new Set(
    (reconciliation.inputs?.explicitTableNames || []).map(normalizeName),
  )].sort((left, right) => left.localeCompare(right));
  const actualProposedTables = [...new Set(
    (reconciliation.inputs?.proposedTableNames || []).map(normalizeName),
  )].sort((left, right) => left.localeCompare(right));
  if (stableJson(actualExactTables) !== stableJson(expectedScope.exactTables)
    || stableJson(actualProposedTables) !== stableJson(expectedScope.proposedTables)) {
    throw new Error(
      'execution reconciliation scope does not exactly match the approved structured schema',
    );
  }
  if (normalizeName(normalized.publisherPrefix) !== normalizeName(context.publisherPrefix)) {
    throw new Error('publisherPrefix does not match the schema contract');
  }
  if (!context.environmentId) throw new Error('environmentId is required');
  if (!context.environmentUrl) throw new Error('environmentUrl is required');
  if (!context.solutionUniqueName) throw new Error('solutionUniqueName is required');
  if (!planBytes?.length) throw new Error('native-app-plan.md is required');
  if (!contractBytes?.length) throw new Error('schema contract bytes are required');
  if (!reconciliationBytes?.length) {
    throw new Error('execution reconciliation bytes are required');
  }
  const planHash = sha256(planBytes);
  const contractHash = sha256(contractBytes);
  const approvalValidation = validateApprovalReceipt(approvalReceipt, {
    contract,
    planBytes,
  });
  if (!approvalValidation.valid) {
    throw new Error(
      `Invalid mobile plan approval receipt: ${approvalValidation.errors.join('; ')}`,
    );
  }
  if (normalized.approvedPlanSha256 !== planHash) {
    throw new Error(
      'structured schema approvedPlanSha256 does not match native-app-plan.md',
    );
  }
  if (normalized.approvedContractSha256
    !== approvalReceipt.approvedContractSha256) {
    throw new Error(
      'structured schema approvedContractSha256 does not match approval receipt',
    );
  }
  if (normalized.approvalReceiptSha256
    !== approvalReceipt.integritySha256) {
    throw new Error(
      'structured schema approvalReceiptSha256 does not match approval receipt',
    );
  }

  const nowMs = Date.parse(now);
  const snapshotMs = Date.parse(snapshot.generatedAt);
  if (!Number.isFinite(nowMs)) throw new Error('now must be an ISO timestamp');
  if (snapshotMs > nowMs + 5 * 60 * 1000) {
    throw new Error('execution reconciliation timestamp is in the future');
  }
  if (nowMs - snapshotMs > maxReconciliationAgeMs) {
    throw new Error(
      `execution reconciliation is stale: age ${nowMs - snapshotMs}ms exceeds `
      + `${maxReconciliationAgeMs}ms`,
    );
  }

  const indexes = snapshotIndexes(snapshot);
  const aliases = { tables: new Map(), columns: new Map() };
  for (const table of normalized.tables) {
    if (table.plannedDecision === 'adapt') {
      aliases.tables.set(table.logicalName, normalizeName(table.adaptedLogicalName));
    }
  }
  const allowedPublishTables = new Set(normalized.tables.map((table) => (
    aliases.tables.get(table.logicalName) || table.logicalName
  )));
  if (publishCheckpoint) {
    const checkpointValidation = validatePublishCheckpoint(publishCheckpoint, {
      context,
      planSha256: planHash,
      structuredSchemaSha256: contractHash,
      allowedTables: allowedPublishTables,
    });
    if (!checkpointValidation.valid) {
      throw new Error(
        `Invalid publish checkpoint: ${checkpointValidation.errors.join('; ')}`,
      );
    }
  }

  const decisions = [];
  const phaseOperations = Object.fromEntries(PHASE_ORDER.map((phase) => [phase, []]));
  const tableState = new Map();
  const publishTables = new Set((publishCheckpoint?.tables || []).map(normalizeName));
  let nextIndex = 0;

  for (const table of normalized.tables) {
    const requestedName = table.logicalName;
    const effectiveName = aliases.tables.get(requestedName) || requestedName;
    const live = presence(effectiveName, indexes);
    const tableId = contractItemId('table', requestedName);
    const requiredExisting = !isCustomName(effectiveName, context.publisherPrefix)
      || ['reuse', 'extend', 'defer'].includes(table.plannedDecision);

    if (table.plannedDecision === 'unverified') {
      decisions.push(makeDecision({
        itemId: tableId,
        itemType: 'table',
        requestedName,
        effectiveName,
        decision: 'unverified',
        operation: 'none',
        reason: table.reason || 'approved plan leaves this table unverified',
      }));
      tableState.set(requestedName, {
        decision: 'unverified',
        effectiveName,
        liveTable: live.detail,
      });
      continue;
    }

    if (table.plannedDecision === 'defer') {
      decisions.push(makeDecision({
        itemId: tableId,
        itemType: 'table',
        requestedName,
        effectiveName,
        decision: 'defer',
        operation: 'none',
        reason: table.reason || 'approved plan defers this table',
      }));
      tableState.set(requestedName, { decision: 'defer', effectiveName, liveTable: live.detail });
      continue;
    }

    if (!live.inventory && !live.detail && !absenceProven(effectiveName, indexes)) {
      decisions.push(makeDecision({
        itemId: tableId,
        itemType: 'table',
        requestedName,
        effectiveName,
        decision: 'unverified',
        operation: 'none',
        reason: 'fresh reconciliation does not prove the target table present or absent',
      }));
      tableState.set(requestedName, {
        decision: 'unverified',
        effectiveName,
        liveTable: null,
      });
      continue;
    }

    if (!live.inventory && !live.detail && absenceProven(effectiveName, indexes)) {
      if (requiredExisting && table.plannedDecision !== 'adapt') {
        decisions.push(makeDecision({
          itemId: tableId,
          itemType: 'table',
          requestedName,
          effectiveName,
          decision: 'defer',
          operation: 'none',
          reason: 'required-existing table is absent; destructive replacement is forbidden',
        }));
        tableState.set(requestedName, { decision: 'defer', effectiveName, liveTable: null });
        continue;
      }
      if (!isCustomName(effectiveName, context.publisherPrefix)) {
        decisions.push(makeDecision({
          itemId: tableId,
          itemType: 'table',
          requestedName,
          effectiveName,
          decision: 'unverified',
          operation: 'none',
          reason: 'new table name does not use the resolved publisher prefix',
        }));
        tableState.set(requestedName, {
          decision: 'unverified',
          effectiveName,
          liveTable: null,
        });
        continue;
      }
      const unresolvedCreateColumns = table.columns.filter((column) => (
        column.plannedDecision === 'unverified'
        || (
          !['create', 'adapt', 'defer'].includes(column.plannedDecision)
          && !isComputedColumn(column)
        )
      ));
      if (unresolvedCreateColumns.length > 0) {
        decisions.push(makeDecision({
          itemId: tableId,
          itemType: 'table',
          requestedName,
          effectiveName,
          decision: 'unverified',
          operation: 'none',
          reason: `new table has non-create column decisions: ${unresolvedCreateColumns
            .map((column) => `${column.logicalName}=${column.plannedDecision}`)
            .join(', ')}`,
        }));
        tableState.set(requestedName, {
          decision: 'unverified',
          effectiveName,
          liveTable: null,
        });
        continue;
      }
      const ordinaryColumns = table.columns
        .filter((column) => (
          ['create', 'adapt'].includes(column.plannedDecision)
          && normalizeColumnType(column.type) !== 'lookup'
          && !isComputedColumn(column)
        ))
        .map((column) => ({
          ...column,
          effectiveLogicalName: normalizeName(column.adaptedLogicalName || column.logicalName),
        }));
      const tableDecision = table.plannedDecision === 'adapt' ? 'adapt' : 'create';
      const tableOperation = operation(
        nextIndex++,
        `create-table:${effectiveName}`,
        'tableCreates',
        'EntityDefinitions',
        tablePayload(table, effectiveName, ordinaryColumns),
        context.solutionUniqueName,
      );
      phaseOperations.tableCreates.push(tableOperation);
      publishTables.add(effectiveName);
      const fullImageColumns = ordinaryColumns
        .filter(requiresFullImageConfiguration)
        .sort((left, right) => (
          left.effectiveLogicalName.localeCompare(right.effectiveLogicalName)
        ));
      for (const column of fullImageColumns) {
        phaseOperations.extensions.push(imageConfigurationOperation(
          nextIndex++,
          effectiveName,
          column,
          context.solutionUniqueName,
        ));
      }
      decisions.push(makeDecision({
        itemId: tableId,
        itemType: 'table',
        requestedName,
        effectiveName,
        decision: tableDecision,
        operation: tableOperation.id,
        reason: tableDecision === 'adapt'
          ? 'approved app-owned alias is absent and verified free'
          : 'new custom table is absent and verified free',
      }));
      tableState.set(requestedName, {
        decision: tableDecision,
        effectiveName,
        liveTable: null,
        created: true,
      });

      for (const column of table.columns) {
        const columnTarget = normalizeName(column.adaptedLogicalName || column.logicalName);
        if (column.plannedDecision === 'defer' || isComputedColumn(column)) {
          decisions.push(makeDecision({
            itemId: contractItemId('column', requestedName, column.logicalName),
            itemType: 'column',
            table: requestedName,
            requestedName: column.logicalName,
            effectiveName: columnTarget,
            decision: 'defer',
            operation: 'none',
            reason: isComputedColumn(column)
              ? 'calculated, rollup, and formula creation is outside the supported API boundary'
              : column.reason || 'approved plan defers this column',
          }));
          continue;
        }
        if (column.plannedDecision === 'adapt') {
          aliases.columns.set(`${effectiveName}:${column.logicalName}`, columnTarget);
        }
        decisions.push(makeDecision({
          itemId: contractItemId('column', requestedName, column.logicalName),
          itemType: 'column',
          table: requestedName,
          requestedName: column.logicalName,
          effectiveName: columnTarget,
          decision: column.plannedDecision === 'adapt' ? 'adapt' : 'create',
          operation: normalizeColumnType(column.type) === 'lookup'
            ? 'relationship-phase'
            : requiresFullImageConfiguration(column)
              ? `configure-image:${effectiveName}:${columnTarget}`
              : tableOperation.id,
          reason: normalizeColumnType(column.type) === 'lookup'
            ? 'lookup is created by its relationship after both endpoint tables exist'
            : requiresFullImageConfiguration(column)
              ? 'image is created inline and full-image storage is configured before publish'
              : 'ordinary column is included inline in the table create',
        }));
      }
      continue;
    }

    if (!live.detail) {
      decisions.push(makeDecision({
        itemId: tableId,
        itemType: 'table',
        requestedName,
        effectiveName,
        decision: 'unverified',
        operation: 'none',
        reason: 'table presence is known but detailed columns/relationships/keys are unavailable',
      }));
      tableState.set(requestedName, {
        decision: 'unverified',
        effectiveName,
        liveTable: null,
      });
      continue;
    }

    if (['create', 'adapt'].includes(table.plannedDecision)) {
      const tableComparison = tableCreateCompatibility(
        table,
        effectiveName,
        live.detail,
      );
      if (!tableComparison.compatible) {
        decisions.push(makeDecision({
          itemId: tableId,
          itemType: 'table',
          requestedName,
          effectiveName,
          decision: 'unverified',
          operation: 'none',
          reason: `existing create/adapt target table behavior is incompatible: `
            + tableComparison.reasons.join('; '),
        }));
        tableState.set(requestedName, {
          decision: 'unverified',
          effectiveName,
          liveTable: live.detail,
        });
        continue;
      }
    }

    const comparisons = compatibleTableColumns(table, live.detail);
    const missing = comparisons.filter((item) => !item.liveColumn);
    const incompatible = comparisons.filter(
      (item) => item.liveColumn && !item.comparison.compatible,
    );
    const canExtend = Boolean(live.detail.customizable && live.detail.canCreateAttributes);
    const createColumns = [];
    const configureImages = [];
    let tableHasUnverified = false;
    let tableHasDeferred = false;

    for (const item of comparisons) {
      const column = item.column;
      const columnId = contractItemId('column', requestedName, column.logicalName);
      const columnTarget = item.targetName;
      if (column.plannedDecision === 'unverified') {
        tableHasUnverified = true;
        decisions.push(makeDecision({
          itemId: columnId,
          itemType: 'column',
          table: requestedName,
          requestedName: column.logicalName,
          effectiveName: columnTarget,
          decision: 'unverified',
          operation: 'none',
          reason: column.reason || 'approved plan leaves this column unverified',
        }));
        continue;
      }
      if (column.plannedDecision === 'defer') {
        tableHasDeferred = true;
        decisions.push(makeDecision({
          itemId: columnId,
          itemType: 'column',
          table: requestedName,
          requestedName: column.logicalName,
          effectiveName: columnTarget,
          decision: 'defer',
          operation: 'none',
          reason: column.reason || 'approved plan defers this column',
        }));
        continue;
      }
      if (isComputedColumn(column)) {
        if (item.liveColumn && item.comparison.compatible) {
          decisions.push(makeDecision({
            itemId: columnId,
            itemType: 'column',
            table: requestedName,
            requestedName: column.logicalName,
            effectiveName: columnTarget,
            decision: 'reuse',
            operation: 'none',
            reason: 'existing computed metadata exactly matches the approved contract',
          }));
        } else {
          tableHasDeferred = true;
          decisions.push(makeDecision({
            itemId: columnId,
            itemType: 'column',
            table: requestedName,
            requestedName: column.logicalName,
            effectiveName: columnTarget,
            decision: 'defer',
            operation: 'none',
            reason: 'computed metadata cannot be created and does not exactly match for reuse',
          }));
        }
        continue;
      }
      if (item.liveColumn && item.comparison.compatible) {
        decisions.push(makeDecision({
          itemId: columnId,
          itemType: 'column',
          table: requestedName,
          requestedName: column.logicalName,
          effectiveName: columnTarget,
          decision: column.plannedDecision === 'adapt' ? 'adapt' : 'reuse',
          operation: 'none',
          reason: column.plannedDecision === 'adapt'
            ? 'approved adapted column already exists with compatible metadata'
            : 'existing column metadata is compatible',
        }));
        if (column.plannedDecision === 'adapt') {
          aliases.columns.set(`${effectiveName}:${column.logicalName}`, columnTarget);
        }
        continue;
      }
      if (!item.liveColumn) {
        if (normalizeColumnType(column.type) === 'lookup') {
          if (
            ['create', 'adapt'].includes(column.plannedDecision)
            && canExtend
            && live.detail.canBeRelatedEntityInRelationship
            && isCustomName(columnTarget, context.publisherPrefix)
          ) {
            decisions.push(makeDecision({
              itemId: columnId,
              itemType: 'column',
              table: requestedName,
              requestedName: column.logicalName,
              effectiveName: columnTarget,
              decision: column.plannedDecision,
              operation: 'relationship-phase',
              reason: 'lookup is absent and the child table permits relationship creation',
            }));
            if (column.plannedDecision === 'adapt') {
              aliases.columns.set(`${effectiveName}:${column.logicalName}`, columnTarget);
            }
          } else {
            tableHasDeferred = true;
            decisions.push(makeDecision({
              itemId: columnId,
              itemType: 'column',
              table: requestedName,
              requestedName: column.logicalName,
              effectiveName: columnTarget,
              decision: 'defer',
              operation: 'none',
              reason: !['create', 'adapt'].includes(column.plannedDecision)
                ? `missing lookup was planned as ${column.plannedDecision}, not create/adapt`
                : 'child table cannot create lookup attributes/relationships',
            }));
          }
        } else if (
          ['create', 'adapt'].includes(table.plannedDecision)
          && normalizeColumnType(column.type) !== 'lookup'
        ) {
          tableHasUnverified = true;
          decisions.push(makeDecision({
            itemId: columnId,
            itemType: 'column',
            table: requestedName,
            requestedName: column.logicalName,
            effectiveName: columnTarget,
            decision: 'unverified',
            operation: 'none',
            reason: 'existing create/adapt target is missing an ordinary column that '
              + 'must have been included inline; extension would change the approved action',
          }));
        } else if (
          ['create', 'adapt'].includes(column.plannedDecision)
          && canExtend
          && isCustomName(columnTarget, context.publisherPrefix)
        ) {
          createColumns.push({ ...column, effectiveLogicalName: columnTarget });
          decisions.push(makeDecision({
            itemId: columnId,
            itemType: 'column',
            table: requestedName,
            requestedName: column.logicalName,
            effectiveName: columnTarget,
            decision: column.plannedDecision === 'adapt' ? 'adapt' : 'create',
            operation: `extend-column:${effectiveName}:${columnTarget}`,
            reason: 'custom column is absent and the table permits extension',
          }));
          if (column.plannedDecision === 'adapt') {
            aliases.columns.set(`${effectiveName}:${column.logicalName}`, columnTarget);
          }
        } else {
          tableHasDeferred = true;
          decisions.push(makeDecision({
            itemId: columnId,
            itemType: 'column',
            table: requestedName,
            requestedName: column.logicalName,
            effectiveName: columnTarget,
            decision: 'defer',
            operation: 'none',
            reason: !['create', 'adapt'].includes(column.plannedDecision)
              ? `missing column was planned as ${column.plannedDecision}, not create/adapt`
              : canExtend
                ? 'missing column is not owned by the resolved publisher'
                : 'target table cannot create attributes',
          }));
        }
        continue;
      }

      if (
        ['create', 'extend', 'adapt'].includes(column.plannedDecision)
        && canExtend
        && item.liveColumn.customizable !== false
        && repairableFullImageConfiguration(column, item.liveColumn)
      ) {
        const desiredMaxSizeInKB = Math.max(
          Number(column.maxSizeInKB),
          Number(item.liveColumn.maxSizeInKB),
        );
        configureImages.push({
          ...column,
          effectiveLogicalName: columnTarget,
          maxSizeInKB: desiredMaxSizeInKB,
        });
        decisions.push(makeDecision({
          itemId: columnId,
          itemType: 'column',
          table: requestedName,
          requestedName: column.logicalName,
          effectiveName: columnTarget,
          decision: 'extend',
          operation: `configure-image:${effectiveName}:${columnTarget}`,
          reason: 'existing Image metadata requires the approved full-image configuration',
        }));
      } else if (
        column.plannedDecision === 'adapt'
        && column.adaptedLogicalName
        && canExtend
        && absenceProven(columnTarget, indexes)
      ) {
        createColumns.push({ ...column, effectiveLogicalName: columnTarget });
        aliases.columns.set(`${effectiveName}:${column.logicalName}`, columnTarget);
        decisions.push(makeDecision({
          itemId: columnId,
          itemType: 'column',
          table: requestedName,
          requestedName: column.logicalName,
          effectiveName: columnTarget,
          decision: 'adapt',
          operation: `extend-column:${effectiveName}:${columnTarget}`,
          reason: 'approved adapted column name is verified free beside incompatible metadata',
        }));
      } else if (column.plannedDecision === 'defer' || !canExtend) {
        tableHasDeferred = true;
        decisions.push(makeDecision({
          itemId: columnId,
          itemType: 'column',
          table: requestedName,
          requestedName: column.logicalName,
          effectiveName: columnTarget,
          decision: 'defer',
          operation: 'none',
          reason: `incompatible existing column: ${item.comparison.reasons.join('; ')}`,
        }));
      } else {
        tableHasUnverified = true;
        decisions.push(makeDecision({
          itemId: columnId,
          itemType: 'column',
          table: requestedName,
          requestedName: column.logicalName,
          effectiveName: columnTarget,
          decision: 'unverified',
          operation: 'none',
          reason: `incompatible column has no approved safe alias: ${item.comparison.reasons.join('; ')}`,
        }));
      }
    }

    for (const column of createColumns.sort((left, right) => (
      left.effectiveLogicalName.localeCompare(right.effectiveLogicalName)
    ))) {
      phaseOperations.extensions.push(operation(
        nextIndex++,
        `extend-column:${effectiveName}:${column.effectiveLogicalName}`,
        'extensions',
        `EntityDefinitions(LogicalName='${effectiveName}')/Attributes`,
        columnPayload(column, column.effectiveLogicalName),
        context.solutionUniqueName,
      ));
      if (requiresFullImageConfiguration(column)) {
        phaseOperations.extensions.push(imageConfigurationOperation(
          nextIndex++,
          effectiveName,
          column,
          context.solutionUniqueName,
        ));
      }
      publishTables.add(effectiveName);
    }

    for (const column of configureImages.sort((left, right) => (
      left.effectiveLogicalName.localeCompare(right.effectiveLogicalName)
    ))) {
      phaseOperations.extensions.push(imageConfigurationOperation(
        nextIndex++,
        effectiveName,
        column,
        context.solutionUniqueName,
      ));
      publishTables.add(effectiveName);
    }

    const tableDecision = tableHasUnverified
      ? 'unverified'
      : createColumns.length > 0 || configureImages.length > 0
        ? 'extend'
        : table.plannedDecision === 'adapt'
          ? 'adapt'
          : 'reuse';
    decisions.push(makeDecision({
      itemId: tableId,
      itemType: 'table',
      requestedName,
      effectiveName,
      decision: tableDecision,
      operation: createColumns.length > 0 || configureImages.length > 0
        ? 'extensions-phase'
        : 'none',
      reason: tableHasUnverified
        ? 'one or more columns remain unverified'
        : createColumns.length > 0 || configureImages.length > 0
          ? `${createColumns.length} missing ordinary column(s) and `
            + `${configureImages.length} Image configuration(s) will be applied`
          : tableHasDeferred
            ? 'compatible table reused; unsupported additions are explicitly deferred'
            : incompatible.length > 0
              ? 'existing table reused with approved adapted/deferred conflicts'
              : missing.length > 0
                ? 'existing table reused with relationship-only additions'
                : 'existing table and planned columns are compatible',
    }));
    tableState.set(requestedName, {
      decision: tableDecision,
      effectiveName,
      liveTable: live.detail,
      created: false,
    });
  }

  for (const table of normalized.tables) {
    const ownerState = tableState.get(table.logicalName);
    for (const relationship of table.relationships) {
      const relationshipId = contractItemId(
        'relationship',
        table.logicalName,
        relationship.schemaName,
      );
      if (relationship.plannedDecision === 'unverified') {
        decisions.push(makeDecision({
          itemId: relationshipId,
          itemType: 'relationship',
          table: table.logicalName,
          requestedName: relationship.schemaName,
          effectiveName: relationship.adaptedSchemaName || relationship.schemaName,
          decision: 'unverified',
          operation: 'none',
          reason: relationship.reason || 'approved plan leaves this relationship unverified',
        }));
        continue;
      }
      if (relationship.plannedDecision === 'defer') {
        decisions.push(makeDecision({
          itemId: relationshipId,
          itemType: 'relationship',
          table: table.logicalName,
          requestedName: relationship.schemaName,
          effectiveName: relationship.adaptedSchemaName || relationship.schemaName,
          decision: 'defer',
          operation: 'none',
          reason: relationship.reason || 'approved plan defers this relationship',
        }));
        continue;
      }
      const endpointNames = relationship.kind === 'many-to-one'
        ? [relationship.childTable, relationship.parentTable]
        : [relationship.entity1, relationship.entity2];
      const endpointStates = endpointNames.map((name) => tableState.get(normalizeName(name)));
      if (endpointStates.some((state) => !state || ['defer', 'unverified'].includes(state.decision))) {
        decisions.push(makeDecision({
          itemId: relationshipId,
          itemType: 'relationship',
          table: table.logicalName,
          requestedName: relationship.schemaName,
          effectiveName: relationship.adaptedSchemaName || relationship.schemaName,
          decision: endpointStates.some((state) => state?.decision === 'unverified' || !state)
            ? 'unverified'
            : 'defer',
          operation: 'none',
          reason: 'relationship endpoint is deferred or unverified',
        }));
        continue;
      }
      const childState = relationship.kind === 'many-to-one'
        ? tableState.get(normalizeName(relationship.childTable))
        : ownerState;
      const parentState = relationship.kind === 'many-to-one'
        ? tableState.get(normalizeName(relationship.parentTable))
        : null;
      const relationshipCapable = relationship.kind === 'many-to-one'
        ? Boolean(
          (
            childState?.created
            || (
              childState?.liveTable?.customizable
              && childState?.liveTable?.canCreateAttributes
              && childState?.liveTable?.canBeRelatedEntityInRelationship
            )
          )
          && (
            parentState?.created
            || parentState?.liveTable?.canBePrimaryEntityInRelationship
          )
        )
        : endpointStates.every((state) => (
          state.created
          || Boolean(
            state.liveTable?.customizable
            && state.liveTable?.canBeInManyToMany,
          )
        ));
      const existing = relationshipExists(
        relationship,
        childState?.liveTable,
        aliases,
      );
      if (existing.exists && existing.compatible) {
        decisions.push(makeDecision({
          itemId: relationshipId,
          itemType: 'relationship',
          table: table.logicalName,
          requestedName: relationship.schemaName,
          effectiveName: relationship.adaptedSchemaName || relationship.schemaName,
          decision: relationship.plannedDecision === 'adapt' ? 'adapt' : 'reuse',
          operation: 'none',
          reason: 'existing relationship metadata is compatible',
        }));
        continue;
      }
      if (existing.exists && !existing.compatible) {
        decisions.push(makeDecision({
          itemId: relationshipId,
          itemType: 'relationship',
          table: table.logicalName,
          requestedName: relationship.schemaName,
          effectiveName: relationship.schemaName,
          decision: relationship.plannedDecision === 'adapt'
            ? 'unverified'
            : 'defer',
          operation: 'none',
          reason: relationship.plannedDecision === 'adapt'
            ? 'adapted relationship identity exists but compatibility evidence mismatches'
            : 'same-name relationship is incompatible and has no approved alias',
        }));
        continue;
      }
      if (
        relationship.kind === 'many-to-many'
        && !existing.exists
        && ['create', 'adapt'].includes(relationship.plannedDecision)
      ) {
        const effectiveIntersect = normalizeName(
          relationship.adaptedIntersectTable || relationship.intersectTable,
        );
        const intersectCheck = indexes.proposedByName.get(effectiveIntersect);
        if (!intersectCheck || intersectCheck.status !== 'missing') {
          decisions.push(makeDecision({
            itemId: relationshipId,
            itemType: 'relationship',
            table: table.logicalName,
            requestedName: relationship.schemaName,
            effectiveName: relationship.adaptedSchemaName || relationship.schemaName,
            decision: 'unverified',
            operation: 'none',
            reason: intersectCheck?.status === 'collision'
              ? `effective intersect name ${effectiveIntersect} collides in fresh reconciliation`
              : `effective intersect name ${effectiveIntersect} was not freshly verified free`,
          }));
          continue;
        }
      }
      if (!existing.verified && !childState?.created) {
        decisions.push(makeDecision({
          itemId: relationshipId,
          itemType: 'relationship',
          table: table.logicalName,
          requestedName: relationship.schemaName,
          effectiveName: relationship.adaptedSchemaName || relationship.schemaName,
          decision: 'unverified',
          operation: 'none',
          reason: 'relationship collection is not available in the fresh reconciliation',
        }));
        continue;
      }
      if (!existing.exists && !relationshipCapable) {
        decisions.push(makeDecision({
          itemId: relationshipId,
          itemType: 'relationship',
          table: table.logicalName,
          requestedName: relationship.schemaName,
          effectiveName: relationship.adaptedSchemaName || relationship.schemaName,
          decision: 'defer',
          operation: 'none',
          reason: 'one or more existing relationship endpoints lack verified creation capability',
        }));
        continue;
      }
      if (!['create', 'adapt'].includes(relationship.plannedDecision)) {
        decisions.push(makeDecision({
          itemId: relationshipId,
          itemType: 'relationship',
          table: table.logicalName,
          requestedName: relationship.schemaName,
          effectiveName: relationship.adaptedSchemaName || relationship.schemaName,
          decision: 'defer',
          operation: 'none',
          reason: `missing relationship was planned as ${relationship.plannedDecision}, not create/adapt`,
        }));
        continue;
      }
      const payload = relationshipPayload(relationship, aliases);
      const operationId = `create-relationship:${normalizeName(payload.SchemaName)}`;
      phaseOperations.relationships.push(operation(
        nextIndex++,
        operationId,
        'relationships',
        'RelationshipDefinitions',
        payload,
        context.solutionUniqueName,
      ));
      publishTables.add(
        relationship.kind === 'many-to-one'
          ? payload.ReferencingEntity
          : payload.Entity1LogicalName,
      );
      decisions.push(makeDecision({
        itemId: relationshipId,
        itemType: 'relationship',
        table: table.logicalName,
        requestedName: relationship.schemaName,
        effectiveName: normalizeName(payload.SchemaName),
        decision: relationship.plannedDecision === 'adapt' ? 'adapt' : 'create',
        operation: operationId,
        reason: 'relationship is absent after both endpoints are resolved',
      }));
    }
  }

  for (const table of normalized.tables) {
    const state = tableState.get(table.logicalName);
    for (const key of table.alternateKeys) {
      const keyId = contractItemId('key', table.logicalName, key.schemaName);
      if (key.plannedDecision === 'unverified') {
        decisions.push(makeDecision({
          itemId: keyId,
          itemType: 'key',
          table: table.logicalName,
          requestedName: key.schemaName,
          effectiveName: key.adaptedSchemaName || key.schemaName,
          decision: 'unverified',
          operation: 'none',
          reason: key.reason || 'approved plan leaves this alternate key unverified',
        }));
        continue;
      }
      if (key.plannedDecision === 'defer' || state?.decision === 'defer') {
        decisions.push(makeDecision({
          itemId: keyId,
          itemType: 'key',
          table: table.logicalName,
          requestedName: key.schemaName,
          effectiveName: key.adaptedSchemaName || key.schemaName,
          decision: 'defer',
          operation: 'none',
          reason: key.reason || 'key or target table is deferred',
        }));
        continue;
      }
      if (!state || state.decision === 'unverified') {
        decisions.push(makeDecision({
          itemId: keyId,
          itemType: 'key',
          table: table.logicalName,
          requestedName: key.schemaName,
          effectiveName: key.adaptedSchemaName || key.schemaName,
          decision: 'unverified',
          operation: 'none',
          reason: 'target table is unverified',
        }));
        continue;
      }
      const existing = keyExists(key, state.liveTable, aliases, state.effectiveName);
      if (existing.exists && existing.compatible) {
        decisions.push(makeDecision({
          itemId: keyId,
          itemType: 'key',
          table: table.logicalName,
          requestedName: key.schemaName,
          effectiveName: key.adaptedSchemaName || key.schemaName,
          decision: key.plannedDecision === 'adapt' ? 'adapt' : 'reuse',
          operation: 'none',
          reason: 'existing alternate key is active or pending with compatible columns',
        }));
        continue;
      }
      if (existing.exists && !existing.compatible) {
        decisions.push(makeDecision({
          itemId: keyId,
          itemType: 'key',
          table: table.logicalName,
          requestedName: key.schemaName,
          effectiveName: key.adaptedSchemaName || key.schemaName,
          decision: 'defer',
          operation: 'none',
          reason: 'same-name or same-column alternate key is failed or incompatible',
        }));
        continue;
      }
      if (!existing.verified && !state.created) {
        decisions.push(makeDecision({
          itemId: keyId,
          itemType: 'key',
          table: table.logicalName,
          requestedName: key.schemaName,
          effectiveName: key.adaptedSchemaName || key.schemaName,
          decision: 'unverified',
          operation: 'none',
          reason: 'alternate-key collection is unavailable in the fresh reconciliation',
        }));
        continue;
      }
      if (!['create', 'adapt'].includes(key.plannedDecision)) {
        decisions.push(makeDecision({
          itemId: keyId,
          itemType: 'key',
          table: table.logicalName,
          requestedName: key.schemaName,
          effectiveName: key.adaptedSchemaName || key.schemaName,
          decision: 'defer',
          operation: 'none',
          reason: `missing alternate key was planned as ${key.plannedDecision}, not create/adapt`,
        }));
        continue;
      }
      const payload = keyPayload(key, aliases, state.effectiveName);
      const operationId = `create-key:${state.effectiveName}:${normalizeName(payload.SchemaName)}`;
      phaseOperations.alternateKeys.push(operation(
        nextIndex++,
        operationId,
        'alternateKeys',
        `EntityDefinitions(LogicalName='${state.effectiveName}')/Keys`,
        payload,
        context.solutionUniqueName,
      ));
      publishTables.add(state.effectiveName);
      decisions.push(makeDecision({
        itemId: keyId,
        itemType: 'key',
        table: table.logicalName,
        requestedName: key.schemaName,
        effectiveName: normalizeName(payload.SchemaName),
        decision: key.plannedDecision === 'adapt' ? 'adapt' : 'create',
        operation: operationId,
        reason: 'alternate key is absent after its table and columns are resolved',
      }));
    }
  }

  if (publishTables.size > 0) {
    const entities = [...publishTables].sort((left, right) => left.localeCompare(right));
    phaseOperations.publish.push(operation(
      nextIndex++,
      'publish-customizations',
      'publish',
      'PublishXml',
      {
        ParameterXml: `<importexportxml><entities>${entities
          .map((entityName) => `<entity>${xmlEscape(entityName)}</entity>`)
          .join('')}</entities></importexportxml>`,
      },
      null,
    ));
  }

  const classifiedItemIds = new Set(decisions.map((decision) => decision.itemId));
  for (const table of normalized.tables) {
    const state = tableState.get(table.logicalName);
    for (const column of table.columns) {
      const itemId = contractItemId('column', table.logicalName, column.logicalName);
      if (classifiedItemIds.has(itemId)) continue;
      const decision = state?.decision === 'defer' ? 'defer' : 'unverified';
      decisions.push(makeDecision({
        itemId,
        itemType: 'column',
        table: table.logicalName,
        requestedName: column.logicalName,
        effectiveName: normalizeName(column.adaptedLogicalName || column.logicalName),
        decision,
        operation: 'none',
        reason: decision === 'defer'
          ? 'containing table is deferred'
          : 'containing table metadata is unverified',
      }));
      classifiedItemIds.add(itemId);
    }
  }

  decisions.sort((left, right) => left.itemId.localeCompare(right.itemId));
  const contractIds = new Set();
  for (const table of normalized.tables) {
    contractIds.add(contractItemId('table', table.logicalName));
    for (const column of table.columns) {
      contractIds.add(contractItemId('column', table.logicalName, column.logicalName));
    }
    for (const relationship of table.relationships) {
      contractIds.add(contractItemId('relationship', table.logicalName, relationship.schemaName));
    }
    for (const key of table.alternateKeys) {
      contractIds.add(contractItemId('key', table.logicalName, key.schemaName));
    }
  }
  const decisionIds = new Set(decisions.map((decision) => decision.itemId));
  const missingDecisions = [...contractIds].filter((itemId) => !decisionIds.has(itemId));
  const duplicateDecisionCount = decisions.length - decisionIds.size;
  if (missingDecisions.length > 0 || duplicateDecisionCount > 0) {
    throw new Error(
      `Decision coverage failure: missing=${missingDecisions.join(',') || 'none'}, `
      + `duplicates=${duplicateDecisionCount}`,
    );
  }

  const approvedDecisionById = new Map();
  for (const table of normalized.tables) {
    approvedDecisionById.set(
      contractItemId('table', table.logicalName),
      table.plannedDecision,
    );
    for (const column of table.columns) {
      approvedDecisionById.set(
        contractItemId('column', table.logicalName, column.logicalName),
        column.plannedDecision,
      );
    }
    for (const relationship of table.relationships) {
      approvedDecisionById.set(
        contractItemId('relationship', table.logicalName, relationship.schemaName),
        relationship.plannedDecision,
      );
    }
    for (const key of table.alternateKeys) {
      approvedDecisionById.set(
        contractItemId('key', table.logicalName, key.schemaName),
        key.plannedDecision,
      );
    }
  }
  for (const decision of decisions) {
    const observedOutcome = decision.decision;
    const approvedDecision = approvedDecisionById.get(decision.itemId);
    decision.decision = approvedDecision;
    decision.observedOutcome = observedOutcome;
    decision.verificationStatus = approvedDecision === 'unverified'
      || observedOutcome === 'unverified'
      ? 'unverified'
      : observedOutcome === 'defer' && approvedDecision !== 'defer'
        ? 'conflict'
        : 'verified';
  }

  const unverified = decisions.filter(
    (decision) => decision.verificationStatus !== 'verified',
  );
  const unverifiedFacts = decisions.filter(
    (decision) => decision.verificationStatus === 'unverified',
  );
  const deferred = decisions.filter((decision) => decision.decision === 'defer');
  const conflicts = decisions.filter((decision) => decision.verificationStatus === 'conflict');
  const decisionById = new Map(decisions.map((decision) => [decision.itemId, decision]));
  const serviceRequiredTables = normalized.tables
    .filter((table) => table.serviceRequired)
    .map((table) => {
      const tableDecision = decisionById.get(contractItemId('table', table.logicalName));
      return {
        requestedName: table.logicalName,
        logicalName: aliases.tables.get(table.logicalName) || table.logicalName,
        decision: table.plannedDecision,
        verificationStatus: tableDecision?.verificationStatus || 'unverified',
      };
    })
    .filter((table) => table.decision !== 'defer')
    .sort((left, right) => left.logicalName.localeCompare(right.logicalName));
  for (const table of normalized.tables) {
    for (const relationship of table.relationships) {
      if (relationship.kind !== 'many-to-many' || !relationship.serviceRequired) continue;
      const relationshipDecision = decisionById.get(contractItemId(
        'relationship',
        table.logicalName,
        relationship.schemaName,
      ));
      if (!relationshipDecision
        || relationshipDecision.decision === 'defer') continue;
      serviceRequiredTables.push({
        requestedName: relationship.intersectTable,
        logicalName: normalizeName(
          relationship.adaptedIntersectTable || relationship.intersectTable,
        ),
        decision: relationshipDecision.decision,
        verificationStatus: relationshipDecision.verificationStatus,
      });
    }
  }
  const uniqueServiceRequiredTables = [...new Map(
    serviceRequiredTables
      .sort((left, right) => left.logicalName.localeCompare(right.logicalName))
      .map((table) => [table.logicalName, table]),
  ).values()];
  const approvedServiceDependencies = new Map(
    approvalReceipt.serviceRequiredTables.map((item) => [
      normalizeName(item.logicalName),
      item.consumers,
    ]),
  );
  const manifestServiceNames = uniqueServiceRequiredTables
    .map((item) => normalizeName(item.logicalName))
    .sort((left, right) => left.localeCompare(right));
  const approvedServiceNames = [...approvedServiceDependencies.keys()]
    .sort((left, right) => left.localeCompare(right));
  if (stableJson(manifestServiceNames) !== stableJson(approvedServiceNames)) {
    throw new Error(
      'manifest serviceRequiredTables do not exactly match approved screen/service dependencies',
    );
  }
  for (const item of uniqueServiceRequiredTables) {
    item.consumers = approvedServiceDependencies.get(normalizeName(item.logicalName));
  }
  let orderedIndex = 0;
  for (const phase of PHASE_ORDER) {
    for (const item of phaseOperations[phase]) item.index = orderedIndex++;
  }
  const operations = PHASE_ORDER.flatMap((phase) => phaseOperations[phase]);
  const nextPublishCheckpoint = publishTables.size > 0
    && (unverified.length === 0 || publishCheckpoint)
    ? createPublishCheckpoint({
      context,
      planSha256: planHash,
      structuredSchemaSha256: contractHash,
      tables: [...publishTables],
      createdAt: publishCheckpoint?.createdAt || now,
      rollForwards: publishCheckpoint?.rollForwards || [],
    })
    : null;
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    preparedAt: now,
    executable: unverified.length === 0,
    binding: {
      environmentId: context.environmentId,
      environmentUrl: String(context.environmentUrl).replace(/\/+$/, ''),
      tenantId: context.tenantId || null,
      publisherPrefix: normalizeName(context.publisherPrefix),
      solutionUniqueName: context.solutionUniqueName,
      planSha256: planHash,
      approvedContractSha256: approvalReceipt.approvedContractSha256,
      approvalReceiptSha256: approvalReceipt.integritySha256,
      structuredSchemaSha256: contractHash,
      reconciliationSha256: sha256(reconciliationBytes),
      reconciliationGeneratedAt: reconciliation.generatedAt,
      maxReconciliationAgeMs,
    },
    summary: {
      decisionCount: decisions.length,
      metadataOperationCount: operations.length,
      metadataWriteCount: operations.filter(
        (item) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(item.method),
      ).length,
      unresolvedCount: unverified.length,
      unverifiedCount: unverifiedFacts.length,
      conflictCount: conflicts.length,
      deferredCount: deferred.length,
      serviceRequiredTableCount: uniqueServiceRequiredTables.length,
    },
    decisions,
    aliases: {
      tables: Object.fromEntries([...aliases.tables].sort()),
      columns: Object.fromEntries([...aliases.columns].sort()),
    },
    service: {
      requiredTables: uniqueServiceRequiredTables,
      generationMode: 'sequential-outside-batch-metadata',
    },
    publishCheckpoint: nextPublishCheckpoint,
    execution: {
      executor: 'BATCH-METADATA',
      odataBatch: false,
      parallelWrites: false,
      journal: {
        required: true,
        schemaVersion: 1,
        atomicPerOperation: true,
        uncertainResumeRequiresFreshReconciliation: true,
      },
      phases: PHASE_ORDER.map((name) => ({
        name,
        operations: phaseOperations[name],
      })),
    },
    verification: {
      unresolvedItemIds: unverified.map((decision) => decision.itemId),
      conflictItemIds: conflicts.map((decision) => decision.itemId),
      deferredItemIds: deferred.map((decision) => decision.itemId),
      reconciliationScope: expectedScope,
    },
  };
  manifest.integritySha256 = sha256(stableJson(manifest));
  return manifest;
}

function validateManifest(manifest, {
  planBytes,
  contractBytes,
  reconciliationBytes,
  contract,
  approvalReceipt,
  reconciliation,
  context,
  publishCheckpoint = null,
  now = new Date().toISOString(),
  maxReconciliationAgeMs = DEFAULT_MAX_RECONCILIATION_AGE_MS,
  requireExecutable = false,
}) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { valid: false, errors: ['manifest must be an object'] };
  }
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    errors.push(`manifest.schemaVersion must equal ${MANIFEST_SCHEMA_VERSION}`);
  }
  const integrity = manifest.integritySha256;
  const withoutIntegrity = { ...manifest };
  delete withoutIntegrity.integritySha256;
  if (!integrity || integrity !== sha256(stableJson(withoutIntegrity))) {
    errors.push('manifest integrity hash does not match');
  }
  const binding = manifest.binding || {};
  if (binding.maxReconciliationAgeMs !== maxReconciliationAgeMs) {
    errors.push('maxReconciliationAgeMs mismatch');
  }
  if (context) {
    if (binding.environmentId !== context.environmentId) errors.push('environmentId mismatch');
    if (normalizeUrl(binding.environmentUrl) !== normalizeUrl(context.environmentUrl)) {
      errors.push('environmentUrl mismatch');
    }
    if (context.tenantId
      && normalizeName(binding.tenantId) !== normalizeName(context.tenantId)) {
      errors.push('tenantId mismatch');
    }
    if (normalizeName(binding.publisherPrefix) !== normalizeName(context.publisherPrefix)) {
      errors.push('publisherPrefix mismatch');
    }
    if (binding.solutionUniqueName !== context.solutionUniqueName) {
      errors.push('solutionUniqueName mismatch');
    }
  }
  if (planBytes && binding.planSha256 !== sha256(planBytes)) errors.push('plan hash mismatch');
  if (approvalReceipt) {
    const approvalValidation = validateApprovalReceipt(approvalReceipt, {
      contract,
      planBytes,
    });
    if (!approvalValidation.valid) {
      errors.push(...approvalValidation.errors.map(
        (error) => `mobile plan approval receipt: ${error}`,
      ));
    }
    if (binding.approvedContractSha256
      !== approvalReceipt.approvedContractSha256) {
      errors.push('approved contract hash mismatch');
    }
    if (binding.approvalReceiptSha256
      !== approvalReceipt.integritySha256) {
      errors.push('mobile plan approval receipt hash mismatch');
    }
  } else {
    errors.push('mobile plan approval receipt is required for execution validation');
  }
  if (contractBytes && binding.structuredSchemaSha256 !== sha256(contractBytes)) {
    errors.push('structured schema hash mismatch');
  }
  if (reconciliationBytes
    && binding.reconciliationSha256 !== sha256(reconciliationBytes)) {
    errors.push('execution reconciliation hash mismatch');
  }
  if (reconciliation) {
    if (binding.reconciliationGeneratedAt !== reconciliation.generatedAt) {
      errors.push('execution reconciliation timestamp mismatch');
    }
    const snapshotValidation = validateSnapshot(reconciliation, {
      environmentUrl: context?.environmentUrl,
      tenantId: context?.tenantId || undefined,
    });
    if (!snapshotValidation.valid) {
      errors.push(...snapshotValidation.errors.map(
        (error) => `execution reconciliation: ${error}`,
      ));
    }
    if (reconciliation.purpose !== 'execution-reconciliation'
      || reconciliation.reconciliation?.boundedExactNames !== true
      || reconciliation.reconciliation?.fullInventoryRead !== false) {
      errors.push('execution reconciliation is not a bounded exact-name artifact');
    }
    const age = Date.parse(now) - Date.parse(reconciliation.generatedAt);
    if (!Number.isFinite(age) || age < -5 * 60 * 1000) {
      errors.push('execution reconciliation freshness cannot be established');
    } else if (age > maxReconciliationAgeMs) {
      errors.push('execution reconciliation is stale');
    }
  }
  if (contract) {
    const contractValidation = validateContract(contract);
    if (!contractValidation.valid) {
      errors.push(...contractValidation.errors.map((error) => `contract: ${error}`));
    } else {
      const expectedIds = new Set();
      for (const table of normalizedContract(contract).tables) {
        expectedIds.add(contractItemId('table', table.logicalName));
        for (const column of table.columns) {
          expectedIds.add(contractItemId('column', table.logicalName, column.logicalName));
        }
        for (const relationship of table.relationships) {
          expectedIds.add(contractItemId(
            'relationship',
            table.logicalName,
            relationship.schemaName,
          ));
        }
        for (const key of table.alternateKeys) {
          expectedIds.add(contractItemId('key', table.logicalName, key.schemaName));
        }
      }
      const actualIds = (manifest.decisions || []).map((decision) => decision.itemId);
      if (new Set(actualIds).size !== actualIds.length) {
        errors.push('manifest decision itemIds must be unique');
      }
      const actualIdSet = new Set(actualIds);
      if (expectedIds.size !== actualIdSet.size
        || [...expectedIds].some((itemId) => !actualIdSet.has(itemId))) {
        errors.push('manifest decision coverage does not match the contract');
      }
    }
  }

  const phases = manifest.execution?.phases;
  if (!Array.isArray(phases)
    || phases.map((phase) => phase.name).join(',') !== PHASE_ORDER.join(',')) {
    errors.push('manifest phase order is invalid');
  } else {
    const operations = phases.flatMap((phase) => (
      (phase.operations || []).map((item) => ({ ...item, enclosingPhase: phase.name }))
    ));
    for (const [index, item] of operations.entries()) {
      if (item.index !== index) errors.push(`operation index ${item.index} is out of order`);
      if (item.phase !== item.enclosingPhase) {
        errors.push(`operation ${item.id} phase does not match its container`);
      }
      const imageConfiguration = isImageConfigurationOperation(item);
      if (item.method !== 'POST' && !imageConfiguration) {
        errors.push(`operation ${item.id} is not an allowed manifest mutation`);
      }
      if (['DELETE', 'PATCH', 'PUT'].includes(item.method) && !imageConfiguration) {
        errors.push(`operation ${item.id} is destructive or mutating in-place`);
      }
    }
    if (manifest.summary?.metadataOperationCount !== operations.length) {
      errors.push('metadataOperationCount does not match operations');
    }
  }
  const unverified = (manifest.decisions || [])
    .filter((decision) => decision.verificationStatus !== 'verified');
  if (!Array.isArray(manifest.decisions)
    || manifest.decisions.some((decision) => !DECISIONS.has(decision.decision))) {
    errors.push('manifest decisions must use the reconciliation taxonomy');
  }
  if ((manifest.decisions || []).some(
    (decision) => !['verified', 'unverified', 'conflict'].includes(
      decision.verificationStatus,
    ),
  )) {
    errors.push('manifest decisions must include a mechanical verificationStatus');
  }
  if (manifest.summary?.decisionCount !== (manifest.decisions || []).length) {
    errors.push('decisionCount does not match decisions');
  }
  if (
    unverified.length > 0
    && (
      !Array.isArray(manifest.verification?.reconciliationScope?.exactTables)
      || manifest.verification.reconciliationScope.exactTables.length === 0
    )
  ) {
    errors.push('unresolved decisions require an explicit reconciliation scope');
  }
  if (manifest.executable !== (unverified.length === 0)) {
    errors.push('manifest executable flag does not match unverified decisions');
  }
  if (requireExecutable && !manifest.executable) {
    errors.push('manifest is not executable; approved schema revision is required');
  }
  if (contract && approvalReceipt && reconciliation && context && planBytes
    && contractBytes && reconciliationBytes) {
    try {
      const expectedManifest = buildManifest({
        contract,
        approvalReceipt,
        reconciliation,
        planBytes,
        contractBytes,
        reconciliationBytes,
        context,
        publishCheckpoint,
        now: manifest.preparedAt,
        maxReconciliationAgeMs,
      });
      if (stableJson(expectedManifest) !== stableJson(manifest)) {
        errors.push(
          'manifest semantic content does not match deterministic '
          + 'structured-schema/reconciliation rebuild',
        );
      }
    } catch (error) {
      errors.push(`manifest semantic rebuild failed: ${error.message}`);
    }
  } else {
    errors.push(
      'manifest semantic validation requires bound structured schema, '
      + 'mobile plan approval receipt, execution reconciliation, plan, and context',
    );
  }
  return { valid: errors.length === 0, errors };
}

function readBytes(file) {
  return fs.readFileSync(path.resolve(file));
}

function readJson(file) {
  return JSON.parse(readBytes(file).toString('utf8'));
}

function contextFromArgs(args) {
  return {
    environmentId: args['environment-id'],
    environmentUrl: args['env-url'],
    tenantId: args['tenant-id'] || null,
    publisherPrefix: args['publisher-prefix'],
    solutionUniqueName: args.solution,
  };
}

function usage() {
  return [
    'Build:',
    '  node build-dataverse-operation-manifest.js --contract <json> --approval-receipt <json> --reconciliation <json> --plan <md> --output <json> \\',
    '    --environment-id <id> --env-url <url> [--tenant-id <id>] --publisher-prefix <prefix> --solution <unique-name> \\',
    '    [--publish-checkpoint <json>]',
    'Normalize a planner sidecar:',
    '  node build-dataverse-operation-manifest.js --normalize-contract <json> --output <json>',
    'Bind a normalized sidecar to the fully approved plan:',
    '  node build-dataverse-operation-manifest.js --bind-plan <json> --approval-receipt <json> --plan <md> --output <json>',
    'Roll a collision checkpoint into a revised approved contract:',
    '  node build-dataverse-operation-manifest.js --roll-forward-checkpoint <json> --previous-manifest <json> \\',
    '    --journal <json> --contract <json> --approval-receipt <json> --plan <md> --output <json> --environment-id <id> \\',
    '    --env-url <url> [--tenant-id <id>] --publisher-prefix <prefix> --solution <unique-name>',
    'Write fresh reconciliation scope:',
    '  node build-dataverse-operation-manifest.js --reconciliation-scope <json> --output <json>',
    'Validate before execution:',
    '  node build-dataverse-operation-manifest.js --validate <manifest> --contract <json> --approval-receipt <json> --reconciliation <json> --plan <md> \\',
    '    --environment-id <id> --env-url <url> [--tenant-id <id>] --publisher-prefix <prefix> --solution <unique-name> \\',
    '    [--publish-checkpoint <json>] --require-executable',
  ].join('\n');
}

function main() {
  const args = parseArgs(process.argv);
  try {
    if (args['normalize-contract']) {
      if (!args.output) throw new Error('--output is required');
      const contract = readJson(args['normalize-contract']);
      const validation = validateContract(contract);
      if (!validation.valid) {
        throw new Error(`Invalid schema contract: ${validation.errors.join('; ')}`);
      }
      const normalized = normalizedContract(contract);
      atomicWriteJson(path.resolve(args.output), normalized);
      process.stdout.write(`${JSON.stringify({
        status: 'ok',
        mode: 'normalize-contract',
        output: path.resolve(args.output),
        tables: normalized.tables.length,
      })}\n`);
      return;
    }
    if (args['bind-plan']) {
      if (!args.output || !args.plan || !args['approval-receipt']) {
        throw new Error('--plan, --approval-receipt, and --output are required');
      }
      const bound = bindContractToPlan(
        readJson(args['bind-plan']),
        readBytes(args.plan),
        readJson(args['approval-receipt']),
      );
      atomicWriteJson(path.resolve(args.output), bound);
      process.stdout.write(`${JSON.stringify({
        status: 'ok',
        mode: 'bind-plan',
        output: path.resolve(args.output),
        approvedPlanSha256: bound.approvedPlanSha256,
        approvedContractSha256: bound.approvedContractSha256,
      })}\n`);
      return;
    }
    if (args['reconciliation-scope']) {
      if (!args.output) throw new Error('--output is required');
      const scope = reconciliationScope(readJson(args['reconciliation-scope']));
      atomicWriteJson(path.resolve(args.output), scope);
      process.stdout.write(`${JSON.stringify({
        status: 'ok',
        mode: 'reconciliation-scope',
        output: path.resolve(args.output),
        exactTables: scope.exactTables.length,
        proposedTables: scope.proposedTables.length,
      })}\n`);
      return;
    }
    if (args['roll-forward-checkpoint']) {
      const requiredRollForward = [
        'previous-manifest',
        'journal',
        'contract',
        'approval-receipt',
        'plan',
        'output',
        'environment-id',
        'env-url',
        'publisher-prefix',
        'solution',
      ];
      const missingRollForward = requiredRollForward.filter((key) => !args[key]);
      if (missingRollForward.length > 0) {
        throw new Error(
          `Missing roll-forward args: ${missingRollForward.join(', ')}`,
        );
      }
      const contractBytes = readBytes(args.contract);
      const planBytes = readBytes(args.plan);
      const rolled = rollForwardPublishCheckpoint({
        checkpoint: readJson(args['roll-forward-checkpoint']),
        previousManifest: readJson(args['previous-manifest']),
        journal: readJson(args.journal),
        contract: JSON.parse(contractBytes.toString('utf8')),
        approvalReceipt: readJson(args['approval-receipt']),
        contractBytes,
        planBytes,
        context: contextFromArgs(args),
        rolledAt: args.now || new Date().toISOString(),
      });
      atomicWriteJson(path.resolve(args.output), rolled);
      process.stdout.write(`${JSON.stringify({
        status: 'ok',
        mode: 'roll-forward-checkpoint',
        output: path.resolve(args.output),
        tables: rolled.tables.length,
        rollForwards: rolled.rollForwards.length,
      })}\n`);
      return;
    }

    const required = ['contract', 'approval-receipt', 'reconciliation', 'plan',
      'environment-id', 'env-url',
      'publisher-prefix', 'solution'];
    const missing = required.filter((key) => !args[key]);
    if (missing.length > 0) throw new Error(`Missing required args: ${missing.join(', ')}`);
    const contractBytes = readBytes(args.contract);
    const reconciliationBytes = readBytes(args.reconciliation);
    const planBytes = readBytes(args.plan);
    const contract = JSON.parse(contractBytes.toString('utf8'));
    const approvalReceipt = readJson(args['approval-receipt']);
    const reconciliation = JSON.parse(reconciliationBytes.toString('utf8'));
    const context = contextFromArgs(args);
    const now = args.now || new Date().toISOString();
    const maxReconciliationAgeMs = args['max-reconciliation-age-ms']
      ? Number(args['max-reconciliation-age-ms'])
      : DEFAULT_MAX_RECONCILIATION_AGE_MS;
    if (!Number.isFinite(maxReconciliationAgeMs) || maxReconciliationAgeMs <= 0) {
      throw new Error('--max-reconciliation-age-ms must be a positive number');
    }
    const publishCheckpoint = args['publish-checkpoint']
      && fs.existsSync(path.resolve(args['publish-checkpoint']))
      ? readJson(args['publish-checkpoint'])
      : null;

    if (args.validate) {
      const manifest = readJson(args.validate);
      if (manifest.publishCheckpoint
        && (!args['publish-checkpoint'] || !publishCheckpoint)) {
        throw new Error(
          'Manifest validation failed: persisted publish checkpoint is required',
        );
      }
      const validation = validateManifest(manifest, {
        planBytes,
        contractBytes,
        reconciliationBytes,
        contract,
        approvalReceipt,
        reconciliation,
        context,
        publishCheckpoint,
        now,
        maxReconciliationAgeMs,
        requireExecutable: Boolean(args['require-executable']),
      });
      if (!validation.valid) {
        throw new Error(`Manifest validation failed: ${validation.errors.join('; ')}`);
      }
      process.stdout.write(`${JSON.stringify({
        status: 'ok',
        mode: 'validate',
        executable: manifest.executable,
        operations: manifest.summary.metadataOperationCount,
      })}\n`);
      return;
    }

    if (!args.output) throw new Error('--output is required');
    const manifest = buildManifest({
      contract,
      approvalReceipt,
      reconciliation,
      planBytes,
      contractBytes,
      reconciliationBytes,
      context,
      publishCheckpoint,
      now,
      maxReconciliationAgeMs,
    });
    if (manifest.publishCheckpoint && !args['publish-checkpoint']) {
      throw new Error(
        '--publish-checkpoint is required when the manifest contains a publish operation',
      );
    }
    if (args['publish-checkpoint'] && manifest.publishCheckpoint) {
      atomicWriteJson(path.resolve(args['publish-checkpoint']), manifest.publishCheckpoint);
    }
    atomicWriteJson(path.resolve(args.output), manifest);
    process.stdout.write(`${JSON.stringify({
      status: 'ok',
      mode: 'build',
      output: path.resolve(args.output),
      executable: manifest.executable,
      operations: manifest.summary.metadataOperationCount,
      publishPending: Boolean(manifest.publishCheckpoint),
      unresolved: manifest.summary.unresolvedCount,
      unverified: manifest.summary.unverifiedCount,
      conflicts: manifest.summary.conflictCount,
      deferred: manifest.summary.deferredCount,
    })}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  APPROVAL_RECEIPT_SCHEMA_VERSION,
  CONTRACT_SCHEMA_VERSION,
  DEFAULT_MAX_RECONCILIATION_AGE_MS,
  MANIFEST_SCHEMA_VERSION,
  PHASE_ORDER,
  atomicWriteJson,
  bindContractToPlan,
  buildManifest,
  contractApprovalContent,
  createPublishCheckpoint,
  declaredServiceRequiredTableNames,
  isHiddenNameCollisionAdapt,
  normalizeColumnType,
  normalizedContract,
  parseArgs,
  reconciliationScope,
  rollForwardPublishCheckpoint,
  sha256,
  stableJson,
  validateContract,
  validateApprovalReceipt,
  validateAdaptationPolicy,
  validateManifest,
  validatePublishCheckpoint,
};
