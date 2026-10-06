'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const VALIDATOR = path.resolve(__dirname, '..', 'validate-telemetry-ikeys.js');
const SHARED_KEY = 'fake-shared-instrumentation-key';

function runValidator(t, configs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-key-validator-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, 'scripts', 'validate-telemetry-ikeys.js');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  // The validator derives its repository root from __dirname. Copy the script
  // rather than inspect real provisioned keys or mutate the working repository.
  fs.copyFileSync(VALIDATOR, script);
  for (const [plugin, cfg] of Object.entries(configs)) {
    const dir = path.join(root, 'plugins', plugin, 'scripts', 'lib', 'telemetry');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ikey.json'), JSON.stringify(cfg));
  }
  return spawnSync(process.execPath, [script], {
    cwd: root, encoding: 'utf8', timeout: 10_000, shell: false,
  });
}

function config(key, stream = 'event') {
  return {
    disabled: false,
    event_stream_name: stream,
    regions: { us: { instrumentation_key: key, collector_url: 'https://example.invalid/' } },
  };
}

function assertExit(result, expected) {
  assert.equal(result.status, expected, result.stderr || result.stdout);
}

test('model-apps and pcf may share the same instrumentation key', (t) => {
  assertExit(runValidator(t, {
    'model-apps': config(SHARED_KEY),
    pcf: config(SHARED_KEY),
  }), 0);
});

test('model-apps and power-pages may not share a key', (t) => {
  assertExit(runValidator(t, {
    'model-apps': config(SHARED_KEY),
    'power-pages': config(SHARED_KEY),
  }), 1);
});

test('pcf and mobile-apps may not share a key', (t) => {
  assertExit(runValidator(t, {
    pcf: config(SHARED_KEY),
    'mobile-apps': config(SHARED_KEY),
  }), 1);
});

test('model-apps, pcf and power-pages sharing one key still fail', (t) => {
  assertExit(runValidator(t, {
    'model-apps': config(SHARED_KEY),
    pcf: config(SHARED_KEY),
    'power-pages': config(SHARED_KEY),
  }), 1);
});

test('distinct keys and streams everywhere pass', (t) => {
  assertExit(runValidator(t, Object.fromEntries(
    ['model-apps', 'pcf', 'power-pages', 'mobile-apps'].map(plugin =>
      [plugin, config(`fake-${plugin}-key`, `fake-${plugin}-stream`)]),
  )), 0);
});

test('known placeholders, empty values and angle-bracket templates are ignored', (t) => {
  const placeholders = {
    event_stream_name: 'PluginEventStreamPlaceholder',
    instrumentationKey: '<your 1DS instrumentation key>',
    regions: {
      us: { instrumentation_key: 'PLACEHOLDER_REPLACE_BEFORE_SHIPPING' },
      eu: { instrumentation_key: '' },
      other: { instrumentation_key: ' ' },
    },
  };
  assertExit(runValidator(t, {
    'model-apps': placeholders,
    pcf: placeholders,
    'power-pages': placeholders,
  }), 0);
});

test('the shared event stream with distinct keys remains exempt', (t) => {
  assertExit(runValidator(t, Object.fromEntries(
    ['model-apps', 'pcf', 'power-pages', 'mobile-apps'].map(plugin =>
      [plugin, config(`fake-${plugin}-key`)]),
  )), 0);
});

test('sharing a non-event stream still fails even for model-apps and pcf', (t) => {
  assertExit(runValidator(t, {
    'model-apps': config('fake-model-apps-key', 'fake-private-stream'),
    pcf: config('fake-pcf-key', 'fake-private-stream'),
  }), 1);
});

test('flat and regional config shapes share the same narrow key exception', (t) => {
  assertExit(runValidator(t, {
    'model-apps': { instrumentationKey: SHARED_KEY, event_stream_name: 'event' },
    pcf: config(SHARED_KEY),
  }), 0);
});

test('a plugin may still reuse its own key across several regions', (t) => {
  const cfg = config(SHARED_KEY);
  cfg.regions.eu = { ...cfg.regions.us };
  assertExit(runValidator(t, { pcf: cfg }), 0);
});

test('strings merely containing placeholder are not exempt keys', (t) => {
  assertExit(runValidator(t, {
    pcf: config('fake-placeholder-containing-key'),
    'power-pages': config('fake-placeholder-containing-key'),
  }), 1);
});

test('collision diagnostics never print the full instrumentation key', (t) => {
  const result = runValidator(t, {
    pcf: config(SHARED_KEY),
    'power-pages': config(SHARED_KEY),
  });
  assertExit(result, 1);
  assert.equal((result.stdout + result.stderr).includes(SHARED_KEY), false);
  assert.match(result.stdout, /pcf:.*ikey\.json/);
  assert.match(result.stdout, /power-pages:.*ikey\.json/);
});

for (const outsider of ['canvas-apps', 'code-apps', 'power-automate', 'power-apps-mobile-extension', 'new-plugin']) {
  test(`the sanctioned pair cannot extend key sharing to ${outsider}`, (t) => {
    for (const members of [['model-apps'], ['pcf'], ['model-apps', 'pcf']]) {
      assertExit(runValidator(t, Object.fromEntries(
        [...members, outsider].map(plugin => [plugin, config(SHARED_KEY)]),
      )), 1);
    }
  });
}
