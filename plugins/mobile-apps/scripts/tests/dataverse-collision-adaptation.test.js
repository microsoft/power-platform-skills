'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  collisionAdaptationContext,
  probeCollisionAdaptation,
} = require('../resolve-dataverse-collision-adaptation');
const {
  sha256,
  stableJson,
} = require('../build-dataverse-operation-manifest');
const {
  operationFingerprint,
} = require('../dataverse-request');

function withIntegrity(value) {
  const result = { ...value };
  result.integritySha256 = sha256(stableJson(result));
  return result;
}

function fixture({ effectiveName = 'cr1_item' } = {}) {
  const approvalReceipt = withIntegrity({
    schemaVersion: 2,
    adaptationPolicy: {
      schemaVersion: 1,
      automaticTechnicalRename: true,
      semanticChangesRequireApproval: true,
      allowedCollisionCodes: ['0x80044363'],
      alternativeSuffixes: ['v2', 'v3', '2', 'copy'],
      maxAttempts: 4,
    },
  });
  const operation = {
    id: `create-table:${effectiveName}`,
    index: 0,
    phase: 'tableCreates',
    method: 'POST',
    apiPath: 'EntityDefinitions',
    body: { SchemaName: effectiveName },
  };
  const manifest = withIntegrity({
    schemaVersion: 2,
    binding: {
      environmentUrl: 'https://example.crm.dynamics.com',
      solutionUniqueName: 'Default',
      approvalReceiptSha256: approvalReceipt.integritySha256,
    },
    decisions: [{
      itemType: 'table',
      requestedName: 'cr1_item',
      effectiveName,
      operation: operation.id,
    }],
    execution: {
      phases: [{ name: 'tableCreates', operations: [operation] }],
    },
  });
  const collisionEvidence = {
    code: '0x80044363',
    operationId: operation.id,
    operationFingerprint: operationFingerprint(operation, 'Default'),
    priorManifestSha256: manifest.integritySha256,
    priorReconciliationSha256: 'b'.repeat(64),
    observedAt: '2026-08-29T00:00:00.000Z',
  };
  const journal = {
    inFlight: {
      operationId: collisionEvidence.operationId,
      fingerprint: collisionEvidence.operationFingerprint,
      manifestHash: collisionEvidence.priorManifestSha256,
      reconciliationHash: collisionEvidence.priorReconciliationSha256,
      failure: {
        collision: true,
        collisionCode: collisionEvidence.code,
        recordedAt: collisionEvidence.observedAt,
      },
    },
  };
  return {
    approvalReceipt,
    manifest,
    journal,
    executionOutcome: {
      status: 'COLLISION_ADAPTATION_REQUIRED',
      reasonCode: 'HIDDEN_SCHEMA_NAME_COLLISION',
      collisionEvidence,
    },
  };
}

test('collision selector chooses the first absent approved suffix', async () => {
  const input = fixture();
  let requestedPath = null;
  const result = await probeCollisionAdaptation({
    ...input,
    request: async (method, apiPath) => {
      assert.equal(method, 'GET');
      requestedPath = apiPath;
      return {
        status: 200,
        data: { value: [{ LogicalName: 'cr1_item_v2' }] },
      };
    },
    nowIso: () => '2026-08-29T00:01:00.000Z',
  });
  assert.match(requestedPath, /cr1_item_v2/);
  assert.match(requestedPath, /cr1_item_copy/);
  assert.equal(result.status, 'ADAPTATION_CANDIDATE_READY');
  assert.equal(result.adaptation.adaptedLogicalName, 'cr1_item_v3');
  assert.equal(result.adaptation.adaptationKind, 'hidden-name-collision');
  assert.deepEqual(result.adaptation.collisionEvidence,
    input.executionOutcome.collisionEvidence);
  const withoutIntegrity = { ...result };
  delete withoutIntegrity.integritySha256;
  assert.equal(result.integritySha256, sha256(stableJson(withoutIntegrity)));
});

test('collision selector never retries an already-collided suffix', async () => {
  const input = fixture({ effectiveName: 'cr1_item_v2' });
  const result = await probeCollisionAdaptation({
    ...input,
    request: async (_method, apiPath) => {
      assert.doesNotMatch(apiPath, /LogicalName eq 'cr1_item_v2'/);
      return { status: 200, data: { value: [] } };
    },
  });
  assert.equal(result.adaptation.adaptedLogicalName, 'cr1_item_v3');
  assert.equal(result.adaptation.attempt, 2);
});

test('collision selector fails closed on tampered evidence and exhausted names', async () => {
  const tampered = fixture();
  tampered.executionOutcome.collisionEvidence.observedAt = '2026-08-30T00:00:00.000Z';
  assert.throws(
    () => collisionAdaptationContext(tampered),
    /does not match the mutation journal/,
  );

  const input = fixture();
  const result = await probeCollisionAdaptation({
    ...input,
    request: async () => ({
      status: 200,
      data: {
        value: ['v2', 'v3', '2', 'copy'].map((suffix) => ({
          LogicalName: `cr1_item_${suffix}`,
        })),
      },
    }),
  });
  assert.equal(result.status, 'COLLISION_SEQUENCE_EXHAUSTED');
  assert.equal(result.adaptation, null);
});

test('add-dataverse delegates suffix selection to the deterministic helper', () => {
  const skill = fs.readFileSync(path.resolve(
    __dirname,
    '../../skills/add-dataverse/SKILL.md',
  ), 'utf8');
  assert.match(skill, /resolve-dataverse-collision-adaptation\.js/);
  assert.match(skill, /--journal "\$EXECUTION_JOURNAL"/);
  assert.match(skill, /ADAPTATION_CANDIDATE_READY/);
  assert.match(skill, /COLLISION_SEQUENCE_EXHAUSTED/);
  assert.match(skill, /return `NEEDS_APPROVAL`/);
});