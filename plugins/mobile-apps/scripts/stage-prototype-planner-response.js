#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const { safeExistingProjectFile, safeProjectOutput } = require('./lib/project-path');
const { REQUEST_LIMIT_BYTES } = require('./prepare-prototype-planner-request');
const { RESPONSE_LIMIT_BYTES, semanticPlanRevision, validatePrototypeSemanticPlan } = require('./lib/prototype-semantic-plan');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function writeAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporaryPath, value, { flag: 'wx' });
  fs.renameSync(temporaryPath, filePath);
}

function decodeUtf8(buffer) {
  return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
}

function parseRawSemanticPlan(buffer) {
  if (buffer.length > RESPONSE_LIMIT_BYTES) throw new Error(`planner response exceeds ${RESPONSE_LIMIT_BYTES} bytes (${buffer.length})`);
  const text = decodeUtf8(buffer);
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) throw new Error('planner response must be one raw JSON object without status text or Markdown fences');
  let semanticPlan;
  try {
    semanticPlan = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`planner response is invalid JSON: ${error.message}`);
  }
  return semanticPlan;
}

function stagePrototypePlannerResponse(projectRoot, responseBuffer, attempt) {
  const root = fs.realpathSync(path.resolve(projectRoot));
  if (![1, 2].includes(attempt)) throw new Error('planner attempt must be 1 or 2');
  const requestPath = safeExistingProjectFile(root, '.tmp/prototype-planner-request.json', 'prototype planner request');
  const requestBuffer = fs.readFileSync(requestPath);
  if (requestBuffer.length > REQUEST_LIMIT_BYTES) throw new Error('prototype planner request exceeds its transport budget');
  const errorPath = safeProjectOutput(root, '.tmp/planner-transport-error.json', 'planner transport error');
  const transportPath = safeProjectOutput(root, '.tmp/planner-transport.json', 'planner transport evidence');
  if (fs.existsSync(transportPath)) throw new Error('planner transport already completed for this request');
  if (attempt === 1 && fs.existsSync(errorPath)) throw new Error('planner attempt 1 is already recorded; only attempt 2 repair is allowed');
  if (attempt === 2) {
    if (!fs.existsSync(errorPath) || JSON.parse(fs.readFileSync(errorPath, 'utf8')).attempt !== 1) {
      throw new Error('planner repair attempt requires one recorded attempt-1 schema failure');
    }
  }
  let semanticPlan;
  let errors = [];
  let errorCategory = null;
  try {
    semanticPlan = parseRawSemanticPlan(responseBuffer);
    const request = JSON.parse(requestBuffer.toString('utf8'));
    const validation = validatePrototypeSemanticPlan(semanticPlan, {
      experienceContract: request.contracts.experience,
      contextContract: request.contracts.context,
      workflowJourney: request.contracts.workflowJourney,
      executionPreflight: request.contracts.executionPreflight,
      foundationContract: request.derived.foundationContract,
    });
    errors = validation.errors;
    if (errors.length) errorCategory = 'schema-or-semantic';
  } catch (error) {
    errors = [error.message];
    errorCategory = /exceeds/.test(error.message) ? 'response-budget'
      : /utf-?8/i.test(error.message) ? 'invalid-utf8'
        : /invalid JSON/.test(error.message) ? 'invalid-json'
          : 'transport-framing';
  }
  const responseSha256 = sha256(responseBuffer);
  if (errors.length) {
    writeAtomic(errorPath, `${JSON.stringify({ schemaVersion: 1, attempt, errorCategory, responseBytes: responseBuffer.length, responseSha256, errors }, null, 2)}\n`);
    const error = new Error(errors.join('; '));
    error.validationErrors = errors;
    throw error;
  }
  const semanticPlanSha256 = semanticPlanRevision(semanticPlan);
  writeAtomic(safeProjectOutput(root, '.tmp/prototype-semantic-plan.staged.json', 'staged prototype semantic plan'), `${JSON.stringify(semanticPlan, null, 2)}\n`);
  writeAtomic(transportPath, `${JSON.stringify({
    schemaVersion: 1,
    requestBytes: requestBuffer.length,
    requestSha256: sha256(requestBuffer),
    responseBytes: responseBuffer.length,
    responseSha256,
    semanticPlanSha256,
    plannerAttempts: attempt,
    plannerRepairAttempts: attempt - 1,
    errorCategory: null,
  }, null, 2)}\n`);
  if (fs.existsSync(errorPath)) fs.rmSync(errorPath);
  return { semanticPlan, responseSha256 };
}

function main(argv) {
  const args = { attempt: 1 };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--response') args.response = argv[++index];
    else if (argv[index] === '--attempt') args.attempt = Number(argv[++index]);
  }
  if (!args.projectRoot || !args.response) {
    process.stderr.write('Usage: node stage-prototype-planner-response.js --project-root <dir> --response <relative-file> [--attempt 1|2]\n');
    return 2;
  }
  try {
    const root = fs.realpathSync(path.resolve(args.projectRoot));
    const responsePath = safeExistingProjectFile(root, args.response, 'planner response');
    stagePrototypePlannerResponse(root, fs.readFileSync(responsePath), args.attempt);
    process.stdout.write(`${JSON.stringify({ status: 'staged', attempt: args.attempt })}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`stage-prototype-planner-response: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { RESPONSE_LIMIT_BYTES, parseRawSemanticPlan, stagePrototypePlannerResponse };