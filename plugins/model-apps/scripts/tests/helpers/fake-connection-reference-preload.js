'use strict';

// Runs create-connection-reference.js as a real process over the fake configuration org, so a test can assert the
// exact bytes the CLI writes to stdout and stderr and its exit code. Loaded with `node -r`, it swaps the az-token HTTP
// client for one over the fake org before the CLI requires it; the CLI and the SDK run unchanged.
//   CCR_FAKE_SCENARIO = JSON { seed?: [connectionreference rows to create first], refuse?: { status, message } }
//     refuse answers every POST to connectionreferences with that status and a Dataverse error body, e.g.
//     { "error": { "code": "0x80040203", "message": "<message>" } }
const path = require('node:path');
const http = require(path.join(__dirname, '..', '..', 'lib', 'sdk-http-client.js'));
const { createConfigOrg } = require(path.join(__dirname, 'fake-config-org.js'));

const scenario = JSON.parse(process.env.CCR_FAKE_SCENARIO || '{}');
const org = createConfigOrg({ solution: { uniqueName: 'ContosoSol', version: '1.0.0.0', prefix: 'contoso' } });
const ready = (async () => {
  for (const row of scenario.seed || []) {
    await org.request({ url: `${org.origin}/api/data/v9.2/connectionreferences`, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(row) });
  }
})();

const realCreate = http.createAzHttpClient;
http.createAzHttpClient = (env, deps = {}) => realCreate(env, {
  ...deps,
  getToken: () => 'test-token-0123456789abcdef',
  sleep: async () => {},
  request: async (req) => {
    await ready;
    const where = new URL(req.url).pathname.replace(/^\/api\/data\/v9\.\d/, '');
    if (scenario.refuse && String(req.method).toUpperCase() === 'POST' && where === '/connectionreferences') {
      return { statusCode: scenario.refuse.status, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: { code: '0x80040203', message: scenario.refuse.message } }) };
    }
    return org.request(req);
  },
});
