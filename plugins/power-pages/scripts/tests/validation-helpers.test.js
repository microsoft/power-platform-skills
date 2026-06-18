const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const http = require('http');
const childProcess = require('child_process');

const helpersPath = path.join(__dirname, '..', 'lib', 'validation-helpers.js');

test('getAuthToken calls az account get-access-token without --allow-no-subscriptions (only az login accepts that flag)', (t) => {
  const originalExecSync = childProcess.execSync;
  let capturedCommand = null;

  childProcess.execSync = (command, options) => {
    capturedCommand = command;
    const out = 'fake-token-value\n';
    return options && options.encoding ? out : Buffer.from(out);
  };
  delete require.cache[require.resolve(helpersPath)];

  t.after(() => {
    childProcess.execSync = originalExecSync;
    delete require.cache[require.resolve(helpersPath)];
  });

  const { getAuthToken } = require(helpersPath);
  const token = getAuthToken('https://example.crm.dynamics.com');

  assert.equal(token, 'fake-token-value');
  assert.match(capturedCommand, /^az account get-access-token /);
  assert.doesNotMatch(
    capturedCommand,
    /--allow-no-subscriptions/,
    'az account get-access-token rejects --allow-no-subscriptions on recent CLI versions; the helper must omit it.',
  );
  assert.match(capturedCommand, /--resource "https:\/\/example\.crm\.dynamics\.com"/);
});

// ---------------------------------------------------------------------------
// makeRequest socket-timeout knob (regression coverage for the 2026-06 bug
// where commit-to-git mis-classified slow-but-successful CommitToGit replies
// as { error: 'Request timed out' } because the helper's 15 s default fired
// before the server finished writing components to ADO).
// ---------------------------------------------------------------------------

function startSlowServer(delayMs) {
  const server = http.createServer((_req, res) => {
    setTimeout(() => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); }, delayMs);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}
function stopServer(s) {
  return new Promise((resolve) => s.server.close(resolve));
}

test('makeRequest: socketTimeoutMs fires when the server is slower than the configured ceiling', async () => {
  delete require.cache[require.resolve(helpersPath)];
  const { makeRequest } = require(helpersPath);
  const s = await startSlowServer(200);
  try {
    const r = await makeRequest({ url: `http://127.0.0.1:${s.port}/`, socketTimeoutMs: 50 });
    assert.equal(
      r.error, 'Request timed out',
      'A 200 ms server reply with socketTimeoutMs=50 must surface "Request timed out".',
    );
  } finally {
    await stopServer(s);
  }
});

test('makeRequest: socketTimeoutMs allows a slow-but-successful reply to land (regression for commit-to-git bug)', async () => {
  delete require.cache[require.resolve(helpersPath)];
  const { makeRequest } = require(helpersPath);
  const s = await startSlowServer(150);
  try {
    // Under the OLD code, a CommitToGit reply that took longer than 15 s
    // would surface { error: 'Request timed out' } even when the server was
    // about to return 200. Here we simulate the same shape on a 150 ms reply
    // with socketTimeoutMs=2000 — must succeed.
    const r = await makeRequest({ url: `http://127.0.0.1:${s.port}/`, socketTimeoutMs: 2000 });
    assert.equal(r.statusCode, 200, 'Slow-but-within-budget replies must reach the caller.');
    assert.equal(r.body, 'ok');
  } finally {
    await stopServer(s);
  }
});

test('makeRequest: timeout alias remains honored for back-compat (no breakage for any external caller still passing timeout)', async () => {
  delete require.cache[require.resolve(helpersPath)];
  const { makeRequest } = require(helpersPath);
  const s = await startSlowServer(200);
  try {
    const r = await makeRequest({ url: `http://127.0.0.1:${s.port}/`, timeout: 50 });
    assert.equal(
      r.error, 'Request timed out',
      'The deprecated `timeout` alias must still fire — removing it would silently break any caller that still passes it.',
    );
  } finally {
    await stopServer(s);
  }
});

test('makeRequest: socketTimeoutMs wins when both socketTimeoutMs and timeout are supplied', async () => {
  delete require.cache[require.resolve(helpersPath)];
  const { makeRequest } = require(helpersPath);
  const s = await startSlowServer(120);
  try {
    // timeout=30 would fire on a 120 ms reply; socketTimeoutMs=2000 should win → success.
    const r = await makeRequest({
      url: `http://127.0.0.1:${s.port}/`,
      timeout: 30,
      socketTimeoutMs: 2000,
    });
    assert.equal(
      r.statusCode, 200,
      'When both knobs are supplied, the canonical socketTimeoutMs must take precedence over the legacy timeout alias.',
    );
  } finally {
    await stopServer(s);
  }
});

test('makeRequest: LONG_RUNNING_GIT_ACTION_TIMEOUT_MS is exported and equals 15 min (matches the empirical CommitToGit ceiling)', () => {
  delete require.cache[require.resolve(helpersPath)];
  const { LONG_RUNNING_GIT_ACTION_TIMEOUT_MS } = require(helpersPath);
  assert.equal(
    LONG_RUNNING_GIT_ACTION_TIMEOUT_MS, 15 * 60 * 1000,
    'The long-running git action timeout must be 900_000 ms (15 min) — the empirical upper bound for CommitToGit on big solutions (references/inner-loop-empirical-findings.md §3).',
  );
});
