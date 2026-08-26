#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function normalized(value) {
  return String(value || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

function serviceMethods(source) {
  const methods = new Set();
  for (const pattern of [/(?:static\s+)?async\s+([A-Za-z_$][\w$]*)\s*\(/g, /^\s*([A-Za-z_$][\w$]*)\s*:\s*async\s*\(/gm]) {
    let match;
    while ((match = pattern.exec(source)) !== null) methods.add(match[1]);
  }
  return [...methods].sort();
}

function candidateServiceNames(table) {
  const logicalName = table.adaptedLogicalName || table.logicalName;
  const stems = [
    table.serviceName,
    table.entitySetName,
    table.adaptedEntitySetName,
    logicalName,
  ].filter(Boolean);
  return [...new Set(stems.flatMap((stem) => {
    const capitalized = String(stem).replace(/^./, (value) => value.toUpperCase());
    return [stem, `${stem}Service`, capitalized, `${capitalized}Service`];
  }).map(normalized))];
}

function snapshotGeneratedServiceSurface(projectRoot, schema) {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const servicesRoot = path.join(root, 'src', 'generated', 'services');
  const files = fs.existsSync(servicesRoot)
    ? fs.readdirSync(servicesRoot).filter((name) => name.endsWith('Service.ts')).sort()
    : [];
  const entries = (schema?.tables || [])
    .filter((table) => table?.logicalName
      && String(table.plannedDecision || table.decision || '').toLowerCase() !== 'defer'
      && table.serviceRequired !== false)
    .map((table) => {
      const candidates = candidateServiceNames(table);
      const file = files.find((name) => candidates.includes(normalized(path.basename(name, '.ts'))));
      const logicalName = table.adaptedLogicalName || table.logicalName;
      if (!file) {
        return {
          entity: logicalName,
          aliases: [...new Set([table.logicalName, table.adaptedLogicalName, table.schemaName, table.entitySetName, table.adaptedEntitySetName].filter(Boolean))],
          displayName: table.displayName || logicalName,
          status: 'missing',
          service: null,
          serviceModule: null,
          methods: [],
        };
      }
      const service = path.basename(file, '.ts');
      return {
        entity: logicalName,
        aliases: [...new Set([table.logicalName, table.adaptedLogicalName, table.schemaName, table.entitySetName, table.adaptedEntitySetName].filter(Boolean))],
        displayName: table.displayName || logicalName,
        status: 'available',
        service,
        serviceModule: `@/generated/services/${service}`,
        methods: serviceMethods(fs.readFileSync(path.join(servicesRoot, file), 'utf8')),
      };
    });
  return { schemaVersion: 1, kind: 'generated-service-surface', entries };
}

function writeAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function main(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--schema') args.schema = argv[++index];
    else if (argv[index] === '--output') args.output = argv[++index];
  }
  if (!args.projectRoot) {
    process.stderr.write('Usage: node snapshot-generated-service-surface.js --project-root <dir> [--schema .tmp/dataverse-schema-contract.json] [--output .tmp/generated-service-surface.json]\n');
    return 2;
  }
  try {
    const root = fs.realpathSync(path.resolve(args.projectRoot));
    const schemaPath = path.resolve(root, args.schema || '.tmp/dataverse-schema-contract.json');
    const outputPath = path.resolve(root, args.output || '.tmp/generated-service-surface.json');
    if (!schemaPath.startsWith(`${root}${path.sep}`) || !outputPath.startsWith(`${root}${path.sep}`)) throw new Error('schema and output must remain inside project root');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    const surface = snapshotGeneratedServiceSurface(root, schema);
    writeAtomic(outputPath, surface);
    process.stdout.write(`Generated service surface written: ${outputPath} (${surface.entries.filter((entry) => entry.status === 'available').length}/${surface.entries.length} available)\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`snapshot-generated-service-surface: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { candidateServiceNames, main, normalized, serviceMethods, snapshotGeneratedServiceSurface, writeAtomic };
