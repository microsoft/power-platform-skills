#!/usr/bin/env node
'use strict';

/**
 * Materialize the shared presentation adapter before screen builders run.
 * It accepts schema-first real apps and mock-backed prototype apps; seed rows
 * enrich per-record recipes when present, while entity fallbacks remain local.
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  buildExperienceAssetManifest,
  buildExperienceViewModel,
  renderExperienceViewModel,
} = require('./lib/experience-view-model');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizeType(rawType) {
  const type = String(rawType || 'string').toLowerCase();
  if (['integer', 'bigint', 'decimal', 'double', 'money', 'number', 'int'].includes(type)) return 'number';
  if (['boolean', 'bool', 'yes/no'].includes(type)) return 'boolean';
  if (['choice', 'picklist', 'multiselectchoice'].includes(type)) return 'choice';
  if (['datetime', 'date'].includes(type)) return 'date';
  if (type === 'lookup') return 'lookup';
  if (type === 'image') return 'image';
  if (type === 'file') return 'file';
  return 'string';
}

function serviceIdentifier(logicalName) {
  const identifier = String(logicalName).replace(/[^A-Za-z0-9_$]/g, '_');
  return identifier.charAt(0).toUpperCase() + identifier.slice(1);
}

function normalizedSchemaEntities(schema) {
  return (schema.tables || [])
    .filter((table) => table?.logicalName && String(table.plannedDecision || table.decision || '').toLowerCase() !== 'defer' && table.serviceRequired !== false)
    .map((table) => ({
      logicalName: String(table.logicalName),
      displayName: String(table.displayName || table.logicalName),
      serviceName: serviceIdentifier(table.logicalName),
      primaryKey: String(table.primaryIdAttribute || `${table.logicalName}id`),
      fields: (table.columns || [])
        .filter((column) => String(column.plannedDecision || column.decision || '').toLowerCase() !== 'defer')
        .map((column) => ({
          name: String(column.logicalName || ''),
          type: normalizeType(column.type || column.attributeType),
          primaryName: column.primaryName === true,
        }))
        .filter((column) => column.name),
    }));
}

function prototypeManifestEntities(manifest) {
  return (manifest.tableSchemas || []).map((table) => ({
    logicalName: String(table.logicalName),
    displayName: String(table.displayName || table.logicalName),
    serviceName: String(table.serviceName || serviceIdentifier(table.logicalName)),
    primaryKey: String(table.primaryKey || `${table.logicalName}id`),
    seedFile: table.seedFile,
    fields: (table.fields || []).map((field) => ({
      name: String(field.name || ''),
      type: normalizeType(field.type),
      primaryName: field.primaryName === true,
    })).filter((field) => field.name),
  }));
}

function loadEntities(projectRoot) {
  const schemaPath = path.join(projectRoot, '.tmp', 'dataverse-schema-contract.json');
  if (fs.existsSync(schemaPath)) {
    const entities = normalizedSchemaEntities(readJson(schemaPath));
    if (entities.length) return entities;
  }
  const prototypePath = path.join(projectRoot, 'src', 'generated', '.prototype-manifest.json');
  if (fs.existsSync(prototypePath)) {
    const entities = prototypeManifestEntities(readJson(prototypePath));
    if (entities.length) return entities;
  }
  throw new Error('expected .tmp/dataverse-schema-contract.json or src/generated/.prototype-manifest.json with service tables');
}

function loadRows(projectRoot, entities) {
  const rowsByEntity = new Map();
  for (const entity of entities) {
    const seedPath = path.join(projectRoot, entity.seedFile || `src/generated/services/${entity.serviceName}.seed.json`);
    if (!fs.existsSync(seedPath)) {
      rowsByEntity.set(entity.logicalName, []);
      continue;
    }
    const rows = readJson(seedPath);
    if (!Array.isArray(rows)) throw new Error(`${path.relative(projectRoot, seedPath)} must contain a JSON array`);
    rowsByEntity.set(entity.logicalName, rows);
  }
  return rowsByEntity;
}

function loadExperienceContract(projectRoot) {
  const contractPath = path.join(projectRoot, '.tmp', 'experience-contract.json');
  return fs.existsSync(contractPath) ? readJson(contractPath) : null;
}

function writeFile(projectRoot, relativePath, content) {
  const filePath = path.join(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function materializeExperienceViewModel(projectRoot) {
  const root = path.resolve(projectRoot);
  const entities = loadEntities(root);
  const rowsByEntity = loadRows(root, entities);
  const assetManifestPath = 'assets/experience/manifest.json';
  const assetManifest = buildExperienceAssetManifest(entities, rowsByEntity, loadExperienceContract(root));
  const viewModel = buildExperienceViewModel(entities, rowsByEntity, assetManifestPath, assetManifest);
  writeFile(root, assetManifestPath, `${JSON.stringify(assetManifest, null, 2)}\n`);
  writeFile(root, 'src/generated/experience-view-model.ts', renderExperienceViewModel(viewModel));
  return { assetManifestPath, viewModelPath: 'src/generated/experience-view-model.ts', entities: entities.map((entity) => entity.logicalName) };
}

function main(argv) {
  const index = argv.indexOf('--project-root');
  const projectRoot = index >= 0 ? argv[index + 1] : null;
  if (!projectRoot) {
    process.stderr.write('Usage: node materialize-experience-view-model.js --project-root <dir>\n');
    return 2;
  }
  try {
    const result = materializeExperienceViewModel(projectRoot);
    process.stdout.write(`Experience view model written: ${result.viewModelPath} (${result.entities.length} entities)\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`BLOCKED: experience view model: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { loadEntities, materializeExperienceViewModel, normalizedSchemaEntities };