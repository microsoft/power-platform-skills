'use strict';
// The lag of a table the build has just created (lib/entity-provision.js, "The lag of a table this attempt just created").
//
// Right after a table is created, a create of one of its columns — in the change set, or on its own — or the insert of one of its status reasons is
// intermittently refused with HTTP 400 and a generic code (`0x80040216` "An unexpected error occurred.", `0x80090457` "Component of type Entity …
// does not exist."), and a re-run succeeds. These tests drive the data-model phase (provisionDataModel) over the REAL vendored SDK, the plugin's own
// HTTP client and the strict stateful fake of helpers/fake-lifecycle-org.js, with a seam in front of the fake's transport that answers the requests a
// test names — the request-level fault a live check injects — so the environment holds exactly what it would after a real refusal. The clock, the
// waits and the jitter are the phase's seams: a wait records its length and moves the clock, and nothing sleeps.
//
// What is held: a refused create is sent again only after a read PROVES it absent, within the table's budget (20 s of the time the check itself
// waits, 8 reads, 4 resends of one create, 1 of the change set); a create the read shows is adopted; a read that proves nothing is read again; a
// budget spent stops the build with the original refusal and a halt that says the build may be run again — said only by the halt, never by the
// error the step reports; and nothing changes for a table that existed, for the other refusals, or for a build the lag never touches.
const { test } = require('node:test');
const assert = require('node:assert');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createLifecycleOrg } = require('./helpers/fake-lifecycle-org.js');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../lib/maker-sdk.js');
const { makeRunner, provisionDataModel, provisionSolution, BuildHalt } = require('../lib/entity-provision.js');
const { serviceCodeOf, retryPolicyFor } = require('../lib/retry-policy.js');
const { isTransientHalt } = require('../build-model-app.js');
const { appFolder, command, settle } = require('./helpers/build-command-harness.js');

const SOLUTION = 'ContosoLag';
// A token long enough for the client's scrubber, never sent anywhere: the transport is the fake.
const TOKEN = 'post-create-lag-token-0123456789';
const SUFFIX = ' — the refusal persisted after the bounded check. The table was created. Run the build again to reconcile what is already there; a refusal that is not lag will persist';
const UNEXPECTED = 'An unexpected error occurred.';
const NOT_THERE = 'Component of type Entity with name  and id 00000000-0000-4000-8000-000000000000 does not exist.';

// --- the platform's answers ------------------------------------------------------------------------------------------------------------------------------
// A refusal is an OData error:  HTTP 400  { "error": { "code": "0x80040216", "message": "An unexpected error occurred." } }
// See: https://learn.microsoft.com/power-apps/developer/data-platform/webapi/compose-http-requests-handle-errors#parse-errors-from-the-response
const odata = (statusCode, error) => ({ statusCode, headers: { 'content-type': 'application/json; odata.metadata=minimal' }, body: JSON.stringify({ error }) });
const refused = (code = '0x80040216', message = UNEXPECTED) => odata(400, { code, message });
// A change set refused as a whole: HTTP 400, and the refusal in the part of the operation that failed (the first, here).
// See: https://learn.microsoft.com/power-apps/developer/data-platform/webapi/execute-batch-operations-using-web-api#handling-errors
const batchRefused = (error) => ({
  statusCode: 400,
  headers: { 'content-type': 'multipart/mixed; boundary=batchresponse_lag' },
  body: ['--batchresponse_lag', 'Content-Type: multipart/mixed; boundary=changesetresponse_lag', '',
    '--changesetresponse_lag', 'Content-Type: application/http', 'Content-Transfer-Encoding: binary', 'Content-ID: 1', '',
    'HTTP/1.1 400 Bad Request', 'OData-Version: 4.0', 'Content-Type: application/json; odata.metadata=minimal', '',
    JSON.stringify({ error }), '--changesetresponse_lag--', '--batchresponse_lag--', ''].join('\r\n'),
});
const list = (value) => ({ statusCode: 200, headers: { 'content-type': 'application/json; odata.metadata=minimal' }, body: JSON.stringify({ value }) });

// --- what the build sends --------------------------------------------------------------------------------------------------------------------------------
const PROBE = /^\/EntityDefinitions\([0-9a-f-]{36}\)\/Attributes\?\$select=MetadataId,LogicalName$/;
const STATUS_READ = /^\/EntityDefinitions\([0-9a-f-]{36}\)\/Attributes\/Microsoft\.Dynamics\.CRM\.StatusAttributeMetadata\?/;
const columnPost = (table, column) => (where, req) => where === `/EntityDefinitions(LogicalName='${table}')/Attributes` && JSON.parse(req.body).SchemaName === column;
const isBatch = (where) => where === '/$batch';
const isInsert = (where) => where === '/InsertStatusValue';
const isProbe = (where) => PROBE.test(where);

// One fake environment, with the solution made, and a seam in front of its transport: `fault(method, matches, answer)` answers what `answer(req, n)`
// returns for the n-th request it matches, and lets the request through to the fake when it returns nothing. `wire` is every request, in order.
async function lagEnv() {
  const org = createLifecycleOrg();
  const wire = [];
  const faults = [];
  const request = async (req) => {
    const url = new URL(req.url);
    const where = decodeURIComponent(url.pathname + url.search).replace(/^\/api\/data\/v9\.\d/, '');
    const entry = { method: req.method, path: where, body: req.body };
    wire.push(entry);
    for (const f of faults) {
      if (f.method !== req.method || !f.matches(where, req)) continue;
      f.hits += 1;
      const answer = await f.answer(req, f.hits);
      if (answer) { entry.faulted = true; return answer; }
    }
    return org.request(req);
  };
  const fault = (method, matches, answer) => {
    const f = { method, matches, answer, hits: 0 };
    faults.push(f);
    return { lift: () => faults.splice(faults.indexOf(f), 1), hits: () => f.hits };
  };
  const client = createAzHttpClient(org.origin, { getToken: () => TOKEN, request, sleep: async () => {} });
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(makeTempDir('post-create-lag-')), instanceUrl: org.origin, httpClient: client, solutionUniqueName: SOLUTION });
  await sdk.initWorkspace();
  await provisionSolution({ sdk, provision: sdk, runner: makeRunner({ emit: () => {}, total: 1 }), solution: { uniqueName: SOLUTION, publisherPrefix: 'contoso' } });
  // What a request answered by the fake itself does to the environment: a create that "committed and then failed" goes through, then fails.
  const through = (req) => org.request(req);
  return { org, wire, fault, sdk, through };
}

// The clock the phase is given: a wait records its length and moves the clock; `advance` is a read that takes time.
function clock() {
  let t = 1000000;
  const waits = [];
  return { now: () => t, sleep: async (ms) => { waits.push(ms); t += ms; }, advance: (ms) => { t += ms; }, waits };
}

const ticket = ({ columns = [{ schemaName: 'contoso_title', displayName: 'Title', type: 'Text' }, { schemaName: 'contoso_code', displayName: 'Code', type: 'Text' }], statusReasons, alternateKeys } = {}) => ({
  schemaName: 'contoso_ticket', displayName: 'Ticket', pluralName: 'Tickets', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns,
  ...(statusReasons ? { statusReasons } : {}), ...(alternateKeys ? { alternateKeys } : {}),
});
const lagSpec = (entities = [ticket()], relationships = []) => ({ solution: { uniqueName: SOLUTION, publisherPrefix: 'contoso' }, app: { name: 'Lag' }, relationships, entities });

// Runs the data-model phase once. Answers what it returned or threw, its events and warnings, the clock, and the requests it sent.
async function phase(env, spec, { clk = clock(), inlineColumns } = {}) {
  const events = [];
  const warnings = [];
  const mark = env.wire.length;
  let result = null;
  let error = null;
  try {
    result = await provisionDataModel({
      sdk: env.sdk, provision: env.sdk, runner: makeRunner({ emit: (e) => events.push(e), total: 99 }), spec, apply: true, preResolvedLanguageCode: 1033,
      provisionedLanguages: async () => [1033, 3082], sleep: clk.sleep, now: clk.now, random: () => 0, warn: (m) => warnings.push(String(m)),
      ...(inlineColumns === false ? { inlineColumns: false } : {}),
    });
  } catch (e) { error = e; }
  return { result, error, events, warnings, clk, wire: env.wire.slice(mark) };
}

const posts = (run, matches) => run.wire.filter((r) => r.method === 'POST' && matches(r.path, r));
const probes = (run) => run.wire.filter((r) => r.method === 'GET' && isProbe(r.path));
const steps = (run, prefix) => run.events.filter((e) => e.status !== 'start' && e.label.startsWith(prefix));
const lagWarnings = (run) => run.warnings.filter((w) => /was refused just after the table was created/.test(w));
const columnIds = (env, table) => {
  const t = [...env.org.metadata.tables.values()].find((x) => x.LogicalName === table);
  return Object.fromEntries((t ? [...t.Attributes.values()] : []).map((a) => [a.LogicalName, a.MetadataId]));
};
// The halt is the runner's, around the failure the step threw; its message is the step's failure and, for a refusal the check ran out on, more.
const haltOf = (run) => { assert.ok(run.error instanceof BuildHalt, `the phase halts: ${run.error && run.error.stack}`); return run.error; };

// --- the change set ---------------------------------------------------------------------------------------------------------------------------------------

test('a change set refused with the lag of its new table is sent again once, after a read proves its columns absent — and its columns are the ones that read and the commit give', async () => {
  const env = await lagEnv();
  env.fault('POST', isBatch, (req, n) => (n === 1 ? batchRefused({ code: '0x80040216', message: UNEXPECTED }) : undefined));
  const run = await phase(env, lagSpec());
  assert.ifError(run.error);
  const batches = posts(run, isBatch);
  assert.strictEqual(batches.length, 2, 'the change set is sent again, once');
  const between = run.wire.slice(run.wire.indexOf(batches[0]) + 1, run.wire.indexOf(batches[1]));
  assert.deepStrictEqual(between.map((r) => `${r.method} ${isProbe(r.path) ? 'probe' : r.path}`), ['GET probe'], 'one read between them, and nothing else');
  assert.deepStrictEqual(run.clk.waits, [1000], 'one wait before the resend');
  assert.deepStrictEqual(posts(run, columnPost('contoso_ticket', 'contoso_title')).length, 0, 'no column is sent on its own');
  assert.deepStrictEqual(steps(run, 'column contoso_ticket.').map((e) => e.status), ['ok', 'ok']);
  const ids = columnIds(env, 'contoso_ticket');
  assert.deepStrictEqual(run.result.columns.contoso_ticket.map((c) => [c.logicalName, c.metadataId]), [['contoso_title', ids.contoso_title], ['contoso_code', ids.contoso_code]]);
  assert.deepStrictEqual(lagWarnings(run), ['creating the 2 ordinary column(s) of table contoso_ticket in one request was refused just after the table was created (HTTP 400 0x80040216) — checking whether it exists before a bounded retry']);
});

test('the code of a refused change set is read from its first part: a part that names no code does not qualify, whatever its words quote', async () => {
  // Control: the code in the part qualifies (the check reads, and sends the change set again).
  const qualified = await lagEnv();
  qualified.fault('POST', isBatch, (req, n) => (n === 1 ? batchRefused({ code: '0x80040216', message: UNEXPECTED }) : undefined));
  const one = await phase(qualified, lagSpec());
  assert.ifError(one.error);
  assert.strictEqual(posts(one, isBatch).length, 2);
  // The same refusal with the code taken out of the part, its message quoting it (as a display name a maker wrote could): the refusal every other
  // refused change set is — the columns go one by one, with no read of the lag kind and no resend.
  const env = await lagEnv();
  env.fault('POST', isBatch, (req, n) => (n === 1 ? batchRefused({ message: 'The column 0x80040216 Title could not be created.' }) : undefined));
  const run = await phase(env, lagSpec());
  assert.ifError(run.error);
  assert.strictEqual(posts(run, isBatch).length, 1, 'not sent again');
  assert.deepStrictEqual(probes(run).length, 0, 'no read');
  assert.strictEqual(posts(run, columnPost('contoso_ticket', 'contoso_title')).length, 1, 'created on its own, as any refused change set is');
  assert.deepStrictEqual(lagWarnings(run), []);
  assert.ok(run.warnings.some((w) => /could not create the 2 ordinary column\(s\) of table contoso_ticket in one request .* — creating them one by one/.test(w)), JSON.stringify(run.warnings));
});

test('a change set refused with the lag whose reads never prove anything stops the build at the end of its budget — no column is sent on its own, the first missing one stops it, and the halt says the build may be run again', async () => {
  const env = await lagEnv();
  env.fault('POST', isBatch, () => batchRefused({ code: '0x80040216', message: UNEXPECTED }));
  // Every read answers that the table is not there yet; one of them takes time of its own (a slow answer), with no wait around it.
  const clk = clock();
  env.fault('GET', isProbe, (req, n) => { if (n === 2) clk.advance(3000); return odata(404, { code: '0x80060888', message: 'Resource not found for the segment.' }); });
  const run = await phase(env, lagSpec(), { clk });
  const halt = haltOf(run);
  assert.strictEqual(posts(run, isBatch).length, 1, 'the change set is not sent again');
  assert.strictEqual(posts(run, (w) => /\/Attributes$/.test(w)).length, 0, 'and no column is sent on its own');
  assert.deepStrictEqual(steps(run, 'column contoso_ticket.').map((e) => `${e.label} ${e.status}`), ['column contoso_ticket.contoso_title (Text) error'], 'the first column the check did not confirm stops the phase');
  assert.ok(halt.message.endsWith(SUFFIX), halt.message);
  assert.strictEqual(halt.retry, 'never', 'a 400 is final: the build does not run again by itself');
  assert.ok(run.clk.now() - 1000000 >= 20000 - 8000, 'the budget was spent');
});

test('a read that shows some columns and not the table\'s own name column proves nothing of the others: none of them is sent until a read proves it absent — and only while the budget has room', async () => {
  const A = 'contoso_title';
  const B = 'contoso_code';
  const someId = '11111111-2222-4333-8444-555555555555';
  // A read with A and nothing else: no proof about B.
  const onlyA = list([{ LogicalName: A, MetadataId: someId }]);
  // (1) That read until the budget is spent: A is adopted, B is never sent, and the build stops at B.
  {
    const env = await lagEnv();
    env.fault('POST', isBatch, () => batchRefused({ code: '0x80040216', message: UNEXPECTED }));
    env.fault('GET', isProbe, () => onlyA);
    const run = await phase(env, lagSpec());
    const halt = haltOf(run);
    assert.strictEqual(posts(run, columnPost('contoso_ticket', B)).length, 0, 'B is never sent while nothing proves it absent');
    assert.strictEqual(posts(run, isBatch).length, 1);
    assert.deepStrictEqual(steps(run, 'column contoso_ticket.').map((e) => `${e.label} ${e.status}`), ['column contoso_ticket.contoso_title (Text) ok', 'column contoso_ticket.contoso_code (Text) error']);
    assert.ok(halt.message.endsWith(SUFFIX));
  }
  // (2) A later read that holds the name column and not B proves B absent: B is sent once, A is not sent.
  {
    const env = await lagEnv();
    env.fault('POST', isBatch, () => batchRefused({ code: '0x80040216', message: UNEXPECTED }));
    env.fault('GET', isProbe, (req, n) => (n === 1 ? onlyA : (n === 2 ? list([{ LogicalName: A, MetadataId: someId }, { LogicalName: 'contoso_name', MetadataId: '22222222-2222-4333-8444-555555555555' }]) : undefined)));
    const run = await phase(env, lagSpec());
    assert.ifError(run.error);
    assert.strictEqual(posts(run, columnPost('contoso_ticket', B)).length, 1, 'B is sent once, once a read proves it absent');
    assert.strictEqual(posts(run, columnPost('contoso_ticket', A)).length, 0, 'A is adopted, not sent');
    assert.strictEqual(run.result.columns.contoso_ticket.find((c) => c.logicalName === A).metadataId, someId);
  }
  // (3) The first read holds the name column and A, not B: B is proved absent at once, and is the only column sent.
  {
    const env = await lagEnv();
    env.fault('POST', isBatch, () => batchRefused({ code: '0x80040216', message: UNEXPECTED }));
    env.fault('GET', isProbe, (req, n) => (n === 1 ? list([{ LogicalName: A, MetadataId: someId }, { LogicalName: 'contoso_name', MetadataId: '22222222-2222-4333-8444-555555555555' }]) : undefined));
    const run = await phase(env, lagSpec());
    assert.ifError(run.error);
    assert.deepStrictEqual(posts(run, (w) => /\/Attributes$/.test(w)).map((r) => JSON.parse(r.body).SchemaName), [B], 'only B is sent');
    assert.strictEqual(posts(run, isBatch).length, 1, 'and the change set is not sent again: part of it is there');
  }
});

test('a proof of absence that comes when the budget is spent sends nothing: not the change set again, not a column on its own — and the halt is the original refusal', async () => {
  const sentinel = { LogicalName: 'contoso_name', MetadataId: '22222222-2222-4333-8444-555555555555' };
  const A = 'contoso_title';
  const cases = [
    // The read that proves every column absent takes the rest of the time.
    ['the proof comes on the read that spends the time', (clk) => (req, n) => (n < 2 ? odata(404, { code: '0x80060888', message: 'not yet' }) : (clk.advance(20000), list([sentinel])))],
    // Eight reads that prove nothing but the last: the eighth is the last the budget has, with time left.
    ['the proof comes on the eighth read', () => (req, n) => (n < 8 ? list([]) : list([sentinel]))],
    // A found, B proved absent, on the read that spends the time.
    ['a part found and the rest proved absent on the read that spends the time', (clk) => (req, n) => (n < 2 ? odata(404, { code: '0x80060888', message: 'not yet' }) : (clk.advance(20000), list([sentinel, { LogicalName: A, MetadataId: '11111111-2222-4333-8444-555555555555' }])))],
  ];
  for (const [what, reads] of cases) {
    const env = await lagEnv();
    const clk = clock();
    // The eighth read comes before the time is spent only when the reads in between are quick: the waits are, here, short enough.
    env.fault('POST', isBatch, () => batchRefused({ code: '0x80040216', message: UNEXPECTED }));
    env.fault('GET', isProbe, reads(clk));
    const run = await phase(env, lagSpec(), { clk: what.includes('eighth') ? { ...clk, sleep: async (ms) => { clk.waits.push(ms); clk.advance(1); } } : clk });
    const halt = haltOf(run);
    assert.strictEqual(posts(run, isBatch).length, 1, `${what}: not sent again`);
    assert.strictEqual(posts(run, (w) => /\/Attributes$/.test(w)).length, 0, `${what}: no column sent on its own`);
    assert.ok(halt.message.endsWith(SUFFIX), `${what}: ${halt.message}`);
    assert.strictEqual(halt.cause.statusCode, 400, `${what}: the original refusal`);
    assert.ok(String(halt.cause.cause).includes('{"error":{"code":"0x80040216"'), `${what}: the change set's own answer, which holds the code in its first part`);
    assert.strictEqual(halt.retry, 'never', what);
    if (what.includes('part found')) {
      assert.deepStrictEqual(steps(run, 'column contoso_ticket.').map((e) => `${e.label} ${e.status}`), ['column contoso_ticket.contoso_title (Text) ok', 'column contoso_ticket.contoso_code (Text) error'], `${what}: the column found is adopted, the missing one stops the phase`);
    }
    if (what.includes('eighth')) assert.strictEqual(probes(run).length, 8, `${what}: eight reads, and no ninth`);
  }
});

// --- one column on its own -------------------------------------------------------------------------------------------------------------------------------

test('a column refused with the lag of its new table is sent again only after a read proves it absent — and its step is ok, with its id', async () => {
  const env = await lagEnv();
  const answers = [];
  const createColumn = env.sdk.createColumn.bind(env.sdk);
  env.sdk.createColumn = async (...a) => { const answer = await createColumn(...a); answers.push(answer); return answer; };
  env.fault('POST', columnPost('contoso_ticket', 'contoso_title'), (req, n) => (n === 1 ? refused('0x80040216') : undefined));
  const run = await phase(env, lagSpec(), { inlineColumns: false });
  assert.ifError(run.error);
  const sent = posts(run, columnPost('contoso_ticket', 'contoso_title'));
  assert.strictEqual(sent.length, 2, 'sent again, once');
  const between = run.wire.slice(run.wire.indexOf(sent[0]) + 1, run.wire.indexOf(sent[1]));
  assert.deepStrictEqual(between.map((r) => `${r.method} ${isProbe(r.path) ? 'probe' : r.path}`), ['GET probe'], 'after one read, and nothing else');
  assert.deepStrictEqual(steps(run, 'column contoso_ticket.contoso_title').map((e) => e.status), ['ok']);
  assert.strictEqual(answers.length, 2, 'the refused create answered nothing; the resend and the other column did');
  assert.strictEqual(run.result.columns.contoso_ticket.find((c) => c.logicalName === 'contoso_title').metadataId, answers[0].metadataId, 'the id the resend\'s create answered');
  assert.deepStrictEqual(lagWarnings(run), ['creating column contoso_ticket.contoso_title was refused just after the table was created (HTTP 400 0x80040216) — checking whether it exists before a bounded retry']);
});

test('a column the read shows after its refusal is adopted with the id the read gives — not sent again', async () => {
  const env = await lagEnv();
  // The create committed, and its answer was the refusal.
  env.fault('POST', columnPost('contoso_ticket', 'contoso_title'), async (req, n) => (n === 1 ? (await env.through(req), refused('0x80040216')) : undefined));
  const run = await phase(env, lagSpec(), { inlineColumns: false });
  assert.ifError(run.error);
  assert.strictEqual(posts(run, columnPost('contoso_ticket', 'contoso_title')).length, 1, 'not sent again');
  assert.deepStrictEqual(steps(run, 'column contoso_ticket.contoso_title').map((e) => e.status), ['ok']);
  assert.strictEqual(run.result.columns.contoso_ticket.find((c) => c.logicalName === 'contoso_title').metadataId, columnIds(env, 'contoso_ticket').contoso_title);
  assert.ok(run.warnings.includes('column contoso_ticket.contoso_title was refused (HTTP 400 0x80040216) and then found on the table, so it is reused'), JSON.stringify(run.warnings));
});

test('a different refusal of the column sent again is not sent again: it is the failure, final as any 400', async () => {
  const env = await lagEnv();
  env.fault('POST', columnPost('contoso_ticket', 'contoso_title'), (req, n) => (n === 1 ? refused('0x80040216') : refused('0x80040203', 'Invalid argument.')));
  const run = await phase(env, lagSpec(), { inlineColumns: false });
  const halt = haltOf(run);
  assert.strictEqual(posts(run, columnPost('contoso_ticket', 'contoso_title')).length, 2, 'the original, and one resend');
  assert.strictEqual(serviceCodeOf(halt.cause), '0x80040203', 'the halt is the second answer');
  assert.strictEqual(halt.retry, 'never');
  assert.ok(!halt.message.endsWith(SUFFIX), 'and it is not the refusal the check ran out on');
});

test('a column whose reads answer 404 until the budget is spent is not sent again — the halt says the build may be run again; the error the step reports does not', async () => {
  const env = await lagEnv();
  env.fault('POST', columnPost('contoso_ticket', 'contoso_title'), () => refused('0x80090457', NOT_THERE));
  env.fault('GET', isProbe, () => odata(404, { code: '0x80060888', message: 'Resource not found for the segment.' }));
  const run = await phase(env, lagSpec(), { inlineColumns: false });
  const halt = haltOf(run);
  assert.strictEqual(posts(run, columnPost('contoso_ticket', 'contoso_title')).length, 1, 'no second create');
  assert.ok(halt.message.endsWith(SUFFIX), halt.message);
  assert.ok(halt.message.includes(NOT_THERE), 'the halt quotes the refusal');
  assert.strictEqual(serviceCodeOf(halt.cause), '0x80090457', 'and carries it');
  assert.ok(!halt.cause.message.includes('persisted'), 'the SDK\'s error is as the SDK made it');
  const failed = run.events.find((e) => e.status === 'error');
  assert.ok(failed && failed.detail === halt.cause.message, 'the step reports the SDK\'s error as it is');
  assert.ok(!failed.detail.includes('persisted'), 'with nothing added');
  assert.strictEqual(halt.retry, 'never', 'the original refusal decides: a 400 is final');
  assert.strictEqual(retryPolicyFor(halt.cause), 'never');
  assert.strictEqual(isTransientHalt(halt), false);
  assert.deepStrictEqual(run.clk.waits, [1000, 2000, 4000, 8000], 'the reads were spaced, and the next wait would have run past the budget');
  assert.strictEqual(probes(run).length, 5);
});

test('a column whose reads prove it absent, refused with the lag every time, is sent again four times and then stops the build — not a skip', async () => {
  const env = await lagEnv();
  env.fault('POST', columnPost('contoso_ticket', 'contoso_title'), () => refused('0x80040216'));
  const run = await phase(env, lagSpec(), { inlineColumns: false });
  const halt = haltOf(run);
  assert.strictEqual(posts(run, columnPost('contoso_ticket', 'contoso_title')).length, 5, 'the original and four resends');
  assert.deepStrictEqual(steps(run, 'column contoso_ticket.contoso_title').map((e) => e.status), ['error'], 'an error, not a skip');
  assert.ok(halt.message.endsWith(SUFFIX));
  assert.strictEqual(halt.retry, 'never');
});

test('a read of the columns that fails — a 403, a 400 that is not the lag, a 503, a timeout of the transport — sends nothing more, and the halt is that failure', async () => {
  const cases = [
    ['a 403', () => odata(403, { code: '0x80040220', message: 'Principal user is missing prvReadEntity privilege.' }), (h) => h.cause.statusCode === 403 && h.retry === 'never'],
    ['a 400 that is not the lag', () => odata(400, { code: '0x80040203', message: 'Invalid argument.' }), (h) => h.cause.statusCode === 400 && h.retry === 'never'],
    // A 503 keeps its status, so the build's own retry runs the build again for it, as for any 503.
    ['a 503', () => ({ statusCode: 503, headers: { 'content-type': 'text/plain' }, body: 'Service Unavailable' }), (h) => h.cause.statusCode === 503 && h.retry === 'service'],
    ['a timeout of the transport', () => ({ error: 'connect ETIMEDOUT', code: 'ETIMEDOUT' }), (h) => /ETIMEDOUT/.test(h.cause.message) && h.retry === 'service'],
  ];
  for (const [what, answer, check] of cases) {
    const env = await lagEnv();
    env.fault('POST', columnPost('contoso_ticket', 'contoso_title'), () => refused('0x80040216'));
    env.fault('GET', isProbe, answer);
    const run = await phase(env, lagSpec(), { inlineColumns: false });
    const halt = haltOf(run);
    assert.strictEqual(posts(run, columnPost('contoso_ticket', 'contoso_title')).length, 1, `${what}: nothing sent again`);
    assert.notStrictEqual(serviceCodeOf(halt.cause), '0x80040216', `${what}: the halt is not the refusal`);
    assert.ok(check(halt), `${what}: ${halt.message} (${halt.retry})`);
    assert.ok(!halt.message.endsWith(SUFFIX), what);
  }
});

// --- the status reasons ------------------------------------------------------------------------------------------------------------------------------------

// The table the status reason waits for, and after it in the phase: a table whose column and key are labelled in two languages, and a relationship whose
// lookup is too — the creates a label-bearing read must not come before.
const statusSpec = (reason = { label: 'In Review', state: 'Active' }) => lagSpec([
  ticket({ statusReasons: [reason] }),
  {
    schemaName: 'contoso_task', displayName: 'Task', pluralName: 'Tasks', primaryAttribute: { schemaName: 'contoso_title', displayName: 'Title' },
    columns: [{ schemaName: 'contoso_code', displayName: { 1033: 'Code', 3082: 'Código' }, type: 'Text' }],
    alternateKeys: [{ schemaName: 'contoso_codekey', displayName: { 1033: 'Code Key', 3082: 'Clave' }, columns: ['contoso_code'] }],
  },
], [{ type: 'OneToMany', referenced: 'contoso_ticket', referencing: 'contoso_task', lookup: { schemaName: 'contoso_TicketId', displayName: { 1033: 'Ticket', 3082: 'Entrada' } } }]);

test('a status reason refused with the lag of its new table is read and inserted again only after every other labelled create of the phase', async () => {
  const env = await lagEnv();
  env.fault('POST', isInsert, (req, n) => (n === 1 ? refused('0x80090457', NOT_THERE) : undefined));
  const run = await phase(env, statusSpec());
  assert.ifError(run.error);
  const reads = run.wire.filter((r) => r.method === 'GET' && STATUS_READ.test(r.path));
  assert.strictEqual(reads.length, 1, 'one read of the status reasons');
  const inserts = posts(run, isInsert);
  const labelled = run.wire.slice(run.wire.indexOf(inserts[0]) + 1).filter((r) => r.method === 'POST' && (r.path === '/EntityDefinitions' || isBatch(r.path) || /\/(Attributes|Keys)$/.test(r.path) || r.path === '/RelationshipDefinitions'));
  assert.deepStrictEqual([...new Set(labelled.map((r) => (/\/Keys$/.test(r.path) ? 'key' : r.path === '/RelationshipDefinitions' ? 'relationship' : isBatch(r.path) ? 'columns' : r.path === '/EntityDefinitions' ? 'table' : 'column')))].sort(), ['columns', 'key', 'relationship', 'table'], 'the later labelled creates were sent after the refusal');
  assert.ok(run.wire.indexOf(reads[0]) > run.wire.indexOf(labelled[labelled.length - 1]), 'the read comes after every one of them');
  assert.ok(!run.wire.slice(0, run.wire.indexOf(labelled[labelled.length - 1])).some((r) => r.method === 'GET' && /StatusAttributeMetadata/.test(r.path)), 'and no read of the status options before them');
  assert.strictEqual(inserts.length, 2, 'the original and one insert after the read');
  assert.ok(run.wire.indexOf(inserts[1]) > run.wire.indexOf(reads[0]));
  assert.deepStrictEqual(steps(run, 'status reason contoso_ticket: In Review').map((e) => `${e.label} ${e.status}`), [
    'status reason contoso_ticket: In Review (refused just after the table was created — retrying after the other schema creates) skip',
    'status reason contoso_ticket: In Review (retried after the other schema creates) ok',
  ]);
  assert.deepStrictEqual(run.result.statusReasonValues.contoso_ticket['In Review'], { value: 100000000, stateCode: 0 });
  // The later creates kept both of their languages: the column, the key and the relationship's lookup.
  const task = [...env.org.metadata.tables.values()].find((t) => t.LogicalName === 'contoso_task');
  const languages = (component) => component.DisplayName.LocalizedLabels.map((l) => l.LanguageCode).sort();
  assert.deepStrictEqual(languages(task.Attributes.get('contoso_code')), [1033, 3082], 'the column');
  assert.deepStrictEqual(languages(task.Keys.get('contoso_codekey')), [1033, 3082], 'the key');
  assert.deepStrictEqual(languages(task.Attributes.get('contoso_ticketid')), [1033, 3082], 'the lookup');
});

test('a status reason the read shows is adopted when its value, state, label and declared colour are the spec\'s — and a declared colour that differs stops the build, with nothing inserted, adopted or changed', async () => {
  const option = (color) => ({ Value: 100000000, State: 0, Label: { LocalizedLabels: [{ Label: 'In Review', LanguageCode: 1033 }] }, Color: color });
  const stock = { Value: 1, State: 0, Label: { LocalizedLabels: [{ Label: 'Active', LanguageCode: 1033 }] }, Color: null };
  const statusList = (opt) => list([{ LogicalName: 'statuscode', OptionSet: { Options: [stock, opt] } }]);
  for (const [what, reason, held, adopted] of [
    ['the declared colour', { label: 'In Review', state: 'Active', color: '#336699' }, '#336699', true],
    ['another colour than the declared one', { label: 'In Review', state: 'Active', color: '#336699' }, '#ff0000', false],
    ['no declared colour', { label: 'In Review', state: 'Active' }, '#ff0000', true],
  ]) {
    const env = await lagEnv();
    env.fault('POST', isInsert, () => refused('0x80090457', NOT_THERE));
    env.fault('GET', (w) => STATUS_READ.test(w), () => statusList(option(held)));
    const run = await phase(env, lagSpec([ticket({ statusReasons: [reason] })]));
    assert.strictEqual(posts(run, isInsert).length, 1, `${what}: no second insert`);
    if (adopted) {
      assert.ifError(run.error);
      assert.ok(run.warnings.includes('status reason contoso_ticket: In Review was refused (HTTP 400 0x80090457) and then found, so it is reused'), `${what}: ${JSON.stringify(run.warnings)}`);
    } else {
      const halt = haltOf(run);
      assert.strictEqual(serviceCodeOf(halt.cause), '0x80090457', `${what}: the original refusal`);
      assert.ok(!halt.message.endsWith(SUFFIX), `${what}: the option there is another reason's, not a refusal that ran out`);
      assert.ok(!run.warnings.some((w) => /then found/.test(w)), `${what}: not adopted`);
    }
    assert.strictEqual(run.wire.filter((r) => ['PUT', 'PATCH', 'DELETE'].includes(r.method)).length, 0, `${what}: nothing changed`);
  }
});

// --- one budget per table ----------------------------------------------------------------------------------------------------------------------------------

test('one table\'s change set, its columns on their own and its status reasons share one budget; another table has its own; and a throttle the HTTP client waits out is not one of the check\'s resends', async () => {
  // The change set's check spends 15 seconds (three reads that prove nothing, then a proof and the resend that commits it).
  const spendOnBatch = (env) => {
    env.fault('POST', isBatch, (req, n) => (n === 1 ? batchRefused({ code: '0x80040216', message: UNEXPECTED }) : undefined));
    let reads = 0;
    env.fault('GET', isProbe, () => { reads += 1; return reads <= 3 ? odata(404, { code: '0x80060888', message: 'not yet' }) : undefined; });
  };
  const fileColumn = { schemaName: 'contoso_doc', displayName: 'Document', type: 'File', maxSizeKb: 1024 };
  // The same table's File column, created on its own after the change set and refused with the lag every time, reads only what is left: 5 seconds —
  // two reads, after waits of 1 s and 2 s; the next wait (4 s) would run past the budget.
  {
    const env = await lagEnv();
    spendOnBatch(env);
    let docRefused = false;
    env.fault('POST', columnPost('contoso_ticket', 'contoso_doc'), () => { docRefused = true; return refused('0x80040216'); });
    env.fault('GET', isProbe, () => (docRefused ? odata(404, { code: '0x80060888', message: 'not yet' }) : undefined));
    const run = await phase(env, lagSpec([ticket({ columns: [...ticket().columns, fileColumn] })]));
    const halt = haltOf(run);
    assert.ok(halt.message.endsWith(SUFFIX));
    assert.deepStrictEqual(run.clk.waits, [1000, 2000, 4000, 8000, 1000, 2000], 'the File column\'s check waited only what the change set\'s left');
  }
  // Another table's File column has a budget of its own: four waits before it stops.
  {
    const env = await lagEnv();
    spendOnBatch(env);
    const other = { schemaName: 'contoso_note', displayName: 'Note', pluralName: 'Notes', primaryAttribute: { schemaName: 'contoso_subject', displayName: 'Subject' }, columns: [fileColumn] };
    env.fault('POST', columnPost('contoso_note', 'contoso_doc'), () => refused('0x80040216'));
    const run = await phase(env, lagSpec([ticket(), other]));
    const halt = haltOf(run);
    assert.ok(halt.message.endsWith(SUFFIX));
    assert.deepStrictEqual(run.clk.waits, [1000, 2000, 4000, 8000, 1000, 2000, 4000, 8000], 'the other table waited a whole budget of its own');
  }
  // The status reason of the table whose change set spent 15 seconds: its read at the end of the phase has the same 5 seconds left.
  {
    const env = await lagEnv();
    spendOnBatch(env);
    env.fault('POST', isInsert, () => refused('0x80090457', NOT_THERE));
    env.fault('GET', (w) => STATUS_READ.test(w), () => odata(404, { code: '0x80060888', message: 'not yet' }));
    const run = await phase(env, lagSpec([ticket({ statusReasons: [{ label: 'In Review', state: 'Active' }] })]));
    haltOf(run);
    assert.strictEqual(run.wire.filter((r) => r.method === 'GET' && STATUS_READ.test(r.path)).length, 3, 'three reads of the status reasons: what the shared budget had left room for');
  }
  // A throttle (429) the HTTP client waits out inside one resend: one resend of the check's, two requests on the wire.
  {
    const env = await lagEnv();
    let calls = 0;
    const createColumn = env.sdk.createColumn.bind(env.sdk);
    env.sdk.createColumn = (logical, options, ...rest) => { if (options && options.schemaName === 'contoso_title') calls += 1; return createColumn(logical, options, ...rest); };
    env.fault('POST', columnPost('contoso_ticket', 'contoso_title'), (req, n) => (n === 1 ? refused('0x80040216') : (n === 2 ? odata(429, { code: '0x80072322', message: 'Number of requests exceeded the limit.' }) : undefined)));
    const run = await phase(env, lagSpec(), { inlineColumns: false });
    assert.ifError(run.error);
    assert.strictEqual(calls, 2, 'the refused create and one resend by the check');
    assert.strictEqual(posts(run, columnPost('contoso_ticket', 'contoso_title')).length, 3, 'three requests: the refusal, the throttled one and the one the client sent again');
  }
});

test('a first run whose check runs out stops the build; the next run finds the table and creates the column, with no check and no word of the lag', async () => {
  const env = await lagEnv();
  const lagged = env.fault('POST', columnPost('contoso_ticket', 'contoso_title'), () => refused('0x80040216'));
  const first = await phase(env, lagSpec(), { inlineColumns: false });
  haltOf(first);
  assert.strictEqual(posts(first, columnPost('contoso_ticket', 'contoso_title')).length, 5, 'the first run read and sent it again until its budget allowed no more');
  assert.ok(probes(first).length >= 5, 'reading before each resend');
  assert.strictEqual(lagWarnings(first).length, 1);
  lagged.lift();
  const rerun = await phase(env, lagSpec(), { inlineColumns: false });
  assert.ifError(rerun.error);
  assert.strictEqual(posts(rerun, columnPost('contoso_ticket', 'contoso_title')).length, 1, 'the rerun creates it once');
  assert.deepStrictEqual(lagWarnings(rerun), [], 'and says nothing of the lag: the table existed');
  assert.deepStrictEqual(rerun.clk.waits, []);
});

// --- what does not change -------------------------------------------------------------------------------------------------------------------------------

test('the same refusal of a column on a table that already existed stops the build at once, as it always did: one create, no read, no wait, no word of the lag', async () => {
  const env = await lagEnv();
  assert.ifError((await phase(env, lagSpec())).error);
  const grown = lagSpec([ticket({ columns: [...ticket().columns, { schemaName: 'contoso_more', displayName: 'More', type: 'Text' }] })]);
  env.fault('POST', columnPost('contoso_ticket', 'contoso_more'), () => refused('0x80040216'));
  const run = await phase(env, grown);
  const halt = haltOf(run);
  assert.strictEqual(posts(run, columnPost('contoso_ticket', 'contoso_more')).length, 1);
  assert.strictEqual(probes(run).length, 0);
  assert.deepStrictEqual(run.clk.waits, []);
  assert.deepStrictEqual(lagWarnings(run), []);
  assert.ok(!halt.message.endsWith(SUFFIX));
});

test('an "already exists" answer is still the skip it was — for a column and for a status reason of a new table — with no read and no wait', async () => {
  const env = await lagEnv();
  env.fault('POST', columnPost('contoso_ticket', 'contoso_title'), () => refused('0x80047013', 'An attribute with the specified name contoso_title already exists for entity contoso_ticket.'));
  env.fault('POST', isInsert, () => refused('0x80044310', 'The picklist value already exists.'));
  const run = await phase(env, lagSpec([ticket({ statusReasons: [{ label: 'In Review', state: 'Active' }] })]), { inlineColumns: false });
  assert.ifError(run.error);
  assert.deepStrictEqual(steps(run, 'column contoso_ticket.contoso_title').map((e) => e.status), ['skip']);
  assert.deepStrictEqual(steps(run, 'status reason contoso_ticket: In Review').map((e) => `${e.label} ${e.status}`), ['status reason contoso_ticket: In Review (exists) skip']);
  assert.strictEqual(probes(run).length, 0);
  assert.strictEqual(run.wire.filter((r) => STATUS_READ.test(r.path)).length, 0);
  assert.deepStrictEqual(run.clk.waits, []);
  assert.deepStrictEqual(lagWarnings(run), []);
});

test('a build the lag never touches sends what it always did: one read of the columns after the change set, no read of the status reasons before the insert, no wait, no warning', async () => {
  const env = await lagEnv();
  const run = await phase(env, lagSpec([ticket({ statusReasons: [{ label: 'In Review', state: 'Active' }] })]));
  assert.ifError(run.error);
  assert.strictEqual(posts(run, isBatch).length, 1);
  assert.strictEqual(probes(run).length, 1, 'the read that confirms the change set');
  assert.strictEqual(run.wire.filter((r) => /StatusAttributeMetadata/.test(r.path)).length, 0);
  assert.strictEqual(posts(run, isInsert).length, 1);
  assert.deepStrictEqual(run.clk.waits, []);
  assert.deepStrictEqual(run.warnings, []);
});

test('a change set refused with any other 400 is sent once by the HTTP client and created one by one, as before', async () => {
  const env = await lagEnv();
  env.fault('POST', isBatch, () => batchRefused({ code: '0x80060304', message: 'Attribute contoso_title already exists for entity contoso_ticket.' }));
  const run = await phase(env, lagSpec());
  assert.ifError(run.error);
  assert.strictEqual(posts(run, isBatch).length, 1);
  assert.strictEqual(probes(run).length, 0, 'no read of the lag kind');
  assert.deepStrictEqual(posts(run, (w) => /\/Attributes$/.test(w)).map((r) => JSON.parse(r.body).SchemaName), ['contoso_title', 'contoso_code']);
});

// --- what is printed, and when ----------------------------------------------------------------------------------------------------------------------------

test('a refusal the check ran out on says the build may be run again only in the halt the command prints after its build lease is let go — the step printed the SDK\'s error, with nothing added, while the lease was held', async () => {
  const env = await lagEnv();
  env.fault('POST', columnPost('contoso_ticket', 'contoso_title'), () => refused('0x80090457', NOT_THERE));
  env.fault('GET', isProbe, () => odata(404, { code: '0x80060888', message: 'Resource not found for the segment.' }));
  const spec = lagSpec();
  const folder = appFolder(spec);
  const clk = clock();
  let atError = null;
  // The build command over its real modules (helpers/build-command-harness.js), its engine the data-model phase over the fake environment, whose steps
  // the command's own printer prints (the `emit` buildModelApp hands the engine).
  const run = command(folder, {
    engine: async (held, o) => {
      const emit = (e) => { o.emit(e); if (e.status === 'error') atError = { held: held(), stderr: run.cli.stderrText() }; };
      await provisionDataModel({
        sdk: env.sdk, provision: env.sdk, runner: makeRunner({ emit, total: 99 }), spec, apply: true, preResolvedLanguageCode: 1033,
        provisionedLanguages: async () => [1033], sleep: clk.sleep, now: clk.now, random: () => 0, warn: o.warn, inlineColumns: false,
      });
      return { ok: true, dryRun: false, created: {} };
    },
  });
  const outcome = await settle(run);
  const halt = outcome.thrown;
  assert.ok(halt instanceof BuildHalt, JSON.stringify(outcome));
  // While the lease was held: the step's failure, printed as the SDK made it.
  assert.ok(atError && atError.held, 'the step failed while the lease was held');
  assert.ok(atError.stderr.includes(`✗ column contoso_ticket.contoso_title (Text) — ${halt.cause.message}\n`), atError.stderr);
  assert.ok(!run.cli.stderrText().includes('persisted') && !run.cli.stdoutText().includes('persisted'), 'nothing the command printed under the lease says more');
  // After it: the halt main().catch prints, which does.
  assert.strictEqual(outcome.heldThen, false, 'the lease was let go before the halt reached main().catch');
  assert.ok(halt.message.endsWith(SUFFIX), halt.message);
  assert.throws(() => run.authCli.exports.emitResult(false, halt), (e) => e.exitCode === 1);
  assert.strictEqual(run.authCli.stderrText(), `${halt.message}\n`);
  assert.strictEqual(run.authCli.stdoutText(), '');
  // And the refusal decides what the build does about it: a 400 is final, so the command did not run the build again.
  assert.strictEqual(serviceCodeOf(halt.cause), '0x80090457');
  assert.strictEqual(halt.retry, 'never');
  assert.strictEqual(isTransientHalt(halt), false);
  assert.deepStrictEqual(run.calls.filter((c) => c === 'engine'), ['engine'], 'one run of the phases');
});
