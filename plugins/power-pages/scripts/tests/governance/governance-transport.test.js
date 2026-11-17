'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const modulePath = require.resolve('../../../skills/manage-governance/scripts/governance-transport');
const realRequire = createRequire(modulePath);

// Exercise the real route builder without credentials, authentication subprocesses,
// or gateway traffic; context and request are the only replaced dependencies.
function harness(context, response = { ok: true, statusCode: 200, body: 'test-result' }) {
  const resolutions = [];
  const requests = [];
  const sandbox = {
    module: { exports: {} },
    require(name) {
      if (name === './governance-route') return realRequire(name);
      if (name === './governance-context') {
        return {
          resolveGovernanceContext(envId) {
            resolutions.push(envId);
            return context;
          },
        };
      }
      if (name === '../../../scripts/lib/power-platform-api') {
        return {
          async request(args) {
            requests.push(args);
            return response;
          },
        };
      }
      throw new Error(`Unexpected dependency: ${name}`);
    },
  };
  vm.runInNewContext(fs.readFileSync(modulePath, 'utf8'), sandbox, { filename: modulePath });
  return { call: sandbox.module.exports.callGovernance, resolutions, requests };
}

const operations = [
  ['apply', 'POST', '/governance'],
  ['getEnv', 'GET', '/governance/TestPolicy'],
  ['getStatus', 'GET', '/governance/status/TestPolicy'],
  ['getDetails', 'GET', '/governance/TestPolicy/details'],
  ['getPortal', 'GET', '/websites/test-site/governance/TestPolicy'],
];

for (const [op, method, path] of operations) {
  for (const reuseContext of [false, true]) {
    test(`${op} without envId uses ${reuseContext ? 'pre-resolved' : 'current/configured'} context`, async () => {
      const context = {
        environmentId: 'resolved-env',
        baseUrl: 'https://api.powerplatform.com/powerpages/environments/resolved-env',
        token: 'test-token',
      };
      const h = harness(context);
      const body = { test: 'payload' };
      const result = await h.call({
        op, policy: 'TestPolicy', portalId: 'test-site', body, timeout: 60_000,
        ...(reuseContext ? { context } : {}),
      });
      assert.equal(result.ok, true);
      assert.equal(result.transport, 'gateway');
      assert.deepEqual(h.resolutions, reuseContext ? [] : [undefined]);
      assert.equal(h.requests.length, 1);
      assert.strictEqual(h.requests[0].context, context);
      assert.equal(h.requests[0].method, method);
      assert.equal(h.requests[0].path, path);
      assert.strictEqual(h.requests[0].body, body);
      assert.equal(h.requests[0].timeout, 60_000);
    });
  }
}

test('explicit envId is passed to context resolution unchanged', async () => {
  const context = { environmentId: 'explicit-env', baseUrl: 'test-base-url' };
  const h = harness(context);
  assert.equal((await h.call({ op: 'getEnv', policy: 'TestPolicy', envId: 'explicit-env' })).ok, true);
  assert.deepEqual(h.resolutions, ['explicit-env']);
  assert.strictEqual(h.requests[0].context, context);
});

test('unresolved environments and authentication errors fail before any gateway request', async () => {
  for (const context of [{ error: 'Sign-in required' }, {}]) {
    const h = harness(context);
    const result = await h.call({ op: 'getEnv', policy: 'TestPolicy' });
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 0);
    assert.equal(result.error.code, 'ContextError');
    assert.match(result.error.message, context.error ? /Sign-in required/ : /No environment could be resolved.*--envId/);
    assert.equal(h.requests.length, 0);
  }
});

test('resolving an environment preserves required policy and site validation', async () => {
  const h = harness({ environmentId: 'resolved-env' });
  await assert.rejects(h.call({ op: 'getEnv' }), /policy is required/);
  await assert.rejects(h.call({ op: 'getPortal', policy: 'TestPolicy' }), /portalId is required/);
  assert.equal(h.requests.length, 0);
});

test('only an environment-policy 404 becomes an explicit unconfigured disabled scope', async () => {
  const failure = {
    ok: false, statusCode: 404, body: { error: { message: 'Not found' } },
    error: { code: 'HTTP_404', message: 'Not found' },
  };
  for (const [op] of operations) {
    const h = harness({ environmentId: 'test-env' }, failure);
    const result = await h.call({ op, policy: 'TestPolicy', portalId: 'test-site' });
    assert.equal(result.statusCode, 404);
    assert.equal(result.ok, op === 'getEnv');
    if (op === 'getEnv') {
      assert.equal(result.body, 'None');
      assert.equal(result.settingPresent, false);
      assert.equal(result.error, undefined);
    } else {
      assert.strictEqual(result.body, failure.body);
      assert.strictEqual(result.error, failure.error);
      assert.equal(result.settingPresent, undefined);
    }
  }
});

test('environment-policy authentication, transport, and server failures remain failures', async () => {
  for (const statusCode of [0, 400, 401, 403, 429, 500, 503]) {
    const failure = { ok: false, statusCode, body: null, error: { code: 'Failure', message: 'Rejected' } };
    const h = harness({ environmentId: 'test-env' }, failure);
    const result = await h.call({ op: 'getEnv', policy: 'TestPolicy' });
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, statusCode);
    assert.strictEqual(result.error, failure.error);
    assert.equal(result.settingPresent, undefined);
  }
});
