'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { beginConversion, runConversionPhase, JOURNAL } = require('../lib/prototype-conversion');
const { revision } = require('../lib/prototype-files');

function project(t) {
  const root = path.join(path.resolve(__dirname, '../../../..'), `.prototype-conversion-work-${crypto.randomUUID()}`);
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value));
  write('.tmp/prototype-profile.json', { profile: 'prototype', appInstanceId: 'prototype-one' });
  write('.tmp/prototype-domain.json', { appInstanceId: 'prototype-one', entities: [], actions: [] });
  write('.tmp/prototype-rules.json', { schemaVersion: 1, rules: [] });
  write('.tmp/prototype-bindings.json', { schemaVersion: 1, entities: [] });
  write('.tmp/scenario-facts.json', { records: [], relationships: [], mediaAssets: [] });
  write('.tmp/dataverse-schema-contract.json', { schemaVersion: 1, tables: [] });
  beginConversion(root, { captureSource: () => ({ revision: 'a'.repeat(64), files: [] }), verifyPrototype: () => ({ ok: true }) });
  return { root, write, read: () => JSON.parse(fs.readFileSync(path.join(root, JOURNAL))) };
}

test('conversion journal starts local with no data import and only uses shared source capture', (t) => {
  const { root, read } = project(t);
  assert.equal(read().baseRevision, 'a'.repeat(64));
  assert.equal(read().activeProfile, 'prototype');
  assert.equal(read().dataImport, 'none');
  assert.deepEqual(beginConversion(root), read());
});

test('metadata interruption requires fresh reconciliation, preserves remote evidence, and resumes sequentially', async (t) => {
  const { root, read } = project(t);
  const schemaBefore = fs.readFileSync(path.join(root, '.tmp/dataverse-schema-contract.json'));
  let reconciliationRevision = 'initial';
  let attempts = 0;
  const dependencies = {
    loadInputs: () => ({ schema: JSON.parse(schemaBefore), manifest: { integritySha256: 'manifest' }, reconciliationRevision }),
    executeManifest: async ({ journalPath }) => {
      attempts += 1;
      fs.writeFileSync(journalPath, 'remote-evidence');
      if (attempts === 1) throw new Error('interrupted metadata');
      return { ok: true };
    },
    generateServices: () => ({ ok: true }),
  };
  await assert.rejects(runConversionPhase(root, 'metadata', {}, dependencies), /interrupted metadata/);
  assert.equal(read().activeProfile, 'prototype');
  assert.equal(read().remoteEffectsPossible, true);
  await assert.rejects(runConversionPhase(root, 'metadata', {}, dependencies), /fresh bounded reconciliation/);
  assert.equal(attempts, 1);
  reconciliationRevision = 'fresh-verified';
  await runConversionPhase(root, 'metadata', {}, dependencies);
  assert.equal(attempts, 2);
  await runConversionPhase(root, 'services', {}, dependencies);
  assert.deepEqual(read().completed, ['metadata', 'services']);
  assert.equal(fs.readFileSync(path.join(root, '.tmp/prototype-dataverse-remote-journal.json'), 'utf8'), 'remote-evidence');
  assert.deepEqual(fs.readFileSync(path.join(root, '.tmp/dataverse-schema-contract.json')), schemaBefore);
});

test('conversion cannot skip phases, import samples, or silently change domain/rules', async (t) => {
  const { root, read, write } = project(t);
  const dependencies = { loadInputs: () => ({ schema: {}, manifest: {}, reconciliationRevision: 'r' }) };
  await assert.rejects(runConversionPhase(root, 'services', {}, dependencies), /finish metadata/);
  const journal = read();
  journal.dataImport = 'all-samples';
  write(JOURNAL, journal);
  await assert.rejects(runConversionPhase(root, 'metadata', {}, dependencies), /not authorized/);
  journal.dataImport = 'none';
  write(JOURNAL, journal);
  write('.tmp/prototype-rules.json', { schemaVersion: 1, rules: [{ id: 'new-rule' }] });
  await assert.rejects(runConversionPhase(root, 'metadata', {}, dependencies), /domain\/rules changed/);
  assert.equal(read().domainRevision, revision({ appInstanceId: 'prototype-one', entities: [], actions: [] }));
});

test('service phase awaits broker completion and keeps remote evidence on async failure', async (t) => {
  const { root, read } = project(t);
  const dependencies = {
    loadInputs: () => ({ schema: { schemaVersion: 1, tables: [] }, manifest: {}, reconciliationRevision: 'current' }),
    executeManifest: async ({ journalPath }) => {
      fs.writeFileSync(journalPath, 'retained remote evidence');
      return { ok: true };
    },
  };
  await runConversionPhase(root, 'metadata', {}, dependencies);
  let reject;
  const pending = runConversionPhase(root, 'services', {}, {
    ...dependencies, generateServices: () => new Promise((_resolve, fail) => { reject = fail; }),
  });
  assert.deepEqual(read().completed, ['metadata']);
  reject(new Error('broker generation interrupted'));
  await assert.rejects(pending, /broker generation interrupted/);
  assert.deepEqual(read().completed, ['metadata']);
  assert.equal(read().state, 'interrupted');
  assert.equal(fs.readFileSync(path.join(root, '.tmp/prototype-dataverse-remote-journal.json'), 'utf8'), 'retained remote evidence');
  await runConversionPhase(root, 'services', {}, { ...dependencies, generateServices: async () => ({ ok: true }) });
  assert.deepEqual(read().completed, ['metadata', 'services']);
});

test('every local conversion phase resumes without replaying completed metadata and never edits canonical schema', async (t) => {
  const { root, read } = project(t);
  const calls = [];
  let fail = 'services';
  const action = (phase) => {
    calls.push(phase);
    if (fail === phase) throw new Error(`interrupted ${phase}`);
    return { ok: true };
  };
  const dependencies = {
    loadInputs: () => ({ schema: { schemaVersion: 1, tables: [] }, manifest: {}, reconciliationRevision: 'current' }),
    executeManifest: async () => action('metadata'),
    generateServices: () => action('services'),
    runCommand: (command, args) => {
      assert.equal(command, 'npm');
      assert.deepEqual(args, ['run', 'generate-schemas']);
      action('schemas');
      fs.mkdirSync(path.join(root, 'src/generated'), { recursive: true });
      fs.writeFileSync(path.join(root, 'src/generated/connectorSchemas.ts'), '// official-command fixture output\n');
      return { status: 0 };
    },
    generateAdapters: () => action('adapters'),
    stageStartup: () => action('startup'),
  };
  const context = { environmentId: 'approved-environment', solutionUniqueName: 'approved-solution' };
  await runConversionPhase(root, 'metadata', context, dependencies);
  for (const phase of ['services', 'schemas', 'adapters', 'startup']) {
    fail = phase;
    await assert.rejects(runConversionPhase(root, phase, context, dependencies), new RegExp(`interrupted ${phase}`));
    assert.equal(read().inFlight.phase, phase);
    assert.equal(read().activeProfile, 'prototype');
    fail = null;
    await runConversionPhase(root, phase, context, dependencies);
    await runConversionPhase(root, phase, context, dependencies);
  }
  assert.equal(calls.filter((phase) => phase === 'metadata').length, 1);
  assert.deepEqual(read().completed, ['metadata', 'services', 'schemas', 'adapters', 'startup']);
  assert.equal(read().state, 'candidate-ready-for-validation');
  assert.equal(read().dataImport, 'none');
  await assert.rejects(runConversionPhase(root, 'startup', { ...context, environmentId: 'unapproved-other' }, dependencies), /environment\/solution changed/);
});
