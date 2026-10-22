const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

// Run the real REST helper/CLI with fake HTTPS and time so deadline tests
// never contact BAP, read credentials, or wait sixty seconds.
function harness() {
  const script = path.resolve(__dirname, '../../../skills/manage-governance/scripts/list-envs.js');
  const req = new EventEmitter();
  let onResponse;
  let main;
  let clock = 0;
  let timer;
  let stdout = '';
  let timerCleared = false;
  let destroyed = false;
  req.destroy = (error) => { destroyed = true; req.emit('error', error); };
  const sandbox = {
    module: { exports: {} },
    process: {
      argv: ['node', script], env: {},
      stdout: { write: (text) => { stdout += text; } },
    },
    setTimeout(callback, ms) {
      timer = { callback, deadline: clock + ms };
      return timer;
    },
    clearTimeout(handle) {
      assert.equal(handle, timer);
      timerCleared = true;
    },
    require(name) {
      if (name === 'https') return { get(url, options, callback) { onResponse = callback; return req; } };
      if (name === '../../../scripts/lib/power-platform-api') {
        return {
          parseCliArgs: () => ({}),
          runCli: (mod, callback) => { main = callback; },
          fail(message, code) { throw Object.assign(new Error(message), { exitCode: code }); },
        };
      }
      if (name === '../../../scripts/lib/validation-helpers') return { getAuthToken: () => 'test-token' };
      if (name === '../../../scripts/lib/pac-bap-shim') {
        return { listEnvsViaPac: () => { throw new Error('Unexpected PAC call'); } };
      }
      if (name === './governance-context') {
        return {
          resolveRing: () => 'TIP',
          getRing: () => ({ bapStrategy: 'rest', bapHost: 'https://example.invalid', bapResource: 'test' }),
        };
      }
      throw new Error(`Unexpected dependency: ${name}`);
    },
  };
  vm.runInNewContext(fs.readFileSync(script, 'utf8'), sandbox, { filename: script });
  return {
    fetch: () => sandbox.module.exports.fetchEnvsViaBapRest('https://example.invalid', 'test-token'),
    run: () => main(),
    advance(ms) {
      clock += ms;
      if (timer && !timerCleared && clock >= timer.deadline) timer.callback();
    },
    respond(statusCode = 200) {
      const res = new EventEmitter();
      res.statusCode = statusCode;
      onResponse(res);
      return res;
    },
    get destroyed() { return destroyed; },
    get timerCleared() { return timerCleared; },
    get stdout() { return stdout; },
    req,
  };
}

test('TIP environment request aborts at the 60-second total deadline', async () => {
  const h = harness();
  const pending = h.fetch();
  h.advance(59_999);
  assert.equal(h.destroyed, false);
  h.advance(1);
  await assert.rejects(pending, /timed out after 60 seconds/);
  assert.equal(h.destroyed, true);
  assert.equal(h.timerCleared, true);
});

test('TIP timeout still bounds a response body that keeps receiving data', async () => {
  const h = harness();
  const pending = h.fetch();
  const response = h.respond();
  response.emit('data', '{"value":[');
  h.advance(30_000);
  response.emit('data', ' ');
  h.advance(30_000);
  await assert.rejects(pending, /timed out after 60 seconds/);
  assert.equal(h.destroyed, true);
});

test('TIP environment request clears its deadline after success', async () => {
  const h = harness();
  const pending = h.fetch();
  const response = h.respond();
  response.emit('data', '{"value":[{"name":"test-environment"}]}');
  response.emit('end');
  assert.equal(JSON.stringify(await pending), '[{"name":"test-environment"}]');
  assert.equal(h.timerCleared, true);
  h.advance(60_000);
  assert.equal(h.destroyed, false);
});

test('TIP environment request clears its deadline after transport and body errors', async () => {
  for (const source of ['request', 'response']) {
    const h = harness();
    const pending = h.fetch();
    const emitter = source === 'request' ? h.req : h.respond();
    emitter.emit('error', new Error('connection reset'));
    await assert.rejects(pending, /connection reset/);
    assert.equal(h.timerCleared, true);
    h.advance(60_000);
    assert.equal(h.destroyed, false);
  }
});

test('TIP environment-list CLI reports timeout as a failure, not an empty inventory', async () => {
  const h = harness();
  const pending = h.run();
  h.advance(60_000);
  await assert.rejects(pending, (error) => {
    assert.equal(error.exitCode, 1);
    assert.match(error.message, /Failed to list environments \(TIP ring\).*timed out after 60 seconds/);
    return true;
  });
  assert.equal(h.stdout, '');
});

test('list-envs exposes no cache or TTL flags', () => {
  const script = path.resolve(
    __dirname,
    '../../../skills/manage-governance/scripts/list-envs.js'
  );
  const result = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /cacheFile|maxAgeHours|refresh|TTL/i);
  assert.match(result.stdout, /node list-envs\.js/);
});
