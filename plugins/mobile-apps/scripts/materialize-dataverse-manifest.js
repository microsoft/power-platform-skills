#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  atomicWriteJson,
  normalizedContract,
  validateContract,
} = require('./build-dataverse-operation-manifest');

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
}

function outputColumnType(value) {
  const normalized = normalizeName(value).replace(/[\s_-]/g, '');
  const values = {
    bigint: 'BigInt',
    boolean: 'Boolean',
    choice: 'Choice',
    date: 'DateTime',
    datetime: 'DateTime',
    decimal: 'Decimal',
    double: 'Double',
    file: 'File',
    image: 'Image',
    integer: 'Integer',
    lookup: 'Lookup',
    memo: 'Memo',
    money: 'Money',
    multiselectchoice: 'MultiSelectChoice',
    string: 'String',
    text: 'String',
    uniqueidentifier: 'Uniqueidentifier',
    virtual: 'Virtual',
    wholenumber: 'Integer',
  };
  return values[normalized] || String(value || 'Unknown');
}

function effectiveTableName(manifest, table) {
  return normalizeName(
    manifest.aliases?.tables?.[table.logicalName]
      || table.adaptedLogicalName
      || table.logicalName,
  );
}

function effectiveColumnName(manifest, effectiveTable, column) {
  return normalizeName(
    manifest.aliases?.columns?.[`${effectiveTable}:${column.logicalName}`]
      || column.adaptedLogicalName
      || column.logicalName,
  );
}

function includedComponent(component) {
  return !['defer', 'unverified'].includes(normalizeName(component.plannedDecision));
}

function materializedColumn(manifest, effectiveTable, column, liveTable) {
  const logicalName = effectiveColumnName(manifest, effectiveTable, column);
  const live = (liveTable.columns || []).find(
    (item) => normalizeName(item.logicalName) === logicalName,
  );
  if (!live) throw new Error(`verified table ${effectiveTable} is missing column ${logicalName}`);
  const type = outputColumnType(column.type || live.type);
  return {
    logicalName,
    type,
    ...(type === 'Image' ? {
      canStoreFullImage: Boolean(live.canStoreFullImage),
      maxSizeInKB: Number(live.maxSizeInKB),
      ...(Number.isFinite(live.maxHeight) ? { thumbnailHeight: Number(live.maxHeight) } : {}),
      ...(Number.isFinite(live.maxWidth) ? { thumbnailWidth: Number(live.maxWidth) } : {}),
    } : {}),
    ...(type === 'File' ? { maxSizeInKB: Number(live.maxSizeInKB) } : {}),
  };
}

function materializedRelationship(manifest, relationship) {
  const schemaName = relationship.adaptedSchemaName || relationship.schemaName;
  if (relationship.kind === 'many-to-many') {
    return {
      schemaName,
      kind: 'many-to-many',
      entity1: normalizeName(
        manifest.aliases?.tables?.[normalizeName(relationship.entity1)]
          || relationship.entity1,
      ),
      entity2: normalizeName(
        manifest.aliases?.tables?.[normalizeName(relationship.entity2)]
          || relationship.entity2,
      ),
      intersectTable: normalizeName(
        relationship.adaptedIntersectTable || relationship.intersectTable,
      ),
    };
  }
  const childTable = normalizeName(
    manifest.aliases?.tables?.[normalizeName(relationship.childTable)]
      || relationship.childTable,
  );
  const parentTable = normalizeName(
    manifest.aliases?.tables?.[normalizeName(relationship.parentTable)]
      || relationship.parentTable,
  );
  const lookupColumn = effectiveColumnName(
    manifest,
    childTable,
    relationship.lookup || {},
  );
  return {
    schemaName,
    kind: 'many-to-one',
    parentTable,
    childTable,
    lookupColumn,
    deleteBehavior: relationship.cascadeConfiguration?.Delete
      || relationship.deleteBehavior
      || 'RemoveLink',
  };
}

function materializedKey(manifest, effectiveTable, key, liveTable) {
  const schemaName = key.adaptedSchemaName || key.schemaName;
  const keyAttributes = key.columns.map((column) => normalizeName(
    manifest.aliases?.columns?.[`${effectiveTable}:${normalizeName(column)}`]
      || column,
  ));
  const live = (liveTable.alternateKeys || []).find(
    (item) => normalizeName(item.schemaName) === normalizeName(schemaName),
  );
  if (!live) throw new Error(`verified table ${effectiveTable} is missing key ${schemaName}`);
  return {
    schemaName,
    keyAttributes,
    indexStatus: live.status || null,
  };
}

function buildMaterializedManifest({
  manifest,
  contract,
  reconciliation,
  context,
  previousManifest = null,
  nowIso = () => new Date().toISOString(),
}) {
  if (manifest?.executable !== true) {
    throw new Error('only an executable verified manifest can be materialized');
  }
  const validation = validateContract(contract);
  if (!validation.valid) {
    throw new Error(`Invalid Dataverse contract: ${validation.errors.join('; ')}`);
  }
  const normalized = normalizedContract(contract);
  if (previousManifest?.environmentId
    && normalizeName(previousManifest.environmentId) !== normalizeName(context.environmentId)) {
    throw new Error('previous materialized manifest environmentId does not match');
  }
  if (previousManifest?.environmentUrl
    && String(previousManifest.environmentUrl).replace(/\/+$/, '').toLowerCase()
      !== String(context.environmentUrl).replace(/\/+$/, '').toLowerCase()) {
    throw new Error('previous materialized manifest environmentUrl does not match');
  }
  const decisions = new Map((manifest.decisions || [])
    .filter((item) => item.itemType === 'table')
    .map((item) => [normalizeName(item.requestedName), item]));
  const liveTables = new Map((reconciliation.tables || []).map(
    (table) => [normalizeName(table.logicalName), table],
  ));
  const previousTables = new Map((previousManifest?.tables || []).flatMap((table) => [
    [normalizeName(table.logicalName), table],
    ...(table.requestedLogicalName
      ? [[normalizeName(table.requestedLogicalName), table]]
      : []),
  ]));
  const tables = [];
  const representedTableNames = new Set();
  for (const table of normalized.tables) {
    const logicalName = effectiveTableName(manifest, table);
    representedTableNames.add(table.logicalName);
    representedTableNames.add(logicalName);
    const previous = previousTables.get(logicalName)
      || previousTables.get(table.logicalName)
      || null;
    const changed = (manifest.decisions || []).some((item) => (
      (item.itemType === 'table'
        ? normalizeName(item.requestedName) === table.logicalName
        : normalizeName(item.table) === table.logicalName)
      && item.operation !== 'none'
    ));
    const approvedOwnership = ['create', 'adapt', 'extend'].includes(table.plannedDecision);
    if (!previous && !changed && !approvedOwnership) continue;
    const decision = decisions.get(table.logicalName);
    if (!decision || decision.verificationStatus !== 'verified') {
      throw new Error(`table ${table.logicalName} is not verified for materialization`);
    }
    const live = liveTables.get(logicalName);
    if (!live) throw new Error(`verified reconciliation is missing table ${logicalName}`);
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(String(live.metadataId || ''))) {
      throw new Error(`verified table ${logicalName} has no valid MetadataId`);
    }
    const status = previous?.status
      || (['create', 'adapt'].includes(table.plannedDecision) ? 'new' : 'extended');
    tables.push({
      logicalName,
      ...(logicalName !== table.logicalName
        ? { requestedLogicalName: table.logicalName }
        : {}),
      displayName: live.displayName || table.displayName || logicalName,
      entitySetName: live.entitySetName || null,
      status,
      metadataId: live.metadataId,
      solution: context.solutionUniqueName,
      dependencyTier: table.dependencyTier,
      columns: table.columns
        .filter(includedComponent)
        .map((column) => materializedColumn(manifest, logicalName, column, live))
        .sort((left, right) => left.logicalName.localeCompare(right.logicalName)),
      relationships: table.relationships
        .filter(includedComponent)
        .map((relationship) => materializedRelationship(manifest, relationship))
        .sort((left, right) => left.schemaName.localeCompare(right.schemaName)),
      alternateKeys: table.alternateKeys
        .filter(includedComponent)
        .map((key) => materializedKey(manifest, logicalName, key, live))
        .sort((left, right) => left.schemaName.localeCompare(right.schemaName)),
    });
  }
  for (const previous of previousManifest?.tables || []) {
    if (representedTableNames.has(normalizeName(previous.logicalName))
      || representedTableNames.has(normalizeName(previous.requestedLogicalName))) {
      continue;
    }
    tables.push(structuredClone(previous));
  }
  tables.sort((left, right) => (
    left.dependencyTier - right.dependencyTier
    || left.logicalName.localeCompare(right.logicalName)
  ));
  return {
    schemaVersion: 1,
    environmentId: context.environmentId,
    environmentUrl: String(context.environmentUrl).replace(/\/+$/, ''),
    generatedAt: nowIso(),
    solution: context.solutionUniqueName,
    publisherPrefix: context.publisherPrefix,
    aliases: {
      ...(previousManifest?.aliases || {}),
      ...(manifest.aliases?.tables || {}),
    },
    tables,
  };
}

function materializeFromFiles({
  manifestPath,
  contractPath,
  reconciliationPath,
  outputPath,
  context,
  fileSystem = fs,
}) {
  const previousManifest = fileSystem.existsSync(path.resolve(outputPath))
    ? JSON.parse(fileSystem.readFileSync(path.resolve(outputPath), 'utf8'))
    : null;
  const result = buildMaterializedManifest({
    manifest: JSON.parse(fileSystem.readFileSync(path.resolve(manifestPath), 'utf8')),
    contract: JSON.parse(fileSystem.readFileSync(path.resolve(contractPath), 'utf8')),
    reconciliation: JSON.parse(fileSystem.readFileSync(path.resolve(reconciliationPath), 'utf8')),
    context,
    previousManifest,
  });
  atomicWriteJson(path.resolve(outputPath), result, fileSystem);
  return result;
}

module.exports = {
  buildMaterializedManifest,
  materializeFromFiles,
  outputColumnType,
};