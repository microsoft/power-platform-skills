'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { parseEnvelope } = require('../parse-dataverse-model-proposal-envelope');

const RUN_ID = 'run-42';
const proposal = {
  schemaVersion: 1,
  contractType: 'dataverse-model-proposal',
  publisherPrefix: 'new',
  tables: [{
    conceptId: 'asset',
    logicalName: 'new_asset',
    displayName: 'Asset',
    displayCollectionName: 'Assets',
    decision: 'create',
    dependencyTier: 0,
    serviceRequired: true,
    ownershipType: 'UserOwned',
    reason: 'Assets have an independent application-owned lifecycle.',
    columns: [{
      logicalName: 'new_name',
      displayName: 'Asset name',
      type: 'string',
      primaryName: true,
      required: true,
    }],
    relationships: [],
    alternateKeys: [],
  }],
  readPaths: [],
  risks: [],
};

function envelope({
  runId = RUN_ID,
  status = 'DONE',
  concerns = [],
  content = proposal,
  prefix = '',
  suffix = '',
} = {}) {
  return `${prefix}<<<MOBILE_DATAVERSE_PROPOSAL:${runId}:BEGIN>>>
STATUS: ${status}
CONCERNS: ${JSON.stringify(concerns)}
<<<MOBILE_DATAVERSE_PROPOSAL_CONTENT:${runId}:BEGIN>>>
${JSON.stringify(content, null, 2)}
<<<MOBILE_DATAVERSE_PROPOSAL_CONTENT:${runId}:END>>>
<<<MOBILE_DATAVERSE_PROPOSAL:${runId}:END>>>${suffix}`;
}

test('parses exactly one schema-valid run-scoped proposal', () => {
  assert.deepEqual(parseEnvelope(`${envelope()}\n`, RUN_ID), {
    status: 'DONE',
    concerns: [],
    proposal,
  });
});

test('rejects mismatched IDs, outside prose, duplicate blocks, and invalid proposals', () => {
  assert.throws(() => parseEnvelope(envelope({ runId: 'other' }), RUN_ID), /mismatched run ID/);
  assert.throws(() => parseEnvelope(envelope({ prefix: 'Here is the proposal:\n' }), RUN_ID), /outside/);
  assert.throws(() => parseEnvelope(envelope({ suffix: '\nextra' }), RUN_ID), /outside/);
  const duplicate = envelope().replace(
    `<<<MOBILE_DATAVERSE_PROPOSAL_CONTENT:${RUN_ID}:END>>>`,
    `<<<MOBILE_DATAVERSE_PROPOSAL_CONTENT:${RUN_ID}:END>>>\n<<<MOBILE_DATAVERSE_PROPOSAL_CONTENT:${RUN_ID}:BEGIN>>>`,
  );
  assert.throws(() => parseEnvelope(duplicate, RUN_ID), /exactly one/);
  assert.throws(() => parseEnvelope(envelope({ content: { schemaVersion: 1 } }), RUN_ID), /proposal content is invalid/);
});

test('requires concerns to agree with success status', () => {
  assert.throws(() => parseEnvelope(envelope({ concerns: ['deferred'] }), RUN_ID), /DONE requires/);
  assert.throws(() => parseEnvelope(envelope({
    status: 'DONE_WITH_CONCERNS',
  }), RUN_ID), /requires at least one concern/);
  assert.throws(() => parseEnvelope(envelope({
    status: 'DONE_WITH_CONCERNS',
    concerns: ['One table is deferred.'],
  }), RUN_ID), /only valid when the proposal contains adapt or defer/);

  const deferredProposal = structuredClone(proposal);
  deferredProposal.tables[0].decision = 'defer';
  assert.throws(
    () => parseEnvelope(envelope({ content: deferredProposal }), RUN_ID),
    /requires DONE_WITH_CONCERNS/,
  );
  assert.equal(parseEnvelope(envelope({
    status: 'DONE_WITH_CONCERNS',
    concerns: ['The asset table is deferred.'],
    content: deferredProposal,
  }), RUN_ID).status, 'DONE_WITH_CONCERNS');
});

test('parses bounded NEEDS_CONTEXT without accepting a content block', () => {
  const response = [
    `<<<MOBILE_DATAVERSE_PROPOSAL:${RUN_ID}:BEGIN>>>`,
    'STATUS: NEEDS_CONTEXT',
    'DETAIL: detailed-dataverse-metadata:new_asset,new_site',
    'CONCERNS: []',
    `<<<MOBILE_DATAVERSE_PROPOSAL:${RUN_ID}:END>>>`,
  ].join('\n');
  assert.deepEqual(parseEnvelope(response, RUN_ID), {
    status: 'NEEDS_CONTEXT',
    concerns: [],
    detail: 'detailed-dataverse-metadata:new_asset,new_site',
  });
  assert.throws(() => parseEnvelope(envelope({ status: 'NEEDS_CONTEXT' }), RUN_ID), /must not contain/);
});