#!/usr/bin/env node
'use strict';

/**
 * Convert prototype seed JSON into a deterministic, tiered Dataverse migration
 * plan. This script is read-only with respect to Dataverse: it never inserts
 * rows or fetches remote media.
 *
 * Usage:
 *   node prepare-prototype-seed-migration.js <project-dir> [--output <path>]
 *
 * Required project artifacts:
 *   src/generated/.prototype-manifest.json
 *   .datamodel-manifest.json (or docs/plan-artifacts fallback)
 *   .tmp/prototype-plan-artifacts/live-name-map.json
 *
 * Exit codes:
 *   0 = migration plan written, no blockers
 *   1 = invalid invocation/artifact
 *   2 = mapping blockers written to the output plan
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const args = process.argv.slice(2);
const projectArg = args[0];
const outputIndex = args.indexOf('--output');
const outputArg = outputIndex >= 0 ? args[outputIndex + 1] : null;

if (!projectArg || (outputIndex >= 0 && !outputArg)) {
  console.error('Usage: node prepare-prototype-seed-migration.js <project-dir> [--output <path>]');
  process.exit(1);
}

const projectDir = path.resolve(projectArg);
const prototypeManifestPath = path.join(projectDir, 'src', 'generated', '.prototype-manifest.json');
const rootManifestPath = path.join(projectDir, '.datamodel-manifest.json');
const artifactManifestPath = path.join(projectDir, 'docs', 'plan-artifacts', '.datamodel-manifest.json');
const realManifestPath = fs.existsSync(rootManifestPath) ? rootManifestPath : artifactManifestPath;
const liveNameMapPath = path.join(projectDir, '.tmp', 'prototype-plan-artifacts', 'live-name-map.json');
const planPath = path.join(projectDir, 'native-app-plan.md');
const archivedContractPath = path.join(projectDir, '.tmp', 'prototype-plan-artifacts', 'dataverse-schema-contract.json');
const outputPath = outputArg
  ? path.resolve(projectDir, outputArg)
  : path.join(projectDir, '.tmp', 'prototype-seed-migration.json');

function fail(message) {
  console.error(`prototype-seed-migration: ${message}`);
  process.exit(1);
}

function readJson(filePath, label) {
  if (!fs.existsSync(filePath)) fail(`${label} not found: ${filePath}`);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

function normalizeType(value) {
  return String(value || '').toLowerCase();
}

function sha256File(filePath, label) {
  if (!fs.existsSync(filePath)) fail(`${label} not found: ${filePath}`);
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function isGuid(value) {
  // Dataverse uniqueidentifier values need only the 8-4-4-4-12 hex shape;
  // sequential IDs do not necessarily carry RFC version/variant bits.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function optionEntries(column) {
  const values = Array.isArray(column?.options)
    ? column.options
    : Array.isArray(column?.choices)
      ? column.choices
      : [];
  return values.map((entry) => ({
    value: typeof entry === 'object' && entry !== null ? entry.value : entry,
    label: typeof entry === 'object' && entry !== null ? entry.label : String(entry),
  }));
}

function normalizedLabel(value) {
  return String(value || '').trim().toLocaleLowerCase('en-US');
}

function tableMappingFor(nameMap, prototypeLogicalName) {
  if (nameMap.tables && !Array.isArray(nameMap.tables)) {
    return nameMap.tables[prototypeLogicalName] || null;
  }
  return (nameMap.tables || []).find((entry) => entry.prototypeLogicalName === prototypeLogicalName) || null;
}

function columnMappingFor(tableMapping, prototypeLogicalName) {
  if (!tableMapping?.columns) return null;
  if (!Array.isArray(tableMapping.columns)) return tableMapping.columns[prototypeLogicalName] || null;
  return tableMapping.columns.find((entry) => entry.prototypeLogicalName === prototypeLogicalName) || null;
}

function mappedName(mapping) {
  if (typeof mapping === 'string') return mapping;
  return mapping?.logicalName || mapping?.realLogicalName || null;
}

function mappingDecision(mapping) {
  return String(mapping?.decision || 'map').toLowerCase();
}

function mapChoiceValue(prototypeField, realColumn, seedValue) {
  const prototypeOptions = optionEntries(prototypeField);
  const realOptions = optionEntries(realColumn);
  if (!realOptions.length) return { blocker: 'real choice metadata has no options' };

  const direct = realOptions.find((entry) => entry.value === seedValue);
  if (direct && (!prototypeOptions.length
    || prototypeOptions.some((entry) => entry.value === seedValue
      && normalizedLabel(entry.label) === normalizedLabel(direct.label)))) {
    return { value: direct.value };
  }

  const prototypeOption = prototypeOptions.find((entry) => entry.value === seedValue);
  if (!prototypeOption) return { blocker: `prototype choice value ${seedValue} has no label mapping` };
  const byLabel = realOptions.find(
    (entry) => normalizedLabel(entry.label) === normalizedLabel(prototypeOption.label),
  );
  if (!byLabel) return { blocker: `real choice has no label matching ${JSON.stringify(prototypeOption.label)}` };
  return { value: byLabel.value };
}

function lookupTarget(column) {
  return column?.target
    || column?.lookupTarget
    || (Array.isArray(column?.lookupTargets) ? column.lookupTargets[0] : null)
    || null;
}

const prototypeManifest = readJson(prototypeManifestPath, 'prototype manifest');
const realManifest = readJson(realManifestPath, 'Dataverse manifest');
const liveNameMap = readJson(liveNameMapPath, 'approved live name map');

const expectedBindings = {
  approvedPlanSha256: sha256File(planPath, 'approved native app plan'),
  prototypeContractSha256: sha256File(archivedContractPath, 'archived prototype contract'),
  dataverseManifestSha256: sha256File(realManifestPath, 'Dataverse manifest'),
};
for (const [field, expected] of Object.entries(expectedBindings)) {
  if (liveNameMap[field] !== expected) {
    fail(`approved live name map ${field} does not match current artifact`);
  }
}
if (String(liveNameMap.environment?.url || '').replace(/\/$/, '').toLowerCase()
  !== String(realManifest.environmentUrl || '').replace(/\/$/, '').toLowerCase()) {
  fail('approved live name map environment URL does not match Dataverse manifest');
}

if (!Array.isArray(prototypeManifest.tableSchemas) || !prototypeManifest.tableSchemas.length) {
  fail('prototype manifest has no tableSchemas; regenerate mocks before conversion');
}
if (!Array.isArray(realManifest.tables)) fail('Dataverse manifest must contain tables[]');

const realTables = new Map(realManifest.tables.map((table) => [table.logicalName, table]));
const prototypeSchemas = new Map(
  prototypeManifest.tableSchemas.map((schema) => [schema.logicalName, schema]),
);
const blockers = [];
const concerns = [];
const tables = [];
const seenSeedIds = new Set();

for (const prototypeSchema of [...prototypeManifest.tableSchemas]
  .sort((left, right) => (left.dependencyTier || 0) - (right.dependencyTier || 0))) {
  const tableMapping = tableMappingFor(liveNameMap, prototypeSchema.logicalName);
  if (!tableMapping) {
    blockers.push(`table ${prototypeSchema.logicalName} has no approved live mapping`);
    continue;
  }
  if (mappingDecision(tableMapping) === 'defer') {
    concerns.push(`table ${prototypeSchema.logicalName} was intentionally deferred; its prototype rows will not migrate`);
    continue;
  }

  const realLogicalName = mappedName(tableMapping);
  const realTable = realTables.get(realLogicalName);
  if (!realLogicalName || !realTable) {
    blockers.push(`table ${prototypeSchema.logicalName} maps to missing Dataverse table ${realLogicalName || '<empty>'}`);
    continue;
  }
  if (!realTable.entitySetName || !realTable.primaryIdAttribute) {
    blockers.push(`Dataverse table ${realLogicalName} is missing entitySetName or primaryIdAttribute`);
    continue;
  }

  const seedPath = path.join(projectDir, prototypeSchema.seedFile || '');
  const seedRows = readJson(seedPath, `seed rows for ${prototypeSchema.logicalName}`);
  if (!Array.isArray(seedRows)) {
    blockers.push(`seed rows for ${prototypeSchema.logicalName} are not an array`);
    continue;
  }

  const realColumns = new Map((realTable.columns || []).map((column) => [column.logicalName, column]));
  const prototypeFields = new Map((prototypeSchema.fields || []).map((field) => [field.name, field]));
  const rows = [];

  for (let rowIndex = 0; rowIndex < seedRows.length; rowIndex += 1) {
    const seedRow = seedRows[rowIndex];
    const seedId = seedRow?.[prototypeSchema.primaryKey];
    if (!isGuid(seedId)) {
      blockers.push(`${prototypeSchema.logicalName} row ${rowIndex} has invalid seed GUID ${JSON.stringify(seedId)}`);
      continue;
    }
    if (seenSeedIds.has(seedId)) {
      blockers.push(`duplicate prototype seed GUID ${seedId}`);
      continue;
    }
    seenSeedIds.add(seedId);

    const body = { [realTable.primaryIdAttribute]: seedId };
    const lookups = [];
    const mediaJobs = [];
    const skippedFields = [];

    for (const prototypeField of prototypeSchema.fields || []) {
      if (prototypeField.name === prototypeSchema.primaryKey) continue;
      if (!Object.prototype.hasOwnProperty.call(seedRow, prototypeField.name)) continue;
      const fieldMapping = columnMappingFor(tableMapping, prototypeField.name);
      if (!fieldMapping) {
        blockers.push(`${prototypeSchema.logicalName}.${prototypeField.name} has no approved live column mapping`);
        continue;
      }
      if (mappingDecision(fieldMapping) === 'defer') {
        skippedFields.push({ field: prototypeField.name, reason: 'intentionally deferred by live reconciliation' });
        continue;
      }

      const realColumnName = mappedName(fieldMapping);
      const realColumn = realColumns.get(realColumnName);
      if (!realColumnName || !realColumn) {
        blockers.push(`${prototypeSchema.logicalName}.${prototypeField.name} maps to missing column ${realColumnName || '<empty>'}`);
        continue;
      }

      const value = seedRow[prototypeField.name];
      const realType = normalizeType(realColumn.type);
      if (['lookup', 'customer', 'owner'].includes(realType)) {
        const targetPrototypeTable = prototypeField.lookupTarget;
        const targetMapping = targetPrototypeTable
          ? tableMappingFor(liveNameMap, targetPrototypeTable)
          : null;
        const targetRealName = mappedName(targetMapping) || lookupTarget(realColumn);
        const targetRealTable = realTables.get(targetRealName);
        if (!targetPrototypeTable || !targetRealName || !targetRealTable?.entitySetName || !isGuid(value)) {
          blockers.push(`${prototypeSchema.logicalName}.${prototypeField.name} has incomplete lookup mapping for row ${seedId}`);
          continue;
        }
        lookups.push({
          property: `${realColumn.schemaName || realColumn.logicalName}@odata.bind`,
          targetPrototypeTable,
          targetRealLogicalName: targetRealName,
          targetEntitySetName: targetRealTable.entitySetName,
          targetSeedId: value,
        });
        continue;
      }

      if (['choice', 'picklist', 'multiselectchoice'].includes(realType)) {
        const mapped = mapChoiceValue(prototypeField, realColumn, value);
        if (mapped.blocker) {
          blockers.push(`${prototypeSchema.logicalName}.${prototypeField.name} row ${seedId}: ${mapped.blocker}`);
        } else {
          body[realColumnName] = mapped.value;
        }
        continue;
      }

      if (['file', 'image'].includes(realType)) {
        if (realType === 'image' && typeof value === 'string' && /^data:image\/[a-z0-9.+-]+;base64,/i.test(value)) {
          mediaJobs.push({
            kind: 'image',
            columnName: realColumnName,
            dataUri: value,
          });
        } else {
          skippedFields.push({
            field: prototypeField.name,
            reason: `${realType} seed contains metadata/URL but no local bytes; preserve UI fallback and seed media separately`,
          });
          concerns.push(`${prototypeSchema.logicalName}.${prototypeField.name} media bytes were not available for seed ${seedId}`);
        }
        continue;
      }

      body[realColumnName] = value;
    }

    rows.push({ seedId, body, lookups, mediaJobs, skippedFields });
  }

  tables.push({
    prototypeLogicalName: prototypeSchema.logicalName,
    realLogicalName,
    entitySetName: realTable.entitySetName,
    primaryIdAttribute: realTable.primaryIdAttribute,
    primaryNameAttribute: realTable.primaryNameAttribute || null,
    dependencyTier: Number.isInteger(realTable.dependencyTier)
      ? realTable.dependencyTier
      : prototypeSchema.dependencyTier || 0,
    decision: tableMapping.decision || realTable.status || 'mapped',
    requiresSharedTableConfirmation: realTable.customEntity === false || realTable.sharedSystemTable === true,
    rows,
  });
}

const output = {
  schemaVersion: 1,
  source: 'prototype-seed-json',
  prototypeManifest: path.relative(projectDir, prototypeManifestPath).split(path.sep).join('/'),
  dataverseManifest: path.relative(projectDir, realManifestPath).split(path.sep).join('/'),
  liveNameMap: path.relative(projectDir, liveNameMapPath).split(path.sep).join('/'),
  tables,
  concerns: [...new Set(concerns)].sort(),
  blockers: [...new Set(blockers)].sort(),
  summary: {
    tableCount: tables.length,
    rowCount: tables.reduce((total, table) => total + table.rows.length, 0),
    lookupCount: tables.reduce(
      (total, table) => total + table.rows.reduce((rowTotal, row) => rowTotal + row.lookups.length, 0),
      0,
    ),
    mediaJobCount: tables.reduce(
      (total, table) => total + table.rows.reduce((rowTotal, row) => rowTotal + row.mediaJobs.length, 0),
      0,
    ),
    concernCount: new Set(concerns).size,
    blockerCount: new Set(blockers).size,
  },
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);

if (output.blockers.length) {
  console.error(`prototype-seed-migration: BLOCKED (${output.blockers.length} mapping issue(s)); wrote ${outputPath}`);
  process.exit(2);
}

console.log(`prototype-seed-migration: planned ${output.summary.rowCount} row(s) across ${output.summary.tableCount} table(s)`);
console.log(`prototype-seed-migration: wrote ${outputPath}`);