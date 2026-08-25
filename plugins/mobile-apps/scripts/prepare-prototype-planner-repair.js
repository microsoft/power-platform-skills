#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { REQUEST_LIMIT_BYTES } = require('./prepare-prototype-planner-request');
const { safeExistingProjectFile, safeProjectOutput } = require('./lib/project-path');
const { stableStringify } = require('./resolve-context-enrichment');

function writeAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporaryPath, content, { flag: 'wx' });
  fs.renameSync(temporaryPath, filePath);
}

function preparePrototypePlannerRepair(projectRoot, responsePath) {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const request = JSON.parse(fs.readFileSync(safeExistingProjectFile(root, '.tmp/prototype-planner-request.json', 'prototype planner request'), 'utf8'));
  const invalidResponse = fs.readFileSync(safeExistingProjectFile(root, responsePath, 'invalid planner response'), 'utf8');
  const failure = JSON.parse(fs.readFileSync(safeExistingProjectFile(root, '.tmp/planner-transport-error.json', 'planner transport error'), 'utf8'));
  if (failure.attempt !== 1 || !Array.isArray(failure.errors) || !failure.errors.length) throw new Error('repair requires one recorded attempt-1 failure with concise errors');
  const repair = {
    schemaVersion: 1,
    kind: 'prototype-semantic-plan-repair-request',
    originalRequest: request,
    invalidResponse,
    validationErrors: failure.errors,
    restrictions: {
      attempt: 2,
      correctOnlyReportedErrors: true,
      rawJsonOnly: true,
      noConversationalReconstruction: true,
    },
  };
  const content = `${stableStringify(repair)}\n`;
  const bytes = Buffer.byteLength(content);
  if (bytes > REQUEST_LIMIT_BYTES) throw new Error(`planner repair request exceeds ${REQUEST_LIMIT_BYTES} bytes (${bytes})`);
  return { repair, content, bytes };
}

function main(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--invalid-response') args.invalidResponse = argv[++index];
    else if (argv[index] === '--output') args.output = argv[++index];
  }
  if (!args.projectRoot || !args.invalidResponse) {
    process.stderr.write('Usage: node prepare-prototype-planner-repair.js --project-root <dir> --invalid-response .tmp/planner-response-1.json [--output .tmp/prototype-planner-repair-request.json]\n');
    return 2;
  }
  try {
    const root = fs.realpathSync(path.resolve(args.projectRoot));
    const result = preparePrototypePlannerRepair(root, args.invalidResponse);
    writeAtomic(safeProjectOutput(root, args.output || '.tmp/prototype-planner-repair-request.json', 'prototype planner repair request'), result.content);
    process.stdout.write(`${JSON.stringify({ status: 'prepared-repair', bytes: result.bytes })}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`prepare-prototype-planner-repair: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { preparePrototypePlannerRepair };
