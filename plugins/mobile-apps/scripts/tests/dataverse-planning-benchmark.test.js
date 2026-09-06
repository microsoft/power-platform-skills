'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  REQUIREMENT_SETS,
  renderBenchmarkMarkdown,
  runBenchmark,
} = require('../benchmark-dataverse-planning');

test('fixture benchmark covers typed domain and adversarial receiving workflows', async () => {
  const result = await runBenchmark();
  assert.equal(result.scenarios.length, 3);
  assert.deepEqual(
    result.scenarios.map((scenario) => scenario.id),
    [
      'wildlife-rehabilitation',
      'laboratory-chain-of-custody',
      'warehouse-receiving-adversarial',
    ],
  );
  for (const scenario of result.scenarios) {
    assert.equal(scenario.detailedCandidateBreakdown.required, 0);
    assert.equal(scenario.detailedCandidateBreakdown.exactCoveredConcepts, 0);
    assert.equal(scenario.detailedCandidateBreakdown.advisoryLimit, 40);
    assert.equal(
      scenario.detailedCandidateBreakdown.loaded
        + scenario.detailedCandidateBreakdown.failed,
      scenario.detailedCandidateBreakdown.advisory,
    );
    assert.equal(scenario.metadataRequests.snapshotFirstAgentRequests, 0);
    assert.ok(scenario.metadataRequests.snapshotForegroundRequests > 0);
    assert.ok(Object.keys(scenario.metadataRequests.byCategory).length > 0);
    assert.equal(scenario.outputCompleteness.percent, 100);
    assert.deepEqual(scenario.outputCompleteness.checks, {
      candidateSelection: true,
      relationshipExtraction: true,
      computedExtraction: true,
      proposedNameChecks: true,
      evidenceOutput: true,
      nonEntityConceptFiltering: true,
      strongCollisionPromotion: true,
    });
    assert.ok(scenario.evidenceCharacters > 0);
    assert.ok(scenario.architectEvidenceBytes < scenario.snapshotBytes);
    assert.ok(scenario.elapsedLocalProcessingMs >= 0);
  }

  assert.deepEqual(result.workloads.map((item) => item.id), ['small', 'medium', 'large']);
  assert.deepEqual(result.workloads.map((item) => item.workload.tables), [3, 10, 20]);
  assert.deepEqual(result.workloads.map((item) => item.workload.columns), [15, 100, 400]);
  assert.deepEqual(result.workloads.map((item) => item.workload.relationships), [2, 9, 19]);
  assert.deepEqual(result.workloads.map((item) => item.workload.alternateKeys), [3, 10, 20]);
  assert.deepEqual(result.workloads.map((item) => item.workload.metadataOperations), [9, 30, 60]);
  assert.deepEqual(result.workloads.map((item) => item.workload.services), [3, 10, 20]);
  for (const workload of result.workloads) {
    assert.ok(workload.workload.metadataRequests > 0);
    assert.ok(Object.values(workload.stagesMs).every((duration) => duration >= 0));
    assert.ok(workload.bytes.compactEvidence < workload.bytes.snapshot);
  }

  const receiving = result.scenarios[2];
  assert.equal(receiving.requiredConceptCount, 6);
  assert.equal(receiving.selectedCandidateCount, 8);
  assert.deepEqual(receiving.detailedCandidateBreakdown, {
    required: 0,
    advisory: 8,
    exactCoveredConcepts: 0,
    advisoryLimit: 40,
    primary: 6,
    ambiguity: 1,
    strongCollisions: 1,
    deferred: 0,
    core: 2,
    full: 6,
    loaded: 8,
    failed: 0,
  });
});

test('benchmark report is explicit about real fixture execution and A/B limitations', async () => {
  const markdown = renderBenchmarkMarkdown(await runBenchmark(REQUIREMENT_SETS));
  assert.match(markdown, /Wildlife rehabilitation/);
  assert.match(markdown, /Laboratory sample chain-of-custody/);
  assert.match(markdown, /Warehouse receiving with typed noise and collision/);
  assert.match(markdown, /Core \/ full \/ failed/);
  assert.match(markdown, /combined-base-metadata=/);
  assert.match(markdown, /Primary \/ ambiguity \/ collision/);
  assert.match(markdown, /Snapshot \/ sidecar/);
  assert.match(markdown, /## Request categories/);
  assert.match(markdown, /typed candidate selection/);
  assert.match(markdown, /compact architect evidence/);
  assert.match(markdown, /## Synthetic workload scaling/);
  assert.match(markdown, /Metadata operations/);
  assert.match(markdown, /local orchestration only/);
  assert.match(markdown, /Matched agent A\/B runs are still required/);
  assert.match(markdown, /matched agent A\/B decision and timing runs/);
});
