'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { TELEMETRY_DIR } = require('./helpers/telemetry-fixtures.js');

const COLLECTORS = {
  internal: 'https://us-mobile.events.data.microsoft.com/OneCollector/1.0/',
  us: 'https://us-mobile.events.data.microsoft.com/OneCollector/1.0/',
  eu: 'https://eu-mobile.events.data.microsoft.com/OneCollector/1.0/',
  gov: 'https://tb.events.data.microsoft.com/OneCollector/1.0/',
  high: 'https://tb.events.data.microsoft.com/OneCollector/1.0/',
  dod: 'https://pf.events.data.microsoft.com/OneCollector/1.0/',
  mooncake: 'https://collector.azure.cn/OneCollector/1.0/',
};

// Deliberately pin the staged release. When pcf's own keys are provisioned,
// update this test and the adopter disclosures together before enabling it.
test('shipped PCF telemetry stays disabled with placeholders in the shared event stream', () => {
  const file = path.join(TELEMETRY_DIR, 'ikey.json');
  assert.ok(fs.existsSync(file), 'pcf must ship its own staged telemetry config');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(cfg.disabled, true);
  assert.equal(cfg.default_region, 'us');
  assert.equal(cfg.event_stream_name, 'event');
  assert.deepEqual(Object.keys(cfg).sort(), ['default_region', 'disabled', 'event_stream_name', 'regions']);
  assert.deepEqual(Object.keys(cfg.regions).sort(), Object.keys(COLLECTORS).sort());
  for (const [region, entry] of Object.entries(cfg.regions)) {
    assert.deepEqual(entry, {
      instrumentation_key: 'PLACEHOLDER_REPLACE_BEFORE_SHIPPING',
      collector_url: COLLECTORS[region],
    }, `${region} must use a placeholder and the public regional OneCollector endpoint`);
  }
});
