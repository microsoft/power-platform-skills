#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { contractHash } = require('./experience-patterns');
const { fixtureDataRevision, validatePrototypeDomainModel } = require('./lib/prototype-domain-model');
const { contextEnrichmentRevision } = require('./resolve-context-enrichment');
const { validateContextEnrichment } = require('./validate-context-enrichment');

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function writePairAtomic(contextPath, contextContract, domainPath, domainModel) {
  const nonce = `${process.pid}-${Date.now()}`;
  const contextTemporary = `${contextPath}.tmp-${nonce}`;
  const domainTemporary = `${domainPath}.tmp-${nonce}`;
  const originalContext = fs.readFileSync(contextPath);
  const originalDomain = fs.readFileSync(domainPath);
  let domainReplaced = false;
  try {
    fs.writeFileSync(contextTemporary, `${JSON.stringify(contextContract, null, 2)}\n`, { flag: 'wx' });
    fs.writeFileSync(domainTemporary, `${JSON.stringify(domainModel, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(domainTemporary, domainPath);
    domainReplaced = true;
    fs.renameSync(contextTemporary, contextPath);
  } catch (error) {
    if (domainReplaced) {
      fs.writeFileSync(domainPath, originalDomain);
      fs.writeFileSync(contextPath, originalContext);
    }
    throw error;
  } finally {
    fs.rmSync(contextTemporary, { force: true });
    fs.rmSync(domainTemporary, { force: true });
  }
}

function finalizeContextFromDomain(projectRoot, options = {}) {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const contextPath = path.resolve(root, options.contextPath || '.tmp/context-enrichment-contract.json');
  const domainPath = path.resolve(root, options.domainPath || '.tmp/prototype-domain-model.json');
  const experiencePath = path.resolve(root, options.experiencePath || '.tmp/experience-contract.json');
  const briefPath = path.resolve(root, options.briefPath || 'brief.md');
  for (const filePath of [contextPath, domainPath, experiencePath, briefPath]) {
    if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) throw new Error('all Context finalization inputs must remain inside project root');
    if (!fs.existsSync(filePath)) throw new Error(`Context finalization input is missing: ${path.relative(root, filePath)}`);
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Context finalization input must be a regular non-symlink file: ${path.relative(root, filePath)}`);
  }

  const contextContract = readJson(contextPath, 'Context enrichment contract');
  const domainModel = readJson(domainPath, 'Prototype domain model');
  const experienceContract = readJson(experiencePath, 'Experience contract');
  const briefText = fs.readFileSync(briefPath, 'utf8');
  if (contextContract.decisionOwner !== 'model') throw new Error('final Context must report decisionOwner model');

  const usesFixtureData = (contextContract.displayContext || []).some((entry) => entry.source === 'domain-fixture');
  const fixtureDataSha256 = fixtureDataRevision(domainModel);
  const finalizedContext = {
    ...contextContract,
    ...(usesFixtureData ? { fixtureDataSha256 } : {}),
  };
  if (!usesFixtureData) delete finalizedContext.fixtureDataSha256;

  const contextValidation = validateContextEnrichment(finalizedContext, {
    experienceContract,
    briefText,
    domainModel,
  });
  if (!contextValidation.valid) throw new Error(`final Context is invalid: ${contextValidation.errors.join('; ')}`);

  const finalizedDomain = {
    ...domainModel,
    contextEnrichmentSha256: contextEnrichmentRevision(finalizedContext),
  };
  const domainValidation = validatePrototypeDomainModel(finalizedDomain, {
    experienceContractSha256: contractHash(experienceContract),
    contextEnrichmentSha256: contextEnrichmentRevision(finalizedContext),
  });
  if (!domainValidation.valid) throw new Error(`restamped prototype Domain is invalid: ${domainValidation.errors.join('; ')}`);

  writePairAtomic(contextPath, finalizedContext, domainPath, finalizedDomain);
  return {
    contextRevision: contextEnrichmentRevision(finalizedContext),
    fixtureDataSha256: usesFixtureData ? fixtureDataSha256 : null,
    fixtureBindingCount: (finalizedContext.displayContext || []).filter((entry) => entry.source === 'domain-fixture').length,
  };
}

function main(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--context') args.contextPath = argv[++index];
    else if (argv[index] === '--domain-model') args.domainPath = argv[++index];
  }
  if (!args.projectRoot) {
    process.stderr.write('Usage: node finalize-context-from-domain.js --project-root <dir> [--context .tmp/context-enrichment-contract.json] [--domain-model .tmp/prototype-domain-model.json]\n');
    return 2;
  }
  try {
    const result = finalizeContextFromDomain(args.projectRoot, args);
    process.stdout.write(`Context finalized from Domain fixtures: ${result.contextRevision} (${result.fixtureBindingCount} fixture binding(s))\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`finalize-context-from-domain: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { finalizeContextFromDomain, main, writePairAtomic };
