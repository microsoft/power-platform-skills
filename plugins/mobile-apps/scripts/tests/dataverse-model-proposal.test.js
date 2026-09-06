'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  compileProposal,
  renderDataModelSection,
} = require('../compile-dataverse-model-proposal');
const {
  buildArchitectEvidence,
  sha256,
} = require('../render-dataverse-architect-evidence');

function snapshot() {
  const table = {
    logicalName: 'new_asset',
    schemaName: 'new_asset',
    displayName: 'Asset',
    displayCollectionName: 'Assets',
    entitySetName: 'new_assets',
    primaryIdAttribute: 'new_assetid',
    primaryNameAttribute: 'new_name',
    ownershipType: 'UserOwned',
    hasActivities: false,
    hasNotes: false,
    isAvailableOffline: true,
    changeTrackingEnabled: true,
    customEntity: true,
    managed: false,
    customizable: true,
    canCreateAttributes: true,
    canBePrimaryEntityInRelationship: true,
    canBeRelatedEntityInRelationship: true,
    canBeInManyToMany: true,
    detailLevel: 'full',
    missingDetailClasses: [],
    columns: [{
      logicalName: 'new_name',
      schemaName: 'new_name',
      type: 'String',
      typeName: 'StringType',
      maxLength: 120,
      format: 'Text',
      formatName: 'Text',
      requiredLevel: 'ApplicationRequired',
      customAttribute: true,
      managed: false,
      customizable: true,
      primaryId: false,
      primaryName: true,
      validForCreate: true,
      validForRead: true,
      validForUpdate: true,
      sourceType: 0,
      sourceTypeMask: null,
      attributeOf: null,
      logical: false,
      lookupTargets: [],
      choices: [],
      formulaDefinition: null,
    }],
    manyToOneRelationships: [],
    oneToManyRelationships: [],
    manyToManyRelationships: [],
    alternateKeys: [],
    facts: { columnCount: 1, relationshipCount: 0, keyCount: 0 },
  };
  return {
    version: 3,
    purpose: 'foreground-planning',
    environmentUrl: 'https://example.crm.dynamics.com',
    tenantId: 'tenant-1',
    generatedAt: '2026-09-04T00:00:00.000Z',
    inputs: { concepts: [], explicitTableNames: [], proposedTableNames: ['new_service'] },
    inventory: [{ logicalName: 'new_asset', customizable: true }],
    inventoryFacts: {
      customizableTables: 1,
      exactNameTables: 0,
      requiredExactNameTables: 0,
      proposedCollisionTables: 0,
      totalTables: 1,
    },
    candidateRanking: [{
      concept: 'assets',
      conceptKind: 'entity',
      discoverTable: true,
      skippedReason: null,
      preferredPublisherFamily: 'new',
      candidates: [{
        logicalName: 'new_asset',
        displayName: 'Asset',
        rank: 1,
        score: 999,
        matchClass: 'exact',
        publisherFamily: 'new',
        versioned: false,
        detailStatus: 'loaded',
        detailLevel: 'full',
        selectionEvidence: ['concept:assets:primary'],
        reasons: ['exact:asset'],
      }],
    }],
    selectedCandidateEvidence: [{
      logicalName: 'new_asset',
      reasons: ['concept:assets:primary'],
      detailLevel: 'full',
      required: false,
      detailStatus: 'loaded',
      detailFailure: null,
    }],
    tables: [table],
    detailLoadFailures: [],
    detailLoadSummary: {
      attemptedCandidates: 1,
      loadedCandidates: 1,
      failedCandidates: 0,
    },
    proposedNameChecks: {
      checked: [{ logicalName: 'new_service', status: 'missing', existing: null }],
      collisions: [],
      missing: ['new_service'],
    },
    exactNameResolution: { requestedTables: [], loadedTables: [], unavailableTables: [] },
    timings: { inventoryRetrievalMs: 1, candidateSelectionMs: 1, detailLoadingMs: 1, totalDurationMs: 3 },
  };
}

function proposal() {
  return {
    schemaVersion: 1,
    contractType: 'dataverse-model-proposal',
    publisherPrefix: 'new',
    tables: [{
      conceptId: 'asset',
      logicalName: 'new_asset',
      displayName: 'Asset',
      displayCollectionName: 'Assets',
      decision: 'extend',
      dependencyTier: 0,
      serviceRequired: true,
      reason: 'The existing Asset table is authoritative and needs one additive business code.',
      columns: [{
        logicalName: 'new_name',
        displayName: 'Asset name',
        type: 'string',
        primaryName: true,
        required: true,
      }, {
        logicalName: 'new_code',
        displayName: 'Asset code',
        type: 'string',
        required: true,
      }],
      relationships: [],
      alternateKeys: [{
        schemaName: 'new_asset_code_key',
        displayName: 'Asset code key',
        decision: 'create',
        columns: ['new_code'],
      }],
    }, {
      conceptId: 'service-record',
      logicalName: 'new_service',
      displayName: 'Service Record',
      displayCollectionName: 'Service Records',
      decision: 'create',
      dependencyTier: 1,
      serviceRequired: true,
      reason: 'Each completed service event has an independent auditable lifecycle.',
      columns: [{
        logicalName: 'new_name',
        displayName: 'Service record',
        type: 'string',
        primaryName: true,
        required: true,
      }, {
        logicalName: 'new_assetid',
        displayName: 'Asset',
        type: 'lookup',
        lookupTarget: 'new_asset',
        required: true,
      }],
      relationships: [{
        kind: 'many-to-one',
        schemaName: 'new_asset_service',
        decision: 'create',
        parentTable: 'new_asset',
        childTable: 'new_service',
        lookupColumn: 'new_assetid',
        lookupDisplayName: 'Asset',
        deleteBehavior: 'Restrict',
      }],
      alternateKeys: [],
    }],
    readPaths: [{
      jobId: 'review-service',
      path: 'Asset -> Service Records',
      strategy: 'bounded-chained-fetch',
      note: 'Fetch service records once for the active asset detail.',
    }],
    risks: ['Existing Asset rows need a business code before the alternate key can become useful.'],
  };
}

function evidence() {
  const source = snapshot();
  return buildArchitectEvidence(source, sha256(`${JSON.stringify(source, null, 2)}\n`));
}

test('compact proposal expands reused constraints and new-column defaults', () => {
  const contract = compileProposal(proposal(), evidence());
  const asset = contract.tables.find((table) => table.logicalName === 'new_asset');
  const service = contract.tables.find((table) => table.logicalName === 'new_service');
  const name = asset.columns.find((column) => column.logicalName === 'new_name');
  const code = asset.columns.find((column) => column.logicalName === 'new_code');

  assert.equal(asset.plannedDecision, 'extend');
  assert.equal(name.plannedDecision, 'reuse');
  assert.equal(name.maxLength, 120);
  assert.equal(code.plannedDecision, 'create');
  assert.equal(code.maxLength, 200);
  assert.equal(service.columns.find((column) => column.logicalName === 'new_assetid').plannedDecision, 'create');
  assert.equal(service.relationships[0].lookup.logicalName, 'new_assetid');
  assert.equal(service.relationships[0].deleteBehavior, 'Restrict');
});

test('data-model rendering is deterministic and product-specific', () => {
  const sourceProposal = proposal();
  const sourceEvidence = evidence();
  const contract = compileProposal(sourceProposal, sourceEvidence);
  const first = renderDataModelSection(sourceProposal, contract, sourceEvidence);
  const second = renderDataModelSection(sourceProposal, contract, sourceEvidence);

  assert.equal(first, second);
  assert.match(first, /^## Data Model/m);
  assert.match(first, /new_asset \|\|--o\{ new_service : "Asset"/);
  assert.match(first, /bounded-chained-fetch/);
  assert.match(first, /Existing Asset rows need a business code/);
});

test('incompatible existing column types require an explicit proposal correction', () => {
  const sourceProposal = proposal();
  sourceProposal.tables[0].columns[0].type = 'integer';
  assert.throws(
    () => compileProposal(sourceProposal, evidence()),
    /expects integer, but target metadata is string/,
  );
});

test('CLI writes deterministic artifacts and check mode rejects drift', (context) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dataverse-proposal-'));
  context.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const temporaryDirectory = path.join(projectRoot, '.tmp');
  fs.mkdirSync(temporaryDirectory, { recursive: true });
  const source = snapshot();
  const sourceBytes = `${JSON.stringify(source, null, 2)}\n`;
  fs.writeFileSync(path.join(temporaryDirectory, 'dataverse-foreground-planning-snapshot.json'), sourceBytes);
  fs.writeFileSync(
    path.join(temporaryDirectory, 'dataverse-architect-evidence.json'),
    `${JSON.stringify(buildArchitectEvidence(source, sha256(sourceBytes)), null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(temporaryDirectory, 'dataverse-model-proposal.json'),
    `${JSON.stringify(proposal(), null, 2)}\n`,
  );
  const script = path.resolve(__dirname, '..', 'compile-dataverse-model-proposal.js');
  const run = (extra = []) => spawnSync(
    process.execPath,
    [script, '--project-root', projectRoot, ...extra],
    { encoding: 'utf8' },
  );

  assert.equal(run().status, 0);
  assert.equal(run(['--check']).status, 0);
  fs.appendFileSync(path.join(projectRoot, '_dm_section.md'), '\nchanged');
  const stale = run(['--check']);
  assert.equal(stale.status, 2);
  assert.match(stale.stderr, /compiled Dataverse artifacts are stale/);
});