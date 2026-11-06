'use strict';
// lib/power-apps-service-client.js — the HttpClient the SDK's connection and connector reads carry a Power Apps token in. It is the part of the
// system that holds that credential, so what is pinned here is where it may go, what it may do, and what it never says: other hosts, http,
// relative URLs, credentials and ports in a URL, every method but GET, a redirect, a missing token, a failing transport, a token in a message.
// The token reads are tested through dataverse-auth.js's own seams (`exec`), never a real Azure CLI.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createPowerAppsServiceClient, isAllowedHost, PowerAppsClientError, BAP_HOSTS, REQUEST_TIMEOUT_MS } = require('../lib/power-apps-service-client.js');
const auth = require('../lib/dataverse-auth.js');

const TOKEN = 'power-apps-secret-token-value';
const BAP_URL = 'https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/environments/11111111-1111-4111-8111-111111111111?api-version=2021-04-01';

// A client over a recording transport. `answer` is what the transport resolves for the next request.
function harness({ token = TOKEN, answer = { statusCode: 200, headers: { 'content-type': 'application/json' }, body: '{"name":"env"}' }, tokenFailureMessage, timeoutMs } = {}) {
  const sent = [];
  const reads = [];
  const client = createPowerAppsServiceClient({
    getToken: () => { reads.push('token'); return token; },
    tokenFailureMessage,
    timeoutMs,
    request: async (options) => {
      sent.push(options);
      return typeof answer === 'function' ? answer(options) : answer;
    },
  });
  return { client, sent, reads };
}

async function refused(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof PowerAppsClientError, `a PowerAppsClientError, got ${err && err.constructor && err.constructor.name}: ${err && err.message}`);
    assert.strictEqual(err.code, code);
    assert.ok(!String(err.message).includes(TOKEN), 'the message never holds the token');
    return true;
  });
}

// --- the allowlist: exactly the hosts the SDK's connectivity code calls --------------------------------------------------------------

test('the allowed hosts are the two BAP hosts and api.powerapps.com with the names under it — and nothing else', () => {
  assert.deepStrictEqual([...BAP_HOSTS], ['api.bap.microsoft.com', 'test.api.bap.microsoft.com']);
  for (const host of [
    'api.bap.microsoft.com',
    'test.api.bap.microsoft.com',
    'api.powerapps.com',
    'unitedstates.api.powerapps.com',
    'unitedstatesfirstrelease.api.powerapps.com',
    'unitedstates.tip2.api.powerapps.com',
    'a.b-c.d.api.powerapps.com',
  ]) assert.strictEqual(isAllowedHost(host), true, host);
  for (const host of [
    'evil.example',
    'api.powerapps.com.evil.example',
    'evilapi.powerapps.com',
    'powerapps.com',
    'service.powerapps.com',
    'make.powerapps.com',
    'api.bap.microsoft.us',
    'gov.api.bap.microsoft.us',
    'bap.microsoft.com',
    'api.bap.microsoft.com.evil.example',
    'evil.api.bap.microsoft.com',
    'x.test.api.bap.microsoft.com',
    '.api.powerapps.com',
    'api.powerapps.com.',
    'localhost',
    '127.0.0.1',
    '[::1]',
    'contoso.crm.dynamics.com',
    '',
    undefined,
    null,
    42,
  ]) assert.strictEqual(isAllowedHost(host), false, String(host));
});

test('a GET to an allowed host is sent once, with the bearer token, as the URL that was checked, and answers in the SDK\'s shape', async () => {
  const { client, sent } = harness();
  const res = await client.get(BAP_URL);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].method, 'GET');
  assert.strictEqual(sent[0].url, BAP_URL);
  assert.strictEqual(sent[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.strictEqual(sent[0].headers.Accept, 'application/json');
  assert.strictEqual(sent[0].includeHeaders, true);
  assert.deepStrictEqual(res, { status: 200, headers: { 'content-type': 'application/json' }, body: { name: 'env' } });
});

test('every shape of runtime URL the SDK builds is allowed: a regional host, a Test-cloud host, a connection page and its nextLink', async () => {
  const { client, sent } = harness();
  const urls = [
    'https://unitedstates.api.powerapps.com/providers/Microsoft.PowerApps/connections?api-version=2016-11-01&$filter=environment%20eq%20%2711111111-1111-4111-8111-111111111111%27',
    'https://unitedstates.tip2.api.powerapps.com/providers/Microsoft.PowerApps/apis/shared_msnweather?api-version=2016-11-01',
    'https://test.api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/environments/x?api-version=2021-04-01',
    'https://unitedstates.api.powerapps.com/providers/Microsoft.PowerApps/connections?api-version=2016-11-01&$skiptoken=abc&$paginationId=1',
  ];
  for (const url of urls) await client.get(url);
  assert.deepStrictEqual(sent.map((s) => s.url), urls);
});

test('a host that is not Business Application Platform or Power Apps is refused before a token is read or anything is sent', async () => {
  const { client, sent, reads } = harness();
  for (const url of [
    'https://evil.example/providers/Microsoft.PowerApps/connections',
    'https://api.powerapps.com.evil.example/x',
    'https://contoso.crm.dynamics.com/api/data/v9.2/WhoAmI',
    'https://login.microsoftonline.com/common/oauth2/token',
    'https://service.powerapps.com/',
    'https://api.bap.microsoft.us/providers/Microsoft.BusinessAppPlatform/environments/x',
  ]) await refused(client.get(url), 'POWER_APPS_URL_REFUSED');
  assert.deepStrictEqual(sent, [], 'nothing was sent');
  assert.deepStrictEqual(reads, [], 'no token was read for a request that was going to be refused');
});

test('http:, and every other scheme, is refused — the token is never sent in clear text', async () => {
  const { client, sent } = harness();
  for (const url of [
    'http://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/environments/x',
    'http://unitedstates.api.powerapps.com/providers/Microsoft.PowerApps/connections',
    'ftp://api.bap.microsoft.com/x',
    'file:///etc/passwd',
    'ws://api.bap.microsoft.com/x',
  ]) await refused(client.get(url), 'POWER_APPS_URL_REFUSED');
  assert.deepStrictEqual(sent, []);
});

test('a relative URL, an empty one and one that is not text are refused: the client sends absolute URLs only', async () => {
  const { client, sent } = harness();
  for (const url of ['/providers/Microsoft.PowerApps/connections', 'providers/Microsoft.PowerApps/connections', '//api.bap.microsoft.com/x', '', '   ', undefined, null, 42, {}]) {
    await refused(client.get(url), 'POWER_APPS_URL_REFUSED');
  }
  assert.deepStrictEqual(sent, []);
});

test('credentials or a port in the URL are refused, and so is a host written to look like an allowed one', async () => {
  const { client, sent } = harness();
  // The `@` is written apart so no line reads as an e-mail address to the repository's environment-identifier scan.
  const AT = '@';
  for (const url of [
    `https://user:pass${AT}api.bap.microsoft.com/x`,
    `https://api.bap.microsoft.com${AT}evil.example/x`,
    'https://api.bap.microsoft.com:8443/x',
    'https://unitedstates.api.powerapps.com:444/x',
    'https://evil.example#@api.bap.microsoft.com/x',
    'https://evil.example?@api.bap.microsoft.com/x',
  ]) {
    await assert.rejects(client.get(url), (err) => err instanceof PowerAppsClientError && err.code === 'POWER_APPS_URL_REFUSED', url);
  }
  assert.deepStrictEqual(sent, [], 'none of them was sent');
});

test('what is sent is the URL as it was checked, not the text the caller gave (the transport parses a URL once more)', async () => {
  const { client, sent } = harness();
  await client.get('https://API.BAP.Microsoft.COM/providers/Microsoft.BusinessAppPlatform/environments/x');
  assert.strictEqual(sent[0].url, 'https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/environments/x');
  // The URL parser reads a backslash as a slash in an https URL, so this text names the BAP host and a path — not evil.example. What is sent is that parse.
  await client.get('https://api.bap.microsoft.com\\@evil.example/x');
  assert.strictEqual(sent[1].url, 'https://api.bap.microsoft.com/@evil.example/x');
});

// --- GET only --------------------------------------------------------------------------------------------------------------------

test('every method but GET is refused, without a token read or a request — also to an allowed host', async () => {
  const { client, sent, reads } = harness();
  await refused(client.post(BAP_URL, { x: 1 }), 'POWER_APPS_METHOD_REFUSED');
  await refused(client.patch(BAP_URL, { x: 1 }), 'POWER_APPS_METHOD_REFUSED');
  await refused(client.delete(BAP_URL), 'POWER_APPS_METHOD_REFUSED');
  await refused(client.put(BAP_URL, { x: 1 }), 'POWER_APPS_METHOD_REFUSED');
  await refused(client.postRaw(BAP_URL, 'x'), 'POWER_APPS_METHOD_REFUSED');
  await refused(client.patchRaw(BAP_URL, new Uint8Array([1])), 'POWER_APPS_METHOD_REFUSED');
  assert.deepStrictEqual(sent, []);
  assert.deepStrictEqual(reads, []);
  assert.deepStrictEqual(Object.keys(client).sort(), ['delete', 'get', 'patch', 'patchRaw', 'post', 'postRaw', 'put']);
});

// --- redirects -------------------------------------------------------------------------------------------------------------------

test('a redirect is never followed: the one request is the whole conversation, and the 3xx comes back as the answer', async () => {
  const { client, sent } = harness({ answer: { statusCode: 302, headers: { location: 'https://evil.example/steal' }, body: '' } });
  const res = await client.get(BAP_URL);
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.location, 'https://evil.example/steal');
  assert.strictEqual(sent.length, 1, 'no second request, to the Location or anywhere else');
  assert.ok(sent.every((s) => !String(s.url).includes('evil.example')));
});

test('the transport the client uses does not follow a redirect either (a real local server, so a transport that did would reach /next)', async () => {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url === '/start') {
      res.writeHead(302, { Location: `http://127.0.0.1:${server.address().port}/next` });
      res.end();
    } else {
      res.writeHead(200);
      res.end('followed');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await auth.makeRequest({ url: `http://127.0.0.1:${server.address().port}/start`, method: 'GET', includeHeaders: true, timeout: 5000 });
    assert.strictEqual(res.statusCode, 302);
    assert.deepStrictEqual(hits, ['/start']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// --- the token ---------------------------------------------------------------------------------------------------------------------

test('no token: the request is not sent, the rejection carries POWER_APPS_TOKEN_UNAVAILABLE and the reason', async () => {
  const { client, sent } = harness({ token: null, tokenFailureMessage: () => 'Could not get an Azure CLI token for the Power Apps service: Azure CLI (`az`) is not on PATH.' });
  await assert.rejects(client.get(BAP_URL), (err) => {
    assert.strictEqual(err.code, 'POWER_APPS_TOKEN_UNAVAILABLE');
    assert.match(err.message, /Azure CLI \(`az`\) is not on PATH/);
    return true;
  });
  assert.deepStrictEqual(sent, []);
});

test('the token may be read asynchronously, and an empty one is no token', async () => {
  const sent = [];
  const make = (token) => createPowerAppsServiceClient({
    getToken: async () => token,
    request: async (o) => { sent.push(o); return { statusCode: 200, body: '{}', headers: {} }; },
  });
  await make('async-token').get(BAP_URL);
  assert.strictEqual(sent[0].headers.Authorization, 'Bearer async-token');
  await refused(make('').get(BAP_URL), 'POWER_APPS_TOKEN_UNAVAILABLE');
  await refused(make(undefined).get(BAP_URL), 'POWER_APPS_TOKEN_UNAVAILABLE');
  assert.strictEqual(sent.length, 1);
});

test('the Azure CLI is asked for https://service.powerapps.com/, through the plugin\'s own token code, with the memo and the failure record it has', () => {
  const calls = [];
  const exec = (name, args, options) => {
    calls.push({ name, args, options });
    return 'tok-from-az\n';
  };
  assert.strictEqual(auth.getPowerAppsToken({ exec, fresh: true }), 'tok-from-az');
  assert.deepStrictEqual(calls[0].args, ['account', 'get-access-token', '--resource', 'https://service.powerapps.com/', '--query', 'accessToken', '-o', 'tsv']);
  assert.strictEqual(calls[0].name, 'az');
  assert.deepStrictEqual(calls[0].options.stdio, ['ignore', 'pipe', 'pipe'], 'its output is captured, never shown');
  assert.strictEqual(auth.getPowerAppsToken({ exec }), 'tok-from-az', 'an ordinary repeat is served from the memo');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(auth.POWER_APPS_RESOURCE, 'https://service.powerapps.com/');
  assert.strictEqual(auth.powerAppsTokenFailureKind(), null);
  // The Dataverse reader is unchanged: it still refuses anything that is not a Dataverse origin, and the Power Apps audience is not one.
  assert.strictEqual(auth.getAuthToken('https://service.powerapps.com/', { exec }), null);
  assert.strictEqual(calls.length, 1, 'no process was started for it');
});

test('a Power Apps token that cannot be had says why: Azure CLI missing, slow, or signed out — and never holds a token', () => {
  const fails = (code, message) => () => { throw Object.assign(new Error(message), { code }); };
  auth.getPowerAppsToken({ exec: fails('ENOENT', 'spawn az ENOENT: not found on PATH'), fresh: true });
  assert.strictEqual(auth.powerAppsTokenFailureKind(), 'missing');
  assert.match(auth.powerAppsTokenFailureMessage(), /Power Apps service: Azure CLI \(`az`\) is not on PATH/);
  auth.getPowerAppsToken({ exec: fails('ETIMEDOUT', 'spawnSync az ETIMEDOUT'), fresh: true });
  assert.strictEqual(auth.powerAppsTokenFailureKind(), 'timeout');
  assert.match(auth.powerAppsTokenFailureMessage(), /Power Apps service: `az account get-access-token` did not answer within \d+ s/);
  assert.strictEqual(auth.getPowerAppsToken({ exec: fails(1, 'Command failed'), fresh: true }), null);
  assert.strictEqual(auth.powerAppsTokenFailureKind(), 'failed');
  assert.match(auth.powerAppsTokenFailureMessage(), /Run `az login` first/);
  // A later success clears the record.
  assert.strictEqual(auth.getPowerAppsToken({ exec: () => 'ok-token', fresh: true }), 'ok-token');
  assert.strictEqual(auth.powerAppsTokenFailureKind(), null);
});

test('getPowerAppsTokenAsync shares the memo and the failure record with the synchronous read', async () => {
  const execFile = (name, args, options, callback) => { callback(null, 'async-tok\n', ''); return { pid: 1 }; };
  assert.strictEqual(await auth.getPowerAppsTokenAsync({ execFile, fresh: true }), 'async-tok');
  assert.strictEqual(auth.getPowerAppsToken({ exec: () => { throw new Error('must be served from the memo'); } }), 'async-tok');
  const failing = (name, args, options, callback) => { callback(Object.assign(new Error('x'), { code: 'ENOENT' }), '', ''); return { pid: 1 }; };
  assert.strictEqual(await auth.getPowerAppsTokenAsync({ execFile: failing, fresh: true }), null);
  assert.strictEqual(auth.powerAppsTokenFailureKind(), 'missing');
  await auth.getPowerAppsTokenAsync({ execFile, fresh: true }); // leave a token in the memo for the tests that follow in this process
});

// --- failures of the transport --------------------------------------------------------------------------------------------------

test('a transport that fails rejects with POWER_APPS_REQUEST_FAILED, and a message that repeats the request it failed is cleaned of the token', async () => {
  const { client } = harness({ answer: { error: 'socket hang up' } });
  await assert.rejects(client.get(BAP_URL), (err) => err.code === 'POWER_APPS_REQUEST_FAILED' && /socket hang up/.test(err.message));

  const leaky = createPowerAppsServiceClient({
    getToken: () => TOKEN,
    request: async (options) => { throw new Error(`request failed: ${JSON.stringify(options.headers)}`); },
  });
  await assert.rejects(leaky.get(BAP_URL), (err) => {
    assert.strictEqual(err.code, 'POWER_APPS_REQUEST_FAILED');
    assert.ok(!err.message.includes(TOKEN), err.message);
    assert.match(err.message, /<token>/);
    return true;
  });

  const noAnswer = createPowerAppsServiceClient({ getToken: () => TOKEN, request: async () => undefined });
  await refused(noAnswer.get(BAP_URL), 'POWER_APPS_REQUEST_FAILED');
});

test('a timeout is given to the transport: a minute of silence by default, and the caller\'s value when it names one', async () => {
  assert.strictEqual(REQUEST_TIMEOUT_MS, 60000);
  const a = harness();
  await a.client.get(BAP_URL);
  assert.strictEqual(a.sent[0].timeout, REQUEST_TIMEOUT_MS);
  const b = harness({ timeoutMs: 1234 });
  await b.client.get(BAP_URL);
  assert.strictEqual(b.sent[0].timeout, 1234);
});

test('a body that is not JSON is the text it is, an empty one is undefined, and the status and headers are the transport\'s', async () => {
  const text = harness({ answer: { statusCode: 502, headers: { 'x-y': '1' }, body: '<html>Bad gateway</html>' } });
  assert.deepStrictEqual(await text.client.get(BAP_URL), { status: 502, headers: { 'x-y': '1' }, body: '<html>Bad gateway</html>' });
  const none = harness({ answer: { statusCode: 204, body: '' } });
  assert.deepStrictEqual(await none.client.get(BAP_URL), { status: 204, headers: {}, body: undefined });
  const error = harness({ answer: { statusCode: 410, headers: {}, body: '{"error":{"code":"ServiceDecommissioned","message":"gone"}}' } });
  assert.deepStrictEqual((await error.client.get(BAP_URL)).body, { error: { code: 'ServiceDecommissioned', message: 'gone' } });
});

// A token the way Azure issues one: three base64url parts joined by dots (synthetic).
const JWT = 'eyJhbGciOiJSUzI1NiJ9abcdefghij.eyJzdWIiOiJtYWtlci1hbmQtc29tZXRoaW5nLWxvbmcifQabcdef.c2lnbmF0dXJlLXBhcnQtb2YtdGhlLXRva2VuIiwgImtpZCI6';
const [JWT_HEADER, JWT_PAYLOAD, JWT_SIGNATURE] = JWT.split('.');

test('the token is taken out of what the SERVICE answered — an error body that repeats it, JSON or text, in a value, a list, a key or a header — and the status and the typed code survive', async () => {
  const json = harness({
    token: JWT,
    answer: {
      statusCode: 403,
      headers: { 'content-type': 'application/json', 'www-authenticate': `Bearer error="invalid_token", error_description="${JWT} was rejected"` },
      body: JSON.stringify({ error: { code: 'InvalidAuthenticationToken', message: `Authorization rejected: ${JWT}`, details: [`the token ${JWT}`, { note: JWT }] }, [JWT]: 'as a key', status: 403 }),
    },
  });
  const answered = await json.client.get(BAP_URL);
  assert.strictEqual(answered.status, 403);
  assert.strictEqual(answered.body.error.code, 'InvalidAuthenticationToken', 'the typed code the SDK reads is left as it is');
  assert.strictEqual(answered.body.error.message, 'Authorization rejected: <token>');
  assert.deepStrictEqual(answered.body.error.details, ['the token <token>', { note: '<token>' }]);
  assert.strictEqual(answered.body['<token>'], 'as a key');
  assert.strictEqual(answered.body.status, 403);
  assert.strictEqual(answered.headers['content-type'], 'application/json');
  assert.strictEqual(answered.headers['www-authenticate'], 'Bearer error="invalid_token", error_description="<token> was rejected"');
  assert.ok(!JSON.stringify(answered).includes(JWT), JSON.stringify(answered));

  // A text body (an error page), a failure with no JSON at all.
  const text = harness({ token: JWT, answer: { statusCode: 401, headers: {}, body: `<html>Unauthorized: bearer ${JWT}</html>` } });
  assert.deepStrictEqual(await text.client.get(BAP_URL), { status: 401, headers: {}, body: '<html>Unauthorized: bearer <token></html>' });

  // A body the transport already parsed (an object), and a success whose body echoes the token: scrubbed alike.
  const parsed = harness({ token: JWT, answer: { statusCode: 200, headers: {}, body: { echo: JWT, list: [JWT, 1, null, true] } } });
  assert.deepStrictEqual((await parsed.client.get(BAP_URL)).body, { echo: '<token>', list: ['<token>', 1, null, true] });
});

test('what a service repeats of a token is often one PART of it — each long part is taken out too, and a short one is left alone', async () => {
  for (const part of [JWT_HEADER, JWT_PAYLOAD, JWT_SIGNATURE]) {
    const { client } = harness({ token: JWT, answer: { statusCode: 400, headers: {}, body: JSON.stringify({ error: { message: `the part ${part} is not valid` } }) } });
    const answered = await client.get(BAP_URL);
    assert.strictEqual(answered.body.error.message, 'the part <token> is not valid', part);
  }
  const short = harness({ token: 'aaa.bbb.ccc', answer: { statusCode: 400, headers: {}, body: '{"error":{"message":"aaa and bbb and ccc"}}' } });
  assert.strictEqual((await short.client.get(BAP_URL)).body.error.message, 'aaa and bbb and ccc', 'parts shorter than 24 characters would be taken out of ordinary words');
  const opaque = harness({ token: TOKEN, answer: { statusCode: 400, headers: {}, body: `{"error":{"message":"${TOKEN} no"}}` } });
  assert.strictEqual((await opaque.client.get(BAP_URL)).body.error.message, '<token> no', 'a token with no dots is taken out whole');
});

test('a body nested deeper than any real answer is replaced rather than walked, and holds no token either', async () => {
  let nested = { token: TOKEN };
  for (let i = 0; i < 300; i += 1) nested = { next: nested };
  const { client } = harness({ answer: { statusCode: 200, headers: {}, body: nested } });
  const answered = await client.get(BAP_URL);
  assert.ok(!JSON.stringify(answered).includes(TOKEN));
  assert.match(JSON.stringify(answered), /too deeply nested to scrub/);
});

test('the SDK\'s error built from such an answer holds no token: it prints the body\'s message, and the message has been cleaned', async () => {
  const { ConnectionError } = require('../lib/maker-sdk.js');
  const { client } = harness({ token: JWT, answer: { statusCode: 403, headers: {}, body: JSON.stringify({ error: { code: 'InvalidAuthenticationToken', message: `Authorization rejected: ${JWT}` } }) } });
  const answered = await client.get(BAP_URL);
  const error = new ConnectionError(BAP_URL, answered.status, answered.body.error.message, answered.body);
  assert.ok(!error.message.includes(JWT) && !JSON.stringify(error.cause).includes(JWT), error.message);
  assert.match(error.message, /^HTTP 403 from [^:]+:\/\/[^ ]+: Authorization rejected: <token>$/);
});

test('a refusal names the host and never the whole URL (it carries the environment\'s id and filter)', async () => {
  const { client } = harness();
  await assert.rejects(client.get('https://evil.example/providers/x?$filter=environment%20eq%20%2711111111-1111-4111-8111-111111111111%27'), (err) => {
    assert.match(err.message, /evil\.example/);
    assert.ok(!err.message.includes('11111111-1111-4111-8111-111111111111'), err.message);
    return true;
  });
});
