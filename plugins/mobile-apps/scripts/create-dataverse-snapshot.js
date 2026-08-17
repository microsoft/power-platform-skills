#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ATTRIBUTE_SELECT = [
  'MetadataId',
  'LogicalName',
  'SchemaName',
  'AttributeType',
  'AttributeTypeName',
  'IsCustomAttribute',
  'IsPrimaryId',
  'IsPrimaryName',
  'IsValidForCreate',
  'IsValidForRead',
  'IsValidForUpdate',
  'SourceType',
].join(',');

const CHOICE_TYPES = [
  'PicklistAttributeMetadata',
  'MultiSelectPicklistAttributeMetadata',
  'StateAttributeMetadata',
  'StatusAttributeMetadata',
  'BooleanAttributeMetadata',
];

const FORMULA_TYPE_BY_ATTRIBUTE = {
  BigInt: 'BigIntAttributeMetadata',
  Boolean: 'BooleanAttributeMetadata',
  DateTime: 'DateTimeAttributeMetadata',
  Decimal: 'DecimalAttributeMetadata',
  Double: 'DoubleAttributeMetadata',
  Integer: 'IntegerAttributeMetadata',
  Money: 'MoneyAttributeMetadata',
  Picklist: 'PicklistAttributeMetadata',
  String: 'StringAttributeMetadata',
};

const CONCEPT_ALIASES = {
  associate: ['systemuser'],
  associates: ['systemuser'],
  manager: ['systemuser'],
  managers: ['systemuser'],
  store: ['stocklocation'],
  stores: ['stocklocation'],
};

const GENERIC_CONCEPT_TOKENS = new Set([
  'and',
  'data',
  'record',
  'records',
  'report',
  'reports',
  'stock',
  'table',
  'tables',
]);

const MAX_TABLES_PER_CONCEPT = 12;

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

function normalizeNextLink(nextLink) {
  const marker = '/api/data/v9.2/';
  const markerIndex = nextLink ? nextLink.indexOf(marker) : -1;
  return nextLink && markerIndex >= 0 ? nextLink.slice(markerIndex + marker.length) : nextLink;
}

async function requestCollection(request, apiPath, label, { optional = false } = {}) {
  const values = [];
  let next = apiPath;
  while (next) {
    const response = await request('GET', normalizeNextLink(next));
    if (response.status < 200 || response.status >= 300) {
      if (optional && [400, 404].includes(response.status)) return [];
      throw new Error(`${label} failed: ${response.error || response.status}`);
    }
    values.push(...(response.data?.value || []));
    next = response.data?.['@odata.nextLink'] || null;
  }
  return values;
}

function labelText(label) {
  return label?.UserLocalizedLabel?.Label ||
    label?.LocalizedLabels?.find((item) => item.LanguageCode === 1033)?.Label ||
    label?.LocalizedLabels?.[0]?.Label ||
    '';
}

function singularizeToken(token) {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

function normalizedTokens(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(singularizeToken);
}

function compact(value) {
  return normalizedTokens(value).join('');
}

function entitySearchParts(entity) {
  return [
    entity.LogicalName,
    entity.SchemaName,
    entity.EntitySetName,
    labelText(entity.DisplayName),
    labelText(entity.DisplayCollectionName),
  ].filter(Boolean);
}

function publisherPrefix(logicalName) {
  const match = String(logicalName || '').toLowerCase().match(/^([a-z][a-z0-9]*)_/);
  return match?.[1] || '';
}

function versionPenalty(logicalName) {
  const value = String(logicalName || '').toLowerCase().replace(/^[a-z][a-z0-9]*_/, '');
  return /^(?:v[0-9a-z]+|m[0-9a-z]+|old[0-9a-z]*|main[0-9a-z]*)_/.test(value) ? 300 : 0;
}

function conceptDescriptor(value) {
  const raw = String(value || '').trim().toLowerCase();
  const tokens = normalizedTokens(raw);
  const aliases = (CONCEPT_ALIASES[raw] || [])
    .flatMap((alias) => normalizedTokens(alias));
  const matchTokens = [...new Set([...tokens, ...aliases])]
    .filter((token) => token.length >= 3 && !GENERIC_CONCEPT_TOKENS.has(token));
  return {
    compactValues: [...new Set([
      compact(raw),
      ...(CONCEPT_ALIASES[raw] || []).map(compact),
    ].filter((item) => item.length >= 3))],
    matchTokens,
  };
}

function scoreEntityForConcept(entity, descriptor) {
  const logicalName = String(entity.LogicalName || '').toLowerCase();
  const parts = entitySearchParts(entity);
  const compactParts = parts.map(compact);
  const tokenSet = new Set(parts.flatMap(normalizedTokens));
  let score = 0;

  for (const value of descriptor.compactValues) {
    if (compactParts.some((part) => part === value)) score = Math.max(score, 1000);
    else if (compactParts.some((part) => part.endsWith(value))) score = Math.max(score, 900);
    else if (compactParts.some((part) => part.includes(value))) score = Math.max(score, 750);
  }
  if (descriptor.matchTokens.some((token) => tokenSet.has(token))) score = Math.max(score, 500);
  if (descriptor.matchTokens.some((token) => compactParts.some((part) => part.includes(token)))) {
    score = Math.max(score, 400);
  }

  return score - versionPenalty(logicalName) - Math.min(logicalName.length, 100) / 100;
}

function selectDetailedEntities(entities, tableNames, concepts) {
  const exactNames = new Set(tableNames.map((value) => value.toLowerCase()));
  const selected = new Set(
    entities
      .filter((entity) => exactNames.has(String(entity.LogicalName).toLowerCase()))
      .map((entity) => entity.LogicalName),
  );

  for (const concept of concepts) {
    const descriptor = conceptDescriptor(concept);
    if (descriptor.compactValues.length === 0 && descriptor.matchTokens.length === 0) continue;
    const candidates = entities
      .map((entity) => ({ entity, score: scoreEntityForConcept(entity, descriptor) }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score);
    if (candidates.length === 0) continue;

    const bestPrefix = publisherPrefix(candidates[0].entity.LogicalName);
    const familyToken = descriptor.matchTokens[0];
    const familyThreshold = candidates[0].score - 300;
    const preferred = candidates.filter((candidate) => (
      publisherPrefix(candidate.entity.LogicalName) === bestPrefix
      && versionPenalty(candidate.entity.LogicalName) === 0
      && (
        candidate.score >= familyThreshold
        || (familyToken && entitySearchParts(candidate.entity).flatMap(normalizedTokens).includes(familyToken))
      )
    ));
    for (const candidate of (preferred.length ? preferred : candidates).slice(0, MAX_TABLES_PER_CONCEPT)) {
      selected.add(candidate.entity.LogicalName);
    }
  }

  return entities.filter((entity) => selected.has(entity.LogicalName));
}

function normalizeChoiceOptions(metadata) {
  const optionSet = metadata.OptionSet || metadata.GlobalOptionSet;
  const options = optionSet?.Options || [
    optionSet?.FalseOption,
    optionSet?.TrueOption,
  ].filter(Boolean);
  return options.map((option) => ({
    value: option.Value,
    label: labelText(option.Label),
  }));
}

async function loadDetailedEntity(request, entity) {
  const logicalName = entity.LogicalName;
  const root = `EntityDefinitions(LogicalName='${odataString(logicalName)}')`;
  const attributes = await requestCollection(
    request,
    `${root}/Attributes?$select=${ATTRIBUTE_SELECT}`,
    `${logicalName} attributes`,
  );
  const relationships = await requestCollection(
    request,
    `${root}/ManyToOneRelationships?$select=SchemaName,ReferencingAttribute,ReferencedEntity,ReferencedAttribute`,
    `${logicalName} relationships`,
  );
  const keys = await requestCollection(
    request,
    `${root}/Keys?$select=LogicalName,SchemaName,KeyAttributes,EntityKeyIndexStatus`,
    `${logicalName} alternate keys`,
  );

  const choices = new Map();
  for (const type of CHOICE_TYPES) {
    const metadata = await requestCollection(
      request,
      `${root}/Attributes/Microsoft.Dynamics.CRM.${type}?$select=LogicalName,FormulaDefinition&$expand=OptionSet,GlobalOptionSet`,
      `${logicalName} ${type}`,
      { optional: true },
    );
    for (const item of metadata) {
      choices.set(item.LogicalName, {
        options: normalizeChoiceOptions(item),
        formula: item.FormulaDefinition || null,
      });
    }
  }

  const lookups = new Map();
  const lookupMetadata = await requestCollection(
    request,
    `${root}/Attributes/Microsoft.Dynamics.CRM.LookupAttributeMetadata?$select=LogicalName,Targets`,
    `${logicalName} lookup metadata`,
    { optional: true },
  );
  for (const item of lookupMetadata) lookups.set(item.LogicalName, item.Targets || []);

  const formulas = new Map();
  for (const attribute of attributes.filter(
    (item) => [1, 2, 3].includes(item.SourceType) && item.MetadataId,
  )) {
    const type = FORMULA_TYPE_BY_ATTRIBUTE[attribute.AttributeType];
    if (!type) continue;
    const response = await request(
      'GET',
      `${root}/Attributes(${attribute.MetadataId})/Microsoft.Dynamics.CRM.${type}?$select=LogicalName,FormulaDefinition`,
    );
    if (response.status >= 200 && response.status < 300 && response.data?.FormulaDefinition) {
      formulas.set(attribute.LogicalName, response.data.FormulaDefinition);
    } else if (response.status !== 404) {
      throw new Error(
        `${logicalName} ${attribute.LogicalName} formula metadata failed (${response.status}): `
        + `${response.error || JSON.stringify(response.data || {})}`,
      );
    }
  }

  return {
    logicalName,
    schemaName: entity.SchemaName,
    displayName: labelText(entity.DisplayName),
    displayCollectionName: labelText(entity.DisplayCollectionName),
    entitySetName: entity.EntitySetName,
    primaryIdAttribute: entity.PrimaryIdAttribute,
    primaryNameAttribute: entity.PrimaryNameAttribute,
    customEntity: Boolean(entity.IsCustomEntity),
    managed: Boolean(entity.IsManaged),
    customizable: Boolean(entity.IsCustomizable?.Value),
    canCreateAttributes: Boolean(entity.CanCreateAttributes?.Value),
    columns: attributes.map((attribute) => ({
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
      sourceType: attribute.SourceType ?? null,
      lookupTargets: lookups.get(attribute.LogicalName) || [],
      choices: choices.get(attribute.LogicalName)?.options || [],
      formula: formulas.get(attribute.LogicalName) || choices.get(attribute.LogicalName)?.formula || null,
    })),
    manyToOneRelationships: relationships.map((relationship) => ({
      schemaName: relationship.SchemaName,
      lookupColumn: relationship.ReferencingAttribute,
      targetTable: relationship.ReferencedEntity,
      targetColumn: relationship.ReferencedAttribute,
    })),
    alternateKeys: keys.map((key) => ({
      logicalName: key.LogicalName,
      schemaName: key.SchemaName,
      columns: key.KeyAttributes || [],
      status: key.EntityKeyIndexStatus || null,
    })),
  };
}

async function createSnapshot({ environmentUrl, tableNames = [], concepts = [], request }) {
  if (!environmentUrl) throw new Error('environmentUrl is required');
  const entities = await requestCollection(
    request,
    [
      'EntityDefinitions?',
      '$select=LogicalName,SchemaName,DisplayName,DisplayCollectionName,EntitySetName,',
      'PrimaryIdAttribute,PrimaryNameAttribute,IsCustomEntity,IsManaged,IsCustomizable,CanCreateAttributes',
      '&$filter=IsCustomizable/Value eq true',
      '&LabelLanguages=1033',
    ].join(''),
    'Customizable-table inventory',
  );
  const detailedEntities = selectDetailedEntities(entities, tableNames, concepts);
  const tables = [];
  for (const entity of detailedEntities) tables.push(await loadDetailedEntity(request, entity));

  return {
    version: 2,
    environmentUrl,
    generatedAt: new Date().toISOString(),
    inventory: entities.map((entity) => ({
      logicalName: entity.LogicalName,
      schemaName: entity.SchemaName,
      displayName: labelText(entity.DisplayName),
      displayCollectionName: labelText(entity.DisplayCollectionName),
      entitySetName: entity.EntitySetName,
      customEntity: Boolean(entity.IsCustomEntity),
      customizable: Boolean(entity.IsCustomizable?.Value),
      canCreateAttributes: Boolean(entity.CanCreateAttributes?.Value),
    })),
    tables,
    concepts,
    missingProposedTables: tableNames.filter(
      (logicalName) => !entities.some((entity) => entity.LogicalName === logicalName),
    ),
  };
}

function createCliRequest(args) {
  const script = path.join(__dirname, 'dataverse-request.js');
  return async (method, apiPath) => {
    const command = [script, args['env-url'], method, apiPath];
    if (args.solution) command.push('--solution', args.solution);
    if (args['tenant-id']) command.push('--tenant-id', args['tenant-id']);
    return JSON.parse(execFileSync(process.execPath, command, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }).trim());
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args['env-url'] || !args.output) {
    process.stderr.write('Usage: node create-dataverse-snapshot.js --env-url <url> --output <json> [--tables <logical-name,...>] [--concepts <domain-term,...>] [--tenant-id <id>]\n');
    process.exit(1);
  }
  const snapshot = await createSnapshot({
    environmentUrl: args['env-url'],
    tableNames: (args.tables || '').split(',').map((value) => value.trim()).filter(Boolean),
    concepts: (args.concepts || '').split(',').map((value) => value.trim()).filter(Boolean),
    request: createCliRequest(args),
  });
  const output = path.resolve(args.output);
  atomicWriteJson(output, snapshot);
  console.log(JSON.stringify({
    status: 'DONE',
    output,
    inventoryTables: snapshot.inventory.length,
    detailedTables: snapshot.tables.length,
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  atomicWriteJson,
  createSnapshot,
  labelText,
  normalizeNextLink,
  odataString,
  requestCollection,
  selectDetailedEntities,
  singularizeToken,
};
