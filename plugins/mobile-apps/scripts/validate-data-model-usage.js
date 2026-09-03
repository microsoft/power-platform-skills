#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  contractApprovalContent,
  validateContract,
} = require('./build-dataverse-operation-manifest');
const { conceptId } = require('./compile-persistence-contract');
const {
  canonicalJson,
  contractRevision,
  sha256Hex,
} = require('./lib/product-experience-contracts');

const DEFAULT_PATHS = {
  input: '.tmp/data-model-usage-input.json',
  scope: '.tmp/product-scope-contract.json',
  persistence: '.tmp/persistence-contract.json',
  journey: '.tmp/workflow-journey-contract.json',
  dataModel: '.tmp/dataverse-schema-contract.json',
  output: '.tmp/data-model-usage.json',
};
const CONSUMER_KINDS = new Set([
  'requirement',
  'job',
  'screen',
  'domain-operation',
  'integration',
  'reporting',
  'audit',
]);
const EXEMPTION_KINDS = new Set([
  'primary-name',
  'platform-required',
  'ownership',
  'audit',
]);
const DUPLICATION_KINDS = new Set([
  'approved-denormalization',
  'approved-synchronization',
]);
const PERSISTABLE_OPERATIONS = new Set([
  'read',
  'create',
  'update',
  'delete',
  'external-call',
  'local-state',
]);

function finding(code, message, pointer = null) {
  return pointer ? { code, message, pointer } : { code, message };
}

function dataModelRevision(dataModel) {
  if (!dataModel) return null;
  return sha256Hex(canonicalJson(contractApprovalContent(dataModel)));
}

function sourceBindings(source) {
  return {
    scopeRevision: contractRevision(source.scope),
    persistenceRevision: source.persistence.persistenceRevision,
    journeyRevision: contractRevision(source.journey),
    dataModelRevision: dataModelRevision(source.dataModel),
  };
}

function indexSource(source) {
  const requirements = new Map((source.scope.requirements || []).map(
    (item) => [item.id, item],
  ));
  const jobs = new Map([
    ...(source.scope.coreJobs || []),
    ...(source.scope.supportingJobs || []),
  ].map((item) => [item.id, item]));
  const screens = new Map((source.scope.screens || []).map((item) => [item.id, item]));
  const entities = new Map((source.scope.dataEntities || []).map(
    (item) => [conceptId(item.name), item],
  ));
  const owners = new Map((source.persistence.conceptOwners || []).map(
    (item) => [item.conceptId, item],
  ));
  const operations = new Map();
  const operationsByRequirement = new Map();
  for (const journey of source.journey.journeys || []) {
    for (const step of journey.steps || []) {
      const id = `${journey.id}:${step.id}`;
      const operation = {
        id,
        journeyId: journey.id,
        jobId: journey.jobId,
        stepId: step.id,
        screenId: step.surface?.screenId || null,
        kind: step.dataOperation?.kind,
        entity: step.dataOperation?.entity || null,
        conceptId: step.dataOperation?.entity ? conceptId(step.dataOperation.entity) : null,
      };
      operations.set(id, operation);
      for (const requirementId of step.satisfies || []) {
        if (!operationsByRequirement.has(requirementId)) {
          operationsByRequirement.set(requirementId, []);
        }
        operationsByRequirement.get(requirementId).push(operation);
      }
    }
  }
  const tables = new Map((source.dataModel?.tables || []).map(
    (item) => [String(item.logicalName).toLowerCase(), item],
  ));
  return {
    requirements,
    jobs,
    screens,
    entities,
    owners,
    operations,
    operationsByRequirement,
    tables,
  };
}

function validateConsumer(consumer, index, errors, pointer) {
  if (!consumer || typeof consumer !== 'object' || Array.isArray(consumer)) {
    errors.push(finding('invalid-consumer', 'consumer must be an object', pointer));
    return null;
  }
  if (!CONSUMER_KINDS.has(consumer.kind)) {
    errors.push(finding(
      'invalid-consumer',
      `consumer kind ${consumer.kind || '(missing)'} is unsupported`,
      pointer,
    ));
    return null;
  }
  const id = String(consumer.id || '').trim();
  if (!id) {
    errors.push(finding('invalid-consumer', 'consumer id is required', pointer));
    return null;
  }
  const known = consumer.kind === 'requirement' ? index.requirements.has(id)
    : consumer.kind === 'job' ? index.jobs.has(id)
      : consumer.kind === 'screen' ? index.screens.has(id)
        : consumer.kind === 'domain-operation' ? index.operations.has(id)
          : true;
  if (!known) {
    errors.push(finding(
      'unknown-consumer',
      `${consumer.kind} consumer ${id} does not exist in canonical contracts`,
      pointer,
    ));
    return null;
  }
  if (['integration', 'reporting', 'audit'].includes(consumer.kind)
    && (!consumer.reason || String(consumer.reason).trim().length < 10)) {
    errors.push(finding(
      'consumer-reason-required',
      `${consumer.kind} consumer ${id} requires a reason`,
      pointer,
    ));
    return null;
  }
  return {
    kind: consumer.kind,
    id,
    ...(consumer.reason ? { reason: String(consumer.reason).trim() } : {}),
  };
}

function validateExemption(column, exemption, errors, pointer) {
  if (!exemption || typeof exemption !== 'object' || Array.isArray(exemption)) return null;
  if (!EXEMPTION_KINDS.has(exemption.kind)
    || typeof exemption.reason !== 'string'
    || exemption.reason.trim().length < 10) {
    errors.push(finding(
      'invalid-system-exemption',
      `${column.logicalName} has an invalid typed system exemption`,
      pointer,
    ));
    return null;
  }
  if (column.primaryName && exemption.kind !== 'primary-name') {
    errors.push(finding(
      'invalid-system-exemption',
      `${column.logicalName} is a primary name and may use only primary-name exemption`,
      pointer,
    ));
    return null;
  }
  if (!column.primaryName && exemption.kind === 'primary-name') {
    errors.push(finding(
      'invalid-system-exemption',
      `${column.logicalName} is not a primary name field`,
      pointer,
    ));
    return null;
  }
  return { kind: exemption.kind, reason: exemption.reason.trim() };
}

function summarizeConsumers(consumers) {
  const idsFor = (kind) => consumers
    .filter((item) => item.kind === kind)
    .map((item) => item.id)
    .sort();
  return {
    consumers,
    requirementIds: idsFor('requirement'),
    jobIds: idsFor('job'),
    screenIds: idsFor('screen'),
    operationIds: idsFor('domain-operation'),
    integrationIds: idsFor('integration'),
  };
}

function compileMemberUsage(member, input, index, errors, pointer, memberKind) {
  const consumers = (input?.consumers || []).map((consumer, consumerIndex) => (
    validateConsumer(consumer, index, errors, `${pointer}.consumers[${consumerIndex}]`)
  )).filter(Boolean);
  const exemption = memberKind === 'field'
    ? validateExemption(member, input?.exemption, errors, `${pointer}.exemption`)
    : null;
  if (consumers.length === 0 && !exemption) {
    errors.push(finding(
      memberKind === 'field' ? 'unused-field' : 'unused-relationship',
      `${member.logicalName || member.schemaName} has no canonical consumer or typed exemption`,
      pointer,
    ));
  }
  return {
    [memberKind === 'field' ? 'logicalName' : 'schemaName']:
      memberKind === 'field' ? member.logicalName : member.schemaName,
    ...summarizeConsumers(consumers),
    ...(exemption ? { exemption } : {}),
  };
}

function compileRequirementUsage(index, errors) {
  return [...index.requirements.values()]
    .filter((requirement) => requirement.disposition === 'shipping')
    .map((requirement) => {
      const operations = (index.operationsByRequirement.get(requirement.id) || [])
        .filter((operation) => PERSISTABLE_OPERATIONS.has(operation.kind)
          && operation.conceptId);
      const conceptIds = [...new Set(operations.map((operation) => operation.conceptId))].sort();
      const ownerValues = [...new Set(conceptIds.map(
        (id) => index.owners.get(id)?.owner,
      ).filter(Boolean))].sort();
      if (operations.length > 0 && conceptIds.some((id) => !index.owners.has(id))) {
        errors.push(finding(
          'requirement-owner-missing',
          `requirement ${requirement.id} has a persistable operation without a storage owner`,
        ));
      }
      if (operations.length > 0 && ownerValues.length === 0) {
        errors.push(finding(
          'requirement-owner-missing',
          `requirement ${requirement.id} has no resolved storage owner`,
        ));
      } else if (ownerValues.length > 1) {
        errors.push(finding(
          'requirement-owner-ambiguous',
          `requirement ${requirement.id} spans multiple storage owners: ${ownerValues.join(', ')}`,
        ));
      }
      return {
        requirementId: requirement.id,
        jobId: requirement.jobId,
        persistable: operations.length > 0,
        owner: ownerValues.length === 1 ? ownerValues[0] : null,
        conceptIds,
        operationIds: operations.map((operation) => operation.id).sort(),
        screenIds: [...new Set(operations.map((operation) => operation.screenId).filter(Boolean))]
          .sort(),
      };
    });
}

function compileDataModelUsage(input, source) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { errors: [finding('invalid-input', 'usage input must be an object')], compiled: null };
  }
  if (input.schemaVersion !== 1 || !Array.isArray(input.tables)) {
    return {
      errors: [finding('invalid-input', 'usage input requires schemaVersion 1 and tables[]')],
      compiled: null,
    };
  }
  const dataModelRequired = ['dataverse', 'mixed'].includes(source.persistence.mode);
  const contractValidation = source.dataModel
    ? validateContract(source.dataModel)
    : { valid: !dataModelRequired, errors: dataModelRequired ? ['Dataverse mode requires a data model contract'] : [] };
  if (!contractValidation.valid) {
    return {
      errors: contractValidation.errors.map((message) => finding('invalid-data-model', message)),
      compiled: null,
    };
  }
  const index = indexSource(source);
  const inputByTable = new Map();
  for (const [inputIndex, entry] of input.tables.entries()) {
    const name = String(entry.tableLogicalName || '').toLowerCase();
    if (!index.tables.has(name)) {
      errors.push(finding(
        'unknown-table-usage',
        `usage references removed or unknown table ${entry.tableLogicalName || '(missing)'}`,
        `tables[${inputIndex}]`,
      ));
    }
    if (inputByTable.has(name)) {
      errors.push(finding('duplicate-table-usage', `duplicate usage entry for ${name}`));
    }
    inputByTable.set(name, { entry, inputIndex });
  }

  const compiledTables = [];
  const conceptTables = new Map();
  for (const table of source.dataModel?.tables || []) {
    if (table.plannedDecision === 'defer') continue;
    const inputRecord = inputByTable.get(String(table.logicalName).toLowerCase());
    if (!inputRecord) {
      errors.push(finding(
        'table-usage-missing',
        `table ${table.logicalName} has no usage mapping`,
      ));
      continue;
    }
    const { entry, inputIndex } = inputRecord;
    const pointer = `tables[${inputIndex}]`;
    const entity = index.entities.get(entry.conceptId);
    const owner = index.owners.get(entry.conceptId);
    if (!entity || !owner) {
      errors.push(finding(
        'table-concept-missing',
        `table ${table.logicalName} maps to unknown concept ${entry.conceptId}`,
        pointer,
      ));
      continue;
    }
    if (owner.owner !== 'dataverse') {
      errors.push(finding(
        'table-owner-mismatch',
        `table ${table.logicalName} maps to ${entry.conceptId}, owned by ${owner.owner}`,
        pointer,
      ));
    }
    const isNew = ['create', 'adapt'].includes(table.plannedDecision);
    const scopeTable = (source.scope.newTables || []).find(
      (item) => conceptId(item.name) === entry.conceptId,
    );
    if (isNew && (entity.realization !== 'new-table' || !scopeTable)) {
      errors.push(finding(
        'new-table-scope-mismatch',
        `${table.logicalName} is create/adapt without a matching Product Scope new-table decision`,
        pointer,
      ));
    }
    const fieldUsageNames = new Set();
    for (const [fieldIndex, field] of (entry.fields || []).entries()) {
      const name = String(field.logicalName || '').toLowerCase();
      if (fieldUsageNames.has(name)) {
        errors.push(finding(
          'duplicate-field-usage',
          `duplicate usage entry for ${table.logicalName}.${field.logicalName || '(missing)'}`,
          `${pointer}.fields[${fieldIndex}]`,
        ));
      }
      fieldUsageNames.add(name);
    }
    const relationshipUsageNames = new Set();
    for (const [relationshipIndex, relationship] of (entry.relationships || []).entries()) {
      const name = String(relationship.schemaName || '').toLowerCase();
      if (relationshipUsageNames.has(name)) {
        errors.push(finding(
          'duplicate-relationship-usage',
          `duplicate usage entry for ${table.logicalName}.${relationship.schemaName || '(missing)'}`,
          `${pointer}.relationships[${relationshipIndex}]`,
        ));
      }
      relationshipUsageNames.add(name);
    }
    const fieldInput = new Map((entry.fields || []).map(
      (item, fieldIndex) => [String(item.logicalName || '').toLowerCase(), { item, fieldIndex }],
    ));
    const relationshipInput = new Map((entry.relationships || []).map(
      (item, relationshipIndex) => [String(item.schemaName || '').toLowerCase(), {
        item,
        relationshipIndex,
      }],
    ));
    const fields = (table.columns || []).map((column) => {
      const record = fieldInput.get(String(column.logicalName).toLowerCase());
      return compileMemberUsage(
        column,
        record?.item,
        index,
        errors,
        `${pointer}.fields[${record?.fieldIndex ?? 'missing'}]`,
        'field',
      );
    });
    const relationships = (table.relationships || []).map((relationship) => {
      const record = relationshipInput.get(String(relationship.schemaName).toLowerCase());
      return compileMemberUsage(
        relationship,
        record?.item,
        index,
        errors,
        `${pointer}.relationships[${record?.relationshipIndex ?? 'missing'}]`,
        'relationship',
      );
    });
    const knownFields = new Set((table.columns || []).map(
      (column) => String(column.logicalName).toLowerCase(),
    ));
    for (const field of entry.fields || []) {
      if (!knownFields.has(String(field.logicalName || '').toLowerCase())) {
        errors.push(finding(
          'unknown-field-usage',
          `${table.logicalName} usage references removed or unknown field ${field.logicalName || '(missing)'}`,
          pointer,
        ));
      }
    }
    const knownRelationships = new Set((table.relationships || []).map(
      (relationship) => String(relationship.schemaName).toLowerCase(),
    ));
    for (const relationship of entry.relationships || []) {
      if (!knownRelationships.has(String(relationship.schemaName || '').toLowerCase())) {
        errors.push(finding(
          'unknown-relationship-usage',
          `${table.logicalName} usage references removed or unknown relationship ${relationship.schemaName || '(missing)'}`,
          pointer,
        ));
      }
    }
    const allConsumers = [
      ...fields.flatMap((field) => field.consumers),
      ...relationships.flatMap((relationship) => relationship.consumers),
    ];
    const tableUsage = {
      tableLogicalName: table.logicalName,
      conceptId: entry.conceptId,
      conceptName: entity.name,
      owner: owner.owner,
      entityRole: entity.role,
      realization: entity.realization,
      decision: table.plannedDecision,
      justification: scopeTable?.lifecycleJustification || null,
      ...summarizeConsumers(allConsumers),
      fields,
      relationships,
      ...(entry.duplicationJustification
        ? { duplicationJustification: entry.duplicationJustification }
        : {}),
    };
    compiledTables.push(tableUsage);
    if (!conceptTables.has(entry.conceptId)) conceptTables.set(entry.conceptId, []);
    conceptTables.get(entry.conceptId).push(tableUsage);
  }

  for (const [id, tables] of conceptTables) {
    if (tables.length < 2) continue;
    const unjustified = tables.slice(1).filter((table) => {
      const justification = table.duplicationJustification;
      return !justification
        || !DUPLICATION_KINDS.has(justification.kind)
        || typeof justification.reason !== 'string'
        || justification.reason.trim().length < 20;
    });
    if (unjustified.length > 0) {
      errors.push(finding(
        'duplicate-concept-storage',
        `concept ${id} is stored by multiple Dataverse tables without approved synchronization or denormalization`,
      ));
    }
  }

  const requirements = compileRequirementUsage(index, errors);
  const compiled = {
    schemaVersion: 1,
    contractType: 'data-model-usage',
    ...sourceBindings(source),
    requirements,
    tables: compiledTables.sort(
      (left, right) => left.tableLogicalName.localeCompare(right.tableLogicalName),
    ),
  };
  compiled.usageRevision = sha256Hex(canonicalJson(compiled));
  return { errors, compiled: errors.length === 0 ? compiled : null };
}

function validateDataModelUsage(compiled, source) {
  const errors = [];
  if (!compiled || compiled.contractType !== 'data-model-usage') {
    return { ok: false, errors: [finding('invalid-usage-contract', 'data-model-usage contract is required')] };
  }
  const expected = sourceBindings(source);
  const codes = {
    scopeRevision: 'stale-scope-binding',
    persistenceRevision: 'stale-persistence-binding',
    journeyRevision: 'stale-journey-binding',
    dataModelRevision: 'stale-data-model-binding',
  };
  for (const [field, value] of Object.entries(expected)) {
    if (compiled[field] !== value) {
      errors.push(finding(codes[field], `${field} does not match the current canonical artifact`));
    }
  }
  const copy = structuredClone(compiled);
  const revision = copy.usageRevision;
  delete copy.usageRevision;
  if (revision !== sha256Hex(canonicalJson(copy))) {
    errors.push(finding('usage-revision-mismatch', 'usageRevision does not match contract content'));
  }
  return { ok: errors.length === 0, errors };
}

function readJson(projectRoot, relativePath) {
  return JSON.parse(fs.readFileSync(path.resolve(projectRoot, relativePath), 'utf8'));
}

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--input') args.input = argv[++index];
    else if (argv[index] === '--scope') args.scope = argv[++index];
    else if (argv[index] === '--persistence') args.persistence = argv[++index];
    else if (argv[index] === '--journey') args.journey = argv[++index];
    else if (argv[index] === '--data-model') args.dataModel = argv[++index];
    else if (argv[index] === '--output') args.output = argv[++index];
    else if (argv[index] === '--check') args.check = true;
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!args.projectRoot) throw new Error('--project-root is required');
  return args;
}

function main(argv = process.argv) {
  try {
    const args = parseArgs(argv);
    const projectRoot = path.resolve(args.projectRoot);
    const source = {
      scope: readJson(projectRoot, args.scope || DEFAULT_PATHS.scope),
      persistence: readJson(projectRoot, args.persistence || DEFAULT_PATHS.persistence),
      journey: readJson(projectRoot, args.journey || DEFAULT_PATHS.journey),
      dataModel: fs.existsSync(path.resolve(projectRoot, args.dataModel || DEFAULT_PATHS.dataModel))
        ? readJson(projectRoot, args.dataModel || DEFAULT_PATHS.dataModel)
        : null,
    };
    const output = path.resolve(projectRoot, args.output || DEFAULT_PATHS.output);
    if (args.check) {
      const result = validateDataModelUsage(JSON.parse(fs.readFileSync(output, 'utf8')), source);
      if (!result.ok) result.errors.forEach((item) => process.stderr.write(`${item.code}: ${item.message}\n`));
      else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.ok ? 0 : 1;
    }
    const result = compileDataModelUsage(
      readJson(projectRoot, args.input || DEFAULT_PATHS.input),
      source,
    );
    if (result.errors.length > 0) {
      result.errors.forEach((item) => process.stderr.write(`${item.code}: ${item.message}\n`));
      return 1;
    }
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const temporary = `${output}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(result.compiled, null, 2)}\n`);
      fs.renameSync(temporary, output);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      output,
      revision: result.compiled.usageRevision,
      requirementCount: result.compiled.requirements.length,
      tableCount: result.compiled.tables.length,
    }, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`validate-data-model-usage: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  compileDataModelUsage,
  main,
  validateDataModelUsage,
};
