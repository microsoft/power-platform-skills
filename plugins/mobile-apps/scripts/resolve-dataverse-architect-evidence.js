#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { validatePlanningGenerationPointer } = require('./refresh-dataverse-planning-evidence');
const { stableJson } = require('./lib/dataverse-evidence-projection');

const MAX_REQUESTED_EVIDENCE_ITEMS = 20;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
}

function parseEvidenceRequest(value) {
  const normalized = String(value || '').trim().replace(/^NEEDS_CONTEXT:\s*/, '');
  const match = normalized.match(
    /^dataverse-evidence:([A-Za-z][A-Za-z0-9_]*):(columns|relationships|keys):(.+)$/,
  );
  if (!match) {
    throw new Error(
      'evidence request must use dataverse-evidence:<table>:<columns|relationships|keys>:<name,...>',
    );
  }
  const names = [...new Set(match[3].split(',').map((name) => name.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
  if (names.length === 0 || names.length > MAX_REQUESTED_EVIDENCE_ITEMS) {
    throw new Error(`evidence request must contain 1-${MAX_REQUESTED_EVIDENCE_ITEMS} names`);
  }
  if (names.some((name) => !/^[A-Za-z][A-Za-z0-9_]*$/.test(name))) {
    throw new Error('evidence request names must be Dataverse logical or schema names');
  }
  return {
    tableLogicalName: normalizeName(match[1]),
    evidenceClass: match[2],
    names,
  };
}

function relationshipItems(table) {
  return [
    ...(table.manyToOneRelationships || []).map((item) => ({
      kind: 'many-to-one',
      ...item,
    })),
    ...(table.oneToManyRelationships || []).map((item) => ({
      kind: 'one-to-many',
      ...item,
    })),
    ...(table.manyToManyRelationships || []).map((item) => ({
      kind: 'many-to-many',
      ...item,
    })),
  ];
}

function resolveEvidenceRequest(snapshot, request, sourceSnapshotSha256) {
  const table = (snapshot.tables || []).find(
    (item) => normalizeName(item.logicalName) === request.tableLogicalName,
  );
  if (!table) throw new Error(`selected table is not in the current snapshot: ${request.tableLogicalName}`);
  if ((table.detailLevel || 'full') !== 'full') {
    throw new Error(`selected table requires full detail before evidence extraction: ${table.logicalName}`);
  }
  const sourceItems = request.evidenceClass === 'columns'
    ? table.columns || []
    : request.evidenceClass === 'relationships'
      ? relationshipItems(table)
      : table.alternateKeys || [];
  const requestedKeys = new Set(request.names.map(normalizeName));
  const items = sourceItems.filter((item) => {
    const identities = request.evidenceClass === 'columns'
      ? [item.logicalName]
      : request.evidenceClass === 'relationships'
        ? [item.schemaName]
        : [item.logicalName, item.schemaName];
    return identities.some((identity) => requestedKeys.has(normalizeName(identity)));
  });
  const found = new Set(items.flatMap((item) => (
    request.evidenceClass === 'keys'
      ? [normalizeName(item.logicalName), normalizeName(item.schemaName)]
      : [normalizeName(
        request.evidenceClass === 'columns' ? item.logicalName : item.schemaName,
      )]
  )));
  const response = {
    schemaVersion: 1,
    sourceSnapshotSha256,
    snapshotGeneratedAt: snapshot.generatedAt,
    tableLogicalName: table.logicalName,
    detailLevel: table.detailLevel || 'full',
    evidenceClass: request.evidenceClass,
    requestedNames: request.names,
    items,
    absentNames: request.names.filter((name) => !found.has(normalizeName(name))),
  };
  response.integritySha256 = sha256(stableJson(response));
  return response;
}

function validateEvidenceResponse(response, snapshot) {
  const errors = [];
  const withoutIntegrity = { ...response };
  delete withoutIntegrity.integritySha256;
  if (response.integritySha256 !== sha256(stableJson(withoutIntegrity))) {
    errors.push('evidence response integrity hash does not match');
  }
  if (response.sourceSnapshotSha256 !== sha256(fs.readFileSync(snapshot))) {
    errors.push('evidence response source snapshot hash is stale');
  }
  return { valid: errors.length === 0, errors };
}

function atomicWriteJson(file, value) {
  const resolved = path.resolve(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporary, stableJson(value), 'utf8');
    fs.renameSync(temporary, resolved);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function resolveFromCurrentGeneration({ pointerFile, requestValue, outputFile }) {
  const generation = validatePlanningGenerationPointer(pointerFile);
  const snapshotSource = fs.readFileSync(generation.snapshotPath, 'utf8');
  const snapshot = JSON.parse(snapshotSource);
  const request = parseEvidenceRequest(requestValue);
  const response = resolveEvidenceRequest(snapshot, request, generation.sourceSnapshotSha256);
  if (outputFile) atomicWriteJson(outputFile, response);
  return { response, generation, output: outputFile ? path.resolve(outputFile) : null };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--pointer') args.pointerFile = argv[++index];
    else if (argv[index] === '--request') args.requestValue = argv[++index];
    else if (argv[index] === '--output') args.outputFile = argv[++index];
    else if (argv[index] === '--json') args.json = true;
  }
  return args;
}

function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (!args.pointerFile || !args.requestValue || !args.outputFile) {
    process.stderr.write(
      'Usage: node resolve-dataverse-architect-evidence.js '
      + '--pointer <json> --request <signal> --output <json> [--json]\n',
    );
    return 2;
  }
  try {
    const result = resolveFromCurrentGeneration(args);
    process.stdout.write(`${args.json ? JSON.stringify({
      status: 'DONE',
      output: result.output,
      tableLogicalName: result.response.tableLogicalName,
      evidenceClass: result.response.evidenceClass,
      items: result.response.items.length,
      absent: result.response.absentNames.length,
      sourceSnapshotSha256: result.response.sourceSnapshotSha256,
    }, null, 2) : result.output}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`resolve-dataverse-architect-evidence: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  MAX_REQUESTED_EVIDENCE_ITEMS,
  main,
  parseEvidenceRequest,
  relationshipItems,
  resolveEvidenceRequest,
  resolveFromCurrentGeneration,
  validateEvidenceResponse,
};
