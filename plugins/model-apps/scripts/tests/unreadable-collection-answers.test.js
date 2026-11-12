'use strict';
// An answer to a read of a COLLECTION that is not a collection is a failed read — never an empty list.
//
// The bundled SDK's `findTables()` takes a 2xx answer with no `value` list for "no tables": `body.value ?? []`. The HTTP client keeps a body that is not JSON as the text it is,
// so a sign-in page, a proxy's error page, `{}` and `null` all read as an environment with no table at all — and `list-tables.js --exact` then reports every searched table as
// `missing`, which the planner reads as "create it". The bundle is vendored and cannot change, so the script holds the answer to its shape itself (lib/collection-answers.js, at the
// HTTP client the SDK is given): a 2xx answer to the table-list read that is no `{ value: [...] }` fails with TABLES_UNREADABLE, and `{ "value": [] }` stays an empty answer.
//
// The two other scripts that read a collection through the SDK were probed with the same bodies and do not have the hole — `apps.js list` (lib/app-components.js collectionRows) and
// `list-languages.js` (the SDK's own strict reader) — and are pinned here so that neither can open it.
//
// All of it runs the REAL client, the REAL bundle and the REAL script over the fake Dataverse of helpers/fake-apps-org.js.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const { createFakeAppsOrg } = require('./helpers/fake-apps-org.js');
const { readTables } = require('../list-tables.js');
const { listApps } = require('../apps.js');
const { readLanguages } = require('../list-languages.js');

const ORIGIN = 'https://contoso.crm.dynamics.com';
const TABLE_READ = /^\/EntityDefinitions\?/;
const t = (logicalName, schemaName, displayName, isCustom = false) => ({ logicalName, schemaName, displayName, isCustom, entitySetName: `${logicalName}s` });
const TABLES = [t('account', 'Account', 'Account'), t('contact', 'Contact', 'Contact'), t('cr_ticket', 'cr_Ticket', 'Support Ticket', true)];

const client = (org) => createAzHttpClient(ORIGIN, { getToken: () => 'test-token', request: org.request, sleep: async () => {} });
// A transport answer (`{ statusCode, headers, body }`, the body as the text it arrived as), for the reads of one kind.
const answer = (statusCode, body, contentType = 'application/json') => ({ statusCode, headers: { 'content-type': contentType }, body });
const only = (reads, response) => (req) => (reads.test(req.path) ? response : undefined);

// What a 2xx answer can be besides a collection: a page that stands in for the API, an empty or JSON-null body, and a `value` that is no list.
const NOT_A_COLLECTION = {
  'no value ({})': answer(200, '{}'),
  'JSON null': answer(200, 'null'),
  'a sign-in page (HTML)': answer(200, '<html><body>Sign in to your account</body></html>', 'text/html'),
  'text that is not JSON': answer(200, 'Service Unavailable', 'text/plain'),
  'an empty body': answer(200, ''),
  'value: null': answer(200, '{"value":null}'),
  'value: an object': answer(200, '{"value":{}}'),
  'value: text': answer(200, '{"value":"nope"}'),
  'a top-level array': answer(200, '[]'),
};

// --- the table list --------------------------------------------------------------------------------------------------------------

test('REAL BUNDLE: a genuine empty collection stays an empty answer — no table, and every searched one missing (the control for the failures below)', async () => {
  const empty = createFakeAppsOrg({ answer: only(TABLE_READ, answer(200, '{"value":[]}')) });
  const all = await readTables(ORIGIN, {}, client(empty));
  assert.deepStrictEqual([all.ok, all.count, all.tables], [true, 0, []]);
  const exact = await readTables(ORIGIN, { terms: ['account', 'cr_ticket'], exact: true }, client(empty));
  assert.deepStrictEqual([exact.ok, exact.count, exact.missing], [true, 0, ['account', 'cr_ticket']]);
  const typed = await readTables(ORIGIN, { type: 'custom' }, client(empty));
  assert.deepStrictEqual([typed.ok, typed.count], [true, 0]);
  // And the same collection with rows in it is answered as before, so the check looks at the shape and never at what the rows say.
  const full = await readTables(ORIGIN, { terms: ['account', 'cr_ticket', 'incident'], exact: true }, client(createFakeAppsOrg({ tables: TABLES })));
  assert.deepStrictEqual([full.count, full.missing], [2, ['incident']]);
});

const MODES = {
  'every table': {},
  'a search': { terms: ['account'] },
  'an exact search': { terms: ['account', 'cr_ticket'], exact: true },
  'the custom tables': { type: 'custom' },
};

for (const [shape, response] of Object.entries(NOT_A_COLLECTION)) {
  test(`REAL BUNDLE: a 200 answer to the table read that is ${shape} fails TABLES_UNREADABLE in every mode — never an empty list or a "missing" table`, async () => {
    for (const [mode, args] of Object.entries(MODES)) {
      const org = createFakeAppsOrg({ tables: TABLES, answer: only(TABLE_READ, response) });
      await assert.rejects(readTables(ORIGIN, args, client(org)), (err) => {
        assert.strictEqual(err.code, 'TABLES_UNREADABLE', `${mode}: ${err.message}`);
        assert.match(err.message, /not a list of tables/, mode);
        assert.match(err.message, /not an empty environment/, `${mode}: it says what the failure is not`);
        assert.doesNotMatch(err.message, /Transport failure|reaching/, `${mode}: the SDK's wrapper is not the message`);
        assert.ok(!err.message.includes('Sign in to your account') && !err.message.includes('Service Unavailable'), `${mode}: what the platform sent is not echoed`);
        return true;
      }, mode);
      assert.strictEqual(org.unexpected.length, 0, mode);
    }
  });
}

test('REAL BUNDLE: only a 2xx answer is held to the shape — a refusal, a redirect, a 304 and a 400 stay the SDK\u2019s own failures, with the platform\u2019s status', async () => {
  for (const [status, response] of [
    [403, answer(403, '{"error":{"message":"The user is not a member of the organization."}}')],
    [400, answer(400, '{"error":{"message":"bad request"}}')],
    [404, answer(404, '{"error":{"message":"not found"}}')],
    [301, { statusCode: 301, headers: { location: `${ORIGIN}/elsewhere` }, body: '' }],
    [304, { statusCode: 304, headers: {}, body: '' }],
    [400, answer(400, '<html>Bad Request</html>', 'text/html')],
  ]) {
    await assert.rejects(readTables(ORIGIN, { terms: ['account'] }, client(createFakeAppsOrg({ tables: TABLES, answer: () => response }))), (err) => {
      assert.strictEqual(err.code, 'CONNECTION_ERROR', String(status));
      assert.strictEqual(err.statusCode, status, String(status));
      assert.match(err.message, new RegExp(`^HTTP ${status} from .*/EntityDefinitions`), String(status));
      return true;
    }, String(status));
  }
});

// --- end to end: the real script in a real process -------------------------------------------------------------------------------

const PRELOAD = path.resolve(__dirname, 'helpers', 'fake-raw-answer-preload.js');
const SCRIPT = path.resolve(__dirname, '..', 'list-tables.js');
const runScript = (argv, rawAnswer) => spawnSync(process.execPath, ['--require', PRELOAD, SCRIPT, ...argv], {
  env: { ...process.env, FAKE_RAW_ANSWER: JSON.stringify({ read: '^/EntityDefinitions\\?', tables: TABLES, ...rawAnswer }) },
  encoding: 'utf8',
  timeout: 120000,
});
const lines = (r) => r.stdout.split(/\r?\n/).filter(Boolean);

test('END TO END: a sign-in page where the table list should be is one { ok: false, code } line and exit 1 — no tables, no missing — with the reason on stderr', () => {
  for (const [name, rawAnswer] of [
    ['a sign-in page', { status: 200, contentType: 'text/html', body: '<html><body>Sign in to your account</body></html>' }],
    ['an empty object', { status: 200, body: '{}' }],
    ['JSON null', { status: 200, body: 'null' }],
  ]) {
    for (const argv of [['--env', ORIGIN, '--search', 'account,cr_candidate', '--exact'], ['--env', ORIGIN, '--search', 'account'], ['--env', ORIGIN]]) {
      const r = runScript(argv, rawAnswer);
      assert.strictEqual(r.status, 1, `${name} ${argv.join(' ')}: ${r.stdout}`);
      assert.strictEqual(lines(r).length, 1, 'one line');
      const result = JSON.parse(lines(r)[0]);
      assert.deepStrictEqual(Object.keys(result).sort(), ['code', 'error', 'ok'], `${name}: no tables, count or missing`);
      assert.deepStrictEqual([result.ok, result.code], [false, 'TABLES_UNREADABLE']);
      assert.match(result.error, /not a list of tables/);
      assert.ok(r.stderr.includes(result.error), 'the reason is on stderr as well');
      assert.ok(!r.stdout.includes('Sign in to your account'), 'what the platform sent is not printed');
    }
  }
});

test('END TO END: an empty collection is still exit 0 — the searched tables are `missing`; and a real list is read as before', () => {
  const empty = runScript(['--env', ORIGIN, '--search', 'account', '--exact'], { status: 200, body: '{"value":[]}' });
  assert.strictEqual(empty.status, 0, empty.stderr);
  assert.deepStrictEqual(JSON.parse(lines(empty)[0]), { ok: true, search: ['account'], exact: true, count: 0, tables: [], missing: ['account'] });
  const full = runScript(['--env', ORIGIN, '--search', 'account,incident', '--exact'], { read: '^/nothing-matches-this$' });
  assert.strictEqual(full.status, 0, full.stderr);
  const result = JSON.parse(lines(full)[0]);
  assert.deepStrictEqual([result.tables.map((x) => x.logicalName), result.missing], [['account'], ['incident']]);
});

// --- the two scripts that were probed and are not affected: pinned -------------------------------------------------------------------

const APPS_SAVED = /^\/appmodules\/Microsoft\.Dynamics\.CRM\.RetrieveUnpublishedMultiple\(\)\?\$select=appmoduleid,name/;
const APPS_PUBLISHED = /^\/appmodules\?\$select=appmoduleid$/;
const SALES = { appmoduleid: '11111111-1111-4111-8111-111111111111', name: 'Sales', uniquename: 'sales', componentstate: 0, published: true };

test('REAL BUNDLE: apps.js list fails on an answer that is no list — in either layer it reads — and an empty collection is an empty list', async () => {
  for (const [layer, reads] of [['saved', APPS_SAVED], ['published', APPS_PUBLISHED]]) {
    for (const [shape, response] of Object.entries(NOT_A_COLLECTION)) {
      await assert.rejects(listApps(ORIGIN, {}, client(createFakeAppsOrg({ apps: [SALES], answer: only(reads, response) }))), (err) => {
        assert.strictEqual(err.code, 'CONNECTION_ERROR', `${layer} / ${shape}`);
        assert.match(err.message, /: no readable result set$/, `${layer} / ${shape}`);
        return true;
      }, `${layer} / ${shape}`);
    }
  }
  const empty = await listApps(ORIGIN, {}, client(createFakeAppsOrg({ answer: () => answer(200, '{"value":[]}') })));
  assert.deepStrictEqual([empty.ok, empty.count, empty.apps], [true, 0, []]);
});

// The three reads of getEnvironmentLanguages(), each answered as the platform does unless a test says otherwise.
const LANGUAGE_READS = {
  organization: [/^\/organizations\?\$select=languagecode$/, '{"value":[{"languagecode":1033,"organizationid":"00000000-0000-0000-0000-000000000001"}]}'],
  provisioned: [/^\/RetrieveProvisionedLanguages\(\)$/, '{"RetrieveProvisionedLanguages":[1033]}'],
  available: [/^\/RetrieveAvailableLanguages\(\)$/, '{"LocaleIds":[1033]}'],
};
const languagesOrg = (broken, response) => createFakeAppsOrg({
  answer: (req) => {
    for (const [name, [reads, body]] of Object.entries(LANGUAGE_READS)) if (reads.test(req.path)) return name === broken ? response : answer(200, body);
    return undefined;
  },
});

test('REAL BUNDLE: list-languages.js fails ENVIRONMENT_LANGUAGES_UNREADABLE on an answer that is no list, in each of its three reads — never an English default', async () => {
  const ok = await readLanguages(ORIGIN, client(languagesOrg(null, null)));
  assert.deepStrictEqual(ok.languages.map((l) => l.lcid), [1033], 'the premise: the three reads, answered as the platform does, are read');
  for (const read of Object.keys(LANGUAGE_READS)) {
    for (const [shape, response] of Object.entries({ ...NOT_A_COLLECTION, 'value: an empty list': answer(200, '{"value":[]}') })) {
      await assert.rejects(readLanguages(ORIGIN, client(languagesOrg(read, response))), (err) => {
        assert.strictEqual(err.code, 'ENVIRONMENT_LANGUAGES_UNREADABLE', `${read} / ${shape}: ${err.message}`);
        return true;
      }, `${read} / ${shape}`);
    }
  }
});
