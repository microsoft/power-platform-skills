'use strict';
// A `node --require` preload for END-TO-END runs of scripts/list-tables.js with ONE read answered by a body the platform does not send. It gives the plugin's REAL az-token HttpClient the
// fake Dataverse of helpers/fake-apps-org.js (no token is read and no network is used), like helpers/fake-apps-org-preload.js — which can refuse a read, but cannot say what a sign-in page
// or a proxy says when it stands in for the API: a 2xx status and a body that is no JSON list.
//
// The answer comes from the environment variable FAKE_RAW_ANSWER, a JSON object:
//   { "read": "^/EntityDefinitions\\?", "status": 200, "contentType": "text/html", "body": "<html>…</html>", "tables": [ … ] }
//   read         a regular expression matched against the request's path below the API root; the requests it fits get the answer below, the others are answered by the fake as usual
//   status       the answer's HTTP status (default 200)
//   contentType  its Content-Type (default application/json)
//   body         its body, as the text it arrives as
//   tables       the fake's `tables` option (createFakeAppsOrg)
const path = require('node:path');
const client = require(path.resolve(__dirname, '..', '..', 'lib', 'sdk-http-client.js'));
const { createFakeAppsOrg } = require('./fake-apps-org.js');

const { read, status = 200, contentType = 'application/json', body = '', tables } = JSON.parse(process.env.FAKE_RAW_ANSWER || '{}');
const pattern = new RegExp(read || '(?!)');
const org = createFakeAppsOrg({
  tables,
  answer: (req) => (pattern.test(req.path) ? { statusCode: status, headers: { 'content-type': contentType }, body } : undefined),
});

const real = client.createAzHttpClient;
// The script destructures `createAzHttpClient` when it is loaded, which is after this preload, so replacing the export here is what it receives.
client.createAzHttpClient = (origin) => real(origin, { getToken: () => 'test-token', request: org.request, sleep: async () => {} });
