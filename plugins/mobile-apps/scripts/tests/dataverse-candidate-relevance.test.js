'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  parseConcepts,
  rankCandidatesByConcept,
  selectDetailedCandidates,
  selectStrongProposedCollisions,
} = require('../create-dataverse-snapshot');

function label(value) {
  return { UserLocalizedLabel: { Label: value } };
}

function entity(logicalName, displayName, description = `${displayName} records`) {
  return {
    LogicalName: logicalName,
    SchemaName: logicalName,
    EntitySetName: `${logicalName}s`,
    DisplayName: label(displayName),
    DisplayCollectionName: label(`${displayName}s`),
    Description: label(description),
    PrimaryIdAttribute: `${logicalName}id`,
    PrimaryNameAttribute: `${logicalName}name`,
    OwnershipType: 'UserOwned',
    HasActivities: false,
    HasNotes: false,
    IsAvailableOffline: true,
    ChangeTrackingEnabled: true,
    IsCustomEntity: true,
    IsManaged: false,
    IsCustomizable: { Value: true },
    CanCreateAttributes: { Value: true },
    CanBePrimaryEntityInRelationship: { Value: true },
    CanBeRelatedEntityInRelationship: { Value: true },
    CanBeInManyToMany: { Value: true },
  };
}

function concept(phrase, kind = 'entity', discoverTable = kind === 'entity') {
  return { phrase, kind, discoverTable, evidence: `Brief mentions ${phrase}.` };
}

test('typed roles, attributes, and constraints do not discover Dataverse tables', () => {
  const rankings = rankCandidatesByConcept([
    entity('rollupfield', 'Rollup Field'),
    entity('fax', 'Fax'),
    entity('new_goodsreception', 'Goods Reception'),
  ], [
    concept('field logisticians', 'role', false),
    concept('batch numbers', 'attribute', false),
    concept('limited connectivity', 'constraint', false),
    concept('goods receptions'),
  ]);

  assert.deepEqual(rankings.slice(0, 3).map((ranking) => ({
    concept: ranking.concept,
    candidates: ranking.candidates,
    skippedReason: ranking.skippedReason,
  })), [
    { concept: 'field logisticians', candidates: [], skippedReason: 'concept-kind:role' },
    { concept: 'batch numbers', candidates: [], skippedReason: 'concept-kind:attribute' },
    { concept: 'limited connectivity', candidates: [], skippedReason: 'concept-kind:constraint' },
  ]);
  assert.equal(rankings[3].candidates[0].logicalName, 'new_goodsreception');
  assert.equal(rankings[3].candidates[0].matchClass, 'exact');
});

test('typed persistent concepts select the six exact receiving tables without alternatives', () => {
  const entities = [
    entity('new_goodsitem', 'Goods Item'),
    entity('new_expectedshipment', 'Expected Shipment'),
    entity('new_expectedshipmentline', 'Expected Shipment Line'),
    entity('new_goodsreception', 'Goods Reception'),
    entity('new_goodsreceptionline', 'Goods Reception Line'),
    entity('new_damageevidence', 'Damage Evidence'),
    entity('new_damagephoto', 'Damage Photo'),
    entity('new_damagereport', 'Damage Report'),
  ];
  const concepts = [
    concept('goods items'),
    concept('expected shipments'),
    concept('expected shipment lines'),
    concept('goods receptions'),
    concept('goods reception lines'),
    concept('damage evidence'),
  ];
  const selection = selectDetailedCandidates(entities, [], concepts);

  assert.deepEqual(selection.selectedEntities.map((item) => item.LogicalName), [
    'new_damageevidence',
    'new_expectedshipment',
    'new_expectedshipmentline',
    'new_goodsitem',
    'new_goodsreception',
    'new_goodsreceptionline',
  ]);
  assert.equal(selection.detailSelectionSummary.primaryCandidates, 6);
  assert.equal(selection.detailSelectionSummary.ambiguityCandidates, 0);
  assert.equal(selection.detailSelectionSummary.deferredCandidates, 2);
});

test('typed ambiguity adds only the second candidate and defers the third', () => {
  const selection = selectDetailedCandidates([
    entity('new_inspection', 'Inspection'),
    entity('new_inspectionitem', 'Inspection Item'),
    entity('new_inspectionphoto', 'Inspection Photo'),
  ], [], [concept('inspection results')]);

  assert.equal(selection.selectedEntities.length, 2);
  assert.equal(selection.detailSelectionSummary.primaryCandidates, 1);
  assert.equal(selection.detailSelectionSummary.ambiguityCandidates, 1);
  assert.equal(selection.detailSelectionSummary.deferredCandidates, 1);
});

test('multiword display phrase promotes a lower-ranked proposed collision', () => {
  const entities = [
    entity('new_checkin', 'Evidence'),
    entity('new_damagephoto', 'Damage Photo'),
    entity('new_damageevidence', 'Damage Evidence'),
  ];
  const concepts = [concept('damage evidence attachments')];
  const selection = selectDetailedCandidates(entities, [], concepts, {
    proposedTableNames: ['new_damageevidence'],
  });

  assert.deepEqual(
    selection.selectedEntities.map((item) => item.LogicalName),
    ['new_checkin', 'new_damageevidence', 'new_damagephoto'],
  );
  assert.equal(selection.detailSelectionSummary.strongCollisionCandidates, 1);
  assert.ok(selection.selectedEvidence.find(
    (item) => item.logicalName === 'new_damageevidence',
  ).reasons.includes('proposed-collision:strong-concept-phrase'));
});

test('single generic display word does not promote a proposed collision', () => {
  const entities = [
    entity('fax', 'Signed Document Register'),
    entity('new_document', 'Document'),
  ];
  const rankings = rankCandidatesByConcept(entities, [concept('signed delivery documents')]);
  const selected = selectStrongProposedCollisions(
    entities,
    ['new_document'],
    rankings,
    new Map([['fax', new Set(['concept:signed delivery documents:primary'])]]),
  );
  assert.deepEqual(selected, []);
});

test('structured concept files are validated and legacy input remains supported', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dataverse-concepts-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'concepts.json');
  fs.writeFileSync(file, JSON.stringify([
    concept('goods receptions'),
    concept('batch numbers', 'attribute', false),
  ]));
  assert.deepEqual(parseConcepts({ 'concepts-file': file }), [
    concept('goods receptions'),
    concept('batch numbers', 'attribute', false),
  ]);
  assert.deepEqual(parseConcepts({ concepts: 'goods receptions,batch numbers' }), [
    'goods receptions',
    'batch numbers',
  ]);
  assert.throws(
    () => parseConcepts({ concepts: 'goods', 'concepts-file': file }),
    /mutually exclusive/,
  );
  fs.writeFileSync(file, JSON.stringify([{ phrase: 'goods receptions', kind: 'unknown' }]));
  assert.throws(() => parseConcepts({ 'concepts-file': file }), /kind is invalid/);
});