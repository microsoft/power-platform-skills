'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { compileDesignContentProjection, main, validateDesignContentProjection } = require('../compile-design-content-projection');
const { validationFingerprint } = require('../validate-mobile-app');

function model() {
  return {
    schemaVersion: 1,
    mode: 'prototype-domain',
    experienceContractSha256: 'a'.repeat(64),
    contextEnrichmentSha256: 'b'.repeat(64),
    entities: [{
      key: 'WorkItem', displayName: 'Work item', displayPluralName: 'Work items',
      description: 'A realistic item requiring a product decision.', primaryNameField: 'name', estimatedPrototypeRows: 2,
      fields: [
        { key: 'id', displayName: 'ID', type: 'id', required: true },
        { key: 'name', displayName: 'Item name', type: 'text', required: true, maximumLength: 120 },
        { key: 'status', displayName: 'Current status', type: 'choice', required: true, choiceKey: 'WorkStatus' },
        { key: 'priority', displayName: 'Priority', type: 'whole-number', required: true, minimum: 1, maximum: 5 },
        { key: 'notes', displayName: 'Decision context', type: 'multiline-text', required: false, maximumLength: 500 },
      ],
    }],
    relationships: [],
    choices: [{ key: 'WorkStatus', options: [{ key: 'ready', label: 'Ready for review' }, { key: 'blocked', label: 'Blocked by required evidence' }] }],
    operations: [{
      key: 'listWorkItems', entity: 'WorkItem', kind: 'list', repository: 'WorkRepository', method: 'listWorkItems', hook: 'useWorkItems',
      selectFields: ['id', 'name', 'status', 'priority', 'notes'], filterFields: ['status'], sortFields: ['priority'],
      pagination: { mode: 'bounded', boundedReason: 'Two representative prototype records.', maximumExpectedCount: 2 },
    }],
    actors: [{ key: 'Operator', displayName: 'Operator' }],
    uxPermissions: [{ actor: 'Operator', operation: 'listWorkItems', allowed: true }],
    offlineUxIntent: { connectivity: 'network-optional', requiredOperations: [] },
    fixtureRequirements: [
      { key: 'work-populated', state: 'populated', description: 'Representative work records.', entity: 'WorkItem', minimumRecords: 2 },
      { key: 'work-loading', state: 'loading', description: 'Work records are loading.' },
      { key: 'work-empty', state: 'empty', description: 'No work records match.' },
      { key: 'work-error', state: 'error', description: 'Work records failed to load.' },
      { key: 'work-offline', state: 'offline', description: 'Work records are unavailable offline.' },
    ],
    mediaPolicy: { mode: 'not-applicable', requiredFields: [], requiresFallback: false },
    fixtures: {
      WorkItem: [
        { id: 'work-ready', name: 'North facility readiness review', status: 'ready', priority: 2, notes: 'Confirm ownership and the next safe action before the morning shift begins.' },
        { id: 'work-blocked', name: 'Evidence-dependent maintenance decision', status: 'blocked', priority: 1, notes: 'Photographic evidence and supervisor confirmation are required before this record can proceed.' },
      ],
    },
    fixtureScenarios: [
      { key: 'work-populated', state: 'populated', description: 'Representative work records.', entity: 'WorkItem', recordIds: ['work-ready', 'work-blocked'] },
      { key: 'work-loading', state: 'loading', description: 'Work records are loading.' },
      { key: 'work-empty', state: 'empty', description: 'No work records match.' },
      { key: 'work-error', state: 'error', description: 'Work records failed to load.' },
      { key: 'work-offline', state: 'offline', description: 'Work records are unavailable offline.' },
    ],
  };
}

test('compiles bounded representative content for automatic design', () => {
  const first = compileDesignContentProjection(model());
  const second = compileDesignContentProjection(structuredClone(model()));
  assert.deepEqual(first, second);
  assert.equal(first.kind, 'mobile-design-content-projection');
  assert.equal(first.entities[0].representativeRecords.length, 2);
  assert.deepEqual(first.entities[0].representativeRecords[0], {
    id: 'work-ready',
    name: 'North facility readiness review',
    status: 'ready',
    priority: 2,
    notes: 'Confirm ownership and the next safe action before the morning shift begins.',
  });
  assert.deepEqual(first.entities[0].representativeFieldSets[0], ['id', 'name', 'status', 'priority', 'notes']);
  assert.deepEqual(first.choiceVocabulary[0].options.map((option) => option.label), ['Ready for review', 'Blocked by required evidence']);
  assert.equal(first.longestStrings[0].value, 'Photographic evidence and supervisor confirmation are required before this record can proceed.');
  assert.equal(first.scenarios.some((scenario) => scenario.state === 'offline'), false);
  assert.match(first.contentFingerprint, /^[a-f0-9]{64}$/);
});

test('projection caps records and strings without changing the validated source model', () => {
  const value = model();
  const template = value.fixtures.WorkItem[0];
  value.fixtures.WorkItem = Array.from({ length: 5 }, (_, index) => ({ ...template, id: `work-${index}`, name: `Distinct work item ${String.fromCharCode(65 + index)}` }));
  value.entities[0].estimatedPrototypeRows = 5;
  value.operations[0].pagination.maximumExpectedCount = 5;
  value.operations[0].pagination.boundedReason = 'Five bounded prototype records.';
  value.fixtureRequirements[0].minimumRecords = 2;
  value.fixtureScenarios[0].recordIds = value.fixtures.WorkItem.map((record) => record.id);
  const projection = compileDesignContentProjection(value);
  assert.equal(projection.entities[0].recordCount, 5);
  assert.equal(projection.entities[0].representativeRecords.length, 3);
  assert.ok(projection.longestStrings.length <= projection.limits.maxLongestStrings);
});

test('invalid domain input fails before design context is written', () => {
  const value = model();
  value.fixtures.WorkItem[0].status = 'unknown';
  assert.throws(() => compileDesignContentProjection(value), /invalid choice key/);
});

test('freshness validation rejects a projection after representative content changes', () => {
  const original = model();
  const projection = compileDesignContentProjection(original);
  assert.equal(validateDesignContentProjection(original, projection).valid, true);
  const changed = structuredClone(original);
  changed.fixtures.WorkItem[0].name = 'Changed representative content';
  assert.equal(validateDesignContentProjection(changed, projection).valid, false);
});

test('CLI writes the projection inside the project root', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'design-content-projection-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
  fs.writeFileSync(path.join(root, '.tmp', 'prototype-domain-model.json'), `${JSON.stringify(model(), null, 2)}\n`);
  assert.equal(main(['--project-root', root]), 0);
  const output = JSON.parse(fs.readFileSync(path.join(root, '.tmp', 'design-content-projection.json'), 'utf8'));
  assert.equal(output.entities[0].representativeRecords.length, 2);
});

test('design content changes invalidate validation reuse fingerprints', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'design-content-fingerprint-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
  const outputPath = path.join(root, '.tmp', 'design-content-projection.json');
  const projection = compileDesignContentProjection(model());
  fs.writeFileSync(outputPath, `${JSON.stringify(projection, null, 2)}\n`);
  const first = validationFingerprint(root);
  projection.entities[0].representativeRecords[0].name = 'A materially longer representative name';
  fs.writeFileSync(outputPath, `${JSON.stringify(projection, null, 2)}\n`);
  assert.notEqual(validationFingerprint(root), first);
});
