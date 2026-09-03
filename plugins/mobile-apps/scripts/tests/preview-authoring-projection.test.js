'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildPreviewAuthoringProjection } = require('../lib/final-preview-authoring-projection');
const { canonicalJson, sha256Hex } = require('../lib/product-experience-contracts');
const { buildFinalPreviewContract } = require('../validate-product-experience-preview');
const { runVariant } = require('./helpers/run-live-build-plan-acceptance');

test('model-facing preview projection is compact and contains only authoring authority', () => {
  const run = runVariant({ id: 'projection-icrc', scenario: 'icrcReceiving', mode: 'dataverse' });
  const tokenContract = {
    ok: true,
    revision: 'a'.repeat(64),
    colors: {
      bg: '#f5f5f5', surface: '#ffffff', primary: '#202020', accent: '#d30b18',
      text: '#171717', textMuted: '#666666', border: '#dddddd',
      statusSuccess: '#287a4b', statusWarning: '#9c6500', statusDanger: '#b42318',
      statusInfo: '#176b87',
    },
    typography: { family: 'Test Sans', size: 22, weight: 700, lineHeight: 1.2, tracking: 0 },
  };
  const contract = buildFinalPreviewContract({
    experience: run.artifacts.bundle.experience,
    scope: run.artifacts.bundle.scope,
    journey: run.artifacts.bundle.journey,
    compiled: run.artifacts.compiled,
    scenario: run.artifacts.scenario,
    navigation: run.artifacts.navigation,
    tokenContract,
    signatureComponentsSource: 'export interface ReceivingSignatureProps { ready: boolean; }\n',
  });
  const projection = buildPreviewAuthoringProjection(contract);
  assert.deepEqual(Object.keys(projection).sort(), [
    'contractType',
    'experienceDirective',
    'finalContractRevision',
    'generatedTokens',
    'navigationShell',
    'prohibitedDefaults',
    'projectionRevision',
    'review',
    'schemaVersion',
    'screenSpecifications',
    'selectedScreenIds',
    'selectionRationale',
    'signatureComponentContracts',
  ]);
  assert.deepEqual(projection.selectedScreenIds, ['receiving', 'inspection', 'evidence']);
  assert.deepEqual(
    projection.selectionRationale.map((entry) => entry.role),
    ['primary-destination', 'flow-entry', 'strongest-decision'],
  );
  assert.ok(projection.screenSpecifications.every(
    (screen) => screen.scenarioValues.length > 0 && screen.firstViewport,
  ));
  const revisionContent = structuredClone(projection);
  delete revisionContent.projectionRevision;
  assert.equal(projection.projectionRevision, sha256Hex(canonicalJson(revisionContent)));
  assert.ok(
    Buffer.byteLength(JSON.stringify(projection)) < Buffer.byteLength(JSON.stringify(contract)),
    'authoring projection must be smaller than the full validator contract',
  );
  for (const forbidden of ['compiled', 'journey', 'scope', 'scenario', 'sharedDesignInputs']) {
    assert.equal(Object.prototype.hasOwnProperty.call(projection, forbidden), false);
  }
});