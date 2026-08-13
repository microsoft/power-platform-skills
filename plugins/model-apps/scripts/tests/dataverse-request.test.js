'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const scriptPath = path.join(__dirname, '..', 'dataverse-request.js');
const authPath = path.join(__dirname, '..', 'lib', 'dataverse-auth.js');
const tempDirs = [];

test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function mkdirTemp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dataverse-request-test-'));
  tempDirs.push(dir);
  return dir;
}

function runCli(args, { errorMessage = null } = {}) {
  const code = `
    const Module = require('node:module');
    const scriptPath = ${JSON.stringify(scriptPath)};
    const authPath = ${JSON.stringify(authPath)};
    const realAuth = require(authPath);
    const originalLoad = Module._load;
    Module._load = function(request, parent, isMain) {
      const resolved = Module._resolveFilename(request, parent, isMain);
      if (resolved === authPath) {
        return {
          parseArgs: realAuth.parseArgs,
          readJsonArg: realAuth.readJsonArg,
          dataverseRequest: async (envUrl, method, apiPath, body, opts) => {
            if (${JSON.stringify(errorMessage)} !== null) throw new Error(${JSON.stringify(errorMessage)});
            return { status: 207, data: { envUrl, method, apiPath, body, opts } };
          },
        };
      }
      return originalLoad.apply(this, arguments);
    };
    process.argv = [process.execPath, scriptPath, ...${JSON.stringify(args)}];
    require(scriptPath);
  `;
  return spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' });
}

test('missing required positional arguments exits 1 with usage before any request', () => {
  const res = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });

  assert.equal(res.status, 1);
  assert.match(res.stderr, /Usage: node dataverse-request\.js <envUrl> <method> <apiPath>/);
  assert.equal(res.stdout, '');
});

test('successful request uppercases the method, parses JSON body, and forwards headers plus timeout options', () => {
  const res = runCli([
    'https://org.crm.dynamics.com/',
    'post',
    'accounts',
    '--body',
    '{"name":"Contoso"}',
    '--include-headers',
    '--timeout',
    '1234',
  ]);

  assert.equal(res.status, 0, res.stderr);
  // CLI stdout is the machine contract consumed by shell callers:
  //   { "status": 207, "data": { "envUrl": "...", "method": "POST", "apiPath": "...", "body": {...}, "opts": {...} } }
  const out = JSON.parse(res.stdout);
  assert.equal(out.status, 207);
  assert.deepEqual(out.data, {
    envUrl: 'https://org.crm.dynamics.com/',
    method: 'POST',
    apiPath: 'accounts',
    body: { name: 'Contoso' },
    opts: { includeHeaders: true, timeout: 1234 },
  });
});

test('body can be read from an @file path and omitted include-headers stays false', () => {
  const dir = mkdirTemp();
  const bodyPath = path.join(dir, 'body.json');
  fs.writeFileSync(bodyPath, JSON.stringify({ subject: 'From file' }), 'utf8');

  const res = runCli(['https://org.crm.dynamics.com', 'PATCH', 'tasks(1)', '--body', '@' + bodyPath]);

  assert.equal(res.status, 0, res.stderr);
  // Same stdout envelope as above; this case proves @file input is parsed before the request call.
  const out = JSON.parse(res.stdout);
  assert.equal(out.data.method, 'PATCH');
  assert.deepEqual(out.data.body, { subject: 'From file' });
  assert.equal(out.data.opts.includeHeaders, false);
  assert.equal(Object.hasOwn(out.data.opts, 'timeout'), false);
});

test('--timeout without a value is rejected before the Dataverse request is invoked', () => {
  const res = runCli(['https://org.crm.dynamics.com', 'GET', 'accounts', '--timeout']);

  assert.equal(res.status, 1);
  assert.match(res.stderr, /--timeout must include a positive millisecond value/);
  assert.equal(res.stdout, '');
});

test('--timeout rejects zero and non-numeric values with the provided raw value', () => {
  const zero = runCli(['https://org.crm.dynamics.com', 'GET', 'accounts', '--timeout', '0']);
  const text = runCli(['https://org.crm.dynamics.com', 'GET', 'accounts', '--timeout', 'soon']);

  assert.equal(zero.status, 1);
  assert.match(zero.stderr, /--timeout must be a positive number \(got "0"\)/);
  assert.equal(text.status, 1);
  assert.match(text.stderr, /--timeout must be a positive number \(got "soon"\)/);
});

test('Dataverse request failures are written to stderr and exit 1', () => {
  const res = runCli(['https://org.crm.dynamics.com', 'GET', 'accounts'], { errorMessage: 'token unavailable' });

  assert.equal(res.status, 1);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /^token unavailable\r?\n$/);
});
