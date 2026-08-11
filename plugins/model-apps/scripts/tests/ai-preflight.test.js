'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { runPreflight } = require('../ai-preflight.js');

test('runPreflight lists features and produces admin actions for disabled ones', () => {
  const readiness = {
    formFill: { enabled: false, setting: 'FormFillBarUXEnabled', value: '0' },
    nlSearch: { enabled: true, setting: 'EnableNLGridSearch', value: 'true' },
    nlChart: { enabled: false, setting: 'NLChartVisualizationSetting', value: 'false' },
    summaries: { enabled: true, setting: 'EnableFormInsights', value: 'true' },
    m365: { enabled: false, setting: 'm365copilotmodelappenabled', value: '0' },
  };
  const r = runPreflight(readiness);
  assert.strictEqual(r.features.length, 5);
  assert.ok(r.features.find((f) => f.feature === 'nlSearch').enabled === true);
  assert.ok(r.adminActions.length === 3); // formFill, nlChart, m365 disabled
  assert.ok(r.adminActions.some((a) => /form.?fill/i.test(a)));
});

test('runPreflight returns no admin actions when all features are enabled', () => {
  const readiness = {
    formFill: { enabled: true, setting: 'FormFillBarUXEnabled', value: '1' },
    nlSearch: { enabled: true, setting: 'EnableNLGridSearch', value: 'true' },
    nlChart: { enabled: true, setting: 'NLChartVisualizationSetting', value: 'true' },
    summaries: { enabled: true, setting: 'EnableFormInsights', value: 'true' },
    m365: { enabled: true, setting: 'm365copilotmodelappenabled', value: '1' },
  };
  const r = runPreflight(readiness);
  assert.strictEqual(r.features.length, 5);
  assert.strictEqual(r.adminActions.length, 0);
});

test('runPreflight summaries admin action mentions AI insight cards', () => {
  const readiness = {
    formFill: { enabled: true, setting: 'FormFillBarUXEnabled', value: '1' },
    nlSearch: { enabled: true, setting: 'EnableNLGridSearch', value: 'true' },
    nlChart: { enabled: true, setting: 'NLChartVisualizationSetting', value: 'true' },
    summaries: { enabled: false, setting: 'EnableFormInsights', value: 'false' },
    m365: { enabled: true, setting: 'm365copilotmodelappenabled', value: '1' },
  };
  const r = runPreflight(readiness);
  assert.strictEqual(r.adminActions.length, 1);
  assert.ok(/ai insight cards/i.test(r.adminActions[0]), 'summaries action mentions "AI insight cards"');
});

test('runPreflight features include feature name, enabled flag, and setting', () => {
  const readiness = {
    formFill: { enabled: false, setting: 'FormFillBarUXEnabled', value: '0' },
    nlSearch: { enabled: true, setting: 'EnableNLGridSearch', value: 'true' },
    nlChart: { enabled: true, setting: 'NLChartVisualizationSetting', value: 'true' },
    summaries: { enabled: true, setting: 'EnableFormInsights', value: 'true' },
    m365: { enabled: true, setting: 'm365copilotmodelappenabled', value: '1' },
  };
  const r = runPreflight(readiness);
  const ff = r.features.find((f) => f.feature === 'formFill');
  assert.ok(ff, 'formFill feature present');
  assert.strictEqual(ff.enabled, false);
  assert.strictEqual(ff.setting, 'FormFillBarUXEnabled');
});

test('runPreflight ignores feature keys the SDK did not return', () => {
  const r = runPreflight({
    nlSearch: { enabled: false, setting: 'EnableNLGridSearch', value: 'false' },
  });

  assert.deepStrictEqual(r.features, [{ feature: 'nlSearch', enabled: false, setting: 'EnableNLGridSearch' }]);
  assert.strictEqual(r.adminActions.length, 1);
});

function loadPreflightCli({ parseResult, readiness, sdkThrows = null }) {
  const scriptPath = path.join(__dirname, '..', 'ai-preflight.js');
  const source = `${fs.readFileSync(scriptPath, 'utf8')}\nmodule.exports.__mainForTest = main;\n`;
  const events = [];
  const stderr = [];
  const mod = { exports: {} };
  const fakeFs = {
    mkdtempSync: (prefix) => {
      events.push({ type: 'mkdtempSync', prefix });
      return 'D:\\Projects\\power-platform-skills-sdk\\.test-workspace\\ai-preflight';
    },
    rmSync: (dir, opts) => events.push({ type: 'rmSync', dir, opts }),
  };
  const customRequire = (id) => {
    if (id === './lib/dataverse-auth.js') {
      return {
        parseArgs: () => parseResult,
        emitResult: (ok, payload) => events.push({ type: 'emitResult', ok, payload }),
      };
    }
    if (id === './lib/sdk-http-client.js') {
      return { createAzHttpClient: (env) => ({ env }) };
    }
    if (id === 'node:fs') return fakeFs;
    if (id === 'node:os') return { tmpdir: () => 'D:\\Projects\\power-platform-skills-sdk\\.test-workspace' };
    if (id === 'node:path') return path;
    if (id === './vendor/cds-maker-sdk.cjs') {
      return {
        createMakerSdk: (cfg) => {
          events.push({ type: 'createMakerSdk', cfg });
          if (sdkThrows) throw sdkThrows;
          return {
            initWorkspace: () => events.push({ type: 'initWorkspace' }),
            getAiReadiness: async (opts) => {
              events.push({ type: 'getAiReadiness', opts });
              return readiness;
            },
          };
        },
      };
    }
    return require(id);
  };
  customRequire.main = {};
  const sandboxProcess = {
    argv: ['node', scriptPath],
    stderr: { write: (message) => stderr.push(message) },
    exit: (code) => {
      const err = new Error(`process.exit(${code})`);
      err.exitCode = code;
      throw err;
    },
  };
  vm.runInNewContext(source, {
    require: customRequire,
    module: mod,
    exports: mod.exports,
    process: sandboxProcess,
    Buffer,
  }, { filename: scriptPath });
  return { main: mod.exports.__mainForTest, events, stderr };
}

test('ai-preflight CLI rejects a missing --env before creating the throwaway SDK workspace', async () => {
  const harness = loadPreflightCli({ parseResult: { flags: { app: 'contoso_app' } }, readiness: {} });

  await assert.rejects(harness.main(), (err) => err.exitCode === 1);
  assert.match(harness.stderr.join(''), /Usage: node scripts\/ai-preflight\.js/);
  assert.ok(!harness.events.some((e) => e.type === 'mkdtempSync'), 'usage errors stay read-only and create no workspace');
});

test('ai-preflight CLI passes the app scope, prints admin actions, emits the report, and cleans up first', async () => {
  const readiness = {
    formFill: { enabled: false, setting: 'FormFillBarUXEnabled', value: '0' },
    nlSearch: { enabled: true, setting: 'EnableNLGridSearch', value: 'true' },
    m365: { enabled: false, setting: 'm365copilotmodelappenabled', value: '0' },
  };
  const harness = loadPreflightCli({
    parseResult: { flags: { env: 'https://org.example', app: 'new_supportdesk' } },
    readiness,
  });

  await harness.main();
  const stderr = harness.stderr.join('');
  const emitIndex = harness.events.findIndex((e) => e.type === 'emitResult');
  const cleanupIndex = harness.events.findIndex((e) => e.type === 'rmSync');
  const emitted = harness.events[emitIndex];

  assert.ok(harness.events.some((e) => e.type === 'getAiReadiness' && e.opts.appUniqueName === 'new_supportdesk'));
  assert.match(stderr, /AI Feature Readiness/);
  assert.match(stderr, /✗ Form fill \(FormFillBarUXEnabled\)/);
  assert.match(stderr, /Admin actions required:/);
  assert.ok(cleanupIndex > -1 && cleanupIndex < emitIndex, 'emitResult exits, so cleanup must happen first');
  assert.strictEqual(emitted.ok, true);
  assert.strictEqual(emitted.payload.ok, true);
  assert.strictEqual(emitted.payload.adminActions.length, 2);
});

test('ai-preflight CLI reports all-enabled status without admin actions', async () => {
  const readiness = {
    formFill: { enabled: true, setting: 'FormFillBarUXEnabled', value: '1' },
  };
  const harness = loadPreflightCli({
    parseResult: { flags: { env: 'https://org.example' } },
    readiness,
  });

  await harness.main();
  assert.match(harness.stderr.join(''), /All AI features are enabled/);
  assert.ok(harness.events.some((e) => e.type === 'getAiReadiness' && Object.keys(e.opts).length === 0));
});
