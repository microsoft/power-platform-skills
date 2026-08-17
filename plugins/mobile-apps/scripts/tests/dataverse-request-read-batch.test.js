const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const scriptPath = path.resolve(__dirname, '..', 'dataverse-request.js');
const fakeAzPreload = path.join(__dirname, 'helpers', 'fake-az-preload.js');

function makeTempDir(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dataverse-read-batch-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  return tempDir;
}

function fakeAzEnv(overrides = {}) {
  return {
    ...process.env,
    NODE_OPTIONS: `--require=${fakeAzPreload}`,
    FAKE_AZ_STATIC_TOKEN: 'test-token',
    ...overrides,
  };
}

async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('BATCH-READS reuses auth, preserves order, and caps concurrency', async (t) => {
  const tempDir = makeTempDir(t);
  const azLog = path.join(tempDir, 'az.log');
  let active = 0;
  let maxActive = 0;

  const envUrl = await listen(t, (req, res) => {
    active++;
    maxActive = Math.max(maxActive, active);
    const name = req.url.split('/').pop();
    const delay = name === 'slow' ? 60 : name === 'medium' ? 30 : 10;
    setTimeout(() => {
      active--;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ value: [name] }));
    }, delay);
  });

  const operations = [
    { index: 30, apiPath: 'slow' },
    { index: 10, apiPath: 'fast' },
    { index: 20, apiPath: 'medium' },
  ];
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      scriptPath,
      envUrl,
      'BATCH-READS',
      'test',
      '--operations',
      JSON.stringify(operations),
      '--concurrency',
      '2',
      '--tenant-id',
      'explicit-tenant',
    ],
    { env: fakeAzEnv({ FAKE_AZ_LOG: azLog }) },
  );

  const output = JSON.parse(stdout);
  assert.equal(output.status, 200);
  assert.deepEqual(
    output.data.map(({ index, status, data }) => ({ index, status, value: data.value[0] })),
    [
      { index: 30, status: 200, value: 'slow' },
      { index: 10, status: 200, value: 'fast' },
      { index: 20, status: 200, value: 'medium' },
    ],
  );
  assert.equal(maxActive, 2);

  const authCalls = fs.readFileSync(azLog, 'utf8').trim().split('\n');
  assert.equal(authCalls.length, 1);
  assert.match(authCalls[0], /--tenant explicit-tenant/);
});

test('BATCH-READS retries auth and throttling without hiding failures', async (t) => {
  const tempDir = makeTempDir(t);
  const azLog = path.join(tempDir, 'az.log');
  const attempts = new Map();

  const envUrl = await listen(t, (req, res) => {
    const name = req.url.split('/').pop();
    const count = (attempts.get(name) || 0) + 1;
    attempts.set(name, count);

    if (name === 'auth' && count === 1) {
      res.writeHead(401);
      res.end();
      return;
    }
    if (name === 'throttle' && count === 1) {
      res.writeHead(429, { 'Retry-After': '0' });
      res.end();
      return;
    }
    if (name === 'missing') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ value: [name] }));
  });

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      scriptPath,
      envUrl,
      'BATCH-READS',
      'retry',
      '--operations',
      JSON.stringify([
        { index: 1, apiPath: 'auth' },
        { index: 2, apiPath: 'throttle' },
        { index: 3, apiPath: 'missing' },
      ]),
      '--concurrency',
      '3',
      '--tenant-id',
      'explicit-tenant',
    ],
    { env: fakeAzEnv({ FAKE_AZ_LOG: azLog }) },
  );

  const output = JSON.parse(stdout);
  assert.equal(output.status, 207);
  assert.deepEqual(
    output.data.map(({ index, status, error }) => ({ index, status, error })),
    [
      { index: 1, status: 200, error: undefined },
      { index: 2, status: 200, error: undefined },
      { index: 3, status: 404, error: 'not found' },
    ],
  );
  assert.equal(attempts.get('auth'), 2);
  assert.equal(attempts.get('throttle'), 2);
  assert.equal(attempts.get('missing'), 1);

  const authCalls = fs.readFileSync(azLog, 'utf8').trim().split('\n');
  assert.equal(authCalls.length, 2);
});
