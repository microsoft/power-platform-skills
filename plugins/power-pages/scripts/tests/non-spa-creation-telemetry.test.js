'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { buildNonSpaCreationEvent, recordNonSpaCreation } = require('../lib/non-spa-creation-telemetry');
const { parseArgs } = require('../emit-non-spa-creation-telemetry');

const CORRELATION = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';
const SHA = '0123456789abcdef0123456789abcdef01234567';
const CLI = path.resolve(__dirname, '..', 'emit-non-spa-creation-telemetry.js');
const DISPATCHER = path.resolve(__dirname, '..', 'lib', 'telemetry', 'lib', 'emit-dispatcher.js');
const select = (correlationId = CORRELATION) => ({
  eventName: 'template_used', templateId: 'starter-layout-1', catalogSha: SHA,
  correlationId, sessionId: 'test-session', audience: 'external',
});
const finish = (eventName = 'non_spa_creation_success', correlationId = CORRELATION) => ({ eventName, correlationId });

function fixture(t, cfg = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'non-spa-creation-telemetry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const configDir = path.join(root, 'config');
  const cacheRoot = path.join(root, 'cache');
  const catalogPath = path.join(cacheRoot, SHA, 'templates', 'manifest.json');
  fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
  const template = {
    id: 'starter-layout-1', displayName: 'User-facing catalog title must not be emitted',
    description: 'Catalog content must not be emitted', author: 'Microsoft', kind: 'non-spa',
    keywords: ['non-spa'], audience: ['makers'],
    provisioning: { type: 'create-website-api', templateName: 'StarterLayout1' },
    capabilities: [], requirements: [], responsivePreviews: [],
  };
  fs.writeFileSync(catalogPath, JSON.stringify({ templates: [template] }));
  const ikeyPath = path.join(root, 'ikey.json');
  fs.writeFileSync(ikeyPath, JSON.stringify({
    disabled: false, event_stream_name: 'PagesAIPluginEvent',
    instrumentationKey: 'test-ikey-32-chars-minimum-aaaaaaaaaaaaaa',
    collector_url: 'https://example.invalid/OneCollector/1.0/', ...cfg,
  }));
  const emitted = [];
  let contextReads = 0;
  const env = { POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir, POWER_PLATFORM_SKILLS_IKEY_JSON: ikeyPath };
  const deps = {
    env, cacheRoot,
    readPacAuth: () => { contextReads++; return { orgId: 'org', tenantId: 'tenant', cloud: 'UsGov' }; },
    readAgentInfo: () => ({ aiAgentName: 'Copilot CLI', aiAgentVersion: '1.0.0', pacCliVersion: '2.0.0' }),
    fireAndForget: (event, options) => emitted.push({ event, options }),
  };
  const stateDir = (id = CORRELATION) => path.join(configDir, 'telemetry', 'power-pages', 'non-spa-creations', id);
  return { root, configDir, cacheRoot, catalogPath, template, ikeyPath, emitted, env, deps,
    contextReads: () => contextReads, stateDir };
}

test('selection and baseline result use the non-SPA template vocabulary and one shared correlation', (t) => {
  const f = fixture(t);
  assert.equal(f.template.kind, 'non-spa');
  assert.equal(recordNonSpaCreation(select(), f.deps).ok, true);
  // Simulate a fresh process at completion: no repeated PAC/agent discovery.
  assert.equal(recordNonSpaCreation(finish(), {
    ...f.deps, readPacAuth: () => assert.fail('Do not rediscover context at completion.'),
  }).ok, true);
  assert.equal(f.contextReads(), 1);
  assert.deepEqual(f.emitted.map(({ event }) => event.data.eventName), ['template_used', 'non_spa_creation_success']);
  for (const { event, options } of f.emitted) {
    assert.equal(event.name, 'PagesAIPluginEvent');
    assert.equal(event.data.correlationId, CORRELATION);
    assert.equal(event.data.sessionId, 'test-session');
    assert.equal(event.data.skillName, 'create-site');
    assert.equal(event.data.orgId, 'org');
    assert.equal(event.data.tenantId, 'tenant');
    assert.equal(options.cloud, 'UsGov');
    assert.deepEqual(event.data.eventInfo, {
      templateId: 'starter-layout-1', templateKind: 'non-spa', audience: 'external',
    });
  }
  assert.equal(f.emitted[0].event.data.outcome, undefined, 'Selection is not creation success.');
  assert.equal(f.emitted[1].event.data.outcome, 'success');
  assert.equal(f.emitted[1].event.data.errorClass, undefined);
});

test('repeated selection, retries and resume do not emit duplicate selection or terminal outcomes', (t) => {
  const f = fixture(t);
  recordNonSpaCreation(select(), f.deps);
  assert.equal(recordNonSpaCreation(select(), f.deps).skipped, 'duplicate');
  assert.equal(recordNonSpaCreation(finish(), f.deps).ok, true);
  assert.equal(recordNonSpaCreation(finish(), f.deps).skipped, 'finished');
  assert.equal(recordNonSpaCreation(finish('non_spa_creation_failure'), f.deps).skipped, 'finished');
  assert.equal(f.emitted.length, 2);
  recordNonSpaCreation(select(SECOND), f.deps);
  assert.equal(f.emitted[2].event.data.correlationId, SECOND);
  assert.equal(f.contextReads(), 2);
});

test('failure sends only a controlled class and cannot claim successful completion', (t) => {
  const f = fixture(t);
  recordNonSpaCreation(select(), f.deps);
  const raw = 'failed at C:\\private\\site with https://contoso.crm.dynamics.com';
  assert.equal(recordNonSpaCreation({
    ...finish('non_spa_creation_failure'), errorClass: 'Download',
    errorDescription: raw, siteUrl: raw, prompt: raw, framework: 'react', durationMs: 500,
  }, f.deps).ok, true);
  const event = f.emitted[1].event;
  assert.equal(event.data.errorClass, 'Download');
  assert.equal(event.data.eventInfo.templateKind, 'non-spa');
  assert.equal(event.data.outcome, 'failure');
  assert.equal(event.data.severity, 'Error');
  assert.doesNotMatch(JSON.stringify(event), /private|contoso|errorDescription|framework|durationMs/);
  assert.equal(recordNonSpaCreation(finish(), f.deps).skipped, 'finished');
  recordNonSpaCreation(select(SECOND), f.deps);
  recordNonSpaCreation({ ...finish('non_spa_creation_failure', SECOND), errorClass: raw }, f.deps);
  assert.equal(f.emitted.at(-1).event.data.errorClass, 'Unknown');
});

test('the event builder never copies arbitrary eventInfo or raw diagnostics from state', () => {
  const state = {
    correlationId: CORRELATION, templateId: 'starter-layout-1', audience: 'makers',
    context: { sessionId: 'test-session', eventInfo: { framework: 'react', secret: 'private' },
      siteName: 'private', errorDescription: 'private', durationMs: 900 },
  };
  const event = buildNonSpaCreationEvent('non_spa_creation_success', state, 'PagesAIPluginEvent');
  assert.deepEqual(event.data.eventInfo, { templateId: 'starter-layout-1', templateKind: 'non-spa' });
  assert.doesNotMatch(JSON.stringify(event), /private|framework|durationMs/);
  assert.throws(() => buildNonSpaCreationEvent('skill_started', state, 'stream'), /Unsupported/);
  assert.throws(() => buildNonSpaCreationEvent('template_used', { ...state, correlationId: 'not-a-uuid' }, 'stream'), /correlation/);
  for (const templateId of [123, {}, [], null]) {
    assert.throws(() => buildNonSpaCreationEvent('template_used', { ...state, templateId }, 'stream'), /template/);
  }
});

test('template identifiers must match one validated cached non-SPA catalog entry', (t) => {
  const f = fixture(t);
  for (const templateId of ['private-site-name', 'StarterLayout1', '../private', 'https://example.com', 'x'.repeat(121)]) {
    assert.deepEqual(recordNonSpaCreation({ ...select(), templateId }, f.deps), { ok: false });
  }
  assert.deepEqual(recordNonSpaCreation({ ...select(), catalogSha: '../wrong' }, f.deps), { ok: false });
  fs.writeFileSync(f.catalogPath, JSON.stringify({ templates: [f.template, f.template] }));
  assert.deepEqual(recordNonSpaCreation(select(), f.deps), { ok: false });
  fs.writeFileSync(f.catalogPath, JSON.stringify({ templates: [{ ...f.template, kind: 'spa' }] }));
  assert.deepEqual(recordNonSpaCreation(select(), f.deps), { ok: false });
  fs.unlinkSync(f.catalogPath);
  assert.deepEqual(recordNonSpaCreation(select(), f.deps), { ok: false });
  assert.equal(f.contextReads(), 0);
  assert.equal(f.emitted.length, 0);
});

test('missing or changed correlation state never fabricates a result event', (t) => {
  const f = fixture(t);
  assert.deepEqual(recordNonSpaCreation(finish(), f.deps), { ok: false });
  recordNonSpaCreation(select(), f.deps);
  const file = path.join(f.stateDir(), 'state.json');
  const state = JSON.parse(fs.readFileSync(file));
  state.correlationId = SECOND;
  fs.writeFileSync(file, JSON.stringify(state));
  assert.deepEqual(recordNonSpaCreation(finish(), f.deps), { ok: false });
  assert.equal(f.emitted.length, 1);
  assert.equal(fs.existsSync(path.join(f.stateDir(), 'finished.json')), false);
});

test('an existing or concurrently claimed correlation cannot be rebound to another catalog selection', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.catalogPath, JSON.stringify({
    templates: [f.template, { ...f.template, id: 'starter-layout-2' }],
  }));
  recordNonSpaCreation(select(), f.deps);
  assert.deepEqual(recordNonSpaCreation({ ...select(), templateId: 'starter-layout-2' }, f.deps), { ok: false });
  const result = recordNonSpaCreation(select(SECOND), {
    ...f.deps,
    readPacAuth: () => {
      // Simulate another process winning the exclusive claim while this process
      // collects context. The winner's selection must be checked, not overwritten.
      fs.writeFileSync(path.join(f.stateDir(SECOND), 'state.json'), JSON.stringify({
        schemaVersion: 1, correlationId: SECOND, templateId: 'starter-layout-2', catalogSha: SHA,
      }));
      return {};
    },
  });
  assert.deepEqual(result, { ok: false });
  assert.equal(f.emitted.length, 1);
});

test('hard-off, missing config and unprovisioned config do not discover context or write state', (t) => {
  for (const config of [
    { disabled: true },
    { instrumentationKey: '' },
    { instrumentationKey: 'PLACEHOLDER_REPLACE_BEFORE_SHIPPING' },
  ]) {
    const f = fixture(t, config);
    const result = recordNonSpaCreation(select(), f.deps);
    assert.equal(result.ok, true);
    assert.equal(result.skipped, 'disabled');
    assert.equal(f.contextReads(), 0);
    assert.equal(f.emitted.length, 0);
    assert.equal(fs.existsSync(f.configDir), false);
  }
  const f = fixture(t);
  fs.unlinkSync(f.ikeyPath);
  assert.deepEqual(recordNonSpaCreation(select(), f.deps), { ok: false });
  assert.equal(fs.existsSync(f.configDir), false);
});

test('plugin resolver provision check gates discovery and the existing dispatcher still owns routing', (t) => {
  const f = fixture(t, { instrumentationKey: '' });
  const resolver = path.join(f.root, 'resolver.js');
  fs.writeFileSync(resolver, `module.exports={isProvisioned:()=>false,resolve:()=>{throw new Error('do not resolve in parent')}};`);
  assert.equal(recordNonSpaCreation(select(), f.deps).skipped, 'disabled');
  assert.equal(f.contextReads(), 0);
  assert.equal(fs.existsSync(f.configDir), false);
  delete require.cache[require.resolve(resolver)];
  fs.writeFileSync(resolver, `module.exports={isProvisioned:()=>true,resolve:()=>{throw new Error('do not resolve in parent')}};`);
  assert.equal(recordNonSpaCreation(select(), f.deps).ok, true);
  assert.equal(f.contextReads(), 1);
  assert.equal(f.emitted.length, 1);
  delete require.cache[require.resolve(resolver)];
});

test('telemetry module and dispatch failures are nonblocking with bounded public output', (t) => {
  const f = fixture(t);
  const result = recordNonSpaCreation(select(), { ...f.deps,
    fireAndForget: () => { throw new Error('sensitive runtime details'); } });
  assert.deepEqual(result, { ok: false });
  const cli = spawnSync(process.execPath, [CLI, '--eventName', 'template_used', '--unexpected', 'private'], {
    encoding: 'utf8', shell: false,
    env: { ...process.env, ...f.env, POWER_PLATFORM_SKILLS_TELEMETRY_POWER_PAGES_OPTOUT: '1' },
  });
  assert.equal(cli.status, 0);
  assert.deepEqual(JSON.parse(cli.stdout), { ok: false });
  assert.equal(cli.stderr, '');
  const preload = path.join(f.root, 'missing-module.cjs');
  fs.writeFileSync(preload, `const Module=require('node:module');const original=Module._load;
Module._load=function(name,...rest){if(name==='./lib/non-spa-creation-telemetry')throw new Error('private');
return original.call(this,name,...rest);};`);
  const unavailable = spawnSync(process.execPath, ['--require', preload, CLI], {
    encoding: 'utf8', shell: false,
    env: { ...process.env, ...f.env, POWER_PLATFORM_SKILLS_TELEMETRY_POWER_PAGES_OPTOUT: '1' },
  });
  assert.equal(unavailable.status, 0);
  assert.deepEqual(JSON.parse(unavailable.stdout), { ok: false });
  assert.equal(unavailable.stderr, '');
});

test('CLI accepts only the minimal flags and never aliases errors to additional telemetry fields', () => {
  assert.deepEqual(parseArgs(['--eventName', 'template_used', '--correlationId', CORRELATION]),
    { eventName: 'template_used', correlationId: CORRELATION });
  for (const argv of [
    ['--eventName'], ['--eventName', ''], ['--eventName', 'template_used', '--eventName', 'other'],
    ['--siteName', 'private'], ['--errorDescription', 'private'], ['--framework', 'react'],
  ]) assert.throws(() => parseArgs(argv), /Invalid telemetry arguments/);
});

test('first selection generates a UUID, but a result never invents a missing correlation', (t) => {
  const f = fixture(t);
  const fields = select();
  delete fields.correlationId;
  const first = recordNonSpaCreation(fields, f.deps);
  const second = recordNonSpaCreation(fields, f.deps);
  assert.match(first.correlationId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(second.correlationId, first.correlationId);
  assert.deepEqual(recordNonSpaCreation({ eventName: 'non_spa_creation_success' }, f.deps), { ok: false });
  for (const correlationId of ['', null, '../run', 'not-a-uuid']) {
    assert.deepEqual(recordNonSpaCreation({ ...fields, correlationId }, f.deps), { ok: false });
  }
  fs.unlinkSync(f.catalogPath);
  assert.equal(recordNonSpaCreation(finish('non_spa_creation_success', first.correlationId), f.deps).ok, true);
  assert.equal(f.emitted.at(-1).event.data.correlationId, first.correlationId);
});

test('separate CLI processes carry selection correlation through the real detached dispatcher', async (t) => {
  const f = fixture(t);
  const preload = path.join(f.root, 'context-preload.cjs');
  fs.writeFileSync(preload, `const Module=require('node:module');const original=Module._load;
Module._load=function(name,...rest){
  if(name==='./telemetry/lib/pac-auth')return {readPacAuth:()=>({cloud:'Public'})};
  if(name==='./telemetry/lib/agent-info')return {readAiAgent:()=>({}),readPacCliVersion:()=>''};
  const value=original.call(this,name,...rest);
  return name==='./template-catalog'?{...value,getDefaultCacheRoot:()=>${JSON.stringify(f.cacheRoot)}}:value;
};`);
  const env = {
    ...process.env, ...f.env, POWER_PLATFORM_SKILLS_TELEMETRY_POWER_PAGES_OPTOUT: '',
    POWER_PLATFORM_SKILLS_FAKE_HTTPS: path.join(f.root, 'probe.json'),
  };
  async function run(fields) {
    const args = Object.entries(fields).flatMap(([key, value]) => [`--${key}`, value]);
    const probe = env.POWER_PLATFORM_SKILLS_FAKE_HTTPS;
    fs.rmSync(probe, { force: true });
    const result = spawnSync(process.execPath, ['--require', preload, CLI, ...args], {
      encoding: 'utf8', shell: false, timeout: 10000, env,
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(probe) && Date.now() < deadline) await delay(25);
    assert.ok(fs.existsSync(probe), 'Detached dispatcher should finish writing the isolated probe.');
    const body = JSON.parse(JSON.parse(fs.readFileSync(probe, 'utf8')).body);
    assert.equal(body.data.correlationId, output.correlationId);
    return output;
  }
  const selected = await run(select());
  const completed = await run(finish('non_spa_creation_success', selected.correlationId));
  assert.equal(completed.correlationId, selected.correlationId);
  const log = path.join(f.configDir, 'telemetry', 'power-pages', 'sessions', 'test-session', 'events.jsonl');
  const records = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(records.map((record) => record.data.eventName), ['template_used', 'non_spa_creation_success']);
});

test('non-SPA workflow emits at selection and verified baseline boundaries without modifying SPA entry points', () => {
  const root = path.resolve(__dirname, '..', '..');
  const workflow = fs.readFileSync(path.join(root, 'skills', 'create-site', 'workflows', 'non-spa-site.md'), 'utf8');
  const selectedAt = workflow.indexOf('--eventName template_used');
  assert.ok(selectedAt > workflow.indexOf('## Phase 2:'));
  assert.ok(selectedAt < workflow.indexOf('## Phase 3:'));
  const succeededAt = workflow.indexOf('--eventName non_spa_creation_success');
  assert.ok(succeededAt > workflow.indexOf('Run the validator again after Git initialization.'));
  assert.ok(succeededAt < workflow.indexOf('## Phase 8:'));
  assert.match(workflow, /Git\s+baseline commit.*?final validator have \*\*all succeeded\*\*/s);
  assert.match(workflow, /--eventName non_spa_creation_failure --correlationId "<CREATION_CORRELATION_ID>"/);
  assert.match(workflow, /Keep the same correlation across polling, authentication repair, download retries/);
  assert.match(workflow, /Do \*\*not\*\* emit failure for Cancel/);
  assert.match(workflow, /a polling timeout\s+with an unresolved operation/);
  assert.match(workflow, /never authorizes a\s+second POST/);
  assert.match(workflow, /Do not re-fetch the catalog or retry telemetry/);
  for (const file of [
    path.join('skills', 'create-site', 'SKILL.md'),
    path.join('skills', 'activate-site', 'scripts', 'activate-site.js'),
    path.join('skills', 'create-site', 'scripts', 'validate-site.js'),
    path.join('hooks', 'run-skill-pretool-telemetry.js'),
    path.join('hooks', 'run-skill-posttool-validation.js'),
    path.join('hooks', 'run-user-prompt-telemetry.js'),
  ]) assert.doesNotMatch(fs.readFileSync(path.join(root, file), 'utf8'), /emit-non-spa-creation-telemetry|non_spa_creation_success|non_spa_creation_failure/, file);
});

test('symlinked run directories cannot redirect telemetry state writes', (t) => {
  const f = fixture(t);
  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  fs.mkdirSync(path.dirname(f.stateDir()), { recursive: true });
  try { fs.symlinkSync(outside, f.stateDir(), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('Host disallows symlink creation.');
    throw error;
  }
  assert.deepEqual(recordNonSpaCreation(select(), f.deps), { ok: false });
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('old helper-owned resume state is pruned without touching non-run directories', (t) => {
  const f = fixture(t);
  const old = f.stateDir(SECOND);
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, 'state.json'), '{}');
  fs.writeFileSync(path.join(old, 'finished.json'), '{}');
  const timestamp = new Date(Date.now() - 15 * 86400000);
  fs.utimesSync(old, timestamp, timestamp);
  const unrelated = path.join(path.dirname(old), 'not-a-run');
  fs.mkdirSync(unrelated);
  fs.utimesSync(unrelated, timestamp, timestamp);
  recordNonSpaCreation(select(), f.deps);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(unrelated), true);
});

test('existing dispatcher keeps a local mirror and enforces transmission opt-out for non-SPA events', (t) => {
  const f = fixture(t);
  recordNonSpaCreation(select(), f.deps);
  for (const [name, optout, choice, expectProbe] of [
    ['enabled', '', 'on', true], ['env-off', 'true', 'on', false], ['config-off', '', 'off', false],
  ]) {
    const configDir = path.join(f.root, name);
    fs.mkdirSync(configDir);
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ telemetry: { 'power-pages': choice } }));
    const probe = path.join(configDir, 'probe.json');
    const result = spawnSync(process.execPath, [DISPATCHER], {
      input: JSON.stringify(f.emitted[0].event), encoding: 'utf8', shell: false, timeout: 15000,
      env: {
        ...process.env, POWER_PLATFORM_SKILLS_IKEY_JSON: f.ikeyPath,
        POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir,
        POWER_PLATFORM_SKILLS_TELEMETRY_POWER_PAGES_OPTOUT: optout,
        POWER_PLATFORM_SKILLS_FAKE_HTTPS: probe,
        POWER_PLATFORM_SKILLS_IKEY: '', POWER_PLATFORM_SKILLS_COLLECTOR: '',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(probe), expectProbe, name);
    const local = path.join(configDir, 'telemetry', 'power-pages', 'sessions', 'test-session', 'events.jsonl');
    const mirror = JSON.parse(fs.readFileSync(local, 'utf8').trim());
    assert.equal(mirror.data.correlationId, CORRELATION);
    assert.equal(mirror.data.eventInfo.templateKind, 'non-spa');
    if (expectProbe) {
      const wire = JSON.parse(JSON.parse(fs.readFileSync(probe, 'utf8')).body);
      assert.deepEqual(JSON.parse(wire.data.eventInfo), mirror.data.eventInfo);
    }
  }
});
