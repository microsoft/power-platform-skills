'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { canonicalJson, sha256Hex } = require('../lib/product-experience-contracts');
const {
  buildFinalPreviewContract,
  validateHtml,
} = require('../validate-product-experience-preview');
const { runVariant } = require('../run-live-build-plan-acceptance');
const {
  flightPreview,
  gymPreview,
  receivingPreview,
} = require('./fixtures/final-preview-model-outputs');

const TOKEN_FIXTURES = {
  flight: {
    colors: {
      bg: '#f4f7f6', surface: '#ffffff', primary: '#075d66', accent: '#d9efed',
      text: '#142523', textMuted: '#5d706d', border: '#cfdedb',
      statusSuccess: '#187a50', statusWarning: '#9a650d', statusDanger: '#b4232f', statusInfo: '#176b87',
    },
    typography: { family: 'Georgia', size: 24, weight: 700, lineHeight: 1.18, tracking: 0 },
  },
  gym: {
    colors: {
      bg: '#f4f6f2', surface: '#ffffff', primary: '#155f4d', accent: '#e5f3b5',
      text: '#17231f', textMuted: '#596b64', border: '#ced9d3',
      statusSuccess: '#207a4d', statusWarning: '#ad6500', statusDanger: '#bd2d27', statusInfo: '#276b78',
    },
    typography: { family: 'Avenir Next', size: 23, weight: 750, lineHeight: 1.2, tracking: 0.01 },
  },
  receiving: {
    colors: {
      bg: '#f6f6f4', surface: '#ffffff', primary: '#d30b18', accent: '#fde7e9',
      text: '#202020', textMuted: '#66645f', border: '#dedcd7',
      statusSuccess: '#2c7a45', statusWarning: '#b36a00', statusDanger: '#d30b18', statusInfo: '#476d89',
    },
    typography: { family: 'Helvetica Neue', size: 22, weight: 700, lineHeight: 1.2, tracking: 0 },
  },
};

function contractFor(run, tokenFixture) {
  const tokenContract = {
    ok: true,
    ready: true,
    source: 'supplied-model-output-fixture',
    revision: sha256Hex(canonicalJson(tokenFixture)),
    ...tokenFixture,
  };
  return buildFinalPreviewContract({
    experience: run.artifacts.bundle.experience,
    scope: run.artifacts.bundle.scope,
    journey: run.artifacts.bundle.journey,
    compiled: run.artifacts.compiled,
    scenario: run.artifacts.scenario,
    navigation: run.artifacts.navigation,
    tokenContract,
    signatureComponentsRevision: sha256Hex(`fixture:${run.domain}:signature-components`),
  });
}

test('supplied flight, gym, and receiving final previews validate with distinct compositions', () => {
  const cases = [
    {
      id: 'flight',
      definition: { id: 'fixture-flight', scenario: 'flightCommerce', mode: 'connector-only', offline: false },
      render: flightPreview,
      composition: 'editorial-merchandise-runway',
      evidence: [/Cabin collection/, /Seat-aware availability/],
    },
    {
      id: 'gym',
      definition: { id: 'fixture-gym', scenario: 'gymMaintenance', mode: 'mixed', offline: false },
      render: gymPreview,
      composition: 'equipment-command-surface',
      evidence: [/Equipment identity/, /Scan to record/, /Maintenance and safety/],
    },
    {
      id: 'receiving',
      definition: { id: 'fixture-receiving', scenario: 'icrcReceiving', mode: 'dataverse', offline: true },
      render: receivingPreview,
      composition: 'dense-receiving-ledger',
      evidence: [/Receiving queue/, /Shipment quantity/, /Inspection and handoff/],
    },
  ];

  const htmlById = {};
  for (const candidate of cases) {
    const run = runVariant(candidate.definition);
    const contract = contractFor(run, TOKEN_FIXTURES[candidate.id]);
    const html = candidate.render(contract);
    const validation = validateHtml(html, contract);
    assert.deepEqual(validation.errors, [], `${candidate.id}: ${JSON.stringify(validation.errors)}`);
    assert.match(html, new RegExp(`data-composition-id="${candidate.composition}"`));
    assert.deepEqual(
      contract.selectedScreenIds,
      run.storyboardScreenIds,
      `${candidate.id} changed semantic screen selection`,
    );
    assert.deepEqual(
      contract.requirements.map((requirement) => requirement.requirementId),
      run.artifacts.bundle.scope.requirements.map((requirement) => requirement.id),
      `${candidate.id} changed approved requirements`,
    );
    for (const evidence of candidate.evidence) assert.match(html, evidence);
    htmlById[candidate.id] = html;
  }

  assert.equal(new Set(Object.values(htmlById)).size, 3);
  assert.notEqual(
    htmlById.flight.match(/<main[\s\S]*<\/main>/)[0],
    htmlById.gym.match(/<main[\s\S]*<\/main>/)[0],
  );
  assert.notEqual(
    htmlById.gym.match(/<main[\s\S]*<\/main>/)[0],
    htmlById.receiving.match(/<main[\s\S]*<\/main>/)[0],
  );
});