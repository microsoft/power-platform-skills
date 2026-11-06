'use strict';
// A `node --require` preload for END-TO-END runs of scripts/list-languages.js. It swaps the az-token HTTP client for a
// fake Dataverse that answers the three reads the SDK's `getEnvironmentLanguages()` makes, so a real child process runs
// the real script, the real bundle, the real culture table and the real `emitResult` — with no Azure CLI and no network.
//
// The fake org comes from the environment variable FAKE_ORG_LANGUAGES, a JSON object:
//   { "base": 1033, "provisioned": [1033, 1025], "available": [1033, 1025] }   the three answers, as the SDK measured them
//   { "refuse": { "status": 403, "message": "…" } }                            the organization read answers that instead
//
// Measured shapes (see list-languages-real-bundle.test.js for the same three):
//   GET organizations?$select=languagecode   -> { value: [ { languagecode: <LCID> } ] }
//   GET RetrieveProvisionedLanguages()       -> { RetrieveProvisionedLanguages: [<LCID>, ...] }
//   GET RetrieveAvailableLanguages()         -> { LocaleIds: [<LCID>, ...] }
const path = require('node:path');

const client = require(path.resolve(__dirname, '..', '..', 'lib', 'sdk-http-client.js'));
const org = JSON.parse(process.env.FAKE_ORG_LANGUAGES || '{}');

const answer = (status, body) => ({ status, headers: { 'content-type': 'application/json' }, body });
const refused = () => { throw new Error('this fake org answers only the three language reads'); };

// The script destructures `createAzHttpClient` when it is loaded, which is after this preload, so replacing the export
// here is what it receives.
client.createAzHttpClient = () => ({
  get: async (url) => {
    const where = decodeURIComponent(String(url));
    if (/\/organizations\?\$select=languagecode$/.test(where)) {
      if (org.refuse) return answer(org.refuse.status, { error: { message: org.refuse.message } });
      return answer(200, { value: [{ languagecode: org.base }] });
    }
    if (/\/RetrieveProvisionedLanguages\(\)$/.test(where)) return answer(200, { RetrieveProvisionedLanguages: org.provisioned });
    if (/\/RetrieveAvailableLanguages\(\)$/.test(where)) return answer(200, { LocaleIds: org.available });
    throw new Error(`unexpected request: GET ${where}`);
  },
  post: refused,
  patch: refused,
  put: refused,
  delete: refused,
});
