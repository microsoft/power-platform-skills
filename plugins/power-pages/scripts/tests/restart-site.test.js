const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { restartSite } = require('../restart-site');
const { buildInitialState } = require('../../skills/migrate-datamodel/scripts/lib/migration-state-schema');
const { renderLiveReport } = require('../../skills/migrate-datamodel/scripts/lib/render-live-report');

const portalId = '00000000-0000-0000-0000-000000000001';
const environmentId = '00000000-0000-0000-0000-000000000002';
const environmentUrl = 'https://contoso.crm.dynamics.com';
const websiteUrl = 'https://contoso.powerappsportals.com';

function fixture({ statuses = [], health = [], post = { ok: true, statusCode: 200 } } = {}) {
  const calls = [];
  const probes = [];
  const sleeps = [];
  const progress = [];
  let index = 0;
  const site = (status = 'OperationComplete') => ({
    id: portalId, websiteUrl, status,
    // The activated EDM record need not be the original SDM record.
    websiteRecordId: '00000000-0000-0000-0000-000000000003',
  });
  const deps = {
    getEnvironmentUrl: () => environmentUrl,
    resolveContext: () => ({
      environmentId, apiHost: 'https://api.powerplatform.com',
      baseUrl: `https://api.powerplatform.com/powerpages/environments/${environmentId}`, token: 'test-token',
    }),
    async request(options) {
      calls.push(options);
      if (options.method === 'POST') return post;
      const current = index++;
      const selected = statuses[current] || 'OperationComplete';
      if (typeof selected === 'object') return selected;
      return { ok: true, statusCode: 200, body: site(selected) };
    },
    async makeRequest(options) {
      probes.push(options);
      return health[probes.length - 1] || { statusCode: 200 };
    },
    async sleep(ms) { sleeps.push(ms); },
    onProgress(record) { progress.push(record); },
  };
  return { deps, calls, probes, sleeps, progress, options: { portalId, environmentUrl, websiteUrl, approved: true } };
}

test('approved restart uses the API Portal ID and verifies operation status and anonymous reachability', async () => {
  const f = fixture();
  const result = await restartSite(f.options, f.deps);
  assert.equal(result.success, true);
  assert.equal(result.restartSubmitted, true);
  assert.equal(result.websiteReachable, true);
  assert.equal(result.attempts, 2);
  const posts = f.calls.filter((call) => call.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, `/websites/${portalId}/restart`);
  assert.equal(posts[0].query['api-version'], '2024-10-01');
  assert.equal(posts[0].timeout, 30000);
  assert.ok(f.probes.every((probe) => probe.url === `${websiteUrl}/` &&
    !Object.keys(probe.headers).some((key) => /authorization|cookie/i.test(key))));
  assert.deepEqual(f.sleeps, [15000, 15000]);
  assert.equal(f.progress[0].event, 'restart-submitted');
});

test('missing approval, malformed identifiers and unsafe URLs cannot invoke auth or HTTP', async () => {
  for (const patch of [
    { approved: false }, { approved: 'true' }, { approved: true, verifyOnly: true },
    { portalId: null }, { portalId: '../other-site' }, { environmentUrl: null },
    { environmentUrl: 'https://example.com' }, { websiteUrl: null },
    { websiteUrl: 'http://contoso.powerappsportals.com' },
    { websiteUrl: 'https://user:password@contoso.powerappsportals.com' },
    { websiteUrl: 'https://contoso.powerappsportals.com:8443' },
  ]) {
    const f = fixture();
    let authCalled = false;
    f.deps.getEnvironmentUrl = () => { authCalled = true; return environmentUrl; };
    await assert.rejects(restartSite({ ...f.options, ...patch }, f.deps));
    assert.equal(authCalled, false);
    assert.equal(f.calls.length, 0);
  }
});

test('environment mismatch and sign-in failures stop before any API mutation', async () => {
  for (const active of [null, 'https://fabrikam.crm.dynamics.com']) {
    const f = fixture();
    f.deps.getEnvironmentUrl = () => active;
    await assert.rejects(restartSite(f.options, f.deps), /does not match/);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  f.deps.resolveContext = () => ({ error: 'Azure CLI is not signed in. Run: az login' });
  await assert.rejects(restartSite(f.options, f.deps), /Azure CLI/);
  assert.equal(f.calls.length, 0);
});

test('invalid API context cannot send management credentials to another host', async () => {
  const f = fixture();
  f.deps.resolveContext = () => ({ environmentId, apiHost: 'https://example.com', baseUrl: 'https://example.com', token: 'test-token' });
  await assert.rejects(restartSite(f.options, f.deps), /Invalid Power Platform/);
  assert.equal(f.calls.length, 0);
});

test('missing API context produces an actionable error rather than a null dereference', async () => {
  const f = fixture();
  f.deps.resolveContext = () => null;
  await assert.rejects(restartSite(f.options, f.deps), /context is unavailable/);
  assert.equal(f.calls.length, 0);
});

test('null, malformed or mismatched API identities cannot be restarted', async () => {
  for (const body of [null, [], {}, { id: environmentId, websiteUrl, status: 'OperationComplete' },
    { id: portalId, websiteUrl: 'https://another.powerappsportals.com', status: 'OperationComplete' },
    { id: portalId, websiteUrl, status: 'Unknown' }]) {
    const f = fixture({ statuses: [{ ok: true, statusCode: 200, body }] });
    await assert.rejects(restartSite(f.options, f.deps));
    assert.equal(f.calls.filter((call) => call.method === 'POST').length, 0);
  }
});

test('PascalCase API properties remain supported', async () => {
  const f = fixture({
    statuses: Array(3).fill({ ok: true, statusCode: 200, body: { Id: portalId.toUpperCase(), WebsiteUrl: websiteUrl, Status: 'OperationComplete' } }),
  });
  assert.equal((await restartSite(f.options, f.deps)).success, true);
});

test('preflight API failure or an outstanding operation does not restart the site', async () => {
  for (const initial of [
    { ok: false, statusCode: 403, error: { message: 'Not authorized' } },
    'OperationInProgress', 'OperationNotStarted', 'OperationFailed',
  ]) {
    const f = fixture({ statuses: [initial] });
    const result = await restartSite(f.options, f.deps);
    assert.equal(result.success, false);
    assert.equal(result.restartSubmitted, false);
    assert.equal(result.outcome, 'PreflightFailed');
    assert.equal(f.calls.length, 1);
  }
});

test('restart errors are explicit and ambiguous requests are never retried', async () => {
  for (const [statusCode, submitted] of [[401, false], [403, false], [404, false], [408, null], [500, null], [0, null]]) {
    const f = fixture({ post: { ok: false, statusCode, error: { message: 'Restart failed' } } });
    const result = await restartSite(f.options, f.deps);
    assert.equal(result.success, false);
    assert.equal(result.restartSubmitted, submitted);
    assert.match(result.error, /Restart failed/);
    assert.equal(f.calls.filter((call) => call.method === 'POST').length, 1);
    assert.equal(f.probes.length, 0);
  }
});

test('an undocumented async response cannot masquerade as a completed restart', async () => {
  const f = fixture({ post: { ok: true, statusCode: 202 } });
  const result = await restartSite(f.options, f.deps);
  assert.equal(result.success, false);
  assert.equal(result.restartSubmitted, true);
  assert.equal(result.outcome, 'RestartUnconfirmed');
  assert.equal(f.probes.length, 0);
});

test('verification waits for completion and requires two consecutive reachable responses', async () => {
  const f = fixture({
    statuses: ['OperationComplete', 'OperationInProgress', 'OperationComplete', 'OperationComplete', 'OperationComplete', 'OperationComplete'],
    health: [{ statusCode: 200 }, { statusCode: 503 }, { statusCode: 302 }, { statusCode: 200 }],
  });
  const result = await restartSite(f.options, f.deps);
  assert.equal(result.success, true);
  assert.equal(result.attempts, 5);
  assert.equal(f.probes.length, 4);
});

test('website operation failure and API verification errors remain failures after submission', async () => {
  for (const response of ['OperationFailed', { ok: false, statusCode: 401, error: { message: 'Token expired' } }]) {
    const f = fixture({ statuses: ['OperationComplete', response] });
    const result = await restartSite(f.options, f.deps);
    assert.equal(result.success, false);
    assert.equal(result.restartSubmitted, true);
    assert.equal(result.outcome, 'VerificationFailed');
    assert.equal(f.calls.filter((call) => call.method === 'POST').length, 1);
  }
});

test('unreachable or protected sites time out at exactly 20 checks without another restart', async () => {
  for (const health of [{ error: 'Request timed out' }, { statusCode: 503 }, { statusCode: 403 }]) {
    const f = fixture({ health: Array(20).fill(health) });
    const result = await restartSite(f.options, f.deps);
    assert.equal(result.success, false);
    assert.equal(result.outcome, 'VerificationTimedOut');
    assert.equal(result.attempts, 20);
    assert.equal(f.sleeps.length, 20);
    assert.equal(f.probes.length, 20);
    assert.equal(f.calls.filter((call) => call.method === 'POST').length, 1);
  }
});

test('read-only verification never sends a POST or needs fresh mutation consent', async () => {
  const f = fixture();
  const result = await restartSite({ ...f.options, approved: false, verifyOnly: true }, f.deps);
  assert.equal(result.success, true);
  assert.equal(result.verificationOnly, true);
  assert.equal(result.restartSubmitted, false);
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 0);
  assert.deepEqual(f.sleeps, [15000]);
});

test('CLI reports invalid or unapproved invocations as JSON failures without accessing live CLIs', () => {
  const script = path.join(__dirname, '../restart-site.js');
  const result = spawnSync(process.execPath, [
    script, '--portal-id', portalId, '--env-url', environmentUrl, '--website-url', websiteUrl,
  ], { encoding: 'utf8', env: { ...process.env, PATH: '' } });
  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output.success, false);
  assert.match(output.error, /approval/);
});

test('restart remains after activation in both Phase 3 tracks and before Phase 4 runtime validation', () => {
  for (const track of ['A', 'B']) {
    const state = buildInitialState({ webSiteId: portalId, outputDir: 'migration-reports', track });
    const phase3 = state.phases.find((phase) => phase.id === 3);
    assert.match(phase3.subSteps.at(-2).label, /Activate EDM/);
    assert.equal(phase3.subSteps.at(-1).label, 'Restart Site');
    assert.match(state.phases.find((phase) => phase.id === 4).subSteps[0].label, /Runtime Smoke Test/);
    assert.match(renderLiveReport(state), /approved API restart and readiness verification \(manual fallback\)/);
  }
  const skill = fs.readFileSync(path.join(__dirname, '../../skills/migrate-datamodel/SKILL.md'), 'utf8');
  assert.match(skill, /### 3\.4 Restart Site \(API first, manual fallback\)/);
  assert.match(skill, /### 3\.6 Restart Site \(API first, manual fallback\)/);
  assert.match(skill, /Phase 3, after activation and before Phase 4 runtime validation/);
  assert.match(skill, /restart-site\.js".*--portal-id "<PORTAL_ID>".*--approved/);
  assert.match(skill, /restart-site\.js".*--verify-only/);
  assert.match(skill, /do not automatically repeat the POST/i);
  assert.match(skill, /A healthy site alone does not prove a restart happened/);
  assert.match(skill, /Restart the site in Power Platform admin center/);
});

test('CLI success, read-only verification and readiness timeout preserve the JSON/exit-code contract', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const preload = path.join(root, 'stub-api.cjs');
  const apiPath = path.join(__dirname, '../lib/power-platform-api.js');
  const helpersPath = path.join(__dirname, '../lib/validation-helpers.js');
  // Only the spawned child is stubbed; no test can reach real CLI accounts,
  // management endpoints or websites.
  fs.writeFileSync(preload, `
    const api = require(${JSON.stringify(apiPath)});
    const helpers = require(${JSON.stringify(helpersPath)});
    // Preloading occurs before Node assigns require.main. Supply the same
    // entry-point gate here so the CLI main still runs with stubbed services.
    api.runCli = (caller, main) => {
      if (caller.filename === process.argv[1]) Promise.resolve().then(main).catch(error => {
        console.error(error.message);
        process.exitCode = 1;
      });
    };
    api.resolveContext = () => ({
      environmentId: ${JSON.stringify(environmentId)}, token: 'test-token',
      apiHost: 'https://api.powerplatform.com',
      baseUrl: 'https://api.powerplatform.com/powerpages/environments/${environmentId}'
    });
    api.request = async ({method}) => {
      if (method === 'POST' && process.env.TEST_RESTART_MODE === 'readonly') throw new Error('Read-only command sent a POST');
      return {ok:true,statusCode:200,body:{id:${JSON.stringify(portalId)},websiteUrl:${JSON.stringify(websiteUrl)},status:'OperationComplete'}};
    };
    helpers.getEnvironmentUrl = () => ${JSON.stringify(environmentUrl)};
    helpers.makeRequest = async () => ({statusCode:process.env.TEST_RESTART_MODE === 'timeout' ? 503 : 200});
    global.setTimeout = callback => { callback(); };
  `);
  for (const [mode, exitCode, submitted, attempts] of [
    ['ready', 0, true, 2], ['readonly', 0, false, 2], ['timeout', 1, true, 20],
  ]) {
    const result = spawnSync(process.execPath, [
      '--require', preload, path.join(__dirname, '../restart-site.js'),
      '--portal-id', portalId, '--env-url', environmentUrl, '--website-url', websiteUrl,
      mode === 'readonly' ? '--verify-only' : '--approved',
    ], { encoding: 'utf8', env: { ...process.env, TEST_RESTART_MODE: mode } });
    assert.equal(result.status, exitCode, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.success, exitCode === 0);
    assert.equal(output.restartSubmitted, submitted);
    assert.equal(output.attempts, attempts);
    assert.doesNotMatch(result.stdout + result.stderr, /test-token/);
  }
});
