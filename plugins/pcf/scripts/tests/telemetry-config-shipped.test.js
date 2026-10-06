'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PLUGIN_ROOT, TELEMETRY_DIR } = require('./helpers/telemetry-fixtures.js');

const COLLECTORS = {
  internal: 'https://us-mobile.events.data.microsoft.com/OneCollector/1.0/',
  us: 'https://us-mobile.events.data.microsoft.com/OneCollector/1.0/',
  eu: 'https://eu-mobile.events.data.microsoft.com/OneCollector/1.0/',
  gov: 'https://tb.events.data.microsoft.com/OneCollector/1.0/',
  high: 'https://tb.events.data.microsoft.com/OneCollector/1.0/',
  dod: 'https://pf.events.data.microsoft.com/OneCollector/1.0/',
  mooncake: 'https://collector.azure.cn/OneCollector/1.0/',
};

// A key rotation is a model-apps change copied here in the same PR; the root
// copy validator and this byte comparison keep the shared tenant in sync.
test('shipped PCF telemetry is enabled with a verbatim model-apps config in the event stream', (t) => {
  const file = path.join(TELEMETRY_DIR, 'ikey.json');
  assert.ok(fs.existsSync(file), 'pcf must bundle the shared telemetry config');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(cfg.disabled, false);
  assert.equal(cfg.default_region, 'us');
  assert.equal(cfg.event_stream_name, 'event');
  assert.deepEqual(Object.keys(cfg).sort(), ['default_region', 'disabled', 'event_stream_name', 'regions']);
  assert.deepEqual(Object.keys(cfg.regions).sort(), Object.keys(COLLECTORS).sort());
  for (const [region, entry] of Object.entries(cfg.regions)) {
    assert.ok(typeof entry.instrumentation_key === 'string' && entry.instrumentation_key
      && entry.instrumentation_key !== 'PLACEHOLDER_REPLACE_BEFORE_SHIPPING',
    `${region} must have a provisioned key`);
    assert.equal(entry.collector_url, COLLECTORS[region]);
  }
  const source = path.resolve(PLUGIN_ROOT, '..', 'model-apps', 'scripts', 'lib', 'telemetry', 'ikey.json');
  if (!fs.existsSync(source)) { t.skip('model-apps source is not present in an installed plugin'); return; }
  // Do not expose key values in an assertion diff.
  assert.ok(fs.readFileSync(file).equals(fs.readFileSync(source)), 'model-apps and pcf configs must be byte-identical');
});
