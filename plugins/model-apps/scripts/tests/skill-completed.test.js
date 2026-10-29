'use strict';
// skill_completed telemetry (lib/telemetry/skill-completed.js): the event the environment-changing scripts send when they finish — the app
// build, the generative-page upload, and (through pcf's verbatim copy) the control push. What these hold:
//   - the privacy contract: eventInfo carries only the approved keys, enum values, booleans and bounded counts; anything else is dropped;
//   - the routing context: the target environment's cloud is read from its host, the tenant from the token's `tid` alone, the organization
//     from one WhoAmI with a short budget — and an opted-out user incurs no lookup;
//   - the gates: the repo kill switch, an unprovisioned key, and a node:test run that did not ask for emission all send nothing;
//   - the build's mapping from its result to outcome / errorClass / per-phase step counts, and the engine wiring that feeds the counts.
// The end-to-end cases spawn a real dispatcher and read the POWER_PLATFORM_SKILLS_FAKE_HTTPS probe: nothing reaches a collector.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const sc = require('../lib/telemetry/skill-completed.js');
const { PHASES } = require('../lib/stages.js');
const { buildModelApp, completionFor, reportCompletion } = require('../build-model-app.js');
const { ConnectionError } = require('../lib/maker-sdk.js');
// Removes every folder these tests make once the file is done; the suite fails on anything left in its temp folder.
const { makeTempDir } = require('./helpers/temp-dirs.js');

const MODULE = path.resolve(__dirname, '..', 'lib', 'telemetry', 'skill-completed.js');
const SHIPPED_IKEY = path.resolve(__dirname, '..', 'lib', 'telemetry', 'ikey.json');
const ORG = '11111111-2222-4333-8444-555555555555';
const TENANT = '66666666-7777-4888-9999-aaaaaaaaaaaa';

function mkTemp() {
  return makeTempDir('modelapps-skillcompleted-');
}

// The detached dispatcher writes the local mirror before it decides where (or whether) to send. A case that expects NO probe waits for
// the mirror, so the child has finished with the folder before the file's cleanup removes it.
function waitForMirror(configDir, timeoutMs = 5000) {
  const root = path.join(configDir, 'telemetry', 'model-apps', 'sessions');
  const has = () => fs.existsSync(root) && fs.readdirSync(root).some((d) => fs.existsSync(path.join(root, d, 'events.jsonl')));
  const deadline = Date.now() + timeoutMs;
  while (!has() && Date.now() < deadline) sleep(25);
  return has();
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file) && Date.now() < deadline) sleep(25);
  return fs.existsSync(file);
}

// A JWT-shaped token whose payload is `claims` (unsigned: tenantIdFromToken reads, never verifies).
function token(claims) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
}

// ── The privacy contract ───────────────────────────────────────────────────────────────────────────────────────────────────

test('sanitizeEventInfo keeps only the approved keys and values, and stamps the schema version', () => {
  const out = sc.sanitizeEventInfo({
    operation: 'app-build', scope: 'changed-only', publish: true, verify: 'failed', haltPhase: 'forms',
    page: 'created', placedInApp: false, addedToSolution: true, incremental: false, registration: 'verified',
    steps: { forms: { ok: 3, skip: 1, error: 1 } },
    // Not in the schema, or not an allowed value: every one is dropped.
    appName: 'Contoso Sales', envUrl: 'https://contoso.crm.dynamics.com', message: 'boom', tables: ['contoso_order'],
  });
  assert.deepEqual(out, {
    schemaVersion: 1, operation: 'app-build', scope: 'changed-only', publish: true, verify: 'failed', haltPhase: 'forms',
    page: 'created', placedInApp: false, addedToSolution: true, incremental: false, registration: 'verified',
    steps: { forms: { ok: 3, skip: 1, error: 1 } },
  });
});

test('sanitizeEventInfo drops values outside each enum, non-booleans, unknown phases and empty rows, and clamps counts', () => {
  const out = sc.sanitizeEventInfo({
    operation: 'drop-table', scope: 'everything', publish: 'yes', verify: 'maybe', haltPhase: 'contoso_order', page: 'deleted',
    steps: {
      contoso_order: { ok: 1 }, // a table name is not a phase
      views: { ok: -4, skip: 2.9, error: 'x' },
      charts: { ok: 0, skip: 0, error: 0 }, // an empty row says nothing
      forms: { ok: 1e12 },
    },
  });
  assert.deepEqual(out, { schemaVersion: 1, steps: { views: { ok: 0, skip: 2, error: 0 }, forms: { ok: 100000, skip: 0, error: 0 } } });
  assert.deepEqual(sc.sanitizeEventInfo('not an object'), { schemaVersion: 1 });
  assert.deepEqual(sc.sanitizeEventInfo({ steps: ['views'] }), { schemaVersion: 1 });
});

test('every engine phase the build can report is an allowed step key (pinned to lib/stages.js)', () => {
  for (const phase of [...PHASES, 'preflight']) assert.ok(sc.PHASES.has(phase), `${phase} is missing from the telemetry schema`);
});

// ── The step tally ──────────────────────────────────────────────────────────────────────────────────────────────────────────

test('the step tally counts each step once, by its final outcome, per phase', () => {
  const tally = sc.createStepTally();
  for (const e of [
    { phase: 'data-model', status: 'start' }, // a header, not a step
    { phase: 'data-model', status: 'ok' },
    { phase: 'data-model', status: 'skip' },
    { phase: 'views', status: 'error' },
    { phase: 'views', status: 'ok', replaces: 'error' }, // a deferred step taken up again: its earlier outcome is replaced
    { phase: 'forms', status: 'warn' },
    null,
  ]) tally.record(e);
  assert.deepEqual(tally.snapshot(), { 'data-model': { ok: 1, skip: 1, error: 0 }, views: { ok: 1, skip: 0, error: 0 } });
  tally.reset();
  assert.deepEqual(tally.snapshot(), {});
});

test('an apply feeds its engine events to the tally, and an automatic re-run starts it over', async () => {
  const tally = sc.createStepTally();
  let attempt = 0;
  const r = await buildModelApp(
    { schemaVersion: 2, solution: { uniqueName: 'contoso', publisherPrefix: 'contoso' }, app: { name: 'Tally Probe' },
      entities: [{ schemaName: 'contoso_order', primaryAttribute: { schemaName: 'contoso_name' }, columns: [] }],
      appShell: { areas: [{ label: 'Main', groups: [{ label: 'Main', subAreas: [] }] }] } },
    { apply: true, workspaceDir: mkTemp(), maxRetries: 1, retryDelayMs: 0 },
    {
      log: () => {},
      stepTally: tally,
      runBuild: async (s, o) => {
        attempt += 1;
        o.emit({ phase: 'solution', status: 'ok', n: 1, total: 2, label: 's' });
        if (attempt === 1) {
          o.emit({ phase: 'data-model', status: 'error', n: 2, total: 2, label: 't' });
          // A 503: transient, so the build runs again (as app-build-lease.test.js drives it).
          throw new ConnectionError('https://contoso.crm.dynamics.com/api/data/v9.2/solutions', 503, 'Service Unavailable');
        }
        o.emit({ phase: 'data-model', status: 'ok', n: 2, total: 2, label: 't' });
        return { ok: true, dryRun: false, created: {} };
      },
      sleep: async () => {},
    }
  );
  assert.equal(r.ok, true);
  assert.equal(attempt, 2, 'the transient halt was retried');
  assert.deepEqual(tally.snapshot(), { solution: { ok: 1, skip: 0, error: 0 }, 'data-model': { ok: 1, skip: 0, error: 0 } });
});

// ── The build's result, in the closed vocabulary ────────────────────────────────────────────────────────────────────────────

function run(over = {}) {
  const tally = sc.createStepTally();
  for (const e of over.events || []) tally.record(e);
  return { startedAt: Date.now() - 1000, env: 'https://contoso.crm.dynamics.com', changedOnly: false, staged: false, opts: { publish: true }, tally, ...over };
}

test('completionFor maps each kind of build result to its outcome, error class and phase', () => {
  const ok = completionFor(run({ events: [{ phase: 'forms', status: 'ok' }] }), { ok: true, payload: { ok: true, verify: { ok: true } } });
  assert.deepEqual(ok, { outcome: 'success', eventInfo: { operation: 'app-build', scope: 'full', publish: true, steps: { forms: { ok: 1, skip: 0, error: 0 } }, verify: 'passed' } });

  assert.equal(completionFor(run(), { ok: true, payload: { ok: true } }).eventInfo.verify, 'not-run');
  assert.equal(completionFor(run({ staged: true }), { ok: true, payload: { ok: true } }).eventInfo.scope, 'staged');
  assert.equal(completionFor(run({ changedOnly: true, staged: true }), { ok: true, payload: { ok: true } }).eventInfo.scope, 'changed-only');

  const verify = completionFor(run(), { ok: false, payload: { ok: true, verify: { ok: false } } });
  assert.equal(verify.errorClass, 'verify-failed');
  assert.equal(verify.eventInfo.verify, 'failed');

  const auth = completionFor(run(), { ok: false, payload: { ok: false, error: 'the token was issued to someone else' } });
  assert.deepEqual([auth.errorClass, auth.eventInfo.haltPhase], ['auth', 'preflight']);

  const refused = completionFor(run(), { ok: false, payload: { ok: false, errors: ['destructive ops need approval'] } });
  assert.deepEqual([refused.errorClass, refused.eventInfo.haltPhase], ['halted', 'preflight']);

  const partial = completionFor(run({ events: [{ phase: 'views', status: 'error' }] }), { ok: false, payload: { ok: false, errors: ['1 step failed'] } });
  assert.equal(partial.errorClass, 'deploy-failed');

  const halt = completionFor(run(), { ok: false, error: Object.assign(new Error('forms stopped'), { phase: 'forms', code: 'whatever' }) });
  assert.deepEqual([halt.outcome, halt.errorClass, halt.eventInfo.haltPhase, halt.eventInfo.verify], ['failure', 'halted', 'forms', undefined]);

  for (const code of ['build-locked', 'pages-locked', 'build-lease-invalid']) {
    assert.equal(completionFor(run(), { ok: false, error: Object.assign(new Error('x'), { code, phase: 'preflight' }) }).errorClass, 'locked', code);
  }
  assert.equal(completionFor(run(), { ok: false, error: new Error('unexpected') }).errorClass, 'unexpected');
});

test('reportCompletion sends app-builder with the target environment and a duration, and never throws', async () => {
  const sent = [];
  await reportCompletion(run(), { ok: true, payload: { ok: true } }, async (input) => { sent.push(input); return true; });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].skillName, 'app-builder');
  assert.equal(sent[0].outcome, 'success');
  assert.equal(sent[0].envUrl, 'https://contoso.crm.dynamics.com');
  assert.ok(sent[0].durationMs >= 1000);
  await reportCompletion(null, { ok: true }, async () => { throw new Error('a dry run reports nothing'); });
  await reportCompletion(run(), { ok: true, payload: {} }, async () => { throw new Error('telemetry failed'); });
});

// ── Routing context ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test('cloudOfEnvironment names the PAC cloud of a Dataverse host, and nothing for any other', () => {
  const cases = [
    ['https://contoso.crm.dynamics.com', 'Public'],
    ['https://contoso.crm4.dynamics.com', 'Public'],
    ['https://contoso.api.crm11.dynamics.com', 'Public'],
    ['https://contoso.crm9.dynamics.com', 'UsGov'],
    ['https://contoso.crm.microsoftdynamics.us', 'UsGovHigh'],
    ['https://contoso.crm.appsplatform.us', 'UsGovDod'],
    ['https://contoso.crm.dynamics.cn', 'China'],
    ['https://contoso.crmtest.dynamics.com', 'Test'],
    ['https://contoso.example.com', ''],
    ['https://contoso.crm.dynamics.com.evil.example', ''],
    ['not a url', ''],
    [undefined, ''],
  ];
  for (const [url, cloud] of cases) assert.equal(sc.cloudOfEnvironment(url), cloud, String(url));
});

test('tenantIdFromToken reads the tid claim and nothing else', () => {
  assert.equal(sc.tenantIdFromToken(token({ tid: TENANT.toUpperCase(), oid: ORG, upn: 'maker@contoso.onmicrosoft.com' })), TENANT);
  assert.equal(sc.tenantIdFromToken(token({ oid: ORG })), undefined);
  assert.equal(sc.tenantIdFromToken(token({ tid: 'not-a-guid' })), undefined);
  assert.equal(sc.tenantIdFromToken('garbage'), undefined);
});

function fakeAuth({ whoAmI, peek = () => token({ tid: TENANT }) } = {}) {
  const calls = [];
  return {
    calls,
    dataverseOrigin: (u) => (/^https:\/\/[a-z0-9.-]+$/.test(u) ? u : null),
    peekAuthToken: (origin) => { calls.push(['peek', origin]); return peek(); },
    getAuthToken: () => { throw new Error('telemetry must never start the Azure CLI'); },
    dataverseRequest: async (origin, method, apiPath, body, opts) => { calls.push(['request', method, apiPath, opts.refreshOn401]); return whoAmI(); },
  };
}

test('resolveEnvironmentIdentity: the tenant from the memoized token, the organization from one WhoAmI', async () => {
  const auth = fakeAuth({ whoAmI: async () => ({ status: 200, data: { OrganizationId: ORG.toUpperCase(), UserId: 'u' } }) });
  assert.deepEqual(await sc.resolveEnvironmentIdentity('https://contoso.crm.dynamics.com', { auth }), { orgId: ORG, tenantId: TENANT });
  assert.deepEqual(auth.calls[0], ['peek', 'https://contoso.crm.dynamics.com'], 'the memo only');
  assert.deepEqual(auth.calls[1], ['request', 'GET', 'WhoAmI', false], 'a 401 is not refreshed for telemetry');
});

test('resolveEnvironmentIdentity sends no request when the script never read a token (a refused sign-in, a lock refusal, a failed push)', async () => {
  const auth = fakeAuth({ peek: () => null, whoAmI: async () => { throw new Error('no request without a token'); } });
  assert.deepEqual(await sc.resolveEnvironmentIdentity('https://contoso.crm.dynamics.com', { auth }), {});
  assert.deepEqual(auth.calls, [['peek', 'https://contoso.crm.dynamics.com']]);
  // An auth module without the memo read (an older copy) is the same: no IDs, and no Azure CLI.
  const { peekAuthToken, ...older } = fakeAuth({ whoAmI: async () => ({ status: 200, data: { OrganizationId: ORG } }) });
  assert.equal(typeof peekAuthToken, 'function');
  assert.deepEqual(await sc.resolveEnvironmentIdentity('https://contoso.crm.dynamics.com', { auth: older }), {});
});

test('resolveEnvironmentIdentity degrades to nothing — a slow, failed or refused WhoAmI sends neither ID, since the token\'s tenant is the environment\'s only once it accepted the token', async () => {
  const slow = fakeAuth({ whoAmI: () => new Promise(() => {}) });
  const t0 = Date.now();
  assert.deepEqual(await sc.resolveEnvironmentIdentity('https://contoso.crm.dynamics.com', { auth: slow, timeoutMs: 50 }), {});
  assert.ok(Date.now() - t0 < 2000, 'the budget bounds the wait');
  assert.deepEqual(await sc.resolveEnvironmentIdentity('https://contoso.crm.dynamics.com', { auth: fakeAuth({ whoAmI: async () => { throw new Error('ECONNRESET'); } }) }), {});
  // Observed live: an Azure CLI signed in to another tenant gets a token, and the environment answers 401. Its `tid` is not this environment's.
  assert.deepEqual(await sc.resolveEnvironmentIdentity('https://contoso.crm.dynamics.com', { auth: fakeAuth({ whoAmI: async () => ({ status: 401, data: {} }) }) }), {});
  assert.deepEqual(await sc.resolveEnvironmentIdentity('ftp://contoso', { auth: fakeAuth({ whoAmI: async () => ({}) }) }), {});
});

// ── Gates ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const OK_INPUT = { skillName: 'app-builder', outcome: 'success', durationMs: 5, envUrl: 'https://contoso.crm.dynamics.com' };

test('nothing is sent from inside a node:test run unless the test asks for it', async () => {
  const fired = [];
  const sent = await sc.emitSkillCompleted(OK_INPUT, { env: { NODE_TEST_CONTEXT: 'child' }, fireAndForget: (e) => fired.push(e) });
  assert.equal(sent, false);
  assert.deepEqual(fired, []);
});

test('an invalid input sends nothing', async () => {
  const env = { POWER_PLATFORM_SKILLS_TELEMETRY_TEST_EMIT: '1', NODE_TEST_CONTEXT: 'child' };
  for (const input of [null, { outcome: 'success' }, { skillName: 'app-builder', outcome: 'done' }]) {
    const fired = [];
    assert.equal(await sc.emitSkillCompleted(input, { env, fireAndForget: (e) => fired.push(e) }), false);
    assert.deepEqual(fired, []);
  }
});

test('a user who opted out gets no organization lookup, and the event still goes to the dispatcher for the local mirror', async () => {
  const configDir = mkTemp();
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ telemetry: { 'model-apps': 'off' } }));
  const fired = [];
  let looked = 0;
  const sent = await sc.emitSkillCompleted(OK_INPUT, {
    env: { NODE_TEST_CONTEXT: 'child', POWER_PLATFORM_SKILLS_TELEMETRY_TEST_EMIT: '1', POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir },
    resolveIdentity: async () => { looked += 1; return { orgId: ORG }; },
    fireAndForget: (e) => fired.push(e),
  });
  assert.equal(sent, true);
  assert.equal(looked, 0);
  assert.equal(fired[0].data.orgId, undefined);
});

// Spawns a process that calls emitSkillCompleted with `input`, the way a script does, and returns the probe the dispatcher writes.
// `identity` is what the organization lookup answers ({} for a lookup that was skipped, refused or timed out).
function emitInChild({ input, ikeyPath, configDir, extraEnv = {}, identity = { orgId: ORG, tenantId: TENANT } }) {
  const probe = path.join(configDir, 'probe.json');
  const code = `require(${JSON.stringify(MODULE)}).emitSkillCompleted(${JSON.stringify(input)}, ` +
    `{ resolveIdentity: async () => (${JSON.stringify(identity)}) }).then((r) => process.stdout.write(String(r)));`;
  const res = spawnSync(process.execPath, ['-e', code], {
    encoding: 'utf8',
    env: {
      ...process.env,
      POWER_PLATFORM_SKILLS_TELEMETRY_TEST_EMIT: '1',
      POWER_PLATFORM_SKILLS_IKEY_JSON: ikeyPath || '',
      POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir,
      POWER_PLATFORM_SKILLS_FAKE_HTTPS: probe,
      // CI opts out of transmission; this case asserts what WOULD be sent, so it clears that for its own child only.
      POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT: '',
      ...extraEnv,
    },
    timeout: 15000,
  });
  return { res, probe };
}

test('the repo kill switch and an unprovisioned key send nothing', () => {
  for (const cfg of [
    { instrumentationKey: 'k-1', collector_url: 'https://example.invalid/', event_stream_name: 'S', disabled: true },
    { instrumentationKey: 'PLACEHOLDER_REPLACE_BEFORE_SHIPPING', collector_url: 'https://example.invalid/', event_stream_name: 'S', disabled: false },
  ]) {
    const configDir = mkTemp();
    const ikeyPath = path.join(configDir, 'ikey.json');
    fs.writeFileSync(ikeyPath, JSON.stringify(cfg));
    const { res, probe } = emitInChild({ input: OK_INPUT, ikeyPath, configDir });
    assert.equal(res.stdout, 'false', res.stderr);
    assert.equal(waitForFile(probe, 1000), false);
  }
});

test('end to end with the shipped config: the Power Apps client event carries the outcome, counts and target identity — and nothing else', () => {
  const configDir = mkTemp();
  // Seed the shared org→region cache so the public-cloud route resolves without the Artemis gateway: the test stays offline.
  fs.mkdirSync(path.join(configDir, 'region-cache'), { recursive: true });
  fs.writeFileSync(path.join(configDir, 'region-cache', `${ORG}.json`), JSON.stringify({ region: 'eu', expiresAt: Date.now() + 3600000 }));
  const input = {
    ...OK_INPUT,
    outcome: 'failure',
    errorClass: 'halted',
    eventInfo: { operation: 'app-build', scope: 'full', publish: true, haltPhase: 'forms', steps: { forms: { ok: 2, error: 1 } }, appName: 'Contoso Sales' },
  };
  const { res, probe } = emitInChild({ input, configDir });
  assert.equal(res.stdout, 'true', res.stderr);
  assert.ok(waitForFile(probe, 5000), 'the dispatcher wrote the probe');
  const shipped = JSON.parse(fs.readFileSync(SHIPPED_IKEY, 'utf8'));
  const { headers, body } = JSON.parse(fs.readFileSync(probe, 'utf8'));
  assert.equal(headers['x-apikey'], shipped.regions.eu.instrumentation_key, 'a public-cloud org is routed by its geo');
  const wire = JSON.parse(body);
  assert.equal(wire.name, 'event');
  assert.equal(wire.data.clientType, 'ModelAppsAIPlugin');
  assert.equal(wire.data.event_Name, 'skill_completed');
  assert.equal(wire.data.severity, 'Error');
  assert.equal(wire.data.tenantId, TENANT);
  const dims = JSON.parse(wire.data.customDimensions);
  assert.equal(dims.pluginName, 'model-apps');
  assert.equal(dims.skillName, 'app-builder');
  assert.equal(dims.outcome, 'failure');
  assert.equal(dims.errorClass, 'halted');
  assert.equal(dims.durationMs, 5);
  assert.equal(dims.orgId, ORG);
  assert.deepEqual(dims.eventInfo, {
    schemaVersion: 1, operation: 'app-build', scope: 'full', publish: true, haltPhase: 'forms', steps: { forms: { ok: 2, skip: 0, error: 1 } },
  });
  assert.ok(!body.includes('Contoso Sales'), 'an app name never reaches the wire');
  assert.ok(!body.includes('contoso.crm.dynamics.com'), 'the environment URL never reaches the wire');
});

test('an environment in an unrecognized cloud is not sent anywhere — with an organization ID, and without one', () => {
  for (const identity of [{ orgId: ORG, tenantId: TENANT }, {}]) {
    const configDir = mkTemp();
    const { res, probe } = emitInChild({ input: { ...OK_INPUT, envUrl: 'https://contoso.example.com' }, configDir, identity });
    assert.equal(res.stdout, 'true', res.stderr);
    // Without an ID a blank cloud would read as a signed-out PAC and take the public US default; the emitter names it unroutable instead.
    assert.ok(waitForMirror(configDir), 'the dispatcher ran (it mirrors every event it is handed)');
    assert.equal(waitForFile(probe, 1500), false, `routed somewhere with ${JSON.stringify(identity)}`);
  }
});

test('a recognized public host with no organization ID (the lookup was skipped) still sends, to the configured default', () => {
  const configDir = mkTemp();
  const { res, probe } = emitInChild({ input: OK_INPUT, configDir, identity: {} });
  assert.equal(res.stdout, 'true', res.stderr);
  assert.ok(waitForFile(probe, 5000), 'the dispatcher wrote the probe');
  const shipped = JSON.parse(fs.readFileSync(SHIPPED_IKEY, 'utf8'));
  assert.equal(JSON.parse(fs.readFileSync(probe, 'utf8')).headers['x-apikey'], shipped.regions[shipped.default_region].instrumentation_key);
});
