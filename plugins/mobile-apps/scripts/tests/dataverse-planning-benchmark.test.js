'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  REQUIREMENT_SETS,
  renderBenchmarkMarkdown,
  runBenchmark,
} = require('../benchmark-dataverse-planning');

test('fixture benchmark covers wildlife and an unrelated laboratory workflow', async () => {
  const result = await runBenchmark();
  assert.equal(result.scenarios.length, 2);
  assert.deepEqual(
    result.scenarios.map((scenario) => scenario.id),
    ['wildlife-rehabilitation', 'laboratory-chain-of-custody'],
  );
  for (const scenario of result.scenarios) {
    assert.equal(scenario.requiredConceptCount, 5);
    assert.ok(scenario.selectedCandidateCount >= 5);
    assert.equal(scenario.metadataRequests.snapshotFirstAgentRequests, 0);
    assert.ok(scenario.metadataRequests.snapshotForegroundRequests > 0);
    assert.equal(scenario.outputCompleteness.percent, 100);
    assert.deepEqual(scenario.outputCompleteness.checks, {
      candidateSelection: true,
      relationshipExtraction: true,
      computedExtraction: true,
      proposedNameChecks: true,
      evidenceOutput: true,
    });
    assert.ok(scenario.evidenceCharacters > 0);
    assert.ok(scenario.elapsedLocalProcessingMs >= 0);
  }
});

test('benchmark report is explicit about real fixture execution and A/B limitations', async () => {
  const markdown = renderBenchmarkMarkdown(await runBenchmark(REQUIREMENT_SETS));
  assert.match(markdown, /Wildlife rehabilitation/);
  assert.match(markdown, /Laboratory sample chain-of-custody/);
  assert.match(markdown, /Foreground fixture requests/);
  assert.match(markdown, /Snapshot-first agent requests/);
  assert.match(markdown, /real snapshot candidate selection/);
  assert.match(markdown, /Matched agent A\/B runs are still required/);
  assert.match(markdown, /matched agent A\/B decision and timing runs/);
});
