#!/usr/bin/env node
'use strict';

const { createSnapshot, parseArgs } = require('./create-dataverse-snapshot');
const { metadataRequestIdentity } = require('./dataverse-request');
const {
  buildArchitectEvidence,
  sha256,
} = require('./render-dataverse-architect-evidence');

function label(value) {
  return { UserLocalizedLabel: { Label: value } };
}

function entity(logicalName, displayName, overrides = {}) {
  return {
    LogicalName: logicalName,
    SchemaName: logicalName,
    EntitySetName: `${logicalName}s`,
    DisplayName: label(displayName),
    DisplayCollectionName: label(`${displayName}s`),
    Description: label(`${displayName} records`),
    PrimaryIdAttribute: `${logicalName}id`,
    PrimaryNameAttribute: `${logicalName}name`,
    IsCustomEntity: true,
    IsManaged: false,
    IsCustomizable: { Value: true },
    CanCreateAttributes: { Value: true },
    ...overrides,
  };
}

function column(logicalName, type = 'String', overrides = {}) {
  return {
    MetadataId: `${logicalName}-metadata`,
    LogicalName: logicalName,
    SchemaName: logicalName,
    AttributeType: type,
    AttributeTypeName: { Value: `${type}Type` },
    IsCustomAttribute: true,
    IsManaged: false,
    IsCustomizable: { Value: true },
    IsValidForCreate: true,
    IsValidForRead: true,
    IsValidForUpdate: true,
    SourceType: 0,
    SourceTypeMask: 0,
    ...overrides,
  };
}

function table(logicalName, columns, overrides = {}) {
  return {
    logicalName,
    columns,
    manyToOneRelationships: [],
    oneToManyRelationships: [],
    manyToManyRelationships: [],
    alternateKeys: [],
    lookupTargets: {},
    computed: {},
    ...overrides,
  };
}

function concept(phrase, kind = 'entity', discoverTable = kind === 'entity') {
  return { phrase, kind, discoverTable, evidence: `Fixture brief mentions ${phrase}.` };
}

const REQUIREMENT_SETS = [
  {
    id: 'wildlife-rehabilitation',
    name: 'Wildlife rehabilitation',
    prompt: 'Plan a wildlife rehabilitation app for animal intake, medical assessments, care activities, enclosure assignment, and release events.',
    concepts: [
      concept('animals'),
      concept('medical assessments'),
      concept('care activities'),
      concept('enclosures'),
      concept('release events'),
    ],
    entities: [
      entity('wr_animal', 'Animal'),
      entity('wr_medicalassessment', 'Medical Assessment'),
      entity('wr_careactivity', 'Care Activity'),
      entity('wr_enclosure', 'Enclosure'),
      entity('wr_releaseevent', 'Release Event'),
      entity('wr_releaseeventv2', 'Release Event'),
      entity('demo_animal', 'Animal'),
    ],
    tables: [
      table('wr_animal', [
        column('wr_name'),
        column('wr_enclosureid', 'Lookup'),
        column('wr_releaseweight', 'Decimal', {
          SourceType: 1,
          SourceTypeMask: 1,
        }),
      ], {
        manyToOneRelationships: [{
          SchemaName: 'wr_Animal_Enclosure',
          ReferencingAttribute: 'wr_enclosureid',
          ReferencedEntity: 'wr_enclosure',
          ReferencedAttribute: 'wr_enclosureid',
          IsManaged: false,
        }],
        alternateKeys: [{
          LogicalName: 'wr_animal_intake_key',
          SchemaName: 'wr_AnimalIntakeKey',
          KeyAttributes: ['wr_name'],
          EntityKeyIndexStatus: 'Active',
          IsManaged: false,
        }],
        lookupTargets: { wr_enclosureid: ['wr_enclosure'] },
        computed: {
          wr_releaseweight: {
            sourceType: 1,
            sourceTypeMask: 1,
            formulaDefinition: 'wr_intakeweight - wr_weightloss',
          },
        },
      }),
      table('wr_medicalassessment', [
        column('wr_name'),
        column('wr_animalid', 'Lookup'),
      ], {
        manyToOneRelationships: [{
          SchemaName: 'wr_MedicalAssessment_Animal',
          ReferencingAttribute: 'wr_animalid',
          ReferencedEntity: 'wr_animal',
          ReferencedAttribute: 'wr_animalid',
          IsManaged: false,
        }],
        lookupTargets: { wr_animalid: ['wr_animal'] },
      }),
      table('wr_careactivity', [
        column('wr_name'),
        column('wr_animalid', 'Lookup'),
      ], {
        manyToOneRelationships: [{
          SchemaName: 'wr_CareActivity_Animal',
          ReferencingAttribute: 'wr_animalid',
          ReferencedEntity: 'wr_animal',
          ReferencedAttribute: 'wr_animalid',
          IsManaged: false,
        }],
        lookupTargets: { wr_animalid: ['wr_animal'] },
      }),
      table('wr_enclosure', [column('wr_name')]),
      table('wr_releaseevent', [
        column('wr_name'),
        column('wr_animalid', 'Lookup'),
      ], {
        manyToOneRelationships: [{
          SchemaName: 'wr_ReleaseEvent_Animal',
          ReferencingAttribute: 'wr_animalid',
          ReferencedEntity: 'wr_animal',
          ReferencedAttribute: 'wr_animalid',
          IsManaged: false,
        }],
        lookupTargets: { wr_animalid: ['wr_animal'] },
      }),
    ],
    expectedDetailed: [
      'wr_animal',
      'wr_medicalassessment',
      'wr_careactivity',
      'wr_enclosure',
      'wr_releaseevent',
    ],
    expectedRelationship: {
      table: 'wr_animal',
      lookupColumn: 'wr_enclosureid',
      targetTable: 'wr_enclosure',
    },
    expectedComputed: {
      table: 'wr_animal',
      logicalName: 'wr_releaseweight',
      sourceType: 1,
      sourceTypeMask: 1,
      formulaDefinition: 'wr_intakeweight - wr_weightloss',
    },
    proposedNames: ['wr_animal', 'wr_releasereview'],
    expectedCollision: 'wr_animal',
    expectedMissing: 'wr_releasereview',
  },
  {
    id: 'laboratory-chain-of-custody',
    name: 'Laboratory sample chain-of-custody',
    prompt: 'Plan a laboratory sample chain-of-custody app for samples, batches, custody transfers, test results, and evidence attachments.',
    concepts: [
      concept('samples'),
      concept('batches'),
      concept('custody transfers'),
      concept('test results'),
      concept('evidence attachments'),
    ],
    entities: [
      entity('lab_sample', 'Sample'),
      entity('lab_batch', 'Batch'),
      entity('lab_custodytransfer', 'Custody Transfer'),
      entity('lab_testresult', 'Test Result'),
      entity('lab_evidenceattachment', 'Evidence Attachment'),
      entity('lab_v3_sample', 'Sample'),
      entity('archive_custodytransfer', 'Custody Transfer'),
    ],
    tables: [
      table('lab_sample', [
        column('lab_name'),
        column('lab_batchid', 'Lookup'),
        column('lab_elapsedhours', 'Decimal', {
          SourceType: 3,
          SourceTypeMask: 4,
        }),
      ], {
        manyToOneRelationships: [{
          SchemaName: 'lab_Sample_Batch',
          ReferencingAttribute: 'lab_batchid',
          ReferencedEntity: 'lab_batch',
          ReferencedAttribute: 'lab_batchid',
          IsManaged: false,
        }],
        alternateKeys: [{
          LogicalName: 'lab_sample_barcode_key',
          SchemaName: 'lab_SampleBarcodeKey',
          KeyAttributes: ['lab_name'],
          EntityKeyIndexStatus: 'Active',
          IsManaged: false,
        }],
        lookupTargets: { lab_batchid: ['lab_batch'] },
        computed: {
          lab_elapsedhours: {
            sourceType: 3,
            sourceTypeMask: 4,
            formulaDefinition: 'DiffInHours(lab_collectedon, Now())',
          },
        },
      }),
      table('lab_batch', [column('lab_name')]),
      table('lab_custodytransfer', [
        column('lab_name'),
        column('lab_sampleid', 'Lookup'),
      ], {
        manyToOneRelationships: [{
          SchemaName: 'lab_CustodyTransfer_Sample',
          ReferencingAttribute: 'lab_sampleid',
          ReferencedEntity: 'lab_sample',
          ReferencedAttribute: 'lab_sampleid',
          IsManaged: false,
        }],
        lookupTargets: { lab_sampleid: ['lab_sample'] },
      }),
      table('lab_testresult', [
        column('lab_name'),
        column('lab_sampleid', 'Lookup'),
      ], {
        manyToOneRelationships: [{
          SchemaName: 'lab_TestResult_Sample',
          ReferencingAttribute: 'lab_sampleid',
          ReferencedEntity: 'lab_sample',
          ReferencedAttribute: 'lab_sampleid',
          IsManaged: false,
        }],
        lookupTargets: { lab_sampleid: ['lab_sample'] },
      }),
      table('lab_evidenceattachment', [
        column('lab_name'),
        column('lab_sampleid', 'Lookup'),
      ], {
        manyToOneRelationships: [{
          SchemaName: 'lab_EvidenceAttachment_Sample',
          ReferencingAttribute: 'lab_sampleid',
          ReferencedEntity: 'lab_sample',
          ReferencedAttribute: 'lab_sampleid',
          IsManaged: false,
        }],
        lookupTargets: { lab_sampleid: ['lab_sample'] },
      }),
    ],
    expectedDetailed: [
      'lab_sample',
      'lab_batch',
      'lab_custodytransfer',
      'lab_testresult',
      'lab_evidenceattachment',
    ],
    expectedRelationship: {
      table: 'lab_sample',
      lookupColumn: 'lab_batchid',
      targetTable: 'lab_batch',
    },
    expectedComputed: {
      table: 'lab_sample',
      logicalName: 'lab_elapsedhours',
      sourceType: 3,
      sourceTypeMask: 4,
      formulaDefinition: 'DiffInHours(lab_collectedon, Now())',
    },
    proposedNames: ['lab_sample', 'lab_storagecondition'],
    expectedCollision: 'lab_sample',
    expectedMissing: 'lab_storagecondition',
  },
  {
    id: 'warehouse-receiving-adversarial',
    name: 'Warehouse receiving with typed noise and collision',
    prompt: 'Plan receiving for field logisticians with shipments, line items, receptions, batch numbers, damage evidence, and limited connectivity.',
    concepts: [
      concept('goods items'),
      concept('expected shipments'),
      concept('expected shipment lines'),
      concept('goods receptions'),
      concept('goods reception lines'),
      concept('damage evidence attachments'),
      concept('field logisticians', 'role', false),
      concept('batch numbers', 'attribute', false),
      concept('limited connectivity', 'constraint', false),
    ],
    entities: [
      entity('new_goodsitem', 'Goods Item'),
      entity('new_expectedshipment', 'Expected Shipment'),
      entity('new_expectedshipmentline', 'Expected Shipment Line'),
      entity('new_goodsreception', 'Goods Reception'),
      entity('new_goodsreceptionline', 'Goods Reception Line'),
      entity('new_checkin', 'Evidence'),
      entity('new_damagephoto', 'Damage Photo'),
      entity('new_damageevidence', 'Damage Evidence'),
      entity('rollupfield', 'Field'),
      entity('fax', 'Fax'),
    ],
    tables: [
      table('new_goodsitem', [column('new_name')]),
      table('new_expectedshipment', [column('new_name')]),
      table('new_expectedshipmentline', [column('new_name')]),
      table('new_goodsreception', [column('new_name')]),
      table('new_goodsreceptionline', [
        column('new_name'),
        column('new_goodsreceptionid', 'Lookup'),
        column('new_quantityvariance', 'Decimal', { SourceType: 3, SourceTypeMask: 4 }),
      ], {
        manyToOneRelationships: [{
          SchemaName: 'new_GoodsReceptionLine_GoodsReception',
          ReferencingAttribute: 'new_goodsreceptionid',
          ReferencedEntity: 'new_goodsreception',
          ReferencedAttribute: 'new_goodsreceptionid',
          IsManaged: false,
        }],
        lookupTargets: { new_goodsreceptionid: ['new_goodsreception'] },
        computed: {
          new_quantityvariance: {
            sourceType: 3,
            sourceTypeMask: 4,
            formulaDefinition: 'new_receivedquantity - new_expectedquantity',
          },
        },
      }),
      table('new_checkin', [column('new_name')]),
      table('new_damagephoto', [column('new_name')]),
      table('new_damageevidence', [column('new_name')]),
    ],
    expectedDetailed: [
      'new_goodsitem',
      'new_expectedshipment',
      'new_expectedshipmentline',
      'new_goodsreception',
      'new_goodsreceptionline',
      'new_checkin',
      'new_damagephoto',
      'new_damageevidence',
    ],
    expectedRelationship: {
      table: 'new_goodsreceptionline',
      lookupColumn: 'new_goodsreceptionid',
      targetTable: 'new_goodsreception',
    },
    expectedComputed: {
      table: 'new_goodsreceptionline',
      logicalName: 'new_quantityvariance',
      sourceType: 3,
      sourceTypeMask: 4,
      formulaDefinition: 'new_receivedquantity - new_expectedquantity',
    },
    proposedNames: ['new_damageevidence', 'new_receivingexception'],
    expectedCollision: 'new_damageevidence',
    expectedMissing: 'new_receivingexception',
    expectedStrongCollision: 'new_damageevidence',
    expectedSkippedConcepts: ['field logisticians', 'batch numbers', 'limited connectivity'],
  },
];

function tableNameFromPath(apiPath) {
  const match = apiPath.match(/EntityDefinitions\(LogicalName='([^']+)'\)/);
  return match?.[1] || null;
}

function createFixtureRequest(requirementSet, calls) {
  const tables = new Map(requirementSet.tables.map((item) => [item.logicalName, item]));
  return async (_method, apiPath) => {
    calls.push(apiPath);
    if (apiPath.startsWith('EntityDefinitions?')) {
      if (apiPath.includes('IsCustomizable/Value eq true')) {
        return { status: 200, data: { value: requirementSet.entities } };
      }
      return {
        status: 200,
        data: {
          value: requirementSet.entities.filter(
            (item) => apiPath.includes(`LogicalName eq '${item.LogicalName}'`),
          ),
        },
      };
    }

    const logicalName = tableNameFromPath(apiPath);
    const fixture = tables.get(logicalName);
    if (!fixture) return { status: 404, error: `Unknown fixture table ${logicalName}` };
    if (apiPath.includes('$expand=Attributes(')) {
      return {
        status: 200,
        data: {
          LogicalName: logicalName,
          Attributes: fixture.columns,
          ManyToOneRelationships: fixture.manyToOneRelationships,
          OneToManyRelationships: fixture.oneToManyRelationships,
          ManyToManyRelationships: fixture.manyToManyRelationships,
          Keys: fixture.alternateKeys,
        },
      };
    }
    if (apiPath.includes('/Attributes?$select=')) {
      return { status: 200, data: { value: fixture.columns } };
    }
    if (apiPath.includes('/ManyToOneRelationships?')) {
      return { status: 200, data: { value: fixture.manyToOneRelationships } };
    }
    if (apiPath.includes('/OneToManyRelationships?')) {
      return { status: 200, data: { value: fixture.oneToManyRelationships } };
    }
    if (apiPath.includes('/ManyToManyRelationships?')) {
      return { status: 200, data: { value: fixture.manyToManyRelationships } };
    }
    if (apiPath.includes('/Keys?')) {
      return { status: 200, data: { value: fixture.alternateKeys } };
    }
    if (apiPath.includes('LookupAttributeMetadata')) {
      return {
        status: 200,
        data: {
          value: Object.entries(fixture.lookupTargets).map(([name, targets]) => ({
            LogicalName: name,
            Targets: targets,
          })),
        },
      };
    }
    if (/AttributeMetadata/.test(apiPath) && apiPath.includes('$expand=OptionSet')) {
      return { status: 200, data: { value: [] } };
    }

    const metadataId = apiPath.match(/\/Attributes\(([^)]+)\)\//)?.[1];
    if (metadataId) {
      const attribute = fixture.columns.find((item) => item.MetadataId === metadataId);
      const computed = fixture.computed[attribute?.LogicalName];
      if (!computed) return { status: 404, error: 'Computed metadata fixture missing' };
      return {
        status: 200,
        data: {
          LogicalName: attribute.LogicalName,
          SourceType: computed.sourceType,
          SourceTypeMask: computed.sourceTypeMask,
          FormulaDefinition: computed.formulaDefinition,
        },
      };
    }
    return { status: 200, data: { value: [] } };
  };
}

function normalizeEvidence(evidence) {
  return JSON.stringify(evidence);
}

async function evaluateRequirementSet(requirementSet) {
  const startedAt = process.hrtime.bigint();
  const calls = [];
  const snapshot = await createSnapshot({
    environmentUrl: 'https://fixture.crm.dynamics.com',
    tenantId: 'fixture-tenant',
    concepts: requirementSet.concepts,
    proposedTableNames: requirementSet.proposedNames,
    progressiveDetail: true,
    combinedBaseRead: true,
    request: createFixtureRequest(requirementSet, calls),
    nowIso: () => '2026-08-18T05:00:00.000Z',
  });
  const snapshotSource = JSON.stringify(snapshot);
  const evidence = buildArchitectEvidence(snapshot, sha256(snapshotSource));
  const normalizedEvidenceText = normalizeEvidence(evidence);
  const selectedNames = snapshot.tables.map((item) => item.logicalName).sort();
  const expectedNames = [...requirementSet.expectedDetailed].sort();
  const relationshipTable = snapshot.tables.find(
    (item) => item.logicalName === requirementSet.expectedRelationship.table,
  );
  const computedTable = snapshot.tables.find(
    (item) => item.logicalName === requirementSet.expectedComputed.table,
  );
  const computedColumn = computedTable?.columns.find(
    (item) => item.logicalName === requirementSet.expectedComputed.logicalName,
  );
  const checks = {
    candidateSelection: JSON.stringify(selectedNames) === JSON.stringify(expectedNames),
    relationshipExtraction: relationshipTable?.manyToOneRelationships.some((relationship) => (
      relationship.lookupColumn === requirementSet.expectedRelationship.lookupColumn
      && relationship.targetTable === requirementSet.expectedRelationship.targetTable
    )) || false,
    computedExtraction: computedColumn?.computed?.metadataStatus === 'available'
      && computedColumn.computed.sourceType === requirementSet.expectedComputed.sourceType
      && computedColumn.computed.sourceTypeMask === requirementSet.expectedComputed.sourceTypeMask
      && computedColumn.computed.formulaDefinition
        === requirementSet.expectedComputed.formulaDefinition,
    proposedNameChecks: snapshot.proposedNameChecks.collisions.some(
      (item) => item.logicalName === requirementSet.expectedCollision,
    ) && snapshot.proposedNameChecks.missing.includes(requirementSet.expectedMissing),
    evidenceOutput: expectedNames.every((name) => normalizedEvidenceText.includes(name))
      && normalizedEvidenceText.includes(requirementSet.expectedCollision)
      && normalizedEvidenceText.includes(requirementSet.expectedMissing)
      && evidence.selectedTables.length === snapshot.tables.length
      && evidence.concepts.every((item) => item.topCandidates.length <= 3),
    nonEntityConceptFiltering: (requirementSet.expectedSkippedConcepts || []).every(
      (phrase) => snapshot.candidateRanking.some((ranking) => (
        ranking.concept === phrase
        && ranking.discoverTable === false
        && ranking.candidates.length === 0
      ))),
    strongCollisionPromotion: !requirementSet.expectedStrongCollision
      || snapshot.selectedCandidateEvidence.some((item) => (
        item.logicalName === requirementSet.expectedStrongCollision
        && item.reasons.includes('proposed-collision:strong-concept-phrase')
      )),
  };
  const passedChecks = Object.values(checks).filter(Boolean).length;
  const totalChecks = Object.keys(checks).length;
  const elapsedLocalProcessingMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

  return {
    id: requirementSet.id,
    name: requirementSet.name,
    prompt: requirementSet.prompt,
    requiredConceptCount: requirementSet.concepts.filter((item) => item.discoverTable).length,
    selectedCandidateCount: selectedNames.length,
    selectedCandidates: selectedNames,
    detailedCandidateBreakdown: {
      required: snapshot.detailLoadSummary.requiredCandidates || 0,
      advisory: snapshot.detailLoadSummary.advisoryCandidates || 0,
      exactCoveredConcepts: snapshot.detailLoadSummary.exactCoveredConcepts || 0,
      advisoryLimit: snapshot.detailLoadSummary.advisoryLimit || 40,
      primary: snapshot.detailLoadSummary.primaryCandidates || 0,
      ambiguity: snapshot.detailLoadSummary.ambiguityCandidates || 0,
      strongCollisions: snapshot.detailLoadSummary.strongCollisionCandidates || 0,
      deferred: snapshot.detailLoadSummary.deferredCandidates || 0,
      core: snapshot.detailLoadSummary.coreCandidates || 0,
      full: snapshot.detailLoadSummary.fullCandidates || 0,
      loaded: snapshot.detailLoadSummary.loadedCandidates || 0,
      failed: snapshot.detailLoadSummary.failedCandidates || 0,
    },
    metadataRequests: {
      snapshotForegroundRequests: calls.length,
      snapshotFirstAgentRequests: 0,
      byCategory: calls.reduce((counts, apiPath) => {
        const category = metadataRequestIdentity(apiPath).category;
        counts[category] = (counts[category] || 0) + 1;
        return counts;
      }, {}),
    },
    outputCompleteness: {
      checks,
      passedChecks,
      totalChecks,
      percent: Math.round((passedChecks / totalChecks) * 100),
    },
    snapshotBytes: Buffer.byteLength(snapshotSource),
    architectEvidenceBytes: Buffer.byteLength(normalizedEvidenceText),
    evidenceCharacters: normalizedEvidenceText.length,
    elapsedLocalProcessingMs: Number(elapsedLocalProcessingMs.toFixed(3)),
  };
}

async function runBenchmark(requirementSets = REQUIREMENT_SETS) {
  return {
    version: 2,
    methodology: 'Fixture-backed execution through typed createSnapshot and compact architect evidence',
    limitation: 'Matched agent A/B runs are still required for model decision and timing claims.',
    scenarios: await Promise.all(requirementSets.map(evaluateRequirementSet)),
  };
}

function renderBenchmarkMarkdown(result) {
  const lines = [
    '# Dataverse snapshot-first planning benchmark',
    '',
    `> ${result.limitation}`,
    '',
    '| Requirements set | Selected | Core / full / failed | Primary / ambiguity / collision | Deferred | Fixture requests | Completeness | Snapshot / sidecar | Local processing |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const scenario of result.scenarios) {
    lines.push(
      `| ${scenario.name} | ${scenario.selectedCandidateCount} | `
      + `${scenario.detailedCandidateBreakdown.core} / ${scenario.detailedCandidateBreakdown.full} / ${scenario.detailedCandidateBreakdown.failed} | `
      + `${scenario.detailedCandidateBreakdown.primary} / ${scenario.detailedCandidateBreakdown.ambiguity} / ${scenario.detailedCandidateBreakdown.strongCollisions} | `
      + `${scenario.detailedCandidateBreakdown.deferred} | `
      + `${scenario.metadataRequests.snapshotForegroundRequests} | `
      + `${scenario.outputCompleteness.passedChecks}/${scenario.outputCompleteness.totalChecks} `
      + `(${scenario.outputCompleteness.percent}%) | `
      + `${scenario.snapshotBytes} / ${scenario.architectEvidenceBytes} bytes | `
      + `${scenario.elapsedLocalProcessingMs.toFixed(3)} ms |`,
    );
  }
  lines.push(
    '',
    '## Request categories',
    '',
    ...result.scenarios.map((scenario) => {
      const categories = Object.entries(scenario.metadataRequests.byCategory)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([category, count]) => `${category}=${count}`)
        .join(', ');
      return `- ${scenario.name}: ${categories}`;
    }),
    '',
    'Each scenario executes typed candidate selection, progressive detail loading, relationship and computed-column extraction, proposed-name checks, request classification, and compact architect evidence against injected Dataverse responses.',
    '',
    'The request count is the actual fixture executor call count. It does not measure network latency or agent behavior, and it does not substitute for matched agent A/B decision and timing runs.',
    '',
  );
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv);
  const result = await runBenchmark();
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(renderBenchmarkMarkdown(result));
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  REQUIREMENT_SETS,
  createFixtureRequest,
  evaluateRequirementSet,
  normalizeEvidence,
  renderBenchmarkMarkdown,
  runBenchmark,
};
