#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  atomicWriteJson,
  createReconciliationSnapshot,
} = require('./create-dataverse-snapshot');
const { createDataverseRequestExecutor } = require('./dataverse-request');
const {
  recordPlanningDuration,
  summarizePlanningTimings,
} = require('./planning-timings');

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
}

function logicalNameFromSchema(value) {
  return normalizeName(value);
}

function tableFromApiPath(apiPath) {
  return String(apiPath || '').match(/EntityDefinitions\(LogicalName='([^']+)'\)/)?.[1] || null;
}

function changedOperations(manifest) {
  return (manifest.execution?.phases || []).flatMap((phase) => (
    (phase.operations || []).map((operation) => ({ ...operation, phase: phase.name }))
  ));
}

function normalizedNames(values) {
  return (values || []).map(normalizeName).sort();
}

function relationshipCandidates(tables) {
  return [...tables.values()].flatMap((table) => [
    ...(table.manyToOneRelationships || []).map((item) => ({
      kind: 'one-to-many',
      schemaName: item.schemaName,
      childTable: table.logicalName,
      parentTable: item.targetTable,
      lookupColumn: item.lookupColumn,
      parentColumn: item.targetColumn,
      cascadeConfiguration: item.cascadeConfiguration,
    })),
    ...(table.oneToManyRelationships || []).map((item) => ({
      kind: 'one-to-many',
      schemaName: item.schemaName,
      childTable: item.childTable,
      parentTable: table.logicalName,
      lookupColumn: item.childLookupColumn,
      parentColumn: item.parentColumn,
      cascadeConfiguration: item.cascadeConfiguration,
    })),
    ...(table.manyToManyRelationships || []).map((item) => ({
      kind: 'many-to-many',
      schemaName: item.schemaName,
      entity1: item.entity1,
      entity2: item.entity2,
      intersectTable: item.intersectTable,
    })),
  ]);
}

function expectedRelationship(operation) {
  const body = operation.body || {};
  if (/\.ManyToManyRelationshipMetadata$/.test(String(body['@odata.type'] || ''))
    || body.Entity1LogicalName || body.Entity2LogicalName) {
    return {
      kind: 'many-to-many',
      schemaName: body.SchemaName,
      entity1: body.Entity1LogicalName,
      entity2: body.Entity2LogicalName,
      intersectTable: body.IntersectEntityName,
    };
  }
  return {
    kind: 'one-to-many',
    schemaName: body.SchemaName,
    childTable: body.ReferencingEntity,
    parentTable: body.ReferencedEntity,
    lookupColumn: body.ReferencingAttribute || body.Lookup?.SchemaName,
    parentColumn: body.ReferencedAttribute || null,
    cascadeConfiguration: body.CascadeConfiguration || {},
  };
}

function relationshipMatches(actual, expected) {
  if (actual.kind !== expected.kind) return false;
  if (expected.kind === 'many-to-many') {
    return normalizeName(actual.entity1) === normalizeName(expected.entity1)
      && normalizeName(actual.entity2) === normalizeName(expected.entity2)
      && normalizeName(actual.intersectTable) === normalizeName(expected.intersectTable);
  }
  const endpointsMatch = normalizeName(actual.childTable) === normalizeName(expected.childTable)
    && normalizeName(actual.parentTable) === normalizeName(expected.parentTable)
    && normalizeName(actual.lookupColumn) === normalizeName(expected.lookupColumn)
    && (!expected.parentColumn
      || normalizeName(actual.parentColumn) === normalizeName(expected.parentColumn));
  return endpointsMatch && Object.entries(expected.cascadeConfiguration).every(
    ([key, value]) => normalizeName(actual.cascadeConfiguration?.[key]) === normalizeName(value),
  );
}

function mediaExpectations(operations) {
  const values = [];
  for (const operation of operations) {
    const tableLogicalName = operation.phase === 'tableCreates'
      ? logicalNameFromSchema(operation.body?.SchemaName)
      : normalizeName(tableFromApiPath(operation.apiPath));
    const attributes = operation.phase === 'tableCreates'
      ? operation.body?.Attributes || []
      : operation.phase === 'extensions'
        ? [operation.body]
        : [];
    for (const attribute of attributes) {
      const type = String(attribute?.['@odata.type'] || '');
      if (!/\.(?:Image|File)AttributeMetadata$/.test(type)) continue;
      values.push({
        tableLogicalName,
        columnLogicalName: logicalNameFromSchema(attribute.SchemaName),
        kind: type.includes('.ImageAttributeMetadata') ? 'Image' : 'File',
        maxSizeInKB: Number(attribute.MaxSizeInKB),
        canStoreFullImage: type.includes('.ImageAttributeMetadata')
          ? Boolean(attribute.CanStoreFullImage)
          : null,
      });
    }
  }
  return values;
}

function verifyChangedScope({
  manifest,
  reconciliation,
  executionOutcome,
  imageConfigurations = [],
}) {
  const mismatches = [];
  const pendingActivations = [];
  const operations = changedOperations(manifest);
  const changedOperationCount = operations.filter((item) => item.phase !== 'publish').length;
  const publishSatisfied = executionOutcome?.status === 'DONE'
    && (executionOutcome?.reasonCode === 'PUBLISH_CONFIRMED'
      || (changedOperationCount === 0
        && executionOutcome?.reasonCode === 'NO_PUBLISH_REQUIRED'));
  if (!publishSatisfied) {
    mismatches.push({
      fact: 'publish',
      expected: 'confirmed',
      actual: executionOutcome?.reasonCode || executionOutcome?.status || 'missing',
    });
  }
  const tables = new Map((reconciliation.tables || []).map(
    (table) => [normalizeName(table.logicalName), table],
  ));
  const relationships = relationshipCandidates(tables);
  for (const operation of operations) {
    if (operation.phase === 'tableCreates') {
      const logicalName = logicalNameFromSchema(operation.body?.SchemaName);
      const table = tables.get(logicalName);
      if (!table) {
        mismatches.push({ fact: 'table', name: logicalName, expected: 'present', actual: 'missing' });
        continue;
      }
      for (const [manifestName, reconciliationName] of [
        ['IsAvailableOffline', 'isAvailableOffline'],
        ['ChangeTrackingEnabled', 'changeTrackingEnabled'],
      ]) {
        if (Object.prototype.hasOwnProperty.call(operation.body || {}, manifestName)
          && table[reconciliationName] !== Boolean(operation.body[manifestName])) {
          mismatches.push({
            fact: 'table-setting',
            table: logicalName,
            name: manifestName,
            expected: Boolean(operation.body[manifestName]),
            actual: table[reconciliationName] ?? null,
          });
        }
      }
      for (const attribute of operation.body?.Attributes || []) {
        const columnName = logicalNameFromSchema(attribute.SchemaName);
        const column = (table.columns || []).find(
          (item) => normalizeName(item.logicalName) === columnName,
        );
        if (!column) {
          mismatches.push({
            fact: 'column',
            table: logicalName,
            name: columnName,
            expected: 'present',
            actual: 'missing',
          });
        }
      }
    } else if (operation.phase === 'extensions') {
      const tableName = normalizeName(tableFromApiPath(operation.apiPath));
      const columnName = logicalNameFromSchema(operation.body?.SchemaName);
      const column = (tables.get(tableName)?.columns || []).find(
        (item) => normalizeName(item.logicalName) === columnName,
      );
      if (!column) {
        mismatches.push({ fact: 'column', table: tableName, name: columnName, expected: 'present', actual: 'missing' });
      }
    } else if (operation.phase === 'relationships') {
      const expected = expectedRelationship(operation);
      const matchingNames = relationships.filter(
        (item) => normalizeName(item.schemaName) === normalizeName(expected.schemaName),
      );
      if (matchingNames.length === 0) {
        mismatches.push({ fact: 'relationship', name: expected.schemaName, expected: 'present', actual: 'missing' });
      } else if (!matchingNames.some((item) => relationshipMatches(item, expected))) {
        mismatches.push({
          fact: 'relationship-semantics',
          name: expected.schemaName,
          expected,
          actual: matchingNames,
        });
      }
    } else if (operation.phase === 'alternateKeys') {
      const tableName = normalizeName(tableFromApiPath(operation.apiPath));
      const expected = operation.body || {};
      const key = (tables.get(tableName)?.alternateKeys || []).find(
        (item) => normalizeName(item.schemaName) === normalizeName(expected.SchemaName),
      );
      if (!key) {
        mismatches.push({ fact: 'alternate-key', table: tableName, name: expected.SchemaName, expected: 'present', actual: 'missing' });
      } else if (JSON.stringify(normalizedNames(key.columns))
        !== JSON.stringify(normalizedNames(expected.KeyAttributes))) {
        mismatches.push({
          fact: 'alternate-key-members',
          table: tableName,
          name: expected.SchemaName,
          expected: normalizedNames(expected.KeyAttributes),
          actual: normalizedNames(key.columns),
        });
      } else if (!['active', 'pending'].includes(normalizeName(key.status))) {
        mismatches.push({ fact: 'alternate-key', table: tableName, name: expected.SchemaName, expected: 'Active or Pending', actual: key.status || 'missing' });
      } else if (normalizeName(key.status) === 'pending') {
        pendingActivations.push({
          tableLogicalName: tableName,
          schemaName: key.schemaName,
          status: key.status,
        });
      }
    }
  }

  const imageConfigByColumn = new Map(imageConfigurations.map((item) => [
    `${normalizeName(item.parententitylogicalname)}:${normalizeName(item.attributelogicalname)}`,
    Boolean(item.canstorefullimage),
  ]));
  for (const expected of mediaExpectations(operations)) {
    const column = (tables.get(expected.tableLogicalName)?.columns || []).find(
      (item) => normalizeName(item.logicalName) === expected.columnLogicalName,
    );
    if (!column) continue;
    if (normalizeName(column.type) !== normalizeName(expected.kind)) {
      mismatches.push({
        fact: 'column-type',
        table: expected.tableLogicalName,
        name: expected.columnLogicalName,
        expected: expected.kind,
        actual: column.type || null,
      });
    }
    if (Number(column.maxSizeInKB) < expected.maxSizeInKB) {
      mismatches.push({
        fact: 'MaxSizeInKB',
        table: expected.tableLogicalName,
        name: expected.columnLogicalName,
        expected: expected.maxSizeInKB,
        actual: column.maxSizeInKB ?? null,
      });
    }
    if (expected.kind === 'Image'
      && Boolean(column.canStoreFullImage) !== expected.canStoreFullImage) {
      mismatches.push({
        fact: 'CanStoreFullImage',
        table: expected.tableLogicalName,
        name: expected.columnLogicalName,
        expected: expected.canStoreFullImage,
        actual: Boolean(column.canStoreFullImage),
      });
    }
    if (expected.kind === 'Image' && expected.canStoreFullImage === true
      && imageConfigByColumn.get(
        `${expected.tableLogicalName}:${expected.columnLogicalName}`,
      ) !== true) {
      mismatches.push({
        fact: 'attributeimageconfig',
        table: expected.tableLogicalName,
        name: expected.columnLogicalName,
        expected: true,
        actual: false,
      });
    }
  }
  return {
    schemaVersion: 1,
    status: mismatches.length > 0
      ? 'BLOCKED'
      : pendingActivations.length > 0
        ? 'DONE_WITH_PENDING_ACTIVATIONS'
        : 'DONE',
    manifestSha256: manifest.integritySha256 || null,
    reconciliationGeneratedAt: reconciliation.generatedAt || null,
    changedOperationCount,
    mismatches,
    pendingActivations,
  };
}

async function imageConfigurationsForOperations(request, operations) {
  const configurations = [];
  for (const expected of mediaExpectations(operations).filter(
    (item) => item.kind === 'Image' && item.canStoreFullImage,
  )) {
    const apiPath = [
      'attributeimageconfigs?',
      '$select=parententitylogicalname,attributelogicalname,canstorefullimage',
      `&$filter=parententitylogicalname eq '${expected.tableLogicalName}' `,
      `and attributelogicalname eq '${expected.columnLogicalName}'`,
    ].join('');
    const response = await request('GET', apiPath);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `Image configuration verification failed for `
        + `${expected.tableLogicalName}.${expected.columnLogicalName} (${response.status})`,
      );
    }
    configurations.push(...(response.data?.value || []));
  }
  return configurations;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--manifest') args.manifestPath = argv[++index];
    else if (argv[index] === '--execution-outcome') args.executionOutcomePath = argv[++index];
    else if (argv[index] === '--reconciliation-output') args.reconciliationOutput = argv[++index];
    else if (argv[index] === '--output') args.output = argv[++index];
    else if (argv[index] === '--timings-output') args.timingsPath = argv[++index];
    else if (argv[index] === '--env-url') args.environmentUrl = argv[++index];
    else if (argv[index] === '--tenant-id') args.tenantId = argv[++index];
    else if (argv[index] === '--timeout-ms') args.timeoutMs = argv[++index];
    else if (argv[index] === '--json') args.json = true;
  }
  return args;
}

async function verifyFromFiles(args) {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(args.manifestPath), 'utf8'));
  const executionOutcome = JSON.parse(
    fs.readFileSync(path.resolve(args.executionOutcomePath), 'utf8'),
  );
  const scope = manifest.verification?.reconciliationScope;
  if (!Array.isArray(scope?.exactTables) || scope.exactTables.length === 0) {
    throw new Error('manifest verification scope is missing exact tables');
  }
  const request = createDataverseRequestExecutor({
    environmentUrl: args.environmentUrl,
    tenantId: args.tenantId,
    timeoutMs: args.timeoutMs,
  });
  const startedAt = Date.now();
  const reconciliation = await createReconciliationSnapshot({
    environmentUrl: args.environmentUrl,
    tenantId: args.tenantId,
    tableNames: scope.exactTables,
    proposedTableNames: scope.proposedTables || [],
    readConcurrency: 1,
    request,
  });
  atomicWriteJson(path.resolve(args.reconciliationOutput), reconciliation);
  const imageConfigurations = await imageConfigurationsForOperations(
    request,
    changedOperations(manifest),
  );
  const postPublishVerificationMs = Math.max(0, Date.now() - startedAt);
  const result = {
    ...verifyChangedScope({
      manifest,
      reconciliation,
      executionOutcome,
      imageConfigurations,
    }),
    postPublishVerificationMs,
  };
  if (args.timingsPath) {
    const timings = recordPlanningDuration(
      args.timingsPath,
      'postPublishVerification',
      postPublishVerificationMs,
    );
    result.timingSummary = summarizePlanningTimings(timings);
  }
  atomicWriteJson(path.resolve(args.output), result);
  return result;
}

async function main(argv = process.argv) {
  const args = parseArgs(argv);
  const required = [
    'manifestPath',
    'executionOutcomePath',
    'reconciliationOutput',
    'output',
    'environmentUrl',
  ];
  const missing = required.filter((key) => !args[key]);
  if (missing.length > 0) {
    process.stderr.write(`verify-dataverse-post-publish: missing ${missing.join(', ')}\n`);
    return 2;
  }
  try {
    const result = await verifyFromFiles(args);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.status === 'BLOCKED' ? 2 : 0;
  } catch (error) {
    process.stderr.write(`verify-dataverse-post-publish: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) {
  main().then((exitCode) => { process.exitCode = exitCode; });
}

module.exports = {
  changedOperations,
  imageConfigurationsForOperations,
  main,
  mediaExpectations,
  verifyChangedScope,
  verifyFromFiles,
};
