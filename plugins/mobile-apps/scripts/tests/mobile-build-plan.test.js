'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  deriveBuildPlanModel,
  revisionOf,
  updateProgress,
  writeBuildPlan,
} = require('../lib/mobile-build-plan');
const { applyDataModelEdit } = require('../lib/mobile-build-plan-edits');
const { cleanup } = require('./helpers/contract-cli');
const { bundleFor } = require('./helpers/product-experience-scenarios');

function makeProjectDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
}

function writeJson(projectRoot, relativePath, value) {
  const file = path.join(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

test('Build Plan composes progress and canonical planning artifacts', () => {
  const projectRoot = makeProjectDir('mobile-build-plan');
  try {
    writeJson(projectRoot, '.tmp/product-experience-contract.json', {
      productName: 'Field North',
      operatingContext: { environment: 'field' },
      promptEvidence: {
        target: [{
          text: 'Tenant 22222222-3333-4444-5555-666666666666',
          source: 'user-prompt',
        }],
      },
    });
    writeJson(projectRoot, '.tmp/product-scope-contract.json', {
      jobs: [{ id: 'inspect', statement: 'Inspect assigned equipment' }],
    });
    writeJson(projectRoot, '.tmp/workflow-journey-contract.json', {
      journeys: [{
        id: 'inspect',
        name: 'Inspect tenant 44444444-5555-6666-7777-888888888888',
        steps: [{
          order: 1,
          label: 'Open https://contoso.crm.dynamics.com',
          userAction: 'Review the assignment',
        }],
      }],
    });
    writeJson(projectRoot, '.tmp/compiled-screen-build-pack.json', {
      screens: [{ screenId: 'assignments', title: 'Assignments', pack: { purpose: 'Choose the next inspection' } }],
    });
    writeJson(projectRoot, '.tmp/dataverse-schema-contract.json', {
      schemaVersion: 1,
      publisherPrefix: 'ct',
      tables: [{
        logicalName: 'ct_inspection',
        schemaName: 'ct_inspection',
        plannedDecision: 'create',
        dependencyTier: 0,
        columns: [{ logicalName: 'ct_name', schemaName: 'ct_name', type: 'string', plannedDecision: 'create', primaryName: true }],
        relationships: [],
        alternateKeys: [],
      }],
    });
    writeJson(projectRoot, '.tmp/dataverse-operation-manifest.json', {
      binding: {
        environmentUrl: 'https://contoso.crm.dynamics.com',
        tenantId: '11111111-2222-3333-4444-555555555555',
      },
      execution: { phases: { tableCreates: { operations: [{ id: 'create' }] } } },
      summary: { metadataOperationCount: 1 },
    });
    fs.writeFileSync(path.join(projectRoot, 'native-app-plan.md'), [
      '# Field North',
      '## App Requirements',
      'Use https://contoso.crm.dynamics.com in tenant 11111111-2222-3333-4444-555555555555.',
      '## Native Capabilities',
      '- Camera capture',
      '## Plan Provenance',
      '- Internal detail that must not reach the browser',
    ].join('\n'));

    const progress = updateProgress(projectRoot, {
      phase: 'data-model',
      status: 'active',
      detail: 'Preparing one table in 33333333-4444-5555-6666-777777777777',
    }, '2026-09-01T10:00:00.000Z');
    assert.strictEqual(progress.revision, 1);

    const model = deriveBuildPlanModel(projectRoot, { now: '2026-09-01T10:00:01.000Z' });
    assert.strictEqual(model.projectName, 'Field North');
    assert.strictEqual(model.progress.currentPhase, 'data-model');
    assert.strictEqual(model.tables[0].columns[0].logicalName, 'ct_name');
    assert.strictEqual(model.screens[0].screenId, 'assignments');
    assert.strictEqual(model.dataverse.operationCount, 1);
    assert.strictEqual(model.experience.promptEvidence, undefined);
    assert.doesNotMatch(JSON.stringify(model), /contoso\.crm|11111111-2222|Internal detail/);
    assert.doesNotMatch(JSON.stringify(model), /44444444-5555/);
    assert.match(model.journey.journeys[0].name, /\[identifier\]/);
    assert.match(model.journey.journeys[0].steps[0].label, /\[environment\]/);
    assert.match(model.planSections['App Requirements'], /\[environment\].*\[identifier\]/);

    const result = writeBuildPlan(projectRoot, { now: '2026-09-01T10:00:01.000Z' });
    const html = fs.readFileSync(result.output, 'utf8');
    assert.match(html, /Build Plan/);
    assert.match(html, /Field North/);
    assert.match(html, /Preparing one table in \[identifier\]/);
    assert.match(html, /ct_inspection/);
    assert.match(html, /ct_name/);
    assert.match(html, /Assignments/);
    assert.match(html, /role="tab"/);
    assert.match(html, /Content-Security-Policy/);
    assert.match(html, /id="edit-dialog"/);
    assert.match(html, /id="er-canvas"/);
    assert.match(html, /new EventSource/);
    assert.match(html, /data-add-table disabled/);
    assert.match(html, /data-edit-column="ct_name"/);
    assert.doesNotMatch(html, /<script[^>]+src=/);
    assert.doesNotMatch(html, /22222222-3333|33333333-4444/);
  } finally {
    cleanup(projectRoot);
  }
});

test('Build Plan rejects unknown progress phases and path escapes', () => {
  const projectRoot = makeProjectDir('mobile-build-plan-invalid');
  try {
    assert.throws(
      () => updateProgress(projectRoot, { phase: 'surprise', status: 'active' }),
      /Unknown build phase/,
    );
    assert.throws(
      () => writeBuildPlan(projectRoot, { output: '../outside.html' }),
      /escapes project root/,
    );
  } finally {
    cleanup(projectRoot);
  }
});

function minimalContract() {
  return {
    schemaVersion: 1,
    publisherPrefix: 'ct',
    tables: [
      {
        logicalName: 'ct_asset',
        schemaName: 'ct_asset',
        displayName: 'Asset',
        displayCollectionName: 'Assets',
        plannedDecision: 'create',
        dependencyTier: 0,
        serviceRequired: true,
        ownershipType: 'UserOwned',
        columns: [{
          logicalName: 'ct_name',
          schemaName: 'ct_name',
          displayName: 'Name',
          type: 'string',
          plannedDecision: 'create',
          requiredLevel: 'ApplicationRequired',
          primaryName: true,
        }],
        relationships: [],
        alternateKeys: [],
      },
      {
        logicalName: 'ct_site',
        schemaName: 'ct_site',
        displayName: 'Site',
        displayCollectionName: 'Sites',
        plannedDecision: 'create',
        dependencyTier: 0,
        serviceRequired: true,
        ownershipType: 'UserOwned',
        columns: [{
          logicalName: 'ct_name',
          schemaName: 'ct_name',
          displayName: 'Name',
          type: 'string',
          plannedDecision: 'create',
          requiredLevel: 'ApplicationRequired',
          primaryName: true,
        }],
        relationships: [],
        alternateKeys: [],
      },
    ],
  };
}

test('data-model edits validate, normalize, invalidate approvals, and clear stale state', () => {
  const projectRoot = makeProjectDir('mobile-build-plan-edit');
  try {
    const contract = minimalContract();
    writeJson(projectRoot, '.tmp/dataverse-schema-contract.json', contract);
    writeJson(projectRoot, '.tmp/mobile-plan-status.json', {
      schemaVersion: 1,
      workflow: 'create-mobile-app',
      approvals: {
        dataModel: { status: 'approved', approvedAt: '2026-09-01T09:00:00.000Z' },
        nativeCapabilities: { status: 'approved', approvedAt: '2026-09-01T09:00:00.000Z' },
        connectors: { status: 'approved', approvedAt: '2026-09-01T09:00:00.000Z' },
        screenPlan: { status: 'approved', approvedAt: '2026-09-01T09:00:00.000Z' },
      },
      integritySha256: 'stale',
    });
    writeJson(projectRoot, '.tmp/pipeline-state.json', {
      schemaVersion: 2,
      completedStep: '6.75',
    });
    writeJson(projectRoot, '.tmp/dataverse-operation-manifest.json', { stale: true });

    const result = applyDataModelEdit(projectRoot, {
      type: 'add-column',
      expectedRevision: revisionOf(contract),
      tableLogicalName: 'ct_asset',
      column: {
        logicalName: 'ct_serialnumber',
        schemaName: 'ct_serialnumber',
        displayName: 'Serial number',
        type: 'string',
        plannedDecision: 'create',
        requiredLevel: 'None',
        maxLength: 100,
      },
    }, '2026-09-01T10:00:00.000Z');

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.requiresReapproval, true);
    const edited = JSON.parse(fs.readFileSync(
      path.join(projectRoot, '.tmp/dataverse-schema-contract.json'),
      'utf8',
    ));
    assert.ok(edited.tables[0].columns.some(
      (column) => column.logicalName === 'ct_serialnumber',
    ));
    const receipt = JSON.parse(fs.readFileSync(
      path.join(projectRoot, '.tmp/mobile-plan-status.json'),
      'utf8',
    ));
    assert.strictEqual(receipt.approvals.dataModel.status, 'pending');
    assert.strictEqual(receipt.approvals.screenPlan.status, 'pending');
    assert.strictEqual(receipt.approvedContract, undefined);
    assert.match(receipt.integritySha256, /^[a-f0-9]{64}$/);
    assert.strictEqual(fs.existsSync(path.join(projectRoot, '.tmp/pipeline-state.json')), false);
    assert.strictEqual(
      fs.existsSync(path.join(projectRoot, '.tmp/dataverse-operation-manifest.json')),
      false,
    );
    assert.strictEqual(fs.existsSync(path.join(projectRoot, '_build_plan.html')), true);
  } finally {
    cleanup(projectRoot);
  }
});

test('many-to-one relationship edits create a matching lookup atomically', () => {
  const projectRoot = makeProjectDir('mobile-build-plan-relationship');
  try {
    const contract = minimalContract();
    writeJson(projectRoot, '.tmp/dataverse-schema-contract.json', contract);
    const result = applyDataModelEdit(projectRoot, {
      type: 'add-relationship',
      expectedRevision: revisionOf(contract),
      relationship: {
        kind: 'many-to-one',
        schemaName: 'ct_Site_Asset',
        plannedDecision: 'create',
        parentTable: 'ct_site',
        childTable: 'ct_asset',
        lookup: {
          logicalName: 'ct_siteid',
          schemaName: 'ct_siteid',
          displayName: 'Site',
          requiredLevel: 'None',
        },
      },
    });
    assert.strictEqual(result.ok, true);
    const edited = JSON.parse(fs.readFileSync(
      path.join(projectRoot, '.tmp/dataverse-schema-contract.json'),
      'utf8',
    ));
    const asset = edited.tables.find((table) => table.logicalName === 'ct_asset');
    assert.strictEqual(
      asset.columns.find((column) => column.logicalName === 'ct_siteid').type,
      'lookup',
    );
    assert.strictEqual(asset.relationships[0].lookup.logicalName, 'ct_siteid');
  } finally {
    cleanup(projectRoot);
  }
});

test('invalid and stale edits leave canonical artifacts unchanged', () => {
  const projectRoot = makeProjectDir('mobile-build-plan-rollback');
  try {
    const contract = minimalContract();
    writeJson(projectRoot, '.tmp/dataverse-schema-contract.json', contract);
    const file = path.join(projectRoot, '.tmp/dataverse-schema-contract.json');
    const before = fs.readFileSync(file, 'utf8');
    assert.throws(() => applyDataModelEdit(projectRoot, {
      type: 'add-column',
      expectedRevision: '0'.repeat(64),
      tableLogicalName: 'ct_asset',
      column: { logicalName: 'ct_code', type: 'string' },
    }), /changed since/);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), before);

    assert.throws(() => applyDataModelEdit(projectRoot, {
      type: 'add-column',
      expectedRevision: revisionOf(contract),
      tableLogicalName: 'ct_asset',
      column: { logicalName: 'ct_name', type: 'string' },
    }), /already exists/);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
    assert.strictEqual(
      fs.existsSync(path.join(projectRoot, '.tmp/mobile-build-plan-edits.json')),
      false,
    );

    writeJson(projectRoot, '.tmp/dataverse-foreground-planning-snapshot.json', {
      version: 0,
      tables: [],
    });
    assert.throws(() => applyDataModelEdit(projectRoot, {
      type: 'add-column',
      expectedRevision: revisionOf(contract),
      tableLogicalName: 'ct_asset',
      column: { logicalName: 'ct_code', type: 'string' },
    }), /needs refreshed Dataverse evidence/);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
  } finally {
    cleanup(projectRoot);
  }
});

test('data-model editing stops once Dataverse metadata execution has evidence', () => {
  const projectRoot = makeProjectDir('mobile-build-plan-executing');
  try {
    const contract = minimalContract();
    writeJson(projectRoot, '.tmp/dataverse-schema-contract.json', contract);
    writeJson(projectRoot, '.tmp/dataverse-metadata-execution-journal.json', {
      schemaVersion: 1,
      completed: {},
      inFlight: { operationId: 'table:create' },
    });
    assert.throws(() => applyDataModelEdit(projectRoot, {
      type: 'update-table',
      expectedRevision: revisionOf(contract),
      tableLogicalName: 'ct_asset',
      table: { displayName: 'Equipment' },
    }), /use \/edit-app/);
  } finally {
    cleanup(projectRoot);
  }
});

test('adding a table updates and validates its explicit Product Scope mapping', () => {
  const projectRoot = makeProjectDir('mobile-build-plan-table-scope');
  try {
    const bundle = bundleFor('inspection');
    const contract = minimalContract();
    writeJson(projectRoot, '.tmp/dataverse-schema-contract.json', contract);
    writeJson(projectRoot, '.tmp/product-experience-contract.json', bundle.experience);
    writeJson(projectRoot, '.tmp/product-scope-contract.json', bundle.scope);
    const jobId = bundle.scope.coreJobs[0].id;

    const result = applyDataModelEdit(projectRoot, {
      type: 'add-table',
      expectedRevision: revisionOf(contract),
      logicalName: 'ct_safetyobservation',
      table: {
        displayName: 'Safety observation',
        displayCollectionName: 'Safety observations',
        plannedDecision: 'create',
        dependencyTier: 1,
        serviceRequired: true,
        ownershipType: 'UserOwned',
      },
      primaryColumn: {
        logicalName: 'ct_name',
        displayName: 'Observation',
        type: 'string',
        plannedDecision: 'create',
        requiredLevel: 'ApplicationRequired',
        primaryName: true,
        maxLength: 200,
      },
      scope: {
        role: 'supporting',
        screenIds: [],
        jobIds: [jobId],
        lifecycleJustification: {
          reasons: ['independent-lifecycle'],
          statement: 'A safety observation remains actionable after its originating inspection.',
        },
      },
    });

    assert.strictEqual(result.ok, true);
    const scope = JSON.parse(fs.readFileSync(
      path.join(projectRoot, '.tmp/product-scope-contract.json'),
      'utf8',
    ));
    assert.ok(scope.newTables.some((table) => table.name === 'Safety observation'));
    assert.ok(scope.dataEntities.some((entity) => (
      entity.name === 'Safety observation' && entity.realization === 'new-table'
    )));
  } finally {
    cleanup(projectRoot);
  }
});