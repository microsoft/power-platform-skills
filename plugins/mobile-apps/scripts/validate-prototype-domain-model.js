#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { domainModelRevision, validatePrototypeDomainModel } = require('./lib/prototype-domain-model');
const { contractHash } = require('./experience-patterns');
const { contextEnrichmentRevision } = require('./resolve-context-enrichment');
const { validateContextEnrichment } = require('./validate-context-enrichment');

function main(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--model') args.model = argv[++index];
    else if (argv[index] === '--json') args.json = true;
  }
  if (!args.projectRoot) {
    process.stderr.write('Usage: node validate-prototype-domain-model.js --project-root <dir> [--model .tmp/prototype-domain-model.json] [--json]\n');
    return 2;
  }
  try {
    const root = path.resolve(args.projectRoot);
    const modelPath = path.resolve(root, args.model || '.tmp/prototype-domain-model.json');
    if (!fs.existsSync(modelPath)) throw new Error(`prototype domain model is missing: ${modelPath}`);
    const model = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
    const experiencePath = path.join(root, '.tmp', 'experience-contract.json');
    const contextPath = path.join(root, '.tmp', 'context-enrichment-contract.json');
    const experience = fs.existsSync(experiencePath) ? JSON.parse(fs.readFileSync(experiencePath, 'utf8')) : null;
    const contextContract = fs.existsSync(contextPath) ? JSON.parse(fs.readFileSync(contextPath, 'utf8')) : null;
    if (experience && !contextContract) throw new Error('context enrichment contract is missing');
    if (contextContract) {
      const contextValidation = validateContextEnrichment(contextContract, { experienceContract: experience, domainModel: model });
      if (!contextValidation.valid) throw new Error(contextValidation.errors.join('; '));
    }
    const result = validatePrototypeDomainModel(model, {
      experienceContractSha256: experience ? contractHash(experience) : null,
      contextEnrichmentSha256: contextContract ? contextEnrichmentRevision(contextContract) : null,
    });
    const output = { ...result, revision: result.valid ? domainModelRevision(model) : null };
    if (args.json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if (!result.valid) {
      if (!args.json) result.errors.forEach((error) => process.stderr.write(`- ${error}\n`));
      return 2;
    }
    if (!args.json) process.stdout.write(`Prototype domain model valid: ${output.revision}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`validate-prototype-domain-model: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main };