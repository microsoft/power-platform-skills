#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  normalizeColumnType,
  normalizedContract,
  stableJson,
  validateContract,
} = require('./build-dataverse-operation-manifest');
const {
  loadAndValidateArchitectEvidence,
} = require('./render-dataverse-architect-evidence');
const { validateJsonSchema } = require('./lib/json-schema-lite');

const DEFAULT_PROPOSAL = '.tmp/dataverse-model-proposal.json';
const DEFAULT_SNAPSHOT = '.tmp/dataverse-foreground-planning-snapshot.json';
const DEFAULT_EVIDENCE = '.tmp/dataverse-architect-evidence.json';
const DEFAULT_CONTRACT_OUTPUT = '.tmp/dataverse-schema-contract.json';
const DEFAULT_SECTION_OUTPUT = '_dm_section.md';
const SCHEMA_FILE = path.resolve(__dirname, 'schema-dataverse-model-proposal.json');

const TYPE_ALIASES = {
  bigint: 'bigint',
  boolean: 'boolean',
  booleanattribute: 'boolean',
  choice: 'choice',
  datetime: 'datetime',
  date: 'date',
  decimal: 'decimal',
  double: 'double',
  file: 'file',
  image: 'image',
  integer: 'integer',
  lookup: 'lookup',
  memo: 'memo',
  money: 'money',
  multiselectchoice: 'multiselectchoice',
  picklist: 'choice',
  state: 'choice',
  status: 'choice',
  string: 'string',
  text: 'string',
  virtual: 'virtual',
  wholenumber: 'integer',
};

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizedType(value) {
  const key = normalizeColumnType(value);
  return TYPE_ALIASES[key] || key;
}

function liveColumnType(column) {
  const typeName = normalizeColumnType(column?.typeName);
  if (typeName === 'filetype') return 'file';
  if (typeName === 'imagetype') return 'image';
  if (typeName === 'multiselectpicklisttype') return 'multiselectchoice';
  const type = normalizedType(column?.type);
  if (type === 'datetime' && normalizeName(column?.format) === 'dateonly') return 'date';
  return type;
}

function atomicWrite(file, content, fileSystem = fs) {
  fileSystem.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fileSystem.writeFileSync(temporary, content, 'utf8');
    fileSystem.renameSync(temporary, file);
  } finally {
    fileSystem.rmSync(temporary, { force: true });
  }
}

function readJson(file, label, fileSystem = fs) {
  if (!fileSystem.existsSync(file)) throw new Error(`${label} not found: ${file}`);
  try {
    return JSON.parse(fileSystem.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function validateProposal(proposal, schema = readJson(SCHEMA_FILE, 'proposal schema')) {
  const errors = validateJsonSchema(proposal, schema);
  const seenConcepts = new Set();
  const seenTables = new Set();
  for (const table of proposal.tables || []) {
    const conceptId = normalizeName(table.conceptId);
    const logicalName = normalizeName(table.logicalName);
    if (seenConcepts.has(conceptId)) errors.push(`/tables: duplicate conceptId ${conceptId}`);
    if (seenTables.has(logicalName)) errors.push(`/tables: duplicate logicalName ${logicalName}`);
    seenConcepts.add(conceptId);
    seenTables.add(logicalName);
    if (table.decision === 'adapt' && !table.adaptedLogicalName) {
      errors.push(`/tables/${logicalName}: adapt requires adaptedLogicalName`);
    }
    if (['create', 'adapt'].includes(table.decision)) {
      const effectiveName = table.decision === 'adapt'
        ? table.adaptedLogicalName
        : table.logicalName;
      if (!normalizeName(effectiveName).startsWith(`${normalizeName(proposal.publisherPrefix)}_`)) {
        errors.push(`/tables/${logicalName}: create/adapt name must use publisher prefix`);
      }
    }
    for (const column of table.columns || []) {
      if (column.decision === 'adapt' && !column.adaptedLogicalName) {
        errors.push(`/tables/${logicalName}/columns/${column.logicalName}: adapt requires adaptedLogicalName`);
      }
      if (column.type === 'lookup' && !column.lookupTarget) {
        errors.push(`/tables/${logicalName}/columns/${column.logicalName}: lookupTarget is required`);
      }
      if (['choice', 'multiselectchoice', 'boolean'].includes(column.type)
        && (!Array.isArray(column.options) || column.options.length === 0)) {
        errors.push(`/tables/${logicalName}/columns/${column.logicalName}: options are required`);
      }
      if (column.type === 'computed'
        && (!column.attributeType || column.sourceType === undefined
          || column.sourceTypeMask === undefined || !column.formulaDefinition)) {
        errors.push(`/tables/${logicalName}/columns/${column.logicalName}: computed metadata is incomplete`);
      }
    }
    for (const relationship of table.relationships || []) {
      if (relationship.kind === 'many-to-one'
        && (!relationship.parentTable || !relationship.childTable || !relationship.lookupColumn)) {
        errors.push(`/tables/${logicalName}/relationships/${relationship.schemaName}: many-to-one endpoints and lookupColumn are required`);
      }
      if (relationship.kind === 'many-to-many'
        && (!relationship.entity1 || !relationship.entity2 || !relationship.intersectTable)) {
        errors.push(`/tables/${logicalName}/relationships/${relationship.schemaName}: many-to-many endpoints and intersectTable are required`);
      }
      if (relationship.decision === 'adapt' && !relationship.adaptedSchemaName) {
        errors.push(`/tables/${logicalName}/relationships/${relationship.schemaName}: adapt requires adaptedSchemaName`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

function liveColumnsByName(table) {
  return new Map((table?.columns || []).map((column) => [
    normalizeName(column.logicalName),
    column,
  ]));
}

function copyIfPresent(target, source, targetField, sourceField = targetField) {
  if (source?.[sourceField] !== undefined && source[sourceField] !== null) {
    target[targetField] = source[sourceField];
  }
}

function applyNewColumnDefaults(column) {
  const type = normalizedType(column.type);
  if (type === 'string') {
    column.maxLength = Number(column.maxLength || 200);
    column.format = column.format || 'Text';
  } else if (type === 'memo') {
    column.maxLength = Number(column.maxLength || 10000);
    column.format = column.format || 'TextArea';
  } else if (type === 'integer') {
    column.minValue = Number(column.minValue ?? -2147483648);
    column.maxValue = Number(column.maxValue ?? 2147483647);
    column.format = column.format || 'None';
  } else if (['decimal', 'double'].includes(type)) {
    column.minValue = Number(column.minValue ?? -100000000000);
    column.maxValue = Number(column.maxValue ?? 100000000000);
    column.precision = Number(column.precision ?? 2);
  } else if (type === 'money') {
    column.minValue = Number(column.minValue ?? -922337203685477);
    column.maxValue = Number(column.maxValue ?? 922337203685477);
    column.precision = Number(column.precision ?? 2);
    column.precisionSource = Number(column.precisionSource ?? 2);
  } else if (type === 'datetime') {
    column.format = column.format || 'DateAndTime';
    column.behavior = column.behavior || 'UserLocal';
  } else if (type === 'date') {
    column.behavior = column.behavior || 'UserLocal';
  } else if (type === 'image') {
    column.maxSizeInKB = Number(column.maxSizeInKB || 10240);
    column.canStoreFullImage = column.canStoreFullImage !== false;
    if (column.isPrimaryImage !== undefined) {
      column.isPrimaryImage = Boolean(column.isPrimaryImage);
    }
  } else if (type === 'file') {
    column.maxSizeInKB = Number(column.maxSizeInKB || 32768);
  }
  return column;
}

function reusedColumn(proposalColumn, liveColumn) {
  const desiredType = normalizedType(proposalColumn.type);
  const liveType = liveColumnType(liveColumn);
  if (desiredType !== liveType && desiredType !== 'computed') {
    throw new Error(
      `${proposalColumn.logicalName} expects ${desiredType}, but target metadata is ${liveType}`,
    );
  }
  const column = {
    logicalName: normalizeName(liveColumn.logicalName),
    schemaName: String(liveColumn.schemaName || liveColumn.logicalName),
    displayName: proposalColumn.displayName,
    type: desiredType,
    plannedDecision: 'reuse',
    requiredLevel: liveColumn.requiredLevel || 'None',
  };
  copyIfPresent(column, liveColumn, 'primaryName');
  copyIfPresent(column, liveColumn, 'maxLength');
  copyIfPresent(column, liveColumn, 'minValue');
  copyIfPresent(column, liveColumn, 'maxValue');
  copyIfPresent(column, liveColumn, 'precision');
  copyIfPresent(column, liveColumn, 'precisionSource');
  copyIfPresent(column, liveColumn, 'format');
  copyIfPresent(column, liveColumn, 'formatName', 'formatName');
  copyIfPresent(column, liveColumn, 'behavior', 'dateTimeBehavior');
  copyIfPresent(column, liveColumn, 'defaultValue');
  copyIfPresent(column, liveColumn, 'sourceType');
  copyIfPresent(column, liveColumn, 'sourceTypeMask');
  if (desiredType === 'lookup') {
    const liveTargets = liveColumn.lookupTargets || [];
    if (liveTargets.length !== 1
      || normalizeName(liveTargets[0]) !== normalizeName(proposalColumn.lookupTarget)) {
      throw new Error(`${proposalColumn.logicalName} lookup target does not match target metadata`);
    }
    column.lookupTarget = normalizeName(proposalColumn.lookupTarget);
  }
  if (['choice', 'multiselectchoice', 'boolean'].includes(desiredType)) {
    column.options = liveColumn.choices || proposalColumn.options;
  }
  if (desiredType === 'computed') {
    column.attributeType = proposalColumn.attributeType;
    column.sourceType = liveColumn.sourceType;
    column.sourceTypeMask = liveColumn.sourceTypeMask;
    column.formulaDefinition = liveColumn.formulaDefinition || liveColumn.formula;
  }
  return column;
}

function newColumn(proposalColumn, decision) {
  const column = {
    logicalName: normalizeName(proposalColumn.logicalName),
    schemaName: proposalColumn.logicalName,
    displayName: proposalColumn.displayName,
    type: normalizedType(proposalColumn.type),
    plannedDecision: decision,
    requiredLevel: proposalColumn.required ? 'ApplicationRequired' : 'None',
  };
  if (proposalColumn.primaryName) column.primaryName = true;
  if (decision === 'adapt') {
    column.adaptedLogicalName = normalizeName(proposalColumn.adaptedLogicalName);
    column.adaptedSchemaName = proposalColumn.adaptedLogicalName;
  }
  for (const field of [
    'maxLength',
    'minValue',
    'maxValue',
    'precision',
    'precisionSource',
    'format',
    'behavior',
    'defaultValue',
    'attributeType',
    'sourceType',
    'sourceTypeMask',
    'formulaDefinition',
  ]) copyIfPresent(column, proposalColumn, field);
  if (proposalColumn.lookupTarget) column.lookupTarget = normalizeName(proposalColumn.lookupTarget);
  if (proposalColumn.options) column.options = proposalColumn.options;
  return applyNewColumnDefaults(column);
}

function compileColumn(proposalColumn, tableProposal, liveColumn) {
  const tableDecision = tableProposal.decision;
  let decision = proposalColumn.decision;
  if (!decision) {
    if (tableDecision === 'defer') decision = 'defer';
    else if (['create', 'adapt'].includes(tableDecision)) decision = 'create';
    else if (liveColumn) decision = 'reuse';
    else if (tableDecision === 'extend') decision = 'create';
    else throw new Error(`${tableProposal.logicalName}.${proposalColumn.logicalName} is absent from a reused table`);
  }
  if (decision === 'reuse') {
    if (!liveColumn) {
      throw new Error(`${tableProposal.logicalName}.${proposalColumn.logicalName} cannot reuse an absent column`);
    }
    return reusedColumn(proposalColumn, liveColumn);
  }
  if (decision === 'create' && liveColumn && !['create', 'adapt'].includes(tableDecision)) {
    throw new Error(`${tableProposal.logicalName}.${proposalColumn.logicalName} already exists; use reuse or adapt`);
  }
  if (decision === 'adapt' && !liveColumn) {
    throw new Error(`${tableProposal.logicalName}.${proposalColumn.logicalName} cannot adapt an absent column`);
  }
  return newColumn(proposalColumn, decision);
}

function compileProposal(proposal, evidence) {
  const proposalValidation = validateProposal(proposal);
  if (!proposalValidation.valid) {
    throw new Error(`Invalid Dataverse model proposal: ${proposalValidation.errors.join('; ')}`);
  }
  const evidenceByName = new Map((evidence.selectedTables || []).map((table) => [
    normalizeName(table.logicalName),
    table,
  ]));
  const tables = proposal.tables.map((tableProposal) => {
    const liveTable = evidenceByName.get(normalizeName(tableProposal.logicalName));
    if (['reuse', 'extend', 'adapt'].includes(tableProposal.decision)
      && (!liveTable || liveTable.detailLevel !== 'full')) {
      throw new Error(`${tableProposal.logicalName} requires full compact target evidence`);
    }
    const liveColumns = ['create', 'adapt'].includes(tableProposal.decision)
      ? new Map()
      : liveColumnsByName(liveTable);
    const table = {
      logicalName: normalizeName(tableProposal.logicalName),
      schemaName: liveTable?.schemaName || tableProposal.logicalName,
      displayName: tableProposal.displayName,
      displayCollectionName: tableProposal.displayCollectionName
        || liveTable?.displayCollectionName
        || `${tableProposal.displayName}s`,
      plannedDecision: tableProposal.decision,
      dependencyTier: tableProposal.dependencyTier,
      serviceRequired: tableProposal.serviceRequired,
      ownershipType: tableProposal.ownershipType
        || liveTable?.ownershipType
        || 'UserOwned',
      columns: tableProposal.columns.map((column) => compileColumn(
        column,
        tableProposal,
        liveColumns.get(normalizeName(column.logicalName)),
      )),
      relationships: [],
      alternateKeys: [],
    };
    if (tableProposal.decision === 'adapt') {
      table.adaptedLogicalName = normalizeName(tableProposal.adaptedLogicalName);
      table.adaptedSchemaName = tableProposal.adaptedLogicalName;
    }
    for (const field of [
      'hasActivities',
      'hasNotes',
      'isAvailableOffline',
      'changeTrackingEnabled',
    ]) copyIfPresent(table, liveTable, field);
    return table;
  });
  const tableByName = new Map(tables.map((table) => [table.logicalName, table]));

  for (const tableProposal of proposal.tables) {
    const owner = tableByName.get(normalizeName(tableProposal.logicalName));
    owner.relationships = tableProposal.relationships.map((relationship) => {
      if (relationship.kind === 'many-to-one') {
        const child = tableByName.get(normalizeName(relationship.childTable));
        const lookup = child?.columns.find(
          (column) => column.logicalName === normalizeName(relationship.lookupColumn),
        );
        if (!child || !lookup || normalizedType(lookup.type) !== 'lookup') {
          throw new Error(`${relationship.schemaName} must reference a lookup column on its child table`);
        }
        if (normalizeName(lookup.lookupTarget) !== normalizeName(relationship.parentTable)) {
          throw new Error(`${relationship.schemaName} lookupTarget does not match parentTable`);
        }
        if (normalizeName(lookup.plannedDecision) !== normalizeName(relationship.decision)) {
          throw new Error(`${relationship.schemaName} decision must match its lookup column`);
        }
        const compiled = {
          kind: 'many-to-one',
          schemaName: relationship.schemaName,
          plannedDecision: relationship.decision,
          parentTable: normalizeName(relationship.parentTable),
          childTable: normalizeName(relationship.childTable),
          lookup: {
            logicalName: lookup.logicalName,
            schemaName: lookup.schemaName,
            displayName: relationship.lookupDisplayName || lookup.displayName,
            requiredLevel: lookup.requiredLevel,
          },
        };
        if (relationship.deleteBehavior) compiled.deleteBehavior = relationship.deleteBehavior;
        if (relationship.decision === 'adapt') {
          compiled.adaptedSchemaName = relationship.adaptedSchemaName;
          compiled.lookup.adaptedLogicalName = lookup.adaptedLogicalName;
          compiled.lookup.adaptedSchemaName = lookup.adaptedSchemaName;
        }
        return compiled;
      }
      const compiled = {
        kind: 'many-to-many',
        schemaName: relationship.schemaName,
        plannedDecision: relationship.decision,
        entity1: normalizeName(relationship.entity1),
        entity2: normalizeName(relationship.entity2),
        intersectTable: normalizeName(relationship.intersectTable),
      };
      if (relationship.serviceRequired !== undefined) {
        compiled.serviceRequired = relationship.serviceRequired;
      }
      if (relationship.decision === 'adapt') {
        compiled.adaptedSchemaName = relationship.adaptedSchemaName;
        compiled.adaptedIntersectTable = normalizeName(relationship.adaptedIntersectTable);
      }
      return compiled;
    });
    owner.alternateKeys = tableProposal.alternateKeys.map((key) => ({
      schemaName: key.schemaName,
      displayName: key.displayName,
      plannedDecision: key.decision,
      ...(key.adaptedSchemaName ? { adaptedSchemaName: key.adaptedSchemaName } : {}),
      columns: key.columns.map(normalizeName),
    }));
  }

  const contract = normalizedContract({
    schemaVersion: 1,
    publisherPrefix: proposal.publisherPrefix,
    tables,
  });
  const validation = validateContract(contract);
  if (!validation.valid) {
    throw new Error(`Compiled Dataverse contract is invalid: ${validation.errors.join('; ')}`);
  }
  return contract;
}

function escapeCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function effectiveTableName(table) {
  return table.plannedDecision === 'adapt' ? table.adaptedLogicalName : table.logicalName;
}

function effectiveColumnName(column) {
  return column.plannedDecision === 'adapt'
    ? column.adaptedLogicalName
    : column.logicalName;
}

function renderDataModelSection(proposal, contract, evidence) {
  const counts = Object.fromEntries(
    ['reuse', 'extend', 'create', 'adapt', 'defer'].map((decision) => [
      decision,
      contract.tables.filter((table) => table.plannedDecision === decision).length,
    ]),
  );
  const proposalByName = new Map(proposal.tables.map((table) => [
    normalizeName(table.logicalName),
    table,
  ]));
  const evidenceByName = new Map((evidence.selectedTables || []).map((table) => [
    normalizeName(table.logicalName),
    table,
  ]));
  const lines = [
    '## Data Model',
    '',
    '### Summary',
    '',
    `- Reuse: ${counts.reuse}`,
    `- Extend: ${counts.extend}`,
    `- Create: ${counts.create}`,
    `- Adapt: ${counts.adapt}`,
    `- Defer: ${counts.defer}`,
    `- Service-required tables: ${contract.tables.filter((table) => table.serviceRequired && table.plannedDecision !== 'defer').length}`,
    '',
    '### Planning Evidence',
    '',
    `- Compact evidence schema: ${evidence.schemaVersion}`,
    `- Source snapshot SHA-256: \`${evidence.sourceSnapshotSha256}\``,
    `- Selected target tables: ${evidence.selectedTables.length}`,
    '',
    '### Target Reconciliation',
    '',
    '| Concept | Decision | Target | Column decisions | Reason |',
    '|---|---|---|---|---|',
  ];
  for (const table of contract.tables) {
    const source = proposalByName.get(table.logicalName);
    const columnCounts = Object.entries((table.columns || []).reduce((result, column) => {
      result[column.plannedDecision] = (result[column.plannedDecision] || 0) + 1;
      return result;
    }, {})).map(([decision, count]) => `${decision} ${count}`).join(', ') || 'none';
    lines.push(
      `| ${escapeCell(source.conceptId)} | ${table.plannedDecision} | \`${effectiveTableName(table)}\` | ${columnCounts} | ${escapeCell(source.reason)} |`,
    );
  }

  lines.push('', '### ER Diagram', '', '```mermaid', 'erDiagram');
  const aliases = new Map(contract.tables.map((table) => [table.logicalName, effectiveTableName(table)]));
  for (const table of contract.tables.filter((item) => item.plannedDecision !== 'defer')) {
    const entity = effectiveTableName(table);
    const live = evidenceByName.get(table.logicalName);
    const primaryId = live?.primaryIdAttribute || `${entity}id`;
    lines.push(`    ${entity} {`, `        guid ${primaryId} PK`);
    for (const column of table.columns) {
      const name = effectiveColumnName(column);
      if (name === primaryId) continue;
      const flags = [column.primaryName ? 'UK' : '', column.type === 'lookup' ? 'FK' : '']
        .filter(Boolean).join(' ');
      lines.push(`        ${normalizedType(column.type)} ${name}${flags ? ` ${flags}` : ''}`);
    }
    lines.push('    }');
  }
  for (const table of contract.tables) {
    for (const relationship of table.relationships || []) {
      if (relationship.plannedDecision === 'defer') continue;
      if (relationship.kind === 'many-to-one') {
        lines.push(
          `    ${aliases.get(relationship.parentTable) || relationship.parentTable} ||--o{ ${aliases.get(relationship.childTable) || relationship.childTable} : "${escapeCell(relationship.lookup.displayName)}"`,
        );
      } else {
        lines.push(
          `    ${aliases.get(relationship.entity1) || relationship.entity1} }o--o{ ${aliases.get(relationship.entity2) || relationship.entity2} : "${escapeCell(relationship.schemaName)}"`,
        );
      }
    }
  }
  lines.push('```', '', '### Creation Order', '');
  const tiers = new Map();
  for (const table of contract.tables.filter((item) => (
    ['create', 'adapt'].includes(item.plannedDecision)
  ))) {
    if (!tiers.has(table.dependencyTier)) tiers.set(table.dependencyTier, []);
    tiers.get(table.dependencyTier).push(effectiveTableName(table));
  }
  if (tiers.size === 0) lines.push('No new tables.');
  else {
    for (const [tier, names] of [...tiers].sort(([left], [right]) => left - right)) {
      lines.push(`${tier + 1}. Tier ${tier}: ${names.sort().map((name) => `\`${name}\``).join(', ')}`);
    }
  }
  const extensions = contract.tables.filter((table) => table.plannedDecision === 'extend');
  if (extensions.length > 0) {
    lines.push(
      `${tiers.size + 1}. Extensions: ${extensions.map((table) => `\`${table.logicalName}\``).join(', ')}`,
    );
  }

  lines.push('', '### Cross-entity Reads', '');
  if (proposal.readPaths.length === 0) lines.push('None.');
  else {
    lines.push('| Job | Path | Strategy | Note |', '|---|---|---|---|');
    for (const readPath of proposal.readPaths) {
      lines.push(
        `| ${escapeCell(readPath.jobId)} | ${escapeCell(readPath.path)} | ${readPath.strategy} | ${escapeCell(readPath.note || '')} |`,
      );
    }
  }
  lines.push('', '### Risks and Scope Boundaries', '');
  if (proposal.risks.length === 0) lines.push('- None identified.');
  else proposal.risks.forEach((risk) => lines.push(`- ${risk}`));
  lines.push('');
  return lines.join('\n');
}

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--project-root') args.projectRoot = argv[++index];
    else if (token === '--proposal') args.proposal = argv[++index];
    else if (token === '--snapshot') args.snapshot = argv[++index];
    else if (token === '--evidence') args.evidence = argv[++index];
    else if (token === '--contract-output') args.contractOutput = argv[++index];
    else if (token === '--section-output') args.sectionOutput = argv[++index];
    else if (token === '--check') args.check = true;
    else if (token === '--json') args.json = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  if (!args.projectRoot) throw new Error('--project-root is required');
  return args;
}

function main(argv = process.argv) {
  try {
    const args = parseArgs(argv);
    const projectRoot = path.resolve(args.projectRoot);
    const proposalPath = path.resolve(projectRoot, args.proposal || DEFAULT_PROPOSAL);
    const snapshotPath = path.resolve(projectRoot, args.snapshot || DEFAULT_SNAPSHOT);
    const evidencePath = path.resolve(projectRoot, args.evidence || DEFAULT_EVIDENCE);
    const contractOutput = path.resolve(
      projectRoot,
      args.contractOutput || DEFAULT_CONTRACT_OUTPUT,
    );
    const sectionOutput = path.resolve(projectRoot, args.sectionOutput || DEFAULT_SECTION_OUTPUT);
    const proposal = readJson(proposalPath, 'Dataverse model proposal');
    const { evidence } = loadAndValidateArchitectEvidence(snapshotPath, evidencePath);
    const contract = compileProposal(proposal, evidence);
    const section = renderDataModelSection(proposal, contract, evidence);
    const contractBytes = `${JSON.stringify(contract, null, 2)}\n`;
    const sectionBytes = section.endsWith('\n') ? section : `${section}\n`;

    if (args.check) {
      const mismatches = [];
      if (!fs.existsSync(contractOutput)
        || fs.readFileSync(contractOutput, 'utf8') !== contractBytes) {
        mismatches.push(path.relative(projectRoot, contractOutput));
      }
      if (!fs.existsSync(sectionOutput)
        || fs.readFileSync(sectionOutput, 'utf8') !== sectionBytes) {
        mismatches.push(path.relative(projectRoot, sectionOutput));
      }
      if (mismatches.length > 0) {
        throw new Error(`compiled Dataverse artifacts are stale: ${mismatches.join(', ')}`);
      }
    } else {
      atomicWrite(contractOutput, contractBytes);
      atomicWrite(sectionOutput, sectionBytes);
    }
    const result = {
      ok: true,
      check: Boolean(args.check),
      proposal: path.relative(projectRoot, proposalPath),
      contract: path.relative(projectRoot, contractOutput),
      section: path.relative(projectRoot, sectionOutput),
      proposalSha256: require('node:crypto').createHash('sha256')
        .update(stableJson(proposal)).digest('hex'),
      tableCount: contract.tables.length,
      columnCount: contract.tables.reduce((sum, table) => sum + table.columns.length, 0),
      relationshipCount: contract.tables.reduce(
        (sum, table) => sum + table.relationships.length,
        0,
      ),
    };
    process.stdout.write(`${JSON.stringify(result, null, args.json ? 2 : 0)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`compile-dataverse-model-proposal: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  applyNewColumnDefaults,
  compileProposal,
  liveColumnType,
  main,
  normalizedType,
  renderDataModelSection,
  validateProposal,
};