const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const emitter = require('../../skills/migrate-datamodel/scripts/emit-telemetry');
const telemetry = path.join(__dirname, '../lib/telemetry');

test('completion metrics exclude migration details and do not claim pending work succeeded', () => {
  const state = {
    phases: [{ status: 'completed', title: 'Private phase title' }],
    skillStartedAt: '2026-01-01T00:00:00Z', lastUpdatedAt: '2026-01-01T00:00:05Z',
    site: { template: 'Private template' }, track: 'A',
  };
  assert.deepEqual(emitter.buildPhaseRollup(state), { outcome: 'success', durationMs: 5000 });
  assert.equal(emitter.buildPhaseRollup({ ...state, phases: [{ status: 'in-progress' }] }), null);
  assert.equal(emitter.buildPhaseRollup(null), null);
  assert.equal(emitter.buildPhaseRollup({ phases: [null] }), null);
  assert.deepEqual(emitter.buildPhaseRollup({ ...state, phases: [{ status: 'blocked' }] }),
    { outcome: 'failure', durationMs: 5000 });
});

test('regional config reaches the shared dispatcher without migration-specific eventInfo', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-telemetry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ikeyPath = path.join(root, 'ikey.json');
  const config = { disabled: false, event_stream_name: 'test-stream', default_region: 'us',
    regions: { us: { instrumentation_key: 'test-only-key' } } };
  fs.writeFileSync(ikeyPath, JSON.stringify(config));
  // Use the plugin's real provisioning gate, but never invoke its network resolver.
  fs.writeFileSync(path.join(root, 'resolver.js'),
    `module.exports = require(${JSON.stringify(path.join(telemetry, 'resolver.js'))});`);
  fs.writeFileSync(path.join(root, 'migration-state.json'), JSON.stringify({
    phases: [{ status: 'completed', title: 'Private phase title' }],
    site: { template: 'Private template' }, track: 'A',
  }));
  const oldArgs = process.argv;
  const oldKey = process.env.POWER_PLATFORM_SKILLS_IKEY_JSON;
  process.argv = [process.execPath, 'emit-telemetry.js', '--output-dir', root];
  process.env.POWER_PLATFORM_SKILLS_IKEY_JSON = ikeyPath;
  t.after(() => {
    process.argv = oldArgs;
    if (oldKey === undefined) delete process.env.POWER_PLATFORM_SKILLS_IKEY_JSON;
    else process.env.POWER_PLATFORM_SKILLS_IKEY_JSON = oldKey;
  });
  const calls = [];
  t.mock.method(require(path.join(telemetry, 'lib', 'emit-spawn')), 'fireAndForget',
    (event, options) => calls.push({ event, options }));
  t.mock.method(require(path.join(telemetry, 'lib', 'pac-auth')), 'readPacAuth', () => ({ cloud: 'Public' }));
  const agent = require(path.join(telemetry, 'lib', 'agent-info'));
  t.mock.method(agent, 'readAiAgent', () => ({}));
  t.mock.method(agent, 'readPacCliVersion', () => null);
  t.mock.method(require(path.join(telemetry, 'lib', 'session')), 'getSessionId', () => 'test-session');
  emitter.main();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.ikeyJsonPath, ikeyPath);
  assert.equal(calls[0].options.cloud, 'Public');
  assert.deepEqual(calls[0].event.data.eventInfo, {});
  assert.doesNotMatch(JSON.stringify(calls[0]), /Private phase title|Private template/);
  fs.writeFileSync(ikeyPath, JSON.stringify({ ...config, disabled: true }));
  emitter.main();
  assert.equal(calls.length, 1);
  fs.unlinkSync(ikeyPath);
  emitter.main();
  assert.equal(calls.length, 1);
});
