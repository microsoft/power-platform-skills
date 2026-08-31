'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  compileDataModelSemanticResult,
  materializeDataModelCompilation,
  validateSemanticResult,
} = require('../lib/compile-data-model-semantic-result');
const { run } = require('../compile-data-model-semantic-result');
const { stableJson, validateContract } = require('../build-dataverse-operation-manifest');

function semanticFixture() {
  return {
    schemaVersion: 1,
    status: 'ready',
    mode: 'dataverse-required',
    summary: {
      productDomain: 'equipment maintenance',
      persistenceRationale: 'Shared maintenance records across company gyms.',
    },
    requirements: [{
      requirementId: 'requirement:scan-equipment',
      statement: 'Identify equipment by QR code.',
      coveredBy: ['entity:equipment', 'operation:equipment-by-code'],
    }],
    entities: [{
      entityId: 'entity:equipment',
      displayName: 'Equipment',
      pluralDisplayName: 'Equipment',
      purpose: 'A maintainable asset installed at a gym location.',
      lifecycle: 'Equipment remains active across inspections, repairs, and warranty events.',
      scopeRole: 'core asset',
      ownershipIntent: 'organization',
      decision: 'new',
      decisionRationale: 'The app owns equipment identity and lifecycle.',
      primaryDisplayField: 'field:equipment-name',
      serviceRequired: true,
      owningRequirementIds: ['requirement:scan-equipment'],
      behavior: { activities: false, notes: true, offlineAvailable: true, changeTracking: true },
      targetEvidence: { status: 'missing', summary: 'The proposed table name is verified absent.' },
      fields: [{
        fieldId: 'field:equipment-name',
        displayName: 'Equipment name',
        typeIntent: 'text',
        required: true,
        purpose: 'Human-readable equipment identity.',
        decision: 'new',
        validation: { maxLength: 200 },
      }, {
        fieldId: 'field:qr-code',
        displayName: 'QR code',
        typeIntent: 'text',
        required: true,
        purpose: 'Scanner lookup value.',
        decision: 'new',
        uniqueIntent: true,
        uniqueDecision: 'new',
        validation: { maxLength: 100 },
      }, {
        fieldId: 'field:condition',
        displayName: 'Condition',
        typeIntent: 'choice',
        required: true,
        purpose: 'Current operating condition.',
        decision: 'new',
        options: [
          { optionId: 'option:serviceable', label: 'Serviceable', order: 0 },
          { optionId: 'option:needs-repair', label: 'Needs repair', order: 1 },
          { optionId: 'option:out-of-service', label: 'Out of service', order: 2 },
        ],
      }],
    }, {
      entityId: 'entity:gym-location',
      displayName: 'Gym location',
      pluralDisplayName: 'Gym locations',
      purpose: 'A company gym where equipment is installed.',
      lifecycle: 'Locations organize equipment and remain stable across maintenance activity.',
      scopeRole: 'reference parent',
      ownershipIntent: 'organization',
      decision: 'new',
      primaryDisplayField: 'field:location-name',
      serviceRequired: true,
      owningRequirementIds: [],
      behavior: { activities: false, notes: false, offlineAvailable: true, changeTracking: true },
      targetEvidence: { status: 'missing', summary: 'The proposed table name is verified absent.' },
      fields: [{
        fieldId: 'field:location-name',
        displayName: 'Location name',
        typeIntent: 'text',
        required: true,
        purpose: 'Human-readable gym identity.',
        decision: 'new',
      }],
    }],
    relationships: [{
      relationshipId: 'relationship:equipment-location',
      fromEntityId: 'entity:equipment',
      toEntityId: 'entity:gym-location',
      cardinalityIntent: 'many-to-one',
      required: true,
      purpose: 'Identifies the gym that owns the equipment.',
      decision: 'new',
      deleteBehaviorIntent: 'restrict',
      serviceRequired: false,
    }],
    operations: [{
      operationId: 'operation:equipment-by-code',
      kind: 'read-one',
      entityId: 'entity:equipment',
      inputIntent: ['qrCode'],
      selectFieldIds: ['field:equipment-name', 'field:qr-code', 'field:condition'],
      filterIntent: [{ fieldId: 'field:qr-code', operator: 'equals', input: 'qrCode' }],
      sortIntent: [],
      mutationFieldIds: [],
      paginationIntent: 'not-applicable',
      purpose: 'Open equipment details after scanning.',
    }],
    fixtureScenarios: [{
      scenarioId: 'scenario:repair-in-progress',
      purpose: 'Demonstrate equipment that currently needs repair.',
      entityIds: ['entity:equipment', 'entity:gym-location'],
      requirementIds: ['requirement:scan-equipment'],
    }],
    assumptions: ['Gym locations are shared reference data.'],
    risks: ['QR labels must remain unique across locations.'],
    concerns: [],
  };
}

test('same semantic input produces byte-identical Markdown, contract, and receipt', () => {
  const input = semanticFixture();
  const options = { publisherPrefix: 'cr1', snapshotHash: 'a'.repeat(64) };
  const first = compileDataModelSemanticResult(input, options);
  const second = compileDataModelSemanticResult(JSON.parse(JSON.stringify(input)), options);
  assert.equal(first.markdown, second.markdown);
  assert.equal(stableJson(first.contract), stableJson(second.contract));
  assert.equal(stableJson(first.receipt), stableJson(second.receipt));
  assert.equal(first.receipt.markdownRenderedFrom, first.receipt.semanticResultHash);
  assert.equal(first.receipt.contractRenderedFrom, first.receipt.semanticResultHash);
  assert.equal(validateContract(first.contract).valid, true);
});

test('publisher-prefix changes only mechanical outputs and dependent hashes', () => {
  const input = semanticFixture();
  const first = compileDataModelSemanticResult(input, { publisherPrefix: 'cr1' });
  const second = compileDataModelSemanticResult(input, { publisherPrefix: 'xy2' });
  assert.equal(first.receipt.semanticResultHash, second.receipt.semanticResultHash);
  assert.notEqual(first.receipt.contractHash, second.receipt.contractHash);
  assert.notEqual(first.receipt.markdownHash, second.receipt.markdownHash);
  assert.equal(first.contract.tables.some((table) => table.logicalName.startsWith('cr1_')), true);
  assert.equal(second.contract.tables.some((table) => table.logicalName.startsWith('xy2_')), true);
  assert.deepEqual(first.semantic.requirements, second.semantic.requirements);
});

test('invalid relationships and operations fail before output compilation', () => {
  const invalidRelationship = semanticFixture();
  invalidRelationship.relationships[0].toEntityId = 'entity:missing';
  assert.throws(
    () => compileDataModelSemanticResult(invalidRelationship, { publisherPrefix: 'cr1' }),
    /unknown toEntityId/,
  );
  const invalidOperation = semanticFixture();
  invalidOperation.operations[0].selectFieldIds.push('field:missing');
  assert.throws(
    () => compileDataModelSemanticResult(invalidOperation, { publisherPrefix: 'cr1' }),
    /references unknown field/,
  );
});

test('semantic IDs must use the kind required by their owning property', () => {
  const input = semanticFixture();
  input.entities[0].entityId = 'field:not-an-entity';
  const validation = validateSemanticResult(input);
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join('; '), /does not match \^entity:/);
});

test('normalization cannot turn whitespace-only semantic content into an accepted value', () => {
  const input = semanticFixture();
  input.summary.productDomain = '  ';
  assert.throws(
    () => compileDataModelSemanticResult(input, { publisherPrefix: 'cr1' }),
    /productDomain.*at least 2 characters/,
  );
});

test('mechanical compilation never invents missing semantic content', () => {
  const input = semanticFixture();
  input.entities = [];
  input.relationships = [];
  input.operations = [];
  input.fixtureScenarios = [];
  const validation = validateSemanticResult(input);
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join('; '), /requires at least one semantic entity|unknown semantic ID/);
  assert.throws(() => compileDataModelSemanticResult(input, { publisherPrefix: 'cr1' }));
});

test('requirement coverage and choice semantics survive both rendered outputs', () => {
  const compiled = compileDataModelSemanticResult(semanticFixture(), { publisherPrefix: 'cr1' });
  assert.match(compiled.markdown, /requirement:scan-equipment/);
  assert.match(compiled.markdown, /Serviceable → Needs repair → Out of service/);
  const equipment = compiled.contract.tables.find((table) => table.semanticEntityId === 'entity:equipment');
  const condition = equipment.columns.find((column) => column.semanticFieldId === 'field:condition');
  assert.deepEqual(condition.options.map((option) => option.label), [
    'Serviceable',
    'Needs repair',
    'Out of service',
  ]);
});

test('reuse, extend, and new table decisions remain representable', () => {
  const input = semanticFixture();
  input.relationships = [];
  input.entities[0].decision = 'extend';
  input.entities[0].existingLogicalName = 'new_equipment';
  input.entities[0].fields[0].decision = 'reuse';
  input.entities[0].fields[0].existingLogicalName = 'new_name';
  input.entities[0].fields[1].uniqueIntent = false;
  delete input.entities[0].fields[1].uniqueDecision;
  input.entities[1].decision = 'reuse';
  input.entities[1].existingLogicalName = 'account';
  input.entities[1].fields[0].decision = 'reuse';
  input.entities[1].fields[0].existingLogicalName = 'name';
  const compiled = compileDataModelSemanticResult(input, { publisherPrefix: 'cr1' });
  assert.deepEqual(
    compiled.contract.tables.map((table) => table.plannedDecision).sort(),
    ['extend', 'reuse'],
  );
  assert.equal(validateContract(compiled.contract).valid, true);
});

test('all outputs materialize transactionally from one compilation', (context) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-compiler-'));
  context.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const compiled = compileDataModelSemanticResult(semanticFixture(), {
    publisherPrefix: 'cr1',
    snapshotHash: 'b'.repeat(64),
  });
  const targets = {
    projectRoot,
    semanticTarget: path.join(projectRoot, '.tmp', 'data-model-semantic-result.json'),
    markdownTarget: path.join(projectRoot, '_dm_section.md'),
    contractTarget: path.join(projectRoot, '.tmp', 'dataverse-schema-contract.json'),
    receiptTarget: path.join(projectRoot, '.tmp', 'data-model-compilation-receipt.json'),
  };
  const materialized = materializeDataModelCompilation(compiled, targets);
  assert.equal(materialized.length, 4);
  assert.equal(fs.readFileSync(targets.markdownTarget, 'utf8'), compiled.markdown);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(targets.receiptTarget, 'utf8')),
    compiled.receipt,
  );
});

test('thin CLI consumes a typed envelope result and materializes canonical outputs', (context) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-cli-'));
  context.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(projectRoot, '.tmp'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.tmp', 'agent-result.json'), JSON.stringify({
    schemaVersion: 1,
    status: 'ready',
    results: [{
      agent: 'data-model-architect',
      resultId: 'semantic:data-model',
      resultType: 'data-model-semantic-v1',
      value: semanticFixture(),
    }],
  }));
  const result = run({
    projectRoot,
    semanticResult: '.tmp/agent-result.json',
    publisherPrefix: 'cr1',
    materialize: true,
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.materialized.length, 4);
  assert.equal(fs.existsSync(path.join(projectRoot, '_dm_section.md')), true);
  assert.equal(fs.existsSync(path.join(projectRoot, '.tmp', 'dataverse-schema-contract.json')), true);
});