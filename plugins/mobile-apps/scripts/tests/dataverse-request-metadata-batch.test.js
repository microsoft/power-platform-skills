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
const {
  createDataverseRequestExecutor,
  retryAfterDelayMs,
} = require('../dataverse-request');

test('Retry-After parsing falls back without removing the retry delay', () => {
  assert.equal(retryAfterDelayMs('7', 30000), 7000);
  assert.equal(retryAfterDelayMs('invalid', 30000), 30000);
  assert.equal(retryAfterDelayMs(undefined, 5000), 5000);
});

function makeTempDir(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dataverse-fake-az-'));
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

test('in-process request executor reuses one token across sequential metadata reads', async () => {
  let tokenCalls = 0;
  const requests = [];
  const request = createDataverseRequestExecutor({
    environmentUrl: 'https://example.crm.dynamics.com/',
    tenantId: 'tenant-1',
    getToken: async () => {
      tokenCalls += 1;
      return 'shared-token';
    },
    sendRequest: async (_envUrl, method, apiPath, _body, token) => {
      requests.push({ method, apiPath, token });
      return {
        statusCode: 200,
        body: JSON.stringify({ value: [] }),
        headers: {},
      };
    },
  });

  await request('GET', 'EntityDefinitions');
  await request('GET', "EntityDefinitions(LogicalName='contact')/Attributes");
  await request('GET', "EntityDefinitions(LogicalName='contact')/Keys");

  assert.equal(tokenCalls, 1);
  assert.equal(requests.length, 3);
  assert.deepEqual(new Set(requests.map((item) => item.token)), new Set(['shared-token']));
});

test('BATCH-METADATA reuses auth, preserves order, and stops on first failure', async (t) => {
  const tempDir = makeTempDir(t);
  const azLog = path.join(tempDir, 'az.log');

  const requests = [];
  let active = 0;
  let maxActive = 0;
  const server = http.createServer((req, res) => {
    active++;
    maxActive = Math.max(maxActive, active);
    requests.push(req.url);
    const finish = () => {
      active--;
      if (req.url.endsWith('/two')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'planned failure' } }));
        return;
      }
      res.writeHead(204);
      res.end();
    };
    setTimeout(finish, 25);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const envUrl = `http://127.0.0.1:${server.address().port}`;
  const operations = [
    { index: 10, method: 'POST', apiPath: 'one', body: { value: 1 } },
    { index: 20, method: 'POST', apiPath: 'two', body: { value: 2 } },
    { index: 30, method: 'POST', apiPath: 'three', body: { value: 3 } },
  ];
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      scriptPath,
      envUrl,
      'BATCH-METADATA',
      'test',
      '--operations',
      JSON.stringify(operations),
      '--tenant-id',
      'explicit-tenant',
    ],
    {
      env: fakeAzEnv({
        FAKE_AZ_LOG: azLog,
      }),
    },
  );

  const output = JSON.parse(stdout);
  assert.equal(output.status, 207);
  assert.deepEqual(
    output.data.map(({ index, status }) => ({ index, status })),
    [
      { index: 10, status: 204 },
      { index: 20, status: 400 },
    ],
  );
  assert.equal(requests.length, 2);
  assert.match(requests[0], /\/api\/data\/v9\.2\/one$/);
  assert.match(requests[1], /\/api\/data\/v9\.2\/two$/);
  assert.equal(maxActive, 1);

  const authCalls = fs.readFileSync(azLog, 'utf8').trim().split('\n');
  assert.equal(authCalls.length, 1);
  assert.match(authCalls[0], /--tenant explicit-tenant/);
});

test('BATCH-METADATA does not turn a post-throttle collision into success', async (t) => {
  makeTempDir(t);

  let requestCount = 0;
  const server = http.createServer((req, res) => {
    requestCount++;
    if (requestCount === 1) {
      res.writeHead(429, { 'Retry-After': '0' });
      res.end();
      return;
    }
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'object with same name already exists' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const envUrl = `http://127.0.0.1:${server.address().port}`;
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      scriptPath,
      envUrl,
      'BATCH-METADATA',
      'collision',
      '--operations',
      JSON.stringify([{ method: 'POST', apiPath: 'EntityDefinitions', body: { value: 1 } }]),
      '--tenant-id',
      'explicit-tenant',
    ],
    { env: fakeAzEnv() },
  );

  const output = JSON.parse(stdout);
  assert.equal(output.status, 207);
  assert.equal(output.data[0].status, 400);
  assert.equal(output.data[0].rateLimited, true);
  assert.equal(requestCount, 2);
});
