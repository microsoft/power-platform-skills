'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const {
  TELEMETRY_DIR, FAKE_REGIONS, assertHookIsolation,
} = require('./telemetry-fixtures.js');

assertHookIsolation(process.env);
const configDir = process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR;
const probe = process.env.POWER_PLATFORM_SKILLS_FAKE_HTTPS;

function blockNetwork() {
  // Hooks intentionally swallow telemetry errors. Persist the attempt so the
  // parent test still fails instead of mistaking a caught error for isolation.
  fs.appendFileSync(path.join(configDir, 'blocked-network.jsonl'), '{"blocked":true}\n');
  throw new Error('offline hook test forbids network I/O');
}
for (const protocol of [require('node:http'), require('node:https')]) {
  protocol.request = blockNetwork;
  protocol.get = blockNetwork;
}

if (path.basename(process.argv[1] || '') === 'emit-dispatcher.js') {
  // Opt-outs write the mirror before checking transmission. Completion must be
  // observed before asserting that there was no late POST.
  process.on('exit', () => fs.writeFileSync(path.join(configDir, 'dispatcher-exited.json'), '{"exited":true}'));
  const shippedConfig = path.join(TELEMETRY_DIR, 'ikey.json');
  if (path.resolve(process.env.POWER_PLATFORM_SKILLS_IKEY_JSON || shippedConfig) === shippedConfig) {
    const resolver = require(path.join(TELEMETRY_DIR, 'resolver.js'));
    const resolve = resolver.resolve;
    resolver.resolve = async (context) => {
      const destination = await resolve(context);
      if (!destination) return destination;
      const configured = context.cfg.regions[destination.region];
      assert.ok(destination.iKey === configured.instrumentation_key, 'resolve must use the configured regional key');
      assert.equal(destination.collectorUrl, configured.collector_url);
      fs.writeFileSync(path.join(configDir, 'routing-proof.json'), JSON.stringify({
        region: destination.region, collectorUrl: destination.collectorUrl, usesConfiguredKey: true,
      }));
      // Exercise the shipped bytes and real routing, but never persist a real
      // key in the fake probe. Only the captured key is replaced; no network
      // operation can escape the mandatory probe and the blockers above.
      return { ...destination, iKey: FAKE_REGIONS[destination.region].instrumentation_key };
    };
  }
}

const spawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  if (args.some((arg) => path.basename(arg) === 'emit-dispatcher.js')) {
    assertHookIsolation(options.env, configDir);
    assert.equal(options.env.POWER_PLATFORM_SKILLS_FAKE_HTTPS, probe, 'dispatcher must inherit the fake HTTPS probe');
    // emit-spawn deliberately strips NODE_OPTIONS. Pass the preload explicitly
    // so the detached child cannot lose the network blocker or completion marker.
    // Its minimal env also omits temp variables. Preserve the fixture's temp
    // root explicitly: POSIX does not implicitly inherit TMPDIR like Windows
    // can inherit TEMP, and the child's fallback may be outside the config root.
    // https://nodejs.org/api/os.html#ostmpdir
    const tempDir = os.tmpdir();
    const env = { ...options.env, TEMP: tempDir, TMP: tempDir, TMPDIR: tempDir };
    return spawn(command, ['--require', __filename, ...args], { ...options, env });
  }
  return spawn(command, args, options);
};
