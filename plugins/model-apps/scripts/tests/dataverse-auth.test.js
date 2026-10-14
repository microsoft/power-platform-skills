'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { parseArgs, readJsonArg, label, requiredLevel } = require('../lib/dataverse-auth');

test('parseArgs: positional only', () => {
  const { positional, flags } = parseArgs(['a', 'b', 'c']);
  assert.deepEqual(positional, ['a', 'b', 'c']);
  assert.deepEqual(flags, {});
});

test('parseArgs: mix of positional and flags', () => {
  const { positional, flags } = parseArgs(['a', '--foo', 'bar', 'b', '--baz']);
  assert.deepEqual(positional, ['a', 'b']);
  assert.deepEqual(flags, { foo: 'bar', baz: true });
});

test('parseArgs: bool flag followed by another flag treats first as bool', () => {
  const { flags } = parseArgs(['--x', '--y', '1']);
  assert.deepEqual(flags, { x: true, y: '1' });
});

test('parseArgs: repeated flag overwrites', () => {
  const { flags } = parseArgs(['--foo', '1', '--foo', '2']);
  assert.equal(flags.foo, '2');
});

test('parseArgs: --key=value form', () => {
  const { positional, flags } = parseArgs(['x', '--foo=bar', '--baz=qux', 'y']);
  assert.deepEqual(positional, ['x', 'y']);
  assert.deepEqual(flags, { foo: 'bar', baz: 'qux' });
});

test('parseArgs: --key=value with empty value', () => {
  const { flags } = parseArgs(['--foo=']);
  assert.equal(flags.foo, '');
});

test('parseArgs: --key=value preserves additional = signs in value', () => {
  const { flags } = parseArgs(['--query=a=b=c']);
  assert.equal(flags.query, 'a=b=c');
});

test('parseArgs: mixed --key=value and --key value forms', () => {
  const { flags } = parseArgs(['--foo=bar', '--baz', 'qux']);
  assert.deepEqual(flags, { foo: 'bar', baz: 'qux' });
});

test('readJsonArg: inline JSON', () => {
  assert.deepEqual(readJsonArg('{"a":1}'), { a: 1 });
});

test('readJsonArg: file path with @ prefix', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const tmp = path.join(os.tmpdir(), `dv-auth-test-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ from: 'file' }));
  try {
    assert.deepEqual(readJsonArg('@' + tmp), { from: 'file' });
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('readJsonArg: null and undefined pass through', () => {
  assert.equal(readJsonArg(null), null);
  assert.equal(readJsonArg(undefined), null);
});

test('label: builds Dataverse verbose Label object', () => {
  const out = label('Hello');
  assert.equal(out['@odata.type'], 'Microsoft.Dynamics.CRM.Label');
  assert.equal(out.LocalizedLabels.length, 1);
  assert.equal(out.LocalizedLabels[0].Label, 'Hello');
  assert.equal(out.LocalizedLabels[0].LanguageCode, 1033);
});

test('label: respects custom language code', () => {
  const out = label('Bonjour', 1036);
  assert.equal(out.LocalizedLabels[0].LanguageCode, 1036);
});

test('requiredLevel: defaults to None and is mutable', () => {
  const out = requiredLevel();
  assert.equal(out.Value, 'None');
  assert.equal(out.CanBeChanged, true);
});

test('requiredLevel: respects argument', () => {
  assert.equal(requiredLevel('ApplicationRequired').Value, 'ApplicationRequired');
});

test('makeRequest preserves UTF-8 characters split across response chunks', async () => {
  const { makeRequest } = require('../lib/dataverse-auth.js');
  const body = JSON.stringify({ city: '東京', emoji: '😀', cafe: 'Café' });
  const bodyBytes = Buffer.from(body, 'utf8');
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (req.url === '/split') {
      for (let i = 0; i < bodyBytes.length; i += 1) {
        res.write(bodyBytes.subarray(i, i + 1));
      }
      res.end();
      return;
    }
    if (req.url === '/whole') {
      res.end(bodyBytes);
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const whole = await makeRequest({ url: `http://127.0.0.1:${port}/whole` });
    const split = await makeRequest({ url: `http://127.0.0.1:${port}/split` });
    assert.equal(whole.body, body);
    assert.equal(split.body, body);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('makeRequest settles with an error when the connection closes mid-response', async () => {
  const { makeRequest } = require('../lib/dataverse-auth.js');
  // Headers and part of the body arrive, then the socket closes: no 'end', and the socket timeout
  // cannot fire on a closed socket. The promise must still settle through the { error } contract.
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '100' });
    res.write('{"value":[');
    setTimeout(() => res.socket.destroy(), 20);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const settled = await Promise.race([
      makeRequest({ url: `http://127.0.0.1:${port}/cut`, timeout: 60000 }),
      new Promise((resolve) => setTimeout(() => resolve('still pending'), 2000)),
    ]);
    assert.notEqual(settled, 'still pending', 'a truncated response must not leave the request pending');
    assert.match(settled.error, /before (it|the response) completed/);
    assert.strictEqual(settled.incompleteResponse, true, 'the server answered before the body was cut off');
    assert.strictEqual(settled.statusCode, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('makeRequest marks a timeout after the headers arrived as an incomplete response', async () => {
  const { makeRequest } = require('../lib/dataverse-auth.js');
  // The server answers, sends part of the body, then stalls. The request timeout fires on the
  // request, not the response, but the answer had arrived: a POST may already have been applied.
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    res.writeHead(201, { 'Content-Type': 'application/json', 'Content-Length': '100' });
    res.write('{"id":');
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const answered = await makeRequest({ url: `http://127.0.0.1:${port}/stall`, method: 'POST', body: '{}', timeout: 150 });
    assert.strictEqual(answered.incompleteResponse, true);
    assert.strictEqual(answered.statusCode, 201);
    assert.match(answered.error, /timed out before the response completed/);
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('makeRequest keeps a timeout with no answer as a plain request failure', async () => {
  const { makeRequest } = require('../lib/dataverse-auth.js');
  const sockets = new Set();
  const server = http.createServer(() => { /* never answers */ });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const silent = await makeRequest({ url: `http://127.0.0.1:${port}/silent`, method: 'POST', body: '{}', timeout: 150 });
    assert.deepStrictEqual(silent, { error: 'Request timed out' });
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('dataverseRequest does not replay a POST whose response was cut off, but retries a GET', async () => {
  const { dataverseRequest } = require('../lib/dataverse-auth.js');
  const cut = (statusCode) => ({ error: 'Connection closed before the response completed', incompleteResponse: true, statusCode });
  let posts = 0;
  await assert.rejects(
    dataverseRequest('https://contoso.crm.dynamics.com', 'POST', 'accounts', { name: 'A' }, {
      getToken: () => 'TOK', request: async () => { posts += 1; return cut(201); },
    }),
    /already answered 201, so this POST may have been applied; it was not re-sent/,
  );
  assert.strictEqual(posts, 1);
  let gets = 0;
  const res = await dataverseRequest('https://contoso.crm.dynamics.com', 'GET', 'accounts', null, {
    getToken: () => 'TOK',
    request: async () => { gets += 1; return gets === 1 ? cut(200) : { statusCode: 200, body: '{"value":[]}' }; },
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(gets, 2);
});

test('getAuthToken reuses a non-empty token per normalized resource URL', () => {
  const { getAuthToken } = require('../lib/dataverse-auth.js');
  const calls = [];
  const exec = (_file, args) => {
    calls.push(args[args.indexOf('--resource') + 1]);
    return 'TOK\n';
  };
  const oldPath = process.env.PATH;
  process.env.PATH = '';
  try {
    assert.equal(getAuthToken('https://contoso.crm.dynamics.com/', { exec, fresh: true }), 'TOK');
    assert.equal(getAuthToken('https://contoso.crm.dynamics.com', { exec }), 'TOK');
    assert.equal(getAuthToken('https://fabrikam.crm.dynamics.com', { exec, fresh: true }), 'TOK');
  } finally {
    process.env.PATH = oldPath;
  }
  assert.deepEqual(calls, ['https://contoso.crm.dynamics.com', 'https://fabrikam.crm.dynamics.com']);
});

test('a fresh acquire bypasses the memo and replaces the token it holds', () => {
  const { getAuthToken } = require('../lib/dataverse-auth.js');
  const tokens = ['OLD\n', 'NEW\n'];
  let calls = 0;
  const exec = () => tokens[Math.min(calls++, tokens.length - 1)];
  const url = 'https://fabrikam.crm4.dynamics.com';
  const oldPath = process.env.PATH;
  process.env.PATH = '';
  try {
    assert.equal(getAuthToken(url, { exec, fresh: true }), 'OLD');
    assert.equal(getAuthToken(url, { exec }), 'OLD', 'an ordinary repeat is served from the memo');
    // A 401 refresh must not be handed the token the server just rejected.
    assert.equal(getAuthToken(url, { exec, fresh: true }), 'NEW');
    assert.equal(getAuthToken(url, { exec }), 'NEW', 'the refreshed token replaces the memoized one');
  } finally {
    process.env.PATH = oldPath;
  }
  assert.equal(calls, 2);
});
test('getAuthToken does not cache a null token result', () => {
  const { getAuthToken } = require('../lib/dataverse-auth.js');
  let calls = 0;
  const exec = () => {
    calls += 1;
    if (calls === 1) return '\n';
    return 'TOK\n';
  };
  const oldPath = process.env.PATH;
  process.env.PATH = '';
  try {
    assert.equal(getAuthToken('https://example.crm.dynamics.com', { exec, fresh: true }), null);
    assert.equal(getAuthToken('https://example.crm.dynamics.com', { exec }), 'TOK');
  } finally {
    process.env.PATH = oldPath;
  }
  assert.equal(calls, 2);
});

test('getAuthTokenAsync is served from a memo that getAuthToken filled', async () => {
  // The other direction of sharing: check-auth warms the memo asynchronously, but a synchronous caller
  // may have filled it first, and the async path must then not start the CLI again.
  const { getAuthToken, getAuthTokenAsync } = require('../lib/dataverse-auth.js');
  let asyncCalls = 0;
  const exec = () => 'SYNC\n';
  const execFile = (_file, _args, _opts, cb) => { asyncCalls += 1; setImmediate(() => cb(null, 'ASYNC\n')); };
  const url = 'https://fabrikam.crm5.dynamics.com';
  const oldPath = process.env.PATH;
  process.env.PATH = '';
  try {
    assert.equal(getAuthToken(url, { exec, fresh: true }), 'SYNC');
    assert.equal(await getAuthTokenAsync(url, { execFile }), 'SYNC');
  } finally {
    process.env.PATH = oldPath;
  }
  assert.equal(asyncCalls, 0);
});
test('getAuthTokenAsync shares the token memo with getAuthToken and honors fresh replacement', async () => {
  const { getAuthToken, getAuthTokenAsync } = require('../lib/dataverse-auth.js');
  const calls = [];
  const exec = (_file, args) => {
    calls.push(`sync:${args[args.indexOf('--resource') + 1]}`);
    return 'SYNC\n';
  };
  const execFile = (_file, args, _opts, cb) => {
    calls.push(`async:${args[args.indexOf('--resource') + 1]}`);
    setImmediate(() => cb(null, calls.length === 1 ? 'ASYNC\n' : 'FRESH\n'));
  };
  const oldPath = process.env.PATH;
  process.env.PATH = '';
  try {
    assert.equal(await getAuthTokenAsync('https://contoso.crm.dynamics.com/', { execFile, fresh: true }), 'ASYNC');
    assert.equal(getAuthToken('https://contoso.crm.dynamics.com', { exec }), 'ASYNC');
    assert.equal(await getAuthTokenAsync('https://contoso.crm.dynamics.com', { execFile, fresh: true }), 'FRESH');
    assert.equal(getAuthToken('https://contoso.crm.dynamics.com', { exec }), 'FRESH');
  } finally {
    process.env.PATH = oldPath;
  }
  assert.deepEqual(calls, [
    'async:https://contoso.crm.dynamics.com',
    'async:https://contoso.crm.dynamics.com',
  ]);
});

test('cancelling a getAuthTokenAsync read ends the child\'s whole process tree, not just the wrapper Node starts, and is not a remembered failure', async () => {
  // check-auth starts this read beside `az account show`; when the account verdict ends the run, the token child is
  // cancelled. On Windows `az` is a batch shim under cmd.exe, so Node's own abort would end only that wrapper and leave az's
  // Python process running after this one exits — the abort is handled here, through killProcessTree, and the signal is not
  // handed to the child's start. The cancellation must also not be recorded as the Azure CLI failing: a later reader of
  // tokenFailureKind would be told the CLI "failed" when it was simply told to stop.
  const { getAuthTokenAsync, tokenFailureKind } = require('../lib/dataverse-auth.js');
  const url = 'https://contoso-abort.crm.dynamics.com';
  const controller = new AbortController();
  const child = { pid: 4242 };
  const killed = [];
  let seen;
  let finish;
  const execFile = (_file, _args, options, cb) => { seen = options; finish = cb; return child; };
  const pending = getAuthTokenAsync(url, { execFile, signal: controller.signal, killTree: (c) => killed.push(c) });
  assert.ok(!('signal' in seen), 'the signal is not handed to Node, whose own kill would reach only the cmd.exe wrapper');
  assert.deepEqual(killed, [], 'nothing is ended before the abort');
  controller.abort();
  assert.deepEqual(killed, [child], 'the abort ends the child\'s process tree');
  finish(Object.assign(new Error('Command failed'), { code: 1 }), '', '');
  assert.equal(await pending, null);
  assert.equal(tokenFailureKind(url), null, 'a cancelled read leaves no failure behind');
});

test('a getAuthTokenAsync read that already finished is not ended by a later abort, and one cancelled before it starts runs nothing', async () => {
  const { getAuthTokenAsync } = require('../lib/dataverse-auth.js');
  const controller = new AbortController();
  const killed = [];
  const execFile = (_file, _args, _options, cb) => { setImmediate(() => cb(null, 'TOKEN\n', '')); return { pid: 7 }; };
  assert.equal(await getAuthTokenAsync('https://contoso-finished.crm.dynamics.com', { execFile, signal: controller.signal, killTree: (c) => killed.push(c) }), 'TOKEN');
  controller.abort();
  assert.deepEqual(killed, [], 'the child had finished: there is nothing to end');
  let started = 0;
  const cancelled = new AbortController();
  cancelled.abort();
  assert.equal(await getAuthTokenAsync('https://contoso-never.crm.dynamics.com', { execFile: () => { started += 1; return {}; }, signal: cancelled.signal }), null);
  assert.equal(started, 0, 'no process is started for a read that was already cancelled');
});

test('without a signal getAuthTokenAsync starts the CLI with exactly the options it always did, and a real failure is still remembered', async () => {
  const { getAuthTokenAsync, tokenFailureKind } = require('../lib/dataverse-auth.js');
  const url = 'https://contoso-plain.crm.dynamics.com';
  let seen;
  const execFile = (_file, _args, options, cb) => { seen = options; setImmediate(() => cb(Object.assign(new Error('boom'), { killed: true, signal: 'SIGTERM' }), '', '')); return {}; };
  assert.equal(await getAuthTokenAsync(url, { execFile }), null);
  assert.deepEqual(Object.keys(seen).sort(), ['encoding', 'timeout', 'windowsHide'], 'no `signal` key unless the caller supplied one');
  assert.equal(tokenFailureKind(url), 'timeout');
});

test('dataverseRequest hands a 401 back without refreshing the token when refreshOn401 is false — the refresh is a synchronous CLI read', async () => {
  const { dataverseRequest } = require('../lib/dataverse-auth.js');
  const run = async (options) => {
    const tokenCalls = [];
    let sends = 0;
    const res = await dataverseRequest('https://contoso.crm.dynamics.com', 'GET', 'WhoAmI', null, {
      getToken: (_url, o) => { tokenCalls.push(Boolean(o && o.fresh)); return 'TOK'; },
      request: async () => { sends += 1; return { statusCode: 401, body: '' }; },
      ...options,
    });
    return { res, tokenCalls, sends };
  };
  const refreshing = await run({});
  assert.deepEqual(refreshing.tokenCalls, [false, true, true], 'by default each 401 is followed by a fresh token read, twice');
  assert.equal(refreshing.sends, 3);
  const handedBack = await run({ refreshOn401: false });
  assert.equal(handedBack.res.status, 401);
  assert.deepEqual(handedBack.tokenCalls, [false], 'only the memoized token was used: no synchronous read');
  assert.equal(handedBack.sends, 1, 'and the 401 was not sent again');
});

test('emitResult: partial-failure object writes JSON to stdout (not [object Object])', () => {
  // Spawn a tiny script that calls emitResult(false, {errors:[...]}) and
  // verify that stdout contains the JSON payload — not the literal string
  // "[object Object]". Regression guard for the bulk-insert failure path.
  const { spawnSync } = require('node:child_process');
  const path = require('node:path');
  const libPath = path.join(__dirname, '..', 'lib', 'dataverse-auth.js');
  const code = `
    const { emitResult } = require(${JSON.stringify(libPath)});
    emitResult(false, { ok: false, count: 0, ids: [], errors: [{ index: 0, status: 400, message: 'bad row' }] });
  `;
  const res = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' });
  assert.equal(res.status, 1, 'expected exit 1');
  assert.doesNotMatch(res.stdout, /\[object Object\]/, 'stdout must not be [object Object]');
  const parsed = JSON.parse(res.stdout.trim());
  assert.equal(parsed.ok, false);
  assert.equal(parsed.errors.length, 1);
  assert.equal(parsed.errors[0].index, 0);
  assert.equal(parsed.errors[0].status, 400);
  assert.equal(parsed.errors[0].message, 'bad row');
  assert.match(res.stderr, /Operation completed with 1 error/);
});

// --- AB#6686427: auth preflight — az tenant divergence from the selected PAC environment ---------
//
// The skill flow validates and selects a PAC profile, but every script authenticates through the
// INDEPENDENTLY active Azure CLI account. In a normal multi-tenant workflow `pac auth` and
// `az login` legitimately point at different tenants, and the result is an HTTP 401 that reads as a
// Dataverse permission problem — so the user troubleshoots roles and PAC profiles while the actual
// cause is the ambient az context. Worse, download's best-effort catches turn that 401 into a
// silently EMPTY spec (AB#6686423), so the failure does not even surface as an error.
//
// The preflight names the identity that will actually supply the token, before any real work.

const { preflightAuth } = require('../lib/dataverse-auth.js');

test('AB#6686427: preflight passes and reports the identity when WhoAmI succeeds', async () => {
  const r = await preflightAuth('https://contoso.crm.dynamics.com', {
    getToken: () => 'token',
    request: async () => ({ status: 200, data: { UserId: '00000000-0000-0000-0000-000000000001' } }),
    azIdentity: () => ({ user: 'maker@contoso.com', tenantId: 'aaaaaaaa-0000-0000-0000-000000000000' }),
  });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.match(r.identity.user, /maker@contoso\.com/);
});

test('preflight: identityOnSuccess:false skips the identity read on success but keeps it for a 401', async () => {
  let reads = 0;
  const azIdentity = () => { reads += 1; return { user: 'maker@contoso.com', tenantId: 'aaaaaaaa-0000-0000-0000-000000000000' }; };
  const ok = await preflightAuth('https://contoso.crm.dynamics.com', {
    getToken: () => 'token',
    request: async () => ({ status: 200, data: { UserId: '00000000-0000-0000-0000-000000000001' } }),
    azIdentity,
    identityOnSuccess: false,
  });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.userId, '00000000-0000-0000-0000-000000000001');
  assert.strictEqual('identity' in ok, false, 'no identity on a verdict-only success');
  assert.strictEqual(reads, 0, 'no `az account show` for a value nobody reads');
  const denied = await preflightAuth('https://contoso.crm.dynamics.com', {
    getToken: () => 'token',
    request: async () => ({ status: 401, headers: {} }),
    azIdentity,
    identityOnSuccess: false,
  });
  assert.strictEqual(denied.ok, false);
  assert.strictEqual(reads, 1, 'a 401 still names the identity it rejected');
  assert.match(denied.error, /maker@contoso\.com/);
});

test('dataverseRequest USES a preset token and skips the CLI entirely', async () => {
  // The receiving half of the preflight optimisation. Passing the token is pointless if this side
  // fetches its own anyway, and that is invisible from the caller.
  const { dataverseRequest } = require('../lib/dataverse-auth.js');
  let cliCalls = 0;
  let sentAuth;
  const res = await dataverseRequest('https://contoso.crm.dynamics.com', 'GET', 'WhoAmI', null, {
    token: 'tok-abc',
    getToken: () => { cliCalls += 1; return 'tok-from-cli'; },
    request: async ({ headers }) => { sentAuth = headers.Authorization; return { statusCode: 200, body: '{}' }; },
  });
  assert.strictEqual(cliCalls, 0, 'a preset token must skip `az account get-access-token` altogether');
  assert.strictEqual(sentAuth, 'Bearer tok-abc');
  assert.strictEqual(res.status, 200);

  // Counterfactual: with no preset token it still acquires one, or the seam would have broken the
  // normal path while looking green.
  cliCalls = 0;
  await dataverseRequest('https://contoso.crm.dynamics.com', 'GET', 'WhoAmI', null, {
    getToken: () => { cliCalls += 1; return 'tok-from-cli'; },
    request: async ({ headers }) => { sentAuth = headers.Authorization; return { statusCode: 200, body: '{}' }; },
  });
  assert.strictEqual(cliCalls, 1);
  assert.strictEqual(sentAuth, 'Bearer tok-from-cli');
});


test('dataverseRequest bypasses the token memo after a 401 before retrying', async () => {
  const { dataverseRequest } = require('../lib/dataverse-auth.js');
  const tokenCalls = [];
  const sent = [];
  const res = await dataverseRequest('https://contoso.crm.dynamics.com', 'GET', 'WhoAmI', null, {
    getToken: (_url, options) => {
      tokenCalls.push(Boolean(options && options.fresh));
      return tokenCalls.length === 1 ? 'OLD' : 'NEW';
    },
    request: async ({ headers }) => {
      sent.push(headers.Authorization);
      return sent.length === 1
        ? { statusCode: 401, body: '' }
        : { statusCode: 200, body: '{"ok":true}' };
    },
  });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(tokenCalls, [false, true]);
  assert.deepStrictEqual(sent, ['Bearer OLD', 'Bearer NEW']);
});

test('a path-bearing or query-bearing env is refused, not silently trimmed to its origin', async () => {
  // `dataverseRequest` appends `/api/data/...` to whatever it is given, so a trimmed
  // `https://org.crm.dynamics.com/some/path` would probe `.../some/path/api/data/...` and report a
  // result about a URL nobody asked for. This function decides where a bearer token may be sent, so
  // "close enough" is the wrong disposition.
  for (const bad of [
    'https://contoso.crm.dynamics.com/some/path',
    'https://contoso.crm.dynamics.com/?q=1',
    'https://contoso.crm.dynamics.com/#frag',
  ]) {
    let tokenAsked = 0;
    let requested = 0;
    const r = await preflightAuth(bad, {
      getToken: () => { tokenAsked += 1; return 'token'; },
      request: async () => { requested += 1; return { status: 200, data: {} }; },
      azIdentity: () => ({ user: 'maker@contoso.com', tenantId: 't' }),
    });
    assert.strictEqual(r.ok, false, `${bad} must be refused: ${JSON.stringify(r)}`);
    assert.match(r.error, /ORIGIN/, r.error);
    assert.strictEqual(tokenAsked, 0, `${bad}: no token may be acquired for a rejected target`);
    assert.strictEqual(requested, 0, `${bad}: and nothing may be sent`);
  }
  // Counterfactual: a bare origin, and an origin with only a trailing slash, are both fine.
  for (const good of ['https://contoso.crm.dynamics.com', 'https://contoso.crm.dynamics.com/']) {
    const r = await preflightAuth(good, {
      getToken: () => 'token',
      request: async () => ({ status: 200, data: { UserId: 'u' } }),
      azIdentity: () => ({ user: 'maker@contoso.com', tenantId: 't' }),
    });
    assert.strictEqual(r.ok, true, `${good} must be accepted: ${JSON.stringify(r)}`);
  }
});

// --- emitResult: a single explained failure must not be dressed as a partial one -----------------
test('both CLIs report an auth-preflight failure with the SAME payload shape', () => {
  // `emitResult` reserves `errors: [...]` for a genuine PARTIAL failure and summarises it as a COUNT.
  // `build-model-app.js` wrapped its single preflight message in that array while
  // `download-model-app.js` passed it as `error`, so the two sibling CLIs printed different things
  // for the identical failure — and the one users hit on an apply printed the count, replacing a
  // message written specifically to say which identity to sign in as.
  //
  // Asserted on the SOURCE because the alternative is spawning both CLIs against a live tenant.
  const fs = require('node:fs');
  const path = require('node:path');
  for (const cli of ['build-model-app.js', 'download-model-app.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', cli), 'utf8');
    const line = src.split('\n').find((l) => /emitResult\(false,.*auth\.error/.test(l));
    assert.ok(line, `${cli}: expected an emitResult call carrying auth.error`);
    assert.match(line, /error:\s*auth\.error/, `${cli}: a single explained failure must use \`error\`: ${line.trim()}`);
    assert.doesNotMatch(line, /errors:\s*\[/, `${cli}: \`errors: [...]\` is for PARTIAL failures and prints only a count: ${line.trim()}`);
  }
});

test('emitResult prints a single error message instead of "unknown error(s)"', () => {
  // The auth preflight, the app-id resolver and friends all fail with { ok:false, error:"<what to
  // do>" } and no `errors` array. The old branch printed "Operation completed with unknown error(s)"
  // for every one of them — burying a message written specifically to tell the operator what to do,
  // under boilerplate that is also untrue: nothing completed, and it is not unknown.
  const { emitResult } = require('../lib/dataverse-auth.js');
  const run = (payload) => {
    const out = [];
    const err = [];
    const so = process.stdout.write;
    const se = process.stderr.write;
    const ex = process.exit;
    process.stdout.write = (s) => { out.push(String(s)); return true; };
    process.stderr.write = (s) => { err.push(String(s)); return true; };
    // `emitResult` ends the process by contract, so the exit is turned into a throw and swallowed.
    process.exit = () => { throw new Error('__exit__'); };
    try { emitResult(false, payload); } catch (e) { if (e.message !== '__exit__') throw e; } finally {
      process.stdout.write = so; process.stderr.write = se; process.exit = ex;
    }
    return { out: out.join(''), err: err.join('') };
  };

  const single = run({ ok: false, error: 'no Azure CLI access token could be obtained; run az login' });
  assert.match(single.err, /run az login/, 'the actionable message must reach stderr');
  assert.doesNotMatch(single.err, /unknown error/, 'and must not be replaced by boilerplate');
  assert.match(single.out, /"ok":false/, 'the structured payload still goes to stdout for callers');

  // The genuine PARTIAL-failure contract is unchanged: a count, with the detail on stdout.
  const partial = run({ ok: false, errors: [{ row: 1 }, { row: 2 }] });
  assert.match(partial.err, /completed with 2 error\(s\)/, partial.err);

  // Neither shape: say so honestly rather than claiming a count we do not have.
  const opaque = run({ ok: false });
  assert.match(opaque.err, /unstructured error/, opaque.err);
  assert.doesNotMatch(opaque.err, /completed with/, 'nothing completed');
});

test('AB#6686427: the preflight HANDS its token to the request instead of fetching a second one', async () => {
  // `preflightAuth` deliberately acquires a token itself so it can tell "not signed in" apart from
  // "signed in but rejected" — two different diagnoses with two different fixes. Without passing it
  // on, `dataverseRequest` shells out to `az account get-access-token` again for the same origin,
  // and that call cold-starts the Azure CLI's Python runtime: seconds, on a path a user waits on.
  let tokenCalls = 0;
  let sawToken;
  const r = await preflightAuth('https://contoso.crm.dynamics.com', {
    getToken: () => { tokenCalls += 1; return 'tok-abc'; },
    request: async (_url, _m, _p, _b, opts) => { sawToken = opts && opts.token; return { status: 200, data: { UserId: 'u' } }; },
    azIdentity: () => ({ user: 'maker@contoso.com', tenantId: 'aaaaaaaa-0000-0000-0000-000000000000' }),
  });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(tokenCalls, 1, 'exactly one token acquisition');
  assert.strictEqual(sawToken, 'tok-abc', 'and the SAME token must reach the request');
});

test('AB#6686427: a 401 names the ACTIVE az identity, the target org, and the remediation', async () => {
  const r = await preflightAuth('https://contoso.crm.dynamics.com', {
    getToken: () => 'token',
    request: async () => ({ status: 401, data: {} }),
    azIdentity: () => ({ user: 'other@fabrikam.onmicrosoft.com', tenantId: 'bbbbbbbb-0000-0000-0000-000000000000' }),
  });
  assert.strictEqual(r.ok, false);
  // Naming only the status repeats the failure the user already saw; the point is to name the CAUSE.
  assert.match(r.error, /other@fabrikam\.onmicrosoft\.com/, 'must name the active az identity');
  assert.match(r.error, /bbbbbbbb-0000-0000-0000-000000000000/, 'must name the tenant supplying the token');
  assert.match(r.error, /contoso\.crm\.dynamics\.com/, 'must name the target org');
  assert.match(r.error, /az login/, 'must name the remediation');
});

test('AB#6686427: no token at all is reported as a sign-in problem, not a permission one', async () => {
  const r = await preflightAuth('https://contoso.crm.dynamics.com', {
    getToken: () => null,
    request: async () => { throw new Error('should not be called'); },
    azIdentity: () => null,
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /az login/);
  // Assert the CLAIM, not the vocabulary: the message may legitimately use the word "permissions"
  // to rule it OUT, which an over-crude /permission/ ban would fail. What must not happen is the
  // failure being ATTRIBUTED to privileges, sending the user to security roles.
  assert.match(r.error, /sign-in problem/, 'must name the real cause');
  assert.doesNotMatch(r.error, /insufficient|lacks? (the )?privilege|missing privilege|security role/i,
    'must not attribute a missing token to privileges');
});

test('AB#6686427: the preflight is a diagnostic and never throws', async () => {
  for (const opts of [
    { getToken: () => { throw new Error('az exploded'); }, request: async () => ({ status: 200, data: {} }), azIdentity: () => null },
    { getToken: () => 't', request: async () => { throw new Error('socket hang up'); }, azIdentity: () => null },
    { getToken: () => 't', request: async () => ({ status: 200, data: {} }), azIdentity: () => { throw new Error('az show failed'); } },
  ]) {
    let r;
    await assert.doesNotReject(async () => { r = await preflightAuth('https://contoso.crm.dynamics.com', opts); });
    assert.ok(typeof r.ok === 'boolean', 'always returns a structured verdict');
  }
});

test('AB#6686427: a non-401 failure is INCONCLUSIVE, not a block and not a tenant mismatch', async () => {
  // A 403 is a real privilege problem and a 500 is the service; blaming the az tenant for either
  // would send the user down exactly the wrong path — the mirror of the bug being fixed.
  //
  // They must also NOT BLOCK. This probe goes through `dataverseRequest`, which retries fewer
  // statuses and fewer times than the `createAzHttpClient` the real download uses (that one also
  // retries 504). A transient 5xx the download would have ridden out must not be turned into a hard
  // failure by a diagnostic sitting in front of it. Found in review.
  for (const status of [403, 429, 500, 504]) {
    const r = await preflightAuth('https://contoso.crm.dynamics.com', {
      getToken: () => 'token',
      request: async () => ({ status, data: { error: { message: 'upstream detail' } } }),
      azIdentity: () => ({ user: 'maker@contoso.com', tenantId: 'aaaa' }),
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.inconclusive, true, `${status} must be inconclusive, never blocking`);
    assert.doesNotMatch(r.error, /az login --tenant/, `${status} must not be blamed on the az tenant`);
    assert.match(r.error, /upstream detail/, 'the server message explains a 403 and must survive');
  }
});

test('AB#6686427: a non-HTTPS or malformed env is refused BEFORE any token is acquired', async () => {
  // The preflight runs ahead of createAzHttpClient's credential boundary and goes through
  // dataverseRequest, whose transport falls back to plain `http` for a non-HTTPS scheme. Without
  // this gate a malformed --env could put a bearer token on the wire in clear text. Found in review.
  for (const bad of ['http://contoso.crm.dynamics.com', 'not-a-url', 'ftp://x/y', '']) {
    let tokenAsked = 0;
    const r = await preflightAuth(bad, {
      getToken: () => { tokenAsked++; return 'token'; },
      request: async () => { throw new Error('must not reach the wire'); },
      azIdentity: () => null,
    });
    assert.strictEqual(r.ok, false, `${bad} must be refused`);
    assert.strictEqual(r.inconclusive, undefined, 'a bad target is definitive, not inconclusive');
    assert.strictEqual(tokenAsked, 0, `no token may be acquired for ${bad}`);
    assert.match(r.error, /https/i);
  }
});

test('AB#6686427: a CLAIMS CHALLENGE 401 is not blamed on the tenant', async () => {
  // Conditional Access / CAE answer 401 with `WWW-Authenticate: ... error="insufficient_claims"`,
  // and `az login --tenant` does not fix it. Asserting tenant divergence as a certainty would be the
  // same misattribution this bug is about, pointed somewhere new. Found in review.
  const r = await preflightAuth('https://contoso.crm.dynamics.com', {
    getToken: () => 'token',
    request: async () => ({ status: 401, data: null, headers: { 'www-authenticate': 'Bearer error="insufficient_claims", claims="eyJ..."' } }),
    azIdentity: () => ({ user: 'maker@contoso.com', tenantId: 'aaaa' }),
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /claims/i);
  assert.doesNotMatch(r.error, /az login --tenant/, 'a claims challenge is not a tenant problem');
});

test('AB#6686427: the happy path does not shell out to az for an identity nobody asked for', async () => {
  // The caller only reads `auth.ok`; paying for an `az account show` subprocess on every successful
  // run is pure cost. Found in review.
  let idReads = 0;
  const r = await preflightAuth('https://contoso.crm.dynamics.com', {
    getToken: () => 'token',
    request: async () => ({ status: 200, data: { UserId: 'u' } }),
    azIdentity: () => { idReads++; return { user: 'maker@contoso.com', tenantId: 'aaaa' }; },
  });
  assert.strictEqual(r.ok, true);
  assert.ok(idReads <= 1, `identity read at most once on success, got ${idReads}`);
});

// --- AB#6686424: a terminal 401 must explain itself ----------------------------------------------
//
// Both auth paths already retry a 401 once (dataverse-auth's loop, and sdk-http-client.js:130). The
// retry is not the gap: MEASURED, `az account get-access-token` serves from the MSAL cache, so an
// immediate re-call returns a byte-identical token (same sha256). A retry therefore cannot fix a
// token that is rejected for WHO it belongs to — only one that expired in a very narrow window.
//
// The reporter's own workaround was "refresh Azure CLI login and retry" — an `az login`, which is
// AB#6686427's cause. So what a surviving 401 needs is not another attempt, it is to say whose
// token was refused, so the reader stops looking at Dataverse roles.

test('AB#6686424: a terminal 401 names the identity whose token was refused', () => {
  const { ensureOk } = require('../lib/dataverse-auth.js');
  assert.throws(
    () => ensureOk({ status: 401, data: { error: { message: 'Unauthorized' } } }, 'read EntityDefinitions',
      { azIdentity: () => ({ user: 'other@fabrikam.onmicrosoft.com', tenantId: 'bbbb-tenant' }) }),
    (e) => {
      assert.match(e.message, /other@fabrikam\.onmicrosoft\.com/, 'names the account');
      assert.match(e.message, /bbbb-tenant/, 'names the tenant');
      assert.match(e.message, /az login/, 'names the remediation');
      return true;
    }
  );
});

test('AB#6686424: a NON-401 error is left exactly as it was', () => {
  // A 403 is a real privilege problem and a 400 is a bad request; attaching identity advice to
  // either would send the reader to `az login` for something az cannot fix.
  const { ensureOk } = require('../lib/dataverse-auth.js');
  for (const status of [400, 403, 404, 500]) {
    assert.throws(
      () => ensureOk({ status, data: { error: { message: 'boom' } } }, 'ctx', { azIdentity: () => ({ user: 'x', tenantId: 'y' }) }),
      (e) => {
        assert.doesNotMatch(e.message, /az login/, `${status} must not be blamed on the az identity`);
        assert.match(e.message, /boom/);
        return true;
      }
    );
  }
});

test('AB#6686424: an unreadable identity still produces a useful 401, never a crash', () => {
  const { ensureOk } = require('../lib/dataverse-auth.js');
  assert.throws(
    () => ensureOk({ status: 401, data: {} }, 'ctx', { azIdentity: () => { throw new Error('az gone'); } }),
    (e) => {
      assert.match(e.message, /401/);
      assert.match(e.message, /az login/);
      return true;
    }
  );
});

test('AB#6686424: a 2xx is returned untouched (no identity read on the happy path)', () => {
  const { ensureOk } = require('../lib/dataverse-auth.js');
  let called = 0;
  const res = { status: 200, data: { ok: 1 } };
  assert.strictEqual(ensureOk(res, 'ctx', { azIdentity: () => { called++; return null; } }), res);
  assert.strictEqual(called, 0, 'must not shell out to az on every successful call');
});

test('AB#6686424: a bodyless error does not print "null" as the server message', () => {
  // Found by LIVE verification, not by the unit fixtures: a real Dataverse 401 often carries no body
  // at all, so `data` is null and the message read "HTTP 401 — null". Every unit fixture supplied a
  // message, so nothing caught it.
  const { ensureOk } = require('../lib/dataverse-auth.js');
  for (const [status, data] of [[401, null], [500, null], [404, undefined]]) {
    assert.throws(
      () => ensureOk({ status, data }, 'ctx', { azIdentity: () => null }),
      (e) => {
        assert.doesNotMatch(e.message, /— null|— undefined/, `${status} must not print a bare null: ${e.message}`);
        assert.match(e.message, /no response body/);
        return true;
      }
    );
  }
});

// --- environment URLs: only a Dataverse https origin is ever used -------------------------------
// The origin is the `--resource` a token is requested for, the base of every request URL, and the
// only place a token is sent. Anything else is refused before a process starts or a request is sent.
test('dataverseOrigin accepts a Dataverse origin in any cloud and returns it canonically', () => {
  const { dataverseOrigin } = require('../lib/dataverse-auth.js');
  for (const [input, expected] of [
    ['https://contoso.crm.dynamics.com', 'https://contoso.crm.dynamics.com'],
    ['https://Contoso.CRM.Dynamics.com/', 'https://contoso.crm.dynamics.com'],
    ['  https://contoso.crm4.dynamics.com//  ', 'https://contoso.crm4.dynamics.com'],
    ['HTTPS://contoso.api.crm.dynamics.com', 'https://contoso.api.crm.dynamics.com'],
    ['https://contoso.crmtest.dynamics.com', 'https://contoso.crmtest.dynamics.com'],
    ['https://contoso.crm.microsoftdynamics.us', 'https://contoso.crm.microsoftdynamics.us'],
    ['https://contoso.crm.appsplatform.us', 'https://contoso.crm.appsplatform.us'],
    ['https://contoso.crm.dynamics.cn', 'https://contoso.crm.dynamics.cn'],
  ]) {
    assert.equal(dataverseOrigin(input), expected, input);
  }
});

test('dataverseOrigin refuses anything that is not exactly an https Dataverse origin', () => {
  const { dataverseOrigin } = require('../lib/dataverse-auth.js');
  for (const input of [
    'http://contoso.crm.dynamics.com',
    'https://contoso.crm.dynamics.com/main.aspx',
    'https://contoso.crm.dynamics.com/?x=1',
    'https://contoso.crm.dynamics.com/#x',
    'https://contoso.crm.dynamics.com:443',
    'https://user@contoso.crm.dynamics.com',
    'https://contoso.crm.dynamics.com/&whoami',
    'https://contoso.crm.dynamics.com&whoami',
    'https://contoso.crm.dynamics.com\\x',
    'https://contoso.crm.dynamics.com%20',
    'https://contoso.crm.dynamics.com\nx',
    'https://contoso.example.com',
    'https://crm.dynamics.com',
    'https://contoso.crm.dynamics.com.example.com',
    '',
    null,
    undefined,
  ]) {
    assert.equal(dataverseOrigin(input), null, JSON.stringify(input));
  }
});

test('a non-origin environment URL starts no Azure CLI process and sends no request', async () => {
  const { getAuthToken, getAuthTokenAsync, dataverseRequest } = require('../lib/dataverse-auth.js');
  let started = 0;
  const exec = () => { started += 1; return 'TOK\n'; };
  const execFile = (_f, _a, _o, cb) => { started += 1; cb(null, 'TOK\n'); };
  const bad = 'https://contoso.crm.dynamics.com/&whoami';
  assert.equal(getAuthToken(bad, { exec, fresh: true }), null);
  assert.equal(await getAuthTokenAsync(bad, { execFile, fresh: true }), null);
  let sent = 0;
  await assert.rejects(
    dataverseRequest(bad, 'GET', 'WhoAmI', null, { getToken: exec, request: async () => { sent += 1; return { statusCode: 200, body: '{}' }; } }),
    /is not a Dataverse environment URL/
  );
  assert.equal(started, 0);
  assert.equal(sent, 0);
});

test('dataverseRequest builds the request on the validated origin and requests the token for it', async () => {
  const { dataverseRequest } = require('../lib/dataverse-auth.js');
  let resource;
  let url;
  await dataverseRequest('https://Contoso.crm.dynamics.com/', 'GET', 'WhoAmI', null, {
    getToken: (r) => { resource = r; return 'TOK'; },
    request: async (o) => { url = o.url; return { statusCode: 200, body: '{}' }; },
  });
  assert.equal(resource, 'https://contoso.crm.dynamics.com');
  assert.equal(url, 'https://contoso.crm.dynamics.com/api/data/v9.2/WhoAmI');
});

test('a path that leaves the Web API root is refused before a token is read or a request sent', async () => {
  const { dataverseRequest } = require('../lib/dataverse-auth.js');
  // [path, where it resolves]. Each spelling reached an endpoint outside /api/data/v9.2/ on a live
  // environment with the released code. The client resolves the first seven itself; the server decodes
  // %2F / %5C and resolves the next three. The last one leaves the root as the client sends it, although
  // the server's further decoding would bring it back: the client reading is checked on its own too.
  const escapes = [
    ['../v9.0/WhoAmI', '/api/data/v9.0/WhoAmI'],
    ['../../../XRMServices/2011/Organization.svc/web', '/XRMServices/2011/Organization.svc/web'],
    ['%2e%2e/%2E%2e/%2e%2E/XRMServices/2011/Organization.svc/web', '/XRMServices/2011/Organization.svc/web'],
    ['.%2e/v9.0/WhoAmI', '/api/data/v9.0/WhoAmI'],
    ['..\\..\\..\\XRMServices\\2011\\Organization.svc\\web', '/XRMServices/2011/Organization.svc/web'],
    ['a%2Fb/../../x', '/api/data/x'],
    ['..', '/api/data/'],
    ['..%2Fv9.0%2FWhoAmI', '/api/data/v9.0/WhoAmI'],
    ['..%5cv9.0%5cWhoAmI', '/api/data/v9.0/WhoAmI'],
    ['.%2e%2Fv9.0%2FWhoAmI', '/api/data/v9.0/WhoAmI'],
    ['../x%2F..%2Fv9.2%2FWhoAmI', '/api/data/x%2F..%2Fv9.2%2FWhoAmI'],
  ];
  for (const [apiPath, resolved] of escapes) {
    let tokens = 0;
    let sent = 0;
    await assert.rejects(
      dataverseRequest('https://contoso.crm.dynamics.com', 'GET', apiPath, null, {
        getToken: () => { tokens += 1; return 'TOK'; },
        request: async () => { sent += 1; return { statusCode: 200, body: '{}' }; },
      }),
      (e) => /leaves the Dataverse Web API root \/api\/data\/v9\.2\//.test(e.message) && e.message.includes(`resolves to '${resolved}'`),
      apiPath
    );
    assert.equal(tokens, 0, apiPath);
    assert.equal(sent, 0, apiPath);
  }
  await assert.rejects(
    dataverseRequest('https://contoso.crm.dynamics.com', 'GET', undefined, null, { getToken: () => 'TOK', request: async () => ({ statusCode: 200, body: '{}' }) }),
    /must be text \(got undefined\)/
  );
});

test('a path inside the Web API root is sent exactly as before', async () => {
  const { dataverseRequest } = require('../lib/dataverse-auth.js');
  const accepted = [
    'WhoAmI',
    "EntityDefinitions(LogicalName='account')/Attributes?$select=LogicalName",
    '$batch',
    // Dataverse answers /api/data/v9.2//WhoAmI and WhoAmI%2F like WhoAmI (measured).
    '/WhoAmI',
    'WhoAmI%2F',
    // Decoded by the server, this resolves back inside the root.
    'x/..%2F..%2Fv9.2%2FWhoAmI',
    // Dot segments inside a query are data, not a path.
    "accounts?$filter=name eq '../../x'",
    // An absolute URL is only text under the root: it cannot change where the request goes.
    'https://example.com/x',
  ];
  for (const apiPath of accepted) {
    let url;
    await dataverseRequest('https://contoso.crm.dynamics.com', 'GET', apiPath, null, {
      getToken: () => 'TOK',
      request: async (o) => { url = o.url; return { statusCode: 200, body: '{}' }; },
    });
    assert.equal(url, `https://contoso.crm.dynamics.com/api/data/v9.2/${apiPath}`, apiPath);
  }
});

test('createAzHttpClient requests its token for the validated origin, never the text it was given', async () => {
  const { createAzHttpClient } = require('../lib/sdk-http-client.js');
  assert.throws(() => createAzHttpClient('https://contoso.crm.dynamics.com/&whoami', { getToken: () => 'TOK' }), /Invalid Dataverse org URL/);
  let resource;
  const http = createAzHttpClient('https://CONTOSO.crm.dynamics.com/', {
    getToken: (r) => { resource = r; return 'TOK'; },
    request: async () => ({ statusCode: 200, body: '{}' }),
  });
  await http.get('https://contoso.crm.dynamics.com/api/data/v9.2/WhoAmI');
  assert.equal(resource, 'https://contoso.crm.dynamics.com');
});

test('azIdentity reads the identity through the process runner seam', () => {
  const { azIdentity } = require('../lib/dataverse-auth.js');
  const seen = [];
  const id = azIdentity({ exec: (cmd, args) => { seen.push([cmd, ...args].join(' ')); return '{"user":"maker@contoso.com","tenantId":"t"}'; } });
  assert.deepEqual(id, { user: 'maker@contoso.com', tenantId: 't' });
  assert.deepEqual(seen, ['az account show --query {user:user.name,tenantId:tenantId} -o json']);
});

// End to end on Windows, where the Azure CLI is a batch shim: the entry-point CLIs refuse an
// environment URL that is not an origin, and nothing but the (fake) Azure CLI ever runs.
test('the Dataverse entry points refuse a non-origin URL before anything runs (real CLI, Windows)', { skip: process.platform !== 'win32' }, () => {
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const scripts = path.join(__dirname, '..');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-origin-e2e-'));
  try {
    const bin = path.join(work, 'bin');
    fs.mkdirSync(bin);
    const azLog = path.join(work, 'az-calls.txt');
    fs.writeFileSync(path.join(bin, 'az.cmd'), `@echo %*>>"${azLog}"\r\n@exit /b 1\r\n`, 'utf8');
    const env = { ...process.env, Path: `${bin};${process.env.SystemRoot}\\System32`, PATH: `${bin};${process.env.SystemRoot}\\System32` };
    const url = 'https://contoso.crm.dynamics.com/&md,MARKER';
    const runs = [
      spawnSync(process.execPath, [path.join(scripts, 'dataverse-request.js'), url, 'GET', 'WhoAmI'], { cwd: work, env, encoding: 'utf8', timeout: 60000 }),
      spawnSync(process.execPath, [path.join(scripts, 'check-auth.js'), '--env', url], { cwd: work, env, encoding: 'utf8', timeout: 60000 }),
    ];
    assert.equal(fs.existsSync(path.join(work, 'MARKER')), false, 'no second command ran');
    assert.match(runs[0].stderr, /is not a Dataverse environment URL/);
    const logged = fs.existsSync(azLog) ? fs.readFileSync(azLog, 'utf8') : '';
    assert.doesNotMatch(logged, /MARKER/, `the URL never reached the Azure CLI: ${logged}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

// Cancelling the token read, end to end on a real cmd.exe. `az.cmd` runs the Azure CLI's program as cmd.exe's CHILD, so ending only
// the cmd.exe Node started (what an AbortSignal handed to execFile does) leaves that program running after the process that
// cancelled it has exited. Here the "CLI" is a node program that records its pid and idles.
test('aborting a real getAuthTokenAsync read ends the program the az shim started too, so nothing is left running (real cmd.exe, Windows)', { skip: process.platform !== 'win32' }, () => {
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-abort-e2e-'));
  const pidFile = path.join(work, 'az-program.pid');
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
  let program = 0;
  try {
    const bin = path.join(work, 'bin');
    fs.mkdirSync(bin);
    // The timer is a backstop: whatever a failing run leaves behind ends by itself.
    fs.writeFileSync(path.join(bin, 'idle.js'), `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => process.exit(0), 120000);\n`, 'utf8');
    fs.writeFileSync(path.join(bin, 'az.cmd'), `@echo off\r\n"${process.execPath}" "${path.join(bin, 'idle.js')}" %*\r\n`, 'utf8');
    const url = 'https://contoso.crm.dynamics.com';
    const driver = `
      const fs = require('fs');
      const { getAuthTokenAsync, tokenFailureKind } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'dataverse-auth.js'))});
      (async () => {
        const controller = new AbortController();
        const read = getAuthTokenAsync(${JSON.stringify(url)}, { signal: controller.signal });
        for (let i = 0; i < 150 && !fs.existsSync(${JSON.stringify(pidFile)}); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
        controller.abort();
        process.stdout.write(JSON.stringify({ token: await read, failure: tokenFailureKind(${JSON.stringify(url)}) }));
      })();`;
    const env = { ...process.env, Path: `${bin};${process.env.SystemRoot}\\System32`, PATH: `${bin};${process.env.SystemRoot}\\System32` };
    const run = spawnSync(process.execPath, ['-e', driver], { cwd: work, env, encoding: 'utf8', timeout: 60000 });
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.deepEqual(JSON.parse(run.stdout), { token: null, failure: null }, 'a cancelled read is null and leaves no failure behind');
    program = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(program > 0, 'the az shim started its program');
    // The tree was ended before the reader that cancelled it exited; allow the OS a moment to finish reaping it.
    const until = Date.now() + 5000;
    while (alive(program) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    assert.equal(alive(program), false, 'the program the az shim started is no longer running');
  } finally {
    // Whatever the assertions above found, never leave the program the shim started running.
    if (!program && fs.existsSync(pidFile)) program = Number(fs.readFileSync(pidFile, 'utf8')) || 0;
    if (program && alive(program)) { try { process.kill(program); } catch { /* already gone */ } }
    fs.rmSync(work, { recursive: true, force: true });
  }
});

// --- emitResult: `ascii` keeps a script's stdout pure ASCII ----------------------------------------------------
//
// An agent reads a script's stdout off a console. Windows PowerShell 5.1 decodes a child's output with the OEM code
// page, so UTF-8 bytes of an em dash arrive as three other characters; written as a \uXXXX escape the same JSON
// survives any code page. Only a script that asks for it changes — every other caller keeps the raw text.
test('emitResult with `ascii` writes every character above U+007E as a \\uXXXX escape, in either outcome, and leaves stderr as written', () => {
  const { spawnSync } = require('node:child_process');
  const path = require('node:path');
  const libPath = path.join(__dirname, '..', 'lib', 'dataverse-auth.js');
  // An em dash and an accented letter (BMP), an emoji (a surrogate pair, as JSON writes a character outside the BMP),
  // DEL, and the characters JSON.stringify already escapes.
  const message = 'Norwegian Bokm\u00e5l \u2014 \ud83d\ude00 \u007f "quoted" \\ back\nline';
  for (const [ok, status] of [[true, 0], [false, 1]]) {
    const payload = { ok, error: message, list: ['1025 ar-SA \u2014 RTL: Yes'] };
    const code = `
      const { emitResult } = require(${JSON.stringify(libPath)});
      emitResult(${ok}, ${JSON.stringify(payload)}, { ascii: true });
    `;
    const res = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' });
    assert.equal(res.status, status, `ok=${ok}: ${res.stderr}`);
    assert.match(res.stdout, /^[\x00-\x7e\r\n]*$/, `ok=${ok}: pure ASCII`);
    assert.ok(res.stdout.includes('\\u2014') && res.stdout.includes('\\u00e5') && res.stdout.includes('\\ud83d\\ude00') && res.stdout.includes('\\u007f'), res.stdout);
    assert.deepEqual(JSON.parse(res.stdout.trim()), payload, `ok=${ok}: the same document, decoded`);
    if (!ok) assert.equal(res.stderr.trim(), message.trim(), 'stderr is for people and is not escaped');
  }
});

test('emitResult without `ascii` still writes the raw text: no other script\u2019s output changes', () => {
  const { spawnSync } = require('node:child_process');
  const path = require('node:path');
  const libPath = path.join(__dirname, '..', 'lib', 'dataverse-auth.js');
  const code = `
    const { emitResult } = require(${JSON.stringify(libPath)});
    emitResult(true, { s: '1025 ar-SA \\u2014 RTL: Yes' });
  `;
  const res = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.includes('\u2014') && !res.stdout.includes('\\u2014'), res.stdout);
});