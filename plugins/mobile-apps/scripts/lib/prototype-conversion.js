'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { inside, readJson, atomicWrite, revision } = require('./prototype-files');
const { bindContractToPlan, validateManifest } = require('../build-dataverse-operation-manifest');
const { executeManifest } = require('../execute-dataverse-operation-manifest');
const { generateDataverseServices } = require('../generate-dataverse-services');
const { generateDataverseRepositories, stageConnectedStartup } = require('./dataverse-repository-generator');
const { generatePrototype } = require('./prototype-generator');

const JOURNAL = '.tmp/prototype-conversion-journal.json';
const PHASES = ['metadata', 'services', 'schemas', 'adapters', 'startup'];

function beginConversion(root, {
  captureSource, verifyPrototype = (projectRoot) => generatePrototype(projectRoot, { check: true }),
} = {}) {
  if (fs.existsSync(inside(root, JOURNAL))) return readJson(root, JOURNAL);
  const profile = readJson(root, '.tmp/prototype-profile.json');
  const domain = readJson(root, '.tmp/prototype-domain.json');
  if (profile.profile !== 'prototype' || profile.appInstanceId !== domain.appInstanceId) {
    throw new Error('Conversion requires an explicit existing prototype');
  }
  if (verifyPrototype(root)?.ok !== true) throw new Error('The existing local prototype must pass its actual generator/startup checks');
  const journal = {
    schemaVersion: 1, conversionId: crypto.randomUUID(), appInstanceId: domain.appInstanceId,
    baseRevision: (captureSource || require('./authoring-source').captureSource)(root).revision,
    domainRevision: revision(domain), rulesRevision: revision(readJson(root, '.tmp/prototype-rules.json')),
    bindingsRevision: revision(readJson(root, '.tmp/prototype-bindings.json')),
    fixtureContentRevision: fixtureContentRevision(root),
    state: 'planning', activeProfile: 'prototype', remoteEffectsPossible: false,
    completed: [], inFlight: null, failures: [],
    dataImport: 'none',
  };
  atomicWrite(root, JOURNAL, journal);
  return journal;
}

function fixtureContentRevision(root) {
  const facts = readJson(root, '.tmp/scenario-facts.json');
  return revision({ records: facts.records, relationships: facts.relationships, mediaAssets: facts.mediaAssets });
}

function conversionInputs(root, context) {
  const schema = readJson(root, '.tmp/dataverse-schema-contract.json');
  const execution = readJson(root, '.tmp/dataverse-execution-contract.json');
  const planBytes = fs.readFileSync(inside(root, 'native-app-plan.md'));
  const approvalReceipt = readJson(root, '.tmp/mobile-plan-status.json');
  const expected = bindContractToPlan(schema, planBytes, approvalReceipt);
  if (revision(expected) !== revision(execution)) throw new Error('Execution copy must bind the immutable approved canonical schema');
  const manifest = readJson(root, '.tmp/dataverse-operation-manifest.json');
  const reconciliationBytes = fs.readFileSync(inside(root, '.tmp/dataverse-execution-reconciliation.json'));
  const publishCheckpoint = fs.existsSync(inside(root, '.tmp/dataverse-publish-pending.json'))
    ? readJson(root, '.tmp/dataverse-publish-pending.json') : null;
  const result = validateManifest(manifest, {
    planBytes, contract: execution, contractBytes: fs.readFileSync(inside(root, '.tmp/dataverse-execution-contract.json')),
    approvalReceipt, reconciliationBytes, reconciliation: JSON.parse(reconciliationBytes),
    context, publishCheckpoint, requireExecutable: true,
  });
  if (!result.valid) throw new Error(`Conversion manifest gate failed: ${result.errors.join('; ')}`);
  return { schema, manifest, reconciliationRevision: manifest.binding.reconciliationSha256 };
}

async function runConversionPhase(root, phase, context, dependencies = {}) {
  if (!PHASES.includes(phase)) throw new Error(`Unknown conversion phase ${phase}`);
  const journal = readJson(root, JOURNAL);
  if (revision(readJson(root, '.tmp/prototype-domain.json')) !== journal.domainRevision
    || revision(readJson(root, '.tmp/prototype-rules.json')) !== journal.rulesRevision
    || revision(readJson(root, '.tmp/prototype-bindings.json')) !== journal.bindingsRevision) {
    throw new Error('Prototype domain/rules changed during conversion; review a successor conversion, preserving this remote journal');
  }
  if (fixtureContentRevision(root) !== journal.fixtureContentRevision) throw new Error('Conversion cannot redefine canonical fixture records or media');
  if (journal.dataImport !== 'none') throw new Error('Sample/media import is not authorized by conversion');
  for (const predecessor of PHASES.slice(0, PHASES.indexOf(phase))) {
    if (!journal.completed.includes(predecessor)) throw new Error(`Conversion must finish ${predecessor} before ${phase}`);
  }
  const inputs = (dependencies.loadInputs || conversionInputs)(root, context);
  if (journal.canonicalSchemaRevision && journal.canonicalSchemaRevision !== revision(inputs.schema)) {
    throw new Error('The approved canonical schema changed; retain remote evidence and reopen conversion approval');
  }
  journal.canonicalSchemaRevision = revision(inputs.schema);
  const environmentBinding = revision({
    environmentId: context.environmentId, environmentUrl: context.environmentUrl, tenantId: context.tenantId,
    solutionUniqueName: context.solutionUniqueName, publisherPrefix: context.publisherPrefix,
  });
  if (journal.environmentBinding && journal.environmentBinding !== environmentBinding) {
    throw new Error('Conversion environment/solution changed; preserve remote evidence and explicitly reapprove a successor');
  }
  journal.environmentBinding = environmentBinding;
  if (journal.completed.includes(phase)) return { ok: true, skipped: phase, journal };
  if (phase === 'metadata' && journal.inFlight?.phase === 'metadata'
    && journal.inFlight.reconciliationRevision === inputs.reconciliationRevision) {
    throw new Error('Interrupted remote execution requires a fresh bounded reconciliation and rebuilt manifest before retry');
  }
  journal.inFlight = { phase, reconciliationRevision: inputs.reconciliationRevision, manifestHash: inputs.manifest.integritySha256 };
  journal.state = 'working';
  if (phase === 'metadata') journal.remoteEffectsPossible = true;
  atomicWrite(root, JOURNAL, journal);
  try {
    let result;
    if (phase === 'metadata') {
      result = await (dependencies.executeManifest || executeManifest)({
        projectRoot: root,
        manifest: inputs.manifest, environmentUrl: context.environmentUrl, tenantId: context.tenantId,
        solution: context.solutionUniqueName,
        journalPath: inside(root, '.tmp/prototype-dataverse-remote-journal.json'),
        publishCheckpointPath: inside(root, '.tmp/dataverse-publish-pending.json'),
      });
    } else if (phase === 'services') {
      result = await (dependencies.generateServices || generateDataverseServices)({
        projectRoot: root, manifest: inputs.manifest, environmentUrl: context.environmentUrl,
        tenantId: context.tenantId, solution: context.solutionUniqueName,
      });
    } else if (phase === 'schemas') {
      const run = dependencies.runCommand || ((command, args, options) => spawnSync(command, args, { ...options, encoding: 'utf8' }));
      const outcome = run('npm', ['run', 'generate-schemas'], { cwd: root });
      if (outcome.error || outcome.status !== 0) throw new Error('Official schema generation failed; retain its safe output for diagnosis');
      if (!fs.existsSync(inside(root, 'src/generated/connectorSchemas.ts'))) throw new Error('Official connectorSchemas output is missing');
      result = { ok: true };
    } else if (phase === 'adapters') {
      result = (dependencies.generateAdapters || generateDataverseRepositories)(root);
    } else result = (dependencies.stageStartup || stageConnectedStartup)(root);
    if (!result?.ok) throw new Error(`Conversion ${phase} did not report completion`);
    journal.completed.push(phase);
    journal.inFlight = null;
    journal.state = phase === 'startup' ? 'candidate-ready-for-validation' : 'working';
    atomicWrite(root, JOURNAL, journal);
    return { ok: true, phase, journal };
  } catch (error) {
    journal.state = 'interrupted';
    journal.failures.push({ phase, code: 'phase-failed' });
    atomicWrite(root, JOURNAL, journal);
    throw error;
  }
}

module.exports = { JOURNAL, PHASES, beginConversion, conversionInputs, runConversionPhase };
