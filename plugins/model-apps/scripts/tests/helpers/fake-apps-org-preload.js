'use strict';
// A `node --require` preload for END-TO-END runs of scripts/apps.js and scripts/list-tables.js. It gives the plugin's REAL az-token HttpClient a
// fake Dataverse (helpers/fake-apps-org.js) to talk to — no token is read and no network is used — so a real child process runs the real script,
// the real client, the real bundle and the real `emitResult`, and the test sees what the platform was sent.
//
// The fake comes from the environment variable FAKE_APPS_ORG, a JSON object of createFakeAppsOrg's options (pages, apps, solutions, sitemaps,
// tables, baseLanguage), plus
//   { "refuse": { "status": 403, "message": "…" } }     every request is answered that instead
//   { "refuseWhen": [ { "method": "POST", "path": "AddSolutionComponent", "nth": 2, "status": 400, "message": "…" } ] }
//                                                       the requests whose method (if given) and path (a regular expression, matched anywhere in it)
//                                                       fit a rule are answered that instead — with `nth`, only the nth such request; the others as usual
// When FAKE_APPS_ORG_LOG names a file, the requests the run made are written there, as JSON, as the process exits.
const fs = require('node:fs');
const path = require('node:path');
const client = require(path.resolve(__dirname, '..', '..', 'lib', 'sdk-http-client.js'));
const { createFakeAppsOrg, json } = require('./fake-apps-org.js');

const { refuse, refuseWhen = [], ...options } = JSON.parse(process.env.FAKE_APPS_ORG || '{}');
const rules = refuseWhen.map((rule) => ({ ...rule, pattern: new RegExp(rule.path), seen: 0 }));
const answer = (req) => {
  if (refuse) return json(refuse.status, { error: { message: refuse.message } });
  for (const rule of rules) {
    if ((rule.method && rule.method !== req.method) || !rule.pattern.test(req.path)) continue;
    rule.seen += 1;
    if (!rule.nth || rule.nth === rule.seen) return json(rule.status, { error: { message: rule.message } });
  }
  return undefined;
};
const org = createFakeAppsOrg({ ...options, answer });

const real = client.createAzHttpClient;
// The script destructures `createAzHttpClient` when it is loaded, which is after this preload, so replacing the export here is what it receives.
client.createAzHttpClient = (origin) => real(origin, { getToken: () => 'test-token', request: org.request, sleep: async () => {} });

if (process.env.FAKE_APPS_ORG_LOG) {
  process.on('exit', () => {
    fs.writeFileSync(process.env.FAKE_APPS_ORG_LOG, JSON.stringify(org.requests.map(({ method, path: p, body }) => ({ method, path: p, body }))));
  });
}
