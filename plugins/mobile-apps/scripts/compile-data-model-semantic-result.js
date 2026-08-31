#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { sha256 } = require('./build-dataverse-operation-manifest');
const { assertSafeTarget } = require('./lib/agent-return-envelope');
const {
  RESULT_TYPE,
  compileDataModelSemanticResult,
  materializeDataModelCompilation,
} = require('./lib/compile-data-model-semantic-result');

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--project-root') args.projectRoot = argv[++index];
    else if (token === '--semantic-result') args.semanticResult = argv[++index];
    else if (token === '--publisher-prefix') args.publisherPrefix = argv[++index];
    else if (token === '--snapshot') args.snapshot = argv[++index];
    else if (token === '--product-scope-revision') args.productScopeRevision = argv[++index];
    else if (token === '--semantic-output') args.semanticOutput = argv[++index];
    else if (token === '--markdown-output') args.markdownOutput = argv[++index];
    else if (token === '--contract-output') args.contractOutput = argv[++index];
    else if (token === '--receipt-output') args.receiptOutput = argv[++index];
    else if (token === '--validate-only') args.validateOnly = true;
    else if (token === '--materialize') args.materialize = true;
    else if (token === '--json') args.json = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`unknown argument: ${token}`);
  }
  return args;
}

function usage() {
  return [
    'Usage: node compile-data-model-semantic-result.js',
    '  --project-root <dir> --semantic-result <json>',
    '  [--publisher-prefix <prefix>] [--snapshot <json>]',
    '  [--product-scope-revision <sha256>]',
    '  <--validate-only|--materialize>',
    '  [--semantic-output <json>] [--markdown-output <md>]',
    '  [--contract-output <json>] [--receipt-output <json>] [--json]',
  ].join('\n');
}

function projectFile(projectRoot, file, label) {
  if (!file) throw new Error(`${label} is required`);
  const resolved = path.resolve(projectRoot, file);
  try {
    return assertSafeTarget(projectRoot, resolved, fs);
  } catch (error) {
    throw new Error(`${label} is unsafe: ${error.message}`);
  }
}

function extractSemanticResult(value) {
  if (value && value.schemaVersion === 1 && value.mode && Array.isArray(value.entities)) return value;
  if (value?.result && value.result.schemaVersion === 1) return value.result;
  if (Array.isArray(value?.results)) {
    const matches = value.results.filter((result) => result.resultType === RESULT_TYPE);
    if (matches.length !== 1) {
      throw new Error(`expected exactly one ${RESULT_TYPE} result, found ${matches.length}`);
    }
    return matches[0].value;
  }
  throw new Error('semantic result file does not contain a data-model semantic result');
}

function run(args, fileSystem = fs) {
  if (!args.projectRoot) throw new Error('--project-root is required');
  if (Number(Boolean(args.validateOnly)) + Number(Boolean(args.materialize)) !== 1) {
    throw new Error('choose exactly one of --validate-only or --materialize');
  }
  const projectRoot = path.resolve(args.projectRoot);
  const sourcePath = projectFile(projectRoot, args.semanticResult, '--semantic-result');
  const semantic = extractSemanticResult(JSON.parse(fileSystem.readFileSync(sourcePath, 'utf8')));
  const snapshotPath = args.snapshot
    ? projectFile(projectRoot, args.snapshot, '--snapshot')
    : null;
  const snapshotHash = snapshotPath ? sha256(fileSystem.readFileSync(snapshotPath)) : null;
  const compilation = compileDataModelSemanticResult(semantic, {
    publisherPrefix: args.publisherPrefix,
    snapshotHash,
    productScopeRevision: args.productScopeRevision || null,
  });
  let materialized = [];
  if (args.materialize) {
    materialized = materializeDataModelCompilation(compilation, {
      projectRoot,
      semanticTarget: projectFile(
        projectRoot,
        args.semanticOutput || '.tmp/data-model-semantic-result.json',
        '--semantic-output',
      ),
      markdownTarget: projectFile(
        projectRoot,
        args.markdownOutput || '_dm_section.md',
        '--markdown-output',
      ),
      contractTarget: compilation.contract ? projectFile(
        projectRoot,
        args.contractOutput || '.tmp/dataverse-schema-contract.json',
        '--contract-output',
      ) : null,
      receiptTarget: projectFile(
        projectRoot,
        args.receiptOutput || '.tmp/data-model-compilation-receipt.json',
        '--receipt-output',
      ),
      fileSystem,
    });
  }
  return {
    status: 'ok',
    semanticResultHash: compilation.receipt.semanticResultHash,
    markdownHash: compilation.receipt.markdownHash,
    contractHash: compilation.receipt.contractHash,
    snapshotHash,
    mode: compilation.semantic.mode,
    entities: compilation.semantic.entities.length,
    relationships: compilation.semantic.relationships.length,
    operations: compilation.semantic.operations.length,
    materialized,
  };
}

function main(argv = process.argv) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    const result = run(args);
    if (args.json || !args.materialize) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`compile-data-model-semantic-result: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  extractSemanticResult,
  main,
  parseArgs,
  run,
};