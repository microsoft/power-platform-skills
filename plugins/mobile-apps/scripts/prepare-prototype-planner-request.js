#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { contractHash, foundationContract, primaryComposition } = require('./experience-patterns');
const { RESPONSE_LIMIT_BYTES } = require('./lib/prototype-semantic-plan');
const { safeProjectOutput } = require('./lib/project-path');
const { contextEnrichmentRevision, stableStringify } = require('./resolve-context-enrichment');
const { workflowJourneyRevision } = require('./resolve-workflow-journey');
const semanticPlanSchema = require('./schema-prototype-semantic-plan.json');

const REQUEST_LIMIT_BYTES = 512 * 1024;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporaryPath, content, { flag: 'wx' });
  fs.renameSync(temporaryPath, filePath);
}

function preparePrototypePlannerRequest(projectRoot) {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const required = {
    brief: path.join(root, 'brief.md'),
    experience: path.join(root, '.tmp', 'experience-contract.json'),
    context: path.join(root, '.tmp', 'context-enrichment-contract.json'),
    journey: path.join(root, '.tmp', 'workflow-journey-contract.json'),
    executionPreflight: path.join(root, '.tmp', 'mobile-plan-execution-preflight.json'),
    packageJson: path.join(root, 'package.json'),
  };
  for (const [name, filePath] of Object.entries(required)) if (!fs.existsSync(filePath)) throw new Error(`${name} input is missing`);
  const brief = fs.readFileSync(required.brief, 'utf8').trim();
  if (!brief) throw new Error('brief must be non-empty');
  const experience = readJson(required.experience);
  const context = readJson(required.context);
  const journey = readJson(required.journey);
  const executionPreflight = readJson(required.executionPreflight);
  const packageJson = readJson(required.packageJson);
  const request = {
    schemaVersion: 1,
    kind: 'mobile-prototype-planner-request',
    workflow: 'create-mobile-prototype',
    planningMode: 'prototype',
    brief,
    contracts: { experience, context, workflowJourney: journey, executionPreflight },
    derived: {
      experienceContractSha256: contractHash(experience),
      contextEnrichmentSha256: contextEnrichmentRevision(context),
      workflowJourneySha256: workflowJourneyRevision(journey),
      primaryComposition: primaryComposition(experience),
      foundationContract: foundationContract(experience),
    },
    templateFacts: {
      packageName: String(packageJson.name || ''),
      dependencies: packageJson.dependencies || {},
      devDependencies: packageJson.devDependencies || {},
    },
    responseSchema: semanticPlanSchema,
    restrictions: {
      filesystemAccess: false,
      externalMutation: false,
      environmentDiscovery: false,
      navigationOwner: 'foreground',
      finalNavigationContractForbidden: true,
      output: 'raw-json-prototype-semantic-plan-v1',
      responseLimitBytes: RESPONSE_LIMIT_BYTES,
    },
  };
  const content = `${stableStringify(request)}\n`;
  const bytes = Buffer.byteLength(content);
  if (bytes > REQUEST_LIMIT_BYTES) throw new Error(`planner request exceeds ${REQUEST_LIMIT_BYTES} bytes (${bytes})`);
  return { request, content, bytes, sha256: sha256(content) };
}

function main(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--output') args.output = argv[++index];
  }
  if (!args.projectRoot) {
    process.stderr.write('Usage: node prepare-prototype-planner-request.js --project-root <dir> [--output .tmp/prototype-planner-request.json]\n');
    return 2;
  }
  try {
    const root = fs.realpathSync(path.resolve(args.projectRoot));
    const output = safeProjectOutput(root, args.output || '.tmp/prototype-planner-request.json', 'planner request output');
    const result = preparePrototypePlannerRequest(root);
    for (const relativePath of ['.tmp/planner-transport-error.json', '.tmp/planner-transport.json', '.tmp/prototype-planner-repair-request.json', '.tmp/prototype-semantic-plan.staged.json', '.tmp/plan-artifact-bundle.json']) {
      const stalePath = safeProjectOutput(root, relativePath, 'planner transport reset');
      if (fs.existsSync(stalePath)) fs.rmSync(stalePath);
    }
    writeAtomic(output, result.content);
    process.stdout.write(`${JSON.stringify({ status: 'prepared', bytes: result.bytes, sha256: result.sha256 })}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`prepare-prototype-planner-request: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { REQUEST_LIMIT_BYTES, preparePrototypePlannerRequest };