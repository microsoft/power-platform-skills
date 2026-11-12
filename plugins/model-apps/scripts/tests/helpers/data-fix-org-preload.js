'use strict';
// A `node --require` preload for END-TO-END runs of scripts/data-fix.js: the REAL CLI, the plugin's REAL az-token
// HttpClient and the REAL vendored SDK talk to the fake of helpers/data-fix-org.js — no token is read and no network
// is used — so a test sees exactly what the maker would see printed, and the exit code.
//
// FAKE_DATA_FIX_ORG names a JSON file holding `org.snapshot()` (the rows, their version counter, the identity), plus
//   { "batchAnswer": { "statusCode": 403, "body": "…" } }   every `$batch` is answered that instead (the rows are
//                                                            untouched: the service refused the whole request)
// The file is rewritten with the fake's rows as the process exits, so the next verb's child sees what this one wrote.
const fs = require('node:fs');
const path = require('node:path');
const client = require(path.resolve(__dirname, '..', '..', 'lib', 'sdk-http-client.js'));
const { createDataFixOrg } = require('./data-fix-org.js');

const file = process.env.FAKE_DATA_FIX_ORG;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const org = createDataFixOrg({ seed: state });
if (state.batchAnswer) {
  org.onBatch = async () => ({ headers: { 'content-type': 'application/json' }, ...state.batchAnswer });
}

const real = client.createAzHttpClient;
// data-fix.js destructures `createAzHttpClient` when it is loaded, which is after this preload, so replacing the export
// here is what it receives.
client.createAzHttpClient = (origin) => real(origin, { getToken: () => 'x'.repeat(48), request: org.request, sleep: async () => {} });

process.on('exit', () => {
  fs.writeFileSync(file, JSON.stringify({ ...state, ...org.snapshot() }));
});
