'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const scripts = path.resolve(__dirname, '../../../skills/manage-governance/scripts');
const policy = 'EnableIdpOAuthFacebook';
const portals = [{ portalId: 'test-site', name: 'Test Site', url: 'https://example.invalid' }];
const availability = require('../../../skills/manage-governance/scripts/resolve-portal-availability');
const deps = availability.dependenciesForPolicy(policy, availability.loadMapping());

// Run real readers and the shared transport against mocked HTTP responses.
// No PAC/Azure CLI state, auth subprocess, or live endpoint is accessed.
function harness(unconfigured, failedStatus) {
  let stdout = '';
  let stderr = '';
  const context = { environmentId: 'test-env', baseUrl: 'https://api.powerplatform.com/powerpages/environments/test-env' };
  const processStub = {
    argv: ['node', 'test-script', '--policy', policy],
    stdout: { write: (text) => { stdout += text; } },
    stderr: { write: (text) => { stderr += text; } },
    exit(code) { throw Object.assign(new Error(`CLI exited ${code}`), { exitCode: code }); },
  };
  let transport;
  function load(name) {
    const filename = path.join(scripts, `${name}.js`);
    const realRequire = createRequire(filename);
    const sandbox = {
      module: { exports: {} },
      __dirname: scripts,
      process: processStub,
      require(dependency) {
        if (dependency === './governance-transport') return transport;
        if (dependency === './governance-context') return { resolveGovernanceContext: () => context };
        if (dependency === './list-portals') return { fetchPortalsPaged: async () => ({ portals }) };
        if (dependency === './resolve-portal-availability') {
          return { ...availability, readPortalsInput: async () => portals };
        }
        if (dependency === '../../../scripts/lib/power-platform-api') {
          return {
            parseCliArgs: () => ({ policy }),
            runCli() {},
            fail(message, code) { throw Object.assign(new Error(message), { exitCode: code }); },
            async request({ path: route }) {
              const selectedPolicy = decodeURIComponent(route.split('/')[2]);
              const statusCode = failedStatus || (unconfigured.includes(selectedPolicy) ? 404 : 200);
              return statusCode === 200
                ? { ok: true, statusCode, body: route.endsWith('/details') ? {} : 'All' }
                : { ok: false, statusCode, body: null, error: { code: `HTTP_${statusCode}`, message: 'Read failed' } };
            },
          };
        }
        return realRequire(dependency);
      },
    };
    vm.runInNewContext(
      `${fs.readFileSync(filename, 'utf8')}\nmodule.exports.testMain = typeof main === 'function' ? main : undefined;`,
      sandbox,
      { filename },
    );
    return sandbox.module.exports;
  }
  transport = load('governance-transport');
  return {
    load,
    async run(name) {
      await load(name).testMain();
      return JSON.parse(stdout);
    },
    get stderr() { return stderr; },
  };
}

test('get-env reports an unconfigured policy rather than failing its documented 404', async () => {
  const h = harness([policy]);
  const result = await h.run('get-env');
  assert.equal(result.status, 'ok');
  assert.equal(result.settingPresent, false);
  assert.equal(result.value, 'None');
  assert.match(result.message, /No governance setting on record/);
  assert.equal(h.stderr, '');
});

for (const script of ['fetch-env-status', 'get-effective-status']) {
  for (const missing of [policy, deps[0]]) {
    test(`${script} preserves rows and reports an unconfigured ${missing === policy ? 'policy' : 'parent'}`, async () => {
      const h = harness([missing]);
      const result = await h.run(script);
      assert.equal(result.status, 'ok');
      assert.equal(result.settingPresent, missing !== policy);
      assert.deepEqual(result.unconfiguredPolicies, [missing]);
      assert.equal(result.portals.length, 1);
      assert.equal(result.portals[0].state, false);
      assert.equal(result.effectiveEnabledCount, 0);
      if (script === 'fetch-env-status' && missing === policy) assert.equal(result.envValue, 'None');
      if (missing !== policy) assert.equal(result.portals[0].parents[missing], false);
      assert.equal(h.stderr, '');
    });
  }
}

test('an unconfigured prerequisite is a known disabled parent eligible for remediation', async () => {
  const h = harness([deps[0]]);
  const resolver = h.load('resolve-portal-availability');
  const states = await resolver.readParentStates([deps[0]]);
  assert.equal(states[deps[0]].envValue, 'None');
  assert.equal(resolver.computeSiteState(states[deps[0]].envValue), 'Disabled');
});

for (const script of ['get-env', 'fetch-env-status', 'get-effective-status']) {
  test(`${script} still fails on a real environment-read error`, async () => {
    const h = harness([], 503);
    await assert.rejects(h.run(script), (error) => error.exitCode === 1);
  });
}
