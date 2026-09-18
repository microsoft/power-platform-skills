'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  REQUIREMENT_SETS,
  createFixtureRequest,
  createScaleScenario,
  renderBenchmarkMarkdown,
  runBenchmark,
} = require('../benchmark-dataverse-planning');
const { createSnapshot, createReconciliationSnapshot } = require('../create-dataverse-snapshot');
const { createDataverseRequestExecutor } = require('../dataverse-request');

test('benchmark scenarios run sequentially without contaminating individual timings', async () => {
  const events = [];
  const fixtures = REQUIREMENT_SETS.slice(0, 2).map((fixture, index) => {
    let started = false;
    return {
      ...fixture,
      get concepts() {
        if (!started) events.push(`start:${index}`);
        started = true;
        return fixture.concepts;
      },
      get name() {
        events.push(`finish:${index}`);
        return fixture.name;
      },
    };
  });
  await runBenchmark(fixtures);
  assert.deepEqual(events, ['start:0', 'finish:0', 'start:1', 'finish:1']);
});

test('combined-read compatibility fallback never masks access, transient, or malformed responses', async () => {
  const fixture = createScaleScenario(6, 'base');
  const options = {
    environmentUrl: 'https://fixture.crm.dynamics.com', tenantId: 'fixture-tenant',
    tableNames: fixture.expectedDetailed, combinedBaseRead: true,
  };
  for (const status of [401, 403, 404, 429, 500, 503]) {
    const calls = [];
    const request = createFixtureRequest(fixture, calls);
    await assert.rejects(createReconciliationSnapshot({ ...options,
      request: (method, apiPath) => apiPath.includes('$expand=Attributes(')
        ? Promise.resolve({ status, data: { error: { message: 'Metadata request failed' } } })
        : request(method, apiPath),
    }), new RegExp(String(status)));
    assert.ok(calls.every((apiPath) => !apiPath.includes('/Attributes?')));
  }
  const request = createFixtureRequest(fixture, []);
  await assert.rejects(createReconciliationSnapshot({ ...options,
    request: (method, apiPath) => apiPath.includes('$expand=Attributes(')
      ? Promise.resolve({ status: 200, data: { Attributes: [] } })
      : request(method, apiPath),
  }), /omitted/);
  let unsupportedProbes = 0;
  const supported = await createReconciliationSnapshot({ ...options,
    request: (method, apiPath) => {
      if (apiPath.includes('$expand=Attributes(')) {
        unsupportedProbes += 1;
        return Promise.resolve({ status: 501, data: { error: { message: 'Not implemented' } } });
      }
      return request(method, apiPath);
    },
  });
  assert.equal(unsupportedProbes, 1);
  assert.equal(supported.tables.length, fixture.expectedDetailed.length);
});

for (const tableCount of [6, 12, 24]) {
  test(`${tableCount}-table discovery is equivalent across concurrency, cache, and combined-read fallback`, async () => {
    const fixture = createScaleScenario(tableCount, 'worst');
    const options = {
      environmentUrl: 'https://fixture.crm.dynamics.com', tenantId: 'fixture-tenant',
      concepts: fixture.concepts, tableNames: fixture.expectedDetailed,
      proposedTableNames: fixture.proposedNames, progressiveDetail: true,
      nowIso: () => '2026-08-18T05:00:00.000Z',
    };
    const baseline = await createSnapshot({ ...options,
      request: createFixtureRequest(fixture, []), combinedBaseRead: true });
    for (const readConcurrency of [1, 2, 3, 4]) {
      for (const combinedBaseRead of [false, true]) {
        const result = await createSnapshot({ ...options, readConcurrency, combinedBaseRead,
          request: createFixtureRequest(fixture, []) });
        assert.deepEqual(result.tables, baseline.tables);
        assert.deepEqual(result.candidateRanking, baseline.candidateRanking);
        assert.deepEqual(result.proposedNameChecks, baseline.proposedNameChecks);
      }
    }
    const cachedCalls = [];
    const cached = await createSnapshot({ ...options,
      request: createFixtureRequest(fixture, cachedCalls), combinedBaseRead: true,
      inventory: baseline.inventory, inventorySource: 'cache', inventoryCacheAgeMs: 1000 });
    assert.deepEqual(cached.tables, baseline.tables);
    assert.ok(cachedCalls.every((apiPath) => !apiPath.includes('IsCustomizable/Value')));
    assert.deepEqual(cached.proposedNameChecks, baseline.proposedNameChecks);
    const request = createFixtureRequest(fixture, []);
    let fallbackCount = 0;
    const fallback = await createSnapshot({ ...options, combinedBaseRead: true,
      request: async (method, apiPath) => {
        if (apiPath.includes('$expand=Attributes(')) {
          fallbackCount += 1;
          return { status: 400, data: { error: { message: 'Unsupported metadata expansion' } } };
        }
        return request(method, apiPath);
      } });
    assert.equal(fallbackCount, 1);
    assert.deepEqual(fallback.tables, baseline.tables);
    const removedName = fixture.expectedDetailed[0];
    const changedFixture = { ...fixture,
      entities: fixture.entities.filter((item) => item.LogicalName !== removedName) };
    const staleCache = await createSnapshot({ ...options, combinedBaseRead: true,
      request: createFixtureRequest(changedFixture, []),
      inventory: baseline.inventory, inventorySource: 'cache', inventoryCacheAgeMs: 1000 });
    assert.ok(staleCache.exactNameResolution.unavailableTables.includes(removedName));
    assert.ok(staleCache.tables.every((item) => item.logicalName !== removedName));
  });

  test(`${tableCount}-table discovery retries recover and execution reconciliation fails closed`, async (testContext) => {
    const fixture = createScaleScenario(tableCount, 'worst');
    const options = {
      environmentUrl: 'https://fixture.crm.dynamics.com', tenantId: 'fixture-tenant',
      concepts: fixture.concepts, tableNames: fixture.expectedDetailed,
      proposedTableNames: fixture.proposedNames, progressiveDetail: true,
      combinedBaseRead: true, readConcurrency: 4,
    };
    const fixtureRequest = createFixtureRequest(fixture, []);
    const delays = [];
    const telemetry = [];
    const injected = new Set();
    let tokenCount = 0;
    const request = createDataverseRequestExecutor({
      environmentUrl: options.environmentUrl, tenantId: options.tenantId,
      getToken: async () => `fixture-token-${++tokenCount}`,
      sleep: async (delayMs) => { delays.push(delayMs); },
      onTelemetry: (event) => telemetry.push(event),
      sendRequest: async (_environmentUrl, method, apiPath) => {
        const fault = apiPath.includes('IsCustomizable/Value') ? 503
          : apiPath.includes('$expand=Attributes(') ? 429
          : apiPath.includes('StringAttributeMetadata') ? 401 : null;
        if (fault && !injected.has(fault)) {
          injected.add(fault);
          return { statusCode: fault, headers: { 'retry-after': '2' }, body: '{}' };
        }
        const result = await fixtureRequest(method, apiPath);
        return { statusCode: result.status, headers: {}, body: JSON.stringify(result.data) };
      },
    });
    const recovered = await createSnapshot({ ...options, request });
    assert.deepEqual(recovered.detailLoadFailures, []);
    assert.deepEqual([...injected].sort(), [401, 429, 503]);
    assert.deepEqual(request.getAuthStats(), { tokenAcquisitionCount: 1, tokenRefreshCount: 1 });
    assert.equal(telemetry.reduce((total, event) => total + event.retryCount, 0), 3);
    assert.equal(delays.reduce((total, delayMs) => total + delayMs, 0), 7000);
    const failedTable = fixture.expectedDetailed[0];
    const unavailableRequest = (method, apiPath) => apiPath.includes(`LogicalName='${failedTable}'`)
      && apiPath.includes('StringAttributeMetadata')
      ? Promise.resolve({ status: 404, data: { error: { message: 'Typed metadata unavailable' } } })
      : fixtureRequest(method, apiPath);
    const partial = await createSnapshot({ ...options, request: unavailableRequest });
    assert.ok(partial.detailLoadFailures.some((item) => item.logicalName === failedTable));
    await assert.rejects(createReconciliationSnapshot({ ...options, request: unavailableRequest }), /404/);
    await assert.rejects(createSnapshot({ ...options,
      request: async () => ({ status: 403, data: { error: { message: 'Access denied' } } }) }), /403/);
    testContext.diagnostic(JSON.stringify({ tableCount, recoveredRetries: 3,
      modeledBackoffMs: 7000, tokenRefreshes: 1,
      timingScope: 'retry delays captured by an injected wait function; not measured wall time' }));
  });
}

test('scaled warehouse fixtures preserve exact tables and typed evidence at every size', async () => {
  for (const tableCount of [6, 12, 24]) {
    for (const profile of ['best', 'base', 'worst']) {
      const fixture = createScaleScenario(tableCount, profile);
      const snapshot = await createSnapshot({
        environmentUrl: 'https://fixture.crm.dynamics.com', tenantId: 'fixture-tenant',
        concepts: fixture.concepts, tableNames: fixture.expectedDetailed,
        proposedTableNames: fixture.proposedNames, progressiveDetail: true, combinedBaseRead: true,
        request: createFixtureRequest(fixture, []),
      });
      assert.equal(fixture.contract.tables.length, tableCount);
      assert.deepEqual(snapshot.detailLoadFailures, []);
      for (const logicalName of fixture.expectedDetailed) {
        const table = snapshot.tables.find((item) => item.logicalName === logicalName);
        assert.ok(table, `${fixture.id}: missing ${logicalName}`);
        assert.equal(table.detailLevel, 'full');
        assert.equal(table.columns[0].maxLength, 200);
      }
      assert.ok(snapshot.candidateRanking.filter((item) => !item.discoverTable)
        .every((item) => item.candidates.length === 0));
      assert.deepEqual(snapshot.proposedNameChecks.missing.sort(), fixture.proposedNames.slice().sort());
    }
  }
  assert.throws(() => createScaleScenario(5, 'best'), /6, 12, or 24/);
  assert.throws(() => createScaleScenario(6, 'unknown'), /best, base, or worst/);
});

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
  assert.match(markdown, /Matched agent A\/B runs are still required/);
  assert.match(markdown, /matched agent A\/B decision and timing runs/);
});
