#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizedFileStem(value) {
  return normalizeName(value).replace(/[^a-z0-9]/g, '');
}

function configuredDataSources(config) {
  return config?.databaseReferences?.['default.cds']?.dataSources
    || config?.databaseReferences?.default?.cds?.dataSources;
}

function dataSourceEntries(dataSources) {
  if (Array.isArray(dataSources)) {
    return dataSources.map((value, index) => ({ key: String(index), value }));
  }
  if (!dataSources || typeof dataSources !== 'object') return [];
  return Object.entries(dataSources).map(([key, value]) => ({ key, value }));
}

function serviceFileFor(entry, serviceFiles) {
  const expectedStem = `${normalizedFileStem(entry?.value?.entitySetName)}service`;
  return serviceFiles.find((file) => (
    normalizedFileStem(file.replace(/\.ts$/i, '')) === expectedStem
  )) || null;
}

function verifyDataverseServices(projectRoot, logicalNames, fileSystem = fs) {
  const required = [...new Set((logicalNames || []).map(normalizeName).filter(Boolean))];
  if (required.length === 0) return [];
  const configPath = path.join(projectRoot, 'power.config.json');
  if (!fileSystem.existsSync(configPath)) throw new Error('power.config.json was not generated');
  let config;
  try {
    config = JSON.parse(fileSystem.readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`power.config.json is invalid: ${error.message}`);
  }
  const dataSources = configuredDataSources(config);
  if (dataSources === undefined) {
    throw new Error(
      'power.config.json is missing Dataverse dataSources under '
      + 'databaseReferences["default.cds"] or databaseReferences.default.cds',
    );
  }
  const entries = dataSourceEntries(dataSources);
  const serviceDirectory = path.join(projectRoot, 'src', 'generated', 'services');
  const serviceFiles = fileSystem.existsSync(serviceDirectory)
    ? fileSystem.readdirSync(serviceDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => entry.name)
    : [];
  const results = [];
  const missing = [];
  for (const logicalName of required) {
    const entry = entries.find(({ value }) => normalizeName(value?.logicalName) === logicalName);
    const serviceFile = entry ? serviceFileFor(entry, serviceFiles) : null;
    if (!entry || !entry.value?.entitySetName || !serviceFile) {
      missing.push({
        logicalName,
        configured: Boolean(entry),
        entitySetName: entry?.value?.entitySetName || null,
        serviceFile,
      });
      continue;
    }
    results.push({
      logicalName,
      entitySetName: entry.value.entitySetName,
      serviceFile,
    });
  }
  if (missing.length > 0) {
    throw new Error(`required Dataverse service output is incomplete: ${missing.map((item) => (
      `${item.logicalName} (${item.configured ? 'configured' : 'missing config'}, `
      + `${item.entitySetName || 'missing entitySetName'}, ${item.serviceFile || 'missing service file'})`
    )).join('; ')}`);
  }
  return results;
}

function resolveInside(root, requested) {
  const file = path.resolve(root, requested);
  const relative = path.relative(root, file);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`path is outside project root: ${requested}`);
  }
  return file;
}

function parseArgs(argv) {
  const args = { tables: [] };
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--project-root') args.projectRoot = argv[++index];
    else if (token === '--manifest') args.manifest = argv[++index];
    else if (token === '--tables') {
      args.tables.push(...String(argv[++index] || '').split(','));
    } else if (token === '--table') args.tables.push(argv[++index]);
    else throw new Error(`Unknown argument: ${token}`);
  }
  if (!args.projectRoot) throw new Error('--project-root is required');
  if (!args.manifest && args.tables.length === 0) {
    throw new Error('--manifest or --tables is required');
  }
  return args;
}

function main(argv = process.argv) {
  try {
    const args = parseArgs(argv);
    const projectRoot = path.resolve(args.projectRoot);
    let logicalNames = args.tables;
    if (args.manifest) {
      const manifestPath = resolveInside(projectRoot, args.manifest);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (!Array.isArray(manifest?.service?.requiredTables)) {
        throw new Error('manifest service.requiredTables must be an array');
      }
      logicalNames = manifest.service.requiredTables.map((item) => item.logicalName);
    }
    const services = verifyDataverseServices(projectRoot, logicalNames);
    process.stdout.write(`${JSON.stringify({ ok: true, count: services.length, services })}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`verify-dataverse-services: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  configuredDataSources,
  dataSourceEntries,
  main,
  verifyDataverseServices,
};