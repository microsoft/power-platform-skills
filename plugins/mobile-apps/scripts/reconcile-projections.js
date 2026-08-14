#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--validate-only') {
      args.validateOnly = true;
    } else if (argv[i].startsWith('--') && argv[i + 1]) {
      args[argv[i].slice(2)] = argv[++i];
    }
  }
  return args;
}

function normalizeNextLink(nextLink) {
  const marker = '/api/data/v9.2/';
  const index = nextLink.indexOf(marker);
  return index >= 0 ? nextLink.slice(index + marker.length) : nextLink;
}

async function fetchAll(request, apiPath, label) {
  const rows = [];
  let next = apiPath;
  while (next) {
    const response = await request('GET', normalizeNextLink(next));
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`${label} query failed: ${response.error || response.status}`);
    }
    rows.push(...(response.data?.value || []));
    next = response.data?.['@odata.nextLink'] || null;
  }
  return rows;
}

async function reconcileProjection(projection, request, sourceId, options = {}) {
  const sourceFilter = sourceId ? `&$filter=${encodeURIComponent(`${projection.sourcePrimaryId} eq ${sourceId}`)}` : '';
  const sources = await fetchAll(request,
    `${projection.sourceEntitySet}?$select=${projection.sourcePrimaryId},${projection.sourceColumn}&$top=5000${sourceFilter}`,
    `${projection.name}: source`);

  const targetFilter = sourceId ? `&$filter=${encodeURIComponent(`${projection.targetLookupValueColumn} eq ${sourceId}`)}` : '';
  const targetSelect = [
    projection.targetPrimaryId,
    projection.targetLookupValueColumn,
    options.validateOnly ? null : projection.targetColumn,
  ].filter(Boolean).join(',');
  const targets = await fetchAll(request,
    `${projection.targetEntitySet}?$select=${targetSelect}&$top=5000${targetFilter}`,
    `${projection.name}: target`);

  if (options.validateOnly) {
    return {
      name: projection.name,
      status: 'VALID',
      sourcesScanned: sources.length,
      targetsScanned: targets.length,
      updated: 0,
    };
  }

  const sourceMap = new Map(sources.map((row) => [
    String(row[projection.sourcePrimaryId]).toLowerCase(),
    row[projection.sourceColumn],
  ]));
  const operations = [];
  let correct = 0;
  for (const row of targets) {
    const lookupId = row[projection.targetLookupValueColumn];
    const expected = lookupId == null ? null : sourceMap.get(String(lookupId).toLowerCase());
    if (expected === undefined) continue;
    if (row[projection.targetColumn] === expected) {
      correct += 1;
      continue;
    }
    operations.push({
      method: 'PATCH',
      apiPath: `${projection.targetEntitySet}(${row[projection.targetPrimaryId]})`,
      body: { [projection.targetColumn]: expected },
    });
  }
  if (operations.length > 0) {
    let failureCount = 0;
    for (let offset = 0; offset < operations.length; offset += 100) {
      const chunk = operations.slice(offset, offset + 100);
      const result = await request(
        'BATCH-METADATA',
        `Projection ${projection.name} ${offset + 1}-${offset + chunk.length}`,
        chunk,
      );
      if (result.status < 200 || result.status >= 300 || !Array.isArray(result.data)) {
        throw new Error(`${projection.name}: update batch failed: ${result.error || result.status}`);
      }
      failureCount += (result.data || []).filter(
        (entry) => entry.status < 200 || entry.status >= 300,
      ).length;
    }
    if (failureCount > 0) throw new Error(`${projection.name}: ${failureCount} updates failed`);
  }
  return {
    name: projection.name,
    scanned: targets.length,
    correct,
    updated: operations.length,
    failed: 0,
  };
}

function validateProjection(projection) {
  const required = [
    'name', 'sourceEntitySet', 'sourcePrimaryId', 'sourceColumn',
    'targetEntitySet', 'targetPrimaryId', 'targetLookupValueColumn', 'targetColumn',
    'refreshOwner',
  ];
  const missing = required.filter((key) => !projection[key]);
  if (missing.length > 0) throw new Error(`${projection.name || '<unnamed>'}: missing ${missing.join(', ')}`);
  if (!['client-write-through', 'existing-cloud-flow'].includes(projection.refreshOwner)) {
    throw new Error(`${projection.name}: unsupported refreshOwner ${projection.refreshOwner}`);
  }
  if (projection.refreshOwner === 'existing-cloud-flow' &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(projection.flowId || '')) {
    throw new Error(`${projection.name}: existing-cloud-flow requires a verified GUID flowId`);
  }
}

function createCliRequest(args) {
  const script = path.join(__dirname, 'dataverse-request.js');
  return async (method, apiPath, operations) => {
    const command = [script, args['env-url'], method, apiPath];
    if (method === 'BATCH-METADATA') {
      command.push('--operations', JSON.stringify(operations));
    }
    if (args.solution) command.push('--solution', args.solution);
    if (args['tenant-id']) command.push('--tenant-id', args['tenant-id']);
    return JSON.parse(execFileSync(process.execPath, command, { encoding: 'utf8' }).trim());
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.plan || !args['env-url']) {
    process.stderr.write('Usage: node reconcile-projections.js --plan <projection-plan.json> --env-url <url> [--validate-only] [--projection <name>] [--source-id <guid>] [--tenant-id <id>]\n');
    process.exit(1);
  }
  const plan = JSON.parse(fs.readFileSync(path.resolve(args.plan), 'utf8'));
  const projections = (plan.projections || []).filter((item) => !args.projection || item.name === args.projection);
  if (projections.length === 0) throw new Error('No matching projections');
  const request = createCliRequest(args);
  const results = [];
  for (const projection of projections) {
    validateProjection(projection);
    results.push(await reconcileProjection(
      projection,
      request,
      args['source-id'],
      { validateOnly: Boolean(args.validateOnly) },
    ));
  }
  console.log(JSON.stringify({ status: args.validateOnly ? 'VALID' : 'DONE', results }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}

module.exports = { fetchAll, normalizeNextLink, reconcileProjection, validateProjection };
