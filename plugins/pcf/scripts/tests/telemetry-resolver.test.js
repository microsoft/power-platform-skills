'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const {
  TELEMETRY_DIR, FAKE_CONFIG, FAKE_REGIONS, ORG_ID, TENANT_ID, tempRoot, seedRegion,
} = require('./helpers/telemetry-fixtures.js');

function resolver() {
  const file = path.join(TELEMETRY_DIR, 'resolver.js');
  assert.ok(fs.existsSync(file), 'pcf must own its telemetry resolver');
  return require(file);
}

async function withGeo(t, geoName, fn) {
  const calls = [];
  t.mock.method(https, 'request', (options, respond) => {
    calls.push(options);
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = () => {};
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.setEncoding = () => {};
      respond(response);
      response.emit('data', JSON.stringify({ geoName }));
      response.emit('end');
    };
    return request;
  });
  return { result: await fn(), calls };
}

function expected(region) {
  return {
    region,
    iKey: FAKE_REGIONS[region].instrumentation_key,
    collectorUrl: FAKE_REGIONS[region].collector_url,
  };
}

test('placeholder PCF config is not provisioned', () => {
  const ownResolver = resolver();
  const cfg = JSON.parse(fs.readFileSync(path.join(TELEMETRY_DIR, 'ikey.json'), 'utf8'));
  assert.equal(ownResolver.isProvisioned(cfg), false);
});

test('provisioning needs a non-placeholder default-region key and collector', () => {
  const ownResolver = resolver();
  assert.equal(ownResolver.isProvisioned(FAKE_CONFIG), true);
  for (const cfg of [
    null, {}, { regions: {} },
    { regions: { us: { instrumentation_key: 'fake-key' } } },
    { regions: { us: { collector_url: 'https://example.invalid/' } } },
    { regions: { us: { instrumentation_key: 'PLACEHOLDER_REPLACE_BEFORE_SHIPPING', collector_url: 'https://example.invalid/' } } },
  ]) {
    assert.equal(ownResolver.isProvisioned(cfg), false);
  }
});

for (const cloud of ['', 'Public']) {
  test(`signed-out PAC (${cloud || 'no cloud stamp'}) uses the configured default without HTTPS`, async (t) => {
    const ownResolver = resolver();
    const { result, calls } = await withGeo(t, 'eu', () => ownResolver.resolve({
      event: { data: {} }, cfg: { ...FAKE_CONFIG, default_region: 'eu' }, cloud, configDir: tempRoot(t),
    }));
    assert.deepEqual(result, expected('eu'));
    assert.deepEqual(calls, []);
  });
}

for (const [cloud, region] of [
  ['UsGov', 'gov'], ['UsGovGcc', 'gov'], ['GCC', 'gov'], ['Gov', 'gov'],
  ['UsGovHigh', 'high'], ['High', 'high'], ['UsGovDod', 'dod'], ['Dod', 'dod'],
  ['China', 'mooncake'], ['Mooncake', 'mooncake'], ['ChinaCloud', 'mooncake'],
  ['Tip1', 'internal'], ['Tip2', 'internal'], ['Test', 'internal'], ['Preprod', 'internal'],
]) {
  test(`${cloud} routes from its stamp alone, never from a public geo`, async (t) => {
    const ownResolver = resolver();
    const { result, calls } = await withGeo(t, 'us', () => ownResolver.resolve({
      event: { data: { orgId: ORG_ID } }, cfg: FAKE_CONFIG, cloud, configDir: tempRoot(t),
    }));
    assert.deepEqual(result, expected(region));
    assert.deepEqual(calls, []);
  });
}

test('sovereign cloud without its configured entry never falls back to public', async (t) => {
  const ownResolver = resolver();
  const { result, calls } = await withGeo(t, 'us', () => ownResolver.resolve({
    event: { data: { orgId: ORG_ID } },
    cfg: { ...FAKE_CONFIG, regions: { us: FAKE_REGIONS.us } },
    cloud: 'UsGovHigh', configDir: tempRoot(t),
  }));
  assert.equal(result, null);
  assert.deepEqual(calls, []);
});

for (const cloud of ['UnknownCloud', 'USNat', '']) {
  test(`signed-in org with ${cloud || 'a missing cloud stamp'} is not transmitted`, async (t) => {
    const ownResolver = resolver();
    const { result, calls } = await withGeo(t, 'us', () => ownResolver.resolve({
      event: { data: { orgId: ORG_ID } }, cfg: FAKE_CONFIG, cloud, configDir: tempRoot(t),
    }));
    assert.equal(result, null);
    assert.deepEqual(calls, []);
  });
}

test('a public org uses its seeded EU cache and this plugin config, without HTTPS', async (t) => {
  const ownResolver = resolver();
  const configDir = tempRoot(t);
  seedRegion(configDir);
  const { result, calls } = await withGeo(t, 'us', () => ownResolver.resolve({
    event: { data: { orgId: ORG_ID } }, cfg: FAKE_CONFIG, cloud: 'Public', configDir,
  }));
  assert.deepEqual(result, expected('eu'));
  assert.deepEqual(calls, []);
});

test('a recognized public geo is cached as a region, never an instrumentation key', async (t) => {
  const ownResolver = resolver();
  const configDir = tempRoot(t);
  const { result, calls } = await withGeo(t, 'eu', () => ownResolver.resolve({
    event: { data: { orgId: ORG_ID } }, cfg: FAKE_CONFIG, cloud: 'Public', configDir,
  }));
  assert.deepEqual(result, expected('eu'));
  assert.equal(calls.length, 1);
  const cache = JSON.parse(fs.readFileSync(path.join(configDir, 'region-cache', `${ORG_ID}.json`), 'utf8'));
  assert.deepEqual(Object.keys(cache).sort(), ['expiresAt', 'region']);
  assert.equal(cache.region, 'eu');
});

for (const [label, geo] of [['unavailable', ''], ['unrecognized', 'mars']]) {
  test(`a public org whose geo is ${label} has no public-default fallback or cached fallback`, async (t) => {
    const ownResolver = resolver();
    const configDir = tempRoot(t);
    const { result, calls } = await withGeo(t, geo, () => ownResolver.resolve({
      event: { data: { orgId: ORG_ID } }, cfg: FAKE_CONFIG, cloud: 'Public', configDir,
    }));
    assert.equal(result, null);
    assert.equal(calls.length, 1);
    assert.equal(fs.existsSync(path.join(configDir, 'region-cache')), false);
  });
}

test('a cached public region missing from this config does not fall back to US', async (t) => {
  const ownResolver = resolver();
  const configDir = tempRoot(t);
  seedRegion(configDir);
  const { result, calls } = await withGeo(t, 'us', () => ownResolver.resolve({
    event: { data: { orgId: ORG_ID } },
    cfg: { ...FAKE_CONFIG, regions: { us: FAKE_REGIONS.us } }, cloud: 'Public', configDir,
  }));
  assert.equal(result, null);
  assert.deepEqual(calls, []);
});

test('the wire envelope has the Power Apps event shape and distinct PCF identity', () => {
  const ownResolver = resolver();
  const time = '2026-10-06T00:00:00.000Z';
  const data = {
    eventName: 'skill_started', eventType: 'Trace', severity: 'Info',
    pluginName: 'pcf', pluginVersion: '1.0.0', skillName: 'pcf',
    sessionId: 'pcf-session', correlationId: 'pcf-correlation',
    osName: 'Windows', osVersion: '10.0', nodeVersion: 'v22',
    orgId: ORG_ID, tenantId: TENANT_ID,
  };
  const { eventName, eventType, severity, ...dimensions } = data;
  assert.deepEqual(ownResolver.formatEnvelope({
    time, data, iKey: FAKE_REGIONS.eu.instrumentation_key, eventStreamName: 'event',
  }), {
    ver: '4.0', name: 'event', time, iKey: 'o:00000000',
    data: {
      app_Name: 'powerappsclient', clientType: 'PcfAIPlugin',
      event_Name: eventName, session_Id: data.sessionId, tenantId: TENANT_ID,
      severity, timestamp: time, customDimensions: JSON.stringify(dimensions),
    },
    ext: {
      app: { sesId: data.sessionId, ver: data.pluginVersion },
      os: { name: data.osName, ver: data.osVersion },
    },
  });
  assert.equal(eventType, 'Trace');
});

test('the wire envelope omits absent tenant identity and defaults to the event stream', () => {
  const envelope = resolver().formatEnvelope({ time: 't', data: { eventName: 'skill_started' }, iKey: 'fake-key' });
  assert.equal(envelope.name, 'event');
  assert.equal(Object.hasOwn(envelope.data, 'tenantId'), false);
  assert.equal(envelope.data.session_Id, '');
});
