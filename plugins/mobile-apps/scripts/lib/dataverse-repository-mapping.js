'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { verifyDataverseServices } = require('../verify-dataverse-services');
const { validateDomain } = require('./prototype-domain');
const { inside, revision, readJson, assertRevision } = require('./prototype-files');
const { sha256Hex } = require('./product-experience-contracts');

const NAME = /^[a-z][a-z0-9_]*$/;
const SYMBOL = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const TYPE_MAP = {
  text: ['string', 'memo'], number: ['integer', 'double', 'decimal', 'money'],
  boolean: ['boolean'], datetime: ['datetime'], choice: ['picklist', 'choice', 'state', 'status'],
  lookup: ['lookup'], photo: ['image'],
};

function typeName(column) {
  const name = String(column.typeName || column.type || '').toLowerCase().replace(/type$/, '');
  return name === 'virtual' && column.attributeTypeName ? String(column.attributeTypeName).toLowerCase().replace(/type$/, '') : name;
}

function maskServiceLiterals(source) {
  let masked = '';
  for (let index = 0; index < source.length;) {
    const start = index;
    if (source[index] === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
    } else if (source[index] === '/' && source[index + 1] === '*') {
      index = source.indexOf('*/', index + 2);
      if (index < 0) throw new Error('Unterminated generated service comment');
      index += 2;
    } else if (['"', "'", '`'].includes(source[index])) {
      const quote = source[index++];
      while (index < source.length && source[index] !== quote) index += source[index] === '\\' ? 2 : 1;
      if (index >= source.length) throw new Error('Unterminated generated service literal');
      index += 1;
    } else {
      masked += source[index++];
      continue;
    }
    masked += source.slice(start, index).replace(/[^\r\n]/g, ' ');
  }
  return masked;
}

function inspectService(source, exportName) {
  const masked = maskServiceLiterals(source);
  const escapedExport = String(exportName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const classes = [...masked.matchAll(new RegExp(`\\bexport\\s+(?:declare\\s+)?class\\s+${escapedExport}\\b[^;{]*\\{`, 'g'))];
  if (!SYMBOL.test(exportName) || classes.length !== 1) {
    throw new Error(`Official service must export the declared class ${exportName}`);
  }
  const classStart = classes[0].index + classes[0][0].length;
  const depths = [];
  let depth = 1;
  let classEnd = classStart;
  for (; classEnd < masked.length && depth > 0; classEnd += 1) {
    depths[classEnd - classStart] = depth;
    if (masked[classEnd] === '{') depth += 1;
    else if (masked[classEnd] === '}') depth -= 1;
  }
  if (depth !== 0) throw new Error('Unterminated official service class');
  const classBody = masked.slice(classStart, classEnd - 1);
  const methods = {};
  // Only the current generated static-method grammar is accepted. Unknown
  // overloads, arrow properties, unions, or renamed SDK option types block
  // generation rather than being guessed from a filename.
  const pattern = /\b(?:public\s+)?static\s+(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(([^()]*)\)\s*:\s*(Promise\s*<\s*IOperationResult\s*<[\s\S]*?>\s*>)\s*\{/g;
  for (const match of classBody.matchAll(pattern)) {
    if (depths[match.index] !== 1) continue;
    const name = match[1];
    if (methods[name]) throw new Error(`Ambiguous generated service method ${name}`);
    const parameters = match[2].split(',').map((value) => value.trim()).filter(Boolean);
    methods[name] = { parameters, returnType: match[3].replace(/\s+/g, ' '), signature: match[0].slice(0, -1).trim() };
  }
  const check = (name, count, checks) => {
    const method = methods[name];
    if (!method || method.parameters.length !== count || checks.some((test, index) => !test.test(method.parameters[index]))) {
      throw new Error(`Unsupported or missing official service signature ${exportName}.${name}`);
    }
  };
  check('getAll', 1, [/^\w+\??\s*:\s*IGetAllOptions(?:\s*=\s*\{\s*\})?$/]);
  check('get', 2, [/^\w+\s*:\s*string$/, /^\w+\??\s*:\s*IGetOptions(?:\s*=\s*\{\s*\})?$/]);
  check('create', 1, [/^\w+\s*:\s*(?:Partial<)?[A-Za-z_$][\w$]*(?:>)?$/]);
  check('update', 2, [/^\w+\s*:\s*string$/, /^\w+\s*:\s*(?:Partial<)?[A-Za-z_$][\w$]*(?:>)?$/]);
  check('delete', 1, [/^\w+\s*:\s*string$/]);
  if (!/IOperationResult\s*<[^>]+\[\]\s*>/.test(methods.getAll.returnType)) {
    throw new Error('getAll must return the SDK data-array/skipToken result');
  }
  return methods;
}

function compileDataverseMapping({ root, domain: inputDomain, mapping, schema, snapshot, persistence, bindings, relationshipEvidence = {} }) {
  const domain = validateDomain(inputDomain);
  assertRevision(persistence, 'persistenceRevision', 'Persistence contract');
  if (!['dataverse', 'mixed'].includes(persistence.mode)) throw new Error('Connected mapping requires approved Dataverse/mixed ownership');
  if (mapping.schemaVersion !== 1 || mapping.domainRevision !== revision(domain)
    || mapping.schemaRevision !== revision(schema) || !Array.isArray(mapping.entities)) {
    throw new Error('Mapping is missing or bound to stale domain/schema revisions');
  }
  const owners = new Map(persistence.conceptOwners.map((entry) => [entry.conceptId, entry.owner]));
  if (owners.size !== persistence.conceptOwners.length || bindings.schemaVersion !== 1
    || !Array.isArray(bindings.entities) || bindings.entities.length !== domain.entities.length
    || new Set(bindings.entities.map((entry) => entry.entityId)).size !== bindings.entities.length
    || new Set(bindings.entities.map((entry) => entry.conceptId)).size !== bindings.entities.length) {
    throw new Error('Connected mapping requires unique canonical logical concept bindings');
  }
  const bindingMap = new Map(bindings.entities.map((entry) => [entry.entityId, entry.conceptId]));
  const seen = new Set();
  const services = [];
  const compiledEntities = mapping.entities.map((entry) => {
    const entity = domain.entities.find((candidate) => candidate.id === entry.entityId);
    if (!entity || seen.has(entity.id)) throw new Error('Mapping has a duplicate or unknown entity');
    seen.add(entity.id);
    const owner = owners.get(bindingMap.get(entity.id));
    if (entry.owner !== owner) throw new Error(`Mapping cannot change the approved owner of ${entity.id}`);
    if (owner !== 'dataverse') {
      if (entry.decision !== 'defer' || entry.logicalName || entry.fields?.length) {
        throw new Error(`Non-Dataverse owner ${owner} must retain its current adapter without table mappings`);
      }
      if (/^connector:[a-z0-9][a-z0-9-]*$/.test(owner)) {
        const adapter = entry.retainedAdapter;
        if (!adapter || !/^src\/data\/[A-Za-z0-9_/-]+\.ts$/.test(adapter.file || '') || !SYMBOL.test(adapter.exportName || '')) {
          throw new Error(`Connector-owned ${entity.id} requires its exact existing app-owned repository, not a local fallback`);
        }
        const content = fs.readFileSync(inside(root, adapter.file), 'utf8');
        const exported = String(adapter.exportName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (sha256Hex(content) !== adapter.sha256
          || !new RegExp(`\\bexport\\s+const\\s+${exported}\\b`).test(maskServiceLiterals(content))) {
          throw new Error('Retained connector repository export/hash changed');
        }
        return { entityId: entity.id, owner, decision: 'defer', retainedAdapter: {
          file: adapter.file, exportName: adapter.exportName, sha256: adapter.sha256,
        } };
      }
      if (!['local', 'transient'].includes(owner) || entry.retainedAdapter) throw new Error(`Unsupported retained owner ${owner}`);
      return { entityId: entity.id, owner, decision: 'defer' };
    }
    if (!NAME.test(entry.logicalName || '')) throw new Error('Mapping requires an exact logical table name');
    const approved = schema.tables.find((table) => (table.adaptedLogicalName || table.logicalName) === entry.logicalName);
    if (!approved || approved.plannedDecision !== entry.decision || entry.decision === 'defer' || !approved.serviceRequired) {
      throw new Error(`Table ${entry.logicalName} is not an approved service-required table decision`);
    }
    const physical = snapshot.tables?.find((table) => table.logicalName === entry.logicalName);
    if (!physical || !NAME.test(physical.primaryIdAttribute || '') || !NAME.test(physical.entitySetName || '')) {
      throw new Error(`Materialized table evidence is missing for ${entry.logicalName}`);
    }
    if (physical.detailLevel !== 'full' || physical.missingDetailClasses?.length) throw new Error('Mapping requires a full bounded materialized-table snapshot');
    const verified = verifyDataverseServices(root, [entry.logicalName])[0];
    if (verified.entitySetName !== physical.entitySetName || entry.serviceFile !== verified.serviceFile) {
      throw new Error('Mapping must use the exact officially generated entity-set service');
    }
    const relative = `src/generated/services/${verified.serviceFile}`;
    const source = fs.readFileSync(inside(root, relative), 'utf8');
    const serviceSha256 = sha256Hex(source);
    if (entry.serviceSha256 !== serviceSha256) throw new Error('Official service changed since mapping review');
    const methods = inspectService(source, entry.serviceExport);
    services.push({ file: relative, sha256: serviceSha256, exportName: entry.serviceExport, methods });
    const seenFields = new Set();
    const seenColumns = new Set();
    const fields = (entry.fields || []).map((fieldMapping) => {
      const field = entity.fields.find((candidate) => candidate.id === fieldMapping.fieldId);
      if (!field || seenFields.has(field.id) || !NAME.test(fieldMapping.column || '') || seenColumns.has(fieldMapping.column)) {
        throw new Error('Every domain field requires an unambiguous physical column mapping');
      }
      seenFields.add(field.id);
      seenColumns.add(fieldMapping.column);
      const column = physical.columns?.find((candidate) => candidate.logicalName === fieldMapping.column);
      const approvedColumn = approved.columns.find((candidate) => (candidate.adaptedLogicalName || candidate.logicalName) === fieldMapping.column);
      if (!column || !approvedColumn || approvedColumn.plannedDecision === 'defer' || !TYPE_MAP[field.type].includes(typeName(column))) {
        throw new Error(`Unsupported or unapproved column mapping ${entity.id}.${field.id}`);
      }
      if (((column.sourceType > 0 || column.formulaDefinition) && (entity.operations.includes('create') || entity.operations.includes('update')))
        || column.validForRead === false
        || (entity.operations.includes('create') && column.validForCreate === false)
        || (entity.operations.includes('update') && column.validForUpdate === false)) {
        throw new Error(`Read-only/computed mapping cannot preserve ${entity.id}.${field.id}`);
      }
      if (column.requiredLevel === 'ApplicationRequired' && !field.required) {
        throw new Error(`Required physical column would strengthen the approved logical rule for ${entity.id}.${field.id}`);
      }
      const result = { fieldId: field.id, type: field.type, column: fieldMapping.column, readColumn: fieldMapping.column };
      if (field.type === 'datetime' && column.dateTimeBehavior !== 'UserLocal') {
        throw new Error(`Datetime ${entity.id}.${field.id} requires verified UTC-instant/UserLocal behavior, not a guessed date-only or wall-clock conversion`);
      }
      if (field.type === 'choice') {
        const map = fieldMapping.choiceMap;
        if (!map || Object.keys(map).length !== field.options.length
          || field.options.some((option) => !Number.isInteger(map[option.id]))
          || new Set(Object.values(map)).size !== field.options.length
          || Object.values(map).some((value) => !(column.choices || column.options || []).some((option) => option.value === value))) {
          throw new Error(`Every choice ID needs one verified numeric value for ${entity.id}.${field.id}`);
        }
        result.choiceMap = map;
      }
      if (field.type === 'lookup') {
        const target = mapping.entities.find((candidate) => candidate.entityId === field.targetEntityId);
        const targetTable = snapshot.tables.find((table) => table.logicalName === target?.logicalName);
        const relation = (relationshipEvidence[entry.logicalName] || []).find((candidate) => (
          candidate.ReferencingAttribute === column.logicalName
          && candidate.ReferencedEntity === target?.logicalName
          && candidate.ReferencingEntityNavigationPropertyName === fieldMapping.navigationProperty
        ));
        if (target?.owner !== 'dataverse' || !targetTable || !relation
          || !SYMBOL.test(fieldMapping.navigationProperty || '')
          || column.lookupTargets?.length !== 1 || column.lookupTargets[0] !== target.logicalName) {
          throw new Error(`Lookup ${entity.id}.${field.id} needs exact single-target navigation-property evidence`);
        }
        result.readColumn = `_${column.logicalName}_value`;
        result.navigationProperty = fieldMapping.navigationProperty;
        result.targetEntitySet = targetTable.entitySetName;
      }
      if (field.type === 'photo') {
        if (fieldMapping.mediaStrategy !== 'image-base64' || approvedColumn.requiredLevel === 'ApplicationRequired'
          || column.requiredLevel === 'ApplicationRequired') {
          throw new Error('Photo mapping requires an optional Dataverse Image column and the approved image-base64 strategy');
        }
        result.mediaStrategy = 'image-base64';
        result.maxSizeInKB = column.maxSizeInKB;
        if (!Number.isInteger(result.maxSizeInKB) || result.maxSizeInKB < 1) throw new Error('Image size evidence is required');
      }
      return result;
    });
    if (seenFields.size !== entity.fields.length) throw new Error(`Mapping would lose fields from ${entity.id}`);
    if (entity.operations.includes('create') && physical.columns.some((column) => (
      column.requiredLevel === 'ApplicationRequired' && column.validForCreate !== false
      && !column.primaryId && column.logicalName !== physical.primaryIdAttribute && !seenColumns.has(column.logicalName)
    ))) throw new Error(`Unmapped required writable columns would prevent creating ${entity.id}`);
    return {
      entityId: entity.id, owner, decision: entry.decision, logicalName: entry.logicalName,
      entitySetName: physical.entitySetName, primaryId: physical.primaryIdAttribute,
      serviceFile: verified.serviceFile, serviceExport: entry.serviceExport, serviceSha256,
      fields, operations: entity.operations,
    };
  });
  if (seen.size !== domain.entities.length) throw new Error('Mapping must preserve every domain entity and owner');
  if (!compiledEntities.some((entry) => entry.owner === 'dataverse')) throw new Error('No approved Dataverse entity was selected; keep the prototype local or approve a real table');
  const environmentId = readJson(root, 'power.config.json').environmentId;
  if (typeof environmentId !== 'string' || !environmentId.trim()) throw new Error('Mapping requires the officially initialized environment identity');
  const result = {
    schemaVersion: 1, contractType: 'dataverse-repository-mapping',
    domainRevision: revision(domain), schemaRevision: revision(schema),
    persistenceRevision: persistence.persistenceRevision, snapshotRevision: revision(snapshot),
    relationshipEvidenceRevision: revision(relationshipEvidence),
    environmentKey: revision({ environmentId }),
    entities: compiledEntities, services,
  };
  result.mappingRevision = revision(result);
  return result;
}

module.exports = { inspectService, compileDataverseMapping };
