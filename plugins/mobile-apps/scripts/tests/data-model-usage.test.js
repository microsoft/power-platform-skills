'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  compileDataModelUsage,
  validateDataModelUsage,
} = require('../validate-data-model-usage');
const { cleanup, makeProjectDir, runCli } = require('./helpers/contract-cli');

function writeJson(projectRoot, relativePath, value) {
  const file = path.join(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeCliContracts(projectRoot, source) {
  writeJson(projectRoot, '.tmp/product-scope-contract.json', source.scope);
  writeJson(projectRoot, '.tmp/persistence-contract.json', source.persistence);
  writeJson(projectRoot, '.tmp/workflow-journey-contract.json', source.journey);
  writeJson(projectRoot, '.tmp/data-model-usage-input.json', source.input);
  if (source.dataModel) {
    writeJson(projectRoot, '.tmp/dataverse-schema-contract.json', source.dataModel);
  }
}

function contracts() {
  const scope = {
    schemaVersion: 1,
    contractType: 'product-scope',
    requirements: [
      {
        id: 'record-inspection',
        statement: 'Record an inspection result',
        disposition: 'shipping',
        jobId: 'inspect-equipment',
      },
      {
        id: 'view-warranty',
        statement: 'View warranty coverage',
        disposition: 'shipping',
        jobId: 'inspect-equipment',
      },
    ],
    requirementCoverage: [
      { requirementId: 'record-inspection', screenId: 'inspection', mechanism: 'action', target: 'Save inspection' },
      { requirementId: 'view-warranty', screenId: 'equipment', mechanism: 'action', target: 'View warranty' },
    ],
    coreJobs: [{ id: 'inspect-equipment' }],
    supportingJobs: [],
    screens: [
      { id: 'inspection', entity: 'Inspection' },
      { id: 'equipment', entity: 'Equipment' },
    ],
    newTables: [{
      name: 'Inspection',
      jobIds: ['inspect-equipment'],
      lifecycleJustification: {
        reasons: ['independent-lifecycle', 'explicit-history-or-audit'],
        statement: 'Inspection records remain independently auditable after work completes.',
      },
    }],
    dataEntities: [
      { name: 'Inspection', role: 'primary', realization: 'new-table', screenIds: ['inspection'] },
      { name: 'Equipment', role: 'primary', realization: 'existing-table', screenIds: ['equipment'] },
      { name: 'Warranty', role: 'supporting', realization: 'connector-source', screenIds: ['equipment'] },
    ],
  };
  const persistence = {
    schemaVersion: 1,
    contractType: 'persistence-contract',
    persistenceRevision: 'b'.repeat(64),
    conceptOwners: [
      { conceptId: 'inspection', conceptName: 'Inspection', owner: 'dataverse', role: 'primary', realization: 'new-table' },
      { conceptId: 'equipment', conceptName: 'Equipment', owner: 'dataverse', role: 'primary', realization: 'existing-table' },
      { conceptId: 'warranty', conceptName: 'Warranty', owner: 'connector:warranty-api', role: 'supporting', realization: 'connector-source' },
    ],
  };
  const journey = {
    journeys: [{
      id: 'inspection-journey',
      jobId: 'inspect-equipment',
      steps: [
        {
          id: 'save-inspection',
          satisfies: ['record-inspection'],
          surface: { screenId: 'inspection' },
          dataOperation: { kind: 'create', entity: 'Inspection', classification: 'schema-backed' },
        },
        {
          id: 'load-warranty',
          satisfies: ['view-warranty'],
          surface: { screenId: 'equipment' },
          dataOperation: { kind: 'external-call', entity: 'Warranty', classification: 'schema-backed' },
        },
      ],
    }],
  };
  const dataModel = {
    schemaVersion: 1,
    publisherPrefix: 'ct',
    tables: [{
      logicalName: 'ct_inspection',
      schemaName: 'ct_inspection',
      displayName: 'Inspection',
      plannedDecision: 'create',
      dependencyTier: 0,
      serviceRequired: true,
      ownershipType: 'UserOwned',
      columns: [
        {
          logicalName: 'ct_name',
          schemaName: 'ct_name',
          displayName: 'Inspection',
          type: 'string',
          plannedDecision: 'create',
          requiredLevel: 'ApplicationRequired',
          primaryName: true,
        },
        {
          logicalName: 'ct_result',
          schemaName: 'ct_result',
          displayName: 'Result',
          type: 'string',
          plannedDecision: 'create',
          requiredLevel: 'ApplicationRequired',
        },
        {
          logicalName: 'ct_equipmentid',
          schemaName: 'ct_equipmentid',
          displayName: 'Equipment',
          type: 'lookup',
          lookupTarget: 'equipment',
          plannedDecision: 'create',
          requiredLevel: 'ApplicationRequired',
        },
      ],
      relationships: [{
        kind: 'many-to-one',
        schemaName: 'ct_Equipment_Inspection',
        plannedDecision: 'create',
        parentTable: 'equipment',
        childTable: 'ct_inspection',
        lookup: {
          logicalName: 'ct_equipmentid',
          schemaName: 'ct_equipmentid',
          displayName: 'Equipment',
          requiredLevel: 'ApplicationRequired',
        },
      }],
      alternateKeys: [],
    }, {
      logicalName: 'equipment',
      schemaName: 'equipment',
      displayName: 'Equipment',
      plannedDecision: 'reuse',
      dependencyTier: 0,
      serviceRequired: true,
      ownershipType: 'OrganizationOwned',
      columns: [{
        logicalName: 'name',
        schemaName: 'name',
        displayName: 'Name',
        type: 'string',
        plannedDecision: 'reuse',
        requiredLevel: 'ApplicationRequired',
        primaryName: true,
      }],
      relationships: [],
      alternateKeys: [],
    }],
  };
  const input = {
    schemaVersion: 1,
    tables: [{
      tableLogicalName: 'ct_inspection',
      conceptId: 'inspection',
      fields: [
        { logicalName: 'ct_name', exemption: { kind: 'primary-name', reason: 'Dataverse requires one human-readable primary name.' } },
        { logicalName: 'ct_result', consumers: [{ kind: 'requirement', id: 'record-inspection' }, { kind: 'domain-operation', id: 'inspection-journey:save-inspection' }] },
        { logicalName: 'ct_equipmentid', consumers: [{ kind: 'screen', id: 'inspection' }] },
      ],
      relationships: [{ schemaName: 'ct_Equipment_Inspection', consumers: [{ kind: 'requirement', id: 'record-inspection' }] }],
    }, {
      tableLogicalName: 'equipment',
      conceptId: 'equipment',
      fields: [{ logicalName: 'name', consumers: [{ kind: 'screen', id: 'equipment' }] }],
      relationships: [],
    }],
  };
  return { scope, persistence, journey, dataModel, input };
}

test('usage compilation traces requirements through owners, schema, operations, and screens', () => {
  const source = contracts();
  const result = compileDataModelUsage(source.input, source);
  assert.deepEqual(result.errors, []);
  assert.equal(result.compiled.requirements.find(
    (item) => item.requirementId === 'record-inspection',
  ).owner, 'dataverse');
  assert.equal(result.compiled.requirements.find(
    (item) => item.requirementId === 'view-warranty',
  ).owner, 'connector:warranty-api');
  const inspection = result.compiled.tables.find(
    (table) => table.tableLogicalName === 'ct_inspection',
  );
  assert.deepEqual(inspection.justification.reasons, [
    'independent-lifecycle',
    'explicit-history-or-audit',
  ]);
  assert.deepEqual(inspection.fields.find(
    (field) => field.logicalName === 'ct_result',
  ).requirementIds, ['record-inspection']);
  assert.match(result.compiled.usageRevision, /^[a-f0-9]{64}$/);
});

test('unused non-system fields and relationships are rejected', () => {
  const source = contracts();
  source.input.tables[0].fields.find((field) => field.logicalName === 'ct_result').consumers = [];
  source.input.tables[0].relationships[0].consumers = [];
  const result = compileDataModelUsage(source.input, source);
  assert.ok(result.errors.some((item) => item.code === 'unused-field'));
  assert.ok(result.errors.some((item) => item.code === 'unused-relationship'));
});

test('typed system exemptions are required and narrowly validated', () => {
  const source = contracts();
  delete source.input.tables[0].fields[0].exemption;
  assert.ok(compileDataModelUsage(source.input, source).errors.some(
    (item) => item.code === 'unused-field',
  ));
  source.input.tables[0].fields[0].exemption = {
    kind: 'audit',
    reason: 'Wrong exemption for a primary name field.',
  };
  assert.ok(compileDataModelUsage(source.input, source).errors.some(
    (item) => item.code === 'invalid-system-exemption',
  ));
});

test('persistable requirements require exactly one resolved storage owner', () => {
  const source = contracts();
  source.persistence.conceptOwners = source.persistence.conceptOwners.filter(
    (item) => item.conceptId !== 'warranty',
  );
  const result = compileDataModelUsage(source.input, source);
  assert.ok(result.errors.some((item) => item.code === 'requirement-owner-missing'));

  const ambiguous = contracts();
  ambiguous.journey.journeys[0].steps.push({
    id: 'duplicate-inspection-owner',
    satisfies: ['record-inspection'],
    surface: { screenId: 'inspection' },
    dataOperation: { kind: 'external-call', entity: 'Warranty', classification: 'schema-backed' },
  });
  assert.ok(compileDataModelUsage(ambiguous.input, ambiguous).errors.some(
    (item) => item.code === 'requirement-owner-ambiguous',
  ));
});

test('duplicate Dataverse storage for one concept requires typed justification', () => {
  const source = contracts();
  source.dataModel.tables.push({
    ...structuredClone(source.dataModel.tables[0]),
    logicalName: 'ct_inspectionarchive',
    schemaName: 'ct_inspectionarchive',
    displayName: 'Inspection archive',
    columns: source.dataModel.tables[0].columns.filter(
      (column) => column.logicalName !== 'ct_equipmentid',
    ),
    relationships: [],
  });
  source.input.tables.push({
    ...structuredClone(source.input.tables[0]),
    tableLogicalName: 'ct_inspectionarchive',
    fields: source.input.tables[0].fields.filter(
      (field) => field.logicalName !== 'ct_equipmentid',
    ),
    relationships: [],
  });
  let result = compileDataModelUsage(source.input, source);
  assert.ok(result.errors.some((item) => item.code === 'duplicate-concept-storage'));
  source.input.tables.at(-1).duplicationJustification = {
    kind: 'approved-denormalization',
    reason: 'A separately approved reporting projection retains immutable inspection facts.',
  };
  result = compileDataModelUsage(source.input, source);
  assert.equal(result.errors.some((item) => item.code === 'duplicate-concept-storage'), false);
});

test('compiled usage validates against current contract revisions', () => {
  const source = contracts();
  const compiled = compileDataModelUsage(source.input, source).compiled;
  assert.deepEqual(validateDataModelUsage(compiled, source).errors, []);
  source.persistence.persistenceRevision = 'c'.repeat(64);
  assert.ok(validateDataModelUsage(compiled, source).errors.some(
    (item) => item.code === 'stale-persistence-binding',
  ));
});

test('connector-only usage traces requirements without a Dataverse schema', () => {
  const source = contracts();
  source.scope.requirements = [source.scope.requirements[1]];
  source.scope.requirementCoverage = [source.scope.requirementCoverage[1]];
  source.journey.journeys[0].steps = [source.journey.journeys[0].steps[1]];
  source.persistence.mode = 'connector-only';
  source.persistence.conceptOwners = source.persistence.conceptOwners.filter(
    (item) => item.conceptId === 'warranty',
  );
  source.dataModel = null;
  const result = compileDataModelUsage({ schemaVersion: 1, tables: [] }, source);
  assert.deepEqual(result.errors, []);
  assert.equal(result.compiled.dataModelRevision, null);
  assert.equal(result.compiled.tables.length, 0);
  assert.equal(result.compiled.requirements[0].owner, 'connector:warranty-api');
});

test('local-prototype usage traces requirements without a Dataverse schema', () => {
  const source = contracts();
  source.scope.requirements = [source.scope.requirements[0]];
  source.scope.requirementCoverage = [source.scope.requirementCoverage[0]];
  source.scope.newTables = [];
  source.scope.dataEntities = [{
    name: 'Inspection',
    role: 'primary',
    realization: 'local-configuration',
    screenIds: ['inspection'],
  }];
  source.journey.journeys[0].steps = [{
    ...source.journey.journeys[0].steps[0],
    dataOperation: {
      kind: 'local-state',
      entity: 'Inspection',
      classification: 'schema-backed',
    },
  }];
  source.persistence.mode = 'local-prototype';
  source.persistence.conceptOwners = [{
    conceptId: 'inspection',
    conceptName: 'Inspection',
    owner: 'local',
    role: 'primary',
    realization: 'local-configuration',
  }];
  source.dataModel = null;
  const result = compileDataModelUsage({ schemaVersion: 1, tables: [] }, source);
  assert.deepEqual(result.errors, []);
  assert.equal(result.compiled.dataModelRevision, null);
  assert.equal(result.compiled.tables.length, 0);
  assert.equal(result.compiled.requirements[0].owner, 'local');
});

test('stale field and relationship usage entries are rejected', () => {
  const source = contracts();
  source.input.tables[0].fields.push({
    logicalName: 'ct_removed',
    consumers: [{ kind: 'screen', id: 'inspection' }],
  });
  source.input.tables[0].relationships.push({
    schemaName: 'ct_Removed_Relationship',
    consumers: [{ kind: 'screen', id: 'inspection' }],
  });
  const result = compileDataModelUsage(source.input, source);
  assert.ok(result.errors.some((item) => item.code === 'unknown-field-usage'));
  assert.ok(result.errors.some((item) => item.code === 'unknown-relationship-usage'));
});

test('duplicate field and relationship usage entries are rejected', () => {
  const source = contracts();
  source.input.tables[0].fields.push(structuredClone(source.input.tables[0].fields[1]));
  source.input.tables[0].relationships.push(
    structuredClone(source.input.tables[0].relationships[0]),
  );
  const result = compileDataModelUsage(source.input, source);
  assert.ok(result.errors.some((item) => item.code === 'duplicate-field-usage'));
  assert.ok(result.errors.some((item) => item.code === 'duplicate-relationship-usage'));
  assert.equal(result.compiled, null);
});

test('stale table usage entries are rejected', () => {
  const source = contracts();
  source.input.tables.push({
    tableLogicalName: 'ct_removed',
    conceptId: 'inspection',
    fields: [],
    relationships: [],
  });
  const result = compileDataModelUsage(source.input, source);
  assert.ok(result.errors.some((item) => item.code === 'unknown-table-usage'));
});

test('CLI writes and checks usage artifacts for Dataverse and connector-only projects', () => {
  const scenarios = [
    {
      label: 'dataverse',
      prepare(source) {
        source.scope.requirements = [source.scope.requirements[0]];
        source.scope.requirementCoverage = [source.scope.requirementCoverage[0]];
        source.journey.journeys[0].steps = [source.journey.journeys[0].steps[0]];
        source.persistence.mode = 'dataverse';
        source.persistence.conceptOwners = source.persistence.conceptOwners.filter(
          (item) => item.owner === 'dataverse',
        );
        return source;
      },
      expectedOwner: 'dataverse',
      expectedTables: 2,
    },
    {
      label: 'connector-only',
      prepare(source) {
        source.scope.requirements = [source.scope.requirements[1]];
        source.scope.requirementCoverage = [source.scope.requirementCoverage[1]];
        source.journey.journeys[0].steps = [source.journey.journeys[0].steps[1]];
        source.persistence.mode = 'connector-only';
        source.persistence.conceptOwners = source.persistence.conceptOwners.filter(
          (item) => item.conceptId === 'warranty',
        );
        source.dataModel = null;
        source.input = { schemaVersion: 1, tables: [] };
        return source;
      },
      expectedOwner: 'connector:warranty-api',
      expectedTables: 0,
    },
  ];

  for (const scenario of scenarios) {
    const projectRoot = makeProjectDir(`data-model-usage-${scenario.label}`);
    try {
      writeCliContracts(projectRoot, scenario.prepare(contracts()));
      const compiled = runCli('validate-data-model-usage.js', [
        '--project-root', projectRoot,
      ]);
      assert.equal(compiled.code, 0, compiled.stderr);
      assert.equal(compiled.json.ok, true);
      const output = JSON.parse(fs.readFileSync(
        path.join(projectRoot, '.tmp/data-model-usage.json'),
        'utf8',
      ));
      assert.equal(output.tables.length, scenario.expectedTables);
      assert.equal(output.requirements[0].owner, scenario.expectedOwner);

      const checked = runCli('validate-data-model-usage.js', [
        '--project-root', projectRoot,
        '--check',
      ]);
      assert.equal(checked.code, 0, checked.stderr);
      assert.equal(checked.json.ok, true);
    } finally {
      cleanup(projectRoot);
    }
  }
});
