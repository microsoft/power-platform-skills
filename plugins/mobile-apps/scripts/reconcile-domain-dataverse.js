#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { domainModelRevision, validatePrototypeDomainModel } = require('./lib/prototype-domain-model');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function outputPath(root, value, label) {
  const target = path.resolve(root, value);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error(`${label} must remain inside the project root`);
  let cursor = root;
  for (const part of path.relative(root, path.dirname(target)).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`${label} parent must not contain a symlink`);
  }
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  return target;
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function normalized(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function logicalSuffix(value) {
  return String(value || '').replace(/^[a-z][a-z0-9]*_/, '');
}

function compatibleType(domainType, dataverseType) {
  const type = normalized(dataverseType);
  const compatible = {
    id: ['uniqueidentifier', 'guid'],
    text: ['string', 'text'],
    'multiline-text': ['memo', 'multilinetext', 'string'],
    boolean: ['boolean', 'bool'],
    'whole-number': ['integer', 'int', 'biginteger', 'wholenumber'],
    decimal: ['decimal', 'double', 'float'],
    money: ['money', 'decimal'],
    date: ['datetime', 'dateonly', 'date'],
    'date-time': ['datetime', 'dateandtime'],
    choice: ['choice', 'picklist', 'state', 'status'],
    reference: ['lookup', 'customer', 'owner'],
    url: ['string', 'url'],
    email: ['string', 'email'],
    phone: ['string', 'phone'],
    image: ['string', 'url'],
  };
  return (compatible[domainType] || []).includes(type);
}

function serviceMethods(source) {
  const methods = new Set();
  for (const pattern of [/(?:static\s+)?async\s+([A-Za-z_$][\w$]*)\s*\(/g, /^\s*([A-Za-z_$][\w$]*)\s*:\s*async\s*\(/gm]) {
    let match;
    while ((match = pattern.exec(source)) !== null) methods.add(match[1]);
  }
  return methods;
}

function serviceForTable(projectRoot, table) {
  const directory = path.join(projectRoot, 'src', 'generated', 'services');
  if (!fs.existsSync(directory)) return null;
  const files = fs.readdirSync(directory).filter((name) => name.endsWith('Service.ts'));
  const requested = table.serviceName || `${String(table.logicalName || '').replace(/^./, (value) => value.toUpperCase())}Service`;
  const exact = files.find((name) => normalized(path.basename(name, '.ts')) === normalized(requested));
  if (!exact) return null;
  const service = path.basename(exact, '.ts');
  return {
    service,
    serviceModule: `@/generated/services/${service}`,
    methods: serviceMethods(fs.readFileSync(path.join(directory, exact), 'utf8')),
  };
}

function tableCandidates(entity, tables) {
  const keys = new Set([normalized(entity.key), normalized(entity.displayName), normalized(entity.displayPluralName)]);
  return tables.filter((table) => [table.displayName, table.displayPluralName, logicalSuffix(table.logicalName)]
    .some((value) => keys.has(normalized(value))));
}

function fieldCandidates(field, table) {
  const keys = new Set([normalized(field.key), normalized(field.displayName)]);
  return (table.columns || []).filter((column) => (
    [column.displayName, logicalSuffix(column.logicalName), column.schemaName].some((value) => keys.has(normalized(value)))
    && compatibleType(field.type, column.type || column.attributeType)
  ));
}

function fixtureCurrency(model, entityKey, fieldKey) {
  const values = new Set((model.fixtures?.[entityKey] || []).map((row) => row[fieldKey]?.currencyCode).filter(Boolean));
  return values.size === 1 ? [...values][0] : null;
}

function transformForField(model, entity, field, column, conflicts) {
  if (field.type === 'choice') {
    const choice = model.choices.find((candidate) => candidate.key === field.choiceKey);
    const options = column.options || [];
    const choiceMap = {};
    for (const option of choice?.options || []) {
      const matches = options.filter((candidate) => normalized(candidate.label) === normalized(option.label));
      if (matches.length !== 1) conflicts.push({ kind: 'choice-option', domainEntity: entity.key, domainField: field.key, option: option.key, message: `Choice ${field.choiceKey}.${option.key} has ${matches.length} Dataverse label matches.` });
      else choiceMap[option.key] = matches[0].value;
    }
    return { transform: 'choice', choiceMap };
  }
  if (field.type === 'money') {
    const defaultCurrencyCode = fixtureCurrency(model, entity.key, field.key);
    if (!defaultCurrencyCode) conflicts.push({ kind: 'money-currency', domainEntity: entity.key, domainField: field.key, message: 'Money mapping requires one prototype currency or an explicit reviewed mapping.' });
    return { transform: 'money', defaultCurrencyCode };
  }
  if (field.type === 'reference') {
    const sourceColumn = column.logicalName;
    const navigationProperty = column.navigationProperty || column.schemaName;
    if (!navigationProperty) conflicts.push({ kind: 'reference-navigation', domainEntity: entity.key, domainField: field.key, message: `Reference ${entity.key}.${field.key} requires a verified Dataverse navigation property.` });
    return {
      transform: 'reference',
      dataverseField: sourceColumn.startsWith('_') && sourceColumn.endsWith('_value') ? sourceColumn : `_${sourceColumn}_value`,
      sourceColumn,
      writeField: navigationProperty ? `${navigationProperty}@odata.bind` : null,
      targetDomainEntity: field.referenceTarget,
      targetEntitySetName: null,
    };
  }
  if (field.type === 'image') return { transform: 'image-url', altTextField: entity.primaryNameField };
  if (['whole-number', 'decimal'].includes(field.type)) return { transform: 'number' };
  return { transform: field.type };
}

function reconcileDomainDataverse(projectRoot, options = {}) {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const domainPath = path.resolve(root, options.domain || '.tmp/prototype-domain-model.json');
  const manifestPath = path.resolve(root, options.manifest || '.datamodel-manifest.json');
  const reportPath = outputPath(root, options.report || '.tmp/dataverse-reconciliation-report.json', 'reconciliation report');
  const mappingPath = outputPath(root, options.mapping || '.tmp/dataverse-repository-mapping.json', 'repository mapping');
  if (reportPath === mappingPath) throw new Error('reconciliation report and repository mapping must use different paths');
  const model = readJson(domainPath, 'Prototype domain model');
  const domainValidation = validatePrototypeDomainModel(model);
  if (!domainValidation.valid) throw new Error(`prototype domain model is invalid: ${domainValidation.errors.join('; ')}`);
  const manifest = readJson(manifestPath, 'Dataverse manifest');
  const tables = Array.isArray(manifest.tables) ? manifest.tables : [];
  const conflicts = [];
  const warnings = [];
  const entities = [];
  for (const entity of model.entities) {
    const matches = tableCandidates(entity, tables);
    if (matches.length !== 1) {
      conflicts.push({ kind: 'entity', domainEntity: entity.key, candidates: matches.map((table) => table.logicalName), message: `Entity ${entity.key} has ${matches.length} semantic Dataverse matches.` });
      continue;
    }
    const table = matches[0];
    const service = serviceForTable(root, table);
    if (!service) conflicts.push({ kind: 'service', domainEntity: entity.key, table: table.logicalName, message: `No generated service resolves for ${table.logicalName}.` });
    const fields = [];
    for (const field of entity.fields) {
      if (field.type === 'id') {
        if (!table.primaryIdAttribute) conflicts.push({ kind: 'field', domainEntity: entity.key, domainField: field.key, message: `Table ${table.logicalName} has no primaryIdAttribute.` });
        else fields.push({ domainField: field.key, dataverseField: table.primaryIdAttribute, transform: 'id', required: field.required });
        continue;
      }
      const candidates = fieldCandidates(field, table);
      if (candidates.length !== 1) {
        const finding = { kind: 'field', domainEntity: entity.key, domainField: field.key, candidates: candidates.map((column) => column.logicalName), message: `Field ${entity.key}.${field.key} has ${candidates.length} compatible Dataverse matches.` };
        if (field.required) conflicts.push(finding); else warnings.push(finding);
        continue;
      }
      const column = candidates[0];
      fields.push({ domainField: field.key, dataverseField: column.logicalName, required: field.required, ...transformForField(model, entity, field, column, conflicts) });
    }
    entities.push({
      domainEntity: entity.key,
      tableLogicalName: table.logicalName,
      entitySetName: table.entitySetName || null,
      primaryIdAttribute: table.primaryIdAttribute,
      service: service?.service || null,
      serviceModule: service?.serviceModule || null,
      availableServiceMethods: service ? [...service.methods].sort() : [],
      fields,
    });
  }
  for (const entity of entities) {
    for (const field of entity.fields.filter((candidate) => candidate.transform === 'reference')) {
      const target = entities.find((candidate) => candidate.domainEntity === field.targetDomainEntity);
      if (!target?.entitySetName) conflicts.push({ kind: 'reference-target', domainEntity: entity.domainEntity, domainField: field.domainField, message: `Reference ${entity.domainEntity}.${field.domainField} requires a reconciled target entity set.` });
      else field.targetEntitySetName = target.entitySetName;
    }
  }

  const methodByKind = { list: 'getAll', get: 'get', create: 'create', update: 'update', delete: 'delete' };
  const operations = [];
  for (const operation of model.operations) {
    const entity = entities.find((candidate) => candidate.domainEntity === operation.entity);
    if (!entity) continue;
    const serviceMethod = methodByKind[operation.kind];
    if (!entity.availableServiceMethods.includes(serviceMethod)) conflicts.push({ kind: 'operation', domainOperation: operation.key, message: `Generated service ${entity.service || '<missing>'} lacks ${serviceMethod}.` });
    const mapField = (field) => entity.fields.find((candidate) => candidate.domainField === field)?.dataverseField || null;
    const operationFields = new Set([
      ...(operation.selectFields || []),
      ...(operation.filterFields || []),
      ...(operation.sortFields || []),
      ...(operation.writeFields || []),
    ]);
    for (const field of operationFields) {
      if (!mapField(field)) conflicts.push({ kind: 'operation-field', domainOperation: operation.key, domainField: field, message: `Operation ${operation.key} requires unmapped field ${operation.entity}.${field}.` });
    }
    const domainEntity = model.entities.find((candidate) => candidate.key === operation.entity);
    const selectedDomainFields = new Set([
      ...(operation.selectFields || []),
      ...(domainEntity?.fields || []).filter((field) => field.required).map((field) => field.key),
    ]);
    const select = [...selectedDomainFields].map(mapField).filter(Boolean);
    if (!select.includes(entity.primaryIdAttribute)) select.unshift(entity.primaryIdAttribute);
    operations.push({
      domainOperation: operation.key,
      domainEntity: operation.entity,
      repository: operation.repository,
      method: operation.method,
      kind: operation.kind,
      service: entity.service,
      serviceModule: entity.serviceModule,
      serviceMethod,
      select,
      filters: Object.fromEntries((operation.filterFields || []).map((field) => [field, mapField(field)]).filter(([, value]) => value)),
      sort: Object.fromEntries((operation.sortFields || []).map((field) => [field, mapField(field)]).filter(([, value]) => value)),
      pagination: operation.pagination,
    });
  }

  const report = {
    schemaVersion: 1,
    status: conflicts.length ? 'blocked' : 'ready',
    domainModelRevision: domainModelRevision(model),
    dataverseManifestSha256: sha256(fs.readFileSync(manifestPath)),
    mappings: { entities: entities.length, operations: operations.length },
    conflicts,
    warnings,
  };
  if (conflicts.length) {
    fs.rmSync(mappingPath, { force: true });
    writeJsonAtomic(reportPath, report);
    return { report, mapping: null };
  }
  const mapping = {
    schemaVersion: 1,
    domainModelRevision: report.domainModelRevision,
    dataverseManifestSha256: report.dataverseManifestSha256,
    entities: entities.map(({ availableServiceMethods, ...entity }) => entity),
    operations,
  };
  // Publish the ready report last. An interrupted mapping write can never leave
  // a fresh report claiming that an absent or partial mapping is executable.
  writeJsonAtomic(mappingPath, mapping);
  writeJsonAtomic(reportPath, report);
  return { report, mapping };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--domain') args.domain = argv[++index];
    else if (argv[index] === '--manifest') args.manifest = argv[++index];
    else if (argv[index] === '--report') args.report = argv[++index];
    else if (argv[index] === '--mapping') args.mapping = argv[++index];
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args.projectRoot) {
    process.stderr.write('Usage: node reconcile-domain-dataverse.js --project-root <dir> [--domain <path>] [--manifest <path>] [--report <path>] [--mapping <path>]\n');
    return 2;
  }
  try {
    const result = reconcileDomainDataverse(args.projectRoot, args);
    process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
    return result.report.status === 'ready' ? 0 : 2;
  } catch (error) {
    process.stderr.write(`BLOCKED: domain-Dataverse reconciliation: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { reconcileDomainDataverse };