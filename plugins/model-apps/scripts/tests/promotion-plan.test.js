'use strict';
// Promotion planning (lib/promotion-plan.js, scripts/plan-app-promotion.js): plan only. Pinned here: the SDK input is
// built from the maker's explicit choices (the non-atomic-import acknowledgement only when granted, deployment-settings
// values and connections mapped, empty ones left for the SDK to report missing); the result lists every refusal and
// requirement and echoes no value or connection id; a refused or unknown plan is never followed by an import or a
// promote; a write attempt during planning is refused before it is sent and fails the result; and over the REAL bundle an
// unreadable package is refused before either environment is read.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const pp = require('../lib/promotion-plan.js');
const { planFromFlags } = require('../plan-app-promotion.js');

const SOURCE = 'https://contoso-dev.crm.dynamics.com';
const TARGET = 'https://contoso-test.crm.dynamics.com';
const SECRET = 'SENTINEL-secret-value';
const settings = {
  EnvironmentVariables: [{ SchemaName: 'contoso_ApiBase', Value: SECRET }, { SchemaName: 'contoso_Empty', Value: '' }],
  ConnectionReferences: [{ LogicalName: 'contoso_sql', ConnectionId: 'conn-SENTINEL-id', ConnectorId: '/providers/x' }, { LogicalName: 'contoso_unmapped', ConnectionId: '' }],
};

function refusedPlan(intent) {
  return {
    schemaVersion: 1, planId: 'p', planDigest: 'd'.repeat(64), outcome: 'refused', importKind: 'undetermined',
    package: { sha256: 'a'.repeat(64), solutionUniqueName: 'ContosoTickets', version: '1.0.0.0', managed: true, publisherUniqueName: 'contoso', publisherPrefix: 'contoso', projectionVersion: '1' },
    intent: { settingOverrides: [], ...intent },
    coverage: [
      { id: 'c1', coverageId: 'c1', subject: { kind: 'table', logicalName: 'contoso_ticket' }, relevance: 'namedApp', delivery: 'refused', required: true, checks: [], complete: false },
      { id: 'c2', coverageId: 'c2', subject: { kind: 'app', uniqueName: 'contoso_Tickets' }, relevance: 'namedApp', delivery: 'solution', required: true, checks: [], complete: true },
    ],
    steps: [], checks: [], observations: [],
    problems: [
      { code: 'PROMOTION_COVERAGE_GAP', phase: 'preflight', blocking: true, message: 'A table cannot be promoted by this version.', subject: { kind: 'table', logicalName: 'contoso_ticket' } },
      { code: 'PROMOTION_NON_ATOMIC_IMPORT_NOT_ACKNOWLEDGED', phase: 'preflight', blocking: true, message: 'The import is not atomic; acknowledge it.' },
    ],
    reads: { getAttempts: 7, layerLookups: 0, layerPages: 0, components: 2, elapsedMs: 5, complete: true },
  };
}

function stubSdks({ write } = {}) {
  const seen = { inputs: [], promoted: 0 };
  const makeSdk = (client, side) => ({
    side,
    async planPromotion(source, input) {
      assert.equal(side, 'target');
      assert.equal(source.side, 'source');
      seen.inputs.push(input);
      if (write) await client.post(`${TARGET}/api/data/v9.2/ImportSolution`, {}).catch(() => {});
      await client.get(`${TARGET}/api/data/v9.2/WhoAmI`);
      return refusedPlan({ appUniqueName: input.appUniqueName, mode: 'managed', values: input.values, connections: input.connections, requirements: input.requirements, overwriteUnmanagedCustomizations: input.overwriteUnmanagedCustomizations, publishWorkflows: input.publishWorkflows, acknowledgeNonAtomicImport: input.acknowledgeNonAtomicImport, publishApp: input.publishApp });
    },
    promote() { seen.promoted += 1; throw new Error('promote must never be called'); },
    importSolution() { seen.promoted += 1; throw new Error('import must never be called'); },
  });
  const http = () => ({ calls: [], async get(url) { this.calls.push(['GET', url]); return { status: 200, body: {} }; }, async post(url) { this.calls.push(['POST', url]); return { status: 204 }; } });
  return { seen, makeSdk, source: http(), target: http() };
}

test('the SDK input carries only what the maker chose; the result lists refusals and echoes no value', async () => {
  const s = stubSdks();
  const result = await pp.planAppPromotion({ sourceHttpClient: s.source, targetHttpClient: s.target, makeSdk: s.makeSdk, input: { packageBytes: Buffer.from('zip'), appUniqueName: 'contoso_Tickets', settings } });
  const input = s.seen.inputs[0];
  assert.equal(input.acknowledgeNonAtomicImport, false, 'never acknowledged on the maker\'s behalf');
  assert.equal(input.overwriteUnmanagedCustomizations, false);
  assert.deepEqual(input.values, [{ schemaName: 'contoso_ApiBase', value: SECRET }]);
  assert.deepEqual(input.connections, [{ logicalName: 'contoso_sql', connectionId: 'conn-SENTINEL-id' }]);
  assert.deepEqual(input.requirements, []);
  assert.equal(typeof input.codec.inflateRaw, 'function');
  assert.equal(input.codec.sha256(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(result.ok, false);
  assert.equal(result.applied, false);
  assert.equal(result.fallbackImport, false);
  assert.equal(result.plan.outcome, 'refused');
  assert.deepEqual(result.plan.refusals.map((p) => p.code), ['PROMOTION_COVERAGE_GAP', 'PROMOTION_NON_ATOMIC_IMPORT_NOT_ACKNOWLEDGED']);
  assert.deepEqual(result.plan.coverage.refused, [{ kind: 'table', logicalName: 'contoso_ticket' }]);
  assert.deepEqual(result.plan.coverage.byDelivery, { refused: 1, solution: 1 });
  assert.equal(result.plan.intent.values, 1);
  assert.equal(JSON.stringify(result).includes('SENTINEL'), false, 'no value or connection id in the result');
  assert.equal(s.seen.promoted, 0);
  assert.deepEqual([...s.source.calls, ...s.target.calls].filter(([m]) => m !== 'GET'), []);
});

test('the acknowledgement and the other switches are sent only when granted', async () => {
  const s = stubSdks();
  await pp.planAppPromotion({ sourceHttpClient: s.source, targetHttpClient: s.target, makeSdk: s.makeSdk, input: { packageBytes: Buffer.from('zip'), appUniqueName: 'a', acknowledgeNonAtomicImport: true, publishWorkflows: true, publishApp: 'yes' } });
  const input = s.seen.inputs[0];
  assert.equal(input.acknowledgeNonAtomicImport, true);
  assert.equal(input.publishWorkflows, true);
  assert.equal(input.publishApp, false, 'only a real true grants a switch');
  assert.throws(() => pp.promotionInputOf({ packageBytes: Buffer.alloc(0), appUniqueName: 'a' }), { code: 'PROMOTION_PLAN_INPUT_INVALID' });
  assert.throws(() => pp.promotionInputOf({ packageBytes: Buffer.from('z'), appUniqueName: 'a', mode: 'both' }), { code: 'PROMOTION_PLAN_INPUT_INVALID' });
  assert.throws(() => pp.deploymentSettingsOf({ EnvironmentVariables: {} }), { code: 'PROMOTION_PLAN_INPUT_INVALID' });
});

test('a write attempted while planning is refused before it is sent and fails the result', async () => {
  const s = stubSdks({ write: true });
  const result = await pp.planAppPromotion({ sourceHttpClient: s.source, targetHttpClient: s.target, makeSdk: s.makeSdk, input: { packageBytes: Buffer.from('zip'), appUniqueName: 'a' } });
  assert.equal(result.writeAttempts, 1);
  assert.equal(result.ok, false);
  assert.deepEqual(s.target.calls.filter(([m]) => m !== 'GET'), [], 'the POST never reached the transport');
});

test('real bundle: an unreadable package is refused before either environment is read, and nothing is written', async () => {
  const requests = [];
  const request = async ({ url, method }) => { requests.push(`${method} ${url}`); return { statusCode: 501, headers: {}, body: '' }; };
  const token = 'x'.repeat(48);
  const dir = makeTempDir('promotion-plan-');
  const pkg = path.join(dir, 'not-a-solution.zip');
  fs.writeFileSync(pkg, 'this is not a zip file');
  const result = await planFromFlags({ 'source-env': SOURCE, 'target-env': TARGET, package: pkg, app: 'contoso_Tickets' }, {
    source: createAzHttpClient(SOURCE, { getToken: () => token, request, sleep: async () => {} }),
    target: createAzHttpClient(TARGET, { getToken: () => token, request, sleep: async () => {} }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'PROMOTION_PACKAGE_UNREADABLE');
  assert.equal(result.applied, false);
  assert.deepEqual(requests, []);
});

test('the CLI has no apply: an extra argument or an unknown flag is refused', () => {
  const script = path.join(__dirname, '..', 'plan-app-promotion.js');
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const base = ['--source-env', SOURCE, '--target-env', TARGET, '--package', 'x.zip', '--app', 'a'];
  for (const args of [['apply', ...base], [...base, '--apply'], [...base, '--acknowledge-non-atomic-import', 'yes'], base.slice(2)]) {
    const r = spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8' });
    assert.equal(r.status, 1, args.join(' '));
  }
});
