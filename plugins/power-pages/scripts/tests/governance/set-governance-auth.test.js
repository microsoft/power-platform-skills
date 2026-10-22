'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const modulePath = require.resolve('../../../skills/manage-governance/scripts/set-governance');
const apiPath = require.resolve('../../lib/power-platform-api');
const realRequire = createRequire(modulePath);
const envId = 'test-environment';
const ok = (body = 'Succeeded') => ({ ok: true, statusCode: 200, body, transport: 'gateway' });
const networkError = () => ({
  ok: false, statusCode: 0, body: null, error: { code: 'NetworkError', message: 'connection lost' },
});

class CliExit extends Error {
  constructor(code) {
    super(`CLI exited ${code}`);
    this.code = code;
  }
}

// Exercise the real CLI main and shared pollUntil with virtual time. All
// context/network dependencies are replaced; no operator credentials, login
// subprocesses, or live governance endpoints are accessed.
function harness(responses, context = { environmentId: envId, token: 'test-only' }, extraArgs = []) {
  let now = 0;
  let main;
  let stdout = '';
  let stderr = '';
  const calls = [];
  const resolutions = [];
  const waits = [];
  const queue = [...responses];
  const processStub = {
    argv: ['node', modulePath, '--policy', 'EnableProtocolOpenIdConnect', '--envId', envId, ...extraArgs],
    stdout: { write: (text) => { stdout += text; } },
    stderr: { write: (text) => { stderr += text; } },
    exit(code) { throw new CliExit(code); },
  };
  const apiSandbox = {
    module: { exports: {} },
    require(name) {
      if (name === 'child_process' || name === './validation-helpers') return {};
      throw new Error(`Unexpected API dependency: ${name}`);
    },
    process: processStub,
    Date: class extends Date { static now() { return now; } },
    setTimeout(callback, ms) {
      waits.push(ms);
      now += ms;
      queueMicrotask(callback);
    },
  };
  vm.runInNewContext(fs.readFileSync(apiPath, 'utf8'), apiSandbox, { filename: apiPath });
  const sandbox = {
    module: { exports: {} },
    process: processStub,
    require(name) {
      if (name === '../../../scripts/lib/power-platform-api') {
        return { ...apiSandbox.module.exports, runCli: (mod, callback) => { main = callback; } };
      }
      if (name === './governance-context') {
        return { resolveGovernanceContext: (id) => { resolutions.push(id); return context; } };
      }
      if (name === './governance-transport') {
        return {
          async callGovernance(args) {
            assert.strictEqual(args.context, context, 'every call must reuse the resolved context');
            calls.push(args);
            assert.ok(queue.length, `Unexpected call: ${args.op}`);
            return queue.shift();
          },
        };
      }
      if (name === './policies') return realRequire(name);
      throw new Error(`Unexpected Apply dependency: ${name}`);
    },
  };
  vm.runInNewContext(fs.readFileSync(modulePath, 'utf8'), sandbox, { filename: modulePath });
  return {
    calls, resolutions, waits,
    async run() {
      let code = 0;
      try {
        await main();
      } catch (error) {
        if (!(error instanceof CliExit)) throw error;
        code = error.code;
      }
      return { code, stdout, stderr };
    },
  };
}

test('Apply resolves context once and retains fixed 30-second polling after transient failures', async () => {
  const h = harness([ok(), ok('InProgress'), networkError(), ok()]);
  const result = await h.run();
  assert.equal(result.code, 0);
  assert.deepEqual(h.resolutions, [envId]);
  assert.deepEqual(h.calls.map((call) => call.op), ['apply', 'getStatus', 'getStatus', 'getStatus']);
  assert.deepEqual(h.waits, [30_000, 30_000]);
  assert.equal(JSON.parse(result.stdout).status, 'applied');
  assert.equal(JSON.parse(result.stdout).attempts, 3);
});

test('Apply also reuses its context for existing uncertain-response recovery', async () => {
  const h = harness([networkError(), ok('All'), ok()]);
  assert.equal((await h.run()).code, 0);
  assert.deepEqual(h.resolutions, [envId]);
  assert.deepEqual(h.calls.map((call) => call.op), ['apply', 'getEnv', 'getStatus']);
});

for (const scope of ['Include', 'Exclude']) {
  test(`CLI forwards comma/space-separated removals for a removal-only ${scope} edit`, async () => {
    const h = harness([ok(), ok()], undefined, [
      '--policyValue', scope, '--removePortalIds', 'site-a, site-b site-c',
    ]);
    const result = await h.run();
    assert.equal(result.code, 0);
    assert.deepEqual(h.calls.map((call) => call.op), ['apply', 'getStatus']);
    const payload = JSON.parse(JSON.stringify(h.calls[0].body));
    assert.deepEqual(payload, [{
      policyName: 'EnableProtocolOpenIdConnect',
      policyValue: scope,
      ToBeAdded: [],
      ToBeRemoved: ['site-a', 'site-b', 'site-c'],
    }]);
  });
}

for (const statusCode of [400, 409, 429, 500, 503]) {
  for (const scope of ['Include', 'Exclude']) {
    test(`HTTP ${statusCode} rejects a ${scope} membership edit without matching-scope recovery`, async () => {
      const rejection = {
        ok: false,
        statusCode,
        error: { code: 'Rejected', message: 'governance update rejected' },
      };
      // If reached, these reads could falsely confirm a rejected edit using
      // the existing scope and a previous rollout's success.
      const h = harness([rejection, ok(scope), ok()], undefined, [
        '--policyValue', scope, '--portalIds', 'site-b', '--removePortalIds', 'site-a',
      ]);
      const result = await h.run();
      assert.equal(result.code, 1);
      assert.equal(result.stdout, '');
      assert.ok(result.stderr.includes(`HTTP ${statusCode}`));
      assert.match(result.stderr, /governance update rejected/);
      assert.deepEqual(h.calls.map((call) => call.op), ['apply']);
      assert.deepEqual(h.waits, []);
      assert.deepEqual(h.resolutions, [envId]);
      const payload = h.calls[0].body[0];
      assert.equal(payload.policyValue, scope);
      assert.equal(payload.ToBeAdded.join(','), 'site-b');
      assert.equal(payload.ToBeRemoved.join(','), 'site-a');
    });
  }
}

test('initial context failure exits before any request', async () => {
  const h = harness([], { error: 'Run: pac auth create' });
  const result = await h.run();
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Failed to resolve governance context.*pac auth create/);
  assert.equal(result.stdout, '');
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.waits, []);
  assert.deepEqual(h.resolutions, [envId]);
});

const authFailures = [
  {
    name: '401', code: 2, guidance: /sign in again/,
    response: { ok: false, statusCode: 401, error: { code: 'Unauthorized', message: 'expired token' } },
  },
  {
    name: '403', code: 1, guidance: /admin role, delegated permissions, and access policies/,
    response: { ok: false, statusCode: 403, error: { code: 'Forbidden', message: 'missing permission' } },
  },
  {
    name: 'context error', code: 2, guidance: /sign-in required/,
    response: { ok: false, statusCode: 0, error: { code: 'ContextError', message: 'sign-in required' } },
  },
];

const stages = [
  { name: 'POST', before: [], operations: ['apply'], waits: [] },
  { name: 'recovery read', before: [networkError()], operations: ['apply', 'getEnv'], waits: [] },
  { name: 'first status poll', before: [ok()], operations: ['apply', 'getStatus'], waits: [] },
  {
    name: 'status poll after healthy polling', before: [ok(), ok('InProgress')],
    operations: ['apply', 'getStatus', 'getStatus'], waits: [30_000],
  },
  {
    name: 'final check after transient-error exhaustion',
    before: [ok(), ...Array.from({ length: 5 }, networkError)],
    operations: ['apply', ...Array(6).fill('getStatus')], waits: Array(4).fill(30_000),
  },
  {
    name: 'final check after timeout', before: [ok(), ok('InProgress')],
    operations: ['apply', 'getStatus', 'getStatus'], waits: [30_000],
    extraArgs: ['--timeoutMinutes', '0.5'],
  },
];

for (const failure of authFailures) {
  for (const stage of stages) {
    test(`${failure.name} at ${stage.name} exits immediately without recovery or stale success`, async () => {
      const h = harness([...stage.before, failure.response, ok()], undefined, stage.extraArgs);
      const result = await h.run();
      assert.equal(result.code, failure.code);
      assert.equal(result.stdout, '', 'failure must not emit an applied result');
      assert.match(result.stderr, failure.guidance);
      assert.ok(result.stderr.includes(failure.response.error.message), 'retain upstream error detail');
      assert.deepEqual(h.calls.map((call) => call.op), stage.operations);
      assert.deepEqual(h.waits, stage.waits);
      assert.deepEqual(h.resolutions, [envId]);
      assert.equal(h.calls.filter((call) => call.op === 'apply').length, 1, 'never replay the POST');
    });
  }
}
