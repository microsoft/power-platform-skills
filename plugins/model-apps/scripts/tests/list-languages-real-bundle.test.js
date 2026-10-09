'use strict';
// REAL BUNDLE: the languages script's read, through the plugin's real az-token HttpClient over a fake Dataverse that
// answers the three reads the SDK's `getEnvironmentLanguages()` makes, in the shapes the SDK measured on live
// environments:
//   GET organizations?$select=languagecode      -> { value: [ { languagecode: <LCID> } ] }            one row
//   GET RetrieveProvisionedLanguages()          -> { RetrieveProvisionedLanguages: [<LCID>, ...] }    the key is the function's
//   GET RetrieveAvailableLanguages()            -> { LocaleIds: [<LCID>, ...] }                       a different key
// A stub cannot tell the plugin that a re-vendored bundle stopped answering `ENVIRONMENT_LANGUAGES_UNREADABLE` for a
// shape it cannot read, started to default to English, wrote to the workspace, or moved a read: this can.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const auth = require('../lib/dataverse-auth.js');
const { readLanguages } = require('../list-languages.js');

const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');
const ENV = 'https://contoso.crm.dynamics.com';

const json = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// A Dataverse holding one organization. `languages` answers each read: a number or list is the measured body; a
// function receives the request and answers however the test needs (a status, a body of another shape).
function fakeOrg({ base = 1033, provisioned = [1033], available = [1033], answer = {} } = {}) {
  const requests = [];
  async function request({ url, method, headers }) {
    const u = new URL(url);
    const where = decodeURIComponent(u.pathname + u.search);
    requests.push({ method, where, authorization: headers && headers.Authorization, headers });
    const read = (name, fallback) => (typeof answer[name] === 'function' ? answer[name]() : fallback);
    if (method === 'GET' && /\/organizations\?\$select=languagecode$/.test(where)) {
      return read('organization', json(200, {
        '@odata.context': `${ENV}/api/data/v9.2/$metadata#organizations(languagecode)`,
        value: [{ '@odata.etag': 'W/"1"', languagecode: base, organizationid: '00000000-0000-0000-0000-000000000001' }],
      }));
    }
    if (method === 'GET' && /\/RetrieveProvisionedLanguages\(\)$/.test(where)) {
      return read('provisioned', json(200, {
        '@odata.context': `${ENV}/api/data/v9.2/$metadata#Microsoft.Dynamics.CRM.RetrieveProvisionedLanguagesResponse`,
        RetrieveProvisionedLanguages: provisioned,
      }));
    }
    if (method === 'GET' && /\/RetrieveAvailableLanguages\(\)$/.test(where)) {
      return read('available', json(200, {
        '@odata.context': `${ENV}/api/data/v9.2/$metadata#Microsoft.Dynamics.CRM.RetrieveAvailableLanguagesResponse`,
        LocaleIds: available,
      }));
    }
    throw new Error(`the languages read made an unexpected request: ${method} ${where}`);
  }
  return { request, requests };
}

function clientFor(org, tokens = []) {
  return createAzHttpClient(ENV, {
    getToken: (origin) => { tokens.push(origin); return 'test-token'; },
    request: org.request,
    sleep: async () => {},
  });
}

test('REAL BUNDLE: an English-only, a Spanish-only and a two-language environment, each in three reads and in the planner\u2019s terms', async () => {
  const cases = [
    { name: 'English only', org: { base: 1033, provisioned: [1033], available: [1033] }, languages: [[1033, 'en-US', false]], base: [1033, 'en-US'] },
    { name: 'Spanish only', org: { base: 3082, provisioned: [3082], available: [3082] }, languages: [[3082, 'es-ES', false]], base: [3082, 'es-ES'] },
    { name: 'two languages', org: { base: 1033, provisioned: [1033, 3082], available: [1033, 3082] }, languages: [[1033, 'en-US', false], [3082, 'es-ES', false]], base: [1033, 'en-US'] },
    { name: 'Arabic and French beside English', org: { base: 1033, provisioned: [1033, 1025, 1036], available: [1033, 1025, 1036, 3082] }, languages: [[1033, 'en-US', false], [1025, 'ar-SA', true], [1036, 'fr-FR', false]], base: [1033, 'en-US'] },
  ];
  for (const c of cases) {
    const org = fakeOrg(c.org);
    const tokens = [];
    const result = await readLanguages(ENV, clientFor(org, tokens));
    assert.deepStrictEqual(org.requests.map((r) => `${r.method} ${r.where.replace(/^\/api\/data\/v9\.\d\//, '')}`), [
      'GET organizations?$select=languagecode',
      'GET RetrieveProvisionedLanguages()',
      'GET RetrieveAvailableLanguages()',
    ], `${c.name}: three reads, in the SDK's order, and nothing else`);
    assert.ok(org.requests.every((r) => r.authorization === 'Bearer test-token'), `${c.name}: each read carries the az token`);
    assert.deepStrictEqual(tokens, [ENV], `${c.name}: one token, for the environment's own origin`);
    assert.deepStrictEqual(result.languages.map((l) => [l.lcid, l.code, l.rtl]), c.languages, c.name);
    assert.deepStrictEqual([result.baseLanguage.lcid, result.baseLanguage.code], c.base, c.name);
    assert.deepStrictEqual(result.unmapped, [], c.name);
    assert.ok(!JSON.stringify(result).includes('test-token'), `${c.name}: no token in the output`);
  }
});

test('REAL BUNDLE: an LCID this plugin cannot name comes through numeric, and the answer is still complete', async () => {
  const org = fakeOrg({ base: 1033, provisioned: [1033, 4096], available: [1033, 4096] });
  const result = await readLanguages(ENV, clientFor(org));
  assert.deepStrictEqual(result.languages[1], { lcid: 4096, code: null, name: null, rtl: null });
  assert.deepStrictEqual(result.unmapped, [4096]);
  assert.strictEqual(result.summary[1], '4096 unknown \u2014 RTL: unknown');
});

test('REAL BUNDLE: a BASE language this plugin cannot name is reported in `unmapped` although it is not provisioned', async () => {
  const result = await readLanguages(ENV, clientFor(fakeOrg({ base: 4096, provisioned: [1033], available: [1033] })));
  assert.deepStrictEqual(result.baseLanguage, { lcid: 4096, code: null, name: null, rtl: null });
  assert.deepStrictEqual(result.unmapped, [4096]);
  assert.deepStrictEqual(result.languages.map((l) => l.lcid), [1033], 'the provisioned languages are the ones the server listed');
});

test('REAL BUNDLE: an answer it cannot read as a list of languages fails ENVIRONMENT_LANGUAGES_UNREADABLE, never an English default', async () => {
  const shapes = {
    'an empty provisioned list': { provisioned: () => json(200, { RetrieveProvisionedLanguages: [] }) },
    'provisioned under the other function\u2019s key': { provisioned: () => json(200, { LocaleIds: [1033] }) },
    'a non-integer LCID': { provisioned: () => json(200, { RetrieveProvisionedLanguages: [1033, '3082'] }) },
    'an available list with no answer': { available: () => json(200, { LocaleIds: [] }) },
    'two organization rows': { organization: () => json(200, { value: [{ languagecode: 1033 }, { languagecode: 1033 }] }) },
    'an organization row with no language code': { organization: () => json(200, { value: [{ organizationid: 'x' }] }) },
    'an organization answer with no rows': { organization: () => json(200, { value: [] }) },
  };
  for (const [name, answer] of Object.entries(shapes)) {
    const org = fakeOrg({ answer });
    await assert.rejects(readLanguages(ENV, clientFor(org)), (err) => {
      assert.strictEqual(err.code, 'ENVIRONMENT_LANGUAGES_UNREADABLE', `${name}: ${err.message}`);
      assert.match(err.message, /Nothing is assumed in its place/, name);
      return true;
    }, name);
  }
});

// Every way the Azure CLI or the identity can fail, through the REAL token reader and client. The planner falls back to
// `pac model list-languages` on ANY non-zero exit of the script, so what these pin is that each one is a rejected
// read — never an answer, and never an English default in the place of one. The SDK reports them all as the same
// `CONNECTION_ERROR`: a failure before any answer (statusCode 0) wraps the client's own error, so a missing Azure CLI
// reads like a dropped connection, and a refusal carries its HTTP status. Nothing in either is a code a planner could
// match, which is why its rule is the exit status.
//   az missing   `spawn az ENOENT: not found on PATH`  (process-runner.js)     -> kind 'missing'
//   az too slow  `ETIMEDOUT`                                                   -> kind 'timeout'   (cli-failure.js)
//   az signed out  any other failure of `az account get-access-token`          -> kind 'failed'
const failingAz = (code, message) => (origin, options) => auth.getAuthToken(origin, { ...options, exec: () => { throw Object.assign(new Error(message), { code }); } });

test('REAL BUNDLE: every Azure CLI or identity failure rejects the read — no answer, and no request made without a token', async () => {
  const cases = {
    'the Azure CLI is not installed': { getToken: failingAz('ENOENT', 'spawn az ENOENT: not found on PATH'), statusCode: 0, message: /Could not get an Azure CLI token for .*: Azure CLI \(`az`\) is not on PATH/ },
    'the Azure CLI is too slow': { getToken: failingAz('ETIMEDOUT', 'spawnSync az ETIMEDOUT'), statusCode: 0, message: /Could not get an Azure CLI token for .*: `az account get-access-token` did not answer within \d+ s/ },
    'the Azure CLI is signed out': { getToken: failingAz(1, 'Command failed: az account get-access-token'), statusCode: 0, message: /Failed to get Azure CLI token for .*Run 'az login' first/ },
  };
  for (const [name, c] of Object.entries(cases)) {
    const org = fakeOrg();
    await assert.rejects(readLanguages(ENV, createAzHttpClient(ENV, { getToken: c.getToken, request: org.request, sleep: async () => {} })), (err) => {
      assert.strictEqual(err.code, 'CONNECTION_ERROR', `${name}: ${err.message}`);
      assert.strictEqual(err.statusCode, c.statusCode, name);
      assert.match(err.message, c.message, name);
      return true;
    }, name);
    assert.deepStrictEqual(org.requests, [], `${name}: the Dataverse was never asked`);
  }
  const refusals = {
    'a token for another tenant (401)': { answer: () => json(401, { error: { message: 'Unauthorized' } }), statusCode: 401, message: /^HTTP 401 from / },
    'an identity that is no user of the environment (403)': { answer: () => json(403, { error: { code: '0x80072560', message: 'The user is not a member of the organization.' } }), statusCode: 403, message: /^HTTP 403 from .*The user is not a member of the organization\./ },
    'a connection that drops': { answer: () => ({ error: 'ECONNRESET' }), statusCode: 0, message: /^Transport failure reaching .*Request failed: ECONNRESET/ },
    'an environment that is down (503)': { answer: () => json(503, { error: { message: 'Service unavailable' } }), statusCode: 503, message: /^HTTP 503 from / },
  };
  for (const [name, c] of Object.entries(refusals)) {
    const client = createAzHttpClient(ENV, { getToken: () => 'test-token', request: async () => c.answer(), sleep: async () => {} });
    await assert.rejects(readLanguages(ENV, client), (err) => {
      assert.strictEqual(err.code, 'CONNECTION_ERROR', `${name}: ${err.message}`);
      assert.strictEqual(err.statusCode, c.statusCode, name);
      assert.match(err.message, c.message, name);
      assert.ok(!err.message.includes('test-token'), `${name}: no token in the message`);
      return true;
    }, name);
  }
});

test('REAL BUNDLE: a read the platform refuses fails with its own error, and no partial answer is returned', async () => {
  for (const [name, answer] of Object.entries({
    organization: { organization: () => json(403, { error: { code: '0x80040220', message: 'SecLib::AccessCheckEx failed' } }) },
    provisioned: { provisioned: () => json(403, { error: { code: '0x80040220', message: 'SecLib::AccessCheckEx failed' } }) },
    available: { available: () => json(404, { error: { message: 'Resource not found for the segment RetrieveAvailableLanguages' } }) },
  })) {
    const org = fakeOrg({ answer });
    await assert.rejects(readLanguages(ENV, clientFor(org)), (err) => {
      assert.notStrictEqual(err.code, 'ENVIRONMENT_LANGUAGES_UNREADABLE', `${name}: a refused read is not an unreadable shape`);
      assert.match(err.message, /40[34]|SecLib|Resource not found/, `${name}: ${err.message}`);
      return true;
    }, name);
  }
});

test('REAL BUNDLE: the read uses no workspace — nothing is written, not even the manifest an initialized one lays down', async () => {
  const { createMakerSdk, createNodeWorkspaceStorage } = require(BUNDLE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'languages-ws-'));
  try {
    const org = fakeOrg({ provisioned: [1033, 3082], available: [1033, 3082] });
    const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: ENV, httpClient: clientFor(org) });
    assert.deepStrictEqual(await sdk.getEnvironmentLanguages(), { baseLanguage: 1033, provisioned: [1033, 3082], available: [1033, 3082] });
    assert.deepStrictEqual(fs.readdirSync(dir), [], 'the SDK never touched its workspace, so the script needs no initWorkspace()');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('REAL BUNDLE: the script leaves no throwaway directory behind, on a read or on a refused one', async () => {
  const made = [];
  const mkdtemp = fs.mkdtempSync;
  fs.mkdtempSync = (prefix, ...rest) => { const dir = mkdtemp(prefix, ...rest); made.push(dir); return dir; };
  try {
    await readLanguages(ENV, clientFor(fakeOrg()));
    await assert.rejects(readLanguages(ENV, clientFor(fakeOrg({ answer: { provisioned: () => json(403, { error: { message: 'no' } }) } }))));
  } finally {
    fs.mkdtempSync = mkdtemp;
  }
  assert.strictEqual(made.length, 2);
  for (const dir of made) assert.strictEqual(fs.existsSync(dir), false, dir);
});
