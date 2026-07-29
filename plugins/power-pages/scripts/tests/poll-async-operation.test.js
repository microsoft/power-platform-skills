'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const scriptPath = path.join(__dirname, '..', 'poll-async-operation.js');

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('poll-async-operation writes estimated progress when Dataverse omits progress', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poll-async-operation-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      statecode: 0,
      statuscode: 20,
      message: 'Import is still running',
    }));
  });
  t.after(() => server.close());
  const port = await listen(server);
  const statusFile = path.join(dir, 'status.json');

  const result = await runNode([
    scriptPath,
    '--asyncJobId', '00000000-0000-0000-0000-000000000000',
    '--envUrl', `http://127.0.0.1:${port}`,
    '--token', 'token',
    '--intervalMs', '1',
    '--maxAttempts', '1',
    '--statusFile', statusFile,
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(requests, 1);
  assert.equal(JSON.parse(result.stdout).status, 'Timeout');

  const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
  assert.equal(status.state, 'timeout');
  assert.equal(status.progressPercent, 95);
});
