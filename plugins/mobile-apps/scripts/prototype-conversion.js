#!/usr/bin/env node
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { readJson } = require('./lib/prototype-files');
const { JOURNAL, beginConversion, runConversionPhase } = require('./lib/prototype-conversion');
const { prepareTestWriteScope, authorizeTestWrites, revokeTestWrites } = require('./lib/prototype-test-writes');
const { activateConnectedData } = require('./lib/prototype-activation');

async function verifyPlayerEffect(root, command, phase, receipt) {
  if (!process.env.MOBILE_AUTHORING_CONTEXT && !process.env.MOBILE_AUTHORING_RUNNER_TOKEN) return;
  const client = require('./lib/mobile-authoring-transport').createClient({ projectRoot: root });
  if (command !== 'status' && client.descriptor.operation !== 'connect') throw new Error('Only an explicit conversion job may run these effects');
  await client.verify({ refresh: true });
  if (readJson(root, '.tmp/prototype-domain.json').appInstanceId !== client.descriptor.appInstanceId) {
    throw new Error('Conversion context belongs to a different app');
  }
  if (command === 'begin') {
    const baseRevision = fs.existsSync(path.join(root, JOURNAL)) ? readJson(root, JOURNAL).baseRevision
      : require('./lib/authoring-source').captureSource(root).revision;
    if (baseRevision !== client.descriptor.baseRevision) throw new Error('Conversion must begin or resume from the exact approved base revision');
  }
  if (command === 'run') {
    if (!receipt) throw new Error('Player conversion phases require their exact maker receipt');
    const gateId = ['adapters', 'startup'].includes(phase) ? 'prototype-mapping' : 'gate4';
    const saved = await client.verifySavedDecision(receipt, { gateId, action: 'approve' });
    if (gateId === 'gate4' && (saved.binding.type !== 'gate' || saved.binding.gate !== 4)) {
      throw new Error('Remote preparation requires the owning implementation gate');
    }
    if (gateId === 'prototype-mapping') {
      const required = [
        '.tmp/prototype-dataverse-mapping-input.json', '.tmp/dataverse-schema-contract.json',
        '.tmp/prototype-materialized-snapshot.json', '.tmp/prototype-relationship-evidence.json',
        '.tmp/prototype-domain.json', '.tmp/prototype-bindings.json', '.tmp/prototype-rules.json',
      ];
      if (saved.question.kind !== 'schema' || saved.question.fields.length || saved.binding.type !== 'artifacts'
        || required.some((file) => !saved.binding.files.some((entry) => entry.path === file))) {
        throw new Error('Materialized mapping approval must bind every exact mapping input');
      }
    }
  }
}

async function main(argv = process.argv.slice(2)) {
  try {
    const command = argv[0];
    let root;
    let phase;
    let solution;
    let receipt;
    let confirmDisposableTestWrites = false;
    let confirmStandaloneApply = false;
    let expectedSourceRevision;
    const entityIds = [];
    for (let index = 1; index < argv.length; index += 1) {
      if (argv[index] === '--project-root') root = argv[++index];
      else if (argv[index] === '--phase') phase = argv[++index];
      else if (argv[index] === '--solution') solution = argv[++index];
      else if (argv[index] === '--receipt') receipt = argv[++index];
      else if (argv[index] === '--entity') entityIds.push(argv[++index]);
      else if (argv[index] === '--confirm-disposable-test-writes') confirmDisposableTestWrites = true;
      else if (argv[index] === '--confirm-standalone-apply') confirmStandaloneApply = true;
      else if (argv[index] === '--expected-revision') expectedSourceRevision = argv[++index];
      else throw new Error(`Unknown argument: ${argv[index]}`);
    }
    if (!root) throw new Error('--project-root is required');
    root = path.resolve(root);
    if (!['authorize-test-writes', 'revoke-test-writes'].includes(command)) await verifyPlayerEffect(root, command, phase, receipt);
    let result;
    if (command === 'begin') result = beginConversion(root);
    else if (command === 'status') result = readJson(root, JOURNAL);
    else if (command === 'test-write-scope') result = prepareTestWriteScope(root, entityIds);
    else if (command === 'authorize-test-writes') result = await authorizeTestWrites(root, { receipt, confirmDisposableTestWrites });
    else if (command === 'revoke-test-writes') result = await revokeTestWrites(root);
    else if (command === 'activate-data') result = activateConnectedData(root, { expectedSourceRevision, confirmStandaloneApply });
    else if (command === 'run') {
      if (!solution) throw new Error('An explicitly approved --solution is required');
      const environment = readJson(root, '.resolved-environment.json');
      const config = readJson(root, 'power.config.json');
      if (!environment.environmentId || config.environmentId !== environment.environmentId) throw new Error('Resolved and officially initialized environments must match');
      result = await runConversionPhase(root, phase, {
        ...environment, publisherPrefix: readJson(root, '.tmp/dataverse-schema-contract.json').publisherPrefix,
        solutionUniqueName: solution,
      });
    } else throw new Error('Expected begin, status, run, test-write-scope, authorize-test-writes, revoke-test-writes, or activate-data');
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const token = process.env.MOBILE_AUTHORING_RUNNER_TOKEN;
    process.stderr.write(`prototype-conversion: ${token ? String(error.message).split(token).join('[redacted]') : error.message}\n`);
    return 1;
  }
}

if (require.main === module) main().then((status) => { process.exitCode = status; });
module.exports = { main, verifyPlayerEffect };
