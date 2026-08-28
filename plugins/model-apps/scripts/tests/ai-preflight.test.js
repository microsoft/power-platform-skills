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
    // Script-relative requires must resolve against the SCRIPT, not this test file — the CLI lives
    // in scripts/ and its siblings are one directory up from tests/.
    if (id.startsWith('./')) {
      return require(path.join(path.dirname(scriptPath), id));
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
  assert.match(stderr, /✗ Form fill assist toolbar \(FormFillBarUXEnabled\)/);
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
  assert.match(harness.stderr.join(''), /All AI features are available \(enabled, or already in effect\)/);
  assert.ok(harness.events.some((e) => e.type === 'getAiReadiness' && Object.keys(e.opts).length === 0));
});

// --- "in effect" reporting: the gate is NOT the whole truth -----------------------------------
// Live-measured on a real environment: the readiness gate `EnableNLGridSearch` reads "false" while
// the feature's actual setting `NLGridSearchSetting` is "2" at ENVIRONMENT scope, so NL grid search
// runs in every app on that org. Reporting it as disabled — and telling an admin to switch it on —
// is wrong, and it is what this suite previously locked in.
const { effectiveSettingValue, settingIsOn } = require('../lib/ai-app-settings.js');

test('a gate-off feature that is ON at environment scope reports as in effect, with no admin action', () => {
  const readiness = {
    formFill: { enabled: false, setting: 'FormFillBarUXEnabled', value: '0' },
    nlSearch: { enabled: false, setting: 'EnableNLGridSearch', value: 'false' },
  };
  const effective = {
    formFill: { value: '0', scope: 'default', on: false },
    nlSearch: { value: '2', scope: 'environment', on: true },
  };
  const r = runPreflight(readiness, effective);
  const nl = r.features.find((f) => f.feature === 'nlSearch');
  assert.strictEqual(nl.inEffect, true);
  assert.strictEqual(nl.effectiveScope, 'environment');
  assert.strictEqual(nl.effectiveValue, '2');
  // Only the genuinely-off feature earns an admin action.
  assert.strictEqual(r.adminActions.length, 1);
  assert.match(r.adminActions[0], /Form fill assist toolbar/);
});

test('an UNREADABLE effective value never counts as in effect', () => {
  // Fail-closed: "could not look" must not suppress a real admin action, which would leave an
  // operator with no indication that anything needs doing.
  const readiness = { nlSearch: { enabled: false, setting: 'EnableNLGridSearch', value: 'false' } };
  const r = runPreflight(readiness, { nlSearch: { error: 'the setting definition could not be read: 401' } });
  assert.ok(!r.features.find((f) => f.feature === 'nlSearch').inEffect);
  assert.strictEqual(r.adminActions.length, 1);
});

test('omitting the effective map preserves the previous gate-only behaviour', () => {
  const readiness = { nlSearch: { enabled: false, setting: 'EnableNLGridSearch', value: 'false' } };
  const r = runPreflight(readiness);
  assert.strictEqual(r.adminActions.length, 1);
  assert.ok(!r.features.find((f) => f.feature === 'nlSearch').inEffect);
});

test('settingIsOn reads Dataverse string values, not JS truthiness', () => {
  // Every one of these is a trap: "0" and "false" are truthy strings in JS.
  assert.strictEqual(settingIsOn('0'), false);
  assert.strictEqual(settingIsOn('false'), false);
  assert.strictEqual(settingIsOn('1'), true);
  assert.strictEqual(settingIsOn('2'), true);       // NL grid search uses 2, not 1
  assert.strictEqual(settingIsOn('true'), true);
  assert.strictEqual(settingIsOn(''), undefined);
  assert.strictEqual(settingIsOn(undefined), undefined);
  assert.strictEqual(settingIsOn('yes'), undefined); // unparseable => indeterminate, never a guess
});

test('effectiveSettingValue prefers app scope, then environment, then the default', async () => {
  const def = [{ settingdefinitionid: 'def-1', defaultvalue: '0' }];
  const reader = (appRows, envRows) => ({
    queryRecords: async (entity) => {
      if (entity === 'settingdefinition') return def;
      if (entity === 'appsetting') return appRows;
      if (entity === 'organizationsetting') return envRows;
      throw new Error(`unexpected entity ${entity}`);
    },
  });

  assert.deepStrictEqual(
    await effectiveSettingValue(reader([{ value: '9' }], [{ value: '2' }]), 'app-1', 'S'),
    { value: '9', scope: 'app' });
  assert.deepStrictEqual(
    await effectiveSettingValue(reader([], [{ value: '2' }]), 'app-1', 'S'),
    { value: '2', scope: 'environment' });
  assert.deepStrictEqual(
    await effectiveSettingValue(reader([], []), 'app-1', 'S'),
    { value: '0', scope: 'default' });
  // No app in scope: skip the app layer entirely rather than erroring.
  assert.deepStrictEqual(
    await effectiveSettingValue(reader([], [{ value: '2' }]), null, 'S'),
    { value: '2', scope: 'environment' });
});

test('effectiveSettingValue reports a setting the environment does not declare as unsupported', async () => {
  // Distinct from "off": there is no admin action that would satisfy it, so the caller must be able
  // to say so precisely instead of alleging a missing override.
  const read = { queryRecords: async () => [] };
  const r = await effectiveSettingValue(read, 'app-1', 'm365copilotmodelappenabled');
  assert.ok(r.error);
  assert.strictEqual(r.unsupported, true);
  assert.strictEqual(r.value, undefined);
});

test('an unresolvable --app makes effective values INDETERMINATE, not environment-derived', async () => {
  // Peer-review finding. If `--app` is supplied but the app cannot be resolved, the app-scope layer
  // is UNKNOWN, not absent. Falling through to the environment value is actively harmful: an app
  // that overrides a feature to "0" while the environment holds "2" would be reported as in effect,
  // and the admin action for a genuinely disabled feature would be suppressed.
  const harness = loadPreflightCli({
    parseResult: { flags: { env: 'https://contoso.crm.dynamics.com', app: 'missing_app' } },
    readiness: {
      formFill: { enabled: false, setting: 'FormFillBarUXEnabled', value: '0' },
      nlSearch: { enabled: false, setting: 'EnableNLGridSearch', value: 'false' },
    },
  });
  try { await harness.main(); } catch (e) { if (e.exitCode === undefined) throw e; }
  const out = harness.stderr.join('');
  // The app could not be resolved (the stub SDK has no queryRecords), so nothing may be claimed to
  // be in effect, and the admin actions must survive.
  assert.match(out, /could not resolve app/i, `expected a warning about the unresolved app; got: ${out}`);
  assert.ok(!/in effect via/.test(out), 'no feature may be reported as in effect when app scope is unknown');
  assert.match(out, /Admin actions required/, 'genuine admin actions must NOT be suppressed');
});

test('a platform-default value is reported as UNKNOWN, not as off', () => {
  // For the AI form-fill family `0` means "defer to service flighting", not "disabled". Printing ✗
  // asserts something the environment does not say — and it is exactly why a user saw form fill
  // working while an earlier report called it off across every org.
  const readiness = { formFill: { enabled: false, setting: 'FormFillBarUXEnabled', value: '0' } };
  const r = runPreflight(readiness, { formFill: { value: '0', scope: 'default', on: undefined } });
  const f = r.features.find((x) => x.feature === 'formFill');
  assert.strictEqual(f.effectiveUnknown, true, 'a default value must be flagged unknown');
  assert.ok(!f.inEffect, 'unknown is not a claim that it runs');
  // Still actionable: leaving it to flighting is not a deterministic choice.
  assert.strictEqual(r.adminActions.length, 1);
});

test('a codec DISABLED value is off, not on', () => {
  // The bug this replaces: any non-zero value counted as on, so `1` (DISABLED) reported as enabled.
  const { settingIsOn } = require('../lib/ai-app-settings.js');
  assert.strictEqual(settingIsOn('1', 'formFill'), false, "'1' is DISABLED for the form-fill family");
  assert.strictEqual(settingIsOn('2', 'formFill'), true, "'2' is ENABLED");
  assert.strictEqual(settingIsOn('0', 'formFill'), undefined, "'0' is the platform default, not off");
  // A feature with no codec keeps the plain numeric convention.
  assert.strictEqual(settingIsOn('1', 'nlSearch'), true);
  assert.strictEqual(settingIsOn('2', 'nlSearch'), true);
  assert.strictEqual(settingIsOn('0', 'nlSearch'), false);
  // And with no feature key at all, the old convention still applies for existing callers.
  assert.strictEqual(settingIsOn('1'), true);
});
