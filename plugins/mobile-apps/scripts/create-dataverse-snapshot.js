#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--') && argv[i + 1]) args[argv[i].slice(2)] = argv[++i];
  }
  return args;
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}

function odataString(value) {
  return value.replace(/'/g, "''");
}

async function createSnapshot({ environmentUrl, tableNames, request }) {
  if (!environmentUrl) throw new Error('environmentUrl is required');
  tableNames ||= [];
  const expansion = [
    '$select=LogicalName,SchemaName,EntitySetName,PrimaryIdAttribute,PrimaryNameAttribute,IsCustomEntity,IsManaged,IsCustomizable,CanCreateAttributes',
    '$expand=Attributes($select=LogicalName,SchemaName,AttributeType,AttributeTypeName,IsCustomAttribute,IsPrimaryId,IsPrimaryName,IsValidForCreate,IsValidForRead,IsValidForUpdate),',
    'ManyToOneRelationships($select=SchemaName,ReferencingAttribute,ReferencedEntity,ReferencedAttribute)',
  ].join('&');
  const entities = [];
  let next = `EntityDefinitions?${expansion}&$filter=IsCustomizable%2FValue%20eq%20true`;
  while (next) {
    const response = await request('GET', next);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Customizable-table metadata snapshot failed: ${response.error || response.status}`);
    }
    entities.push(...(response.data?.value || []));
    const nextLink = response.data?.['@odata.nextLink'];
    const marker = '/api/data/v9.2/';
    const markerIndex = nextLink ? nextLink.indexOf(marker) : -1;
    next = nextLink ? (markerIndex >= 0 ? nextLink.slice(markerIndex + marker.length) : nextLink) : null;
  }

  const byLogicalName = new Map(entities.map((entity) => [entity.LogicalName, entity]));
  for (const logicalName of [...new Set(tableNames)].sort()) {
    if (byLogicalName.has(logicalName)) continue;
    const response = await request(
      'GET',
      `EntityDefinitions(LogicalName='${odataString(logicalName)}')?${expansion}`,
    );
    if (response.status >= 200 && response.status < 300) {
      byLogicalName.set(response.data.LogicalName, response.data);
    } else if (response.status !== 404) {
      throw new Error(`Metadata snapshot failed for ${logicalName}: ${response.error || response.status}`);
    }
  }

  const tables = [...byLogicalName.values()].map((entity) => ({
      logicalName: entity.LogicalName,
      schemaName: entity.SchemaName,
      entitySetName: entity.EntitySetName,
      primaryIdAttribute: entity.PrimaryIdAttribute,
      primaryNameAttribute: entity.PrimaryNameAttribute,
      customEntity: Boolean(entity.IsCustomEntity),
      managed: Boolean(entity.IsManaged),
      customizable: Boolean(entity.IsCustomizable?.Value),
      canCreateAttributes: Boolean(entity.CanCreateAttributes?.Value),
      columns: (entity.Attributes || []).map((attribute) => ({
        logicalName: attribute.LogicalName,
        schemaName: attribute.SchemaName,
        type: attribute.AttributeType,
        typeName: attribute.AttributeTypeName?.Value || null,
        customAttribute: Boolean(attribute.IsCustomAttribute),
        primaryId: Boolean(attribute.IsPrimaryId),
        primaryName: Boolean(attribute.IsPrimaryName),
        validForCreate: Boolean(attribute.IsValidForCreate),
        validForRead: Boolean(attribute.IsValidForRead),
        validForUpdate: Boolean(attribute.IsValidForUpdate),
      })),
      manyToOneRelationships: (entity.ManyToOneRelationships || []).map((relationship) => ({
        schemaName: relationship.SchemaName,
        lookupColumn: relationship.ReferencingAttribute,
        targetTable: relationship.ReferencedEntity,
        targetColumn: relationship.ReferencedAttribute,
      })),
    }));

  return {
    version: 1,
    environmentUrl,
    generatedAt: new Date().toISOString(),
    tables,
    missingProposedTables: tableNames.filter((logicalName) => !byLogicalName.has(logicalName)),
  };
}

function createCliRequest(args) {
  const script = path.join(__dirname, 'dataverse-request.js');
  return async (method, apiPath) => {
    const command = [script, args['env-url'], method, apiPath];
    if (args.solution) command.push('--solution', args.solution);
    if (args['tenant-id']) command.push('--tenant-id', args['tenant-id']);
    return JSON.parse(execFileSync(process.execPath, command, { encoding: 'utf8' }).trim());
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args['env-url'] || !args.output) {
    process.stderr.write('Usage: node create-dataverse-snapshot.js --env-url <url> --output <json> [--tables <known-logical-name,...>] [--tenant-id <id>]\n');
    process.exit(1);
  }
  const snapshot = await createSnapshot({
    environmentUrl: args['env-url'],
    tableNames: (args.tables || '').split(',').map((value) => value.trim()).filter(Boolean),
    request: createCliRequest(args),
  });
  const output = path.resolve(args.output);
  atomicWriteJson(output, snapshot);
  console.log(JSON.stringify({ status: 'DONE', output, tables: snapshot.tables.length }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}

module.exports = { atomicWriteJson, createSnapshot, odataString };
