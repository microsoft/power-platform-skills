'use strict';
// Teardown's row-summary step says what the SDK found. `removeRowSummary` looks the table's skill row up itself and answers `{ removed: true }` when the table had a row summary and it is
// gone, and `{ removed: false }` — deleting nothing — when it had none (cds-maker-sdk 9a0c9f03). The SDK used to answer nothing in both cases, so the step took "the call did not throw" for "one
// was deleted" and a table with no row summary was reported `✓ row summary <table> (1 deleted)`; 2.16.0 looked for the skill row first, with a read of its own, to tell them apart. The step now
// reads nothing of its own: what the removal answers is what its line says, like every other step. It stays best-effort, as it always was (a failure of the lookup or of the removal fails nothing),
// but what it could not do is said on its line instead of being counted as a deletion.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runTeardown, KIND_HANDLERS } = require('../lib/sdk-teardown.js');
const { teardownModelApp: engineTeardownModelApp } = require('../teardown-model-app.js');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../lib/maker-sdk.js');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');

const ENV = 'https://contoso.crm.dynamics.com';
const teardownModelApp = (spec, opts, deps) => engineTeardownModelApp(spec, { env: ENV, ...opts }, deps);

// A spec whose one table gets a row summary: the build would make one for the Memo column, so teardown plans its removal.
const SPEC = {
  solution: { uniqueName: 'AiTest', publisherPrefix: 'new' },
  app: { name: 'AiApp' },
  entities: [{ schemaName: 'new_memo', displayName: 'Memo', primaryAttribute: { schemaName: 'new_name' }, columns: [{ schemaName: 'new_body', displayName: 'Body', type: 'Memo' }] }],
  relationships: [],
  ai: { summaries: { default: 'auto' } },
};
const SKILL_ROW = { aiskillconfigid: '11111111-1111-1111-1111-111111111111' };
const LOOKUP_URL = `${ENV}/api/data/v9.0/aiskillconfigs?$select=aiskillconfigid,_aimodel_value&$filter=uniquename eq 'ais_RowSummary_new_memo'&$top=1`;

// An SDK double whose `removeRowSummary` answers `answer` (`{ removed: true }` unless told otherwise, and nothing at all for `answer: undefined`) and records every call. `remove` replaces the
// answer with a failure to throw. A read through `sdk.dataverse` fails the test: the step makes none. `solution: false` is an environment without the spec's solution, so that nothing else of the
// plan is deleted either.
function summarySdk(options = {}) {
  const { remove, solution = true } = options;
  const answer = 'answer' in options ? options.answer : { removed: true };
  const calls = [];
  const sdk = {
    resolveArtifact: async (kind) => (kind === 'solution' && solution ? [{ id: 'sol-1', name: 'AiTest' }] : []),
    queryRecords: async () => [],
    dataverse: {
      get: async (url) => { throw new Error(`the row-summary step must read nothing of its own, and read ${url}`); },
    },
    removeRowSummary: async (args) => {
      calls.push({ method: 'removeRowSummary', ...args });
      if (remove) throw remove();
      return answer;
    },
    deleteTable: async () => { throw Object.assign(new Error('Could not find an entity with specified id'), { statusCode: 404 }); },
    deleteSolution: async () => {},
  };
  return { sdk, calls, removals: () => calls.filter((c) => c.method === 'removeRowSummary') };
}

// What the SDK throws when a request of its own is refused: a ConnectionError carrying the url and the status (cds-maker-sdk `ConnectionError`).
const refusal = (status, words, url = LOOKUP_URL) => Object.assign(new Error(`HTTP ${status} from ${url}: ${words}`), { code: 'CONNECTION_ERROR', statusCode: status, url });

const stepEvents = (events) => events.filter((e) => e.phase === 'ai-summaries' && e.status !== 'start');
async function run(sdk, spec = SPEC) {
  const events = [];
  const result = await runTeardown(spec, { apply: true }, { sdk, emit: (e) => events.push(e) });
  return { result, events: stepEvents(events) };
}

test('a table with no row summary is reported as not found: the SDK deleted nothing, and nothing deleted is counted', async () => {
  const { sdk, removals } = summarySdk({ answer: { removed: false } });
  const { result, events } = await run(sdk);
  assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
  assert.deepStrictEqual(events.map((e) => [e.status, e.skip, e.label]), [['skip', 'not-found', 'row summary new_memo (not found)']]);
  assert.strictEqual(removals().length, 1, 'the SDK is asked once, and it looks for the row summary itself');
  assert.strictEqual(result.deleted.aiSummary, undefined, 'and nothing deleted is counted');
  assert.ok(result.skipped.includes('row summary new_memo'));
});

test('a row summary the environment holds is removed once, and reported as deleted', async () => {
  const { sdk, removals } = summarySdk({ answer: { removed: true } });
  const { result, events } = await run(sdk);
  assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
  assert.deepStrictEqual(events.map((e) => [e.status, e.label]), [['ok', 'row summary new_memo (1 deleted)']]);
  assert.deepStrictEqual(removals().map((c) => c.entityLogicalName), ['new_memo']);
  assert.deepStrictEqual(result.deleted.aiSummary, ['new_memo']);
});

test('the step makes no request of its own: the SDK\u2019s removal is the only call it makes for a table', async () => {
  // The double fails the test on any read through `sdk.dataverse`; the plan's other steps read through `resolveArtifact`/`queryRecords`, which this spec's steps do not use for a row summary.
  for (const answer of [{ removed: true }, { removed: false }]) {
    const { sdk, calls } = summarySdk({ answer });
    const { result } = await run(sdk);
    assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
    assert.deepStrictEqual(calls.map((c) => c.method), ['removeRowSummary'], JSON.stringify(answer));
  }
});

test('only an explicit { removed: false } says that nothing was there: an answer that says nothing is counted as it always was', async () => {
  // A double (or an SDK) that answers nothing cannot say that no row summary was found, so the removal that did not throw is a deletion, as it was before the lookup existed.
  for (const answer of [undefined, null, {}, { removed: undefined }]) {
    const { sdk } = summarySdk({ answer });
    const { result, events } = await run(sdk);
    assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
    assert.deepStrictEqual(events.map((e) => [e.status, e.label]), [['ok', 'row summary new_memo (1 deleted)']], JSON.stringify(answer));
  }
});

test('an environment that has no AI skill table holds no row summary: the SDK\u2019s lookup answers 404, and the step says not found, not failed', async () => {
  const { sdk, removals } = summarySdk({ remove: () => refusal(404, "Resource not found for the segment 'aiskillconfigs'.") });
  const { result, events } = await run(sdk);
  assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
  assert.deepStrictEqual(events.map((e) => [e.status, e.skip, e.label]), [['skip', 'not-found', 'row summary new_memo (not found)']]);
  assert.strictEqual(removals().length, 1);
  assert.strictEqual(result.deleted.aiSummary, undefined);
});

test('a lookup or a removal that fails leaves what is there unknown: said on the step in the SDK\u2019s words, nothing counted as deleted, nothing failed', async () => {
  for (const [what, failure, words] of [
    ['a refusal of the lookup', () => refusal(403, 'no read privilege'), `HTTP 403 from ${LOOKUP_URL}: no read privilege`],
    ['an answer that is no list', () => Object.assign(refusal(200, "the row-summary skill lookup returned a malformed answer \u2014 expected an OData 'value' array but got a string"), { statusCode: 200 }), `HTTP 200 from ${LOOKUP_URL}: the row-summary skill lookup returned a malformed answer \u2014 expected an OData 'value' array but got a string`],
    ['a first row that is no row', () => refusal(200, 'the row-summary skill lookup returned a malformed row \u2014 expected an object but got null'), `HTTP 200 from ${LOOKUP_URL}: the row-summary skill lookup returned a malformed row \u2014 expected an object but got null`],
    ['a request that failed', () => new Error('socket hang up'), 'socket hang up'],
  ]) {
    const { sdk, removals } = summarySdk({ remove: failure });
    const { result, events } = await run(sdk);
    assert.strictEqual(result.ok, true, `${what}: the step is best-effort, as it was: ${JSON.stringify(result.errors)}`);
    assert.deepStrictEqual(events.map((e) => [e.status, e.skip, e.label]), [['skip', 'kept', `row summary new_memo (kept \u2014 1 not removed: ${words})`]], what);
    assert.strictEqual(removals().length, 1, what);
    assert.strictEqual(result.deleted.aiSummary.length, 0, what);
  }
});

test('a removal that fails is not a deletion: said on the step in the SDK\u2019s words, kept like a step that left its artifact, and it still fails nothing', async () => {
  const words = "The row summary of 'new_memo' was removed, but its AI model '22222222-2222-2222-2222-222222222222' was not deleted (HTTP 400: refused).";
  const { sdk, removals } = summarySdk({ remove: () => Object.assign(new Error(words), { code: 'ROW_SUMMARY_MODEL_NOT_DELETED' }) });
  const { result, events } = await run(sdk);
  assert.strictEqual(result.ok, true, 'best-effort: the table\u2019s delete that follows reports what still depends on the row summary');
  assert.deepStrictEqual(events.map((e) => [e.status, e.skip, e.label]), [['skip', 'kept', `row summary new_memo (kept \u2014 1 not removed: ${words})`]]);
  assert.strictEqual(removals().length, 1);
  assert.deepStrictEqual(result.deleted.aiSummary, []);
  assert.deepStrictEqual(result.skipped.filter((s) => /^row summary new_memo/.test(s)), [`row summary new_memo (1 not removed: ${words} \u2014 skipped)`]);
});

// The review's case: the table is kept (`existing: true`) and every other artifact is absent, so nothing at all is deleted. The closing line counts the events the engine emitted, so a wholly failed
// removal that was emitted as a step that deleted something put a deletion in the total that the step line and the JSON result both deny.
const RETAINED = { ...SPEC, entities: [{ ...SPEC.entities[0], existing: true }] };
const CLOSING_WHEN_NOTHING_WAS_DELETED = /\u2014 0 deleted, 5 not found, 0 failed, 2 kept \(7 steps\)$/;

test('a removal that wholly fails is not in the closing count of deleted steps: it is kept, with the table that is kept', async () => {
  const words = 'HTTP 403 from https://contoso.crm.dynamics.com/api/data/v9.0/aiskillconfigs(11111111-1111-1111-1111-111111111111): no delete privilege';
  const logs = [];
  const { sdk } = summarySdk({ solution: false, remove: () => new Error(words) });
  const result = await teardownModelApp(RETAINED, { apply: true, allowDestructive: true }, { sdk, log: (m) => logs.push(m) });
  assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
  assert.deepStrictEqual(result.deleted.aiSummary, [], 'the JSON result deletes nothing');
  assert.ok(logs.some((l) => l === `  [3/7] \u2298 row summary new_memo (kept \u2014 1 not removed: ${words})`), logs.join('\n'));
  assert.match(logs.find((l) => /teardown complete/.test(l)), CLOSING_WHEN_NOTHING_WAS_DELETED, logs.join('\n'));
});

test('a removal that succeeds is still counted as the deletion it is, beside the table that is kept', async () => {
  const logs = [];
  const { sdk } = summarySdk({ solution: false });
  await teardownModelApp(RETAINED, { apply: true, allowDestructive: true }, { sdk, log: (m) => logs.push(m) });
  assert.match(logs.find((l) => /teardown complete/.test(l)), /\u2014 1 deleted, 5 not found, 0 failed, 1 kept \(7 steps\)$/, logs.join('\n'));
});

test('the printed step and the closing counts follow what was found', async () => {
  const tally = async (options) => {
    const logs = [];
    const { sdk } = summarySdk(options);
    const result = await teardownModelApp(SPEC, { apply: true, allowDestructive: true }, { sdk, log: (m) => logs.push(m) });
    assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
    const closing = /\u2014 (\d+) deleted, (\d+) not found, 0 failed \((\d+) steps\)/.exec(logs.find((l) => /teardown complete/.test(l)));
    assert.ok(closing, logs.join('\n'));
    return { logs, deleted: Number(closing[1]), notFound: Number(closing[2]), steps: Number(closing[3]) };
  };
  const none = await tally({ answer: { removed: false } });
  const one = await tally({ answer: { removed: true } });
  assert.ok(none.logs.some((l) => /^ {2}\[\d+\/\d+\] \u2298 row summary new_memo \(not found\)$/.test(l)), none.logs.join('\n'));
  assert.ok(!none.logs.some((l) => /row summary new_memo \(1 deleted\)/.test(l)));
  assert.ok(one.logs.some((l) => /^ {2}\[\d+\/\d+\] \u2713 row summary new_memo \(1 deleted\)$/.test(l)), one.logs.join('\n'));
  // The same plan, so the one step that differs moves one count into the other: a summary nothing held is not a deletion.
  assert.strictEqual(none.steps, one.steps);
  assert.strictEqual(one.deleted - none.deleted, 1);
  assert.strictEqual(none.notFound - one.notFound, 1);
});

// --- the real SDK ----------------------------------------------------------------------------------------------------------------------------------------------

// The real bundle over a fake Dataverse that answers by the filter: `removeRowSummary` looks the row summary up by its skill row — `GET /aiskillconfigs?…$filter=uniquename eq 'ais_RowSummary_<table>'` — and
// what the step reports is what that call answers, so these hold the step to the requests the bundle really makes and to the words it really answers in.
function fakeSkillOrg({ rows = [], status = 200, deleteStatus = 204 } = {}) {
  const requests = [];
  const json = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  async function request({ url, method }) {
    const where = decodeURIComponent(new URL(url).pathname + new URL(url).search);
    requests.push({ method, path: where });
    if (method === 'GET' && /\/aiskillconfigs\?/.test(where)) return json(status, status === 200 ? { value: rows } : { error: { message: "Resource not found for the segment 'aiskillconfigs'." } });
    // The skill row's own delete, and the read the bundle makes to settle one that failed: the row is still there.
    if (method === 'DELETE' && /\/aiskillconfigs\(/.test(where)) return deleteStatus >= 400 ? json(deleteStatus, { error: { message: 'no delete privilege' } }) : { statusCode: deleteStatus, headers: {}, body: '' };
    if (method === 'GET' && /\/aiskillconfigs\(/.test(where)) return json(200, { aiskillconfigid: SKILL_ROW.aiskillconfigid });
    const table = /EntityDefinitions\(LogicalName='([^']+)'\)/.exec(where);
    if (method === 'GET' && table) return json(200, { LogicalName: table[1], EntitySetName: `${table[1]}s`, MetadataId: '55555555-5555-5555-5555-555555555555' });
    return method === 'GET' ? json(200, { value: [] }) : { statusCode: 204, headers: {}, body: '' };
  }
  const httpClient = createAzHttpClient(ENV, { getToken: () => 'token', request, sleep: async () => {} });
  return { httpClient, requests };
}
const dirs = [];
test.after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });
async function realSdk(org) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teardown-summary-'));
  dirs.push(dir);
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: ENV, httpClient: org.httpClient });
  await sdk.initWorkspace();
  return sdk;
}
const skillFilters = (requests) => requests.map((r) => /\/aiskillconfigs\?.*\$filter=([^&]+)/.exec(r.path)).filter(Boolean).map((m) => m[1]);

const withoutPage = { entities: SPEC.entities, ai: SPEC.ai };
const deleteRequests = (requests) => requests.filter((r) => r.method === 'DELETE').map((r) => r.path.replace(/^\/api\/data\/v9\.\d\//, ''));

test('REAL BUNDLE: the removal of a table with no skill row answers { removed: false }, and the step reports not found after the SDK\u2019s one lookup, sending nothing', async () => {
  const direct = fakeSkillOrg({ rows: [] });
  assert.deepStrictEqual(await KIND_HANDLERS.aiSummary.del(await realSdk(direct), { id: 'new_memo', entityLogicalName: 'new_memo' }), { removed: false });
  const org = fakeSkillOrg({ rows: [] });
  const { result, events } = await run(await realSdk(org), withoutPage);
  assert.deepStrictEqual(events.map((e) => [e.status, e.label]), [['skip', 'row summary new_memo (not found)']], JSON.stringify(result.errors));
  assert.deepStrictEqual(skillFilters(org.requests), ["uniquename eq 'ais_RowSummary_new_memo'"], 'one lookup, by the unique name the build gave the row summary: the SDK\u2019s own');
  assert.deepStrictEqual(deleteRequests(org.requests).filter((p) => /aiskillconfigs|msdyn_aimodels/.test(p)), [], 'and no row summary was deleted (the table\u2019s own delete, which the plan makes next, is not this step\u2019s)');
  assert.strictEqual(result.deleted.aiSummary, undefined);
});

test('REAL BUNDLE: a skill row the environment holds is removed by the SDK, which is the one that looks for it: one lookup, one delete, reported as deleted', async () => {
  const org = fakeSkillOrg({ rows: [SKILL_ROW] });
  const { result, events } = await run(await realSdk(org), withoutPage);
  assert.deepStrictEqual(events.map((e) => [e.status, e.label]), [['ok', 'row summary new_memo (1 deleted)']], JSON.stringify(result.errors));
  assert.deepStrictEqual(skillFilters(org.requests), ["uniquename eq 'ais_RowSummary_new_memo'"], 'the step makes no lookup of its own');
  assert.deepStrictEqual(deleteRequests(org.requests).filter((p) => /aiskillconfigs|msdyn_aimodels/.test(p)), ['aiskillconfigs(11111111-1111-1111-1111-111111111111)'], 'one delete, of the skill row (the table\u2019s own, which the plan makes next, is not this step\u2019s)');
  assert.deepStrictEqual(result.deleted.aiSummary, ['new_memo']);
});

test('REAL BUNDLE: a first row that is no row is a failure of the SDK\u2019s lookup, kept in its words — not a table with no row summary — and no row summary is deleted', async () => {
  const org = fakeSkillOrg({ rows: [null] });
  const { result, events } = await run(await realSdk(org), withoutPage);
  assert.strictEqual(result.ok, true, 'best-effort, as it always was');
  assert.deepStrictEqual(events.map((e) => [e.status, e.skip]), [['skip', 'kept']]);
  assert.match(events[0].label, /^row summary new_memo \(kept \u2014 1 not removed: HTTP 200 from https:\/\/contoso\.crm\.dynamics\.com\/api\/data\/v9\.\d\/aiskillconfigs\?[^:]*: the row-summary skill lookup returned a malformed row \u2014 expected an object but got /);
  assert.deepStrictEqual(deleteRequests(org.requests).filter((p) => /aiskillconfigs|msdyn_aimodels/.test(p)), []);
  assert.deepStrictEqual(result.deleted.aiSummary, []);
});

test('REAL BUNDLE: an environment with no AI skill table is reported as not found through the whole teardown', async () => {
  const sdk = await realSdk(fakeSkillOrg({ status: 404 }));
  // No app and no solution in the plan: what the real SDK would be asked about them is not this test's.
  const { result, events } = await run(sdk, { entities: SPEC.entities, ai: SPEC.ai });
  assert.deepStrictEqual(events.map((e) => [e.status, e.label]), [['skip', 'row summary new_memo (not found)']], JSON.stringify(result.errors));
});

test('REAL BUNDLE: a skill row the caller may not delete is kept, with the platform\u2019s refusal, and the closing counts say that nothing was deleted', async () => {
  const org = fakeSkillOrg({ rows: [SKILL_ROW], deleteStatus: 403 });
  const logs = [];
  const result = await teardownModelApp(RETAINED, { apply: true, allowDestructive: true }, { sdk: await realSdk(org), log: (m) => logs.push(m) });
  assert.strictEqual(result.ok, true, `${JSON.stringify(result.errors)}\n${logs.join('\n')}`);
  assert.deepStrictEqual(result.deleted.aiSummary, []);
  const line = logs.find((l) => /row summary new_memo/.test(l));
  assert.match(line, /^ {2}\[3\/7\] \u2298 row summary new_memo \(kept \u2014 1 not removed: HTTP 403 from https:\/\/contoso\.crm\.dynamics\.com\/api\/data\/v9\.0\/aiskillconfigs\(11111111-1111-1111-1111-111111111111\): no delete privilege\)$/, line);
  assert.match(logs.find((l) => /teardown complete/.test(l)), CLOSING_WHEN_NOTHING_WAS_DELETED, logs.join('\n'));
  assert.deepStrictEqual(org.requests.filter((r) => r.method === 'DELETE').map((r) => r.path.replace(/^\/api\/data\/v9\.\d\//, '')), ['aiskillconfigs(11111111-1111-1111-1111-111111111111)'], 'the delete was sent once and its refusal was the answer');
});
